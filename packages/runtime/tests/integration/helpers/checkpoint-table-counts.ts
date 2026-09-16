/**
 * Stack 208 P3 — privileged read-only counts for the langchain checkpoint
 * tables, parameterized by graph thread id. Used by the long-run /
 * no-progress / ephemeral-cleanup integration tests to assert that
 * compaction drains to a single surviving checkpoint, that referenced
 * blobs exist, and that stale writes/checkpoints do not scale with the
 * number of graph rounds.
 *
 * The helper runs raw parameterized SQL over a caller-supplied
 * `DirectDatabase` (the canonical privileged direct pool from
 * `getDirectDb()` / `createDirectDb()`), which owns SELECT on the
 * `langchain.*` checkpoint tables. It never writes, never creates its
 * own pool, and never logs connection strings. All values are
 * parameterized; all table references are schema-qualified to
 * `langchain` (the schema `PostgresSaver` is constructed with).
 */

import { sql, type DirectDatabase } from "@nautilo/db";

/** Schema-qualified table names owned by `PostgresSaver.setup()`. */
const CHECKPOINTS_TABLE = "langchain.checkpoints";
const BLOBS_TABLE = "langchain.checkpoint_blobs";
const WRITES_TABLE = "langchain.checkpoint_writes";

export interface CheckpointCounts {
  /** Rows in `langchain.checkpoints` for the thread (across all namespaces). */
  checkpoints: number;
  /** Rows in `langchain.checkpoint_blobs` for the thread. */
  blobs: number;
  /** Rows in `langchain.checkpoint_writes` for the thread. */
  writes: number;
}

/**
 * Read the first row from a drizzle `execute(sql\`...\`)` result. drizzle
 * over `postgres-js` returns an array of rows; some adapters return
 * `{ rows: [...] }`. Handle both defensively.
 */
function firstRow<T extends Record<string, unknown>>(result: unknown): T | undefined {
  if (Array.isArray(result)) return result[0] as T | undefined;
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows: T[] }).rows;
    return rows[0];
  }
  return undefined;
}

/**
 * Privileged read-only counts for one thread id across the three
 * `langchain.*` checkpoint tables. Returns 0 for each when the thread has
 * no rows (e.g. after ephemeral-thread cleanup, or before any put).
 */
async function getCheckpointCounts(
  db: DirectDatabase,
  threadId: string,
): Promise<CheckpointCounts> {
  const [cp, bl, wr] = await Promise.all([
    db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(CHECKPOINTS_TABLE)} WHERE thread_id = ${threadId}`),
    db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(BLOBS_TABLE)} WHERE thread_id = ${threadId}`),
    db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(WRITES_TABLE)} WHERE thread_id = ${threadId}`),
  ]);
  const checkpoints = firstRow<{ n: number }>(cp)?.n ?? 0;
  const blobs = firstRow<{ n: number }>(bl)?.n ?? 0;
  const writes = firstRow<{ n: number }>(wr)?.n ?? 0;
  return { checkpoints, blobs, writes };
}

/**
 * Wait (poll) until the checkpoint count for a thread reaches `expected`,
 * or throw after `timeoutMs`. Compaction is fire-and-forget on the
 * `put` caller's critical path, so a freshly-completed run may still
 * have stale rows for a few ms; this helper drains that race
 * deterministically without flaking on timing.
 */
export async function waitForCheckpointCount(
  db: DirectDatabase,
  threadId: string,
  expected: number,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<CheckpointCounts> {
  const start = Date.now();
  let counts = await getCheckpointCounts(db, threadId);
  while (counts.checkpoints !== expected) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitForCheckpointCount timed out after ${timeoutMs}ms: ` +
          `expected checkpoints=${expected}, got ${counts.checkpoints} ` +
          `(blobs=${counts.blobs} writes=${counts.writes})`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    counts = await getCheckpointCounts(db, threadId);
  }
  return counts;
}

/**
 * Wait until the checkpoint count for a thread is <= `max` (e.g. 1 after
 * compaction drains). Used by the long-run test where the exact post-
 * compaction count is a single surviving row.
 */
export async function waitForCheckpointCountAtMost(
  db: DirectDatabase,
  threadId: string,
  max: number,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<CheckpointCounts> {
  const start = Date.now();
  let counts = await getCheckpointCounts(db, threadId);
  while (counts.checkpoints > max) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitForCheckpointCountAtMost timed out after ${timeoutMs}ms: ` +
          `expected checkpoints<=${max}, got ${counts.checkpoints} ` +
          `(blobs=${counts.blobs} writes=${counts.writes})`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    counts = await getCheckpointCounts(db, threadId);
  }
  return counts;
}
