// Reconstructible, transient timeline gesture state. No member represents an
// EDL write: callers lower a completed proposal through one validated command.

import type { TimelineSnapResult } from "./snap-index";

export type TimelineInteractionKind =
  | "idle"
  | "move"
  | "trim-left"
  | "trim-right"
  | "playhead"
  | "range-wing"
  | "divider"
  | "cancelled";

export type TimelinePointerPosition = {
  x: number;
  y: number;
};

export type TimelineInteractionStart = {
  pointer: TimelinePointerPosition;
  frame: number;
  selectionIds?: readonly string[];
};

export type TimelineInteractionCurrent = {
  pointer: TimelinePointerPosition;
  frame: number;
};

export type TimelineInteractionProposal = {
  /** The proposed fields are intentionally generic and are never durable here. */
  readonly [field: string]: unknown;
};

export type TimelineIdleInteractionState = { kind: "idle" };

export type TimelineCancelledInteractionState = {
  kind: "cancelled";
  cancelledKind: Exclude<TimelineInteractionKind, "idle" | "cancelled">;
  start: TimelineInteractionStart;
  current: TimelineInteractionCurrent;
};

export type TimelineActiveInteractionState = {
  kind: Exclude<TimelineInteractionKind, "idle" | "cancelled">;
  start: TimelineInteractionStart;
  current: TimelineInteractionCurrent;
  proposal: TimelineInteractionProposal;
  snap?: TimelineSnapResult;
};

export type TimelineInteractionState =
  | TimelineIdleInteractionState
  | TimelineCancelledInteractionState
  | TimelineActiveInteractionState;

export type BeginTimelineInteractionInput = {
  kind: TimelineActiveInteractionState["kind"];
  start: TimelineInteractionStart;
  proposal: TimelineInteractionProposal;
  snap?: TimelineSnapResult;
};

export type AdvanceTimelineInteractionInput = {
  current: TimelineInteractionCurrent;
  proposal: TimelineInteractionProposal;
  snap?: TimelineSnapResult;
};

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function copyPointer(pointer: TimelinePointerPosition): TimelinePointerPosition {
  assertFinite(pointer.x, "Pointer x");
  assertFinite(pointer.y, "Pointer y");
  return { x: pointer.x, y: pointer.y };
}

function copyStart(start: TimelineInteractionStart): TimelineInteractionStart {
  assertFinite(start.frame, "Start frame");
  return {
    pointer: copyPointer(start.pointer),
    frame: start.frame,
    ...(start.selectionIds ? { selectionIds: [...start.selectionIds] } : {}),
  };
}

function copyCurrent(current: TimelineInteractionCurrent): TimelineInteractionCurrent {
  assertFinite(current.frame, "Current frame");
  return { pointer: copyPointer(current.pointer), frame: current.frame };
}

function copyProposal(proposal: TimelineInteractionProposal): TimelineInteractionProposal {
  // Proposal values are opaque to this state machine. A deep structured clone
  // prevents an update to a caller-owned nested array/object from changing the
  // transient proposal after the gesture has begun.
  return structuredClone(proposal);
}

export function createIdleTimelineInteraction(): TimelineIdleInteractionState {
  return { kind: "idle" };
}

/** Begin a gesture without touching canonical document or layout state. */
export function beginTimelineInteraction(input: BeginTimelineInteractionInput): TimelineActiveInteractionState {
  return {
    kind: input.kind,
    start: copyStart(input.start),
    current: { pointer: copyPointer(input.start.pointer), frame: input.start.frame },
    proposal: copyProposal(input.proposal),
    ...(input.snap ? { snap: input.snap } : {}),
  };
}

/** Advance an active gesture with a wholly new transient proposal. */
export function advanceTimelineInteraction(
  state: TimelineInteractionState,
  input: AdvanceTimelineInteractionInput,
): TimelineInteractionState {
  if (state.kind === "idle" || state.kind === "cancelled") return state;
  return {
    kind: state.kind,
    start: copyStart(state.start),
    current: copyCurrent(input.current),
    proposal: copyProposal(input.proposal),
    ...(input.snap ? { snap: input.snap } : {}),
  };
}

/** Cancel discards the proposal while retaining enough diagnostic UI context. */
export function cancelTimelineInteraction(state: TimelineInteractionState): TimelineInteractionState {
  if (state.kind === "idle" || state.kind === "cancelled") return state;
  return {
    kind: "cancelled",
    cancelledKind: state.kind,
    start: copyStart(state.start),
    current: copyCurrent(state.current),
  };
}

/** Gesture completion is a caller-owned transaction boundary; reset is pure. */
export function resetTimelineInteraction(): TimelineIdleInteractionState {
  return createIdleTimelineInteraction();
}

export function isActiveTimelineInteraction(state: TimelineInteractionState): state is TimelineActiveInteractionState {
  return state.kind !== "idle" && state.kind !== "cancelled";
}
