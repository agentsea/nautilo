/**
 * Headless server-side agent tools for the Nautilo Design mini-app.
 *
 * Uses the shared `ServerNautiloAppHost` / `AgentToolContext` contract and the
 * read→mutate→write-back flow with baseSha256/baseRevision and the
 * saved/conflict/error result taxonomy used by first-party document apps.
 *
 * No filesystem, network, child process, or env-variable access. All mutation
 * happens by parsing the persisted `.design.html`, transforming the
 * renderer-neutral scene graph, and writing back a freshly serialized
 * document.
 */

import {
  assertSafeObjectKeys,
  findNode,
  findPage,
  firstPageId,
  isDesignNodeKind,
  type DesignDocument,
  type DesignFill,
  type DesignNode,
  type DesignNodeKind,
  type DesignStroke,
  type DesignTextAlign,
} from "./scene-graph";
import {
  applyDesignTransaction,
  type CreateTransaction,
  type DesignTransactionRequest,
  type GeometryPatch,
  type StylePatch,
  type TextPatch,
} from "./transactions";
import {
  parseDesignHtml,
  renderSceneSvg,
  serializeDesignHtml,
  UnsupportedImageSourceError,
  type DesignHtmlDocument,
  type DesignHtmlManifest,
} from "./design-document";
import {
  designNodeHandle,
  designPageHandle,
  inspectOpenDesign as inspectCanonicalOpenDesign,
  MAX_INSPECTION_PAGE_SIZE,
  nodeIdFromDesignHandle,
  pageIdFromDesignHandle,
  type InspectOpenDesignOptions,
} from "./design-inspection";
import {
  designOperationFingerprint,
  editOpenDesign as applyOpenDesignOperations,
  type DesignIdempotencyMetadata,
  type DesignOperation,
  type DesignSemanticPropertyGroup,
  type EditOpenDesignReceipt,
} from "./design-operations";

export type AppDocumentTarget =
  | { surface: "workspace"; path: string }
  | { surface: "currentFolder"; relativePath: string };

export type ServerNautiloAppHost = {
  assets?: { inspect(input: { artifactId: string }): Promise<{ ok: true; ref: string; name: string; width: number; height: number } | { ok: false; code: string; message: string }> };
  document: {
    createFromAction(
      actionId: string,
      opts: {
        targetSurface: "workspace" | "currentFolder";
        filename: string;
        openAfterCreate?: boolean;
      },
    ): Promise<{
      target: AppDocumentTarget;
      displayPath: string;
      opened: boolean;
    }>;
    read(target: AppDocumentTarget): Promise<{
      content: string;
      mimeType: string | null;
      displayPath: string;
      baseSha256: string | null;
      baseRevision: number | null;
    }>;
    write(
      target: AppDocumentTarget,
      next: { content: string },
      opts?: { baseSha256?: string | null; baseRevision?: number | null },
    ): Promise<
      | { kind: "saved"; sha256: string; revision?: number | null; size?: number }
      | { kind: "conflict"; currentSha256: string | null }
      | { kind: "error"; message: string }
    >;
    /** Available only to a server-validated direct live-mutation tool turn. */
    writeBound(next: { content: string }): Promise<
      | { kind: "saved"; sha256: string; revision?: number | null; size?: number }
      | { kind: "conflict"; currentSha256: string | null }
      | { kind: "error"; message: string }
    >;
    /**
     * Create a conversion result directly. This is deliberately distinct
     * from `write`, which can only update the document bound to a tool turn.
     */
    createDocument(args: {
      surface: "workspace" | "currentFolder";
      path: string;
      content: string;
      mimeType?: string;
      colocateWith?: { surface: "workspace"; path: string };
      overwrite?: boolean;
    }): Promise<
      | { ok: true; artifactPath: string; sha256: string; byteLength: number }
      | { ok: false; code: string; message: string; displayPath?: string; bytesWritten?: number; metadataConfirmed?: false; stateChanged?: true; retrySafe?: false }
    >;
    createRasterFromSvg(args: {
      surface: "workspace" | "currentFolder";
      path: string;
      svg: string;
      format: "png";
      colocateWith?: { surface: "workspace"; path: string };
      overwrite?: boolean;
    }): Promise<
      | { ok: true; artifactPath: string; sha256: string; byteLength: number }
      | { ok: false; code: string; message: string; displayPath?: string; bytesWritten?: number; metadataConfirmed?: false; stateChanged?: true; retrySafe?: false }
    >;
  };
};

export type AgentToolContext = {
  nautiloApp: ServerNautiloAppHost;
};

type ToolError = { ok: false; error: string };
type ParsedDocument = { ok: true; document: DesignHtmlDocument };
type LiveDocumentVersion =
  | { kind: "artifact_revision"; revision: number }
  | { kind: "local_sha"; sha256: string };

type LiveDesignBase = {
  documentVersion: LiveDocumentVersion;
  canonicalContent: string;
  record: Record<string, unknown>;
};

function toolError(message: string): ToolError {
  return { ok: false, error: message };
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function validateBasenameFilename(filename: unknown): string | null {
  if (typeof filename !== "string" || filename.trim().length === 0) {
    return "filename must be a non-empty basename";
  }
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename === "." ||
    filename === ".."
  ) {
    return "filename must be a basename without path separators";
  }
  if (/^[A-Za-z]:[\\/]/.test(filename)) {
    return "filename must not be an absolute path";
  }
  if (hasControlChars(filename)) {
    return "filename must not contain control characters";
  }
  return null;
}

export function validateAppDocumentTarget(
  target: unknown,
): { ok: true; target: AppDocumentTarget } | ToolError {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return toolError("target must be an object");
  }
  const record = target as Record<string, unknown>;
  if (record["surface"] === "workspace") {
    if (typeof record["path"] !== "string" || record["path"].trim().length === 0) {
      return toolError("target.path is required for workspace surface");
    }
    return { ok: true, target: { surface: "workspace", path: record["path"].trim() } };
  }
  if (record["surface"] === "currentFolder") {
    if (typeof record["relativePath"] !== "string" || record["relativePath"].trim().length === 0) {
      return toolError("target.relativePath is required for currentFolder surface");
    }
    const relativePath = record["relativePath"].trim();
    if (
      relativePath.includes("..") ||
      relativePath.startsWith("/") ||
      relativePath.startsWith("\\") ||
      hasControlChars(relativePath)
    ) {
      return toolError("target.relativePath must be a safe relative path");
    }
    return { ok: true, target: { surface: "currentFolder", relativePath } };
  }
  return toolError('target.surface must be "workspace" or "currentFolder"');
}

function parseDocument(content: string): ParsedDocument | ToolError {
  const parsed = parseDesignHtml(content);
  if (!parsed.ok) return toolError(parsed.error);
  return { ok: true, document: parsed.document };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LOCAL_SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Package-local mirror of the host's two live-version wire shapes. Agent tool
 * bundles are copied out of the workspace when first-party apps are seeded,
 * so this security-boundary parser must remain dependency-free.
 */
function parseLiveDocumentVersion(value: unknown): LiveDocumentVersion | null {
  if (!isRecord(value)) return null;
  if (value["kind"] === "artifact_revision") {
    if (
      Object.keys(value).length !== 2 ||
      !Number.isSafeInteger(value["revision"]) ||
      (value["revision"] as number) < 0
    ) {
      return null;
    }
    return { kind: "artifact_revision", revision: value["revision"] as number };
  }
  if (value["kind"] === "local_sha") {
    if (
      Object.keys(value).length !== 2 ||
      typeof value["sha256"] !== "string" ||
      !LOCAL_SHA256_HEX_RE.test(value["sha256"])
    ) {
      return null;
    }
    return { kind: "local_sha", sha256: value["sha256"] };
  }
  return null;
}

function unknownKey(
  record: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  return Object.keys(record).find((key) => !allowed.includes(key)) ?? null;
}

function parseLiveDesignBase(
  args: unknown,
  allowedPublicKeys: readonly string[],
): LiveDesignBase | ToolError {
  if (!isRecord(args)) return toolError("live Design session is unavailable");
  const extra = unknownKey(args, [
    ...allowedPublicKeys,
    // Injected only after the server validates the opaque session and version.
    "__canonicalContent",
  ]);
  if (extra) return toolError(`unknown field ${extra}`);
  const sessionToken = args["sessionToken"];
  if (
    typeof sessionToken !== "string" ||
    sessionToken.length < 1 ||
    sessionToken.length > 256
  ) {
    return toolError("sessionToken must be an opaque non-empty token");
  }
  const documentVersion = parseLiveDocumentVersion(args["documentVersion"]);
  if (!documentVersion) {
    return toolError("documentVersion must be a supported live document version");
  }
  if (typeof args["__canonicalContent"] !== "string") {
    return toolError("live Design session is unavailable");
  }
  return {
    documentVersion,
    canonicalContent: args["__canonicalContent"],
    record: args,
  };
}

const INSPECT_OPEN_DESIGN_KEYS = [
  "sessionToken",
  "documentVersion",
  "pageHandle",
  "parentHandle",
  "nodeHandle",
  "selectedNodeHandles",
  "nodeTypes",
  "intersects",
  "appearance",
  "connector",
  "includeGeometry",
  "cursor",
  "pageSize",
] as const;

const DESIGN_NODE_TYPES = new Set<DesignNodeKind>([
  "frame",
  "text",
  "rectangle",
  "image",
  "group",
  "vector",
]);

function optionalBoundedString(
  record: Record<string, unknown>,
  field: string,
  maxLength: number,
): string | undefined | ToolError {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    return toolError(`${field} must be a bounded non-empty string`);
  }
  return value;
}

function parseInspectionOptions(
  record: Record<string, unknown>,
): InspectOpenDesignOptions | ToolError {
  const pageHandle = optionalBoundedString(record, "pageHandle", 512);
  if (isRecord(pageHandle) && "error" in pageHandle) return pageHandle;
  const nodeHandle = optionalBoundedString(record, "nodeHandle", 512);
  if (isRecord(nodeHandle) && "error" in nodeHandle) return nodeHandle;
  const cursor = optionalBoundedString(record, "cursor", 4096);
  if (isRecord(cursor) && "error" in cursor) return cursor;

  let parentHandle: string | null | undefined;
  if (record["parentHandle"] !== undefined) {
    if (record["parentHandle"] === null) parentHandle = null;
    else {
      const parsed = optionalBoundedString(record, "parentHandle", 512);
      if (isRecord(parsed) && "error" in parsed) return parsed;
      parentHandle = parsed;
    }
  }

  let selectedNodeHandles: string[] | undefined;
  if (record["selectedNodeHandles"] !== undefined) {
    const value = record["selectedNodeHandles"];
    if (
      !Array.isArray(value) ||
      value.length > 256 ||
      !value.every((entry) =>
        typeof entry === "string" && entry.length >= 1 && entry.length <= 512
      )
    ) {
      return toolError("selectedNodeHandles must contain at most 256 node handles");
    }
    selectedNodeHandles = value;
  }

  let nodeTypes: DesignNodeKind[] | undefined;
  if (record["nodeTypes"] !== undefined) {
    const value = record["nodeTypes"];
    if (
      !Array.isArray(value) ||
      value.length > DESIGN_NODE_TYPES.size ||
      !value.every((entry): entry is DesignNodeKind =>
        typeof entry === "string" && DESIGN_NODE_TYPES.has(entry as DesignNodeKind)
      )
    ) {
      return toolError("nodeTypes contains an unsupported Design node type");
    }
    nodeTypes = value;
  }

  let intersects: InspectOpenDesignOptions["intersects"];
  if (record["intersects"] !== undefined) {
    const value = record["intersects"];
    if (!isRecord(value)) return toolError("intersects must be an object");
    const extra = unknownKey(value, ["x", "y", "width", "height"]);
    if (
      extra ||
      !["x", "y", "width", "height"].every((key) =>
        typeof value[key] === "number" && Number.isFinite(value[key])
      )
    ) {
      return toolError(extra ? `intersects has unknown field ${extra}` : "intersects requires finite x, y, width, and height");
    }
    intersects = value as NonNullable<InspectOpenDesignOptions["intersects"]>;
  }

  let appearance: InspectOpenDesignOptions["appearance"];
  if (record["appearance"] !== undefined) {
    const value = record["appearance"];
    if (!isRecord(value)) return toolError("appearance must be an object");
    const extra = unknownKey(value, ["hasFill", "hasStroke", "hasRadius", "hasText"]);
    if (extra) return toolError(`appearance has unknown field ${extra}`);
    for (const key of ["hasFill", "hasStroke", "hasRadius", "hasText"] as const) {
      if (value[key] !== undefined && typeof value[key] !== "boolean") {
        return toolError(`appearance.${key} must be boolean`);
      }
    }
    appearance = value;
  }

  const connector = record["connector"];
  if (connector !== undefined && connector !== "only" && connector !== "exclude") {
    return toolError('connector must be "only" or "exclude"');
  }
  const includeGeometry = record["includeGeometry"];
  if (includeGeometry !== undefined && typeof includeGeometry !== "boolean") {
    return toolError("includeGeometry must be boolean");
  }
  const pageSize = record["pageSize"];
  if (
    pageSize !== undefined &&
    (!Number.isSafeInteger(pageSize) ||
      (pageSize as number) < 1 ||
      (pageSize as number) > MAX_INSPECTION_PAGE_SIZE)
  ) {
    return toolError(`pageSize must be an integer from 1 to ${MAX_INSPECTION_PAGE_SIZE}`);
  }
  return {
    ...(typeof pageHandle === "string" ? { pageHandle } : {}),
    ...(parentHandle !== undefined ? { parentHandle } : {}),
    ...(typeof nodeHandle === "string" ? { nodeHandle } : {}),
    ...(selectedNodeHandles ? { selectedNodeHandles } : {}),
    ...(nodeTypes ? { nodeTypes } : {}),
    ...(intersects ? { intersects } : {}),
    ...(appearance ? { appearance } : {}),
    ...(connector ? { connector } : {}),
    ...(includeGeometry !== undefined ? { includeGeometry } : {}),
    ...(typeof cursor === "string" ? { cursor } : {}),
    ...(typeof pageSize === "number" ? { pageSize } : {}),
  };
}

const CONVERSION_CURRENT_FOLDER_PATH_MAX = 1024;
const CONVERSION_WORKSPACE_PATH_MAX = 4096;

function validateConversionPath(
  surface: unknown,
  value: unknown,
  field: string,
):
  | { ok: true; surface: "workspace" | "currentFolder"; path: string }
  | ToolError {
  if (surface !== "workspace" && surface !== "currentFolder") {
    return toolError(`${field}.surface must be "workspace" or "currentFolder"`);
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return toolError(`${field}.path must be a non-empty string`);
  }
  const path = value.trim();
  const maxLength =
    surface === "workspace"
      ? CONVERSION_WORKSPACE_PATH_MAX
      : CONVERSION_CURRENT_FOLDER_PATH_MAX;
  if (path.length > maxLength) {
    return toolError(`${field}.path length exceeds maximum (${maxLength})`);
  }
  if (hasControlChars(path)) {
    return toolError(`${field}.path must not contain control characters`);
  }
  if (surface === "workspace") {
    if (path.startsWith("/"))
      return toolError(`${field}.path must not start with "/"`);
    if (path.split("/").some((segment) => segment === "..")) {
      return toolError(`${field}.path must not contain ".." segments`);
    }
  } else if (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.split(/[\\/]/).some((segment) => segment === "..")
  ) {
    return toolError(`${field}.path must be a safe relative path`);
  }
  return { ok: true, surface, path };
}

// ----- arg types -----

export type CreateFileArgs = {
  targetSurface: "workspace" | "currentFolder";
  filename: string;
  initialContent?: "empty";
};

export type InspectDocumentArgs = {
  target: AppDocumentTarget;
  pageId?: string;
  nodeId?: string;
  includeNodes?: boolean;
};

export type CreateFrameArgs = {
  target: AppDocumentTarget;
  pageId?: string;
  parentId?: string | null;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fills?: DesignFill[];
  stroke?: DesignStroke;
  radius?: number;
  opacity?: number;
  rotation?: number;
};

export type CreateTextArgs = {
  target: AppDocumentTarget;
  pageId?: string;
  parentId?: string | null;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string | number;
  lineHeight?: number;
  textWrap?: boolean;
  textAlign?: DesignTextAlign;
  color?: string;
  fills?: DesignFill[];
  stroke?: DesignStroke;
  opacity?: number;
  rotation?: number;
};

export type CreateShapeArgs = {
  target: AppDocumentTarget;
  pageId?: string;
  parentId?: string | null;
  name?: string;
  shape: "rectangle";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fills?: DesignFill[];
  stroke?: DesignStroke;
  radius?: number;
  opacity?: number;
  rotation?: number;
};

export type SetNodePropsArgs = {
  target: AppDocumentTarget;
  nodeId: string;
  props: {
    name?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    rotation?: number;
    opacity?: number;
    radius?: number;
    fills?: DesignFill[];
    stroke?: DesignStroke;
    text?: string;
    fontSize?: number;
    fontFamily?: string;
    fontWeight?: string | number;
    lineHeight?: number;
    textWrap?: boolean;
    textAlign?: DesignTextAlign;
    color?: string;
    src?: string;
  };
};

export type ReplaceTextArgs = {
  target: AppDocumentTarget;
  nodeId: string;
  text: string;
};

export type ArrangeNodesArgs = {
  target: AppDocumentTarget;
  parentId: string | null;
  nodeIds: string[];
  pageId?: string;
};

export type LayoutNodesArgs = {
  target: AppDocumentTarget;
  nodeIds: string[];
  operation: "align" | "distribute";
  axis: "horizontal" | "vertical";
  mode?: "start" | "center" | "end";
};

/**
 * The public conversion-runner contract: both locations use a plain `path`
 * because the runner resolves a current-folder path relative to its explicit
 * currentFolder context before it reaches this server handler.
 */
export type ExportSvgArgs = {
  source: { surface: "workspace" | "currentFolder"; path: string };
  target: { surface: "workspace" | "currentFolder"; path: string };
  overwrite?: boolean;
  scope?: { pageHandle: string; nodeHandles?: string[] };
};

// ----- helpers -----

type WriteSuccess = {
  kind: "saved";
  sha256: string;
  revision?: number | null;
};
type WriteResult = WriteSuccess | { kind: "conflict"; currentSha256: string | null } | { kind: "error"; message: string };

type NodeMutationResult =
  | { ok: true; status: "saved"; displayPath: string; nodeId: string; sha256: string; revision?: number | null }
  | { ok: true; status: "noop"; displayPath: string; nodeId: string }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError;

async function writeBack(
  ctx: AgentToolContext,
  target: AppDocumentTarget,
  manifest: DesignHtmlManifest,
  scene: DesignDocument,
  envelope: { baseSha256: string | null; baseRevision: number | null; displayPath: string },
): Promise<
  | { ok: true; write: WriteSuccess; displayPath: string }
  | { ok: true; conflict: { currentSha256: string | null }; displayPath: string }
  | { ok: true; error: { message: string }; displayPath: string }
  | ToolError
> {
  let content: string;
  try {
    content = serializeDesignHtml(manifest, scene, { touchMetadata: true });
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  let writeResult: WriteResult;
  try {
    writeResult = await ctx.nautiloApp.document.write(
      target,
      { content },
      {
        baseSha256: envelope.baseSha256,
        baseRevision: envelope.baseRevision,
      },
    );
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  if (writeResult.kind === "conflict") {
    return {
      ok: true,
      conflict: { currentSha256: writeResult.currentSha256 },
      displayPath: envelope.displayPath,
    };
  }
  if (writeResult.kind === "error") {
    return {
      ok: true,
      error: { message: writeResult.message },
      displayPath: envelope.displayPath,
    };
  }
  return {
    ok: true,
    write: { kind: "saved", sha256: writeResult.sha256, revision: writeResult.revision ?? null },
    displayPath: envelope.displayPath,
  };
}

function resolvePage(doc: DesignDocument, pageId?: string): string | null {
  if (pageId) return findPage(doc, pageId)?.id ?? null;
  return firstPageId(doc);
}

type ResolvedExportScope = {
  pageId: string | undefined;
  nodeIds?: string[];
  /** Canonical handles, generated from the parsed scene rather than reflected request metadata. */
  publicScope?: { pageHandle: string; nodeHandles?: string[] };
};

function nodeIsOnPage(doc: DesignDocument, node: DesignNode, pageId: string): boolean {
  let root = node;
  while (root.parentId !== null) {
    const parent = doc.nodes[root.parentId];
    if (!parent) return false;
    root = parent;
  }
  return findPage(doc, pageId)?.children.includes(root.id) ?? false;
}

/** Resolve an export selection from public handles against this parsed source scene. */
function resolveExportScope(doc: DesignDocument, scope: unknown): ResolvedExportScope | ToolError {
  if (scope === undefined) {
    const pageId = firstPageId(doc);
    return {
      pageId: pageId ?? undefined,
      ...(pageId ? { publicScope: { pageHandle: designPageHandle(pageId) } } : {}),
    };
  }
  if (!isRecord(scope)) return toolError("scope must be an object");
  const extra = unknownKey(scope, ["pageHandle", "nodeHandles"]);
  if (extra) return toolError(`unknown scope field ${extra}`);
  if (typeof scope["pageHandle"] !== "string") return toolError("scope.pageHandle must be a public page handle");
  const pageId = pageIdFromDesignHandle(scope["pageHandle"]);
  if (!pageId || !findPage(doc, pageId)) return toolError("scope.pageHandle must identify a page in the source document");
  const rawNodeHandles = scope["nodeHandles"];
  if (rawNodeHandles === undefined) {
    return { pageId, publicScope: { pageHandle: designPageHandle(pageId) } };
  }
  if (!Array.isArray(rawNodeHandles)) return toolError("scope.nodeHandles must be an array of public node handles");
  if (rawNodeHandles.length === 0) return toolError("scope.nodeHandles must not be empty when provided");
  const nodeIds: string[] = [];
  for (const handle of rawNodeHandles) {
    const nodeId = nodeIdFromDesignHandle(handle);
    const node = nodeId ? findNode(doc, nodeId) : undefined;
    if (!node) return toolError("scope.nodeHandles must identify nodes in the source document");
    if (!nodeIsOnPage(doc, node, pageId)) return toolError("scope.nodeHandles must belong to scope.pageHandle");
    nodeIds.push(node.id);
  }
  const uniqueNodeIds = [...new Set(nodeIds)];
  return {
    pageId,
    nodeIds: uniqueNodeIds,
    publicScope: {
      pageHandle: designPageHandle(pageId),
      nodeHandles: uniqueNodeIds.map(designNodeHandle),
    },
  };
}

function applyRequests(
  document: DesignDocument,
  requests: readonly DesignTransactionRequest[],
): { ok: true; document: DesignDocument; outcome: "applied" | "noop"; changedNodeIds: string[] } | ToolError {
  let next = document;
  let outcome: "applied" | "noop" = "noop";
  const changedNodeIds = new Set<string>();
  for (const request of requests) {
    const result = applyDesignTransaction(next, request);
    if (!result.ok) return toolError(result.error.message);
    if (result.receipt.outcome === "applied") outcome = "applied";
    for (const nodeId of result.receipt.changedNodeIds) changedNodeIds.add(nodeId);
    next = result.document;
  }
  return { ok: true, document: next, outcome, changedNodeIds: [...changedNodeIds] };
}

function stylePatch(
  value: { fills?: DesignFill[]; stroke?: DesignStroke; opacity?: number; radius?: number },
): StylePatch | undefined {
  const patch: StylePatch = {
    ...(value.fills !== undefined ? { fills: value.fills } : {}),
    ...(value.stroke !== undefined ? { stroke: value.stroke } : {}),
    ...(value.opacity !== undefined ? { opacity: value.opacity } : {}),
    ...(value.radius !== undefined ? { radius: value.radius } : {}),
  };
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function textPatch(
  value: { text?: string; fontSize?: number; fontFamily?: string; fontWeight?: string | number; lineHeight?: number; textWrap?: boolean; textAlign?: DesignTextAlign; color?: string },
): TextPatch | undefined {
  const patch: TextPatch = {
    ...(value.text !== undefined ? { text: value.text } : {}),
    ...(value.fontSize !== undefined ? { fontSize: value.fontSize } : {}),
    ...(value.fontFamily !== undefined ? { fontFamily: value.fontFamily } : {}),
    ...(value.fontWeight !== undefined ? { fontWeight: value.fontWeight } : {}),
    ...(value.lineHeight !== undefined ? { lineHeight: value.lineHeight } : {}),
    ...(value.textWrap !== undefined ? { textWrap: value.textWrap } : {}),
    ...(value.textAlign !== undefined ? { textAlign: value.textAlign } : {}),
    ...(value.color !== undefined ? { color: value.color } : {}),
  };
  return Object.keys(patch).length > 0 ? patch : undefined;
}

// ----- handlers -----

export function inspectOpenDesign(
  args: unknown,
  _ctx: AgentToolContext,
):
  | ({ status: "inspected"; documentVersion: LiveDocumentVersion } &
      Extract<ReturnType<typeof inspectCanonicalOpenDesign>, { ok: true }>)
  | ToolError
  | Extract<ReturnType<typeof inspectCanonicalOpenDesign>, { ok: false }> {
  const base = parseLiveDesignBase(args, INSPECT_OPEN_DESIGN_KEYS);
  if ("error" in base) return base;
  const options = parseInspectionOptions(base.record);
  if ("error" in options) return options;
  const parsed = parseDocument(base.canonicalContent);
  if (!parsed.ok) return parsed;
  const inspected = inspectCanonicalOpenDesign(parsed.document.scene, options);
  if (!inspected.ok) return inspected;
  return {
    ...inspected,
    status: "inspected",
    documentVersion: base.documentVersion,
  };
}

type LiveEditFailure = {
  ok: false;
  status: "rejected" | "conflict" | "error";
  code: string;
  message: string;
  stateChanged: false | "unknown";
  retrySafe: boolean;
  failedOperationIndex?: number;
  path?: string;
  conflicts?: Array<{
    handle: string;
    propertyGroups: DesignSemanticPropertyGroup[];
  }>;
  conflictCount?: number;
  omittedConflictCount?: number;
  recovery: string | { action: "ask_user"; reason: "refresh_intent" };
};

type LiveEditSuccess = {
  ok: true;
  status: "saved" | "noop";
  documentVersion: LiveDocumentVersion;
  receipt: EditOpenDesignReceipt;
  idempotency: DesignIdempotencyMetadata;
};

function versionAfterBoundWrite(
  write: Extract<WriteResult, { kind: "saved" }>,
  previous: LiveDocumentVersion,
): LiveDocumentVersion {
  if (previous.kind === "artifact_revision" && Number.isSafeInteger(write.revision)) {
    return { kind: "artifact_revision", revision: write.revision as number };
  }
  if (previous.kind === "local_sha") {
    return { kind: "local_sha", sha256: write.sha256 };
  }
  // A conforming artifact write returns a revision. Keeping the validated
  // prior version here is safer than inventing a revision if an older host
  // adapter omits it; the next call will be rejected until the surface refreshes.
  return previous;
}

export async function editOpenDesign(
  args: unknown,
  ctx: AgentToolContext,
): Promise<LiveEditSuccess | LiveEditFailure | ToolError> {
  const base = parseLiveDesignBase(args, [
    "sessionToken",
    "documentVersion",
    "idempotencyKey",
    "operations",
    "preconditions",
  ]);
  if ("error" in base) return base;
  const parsed = parseDocument(base.canonicalContent);
  if (!parsed.ok) return parsed;

  let applied: ReturnType<typeof applyOpenDesignOperations>;
  try {
    applied = applyOpenDesignOperations(parsed.document.scene, {
      idempotencyKey: base.record["idempotencyKey"],
      operations: base.record["operations"],
      preconditions: base.record["preconditions"],
    }, undefined, { requireSemanticPreconditions: true });
  } catch {
    return {
      ok: false,
      status: "rejected",
      code: "invalid_request",
      message: "The operation batch was malformed.",
      stateChanged: false,
      retrySafe: true,
      recovery: "Correct the operation shapes using the callable schema, then retry with a new idempotencyKey.",
    };
  }
  if (!applied.ok) {
    return {
      ok: false,
      status: "rejected",
      code: applied.error.code,
      message: applied.error.message,
      stateChanged: false,
      retrySafe: applied.error.retrySafe,
      failedOperationIndex: applied.error.failedOperationIndex,
      path: applied.error.path,
      ...(applied.error.conflicts ? { conflicts: applied.error.conflicts } : {}),
      ...(applied.error.conflictCount !== undefined
        ? { conflictCount: applied.error.conflictCount }
        : {}),
      ...(applied.error.omittedConflictCount !== undefined
        ? { omittedConflictCount: applied.error.omittedConflictCount }
        : {}),
      recovery:
        applied.error.code === "semantic_conflict"
          ? { action: "ask_user", reason: "refresh_intent" }
          : applied.error.code === "stale_geometry"
          ? "Inspect the current vector with includeGeometry, then retry once with those normalized commands as expectedGeometry."
          : applied.error.code === "not_found"
            ? "Inspect the open design again and retry with current handles and a new idempotencyKey."
            : applied.error.retrySafe
              ? `Correct operation ${applied.error.failedOperationIndex} using the typed error message, then retry with a new idempotencyKey.`
              : "Inspect the open design to confirm its current state before deciding whether to retry.",
    };
  }

  const operations = base.record["operations"] as DesignOperation[];
  const preconditions = Array.isArray(base.record["preconditions"])
    ? base.record["preconditions"]
    : [];
  const idempotency: DesignIdempotencyMetadata = {
    key: applied.receipt.idempotencyKey,
    fingerprint: designOperationFingerprint(
      parsed.document.scene,
      operations,
      preconditions as Parameters<typeof designOperationFingerprint>[2],
    ),
  };
  if (applied.receipt.outcome === "noop") {
    return {
      ok: true,
      status: "noop",
      documentVersion: base.documentVersion,
      receipt: applied.receipt,
      idempotency,
    };
  }

  let content: string;
  try {
    content = serializeDesignHtml(
      parsed.document.manifest,
      applied.document,
      { touchMetadata: true },
    );
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }

  let write: WriteResult;
  try {
    write = await ctx.nautiloApp.document.writeBound({ content });
  } catch (error) {
    return {
      ok: false,
      status: "error",
      code: "bound_write_failed",
      message: error instanceof Error ? error.message : String(error),
      stateChanged: "unknown",
      retrySafe: false,
      recovery: "Inspect the open design to confirm its current version before retrying.",
    };
  }
  if (write.kind === "conflict") {
    return {
      ok: false,
      status: "conflict",
      code: "version_conflict",
      message: "The open design changed before this atomic batch could be saved.",
      stateChanged: false,
      retrySafe: true,
      recovery: "Inspect the open design again, revise against the returned handles and geometry, then retry with a new idempotencyKey.",
    };
  }
  if (write.kind === "error") {
    return {
      ok: false,
      status: "error",
      code: "bound_write_failed",
      message: write.message,
      stateChanged: false,
      retrySafe: false,
      recovery: "Inspect the open design to confirm whether it changed before retrying.",
    };
  }
  return {
    ok: true,
    status: "saved",
    documentVersion: versionAfterBoundWrite(write, base.documentVersion),
    receipt: applied.receipt,
    idempotency,
  };
}

export type StaleDesignMutationValidation =
  | { status: "allow_current_binding" }
  | {
      status: "semantic_conflict";
      conflicts: Array<{
        handle: string;
        propertyGroups: DesignSemanticPropertyGroup[];
      }>;
      conflictCount: number;
      omittedConflictCount: number;
    };

/**
 * Trusted server-side stale rebase check. It never rewrites the frozen,
 * previously approved request: it only proves its inspected dependencies are
 * still semantically identical on the latest canonical Design document.
 */
export function validateStaleDesignMutation(input: {
  canonicalContent: string;
  frozenArgs: unknown;
}): StaleDesignMutationValidation {
  const parsed = parseDocument(input.canonicalContent);
  if (!parsed.ok || !isRecord(input.frozenArgs)) {
    return { status: "semantic_conflict", conflicts: [], conflictCount: 0, omittedConflictCount: 0 };
  }
  const result = applyOpenDesignOperations(parsed.document.scene, {
    idempotencyKey: input.frozenArgs["idempotencyKey"],
    operations: input.frozenArgs["operations"],
    preconditions: input.frozenArgs["preconditions"],
  }, undefined, { requireSemanticPreconditions: true });
  if (result.ok) return { status: "allow_current_binding" };
  const conflicts = result.error.conflicts ?? [];
  return {
    status: "semantic_conflict",
    conflicts,
    conflictCount: result.error.conflictCount ?? conflicts.length,
    omittedConflictCount: result.error.omittedConflictCount ?? 0,
  };
}

export async function createFile(
  args: CreateFileArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; displayPath: string; target: AppDocumentTarget }
  | ToolError
> {
  if (Object.prototype.hasOwnProperty.call(args, "openAfterCreate")) {
    return toolError("openAfterCreate is not supported; use the returned target to open the created document");
  }
  const extra = unknownKey(args as unknown as Record<string, unknown>, [
    "targetSurface",
    "filename",
    "initialContent",
  ]);
  if (extra) return toolError(`unknown field ${extra}`);
  const filenameError = validateBasenameFilename(args.filename);
  if (filenameError) return toolError(filenameError);
  if (args.filename.length < 13) {
    return toolError("filename must include a basename before .design.html");
  }
  if (args.filename.length > 255) return toolError("filename must be at most 255 characters");
  if (!args.filename.toLowerCase().endsWith(".design.html")) {
    return toolError("filename must end with .design.html");
  }
  if (args.targetSurface !== "workspace" && args.targetSurface !== "currentFolder") {
    return toolError('targetSurface must be "workspace" or "currentFolder"');
  }
  if (args.initialContent != null && args.initialContent !== "empty") {
    return toolError('initialContent must be "empty" when provided');
  }
  try {
    const result = await ctx.nautiloApp.document.createFromAction("new-design", {
      targetSurface: args.targetSurface,
      filename: args.filename,
    });
    return {
      ok: true,
      displayPath: result.displayPath,
      target: result.target,
    };
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

export async function inspectDocument(
  args: InspectDocumentArgs,
  ctx: AgentToolContext,
): Promise<
  | {
      ok: true;
      displayPath: string;
      pages: Array<{ id: string; name: string; topLevelCount: number }>;
      activePageId: string | null;
      nodeCount: number;
      topLevelFrames: Array<{ id: string; name: string; type: DesignNodeKind }>;
      node?: {
        id: string;
        type: DesignNodeKind;
        name: string;
        parentId: string | null;
        childIds: string[];
        x: number;
        y: number;
        width: number;
        height: number;
      };
    }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;

  let envelope;
  try {
    envelope = await ctx.nautiloApp.document.read(target);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;
  const doc = parsed.document.scene;
  const activePageId = resolvePage(doc, args.pageId);
  const activePage = activePageId ? findPage(doc, activePageId) : null;
  const frames = activePage
    ? activePage.children
        .map((id) => doc.nodes[id])
        .filter((node): node is DesignNode => node !== undefined)
        .map((node) => ({ id: node.id, name: node.name, type: node.type }))
    : [];
  const pages = doc.pages.map((page) => ({
    id: page.id,
    name: page.name,
    topLevelCount: page.children.length,
  }));
  let nodeSummary:
    | {
        id: string;
        type: DesignNodeKind;
        name: string;
        parentId: string | null;
        childIds: string[];
        x: number;
        y: number;
        width: number;
        height: number;
      }
    | undefined;
  if (args.nodeId) {
    const node = findNode(doc, args.nodeId);
    if (!node) return toolError(`Node not found: ${args.nodeId}`);
    nodeSummary = {
      id: node.id,
      type: node.type,
      name: node.name,
      parentId: node.parentId,
      childIds: node.childIds,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    };
  }
  return {
    ok: true,
    displayPath: envelope.displayPath,
    pages,
    activePageId,
    nodeCount: Object.keys(doc.nodes).length,
    topLevelFrames: frames,
    ...(nodeSummary ? { node: nodeSummary } : {}),
  };
}

type CreateNodeResult =
  | { ok: true; status: "saved"; displayPath: string; nodeId: string; sha256: string; revision?: number | null }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError;

async function createAndAppend(
  args: {
    target: AppDocumentTarget;
    pageId?: string;
    parentId?: string | null;
  },
  node: CreateTransaction["node"],
  ctx: AgentToolContext,
): Promise<CreateNodeResult> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;

  let envelope;
  try {
    envelope = await ctx.nautiloApp.document.read(target);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;
  const doc = parsed.document.scene;
  const result = applyDesignTransaction(doc, {
    kind: "create",
    node,
    ...(args.pageId !== undefined ? { pageId: args.pageId } : {}),
    ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
  });
  if (!result.ok) return toolError(result.error.message);
  const nodeId = result.receipt.changedNodeIds[0];
  if (!nodeId) return toolError("Create transaction returned no created node.");

  const writeBackResult = await writeBack(
    ctx,
    target,
    parsed.document.manifest,
    result.document,
    envelope,
  );
  if (!writeBackResult.ok) return writeBackResult;
  if ("conflict" in writeBackResult) {
    return {
      ok: true,
      status: "conflict",
      displayPath: writeBackResult.displayPath,
      currentSha256: writeBackResult.conflict.currentSha256,
    };
  }
  if ("error" in writeBackResult) {
    return {
      ok: true,
      status: "error",
      displayPath: writeBackResult.displayPath,
      message: writeBackResult.error.message,
    };
  }
  return {
    ok: true,
    status: "saved",
    displayPath: writeBackResult.displayPath,
    nodeId,
    sha256: writeBackResult.write.sha256,
    revision: writeBackResult.write.revision ?? null,
  };
}

export async function createFrame(
  args: CreateFrameArgs,
  ctx: AgentToolContext,
): Promise<CreateNodeResult> {
  const style = stylePatch(args);
  return createAndAppend(
    args,
    {
      type: "frame",
      ...(args.name !== undefined ? { name: args.name } : {}),
      x: args.x ?? 0,
      y: args.y ?? 0,
      width: args.width ?? 400,
      height: args.height ?? 300,
      ...(args.rotation !== undefined ? { rotation: args.rotation } : {}),
      ...(style !== undefined ? { style } : {}),
    },
    ctx,
  );
}

export async function createText(
  args: CreateTextArgs,
  ctx: AgentToolContext,
): Promise<CreateNodeResult> {
  if (typeof args.text !== "string") {
    return toolError("text must be a non-empty string");
  }
  const style = stylePatch(args);
  const text = textPatch(args);
  if (!text) return toolError("text must be a string");
  return createAndAppend(
    args,
    {
      type: "text",
      ...(args.name !== undefined ? { name: args.name } : {}),
      x: args.x ?? 0,
      y: args.y ?? 0,
      width: args.width ?? 200,
      height: args.height ?? 32,
      ...(args.rotation !== undefined ? { rotation: args.rotation } : {}),
      ...(style !== undefined ? { style } : {}),
      text,
    },
    ctx,
  );
}

export async function createShape(
  args: CreateShapeArgs,
  ctx: AgentToolContext,
): Promise<CreateNodeResult> {
  if (args.shape !== "rectangle") {
    return toolError('shape must be "rectangle" in V1');
  }
  const style = stylePatch(args);
  return createAndAppend(
    args,
    {
      type: "rectangle",
      ...(args.name !== undefined ? { name: args.name } : {}),
      x: args.x ?? 0,
      y: args.y ?? 0,
      width: args.width ?? 200,
      height: args.height ?? 120,
      ...(args.rotation !== undefined ? { rotation: args.rotation } : {}),
      ...(style !== undefined ? { style } : {}),
    },
    ctx,
  );
}

export async function setNodeProps(
  args: SetNodePropsArgs,
  ctx: AgentToolContext,
): Promise<NodeMutationResult> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;
  if (!args.props || typeof args.props !== "object" || Array.isArray(args.props)) {
    return toolError("props must be an object");
  }
  const propsUnsafe = assertSafeObjectKeys(args.props, "props");
  if (propsUnsafe) return toolError(propsUnsafe);
  const allowedProps = [
    "name", "x", "y", "width", "height", "rotation", "opacity", "radius",
    "fills", "stroke", "text", "fontSize", "fontFamily", "fontWeight", "lineHeight", "textWrap", "textAlign", "color", "src",
  ];
  const unknownProp = Object.keys(args.props).find((key) => !allowedProps.includes(key));
  if (unknownProp) return toolError(`Unknown props field: ${unknownProp}`);
  if (args.props.src !== undefined) {
    return toolError("props.src cannot store image bytes or URLs. Use an inspected assetRef with the image operation.");
  }

  let envelope;
  try {
    envelope = await ctx.nautiloApp.document.read(target);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;
  const doc = parsed.document.scene;
  const p = args.props;
  const geometry: GeometryPatch = {
    ...(p.x !== undefined ? { x: p.x } : {}),
    ...(p.y !== undefined ? { y: p.y } : {}),
    ...(p.width !== undefined ? { width: p.width } : {}),
    ...(p.height !== undefined ? { height: p.height } : {}),
  };
  const style = stylePatch(p);
  const text = textPatch(p);
  const requests: DesignTransactionRequest[] = [];
  if (Object.keys(geometry).length > 0) requests.push({ kind: "transform", updates: [{ nodeId: args.nodeId, ...geometry }] });
  if (p.rotation !== undefined) requests.push({ kind: "rotate", nodeIds: [args.nodeId], rotation: p.rotation });
  if (p.name !== undefined) requests.push({ kind: "rename", nodeIds: [args.nodeId], name: p.name });
  if (style) requests.push({ kind: "style", nodeIds: [args.nodeId], patch: style });
  if (text) requests.push({ kind: "text", nodeId: args.nodeId, patch: text });
  if (requests.length === 0) return toolError("props must contain at least one supported mutation field");
  const transaction = applyRequests(doc, requests);
  if (!transaction.ok) return transaction;
  if (transaction.outcome === "noop") {
    return { ok: true, status: "noop", displayPath: envelope.displayPath, nodeId: args.nodeId };
  }

  const writeBackResult = await writeBack(ctx, target, parsed.document.manifest, transaction.document, envelope);
  if (!writeBackResult.ok) return writeBackResult;
  if ("conflict" in writeBackResult) {
    return {
      ok: true,
      status: "conflict",
      displayPath: writeBackResult.displayPath,
      currentSha256: writeBackResult.conflict.currentSha256,
    };
  }
  if ("error" in writeBackResult) {
    return {
      ok: true,
      status: "error",
      displayPath: writeBackResult.displayPath,
      message: writeBackResult.error.message,
    };
  }
  return {
    ok: true,
    status: "saved",
    displayPath: writeBackResult.displayPath,
    nodeId: args.nodeId,
    sha256: writeBackResult.write.sha256,
    revision: writeBackResult.write.revision ?? null,
  };
}

export async function replaceText(
  args: ReplaceTextArgs,
  ctx: AgentToolContext,
): Promise<NodeMutationResult> {
  if (typeof args.text !== "string") return toolError("text must be a string");
  return setNodeProps(
    { target: args.target, nodeId: args.nodeId, props: { text: args.text } },
    ctx,
  );
}

type LayoutNodesResult =
  | { ok: true; status: "saved"; displayPath: string; changedNodeIds: string[]; sha256: string; revision?: number | null }
  | { ok: true; status: "noop"; displayPath: string; changedNodeIds: [] }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError;

/** Deterministic geometry layout; the agent supplies intent, not calculated coordinates. */
export async function layoutNodes(
  args: LayoutNodesArgs,
  ctx: AgentToolContext,
): Promise<LayoutNodesResult> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  if (args.operation !== "align" && args.operation !== "distribute") {
    return toolError("operation must be align or distribute");
  }
  if (args.axis !== "horizontal" && args.axis !== "vertical") {
    return toolError("axis must be horizontal or vertical");
  }
  if (args.operation === "distribute" && args.mode !== undefined) {
    return toolError("mode is only valid when operation is align");
  }
  const target = targetResult.target;
  let envelope;
  try {
    envelope = await ctx.nautiloApp.document.read(target);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;
  let request: DesignTransactionRequest;
  if (args.operation === "align") {
    const mode = args.mode;
    if (mode !== "start" && mode !== "center" && mode !== "end") {
      return toolError("mode must be start, center, or end when operation is align");
    }
    request = { kind: "align", nodeIds: args.nodeIds, axis: args.axis, mode };
  } else {
    request = { kind: "distribute", nodeIds: args.nodeIds, axis: args.axis };
  }
  const transaction = applyRequests(parsed.document.scene, [request]);
  if (!transaction.ok) return transaction;
  if (transaction.outcome === "noop") {
    return { ok: true, status: "noop", displayPath: envelope.displayPath, changedNodeIds: [] };
  }
  const writeBackResult = await writeBack(ctx, target, parsed.document.manifest, transaction.document, envelope);
  if (!writeBackResult.ok) return writeBackResult;
  if ("conflict" in writeBackResult) {
    return { ok: true, status: "conflict", displayPath: writeBackResult.displayPath, currentSha256: writeBackResult.conflict.currentSha256 };
  }
  if ("error" in writeBackResult) {
    return { ok: true, status: "error", displayPath: writeBackResult.displayPath, message: writeBackResult.error.message };
  }
  return {
    ok: true,
    status: "saved",
    displayPath: writeBackResult.displayPath,
    changedNodeIds: transaction.changedNodeIds,
    sha256: writeBackResult.write.sha256,
    revision: writeBackResult.write.revision ?? null,
  };
}

export async function arrangeNodes(
  args: ArrangeNodesArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; status: "saved"; displayPath: string; reorderedCount: number; sha256: string; revision?: number | null }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;
  if (!Array.isArray(args.nodeIds)) return toolError("nodeIds must be an array");
  for (const id of args.nodeIds) {
    if (typeof id !== "string") return toolError("nodeIds entries must be strings");
  }

  let envelope;
  try {
    envelope = await ctx.nautiloApp.document.read(target);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;
  const doc = parsed.document.scene;

  const transaction = applyDesignTransaction(doc, {
    kind: "reorder",
    parentId: args.parentId,
    ...(args.pageId !== undefined ? { pageId: args.pageId } : {}),
    orderedIds: args.nodeIds,
  });
  if (!transaction.ok) return toolError(transaction.error.message);

  const writeBackResult = await writeBack(
    ctx,
    target,
    parsed.document.manifest,
    transaction.document,
    envelope,
  );
  if (!writeBackResult.ok) return writeBackResult;
  if ("conflict" in writeBackResult) {
    return {
      ok: true,
      status: "conflict",
      displayPath: writeBackResult.displayPath,
      currentSha256: writeBackResult.conflict.currentSha256,
    };
  }
  if ("error" in writeBackResult) {
    return {
      ok: true,
      status: "error",
      displayPath: writeBackResult.displayPath,
      message: writeBackResult.error.message,
    };
  }
  return {
    ok: true,
    status: "saved",
    displayPath: writeBackResult.displayPath,
    reorderedCount: args.nodeIds.length,
    sha256: writeBackResult.write.sha256,
    revision: writeBackResult.write.revision ?? null,
  };
}

export async function exportSvg(args: ExportSvgArgs, ctx: AgentToolContext) {
  return exportImage(args, ctx, "svg");
}

export async function exportPng(args: ExportSvgArgs, ctx: AgentToolContext) {
  return exportImage(args, ctx, "png");
}

async function exportImage(
  args: ExportSvgArgs,
  ctx: AgentToolContext,
  format: "svg" | "png",
): Promise<
  | {
      ok: true;
      status: "exported";
      artifactPath: string;
      displayPath: string;
      sha256: string;
      byteLength: number;
      scope?: { pageHandle: string; nodeHandles?: string[] };
    }
  | {
      ok: true;
      status: "conflict";
      target: { surface: "workspace" | "currentFolder"; path: string };
      message: string;
    }
  | { ok: true; status: "failed"; code: string; message: string; displayPath?: string; bytesWritten?: number; metadataConfirmed?: false; stateChanged?: true; retrySafe?: false }
  | ToolError
> {
  if (!args || typeof args !== "object")
    return toolError("args must be an object");
  if (!args.source || typeof args.source !== "object")
    return toolError("source must be an object");
  if (!args.target || typeof args.target !== "object")
    return toolError("target must be an object");

  const sourceResult = validateConversionPath(
    args.source.surface,
    args.source.path,
    "source",
  );
  if (!sourceResult.ok) return sourceResult;
  if (!sourceResult.path.toLowerCase().endsWith(".design.html")) {
    return toolError('source.path must end with ".design.html"');
  }
  const targetResult = validateConversionPath(
    args.target.surface,
    args.target.path,
    "target",
  );
  if (!targetResult.ok) return targetResult;
  if (!targetResult.path.toLowerCase().endsWith(`.${format}`)) {
    return toolError(`target.path must end with ".${format}"`);
  }
  if (targetResult.surface !== "workspace") {
    return toolError(
      `${format.toUpperCase()} export currently requires a workspace destination because Current Folder does not provide atomic create-only writes.`,
    );
  }

  const source: AppDocumentTarget =
    sourceResult.surface === "workspace"
      ? { surface: "workspace", path: sourceResult.path }
      : { surface: "currentFolder", relativePath: sourceResult.path };

  let envelope;
  try {
    envelope = await ctx.nautiloApp.document.read(source);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) {
    return {
      ok: true,
      status: "failed",
      code: "PARSER_FAILED",
      message: parsed.error,
    };
  }
  const doc = parsed.document.scene;
  const scope = resolveExportScope(doc, args.scope);
  if ("error" in scope) return scope;
  let svg: string;
  try {
    svg = renderSceneSvg(doc, scope.pageId, {
      ...(scope.nodeIds ? { nodeIds: scope.nodeIds } : {}),
      ...(format === "png" ? { outlineText: true } : {}),
      // Legacy source strings have no host custody. Export only pinned asset
      // references that the verified host resolves inside its read envelope.
      rejectImageSources: true,
      hostAssetReferences: true,
    });
  } catch (err) {
    if (err instanceof UnsupportedImageSourceError) {
      return {
        ok: true,
        status: "failed",
        code: "UNSUPPORTED_IMAGE_SOURCE",
        message: `${format.toUpperCase()} export is unavailable for the requested scope because it contains image sources.`,
      };
    }
    return toolError(err instanceof Error ? err.message : String(err));
  }

  let created;
  try {
    const output = {
      surface: targetResult.surface,
      path: targetResult.path,
      overwrite: args.overwrite === true,
      ...(sourceResult.surface === "workspace" &&
      targetResult.surface === "workspace"
        ? {
            colocateWith: {
              surface: "workspace" as const,
              path: sourceResult.path,
            },
          }
        : {}),
    };
    created = format === "png"
      ? await ctx.nautiloApp.document.createRasterFromSvg({ ...output, svg, format: "png" })
      : await ctx.nautiloApp.document.createDocument({ ...output, content: svg, mimeType: "image/svg+xml" });
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  if (!created.ok) {
    if (created.code === "EXISTS") {
      return {
        ok: true,
        status: "conflict",
        target: { surface: targetResult.surface, path: targetResult.path },
        message: created.message,
      };
    }
    return {
      ok: true,
      status: "failed",
      code: created.code,
      message: created.message,
      ...(created.stateChanged ? {
        displayPath: created.displayPath ?? targetResult.path,
        bytesWritten: created.bytesWritten,
        metadataConfirmed: false as const,
        stateChanged: true as const,
        retrySafe: false as const,
      } : {}),
    };
  }
  return {
    ok: true,
    status: "exported",
    artifactPath: created.artifactPath,
    displayPath: created.artifactPath,
    sha256: created.sha256,
    byteLength: created.byteLength,
    ...(scope.publicScope ? { scope: scope.publicScope } : {}),
  };
}

// Re-export for test visibility
export { isDesignNodeKind };

/** Obtain metadata only; raster bytes stay inside host custody. */
export async function inspectImageAsset(args: { artifactId: string }, ctx: AgentToolContext) {
  if (!args || typeof args.artifactId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(args.artifactId)) return toolError("artifactId must be a Workspace artifact internal UUID from discovery.");
  if (!ctx.nautiloApp.assets) return toolError("Image inspection is unavailable in this host.");
  return ctx.nautiloApp.assets.inspect({ artifactId: args.artifactId });
}
