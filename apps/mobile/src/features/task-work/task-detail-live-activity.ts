import {
  normalizeTaskPresentationStatus, projectTaskTranscriptToolArgs,
  projectTaskTranscriptToolResult, taskPresentationActivityText,
  type ServerEvent, type TaskHarnessActivity, type TaskPresentationStatus,
} from "@nautilo/types";

export interface TaskDetailLiveActivityTarget {
  readonly serverId: string; readonly serverUrl: string; readonly userId: string;
  readonly actorId: string; readonly viewerEpoch: number; readonly taskId: string;
}
export interface TaskDetailHarnessActivity {
  readonly id: string; readonly kind: TaskHarnessActivity["kind"];
  readonly name: string; readonly status: TaskHarnessActivity["status"];
  readonly args: Record<string, unknown>; readonly result?: string; readonly startedAt: number;
}
type ReconciliationPhase = "idle" | "initial-requested" | "trailing-requested";

/** A phase belongs to one live revision; a distinct fire always starts a new one. */
export interface TaskDetailLiveActivityState {
  readonly target: TaskDetailLiveActivityTarget | null; readonly taskRunId: string | null;
  readonly terminalTaskRunId: string | null; readonly progress: string | null;
  readonly status: TaskPresentationStatus | null; readonly activity: TaskDetailHarnessActivity | null;
  /** True only after an owner-scoped human-reply interrupt for this live revision. */
  readonly awaitingReply: boolean;
  readonly retiredRunIds: readonly string[];
  readonly reconciliationPhase: ReconciliationPhase;
  /** Exact canonical identity this revision needs before it is settled. */
  readonly desiredRunId: string | null;
  /** Run status when desiredRunId is set; Task status for runless lifecycle. */
  readonly desiredStatus: TaskPresentationStatus | null;
  /** Distinguishes a canonical pending/unknown Task lifecycle from idle. */
  readonly hasDesiredTaskStatus: boolean;
}
const EMPTY_TASK_DETAIL_LIVE_ACTIVITY: TaskDetailLiveActivityState = Object.freeze({
  target: null, taskRunId: null, terminalTaskRunId: null, progress: null, activity: null, status: null,
  awaitingReply: false, retiredRunIds: [], reconciliationPhase: "idle", desiredRunId: null, desiredStatus: null, hasDesiredTaskStatus: false,
});
export interface TaskDetailLiveActivityController {
  getState(): Readonly<TaskDetailLiveActivityState>; subscribe(listener: () => void): () => void;
  setTarget(target: TaskDetailLiveActivityTarget | null): void;
  /** True asks the route for one coalesced canonical read. */
  seedCanonical(input: { taskStatus: string; latestRun: { id: string; status: string } | null }): boolean;
  apply(event: ServerEvent, sourceTarget: TaskDetailLiveActivityTarget): boolean;
  clearProvisional(): void; dispose(): void;
}
export function sameTaskDetailLiveActivityTarget(a: TaskDetailLiveActivityTarget | null, b: TaskDetailLiveActivityTarget | null): boolean {
  return a?.serverId === b?.serverId && a?.serverUrl === b?.serverUrl && a?.userId === b?.userId
    && a?.actorId === b?.actorId && a?.viewerEpoch === b?.viewerEpoch && a?.taskId === b?.taskId;
}
function safeName(name: string): string { return name.length <= 256 ? name : `${name.slice(0, 255)}…`; }
function isTerminal(status: TaskPresentationStatus | null): boolean { return status === "done" || status === "errored"; }
function retire(ids: readonly string[], id: string | null): readonly string[] {
  return id === null ? ids : [...ids.filter((value) => value !== id), id].slice(-8);
}
function projectActivity(activity: TaskHarnessActivity, prior: TaskDetailHarnessActivity | null): TaskDetailHarnessActivity {
  // Only a same-ID provider-neutral frame can inherit arguments/result bytes.
  const sameActivity = prior !== null && prior.id === activity.id;
  const nextResult = projectTaskTranscriptToolResult(activity.result);
  const result = activity.appendResult && sameActivity && prior.result !== undefined && nextResult !== undefined
    ? projectTaskTranscriptToolResult(`${prior.result}${activity.appendResultSeparator ?? "\n"}${nextResult}`)
    : nextResult === undefined && sameActivity ? prior.result : nextResult;
  return {
    id: activity.id, kind: activity.kind, name: safeName(activity.name), status: activity.status,
    args: Object.keys(activity.args).length === 0 && sameActivity ? prior.args : projectTaskTranscriptToolArgs(activity.args),
    startedAt: sameActivity ? prior.startedAt : activity.startedAt,
    ...(result === undefined ? {} : { result }),
  };
}

export function createTaskDetailLiveActivityController(): TaskDetailLiveActivityController {
  let disposed = false;
  let state: TaskDetailLiveActivityState = EMPTY_TASK_DETAIL_LIVE_ACTIVITY;
  const listeners = new Set<() => void>();
  const emit = (): void => { for (const listener of listeners) listener(); };
  const replace = (next: TaskDetailLiveActivityState): void => { state = next; emit(); };
  const exact = (event: ServerEvent): boolean => state.target !== null && "ownerId" in event && event.ownerId === state.target.userId
    && "taskId" in event && event.taskId === state.target.taskId;
  const sameDesired = (runId: string | null, status: TaskPresentationStatus | null, hasTaskStatus: boolean): boolean =>
    state.desiredRunId === runId && state.desiredStatus === status && state.hasDesiredTaskStatus === hasTaskStatus;
  /** At most initial + one meaningful trailing repair per live revision. */
  const request = (
    patch: Partial<TaskDetailLiveActivityState>,
    desiredRunId: string | null,
    desiredStatus: TaskPresentationStatus | null,
    allowSameDesired = false,
    hasTaskStatus = false,
  ): boolean => {
    // The trailing phase limits reads, not live truth. Keep applying the
    // newest exact lifecycle patch (especially a terminal latch) while the
    // route's one trailing request is already queued.
    if (state.reconciliationPhase === "trailing-requested") {
      replace({ ...state, ...patch, desiredRunId, desiredStatus, hasDesiredTaskStatus: hasTaskStatus });
      return false;
    }
    if (!allowSameDesired && sameDesired(desiredRunId, desiredStatus, hasTaskStatus)) {
      if (Object.keys(patch).length > 0) replace({ ...state, ...patch });
      return false;
    }
    const phase: ReconciliationPhase = state.reconciliationPhase === "idle" ? "initial-requested" : "trailing-requested";
    replace({ ...state, ...patch, reconciliationPhase: phase, desiredRunId, desiredStatus, hasDesiredTaskStatus: hasTaskStatus });
    return true;
  };
  const startRevision = (runId: string): boolean => {
    replace({ ...state, taskRunId: runId, terminalTaskRunId: null, progress: null, activity: null, status: "running", awaitingReply: false,
      retiredRunIds: retire(state.retiredRunIds, state.taskRunId),
      reconciliationPhase: "initial-requested", desiredRunId: runId, desiredStatus: "running", hasDesiredTaskStatus: false });
    return true;
  };

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setTarget(target) {
      if (!disposed && !sameTaskDetailLiveActivityTarget(state.target, target)) {
        replace(target ? { ...EMPTY_TASK_DETAIL_LIVE_ACTIVITY, target } : EMPTY_TASK_DETAIL_LIVE_ACTIVITY);
      }
    },
    seedCanonical({ taskStatus, latestRun }) {
      if (disposed || state.target === null) return false;
      const canonicalTaskStatus = normalizeTaskPresentationStatus(taskStatus);
      const canonicalRunStatus = latestRun ? normalizeTaskPresentationStatus(latestRun.status) : null;
      const desiredSatisfied = state.desiredRunId !== null
        ? latestRun?.id === state.desiredRunId && (state.desiredStatus === null || canonicalRunStatus === state.desiredStatus)
        : !state.hasDesiredTaskStatus || canonicalTaskStatus === state.desiredStatus;
      const staleRetired = latestRun !== null && latestRun.id !== state.taskRunId && state.retiredRunIds.includes(latestRun.id);
      const sameRunBehindLive = latestRun !== null && latestRun.id === state.taskRunId && (
        (state.terminalTaskRunId === latestRun.id && !isTerminal(canonicalRunStatus))
        || (state.status === "awaiting" && canonicalRunStatus !== "awaiting")
      );
      // A runless lifecycle is reconciled against the Task status, never the
      // current run. A stale detail response must not reset its one-shot
      // desired status and turn repeated WS bytes into polling again.
      const staleRunlessStatus = state.desiredRunId === null && state.hasDesiredTaskStatus
        && canonicalTaskStatus !== state.desiredStatus;
      // A desired run is stale only when this response is still for the
      // current predecessor (or has no run). A third, non-retired run is a
      // genuinely newer canonical identity and must retire the current one.
      const staleDesiredRun = state.desiredRunId !== null && (
        latestRun === null || (latestRun.id === state.taskRunId && latestRun.id !== state.desiredRunId)
      );
      if (!desiredSatisfied && (staleRetired || sameRunBehindLive || staleRunlessStatus || staleDesiredRun)) {
        return request({}, state.desiredRunId, state.desiredStatus, true, state.hasDesiredTaskStatus);
      }
      // A non-retired distinct canonical latest run is newer and authoritative.
      if (latestRun !== null && latestRun.id !== state.taskRunId) {
        if (!state.retiredRunIds.includes(latestRun.id)) {
          replace({ ...state, taskRunId: latestRun.id, terminalTaskRunId: isTerminal(canonicalRunStatus) ? latestRun.id : null,
            progress: null, activity: null, status: canonicalTaskStatus, awaitingReply: false,
            retiredRunIds: retire(
              retire(state.retiredRunIds, state.taskRunId),
              state.desiredRunId === latestRun.id ? null : state.desiredRunId,
            ),
            reconciliationPhase: "idle", desiredRunId: null, desiredStatus: null, hasDesiredTaskStatus: false });
          return false;
        }
      }
      if (desiredSatisfied || state.reconciliationPhase !== "idle") {
        replace({ ...state, taskRunId: latestRun?.id ?? state.taskRunId,
          terminalTaskRunId: latestRun && isTerminal(canonicalRunStatus) ? latestRun.id : state.terminalTaskRunId,
          progress: isTerminal(canonicalRunStatus) ? null : state.progress,
          activity: isTerminal(canonicalRunStatus) ? null : state.activity,
          // The Task is the canonical lifecycle authority. The latest run is
          // only an identity/terminal fence, so a recurring pending Task does
          // not render its previous terminal run forever.
          status: canonicalTaskStatus,
          awaitingReply: canonicalTaskStatus === "awaiting" && state.awaitingReply,
          reconciliationPhase: "idle", desiredRunId: null, desiredStatus: null, hasDesiredTaskStatus: false });
      } else if (latestRun === null) {
        replace({ ...state, progress: null, activity: null, status: canonicalTaskStatus, awaitingReply: canonicalTaskStatus === "awaiting" && state.awaitingReply });
      }
      return false;
    },
    apply(event, sourceTarget) {
      if (disposed || !sameTaskDetailLiveActivityTarget(state.target, sourceTarget) || !exact(event)) return false;
      if (event.type === "task.fired") {
        if (event.taskRunId === state.taskRunId || state.retiredRunIds.includes(event.taskRunId)) return false;
        return startRevision(event.taskRunId);
      }
      if (event.type === "task.progress") {
        if (event.taskRunId === state.taskRunId && state.terminalTaskRunId === null) {
          replace({ ...state, progress: event.detail, status: "running", awaitingReply: false, activity: event.activity ? projectActivity(event.activity, state.activity) : state.activity });
          return false;
        }
        if (state.retiredRunIds.includes(event.taskRunId)) return false;
        return request({}, event.taskRunId, null);
      }
      if (event.type === "task.awaiting_reply") {
        const runId = event.taskRunId ?? null;
        if (runId !== null && runId === state.taskRunId && state.terminalTaskRunId === null) {
          if (state.status === "awaiting" && state.awaitingReply) return false;
          return request({ progress: null, activity: null, status: "awaiting", awaitingReply: true }, runId, "awaiting");
        }
        if (runId !== null && state.retiredRunIds.includes(runId)) return false;
        return request({ awaitingReply: true }, runId, "awaiting", false, runId === null);
      }
      if (event.type === "task.completed" || event.type === "task.errored") {
        const terminalStatus: TaskPresentationStatus = event.type === "task.completed" ? "done" : "errored";
        if (event.taskRunId === state.taskRunId && state.terminalTaskRunId === null) {
          return request({ terminalTaskRunId: event.taskRunId, progress: null, activity: null, status: terminalStatus, awaitingReply: false,
            retiredRunIds: retire(state.retiredRunIds, event.taskRunId) }, event.taskRunId, terminalStatus);
        }
        if (state.terminalTaskRunId === event.taskRunId || state.retiredRunIds.includes(event.taskRunId)) return false;
        return request({}, event.taskRunId, terminalStatus);
      }
      if (event.type === "task.status") {
        const desiredStatus = normalizeTaskPresentationStatus(event.status);
        // Runless lifecycle never rewrites an established run locally.
        return request({ progress: null, activity: null, status: state.taskRunId ? state.status : desiredStatus, awaitingReply: desiredStatus === "awaiting" && state.awaitingReply }, null, desiredStatus, false, true);
      }
      return false;
    },
    clearProvisional() {
      if (!disposed && state.target) replace({ ...state, progress: null, activity: null, status: state.terminalTaskRunId ? state.status : null, awaitingReply: false });
    },
    dispose() { disposed = true; state = EMPTY_TASK_DETAIL_LIVE_ACTIVITY; listeners.clear(); },
  };
}
export function taskDetailLiveActivityText(state: Pick<TaskDetailLiveActivityState, "progress" | "status" | "awaitingReply">, canonicalTaskStatus: string): string {
  const status = state.status ?? normalizeTaskPresentationStatus(canonicalTaskStatus);
  if (status === "awaiting") return state.awaitingReply ? "Waiting for your reply" : taskPresentationActivityText(status, null);
  return status === null ? "No current activity." : taskPresentationActivityText(status, state.progress);
}
