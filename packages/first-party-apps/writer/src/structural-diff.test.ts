import { describe, expect, test } from "bun:test";
import { createBlock, createTableBlock, type Block, type Document } from "@nautilo/office-docs/node";
import { structuralDiff } from "./structural-diff";

function block(id: string, text: string, style: Record<string, unknown> = {}): Block {
  const value = createBlock("paragraph");
  value.id = id;
  value.inlines = [{ text, style }];
  return value;
}
function doc(...blocks: Block[]): Document {
  return { blocks } as Document;
}
function table(id: string, rows = 2, cols = 2): Block {
  const value = createTableBlock(rows, cols);
  value.id = id;
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const cell = value.tableData!.rows[row]!.cells[col]!;
    cell.blocks[0]!.id = `${id}-${row}-${col}`;
    cell.blocks[0]!.inlines = [{ text: `${row}:${col}`, style: {} }];
  }
  return value;
}

describe("structural diff", () => {
  test("uses block IDs, not duplicate text, and has stable IDs", () => {
    const base = doc(block("one", "same"), block("two", "same"));
    const proposed = doc(block("one", "changed"), block("two", "same"));
    const first = structuralDiff(base, proposed);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((change) => change.blockId === "one")).toBe(true);
    expect(structuralDiff(base, proposed)).toEqual(first);
  });

  test("emits one explicit move and never delete/insert for a same-ID move", () => {
    const base = doc(block("a", "A"), block("b", "B"), block("c", "C"));
    const proposed = doc(block("b", "B"), block("c", "C"), block("a", "A"));
    const changes = structuralDiff(base, proposed, [{ kind: "move-block", blockId: "a" }]);
    expect(changes.filter((change) => change.kind === "move")).toEqual([
      expect.objectContaining({ blockId: "a", from: 0, to: 2 }),
    ]);
    expect(changes.some((change) => change.kind === "block-delete" || change.kind === "block-insert")).toBe(false);
  });

  test("keeps separated inline edits as multiple spans", () => {
    const changes = structuralDiff(doc(block("a", "one two three")), doc(block("a", "ONE two THREE")));
    expect(changes.filter((change) => change.kind === "inline-replace")).toMatchObject([
      { blockId: "a", before: "one", after: "ONE" },
      { blockId: "a", before: "three", after: "THREE" },
    ]);
  });

  test("uses original proposal indexes instead of metadata application order", () => {
    const changes = structuralDiff(doc(block("a", "abcdef")), doc(block("a", "AbcdEF")), [
      { operationIndex: 3, kind: "replace", blockId: "a", range: { start: 4, end: 6 } },
      { operationIndex: 1, kind: "replace", blockId: "a", range: { start: 0, end: 1 } },
    ]);
    expect(changes.filter((change) => change.kind === "inline-replace").map((change) => change.operationIndexes)).toEqual([
      [1],
      [3],
    ]);
  });

  test("reports styles and block type separately", () => {
    const base = doc(block("a", "text"));
    const proposedBlock = block("a", "text", { bold: true }) as Block & { type: string; headingLevel?: number };
    proposedBlock.type = "heading";
    proposedBlock.headingLevel = 2;
    proposedBlock.style = { alignment: "center" } as Block["style"];
    const kinds = structuralDiff(base, doc(proposedBlock), [
      { kind: "format-inline", blockId: "a", range: { start: 0, end: 4 } },
      { kind: "format-block", blockId: "a", range: { start: 0, end: 4 } },
      { kind: "set-block-type", blockId: "a", range: { start: 0, end: 4 } },
    ]).map((change) => change.kind);
    expect(kinds).toEqual(["inline-style", "block-style", "block-type"]);
  });

  test("reports a real format delta alongside a text edit without flagging replacement splits", () => {
    const base = doc(block("a", "Hello world"));
    const proposedBlock = block("a", "Hello earth");
    proposedBlock.inlines = [
      { text: "Hello", style: { bold: true } },
      { text: " earth", style: {} },
    ];
    const changes = structuralDiff(base, doc(proposedBlock), [
      { kind: "replace", blockId: "a", range: { start: 6, end: 11 } },
      { kind: "format-inline", blockId: "a", range: { start: 0, end: 5 } },
    ]);
    expect(changes.map((change) => change.kind)).toContain("inline-replace");
    expect(changes.filter((change) => change.kind === "inline-style")).toEqual([
      expect.objectContaining({ blockId: "a", operationIndexes: [1] }),
    ]);

    const splitOnly = block("a", "Hello earth");
    splitOnly.inlines = [{ text: "Hello", style: {} }, { text: " earth", style: {} }];
    expect(structuralDiff(base, doc(splitOnly), [
      { kind: "replace", blockId: "a", range: { start: 6, end: 11 } },
      { kind: "format-inline", blockId: "a", range: { start: 0, end: 5 } },
    ]).some((change) => change.kind === "inline-style")).toBe(false);
  });

  test("reports deterministic table cell text and style records with cell bounds", () => {
    const base = table("table");
    const proposed = structuredClone(base);
    const cell = proposed.tableData!.rows[0]!.cells[1]!;
    cell.blocks[0]!.inlines = [{ text: "changed", style: { bold: true } }];
    cell.style = { padding: 8 };
    const operations = [
      { kind: "replace" as const, blockId: "table-0-1", range: { start: 0, end: 3 } },
      { kind: "format-inline" as const, blockId: "table-0-1", range: { start: 0, end: 7 } },
      { kind: "set-table-cell-style" as const, blockId: "table" },
    ];
    const first = structuralDiff(doc(base), doc(proposed), operations);
    expect(first).toEqual(structuralDiff(doc(base), doc(proposed), operations));
    expect(first.filter((change) => change.kind === "table-cell-text" || change.kind === "table-cell-style")).toEqual([
      expect.objectContaining({ tableId: "table", bounds: { start: { rowIndex: 0, colIndex: 1 }, end: { rowIndex: 0, colIndex: 1 } } }),
      expect.objectContaining({ tableId: "table", bounds: { start: { rowIndex: 0, colIndex: 1 }, end: { rowIndex: 0, colIndex: 1 } } }),
    ]);
  });

  test("reports row and column changes, merge/split groups, and table deletion atomically", () => {
    const base = table("table");
    const rowAdded = structuredClone(base);
    rowAdded.tableData!.rows.push(structuredClone(rowAdded.tableData!.rows[0]!));
    const columnAdded = structuredClone(base);
    columnAdded.tableData!.columnWidths.push(0.5);
    for (const row of columnAdded.tableData!.rows) row.cells.push(structuredClone(row.cells[0]!));
    expect(structuralDiff(doc(base), doc(rowAdded), [{ kind: "insert-table-row", blockId: "table" }])[0]).toMatchObject({ kind: "table-row-insert", tableId: "table" });
    expect(structuralDiff(doc(base), doc(columnAdded), [{ kind: "insert-table-column", blockId: "table" }])[0]).toMatchObject({ kind: "table-column-insert", tableId: "table" });
    const rowDeleted = structuredClone(base);
    rowDeleted.tableData!.rows.splice(1, 1);
    const columnDeleted = structuredClone(base);
    columnDeleted.tableData!.columnWidths.splice(1, 1);
    for (const row of columnDeleted.tableData!.rows) row.cells.splice(1, 1);
    expect(structuralDiff(doc(base), doc(rowDeleted), [{ kind: "delete-table-row", blockId: "table" }])[0]).toMatchObject({ kind: "table-row-delete", tableId: "table" });
    expect(structuralDiff(doc(base), doc(columnDeleted), [{ kind: "delete-table-column", blockId: "table" }])[0]).toMatchObject({ kind: "table-column-delete", tableId: "table" });

    const merged = structuredClone(base);
    merged.tableData!.rows[0]!.cells[0]!.colSpan = 2;
    merged.tableData!.rows[0]!.cells[0]!.rowSpan = 2;
    for (const [row, col] of [[0, 1], [1, 0], [1, 1]]) merged.tableData!.rows[row]!.cells[col]!.colSpan = 0;
    const merge = structuralDiff(doc(base), doc(merged), [{ kind: "merge-table-cells", blockId: "table" }]);
    expect(merge.filter((change) => change.kind === "table-merge").every((change) =>
      "groupId" in change && change.groupId === "table-merge:table:0")).toBe(true);
    const split = structuralDiff(doc(merged), doc(base), [{ kind: "split-table-cell", blockId: "table" }]);
    expect(split.some((change) => change.kind === "table-split")).toBe(true);
    const deletion = structuralDiff(doc(base), doc(), [{ kind: "delete-table", blockId: "table" }]);
    expect(deletion).toEqual([expect.objectContaining({ kind: "table-delete", groupId: "table-delete:table:0" })]);
  });

  test("emits no change for an unchanged table", () => {
    const source = table("table");
    expect(structuralDiff(doc(source), doc(structuredClone(source)))).toEqual([]);
  });
});
