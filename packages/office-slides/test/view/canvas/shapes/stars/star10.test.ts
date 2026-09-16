import { describe, it, expect } from 'vitest';
import '../../../../../src/view/canvas/test-canvas-env';
import { createTestCanvas } from '../../../../../src/view/canvas/test-canvas-env';
import { buildStar10 } from '../../../../../src/view/canvas/shapes/stars/star10';
import { buildStar4 } from '../../../../../src/view/canvas/shapes/stars/star4';
import { buildStar5 } from '../../../../../src/view/canvas/shapes/stars/star5';
import { buildStar6 } from '../../../../../src/view/canvas/shapes/stars/star6';
import { buildStar7 } from '../../../../../src/view/canvas/shapes/stars/star7';
import { buildStar8 } from '../../../../../src/view/canvas/shapes/stars/star8';
import { buildStar12 } from '../../../../../src/view/canvas/shapes/stars/star12';
import { buildStar16 } from '../../../../../src/view/canvas/shapes/stars/star16';
import { buildStar24 } from '../../../../../src/view/canvas/shapes/stars/star24';
import { buildStar32 } from '../../../../../src/view/canvas/shapes/stars/star32';

const STAR_BUILDERS = [
  buildStar4,
  buildStar5,
  buildStar6,
  buildStar7,
  buildStar8,
  buildStar10,
  buildStar12,
  buildStar16,
  buildStar24,
  buildStar32,
] as const;

describe('buildStar10', () => {
  it('contains the centre and excludes corners', () => {
    const path = buildStar10({ w: 100, h: 100 });
    const ctx = createTestCanvas(200, 200).getContext('2d');
    expect(ctx.isPointInPath(path, 50, 50)).toBe(true);  // centre
    expect(ctx.isPointInPath(path, 1, 1)).toBe(false);   // corner
    expect(ctx.isPointInPath(path, 99, 99)).toBe(false); // corner
  });

  it('apex-up vertex sits on the top edge', () => {
    const path = buildStar10({ w: 100, h: 100 });
    const ctx = createTestCanvas(200, 200).getContext('2d');
    // apex tip is at (50, 0); 1px in is inside
    expect(ctx.isPointInPath(path, 50, 1)).toBe(true);
  });

  it('honours custom inner-radius adjustment', () => {
    // inner radius 5% (very thin star) — points are sliver-thin,
    // so the centre is still inside but a generous off-axis point
    // corners remain outside
    const path = buildStar10({ w: 100, h: 100 }, [5000]);
    const ctx = createTestCanvas(200, 200).getContext('2d');
    expect(ctx.isPointInPath(path, 50, 50)).toBe(true);
    expect(ctx.isPointInPath(path, 1, 1)).toBe(false);
  });

  it.each(STAR_BUILDERS)(
    'pins stored and imported inner radii to the OOXML 0..50000 domain',
    (buildStar) => {
      const ctx = createTestCanvas(200, 200).getContext('2d');
      const belowAdjustments = [-10000];
      const aboveAdjustments = [90000];
      Object.freeze(belowAdjustments);
      Object.freeze(aboveAdjustments);
      const below = buildStar({ w: 100, h: 100 }, belowAdjustments);
      const atMin = buildStar({ w: 100, h: 100 }, [0]);
      const above = buildStar({ w: 100, h: 100 }, aboveAdjustments);
      const atMax = buildStar({ w: 100, h: 100 }, [50000]);

      for (let y = 0; y <= 100; y += 2) {
        for (let x = 0; x <= 100; x += 2) {
          expect(ctx.isPointInPath(below, x, y)).toBe(
            ctx.isPointInPath(atMin, x, y),
          );
          expect(ctx.isPointInPath(above, x, y)).toBe(
            ctx.isPointInPath(atMax, x, y),
          );
        }
      }
    },
  );
});
