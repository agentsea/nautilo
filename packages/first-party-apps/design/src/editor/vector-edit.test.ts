import { describe, expect, test } from "bun:test";
import type { VectorNetwork } from "../vector";
import { createNode } from "../scene-graph";
import {
  applyVectorDrag,
  applyVectorNodeDrag,
  hitVectorPart,
  hitVectorNodePart,
  moveHandle,
  moveVertex,
  normalizeVectorNode,
  scaleNetwork,
  translateNetwork,
} from "./vector-edit";

function triangle(): VectorNetwork {
  return {
    vertices: [
      { id: "v0", x: 0, y: 0 },
      { id: "v1", x: 40, y: 0 },
      { id: "v2", x: 40, y: 30 },
    ],
    segments: [
      { id: "s0", startVertexId: "v0", endVertexId: "v1", startHandle: { x: 10, y: 10 }, endHandle: { x: 30, y: 5 } },
      { id: "s1", startVertexId: "v1", endVertexId: "v2" },
    ],
    regions: [{ id: "r0", vertexIds: ["v0", "v1", "v2"] }],
  };
}

describe("hitVectorPart", () => {
  test("prefers a handle over a vertex and returns null when nothing is close", () => {
    const net = triangle();
    expect(hitVectorPart(net, 10, 10, 3)).toEqual({ kind: "handle", segmentId: "s0", end: "start" });
    expect(hitVectorPart(net, 41, 1, 3)).toEqual({ kind: "vertex", vertexId: "v1" });
    expect(hitVectorPart(net, 100, 100, 3)).toBeNull();
  });

  test("node-aware hit testing follows rotation", () => {
    const node = createNode({ id: "v", type: "vector", parentId: null, x: 0, y: 0, width: 40, height: 30, rotation: 90, vectorNetwork: triangle() });
    expect(hitVectorNodePart(node, { x: 35, y: 35 }, 2)).toEqual({ kind: "vertex", vertexId: "v1" });
  });
});

describe("moveVertex", () => {
  test("moves the vertex and carries its incident handles", () => {
    const net = moveVertex(triangle(), "v0", 5, -5);
    expect(net.vertices[0]).toMatchObject({ x: 5, y: -5 });
    // v0 is the start of s0, so its start handle moves too
    expect(net.segments[0]?.startHandle).toEqual({ x: 15, y: 5 });
    // the end handle (near v1) is untouched
    expect(net.segments[0]?.endHandle).toEqual({ x: 30, y: 5 });
  });
});

describe("moveHandle", () => {
  test("moves only the targeted handle", () => {
    const net = moveHandle(triangle(), "s0", "end", -4, 2);
    expect(net.segments[0]?.endHandle).toEqual({ x: 26, y: 7 });
    expect(net.segments[0]?.startHandle).toEqual({ x: 10, y: 10 });
  });
});

describe("translateNetwork / scaleNetwork", () => {
  test("translate shifts every coordinate including handles", () => {
    const net = translateNetwork(triangle(), 100, 50);
    expect(net.vertices[0]).toMatchObject({ x: 100, y: 50 });
    expect(net.segments[0]?.startHandle).toEqual({ x: 110, y: 60 });
  });

  test("scale multiplies local coordinates about the origin", () => {
    const net = scaleNetwork(triangle(), 2, 0.5);
    expect(net.vertices[1]).toMatchObject({ x: 80, y: 0 });
    expect(net.vertices[2]).toMatchObject({ x: 80, y: 15 });
    expect(net.segments[0]?.endHandle).toEqual({ x: 60, y: 2.5 });
  });
});

describe("normalizeVectorNode", () => {
  test("shifts the min corner to (0,0) and offsets the node origin", () => {
    const shifted = translateNetwork(triangle(), -5, -8);
    const { network, box } = normalizeVectorNode(shifted, 100, 100);
    expect(box).toEqual({ x: 95, y: 92, width: 40, height: 30 });
    expect(network.vertices[0]).toMatchObject({ x: 0, y: 0 });
  });
});

describe("applyVectorDrag", () => {
  test("dragging a vertex keeps the anchor's absolute position consistent", () => {
    const node = { x: 100, y: 100, vectorNetwork: triangle() };
    // drag v2 (local 40,30 -> absolute 140,130) by (+20,+20) -> absolute 160,150
    const { network, box } = applyVectorDrag(node, { kind: "vertex", vertexId: "v2" }, 20, 20);
    const v2 = network.vertices.find((v) => v.id === "v2")!;
    // absolute position = box origin + local coord
    expect(box.x + v2.x).toBe(160);
    expect(box.y + v2.y).toBe(150);
  });

  test("node-aware dragging converts document movement into local axes", () => {
    const node = createNode({ id: "v", type: "vector", parentId: null, x: 0, y: 0, width: 40, height: 30, rotation: 90, vectorNetwork: triangle() });
    const before = { x: 35, y: 35 }; // v1 (40,0) rotated around (20,15)
    const result = applyVectorNodeDrag(node, { kind: "vertex", vertexId: "v1" }, 0, 10);
    const v1 = result.network.vertices.find((vertex) => vertex.id === "v1")!;
    const afterNode = { ...node, ...result.box, vectorNetwork: result.network };
    const hit = hitVectorNodePart(afterNode, { x: before.x, y: before.y + 10 }, 0.001);
    expect(v1.x).toBeGreaterThan(0);
    expect(hit).toEqual({ kind: "vertex", vertexId: "v1" });
  });
});
