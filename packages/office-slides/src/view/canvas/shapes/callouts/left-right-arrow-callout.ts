import type { PathBuilder, AdjustmentSpec, AdjustmentHandle } from '../builder';
import { insetAlongAxis } from '../handles';
import { pin, resolveArrowCalloutGuides } from './arrow-callout-guides';
import { DEF_DEPTH, DEF_HEAD, DEF_SHAFT } from './right-arrow-callout';

/**
 * Adjustments for bidirectional arrow callouts (leftRight / upDown).
 * adj4 here is the body extent on the long axis as a fraction of
 * the full axis length — but in OOXML this is split symmetrically
 * around the centre (`dx2 = w * adj4 / 200000`), giving a body that
 * spans ±(adj4 * w / 200000) from the centre.
 */
export const BI_ARROW_CALLOUT_ADJUSTMENTS: readonly AdjustmentSpec[] = [
  { name: 'Shaft thickness', defaultValue: 25000, min: 0, max: 100000 },
  { name: 'Head thickness', defaultValue: 25000, min: 0, max: 100000 },
  { name: 'Head depth', defaultValue: 25000, min: 0, max: 50000 },
  { name: 'Body extent', defaultValue: 48123, min: 0, max: 100000 },
];

// Re-exported for `up-down-arrow-callout.ts`. Bidirectional callouts
// share shaft/head/depth defaults with the single-direction ones but
// diverge on `DEF_BI_BODY` (smaller, since the body sits between
// two heads instead of being most of the frame).
export const DEF_BI_BODY = 48123;
const DEFAULTS = [DEF_SHAFT, DEF_HEAD, DEF_DEPTH, DEF_BI_BODY] as const;

/**
 * `leftRightArrowCallout` — body in the middle, arrowheads
 * pointing both left and right.
 */
export const buildLeftRightArrowCallout: PathBuilder = (
  { w, h },
  adjustments,
) => {
  const { ss, a1, a2, a3, a4 } = resolveArrowCalloutGuides(w, h, adjustments, {
    vertical: false, bidirectional: true, defaults: DEFAULTS,
  });
  // dy1 = shaft half-thickness (ss·a1/200000); dy2 = head half-thickness
  // (ss·a2/100000). At default a1=a2 the head flares to 2× the shaft.
  const dy1 = ss * (a1 / 200000);
  const dy2 = ss * (a2 / 100000);
  // OOXML head depth uses ss = min(w,h), not w (shallow heads on wide frames).
  const dx1 = ss * (a3 / 100000);
  const dx2 = Math.min(w / 2 - dx1, (w / 2) * (a4 / 100000));
  const cx = w / 2;
  const cy = h / 2;
  const path = new Path2D();
  path.moveTo(0, cy);
  path.lineTo(dx1, cy - dy2);
  path.lineTo(dx1, cy - dy1);
  path.lineTo(cx - dx2, cy - dy1);
  path.lineTo(cx - dx2, 0);
  path.lineTo(cx + dx2, 0);
  path.lineTo(cx + dx2, cy - dy1);
  path.lineTo(w - dx1, cy - dy1);
  path.lineTo(w - dx1, cy - dy2);
  path.lineTo(w, cy);
  path.lineTo(w - dx1, cy + dy2);
  path.lineTo(w - dx1, cy + dy1);
  path.lineTo(cx + dx2, cy + dy1);
  path.lineTo(cx + dx2, h);
  path.lineTo(cx - dx2, h);
  path.lineTo(cx - dx2, cy + dy1);
  path.lineTo(dx1, cy + dy1);
  path.lineTo(dx1, cy + dy2);
  path.closePath();
  return path;
};

export const LEFT_RIGHT_ARROW_CALLOUT_HANDLES: readonly AdjustmentHandle[] = [
  {
    position: ({ w, h }, adjustments) => {
      const { ss, a1, a3, a4 } = resolveArrowCalloutGuides(w, h, adjustments, {
        vertical: false, bidirectional: true, defaults: DEFAULTS,
      });
      // Two heads, so the clamp is `dx2 = min(w/2 - dx1, w*adj4/200000)`.
      const dx1 = ss * (a3 / 100000);
      const dx2 = Math.min(w / 2 - dx1, (w / 2) * (a4 / 100000));
      return {
        x: insetAlongAxis(w / 2 - dx2, w),
        y: insetAlongAxis(h / 2 - ss * (a1 / 200000), h),
      };
    },
    apply: ({ w, h }, start, pointer) => {
      const ss = Math.min(w, h);
      const x = Math.max(0, Math.min(w, pointer.x));
      const y = Math.max(0, Math.min(h, pointer.y));
      const { maxA1, maxA4 } = resolveArrowCalloutGuides(w, h, start, {
        vertical: false, bidirectional: true, defaults: DEFAULTS,
      });
      const dx = Math.abs(x - w / 2);
      const rawA4 = w > 0 ? Math.round((dx / (w / 2)) * 100000) : DEF_BI_BODY;
      const newA4 = Math.max(0, Math.min(maxA4, rawA4));
      const dy = Math.abs(y - h / 2);
      const newA1 = ss > 0 ? Math.round((dy / (ss / 2)) * 100000) : DEF_SHAFT;
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
        vertical: false, bidirectional: true, defaults: DEFAULTS,
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
        vertical: false, bidirectional: true, defaults: DEFAULTS,
      });
      const newA3 = ss > 0 ? Math.round((x / ss) * 100000) : DEF_DEPTH;
      const newA2 = ss > 0
        ? Math.round((Math.abs(y - h / 2) / ss) * 100000)
        : DEF_HEAD;
      return [
        start[0] ?? DEF_SHAFT,
        pin(0, newA2, maxA2),
        pin(0, newA3, maxA3),
        start[3] ?? DEF_BI_BODY,
      ];
    },
  },
];
