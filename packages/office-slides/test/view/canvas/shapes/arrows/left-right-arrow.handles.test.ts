import { describe, it, expect } from 'vitest';
import { LEFT_RIGHT_ARROW_HANDLES } from '../../../../../src/view/canvas/shapes/arrows/left-right-arrow';

describe('LEFT_RIGHT_ARROW_HANDLES', () => {
  it('registers OOXML shaft-width and head-length handles', () => {
    expect(LEFT_RIGHT_ARROW_HANDLES).toHaveLength(2);
    // Preset adj1 handle is at x3 = w - headLength, y1 = halfHeight - shaftHalf.
    const p = LEFT_RIGHT_ARROW_HANDLES[0].position(
      { w: 200, h: 100 },
      [50000, 50000],
    );
    expect(p).toEqual({ x: 150, y: 25 });
  });

  it('caps the head handle x at w/2 in tall boxes (matches builder)', () => {
    // Tall box: w=100, h=400 → ss=100. adj=100000 → head=100 uncapped,
    // but buildLeftRightArrow caps head at w/2=50. The handle must mirror
    // that cap so its x lands on the actual head base, not past it.
    const frame = { w: 100, h: 400 };
    const p0 = LEFT_RIGHT_ARROW_HANDLES[0].position(frame, [100000, 50000]);
    expect(p0.y).toBeCloseTo(8, 5);
    const p1 = LEFT_RIGHT_ARROW_HANDLES[1].position(frame, [100000, 50000]);
    expect(p1.x).toBeCloseTo(50, 5);
  });

  it('head-length apply scales by the shorter side (ss)', () => {
    // ss=100; pointer.x = 50 → head/ss = 50/100 = 0.5 → 50000
    const next = LEFT_RIGHT_ARROW_HANDLES[1].apply(
      { w: 200, h: 100 },
      [50000, 50000],
      { x: 50, y: 50 },
    );
    expect(next[1]).toBe(50000);
  });
});
