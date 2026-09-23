import type { MobileTaskDetail as TaskDetail } from "./task-content-mobile";

import type { TaskWorkScope } from "./use-task-work-scope";

export interface TaskDetailTarget extends TaskWorkScope {
  readonly serverUrl: string;
  readonly taskId: string;
}

export interface TaskDetailApi {
  readonly detail: (target: TaskDetailTarget) => Promise<TaskDetail>;
}

export interface TaskDetailState {
  readonly target: TaskDetailTarget | null;
  readonly data: TaskDetail | null;
  readonly loading: boolean;
  /** One intentionally non-specific state for missing, foreign, and revoked Tasks. */
  readonly unavailable: boolean;
  /** A 401 is still hidden detail, but lets the route use the auth recovery path. */
  readonly authRequired: boolean;
  readonly error: Error | null;
}

export type TaskDetailLoadResult =
  | { readonly status: "applied"; readonly data: TaskDetail }
  | { readonly status: "ignored" }
  | { readonly status: "failed"; readonly error: unknown };

export interface TaskDetailController {
  getState(): Readonly<TaskDetailState>;
  subscribe(listener: () => void): () => void;
  setTarget(target: TaskDetailTarget | null): void;
  load(api: TaskDetailApi): Promise<TaskDetailLoadResult>;
  refresh(api: TaskDetailApi): Promise<TaskDetailLoadResult>;
  /**
   * Starts (and awaits) a canonical GET that begins after this call. Unlike a
   * normal refresh, an older in-flight GET cannot satisfy this barrier.
   */
  reconcileAfterMutation(api: TaskDetailApi): Promise<TaskDetailLoadResult>;
  dispose(): void;
}

export interface CreateTaskDetailControllerOptions {
  readonly readDeadlineMs?: number;
  readonly scheduleReadDeadline?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearReadDeadline?: (handle: ReturnType<typeof setTimeout>) => void;
}

const EMPTY_STATE: TaskDetailState = Object.freeze({ target: null, data: null, loading: false, unavailable: false, authRequired: false, error: null });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DETAIL_READ_DEADLINE_MS = 15_000;
class TaskDetailDeadlineError extends Error {
  constructor() { super("Nautilo did not respond. Try again."); }
}

export function isExactTaskId(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function sameTaskDetailTarget(left: TaskDetailTarget | null, right: TaskDetailTarget | null): boolean {
  return left?.serverId === right?.serverId
    && left?.serverUrl === right?.serverUrl
    && left?.userId === right?.userId
    && left?.actorId === right?.actorId
    && left?.viewerEpoch === right?.viewerEpoch
    && left?.taskId === right?.taskId;
}

function httpStatus(error: unknown): number | null {
  return error !== null && typeof error === "object" && "status" in error
    && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Could not load this task.");
}

/**
 * Route-owned reader, not a cache or a Task-list store. Its target is complete
 * enough that a response from another server, identity epoch, or route ID can
 * never become visible. Repeated refreshes coalesce to one in-flight request
 * plus one trailing canonical read.
 */
export function createTaskDetailController(options: CreateTaskDetailControllerOptions = {}): TaskDetailController {
  let disposed = false;
  let generation = 0;
  let state: TaskDetailState = EMPTY_STATE;
  let inFlight: Promise<TaskDetailLoadResult> | null = null;
  let trailingRefresh = false;
  let trailingApi: TaskDetailApi | null = null;
  let reconciliationWaiters: Array<(result: TaskDetailLoadResult) => void> = [];
  const deadlineMs = Number.isFinite(options.readDeadlineMs) && (options.readDeadlineMs ?? 0) > 0
    ? options.readDeadlineMs!
    : DETAIL_READ_DEADLINE_MS;
  const scheduleDeadline = options.scheduleReadDeadline ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearDeadline = options.clearReadDeadline ?? clearTimeout;
  const listeners = new Set<() => void>();
  const emit = (): void => { for (const listener of listeners) listener(); };
  const replace = (next: TaskDetailState): void => { state = next; emit(); };
  const canCommit = (target: TaskDetailTarget, requestGeneration: number): boolean =>
    !disposed && generation === requestGeneration && sameTaskDetailTarget(state.target, target);
  const resolveReconciliationWaiters = (result: TaskDetailLoadResult): void => {
    const waiters = reconciliationWaiters;
    reconciliationWaiters = [];
    for (const resolve of waiters) resolve(result);
  };

  const run = (api: TaskDetailApi, refresh: boolean): Promise<TaskDetailLoadResult> => {
    const target = state.target;
    if (disposed || !target) return Promise.resolve({ status: "ignored" });
    if (!isExactTaskId(target.taskId)) {
      replace({ ...state, data: null, loading: false, unavailable: true, authRequired: false, error: null });
      return Promise.resolve({ status: "ignored" });
    }
    if (inFlight) {
      if (refresh) {
        trailingRefresh = true;
        trailingApi = api;
      }
      return inFlight;
    }
    const requestGeneration = ++generation;
    // Same-target recovery may honestly retain previously verified detail while
    // connectivity is being retried. Identity/ID changes cleared it in setTarget.
    replace({ ...state, loading: true, unavailable: false, authRequired: false, error: null });
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const deadlineBoundary = new Promise<never>((_, reject) => {
      deadline = scheduleDeadline(() => reject(new TaskDetailDeadlineError()), deadlineMs);
    });
    const request = Promise.race([api.detail(target), deadlineBoundary]).then(
      (data): TaskDetailLoadResult => {
        if (!canCommit(target, requestGeneration)) return { status: "ignored" };
        if (data.task.id !== target.taskId) {
          replace({ ...state, data: null, loading: false, unavailable: true, authRequired: false, error: null });
          return { status: "ignored" };
        }
        replace({ ...state, data, loading: false, unavailable: false, authRequired: false, error: null });
        return { status: "applied", data };
      },
      (error: unknown): TaskDetailLoadResult => {
        if (!canCommit(target, requestGeneration)) return { status: "ignored" };
        if (error instanceof TaskDetailDeadlineError) {
          // The actual transport may still resolve. Advance the fence before
          // showing recovery so that late bytes cannot revive this route.
          generation += 1;
          replace({ ...state, loading: false, unavailable: false, authRequired: false, error });
          return { status: "failed", error };
        }
        const status = httpStatus(error);
        if (status === 401 || status === 403 || status === 404) {
          replace({ ...state, data: null, loading: false, unavailable: true, authRequired: status === 401, error: null });
        } else {
          replace({ ...state, loading: false, unavailable: false, error: asError(error) });
        }
        return { status: "failed", error };
      },
    ).finally(() => {
      if (deadline !== null) clearDeadline(deadline);
      if (inFlight !== request) return;
      inFlight = null;
      if (!disposed && trailingRefresh && state.target && sameTaskDetailTarget(state.target, target)) {
        trailingRefresh = false;
        const trailing = run(trailingApi ?? api, false);
        trailingApi = null;
        if (reconciliationWaiters.length > 0) {
          void trailing.then(resolveReconciliationWaiters);
        }
      } else {
        trailingRefresh = false;
        trailingApi = null;
      }
    });
    inFlight = request;
    return request;
  };

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setTarget(target) {
      if (sameTaskDetailTarget(state.target, target)) return;
      generation += 1;
      // Detach the prior target's request before exposing the new target. Its
      // completion is generation-fenced, while the new ID can start at once.
      inFlight = null;
      trailingRefresh = false;
      trailingApi = null;
      resolveReconciliationWaiters({ status: "ignored" });
      // A locator is never data: switching any authority or ID drops detail
      // synchronously before an old fetch can settle.
      replace(target && isExactTaskId(target.taskId)
        ? { target, data: null, loading: false, unavailable: false, authRequired: false, error: null }
        : { target, data: null, loading: false, unavailable: target !== null, authRequired: false, error: null });
    },
    load(api) { return run(api, false); },
    refresh(api) { return run(api, true); },
    reconcileAfterMutation(api) {
      const target = state.target;
      if (disposed || !target) return Promise.resolve({ status: "ignored" });
      // A fresh request started here is necessarily post-boundary. When a
      // read was already underway, reserve exactly one trailing request and
      // await that request rather than treating the old result as authority.
      if (!inFlight) return run(api, false);
      trailingRefresh = true;
      trailingApi = api;
      return new Promise<TaskDetailLoadResult>((resolve) => {
        reconciliationWaiters.push(resolve);
      });
    },
    dispose() {
      disposed = true;
      generation += 1;
      trailingRefresh = false;
      trailingApi = null;
      inFlight = null;
      resolveReconciliationWaiters({ status: "ignored" });
      listeners.clear();
      state = EMPTY_STATE;
    },
  };
}
