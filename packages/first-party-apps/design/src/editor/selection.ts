/**
 * Pure hit testing and selection-set helpers for the design canvas. Geometry
 * comes straight from the scene-graph model (absolute x/y/width/height); this
 * module never mutates the document and never touches the DOM.
 */

import { findPage, type DesignDocument, type DesignNode } from "../scene-graph";
import { pointNearPath } from "../vector";
import { boundsToBox, documentToNodeLocal, nodeRenderBounds, vectorNetworkToDocument } from "../geometry";
import type { TextMeasurer } from "../text-layout";
import type { Point } from "./viewport";

type InheritedNodeFlag = "hidden" | "locked";

function nodeOrAncestorHasFlag(
  doc: DesignDocument,
  nodeOrId: DesignNode | string,
  flag: InheritedNodeFlag,
): boolean {
  let node = typeof nodeOrId === "string" ? doc.nodes[nodeOrId] : nodeOrId;
  const visited = new Set<string>();
  while (node) {
    if (node[flag] === true) return true;
    if (node.parentId === null || visited.has(node.id)) return false;
    visited.add(node.id);
    node = doc.nodes[node.parentId];
  }
  return false;
}

/** Hidden and locked state applies to the complete descendant subtree. */
export function isNodeEffectivelyHidden(doc: DesignDocument, nodeOrId: DesignNode | string): boolean {
  return nodeOrAncestorHasFlag(doc, nodeOrId, "hidden");
}

export function isNodeEffectivelyLocked(doc: DesignDocument, nodeOrId: DesignNode | string): boolean {
  return nodeOrAncestorHasFlag(doc, nodeOrId, "locked");
}

export function pointInNode(node: DesignNode, point: Point): boolean {
  if (node.width <= 0 || node.height <= 0) return false;
  const local = documentToNodeLocal(node, point);
  return (
    local.x >= 0 &&
    local.x <= node.width &&
    local.y >= 0 &&
    local.y <= node.height
  );
}

/**
 * Whether `point` (canvas coords) hits `node`, honouring a hit `tolerance`
 * (canvas units) for thin vector paths. A vector node is hit when the point is
 * within tolerance of its path (its network is local to the node origin, so we
 * offset first) or — for a closed/filled vector — inside its bounding box.
 * Non-vector nodes use the plain bounding-box test.
 */
export function nodeContainsPoint(node: DesignNode, point: Point, tolerance = 0): boolean {
  if (node.type === "vector" && node.vectorNetwork) {
    const documentNetwork = vectorNetworkToDocument(node, node.vectorNetwork);
    if (pointNearPath(documentNetwork, point.x, point.y, tolerance)) return true;
    if (node.vectorNetwork.regions.length > 0 && pointInNode(node, point)) return true;
    return false;
  }
  return pointInNode(node, point);
}

/**
 * Flatten a page's nodes in paint order (pre-order: a parent is painted before
 * its children, earlier siblings before later ones). The last entry is the
 * top-most node.
 */
export function paintOrder(doc: DesignDocument, pageId: string): DesignNode[] {
  const page = findPage(doc, pageId);
  if (!page) return [];
  const out: DesignNode[] = [];
  const visit = (id: string): void => {
    const node = doc.nodes[id];
    if (!node || isNodeEffectivelyHidden(doc, node)) return;
    out.push(node);
    for (const childId of node.childIds) visit(childId);
  };
  for (const id of page.children) visit(id);
  return out;
}

/**
 * Return the id of the top-most node containing `point`, or null when the point
 * hits empty canvas. Later-painted (visually on top) nodes win.
 */
export function hitTest(
  doc: DesignDocument,
  pageId: string,
  point: Point,
  tolerance = 0,
): string | null {
  const nodes = paintOrder(doc, pageId);
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]!;
    if (isNodeEffectivelyLocked(doc, node)) continue;
    if (nodeContainsPoint(node, point, tolerance)) return node.id;
  }
  return null;
}

export type SelectMode = "replace" | "toggle";

/** Apply a click to the current selection set, returning the next selection. */
export function applySelection(
  current: readonly string[],
  hitId: string | null,
  mode: SelectMode,
): string[] {
  if (hitId === null) {
    return mode === "toggle" ? [...current] : [];
  }
  if (mode === "toggle") {
    if (current.includes(hitId)) return current.filter((id) => id !== hitId);
    return [...current, hitId];
  }
  if (current.length === 1 && current[0] === hitId) return [...current];
  return [hitId];
}

/**
 * Combined bounding box of a set of nodes in canvas coordinates, or null when
 * no id resolves to a node.
 */
export function selectionBounds(
  doc: DesignDocument,
  ids: readonly string[],
  textMeasurer?: TextMeasurer | null,
): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node || isNodeEffectivelyHidden(doc, node)) continue;
    const bounds = nodeRenderBounds(node, textMeasurer);
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
    seen = true;
  }
  if (!seen) return null;
  return boundsToBox({ minX, minY, maxX, maxY });
}

/** Connector geometry is derived from durable endpoint metadata, never generic box editing. */
export function editableSelectionIds(doc: DesignDocument, ids: readonly string[]): string[] {
  return ids.filter((id) => {
    const node = doc.nodes[id];
    return node !== undefined
      && node.connector === undefined
      && !isNodeEffectivelyHidden(doc, node)
      && !isNodeEffectivelyLocked(doc, node);
  });
}

/** Bounds used for generic resize handles; connectors remain selectable but are excluded. */
export function editableSelectionBounds(
  doc: DesignDocument,
  ids: readonly string[],
  textMeasurer?: TextMeasurer | null,
): { x: number; y: number; width: number; height: number } | null {
  return selectionBounds(doc, editableSelectionIds(doc, ids), textMeasurer);
}
