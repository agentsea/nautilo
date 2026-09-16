import { describe, it, expect } from 'vitest';
import { LEFT_ARROW_HANDLES } from '../../../../../src/view/canvas/shapes/arrows/left-arrow';

describe('LEFT_ARROW_HANDLES', () => {
  it('registers shaft-width and head-length handles in OOXML order', () => {
    expect(LEFT_ARROW_HANDLES).toHaveLength(2);
    // Handle zero adjusts shaft width; handle one adjusts head length.
    const p = LEFT_ARROW_HANDLES[0].position({ w: 200, h: 100 }, [50000, 50000]);
    expect(p).toEqual({ x: 200, y: 25 });
    expect(LEFT_ARROW_HANDLES[1].position({ w: 200, h: 100 }, [50000, 150000])).toEqual({ x: 150, y: 0 });
  });
});
