import { describe, expect, test } from "bun:test";
import { createBlock, getBlockText, type Block, type Document } from "@nautilo/office-docs/node";
import { executeProposalOperations } from "./proposal-execution";

function block(id: string, text: string): Block {
  const value = createBlock("paragraph");
  value.id = id;
  value.inlines = [{ text, style: {} }];
  return value;
}
function document(...blocks: Block[]): Document {
  return { blocks } as Document;
}
function text(result: ReturnType<typeof executeProposalOperations>, index = 0): string {
  if (!result.ok) throw new Error(result.message);
  return getBlockText(result.document.blocks[index]!);
}

describe("base-revision proposal execution", () => {
  test("applies shortening and later replacement against base coordinates", () => {
    const result = executeProposalOperations(document(block("a", "abcdef")), [
      { kind: "delete", blockId: "a", scope: { kind: "range", start: 0, end: 2 } },
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 2, end: 4 }, text: "X" },
    ]);
    expect(text(result)).toBe("Xef");
  });

  test("rejects ranges that only exist after an earlier lengthening", () => {
    const result = executeProposalOperations(document(block("a", "abcdef")), [
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 1, end: 2 }, text: "LONG" },
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 5, end: 7 }, text: "X" },
    ]);
    expect(result).toMatchObject({ ok: false, code: "invalid_scope", operationIndex: 1 });
  });

  test("reorders independent ranges and rejects overlaps", () => {
    const nonOverlapping = executeProposalOperations(document(block("a", "abcdef")), [
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 0, end: 1 }, text: "A" },
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 4, end: 6 }, text: "EF" },
    ]);
    expect(text(nonOverlapping)).toBe("AbcdEF");

    const overlapping = executeProposalOperations(document(block("a", "abcdef")), [
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 1, end: 4 }, text: "X" },
      { kind: "delete", blockId: "a", scope: { kind: "range", start: 1, end: 2 } },
    ]);
    expect(overlapping).toMatchObject({
      ok: false,
      code: "proposal_conflict",
      conflictingOperationIndexes: [0, 1],
    });
  });

  test("orders independent formatting with mutations and preserves source indexes", () => {
    const result = executeProposalOperations(document(block("a", "abcdef")), [
      { kind: "format-inline", blockId: "a", scope: { kind: "range", start: 4, end: 6 }, style: { bold: true } },
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 0, end: 1 }, text: "A" },
    ]);
    expect(text(result)).toBe("Abcdef");
    if (!result.ok) return;
    expect(result.metadata.map((metadata) => metadata.operationIndex).sort()).toEqual([0, 1]);

    const conflict = executeProposalOperations(document(block("a", "abcdef")), [
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 0, end: 2 }, text: "A" },
      { kind: "format-inline", blockId: "a", scope: { kind: "range", start: 1, end: 3 }, style: { bold: true } },
    ]);
    expect(conflict).toMatchObject({ ok: false, code: "proposal_conflict", conflictingOperationIndexes: [0, 1] });
  });

  test("independently resolves operations in separate blocks", () => {
    const result = executeProposalOperations(document(block("a", "abc"), block("b", "def")), [
      { kind: "insert", blockId: "a", scope: { kind: "range", start: 1, end: 1 }, text: "!" },
      { kind: "replace", blockId: "b", scope: { kind: "range", start: 1, end: 3 }, text: "X" },
    ]);
    expect(text(result, 0)).toBe("a!bc");
    expect(text(result, 1)).toBe("dX");
  });

  test("atomically discards all work when a later operation fails", () => {
    const base = document(block("a", "abc"));
    const result = executeProposalOperations(base, [
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 0, end: 1 }, text: "A" },
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 20, end: 21 }, text: "X" },
    ]);
    expect(result).toMatchObject({ ok: false, operationIndex: 1, document: base });
    expect(getBlockText(base.blocks[0]!)).toBe("abc");
  });
});
