import type { TaskLifecycleResponse } from "@nautilo/types";

import {
  sameTaskDetailTarget,
  type TaskDetailLoadResult,
  type TaskDetailTarget,
} from "./task-detail-state";

export type TaskLifecycleAction = "pause" | "resume" | "stop";
export type TaskLifecyclePhase = "idle" | "requesting" | "reconciling" | "recovery-required";

export interface TaskDetailLifecycleState {
  readonly target: TaskDetailTarget | null;
  readonly phase: TaskLifecyclePhase;
  readonly action: TaskLifecycleAction | null;
  readonly error: string | null;
  readonly notice: string | null;
}

export interface TaskDetailLifecycleApi {
  readonly pause: (target: TaskDetailTarget) => Promise<TaskLifecycleResponse>;
  readonly resume: (target: TaskDetailTarget) => Promise<TaskLifecycleResponse>;
  readonly stop: (target: TaskDetailTarget) => Promise<TaskLifecycleResponse>;
  /** A Task-detail GET guaranteed to begin after the lifecycle POST boundary. */
  readonly reconcile: (target: TaskDetailTarget) => Promise<TaskDetailLoadResult>;
}

export interface TaskDetailLifecycleController {
  getState(): Readonly<TaskDetailLifecycleState>;
  subscribe(listener: () => void): () => void;
  setTarget(target: TaskDetailTarget | null): void;
  act(action: TaskLifecycleAction, canonicalStatus: string | null, api: TaskDetailLifecycleApi): Promise<TaskDetailLoadResult>;
  reload(api: TaskDetailLifecycleApi): Promise<TaskDetailLoadResult>;
  /** Lets later canonical detail/realtime refreshes clear a safe recovery fence. */
  observeCanonical(status: string | null): void;
  dispose(): void;
}

export interface CreateTaskDetailLifecycleControllerOptions {
  readonly requestDeadlineMs?: number;
  readonly scheduleRequestDeadline?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearRequestDeadline?: (handle: ReturnType<typeof setTimeout>) => void;
}

const EMPTY_STATE: TaskDetailLifecycleState = Object.freeze({ target: null, phase: "idle", action: null, error: null, notice: null });
const REQUEST_DEADLINE_MS = 15_000;

class TaskLifecycleRequestDeadlineError extends Error {
  constructor() { super("Nautilo did not confirm that change. The current task status was reloaded."); }
}

class TaskLifecycleReceiptError extends Error {
  constructor() { super("Nautilo returned an invalid task response."); }
}

/** The only detail actions the locked product contract presents. */
export function taskDetailLifecycleActions(status: string | null | undefined): readonly TaskLifecycleAction[] {
  if (status === "running") return ["pause", "stop"];
  if (status === "paused") return ["resume", "stop"];
  return [];
}

function expectedStatus(action: TaskLifecycleAction): string {
  return action === "pause" ? "paused" : action === "resume" ? "pending" : "cancelled";
}

function messageFor(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Could not update this task.";
}

function hasHttpResponse(error: unknown): boolean {
  return error !== null && typeof error === "object" && "status" in error
    && typeof (error as { status?: unknown }).status === "number";
}

function isTerminal(status: string | null): boolean {
  return status === "completed" || status === "cancelled" || status === "errored";
}

function settlesUncertainAction(action: TaskLifecycleAction | null, status: string | null): boolean {
  if (isTerminal(status)) return true;
  if (action === "pause") return status === "paused";
  if (action === "resume") return status === "pending" || status === "running";
  return false;
}

/**
 * Keeps lifecycle intent deliberately smaller than Task detail itself. POST
 * receipts never modify visible Task data: a post-boundary canonical GET is
 * the only success authority, including after timeout or a race with realtime.
 */
export function createTaskDetailLifecycleController(
  options: CreateTaskDetailLifecycleControllerOptions = {},
): TaskDetailLifecycleController {
  let disposed = false;
  let generation = 0;
  let state: TaskDetailLifecycleState = EMPTY_STATE;
  let recoveryAction: TaskLifecycleAction | null = null;
  let recoveryIsUncertain = false;
  const listeners = new Set<() => void>();
  const deadlineMs = Number.isFinite(options.requestDeadlineMs) && (options.requestDeadlineMs ?? 0) > 0
    ? options.requestDeadlineMs!
    : REQUEST_DEADLINE_MS;
  const scheduleDeadline = options.scheduleRequestDeadline ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearDeadline = options.clearRequestDeadline ?? clearTimeout;
  const emit = (): void => { for (const listener of listeners) listener(); };
  const replace = (next: TaskDetailLifecycleState): void => { state = next; emit(); };
  const current = (target: TaskDetailTarget, requestGeneration: number): boolean =>
    !disposed && generation === requestGeneration && sameTaskDetailTarget(state.target, target);

  const reconcile = async (
    target: TaskDetailTarget,
    requestGeneration: number,
    api: TaskDetailLifecycleApi,
    postError: unknown,
    receipt: TaskLifecycleResponse | null,
    action: TaskLifecycleAction | null,
    postBoundaryUncertain: boolean,
  ): Promise<TaskDetailLoadResult> => {
    if (!current(target, requestGeneration)) return { status: "ignored" };
    replace({ ...state, phase: "reconciling", error: null });
    const result = await api.reconcile(target);
    if (!current(target, requestGeneration)) return { status: "ignored" };
    if (result.status === "applied") {
      if (postBoundaryUncertain && !settlesUncertainAction(action, result.data.task.status)) {
        recoveryAction = action;
        recoveryIsUncertain = true;
        replace({
          ...state,
          phase: "recovery-required",
          error: "Nautilo could not confirm whether that change reached the server. Reload task before trying again.",
          notice: null,
        });
        return result;
      }
      const receiptLost = receipt !== null && action !== null && receipt.status !== expectedStatus(action);
      recoveryAction = null;
      recoveryIsUncertain = false;
      replace({
        ...state,
        phase: "idle",
        action: null,
        error: postError === null ? null : `${messageFor(postError)} The current task status is shown.`,
        notice: receiptLost ? receipt.message : null,
      });
      return result;
    }
    // The Task reader owns non-leaking 401/403/404 presentation. Preserve
    // that route boundary while keeping POSTs fenced until a GET succeeds.
    replace({
      ...state,
      phase: "recovery-required",
      error: "Could not confirm the current task status. Reload task before trying again.",
      notice: null,
    });
    recoveryAction = action;
    recoveryIsUncertain = postBoundaryUncertain;
    return result;
  };

  const act = async (
    action: TaskLifecycleAction,
    canonicalStatus: string | null,
    api: TaskDetailLifecycleApi,
  ): Promise<TaskDetailLoadResult> => {
    const target = state.target;
    if (!target || state.phase !== "idle" || !taskDetailLifecycleActions(canonicalStatus).includes(action)) {
      return { status: "ignored" };
    }
    const requestGeneration = ++generation;
    replace({ ...state, phase: "requesting", action, error: null, notice: null });
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const deadlineBoundary = new Promise<never>((_, reject) => {
      deadline = scheduleDeadline(() => reject(new TaskLifecycleRequestDeadlineError()), deadlineMs);
    });
    let receipt: TaskLifecycleResponse | null = null;
    let postError: unknown = null;
    try {
      const post = action === "pause" ? api.pause(target)
        : action === "resume" ? api.resume(target)
          : api.stop(target);
      receipt = await Promise.race([post, deadlineBoundary]);
      if (receipt.taskId !== target.taskId) {
        postError = new TaskLifecycleReceiptError();
        receipt = null;
      }
    } catch (error) {
      postError = error;
    } finally {
      if (deadline !== null) clearDeadline(deadline);
    }
    return reconcile(target, requestGeneration, api, postError, receipt, action, postError !== null && !hasHttpResponse(postError));
  };

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setTarget(target) {
      if (sameTaskDetailTarget(state.target, target)) return;
      generation += 1;
      recoveryAction = null;
      recoveryIsUncertain = false;
      replace(target ? { target, phase: "idle", action: null, error: null, notice: null } : EMPTY_STATE);
    },
    act,
    async reload(api) {
      const target = state.target;
      if (!target || state.phase !== "recovery-required") return { status: "ignored" };
      const requestGeneration = ++generation;
      return reconcile(target, requestGeneration, api, null, null, recoveryAction, recoveryIsUncertain);
    },
    observeCanonical(status) {
      if (state.phase !== "recovery-required" || (recoveryIsUncertain && !settlesUncertainAction(recoveryAction, status))) return;
      recoveryAction = null;
      recoveryIsUncertain = false;
      replace({ ...state, phase: "idle", action: null, error: null, notice: null });
    },
    dispose() {
      disposed = true;
      generation += 1;
      listeners.clear();
      recoveryAction = null;
      recoveryIsUncertain = false;
      state = EMPTY_STATE;
    },
  };
}
