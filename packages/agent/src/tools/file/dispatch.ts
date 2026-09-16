/**
 * D079 Phase 4 / G3 — command dispatcher for the `file` tool.
 *
 * Every `file(...)` invocation flows through here. The dispatcher:
 *   1. Takes already-Zod-validated args (discriminated union).
 *   2. Resolves the path + zone against the current turn's
 *      ZoneContext. Bails out with a clear error on resolution
 *      failure.
 *   3. Routes to the per-command handler.
 *   4. Returns the handler's string result (for tool message
 *      content) OR a structured error string.
 *
 * Handlers are registered at module load time via the per-command
 * imports. Each handler signature:
 *
 *     async function handle<C extends FileToolArgs["command"]>(
 *       args: FileCommandArgs<C>,
 *       resolution: { resolved: string, resolvedZone: "..." },
 *       ctx: DispatchContext,
 *     ): Promise<string>
 *
 * The `string` return is what goes into the ToolMessage. For
 * structured results (list output, grep matches, etc.) the handler
 * stringifies its own shape — the tool is string-in-string-out at
 * this layer, consistent with every other Nautilo tool.
 *
 * G3 commit 5 ships all 10 handlers as stubs (throw "not
 * implemented" with their command name). G3 commits 6-8 fill them
 * in progressively.
 */

import { ToolMessage } from "@langchain/core/messages";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { FileToolArgs, FileToolRawArgs } from "./schema";
import type { ZoneContext } from "./zones";
import { resolveZone, assertRealpathContained } from "./zones";
import { LocalFileBackend, type FileBackend } from "./backend";
import type { WorkspaceArtifactPatchMeta } from "./artifact-store";
import {
  dispatchWorkspaceCommand,
  handleWorkspaceUndoTurn,
  isWorkspaceArtifactCommand,
} from "./workspace-commands";
import {
  isLocalHistoryRoutingError,
  shouldRouteHistoryViaLocalRelay,
} from "./local-history-routing";
import {
  isLocalFileZone,
  isMutatingLocalFileCommand,
} from "./local-file-routing";

// Per-command handlers (stubs for now; filled in G3 commits 6-8)
import { handleList } from "./commands/list";
import { handleRead } from "./commands/read";
import { handleStat } from "./commands/stat";
import { handleWrite } from "./commands/write";
import { handleInsert } from "./commands/insert";
import { handleStrReplace } from "./commands/str-replace";
// D087 Phase 3 §3.4 — read-only enumeration. No path/zone on args
// (path is a filter, not a target). Routes before zone resolution.
import { handleListRevisions } from "./commands/list-revisions";
// D087 Phase 3 §3.5 — protect / unprotect revisions from GC. No
// path/zone; revisionId is the key.
import { handlePinRevision, handleUnpinRevision } from "./commands/pin-revision";
import { fileToolError } from "./file-result-status";

export interface DispatchContext {
  zoneCtx: ZoneContext;
  /**
   * D448 — trusted tool-dispatch correlation used as the initial durable
   * Workspace mutation operation id. A public retry token may reference a
   * prior value, but never grants authority.
   */
  mutationRequestId?: string;
  /** Enclosing LangGraph/tool-call cancellation; native Workspace search forwards it. */
  signal?: AbortSignal;
  /**
   * M174 — byte-I/O backend for this call. `LocalFileBackend` for the
   * `workspace` zone (and for commands with no zone); `RelayFileBackend`
   * for `current`/`absolute` when a relay is connected. Selected once per
   * `file` call in `createFileTool` and threaded through every fs op so
   * the tool's matching/scanning/approval/revision logic stays
   * server-side while the bytes ride the relay for remote servers.
   */
  backend?: FileBackend;
  /** Owner id for audit-log correlation; handlers can include it in their output. */
  ownerId: string;
  /**
   * Active chat model id for this turn (D069 multimodal read / PDF gating).
   * Prefer over bare `fromRuntimeConfig().nautilo_model` so tooling respects
   * per-turn model selection without stale global config cache.
   */
  activeModelId?: string | undefined;
  /**
   * D087 Phase 1 §1.3 — the current turn's UUID. Destructive commands
   * use this as the key for the staged-patch store so patches are
   * turn-scoped. Populated from the `@nautilo/logger` AsyncLocalStorage
   * (D082 PR B) at the tool-factory layer; every real agent turn has
   * one. Missing at stage time signals a plumbing bug — the staging
   * helper throws loudly rather than silently degrade. Optional here
   * so read-only test fixtures and legacy callers don't need to
   * construct one; required at the stage path in practice.
   */
  turnId?: string;
  /**
   * D087 Phase 2A — the agent whose turn this is. Required by the
   * `file_revisions` table FK at `recordRevision()` time, so the
   * backup router can attribute revisions to the correct agent
   * (multi-tenancy + partition-friendliness). Sourced from
   * `NautiloState.agentId` via the tool-factory call sites
   * (pre-model.ts / agent.ts / tools.ts), mirroring how `ownerId`
   * flows from `NautiloState.userId`. Optional here for the same
   * reason `turnId` is — read-only test fixtures don't need one.
   * Missing at `recordRevision` time throws loudly; missing for
   * pure read operations is fine.
   */
  agentId?: string;
  /**
   * D087 Phase 2A — the room this turn is happening in. Used as
   * the `room_id` FK on `file_revisions`; set-null on room delete
   * so revisions outlive room cleanup. Nullable in the room FK
   * (unlike agentId) so always-optional here — rooms are an
   * M042B+ concept and not every flow has one in scope.
   */
  roomId?: string;
  /**
   * M088A — Room-derived access envelope. Used exclusively by the
   * `workspace` zone handlers to scope artifact rows by
   * `readableNamespaces` / `mutableNamespaces` / `writableNamespaces`
   * and `envelope.agentId`. `current` and `absolute` zones ignore it.
   *
   * Optional + null-tolerant so read-only tests, legacy callers, and
   * non-workspace zones don't have to construct one. The artifact-store
   * layer returns a clear error when a workspace-zone command runs
   * without an envelope.
   */
  memoryAccessEnvelope?: MemoryAccessEnvelope | null;
  /**
   * M088A — Workspace-artifact metadata stamped onto a staged patch.
   * Populated by `workspace-commands.ts` immediately before calling
   * through to an existing content/structural staging handler so the
   * staged patch carries enough context for `apply_patch` to update
   * the `artifacts` row row alongside the FS write. Undefined for
   * non-workspace zones; staging helpers merge it onto
   * `metadata.workspaceArtifact` when present.
   */
  workspaceArtifactMeta?: WorkspaceArtifactPatchMeta;
}

const DEFAULT_LOCAL_BACKEND = new LocalFileBackend();

export function getFileBackend(ctx: DispatchContext): FileBackend {
  return ctx.backend ?? DEFAULT_LOCAL_BACKEND;
}

function localRelayRequired(command: FileToolArgs["command"]): string {
  return JSON.stringify({
    error: "local_relay_required",
    code: "local_relay_required",
    message:
      `Current Folder and absolute file.${command} require the Desktop local relay dispatcher.`,
  });
}

/**
 * Dispatch a parsed `file` tool call to the right command handler.
 * Returns a string suitable for a ToolMessage content field. Never
 * throws on known error paths — wraps errors in a descriptive string
 * so the LLM can read the failure and decide whether to retry.
 *
 * Unknown commands are unreachable (Zod rejected earlier), but the
 * dispatcher still has an exhaustiveness guard via the TS-level
 * `never` check. If someone adds a command-union variant without a
 * dispatch case, the build fails — compile-time parity between the
 * schema and the dispatcher.
 */
export async function dispatchFileCommand(
  raw: FileToolRawArgs,
  ctx: DispatchContext,
): Promise<string | ToolMessage> {
  // Cast the Zod-validated raw (flat) args to the discriminated
  // union. Safe because `command` is constrained to the enum of
  // legal command names by the Zod schema; TypeScript can narrow
  // from there on each switch case.
  const args = raw as FileToolArgs;

  // D448 — direct server dispatch is never a local mutation/history
  // fallback. Production local calls are intercepted by `file-tool.ts` and
  // sent to the Desktop relay before this function. Keep this guard here so
  // tests and future direct callers cannot silently mutate the server host.
  const historyRoutingError = isLocalHistoryRoutingError(args, {
    currentFolder: ctx.zoneCtx.currentFolder,
  });
  if (historyRoutingError) {
    return JSON.stringify({
      error: historyRoutingError.code,
      code: historyRoutingError.code,
      message: historyRoutingError.message,
      ...(historyRoutingError.hint ? { hint: historyRoutingError.hint } : {}),
    });
  }
  if (
    shouldRouteHistoryViaLocalRelay(args, {
      currentFolder: ctx.zoneCtx.currentFolder,
    }) ||
    (isLocalFileZone(raw.zone) && isMutatingLocalFileCommand(args.command))
  ) {
    return localRelayRequired(args.command);
  }

  // M162 / D448 — Workspace turn restore is canonical and server-side.
  if (args.command === "undo_turn") {
    return handleWorkspaceUndoTurn(args, ctx);
  }
  if (args.command === "list_revisions") return handleListRevisions(args, ctx);
  if (args.command === "pin_revision") return handlePinRevision(args, ctx);
  if (args.command === "unpin_revision") return handleUnpinRevision(args, ctx);

  // M088A / D306 Phase 1B — `zone: "workspace"` (and the legacy
  // `home`/`scratch` aliases) routes through the artifact DB index
  // instead of treating the workspace root + path as the authority.
  // Binary delivered-format commands (copy) mint or update artifact
  // rows via `dispatchWorkspaceCommand`.
  if (
    (args.zone === "workspace" || args.zone === "home" || args.zone === "scratch") &&
    isWorkspaceArtifactCommand(args.command)
  ) {
    return dispatchWorkspaceCommand(args, ctx);
  }

  // All remaining commands take `path` + `zone` as base args. The
  // schema marks both optional (to accommodate the two commands
  // above); the handler-level presence check is below.
  if (typeof args.path !== "string" || !args.zone) {
    return fileToolError(`Error: ${args.command} requires path and zone`);
  }

  // Resolve once here and hand the resolution to the handler.
  // Commands like `move` and `copy` that have a destination path do
  // their own second resolve against destinationZone inside the
  // handler.
  const resolution = resolveZone(
    { path: args.path, zone: args.zone },
    ctx.zoneCtx,
  );
  if (!resolution.ok) {
    return fileToolError(`Error: ${resolution.reason}`);
  }

  // D079 PR-011 security port — realpath-level containment. The
  // textual check in resolveZone catches `..` traversal but does
  // not follow symlinks. Since workspace-zone writes auto-approve
  // (see personal-policy-resolver.ts), a symlink inside the
  // workspace pointing outside would otherwise redirect the fs op
  // to an arbitrary path. Re-verify here before the handler runs.
  // Absolute zone skips this check — its gate is the deny-list in
  // validateBeforeExecution (toolsNode).
  const contained = await assertRealpathContained(resolution, ctx.zoneCtx, getFileBackend(ctx));
  if (!contained.ok) {
    return fileToolError(`Error: ${contained.reason}`);
  }

  switch (args.command) {
    case "list":
      return handleList(args, resolution, ctx);
    case "read":
      return handleRead(args, resolution, ctx);
    case "glob":
    case "grep":
      return fileToolError(
        "Error: native search is available only through Workspace artifacts and Desktop current/absolute zones.",
      );
    case "stat":
      return handleStat(args, resolution, ctx);
    case "write":
      return handleWrite(args, resolution, ctx);
    case "insert":
      return handleInsert(args, resolution, ctx);
    case "str_replace":
      return handleStrReplace(args, resolution, ctx);
    case "move":
    case "copy":
    case "delete":
    case "undo":
    case "redo":
      return localRelayRequired(args.command);
    // D121-P4 / D087-P2B — block-edit commands are workspace-only.
    // The workspace-zone path is handled above via
    // `dispatchWorkspaceCommand` BEFORE we reach this switch. If a
    // block command arrives here, the caller used a non-workspace zone
    // (current / absolute) — surface a clear error rather than throw an
    // exhaustiveness-trap "unreachable" message.
    case "list_blocks":
    case "read_block":
    case "replace_block":
    case "insert_block":
    case "move_block":
    case "rewrite_block":
      return fileToolError(`Error: file.${args.command} is only supported on zone="workspace" (HTML5 + <nw-*> artifacts). Use zone="workspace" with the logical artifact path.`);
    default: {
      // Exhaustiveness check — TS errors if a new command variant
      // isn't handled. At runtime, Zod would have rejected first,
      // but this guards the dispatch surface from schema drift.
      const _exhaustive: never = args;
      return fileToolError(`Error: unreachable — command ${String((_exhaustive as FileToolArgs).command)} not handled`);
    }
  }
}
