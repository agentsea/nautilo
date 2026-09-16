/**
 * Pure viewport transform for the design canvas: a uniform scale plus a screen
 * translation. Canvas coordinates are the scene-graph's absolute coordinates
 * (see scene-graph.ts); screen coordinates are pixels within the canvas
 * element. All functions are pure and return new `Viewport` values.
 *
 *   screen = canvas * scale + translate
 *   canvas = (screen - translate) / scale
 */

export type Point = { x: number; y: number };

export type Viewport = {
  scale: number;
  tx: number;
  ty: number;
};

export type Size = { width: number; height: number };

export type ViewportBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 64;

export function createViewport(): Viewport {
  return { scale: 1, tx: 0, ty: 0 };
}

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function screenToCanvas(viewport: Viewport, screen: Point): Point {
  return {
    x: (screen.x - viewport.tx) / viewport.scale,
    y: (screen.y - viewport.ty) / viewport.scale,
  };
}

export function canvasToScreen(viewport: Viewport, canvas: Point): Point {
  return {
    x: canvas.x * viewport.scale + viewport.tx,
    y: canvas.y * viewport.scale + viewport.ty,
  };
}

export function panBy(viewport: Viewport, dxScreen: number, dyScreen: number): Viewport {
  return { scale: viewport.scale, tx: viewport.tx + dxScreen, ty: viewport.ty + dyScreen };
}

/**
 * Zoom by `factor` around a fixed screen anchor (typically the pointer), so the
 * canvas point currently under `anchor` stays under `anchor` after the zoom.
 */
export function zoomAt(viewport: Viewport, factor: number, anchor: Point): Viewport {
  const nextScale = clampScale(viewport.scale * factor);
  const canvasPoint = screenToCanvas(viewport, anchor);
  return {
    scale: nextScale,
    tx: anchor.x - canvasPoint.x * nextScale,
    ty: anchor.y - canvasPoint.y * nextScale,
  };
}

/** Set an absolute zoom level while keeping `anchor` fixed on screen. */
export function setZoom(viewport: Viewport, nextScale: number, anchor: Point): Viewport {
  const clamped = clampScale(nextScale);
  const canvasPoint = screenToCanvas(viewport, anchor);
  return {
    scale: clamped,
    tx: anchor.x - canvasPoint.x * clamped,
    ty: anchor.y - canvasPoint.y * clamped,
  };
}

/**
 * Fit `bounds` (canvas coordinates) inside a viewport of `viewportSize` with a
 * screen-pixel `padding` margin, centered. Empty/degenerate bounds recenter at
 * scale 1.
 */
export function fitBounds(
  bounds: ViewportBounds,
  viewportSize: Size,
  padding = 48,
): Viewport {
  const contentWidth = bounds.maxX - bounds.minX;
  const contentHeight = bounds.maxY - bounds.minY;
  const availableWidth = Math.max(1, viewportSize.width - padding * 2);
  const availableHeight = Math.max(1, viewportSize.height - padding * 2);

  let scale = 1;
  if (contentWidth > 0 && contentHeight > 0) {
    scale = clampScale(Math.min(availableWidth / contentWidth, availableHeight / contentHeight));
  } else if (contentWidth > 0) {
    scale = clampScale(availableWidth / contentWidth);
  } else if (contentHeight > 0) {
    scale = clampScale(availableHeight / contentHeight);
  }

  const centerX = bounds.minX + contentWidth / 2;
  const centerY = bounds.minY + contentHeight / 2;
  return {
    scale,
    tx: viewportSize.width / 2 - centerX * scale,
    ty: viewportSize.height / 2 - centerY * scale,
  };
}
