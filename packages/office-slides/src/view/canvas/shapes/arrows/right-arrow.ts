import type { PathBuilder, AdjustmentSpec, AdjustmentHandle } from '../builder';
import { adj } from '../builder';
import { insetAlongAxis } from '../handles';

/**
 * `rightArrow` — block arrow pointing right.
 *
 * Adjustments (shared with leftArrow/upArrow/downArrow/leftRightArrow
 * via `ARROW_ADJUSTMENTS`):
 *   [0] shaft width — OOXML thousandths of the perpendicular axis.
 *   [1] head length — OOXML thousandths of `ss = min(w,h)`.
 */
export const ARROW_ADJUSTMENTS: readonly AdjustmentSpec[] = [
  { name: 'Shaft width', defaultValue: 50000, min: 0, max: 100000 },
  { name: 'Head length', defaultValue: 50000, min: 0, max: 100000 },
];

export const arrowHeadLengthMax = (axisLength: number, ss: number, heads = 1) =>
  ss > 0 ? (100000 * axisLength) / (heads * ss) : 0;

export const resolveHorizontalArrowAdjustments = (
  w: number,
  h: number,
  adjustments?: number[],
  heads = 1,
): [shaft: number, headLength: number] => {
  const ss = Math.min(w, h);
  const shaft = Math.max(0, Math.min(100000, adj(adjustments, 0, 50000)));
  const maxHead = arrowHeadLengthMax(w, ss, heads);
  const headLength = Math.max(0, Math.min(maxHead, adj(adjustments, 1, 50000)));
  return [shaft, headLength];
};

export const buildRightArrow: PathBuilder = ({ w, h }, adjustments) => {
  // OOXML: dx1 = ss * adj2 / 100000 where ss = min(w, h). The head length
  // scales by the shorter side so the arrowhead keeps its proportion when
  // the bounding box is stretched. Clamp to w so it never exceeds the box.
  const ss = Math.min(w, h);
  const [shaftAdj, headAdj] = resolveHorizontalArrowAdjustments(w, h, adjustments);
  const headLen = (headAdj / 100000) * ss;
  const headHalf = (shaftAdj / 100000) * (h / 2);
  const path = new Path2D();
  path.moveTo(0, h / 2 - headHalf);
  path.lineTo(w - headLen, h / 2 - headHalf);
  path.lineTo(w - headLen, 0);
  path.lineTo(w, h / 2);
  path.lineTo(w - headLen, h);
  path.lineTo(w - headLen, h / 2 + headHalf);
  path.lineTo(0, h / 2 + headHalf);
  path.closePath();
  return path;
};

const SHAFT_DEF = ARROW_ADJUSTMENTS[0].defaultValue;
const HEAD_DEF = ARROW_ADJUSTMENTS[1].defaultValue;

export const RIGHT_ARROW_HANDLES: readonly AdjustmentHandle[] = [
  {
    position: ({ w, h }, adjustments) => {
      const [shaftAdj] = resolveHorizontalArrowAdjustments(w, h, adjustments);
      return { x: 0, y: insetAlongAxis(h / 2 - (shaftAdj / 100000) * (h / 2), h) };
    },
    apply: ({ h }, start, pointer) => {
      const half = h / 2;
      const raw = half > 0 ? Math.round((Math.abs(pointer.y - half) / half) * 100000) : 0;
      return [Math.max(0, Math.min(100000, raw)), start[1] ?? HEAD_DEF];
    },
  },
  {
    position: ({ w, h }, adjustments) => {
      const ss = Math.min(w, h);
      const [, headAdj] = resolveHorizontalArrowAdjustments(w, h, adjustments);
      const headLen = (headAdj / 100000) * ss;
      return { x: insetAlongAxis(w - headLen, w), y: 0 };
    },
    apply: ({ w, h }, start, pointer) => {
      const ss = Math.min(w, h);
      const raw = ss > 0 ? Math.round(((w - pointer.x) / ss) * 100000) : 0;
      return [start[0] ?? SHAFT_DEF, Math.max(0, Math.min(arrowHeadLengthMax(w, ss), raw))];
    },
  },
];
