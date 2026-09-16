import { describe, expect, test } from "bun:test";
import { createTableBlock, getBlockText } from "@nautilo/office-docs/node";
import {
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
  mergeTableCells,
  setTableCellStyle,
  splitTableCell,
} from "./table-document-ops";

function tableData() {
  const table = createTableBlock(2, 2);
  table.tableData!.rows[0]!.cells[0]!.blocks[0]!.inlines = [{ text: "A", style: {} }];
  table.tableData!.rows[0]!.cells[1]!.blocks[0]!.inlines = [{ text: "B", style: {} }];
  return table.tableData!;
}

function mergedTable(start: { rowIndex: number; colIndex: number }, end: { rowIndex: number; colIndex: number }) {
  const table = createTableBlock(4, 4).tableData!;
  const merged = mergeTableCells(table, start, end);
  if (!merged.ok) throw new Error(merged.message);
  return merged.tableData;
}

function expectValidCoveredCells(table: ReturnType<typeof tableData>): void {
  const claimed = Array.from({ length: table.rows.length }, () => Array<boolean>(table.columnWidths.length).fill(false));
  for (let row = 0; row < table.rows.length; row++) {
    expect(table.rows[row]!.cells).toHaveLength(table.columnWidths.length);
    for (let col = 0; col < table.columnWidths.length; col++) {
      const entry = table.rows[row]!.cells[col]!;
      if (entry.colSpan === 0) continue;
      const rowSpan = entry.rowSpan ?? 1;
      const colSpan = entry.colSpan ?? 1;
      for (let r = row; r < row + rowSpan; r++) for (let c = col; c < col + colSpan; c++) {
        if (r !== row || c !== col) claimed[r]![c] = true;
      }
    }
  }
  for (let row = 0; row < table.rows.length; row++) for (let col = 0; col < table.columnWidths.length; col++) {
    expect(table.rows[row]!.cells[col]!.colSpan === 0).toBe(claimed[row]![col]);
  }
}

describe("pure Writer table document operations", () => {
  test("inserts and deletes rows and columns without mutating input", () => {
    const source = tableData(), before = JSON.stringify(source);
    const row = insertTableRow(source, 1);
    expect(row).toMatchObject({ ok: true });
    if (!row.ok) return;
    const column = insertTableColumn(row.tableData, 1);
    expect(column).toMatchObject({ ok: true });
    if (!column.ok) return;
    expect(deleteTableRow(column.tableData, 1)).toMatchObject({ ok: true, tableData: { rows: { length: 2 } } });
    expect(deleteTableColumn(column.tableData, 1)).toMatchObject({ ok: true, tableData: { columnWidths: { length: 2 } } });
    expect(JSON.stringify(source)).toBe(before);
  });

  test("merges, splits, and styles cells with covered cells rejected", () => {
    const merged = mergeTableCells(tableData(), { rowIndex: 0, colIndex: 0 }, { rowIndex: 1, colIndex: 1 });
    expect(merged).toMatchObject({ ok: true });
    if (!merged.ok) return;
    expect(merged.tableData.rows[0]!.cells[0]!).toMatchObject({ colSpan: 2, rowSpan: 2 });
    expect(merged.tableData.rows[1]!.cells[1]!.colSpan).toBe(0);
    expect(getBlockText(merged.tableData.rows[0]!.cells[0]!.blocks[0]!)).toBe("A");
    expect(setTableCellStyle(merged.tableData, { rowIndex: 1, colIndex: 1 }, { padding: 8 })).toMatchObject({ ok: false });
    const split = splitTableCell(merged.tableData, { rowIndex: 0, colIndex: 0 });
    expect(split).toMatchObject({ ok: true });
    if (!split.ok) return;
    expect(split.tableData.rows[1]!.cells[1]!.colSpan).toBeUndefined();
    const styled = setTableCellStyle(split.tableData, { rowIndex: 0, colIndex: 0 }, { backgroundColor: "#abc", padding: 8 });
    expect(styled).toMatchObject({ ok: true });
    if (styled.ok) expect(styled.tableData.rows[0]!.cells[0]!.style).toMatchObject({ backgroundColor: "#abc", padding: 8 });
  });

  test("rejects invalid structural operations without changing source", () => {
    const source = tableData(), before = JSON.stringify(source);
    expect(deleteTableRow(source, 2)).toMatchObject({ ok: false });
    expect(deleteTableColumn(source, 2)).toMatchObject({ ok: false });
    expect(splitTableCell(source, { rowIndex: 0, colIndex: 0 })).toMatchObject({ ok: false });
    expect(JSON.stringify(source)).toBe(before);
  });

  test("horizontal merge column boundary matrix fails closed inside and permits before/after", () => {
    const source = mergedTable({ rowIndex: 1, colIndex: 1 }, { rowIndex: 1, colIndex: 2 });
    for (const [index, ok] of [[1, true], [2, false], [3, true]] as const) {
      const result = insertTableColumn(source, index);
      expect(result.ok).toBe(ok);
      if (result.ok) expectValidCoveredCells(result.tableData);
      else expect(result.message).toContain("intersects an active merge");
    }
    for (const [index, ok] of [[0, true], [1, false], [2, false], [3, true]] as const) {
      const result = deleteTableColumn(source, index);
      expect(result.ok).toBe(ok);
      if (result.ok) expectValidCoveredCells(result.tableData);
      else expect(result.message).toContain("intersects an active merge");
    }
  });

  test("vertical merge row boundary matrix fails closed inside and permits before/after", () => {
    const source = mergedTable({ rowIndex: 1, colIndex: 1 }, { rowIndex: 2, colIndex: 1 });
    for (const [index, ok] of [[1, true], [2, false], [3, true]] as const) {
      const result = insertTableRow(source, index);
      expect(result.ok).toBe(ok);
      if (result.ok) expectValidCoveredCells(result.tableData);
      else expect(result.message).toContain("intersects an active merge");
    }
    for (const [index, ok] of [[0, true], [1, false], [2, false], [3, true]] as const) {
      const result = deleteTableRow(source, index);
      expect(result.ok).toBe(ok);
      if (result.ok) expectValidCoveredCells(result.tableData);
      else expect(result.message).toContain("intersects an active merge");
    }
  });

  test("rectangular merge rejects crossing edits on both axes and preserves topology around boundaries", () => {
    const source = mergedTable({ rowIndex: 1, colIndex: 1 }, { rowIndex: 2, colIndex: 2 });
    const operations = [
      insertTableRow(source, 1),
      insertTableRow(source, 2),
      insertTableRow(source, 3),
      deleteTableRow(source, 0),
      deleteTableRow(source, 1),
      deleteTableRow(source, 2),
      deleteTableRow(source, 3),
      insertTableColumn(source, 1),
      insertTableColumn(source, 2),
      insertTableColumn(source, 3),
      deleteTableColumn(source, 0),
      deleteTableColumn(source, 1),
      deleteTableColumn(source, 2),
      deleteTableColumn(source, 3),
    ];
    expect(operations.map((result) => result.ok)).toEqual([
      true, false, true,
      true, false, false, true,
      true, false, true,
      true, false, false, true,
    ]);
    for (const result of operations) if (result.ok) expectValidCoveredCells(result.tableData);
  });

  test("rejects orphaned covered cells before structural mutation", () => {
    const source = tableData();
    source.rows[0]!.cells[1]!.colSpan = 0;
    expect(insertTableRow(source, 0)).toEqual({ ok: false, message: "table merge topology is invalid" });
    expect(deleteTableColumn(source, 0)).toEqual({ ok: false, message: "table merge topology is invalid" });
  });
});
