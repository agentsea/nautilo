/**
 * Pure pen-tool model: turn a sequence of anchors (each an optional symmetric
 * Bézier handle) into a `VectorNetwork`. This is DOM-free so the click →
 * geometry logic is unit-tested without a canvas. The interaction layer
 * (interactions.ts) collects clicks/drags into a `PenPath`; `buildVector`
 * converts a finished path into a node-ready, origin-local network + box.
 */

import { vectorNetworkBounds, type VectorNetwork, type VectorSegment, type VectorVertex } from "../vector";
import { translateNetwork, type VectorNodeBox } from "./vector-edit";

/** Symmetric handle: the out-direction offset from the anchor; the in-handle is its mirror. */
export type PenHandle = { dx: number; dy: number };

export type PenAnchor = {
  x: number;
  y: number;
  handle?: PenHandle;
};

export type PenPath = {
  anchors: PenAnchor[];
  closed: boolean;
};

export type BuiltVector = { network: VectorNetwork } & VectorNodeBox;

export function emptyPenPath(): PenPath {
  return { anchors: [], closed: false };
}

/** True when (x, y) is within `tol` of the path's first anchor. */
export function nearFirstAnchor(path: PenPath, x: number, y: number, tol: number): boolean {
  const first = path.anchors[0];
  if (!first) return false;
  return Math.hypot(x - first.x, y - first.y) <= tol;
}

function anchorOut(a: PenAnchor): { x: number; y: number } | null {
  return a.handle ? { x: a.x + a.handle.dx, y: a.y + a.handle.dy } : null;
}

function anchorIn(a: PenAnchor): { x: number; y: number } | null {
  return a.handle ? { x: a.x - a.handle.dx, y: a.y - a.handle.dy } : null;
}

/**
 * Build an absolute-coordinate `VectorNetwork` from a pen path. An edge between
 * two anchors becomes a cubic when either endpoint carries a handle (a corner
 * endpoint contributes a control point coincident with its own anchor);
 * otherwise it is a straight line. A closed path adds the wrap edge plus a
 * region so it fills/round-trips as a loop.
 */
export function penPathToNetwork(path: PenPath, prefix = "vn"): VectorNetwork {
  const anchors = path.anchors;
  const n = anchors.length;
  const vertices: VectorVertex[] = anchors.map((a, i) => ({ id: `${prefix}-v${i}`, x: a.x, y: a.y }));
  const segments: VectorSegment[] = [];
  const edgeCount = path.closed ? n : n - 1;
  for (let i = 0; i < edgeCount; i++) {
    const a = anchors[i]!;
    const j = (i + 1) % n;
    const b = anchors[j]!;
    const seg: VectorSegment = {
      id: `${prefix}-s${i}`,
      startVertexId: vertices[i]!.id,
      endVertexId: vertices[j]!.id,
    };
    const outA = anchorOut(a);
    const inB = anchorIn(b);
    if (outA || inB) {
      seg.startHandle = outA ?? { x: a.x, y: a.y };
      seg.endHandle = inB ?? { x: b.x, y: b.y };
    }
    segments.push(seg);
  }
  const regions =
    path.closed && n >= 2 ? [{ id: `${prefix}-r0`, vertexIds: vertices.map((v) => v.id) }] : [];
  return { vertices, segments, regions };
}

/**
 * Convert a finished pen path into a node-ready vector: an origin-local network
 * (min corner at 0, 0) plus the node box that places it back in canvas space.
 * Returns `null` when there are fewer than two anchors (nothing to draw).
 */
export function buildVector(path: PenPath, prefix = "vn"): BuiltVector | null {
  if (path.anchors.length < 2) return null;
  const abs = penPathToNetwork(path, prefix);
  const bounds = vectorNetworkBounds(abs);
  if (!bounds) return null;
  return {
    network: translateNetwork(abs, -bounds.minX, -bounds.minY),
    x: bounds.minX,
    y: bounds.minY,
    width: Math.max(1, bounds.maxX - bounds.minX),
    height: Math.max(1, bounds.maxY - bounds.minY),
  };
}
