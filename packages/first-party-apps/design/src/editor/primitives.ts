/**
 * Deterministic vector-network builders for the human ellipse, line, and
 * common-shape tools. The document format already has a durable vector network, so
 * these tools do not introduce a parallel primitive schema.
 */

import type { VectorNetwork, VectorSegment, VectorVertex } from "../vector";
import type { Point } from "./viewport";

/**
 * The intentionally bounded set exposed by the future Shapes menu. These are
 * creation affordances, not a second document schema: each one is stored as a
 * normal vector network and is freely editable after creation.
 */
export const COMMON_SHAPE_TOOLS = [
  "triangle",
  "diamond",
  "pentagon",
  "hexagon",
  "star",
  "arrow",
] as const;

export type CommonShapeTool = (typeof COMMON_SHAPE_TOOLS)[number];

/**
 * `polygon` remains a backwards-compatible alias for the old triangle tool.
 * New callers should choose a concrete common-shape tool instead.
 */
export type PrimitiveTool = "ellipse" | "line" | "polygon" | CommonShapeTool;
export type BuiltPrimitive = {
  network: VectorNetwork;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Matches the existing vector node default; used only for click/near-click creation. */
export const DEFAULT_PRIMITIVE_SIZE = 100;
/** The editor's existing small-drag threshold, in canvas coordinates. */
const NEAR_CLICK_DISTANCE = 4;
const ELLIPSE_KAPPA = 0.5522847498307936;

function isNearClick(start: Point, end: Point): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) < NEAR_CLICK_DISTANCE;
}

function boundedDrag(start: Point, end: Point): { x: number; y: number; width: number; height: number } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (isNearClick(start, end)) {
    return { x: start.x, y: start.y, width: DEFAULT_PRIMITIVE_SIZE, height: DEFAULT_PRIMITIVE_SIZE };
  }
  const width = Math.max(1, Math.abs(dx));
  const height = Math.max(1, Math.abs(dy));
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width,
    height,
  };
}

function closedSegments(vertices: readonly VectorVertex[], prefix: string): VectorSegment[] {
  return vertices.map((vertex, index) => {
    const next = vertices[(index + 1) % vertices.length]!;
    const segment: VectorSegment = {
      id: `${prefix}-s${index}`,
      startVertexId: vertex.id,
      endVertexId: next.id,
    };
    return segment;
  });
}

function ellipseNetwork(width: number, height: number): VectorNetwork {
  const rx = width / 2;
  const ry = height / 2;
  const kx = rx * ELLIPSE_KAPPA;
  const ky = ry * ELLIPSE_KAPPA;
  const vertices: VectorVertex[] = [
    { id: "ellipse-v0", x: rx, y: 0 },
    { id: "ellipse-v1", x: width, y: ry },
    { id: "ellipse-v2", x: rx, y: height },
    { id: "ellipse-v3", x: 0, y: ry },
  ];
  const segments: VectorSegment[] = [
    { id: "ellipse-s0", startVertexId: "ellipse-v0", endVertexId: "ellipse-v1", startHandle: { x: rx + kx, y: 0 }, endHandle: { x: width, y: ry - ky } },
    { id: "ellipse-s1", startVertexId: "ellipse-v1", endVertexId: "ellipse-v2", startHandle: { x: width, y: ry + ky }, endHandle: { x: rx + kx, y: height } },
    { id: "ellipse-s2", startVertexId: "ellipse-v2", endVertexId: "ellipse-v3", startHandle: { x: rx - kx, y: height }, endHandle: { x: 0, y: ry + ky } },
    { id: "ellipse-s3", startVertexId: "ellipse-v3", endVertexId: "ellipse-v0", startHandle: { x: 0, y: ry - ky }, endHandle: { x: rx - kx, y: 0 } },
  ];
  return { vertices, segments, regions: [{ id: "ellipse-r0", vertexIds: vertices.map((vertex) => vertex.id) }] };
}

function lineNetwork(width: number, height: number, dx: number, dy: number): VectorNetwork {
  const start = {
    x: dx > 0 ? 0 : dx < 0 ? width : width / 2,
    y: dy > 0 ? 0 : dy < 0 ? height : height / 2,
  };
  const end = {
    x: dx > 0 ? width : dx < 0 ? 0 : width / 2,
    y: dy > 0 ? height : dy < 0 ? 0 : height / 2,
  };
  return {
    vertices: [{ id: "line-v0", ...start }, { id: "line-v1", ...end }],
    segments: [{ id: "line-s0", startVertexId: "line-v0", endVertexId: "line-v1" }],
    regions: [],
  };
}

type NormalizedVertex = readonly [x: number, y: number];

const COMMON_SHAPE_VERTICES: Record<CommonShapeTool, readonly NormalizedVertex[]> = {
  triangle: [[0.5, 0], [1, 1], [0, 1]],
  diamond: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]],
  pentagon: [[0.5, 0], [1, 0.382], [0.809, 1], [0.191, 1], [0, 0.382]],
  hexagon: [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]],
  star: [
    [0.5, 0], [0.618, 0.338], [0.976, 0.382], [0.691, 0.609], [0.794, 1],
    [0.5, 0.75], [0.206, 1], [0.309, 0.609], [0.024, 0.382], [0.382, 0.338],
  ],
  arrow: [[0, 0.2], [0.6, 0.2], [0.6, 0], [1, 0.5], [0.6, 1], [0.6, 0.8], [0, 0.8]],
};

function commonShapeNetwork(
  shape: CommonShapeTool,
  width: number,
  height: number,
  prefix: string = shape,
): VectorNetwork {
  const vertices: VectorVertex[] = COMMON_SHAPE_VERTICES[shape].map(([x, y], index) => ({
    id: `${prefix}-v${index}`,
    x: x * width,
    y: y * height,
  }));
  return {
    vertices,
    segments: closedSegments(vertices, prefix),
    regions: [{ id: `${prefix}-r0`, vertexIds: vertices.map((vertex) => vertex.id) }],
  };
}

export function isVectorPrimitiveTool(tool: string): tool is PrimitiveTool {
  return tool === "ellipse" || tool === "line" || tool === "polygon" || COMMON_SHAPE_TOOLS.includes(tool as CommonShapeTool);
}

export function primitiveDisplayName(tool: PrimitiveTool): string {
  switch (tool) {
    case "ellipse": return "Ellipse";
    case "line": return "Line";
    case "polygon": return "Triangle";
    default: return tool[0]!.toUpperCase() + tool.slice(1);
  }
}

/** Build a vector primitive from a drag; click/near-click creation uses the conventional 100×100 vector default. */
export function buildPrimitiveFromDrag(tool: PrimitiveTool, start: Point, end: Point): BuiltPrimitive {
  const box = boundedDrag(start, end);
  const lineDx = isNearClick(start, end) ? box.width : end.x - start.x;
  const lineDy = isNearClick(start, end) ? box.height : end.y - start.y;
  const network = tool === "ellipse"
    ? ellipseNetwork(box.width, box.height)
    : tool === "line"
      ? lineNetwork(box.width, box.height, lineDx, lineDy)
      : tool === "polygon"
        ? commonShapeNetwork("triangle", box.width, box.height, "polygon")
        : commonShapeNetwork(tool, box.width, box.height);
  return { ...box, network };
}

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

function sameHandle(
  left: VectorSegment["startHandle"],
  right: VectorSegment["startHandle"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameNumber(left.x, right.x) && sameNumber(left.y, right.y);
}

/** Compare vector geometry while deliberately ignoring durable element IDs. */
function samePrimitiveGeometry(actual: VectorNetwork, expected: VectorNetwork): boolean {
  if (
    actual.vertices.length !== expected.vertices.length ||
    actual.segments.length !== expected.segments.length ||
    actual.regions.length !== expected.regions.length
  ) {
    return false;
  }
  const actualVertexIndex = new Map(actual.vertices.map((vertex, index) => [vertex.id, index]));
  const expectedVertexIndex = new Map(expected.vertices.map((vertex, index) => [vertex.id, index]));
  if (!actual.vertices.every((vertex, index) => {
    const candidate = expected.vertices[index]!;
    return sameNumber(vertex.x, candidate.x) && sameNumber(vertex.y, candidate.y);
  })) {
    return false;
  }
  if (!actual.segments.every((segment, index) => {
    const candidate = expected.segments[index]!;
    return actualVertexIndex.get(segment.startVertexId) === expectedVertexIndex.get(candidate.startVertexId)
      && actualVertexIndex.get(segment.endVertexId) === expectedVertexIndex.get(candidate.endVertexId)
      && sameHandle(segment.startHandle, candidate.startHandle)
      && sameHandle(segment.endHandle, candidate.endHandle);
  })) {
    return false;
  }
  return actual.regions.every((region, index) => {
    const candidate = expected.regions[index]!;
    return region.vertexIds.length === candidate.vertexIds.length
      && region.vertexIds.every((vertexId, vertexIndex) =>
        actualVertexIndex.get(vertexId) === expectedVertexIndex.get(candidate.vertexIds[vertexIndex]!)
      );
  });
}

/**
 * Recover the public creation primitive when a canonical vector still has its
 * exact primitive geometry. The document remains a single vector schema; this
 * is inspection metadata, and disappears naturally after a Pen edit changes
 * the geometry.
 */
export function inferVectorPrimitive(
  network: VectorNetwork,
  width: number,
  height: number,
): PrimitiveTool | null {
  if (
    network.vertices.length === 2 &&
    network.segments.length === 1 &&
    network.regions.length === 0
  ) {
    return "line";
  }
  if (!(width > 0) || !(height > 0)) return null;
  const candidates: readonly PrimitiveTool[] = ["ellipse", ...COMMON_SHAPE_TOOLS];
  for (const candidate of candidates) {
    const expected = buildPrimitiveFromDrag(candidate, { x: 0, y: 0 }, { x: width, y: height });
    if (samePrimitiveGeometry(network, expected.network)) return candidate;
  }
  return null;
}
