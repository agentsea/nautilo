import { extractTokens, getWorksheetCell, getWorksheetEntries, parseRanges, parseRef, toSref, type Range, type Worksheet } from "../engine/node.js";
import { recalculateWorkbook } from "./sheet-calculation";
import { validateSheetDocument, type SheetDocument } from "./sheet-document";
import { sheetCellDisplay, type SheetFilterCondition } from "./sheet-filter";
export type { SheetFilterCondition } from "./sheet-filter";

export type SheetDataOperation =
  | { op: "sort-range"; sheetId: string; range: string; column: number; direction: "asc" | "desc"; header: boolean }
  | { op: "set-filter"; sheetId: string; range: string; columns: Record<string, SheetFilterCondition> }
  | { op: "clear-filter"; sheetId: string };

export type SheetSearchOptions = { query: string; scope: "sheet" | "workbook"; sheetId: string; caseSensitive?: boolean; formulas?: boolean };
export type SheetSearchMatch = { sheetId: string; sheetName: string; ref: string; value?: string; formula?: string; hidden: boolean };

export function parseSheetDataRange(value: string): Range {
  if (typeof value !== "string" || !/^\$?[A-Za-z]+\$?[1-9]\d*(?::\$?[A-Za-z]+\$?[1-9]\d*)?$/.test(value)) throw new Error("Enter a bounded cell range, such as A1:D20.");
  const range = parseRanges(value)[0];
  if (!range || range.some(ref => !Number.isSafeInteger(ref.r) || !Number.isSafeInteger(ref.c) || ref.r < 1 || ref.c < 1)) throw new Error("Range coordinates must be positive safe integers.");
  return [{ r: Math.min(range[0].r, range[1].r), c: Math.min(range[0].c, range[1].c) }, { r: Math.max(range[0].r, range[1].r), c: Math.max(range[0].c, range[1].c) }];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Data operation fields must be objects.");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) throw new Error(`Unsupported data field: ${extra}`);
}

export function validateSheetDataOperation(value: unknown): SheetDataOperation {
  const input = record(value);
  if (typeof input["sheetId"] !== "string" || !input["sheetId"]) throw new Error("sheetId is required.");
  const sheetId = input["sheetId"];
  if (input["op"] === "clear-filter") { fields(input, ["op", "sheetId"]); return { op: "clear-filter", sheetId }; }
  const range = parseSheetDataRange(input["range"] as string);
  const canonical = `${toSref(range[0])}:${toSref(range[1])}`;
  if (input["op"] === "sort-range") {
    fields(input, ["op", "sheetId", "range", "column", "direction", "header"]);
    const column = input["column"];
    if (!Number.isSafeInteger(column) || (column as number) < range[0].c || (column as number) > range[1].c) throw new Error("Sort column must be inside the range.");
    if (input["direction"] !== "asc" && input["direction"] !== "desc") throw new Error("Sort direction must be asc or desc.");
    if (typeof input["header"] !== "boolean") throw new Error("Choose whether the first row is a header.");
    return { op: "sort-range", sheetId, range: canonical, column: column as number, direction: input["direction"], header: input["header"] };
  }
  if (input["op"] !== "set-filter") throw new Error("Unsupported data operation.");
  fields(input, ["op", "sheetId", "range", "columns"]);
  if (range[1].r <= range[0].r) throw new Error("A filter needs a header row and at least one data row.");
  const columns: Record<string, SheetFilterCondition> = {};
  for (const [key, raw] of Object.entries(record(input["columns"]))) {
    const column = Number(key);
    if (!Number.isSafeInteger(column) || String(column) !== key || column < range[0].c || column > range[1].c) throw new Error("Filter columns must be canonical column numbers inside the range.");
    const condition = record(raw);
    const op = condition["op"];
    if (op === "isEmpty" || op === "isNotEmpty") { fields(condition, ["op"]); columns[key] = { op }; }
    else if (op === "in") {
      fields(condition, ["op", "values"]);
      if (!Array.isArray(condition["values"]) || condition["values"].some(item => typeof item !== "string")) throw new Error("Filter values must be strings.");
      columns[key] = { op, values: [...new Set(condition["values"] as string[])] };
    } else if (op === "contains" || op === "notContains" || op === "equals" || op === "notEquals") {
      fields(condition, ["op", "value"]);
      if (typeof condition["value"] !== "string" || !condition["value"].trim()) throw new Error("Enter a filter value, or choose an empty-cell condition.");
      columns[key] = { op, value: condition["value"].trim() };
    } else throw new Error("Unsupported filter condition.");
  }
  return { op: "set-filter", sheetId, range: canonical, columns };
}

export function sheetDataRange(document: SheetDocument, sheetId: string, selection?: Range): string {
  if (selection && (selection[0].r !== selection[1].r || selection[0].c !== selection[1].c)) return `${toSref(selection[0])}:${toSref(selection[1])}`;
  const sheet = document.sheets[sheetId];
  if (!sheet) throw new Error("That sheet no longer exists.");
  if (sheet.filter) return `${toSref({ r: sheet.filter.startRow, c: sheet.filter.startCol })}:${toSref({ r: sheet.filter.endRow, c: sheet.filter.endCol })}`;
  const refs = getWorksheetEntries(sheet).map(([ref]) => parseRef(ref));
  if (!refs.length) return "A1:A1";
  const start = { ...refs[0] }, end = { ...refs[0] };
  for (const ref of refs) { start.r = Math.min(start.r, ref.r); start.c = Math.min(start.c, ref.c); end.r = Math.max(end.r, ref.r); end.c = Math.max(end.c, ref.c); }
  return `${toSref(start)}:${toSref(end)}`;
}

/** Translate only reference tokens, preserving strings, absolute rows and whole-column ranges. */
function sortedFormula(formula: string, delta: number): string {
  if (!delta) return formula;
  return "=" + extractTokens(formula).map(token => {
    if (token.type !== "REFERENCE") return token.text;
    const split = token.text.lastIndexOf("!");
    const prefix = token.text.slice(0, split + 1);
    const local = token.text.slice(split + 1);
    return prefix + local.split(":").map(ref => {
      const match = /^(\$?[A-Za-z]+)?(\$?)([1-9]\d*)$/.exec(ref);
      if (!match || match[2]) return ref;
      const row = Number(match[3]) + delta;
      return row < 1 || !Number.isSafeInteger(row) ? "#REF!" : `${match[1] ?? ""}${row}`;
    }).join(":");
  }).join("");
}

function intersectsRows(range: Range, start: number, end: number): boolean { return range[0].r <= end && range[1].r >= start; }

function assertSortable(sheet: Worksheet, start: number, end: number): void {
  const known = new Set(["cells", "rowOrder", "colOrder", "nextRowId", "nextColId", "rowHeights", "colWidths", "colStyles", "rowStyles", "sheetStyle", "rangeStyles", "conditionalFormats", "dataValidations", "merges", "filter", "hiddenRows", "hiddenColumns", "charts", "images", "comments", "frozenRows", "frozenCols", "pivotTable"]);
  if (Object.keys(sheet).some(key => !known.has(key))) throw new Error("Sorting cannot safely move unsupported worksheet metadata.");
  for (const [ref, cell] of getWorksheetEntries(sheet)) {
    const row = parseRef(ref).r;
    if (row >= start && row <= end && [cell.spillAnchor, cell.spillRows, cell.spillCols, cell.spillBlocked].some(value => value !== undefined)) throw new Error("Sorting rows with dynamic-array spills is unsupported. Your sheet is unchanged.");
  }
  for (const [ref, span] of Object.entries(sheet.merges ?? {})) {
    const row = parseRef(ref).r;
    if (row <= end && row + span.rs - 1 >= start) throw new Error("Unmerge cells in these rows before sorting.");
  }
  // Their formulas/anchors have separate semantics; refuse rather than detach them from records.
  if (sheet.conditionalFormats?.some(rule => rule.ranges.some(range => intersectsRows(range, start, end))) || sheet.dataValidations?.some(rule => rule.ranges.some(range => intersectsRows(range, start, end))) || Object.keys(sheet.comments ?? {}).length || Object.keys(sheet.images ?? {}).length || Object.keys(sheet.charts ?? {}).length || sheet.pivotTable) throw new Error("Sorting rows with validation, conditional formatting, comments, images, charts or pivots is not supported yet. Your sheet is unchanged.");
  if (sheet.filter && start < sheet.filter.endRow && end > sheet.filter.endRow) throw new Error("Sort within the filtered data range, or clear the filter first.");
  if (sheet.filter && start <= sheet.filter.startRow && end >= sheet.filter.startRow) throw new Error("Keep the active filter's header out of the sort. Select First row is a header.");
}

function sortRows(sheet: Worksheet, operation: Extract<SheetDataOperation, { op: "sort-range" }>): void {
  const range = parseSheetDataRange(operation.range);
  const start = range[0].r + Number(operation.header), end = range[1].r;
  if (start >= end) return;
  assertSortable(sheet, start, end);
  const rows = Array.from({ length: end - start + 1 }, (_, index) => {
    const row = start + index;
    const value = getWorksheetCell(sheet, { r: row, c: operation.column })?.v?.trim() ?? "";
    const number = value && Number.isFinite(Number(value)) ? Number(value) : null;
    return { row, value, number };
  });
  rows.sort((a, b) => {
    if (!a.value || !b.value) return a.value ? -1 : b.value ? 1 : a.row - b.row;
    const compared = a.number !== null && b.number !== null ? a.number - b.number : a.number !== null ? -1 : b.number !== null ? 1 : a.value.toLowerCase().localeCompare(b.value.toLowerCase(), "en");
    return compared ? (operation.direction === "asc" ? compared : -compared) : a.row - b.row;
  });
  if (rows.every((row, index) => row.row === start + index)) return;
  const mapping = new Map(rows.map(({ row }, index) => [row, start + index]));
  // Formulas and all unknown cell fields stay with their existing stable row IDs.
  for (const [ref, cell] of getWorksheetEntries(sheet)) {
    const oldRow = parseRef(ref).r;
    const newRow = mapping.get(oldRow);
    if (cell.f && newRow !== undefined && oldRow !== newRow) {
      cell.f = sortedFormula(cell.f, newRow - oldRow);
      delete cell.v;
    }
  }
  const order = [...sheet.rowOrder];
  for (const [oldRow, newRow] of mapping) sheet.rowOrder[newRow - 1] = order[oldRow - 1];
  const remapRecord = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).map(([key, value]) => [String(mapping.get(Number(key)) ?? Number(key)), value]));
  sheet.rowHeights = remapRecord(sheet.rowHeights);
  sheet.rowStyles = remapRecord(sheet.rowStyles);
  if (sheet.hiddenRows) sheet.hiddenRows = sheet.hiddenRows.map(row => mapping.get(row) ?? row).sort((a, b) => a - b);
  // Split and recombine contiguous mapped intervals. No per-cell style expansion.
  if (sheet.rangeStyles) sheet.rangeStyles = sheet.rangeStyles.flatMap(patch => {
    if (!intersectsRows(patch.range, start, end)) return [patch];
    const [from, to] = patch.range;
    const intervals: Array<[number, number]> = [];
    if (from.r < start) intervals.push([from.r, start - 1]);
    if (to.r > end) intervals.push([end + 1, to.r]);
    const mapped: number[] = [];
    for (let row = Math.max(from.r, start); row <= Math.min(to.r, end); row++) mapped.push(mapping.get(row)!);
    mapped.sort((a, b) => a - b);
    for (const row of mapped) {
      const last = intervals.at(-1);
      if (last && last[1] + 1 === row) last[1] = row;
      else intervals.push([row, row]);
    }
    return intervals.map(([first, last]) => ({ ...structuredClone(patch), range: [{ r: first, c: from.c }, { r: last, c: to.c }] as Range }));
  });
}

export async function applySheetDataOperation(input: SheetDocument, candidate: SheetDataOperation): Promise<SheetDocument> {
  const operation = validateSheetDataOperation(candidate);
  const document = await recalculateWorkbook(structuredClone(validateSheetDocument(input)));
  const sheet = document.sheets[operation.sheetId];
  if (!sheet || document.tabs[operation.sheetId]?.type !== "sheet") throw new Error("Choose an editable sheet.");
  if (operation.op !== "clear-filter") {
    const range = parseSheetDataRange(operation.range);
    if (range[1].r > sheet.rowOrder.length || range[1].c > sheet.colOrder.length) throw new Error("The data range extends beyond this sheet's stored rows or columns. Choose an existing data range.");
  }
  if (operation.op === "sort-range") sortRows(sheet, operation);
  else if (operation.op === "clear-filter") delete sheet.filter;
  else {
    const [from, to] = parseSheetDataRange(operation.range);
    sheet.filter = { startRow: from.r, endRow: to.r, startCol: from.c, endCol: to.c, columns: structuredClone(operation.columns), hiddenRows: [] };
  }
  return recalculateWorkbook(document);
}

export function searchSheetDocument(document: SheetDocument, options: SheetSearchOptions): SheetSearchMatch[] {
  if (!document.sheets[options.sheetId]) throw new Error("That sheet no longer exists.");
  if (!options.query) return [];
  const normalize = (value: string) => options.caseSensitive ? value : value.toLowerCase();
  const needle = normalize(options.query);
  const matches: SheetSearchMatch[] = [];
  for (const id of options.scope === "workbook" ? document.tabOrder : [options.sheetId]) {
    const sheet = document.sheets[id];
    const hidden = new Set([...(sheet.hiddenRows ?? []), ...(sheet.filter?.hiddenRows ?? [])]);
    const entries = getWorksheetEntries(sheet).sort(([a], [b]) => parseRef(a).r - parseRef(b).r || parseRef(a).c - parseRef(b).c);
    for (const [ref, cell] of entries) {
      const point = parseRef(ref);
      if (![sheetCellDisplay(sheet, point, cell), cell.v ?? "", ...(options.formulas ? [cell.f ?? ""] : [])].some(value => normalize(value).includes(needle))) continue;
      matches.push({ sheetId: id, sheetName: document.tabs[id].name, ref, ...(cell.v !== undefined ? { value: cell.v } : {}), ...(cell.f !== undefined ? { formula: cell.f } : {}), hidden: hidden.has(point.r) || Boolean(sheet.hiddenColumns?.includes(point.c)) });
    }
  }
  return matches;
}
