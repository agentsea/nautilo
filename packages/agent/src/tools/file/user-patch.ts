/**
 * ISSUE-M193 — workspace artifact anchored text patch apply helper.
 *
 * Applies versioned anchored patches with exact-base and stale-base rebase
 * semantics; materializes bytes via the same path as human snapshot saves.
 */

import { randomUUID } from "node:crypto";
import { createPatch } from "diff";
import * as fsp from "node:fs/promises";
import { FILE_REVISION_AUTHOR, findRecentRevision, type Artifact, type DirectDatabase } from "@nautilo/db";
import { warn } from "@nautilo/logger";
import type {
  AnchoredTextPatch,
  DocumentPatchApplied,
  DocumentPatchAuthor,
  DocumentPatchEvent,
  DocumentPatchRejected,
  PatchDocumentTarget,
} from "@nautilo/types";
import { applyAnchoredTextPatch } from "@nautilo/types";
import {
  assertCanWriteArtifacts,
  type MemoryAccessEnvelope,
} from "@nautilo/trust";
import { withAgentTrustContext } from "../../store/trust-agent-db";
import {
  applyWorkspaceArtifactRowChange,
  emitWorkspaceArtifactDocumentPatchApplied,
  envelopeFactsForArtifacts,
  physicalPathFromStorageUri,
  type WorkspaceArtifactPatchMeta,
} from "./artifact-store";
import { writeAtomic } from "./atomic-write";
import { recordRevision } from "./backups/record-revision";
import { pickMutationNamespaceId } from "./workspace-commands";
import {
  shouldRecordCheckpoint,
  USER_SAVE_TEXT_LIMIT_BYTES,
} from "./user-save";
import { sha256Hex } from "./staged-patches";

export type WorkspaceArtifactPatchApplyResult =
  | { ok: true; applied: DocumentPatchApplied; event: DocumentPatchEvent }
  | { ok: false; rejection: DocumentPatchRejected };

async function readCurrentBytes(physicalPath: string): Promise<Buffer | { error: string }> {
  try {
    return await fsp.readFile(physicalPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT")) {
      return Buffer.alloc(0);
    }
    return { error: msg };
  }
}

function patchPayloadTooLarge(patch: AnchoredTextPatch): boolean {
  const oldBytes = Buffer.byteLength(patch.oldString, "utf8");
  const newBytes = Buffer.byteLength(patch.newString, "utf8");
  return oldBytes > USER_SAVE_TEXT_LIMIT_BYTES || newBytes > USER_SAVE_TEXT_LIMIT_BYTES;
}

function buildUnifiedDiff(path: string, before: string, after: string): string {
  return createPatch(path, before, after, "before", "after", { context: 3 });
}

function baseMatchesCurrent(input: {
  baseRevision: number | null;
  baseSha256: string;
  rowRevision: number | null;
  currentSha256: string;
}): boolean {
  if (input.baseSha256 !== input.currentSha256) return false;
  if (
    input.baseRevision !== null &&
    input.rowRevision !== null &&
    input.baseRevision !== input.rowRevision
  ) {
    return false;
  }
  return true;
}

function artifactTarget(
  row: Artifact,
  envelope: MemoryAccessEnvelope,
  mimeType?: string,
): PatchDocumentTarget {
  return {
    kind: "artifact",
    artifactInternalId: row.id,
    path: row.path,
    ...(envelope.roomId ? { roomId: envelope.roomId } : {}),
    ...(mimeType ? { mimeType } : row.mimeType ? { mimeType: row.mimeType } : {}),
  };
}

export async function applyWorkspaceArtifactTextPatch(input: {
  envelope: MemoryAccessEnvelope;
  artifact: Artifact;
  requestId: string;
  baseRevision: number | null;
  baseSha256: string;
  patch: AnchoredTextPatch;
  checkpoint: boolean;
  mimeType?: string | undefined;
  clientMutationId?: string | undefined;
  author?: DocumentPatchAuthor | undefined;
  now?: Date | undefined;
}): Promise<WorkspaceArtifactPatchApplyResult> {
  const now = input.now ?? new Date();

  const factsResult = envelopeFactsForArtifacts(input.envelope);
  if (!factsResult.ok) {
    return {
      ok: false,
      rejection: { kind: "forbidden", reason: factsResult.reason },
    };
  }
  const facts = factsResult.facts;
  if (!facts.agentId) {
    return {
      ok: false,
      rejection: {
        kind: "forbidden",
        reason: "workspace artifact access requires an authenticated agent context.",
      },
    };
  }
  if (facts.mutableNamespaces.length === 0) {
    return {
      ok: false,
      rejection: {
        kind: "forbidden",
        reason: "no mutable namespace for workspace artifact writes.",
      },
    };
  }

  if (input.patch.kind !== "anchored_text") {
    return {
      ok: false,
      rejection: { kind: "unsupported", reason: "only anchored_text patches are supported" },
    };
  }

  if (patchPayloadTooLarge(input.patch)) {
    return {
      ok: false,
      rejection: {
        kind: "too_large",
        reason: `patch payload exceeds ${USER_SAVE_TEXT_LIMIT_BYTES} byte limit`,
      },
    };
  }

  const row = input.artifact;
  const physicalPath = physicalPathFromStorageUri(row.storageUri);
  if (!physicalPath) {
    return {
      ok: false,
      rejection: {
        kind: "unsupported",
        reason: `Artifact ${row.artifactId} has unrecognized storage_uri scheme`,
      },
    };
  }

  const preBytesResult = await readCurrentBytes(physicalPath);
  if (!Buffer.isBuffer(preBytesResult)) {
    return {
      ok: false,
      rejection: {
        kind: "unsupported",
        reason: `could not read artifact bytes: ${preBytesResult.error}`,
      },
    };
  }
  const preBytes = preBytesResult;
  const currentText = preBytes.toString("utf8");
  const currentSha256 = sha256Hex(preBytes);
  const previousRevision = row.revision;
  const previousSha256 = currentSha256;

  const exactBase = baseMatchesCurrent({
    baseRevision: input.baseRevision,
    baseSha256: input.baseSha256,
    rowRevision: row.revision,
    currentSha256,
  });

  const applyResult = applyAnchoredTextPatch(currentText, input.patch);
  if (!applyResult.ok) {
    const baseShaStale = input.baseSha256 !== currentSha256;
    const kind =
      applyResult.reason === "anchor_ambiguous"
        ? "anchor_ambiguous"
        : applyResult.reason === "anchor_not_found" && baseShaStale
          ? "stale_base_unrebaseable"
          : "anchor_not_found";
    return {
      ok: false,
      rejection: {
        kind,
        latestRevision: row.revision,
        latestSha256: currentSha256,
      },
    };
  }

  const newText = applyResult.text;
  const newBytes = Buffer.from(newText, "utf8");
  if (newBytes.byteLength > USER_SAVE_TEXT_LIMIT_BYTES) {
    return {
      ok: false,
      rejection: {
        kind: "too_large",
        reason: `resulting content exceeds ${USER_SAVE_TEXT_LIMIT_BYTES} byte limit`,
      },
    };
  }

  const rebased = !exactBase;

  if (!exactBase) {
    // Stale base succeeded via anchored rebase — allowed. If base was stale but
    // patch somehow equals current (no-op), still materialize only when apply succeeded.
  }

  const namespaceId = await pickMutationNamespaceId(row.id, facts);
  if (!namespaceId) {
    return {
      ok: false,
      rejection: {
        kind: "unsupported",
        reason: `artifact ${row.artifactId} has no namespace attachment (orphaned junction).`,
      },
    };
  }
  await assertCanWriteArtifacts({
    humanUserId: facts.userId,
    namespaceId,
    artifactId: row.id,
  });

  let lastCreatedAt: Date | null = null;
  if (input.checkpoint) {
    const recent = await withAgentTrustContext(
      { userId: facts.userId, agentId: facts.agentId },
      async (tx) => {
        const conn = tx as unknown as DirectDatabase;
        return findRecentRevision(conn, {
          agentId: facts.agentId,
          absolutePath: physicalPath,
          authoredBy: FILE_REVISION_AUTHOR.USER,
          userId: facts.userId,
        });
      },
    );
    lastCreatedAt = recent?.createdAt ?? null;
  }

  try {
    await writeAtomic(physicalPath, newBytes);
  } catch (err) {
    return {
      ok: false,
      rejection: {
        kind: "unsupported",
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const mimeType =
    input.mimeType !== undefined && input.mimeType.length > 0 ? input.mimeType : undefined;

  const meta: WorkspaceArtifactPatchMeta = {
    mode: "update",
    artifactId: row.artifactId,
    logicalPath: row.path,
    namespaceId,
    storageUri: row.storageUri,
    ...(mimeType ? { mimeType } : {}),
    ...(input.clientMutationId ? { clientMutationId: input.clientMutationId } : {}),
    rowId: row.id,
  };

  try {
    await applyWorkspaceArtifactRowChange(
      meta,
      newBytes.byteLength,
      facts.userId,
      facts.agentId,
      { kind: "human", userId: facts.userId },
    );
  } catch (err) {
    return {
      ok: false,
      rejection: {
        kind: "unsupported",
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }

  if (shouldRecordCheckpoint(input.checkpoint, lastCreatedAt, now)) {
    try {
      const revision = await recordRevision({
        preBytes,
        postBytes: newBytes,
        absolutePath: physicalPath,
        operation: "write",
        ownerId: facts.userId,
        agentId: facts.agentId,
        roomId: input.envelope.roomId,
        turnId: `user-patch:${randomUUID()}`,
        authoredBy: FILE_REVISION_AUTHOR.USER,
        userId: facts.userId,
      });
      if (!revision.ok) {
        warn(`[user-patch] checkpoint skipped for ${row.path}: ${revision.reason}`);
      }
    } catch (err) {
      warn(
        `[user-patch] checkpoint failed for ${row.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const newSha256 = sha256Hex(newBytes);
  const newRevision = row.revision === null ? null : row.revision + 1;
  const patchId = randomUUID();
  const author: DocumentPatchAuthor = input.author ?? {
    kind: "human",
    displayName: facts.userId,
  };
  const target = artifactTarget(row, input.envelope, mimeType);
  const unifiedDiff = buildUnifiedDiff(row.path, currentText, newText);

  emitWorkspaceArtifactDocumentPatchApplied({
    rowInternalId: row.id,
    logicalPath: row.path,
    ...(mimeType ? { mimeType } : {}),
    ...(input.envelope.roomId ? { roomId: input.envelope.roomId } : {}),
    previousRevision,
    previousSha256,
    newRevision,
    newSha256,
    patchId,
    anchoredPatch: input.patch,
    unifiedDiff,
    author,
    rebased,
    requestId: input.requestId,
    ...(input.clientMutationId ? { clientMutationId: input.clientMutationId } : {}),
  });

  const applied: DocumentPatchApplied = {
    kind: "applied",
    target,
    patchId,
    requestId: input.requestId,
    revision: newRevision,
    sha256: newSha256,
    content: newText,
    author,
    patch: input.patch,
    unifiedDiff,
    rebased,
  };

  return { ok: true, applied, event: {
    type: "document.patch.applied",
    target,
    patchId,
    requestId: input.requestId,
    revision: newRevision,
    sha256: newSha256,
    previousRevision,
    previousSha256,
    patch: input.patch,
    author,
    ...(input.clientMutationId ? { clientMutationId: input.clientMutationId } : {}),
    rebased,
  } };
}
