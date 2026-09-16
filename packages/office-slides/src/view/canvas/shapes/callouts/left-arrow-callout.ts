import type { PathBuilder, AdjustmentHandle } from '../builder';
import { insetAlongAxis } from '../handles';
import { pin, resolveArrowCalloutGuides } from './arrow-callout-guides';
import { DEF_BODY, DEF_DEPTH, DEF_HEAD, DEF_SHAFT } from './right-arrow-callout';

const DEFAULTS = [DEF_SHAFT, DEF_HEAD, DEF_DEPTH, DEF_BODY] as const;

/**
 * `leftArrowCallout` — horizontal mirror of `rightArrowCallout`.
 * Body is on the right; arrowhead protrudes to the left.
 */
export const buildLeftArrowCallout: PathBuilder = ({ w, h }, adjustments) => {
  const { ss, a1, a2, a3, a4 } = resolveArrowCalloutGuides(w, h, adjustments, {
    vertical: false, bidirectional: false, defaults: DEFAULTS,
  });
  // dy1 = shaft half-thickness (ss·a1/200000); dy2 = head half-thickness
  // (ss·a2/100000). At default a1=a2 the head flares to 2× the shaft.
  const dy1 = ss * (a1 / 200000);
  const dy2 = ss * (a2 / 100000);
  // OOXML head depth uses ss = min(w,h), not w (shallow head on wide frames).
  const dx1 = ss * (a3 / 100000);
  const bx = Math.max(dx1, w - w * (a4 / 100000));
  const cy = h / 2;
  const path = new Path2D();
  path.moveTo(w, h);
  path.lineTo(bx, h);
  path.lineTo(bx, cy + dy1);
  path.lineTo(dx1, cy + dy1);
  path.lineTo(dx1, cy + dy2);
  path.lineTo(0, cy);
  path.lineTo(dx1, cy - dy2);
  path.lineTo(dx1, cy - dy1);
  path.lineTo(bx, cy - dy1);
  path.lineTo(bx, 0);
  path.lineTo(w, 0);
  path.closePath();
  return path;
};

export const LEFT_ARROW_CALLOUT_HANDLES: readonly AdjustmentHandle[] = [
  {
    position: ({ w, h }, adjustments) => {
      const { ss, a1, a3, a4 } = resolveArrowCalloutGuides(w, h, adjustments, {
        vertical: false, bidirectional: false, defaults: DEFAULTS,
      });
      // Mirror of right callout — builder clamps
      // `bx = max(dx1, w - w * adj4 / 100000)`.
      const bodyX = Math.max(ss * (a3 / 100000), w - w * (a4 / 100000));
      return {
        x: insetAlongAxis(bodyX, w),
        y: insetAlongAxis(h / 2 - ss * (a1 / 200000), h),
      };
    },
    apply: ({ w, h }, start, pointer) => {
      const ss = Math.min(w, h);
      const x = Math.max(0, Math.min(w, pointer.x));
      const y = Math.max(0, Math.min(h, pointer.y));
      const { maxA1, maxA4 } = resolveArrowCalloutGuides(w, h, start, {
        vertical: false, bidirectional: false, defaults: DEFAULTS,
      });
      const rawA4 = w > 0 ? Math.round(((w - x) / w) * 100000) : DEF_BODY;
      const newA4 = Math.max(0, Math.min(maxA4, rawA4));
      const dy1 = Math.abs(y - h / 2);
      const newA1 = ss > 0 ? Math.round((dy1 / (ss / 2)) * 100000) : DEF_SHAFT;
      return [
        pin(0, newA1, maxA1),
        start[1] ?? DEF_HEAD,
        start[2] ?? DEF_DEPTH,
        newA4,
      ];
    },
  },
  {
    position: ({ w, h }, adjustments) => {
      const { ss, a2, a3 } = resolveArrowCalloutGuides(w, h, adjustments, {
        vertical: false, bidirectional: false, defaults: DEFAULTS,
      });
      return {
        x: insetAlongAxis(ss * (a3 / 100000), w),
        y: insetAlongAxis(h / 2 - ss * (a2 / 100000), h),
      };
    },
    apply: ({ w, h }, start, pointer) => {
      const ss = Math.min(w, h);
      const x = Math.max(0, Math.min(w, pointer.x));
      const y = Math.max(0, Math.min(h, pointer.y));
      const { maxA2, maxA3 } = resolveArrowCalloutGuides(w, h, start, {
        vertical: false, bidirectional: false, defaults: DEFAULTS,
      });
      const newA3 = ss > 0 ? Math.round((x / ss) * 100000) : DEF_DEPTH;
      const newA2 = ss > 0
        ? Math.round((Math.abs(y - h / 2) / ss) * 100000)
        : DEF_HEAD;
      return [
        start[0] ?? DEF_SHAFT,
        pin(0, newA2, maxA2),
        pin(0, newA3, maxA3),
        start[3] ?? DEF_BODY,
      ];
    },
  },
];
