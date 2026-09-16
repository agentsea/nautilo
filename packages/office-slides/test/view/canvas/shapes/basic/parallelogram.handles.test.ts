import { describe, it, expect } from 'vitest';
import { PARALLELOGRAM_HANDLES } from '../../../../../src/view/canvas/shapes/basic/parallelogram';

describe('PARALLELOGRAM_HANDLES', () => {
  it('registers a single linear-x handle on the top edge', () => {
    expect(PARALLELOGRAM_HANDLES).toHaveLength(1);
    const p = PARALLELOGRAM_HANDLES[0].position({ w: 200, h: 100 }, [25000]);
    expect(p).toEqual({ x: 25, y: 0 }); // x2 = ss*adj/100000
  });

  it('reaches the frame-derived preset maximum on a wide frame', () => {
    expect(PARALLELOGRAM_HANDLES[0].apply(
      { w: 200, h: 100 }, [25000], { x: 200, y: 0 },
    )).toEqual([200000]);
  });
});
