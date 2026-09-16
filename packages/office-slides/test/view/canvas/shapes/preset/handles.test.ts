import { describe, expect, it } from "vitest";
import type { AdjustmentSpec } from "../../../../../src/view/canvas/shapes/builder";
import { presetAngularHandle, presetNumericHandle } from "../../../../../src/view/canvas/shapes/preset/handles";
import type { PresetShapeDef } from "../../../../../src/view/canvas/shapes/preset/types";

const DEF: PresetShapeDef = {
  adj: { adj1: 0 },
  guides: [],
  paths: [],
};

const SPEC: AdjustmentSpec = {
  name: "Many-turn angle",
  defaultValue: 0,
  min: 0,
  max: 10 * 360 * 60000,
};

const handle = presetAngularHandle({
  def: DEF,
  index: 0,
  posX: "hc",
  posY: "vc",
  spec: SPEC,
});

describe("presetAngularHandle", () => {
  it("derives the nearest branch across more than four turns", () => {
    const next = handle.apply({ w: 200, h: 200 }, [(8 * 360 + 355) * 60000], {
      x: 200,
      y: 100 + 100 * Math.tan((5 * Math.PI) / 180),
    });
    expect(next[0]).toBeCloseTo((9 * 360 + 5) * 60000, -3);
  });

  it("preserves exact negative-180 tie behavior", () => {
    const next = handle.apply({ w: 200, h: 200 }, [270 * 60000], {
      x: 100,
      y: 200,
    });
    expect(next[0]).toBe(90 * 60000);
  });

  it("recovers a malformed start with the preset default", () => {
    const next = handle.apply(
      { w: 200, h: 200 },
      [Number.POSITIVE_INFINITY, 17],
      { x: 200, y: 100 },
    );
    expect(next).toEqual([0]);
    expect(Number.isFinite(next[0])).toBe(true);
  });
});

describe("presetNumericHandle", () => {
  const def: PresetShapeDef = {
    adj: { adj1: 25000, adj2: 200000 },
    guides: [
      { name: "a", fmla: "pin 0 adj1 adj2" },
      { name: "x", fmla: "*/ w a 200000" },
    ],
    paths: [],
  };
  const numeric = presetNumericHandle({
    def, index: 0, posX: "x", posY: "vc",
    spec: { name: "Size", defaultValue: 25000, min: 0, max: 100000 },
    bounds: { min: "0", max: "adj2" },
  });
  it("searches beyond the static spec and retains sibling values", () => {
    expect(numeric.apply({ w: 200, h: 200 }, [25000, 200000], { x: 150, y: 100 }))
      .toEqual([150000, 200000]);
  });
  it("includes exact boundaries without rounding past fractional bounds", () => {
    const max = 33333.25;
    const next = numeric.apply({ w: 200, h: 200 }, [25000, max], { x: 190, y: 100 });
    expect(next).toEqual([max, max]);
  });
  it("preserves raw out-of-domain imported content on click without movement", () => {
    const start = [240000, 200000];
    const frame = { w: 200, h: 200 };
    expect(numeric.apply(frame, start, numeric.position(frame, start))).toEqual(start);
  });
});
