import { log, warn } from "@nautilo/logger";
import {
  FILE_REVISION_AUTHOR,
  type FileRevisionAuthor,
  type FileRevisionOperation,
  type WorkspaceFileRevisionMetadata,
} from "@nautilo/db";
import { sha256Hex } from "../staged-patches";
import { looksLikeBinary } from "../commands/_shared";
import {
  buildReverseDiff,
  insertHotLaneRevision,
  type HotLaneInput,
  type HotLaneResult,
} from "./hot-lane";
import {
  insertColdLaneRevision,
  type ColdLaneInput,
  type ColdLaneResult,
} from "./cold-lane";
import { getBackupStorage } from "./storage-registry";
import { sweepPerFileCap, DEFAULT_GC_CONFIG } from "./gc";
import { emitRevisionStateSnapshot } from "./events-sink";

/**
 * D087 Phase 2A §3 — backup subsystem entrypoint.
 *
 * Called from `file.apply_patch`'s success path (see
 * `commands/apply-patch.ts`, §12.2.3) after a destructive write has
 * landed on disk. Records a revision row in `file_revisions` that
 * the user can `/undo` later.
 *
 * One public function. One router inside. Two storage lanes under the
 * hood (hot = Postgres reverse-diff row, cold = content-addressed
 * blob via `StorageProvider`). All routing decisions stay inside this
 * module; the apply-patch handler doesn't care which lane fired.
 *
 * Failure semantics (see phase-2a spec §9):
 *
 *   - If the backup registry is not wired (test fixture, partial
 *     boot), `recordRevision` returns `{ skipped: "no-storage" }`
 *     without touching the DB. The FS write still landed; the
 *     revision row is just missing, which the caller surfaces as a
 *     warning in the turn log.
 *   - If the DB insert fails (connection drop, unique-violation, etc.)
 *     the error propagates. The apply-patch wrapper runs this in
 *     parallel with `writeAtomic` via `Promise.allSettled`, so the FS
 *     write still lands; this rejection becomes a warning + retry-
 *     queue enqueue (retry queue deferred to a follow-up commit —
 *     first cut just logs).
 *   - If `agentId` is missing from the ctx, we throw loudly. Phase 1's
 *     `staged-patches.ts` uses the same "throw on missing context"
 *     convention for `turnId`; a missing agent id means the context
 *     plumbing is broken and silently degrading would hide that.
 *
 * Retention (post-turn count cap + hourly size sweep) is **not** run
 * from this function — see `gc.ts`.
 */

/** Routing thresholds. Source of truth for the ones also referenced
 *  in phase-2a spec §3. */
export const BACKUP_ROUTING = {
  /**
   * Pre-bytes above this size skip Myers entirely and go cold-lane.
   * Rationale: O(M+N) linear term of Myers dominates even for tiny
   * edits once files get large; the hot lane stops saving space.
   */
  COLD_LANE_PRE_SIZE_THRESHOLD: 5 * 1024 * 1024,
  /**
   * If the computed reverse-diff is larger than this, spill to the
   * cold lane instead — storing pre-bytes directly is cheaper.
   */
  COLD_LANE_DIFF_INFLATION_THRESHOLD: 1 * 1024 * 1024,
} as const;

export interface RecordRevisionInput {
  preBytes: Buffer;
  postBytes: Buffer;
  absolutePath: string;
  workspacePath?: string | undefined;
  operation: FileRevisionOperation;
  ownerId: string;
  agentId: string;
  roomId?: string | undefined;
  turnId: string;
  /**
   * D087 Phase 3 — set by apply-patch when the staged patch being
   * applied was produced by `file.undo`. The new revision row records
   * it so `file.redo` can walk back to the undone state later. When
   * undefined (the vast majority of cases), the row stores NULL and
   * is never considered as a redo candidate.
   */
  restoreFromRevisionId?: string | undefined;
  /**
   * M180 — revision provenance. Defaults to agent-authored when
   * omitted (existing agent file-tool call sites). Human workbench
   * checkpoints pass `user` plus `userId`.
   */
  authoredBy?: FileRevisionAuthor | undefined;
  userId?: string | undefined;
  /** D448 Workspace history grouping; not a filesystem authorization input. */
  workspaceMetadata?: WorkspaceFileRevisionMetadata | undefined;
}

export type RecordRevisionResult =
  | { ok: true; lane: "hot"; revisionId: string; diffBytes: number }
  | {
      ok: true;
      lane: "cold";
      revisionId: string;
      kind: "blob" | "tombstone";
      blobRef: string;
      blobSize: number;
      blobWasNew: boolean;
    }
  | { ok: false; skipped: "no-storage" | "recursive-dir-delete"; reason: string };

/**
 * The backup-subsystem public API. Signature is designed so the
 * apply-patch wrapper can pass exactly what it already has on the
 * success path (current bytes read pre-write, new bytes from the
 * patch, dispatch ctx fields) without extra ceremony.
 */
export async function recordRevision(
  input: RecordRevisionInput,
): Promise<RecordRevisionResult> {
  if (!input.agentId) {
    throw new Error(
      "[backups] recordRevision: agentId is required — plumbing bug " +
        "in DispatchContext. Phase 2A §12.2.0 threads this through " +
        "FileToolContext; if it's missing, the tool-factory call " +
        "site isn't populating it from NautiloState.",
    );
  }
  if (!input.ownerId) {
    throw new Error("[backups] recordRevision: ownerId is required");
  }
  if (!input.turnId) {
    throw new Error("[backups] recordRevision: turnId is required");
  }

  const authoredBy = input.authoredBy ?? FILE_REVISION_AUTHOR.AGENT;
  const userId = input.userId;
  const provenance = { authoredBy, userId };

  // Pre-bytes sha256 is needed by both lanes (hot: invariant check at
  // restore time; cold: blob dedup key). Compute once.
  const preSha256 = sha256Hex(input.preBytes);

  // Tombstone path — file.delete on a single file. The target is
  // gone post-accept, so there's no "post-bytes" for a diff to work
  // against at restore time. We always go cold-lane for these and
  // re-materialize from the blob.
  const isDelete = input.operation === "delete";
  if (isDelete) {
    // Empty-preBytes deletes can happen two ways:
    //   1. A legitimately-empty file being deleted (single-file).
    //   2. A recursive directory delete (Phase 1 stages directory
    //      deletes with empty preBytes — the tree content isn't
    //      captured at the stage layer).
    // Recursive directory deletes have no per-file identity. An empty
    // single-file Workspace delete does, and must retain a tombstone row
    // even though its backup blob is zero bytes.
    if (input.preBytes.byteLength === 0 && !input.workspaceMetadata) {
      const reason =
        "delete with empty pre-bytes (recursive directory delete OR " +
        "delete of an empty file) — no content to back up.";
      warn(`[backups] recordRevision skipped: ${reason}`);
      return { ok: false, skipped: "recursive-dir-delete", reason };
    }
    return runColdLane({
      preBytes: input.preBytes,
      preSha256,
      ownerId: input.ownerId,
      agentId: input.agentId,
      roomId: input.roomId,
      turnId: input.turnId,
      absolutePath: input.absolutePath,
      workspacePath: input.workspacePath,
      operation: input.operation,
      kind: "tombstone",
      restoreFromRevisionId: input.restoreFromRevisionId,
      workspaceMetadata: input.workspaceMetadata,
      ...provenance,
    });
  }

  // Non-delete path — decide lane based on pre-size, binary-ness, and
  // (for the text case) diff inflation.

  const preBytes = input.preBytes;
  const postBytes = input.postBytes;

  const preSizeBig =
    preBytes.byteLength >= BACKUP_ROUTING.COLD_LANE_PRE_SIZE_THRESHOLD;

  const preLooksBinary = looksLikeBinary(preBytes);
  const postLooksBinary = looksLikeBinary(postBytes);

  if (preSizeBig || preLooksBinary || postLooksBinary) {
    return runColdLane({
      preBytes,
      preSha256,
      ownerId: input.ownerId,
      agentId: input.agentId,
      roomId: input.roomId,
      turnId: input.turnId,
      absolutePath: input.absolutePath,
      workspacePath: input.workspacePath,
      operation: input.operation,
      kind: "blob",
      restoreFromRevisionId: input.restoreFromRevisionId,
      workspaceMetadata: input.workspaceMetadata,
      ...provenance,
    });
  }

  // Text + under the size threshold — try the hot lane.
  const diffText = buildReverseDiff(input.absolutePath, preBytes, postBytes);
  const diffByteLength = Buffer.byteLength(diffText, "utf-8");

  const diffWouldInflate =
    diffByteLength > BACKUP_ROUTING.COLD_LANE_DIFF_INFLATION_THRESHOLD ||
    diffByteLength > preBytes.byteLength;

  if (diffWouldInflate) {
    return runColdLane({
      preBytes,
      preSha256,
      ownerId: input.ownerId,
      agentId: input.agentId,
      roomId: input.roomId,
      turnId: input.turnId,
      absolutePath: input.absolutePath,
      workspacePath: input.workspacePath,
      operation: input.operation,
      kind: "blob",
      restoreFromRevisionId: input.restoreFromRevisionId,
      workspaceMetadata: input.workspaceMetadata,
      ...provenance,
    });
  }

  return runHotLane(
    {
      preBytes,
      postBytes,
      preSha256,
      ownerId: input.ownerId,
      agentId: input.agentId,
      roomId: input.roomId,
      turnId: input.turnId,
      absolutePath: input.absolutePath,
      workspacePath: input.workspacePath,
      operation: input.operation,
      restoreFromRevisionId: input.restoreFromRevisionId,
      workspaceMetadata: input.workspaceMetadata,
      ...provenance,
    },
    diffText,
  );
}

/**
 * Post-insert per-file count-cap sweep. Runs after every successful
 * revision insert; cheap (O(log N) via `idx_file_revisions_path_newest`
 * and a bounded DELETE). A failure here doesn't invalidate the
 * revision just written — it only means an old row sticks around
 * for one more turn until the next insert sweeps again.
 */
async function sweepAfterInsert(
  agentId: string,
  absolutePath: string,
): Promise<void> {
  try {
    await sweepPerFileCap(agentId, absolutePath, DEFAULT_GC_CONFIG);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(
      `[backups] per-file sweep failed after insert for ${absolutePath}: ${msg} ` +
        `(revision row unaffected; stale rows will be swept on next insert)`,
    );
  }
}


async function runHotLane(
  input: HotLaneInput,
  diffText: string,
): Promise<RecordRevisionResult> {
  const result: HotLaneResult = await insertHotLaneRevision(input, diffText);
  log(
    `[backups] recorded hot-lane revision ${result.revisionId} ` +
      `for ${input.absolutePath} (op=${input.operation}, ` +
      `diff=${result.diffBytes}B)`,
  );
  await sweepAfterInsert(input.agentId, input.absolutePath);
  // D087 Phase 3 §3.10 — emit state snapshot so the UI's undo/redo
  // bar updates reactively. Fire-and-forget; the helper swallows
  // its own errors.
  void emitRevisionStateSnapshot(input.agentId, input.absolutePath);
  return {
    ok: true,
    lane: "hot",
    revisionId: result.revisionId,
    diffBytes: result.diffBytes,
  };
}

async function runColdLane(
  input: ColdLaneInput,
): Promise<RecordRevisionResult> {
  const storage = getBackupStorage();
  if (!storage) {
    const reason =
      "backup blob storage not installed (setBackupStorage() not " +
      "called at server boot). FS write still landed but no " +
      "revision record. Undo for this change will be unavailable.";
    warn(`[backups] recordRevision skipped: ${reason}`);
    return { ok: false, skipped: "no-storage", reason };
  }
  const result: ColdLaneResult = await insertColdLaneRevision(input);
  log(
    `[backups] recorded cold-lane revision ${result.revisionId} ` +
      `for ${input.absolutePath} (op=${input.operation}, ` +
      `kind=${result.kind}, blob=${result.blobSize}B, ` +
      `dedup=${result.blobWasNew ? "new" : "hit"})`,
  );
  await sweepAfterInsert(input.agentId, input.absolutePath);
  // D087 Phase 3 §3.10 — same emit as the hot-lane branch.
  void emitRevisionStateSnapshot(input.agentId, input.absolutePath);
  return {
    ok: true,
    lane: "cold",
    revisionId: result.revisionId,
    kind: result.kind,
    blobRef: result.blobRef,
    blobSize: result.blobSize,
    blobWasNew: result.blobWasNew,
  };
}
