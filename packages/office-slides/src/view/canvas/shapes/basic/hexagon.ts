import type { PathBuilder, AdjustmentSpec, AdjustmentHandle } from '../builder';
import { adj } from '../builder';

/**
 * `hexagon` — horizontal hexagon (long axis = w) with triangular
 * notches on the left and right edges.
 *
 * Adjustments:
 *   [0] notchDepth — OOXML thousandths of `min(w,h)`; default 25000.
 */
export const HEXAGON_ADJUSTMENTS: readonly AdjustmentSpec[] = [
  { name: 'Notch depth', defaultValue: 25000, min: 0, max: 100000 },
];

export const buildHexagon: PathBuilder = ({ w, h }, adjustments) => {
  const ss = Math.min(w, h);
  const max = ss > 0 ? 50000 * w / ss : 0;
  const a = Math.max(0, Math.min(max, adj(adjustments, 0, 25000)));
  const notch = (a / 100000) * ss;
  const path = new Path2D();
  // Horizontal hexagon (long axis = w). Notches cut the left/right edges.
  path.moveTo(notch, 0);
  path.lineTo(w - notch, 0);
  path.lineTo(w, h / 2);
  path.lineTo(w - notch, h);
  path.lineTo(notch, h);
  path.lineTo(0, h / 2);
  path.closePath();
  return path;
};

export const HEXAGON_HANDLES: readonly AdjustmentHandle[] = [
  {
    position: ({ w, h }, values) => {
      const ss = Math.min(w, h);
      const max = ss > 0 ? 50000 * w / ss : 0;
      const a = Math.max(0, Math.min(max, values[0] ?? 25000));
      return { x: ss * a / 100000, y: 0 };
    },
    apply: ({ w, h }, _start, pointer) => {
      const ss = Math.min(w, h);
      const max = ss > 0 ? 50000 * w / ss : 0;
      const raw = ss > 0 ? pointer.x * 100000 / ss : 0;
      return [Math.max(0, Math.min(max, Math.round(raw)))];
    },
  },
];
