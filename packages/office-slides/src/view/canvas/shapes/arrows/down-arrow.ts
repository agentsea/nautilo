import type { PathBuilder, AdjustmentHandle } from '../builder';
import { adj } from '../builder';
import { insetAlongAxis } from '../handles';
import { arrowHeadLengthMax } from './right-arrow';

/**
 * `downArrow` — block arrow pointing down.
 * Reuses `ARROW_ADJUSTMENTS` from `right-arrow.ts`.
 */
export const buildDownArrow: PathBuilder = ({ w, h }, adjustments) => {
  // OOXML: dy1 = ss * adj2 / 100000 where ss = min(w, h). Mirror of upArrow.
  const ss = Math.min(w, h);
  const shaftAdj = Math.max(0, Math.min(100000, adj(adjustments, 0, 50000)));
  const headAdj = Math.max(0, Math.min(arrowHeadLengthMax(h, ss), adj(adjustments, 1, 50000)));
  const headLen = (headAdj / 100000) * ss;
  const headHalf = (shaftAdj / 100000) * (w / 2);
  const path = new Path2D();
  path.moveTo(w / 2 - headHalf, 0);
  path.lineTo(w / 2 - headHalf, h - headLen);
  path.lineTo(0, h - headLen);
  path.lineTo(w / 2, h);
  path.lineTo(w, h - headLen);
  path.lineTo(w / 2 + headHalf, h - headLen);
  path.lineTo(w / 2 + headHalf, 0);
  path.closePath();
  return path;
};

// downArrow handles: head on the BOTTOM, back of head at (w/2, h-headLen).
export const DOWN_ARROW_HANDLES: readonly AdjustmentHandle[] = [
  {
    position: ({ w }, adjustments) => {
      const shaft = Math.max(0, Math.min(100000, adjustments[0] ?? 50000));
      return { x: insetAlongAxis(w / 2 - (shaft / 100000) * (w / 2), w), y: 0 };
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
      const max = arrowHeadLengthMax(h, ss);
      const head = Math.max(0, Math.min(max, adjustments[1] ?? 50000));
      return { x: 0, y: insetAlongAxis(h - (head / 100000) * ss, h) };
    },
    apply: ({ w, h }, start, pointer) => {
      const ss = Math.min(w, h);
      const raw = ss > 0 ? Math.round(((h - pointer.y) / ss) * 100000) : 0;
      return [start[0] ?? 50000, Math.max(0, Math.min(arrowHeadLengthMax(h, ss), raw))];
    },
  },
];
