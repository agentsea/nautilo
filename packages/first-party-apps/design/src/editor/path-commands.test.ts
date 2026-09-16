import { expect, test } from "bun:test";
import { penPathToNetwork } from "./pen";
import { editPathNetwork, pathEditTransaction } from "./path-commands";
import { createNode } from "../scene-graph";
import { commandsFromVectorNetwork } from "../vector";
import { nodeLocalToDocument } from "../geometry";

const triangle = () => penPathToNetwork({ anchors: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }], closed: true });

test("adding a point preserves cubic geometry through exact subdivision", () => {
  const net = penPathToNetwork({ anchors: [{ x: 0, y: 0, handle: { dx: 30, dy: 60 } }, { x: 100, y: 0, handle: { dx: 30, dy: -60 } }], closed: false });
  const next = editPathNetwork(net, { kind: "add", segmentId: net.segments[0]!.id });
  expect(next.vertices).toHaveLength(3);
  expect(next.segments).toHaveLength(2);
  const midpoint = next.vertices[2]!;
  expect(midpoint.x).toBe(50);
  expect(midpoint.y).toBe(45);
  expect(next.segments[0]!.endHandle).toEqual({ x: 32.5, y: 45 });
  expect(next.segments[1]!.startHandle).toEqual({ x: 67.5, y: 45 });
  expect(net.vertices).toHaveLength(2);
});

test("break and join preserve all geometry and restore a closed region", () => {
  const net = triangle();
  const split = editPathNetwork(net, { kind: "split", vertexId: net.vertices[0]!.id });
  expect(split.regions).toHaveLength(0);
  expect(split.vertices).toHaveLength(4);
  const joined = editPathNetwork(split, { kind: "join", firstVertexId: net.vertices[0]!.id, secondVertexId: split.vertices[3]!.id });
  expect(joined.regions).toHaveLength(1);
  expect(joined.segments).toHaveLength(4);
});

test("smooth/corner edit only incident tangents and delete reconnects a closed path", () => {
  const net = triangle();
  const smooth = editPathNetwork(net, { kind: "smooth", vertexId: net.vertices[1]!.id });
  expect(smooth.segments[0]!.endHandle).toBeDefined();
  expect(smooth.segments[1]!.startHandle).toBeDefined();
  expect(commandsFromVectorNetwork(smooth).filter((command) => command.kind === "C")).toHaveLength(2);
  const corner = editPathNetwork(smooth, { kind: "corner", vertexId: net.vertices[1]!.id });
  expect(corner.segments[0]!.endHandle).toBeUndefined();
  const added = editPathNetwork(net, { kind: "add", segmentId: net.segments[0]!.id });
  const deleted = editPathNetwork(added, { kind: "delete", vertexId: added.vertices[3]!.id });
  expect(deleted.vertices).toEqual(net.vertices);
  expect(deleted.regions[0]!.vertexIds).toEqual(net.regions[0]!.vertexIds);
});

test("path reframing keeps rotated untouched points fixed in document coordinates", () => {
  const network = triangle();
  const node = createNode({ id: "path", type: "vector", parentId: null, x: 100, y: 30, width: 100, height: 100, rotation: 40, skewX: 12, vectorNetwork: network });
  const edit = pathEditTransaction(node, { kind: "smooth", vertexId: network.vertices[1]!.id });
  const next = { ...node, ...edit };
  network.vertices.forEach((vertex, i) => {
    const before = nodeLocalToDocument(node, vertex);
    const after = nodeLocalToDocument(next, edit.vectorNetwork.vertices[i]!);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });
});
