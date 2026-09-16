import type { PathBuilder, AdjustmentHandle } from '../builder';
import { adj } from '../builder';
import { insetAlongAxis } from '../handles';
import { arrowHeadLengthMax } from './right-arrow';

/**
 * `upArrow` — block arrow pointing up.
 * Reuses `ARROW_ADJUSTMENTS` from `right-arrow.ts`.
 */
export const buildUpArrow: PathBuilder = ({ w, h }, adjustments) => {
  // OOXML: dy2 = ss * adj2 / 100000 where ss = min(w, h). Head length scales
  // by the shorter side; clamp to h so it never exceeds the box.
  const ss = Math.min(w, h);
  const shaftAdj = Math.max(0, Math.min(100000, adj(adjustments, 0, 50000)));
  const headAdj = Math.max(0, Math.min(arrowHeadLengthMax(h, ss, 2), adj(adjustments, 1, 50000)));
  const headLen = (headAdj / 100000) * ss;
  const headHalf = (shaftAdj / 100000) * (w / 2);
  const path = new Path2D();
  path.moveTo(w / 2 - headHalf, h);
  path.lineTo(w / 2 - headHalf, headLen);
  path.lineTo(0, headLen);
  path.lineTo(w / 2, 0);
  path.lineTo(w, headLen);
  path.lineTo(w / 2 + headHalf, headLen);
  path.lineTo(w / 2 + headHalf, h);
  path.closePath();
  return path;
};

// upArrow handles: head on the TOP, back of head at (w/2, headLen).
// Drag DOWN to grow head; head width perpendicular (along x).
export const UP_ARROW_HANDLES: readonly AdjustmentHandle[] = [
  {
    position: ({ w, h }, adjustments) => {
      const shaft = Math.max(0, Math.min(100000, adjustments[0] ?? 50000));
      const ss = Math.min(w, h);
      const max = arrowHeadLengthMax(h, ss, 2);
      const head = Math.max(0, Math.min(max, adjustments[1] ?? 50000));
      return {
        x: insetAlongAxis(w / 2 - (shaft / 100000) * (w / 2), w),
        y: insetAlongAxis(h - (head / 100000) * ss, h),
      };
    },
    apply: ({ w }, start, pointer) => {
      const half = w / 2;
      const raw = half > 0 ? Math.round((Math.abs(pointer.x - half) / half) * 100000) : 0;
      return [Math.max(0, Math.min(100000, raw)), start[1] ?? 50000];
    },
  },
  {
    position: ({ w, h }, adjustments) => {
      const ss = Math.min(w, h);
      const max = arrowHeadLengthMax(h, ss, 2);
      const head = Math.max(0, Math.min(max, adjustments[1] ?? 50000));
      return { x: 0, y: insetAlongAxis((head / 100000) * ss, h) };
    },
    apply: ({ w, h }, start, pointer) => {
      const ss = Math.min(w, h);
      const raw = ss > 0 ? Math.round((pointer.y / ss) * 100000) : 0;
      return [start[0] ?? 50000, Math.max(0, Math.min(arrowHeadLengthMax(h, ss, 2), raw))];
    },
  },
];
