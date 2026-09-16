/**
 * Pure geometry for selection move/resize. A `Box` is an axis-aligned rectangle
 * in canvas coordinates (matching the scene-graph's absolute x/y/width/height).
 * Resizing pins the opposite edge/corner and clamps to `MIN_SIZE` without
 * flipping, so the box never inverts.
 */

export type Box = { x: number; y: number; width: number; height: number };

export const MIN_SIZE = 1;

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLE_IDS: readonly HandleId[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];

function affectsLeft(handle: HandleId): boolean {
  return handle === "nw" || handle === "w" || handle === "sw";
}

function affectsRight(handle: HandleId): boolean {
  return handle === "ne" || handle === "e" || handle === "se";
}

function affectsTop(handle: HandleId): boolean {
  return handle === "nw" || handle === "n" || handle === "ne";
}

function affectsBottom(handle: HandleId): boolean {
  return handle === "sw" || handle === "s" || handle === "se";
}

/** Translate a box by a canvas-space delta (used while dragging a selection). */
export function moveBox(start: Box, dx: number, dy: number): Box {
  return { x: start.x + dx, y: start.y + dy, width: start.width, height: start.height };
}

/**
 * Resize `start` by dragging `handle` a canvas-space delta of (dx, dy). The
 * edge/corner opposite the handle stays fixed; dimensions clamp to `MIN_SIZE`.
 */
export function resizeBox(handle: HandleId, start: Box, dx: number, dy: number): Box {
  let { x, y, width, height } = start;

  if (affectsLeft(handle)) {
    const nextX = start.x + dx;
    const right = start.x + start.width;
    x = Math.min(nextX, right - MIN_SIZE);
    width = right - x;
  } else if (affectsRight(handle)) {
    width = Math.max(MIN_SIZE, start.width + dx);
  }

  if (affectsTop(handle)) {
    const nextY = start.y + dy;
    const bottom = start.y + start.height;
    y = Math.min(nextY, bottom - MIN_SIZE);
    height = bottom - y;
  } else if (affectsBottom(handle)) {
    height = Math.max(MIN_SIZE, start.height + dy);
  }

  return { x, y, width, height };
}

/** Axis-aligned union of a list of boxes, or null when the list is empty. */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Map `box` from the `from` group bbox into the `to` group bbox, scaling and
 * translating proportionally. Used for multi-selection resize: every selected
 * node keeps its relative position/size within the group as the group box is
 * dragged. A zero-width/height group axis maps with scale 1 (no divide-by-zero).
 */
export function scaleBox(box: Box, from: Box, to: Box): Box {
  const sx = from.width === 0 ? 1 : to.width / from.width;
  const sy = from.height === 0 ? 1 : to.height / from.height;
  return {
    x: to.x + (box.x - from.x) * sx,
    y: to.y + (box.y - from.y) * sy,
    width: box.width * sx,
    height: box.height * sy,
  };
}

/** Canvas-coordinate anchor point for a handle on `box`. */
export function handlePoint(box: Box, handle: HandleId): { x: number; y: number } {
  const midX = box.x + box.width / 2;
  const midY = box.y + box.height / 2;
  const left = box.x;
  const right = box.x + box.width;
  const top = box.y;
  const bottom = box.y + box.height;
  switch (handle) {
    case "nw":
      return { x: left, y: top };
    case "n":
      return { x: midX, y: top };
    case "ne":
      return { x: right, y: top };
    case "e":
      return { x: right, y: midY };
    case "se":
      return { x: right, y: bottom };
    case "s":
      return { x: midX, y: bottom };
    case "sw":
      return { x: left, y: bottom };
    case "w":
      return { x: left, y: midY };
  }
}

/** CSS cursor name for a handle. */
export function handleCursor(handle: HandleId): string {
  switch (handle) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
  }
}
