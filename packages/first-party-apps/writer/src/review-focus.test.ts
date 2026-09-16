import { describe, expect, test } from "bun:test";
import { createBlock, createTableBlock, type Block, type Document } from "@nautilo/office-docs/node";
import { resolveReviewFocusRanges, scheduleReviewFocus } from "./review-focus";
import { buildReviewProjection } from "./review-projection";
import type { StructuralChange } from "./structural-diff";

function textBlock(id: string, text: string): Block {
  const block = createBlock("paragraph");
  block.id = id;
  block.inlines = [{ text, style: {} }];
  return block;
}

function table(id: string): Block {
  const block = createTableBlock(2, 2);
  block.id = id;
  for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
    const cell = block.tableData!.rows[row]!.cells[col]!;
    cell.blocks[0]!.id = `${id}-${row}-${col}`;
    cell.blocks[0]!.inlines = [{ text: `${row}:${col}`, style: {} }];
  }
  return block;
}

function document(...blocks: Block[]): Document {
  return { blocks } as Document;
}

function focus(projection: ReturnType<typeof buildReviewProjection>, id: string) {
  return resolveReviewFocusRanges(projection.document, projection.items, id);
}

describe("review focus ranges", () => {
  test("resolves body replacements, inserts, deletes, and format-only changes", () => {
    const base = document(textBlock("body", "hello world"), textBlock("format", "format me"), textBlock("type", "heading"));
    const proposed = structuredClone(base);
    proposed.blocks[1]!.inlines = [{ text: "format me", style: { bold: true } }];
    proposed.blocks[2]!.type = "heading";
    proposed.blocks[2]!.headingLevel = 2;
    const changes: StructuralChange[] = [
      { id: "replace", kind: "inline-replace", blockId: "body", start: 6, end: 11, before: "world", after: "reader", operationIndexes: [0] },
      { id: "insert", kind: "inline-insert", blockId: "body", start: 0, end: 0, before: "", after: "Hi ", operationIndexes: [1] },
      { id: "delete", kind: "inline-delete", blockId: "body", start: 5, end: 6, before: " ", after: "", operationIndexes: [2] },
      { id: "format", kind: "inline-style", blockId: "format", before: {}, after: { bold: true }, operationIndexes: [3] },
      { id: "type", kind: "block-type", blockId: "type", before: { type: "paragraph" }, after: { type: "heading" }, operationIndexes: [4] },
    ];
    const projection = buildReviewProjection(base, proposed, changes, [
      { kind: "format-inline", blockId: "format", range: { start: 0, end: 6 } },
    ]);

    expect(focus(projection, "replace")).toEqual([
      { blockId: "body", startOffset: 9, endOffset: 14 },
      { blockId: "body", startOffset: 14, endOffset: 20 },
    ]);
    expect(focus(projection, "insert")).toEqual([{ blockId: "body", startOffset: 0, endOffset: 3 }]);
    expect(focus(projection, "delete")).toEqual([{ blockId: "body", startOffset: 8, endOffset: 9 }]);
    expect(focus(projection, "format")).toEqual([{ blockId: "format", startOffset: 0, endOffset: 9 }]);
    expect(focus(projection, "type")).toEqual([{ blockId: "type", startOffset: 0, endOffset: 7 }]);
  });

  test("uses the visible source block for an atomic move", () => {
    const base = document(textBlock("one", "one"), textBlock("two", "two"));
    const proposed = document(textBlock("two", "two"), textBlock("one", "one moved"));
    const projection = buildReviewProjection(base, proposed, [
      { id: "move", kind: "move", blockId: "one", from: 0, to: 1, operationIndexes: [0] },
    ]);

    expect(focus(projection, "move")).toEqual([
      { blockId: "one", startOffset: 0, endOffset: 3 },
      { blockId: "review:move-destination:move", startOffset: 0, endOffset: 9 },
    ]);
  });

  test("uses nested cell text for table text and style changes", () => {
    const base = document(table("table"));
    const proposed = structuredClone(base);
    proposed.blocks[0]!.tableData!.rows[0]!.cells[1]!.blocks[0]!.inlines = [{ text: "changed", style: { italic: true } }];
    const changes: StructuralChange[] = [
      {
        id: "cell-text", kind: "table-cell-text", blockId: "table", tableId: "table",
        bounds: { start: { rowIndex: 0, colIndex: 1 }, end: { rowIndex: 0, colIndex: 1 } },
        before: "0:1", after: "changed", operationIndexes: [0], groupId: "text", dependencyOperationIndexes: [],
      },
      {
        id: "cell-style", kind: "table-cell-style", blockId: "table", tableId: "table",
        bounds: { start: { rowIndex: 0, colIndex: 1 }, end: { rowIndex: 0, colIndex: 1 } },
        before: {}, after: {}, operationIndexes: [1], groupId: "style", dependencyOperationIndexes: [],
      },
    ];
    const projection = buildReviewProjection(base, proposed, changes);

    for (const id of ["cell-text", "cell-style"]) {
      expect(focus(projection, id)).toEqual([{
        blockId: "table-0-1", startOffset: 0, endOffset: 10,
        cellAddress: { rowIndex: 0, colIndex: 1 }, cellBlockIndex: 1,
      }]);
    }
  });

  test("anchors row, column, merge, split, and delete changes to structural labels", () => {
    const base = document(table("table"));
    const changes = ["table-row-insert", "table-column-delete", "table-merge", "table-split", "table-delete"].map(
      (kind, index) => ({
        id: kind,
        kind: kind as Extract<StructuralChange, { tableId: string }>["kind"],
        blockId: "table",
        tableId: "table",
        bounds: { start: { rowIndex: 0, colIndex: 0 }, end: { rowIndex: 1, colIndex: 1 } },
        operationIndexes: [index],
        groupId: kind,
        dependencyOperationIndexes: [],
      }),
    ) as StructuralChange[];
    const projection = buildReviewProjection(base, document(), changes);

    for (const change of changes) {
      const ranges = focus(projection, change.id);
      expect(ranges).toHaveLength(1);
      expect(ranges[0]!.blockId).toStartWith("review:table-structure:");
      expect(ranges[0]!.blockId).not.toBe("table");
    }
  });
});

describe("review focus scheduler", () => {
  test("waits two frames, retries four times, and ignores stale generations", () => {
    const frames: FrameRequestCallback[] = [];
    let current = { generation: 1, changeId: "one" as string | null };
    let focused = 0;
    scheduleReviewFocus(
      { generation: 1, changeId: "one" },
      () => current,
      () => { focused += 1; },
      (callback) => { frames.push(callback); return frames.length; },
      () => {},
    );
    while (frames.length > 0) frames.shift()!(0);
    expect(focused).toBe(5);

    scheduleReviewFocus(
      { generation: 1, changeId: "one" },
      () => current,
      () => { focused += 1; },
      (callback) => { frames.push(callback); return frames.length; },
      () => {},
    );
    current = { generation: 2, changeId: "two" };
    frames.shift()!(0);
    expect(focused).toBe(5);
  });
});
