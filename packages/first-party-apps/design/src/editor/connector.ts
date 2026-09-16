/**
 * Pure connector geometry for the Design canvas. Connectors deliberately stay
 * ordinary vector nodes: this module resolves their small metadata extension
 * into the same origin-local VectorNetwork every renderer and exporter uses.
 */

import type {
  ConnectorEndpoint,
  DesignConnector,
  DesignDocument,
  DesignNode,
} from "../scene-graph";
import { nodeTransformMatrix, transformPoint, inverseTransformPoint } from "../geometry";
import type { VectorNetwork, VectorSegment, VectorVertex } from "../vector";

export type ConnectorPoint = { x: number; y: number };
export type ConnectorGeometry = {
  network: VectorNetwork;
  x: number;
  y: number;
  width: number;
  height: number;
};

const ARROW_SIZE = 8;

function rotatedPoint(node: DesignNode, point: ConnectorPoint): ConnectorPoint {
  return transformPoint(point, nodeTransformMatrix(node));
}

function inverseRotatedPoint(node: DesignNode, point: ConnectorPoint): ConnectorPoint {
  return inverseTransformPoint(point, nodeTransformMatrix(node));
}

/** V1 connector targets are shape-like nodes, never other connectors or open paths. */
export function isEligibleConnectorTarget(node: DesignNode | undefined): node is DesignNode {
  if (!node || node.connector) return false;
  if (node.type === "frame" || node.type === "rectangle") return true;
  if (node.booleanOp !== undefined) return true;
  return node.type === "vector" && node.vectorNetwork !== undefined && node.vectorNetwork.regions.length > 0;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Convert a pointer point into a deterministic nearest-edge normalized anchor.
 * Rotation is inverted before choosing an edge, then reapplied for the durable
 * world-point fallback. An ineligible/missing target produces a free endpoint.
 */
export function connectorEndpointForPoint(
  doc: DesignDocument,
  point: ConnectorPoint,
  targetId: string | null | undefined,
): ConnectorEndpoint {
  const target = targetId === undefined || targetId === null ? undefined : doc.nodes[targetId];
  if (!isEligibleConnectorTarget(target) || target.width <= 0 || target.height <= 0) {
    return { x: point.x, y: point.y };
  }
  const local = inverseRotatedPoint(target, point);
  let x = clampUnit((local.x - target.x) / target.width);
  let y = clampUnit((local.y - target.y) / target.height);
  const distances: Array<[number, "left" | "right" | "top" | "bottom"]> = [
    [x, "left"], [1 - x, "right"], [y, "top"], [1 - y, "bottom"],
  ];
  distances.sort((a, b) => a[0] - b[0]);
  switch (distances[0]![1]) {
    case "left": x = 0; break;
    case "right": x = 1; break;
    case "top": y = 0; break;
    case "bottom": y = 1; break;
  }
  const endpoint: ConnectorEndpoint = { x: point.x, y: point.y, targetId: target.id, anchor: { x, y } };
  const resolved = resolveConnectorEndpoint(doc, endpoint);
  return { ...endpoint, x: resolved.x, y: resolved.y };
}

/** Resolve one endpoint to world coordinates, respecting target rotation. */
export function resolveConnectorEndpoint(doc: DesignDocument, endpoint: ConnectorEndpoint): ConnectorPoint {
  const target = endpoint.targetId === undefined ? undefined : doc.nodes[endpoint.targetId];
  if (!target || !endpoint.anchor) return { x: endpoint.x, y: endpoint.y };
  return rotatedPoint(target, {
    x: target.x + target.width * endpoint.anchor.x,
    y: target.y + target.height * endpoint.anchor.y,
  });
}

function routePoints(connector: DesignConnector, start: ConnectorPoint, end: ConnectorPoint): ConnectorPoint[] {
  if (connector.route === "straight" || (start.x === end.x || start.y === end.y)) return [start, end];
  if (Math.abs(end.x - start.x) >= Math.abs(end.y - start.y)) {
    const midX = (start.x + end.x) / 2;
    return [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
  }
  const midY = (start.y + end.y) / 2;
  return [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end];
}

function arrowWingPoints(tip: ConnectorPoint, towardLine: ConnectorPoint): [ConnectorPoint, ConnectorPoint] | null {
  const dx = towardLine.x - tip.x;
  const dy = towardLine.y - tip.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;
  const ux = dx / length;
  const uy = dy / length;
  const backX = tip.x + ux * ARROW_SIZE;
  const backY = tip.y + uy * ARROW_SIZE;
  const spread = ARROW_SIZE * 0.58;
  return [
    { x: backX - uy * spread, y: backY + ux * spread },
    { x: backX + uy * spread, y: backY - ux * spread },
  ];
}

/** Build origin-local vector geometry, including arrowheads, from metadata. */
export function connectorGeometry(doc: DesignDocument, connector: DesignConnector): ConnectorGeometry {
  const start = resolveConnectorEndpoint(doc, connector.start);
  const end = resolveConnectorEndpoint(doc, connector.end);
  const points = routePoints(connector, start, end);
  const extras: ConnectorPoint[] = [];
  const startWings = connector.startArrow ? arrowWingPoints(start, points[1] ?? end) : null;
  const endWings = connector.endArrow ? arrowWingPoints(end, points[points.length - 2] ?? start) : null;
  if (startWings) extras.push(...startWings);
  if (endWings) extras.push(...endWings);
  const allPoints = [...points, ...extras];
  const minX = Math.min(...allPoints.map((point) => point.x));
  const minY = Math.min(...allPoints.map((point) => point.y));
  const maxX = Math.max(...allPoints.map((point) => point.x));
  const maxY = Math.max(...allPoints.map((point) => point.y));
  const vertices: VectorVertex[] = points.map((point, index) => ({
    id: `connector-p${index}`,
    x: point.x - minX,
    y: point.y - minY,
  }));
  const segments: VectorSegment[] = points.slice(1).map((_, index) => ({
    id: `connector-s${index}`,
    startVertexId: `connector-p${index}`,
    endVertexId: `connector-p${index + 1}`,
  }));
  const addArrow = (tip: ConnectorPoint, wings: [ConnectorPoint, ConnectorPoint] | null, prefix: string): void => {
    if (!wings) return;
    const [left, right] = wings;
    vertices.push(
      { id: `${prefix}-tip`, x: tip.x - minX, y: tip.y - minY },
      { id: `${prefix}-left`, x: left.x - minX, y: left.y - minY },
      { id: `${prefix}-right`, x: right.x - minX, y: right.y - minY },
    );
    segments.push(
      { id: `${prefix}-left-segment`, startVertexId: `${prefix}-left`, endVertexId: `${prefix}-tip` },
      { id: `${prefix}-right-segment`, startVertexId: `${prefix}-tip`, endVertexId: `${prefix}-right` },
    );
  };
  addArrow(start, startWings, "connector-start-arrow");
  addArrow(end, endWings, "connector-end-arrow");
  return {
    network: { vertices, segments, regions: [] },
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/** Regenerate every connector's derived network and box after a model change. */
export function synchronizeConnectors(doc: DesignDocument): DesignDocument {
  let nodes = doc.nodes;
  let changed = false;
  for (const node of Object.values(doc.nodes)) {
    if (!node.connector) continue;
    const geometry = connectorGeometry(doc, node.connector);
    const { network, ...box } = geometry;
    const next: DesignNode = { ...node, ...box, vectorNetwork: network };
    delete next.rotation; delete next.skewX; delete next.flipX;
    if (JSON.stringify(next) !== JSON.stringify(node)) {
      if (!changed) nodes = { ...nodes };
      nodes[node.id] = next;
      changed = true;
    }
  }
  return changed ? { ...doc, nodes } : doc;
}

/** Preserve connectors when targets are deleted by converting only the affected endpoint(s) to free points. */
export function detachConnectorsForDeleted(doc: DesignDocument, deletedNodeIds: ReadonlySet<string>): DesignDocument {
  let nodes = doc.nodes;
  let changed = false;
  for (const node of Object.values(doc.nodes)) {
    if (!node.connector || deletedNodeIds.has(node.id)) continue;
    const detach = (endpoint: ConnectorEndpoint): ConnectorEndpoint => {
      if (!endpoint.targetId || !deletedNodeIds.has(endpoint.targetId)) return endpoint;
      const point = resolveConnectorEndpoint(doc, endpoint);
      return { x: point.x, y: point.y, detachedFromTargetId: endpoint.targetId };
    };
    const start = detach(node.connector.start);
    const end = detach(node.connector.end);
    if (start === node.connector.start && end === node.connector.end) continue;
    if (!changed) nodes = { ...nodes };
    nodes[node.id] = { ...node, connector: { ...node.connector, start, end } };
    changed = true;
  }
  return changed ? { ...doc, nodes } : doc;
}
