import { describe, expect, test } from "bun:test";
import {
  canvasToScreen,
  clampScale,
  createViewport,
  fitBounds,
  MAX_SCALE,
  MIN_SCALE,
  panBy,
  screenToCanvas,
  setZoom,
  zoomAt,
  type Viewport,
} from "./viewport";

describe("viewport coordinate math", () => {
  test("screen/canvas round-trips under scale and translation", () => {
    const viewport: Viewport = { scale: 2, tx: 30, ty: -10 };
    const canvas = { x: 15, y: 40 };
    const screen = canvasToScreen(viewport, canvas);
    expect(screen).toEqual({ x: 60, y: 70 });
    expect(screenToCanvas(viewport, screen)).toEqual(canvas);
  });

  test("panBy shifts translation, not scale", () => {
    const viewport = createViewport();
    expect(panBy(viewport, 10, -5)).toEqual({ scale: 1, tx: 10, ty: -5 });
  });

  test("clampScale enforces min/max bounds", () => {
    expect(clampScale(1000)).toBe(MAX_SCALE);
    expect(clampScale(0.0001)).toBe(MIN_SCALE);
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(2)).toBe(2);
  });
});

describe("zoomAt", () => {
  test("keeps the anchor's canvas point fixed on screen", () => {
    const viewport: Viewport = { scale: 1, tx: 0, ty: 0 };
    const anchor = { x: 100, y: 100 };
    const before = screenToCanvas(viewport, anchor);
    const zoomed = zoomAt(viewport, 2, anchor);
    expect(zoomed.scale).toBe(2);
    const after = screenToCanvas(zoomed, anchor);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });

  test("respects scale clamping", () => {
    const viewport: Viewport = { scale: MAX_SCALE, tx: 0, ty: 0 };
    expect(zoomAt(viewport, 4, { x: 0, y: 0 }).scale).toBe(MAX_SCALE);
  });
});

describe("setZoom", () => {
  test("sets an absolute scale while keeping the anchor fixed", () => {
    const viewport: Viewport = { scale: 1, tx: 20, ty: 20 };
    const anchor = { x: 50, y: 50 };
    const before = screenToCanvas(viewport, anchor);
    const zoomed = setZoom(viewport, 3, anchor);
    expect(zoomed.scale).toBe(3);
    const after = screenToCanvas(zoomed, anchor);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });
});

describe("fitBounds", () => {
  test("centers content and scales to fit within padding", () => {
    const viewport = fitBounds(
      { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      { width: 400, height: 400 },
      50,
    );
    // available = 300x300, content 100x100 -> scale 3
    expect(viewport.scale).toBe(3);
    // center of content (50,50) maps to viewport center (200,200)
    const center = canvasToScreen(viewport, { x: 50, y: 50 });
    expect(center.x).toBeCloseTo(200, 6);
    expect(center.y).toBeCloseTo(200, 6);
  });

  test("recenters degenerate bounds at scale 1", () => {
    const viewport = fitBounds(
      { minX: 10, minY: 10, maxX: 10, maxY: 10 },
      { width: 200, height: 200 },
      20,
    );
    expect(viewport.scale).toBe(1);
    const center = canvasToScreen(viewport, { x: 10, y: 10 });
    expect(center.x).toBeCloseTo(100, 6);
    expect(center.y).toBeCloseTo(100, 6);
  });
});
