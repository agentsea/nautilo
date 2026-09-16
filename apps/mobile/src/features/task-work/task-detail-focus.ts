import { sameTaskDetailTarget, type TaskDetailTarget } from "./task-detail-state";

/** First focus for an exact target is satisfied by its blocking load. */
export function taskDetailFocusRefreshDecision(
  previous: TaskDetailTarget | null,
  target: TaskDetailTarget | null,
): { readonly next: TaskDetailTarget | null; readonly refresh: boolean } {
  if (!target) return { next: null, refresh: false };
  return sameTaskDetailTarget(previous, target)
    ? { next: target, refresh: true }
    : { next: target, refresh: false };
}
