import { describe, expect, test } from "bun:test";
import { buildContextEnvelope, buildContextSummary } from "./context-summary";
import { createBlock, createTableBlock, type Block } from "@nautilo/office-docs/node";

function para(text: string): Block {
  const b = createBlock("paragraph");
  b.inlines = [{ text, style: {} }];
  return b;
}

function heading(text: string, level: 1 | 2 | 3): Block {
  const b = createBlock("heading", { headingLevel: level });
  b.inlines = [{ text, style: {} }];
  return b;
}

describe("writer context-summary", () => {
  test("builds compact outline with blockCount and dirty flag", () => {
    const blocks = [heading("Title", 1), para("Hello world"), para("Second")];
    const summary = buildContextSummary({
      document: { blocks },
      dirty: true,
    });
    expect(summary).toMatchObject({
      documentType: "document",
      blockCount: 3,
      dirty: true,
    });
    const outline = summary.outline as Array<{
      blockId: string;
      type: string;
      headingLevel?: number;
      text: string;
    }>;
    expect(outline).toHaveLength(3);
    expect(outline[0]).toMatchObject({ type: "heading", headingLevel: 1, text: "Title" });
    expect(outline[1]).toMatchObject({ type: "paragraph", text: "Hello world" });
    expect(outline[2]).toMatchObject({ type: "paragraph", text: "Second" });
    expect(outline.map((entry) => entry.blockId)).toEqual(blocks.map((block) => block.id));
    const serialized = JSON.stringify(summary);
    expect(serialized).toContain('"blockId":');
    expect(serialized).not.toContain('"id":');
  });

  test("truncates outline text to ~80 chars", () => {
    const longText = "B".repeat(200);
    const summary = buildContextSummary({
      document: { blocks: [para(longText)] },
      dirty: false,
    });
    const outline = summary.outline as Array<{ text: string }>;
    expect(outline[0]!.text.length).toBeLessThanOrEqual(81);
    expect(outline[0]!.text.endsWith("…")).toBe(true);
  });

  test("describes tables as discoverable containers without flattening cell text", () => {
    const table = createTableBlock(2, 2);
    table.id = "table-1";
    table.tableData!.rows[0]!.cells[0]!.blocks[0]!.inlines = [{ text: "First cell preview", style: {} }];
    table.tableData!.rows[0]!.cells[1]!.blocks[0]!.inlines = [{ text: "Must not be flattened", style: {} }];
    const summary = buildContextSummary({ document: { blocks: [table] }, dirty: false });
    const entry = summary.outline[0]!;
    expect(entry).toMatchObject({
      blockId: "table-1",
      type: "table",
      text: "Table (2 rows × 2 columns)",
      table: {
        rowCount: 2,
        columnCount: 2,
        cellCount: 4,
        preview: "First cell preview",
        readHint: "Use read-open-writer-range with this table blockId to discover editable cell blocks; follow any returned nextCursor.",
      },
    });
    expect(entry.text).not.toContain("First cell preview");
    expect(entry.text).not.toContain("Must not be flattened");
  });

  test("caps the outline at the first 30 blocks but reports full blockCount", () => {
    const blocks: Block[] = Array.from({ length: 40 }, (_, i) => para(`block ${i}`));
    const summary = buildContextSummary({
      document: { blocks },
      dirty: false,
    });
    expect(summary.blockCount).toBe(40);
    const outline = summary.outline as Array<{ text: string }>;
    expect(outline).toHaveLength(30);
    expect(outline[0]!.text).toBe("block 0");
    expect(outline[29]!.text).toBe("block 29");
    expect(summary.outlineContinuation).toEqual({
      returnedBlockCount: 30,
      truncated: true,
      nextBlockIndex: 30,
      readHint: "Use read-open-writer-range to continue from nextBlockIndex until the complete document has been inspected.",
    });
  });

  test("uses only Workbench-allowed top-level envelope fields", () => {
    const envelope = buildContextEnvelope({
      documentPath: "/workspace/notes.html",
      document: { blocks: [para("x")] },
      dirty: false,
      selection: { blockId: "b1" },
      liveSession: { sessionToken: "a".repeat(43), sessionId: "route-a", documentVersion: { kind: "artifact_revision", revision: 4 } },
    });

    // This mirrors normalizeAppContextSummary's accepted input shape: all
    // document details must remain in summary, while selection is top-level.
    expect(Object.keys(envelope).sort()).toEqual(["documentPath", "selection", "summary"]);
    expect(envelope.documentPath).toBe("/workspace/notes.html");
    expect(envelope.selection).toEqual({ blockId: "b1" });
    expect(envelope.summary).toMatchObject({
      documentType: "document",
      blockCount: 1,
      dirty: false,
      liveSession: { sessionToken: "a".repeat(43), sessionId: "route-a", documentVersion: { kind: "artifact_revision", revision: 4 } },
    });
    expect(envelope.summary).not.toHaveProperty("selection");
    expect(envelope.summary).not.toHaveProperty("documentPath");
    expect(envelope.summary).not.toHaveProperty("path");
    expect(envelope.summary.openDocumentWorkflow).toBe(
      "This document is open. For proofreading, rewrites, formatting, moves, or any change, use edit-open-writer only; it creates reviewable suggestions. Do not use path-targeted direct mutation tools.",
    );
  });

  test("handles empty document", () => {
    const summary = buildContextSummary({
      document: { blocks: [] },
      dirty: false,
    });
    expect(summary.blockCount).toBe(0);
    expect(summary.outline).toEqual([]);
    expect(summary.outlineContinuation).toEqual({
      returnedBlockCount: 0,
      truncated: false,
      readHint: "Use read-open-writer-range to continue from nextBlockIndex until the complete document has been inspected.",
    });
  });

  test("publishes the bearer needed by the tool plus the non-authorizing routing handle", () => {
    const envelope = buildContextEnvelope({
      document: { blocks: [para("x")] },
      dirty: false,
      liveSession: { sessionToken: "a".repeat(43), sessionId: "route-a", documentVersion: { kind: "artifact_revision", revision: 4 } },
    });

    expect(envelope.summary.liveSession).toEqual({
      sessionToken: "a".repeat(43),
      sessionId: "route-a",
      documentVersion: { kind: "artifact_revision", revision: 4 },
    });
    expect(JSON.stringify(envelope.summary.liveSession)).not.toContain("artifactId");
    expect(JSON.stringify(envelope.summary.liveSession)).not.toContain("path");
  });

  test("publishes the open-document workflow only for a live Writer session", () => {
    const summary = buildContextSummary({
      document: { blocks: [para("x")] },
      dirty: false,
    });

    expect(summary).not.toHaveProperty("liveSession");
    expect(summary).not.toHaveProperty("openDocumentWorkflow");
  });

  test("keeps the capped document summary below Workbench's 10k JSON field limit", () => {
    const summary = buildContextEnvelope({
      document: { blocks: Array.from({ length: 40 }, () => para("B".repeat(200))) },
      dirty: false,
    }).summary;

    expect(summary.outline).toHaveLength(30);
    expect(JSON.stringify(summary).length).toBeLessThan(10_000);
  });
});
