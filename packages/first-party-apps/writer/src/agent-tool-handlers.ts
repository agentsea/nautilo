/**
 * Writer mini-app agent tool handlers (P3.1) — server-side, headless, node-safe.
 *
 * Mirrors the Excel pattern (`../../excel/src/agent-tool-handlers.ts`): each
 * tool reads the office-document container, parses it via `parseWriterHtml`,
 * mutates the Wafflebase block model, re-serializes the FULL container, and
 * writes it back through the host. The host derives + broadcasts the M193
 * `AnchoredTextPatch`; we never compute a patch here.
 *
 * Types are defined LOCALLY (no cross-app imports) so first-party apps stay
 * isolated — the Excel handler is a template, not a dependency.
 */
import {
  CLEAR_INLINE_STYLE,
  applyInlineStyleHelper,
  createBlock,
  createTableBlock,
  getBlockText,
  getBlockTextLength,
  normalizeBlockStyle,
  type Block,
  type BlockStyle,
  type BlockType,
  type CellAddress,
  type InlineStyle,
} from "@nautilo/office-docs/node";
import {
  createDefaultManifest,
  createEmptyWriterHtml,
  parseWriterHtml,
  serializeWriterHtml,
  wafflebaseDocumentToPayload,
  type WafflebaseDocumentPayload,
  type WriterHtmlDocument,
  type WriterHtmlManifest,
} from "./office-document";
import {
  mapOfficeCliGetEnvelope,
  mapWriterDocumentToOfficeCliBatch,
  type OfficeCliGetEnvelope,
  type OfficeRunDataUrlImageInput,
} from "./docx-mapper";
import {
  validateEditOpenWriterRequest,
  type EditOpenWriterRequest,
  type ProposalOperation,
  parseEditOpenWriterDocumentVersion,
} from "./proposal-contract";
import {
  validateBlockStyle,
  validateInlineStyle,
  validateTableCellStyle,
  type StyleValidationError,
} from "./writer-style-validation";
import {
  boundedCanonicalBlocks,
  boundedCanonicalTable,
  findCanonicalTextBlock,
  isTableReadCursor,
  locateWriterText,
  type CanonicalTablePayload,
  type TableReadCursor,
} from "./writer-live-locator";
import type { LiveDocumentVersion } from "@nautilo/types";
import {
  deleteTableBlock as deleteCanonicalTableBlock,
  deleteTableColumn as deleteCanonicalTableColumn,
  deleteTableRow as deleteCanonicalTableRow,
  insertTableColumn as insertCanonicalTableColumn,
  insertTableRow as insertCanonicalTableRow,
  mergeTableCells as mergeCanonicalTableCells,
  setTableCellStyle as setCanonicalTableCellStyle,
  splitTableCell as splitCanonicalTableCell,
} from "./table-document-ops";

function liveToolDocumentVersion(args: Record<string, unknown>): LiveDocumentVersion | null {
  return parseEditOpenWriterDocumentVersion(args["documentVersion"] ?? args["baseRevision"]);
}

export type AppDocumentTarget =
  | { surface: "workspace"; path: string }
  | { surface: "currentFolder"; relativePath: string };

export type ServerNautiloAppHost = {
  document: {
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
    createDocument(args: {
      surface: "workspace" | "currentFolder";
      path: string;
      content: string;
      mimeType?: string;
      colocateWith?: { surface: "workspace"; path: string };
      overwrite?: boolean;
    }): Promise<
      | { ok: true; artifactPath: string; sha256: string; byteLength: number }
      | { ok: false; code: string; message: string; stateChanged?: true; retrySafe?: false }
    >;
  };
  office: {
    run(args: {
      input?: { surface: "workspace" | "currentFolder"; path: string };
      readArgv?: string[];
      ops?: unknown[];
      imageInputs?: OfficeRunDataUrlImageInput[];
      output?: { surface: "workspace" | "currentFolder"; path: string };
      overwrite?: boolean;
    }): Promise<
      | {
          ok: true;
          json?: unknown;
          mediaByRelId?: Record<string, string>;
          sha256?: string;
          byteLength?: number;
          displayPath?: string;
        }
      | { ok: false; code: string; message: string }
    >;
  };
};

export type AgentToolContext = {
  nautiloApp: ServerNautiloAppHost;
};

/** Create canonical Writer bytes through the host's create-only storage path. */
export async function createFile(args: unknown, ctx: AgentToolContext) {
  const invalid = (message: string) => ({
    ok: false as const, status: "invalid_request" as const, code: "invalid_create_request",
    phase: "validate", message, stateChanged: false as const, retrySafe: true,
  });
  if (!args || typeof args !== "object" || Array.isArray(args)) return invalid("Expected a document name.");
  const input = args as Record<string, unknown>;
  const extra = Object.keys(input).find(key => key !== "filename");
  if (extra) return invalid(`Unknown field: ${extra}.`);
  if (typeof input["filename"] !== "string") return invalid("filename must be a document name.");
  const name = input["filename"].trim();
  if (!name || name === "." || name === ".." || /[\\/]/u.test(name) || [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    return invalid("Use a document name without folders or control characters.");
  }
  const filename = name.toLowerCase().endsWith(".doc.html") ? name : `${name}.doc.html`;
  if (filename.toLowerCase() === ".doc.html") return invalid("Include a name before .doc.html.");
  try {
    const result = await ctx.nautiloApp.document.createDocument({
      surface: "workspace", path: filename, content: createEmptyWriterHtml(), mimeType: "text/html", overwrite: false,
    });
    if (!result.ok) return {
      stateChanged: result.code === "EXISTS" || result.code === "FORBIDDEN" ? false : "unknown",
      retrySafe: false,
      ...result, status: "create_failed" as const, phase: "persist",
      recovery: "Inspect the destination before retrying; choose another name if it already exists.",
    };
    return {
      ...result, status: "created" as const, displayPath: result.artifactPath,
      target: { surface: "workspace" as const, path: result.artifactPath },
      opened: false,
      nextAction: "Populate this document with Writer tools, then direct the Human to the Open document card.",
    };
  } catch (error) {
    return {
      ok: false as const, status: "create_failed" as const, code: "create_uncertain", phase: "persist",
      message: error instanceof Error ? error.message : "Document creation did not return a receipt.",
      stateChanged: "unknown" as const, retrySafe: false,
      recovery: "Inspect the destination before retrying. Do not assume the document was not created.",
    };
  }
}

export type EditOpenWriterResult =
  | {
      ok: true;
      status: "proposal_ready";
      documentVersion: LiveDocumentVersion;
      operations: ProposalOperation[];
    }
  | {
      ok: false;
      status: "invalid_request";
      field: string;
      message: string;
    };

type LiveCanonicalArgs = {
  sessionToken: string;
  documentVersion: LiveDocumentVersion;
  blockId: string;
  beforeBlocks?: number;
  afterBlocks?: number;
  tableCursor?: TableReadCursor;
  /** Injected only by the validated server registration boundary. */
  __canonicalContent?: string;
};

function parseLiveCanonicalArgs(args: unknown): LiveCanonicalArgs | ToolError {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return toolError("live Writer session is unavailable");
  }
  const record = args as Record<string, unknown>;
  const documentVersion = liveToolDocumentVersion(record);
  if (!documentVersion) return toolError("documentVersion must be a supported live document version");
  if (typeof record["sessionToken"] !== "string" || record["sessionToken"].trim().length === 0) {
    return toolError("sessionToken must be an opaque non-empty token");
  }
  if (typeof record["blockId"] !== "string") return toolError("blockId must be a non-empty string");
  return {
    sessionToken: record["sessionToken"],
    documentVersion,
    blockId: record["blockId"],
    ...(typeof record["beforeBlocks"] === "number" ? { beforeBlocks: record["beforeBlocks"] } : {}),
    ...(typeof record["afterBlocks"] === "number" ? { afterBlocks: record["afterBlocks"] } : {}),
    ...(record["tableCursor"] !== undefined ? { tableCursor: record["tableCursor"] as TableReadCursor } : {}),
    ...(typeof record["__canonicalContent"] === "string" ? { __canonicalContent: record["__canonicalContent"] } : {}),
  };
}

function liveCanonicalDocument(args: LiveCanonicalArgs): ParsedDocument | ToolError {
  if (typeof args.__canonicalContent !== "string") return toolError("live Writer session is unavailable");
  return parseDocument(args.__canonicalContent);
}

/** Preserve the asynchronous app-worker contract around deterministic validation. */
export function readOpenWriterRange(args: unknown, ctx: AgentToolContext): Promise<ReturnType<typeof readOpenWriterRangeResult>> {
  return Promise.resolve().then(() => readOpenWriterRangeResult(args, ctx));
}

function readOpenWriterRangeResult(args: unknown, _ctx: AgentToolContext):
  | { ok: true; status: "range_read"; documentVersion: LiveDocumentVersion; blocks: Array<{ id: string; type: string; text: string }> }
  | { ok: true; status: "table_read"; documentVersion: LiveDocumentVersion; table: CanonicalTablePayload }
  | ToolError
{
  const parsedArgs = parseLiveCanonicalArgs(args);
  if ("error" in parsedArgs) return parsedArgs;
  const liveArgs = parsedArgs;
  if (!validateBlockId(liveArgs.blockId)) return toolError("blockId must be a non-empty string");
  const before = liveArgs.beforeBlocks ?? 0;
  const after = liveArgs.afterBlocks ?? 0;
  if (!Number.isInteger(before) || !Number.isInteger(after) || before < 0 || after < 0 || before + after + 1 > 5) {
    return toolError("range read must select 1–5 blocks");
  }
  const parsed = liveCanonicalDocument(liveArgs);
  if (!parsed.ok) return parsed;
  const canonicalBlocks = parsed.document.document.blocks as Block[];
  const table = canonicalBlocks.find((block) => block.id === liveArgs.blockId && block.type === "table");
  if (table) {
    if (liveArgs.tableCursor !== undefined && !isTableReadCursor(liveArgs.tableCursor)) {
      return toolError("tableCursor must be a non-negative table coordinate cursor");
    }
    const payload = boundedCanonicalTable(table, liveArgs.tableCursor);
    if (!payload) return toolError("tableCursor is invalid or stale for this canonical table");
    return { ok: true, status: "table_read", documentVersion: liveArgs.documentVersion, table: payload };
  }
  const blocks = boundedCanonicalBlocks(canonicalBlocks, liveArgs.blockId, before, after);
  if (!blocks) return toolError("blockId was not found in the canonical document");
  return { ok: true, status: "range_read", documentVersion: liveArgs.documentVersion, blocks };
}

/** Preserve the asynchronous app-worker contract around deterministic validation. */
export function locateOpenWriterText(args: unknown, ctx: AgentToolContext): Promise<ReturnType<typeof locateOpenWriterTextResult>> {
  return Promise.resolve().then(() => locateOpenWriterTextResult(args, ctx));
}

function locateOpenWriterTextResult(args: unknown, _ctx: AgentToolContext):
  | { ok: true; status: "locator_resolved"; documentVersion: LiveDocumentVersion; blockId: string; __range: { start: number; end: number } }
  | { ok: false; status: "anchor_not_found" | "anchor_ambiguous" }
  | ToolError
{
  const parsedArgs = parseLiveCanonicalArgs(args);
  if ("error" in parsedArgs) return parsedArgs;
  const record = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const liveArgs = {
    ...parsedArgs,
    target: record["target"] as string,
    ...(record["before"] === undefined ? {} : { before: record["before"] as string }),
    ...(record["after"] === undefined ? {} : { after: record["after"] as string }),
  };
  const collapseTo = record["collapseTo"];
  if (collapseTo !== undefined && collapseTo !== "start" && collapseTo !== "end") {
    return toolError('collapseTo must be "start" or "end"');
  }
  if (!validateBlockId(liveArgs.blockId)) return toolError("blockId must be a non-empty string");
  for (const value of [liveArgs.before, liveArgs.target, liveArgs.after]) {
    if (value !== undefined && (typeof value !== "string" || value.trim().split(/\s+/u).filter(Boolean).length > 5)) {
      return toolError("anchors must contain 1–5 words");
    }
  }
  if (typeof liveArgs.target !== "string" || liveArgs.target.trim().length === 0) return toolError("target is required");
  const parsed = liveCanonicalDocument(liveArgs);
  if (!parsed.ok) return parsed;
  const block = findCanonicalTextBlock(parsed.document.document.blocks as Block[], liveArgs.blockId);
  if (!block) return toolError("blockId was not found in the canonical document");
  const located = locateWriterText(getBlockText(block), liveArgs);
  if (!located.ok) return { ok: false, status: located.code };
  const range = collapseTo === "start"
    ? { start: located.range.start, end: located.range.start }
    : collapseTo === "end"
      ? { start: located.range.end, end: located.range.end }
      : located.range;
  return {
    ok: true,
    status: "locator_resolved",
    documentVersion: liveArgs.documentVersion,
    blockId: liveArgs.blockId,
    __range: range,
  };
}

export type InspectDocumentArgs = {
  target: AppDocumentTarget;
};

export type InsertBlocksArgs = {
  target: AppDocumentTarget;
  afterBlockId?: string;
  blocks: Array<{
    type: "paragraph" | "heading" | "list-item";
    text: string;
    headingLevel?: 1 | 2 | 3;
    listKind?: "ordered" | "unordered";
    listLevel?: number;
  }>;
};

export type ReplaceTextArgs = {
  target: AppDocumentTarget;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
};

export type SetBlockTypeArgs = {
  target: AppDocumentTarget;
  blockId: string;
  toType: "paragraph" | "title" | "subtitle" | "heading" | "list-item";
  headingLevel?: 1 | 2 | 3;
  listKind?: "ordered" | "unordered";
  listLevel?: number;
};

export type ApplyBlockStyleArgs = {
  target: AppDocumentTarget;
  blockId: string;
  style: {
    alignment?: "left" | "center" | "right" | "justify";
    lineHeight?: number;
    marginTop?: number;
    marginBottom?: number;
    textIndent?: number;
    marginLeft?: number;
  };
};

export type FormatTextStyle = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  backgroundColor?: string;
  href?: string;
  clear?: boolean;
};

export type FormatTextArgs = {
  target: AppDocumentTarget;
  blockId: string;
  from: number;
  to?: number;
  style: FormatTextStyle;
};

export type DeleteBlocksArgs = {
  target: AppDocumentTarget;
  blockIds: string[];
};

export type MoveBlocksArgs = {
  target: AppDocumentTarget;
  blockIds: string[];
  position: "start" | "end" | "after";
  afterBlockId?: string;
};

export type InsertTableArgs = {
  target: AppDocumentTarget;
  afterBlockId?: string;
  rows: number;
  cols: number;
  /** Optional row-major text; dimensions must exactly match rows and cols. */
  cells?: string[][];
};

// ---------------------------------------------------------------------------
// D372 parity tools: table structure edits, cell style, delete-table, and
// indent/outdent. These mirror the human Writer ribbon over the same
// Wafflebase Document model so agent and human capability match.
// ---------------------------------------------------------------------------

export type InsertTableRowArgs = {
  target: AppDocumentTarget;
  blockId: string;
  /** 0..rows.length. `rows.length` appends. */
  rowIndex: number;
};

export type DeleteTableRowArgs = {
  target: AppDocumentTarget;
  blockId: string;
  rowIndex: number;
};

export type InsertTableColumnArgs = {
  target: AppDocumentTarget;
  blockId: string;
  /** 0..columnWidths.length. `columnWidths.length` appends. */
  colIndex: number;
};

export type DeleteTableColumnArgs = {
  target: AppDocumentTarget;
  blockId: string;
  colIndex: number;
};

export type MergeTableCellsArgs = {
  target: AppDocumentTarget;
  blockId: string;
  start: CellAddress;
  end: CellAddress;
};

export type SplitTableCellArgs = {
  target: AppDocumentTarget;
  blockId: string;
  rowIndex: number;
  colIndex: number;
};

export type SetTableCellStyleArgs = {
  target: AppDocumentTarget;
  blockId: string;
  rowIndex: number;
  colIndex: number;
  style: {
    backgroundColor?: string;
    verticalAlign?: "top" | "middle" | "bottom";
    padding?: number;
  };
};

export type DeleteTableArgs = {
  target: AppDocumentTarget;
  blockId: string;
};

export type IndentBlocksArgs = {
  target: AppDocumentTarget;
  blockIds: string[];
};

export type OutdentBlocksArgs = {
  target: AppDocumentTarget;
  blockIds: string[];
};

// ---------------------------------------------------------------------------
// D372 — .docx import/export tools. The app owns OfficeCLI JSON ⇄ Writer
// block mapping; the host primitive performs the OfficeCLI invocation and
// host-side bytes read/write.
// ---------------------------------------------------------------------------

export type ImportDocxArgs = {
  source: { surface: "currentFolder" | "workspace"; path: string };
  targetPath: string;
  fileName?: string;
  /** M205 — overwrite an existing target instead of returning a conflict. */
  overwrite?: boolean;
};

export type ExportDocxArgs = {
  source: { surface: "currentFolder" | "workspace"; path: string };
  target: { surface: "currentFolder" | "workspace"; path: string };
  fileName?: string;
  /** M205 — overwrite an existing target instead of returning a conflict. */
  overwrite?: boolean;
};

/**
 * M205 — a write target that already exists. Both import and export return
 * this (instead of overwriting or erroring) so the caller can prompt
 * overwrite / rename / cancel uniformly across surfaces.
 */
export type ConversionConflict = {
  ok: true;
  status: "conflict";
  target: { surface: "currentFolder" | "workspace"; path: string };
  message: string;
};

type ToolError = { ok: false; error: string };
type ParsedDocument = { ok: true; document: WriterHtmlDocument };

const INSERT_BLOCKS_MAX = 100;
const INSERT_TEXT_MAX = 20_000;
const OUTLINE_TEXT_LIMIT = 200;
const BLOCK_IDS_MAX = 100;
const BLOCK_ID_MAX_LEN = 200;
const TABLE_ROWS_MAX = 100;
const TABLE_COLS_MAX = 20;
const TABLE_CELLS_MAX = 1000;
// Indent / outdent — match the human ribbon (editor.ts indent/outdent).
const INDENT_STEP = 36;
const MAX_LIST_LEVEL = 8;
// Table edit bounds — keep well under the model's createTableBlock limits.
const TABLE_ROW_INDEX_MAX = TABLE_ROWS_MAX;
const TABLE_COL_INDEX_MAX = TABLE_COLS_MAX;
const TEXT_BLOCK_TYPES = new Set(["paragraph", "title", "subtitle", "heading", "list-item"]);
type TextBlockType = "paragraph" | "title" | "subtitle" | "heading" | "list-item";

function isTextBlockType(value: unknown): value is TextBlockType {
  return typeof value === "string" && TEXT_BLOCK_TYPES.has(value);
}

function validateBlockId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > BLOCK_ID_MAX_LEN || hasControlChars(value)) return null;
  return value;
}

function toolError(message: string): ToolError {
  return { ok: false, error: message };
}

function styleToolError(error: StyleValidationError): ToolError {
  return toolError(error.field === "style" ? error.message : `style.${error.field} ${error.message}`);
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
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
  const parsed = parseWriterHtml(content);
  if (!parsed.ok) return toolError(parsed.error);
  return { ok: true, document: parsed.document };
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "…";
}

/**
 * D386 Phase 1 transport envelope only. Session authority is checked by the
 * server registration gate before this worker runs. This handler independently
 * validates the public request contract and deliberately performs no document
 * read, write, resolution, diffing, or canonical mutation.
 */
/** Preserve the asynchronous app-worker contract around deterministic validation. */
export function editOpenWriter(args: unknown, ctx: AgentToolContext): Promise<ReturnType<typeof editOpenWriterResult>> {
  return Promise.resolve().then(() => editOpenWriterResult(args, ctx));
}

function editOpenWriterResult(
  args: unknown,
  _ctx: AgentToolContext,
): EditOpenWriterResult {
  const validated = validateEditOpenWriterRequest(args);
  if (!validated.ok) {
    return {
      ok: false,
      status: "invalid_request",
      field: validated.field,
      message: validated.message,
    };
  }
  const request: EditOpenWriterRequest = validated.request;
  return {
    ok: true,
    status: "proposal_ready",
    documentVersion: request.documentVersion,
    operations: request.operations,
  };
}

type OutlineEntry = {
  id: string;
  index: number;
  type: BlockType;
  headingLevel?: 1 | 2 | 3;
  listKind?: "ordered" | "unordered";
  listLevel?: number;
  text: string;
  table?: {
    rowCount: number;
    columnCount: number;
    cellCount: number;
    preview: string;
    readHint: "Use read-open-writer-range with this table blockId to discover editable cell blocks; follow any returned nextCursor.";
  };
};

function tableOutlinePreview(block: Block): string {
  if (!block.tableData) return "";
  for (const row of block.tableData.rows) for (const cell of row.cells) {
    if (cell.colSpan === 0) continue;
    for (const nested of cell.blocks) {
      const text = getBlockText(nested);
      if (text) return truncate(text, 80);
    }
  }
  return "";
}

function buildOutline(blocks: unknown[]): OutlineEntry[] {
  const outline: OutlineEntry[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] as Block | undefined;
    if (!block || typeof block !== "object") continue;
    const isTable = block.type === "table" && block.tableData;
    const entry: OutlineEntry = {
      id: block.id,
      index: i,
      type: block.type,
      text: isTable
        ? `Table (${block.tableData!.rows.length} rows × ${block.tableData!.columnWidths.length} columns)`
        : truncate(getBlockText(block), OUTLINE_TEXT_LIMIT),
    };
    if (isTable) {
      entry.table = {
        rowCount: block.tableData!.rows.length,
        columnCount: block.tableData!.columnWidths.length,
        cellCount: block.tableData!.rows.reduce((count, row) => count + row.cells.length, 0),
        preview: tableOutlinePreview(block),
        readHint: "Use read-open-writer-range with this table blockId to discover editable cell blocks; follow any returned nextCursor.",
      };
    }
    if (block.headingLevel !== undefined) {
      entry.headingLevel = block.headingLevel as 1 | 2 | 3;
    }
    if (block.listKind !== undefined) {
      entry.listKind = block.listKind;
    }
    if (block.listLevel !== undefined) {
      entry.listLevel = block.listLevel;
    }
    outline.push(entry);
  }
  return outline;
}

export async function inspectDocument(
  args: InspectDocumentArgs,
  ctx: AgentToolContext,
): Promise<
  | {
      ok: true;
      displayPath: string;
      blockCount: number;
      outline: OutlineEntry[];
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

  const blocks = parsed.document.document.blocks;
  return {
    ok: true,
    displayPath: envelope.displayPath,
    blockCount: blocks.length,
    outline: buildOutline(blocks),
  };
}

type InsertBlockInput = InsertBlocksArgs["blocks"][number];

function buildBlockFromInput(input: InsertBlockInput): Block {
  const type: BlockType = input.type;
  const opts: { headingLevel?: 1 | 2 | 3; listKind?: "ordered" | "unordered"; listLevel?: number } = {};
  if (input.headingLevel !== undefined) opts.headingLevel = input.headingLevel;
  if (input.listKind !== undefined) opts.listKind = input.listKind;
  if (input.listLevel !== undefined) opts.listLevel = input.listLevel;
  const block = createBlock(type, opts);
  block.inlines = [{ text: input.text, style: {} }];
  return block;
}

function validateInsertBlocksArgs(args: InsertBlocksArgs): ToolError | null {
  if (!Array.isArray(args.blocks)) {
    return toolError("blocks must be an array");
  }
  if (args.blocks.length === 0) {
    return toolError("blocks must contain at least one block");
  }
  if (args.blocks.length > INSERT_BLOCKS_MAX) {
    return toolError(`blocks length exceeds maximum (${INSERT_BLOCKS_MAX})`);
  }
  for (let i = 0; i < args.blocks.length; i++) {
    const entry = args.blocks[i]!;
    if (entry == null || typeof entry !== "object") {
      return toolError(`blocks[${i}] must be an object`);
    }
    if (entry.type !== "paragraph" && entry.type !== "heading" && entry.type !== "list-item") {
      return toolError(
        `blocks[${i}].type must be "paragraph", "heading", or "list-item"`,
      );
    }
    if (typeof entry.text !== "string") {
      return toolError(`blocks[${i}].text must be a string`);
    }
    if (entry.text.length > INSERT_TEXT_MAX) {
      return toolError(`blocks[${i}].text length exceeds maximum (${INSERT_TEXT_MAX})`);
    }
    if (hasControlChars(entry.text)) {
      return toolError(`blocks[${i}].text must not contain control characters`);
    }
    if (entry.headingLevel !== undefined && entry.headingLevel !== 1 && entry.headingLevel !== 2 && entry.headingLevel !== 3) {
      return toolError(`blocks[${i}].headingLevel must be 1, 2, or 3`);
    }
    if (entry.listKind !== undefined && entry.listKind !== "ordered" && entry.listKind !== "unordered") {
      return toolError(`blocks[${i}].listKind must be "ordered" or "unordered"`);
    }
    if (entry.listLevel !== undefined && (typeof entry.listLevel !== "number" || !Number.isFinite(entry.listLevel) || entry.listLevel < 0)) {
      return toolError(`blocks[${i}].listLevel must be a non-negative number`);
    }
  }
  return null;
}

export async function insertBlocks(
  args: InsertBlocksArgs,
  ctx: AgentToolContext,
): Promise<
  | {
      ok: true;
      status: "saved";
      displayPath: string;
      insertedCount: number;
      sha256: string;
      revision?: number | null;
    }
  | {
      ok: true;
      status: "conflict";
      displayPath: string;
      currentSha256: string | null;
    }
  | {
      ok: true;
      status: "error";
      displayPath: string;
      message: string;
    }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;

  const argError = validateInsertBlocksArgs(args);
  if (argError) return argError;

  let envelope;
  try {
    envelope = await ctx.nautiloApp.document.read(target);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }

  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;

  const payload: WafflebaseDocumentPayload = parsed.document.document;
  const currentBlocks = payload.blocks as Block[];

  const newBlocks = args.blocks.map(buildBlockFromInput);

  let insertIndex: number;
  if (args.afterBlockId && typeof args.afterBlockId === "string") {
    const foundIndex = currentBlocks.findIndex((b) => b?.id === args.afterBlockId);
    insertIndex = foundIndex >= 0 ? foundIndex + 1 : currentBlocks.length;
  } else {
    insertIndex = currentBlocks.length;
  }

  const nextBlocks: Block[] = [
    ...currentBlocks.slice(0, insertIndex),
    ...newBlocks,
    ...currentBlocks.slice(insertIndex),
  ];

  const nextPayload: WafflebaseDocumentPayload = { ...payload, blocks: nextBlocks };

  let content: string;
  try {
    content = serializeWriterHtml(parsed.document.manifest, nextPayload, {
      touchMetadata: true,
    });
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }

  let writeResult;
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
      status: "conflict",
      displayPath: envelope.displayPath,
      currentSha256: writeResult.currentSha256,
    };
  }

  if (writeResult.kind === "error") {
    return {
      ok: true,
      status: "error",
      displayPath: envelope.displayPath,
      message: writeResult.message,
    };
  }

  return {
    ok: true,
    status: "saved",
    displayPath: envelope.displayPath,
    insertedCount: newBlocks.length,
    sha256: writeResult.sha256,
    revision: writeResult.revision ?? null,
  };
}

type ReplaceOutcome = { matched: number; nextBlocks: Block[] };

function applyReplaceToBlocks(
  blocks: Block[],
  oldString: string,
  newString: string,
  replaceAll: boolean,
): ReplaceOutcome {
  let matched = 0;
  const nextBlocks: Block[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      nextBlocks.push(block);
      continue;
    }
    const inlines = Array.isArray(block.inlines) ? block.inlines : [];
    const nextInlines = inlines.map((inline) => {
      if (!inline || typeof inline !== "object" || typeof inline.text !== "string") {
        return inline;
      }
      if (replaceAll) {
        if (!inline.text.includes(oldString)) return inline;
        const occurrences = inline.text.split(oldString).length - 1;
        matched += occurrences;
        return { ...inline, text: inline.text.split(oldString).join(newString) };
      }
      if (matched > 0 || !inline.text.includes(oldString)) {
        return inline;
      }
      matched += 1;
      return { ...inline, text: inline.text.replace(oldString, newString) };
    });
    nextBlocks.push({ ...block, inlines: nextInlines });
  }
  return { matched, nextBlocks };
}

export async function replaceText(
  args: ReplaceTextArgs,
  ctx: AgentToolContext,
): Promise<
  | {
      ok: true;
      status: "saved";
      displayPath: string;
      matched: number;
      sha256: string;
      revision?: number | null;
    }
  | {
      ok: true;
      status: "not_found";
      displayPath: string;
    }
  | {
      ok: true;
      status: "conflict";
      displayPath: string;
      currentSha256: string | null;
    }
  | {
      ok: true;
      status: "error";
      displayPath: string;
      message: string;
    }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;

  if (typeof args.oldString !== "string" || args.oldString.length === 0) {
    return toolError("oldString must be a non-empty string");
  }
  if (typeof args.newString !== "string") {
    return toolError("newString must be a string");
  }

  let envelope;
  try {
    envelope = await ctx.nautiloApp.document.read(target);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }

  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;

  const payload: WafflebaseDocumentPayload = parsed.document.document;
  const currentBlocks = (payload.blocks as Block[]).filter(
    (b): b is Block => b != null && typeof b === "object",
  );

  const replaceAll = args.replaceAll === true;
  const { matched, nextBlocks } = applyReplaceToBlocks(
    currentBlocks,
    args.oldString,
    args.newString,
    replaceAll,
  );

  if (matched === 0) {
    return { ok: true, status: "not_found", displayPath: envelope.displayPath };
  }

  const nextPayload: WafflebaseDocumentPayload = { ...payload, blocks: nextBlocks };

  let content: string;
  try {
    content = serializeWriterHtml(parsed.document.manifest, nextPayload, {
      touchMetadata: true,
    });
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }

  let writeResult;
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
      status: "conflict",
      displayPath: envelope.displayPath,
      currentSha256: writeResult.currentSha256,
    };
  }

  if (writeResult.kind === "error") {
    return {
      ok: true,
      status: "error",
      displayPath: envelope.displayPath,
      message: writeResult.message,
    };
  }

  return {
    ok: true,
    status: "saved",
    displayPath: envelope.displayPath,
    matched,
    sha256: writeResult.sha256,
    revision: writeResult.revision ?? null,
  };
}

// ---------------------------------------------------------------------------
// Shared write helper for the additional D372 tools. Inlines the same
// serialize → write → classify-outcome flow used by insertBlocks/replaceText
// so the new handlers stay consistent without duplicating the boilerplate.
// ---------------------------------------------------------------------------

type ReadEnvelope = {
  content: string;
  displayPath: string;
  baseSha256: string | null;
  baseRevision: number | null;
};

type WriteOutcome =
  | { kind: "saved"; sha256: string; revision?: number | null }
  | { kind: "conflict"; currentSha256: string | null }
  | { kind: "error"; message: string };

async function persistBlocks(
  ctx: AgentToolContext,
  target: AppDocumentTarget,
  envelope: ReadEnvelope,
  manifest: WriterHtmlManifest,
  nextPayload: WafflebaseDocumentPayload,
): Promise<WriteOutcome | ToolError> {
  let content: string;
  try {
    content = serializeWriterHtml(manifest, nextPayload, { touchMetadata: true });
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  let writeResult;
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
    return { kind: "conflict", currentSha256: writeResult.currentSha256 };
  }
  if (writeResult.kind === "error") {
    return { kind: "error", message: writeResult.message };
  }
  return { kind: "saved", sha256: writeResult.sha256, revision: writeResult.revision ?? null };
}

function classifyWrite(
  outcome: WriteOutcome | ToolError,
  displayPath: string,
  extra: Record<string, unknown>,
):
  | { ok: true; status: "saved"; displayPath: string; sha256: string; revision?: number | null }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError {
  if (!("kind" in outcome)) return outcome;
  if (outcome.kind === "conflict") {
    return { ok: true, status: "conflict", displayPath, currentSha256: outcome.currentSha256 };
  }
  if (outcome.kind === "error") {
    return { ok: true, status: "error", displayPath, message: outcome.message };
  }
  return { ok: true, status: "saved", displayPath, sha256: outcome.sha256, revision: outcome.revision ?? null, ...extra };
}

// --- set-block-type -------------------------------------------------------

function validateSetBlockTypeArgs(args: SetBlockTypeArgs): ToolError | null {
  if (!validateBlockId(args.blockId)) {
    return toolError("blockId must be a non-empty string");
  }
  if (!isTextBlockType(args.toType)) {
    return toolError(
      'toType must be "paragraph", "title", "subtitle", "heading", or "list-item"',
    );
  }
  if (args.headingLevel !== undefined && args.headingLevel !== 1 && args.headingLevel !== 2 && args.headingLevel !== 3) {
    return toolError("headingLevel must be 1, 2, or 3");
  }
  if (args.listKind !== undefined && args.listKind !== "ordered" && args.listKind !== "unordered") {
    return toolError('listKind must be "ordered" or "unordered"');
  }
  if (args.listLevel !== undefined && (typeof args.listLevel !== "number" || !Number.isFinite(args.listLevel) || args.listLevel < 0)) {
    return toolError("listLevel must be a non-negative number");
  }
  if (args.toType === "heading" && args.listKind !== undefined) {
    return toolError('listKind is not valid for "heading" blocks');
  }
  if (args.toType === "list-item" && args.headingLevel !== undefined) {
    return toolError("headingLevel is not valid for \"list-item\" blocks");
  }
  if ((args.toType === "paragraph" || args.toType === "title" || args.toType === "subtitle") &&
      (args.headingLevel !== undefined || args.listKind !== undefined || args.listLevel !== undefined)) {
    return toolError(`headingLevel, listKind, and listLevel are not valid for "${args.toType}" blocks`);
  }
  return null;
}

function convertBlockType(
  block: Block,
  toType: TextBlockType,
  opts: { headingLevel?: 1 | 2 | 3; listKind?: "ordered" | "unordered"; listLevel?: number },
): Block {
  const next: Block = { ...block, type: toType };
  // Clear text-block-specific fields, then re-apply as needed for the target.
  delete (next as { headingLevel?: number }).headingLevel;
  delete (next as { listKind?: string }).listKind;
  delete (next as { listLevel?: number }).listLevel;
  if (toType === "heading") {
    next.headingLevel = opts.headingLevel ?? 1;
  } else if (toType === "list-item") {
    next.listKind = opts.listKind ?? "unordered";
    next.listLevel = opts.listLevel ?? 0;
  }
  return next;
}

export async function setBlockType(
  args: SetBlockTypeArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; status: "saved"; displayPath: string; blockId: string; toType: TextBlockType; sha256: string; revision?: number | null }
  | { ok: true; status: "not_found"; displayPath: string }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;
  const argError = validateSetBlockTypeArgs(args);
  if (argError) return argError;
  const blockId = args.blockId;

  let envelope;
  try {
    envelope = await ctx.nautiloApp.document.read(target);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;

  const payload: WafflebaseDocumentPayload = parsed.document.document;
  const currentBlocks = payload.blocks as Block[];
  const idx = currentBlocks.findIndex((b) => b?.id === blockId);
  if (idx < 0) {
    return { ok: true, status: "not_found", displayPath: envelope.displayPath };
  }
  const targetBlock = currentBlocks[idx]!;
  if (!isTextBlockType(targetBlock.type)) {
    return toolError(
      `block "${blockId}" has non-convertible type "${targetBlock.type}" (only paragraph/title/subtitle/heading/list-item can be converted)`,
    );
  }
  const nextBlocks = currentBlocks.slice();
  nextBlocks[idx] = convertBlockType(targetBlock, args.toType, {
    ...(args.headingLevel === undefined ? {} : { headingLevel: args.headingLevel }),
    ...(args.listKind === undefined ? {} : { listKind: args.listKind }),
    ...(args.listLevel === undefined ? {} : { listLevel: args.listLevel }),
  });
  const nextPayload: WafflebaseDocumentPayload = { ...payload, blocks: nextBlocks };

  const outcome = await persistBlocks(ctx, target, envelope, parsed.document.manifest, nextPayload);
  return classifyWrite(outcome, envelope.displayPath, {
    blockId,
    toType: args.toType,
  }) as
    | { ok: true; status: "saved"; displayPath: string; blockId: string; toType: TextBlockType; sha256: string; revision?: number | null }
    | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
    | { ok: true; status: "error"; displayPath: string; message: string }
    | ToolError;
}

// --- apply-block-style ----------------------------------------------------

function validateApplyBlockStyleArgs(args: ApplyBlockStyleArgs): ToolError | null {
  if (!validateBlockId(args.blockId)) {
    return toolError("blockId must be a non-empty string");
  }
  const result = validateBlockStyle(args.style);
  return result.ok ? null : styleToolError(result);
}

export async function applyBlockStyle(
  args: ApplyBlockStyleArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; status: "saved"; displayPath: string; blockId: string; sha256: string; revision?: number | null }
  | { ok: true; status: "not_found"; displayPath: string }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;
  const argError = validateApplyBlockStyleArgs(args);
  if (argError) return argError;
  const blockId = args.blockId;

  let envelope;
  try {
    envelope = await ctx.nautiloApp.document.read(target);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;

  const payload: WafflebaseDocumentPayload = parsed.document.document;
  const currentBlocks = payload.blocks as Block[];
  const idx = currentBlocks.findIndex((b) => b?.id === blockId);
  if (idx < 0) {
    return { ok: true, status: "not_found", displayPath: envelope.displayPath };
  }
  const block = currentBlocks[idx]!;
  const patch: Partial<BlockStyle> = {};
  const s = args.style;
  if (s.alignment !== undefined) patch.alignment = s.alignment;
  if (s.lineHeight !== undefined) patch.lineHeight = s.lineHeight;
  if (s.marginTop !== undefined) patch.marginTop = s.marginTop;
  if (s.marginBottom !== undefined) patch.marginBottom = s.marginBottom;
  if (s.textIndent !== undefined) patch.textIndent = s.textIndent;
  if (s.marginLeft !== undefined) patch.marginLeft = s.marginLeft;
  const nextStyle = normalizeBlockStyle({ ...block.style, ...patch });
  const nextBlocks = currentBlocks.slice();
  nextBlocks[idx] = { ...block, style: nextStyle };
  const nextPayload: WafflebaseDocumentPayload = { ...payload, blocks: nextBlocks };

  const outcome = await persistBlocks(ctx, target, envelope, parsed.document.manifest, nextPayload);
  return classifyWrite(outcome, envelope.displayPath, { blockId }) as
    | { ok: true; status: "saved"; displayPath: string; blockId: string; sha256: string; revision?: number | null }
    | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
    | { ok: true; status: "error"; displayPath: string; message: string }
    | ToolError;
}

// --- format-text ----------------------------------------------------------

function validateFormatTextStyle(style: unknown): FormatTextStyle | ToolError {
  const result = validateInlineStyle<FormatTextStyle>(style, "closed");
  return result.ok ? result.value : styleToolError(result);
}

function buildFormatStylePatch(input: FormatTextStyle): Partial<InlineStyle> {
  if (input.clear === true) return { ...CLEAR_INLINE_STYLE };
  const patch: Partial<InlineStyle> = {};
  if (input.bold !== undefined) patch.bold = input.bold;
  if (input.italic !== undefined) patch.italic = input.italic;
  if (input.underline !== undefined) patch.underline = input.underline;
  if (input.strikethrough !== undefined) patch.strikethrough = input.strikethrough;
  if (input.superscript !== undefined) patch.superscript = input.superscript;
  if (input.subscript !== undefined) patch.subscript = input.subscript;
  if (input.fontSize !== undefined) patch.fontSize = input.fontSize;
  if (input.fontFamily !== undefined) patch.fontFamily = input.fontFamily;
  if (input.color !== undefined) patch.color = input.color;
  if (input.backgroundColor !== undefined) patch.backgroundColor = input.backgroundColor;
  if (input.href !== undefined) patch.href = input.href;
  return patch;
}

export async function formatText(
  args: FormatTextArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; status: "saved"; displayPath: string; blockId: string; matched: number; sha256: string; revision?: number | null }
  | { ok: true; status: "not_found"; displayPath: string }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;
  if (!validateBlockId(args.blockId)) {
    return toolError("blockId must be a non-empty string");
  }
  const blockId = args.blockId;
  if (typeof args.from !== "number" || !Number.isFinite(args.from) || args.from < 0 || !Number.isInteger(args.from)) {
    return toolError("from must be a non-negative integer");
  }
  const to = args.to;
  if (to !== undefined) {
    if (typeof to !== "number" || !Number.isFinite(to) || to < 0 || !Number.isInteger(to)) {
      return toolError("to must be a non-negative integer");
    }
    if (to < args.from) return toolError("to must be greater than or equal to from");
  }
  const styleResult = validateFormatTextStyle(args.style);
  if ((styleResult as { ok?: boolean }).ok === false) {
    return styleResult as ToolError;
  }
  const style = styleResult as FormatTextStyle;

  let envelope;
  try {
    envelope = await ctx.nautiloApp.document.read(target);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;

  const payload: WafflebaseDocumentPayload = parsed.document.document;
  const currentBlocks = payload.blocks as Block[];
  const idx = currentBlocks.findIndex((b) => b?.id === blockId);
  if (idx < 0) {
    return { ok: true, status: "not_found", displayPath: envelope.displayPath };
  }
  const block = currentBlocks[idx]!;
  if (!isTextBlockType(block.type)) {
    return toolError(
      `block "${blockId}" has type "${block.type}" which does not carry inline text`,
    );
  }
  const length = getBlockTextLength(block);
  const fromClamped = Math.min(args.from, length);
  const toClamped = Math.min(to ?? length, length);
  if (fromClamped === toClamped) {
    // Empty range: nothing to format. Treat as not_found so callers don't
    // write a no-op revision.
    return { ok: true, status: "not_found", displayPath: envelope.displayPath };
  }
  const patch = buildFormatStylePatch(style);
  const nextBlock = applyInlineStyleHelper(block, fromClamped, toClamped, patch);
  const nextBlocks = currentBlocks.slice();
  nextBlocks[idx] = nextBlock;
  const nextPayload: WafflebaseDocumentPayload = { ...payload, blocks: nextBlocks };

  const outcome = await persistBlocks(ctx, target, envelope, parsed.document.manifest, nextPayload);
  return classifyWrite(outcome, envelope.displayPath, { blockId, matched: 1 }) as
    | { ok: true; status: "saved"; displayPath: string; blockId: string; matched: number; sha256: string; revision?: number | null }
    | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
    | { ok: true; status: "error"; displayPath: string; message: string }
    | ToolError;
}

// --- delete-blocks --------------------------------------------------------

function validateBlockIdsList(value: unknown, field: string): string[] | ToolError {
  if (!Array.isArray(value)) return toolError(`${field} must be an array`);
  if (value.length === 0) return toolError(`${field} must contain at least one id`);
  if (value.length > BLOCK_IDS_MAX) return toolError(`${field} length exceeds maximum (${BLOCK_IDS_MAX})`);
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const id = validateBlockId(value[i]);
    if (!id) return toolError(`${field}[${i}] must be a non-empty string without control characters`);
    if (seen.has(id)) return toolError(`${field}[${i}] is duplicated`);
    seen.add(id);
  }
  return Array.from(seen);
}

export async function deleteBlocks(
  args: DeleteBlocksArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; status: "saved"; displayPath: string; deletedCount: number; sha256: string; revision?: number | null }
  | { ok: true; status: "not_found"; displayPath: string }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;
  const idsResult = validateBlockIdsList(args.blockIds, "blockIds");
  if (!Array.isArray(idsResult)) return idsResult;
  const ids = new Set(idsResult);

  let envelope;
  try {
    envelope = await ctx.nautiloApp.document.read(target);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;

  const payload: WafflebaseDocumentPayload = parsed.document.document;
  const currentBlocks = payload.blocks as Block[];
  const nextBlocks: Block[] = [];
  let deleted = 0;
  for (const b of currentBlocks) {
    if (b && ids.has(b.id)) {
      deleted += 1;
      continue;
    }
    nextBlocks.push(b);
  }
  if (deleted === 0) {
    return { ok: true, status: "not_found", displayPath: envelope.displayPath };
  }
  const nextPayload: WafflebaseDocumentPayload = { ...payload, blocks: nextBlocks };

  const outcome = await persistBlocks(ctx, target, envelope, parsed.document.manifest, nextPayload);
  return classifyWrite(outcome, envelope.displayPath, { deletedCount: deleted }) as
    | { ok: true; status: "saved"; displayPath: string; deletedCount: number; sha256: string; revision?: number | null }
    | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
    | { ok: true; status: "error"; displayPath: string; message: string }
    | ToolError;
}

// --- move-blocks ----------------------------------------------------------

export async function moveBlocks(
  args: MoveBlocksArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; status: "saved"; displayPath: string; movedCount: number; sha256: string; revision?: number | null }
  | { ok: true; status: "not_found"; displayPath: string }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;
  if (args.position !== "start" && args.position !== "end" && args.position !== "after") {
    return toolError('position must be "start", "end", or "after"');
  }
  if (args.position === "after" && !validateBlockId(args.afterBlockId)) {
    return toolError("afterBlockId must be a non-empty string when position is \"after\"");
  }
  const idsResult = validateBlockIdsList(args.blockIds, "blockIds");
  if (!Array.isArray(idsResult)) return idsResult;
  const ids = new Set(idsResult);
  if (args.position === "after" && args.afterBlockId && ids.has(args.afterBlockId)) {
    return toolError("afterBlockId cannot be one of the blockIds being moved");
  }

  let envelope;
  try {
    envelope = await ctx.nautiloApp.document.read(target);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;

  const payload: WafflebaseDocumentPayload = parsed.document.document;
  const currentBlocks = payload.blocks as Block[];
  const moved: Block[] = [];
  const remaining: Block[] = [];
  for (const b of currentBlocks) {
    if (b && ids.has(b.id)) moved.push(b);
    else remaining.push(b);
  }
  if (moved.length === 0) {
    return { ok: true, status: "not_found", displayPath: envelope.displayPath };
  }
  let insertIndex: number;
  if (args.position === "start") {
    insertIndex = 0;
  } else if (args.position === "end") {
    insertIndex = remaining.length;
  } else {
    const idx = remaining.findIndex((b) => b?.id === args.afterBlockId);
    if (idx < 0) {
      return toolError(`afterBlockId "${args.afterBlockId}" was not found`);
    }
    insertIndex = idx + 1;
  }
  const nextBlocks = [
    ...remaining.slice(0, insertIndex),
    ...moved,
    ...remaining.slice(insertIndex),
  ];
  const nextPayload: WafflebaseDocumentPayload = { ...payload, blocks: nextBlocks };

  const outcome = await persistBlocks(ctx, target, envelope, parsed.document.manifest, nextPayload);
  return classifyWrite(outcome, envelope.displayPath, { movedCount: moved.length }) as
    | { ok: true; status: "saved"; displayPath: string; movedCount: number; sha256: string; revision?: number | null }
    | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
    | { ok: true; status: "error"; displayPath: string; message: string }
    | ToolError;
}

// --- insert-table ---------------------------------------------------------

function validateInsertTableArgs(args: InsertTableArgs): ToolError | null {
  if (typeof args.rows !== "number" || !Number.isInteger(args.rows) || args.rows < 1) {
    return toolError("rows must be a positive integer");
  }
  if (typeof args.cols !== "number" || !Number.isInteger(args.cols) || args.cols < 1) {
    return toolError("cols must be a positive integer");
  }
  if (args.rows > TABLE_ROWS_MAX) return toolError(`rows exceeds maximum (${TABLE_ROWS_MAX})`);
  if (args.cols > TABLE_COLS_MAX) return toolError(`cols exceeds maximum (${TABLE_COLS_MAX})`);
  if (args.rows * args.cols > TABLE_CELLS_MAX) {
    return toolError(`table cell count exceeds maximum (${TABLE_CELLS_MAX})`);
  }
  if (args.afterBlockId !== undefined && !validateBlockId(args.afterBlockId)) {
    return toolError("afterBlockId must be a non-empty string");
  }
  if (args.cells !== undefined && (!Array.isArray(args.cells) || args.cells.length !== args.rows ||
      args.cells.some(row => !Array.isArray(row) || row.length !== args.cols ||
        row.some(text => typeof text !== "string")))) {
    return toolError("cells must contain exactly rows arrays of cols strings");
  }
  return null;
}

export async function insertTable(
  args: InsertTableArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; status: "saved"; displayPath: string; insertedCount: number; blockId: string; sha256: string; revision?: number | null }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;
  const argError = validateInsertTableArgs(args);
  if (argError) return argError;

  let envelope;
  try {
    envelope = await ctx.nautiloApp.document.read(target);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;

  const payload: WafflebaseDocumentPayload = parsed.document.document;
  const currentBlocks = payload.blocks as Block[];

  const tableBlock = createTableBlock(args.rows, args.cols);
  if (args.cells && tableBlock.tableData) {
    for (const [rowIndex, row] of tableBlock.tableData.rows.entries()) {
      for (const [colIndex, cell] of row.cells.entries()) {
        const paragraph = cell.blocks[0];
        if (paragraph) paragraph.inlines = [{ text: args.cells[rowIndex]![colIndex]!, style: {} }];
      }
    }
  }

  let insertIndex: number;
  if (args.afterBlockId && typeof args.afterBlockId === "string") {
    const foundIndex = currentBlocks.findIndex((b) => b?.id === args.afterBlockId);
    insertIndex = foundIndex >= 0 ? foundIndex + 1 : currentBlocks.length;
  } else {
    insertIndex = currentBlocks.length;
  }
  const nextBlocks = [
    ...currentBlocks.slice(0, insertIndex),
    tableBlock,
    ...currentBlocks.slice(insertIndex),
  ];
  const nextPayload: WafflebaseDocumentPayload = { ...payload, blocks: nextBlocks };

  const outcome = await persistBlocks(ctx, target, envelope, parsed.document.manifest, nextPayload);
  const classified = classifyWrite(outcome, envelope.displayPath, {
    insertedCount: 1,
    blockId: tableBlock.id,
  });
  if (!("ok" in classified) || !classified.ok) return classified;
  if (classified.status !== "saved") {
    return classified as
      | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
      | { ok: true; status: "error"; displayPath: string; message: string };
  }
  return classified as { ok: true; status: "saved"; displayPath: string; insertedCount: number; blockId: string; sha256: string; revision?: number | null };
}

// ---------------------------------------------------------------------------
// D372 parity: table structure edits, cell style, delete-table, indent/outdent.
// Each handler operates directly on the plain Wafflebase block model (no Doc
// store), mirroring the semantics in `EXTERNAL/wafflebase/.../model/document.ts`
// (insertRow/deleteRow/insertColumn/deleteColumn/mergeCells/splitCell/
// applyCellStyle) so agent mutations match the human ribbon over the same
// model. `normalizeTableMerges` is not exported from `@nautilo/office-docs`, so
// merge is constrained to ranges of fully-unmerged cells — no repair needed.
// ---------------------------------------------------------------------------

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function findTableBlock(
  payload: WafflebaseDocumentPayload,
  blockId: string,
): { block: Block; index: number } | null {
  const blocks = payload.blocks as Block[];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b && b.id === blockId && b.type === "table" && b.tableData) {
      return { block: b, index: i };
    }
  }
  return null;
}

// --- insert-table-row -----------------------------------------------------

function validateInsertTableRowArgs(args: InsertTableRowArgs): ToolError | null {
  if (!validateBlockId(args.blockId)) return toolError("blockId must be a non-empty string");
  if (!isNonNegativeInt(args.rowIndex)) return toolError("rowIndex must be a non-negative integer");
  if (args.rowIndex > TABLE_ROW_INDEX_MAX) return toolError(`rowIndex exceeds maximum (${TABLE_ROW_INDEX_MAX})`);
  return null;
}

export async function insertTableRow(
  args: InsertTableRowArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; status: "saved"; displayPath: string; blockId: string; rowCount: number; sha256: string; revision?: number | null }
  | { ok: true; status: "not_found"; displayPath: string }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;
  const argError = validateInsertTableRowArgs(args);
  if (argError) return argError;

  let envelope;
  try { envelope = await ctx.nautiloApp.document.read(target); }
  catch (err) { return toolError(err instanceof Error ? err.message : String(err)); }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;

  const payload = parsed.document.document;
  const found = findTableBlock(payload, args.blockId);
  if (!found) return { ok: true, status: "not_found", displayPath: envelope.displayPath };
  const source = found.block.tableData!;
  if (args.rowIndex > source.rows.length) {
    return toolError(`rowIndex exceeds current row count (${source.rows.length})`);
  }
  const result = insertCanonicalTableRow(source, args.rowIndex);
  if (!result.ok) return toolError(result.message);
  const td = result.tableData;

  const currentBlocks = payload.blocks as Block[];
  const nextBlocks = currentBlocks.slice();
  nextBlocks[found.index] = { ...found.block, tableData: td };
  const nextPayload: WafflebaseDocumentPayload = { ...payload, blocks: nextBlocks };

  const outcome = await persistBlocks(ctx, target, envelope, parsed.document.manifest, nextPayload);
  return classifyWrite(outcome, envelope.displayPath, { blockId: args.blockId, rowCount: td.rows.length }) as
    | { ok: true; status: "saved"; displayPath: string; blockId: string; rowCount: number; sha256: string; revision?: number | null }
    | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
    | { ok: true; status: "error"; displayPath: string; message: string }
    | ToolError;
}

// --- delete-table-row -----------------------------------------------------

function validateDeleteTableRowArgs(args: DeleteTableRowArgs): ToolError | null {
  if (!validateBlockId(args.blockId)) return toolError("blockId must be a non-empty string");
  if (!isNonNegativeInt(args.rowIndex)) return toolError("rowIndex must be a non-negative integer");
  return null;
}

export async function deleteTableRow(
  args: DeleteTableRowArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; status: "saved"; displayPath: string; blockId: string; rowCount: number; sha256: string; revision?: number | null }
  | { ok: true; status: "not_found"; displayPath: string }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;
  const argError = validateDeleteTableRowArgs(args);
  if (argError) return argError;

  let envelope;
  try { envelope = await ctx.nautiloApp.document.read(target); }
  catch (err) { return toolError(err instanceof Error ? err.message : String(err)); }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;

  const payload = parsed.document.document;
  const found = findTableBlock(payload, args.blockId);
  if (!found) return { ok: true, status: "not_found", displayPath: envelope.displayPath };
  const source = found.block.tableData!;
  if (args.rowIndex >= source.rows.length) {
    return toolError(`rowIndex out of range (table has ${source.rows.length} rows)`);
  }
  if (source.rows.length <= 1) {
    return toolError("cannot delete the last row of a table");
  }
  const result = deleteCanonicalTableRow(source, args.rowIndex);
  if (!result.ok) return toolError(result.message);
  const td = result.tableData;

  const currentBlocks = payload.blocks as Block[];
  const nextBlocks = currentBlocks.slice();
  nextBlocks[found.index] = { ...found.block, tableData: td };
  const nextPayload: WafflebaseDocumentPayload = { ...payload, blocks: nextBlocks };

  const outcome = await persistBlocks(ctx, target, envelope, parsed.document.manifest, nextPayload);
  return classifyWrite(outcome, envelope.displayPath, { blockId: args.blockId, rowCount: td.rows.length }) as
    | { ok: true; status: "saved"; displayPath: string; blockId: string; rowCount: number; sha256: string; revision?: number | null }
    | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
    | { ok: true; status: "error"; displayPath: string; message: string }
    | ToolError;
}

// --- insert-table-column --------------------------------------------------

function validateInsertTableColumnArgs(args: InsertTableColumnArgs): ToolError | null {
  if (!validateBlockId(args.blockId)) return toolError("blockId must be a non-empty string");
  if (!isNonNegativeInt(args.colIndex)) return toolError("colIndex must be a non-negative integer");
  if (args.colIndex > TABLE_COL_INDEX_MAX) return toolError(`colIndex exceeds maximum (${TABLE_COL_INDEX_MAX})`);
  return null;
}

export async function insertTableColumn(
  args: InsertTableColumnArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; status: "saved"; displayPath: string; blockId: string; colCount: number; sha256: string; revision?: number | null }
  | { ok: true; status: "not_found"; displayPath: string }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;
  const argError = validateInsertTableColumnArgs(args);
  if (argError) return argError;

  let envelope;
  try { envelope = await ctx.nautiloApp.document.read(target); }
  catch (err) { return toolError(err instanceof Error ? err.message : String(err)); }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;

  const payload = parsed.document.document;
  const found = findTableBlock(payload, args.blockId);
  if (!found) return { ok: true, status: "not_found", displayPath: envelope.displayPath };
  const source = found.block.tableData!;
  if (args.colIndex > source.columnWidths.length) {
    return toolError(`colIndex exceeds current column count (${source.columnWidths.length})`);
  }
  if (source.columnWidths.length + 1 > TABLE_COLS_MAX) {
    return toolError(`column count exceeds maximum (${TABLE_COLS_MAX})`);
  }
  const result = insertCanonicalTableColumn(source, args.colIndex);
  if (!result.ok) return toolError(result.message);
  const td = result.tableData;

  const currentBlocks = payload.blocks as Block[];
  const nextBlocks = currentBlocks.slice();
  nextBlocks[found.index] = { ...found.block, tableData: td };
  const nextPayload: WafflebaseDocumentPayload = { ...payload, blocks: nextBlocks };

  const outcome = await persistBlocks(ctx, target, envelope, parsed.document.manifest, nextPayload);
  return classifyWrite(outcome, envelope.displayPath, { blockId: args.blockId, colCount: td.columnWidths.length }) as
    | { ok: true; status: "saved"; displayPath: string; blockId: string; colCount: number; sha256: string; revision?: number | null }
    | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
    | { ok: true; status: "error"; displayPath: string; message: string }
    | ToolError;
}

// --- delete-table-column --------------------------------------------------

function validateDeleteTableColumnArgs(args: DeleteTableColumnArgs): ToolError | null {
  if (!validateBlockId(args.blockId)) return toolError("blockId must be a non-empty string");
  if (!isNonNegativeInt(args.colIndex)) return toolError("colIndex must be a non-negative integer");
  return null;
}

export async function deleteTableColumn(
  args: DeleteTableColumnArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; status: "saved"; displayPath: string; blockId: string; colCount: number; sha256: string; revision?: number | null }
  | { ok: true; status: "not_found"; displayPath: string }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;
  const argError = validateDeleteTableColumnArgs(args);
  if (argError) return argError;

  let envelope;
  try { envelope = await ctx.nautiloApp.document.read(target); }
  catch (err) { return toolError(err instanceof Error ? err.message : String(err)); }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;

  const payload = parsed.document.document;
  const found = findTableBlock(payload, args.blockId);
  if (!found) return { ok: true, status: "not_found", displayPath: envelope.displayPath };
  const source = found.block.tableData!;
  if (args.colIndex >= source.columnWidths.length) {
    return toolError(`colIndex out of range (table has ${source.columnWidths.length} columns)`);
  }
  if (source.columnWidths.length <= 1) {
    return toolError("cannot delete the last column of a table");
  }
  const result = deleteCanonicalTableColumn(source, args.colIndex);
  if (!result.ok) return toolError(result.message);
  const td = result.tableData;

  const currentBlocks = payload.blocks as Block[];
  const nextBlocks = currentBlocks.slice();
  nextBlocks[found.index] = { ...found.block, tableData: td };
  const nextPayload: WafflebaseDocumentPayload = { ...payload, blocks: nextBlocks };

  const outcome = await persistBlocks(ctx, target, envelope, parsed.document.manifest, nextPayload);
  return classifyWrite(outcome, envelope.displayPath, { blockId: args.blockId, colCount: td.columnWidths.length }) as
    | { ok: true; status: "saved"; displayPath: string; blockId: string; colCount: number; sha256: string; revision?: number | null }
    | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
    | { ok: true; status: "error"; displayPath: string; message: string }
    | ToolError;
}

// --- merge-table-cells ----------------------------------------------------

function validateCellAddress(value: unknown, label: string): CellAddress | ToolError {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return toolError(`${label} must be an object`);
  }
  const rec = value as Record<string, unknown>;
  if (!isNonNegativeInt(rec["rowIndex"])) return toolError(`${label}.rowIndex must be a non-negative integer`);
  if (!isNonNegativeInt(rec["colIndex"])) return toolError(`${label}.colIndex must be a non-negative integer`);
  return { rowIndex: rec["rowIndex"], colIndex: rec["colIndex"] };
}

export async function mergeTableCells(
  args: MergeTableCellsArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; status: "saved"; displayPath: string; blockId: string; sha256: string; revision?: number | null }
  | { ok: true; status: "not_found"; displayPath: string }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;
  if (!validateBlockId(args.blockId)) return toolError("blockId must be a non-empty string");
  const startRes = validateCellAddress(args.start, "start");
  if (!("rowIndex" in startRes)) return startRes;
  const endRes = validateCellAddress(args.end, "end");
  if (!("rowIndex" in endRes)) return endRes;
  const start = startRes;
  const end = endRes;
  // Normalize so start <= end in both axes.
  const r0 = Math.min(start.rowIndex, end.rowIndex);
  const r1 = Math.max(start.rowIndex, end.rowIndex);
  const c0 = Math.min(start.colIndex, end.colIndex);
  const c1 = Math.max(start.colIndex, end.colIndex);
  if (r0 === r1 && c0 === c1) {
    return toolError("merge range must cover at least two cells");
  }

  let envelope;
  try { envelope = await ctx.nautiloApp.document.read(target); }
  catch (err) { return toolError(err instanceof Error ? err.message : String(err)); }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;

  const payload = parsed.document.document;
  const found = findTableBlock(payload, args.blockId);
  if (!found) return { ok: true, status: "not_found", displayPath: envelope.displayPath };
  const source = found.block.tableData!;
  const numRows = source.rows.length;
  const numCols = source.columnWidths.length;
  if (r1 >= numRows || c1 >= numCols) {
    return toolError(`merge range out of bounds (table is ${numRows}x${numCols})`);
  }
  // Refuse to merge over cells that are already part of a merge. The model's
  // `normalizeTableMerges` could repair some of these, but it isn't exported
  // from `@nautilo/office-docs`; the safe, model-safe rule is to require a clean
  // rectangle of unmerged cells.
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = source.rows[r]!.cells[c]!;
      if ((cell.colSpan ?? 1) > 1 || (cell.rowSpan ?? 1) > 1 || cell.colSpan === 0) {
        return toolError(`cell at (${r},${c}) is already merged; split it before re-merging`);
      }
    }
  }
  const result = mergeCanonicalTableCells(source, start, end);
  if (!result.ok) return toolError(result.message);
  const td = result.tableData;

  const currentBlocks = payload.blocks as Block[];
  const nextBlocks = currentBlocks.slice();
  nextBlocks[found.index] = { ...found.block, tableData: td };
  const nextPayload: WafflebaseDocumentPayload = { ...payload, blocks: nextBlocks };

  const outcome = await persistBlocks(ctx, target, envelope, parsed.document.manifest, nextPayload);
  return classifyWrite(outcome, envelope.displayPath, { blockId: args.blockId }) as
    | { ok: true; status: "saved"; displayPath: string; blockId: string; sha256: string; revision?: number | null }
    | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
    | { ok: true; status: "error"; displayPath: string; message: string }
    | ToolError;
}

// --- split-table-cell -----------------------------------------------------

export async function splitTableCell(
  args: SplitTableCellArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; status: "saved"; displayPath: string; blockId: string; sha256: string; revision?: number | null }
  | { ok: true; status: "not_found"; displayPath: string }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;
  if (!validateBlockId(args.blockId)) return toolError("blockId must be a non-empty string");
  if (!isNonNegativeInt(args.rowIndex)) return toolError("rowIndex must be a non-negative integer");
  if (!isNonNegativeInt(args.colIndex)) return toolError("colIndex must be a non-negative integer");

  let envelope;
  try { envelope = await ctx.nautiloApp.document.read(target); }
  catch (err) { return toolError(err instanceof Error ? err.message : String(err)); }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;

  const payload = parsed.document.document;
  const found = findTableBlock(payload, args.blockId);
  if (!found) return { ok: true, status: "not_found", displayPath: envelope.displayPath };
  const source = found.block.tableData!;
  if (args.rowIndex >= source.rows.length || args.colIndex >= source.columnWidths.length) {
    return toolError(`cell address out of bounds (table is ${source.rows.length}x${source.columnWidths.length})`);
  }
  const targetCell = source.rows[args.rowIndex]!.cells[args.colIndex]!;
  const rowSpan = targetCell.rowSpan ?? 1;
  const colSpan = targetCell.colSpan ?? 1;
  if (colSpan <= 1 && rowSpan <= 1) {
    return toolError("cell at (rowIndex, colIndex) is not merged");
  }
  const result = splitCanonicalTableCell(source, { rowIndex: args.rowIndex, colIndex: args.colIndex });
  if (!result.ok) return toolError(result.message);
  const td = result.tableData;

  const currentBlocks = payload.blocks as Block[];
  const nextBlocks = currentBlocks.slice();
  nextBlocks[found.index] = { ...found.block, tableData: td };
  const nextPayload: WafflebaseDocumentPayload = { ...payload, blocks: nextBlocks };

  const outcome = await persistBlocks(ctx, target, envelope, parsed.document.manifest, nextPayload);
  return classifyWrite(outcome, envelope.displayPath, { blockId: args.blockId }) as
    | { ok: true; status: "saved"; displayPath: string; blockId: string; sha256: string; revision?: number | null }
    | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
    | { ok: true; status: "error"; displayPath: string; message: string }
    | ToolError;
}

// --- set-table-cell-style -------------------------------------------------

function validateSetTableCellStyleArgs(args: SetTableCellStyleArgs): ToolError | null {
  if (!validateBlockId(args.blockId)) return toolError("blockId must be a non-empty string");
  if (!isNonNegativeInt(args.rowIndex)) return toolError("rowIndex must be a non-negative integer");
  if (!isNonNegativeInt(args.colIndex)) return toolError("colIndex must be a non-negative integer");
  const result = validateTableCellStyle(args.style);
  return result.ok ? null : styleToolError(result);
}

export async function setTableCellStyle(
  args: SetTableCellStyleArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; status: "saved"; displayPath: string; blockId: string; rowIndex: number; colIndex: number; sha256: string; revision?: number | null }
  | { ok: true; status: "not_found"; displayPath: string }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;
  const argError = validateSetTableCellStyleArgs(args);
  if (argError) return argError;

  let envelope;
  try { envelope = await ctx.nautiloApp.document.read(target); }
  catch (err) { return toolError(err instanceof Error ? err.message : String(err)); }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;

  const payload = parsed.document.document;
  const found = findTableBlock(payload, args.blockId);
  if (!found) return { ok: true, status: "not_found", displayPath: envelope.displayPath };
  const source = found.block.tableData!;
  if (args.rowIndex >= source.rows.length || args.colIndex >= source.columnWidths.length) {
    return toolError(`cell address out of bounds (table is ${source.rows.length}x${source.columnWidths.length})`);
  }
  // Skip covered (colSpan===0) cells — they're rendered as part of the
  // anchor. Agents must target the anchor cell to style a merged region.
  const cell = source.rows[args.rowIndex]!.cells[args.colIndex]!;
  if (cell.colSpan === 0) {
    return toolError(`cell at (${args.rowIndex},${args.colIndex}) is covered by a merge; style the anchor cell instead`);
  }
  const result = setCanonicalTableCellStyle(source, { rowIndex: args.rowIndex, colIndex: args.colIndex }, args.style);
  if (!result.ok) return toolError(result.message);
  const td = result.tableData;

  const currentBlocks = payload.blocks as Block[];
  const nextBlocks = currentBlocks.slice();
  nextBlocks[found.index] = { ...found.block, tableData: td };
  const nextPayload: WafflebaseDocumentPayload = { ...payload, blocks: nextBlocks };

  const outcome = await persistBlocks(ctx, target, envelope, parsed.document.manifest, nextPayload);
  return classifyWrite(outcome, envelope.displayPath, {
    blockId: args.blockId,
    rowIndex: args.rowIndex,
    colIndex: args.colIndex,
  }) as
    | { ok: true; status: "saved"; displayPath: string; blockId: string; rowIndex: number; colIndex: number; sha256: string; revision?: number | null }
    | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
    | { ok: true; status: "error"; displayPath: string; message: string }
    | ToolError;
}

// --- delete-table ---------------------------------------------------------

export async function deleteTable(
  args: DeleteTableArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; status: "saved"; displayPath: string; blockId: string; sha256: string; revision?: number | null }
  | { ok: true; status: "not_found"; displayPath: string }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;
  if (!validateBlockId(args.blockId)) return toolError("blockId must be a non-empty string");

  let envelope;
  try { envelope = await ctx.nautiloApp.document.read(target); }
  catch (err) { return toolError(err instanceof Error ? err.message : String(err)); }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;

  const payload = parsed.document.document;
  const currentBlocks = payload.blocks as Block[];
  const nextBlocks = deleteCanonicalTableBlock(currentBlocks, args.blockId);
  if (!nextBlocks) {
    return { ok: true, status: "not_found", displayPath: envelope.displayPath };
  }
  const nextPayload: WafflebaseDocumentPayload = { ...payload, blocks: nextBlocks };

  const outcome = await persistBlocks(ctx, target, envelope, parsed.document.manifest, nextPayload);
  return classifyWrite(outcome, envelope.displayPath, { blockId: args.blockId }) as
    | { ok: true; status: "saved"; displayPath: string; blockId: string; sha256: string; revision?: number | null }
    | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
    | { ok: true; status: "error"; displayPath: string; message: string }
    | ToolError;
}

// --- indent-blocks / outdent-blocks --------------------------------------

// Shared core: apply indent or outdent to a list of blocks. Returns the
// count of blocks actually changed (a block at the clamp boundary is a
// no-op for that block, but the call still saves if ANY block changed).
function applyIndentOutdent(
  currentBlocks: Block[],
  ids: Set<string>,
  direction: "indent" | "outdent",
): { nextBlocks: Block[]; changed: number } {
  let changed = 0;
  const nextBlocks: Block[] = [];
  for (const b of currentBlocks) {
    if (!b || !ids.has(b.id)) {
      nextBlocks.push(b);
      continue;
    }
    if (b.type === "list-item") {
      const currentLevel = b.listLevel ?? 0;
      const nextLevel = direction === "indent" ? currentLevel + 1 : currentLevel - 1;
      const clamped = Math.max(0, Math.min(MAX_LIST_LEVEL, nextLevel));
      if (clamped === currentLevel) {
        nextBlocks.push(b);
        continue;
      }
      nextBlocks.push({ ...b, listLevel: clamped });
      changed += 1;
    } else {
      const current = b.style?.marginLeft ?? 0;
      const next = direction === "indent" ? current + INDENT_STEP : Math.max(0, current - INDENT_STEP);
      if (next === current) {
        nextBlocks.push(b);
        continue;
      }
      nextBlocks.push({ ...b, style: normalizeBlockStyle({ ...b.style, marginLeft: next }) });
      changed += 1;
    }
  }
  return { nextBlocks, changed };
}

async function runIndentOutdent(
  args: IndentBlocksArgs,
  ctx: AgentToolContext,
  direction: "indent" | "outdent",
): Promise<
  | { ok: true; status: "saved"; displayPath: string; affectedCount: number; sha256: string; revision?: number | null }
  | { ok: true; status: "not_found"; displayPath: string }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError
> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;
  const idsResult = validateBlockIdsList(args.blockIds, "blockIds");
  if (!Array.isArray(idsResult)) return idsResult;
  const ids = new Set(idsResult);

  let envelope;
  try { envelope = await ctx.nautiloApp.document.read(target); }
  catch (err) { return toolError(err instanceof Error ? err.message : String(err)); }
  const parsed = parseDocument(envelope.content);
  if (!parsed.ok) return parsed;

  const payload = parsed.document.document;
  const currentBlocks = payload.blocks as Block[];
  const { nextBlocks, changed } = applyIndentOutdent(currentBlocks, ids, direction);
  if (changed === 0) {
    return { ok: true, status: "not_found", displayPath: envelope.displayPath };
  }
  const nextPayload: WafflebaseDocumentPayload = { ...payload, blocks: nextBlocks };
  const outcome = await persistBlocks(ctx, target, envelope, parsed.document.manifest, nextPayload);
  return classifyWrite(outcome, envelope.displayPath, { affectedCount: changed }) as
    | { ok: true; status: "saved"; displayPath: string; affectedCount: number; sha256: string; revision?: number | null }
    | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
    | { ok: true; status: "error"; displayPath: string; message: string }
    | ToolError;
}

export async function indentBlocks(
  args: IndentBlocksArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; status: "saved"; displayPath: string; affectedCount: number; sha256: string; revision?: number | null }
  | { ok: true; status: "not_found"; displayPath: string }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError
> {
  return runIndentOutdent(args, ctx, "indent");
}

export async function outdentBlocks(
  args: OutdentBlocksArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; status: "saved"; displayPath: string; affectedCount: number; sha256: string; revision?: number | null }
  | { ok: true; status: "not_found"; displayPath: string }
  | { ok: true; status: "conflict"; displayPath: string; currentSha256: string | null }
  | { ok: true; status: "error"; displayPath: string; message: string }
  | ToolError
> {
  return runIndentOutdent(args as IndentBlocksArgs, ctx, "outdent");
}

// ---------------------------------------------------------------------------
// D372 — import-docx / export-docx.
// ---------------------------------------------------------------------------

const IMPORT_DOCX_RELATIVE_PATH_MAX = 1024;
const IMPORT_DOCX_FILENAME_MAX = 256;

function validateCurrentFolderRelativePath(
  value: unknown,
  field: string,
): { ok: true; relativePath: string } | ToolError {
  if (typeof value !== "string" || value.length === 0) {
    return toolError(`${field} must be a non-empty string`);
  }
  if (value.length > 1024) {
    return toolError(`${field} length exceeds maximum (${IMPORT_DOCX_RELATIVE_PATH_MAX})`);
  }
  if (
    value.includes("..") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    hasControlChars(value)
  ) {
    return toolError(`${field} must be a safe relative path (no "..", no leading slash, no control chars)`);
  }
  return { ok: true, relativePath: value };
}

function validateWorkspacePath(value: unknown, field: string): { ok: true; path: string } | ToolError {
  if (typeof value !== "string" || value.trim().length === 0) {
    return toolError(`${field} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > 4096) return toolError(`${field} length exceeds maximum (4096)`);
  if (trimmed.startsWith("/")) return toolError(`${field} must not start with "/"`);
  if (trimmed.split("/").some((seg) => seg === "..")) {
    return toolError(`${field} must not contain ".." segments`);
  }
  if (hasControlChars(trimmed)) return toolError(`${field} must not contain control characters`);
  return { ok: true, path: trimmed };
}

function validateOptionalFileName(value: unknown): { ok: true; fileName: string | undefined } | ToolError {
  if (value === undefined) return { ok: true, fileName: undefined };
  if (typeof value !== "string") return toolError("fileName must be a string");
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, fileName: undefined };
  if (trimmed.length > IMPORT_DOCX_FILENAME_MAX) {
    return toolError(`fileName length exceeds maximum (${IMPORT_DOCX_FILENAME_MAX})`);
  }
  if (hasControlChars(trimmed)) return toolError("fileName must not contain control characters");
  return { ok: true, fileName: trimmed };
}

export async function importDocx(
  args: ImportDocxArgs,
  ctx: AgentToolContext,
): Promise<
  | {
      ok: true;
      status: "imported";
      artifactPath: string;
      displayPath: string;
      sha256: string;
      skippedCount: number;
      blockCount: number;
    }
  | ConversionConflict
  | { ok: true; status: "failed"; code: string; message: string }
  | ToolError
> {
  if (!args || typeof args !== "object") return toolError("args must be an object");
  if (!args.source || typeof args.source !== "object") {
    return toolError("source must be an object");
  }
  if (args.source.surface !== "currentFolder" && args.source.surface !== "workspace") {
    return toolError('source.surface must be "currentFolder" or "workspace"');
  }
  const sourcePathResult =
    args.source.surface === "currentFolder"
      ? validateCurrentFolderRelativePath(args.source.path, "source.path")
      : validateWorkspacePath(args.source.path, "source.path");
  if (!sourcePathResult.ok) return sourcePathResult;
  const sourcePath =
    "relativePath" in sourcePathResult ? sourcePathResult.relativePath : sourcePathResult.path;
  // Import target mirrors the source surface: a current-folder .docx imports
  // to the current folder (next to the source); a workspace artifact imports
  // to the workspace. Validate the target path against the mirrored surface.
  const targetSurface = args.source.surface;
  const targetPathResult =
    targetSurface === "currentFolder"
      ? validateCurrentFolderRelativePath(args.targetPath, "targetPath")
      : validateWorkspacePath(args.targetPath, "targetPath");
  if (!targetPathResult.ok) return targetPathResult;
  const targetPath =
    "relativePath" in targetPathResult ? targetPathResult.relativePath : targetPathResult.path;
  if (!targetPath.toLowerCase().endsWith(".html")) {
    return toolError('targetPath must end with ".html"');
  }
  const fileNameResult = validateOptionalFileName(args.fileName);
  if (!fileNameResult.ok) return fileNameResult;

  let run;
  try {
    run = await ctx.nautiloApp.office.run({
      input: { surface: args.source.surface, path: sourcePath },
      readArgv: ["get", "/body", "--depth", "6", "--json"],
    });
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }

  if (!run.ok) {
    return { ok: true, status: "failed", code: run.code, message: run.message };
  }

  const mapResult = mapOfficeCliGetEnvelope(run.json as OfficeCliGetEnvelope, {
    resolveMedia: (relId) => {
      const dataUrl = run.mediaByRelId?.[relId];
      return dataUrl ? { dataUrl } : null;
    },
  });
  let html: string;
  try {
    html = serializeWriterHtml(createDefaultManifest(), wafflebaseDocumentToPayload(mapResult.document));
  } catch (err) {
    return {
      ok: true,
      status: "failed",
      code: "SERIALIZER_FAILED",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // Create the imported document beside its source: current-folder source →
  // current-folder file (namespaces don't apply); workspace source → workspace
  // artifact colocated in the SAME namespace as the source. Both write
  // DIRECTLY (never through the turn-scoped patch pipeline).
  let created;
  try {
    created = await ctx.nautiloApp.document.createDocument({
      surface: targetSurface,
      path: targetPath,
      content: html,
      mimeType: "text/html",
      overwrite: args.overwrite === true,
      ...(targetSurface === "workspace"
        ? { colocateWith: { surface: "workspace" as const, path: sourcePath } }
        : {}),
    });
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  if (!created.ok) {
    if (created.code === "EXISTS") {
      return {
        ok: true,
        status: "conflict",
        target: { surface: targetSurface, path: targetPath },
        message: created.message,
      };
    }
    return { ok: true, status: "failed", code: created.code, message: created.message };
  }

  return {
    ok: true,
    status: "imported",
    artifactPath: created.artifactPath,
    displayPath: created.artifactPath,
    sha256: created.sha256,
    skippedCount: mapResult.skipped.length,
    blockCount: mapResult.document.blocks.length,
  };
}

export async function exportDocx(
  args: ExportDocxArgs,
  ctx: AgentToolContext,
): Promise<
  | {
      ok: true;
      status: "exported";
      displayPath: string;
      sha256: string;
      byteLength: number;
      skippedCount: number;
    }
  | ConversionConflict
  | { ok: true; status: "failed"; code: string; message: string }
  | ToolError
> {
  if (!args || typeof args !== "object") return toolError("args must be an object");
  if (!args.source || typeof args.source !== "object") {
    return toolError("source must be an object");
  }
  if (args.source.surface !== "currentFolder" && args.source.surface !== "workspace") {
    return toolError('source.surface must be "currentFolder" or "workspace" for export-docx');
  }
  if (!args.target || typeof args.target !== "object") {
    return toolError("target must be an object");
  }
  if (args.target.surface !== "currentFolder" && args.target.surface !== "workspace") {
    return toolError('target.surface must be "currentFolder" or "workspace" for export-docx');
  }
  const sourcePathResult =
    args.source.surface === "currentFolder"
      ? validateCurrentFolderRelativePath(args.source.path, "source.path")
      : validateWorkspacePath(args.source.path, "source.path");
  if (!sourcePathResult.ok) return sourcePathResult;
  const sourcePath =
    "relativePath" in sourcePathResult ? sourcePathResult.relativePath : sourcePathResult.path;
  if (!sourcePath.toLowerCase().endsWith(".html")) {
    return toolError('source.path must end with ".html"');
  }
  const targetResult =
    args.target.surface === "currentFolder"
      ? validateCurrentFolderRelativePath(args.target.path, "target.path")
      : validateWorkspacePath(args.target.path, "target.path");
  if (!targetResult.ok) return targetResult;
  const targetPath =
    "relativePath" in targetResult ? targetResult.relativePath : targetResult.path;
  if (!targetPath.toLowerCase().endsWith(".docx")) {
    return toolError('target path must end with ".docx"');
  }
  const fileNameResult = validateOptionalFileName(args.fileName);
  if (!fileNameResult.ok) return fileNameResult;

  let read;
  try {
    read = await ctx.nautiloApp.document.read(
      args.source.surface === "currentFolder"
        ? { surface: "currentFolder", relativePath: sourcePath }
        : { surface: "workspace", path: sourcePath },
    );
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }

  const parsed = parseWriterHtml(read.content);
  if (!parsed.ok) {
    return { ok: true, status: "failed", code: "PARSER_FAILED", message: parsed.error };
  }

  const mapped = mapWriterDocumentToOfficeCliBatch(parsed.document.document);
  let run;
  try {
    run = await ctx.nautiloApp.office.run({
      ops: mapped.commands,
      ...(mapped.imageInputs.length > 0 ? { imageInputs: mapped.imageInputs } : {}),
      output: { surface: args.target.surface, path: targetPath },
      overwrite: args.overwrite === true,
    });
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }

  if (!run.ok) {
    if (run.code === "EXISTS") {
      return {
        ok: true,
        status: "conflict",
        target: { surface: args.target.surface, path: targetPath },
        message: run.message,
      };
    }
    return { ok: true, status: "failed", code: run.code, message: run.message };
  }

  return {
    ok: true,
    status: "exported",
    displayPath: run.displayPath ?? targetPath,
    sha256: run.sha256 ?? "",
    byteLength: run.byteLength ?? 0,
    skippedCount: mapped.skipped.length,
  };
}

// Re-exports for callers/tests that want the manifest type alongside the tools.
export type { WriterHtmlManifest, WriterHtmlDocument, WafflebaseDocumentPayload };
