import { describe, expect, test } from "bun:test";
import { createBlock, createTableBlock, getBlockText, type Block, type Document } from "@nautilo/office-docs/node";
import { buildReviewProjection, reviewSurfaceState, REVIEW_DELETE_STYLE, REVIEW_FORMAT_STYLE, REVIEW_INSERT_STYLE } from "./review-projection";
import type { StructuralChange } from "./structural-diff";
import { SuggestionController } from "./suggestion-controller";

function block(id: string, inlines: Block["inlines"]): Block {
  const value = createBlock("paragraph");
  value.id = id;
  value.inlines = inlines;
  return value;
}

function document(...blocks: Block[]): Document {
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

function replace(id: string, blockId: string, start: number, end: number, before: string, after: string): StructuralChange {
  return { id, kind: "inline-replace", blockId, start, end, before, after, operationIndexes: [start] };
}

function project(
  base: Document,
  changes: readonly StructuralChange[],
  metadata: Parameters<typeof buildReviewProjection>[3] = [],
  proposed: Document = base,
) {
  return buildReviewProjection(base, proposed, changes, metadata);
}

describe("review projection", () => {
  test("keeps the accepted detached document visible and save-enabled after the final individual acceptance", () => {
    const controller = new SuggestionController();
    const pending = controller.receive(
      {
        proposalId: "final-accept",
        sessionToken: "token",
        documentVersion: { kind: "artifact_revision", revision: 1 },
        operations: [{ kind: "replace", blockId: "p1", scope: { kind: "range", start: 0, end: 1 }, text: "A" }],
      },
      document(block("p1", [{ text: "a", style: {} }])),
      { kind: "artifact_revision", revision: 1 },
    );
    expect(pending.kind).toBe("pending");
    if (pending.kind !== "pending") return;

    const finalState = controller.acceptChangeForReview(pending.changes[0]!.id);
    expect(finalState).toMatchObject({ kind: "pending", changes: [], acceptedOperationIndexes: [0] });
    if (finalState.kind !== "pending") return;

    const presentation = reviewSurfaceState(
      finalState.changes,
      finalState.acceptedOperationIndexes,
    );
    expect(presentation).toMatchObject({
      activeChangeId: null,
      isFinalAcceptedState: true,
      canSaveAcceptedChanges: true,
      shouldRenderProjection: true,
    });
    const projection = buildReviewProjection(
      finalState.reviewBaseDoc,
      finalState.reviewBaseDoc,
      presentation.changes,
      finalState.operationMetadata,
    );
    expect(getBlockText(projection.document.blocks[0]!)).toBe("A");
  });

  test("reflows replacement redlines while retaining underlying styles", () => {
    const base = document(block("p1", [
      { text: "Hello ", style: { bold: true } },
      { text: "world", style: { italic: true } },
    ]));
    const before = JSON.stringify(base);

    const projection = project(base, [
      replace("replace-world", "p1", 6, 11, "world", "earth"),
    ]);

    const projected = projection.document.blocks[0]!;
    expect(getBlockText(projected)).toBe("Hello worldearth");
    expect(projected.inlines).toEqual([
      { text: "Hello ", style: { bold: true } },
      { text: "world", style: { italic: true, color: "#c62828", strikethrough: true } },
      { text: "earth", style: { bold: true, color: "#2e7d32", underline: true } },
    ]);
    expect(projection.items).toEqual([
      {
        id: "replace-world",
        kind: "inline-replace",
        changeIds: ["replace-world"],
        operationIndexes: [6],
        anchors: [
          { role: "delete", blockId: "p1", offset: 6, length: 5 },
          { role: "insert", blockId: "p1", offset: 6, length: 5 },
        ],
      },
    ]);
    expect(JSON.stringify(base)).toBe(before);
  });

  test("keeps four replacements as four logical items, not eight halves", () => {
    const projection = project(
      document(block("p1", [{ text: "a b c d", style: {} }])),
      [
        replace("one", "p1", 0, 1, "a", "A"),
        replace("two", "p1", 2, 3, "b", "B"),
        replace("three", "p1", 4, 5, "c", "C"),
        replace("four", "p1", 6, 7, "d", "D"),
      ],
    );

    expect(getBlockText(projection.document.blocks[0]!)).toBe("aA bB cC dD");
    expect(projection.items).toHaveLength(4);
    expect(projection.items.every((item) => item.anchors.length === 2)).toBe(true);
    expect(projection.items.map((item) => item.id)).toEqual(["one", "two", "three", "four"]);
  });

  test("renders inserts and deletes at their exact base offsets", () => {
    const projection = project(
      document(block("p1", [{ text: "abcd", style: { fontFamily: "Serif" } }])),
      [
        { id: "insert", kind: "inline-insert", blockId: "p1", start: 1, end: 1, before: "", after: "X", operationIndexes: [0] },
        { id: "delete", kind: "inline-delete", blockId: "p1", start: 2, end: 3, before: "c", after: "", operationIndexes: [1] },
      ],
    );

    const inlines = projection.document.blocks[0]!.inlines;
    expect(getBlockText(projection.document.blocks[0]!)).toBe("aXbcd");
    expect(inlines[1]).toMatchObject({ text: "X", style: { fontFamily: "Serif", color: "#2e7d32", underline: true } });
    expect(inlines[3]).toMatchObject({ text: "c", style: { fontFamily: "Serif", color: "#c62828", strikethrough: true } });
  });

  test("represents an explicit move as one linked source and destination item", () => {
    const base = document(block("a", [{ text: "A", style: {} }]), block("b", [{ text: "B", style: {} }]));
    const before = JSON.stringify(base);
    const proposed = document(block("b", [{ text: "B", style: {} }]), block("a", [{ text: "Moved A", style: { italic: true } }]));
    const proposedBefore = JSON.stringify(proposed);
    const projection = project(base, [
      { id: "move-a", kind: "move", blockId: "a", from: 0, to: 1, operationIndexes: [3] },
    ], [{ kind: "move-block", blockId: "a" }], proposed);

    expect(projection.items).toEqual([
      {
        id: "move-a",
        kind: "move",
        changeIds: ["move-a"],
        operationIndexes: [3],
        anchors: [
          { role: "source", blockId: "a", index: 0 },
          { role: "destination", blockId: "a", index: 1 },
        ],
      },
    ]);
    expect(projection.document.blocks.map((item) => item.id)).toEqual(["a", "b", "review:move-destination:move-a"]);
    expect(projection.document.blocks[0]!.inlines[0]).toMatchObject({ text: "A", style: REVIEW_DELETE_STYLE });
    expect(projection.document.blocks[2]!.inlines[0]).toMatchObject({ text: "Moved A", style: { italic: true, ...REVIEW_INSERT_STYLE } });
    expect(new Set(projection.document.blocks.map((item) => item.id)).size).toBe(3);
    expect(projection.document).not.toBe(base);
    expect(JSON.stringify(base)).toBe(before);
    expect(JSON.stringify(proposed)).toBe(proposedBefore);
  });

  test("visibly overlays inline, block, and type formatting changes", () => {
    const base = document(
      block("inline", [{ text: "inline format", style: { bold: true } }]),
      block("block", [{ text: "block format", style: { italic: true } }]),
      block("type", [{ text: "type format", style: {} }]),
    );
    const before = JSON.stringify(base);
    const proposed = document(
      block("inline", [{ text: "inline format", style: { bold: true, underline: true } }]),
      block("block", [{ text: "block format", style: { italic: true } }]),
      block("type", [{ text: "type format", style: {} }]),
    );
    proposed.blocks[1]!.style = { alignment: "center" } as Block["style"];
    proposed.blocks[2]!.type = "heading";
    proposed.blocks[2]!.headingLevel = 2;
    const proposedBefore = JSON.stringify(proposed);
    const projection = project(base, [
      { id: "inline-style", kind: "inline-style", blockId: "inline", before: {}, after: { underline: true }, operationIndexes: [0] },
      { id: "block-style", kind: "block-style", blockId: "block", before: {}, after: { alignment: "center" }, operationIndexes: [1] },
      { id: "block-type", kind: "block-type", blockId: "type", before: { type: "paragraph" }, after: { type: "heading" }, operationIndexes: [2] },
    ], [
      { kind: "format-inline", blockId: "inline", range: { start: 0, end: 6 } },
      { kind: "format-block", blockId: "block", range: { start: 0, end: 12 } },
      { kind: "set-block-type", blockId: "type", range: { start: 0, end: 11 } },
    ], proposed);

    expect(projection.document.blocks[0]!.inlines).toEqual([
      { text: "inline", style: { bold: true, underline: true, backgroundColor: "#fff3cd" } },
      { text: " format", style: { bold: true, underline: true } },
    ]);
    expect(projection.document.blocks[1]!.inlines[0]).toMatchObject({ text: "block format", style: { italic: true, backgroundColor: "#fff3cd" } });
    expect(projection.document.blocks[2]!.inlines[0]).toMatchObject({ text: "type format", style: REVIEW_FORMAT_STYLE });
    expect(projection.document.blocks[1]!.style.alignment).toBe("center");
    expect(projection.document.blocks[2]).toMatchObject({ type: "heading", headingLevel: 2 });
    expect(JSON.stringify(base)).toBe(before);
    expect(JSON.stringify(proposed)).toBe(proposedBefore);
  });

  test("projects inserted and deleted blocks with review-only IDs and styles", () => {
    const base = document(
      block("removed", [{ text: "Remove me", style: { bold: true } }]),
      block("kept", [{ text: "Keep me", style: {} }]),
    );
    const before = JSON.stringify(base);
    const proposed = document(
      block("kept", [{ text: "Keep me", style: {} }]),
      block("new-canonical-block", [{ text: "Actual inserted text", style: { italic: true } }]),
    );
    proposed.blocks[1]!.type = "heading";
    proposed.blocks[1]!.headingLevel = 3;
    const proposedBefore = JSON.stringify(proposed);
    const projection = project(base, [
      { id: "delete-block", kind: "block-delete", blockId: "removed", index: 0, operationIndexes: [0] },
      { id: "insert-block", kind: "block-insert", blockId: "new-canonical-block", index: 1, operationIndexes: [1] },
    ], [], proposed);

    expect(projection.document.blocks.map((item) => item.id)).toEqual([
      "removed",
      "review:block-insert:insert-block",
      "kept",
    ]);
    expect(projection.document.blocks[0]!.inlines[0]).toMatchObject({
      text: "Remove me",
      style: { bold: true, color: "#c62828", strikethrough: true },
    });
    expect(projection.document.blocks[1]!.inlines[0]).toEqual({
      text: "Actual inserted text",
      style: { italic: true, ...REVIEW_INSERT_STYLE },
    });
    expect(projection.document.blocks[1]).toMatchObject({ type: "heading", headingLevel: 3 });
    expect(new Set(projection.document.blocks.map((item) => item.id)).size).toBe(3);
    expect(JSON.stringify(base)).toBe(before);
    expect(JSON.stringify(proposed)).toBe(proposedBefore);
  });

  test("redlines nested table cell text and inline/block styles without mutating snapshots", () => {
    const base = document(table("t"));
    const proposed = structuredClone(base);
    const before = JSON.stringify(base);
    const cell = proposed.blocks[0]!.tableData!.rows[0]!.cells[1]!;
    cell.blocks[0]!.inlines = [{ text: "changed", style: { bold: true } }];
    cell.blocks[0]!.style = { alignment: "center" } as Block["style"];
    const after = JSON.stringify(proposed);
    const projection = project(base, [
      {
        id: "cell-text", kind: "table-cell-text", blockId: "t", tableId: "t",
        bounds: { start: { rowIndex: 0, colIndex: 1 }, end: { rowIndex: 0, colIndex: 1 } },
        before: "0:1", after: "changed", operationIndexes: [0], groupId: "text", dependencyOperationIndexes: [],
      },
      {
        id: "cell-style", kind: "table-cell-style", blockId: "t", tableId: "t",
        bounds: { start: { rowIndex: 0, colIndex: 1 }, end: { rowIndex: 0, colIndex: 1 } },
        before: {}, after: {}, operationIndexes: [1], groupId: "style", dependencyOperationIndexes: [],
      },
    ], [], proposed);

    const projected = projection.document.blocks[0]!.tableData!.rows[0]!.cells[1]!;
    expect(getBlockText(projected.blocks[0]!)).toBe("Cell formatting changed: cell R1C2");
    expect(getBlockText(projected.blocks[1]!)).toBe("0:1changed");
    expect(projected.blocks[1]!.inlines).toMatchObject([
      { text: "0:1", style: { ...REVIEW_DELETE_STYLE, ...REVIEW_FORMAT_STYLE } },
      { text: "changed", style: { bold: true, ...REVIEW_INSERT_STYLE, ...REVIEW_FORMAT_STYLE } },
    ]);
    expect(projected.style).toMatchObject({ backgroundColor: "#fff3cd" });
    expect(projection.items.map((item) => item.anchors[0]?.role)).toEqual(["cell", "cell"]);
    expect(JSON.stringify(base)).toBe(before);
    expect(JSON.stringify(proposed)).toBe(after);
  });

  test("shows nested table cell insertions and deletions at their base offsets", () => {
    const base = document(table("t"));
    const proposed = structuredClone(base);
    proposed.blocks[0]!.tableData!.rows[0]!.cells[0]!.blocks[0]!.inlines = [{ text: "0:0+", style: { italic: true } }];
    proposed.blocks[0]!.tableData!.rows[0]!.cells[1]!.blocks[0]!.inlines = [{ text: "", style: {} }];
    const change = (id: string, colIndex: number): StructuralChange => ({
      id, kind: "table-cell-text", blockId: "t", tableId: "t",
      bounds: { start: { rowIndex: 0, colIndex }, end: { rowIndex: 0, colIndex } },
      before: null, after: null, operationIndexes: [], groupId: id, dependencyOperationIndexes: [],
    });
    const projection = project(base, [change("insert", 0), change("delete", 1)], [], proposed);
    const inserted = projection.document.blocks[0]!.tableData!.rows[0]!.cells[0]!.blocks[0]!;
    const deleted = projection.document.blocks[0]!.tableData!.rows[0]!.cells[1]!.blocks[0]!;

    expect(getBlockText(inserted)).toBe("0:0+");
    expect(inserted.inlines[1]).toMatchObject({ text: "+", style: { italic: true, ...REVIEW_INSERT_STYLE } });
    expect(getBlockText(deleted)).toBe("0:1");
    expect(deleted.inlines[0]).toMatchObject({ text: "0:1", style: REVIEW_DELETE_STYLE });
  });

  test("projects every table structural operation as a readable table-scoped item", () => {
    const base = document(table("t"));
    const proposed = structuredClone(base);
    proposed.blocks[0]!.tableData!.rows.push(structuredClone(proposed.blocks[0]!.tableData!.rows[0]!));
    proposed.blocks[0]!.tableData!.columnWidths.push(0.5);
    for (const row of proposed.blocks[0]!.tableData!.rows) row.cells.push(structuredClone(row.cells[0]!));
    const kinds = [
      "table-row-insert", "table-row-delete", "table-column-insert", "table-column-delete",
      "table-merge", "table-split",
    ] as const;
    const changes: StructuralChange[] = kinds.map((kind, index) => ({
      id: kind,
      kind,
      blockId: "t",
      tableId: "t",
      bounds: { start: { rowIndex: 0, colIndex: 0 }, end: { rowIndex: 1, colIndex: 1 } },
      operationIndexes: [index],
      groupId: `${kind}:t:${index}`,
      dependencyOperationIndexes: [],
    }));
    const projection = project(base, changes, [], proposed);

    expect(projection.document.blocks.filter((block) => block.type === "table")).toHaveLength(1);
    expect(projection.document.blocks.slice(0, -1).map(getBlockText)).toEqual([
      "Row inserted: R1C1–R2C2",
      "Row deleted: R1C1–R2C2",
      "Column inserted: R1C1–R2C2",
      "Column deleted: R1C1–R2C2",
      "Cells merged: R1C1–R2C2",
      "Cell split: R1C1–R2C2",
    ]);
    expect(projection.items).toHaveLength(kinds.length);
    expect(projection.items.every((item) => item.anchors[0]?.role === "table")).toBe(true);
  });

  test("groups multi-cell merge/split and table deletion into atomic logical items", () => {
    const base = document(table("t"));
    const deletion: StructuralChange = {
      id: "delete", kind: "table-delete", blockId: "t", tableId: "t",
      bounds: { start: { rowIndex: 0, colIndex: 0 }, end: { rowIndex: 1, colIndex: 1 } },
      operationIndexes: [5], groupId: "delete:t", dependencyOperationIndexes: [],
    };
    const mergeParts: StructuralChange[] = ["merge-a", "merge-b"].map((id, index) => ({
      id, kind: "table-merge", blockId: "t", tableId: "t",
      bounds: { start: { rowIndex: 0, colIndex: index }, end: { rowIndex: 1, colIndex: 1 } },
      operationIndexes: [index], groupId: "merge:t:0", dependencyOperationIndexes: [],
    }));
    const projection = project(base, [...mergeParts, deletion], [], document());

    expect(projection.items).toEqual([
      expect.objectContaining({ id: "merge-a", changeIds: ["merge-a", "merge-b"], operationIndexes: [0, 1] }),
      expect.objectContaining({ id: "delete", changeIds: ["delete"], operationIndexes: [5] }),
    ]);
    expect(projection.document.blocks.map(getBlockText)).toContain("Table deleted: R1C1–R2C2");
    expect(projection.document.blocks.some((block) => block.type === "table")).toBe(true);
  });
});
