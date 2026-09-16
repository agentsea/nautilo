import { formatValue, getWorksheetEntries, matchesFilterCondition, parseRef, resolveWorksheetCellStyle, toSref, type Cell, type Worksheet } from "../engine/node.js";
import type { SheetDocument } from "./sheet-document";

export type SheetFilterCondition = {
  op: "contains" | "notContains" | "equals" | "notEquals" | "isEmpty" | "isNotEmpty" | "in";
  value?: string;
  values?: string[];
};

export function validateStoredFilter(value: unknown, extent: { rows: number; columns: number }): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sheet filter must be an object.");
  const filter = value as Record<string, unknown>;
  if (Object.keys(filter).some(key => !["startRow", "endRow", "startCol", "endCol", "columns", "hiddenRows"].includes(key))) throw new Error("Unsupported filter metadata cannot be edited safely.");
  for (const key of ["startRow", "endRow", "startCol", "endCol"]) {
    if (!Number.isSafeInteger(filter[key]) || (filter[key] as number) < 1) throw new Error("Filter coordinates must be positive safe integers.");
  }
  if ((filter["startRow"] as number) >= (filter["endRow"] as number) || (filter["startCol"] as number) > (filter["endCol"] as number)) throw new Error("Filter range must include a header and data rows.");
  if ((filter["endRow"] as number) > extent.rows || (filter["endCol"] as number) > extent.columns) throw new Error("Filter range extends beyond this sheet's stored extent.");
  const columns = filter["columns"];
  if (!columns || typeof columns !== "object" || Array.isArray(columns)) throw new Error("Filter columns must be an object.");
  for (const [key, raw] of Object.entries(columns)) {
    const column = Number(key);
    if (!Number.isSafeInteger(column) || String(column) !== key || column < (filter["startCol"] as number) || column > (filter["endCol"] as number)) throw new Error("Filter column is outside its range.");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid filter condition.");
    const condition = raw as Record<string, unknown>;
    const op = condition["op"];
    const allowed = op === "in" ? ["op", "values"] : op === "isEmpty" || op === "isNotEmpty" ? ["op"] : ["op", "value"];
    if (Object.keys(condition).some(key => !allowed.includes(key))) throw new Error("Unsupported filter condition metadata.");
    if (op === "in") {
      if (!Array.isArray(condition["values"]) || condition["values"].some(value => typeof value !== "string")) throw new Error("Invalid filter values.");
    } else if (op !== "isEmpty" && op !== "isNotEmpty") {
      if (!["contains", "notContains", "equals", "notEquals"].includes(String(op)) || typeof condition["value"] !== "string") throw new Error("Invalid filter condition.");
    }
  }
  if (!Array.isArray(filter["hiddenRows"]) || filter["hiddenRows"].some(row => !Number.isSafeInteger(row) || row <= (filter["startRow"] as number) || row > (filter["endRow"] as number))) throw new Error("Invalid filter hidden rows.");
}

export function sheetCellDisplay(sheet: Worksheet, ref: { r: number; c: number }, cell: Cell): string {
  const style = resolveWorksheetCellStyle(sheet, ref, cell.s);
  return formatValue(cell.v ?? "", style?.nf, style?.dp, { currency: style?.cu });
}

/** Recompute derived visibility after every workbook calculation, including Genie writes. */
export function refreshSheetFilters(document: SheetDocument): void {
  for (const id of document.tabOrder) {
    if (document.tabs[id].type !== "sheet") continue;
    const sheet = document.sheets[id];
    const filter = sheet.filter;
    if (!filter) continue;
    validateStoredFilter(filter, { rows: sheet.rowOrder.length, columns: sheet.colOrder.length });
    const conditions = Object.entries(filter.columns);
    if (conditions.length === 0) { filter.hiddenRows = []; continue; }
    const values = new Map(getWorksheetEntries(sheet).map(([ref, cell]) => [ref, sheetCellDisplay(sheet, parseRef(ref), cell)]));
    const hidden: number[] = [];
    for (let row = filter.startRow + 1; row <= filter.endRow; row++) {
      if (conditions.some(([col, condition]) => {
        return !matchesFilterCondition(values.get(toSref({ r: row, c: Number(col) })) ?? "", condition);
      })) hidden.push(row);
    }
    filter.hiddenRows = hidden;
  }
}
