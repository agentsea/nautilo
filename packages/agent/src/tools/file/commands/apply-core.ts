import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { RelayFsChangeEvent } from "@nautilo/relay";
import {
  FILE_REVISION_OPERATION,
  type FileRevisionOperation,
  type WorkspaceFileRevisionMetadata,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { applyAnchoredSplice } from "../anchor";
import { recordRevision, type RecordRevisionInput } from "../backups";
import { getFileBackend, type DispatchContext } from "../dispatch";
import {
  emitWorkspaceArtifactDocumentPatchFromAnchoredEdit,
} from "../artifact-store";
import { sha256Hex, type StagedPatch } from "../staged-patches";
import {
  applyWorkspaceArtifactRowChange,
  readWorkspaceArtifactMeta,
} from "../workspace-commands";
import { assertRealpathContained } from "../zones";

function currentFileChangeEventForContentWrite(
  patch: StagedPatch,
  ctx: DispatchContext,
  previousSha256: string,
  nextSha256: string,
): RelayFsChangeEvent | undefined {
  if (patch.zone !== "current") return undefined;
  const currentFolder = patch.zoneCtx.currentFolder;
  if (!currentFolder) return undefined;

  const rawPath = patch.metadata.args["path"];
  const relativePath =
    typeof rawPath === "string" && rawPath.length > 0
      ? rawPath
      : path.relative(currentFolder, patch.path);
  const base = {
    rootPath: currentFolder,
    path: path.dirname(patch.path),
    changedPath: patch.path,
    source: "relay" as const,
    op: "writeFileAtomic" as const,
    sha256: nextSha256,
  };

  if (!patch.anchoredEdit) {
    return { ...base, reloadRequired: true };
  }

  return {
    ...base,
    patchEvent: {
      type: "document.patch.applied",
      target: {
        kind: "currentFile",
        currentFolderRef: currentFolder,
        relativePath,
        relayOwnerUserId: ctx.ownerId,
      },
      patchId: patch.patchId,
      revision: null,
      sha256: nextSha256,
      previousRevision: null,
      previousSha256,
      patch: {
        kind: "anchored_text",
        oldString: patch.anchoredEdit.oldString,
        newString: patch.anchoredEdit.newString,
        ...(patch.anchoredEdit.replaceAll !== undefined
          ? { replaceAll: patch.anchoredEdit.replaceAll }
          : {}),
        ...(patch.anchoredEdit.scope ? { scope: patch.anchoredEdit.scope } : {}),
      },
      author: {
        kind: "agent",
        displayName: ctx.agentId ?? "agent",
      },
      rebased: patch.originalSha256 !== previousSha256,
    },
  };
}

export interface AppliedOutcome {
  text: string;
  revisionId?: string;
  error?: boolean;
}

export async function applyEphemeralPatch(
  patch: StagedPatch,
  ctx: DispatchContext,
): Promise<AppliedOutcome> {
  try {
    return await applyContentWrite(patch, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (errCodeMatches(err, "EACCES")) {
      return { text: `Error: permission denied applying patch to ${patch.path}`, error: true };
    }
    if (errCodeMatches(err, "ENOSPC")) {
      return { text: `Error: disk full, cannot apply patch to ${patch.path}`, error: true };
    }
    return { text: `Error applying patch: ${msg}`, error: true };
  }
}

function errCodeMatches(err: unknown, code: string): boolean {
  if (err instanceof Error) {
    const c = (err as NodeJS.ErrnoException).code;
    if (typeof c === "string") return c === code;
    return err.message.includes(code);
  }
  return String(err).includes(code);
}

async function checkApplyContainment(
  patch: StagedPatch,
  targetPath: string,
  ctx: DispatchContext,
): Promise<string | null> {
  const contained = await assertRealpathContained(
    { resolved: targetPath, resolvedZone: patch.zone },
    patch.zoneCtx,
    getFileBackend(ctx),
  );
  if (contained.ok) return null;
  return (
    `Error: apply refused — ${contained.reason}. ` +
    `The path changed on disk between stage and apply (symlink swap or ` +
    `containment drift). Stage preserved; re-read and re-stage if the ` +
    `change is legitimate.`
  );
}

async function applyContentWrite(
  patch: StagedPatch,
  ctx: DispatchContext,
): Promise<AppliedOutcome> {
  const containmentError = await checkApplyContainment(patch, patch.path, ctx);
  if (containmentError) return { text: containmentError, error: true };
  const backend = getFileBackend(ctx);

  let currentBytes: Buffer;
  let targetExistedBefore = true;
  try {
    currentBytes = await backend.readFile(patch.path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (errCodeMatches(err, "ENOENT")) {
      currentBytes = Buffer.alloc(0);
      targetExistedBefore = false;
    } else if (errCodeMatches(err, "EACCES")) {
      return { text: `Error: permission denied reading ${patch.path}`, error: true };
    } else {
      return { text: `Error reading current file state before apply: ${msg}`, error: true };
    }
  }

  let bytesToWrite = patch.newBytes;
  if (patch.anchoredEdit) {
    const splice = applyAnchoredSplice(
      currentBytes.toString("utf-8"),
      patch.anchoredEdit,
    );
    if (!splice.ok) {
      return {
        text: splice.kind === "ambiguous"
          ? anchorAmbiguousError(patch.path)
          : anchorNotFoundError(patch.path),
        error: true,
      };
    }
    bytesToWrite = Buffer.from(splice.text, "utf-8");
  } else {
    const currentSha256 = sha256Hex(currentBytes);
    if (currentSha256 !== patch.originalSha256) {
      return { text: externalChangeError(patch.path), error: true };
    }
  }

  const parent = path.dirname(patch.path);
  await backend.mkdir(parent, { recursive: true });

  const backupInput = buildBackupInput(
    patch,
    ctx,
    currentBytes,
    bytesToWrite,
    operationForContentWrite(patch, targetExistedBefore),
  );
  const previousSha256 = sha256Hex(currentBytes);
  const nextSha256 = sha256Hex(bytesToWrite);
  const currentFileChangeEvent = currentFileChangeEventForContentWrite(
    patch,
    ctx,
    previousSha256,
    nextSha256,
  );

  const results = await Promise.allSettled([
    backend.writeFileAtomic(
      patch.path,
      bytesToWrite,
      currentFileChangeEvent ? { changeEvent: currentFileChangeEvent } : undefined,
    ),
    backupInput ? runBackupCapturingRevisionId(backupInput) : Promise.resolve(undefined),
  ]);
  if (results[0].status === "rejected") {
    throw results[0].reason;
  }

  const wsMetaContent = readWorkspaceArtifactMeta(patch.metadata);
  let rowApplyResult: Awaited<ReturnType<typeof applyWorkspaceArtifactRowChange>> | undefined;
  if (wsMetaContent) {
    try {
      rowApplyResult = await applyWorkspaceArtifactRowChange(
        {
          ...wsMetaContent,
          ...(!patch.anchoredEdit && wsMetaContent.mode === "update"
            ? { reloadRequired: true }
            : {}),
        },
        bytesToWrite.byteLength,
        ctx.ownerId,
        ctx.agentId ?? "",
        { kind: "agent", agentId: ctx.agentId ?? "" },
      );
    } catch (err) {
      return {
        text:
          `Error: Workspace bytes were written but its authoritative row did not update; ` +
          `state is unknown/partial and must be reconciled before retrying. ` +
          `${err instanceof Error ? err.message : String(err)}`,
        error: true,
      };
    }
    if (!rowApplyResult) {
      return {
        text: "Error: Workspace bytes were written but its authoritative row changed or disappeared; state is unknown/partial.",
        error: true,
      };
    }
  }

  if (
    rowApplyResult &&
    patch.anchoredEdit &&
    wsMetaContent &&
    (wsMetaContent.mode === "create" || wsMetaContent.mode === "update")
  ) {
    emitWorkspaceArtifactDocumentPatchFromAnchoredEdit({
      rowInternalId: rowApplyResult.internalId,
      logicalPath: wsMetaContent.logicalPath,
      ...(wsMetaContent.mimeType ? { mimeType: wsMetaContent.mimeType } : {}),
      ...(ctx.roomId ? { roomId: ctx.roomId } : {}),
      previousRevision: rowApplyResult.previousRevision,
      previousSha256,
      newRevision: rowApplyResult.revision,
      newSha256: nextSha256,
      patchId: patch.patchId,
      anchoredEdit: patch.anchoredEdit,
      unifiedDiff: patch.unifiedDiff,
      ...(wsMetaContent.clientMutationId ? { clientMutationId: wsMetaContent.clientMutationId } : {}),
      author: {
        kind: "agent",
        displayName: ctx.agentId ?? "agent",
      },
      rebased: patch.originalSha256 !== previousSha256,
    });
  }

  const revisionId = results[1].status === "fulfilled" ? results[1].value : undefined;
  const bytes = bytesToWrite.byteLength;
  return {
    text: `Applied ${patch.metadata.command} to ${patch.path} (${bytes} bytes, +${patch.stats.additions}/-${patch.stats.deletions}).`,
    ...(revisionId ? { revisionId } : {}),
    error: false,
  };
}

function operationForContentWrite(
  patch: StagedPatch,
  targetExistedBefore: boolean,
): FileRevisionOperation {
  const command = patch.metadata.command as FileRevisionOperation;
  if (
    !targetExistedBefore &&
    (command === FILE_REVISION_OPERATION.WRITE ||
      command === FILE_REVISION_OPERATION.CONVERT ||
      command === FILE_REVISION_OPERATION.WRITE_XLSX ||
      command === FILE_REVISION_OPERATION.WRITE_PPTX)
  ) {
    return FILE_REVISION_OPERATION.CREATE;
  }
  return command;
}

function externalChangeError(p: string): string {
  return (
    `Error: file changed on disk since the patch was staged ` +
    `(${p}). External-change guard prevents silent ` +
    `overwrite. Options: (a) ask the user; (b) inspect revision history to ` +
    `see the staged change; (c) re-read the file, re-stage with ` +
    `updated context, then apply.`
  );
}

function anchorNotFoundError(p: string): string {
  return (
    `Error: could not locate the edit anchor in ${p} — the text it ` +
    `targeted has changed since it was proposed. Re-read the file and ` +
    `re-stage.`
  );
}

function anchorAmbiguousError(p: string): string {
  return (
    `Error: the edit anchor now matches multiple places in ${p} — ` +
    `cannot place it safely. Re-read and re-stage with more surrounding ` +
    `context.`
  );
}

async function runBackupCapturingRevisionId(
  input: RecordRevisionInput,
): Promise<string | undefined> {
  try {
    const result = await recordRevision(input);
    if (result.ok) {
      return result.revisionId;
    }
    warn(
      `[apply-patch] backup skipped for ${input.absolutePath}: ${result.reason}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(
      `[apply-patch] backup recordRevision failed for ${input.absolutePath} ` +
        `(FS side unchanged by this failure): ${msg}`,
    );
  }
  return undefined;
}

function buildBackupInput(
  patch: StagedPatch,
  ctx: DispatchContext,
  preBytes: Buffer,
  postBytes: Buffer,
  operation: FileRevisionOperation,
  absolutePathOverride?: string,
): RecordRevisionInput | null {
  if (!ctx.agentId) {
    warn(
      `[apply-patch] backup skipped for ${patch.path}: ctx.agentId missing ` +
        `(tool-factory plumbing bug; see phase-2a §12.2.0). FS side proceeds; undo unavailable.`,
    );
    return null;
  }
  if (!ctx.turnId) {
    warn(
      `[apply-patch] backup skipped for ${patch.path}: ctx.turnId missing. ` +
        `FS side proceeds; undo unavailable.`,
    );
    return null;
  }
  const input: RecordRevisionInput = {
    preBytes,
    postBytes,
    absolutePath: absolutePathOverride ?? patch.path,
    operation,
    ownerId: ctx.ownerId,
    agentId: ctx.agentId,
    turnId: ctx.turnId,
  };
  if (ctx.roomId !== undefined) input.roomId = ctx.roomId;
  const workspaceMetadata = workspaceRevisionMetadataForPatch(patch);
  if (workspaceMetadata) {
    input.workspaceMetadata = workspaceMetadata;
    input.workspacePath = workspaceMetadata.workspacePathAfter ?? workspaceMetadata.workspacePathBefore ?? undefined;
  }
  const restoreFromRevisionId = readRestoreFromRevisionId(patch);
  if (restoreFromRevisionId) {
    input.restoreFromRevisionId = restoreFromRevisionId;
  }
  return input;
}

/** D448: only patches already stamped by the Workspace artifact authority
 * carry logical-history metadata. This does not inspect or authorize paths. */
function workspaceRevisionMetadataForPatch(
  patch: StagedPatch,
): WorkspaceFileRevisionMetadata | undefined {
  const meta = readWorkspaceArtifactMeta(patch.metadata);
  if (!meta?.rowId) return undefined;
  let workspacePathBefore: string | null;
  let workspacePathAfter: string | null;
  switch (meta.mode) {
    case "create":
      workspacePathBefore = null;
      workspacePathAfter = meta.logicalPath;
      break;
    case "update":
      workspacePathBefore = meta.logicalPath;
      workspacePathAfter = meta.logicalPath;
      break;
  }
  return {
    workspaceArtifactId: meta.rowId,
    workspacePathBefore,
    workspacePathAfter,
    // Group id is persisted in a UUID column; patch ids are turn-scoped
    // strings and intentionally remain separate correlation identifiers.
    workspaceOperationId: randomUUID(),
  };
}

function readRestoreFromRevisionId(patch: StagedPatch): string | undefined {
  const meta = patch.metadata as unknown as { restoreFromRevisionId?: unknown };
  const value = meta.restoreFromRevisionId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
