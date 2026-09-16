/**
 * Stack 208 P1 — shallow checkpoint compaction helpers.
 *
 * Extracted from checkpoint-saver so unit-isolated tests can static-import
 * deterministic SQL/serialization without dynamic-import blind spots for Knip.
 */
const CHECKPOINT_SCHEMA = "langchain";

// Delete checkpoint rows strictly older than the just-put checkpoint id.
// Kept: checkpoint_id >= $3 (the just-put row plus any newer concurrent row).
const COMPACTION_DELETE_OLDER_CHECKPOINTS_SQL = `DELETE FROM ${CHECKPOINT_SCHEMA}.checkpoints
WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id < $3`;

// Delete writes for deleted (older) checkpoints. Writes for retained
// checkpoints (checkpoint_id >= $3) survive, preserving pending writes the
// pinned saver loads via `WHERE checkpoint_id = <latest>`.
const COMPACTION_DELETE_OLDER_WRITES_SQL = `DELETE FROM ${CHECKPOINT_SCHEMA}.checkpoint_writes
WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id < $3`;

// Delete blobs not referenced by any surviving checkpoint. After the two
// deletes above, the only rows left in `checkpoints` for this
// (thread_id, checkpoint_ns) are the retained ones, so this NOT EXISTS
// naturally keeps exactly the blobs their `channel_versions` point at.
const COMPACTION_DELETE_UNREFERENCED_BLOBS_SQL = `DELETE FROM ${CHECKPOINT_SCHEMA}.checkpoint_blobs AS bl
WHERE bl.thread_id = $1
  AND bl.checkpoint_ns = $2
  AND NOT EXISTS (
    SELECT 1
    FROM ${CHECKPOINT_SCHEMA}.checkpoints AS cp
    WHERE cp.thread_id = bl.thread_id
      AND cp.checkpoint_ns = bl.checkpoint_ns
      AND (cp.checkpoint -> 'channel_versions') ->> bl.channel = bl.version
  )`;

/** Minimal client interface `runCompaction` needs — a `pg.PoolClient` subset. */
export interface CompactionClient {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
}

/** Ordered compaction statements for one (thread_id, checkpoint_ns) put. */
export interface CompactionStatement {
  sql: string;
  params: unknown[];
}

/**
 * Build the ordered, schema-qualified, parameterized compaction statements
 * for a single just-put checkpoint. Pure — no I/O. Exported for deterministic
 * SQL/param testing without a database.
 */
export function buildCompactionQueries(
  threadId: string,
  checkpointNs: string,
  retainedCheckpointId: string,
): CompactionStatement[] {
  return [
    { sql: COMPACTION_DELETE_OLDER_CHECKPOINTS_SQL, params: [threadId, checkpointNs, retainedCheckpointId] },
    { sql: COMPACTION_DELETE_OLDER_WRITES_SQL, params: [threadId, checkpointNs, retainedCheckpointId] },
    { sql: COMPACTION_DELETE_UNREFERENCED_BLOBS_SQL, params: [threadId, checkpointNs] },
  ];
}

/**
 * Run compaction for one just-put checkpoint inside a single transaction.
 * Best-effort: any error is rolled back, logged, and swallowed — it never
 * throws to the caller, so a successful durable `put` is never turned into an
 * agent failure. Cleanup leaks are retried on the next successful `put`.
 */
export async function runCompaction(
  client: CompactionClient,
  threadId: string,
  checkpointNs: string,
  retainedCheckpointId: string,
): Promise<void> {
  try {
    await client.query("BEGIN");
    for (const stmt of buildCompactionQueries(threadId, checkpointNs, retainedCheckpointId)) {
      await client.query(stmt.sql, stmt.params);
    }
    await client.query("COMMIT");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    try {
      await client.query("ROLLBACK");
    } catch {
      // Rollback itself failed — pool client is still released by the caller.
    }
    // Best-effort: log and swallow. The next successful put retries cleanup.
    console.warn(
      `[checkpoint] compaction failed for thread=${threadId} ns=${checkpointNs} retained=${retainedCheckpointId} (will retry on next put): ${msg}`,
    );
  }
}

/**
 * Per-(thread_id, checkpoint_ns) serialization for compaction within this
 * process. Compaction reads the surviving checkpoints and deletes older
 * rows; overlapping compactions for the same thread/ns could otherwise race
 * (one deleting a row the other still expects). The lock is keyed with a NUL
 * separator so a thread id containing `|` cannot collide with a namespace.
 */
const compactionLocks = new Map<string, Promise<void>>();

export function compactionLockKey(threadId: string, checkpointNs: string): string {
  return `${threadId}\u0000${checkpointNs}`;
}

/**
 * Serialize a compaction run per thread/namespace. `run` is expected to
 * swallow its own errors (see `runCompaction`); this serializer additionally
 * guards the chain so a rejected predecessor still lets the next run proceed.
 * Exported for concurrency testing.
 */
export function serializeCompaction(
  key: string,
  run: () => Promise<void>,
): Promise<void> {
  const prev = compactionLocks.get(key) ?? Promise.resolve();
  // `run` is expected to swallow its own errors (see `runCompaction`); the
  // trailing `.then(_, _)` guarantees the chain — and the cleanup `finally` —
  // never surfaces an unhandled rejection even if a caller passes a rejecting
  // run. Compaction is best-effort; it must never reject.
  const next = prev.then(run, run).then(
    () => undefined,
    () => undefined,
  );
  compactionLocks.set(key, next);
  void next.finally(() => {
    if (compactionLocks.get(key) === next) compactionLocks.delete(key);
  });
  return next;
}

/** Reset the in-process compaction lock map (tests only). */
export function __resetCompactionLocksForTests(): void {
  compactionLocks.clear();
}

