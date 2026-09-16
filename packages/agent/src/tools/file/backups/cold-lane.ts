import {
  agentDb as db,
  fileRevisions,
  type FileRevisionAuthor,
  type FileRevisionKind,
  type FileRevisionOperation,
  type NewFileRevision,
  type WorkspaceFileRevisionMetadata,
  withWorkspaceFileRevisionMetadata,
} from "@nautilo/db";
import { getBackupStorage, blobRelPathFor } from "./storage-registry";

/**
 * D087 Phase 2A §5 — cold lane.
 *
 * Store pre-bytes verbatim as a content-addressed blob via the
 * `data`-zone `StorageProvider`, then record one row in
 * `file_revisions` that references the blob by key. Used for:
 *
 *   - binary writes (diff of binary is nonsense);
 *   - files > 5 MB (Myers is O(M+N) on the uncommon part, so the
 *     linear term dominates even when the edit is tiny);
 *   - diffs > 1 MB OR larger than the pre-bytes themselves (i.e. the
 *     hot lane would inflate rather than compress);
 *   - `file.delete` tombstones (no post-bytes to apply a diff against
 *     at restore time — we just re-materialize the blob at the old
 *     path).
 *
 * Blob dedup is automatic via the content-addressed key: two revisions
 * with the same pre-state sha256 share one blob on disk. The hourly
 * GC sweep unlinks a blob only when zero `file_revisions` rows still
 * reference it.
 */

export interface ColdLaneInput {
  preBytes: Buffer;
  preSha256: string;
  ownerId: string;
  agentId: string;
  roomId: string | undefined;
  turnId: string;
  absolutePath: string;
  workspacePath: string | undefined;
  operation: FileRevisionOperation;
  /**
   * Discriminator carried over from the router: `"blob"` for normal
   * content-bytes-are-large / binary cases, `"tombstone"` for
   * `file.delete` where the target file no longer exists post-accept.
   * Restore semantics differ: blob revisions write the pre-bytes over
   * the current file; tombstone revisions recreate the file at the
   * original path from the pre-bytes blob.
   */
  kind: Extract<FileRevisionKind, "blob" | "tombstone">;
  /**
   * D087 Phase 3 — see the matching field on `HotLaneInput`. Populated
   * on the new row when this revision is the acceptance of an `undo`
   * staged patch; `undefined` otherwise.
   */
  restoreFromRevisionId: string | undefined;
  authoredBy: FileRevisionAuthor;
  userId: string | undefined;
  workspaceMetadata: WorkspaceFileRevisionMetadata | undefined;
}

export interface ColdLaneResult {
  revisionId: string;
  kind: "blob" | "tombstone";
  blobRef: string;
  blobSize: number;
  blobWasNew: boolean;
}

/**
 * Write the pre-bytes to the backup blob store (idempotent via content
 * hash) and insert the `file_revisions` row that references it.
 *
 * Dedup: if a blob already exists at the content-addressed key, we
 * skip the write — two revisions with the same sha256 share one
 * on-disk blob. The row count is the ref count; GC walks rows grouped
 * by `blob_ref` and unlinks anything unreferenced.
 *
 * Contract: the caller (`runColdLane` in `record-revision.ts`) has
 * already verified that `getBackupStorage()` is installed. We assert
 * it again here and throw loudly if not, rather than double-checking
 * and turning the contract-violation into a quiet return — the
 * router catches + converts to a typed result for the caller.
 */
export async function insertColdLaneRevision(
  input: ColdLaneInput,
): Promise<ColdLaneResult> {
  const storage = getBackupStorage();
  if (!storage) {
    throw new Error(
      "[backups/cold-lane] invariant: storage must be installed before " +
        "insertColdLaneRevision is called. The router in record-revision.ts " +
        "short-circuits with a typed no-storage result for the public API; " +
        "reaching here means a caller bypassed the router.",
    );
  }

  const blobRef = blobRelPathFor(input.preSha256);

  // Dedup: only write the blob if no prior revision landed the same
  // content. Check-then-write races are benign — a duplicate write
  // against the same content-addressed key is idempotent (the second
  // write overwrites with the identical bytes). We skip the write
  // anyway to save the round-trip on the common repeat case.
  //
  // Buffer IS a Uint8Array subclass, so we pass `input.preBytes`
  // directly to storage.write — no copy, no extra allocation.
  const alreadyExists = await storage.exists(blobRef);
  if (!alreadyExists) {
    await storage.write(blobRef, input.preBytes);
  }

  const baseRow: NewFileRevision = {
    ownerId: input.ownerId,
    agentId: input.agentId,
    ...(input.roomId ? { roomId: input.roomId } : {}),
    turnId: input.turnId,
    absolutePath: input.absolutePath,
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    preSha256: input.preSha256,
    preSize: input.preBytes.byteLength,
    kind: input.kind,
    blobRef,
    blobSize: input.preBytes.byteLength,
    operation: input.operation,
    authoredBy: input.authoredBy,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.restoreFromRevisionId
      ? { restoreFromRevisionId: input.restoreFromRevisionId }
      : {}),
  };
  const row = input.workspaceMetadata
    ? withWorkspaceFileRevisionMetadata(baseRow, input.workspaceMetadata)
    : baseRow;

  const [inserted] = await db
    .insert(fileRevisions)
    .values(row)
    .returning({ id: fileRevisions.id });

  if (!inserted) {
    throw new Error(
      `[backups/cold-lane] INSERT returned no row for ${input.absolutePath}`,
    );
  }

  return {
    revisionId: inserted.id,
    kind: input.kind,
    blobRef,
    blobSize: input.preBytes.byteLength,
    blobWasNew: !alreadyExists,
  };
}
