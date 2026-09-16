import { describe, it, expect } from 'vitest';
import { DOWN_ARROW_HANDLES } from '../../../../../src/view/canvas/shapes/arrows/down-arrow';

describe('DOWN_ARROW_HANDLES', () => {
  it('registers head-length and head-width handles, head on bottom', () => {
    expect(DOWN_ARROW_HANDLES).toHaveLength(2);
    // Handle zero adjusts shaft width; handle one adjusts head length.
    const p = DOWN_ARROW_HANDLES[0].position({ w: 200, h: 100 }, [50000, 50000]);
    expect(p).toEqual({ x: 50, y: 0 });
    expect(DOWN_ARROW_HANDLES[1].apply({ w: 200, h: 100 }, [50000, 50000], { x: 0, y: -100 })).toEqual([50000, 100000]);
  });
});
