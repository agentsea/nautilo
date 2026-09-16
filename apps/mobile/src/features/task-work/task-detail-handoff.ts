import { isExactTaskId } from "./task-detail-state";
import type { TaskWorkViewState } from "./task-work-state";

export interface TaskDetailHandoffInput {
  /** The scope that mounted this overview, not a Task authority of its own. */
  readonly openOverviewScopeKey: string | null;
  /** The current Room/server/viewer scope at the instant of the press. */
  readonly currentOverviewScopeKey: string | null;
  readonly roomId: string;
  readonly taskId: string;
  readonly view: TaskWorkViewState;
}

export type TaskDetailHandoff =
  | { readonly status: "navigate"; readonly taskId: string; readonly originRoomId: string }
  | { readonly status: "ignored" };

/**
 * A tiny per-mounted-overview press latch. It owns neither Task data nor route
 * data: canonical overview/detail controllers remain their respective sources
 * of truth. Its only job is to turn one scope-valid row press into one push.
 */
export interface TaskDetailHandoffCoordinator {
  begin(input: TaskDetailHandoffInput): TaskDetailHandoff;
  reset(): void;
}

function isCurrentOverviewTask(input: TaskDetailHandoffInput): boolean {
  return input.openOverviewScopeKey !== null
    && input.openOverviewScopeKey === input.currentOverviewScopeKey
    && input.view.scope !== null
    && input.view.selectors.overviewRows.some((row) => row.taskId === input.taskId);
}

export function createTaskDetailHandoffCoordinator(): TaskDetailHandoffCoordinator {
  let handedOff = false;

  return {
    begin(input) {
      if (handedOff || !isExactTaskId(input.taskId) || !isCurrentOverviewTask(input)) {
        return { status: "ignored" };
      }
      handedOff = true;
      return { status: "navigate", taskId: input.taskId, originRoomId: input.roomId };
    },
    // A newly opened overview is a new deliberate interaction. Keeping the
    // latch until then makes a rapid multi-tap unable to enqueue another route.
    reset() { handedOff = false; },
  };
}
