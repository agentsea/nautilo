import { describe, it, expect } from "vitest";
import {
  MATH_EQUAL_ADJUSTMENTS,
  MATH_EQUAL_HANDLES,
  resolveMathEqualAdjustments,
} from "../../../../../src/view/canvas/shapes/equation/math-equal";

describe("MATH_EQUAL_HANDLES", () => {
  it("registers thickness and gap handles", () => {
    expect(MATH_EQUAL_HANDLES).toHaveLength(2);
    // bar = 23.52, gap = 11.76; upper-bar top y = 50 - 5.88 - 23.52 = 20.6
    const p0 = MATH_EQUAL_HANDLES[0].position(
      { w: 200, h: 100 },
      [23520, 11760],
    );
    expect(p0.x).toBe(100);
    expect(p0.y).toBeCloseTo(20.6, 2);
    // upper-bar bottom (gap top) y = 50 - 5.88 = 44.12
    const p1 = MATH_EQUAL_HANDLES[1].position(
      { w: 200, h: 100 },
      [23520, 11760],
    );
    expect(p1.y).toBeCloseTo(44.12, 2);
  });

  it("uses the exact fixed bar maximum and derives the gap maximum from it", () => {
    expect(MATH_EQUAL_ADJUSTMENTS[0].max).toBe(36745);
    expect(resolveMathEqualAdjustments([36745, 100000])).toEqual([
      36745, 26510,
    ]);
    expect(
      MATH_EQUAL_HANDLES[1].apply({ w: 100, h: 100 }, [36745, 11760, 23], {
        x: 100,
        y: -100,
      }),
    ).toEqual([36745, 26510, 23]);
  });

  it("recovers malformed values through preset defaults", () => {
    expect(
      resolveMathEqualAdjustments([Number.NaN, Number.POSITIVE_INFINITY]),
    ).toEqual([23520, 11760]);
  });
});
