import { describe, expect, test } from "bun:test";
import {
  createWorksheet,
  getWorksheetCell,
  parseRef,
  writeWorksheetCell,
} from "../engine/node.js";
import { createSheetDocument } from "./sheet-document";
import {
  mapOfficeCliDumpToSheet,
  mapSheetToOfficeCliBatch,
  type OfficeCliDumpEnvelope,
} from "./xlsx-mapper";

function fidelityDump(): OfficeCliDumpEnvelope {
  return {
    success: true,
    warnings: ["Workbook metadata was reduced by OfficeCLI."],
    data: [
      { command: "meta", dumpVersion: 2 },
      { command: "set", path: "/", props: { "workbook.date1904": "false", author: "Excel" } },
      { command: "set", path: "/sheet[1]", props: { name: "Summary" } },
      {
        command: "import",
        parent: "/Summary",
        props: { "start-cell": "A1" },
        text: 'Name,Amount,Active,When\n"Ada, A.",42,TRUE,46277\nTotal,=SUM(B2:B2),,\n',
      },
      { command: "set", path: "/Summary/A1:D1", props: { "font.bold": "true", fill: "#ddeeff", "alignment.horizontal": "center", "border.bottom": "thin" } },
      { command: "set", path: "/Summary/B2:B3", props: { numberformat: "$#,##0.00" } },
      { command: "set", path: "/Summary/D2", props: { numberformat: "yyyy-mm-dd" } },
      { command: "set", path: "/Summary/E2", props: { value: "00123", type: "string" } },
      { command: "set", path: "/Summary/row[2]", props: { height: "24pt", hidden: "true" } },
      { command: "set", path: "/Summary/col[B]", props: { width: "20", hidden: "true" } },
      { command: "set", path: "/Summary", props: { merge: "A4:B4", freeze: "B2", autoFilter: "A1:D3" } },
      { command: "add", parent: "/Summary", type: "autofilter", props: { range: "A1:D3", "criteria1.gte": "20", "criteria2.equals": "TRUE" } },
      { command: "add", parent: "/", type: "sheet", props: { name: "Details" } },
      { command: "import", parent: "/Details", props: { "start-cell": "B2" }, text: "Second sheet\n" },
      { command: "add", parent: "/Summary", type: "chart", props: { title: "Unsupported" } },
    ],
  };
}

describe("Sheets XLSX mapper", () => {
  test("imports the replayable OfficeCLI dump with workbook fidelity and explicit warnings", () => {
    const result = mapOfficeCliDumpToSheet(fidelityDump());
    expect(result.document.tabOrder).toEqual(["tab-1", "tab-2"]);
    expect(result.document.tabs["tab-1"]?.name).toBe("Summary");
    expect(result.document.tabs["tab-2"]?.name).toBe("Details");
    const summary = result.document.sheets["tab-1"];
    expect(getWorksheetCell(summary, parseRef("A2"))?.v).toBe("Ada, A.");
    expect(getWorksheetCell(summary, parseRef("B2"))?.v).toBe("42");
    expect(getWorksheetCell(summary, parseRef("C2"))?.v).toBe("TRUE");
    expect(getWorksheetCell(summary, parseRef("D2"))?.v).toBe("2026-09-12");
    expect(getWorksheetCell(summary, parseRef("E2"))?.v).toBe("00123");
    expect(getWorksheetCell(summary, parseRef("B3"))?.f).toBe("=SUM(B2:B2)");
    expect(summary.rowHeights["2"]).toBe(32);
    expect(summary.colWidths["2"]).toBe(145);
    expect(summary.hiddenRows).toEqual([2]);
    expect(summary.hiddenColumns).toEqual([2]);
    expect(summary.merges?.A4).toEqual({ rs: 1, cs: 2 });
    expect(summary.frozenRows).toBe(1);
    expect(summary.frozenCols).toBe(1);
    expect(summary.filter).toMatchObject({ startRow: 1, endRow: 3, startCol: 1, endCol: 4 });
    expect(summary.filter?.columns).toEqual({ "3": { op: "equals", value: "TRUE" } });
    expect(result.document.sheets["tab-2"]?.rowOrder.length).toBeGreaterThanOrEqual(2);
    expect(result.skipped.map((entry) => entry.feature)).toContain("author");
    expect(result.skipped.map((entry) => entry.feature)).toContain("chart");
    expect(result.skipped.map((entry) => entry.feature)).toContain("criteria1.gte");
    expect(result.skipped.some((entry) =>
      entry.feature === "officecli-warning-1"
      && entry.reason === "Workbook metadata was reduced by OfficeCLI.",
    )).toBe(true);
  });

  test("rejects malformed and unversioned dumps instead of creating a partial workbook", () => {
    expect(() => mapOfficeCliDumpToSheet({ success: true, data: [{ command: "set", path: "/sheet[1]", props: { name: "A" } }] })).toThrow("version marker");
    expect(() => mapOfficeCliDumpToSheet({ success: true, data: [{ command: "meta", dumpVersion: 2 }, { nope: true }] })).toThrow("malformed");
    expect(() => mapOfficeCliDumpToSheet({ success: false, message: "broken" })).toThrow("broken");
  });

  test("exports native values, formula results, formatting, dimensions, merge, filter, and freeze as OfficeCLI operations", () => {
    const document = createSheetDocument();
    document.tabs["tab-1"].name = "Budget 2026";
    const sheet = document.sheets["tab-1"];
    writeWorksheetCell(sheet, parseRef("A1"), { v: "Amount", s: { b: true, bg: "#DDEEFF" } });
    writeWorksheetCell(sheet, parseRef("A2"), { v: "42", s: { nf: "currency", cu: "USD", dp: 2 } });
    writeWorksheetCell(sheet, parseRef("A3"), { f: "=SUM(A2:A2)", v: "42" });
    sheet.rowHeights["2"] = 32;
    sheet.colWidths["1"] = 145;
    sheet.hiddenRows = [4];
    sheet.hiddenColumns = [3];
    sheet.merges = { B1: { rs: 1, cs: 2 } };
    sheet.frozenRows = 1;
    sheet.frozenCols = 1;
    sheet.filter = {
      startRow: 1, endRow: 4, startCol: 1, endCol: 3, hiddenRows: [],
      columns: { "2": { op: "contains", value: "east" }, "3": { op: "in", values: ["Open", "Won"] } },
    };
    sheet.charts = { chart1: {} as never };
    document.tabOrder.push("tab-2");
    document.tabs["tab-2"] = { id: "tab-2", name: "Details", type: "sheet" };
    document.sheets["tab-2"] = createWorksheet();
    writeWorksheetCell(document.sheets["tab-2"], parseRef("B2"), { v: "Second sheet" });

    const mapped = mapSheetToOfficeCliBatch(document);
    expect(mapped.commands).toContainEqual({ command: "set", path: "/sheet[1]", props: { name: "Budget 2026" } });
    expect(mapped.commands).toContainEqual({ command: "add", parent: "/", type: "sheet", props: { name: "Details" } });
    expect(mapped.commands).toContainEqual({ command: "set", path: "/Details/B2", props: { value: "Second sheet", type: "string" } });
    expect(mapped.commands).toContainEqual({ command: "set", path: "/Budget 2026/A3", props: { formula: "SUM(A2:A2)" } });
    expect(mapped.commands).toContainEqual({ command: "set", path: "/Budget 2026/row[2]", props: { height: "24pt" } });
    expect(mapped.commands).toContainEqual({ command: "set", path: "/Budget 2026/col[A]", props: { width: "20" } });
    expect(mapped.commands).toContainEqual({ command: "set", path: "/Budget 2026", props: { merge: "B1:C1" } });
    expect(mapped.commands).toContainEqual({ command: "set", path: "/Budget 2026", props: { freeze: "B2" } });
    expect(mapped.commands).toContainEqual({
      command: "add",
      parent: "/Budget 2026",
      type: "autofilter",
      props: { range: "A1:C4", "criteria1.contains": "east", "criteria2.values": "Open,Won" },
    });
    expect(mapped.skipped.some((entry) => entry.feature === "charts")).toBe(true);
  });
});
