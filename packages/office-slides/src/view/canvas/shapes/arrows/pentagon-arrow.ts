import type { PathBuilder, AdjustmentSpec, AdjustmentHandle } from '../builder';
import { adj } from '../builder';
import { insetAlongAxis } from '../handles';

/**
 * `pentagonArrow` — homePlate-style pentagon pointing right.
 *
 * Adjustments (`PENTAGON_ARROW_ADJUSTMENTS`):
 *   [0] pointLen — OOXML thousandths of `w`; default 50000.
 */
export const PENTAGON_ARROW_ADJUSTMENTS: readonly AdjustmentSpec[] = [
  { name: 'Point length', defaultValue: 50000, min: 0, max: 100000 },
];

const pointLengthMax = (w: number, h: number) => {
  const ss = Math.min(w, h);
  return ss > 0 ? (100000 * w) / ss : 0;
};

export const buildPentagonArrow: PathBuilder = ({ w, h }, adjustments) => {
  const ss = Math.min(w, h);
  const value = Math.max(0, Math.min(pointLengthMax(w, h), adj(adjustments, 0, 50000) ));
  const point = (value / 100000) * ss;
  const path = new Path2D();
  path.moveTo(0, 0);
  path.lineTo(w - point, 0);
  path.lineTo(w, h / 2);
  path.lineTo(w - point, h);
  path.lineTo(0, h);
  path.closePath();
  return path;
};

// Handle paints where the arrowhead notch begins on the top edge:
// x = w - point. Dragging rightward shrinks the arrowhead; leftward
// grows it. Inverse: adj = ((w - x) / w) * 100000.
export const PENTAGON_ARROW_HANDLES: readonly AdjustmentHandle[] = [
  {
    position: ({ w , h }, adjustments) => {
      const ss = Math.min(w , h);
      const value = Math.max(0, Math.min(pointLengthMax(w, h), adjustments[0] ?? 50000));
      return { x: insetAlongAxis(w - (value / 100000) * ss, w),
    y: 0 };
    }, apply: ({ w , h }, _start, pointer) => {
      const ss = Math.min(w, h);
      const raw = ss > 0 ? Math.round(((w - pointer.x) / ss) * 100000) : 0;
      return [Math.max(0, Math.min(pointLengthMax(w, h), raw))];
    },
  },
];
