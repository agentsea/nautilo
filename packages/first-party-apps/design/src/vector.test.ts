import { describe, expect, test } from "bun:test";
import {
  commandsFromVectorNetwork,
  dashArrayToString,
  distanceToCubic,
  distanceToSegment,
  parsePathData,
  pathDataFromCommands,
  pathDataFromVectorNetwork,
  pointNearPath,
  translateCommands,
  vectorNetworkBounds,
  type VectorNetwork,
} from "./vector";

describe("vector", () => {
  test("pathDataFromCommands serializes M/L/C/Z commands", () => {
    const d = pathDataFromCommands([
      { kind: "M", x: 0, y: 0 },
      { kind: "L", x: 10, y: 20 },
      { kind: "C", c1x: 1, c1y: 2, c2x: 3, c2y: 4, x: 5, y: 6 },
      { kind: "Z" },
    ]);
    expect(d).toBe("M 0 0 L 10 20 C 1 2 3 4 5 6 Z");
  });

  test("pathDataFromVectorNetwork walks an open chain (no closing Z)", () => {
    const network: VectorNetwork = {
      vertices: [
        { id: "v1", x: 0, y: 0 },
        { id: "v2", x: 10, y: 0 },
        { id: "v3", x: 10, y: 10 },
      ],
      segments: [
        { id: "s1", startVertexId: "v1", endVertexId: "v2" },
        {
          id: "s2",
          startVertexId: "v2",
          endVertexId: "v3",
          startHandle: { x: 12, y: 2 },
          endHandle: { x: 12, y: 8 },
        },
      ],
      regions: [],
    };
    const d = pathDataFromVectorNetwork(network);
    expect(d).toBe("M 0 0 L 10 0 C 12 2 12 8 10 10");
  });

  test("pathDataFromVectorNetwork closes a cycle with Z (line closing edge dropped)", () => {
    const network: VectorNetwork = {
      vertices: [
        { id: "v1", x: 0, y: 0 },
        { id: "v2", x: 10, y: 0 },
        { id: "v3", x: 10, y: 10 },
      ],
      segments: [
        { id: "s1", startVertexId: "v1", endVertexId: "v2" },
        { id: "s2", startVertexId: "v2", endVertexId: "v3" },
        { id: "s3", startVertexId: "v3", endVertexId: "v1" },
      ],
      regions: [],
    };
    expect(pathDataFromVectorNetwork(network)).toBe("M 0 0 L 10 0 L 10 10 Z");
  });

  test("pathDataFromVectorNetwork emits one subpath per region", () => {
    const network: VectorNetwork = {
      vertices: [
        { id: "a1", x: 0, y: 0 },
        { id: "a2", x: 10, y: 0 },
        { id: "a3", x: 0, y: 10 },
        { id: "b1", x: 20, y: 20 },
        { id: "b2", x: 30, y: 20 },
        { id: "b3", x: 20, y: 30 },
      ],
      segments: [],
      regions: [
        { id: "r1", vertexIds: ["a1", "a2", "a3"] },
        { id: "r2", vertexIds: ["b1", "b2", "b3"] },
      ],
    };
    const d = pathDataFromVectorNetwork(network);
    expect(d).toBe("M 0 0 L 10 0 L 0 10 Z M 20 20 L 30 20 L 20 30 Z");
  });

  test("region honours a curved closing edge with swapped handles when reversed", () => {
    const network: VectorNetwork = {
      vertices: [
        { id: "v1", x: 0, y: 0 },
        { id: "v2", x: 10, y: 0 },
        { id: "v3", x: 10, y: 10 },
      ],
      // Closing edge (v3->v1) is declared v1->v3, so it is traversed reversed
      // and the handles swap order.
      segments: [
        {
          id: "s1",
          startVertexId: "v1",
          endVertexId: "v3",
          startHandle: { x: 2, y: 2 },
          endHandle: { x: 8, y: 8 },
        },
      ],
      regions: [{ id: "r1", vertexIds: ["v1", "v2", "v3"] }],
    };
    // v1->v2 implicit L, v2->v3 implicit L, v3->v1 curved (reversed: endHandle
    // first, startHandle second).
    expect(pathDataFromVectorNetwork(network)).toBe("M 0 0 L 10 0 L 10 10 C 8 8 2 2 0 0 Z");
  });

  test("pathDataFromVectorNetwork handles empty networks", () => {
    expect(pathDataFromVectorNetwork({ vertices: [], segments: [], regions: [] })).toBe("");
  });

  test("pathDataFromCommands formats non-integer numbers without trailing zeros", () => {
    const d = pathDataFromCommands([
      { kind: "M", x: 0.1, y: 0.2 },
      { kind: "L", x: 1.5, y: 2.25 },
    ]);
    expect(d).toBe("M 0.1 0.2 L 1.5 2.25");
  });

  test("path data round-trips exact fractional coordinates without presentation rounding", () => {
    const commands = [
      { kind: "M" as const, x: 1 / 3, y: -2 / 7 },
      { kind: "C" as const, c1x: 5 / 11, c1y: -7 / 13, c2x: 17 / 19, c2y: 23 / 29, x: -31 / 37, y: 41 / 43 },
      { kind: "Z" as const },
    ];
    expect(parsePathData(pathDataFromCommands(commands))).toEqual(commands);
  });

  test("translateCommands offsets every coordinate", () => {
    const out = translateCommands(
      [
        { kind: "M", x: 1, y: 2 },
        { kind: "C", c1x: 3, c1y: 4, c2x: 5, c2y: 6, x: 7, y: 8 },
        { kind: "Z" },
      ],
      10,
      20,
    );
    expect(pathDataFromCommands(out)).toBe("M 11 22 C 13 24 15 26 17 28 Z");
  });

  test("commandsFromVectorNetwork returns command objects", () => {
    const cmds = commandsFromVectorNetwork({
      vertices: [
        { id: "v1", x: 0, y: 0 },
        { id: "v2", x: 4, y: 0 },
      ],
      segments: [{ id: "s1", startVertexId: "v1", endVertexId: "v2" }],
      regions: [],
    });
    expect(cmds).toEqual([
      { kind: "M", x: 0, y: 0 },
      { kind: "L", x: 4, y: 0 },
    ]);
  });

  test("parsePathData resolves relative + H/V commands to absolute M/L/C/Z", () => {
    const cmds = parsePathData("M 0 0 h 10 v 5 l -10 0 Z");
    expect(cmds).not.toBeNull();
    expect(pathDataFromCommands(cmds!)).toBe("M 0 0 L 10 0 L 10 5 L 0 5 Z");
  });

  test("parsePathData round-trips our own cubic output", () => {
    const cmds = parsePathData("M 0 0 C 1 2 3 4 5 6 Z");
    expect(pathDataFromCommands(cmds!)).toBe("M 0 0 C 1 2 3 4 5 6 Z");
  });

  test("parsePathData returns null on unsupported commands", () => {
    expect(parsePathData("M 0 0 A 1 1 0 0 1 5 5")).toBeNull();
    expect(parsePathData("M 0 0 Q 5 5 10 0")).toBeNull();
    expect(parsePathData("M 0 0 S 5 5 10 0")).toBeNull();
    expect(parsePathData("M 0 0 @ L 2 2")).toBeNull();
  });

  test("parsePathData rejects arguments after a close command without hanging", () => {
    expect(parsePathData("M 0 0 Z 1 2")).toBeNull();
  });

  test("parsePathData rejects malformed command order and separators", () => {
    expect(parsePathData("L 0 0")).toBeNull();
    expect(parsePathData("Z")).toBeNull();
    expect(parsePathData("M,0 0")).toBeNull();
    expect(parsePathData("M 0,,0")).toBeNull();
    expect(parsePathData("M 0 0,")).toBeNull();
  });

  test("parsePathData treats empty input as no commands", () => {
    expect(parsePathData("   ")).toEqual([]);
  });

  test("distanceToSegment measures perpendicular + endpoint distance", () => {
    expect(distanceToSegment(5, 5, 0, 0, 10, 0)).toBe(5);
    expect(distanceToSegment(-5, 0, 0, 0, 10, 0)).toBe(5);
    expect(distanceToSegment(3, 0, 3, 3, 3, 3)).toBe(3);
  });

  test("distanceToCubic approximates a straight-line cubic", () => {
    // Control points on the line y=0 -> the curve is the straight segment.
    const d = distanceToCubic(5, 4, 0, 0, 3, 0, 7, 0, 10, 0);
    expect(d).toBeCloseTo(4, 5);
  });

  test("pointNearPath respects tolerance for curves and lines", () => {
    const network: VectorNetwork = {
      vertices: [
        { id: "v1", x: 0, y: 0 },
        { id: "v2", x: 10, y: 0 },
      ],
      segments: [{ id: "s1", startVertexId: "v1", endVertexId: "v2" }],
      regions: [],
    };
    expect(pointNearPath(network, 5, 1, 2)).toBe(true);
    expect(pointNearPath(network, 5, 5, 2)).toBe(false);
  });

  test("vectorNetworkBounds includes vertices and control points", () => {
    const bounds = vectorNetworkBounds({
      vertices: [
        { id: "v1", x: 0, y: 0 },
        { id: "v2", x: 10, y: 10 },
      ],
      segments: [
        {
          id: "s1",
          startVertexId: "v1",
          endVertexId: "v2",
          startHandle: { x: -5, y: 0 },
          endHandle: { x: 10, y: 15 },
        },
      ],
      regions: [],
    });
    expect(bounds).toEqual({ minX: -5, minY: 0, maxX: 10, maxY: 15 });
  });

  test("vectorNetworkBounds returns null for an empty network", () => {
    expect(vectorNetworkBounds({ vertices: [], segments: [], regions: [] })).toBeNull();
  });

  test("dashArrayToString filters invalid entries", () => {
    expect(dashArrayToString([4, 2])).toBe("4 2");
    expect(dashArrayToString([4, -1, Number.NaN, 2.5])).toBe("4 2.5");
    expect(dashArrayToString([])).toBeNull();
    expect(dashArrayToString([-1])).toBeNull();
  });
});
