import {
  TASK_PRESENTATION_TERMINAL_LINGER_MS,
  isTerminalTaskPresentationStatus,
  normalizeTaskPresentationStatus,
  parseTaskPresentationTimestamp,
  sortTaskPresentationItems,
  taskPresentationActivityText,
  type TaskPresentationStatus,
} from "@nautilo/types";
import type { ServerEvent, TaskSummary } from "@nautilo/types";

import type { TaskWorkScope } from "./use-task-work-scope";
export type { TaskWorkScope } from "./use-task-work-scope";

/**
 * The authenticated owner/server identity which owns this one in-memory Task
 * surface. Reusing the established settings scope prevents a server-only cache
 * key from showing one Human's work to another Human on that same server.
 */
export type TaskWorkLoadResult =
  | { status: "applied"; data: readonly TaskSummary[] }
  | { status: "ignored" }
  | { status: "failed"; error: unknown };

export type TaskWorkStateKind = "idle" | "loading" | "ready" | "error" | "unsupported";

export interface TaskWorkState {
  readonly kind: TaskWorkStateKind;
  readonly scope: TaskWorkScope | null;
  /** The canonical, owner-scoped bounded Task list. It is never persisted. */
  readonly tasks: readonly TaskSummary[];
  readonly error: Error | null;
  /**
   * Reserved for the process-local realtime overlay added in 2.2. It starts
   * empty: loading itself must not infer activity from a transcript or prompt.
   */
  readonly overlays: Readonly<Record<string, TaskWorkOverlay>>;
}

/** A future realtime overlay, intentionally separate from canonical API rows. */
export interface TaskWorkOverlay {
  readonly status?: TaskPresentationStatus;
  /** The active run whose progress this overlay may present. */
  readonly taskRunId?: string;
  /** A terminal receipt latches this Task until a distinct `task.fired` run. */
  readonly terminalTaskRunId?: string | null;
  /** Exact `task.progress.detail`; an empty string is still exact progress. */
  readonly progress?: string;
  /** Local receipt time for the terminal linger window, when a live event supplies one. */
  readonly terminalAtMs?: number;
}

export interface TaskWorkApi {
  list(scope: TaskWorkScope): Promise<TaskSummary[]>;
}

export interface TaskWorkController {
  getState(): Readonly<TaskWorkState>;
  subscribe(listener: () => void): () => void;
  /** Server, viewer, logout, and capability changes erase this controller's custody. */
  setScope(scope: TaskWorkScope | null): void;
  /** Route teardown invalidates every request completion forever. */
  dispose(): void;
  load(api: TaskWorkApi): Promise<TaskWorkLoadResult>;
  retry(api: TaskWorkApi): Promise<TaskWorkLoadResult>;
  /** Apply one owner-scoped Task event; unknown rows reconcile once via the canonical API. */
  applyRealtimeEvent(event: ServerEvent, api: TaskWorkApi): void;
  /** Reconnect/foreground repair: no synthetic activity survives the boundary. */
  discardProvisionalProgress(): void;
  /** A single-flight canonical repair that never discards newer live events. */
  reconcile(api: TaskWorkApi, options?: { resetLive?: boolean }): Promise<TaskWorkLoadResult>;
}

export interface CreateTaskWorkControllerOptions {
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface PendingUnknownTaskRefresh {
  readonly revision: number;
  /** A burst gets its initial repair plus at most one post-snapshot repair. */
  readonly trailingUsed: boolean;
}

export interface TaskWorkRow {
  readonly task: TaskSummary;
  readonly taskId: string;
  readonly parentTaskId: string | null;
  readonly depth: number;
  readonly status: TaskPresentationStatus;
  readonly startedAtMs: number;
  readonly terminalAtMs: number | null;
  /** Exact progress when present, otherwise fixed shared lifecycle text. */
  readonly activity: string;
}

export interface TaskWorkSelectors {
  /** Every current, server-presentable row for the later overview. */
  readonly overviewRows: readonly TaskWorkRow[];
  /** Awaiting Tasks and newly-terminal errors, in shared Task priority order. */
  readonly actionNeeded: readonly TaskWorkRow[];
  readonly active: readonly TaskWorkRow[];
  readonly paused: readonly TaskWorkRow[];
  /** Server-bounded terminal history for the later overview. */
  readonly terminalHistory: readonly TaskWorkRow[];
  /** Terminal rows still within the short, shared top-strip linger window. */
  readonly newlyCompleted: readonly TaskWorkRow[];
  /** Rows relevant to the compact strip right now. */
  readonly topRows: readonly TaskWorkRow[];
  /** A quiet strip has no relevant row, spacer, or hidden target to render. */
  readonly quiet: boolean;
}

export type TaskWorkViewState =
  | { readonly kind: "idle"; readonly scope: null; readonly selectors: TaskWorkSelectors }
  | { readonly kind: "loading"; readonly scope: TaskWorkScope; readonly selectors: TaskWorkSelectors }
  | { readonly kind: "ready"; readonly scope: TaskWorkScope; readonly selectors: TaskWorkSelectors }
  | { readonly kind: "empty"; readonly scope: TaskWorkScope; readonly selectors: TaskWorkSelectors }
  | { readonly kind: "error"; readonly scope: TaskWorkScope; readonly selectors: TaskWorkSelectors; readonly error: Error }
  | { readonly kind: "unsupported"; readonly scope: TaskWorkScope; readonly selectors: TaskWorkSelectors };

const EMPTY_SELECTORS: TaskWorkSelectors = Object.freeze({
  overviewRows: Object.freeze([]),
  actionNeeded: Object.freeze([]),
  active: Object.freeze([]),
  paused: Object.freeze([]),
  terminalHistory: Object.freeze([]),
  newlyCompleted: Object.freeze([]),
  topRows: Object.freeze([]),
  quiet: true,
});

function emptyState(scope: TaskWorkScope | null): TaskWorkState {
  return {
    kind: "idle",
    scope,
    tasks: [],
    error: null,
    overlays: {},
  };
}

function sameTaskWorkScope(left: TaskWorkScope | null, right: TaskWorkScope | null): boolean {
  return left?.serverId === right?.serverId
    && left?.userId === right?.userId
    && left?.actorId === right?.actorId
    && left?.viewerEpoch === right?.viewerEpoch;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Could not load delegated work.");
}

function isUnsupportedTaskApi(error: unknown): boolean {
  const status = error !== null && typeof error === "object" && "status" in error
    && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : null;
  // The Task list is an optional server capability during rolling upgrades.
  return status === 404 || status === 405 || status === 501;
}

function taskStatusForPresentation(status: TaskPresentationStatus): string {
  switch (status) {
    case "done": return "completed";
    case "errored": return "errored";
    default: return status;
  }
}

/**
 * One fenced in-memory Task reader. A caller owns its lifecycle; neither it nor
 * the selectors reach into realtime, persistence, room focus, or chat state.
 */
export function createTaskWorkController(options: CreateTaskWorkControllerOptions = {}): TaskWorkController {
  let disposed = false;
  let generation = 0;
  let state = emptyState(null);
  let canonicalTasks: readonly TaskSummary[] = [];
  let reconcileInFlight: Promise<TaskWorkLoadResult> | null = null;
  let boundaryRefreshQueued = false;
  let eventRevision = 0;
  const lastEventRevisionByTask = new Map<string, number>();
  const unknownTaskRefreshes = new Map<string, PendingUnknownTaskRefresh>();
  const unknownTaskCooldownUntil = new Map<string, number>();
  const retiredRunIdsByTask = new Map<string, Set<string>>();
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearSchedule = options.clearSchedule ?? clearTimeout;
  const terminalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();
  const MAX_EVENT_BOOKKEEPING = 128;
  const UNKNOWN_REPAIR_COOLDOWN_MS = 1_000;

  const trimMap = <T>(map: Map<string, T>): void => {
    while (map.size > MAX_EVENT_BOOKKEEPING) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  };

  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  const replace = (next: TaskWorkState): void => {
    state = next;
    emit();
  };
  const canCommit = (scope: TaskWorkScope, requestGeneration: number): boolean =>
    !disposed
    && generation === requestGeneration
    && sameTaskWorkScope(state.scope, scope);

  const clearTerminalTimer = (taskId: string): void => {
    const timer = terminalTimers.get(taskId);
    if (timer !== undefined) {
      clearSchedule(timer);
      terminalTimers.delete(taskId);
    }
  };

  const scheduleTerminalExpiry = (taskId: string, terminalAtMs: number): void => {
    clearTerminalTimer(taskId);
    const delayMs = Math.max(0, terminalAtMs + TASK_PRESENTATION_TERMINAL_LINGER_MS - now());
    terminalTimers.set(taskId, schedule(() => {
      terminalTimers.delete(taskId);
      if (disposed) return;
      // The selector reads its clock on each render. This finite notification is
      // what makes the compact strip recompute to quiet at the shared boundary.
      replace({ ...state });
    }, delayMs));
  };

  const patchCanonicalStatus = (taskId: string, status: string, options?: { allowTerminalOverride?: boolean }): void => {
    const existing = state.tasks.find((task) => task.id === taskId);
    if (!existing || existing.status === status) return;
    const existingStatus = normalizeTaskPresentationStatus(existing.status);
    if (existingStatus && isTerminalTaskPresentationStatus(existingStatus) && !options?.allowTerminalOverride) return;
    state = {
      ...state,
      tasks: state.tasks.map((task) => task.id === taskId ? { ...task, status } : task),
    };
  };

  const knownTask = (taskId: string): boolean => state.tasks.some((task) => task.id === taskId);

  const updateOverlay = (taskId: string, patch: TaskWorkOverlay): void => {
    state = {
      ...state,
      overlays: { ...state.overlays, [taskId]: { ...state.overlays[taskId], ...patch } },
    };
  };

  const dropTaskLiveRecord = (taskId: string): boolean => {
    clearTerminalTimer(taskId);
    lastEventRevisionByTask.delete(taskId);
    retiredRunIdsByTask.delete(taskId);
    unknownTaskRefreshes.delete(taskId);
    if (!state.overlays[taskId]) return false;
    const { [taskId]: _removed, ...overlays } = state.overlays;
    state = { ...state, overlays };
    return true;
  };

  const hasTerminalLatch = (taskId: string): boolean =>
    Object.prototype.hasOwnProperty.call(state.overlays[taskId] ?? {}, "terminalTaskRunId")
    && state.overlays[taskId]?.terminalTaskRunId !== undefined;

  const runMatches = (taskId: string, taskRunId: string | undefined): boolean => {
    if (!taskRunId) return true;
    const current = state.overlays[taskId]?.taskRunId;
    return !current || current === taskRunId;
  };

  const scheduleCanonicalTerminalExpiries = (tasks: readonly TaskSummary[]): void => {
    for (const task of tasks) {
      const status = normalizeTaskPresentationStatus(task.status);
      const terminalAtMs = parseTaskPresentationTimestamp(task.updatedAt ?? task.createdAt);
      if (status && isTerminalTaskPresentationStatus(status)
        && terminalAtMs <= now()
        && now() - terminalAtMs < TASK_PRESENTATION_TERMINAL_LINGER_MS) {
        scheduleTerminalExpiry(task.id, terminalAtMs);
      }
    }
  };

  const load = async (api: TaskWorkApi): Promise<TaskWorkLoadResult> => {
    const scope = state.scope;
    if (disposed || !scope) return { status: "ignored" };
    const requestGeneration = ++generation;
    const requestEventRevision = eventRevision;
    // Retain overlays received while an initial or repair request is in flight.
    // A list response is canonical data, never permission to erase a newer WS frame.
    replace({ ...state, kind: "loading", scope, error: null });
    try {
      const receivedTasks = await api.list(scope);
      if (!canCommit(scope, requestGeneration)) return { status: "ignored" };
      canonicalTasks = receivedTasks;
      const currentById = new Map(state.tasks.map((task) => [task.id, task]));
      const tasks = receivedTasks.map((task) => {
        const current = currentById.get(task.id);
        const freshOverlay = state.overlays[task.id];
        // A post-request fire/progress is newer than this response. Preserve
        // its locally patched lifecycle so an old completion cannot suppress it.
        if ((lastEventRevisionByTask.get(task.id) ?? 0) <= requestEventRevision) return task;
        return current
          ? { ...task, status: current.status }
          : freshOverlay?.status
            ? { ...task, status: taskStatusForPresentation(freshOverlay.status) }
            : task;
      });
      const receivedIds = new Set(receivedTasks.map((task) => task.id));
      for (const taskId of Object.keys(state.overlays)) {
        if (receivedIds.has(taskId) || unknownTaskRefreshes.has(taskId)
          || (lastEventRevisionByTask.get(taskId) ?? 0) > requestEventRevision) continue;
        dropTaskLiveRecord(taskId);
      }
      replace({
        kind: "ready",
        scope,
        tasks,
        error: null,
        overlays: state.overlays,
      });
      scheduleCanonicalTerminalExpiries(tasks);
      return { status: "applied", data: tasks };
    } catch (error) {
      if (!canCommit(scope, requestGeneration)) return { status: "ignored" };
      if (isUnsupportedTaskApi(error)) {
        replace({ ...state, kind: "unsupported", scope, error: null });
        return { status: "failed", error };
      }
      replace({ ...state, kind: "error", scope, error: toError(error) });
      return { status: "failed", error };
    }
  };

  const clearLiveForBoundary = (): void => {
    generation += 1;
    for (const taskId of terminalTimers.keys()) clearTerminalTimer(taskId);
    lastEventRevisionByTask.clear();
    retiredRunIdsByTask.clear();
    state = { ...state, tasks: canonicalTasks, overlays: {} };
    emit();
  };

  const reconcile = (api: TaskWorkApi, options?: { resetLive?: boolean }): Promise<TaskWorkLoadResult> => {
    if (options?.resetLive) {
      // A visibility boundary is immediate: no prior run/status/progress is
      // allowed to outlive foreground/reconnect while the canonical request runs.
      clearLiveForBoundary();
      if (reconcileInFlight) boundaryRefreshQueued = true;
    }
    if (reconcileInFlight) return reconcileInFlight;
    const scope = state.scope;
    if (!scope) return Promise.resolve({ status: "ignored" });
    const requestStartRevision = eventRevision;
    // `load` advances this generation before invoking a caller-controlled API.
    // Snapshot its expected value now: a re-entrant auth/server switch from a
    // synchronous test adapter must not make this old request look current.
    const requestGeneration = generation + 1;
    const requestLoad = load(api);
    const request = requestLoad.then((result) => {
      // `load` fences its response, but this reconciliation bookkeeping runs
      // after it settles. Do not let an ignored request from a prior
      // server/viewer generation touch the current scope's unknown-event maps
      // or live overlays.
      if (!canCommit(scope, requestGeneration)) return result;
      const knownIds = new Set(state.tasks.map((task) => task.id));
      let trailingUnknownRepair = false;
      let removedMissingOverlay = false;
      for (const [taskId, pending] of unknownTaskRefreshes) {
        if (knownIds.has(taskId)) {
          unknownTaskRefreshes.delete(taskId);
          unknownTaskCooldownUntil.delete(taskId);
        } else if (result.status === "applied" && pending.revision > requestStartRevision && !pending.trailingUsed) {
          unknownTaskRefreshes.set(taskId, { ...pending, trailingUsed: true });
          trailingUnknownRepair = true;
        } else {
          unknownTaskRefreshes.delete(taskId);
          unknownTaskCooldownUntil.set(taskId, now() + UNKNOWN_REPAIR_COOLDOWN_MS);
          removedMissingOverlay = dropTaskLiveRecord(taskId) || removedMissingOverlay;
        }
      }
      trimMap(unknownTaskCooldownUntil);
      if (removedMissingOverlay) replace({ ...state });
      if (trailingUnknownRepair) boundaryRefreshQueued = true;
      return result;
    }).finally(() => {
      if (reconcileInFlight === request) {
        reconcileInFlight = null;
        if (boundaryRefreshQueued) {
          boundaryRefreshQueued = false;
          void reconcile(api);
        }
      }
    });
    reconcileInFlight = request;
    return request;
  };

  const applyRealtimeEvent = (event: ServerEvent, api: TaskWorkApi): void => {
    const scope = state.scope;
    if (disposed || !scope || !("ownerId" in event) || event.ownerId !== scope.userId) return;
    if (event.type !== "task.fired" && event.type !== "task.status" && event.type !== "task.awaiting_reply"
      && event.type !== "task.progress" && event.type !== "task.completed" && event.type !== "task.errored") return;
    const taskId = event.taskId;
    if (!taskId) return;
    const wasKnown = knownTask(taskId);
    const overlay = state.overlays[taskId];
    let locallyApplied = false;

    if (event.type === "task.fired") {
      // A duplicate fire cannot reopen terminal work; only a distinct run can.
      if (overlay?.terminalTaskRunId === event.taskRunId
        || retiredRunIdsByTask.get(taskId)?.has(event.taskRunId)) return;
      if (overlay?.terminalTaskRunId) {
        const retired = retiredRunIdsByTask.get(taskId) ?? new Set<string>();
        retired.add(overlay.terminalTaskRunId);
        while (retired.size > 8) retired.delete(retired.values().next().value!);
        retiredRunIdsByTask.set(taskId, retired);
        trimMap(retiredRunIdsByTask);
      }
      if (overlay?.taskRunId && overlay.taskRunId !== event.taskRunId) {
        const retired = retiredRunIdsByTask.get(taskId) ?? new Set<string>();
        retired.add(overlay.taskRunId);
        while (retired.size > 8) retired.delete(retired.values().next().value!);
        retiredRunIdsByTask.set(taskId, retired);
        trimMap(retiredRunIdsByTask);
      }
      clearTerminalTimer(taskId);
      patchCanonicalStatus(taskId, "running", { allowTerminalOverride: true });
      updateOverlay(taskId, { status: "running", taskRunId: event.taskRunId, terminalTaskRunId: undefined, progress: undefined, terminalAtMs: undefined });
      locallyApplied = true;
    } else if (hasTerminalLatch(taskId) && event.type !== "task.status") {
      // Terminal truth is monotonic for this local run. Late progress/status
      // frames are ignored until the server explicitly fires a different run.
      return;
    } else if (event.type === "task.progress") {
      if (!runMatches(taskId, event.taskRunId)) return;
      patchCanonicalStatus(taskId, "running");
      updateOverlay(taskId, { status: "running", taskRunId: event.taskRunId, progress: event.detail });
      locallyApplied = true;
    } else if (event.type === "task.awaiting_reply") {
      if (!runMatches(taskId, event.taskRunId)) return;
      patchCanonicalStatus(taskId, "awaiting");
      updateOverlay(taskId, { status: "awaiting", taskRunId: event.taskRunId ?? overlay?.taskRunId, progress: "Waiting for your reply" });
      locallyApplied = true;
    } else if (event.type === "task.completed" || event.type === "task.errored") {
      if (!runMatches(taskId, event.taskRunId)) return;
      const status: TaskPresentationStatus = event.type === "task.completed" ? "done" : "errored";
      const terminalAtMs = now();
      patchCanonicalStatus(taskId, event.status);
      updateOverlay(taskId, { status, taskRunId: event.taskRunId, terminalTaskRunId: event.taskRunId, progress: undefined, terminalAtMs });
      scheduleTerminalExpiry(taskId, terminalAtMs);
      locallyApplied = true;
    } else {
      const status = normalizeTaskPresentationStatus(event.status);
      // task.status lacks taskRunId. Terminal variants therefore reconcile
      // canonically rather than latching an unidentifiable old run over a
      // newer fire; non-terminal control transitions remain immediate.
      // Once a concrete run is live, even a non-terminal status could be a
      // delayed control frame from the prior run. Let the owner API settle it.
      if (hasTerminalLatch(taskId)) {
        // Cron completion may durable-transition to pending before a later
        // human pause/cancel control frame. Keep its run fence, but stop the
        // old terminal presentation from masking the canonical reconciliation.
        clearTerminalTimer(taskId);
        updateOverlay(taskId, { status: undefined, progress: undefined });
      } else if (overlay?.taskRunId) {
        // Do not locally project a runless status over a concrete live run.
        // Hide its provisional status while the owner API establishes pause,
        // resume, or cancellation truth.
        updateOverlay(taskId, { status: undefined, progress: undefined });
      } else if (!overlay?.taskRunId && (!status || !isTerminalTaskPresentationStatus(status))) {
        patchCanonicalStatus(taskId, event.status);
      }
      if (!hasTerminalLatch(taskId) && !overlay?.taskRunId && status && !isTerminalTaskPresentationStatus(status)) {
        updateOverlay(taskId, { status, progress: undefined });
        locallyApplied = true;
      } else if (status) {
        // No local terminal overlay without a run identity (see above).
      } else if (!overlay?.taskRunId) {
        clearTerminalTimer(taskId);
        const { [taskId]: _removed, ...overlays } = state.overlays;
        state = { ...state, overlays };
        locallyApplied = true;
      }
    }
    // Every accepted event is observable, including rows not yet in the last
    // bounded list. Unknown IDs receive exactly one single-flight repair.
    eventRevision += 1;
    if (locallyApplied) {
      lastEventRevisionByTask.set(taskId, eventRevision);
      trimMap(lastEventRevisionByTask);
    }
    replace({ ...state });
    if (!wasKnown) {
      if (reconcileInFlight) {
        unknownTaskRefreshes.set(taskId, {
          revision: eventRevision,
          trailingUsed: unknownTaskRefreshes.get(taskId)?.trailingUsed ?? false,
        });
        trimMap(unknownTaskRefreshes);
      } else if ((unknownTaskCooldownUntil.get(taskId) ?? 0) <= now()) {
        unknownTaskRefreshes.set(taskId, { revision: eventRevision, trailingUsed: false });
        trimMap(unknownTaskRefreshes);
        void reconcile(api);
      } else {
        // A cooldown must not leave an invisible unknown overlay resident with
        // no request or timer capable of reconciling it later.
        if (dropTaskLiveRecord(taskId)) replace({ ...state });
      }
    } else if (event.type === "task.status" && (overlay?.taskRunId
      || (normalizeTaskPresentationStatus(event.status)
        && isTerminalTaskPresentationStatus(normalizeTaskPresentationStatus(event.status)!)))) {
      if (reconcileInFlight) boundaryRefreshQueued = true;
      void reconcile(api);
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setScope(scope) {
      if (disposed || sameTaskWorkScope(state.scope, scope)) return;
      generation += 1;
      for (const taskId of terminalTimers.keys()) clearTerminalTimer(taskId);
      reconcileInFlight = null;
      boundaryRefreshQueued = false;
      eventRevision = 0;
      lastEventRevisionByTask.clear();
      unknownTaskRefreshes.clear();
      unknownTaskCooldownUntil.clear();
      retiredRunIdsByTask.clear();
      canonicalTasks = [];
      replace(emptyState(scope));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      for (const taskId of terminalTimers.keys()) clearTerminalTimer(taskId);
      reconcileInFlight = null;
      boundaryRefreshQueued = false;
      lastEventRevisionByTask.clear();
      unknownTaskRefreshes.clear();
      unknownTaskCooldownUntil.clear();
      retiredRunIdsByTask.clear();
      canonicalTasks = [];
      state = emptyState(null);
      listeners.clear();
    },
    load,
    retry: load,
    reconcile,
    discardProvisionalProgress() {
      if (disposed || Object.values(state.overlays).every((overlay) => overlay.progress === undefined)) return;
      const overlays = Object.fromEntries(Object.entries(state.overlays).map(([taskId, overlay]) => {
        const { progress: _progress, ...retained } = overlay;
        return [taskId, retained];
      })) as Record<string, TaskWorkOverlay>;
      replace({ ...state, overlays });
    },
    applyRealtimeEvent,
  };
}

/**
 * Build a pure, deterministic Task view. `nowMs` is injectable so the terminal
 * linger boundary is testable and no UI needs to own a timer or synthesize work.
 */
export function selectTaskWork(
  tasks: readonly TaskSummary[],
  overlays: Readonly<Record<string, TaskWorkOverlay>> = {},
  nowMs = Date.now(),
): TaskWorkSelectors {
  const rows = tasks.flatMap<TaskWorkRow>((task) => {
    const overlay = overlays[task.id];
    const canonicalStatus = normalizeTaskPresentationStatus(task.status);
    const canonicalTerminal = canonicalStatus !== null && isTerminalTaskPresentationStatus(canonicalStatus);
    // A stale non-terminal frame may arrive after canonical completion. It
    // must never resurrect a terminal Task while 2.2 is reconciling events.
    const status = canonicalTerminal
      ? canonicalStatus
      : overlay?.status ?? canonicalStatus;
    if (!status) return [];
    const canonicalTerminalAtMs = isTerminalTaskPresentationStatus(status)
      ? parseTaskPresentationTimestamp(task.updatedAt ?? task.createdAt)
      : null;
    const terminal = isTerminalTaskPresentationStatus(status);
    const matchingTerminalOverlay = terminal
      && overlay?.status === status
      && isTerminalTaskPresentationStatus(overlay.status);
    return [{
      task,
      taskId: task.id,
      parentTaskId: task.parentTaskId,
      depth: task.depth,
      status,
      startedAtMs: parseTaskPresentationTimestamp(task.createdAt),
      terminalAtMs: matchingTerminalOverlay
        ? overlay?.terminalAtMs ?? canonicalTerminalAtMs
        : canonicalTerminalAtMs,
      activity: taskPresentationActivityText(
        status,
        // Terminal lifecycle wins its linger. Progress belongs only to a live
        // non-terminal frame, even when the terminal overlay is authoritative.
        terminal || (overlay?.status && overlay.status !== status) ? undefined : overlay?.progress,
      ),
    }];
  });
  const ordered = sortTaskPresentationItems(rows);
  const terminalHistory = ordered.filter((row) => isTerminalTaskPresentationStatus(row.status));
  const newlyCompleted = terminalHistory.filter((row) => isWithinTerminalLinger(row.terminalAtMs, nowMs));
  const actionNeeded = ordered.filter((row) => row.status === "awaiting"
    || (row.status === "errored" && newlyCompleted.includes(row)));
  const active = ordered.filter((row) => row.status === "running");
  const paused = ordered.filter((row) => row.status === "paused");
  // Paused work remains in the overview but must not pin a Chat work strip.
  // One ordered filter avoids duplicating a newly failed row in the strip.
  const topRows = ordered.filter((row) => row.status === "awaiting"
    || row.status === "running"
    || newlyCompleted.includes(row));

  return {
    overviewRows: ordered,
    actionNeeded,
    active,
    paused,
    terminalHistory,
    newlyCompleted,
    topRows,
    quiet: topRows.length === 0,
  };
}

/** The strip should not survive indefinitely just because the overview has history. */
function isWithinTerminalLinger(terminalAtMs: number | null, nowMs: number): boolean {
  return terminalAtMs !== null
    && Number.isFinite(nowMs)
    && terminalAtMs <= nowMs
    && nowMs - terminalAtMs < TASK_PRESENTATION_TERMINAL_LINGER_MS;
}

/** Convert raw controller state into explicit UI semantics without leaking stale scope data. */
export function taskWorkViewState(
  state: Readonly<TaskWorkState>,
  currentScope: TaskWorkScope | null,
  nowMs = Date.now(),
): TaskWorkViewState {
  if (!currentScope) return { kind: "idle", scope: null, selectors: EMPTY_SELECTORS };
  // Effects clear the controller after React commits, but rendering must never
  // expose previous-owner rows during that one render between identity changes.
  if (!sameTaskWorkScope(state.scope, currentScope)) {
    return { kind: "loading", scope: currentScope, selectors: EMPTY_SELECTORS };
  }
  const selectors = selectTaskWork(state.tasks, state.overlays, nowMs);
  if (state.kind === "unsupported") return { kind: "unsupported", scope: currentScope, selectors };
  if (state.kind === "error") return { kind: "error", scope: currentScope, selectors, error: state.error ?? new Error("Could not load delegated work.") };
  if (state.kind === "loading" || state.kind === "idle") return { kind: "loading", scope: currentScope, selectors };
  return selectors.overviewRows.length === 0
    ? { kind: "empty", scope: currentScope, selectors }
    : { kind: "ready", scope: currentScope, selectors };
}
