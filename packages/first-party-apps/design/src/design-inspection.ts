/**
 * Canonical, renderer-neutral inspection for an already parsed Design document.
 *
 * This is deliberately a document-model API: it neither knows about an open
 * surface nor emits DOM/SVG identifiers.  The live-session tool layer owns
 * authorization, versions, and transport; it can use this module to turn the
 * canonical scene into a complete, cursor-paged public view.
 */

import {
  type ConnectorEndpoint,
  type DesignDocument,
  type DesignFill,
  type DesignNode,
  type DesignNodeKind,
  type DesignStroke,
} from "./scene-graph";
import {
  commandsFromVectorNetwork,
  type VectorPathCommand,
} from "./vector";
import { nodeVisualBounds } from "./geometry";
import { inferVectorPrimitive, type PrimitiveTool } from "./editor/primitives";

const NODE_HANDLE_PREFIX = "node:";
const PAGE_HANDLE_PREFIX = "page:";
const CURSOR_VERSION = 1;

/**
 * A response may contain up to this many *small inspection items*.  The limit
 * bounds one tool response, rather than imposing a scene-size limit: callers
 * can always follow `nextCursor` until `completeness` is `"complete"`.
 */
export const MAX_INSPECTION_PAGE_SIZE = 2_048;

export type PublicNodeHandle = string;

export const DESIGN_SEMANTIC_PROPERTY_GROUPS = [
  "name",
  "geometry",
  "appearance",
  "text",
  "connector",
  "structure",
] as const;
export type DesignSemanticPropertyGroup = typeof DESIGN_SEMANTIC_PROPERTY_GROUPS[number];

export type DesignInspectionBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DesignAppearanceFilter = {
  hasFill?: boolean;
  hasStroke?: boolean;
  hasRadius?: boolean;
  hasText?: boolean;
};

export type DesignInspectionFilters = {
  /** Public page handle, as published on page inspection items. */
  pageHandle?: string;
  /** `null` means top-level nodes. Omit to inspect every parent. */
  parentHandle?: PublicNodeHandle | null;
  nodeHandle?: PublicNodeHandle;
  /** Selection is supplied by the active surface, never inferred from DOM. */
  selectedNodeHandles?: readonly PublicNodeHandle[];
  nodeTypes?: readonly DesignNodeKind[];
  /** Intersects this model-coordinate document-space rectangle. */
  intersects?: DesignInspectionBounds;
  appearance?: DesignAppearanceFilter;
  connector?: "only" | "exclude";
};

export type InspectOpenDesignOptions = DesignInspectionFilters & {
  /** Include vector paths as separately paged local-coordinate commands. */
  includeGeometry?: boolean;
  /** Opaque cursor returned by a prior call against the same scene and filters. */
  cursor?: string;
  /** Caller-selected response bound; defaults to the safe response maximum. */
  pageSize?: number;
};

export type PublicDesignConnectorEndpoint = {
  x: number;
  y: number;
  targetHandle?: PublicNodeHandle;
  anchor?: { x: number; y: number };
  detachedFromHandle?: PublicNodeHandle;
};

export type PublicDesignInspectionNode = {
  kind: "node";
  handle: PublicNodeHandle;
  pageHandle: string | null;
  orphaned: boolean;
  type: DesignNodeKind;
  /** Creation vocabulary recovered from unchanged canonical vector geometry. */
  primitive?: PrimitiveTool;
  name: string;
  parentHandle: PublicNodeHandle | null;
  childHandles: PublicNodeHandle[];
  /** Opaque whole-node precondition copied into a later semantic edit. */
  semanticVersion: string;
  bounds: DesignInspectionBounds;
  rotation?: number;
  skewX?: number;
  flipX?: boolean;
  assetRef?: string;
  hidden?: boolean;
  locked?: boolean;
  appearance: {
    fills?: DesignFill[];
    stroke?: DesignStroke;
    strokeDisabled?: boolean;
    opacity?: number;
    radius?: number;
    radiusY?: number;
    color?: string;
  };
  text?: {
    content: string;
    fontSize?: number;
    lineHeight?: number;
    fontStretch?: number;
    textWrap?: boolean;
    fontFamily?: string;
    fontWeight?: string | number;
    textAlign?: "left" | "center" | "right";
  };
  connector?: {
    route: "straight" | "elbow";
    start: PublicDesignConnectorEndpoint;
    end: PublicDesignConnectorEndpoint;
    startArrow: boolean;
    endArrow: boolean;
  };
  vector?:
    | { geometryCompleteness: "complete"; pathCommandCount: number }
    | {
        geometryCompleteness: "unavailable";
        pathCommandCount: 0;
        geometryOmittedReason: "zero_width" | "zero_height" | "zero_width_and_height";
      };
};

/** A command uses the exact normalized coordinate contract accepted by Pen edits. */
export type PublicDesignPathCommand = {
  kind: "path-command";
  nodeHandle: PublicNodeHandle;
  commandIndex: number;
  coordinateSpace: "node-local-normalized";
  command: VectorPathCommand;
};

export type PublicDesignInspectionPage = {
  kind: "page";
  handle: string;
  name: string;
  topLevelCount: number;
  semanticVersion: string;
};

export type PublicDesignInspectionItem =
  | PublicDesignInspectionPage
  | PublicDesignInspectionNode
  | PublicDesignPathCommand;

export type InspectOpenDesignResult =
  | {
      ok: true;
      pageCount: number;
      sourceNodeCount: number;
      matchedNodeCount: number;
      total: number;
      returned: number;
      omitted: number;
      completeness: "complete" | "partial";
      items: PublicDesignInspectionItem[];
      nextCursor?: string;
      /** Separate active-surface selection after canonical handle validation. */
      selectedNodeHandles: PublicNodeHandle[];
      missingSelectedNodeHandles: PublicNodeHandle[];
    }
  | {
      ok: false;
      code: "invalid_filter" | "invalid_cursor" | "stale_cursor";
      message: string;
    };

type SceneNode = { node: DesignNode; pageId: string | null; orphaned: boolean };
type CursorPayload = { version: number; fingerprint: string; offset: number };

export function designNodeHandle(nodeId: string): PublicNodeHandle {
  return `${NODE_HANDLE_PREFIX}${encodeURIComponent(nodeId)}`;
}

export function designPageHandle(pageId: string): string {
  return `${PAGE_HANDLE_PREFIX}${encodeURIComponent(pageId)}`;
}

export function nodeIdFromDesignHandle(handle: unknown): string | null {
  if (typeof handle !== "string" || !handle.startsWith(NODE_HANDLE_PREFIX)) return null;
  const encoded = handle.slice(NODE_HANDLE_PREFIX.length);
  if (encoded.length === 0) return null;
  try {
    const nodeId = decodeURIComponent(encoded);
    return nodeId.length > 0 ? nodeId : null;
  } catch {
    return null;
  }
}

export function pageIdFromDesignHandle(handle: unknown): string | null {
  if (typeof handle !== "string" || !handle.startsWith(PAGE_HANDLE_PREFIX)) return null;
  const encoded = handle.slice(PAGE_HANDLE_PREFIX.length);
  if (encoded.length === 0) return null;
  try {
    const pageId = decodeURIComponent(encoded);
    return pageId.length > 0 ? pageId : null;
  } catch {
    return null;
  }
}

function cloneFills(fills: readonly DesignFill[]): DesignFill[] {
  return fills.map((fill) => ({ ...fill }));
}

function cloneStroke(stroke: DesignStroke): DesignStroke {
  return { ...stroke, ...(stroke.dash ? { dash: [...stroke.dash] } : {}) };
}

function publicEndpoint(endpoint: ConnectorEndpoint): PublicDesignConnectorEndpoint {
  return {
    x: endpoint.x,
    y: endpoint.y,
    ...(endpoint.targetId ? { targetHandle: designNodeHandle(endpoint.targetId) } : {}),
    ...(endpoint.anchor ? { anchor: { ...endpoint.anchor } } : {}),
    ...(endpoint.detachedFromTargetId
      ? { detachedFromHandle: designNodeHandle(endpoint.detachedFromTargetId) }
      : {}),
  };
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

/** Synchronous, browser-bundle-safe SHA-256 for deterministic semantic tokens. */
function sha256Hex(source: string): string {
  const sourceBytes = new TextEncoder().encode(source);
  const paddedLength = Math.ceil((sourceBytes.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(sourceBytes);
  bytes[sourceBytes.length] = 0x80;
  const view = new DataView(bytes.buffer);
  const bitLength = sourceBytes.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index++) {
      const previous15 = words[index - 15]!;
      const previous2 = words[index - 2]!;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temporary1 = (h! + sum1 + choice + SHA256_CONSTANTS[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temporary2 = (sum0 + majority) >>> 0;
      [a, b, c, d, e, f, g, h] = [(temporary1 + temporary2) >>> 0, a, b, c, (d! + temporary1) >>> 0, e, f, g];
    }
    state[0] = (state[0]! + a!) >>> 0;
    state[1] = (state[1]! + b!) >>> 0;
    state[2] = (state[2]! + c!) >>> 0;
    state[3] = (state[3]! + d!) >>> 0;
    state[4] = (state[4]! + e!) >>> 0;
    state[5] = (state[5]! + f!) >>> 0;
    state[6] = (state[6]! + g!) >>> 0;
    state[7] = (state[7]! + h!) >>> 0;
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("");
}

function semanticFingerprint(value: unknown): string {
  return `s1:${sha256Hex(stableStringify(value))}`;
}

export function semanticVersionForNode(node: DesignNode, document?: DesignDocument): string {
  if (!document || node.childIds.length === 0) return semanticFingerprint(node);
  const descendants: DesignNode[] = [];
  const pending = [...node.childIds];
  const seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    const child = document.nodes[id];
    if (!child || seen.has(id)) continue;
    seen.add(id); descendants.push(child); pending.push(...child.childIds);
  }
  return semanticFingerprint({ node, descendants });
}

export function semanticVersionForPage(page: { id: string; name: string; children: string[] }): string {
  return semanticFingerprint(page);
}

function normalizedPathCommands(node: DesignNode): VectorPathCommand[] | null {
  if (!node.vectorNetwork || node.width === 0 || node.height === 0) return null;
  return commandsFromVectorNetwork(node.vectorNetwork).map((command): VectorPathCommand => {
    if (command.kind === "M" || command.kind === "L") {
      return { ...command, x: command.x / node.width, y: command.y / node.height };
    }
    if (command.kind === "C") {
      return {
        ...command,
        c1x: command.c1x / node.width,
        c1y: command.c1y / node.height,
        c2x: command.c2x / node.width,
        c2y: command.c2y / node.height,
        x: command.x / node.width,
        y: command.y / node.height,
      };
    }
    return command;
  });
}

function publicVector(node: DesignNode): PublicDesignInspectionNode["vector"] {
  if (!node.vectorNetwork) return undefined;
  const commands = normalizedPathCommands(node);
  if (commands) return { geometryCompleteness: "complete", pathCommandCount: commands.length };
  const geometryOmittedReason = node.width === 0 && node.height === 0
    ? "zero_width_and_height"
    : node.width === 0
      ? "zero_width"
      : "zero_height";
  return { geometryCompleteness: "unavailable", pathCommandCount: 0, geometryOmittedReason };
}

function publicNode(sceneNode: SceneNode, document: DesignDocument): PublicDesignInspectionNode {
  const { node, pageId, orphaned } = sceneNode;
  const vector = publicVector(node);
  const primitive = node.type === "vector" && node.vectorNetwork
    ? inferVectorPrimitive(node.vectorNetwork, node.width, node.height)
    : null;
  return {
    kind: "node",
    handle: designNodeHandle(node.id),
    pageHandle: pageId === null ? null : designPageHandle(pageId),
    orphaned,
    type: node.type,
    ...(primitive === null ? {} : { primitive }),
    name: node.name,
    parentHandle: node.parentId === null ? null : designNodeHandle(node.parentId),
    childHandles: node.childIds.map(designNodeHandle),
    semanticVersion: semanticVersionForNode(node, document),
    bounds: { x: node.x, y: node.y, width: node.width, height: node.height },
    ...(node.rotation === undefined ? {} : { rotation: node.rotation }),
    ...(node.skewX === undefined ? {} : { skewX: node.skewX }),
    ...(node.flipX === undefined ? {} : { flipX: node.flipX }),
    ...(node.assetRef === undefined ? {} : { assetRef: node.assetRef }),
    ...(node.hidden === undefined ? {} : { hidden: node.hidden }),
    ...(node.locked === undefined ? {} : { locked: node.locked }),
    appearance: {
      ...(node.strokeDisabled === undefined ? {} : { strokeDisabled: node.strokeDisabled }),
      ...(node.fills === undefined ? {} : { fills: cloneFills(node.fills) }),
      ...(node.stroke === undefined ? {} : { stroke: cloneStroke(node.stroke) }),
      ...(node.opacity === undefined ? {} : { opacity: node.opacity }),
      ...(node.radius === undefined ? {} : { radius: node.radius }),
      ...(node.radiusY === undefined ? {} : { radiusY: node.radiusY }),
      ...(node.color === undefined ? {} : { color: node.color }),
    },
    ...(node.text === undefined
      ? {}
      : {
          text: {
            content: node.text,
            ...(node.fontSize === undefined ? {} : { fontSize: node.fontSize }),
        ...(node.lineHeight === undefined ? {} : { lineHeight: node.lineHeight }),
        ...(node.fontStretch === undefined ? {} : { fontStretch: node.fontStretch }),
        ...(node.textWrap === undefined ? {} : { textWrap: node.textWrap }),
            ...(node.fontFamily === undefined ? {} : { fontFamily: node.fontFamily }),
            ...(node.fontWeight === undefined ? {} : { fontWeight: node.fontWeight }),
            ...(node.textAlign === undefined ? {} : { textAlign: node.textAlign }),
          },
        }),
    ...(node.connector
      ? {
          connector: {
            route: node.connector.route,
            start: publicEndpoint(node.connector.start),
            end: publicEndpoint(node.connector.end),
            startArrow: node.connector.startArrow ?? false,
            endArrow: node.connector.endArrow ?? false,
          },
        }
      : {}),
    ...(vector ? { vector } : {}),
  };
}

function intersects(a: DesignInspectionBounds, b: DesignInspectionBounds): boolean {
  return a.x <= b.x + b.width
    && a.x + a.width >= b.x
    && a.y <= b.y + b.height
    && a.y + a.height >= b.y;
}

function appearanceMatches(node: DesignNode, filter: DesignAppearanceFilter): boolean {
  return (filter.hasFill === undefined || (node.fills?.length ?? 0) > 0 === filter.hasFill)
    && (filter.hasStroke === undefined || (node.stroke !== undefined) === filter.hasStroke)
    && (filter.hasRadius === undefined || (node.radius !== undefined) === filter.hasRadius)
    && (filter.hasText === undefined || (node.text !== undefined) === filter.hasText);
}

function orderedSceneNodes(doc: DesignDocument): SceneNode[] {
  const result: SceneNode[] = [];
  const visited = new Set<string>();

  const walk = (nodeId: string, pageId: string | null, orphaned: boolean): void => {
    if (visited.has(nodeId)) return;
    const node = doc.nodes[nodeId];
    if (!node) return;
    visited.add(nodeId);
    result.push({ node, pageId, orphaned });
    for (const childId of node.childIds) walk(childId, pageId, orphaned);
  };

  for (const page of doc.pages) {
    for (const nodeId of page.children) walk(nodeId, page.id, false);
  }
  // A parsed document is expected to be a well-formed scene.  Still, inspect
  // every canonical node rather than silently hiding an unattached record.
  for (const nodeId of Object.keys(doc.nodes).sort()) walk(nodeId, null, true);
  return result;
}

function normalizeNodeTypeFilter(value: readonly DesignNodeKind[] | undefined): Set<DesignNodeKind> | null {
  if (!value) return null;
  return new Set(value);
}

function validateBounds(bounds: DesignInspectionBounds | undefined): string | null {
  if (!bounds) return null;
  for (const key of ["x", "y", "width", "height"] as const) {
    if (!Number.isFinite(bounds[key])) return `intersects.${key} must be finite`;
  }
  if (bounds.width < 0 || bounds.height < 0) return "intersects.width and intersects.height must be non-negative";
  return null;
}

function normalizeSelection(
  doc: DesignDocument,
  selected: readonly PublicNodeHandle[] | undefined,
): { selectedNodeHandles: PublicNodeHandle[]; missingSelectedNodeHandles: PublicNodeHandle[]; selectedIds: Set<string> } | null {
  const selectedNodeHandles: PublicNodeHandle[] = [];
  const missingSelectedNodeHandles: PublicNodeHandle[] = [];
  const selectedIds = new Set<string>();
  for (const handle of selected ?? []) {
    const id = nodeIdFromDesignHandle(handle);
    if (!id) return null;
    if (doc.nodes[id]) {
      if (!selectedIds.has(id)) selectedNodeHandles.push(designNodeHandle(id));
      selectedIds.add(id);
    } else if (!missingSelectedNodeHandles.includes(handle)) {
      missingSelectedNodeHandles.push(handle);
    }
  }
  return { selectedNodeHandles, missingSelectedNodeHandles, selectedIds };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** Fast deterministic fingerprinting for cursor staleness, not a security hash. */
function fingerprint(value: unknown): string {
  const source = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function encodeCursor(payload: CursorPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) return null;
    const padded = cursor.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((cursor.length + 3) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (value["version"] !== CURSOR_VERSION || typeof value["fingerprint"] !== "string"
      || !Number.isSafeInteger(value["offset"]) || (value["offset"] as number) < 0) return null;
    return { version: CURSOR_VERSION, fingerprint: value["fingerprint"], offset: value["offset"] as number };
  } catch {
    return null;
  }
}

function pageSizeFor(value: number | undefined): number | null {
  if (value === undefined) return MAX_INSPECTION_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_INSPECTION_PAGE_SIZE) return null;
  return value;
}

function normalizedFilterForCursor(
  options: InspectOpenDesignOptions,
  selectedIds: Set<string>,
): Record<string, unknown> {
  return {
    pageId: pageIdFromDesignHandle(options.pageHandle) ?? null,
    parentHandle: options.parentHandle ?? "__omitted__",
    nodeHandle: options.nodeHandle ?? null,
    selectedNodeIds: [...selectedIds].sort(),
    nodeTypes: [...(options.nodeTypes ?? [])].sort(),
    intersects: options.intersects ?? null,
    appearance: options.appearance ?? null,
    connector: options.connector ?? null,
    includeGeometry: options.includeGeometry === true,
  };
}

/**
 * Inspect the canonical document in page/tree order.  Pagination never hides
 * data: `total`, `omitted`, `completeness`, and `nextCursor` make every partial
 * response explicit, including path commands for large Pen/vector paths.
 */
export function inspectOpenDesign(
  doc: DesignDocument,
  options: InspectOpenDesignOptions = {},
): InspectOpenDesignResult {
  const size = pageSizeFor(options.pageSize);
  if (!size) return { ok: false, code: "invalid_filter", message: `pageSize must be an integer from 1 to ${MAX_INSPECTION_PAGE_SIZE}` };
  const boundsError = validateBounds(options.intersects);
  if (boundsError) return { ok: false, code: "invalid_filter", message: boundsError };
  if (options.connector !== undefined && options.connector !== "only" && options.connector !== "exclude") {
    return { ok: false, code: "invalid_filter", message: 'connector must be "only" or "exclude"' };
  }
  const pageId = options.pageHandle === undefined ? undefined : pageIdFromDesignHandle(options.pageHandle);
  if (options.pageHandle !== undefined && (pageId === null || !doc.pages.some((page) => page.id === pageId))) {
    return { ok: false, code: "invalid_filter", message: "pageHandle must identify a page in this document" };
  }
  const parentId = options.parentHandle === undefined
    ? undefined
    : options.parentHandle === null
      ? null
      : nodeIdFromDesignHandle(options.parentHandle);
  if (options.parentHandle !== undefined && options.parentHandle !== null && parentId === null) {
    return { ok: false, code: "invalid_filter", message: "parentHandle must be a public Design node handle or null" };
  }
  const nodeId = options.nodeHandle === undefined ? undefined : nodeIdFromDesignHandle(options.nodeHandle);
  if (nodeId === null || (nodeId !== undefined && !doc.nodes[nodeId])) {
    return { ok: false, code: "invalid_filter", message: "nodeHandle must identify a node in this document" };
  }
  const selection = normalizeSelection(doc, options.selectedNodeHandles);
  if (!selection) return { ok: false, code: "invalid_filter", message: "selectedNodeHandles must contain public Design node handles" };

  const nodeTypes = normalizeNodeTypeFilter(options.nodeTypes);
  const filtersRequireNodes = options.parentHandle !== undefined
    || options.nodeHandle !== undefined
    || options.selectedNodeHandles !== undefined
    || options.nodeTypes !== undefined
    || options.intersects !== undefined
    || options.appearance !== undefined
    || options.connector !== undefined;
  const sceneNodes = orderedSceneNodes(doc).filter(({ node, pageId: nodePageId }) =>
    (pageId === undefined || pageId === nodePageId)
    && (parentId === undefined || node.parentId === parentId)
    && (nodeId === undefined || node.id === nodeId)
    && (options.selectedNodeHandles === undefined || selection.selectedIds.has(node.id))
    && (nodeTypes === null || nodeTypes.has(node.type))
    && (options.intersects === undefined || intersects(
      (() => { const bounds = nodeVisualBounds(node); return { x: bounds.minX, y: bounds.minY, width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY }; })(),
      options.intersects,
    ))
    && (options.appearance === undefined || appearanceMatches(node, options.appearance))
    && (options.connector === undefined
      || (options.connector === "only" ? node.connector !== undefined : node.connector === undefined)),
  );

  const items: PublicDesignInspectionItem[] = [];
  if (!filtersRequireNodes) {
    for (const page of doc.pages) {
      if (pageId === undefined || page.id === pageId) {
        items.push({
          kind: "page",
          handle: designPageHandle(page.id),
          name: page.name,
          topLevelCount: page.children.length,
          semanticVersion: semanticVersionForPage(page),
        });
      }
    }
  }
  for (const sceneNode of sceneNodes) {
    items.push(publicNode(sceneNode, doc));
    const commands = options.includeGeometry
      ? normalizedPathCommands(sceneNode.node)
      : null;
    if (commands) {
      const nodeHandle = designNodeHandle(sceneNode.node.id);
      for (const [commandIndex, command] of commands.entries()) {
        items.push({ kind: "path-command", nodeHandle, commandIndex, coordinateSpace: "node-local-normalized", command: { ...command } });
      }
    }
  }

  const cursorFingerprint = fingerprint({
    document: doc,
    filter: normalizedFilterForCursor(options, selection.selectedIds),
  });
  let offset = 0;
  if (options.cursor !== undefined) {
    const cursor = decodeCursor(options.cursor);
    if (!cursor) return { ok: false, code: "invalid_cursor", message: "cursor is malformed" };
    if (cursor.fingerprint !== cursorFingerprint) return { ok: false, code: "stale_cursor", message: "cursor does not match this document state or filter" };
    if (cursor.offset > items.length) return { ok: false, code: "invalid_cursor", message: "cursor offset is outside this result" };
    offset = cursor.offset;
  }

  const responseItems = items.slice(offset, offset + size);
  const nextOffset = offset + responseItems.length;
  const omitted = items.length - nextOffset;
  return {
    ok: true,
    pageCount: doc.pages.length,
    sourceNodeCount: Object.keys(doc.nodes).length,
    matchedNodeCount: sceneNodes.length,
    total: items.length,
    returned: responseItems.length,
    omitted,
    completeness: omitted === 0 ? "complete" : "partial",
    items: responseItems,
    ...(omitted === 0 ? {} : { nextCursor: encodeCursor({ version: CURSOR_VERSION, fingerprint: cursorFingerprint, offset: nextOffset }) }),
    selectedNodeHandles: selection.selectedNodeHandles,
    missingSelectedNodeHandles: selection.missingSelectedNodeHandles,
  };
}
