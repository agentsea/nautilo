import { describe, it, expect } from "vitest";
import {
  MATH_DIVIDE_ADJUSTMENTS,
  MATH_DIVIDE_HANDLES,
  resolveMathDivideAdjustments,
} from "../../../../../src/view/canvas/shapes/equation/math-divide";

describe("MATH_DIVIDE_HANDLES", () => {
  it("registers bar, gap, and dot-radius handles in OOXML order", () => {
    expect(MATH_DIVIDE_HANDLES).toHaveLength(3);
    // OOXML defaults [bar 23520, gap 5880, radius 11760] over h=100:
    // half-bar 11.76 → bar-top y = 50 - 11.76 = 38.24.
    const p0 = MATH_DIVIDE_HANDLES[0].position(
      { w: 200, h: 100 },
      [23520, 5880, 11760],
    );
    expect(p0.y).toBeCloseTo(38.24, 2);
    // The preset's coupled maxAdj2 resolves the declared 5880 gap to
    // 2930 at the default bar/radius. The dot centre is therefore 23.55.
    const p1 = MATH_DIVIDE_HANDLES[1].position(
      { w: 200, h: 100 },
      [23520, 5880, 11760],
    );
    expect(p1.x).toBeCloseTo(100, 2);
    expect(p1.y).toBeCloseTo(36.775, 2);
  });

  it("derives radius and gap maxima from bar, frame, and radius", () => {
    expect(MATH_DIVIDE_ADJUSTMENTS[0]).toMatchObject({ min: 1000, max: 36745 });
    expect(MATH_DIVIDE_ADJUSTMENTS[1].max).toBe(72490);
    expect(MATH_DIVIDE_ADJUSTMENTS[2].max).toBe(18122.5);
    expect(resolveMathDivideAdjustments(200, 100, [1000, 99999, 99999])).toEqual([1000, 0, 18122.5]);
    expect(resolveMathDivideAdjustments(0.01, 100, [1000, 11760, 99999])[2]).toBeCloseTo(3.6745);
    expect(
      resolveMathDivideAdjustments(200, 100, [23520, 99999, 99999]),
    ).toEqual([23520, 0, 12492.5]);
    expect(resolveMathDivideAdjustments(20, 100, [1000, 99999, 99999])).toEqual(
      [1000, 43094, 7349],
    );
  });

  it("clamps the edited slot without reordering or dropping sibling slots", () => {
    const gap = MATH_DIVIDE_HANDLES[1].apply(
      { w: 200, h: 100 },
      [23520, 5880, 11760, 7],
      { x: 1000, y: 0 },
    );
    expect(gap).toEqual([23520, 2930, 11760, 7]);

    const radius = MATH_DIVIDE_HANDLES[2].apply(
      { w: 200, h: 100 },
      [23520, 5880, 11760, 7],
      { x: 1000, y: 0 },
    );
    expect(radius).toEqual([23520, 5880, 12492.5, 7]);
  });

  it("matches ordered preset pin semantics when maxAdj3 is below its minimum", () => {
    expect(resolveMathDivideAdjustments(1, 100, [23520, 5880, 11760])).toEqual([
      23520, 5880, 367.45,
    ]);
    expect(resolveMathDivideAdjustments(1, 100, [23520, 5880, 0])[2]).toBe(
      1000,
    );
  });

  it("recovers malformed values through exact preset defaults", () => {
    expect(
      resolveMathDivideAdjustments(200, 100, [Number.NaN, Infinity, -Infinity]),
    ).toEqual([23520, 2930, 11760]);
  });
});
