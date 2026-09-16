import { isDesignAssetRef } from "./image-assets";
import { layoutTextNode } from "./text-layout";
import { DESIGN_BUNDLED_FONT_FAMILY } from "./bundled-fonts";
/**
 * Pure, adapter-free durable mutation kernel for the Design scene graph.
 *
 * This module intentionally owns no selection, undo, persistence, bridge, or
 * rendering state. Adapters will translate their affordances to these typed
 * requests in a later phase; for now this establishes the canonical document
 * transformation and its receipt/error contract.
 */

import {
  appendChild,
  createNode,
  findNode,
  findPage,
  nextPageId,
  nextNodeId,
  normalizeDesignConnector,
  removeNode,
  reorderChildren,
  type DesignBooleanOp,
  type DesignDocument,
  type DesignConnector,
  type DesignFill,
  type DesignNode,
  type DesignNodeKind,
  type DesignStroke,
  type DesignStrokeCap,
  type DesignStrokeJoin,
  type DesignTextAlign,
  validateDesignDocument,
} from "./scene-graph";
import { detachConnectorsForDeleted, isEligibleConnectorTarget, synchronizeConnectors } from "./editor/connector";
import type { VectorNetwork } from "./vector";
import { nodePaint } from "./render-style";
import { jsonEqual } from "./json-equal";
import { applyOrganizationTransaction, selectionRoots, type OrganizationTransaction } from "./organization";
import { boxTransform, transformSubtrees } from "./affine-transform";
import { nodeCenter, nodeVisualBounds, type GeometryMatrix } from "./geometry";
import { buildExactBooleanComposition } from "./boolean-composition";

export type TransactionErrorCode =
  | "invalid_request"
  | "not_found"
  | "stale_revert"
  | "unsupported_operation";

export type TransactionValidationError = {
  code: TransactionErrorCode;
  message: string;
  path?: string;
};

export type TransactionReceipt = {
  kind: DesignTransactionRequest["kind"];
  /** Explicit so adapters never have to infer whether an empty receipt is a no-op. */
  outcome: "applied" | "noop";
  changedNodeIds: string[];
  /** Page lifecycle and top-level reorders have no node id to report. */
  changedPageIds?: string[];
};

export type DesignTransactionResult =
  | { ok: true; document: DesignDocument; receipt: TransactionReceipt }
  | { ok: false; error: TransactionValidationError };

export type GeometryPatch = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

export type StylePatch = {
  fills?: DesignFill[];
  /** `null` explicitly removes the durable stroke; zero-width is still a stroke. */
  stroke?: DesignStroke | null;
  opacity?: number;
  radius?: number;
};

export type TextPatch = {
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string | number;
  textAlign?: DesignTextAlign;
  lineHeight?: number;
  textWrap?: boolean;
  color?: string;
};

export type CreateTransaction = {
  kind: "create";
  node: {
    type: Extract<DesignNodeKind, "frame" | "text" | "rectangle" | "vector" | "image">;
    name?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    rotation?: number;
    assetRef?: string;
    vectorNetwork?: VectorNetwork;
    connector?: DesignConnector;
    style?: StylePatch;
    text?: TextPatch;
  };
  pageId?: string;
  parentId?: string | null;
};

export type TransformTransaction = {
  kind: "transform";
  updates: Array<{ nodeId: string } & GeometryPatch>;
};

export type RotateTransaction = {
  kind: "rotate";
  nodeIds: string[];
  rotation: number;
};

export type RenameTransaction = {
  kind: "rename";
  nodeIds: string[];
  name: string;
};

export type AlignTransaction = {
  kind: "align";
  nodeIds: string[];
  axis: "horizontal" | "vertical";
  mode: "start" | "center" | "end";
};

export type DistributeTransaction = {
  kind: "distribute";
  nodeIds: string[];
  axis: "horizontal" | "vertical";
};

export type StyleTransaction = {
  kind: "style";
  nodeIds: string[];
  patch: StylePatch;
};

export type TextTransaction = {
  kind: "text";
  nodeId: string;
  patch: TextPatch;
};

export type DeleteTransaction = {
  kind: "delete";
  nodeIds: string[];
};

/**
 * Explicit connector route, attachment and arrow edits. Generic transforms move
 * free endpoints; attached endpoints continue to resolve against their targets.
 */
export type ConnectorPatch = Partial<Pick<DesignConnector, "route" | "start" | "end" | "startArrow" | "endArrow">>;

export type ConnectorTransaction = {
  kind: "connector";
  nodeId: string;
  patch: ConnectorPatch;
};

/** Create a durable empty page without giving callers direct document access. */
export type PageTransaction = {
  kind: "page";
  name?: string;
};

/** Reorder the complete child list of a parent node or top-level page. */
export type ReorderTransaction = {
  kind: "reorder";
  parentId: string | null;
  pageId?: string;
  orderedIds: string[];
};

/** Wrap existing sibling nodes in one renderer-native boolean composition group. */
export type BooleanTransaction = {
  kind: "boolean";
  nodeIds: string[];
  op: DesignBooleanOp;
};

/** Replace one non-connector vector's canonical local network and its box. */
export type VectorTransaction = {
  kind: "vector";
  nodeId: string;
  vectorNetwork: VectorNetwork;
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * A bounded renderer receipt may invert a non-structural agent update only
 * while every target still has the exact agent-authored post-image. These
 * snapshots are intentionally explicit: they are an ordinary new transaction,
 * not an entry in either actor's undo history.
 */
export type RevertTransaction = {
  kind: "revert";
  changes: Array<{
    nodeId: string;
    expected: DesignNode;
    restore: DesignNode;
  }>;
};

export type DesignTransactionRequest =
  | OrganizationTransaction
  | { kind: "affine"; nodeIds: string[]; matrix: GeometryMatrix }
  | { kind: "image"; nodeId: string; assetRef: string }
  | CreateTransaction
  | TransformTransaction
  | RotateTransaction
  | RenameTransaction
  | AlignTransaction
  | DistributeTransaction
  | StyleTransaction
  | TextTransaction
  | DeleteTransaction
  | ConnectorTransaction
  | PageTransaction
  | ReorderTransaction
  | BooleanTransaction
  | VectorTransaction
  | RevertTransaction;

function invalid(message: string, path?: string): DesignTransactionResult {
  return { ok: false, error: { code: "invalid_request", message, ...(path ? { path } : {}) } };
}

function missing(nodeId: string): DesignTransactionResult {
  return {
    ok: false,
    error: { code: "not_found", message: `Node not found: ${nodeId}`, path: "nodeId" },
  };
}

function success(
  document: DesignDocument,
  kind: DesignTransactionRequest["kind"],
  changedNodeIds: string[],
  changedPageIds: string[] = [],
): DesignTransactionResult {
  return {
    ok: true,
    document,
    receipt: {
      kind,
      outcome: changedNodeIds.length === 0 && changedPageIds.length === 0 ? "noop" : "applied",
      changedNodeIds,
      ...(changedPageIds.length > 0 ? { changedPageIds } : {}),
    },
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasOwnFields(value: object): boolean {
  return Object.keys(value).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function rejectUnknownKeys(
  value: object,
  knownKeys: readonly string[],
  path: string,
): TransactionValidationError | null {
  const unknownKey = Object.keys(value).find((key) => !knownKeys.includes(key));
  return unknownKey === undefined
    ? null
    : { code: "invalid_request", message: `Unknown field: ${unknownKey}.`, path: `${path}.${unknownKey}` };
}

function exactNodeIds(doc: DesignDocument, nodeIds: unknown): string[] | DesignTransactionResult {
  if (!Array.isArray(nodeIds)) return invalid("nodeIds must be an array.", "nodeIds");
  if (nodeIds.length === 0) return invalid("nodeIds must not be empty.", "nodeIds");
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const nodeId of nodeIds) {
    if (typeof nodeId !== "string" || nodeId.length === 0) {
      return invalid("nodeIds entries must be non-empty strings.", "nodeIds");
    }
    if (seen.has(nodeId)) return invalid(`nodeIds contains duplicate id: ${nodeId}`, "nodeIds");
    if (!findNode(doc, nodeId)) return missing(nodeId);
    seen.add(nodeId);
    ids.push(nodeId);
  }
  return ids;
}

function nodesFor(doc: DesignDocument, nodeIds: unknown): DesignNode[] | DesignTransactionResult {
  const exact = exactNodeIds(doc, nodeIds);
  if (Array.isArray(exact)) return exact.map((id) => doc.nodes[id]!);
  return exact;
}

function validateGeometryPatch(patch: unknown, path: string): TransactionValidationError | null {
  if (!isRecord(patch)) {
    return { code: "invalid_request", message: "Geometry patch must be an object.", path };
  }
  if (!hasOwnFields(patch)) {
    return { code: "invalid_request", message: "Geometry patch must contain at least one field.", path };
  }
  for (const field of ["x", "y", "width", "height"] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    if (!isFiniteNumber(value)) {
      return { code: "invalid_request", message: `${field} must be a finite number.`, path: `${path}.${field}` };
    }
    if ((field === "width" || field === "height") && value < 0) {
      return { code: "invalid_request", message: `${field} must be non-negative.`, path: `${path}.${field}` };
    }
  }
  return null;
}

function validateStroke(stroke: unknown, path: string): TransactionValidationError | null {
  if (!isRecord(stroke) || typeof stroke["color"] !== "string" || stroke["color"].length === 0) {
    return { code: "invalid_request", message: "stroke.color must be a non-empty string.", path: `${path}.color` };
  }
  const unknownField = rejectUnknownKeys(stroke, ["color", "width", "cap", "join", "dash"], path);
  if (unknownField) return unknownField;
  if (!isFiniteNumber(stroke["width"]) || stroke["width"] < 0) {
    return { code: "invalid_request", message: "stroke.width must be a non-negative finite number.", path: `${path}.width` };
  }
  const caps: readonly DesignStrokeCap[] = ["butt", "round", "square"];
  if (stroke["cap"] !== undefined && !caps.includes(stroke["cap"] as DesignStrokeCap)) {
    return { code: "invalid_request", message: "stroke.cap is invalid.", path: `${path}.cap` };
  }
  const joins: readonly DesignStrokeJoin[] = ["miter", "round", "bevel"];
  if (stroke["join"] !== undefined && !joins.includes(stroke["join"] as DesignStrokeJoin)) {
    return { code: "invalid_request", message: "stroke.join is invalid.", path: `${path}.join` };
  }
  if (stroke["dash"] !== undefined && (!Array.isArray(stroke["dash"]) || stroke["dash"].some((value) => !isFiniteNumber(value) || value < 0))) {
    return { code: "invalid_request", message: "stroke.dash entries must be non-negative finite numbers.", path: `${path}.dash` };
  }
  return null;
}

function validateStylePatch(
  patch: unknown,
  path: string,
  options: { allowStrokeRemoval?: boolean } = {},
): TransactionValidationError | null {
  if (!isRecord(patch)) {
    return { code: "invalid_request", message: "Style patch must be an object.", path };
  }
  if (!hasOwnFields(patch)) {
    return { code: "invalid_request", message: "Style patch must contain at least one field.", path };
  }
  const unknownField = rejectUnknownKeys(patch, ["fills", "stroke", "opacity", "radius"], path);
  if (unknownField) return unknownField;
  if (patch["opacity"] !== undefined && (!isFiniteNumber(patch["opacity"]) || patch["opacity"] < 0 || patch["opacity"] > 1)) {
    return { code: "invalid_request", message: "opacity must be a finite number in [0, 1].", path: `${path}.opacity` };
  }
  if (patch["radius"] !== undefined && (!isFiniteNumber(patch["radius"]) || patch["radius"] < 0)) {
    return { code: "invalid_request", message: "radius must be a non-negative finite number.", path: `${path}.radius` };
  }
  if (patch["fills"] !== undefined) {
    if (!isUnknownArray(patch["fills"])) {
      return { code: "invalid_request", message: "fills must be an array.", path: `${path}.fills` };
    }
    for (let index = 0; index < patch["fills"].length; index++) {
      const fill = patch["fills"][index];
      if (!isRecord(fill) || fill["kind"] !== "solid" || typeof fill["color"] !== "string" || fill["color"].length === 0) {
        return { code: "invalid_request", message: "fills entries must be solid colors.", path: `${path}.fills[${index}]` };
      }
      const unknownFillField = rejectUnknownKeys(fill, ["kind", "color", "opacity"], `${path}.fills[${index}]`);
      if (unknownFillField) return unknownFillField;
      if (fill["opacity"] !== undefined && (!isFiniteNumber(fill["opacity"]) || fill["opacity"] < 0 || fill["opacity"] > 1)) {
        return { code: "invalid_request", message: "fill opacity must be in [0, 1].", path: `${path}.fills[${index}].opacity` };
      }
    }
  }
  if (patch["stroke"] === undefined) return null;
  if (patch["stroke"] === null) {
    return options.allowStrokeRemoval
      ? null
      : { code: "invalid_request", message: "stroke removal is only valid for a style update.", path: `${path}.stroke` };
  }
  return validateStroke(patch["stroke"], `${path}.stroke`);
}

function validateTextPatch(patch: unknown, path: string): TransactionValidationError | null {
  if (!isRecord(patch)) {
    return { code: "invalid_request", message: "Text patch must be an object.", path };
  }
  if (!hasOwnFields(patch)) {
    return { code: "invalid_request", message: "Text patch must contain at least one field.", path };
  }
  const unknownField = rejectUnknownKeys(
    patch,
    ["text", "fontSize", "fontFamily", "fontWeight", "textAlign", "lineHeight", "textWrap", "color"],
    path,
  );
  if (unknownField) return unknownField;
  if (patch["text"] !== undefined && typeof patch["text"] !== "string") {
    return { code: "invalid_request", message: "text must be a string.", path: `${path}.text` };
  }
  if (patch["fontSize"] !== undefined && (!isFiniteNumber(patch["fontSize"]) || patch["fontSize"] <= 0)) {
    return { code: "invalid_request", message: "fontSize must be a positive finite number.", path: `${path}.fontSize` };
  }
  if (patch["fontFamily"] !== undefined && typeof patch["fontFamily"] !== "string") {
    return { code: "invalid_request", message: "fontFamily must be a string.", path: `${path}.fontFamily` };
  }
  if (patch["fontWeight"] !== undefined && typeof patch["fontWeight"] !== "string" && !isFiniteNumber(patch["fontWeight"])) {
    return { code: "invalid_request", message: "fontWeight must be a string or finite number.", path: `${path}.fontWeight` };
  }
  if (patch["textAlign"] !== undefined && !(["left", "center", "right"] as const).includes(patch["textAlign"] as DesignTextAlign)) {
    return { code: "invalid_request", message: "textAlign must be left, center, or right.", path: `${path}.textAlign` };
  }
  if (patch["lineHeight"] !== undefined && (!isFiniteNumber(patch["lineHeight"]) || patch["lineHeight"] <= 0)) return { code: "invalid_request", message: "lineHeight must be positive and finite.", path: `${path}.lineHeight` };
  if (patch["textWrap"] !== undefined && typeof patch["textWrap"] !== "boolean") return { code: "invalid_request", message: "textWrap must be a boolean.", path: `${path}.textWrap` };
  if (patch["color"] !== undefined && typeof patch["color"] !== "string") {
    return { code: "invalid_request", message: "color must be a string.", path: `${path}.color` };
  }
  return null;
}

function patchNode(node: DesignNode, patch: GeometryPatch | StylePatch | TextPatch): DesignNode {
  // Style removal has its own explicit branch in applyStyle; keeping this
  // helper defensive prevents a nullable UI patch from contaminating the
  // durable node shape under exactOptionalPropertyTypes.
  if ("stroke" in patch && patch.stroke === null) {
    const { stroke: _stroke, ...remaining } = patch;
    return { ...node, ...remaining };
  }
  return { ...node, ...patch } as DesignNode;
}

function replaceNodes(doc: DesignDocument, updates: readonly [string, DesignNode][]): DesignDocument {
  if (updates.length === 0) return doc;
  return { ...doc, nodes: { ...doc.nodes, ...Object.fromEntries(updates) } };
}

function owningPageId(doc: DesignDocument, nodeId: string): string | null {
  let node = doc.nodes[nodeId];
  const seen = new Set<string>();
  while (node && node.parentId !== null && !seen.has(node.id)) {
    seen.add(node.id);
    node = doc.nodes[node.parentId];
  }
  if (!node || node.parentId !== null) return null;
  return doc.pages.find((page) => page.children.includes(node.id))?.id ?? null;
}

function validateConnectorAttachments(
  doc: DesignDocument,
  connector: DesignConnector,
  connectorPageId: string | null,
  path: string,
  endpointKeys: readonly ("start" | "end")[] = ["start", "end"],
): TransactionValidationError | null {
  for (const key of endpointKeys) {
    const targetId = connector[key].targetId;
    if (targetId === undefined) continue;
    const target = doc.nodes[targetId];
    if (!isEligibleConnectorTarget(target)) {
      return {
        code: "invalid_request",
        message: `Connector ${key} must target a closed shape, frame, or boolean.`,
        path: `${path}.${key}.targetId`,
      };
    }
    if (connectorPageId === null || owningPageId(doc, targetId) !== connectorPageId) {
      return {
        code: "invalid_request",
        message: `Connector ${key} target must be on the connector's page.`,
        path: `${path}.${key}.targetId`,
      };
    }
  }
  return null;
}

function changedIdsForUpdates(
  doc: DesignDocument,
  updates: readonly [string, DesignNode][],
): string[] {
  return updates.filter(([id, node]) => !jsonEqual(doc.nodes[id], node)).map(([id]) => id);
}

export type VisualBounds = { minX: number; maxX: number; minY: number; maxY: number };

/** Axis-aligned visual bounds after the renderer's center-origin rotation. */
export function visualBounds(node: DesignNode): VisualBounds {
  return nodeVisualBounds(node);
}

function applyCreate(doc: DesignDocument, request: CreateTransaction): DesignTransactionResult {
  if (!isRecord(request.node)) return invalid("node must be an object.", "node");
  const node = request.node;
  const unknownNodeField = rejectUnknownKeys(
    node,
    ["type", "name", "x", "y", "width", "height", "rotation", "assetRef", "vectorNetwork", "connector", "style", "text"],
    "node",
  );
  if (unknownNodeField) return { ok: false, error: unknownNodeField };
  if (node.name !== undefined && (typeof node.name !== "string" || node.name.length === 0)) {
    return invalid("name must be a non-empty string.", "node.name");
  }
  const geometryError = validateGeometryPatch(
    { ...(node.x !== undefined ? { x: node.x } : {}), ...(node.y !== undefined ? { y: node.y } : {}), ...(node.width !== undefined ? { width: node.width } : {}), ...(node.height !== undefined ? { height: node.height } : {}) },
    "node",
  );
  if (geometryError && (node.x !== undefined || node.y !== undefined || node.width !== undefined || node.height !== undefined)) {
    return { ok: false, error: geometryError };
  }
  if (node.rotation !== undefined && !isFiniteNumber(node.rotation)) {
    return invalid("rotation must be a finite number.", "node.rotation");
  }
  if (node.style !== undefined) {
    // On creation, null means "create without a stroke"; omission preserves
    // the node type's durable default. Both lower to an absent stroke field.
    const styleError = validateStylePatch(node.style, "node.style", { allowStrokeRemoval: true });
    if (styleError) return { ok: false, error: styleError };
  }
  if (node.text !== undefined) {
    const textError = validateTextPatch(node.text, "node.text");
    if (textError) return { ok: false, error: textError };
  }
  if (node.type !== "frame" && node.type !== "text" && node.type !== "rectangle" && node.type !== "vector" && node.type !== "image") {
    return invalid("create only supports frame, text, rectangle, vector, and image nodes.", "node.type");
  }
  if ((node.type === "image" && !isDesignAssetRef(node.assetRef)) || (node.type !== "image" && node.assetRef !== undefined)) return invalid("Image creation requires a host-owned assetRef.", "node.assetRef");
  if (node.type === "vector" && node.vectorNetwork === undefined) {
    return invalid("vectorNetwork is required for vector nodes.", "node.vectorNetwork");
  }
  if (node.type !== "vector" && node.vectorNetwork !== undefined) {
    return invalid("vectorNetwork requires a vector node.", "node.vectorNetwork");
  }
  if (node.connector !== undefined && node.type !== "vector") {
    return invalid("connector requires a vector node.", "node.connector");
  }
  let connector: DesignConnector | undefined;
  if (node.connector !== undefined) {
    try {
      connector = normalizeDesignConnector(node.connector);
    } catch (error) {
      return invalid(
        error instanceof Error ? error.message : "Invalid connector metadata.",
        "node.connector",
      );
    }
  }
  if (request.parentId !== undefined && request.parentId !== null && typeof request.parentId !== "string") {
    return invalid("parentId must be a string or null.", "parentId");
  }
  if (request.pageId !== undefined && typeof request.pageId !== "string") {
    return invalid("pageId must be a string.", "pageId");
  }
  const parentId = request.parentId ?? null;
  let pageId = request.pageId ?? doc.pages[0]?.id;
  if (parentId !== null) {
    const parent = findNode(doc, parentId);
    if (!parent) return missing(parentId);
    if (parent.booleanOp !== undefined || (parent.type !== "frame" && parent.type !== "group")) {
      return invalid("parentId must identify a frame or ordinary group.", "parentId");
    }
    const parentPageId = owningPageId(doc, parentId);
    if (!parentPageId) return invalid("parentId must belong to an existing page.", "parentId");
    if (request.pageId !== undefined && request.pageId !== parentPageId) {
      return invalid("parentId must belong to pageId.", "pageId");
    }
    pageId = parentPageId;
  } else if (!pageId || !findPage(doc, pageId)) {
    return invalid("pageId must identify an existing page.", "pageId");
  }
  if (connector !== undefined) {
    const attachmentError = validateConnectorAttachments(doc, connector, pageId ?? null, "node.connector");
    if (attachmentError) return { ok: false, error: attachmentError };
  }
  if (node.text !== undefined && node.type !== "text") {
    return invalid("Text fields require a text node.", "node.text");
  }
  const id = nextNodeId(doc);
  let created = createNode({
    id,
    type: node.type,
    parentId,
    ...(node.name !== undefined ? { name: node.name } : {}),
    ...(node.x !== undefined ? { x: node.x } : {}),
    ...(node.y !== undefined ? { y: node.y } : {}),
    ...(node.width !== undefined ? { width: node.width } : {}),
    ...(node.height !== undefined ? { height: node.height } : {}),
    ...(node.rotation !== undefined ? { rotation: node.rotation } : {}),
    ...(node.assetRef !== undefined ? { assetRef: node.assetRef } : {}),
    ...(node.vectorNetwork !== undefined ? { vectorNetwork: node.vectorNetwork } : {}),
    ...(connector !== undefined ? { connector } : {}),
    ...(node.style?.fills !== undefined ? { fills: node.style.fills } : {}),
    ...(node.style?.stroke !== undefined && node.style.stroke !== null ? { stroke: node.style.stroke } : {}),
    ...(node.style?.opacity !== undefined ? { opacity: node.style.opacity } : {}),
    ...(node.style?.radius !== undefined ? { radius: node.style.radius } : {}),
    ...(node.text?.text !== undefined ? { text: node.text.text } : {}),
    ...(node.text?.fontSize !== undefined ? { fontSize: node.text.fontSize } : {}),
    ...(node.type === "text" ? { fontFamily: node.text?.fontFamily ?? DESIGN_BUNDLED_FONT_FAMILY } : {}),
    ...(node.text?.fontWeight !== undefined ? { fontWeight: node.text.fontWeight } : {}),
    ...(node.text?.textAlign !== undefined ? { textAlign: node.text.textAlign } : {}),
    ...(node.text?.lineHeight !== undefined ? { lineHeight: node.text.lineHeight } : {}),
    ...(node.text?.textWrap !== undefined ? { textWrap: node.text.textWrap } : {}),
    ...(node.text?.color !== undefined ? { color: node.text.color } : {}),
  });
  if (node.type === "vector") {
    try {
      // Reuse the document parser's canonical vector validation rather than
      // duplicate the network's closed vocabulary in the transaction kernel.
      created = validateDesignDocument(appendChild({ ...doc, nodes: { ...doc.nodes, [id]: created } }, parentId, id, pageId)).nodes[id]!;
    } catch (error) {
      return invalid(error instanceof Error ? error.message : "Invalid vectorNetwork.", "node.vectorNetwork");
    }
  }
  if (node.style?.stroke === null) created = { ...created, strokeDisabled: true };
  const withNode = { ...doc, nodes: { ...doc.nodes, [id]: created } };
  return success(
    appendChild(withNode, parentId, id, pageId),
    request.kind,
    parentId === null ? [id] : [id, parentId],
  );
}

function applyTransform(doc: DesignDocument, request: TransformTransaction): DesignTransactionResult {
  if (!Array.isArray(request.updates)) return invalid("updates must be an array.", "updates");
  if (request.updates.length === 0) return invalid("updates must not be empty.", "updates");
  const seen = new Set<string>();
  const updates: Array<[string, DesignNode]> = [];
  for (let index = 0; index < request.updates.length; index++) {
    const update = request.updates[index]!;
    if (!isRecord(update)) return invalid("updates entries must be objects.", `updates[${index}]`);
    const unknownUpdateField = rejectUnknownKeys(update, ["nodeId", "x", "y", "width", "height"], `updates[${index}]`);
    if (unknownUpdateField) return { ok: false, error: unknownUpdateField };
    if (typeof update["nodeId"] !== "string" || update["nodeId"].length === 0) {
      return invalid("updates.nodeId must be a non-empty string.", `updates[${index}].nodeId`);
    }
    const nodeId = update["nodeId"];
    if (seen.has(nodeId)) return invalid(`updates contains duplicate id: ${nodeId}`, `updates[${index}].nodeId`);
    seen.add(nodeId);
    const current = findNode(doc, nodeId);
    if (!current) return missing(nodeId);
    const patch: GeometryPatch = {
      ...(update["x"] !== undefined ? { x: update["x"] } : {}),
      ...(update["y"] !== undefined ? { y: update["y"] } : {}),
      ...(update["width"] !== undefined ? { width: update["width"] } : {}),
      ...(update["height"] !== undefined ? { height: update["height"] } : {}),
    };
    const error = validateGeometryPatch(patch, `updates[${index}]`);
    if (error) return { ok: false, error };
    updates.push([nodeId, patchNode(current, patch)]);
  }
  const roots = selectionRoots(doc, updates.map(([id]) => id));
  if (roots.length !== updates.length) return invalid("Transform updates cannot include both a container and its descendant.", "updates");
  let next = doc;
  for (const nodeId of roots) {
    const target = updates.find(([id]) => id === nodeId)![1];
    const current = doc.nodes[nodeId]!;
    if (jsonEqual(current, target)) continue;
    try {
      next = transformSubtrees(next, [nodeId], boxTransform(current, target));
      const transformed = next.nodes[nodeId]!;
      const root = { ...transformed, x: target.x, y: target.y, width: target.width, height: target.height };
      for (const field of ["rotation", "skewX", "flipX"] as const) {
        if (current[field] === undefined) delete root[field];
        else Object.assign(root, { [field]: current[field] });
      }
      next.nodes[nodeId] = root;
    } catch (cause) { return invalid(cause instanceof Error ? cause.message : "Invalid transform.", "updates"); }
  }
  const changedNodeIds = Object.keys(next.nodes).filter((id) => !jsonEqual(doc.nodes[id], next.nodes[id]));
  return success(changedNodeIds.length === 0 ? doc : next, request.kind, changedNodeIds);
}

function applyRotate(doc: DesignDocument, request: RotateTransaction): DesignTransactionResult {
  if (!isFiniteNumber(request.rotation)) return invalid("rotation must be a finite number.", "rotation");
  const nodes = nodesFor(doc, request.nodeIds);
  if (!Array.isArray(nodes)) return nodes;
  let next = doc;
  for (const id of selectionRoots(doc, nodes.map((node) => node.id))) {
    const node = doc.nodes[id]!;
    const angle = (request.rotation - (node.rotation ?? 0)) * Math.PI / 180;
    if (angle === 0) continue;
    const a = Math.cos(angle), b = Math.sin(angle), c = -b, d = a;
    const center = nodeCenter(node);
    next = transformSubtrees(next, [id], { a, b, c, d, e: center.x - a * center.x - c * center.y, f: center.y - b * center.x - d * center.y });
    next.nodes[id] = { ...next.nodes[id]!, rotation: request.rotation };
  }
  const changedNodeIds = Object.keys(next.nodes).filter((id) => !jsonEqual(doc.nodes[id], next.nodes[id]));
  return success(changedNodeIds.length === 0 ? doc : next, request.kind, changedNodeIds);
}

function applyAffine(doc: DesignDocument, request: { kind: "affine"; nodeIds: string[]; matrix: GeometryMatrix }): DesignTransactionResult {
  const unknown = rejectUnknownKeys(request, ["kind", "nodeIds", "matrix"], "request");
  if (unknown) return { ok: false, error: unknown };
  const nodes = nodesFor(doc, request.nodeIds);
  if (!Array.isArray(nodes)) return nodes;
  if (!isRecord(request.matrix) || Object.keys(request.matrix).some((key) => !["a", "b", "c", "d", "e", "f"].includes(key)) || !(["a", "b", "c", "d", "e", "f"] as const).every((key) => isFiniteNumber(request.matrix[key]))) return invalid("Supply six finite affine matrix components.", "matrix");
  try {
    const next = validateDesignDocument(transformSubtrees(doc, request.nodeIds, request.matrix));
    const changed = Object.keys(next.nodes).filter((id) => !jsonEqual(doc.nodes[id], next.nodes[id]));
    return success(changed.length ? next : doc, request.kind, changed);
  } catch (cause) { return invalid(cause instanceof Error ? cause.message : "Invalid affine transform.", "matrix"); }
}

function applyRename(doc: DesignDocument, request: RenameTransaction): DesignTransactionResult {
  if (typeof request.name !== "string" || request.name.length === 0) {
    return invalid("name must be a non-empty string.", "name");
  }
  const nodes = nodesFor(doc, request.nodeIds);
  if (!Array.isArray(nodes)) return nodes;
  const updates = nodes.map((node): [string, DesignNode] => [node.id, { ...node, name: request.name }]);
  const changedNodeIds = changedIdsForUpdates(doc, updates);
  return success(changedNodeIds.length === 0 ? doc : replaceNodes(doc, updates), request.kind, changedNodeIds);
}

function applyAlign(doc: DesignDocument, request: AlignTransaction): DesignTransactionResult {
  if (request.axis !== "horizontal" && request.axis !== "vertical") {
    return invalid("axis must be horizontal or vertical.", "axis");
  }
  if (request.mode !== "start" && request.mode !== "center" && request.mode !== "end") {
    return invalid("mode must be start, center, or end.", "mode");
  }
  const nodes = nodesFor(doc, request.nodeIds);
  if (!Array.isArray(nodes)) return nodes;
  if (!nodes.every((node) => node.parentId === nodes[0]!.parentId)) {
    return invalid("All nodes must share a parent until world-coordinate transforms exist.", "nodeIds");
  }
  if (nodes.length < 2) return success(doc, request.kind, []);
  const horizontal = request.axis === "horizontal";
  const bounds = nodes.map((node) => ({ node, bounds: visualBounds(node) }));
  const starts = bounds.map(({ bounds }) => horizontal ? bounds.minX : bounds.minY);
  const ends = bounds.map(({ bounds }) => horizontal ? bounds.maxX : bounds.maxY);
  const target = request.mode === "start"
    ? Math.min(...starts)
    : request.mode === "end"
      ? Math.max(...ends)
      : (Math.min(...starts) + Math.max(...ends)) / 2;
  const updates = bounds.map(({ node, bounds: box }): [string, DesignNode] => {
    const currentStart = horizontal ? box.minX : box.minY;
    const currentEnd = horizontal ? box.maxX : box.maxY;
    const currentCenter = (currentStart + currentEnd) / 2;
    const delta = request.mode === "start" ? target - currentStart
      : request.mode === "end" ? target - currentEnd
        : target - currentCenter;
    return [node.id, horizontal ? { ...node, x: node.x + delta } : { ...node, y: node.y + delta }];
  });
  const result = applyTransform(doc, { kind: "transform", updates: updates.map(([nodeId, node]) => ({ nodeId, x: node.x, y: node.y })) });
  return result.ok ? { ...result, receipt: { ...result.receipt, kind: request.kind } } : result;
}

function applyDistribute(doc: DesignDocument, request: DistributeTransaction): DesignTransactionResult {
  if (request.axis !== "horizontal" && request.axis !== "vertical") {
    return invalid("axis must be horizontal or vertical.", "axis");
  }
  const nodes = nodesFor(doc, request.nodeIds);
  if (!Array.isArray(nodes)) return nodes;
  if (!nodes.every((node) => node.parentId === nodes[0]!.parentId)) {
    return invalid("All nodes must share a parent until world-coordinate transforms exist.", "nodeIds");
  }
  if (nodes.length < 3) return success(doc, request.kind, []);
  const horizontal = request.axis === "horizontal";
  const ordered = nodes
    .map((node) => ({ node, bounds: visualBounds(node) }))
    .sort((left, right) => {
      const leftStart = horizontal ? left.bounds.minX : left.bounds.minY;
      const rightStart = horizontal ? right.bounds.minX : right.bounds.minY;
      return leftStart - rightStart || left.node.id.localeCompare(right.node.id);
    });
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const leading = horizontal ? first.bounds.minX : first.bounds.minY;
  const trailing = horizontal ? last.bounds.maxX : last.bounds.maxY;
  const totalSize = ordered.reduce((sum, entry) => sum + (horizontal
    ? entry.bounds.maxX - entry.bounds.minX
    : entry.bounds.maxY - entry.bounds.minY), 0);
  const gap = (trailing - leading - totalSize) / (ordered.length - 1);
  let cursor = leading;
  const updates = ordered.map(({ node, bounds }): [string, DesignNode] => {
    const currentStart = horizontal ? bounds.minX : bounds.minY;
    const size = horizontal ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY;
    const delta = cursor - currentStart;
    const next = horizontal ? { ...node, x: node.x + delta } : { ...node, y: node.y + delta };
    cursor += size + gap;
    return [node.id, next];
  });
  const result = applyTransform(doc, { kind: "transform", updates: updates.map(([nodeId, node]) => ({ nodeId, x: node.x, y: node.y })) });
  return result.ok ? { ...result, receipt: { ...result.receipt, kind: request.kind } } : result;
}

function applyStyle(doc: DesignDocument, request: StyleTransaction): DesignTransactionResult {
  const error = validateStylePatch(request.patch, "patch", { allowStrokeRemoval: true });
  if (error) return { ok: false, error };
  const nodes = nodesFor(doc, request.nodeIds);
  if (!Array.isArray(nodes)) return nodes;
  const updates = nodes.map((node): [string, DesignNode] => {
    if (request.patch.stroke !== null) {
      const next = patchNode(node, request.patch);
      if (request.patch.stroke !== undefined) delete next.strokeDisabled;
      if (request.patch.radius !== undefined) delete next.radiusY;
      return [node.id, next];
    }
    const { stroke: _removedStroke, ...remainingPatch } = request.patch;
    const { stroke: _existingStroke, ...withoutStroke } = node;
    const next = { ...patchNode(withoutStroke, remainingPatch), strokeDisabled: true };
    if (request.patch.radius !== undefined) delete next.radiusY;
    return [node.id, next];
  });
  const changedNodeIds = changedIdsForUpdates(doc, updates);
  return success(changedNodeIds.length === 0 ? doc : replaceNodes(doc, updates), request.kind, changedNodeIds);
}

function applyText(doc: DesignDocument, request: TextTransaction): DesignTransactionResult {
  const error = validateTextPatch(request.patch, "patch");
  if (error) return { ok: false, error };
  const node = findNode(doc, request.nodeId);
  if (!node) return missing(request.nodeId);
  if (node.type !== "text") return invalid("Text transactions require a text node.", "nodeId");
  const next = patchNode(node, request.patch);
  const changedNodeIds = changedIdsForUpdates(doc, [[node.id, next]]);
  return success(changedNodeIds.length === 0 ? doc : replaceNodes(doc, [[node.id, next]]), request.kind, changedNodeIds);
}

function descendants(doc: DesignDocument, nodeId: string, seen: Set<string>): void {
  if (seen.has(nodeId)) return;
  seen.add(nodeId);
  for (const childId of doc.nodes[nodeId]?.childIds ?? []) descendants(doc, childId, seen);
}

function applyDelete(doc: DesignDocument, request: DeleteTransaction): DesignTransactionResult {
  const exact = exactNodeIds(doc, request.nodeIds);
  if (!Array.isArray(exact)) return exact;
  const deleted = new Set<string>();
  const structurallyChangedParents = new Set<string>();
  for (const nodeId of exact) {
    descendants(doc, nodeId, deleted);
    const parentId = doc.nodes[nodeId]!.parentId;
    if (parentId !== null) structurallyChangedParents.add(parentId);
  }
  // Resolve attached endpoints against the pre-delete document, then detach
  // only the endpoints whose target is going away. The connector itself stays.
  let next = detachConnectorsForDeleted(doc, deleted);
  const detachedConnectorIds = Object.keys(next.nodes).filter(
    (id) => next.nodes[id] !== doc.nodes[id],
  );
  for (const nodeId of exact) next = removeNode(next, nodeId);
  return success(
    next,
    request.kind,
    [...new Set([...deleted, ...structurallyChangedParents, ...detachedConnectorIds])],
  );
}

function applyConnector(doc: DesignDocument, request: ConnectorTransaction): DesignTransactionResult {
  if (typeof request.nodeId !== "string" || request.nodeId.length === 0) {
    return invalid("nodeId must be a non-empty string.", "nodeId");
  }
  const node = findNode(doc, request.nodeId);
  if (!node) return missing(request.nodeId);
  if (!node.connector || node.type !== "vector") {
    return invalid("Connector transactions require a connector vector node.", "nodeId");
  }
  if (!isRecord(request.patch) || !hasOwnFields(request.patch)) {
    return invalid("connector patch must be a non-empty object.", "patch");
  }
  const unknown = rejectUnknownKeys(request.patch, ["route", "start", "end", "startArrow", "endArrow"], "patch");
  if (unknown) return { ok: false, error: unknown };
  let connector: DesignConnector;
  try {
    connector = normalizeDesignConnector({ ...node.connector, ...request.patch });
    const changedEndpointKeys = (["start", "end"] as const).filter((key) => request.patch[key] !== undefined);
    const attachmentError = validateConnectorAttachments(
      doc,
      connector,
      owningPageId(doc, node.id),
      "patch",
      changedEndpointKeys,
    );
    if (attachmentError) return { ok: false, error: attachmentError };
    // Cross-reference validation (including no connector-to-connector target)
    // belongs to the same parser boundary that reads persisted scenes.
    validateDesignDocument({ ...doc, nodes: { ...doc.nodes, [node.id]: { ...node, connector } } });
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "Invalid connector patch.", "patch");
  }
  const next = { ...node, connector };
  const changedNodeIds = changedIdsForUpdates(doc, [[node.id, next]]);
  return success(changedNodeIds.length === 0 ? doc : replaceNodes(doc, [[node.id, next]]), request.kind, changedNodeIds);
}

function applyPage(doc: DesignDocument, request: PageTransaction): DesignTransactionResult {
  const unknown = rejectUnknownKeys(request, ["kind", "name"], "request");
  if (unknown) return { ok: false, error: unknown };
  if (request.name !== undefined && (typeof request.name !== "string" || request.name.trim().length === 0)) {
    return invalid("name must be a non-empty string when supplied.", "name");
  }
  const id = nextPageId(doc);
  const name = request.name?.trim() ?? `Page ${id.replace(/^page-/, "")}`;
  return success(
    { ...doc, pages: [...doc.pages, { id, name, children: [] }] },
    request.kind,
    [],
    [id],
  );
}

function applyReorder(doc: DesignDocument, request: ReorderTransaction): DesignTransactionResult {
  const unknown = rejectUnknownKeys(request, ["kind", "parentId", "pageId", "orderedIds"], "request");
  if (unknown) return { ok: false, error: unknown };
  if (request.parentId !== null && typeof request.parentId !== "string") {
    return invalid("parentId must be a string or null.", "parentId");
  }
  if (request.pageId !== undefined && typeof request.pageId !== "string") {
    return invalid("pageId must be a string.", "pageId");
  }
  if (!Array.isArray(request.orderedIds) || request.orderedIds.some((id) => typeof id !== "string" || id.length === 0)) {
    return invalid("orderedIds must be an array of non-empty strings.", "orderedIds");
  }
  if (new Set(request.orderedIds).size !== request.orderedIds.length) {
    return invalid("orderedIds must not contain duplicates.", "orderedIds");
  }
  if (request.parentId === null) {
    const pageId = request.pageId ?? doc.pages[0]?.id;
    if (!pageId || !findPage(doc, pageId)) return invalid("pageId must identify an existing page.", "pageId");
    if (jsonEqual(doc.pages.find((page) => page.id === pageId)?.children, request.orderedIds)) {
      return success(doc, request.kind, []);
    }
    try {
      const next = reorderChildren(doc, null, request.orderedIds, pageId);
      return success(next === doc ? doc : next, request.kind, [], next === doc ? [] : [pageId]);
    } catch (error) {
      return invalid(error instanceof Error ? error.message : "Invalid page reorder.", "orderedIds");
    }
  }
  if (!findNode(doc, request.parentId)) return missing(request.parentId);
  if (jsonEqual(doc.nodes[request.parentId]!.childIds, request.orderedIds)) {
    return success(doc, request.kind, []);
  }
  try {
    const next = reorderChildren(doc, request.parentId, request.orderedIds);
    return success(next === doc ? doc : next, request.kind, next === doc ? [] : [request.parentId]);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "Invalid child reorder.", "orderedIds");
  }
}

function applyBoolean(doc: DesignDocument, request: BooleanTransaction): DesignTransactionResult {
  const unknown = rejectUnknownKeys(request, ["kind", "nodeIds", "op"], "request");
  if (unknown) return { ok: false, error: unknown };
  if (!( ["union", "subtract", "intersect", "exclude"] as const).includes(request.op)) {
    return invalid("op must be union, subtract, intersect, or exclude.", "op");
  }
  const exact = exactNodeIds(doc, request.nodeIds);
  if (!Array.isArray(exact)) return exact;
  if (exact.length < 2) return invalid("boolean requires at least two nodes.", "nodeIds");
  const selected = exact.map((id) => doc.nodes[id]!);
  const parentId = selected[0]!.parentId;
  if (!selected.every((node) => node.parentId === parentId)) {
    return invalid("All boolean operands must share a parent.", "nodeIds");
  }

  const ids = new Set(exact);
  const page = parentId === null
    ? doc.pages.find((candidate) => exact.every((id) => candidate.children.includes(id)))
    : undefined;
  if (parentId === null && !page) return invalid("Top-level boolean operands must share a page.", "nodeIds");
  const container = parentId === null ? page!.children : doc.nodes[parentId]!.childIds;
  if (!exact.every((id) => container.includes(id))) return invalid("Boolean operands must be direct siblings.", "nodeIds");

  const selectedInOrder = container.filter((id) => ids.has(id));
  const topmostIndex = Math.max(...selectedInOrder.map((id) => container.indexOf(id)));
  const insertAt = container.slice(0, topmostIndex).filter((id) => !ids.has(id)).length;
  const groupId = nextNodeId(doc);
  const group = createNode({
    id: groupId,
    type: "group",
    parentId,
    name: request.op.charAt(0).toUpperCase() + request.op.slice(1),
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    booleanOp: request.op,
    fills: [{ kind: "solid", color: nodePaint(doc.nodes[selectedInOrder[selectedInOrder.length - 1]!]!).fill ?? "#3b82f6" }],
  });
  group.childIds = [...selectedInOrder];
  const nodes: Record<string, DesignNode> = { ...doc.nodes, [groupId]: group };
  for (const id of selectedInOrder) nodes[id] = { ...nodes[id]!, parentId: groupId };
  const remaining = container.filter((id) => !ids.has(id));
  remaining.splice(insertAt, 0, groupId);
  const next = parentId === null
    ? { ...doc, nodes, pages: doc.pages.map((candidate) => candidate.id === page!.id ? { ...candidate, children: remaining } : candidate) }
    : { ...doc, nodes: { ...nodes, [parentId]: { ...nodes[parentId]!, childIds: remaining } } };
  const composition = buildExactBooleanComposition(next, group);
  if (!composition.ok) return { ok: false, error: { code: "unsupported_operation", message: composition.reason, path: "nodeIds" } };
  const bounds = composition.composition.bounds;
  next.nodes[groupId] = {
    ...next.nodes[groupId]!,
    x: bounds.minX,
    y: bounds.minY,
    width: Math.max(0, bounds.maxX - bounds.minX),
    height: Math.max(0, bounds.maxY - bounds.minY),
  };
  try {
    return success(validateDesignDocument(next), request.kind, [groupId, ...selectedInOrder, ...(parentId ? [parentId] : [])], parentId === null ? [page!.id] : []);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "Invalid boolean composition.", "nodeIds");
  }
}

function applyVector(doc: DesignDocument, request: VectorTransaction): DesignTransactionResult {
  const unknown = rejectUnknownKeys(request, ["kind", "nodeId", "vectorNetwork", "x", "y", "width", "height"], "request");
  if (unknown) return { ok: false, error: unknown };
  if (typeof request.nodeId !== "string" || request.nodeId.length === 0) return invalid("nodeId must be a non-empty string.", "nodeId");
  const node = findNode(doc, request.nodeId);
  if (!node) return missing(request.nodeId);
  if (node.type !== "vector" || node.connector) return invalid("Vector edits require a non-connector vector node.", "nodeId");
  const geometry = validateGeometryPatch({ x: request.x, y: request.y, width: request.width, height: request.height }, "request");
  if (geometry) return { ok: false, error: geometry };
  try {
    const next = validateDesignDocument({
      ...doc,
      nodes: { ...doc.nodes, [node.id]: { ...node, x: request.x, y: request.y, width: request.width, height: request.height, vectorNetwork: request.vectorNetwork } },
    });
    const changed = jsonEqual(next.nodes[node.id], node) ? [] : [node.id];
    return success(changed.length === 0 ? doc : next, request.kind, changed);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "Invalid vector network.", "vectorNetwork");
  }
}

function validRevertSnapshot(
  doc: DesignDocument,
  nodeId: string,
  snapshot: unknown,
  path: string,
): DesignNode | DesignTransactionResult {
  if (!isRecord(snapshot) || snapshot["id"] !== nodeId) {
    return invalid("Revert snapshots must be objects with the matching node id.", path);
  }
  try {
    return validateDesignDocument({ ...doc, nodes: { ...doc.nodes, [nodeId]: snapshot } }).nodes[nodeId]!;
  } catch (err) {
    return invalid(
      err instanceof Error ? err.message : "Revert snapshot is invalid.",
      path,
    );
  }
}

function isTransactionResult(value: DesignNode | DesignTransactionResult): value is DesignTransactionResult {
  return "ok" in value;
}

function applyRevert(doc: DesignDocument, request: RevertTransaction): DesignTransactionResult {
  const unknownRequestField = rejectUnknownKeys(request, ["kind", "changes"], "request");
  if (unknownRequestField) return { ok: false, error: unknownRequestField };
  if (!Array.isArray(request.changes) || request.changes.length === 0) {
    return invalid("changes must be a non-empty array.", "changes");
  }
  const seen = new Set<string>();
  const changes: Array<{ nodeId: string; expected: DesignNode; restore: DesignNode }> = [];
  for (let index = 0; index < request.changes.length; index++) {
    const change = request.changes[index];
    if (!isRecord(change) || typeof change["nodeId"] !== "string" || change["nodeId"].length === 0) {
      return invalid("changes entries must identify a node.", `changes[${index}].nodeId`);
    }
    const unknownChangeField = rejectUnknownKeys(change, ["nodeId", "expected", "restore"], `changes[${index}]`);
    if (unknownChangeField) return { ok: false, error: unknownChangeField };
    const nodeId = change["nodeId"];
    if (seen.has(nodeId)) return invalid(`changes contains duplicate id: ${nodeId}`, `changes[${index}].nodeId`);
    seen.add(nodeId);
    const current = findNode(doc, nodeId);
    if (!current) {
      return {
        ok: false,
        error: { code: "stale_revert", message: `Revert no longer applies: ${nodeId} no longer exists.`, path: `changes[${index}].nodeId` },
      };
    }
    const expected = validRevertSnapshot(doc, nodeId, change["expected"], `changes[${index}].expected`);
    if (isTransactionResult(expected)) return expected;
    const restore = validRevertSnapshot(doc, nodeId, change["restore"], `changes[${index}].restore`);
    if (isTransactionResult(restore)) return restore;
    if (
      expected.type !== current.type || expected.parentId !== current.parentId ||
      !jsonEqual(expected.childIds, current.childIds) ||
      restore.type !== current.type || restore.parentId !== current.parentId ||
      !jsonEqual(restore.childIds, current.childIds)
    ) {
      return invalid("Revert only supports non-structural node changes.", `changes[${index}]`);
    }
    changes.push({ nodeId, expected, restore });
  }
  for (const change of changes) {
    if (!jsonEqual(doc.nodes[change.nodeId], change.expected)) {
      return {
        ok: false,
        error: { code: "stale_revert", message: `Revert no longer applies: ${change.nodeId} changed after the agent update.`, path: `changes.${change.nodeId}` },
      };
    }
  }
  const updates = changes.map(({ nodeId, restore }): [string, DesignNode] => [nodeId, restore]);
  const changedNodeIds = changedIdsForUpdates(doc, updates);
  return success(changedNodeIds.length === 0 ? doc : replaceNodes(doc, updates), request.kind, changedNodeIds);
}

/** Apply one validated canonical scene mutation without mutating the input document. */
export function applyDesignTransaction(
  document: DesignDocument,
  request: DesignTransactionRequest,
): DesignTransactionResult;
export function applyDesignTransaction(
  document: DesignDocument,
  request: unknown,
): DesignTransactionResult {
  if (!isRecord(request) || typeof request["kind"] !== "string") {
    return invalid("Transaction request must be an object with a kind.", "request");
  }
  if (request["kind"] === "reorder" && Array.isArray(request["orderedIds"])) {
    const parentId = request["parentId"];
    const current = parentId === null
      ? document.pages.find((page) => page.id === (request["pageId"] ?? document.pages[0]?.id))?.children
      : typeof parentId === "string"
        ? document.nodes[parentId]?.childIds
        : undefined;
    if (current) {
      for (const [index, id] of current.entries()) {
        if (document.nodes[id]?.locked && request["orderedIds"].indexOf(id) !== index) {
          return invalid(`Unlock "${document.nodes[id].name}" before changing its layer position.`, "orderedIds");
        }
      }
    }
  }
  // Locked objects remain inspectable and unlockable. Ordinary mutations may
  // not silently bypass a lock selected through Layers or an agent handle.
  if (!["flags", "revert", "page", "page-edit", "page-order", "insert"].includes(request["kind"])) {
    const targets: string[] = [];
    if (Array.isArray(request["nodeIds"])) targets.push(...request["nodeIds"].filter((id): id is string => typeof id === "string"));
    if (typeof request["nodeId"] === "string") targets.push(request["nodeId"]);
    if (typeof request["parentId"] === "string") targets.push(request["parentId"]);
    if (Array.isArray(request["updates"])) for (const update of request["updates"]) if (isRecord(update) && typeof update["nodeId"] === "string") targets.push(update["nodeId"]);
    for (const id of targets) {
      let node = document.nodes[id];
      const seen = new Set<string>();
      while (node && !seen.has(node.id)) {
        if (node.locked) return invalid(`Unlock "${node.name}" before editing it.`, "nodeIds");
        seen.add(node.id);
        node = node.parentId === null ? undefined : document.nodes[node.parentId];
      }
    }
  }
  const result: DesignTransactionResult = (() : DesignTransactionResult => {
  switch (request["kind"]) {
    case "group": case "ungroup": case "reparent": case "duplicate": case "insert": case "flags": case "page-edit": case "page-order":
      return applyOrganizationTransaction(document, request as OrganizationTransaction);
    case "affine":
      return applyAffine(document, request as { kind: "affine"; nodeIds: string[]; matrix: GeometryMatrix });
    case "image": {
      const node = typeof request["nodeId"] === "string" ? document.nodes[request["nodeId"]] : undefined;
      if (!node || node.type !== "image") return invalid("Select an image to replace.", "nodeId");
      if (!isDesignAssetRef(request["assetRef"])) return invalid("A host-owned image reference is required.", "assetRef");
      if (node.assetRef === request["assetRef"]) return success(document, "image", []);
      const updated = { ...node, assetRef: request["assetRef"] };
      delete updated.src;
      return success({ ...document, nodes: { ...document.nodes, [node.id]: updated } }, "image", [node.id]);
    }
    case "create":
      return applyCreate(document, request as CreateTransaction);
    case "transform":
      return applyTransform(document, request as TransformTransaction);
    case "rotate":
      return applyRotate(document, request as RotateTransaction);
    case "rename":
      return applyRename(document, request as RenameTransaction);
    case "align":
      return applyAlign(document, request as AlignTransaction);
    case "distribute":
      return applyDistribute(document, request as DistributeTransaction);
    case "style":
      return applyStyle(document, request as StyleTransaction);
    case "text":
      return applyText(document, request as TextTransaction);
    case "delete":
      return applyDelete(document, request as DeleteTransaction);
    case "connector":
      return applyConnector(document, request as ConnectorTransaction);
    case "page":
      return applyPage(document, request as PageTransaction);
    case "reorder":
      return applyReorder(document, request as ReorderTransaction);
    case "boolean":
      return applyBoolean(document, request as BooleanTransaction);
    case "vector":
      return applyVector(document, request as VectorTransaction);
    case "revert":
      return applyRevert(document, request as RevertTransaction);
    default:
      return {
        ok: false as const,
        error: { code: "unsupported_operation", message: `Unsupported transaction: ${request["kind"]}`, path: "kind" },
      };
  }
  })();
  if (!result.ok) return result;
  if (result.receipt.outcome === "applied") {
    try {
      result.document = validateDesignDocument(result.document);
    } catch (cause) {
      return invalid(cause instanceof Error ? cause.message : "Transaction produced an invalid document.", "request");
    }
  }
  try {
    for (const id of result.receipt.changedNodeIds) {
      const node = result.document.nodes[id];
      if (node?.type === "text" && node.textWrap) layoutTextNode(node);
    }
  } catch (cause) {
    return invalid(cause instanceof Error ? cause.message : "Text layout is unsupported.", "text");
  }
  const hasConnector = Object.values(result.document.nodes).some((node) => node.connector !== undefined);
  if (!hasConnector) return result;
  let synchronized: DesignDocument;
  try {
    // The parser is also the canonical cloning/cross-reference boundary. This
    // means a successful connector mutation can never leak caller-owned
    // metadata or a dangling/unsafe attachment into durable state.
    synchronized = validateDesignDocument(synchronizeConnectors(result.document));
  } catch (error) {
    return invalid(
      error instanceof Error ? error.message : "Invalid connector document state.",
      "connector",
    );
  }
  const changedConnectorIds = Object.keys(synchronized.nodes).filter((id) =>
    !jsonEqual(synchronized.nodes[id], result.document.nodes[id]),
  );
  if (changedConnectorIds.length === 0) return result;
  return success(
    synchronized,
    result.receipt.kind,
    [...new Set([...result.receipt.changedNodeIds, ...changedConnectorIds])],
    result.receipt.changedPageIds,
  );
}
