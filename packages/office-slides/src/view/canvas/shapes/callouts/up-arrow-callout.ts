import type { PathBuilder, AdjustmentHandle } from '../builder';
import { insetAlongAxis } from '../handles';
import { pin, resolveArrowCalloutGuides } from './arrow-callout-guides';
import { DEF_BODY, DEF_DEPTH, DEF_HEAD, DEF_SHAFT } from './right-arrow-callout';

const DEFAULTS = [DEF_SHAFT, DEF_HEAD, DEF_DEPTH, DEF_BODY] as const;

/**
 * `upArrowCallout` — vertical version. Body is at the bottom of
 * the frame; arrowhead points up. Long axis is `h`.
 */
export const buildUpArrowCallout: PathBuilder = ({ w, h }, adjustments) => {
  const { ss, a1, a2, a3, a4 } = resolveArrowCalloutGuides(w, h, adjustments, {
    vertical: true, bidirectional: false, defaults: DEFAULTS,
  });
  // dx1 = shaft half-thickness (ss·a1/200000); dx2 = head half-thickness
  // (ss·a2/100000). At default a1=a2 the head flares to 2× the shaft.
  const dx1 = ss * (a1 / 200000);
  const dx2 = ss * (a2 / 100000);
  // OOXML head depth uses ss = min(w,h), not h (shallow head on tall frames).
  const dy1 = ss * (a3 / 100000);
  const by = Math.max(dy1, h - h * (a4 / 100000));
  const cx = w / 2;
  const path = new Path2D();
  path.moveTo(w, h);
  path.lineTo(w, by);
  path.lineTo(cx + dx1, by);
  path.lineTo(cx + dx1, dy1);
  path.lineTo(cx + dx2, dy1);
  path.lineTo(cx, 0);
  path.lineTo(cx - dx2, dy1);
  path.lineTo(cx - dx1, dy1);
  path.lineTo(cx - dx1, by);
  path.lineTo(0, by);
  path.lineTo(0, h);
  path.closePath();
  return path;
};

export const UP_ARROW_CALLOUT_HANDLES: readonly AdjustmentHandle[] = [
  {
    position: ({ w, h }, adjustments) => {
      const { ss, a1, a3, a4 } = resolveArrowCalloutGuides(w, h, adjustments, {
        vertical: true, bidirectional: false, defaults: DEFAULTS,
      });
      // Builder clamps `by = max(dy1, h - h * adj4 / 100000)`.
      const bodyY = Math.max(ss * (a3 / 100000), h - h * (a4 / 100000));
      return {
        x: insetAlongAxis(w / 2 + ss * (a1 / 200000), w),
        y: insetAlongAxis(bodyY, h),
      };
    },
    apply: ({ w, h }, start, pointer) => {
      const ss = Math.min(w, h);
      const x = Math.max(0, Math.min(w, pointer.x));
      const y = Math.max(0, Math.min(h, pointer.y));
      const { maxA1, maxA4 } = resolveArrowCalloutGuides(w, h, start, {
        vertical: true, bidirectional: false, defaults: DEFAULTS,
      });
      const rawA4 = h > 0 ? Math.round(((h - y) / h) * 100000) : DEF_BODY;
      const newA4 = Math.max(0, Math.min(maxA4, rawA4));
      const dx1 = Math.abs(x - w / 2);
      const newA1 = ss > 0 ? Math.round((dx1 / (ss / 2)) * 100000) : DEF_SHAFT;
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
        vertical: true, bidirectional: false, defaults: DEFAULTS,
      });
      return {
        x: insetAlongAxis(w / 2 + ss * (a2 / 100000), w),
        y: insetAlongAxis(ss * (a3 / 100000), h),
      };
    },
    apply: ({ w, h }, start, pointer) => {
      const ss = Math.min(w, h);
      const x = Math.max(0, Math.min(w, pointer.x));
      const y = Math.max(0, Math.min(h, pointer.y));
      const { maxA2, maxA3 } = resolveArrowCalloutGuides(w, h, start, {
        vertical: true, bidirectional: false, defaults: DEFAULTS,
      });
      const newA2 = ss > 0
        ? Math.round((Math.abs(x - w / 2) / ss) * 100000)
        : DEF_HEAD;
      const newA3 = ss > 0 ? Math.round((y / ss) * 100000) : DEF_DEPTH;
      return [
        start[0] ?? DEF_SHAFT,
        pin(0, newA2, maxA2),
        pin(0, newA3, maxA3),
        start[3] ?? DEF_BODY,
      ];
    },
  },
];
