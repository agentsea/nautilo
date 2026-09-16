import type {
  PathBuilder,
  AdjustmentSpec,
  AdjustmentHandle,
  FaceBuilder,
} from '../builder';
import { adj } from '../builder';
import { insetAlongAxis } from '../handles';

/**
 * `can` — cylinder side view. Outline is a top half-ellipse, two
 * vertical sides, a bottom half-ellipse, plus a separate full top
 * ellipse so the lid is visible when the shape is stroked.
 *
 * Canvas-angle reminder (y-down): angle 0 is +x (right), increasing
 * angle visually rotates clockwise. PI/2 = visually DOWN, 3PI/2 =
 * visually UP. With `anticlockwise=false` (default), the arc traces
 * by increasing angle. So `ellipse(..., PI, 0)` (CW) traces from the
 * left point through 3PI/2 (top) to the right point — the upper half.
 * Conversely `ellipse(..., 0, PI)` (CW) traces through PI/2 (bottom).
 *
 * Adjustments:
 *   [0] topEllipseHeight — OOXML guide value whose rendered ellipse
 *       radius is `ss * adj / 200000`; default 25000.
 */
export const CAN_ADJUSTMENTS: readonly AdjustmentSpec[] = [
  { name: 'Top ellipse height', defaultValue: 25000, min: 0, max: 50000 },
];

function canGeometry({ w, h }: { w: number; h: number }, adjustments?: number[]) {
  const ss = Math.min(w, h);
  const maxAdj = ss > 0 ? (50000 * h) / ss : 0;
  const a = Math.max(0, Math.min(maxAdj, adj(adjustments, 0, 25000) ) );
  const ry = (ss * a) / 200000;
  return { a, maxAdj, ry, handleY: ry * 2 };
}

export const buildCan: PathBuilder = ({ w, h}, adjustments) => {
  const { ry } = canGeometry({ w, h }, adjustments);
  const path = new Path2D();
  // Body silhouette: cylinder side view.
  // Start at the left edge of the top lid level, sweep over the top
  // half-ellipse, down the right side, through the bottom half-ellipse,
  // then back up the left side via closePath.
  path.moveTo(0, ry);
  // Upper half-arc — anticlockwise=false (default). From PI (left) to
  // 0 (right) the angle parameter wraps PI → 3PI/2 → 2PI, tracing
  // through the top of the ellipse.
  path.ellipse(w / 2, ry, w / 2, ry, 0, Math.PI, 0);
  path.lineTo(w, h - ry);
  // Lower half-arc — anticlockwise=false (default). From 0 (right) to
  // PI (left), angle increases through PI/2, tracing through the
  // bottom of the ellipse.
  path.ellipse(w / 2, h - ry, w / 2, ry, 0, 0, Math.PI);
  path.closePath();
  // Can-opening line — only the lower half of the top ellipse. The
  // upper half coincides with the body silhouette's top arc; drawing
  // the full lid would double-stroke the top and create a visible
  // ring. Explicit moveTo before the arc prevents Canvas2D from
  // emitting an implicit lineTo from the body's last point (0, ry)
  // to the arc's start (w, ry) — that would paint a horizontal line
  // across the top of the can in real browsers (the test-canvas
  // shim's ellipse implementation skips the implicit lineTo, so this
  // bug is invisible to unit tests).
  path.moveTo(w, ry);
  path.ellipse(w / 2, ry, w / 2, ry, 0, 0, Math.PI);
  return path;
};

/**
 * Multi-fill faces for the can's 3D look: the cylinder body at the base
 * fill, plus the top lid as a full ellipse, lightened to read as the
 * lit top surface.
 */
export const buildCanFaces: FaceBuilder = ({ w, h }, adjustments) => {
  const { ry } = canGeometry({ w, h }, adjustments) ;
  const body = new Path2D();
  body.moveTo(0, ry);
  body.ellipse(w / 2, ry, w / 2, ry, 0, Math.PI, 0);
  body.lineTo(w, h - ry);
  body.ellipse(w / 2, h - ry, w / 2, ry, 0, 0, Math.PI);
  body.closePath();
  const lid = new Path2D();
  lid.ellipse(w / 2, ry, w / 2, ry, 0, 0, Math.PI * 2);
  return [
    { path: body, shade: 0 },
    { path: lid, shade: 0.16 },
  ];
};

// The OOXML handle sits at (w/2, 2*ry), while the lid centre is y=ry.
// Dragging downward raises ry → taller lid; upward → flatter lid.
// The y inset keeps the diamond off the N (y=0) and S (y=h) resize
// handles when the adjustment sits at a boundary.
export const CAN_HANDLES: readonly AdjustmentHandle[] = [
  {
    position: ({ w, h }, adjustments) => {
      const { handleY } = canGeometry({ w, h }, adjustments) ;
      return { x: w / 2, y: insetAlongAxis(handleY, h) };
    },
    apply: ({ w, h }, _start, pointer) => {
      const ss = Math.min(w, h);
      const maxAdj = ss > 0 ? (50000 * h)/ ss : 0;
      const raw = ss > 0 ? Math.round((pointer.y / ss) * 100000) : 0;
      return [Math.max(0, Math.min(maxAdj, raw))];
    },
  },
];
