import { resumeReconnectedSecurityResearch } from "./security-report-recovery";
import type { ServerEvent } from "@nautilo/types";
import { eventBus } from "../event-bus";
import {
  claimDueTasks,
  recordTaskPreparation,
  clearStaleFireLocks,
  clearTaskWriterReviewAwaitingMarker,
  acquireWorkspaceDocumentMutationOperationLock,
  findWorkspaceEditorSaveForWriterReviewRecovery,
  recordTaskWriterReviewAcceptedReceipt,
  findTimedOutRunningTasks,
  listAwaitingWriterReviewTasks,
  listPendingWriterReviewVerificationTasks,
  listRunningWriterReviewVerificationTasks,
  rescheduleCron,
  updateTask,
  type DirectDatabase,
} from "@nautilo/db";
import type { PolicyResolver } from "@nautilo/trust";
import { assertCanInvokeAgent } from "@nautilo/trust";
import { log } from "@nautilo/logger";
import type { Observer } from "../types";
import {
  dispatchTaskRun,
  type TaskExecutionRouteSelector,
  type TaskJobManager,
  type DispatchTaskRunDeps,
} from "./dispatch-task-run";
import { pauseTask, type TaskLifecycleJobManager } from "./lifecycle";
import { nextCronOccurrence } from "./cron";
import { setTaskRunDb } from "./task-runtime-context";
import {
  reportBackTaskDispatchError,
  reportBackTaskError,
  SAFE_WRITER_REVIEW_FAILED_RESULT,
  SAFE_WRITER_REVIEW_SAVED_VERIFICATION_LOST_RESULT,
  reportBackTaskWriterReviewVerificationLostOnRestart,
} from "./report-back";
import {
  getMaintenanceGate,
  MaintenanceDrainError,
  type MaintenanceGate,
} from "../maintenance-controller";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH = 20;
const DEFAULT_STALE_LOCK_MS = 5 * 60_000;
const DEFAULT_KICK_DEBOUNCE_MS = 50;

export interface TaskObserverDeps {
  db: DirectDatabase;
  /** M147 — the watchdog (R5) pauses overrunning runs, so the observer's
   *  JobManager must expose the `abortJob` seam in addition to dispatch. */
  jobManager: TaskJobManager & TaskLifecycleJobManager;
  /** Defaults to the process policy resolver inside `dispatchTaskRun`. */
  resolver?: PolicyResolver;
  /** Poll interval (default 60s). */
  intervalMs?: number;
  /** Max rows claimed per tick (default 20). */
  batch?: number;
  /** Fire-locks older than this are cleared on start (default 5 min). */
  staleLockMs?: number;
  /** Debounce window for `kick()` (default 50ms). */
  kickDebounceMs?: number;
  /** Clock injection for tests. */
  now?: () => Date;
  /**
   * D420 (Wave 2 task 2.2.1) — maintenance admission gate. While the durable
   * state is active the observer SKIPS claiming/dispatching new task runs
   * (already-running runs finish; due rows stay pending and are claimed after
   * maintenance clears). Defaults to the runtime singleton (production gate
   * wired by `createApp`); hermetic tests inject a permissive stub.
   */
  maintenanceGate?: MaintenanceGate;
  /**
   * Optional server-owned route selector for already-created TaskRuns. The
   * default native Task path is unchanged when this is omitted.
   */
  executionRouteSelector?: TaskExecutionRouteSelector;
  /** Test seam; production defaults to the shared current-RBAC decision. */
  assertInvocation?: typeof assertCanInvokeAgent;
  /** Server composition hook for live clients affected by Task-created Rooms. */
  convergeCreatedRoomCatalog?: DispatchTaskRunDeps["convergeCreatedRoomCatalog"];
  /**
   * Process-local server maintenance that must share the observer lifecycle
   * rather than creating another timer. Failures are isolated from task
   * dispatch so a transient live-session sweep cannot strand due Tasks.
   */
  onMaintenance?: () => void | Promise<void>;
}

type PreparationWrite = Parameters<typeof recordTaskPreparation>[1];

/** Latest-state coalescing for the existing durable Task preparation field. */
export function createTaskPreparationWriter(
  persist: (input: PreparationWrite) => Promise<void>,
  onError: () => void,
): { record(input: PreparationWrite): void; flush(): Promise<void> } {
  const pending = new Map<string, PreparationWrite>();
  const writes = new Map<string, Promise<void>>();
  const drain = (key: string): void => {
    if (writes.has(key)) return;
    const write = Promise.resolve().then(async () => {
      while (pending.has(key)) {
        const latest = pending.get(key)!;
        pending.delete(key);
        try { await persist(latest); } catch { onError(); }
      }
    }).finally(() => {
      if (writes.get(key) === write) writes.delete(key);
      // A new event can arrive between the loop completing and this microtask.
      if (pending.has(key)) drain(key);
    });
    writes.set(key, write);
  };
  return {
    record(input) {
      // An old run must not displace the current run's pending progress. The
      // canonical DB write separately verifies owner, active Task and TaskRun.
      const key = `${input.taskId}:${input.taskRunId}`;
      pending.set(key, input);
      drain(key);
    },
    async flush() {
      while (writes.size > 0) await Promise.all(writes.values());
    },
  };
}

/**
 * M142 (spec §5.2) — the in-process task dispatch daemon. Claims due `tasks`
 * rows (`FOR UPDATE SKIP LOCKED`), dispatches each as its own job via
 * `dispatchTaskRun`, and reschedules cron rows. The DB is the source of truth,
 * so the loop is restart-safe (stale fire-locks recovered on start).
 *
 * Implements the existing `Observer` interface; wired in `createApp` next to
 * the relay registry and stopped in the Fastify `onClose` hook.
 */
export class TaskObserver implements Observer {
  private readonly preparationWriter = createTaskPreparationWriter(
    (input) => recordTaskPreparation(this.db, input),
    () => { log("[task-observer] could not retain preparation status"); },
  );
  private readonly onProgress = (event: ServerEvent): void => {
    if (event.type !== "task.progress" || !event.preparation) return;
    this.preparationWriter.record({ taskId: event.taskId, taskRunId: event.taskRunId,
      ownerId: event.ownerId, preparation: event.preparation, updatedAt: this.now().toISOString() });
  };

  private readonly db: DirectDatabase;
  private readonly jobManager: TaskJobManager & TaskLifecycleJobManager;
  private readonly resolver: PolicyResolver | undefined;
  private readonly intervalMs: number;
  private readonly batch: number;
  private readonly staleLockMs: number;
  private readonly kickDebounceMs: number;
  private readonly now: () => Date;
  /** D420 — admission gate; `null` resolves the runtime singleton at call time. */
  private readonly maintenanceGate: MaintenanceGate | null;
  private readonly executionRouteSelector: TaskExecutionRouteSelector | undefined;
  private readonly assertInvocation: typeof assertCanInvokeAgent;
  private readonly convergeCreatedRoomCatalog: DispatchTaskRunDeps["convergeCreatedRoomCatalog"];
  private readonly onMaintenance: (() => void | Promise<void>) | undefined;

  private interval: ReturnType<typeof setInterval> | null = null;
  private kickTimer: ReturnType<typeof setTimeout> | null = null;
  private tickInFlight = false;
  private pendingTick = false;

  constructor(deps: TaskObserverDeps) {
    this.db = deps.db;
    this.jobManager = deps.jobManager;
    this.resolver = deps.resolver;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.batch = deps.batch ?? DEFAULT_BATCH;
    this.staleLockMs = deps.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.kickDebounceMs = deps.kickDebounceMs ?? DEFAULT_KICK_DEBOUNCE_MS;
    this.now = deps.now ?? (() => new Date());
    this.maintenanceGate = deps.maintenanceGate ?? null;
    this.executionRouteSelector = deps.executionRouteSelector;
    this.assertInvocation = deps.assertInvocation ?? assertCanInvokeAgent;
    this.convergeCreatedRoomCatalog = deps.convergeCreatedRoomCatalog;
    this.onMaintenance = deps.onMaintenance;
  }

  private resolveGate(): MaintenanceGate {
    return this.maintenanceGate ?? getMaintenanceGate();
  }

  async start(): Promise<void> {
    eventBus.off(this.onProgress);
    eventBus.on(this.onProgress);
    // The executor (invoked by JobManager, outside this call graph) reads the
    // db handle from the module singleton.
    setTaskRunDb(this.db);

    // Stale-lock recovery + the first tick must never crash server boot — a
    // transient DB hiccup is logged and retried on the next interval. (Server
    // unit tests boot the app with a non-DB stub handle; this keeps them
    // green while the real interval still runs in production.)
    try {
      const cutoff = new Date(this.now().getTime() - this.staleLockMs);
      const cleared = await clearStaleFireLocks(this.db, cutoff);
      if (cleared > 0) {
        log(`[task-observer] cleared ${cleared} stale fire-lock(s) on start`);
      }
      // A live session capability never survives process restart. Reconcile
      // only exact Writer-review markers, in bounded SQL-filtered pages; do
      // not scan arbitrary `awaiting` Tasks and infer authority in JS.
      let after: { startedAt: Date; runId: string } | undefined;
      let hasMoreWriterReviews = true;
      while (hasMoreWriterReviews) {
        const orphanedWriterReviews = await listAwaitingWriterReviewTasks(
          this.db,
          { limit: this.batch, ...(after ? { after } : {}) },
        );
        hasMoreWriterReviews = orphanedWriterReviews.length > 0;
        if (!hasMoreWriterReviews) break;
        for (const { task, run, marker } of orphanedWriterReviews) {
          let acceptedBeforeRestart = Object.prototype.hasOwnProperty.call(
            marker,
            "acceptedResultRevision",
          );
          if (
            typeof marker.pendingWorkspaceOperationId === "string" &&
            typeof marker.pendingWorkspaceClientMutationId === "string" &&
            typeof marker.pendingWorkspaceArtifactId === "string"
          ) {
            const recovered = await this.db.transaction(async (tx) => {
              const lock = await acquireWorkspaceDocumentMutationOperationLock(
                tx,
                marker.pendingWorkspaceOperationId!,
              );
              return findWorkspaceEditorSaveForWriterReviewRecovery(tx, lock, {
                clientMutationId: marker.pendingWorkspaceClientMutationId!,
                actorId: task.ownerId,
                artifactInternalId: marker.pendingWorkspaceArtifactId!,
              });
            });
            if (recovered.kind === "match") {
              const recorded = await recordTaskWriterReviewAcceptedReceipt(this.db, {
                taskId: task.id,
                taskRunId: run.id,
                proposalId: marker.proposalId,
                resultRevision: { kind: "artifact_revision", revision: recovered.revision },
              });
              acceptedBeforeRestart = recorded.status === "recorded" || recorded.status === "same";
            }
          }
          await reportBackTaskError(
            { db: this.db },
            {
              taskId: task.id,
              runId: run.id,
              scheduleKind: task.scheduleKind,
              error: acceptedBeforeRestart
                ? "LIVE_WRITER_VERIFICATION_LOST_ON_RESTART"
                : "LIVE_WRITER_REVIEW_LOST_ON_RESTART",
              failureResultText: acceptedBeforeRestart
                ? SAFE_WRITER_REVIEW_SAVED_VERIFICATION_LOST_RESULT
                : SAFE_WRITER_REVIEW_FAILED_RESULT,
            },
          );
          await clearTaskWriterReviewAwaitingMarker(this.db, {
            taskId: task.id,
            taskRunId: run.id,
            proposalId: marker.proposalId,
          });
        }
        const last = orphanedWriterReviews.at(-1)!;
        after = { startedAt: last.run.startedAt, runId: last.run.id };
      }

      // Acceptance may have committed the producing run and requeued this
      // same Task just before restart. It no longer has an awaiting marker,
      // but its compact accepted receipt still binds the exact completed run.
      // Never let claimDueTasks mint verification provider work without the
      // vanished process-local live-session authority.
      let afterAcceptedRequeue: { startedAt: Date; runId: string } | undefined;
      let hasMoreAcceptedRequeues = true;
      while (hasMoreAcceptedRequeues) {
        const orphanedAcceptedRequeues = await listPendingWriterReviewVerificationTasks(
          this.db,
          { limit: this.batch, ...(afterAcceptedRequeue ? { after: afterAcceptedRequeue } : {}) },
        );
        hasMoreAcceptedRequeues = orphanedAcceptedRequeues.length > 0;
        if (!hasMoreAcceptedRequeues) break;
        for (const { task, run, receipt } of orphanedAcceptedRequeues) {
          await reportBackTaskWriterReviewVerificationLostOnRestart(
            { db: this.db },
            { taskId: task.id, runId: run.id, proposalId: receipt.proposalId },
          );
        }
        const last = orphanedAcceptedRequeues.at(-1)!;
        afterAcceptedRequeue = { startedAt: last.run.startedAt, runId: last.run.id };
      }

      let afterRunningVerification: { startedAt: Date; runId: string } | undefined;
      let hasMoreRunningVerification = true;
      while (hasMoreRunningVerification) {
        const orphanedRunningVerification = await listRunningWriterReviewVerificationTasks(
          this.db,
          { limit: this.batch, ...(afterRunningVerification ? { after: afterRunningVerification } : {}) },
        );
        hasMoreRunningVerification = orphanedRunningVerification.length > 0;
        if (!hasMoreRunningVerification) break;
        for (const { task, run } of orphanedRunningVerification) {
          await reportBackTaskError(
            { db: this.db },
            {
              taskId: task.id,
              runId: run.id,
              scheduleKind: task.scheduleKind,
              error: "LIVE_WRITER_VERIFICATION_LOST_ON_RESTART",
              failureResultText: SAFE_WRITER_REVIEW_SAVED_VERIFICATION_LOST_RESULT,
            },
          );
        }
        const last = orphanedRunningVerification.at(-1)!;
        afterRunningVerification = { startedAt: last.run.startedAt, runId: last.run.id };
      }
    } catch (err) {
      log(
        `[task-observer] stale-lock clear failed on start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.tick();
    this.interval = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    eventBus.off(this.onProgress);
    await this.preparationWriter.flush();
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.kickTimer) {
      clearTimeout(this.kickTimer);
      this.kickTimer = null;
    }
    return Promise.resolve();
  }

  /** Out-of-band, debounced tick (called by `createTask` for now-tasks). */
  kick(): void {
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      void this.tick();
    }, this.kickDebounceMs);
  }

  /** Re-entrancy-guarded tick. A tick requested while one is in flight runs
   * once afterward (bursts coalesce); concurrent claims across observers are
   * already disjoint via `FOR UPDATE SKIP LOCKED`. */
  async tick(): Promise<void> {
    if (this.tickInFlight) {
      this.pendingTick = true;
      return;
    }
    this.tickInFlight = true;
    try {
      await this.runTickOnce();
    } finally {
      this.tickInFlight = false;
      if (this.pendingTick) {
        this.pendingTick = false;
        void this.tick();
      }
    }
  }

  private async runTickOnce(): Promise<void> {
    const now = this.now();

    if (this.onMaintenance) {
      try {
        await this.onMaintenance();
      } catch (err) {
        log(
          `[task-observer] maintenance callback failed; continuing task observation: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // D420 (Wave 2 task 2.2.1) — while the durable maintenance state is
    // active, do NOT claim/dispatch new task runs. Already-running runs keep
    // running (they finish on their own); due rows stay `pending` and are
    // claimed on the first tick after maintenance clears. The time-limit
    // watchdog still runs — pausing an overrunning run is lifecycle, not a
    // new start, and must keep working during drain.
    let acceptingWork = false;
    try {
      acceptingWork = await this.resolveGate().isAcceptingWork();
    } catch (err) {
      log(
        `[task-observer] maintenance state read failed; skipping due-task claim (fail closed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!acceptingWork) {
      log("[task-observer] new work is currently gated — skipping due-task claim this tick");
      await this.runTimeLimitWatchdog(now);
      return;
    }

    let due: Awaited<ReturnType<typeof claimDueTasks>>;
    try {
      await resumeReconnectedSecurityResearch(this.db, this.batch);
      due = await claimDueTasks(this.db, now, this.batch);
    } catch (err) {
      // A claim failure (e.g. DB unavailable) is logged and retried next tick
      // rather than crashing the daemon / server boot.
      log(
        `[task-observer] claim failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    for (const task of due) {
      try {
        const outcome = await dispatchTaskRun(task, {
          db: this.db,
          jobManager: this.jobManager,
          ...(this.resolver ? { resolver: this.resolver } : {}),
          ...(this.executionRouteSelector
            ? { executionRouteSelector: this.executionRouteSelector }
            : {}),
          maintenanceGate: this.resolveGate(),
          assertInvocation: this.assertInvocation,
          ...(this.convergeCreatedRoomCatalog
            ? { convergeCreatedRoomCatalog: this.convergeCreatedRoomCatalog }
            : {}),
        });

        if (outcome.kind === "authorization_paused") {
          continue;
        }

        // Recurrence (D8): advance cron rows to the next occurrence in their
        // timezone, clear the fire-lock, keep status `pending`. `now` /
        // `one_shot` rows stay `running` (dispatch set it); their terminal
        // state comes from the run.
        if (task.scheduleKind === "cron" && task.cron) {
          const next = nextCronOccurrence(task.cron, task.timezone, now);
          await rescheduleCron(this.db, task.id, next);
        }
      } catch (err) {
        // A drain can begin between the pre-claim gate and this dispatch
        // attempt. That is retryable admission refusal, not a task error:
        // release only this claim's fire lock so the pending task remains
        // eligible when maintenance returns to normal.
        if (err instanceof MaintenanceDrainError) {
          await updateTask(this.db, task.id, {
            fireLockId: null,
            fireLockedAt: null,
          }).catch(() => {});
          log(`[task-observer] maintenance rejected task=${task.id}; released claim for retry`);
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        log(`[task-observer] dispatch failed for task=${task.id}: ${message}`);
        await reportBackTaskDispatchError(
          { db: this.db },
          { taskId: task.id, error: message },
        ).catch((deliveryError) => {
          log(
            `[task-observer] dispatch failure delivery failed task=${task.id}: ${
              deliveryError instanceof Error
                ? deliveryError.message
                : String(deliveryError)
            }`,
          );
        });
      }
    }

    // M147 (R5) — time-limit watchdog. After the claim/dispatch/recurrence
    // pass, scan running tasks whose active run has overrun its
    // `time_limit_seconds` budget and PAUSE each (D13a: on expiry the run is
    // paused, awaiting explicit unpause/stop — not stopped). Reuses `pauseTask`
    // verbatim (one abort path). A single bad task must not abort the scan.
    await this.runTimeLimitWatchdog(now);
  }

  private async runTimeLimitWatchdog(now: Date): Promise<void> {
    let timedOut: Awaited<ReturnType<typeof findTimedOutRunningTasks>>;
    try {
      timedOut = await findTimedOutRunningTasks(this.db, now);
    } catch (err) {
      log(
        `[task-observer] time-limit scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    for (const { task } of timedOut) {
      try {
        await pauseTask({ db: this.db, jobManager: this.jobManager }, task.id, "time_limit");
        log(`[task-observer] time-limit reached → paused task=${task.id}`);
      } catch (err) {
        log(
          `[task-observer] time-limit pause failed for task=${task.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
