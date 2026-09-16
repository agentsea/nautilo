import { isExactTaskId, sameTaskDetailTarget, type TaskDetailTarget } from "./task-detail-state";
import { normalizeTaskPresentationStatus } from "@nautilo/types";

/**
 * `targetRoomId` is only a locator carried by the owner-scoped Task response.
 * This route-owned coordinator turns it into a navigation target only after
 * the normal member Room read and a fresh session identity check agree.
 */
export interface TaskRoomHandoffTarget extends TaskDetailTarget {
  readonly targetRoomId: string;
}

export interface TaskRoomHandoffApi {
  /** Existing member-authorized Room read. The controller retains its ID only. */
  readonly getRoom: (target: TaskRoomHandoffTarget) => Promise<{ readonly id: string }>;
  /** Fresh authenticated identity check after the Room read. */
  readonly whoami: (target: TaskRoomHandoffTarget) => Promise<{
    readonly sessionUserId: string | null;
    readonly sessionActorId: string | null;
  }>;
}

export type TaskRoomHandoffPhase = "idle" | "checking" | "opening" | "authorized" | "unavailable";

export interface TaskRoomHandoffState {
  readonly target: TaskRoomHandoffTarget | null;
  readonly phase: TaskRoomHandoffPhase;
  /** Generic recovery copy only; never preserve Room-derived bytes here. */
  readonly error: string | null;
}

export type TaskRoomHandoffResult =
  | { readonly status: "navigate"; readonly target: TaskRoomHandoffTarget }
  | { readonly status: "ignored" }
  | { readonly status: "unavailable" };

export interface TaskRoomHandoffController {
  getState(): Readonly<TaskRoomHandoffState>;
  subscribe(listener: () => void): () => void;
  /** Changes synchronously erase prior availability and fence late responses. */
  setTarget(target: TaskRoomHandoffTarget | null): void;
  /** Silent availability probe for the current exact Task detail. */
  authorize(api: TaskRoomHandoffApi): Promise<TaskRoomHandoffResult>;
  /** Fresh preflight immediately before navigation; one request at a time. */
  open(api: TaskRoomHandoffApi): Promise<TaskRoomHandoffResult>;
  /** Must be checked synchronously adjacent to the router call. */
  mayNavigate(target: TaskRoomHandoffTarget): boolean;
  /** Router failures keep an already authorized button retryable. */
  reportNavigationFailure(): void;
  dispose(): void;
}

const EMPTY_STATE: TaskRoomHandoffState = Object.freeze({ target: null, phase: "idle", error: null });

export function sameTaskRoomHandoffTarget(
  left: TaskRoomHandoffTarget | null,
  right: TaskRoomHandoffTarget | null,
): boolean {
  return sameTaskDetailTarget(left, right) && left?.targetRoomId === right?.targetRoomId;
}

/** Pure eligibility gate shared by the native and Mobile Web route binding. */
export function taskRoomHandoffTarget(input: {
  readonly detailTarget: TaskDetailTarget | null;
  readonly taskStatus: string | null;
  readonly targetRoomId: string | null | undefined;
  readonly attentionPending: boolean;
}): TaskRoomHandoffTarget | null {
  return input.detailTarget !== null
    && normalizeTaskPresentationStatus(input.taskStatus ?? "") === "awaiting"
    && isExactTaskId(input.targetRoomId)
    && !input.attentionPending
    ? { ...input.detailTarget, targetRoomId: input.targetRoomId }
    : null;
}

function isUsableTarget(target: TaskRoomHandoffTarget | null): target is TaskRoomHandoffTarget {
  return target !== null && isExactTaskId(target.taskId) && isExactTaskId(target.targetRoomId);
}

/**
 * This is deliberately not a Room cache: it keeps only a scoped boolean and
 * exact UUID. `getRoom` remains the member-authorization authority, while
 * `whoami` catches a session change between the Task read and handoff.
 */
export function createTaskRoomHandoffController(): TaskRoomHandoffController {
  let disposed = false;
  let generation = 0;
  let state: TaskRoomHandoffState = EMPTY_STATE;
  let inFlight: Promise<TaskRoomHandoffResult> | null = null;
  const listeners = new Set<() => void>();
  const emit = (): void => { for (const listener of listeners) listener(); };
  const replace = (next: TaskRoomHandoffState): void => { state = next; emit(); };
  const current = (target: TaskRoomHandoffTarget, requestGeneration: number): boolean =>
    !disposed && generation === requestGeneration && sameTaskRoomHandoffTarget(state.target, target);

  const run = (api: TaskRoomHandoffApi, revealFailure: boolean): Promise<TaskRoomHandoffResult> => {
    const target = state.target;
    if (!isUsableTarget(target) || state.phase === "checking") return Promise.resolve({ status: "ignored" });
    const requestGeneration = ++generation;
    replace({ target, phase: revealFailure ? "opening" : "checking", error: null });
    const request = (async (): Promise<TaskRoomHandoffResult> => {
      try {
        const room = await api.getRoom(target);
        if (!current(target, requestGeneration)) return { status: "ignored" };
        const viewer = await api.whoami(target);
        if (!current(target, requestGeneration)) return { status: "ignored" };
        const authorized = room.id === target.targetRoomId
          && viewer.sessionUserId === target.userId
          && viewer.sessionActorId === target.actorId;
        if (!authorized) {
          replace({ target, phase: "unavailable", error: revealFailure ? "Room unavailable." : null });
          return { status: "unavailable" };
        }
        replace({ target, phase: "authorized", error: null });
        return { status: "navigate", target };
      } catch {
        if (!current(target, requestGeneration)) return { status: "ignored" };
        replace({ target, phase: "unavailable", error: revealFailure ? "Room unavailable." : null });
        return { status: "unavailable" };
      }
    })().finally(() => {
      if (inFlight === request) inFlight = null;
    });
    inFlight = request;
    return request;
  };

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setTarget(target) {
      if (sameTaskRoomHandoffTarget(state.target, target)) return;
      generation += 1;
      inFlight = null;
      replace(isUsableTarget(target) ? { target, phase: "idle", error: null } : EMPTY_STATE);
    },
    authorize(api) {
      if (state.phase !== "idle") return Promise.resolve({ status: "ignored" });
      return run(api, false);
    },
    open(api) {
      if (state.phase !== "authorized") return Promise.resolve({ status: "ignored" });
      return run(api, true);
    },
    mayNavigate(target) {
      return !disposed && state.phase === "authorized" && sameTaskRoomHandoffTarget(state.target, target);
    },
    reportNavigationFailure() {
      if (state.target && state.phase === "authorized") {
        replace({ ...state, error: "Room unavailable." });
      }
    },
    dispose() {
      disposed = true;
      generation += 1;
      inFlight = null;
      listeners.clear();
      state = EMPTY_STATE;
    },
  };
}
