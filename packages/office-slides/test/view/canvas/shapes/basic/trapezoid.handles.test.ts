import { describe, it, expect } from 'vitest';
import { TRAPEZOID_HANDLES } from '../../../../../src/view/canvas/shapes/basic/trapezoid';

describe('TRAPEZOID_HANDLES', () => {
  it('registers a single linear-x handle on the top edge', () => {
    expect(TRAPEZOID_HANDLES).toHaveLength(1);
    const p = TRAPEZOID_HANDLES[0].position({ w: 200, h: 100 }, [25000]);
    expect(p).toEqual({ x: 25, y: 0 }); // x2 = ss*adj/100000
  });

  it('reaches the frame-derived half-width maximum on a wide frame', () => {
    expect(TRAPEZOID_HANDLES[0].apply(
      { w: 200, h: 100 }, [25000], { x: 100, y: 0 },
    )).toEqual([100000]);
  });
});
