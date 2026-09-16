import { describe, it, expect } from 'vitest';
import { RIGHT_ARROW_HANDLES } from '../../../../../src/view/canvas/shapes/arrows/right-arrow';

describe('RIGHT_ARROW_HANDLES', () => {
  it('registers head-length and head-width handles', () => {
    expect(RIGHT_ARROW_HANDLES).toHaveLength(2);
  });

  it('handle 0 controls OOXML adj1 shaft width', () => {
    const p = RIGHT_ARROW_HANDLES[0].position({ w: 200, h: 100 }, [50000, 50000]);
    expect(p).toEqual({ x: 0, y: 25 });
  });

  it('handle 1 controls OOXML adj2 head length', () => {
    // The head-length handle sits at the top edge, x = w - headLen.
    const p = RIGHT_ARROW_HANDLES[1].position({ w: 200, h: 100 }, [50000, 50000]);
    expect(p).toEqual({ x: 150, y: 0 });
  });

  it('shaft apply preserves head-length index from start', () => {
    // Pointer on the centerline collapses shaft width without changing head length.
    const next = RIGHT_ARROW_HANDLES[0].apply({ w: 200, h: 100 }, [50000, 30000], { x: 150, y: 50 });
    expect(next).toEqual([0, 30000]);
  });

  it('head-length apply preserves shaft index and uses the frame maximum', () => {
    const next = RIGHT_ARROW_HANDLES[1].apply({ w: 200, h: 100 }, [40000, 50000], { x: -100, y: 0 });
    expect(next).toEqual([40000, 200000]);
  });
});
