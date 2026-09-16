import { describe, expect, test } from "bun:test";
import { createTableBlock, type Block, type Document } from "@nautilo/office-docs/node";
import {
  executeProposalOperations,
  parseEditOpenWriterDocumentVersion,
  parseWriterHtml,
  validateAcceptedOperationSelection,
  validateEditOpenWriterRequest,
  writerLiveReviewExtension,
} from "@nautilo/writer-proposal-core";

const MANIFEST_TYPE = "application/vnd.nautilo.document+json";
const PAYLOAD_TYPE = "application/vnd.wafflebase.document+json";

function writerHtml(payloadJson: string, extraScripts = ""): string {
  return `<!DOCTYPE html><html><head>
<script type="${MANIFEST_TYPE}" id="manifest">{
  "documentType": "document",
  "editor": "wafflebase",
  "payloadId": "wafflebase-document",
  "payloadFormat": "${PAYLOAD_TYPE}",
  "version": "1.0"
}</script>
<script type="${PAYLOAD_TYPE}" id="wafflebase-document">${payloadJson}</script>
${extraScripts}
</head><body></body></html>`;
}

function paragraph(id: string, text: string): Block {
  return {
    id,
    type: "paragraph",
    inlines: [{ text, style: {} }],
    style: {},
  } as Block;
}

function blockText(block: Block | undefined): string {
  const inlines = (block as { inlines?: Array<{ text: string }> } | undefined)?.inlines;
  return inlines?.map((inline) => inline.text).join("") ?? "";
}

describe("public import surface", () => {
  test("exports parser, contract, and execution primitives", () => {
    expect(typeof parseWriterHtml).toBe("function");
    expect(typeof validateEditOpenWriterRequest).toBe("function");
    expect(typeof executeProposalOperations).toBe("function");
  });
});

describe("canonical Writer HTML parser safety", () => {
  test("parses the canonical manifest and payload", () => {
    const parsed = parseWriterHtml(writerHtml('{"blocks":[]}'));

    expect(parsed).toMatchObject({
      ok: true,
      document: {
        manifest: { payloadId: "wafflebase-document" },
        document: { blocks: [] },
      },
    });
  });

  test("rejects executable scripts and prototype-pollution keys", () => {
    const executable = parseWriterHtml(
      writerHtml('{"blocks":[]}', "<script>globalThis.compromised = true</script>"),
    );
    expect(executable).toMatchObject({ ok: false });
    if (!executable.ok) expect(executable.error).toContain("executable script");

    const polluted = parseWriterHtml(
      writerHtml('{"blocks":[],"__proto__":{"polluted":true}}'),
    );
    expect(polluted).toMatchObject({ ok: false });
    if (!polluted.ok) expect(polluted.error).toContain("forbidden key");
  });
});

describe("edit-open-writer documentVersion contract", () => {
  test("accepts artifact and local SHA versions plus a legacy artifact revision shim", () => {
    expect(parseEditOpenWriterDocumentVersion({ kind: "artifact_revision", revision: 3 })).toEqual({
      kind: "artifact_revision",
      revision: 3,
    });
    expect(parseEditOpenWriterDocumentVersion({ kind: "local_sha", sha256: "a".repeat(64) })).toEqual({
      kind: "local_sha",
      sha256: "a".repeat(64),
    });
    expect(parseEditOpenWriterDocumentVersion(4)).toEqual({ kind: "artifact_revision", revision: 4 });

    const validated = validateEditOpenWriterRequest({
      sessionToken: "token",
      documentVersion: { kind: "artifact_revision", revision: 2 },
      operations: [{ kind: "delete", blockId: "a", scope: { kind: "block" } }],
    });
    expect(validated.ok).toBe(true);
  });

  test("does not impose an independent operation-count ceiling", () => {
    const validated = validateEditOpenWriterRequest({
      sessionToken: "token",
      documentVersion: { kind: "artifact_revision", revision: 2 },
      operations: Array.from({ length: 21 }, () => ({
        kind: "delete",
        blockId: "a",
        scope: { kind: "block" },
      })),
    });
    expect(validated.ok).toBe(true);
  });

  test("guides document-wide work to read every bounded range", () => {
    expect(writerLiveReviewExtension.guidance).toContain("summary.outline is only a preview");
    expect(writerLiveReviewExtension.guidance).toContain("blockCount");
  });

  test("classifies only returned top-level Writer blocks as exact-version reread coverage", () => {
    const canonical = writerHtml(JSON.stringify({
      blocks: [paragraph("first", "one"), paragraph("second", "two")],
    }));
    expect(writerLiveReviewExtension.readCoverageFactFromResult({
      canonicalContent: canonical,
      args: { blockId: "first" },
      result: {
        ok: true,
        status: "range_read",
        documentVersion: { kind: "artifact_revision", revision: 7 },
        blocks: [{ id: "first", type: "paragraph", text: "one" }],
      },
    })).toEqual({
      kind: "block_range",
      documentVersion: { kind: "artifact_revision", revision: 7 },
      blockCount: 2,
      blockIndexes: [0],
    });
    expect(writerLiveReviewExtension.readCoverageFactFromResult({
      canonicalContent: canonical,
      args: { blockId: "first" },
      result: {
        ok: true,
        status: "range_read",
        documentVersion: { kind: "artifact_revision", revision: 8 },
        blocks: [{ id: "missing", type: "paragraph", text: "not canonical" }],
      },
    })).toBeNull();
  });

  test("classifies table reads as a contiguous page chain without retaining table content", () => {
    const canonical = writerHtml(JSON.stringify({
      blocks: [{
        id: "table-1",
        type: "table",
        tableData: { columnWidths: [1], rows: [] },
      }],
    }));
    const start = { rowIndex: 0, colIndex: 0, blockIndex: 0, sliceIndex: 0 };
    const next = { rowIndex: 50, colIndex: 0, blockIndex: 0, sliceIndex: 0 };
    expect(writerLiveReviewExtension.readCoverageFactFromResult({
      canonicalContent: canonical,
      args: { blockId: "table-1" },
      result: {
        ok: true,
        status: "table_read",
        documentVersion: { kind: "artifact_revision", revision: 7 },
        table: { tableBlockId: "table-1", nextCursor: next, cells: [{ text: "not retained" }] },
      },
    })).toEqual({
      kind: "table_page",
      documentVersion: { kind: "artifact_revision", revision: 7 },
      blockCount: 1,
      tableBlockIndex: 0,
      cursor: start,
      nextCursor: next,
    });
    expect(writerLiveReviewExtension.readCoverageFactFromResult({
      canonicalContent: canonical,
      args: { blockId: "table-1", tableCursor: next },
      result: {
        ok: true,
        status: "table_read",
        documentVersion: { kind: "artifact_revision", revision: 7 },
        table: { tableBlockId: "table-1", cells: [] },
      },
    })).toEqual({
      kind: "table_page",
      documentVersion: { kind: "artifact_revision", revision: 7 },
      blockCount: 1,
      tableBlockIndex: 0,
      cursor: next,
      nextCursor: null,
    });
  });

  test("preflight returns resolved operations and metadata", () => {
    const canonical = writerHtml('{"blocks":[{"id":"a","type":"paragraph","inlines":[{"text":"abc","style":{}}],"style":{}}]}');
    const outcome = writerLiveReviewExtension.preflightProposal(canonical, [
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 0, end: 1 }, text: "X" },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.operations.length).toBe(1);
    expect(outcome.operationMetadata.length).toBe(1);
  });
});

describe("accepted operation selection", () => {
  test("allows a sorted independent partial subset", () => {
    expect(validateAcceptedOperationSelection(
      [0],
      2,
      [
        { operationIndex: 0, kind: "replace", blockId: "a", range: { start: 0, end: 1 } },
        { operationIndex: 1, kind: "replace", blockId: "b", range: { start: 0, end: 1 } },
      ],
    )).toEqual({ ok: true });
  });

  test("rejects open review groups and missing dependencies", () => {
    const grouped = executeProposalOperations(
      { blocks: [paragraph("a", "ab")] } as Document,
      [
        {
          kind: "format-inline",
          blockId: "a",
          scope: { kind: "range", start: 0, end: 1 },
          style: { bold: true },
        },
        {
          kind: "format-inline",
          blockId: "a",
          scope: { kind: "range", start: 1, end: 2 },
          style: { italic: true },
        },
      ],
    );
    expect(grouped.ok).toBe(true);
    if (!grouped.ok) return;
    expect(validateAcceptedOperationSelection(
      [0],
      2,
      grouped.metadata,
    )).toEqual({ ok: false, reason: "group_not_closed" });

    const table = createTableBlock(2, 2);
    table.id = "table";
    const dependent = executeProposalOperations(
      { blocks: [table] } as Document,
      [
        {
          kind: "merge-table-cells",
          tableBlockId: "table",
          start: { rowIndex: 0, colIndex: 0 },
          end: { rowIndex: 1, colIndex: 1 },
        },
        {
          kind: "split-table-cell",
          tableBlockId: "table",
          cell: { rowIndex: 0, colIndex: 0 },
        },
      ],
    );
    expect(dependent.ok).toBe(true);
    if (!dependent.ok) return;
    expect(validateAcceptedOperationSelection([1], 2, dependent.metadata))
      .toEqual({ ok: false, reason: "dependency_not_closed" });
  });
});

describe("documentVersion proposal execution", () => {
  test("resolves each operation against the immutable base", () => {
    const original = {
      blocks: [paragraph("a", "abcdef")],
    } as Document;

    const result = executeProposalOperations(original, [
      {
        kind: "delete",
        blockId: "a",
        scope: { kind: "range", start: 0, end: 2 },
      },
      {
        kind: "replace",
        blockId: "a",
        scope: { kind: "range", start: 2, end: 4 },
        text: "X",
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(blockText(result.document.blocks[0])).toBe("Xef");
    expect(blockText(original.blocks[0])).toBe("abcdef");
    expect(result.operations).toHaveLength(2);
    expect(result.metadata).toHaveLength(2);
  });

  test("applies independent same-block edits regardless of source order", () => {
    const base = { blocks: [paragraph("a", "abcdefgh")] } as Document;
    const sourceOrder = executeProposalOperations(base, [
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 5, end: 7 }, text: "LONG" },
      { kind: "delete", blockId: "a", scope: { kind: "range", start: 1, end: 3 } },
    ]);
    const reversed = executeProposalOperations(base, [
      { kind: "delete", blockId: "a", scope: { kind: "range", start: 1, end: 3 } },
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 5, end: 7 }, text: "LONG" },
    ]);

    expect(sourceOrder).toMatchObject({ ok: true });
    expect(reversed).toMatchObject({ ok: true });
    if (!sourceOrder.ok || !reversed.ok) return;
    expect(blockText(sourceOrder.document.blocks[0])).toBe("adeLONGh");
    expect(blockText(reversed.document.blocks[0])).toBe("adeLONGh");
    expect(sourceOrder.metadata.map((metadata) => metadata.operationIndex).sort()).toEqual([0, 1]);
    expect(validateAcceptedOperationSelection([0], 2, sourceOrder.metadata))
      .toEqual({ ok: true });
    expect(validateAcceptedOperationSelection([1], 2, sourceOrder.metadata))
      .toEqual({ ok: true });
  });

  test("applies block properties with a shortening replacement in either source order", () => {
    const base = { blocks: [paragraph("title", "Is anyone doing real work with AI agents?")] } as Document;
    const replacement = {
      kind: "replace" as const,
      blockId: "title",
      scope: { kind: "block" as const },
      text: "The AI Agency Problem",
    };
    const properties = [
      {
        kind: "set-block-type" as const,
        blockId: "title",
        scope: { kind: "block" as const },
        blockType: { type: "heading" as const, headingLevel: 1 as const },
      },
      {
        kind: "format-block" as const,
        blockId: "title",
        scope: { kind: "block" as const },
        style: { alignment: "center" as const },
      },
    ];

    for (const property of properties) {
      const replacementFirst = executeProposalOperations(base, [replacement, property]);
      const propertyFirst = executeProposalOperations(base, [property, replacement]);

      expect(replacementFirst).toMatchObject({ ok: true });
      expect(propertyFirst).toMatchObject({ ok: true });
      if (!replacementFirst.ok || !propertyFirst.ok) continue;
      expect(replacementFirst.document).toEqual(propertyFirst.document);
      const resultBlock = replacementFirst.document.blocks[0];
      expect(blockText(resultBlock)).toBe("The AI Agency Problem");
      if (property.kind === "set-block-type") {
        expect(resultBlock).toMatchObject({ type: "heading", headingLevel: 1 });
      } else {
        expect(resultBlock).toMatchObject({ style: { alignment: "center" } });
      }
    }
  });

  test("reports the source operation responsible for an apply-stage failure", () => {
    const table = createTableBlock(1, 1);
    table.id = "table";
    const base = { blocks: [table] } as Document;

    const result = executeProposalOperations(base, [
      { kind: "delete-table", tableBlockId: "table" },
      { kind: "delete-table", tableBlockId: "table" },
    ]);

    expect(result).toMatchObject({
      ok: false,
      stage: "apply",
      code: "unknown_block",
      operationIndex: 1,
      document: base,
    });
  });

  test("rejects overlapping and collapsed-coordinate collisions atomically", () => {
    const base = { blocks: [paragraph("a", "abcdef")] } as Document;
    for (const operations of [
      [
        { kind: "replace" as const, blockId: "a", scope: { kind: "range" as const, start: 1, end: 4 }, text: "X" },
        { kind: "delete" as const, blockId: "a", scope: { kind: "range" as const, start: 3, end: 5 } },
      ],
      [
        { kind: "insert" as const, blockId: "a", scope: { kind: "range" as const, start: 2, end: 2 }, text: "X" },
        { kind: "insert" as const, blockId: "a", scope: { kind: "range" as const, start: 2, end: 2 }, text: "Y" },
      ],
      [
        { kind: "delete" as const, blockId: "a", scope: { kind: "range" as const, start: 1, end: 3 } },
        { kind: "insert" as const, blockId: "a", scope: { kind: "range" as const, start: 3, end: 3 }, text: "Y" },
      ],
      [
        { kind: "replace" as const, blockId: "a", scope: { kind: "range" as const, start: 1, end: 4 }, text: "X" },
        { kind: "format-inline" as const, blockId: "a", scope: { kind: "range" as const, start: 2, end: 5 }, style: { bold: true } },
      ],
    ]) {
      const result = executeProposalOperations(base, operations);
      expect(result).toMatchObject({
        ok: false,
        code: "proposal_conflict",
        conflictingOperationIndexes: [0, 1],
        document: base,
      });
      expect(blockText(base.blocks[0])).toBe("abcdef");
    }
  });
});
