import { describe, it, expect } from 'vitest';
import '../../../../../src/view/canvas/test-canvas-env';
import { createTestCanvas } from '../../../../../src/view/canvas/test-canvas-env';
import {
  buildCan,
  buildCanFaces,
} from '../../../../../src/view/canvas/shapes/basic/can';

describe('buildCan', () => {
  it('produces a cylinder side-view from the preset short-side guide', () => {
    const path = buildCan({ w: 100, h: 60 });
    const ctx = createTestCanvas(200, 200).getContext('2d');
    expect(ctx.isPointInPath(path, 50, 30)).toBe(true);
    expect(ctx.isPointInPath(path, 2, 2)).toBe(false);
    expect(ctx.isPointInPath(path, 98, 2)).toBe(false);
  });
});

describe('buildCanFaces', () => {
  it('returns the body (base) and a lightened top lid', () => {
    const faces = buildCanFaces({ w: 100, h: 60 });
    expect(faces).toHaveLength(2);
    const [body, lid] = faces;
    expect(body.shade ?? 0).toBe(0);
    expect(lid.shade).toBeGreaterThan(0); // lit lid
    const ctx = createTestCanvas(200, 200).getContext('2d');
    expect(ctx.isPointInPath(body.path, 50, 30)).toBe(true);
    // OOXML y1 = ss*adj/200000 = 7.5 at the default adjustment.
    expect(ctx.isPointInPath(lid.path, 50, 7.5)).toBe(true);
  });
});
