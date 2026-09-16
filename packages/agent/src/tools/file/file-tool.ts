/**
 * D079 Phase 4 / G3 — the unified `file` tool.
 *
 * One DynamicStructuredTool named `file`; discriminated-union Zod
 * schema dispatches on `command` to per-command handlers. Replaces
 * the 11 legacy filesystem + artifact tools (which stay as
 * deprecated aliases in G3 commit 9 routing calls to this tool
 * with a mapped command+zone).
 *
 * Execution model: cloud (server-process-direct via node:fs/promises
 * in the per-command handlers). Aligned with existing filesystem
 * tools in this codebase. When the relay work (D057 branch) is fully
 * wired, this tool migrates to executor:"relay" with a single
 * relay-side dispatcher that receives the Zod-validated args
 * verbatim — mechanical refactor, no schema change.
 *
 * The tool description + worked-examples table is LOAD-BEARING for
 * Option D's LLM-selection correctness. G4 commit 10 ships the
 * ~500-word description. This commit ships a minimal placeholder
 * description so the catalog registration + schema validation can
 * be verified end-to-end without waiting for the prompt-engineering
 * work. Live-verify doesn't happen until G4 lands the real
 * description.
 *
 * Decision record anchor:
 *   pr-reviews/DECISION-2026-04-21-file-tool-shape.md
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { getCurrentTurnId, log } from "@nautilo/logger";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  fileToolSchema,
  securityResearchFileToolSchema,
  type FileToolRawArgs,
} from "./schema";
import { dispatchFileCommand, type DispatchContext } from "./dispatch";
import type { ZoneContext } from "./zones";
import { LocalFileBackend } from "./backend";
import { executeLocalFileCommand } from "./local-file-dispatch";
import { isLocalFileZone } from "./local-file-routing";
import {
  createFileMutationRequestId,
  fileMutationRetryMatches,
} from "./workspace-runtime-adapter";
import {
  isLocalHistoryRoutingError,
  shouldRouteHistoryViaLocalRelay,
} from "./local-history-routing";
import { fileToolError } from "./file-result-status";
import { getRequiredOrdinaryHostContext } from "../../runtime/ordinary-host-dispatch-context";
import {
  applySelectedCurrentFolderReadDefaults,
  selectedCurrentFolderReadInputError,
} from "./read-only-current-defaults";

/**
 * Factory signature matches the catalog's ToolFactory — the catalog
 * passes a `context` bag containing owner/persona/thread info at
 * tool-resolve time. The factory returns a DynamicStructuredTool
 * whose `func` has closed over the caller-provided context.
 *
 * The context type is deliberately `unknown`-shaped at the catalog
 * level; this factory narrows to the shape it actually needs.
 */
interface FileToolContext {
  ownerId: string;
  currentFolder: string;
  workspacePath: string;
  /**
   * Turn-scoped model id for D069 multimodal read gating (matches
   * pre-model / agent / tools node tool context).
   */
  activeModelId: string;
  /**
   * D087 Phase 2A — plumbed through from `NautiloState.agentId` via
   * the tool-factory call sites (pre-model / agent / tools nodes).
   * Threaded into `DispatchContext.agentId` so the backup subsystem
   * can attribute `file_revisions` rows to the correct agent. Empty
   * string when a legacy caller or guest context didn't populate it;
   * `recordRevision()` throws loudly in that case rather than
   * silently degrading.
   */
  agentId: string;
  /**
   * D087 Phase 2A — plumbed through from `NautiloState.roomId`.
   * Threaded into `DispatchContext.roomId` for the `file_revisions`
   * room FK (nullable). Empty string when the flow has no room in
   * scope; `recordRevision()` tolerates missing roomId because the
   * column is nullable.
   */
  roomId: string;
  /**
   * M088A — Room-derived access envelope. Threaded from
   * `NautiloState.memoryAccessEnvelope` via the tool-factory call sites
   * (pre-model / agent / tools nodes), same plumbing path as
   * `share_memory`. The `workspace` zone in the artifact-aware path
   * uses `readableNamespaces` for visibility, `mutableNamespaces` for
   * mutation, and `writableNamespaces[0]` as the attachment target for
   * new artifacts. Other zones ignore it.
   *
   * `null` for legacy callers / tests that don't populate state; the
   * artifact-store layer surfaces a clear error in that case rather
   * than silently downgrading to filesystem behavior.
   */
  memoryAccessEnvelope: MemoryAccessEnvelope | null;
  /** Server-owned security Task ceiling; never derived from model args. */
  securityResearchReadOnly: boolean;
}

function contextFromUnknown(ctx: unknown): FileToolContext {
  const c = (ctx ?? {}) as Record<string, unknown>;
  const envRaw = c["memoryAccessEnvelope"];
  // Trust the envelope shape only when it looks well-formed enough to
  // be usable; otherwise pass null so downstream code can give a
  // concrete error instead of dereferencing undefined fields.
  const envelope =
    envRaw && typeof envRaw === "object"
      ? (envRaw as MemoryAccessEnvelope)
      : null;
  return {
    ownerId: typeof c["ownerId"] === "string" ? c["ownerId"] : "",
    currentFolder: typeof c["currentFolder"] === "string" ? c["currentFolder"] : "",
    workspacePath: typeof c["workspacePath"] === "string" ? c["workspacePath"] : "",
    agentId: typeof c["agentId"] === "string" ? c["agentId"] : "",
    roomId: typeof c["roomId"] === "string" ? c["roomId"] : "",
    activeModelId: typeof c["activeModelId"] === "string" ? c["activeModelId"] : "",
    memoryAccessEnvelope: envelope,
    securityResearchReadOnly: Array.isArray(c["toolWhitelist"])
      && c["toolWhitelist"].includes("security_scan"),
  };
}

/**
 * D079 Phase 4 / G4 commit 10 — the LOAD-BEARING tool description.
 *
 * Per the decision record (§ Costs we accept → "Out-of-training-
 * distribution shape"), rock-solid prompting is the non-negotiable
 * mitigation for Option D. The agent trained on Anthropic's
 * 5-command `str_replace_based_edit_tool` needs to reason about a
 * 10-command `file` tool every call; the description is what
 * bridges the gap.
 *
 * Target length: 450-550 words (tuned per the decision record's
 * "Description length target" guidance). Shorter loses guidance;
 * longer fattens every turn's context. Tune after the first batch
 * of live command-selection data per revert criteria §1.
 *
 * Structure (matches the Phase 4 task doc §4.3 spec):
 *   1. One-paragraph intro — commands grouped by category
 *   2. Zone quick-reference (3 zones)
 *   3. Worked-examples table — natural-language intent → command
 *   4. Mode notes for str_replace (the 3-mode disambiguator)
 *   5. Anti-patterns — what NOT to do
 *   6. Delivery guidance — mention the Open affordance post-write
 *   7. Cross-reference to run_shell
 */
const FILE_TOOL_DESCRIPTION = `Unified filesystem tool. One tool, many commands, chosen via the 'command' arg. Use file.write zone="workspace" to create durable workspace artifacts, including self-contained interactive HTML artifact workspace mini-apps rendered in Work. In those HTML artifacts, use await window.nwState.emit(topic, payload) to enqueue an event for your next turn, or await window.nwState.ping(topic, payload) when a user action should enqueue the event and wake you immediately; keep payload JSON-serializable and drain it later with read_artifact_events.

Read commands (non-destructive, parallel-safe):
- list: directory entries (optional recursive, explicit depth, limit, includeIgnored and discoveryCursor). Local recursive discovery has no implicit depth cutoff. Inspect incompleteReasons and per-directory descendants; depth-limited or skipped directories are not fully enumerated. In Workspace, path is a logical prefix: omit path to list the Workspace root; never pass an empty string. Then filter the returned logical paths.
- read: text file contents (path is always required; a prior grep/read never establishes an implicit current file, and lineRange does not identify one; optional offset/limit or inclusive lineRange select a line window, with lineRange taking precedence when both forms appear; offset 0 and 1 both mean the first line). Text results preserve exact UTF-8 bytes, including newlines, in JSON content with startByte/endByte, line bounds and a sourceVersion. Echo nextCursor as readCursor on the same path until null to finish the requested range; use nextLineOffset to start the next range. Partial-line flags mean that the line continues across byte pages, not that it was discarded. A stale cursor requires restarting the range. There is no git_history file zone: a security scanner's historyOnlyPath is provenance, never a file.read target. For closed .docx/.xlsx/.pptx documents, use officecli view instead. For images (PNG/JPEG/GIF/WebP) and PDFs the tool returns a multimodal block the active vision/PDF-capable model sees natively — call read on the file path; do NOT base64 it yourself or describe it from filename alone. If the active model lacks vision/PDF support the tool returns a clean rejection string instead of a binary error.
- glob: Desktop-local native ripgrep file discovery for current/absolute zones only (pattern, path, optional limit/includeIgnored/hidden). Workspace returns unsupported_zone; use file.list with a logical path prefix and filter its returned paths. For local search, path must be a non-empty directory; use path:"." for the selected zone root. Defaults to 1000 returned paths and always excludes .git internals.
- grep: Desktop-local native ripgrep regex search for current/absolute zones only (query is always required; pattern belongs to glob; path names a search directory or one exact file; optional glob/lineRange/limit/caseMode/includeIgnored/hidden). Workspace returns unsupported_zone; use file.list to identify artifacts and file.read to inspect selected contents. Workspace full-text search is unavailable. For local search, use path:"." for the selected zone root.
- stat: file or directory metadata (size, mtime, type).
For local list/glob/grep pages, echo nextCursor as discoveryCursor with the same zone/path/query/filters until null. The cursor validates the discovery result set; it is not an immutable source snapshot. Changing the query starts new discovery. complete and scopeExclusions distinguish page exhaustion from omitted scope. Use includeIgnored:true or explicit deeper directory queries when needed; never imply a truncated result is all matches.

Write and edit commands (apply immediately to disk; revertable — the user sees a diff with a Revert button):
- write: create or overwrite (mode: overwrite, append, or prepend).
- insert: insert content at a 1-indexed line.
- str_replace: find-and-replace; three disambiguator modes described below.
- move: rename or move (same-zone or cross-zone).
- copy: duplicate (same-zone or cross-zone).

Destructive commands (apply immediately to disk; revertable; HIL policy is enforced before the tool call):
- delete: remove a file (recursive=true to remove a directory).

History commands (read-only enumeration + immediate restores):
- undo: apply a reverse edit immediately to revert a prior change on ONE file. Args { path, zone, revisionId?, targetTurnId? }. When the user references a specific edit to revert they will give you a revisionId — pass it through; omit it to undo the most recent edit to that file. Omit both id fields for "most recent edit I made on this file". Returns the standard applied envelope. Error shapes (each a JSON error object you should read and narrate): 'no_revisions' (this file has no history from me), 'revision_not_found' (id/turnId didn't match; error includes availableRevisions so you can re-propose), 'file_missing' (diff-kind revision + file no longer on disk — distinct from drift), 'already_at_target_state' (current disk bytes already match the state I'd restore; no-op), 'drift' (hot-lane reverse diff can't apply against current bytes; error includes the stored diffText for hand-inspection).
- undo_turn: atomically restore EVERY active canonical Workspace artifact I changed in a given turn. Args { targetTurnId, zone:"workspace" }. Returns { turnId, appliedCount, outcomes[] }. If any artifact has a later/interleaved edit, lost authority, lease, or version conflict, nothing is restored. Use when the user asks "undo the whole round" — clearer and safer than looping undo N times.
- redo: apply a forward edit immediately to walk BACK from a prior undo. Args { path, zone }. No selection args — always goes to the most-recent-redo-eligible revision. Use for "redo that" / "actually go back to the edited version" / ⌘⇧Z.
- list_revisions: enumerate my edit history. Args { path?, revisionTurnId?, since?, until?, limit?, includePinnedOnly? }. Default limit 20, hard cap 200. Returns { revisions[], truncated }. Use when the user asks "what did you change today?" or wants to pick an older revisionId to target with undo. The 'path' filter must be absolute. The list is always agent-scoped — you see your own history; other agents' revisions on the same file are not exposed through this command (or any other history command).
- pin_revision / unpin_revision: mark a revision as protected from GC / unprotect it. Args { revisionId }. Returns { ok, revisionId, pinned } on success, or { error: 'revision_not_found', revisionId, hint } on failure (a revisionId that doesn't belong to you is indistinguishable from one that doesn't exist — you can only pin or unpin your own revisions). Use ONLY on explicit user request ("pin this", "remember this version") — pins compete for the total-size cap; don't pin proactively.

Zones (the 'zone' arg, required on every command):
- "workspace": your server-authoritative artifact workspace, scoped by the current Room's Namespace rules. Artifacts you save here are namespace-gated content (like memory) — they're visible only in rooms whose Namespace satisfies the subset rule. Use for durable artifacts: drafts, research, generated docs, files the user sent you. The 'path' here is a logical artifact path, not a filesystem path; renames don't move bytes. Binary delivered formats (copy) support zone="workspace" and mint or update artifact rows with the correct mimeType.
- "current": the folder the user has opened for this task. Filesystem-direct, not namespace-scoped. Read by default; only write when the user explicitly tells you to modify a file.
- "absolute": an explicit absolute path the user provided. Filesystem-direct, not namespace-scoped. Common for requests like "look at /tmp/x.log".

Natural-language to command map:
- "what's in this folder?" -> list (current; recursive:false by default).
- "read this file" -> read (offset/limit for large files).
- "find every TypeScript file in Current Folder" -> glob (for example pattern:"**/*.ts").
- "find Workspace artifacts under drafts/" -> list with path:"drafts/", then filter returned logical paths.
- "find everywhere Current Folder contains X" -> grep. For Workspace artifacts, list candidates and read selected contents.
- "how big is this?" -> stat (size, mtime, type).
- "save this for later" -> write (applies immediately and returns revisionId when recorded).
- "fix the typo on line 42" -> str_replace (applies immediately; include context, or pass lineRange).
- "rewrite this whole function" -> str_replace (bookend mode: startFragment + endFragment).
- "replace lines 150-190 with this" -> str_replace (lineRange alone, no oldString).
- "insert a note before line 100" -> insert (explicit lineNumber).
- "change this file's name" -> move (same-zone rename).
- "put a copy in my workspace" -> copy (cross-zone copy).
- "delete this" -> delete (HIL unless workspace).
- "undo that" / "revert" / "go back" / "take that change out" -> undo (most-recent-edit default; specify path + zone; pass revisionId when the user names a specific edit).
- "undo the whole last round" / "revert everything you just did" -> undo_turn (with the targetTurnId from the transcript context).
- "redo" / "actually go back to the edited version" / ⌘⇧Z -> redo.
- "what did you change today?" / "show me my edit history" / "what files have you touched?" -> list_revisions (optional since/until for time-scoping; include path if you want file-specific history).
- "pin this version" / "remember this state" / "don't lose this" -> pin_revision.
- "unpin that" / "release that version" -> unpin_revision.

File edits apply immediately:
Write/edit/delete commands write to disk right away — no staging and no second turn to confirm. The tool result is a JSON envelope: { applied: true, revisionId?, path, zone, command, stats, summary, unifiedDiff }. In your reply, briefly say what you changed; do not ask them to confirm the diff. The workbench shows a diff with a Revert button; the user can undo any change, or ask you to call undo.

str_replace has three modes; pick exactly one disambiguator:
- Mode A (classic find/replace): { oldString, newString, replaceAll?, lineRange? }. oldString must be unique in the file (or within lineRange). Small surgical edits.
- Mode B (range-replace, no find): { lineRange, newString }. Replaces all lines from..to with newString. Use when you know the line numbers from a prior read.
- Mode C (bookend, Papyrus pattern): { startFragment, endFragment, newString }. The tool finds everything between the fragments; you emit only ~1-3 lines of start + ~1-3 lines of end. Best for large-span rewrites (50+ lines) where Mode A would force you to regurgitate old content.

Anti-patterns to avoid:
- Don't use 'write' to change a single line — use 'str_replace'.
- Don't paste long rendered content into chat after a write. The tool card above your reply has an Open affordance the user can tap.
- Don't str_replace without having read the file in this session — the staleness guard will reject you.
- Don't use 'run_shell' for file operations. That's for shell commands (builds, tests); this tool is for files.
- Don't use write to hand-author PDF bytes or ask the model to restate a document for conversion. Use the dedicated convert tool; conversion is programmatic and deterministic.
- If a str_replace needs more than ~200 chars of oldString to be unique, switch to bookend mode or narrow with lineRange.
- Don't ask permission before editing — just make the change and briefly describe it.
- Don't tell the user to confirm a diff — edits already landed; mention Revert if they might want to roll back.

Delivery note: after a write, str_replace, or insert applies, briefly say what you changed — e.g. "Wrote <path> — open in Work to view; revert from the diff card if it's not what you wanted." Don't regurgitate the content; the DiffView shows the red/green change directly. If the result includes an Open affordance, mention it naturally.

History notes (D087 Phase 3 — load-bearing rules about undo semantics):

- When the user asks to undo or revert a change, USE file.undo (or file.undo_turn for the whole round). DON'T rewrite the old content from memory — the revision store has the exact pre-state bytes, and rewriting is both slower AND prone to hallucination. If file.undo returns { error: "no_revisions" }, say so directly rather than guessing at what the old state looked like.
- A revert is itself revertable — calling undo again or redo walks the timeline. If the user asks to go back to the edited version after an undo, use redo.
- undo applies immediately — once the tool returns success, past tense is correct ("reverted", "undid").
- Pin sparingly. Pins compete for the deployment-wide storage cap. Pin only on explicit user request ("pin this version", "remember this state"), not proactively on every important-seeming edit.

Block-addressable commands (D121-P6, shipped): for HTML5 + <nw-*> artifacts under zone="workspace", you have list_blocks, read_block, replace_block, insert_block, move_block, and rewrite_block. Prefer these over 'read' + 'str_replace' for structured HTML — they address blocks by stable id (no large oldString context), and 'move_block' carries zero body content so reorders stay cheap. The block commands are workspace-only; for plain markdown / XML in zone="current" or zone="absolute", keep using 'read' + 'str_replace'.`;

const SECURITY_RESEARCH_FILE_TOOL_DESCRIPTION = `Read-only Current Folder file access for an active security research Task. Only list, read, glob, grep, and stat are available; mutation and history fields do not exist in this Task. Always pass zone="current" and a concrete path: use path="." only for the selected-folder root, a subdirectory for list/glob, and either a directory or exact relative file for grep; read/stat require an exact relative file path. read accepts offset/limit or an inclusive lineRange, with lineRange taking precedence. glob requires pattern. grep requires query. Read results preserve UTF-8 byte windows with sourceVersion and line metadata. Echo nextCursor as readCursor on the same path until null to finish a requested range or long line; nextLineOffset starts a later range. For list/glob/grep, echo nextCursor as discoveryCursor with the exact same path/query/filters until null; sourceVersionScope identifies the discovery snapshot. Inspect scopeExclusions, incompleteReasons and per-directory descendants: page exhaustion does not mean omitted directories were searched. Local recursive list has no implicit depth limit; includeIgnored:true retrieves skipped directories. A changed source/result set requires restarting its range/query, not combining versions. Keep reads bounded and use returned line/byte metadata for citations.`;

export function createFileTool(context?: unknown) {
  const fileCtx = contextFromUnknown(context);

  return new DynamicStructuredTool({
    name: "file",
    description: fileCtx.securityResearchReadOnly
      ? SECURITY_RESEARCH_FILE_TOOL_DESCRIPTION
      : FILE_TOOL_DESCRIPTION,
    schema: fileCtx.securityResearchReadOnly
      ? securityResearchFileToolSchema
      : fileToolSchema,
    /**
     * The `func` receives already-Zod-validated args. Resolves the
     * turn's ZoneContext from the factory closure (ownerId,
     * currentFolder, workspacePath from agent state) and dispatches.
     *
     * Per-command log tag (`[file:<command>]`) is ADDED at the log
     * call — G4 commit 12 wires the same tag convention into the
     * token-batcher so `grep '[file:str_replace]' server.log` works
     * across the whole tool lifecycle. This log is the handler-
     * internal trace; tool.start/tool.end events on the WS bus are
     * still branded with the bare tool name `file` (per the D083
     * tool-card expectations).
     */
    func: async (rawArgs: FileToolRawArgs, _runManager, runConfig) => {
      const requiredHost = getRequiredOrdinaryHostContext();
      const zoneCtx: ZoneContext = {
        workspaceRoot: requiredHost?.workspaceRoot ?? fileCtx.workspacePath,
        currentFolder: requiredHost?.currentFolderRoot ?? (fileCtx.currentFolder || null),
      };
      const args = applySelectedCurrentFolderReadDefaults(
        rawArgs,
        zoneCtx.currentFolder,
      );
      log(`[file:${args.command}] path=${args.path} zone=${args.zone}`);
      const readInputError = selectedCurrentFolderReadInputError(args, zoneCtx.currentFolder);
      if (readInputError !== null) return fileToolError(readInputError);

      const currentTurnId = getCurrentTurnId();
      const configuredMutationRequestId: unknown =
        runConfig?.configurable?.["fileToolMutationRequestId"];
      const trustedMutationRequestId =
        typeof configuredMutationRequestId === "string" &&
        configuredMutationRequestId.trim().length > 0
          ? configuredMutationRequestId
          : _runManager?.runId;
      if (
        args.retryRequestId &&
        !fileMutationRetryMatches(args.retryRequestId, args)
      ) {
        return JSON.stringify({
          error: "invalid_retry",
          code: "invalid_retry",
          message:
            "Workspace mutation retry token does not match this command, path, and arguments.",
        });
      }
      const mutationRequestId =
        args.retryRequestId ??
        (trustedMutationRequestId
          ? createFileMutationRequestId(trustedMutationRequestId, args)
          : undefined);

      const historyRoutingError = isLocalHistoryRoutingError(args, {
        currentFolder: zoneCtx.currentFolder ?? null,
      });
      if (historyRoutingError) {
        return fileToolError(JSON.stringify({
          error: historyRoutingError.code,
          message: historyRoutingError.message,
          ...(historyRoutingError.hint ? { hint: historyRoutingError.hint } : {}),
        }));
      }

      // M206 — one typed `local-file` relay dispatch for every command
      // whose effective zone is `current` or `absolute`, plus zone-less
      // history commands that carry explicit local authority (zone and/or
      // `local:<relayId>:<uuid>` revision refs). No fs primitives, no
      // server filesystem or Postgres fallback for those routes.
      if (
        isLocalFileZone(args.zone) ||
        shouldRouteHistoryViaLocalRelay(args, { currentFolder: zoneCtx.currentFolder ?? null })
      ) {
        return await executeLocalFileCommand(args, {
          zoneCtx,
          ownerId: fileCtx.ownerId,
          agentId: fileCtx.agentId,
          ...(currentTurnId !== undefined ? { turnId: currentTurnId } : {}),
          ...(mutationRequestId ? { mutationRequestId } : {}),
          ...(fileCtx.activeModelId ? { activeModelId: fileCtx.activeModelId } : {}),
          approvalObtained: true,
        });
      }

      const dispatchCtx: DispatchContext = {
        zoneCtx,
        ...(mutationRequestId
          ? {
              mutationRequestId,
            }
          : {}),
        ...(runConfig?.signal ? { signal: runConfig.signal } : {}),
        backend: new LocalFileBackend(),
        ownerId: fileCtx.ownerId,
        ...(currentTurnId !== undefined ? { turnId: currentTurnId } : {}),
        ...(fileCtx.activeModelId ? { activeModelId: fileCtx.activeModelId } : {}),
        ...(fileCtx.agentId ? { agentId: fileCtx.agentId } : {}),
        ...(fileCtx.roomId ? { roomId: fileCtx.roomId } : {}),
        memoryAccessEnvelope: fileCtx.memoryAccessEnvelope,
      };

      try {
        return await dispatchFileCommand(args, dispatchCtx);
      } catch (err) {
        // Defensive — Zod validates + handlers return string errors;
        // anything thrown here is a programming bug. Surface it to
        // the LLM with the command name so the error message is
        // actionable ("file:write failed: EACCES" is better than
        // "Tool 'file' failed").
        const msg = err instanceof Error ? err.message : String(err);
        return fileToolError(`Error in file:${args.command}: ${msg}`);
      }
    },
  });
}
