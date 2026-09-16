import { describe, expect, test } from "bun:test";
import { createBlock, createTableBlock, type Block, type Document } from "@nautilo/office-docs/node";
import type { ProposalOperation } from "./proposal-contract";
import { resolveProposalOperations } from "./proposal-resolver";

function block(id: string, parts: string[]): Block {
  const value = createBlock("paragraph");
  value.id = id;
  value.inlines = parts.map((text, index) => ({ text, style: index === 0 ? { bold: true } : {} }));
  return value;
}
function doc(...blocks: Block[]): Document {
  return { blocks } as Document;
}
function resolve(document: Document, operation: ProposalOperation) {
  return resolveProposalOperations(document, [operation]);
}

describe("proposal resolver", () => {
  test("resolves an anchor across styled-inline boundaries", () => {
    const result = resolve(doc(block("a", ["Hello ", "world. Next."])), {
      kind: "replace", blockId: "a", scope: { kind: "match", anchor: "Hello world" }, text: "Hi",
    });
    expect(result).toMatchObject({ ok: true, operations: [{ range: { start: 0, end: 11 } }] });
  });

  test("normalizes documented curly quotes, dashes, and whitespace only", () => {
    const result = resolve(doc(block("a", ["“Well”—  yes"])), {
      kind: "delete", blockId: "a", scope: { kind: "match", anchor: "\"Well\"- yes" },
    });
    expect(result).toMatchObject({ ok: true, operations: [{ range: { start: 0, end: 12 } }] });
  });

  test("never selects the first repeated anchor", () => {
    const result = resolve(doc(block("a", ["repeat then repeat"])), {
      kind: "delete", blockId: "a", scope: { kind: "match", anchor: "repeat" },
    });
    expect(result).toMatchObject({ ok: false, code: "anchor_ambiguous" });
  });

  test("fails closed for missing anchors and unknown IDs", () => {
    expect(resolve(doc(block("a", ["one"])), { kind: "delete", blockId: "a", scope: { kind: "match", anchor: "two" } })).toMatchObject({ ok: false, code: "anchor_not_found" });
    expect(resolve(doc(block("a", ["one"])), { kind: "delete", blockId: "missing", scope: { kind: "block" } })).toMatchObject({ ok: false, code: "unknown_block" });
  });

  test("supports sentence, block, and bounded structural ranges", () => {
    const document = doc(block("a", ["One. Two here! Three"]));
    expect(resolve(document, { kind: "delete", blockId: "a", scope: { kind: "sentence", anchor: "Two here" } })).toMatchObject({ ok: true, operations: [{ range: { start: 4, end: 14 } }] });
    expect(resolve(document, { kind: "delete", blockId: "a", scope: { kind: "block" } })).toMatchObject({ ok: true, operations: [{ range: { start: 0, end: 20 } }] });
    expect(resolve(document, { kind: "insert", blockId: "a", scope: { kind: "range", start: 4, end: 4 }, text: "X" })).toMatchObject({ ok: true, operations: [{ range: { start: 4, end: 4 } }] });
  });

  test("resolves unique nested table cell anchors and rejects ambiguity", () => {
    const table = createTableBlock(1, 2);
    table.id = "table";
    table.tableData!.rows[0]!.cells[0]!.blocks[0]!.id = "cell-unique";
    table.tableData!.rows[0]!.cells[0]!.blocks[0]!.inlines = [{ text: "unique cell wording", style: {} }];
    table.tableData!.rows[0]!.cells[1]!.blocks[0]!.id = "cell-repeat";
    table.tableData!.rows[0]!.cells[1]!.blocks[0]!.inlines = [{ text: "repeat repeat", style: {} }];
    expect(resolve(doc(table), { kind: "replace", blockId: "cell-unique", scope: { kind: "match", anchor: "unique cell" }, text: "new" }))
      .toMatchObject({ ok: true, operations: [{ range: { start: 0, end: 11 } }] });
    expect(resolve(doc(table), { kind: "delete", blockId: "cell-repeat", scope: { kind: "match", anchor: "repeat" } }))
      .toMatchObject({ ok: false, code: "anchor_ambiguous" });
  });

  test("fails closed for covered nested cells and bad table targets", () => {
    const table = createTableBlock(1, 2);
    table.id = "table";
    table.tableData!.rows[0]!.cells[1]!.colSpan = 0;
    table.tableData!.rows[0]!.cells[1]!.blocks[0]!.id = "covered";
    expect(resolve(doc(table), { kind: "delete", blockId: "covered", scope: { kind: "block" } }))
      .toMatchObject({ ok: false, code: "unknown_block" });
    expect(resolve(doc(table), { kind: "delete-table", tableBlockId: "missing" }))
      .toMatchObject({ ok: false, code: "unknown_block" });
  });
});
