import type { PathBuilder } from '../builder';
import { adj } from '../builder';
import { ARROW_ADJUSTMENTS, RIGHT_ARROW_HANDLES } from './right-arrow';

/**
 * `notchedRightArrow` — right arrow with a V-shaped notch cut into
 * the tail. Same `ARROW_ADJUSTMENTS` (shaft width + head length) as
 * `rightArrow`; the notch depth follows the preset's coupled shaft/head
 * guide `x1 = dy1*dx2/hd2`.
 */
export const NOTCHED_RIGHT_ARROW_ADJUSTMENTS = ARROW_ADJUSTMENTS;
export const NOTCHED_RIGHT_ARROW_HANDLES = RIGHT_ARROW_HANDLES;

export const buildNotchedRightArrow: PathBuilder = ({ w, h }, adjustments) => {
  const ss = Math.min(w, h);
  const shaft = Math.max(0, Math.min(100000, adj(adjustments, 0, 50000)));
  const maxHead = ss > 0 ? (100000 * w) / ss : 0;
  const head = Math.max(0, Math.min(maxHead, adj(adjustments, 1, 50000)));
  const headLen = (head / 100000) * ss;
  const headHalf = (shaft / 100000) * (h / 2);
  const notchDepth = (headHalf * headLen) / (h / 2 || 1);
  const path = new Path2D();
  path.moveTo(0, h / 2 - headHalf);
  path.lineTo(w - headLen, h / 2 - headHalf);
  path.lineTo(w - headLen, 0);
  path.lineTo(w, h / 2);
  path.lineTo(w - headLen, h);
  path.lineTo(w - headLen, h / 2 + headHalf);
  path.lineTo(0, h / 2 + headHalf);
  // V notch back to start, dipping inward.
  path.lineTo(notchDepth, h / 2);
  path.closePath();
  return path;
};
