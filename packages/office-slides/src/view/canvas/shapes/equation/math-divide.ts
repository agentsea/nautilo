import type { PathBuilder, AdjustmentSpec, AdjustmentHandle } from "../builder";
import { insetAlongAxis } from "../handles";

/**
 * `mathDivide` — `÷` glyph: a horizontal bar with a dot above and a
 * dot below.
 *
 * Adjustments (`MATH_DIVIDE_ADJUSTMENTS`):
 *   [0] barThickness — OOXML thousandths of `h`. Default 23520.
 *   [1] gap          — OOXML `adj2`, thousandths of `h`, between bar
 *                      edge and the nearest edge of each dot. Default
 *                      5880.
 *   [2] dotRadius    — OOXML `adj3`, thousandths of `h`. Default 11760.
 *
 * The array order is the serialized DrawingML guide order. Import and export
 * preserve it positionally, so `adj2` must remain the gap and `adj3` the radius.
 *
 * OOXML proportions (origin = frame top-left, y DOWN):
 *   dy1 = h * a1/200000             half bar-thickness
 *   rad = h * a3/100000             dot radius (a3 = adj index 2)
 *   yg  = h * a2/100000             gap (a2 = adj index 1)
 *   dx1 = w * 73490/200000          half bar-width (73.49% of w)
 *   y3 = vc - dy1                   bar top edge
 *   y2 = y3 - (yg + rad)            top-dot centre
 *   y1 = y2 - rad                   top-dot top edge
 *   y5 = b - y1                     bottom-dot centre (symmetric)
 * The bar therefore spans only the inner 73.49% of the width.
 */
export const MATH_DIVIDE_ADJUSTMENTS: readonly AdjustmentSpec[] = [
  { name: "Bar thickness", defaultValue: 23520, min: 1000, max: 36745 },
  { name: "Gap", defaultValue: 5880, min: 0, max: 72490 },
  { name: "Dot radius", defaultValue: 11760, min: 1000, max: 18122.5 },
];

const pinFinite = (
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
) => Math.max(min, Math.min(max, Number.isFinite(value) ? value! : fallback));

// DrawingML `pin lo val hi` uses ordered comparisons. This differs from a
// nested min/max clamp when a dependent guide makes hi smaller than lo.
const pinPreset = (lo: number, value: number, hi: number) =>
  value < lo ? lo : value > hi ? hi : value;

/** Resolve the preset's coupled adj1/adj2/adj3 guide pins in OOXML order. */
export function resolveMathDivideAdjustments(
  w: number,
  h: number,
  adjustments?: number[],
): [bar: number, gap: number, radius: number] {
  const bar = pinFinite(adjustments?.[0], 23520, 1000, 36745);
  const byHeight = (73490 - bar) / 4;
  const byWidth =
    h > 0 && Number.isFinite(w) && Number.isFinite(h)
      ? (36745 * Math.max(0, w)) / h
      : byHeight;
  const maxRadius = Math.min(byHeight, byWidth);
  const radiusInput = Number.isFinite(adjustments?.[2])
    ? adjustments![2]
    : 11760;
  const radius = pinPreset(1000, radiusInput, maxRadius);
  const maxGap = Math.max(0, 73490 - 4 * radius - bar);
  const gap = pinFinite(adjustments?.[1], 5880, 0, maxGap);
  return [bar, gap, radius];
}

export const buildMathDivide: PathBuilder = ({ w, h }, adjustments) => {
  const [barAdj, gapAdj, radiusAdj] = resolveMathDivideAdjustments(
    w,
    h,
    adjustments,
  );
  const dy1 = (barAdj / 200000) * h; // half bar
  const dotR = (radiusAdj / 100000) * h; // a3 radius
  const gap = (gapAdj / 100000) * h; // a2 gap
  const dx1 = (w * 73490) / 200000; // half bar-width (73.49% of w)
  const hc = w / 2;
  const vc = h / 2;
  const barTop = vc - dy1;
  const barBottom = vc + dy1;
  // Top-dot centre sits gap + radius above the bar's top edge.
  const topDotY = barTop - gap - dotR;
  const bottomDotY = barBottom + gap + dotR;
  const path = new Path2D();
  path.rect(hc - dx1, barTop, dx1 * 2, dy1 * 2);
  // Top dot.
  path.moveTo(hc + dotR, topDotY);
  path.arc(hc, topDotY, dotR, 0, Math.PI * 2);
  // Bottom dot.
  path.moveTo(hc + dotR, bottomDotY);
  path.arc(hc, bottomDotY, dotR, 0, Math.PI * 2);
  return path;
};

// Three handles, all on the upper half:
//  [0] bar thickness → top of central bar (w/2, cy - bar/2)
//  [1] gap           → midpoint between bar top and top dot bottom
//  [2] dot radius    → right edge of top dot (cx + dotR, dotY)
const MD_DEF0 = MATH_DIVIDE_ADJUSTMENTS[0].defaultValue;
export const MATH_DIVIDE_HANDLES: readonly AdjustmentHandle[] = [
  {
    position: ({ w, h }, adjustments) => {
      const [barAdj] = resolveMathDivideAdjustments(w, h, adjustments);
      const bar = (barAdj / 100000) * h;
      return { x: w / 2, y: insetAlongAxis(h / 2 - bar / 2, h) };
    },
    apply: ({ h }, start, pointer) => {
      const y = Math.max(0, Math.min(h, pointer.y));
      const bar = h - 2 * y;
      const raw = h > 0 ? Math.round((bar / h) * 100000) : 0;
      const result = [...start];
      result[0] = pinFinite(raw, MD_DEF0, 1000, 36745);
      return result;
    },
  },
  {
    position: ({ w, h }, adjustments) => {
      const [barAdj, gapAdj] = resolveMathDivideAdjustments(
        w,
        h,
        adjustments,
      );
      const bar = (barAdj / 100000) * h;
      const gap = (gapAdj / 100000) * h;
      const barTop = h / 2 - bar / 2;
      const dotBottom = barTop - gap;
      return { x: w / 2, y: insetAlongAxis((barTop + dotBottom) / 2, h) };
    },
    apply: ({ w, h }, start, pointer) => {
      const y = Math.max(0, Math.min(h, pointer.y));
      const [barAdj, , radiusAdj] = resolveMathDivideAdjustments(w, h, start);
      const bar = (barAdj / 100000) * h;
      const raw = h > 0 ? Math.round(((h - bar - 2 * y) / h) * 100000) : 0;
      const result = [...start];
      result[1] = pinFinite(raw, MATH_DIVIDE_ADJUSTMENTS[1].defaultValue, 0, Math.max(0, 73490 - 4 * radiusAdj - barAdj));
      return result;
    },
  },
  {
    position: ({ w, h }, adjustments) => {
      const [barAdj, gapAdj, radiusAdj] = resolveMathDivideAdjustments(
        w,
        h,
        adjustments,
      );
      const bar = (barAdj / 100000) * h;
      const dotR = (radiusAdj / 100000) * h;
      const dotY = h / 2 - bar / 2 - (gapAdj / 100000) * h - dotR;
      return { x: insetAlongAxis(w / 2 + dotR, w), y: insetAlongAxis(dotY, h) };
    },
    apply: ({ w, h }, start, pointer) => {
      const x = Math.max(0, Math.min(w, pointer.x));
      const raw = h > 0 ? Math.round((Math.abs(x - w / 2) / h) * 100000) : 0;
      const result = [...start];
      const [bar] = resolveMathDivideAdjustments(w, h, start);
      const maxRadius = Math.min((73490 - bar) / 4, h > 0 ? (36745 * Math.max(0, w)) / h : (73490 - bar) / 4);
      result[2] = pinPreset(1000, raw, maxRadius);
      return result;
    },
  },
];
