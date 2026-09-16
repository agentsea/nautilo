import { describe, expect, it } from 'vitest';
import '../../../../../src/view/canvas/test-canvas-env';
import { resolveArrowCalloutGuides } from '../../../../../src/view/canvas/shapes/callouts/arrow-callout-guides';
import { RIGHT_ARROW_CALLOUT_HANDLES } from '../../../../../src/view/canvas/shapes/callouts/right-arrow-callout';
import { LEFT_ARROW_CALLOUT_HANDLES } from '../../../../../src/view/canvas/shapes/callouts/left-arrow-callout';
import { UP_ARROW_CALLOUT_HANDLES } from '../../../../../src/view/canvas/shapes/callouts/up-arrow-callout';
import { DOWN_ARROW_CALLOUT_HANDLES } from '../../../../../src/view/canvas/shapes/callouts/down-arrow-callout';
import { LEFT_RIGHT_ARROW_CALLOUT_HANDLES } from '../../../../../src/view/canvas/shapes/callouts/left-right-arrow-callout';
import { UP_DOWN_ARROW_CALLOUT_HANDLES } from '../../../../../src/view/canvas/shapes/callouts/up-down-arrow-callout';
import { QUAD_ARROW_CALLOUT_HANDLES } from '../../../../../src/view/canvas/shapes/callouts/quad-arrow-callout';

const SINGLE_DEFAULTS = [25000, 25000, 25000, 64977] as const;
const BI_DEFAULTS = [25000, 25000, 25000, 48123] as const;

describe('directional arrow callout DrawingML guides', () => {
  it.each([
    ['square horizontal', 100, 100, false, false, 50000, 100000, 75000],
    ['wide horizontal', 200, 100, false, false, 50000, 200000, 87500],
    ['tall horizontal', 100, 200, false, false, 100000, 100000, 75000],
    ['square vertical', 100, 100, true, false, 50000, 100000, 75000],
    ['wide vertical', 200, 100, true, false, 100000, 100000, 75000],
    ['tall vertical', 100, 200, true, false, 50000, 200000, 87500],
    ['wide bidirectional', 200, 100, false, true, 50000, 100000, 75000],
    ['tall bidirectional', 100, 200, true, true, 50000, 100000, 75000],
  ] as const)(
    '%s computes the frame-derived domains',
    (_name, w, h, vertical, bidirectional, maxA2, maxA3, maxA4) => {
      const guides = resolveArrowCalloutGuides(w, h, undefined, {
        vertical,
        bidirectional,
        defaults: bidirectional ? BI_DEFAULTS : SINGLE_DEFAULTS,
      });
      expect(guides.maxA2).toBe(maxA2);
      expect(guides.maxA3).toBe(maxA3);
      expect(guides.maxA4).toBe(maxA4);
      expect(guides.maxA1).toBe(50000);
    },
  );

  it('pins imported values through the coupled guide chain without mutating them', () => {
    const imported = [90000, -1, 300000, 90000];
    const before = [...imported];
    const guides = resolveArrowCalloutGuides(200, 100, imported, {
      vertical: false,
      bidirectional: false,
      defaults: SINGLE_DEFAULTS,
    });
    expect(guides).toMatchObject({ a1: 0, a2: 0, a3: 200000, a4: 0 });
    expect(imported).toEqual(before);
  });

  it('places the default head handles at the rendered head corners', () => {
    expect(RIGHT_ARROW_CALLOUT_HANDLES[1].position({ w: 200, h: 100 }, [])).toEqual({ x: 175, y: 25 });
    expect(LEFT_ARROW_CALLOUT_HANDLES[1].position({ w: 200, h: 100 }, [])).toEqual({ x: 25, y: 25 });
    expect(UP_ARROW_CALLOUT_HANDLES[1].position({ w: 100, h: 200 }, [])).toEqual({ x: 75, y: 25 });
    expect(DOWN_ARROW_CALLOUT_HANDLES[1].position({ w: 100, h: 200 }, [])).toEqual({ x: 75, y: 175 });
    expect(LEFT_RIGHT_ARROW_CALLOUT_HANDLES[1].position({ w: 200, h: 100 }, [])).toEqual({ x: 25, y: 25 });
    expect(UP_DOWN_ARROW_CALLOUT_HANDLES[1].position({ w: 100, h: 200 }, [])).toEqual({ x: 75, y: 25 });
  });

  it('applies exact aspect-ratio domains and preserves untouched imported values', () => {
    const start = [12345, 999999, 888888, 777777];
    const before = [...start];
    expect(RIGHT_ARROW_CALLOUT_HANDLES[1].apply(
      { w: 200, h: 100 }, start, { x: 0, y: 0 },
    )).toEqual([12345, 50000, 200000, 777777]);
    expect(UP_ARROW_CALLOUT_HANDLES[1].apply(
      { w: 100, h: 200 }, start, { x: 100, y: 200 },
    )).toEqual([12345, 50000, 200000, 777777]);
    expect(LEFT_RIGHT_ARROW_CALLOUT_HANDLES[1].apply(
      { w: 200, h: 100 }, start, { x: 200, y: 0 },
    )).toEqual([12345, 50000, 100000, 777777]);
    expect(UP_DOWN_ARROW_CALLOUT_HANDLES[1].apply(
      { w: 100, h: 200 }, start, { x: 100, y: 200 },
    )).toEqual([12345, 50000, 100000, 777777]);
    expect(start).toEqual(before);
  });

  it('pins body and shaft drags against the effective head/depth guides', () => {
    const imported = [90000, -10, 300000, 90000];
    expect(RIGHT_ARROW_CALLOUT_HANDLES[0].apply(
      { w: 200, h: 100 }, imported, { x: 200, y: 0 },
    )).toEqual([0, -10, 300000, 0]);
    expect(LEFT_ARROW_CALLOUT_HANDLES[0].apply(
      { w: 200, h: 100 }, imported, { x: 0, y: 0 },
    )).toEqual([0, -10, 300000, 0]);
    expect(DOWN_ARROW_CALLOUT_HANDLES[0].apply(
      { w: 100, h: 200 }, imported, { x: 100, y: 200 },
    )).toEqual([0, -10, 300000, 0]);
  });

  it('keeps the quad callout coupled body/shaft handle exact and immutable', () => {
    const start = [90000, 10000, 45000, -20];
    const before = [...start];
    expect(QUAD_ARROW_CALLOUT_HANDLES[0].position({ w: 200, h: 100 }, start)).toEqual({ x: 120, y: 40 });
    expect(QUAD_ARROW_CALLOUT_HANDLES[0].apply(
      { w: 200, h: 100 }, start, { x: 200, y: 0 },
    )).toEqual([20000, 10000, 45000, 20000]);
    expect(start).toEqual(before);
  });
});
