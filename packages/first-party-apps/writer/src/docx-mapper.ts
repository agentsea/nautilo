// D372 P4 / M205 Phase 3 — pure DOCX mapping for the Writer app.
// No Node built-ins and no OfficeCLI package imports belong in this file.

import {
  OFFICE_RUN_IMAGE_INDEX_PROP,
  WRITER_IMAGE_OBJECT_CHAR,
  cmStringToPx,
  defaultInlineImageDimensions,
  isWriterImageInline,
  pxToCmString,
  readImageInlineStyle,
  validateDataUrlImage,
  type OfficeRunDataUrlImageInput,
} from "./docx-image";

// ============================================================================
// OfficeCLI input types (read-only mirror of the C# DocumentNode contract)
// ============================================================================

/** A single OfficeCLI DOM node, as emitted by `get --json` / `dump`. */
export interface OfficeCliDocumentNode {
  readonly path: string;
  readonly type: string;
  readonly text?: string | null;
  readonly preview?: string | null;
  readonly style?: string | null;
  readonly childCount?: number;
  readonly format?: Record<string, unknown>;
  readonly children?: OfficeCliDocumentNode[];
}

/** Envelope returned by `officecli <cmd> ... --json`. */
export interface OfficeCliGetEnvelope {
  readonly success: boolean;
  readonly message?: string;
  readonly data?: OfficeCliDocumentNode | OfficeCliGetResultsEnvelope;
  readonly warnings?: unknown[];
}

/** v1.0.128 `get --json` payload wrapper. */
export interface OfficeCliGetResultsEnvelope {
  readonly matches?: number;
  readonly results?: OfficeCliDocumentNode[];
}

// ============================================================================
// Wafflebase output types (narrow server-side subset)
// ============================================================================

export type WafflebaseBlockType =
  | "paragraph"
  | "heading"
  | "list-item"
  | "horizontal-rule"
  | "page-break"
  | "table";

export type WafflebaseAlignment = "left" | "center" | "right" | "justify";

export interface WafflebaseBlockStyle {
  readonly alignment: WafflebaseAlignment;
  readonly lineHeight: number;
  readonly marginTop: number;
  readonly marginBottom: number;
  readonly textIndent: number;
  readonly marginLeft: number;
}

export interface WafflebaseInlineImageStyle {
  readonly src: string;
  readonly width?: number;
  readonly height?: number;
  readonly alt?: string;
}

export interface WafflebaseInlineStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  readonly fontSize?: number;
  readonly fontFamily?: string;
  readonly color?: string;
  readonly superscript?: boolean;
  readonly subscript?: boolean;
  readonly href?: string;
  readonly pageNumber?: boolean;
  readonly image?: WafflebaseInlineImageStyle;
}

export type { OfficeRunDataUrlImageInput } from "./docx-image";

export interface WafflebaseInline {
  readonly text: string;
  readonly style: WafflebaseInlineStyle;
}

export type WafflebaseListKind = "ordered" | "unordered";

export interface WafflebaseBorderStyle {
  readonly width: number;
  readonly color: string;
  readonly style: "solid" | "none";
}

export interface WafflebaseCellStyle {
  backgroundColor?: string;
  borderTop?: WafflebaseBorderStyle;
  borderBottom?: WafflebaseBorderStyle;
  borderLeft?: WafflebaseBorderStyle;
  borderRight?: WafflebaseBorderStyle;
  verticalAlign?: "top" | "middle" | "bottom";
  padding?: number;
}

export interface WafflebaseTableCell {
  blocks: WafflebaseBlock[];
  style: WafflebaseCellStyle;
  colSpan?: number;
  rowSpan?: number;
}

export interface WafflebaseTableRow {
  readonly cells: WafflebaseTableCell[];
}

export interface WafflebaseTableData {
  readonly rows: WafflebaseTableRow[];
  readonly columnWidths: number[];
}

export interface WafflebaseBlock {
  readonly id: string;
  readonly type: WafflebaseBlockType;
  readonly inlines: WafflebaseInline[];
  readonly style: WafflebaseBlockStyle;
  readonly headingLevel?: number;
  readonly listKind?: WafflebaseListKind;
  readonly listLevel?: number;
  readonly tableData?: WafflebaseTableData;
}

export interface WafflebaseDocument {
  readonly blocks: WafflebaseBlock[];
}

export const DEFAULT_BLOCK_STYLE: WafflebaseBlockStyle = {
  alignment: "left",
  lineHeight: 1.5,
  marginTop: 0,
  marginBottom: 8,
  textIndent: 0,
  marginLeft: 0,
};

export interface OfficeDocumentMapOptions {
  readonly idFactory?: () => string;
  readonly onSkipped?: (reason: SkippedNode) => void;
  /** Resolve embedded DOCX media by OfficeCLI relationship id (`format.relId`). */
  readonly resolveMedia?: (relId: string) => { dataUrl: string } | null;
}

export interface SkippedNode {
  readonly path: string;
  readonly type: string;
  readonly reason: string;
}

export interface OfficeDocumentMapResult {
  readonly document: WafflebaseDocument;
  readonly skipped: readonly SkippedNode[];
}

export function mapOfficeDocumentToWafflebase(
  root: OfficeCliDocumentNode,
  options: OfficeDocumentMapOptions = {},
): OfficeDocumentMapResult {
  const idFactory = options.idFactory ?? createDefaultIdFactory();
  const skipped: SkippedNode[] = [];
  const recordSkip = (entry: SkippedNode): void => {
    skipped.push(entry);
    options.onSkipped?.(entry);
  };

  const ctx: MapperContext = {
    idFactory,
    recordSkip,
    resolveMedia: options.resolveMedia ?? null,
  };
  const blocks = mapRoot(root, ctx);
  return { document: { blocks }, skipped };
}

export function mapOfficeCliGetEnvelope(
  envelope: OfficeCliGetEnvelope,
  options: OfficeDocumentMapOptions = {},
): OfficeDocumentMapResult {
  const dataNode = envelope.success ? extractEnvelopeDataNode(envelope.data) : null;
  if (!envelope.success || dataNode === null) {
    const message = envelope.success
      ? envelope.data === undefined
        ? "envelope.data is missing"
        : "envelope.data did not contain a DocumentNode"
      : `envelope.success=false${
          envelope.message !== undefined && envelope.message.length > 0
            ? `: ${envelope.message}`
            : ""
        }`;
    const skipped: SkippedNode[] = [
      { path: "/", type: "envelope", reason: message },
    ];
    options.onSkipped?.(skipped[0]!);
    return { document: { blocks: [] }, skipped };
  }
  return mapOfficeDocumentToWafflebase(dataNode, options);
}

interface MapperContext {
  readonly idFactory: () => string;
  readonly recordSkip: (entry: SkippedNode) => void;
  readonly resolveMedia: ((relId: string) => { dataUrl: string } | null) | null;
}

function createDefaultIdFactory(): () => string {
  let n = 0;
  return (): string => `block-${n++}`;
}

function extractEnvelopeDataNode(
  data: OfficeCliGetEnvelope["data"],
): OfficeCliDocumentNode | null {
  if (data === undefined || data === null || typeof data !== "object") return null;
  if (isOfficeCliDocumentNode(data)) return data;
  const results = data.results;
  if (!Array.isArray(results) || results.length === 0) return null;
  return isOfficeCliDocumentNode(results[0]) ? results[0] : null;
}

function isOfficeCliDocumentNode(value: unknown): value is OfficeCliDocumentNode {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Partial<OfficeCliDocumentNode>;
  return typeof raw.path === "string" && typeof raw.type === "string";
}

function mapRoot(root: OfficeCliDocumentNode, ctx: MapperContext): WafflebaseBlock[] {
  const type = root.type.toLowerCase();
  if (type === "document" || type === "body") {
    return mapChildBlocks(root, ctx);
  }
  return mapBlockLevelNode(root, ctx);
}

function mapChildBlocks(container: OfficeCliDocumentNode, ctx: MapperContext): WafflebaseBlock[] {
  const out: WafflebaseBlock[] = [];
  const children = container.children ?? [];
  for (const child of children) {
    const type = child.type.toLowerCase();
    if (type === "document" || type === "body") {
      for (const b of mapChildBlocks(child, ctx)) out.push(b);
      continue;
    }
    const blocks = mapBlockLevelNode(child, ctx);
    for (const b of blocks) out.push(b);
  }
  return out;
}

function mapBlockLevelNode(node: OfficeCliDocumentNode, ctx: MapperContext): WafflebaseBlock[] {
  const type = node.type.toLowerCase();
  switch (type) {
    case "paragraph":
    case "p":
      return [mapParagraph(node, ctx)];
    case "table":
    case "tbl":
      return [mapTable(node, ctx)];
    case "sdt":
      return mapSdtBlock(node, ctx);
    case "section":
      ctx.recordSkip({
        path: node.path,
        type: node.type,
        reason: "section nodes have no Wafflebase block equivalent",
      });
      return [];
    default:
      ctx.recordSkip({
        path: node.path,
        type: node.type,
        reason: `unsupported block-level type '${node.type}'`,
      });
      return [];
  }
}

function mapSdtBlock(node: OfficeCliDocumentNode, ctx: MapperContext): WafflebaseBlock[] {
  const children = node.children ?? [];
  const blocks: WafflebaseBlock[] = [];
  for (const child of children) {
    const t = child.type.toLowerCase();
    if (t === "paragraph" || t === "p") {
      blocks.push(mapParagraph(child, ctx));
      continue;
    }
    if (t === "table" || t === "tbl") {
      blocks.push(mapTable(child, ctx));
      continue;
    }
    ctx.recordSkip({
      path: child.path,
      type: child.type,
      reason: `non-block sdt child '${child.type}' not unwrapped in this slice`,
    });
  }
  if (blocks.length > 0) return blocks;

  const text = typeof node.text === "string" ? node.text : "";
  if (text.length > 0) {
    ctx.recordSkip({
      path: node.path,
      type: node.type,
      reason:
        "sdt content flattened to text (OfficeCLI did not emit block children at this depth; paragraph boundaries lost)",
    });
    return [
      {
        id: ctx.idFactory(),
        type: "paragraph",
        inlines: [{ text, style: {} }],
        style: { ...DEFAULT_BLOCK_STYLE, alignment: "left" },
      },
    ];
  }
  ctx.recordSkip({
    path: node.path,
    type: node.type,
    reason: "sdt (content control) has no block children and no text",
  });
  return [];
}

const HEADING_STYLE_RE = /^Heading([1-6])$/i;

function mapParagraph(node: OfficeCliDocumentNode, ctx: MapperContext): WafflebaseBlock {
  const format = node.format ?? {};
  const inlines = mapParagraphInlines(node, ctx);
  const heading = resolveHeadingLevel(format);
  const list = resolveListMetadata(format);
  const baseStyle = buildBlockStyle(format);

  if (heading !== null) {
    return {
      id: ctx.idFactory(),
      type: "heading",
      inlines,
      style: baseStyle,
      headingLevel: heading,
    };
  }

  if (list !== null) {
    return {
      id: ctx.idFactory(),
      type: "list-item",
      inlines,
      style: baseStyle,
      listKind: list.kind,
      listLevel: list.level,
    };
  }

  return {
    id: ctx.idFactory(),
    type: "paragraph",
    inlines,
    style: baseStyle,
  };
}

function resolveHeadingLevel(format: Record<string, unknown>): number | null {
  const styleRaw = readString(format, "style");
  if (styleRaw !== null) {
    const m = HEADING_STYLE_RE.exec(styleRaw);
    if (m !== null) {
      const level = parseInt(m[1]!, 10);
      if (Number.isInteger(level) && level >= 1 && level <= 6) return level;
    }
  }
  const outlineRaw = readNumber(format, "outlineLvl");
  if (outlineRaw !== null) {
    if (outlineRaw >= 1 && outlineRaw <= 6) return outlineRaw;
    if (outlineRaw === 7 || outlineRaw === 8) return 6;
  }
  return null;
}

function resolveListMetadata(
  format: Record<string, unknown>,
): { kind: WafflebaseListKind; level: number } | null {
  const listStyle = readString(format, "listStyle");
  const numFmt = readString(format, "numFmt");
  const numIdRaw = readString(format, "numId");
  if (numIdRaw === "0") return null;
  const hasNumId = numIdRaw !== null;

  if (listStyle === null && numFmt === null && !hasNumId) return null;

  let kind: WafflebaseListKind;
  if (listStyle === "bullet") {
    kind = "unordered";
  } else if (listStyle === "ordered") {
    kind = "ordered";
  } else if (numFmt !== null) {
    kind = numFmt.toLowerCase() === "bullet" ? "unordered" : "ordered";
  } else {
    kind = "ordered";
  }

  const levelRaw = readNumber(format, "numLevel");
  const level = levelRaw === null ? 0 : clamp(levelRaw, 0, 8);
  return { kind, level };
}

function mapParagraphInlines(node: OfficeCliDocumentNode, ctx: MapperContext): WafflebaseInline[] {
  const inlines: WafflebaseInline[] = [];
  const children = node.children ?? [];
  for (const child of children) {
    const type = child.type.toLowerCase();
    if (type === "run" || type === "r") {
      inlines.push(mapRunToInline(child));
      continue;
    }
    if (type === "hyperlink" || type === "link") {
      const hlInlines = mapHyperlinkChildToInlines(child, ctx);
      for (const i of hlInlines) inlines.push(i);
      continue;
    }
    if (type === "sdt") {
      const sdtInlines = mapSdtInlineToInlines(child, ctx);
      for (const i of sdtInlines) inlines.push(i);
      continue;
    }
    if (type === "field") {
      const fieldInline = mapFieldChildToInline(child, ctx);
      if (fieldInline !== null) inlines.push(fieldInline);
      continue;
    }
    if (type === "picture" || type === "drawing" || type === "img" || type === "image") {
      const pictureInline = mapPictureChildToInline(child, ctx);
      if (pictureInline !== null) inlines.push(pictureInline);
      continue;
    }
    ctx.recordSkip({
      path: child.path,
      type: child.type,
      reason: `non-run paragraph child '${child.type}' not unwrapped in this slice`,
    });
  }
  if (inlines.length === 0) {
    return [{ text: "", style: {} }];
  }
  return inlines;
}

function mapPictureChildToInline(
  node: OfficeCliDocumentNode,
  ctx: MapperContext,
): WafflebaseInline | null {
  const format = node.format ?? {};
  const relId = readString(format, "relId");
  if (relId === null) {
    ctx.recordSkip({
      path: node.path,
      type: node.type,
      reason: "picture node is missing format.relId for media extraction",
    });
    return null;
  }
  if (ctx.resolveMedia === null) {
    ctx.recordSkip({
      path: node.path,
      type: node.type,
      reason: "picture node recognized but no media resolver was provided",
    });
    return null;
  }
  const media = ctx.resolveMedia(relId);
  if (media === null) {
    ctx.recordSkip({
      path: node.path,
      type: node.type,
      reason: `picture media for relId '${relId}' could not be extracted`,
    });
    return null;
  }
  const width = cmStringToPx(readString(format, "width"));
  const height = cmStringToPx(readString(format, "height"));
  const alt =
    readString(format, "alt") ??
    readString(format, "name") ??
    (typeof node.text === "string" && node.text.length > 0 ? node.text : null);
  return {
    text: WRITER_IMAGE_OBJECT_CHAR,
    style: {
      image: {
        src: media.dataUrl,
        ...(width !== null ? { width } : {}),
        ...(height !== null ? { height } : {}),
        ...(alt !== null ? { alt } : {}),
      },
    },
  };
}

function mapRunToInline(run: OfficeCliDocumentNode): WafflebaseInline {
  const text = run.text ?? "";
  const style = mapRunStyle(run.format ?? {});
  return { text, style };
}

function mapRunStyle(format: Record<string, unknown>): WafflebaseInlineStyle {
  const style: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    fontSize?: number;
    fontFamily?: string;
    color?: string;
    superscript?: boolean;
    subscript?: boolean;
    href?: string;
  } = {};

  const bold = readBool(format, "bold");
  if (bold !== null) style.bold = bold;

  const italic = readBool(format, "italic");
  if (italic !== null) style.italic = italic;

  const underline = readUnderline(format);
  if (underline !== null) style.underline = underline;

  const strike = readBool(format, "strike");
  if (strike !== null) style.strikethrough = strike;

  const fontSize = readFontSize(format);
  if (fontSize !== null) style.fontSize = fontSize;

  const fontFamily = readFontFamily(format);
  if (fontFamily !== null) style.fontFamily = fontFamily;

  const color = readColor(format);
  if (color !== null) style.color = color;

  if (readBool(format, "superscript") === true) style.superscript = true;
  if (readBool(format, "subscript") === true) style.subscript = true;

  const href = resolveRunHref(format);
  if (href !== null) style.href = href;

  return style;
}

function resolveRunHref(format: Record<string, unknown>): string | null {
  const url = readString(format, "url");
  if (url !== null) return url;
  if (readBool(format, "isHyperlink") === true) {
    const anchor = readString(format, "anchor");
    if (anchor !== null) return `#${anchor}`;
  }
  return null;
}

function resolveHyperlinkHref(format: Record<string, unknown>): string | null {
  const url =
    readString(format, "url") ??
    readString(format, "href") ??
    readString(format, "link");
  if (url !== null) return url;
  const anchor = readString(format, "anchor");
  if (anchor !== null) return `#${anchor}`;
  return null;
}

function mapHyperlinkChildToInlines(
  node: OfficeCliDocumentNode,
  ctx: MapperContext,
): WafflebaseInline[] {
  const href = resolveHyperlinkHref(node.format ?? {});
  const children = node.children ?? [];
  const inlines: WafflebaseInline[] = [];
  for (const child of children) {
    const t = child.type.toLowerCase();
    if (t === "run" || t === "r") {
      inlines.push(mapRunToInlineWithHref(child, href));
      continue;
    }
    ctx.recordSkip({
      path: child.path,
      type: child.type,
      reason: `non-run hyperlink child '${child.type}' not unwrapped in this slice`,
    });
  }
  if (inlines.length > 0) return inlines;

  const text = typeof node.text === "string" ? node.text : "";
  if (text.length > 0) {
    return [{ text, style: href !== null ? { href } : {} }];
  }
  ctx.recordSkip({
    path: node.path,
    type: node.type,
    reason:
      href === null
        ? "hyperlink with no url/anchor and no run children"
        : "hyperlink with no run children and no text",
  });
  return [];
}

function mapRunToInlineWithHref(run: OfficeCliDocumentNode, href: string | null): WafflebaseInline {
  const inline = mapRunToInline(run);
  if (href === null) return inline;
  return { text: inline.text, style: { ...inline.style, href } };
}

function mapSdtInlineToInlines(
  node: OfficeCliDocumentNode,
  ctx: MapperContext,
): WafflebaseInline[] {
  const children = node.children ?? [];
  const inlines: WafflebaseInline[] = [];
  for (const child of children) {
    const t = child.type.toLowerCase();
    if (t === "run" || t === "r") {
      inlines.push(mapRunToInline(child));
      continue;
    }
    ctx.recordSkip({
      path: child.path,
      type: child.type,
      reason: `non-run sdt child '${child.type}' not unwrapped in this slice`,
    });
  }
  if (inlines.length > 0) return inlines;

  const text = typeof node.text === "string" ? node.text : "";
  if (text.length > 0) {
    return [{ text, style: {} }];
  }
  ctx.recordSkip({
    path: node.path,
    type: node.type,
    reason: "sdt (inline) has no run children and no text",
  });
  return [];
}

function mapFieldChildToInline(
  node: OfficeCliDocumentNode,
  ctx: MapperContext,
): WafflebaseInline | null {
  const text = typeof node.text === "string" ? node.text : "";
  if (text.length > 0) {
    return { text, style: fieldInlineStyle(node.format ?? {}) };
  }
  const format = node.format ?? {};
  const evaluatedRaw = format["evaluated"];
  const evaluated = evaluatedRaw === true || evaluatedRaw === "true";
  ctx.recordSkip({
    path: node.path,
    type: node.type,
    reason: evaluated
      ? "field has no cached result text"
      : "field result not emitted by OfficeCLI (unevaluated or raw-marker field)",
  });
  return null;
}

function fieldInlineStyle(format: Record<string, unknown>): WafflebaseInlineStyle {
  const style: { href?: string; pageNumber?: boolean } = {};
  const href = hyperlinkFromFieldInstruction(format);
  if (href !== null) style.href = href;
  const fieldType = (readString(format, "fieldType") ?? readString(format, "type") ?? "").toLowerCase();
  const instruction = (readString(format, "instruction") ?? "").trim().toUpperCase();
  if (fieldType === "page" || fieldType === "numpages" || instruction === "PAGE" || instruction === "NUMPAGES") {
    style.pageNumber = true;
  }
  return style;
}

function hyperlinkFromFieldInstruction(format: Record<string, unknown>): string | null {
  const fieldType = (readString(format, "fieldType") ?? readString(format, "type") ?? "").toLowerCase();
  const instruction = readString(format, "instruction");
  if (fieldType !== "hyperlink" && !instruction?.trim().toUpperCase().startsWith("HYPERLINK")) {
    return null;
  }
  if (!instruction) return null;
  const match = /^HYPERLINK\s+(?:"([^"]+)"|(\S+))/i.exec(instruction.trim());
  return match?.[1] ?? match?.[2] ?? null;
}

function readUnderline(format: Record<string, unknown>): boolean | null {
  const raw = readString(format, "underline");
  if (raw === null) return null;
  const lower = raw.toLowerCase();
  if (lower === "false" || lower === "none" || lower === "") return false;
  return true;
}

function readFontSize(format: Record<string, unknown>): number | null {
  const raw = readString(format, "size");
  if (raw === null) return null;
  const m = /^([0-9]+(?:\.[0-9]+)?)pt$/i.exec(raw.trim());
  if (m !== null) return parseFloat(m[1]!);
  const bare = parseFloat(raw);
  if (Number.isFinite(bare)) return bare;
  return null;
}

function readFontFamily(format: Record<string, unknown>): string | null {
  return readString(format, "font") ?? readString(format, "font.latin") ?? null;
}

function readColorKey(format: Record<string, unknown>, key: string): string | null {
  const raw = readString(format, key);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (/^#?[0-9a-f]{6}$/i.test(trimmed)) {
    const hex = trimmed.replace(/^#/, "").toUpperCase();
    return `#${hex}`;
  }
  return trimmed;
}

function readColor(format: Record<string, unknown>): string | null {
  return readColorKey(format, "color");
}

function buildBlockStyle(format: Record<string, unknown>): WafflebaseBlockStyle {
  const alignment = resolveAlignment(format);
  return { ...DEFAULT_BLOCK_STYLE, alignment };
}

function resolveAlignment(format: Record<string, unknown>): WafflebaseAlignment {
  const raw = readString(format, "align");
  if (raw === null) return "left";
  switch (raw.toLowerCase()) {
    case "center":
      return "center";
    case "right":
      return "right";
    case "justify":
    case "both":
      return "justify";
    case "left":
    case "distribute":
    default:
      return "left";
  }
}

const DEFAULT_CELL_STYLE: WafflebaseCellStyle = { padding: 4 };

function makeCoveredCell(): WafflebaseTableCell {
  return { blocks: [], style: {}, colSpan: 0 };
}

function mapTable(node: OfficeCliDocumentNode, ctx: MapperContext): WafflebaseBlock {
  const format = node.format ?? {};
  const rowNodes = (node.children ?? []).filter((c) => {
    const t = c.type.toLowerCase();
    return t === "row" || t === "tr";
  });

  const tableBlockId = ctx.idFactory();
  const rowGrids: Array<Array<{ cell: OfficeCliDocumentNode; gridCol: number; colSpan: number }>> = [];
  let numCols = parseColsCount(format);
  for (const rowNode of rowNodes) {
    const cells = (rowNode.children ?? []).filter((c) => {
      const t = c.type.toLowerCase();
      return t === "cell" || t === "tc";
    });
    const positioned: Array<{ cell: OfficeCliDocumentNode; gridCol: number; colSpan: number }> = [];
    let gridCol = 0;
    for (const cell of cells) {
      const cf = cell.format ?? {};
      const cs = resolveColSpan(cf);
      positioned.push({ cell, gridCol, colSpan: cs });
      gridCol += cs;
    }
    if (gridCol > numCols) numCols = gridCol;
    rowGrids.push(positioned);
  }

  if (numCols < 1) numCols = 1;

  const waffleRows: WafflebaseTableRow[] = [];
  for (let r = 0; r < rowGrids.length; r++) {
    const positioned = rowGrids[r]!;
    const outCells: WafflebaseTableCell[] = [];
    for (const { cell, gridCol, colSpan } of positioned) {
      const cf = cell.format ?? {};
      const vmerge = readString(cf, "vmerge");
      const hmerge = readString(cf, "hmerge");

      if (vmerge === "continue" || hmerge === "continue") {
        outCells.push(makeCoveredCell());
        continue;
      }

      const wCell = buildCell(cell, ctx);
      if (colSpan > 1) wCell.colSpan = colSpan;
      if (vmerge === "restart") {
        const rs = countVMergeContinueBelow(rowGrids, r, gridCol, colSpan) + 1;
        if (rs > 1) wCell.rowSpan = rs;
      }
      outCells.push(wCell);
      for (let k = 1; k < colSpan; k++) outCells.push(makeCoveredCell());
    }
    while (outCells.length < numCols) outCells.push(makeCoveredCell());
    if (outCells.length > numCols) outCells.length = numCols;
    waffleRows.push({ cells: outCells });
  }

  if (waffleRows.length === 0) {
    waffleRows.push({
      cells: [
        {
          blocks: [
            {
              id: ctx.idFactory(),
              type: "paragraph",
              inlines: [{ text: "", style: {} }],
              style: { ...DEFAULT_BLOCK_STYLE, alignment: "left" },
            },
          ],
          style: { ...DEFAULT_CELL_STYLE },
        },
      ],
    });
  }

  const columnWidths = resolveColumnWidths(format, numCols);

  return {
    id: tableBlockId,
    type: "table",
    inlines: [],
    style: { ...DEFAULT_BLOCK_STYLE, alignment: resolveAlignment(format) },
    tableData: { rows: waffleRows, columnWidths },
  };
}

function parseColsCount(format: Record<string, unknown>): number {
  const raw = readNumber(format, "cols");
  if (raw === null) return 0;
  const n = Math.floor(raw);
  return n > 0 ? n : 0;
}

function resolveColSpan(cellFormat: Record<string, unknown>): number {
  const raw = readNumber(cellFormat, "colspan");
  if (raw === null || raw < 1) return 1;
  return Math.floor(raw);
}

function countVMergeContinueBelow(
  rowGrids: Array<Array<{ cell: OfficeCliDocumentNode; gridCol: number; colSpan: number }>>,
  startRow: number,
  gridCol: number,
  colSpan: number,
): number {
  let count = 0;
  for (let r = startRow + 1; r < rowGrids.length; r++) {
    const positioned = rowGrids[r]!;
    const matching = positioned.filter(
      (p) => p.gridCol >= gridCol && p.gridCol < gridCol + colSpan,
    );
    if (matching.length === 0) break;
    const allContinue = matching.every((p) => readString(p.cell.format ?? {}, "vmerge") === "continue");
    if (!allContinue) break;
    count++;
  }
  return count;
}

function buildCell(cell: OfficeCliDocumentNode, ctx: MapperContext): WafflebaseTableCell {
  const blocks: WafflebaseBlock[] = [];
  const children = cell.children ?? [];
  for (const child of children) {
    const t = child.type.toLowerCase();
    if (t === "paragraph" || t === "p") {
      blocks.push(mapParagraph(child, ctx));
      continue;
    }
    if (t === "sdt") {
      blocks.push(...mapSdtBlock(child, ctx));
      continue;
    }
    ctx.recordSkip({
      path: child.path,
      type: child.type,
      reason: `non-paragraph cell child '${child.type}' not unwrapped in this slice`,
    });
  }
  if (blocks.length === 0) {
    const previewText = typeof cell.text === "string" ? cell.text : "";
    blocks.push({
      id: ctx.idFactory(),
      type: "paragraph",
      inlines: previewText.length > 0 ? [{ text: previewText, style: {} }] : [{ text: "", style: {} }],
      style: { ...DEFAULT_BLOCK_STYLE, alignment: "left" },
    });
  }
  const style = buildCellStyle(cell.format ?? {});
  return { blocks, style };
}

function buildCellStyle(cellFormat: Record<string, unknown>): WafflebaseCellStyle {
  const style: WafflebaseCellStyle = { ...DEFAULT_CELL_STYLE };
  const fill = readColorKey(cellFormat, "fill");
  if (fill !== null) style.backgroundColor = fill;
  const valign = readString(cellFormat, "valign");
  if (valign === "top" || valign === "middle" || valign === "bottom") {
    style.verticalAlign = valign;
  }
  return style;
}

function resolveColumnWidths(format: Record<string, unknown>, numCols: number): number[] {
  const raw = readString(format, "colWidths");
  if (raw !== null) {
    const parts = raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length === numCols) {
      const twips = parts.map((p) => parseTwips(p));
      if (twips.every((t) => t > 0)) {
        const total = twips.reduce((a, b) => a + b, 0);
        if (total > 0) return twips.map((t) => t / total);
      }
    }
  }
  return Array.from({ length: numCols }, () => 1 / numCols);
}

function parseTwips(raw: string): number {
  const m = /^([0-9]+(?:\.[0-9]+)?)dxa$/i.exec(raw.trim());
  if (m !== null) return parseFloat(m[1]!);
  const bare = parseFloat(raw);
  return Number.isFinite(bare) && bare > 0 ? bare : 0;
}

function readString(format: Record<string, unknown>, key: string): string | null {
  const v = format[key];
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function readNumber(format: Record<string, unknown>, key: string): number | null {
  const v = format[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function readBool(format: Record<string, unknown>, key: string): boolean | null {
  const v = format[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const lower = v.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

// ============================================================================
// Writer document -> OfficeCLI batch export mapping
// ============================================================================

export interface ExportSkippedNode {
  readonly blockId?: string;
  readonly type: string;
  readonly reason: string;
}

export type OfficeCliBatchCommand =
  | {
      command: "add";
      parent: string;
      type: "paragraph" | "table" | "r" | "hyperlink" | "pagebreak" | "picture";
      props: Record<string, string>;
    }
  | {
      command: "set";
      path: string;
      props: Record<string, string>;
    };

export interface WriterDocxExportResult {
  readonly commands: OfficeCliBatchCommand[];
  readonly imageInputs: OfficeRunDataUrlImageInput[];
  readonly skipped: ExportSkippedNode[];
}

export const DEFAULT_BLOCK_LINE_HEIGHT = 1.5;
export const DEFAULT_TABLE_WIDTH_TWIPS = 9360;

export function mapWriterDocumentToOfficeCliBatch(document: { blocks: unknown[] }): WriterDocxExportResult {
  const commands: OfficeCliBatchCommand[] = [];
  const imageInputs: OfficeRunDataUrlImageInput[] = [];
  const skipped: ExportSkippedNode[] = [];
  let paragraphIndex = 0;
  let tableIndex = 0;
  let imageBytesTotal = 0;
  for (const rawBlock of document.blocks) {
    const block = asRecord(rawBlock);
    if (block === null) {
      skipped.push({ type: "unknown", reason: "block is not an object" });
      continue;
    }
    const id = readExportString(block, "id") ?? undefined;
    const type = readExportString(block, "type") ?? "unknown";
    if (type === "paragraph" || type === "heading" || type === "list-item") {
      paragraphIndex += 1;
      appendParagraphCommands(
        block,
        type,
        paragraphIndex,
        commands,
        imageInputs,
        skipped,
        id,
        () => imageBytesTotal,
        (next) => {
          imageBytesTotal = next;
        },
      );
      continue;
    }
    if (type === "table") {
      tableIndex += 1;
      commands.push(...tableCommands(block, tableIndex, id, skipped));
      continue;
    }
    if (type === "page-break") {
      commands.push({
        command: "add",
        parent: "/body",
        type: "pagebreak",
        props: { type: "page" },
      });
      continue;
    }
    skipped.push({ ...(id ? { blockId: id } : {}), type, reason: "unsupported Writer block type for .docx export" });
  }
  return { commands, imageInputs, skipped };
}

interface ParsedInline {
  readonly text: string;
  readonly style: Record<string, unknown>;
  readonly image?: ReturnType<typeof readImageInlineStyle>;
}

type InlineSegment =
  | { kind: "plain"; inlines: ParsedInline[] }
  | { kind: "image"; inline: ParsedInline }
  | {
      kind: "hyperlink";
      targetKey: string;
      linkProp: "url" | "anchor";
      linkValue: string;
      inlines: ParsedInline[];
    };

function appendParagraphCommands(
  block: Record<string, unknown>,
  type: string,
  paragraphIndex: number,
  commands: OfficeCliBatchCommand[],
  imageInputs: OfficeRunDataUrlImageInput[],
  skipped: ExportSkippedNode[],
  blockId: string | undefined,
  getImageBytesTotal: () => number,
  setImageBytesTotal: (next: number) => void,
): void {
  const segments = groupInlineSegments(block, skipped, blockId);
  const shellProps = paragraphShellProps(block, type);

  if (canUseParagraphTextFastPath(segments)) {
    const plain = segments[0]!;
    commands.push({
      command: "add",
      parent: "/body",
      type: "paragraph",
      props: {
        ...shellProps,
        text: plain.inlines.map((inline) => inline.text).join(""),
        ...inlineRunProps(plain.inlines[0]!.style),
      },
    });
    return;
  }

  commands.push({
    command: "add",
    parent: "/body",
    type: "paragraph",
    props: shellProps,
  });

  const paraPath = `/body/p[${paragraphIndex}]`;
  let hyperlinkIndex = 0;
  for (const segment of segments) {
    if (segment.kind === "image") {
      pushPictureCommand(
        commands,
        imageInputs,
        paraPath,
        segment.inline,
        skipped,
        blockId,
        getImageBytesTotal,
        setImageBytesTotal,
      );
      continue;
    }
    if (segment.kind === "plain") {
      for (const inline of segment.inlines) {
        if (isWriterImageInline(inline)) {
          pushPictureCommand(
            commands,
            imageInputs,
            paraPath,
            inline,
            skipped,
            blockId,
            getImageBytesTotal,
            setImageBytesTotal,
          );
          continue;
        }
        pushRunCommand(commands, paraPath, inline);
      }
      continue;
    }

    hyperlinkIndex += 1;
    const hyperlinkPath = `${paraPath}/hyperlink[${hyperlinkIndex}]`;
    const first = segment.inlines[0]!;
    const uniformStyle = segment.inlines.every((inline) => stylesEqual(inline.style, first.style));

    if (uniformStyle) {
      commands.push({
        command: "add",
        parent: paraPath,
        type: "hyperlink",
        props: {
          [segment.linkProp]: segment.linkValue,
          text: segment.inlines.map((inline) => inline.text).join(""),
          ...inlineRunProps(first.style),
        },
      });
      continue;
    }

    commands.push({
      command: "add",
      parent: paraPath,
      type: "hyperlink",
      props: {
        [segment.linkProp]: segment.linkValue,
        text: first.text,
        ...inlineRunProps(first.style),
      },
    });
    for (const inline of segment.inlines.slice(1)) {
      pushRunCommand(commands, hyperlinkPath, inline);
    }
  }
}

function pushRunCommand(commands: OfficeCliBatchCommand[], parent: string, inline: ParsedInline): void {
  if (inline.text === WRITER_IMAGE_OBJECT_CHAR) return;
  const props = inlineRunProps(inline.style);
  if (inline.text.length > 0) props["text"] = inline.text;
  if (Object.keys(props).length === 0) return;
  commands.push({
    command: "add",
    parent,
    type: "r",
    props,
  });
}

function pushPictureCommand(
  commands: OfficeCliBatchCommand[],
  imageInputs: OfficeRunDataUrlImageInput[],
  parent: string,
  inline: ParsedInline,
  skipped: ExportSkippedNode[],
  blockId: string | undefined,
  getImageBytesTotal: () => number,
  setImageBytesTotal: (next: number) => void,
): void {
  const image = readImageInlineStyle(inline.style);
  if (image === null) {
    skipped.push({
      ...(blockId ? { blockId } : {}),
      type: "inline-image",
      reason: "image inline is missing style.image.src data URL",
    });
    return;
  }
  const validated = validateDataUrlImage(image.src, {
    nextTotal: getImageBytesTotal(),
  });
  if (!validated.ok) {
    skipped.push({
      ...(blockId ? { blockId } : {}),
      type: "inline-image",
      reason: validated.reason,
    });
    return;
  }
  setImageBytesTotal(getImageBytesTotal() + validated.parsed.byteLength);
  const imageIndex = imageInputs.length;
  imageInputs.push({ dataUrl: image.src });
  const dims = defaultInlineImageDimensions();
  const widthPx = image.width ?? dims.width;
  const heightPx = image.height ?? dims.height;
  const props: Record<string, string> = {
    [OFFICE_RUN_IMAGE_INDEX_PROP]: String(imageIndex),
    width: pxToCmString(widthPx),
    height: pxToCmString(heightPx),
  };
  if (image.alt !== undefined) props["alt"] = image.alt;
  commands.push({
    command: "add",
    parent,
    type: "picture",
    props,
  });
}

function canUseParagraphTextFastPath(
  segments: InlineSegment[],
): segments is [Extract<InlineSegment, { kind: "plain" }>] {
  const segment = segments[0];
  if (segments.length !== 1 || segment?.kind !== "plain") return false;
  const inlines = segment.inlines;
  if (inlines.length === 0) return true;
  if (inlines.some((inline) => isWriterImageInline(inline))) return false;
  const firstStyle = inlines[0]!.style;
  return inlines.every((inline) => stylesEqual(inline.style, firstStyle));
}

function groupInlineSegments(
  block: Record<string, unknown>,
  skipped: ExportSkippedNode[],
  blockId: string | undefined,
): InlineSegment[] {
  const rawInlines = Array.isArray(block["inlines"]) ? block["inlines"] : [];
  const parsed = rawInlines.map((rawInline) => {
    const inline = asRecord(rawInline) ?? {};
    return {
      text: readExportString(inline, "text") ?? "",
      style: asRecord(inline["style"]) ?? {},
    };
  });

  const segments: InlineSegment[] = [];
  let currentPlain: ParsedInline[] = [];
  let currentHyperlink: Extract<InlineSegment, { kind: "hyperlink" }> | null = null;

  const flushPlain = (): void => {
    if (currentPlain.length === 0) return;
    segments.push({ kind: "plain", inlines: currentPlain });
    currentPlain = [];
  };

  const flushHyperlink = (): void => {
    if (currentHyperlink === null || currentHyperlink.inlines.length === 0) return;
    segments.push(currentHyperlink);
    currentHyperlink = null;
  };

  for (const inline of parsed) {
    if (isWriterImageInline(inline)) {
      flushHyperlink();
      flushPlain();
      segments.push({ kind: "image", inline });
      continue;
    }

    const resolved = resolveInlineHref(inline.style, skipped, blockId);
    if (resolved === null) {
      flushHyperlink();
      currentPlain.push({ text: inline.text, style: inline.style });
      continue;
    }

    flushPlain();
    if (currentHyperlink !== null && currentHyperlink.targetKey === resolved.targetKey) {
      currentHyperlink.inlines.push({ text: inline.text, style: inline.style });
      continue;
    }

    flushHyperlink();
    currentHyperlink = {
      kind: "hyperlink",
      targetKey: resolved.targetKey,
      linkProp: resolved.linkProp,
      linkValue: resolved.linkValue,
      inlines: [{ text: inline.text, style: inline.style }],
    };
  }

  flushHyperlink();
  flushPlain();
  return segments;
}

function resolveInlineHref(
  style: Record<string, unknown>,
  skipped: ExportSkippedNode[],
  blockId: string | undefined,
): { targetKey: string; linkProp: "url" | "anchor"; linkValue: string } | null {
  const href = readExportString(style, "href");
  if (href === null) return null;

  if (href.startsWith("#")) {
    const anchor = href.slice(1);
    if (anchor.length === 0) {
      skipped.push({
        ...(blockId ? { blockId } : {}),
        type: "inline-hyperlink",
        reason: "internal hyperlink anchor is empty after stripping leading '#'",
      });
      return null;
    }
    return { targetKey: `#${anchor}`, linkProp: "anchor", linkValue: anchor };
  }

  if (!isEmittableExternalHref(href)) {
    skipped.push({
      ...(blockId ? { blockId } : {}),
      type: "inline-hyperlink",
      reason: `hyperlink href '${href}' is unsupported or malformed for .docx export`,
    });
    return null;
  }

  return { targetKey: href, linkProp: "url", linkValue: href };
}

function isEmittableExternalHref(href: string): boolean {
  if (href.length === 0) return false;
  if (/^rewritten:/i.test(href)) return false;
  if (/^(javascript|data|vbscript):/i.test(href)) return false;
  try {
    const parsed = new URL(href);
    return ["http:", "https:", "mailto:", "file:"].includes(parsed.protocol);
  } catch {
    return !/[\s<>"]/.test(href);
  }
}

function paragraphShellProps(block: Record<string, unknown>, type: string): Record<string, string> {
  const props: Record<string, string> = {};
  const style = asRecord(block["style"]);
  const alignment = style ? readExportString(style, "alignment") : null;
  if (alignment && alignment !== "left") props["align"] = alignment === "justify" ? "both" : alignment;
  if (style !== null) appendBlockStyleProps(style, props);
  if (type === "heading") {
    const level = readExportNumber(block, "headingLevel") ?? 1;
    props["style"] = `Heading${Math.max(1, Math.min(6, Math.floor(level)))}`;
  }
  if (type === "list-item") {
    props["listStyle"] = readExportString(block, "listKind") === "unordered" ? "bullet" : "ordered";
    const level = readExportNumber(block, "listLevel");
    if (level !== null) props["numLevel"] = String(Math.max(0, Math.min(8, Math.floor(level))));
  }
  return props;
}

function appendBlockStyleProps(style: Record<string, unknown>, props: Record<string, string>): void {
  const lineHeight = readExportNumber(style, "lineHeight");
  if (lineHeight !== null && lineHeight !== DEFAULT_BLOCK_LINE_HEIGHT) {
    props["lineSpacing"] = formatLineSpacingMultiplier(lineHeight);
  }

  const marginTop = readExportNumber(style, "marginTop");
  if (marginTop !== null && marginTop !== 0) {
    props["spaceBefore"] = pxToPtString(marginTop);
  }

  const marginBottom = readExportNumber(style, "marginBottom");
  if (marginBottom !== null && marginBottom !== 0) {
    props["spaceAfter"] = pxToPtString(marginBottom);
  }

  const textIndent = readExportNumber(style, "textIndent");
  if (textIndent !== null && textIndent !== 0) {
    props["firstLineIndent"] = pxToPtString(textIndent);
  }

  const marginLeft = readExportNumber(style, "marginLeft");
  if (marginLeft !== null && marginLeft !== 0) {
    props["indent"] = pxToPtString(marginLeft);
  }
}

function pxToPtString(px: number): string {
  const pt = (px * 72) / 96;
  const rounded = Math.round(pt * 1000) / 1000;
  return Number.isInteger(rounded) ? `${rounded}pt` : `${rounded}pt`;
}

function formatLineSpacingMultiplier(lineHeight: number): string {
  const normalized = Math.round(lineHeight * 1000) / 1000;
  const body = Number.isInteger(normalized) ? String(normalized) : String(normalized);
  return `${body}x`;
}

function inlineRunProps(style: Record<string, unknown>): Record<string, string> {
  const props: Record<string, string> = {};
  const boolProps: Array<[string, string]> = [
    ["bold", "bold"],
    ["italic", "italic"],
    ["underline", "underline"],
    ["strikethrough", "strike"],
    ["superscript", "superscript"],
    ["subscript", "subscript"],
  ];
  for (const [source, target] of boolProps) {
    if (style[source] === true) props[target] = "true";
  }
  const fontFamily = readExportString(style, "fontFamily");
  if (fontFamily !== null) props["font"] = fontFamily;
  const fontSize = readExportNumber(style, "fontSize");
  if (fontSize !== null) props["size"] = `${fontSize}pt`;
  const color = readExportColor(style["color"]);
  if (color !== null) props["color"] = color;
  const backgroundColor = readExportColor(style["backgroundColor"]);
  if (backgroundColor !== null) props["fill"] = backgroundColor;
  return props;
}

function readExportColor(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (readExportString(record, "kind") === "srgb") {
      return readExportString(record, "value");
    }
  }
  return null;
}

function stylesEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return inlineStyleFingerprint(a) === inlineStyleFingerprint(b);
}

function inlineStyleFingerprint(style: Record<string, unknown>): string {
  const normalized = inlineRunProps(style);
  const keys = Object.keys(normalized).sort();
  return keys.map((key) => `${key}=${normalized[key]}`).join("|");
}

function tableCommands(
  block: Record<string, unknown>,
  tableIndex: number,
  id: string | undefined,
  skipped: ExportSkippedNode[],
): OfficeCliBatchCommand[] {
  const tableData = asRecord(block["tableData"]);
  const rows = Array.isArray(tableData?.["rows"]) ? tableData["rows"] : [];
  if (rows.length === 0) {
    skipped.push({ ...(id ? { blockId: id } : {}), type: "table", reason: "table has no rows" });
    return [];
  }
  const rowCells: unknown[][] = rows.map((row) => {
    const rowRecord = asRecord(row);
    const rawCells: unknown = rowRecord?.["cells"];
    if (!Array.isArray(rawCells)) return [];
    const cells: unknown[] = [];
    for (const cell of rawCells) cells.push(cell);
    return cells;
  });
  const gridColCount = Math.max(1, ...rowCells.map((cells) => cells.length));
  const colWidths = tableColWidths(tableData, gridColCount, id, skipped);
  const colCount = colWidths !== null ? colWidths.length : gridColCount;
  const dataRows = rows.map((row) => {
    const rowRecord = asRecord(row);
    const rawCells: unknown = rowRecord?.["cells"];
    const cells = Array.isArray(rawCells) ? rawCells : [];
    return Array.from({ length: colCount }, (_, index) => {
      const cell = asRecord(cells[index]);
      if (isCoveredCell(cell)) return "";
      return csvCell(cellText(cell));
    }).join(",");
  });
  const addProps: Record<string, string> = {
    rows: String(rows.length),
    cols: String(colCount),
    data: dataRows.join(";"),
  };
  if (colWidths !== null) addProps["colWidths"] = colWidths.join(",");

  const commands: OfficeCliBatchCommand[] = [{
    command: "add",
    parent: "/body",
    type: "table",
    props: addProps,
  }];

  const tablePath = `/body/tbl[${tableIndex}]`;
  const spanCommands: OfficeCliBatchCommand[] = [];
  for (let rowIndex = 0; rowIndex < rowCells.length; rowIndex += 1) {
    const cells = rowCells[rowIndex]!;
    for (let colIndex = 0; colIndex < Math.min(cells.length, colCount); colIndex += 1) {
      const cell = asRecord(cells[colIndex]);
      if (cell === null || isCoveredCell(cell)) continue;
      const cellPath = `${tablePath}/tr[${rowIndex + 1}]/tc[${colIndex + 1}]`;
      const styleProps = tableCellStyleProps(cell, id, skipped);
      if (Object.keys(styleProps).length > 0) {
        commands.push({ command: "set", path: cellPath, props: styleProps });
      }

      const rowSpan = readExportNumber(cell, "rowSpan");
      const colSpan = readExportNumber(cell, "colSpan");
      if (rowSpan !== null && rowSpan !== 1) {
        skipped.push({
          ...(id ? { blockId: id } : {}),
          type: "table-rowspan",
          reason: `rowSpan=${rowSpan} is not supported for .docx table export`,
        });
        continue;
      }
      if (colSpan === null || colSpan === 1) continue;
      if (!Number.isInteger(colSpan) || colSpan < 1 || colIndex + colSpan > colCount) {
        skipped.push({
          ...(id ? { blockId: id } : {}),
          type: "table-colspan",
          reason: `colSpan=${colSpan} cannot be safely applied at row ${rowIndex + 1}, column ${colIndex + 1}`,
        });
        continue;
      }
      spanCommands.unshift({ command: "set", path: cellPath, props: { colspan: String(colSpan) } });
    }
  }

  commands.push(...spanCommands);
  return commands;
}

function tableColWidths(
  tableData: Record<string, unknown> | null,
  colCount: number,
  id: string | undefined,
  skipped: ExportSkippedNode[],
): number[] | null {
  const rawWidths = Array.isArray(tableData?.["columnWidths"]) ? tableData["columnWidths"] : null;
  if (rawWidths === null) return null;
  const widths: number[] = [];
  for (const value of rawWidths) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      skipped.push({
        ...(id ? { blockId: id } : {}),
        type: "table-column-widths",
        reason: "tableData.columnWidths could not be safely mapped to OfficeCLI colWidths",
      });
      return null;
    }
    widths.push(value);
  }
  if (widths.length !== colCount || widths.some((value) => value < 0)) {
    skipped.push({
      ...(id ? { blockId: id } : {}),
      type: "table-column-widths",
      reason: "tableData.columnWidths could not be safely mapped to OfficeCLI colWidths",
    });
    return null;
  }
  const total = widths.reduce((sum, width) => sum + (width ?? 0), 0);
  if (total <= 0) {
    skipped.push({
      ...(id ? { blockId: id } : {}),
      type: "table-column-widths",
      reason: "tableData.columnWidths sum is zero",
    });
    return null;
  }
  let used = 0;
  return widths.map((width, index) => {
    if (index === widths.length - 1) return DEFAULT_TABLE_WIDTH_TWIPS - used;
    const twips = Math.round((width / total) * DEFAULT_TABLE_WIDTH_TWIPS);
    used += twips;
    return twips;
  });
}

function tableCellStyleProps(
  cell: Record<string, unknown>,
  id: string | undefined,
  skipped: ExportSkippedNode[],
): Record<string, string> {
  const props: Record<string, string> = {};
  const style = asRecord(cell["style"]);
  if (style === null) return props;

  const fill = readExportColor(style["backgroundColor"]);
  if (fill !== null) props["fill"] = fill;

  const verticalAlign = readExportString(style, "verticalAlign");
  if (verticalAlign !== null) {
    switch (verticalAlign) {
      case "top":
      case "bottom":
        props["valign"] = verticalAlign;
        break;
      case "middle":
        props["valign"] = "center";
        break;
      default:
        skipped.push({
          ...(id ? { blockId: id } : {}),
          type: "table-cell-style",
          reason: `verticalAlign '${verticalAlign}' is unsupported for .docx table export`,
        });
    }
  }
  return props;
}

function isCoveredCell(cell: Record<string, unknown> | null): boolean {
  return readExportNumber(cell ?? {}, "colSpan") === 0;
}

function cellText(cell: Record<string, unknown> | null): string {
  const blocks = Array.isArray(cell?.["blocks"]) ? cell["blocks"] : [];
  return blocks.map((block) => blockText(asRecord(block) ?? {})).join("\n");
}

function blockText(block: Record<string, unknown>): string {
  const inlines = Array.isArray(block["inlines"]) ? block["inlines"] : [];
  return inlines.map((inline) => readExportString(asRecord(inline) ?? {}, "text") ?? "").join("");
}

function csvCell(value: string): string {
  return /[",;\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readExportString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readExportNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
