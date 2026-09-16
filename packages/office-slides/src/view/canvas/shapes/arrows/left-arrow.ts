import type { PathBuilder, AdjustmentHandle } from '../builder';
import { insetAlongAxis } from '../handles';
import { ARROW_ADJUSTMENTS, arrowHeadLengthMax, resolveHorizontalArrowAdjustments } from './right-arrow';

/**
 * `leftArrow` — block arrow pointing left. Mirror of `rightArrow`.
 * Reuses `ARROW_ADJUSTMENTS` from `right-arrow.ts`.
 */
export const buildLeftArrow: PathBuilder = ({ w, h }, adjustments) => {
  // OOXML: dx2 = ss * adj2 / 100000 where ss = min(w, h). Mirror of rightArrow.
  const ss = Math.min(w, h);
  const [shaftAdj, headAdj] = resolveHorizontalArrowAdjustments(w, h, adjustments);
  const headLen = (headAdj / 100000) * ss;
  const headHalf = (shaftAdj / 100000) * (h / 2);
  const path = new Path2D();
  path.moveTo(w, h / 2 - headHalf);
  path.lineTo(headLen, h / 2 - headHalf);
  path.lineTo(headLen, 0);
  path.lineTo(0, h / 2);
  path.lineTo(headLen, h);
  path.lineTo(headLen, h / 2 + headHalf);
  path.lineTo(w, h / 2 + headHalf);
  path.closePath();
  return path;
};

// leftArrow handles: head on the LEFT side, back of head at (headLen, h/2).
export const LEFT_ARROW_HANDLES: readonly AdjustmentHandle[] = [
  {
    position: ({ w, h }, adjustments) => {
      const [shaftAdj] = resolveHorizontalArrowAdjustments(w, h, adjustments);
      return { x: w, y: insetAlongAxis(h / 2 - (shaftAdj / 100000) * (h / 2), h) };
    },
    apply: ({ h }, start, pointer) => {
      const half = h / 2;
      const raw = half > 0 ? Math.round((Math.abs(pointer.y - half) / half) * 100000) : 0;
      return [Math.max(0, Math.min(100000, raw)), start[1] ?? ARROW_ADJUSTMENTS[1].defaultValue];
    },
  },
  {
    position: ({ w, h }, adjustments) => {
      const ss = Math.min(w, h);
      const [, headAdj] = resolveHorizontalArrowAdjustments(w, h, adjustments);
      return { x: insetAlongAxis((headAdj / 100000) * ss, w), y: 0 };
    },
    apply: ({ w, h }, start, pointer) => {
      const ss = Math.min(w, h);
      const raw = ss > 0 ? Math.round((pointer.x / ss) * 100000) : 0;
      return [start[0] ?? ARROW_ADJUSTMENTS[0].defaultValue, Math.max(0, Math.min(arrowHeadLengthMax(w, ss), raw))];
    },
  },
];
