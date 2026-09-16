import { createPatch } from "diff";
import {
  agentDb as db,
  fileRevisions,
  FILE_REVISION_KIND,
  type FileRevisionAuthor,
  type FileRevisionOperation,
  type NewFileRevision,
  type WorkspaceFileRevisionMetadata,
  withWorkspaceFileRevisionMetadata,
} from "@nautilo/db";

/**
 * D087 Phase 2A §4 — hot lane.
 *
 * Store the pre-bytes → post-bytes transition as a git-style unified
 * reverse-diff (post → pre argument order) in `file_revisions.diff_text`.
 * Used when the bytes are text, the file is ≤ 5 MB, and the resulting
 * diff is ≤ 1 MB (the router in `record-revision.ts` enforces those
 * guards before calling in here).
 *
 * Restore reconstructs the pre-state by applying the stored diff to
 * the current on-disk bytes via `diff.applyPatch` — see `restore.ts`.
 *
 * Typical diff size for agent edits: a few KB (median edit = ~12 KB
 * of changed lines across a ~8 KB file, per the nautilo-repo 14-day
 * agent-touch sample). Postgres TOASTs `text` columns above ~2 KB,
 * so the row itself stays small and the diff payload is stored
 * out-of-line transparently.
 */

export interface HotLaneInput {
  preBytes: Buffer;
  postBytes: Buffer;
  preSha256: string;
  ownerId: string;
  agentId: string;
  roomId: string | undefined;
  turnId: string;
  absolutePath: string;
  workspacePath: string | undefined;
  operation: FileRevisionOperation;
  /**
   * D087 Phase 3 — set when this revision is itself the acceptance
   * of an `undo` staged patch. Points back at the revision being
   * undone; populated on the new row so `file.redo` can walk forward
   * in O(1). `undefined` for the 99% of revisions that aren't produced
   * by an undo.
   */
  restoreFromRevisionId: string | undefined;
  authoredBy: FileRevisionAuthor;
  userId: string | undefined;
  workspaceMetadata: WorkspaceFileRevisionMetadata | undefined;
}

export interface HotLaneResult {
  revisionId: string;
  kind: "diff";
  diffBytes: number;
}

/**
 * Build the reverse-diff in memory. Pure function — does not touch DB
 * or disk. Separated from the insert so the router can compute the
 * diff, decide whether it's worth storing (size / inflation guards),
 * and only hit the DB on the hot-lane branch.
 *
 * Argument order is intentionally **post → pre** (swapped vs Phase
 * 1's stage-time `createPatch(pre, post)`). Myers produces a minimal
 * edit script regardless of direction; flipping the arguments gives a
 * reverse-diff in one library call, no custom inversion needed.
 *
 * Header path on the unified diff is the absolute target path — it's
 * only used for display in the rollback UI; it doesn't affect
 * applyPatch. Context = 3 lines to match the Phase 1 DiffView
 * convention so rendered revisions look identical to staged patches.
 */
export function buildReverseDiff(
  absolutePath: string,
  preBytes: Buffer,
  postBytes: Buffer,
): string {
  const preText = preBytes.toString("utf-8");
  const postText = postBytes.toString("utf-8");
  return createPatch(absolutePath, postText, preText, "", "", { context: 3 });
}

/**
 * Insert a hot-lane revision row. Caller has already built the
 * reverse-diff and decided this is the right lane. Returns the new
 * row id so the caller can surface it for audit / observability.
 */
export async function insertHotLaneRevision(
  input: HotLaneInput,
  diffText: string,
): Promise<HotLaneResult> {
  const baseRow: NewFileRevision = {
    ownerId: input.ownerId,
    agentId: input.agentId,
    ...(input.roomId ? { roomId: input.roomId } : {}),
    turnId: input.turnId,
    absolutePath: input.absolutePath,
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    preSha256: input.preSha256,
    preSize: input.preBytes.byteLength,
    kind: FILE_REVISION_KIND.DIFF,
    diffText,
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
      `[backups/hot-lane] INSERT returned no row for ${input.absolutePath}`,
    );
  }

  return {
    revisionId: inserted.id,
    kind: "diff",
    diffBytes: Buffer.byteLength(diffText, "utf-8"),
  };
}
