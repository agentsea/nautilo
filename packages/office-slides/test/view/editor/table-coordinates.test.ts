import { describe, expect, it } from 'vitest';
import {
  clampInsidePair,
  projectIntoBoundaryIntervals,
} from '../../../src/view/editor/table-coordinates';

describe('table coordinate constraints', () => {
  it('preserves positive adjacent sizes without imposing a minimum width', () => {
    const pairEnd = 0.2;
    const boundary = clampInsidePair(10, 0, pairEnd, 0.05);
    expect(boundary).toBeLessThan(pairEnd);
    expect(boundary).toBeGreaterThan(0);
    expect(boundary + (pairEnd - boundary)).toBe(pairEnd);
  });

  it('retains the imported boundary when no floating-point interior exists', () => {
    const start = 1;
    const end = 1 + Number.EPSILON;
    expect(clampInsidePair(2, start, end, start)).toBe(start);
  });

  it('projects outside range drags into subpixel terminal cells', () => {
    const boundaries = [0, 0.1, 0.2];
    expect(projectIntoBoundaryIntervals(100, boundaries)).toBeCloseTo(0.15);
    expect(projectIntoBoundaryIntervals(-100, boundaries)).toBeCloseTo(0.05);
  });

  it('leaves an inside pointer unchanged', () => {
    expect(projectIntoBoundaryIntervals(0.125, [0, 0.1, 0.2])).toBe(0.125);
  });

  it('stays below an excluded last boundary when midpoint rounds up', () => {
    const last = 1 + Number.EPSILON;
    expect(projectIntoBoundaryIntervals(2, [0, 1, last])).toBe(1);
  });
});
