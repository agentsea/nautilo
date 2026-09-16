import { describe, it, expect } from 'vitest';
import '../../../../../src/view/canvas/test-canvas-env';
import { buildSwooshArrow, SWOOSH_ARROW_HANDLES } from '../../../../../src/view/canvas/shapes/arrows/swoosh-arrow';

describe('buildSwooshArrow', () => {
  it('produces a Path2D (geometry covered by registry snapshot)', () => {
    // The swoosh curve crosses the frame diagonally and the path
    // shim's polygon hit-test loses precision on long thin
    // crescents; pin the snapshot for geometry.
    expect(buildSwooshArrow({ w: 200, h: 200 })).toBeInstanceOf(Path2D);
  });
});

describe('SWOOSH_ARROW_HANDLES', () => {
  it('exposes two handles', () => {
    expect(SWOOSH_ARROW_HANDLES.length).toBe(2);
  });

  it('uses the preset maxAdj2 = 70000*w/ss on a wide frame', () => {
    const frame = { w: 200, h: 100 };
    const next = SWOOSH_ARROW_HANDLES[1].apply(frame, [25000, 16667], { x: 0, y: 0 });
    expect(next).toEqual([25000, 140000]);
    expect(SWOOSH_ARROW_HANDLES[1].position(frame, next)).toEqual({ x: 60, y: 12.5 });
  });
});
