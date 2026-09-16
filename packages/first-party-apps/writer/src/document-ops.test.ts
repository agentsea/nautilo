import { describe, expect, test } from "bun:test";
import { createBlock, createTableBlock, getBlockText, type Block, type Document } from "@nautilo/office-docs/node";
import { applyDocumentOperations } from "./document-ops";
import type { ResolvedProposalOperation } from "./proposal-resolver";
import { mergeTableCells } from "./table-document-ops";

function block(id: string, parts: string[]): Block {
  const value = createBlock("paragraph");
  value.id = id;
  value.inlines = parts.map((text, index) => ({ text, style: index === 0 ? { bold: true } : { italic: true } }));
  return value;
}
function document(...blocks: Block[]): Document {
  return { blocks } as Document;
}
function apply(base: Document, ...operations: ResolvedProposalOperation[]) {
  return applyDocumentOperations(base, operations);
}

describe("pure Writer document operations", () => {
  test("inserts, deletes, and replaces logical text across inlines without mutating input", () => {
    const base = document(block("a", ["Hello ", "world"]));
    const before = JSON.stringify(base);
    const result = apply(base,
      { kind: "insert", blockId: "a", scope: { kind: "range", start: 6, end: 6 }, range: { start: 6, end: 6 }, text: "brave " },
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 12, end: 17 }, range: { start: 12, end: 17 }, text: "earth" },
      { kind: "delete", blockId: "a", scope: { kind: "range", start: 0, end: 1 }, range: { start: 0, end: 1 } },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(getBlockText(result.document.blocks[0]!)).toBe("ello brave earth");
    expect(JSON.stringify(base)).toBe(before);
  });

  test("formats inline and block ranges", () => {
    const result = apply(document(block("a", ["abc", "def"])),
      { kind: "format-inline", blockId: "a", scope: { kind: "range", start: 1, end: 5 }, range: { start: 1, end: 5 }, style: { underline: true } },
      { kind: "format-block", blockId: "a", scope: { kind: "block" }, range: { start: 0, end: 6 }, style: { alignment: "center" } },
    );
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      const changed = result.document.blocks[0]!;
      expect(changed.style.alignment).toBe("center");
      expect(changed.inlines.map((inline) => inline.text)).toEqual(["a", "bc", "de", "f"]);
      expect(changed.inlines[1]!.style).toMatchObject({ bold: true, underline: true });
      expect(changed.inlines[2]!.style).toMatchObject({ italic: true, underline: true });
    }
  });

  test("changes heading and list block types", () => {
    const base = document(block("a", ["text"]));
    const heading = apply(base, { kind: "set-block-type", blockId: "a", scope: { kind: "block" }, range: { start: 0, end: 4 }, blockType: { type: "heading", headingLevel: 2 } });
    expect(heading).toMatchObject({ ok: true });
    if (!heading.ok) return;
    expect(heading.document.blocks[0]).toMatchObject({ type: "heading", headingLevel: 2 });
    const list = apply(heading.document, { kind: "set-block-type", blockId: "a", scope: { kind: "block" }, range: { start: 0, end: 4 }, blockType: { type: "list-item", listKind: "ordered", listLevel: 1 } });
    expect(list).toMatchObject({ ok: true });
    if (list.ok) expect(list.document.blocks[0]).toMatchObject({ type: "list-item", listKind: "ordered", listLevel: 1 });
  });

  test("moves the same cloned block object ID without delete/new IDs", () => {
    const base = document(block("a", ["A"]), block("b", ["B"]), block("c", ["C"]));
    const result = apply(base, { kind: "move-block", blockId: "a", destination: { position: "after", afterBlockId: "c" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.blocks.map((item) => item.id)).toEqual(["b", "c", "a"]);
      expect(new Set(result.document.blocks.map((item) => item.id)).size).toBe(3);
    }
    expect(base.blocks.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  test("returns original input on failed batches", () => {
    const base = document(block("a", ["A"]));
    const result = apply(base,
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 0, end: 1 }, range: { start: 0, end: 1 }, text: "B" },
      { kind: "move-block", blockId: "a", destination: { position: "after", afterBlockId: "missing" } },
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_destination", document: base });
    expect(getBlockText(base.blocks[0]!)).toBe("A");
  });

  test("applies text formatting to nested cell blocks and structural table proposals", () => {
    const table = createTableBlock(2, 2);
    table.id = "table";
    const cell = table.tableData!.rows[0]!.cells[0]!.blocks[0]!;
    cell.id = "nested";
    cell.inlines = [{ text: "cell text", style: {} }];
    const base = document(table);
    const result = apply(base,
      { kind: "replace", blockId: "nested", scope: { kind: "range", start: 0, end: 4 }, range: { start: 0, end: 4 }, text: "table" },
      { kind: "format-inline", blockId: "nested", scope: { kind: "range", start: 0, end: 5 }, range: { start: 0, end: 5 }, style: { bold: true } },
      { kind: "insert-table-row", tableBlockId: "table", rowIndex: 1 },
      { kind: "insert-table-column", tableBlockId: "table", colIndex: 1 },
      { kind: "set-table-cell-style", tableBlockId: "table", cell: { rowIndex: 0, colIndex: 0 }, style: { padding: 6 } },
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const changed = result.document.blocks[0]!;
    expect(getBlockText(changed.tableData!.rows[0]!.cells[0]!.blocks[0]!)).toBe("table text");
    expect(changed.tableData!.rows).toHaveLength(3);
    expect(changed.tableData!.columnWidths).toHaveLength(3);
    expect(changed.tableData!.rows[0]!.cells[0]!.style.padding).toBe(6);
  });

  test("deletes tables atomically and rejects duplicate nested IDs", () => {
    const table = createTableBlock(1, 2);
    table.id = "table";
    table.tableData!.rows[0]!.cells[0]!.blocks[0]!.id = "same";
    table.tableData!.rows[0]!.cells[1]!.blocks[0]!.id = "same";
    const duplicate = document(table);
    expect(apply(duplicate, { kind: "delete-table", tableBlockId: "table" })).toMatchObject({ ok: false, code: "duplicate_id", document: duplicate });

    const deletable = createTableBlock(1, 1);
    deletable.id = "delete-me";
    const removed = apply(document(deletable), { kind: "delete-table", tableBlockId: "delete-me" });
    expect(removed).toMatchObject({ ok: true });
    if (removed.ok) expect(removed.document.blocks).toHaveLength(0);
  });

  test("live document operations fail closed across active merge boundaries", () => {
    const table = createTableBlock(4, 4);
    table.id = "merged-table";
    const merged = mergeTableCells(
      table.tableData!,
      { rowIndex: 1, colIndex: 1 },
      { rowIndex: 2, colIndex: 2 },
    );
    if (!merged.ok) throw new Error(merged.message);
    table.tableData = merged.tableData;
    const base = document(table);

    const inside = apply(base, { kind: "insert-table-row", tableBlockId: table.id, rowIndex: 2 });
    expect(inside).toMatchObject({
      ok: false,
      code: "invalid_table",
      message: "row insertion intersects an active merge",
      document: base,
    });
    const covered = apply(base, { kind: "delete-table-column", tableBlockId: table.id, colIndex: 2 });
    expect(covered).toMatchObject({
      ok: false,
      code: "invalid_table",
      message: "column deletion intersects an active merge",
      document: base,
    });
    const before = apply(base, { kind: "insert-table-column", tableBlockId: table.id, colIndex: 1 });
    expect(before).toMatchObject({ ok: true });
    if (before.ok) {
      const changed = before.document.blocks[0]!.tableData!;
      expect(changed.columnWidths).toHaveLength(5);
      expect(changed.rows[1]!.cells[2]).toMatchObject({ colSpan: 2, rowSpan: 2 });
      expect(changed.rows[2]!.cells[3]!.colSpan).toBe(0);
    }
  });
});
