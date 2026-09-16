import type { DirectDatabase } from "@nautilo/db";
import type { AcceptedInvocationAuthority } from "@nautilo/trust";
import type { MaintenanceAcceptanceAuthority } from "../maintenance-controller";
import type { JobExecutor } from "../job";

/**
 * M142 — process-wide DB handle for the task-run executor.
 *
 * The `taskRunExecutor` is invoked by `JobManager` (outside the
 * `TaskObserver`'s call graph), so it cannot receive the observer's injected
 * `db` directly. The observer publishes its handle here on construction; the
 * executor reads it. Tests set it explicitly to point at the test pool. This
 * mirrors the existing module-singleton pattern (`jobManager`,
 * `getSharedDirectDb`) rather than threading a handle through the
 * serialized job input (which is persisted as JSON and must stay
 * handle-free).
 */
let _taskRunDb: DirectDatabase | null = null;

export function setTaskRunDb(db: DirectDatabase | null): void {
  _taskRunDb = db;
}

export function getTaskRunDb(): DirectDatabase {
  if (!_taskRunDb) {
    throw new Error(
      "task-run db handle not set — call setTaskRunDb() (server wiring / test setup) before a task dispatches",
    );
  }
  return _taskRunDb;
}

/**
 * The live `TaskObserver` instance, published by server wiring so that the
 * (M143) `createTask` call sites can `kick()` the running observer for
 * now-tasks. Kept minimal (just `kick`) to avoid an import cycle on the
 * concrete `TaskObserver` type.
 */
let _taskObserver: { kick(): void } | null = null;

export function setTaskObserver(observer: { kick(): void } | null): void {
  _taskObserver = observer;
}

export function getTaskObserver(): { kick(): void } | null {
  return _taskObserver;
}

/**
 * M143 — the live `JobManager`, published by server wiring so the
 * report-back finalizer (called from inside the `taskRunExecutor` generator,
 * which has no `JobManager` reference) can enqueue the wake turn that delivers
 * a completed task's result back into the calling room. Typed as the minimal
 * `createForegroundJob` slice to avoid an import cycle on the concrete
 * `JobManager` class.
 */
export interface TaskRunJobManager {
  createForegroundJob(
    ownerId: string,
    requestorId: string,
    laneKey: string,
    input: Record<string, unknown>,
    executorOverride?: JobExecutor,
    maintenanceAuthority?: MaintenanceAcceptanceAuthority,
    executionRoute?: unknown,
    invocationAuthority?: AcceptedInvocationAuthority,
  ): Promise<{
    id: string;
    virtualJobId: string;
    acceptanceAuthority?: MaintenanceAcceptanceAuthority;
    invocationAcceptanceAuthority?: AcceptedInvocationAuthority;
  }>;
  /** M144 — non-coalesced system turn (report-back wakes must not merge). */
  createSystemForegroundJob(
    ownerId: string,
    requestorId: string,
    laneKey: string,
    input: Record<string, unknown>,
    executorOverride?: JobExecutor,
    maintenanceAuthority?: MaintenanceAcceptanceAuthority,
    executionRoute?: unknown,
    invocationAuthority?: AcceptedInvocationAuthority,
  ): Promise<{
    id: string;
    virtualJobId: string;
    acceptanceAuthority?: MaintenanceAcceptanceAuthority;
    invocationAcceptanceAuthority?: AcceptedInvocationAuthority;
  }>;
}

let _taskRunJobManager: TaskRunJobManager | null = null;

export function setTaskRunJobManager(jm: TaskRunJobManager | null): void {
  _taskRunJobManager = jm;
}

export function getTaskRunJobManager(): TaskRunJobManager | null {
  return _taskRunJobManager;
}
