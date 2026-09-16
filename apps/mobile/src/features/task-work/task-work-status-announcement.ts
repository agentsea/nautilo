import { taskWorkStatusLabel } from "./task-work-overview-row-presentation";
import type { TaskWorkViewState } from "./task-work-state";

export interface TaskWorkStatusAnnouncementState {
  readonly scopeKey: string | null;
  readonly initialized: boolean;
  readonly statuses: Readonly<Record<string, string>>;
}

export const EMPTY_TASK_WORK_STATUS_ANNOUNCEMENT: TaskWorkStatusAnnouncementState = Object.freeze({ scopeKey: null, initialized: false, statuses: {} });

function statusesFor(view: TaskWorkViewState): Readonly<Record<string, string>> {
  return Object.fromEntries(view.selectors.overviewRows.map((row) => [row.taskId, row.status]));
}

/**
 * Announces one fixed lifecycle receipt at most per render. It never observes
 * progress/activity/prompt/timing, and every new owner/server scope hydrates
 * silently before later canonical lifecycle transitions may announce.
 */
export function reduceTaskWorkStatusAnnouncement(input: {
  readonly previous: TaskWorkStatusAnnouncementState;
  readonly scopeKey: string | null;
  readonly view: TaskWorkViewState;
}): { readonly state: TaskWorkStatusAnnouncementState; readonly announcement: string | null } {
  const statuses = input.scopeKey === null ? {} : statusesFor(input.view);
  if (input.scopeKey === null || input.previous.scopeKey !== input.scopeKey || !input.previous.initialized) {
    return { state: { scopeKey: input.scopeKey, initialized: input.scopeKey !== null, statuses }, announcement: null };
  }
  const changed = input.view.selectors.overviewRows.find((row) => input.previous.statuses[row.taskId] !== undefined && input.previous.statuses[row.taskId] !== row.status)
    ?? input.view.selectors.overviewRows.find((row) => input.previous.statuses[row.taskId] === undefined);
  return {
    state: { scopeKey: input.scopeKey, initialized: true, statuses },
    announcement: changed ? `Delegated work status changed to ${taskWorkStatusLabel(changed.status)}.` : null,
  };
}
