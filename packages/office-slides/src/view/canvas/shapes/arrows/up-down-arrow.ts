import type {
  AdjustmentHandle,
  AdjustmentSpec,
  PathBuilder,
} from '../builder';
import { adj } from '../builder';
import { insetAlongAxis } from '../handles';

/**
 * `upDownArrow` — vertical double-headed block arrow. Two
 * adjustments in OOXML order:
 *   [0] shaft width — `0..100000` across the full width.
 *   [1] head length — `0..50000*h/min(w,h)` along the short side.
 */
export const UP_DOWN_ARROW_ADJUSTMENTS: readonly AdjustmentSpec[] = [
  { name: 'Shaft width', defaultValue: 50000, min: 0, max: 100000 },
  { name: 'Head length', defaultValue: 50000, min: 0, max: 50000 },
];

function upDownAdjustments(w: number, h: number, adjustments?: number[]) {
  const ss = Math.min(w, h);
  const maxA2 = ss > 0 ? (50000 * h) / ss : 0;
  return {
    a1: Math.max(0, Math.min(100000, adj(adjustments, 0, 50000))),
    a2: Math.max(0, Math.min(maxA2, adj(adjustments, 1, 50000))),
    maxA2,
  };
}

export const buildUpDownArrow: PathBuilder = ({ w, h }, adjustments) => {
  const ss = Math.min(w, h);
  const { a1, a2 } = upDownAdjustments(w, h, adjustments);
  const headLen = (ss * a2) / 100000;
  const shaftHalf = (w * a1) / 200000;
  const cx = w / 2;
  const path = new Path2D();
  path.moveTo(cx, 0); // top tip
  path.lineTo(w, headLen);
  path.lineTo(cx + shaftHalf, headLen);
  path.lineTo(cx + shaftHalf, h - headLen);
  path.lineTo(w, h - headLen);
  path.lineTo(cx, h); // bottom tip
  path.lineTo(0, h - headLen);
  path.lineTo(cx - shaftHalf, h - headLen);
  path.lineTo(cx - shaftHalf, headLen);
  path.lineTo(0, headLen);
  path.closePath();
  return path;
};

const SHAFT_DEF = UP_DOWN_ARROW_ADJUSTMENTS[0].defaultValue;
const HEAD_DEF = UP_DOWN_ARROW_ADJUSTMENTS[1].defaultValue;

export const UP_DOWN_ARROW_HANDLES: readonly AdjustmentHandle[] = [
  // Shaft width — the OOXML handle is at (x1, y3).
  {
    position: ({ w, h }, adjustments) => {
      const ss = Math.min(w, h);
      const { a1, a2 } = upDownAdjustments(w, h, adjustments);
      return {
        x: insetAlongAxis(w / 2 - (w * a1) / 200000, w),
        y: insetAlongAxis(h - (ss * a2) / 100000, h),
      };
    },
    apply: ({ w }, start, pointer) => {
      const raw = w > 0 ? Math.round((Math.abs(pointer.x - w / 2) / w) * 200000) : 0;
      return [
        Math.max(0, Math.min(100000, raw)),
        start[1] ?? HEAD_DEF,
      ];
    },
  },
  // Head length — the OOXML handle is at (l, y2).
  {
    position: ({ w, h }, adjustments) => {
      const ss = Math.min(w, h);
      const { a2 } = upDownAdjustments(w, h, adjustments);
      return { x: 0, y: insetAlongAxis((ss * a2) / 100000, h) };
    },
    apply: ({ w, h }, start, pointer) => {
      const ss = Math.min(w, h);
      const maxA2 = ss > 0 ? (50000 * h) / ss : 0;
      const raw = ss > 0 ? Math.round((pointer.y / ss) * 100000) : 0;
      return [
        start[0] ?? SHAFT_DEF,
        Math.max(0, Math.min(maxA2, raw)),
      ];
    },
  },
];
