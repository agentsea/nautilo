import type { DesignNode } from "../scene-graph";
import { vectorNetworkBounds, type VectorNetwork, type VectorVertex, type VectorSegment } from "../vector";
import { nodeTransformMatrix, transformPoint } from "../geometry";
import { translateNetwork } from "./vector-edit";
import type { VectorTransaction } from "../transactions";

export type PathEdit =
  | { kind: "add"; segmentId: string }
  | { kind: "delete" | "smooth" | "corner" | "split"; vertexId: string }
  | { kind: "join"; firstVertexId: string; secondVertexId: string };

function nextId(existing: readonly { id: string }[], prefix: string): string {
  const ids = new Set(existing.map((value) => value.id));
  let next = 1;
  while (ids.has(`${prefix}-${next}`)) next++;
  return `${prefix}-${next}`;
}
const mid = (a: VectorVertex | { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function editPathNetwork(original: VectorNetwork, edit: PathEdit): VectorNetwork {
  const net = structuredClone(original);
  if (edit.kind === "add") {
    const segment = net.segments.find((value) => value.id === edit.segmentId);
    if (!segment) throw new Error("Choose a segment to add a point.");
    const start = net.vertices.find((vertex) => vertex.id === segment.startVertexId)!;
    const end = net.vertices.find((vertex) => vertex.id === segment.endVertexId)!;
    const curved = Boolean(segment.startHandle || segment.endHandle);
    const a = mid(start, segment.startHandle ?? start);
    const b = mid(segment.startHandle ?? start, segment.endHandle ?? end);
    const c = mid(segment.endHandle ?? end, end);
    const d = mid(a, b), e = mid(b, c);
    const point = curved ? mid(d, e) : mid(start, end);
    const vertex: VectorVertex = { id: nextId(net.vertices, "point"), ...point };
    net.vertices.push(vertex);
    const second: VectorSegment = { id: nextId(net.segments, "edge"), startVertexId: vertex.id, endVertexId: end.id,
      ...(curved ? { startHandle: e, endHandle: c } : {}) };
    const first: VectorSegment = { ...segment, endVertexId: vertex.id, ...(curved ? { startHandle: a, endHandle: d } : {}) };
    net.segments = net.segments.flatMap((value) => value.id === segment.id ? [first, second] : [value]);
    net.regions = net.regions.map((region) => ({ ...region, vertexIds: region.vertexIds.flatMap((id, index, ids) => {
      const following = ids[(index + 1) % ids.length];
      return (id === start.id && following === end.id) || (id === end.id && following === start.id) ? [id, vertex.id] : [id];
    }) }));
    return net;
  }
  if (edit.kind === "join") {
    const ids = [edit.firstVertexId, edit.secondVertexId];
    if (ids[0] === ids[1] || ids.some((id) => !net.vertices.some((vertex) => vertex.id === id))) throw new Error("Choose two distinct endpoints.");
    if (ids.some((id) => net.segments.filter((edge) => edge.startVertexId === id || edge.endVertexId === id).length > 1)) throw new Error("Join requires two open endpoints.");
    if (net.segments.some((edge) => ids.includes(edge.startVertexId) && ids.includes(edge.endVertexId))) throw new Error("These endpoints are already joined.");
    // Follow the first component before inserting the edge. If it reaches the
    // other endpoint, joining closes that path and adds its filled region.
    const chain = [ids[0]!];
    let prior: string | null = null, current = ids[0]!;
    while (true) {
      const edge = net.segments.find((edge) => edge.id !== prior && (edge.startVertexId === current || edge.endVertexId === current));
      if (!edge) break;
      const next = edge.startVertexId === current ? edge.endVertexId : edge.startVertexId;
      if (chain.includes(next)) break;
      chain.push(next); prior = edge.id; current = next;
    }
    net.segments.push({ id: nextId(net.segments, "edge"), startVertexId: ids[0]!, endVertexId: ids[1]! });
    if (chain[chain.length - 1] === ids[1] && chain.length >= 3) net.regions.push({ id: nextId(net.regions, "region"), vertexIds: chain });
    return net;
  }
  const vertex = net.vertices.find((value) => value.id === edit.vertexId);
  if (!vertex) throw new Error("Choose a point first.");
  const incident = net.segments.filter((edge) => edge.startVertexId === vertex.id || edge.endVertexId === vertex.id);
  if (edit.kind === "delete") {
    if (net.vertices.length <= 2) throw new Error("A path needs two points. Delete the object to remove the whole path.");
    if (incident.length > 2) throw new Error("This junction connects several paths. Break the branches before deleting it.");
    net.segments = net.segments.filter((edge) => !incident.includes(edge));
    if (incident.length === 2) {
      const other = incident.map((edge) => edge.startVertexId === vertex.id ? edge.endVertexId : edge.startVertexId);
      if (other[0] !== other[1]) net.segments.push({ id: nextId(net.segments, "edge"), startVertexId: other[0]!, endVertexId: other[1]! });
    }
    net.vertices = net.vertices.filter((value) => value.id !== vertex.id);
    net.regions = net.regions.map((region) => ({ ...region, vertexIds: region.vertexIds.filter((id) => id !== vertex.id) })).filter((region) => region.vertexIds.length >= 3);
  } else if (edit.kind === "split") {
    if (incident.length !== 2) throw new Error("Break requires a point between two segments.");
    const clone = { ...vertex, id: nextId(net.vertices, "point") };
    net.vertices.push(clone);
    const edge = incident[1]!;
    if (edge.startVertexId === vertex.id) edge.startVertexId = clone.id;
    else edge.endVertexId = clone.id;
    net.regions = net.regions.filter((region) => !region.vertexIds.includes(vertex.id));
  } else if (edit.kind === "corner") {
    for (const edge of incident) {
      if (edge.startVertexId === vertex.id) delete edge.startHandle;
      if (edge.endVertexId === vertex.id) delete edge.endHandle;
    }
  } else {
    if (incident.length !== 2) throw new Error("Smooth requires a point between two segments.");
    const neighbors = incident.map((edge) => net.vertices.find((value) => value.id === (edge.startVertexId === vertex.id ? edge.endVertexId : edge.startVertexId))!);
    const dx = neighbors[1]!.x - neighbors[0]!.x, dy = neighbors[1]!.y - neighbors[0]!.y;
    const distance = Math.hypot(dx, dy);
    if (!distance) throw new Error("Move the neighboring points apart before smoothing.");
    incident.forEach((edge, index) => {
      const length = Math.hypot(neighbors[index]!.x - vertex.x, neighbors[index]!.y - vertex.y) / 3;
      const direction = index === 0 ? -1 : 1;
      const handle = { x: vertex.x + dx / distance * length * direction, y: vertex.y + dy / distance * length * direction };
      if (edge.startVertexId === vertex.id) edge.startHandle = handle;
      else edge.endHandle = handle;
    });
  }
  return net;
}

/** Reframe edited local coordinates while preserving their original document transform. */
export function pathEditTransaction(node: DesignNode, edit: PathEdit): VectorTransaction {
  if (!node.vectorNetwork || node.connector) throw new Error("Choose an ordinary vector path.");
  const net = editPathNetwork(node.vectorNetwork, edit);
  const bounds = vectorNetworkBounds(net);
  if (!bounds) throw new Error("The edited path has no geometry.");
  const width = bounds.maxX - bounds.minX, height = bounds.maxY - bounds.minY;
  const linear = nodeTransformMatrix({ ...node, x: 0, y: 0, width: 0, height: 0 });
  const shift = transformPoint({ x: bounds.minX + width / 2 - node.width / 2, y: bounds.minY + height / 2 - node.height / 2 }, linear);
  return { kind: "vector", nodeId: node.id, vectorNetwork: translateNetwork(net, -bounds.minX, -bounds.minY),
    x: node.x + node.width / 2 + shift.x - width / 2, y: node.y + node.height / 2 + shift.y - height / 2, width, height };
}
