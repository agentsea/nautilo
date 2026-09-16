import { describe, it, expect } from 'vitest';
import { QUAD_ARROW_HANDLES } from '../../../../../src/view/canvas/shapes/arrows/quad-arrow';

describe('QUAD_ARROW_HANDLES', () => {
  it('registers three handles in OOXML shaft, head-width, head-length order', () => {
    expect(QUAD_ARROW_HANDLES).toHaveLength(3);
  });

  it('all three handles cluster near the top arrowhead at defaults', () => {
    const frame = { w: 200, h: 100 };
    const adj = [22500, 22500, 22500];
    const p0 = QUAD_ARROW_HANDLES[0].position(frame, adj); // shaft
    const p1 = QUAD_ARROW_HANDLES[1].position(frame, adj); // headWidth
    const p2 = QUAD_ARROW_HANDLES[2].position(frame, adj); // headLen
    expect(p0).toEqual({ x: 88.75, y: 22.5 });
    expect(p1).toEqual({ x: 122.5, y: 22.5 });
    expect(p2).toEqual({ x: 200, y: 22.5 });
  });

  it('shaft apply observes maxAdj1 = 2*adj2', () => {
    const next = QUAD_ARROW_HANDLES[0].apply(
      { w: 200, h: 100 },
      [30000, 35000, 22500],
      { x: 140, y: 50 },
    );
    expect(next).toEqual([70000, 35000, 22500]);
  });
});
