import { describe, expect, test } from "bun:test";
import { pathDataFromVectorNetwork } from "../vector";
import { buildVector, emptyPenPath, nearFirstAnchor, penPathToNetwork, type PenPath } from "./pen";

describe("penPathToNetwork", () => {
  test("straight open path yields line segments and no region", () => {
    const path: PenPath = {
      anchors: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      closed: false,
    };
    const net = penPathToNetwork(path);
    expect(net.vertices).toHaveLength(3);
    expect(net.segments).toHaveLength(2);
    expect(net.regions).toHaveLength(0);
    // no handles -> straight lines
    expect(net.segments.every((s) => s.startHandle === undefined && s.endHandle === undefined)).toBe(true);
    expect(pathDataFromVectorNetwork(net)).toBe("M 0 0 L 10 0 L 10 10");
  });

  test("closed path adds the wrap edge and a region", () => {
    const path: PenPath = {
      anchors: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      closed: true,
    };
    const net = penPathToNetwork(path);
    expect(net.segments).toHaveLength(3);
    expect(net.regions).toHaveLength(1);
    expect(net.regions[0]?.vertexIds).toHaveLength(3);
    expect(pathDataFromVectorNetwork(net)).toBe("M 0 0 L 10 0 L 10 10 Z");
  });

  test("a symmetric handle produces a cubic segment with mirrored control points", () => {
    const path: PenPath = {
      anchors: [
        { x: 0, y: 0 },
        { x: 20, y: 0, handle: { dx: 5, dy: 5 } },
      ],
      closed: false,
    };
    const net = penPathToNetwork(path);
    const seg = net.segments[0]!;
    // start anchor has no handle -> control point collapses onto the anchor
    expect(seg.startHandle).toEqual({ x: 0, y: 0 });
    // end anchor's in-handle is the mirror of its out-handle (20-5, 0-5)
    expect(seg.endHandle).toEqual({ x: 15, y: -5 });
  });
});

describe("nearFirstAnchor", () => {
  test("detects proximity to the first anchor within tolerance", () => {
    const path: PenPath = { anchors: [{ x: 5, y: 5 }, { x: 50, y: 50 }], closed: false };
    expect(nearFirstAnchor(path, 6, 6, 3)).toBe(true);
    expect(nearFirstAnchor(path, 20, 20, 3)).toBe(false);
    expect(nearFirstAnchor(emptyPenPath(), 0, 0, 5)).toBe(false);
  });
});

describe("buildVector", () => {
  test("localizes the network so its min corner is (0,0) and reports the node box", () => {
    const path: PenPath = {
      anchors: [
        { x: 100, y: 200 },
        { x: 140, y: 200 },
        { x: 140, y: 260 },
      ],
      closed: true,
    };
    const built = buildVector(path);
    expect(built).not.toBeNull();
    expect(built!.x).toBe(100);
    expect(built!.y).toBe(200);
    expect(built!.width).toBe(40);
    expect(built!.height).toBe(60);
    // local coordinates start at the origin
    expect(built!.network.vertices[0]).toMatchObject({ x: 0, y: 0 });
    expect(built!.network.vertices[1]).toMatchObject({ x: 40, y: 0 });
    expect(built!.network.vertices[2]).toMatchObject({ x: 40, y: 60 });
  });

  test("returns null for fewer than two anchors", () => {
    expect(buildVector({ anchors: [{ x: 0, y: 0 }], closed: false })).toBeNull();
    expect(buildVector(emptyPenPath())).toBeNull();
  });
});
