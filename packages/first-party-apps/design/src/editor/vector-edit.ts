/**
 * Pure geometry for node-edit mode: hit-testing a `VectorNetwork`'s anchors and
 * control handles, applying a canvas-space drag to a vertex or handle, and
 * scaling/normalizing a network relative to its owning node.
 *
 * A vector node stores its network in coordinates *local* to the node origin
 * (node.x, node.y) — the live renderer and the export renderer both translate
 * by the node origin before drawing, so keeping the network's min corner at
 * (0, 0) is what `normalizeVectorNode` maintains. Everything here is DOM-free
 * and pure.
 */

import { vectorNetworkBounds, type VectorNetwork, type VectorSegmentHandle } from "../vector";
import { inverseTransformVector, nodeTransformMatrix, transformPoint, vectorNetworkToDocument } from "../geometry";
import type { DesignNode } from "../scene-graph";

export type VectorPart =
  | { kind: "vertex"; vertexId: string }
  | { kind: "handle"; segmentId: string; end: "start" | "end" };

export type VectorNodeBox = { x: number; y: number; width: number; height: number };

function shift(handle: VectorSegmentHandle, dx: number, dy: number): VectorSegmentHandle {
  return { x: handle.x + dx, y: handle.y + dy };
}

/** Translate every coordinate in a network by (dx, dy). Pure. */
export function translateNetwork(net: VectorNetwork, dx: number, dy: number): VectorNetwork {
  return {
    vertices: net.vertices.map((v) => ({ ...v, x: v.x + dx, y: v.y + dy })),
    segments: net.segments.map((s) => ({
      ...s,
      ...(s.startHandle ? { startHandle: shift(s.startHandle, dx, dy) } : {}),
      ...(s.endHandle ? { endHandle: shift(s.endHandle, dx, dy) } : {}),
    })),
    regions: net.regions.map((r) => ({ ...r, vertexIds: [...r.vertexIds] })),
  };
}

/** Scale every local coordinate about the network origin (0, 0). Pure. */
export function scaleNetwork(net: VectorNetwork, sx: number, sy: number): VectorNetwork {
  const s = (h: VectorSegmentHandle): VectorSegmentHandle => ({ x: h.x * sx, y: h.y * sy });
  return {
    vertices: net.vertices.map((v) => ({ ...v, x: v.x * sx, y: v.y * sy })),
    segments: net.segments.map((seg) => ({
      ...seg,
      ...(seg.startHandle ? { startHandle: s(seg.startHandle) } : {}),
      ...(seg.endHandle ? { endHandle: s(seg.endHandle) } : {}),
    })),
    regions: net.regions.map((r) => ({ ...r, vertexIds: [...r.vertexIds] })),
  };
}

/**
 * Find the anchor or handle within `tol` of the local point (px, py). Handles
 * are tested before vertices so an on-top control point wins. Returns `null`
 * when nothing is close enough.
 */
export function hitVectorPart(
  net: VectorNetwork,
  px: number,
  py: number,
  tol: number,
): VectorPart | null {
  for (const seg of net.segments) {
    if (seg.startHandle && Math.hypot(seg.startHandle.x - px, seg.startHandle.y - py) <= tol) {
      return { kind: "handle", segmentId: seg.id, end: "start" };
    }
    if (seg.endHandle && Math.hypot(seg.endHandle.x - px, seg.endHandle.y - py) <= tol) {
      return { kind: "handle", segmentId: seg.id, end: "end" };
    }
  }
  for (const v of net.vertices) {
    if (Math.hypot(v.x - px, v.y - py) <= tol) return { kind: "vertex", vertexId: v.id };
  }
  return null;
}

/** Rotation-aware vector hit test for interaction controllers. */
export function hitVectorNodePart(
  node: DesignNode,
  point: { x: number; y: number },
  tolerance: number,
): VectorPart | null {
  if (!node.vectorNetwork) return null;
  return hitVectorPart(vectorNetworkToDocument(node, node.vectorNetwork), point.x, point.y, tolerance);
}

/**
 * Move a vertex by (dx, dy), carrying its incident segment handles along so the
 * local curvature around the anchor is preserved.
 */
export function moveVertex(net: VectorNetwork, vertexId: string, dx: number, dy: number): VectorNetwork {
  return {
    vertices: net.vertices.map((v) => (v.id === vertexId ? { ...v, x: v.x + dx, y: v.y + dy } : v)),
    segments: net.segments.map((seg) => {
      const patch: Partial<Pick<typeof seg, "startHandle" | "endHandle">> = {};
      if (seg.startVertexId === vertexId && seg.startHandle) patch.startHandle = shift(seg.startHandle, dx, dy);
      if (seg.endVertexId === vertexId && seg.endHandle) patch.endHandle = shift(seg.endHandle, dx, dy);
      return Object.keys(patch).length > 0 ? { ...seg, ...patch } : seg;
    }),
    regions: net.regions,
  };
}

/** Move a single segment handle by (dx, dy). */
export function moveHandle(
  net: VectorNetwork,
  segmentId: string,
  end: "start" | "end",
  dx: number,
  dy: number,
): VectorNetwork {
  return {
    vertices: net.vertices,
    segments: net.segments.map((seg) => {
      if (seg.id !== segmentId) return seg;
      if (end === "start" && seg.startHandle) return { ...seg, startHandle: shift(seg.startHandle, dx, dy) };
      if (end === "end" && seg.endHandle) return { ...seg, endHandle: shift(seg.endHandle, dx, dy) };
      return seg;
    }),
    regions: net.regions,
  };
}

/**
 * Re-localize a network so its min corner sits at (0, 0), returning the shifted
 * network and the node box (origin + size) that keeps it in the same absolute
 * place. `originX/Y` is the current node origin the network is local to.
 */
export function normalizeVectorNode(
  net: VectorNetwork,
  originX: number,
  originY: number,
): { network: VectorNetwork; box: VectorNodeBox } {
  const bounds = vectorNetworkBounds(net);
  if (!bounds) {
    return { network: net, box: { x: originX, y: originY, width: 1, height: 1 } };
  }
  return {
    network: translateNetwork(net, -bounds.minX, -bounds.minY),
    box: {
      x: originX + bounds.minX,
      y: originY + bounds.minY,
      width: Math.max(1, bounds.maxX - bounds.minX),
      height: Math.max(1, bounds.maxY - bounds.minY),
    },
  };
}

/**
 * Apply a canvas-space drag delta to a vector part and re-normalize, so the
 * caller gets both the updated (origin-local) network and the node box to
 * commit. `dx/dy` are canvas units (the caller converts screen → canvas).
 */
export function applyVectorDrag(
  node: { x: number; y: number; vectorNetwork: VectorNetwork },
  part: VectorPart,
  dx: number,
  dy: number,
): { network: VectorNetwork; box: VectorNodeBox } {
  const moved =
    part.kind === "vertex"
      ? moveVertex(node.vectorNetwork, part.vertexId, dx, dy)
      : moveHandle(node.vectorNetwork, part.segmentId, part.end, dx, dy);
  return normalizeVectorNode(moved, node.x, node.y);
}

/**
 * Apply a document-space pointer delta to a rotated vector. The network lives
 * in the node's local axes, so the delta is inverse-rotated before mutation.
 */
export function applyVectorNodeDrag(
  node: DesignNode,
  part: VectorPart,
  dx: number,
  dy: number,
): { network: VectorNetwork; box: VectorNodeBox } {
  if (!node.vectorNetwork) throw new Error("Vector node drag requires a vector network.");
  const localDelta = inverseTransformVector({ x: dx, y: dy }, nodeTransformMatrix(node));
  const moved = part.kind === "vertex"
    ? moveVertex(node.vectorNetwork, part.vertexId, localDelta.x, localDelta.y)
    : moveHandle(node.vectorNetwork, part.segmentId, part.end, localDelta.x, localDelta.y);
  const bounds = vectorNetworkBounds(moved);
  if (!bounds) return { network: moved, box: { x: node.x, y: node.y, width: 1, height: 1 } };
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const linear = nodeTransformMatrix({ ...node, x: 0, y: 0, width: 0, height: 0 });
  const centerShift = transformPoint(
    { x: bounds.minX + width / 2 - node.width / 2, y: bounds.minY + height / 2 - node.height / 2 },
    linear,
  );
  const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  return {
    network: translateNetwork(moved, -bounds.minX, -bounds.minY),
    box: {
      x: center.x + centerShift.x - width / 2,
      y: center.y + centerShift.y - height / 2,
      width,
      height,
    },
  };
}
