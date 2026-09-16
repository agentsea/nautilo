/**
 * M088B — `zone: "workspace"` command dispatch for the `file` tool.
 *
 * Workspace operations no longer treat `<workspaceRoot>/<path>` as the
 * source of truth. The artifact DB row (and its `artifact_namespaces`
 * junction rows) is. This module routes each supported command through
 * the artifact-store and synthesizes a physical-path resolution for
 * the existing content/structural staging helpers. Reads (list, read,
 * stat) are served directly off the DB index. Native path/content search
 * deliberately remains a Desktop-local capability: Workspace glob/grep
 * fail before artifact lookup or physical storage resolution.
 *
 * Bytes live under the server-owned artifact root (`getArtifactsRoot()`,
 * default `~/.nautilo/artifacts/`) — independent of any client-supplied
 * `workspacePath`. Existing rows whose `namespace_id` was the M088A
 * column live on through their `artifact_namespaces` junction row(s);
 * mutations check overlap with the envelope's `mutableNamespaces`.
 *
 * D306 Phase 1B — `copy` now mints or updates workspace artifact rows
 * (binary delivered formats).
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ToolMessage } from "@langchain/core/messages";
import { mimeFromExtensionOr } from "@nautilo/attachments";
import { log } from "@nautilo/logger";
import {
  agentDb,
  getArtifactNamespaces,
} from "@nautilo/db";
import { withAgentTrustContext } from "../../store/trust-agent-db";
import {
  envelopeFactsForArtifacts,
  listWorkspaceArtifacts,
  resolveWorkspaceArtifact,
  validateLogicalPath,
  type EnvelopeFacts,
  type WorkspaceArtifactPatchMeta,
} from "./artifact-store";
import type { CommandResolution } from "./commands/_shared";
import type { DispatchContext } from "./dispatch";
import type { FileCommandArgs, FileToolRawArgs } from "./schema";
import { handleRead } from "./commands/read";
import { handleWrite } from "./commands/write";
import { handleInsert } from "./commands/insert";
import { handleStrReplace } from "./commands/str-replace";
// D121-P4 / D087-P2B — six block-edit commands. All operate on the
// resolved artifact's physical bytes via linkedom; mutating commands
// stage through the existing D087 pipeline.
import {
  handleInsertBlock,
  handleListBlocks,
  handleMoveBlock,
  handleReadBlock,
  handleReplaceBlock,
  handleRewriteBlock,
} from "./blocks";
import { rejectIfOpenInWriter } from "./live-review-write-guard";
import { fileToolError } from "./file-result-status";
import {
  getWorkspaceCanonicalHistoryRestoreExecution,
  getWorkspaceCanonicalUndoTurnExecution,
  getWorkspaceFileContentRecoveryExecution,
  getWorkspaceFileStructuralMutationExecution,
} from "./workspace-runtime-adapter";
export { applyWorkspaceArtifactRowChange } from "./artifact-store";

export async function handleWorkspaceUndoTurn(
  args: FileCommandArgs<"undo_turn">,
  ctx: DispatchContext,
): Promise<string> {
  if (
    typeof args.targetTurnId !== "string" ||
    args.targetTurnId.trim().length === 0
  ) {
    return fileToolError("Error: undo_turn requires 'targetTurnId' (string)");
  }
  const execution = getWorkspaceCanonicalUndoTurnExecution();
  const envelope = ctx.memoryAccessEnvelope;
  if (
    execution === undefined ||
    envelope === null ||
    envelope === undefined ||
    !ctx.agentId ||
    !ctx.roomId ||
    !ctx.turnId ||
    !ctx.mutationRequestId
  ) {
    return fileToolError(JSON.stringify({
      error: "missing_context",
      code: "missing_context",
      message: "Canonical Workspace undo_turn context is unavailable.",
    }));
  }
  const result = await execution({
    authority: {
      envelope,
      ownerId: ctx.ownerId,
      agentId: ctx.agentId,
      roomId: ctx.roomId,
      turnId: ctx.turnId,
    },
    mutationRequestId: ctx.mutationRequestId,
    targetTurnId: args.targetTurnId,
  });
  if (!result.ok) {
    return fileToolError(JSON.stringify({
      error: result.code,
      code: result.code,
      message: result.message,
      ...(result.retryable ? { retryable: true } : {}),
      ...(result.mutationRequestId
        ? { mutationRequestId: result.mutationRequestId }
        : {}),
    }));
  }
  return JSON.stringify({
    turnId: args.targetTurnId,
    appliedCount: result.outcomes.length,
    outcomes: result.outcomes,
    summary:
      `Atomically reverted ${result.outcomes.length} canonical Workspace artifact` +
      (result.outcomes.length === 1 ? "." : "s."),
  });
}

const WORKSPACE_ARTIFACT_COMMANDS = new Set<FileToolRawArgs["command"]>([
  "list",
  "read",
  "glob",
  "grep",
  "stat",
  "write",
  "insert",
  "str_replace",
  "delete",
  "move",
  "copy",
  // M162 — undo/redo must resolve the artifact's physical storage path
  // (and sync its row) rather than fall through to the generic
  // workspace-FS resolver, which addressed the Genie Workspace tree and
  // could never find artifact-store bytes (file_missing on Revert).
  "undo",
  "redo",
  // D121-P4 / D087-P2B — block-edit surface. Workspace-only; the
  // filesystem-zone dispatcher rejects these because the substrate is
  // designed around the artifact DB index.
  "list_blocks",
  "read_block",
  "replace_block",
  "insert_block",
  "move_block",
  "rewrite_block",
]);

export function isWorkspaceArtifactCommand(
  command: FileToolRawArgs["command"],
): boolean {
  return WORKSPACE_ARTIFACT_COMMANDS.has(command);
}

function unsupportedWorkspaceSearch(command: "glob" | "grep"): string {
  const message = command === "glob"
    ? 'Not supported for Workspace artifacts. Please use file.list with zone: "workspace" and a logical path prefix, then filter the returned paths.'
    : 'Not supported for Workspace artifacts. Please use file.list with zone: "workspace" to identify artifacts and file.read to inspect selected contents. Workspace full-text search is not available.';
  return fileToolError(JSON.stringify({
    error: "unsupported_zone",
    code: "unsupported_zone",
    message,
  }));
}

async function getArtifactNamespacesInTrustContext(
  artifactRowId: string,
  facts: EnvelopeFacts,
): Promise<string[]> {
  return withAgentTrustContext(
    { userId: facts.userId, agentId: facts.agentId },
    async (tx) => {
      const conn = tx as unknown as typeof agentDb;
      return getArtifactNamespaces(artifactRowId, conn);
    },
  );
}

/**
 * Pick the namespace id the workspace-artifact metadata should reference
 * for a mutation. The artifact may attach to multiple namespaces; the
 * staged-patch shape carries one (it's used as a back-pointer for
 * observability + the row lookup the apply path performs). We prefer
 * the first namespace from the artifact's attached set that overlaps
 * the envelope's `mutableNamespaces` so the verb the user is acting in
 * always wins. An attachment that is not mutable for this invocation is
 * never a mutation authority, so there is deliberately no fallback to the
 * first attached namespace.
 *
 * Returns `null` when the artifact has no junction rows at all (a
 * malformed state) so the caller can surface a concrete error.
 */
export async function pickMutationNamespaceId(
  artifactRowId: string,
  facts: EnvelopeFacts,
): Promise<string | null> {
  const attached = await getArtifactNamespacesInTrustContext(artifactRowId, facts);
  if (attached.length === 0) return null;
  const overlap = attached.find((id) => facts.mutableNamespaces.includes(id));
  return overlap ?? null;
}

async function rejectOpenWorkspaceArtifact(
  ownerId: string,
  artifactInternalId: string,
): Promise<string | null> {
  return rejectIfOpenInWriter({
    surface: "workspace",
    ownerId,
    artifactId: artifactInternalId,
  });
}

/**
 * M088B — top-level entry point for any `zone: "workspace"` (or legacy
 * `home` / `scratch` alias) command. Per-command branches encode the
 * authorization rules from the issue:
 *
 *   - list / read / stat / grep → readableNamespaces, agent-scoped
 *   - write (existing or new) → existing in mutableNamespaces OR new
 *     into writableNamespaces[0]
 *   - insert / str_replace / delete → existing in mutableNamespaces
 *   - move → logical rename within the artifact's existing attachment
 *     (cross-namespace shares require `share_artifact`)
 *   - copy → create or update workspace artifacts with binary bytes +
 *     mimeType
 */
export async function dispatchWorkspaceCommand(
  raw: FileToolRawArgs,
  ctx: DispatchContext,
): Promise<string | ToolMessage> {
  const args = raw;
  // Workspace artifacts are logical, DB-authorized resources. Do not bridge
  // them into a native filesystem search runtime. This denial intentionally
  // precedes envelope parsing, artifact queries, storage-URI resolution, and
  // temporary projection creation.
  if (args.command === "glob" || args.command === "grep") {
    return unsupportedWorkspaceSearch(args.command);
  }

  if (args.retryRequestId) {
    const execution = getWorkspaceFileContentRecoveryExecution();
    const envelope = ctx.memoryAccessEnvelope;
    if (
      execution === undefined ||
      envelope === null ||
      envelope === undefined ||
      !ctx.agentId ||
      !ctx.roomId ||
      !ctx.turnId ||
      !ctx.mutationRequestId
    ) {
      return JSON.stringify({
        error: "reapply_required",
        code: "reapply_required",
        message:
          "Workspace mutation recovery is unavailable. Re-read the artifact and reapply the edit.",
      });
    }
    const recovered = await execution({
      authority: {
        envelope,
        ownerId: ctx.ownerId,
        agentId: ctx.agentId,
        roomId: ctx.roomId,
        turnId: ctx.turnId,
      },
      mutationRequestId: ctx.mutationRequestId,
      command: args.command,
    });
    if (!recovered.ok) {
      return JSON.stringify({
        error: recovered.code,
        code: recovered.code,
        message: recovered.message,
        ...(recovered.retryable ? { retryable: true } : {}),
      });
    }
    return JSON.stringify({
      applied: true,
      recovered: true,
      revisionId: recovered.revisionId,
      path: args.path,
      zone: "workspace",
      command: args.command,
      ...(args.destinationPath
        ? { destinationPath: args.destinationPath }
        : {}),
      ...(recovered.artifactId === undefined
        ? {}
        : { artifactId: recovered.artifactId }),
      ...(recovered.artifactInternalId === undefined
        ? {}
        : { artifactInternalId: recovered.artifactInternalId }),
    });
  }

  const factsResult = envelopeFactsForArtifacts(ctx.memoryAccessEnvelope);
  if (!factsResult.ok) return fileToolError(`Error: ${factsResult.reason}`);
  const facts = factsResult.facts;
  if (!facts.agentId) {
    return fileToolError("Error: workspace artifact access requires an authenticated agent context.");
  }

  switch (args.command) {
    case "list":
      return await handleWorkspaceList(args, ctx, facts);
    case "read":
      return await handleWorkspaceRead(args, ctx, facts);
    case "stat":
      return await handleWorkspaceStat(args, ctx, facts);
    case "write":
      return await handleWorkspaceWrite(args, ctx, facts);
    case "insert":
      return await handleWorkspaceMutate(args, ctx, facts, "insert", handleInsert as unknown as MutateHandler);
    case "str_replace":
      return await handleWorkspaceMutate(args, ctx, facts, "str_replace", handleStrReplace as unknown as MutateHandler);
    case "delete":
      return await handleWorkspaceDelete(args, ctx, facts);
    case "undo":
      return await handleWorkspaceUndoRedo(args, ctx, "undo");
    case "redo":
      return await handleWorkspaceUndoRedo(args, ctx, "redo");
    case "move":
      return await handleWorkspaceMove(args, ctx, facts);
    case "copy":
      return await handleWorkspaceCopy(args, ctx, facts);
    case "list_blocks":
      return await handleWorkspaceBlockRead(args, ctx, facts, "list_blocks", handleListBlocks);
    case "read_block":
      return await handleWorkspaceBlockRead(args, ctx, facts, "read_block", handleReadBlock);
    case "replace_block":
      return await handleWorkspaceBlockMutate(args, ctx, facts, "replace_block", handleReplaceBlock);
    case "insert_block":
      return await handleWorkspaceBlockMutate(args, ctx, facts, "insert_block", handleInsertBlock);
    case "move_block":
      return await handleWorkspaceBlockMutate(args, ctx, facts, "move_block", handleMoveBlock);
    case "rewrite_block":
      return await handleWorkspaceBlockMutate(args, ctx, facts, "rewrite_block", handleRewriteBlock);
    default:
      // Shouldn't reach here; dispatch filters on isWorkspaceArtifactCommand.
      return fileToolError(`Error: workspace dispatch reached unsupported command '${(args as { command: string }).command}'`);
  }
}

// ---------------------------------------------------------------------------
// Read-side handlers — served directly from the DB index
// ---------------------------------------------------------------------------

async function handleWorkspaceList(
  args: FileToolRawArgs,
  _ctx: DispatchContext,
  facts: EnvelopeFacts,
): Promise<string> {
  // Treat `path` as a logical-path prefix filter. Empty / "." / "/" means
  // "list everything visible".
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  let prefix = "";
  if (rawPath && rawPath !== "." && rawPath !== "/") {
    const validated = validateLogicalPath(rawPath);
    if (!validated.ok) return fileToolError(`Error: ${validated.reason}`);
    prefix = validated.path;
  }

  const rows = await listWorkspaceArtifacts(facts, {
    ...(prefix ? { pathPrefix: prefix } : {}),
  });
  // Bulk-fetch namespace attachments per row for the response. Cheap
  // because list is bounded by visible rows; no pagination concern in
  // M088B (Phase 5 introduces server HTTP routes that paginate).
  const entries = await Promise.all(
    rows.map(async (row) => ({
      artifactId: row.artifactId,
      path: row.path,
      type: "file",
      mimeType: row.mimeType,
      size: row.size,
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
      namespaceIds: await getArtifactNamespacesInTrustContext(row.id, facts),
    })),
  );
  return JSON.stringify(
    {
      zone: "workspace",
      pathPrefix: prefix || null,
      entries,
      count: entries.length,
    },
    null,
    2,
  );
}

async function handleWorkspaceStat(
  args: FileToolRawArgs,
  _ctx: DispatchContext,
  facts: EnvelopeFacts,
): Promise<string> {
  const validated = validateLogicalPath(args.path);
  if (!validated.ok) return fileToolError(`Error: ${validated.reason}`);
  const resolution = await resolveWorkspaceArtifact({
    logicalPath: validated.path,
    facts,
    intent: "read",
  });
  if (!resolution.ok) return fileToolError(`Error: ${resolution.reason}`);
  if (!resolution.artifact) {
    return fileToolError(`Error: No workspace artifact at "${validated.path}".`);
  }
  const row = resolution.artifact;
  let fileSize: number | null = row.size;
  try {
    const st = await fsp.stat(resolution.physicalPath);
    fileSize = st.size;
  } catch {
    // Disk byte-size unavailable; fall back to the row's recorded size.
  }
  const namespaceIds = await getArtifactNamespacesInTrustContext(row.id, facts);
  return JSON.stringify(
    {
      zone: "workspace",
      path: row.path,
      artifactId: row.artifactId,
      mimeType: row.mimeType,
      size: fileSize,
      revision: row.revision,
      namespaceIds,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
    null,
    2,
  );
}

async function handleWorkspaceRead(
  args: FileToolRawArgs,
  ctx: DispatchContext,
  facts: EnvelopeFacts,
): Promise<string | ToolMessage> {
  const validated = validateLogicalPath(args.path);
  if (!validated.ok) return fileToolError(`Error: ${validated.reason}`);
  const resolution = await resolveWorkspaceArtifact({
    logicalPath: validated.path,
    facts,
    intent: "read",
  });
  if (!resolution.ok) return fileToolError(`Error: ${resolution.reason}`);
  if (!resolution.artifact) {
    return fileToolError(`Error: No workspace artifact at "${validated.path}".`);
  }
  const synth: CommandResolution = {
    resolved: resolution.physicalPath,
    resolvedZone: "workspace",
  };
  return await handleRead(args as Parameters<typeof handleRead>[0], synth, ctx);
}

// ---------------------------------------------------------------------------
// Write / mutate / delete — stage through existing helpers, stamp metadata
// ---------------------------------------------------------------------------

async function handleWorkspaceWrite(
  args: FileToolRawArgs,
  ctx: DispatchContext,
  facts: EnvelopeFacts,
): Promise<string> {
  const validated = validateLogicalPath(args.path);
  if (!validated.ok) return fileToolError(`Error: ${validated.reason}`);
  const resolution = await resolveWorkspaceArtifact({
    logicalPath: validated.path,
    facts,
    intent: "create_or_update",
  });
  if (!resolution.ok) return fileToolError(`Error: ${resolution.reason}`);

  let mode: "create" | "update";
  let namespaceId: string;
  if (resolution.artifact) {
    mode = "update";
    const picked = await pickMutationNamespaceId(resolution.artifact.id, facts);
    if (!picked) {
      return fileToolError(`Error: artifact ${resolution.artifactId} has no namespace attachment (orphaned junction).`);
    }
    namespaceId = picked;
  } else {
    if (facts.writableNamespaces.length === 0) {
      return fileToolError(
        "Error: no writable namespace for new workspace artifacts. " +
        "Open a room with namespace write access before creating new artifacts."
      );
    }
    mode = "create";
    namespaceId = facts.writableNamespaces[0]!;
  }

  const mimeType = mimeFromExtensionOr(resolution.logicalPath);
  const meta: WorkspaceArtifactPatchMeta = {
    mode,
    artifactId: resolution.artifactId,
    logicalPath: resolution.logicalPath,
    namespaceId,
    storageUri: resolution.storageUri,
    mimeType,
    ...(resolution.artifact
      ? {
          rowId: resolution.artifact.id,
          expectedRevision: resolution.artifact.revision,
        }
      : {}),
  };

  // Ensure the artifacts root exists at stage time so the staging
  // helper's readBytesOrEmpty doesn't trip on the directory not
  // existing yet. apply_patch will writeAtomic into the same dir.
  const parentDir = path.dirname(resolution.physicalPath);
  try {
    await fsp.mkdir(parentDir, { recursive: true });
  } catch (err) {
    return fileToolError(`Error: could not prepare artifact storage dir: ${err instanceof Error ? err.message : String(err)}`);
  }

  const synth: CommandResolution = {
    resolved: resolution.physicalPath,
    resolvedZone: "workspace",
  };
  const augmentedCtx: DispatchContext = { ...ctx, workspaceArtifactMeta: meta };
  log(`[file:write] workspace artifact ${mode} path=${resolution.logicalPath} artifactId=${resolution.artifactId}`);
  return await handleWrite(args as Parameters<typeof handleWrite>[0], synth, augmentedCtx);
}

export async function prepareWorkspaceArtifactTarget(
  logicalPath: string,
  facts: EnvelopeFacts,
): Promise<
  | { ok: true; physicalPath: string; meta: WorkspaceArtifactPatchMeta }
  | { ok: false; reason: string; structured?: true }
> {
  const validated = validateLogicalPath(logicalPath);
  if (!validated.ok) return { ok: false, reason: validated.reason };
  const resolution = await resolveWorkspaceArtifact({
    logicalPath: validated.path,
    facts,
    intent: "create_or_update",
  });
  if (!resolution.ok) return { ok: false, reason: resolution.reason };

  let mode: "create" | "update";
  let namespaceId: string;
  if (resolution.artifact) {
    const gateFailure = await rejectOpenWorkspaceArtifact(
      facts.userId,
      resolution.artifact.id,
    );
    if (gateFailure) {
      return { ok: false, reason: gateFailure, structured: true };
    }
    mode = "update";
    const picked = await pickMutationNamespaceId(resolution.artifact.id, facts);
    if (!picked) {
      return {
        ok: false,
        reason: `artifact ${resolution.artifactId} has no namespace attachment (orphaned junction).`,
      };
    }
    namespaceId = picked;
  } else {
    if (facts.writableNamespaces.length === 0) {
      return {
        ok: false,
        reason:
          "no writable namespace for new workspace artifacts. " +
          "Open a room with namespace write access before creating new artifacts.",
      };
    }
    mode = "create";
    namespaceId = facts.writableNamespaces[0]!;
  }

  const mimeType = mimeFromExtensionOr(resolution.logicalPath);
  const meta: WorkspaceArtifactPatchMeta = {
    mode,
    artifactId: resolution.artifactId,
    logicalPath: resolution.logicalPath,
    namespaceId,
    storageUri: resolution.storageUri,
    mimeType,
    ...(resolution.artifact ? { rowId: resolution.artifact.id } : {}),
  };

  const parentDir = path.dirname(resolution.physicalPath);
  try {
    await fsp.mkdir(parentDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      reason: `could not prepare artifact storage dir: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { ok: true, physicalPath: resolution.physicalPath, meta };
}

async function handleWorkspaceCopy(
  args: FileToolRawArgs,
  ctx: DispatchContext,
  _facts: EnvelopeFacts,
): Promise<string> {
  return executeWorkspaceStructuralMutation(args, ctx, "copy");
}

type MutateHandler = (
  args: FileToolRawArgs,
  resolution: CommandResolution,
  ctx: DispatchContext,
) => Promise<string>;

async function handleWorkspaceMutate(
  args: FileToolRawArgs,
  ctx: DispatchContext,
  facts: EnvelopeFacts,
  commandLabel: string,
  inner: MutateHandler,
): Promise<string> {
  const validated = validateLogicalPath(args.path);
  if (!validated.ok) return fileToolError(`Error: ${validated.reason}`);
  const resolution = await resolveWorkspaceArtifact({
    logicalPath: validated.path,
    facts,
    intent: "mutate",
  });
  if (!resolution.ok) {
    if (resolution.reason.includes("No workspace artifact found at")) {
      return fileToolError(`Error: No workspace artifact at "${validated.path}" to ${commandLabel}.`);
    }
    return fileToolError(`Error: ${resolution.reason}`);
  }
  if (!resolution.artifact) {
    return fileToolError(`Error: No workspace artifact at "${validated.path}" to ${commandLabel}.`);
  }
  const namespaceId = await pickMutationNamespaceId(resolution.artifact.id, facts);
  if (!namespaceId) {
    return fileToolError(`Error: artifact ${resolution.artifactId} has no namespace attachment (orphaned junction).`);
  }

  const mimeType = mimeFromExtensionOr(resolution.logicalPath);
  const meta: WorkspaceArtifactPatchMeta = {
    mode: "update",
    artifactId: resolution.artifactId,
    logicalPath: resolution.logicalPath,
    namespaceId,
    storageUri: resolution.storageUri,
    mimeType,
    rowId: resolution.artifact.id,
    expectedRevision: resolution.artifact.revision,
  };

  const synth: CommandResolution = {
    resolved: resolution.physicalPath,
    resolvedZone: "workspace",
  };
  const augmentedCtx: DispatchContext = { ...ctx, workspaceArtifactMeta: meta };
  return await inner(args, synth, augmentedCtx);
}

/**
 * D448 Phase 11.2 — Workspace undo/redo selects and restores only canonical
 * coordinator receipts. The server owns history selection, immutable receipt
 * bytes, current Room authority, exact-version evidence, and final commit.
 * No physical path or legacy file_revisions row enters this mutation path.
 */
async function handleWorkspaceUndoRedo(
  args: FileToolRawArgs,
  ctx: DispatchContext,
  commandLabel: "undo" | "redo",
): Promise<string> {
  const validated = validateLogicalPath(args.path);
  if (!validated.ok) return fileToolError(`Error: ${validated.reason}`);
  if (args.revisionId && args.targetTurnId) {
    return fileToolError(JSON.stringify({
      error: "revision_not_found",
      message: "Workspace undo accepts at most one of revisionId or targetTurnId.",
    }));
  }
  const execution = getWorkspaceCanonicalHistoryRestoreExecution();
  const envelope = ctx.memoryAccessEnvelope;
  if (
    execution === undefined ||
    envelope === null ||
    envelope === undefined ||
    !ctx.agentId ||
    !ctx.roomId ||
    !ctx.turnId ||
    !ctx.mutationRequestId
  ) {
    return fileToolError(JSON.stringify({
      error: "missing_context",
      message: "Canonical Workspace history restore context is unavailable.",
    }));
  }
  const result = await execution({
    authority: {
      envelope,
      ownerId: ctx.ownerId,
      agentId: ctx.agentId,
      roomId: ctx.roomId,
      turnId: ctx.turnId,
    },
    mutationRequestId: ctx.mutationRequestId,
    command: commandLabel,
    logicalPath: validated.path,
    ...(args.revisionId ? { revisionId: args.revisionId } : {}),
    ...(args.targetTurnId ? { targetTurnId: args.targetTurnId } : {}),
  });
  if (!result.ok) {
    return fileToolError(JSON.stringify({
      error: result.code,
      code: result.code,
      message: result.message,
      ...(result.retryable ? { retryable: true } : {}),
      ...(result.mutationRequestId
        ? { mutationRequestId: result.mutationRequestId }
        : {}),
    }));
  }
  return JSON.stringify({
    applied: true,
    revisionId: result.revisionId,
    path: validated.path,
    zone: "workspace",
    command: commandLabel,
    artifactId: result.artifactId,
    artifactInternalId: result.artifactInternalId,
    summary: `Applied canonical Workspace ${commandLabel}.`,
  });
}

// ---------------------------------------------------------------------------
// D121-P4 / D087-P2B — block-edit wrappers
//
// Read-side block commands (list_blocks / read_block) resolve the
// artifact with `intent: "read"` and hand the physical-path
// resolution to the block handler. Mutate-side commands resolve with
// `intent: "mutate"`, pick the namespace, build a WorkspaceArtifactPatchMeta
// stamp, and dispatch — same pattern as `handleWorkspaceMutate` above
// but specialized to the block-handler signature (no FileToolRawArgs
// reshaping; the handlers accept the raw args directly).
// ---------------------------------------------------------------------------

type BlockHandler = (
  args: FileToolRawArgs,
  resolution: CommandResolution,
  ctx: DispatchContext,
) => Promise<string>;

async function handleWorkspaceBlockRead(
  args: FileToolRawArgs,
  ctx: DispatchContext,
  facts: EnvelopeFacts,
  commandLabel: string,
  inner: BlockHandler,
): Promise<string> {
  const validated = validateLogicalPath(args.path);
  if (!validated.ok) return fileToolError(`Error: ${validated.reason}`);
  const resolution = await resolveWorkspaceArtifact({
    logicalPath: validated.path,
    facts,
    intent: "read",
  });
  if (!resolution.ok) return fileToolError(`Error: ${resolution.reason}`);
  if (!resolution.artifact) {
    return fileToolError(`Error: No workspace artifact at "${validated.path}" to ${commandLabel}.`);
  }
  const synth: CommandResolution = {
    resolved: resolution.physicalPath,
    resolvedZone: "workspace",
  };
  return await inner(args, synth, ctx);
}

async function handleWorkspaceBlockMutate(
  args: FileToolRawArgs,
  ctx: DispatchContext,
  facts: EnvelopeFacts,
  commandLabel: string,
  inner: BlockHandler,
): Promise<string> {
  const validated = validateLogicalPath(args.path);
  if (!validated.ok) return fileToolError(`Error: ${validated.reason}`);
  const resolution = await resolveWorkspaceArtifact({
    logicalPath: validated.path,
    facts,
    intent: "mutate",
  });
  if (!resolution.ok) {
    if (resolution.reason.includes("No workspace artifact found at")) {
      return fileToolError(`Error: No workspace artifact at "${validated.path}" to ${commandLabel}.`);
    }
    return fileToolError(`Error: ${resolution.reason}`);
  }
  if (!resolution.artifact) {
    return fileToolError(`Error: No workspace artifact at "${validated.path}" to ${commandLabel}.`);
  }
  const namespaceId = await pickMutationNamespaceId(resolution.artifact.id, facts);
  if (!namespaceId) {
    return fileToolError(`Error: artifact ${resolution.artifactId} has no namespace attachment (orphaned junction).`);
  }
  const mimeType = mimeFromExtensionOr(resolution.logicalPath);
  const meta: WorkspaceArtifactPatchMeta = {
    mode: "update",
    artifactId: resolution.artifactId,
    logicalPath: resolution.logicalPath,
    namespaceId,
    storageUri: resolution.storageUri,
    mimeType,
    rowId: resolution.artifact.id,
    expectedRevision: resolution.artifact.revision,
  };
  const synth: CommandResolution = {
    resolved: resolution.physicalPath,
    resolvedZone: "workspace",
  };
  const augmentedCtx: DispatchContext = { ...ctx, workspaceArtifactMeta: meta };
  return await inner(args, synth, augmentedCtx);
}

async function handleWorkspaceDelete(
  args: FileToolRawArgs,
  ctx: DispatchContext,
  _facts: EnvelopeFacts,
): Promise<string> {
  return executeWorkspaceStructuralMutation(args, ctx, "delete");
}

/**
 * Workspace move = LOGICAL RENAME ONLY. No FS bytes move. Cross-
 * namespace shares are routed through `share_artifact` instead.
 *
 * Stages a no-op-on-disk patch carrying `workspaceArtifact.mode =
 * "logical_move"`. apply_patch short-circuits BEFORE FS dispatch when
 * it sees the metadata flag and updates the row's `path` column.
 */
async function handleWorkspaceMove(
  args: FileToolRawArgs,
  ctx: DispatchContext,
  _facts: EnvelopeFacts,
): Promise<string> {
  return executeWorkspaceStructuralMutation(args, ctx, "move");
}

async function executeWorkspaceStructuralMutation(
  args: FileToolRawArgs,
  ctx: DispatchContext,
  command: "delete" | "move" | "copy",
): Promise<string> {
  const sourceValidated = validateLogicalPath(args.path);
  if (!sourceValidated.ok) return fileToolError(`Error: ${sourceValidated.reason}`);
  if (command === "delete" && args.recursive === true) {
    return fileToolError(JSON.stringify({
      error: "recursive_not_supported",
      code: "recursive_not_supported",
      message: "Recursive Workspace artifact delete is not supported.",
    }));
  }
  const destinationPath = args.destinationPath;
  if (
    command !== "delete" &&
    (typeof destinationPath !== "string" || destinationPath.length === 0)
  ) {
    return fileToolError(`Error: ${command} requires 'destinationPath' (string)`);
  }
  const destinationZone = args.destinationZone ?? args.zone;
  if (
    command !== "delete" &&
    destinationZone !== "workspace" &&
    destinationZone !== "home" &&
    destinationZone !== "scratch"
  ) {
    return fileToolError(`Error: cross-zone ${command} out of workspace is not supported.`);
  }
  const validatedDestination =
    command === "delete"
      ? undefined
      : validateLogicalPath(destinationPath);
  if (validatedDestination && !validatedDestination.ok) {
    return fileToolError(`Error: destinationPath: ${validatedDestination.reason}`);
  }
  if (
    validatedDestination?.ok &&
    sourceValidated.path === validatedDestination.path
  ) {
    return fileToolError("Error: source and destination paths are identical.");
  }
  const execution = getWorkspaceFileStructuralMutationExecution();
  const envelope = ctx.memoryAccessEnvelope;
  if (
    execution === undefined ||
    envelope === null ||
    envelope === undefined ||
    !ctx.agentId ||
    !ctx.roomId ||
    !ctx.turnId ||
    !ctx.mutationRequestId
  ) {
    return fileToolError(JSON.stringify({
      error: "missing_context",
      code: "missing_context",
      message: "Workspace structural mutation context is unavailable.",
    }));
  }
  const result = await execution({
    authority: {
      envelope,
      ownerId: ctx.ownerId,
      agentId: ctx.agentId,
      roomId: ctx.roomId,
      turnId: ctx.turnId,
    },
    mutationRequestId: ctx.mutationRequestId,
    command,
    logicalPath: sourceValidated.path,
    ...(validatedDestination?.ok
      ? { destinationPath: validatedDestination.path }
      : {}),
    ...(args.recursive !== undefined ? { recursive: args.recursive } : {}),
  });
  if (!result.ok) {
    return fileToolError(JSON.stringify({
      error: result.code,
      code: result.code,
      message: result.message,
      ...(result.retryable ? { retryable: true } : {}),
      ...(result.mutationRequestId
        ? { mutationRequestId: result.mutationRequestId }
        : {}),
    }));
  }
  return JSON.stringify({
    applied: true,
    revisionId: result.revisionId,
    path: sourceValidated.path,
    zone: "workspace",
    command,
    ...(validatedDestination?.ok
      ? { destinationPath: validatedDestination.path }
      : {}),
    artifactId: result.artifactId,
    artifactInternalId: result.artifactInternalId,
    summary: `Applied ${command} to canonical Workspace artifact.`,
  });
}

/** Read `metadata.workspaceArtifact` off a staged patch, narrow-typed. */
export function readWorkspaceArtifactMeta(
  metadata: Record<string, unknown>,
): WorkspaceArtifactPatchMeta | null {
  const raw = metadata["workspaceArtifact"];
  if (!raw || typeof raw !== "object") return null;
  return raw as WorkspaceArtifactPatchMeta;
}
