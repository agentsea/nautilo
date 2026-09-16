import type { TaskWorkRow, TaskWorkViewState } from "./task-work-state";

const EDGE_GUTTER_PX = 20;
const DOWNWARD_THRESHOLD_PX = 12;
const VERTICAL_DOMINANCE = 1.25;

export function shouldOpenTaskWorkOverviewFromHandle(input: {
  readonly dx: number;
  readonly dy: number;
  readonly startX: number;
  readonly windowWidth: number;
}): boolean {
  return input.windowWidth > EDGE_GUTTER_PX * 2
    && input.startX > EDGE_GUTTER_PX
    && input.startX < input.windowWidth - EDGE_GUTTER_PX
    && input.dy >= DOWNWARD_THRESHOLD_PX
    && input.dy >= Math.abs(input.dx) * VERTICAL_DOMINANCE;
}

export type TaskWorkStripProjection = {
  readonly row: TaskWorkRow;
  readonly taskCount: number;
  readonly actionNeeded: boolean;
} | null;

/** Pure strip rule: only immediate relevant work earns chat-height. */
export function projectTaskWorkStrip(view: TaskWorkViewState): TaskWorkStripProjection {
  if (view.kind === "idle" || view.kind === "empty" || view.kind === "unsupported" || view.selectors.quiet) return null;
  const row = view.selectors.topRows[0];
  if (!row) return null;
  return {
    row,
    taskCount: view.selectors.topRows.length,
    actionNeeded: view.selectors.actionNeeded.some((candidate) => candidate.taskId === row.taskId),
  };
}

export type TaskWorkStripOpenState = { readonly pullClaimed: boolean };
export type TaskWorkStripOpenAction = "press-start" | "press" | "pull" | "release";

export type TaskWorkStripInteraction = "open" | "close" | "inert";

export function taskWorkStripInteraction(input: {
  readonly expanded: boolean;
  readonly canOpen: boolean;
  readonly canClose: boolean;
}): TaskWorkStripInteraction {
  if (input.expanded) return input.canClose ? "close" : "inert";
  return input.canOpen ? "open" : "inert";
}

/** Prevent one recognized pull and its following Pressable tap from opening twice. */
export function reduceTaskWorkStripOpen(
  state: TaskWorkStripOpenState,
  action: TaskWorkStripOpenAction,
): { readonly state: TaskWorkStripOpenState; readonly shouldOpen: boolean } {
  // A new physical tap always starts with onPressIn. This clears a prior
  // pull's ghost-press latch without relying on timer/event-loop ordering.
  if (action === "press-start") return { state: { pullClaimed: false }, shouldOpen: false };
  // Keep the one pull suppression across release: platforms differ on whether
  // Pressable fires before or after responder release.
  if (action === "release") return { state, shouldOpen: false };
  if (action === "pull") {
    return state.pullClaimed
      ? { state, shouldOpen: false }
      : { state: { pullClaimed: true }, shouldOpen: true };
  }
  return state.pullClaimed
    ? { state: { pullClaimed: false }, shouldOpen: false }
    : { state, shouldOpen: true };
}

export type TaskAgentAvatarRenderState = {
  readonly scopeKey: string;
  readonly headers: Record<string, string> | undefined;
  readonly imageFailed: boolean;
};

/** A mismatched scope must synchronously fall back before its async token load settles. */
export function shouldRenderTaskAgentAvatarImage(
  state: TaskAgentAvatarRenderState,
  currentScopeKey: string,
): boolean {
  return state.scopeKey === currentScopeKey && state.headers !== undefined && !state.imageFailed;
}

export function taskAgentAvatarTokenLoaded(
  state: TaskAgentAvatarRenderState,
  scopeKey: string,
  token: string | null,
): TaskAgentAvatarRenderState {
  if (state.scopeKey !== scopeKey) return state;
  return { ...state, headers: token ? { Authorization: `Bearer ${token}` } : undefined };
}
