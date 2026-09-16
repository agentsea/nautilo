/**
 * M214 Phase 8 — owner-scoped canonical task map + running-subagent overlay.
 *
 * Pure, React-free store so startup seed dedupe, non-overlapping refresh/poll,
 * WS enrichment, and lifecycle reconciliation are unit-testable without a live
 * server or DOM.
 */

import { readTaskPreparation } from "@nautilo/types";
import type {
  ServerEvent,
  TaskHarnessActivity,
  TaskSummary,
} from "@nautilo/types";
import {
  buildRunningSubagentsMap,
  defaultLine3ForStatus,
  mapTaskStatusToCardStatus,
  taskSummaryToRunningSubagent,
  type RunningSubagentOverlay,
} from "./running-subagent-projection";
import {
  isTerminalStatus,
  TERMINAL_LINGER_MS,
  type RunningSubagent,
  type RunningSubagentStatus,
} from "../../modes/rooms/subagents/running-subagents-model";

const SCHEDULED_TASKS_POLL_MS = 5000;
// This is a Human-only presentation cache, deliberately aligned with the
// server's process-local Codex snapshot. It is not a model/Genie polling loop.
const HARNESS_ACTIVITY_CAP = 20;
const HARNESS_ACTIVITY_MAX_BYTES = 64 * 1024;

function mergeHarnessActivity(
  prior: readonly TaskHarnessActivity[],
  incoming: TaskHarnessActivity,
): readonly TaskHarnessActivity[] {
  const index = prior.findIndex((activity) => activity.id === incoming.id);
  if (index < 0) return trimHarnessActivity([...prior, incoming]);
  const current = prior[index];
  const result =
    incoming.appendResult && incoming.result
      ? `${current.result ?? ""}${current.result ? (incoming.appendResultSeparator ?? "\n") : ""}${incoming.result}`
      : incoming.result;
  const next: TaskHarnessActivity = {
    ...current,
    ...incoming,
    args: Object.keys(incoming.args).length === 0 ? current.args : incoming.args,
    startedAt: current.startedAt,
    ...(result !== undefined ? { result } : {}),
  };
  return trimHarnessActivity([
    ...prior.slice(0, index),
    next,
    ...prior.slice(index + 1),
  ]);
}

function trimHarnessActivity(activity: readonly TaskHarnessActivity[]): readonly TaskHarnessActivity[] {
  const newestCurrent = [...activity].reverse().find(
    (item) => item.status === "running" || item.status === "waiting",
  );
  const next = activity
    .filter((item) => (item.status !== "running" && item.status !== "waiting") || item.id === newestCurrent?.id)
    .slice(-HARNESS_ACTIVITY_CAP);
  while (next.length > 1 && harnessActivityBytes(next) > HARNESS_ACTIVITY_MAX_BYTES) {
    const removable = next.findIndex((item) => item.status !== "running" && item.status !== "waiting");
    next.splice(removable < 0 ? 0 : removable, 1);
  }
  if (next.length === 1 && harnessActivityBytes(next) > HARNESS_ACTIVITY_MAX_BYTES && next[0]?.result) {
    next[0] = fitSingleHarnessActivity(next[0]);
  } else if (next.length === 1 && harnessActivityBytes(next) > HARNESS_ACTIVITY_MAX_BYTES && next[0]) {
    next[0] = fitSingleHarnessActivity(next[0]);
  }
  return next;
}

function fitSingleHarnessActivity(activity: TaskHarnessActivity): TaskHarnessActivity {
  const withSmallOutput: TaskHarnessActivity = {
    ...activity,
    args: {},
    ...(activity.result ? { result: truncateUtf8(activity.result, 16 * 1024) } : {}),
  };
  if (harnessActivityBytes([withSmallOutput]) <= HARNESS_ACTIVITY_MAX_BYTES) return withSmallOutput;
  return {
    id: truncateUtf8(activity.id, 1024),
    kind: activity.kind,
    name: truncateUtf8(activity.name, 1024),
    status: activity.status,
    args: {},
    startedAt: activity.startedAt,
    ...(activity.endedAt !== undefined ? { endedAt: activity.endedAt } : {}),
  };
}

function harnessActivityBytes(activity: readonly TaskHarnessActivity[]): number {
  return new TextEncoder().encode(JSON.stringify(activity)).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const suffix = "...";
  const limit = maxBytes - encoder.encode(suffix).byteLength;
  let bytes = 0;
  let end = 0;
  for (const codePoint of value) {
    const size = encoder.encode(codePoint).byteLength;
    if (bytes + size > limit) break;
    bytes += size;
    end += codePoint.length;
  }
  return `${value.slice(0, end)}${suffix}`;
}

function trimRecentActivity(activity: readonly string[]): readonly string[] {
  const next = activity.slice(-HARNESS_ACTIVITY_CAP);
  while (next.length > 1 && new TextEncoder().encode(JSON.stringify(next)).byteLength > HARNESS_ACTIVITY_MAX_BYTES) {
    next.shift();
  }
  if (next.length === 1 && new TextEncoder().encode(next[0] ?? "").byteLength > HARNESS_ACTIVITY_MAX_BYTES) {
    next[0] = truncateUtf8(next[0] ?? "", HARNESS_ACTIVITY_MAX_BYTES / 2);
  }
  return next;
}

/** Suppress a WS-open seed when mount seed finished within this window. */
export const SEED_SUPPRESS_AFTER_MOUNT_MS = 2000;

export type TaskSeedSource = "mount" | "ws-open";

export interface TaskStateSnapshot {
  readonly taskMap: Readonly<Record<string, TaskSummary>>;
  readonly tasks: readonly TaskSummary[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly busyIds: ReadonlySet<string>;
  readonly runningSubagentsMap: Readonly<Record<string, RunningSubagent>>;
  readonly lastSuccessfulAtMs: number | null;
}

export interface TaskStateListener {
  (snapshot: TaskStateSnapshot): void;
}

export interface TaskLifecycleApi {
  pauseTask(taskId: string): Promise<unknown>;
  unpauseTask(taskId: string): Promise<unknown>;
  stopTask(taskId: string): Promise<unknown>;
}

export interface TaskListApi {
  listActiveTasks(): Promise<TaskSummary[]>;
}

export interface CreateTaskStateStoreOptions {
  listActiveTasks: TaskListApi["listActiveTasks"];
  lifecycle?: TaskLifecycleApi;
  pollIntervalMs?: number;
  seedSuppressAfterMountMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearSchedule?: (id: ReturnType<typeof setTimeout>) => void;
}

export interface TaskStateStore {
  getSnapshot(): TaskStateSnapshot;
  subscribe(listener: TaskStateListener): () => void;
  clearForViewerChange(): void;
  seed(source: TaskSeedSource): Promise<void>;
  refresh(): Promise<void>;
  setDashboardPollingEnabled(enabled: boolean): void;
  pauseTask(taskId: string): Promise<void>;
  unpauseTask(taskId: string): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  applyWsEvent(event: ServerEvent): void;
  /** Test seam — advance linger timers without waiting wall clock. */
  flushLingerTimersForTests?(): void;
}

interface MutableTaskState {
  taskMap: Record<string, TaskSummary>;
  loading: boolean;
  error: string | null;
  busyIds: Set<string>;
  overlays: Record<string, RunningSubagentOverlay>;
  visibleRunningIds: Set<string>;
  lingerTimers: Map<string, ReturnType<typeof setTimeout>>;
  lastSuccessfulAtMs: number | null;
}

function tasksFromMap(
  taskMap: Readonly<Record<string, TaskSummary>>,
): TaskSummary[] {
  return Object.values(taskMap);
}

export function shouldSuppressWsOpenSeed(input: {
  source: TaskSeedSource;
  seedInflight: boolean;
  lastSeedCompletedAtMs: number | null;
  nowMs: number;
  suppressWindowMs: number;
}): boolean {
  if (input.source !== "ws-open") return false;
  if (input.seedInflight) return true;
  if (input.lastSeedCompletedAtMs === null) return false;
  return input.nowMs - input.lastSeedCompletedAtMs < input.suppressWindowMs;
}

export function createTaskStateStore(
  options: CreateTaskStateStoreOptions,
): TaskStateStore {
  const pollIntervalMs = options.pollIntervalMs ?? SCHEDULED_TASKS_POLL_MS;
  const seedSuppressAfterMountMs =
    options.seedSuppressAfterMountMs ?? SEED_SUPPRESS_AFTER_MOUNT_MS;
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((fn, delayMs) => setTimeout(fn, delayMs));
  const clearSchedule = options.clearSchedule ?? clearTimeout;

  const listeners = new Set<TaskStateListener>();
  let seedInflight: Promise<void> | null = null;
  let refreshInflight: Promise<void> | null = null;
  let lastSeedCompletedAtMs: number | null = null;
  let pollTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let dashboardPollingEnabled = false;
  let pollChainScheduled = false;
  let taskListRevision = 0;

  const state: MutableTaskState = {
    taskMap: {},
    loading: true,
    error: null,
    busyIds: new Set(),
    overlays: {},
    visibleRunningIds: new Set(),
    lingerTimers: new Map(),
    lastSuccessfulAtMs: null,
  };

  const emit = (): void => {
    const snapshot = getSnapshot();
    for (const listener of listeners) listener(snapshot);
  };

  const clearPollTimeout = (): void => {
    if (pollTimeoutId !== null) {
      clearSchedule(pollTimeoutId);
      pollTimeoutId = null;
    }
    pollChainScheduled = false;
  };

  const schedulePollAfterCompletion = (): void => {
    if (!dashboardPollingEnabled || pollChainScheduled) return;
    pollChainScheduled = true;
    pollTimeoutId = schedule(() => {
      pollTimeoutId = null;
      pollChainScheduled = false;
      void refresh().finally(() => {
        schedulePollAfterCompletion();
      });
    }, pollIntervalMs);
  };

  const discardProvisionalLiveOverlays = (): void => {
    for (const [taskId, overlay] of Object.entries(state.overlays)) {
      if (overlay.status && isTerminalStatus(overlay.status)) continue;
      delete state.overlays[taskId];
    }
  };

  const applyTaskList = (tasks: TaskSummary[], opts?: { recomputeRunning?: boolean }): void => {
    const nextMap: Record<string, TaskSummary> = {};
    for (const task of tasks) {
      const prior = state.taskMap[task.id];
      // A verified same-run recovery can leave terminal state without a new
      // fired run identity. Only the authoritative list clears this latch.
      if (prior?.canResumeResearch === true && prior.status === "errored"
        && task.status !== "errored") {
        clearLingerTimer(task.id);
        delete state.overlays[task.id];
      }
      if (task.status === "errored" && task.canResumeResearch === true) clearLingerTimer(task.id);
      nextMap[task.id] = task;
    }
    state.taskMap = nextMap;
    state.error = null;
    state.lastSuccessfulAtMs = now();
    if (opts?.recomputeRunning !== false) {
      recomputeVisibleRunningFromSeed(tasks);
    }
  };

  const recomputeVisibleRunningFromSeed = (tasks: readonly TaskSummary[]): void => {
    const nextVisible = new Set<string>();
    for (const task of tasks) {
      const mapped = taskSummaryToRunningSubagent(task);
      const overlay = state.overlays[task.id];
      const overlayTerminal = Boolean(overlay?.status && isTerminalStatus(overlay.status));
      const status = mapped?.status ?? overlay?.status;
      if (!status) continue;
      if (!isTerminalStatus(status) || (task.status === "errored" && task.canResumeResearch === true)
        || (overlayTerminal && state.visibleRunningIds.has(task.id))) {
        nextVisible.add(task.id);
      }
    }
    state.visibleRunningIds = nextVisible;
  };

  const clearLingerTimer = (taskId: string): void => {
    const existing = state.lingerTimers.get(taskId);
    if (existing) {
      clearSchedule(existing);
      state.lingerTimers.delete(taskId);
    }
  };

  const scheduleLingerRemoval = (taskId: string): void => {
    clearLingerTimer(taskId);
    if (state.taskMap[taskId]?.status === "errored" && state.taskMap[taskId]?.canResumeResearch === true) return;
    state.lingerTimers.set(
      taskId,
      schedule(() => {
        state.lingerTimers.delete(taskId);
        state.visibleRunningIds.delete(taskId);
        delete state.overlays[taskId];
        emit();
      }, TERMINAL_LINGER_MS),
    );
  };

  const patchTaskStatus = (taskId: string, status: string): void => {
    const existing = state.taskMap[taskId];
    if (existing) {
      state.taskMap = {
        ...state.taskMap,
        [taskId]: { ...existing, status, ...(status !== "errored" ? { canResumeResearch: undefined } : {}) },
      };
    }
  };

  const upsertOverlay = (
    taskId: string,
    patch: RunningSubagentOverlay,
    opts?: { ensureVisible?: boolean },
  ): void => {
    if (opts?.ensureVisible) state.visibleRunningIds.add(taskId);
    state.overlays[taskId] = {
      ...state.overlays[taskId],
      ...patch,
    };
  };

  const fetchTasks = async (): Promise<void> => {
    const revision = taskListRevision;
    try {
      const tasks = await options.listActiveTasks();
      if (revision === taskListRevision) applyTaskList(tasks);
    } catch (err) {
      if (revision === taskListRevision) state.error = err instanceof Error ? err.message : String(err);
    } finally {
      state.loading = false;
      emit();
    }
  };

  const seed = async (source: TaskSeedSource): Promise<void> => {
    if (source === "ws-open") {
      // Reconnect invalidates process-local live detail immediately, even when
      // the seed is suppressed or the follow-up request fails. Terminal linger
      // is deliberately retained until its existing timer expires.
      discardProvisionalLiveOverlays();
      recomputeVisibleRunningFromSeed(Object.values(state.taskMap));
      emit();
    }
    if (
      shouldSuppressWsOpenSeed({
        source,
        seedInflight: seedInflight !== null,
        lastSeedCompletedAtMs,
        nowMs: now(),
        suppressWindowMs: seedSuppressAfterMountMs,
      })
    ) {
      return seedInflight ?? Promise.resolve();
    }
    if (seedInflight) return seedInflight;
    state.loading = true;
    emit();
    const run = fetchTasks().finally(() => {
      if (seedInflight === run) {
        seedInflight = null;
        lastSeedCompletedAtMs = now();
      }
    });
    seedInflight = run;
    return run;
  };

  const refresh = async (): Promise<void> => {
    if (refreshInflight) return refreshInflight;
    const run = fetchTasks().finally(() => {
      if (refreshInflight === run) refreshInflight = null;
    });
    refreshInflight = run;
    return run;
  };

  const withBusy = async (
    taskId: string,
    action: () => Promise<unknown>,
  ): Promise<void> => {
    if (!options.lifecycle) return;
    state.busyIds.add(taskId);
    taskListRevision += 1;
    emit();
    try {
      await action();
      taskListRevision += 1;
      // A query started before the mutation is not its reconciliation query.
      if (refreshInflight) await refreshInflight;
      await refresh();
    } catch {
      // List refetch reconciles real state; swallow action errors.
    } finally {
      state.busyIds.delete(taskId);
      emit();
    }
  };

  const applyCardStatus = (
    taskId: string,
    cardStatus: RunningSubagentStatus,
    taskRunId?: string,
  ): void => {
    if (!state.visibleRunningIds.has(taskId)) return;
    const terminal = isTerminalStatus(cardStatus);
    if (terminal) {
      scheduleLingerRemoval(taskId);
    } else {
      clearLingerTimer(taskId);
    }
    const prior = state.overlays[taskId];
    upsertOverlay(taskId, {
      status: cardStatus,
      line3: defaultLine3ForStatus(cardStatus),
      terminalAtMs: terminal ? now() : null,
      terminalTaskRunId: terminal ? (taskRunId ?? prior?.taskRunId ?? null) : null,
      ...(terminal ? { recentActivity: [], harnessActivity: [] } : {}),
      ...(cardStatus === "awaiting" ? {} : { awaitingRoomId: null }),
    });
    emit();
  };

  const reconcileFiredSubagent = async (
    taskId: string,
    taskRunId: string,
  ): Promise<void> => {
    // A fired event does not carry a TaskSummary. Reconcile through the
    // canonical store's single-flight refresh rather than creating another
    // direct list path. This also makes concurrent fired events share one GET.
    await refresh();
    const summary = state.taskMap[taskId];
    if (!summary || !taskSummaryToRunningSubagent(summary)) return;
    const existingOverlay = state.overlays[taskId];
    if (
      existingOverlay?.status &&
      isTerminalStatus(existingOverlay.status) &&
      existingOverlay.terminalTaskRunId === taskRunId
    ) {
      return;
    }

    clearLingerTimer(taskId);
    state.visibleRunningIds.add(taskId);
    // `task.fired` is only acceptance/dispatch. Preserve the queued detail
    // (or a semantic progress line received while refresh was in flight)
    // rather than fabricating generic "Working…" before Codex confirms work.
    const liveLine =
      existingOverlay?.taskRunId === taskRunId
        ? (existingOverlay.line3 ?? "Queued for execution…")
        : "Queued for execution…";
    upsertOverlay(taskId, {
      taskRunId,
      terminalTaskRunId: null,
      status: "running",
      line3: liveLine,
      startedAtMs: now(),
      terminalAtMs: null,
      awaitingRoomId: null,
    });
    patchTaskStatus(taskId, "running");
    emit();
  };

  const applyWsEvent = (event: ServerEvent): void => {
    switch (event.type) {
      case "task.fired": {
        const { taskId, taskRunId } = event;
        const existingOverlay = state.overlays[taskId];
        if (
          existingOverlay?.status &&
          isTerminalStatus(existingOverlay.status) &&
          existingOverlay.terminalTaskRunId === taskRunId
        ) {
          // Duplicate delivery from a completed run cannot cancel its linger.
          break;
        }
        if (!state.visibleRunningIds.has(taskId)) {
          // Admit the task lane synchronously before the canonical refresh.
          // External harnesses can emit their first command frames immediately;
          // dropping them while GET /tasks is in flight makes fast commands
          // disappear from every live activity surface.
          clearLingerTimer(taskId);
          state.visibleRunningIds.add(taskId);
          upsertOverlay(taskId, {
            taskRunId,
            terminalTaskRunId: null,
            ...(existingOverlay?.taskRunId !== taskRunId ? { researchProgress: null } : {}),
            status: "running",
            line3: "Queued for execution…",
            startedAtMs: now(),
            terminalAtMs: null,
            awaitingRoomId: null,
          });
          emit();
          void reconcileFiredSubagent(taskId, taskRunId);
          break;
        }
        clearLingerTimer(taskId);
        upsertOverlay(taskId, {
          taskRunId,
          terminalTaskRunId: null,
          ...(existingOverlay?.taskRunId !== taskRunId ? { researchProgress: null } : {}),
          status: "running",
          line3: "Queued for execution…",
          startedAtMs: now(),
          terminalAtMs: null,
          awaitingRoomId: null,
        });
        patchTaskStatus(taskId, "running");
        emit();
        break;
      }

      case "task.status": {
        const cardStatus = mapTaskStatusToCardStatus(event.status);
        const existingOverlay = state.overlays[event.taskId];
        if (
          existingOverlay?.status &&
          isTerminalStatus(existingOverlay.status) &&
          (!cardStatus || !isTerminalStatus(cardStatus))
        ) {
          // Status events carry no run id. Keep the terminal card and its
          // canonical Task summary latched until a distinct `task.fired`.
          emit();
          break;
        }
        patchTaskStatus(event.taskId, event.status);
        if (!cardStatus) {
          if (event.status === "pending") {
            clearLingerTimer(event.taskId);
            state.visibleRunningIds.delete(event.taskId);
            delete state.overlays[event.taskId];
            emit();
          }
          break;
        }
        if (state.visibleRunningIds.has(event.taskId)) {
          applyCardStatus(event.taskId, cardStatus);
        } else {
          emit();
        }
        break;
      }

      case "task.completed": {
        patchTaskStatus(event.taskId, event.status);
        if (state.visibleRunningIds.has(event.taskId)) {
          applyCardStatus(event.taskId, "done", event.taskRunId);
        } else {
          emit();
        }
        break;
      }

      case "task.errored": {
        taskListRevision += 1;
        patchTaskStatus(event.taskId, event.status);
        if (state.visibleRunningIds.has(event.taskId)) {
          applyCardStatus(event.taskId, "errored", event.taskRunId);
        } else {
          emit();
        }
        // Eligibility is server-owned and absent from the realtime error event.
        // A query begun before this error cannot discover its saved checkpoint.
        if (refreshInflight) void refreshInflight.then(() => refresh());
        else void refresh();
        break;
      }

      case "task.awaiting_reply": {
        const taskId = event.taskId;
        if (!taskId) break;
        const existingOverlay = state.overlays[taskId];
        if (
          !state.visibleRunningIds.has(taskId) ||
          (existingOverlay?.status && isTerminalStatus(existingOverlay.status)) ||
          (event.taskRunId && existingOverlay?.taskRunId && event.taskRunId !== existingOverlay.taskRunId)
        ) break;
        patchTaskStatus(taskId, "awaiting");
        clearLingerTimer(taskId);
        upsertOverlay(taskId, {
          status: "awaiting",
          line3: "Waiting for your reply",
          awaitingRoomId: event.targetRoomId,
          terminalAtMs: null,
        });
        emit();
        break;
      }

      case "task.progress": {
        if (!state.visibleRunningIds.has(event.taskId)) break;
        const existingOverlay = state.overlays[event.taskId];
        if (
          (existingOverlay?.status && isTerminalStatus(existingOverlay.status)) ||
          (existingOverlay?.taskRunId && existingOverlay.taskRunId !== event.taskRunId)
        ) break;
        const prior = state.overlays[event.taskId]?.recentActivity ?? [];
        const recentActivity =
          prior.at(-1) === event.detail ? prior : trimRecentActivity([...prior, event.detail]);
        const priorHarnessActivity =
          state.overlays[event.taskId]?.harnessActivity ?? [];
        const harnessActivity = event.activity
          ? mergeHarnessActivity(priorHarnessActivity, event.activity)
          : priorHarnessActivity;
        const preparation = readTaskPreparation({ ...event.preparation,
          taskRunId: event.taskRunId, updatedAt: new Date(now()).toISOString() });
        upsertOverlay(event.taskId, {
          ...(preparation?.research ? { researchProgress: preparation.research } : {}),
          line3: event.detail,
          taskRunId: event.taskRunId,
          recentActivity,
          harnessActivity,
        });
        emit();
        break;
      }

      default:
        break;
    }
  };

  const getSnapshot = (): TaskStateSnapshot => ({
    taskMap: state.taskMap,
    tasks: tasksFromMap(state.taskMap),
    loading: state.loading,
    error: state.error,
    busyIds: state.busyIds,
    runningSubagentsMap: buildRunningSubagentsMap(
      state.taskMap,
      state.overlays,
      state.visibleRunningIds,
    ),
    lastSuccessfulAtMs: state.lastSuccessfulAtMs,
  });

  const clearForViewerChange = (): void => {
    taskListRevision += 1;
    clearPollTimeout();
    seedInflight = null;
    refreshInflight = null;
    lastSeedCompletedAtMs = null;
    for (const timer of state.lingerTimers.values()) clearSchedule(timer);
    state.lingerTimers.clear();
    state.taskMap = {};
    state.loading = true;
    state.error = null;
    state.busyIds.clear();
    state.overlays = {};
    state.visibleRunningIds.clear();
    state.lastSuccessfulAtMs = null;
    emit();
  };

  return {
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearForViewerChange,
    seed,
    refresh,
    setDashboardPollingEnabled(enabled) {
      dashboardPollingEnabled = enabled;
      if (!enabled) {
        clearPollTimeout();
        return;
      }
      if (!pollChainScheduled && !refreshInflight) {
        schedulePollAfterCompletion();
      }
    },
    pauseTask(taskId) {
      if (!options.lifecycle) return Promise.resolve();
      return withBusy(taskId, () => options.lifecycle!.pauseTask(taskId));
    },
    unpauseTask(taskId) {
      if (!options.lifecycle) return Promise.resolve();
      return withBusy(taskId, () => options.lifecycle!.unpauseTask(taskId));
    },
    stopTask(taskId) {
      if (!options.lifecycle) return Promise.resolve();
      return withBusy(taskId, () => options.lifecycle!.stopTask(taskId));
    },
    applyWsEvent,
    flushLingerTimersForTests() {
      const ids = [...state.lingerTimers.keys()];
      for (const taskId of ids) {
        clearLingerTimer(taskId);
        state.visibleRunningIds.delete(taskId);
        delete state.overlays[taskId];
      }
      emit();
    },
  };
}
