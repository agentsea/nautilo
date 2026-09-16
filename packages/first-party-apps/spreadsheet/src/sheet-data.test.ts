import { describe, expect, test } from "bun:test";
import { getWorksheetCell, resolveWorksheetCellStyle, writeWorksheetCell } from "../engine/node.js";
import { addSheet, createSheetDocument, parseSheetHtml, serializeSheetHtml, validateSheetDocument } from "./sheet-document";
import { applySheetDataOperation, searchSheetDocument, validateSheetDataOperation } from "./sheet-data";
import { recalculateWorkbook } from "./sheet-calculation";
import { createSheetHistory } from "./sheet-store";

const sheetId = "tab-1";
function fixture() {
  const document = createSheetDocument();
  const sheet = document.sheets[sheetId];
  ["Amount", "20", "3", "3", ""].forEach((v, index) => writeWorksheetCell(sheet, { r: index + 1, c: 1 }, { v }));
  for (let r = 2; r <= 5; r++) {
    writeWorksheetCell(sheet, { r, c: 2 }, { f: `=A${r}*2` });
    writeWorksheetCell(sheet, { r, c: 4 }, { v: `record-${r}`, futureCell: { id: r }, s: { i: true } } as never);
  }
  sheet.rowHeights = { "2": 45, "3": 32 };
  sheet.rowStyles = { "2": { b: true }, "3": { tc: "#ff0000" } };
  sheet.rangeStyles = [{ range: [{ r: 2, c: 1 }, { r: 2, c: 4 }], style: { bg: "#ffff00" } }];
  return document;
}
const sort = { op: "sort-range", sheetId, range: "A1:B5", column: 1, direction: "asc", header: true } as const;

describe("shared sheet data operations", () => {
  test("sorts numeric keys stably, moves entire rows/styles/unknown fields, relocates formulas and round-trips", async () => {
    const original = fixture();
    const before = structuredClone(original);
    const result = await applySheetDataOperation(original, sort);
    const sheet = result.sheets[sheetId];
    expect(original).toEqual(before);
    expect([2, 3, 4, 5].map(r => getWorksheetCell(sheet, { r, c: 1 })?.v)).toEqual(["3", "3", "20", ""]);
    expect(getWorksheetCell(sheet, { r: 2, c: 4 })).toMatchObject({ v: "record-3", futureCell: { id: 3 }, s: { i: true } });
    expect(getWorksheetCell(sheet, { r: 4, c: 2 })).toMatchObject({ f: "=A4*2", v: "40" });
    expect(sheet.rowHeights).toEqual({ "4": 45, "2": 32 });
    expect(sheet.rowStyles["4"]).toEqual({ b: true });
    expect(resolveWorksheetCellStyle(sheet, { r: 4, c: 2 })?.bg).toBe("#ffff00");
    expect(resolveWorksheetCellStyle(sheet, { r: 2, c: 2 })?.bg).toBeUndefined();
    expect(parseSheetHtml(serializeSheetHtml(result))).toEqual(result);
    const history = createSheetHistory(); history.record(original, result, sheetId);
    const undo = history.undo(result, sheetId).document;
    expect(undo).toEqual(original);
    expect(history.redo(undo, sheetId).document).toEqual(result);
  });

  test("descending ties remain stable, blanks last; no-header sorts include first row", async () => {
    const result = await applySheetDataOperation(fixture(), { ...sort, direction: "desc" });
    expect([2, 3, 4, 5].map(r => getWorksheetCell(result.sheets[sheetId], { r, c: 4 })?.v)).toEqual(["record-2", "record-3", "record-4", "record-5"]);
    const doc = fixture();
    writeWorksheetCell(doc.sheets[sheetId], { r: 1, c: 1 }, { v: "100" });
    const noHeader = await applySheetDataOperation(doc, { ...sort, header: false });
    expect(getWorksheetCell(noHeader.sheets[sheetId], { r: 1, c: 1 })?.v).toBe("3");
  });

  test("relative, absolute, cross-sheet and quoted references retain their semantics", async () => {
    const added = addSheet(fixture(), "Other");
    const doc = added.document;
    writeWorksheetCell(doc.sheets[added.tabId], { r: 4, c: 1 }, { v: "9" });
    writeWorksheetCell(doc.sheets[sheetId], { r: 2, c: 3 }, { f: '=A2+$A2+A$2+$A$2+Other!A2+SUM(A:A)+LEN("A2")' });
    const result = await applySheetDataOperation(doc, sort);
    expect(getWorksheetCell(result.sheets[sheetId], { r: 4, c: 3 })?.f).toBe('=A4+$A4+A$2+$A$2+Other!A4+SUM(A:A)+LEN("A2")');
  });

  test("filtering preserves excluded records, recalculates after edits, and clearing retains manual hiding", async () => {
    const doc = fixture(); doc.sheets[sheetId].hiddenRows = [4];
    const filtered = await applySheetDataOperation(doc, { op: "set-filter", sheetId, range: "A1:D5", columns: { "2": { op: "equals", value: "6" } } });
    expect(filtered.sheets[sheetId].filter?.hiddenRows).toEqual([2, 5]);
    expect(getWorksheetCell(filtered.sheets[sheetId], { r: 2, c: 1 })?.v).toBe("20");
    writeWorksheetCell(filtered.sheets[sheetId], { r: 2, c: 1 }, { v: "3" });
    const edited = await recalculateWorkbook(filtered);
    expect(edited.sheets[sheetId].filter?.hiddenRows).toEqual([5]);
    const cleared = await applySheetDataOperation(edited, { op: "clear-filter", sheetId });
    expect(cleared.sheets[sheetId].filter).toBeUndefined();
    expect(cleared.sheets[sheetId].hiddenRows).toEqual([4]);
    expect(parseSheetHtml(serializeSheetHtml(edited))).toEqual(edited);
  });

  test("search covers numbers/formulas and workbook scope while reporting hidden matches without mutation", async () => {
    const added = addSheet(fixture(), "Other");
    writeWorksheetCell(added.document.sheets[added.tabId], { r: 1, c: 1 }, { v: "record-other" });
    const doc = await applySheetDataOperation(added.document, { op: "set-filter", sheetId, range: "A1:D5", columns: { "1": { op: "equals", value: "3" } } });
    const before = structuredClone(doc);
    expect(searchSheetDocument(doc, { query: "record", scope: "workbook", sheetId })).toHaveLength(5);
    expect(searchSheetDocument(doc, { query: "record-2", scope: "sheet", sheetId })[0].hidden).toBe(true);
    expect(searchSheetDocument(doc, { query: "A2*2", formulas: true, scope: "sheet", sheetId })[0].ref).toBe("B2");
    expect(searchSheetDocument(doc, { query: "40", scope: "sheet", sheetId })[0].ref).toBe("B2");
    expect(searchSheetDocument(doc, { query: "RECORD", caseSensitive: true, scope: "workbook", sheetId })).toEqual([]);
    expect(doc).toEqual(before);
  });

  test("malformed operations and unsupported positional metadata are refused without mutation", async () => {
    expect(() => validateSheetDataOperation({ ...sort, header: undefined })).toThrow("header");
    expect(() => validateSheetDataOperation({ ...sort, column: 5 })).toThrow("inside");
    expect(() => validateSheetDataOperation({ op: "set-filter", sheetId, range: "A1:B5", columns: { "0": { op: "equals", value: "3" } } })).toThrow("inside");
    const doc = fixture(); doc.sheets[sheetId].merges = { A2: { rs: 1, cs: 2 } };
    const before = structuredClone(doc);
    expect(applySheetDataOperation(doc, sort)).rejects.toThrow("Unmerge");
    expect(doc).toEqual(before);
    const invalid = fixture(); (invalid.sheets[sheetId] as unknown as Record<string, unknown>)["filter"] = { startRow: 0 };
    expect(() => validateSheetDocument(invalid)).toThrow("coordinates");
  });

  test("rejects ranges beyond stored extent before allocating rows or expanding filters", () => {
    const doc = fixture();
    expect(applySheetDataOperation(doc, { ...sort, range: `A1:B${Number.MAX_SAFE_INTEGER}` })).rejects.toThrow("stored");
    expect(applySheetDataOperation(doc, { op: "set-filter", sheetId, range: `A1:B${Number.MAX_SAFE_INTEGER}`, columns: { "1": { op: "equals", value: "3" } } })).rejects.toThrow("stored");
    doc.sheets[sheetId].filter = { startRow: 1, endRow: Number.MAX_SAFE_INTEGER, startCol: 1, endCol: 2, columns: {}, hiddenRows: [] };
    expect(() => validateSheetDocument(doc)).toThrow("stored extent");
  });

  test("sort refuses charts and crossing a filter boundary while retaining all original data", async () => {
    const doc = fixture();
    doc.sheets[sheetId].charts = { sales: { id: "sales", type: "bar", sourceTabId: sheetId, sourceRange: "A1:B5", anchor: "D2", offsetX: 0, offsetY: 0, width: 200, height: 100 } };
    const before = structuredClone(doc);
    expect(applySheetDataOperation(doc, sort)).rejects.toThrow("charts");
    expect(doc).toEqual(before);
    const filtered = await applySheetDataOperation(fixture(), { op: "set-filter", sheetId, range: "A1:D4", columns: {} });
    expect(applySheetDataOperation(filtered, { ...sort, range: "A3:B5", header: false })).rejects.toThrow("filtered data range");
  });
});
