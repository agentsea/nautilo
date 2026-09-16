/**
 * Presentation model for the Design creation bar.  It deliberately has no DOM
 * dependency: the shell measures its own available space and this module makes
 * the resulting wide/compact/minimal decision deterministic and testable.
 */

export type CreationBarMode = "wide" | "compact" | "minimal";

export type CreationBarMeasurements = {
  /** Width required by the labelled creation controls and direct view actions. */
  wide: number;
  /** Width required by icon-first controls plus the persistent save state. */
  compact: number;
};

/**
 * Pick the richest mode that fits the space actually offered to the top bar.
 * Callers measure intrinsic group widths rather than treating a device or
 * viewport size as a proxy for available room.
 */
export function creationBarModeForWidth(
  availableWidth: number,
  measurements: CreationBarMeasurements,
): CreationBarMode {
  if (availableWidth >= measurements.wide) return "wide";
  if (availableWidth >= measurements.compact) return "compact";
  return "minimal";
}

export type CreationActionId =
  | "select"
  | "frame"
  | "text"
  | "rectangle"
  | "ellipse"
  | "triangle"
  | "diamond"
  | "pentagon"
  | "hexagon"
  | "star"
  | "arrow"
  | "pen"
  | "connector";

export const SHAPE_ACTIONS = [
  "rectangle",
  "ellipse",
  "triangle",
  "diamond",
  "pentagon",
  "hexagon",
  "star",
  "arrow",
] as const satisfies readonly CreationActionId[];

export const PRIMARY_CREATION_ACTIONS = ["select", "frame", "text", "shapes", "pen", "connector"] as const;

export type OverflowGroupId = "edit" | "create" | "view";

export type OverflowAction =
  | "place-image"
  | "undo"
  | "redo"
  | CreationActionId
  | "layers"
  | "inspector"
  | "full-canvas";

/** Every action exposed by the complete wide bar, including shape-menu items. */
export const WIDE_BAR_ACTIONS = [
  "undo",
  "redo",
  "select",
  "frame",
  "text",
  ...SHAPE_ACTIONS,
  "pen",
  "connector",
  "place-image",
  "layers",
  "inspector",
  "full-canvas",
] as const satisfies readonly OverflowAction[];

/** A structured recovery map; this intentionally never becomes a flat menu. */
export function overflowActionsForMode(mode: CreationBarMode): Record<OverflowGroupId, readonly OverflowAction[]> {
  return {
    edit: mode === "wide" ? [] : ["undo", "redo"],
    create: mode === "wide"
      ? []
      : ["select", "frame", "text", ...SHAPE_ACTIONS, "pen", "connector", "place-image"],
    view: mode === "minimal" ? ["layers", "inspector"] : ["layers", "inspector", "full-canvas"],
  };
}

export function visiblePrimaryActions(mode: CreationBarMode): readonly ("select" | "frame" | "text" | "shapes" | "pen" | "connector")[] {
  if (mode === "minimal") return [];
  return PRIMARY_CREATION_ACTIONS;
}

/**
 * Direct controls in each presentation. Shape variants count as direct in
 * wide/compact because their visible Shapes control opens their named menu.
 */
export function directActionsForMode(mode: CreationBarMode): readonly OverflowAction[] {
  if (mode === "wide") return WIDE_BAR_ACTIONS;
  if (mode === "compact") return ["select", "frame", "text", ...SHAPE_ACTIONS, "pen", "connector", "place-image"];
  return ["full-canvas"];
}

export function isWideActionReachable(mode: CreationBarMode, action: OverflowAction): boolean {
  return directActionsForMode(mode).includes(action)
    || Object.values(overflowActionsForMode(mode)).some((actions) => actions.includes(action));
}

/** Presentation guarantees which cannot be sacrificed by a collapse. */
export function chromeInvariants(mode: CreationBarMode): {
  saveTruthVisible: true;
  activeToolVisible: true;
  overflowAvailable: boolean;
  fullCanvasReachable: true;
} {
  return {
    saveTruthVisible: true,
    activeToolVisible: true,
    overflowAvailable: mode !== "wide",
    fullCanvasReachable: true,
  };
}

export function actionLabel(action: CreationActionId): string {
  switch (action) {
    case "select": return "Select";
    case "frame": return "Frame";
    case "text": return "Text";
    case "rectangle": return "Rectangle";
    case "ellipse": return "Ellipse";
    case "triangle": return "Triangle";
    case "diamond": return "Diamond";
    case "pentagon": return "Pentagon";
    case "hexagon": return "Hexagon";
    case "star": return "Star";
    case "arrow": return "Arrow";
    case "pen": return "Pen";
    case "connector": return "Connector";
  }
}
