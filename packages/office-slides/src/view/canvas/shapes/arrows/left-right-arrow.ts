import type { PathBuilder, AdjustmentHandle } from '../builder';
import { adj } from '../builder';
import { insetAlongAxis } from '../handles';
import { arrowHeadLengthMax } from './right-arrow';

/**
 * `leftRightArrow` — double-headed horizontal arrow.
 * Reuses `ARROW_ADJUSTMENTS` from `right-arrow.ts`.
 */
export const buildLeftRightArrow: PathBuilder = ({ w, h }, adjustments) => {
  // OOXML: x2 = ss * adj2 / 100000 where ss = min(w, h); maxAdj2 caps the head
  // at w/2 (50000 * w / ss). Each head length scales by the shorter side.
  const ss = Math.min(w, h);
  const shaft = Math.max(0, Math.min(100000, adj(adjustments, 0, 50000)));
  const headAdj = Math.max(0, Math.min(arrowHeadLengthMax(w, ss, 2), adj(adjustments, 1, 50000)));
  const head = (headAdj / 100000) * ss;
  const headHalf = (shaft / 100000) * (h / 2);
  const path = new Path2D();
  path.moveTo(0, h / 2);
  path.lineTo(head, 0);
  path.lineTo(head, h / 2 - headHalf);
  path.lineTo(w - head, h / 2 - headHalf);
  path.lineTo(w - head, 0);
  path.lineTo(w, h / 2);
  path.lineTo(w - head, h);
  path.lineTo(w - head, h / 2 + headHalf);
  path.lineTo(head, h / 2 + headHalf);
  path.lineTo(head, h);
  path.closePath();
  return path;
};

// leftRightArrow handles: heads on BOTH ends, each "head" extends inward
// from each side. Handle 1 paints at the LEFT arrowhead back on the
// centerline (head, h/2); editing it mirrors symmetrically since the
// path builder uses `w - head` for the right side.
export const LEFT_RIGHT_ARROW_HANDLES: readonly AdjustmentHandle[] = [
  {
    position: ({ w, h }, adjustments) => {
      const shaft = Math.max(0, Math.min(100000, adjustments[0] ?? 50000));
      const ss = Math.min(w, h);
      const max = arrowHeadLengthMax(w, ss, 2);
      const head = Math.max(0, Math.min(max, adjustments[1] ?? 50000));
      return {
        x: insetAlongAxis(w - (head / 100000) * ss, w),
        y: insetAlongAxis(h / 2 - (shaft / 100000) * (h / 2), h),
      };
    },
    apply: ({ h }, start, pointer) => {
      const half = h / 2;
      const raw = half > 0 ? Math.round((Math.abs(pointer.y - half) / half) * 100000) : 0;
      return [Math.max(0, Math.min(100000, raw)), start[1] ?? 50000];
    },
  },
  {
    position: ({ w, h }, adjustments) => {
      const ss = Math.min(w, h);
      const max = arrowHeadLengthMax(w, ss, 2);
      const head = Math.max(0, Math.min(max, adjustments[1] ?? 50000));
      return { x: insetAlongAxis((head / 100000) * ss, w), y: 0 };
    },
    apply: ({ w, h }, start, pointer) => {
      const ss = Math.min(w, h);
      const raw = ss > 0 ? Math.round((pointer.x / ss) * 100000) : 0;
      return [start[0] ?? 50000, Math.max(0, Math.min(arrowHeadLengthMax(w, ss, 2), raw))];
    },
  },
];
