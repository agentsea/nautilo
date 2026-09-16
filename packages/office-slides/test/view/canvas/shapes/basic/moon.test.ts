import { describe, it, expect } from 'vitest';
import '../../../../../src/view/canvas/test-canvas-env';
import { createTestCanvas } from '../../../../../src/view/canvas/test-canvas-env';
import { buildMoon, MOON_ADJUSTMENTS, MOON_HANDLES } from '../../../../../src/view/canvas/shapes/basic/moon';

describe('buildMoon', () => {
  it('fills the crescent on the left side', () => {
    const path = buildMoon({ w: 100, h: 100 });
    const ctx = createTestCanvas(200, 200).getContext('2d');
    expect(ctx.isPointInPath(path, 5, 50)).toBe(true);
  });

  it('default thickness is 50000', () => {
    expect(MOON_ADJUSTMENTS[0].defaultValue).toBe(50000);
  });

  it('evaluates imported out-of-range adjustments through the preset pin guide', () => {
    const ctx = createTestCanvas(200, 200).getContext('2d');
    const below = buildMoon({ w: 100, h: 100 }, [-25000]);
    const atMin = buildMoon({ w: 100, h: 100 }, [0]);
    const above = buildMoon({ w: 100, h: 100 }, [100000]);
    const atMax = buildMoon({ w: 100, h: 100 }, [87500]);
    for (let y = 5; y < 100; y += 10) {
      for (let x = 5; x < 100; x += 10) {
        expect(ctx.isPointInPath(below, x, y)).toBe(ctx.isPointInPath(atMin, x, y));
        expect(ctx.isPointInPath(above, x, y)).toBe(ctx.isPointInPath(atMax, x, y));
      }
    }
  });
});

describe('MOON_HANDLES', () => {
  it('exposes one handle', () => {
    expect(MOON_HANDLES.length).toBe(1);
  });
});
