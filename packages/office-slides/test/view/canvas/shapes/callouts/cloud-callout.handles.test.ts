import { describe, it, expect } from 'vitest';
import { CLOUD_CALLOUT_HANDLES } from '../../../../../src/view/canvas/shapes/callouts/cloud-callout';

describe('CLOUD_CALLOUT_HANDLES', () => {
  it('registers one point-axis tail handle', () => {
    expect(CLOUD_CALLOUT_HANDLES).toHaveLength(1);
    const p = CLOUD_CALLOUT_HANDLES[0].position(
      { w: 200, h: 100 },
      [0, 0],
    );
    expect(p).toEqual({ x: 100, y: 50 }); // tail at frame centre
  });

  it('preserves legal signed DrawingML coordinates beyond the old UI range', () => {
    const next = CLOUD_CALLOUT_HANDLES[0].apply(
      { w: 100, h: 100 },
      [-20833, 62500],
      { x: 1050, y: -950 },
    );
    expect(next).toEqual([1000000, -1000000]);
  });
});
