/**
 * LangGraph checkpoint persistence — wire-protocol only.
 *
 * `PostgresSaver` from `@langchain/langgraph-checkpoint-postgres` manages its
 * own internal `pg` pool and requires a direct Postgres connection string.
 * It cannot use the Neon HTTP `db` / `agentDb` singletons. This is intentional
 * and out of scope for M033's agent-role cutover (see ISSUE-M033 Phase 5).
 *
 * Stack 198 — least-privilege checkpoint saver. Setup and runtime now use
 * SEPARATE Postgres identities:
 *
 *   - **Setup** (`setupCheckpointSaver()`) runs `PostgresSaver.setup()` —
 *     `CREATE SCHEMA`, the versioned `checkpoint_migrations` table, and the
 *     checkpoint tables — over a SHORT-LIVED setup pool built from the
 *     canonical privileged direct connection resolved by
 *     `resolveDirectDatabaseConnectionString()` (`DB_DIRECT_CONNECTION` /
 *     resolved-instance direct connection). That connection carries DDL
 *     privileges (commonly the `postgres` superuser), which the agent
 *     runtime must NOT hold. Immediately after a successful `setup()`, the
 *     narrow idempotent grant block
 *     (`buildLangchainCheckpointRoleGrantsSql()`) is executed over the
 *     SAME setup pool, granting `nautilo_agent` exactly USAGE + DML on
 *     `checkpoints` / `checkpoint_blobs` / `checkpoint_writes` (and
 *     defensive sequence access). The setup pool is then closed; it is
 *     never registered for shutdown.
 *
 *   - **Runtime** (`createCheckpointSaver()`) returns the LONG-LIVED saver
 *     used for get/put/putWrites/list. Its pool connects as the
 *     `nautilo_agent` role via `resolveDirectAgentDatabaseConnectionString()`
 *     (`DB_AGENT_DIRECT_CONNECTION`), with a stable `application_name`.
 *     Only this pool is registered with the shutdown registry.
 *
 * `setupCheckpointSaver()` is concurrency-safe (concurrent callers share a
 * single in-flight setup) and idempotent (a successful setup is not re-run).
 * `createCheckpointSaver()` is preserved as a synchronous handle for graph
 * construction; at boot the server runs `setupCheckpointSaver()` first, so
 * the executor's `createCheckpointSaver()` returns the already-provisioned
 * cached saver. In test mode the server skips checkpoint setup entirely.
 */
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  buildLangchainCheckpointRoleGrantsSql,
  registerPoolForShutdown,
  resolveDirectAgentDatabaseConnectionString,
  resolveDirectDatabaseConnectionString,
} from "@nautilo/db";
import pg from "pg";
import { SUBAGENT_GRAPH_THREAD_PREFIX } from "../store/session-store";

const CHECKPOINT_POOL_NAME = "checkpoint:langgraph";
const CHECKPOINT_APPLICATION_NAME = "nautilo.checkpoint";
const CHECKPOINT_POOL_MAX = 10;

const SETUP_POOL_MAX = 2;
const SETUP_APPLICATION_NAME = "nautilo.checkpoint.setup";

/**
 * Stack 208 — shallow checkpoint compaction.
 *
 * The pinned `PostgresSaver` keeps every superstep's checkpoint, every
 * `checkpoint_writes` row, and every distinct
 * `(thread_id, checkpoint_ns, channel, version)` blob forever. A long-running
 * room accumulates thousands of rows and ~1 GB+ of blobs (measured 2026-07-20).
 *
 * `runCompaction` runs best-effort, *after* a durable `put` has
 * committed, and retains only the latest resumable state for the
 * `(thread_id, checkpoint_ns)` that was just written:
 *
 *   - the just-put checkpoint row (and any newer row that snuck in),
 *   - the `checkpoint_writes` rows for those retained checkpoints
 *     (the pinned saver loads pending writes via
 *     `WHERE checkpoint_id = <latest>` — see `SELECT_SQL` in
 *     `@langchain/langgraph-checkpoint-postgres` `sql.ts`),
 *   - every `checkpoint_blobs` row referenced by a retained checkpoint's
 *     `channel_versions` (the saver's `SELECT_SQL` joins blobs to
 *     `checkpoint->'channel_versions'`).
 *
 * It deletes older checkpoint rows, writes for deleted checkpoints, and blobs
 * no longer referenced by any surviving checkpoint. All SQL is scoped to
 * `thread_id = $1 AND checkpoint_ns = $2` so it can never touch another thread
 * or namespace. All table references are schema-qualified to `langchain` (the
 * schema the saver is constructed with) and all values are parameterized.
 *
 * Why the immediate parent is NOT retained: the pinned saver's `getTuple`
 * only loads the latest checkpoint, its `channel_versions` blobs, and its own
 * pending writes. It returns a `parentConfig` pointer but does not load the
 * parent's data. The only saver code that reads the parent's writes is
 * `SELECT_PENDING_SENDS_SQL`, used solely to migrate legacy `v < 4`
 * checkpoints; the current format is `v: 4`
 * (`@langchain/langgraph-checkpoint/src/base.ts`), so newly-put checkpoints
 * never need the parent. Retaining the parent would defeat compaction (always
 * 2 rows) without any resume benefit, so it is intentionally not retained.
 *
 * Best-effort contract: a compaction failure is logged and retried on the next
 * successful `put`. It must never convert a successful durable `put` into an
 * agent failure — `runCompaction` swallows all errors and the `put` wrapper
 * fires compaction without awaiting it on the caller's critical path.
 */
import {
  runCompaction,
  compactionLockKey,
  serializeCompaction,
  type CompactionClient,
} from "./checkpoint-compaction.js";

/**
 * Stack 208 P1 — terminal ephemeral-thread cleanup guard.
 *
 * `PostgresSaver.deleteThread(threadId)` wipes every checkpoint /
 * `checkpoint_blobs` / `checkpoint_writes` row for a `thread_id` (all
 * namespaces) in one transaction. We only ever call it for terminal
 * EPHEMERAL threads — a fork's `:fork:` checkpoint thread or a task /
 * subagent `subagent:` checkpoint thread — and only after the durable
 * output / report-back commit has landed, so the transcript / report-back
 * never depend on a checkpoint row we just deleted.
 *
 * This predicate is the LAST line of defense, not the first: the call sites
 * (`fork-langgraph-executor`, `task-run-executor`) already gate on the
 * terminal-state contract (no pending interrupt, no abort, no awaiting /
 * approval / PIN / identity / D422-unknown). This guard ensures a misrouted
 * cleanup — a canonical foreground room thread (`room:<roomId>:bot:<agentId>`)
 * or any unrecognized shape — can never wipe a live room's resumable state.
 */
export function isEphemeralCheckpointThread(threadId: string): boolean {
  if (typeof threadId !== "string" || threadId.length === 0) return false;
  // Fork checkpoint thread: `<parentThreadId>:fork:<turnId>:<suffix>`.
  if (threadId.includes(":fork:")) return true;
  // Task / subagent checkpoint thread: `subagent:…`.
  if (threadId.startsWith(SUBAGENT_GRAPH_THREAD_PREFIX)) return true;
  return false;
}

/**
 * Stack 208 P1 — best-effort delete of a terminal ephemeral checkpoint thread.
 *
 * Wraps the cached `PostgresSaver.deleteThread` (schema-qualified, scoped to
 * `thread_id` across all three checkpoint tables / all namespaces) and:
 *
 *   - refuses non-ephemeral threads via `isEphemeralCheckpointThread` (so a
 *     canonical foreground room thread or an unknown shape is never touched),
 *   - swallows every error from `PostgresSaver.deleteThread` itself (logs +
 *     returns), so a
 *     cleanup failure never turns already-successful upstream work into a
 *     failure. The failed delete leaves reclaimable checkpoint storage for
 *     future operational cleanup; it never affects correctness because the
 *     transcript / report-back has already committed.
 *
 * Callers MUST have already durably committed the output / report-back before
 * invoking this — it is the cleanup step, not the persistence step.
 */
export async function deleteEphemeralCheckpointThread(
  saver: PostgresSaver,
  threadId: string,
): Promise<void> {
  if (!isEphemeralCheckpointThread(threadId)) return;
  try {
    await saver.deleteThread(threadId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(
      `[checkpoint] deleteEphemeralCheckpointThread failed for thread=${threadId} (best-effort, swallowed): ${msg}`,
    );
  }
}

interface SaverPoolLike {
  connect?: () => Promise<CompactionClient & { release: () => void }>;
}

function saverPool(saver: PostgresSaver): SaverPoolLike {
  return (saver as unknown as { pool: SaverPoolLike }).pool;
}

/**
 * Trigger best-effort compaction after a successful `put`. Extracts the
 * just-put `(thread_id, checkpoint_ns, checkpoint_id)` from the returned
 * config, acquires the per-thread lock, checks out a client, and runs
 * `runCompaction`. Returns the best-effort operation so protected callers can
 * keep every shadow-table query inside a live authorization callback. Existing
 * plaintext callers intentionally fire-and-forget the returned promise.
 */
function triggerCheckpointCompaction(
  saver: PostgresSaver,
  resultConfig: unknown,
): Promise<void> {
  const configurable = (resultConfig as { configurable?: Record<string, unknown> } | null)?.configurable;
  if (!configurable) return Promise.resolve();
  const threadId = configurable["thread_id"];
  const checkpointNs = (configurable["checkpoint_ns"] as string | undefined) ?? "";
  const retainedCheckpointId = configurable["checkpoint_id"];
  if (typeof threadId !== "string" || typeof retainedCheckpointId !== "string") {
    return Promise.resolve();
  }
  if (!threadId || !retainedCheckpointId) return Promise.resolve();

  const key = compactionLockKey(threadId, checkpointNs);
  return serializeCompaction(key, async () => {
    const pool = saverPool(saver);
    if (!pool || typeof pool.connect !== "function") return;
    let client: (CompactionClient & { release: () => void }) | undefined;
    try {
      client = await pool.connect();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[checkpoint] compaction: failed to acquire client (will retry on next put): ${msg}`);
      return;
    }
    try {
      await runCompaction(
        client,
        threadId,
        checkpointNs,
        retainedCheckpointId,
      );
    } finally {
      client.release();
    }
  });
}

let checkpointSaver: PostgresSaver | null = null;
let checkpointPoolRegistered = false;
let checkpointPoolEnd: (() => Promise<void>) | null = null;
let checkpointCloseInFlight: Promise<void> | null = null;
let setupCompleted = false;
let setupInFlight: Promise<PostgresSaver> | null = null;

function isTransientConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : (typeof error === "string" ? error : "unknown error");
  return (
    message.includes("Connection terminated unexpectedly") ||
    message.includes("connection terminated") ||
    message.includes("Client has encountered a connection error") ||
    message.includes("ECONNRESET") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ETIMEDOUT") ||
    message.includes("connection timeout") ||
    message.includes("timeout expired") ||
    message.includes("Authentication timed out")
  );
}

function wrapWithResilience(saver: PostgresSaver): void {
  const originalPut = saver.put.bind(saver);
  const originalPutWrites = saver.putWrites.bind(saver);

  saver.put = async function resilientPut(...args) {
    let result;
    let succeeded = false;
    try {
      result = await originalPut(...args);
      succeeded = true;
      return result;
    } catch (error) {
      if (!isTransientConnectionError(error)) throw error;

      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[checkpoint] Transient connection error during put, retrying in 1s: ${msg}`);
      await new Promise(resolve => setTimeout(resolve, 1000));

      try {
        result = await originalPut(...args);
        succeeded = true;
        return result;
      } catch (retry1Error) {
        const retry1Msg = retry1Error instanceof Error ? retry1Error.message : String(retry1Error);
        console.warn(`[checkpoint] put retry 1 failed, retrying in 3s: ${retry1Msg}`);
        await new Promise(resolve => setTimeout(resolve, 3000));

        try {
          result = await originalPut(...args);
          succeeded = true;
          return result;
        } catch (retry2Error) {
          const retry2Msg = retry2Error instanceof Error ? retry2Error.message : String(retry2Error);
          console.error(`[checkpoint] put retry 2 also failed, propagating error: ${retry2Msg}`);
          throw retry2Error;
        }
      }
    } finally {
      // Fire-and-forget best-effort compaction only on a durable put.
      // Never let compaction turn a successful put into an agent failure.
      if (succeeded) void triggerCheckpointCompaction(saver, result);
    }
  };

  saver.putWrites = async function resilientPutWrites(...args) {
    try {
      return await originalPutWrites(...args);
    } catch (error) {
      if (!isTransientConnectionError(error)) throw error;

      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[checkpoint] Transient connection error during putWrites, retrying in 1s: ${msg}`);
      await new Promise(resolve => setTimeout(resolve, 1000));

      try {
        return await originalPutWrites(...args);
      } catch (retry1Error) {
        const retry1Msg = retry1Error instanceof Error ? retry1Error.message : String(retry1Error);
        console.warn(`[checkpoint] putWrites retry 1 failed, retrying in 3s: ${retry1Msg}`);
        await new Promise(resolve => setTimeout(resolve, 3000));

        try {
          return await originalPutWrites(...args);
        } catch (retry2Error) {
          const retry2Msg = retry2Error instanceof Error ? retry2Error.message : String(retry2Error);
          console.error(`[checkpoint] putWrites retry 2 also failed, propagating error: ${retry2Msg}`);
          throw retry2Error;
        }
      }
    }
  };
}

interface CheckpointPoolErrorEmitter {
  on?(event: "error", listener: (err: Error) => void): unknown;
}

function attachCheckpointPoolErrorHandler(
  pool: CheckpointPoolErrorEmitter,
): void {
  try {
    if (pool && typeof pool.on === "function") {
      pool.on("error", (err: Error) => {
        console.warn("[checkpoint] Pool idle client error (handled):", err.message);
      });
    }
  } catch {
    // If pool field isn't accessible, skip — resilience wrappers still protect
  }
}

function poolEndFromSaver(saver: PostgresSaver): () => Promise<void> {
  const pool = (saver as unknown as { pool: { end?: () => Promise<void> } }).pool;
  return async () => {
    if (pool && typeof pool.end === "function") {
      await pool.end();
    }
  };
}

function registerCheckpointPoolOnce(saver: PostgresSaver): void {
  if (checkpointPoolRegistered) return;
  checkpointPoolRegistered = true;
  checkpointPoolEnd = poolEndFromSaver(saver);
  registerPoolForShutdown({
    name: CHECKPOINT_POOL_NAME,
    close: async (timeoutMs) => {
      await closeCheckpointSaver(timeoutMs);
    },
  });
}

/** Append a stable Postgres application_name without logging connection details. */
function withApplicationName(connectionString: string, applicationName: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

/**
 * Connection string for the SETUP pool — the canonical privileged direct
 * connection resolved by `resolveDirectDatabaseConnectionString()`.
 * Its precedence is `DB_DIRECT_CONNECTION` then the resolved instance's
 * direct connection. `PostgresSaver.setup()` and the post-setup grant block
 * both run over this identity.
 *
 * Do not fall back to or rewrite `DB_CONNECTION_STRING`: that is the app-role
 * runtime URL and may not own an existing `langchain` schema. In Stack 198 the
 * schema is owned by `postgres`, so using the `nautilo` app role fails before
 * the restricted runtime saver can start.
 */
function getSetupConnectionString(): string {
  return withApplicationName(
    resolveDirectDatabaseConnectionString(),
    SETUP_APPLICATION_NAME,
  );
}

/**
 * Connection string for the LONG-LIVED runtime saver — the restricted
 * `nautilo_agent` role via `resolveDirectAgentDatabaseConnectionString()`
 * (`DB_AGENT_DIRECT_CONNECTION`). The runtime only needs DML on the three
 * checkpoint tables, which the setup path granted.
 */
function getRuntimeConnectionString(): string {
  return withApplicationName(
    resolveDirectAgentDatabaseConnectionString(),
    CHECKPOINT_APPLICATION_NAME,
  );
}

function constructRuntimeSaver(): PostgresSaver {
  const saver = new PostgresSaver(
    new pg.Pool({
      connectionString: getRuntimeConnectionString(),
      max: CHECKPOINT_POOL_MAX,
    }),
    undefined,
    { schema: "langchain" },
  );

  attachCheckpointPoolErrorHandler(
    (saver as unknown as { pool: CheckpointPoolErrorEmitter }).pool,
  );
  wrapWithResilience(saver);

  return saver;
}

/**
 * A short-lived agent-role pool owned by one encrypted checkpoint facade.
 * Unlike the process-global ordinary saver, callers must close this pool via
 * `EncryptedCheckpointSaver.end()` when the foreground invocation finishes.
 */
export function createDedicatedEncryptedCheckpointPool(): pg.Pool {
  const pool = new pg.Pool({
    connectionString: getRuntimeConnectionString(),
    max: 1,
  });
  attachCheckpointPoolErrorHandler(pool);
  return pool;
}

/**
 * Provision the langchain checkpoint schema and grant the agent runtime
 * role exactly the privileges it needs. Runs `PostgresSaver.setup()` over a
 * short-lived setup pool built from the canonical privileged direct
 * connection, executes the narrow idempotent grant block over the SAME pool,
 * then closes the setup pool and constructs the long-lived agent-role saver.
 * Only the long-lived saver is registered for shutdown.
 *
 * Concurrency-safe: concurrent callers share a single in-flight setup.
 * Idempotent: a previously successful setup is not re-run; later callers
 * receive the cached saver. A failed setup propagates the error (the setup
 * pool is still closed via `finally`), and a subsequent call will retry.
 * Never logs connection strings or passwords.
 */
export async function setupCheckpointSaver(): Promise<PostgresSaver> {
  if (setupCompleted && checkpointSaver) return checkpointSaver;
  if (setupInFlight) return setupInFlight;

  setupInFlight = (async () => {
    const setupPool = new pg.Pool({
      connectionString: getSetupConnectionString(),
      max: SETUP_POOL_MAX,
    });
    try {
      const setupSaver = new PostgresSaver(setupPool, undefined, {
        schema: "langchain",
      });
      // Creates/migrates the langchain schema, checkpoint_migrations, and the
      // three checkpoint tables. Runs as the setup identity (DDL privileges).
      await setupSaver.setup();
      // Narrow post-setup grants over the same setup pool — authoritative
      // because setup just created/migrated the tables. Idempotent.
      await setupPool.query(buildLangchainCheckpointRoleGrantsSql());
    } finally {
      // Never leak the setup pool — it carries DDL privileges and is not
      // needed by the runtime. Not registered with the shutdown registry.
      await setupPool.end();
    }

    if (!checkpointSaver) {
      checkpointSaver = constructRuntimeSaver();
      registerCheckpointPoolOnce(checkpointSaver);
    }
    setupCompleted = true;
    return checkpointSaver;
  })();

  try {
    return await setupInFlight;
  } finally {
    setupInFlight = null;
  }
}

export async function closeCheckpointSaver(timeoutMs = 1000): Promise<void> {
  if (!checkpointSaver && !checkpointPoolEnd) return;
  if (checkpointCloseInFlight) {
    await checkpointCloseInFlight;
    return;
  }

  const end = checkpointPoolEnd;
  if (!end) return;

  checkpointCloseInFlight = (async () => {
    try {
      if (timeoutMs > 0) {
        await Promise.race([
          end(),
          new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error("pool close timed out")), timeoutMs);
          }),
        ]);
      } else {
        await end();
      }
    } finally {
      checkpointSaver = null;
      checkpointPoolEnd = null;
      checkpointPoolRegistered = false;
      setupCompleted = false;
    }
  })();

  try {
    await checkpointCloseInFlight;
  } finally {
    checkpointCloseInFlight = null;
  }
}

/**
 * Synchronous handle to the long-lived agent-role saver used for
 * get/put/putWrites/list. At boot the server runs `setupCheckpointSaver()`
 * first, so this returns the already-provisioned cached saver. Constructing
 * on demand is preserved for test seams and the rare path that runs without
 * a setup pass (the saver still works against a previously-provisioned
 * schema). The pool connects as `nautilo_agent` — never the DDL identity.
 */
export function createCheckpointSaver(): PostgresSaver {
  if (checkpointSaver) return checkpointSaver;

  const saver = constructRuntimeSaver();

  checkpointSaver = saver;
  registerCheckpointPoolOnce(saver);
  return checkpointSaver;
}

export type { PostgresSaver };
