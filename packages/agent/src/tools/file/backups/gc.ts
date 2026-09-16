import { log, warn } from "@nautilo/logger";
import { StorageNotFoundError } from "@nautilo/config";
import {
  agentDb as db,
  fileRevisions,
  FILE_REVISION_KIND,
  eq,
  and,
  asc,
  desc,
  inArray,
  isNotNull,
  sql,
} from "@nautilo/db";
import { getBackupStorage, isHex2, isSha256Hex } from "./storage-registry";
import { emitRevisionStateSnapshot } from "./events-sink";

/**
 * D087 Phase 2A §7 — retention / garbage collection.
 *
 * Three knobs, composed:
 *
 *   1. Per-file count cap (default 50): after the 51st insert for a
 *      given `(agentId, absolutePath)`, roll off the oldest unpinned
 *      revision. Runs **inline post-turn** from the langgraph-executor
 *      turn-complete hook; O(log N) via `idx_file_revisions_path_newest`.
 *
 *   2. Per-deployment size cap (default 500 MB): hourly sweep sums
 *      `diff_text` bytes + `blob_size` bytes across the whole table;
 *      if the budget is exceeded, evict oldest unpinned rows until
 *      under budget.
 *
 *   3. Pin (`pinned=true`): exempts a revision from both caps. User
 *      sets this via the rollback UI ("protect this restore point").
 *
 * Blob-ref sweep runs as part of (2) — after evicting rows, we walk
 * `blob_ref` groups and unlink any blob whose ref-count is now 0.
 *
 * All three are idempotent and safe to re-run. The hourly job
 * specifically is launched from the server's background scheduler
 * (or called manually in tests); it owns no lock, takes no
 * transaction longer than a single DELETE, and always leaves the
 * store in a consistent state whether or not it completes.
 */

export interface GcConfig {
  /** Per-file count cap (default 50). */
  perFileCap: number;
  /** Per-deployment hard size ceiling in bytes (default 500 MB). */
  totalSizeCapBytes: number;
}

export const DEFAULT_GC_CONFIG: GcConfig = {
  perFileCap: 50,
  totalSizeCapBytes: 500 * 1024 * 1024,
};

export interface PerFileSweepResult {
  agentId: string;
  absolutePath: string;
  evicted: number;
  evictedRevisionIds: string[];
}

/**
 * Per-file count cap sweep. Post-turn inline path. Given an agent +
 * path that just received a new revision, delete every unpinned row
 * older than the cap keeps, oldest-first.
 *
 * Called from the langgraph-executor's turn-complete hook with the
 * set of (agent, path) tuples touched this turn. Cheap: the path+agent
 * index narrows the scan; the pinned flag is the last filter.
 */
export async function sweepPerFileCap(
  agentId: string,
  absolutePath: string,
  config: GcConfig = DEFAULT_GC_CONFIG,
): Promise<PerFileSweepResult> {
  const rows = await db
    .select({ id: fileRevisions.id })
    .from(fileRevisions)
    .where(
      and(
        eq(fileRevisions.agentId, agentId),
        eq(fileRevisions.absolutePath, absolutePath),
        eq(fileRevisions.pinned, false),
      ),
    )
    .orderBy(desc(fileRevisions.createdAt));

  if (rows.length <= config.perFileCap) {
    return { agentId, absolutePath, evicted: 0, evictedRevisionIds: [] };
  }

  const toEvict = rows.slice(config.perFileCap).map((r) => r.id);
  if (toEvict.length === 0) {
    return { agentId, absolutePath, evicted: 0, evictedRevisionIds: [] };
  }

  await db.delete(fileRevisions).where(inArray(fileRevisions.id, toEvict));

  log(
    `[backups/gc] per-file sweep: evicted ${toEvict.length} revision(s) ` +
      `for ${absolutePath} (agent=${agentId}, cap=${config.perFileCap})`,
  );
  // D087 Phase 3 §3.10 — emit state snapshot so the UI transitions
  // from "undo available" to "undo disabled" if the count just hit
  // zero, or updates the latest-revision summary if older rows
  // were dropped. Fire-and-forget; best-effort observability.
  void emitRevisionStateSnapshot(agentId, absolutePath);
  return {
    agentId,
    absolutePath,
    evicted: toEvict.length,
    evictedRevisionIds: toEvict,
  };
}

export interface HourlySweepResult {
  totalBytesBefore: number;
  totalBytesAfter: number;
  rowsEvictedForSize: number;
  blobsUnlinked: number;
  blobsMissed: number;
}

/**
 * Hourly full sweep — size-cap LRU eviction + blob-ref GC.
 *
 * Steps:
 *   (1) Measure current total backup footprint: sum of `diff_text`
 *       octet-length (for hot-lane rows) + `blob_size` (for cold-
 *       lane / tombstone rows), in bytes. Done server-side via a
 *       single aggregate query.
 *   (2) If total > `totalSizeCapBytes`, delete oldest-accessed,
 *       oldest-created unpinned rows until under budget. Uses
 *       `COALESCE(accessed_at, created_at)` as the effective LRU
 *       key — never-restored revisions evict before recently-
 *       restored ones.
 *   (3) Blob-ref sweep: find `blob_ref` values that exist in the
 *       storage backend but are no longer referenced by any row;
 *       unlink them from the storage backend.
 *
 * Returns a summary so the scheduler can log what happened and alert
 * on runaway failure modes (e.g. blobsUnlinked=0 for many hours in a
 * row despite rowsEvictedForSize>0 would indicate a leaking blob
 * store).
 */
export async function sweepHourly(
  config: GcConfig = DEFAULT_GC_CONFIG,
): Promise<HourlySweepResult> {
  const totalBytesBefore = await measureTotalBackupBytes();
  let rowsEvictedForSize = 0;
  let totalBytesAfter = totalBytesBefore;

  if (totalBytesBefore > config.totalSizeCapBytes) {
    rowsEvictedForSize = await evictForSize(config, totalBytesBefore);
    totalBytesAfter = await measureTotalBackupBytes();
  }

  const { unlinked, missed } = await sweepOrphanedBlobs();

  log(
    `[backups/gc] hourly sweep: bytesBefore=${totalBytesBefore} ` +
      `bytesAfter=${totalBytesAfter} rowsEvicted=${rowsEvictedForSize} ` +
      `blobsUnlinked=${unlinked} blobsMissed=${missed}`,
  );

  return {
    totalBytesBefore,
    totalBytesAfter,
    rowsEvictedForSize,
    blobsUnlinked: unlinked,
    blobsMissed: missed,
  };
}

/**
 * Sum of `coalesce(octet_length(diff_text), 0) + coalesce(blob_size, 0)`
 * across the whole table. The hot-lane row stores `diff_text` inline
 * (TOAST'd when large); `octet_length` gives the logical byte count
 * regardless of TOAST storage. Cold-lane rows have `diff_text = NULL`
 * and `blob_size` populated.
 */
async function measureTotalBackupBytes(): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`COALESCE(SUM(COALESCE(OCTET_LENGTH(${fileRevisions.diffText}), 0) + COALESCE(${fileRevisions.blobSize}, 0)), 0)::bigint`,
    })
    .from(fileRevisions);
  // Postgres `bigint` via the postgres.js driver comes back as string
  // for values above MAX_SAFE_INTEGER; coerce defensively.
  return Number(row?.total ?? 0);
}

/**
 * Delete oldest-accessed + oldest-created unpinned rows until either
 * the running total drops below the cap or we run out of unpinned
 * rows. Returns number of rows deleted.
 *
 * Batch size (BATCH_ROWS) keeps any single DELETE cheap and avoids
 * lock-escalation on a large table.
 */
async function evictForSize(
  config: GcConfig,
  initialTotal: number,
): Promise<number> {
  const BATCH_ROWS = 100;
  let evictedTotal = 0;
  let running = initialTotal;

  while (running > config.totalSizeCapBytes) {
    // Pick the next batch of eviction candidates: unpinned, ordered
    // by effective-LRU (COALESCE(accessed_at, created_at)) ASC so
    // never-accessed-since-create rows evict first, and oldest
    // within each category.
    const candidates = await db
      .select({
        id: fileRevisions.id,
        diffSize: sql<number>`COALESCE(OCTET_LENGTH(${fileRevisions.diffText}), 0)::bigint`,
        blobSize: fileRevisions.blobSize,
      })
      .from(fileRevisions)
      .where(eq(fileRevisions.pinned, false))
      .orderBy(
        asc(sql`COALESCE(${fileRevisions.accessedAt}, ${fileRevisions.createdAt})`),
        asc(fileRevisions.createdAt),
      )
      .limit(BATCH_ROWS);

    if (candidates.length === 0) {
      warn(
        `[backups/gc] size cap exceeded but no unpinned rows remain ` +
          `to evict (all remaining rows are pinned). total=${running} ` +
          `cap=${config.totalSizeCapBytes}`,
      );
      break;
    }

    const ids = candidates.map((c) => c.id);
    const batchBytes = candidates.reduce(
      (acc, c) => acc + Number(c.diffSize ?? 0) + Number(c.blobSize ?? 0),
      0,
    );

    await db.delete(fileRevisions).where(inArray(fileRevisions.id, ids));

    evictedTotal += candidates.length;
    running -= batchBytes;
  }

  return evictedTotal;
}

interface BlobSweepResult {
  unlinked: number;
  missed: number;
}

/**
 * Walk the set of distinct `blob_ref` values still referenced by at
 * least one row, then unlink any blob that exists in the storage
 * backend but isn't in that set.
 *
 * Because the storage provider is namespace-scoped, we only list
 * under `backups/blobs/` — the prefix written by `cold-lane.ts` via
 * `blobRelPathFor()`. Any blob outside that prefix is someone else's
 * business.
 */
async function sweepOrphanedBlobs(): Promise<BlobSweepResult> {
  const storage = getBackupStorage();
  if (!storage) {
    warn(
      "[backups/gc] blob sweep skipped — storage not installed " +
        "(setBackupStorage() not called). Orphaned blobs will " +
        "accumulate until the sweep can run.",
    );
    return { unlinked: 0, missed: 0 };
  }

  // Referenced set — any blob_ref that still has at least one row.
  // Scoped to non-diff kinds since hot-lane rows never set blob_ref.
  const refRows = await db
    .selectDistinct({ blobRef: fileRevisions.blobRef })
    .from(fileRevisions)
    .where(
      and(
        inArray(fileRevisions.kind, [
          FILE_REVISION_KIND.BLOB,
          FILE_REVISION_KIND.TOMBSTONE,
        ]),
        // Guard against any row with kind=blob but blobRef=null — the
        // CHECK we decided to skip at the DB layer (see schema
        // comment) means we filter defensively here instead.
        isNotNull(fileRevisions.blobRef),
      ),
    );
  const referenced = new Set<string>();
  for (const r of refRows) {
    if (r.blobRef) referenced.add(r.blobRef);
  }

  // Enumerate what's actually on disk under the backups prefix. The
  // StorageProvider `list` API takes a relative directory and returns
  // relative entries; we walk the 256-way fan-out manually since
  // list() is one-level only.
  //
  // Non-hex debris (`.DS_Store`, stray tmp files, manual inserts) is
  // skipped via the `isHex2` / `isSha256Hex` guards — we only touch
  // entries that match the write-side naming rule. Anything else is
  // not our business to clean up.
  let unlinked = 0;
  let missed = 0;
  let fanBuckets: string[] = [];
  try {
    fanBuckets = await storage.list("backups/blobs/sha256");
  } catch (err) {
    if (err instanceof StorageNotFoundError) {
      // No blobs have ever been written; normal bootstrap state.
      return { unlinked: 0, missed: 0 };
    }
    const msg = err instanceof Error ? err.message : String(err);
    warn(`[backups/gc] list(backups/blobs/sha256) failed: ${msg}`);
    return { unlinked: 0, missed: 0 };
  }

  for (const bucket of fanBuckets) {
    if (!isHex2(bucket)) continue;
    let bucketEntries: string[];
    try {
      bucketEntries = await storage.list(`backups/blobs/sha256/${bucket}`);
    } catch {
      continue;
    }
    for (const entry of bucketEntries) {
      if (!isSha256Hex(entry)) continue;
      const ref = `backups/blobs/sha256/${bucket}/${entry}`;
      if (referenced.has(ref)) continue;
      try {
        await storage.delete(ref);
        unlinked++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warn(`[backups/gc] unlink failed for ${ref}: ${msg}`);
        missed++;
      }
    }
  }

  return { unlinked, missed };
}

// ---------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------

/**
 * Default interval between hourly GC runs. Overridable via the
 * `intervalMs` option to `startBackupGcScheduler` — useful in tests
 * that want a faster cadence without shipping a slow test.
 */
export const DEFAULT_GC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let _gcTimer: ReturnType<typeof setInterval> | null = null;

export interface StartBackupGcOptions {
  /** Override the interval (default 1 h). */
  intervalMs?: number;
  /** Override the cap config (default `DEFAULT_GC_CONFIG`). */
  config?: GcConfig;
  /**
   * If true, fire a GC run immediately on `start()` in addition to
   * the periodic interval. Default false so server boot stays fast
   * and deterministic — production deployments should let the first
   * GC run land organically after `intervalMs`.
   */
  runOnStart?: boolean;
}

/**
 * Start the periodic hourly GC sweep. Called once at server boot
 * right after `setBackupStorage(storageZones)` — matches the pattern
 * of other background schedulers in `server/src/app.ts` (e.g. relay
 * registry lifecycle hooks).
 *
 * Idempotent: if the scheduler is already running, calling `start`
 * again is a no-op. No re-entrance concerns.
 *
 * Failures inside `runHourlyGc` are caught and logged — a sick GC
 * run never crashes the scheduler; the next tick tries again.
 * Important because the sweep walks the blob store and one flaky
 * `list` / `delete` shouldn't kill the whole subsystem.
 */
export function startBackupGcScheduler(
  options: StartBackupGcOptions = {},
): void {
  if (_gcTimer) return;
  const intervalMs = options.intervalMs ?? DEFAULT_GC_INTERVAL_MS;
  const config = options.config ?? DEFAULT_GC_CONFIG;

  const tick = (): void => {
    sweepHourly(config).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      warn(
        `[backups/gc] scheduled hourly sweep threw — next tick will retry: ${msg}`,
      );
    });
  };

  _gcTimer = setInterval(tick, intervalMs);
  // Node `unref()` so the timer doesn't keep the process alive on
  // shutdown. Server's `onClose` hook explicitly clears it, but if
  // for some reason shutdown skips the hook, we don't want GC to be
  // the thing preventing exit.
  _gcTimer.unref();

  if (options.runOnStart) {
    tick();
  }
  log(
    `[backups/gc] scheduler started (interval=${intervalMs}ms, ` +
      `perFileCap=${config.perFileCap}, totalSizeCap=${config.totalSizeCapBytes}B, ` +
      `runOnStart=${options.runOnStart ?? false})`,
  );
}

/**
 * Stop the periodic GC sweep. Called from the server's `onClose`
 * lifecycle hook. Idempotent — safe to call when not running.
 */
export function stopBackupGcScheduler(): void {
  if (!_gcTimer) return;
  clearInterval(_gcTimer);
  _gcTimer = null;
  log("[backups/gc] scheduler stopped");
}

/**
 * Test-only introspection — is the scheduler currently running?
 */
export function isBackupGcSchedulerRunning(): boolean {
  return _gcTimer !== null;
}
