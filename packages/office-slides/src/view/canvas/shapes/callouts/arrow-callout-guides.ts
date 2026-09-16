import { adj } from '../builder';

export interface ArrowCalloutGuides {
  ss: number;
  a1: number;
  a2: number;
  a3: number;
  a4: number;
  maxA1: number;
  maxA2: number;
  maxA3: number;
  maxA4: number;
}

export const pin = (min: number, value: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/** Resolve the exact DrawingML guide chain shared by directional callouts. */
export function resolveArrowCalloutGuides(
  w: number,
  h: number,
  adjustments: number[] | undefined,
  options: { vertical: boolean; bidirectional: boolean; defaults: readonly number[] },
): ArrowCalloutGuides {
  const ss = Math.min(w, h);
  const cross = options.vertical ? w : h;
  const along = options.vertical ? h : w;
  const headFactor = options.bidirectional ? 50000 : 100000;
  const maxA2 = ss > 0 ? (50000 * cross) / ss : 0;
  const a2 = pin(0, adj(adjustments, 1, options.defaults[1]), maxA2);
  const maxA1 = 2 * a2;
  const a1 = pin(0, adj(adjustments, 0, options.defaults[0]), maxA1);
  const maxA3 = ss > 0 ? (headFactor * along) / ss : 0;
  const a3 = pin(0, adj(adjustments, 2, options.defaults[2]), maxA3);
  const q2 = along > 0
    ? (a3 * ss) / (options.bidirectional ? along / 2 : along)
    : 0;
  const maxA4 = Math.max(0, 100000 - q2);
  const a4 = pin(0, adj(adjustments, 3, options.defaults[3]), maxA4);
  return { ss, a1, a2, a3, a4, maxA1, maxA2, maxA3, maxA4 };
}
