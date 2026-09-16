import { describe, expect, test } from "bun:test";
import { createBlock, createTableBlock } from "@nautilo/office-docs/node";
import {
  TABLE_READ_CELL_LIMIT,
  TABLE_READ_BYTE_LIMIT,
  boundedCanonicalBlocks,
  boundedCanonicalTable,
  findCanonicalTextBlock,
  locateWriterText,
} from "./writer-live-locator";

describe("writer live locator", () => {
  test("disambiguates a short repeated target with exact context", () => {
    expect(locateWriterText("a cat, then a dog, then a cat.", {
      before: "then a", target: "cat", after: ".",
    })).toEqual({ ok: true, range: { start: 26, end: 29 } });
  });

  test("rejects an ambiguous locator", () => {
    expect(locateWriterText("a cat and a cat", { target: "cat" })).toMatchObject({
      ok: false, code: "anchor_ambiguous",
    });
  });

  test("returns no more than five canonical blocks", () => {
    const blocks = Array.from({ length: 6 }, (_, index) => {
      const block = createBlock("paragraph");
      block.id = `b${index}`;
      block.inlines = [{ text: `text ${index}`, style: {} }];
      return block;
    });
    expect(boundedCanonicalBlocks(blocks, "b3", 2, 2)).toEqual([
      { id: "b1", type: "paragraph", text: "text 1" },
      { id: "b2", type: "paragraph", text: "text 2" },
      { id: "b3", type: "paragraph", text: "text 3" },
      { id: "b4", type: "paragraph", text: "text 4" },
      { id: "b5", type: "paragraph", text: "text 5" },
    ]);
  });

  test("reads and locates nested cell blocks without flattening tables", () => {
    const table = createTableBlock(1, 2);
    table.tableData!.rows[0]!.cells[0]!.blocks[0]!.id = "cell-a";
    table.tableData!.rows[0]!.cells[0]!.blocks[0]!.inlines = [{ text: "first target", style: {} }];
    table.tableData!.rows[0]!.cells[1]!.blocks[0]!.id = "cell-b";
    table.tableData!.rows[0]!.cells[1]!.blocks[0]!.inlines = [{ text: "second target", style: {} }];
    expect(boundedCanonicalBlocks([table], "cell-a")).toEqual([{ id: "cell-a", type: "paragraph", text: "first target" }]);
    expect(locateWriterText(findCanonicalTextBlock([table], "cell-a")!.inlines.map((inline) => inline.text).join(""), { target: "target" }))
      .toEqual({ ok: true, range: { start: 6, end: 12 } });
    table.tableData!.rows[0]!.cells[1]!.colSpan = 0;
    expect(findCanonicalTextBlock([table], "cell-b")).toBeNull();
    expect(boundedCanonicalBlocks([table], "cell-b")).toBeNull();
  });

  test("returns coordinate-addressed editable table cells and merged coverage", () => {
    const table = createTableBlock(2, 2);
    table.id = "table-1";
    table.tableData!.rows[0]!.cells[0]!.blocks[0]!.id = "cell-anchor";
    table.tableData!.rows[0]!.cells[0]!.blocks[0]!.inlines = [{ text: "merged text", style: {} }];
    table.tableData!.rows[0]!.cells[0]!.colSpan = 2;
    table.tableData!.rows[0]!.cells[0]!.rowSpan = 2;
    for (const [row, col] of [[0, 1], [1, 0], [1, 1]]) table.tableData!.rows[row]!.cells[col]!.colSpan = 0;

    expect(boundedCanonicalTable(table)).toEqual({
      tableBlockId: "table-1",
      rowCount: 2,
      columnCount: 2,
      cells: [
        {
          rowIndex: 0, colIndex: 0, editable: true, textComplete: true,
          blocks: [{ id: "cell-anchor", type: "paragraph", text: "merged text", textComplete: true }],
          mergedAnchor: { rowSpan: 2, colSpan: 2 },
        },
        { rowIndex: 0, colIndex: 1, editable: false, textComplete: true, coveredBy: { rowIndex: 0, colIndex: 0 } },
        { rowIndex: 1, colIndex: 0, editable: false, textComplete: true, coveredBy: { rowIndex: 0, colIndex: 0 } },
        { rowIndex: 1, colIndex: 1, editable: false, textComplete: true, coveredBy: { rowIndex: 0, colIndex: 0 } },
      ],
    });
  });

  test("paginates table cells deterministically through later editable cells", () => {
    const table = createTableBlock(TABLE_READ_CELL_LIMIT + 2, 1);
    for (let row = 0; row < table.tableData!.rows.length; row++) {
      table.tableData!.rows[row]!.cells[0]!.blocks[0]!.inlines = [{ text: `cell-${row}`, style: {} }];
    }
    const first = boundedCanonicalTable(table)!;
    expect(first.cells).toHaveLength(TABLE_READ_CELL_LIMIT);
    expect(first.nextCursor).toEqual({ rowIndex: TABLE_READ_CELL_LIMIT, colIndex: 0, blockIndex: 0, sliceIndex: 0 });
    const second = boundedCanonicalTable(table, first.nextCursor)!;
    expect(second.cells.map((cell) => cell.blocks?.[0]?.text)).toEqual(["cell-50", "cell-51"]);
    expect(second.nextCursor).toBeUndefined();
  });

  test("marks an oversized cell slice incomplete and resumes it without silent truncation", () => {
    const table = createTableBlock(1, 1);
    table.tableData!.rows[0]!.cells[0]!.blocks[0]!.id = "long-cell";
    table.tableData!.rows[0]!.cells[0]!.blocks[0]!.inlines = [{ text: "x".repeat(TABLE_READ_BYTE_LIMIT + 17), style: {} }];
    const first = boundedCanonicalTable(table)!;
    const firstBlock = first.cells[0]!.blocks![0]!;
    expect(first.cells[0]!.textComplete).toBe(false);
    expect(firstBlock).toMatchObject({
      id: "long-cell",
      textComplete: false,
      continuation: { rowIndex: 0, colIndex: 0, blockIndex: 0, sliceIndex: 1 },
    });
    expect(firstBlock.text).toHaveLength(TABLE_READ_BYTE_LIMIT);
    expect(first.nextCursor).toEqual(firstBlock.continuation);

    const second = boundedCanonicalTable(table, first.nextCursor)!;
    expect(second.cells[0]!.textComplete).toBe(false);
    expect(second.cells[0]!.blocks![0]).toMatchObject({ text: "x".repeat(17), textComplete: true });
    expect(second.nextCursor).toBeUndefined();
  });

  test("preserves merged coverage after a cell-limit page boundary", () => {
    const table = createTableBlock(1, TABLE_READ_CELL_LIMIT + 2);
    const anchor = table.tableData!.rows[0]!.cells[TABLE_READ_CELL_LIMIT]!;
    anchor.colSpan = 2;
    table.tableData!.rows[0]!.cells[TABLE_READ_CELL_LIMIT + 1]!.colSpan = 0;
    const first = boundedCanonicalTable(table)!;
    const second = boundedCanonicalTable(table, first.nextCursor)!;
    expect(second.cells).toMatchObject([
      {
        rowIndex: 0,
        colIndex: TABLE_READ_CELL_LIMIT,
        editable: true,
        mergedAnchor: { rowSpan: 1, colSpan: 2 },
      },
      {
        rowIndex: 0,
        colIndex: TABLE_READ_CELL_LIMIT + 1,
        editable: false,
        coveredBy: { rowIndex: 0, colIndex: TABLE_READ_CELL_LIMIT },
      },
    ]);
  });

  test("uses UTF-8 byte boundaries without splitting or losing emoji", () => {
    const table = createTableBlock(1, 1);
    const source = "a".repeat(TABLE_READ_BYTE_LIMIT - 1) + "😀Z";
    table.tableData!.rows[0]!.cells[0]!.blocks[0]!.inlines = [{ text: source, style: {} }];
    const first = boundedCanonicalTable(table)!;
    const firstText = first.cells[0]!.blocks![0]!.text;
    expect(new TextEncoder().encode(firstText).byteLength).toBe(TABLE_READ_BYTE_LIMIT - 1);
    expect(firstText.endsWith("😀")).toBe(false);
    expect(first.cells[0]!.blocks![0]!.textComplete).toBe(false);

    const second = boundedCanonicalTable(table, first.nextCursor)!;
    const secondText = second.cells[0]!.blocks![0]!.text;
    expect(secondText).toBe("😀Z");
    expect(new TextEncoder().encode(secondText).byteLength).toBe(5);
    expect(firstText + secondText).toBe(source);
    expect(Array.from(firstText + secondText)).toEqual(Array.from(source));
  });

  test("rejects pathological logical slice indexes", () => {
    const table = createTableBlock(1, 1);
    table.tableData!.rows[0]!.cells[0]!.blocks[0]!.inlines = [{ text: "short", style: {} }];
    expect(boundedCanonicalTable(table, {
      rowIndex: 0, colIndex: 0, blockIndex: 0, sliceIndex: Number.MAX_SAFE_INTEGER,
    })).toBeNull();
  });

  test("bounds table payload cells and UTF-8 bytes deterministically", () => {
    const table = createTableBlock(10, 10);
    for (const row of table.tableData!.rows) for (const cell of row.cells) {
      cell.blocks[0]!.inlines = [{ text: "x".repeat(200), style: {} }];
    }
    const payload = boundedCanonicalTable(table)!;
    expect(payload.cells.length).toBeLessThanOrEqual(TABLE_READ_CELL_LIMIT);
    expect(payload.cells.reduce(
      (length, cell) => length + (cell.blocks?.reduce((n, block) => n + new TextEncoder().encode(block.text).byteLength, 0) ?? 0),
      0,
    )).toBeLessThanOrEqual(TABLE_READ_BYTE_LIMIT);
    expect(payload.nextCursor).toBeDefined();
  });
});
