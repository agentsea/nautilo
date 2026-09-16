import { describe, expect, test } from "bun:test";
import { validateEditOpenWriterRequest } from "./proposal-contract";

const request = (operation: object) => ({
  sessionToken: "opaque-session-token",
  documentVersion: { kind: "artifact_revision" as const, revision: 7 },
  operations: [operation],
});
const match = { kind: "match", anchor: "fresh wording" };

describe("proposal contract", () => {
  test("accepts bounded, structural operations", () => {
    const result = validateEditOpenWriterRequest(request({ kind: "replace", blockId: "b1", scope: match, text: "new wording" }));
    expect(result.ok).toBe(true);
  });

  test("validates every table operation shape", () => {
    const operations = [
      { kind: "insert-table-row", tableBlockId: "table", rowIndex: 0 },
      { kind: "delete-table-row", tableBlockId: "table", rowIndex: 0 },
      { kind: "insert-table-column", tableBlockId: "table", colIndex: 0 },
      { kind: "delete-table-column", tableBlockId: "table", colIndex: 0 },
      { kind: "merge-table-cells", tableBlockId: "table", start: { rowIndex: 0, colIndex: 0 }, end: { rowIndex: 1, colIndex: 1 } },
      { kind: "split-table-cell", tableBlockId: "table", cell: { rowIndex: 0, colIndex: 0 } },
      { kind: "set-table-cell-style", tableBlockId: "table", cell: { rowIndex: 0, colIndex: 0 }, style: { backgroundColor: "#abc", verticalAlign: "middle", padding: 4 } },
      { kind: "delete-table", tableBlockId: "table" },
    ];
    for (const operation of operations) expect(validateEditOpenWriterRequest(request(operation))).toMatchObject({ ok: true });
  });

  test("rejects malformed table addresses and cell styles", () => {
    expect(validateEditOpenWriterRequest(request({
      kind: "merge-table-cells", tableBlockId: "table", start: { rowIndex: -1, colIndex: 0 }, end: { rowIndex: 1, colIndex: 1 },
    }))).toMatchObject({ ok: false, field: "operations[0].start.rowIndex" });
    expect(validateEditOpenWriterRequest(request({
      kind: "split-table-cell", tableBlockId: "table", cell: { rowIndex: 0 },
    }))).toMatchObject({ ok: false, field: "operations[0].cell.colIndex" });
    expect(validateEditOpenWriterRequest(request({
      kind: "set-table-cell-style", tableBlockId: "table", cell: { rowIndex: 0, colIndex: 0 }, style: { verticalAlign: "baseline" },
    }))).toMatchObject({ ok: false, field: "operations[0].style.verticalAlign" });
    expect(validateEditOpenWriterRequest(request({
      kind: "delete-table", tableBlockId: "table", blockId: "forbidden",
    }))).toMatchObject({ ok: false, field: "operations[0].blockId" });
  });

  test("validates inline, block, and cell styles before proposal preflight", () => {
    const validOperations = [
      {
        kind: "format-inline",
        blockId: "b1",
        scope: match,
        style: { bold: true, fontSize: 200, fontFamily: "Inter", color: "#abc", backgroundColor: "aabbccdd", href: "https://example.com" },
      },
      {
        kind: "format-block",
        blockId: "b1",
        scope: { kind: "block" },
        style: { alignment: "justify", lineHeight: 1.5, marginTop: 0, marginBottom: 1000, textIndent: 12, marginLeft: 36 },
      },
      {
        kind: "set-table-cell-style",
        tableBlockId: "table",
        cell: { rowIndex: 0, colIndex: 0 },
        style: { backgroundColor: "#1234", verticalAlign: "bottom", padding: 100 },
      },
    ];
    for (const operation of validOperations) {
      expect(validateEditOpenWriterRequest(request(operation))).toMatchObject({ ok: true });
    }

    const invalidOperations = [
      { kind: "format-inline", blockId: "b1", scope: match, style: { fontSize: Number.NaN } },
      { kind: "format-inline", blockId: "b1", scope: match, style: { fontSize: Number.POSITIVE_INFINITY } },
      { kind: "format-inline", blockId: "b1", scope: match, style: { color: "#12345" } },
      { kind: "format-inline", blockId: "b1", scope: match, style: { href: "x".repeat(2001) } },
      { kind: "format-inline", blockId: "b1", scope: match, style: { arbitrary: true } },
      { kind: "format-block", blockId: "b1", scope: { kind: "block" }, style: { alignment: "start" } },
      { kind: "format-block", blockId: "b1", scope: { kind: "block" }, style: { lineHeight: Number.NEGATIVE_INFINITY } },
      { kind: "format-block", blockId: "b1", scope: { kind: "block" }, style: { marginLeft: 1001 } },
      { kind: "format-block", blockId: "b1", scope: { kind: "block" }, style: { arbitrary: 1 } },
      { kind: "set-table-cell-style", tableBlockId: "table", cell: { rowIndex: 0, colIndex: 0 }, style: { backgroundColor: "orange" } },
      { kind: "set-table-cell-style", tableBlockId: "table", cell: { rowIndex: 0, colIndex: 0 }, style: { padding: -1 } },
      { kind: "set-table-cell-style", tableBlockId: "table", cell: { rowIndex: 0, colIndex: 0 }, style: { padding: Number.POSITIVE_INFINITY } },
      { kind: "set-table-cell-style", tableBlockId: "table", cell: { rowIndex: 0, colIndex: 0 }, style: { padding: 101 } },
      { kind: "set-table-cell-style", tableBlockId: "table", cell: { rowIndex: 0, colIndex: 0 }, style: { arbitrary: "value" } },
    ];
    for (const operation of invalidOperations) {
      expect(validateEditOpenWriterRequest(request(operation))).toMatchObject({ ok: false });
    }
  });

  test("rejects invalid and overlong anchors", () => {
    expect(validateEditOpenWriterRequest(request({ kind: "delete", blockId: "b1", scope: { kind: "match", anchor: "" } }))).toMatchObject({ ok: false, field: "operations[0].scope.anchor" });
    expect(validateEditOpenWriterRequest(request({ kind: "delete", blockId: "b1", scope: { kind: "match", anchor: "one two three four five six" } }))).toMatchObject({ ok: false, field: "operations[0].scope.anchor" });
  });

  test("continues to accept a short match anchor when it is valid", () => {
    const result = validateEditOpenWriterRequest(
      request({ kind: "delete", blockId: "b1", scope: { kind: "match", anchor: "a" } }),
    );
    expect(result).toMatchObject({
      ok: true,
      request: { operations: [{ scope: { kind: "match", anchor: "a" } }] },
    });
  });

  test("continues to accept a well-formed range scope for canonical callers", () => {
    const result = validateEditOpenWriterRequest(
      request({ kind: "delete", blockId: "b1", scope: { kind: "range", start: 4, end: 7 } }),
    );
    expect(result).toMatchObject({
      ok: true,
      request: { operations: [{ scope: { kind: "range", start: 4, end: 7 } }] },
    });
  });

  test("accepts only opaque locator handles for live operations", () => {
    const handle = "a".repeat(32);
    expect(validateEditOpenWriterRequest(
      request({ kind: "replace", blockId: "b1", scope: { kind: "locator", handle }, text: "new" }),
    )).toMatchObject({ ok: true });
    expect(validateEditOpenWriterRequest(
      request({ kind: "replace", blockId: "b1", scope: { kind: "locator", handle: "short" }, text: "new" }),
    )).toMatchObject({ ok: false, field: "operations[0].scope.handle" });
  });

  test("rejects every additional operation property, including source-text aliases", () => {
    for (const field of [
      "oldString", "source", "copiedSource", "originalText", "beforeText", "previousText",
      "diff", "patch", "hunk", "occurrence", "target", "path", "arbitrary",
    ]) {
      expect(validateEditOpenWriterRequest(request({
        kind: "replace",
        blockId: "b1",
        scope: match,
        text: "new",
        [field]: "forbidden",
      }))).toMatchObject({ ok: false, field: `operations[0].${field}` });
    }
  });

  test("rejects additional request and nested discriminated-union properties", () => {
    expect(validateEditOpenWriterRequest({
      ...request({ kind: "delete", blockId: "b1", scope: match }),
      arbitrary: true,
    })).toMatchObject({ ok: false, field: "request.arbitrary" });

    expect(validateEditOpenWriterRequest(request({
      kind: "delete",
      blockId: "b1",
      scope: { ...match, previousText: "fresh wording" },
    }))).toMatchObject({ ok: false, field: "operations[0].scope.previousText" });

    expect(validateEditOpenWriterRequest(request({
      kind: "move-block",
      blockId: "b1",
      destination: { position: "after", afterBlockId: "b2", originalText: "copied" },
    }))).toMatchObject({ ok: false, field: "operations[0].destination.originalText" });

    expect(validateEditOpenWriterRequest(request({
      kind: "set-block-type",
      blockId: "b1",
      scope: { kind: "block" },
      blockType: { type: "heading", headingLevel: 2, beforeText: "copied" },
    }))).toMatchObject({ ok: false, field: "operations[0].blockType.beforeText" });

    expect(validateEditOpenWriterRequest(request({
      kind: "format-inline",
      blockId: "b1",
      scope: match,
      style: { bold: true, previousText: "copied" },
    }))).toMatchObject({ ok: false, field: "operations[0].style.previousText" });
  });

  test("preserves exact allowed fields for each union variant", () => {
    const invalidOperations = [
      { kind: "delete", blockId: "b1", scope: match, text: "not allowed" },
      { kind: "format-inline", blockId: "b1", scope: match, style: { bold: true }, destination: { position: "end" } },
      { kind: "move-block", blockId: "b1", destination: { position: "start", afterBlockId: "b2" } },
      { kind: "set-block-type", blockId: "b1", scope: { kind: "block" }, blockType: { type: "paragraph", headingLevel: 1 } },
      { kind: "delete", blockId: "b1", scope: { kind: "block", anchor: "not allowed" } },
    ];
    for (const operation of invalidOperations) {
      expect(validateEditOpenWriterRequest(request(operation))).toMatchObject({ ok: false });
    }
  });

  test("rejects malformed scopes and illegal move destinations", () => {
    expect(validateEditOpenWriterRequest(request({ kind: "delete", blockId: "b1", scope: { kind: "range", start: 4, end: 1 } }))).toMatchObject({ ok: false });
    expect(validateEditOpenWriterRequest(request({ kind: "move-block", blockId: "b1", destination: { position: "after", afterBlockId: "b1" } }))).toMatchObject({ ok: false });
  });

  test("accepts more than twenty independently serialized operations", () => {
    const result = validateEditOpenWriterRequest({
      sessionToken: "token",
      baseRevision: 0,
      operations: Array.from({ length: 21 }, (_, index) => ({
        kind: "delete",
        blockId: `b${index}`,
        scope: match,
      })),
    });
    expect(result).toMatchObject({ ok: true });
  });
});
