import { describe, expect, test } from "bun:test";
import {
  handleCursor,
  handlePoint,
  HANDLE_IDS,
  MIN_SIZE,
  moveBox,
  resizeBox,
  scaleBox,
  unionBox,
  type Box,
} from "./handles";

const start: Box = { x: 100, y: 100, width: 200, height: 100 };

describe("moveBox", () => {
  test("translates without changing size", () => {
    expect(moveBox(start, 25, -10)).toEqual({ x: 125, y: 90, width: 200, height: 100 });
  });
});

describe("resizeBox", () => {
  test("east handle grows width, pins left edge", () => {
    expect(resizeBox("e", start, 40, 999)).toEqual({ x: 100, y: 100, width: 240, height: 100 });
  });

  test("south handle grows height, pins top edge", () => {
    expect(resizeBox("s", start, 0, 30)).toEqual({ x: 100, y: 100, width: 200, height: 130 });
  });

  test("nw handle moves origin and shrinks both dimensions", () => {
    expect(resizeBox("nw", start, 20, 10)).toEqual({ x: 120, y: 110, width: 180, height: 90 });
  });

  test("se handle grows both dimensions from the top-left", () => {
    expect(resizeBox("se", start, 50, 25)).toEqual({ x: 100, y: 100, width: 250, height: 125 });
  });

  test("clamps to MIN_SIZE without inverting when dragged past the opposite edge", () => {
    // Dragging the west handle far right would invert; clamp instead.
    const result = resizeBox("w", start, 1000, 0);
    expect(result.width).toBe(MIN_SIZE);
    expect(result.x).toBe(start.x + start.width - MIN_SIZE);
    // right edge preserved
    expect(result.x + result.width).toBe(start.x + start.width);
  });

  test("clamps east handle width to MIN_SIZE", () => {
    expect(resizeBox("e", start, -1000, 0).width).toBe(MIN_SIZE);
  });
});

describe("handlePoint", () => {
  test("returns canvas anchors for each handle", () => {
    expect(handlePoint(start, "nw")).toEqual({ x: 100, y: 100 });
    expect(handlePoint(start, "se")).toEqual({ x: 300, y: 200 });
    expect(handlePoint(start, "n")).toEqual({ x: 200, y: 100 });
    expect(handlePoint(start, "e")).toEqual({ x: 300, y: 150 });
  });

  test("all eight handles have a distinct point", () => {
    const points = HANDLE_IDS.map((id) => JSON.stringify(handlePoint(start, id)));
    expect(new Set(points).size).toBe(8);
  });
});

describe("unionBox", () => {
  test("returns null for an empty list", () => {
    expect(unionBox([])).toBeNull();
  });

  test("wraps a set of boxes in their axis-aligned union", () => {
    const a: Box = { x: 0, y: 0, width: 100, height: 100 };
    const b: Box = { x: 150, y: 50, width: 50, height: 200 };
    expect(unionBox([a, b])).toEqual({ x: 0, y: 0, width: 200, height: 250 });
  });

  test("a single box is its own union", () => {
    expect(unionBox([start])).toEqual(start);
  });
});

describe("scaleBox", () => {
  test("scales and translates a child box proportionally into the new group box", () => {
    const from: Box = { x: 0, y: 0, width: 100, height: 100 };
    const to: Box = { x: 0, y: 0, width: 200, height: 200 };
    const child: Box = { x: 50, y: 50, width: 20, height: 20 };
    expect(scaleBox(child, from, to)).toEqual({ x: 100, y: 100, width: 40, height: 40 });
  });

  test("translation-only group move preserves child sizes", () => {
    const from: Box = { x: 0, y: 0, width: 100, height: 100 };
    const to: Box = { x: 30, y: -10, width: 100, height: 100 };
    const child: Box = { x: 10, y: 10, width: 40, height: 40 };
    expect(scaleBox(child, from, to)).toEqual({ x: 40, y: 0, width: 40, height: 40 });
  });

  test("a child equal to the group maps exactly onto the new group box", () => {
    const from: Box = { x: 10, y: 20, width: 100, height: 60 };
    const to: Box = { x: 10, y: 20, width: 150, height: 60 };
    expect(scaleBox(from, from, to)).toEqual(to);
  });

  test("zero-size group axis uses scale 1 (no divide-by-zero)", () => {
    const from: Box = { x: 0, y: 0, width: 0, height: 100 };
    const to: Box = { x: 5, y: 0, width: 0, height: 200 };
    const child: Box = { x: 0, y: 50, width: 0, height: 10 };
    expect(scaleBox(child, from, to)).toEqual({ x: 5, y: 100, width: 0, height: 20 });
  });
});

describe("handleCursor", () => {
  test("maps opposite handles to the same diagonal cursor", () => {
    expect(handleCursor("nw")).toBe("nwse-resize");
    expect(handleCursor("se")).toBe("nwse-resize");
    expect(handleCursor("ne")).toBe("nesw-resize");
    expect(handleCursor("e")).toBe("ew-resize");
    expect(handleCursor("n")).toBe("ns-resize");
  });
});
