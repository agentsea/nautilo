import { isDesignAssetRef } from "./image-assets";
/**
 * The public, renderer-free operation vocabulary for an open Design session.
 * It intentionally translates every durable outcome into `transactions.ts`;
 * callers never receive a scene-graph escape hatch or DOM/pointer surrogate.
 */

import { buildPrimitiveFromDrag, isVectorPrimitiveTool, type PrimitiveTool } from "./editor/primitives";
import { connectorGeometry } from "./editor/connector";
import type { DesignConnector, DesignDocument, DesignNode, DesignStroke } from "./scene-graph";
import {
  DESIGN_SEMANTIC_PROPERTY_GROUPS,
  designNodeHandle,
  designPageHandle,
  nodeIdFromDesignHandle,
  pageIdFromDesignHandle,
  semanticVersionForNode,
  semanticVersionForPage,
  type DesignSemanticPropertyGroup,
} from "./design-inspection";
export type { DesignSemanticPropertyGroup } from "./design-inspection";
import { commandsFromVectorNetwork, type VectorNetwork, type VectorPathCommand } from "./vector";
import {
  applyDesignTransaction,
  type ConnectorPatch,
  type DesignTransactionRequest,
  type GeometryPatch,
  type StylePatch,
  type TextPatch,
} from "./transactions";

/** Public Pen commands use normalized node-local coordinates, never SVG or pointer events. */
export type PathCommand = VectorPathCommand;
export type PublicConnectorInput = Omit<DesignConnector, "start" | "end"> & {
  start: Omit<DesignConnector["start"], "targetId" | "detachedFromTargetId"> & { targetHandle?: string; detachedFromHandle?: string };
  end: Omit<DesignConnector["end"], "targetId" | "detachedFromTargetId"> & { targetHandle?: string; detachedFromHandle?: string };
};
export type PublicConnectorPatch = Partial<Omit<DesignConnector, "start" | "end">> & {
  start?: PublicConnectorInput["start"];
  end?: PublicConnectorInput["end"];
};

type DesignCreateNode = {
  type: "frame" | "text" | "rectangle" | "image" | PrimitiveTool;
  assetRef?: string;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Line creation uses explicit endpoints so horizontal, vertical, and reverse lines are unambiguous. */
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  rotation?: number;
  style?: StylePatch;
  text?: TextPatch;
};

export type DesignOperation =
  | { op: "create"; ref?: string; node: DesignCreateNode; pageId?: string; parentId?: string | null }
  /** @deprecated Accepted for replay compatibility. New callable schemas expose only `create`. */
  | { op: "shape"; ref?: string; name?: string; shape: "rectangle" | PrimitiveTool; x: number; y: number; width: number; height: number; style?: StylePatch; pageId?: string; parentId?: string | null }
  | { op: "path"; ref?: string; nodeId?: string; commands: PathCommand[]; expectedGeometry?: PathCommand[]; bounds: { x: number; y: number; width: number; height: number }; name?: string; style?: StylePatch; pageId?: string; parentId?: string | null }
  | { op: "transform"; updates: Array<{ nodeId: string } & GeometryPatch> }
  | { op: "rotate"; nodeIds: string[]; rotation: number }
  | { op: "rename"; nodeId: string; name: string }
  | { op: "image"; nodeId: string; assetRef: string }
  | { op: "text"; nodeId: string; patch: TextPatch }
  | { op: "style"; nodeIds: string[]; patch: StylePatch }
  | { op: "align"; nodeIds: string[]; axis: "horizontal" | "vertical"; mode: "start" | "center" | "end" }
  | { op: "distribute"; nodeIds: string[]; axis: "horizontal" | "vertical" }
  | { op: "reorder"; parentId: string | null; pageId?: string; orderedIds: string[] }
  | { op: "boolean"; ref?: string; nodeIds: string[]; opName: "union" | "subtract" | "intersect" | "exclude" }
  | { op: "page"; ref?: string; name?: string }
  | { op: "connector"; ref?: string; connector: PublicConnectorInput; stroke?: DesignStroke; pageId?: string; parentId?: string | null }
  | { op: "connector-update"; nodeId: string; patch: PublicConnectorPatch }
  | { op: "delete"; nodeIds: string[] };

export type DesignSemanticPrecondition = {
  handle: string;
  semanticVersion: string;
};
export type EditOpenDesignArgs = {
  idempotencyKey: string;
  operations: DesignOperation[];
  preconditions?: DesignSemanticPrecondition[];
};
export type SemanticConflict = {
  handle: string;
  propertyGroups: DesignSemanticPropertyGroup[];
};
export type OperationFailure = {
  code: "invalid_request" | "not_found" | "stale_geometry" | "duplicate_ref" | "semantic_conflict";
  message: string;
  failedOperationIndex: number;
  /** JSON Pointer into the submitted request. */
  path: string;
  stateChanged: false;
  retrySafe: boolean;
  conflicts?: SemanticConflict[];
  conflictCount?: number;
  omittedConflictCount?: number;
};
export type EditOpenDesignReceipt = {
  idempotencyKey: string;
  outcome: "applied" | "noop";
  changedNodeHandles: string[];
  changedPageHandles: string[];
  createdRefs: Record<string, string>;
  summary: string;
};
export type EditOpenDesignResult =
  | { ok: true; document: DesignDocument; receipt: EditOpenDesignReceipt }
  | { ok: false; error: OperationFailure };

type Stored = { fingerprint: string; result: Extract<EditOpenDesignResult, { ok: true }> };

/** Metadata a live-session adapter must durably store to guarantee cross-worker replay. */
export type DesignIdempotencyMetadata = { key: string; fingerprint: string };

/** Host adapters own lifetime/persistence; this pure store makes the idempotency contract testable. */
export class DesignOperationReceiptStore {
  private readonly receipts = new Map<string, Stored>();
  get(key: string): Stored | undefined { return this.receipts.get(key); }
  put(key: string, value: Stored): void { this.receipts.set(key, value); }
}

/** Bounds one atomic response/request, never the size of a Design document. */
export const MAX_EDIT_OPERATIONS = 128;
/** Temporary direct-live reliability/abuse bound; persisted paths are not capped here. */
export const MAX_PATH_COMMANDS = 2_048;
const MAX_NODE_REFERENCES = 256;
const MAX_FILLS = 16;
const MAX_TEXT_LENGTH = 20_000;
const MAX_SEMANTIC_CONFLICTS = 64;
const SEMANTIC_FINGERPRINT_RE = /^s1:[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: unknown, keys: readonly string[]): string | null {
  if (!isRecord(value)) return "must be an object";
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  return unknown ? `unknown field ${unknown}` : null;
}

const OP_KEYS: Record<DesignOperation["op"], readonly string[]> = {
  create: ["op", "ref", "node", "pageId", "parentId"],
  shape: ["op", "ref", "name", "shape", "x", "y", "width", "height", "style", "pageId", "parentId"],
  path: ["op", "ref", "nodeId", "commands", "expectedGeometry", "bounds", "name", "style", "pageId", "parentId"],
  image: ["op", "nodeId", "assetRef"],
  transform: ["op", "updates"], rotate: ["op", "nodeIds", "rotation"], rename: ["op", "nodeId", "name"], text: ["op", "nodeId", "patch"], style: ["op", "nodeIds", "patch"],
  align: ["op", "nodeIds", "axis", "mode"], distribute: ["op", "nodeIds", "axis"], reorder: ["op", "parentId", "pageId", "orderedIds"],
  boolean: ["op", "ref", "nodeIds", "opName"], page: ["op", "ref", "name"], connector: ["op", "ref", "connector", "stroke", "pageId", "parentId"],
  "connector-update": ["op", "nodeId", "patch"], delete: ["op", "nodeIds"],
};

function validatePathCommand(command: unknown): string | null {
  if (!isRecord(command) || typeof command["kind"] !== "string") return "path commands must be objects with kind";
  const numbers = (keys: readonly string[]) => keys.every((key) => typeof command[key] === "number" && Number.isFinite(command[key]));
  const normalized = (keys: readonly string[]) => numbers(keys) && keys.every((key) => (command[key] as number) >= 0 && (command[key] as number) <= 1);
  if (command["kind"] === "M" || command["kind"] === "L") return onlyKeys(command, ["kind", "x", "y"]) ?? (!normalized(["x", "y"]) ? "path coordinates must be normalized finite values in [0, 1]" : null);
  if (command["kind"] === "C") return onlyKeys(command, ["kind", "c1x", "c1y", "c2x", "c2y", "x", "y"]) ?? (!normalized(["c1x", "c1y", "c2x", "c2y", "x", "y"]) ? "path coordinates must be normalized finite values in [0, 1]" : null);
  if (command["kind"] === "Z") return onlyKeys(command, ["kind"]);
  return "path kind must be M, L, C, or Z";
}

function validNodeReference(value: unknown): value is string {
  return typeof value === "string" && (/^\$[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) || nodeIdFromDesignHandle(value) !== null);
}

function validateNodeReferences(value: unknown, minimum = 1): string | null {
  if (!Array.isArray(value) || value.length < minimum || value.length > MAX_NODE_REFERENCES) return `node references must contain ${minimum}-${MAX_NODE_REFERENCES} entries`;
  if (!value.every(validNodeReference)) return "node references must use public node: handles or batch-local $refs";
  if (new Set(value).size !== value.length) return "node references must not contain duplicates";
  return null;
}

function validateStroke(value: unknown): string | null {
  const keyError = onlyKeys(value, ["color", "width", "cap", "join", "dash"]); if (keyError) return `stroke ${keyError}`;
  if (!isRecord(value) || typeof value["color"] !== "string" || value["color"].length === 0 || value["color"].length > 64 || !Number.isFinite(value["width"]) || (value["width"] as number) < 0) return "stroke requires a color of at most 64 characters and non-negative finite width";
  if (value["cap"] !== undefined && !["butt", "round", "square"].includes(value["cap"] as string)) return "stroke cap is invalid";
  if (value["join"] !== undefined && !["miter", "round", "bevel"].includes(value["join"] as string)) return "stroke join is invalid";
  if (value["dash"] !== undefined && (!Array.isArray(value["dash"]) || value["dash"].length > 64 || value["dash"].some((entry) => !Number.isFinite(entry) || entry < 0))) return "stroke dash must contain at most 64 non-negative finite numbers";
  return null;
}

function validateStyle(value: unknown, _allowStrokeRemoval: boolean): string | null {
  const keyError = onlyKeys(value, ["fills", "stroke", "opacity", "radius"]); if (keyError) return `style ${keyError}`;
  if (!isRecord(value) || Object.keys(value).length === 0) return "style must be a non-empty object";
  if (value["fills"] !== undefined) {
    if (!Array.isArray(value["fills"]) || value["fills"].length > MAX_FILLS) return `style fills must be an array of at most ${MAX_FILLS} entries`;
    for (const fill of value["fills"]) {
      const fillError = onlyKeys(fill, ["kind", "color", "opacity"]);
      if (fillError || !isRecord(fill) || fill["kind"] !== "solid" || typeof fill["color"] !== "string" || fill["color"].length === 0 || fill["color"].length > 64) return "fills must contain only solid colors of at most 64 characters";
      if (fill["opacity"] !== undefined && (!Number.isFinite(fill["opacity"]) || (fill["opacity"] as number) < 0 || (fill["opacity"] as number) > 1)) return "fill opacity must be in [0, 1]";
    }
  }
  if (value["stroke"] !== undefined && value["stroke"] !== null) { const error = validateStroke(value["stroke"]); if (error) return error; }
  if (value["opacity"] !== undefined && (!Number.isFinite(value["opacity"]) || (value["opacity"] as number) < 0 || (value["opacity"] as number) > 1)) return "style opacity must be in [0, 1]";
  if (value["radius"] !== undefined && (!Number.isFinite(value["radius"]) || (value["radius"] as number) < 0)) return "style radius must be non-negative and finite";
  return null;
}

function validateText(value: unknown): string | null {
  const keyError = onlyKeys(value, ["text", "fontSize", "fontFamily", "fontWeight", "textAlign", "lineHeight", "textWrap", "color"]); if (keyError) return `text ${keyError}`;
  if (!isRecord(value) || Object.keys(value).length === 0) return "text patch must be a non-empty object";
  if (value["text"] !== undefined && (typeof value["text"] !== "string" || value["text"].length > MAX_TEXT_LENGTH)) return `text must be a string of at most ${MAX_TEXT_LENGTH} characters`;
  if (value["fontSize"] !== undefined && (!Number.isFinite(value["fontSize"]) || (value["fontSize"] as number) <= 0)) return "fontSize must be positive and finite";
  if (value["fontFamily"] !== undefined && (typeof value["fontFamily"] !== "string" || value["fontFamily"].length > 200)) return "fontFamily must be a string of at most 200 characters";
  if (value["fontWeight"] !== undefined && typeof value["fontWeight"] !== "string" && !Number.isFinite(value["fontWeight"])) return "fontWeight must be a string or finite number";
  if (value["textAlign"] !== undefined && !["left", "center", "right"].includes(value["textAlign"] as string)) return "textAlign is invalid";
  if (value["color"] !== undefined && (typeof value["color"] !== "string" || value["color"].length > 64)) return "text color must be a string of at most 64 characters";
  return null;
}

function validateCreateNode(value: unknown): string | null {
  const keyError = onlyKeys(value, ["type", "name", "x", "y", "width", "height", "start", "end", "rotation", "style", "text", "assetRef"]); if (keyError) return `create node ${keyError}`;
  if (!isRecord(value) || typeof value["type"] !== "string" || (!["frame", "text", "rectangle", "image"].includes(value["type"]) && !isVectorPrimitiveTool(value["type"]))) {
    return "create node type is unsupported";
  }
  if ((value["type"] === "image" && !isDesignAssetRef(value["assetRef"])) || (value["type"] !== "image" && value["assetRef"] !== undefined)) return "image creation requires a host-owned assetRef";
  if (value["name"] !== undefined && (typeof value["name"] !== "string" || value["name"].length === 0 || value["name"].length > 256)) return "create node name is invalid";
  for (const field of ["x", "y", "width", "height", "rotation"] as const) if (value[field] !== undefined && !Number.isFinite(value[field])) return `create node ${field} must be finite`;
  if ((value["width"] as number | undefined) !== undefined && (value["width"] as number) <= 0 || (value["height"] as number | undefined) !== undefined && (value["height"] as number) <= 0) return "create node dimensions must be positive";
  if (value["type"] === "line") {
    for (const endpoint of ["start", "end"] as const) {
      const point = value[endpoint];
      if (!isRecord(point) || onlyKeys(point, ["x", "y"]) || !Number.isFinite(point["x"]) || !Number.isFinite(point["y"])) {
        return `create line ${endpoint} must contain only finite x and y`;
      }
    }
    const start = value["start"] as { x: number; y: number };
    const end = value["end"] as { x: number; y: number };
    if (start.x === end.x && start.y === end.y) return "create line endpoints must be distinct";
    if (["x", "y", "width", "height"].some((field) => value[field] !== undefined)) return "create line uses start and end, not bounds";
  } else if (isVectorPrimitiveTool(value["type"]) || value["type"] === "rectangle") {
    // Historical rectangle calls may omit geometry and receive canonical
    // defaults. Any explicit rectangle geometry, and every vector primitive,
    // uses the new complete positive-bounds contract.
    const requiresBounds = value["type"] !== "rectangle" || ["x", "y", "width", "height"].some((field) => value[field] !== undefined);
    if (requiresBounds && ["x", "y", "width", "height"].some((field) => !Number.isFinite(value[field]))) return "closed shape creation requires finite x, y, width, and height";
    if (requiresBounds && ((value["width"] as number) <= 0 || (value["height"] as number) <= 0)) return "closed shape width and height must be positive";
    if (value["start"] !== undefined || value["end"] !== undefined) return "closed shapes use bounds, not line endpoints";
  } else if (value["start"] !== undefined || value["end"] !== undefined) {
    return "line endpoints require a line node";
  }
  if (value["style"] !== undefined) { const error = validateStyle(value["style"], false); if (error) return error; }
  if (value["text"] !== undefined) { const error = validateText(value["text"]); if (error) return error; }
  if (value["text"] !== undefined && value["type"] !== "text") return "text fields require a text node";
  return null;
}

function validateEndpoint(endpoint: unknown): string | null {
  const keyError = onlyKeys(endpoint, ["x", "y", "targetHandle", "anchor", "detachedFromHandle"]);
  if (keyError) return `connector endpoint ${keyError}`;
  if (!isRecord(endpoint) || !Number.isFinite(endpoint["x"]) || !Number.isFinite(endpoint["y"])) return "connector endpoint requires finite x and y";
  if (endpoint["targetHandle"] !== undefined && !validNodeReference(endpoint["targetHandle"])) return "connector endpoint targetHandle must be a public handle or temporary ref";
  if (endpoint["detachedFromHandle"] !== undefined && !validNodeReference(endpoint["detachedFromHandle"])) return "connector endpoint detachedFromHandle must be a public handle or temporary ref";
  if (endpoint["anchor"] !== undefined) {
    const anchorError = onlyKeys(endpoint["anchor"], ["x", "y"]);
    if (anchorError || !isRecord(endpoint["anchor"]) || !Number.isFinite(endpoint["anchor"]["x"]) || !Number.isFinite(endpoint["anchor"]["y"]) || (endpoint["anchor"]["x"] as number) < 0 || (endpoint["anchor"]["x"] as number) > 1 || (endpoint["anchor"]["y"] as number) < 0 || (endpoint["anchor"]["y"] as number) > 1) return "connector anchor must contain only x and y in [0, 1]";
  }
  return null;
}

function validateConnector(value: unknown, partial: boolean): string | null {
  const keyError = onlyKeys(value, ["route", "start", "end", "startArrow", "endArrow"]);
  if (keyError) return `connector ${keyError}`;
  if (!isRecord(value)) return "connector must be an object";
  if (partial && Object.keys(value).length === 0) return "connector update patch must be non-empty";
  if (!partial && (value["start"] === undefined || value["end"] === undefined)) return "connector requires start and end";
  if (value["route"] !== undefined && value["route"] !== "straight" && value["route"] !== "elbow") return "connector route must be straight or elbow";
  if (value["startArrow"] !== undefined && typeof value["startArrow"] !== "boolean") return "connector startArrow must be boolean";
  if (value["endArrow"] !== undefined && typeof value["endArrow"] !== "boolean") return "connector endArrow must be boolean";
  for (const side of ["start", "end"] as const) if (value[side] !== undefined) { const error = validateEndpoint(value[side]); if (error) return error; }
  return null;
}

function validateRuntimeOperation(operation: unknown): string | null {
  if (!isRecord(operation) || typeof operation["op"] !== "string" || !(operation["op"] in OP_KEYS)) return "operation.op is unsupported";
  const op = operation["op"] as DesignOperation["op"];
  const keyError = onlyKeys(operation, OP_KEYS[op]); if (keyError) return keyError;
  for (const field of ["nodeId", "parentId"] as const) if (operation[field] !== undefined && operation[field] !== null && !validNodeReference(operation[field])) return `${field} must be a public node: handle or temporary ref`;
  if (operation["pageId"] !== undefined && pageIdFromDesignHandle(operation["pageId"]) === null) return "pageId must be a public page: handle";
  if (operation["ref"] !== undefined && (typeof operation["ref"] !== "string" || !/^\$[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(operation["ref"]))) return "ref must be a bounded temporary reference beginning with $";
  if (op === "path") {
    const commands = operation["commands"]; const bounds = operation["bounds"];
    if (!Array.isArray(commands)) return "path commands must be an array";
    if (commands.length < 2) return `path commands require at least 2 entries; observed ${commands.length}; state is unchanged`;
    if (commands.length > MAX_PATH_COMMANDS) return `direct-live path request exceeds the temporary reliability safety bound: observed ${commands.length}, maximum ${MAX_PATH_COMMANDS}; state is unchanged; simplify or resample the path, or finish it through manual/local authoring`;
    for (const command of commands) { const error = validatePathCommand(command); if (error) return error; }
    if (onlyKeys(bounds, ["x", "y", "width", "height"]) || !isRecord(bounds) || ["x", "y", "width", "height"].some((key) => typeof bounds[key] !== "number" || !Number.isFinite(bounds[key]))) return "path bounds must contain only finite x, y, width, height";
    if ((bounds["width"] as number) <= 0 || (bounds["height"] as number) <= 0) return "path bounds width and height must be positive";
    if (operation["name"] !== undefined && (typeof operation["name"] !== "string" || operation["name"].length === 0 || operation["name"].length > 256)) return "path name is invalid";
    if (operation["style"] !== undefined) { const error = validateStyle(operation["style"], false); if (error) return error; }
    if (operation["expectedGeometry"] !== undefined) {
      if (!Array.isArray(operation["expectedGeometry"]) || operation["expectedGeometry"].length < 2 || operation["expectedGeometry"].length > MAX_PATH_COMMANDS) return "expectedGeometry must be a bounded path command array";
      for (const command of operation["expectedGeometry"]) { const error = validatePathCommand(command); if (error) return error; }
    }
  }
  if (op === "image") return !validNodeReference(operation["nodeId"]) ? "nodeId must use a public node handle" : !isDesignAssetRef(operation["assetRef"]) ? "assetRef must be a host-owned image reference" : null;
  if (op === "create") return validateCreateNode(operation["node"]);
  if (op === "shape") {
    if (typeof operation["shape"] !== "string" || (operation["shape"] !== "rectangle" && !isVectorPrimitiveTool(operation["shape"]))) return "shape is unsupported";
    for (const field of ["x", "y", "width", "height"] as const) if (!Number.isFinite(operation[field])) return `shape ${field} must be finite`;
    if ((operation["width"] as number) <= 0 || (operation["height"] as number) <= 0) return "shape dimensions must be positive";
    if (operation["name"] !== undefined && (typeof operation["name"] !== "string" || operation["name"].length === 0 || operation["name"].length > 256)) return "shape name is invalid";
    if (operation["style"] !== undefined) return validateStyle(operation["style"], false);
  }
  if (op === "connector") {
    const error = validateConnector(operation["connector"], false); if (error) return error;
    if (operation["stroke"] !== undefined) return validateStroke(operation["stroke"]);
  }
  if (op === "connector-update") return validateConnector(operation["patch"], true);
  if (op === "transform") {
    if (!Array.isArray(operation["updates"]) || operation["updates"].length === 0 || operation["updates"].length > MAX_NODE_REFERENCES) return `transform updates must contain 1-${MAX_NODE_REFERENCES} entries`;
    for (const update of operation["updates"]) {
      const updateError = onlyKeys(update, ["nodeId", "x", "y", "width", "height"]);
      if (updateError || !isRecord(update) || !validNodeReference(update["nodeId"])) return "each transform update must contain a public node: handle or $ref and finite geometry";
      for (const field of ["x", "y", "width", "height"] as const) if (update[field] !== undefined && !Number.isFinite(update[field])) return "transform geometry must be finite";
      if (Object.keys(update).length < 2) return "transform update requires at least one geometry field";
      if ((update["width"] as number | undefined) !== undefined && (update["width"] as number) < 0 || (update["height"] as number | undefined) !== undefined && (update["height"] as number) < 0) return "transform dimensions must be non-negative";
    }
  }
  if (op === "rename" && (typeof operation["name"] !== "string" || operation["name"].trim().length === 0 || operation["name"].length > 256)) {
    return "rename name must be a non-empty string of at most 256 characters";
  }
  if (op === "rotate") { const error = validateNodeReferences(operation["nodeIds"]); if (error) return error; if (!Number.isFinite(operation["rotation"])) return "rotation must be finite"; }
  if (op === "text") return validateText(operation["patch"]);
  if (op === "style") { const error = validateNodeReferences(operation["nodeIds"]); return error ?? validateStyle(operation["patch"], true); }
  if (op === "align") { const error = validateNodeReferences(operation["nodeIds"], 2); if (error) return error; if (!["horizontal", "vertical"].includes(operation["axis"] as string) || !["start", "center", "end"].includes(operation["mode"] as string)) return "align axis or mode is invalid"; }
  if (op === "distribute") { const error = validateNodeReferences(operation["nodeIds"], 3); if (error) return error; if (!["horizontal", "vertical"].includes(operation["axis"] as string)) return "distribute axis is invalid"; }
  if (op === "reorder") { const error = validateNodeReferences(operation["orderedIds"]); if (error) return error; if (operation["parentId"] === undefined) return "reorder parentId is required (null for page)"; if (operation["parentId"] === null && operation["pageId"] === undefined) return "top-level reorder requires pageId"; }
  if (op === "boolean") { const error = validateNodeReferences(operation["nodeIds"], 2); if (error) return error; if (!["union", "subtract", "intersect", "exclude"].includes(operation["opName"] as string)) return "boolean opName is invalid"; }
  if (op === "page" && operation["name"] !== undefined && (typeof operation["name"] !== "string" || operation["name"].trim().length === 0 || operation["name"].length > 256)) return "page name is invalid";
  if (op === "delete") return validateNodeReferences(operation["nodeIds"]);
  return null;
}

function runtimeValidationPath(operation: unknown, message: string): string {
  if (!isRecord(operation)) return "";
  const op = typeof operation["op"] === "string" ? operation["op"] : "";
  if (op === "create") {
    if (message.includes(" line start")) return "/node/start";
    if (message.includes(" line end")) return "/node/end";
    if (message.includes("line endpoints")) return "/node/end";
    if (message.includes("stroke")) return "/node/style/stroke";
    if (message.includes("name")) return "/node/name";
    if (message.includes("width") || message.includes("dimensions") || message.includes("bounds")) return "/node/width";
    if (message.includes("height")) return "/node/height";
    if (message.includes("type")) return "/node/type";
    return "/node";
  }
  if (message.includes("stroke")) return op === "style" ? "/patch/stroke" : "/style/stroke";
  for (const field of ["pageId", "parentId", "nodeId", "nodeIds", "orderedIds", "operations", "preconditions"] as const) {
    if (message.includes(field)) return `/${field}`;
  }
  return "";
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function fnv1a32(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Fixed-width, deterministic document + operation digest for a host-owned
 * idempotency ledger. `v1:` makes future canonicalization/hash migration safe.
 */
export function designOperationFingerprint(
  document: DesignDocument,
  operations: readonly DesignOperation[],
  preconditions: readonly DesignSemanticPrecondition[] = [],
): string {
  const payload = stableJson({ document, operations, preconditions });
  return `v1:${fnv1a32(payload, 0x811c9dc5)}${fnv1a32(payload, 0x9e3779b9)}`;
}

type RequiredSemanticPreconditions = Map<string, Set<DesignSemanticPropertyGroup>>;

function addSemanticRequirement(
  required: RequiredSemanticPreconditions,
  handle: string | null | undefined,
  groups: readonly DesignSemanticPropertyGroup[],
): void {
  if (!handle || handle.startsWith("$")) return;
  if (nodeIdFromDesignHandle(handle) === null && pageIdFromDesignHandle(handle) === null) return;
  const current = required.get(handle) ?? new Set<DesignSemanticPropertyGroup>();
  groups.forEach((group) => current.add(group));
  required.set(handle, current);
}

function addCreationDependencies(
  required: RequiredSemanticPreconditions,
  operation: { pageId?: string; parentId?: string | null },
): void {
  addSemanticRequirement(required, operation.pageId, ["structure"]);
  addSemanticRequirement(required, operation.parentId, ["structure"]);
}

function addConnectorDependencies(
  required: RequiredSemanticPreconditions,
  connector: PublicConnectorInput | PublicConnectorPatch,
): void {
  for (const endpoint of [connector.start, connector.end]) {
    if (!endpoint) continue;
    addSemanticRequirement(required, endpoint.targetHandle, ["geometry", "structure"]);
    addSemanticRequirement(required, endpoint.detachedFromHandle, ["geometry", "structure"]);
  }
}

export function requiredDesignSemanticPreconditions(
  operations: readonly DesignOperation[],
): ReadonlyMap<string, ReadonlySet<DesignSemanticPropertyGroup>> {
  const required: RequiredSemanticPreconditions = new Map();
  const allGroups = DESIGN_SEMANTIC_PROPERTY_GROUPS;
  for (const operation of operations) {
    switch (operation.op) {
      case "path":
        if (operation.nodeId) addSemanticRequirement(required, operation.nodeId, ["geometry"]);
        else addCreationDependencies(required, operation);
        break;
      case "transform":
        operation.updates.forEach((update) => addSemanticRequirement(required, update.nodeId, ["geometry"]));
        break;
      case "rotate":
      case "align":
      case "distribute":
        operation.nodeIds.forEach((handle) => addSemanticRequirement(required, handle, ["geometry"]));
        break;
      case "rename":
        addSemanticRequirement(required, operation.nodeId, ["name"]);
        break;
      case "image":
        addSemanticRequirement(required, operation.nodeId, ["appearance"]);
        break;
      case "text":
        addSemanticRequirement(required, operation.nodeId, ["text"]);
        break;
      case "style":
        operation.nodeIds.forEach((handle) => addSemanticRequirement(required, handle, ["appearance"]));
        break;
      case "reorder":
        addSemanticRequirement(required, operation.parentId ?? operation.pageId, ["structure"]);
        operation.orderedIds.forEach((handle) => addSemanticRequirement(required, handle, ["structure"]));
        break;
      case "boolean":
      case "delete":
        operation.nodeIds.forEach((handle) => addSemanticRequirement(required, handle, allGroups));
        break;
      case "connector-update":
        addSemanticRequirement(required, operation.nodeId, ["connector"]);
        addConnectorDependencies(required, operation.patch);
        break;
      case "create":
      case "shape":
        addCreationDependencies(required, operation);
        break;
      case "connector":
        addCreationDependencies(required, operation);
        addConnectorDependencies(required, operation.connector);
        break;
      case "page":
        break;
    }
  }
  return required;
}

function parseSemanticPreconditions(
  value: unknown,
): { ok: true; entries: Map<string, string> } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, entries: new Map() };
  if (!Array.isArray(value) || value.length > MAX_NODE_REFERENCES) {
    return { ok: false, message: `preconditions must contain at most ${MAX_NODE_REFERENCES} public handle entries` };
  }
  const entries = new Map<string, string>();
  for (const entry of value) {
    if (!isRecord(entry) || onlyKeys(entry, ["handle", "semanticVersion"])) {
      return { ok: false, message: "precondition entries accept only handle and semanticVersion" };
    }
    const handle = entry["handle"];
    if (
      typeof handle !== "string" ||
      (nodeIdFromDesignHandle(handle) === null && pageIdFromDesignHandle(handle) === null) ||
      entries.has(handle)
    ) {
      return { ok: false, message: "precondition handles must be unique public node:/page: handles" };
    }
    const semanticVersion = entry["semanticVersion"];
    if (typeof semanticVersion !== "string" || !SEMANTIC_FINGERPRINT_RE.test(semanticVersion)) {
      return { ok: false, message: "precondition semanticVersion must be an inspection-issued opaque value" };
    }
    entries.set(handle, semanticVersion);
  }
  return { ok: true, entries };
}

function firstOperationIndexRequiringHandle(
  operations: readonly DesignOperation[],
  handle: string,
): number {
  const index = operations.findIndex((operation) =>
    requiredDesignSemanticPreconditions([operation]).has(handle),
  );
  return index < 0 ? 0 : index;
}

function semanticConflictFailure(
  operations: readonly DesignOperation[],
  conflicts: SemanticConflict[],
): EditOpenDesignResult {
  const visible = conflicts.slice(0, MAX_SEMANTIC_CONFLICTS);
  const failedOperationIndex = conflicts.reduce(
    (lowest, conflict) => Math.min(lowest, firstOperationIndexRequiringHandle(operations, conflict.handle)),
    Number.POSITIVE_INFINITY,
  );
  return {
    ok: false,
    error: {
      code: "semantic_conflict",
      message: "The intended semantic properties changed since inspection; the pending edit was not applied.",
      failedOperationIndex: Number.isFinite(failedOperationIndex) ? failedOperationIndex : 0,
      path: "/preconditions",
      stateChanged: false,
      retrySafe: false,
      conflicts: visible,
      conflictCount: conflicts.length,
      omittedConflictCount: conflicts.length - visible.length,
    },
  };
}

export function validateDesignSemanticPreconditions(
  document: DesignDocument,
  operations: readonly DesignOperation[],
  preconditionsValue: unknown,
): EditOpenDesignResult | null {
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index]!;
    const isCreation = operation.op === "create" ||
      operation.op === "shape" ||
      operation.op === "connector" ||
      (operation.op === "path" && operation.nodeId === undefined);
    if (isCreation && pageIdFromDesignHandle(operation.pageId) === null) {
      return failure(
        index,
        "invalid_request",
        "Semantic live creation requires an explicit inspected pageId and its page precondition; the implicit default page is not stale-safe.",
        true,
        `/operations/${index}/pageId`,
      );
    }
  }
  const required = requiredDesignSemanticPreconditions(operations);
  const parsed = parseSemanticPreconditions(preconditionsValue);
  if (!parsed.ok) return failure(0, "invalid_request", parsed.message, true, "/preconditions");

  for (const handle of parsed.entries.keys()) {
    if (!required.has(handle)) return failure(0, "invalid_request", "preconditions must exactly cover the public handles targeted by this batch", true, "/preconditions");
  }
  if (parsed.entries.size !== required.size) {
    return failure(0, "invalid_request", "preconditions are required for every existing public handle targeted by this batch", true, "/preconditions");
  }

  const conflicts: SemanticConflict[] = [];
  for (const [handle, requiredGroups] of required) {
    const supplied = parsed.entries.get(handle);
    if (!supplied) {
      return failure(0, "invalid_request", "preconditions are required for every existing public handle targeted by this batch", true, "/preconditions");
    }
    const nodeId = nodeIdFromDesignHandle(handle);
    const pageId = pageIdFromDesignHandle(handle);
    const node = nodeId === null ? undefined : document.nodes[nodeId];
    const page = pageId === null ? undefined : document.pages.find((candidate) => candidate.id === pageId);
    const current = node
      ? semanticVersionForNode(node, document)
      : page
        ? semanticVersionForPage(page)
        : null;
    if (current !== supplied) conflicts.push({ handle, propertyGroups: [...requiredGroups] });
  }
  return conflicts.length > 0 ? semanticConflictFailure(operations, conflicts) : null;
}

function failure(
  failedOperationIndex: number,
  code: OperationFailure["code"],
  message: string,
  retrySafe = false,
  path = `/operations/${failedOperationIndex}`,
): EditOpenDesignResult {
  return { ok: false, error: { code, message, failedOperationIndex, path, stateChanged: false, retrySafe } };
}

function resolve(value: string, refs: ReadonlyMap<string, string>): string | null {
  if (value.startsWith("$")) return refs.get(value) ?? null;
  return nodeIdFromDesignHandle(value);
}

function resolvePage(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  return pageIdFromDesignHandle(value);
}

function resolveIds(ids: readonly string[], refs: ReadonlyMap<string, string>): string[] | null {
  const resolved = ids.map((id) => resolve(id, refs));
  return resolved.every((id): id is string => id !== null) ? resolved : null;
}

type ResolvedCreationLocation = {
  ok: true;
  pageId?: string;
  parentId?: string | null;
} | {
  ok: false;
  code: "invalid_request" | "not_found";
  message: string;
};

function owningPageId(document: DesignDocument, nodeId: string): string | null {
  let current = document.nodes[nodeId];
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.id)) return null;
    visited.add(current.id);
    if (current.parentId === null) {
      const rootId = current.id;
      return document.pages.find((page) => page.children.includes(rootId))?.id ?? null;
    }
    current = document.nodes[current.parentId];
  }
  return null;
}

function resolveCreationLocation(
  document: DesignDocument,
  pageHandle: string | undefined,
  parentHandle: string | null | undefined,
  refs: ReadonlyMap<string, string>,
): ResolvedCreationLocation {
  const pageId = resolvePage(pageHandle);
  if (pageHandle !== undefined && (pageId === null || !document.pages.some((page) => page.id === pageId))) {
    return { ok: false, code: "not_found", message: "Unknown page handle." };
  }
  if (parentHandle === null) {
    if (pageId === undefined || pageId === null) {
      return { ok: false, code: "invalid_request", message: "pageId is required when parentId is null." };
    }
    return { ok: true, pageId, parentId: null };
  }
  if (parentHandle === undefined) {
    return pageId === undefined || pageId === null ? { ok: true } : { ok: true, pageId };
  }
  const parentId = resolve(parentHandle, refs);
  if (!parentId || !document.nodes[parentId]) {
    return { ok: false, code: "not_found", message: "Unknown parent handle." };
  }
  const parentPageId = owningPageId(document, parentId);
  if (!parentPageId) {
    return { ok: false, code: "not_found", message: "Parent is not attached to a page." };
  }
  if (pageId !== undefined && pageId !== parentPageId) {
    return { ok: false, code: "invalid_request", message: "parentId must belong to pageId." };
  }
  return { ok: true, pageId: pageId ?? parentPageId, parentId };
}

function resolveConnector(connector: PublicConnectorInput, refs: ReadonlyMap<string, string>): DesignConnector | null {
  const endpoint = (value: DesignConnector["start"]): DesignConnector["start"] | null => {
    const publicValue = value as PublicConnectorInput["start"];
    const targetId = publicValue.targetHandle ? resolve(publicValue.targetHandle, refs) : undefined;
    const detachedFromTargetId = publicValue.detachedFromHandle ? resolve(publicValue.detachedFromHandle, refs) : undefined;
    if ((publicValue.targetHandle && !targetId) || (publicValue.detachedFromHandle && !detachedFromTargetId)) return null;
    const { targetHandle: _target, detachedFromHandle: _detached, ...base } = publicValue;
    return { ...base, ...(targetId ? { targetId } : {}), ...(detachedFromTargetId ? { detachedFromTargetId } : {}) };
  };
  const start = endpoint(connector.start);
  const end = endpoint(connector.end);
  return start && end ? { ...connector, start, end } : null;
}

function resolveConnectorPatch(patch: PublicConnectorPatch, refs: ReadonlyMap<string, string>): ConnectorPatch | null {
  const endpoints = resolveConnector({
    route: "straight",
    start: patch.start ?? { x: 0, y: 0 },
    end: patch.end ?? { x: 0, y: 0 },
  }, refs);
  if (!endpoints) return null;
  return {
    ...(patch.route !== undefined ? { route: patch.route } : {}),
    ...(patch.start !== undefined ? { start: endpoints.start } : {}),
    ...(patch.end !== undefined ? { end: endpoints.end } : {}),
    ...(patch.startArrow !== undefined ? { startArrow: patch.startArrow } : {}),
    ...(patch.endArrow !== undefined ? { endArrow: patch.endArrow } : {}),
  };
}

function commandsToNetwork(commands: PathCommand[], bounds: { x: number; y: number; width: number; height: number }): VectorNetwork | null {
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0 || commands.length < 2) return null;
  const point = (x: number, y: number) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x: x * bounds.width, y: y * bounds.height } : null;
  const vertices: VectorNetwork["vertices"] = [];
  const segments: VectorNetwork["segments"] = [];
  let current: string | null = null;
  let closed = false;
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index]!;
    if (command.kind === "M") {
      if (index !== 0) return null;
      const p = point(command.x, command.y); if (!p) return null;
      current = "v0"; vertices.push({ id: current, ...p });
    } else if (command.kind === "Z") {
      if (index !== commands.length - 1 || !current || vertices.length < 2 || closed) return null;
      segments.push({ id: `s${segments.length}`, startVertexId: current, endVertexId: "v0" }); closed = true;
    } else {
      if (!current || closed) return null;
      const end = point(command.x, command.y); if (!end) return null;
      const endId = `v${vertices.length}`; const segment: VectorNetwork["segments"][number] = { id: `s${segments.length}`, startVertexId: current, endVertexId: endId };
      if (command.kind === "C") { const c1 = point(command.c1x, command.c1y); const c2 = point(command.c2x, command.c2y); if (!c1 || !c2) return null; segment.startHandle = c1; segment.endHandle = c2; }
      vertices.push({ id: endId, ...end }); segments.push(segment); current = endId;
    }
  }
  return vertices.length >= 2 && segments.length >= 1 ? { vertices, segments, regions: closed ? [{ id: "r0", vertexIds: vertices.map((vertex) => vertex.id) }] : [] } : null;
}

function pathMatchesExpected(node: DesignNode, expected: PathCommand[]): boolean {
  if (node.type !== "vector" || node.width === 0 || node.height === 0) return false;
  const normalized = commandsFromVectorNetwork(node.vectorNetwork ?? { vertices: [], segments: [], regions: [] }).map((command): PathCommand => {
    if (command.kind === "M" || command.kind === "L") return { ...command, x: command.x / node.width, y: command.y / node.height };
    if (command.kind === "C") return { ...command, c1x: command.c1x / node.width, c1y: command.c1y / node.height, c2x: command.c2x / node.width, c2y: command.c2y / node.height, x: command.x / node.width, y: command.y / node.height };
    return command;
  });
  if (normalized.length !== expected.length) return false;
  return normalized.every((actual, index) => {
    const candidate = expected[index];
    if (!candidate || actual.kind !== candidate.kind) return false;
    if (actual.kind === "Z") return true;
    if (candidate.kind === "Z") return false;
    if (actual.kind === "M" || actual.kind === "L") {
      return candidate.kind === actual.kind &&
        actual.x === candidate.x &&
        actual.y === candidate.y;
    }
    return candidate.kind === "C" &&
      actual.c1x === candidate.c1x &&
      actual.c1y === candidate.c1y &&
      actual.c2x === candidate.c2x &&
      actual.c2y === candidate.c2y &&
      actual.x === candidate.x &&
      actual.y === candidate.y;
  });
}

/** Apply an ordered atomic batch. A refusal always returns the unchanged input document implicitly. */
export function editOpenDesign(
  document: DesignDocument,
  args: unknown,
  store?: DesignOperationReceiptStore,
  options: { requireSemanticPreconditions?: boolean } = {},
): EditOpenDesignResult {
  if (!isRecord(args) || typeof args["idempotencyKey"] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(args["idempotencyKey"]) || !Array.isArray(args["operations"]) || onlyKeys(args, ["idempotencyKey", "operations", "preconditions"])) {
    return failure(0, "invalid_request", "idempotencyKey and operations are required.", true);
  }
  const runtimeOperations = args["operations"] as unknown[];
  if (runtimeOperations.length === 0) return failure(0, "invalid_request", "operations must contain at least one atomic intent; state is unchanged", true);
  if (runtimeOperations.length > MAX_EDIT_OPERATIONS) {
    return failure(0, "invalid_request", `direct-live edit request exceeds the reliability safety bound: observed ${runtimeOperations.length}, maximum ${MAX_EDIT_OPERATIONS}; state is unchanged; partition independent intents into separate batches, with atomicity applying to each batch`, true);
  }
  for (let index = 0; index < runtimeOperations.length; index++) {
    const operation = runtimeOperations[index];
    const error = validateRuntimeOperation(operation);
    if (error) return failure(
      index,
      "invalid_request",
      error,
      true,
      `/operations/${index}${runtimeValidationPath(operation, error)}`,
    );
  }
  const typedArgs = args as EditOpenDesignArgs;
  if (options.requireSemanticPreconditions === true || Object.prototype.hasOwnProperty.call(args, "preconditions")) {
    const semanticFailure = validateDesignSemanticPreconditions(document, typedArgs.operations, typedArgs.preconditions);
    if (semanticFailure) return semanticFailure;
  }
  const fingerprint = designOperationFingerprint(document, typedArgs.operations, typedArgs.preconditions);
  const cached = store?.get(typedArgs.idempotencyKey);
  if (cached) return cached.fingerprint === fingerprint ? cached.result : failure(0, "invalid_request", "idempotencyKey was already used for a different operation batch.");
  let next = document;
  const refs = new Map<string, string>();
  const refKinds = new Map<string, "node" | "page">();
  const changedNodeIds = new Set<string>();
  const changedPageIds = new Set<string>();
  const actionKinds = new Set<string>();
  let applied = false;
  for (let index = 0; index < typedArgs.operations.length; index++) {
    const operation = typedArgs.operations[index];
    if (!operation || typeof operation !== "object" || !("op" in operation)) return failure(index, "invalid_request", "Operation must have an op.", true);
    let request: DesignTransactionRequest;
    let ref: string | undefined;
    if (operation.op === "create") {
      const location = resolveCreationLocation(next, operation.pageId, operation.parentId, refs);
      if (!location.ok) return failure(index, location.code, location.message, location.code === "invalid_request");
      const { type, start, end, ...publicNode } = operation.node;
      const built = isVectorPrimitiveTool(type)
        ? buildPrimitiveFromDrag(
            type,
            type === "line" ? start! : { x: publicNode.x!, y: publicNode.y! },
            type === "line" ? end! : { x: publicNode.x! + publicNode.width!, y: publicNode.y! + publicNode.height! },
          )
        : null;
      request = {
        kind: "create",
        node: built
          ? {
              type: "vector",
              ...(publicNode.name !== undefined ? { name: publicNode.name } : {}),
              x: built.x,
              y: built.y,
              width: built.width,
              height: built.height,
              vectorNetwork: built.network,
              ...(publicNode.rotation !== undefined ? { rotation: publicNode.rotation } : {}),
              ...(publicNode.style !== undefined ? { style: publicNode.style } : {}),
            }
          : { ...publicNode, type: type as "frame" | "text" | "rectangle" | "image" },
        ...(location.pageId ? { pageId: location.pageId } : {}),
        ...(location.parentId !== undefined ? { parentId: location.parentId } : {}),
      };
      ref = operation.ref;
    } else if (operation.op === "shape") {
      if (operation.shape !== "rectangle" && !isVectorPrimitiveTool(operation.shape)) return failure(index, "invalid_request", "shape must be a supported common shape.", true);
      const built = operation.shape === "rectangle" ? null : buildPrimitiveFromDrag(operation.shape, { x: operation.x, y: operation.y }, { x: operation.x + operation.width, y: operation.y + operation.height });
      const location = resolveCreationLocation(next, operation.pageId, operation.parentId, refs);
      if (!location.ok) return failure(index, location.code, location.message, location.code === "invalid_request");
      request = built
        ? { kind: "create", node: { type: "vector", ...(operation.name !== undefined ? { name: operation.name } : {}), x: built.x, y: built.y, width: built.width, height: built.height, vectorNetwork: built.network, ...(operation.style !== undefined ? { style: operation.style } : {}) }, ...(location.pageId ? { pageId: location.pageId } : {}), ...(location.parentId !== undefined ? { parentId: location.parentId } : {}) }
        : { kind: "create", node: { type: "rectangle", ...(operation.name !== undefined ? { name: operation.name } : {}), x: operation.x, y: operation.y, width: operation.width, height: operation.height, ...(operation.style !== undefined ? { style: operation.style } : {}) }, ...(location.pageId ? { pageId: location.pageId } : {}), ...(location.parentId !== undefined ? { parentId: location.parentId } : {}) };
      ref = operation.ref;
    } else if (operation.op === "path") {
      const network = commandsToNetwork(operation.commands, operation.bounds);
      if (!network) return failure(index, "invalid_request", "Path commands must be a finite normalized move/line/cubic/close path with at least two points.", true);
      const nodeId = operation.nodeId ? resolve(operation.nodeId, refs) : null;
      if (operation.nodeId && !nodeId) return failure(index, "not_found", "Path node reference was not created by this batch.");
      if (nodeId) {
        const current = next.nodes[nodeId];
        if (!current) return failure(index, "not_found", `Node not found: ${nodeId}`);
        if (!operation.expectedGeometry) return failure(index, "invalid_request", "expectedGeometry is required to revise an existing path.", true);
        if (!pathMatchesExpected(current, operation.expectedGeometry)) return failure(index, "stale_geometry", "Path geometry changed since it was inspected.");
        request = { kind: "vector", nodeId, ...operation.bounds, vectorNetwork: network };
      } else {
        const location = resolveCreationLocation(next, operation.pageId, operation.parentId, refs);
        if (!location.ok) return failure(index, location.code, location.message, location.code === "invalid_request");
        request = { kind: "create", node: { type: "vector", ...(operation.name !== undefined ? { name: operation.name } : {}), ...operation.bounds, vectorNetwork: network, ...(operation.style !== undefined ? { style: operation.style } : {}) }, ...(location.pageId ? { pageId: location.pageId } : {}), ...(location.parentId !== undefined ? { parentId: location.parentId } : {}) };
        ref = operation.ref;
      }
    } else if (operation.op === "transform") {
      const updates = operation.updates.map((update) => ({ ...update, nodeId: resolve(update.nodeId, refs) }));
      if (updates.some((update) => update.nodeId === null)) return failure(index, "not_found", "Unknown temporary node reference.");
      request = { kind: "transform", updates: updates as Array<{ nodeId: string } & GeometryPatch> };
    } else if (operation.op === "rotate" || operation.op === "style" || operation.op === "align" || operation.op === "distribute" || operation.op === "delete") {
      const nodeIds = resolveIds(operation.nodeIds, refs);
      if (!nodeIds) return failure(index, "not_found", "Unknown temporary node reference.");
      request = operation.op === "rotate" ? { kind: "rotate", nodeIds, rotation: operation.rotation }
        : operation.op === "style" ? { kind: "style", nodeIds, patch: operation.patch }
        : operation.op === "align" ? { kind: "align", nodeIds, axis: operation.axis, mode: operation.mode }
        : operation.op === "distribute" ? { kind: "distribute", nodeIds, axis: operation.axis }
        : { kind: "delete", nodeIds };
    } else if (operation.op === "image") {
      const nodeId = resolve(operation.nodeId, refs); if (!nodeId) return failure(index, "not_found", "Unknown temporary node reference.");
      request = { kind: "image", nodeId, assetRef: operation.assetRef };
    } else if (operation.op === "text") {
      const nodeId = resolve(operation.nodeId, refs); if (!nodeId) return failure(index, "not_found", "Unknown temporary node reference.");
      request = { kind: "text", nodeId, patch: operation.patch };
    } else if (operation.op === "rename") {
      const nodeId = resolve(operation.nodeId, refs); if (!nodeId) return failure(index, "not_found", "Unknown temporary node reference.");
      request = { kind: "rename", nodeIds: [nodeId], name: operation.name.trim() };
    } else if (operation.op === "reorder") {
      const parentId = operation.parentId === null ? null : resolve(operation.parentId, refs); const orderedIds = resolveIds(operation.orderedIds, refs); const pageId = resolvePage(operation.pageId);
      if (parentId === null && operation.parentId !== null || !orderedIds) return failure(index, "not_found", "Unknown temporary node reference.");
      if (pageId === null || (pageId !== undefined && !next.pages.some((page) => page.id === pageId))) return failure(index, "not_found", "Unknown page handle.");
      if (parentId === null) {
        request = { kind: "reorder", parentId, ...(pageId ? { pageId } : {}), orderedIds };
      } else {
        const parentPageId = owningPageId(next, parentId);
        if (!parentPageId) return failure(index, "not_found", "Parent is not attached to a page.");
        if (pageId !== undefined && pageId !== parentPageId) return failure(index, "invalid_request", "parentId must belong to pageId.", true);
        request = { kind: "reorder", parentId, pageId: pageId ?? parentPageId, orderedIds };
      }
    } else if (operation.op === "boolean") {
      const nodeIds = resolveIds(operation.nodeIds, refs); if (!nodeIds) return failure(index, "not_found", "Unknown temporary node reference.");
      request = { kind: "boolean", nodeIds, op: operation.opName }; ref = operation.ref;
    } else if (operation.op === "page") { request = { kind: "page", ...(operation.name !== undefined ? { name: operation.name } : {}) }; ref = operation.ref;
    } else if (operation.op === "connector") {
      const connector = resolveConnector(operation.connector, refs);
      if (!connector) return failure(index, "not_found", "Unknown temporary connector target reference.");
      const geometry = connectorGeometry(next, connector);
      const location = resolveCreationLocation(next, operation.pageId, operation.parentId, refs);
      if (!location.ok) return failure(index, location.code, location.message, location.code === "invalid_request");
      request = { kind: "create", node: { type: "vector", name: "Connector", x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height, vectorNetwork: geometry.network, connector, style: { stroke: operation.stroke ?? { color: "#0f172a", width: 2, cap: "round", join: "round" } } }, ...(location.pageId ? { pageId: location.pageId } : {}), ...(location.parentId !== undefined ? { parentId: location.parentId } : {}) }; ref = operation.ref;
    } else if (operation.op === "connector-update") {
      const nodeId = resolve(operation.nodeId, refs); if (!nodeId) return failure(index, "not_found", "Unknown temporary node reference.");
      const patch = resolveConnectorPatch(operation.patch, refs);
      if (!patch) return failure(index, "not_found", "Unknown temporary connector target reference.");
      request = { kind: "connector", nodeId, patch };
    } else return failure(index, "invalid_request", "Unsupported operation.", true);
    if (ref && (!ref.startsWith("$") || refs.has(ref))) return failure(index, "duplicate_ref", "Temporary refs must be unique names beginning with $.", true);
    const result = applyDesignTransaction(next, request);
    if (!result.ok) return failure(
      index,
      result.error.code === "not_found" ? "not_found" : "invalid_request",
      result.error.message,
      result.error.code === "invalid_request",
      `/operations/${index}${result.error.path ? `/${result.error.path.replaceAll(".", "/").replaceAll("[", "/").replaceAll("]", "")}` : ""}`,
    );
    next = result.document;
    applied ||= result.receipt.outcome === "applied";
    if (result.receipt.outcome === "applied") actionKinds.add(operation.op);
    result.receipt.changedNodeIds.forEach((id) => changedNodeIds.add(id));
    result.receipt.changedPageIds?.forEach((id) => changedPageIds.add(id));
    if (ref) {
      const id = request.kind === "page" ? result.receipt.changedPageIds?.[0] : result.receipt.changedNodeIds[0];
      if (!id) return failure(index, "invalid_request", "A temporary ref requires an operation that creates an outcome.");
      refs.set(ref, id);
      refKinds.set(ref, request.kind === "page" ? "page" : "node");
    }
  }
  const actionSummary = [...actionKinds].slice(0, 4).join(", ");
  const summary = applied
    ? `${actionSummary}${actionKinds.size > 4 ? " and more" : ""}; changed ${changedNodeIds.size} node${changedNodeIds.size === 1 ? "" : "s"} and ${changedPageIds.size} page${changedPageIds.size === 1 ? "" : "s"}.`
    : "No durable changes; the requested state already matched.";
  const receipt: EditOpenDesignReceipt = { idempotencyKey: typedArgs.idempotencyKey, outcome: applied ? "applied" : "noop", changedNodeHandles: [...changedNodeIds].map(designNodeHandle), changedPageHandles: [...changedPageIds].map(designPageHandle), createdRefs: Object.fromEntries([...refs].map(([ref, id]) => [ref, refKinds.get(ref) === "page" ? designPageHandle(id) : designNodeHandle(id)])), summary };
  const result: Extract<EditOpenDesignResult, { ok: true }> = { ok: true, document: next, receipt };
  store?.put(typedArgs.idempotencyKey, { fingerprint, result });
  return result;
}
