import { describe, it, expect } from "vitest";
import {
  MATH_PLUS_ADJUSTMENTS,
  MATH_PLUS_HANDLES,
} from "../../../../../src/view/canvas/shapes/equation/math-plus";

describe("MATH_PLUS_HANDLES", () => {
  it("registers a single arm-thickness handle", () => {
    expect(MATH_PLUS_HANDLES).toHaveLength(1);
    // t = 23520/100000 * min(200, 100) = 23.52; xL = (200-23.52)/2 = 88.24
    const p = MATH_PLUS_HANDLES[0].position({ w: 200, h: 100 }, [23520]);
    expect(p.x).toBeCloseTo(88.24, 2);
    expect(p.y).toBe(0);
  });

  it("admits the preset maximum and preserves the other model slots", () => {
    expect(MATH_PLUS_ADJUSTMENTS[0].max).toBe(73490);
    const next = MATH_PLUS_HANDLES[0].apply({ w: 200, h: 100 }, [23520, 77], {
      x: -100,
      y: 0,
    });
    expect(next).toEqual([73490, 77]);
  });
});
