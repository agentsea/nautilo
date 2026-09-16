import type { PathBuilder, AdjustmentSpec, AdjustmentHandle } from '../builder';
import { adj } from '../builder';

/**
 * `parallelogram` — quadrilateral with two horizontal sides and two
 * slanted sides.
 *
 * Adjustments:
 *   [0] slant — top-left horizontal offset as OOXML thousandths of `w`;
 *       default 25000 (25%).
 */
export const PARALLELOGRAM_ADJUSTMENTS: readonly AdjustmentSpec[] = [
  { name: 'Slant', defaultValue: 25000, min: 0, max: 100000 },
];

export const buildParallelogram: PathBuilder = ({ w, h }, adjustments) => {
  const ss = Math.min(w, h);
  const max = ss > 0 ? 100000 * w / ss : 0;
  const a = Math.max(0, Math.min(max, adj(adjustments, 0, 25000)));
  const slant = (a / 100000) * ss;
  const path = new Path2D();
  path.moveTo(slant, 0);
  path.lineTo(w, 0);
  path.lineTo(w - slant, h);
  path.lineTo(0, h);
  path.closePath();
  return path;
};

export const PARALLELOGRAM_HANDLES: readonly AdjustmentHandle[] = [
  {
    position: ({ w, h }, values) => {
      const ss = Math.min(w, h);
      const max = ss > 0 ? 100000 * w / ss : 0;
      return { x: ss * Math.max(0, Math.min(max, values[0] ?? 25000)) / 100000, y: 0 };
    },
    apply: ({ w, h }, _start, pointer) => {
      const ss = Math.min(w, h);
      const max = ss > 0 ? 100000 * w / ss : 0;
      const raw = ss > 0 ? pointer.x * 100000 / ss : 0;
      return [Math.max(0, Math.min(max, Math.round(raw)))];
    },
  },
];
