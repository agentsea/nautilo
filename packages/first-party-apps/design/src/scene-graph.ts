/**
 * Renderer-neutral scene graph for the Nautilo Design mini-app.
 *
 * The scene graph is the source of truth. SVG/DOM is only a render/export
 * backend (Phase 1). Nothing in this module may import DOM types or produce
 * DOM nodes — it is pure data + pure helpers.
 */

import type {
  VectorNetwork,
  VectorRegion,
  VectorSegment,
  VectorSegmentHandle,
  VectorVertex,
} from "./vector";

import { isDesignAssetRef } from "./image-assets";

export const DESIGN_DOCUMENT_VERSION = 1 as const;

export type DesignNodeKind =
  | "frame"
  | "text"
  | "rectangle"
  | "image"
  | "group"
  | "vector";

export type DesignFill = {
  kind: "solid";
  color: string;
  opacity?: number;
};

export type DesignStrokeCap = "butt" | "round" | "square";
export type DesignStrokeJoin = "miter" | "round" | "bevel";

export type DesignStroke = {
  color: string;
  width: number;
  cap?: DesignStrokeCap;
  join?: DesignStrokeJoin;
  dash?: number[];
};

/**
 * A boolean operation composes a node's `childIds` (its operands) at render
 * time using SVG semantics — it is NOT a new `DesignNodeKind`. A node carrying
 * `booleanOp` is typically kind `"group"`.
 */
export type DesignBooleanOp = "union" | "subtract" | "intersect" | "exclude";

export type DesignTextAlign = "left" | "center" | "right";

/** A normalized attachment point on a target node's unrotated box. */
export type ConnectorAnchor = { x: number; y: number };

/**
 * An endpoint is always positionable without its target. `x`/`y` are the
 * durable world point for a free (or just-detached) endpoint; an attached
 * endpoint instead resolves from `targetId` + its normalized `anchor`.
 */
export type ConnectorEndpoint = {
  x: number;
  y: number;
  targetId?: string;
  anchor?: ConnectorAnchor;
  /** Kept after a target deletion so detachment is durable and inspectable. */
  detachedFromTargetId?: string;
};

/** Vector-only routing metadata. The network is a derived render cache. */
export type DesignConnector = {
  route: "straight" | "elbow";
  start: ConnectorEndpoint;
  end: ConnectorEndpoint;
  startArrow?: boolean;
  endArrow?: boolean;
};

/** Upper bound on a stroke dash array length (keeps validation/output bounded). */
const MAX_DASH_ENTRIES = 64;

export type DesignNode = {
  id: string;
  type: DesignNodeKind;
  name: string;
  parentId: string | null;
  childIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  /** QR affine shear and local reflection, applied after rotation. */
  skewX?: number;
  flipX?: boolean;
  opacity?: number;
  fills?: DesignFill[];
  stroke?: DesignStroke;
  /** Explicit Off survives legacy default paint resolution. */
  strokeDisabled?: boolean;
  hidden?: boolean;
  locked?: boolean;
  radius?: number;
  radiusY?: number;
  // text-specific
  text?: string;
  fontSize?: number;
  /** Geometric horizontal glyph scaling, not a CSS font variant. */
  fontStretch?: number;
  fontFamily?: string;
  fontWeight?: string | number;
  textAlign?: DesignTextAlign;
  /** Line-height multiplier; omission preserves legacy 1.25. */
  lineHeight?: number;
  textWrap?: boolean;
  color?: string;
  // Legacy source is retained for compatibility; new images use host-owned references.
  src?: string;
  assetRef?: string;
  // vector geometry — source of truth for "vector" nodes
  vectorNetwork?: VectorNetwork;
  // opaque/cached SVG path data fallback when no network is present
  vectorPath?: string;
  // connector routing metadata on a normal vector node (not a new node kind)
  connector?: DesignConnector;
  // boolean composition over childIds (see DesignBooleanOp)
  booleanOp?: DesignBooleanOp;
};

export type DesignPage = {
  id: string;
  name: string;
  children: string[];
};

export type DesignDocument = {
  version: typeof DESIGN_DOCUMENT_VERSION;
  pages: DesignPage[];
  nodes: Record<string, DesignNode>;
  metadata?: {
    createdBy?: string;
    updatedAt?: string;
  };
};

export type DesignDocumentParseResult =
  | { ok: true; document: DesignDocument }
  | { ok: false; error: string };

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function hasUnsafeObjectKey(key: string): boolean {
  return UNSAFE_OBJECT_KEYS.has(key);
}

/**
 * Walk `record` and reject prototype-pollution keys anywhere in the tree.
 * Returns the first offending key path (e.g. `nodes.foo.constructor`) or
 * `null` when the record is safe. Mirrors spreadsheet-document.ts.
 */
export function assertSafeObjectKeys(
  record: Record<string, unknown>,
  path = "object",
): string | null {
  for (const key of Object.keys(record)) {
    if (hasUnsafeObjectKey(key)) {
      return `Unsafe key "${key}" at ${path}`;
    }
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = assertSafeObjectKeys(
        value as Record<string, unknown>,
        `${path}.${key}`,
      );
      if (nested) return nested;
    }
  }
  return null;
}

export function isDesignNodeKind(value: unknown): value is DesignNodeKind {
  return (
    typeof value === "string" &&
    (value === "frame" ||
      value === "text" ||
      value === "rectangle" ||
      value === "image" ||
      value === "group" ||
      value === "vector")
  );
}

export function isDesignBooleanOp(value: unknown): value is DesignBooleanOp {
  return (
    value === "union" ||
    value === "subtract" ||
    value === "intersect" ||
    value === "exclude"
  );
}

export function defaultNameForType(type: DesignNodeKind): string {
  switch (type) {
    case "frame":
      return "Frame";
    case "text":
      return "Text";
    case "rectangle":
      return "Rectangle";
    case "image":
      return "Image";
    case "group":
      return "Group";
    case "vector":
      return "Vector";
  }
}

export function defaultSizeForType(type: DesignNodeKind): { width: number; height: number } {
  switch (type) {
    case "frame":
      return { width: 400, height: 300 };
    case "text":
      return { width: 200, height: 32 };
    case "rectangle":
      return { width: 200, height: 120 };
    case "image":
      return { width: 200, height: 200 };
    case "group":
      return { width: 0, height: 0 };
    case "vector":
      return { width: 100, height: 100 };
  }
}

export type CreateNodeInput = {
  id: string;
  type: DesignNodeKind;
  name?: string;
  parentId: string | null;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  /** QR affine shear and local reflection, applied after rotation. */
  skewX?: number;
  flipX?: boolean;
  opacity?: number;
  fills?: DesignFill[];
  stroke?: DesignStroke;
  /** Explicit Off survives legacy default paint resolution. */
  strokeDisabled?: boolean;
  hidden?: boolean;
  locked?: boolean;
  radius?: number;
  radiusY?: number;
  text?: string;
  fontSize?: number;
  /** Geometric horizontal glyph scaling, not a CSS font variant. */
  fontStretch?: number;
  fontFamily?: string;
  fontWeight?: string | number;
  textAlign?: DesignTextAlign;
  /** Line-height multiplier; omission preserves legacy 1.25. */
  lineHeight?: number;
  textWrap?: boolean;
  color?: string;
  src?: string;
  assetRef?: string;
  vectorNetwork?: VectorNetwork;
  vectorPath?: string;
  connector?: DesignConnector;
  booleanOp?: DesignBooleanOp;
};

export function createNode(input: CreateNodeInput): DesignNode {
  const { id, type, parentId } = input;
  const name = input.name ?? defaultNameForType(type);
  const defaults = defaultSizeForType(type);
  const x = input.x ?? 0;
  const y = input.y ?? 0;
  const width = input.width ?? defaults.width;
  const height = input.height ?? defaults.height;
  return {
    id,
    type,
    name,
    parentId,
    childIds: [],
    x,
    y,
    width,
    height,
    ...(input.rotation !== undefined ? { rotation: input.rotation } : {}),
    ...(input.skewX !== undefined ? { skewX: input.skewX } : {}),
    ...(input.flipX !== undefined ? { flipX: input.flipX } : {}),
    ...(input.opacity !== undefined ? { opacity: input.opacity } : {}),
    ...(input.fills !== undefined ? { fills: input.fills } : {}),
    ...(input.stroke !== undefined ? { stroke: input.stroke } : {}),
    ...(input.strokeDisabled !== undefined ? { strokeDisabled: input.strokeDisabled } : {}),
    ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
    ...(input.locked !== undefined ? { locked: input.locked } : {}),
    ...(input.radius !== undefined ? { radius: input.radius } : {}),
    ...(input.radiusY !== undefined ? { radiusY: input.radiusY } : {}),
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.fontSize !== undefined ? { fontSize: input.fontSize } : {}),
    ...(input.fontStretch !== undefined ? { fontStretch: input.fontStretch } : {}),
    ...(input.fontFamily !== undefined ? { fontFamily: input.fontFamily } : {}),
    ...(input.fontWeight !== undefined ? { fontWeight: input.fontWeight } : {}),
    ...(input.textAlign !== undefined ? { textAlign: input.textAlign } : {}),
    ...(input.lineHeight !== undefined ? { lineHeight: input.lineHeight } : {}),
    ...(input.textWrap !== undefined ? { textWrap: input.textWrap } : {}),
    ...(input.color !== undefined ? { color: input.color } : {}),
    ...(input.src !== undefined ? { src: input.src } : {}),
    ...(input.assetRef !== undefined ? { assetRef: input.assetRef } : {}),
    ...(input.vectorNetwork !== undefined ? { vectorNetwork: input.vectorNetwork } : {}),
    ...(input.vectorPath !== undefined ? { vectorPath: input.vectorPath } : {}),
    ...(input.connector !== undefined ? { connector: input.connector } : {}),
    ...(input.booleanOp !== undefined ? { booleanOp: input.booleanOp } : {}),
  };
}

export function findNode(
  doc: DesignDocument,
  nodeId: string,
): DesignNode | null {
  return doc.nodes[nodeId] ?? null;
}

export function findPage(
  doc: DesignDocument,
  pageId: string,
): DesignPage | null {
  return doc.pages.find((page) => page.id === pageId) ?? null;
}

export function firstPageId(doc: DesignDocument): string | null {
  return doc.pages[0]?.id ?? null;
}

/**
 * Append a child id to `parentId` (or to the page when `parentId` is null).
 * Does NOT mutate the node map — caller has already added the node. Returns
 * a new `DesignDocument` with updated child lists.
 */
export function appendChild(
  doc: DesignDocument,
  parentId: string | null,
  childId: string,
  pageId?: string,
): DesignDocument {
  if (parentId === null) {
    const targetPageId = pageId ?? firstPageId(doc);
    if (!targetPageId) return doc;
    return {
      ...doc,
      pages: doc.pages.map((page) =>
        page.id === targetPageId
          ? { ...page, children: [...page.children, childId] }
          : page,
      ),
    };
  }
  const parent = doc.nodes[parentId];
  if (!parent) return doc;
  return {
    ...doc,
    nodes: {
      ...doc.nodes,
      [parentId]: { ...parent, childIds: [...parent.childIds, childId] },
    },
  };
}

/**
 * Remove `nodeId` from its parent (or page) and drop it from the node map.
 * Also removes any descendants reachable from `nodeId`. Returns a new doc.
 */
export function removeNode(
  doc: DesignDocument,
  nodeId: string,
): DesignDocument {
  const node = doc.nodes[nodeId];
  if (!node) return doc;
  const toRemove = new Set<string>();
  const stack = [nodeId];
  while (stack.length > 0) {
    const currentId = stack.pop()!;
    toRemove.add(currentId);
    const current = doc.nodes[currentId];
    if (current) {
      for (const childId of current.childIds) {
        if (!toRemove.has(childId)) stack.push(childId);
      }
    }
  }
  const nextNodes: Record<string, DesignNode> = {};
  for (const [id, value] of Object.entries(doc.nodes)) {
    if (!toRemove.has(id)) nextNodes[id] = value;
  }
  // Remove from parent's childIds or from page children
  let nextPages = doc.pages;
  if (node.parentId === null) {
    nextPages = doc.pages.map((page) => ({
      ...page,
      children: page.children.filter((id) => id !== nodeId),
    }));
  } else {
    const parent = nextNodes[node.parentId];
    if (parent) {
      nextNodes[node.parentId] = {
        ...parent,
        childIds: parent.childIds.filter((id) => id !== nodeId),
      };
    }
  }
  return { ...doc, nodes: nextNodes, pages: nextPages };
}

/**
 * Insert `childId` into `parentId`'s childIds at `index` (or the page's children
 * when `parentId` is null). If `childId` is already present, this acts as a
 * move (the existing occurrence is removed before inserting at `index`).
 * Returns a new doc. Throws when the parent is missing or `index` is out of
 * range.
 */
export function insertChild(
  doc: DesignDocument,
  parentId: string | null,
  childId: string,
  index: number,
  pageId?: string,
): DesignDocument {
  if (parentId === null) {
    const targetPageId = pageId ?? firstPageId(doc);
    if (!targetPageId) throw new Error("Document has no pages.");
    return {
      ...doc,
      pages: doc.pages.map((page) => {
        if (page.id !== targetPageId) return page;
        const without = page.children.filter((id) => id !== childId);
        if (index < 0 || index > without.length) {
          throw new Error(`insertChild index out of range: ${index}`);
        }
        const next = [...without];
        next.splice(index, 0, childId);
        return { ...page, children: next };
      }),
    };
  }
  const parent = doc.nodes[parentId];
  if (!parent) throw new Error(`Parent node not found: ${parentId}`);
  const without = parent.childIds.filter((id) => id !== childId);
  if (index < 0 || index > without.length) {
    throw new Error(`insertChild index out of range: ${index}`);
  }
  const next = [...without];
  next.splice(index, 0, childId);
  return {
    ...doc,
    nodes: { ...doc.nodes, [parentId]: { ...parent, childIds: next } },
  };
}

/**
 * Reorder `childIds` to exactly match `orderedIds` within `parentId` (or the
 * page when `parentId` is null). The set must match exactly (no adds/removes).
 * Returns a new doc. Throws on mismatch.
 */
export function reorderChildren(
  doc: DesignDocument,
  parentId: string | null,
  orderedIds: string[],
  pageId?: string,
): DesignDocument {
  if (parentId === null) {
    const targetPageId = pageId ?? firstPageId(doc);
    if (!targetPageId) throw new Error("Document has no pages.");
    return {
      ...doc,
      pages: doc.pages.map((page) => {
        if (page.id !== targetPageId) return page;
        if (page.children.length !== orderedIds.length) {
          throw new Error("reorderChildren length mismatch");
        }
        const existing = new Set(page.children);
        for (const id of orderedIds) {
          if (!existing.has(id)) {
            throw new Error(`reorderChildren unknown id: ${id}`);
          }
        }
        return { ...page, children: [...orderedIds] };
      }),
    };
  }
  const parent = doc.nodes[parentId];
  if (!parent) throw new Error(`Parent node not found: ${parentId}`);
  if (parent.childIds.length !== orderedIds.length) {
    throw new Error("reorderChildren length mismatch");
  }
  const existing = new Set(parent.childIds);
  for (const id of orderedIds) {
    if (!existing.has(id)) {
      throw new Error(`reorderChildren unknown id: ${id}`);
    }
  }
  return {
    ...doc,
    nodes: { ...doc.nodes, [parentId]: { ...parent, childIds: [...orderedIds] } },
  };
}

/**
 * Move `nodeId` to a new z-index within its parent (or page). `toIndex` is the
 * desired position in the parent's childIds array after removal.
 */
export function setNodeZOrder(
  doc: DesignDocument,
  nodeId: string,
  toIndex: number,
): DesignDocument {
  const node = doc.nodes[nodeId];
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  if (node.parentId === null) {
    const page = doc.pages.find((p) => p.children.includes(nodeId));
    if (!page) throw new Error(`Node ${nodeId} has no parent and no page`);
    const without = page.children.filter((id) => id !== nodeId);
    if (toIndex < 0 || toIndex > without.length) {
      throw new Error(`toIndex out of range: ${toIndex}`);
    }
    const next = [...without];
    next.splice(toIndex, 0, nodeId);
    return {
      ...doc,
      pages: doc.pages.map((p) => (p.id === page.id ? { ...p, children: next } : p)),
    };
  }
  const parent = doc.nodes[node.parentId];
  if (!parent) throw new Error(`Parent node not found: ${node.parentId}`);
  const without = parent.childIds.filter((id) => id !== nodeId);
  if (toIndex < 0 || toIndex > without.length) {
    throw new Error(`toIndex out of range: ${toIndex}`);
  }
  const next = [...without];
  next.splice(toIndex, 0, nodeId);
  return {
    ...doc,
    nodes: { ...doc.nodes, [parent.id]: { ...parent, childIds: next } },
  };
}

export type NodeBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export function nodeBounds(node: DesignNode): NodeBounds {
  return {
    minX: node.x,
    minY: node.y,
    maxX: node.x + node.width,
    maxY: node.y + node.height,
  };
}

/**
 * Compute the bounding box of a list of nodes (typically a page's top-level
 * children). Returns null when the list is empty or all nodes are missing.
 */
export function collectiveBounds(
  doc: DesignDocument,
  nodeIds: string[],
): NodeBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;
  for (const id of nodeIds) {
    const node = doc.nodes[id];
    if (!node) continue;
    const b = nodeBounds(node);
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
    seen = true;
  }
  if (!seen) return null;
  return { minX, minY, maxX, maxY };
}

export type IterationOrder = "pre" | "post";

export function* iterateNodes(
  doc: DesignDocument,
  rootIds: string[],
  order: IterationOrder = "pre",
): Generator<DesignNode> {
  const stack = [...rootIds];
  while (stack.length > 0) {
    const id = stack.shift()!;
    const node = doc.nodes[id];
    if (!node) continue;
    if (order === "pre") {
      yield node;
      stack.unshift(...node.childIds);
    } else {
      for (const child of node.childIds) {
        yield* iterateNodes(doc, [child], order);
      }
      yield node;
    }
  }
}

/**
 * Deterministic id generator: scans existing `node-<n>` ids and returns the
 * next unused number. Tests rely on this being deterministic.
 */
export function nextNodeId(doc: DesignDocument, prefix = "node"): string {
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const id of Object.keys(doc.nodes)) {
    const match = re.exec(id);
    if (match) {
      const n = Number.parseInt(match[1]!, 10);
      if (Number.isFinite(n)) max = Math.max(max, n);
    }
  }
  return `${prefix}-${max + 1}`;
}

export function nextPageId(doc: DesignDocument): string {
  let max = 0;
  for (const page of doc.pages) {
    const match = /^page-(\d+)$/.exec(page.id);
    if (match) {
      const n = Number.parseInt(match[1]!, 10);
      if (Number.isFinite(n)) max = Math.max(max, n);
    }
  }
  return `page-${max + 1}`;
}

export function createEmptyDocument(): DesignDocument {
  return {
    version: DESIGN_DOCUMENT_VERSION,
    pages: [{ id: "page-1", name: "Page 1", children: [] }],
    nodes: {},
    metadata: {
      createdBy: "nautilo",
      updatedAt: new Date().toISOString(),
    },
  };
}

// ----- validation -----

function validateFill(value: unknown, path: string): DesignFill {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, path);
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  if (record["kind"] !== "solid") {
    throw new Error(`${path}.kind must be "solid".`);
  }
  if (typeof record["color"] !== "string" || record["color"].length === 0) {
    throw new Error(`${path}.color must be a non-empty string.`);
  }
  const fill: DesignFill = { kind: "solid", color: record["color"] };
  if (record["opacity"] !== undefined) {
    if (
      typeof record["opacity"] !== "number" ||
      !Number.isFinite(record["opacity"]) ||
      record["opacity"] < 0 ||
      record["opacity"] > 1
    ) {
      throw new Error(`${path}.opacity must be a number in [0, 1].`);
    }
    fill.opacity = record["opacity"];
  }
  return fill;
}

function validateStroke(value: unknown, path: string): DesignStroke {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, path);
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  if (typeof record["color"] !== "string" || record["color"].length === 0) {
    throw new Error(`${path}.color must be a non-empty string.`);
  }
  if (typeof record["width"] !== "number" || record["width"] < 0 || !Number.isFinite(record["width"])) {
    throw new Error(`${path}.width must be a non-negative number.`);
  }
  const stroke: DesignStroke = { color: record["color"], width: record["width"] };
  if (record["cap"] !== undefined) {
    if (record["cap"] !== "butt" && record["cap"] !== "round" && record["cap"] !== "square") {
      throw new Error(`${path}.cap must be butt|round|square.`);
    }
    stroke.cap = record["cap"];
  }
  if (record["join"] !== undefined) {
    if (record["join"] !== "miter" && record["join"] !== "round" && record["join"] !== "bevel") {
      throw new Error(`${path}.join must be miter|round|bevel.`);
    }
    stroke.join = record["join"];
  }
  if (record["dash"] !== undefined) {
    if (!Array.isArray(record["dash"])) {
      throw new Error(`${path}.dash must be an array of numbers.`);
    }
    if (record["dash"].length > MAX_DASH_ENTRIES) {
      throw new Error(`${path}.dash exceeds ${MAX_DASH_ENTRIES} entries.`);
    }
    const dash = record["dash"].map((entry, i) => {
      if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
        throw new Error(`${path}.dash[${i}] must be a finite non-negative number.`);
      }
      return entry;
    });
    stroke.dash = dash;
  }
  return stroke;
}

function validateVertex(value: unknown, path: string): VectorVertex {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, path);
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  if (typeof record["id"] !== "string" || record["id"].length === 0) {
    throw new Error(`${path}.id must be a non-empty string.`);
  }
  for (const field of ["x", "y"] as const) {
    if (typeof record[field] !== "number" || !Number.isFinite(record[field])) {
      throw new Error(`${path}.${field} must be a finite number.`);
    }
  }
  return { id: record["id"], x: record["x"] as number, y: record["y"] as number };
}

function validateHandle(value: unknown, path: string): VectorSegmentHandle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, path);
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  for (const field of ["x", "y"] as const) {
    if (typeof record[field] !== "number" || !Number.isFinite(record[field])) {
      throw new Error(`${path}.${field} must be a finite number.`);
    }
  }
  return { x: record["x"] as number, y: record["y"] as number };
}

function validateSegment(value: unknown, path: string): VectorSegment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, path);
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  for (const field of ["id", "startVertexId", "endVertexId"] as const) {
    if (typeof record[field] !== "string" || record[field].length === 0) {
      throw new Error(`${path}.${field} must be a non-empty string.`);
    }
  }
  const segment: VectorSegment = {
    id: record["id"] as string,
    startVertexId: record["startVertexId"] as string,
    endVertexId: record["endVertexId"] as string,
  };
  if (record["startHandle"] !== undefined) {
    segment.startHandle = validateHandle(record["startHandle"], `${path}.startHandle`);
  }
  if (record["endHandle"] !== undefined) {
    segment.endHandle = validateHandle(record["endHandle"], `${path}.endHandle`);
  }
  return segment;
}

function validateRegion(value: unknown, path: string): VectorRegion {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, path);
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  if (typeof record["id"] !== "string" || record["id"].length === 0) {
    throw new Error(`${path}.id must be a non-empty string.`);
  }
  if (!Array.isArray(record["vertexIds"])) {
    throw new Error(`${path}.vertexIds must be an array.`);
  }
  const vertexIds = record["vertexIds"].map((id, i) => {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`${path}.vertexIds[${i}] must be a non-empty string.`);
    }
    return id;
  });
  const region: VectorRegion = { id: record["id"], vertexIds };
  if (record["fill"] !== undefined) {
    if (typeof record["fill"] !== "string") {
      throw new Error(`${path}.fill must be a string.`);
    }
    region.fill = record["fill"];
  }
  return region;
}

function validateVectorNetwork(value: unknown, path: string): VectorNetwork {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, path);
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  for (const field of ["vertices", "segments", "regions"] as const) {
    if (!Array.isArray(record[field])) {
      throw new Error(`${path}.${field} must be an array.`);
    }
  }
  return {
    vertices: (record["vertices"] as unknown[]).map((v, i) =>
      validateVertex(v, `${path}.vertices[${i}]`),
    ),
    segments: (record["segments"] as unknown[]).map((s, i) =>
      validateSegment(s, `${path}.segments[${i}]`),
    ),
    regions: (record["regions"] as unknown[]).map((r, i) =>
      validateRegion(r, `${path}.regions[${i}]`),
    ),
  };
}

function validateConnectorEndpoint(value: unknown, path: string): ConnectorEndpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, path);
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "x" && key !== "y" && key !== "targetId" && key !== "anchor" && key !== "detachedFromTargetId") {
      throw new Error(`${path}.${key} is not supported.`);
    }
  }
  for (const field of ["x", "y"] as const) {
    if (typeof record[field] !== "number" || !Number.isFinite(record[field])) {
      throw new Error(`${path}.${field} must be a finite number.`);
    }
  }
  const targetId = record["targetId"];
  const anchor = record["anchor"];
  if (targetId !== undefined && (typeof targetId !== "string" || targetId.length === 0)) {
    throw new Error(`${path}.targetId must be a non-empty string.`);
  }
  if (targetId !== undefined && (anchor === undefined || !anchor || typeof anchor !== "object" || Array.isArray(anchor))) {
    throw new Error(`${path}.anchor is required for an attached endpoint.`);
  }
  if (targetId === undefined && anchor !== undefined) {
    throw new Error(`${path}.anchor requires targetId.`);
  }
  const endpoint: ConnectorEndpoint = {
    x: record["x"] as number,
    y: record["y"] as number,
  };
  if (targetId !== undefined) {
    const anchorRecord = anchor as Record<string, unknown>;
    const anchorUnsafe = assertSafeObjectKeys(anchorRecord, `${path}.anchor`);
    if (anchorUnsafe) throw new Error(anchorUnsafe);
    if (Object.keys(anchorRecord).some((key) => key !== "x" && key !== "y")) {
      throw new Error(`${path}.anchor only supports x and y.`);
    }
    if (typeof anchorRecord["x"] !== "number" || !Number.isFinite(anchorRecord["x"]) ||
      typeof anchorRecord["y"] !== "number" || !Number.isFinite(anchorRecord["y"]) ||
      anchorRecord["x"] < 0 || anchorRecord["x"] > 1 || anchorRecord["y"] < 0 || anchorRecord["y"] > 1) {
      throw new Error(`${path}.anchor coordinates must be finite numbers in [0, 1].`);
    }
    endpoint.targetId = targetId;
    endpoint.anchor = { x: anchorRecord["x"], y: anchorRecord["y"] };
  }
  if (record["detachedFromTargetId"] !== undefined) {
    if (typeof record["detachedFromTargetId"] !== "string" || record["detachedFromTargetId"].length === 0) {
      throw new Error(`${path}.detachedFromTargetId must be a non-empty string.`);
    }
    endpoint.detachedFromTargetId = record["detachedFromTargetId"];
  }
  return endpoint;
}

/** Normalize untrusted connector metadata without retaining caller object references. */
export function normalizeDesignConnector(value: unknown): DesignConnector {
  return validateConnector(value, "connector");
}

function validateConnector(value: unknown, path: string): DesignConnector {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, path);
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "route" && key !== "start" && key !== "end" && key !== "startArrow" && key !== "endArrow") {
      throw new Error(`${path}.${key} is not supported.`);
    }
  }
  if (record["route"] !== "straight" && record["route"] !== "elbow") {
    throw new Error(`${path}.route must be straight|elbow.`);
  }
  for (const field of ["startArrow", "endArrow"] as const) {
    if (record[field] !== undefined && typeof record[field] !== "boolean") {
      throw new Error(`${path}.${field} must be a boolean.`);
    }
  }
  return {
    route: record["route"],
    start: validateConnectorEndpoint(record["start"], `${path}.start`),
    end: validateConnectorEndpoint(record["end"], `${path}.end`),
    ...(record["startArrow"] !== undefined ? { startArrow: record["startArrow"] as boolean } : {}),
    ...(record["endArrow"] !== undefined ? { endArrow: record["endArrow"] as boolean } : {}),
  };
}

function isTextAlign(value: unknown): value is DesignTextAlign {
  return value === "left" || value === "center" || value === "right";
}

function validateNode(value: unknown, id: string): DesignNode {
  const path = `nodes.${id}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, path);
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  if (!isDesignNodeKind(record["type"])) {
    throw new Error(`${path}.type must be a known node kind.`);
  }
  if (typeof record["name"] !== "string") {
    throw new Error(`${path}.name must be a string.`);
  }
  if (record["parentId"] !== null && typeof record["parentId"] !== "string") {
    throw new Error(`${path}.parentId must be a string or null.`);
  }
  if (!Array.isArray(record["childIds"])) {
    throw new Error(`${path}.childIds must be an array.`);
  }
  const childIds = record["childIds"].map((childId) => {
    if (typeof childId !== "string") {
      throw new Error(`${path}.childIds entries must be strings.`);
    }
    return childId;
  });
  if (new Set(childIds).size !== childIds.length) {
    throw new Error(`${path}.childIds must not contain duplicate node ids.`);
  }
  for (const field of ["x", "y", "width", "height"] as const) {
    if (typeof record[field] !== "number" || !Number.isFinite(record[field])) {
      throw new Error(`${path}.${field} must be a finite number.`);
    }
  }
  const node: DesignNode = {
    id,
    type: record["type"],
    name: record["name"],
    parentId: record["parentId"],
    childIds,
    x: record["x"] as number,
    y: record["y"] as number,
    width: record["width"] as number,
    height: record["height"] as number,
  };
  if (record["rotation"] !== undefined) {
    if (typeof record["rotation"] !== "number" || !Number.isFinite(record["rotation"])) {
      throw new Error(`${path}.rotation must be a finite number.`);
    }
    node.rotation = record["rotation"];
  }
  if (record["skewX"] !== undefined) {
    const skew = record["skewX"];
    if (typeof skew !== "number" || !Number.isFinite(skew) || Math.abs(skew) >= 90) throw new Error(`${path}.skewX must be finite and between -90 and 90 degrees.`);
    node.skewX = skew;
  }
  if (node.width < 0 || node.height < 0) {
    throw new Error(`${path}.width and ${path}.height must be non-negative.`);
  }
  if (record["opacity"] !== undefined) {
    if (typeof record["opacity"] !== "number" || !Number.isFinite(record["opacity"]) || record["opacity"] < 0 || record["opacity"] > 1) {
      throw new Error(`${path}.opacity must be a number in [0, 1].`);
    }
    node.opacity = record["opacity"];
  }
  if (record["radius"] !== undefined) {
    if (typeof record["radius"] !== "number" || !Number.isFinite(record["radius"]) || record["radius"] < 0) {
      throw new Error(`${path}.radius must be a non-negative number.`);
    }
    node.radius = record["radius"];
  }
  if (record["radiusY"] !== undefined) {
    const value = record["radiusY"];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${path}.radiusY must be nonnegative and finite.`);
    node.radiusY = value;
  }
  if (record["fills"] !== undefined) {
    if (!Array.isArray(record["fills"])) {
      throw new Error(`${path}.fills must be an array.`);
    }
    node.fills = record["fills"].map((fill, i) =>
      validateFill(fill, `${path}.fills[${i}]`),
    );
  }
  if (record["stroke"] !== undefined) {
    node.stroke = validateStroke(record["stroke"], `${path}.stroke`);
  }
  for (const field of ["strokeDisabled", "hidden", "locked", "textWrap", "flipX"] as const) {
    const value = record[field];
    if (value !== undefined) {
      if (typeof value !== "boolean") throw new Error(`${path}.${field} must be a boolean.`);
      node[field] = value;
    }
  }
  if (record["lineHeight"] !== undefined) {
    const value = record["lineHeight"];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${path}.lineHeight must be a positive finite number.`);
    node.lineHeight = value;
  }
  if (record["text"] !== undefined) {
    if (typeof record["text"] !== "string") {
      throw new Error(`${path}.text must be a string.`);
    }
    node.text = record["text"];
  }
  if (record["fontSize"] !== undefined) {
    if (typeof record["fontSize"] !== "number" || !Number.isFinite(record["fontSize"]) || record["fontSize"] <= 0) {
      throw new Error(`${path}.fontSize must be a positive number.`);
    }
    node.fontSize = record["fontSize"];
  }
  if (record["fontStretch"] !== undefined) {
    const value = record["fontStretch"];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${path}.fontStretch must be positive and finite.`);
    node.fontStretch = value;
  }
  if (record["fontFamily"] !== undefined) {
    if (typeof record["fontFamily"] !== "string") {
      throw new Error(`${path}.fontFamily must be a string.`);
    }
    node.fontFamily = record["fontFamily"];
  }
  if (record["fontWeight"] !== undefined) {
    if (typeof record["fontWeight"] !== "string" && typeof record["fontWeight"] !== "number") {
      throw new Error(`${path}.fontWeight must be a string or number.`);
    }
    if (typeof record["fontWeight"] === "number" && !Number.isFinite(record["fontWeight"])) {
      throw new Error(`${path}.fontWeight number must be finite.`);
    }
    node.fontWeight = record["fontWeight"];
  }
  if (record["textAlign"] !== undefined) {
    if (!isTextAlign(record["textAlign"])) {
      throw new Error(`${path}.textAlign must be left|center|right.`);
    }
    node.textAlign = record["textAlign"];
  }
  if (record["color"] !== undefined) {
    if (typeof record["color"] !== "string") {
      throw new Error(`${path}.color must be a string.`);
    }
    node.color = record["color"];
  }
  if (record["assetRef"] !== undefined) {
    if (node.type !== "image" || !isDesignAssetRef(record["assetRef"])) throw new Error(`${path}.assetRef must be a host-owned image reference.`);
    if (record["src"] !== undefined) throw new Error(`${path} cannot contain both src and assetRef.`);
    node.assetRef = record["assetRef"];
  }
  if (record["src"] !== undefined) {
    if (typeof record["src"] !== "string") {
      throw new Error(`${path}.src must be a string.`);
    }
    node.src = record["src"];
  }
  if (record["vectorNetwork"] !== undefined) {
    node.vectorNetwork = validateVectorNetwork(record["vectorNetwork"], `${path}.vectorNetwork`);
  }
  if (record["vectorPath"] !== undefined) {
    if (typeof record["vectorPath"] !== "string") {
      throw new Error(`${path}.vectorPath must be a string.`);
    }
    node.vectorPath = record["vectorPath"];
  }
  if (record["connector"] !== undefined) {
    if (node.type !== "vector") throw new Error(`${path}.connector requires a vector node.`);
    node.connector = validateConnector(record["connector"], `${path}.connector`);
  }
  if (record["booleanOp"] !== undefined) {
    if (!isDesignBooleanOp(record["booleanOp"])) {
      throw new Error(`${path}.booleanOp must be union|subtract|intersect|exclude.`);
    }
    node.booleanOp = record["booleanOp"];
  }
  return node;
}

function validatePage(value: unknown, index: number): DesignPage {
  const path = `pages[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, path);
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  if (typeof record["id"] !== "string" || record["id"].length === 0) {
    throw new Error(`${path}.id must be a non-empty string.`);
  }
  if (typeof record["name"] !== "string") {
    throw new Error(`${path}.name must be a string.`);
  }
  if (!Array.isArray(record["children"])) {
    throw new Error(`${path}.children must be an array.`);
  }
  const children = record["children"].map((childId) => {
    if (typeof childId !== "string") {
      throw new Error(`${path}.children entries must be strings.`);
    }
    return childId;
  });
  if (new Set(children).size !== children.length) {
    throw new Error(`${path}.children must not contain duplicate node ids.`);
  }
  return {
    id: record["id"],
    name: record["name"],
    children,
  };
}

export function validateDesignDocument(value: unknown): DesignDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Design document must be an object.");
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, "document");
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  if (record["version"] !== DESIGN_DOCUMENT_VERSION) {
    throw new Error(`Design document version must be ${DESIGN_DOCUMENT_VERSION}.`);
  }
  if (!Array.isArray(record["pages"]) || record["pages"].length === 0) {
    throw new Error("Design document must include at least one page.");
  }
  if (!record["nodes"] || typeof record["nodes"] !== "object" || Array.isArray(record["nodes"])) {
    throw new Error("Design document must include a nodes object map.");
  }
  const nodesUnsafe = assertSafeObjectKeys(
    record["nodes"] as Record<string, unknown>,
    "nodes",
  );
  if (nodesUnsafe) throw new Error(nodesUnsafe);
  const pages = record["pages"].map((page, i) => validatePage(page, i));
  if (new Set(pages.map((page) => page.id)).size !== pages.length) {
    throw new Error("Design document page ids must be unique.");
  }
  const nodesRaw = record["nodes"] as Record<string, unknown>;
  const nodes: Record<string, DesignNode> = {};
  for (const [id, raw] of Object.entries(nodesRaw)) {
    nodes[id] = validateNode(raw, id);
  }
  // Every node has exactly one structural owner: a page root or one parent.
  // This makes a scene a page-rooted forest, rejecting aliasing, cycles, and
  // orphaned nodes before any renderer or transaction code sees it.
  const ownerByNodeId = new Map<string, string>();
  const setOwner = (nodeId: string, owner: string): void => {
    const previous = ownerByNodeId.get(nodeId);
    if (previous !== undefined) {
      throw new Error(`Node ${nodeId} has multiple owners: ${previous} and ${owner}.`);
    }
    ownerByNodeId.set(nodeId, owner);
  };

  // Cross-reference integrity
  for (const page of pages) {
    for (const childId of page.children) {
      if (!nodes[childId]) {
        throw new Error(`Page ${page.id} references missing node ${childId}.`);
      }
      if (nodes[childId].parentId !== null) {
        throw new Error(`Page ${page.id} child ${childId} must have parentId null.`);
      }
      setOwner(childId, `page ${page.id}`);
    }
  }
  for (const node of Object.values(nodes)) {
    if (node.parentId !== null && !nodes[node.parentId]) {
      throw new Error(`Node ${node.id}.parentId references missing node ${node.parentId}.`);
    }
    for (const childId of node.childIds) {
      if (!nodes[childId]) {
        throw new Error(`Node ${node.id} references missing child ${childId}.`);
      }
      if (nodes[childId].parentId !== node.id) {
        throw new Error(`Node ${childId}.parentId must be ${node.id}.`);
      }
      setOwner(childId, `node ${node.id}`);
    }
    if (node.connector) {
      for (const [label, endpoint] of [["start", node.connector.start], ["end", node.connector.end]] as const) {
        if (endpoint.targetId !== undefined) {
          const target = nodes[endpoint.targetId];
          if (!target) throw new Error(`Node ${node.id}.connector.${label} references missing target ${endpoint.targetId}.`);
          if (target.connector) throw new Error(`Node ${node.id}.connector.${label} may not target another connector.`);
        }
      }
    }
  }
  const reachable = new Set<string>();
  const pending = pages.flatMap((page) => page.children);
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (reachable.has(nodeId)) throw new Error(`Design document contains repeated node ${nodeId}.`);
    reachable.add(nodeId);
    for (const childId of nodes[nodeId]!.childIds) pending.push(childId);
  }
  for (const nodeId of Object.keys(nodes)) {
    if (!ownerByNodeId.has(nodeId) || !reachable.has(nodeId)) {
      throw new Error(`Node ${nodeId} must be reachable exactly once from a page root.`);
    }
  }
  const doc: DesignDocument = { version: DESIGN_DOCUMENT_VERSION, pages, nodes };
  if (record["metadata"] !== undefined) {
    if (!record["metadata"] || typeof record["metadata"] !== "object" || Array.isArray(record["metadata"])) {
      throw new Error("Design document metadata must be an object.");
    }
    const metaUnsafe = assertSafeObjectKeys(
      record["metadata"] as Record<string, unknown>,
      "metadata",
    );
    if (metaUnsafe) throw new Error(metaUnsafe);
    const meta = record["metadata"] as Record<string, unknown>;
    const metadata: NonNullable<DesignDocument["metadata"]> = {};
    if (meta["createdBy"] !== undefined) {
      if (typeof meta["createdBy"] !== "string") {
        throw new Error("metadata.createdBy must be a string.");
      }
      metadata.createdBy = meta["createdBy"];
    }
    if (meta["updatedAt"] !== undefined) {
      if (typeof meta["updatedAt"] !== "string") {
        throw new Error("metadata.updatedAt must be a string.");
      }
      metadata.updatedAt = meta["updatedAt"];
    }
    doc.metadata = metadata;
  }
  return doc;
}

export function parseDesignDocument(raw: string): DesignDocumentParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Document is not valid JSON." };
  }
  try {
    return { ok: true, document: validateDesignDocument(parsed) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function countNodes(doc: DesignDocument): number {
  return Object.keys(doc.nodes).length;
}

export function topLevelFrames(doc: DesignDocument, pageId: string): DesignNode[] {
  const page = findPage(doc, pageId);
  if (!page) return [];
  return page.children
    .map((id) => doc.nodes[id])
    .filter((node): node is DesignNode => node !== undefined && node.type === "frame");
}
