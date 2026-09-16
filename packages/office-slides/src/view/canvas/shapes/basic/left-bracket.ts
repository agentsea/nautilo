import type { PathBuilder, AdjustmentSpec, AdjustmentHandle } from '../builder';
import { adj } from '../builder';
import { insetAlongAxis } from '../handles';

/**
 * `leftBracket` — "[" shape rendered as an open path. OOXML defines
 * brackets with separate fill and stroke geometry; the renderer
 * sidesteps that by skipping fill for these shapes
 * (`OPEN_PATH_KINDS` in `shape-renderer.ts`) so only the stroke
 * outline ever paints. `<a:noFill/>` is the dominant real-world
 * usage; filled brackets would otherwise auto-close into a
 * misleading C-rect.
 *
 * adj1: corner radius as % of min(w, h) — OOXML
 * `g1 = ss * adj1 / 100000`. Default 8333 → 8.33% of min(w,h).
 * Capped at min(w,h)/2 to prevent the two corners from overlapping.
 */
export const BRACKET_ADJUSTMENTS: readonly AdjustmentSpec[] = [
  { name: 'Corner radius', defaultValue: 8333, min: 0, max: 50000 },
];

export const DEF_BRACKET_RADIUS = 8333;

export function bracketCornerRadius(
  { w, h }: { w: number; h: number },
  adjustments?: number[],
): number {
  const a = adj(adjustments, 0, DEF_BRACKET_RADIUS);
  const ss = Math.min(w, h);
  const maxAdj = ss > 0 ? 50000 * h / ss : 0;
  const pinned = Math.max(0, Math.min(maxAdj, a));
  return ss * (pinned / 100000);
}

export const buildLeftBracket: PathBuilder = (size, adjustments) => {
  const { w, h } = size;
  const r = bracketCornerRadius(size, adjustments);
  const path = new Path2D();
  path.moveTo(w, 0);
  path.lineTo(r, 0);
  path.quadraticCurveTo(0, 0, 0, r);
  path.lineTo(0, h - r);
  path.quadraticCurveTo(0, h, r, h);
  path.lineTo(w, h);
  return path;
};

export const LEFT_BRACKET_HANDLES: readonly AdjustmentHandle[] = [
  {
    position: (size, adjustments) => {
      const r = bracketCornerRadius(size, adjustments);
      return { x: insetAlongAxis(0, size.w), y: insetAlongAxis(r, size.h) };
    },
    apply: ({ w, h }, _start, pointer) => {
      const ss = Math.min(w, h);
      const maxAdj = ss > 0 ? 50000 * h / ss : 0;
      const raw = ss > 0 ? Math.round((pointer.y / ss )* 100000) : DEF_BRACKET_RADIUS;
      return [Math.max(0, Math.min(maxAdj, raw))];
    },
  },
];
