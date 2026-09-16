import { describe, it, expect } from 'vitest';
import '../../../../../src/view/canvas/test-canvas-env';
import { createTestCanvas } from '../../../../../src/view/canvas/test-canvas-env';
import {
  buildUpDownArrow,
  UP_DOWN_ARROW_ADJUSTMENTS,
  UP_DOWN_ARROW_HANDLES,
} from '../../../../../src/view/canvas/shapes/arrows/up-down-arrow';

describe('buildUpDownArrow', () => {
  it('fills the shaft and both heads', () => {
    const path = buildUpDownArrow({ w: 100, h: 200 });
    const ctx = createTestCanvas(200, 400).getContext('2d');
    // Middle of the shaft.
    expect(ctx.isPointInPath(path, 50, 100)).toBe(true);
    // Top tip area.
    expect(ctx.isPointInPath(path, 50, 5)).toBe(true);
    // Outside the shape.
    expect(ctx.isPointInPath(path, 5, 100)).toBe(false);
  });

  it('keeps the OOXML shaft-width / head-length order and defaults', () => {
    expect(UP_DOWN_ARROW_ADJUSTMENTS[0].name).toMatch(/shaft/i);
    expect(UP_DOWN_ARROW_ADJUSTMENTS[0].defaultValue).toBe(50000);
    expect(UP_DOWN_ARROW_ADJUSTMENTS[1].name).toMatch(/length/i);
    expect(UP_DOWN_ARROW_ADJUSTMENTS[1].defaultValue).toBe(50000);
  });
});

describe('UP_DOWN_ARROW_HANDLES', () => {
  it('exposes two handles', () => {
    expect(UP_DOWN_ARROW_HANDLES.length).toBe(2);
  });

  it('uses the preset handle positions and frame-dependent head-length maximum', () => {
    const frame = { w: 100, h: 200 };
    expect(UP_DOWN_ARROW_HANDLES[0].position(frame, [50000, 50000])).toEqual({ x: 25, y: 150 });
    expect(UP_DOWN_ARROW_HANDLES[1].position(frame, [50000, 50000])).toEqual({ x: 0, y: 50 });

    expect(UP_DOWN_ARROW_HANDLES[1].apply(frame, [50000, 50000], { x: 0, y: 180 })).toEqual([
      50000,
      100000,
    ]);
  });
});
