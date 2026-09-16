import { describe, expect, test } from "bun:test";
import { worldToScreen } from "@nautilo/office-board";
import { boundingBox } from "@nautilo/office-slides/node";
import { fitBoard, gridStep, viewportFrame, centerOn } from "./board-view";

describe("Board navigation retains unbounded scene geometry", () => {
  test("fits distant negative and positive objects without a zoom floor", () => {
    const frames = [
      { x: -100000, y: -20000, w: 600, h: 400, rotation: 0 },
      { x: 100000, y: 30000, w: 900, h: 500, rotation: Math.PI / 4 },
    ];
    const host = { w: 560, h: 800 };
    const view = fitBoard(frames, host)!;
    expect(view.zoom).toBeLessThan(0.1);
    for (const frame of frames) {
      const bounds = boundingBox(frame);
      const start = worldToScreen(view, bounds);
      const end = worldToScreen(view, {
        x: bounds.x + bounds.w,
        y: bounds.y + bounds.h,
      });
      expect(start.x).toBeGreaterThanOrEqual(0);
      expect(start.y).toBeGreaterThanOrEqual(0);
      expect(end.x).toBeLessThanOrEqual(host.w);
      expect(end.y).toBeLessThanOrEqual(host.h);
    }
  });
  test("empty or zero-size hosts do not invent a fit", () => {
    expect(fitBoard([], { w: 800, h: 600 })).toBeUndefined();
    expect(
      fitBoard([{ x: 0, y: 0, w: 1, h: 1, rotation: 0 }], { w: 0, h: 600 }),
    ).toBeUndefined();
  });
  test("tiny scenes can zoom beyond the inherited ceiling", () => {
    expect(
      fitBoard([{ x: 2, y: 3, w: 1, h: 1, rotation: 0 }], { w: 800, h: 600 })!
        .zoom,
    ).toBeGreaterThan(8);
  });
  test("centering changes only the view and minimap bounds round-trip", () => {
    const host = { w: 800, h: 600 };
    const at = { x: -567.8, y: 456.2 };
    const view = centerOn({ zoom: 0.075, panX: 200, panY: -80 }, at, host);
    expect(worldToScreen(view, at)).toEqual({ x: 400, y: 300 });
    const frame = viewportFrame(view, host);
    expect(worldToScreen(view, frame)).toEqual({ x: 0, y: 0 });
    expect(frame.w * view.zoom).toBeCloseTo(host.w);
    expect(frame.h * view.zoom).toBeCloseTo(host.h);
  });
  test("grid stays readable at navigation extremes without changing world coordinates", () => {
    for (const zoom of [0.00001, 0.05, 0.75, 1, 8, 1234]) {
      expect(gridStep(zoom) * zoom).toBeGreaterThanOrEqual(24);
      expect(gridStep(zoom) * zoom).toBeLessThan(48);
    }
  });
});
