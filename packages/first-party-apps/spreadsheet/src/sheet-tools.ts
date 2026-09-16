import { recalculateWorkbook } from "./sheet-calculation";
import {
  cellFromInput,
  getWorksheetEntries,
  normalizeRangeStylePatch,
  parseRanges,
  parseRef,
  toSref,
  type CellStyle,
  type Cell,
  type Range,
  type Store,
} from "../engine/node.js";
import {
  parseSheetHtml,
  serializeSheetHtml,
  type SheetDocument,
} from "./sheet-document";
import { createSheetStore } from "./sheet-store";
import {
  applySheetDataOperation,
  searchSheetDocument,
  validateSheetDataOperation,
  type SheetDataOperation,
} from "./sheet-data";

export type AppDocumentTarget =
  | { surface: "workspace"; path: string }
  | { surface: "currentFolder"; relativePath: string };

type WriteResult =
  | { kind: "saved"; sha256: string; revision?: number | null; size?: number }
  | { kind: "conflict"; currentSha256: string | null }
  | { kind: "error"; message: string };

export type ServerNautiloAppHost = {
  document: {
    createFromAction(
      actionId: string,
      opts: {
        targetSurface: "workspace" | "currentFolder";
        filename: string;
        openAfterCreate?: boolean;
      },
    ): Promise<{ target: AppDocumentTarget; displayPath: string; opened: boolean }>;
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
    ): Promise<WriteResult>;
    writeBound(next: { content: string }): Promise<WriteResult>;
  };
};

export type AgentToolContext = { nautiloApp: ServerNautiloAppHost };

type LiveDocumentVersion =
  | { kind: "artifact_revision"; revision: number }
  | { kind: "local_sha"; sha256: string };

type ToolError = {
  ok: false;
  status: "invalid_request" | "stale_revision" | "stale_version" | "error";
  code: string;
  message: string;
  stateChanged: false | "unknown";
  retrySafe: boolean;
};

type SetCellsOperation = {
  op: "set-cells";
  sheetId: string;
  cells: Array<{
    ref: string;
    value?: string | number | boolean | null;
    formula?: string;
  }>;
};

type FormatRangeOperation = {
  op: "format-range";
  sheetId: string;
  range: string;
  style: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    textColor?: string;
    fillColor?: string;
    align?: "left" | "center" | "right";
    verticalAlign?: "top" | "middle" | "bottom";
    numberFormat?: "plain" | "number" | "currency" | "percent" | "date";
    currencyCode?: string;
    decimalPlaces?: number;
  };
};

type RangeOperation = {
  op: "merge-cells" | "unmerge-cells";
  sheetId: string;
  range: string;
};

type StructuralOperation = {
  op: "insert-rows" | "delete-rows" | "insert-columns" | "delete-columns";
  sheetId: string;
  index: number;
  count: number;
};

export type SheetEditOperation =
  | SetCellsOperation
  | FormatRangeOperation
  | RangeOperation
  | StructuralOperation
  | SheetDataOperation;

type SheetSearch = {
  query: string;
  scope: "sheet" | "workbook";
  caseSensitive?: boolean;
  formulas?: boolean;
};

type InspectionCursor = {
  v: 1;
  version: string;
  sheetId: string;
  range: string;
  search: string | null;
  offset: number;
};

const SHA256_RE = /^[a-f0-9]{64}$/;
const A1_RANGE_RE = /^\$?[A-Za-z]+\$?[1-9][0-9]*(?::\$?[A-Za-z]+\$?[1-9][0-9]*)?$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function failure(
  status: ToolError["status"],
  code: string,
  message: string,
  retrySafe = false,
  stateChanged: ToolError["stateChanged"] = false,
): ToolError {
  return { ok: false, status, code, message, stateChanged, retrySafe };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKey(record: Record<string, unknown>, allowed: readonly string[]): string | null {
  return Object.keys(record).find((key) => !allowed.includes(key)) ?? null;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function validateTarget(value: unknown): AppDocumentTarget {
  const target = requireRecord(value, "target");
  const extra = unknownKey(target, ["surface", "path", "relativePath"]);
  if (extra) throw new Error(`target contains unknown field ${extra}`);
  if (target["surface"] === "workspace") {
    if (typeof target["path"] !== "string" || target["path"].trim().length === 0) {
      throw new Error("target.path is required for workspace");
    }
    if (target["relativePath"] !== undefined) throw new Error("workspace target cannot include relativePath");
    return { surface: "workspace", path: target["path"].trim() };
  }
  if (target["surface"] === "currentFolder") {
    if (typeof target["relativePath"] !== "string" || target["relativePath"].trim().length === 0) {
      throw new Error("target.relativePath is required for currentFolder");
    }
    if (target["path"] !== undefined) throw new Error("currentFolder target cannot include path");
    const relativePath = target["relativePath"].trim();
    if (
      relativePath.startsWith("/") ||
      relativePath.startsWith("\\") ||
      relativePath.split(/[\\/]/).includes("..") ||
      hasControlCharacters(relativePath)
    ) {
      throw new Error("target.relativePath must be a safe relative path");
    }
    return { surface: "currentFolder", relativePath };
  }
  throw new Error('target.surface must be "workspace" or "currentFolder"');
}

function validateFilename(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("filename must be a non-empty basename");
  }
  if (value !== value.trim() || value.includes("/") || value.includes("\\") || hasControlCharacters(value)) {
    throw new Error("filename must be a basename without path separators or control characters");
  }
  if (value.length <= ".spreadsheet.html".length || !value.toLowerCase().endsWith(".spreadsheet.html")) {
    throw new Error("filename must include a basename and end with .spreadsheet.html");
  }
  return value;
}

function parseRange(value: unknown, label = "range"): { range: Range; canonical: string } {
  if (typeof value !== "string" || !A1_RANGE_RE.test(value)) {
    throw new Error(`${label} must be one A1 range such as A1:C20`);
  }
  const ranges = parseRanges(value.toUpperCase());
  if (ranges.length !== 1) throw new Error(`${label} must contain exactly one range`);
  const raw = ranges[0];
  const range: Range = [
    { r: Math.min(raw[0].r, raw[1].r), c: Math.min(raw[0].c, raw[1].c) },
    { r: Math.max(raw[0].r, raw[1].r), c: Math.max(raw[0].c, raw[1].c) },
  ];
  for (const ref of range) {
    if (!Number.isSafeInteger(ref.r) || !Number.isSafeInteger(ref.c) || ref.r < 1 || ref.c < 1) {
      throw new Error(`${label} coordinates are outside the supported integer range`);
    }
  }
  const canonical = toSref(range[0]) === toSref(range[1])
    ? toSref(range[0])
    : `${toSref(range[0])}:${toSref(range[1])}`;
  return { range, canonical };
}

function parsePageSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("pageSize must be a positive integer selected by the caller");
  }
  return value as number;
}

function parseLiveVersion(value: unknown): LiveDocumentVersion {
  const version = requireRecord(value, "documentVersion");
  if (version["kind"] === "artifact_revision") {
    if (Object.keys(version).length !== 2 || !Number.isSafeInteger(version["revision"]) || (version["revision"] as number) < 0) {
      throw new Error("documentVersion must be a supported live document version");
    }
    return { kind: "artifact_revision", revision: version["revision"] as number };
  }
  if (version["kind"] === "local_sha") {
    if (Object.keys(version).length !== 2 || typeof version["sha256"] !== "string" || !SHA256_RE.test(version["sha256"])) {
      throw new Error("documentVersion must be a supported live document version");
    }
    return { kind: "local_sha", sha256: version["sha256"] };
  }
  throw new Error("documentVersion must be a supported live document version");
}

function resolveSheet(document: SheetDocument, sheetId: unknown): string {
  const resolved = sheetId === undefined ? document.tabOrder[0] : sheetId;
  if (typeof resolved !== "string" || !document.tabOrder.includes(resolved) || !document.sheets[resolved]) {
    throw new Error(`sheet does not exist: ${typeof resolved === "string" ? resolved : "unspecified"}`);
  }
  return resolved;
}

function inRange(ref: { r: number; c: number }, range: Range): boolean {
  return ref.r >= range[0].r && ref.r <= range[1].r && ref.c >= range[0].c && ref.c <= range[1].c;
}

function usedRange(document: SheetDocument, sheetId: string): string | null {
  const entries = getWorksheetEntries(document.sheets[sheetId]);
  if (entries.length === 0) return null;
  let minRow = Infinity;
  let minCol = Infinity;
  let maxRow = 0;
  let maxCol = 0;
  for (const [sref] of entries) {
    const ref = parseRef(sref);
    minRow = Math.min(minRow, ref.r);
    minCol = Math.min(minCol, ref.c);
    maxRow = Math.max(maxRow, ref.r);
    maxCol = Math.max(maxCol, ref.c);
  }
  const from = toSref({ r: minRow, c: minCol });
  const to = toSref({ r: maxRow, c: maxCol });
  return from === to ? from : `${from}:${to}`;
}

function cursorFor(cursor: InspectionCursor): string {
  return JSON.stringify(cursor);
}

function parseCursor(
  value: unknown,
  expected: Omit<InspectionCursor, "v" | "offset">,
): number {
  if (value === undefined) return 0;
  if (typeof value !== "string") throw new Error("cursor must be the exact continuation returned by inspection");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("cursor is invalid");
  }
  const cursor = requireRecord(parsed, "cursor");
  if (
    Object.keys(cursor).length !== 6 ||
    cursor["v"] !== 1 ||
    cursor["version"] !== expected.version ||
    cursor["sheetId"] !== expected.sheetId ||
    cursor["range"] !== expected.range ||
    cursor["search"] !== expected.search ||
    !Number.isSafeInteger(cursor["offset"]) ||
    (cursor["offset"] as number) < 0
  ) {
    throw new Error("cursor does not match this document version, sheet, range, or search");
  }
  return cursor["offset"] as number;
}

function parseSearch(value: unknown): SheetSearch | undefined {
  if (value === undefined) return undefined;
  const input = requireRecord(value, "search");
  const extra = unknownKey(input, ["query", "scope", "caseSensitive", "formulas"]);
  if (extra) throw new Error(`search contains unknown field ${extra}`);
  if (typeof input["query"] !== "string" || input["query"].length === 0) {
    throw new Error("search.query must be a non-empty string");
  }
  if (input["scope"] !== "sheet" && input["scope"] !== "workbook") {
    throw new Error('search.scope must be "sheet" or "workbook"');
  }
  for (const field of ["caseSensitive", "formulas"] as const) {
    if (input[field] !== undefined && typeof input[field] !== "boolean") {
      throw new Error(`search.${field} must be boolean`);
    }
  }
  return {
    query: input["query"],
    scope: input["scope"],
    ...(input["caseSensitive"] !== undefined ? { caseSensitive: input["caseSensitive"] as boolean } : {}),
    ...(input["formulas"] !== undefined ? { formulas: input["formulas"] as boolean } : {}),
  };
}

function filterInspection(document: SheetDocument, sheetId: string) {
  const worksheet = document.sheets[sheetId];
  return {
    filter: worksheet.filter ? structuredClone(worksheet.filter) : null,
    hiddenRows: [...(worksheet.hiddenRows ?? [])],
    hiddenColumns: [...(worksheet.hiddenColumns ?? [])],
  };
}

function inspectParsedDocument(
  document: SheetDocument,
  args: Record<string, unknown>,
  version: string,
) {
  const sheetId = resolveSheet(document, args["sheetId"]);
  const requested = parseRange(args["range"]);
  const pageSize = parsePageSize(args["pageSize"]);
  const search = parseSearch(args["search"]);
  const searchKey = search ? JSON.stringify(search) : null;
  const offset = parseCursor(args["cursor"], {
    version,
    sheetId,
    range: requested.canonical,
    search: searchKey,
  });
  const entries = getWorksheetEntries(document.sheets[sheetId])
    .map(([sref, cell]) => ({ ref: parseRef(sref), sref, cell }))
    .filter((entry) => inRange(entry.ref, requested.range))
    .sort((a, b) => a.ref.r - b.ref.r || a.ref.c - b.ref.c);
  const matches = search ? searchSheetDocument(document, { ...search, sheetId }) : undefined;
  const results = matches ?? entries;
  if (offset > results.length) throw new Error("cursor is past the current result set");
  const page = results.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  const complete = nextOffset >= results.length;
  return {
    sheets: document.tabOrder.map((id) => ({
      id,
      name: document.tabs[id].name,
      type: document.tabs[id].type,
      storedCellCount: getWorksheetEntries(document.sheets[id]).length,
      usedRange: usedRange(document, id),
    })),
    sheetId,
    sheetName: document.tabs[sheetId].name,
    requestedRange: requested.canonical,
    ...filterInspection(document, sheetId),
    cells: search ? [] : (page as typeof entries).map(({ sref, cell }) => ({
      ref: sref,
      ...(cell.v !== undefined ? { value: cell.v } : {}),
      ...(cell.f !== undefined ? { formula: cell.f } : {}),
      ...(cell.s !== undefined ? { style: structuredClone(cell.s) } : {}),
      ...(cell.spillRows !== undefined ? { spillRows: cell.spillRows } : {}),
      ...(cell.spillCols !== undefined ? { spillCols: cell.spillCols } : {}),
      ...(cell.spillAnchor !== undefined ? { spillAnchor: cell.spillAnchor } : {}),
      ...(cell.spillBlocked !== undefined ? { spillBlocked: cell.spillBlocked } : {}),
    })),
    sparseCellCount: entries.length,
    returnedCellCount: search ? 0 : page.length,
    ...(search ? {
      search,
      matches: structuredClone(page),
      matchCount: results.length,
      returnedMatchCount: page.length,
    } : {}),
    completeness: complete ? "complete" as const : "partial" as const,
    omittedCellCount: search ? 0 : entries.length - nextOffset,
    ...(search ? { omittedMatchCount: results.length - nextOffset } : {}),
    ...(complete ? {} : {
      nextCursor: cursorFor({
        v: 1,
        version,
        sheetId,
        range: requested.canonical,
        search: searchKey,
        offset: nextOffset,
      }),
    }),
  };
}

function parseStyle(value: unknown): CellStyle {
  const input = requireRecord(value, "style");
  const allowed = [
    "bold", "italic", "underline", "strikethrough", "textColor", "fillColor",
    "align", "verticalAlign", "numberFormat", "currencyCode", "decimalPlaces",
  ];
  const extra = unknownKey(input, allowed);
  if (extra) throw new Error(`style contains unsupported field ${extra}`);
  const style: CellStyle = {};
  for (const [publicKey, engineKey] of [
    ["bold", "b"], ["italic", "i"], ["underline", "u"], ["strikethrough", "st"],
  ] as const) {
    if (input[publicKey] !== undefined) {
      if (typeof input[publicKey] !== "boolean") throw new Error(`style.${publicKey} must be boolean`);
      style[engineKey] = input[publicKey];
    }
  }
  for (const [publicKey, engineKey] of [["textColor", "tc"], ["fillColor", "bg"]] as const) {
    if (input[publicKey] !== undefined) {
      if (typeof input[publicKey] !== "string" || !COLOR_RE.test(input[publicKey])) {
        throw new Error(`style.${publicKey} must be a six-digit #hex color`);
      }
      style[engineKey] = input[publicKey];
    }
  }
  if (input["align"] !== undefined) {
    if (!(["left", "center", "right"] as unknown[]).includes(input["align"])) throw new Error("style.align is invalid");
    style.al = input["align"] as CellStyle["al"];
  }
  if (input["verticalAlign"] !== undefined) {
    if (!(["top", "middle", "bottom"] as unknown[]).includes(input["verticalAlign"])) throw new Error("style.verticalAlign is invalid");
    style.va = input["verticalAlign"] as CellStyle["va"];
  }
  if (input["numberFormat"] !== undefined) {
    if (!(["plain", "number", "currency", "percent", "date"] as unknown[]).includes(input["numberFormat"])) throw new Error("style.numberFormat is invalid");
    style.nf = input["numberFormat"] as CellStyle["nf"];
  }
  if (input["currencyCode"] !== undefined) {
    if (typeof input["currencyCode"] !== "string" || !/^[A-Z]{3}$/.test(input["currencyCode"])) throw new Error("style.currencyCode must be an uppercase ISO currency code");
    style.cu = input["currencyCode"];
  }
  if (input["decimalPlaces"] !== undefined) {
    if (!Number.isSafeInteger(input["decimalPlaces"]) || (input["decimalPlaces"] as number) < 0) throw new Error("style.decimalPlaces must be a non-negative integer");
    style.dp = input["decimalPlaces"] as number;
  }
  if (Object.keys(style).length === 0) throw new Error("style must set at least one supported field");
  return style;
}

function parseOperations(value: unknown): SheetEditOperation[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("operations must be a non-empty array");
  return value.map((candidate, index) => {
    const operation = requireRecord(candidate, `operations[${index}]`);
    const op = operation["op"];
    if (op === "set-cells") {
      const extra = unknownKey(operation, ["op", "sheetId", "cells"]);
      if (extra) throw new Error(`operations[${index}] contains unknown field ${extra}`);
      if (typeof operation["sheetId"] !== "string" || operation["sheetId"].length === 0) throw new Error(`operations[${index}].sheetId is required`);
      if (!Array.isArray(operation["cells"]) || operation["cells"].length === 0) throw new Error(`operations[${index}].cells must be non-empty`);
      const seen = new Set<string>();
      const cells = operation["cells"].map((raw, cellIndex) => {
        const cell = requireRecord(raw, `operations[${index}].cells[${cellIndex}]`);
        const cellExtra = unknownKey(cell, ["ref", "value", "formula"]);
        if (cellExtra) throw new Error(`operations[${index}].cells[${cellIndex}] contains unknown field ${cellExtra}`);
        const parsed = parseRange(cell["ref"], `operations[${index}].cells[${cellIndex}].ref`);
        if (parsed.range[0].r !== parsed.range[1].r || parsed.range[0].c !== parsed.range[1].c) throw new Error("cell ref must name one cell");
        if (seen.has(parsed.canonical)) throw new Error(`duplicate cell ref ${parsed.canonical}`);
        seen.add(parsed.canonical);
        const hasValue = Object.hasOwn(cell, "value");
        const hasFormula = Object.hasOwn(cell, "formula");
        if (hasValue === hasFormula) throw new Error(`cell ${parsed.canonical} must contain exactly one of value or formula`);
        if (hasFormula && (typeof cell["formula"] !== "string" || cell["formula"].trim().length === 0)) throw new Error(`cell ${parsed.canonical} formula must be non-empty`);
        if (hasValue && cell["value"] !== null && !["string", "number", "boolean"].includes(typeof cell["value"])) throw new Error(`cell ${parsed.canonical} value is invalid`);
        if (typeof cell["value"] === "number" && !Number.isFinite(cell["value"])) throw new Error(`cell ${parsed.canonical} value must be finite`);
        return {
          ref: parsed.canonical,
          ...(hasValue ? { value: cell["value"] as string | number | boolean | null } : {}),
          ...(hasFormula ? { formula: cell["formula"] as string } : {}),
        };
      });
      return { op, sheetId: operation["sheetId"], cells };
    }
    if (op === "format-range") {
      const extra = unknownKey(operation, ["op", "sheetId", "range", "style"]);
      if (extra) throw new Error(`operations[${index}] contains unknown field ${extra}`);
      if (typeof operation["sheetId"] !== "string" || operation["sheetId"].length === 0) throw new Error(`operations[${index}].sheetId is required`);
      return {
        op,
        sheetId: operation["sheetId"],
        range: parseRange(operation["range"]).canonical,
        style: parseStyle(operation["style"]) as FormatRangeOperation["style"],
      };
    }
    if (op === "merge-cells" || op === "unmerge-cells") {
      const extra = unknownKey(operation, ["op", "sheetId", "range"]);
      if (extra) throw new Error(`operations[${index}] contains unknown field ${extra}`);
      if (typeof operation["sheetId"] !== "string" || operation["sheetId"].length === 0) throw new Error(`operations[${index}].sheetId is required`);
      return { op, sheetId: operation["sheetId"], range: parseRange(operation["range"]).canonical };
    }
    if (["insert-rows", "delete-rows", "insert-columns", "delete-columns"].includes(String(op))) {
      const extra = unknownKey(operation, ["op", "sheetId", "index", "count"]);
      if (extra) throw new Error(`operations[${index}] contains unknown field ${extra}`);
      if (typeof operation["sheetId"] !== "string" || operation["sheetId"].length === 0) throw new Error(`operations[${index}].sheetId is required`);
      if (!Number.isSafeInteger(operation["index"]) || (operation["index"] as number) < 1) throw new Error(`operations[${index}].index must be positive`);
      if (!Number.isSafeInteger(operation["count"]) || (operation["count"] as number) < 1) throw new Error(`operations[${index}].count must be positive`);
      return {
        op: op as StructuralOperation["op"],
        sheetId: operation["sheetId"],
        index: operation["index"] as number,
        count: operation["count"] as number,
      };
    }
    if (op === "sort-range" || op === "set-filter" || op === "clear-filter") {
      try {
        return validateSheetDataOperation(operation);
      } catch (error) {
        throw new Error(`operations[${index}]: ${errorMessage(error)}`);
      }
    }
    throw new Error(`operations[${index}].op is unsupported`);
  });
}

function rangesIntersect(a: Range, b: Range): boolean {
  return a[0].r <= b[1].r && a[1].r >= b[0].r && a[0].c <= b[1].c && a[1].c >= b[0].c;
}

const KNOWN_CELL_KEYS = new Set<keyof Cell>([
  "v", "f", "s", "spillRows", "spillCols", "spillAnchor", "spillBlocked",
]);

function assertReplaceableCell(cell: Cell | undefined, sref: string): void {
  if (!cell) return;
  const unknown = Object.keys(cell).find((key) => !KNOWN_CELL_KEYS.has(key as keyof Cell));
  if (unknown) {
    throw new Error(`cell ${sref} contains unsupported metadata ${unknown}; edit it in the sheet editor`);
  }
  if (
    cell.spillAnchor !== undefined ||
    cell.spillRows !== undefined ||
    cell.spillCols !== undefined ||
    cell.spillBlocked !== undefined
  ) {
    throw new Error(`cell ${sref} participates in a dynamic-array spill; edit it in the sheet editor`);
  }
}

function cellWithLiteralValue(cell: Cell | undefined, value: string | number | boolean): Cell {
  const storedValue = typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);
  return {
    v: storedValue,
    ...(cell?.s && Object.keys(cell.s).length > 0 ? { s: structuredClone(cell.s) } : {}),
  };
}

function styleOnlyCell(cell: Cell): Cell | undefined {
  return cell.s && Object.keys(cell.s).length > 0 ? { s: structuredClone(cell.s) } : undefined;
}

async function applyOperation(store: Store, operation: SheetEditOperation): Promise<{ changed: number; summary: string }> {
  if (operation.op === "set-cells") {
    let changed = 0;
    store.beginBatch();
    try {
      for (const input of operation.cells) {
        const ref = parseRef(input.ref);
        const existing = await store.get(ref);
        assertReplaceableCell(existing, input.ref);
        if ("formula" in input) {
          const formula = input.formula!.startsWith("=") ? input.formula! : `=${input.formula!}`;
          await store.set(ref, cellFromInput(formula, existing?.s));
        } else if (input.value === null) {
          const styleOnly = existing ? styleOnlyCell(existing) : undefined;
          if (styleOnly) await store.set(ref, styleOnly);
          else await store.delete(ref);
        } else {
          await store.set(ref, cellWithLiteralValue(existing, input.value ?? ""));
        }
        changed += 1;
      }
    } finally {
      store.endBatch();
    }
    return { changed, summary: `set ${changed} cell(s)` };
  }
  if (operation.op === "format-range") {
    const { range } = parseRange(operation.range);
    const normalized = normalizeRangeStylePatch({ range, style: operation.style as CellStyle });
    if (!normalized) throw new Error("format operation normalized to an empty style");
    await store.addRangeStyle(normalized);
    return { changed: 1, summary: `formatted ${operation.range}` };
  }
  if (operation.op === "merge-cells") {
    const { range } = parseRange(operation.range);
    const rows = range[1].r - range[0].r + 1;
    const columns = range[1].c - range[0].c + 1;
    if (rows === 1 && columns === 1) throw new Error("merge range must span at least two cells");
    const freeze = await store.getFreezePane();
    if (
      (freeze.frozenRows > 0 && range[0].r <= freeze.frozenRows && range[1].r > freeze.frozenRows) ||
      (freeze.frozenCols > 0 && range[0].c <= freeze.frozenCols && range[1].c > freeze.frozenCols)
    ) throw new Error("merge range cannot cross a frozen row or column boundary");
    for (const [anchorSref, span] of await store.getMerges()) {
      const anchor = parseRef(anchorSref);
      const existing: Range = [anchor, { r: anchor.r + span.rs - 1, c: anchor.c + span.cs - 1 }];
      if (rangesIntersect(existing, range)) throw new Error(`merge overlaps existing merge at ${anchorSref}`);
    }
    const anchor = range[0];
    const grid = await store.getGrid(range);
    for (const [sref, cell] of grid) {
      if (sref !== toSref(anchor)) assertReplaceableCell(cell, sref);
    }
    store.beginBatch();
    try {
      for (const [sref, cell] of grid) {
        if (sref === toSref(anchor)) continue;
        const ref = parseRef(sref);
        const styleOnly = styleOnlyCell(cell);
        if (styleOnly) await store.set(ref, styleOnly);
        else await store.delete(ref);
      }
      await store.setMerge(anchor, { rs: rows, cs: columns });
    } finally {
      store.endBatch();
    }
    return { changed: 1, summary: `merged ${operation.range}` };
  }
  if (operation.op === "unmerge-cells") {
    const { range } = parseRange(operation.range);
    const anchors: string[] = [];
    for (const [anchorSref, span] of await store.getMerges()) {
      const anchor = parseRef(anchorSref);
      const existing: Range = [anchor, { r: anchor.r + span.rs - 1, c: anchor.c + span.cs - 1 }];
      if (rangesIntersect(existing, range)) anchors.push(anchorSref);
    }
    store.beginBatch();
    try {
      for (const anchor of anchors) await store.deleteMerge(parseRef(anchor));
    } finally {
      store.endBatch();
    }
    return { changed: anchors.length, summary: `removed ${anchors.length} merge(s)` };
  }
  const structural = operation as StructuralOperation;
  const axis = structural.op.endsWith("rows") ? "row" : "column";
  const direction = structural.op.startsWith("insert") ? 1 : -1;
  await store.shiftCells(axis, structural.index, direction * structural.count);
  return {
    changed: structural.count,
    summary: `${structural.op} at ${structural.index} count ${structural.count}`,
  };
}

async function applyOperations(document: SheetDocument, raw: unknown) {
  const operations = parseOperations(raw);
  let next = structuredClone(document);
  const receipt: Array<{ operationIndex: number; op: string; sheetId: string; changed: number; summary: string }> = [];
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index];
    resolveSheet(next, operation.sheetId);
    if (operation.op === "sort-range" || operation.op === "set-filter" || operation.op === "clear-filter") {
      next = await applySheetDataOperation(next, operation);
      receipt.push({
        operationIndex: index,
        op: operation.op,
        sheetId: operation.sheetId,
        changed: 1,
        summary: operation.op === "sort-range"
          ? `sorted ${operation.range} by column ${operation.column} ${operation.direction}`
          : operation.op === "set-filter"
            ? `filtered ${operation.range}`
            : "cleared filter",
      });
      continue;
    }
    const adapter = await createSheetStore(next, operation.sheetId, () => undefined);
    try {
      const result = await applyOperation(adapter.store, operation);
      next = await adapter.snapshot();
      receipt.push({ operationIndex: index, op: operation.op, sheetId: operation.sheetId, ...result });
    } finally {
      adapter.dispose();
    }
  }
  return { document: await recalculateWorkbook(next), receipt };
}

export async function createFile(args: unknown, ctx: AgentToolContext) {
  let options: {
    targetSurface: "workspace" | "currentFolder";
    filename: string;
    openAfterCreate?: boolean;
  };
  try {
    const input = requireRecord(args, "arguments");
    const extra = unknownKey(input, ["targetSurface", "filename", "openAfterCreate", "initialContent"]);
    if (extra) throw new Error(`unknown field ${extra}`);
    if (input["targetSurface"] !== "workspace" && input["targetSurface"] !== "currentFolder") throw new Error("targetSurface is invalid");
    const filename = validateFilename(input["filename"]);
    if (input["openAfterCreate"] !== undefined && typeof input["openAfterCreate"] !== "boolean") throw new Error("openAfterCreate must be boolean");
    if (input["initialContent"] !== undefined && input["initialContent"] !== "empty") throw new Error("initialContent must be empty");
    options = {
      targetSurface: input["targetSurface"],
      filename,
      ...(input["openAfterCreate"] !== undefined ? { openAfterCreate: input["openAfterCreate"] } : {}),
    };
  } catch (error) {
    return failure("invalid_request", "invalid_create_request", errorMessage(error), true);
  }
  try {
    const result = await ctx.nautiloApp.document.createFromAction("new-spreadsheet", options);
    return { ok: true as const, status: "created" as const, ...result };
  } catch (error) {
    return failure("error", "create_failed", errorMessage(error), false, "unknown");
  }
}

export async function inspectDocument(args: unknown, ctx: AgentToolContext) {
  try {
    const input = requireRecord(args, "arguments");
    const extra = unknownKey(input, ["target", "sheetId", "range", "pageSize", "cursor", "search"]);
    if (extra) throw new Error(`unknown field ${extra}`);
    const target = validateTarget(input["target"]);
    const envelope = await ctx.nautiloApp.document.read(target);
    if (envelope.baseSha256 === null || !SHA256_RE.test(envelope.baseSha256)) {
      throw new Error("host did not provide the revision identity required for safe continuation and editing");
    }
    const inspection = inspectParsedDocument(parseSheetHtml(envelope.content), input, envelope.baseSha256);
    return {
      ok: true as const,
      status: "inspected" as const,
      displayPath: envelope.displayPath,
      expectedSha256: envelope.baseSha256,
      revision: envelope.baseRevision,
      ...inspection,
    };
  } catch (error) {
    return failure("invalid_request", "inspection_failed", errorMessage(error), true);
  }
}

export async function editDocument(args: unknown, ctx: AgentToolContext) {
  let input: Record<string, unknown>;
  let target: AppDocumentTarget;
  try {
    input = requireRecord(args, "arguments");
    const extra = unknownKey(input, ["target", "expectedSha256", "operations"]);
    if (extra) throw new Error(`unknown field ${extra}`);
    target = validateTarget(input["target"]);
    if (typeof input["expectedSha256"] !== "string" || !SHA256_RE.test(input["expectedSha256"])) throw new Error("expectedSha256 must be copied from inspect-document");
  } catch (error) {
    return failure("invalid_request", "edit_failed", errorMessage(error), true);
  }
  let envelope: Awaited<ReturnType<ServerNautiloAppHost["document"]["read"]>>;
  try {
    envelope = await ctx.nautiloApp.document.read(target);
  } catch (error) {
    return failure("error", "read_failed", errorMessage(error), true);
  }
  try {
    if (envelope.baseSha256 !== input["expectedSha256"]) {
      return failure("stale_revision", "stale_revision", "The spreadsheet changed after inspection. Inspect it again before deciding whether to edit.", false);
    }
    const applied = await applyOperations(parseSheetHtml(envelope.content), input["operations"]);
    const content = serializeSheetHtml(applied.document);
    let write: WriteResult;
    try {
      write = await ctx.nautiloApp.document.write(
        target,
        { content },
        { baseSha256: envelope.baseSha256, baseRevision: envelope.baseRevision },
      );
    } catch (error) {
      return failure("error", "write_failed", errorMessage(error), false, "unknown");
    }
    if (write.kind === "conflict") return failure("stale_revision", "write_conflict", "The spreadsheet changed before the edit could be saved. Inspect it again.", false);
    if (write.kind === "error") return failure("error", "write_failed", write.message, false);
    return {
      ok: true as const,
      status: "saved" as const,
      displayPath: envelope.displayPath,
      sha256: write.sha256,
      revision: write.revision ?? null,
      receipt: applied.receipt,
    };
  } catch (error) {
    return failure("invalid_request", "edit_failed", `${envelope.displayPath}: ${errorMessage(error)}`, true);
  }
}

function liveBase(args: unknown, allowed: readonly string[]) {
  const input = requireRecord(args, "arguments");
  const extra = unknownKey(input, [...allowed, "sessionToken", "documentVersion", "idempotencyKey", "__canonicalContent"]);
  if (extra) throw new Error(`unknown field ${extra}`);
  if (typeof input["sessionToken"] !== "string" || input["sessionToken"].length === 0) throw new Error("live Sheets session is unavailable");
  const documentVersion = parseLiveVersion(input["documentVersion"]);
  if (typeof input["__canonicalContent"] !== "string") throw new Error("live Sheets session is unavailable");
  return {
    input,
    documentVersion,
    versionToken: JSON.stringify(documentVersion),
    document: parseSheetHtml(input["__canonicalContent"]),
  };
}

export function inspectOpenSheet(args: unknown, _ctx: AgentToolContext) {
  try {
    const base = liveBase(args, ["sheetId", "range", "pageSize", "cursor", "search"]);
    return {
      ok: true as const,
      status: "inspected" as const,
      documentVersion: base.documentVersion,
      versionToken: base.versionToken,
      ...inspectParsedDocument(base.document, base.input, base.versionToken),
    };
  } catch (error) {
    return failure("invalid_request", "inspection_failed", errorMessage(error), true);
  }
}

function nextVersion(write: Extract<WriteResult, { kind: "saved" }>, previous: LiveDocumentVersion): LiveDocumentVersion {
  if (previous.kind === "artifact_revision" && Number.isSafeInteger(write.revision)) {
    return { kind: "artifact_revision", revision: write.revision as number };
  }
  if (previous.kind === "local_sha" && SHA256_RE.test(write.sha256)) return { kind: "local_sha", sha256: write.sha256 };
  return previous;
}

export async function editOpenSheet(args: unknown, ctx: AgentToolContext) {
  try {
    const base = liveBase(args, ["expectedVersion", "operations"]);
    if (typeof base.input["expectedVersion"] !== "string" || base.input["expectedVersion"] !== base.versionToken) {
      return failure("stale_version", "stale_version", "The open spreadsheet version differs from the inspected version. Inspect it again before deciding whether to edit.", false);
    }
    const applied = await applyOperations(base.document, base.input["operations"]);
    let write: WriteResult;
    try {
      write = await ctx.nautiloApp.document.writeBound({ content: serializeSheetHtml(applied.document) });
    } catch (error) {
      return failure("error", "bound_write_failed", errorMessage(error), false, "unknown");
    }
    if (write.kind === "conflict") return failure("stale_version", "version_conflict", "The open spreadsheet changed before the edit could be saved. Inspect it again.", false);
    if (write.kind === "error") return failure("error", "bound_write_failed", write.message, false);
    const documentVersion = nextVersion(write, base.documentVersion);
    return {
      ok: true as const,
      status: "saved" as const,
      documentVersion,
      versionToken: JSON.stringify(documentVersion),
      receipt: applied.receipt,
    };
  } catch (error) {
    return failure("invalid_request", "edit_failed", errorMessage(error), true);
  }
}
