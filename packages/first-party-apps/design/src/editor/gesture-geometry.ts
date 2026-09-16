/**
 * Pure pointer-gesture geometry. The interaction controller owns DOM events;
 * these helpers keep modifier, marquee, and screen-space snapping semantics
 * independently testable.
 */

import { nodeVisualBounds, transformPoint } from "../geometry";
import type { GeometryMatrix } from "../geometry";
import type { DesignDocument } from "../scene-graph";
import { isNodeEffectivelyLocked, paintOrder } from "./selection";
import { handlePoint, MIN_SIZE, type Box, type HandleId } from "./handles";
import type { Point, Viewport } from "./viewport";

export type GestureModifiers = { shiftKey: boolean; altKey: boolean };

export type SnapGuide = { axis: "x" | "y"; value: number };

export type SnapResult = { box: Box; guides: SnapGuide[] };

/** Screen-pixel proximity for deliberate alignment, independent of zoom. */
export const SNAP_TOLERANCE_PX = 6;

function signOrPositive(value: number): number {
  return value < 0 ? -1 : 1;
}

/** Shift constrains shapes to a square and lines/connectors to 45-degree angles. */
export function constrainDragPoint(
  start: Point,
  current: Point,
  constrainAspectOrAngle: boolean,
  lineLike: boolean,
): Point {
  if (!constrainAspectOrAngle) return current;
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  if (lineLike) {
    const length = Math.hypot(dx, dy);
    if (length === 0) return current;
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return { x: start.x + length * Math.cos(angle), y: start.y + length * Math.sin(angle) };
  }
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: start.x + signOrPositive(dx) * side, y: start.y + signOrPositive(dy) * side };
}

/** Alt makes the drag origin the center; otherwise it stays the anchored corner. */
export function dragBox(start: Point, end: Point, centered: boolean): Box {
  if (centered) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    return { x: start.x - Math.abs(dx), y: start.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 };
  }
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

/** Resize a box symmetrically around its center for Alt-dragged handles. */
export function resizeBoxFromCenter(handle: HandleId, start: Box, dx: number, dy: number): Box {
  const horizontal = handle === "nw" || handle === "w" || handle === "sw" || handle === "ne" || handle === "e" || handle === "se";
  const vertical = handle === "nw" || handle === "n" || handle === "ne" || handle === "sw" || handle === "s" || handle === "se";
  const horizontalDirection = handle === "nw" || handle === "w" || handle === "sw" ? -1 : 1;
  const verticalDirection = handle === "nw" || handle === "n" || handle === "ne" ? -1 : 1;
  const width = horizontal ? Math.max(1, start.width + horizontalDirection * dx * 2) : start.width;
  const height = vertical ? Math.max(1, start.height + verticalDirection * dy * 2) : start.height;
  return {
    x: start.x + (start.width - width) / 2,
    y: start.y + (start.height - height) / 2,
    width,
    height,
  };
}

function resizeAxes(handle: HandleId): { horizontal: -1 | 0 | 1; vertical: -1 | 0 | 1 } {
  return {
    horizontal: handle === "nw" || handle === "w" || handle === "sw" ? -1
      : handle === "ne" || handle === "e" || handle === "se" ? 1 : 0,
    vertical: handle === "nw" || handle === "n" || handle === "ne" ? -1
      : handle === "sw" || handle === "s" || handle === "se" ? 1 : 0,
  };
}

type ResizeAspectAxis = "x" | "y";

/**
 * Resize from a handle while keeping either its opposite anchor or the box
 * center fixed. Shift derives the other dimension from the starting aspect
 * ratio; edge resizes keep their unhandled axis centered.
 */
export function resizeBoxWithModifiers(
  handle: HandleId,
  start: Box,
  dx: number,
  dy: number,
  centered: boolean,
  preserveAspect: boolean,
  aspectAxis?: ResizeAspectAxis,
): Box {
  if (!preserveAspect) {
    return centered
      ? resizeBoxFromCenter(handle, start, dx, dy)
      : resizeBoxFromHandle(handle, start, dx, dy);
  }
  const axes = resizeAxes(handle);
  const ratio = start.width > 0 && start.height > 0 ? start.width / start.height : 1;
  const horizontalScale = axes.horizontal === 0 ? -Infinity : Math.abs(dx / start.width);
  const verticalScale = axes.vertical === 0 ? -Infinity : Math.abs(dy / start.height);
  const axis = aspectAxis ?? (horizontalScale >= verticalScale ? "x" : "y");
  const multiplier = centered ? 2 : 1;
  let width: number;
  let height: number;
  if (axis === "x") {
    const rawWidth = start.width + axes.horizontal * dx * multiplier;
    width = Math.max(MIN_SIZE, ratio * MIN_SIZE, rawWidth);
    height = width / ratio;
  } else {
    const rawHeight = start.height + axes.vertical * dy * multiplier;
    height = Math.max(MIN_SIZE, MIN_SIZE / ratio, rawHeight);
    width = height * ratio;
  }
  const centerX = start.x + start.width / 2;
  const centerY = start.y + start.height / 2;
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  return {
    x: centered ? centerX - width / 2 : axes.horizontal < 0 ? right - width : axes.horizontal > 0 ? start.x : centerX - width / 2,
    y: centered ? centerY - height / 2 : axes.vertical < 0 ? bottom - height : axes.vertical > 0 ? start.y : centerY - height / 2,
    width,
    height,
  };
}

function resizeBoxFromHandle(handle: HandleId, start: Box, dx: number, dy: number): Box {
  const axes = resizeAxes(handle);
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  const x = axes.horizontal < 0 ? Math.min(start.x + dx, right - MIN_SIZE) : start.x;
  const y = axes.vertical < 0 ? Math.min(start.y + dy, bottom - MIN_SIZE) : start.y;
  return {
    x,
    y,
    width: axes.horizontal < 0 ? right - x : axes.horizontal > 0 ? Math.max(MIN_SIZE, start.width + dx) : start.width,
    height: axes.vertical < 0 ? bottom - y : axes.vertical > 0 ? Math.max(MIN_SIZE, start.height + dy) : start.height,
  };
}

/** The world affine matrix that maps every point in `from` into `to`. */
export function boxAffineMatrix(from: Box, to: Box): GeometryMatrix {
  const a = from.width === 0 ? 1 : to.width / from.width;
  const d = from.height === 0 ? 1 : to.height / from.height;
  return { a, b: 0, c: 0, d, e: to.x - a * from.x, f: to.y - d * from.y };
}

/** Return drag endpoints suitable for vector primitive builders. */
export function creationEndpoints(start: Point, end: Point, centered: boolean): { start: Point; end: Point } {
  if (!centered) return { start, end };
  return {
    start: { x: start.x - (end.x - start.x), y: start.y - (end.y - start.y) },
    end,
  };
}

export function boxIntersects(a: Box, b: Box): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

/** Select every visible, unlocked page object whose visual bounds meet the marquee. */
export function marqueeSelectionIds(doc: DesignDocument, pageId: string, marquee: Box): string[] {
  return paintOrder(doc, pageId)
    .filter((node) => !isNodeEffectivelyLocked(doc, node) && boxIntersects(marquee, boundsToBox(nodeVisualBounds(node))))
    .map((node) => node.id);
}

/** Snap all three horizontal/vertical box anchors against every relevant page object. */
export function snapBoxToPageObjects(
  doc: DesignDocument,
  pageId: string,
  box: Box,
  excludedIds: ReadonlySet<string>,
  viewport: Viewport,
  tolerancePx = SNAP_TOLERANCE_PX,
): SnapResult {
  const excluded = new Set(excludedIds);
  const excludeDescendants = (id: string): void => {
    const node = doc.nodes[id];
    if (!node) return;
    for (const childId of node.childIds) {
      if (excluded.has(childId)) continue;
      excluded.add(childId);
      excludeDescendants(childId);
    }
  };
  for (const id of excludedIds) excludeDescendants(id);
  const targetsX: number[] = [];
  const targetsY: number[] = [];
  for (const node of paintOrder(doc, pageId)) {
    if (node.hidden || excluded.has(node.id)) continue;
    const bounds = nodeVisualBounds(node);
    targetsX.push(bounds.minX, (bounds.minX + bounds.maxX) / 2, bounds.maxX);
    targetsY.push(bounds.minY, (bounds.minY + bounds.maxY) / 2, bounds.maxY);
  }
  const snapAxis = (values: readonly number[], targets: readonly number[]) => {
    let best: { source: number; target: number; distancePx: number } | null = null;
    for (const source of values) {
      for (const target of targets) {
        const distancePx = Math.abs(target - source) * viewport.scale;
        if (distancePx > tolerancePx || (best && distancePx >= best.distancePx)) continue;
        best = { source, target, distancePx };
      }
    }
    return best;
  };
  const x = snapAxis([box.x, box.x + box.width / 2, box.x + box.width], targetsX);
  const y = snapAxis([box.y, box.y + box.height / 2, box.y + box.height], targetsY);
  return {
    box: { x: box.x + (x ? x.target - x.source : 0), y: box.y + (y ? y.target - y.source : 0), width: box.width, height: box.height },
    guides: [
      ...(x ? [{ axis: "x" as const, value: x.target }] : []),
      ...(y ? [{ axis: "y" as const, value: y.target }] : []),
    ],
  };
}

export type ResizeSnapOptions = {
  centered: boolean;
  preserveAspect: boolean;
};

/**
 * Snap only the coordinates controlled by a resize handle. A normal resize
 * keeps its opposite anchor fixed; an Alt resize keeps its center fixed. When
 * Shift preserves aspect, a single closest guide wins so a second axis cannot
 * distort the ratio.
 */
export function snapResizeBoxToPageObjects(
  doc: DesignDocument,
  pageId: string,
  handle: HandleId,
  start: Box,
  dx: number,
  dy: number,
  excludedIds: ReadonlySet<string>,
  viewport: Viewport,
  options: ResizeSnapOptions,
): SnapResult {
  const unsnapped = resizeBoxWithModifiers(
    handle,
    start,
    dx,
    dy,
    options.centered,
    options.preserveAspect,
  );
  const axes = resizeAxes(handle);
  const targets = snapTargets(doc, pageId, excludedIds);
  const candidates: Array<{ axis: ResizeAspectAxis; target: number; distancePx: number }> = [];
  if (axes.horizontal !== 0) {
    const source = axes.horizontal < 0 ? unsnapped.x : unsnapped.x + unsnapped.width;
    const candidate = nearestSnap(source, targets.x, viewport);
    if (candidate) candidates.push({ axis: "x", ...candidate });
  }
  if (axes.vertical !== 0) {
    const source = axes.vertical < 0 ? unsnapped.y : unsnapped.y + unsnapped.height;
    const candidate = nearestSnap(source, targets.y, viewport);
    if (candidate) candidates.push({ axis: "y", ...candidate });
  }
  if (candidates.length === 0) return { box: unsnapped, guides: [] };

  const fromStart = (axis: ResizeAspectAxis, target: number): number => {
    if (axis === "x") return target - (axes.horizontal < 0 ? start.x : start.x + start.width);
    return target - (axes.vertical < 0 ? start.y : start.y + start.height);
  };
  if (options.preserveAspect) {
    const candidate = candidates.reduce((best, next) => next.distancePx < best.distancePx ? next : best);
    const next = resizeBoxWithModifiers(
      handle,
      start,
      candidate.axis === "x" ? fromStart("x", candidate.target) : dx,
      candidate.axis === "y" ? fromStart("y", candidate.target) : dy,
      options.centered,
      true,
      candidate.axis,
    );
    return { box: next, guides: [{ axis: candidate.axis, value: candidate.target }] };
  }

  const x = candidates.find((candidate) => candidate.axis === "x");
  const y = candidates.find((candidate) => candidate.axis === "y");
  const next = resizeBoxWithModifiers(
    handle,
    start,
    x ? fromStart("x", x.target) : dx,
    y ? fromStart("y", y.target) : dy,
    options.centered,
    false,
  );
  return {
    box: next,
    guides: [
      ...(x ? [{ axis: "x" as const, value: x.target }] : []),
      ...(y ? [{ axis: "y" as const, value: y.target }] : []),
    ],
  };
}

/** Snap a transformed handle to a reachable page guide in its own resize axes. */
export function snapTransformedResizeBoxToPageObjects(
  doc: DesignDocument,
  pageId: string,
  handle: HandleId,
  start: Box,
  dx: number,
  dy: number,
  excludedIds: ReadonlySet<string>,
  viewport: Viewport,
  options: ResizeSnapOptions,
  transform: GeometryMatrix,
): SnapResult {
  const resize = (x: number, y: number, axis?: ResizeAspectAxis) =>
    resizeBoxWithModifiers(handle, start, x, y, options.centered, options.preserveAspect, axis);
  const unsnapped = resize(dx, dy);
  const worldHandle = (box: Box) => transformPoint(handlePoint(box, handle), transform);
  const point = worldHandle(unsnapped);
  const targets = snapTargets(doc, pageId, excludedIds);
  const candidates = (["x", "y"] as const).flatMap((axis) => {
    const candidate = nearestSnap(point[axis], targets[axis], viewport);
    return candidate ? [{ axis, ...candidate }] : [];
  }).sort((a, b) => a.distancePx - b.distancePx);
  const axes = resizeAxes(handle);
  const dominantAxis: ResizeAspectAxis = axes.horizontal === 0 ? "y" : axes.vertical === 0 ? "x"
    : Math.abs(dx / start.width) >= Math.abs(dy / start.height) ? "x" : "y";
  const localAxes = (["x", "y"] as const).filter((axis) =>
    options.preserveAspect ? axis === dominantAxis
      : axis === "x" ? axes.horizontal !== 0 : axes.vertical !== 0);
  for (const candidate of candidates) {
    // Each permitted local dimension gives a linear path for this handle.
    // Solve along it, retaining opposite-anchor/Alt-center and Shift aspect.
    for (const axis of localAxes) {
      const baseline = resize(dx, dy, axis);
      const origin = worldHandle(baseline)[candidate.axis];
      const sample = resize(dx + (axis === "x" ? 1 : 0), dy + (axis === "y" ? 1 : 0), axis);
      const slope = worldHandle(sample)[candidate.axis] - origin;
      if (slope === 0 || !Number.isFinite(slope)) continue;
      const correction = (candidate.target - origin) / slope;
      const box = resize(dx + (axis === "x" ? correction : 0), dy + (axis === "y" ? correction : 0), axis);
      const actual = worldHandle(box);
      // Clamping or numeric cancellation can make a guide unreachable. Do not
      // display alignment unless the actual transformed handle reaches it.
      const error = Math.abs(actual[candidate.axis] - candidate.target);
      const tolerance = Number.EPSILON * Math.max(1, Math.abs(candidate.target), Math.abs(origin)) * 64;
      if (error > tolerance || !Number.isFinite(actual.x) || !Number.isFinite(actual.y)) continue;
      if (Math.hypot(actual.x - point.x, actual.y - point.y) * viewport.scale > SNAP_TOLERANCE_PX) continue;
      return { box, guides: [{ axis: candidate.axis, value: candidate.target }] };
    }
  }
  return { box: unsnapped, guides: [] };
}

function snapTargets(doc: DesignDocument, pageId: string, excludedIds: ReadonlySet<string>): { x: number[]; y: number[] } {
  const excluded = new Set(excludedIds);
  const excludeDescendants = (id: string): void => {
    const node = doc.nodes[id];
    if (!node) return;
    for (const childId of node.childIds) {
      if (excluded.has(childId)) continue;
      excluded.add(childId);
      excludeDescendants(childId);
    }
  };
  for (const id of excludedIds) excludeDescendants(id);
  const x: number[] = [];
  const y: number[] = [];
  for (const node of paintOrder(doc, pageId)) {
    if (node.hidden || excluded.has(node.id)) continue;
    const bounds = nodeVisualBounds(node);
    x.push(bounds.minX, (bounds.minX + bounds.maxX) / 2, bounds.maxX);
    y.push(bounds.minY, (bounds.minY + bounds.maxY) / 2, bounds.maxY);
  }
  return { x, y };
}

function nearestSnap(source: number, targets: readonly number[], viewport: Viewport): { target: number; distancePx: number } | null {
  let best: { target: number; distancePx: number } | null = null;
  for (const target of targets) {
    const distancePx = Math.abs(target - source) * viewport.scale;
    if (distancePx > SNAP_TOLERANCE_PX || (best && distancePx >= best.distancePx)) continue;
    best = { target, distancePx };
  }
  return best;
}

function boundsToBox(bounds: { minX: number; minY: number; maxX: number; maxY: number }): Box {
  return { x: bounds.minX, y: bounds.minY, width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY };
}
