import type { MobileTaskDetail as TaskDetail, MobileTaskSummary as TaskSummary } from "@/features/task-work/task-content-mobile";
import {
  createTaskDetailController,
  type TaskDetailState,
  type TaskDetailTarget,
} from "@/features/task-work/task-detail-state";
import type { TaskWorkScope } from "@/features/task-work/use-task-work-scope";

import {
  createSettingsDataState,
  sameSettingsDataScope,
  type SettingsDataScope,
  type SettingsDataStateController,
  type SettingsLoadResult,
  type SettingsMutationResult,
} from "@/features/settings/settings-data-state";

/** The server has exactly two user-authored schedule kinds. */
function isScheduledWork(task: TaskSummary): boolean {
  return task.scheduleKind === "cron" || task.scheduleKind === "one_shot";
}

/** Keep the next server fire first; invalid or absent times deliberately sort last. */
export function scheduledWorkRows(tasks: readonly TaskSummary[]): TaskSummary[] {
  return tasks
    .filter(isScheduledWork)
    .slice()
    .sort((left, right) => nextFireMs(left) - nextFireMs(right) || left.id.localeCompare(right.id));
}

function nextFireMs(task: TaskSummary): number {
  const value = task.nextFireAt ? Date.parse(task.nextFireAt) : Number.NaN;
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

export function scheduleCadence(task: Pick<TaskSummary, "scheduleKind" | "cron">): string {
  if (task.scheduleKind === "cron") return task.cron?.trim() || "Recurring";
  return "Once";
}

export function scheduleNextFire(nextFireAt: string | null, now = new Date()): string {
  if (!nextFireAt) return "No next run";
  const fireAt = Date.parse(nextFireAt);
  if (!Number.isFinite(fireAt)) return "No next run";
  const remaining = fireAt - now.getTime();
  if (remaining <= 0) return "Due now";
  const minutes = Math.round(remaining / 60_000);
  if (minutes < 60) return `In ${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `In ${hours} hr`;
  return `In ${Math.round(hours / 24)} days`;
}

export function scheduleStatus(status: string): string {
  switch (status) {
    case "pending": return "Active";
    case "running": return "Running";
    case "awaiting": return "Waiting";
    case "paused": return "Paused";
    default: return status;
  }
}

export function canResumeScheduledWork(status: string, canInvokeAgents: boolean): boolean {
  return status === "paused" && canInvokeAgents;
}

export type ScheduledWorkFailure =
  | { kind: "signed-out" }
  | { kind: "unavailable"; message: string }
  | { kind: "failed"; message: string };

export function scheduledWorkFailure(error: unknown): ScheduledWorkFailure {
  const status = error !== null && typeof error === "object" && "status" in error
    && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : null;
  if (status === 401) return { kind: "signed-out" };
  // A 404 is intentionally not distinguished: another session may have
  // stopped it, or ownership may have changed. Both require a canonical reload.
  if (status === 403 || status === 404 || status === 409) {
    return { kind: "unavailable", message: "This schedule changed on the server. Reload to continue." };
  }
  return {
    kind: "failed",
    message: error instanceof Error && error.message ? error.message : "Could not reach this server.",
  };
}

export interface ScheduledWorkApi {
  list(scope: SettingsDataScope): Promise<TaskSummary[]>;
  detail(scope: SettingsDataScope, id: string): Promise<TaskDetail>;
  pause(scope: SettingsDataScope, id: string): Promise<void>;
  resume(scope: SettingsDataScope, id: string): Promise<void>;
  stop(scope: SettingsDataScope, id: string): Promise<void>;
}

export interface ScheduledWorkController {
  getState: SettingsDataStateController<TaskSummary[], null>["getState"];
  subscribe: SettingsDataStateController<TaskSummary[], null>["subscribe"];
  setScope(scope: SettingsDataScope | null, serverUrl?: string | null, detailScope?: TaskWorkScope | null): void;
  dispose: () => void;
  load(api: ScheduledWorkApi): Promise<SettingsLoadResult<TaskSummary[]>>;
  retry(api: ScheduledWorkApi): Promise<SettingsLoadResult<TaskSummary[]>>;
  getDetail(id: string, api: ScheduledWorkApi): Promise<SettingsLoadResult<TaskDetail>>;
  clearDetail(): void;
  getDetailState: () => Readonly<TaskDetailState>;
  subscribeDetail(listener: () => void): () => void;
  hasPendingCanonicalRefresh(): boolean;
  pause(id: string, api: ScheduledWorkApi): Promise<SettingsMutationResult<TaskSummary[]>>;
  resume(id: string, api: ScheduledWorkApi): Promise<SettingsMutationResult<TaskSummary[]>>;
  stop(id: string, api: ScheduledWorkApi): Promise<SettingsMutationResult<TaskSummary[]>>;
}

/**
 * A deliberately small owner-scoped client controller. It never creates,
 * edits, or schedules work: the server remains the only clock and authority.
 * The scope fence makes old-server, old-viewer, and unmounted completions inert.
 */
export function createScheduledWorkController(): ScheduledWorkController {
  const list = createSettingsDataState<TaskSummary[], null>();
  // Scheduled work remains a list/controller of its own, but its exact run
  // reader delegates to the one reusable Task-detail ownership fence.
  const detail = createTaskDetailController();
  let detailServerUrl: string | null = null;
  let detailScope: TaskWorkScope | null = null;
  let refreshScope: SettingsDataScope | null = null;

  const hasPendingCanonicalRefresh = (): boolean =>
    refreshScope !== null && sameSettingsDataScope(list.getState().scope, refreshScope);
  const clearPendingIfScopeChanged = (): void => {
    if (!hasPendingCanonicalRefresh()) refreshScope = null;
  };
  const validRow = (id: string, expected: "pause" | "resume" | "stop"): TaskSummary | null => {
    const row = list.getState().data?.find((candidate) => candidate.id === id) ?? null;
    if (!row || !isScheduledWork(row)) return null;
    if (expected === "pause") return row.status === "paused" ? null : row;
    if (expected === "resume") return row.status === "paused" ? row : null;
    return row;
  };
  const lifecycle = (
    id: string,
    action: "pause" | "resume" | "stop",
    api: ScheduledWorkApi,
  ): Promise<SettingsMutationResult<TaskSummary[]>> => {
    if (list.getState().mutating) return Promise.resolve({ status: "ignored" });
    // After a lifecycle request began, retry only the canonical GET.
    // Replaying pause/stop after an uncertain network boundary could
    // apply a stale intent to a newer server state.
    if (hasPendingCanonicalRefresh()) {
      return list.retryLoad((scope) => api.list(scope)).then((result) => {
        if (result.status === "applied") refreshScope = null;
        return result;
      });
    }
    const row = validRow(id, action);
    if (!row) return Promise.resolve({ status: "ignored" });
    return list.mutate(
      async (scope) => {
        // A network failure cannot prove that the POST did not reach the
        // server. Fence the next gesture behind a canonical GET instead of
        // replaying a potentially stale pause/resume/stop intent.
        refreshScope = scope;
        if (action === "pause") await api.pause(scope, row.id);
        else if (action === "resume") await api.resume(scope, row.id);
        else await api.stop(scope, row.id);
      },
      (scope) => api.list(scope),
    ).then((result) => {
      if (result.status === "applied" || !hasPendingCanonicalRefresh()) refreshScope = null;
      return result;
    });
  };

  return {
    getState: () => list.getState(),
    subscribe: (listener) => list.subscribe(listener),
    setScope(scope, serverUrl = scope?.serverId ?? null, nextDetailScope = null) {
      list.setScope(scope);
      detailServerUrl = serverUrl;
      detailScope = nextDetailScope;
      detail.setTarget(null);
      clearPendingIfScopeChanged();
    },
    dispose() {
      refreshScope = null;
      list.dispose();
      detail.dispose();
    },
    load(api) { return list.load((scope) => api.list(scope)); },
    retry(api) {
      return list.retryLoad((scope) => api.list(scope)).then((result) => {
        // A user-selected Reload is the same canonical fence as the automatic
        // recovery before a later lifecycle action. Once it succeeds, allow
        // the next gesture through rather than consuming it with another GET.
        if (result.status === "applied") refreshScope = null;
        return result;
      });
    },
    getDetail(id, api) {
      if (!validRow(id, "stop")) return Promise.resolve({ status: "ignored" });
      const scope = detailScope;
      if (!scope || !detailServerUrl) return Promise.resolve({ status: "ignored" });
      const target: TaskDetailTarget = { ...scope, serverUrl: detailServerUrl, taskId: id };
      detail.setTarget(target);
      return detail.load({ detail: async (requestTarget) => api.detail(scope, requestTarget.taskId) });
    },
    clearDetail() {
      // Replacing the current scope invalidates a late detail completion and
      // drops completed run output when the sheet closes.
      detail.setTarget(null);
    },
    getDetailState: () => detail.getState(),
    subscribeDetail: (listener) => detail.subscribe(listener),
    hasPendingCanonicalRefresh,
    pause: (id, api) => lifecycle(id, "pause", api),
    resume: (id, api) => lifecycle(id, "resume", api),
    stop: (id, api) => lifecycle(id, "stop", api),
  };
}
