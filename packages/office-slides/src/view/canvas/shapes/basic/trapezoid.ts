import type { PathBuilder, AdjustmentSpec, AdjustmentHandle } from '../builder';
import { adj } from '../builder';

/**
 * `trapezoid` — narrower top, full-width bottom.
 *
 * Adjustments:
 *   [0] topInset — symmetric inset of each top corner as OOXML
 *       thousandths of `w`; default 25000 (25%).
 */
export const TRAPEZOID_ADJUSTMENTS: readonly AdjustmentSpec[] = [
  { name: 'Top inset', defaultValue: 25000, min: 0, max: 50000 },
];

export const buildTrapezoid: PathBuilder = ({ w, h }, adjustments) => {
  const ss = Math.min(w, h);
  const max = ss > 0 ? 50000 * w / ss : 0;
  const a = Math.max(0, Math.min(max, adj(adjustments, 0, 25000)));
  const inset = (a / 100000) * ss;
  const path = new Path2D();
  path.moveTo(inset, 0);
  path.lineTo(w - inset, 0);
  path.lineTo(w, h);
  path.lineTo(0, h);
  path.closePath();
  return path;
};

export const TRAPEZOID_HANDLES: readonly AdjustmentHandle[] = [
  {
    position: ({ w, h }, values) => {
      const ss = Math.min(w, h);
      const max = ss > 0 ? 50000 * w / ss : 0;
      return { x: ss * Math.max(0, Math.min(max, values[0] ?? 25000)) / 100000, y: 0 };
    },
    apply: ({ w, h }, _start, pointer) => {
      const ss = Math.min(w, h);
      const max = ss > 0 ? 50000 * w / ss : 0;
      const raw = ss > 0 ? pointer.x * 100000 / ss : 0;
      return [Math.max(0, Math.min(max, Math.round(raw)))];
    },
  },
];
