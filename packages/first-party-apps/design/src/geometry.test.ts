import { describe, expect, test } from "bun:test";
import { createNode } from "./scene-graph";
import {
  documentToNodeLocal,
  nodeCorners,
  nodeLocalToDocument,
  nodeVisualBounds,
  rotatePoint,
} from "./geometry";

describe("document geometry", () => {
  test("rotates around a node's own center and supports an exact inverse", () => {
    const node = createNode({
      id: "wide",
      type: "rectangle",
      parentId: null,
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      rotation: 90,
    });
    expect(nodeCorners(node).map((point) => ({
      x: Math.round(point.x),
      y: Math.round(point.y),
    }))).toEqual([
      { x: 60, y: -40 },
      { x: 60, y: 60 },
      { x: 40, y: 60 },
      { x: 40, y: -40 },
    ]);
    const documentPoint = nodeLocalToDocument(node, { x: 100, y: 10 });
    const roundTrip = documentToNodeLocal(node, documentPoint);
    expect(roundTrip.x).toBeCloseTo(100);
    expect(roundTrip.y).toBeCloseTo(10);
  });

  test("includes stroke in rotated visual bounds", () => {
    const node = createNode({
      id: "stroke",
      type: "rectangle",
      parentId: null,
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      rotation: 90,
      stroke: { color: "#000", width: 4 },
    });
    const bounds = nodeVisualBounds(node);
    expect(bounds.minX).toBeCloseTo(38);
    expect(bounds.maxX).toBeCloseTo(62);
    expect(bounds.minY).toBeCloseTo(-42);
    expect(bounds.maxY).toBeCloseTo(62);
  });

  test("rotatePoint is stable for no rotation", () => {
    expect(rotatePoint({ x: 4, y: 5 }, { x: 0, y: 0 }, 0)).toEqual({ x: 4, y: 5 });
  });

  test("round-trips skew and reflection through the canonical node transform", () => {
    const node = createNode({ id: "affine", type: "rectangle", parentId: null, x: 10, y: 20, width: 80, height: 40, rotation: 25, skewX: 20, flipX: true });
    const point = { x: 13, y: 9 };
    const documentPoint = nodeLocalToDocument(node, point);
    const roundTrip = documentToNodeLocal(node, documentPoint);
    expect(roundTrip.x).toBeCloseTo(point.x);
    expect(roundTrip.y).toBeCloseTo(point.y);
  });
});
