// Modified by Nautilo: use the owned Office packages.
import {
  type Viewport,
  worldToScreen,
  screenToWorld,
} from "@nautilo/office-slides/node";

export { type Viewport, worldToScreen, screenToWorld };

export const DEFAULT_VIEWPORT: Viewport = { panX: 0, panY: 0, zoom: 1 };

/** Zoom about a screen anchor. Optional bounds belong to the caller's UI policy.
 * No implicit magnification ceiling; reject non-invertible or overflowing math.
 */
export function zoomAt(
  v: Viewport,
  screenPt: { x: number; y: number },
  factor: number,
  min?: number,
  max?: number,
): Viewport {
  assertViewport(v);
  if (
    ![screenPt.x, screenPt.y, factor].every(Number.isFinite) ||
    factor <= 0 ||
    (min !== undefined && (!Number.isFinite(min) || min <= 0)) ||
    (max !== undefined && (!Number.isFinite(max) || max <= 0)) ||
    (min !== undefined && max !== undefined && min > max)
  ) {
    throw new RangeError(
      "Zoom requires finite coordinates, a positive factor and ordered positive bounds",
    );
  }
  let zoom = v.zoom * factor;
  if (min !== undefined) zoom = Math.max(min, zoom);
  if (max !== undefined) zoom = Math.min(max, zoom);
  // Keep worldPt fixed: screenPt = worldPt*zoom + pan  →  pan = screenPt - worldPt*zoom
  const worldPt = screenToWorld(v, screenPt);
  const next = {
    zoom,
    panX: screenPt.x - worldPt.x * zoom,
    panY: screenPt.y - worldPt.y * zoom,
  };
  assertViewport(next);
  return next;
}

export function panBy(
  v: Viewport,
  dxScreen: number,
  dyScreen: number,
): Viewport {
  assertViewport(v);
  const next = { ...v, panX: v.panX + dxScreen, panY: v.panY + dyScreen };
  assertViewport(next);
  return next;
}

function assertViewport(v: Viewport): void {
  if (![v.zoom, v.panX, v.panY].every(Number.isFinite) || v.zoom <= 0) {
    throw new RangeError(
      "Viewport must have finite coordinates and positive finite zoom",
    );
  }
}
