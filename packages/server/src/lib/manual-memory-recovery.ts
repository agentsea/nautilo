import {
  and, asc, createPostgresJsCanonicalBridgeConnection, desc, eq, isNull, memoryRecoveryRuns, or, sql,
  type DirectDatabase, type PostgresJsBridgeExecutor,
} from "@nautilo/db";
import type { MemoryRecoveryLaneResult, MemoryRecoveryRun } from "@nautilo/types";

const processors = ["stenographer", "reflection", "memory"] as const;
type Processor = typeof processors[number];
type RunRow = typeof memoryRecoveryRuns.$inferSelect;
type Transaction = Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];
type Assessed = Extract<MemoryRecoveryLaneResult, { state: "assessed" }>;
type Recover = (input: {
  db: Transaction; executor: PostgresJsBridgeExecutor; authorizedBy: string; now: Date; observedThrough: Date;
  page: { after: string | null; limit: number };
}) => Promise<MemoryRecoveryLaneResult & { nextCursor?: string }>;

const DEFAULT_LOCK_TIMEOUT_MS = 250;
const RETRYABLE_CONTENTION_SQLSTATES = new Set(["55P03", "40P01", "40001"]);

function isRetryableContention(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current !== null && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && RETRYABLE_CONTENTION_SQLSTATES.has(candidate.code)) return true;
    current = candidate.cause;
  }
  return false;
}

function report(row: RunRow): MemoryRecoveryRun {
  return { requestId: row.id, observedThrough: row.observedThrough.toISOString(),
    stenographer: row.stenographer, reflection: row.reflection, memory: row.memory };
}

function totals(prior: Assessed | undefined, page: Assessed): Assessed {
  const previous = prior?.derivedRepair;
  const repair = page.derivedRepair;
  return {
    state: "assessed", queued: (prior?.queued ?? 0) + page.queued, held: (prior?.held ?? 0) + page.held,
    ...((previous || repair) && { derivedRepair: {
      retired: (previous?.retired ?? 0) + (repair?.retired ?? 0),
      sourcesQueued: (previous?.sourcesQueued ?? 0) + (repair?.sourcesQueued ?? 0),
      ...((previous?.summariesQueued !== undefined || repair?.summariesQueued !== undefined) && {
        summariesQueued: (previous?.summariesQueued ?? 0) + (repair?.summariesQueued ?? 0),
      }),
    } }),
  };
}

export function createManualMemoryRecovery(options: {
  db: () => DirectDatabase;
  assertAvailable(): Promise<void>;
  pageAvailable(tx: Transaction, now: Date): Promise<boolean>;
  recover: Record<Processor, Recover>;
  pageSize: number;
  pollMs: number;
  /** Bound every global-gate and work-row lock wait held by one recovery page. */
  lockTimeoutMs?: number;
  onError(processor: Processor | "worker"): void;
  wakeMemory?(): void;
}) {
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs <= 0) {
    throw new TypeError("Manual Memory recovery lock timeout must be a positive safe integer");
  }
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let processing: Promise<void> | undefined;

  async function processNextPage(requestId?: string): Promise<boolean> {
    const connection = createPostgresJsCanonicalBridgeConnection(options.db());
    let outcome: { wakeMemory: boolean; continueImmediately: boolean } | null;
    try {
      outcome = await connection.transaction(async (tx, executor) => {
        // This precedes the run, policy, maintenance and work locks. A blocked
        // page therefore releases every global gate promptly and can be retried.
        await tx.execute(sql`SELECT set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`);
        const [row] = await tx.select().from(memoryRecoveryRuns).where(and(
          requestId ? eq(memoryRecoveryRuns.id, requestId) : undefined,
          or(isNull(memoryRecoveryRuns.stenographer), isNull(memoryRecoveryRuns.reflection), isNull(memoryRecoveryRuns.memory)),
        )).orderBy(
          asc(sql`coalesce((${memoryRecoveryRuns.progress}->>'lastServicedAt')::timestamptz, ${memoryRecoveryRuns.observedThrough})`),
          asc(memoryRecoveryRuns.observedThrough), asc(memoryRecoveryRuns.id),
        ).limit(1).for("update", { skipLocked: true });
        if (!row) return null;
        // A maintenance interval after the click defers dispatch. Keep this
        // checkpoint pending so the worker resumes after maintenance or restart.
        const now = new Date();
        if (now < row.observedThrough || !await options.pageAvailable(tx, now)) return null;
        const progress = { ...row.progress };
        // Give each unfinished processor a turn before advancing a long backlog again.
        const [processor] = processors.filter(key => row[key] === null)
          .sort((a, b) => (progress[a]?.pages ?? 0) - (progress[b]?.pages ?? 0));
        if (!processor) return null;
        const prior = progress[processor];
        let page: Awaited<ReturnType<Recover>>;
        try {
          page = await tx.transaction(async savepoint => {
            const assessment = await options.recover[processor]({
              db: savepoint, executor, authorizedBy: row.authorizedBy,
              now, observedThrough: row.observedThrough,
              page: { after: prior?.after ?? null, limit: options.pageSize },
            });
            if (assessment.nextCursor !== undefined && (!assessment.nextCursor || assessment.nextCursor === prior?.after)) {
              throw new Error("Recovery cursor did not advance");
            }
            return assessment;
          });
        } catch (error) {
          if (isRetryableContention(error)) {
            // Preserve the exact grant and cursor, but advance this lane's round
            // so every other unfinished lane gets a turn before it is retried.
            const pages = (prior?.pages ?? 0) + 1;
            progress[processor] = {
              ...(prior ?? { state: "assessed", queued: 0, held: 0 }),
              after: prior?.after ?? null,
              pages,
            };
            progress.lastServicedAt = now.toISOString();
            await tx.update(memoryRecoveryRuns).set({ progress }).where(eq(memoryRecoveryRuns.id, row.id));
            const otherLaneReady = processors.some(key => key !== processor
              && row[key] === null && (progress[key]?.pages ?? 0) < pages);
            return { wakeMemory: false, continueImmediately: otherLaneReady };
          }
          options.onError(processor);
          page = { state: "unavailable" };
        }
        let result: MemoryRecoveryLaneResult | null = page;
        if (page.state === "assessed") {
          const assessed = totals(prior, page);
          if (page.nextCursor === undefined) {
            delete progress[processor];
            result = assessed;
          } else {
            progress[processor] = { ...assessed, after: page.nextCursor, pages: (prior?.pages ?? 0) + 1 };
            result = null;
          }
        }
        const remainsPending = result === null
          || processors.some(key => key !== processor && row[key] === null);
        if (remainsPending) progress.lastServicedAt = now.toISOString();
        else delete progress.lastServicedAt;
        await tx.update(memoryRecoveryRuns).set({ [processor]: result, progress }).where(eq(memoryRecoveryRuns.id, row.id));
        const wakeMemory = processor === "memory" && page.state === "assessed" && page.queued > 0;
        return { wakeMemory, continueImmediately: true };
      });
    } catch (error) {
      // Deadlocks and serialization failures can invalidate the whole outer
      // transaction rather than only the lane savepoint. Nothing is committed;
      // leave the durable cursor/grant untouched and retry after normal backoff.
      if (isRetryableContention(error)) return false;
      throw error;
    }
    if (outcome?.wakeMemory) options.wakeMemory?.();
    return outcome?.continueImmediately ?? false;
  }

  function schedule(delay: number) {
    if (!started || processing) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      processing = processNextPage().then(more => more ? 0 : options.pollMs)
        .catch(() => { options.onError("worker"); return options.pollMs; })
        .then(next => { processing = undefined; schedule(next); });
    }, delay);
    timer.unref();
  }

  return {
    processNextPage,
    start() { started = true; schedule(0); },
    async stop() { started = false; clearTimeout(timer); await processing; },
    async latest(): Promise<MemoryRecoveryRun | null> {
      const [row] = await options.db().select().from(memoryRecoveryRuns)
        .orderBy(desc(memoryRecoveryRuns.observedThrough), desc(memoryRecoveryRuns.id)).limit(1);
      return row ? report(row) : null;
    },
    async request(input: { requestId: string; authorizedBy: string; now: Date }): Promise<MemoryRecoveryRun> {
      await options.assertAvailable();
      const db = options.db();
      await db.insert(memoryRecoveryRuns).values({
        id: input.requestId, authorizedBy: input.authorizedBy, observedThrough: input.now,
      }).onConflictDoNothing({ target: memoryRecoveryRuns.id });
      const [row] = await db.select().from(memoryRecoveryRuns).where(eq(memoryRecoveryRuns.id, input.requestId));
      if (!row) throw new Error("Recovery request unavailable");
      // An explicit replay may resume failed pages. Keep the original grant,
      // cutoff and cursor, including when another operator reopens the receipt.
      for (const processor of processors) {
        if (row[processor]?.state !== "unavailable") continue;
        await db.update(memoryRecoveryRuns).set({ [processor]: null }).where(and(
          eq(memoryRecoveryRuns.id, row.id), eq(memoryRecoveryRuns[processor], { state: "unavailable" }),
        ));
        row[processor] = null;
      }
      schedule(0);
      return report(row);
    },
  };
}
