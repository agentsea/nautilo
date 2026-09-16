import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { evalGuides } from '../../../../../src/view/canvas/shapes/preset/formula';
import type { PresetShapeDef } from '../../../../../src/view/canvas/shapes/preset/types';
import { curvedArrowHandles, type CurvedDirection } from '../../../../../src/view/canvas/shapes/arrows/curved';
import { CIRCULAR_ARROW_HANDLES } from '../../../../../src/view/canvas/shapes/arrows/circular-arrow';
import { UTURN_ARROW_HANDLES } from '../../../../../src/view/canvas/shapes/arrows/uturn-arrow';

// Read the independent bundled XML rather than importing the transcribed
// production definition: wrong slot/guide wiring must fail this comparison.
const xml = new DOMParser().parseFromString(
  readFileSync(new URL('../../../../../scripts/presetShapeDefinitions.xml', import.meta.url), 'utf8').replace(/^\uFEFF/, ''),
  'application/xml',
);
const circular = xml.getElementsByTagName('circularArrow')[0];
const ns = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const adjNodes = circular.getElementsByTagNameNS(ns, 'avLst')[0].getElementsByTagNameNS(ns, 'gd');
const guideNodes = circular.getElementsByTagNameNS(ns, 'gdLst')[0].getElementsByTagNameNS(ns, 'gd');
const circularOracle: PresetShapeDef = {
  adj: Object.fromEntries(Array.from(adjNodes, node => [
    node.getAttribute('name')!, Number(node.getAttribute('fmla')!.split(' ')[1]),
  ])),
  guides: Array.from(guideNodes, node => ({ name: node.getAttribute('name')!, fmla: node.getAttribute('fmla')! })),
  paths: [],
};

describe('preset domains follow the frame and sibling guides', () => {
  it.each([{ w: 200, h: 200 }, { w: 600, h: 180 }, { w: 180, h: 600 }])(
    'uses the circular spread domain from the independent XML guide chain in %j', frame => {
      const start = [12500, 1142319, 20457681, 10800000, 12500];
      const max = evalGuides(frame, circularOracle, start)('maxAng');
      const target = Math.round(max * 0.6);
      const handle = CIRCULAR_ARROW_HANDLES[2];
      const next = handle.apply(frame, start, handle.position(frame, [start[0], target, ...start.slice(2)]));
      expect(next[1]).toBeCloseTo(target, 0);
      expect(next[1]).toBeLessThanOrEqual(max);
      expect(next.filter((_, i) => i !== 1)).toEqual(start.filter((_, i) => i !== 1));
    },
  );

  it.each([
    ['right', { w: 120, h: 600 }],
    ['left', { w: 120, h: 600 }],
    ['up', { w: 600, h: 120 }],
    ['down', { w: 600, h: 120 }],
  ] as const)('allows %s curved heads wider than a fixed 100000 range', (direction, frame) => {
    // maxAdj2 = 50000 * transverse dimension / ss = 250000.
    const handle = curvedArrowHandles(direction)[1];
    const start = [25000, 50000, 25000];
    const point = handle.position(frame, [25000, 180000, 25000]);
    const next = handle.apply(frame, start, point);
    expect(next[1]).toBeCloseTo(180000, 0);
    expect(next[0]).toBe(start[0]);
    expect(next[2]).toBe(start[2]);
    expect(start).toEqual([25000, 50000, 25000]);
  });

  it.each([
    ['right', { w: 600, h: 120 }],
    ['left', { w: 600, h: 120 }],
    ['up', { w: 120, h: 600 }],
    ['down', { w: 120, h: 600 }],
  ] as const)('allows %s curved head length beyond the former static interval', (direction, frame) => {
    const handle = curvedArrowHandles(direction)[2];
    const start = [25000, 50000, 25000];
    const next = handle.apply(frame, start, handle.position(frame, [25000, 50000, 180000]));
    expect(next[2]).toBeCloseTo(180000, 0);
  });

  it.each(['right', 'left', 'up', 'down'] satisfies CurvedDirection[])(
    'preserves imported %s curved adjustments on a no-move gesture', (direction) => {
      const frame = { w: 600, h: 180 };
      const start = [40000, 45000, 130000];
      for (const handle of curvedArrowHandles(direction)) {
        expect(handle.apply(frame, start, handle.position(frame, start))).toEqual(start);
      }
    },
  );

  it('pins uturn thickness to twice the sibling head width', () => {
    const frame = { w: 200, h: 200 };
    const start = [10000, 8000, 25000, 43750, 75000];
    const next = UTURN_ARROW_HANDLES[0].apply(frame, start, { x: 180, y: 192 });
    expect(next[0]).toBe(16000);
    expect(next.slice(1)).toEqual(start.slice(1));
  });

  it('derives uturn bend radius from the head position and frame', () => {
    const frame = { w: 600, h: 120 };
    const start = [25000, 25000, 25000, 43750, 75000];
    // bw=292.5, y4=60, ss=120 => maxAdj4=50000.
    const next = UTURN_ARROW_HANDLES[3].apply(frame, start, { x: 580, y: 8 });
    expect(next[3]).toBe(50000);
  });

  it('derives the minimum uturn arm height from shaft and head length', () => {
    const frame = { w: 200, h: 200 };
    const start = [25000, 25000, 40000, 10000, 75000];
    // minAdj5=(a1+a3)*ss/h = 65000.
    const next = UTURN_ARROW_HANDLES[4].apply(frame, start, { x: 192, y: -20 });
    expect(next[4]).toBe(65000);
    expect(next.slice(0, 4)).toEqual(start.slice(0, 4));
  });

  it.each([{ w: 200, h: 200 }, { w: 600, h: 180 }, { w: 180, h: 600 }])(
    'preserves circular imported values and angular identity in frame %j', (frame) => {
      const start = [10000, 1142319, 18000000, 9000000, 20000];
      for (const index of [2, 3, 4]) {
        const handle = CIRCULAR_ARROW_HANDLES[index];
        expect(handle.apply(frame, start, handle.position(frame, start))).toEqual(start);
      }
      const handle = CIRCULAR_ARROW_HANDLES[3];
      const next = handle.apply(frame, start, handle.position(frame, [18000, ...start.slice(1)]));
      expect(next[0]).toBeCloseTo(18000, 0);
      expect(next.slice(1)).toEqual(start.slice(1));
    },
  );
});
