import { describe, expect, test } from "bun:test";
import {
  applyBlockStyle,
  deleteBlocks,
  deleteTable,
  deleteTableColumn,
  deleteTableRow,
  editOpenWriter,
  exportDocx,
  formatText,
  importDocx,
  indentBlocks,
  insertBlocks,
  insertTable,
  insertTableColumn,
  insertTableRow,
  inspectDocument,
  locateOpenWriterText,
  mergeTableCells,
  moveBlocks,
  outdentBlocks,
  readOpenWriterRange,
  replaceText,
  setBlockType,
  setTableCellStyle,
  splitTableCell,
  validateAppDocumentTarget,
  type ServerNautiloAppHost,
} from "./agent-tool-handlers";
import {
  createBlock,
  createTableBlock,
  getBlockText,
  type Block,
} from "@nautilo/office-docs/node";
import {
  createDefaultManifest,
  parseWriterHtml,
  serializeWriterHtml,
  type WafflebaseDocumentPayload,
} from "./office-document";
import { OFFICE_RUN_IMAGE_INDEX_PROP, TINY_PNG_DATA_URL, WRITER_IMAGE_OBJECT_CHAR } from "./docx-image";
import {
  deleteTableBlock as deleteCanonicalTableBlock,
  deleteTableColumn as deleteCanonicalTableColumn,
  deleteTableRow as deleteCanonicalTableRow,
  insertTableColumn as insertCanonicalTableColumn,
  insertTableRow as insertCanonicalTableRow,
  mergeTableCells as mergeCanonicalTableCells,
  setTableCellStyle as setCanonicalTableCellStyle,
  splitTableCell as splitCanonicalTableCell,
} from "./table-document-ops";
import { validateEditOpenWriterRequest } from "./proposal-contract";

function makeBlock(type: "paragraph" | "heading" | "list-item", text: string, opts?: {
  headingLevel?: 1 | 2 | 3;
  listKind?: "ordered" | "unordered";
  listLevel?: number;
}): Block {
  const block = createBlock(type, opts);
  block.inlines = [{ text, style: {} }];
  return block;
}

function seedDocument(blocks: Block[]): WafflebaseDocumentPayload {
  return { blocks };
}

function mockHost(
  overrides?: Partial<ServerNautiloAppHost["document"]>,
  officeOverrides?: Partial<ServerNautiloAppHost["office"]>,
): {
  host: ServerNautiloAppHost;
  getStore: () => string;
  setStore: (next: string) => void;
} {
  let content = serializeWriterHtml(createDefaultManifest(), seedDocument([
    makeBlock("heading", "Title", { headingLevel: 1 }),
    makeBlock("paragraph", "Hello world"),
    makeBlock("paragraph", "Second paragraph with foo"),
  ]));
  let baseSha256: string | null = "abc123";
  let baseRevision: number | null = 1;

  const document: ServerNautiloAppHost["document"] = {
    async read(target) {
      return {
        content,
        mimeType: "text/html",
        displayPath: target.surface === "workspace" ? `workspace:${target.path}` : target.relativePath,
        baseSha256,
        baseRevision,
      };
    },
    async write(_target, next, opts) {
      if (opts && opts.baseSha256 !== null && opts.baseSha256 !== baseSha256) {
        return { kind: "conflict", currentSha256: "newer-hash" };
      }
      content = next.content;
      baseSha256 = "saved-hash";
      baseRevision = 2;
      return { kind: "saved", sha256: "saved-hash", revision: 2 };
    },
    async createDocument(args) {
      content = args.content;
      return {
        ok: true,
        artifactPath: args.path,
        sha256: "created-hash",
        byteLength: new TextEncoder().encode(args.content).length,
      };
    },
    ...overrides,
  };

  const office: ServerNautiloAppHost["office"] = {
    async run(args) {
      return {
        ok: false,
        code: "NOT_IMPLEMENTED",
        message: `office.run stub invoked with ${JSON.stringify(args)}`,
      };
    },
    ...officeOverrides,
  };

  return {
    host: { document, office },
    getStore: () => content,
    setStore: (next) => {
      content = next;
    },
  };
}

describe("writer agent-tool-handlers", () => {
  test("reads a live table by table id without flattening cells and locates its discovered cell id", async () => {
    const table = createTableBlock(1, 2);
    table.id = "live-table";
    table.tableData!.rows[0]!.cells[0]!.blocks[0]!.id = "live-cell-a";
    table.tableData!.rows[0]!.cells[0]!.blocks[0]!.inlines = [{ text: "first cell target", style: {} }];
    table.tableData!.rows[0]!.cells[1]!.blocks[0]!.id = "live-cell-b";
    table.tableData!.rows[0]!.cells[1]!.blocks[0]!.inlines = [{ text: "second cell", style: {} }];
    const content = serializeWriterHtml(createDefaultManifest(), seedDocument([table]));
    const { host } = mockHost();
    const args = { sessionToken: "session", documentVersion: { kind: "artifact_revision", revision: 3 }, blockId: "live-table", __canonicalContent: content };

    const read = await readOpenWriterRange(args, { nautiloApp: host });
    expect(read).toMatchObject({
      ok: true,
      status: "table_read",
      table: {
        tableBlockId: "live-table",
        cells: [
          { rowIndex: 0, colIndex: 0, editable: true, blocks: [{ id: "live-cell-a", text: "first cell target" }] },
          { rowIndex: 0, colIndex: 1, editable: true, blocks: [{ id: "live-cell-b", text: "second cell" }] },
        ],
      },
    });
    expect(JSON.stringify(read)).not.toContain("first cell targetsecond cell");

    const located = await locateOpenWriterText(
      { ...args, blockId: "live-cell-a", target: "target" },
      { nautiloApp: host },
    );
    expect(located).toMatchObject({ ok: true, status: "locator_resolved", blockId: "live-cell-a", __range: { start: 11, end: 17 } });
    await expect(locateOpenWriterText(
      { ...args, blockId: "live-cell-a", target: "target", collapseTo: "start" },
      { nautiloApp: host },
    )).resolves.toMatchObject({ ok: true, __range: { start: 11, end: 11 } });
    await expect(locateOpenWriterText(
      { ...args, blockId: "live-cell-a", target: "target", collapseTo: "end" },
      { nautiloApp: host },
    )).resolves.toMatchObject({ ok: true, __range: { start: 17, end: 17 } });
    await expect(locateOpenWriterText(
      { ...args, blockId: "live-cell-a", target: "target", collapseTo: "middle" },
      { nautiloApp: host },
    )).resolves.toMatchObject({ ok: false, error: 'collapseTo must be "start" or "end"' });
  });

  test("keeps ordinary live paragraph range reads unchanged", async () => {
    const block = makeBlock("paragraph", "ordinary paragraph");
    block.id = "ordinary";
    const content = serializeWriterHtml(createDefaultManifest(), seedDocument([block]));
    const { host } = mockHost();
    await expect(readOpenWriterRange(
      { sessionToken: "session", documentVersion: { kind: "artifact_revision", revision: 3 }, blockId: "ordinary", __canonicalContent: content },
      { nautiloApp: host },
    )).resolves.toEqual({
      ok: true,
      status: "range_read",
      documentVersion: { kind: "artifact_revision", revision: 3 },
      blocks: [{ id: "ordinary", type: "paragraph", text: "ordinary paragraph" }],
    });
  });

  test("continues live table reads with only validated logical cursors", async () => {
    const table = createTableBlock(51, 1);
    table.id = "paged-table";
    for (let row = 0; row < 51; row++) {
      table.tableData!.rows[row]!.cells[0]!.blocks[0]!.inlines = [{ text: `row-${row}`, style: {} }];
    }
    const content = serializeWriterHtml(createDefaultManifest(), seedDocument([table]));
    const { host } = mockHost();
    const first = await readOpenWriterRange(
      { sessionToken: "session", documentVersion: { kind: "artifact_revision", revision: 3 }, blockId: "paged-table", __canonicalContent: content },
      { nautiloApp: host },
    );
    expect(first).toMatchObject({
      ok: true,
      status: "table_read",
      table: { nextCursor: { rowIndex: 50, colIndex: 0, blockIndex: 0, sliceIndex: 0 } },
    });
    if (!first.ok || first.status !== "table_read" || !first.table.nextCursor) throw new Error("expected table cursor");
    const second = await readOpenWriterRange(
      {
        sessionToken: "session",
        documentVersion: { kind: "artifact_revision", revision: 3 },
        blockId: "paged-table",
        tableCursor: first.table.nextCursor,
        __canonicalContent: content,
      },
      { nautiloApp: host },
    );
    expect(second).toMatchObject({
      ok: true,
      status: "table_read",
      table: { cells: [{ rowIndex: 50, colIndex: 0, blocks: [{ text: "row-50", textComplete: true }] }] },
    });
    await expect(readOpenWriterRange(
      {
        sessionToken: "session",
        documentVersion: { kind: "artifact_revision", revision: 3 },
        blockId: "paged-table",
        tableCursor: { rowIndex: 99, colIndex: 0, blockIndex: 0, sliceIndex: 0 },
        __canonicalContent: content,
      },
      { nautiloApp: host },
    )).resolves.toEqual({ ok: false, error: "tableCursor is invalid or stale for this canonical table" });
  });

  test("editOpenWriter returns a token-free proposal envelope with zero document access", async () => {
    let reads = 0;
    let writes = 0;
    const { host } = mockHost({
      async read(target) {
        reads += 1;
        throw new Error(`unexpected read: ${JSON.stringify(target)}`);
      },
      async write() {
        writes += 1;
        throw new Error("unexpected write");
      },
    });
    const result = await editOpenWriter(
      {
        sessionToken: "opaque-live-session-token",
        documentVersion: { kind: "artifact_revision", revision: 7 },
        operations: [{
          kind: "replace",
          blockId: "block-1",
          scope: { kind: "match", anchor: "fresh wording" },
          text: "new wording",
        }],
      },
      { nautiloApp: host },
    );
    expect(result).toEqual({
      ok: true,
      status: "proposal_ready",
      documentVersion: { kind: "artifact_revision", revision: 7 },
      operations: [{
        kind: "replace",
        blockId: "block-1",
        scope: { kind: "match", anchor: "fresh wording" },
        text: "new wording",
      }],
    });
    expect(JSON.stringify(result)).not.toContain("opaque-live-session-token");
    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });

  test("editOpenWriter rejects malformed or forbidden payloads without document access", async () => {
    let accesses = 0;
    const { host } = mockHost({
      async read() {
        accesses += 1;
        throw new Error("unexpected read");
      },
      async write() {
        accesses += 1;
        throw new Error("unexpected write");
      },
    });
    const result = await editOpenWriter(
      {
        sessionToken: "opaque-live-session-token",
        documentVersion: { kind: "artifact_revision", revision: 7 },
        operations: [{
          kind: "replace",
          blockId: "block-1",
          scope: { kind: "match", anchor: "fresh wording" },
          text: "new wording",
          oldString: "forbidden source text",
        }],
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({
      ok: false,
      status: "invalid_request",
      field: "operations[0].oldString",
    });
    expect(accesses).toBe(0);
  });

  test("validateAppDocumentTarget accepts workspace and currentFolder", () => {
    const ws = validateAppDocumentTarget({ surface: "workspace", path: "/doc.html" });
    expect(ws.ok).toBe(true);
    if (ws.ok) expect(ws.target).toEqual({ surface: "workspace", path: "/doc.html" });

    const cf = validateAppDocumentTarget({ surface: "currentFolder", relativePath: "doc.html" });
    expect(cf.ok).toBe(true);
    if (cf.ok) expect(cf.target).toEqual({ surface: "currentFolder", relativePath: "doc.html" });

    expect(validateAppDocumentTarget({ surface: "currentFolder", relativePath: "../escape" }).ok).toBe(false);
    expect(validateAppDocumentTarget({ surface: "bogus" }).ok).toBe(false);
    expect(validateAppDocumentTarget(null).ok).toBe(false);
  });

  test("inspectDocument returns outline without leaking the raw container", async () => {
    const { host } = mockHost();
    const result = await inspectDocument(
      { target: { surface: "workspace", path: "doc.html" } },
      { nautiloApp: host },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.displayPath).toBe("workspace:doc.html");
    expect(result.blockCount).toBe(3);
    expect(result.outline).toHaveLength(3);
    expect(result.outline[0]).toMatchObject({ index: 0, type: "heading", headingLevel: 1, text: "Title" });
    expect(result.outline[1]).toMatchObject({ index: 1, type: "paragraph", text: "Hello world" });
    expect(result.outline[2]).toMatchObject({ index: 2, type: "paragraph", text: "Second paragraph with foo" });
    const json = JSON.stringify(result);
    expect(json).not.toContain("<!DOCTYPE html>");
    expect(json).not.toContain("wafflebase-document");
  });

  test("inspectDocument truncates long block text to ~200 chars", async () => {
    const longText = "A".repeat(500);
    const { host, setStore } = mockHost();
    setStore(
      serializeWriterHtml(createDefaultManifest(), seedDocument([
        makeBlock("paragraph", longText),
      ])),
    );
    const result = await inspectDocument(
      { target: { surface: "workspace", path: "doc.html" } },
      { nautiloApp: host },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outline[0]!.text.length).toBeLessThanOrEqual(201);
    expect(result.outline[0]!.text.endsWith("…")).toBe(true);
  });

  test("insertBlocks appends when afterBlockId is omitted", async () => {
    const { host, getStore } = mockHost();
    const result = await insertBlocks(
      {
        target: { surface: "workspace", path: "doc.html" },
        blocks: [{ type: "paragraph", text: "Appended paragraph" }],
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({
      ok: true,
      status: "saved",
      insertedCount: 1,
      sha256: "saved-hash",
    });
    if (!("ok" in result) || !result.ok) return;
    const parsed = parseWriterHtml(getStore());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const blocks = parsed.document.document.blocks as Block[];
    expect(blocks).toHaveLength(4);
    expect(getBlockText(blocks[3]!)).toBe("Appended paragraph");
  });

  test("insertBlocks inserts after the block matching afterBlockId", async () => {
    const { host, getStore } = mockHost();
    // First, find the id of the heading block via inspect.
    const inspect = await inspectDocument(
      { target: { surface: "workspace", path: "doc.html" } },
      { nautiloApp: host },
    );
    expect(inspect.ok).toBe(true);
    if (!inspect.ok) return;

    // Re-parse to grab the actual id of the heading block.
    const initial = parseWriterHtml(getStore());
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const initialBlocks = initial.document.document.blocks as Block[];
    const headingId = initialBlocks[0]!.id;

    const result = await insertBlocks(
      {
        target: { surface: "workspace", path: "doc.html" },
        afterBlockId: headingId,
        blocks: [
          { type: "heading", text: "Section", headingLevel: 2 },
          { type: "list-item", text: "First item", listKind: "ordered", listLevel: 0 },
        ],
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", insertedCount: 2 });
    const parsed = parseWriterHtml(getStore());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const blocks = parsed.document.document.blocks as Block[];
    expect(blocks).toHaveLength(5);
    expect(blocks[1]!.type).toBe("heading");
    expect(getBlockText(blocks[1]!)).toBe("Section");
    expect((blocks[1]! as { headingLevel?: number }).headingLevel).toBe(2);
    expect(blocks[2]!.type).toBe("list-item");
    expect(getBlockText(blocks[2]!)).toBe("First item");
    expect((blocks[2]! as { listKind?: string }).listKind).toBe("ordered");
  });

  test("insertBlocks falls back to append when afterBlockId is not found", async () => {
    const { host, getStore } = mockHost();
    const result = await insertBlocks(
      {
        target: { surface: "workspace", path: "doc.html" },
        afterBlockId: "does-not-exist",
        blocks: [{ type: "paragraph", text: "Tail" }],
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved" });
    const parsed = parseWriterHtml(getStore());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const blocks = parsed.document.document.blocks as Block[];
    expect(getBlockText(blocks[blocks.length - 1]!)).toBe("Tail");
  });

  test("insertBlocks rejects oversized batches and long text", async () => {
    const { host } = mockHost();
    const tooMany = await insertBlocks(
      {
        target: { surface: "workspace", path: "doc.html" },
        blocks: Array.from({ length: 101 }, () => ({ type: "paragraph" as const, text: "x" })),
      },
      { nautiloApp: host },
    );
    expect(tooMany).toEqual({ ok: false, error: expect.stringContaining("maximum") });

    const tooLong = await insertBlocks(
      {
        target: { surface: "workspace", path: "doc.html" },
        blocks: [{ type: "paragraph", text: "A".repeat(20_001) }],
      },
      { nautiloApp: host },
    );
    expect(tooLong).toEqual({ ok: false, error: expect.stringContaining("maximum") });

    const badType = await insertBlocks(
      {
        target: { surface: "workspace", path: "doc.html" },
        blocks: [{ type: "table" as never, text: "x" }],
      },
      { nautiloApp: host },
    );
    expect(badType).toEqual({ ok: false, error: expect.stringContaining("type must be") });
  });

  test("insertBlocks propagates write conflicts", async () => {
    const { host } = mockHost({
      async write() {
        return { kind: "conflict", currentSha256: "newer-hash" };
      },
    });
    const result = await insertBlocks(
      {
        target: { surface: "workspace", path: "doc.html" },
        blocks: [{ type: "paragraph", text: "x" }],
      },
      { nautiloApp: host },
    );
    expect(result).toEqual({
      ok: true,
      status: "conflict",
      displayPath: "workspace:doc.html",
      currentSha256: "newer-hash",
    });
  });

  test("insertBlocks surfaces host write errors", async () => {
    const { host } = mockHost({
      async write() {
        return { kind: "error", message: "disk full" };
      },
    });
    const result = await insertBlocks(
      {
        target: { surface: "workspace", path: "doc.html" },
        blocks: [{ type: "paragraph", text: "x" }],
      },
      { nautiloApp: host },
    );
    expect(result).toEqual({
      ok: true,
      status: "error",
      displayPath: "workspace:doc.html",
      message: "disk full",
    });
  });

  test("replaceText replaces the first occurrence only by default", async () => {
    const { host, getStore, setStore } = mockHost();
    setStore(
      serializeWriterHtml(createDefaultManifest(), seedDocument([
        makeBlock("paragraph", "foo foo foo"),
        makeBlock("paragraph", "untouched foo"),
      ])),
    );
    const result = await replaceText(
      {
        target: { surface: "workspace", path: "doc.html" },
        oldString: "foo",
        newString: "bar",
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", matched: 1 });
    const parsed = parseWriterHtml(getStore());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const blocks = parsed.document.document.blocks as Block[];
    expect(getBlockText(blocks[0]!)).toBe("bar foo foo");
    expect(getBlockText(blocks[1]!)).toBe("untouched foo");
  });

  test("replaceText replaces all occurrences when replaceAll is true", async () => {
    const { host, getStore, setStore } = mockHost();
    setStore(
      serializeWriterHtml(createDefaultManifest(), seedDocument([
        makeBlock("paragraph", "foo foo foo"),
        makeBlock("paragraph", "untouched foo"),
      ])),
    );
    const result = await replaceText(
      {
        target: { surface: "workspace", path: "doc.html" },
        oldString: "foo",
        newString: "bar",
        replaceAll: true,
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", matched: 4 });
    const parsed = parseWriterHtml(getStore());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const blocks = parsed.document.document.blocks as Block[];
    expect(getBlockText(blocks[0]!)).toBe("bar bar bar");
    expect(getBlockText(blocks[1]!)).toBe("untouched bar");
  });

  test("replaceText returns not_found when nothing matches", async () => {
    const { host } = mockHost();
    const result = await replaceText(
      {
        target: { surface: "workspace", path: "doc.html" },
        oldString: "zzzznotpresent",
        newString: "whatever",
      },
      { nautiloApp: host },
    );
    expect(result).toEqual({
      ok: true,
      status: "not_found",
      displayPath: "workspace:doc.html",
    });
  });

  test("replaceText rejects empty oldString", async () => {
    const { host } = mockHost();
    const result = await replaceText(
      {
        target: { surface: "workspace", path: "doc.html" },
        oldString: "",
        newString: "x",
      },
      { nautiloApp: host },
    );
    expect(result).toEqual({ ok: false, error: expect.stringContaining("non-empty") });
  });

  test("replaceText propagates conflicts", async () => {
    const { host } = mockHost({
      async write() {
        return { kind: "conflict", currentSha256: "newer-hash" };
      },
    });
    const result = await replaceText(
      {
        target: { surface: "workspace", path: "doc.html" },
        oldString: "foo",
        newString: "bar",
      },
      { nautiloApp: host },
    );
    expect(result).toEqual({
      ok: true,
      status: "conflict",
      displayPath: "workspace:doc.html",
      currentSha256: "newer-hash",
    });
  });

  // -------------------------------------------------------------------------
  // New D372 tools: set-block-type, apply-block-style, format-text,
  // delete-blocks, move-blocks, insert-table.
  // -------------------------------------------------------------------------

  function firstBlockId(blocks: Block[]): string {
    if (blocks.length === 0) throw new Error("no blocks");
    return blocks[0]!.id;
  }

  test("inspectDocument outline now includes block ids", async () => {
    const { host } = mockHost();
    const result = await inspectDocument(
      { target: { surface: "workspace", path: "doc.html" } },
      { nautiloApp: host },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const entry of result.outline) {
      expect(typeof entry.id).toBe("string");
      expect(entry.id!.length).toBeGreaterThan(0);
    }
  });

  test("setBlockType converts paragraph → heading with default level 1", async () => {
    const { host, getStore } = mockHost();
    const initial = parseWriterHtml(getStore());
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const paraId = (initial.document.document.blocks as Block[])[1]!.id;
    const result = await setBlockType(
      { target: { surface: "workspace", path: "doc.html" }, blockId: paraId, toType: "heading" },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", blockId: paraId, toType: "heading" });
    const parsed = parseWriterHtml(getStore());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const blocks = parsed.document.document.blocks as Block[];
    expect(blocks[1]!.type).toBe("heading");
    expect((blocks[1]! as { headingLevel?: number }).headingLevel).toBe(1);
    // Text content is preserved.
    expect(getBlockText(blocks[1]!)).toBe("Hello world");
    // Original id is preserved.
    expect(blocks[1]!.id).toBe(paraId);
  });

  test("setBlockType converts heading → list-item and clears headingLevel", async () => {
    const { host, getStore } = mockHost();
    const initial = parseWriterHtml(getStore());
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const headingId = (initial.document.document.blocks as Block[])[0]!.id;
    const result = await setBlockType(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId: headingId,
        toType: "list-item",
        listKind: "ordered",
        listLevel: 2,
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved" });
    const parsed = parseWriterHtml(getStore());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const block = (parsed.document.document.blocks as Block[])[0]!;
    expect(block.type).toBe("list-item");
    expect(block.listKind).toBe("ordered");
    expect(block.listLevel).toBe(2);
    expect((block as { headingLevel?: number }).headingLevel).toBeUndefined();
  });

  test("setBlockType rejects converting to heading with listKind", async () => {
    const { host } = mockHost();
    const result = await setBlockType(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId: "whatever",
        toType: "heading",
        listKind: "ordered",
      },
      { nautiloApp: host },
    );
    expect(result).toEqual({ ok: false, error: expect.stringContaining("listKind is not valid") });
  });

  test("setBlockType returns not_found when blockId is missing", async () => {
    const { host } = mockHost();
    const result = await setBlockType(
      { target: { surface: "workspace", path: "doc.html" }, blockId: "missing", toType: "paragraph" },
      { nautiloApp: host },
    );
    expect(result).toEqual({ ok: true, status: "not_found", displayPath: "workspace:doc.html" });
  });

  test("applyBlockStyle updates alignment and lineHeight, preserves other fields", async () => {
    const { host, getStore } = mockHost();
    const initial = parseWriterHtml(getStore());
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const blockId = firstBlockId(initial.document.document.blocks as Block[]);
    const result = await applyBlockStyle(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId,
        style: { alignment: "center", lineHeight: 2 },
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", blockId });
    const parsed = parseWriterHtml(getStore());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const block = (parsed.document.document.blocks as Block[])[0]!;
    expect(block.style.alignment).toBe("center");
    expect(block.style.lineHeight).toBe(2);
    // Untouched fields stay at their defaults.
    expect(block.style.marginBottom).toBe(8);
  });

  test("applyBlockStyle rejects out-of-range numbers", async () => {
    const { host } = mockHost();
    const result = await applyBlockStyle(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId: "x",
        style: { marginTop: -1 },
      },
      { nautiloApp: host },
    );
    expect(result).toEqual({ ok: false, error: expect.stringContaining("marginTop") });
  });

  test("formatText applies bold to a [from, to) range", async () => {
    const { host, getStore } = mockHost();
    const initial = parseWriterHtml(getStore());
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const blockId = (initial.document.document.blocks as Block[])[1]!.id; // "Hello world"
    const result = await formatText(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId,
        from: 0,
        to: 5,
        style: { bold: true },
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", matched: 1 });
    const parsed = parseWriterHtml(getStore());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const block = (parsed.document.document.blocks as Block[])[1]!;
    expect(block.inlines[0]!.text).toBe("Hello");
    expect(block.inlines[0]!.style.bold).toBe(true);
    expect(block.inlines[1]!.text).toBe(" world");
    expect(block.inlines[1]!.style.bold).toBeUndefined();
  });

  test("formatText with to omitted extends to end of block", async () => {
    const { host, getStore } = mockHost();
    const initial = parseWriterHtml(getStore());
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const blockId = (initial.document.document.blocks as Block[])[1]!.id;
    await formatText(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId,
        from: 6,
        style: { italic: true, color: "#ff0000" },
      },
      { nautiloApp: host },
    );
    const parsed = parseWriterHtml(getStore());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const block = (parsed.document.document.blocks as Block[])[1]!;
    const tail = block.inlines.at(-1)!;
    expect(tail.style.italic).toBe(true);
    expect(tail.style.color).toBe("#ff0000");
  });

  test("formatText with clear=true strips character formatting", async () => {
    const { host, getStore } = mockHost();
    const initial = parseWriterHtml(getStore());
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const blockId = (initial.document.document.blocks as Block[])[1]!.id;
    await formatText(
      { target: { surface: "workspace", path: "doc.html" }, blockId, from: 0, to: 5, style: { bold: true } },
      { nautiloApp: host },
    );
    await formatText(
      { target: { surface: "workspace", path: "doc.html" }, blockId, from: 0, to: 5, style: { clear: true } },
      { nautiloApp: host },
    );
    const parsed = parseWriterHtml(getStore());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const block = (parsed.document.document.blocks as Block[])[1]!;
    expect(getBlockText(block)).toBe("Hello world");
    for (const inline of block.inlines) {
      expect(inline.style.bold).toBeUndefined();
    }
  });

  test("formatText returns not_found for an empty range", async () => {
    const { host, getStore } = mockHost();
    const initial = parseWriterHtml(getStore());
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const blockId = (initial.document.document.blocks as Block[])[1]!.id;
    const result = await formatText(
      { target: { surface: "workspace", path: "doc.html" }, blockId, from: 3, to: 3, style: { bold: true } },
      { nautiloApp: host },
    );
    expect(result).toEqual({ ok: true, status: "not_found", displayPath: "workspace:doc.html" });
  });

  test("formatText rejects invalid color and fontSize", async () => {
    const { host } = mockHost();
    const badColor = await formatText(
      { target: { surface: "workspace", path: "doc.html" }, blockId: "x", from: 0, style: { color: "red" } },
      { nautiloApp: host },
    );
    expect(badColor).toEqual({ ok: false, error: expect.stringContaining("color") });
    const badSize = await formatText(
      { target: { surface: "workspace", path: "doc.html" }, blockId: "x", from: 0, style: { fontSize: 0 } },
      { nautiloApp: host },
    );
    expect(badSize).toEqual({ ok: false, error: expect.stringContaining("fontSize") });
  });

  test("live and closed inline/block paths accept and reject the same shared styles", async () => {
    const inlineValid = { bold: true, fontSize: 18, fontFamily: "Inter", color: "#1234", href: "https://example.com" };
    const inlineInvalid = { bold: true, fontSize: Number.POSITIVE_INFINITY, arbitrary: "value" };
    const blockValid = { alignment: "center" as const, lineHeight: 2, marginTop: 4, marginLeft: 36 };
    const blockInvalid = { alignment: "start", marginTop: Number.NaN, arbitrary: 1 };
    const live = (operation: object) => validateEditOpenWriterRequest({
      sessionToken: "opaque-session-token",
      baseRevision: 0,
      operations: [operation],
    });

    expect(live({ kind: "format-inline", blockId: "b1", scope: { kind: "block" }, style: inlineValid }).ok).toBe(true);
    expect(live({ kind: "format-inline", blockId: "b1", scope: { kind: "block" }, style: inlineInvalid }).ok).toBe(false);
    expect(live({ kind: "format-block", blockId: "b1", scope: { kind: "block" }, style: blockValid }).ok).toBe(true);
    expect(live({ kind: "format-block", blockId: "b1", scope: { kind: "block" }, style: blockInvalid }).ok).toBe(false);

    const { host, getStore } = mockHost();
    const parsed = parseWriterHtml(getStore());
    if (!parsed.ok) throw new Error("seed parse failed");
    const blockId = firstBlockId(parsed.document.document.blocks as Block[]);
    expect(await formatText(
      { target: { surface: "workspace", path: "doc.html" }, blockId, from: 0, style: inlineValid },
      { nautiloApp: host },
    )).toMatchObject({ ok: true });
    expect(await formatText(
      { target: { surface: "workspace", path: "doc.html" }, blockId, from: 0, style: inlineInvalid as never },
      { nautiloApp: host },
    )).toMatchObject({ ok: false });
    expect(await applyBlockStyle(
      { target: { surface: "workspace", path: "doc.html" }, blockId, style: blockValid },
      { nautiloApp: host },
    )).toMatchObject({ ok: true });
    expect(await applyBlockStyle(
      { target: { surface: "workspace", path: "doc.html" }, blockId, style: blockInvalid as never },
      { nautiloApp: host },
    )).toMatchObject({ ok: false });
  });

  test("deleteBlocks removes the listed blocks and returns deletedCount", async () => {
    const { host, getStore } = mockHost();
    const initial = parseWriterHtml(getStore());
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const blocks = initial.document.document.blocks as Block[];
    const a = blocks[0]!.id;
    const c = blocks[2]!.id;
    const result = await deleteBlocks(
      { target: { surface: "workspace", path: "doc.html" }, blockIds: [a, c] },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", deletedCount: 2 });
    const parsed = parseWriterHtml(getStore());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const remaining = parsed.document.document.blocks as Block[];
    expect(remaining).toHaveLength(1);
    expect(getBlockText(remaining[0]!)).toBe("Hello world");
  });

  test("deleteBlocks returns not_found when no ids match", async () => {
    const { host } = mockHost();
    const result = await deleteBlocks(
      { target: { surface: "workspace", path: "doc.html" }, blockIds: ["nope1", "nope2"] },
      { nautiloApp: host },
    );
    expect(result).toEqual({ ok: true, status: "not_found", displayPath: "workspace:doc.html" });
  });

  test("deleteBlocks rejects empty arrays and duplicates", async () => {
    const { host } = mockHost();
    const empty = await deleteBlocks(
      { target: { surface: "workspace", path: "doc.html" }, blockIds: [] },
      { nautiloApp: host },
    );
    expect(empty).toEqual({ ok: false, error: expect.stringContaining("at least one") });
    const dup = await deleteBlocks(
      { target: { surface: "workspace", path: "doc.html" }, blockIds: ["x", "x"] },
      { nautiloApp: host },
    );
    expect(dup).toEqual({ ok: false, error: expect.stringContaining("duplicated") });
  });

  test("moveBlocks moves a block to the end, preserving document order of the moved set", async () => {
    const { host, getStore } = mockHost();
    const initial = parseWriterHtml(getStore());
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const blocks = initial.document.document.blocks as Block[];
    const headingId = blocks[0]!.id; // "Title"
    const result = await moveBlocks(
      { target: { surface: "workspace", path: "doc.html" }, blockIds: [headingId], position: "end" },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", movedCount: 1 });
    const parsed = parseWriterHtml(getStore());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const after = parsed.document.document.blocks as Block[];
    expect(after).toHaveLength(3);
    expect(getBlockText(after[2]!)).toBe("Title");
  });

  test("moveBlocks moves multiple blocks to after a target block", async () => {
    const { host, getStore } = mockHost();
    const initial = parseWriterHtml(getStore());
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const blocks = initial.document.document.blocks as Block[];
    const headingId = blocks[0]!.id;
    const lastId = blocks[2]!.id;
    const result = await moveBlocks(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockIds: [lastId, headingId], // supplied in reverse order
        position: "after",
        afterBlockId: blocks[1]!.id,
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", movedCount: 2 });
    const parsed = parseWriterHtml(getStore());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const after = parsed.document.document.blocks as Block[];
    // Original was: [Title, Hello world, Second paragraph with foo]
    // After moving Title and Second to after Hello world (preserving doc order):
    // [Hello world, Title, Second paragraph with foo]
    expect(getBlockText(after[0]!)).toBe("Hello world");
    expect(getBlockText(after[1]!)).toBe("Title");
    expect(getBlockText(after[2]!)).toBe("Second paragraph with foo");
  });

  test("moveBlocks rejects afterBlockId that is also being moved", async () => {
    const { host } = mockHost();
    const result = await moveBlocks(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockIds: ["a", "b"],
        position: "after",
        afterBlockId: "a",
      },
      { nautiloApp: host },
    );
    expect(result).toEqual({ ok: false, error: expect.stringContaining("cannot be one of") });
  });

  test("moveBlocks returns toolError when afterBlockId not found", async () => {
    const { host, getStore } = mockHost();
    const initial = parseWriterHtml(getStore());
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const blockId = firstBlockId(initial.document.document.blocks as Block[]);
    const result = await moveBlocks(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockIds: [blockId],
        position: "after",
        afterBlockId: "missing",
      },
      { nautiloApp: host },
    );
    expect(result).toEqual({ ok: false, error: expect.stringContaining("afterBlockId") });
  });

  test("insertTable appends a 2x3 table block and returns its blockId", async () => {
    const { host, getStore } = mockHost();
    const result = await insertTable(
      { target: { surface: "workspace", path: "doc.html" }, rows: 2, cols: 3 },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", insertedCount: 1 });
    if (!("ok" in result) || !result.ok) return;
    expect(typeof result.blockId).toBe("string");
    const parsed = parseWriterHtml(getStore());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const blocks = parsed.document.document.blocks as Block[];
    expect(blocks).toHaveLength(4);
    const table = blocks[3]!;
    expect(table.type).toBe("table");
    expect(table.tableData?.rows).toHaveLength(2);
    expect(table.tableData?.columnWidths).toHaveLength(3);
    expect(table.id).toBe(result.blockId);
  });

  test("insertTable saves all cell text in one canonical write", async () => {
    const { host, getStore } = mockHost();
    const cells = [["North", "South"], ["East", "West"]];
    const result = await insertTable(
      { target: { surface: "workspace", path: "doc.html" }, rows: 2, cols: 2, cells },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ status: "saved" });
    const parsed = parseWriterHtml(getStore());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const table = (parsed.document.document.blocks as Block[]).at(-1)!;
    expect(table.tableData?.rows.map(row => row.cells.map(cell => cell.blocks.map(getBlockText).join("\n")))).toEqual(cells);
  });

  test("insertTable rejects incomplete cell matrices before reading or writing", async () => {
    const { host, getStore } = mockHost({ read: async () => { throw new Error("must validate before reading"); } });
    const before = getStore();
    for (const cells of [[], [["North"]], [["North", "South"], ["East"]]]) {
      expect(await insertTable(
        { target: { surface: "workspace", path: "doc.html" }, rows: 2, cols: 2, cells },
        { nautiloApp: host },
      )).toEqual({ ok: false, error: "cells must contain exactly rows arrays of cols strings" });
      expect(getStore()).toBe(before);
    }
  });

  test("insertTable inserts after a given block id", async () => {
    const { host, getStore } = mockHost();
    const initial = parseWriterHtml(getStore());
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const headingId = (initial.document.document.blocks as Block[])[0]!.id;
    const result = await insertTable(
      { target: { surface: "workspace", path: "doc.html" }, afterBlockId: headingId, rows: 1, cols: 2 },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved" });
    const parsed = parseWriterHtml(getStore());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const blocks = parsed.document.document.blocks as Block[];
    expect(blocks[1]!.type).toBe("table");
    expect(blocks[1]!.tableData?.rows).toHaveLength(1);
    expect(blocks[1]!.tableData?.columnWidths).toHaveLength(2);
  });

  test("insertTable rejects oversized dimensions", async () => {
    const { host } = mockHost();
    const tooManyCols = await insertTable(
      { target: { surface: "workspace", path: "doc.html" }, rows: 1, cols: 21 },
      { nautiloApp: host },
    );
    expect(tooManyCols).toEqual({ ok: false, error: expect.stringContaining("cols") });
    const zeroRows = await insertTable(
      { target: { surface: "workspace", path: "doc.html" }, rows: 0, cols: 1 },
      { nautiloApp: host },
    );
    expect(zeroRows).toEqual({ ok: false, error: expect.stringContaining("rows") });
  });

  test("all new write tools propagate conflicts", async () => {
    const conflictHost = mockHost({
      async write() {
        return { kind: "conflict", currentSha256: "newer-hash" };
      },
    }).host;
    const inspect = await inspectDocument(
      { target: { surface: "workspace", path: "doc.html" } },
      { nautiloApp: conflictHost },
    );
    expect(inspect.ok).toBe(true);
    if (!inspect.ok) return;
    const blockId = inspect.outline[0]!.id;

    const s = await setBlockType(
      { target: { surface: "workspace", path: "doc.html" }, blockId, toType: "heading" },
      { nautiloApp: conflictHost },
    );
    expect(s).toEqual({ ok: true, status: "conflict", displayPath: "workspace:doc.html", currentSha256: "newer-hash" });

    const a = await applyBlockStyle(
      { target: { surface: "workspace", path: "doc.html" }, blockId, style: { alignment: "right" } },
      { nautiloApp: conflictHost },
    );
    expect(a).toEqual({ ok: true, status: "conflict", displayPath: "workspace:doc.html", currentSha256: "newer-hash" });

    const f = await formatText(
      { target: { surface: "workspace", path: "doc.html" }, blockId, from: 0, style: { bold: true } },
      { nautiloApp: conflictHost },
    );
    expect(f).toEqual({ ok: true, status: "conflict", displayPath: "workspace:doc.html", currentSha256: "newer-hash" });

    const d = await deleteBlocks(
      { target: { surface: "workspace", path: "doc.html" }, blockIds: [blockId] },
      { nautiloApp: conflictHost },
    );
    expect(d).toEqual({ ok: true, status: "conflict", displayPath: "workspace:doc.html", currentSha256: "newer-hash" });

    const m = await moveBlocks(
      { target: { surface: "workspace", path: "doc.html" }, blockIds: [blockId], position: "start" },
      { nautiloApp: conflictHost },
    );
    expect(m).toEqual({ ok: true, status: "conflict", displayPath: "workspace:doc.html", currentSha256: "newer-hash" });

    const t = await insertTable(
      { target: { surface: "workspace", path: "doc.html" }, rows: 1, cols: 1 },
      { nautiloApp: conflictHost },
    );
    expect(t).toEqual({ ok: true, status: "conflict", displayPath: "workspace:doc.html", currentSha256: "newer-hash" });
  });

  // -------------------------------------------------------------------------
  // D372 parity tools: insert/delete table row/column, merge/split, cell
  // style, delete-table, indent/outdent.
  // -------------------------------------------------------------------------

  function makeTableBlock(rows: number, cols: number): Block {
    return createTableBlock(rows, cols);
  }

  function seedWithBlocks(blocks: Block[]): { host: ServerNautiloAppHost; getStore: () => string } {
    const { host, getStore, setStore } = mockHost();
    setStore(serializeWriterHtml(createDefaultManifest(), seedDocument(blocks)));
    return { host, getStore };
  }

  function findTableBlockId(blocks: Block[]): string {
    const t = blocks.find((b) => b.type === "table");
    if (!t) throw new Error("no table block in seeded doc");
    return t.id;
  }

  function fillCell(table: Block, r: number, c: number, text: string): void {
    const cell = table.tableData!.rows[r]!.cells[c]!;
    cell.blocks = [{
      id: cell.blocks[0]?.id ?? "cell-block",
      type: "paragraph",
      inlines: [{ text, style: {} }],
      style: cell.blocks[0]?.style ?? { alignment: "left", lineHeight: 1.5, marginTop: 0, marginBottom: 8, textIndent: 0, marginLeft: 0 },
    }];
  }

  function tableShape(table: Block): unknown {
    return table.tableData && {
      columnWidths: table.tableData.columnWidths,
      rows: table.tableData.rows.map((row) => ({
        cells: row.cells.map((cell) => ({
          colSpan: cell.colSpan,
          rowSpan: cell.rowSpan,
          style: cell.style,
          blocks: cell.blocks.map((block) => ({
            type: block.type,
            text: getBlockText(block),
            style: block.style,
          })),
        })),
      })),
    };
  }

  function storedTable(getStore: () => string, tableId: string): Block {
    const parsed = parseWriterHtml(getStore());
    if (!parsed.ok) throw new Error("reparse failed");
    const table = (parsed.document.document.blocks as Block[]).find((block) => block.id === tableId);
    if (!table) throw new Error("stored table missing");
    return table;
  }

  test("closed structural handlers match canonical merge-boundary successes and failures", async () => {
    function mergedParityTable(): Block {
      const table = makeTableBlock(4, 4);
      table.id = "parity-structure";
      const merged = mergeCanonicalTableCells(
        table.tableData!,
        { rowIndex: 1, colIndex: 1 },
        { rowIndex: 2, colIndex: 2 },
      );
      if (!merged.ok) throw new Error(merged.message);
      table.tableData = merged.tableData;
      return table;
    }

    {
      const table = mergedParityTable();
      const { host, getStore } = seedWithBlocks([table]);
      const source = storedTable(getStore, table.id).tableData!;
      const pure = insertCanonicalTableRow(source, 1);
      const closed = await insertTableRow(
        { target: { surface: "workspace", path: "doc.html" }, blockId: table.id, rowIndex: 1 },
        { nautiloApp: host },
      );
      expect(pure).toMatchObject({ ok: true });
      expect(closed).toMatchObject({ ok: true, status: "saved" });
      if (pure.ok) expect(tableShape(storedTable(getStore, table.id))).toEqual(tableShape({ ...table, tableData: pure.tableData }));
    }

    for (const [kind, pure, invoke] of [
      [
        "row insertion inside",
        (source: NonNullable<Block["tableData"]>) => insertCanonicalTableRow(source, 2),
        (host: ServerNautiloAppHost, blockId: string) => insertTableRow(
          { target: { surface: "workspace" as const, path: "doc.html" }, blockId, rowIndex: 2 },
          { nautiloApp: host },
        ),
      ],
      [
        "row anchor deletion",
        (source: NonNullable<Block["tableData"]>) => deleteCanonicalTableRow(source, 1),
        (host: ServerNautiloAppHost, blockId: string) => deleteTableRow(
          { target: { surface: "workspace" as const, path: "doc.html" }, blockId, rowIndex: 1 },
          { nautiloApp: host },
        ),
      ],
      [
        "covered column deletion",
        (source: NonNullable<Block["tableData"]>) => deleteCanonicalTableColumn(source, 2),
        (host: ServerNautiloAppHost, blockId: string) => deleteTableColumn(
          { target: { surface: "workspace" as const, path: "doc.html" }, blockId, colIndex: 2 },
          { nautiloApp: host },
        ),
      ],
      [
        "column insertion inside",
        (source: NonNullable<Block["tableData"]>) => insertCanonicalTableColumn(source, 2),
        (host: ServerNautiloAppHost, blockId: string) => insertTableColumn(
          { target: { surface: "workspace" as const, path: "doc.html" }, blockId, colIndex: 2 },
          { nautiloApp: host },
        ),
      ],
    ] as const) {
      const table = mergedParityTable();
      const { host, getStore } = seedWithBlocks([table]);
      const source = storedTable(getStore, table.id).tableData!;
      const pureResult = pure(source);
      const closedResult = await invoke(host, table.id);
      expect(pureResult, kind).toMatchObject({ ok: false });
      if (pureResult.ok) continue;
      expect(closedResult, kind).toEqual({ ok: false, error: pureResult.message });
      expect(tableShape(storedTable(getStore, table.id)), kind).toEqual(tableShape(table));
    }
  });

  test("closed merge, split, and style mutations match canonical live operations and reject covered cells", async () => {
    const table = makeTableBlock(2, 2);
    table.id = "parity-merge";
    fillCell(table, 0, 0, "A");
    fillCell(table, 0, 1, "B");
    const { host, getStore } = seedWithBlocks([table]);
    const source = storedTable(getStore, table.id).tableData!;
    const pureMerged = mergeCanonicalTableCells(source, { rowIndex: 0, colIndex: 0 }, { rowIndex: 1, colIndex: 1 });
    const closedMerged = await mergeTableCells(
      { target: { surface: "workspace", path: "doc.html" }, blockId: table.id, start: { rowIndex: 0, colIndex: 0 }, end: { rowIndex: 1, colIndex: 1 } },
      { nautiloApp: host },
    );
    expect(closedMerged).toMatchObject({ ok: true, status: "saved" });
    if (!pureMerged.ok) return;
    expect(tableShape(storedTable(getStore, table.id))).toEqual(tableShape({ ...table, tableData: pureMerged.tableData }));

    const pureCoveredStyle = setCanonicalTableCellStyle(pureMerged.tableData, { rowIndex: 1, colIndex: 1 }, { padding: 8 });
    const closedCoveredStyle = await setTableCellStyle(
      { target: { surface: "workspace", path: "doc.html" }, blockId: table.id, rowIndex: 1, colIndex: 1, style: { padding: 8 } },
      { nautiloApp: host },
    );
    expect(pureCoveredStyle).toMatchObject({ ok: false });
    expect(closedCoveredStyle).toEqual({ ok: false, error: expect.stringContaining("covered by a merge") });

    const pureSplit = splitCanonicalTableCell(pureMerged.tableData, { rowIndex: 0, colIndex: 0 });
    const closedSplit = await splitTableCell(
      { target: { surface: "workspace", path: "doc.html" }, blockId: table.id, rowIndex: 0, colIndex: 0 },
      { nautiloApp: host },
    );
    expect(closedSplit).toMatchObject({ ok: true, status: "saved" });
    if (!pureSplit.ok) return;
    expect(tableShape(storedTable(getStore, table.id))).toEqual(tableShape({ ...table, tableData: pureSplit.tableData }));

    const pureStyled = setCanonicalTableCellStyle(pureSplit.tableData, { rowIndex: 0, colIndex: 0 }, { backgroundColor: "#abcdef" });
    const closedStyled = await setTableCellStyle(
      { target: { surface: "workspace", path: "doc.html" }, blockId: table.id, rowIndex: 0, colIndex: 0, style: { backgroundColor: "#abcdef" } },
      { nautiloApp: host },
    );
    expect(closedStyled).toMatchObject({ ok: true, status: "saved" });
    if (pureStyled.ok) {
      expect(tableShape(storedTable(getStore, table.id))).toEqual(tableShape({ ...table, tableData: pureStyled.tableData }));
    }
  });

  test("closed table deletion matches the canonical live operation", async () => {
    const table = makeTableBlock(1, 1);
    table.id = "parity-delete";
    const { host, getStore } = seedWithBlocks([makeBlock("paragraph", "keep"), table]);
    const parsed = parseWriterHtml(getStore());
    if (!parsed.ok) throw new Error("seed parse failed");
    const sourceBlocks = parsed.document.document.blocks as Block[];
    const pureBlocks = deleteCanonicalTableBlock(sourceBlocks, table.id);
    expect(pureBlocks).not.toBeNull();
    const closed = await deleteTable(
      { target: { surface: "workspace", path: "doc.html" }, blockId: table.id },
      { nautiloApp: host },
    );
    expect(closed).toMatchObject({ ok: true, status: "saved" });
    const after = parseWriterHtml(getStore());
    if (!after.ok || !pureBlocks) return;
    expect(after.document.document.blocks.map((block) => ({ id: block.id, type: block.type })))
      .toEqual(pureBlocks.map((block) => ({ id: block.id, type: block.type })));
  });

  test("insertTableRow grows row count and inserts at the right index", async () => {
    const { host, getStore } = seedWithBlocks([
      makeBlock("paragraph", "Intro"),
      makeTableBlock(2, 2),
    ]);
    const initial = parseWriterHtml(getStore());
    if (!initial.ok) throw new Error("seed parse failed");
    const tableId = findTableBlockId(initial.document.document.blocks as Block[]);

    const result = await insertTableRow(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId, rowIndex: 1 },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", rowCount: 3 });

    const parsed = parseWriterHtml(getStore());
    if (!parsed.ok) throw new Error("reparse failed");
    const table = (parsed.document.document.blocks as Block[]).find((b) => b.id === tableId)!;
    expect(table.tableData!.rows).toHaveLength(3);
    // New row's cells are empty paragraphs.
    expect(getBlockText(table.tableData!.rows[1]!.cells[0]!.blocks[0]!)).toBe("");
  });

  test("insertTableRow appends when rowIndex equals current row count", async () => {
    const { host, getStore } = seedWithBlocks([makeTableBlock(1, 2)]);
    const initial = parseWriterHtml(getStore());
    if (!initial.ok) throw new Error("seed parse failed");
    const tableId = findTableBlockId(initial.document.document.blocks as Block[]);

    const result = await insertTableRow(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId, rowIndex: 1 },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", rowCount: 2 });
  });

  test("insertTableRow returns not_found when blockId is not a table", async () => {
    const { host } = mockHost();
    const result = await insertTableRow(
      { target: { surface: "workspace", path: "doc.html" }, blockId: "nope", rowIndex: 0 },
      { nautiloApp: host },
    );
    expect(result).toEqual({ ok: true, status: "not_found", displayPath: "workspace:doc.html" });
  });

  test("deleteTableRow shrinks row count and refuses the last row", async () => {
    const { host, getStore } = seedWithBlocks([makeTableBlock(3, 2)]);
    const initial = parseWriterHtml(getStore());
    if (!initial.ok) throw new Error("seed parse failed");
    const tableId = findTableBlockId(initial.document.document.blocks as Block[]);

    const ok = await deleteTableRow(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId, rowIndex: 1 },
      { nautiloApp: host },
    );
    expect(ok).toMatchObject({ ok: true, status: "saved", rowCount: 2 });

    const last = await deleteTableRow(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId, rowIndex: 0 },
      { nautiloApp: host },
    );
    // After first delete the table has 2 rows; reduce to 1 first.
    await deleteTableRow(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId, rowIndex: 0 },
      { nautiloApp: host },
    );
    const refuse = await deleteTableRow(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId, rowIndex: 0 },
      { nautiloApp: host },
    );
    expect((last as { ok: boolean }).ok).toBe(true);
    expect(refuse).toEqual({ ok: false, error: expect.stringContaining("last row") });
  });

  test("insertTableColumn grows col count and renormalizes widths", async () => {
    const { host, getStore } = seedWithBlocks([makeTableBlock(2, 2)]);
    const initial = parseWriterHtml(getStore());
    if (!initial.ok) throw new Error("seed parse failed");
    const tableId = findTableBlockId(initial.document.document.blocks as Block[]);

    const result = await insertTableColumn(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId, colIndex: 1 },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", colCount: 3 });
    const parsed = parseWriterHtml(getStore());
    if (!parsed.ok) throw new Error("reparse failed");
    const table = (parsed.document.document.blocks as Block[]).find((b) => b.id === tableId)!;
    expect(table.tableData!.columnWidths).toHaveLength(3);
    // Equal-share renormalization: each width ~1/3.
    for (const w of table.tableData!.columnWidths) {
      expect(w).toBeCloseTo(1 / 3, 6);
    }
  });

  test("deleteTableColumn shrinks col count and refuses the last column", async () => {
    const { host, getStore } = seedWithBlocks([makeTableBlock(2, 3)]);
    const initial = parseWriterHtml(getStore());
    if (!initial.ok) throw new Error("seed parse failed");
    const tableId = findTableBlockId(initial.document.document.blocks as Block[]);

    const ok = await deleteTableColumn(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId, colIndex: 1 },
      { nautiloApp: host },
    );
    expect(ok).toMatchObject({ ok: true, status: "saved", colCount: 2 });

    await deleteTableColumn(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId, colIndex: 0 },
      { nautiloApp: host },
    );
    const refuse = await deleteTableColumn(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId, colIndex: 0 },
      { nautiloApp: host },
    );
    expect(refuse).toEqual({ ok: false, error: expect.stringContaining("last column") });
  });

  test("mergeTableCells sets anchor span and marks covered cells colSpan=0", async () => {
    const table = makeTableBlock(2, 2);
    fillCell(table, 0, 0, "A");
    fillCell(table, 0, 1, "B");
    fillCell(table, 1, 0, "C");
    fillCell(table, 1, 1, "D");
    const { host, getStore } = seedWithBlocks([table]);
    const initial = parseWriterHtml(getStore());
    if (!initial.ok) throw new Error("seed parse failed");
    const tableId = findTableBlockId(initial.document.document.blocks as Block[]);

    const result = await mergeTableCells(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId: tableId,
        start: { rowIndex: 0, colIndex: 0 },
        end: { rowIndex: 1, colIndex: 1 },
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", blockId: tableId });

    const parsed = parseWriterHtml(getStore());
    if (!parsed.ok) throw new Error("reparse failed");
    const t = (parsed.document.document.blocks as Block[]).find((b) => b.id === tableId)!;
    const anchor = t.tableData!.rows[0]!.cells[0]!;
    expect(anchor.colSpan).toBe(2);
    expect(anchor.rowSpan).toBe(2);
    // Covered cells are marked colSpan=0.
    expect(t.tableData!.rows[0]!.cells[1]!.colSpan).toBe(0);
    expect(t.tableData!.rows[1]!.cells[0]!.colSpan).toBe(0);
    expect(t.tableData!.rows[1]!.cells[1]!.colSpan).toBe(0);
    // Text from covered cells was appended to the anchor.
    const merged = t.tableData!.rows[0]!.cells[0]!.blocks.map((b) => getBlockText(b)).join("");
    expect(merged).toContain("A");
    expect(merged).toContain("B");
    expect(merged).toContain("C");
    expect(merged).toContain("D");
  });

  test("mergeTableCells refuses a single-cell range and an already-merged cell", async () => {
    const { host, getStore } = seedWithBlocks([makeTableBlock(2, 2)]);
    const initial = parseWriterHtml(getStore());
    if (!initial.ok) throw new Error("seed parse failed");
    const tableId = findTableBlockId(initial.document.document.blocks as Block[]);

    const single = await mergeTableCells(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId: tableId,
        start: { rowIndex: 0, colIndex: 0 },
        end: { rowIndex: 0, colIndex: 0 },
      },
      { nautiloApp: host },
    );
    expect(single).toEqual({ ok: false, error: expect.stringContaining("at least two cells") });

    // First merge a 1x2 range, then attempt to re-merge over a covered cell.
    await mergeTableCells(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId: tableId,
        start: { rowIndex: 0, colIndex: 0 },
        end: { rowIndex: 0, colIndex: 1 },
      },
      { nautiloApp: host },
    );
    const reMerge = await mergeTableCells(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId: tableId,
        start: { rowIndex: 0, colIndex: 0 },
        end: { rowIndex: 1, colIndex: 1 },
      },
      { nautiloApp: host },
    );
    expect(reMerge).toEqual({ ok: false, error: expect.stringContaining("already merged") });
  });

  test("splitTableCell restores covered cells to normal empty paragraphs", async () => {
    const table = makeTableBlock(2, 2);
    const { host, getStore } = seedWithBlocks([table]);
    const initial = parseWriterHtml(getStore());
    if (!initial.ok) throw new Error("seed parse failed");
    const tableId = findTableBlockId(initial.document.document.blocks as Block[]);

    await mergeTableCells(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId: tableId,
        start: { rowIndex: 0, colIndex: 0 },
        end: { rowIndex: 1, colIndex: 1 },
      },
      { nautiloApp: host },
    );

    const split = await splitTableCell(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId, rowIndex: 0, colIndex: 0 },
      { nautiloApp: host },
    );
    expect(split).toMatchObject({ ok: true, status: "saved", blockId: tableId });

    const parsed = parseWriterHtml(getStore());
    if (!parsed.ok) throw new Error("reparse failed");
    const t = (parsed.document.document.blocks as Block[]).find((b) => b.id === tableId)!;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const cell = t.tableData!.rows[r]!.cells[c]!;
        expect(cell.colSpan ?? 1).toBe(1);
        expect(cell.rowSpan ?? 1).toBe(1);
        expect(getBlockText(cell.blocks[0]!)).toBe("");
      }
    }
  });

  test("splitTableCell refuses a non-merged cell", async () => {
    const { host, getStore } = seedWithBlocks([makeTableBlock(2, 2)]);
    const initial = parseWriterHtml(getStore());
    if (!initial.ok) throw new Error("seed parse failed");
    const tableId = findTableBlockId(initial.document.document.blocks as Block[]);

    const result = await splitTableCell(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId, rowIndex: 0, colIndex: 0 },
      { nautiloApp: host },
    );
    expect(result).toEqual({ ok: false, error: expect.stringContaining("not merged") });
  });

  test("setTableCellStyle applies backgroundColor and preserves other cell fields", async () => {
    const { host, getStore } = seedWithBlocks([makeTableBlock(2, 2)]);
    const initial = parseWriterHtml(getStore());
    if (!initial.ok) throw new Error("seed parse failed");
    const tableId = findTableBlockId(initial.document.document.blocks as Block[]);

    const result = await setTableCellStyle(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId: tableId,
        rowIndex: 0,
        colIndex: 1,
        style: { backgroundColor: "#ff8800", verticalAlign: "middle" },
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", rowIndex: 0, colIndex: 1 });

    const parsed = parseWriterHtml(getStore());
    if (!parsed.ok) throw new Error("reparse failed");
    const t = (parsed.document.document.blocks as Block[]).find((b) => b.id === tableId)!;
    const cell = t.tableData!.rows[0]!.cells[1]!;
    expect(cell.style.backgroundColor).toBe("#ff8800");
    expect(cell.style.verticalAlign).toBe("middle");
    // Default padding preserved.
    expect(cell.style.padding).toBe(4);
  });

  test("setTableCellStyle refuses a covered (colSpan=0) cell", async () => {
    const { host, getStore } = seedWithBlocks([makeTableBlock(2, 2)]);
    const initial = parseWriterHtml(getStore());
    if (!initial.ok) throw new Error("seed parse failed");
    const tableId = findTableBlockId(initial.document.document.blocks as Block[]);
    await mergeTableCells(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId: tableId,
        start: { rowIndex: 0, colIndex: 0 },
        end: { rowIndex: 0, colIndex: 1 },
      },
      { nautiloApp: host },
    );
    const result = await setTableCellStyle(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId: tableId,
        rowIndex: 0,
        colIndex: 1,
        style: { backgroundColor: "#00ff00" },
      },
      { nautiloApp: host },
    );
    expect(result).toEqual({ ok: false, error: expect.stringContaining("covered by a merge") });
  });

  test("setTableCellStyle rejects invalid color and padding", async () => {
    const { host, getStore } = seedWithBlocks([makeTableBlock(1, 1)]);
    const initial = parseWriterHtml(getStore());
    if (!initial.ok) throw new Error("seed parse failed");
    const tableId = findTableBlockId(initial.document.document.blocks as Block[]);

    const badColor = await setTableCellStyle(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId: tableId,
        rowIndex: 0,
        colIndex: 0,
        style: { backgroundColor: "orange" },
      },
      { nautiloApp: host },
    );
    expect(badColor).toEqual({ ok: false, error: expect.stringContaining("backgroundColor") });

    const badPadding = await setTableCellStyle(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId: tableId,
        rowIndex: 0,
        colIndex: 0,
        style: { padding: -5 },
      },
      { nautiloApp: host },
    );
    expect(badPadding).toEqual({ ok: false, error: expect.stringContaining("padding") });
  });

  test("live and closed cell-style paths accept and reject the same payloads", async () => {
    const validStyle = { backgroundColor: "#abcd", verticalAlign: "middle" as const, padding: 100 };
    const invalidStyles = [
      { backgroundColor: "#12345" },
      { verticalAlign: "baseline" },
      { padding: Number.NaN },
      { padding: Number.POSITIVE_INFINITY },
      { padding: -1 },
      { padding: 101 },
      { arbitrary: true },
    ];
    const live = (style: object) => validateEditOpenWriterRequest({
      sessionToken: "opaque-session-token",
      baseRevision: 0,
      operations: [{
        kind: "set-table-cell-style",
        tableBlockId: "table",
        cell: { rowIndex: 0, colIndex: 0 },
        style,
      }],
    });

    expect(live(validStyle).ok).toBe(true);
    for (const style of invalidStyles) expect(live(style).ok).toBe(false);

    const { host, getStore } = seedWithBlocks([makeTableBlock(1, 1)]);
    const initial = parseWriterHtml(getStore());
    if (!initial.ok) throw new Error("seed parse failed");
    const blockId = findTableBlockId(initial.document.document.blocks as Block[]);
    const closed = (style: object) => setTableCellStyle(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId,
        rowIndex: 0,
        colIndex: 0,
        style: style as never,
      },
      { nautiloApp: host },
    );
    expect(await closed(validStyle)).toMatchObject({ ok: true });
    for (const style of invalidStyles) expect(await closed(style)).toMatchObject({ ok: false });
  });

  test("deleteTable removes the table block and returns not_found for non-table ids", async () => {
    const { host, getStore } = seedWithBlocks([
      makeBlock("paragraph", "Intro"),
      makeTableBlock(2, 2),
    ]);
    const initial = parseWriterHtml(getStore());
    if (!initial.ok) throw new Error("seed parse failed");
    const blocks = initial.document.document.blocks as Block[];
    const tableId = findTableBlockId(blocks);
    const paraId = blocks[0]!.id;

    const ok = await deleteTable(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId },
      { nautiloApp: host },
    );
    expect(ok).toMatchObject({ ok: true, status: "saved", blockId: tableId });
    const parsed = parseWriterHtml(getStore());
    if (!parsed.ok) throw new Error("reparse failed");
    expect((parsed.document.document.blocks as Block[]).find((b) => b.id === tableId)).toBeUndefined();

    // A paragraph id is not a table → not_found.
    const miss = await deleteTable(
      { target: { surface: "workspace", path: "doc.html" }, blockId: paraId },
      { nautiloApp: host },
    );
    expect(miss).toEqual({ ok: true, status: "not_found", displayPath: "workspace:doc.html" });
  });

  test("indentBlocks increases marginLeft for paragraphs and listLevel for list-items", async () => {
    const { host, getStore } = seedWithBlocks([
      makeBlock("paragraph", "Para"),
      makeBlock("list-item", "Item", { listKind: "ordered", listLevel: 1 }),
    ]);
    const initial = parseWriterHtml(getStore());
    if (!initial.ok) throw new Error("seed parse failed");
    const blocks = initial.document.document.blocks as Block[];
    const paraId = blocks[0]!.id;
    const listId = blocks[1]!.id;

    const result = await indentBlocks(
      { target: { surface: "workspace", path: "doc.html" }, blockIds: [paraId, listId] },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", affectedCount: 2 });
    const parsed = parseWriterHtml(getStore());
    if (!parsed.ok) throw new Error("reparse failed");
    const after = parsed.document.document.blocks as Block[];
    expect(after[0]!.style.marginLeft).toBe(36);
    expect(after[1]!.listLevel).toBe(2);
  });

  test("outdentBlocks decreases marginLeft clamped to 0 and listLevel clamped to 0", async () => {
    const para = makeBlock("paragraph", "Para");
    para.style = { ...para.style, marginLeft: 24 };
    const list = makeBlock("list-item", "Item", { listKind: "ordered", listLevel: 0 });
    const { host, getStore } = seedWithBlocks([para, list]);
    const initial = parseWriterHtml(getStore());
    if (!initial.ok) throw new Error("seed parse failed");
    const blocks = initial.document.document.blocks as Block[];
    const paraId = blocks[0]!.id;
    const listId = blocks[1]!.id;

    const result = await outdentBlocks(
      { target: { surface: "workspace", path: "doc.html" }, blockIds: [paraId, listId] },
      { nautiloApp: host },
    );
    // Only the paragraph can be outdented (listLevel 0 is already at floor).
    expect(result).toMatchObject({ ok: true, status: "saved", affectedCount: 1 });
    const parsed = parseWriterHtml(getStore());
    if (!parsed.ok) throw new Error("reparse failed");
    const after = parsed.document.document.blocks as Block[];
    expect(after[0]!.style.marginLeft).toBe(0);
    expect(after[1]!.listLevel).toBe(0);
  });

  test("indentBlocks returns not_found when no listed block can be indented further", async () => {
    const list = makeBlock("list-item", "Item", { listKind: "ordered", listLevel: 8 });
    const { host, getStore } = seedWithBlocks([list]);
    const initial = parseWriterHtml(getStore());
    if (!initial.ok) throw new Error("seed parse failed");
    const listId = (initial.document.document.blocks as Block[])[0]!.id;
    const result = await indentBlocks(
      { target: { surface: "workspace", path: "doc.html" }, blockIds: [listId] },
      { nautiloApp: host },
    );
    expect(result).toEqual({ ok: true, status: "not_found", displayPath: "workspace:doc.html" });
  });

  test("all D372 table write tools propagate conflicts", async () => {
    // Seed host: used to stage documents whose read view the conflict host
    // will mirror. The conflict host's write always returns conflict.
    const seedHost = mockHost();
    const conflictWithSeed = mockHost({
      async read() {
        return {
          content: seedHost.getStore(),
          mimeType: "text/html",
          displayPath: "workspace:doc.html",
          baseSha256: "abc123",
          baseRevision: 1,
        };
      },
      async write() {
        return { kind: "conflict", currentSha256: "newer-hash" };
      },
    }).host;

    // Insert a 2x2 table; capture its blockId for the table-edit ops.
    const insertRes = await insertTable(
      { target: { surface: "workspace", path: "doc.html" }, rows: 2, cols: 2 },
      { nautiloApp: seedHost.host },
    );
    if (!("ok" in insertRes) || !insertRes.ok) throw new Error("seed insert failed");
    const tableId = insertRes.blockId;
    // Bump a paragraph's marginLeft via indent so outdent has something to
    // do later (default paragraphs sit at marginLeft=0 and outdent is a
    // no-op there).
    const inspect = await inspectDocument(
      { target: { surface: "workspace", path: "doc.html" } },
      { nautiloApp: seedHost.host },
    );
    if (!inspect.ok) throw new Error("seed inspect failed");
    const paraId = inspect.outline.find((o) => o.type === "paragraph")!.id;
    await indentBlocks(
      { target: { surface: "workspace", path: "doc.html" }, blockIds: [paraId] },
      { nautiloApp: seedHost.host },
    );

    const expectConflict = (r: unknown) =>
      expect(r).toEqual({ ok: true, status: "conflict", displayPath: "workspace:doc.html", currentSha256: "newer-hash" });

    expectConflict(await insertTableRow(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId, rowIndex: 0 },
      { nautiloApp: conflictWithSeed },
    ));
    expectConflict(await deleteTableRow(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId, rowIndex: 0 },
      { nautiloApp: conflictWithSeed },
    ));
    expectConflict(await insertTableColumn(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId, colIndex: 0 },
      { nautiloApp: conflictWithSeed },
    ));
    expectConflict(await deleteTableColumn(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId, colIndex: 0 },
      { nautiloApp: conflictWithSeed },
    ));
    expectConflict(await mergeTableCells(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId: tableId,
        start: { rowIndex: 0, colIndex: 0 },
        end: { rowIndex: 0, colIndex: 1 },
      },
      { nautiloApp: conflictWithSeed },
    ));
    // Stage a merged cell so split + setTableCellStyle-on-anchor can both
    // reach the write path against the conflict host.
    await mergeTableCells(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId: tableId,
        start: { rowIndex: 0, colIndex: 0 },
        end: { rowIndex: 0, colIndex: 1 },
      },
      { nautiloApp: seedHost.host },
    );
    expectConflict(await splitTableCell(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId, rowIndex: 0, colIndex: 0 },
      { nautiloApp: conflictWithSeed },
    ));
    expectConflict(await setTableCellStyle(
      {
        target: { surface: "workspace", path: "doc.html" },
        blockId: tableId,
        rowIndex: 0,
        colIndex: 0,
        style: { backgroundColor: "#abcdef" },
      },
      { nautiloApp: conflictWithSeed },
    ));
    expectConflict(await deleteTable(
      { target: { surface: "workspace", path: "doc.html" }, blockId: tableId },
      { nautiloApp: conflictWithSeed },
    ));
    expectConflict(await indentBlocks(
      { target: { surface: "workspace", path: "doc.html" }, blockIds: [paraId] },
      { nautiloApp: conflictWithSeed },
    ));
    expectConflict(await outdentBlocks(
      { target: { surface: "workspace", path: "doc.html" }, blockIds: [paraId] },
      { nautiloApp: conflictWithSeed },
    ));
  });
});

describe("writer import-docx / export-docx", () => {
  const officeGetEnvelope = {
    success: true,
    data: {
      matches: 1,
      results: [
        {
          path: "/body",
          type: "body",
          children: [
            {
              path: "/body/p[1]",
              type: "paragraph",
              children: [
                {
                  path: "/body/p[1]/r[1]",
                  type: "run",
                  text: "Imported paragraph",
                  format: { bold: true },
                },
              ],
            },
          ],
        },
      ],
    },
  };

  test("importDocx maps OfficeCLI JSON and writes into the current folder", async () => {
    let capturedRun: unknown = null;
    let capturedCreate: {
      surface: string;
      path: string;
      content: string;
      colocateWith?: { surface: "workspace"; path: string };
    } | null = null;
    let wroteViaWrite = false;
    const { host } = mockHost(
      {
        async write() {
          wroteViaWrite = true;
          return { kind: "saved", sha256: "should-not-be-used", revision: 2 };
        },
        async createDocument(args) {
          capturedCreate = args;
          return { ok: true, artifactPath: args.path, sha256: "deadbeef", byteLength: 1 };
        },
      },
      {
        async run(args) {
          capturedRun = args;
          return { ok: true, json: officeGetEnvelope };
        },
      },
    );
    const result = await importDocx(
      {
        source: { surface: "currentFolder", path: "report.docx" },
        targetPath: "notes/report.html",
        fileName: "report.docx",
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({
      ok: true,
      status: "imported",
      artifactPath: "notes/report.html",
      sha256: "deadbeef",
      skippedCount: 0,
    });
    if (!("ok" in result) || !result.ok || result.status !== "imported") return;
    expect(result.blockCount).toBeGreaterThanOrEqual(1);
    expect(capturedRun).toEqual({
      input: { surface: "currentFolder", path: "report.docx" },
      readArgv: ["get", "/body", "--depth", "6", "--json"],
    });
    // current-folder source → direct createDocument to the current folder,
    // NOT the turn-scoped document.write patch pipeline.
    expect(wroteViaWrite).toBe(false);
    expect(capturedCreate?.surface).toBe("currentFolder");
    expect(capturedCreate?.path).toBe("notes/report.html");
    // current-folder → no namespace colocation.
    expect(capturedCreate?.colocateWith).toBeUndefined();
    const parsed = parseWriterHtml(capturedCreate?.content ?? "");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.document.blocks.length).toBeGreaterThanOrEqual(1);
  });

  test("importDocx colocates a workspace-source import in the source namespace", async () => {
    let capturedCreate: {
      surface: string;
      path: string;
      colocateWith?: { surface: "workspace"; path: string };
    } | null = null;
    const { host } = mockHost(
      {
        async createDocument(args) {
          capturedCreate = args;
          return { ok: true, artifactPath: args.path, sha256: "ns-hash", byteLength: 1 };
        },
      },
      {
        async run() {
          return { ok: true, json: officeGetEnvelope };
        },
      },
    );
    const result = await importDocx(
      {
        source: { surface: "workspace", path: "archive/Group.docx" },
        targetPath: "archive/Group.html",
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "imported", artifactPath: "archive/Group.html" });
    expect(capturedCreate?.surface).toBe("workspace");
    expect(capturedCreate?.colocateWith).toEqual({ surface: "workspace", path: "archive/Group.docx" });
  });

  test("importDocx surfaces office.run failure", async () => {
    const { host } = mockHost(undefined, {
      async run() {
        return { ok: false, code: "OFFICECLI_NON_ZERO_EXIT", message: "officecli get exited with code 1" };
      },
    });
    const result = await importDocx(
      {
        source: { surface: "workspace", path: "imports/broken.docx" },
        targetPath: "broken.html",
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({
      ok: true,
      status: "failed",
      code: "OFFICECLI_NON_ZERO_EXIT",
      message: "officecli get exited with code 1",
    });
  });

  test("exportDocx parses Writer HTML and calls office.run with batch ops", async () => {
    const html = serializeWriterHtml(createDefaultManifest(), seedDocument([
      makeBlock("paragraph", "Exported paragraph"),
    ]));
    let capturedRun: { ops?: unknown[]; output?: unknown } | null = null;
    const { host } = mockHost(
      {
        async read() {
          return {
            content: html,
            mimeType: "text/html",
            displayPath: "workspace:notes/report.html",
            baseSha256: "abc123",
            baseRevision: 1,
          };
        },
      },
      {
        async run(args) {
          capturedRun = { ops: args.ops, output: args.output };
          return { ok: true, displayPath: "report.docx", sha256: "cafebabe", byteLength: 2048 };
        },
      },
    );
    const result = await exportDocx(
      {
        source: { surface: "workspace", path: "notes/report.html" },
        target: { surface: "currentFolder", path: "report.docx" },
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({
      ok: true,
      status: "exported",
      displayPath: "report.docx",
      sha256: "cafebabe",
      byteLength: 2048,
      skippedCount: 0,
    });
    expect(Array.isArray(capturedRun?.ops)).toBe(true);
    expect(capturedRun?.ops?.length).toBeGreaterThan(0);
    expect(capturedRun?.output).toEqual({ surface: "currentFolder", path: "report.docx" });
  });

  test("exportDocx reads a current-folder source and writes the .docx to the current folder", async () => {
    const html = serializeWriterHtml(createDefaultManifest(), seedDocument([
      makeBlock("paragraph", "Local doc"),
    ]));
    let readTarget: unknown = null;
    let capturedOutput: unknown = null;
    const { host } = mockHost(
      {
        async read(target) {
          readTarget = target;
          return {
            content: html,
            mimeType: "text/html",
            displayPath: "report.html",
            baseSha256: "abc123",
            baseRevision: 1,
          };
        },
      },
      {
        async run(args) {
          capturedOutput = args.output;
          return { ok: true, displayPath: "report.docx", sha256: "feedface", byteLength: 512 };
        },
      },
    );
    const result = await exportDocx(
      {
        source: { surface: "currentFolder", path: "report.html" },
        target: { surface: "currentFolder", path: "report.docx" },
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "exported", displayPath: "report.docx" });
    expect(readTarget).toEqual({ surface: "currentFolder", relativePath: "report.html" });
    expect(capturedOutput).toEqual({ surface: "currentFolder", path: "report.docx" });
  });

  test("exportDocx surfaces office.run failure", async () => {
    const { host } = mockHost(undefined, {
      async run() {
        return { ok: false, code: "OFFICECLI_BATCH_FAILED", message: "officecli batch reported failed commands" };
      },
    });
    const result = await exportDocx(
      {
        source: { surface: "workspace", path: "report.html" },
        target: { surface: "workspace", path: "exports/report.docx" },
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({
      ok: true,
      status: "failed",
      code: "OFFICECLI_BATCH_FAILED",
      message: "officecli batch reported failed commands",
    });
  });

  // M205 — symmetric conflict handling: a pre-existing target surfaces as
  // status:"conflict" (with the attempted target) on BOTH import and export,
  // and an explicit overwrite flows through to the host write.
  test("importDocx returns a conflict when the target already exists", async () => {
    const { host } = mockHost(
      {
        async createDocument() {
          return { ok: false, code: "EXISTS", message: 'A file already exists at "notes/report.html".' };
        },
      },
      {
        async run() {
          return { ok: true, json: officeGetEnvelope };
        },
      },
    );
    const result = await importDocx(
      { source: { surface: "workspace", path: "src.docx" }, targetPath: "notes/report.html" },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({
      ok: true,
      status: "conflict",
      target: { surface: "workspace", path: "notes/report.html" },
    });
  });

  test("importDocx forwards overwrite to createDocument", async () => {
    let captured: { overwrite?: boolean } | null = null;
    const { host } = mockHost(
      {
        async createDocument(args) {
          captured = args;
          return { ok: true, artifactPath: args.path, sha256: "h", byteLength: 1 };
        },
      },
      {
        async run() {
          return { ok: true, json: officeGetEnvelope };
        },
      },
    );
    await importDocx(
      { source: { surface: "workspace", path: "src.docx" }, targetPath: "a.html", overwrite: true },
      { nautiloApp: host },
    );
    expect(captured?.overwrite).toBe(true);
  });

  test("exportDocx returns a conflict when the target already exists", async () => {
    const html = serializeWriterHtml(createDefaultManifest(), seedDocument([makeBlock("paragraph", "x")]));
    const { host } = mockHost(
      {
        async read() {
          return { content: html, mimeType: "text/html", displayPath: "d", baseSha256: "a", baseRevision: 1 };
        },
      },
      {
        async run() {
          return { ok: false, code: "EXISTS", message: 'A file already exists at "out.docx".' };
        },
      },
    );
    const result = await exportDocx(
      { source: { surface: "workspace", path: "a.html" }, target: { surface: "currentFolder", path: "out.docx" } },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({
      ok: true,
      status: "conflict",
      target: { surface: "currentFolder", path: "out.docx" },
    });
  });

  test("exportDocx forwards overwrite to office.run", async () => {
    const html = serializeWriterHtml(createDefaultManifest(), seedDocument([makeBlock("paragraph", "x")]));
    let captured: { overwrite?: boolean } | null = null;
    const { host } = mockHost(
      {
        async read() {
          return { content: html, mimeType: "text/html", displayPath: "d", baseSha256: "a", baseRevision: 1 };
        },
      },
      {
        async run(args) {
          captured = args;
          return { ok: true, displayPath: "out.docx", sha256: "c", byteLength: 1 };
        },
      },
    );
    await exportDocx(
      {
        source: { surface: "workspace", path: "a.html" },
        target: { surface: "workspace", path: "out.docx" },
        overwrite: true,
      },
      { nautiloApp: host },
    );
    expect(captured?.overwrite).toBe(true);
  });

  test("exportDocx forwards imageInputs and picture ops for image inlines (workspace target)", async () => {
    const html = serializeWriterHtml(createDefaultManifest(), seedDocument([
      {
        ...makeBlock("paragraph", ""),
        inlines: [
          { text: "See ", style: {} },
          {
            text: WRITER_IMAGE_OBJECT_CHAR,
            style: { image: { src: TINY_PNG_DATA_URL, width: 96, height: 96, alt: "dot" } },
          },
        ],
      } as Block,
    ]));
    let capturedRun: { ops?: unknown[]; imageInputs?: unknown[]; output?: unknown } | null = null;
    const { host } = mockHost(
      {
        async read() {
          return {
            content: html,
            mimeType: "text/html",
            displayPath: "workspace:notes/report.html",
            baseSha256: "abc123",
            baseRevision: 1,
          };
        },
      },
      {
        async run(args) {
          capturedRun = args;
          return { ok: true, displayPath: "report.docx", sha256: "cafe", byteLength: 4096 };
        },
      },
    );
    const result = await exportDocx(
      {
        source: { surface: "workspace", path: "notes/report.html" },
        target: { surface: "workspace", path: "report.docx" },
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "exported" });
    expect(Array.isArray(capturedRun?.imageInputs)).toBe(true);
    expect(capturedRun?.imageInputs?.length).toBe(1);
    const picture = (capturedRun?.ops as Array<{ type?: string; props?: Record<string, string> }> | undefined)
      ?.find((cmd) => cmd.type === "picture");
    expect(picture?.props?.[OFFICE_RUN_IMAGE_INDEX_PROP]).toBe("0");
    expect(
      (capturedRun?.ops as Array<{ type?: string; props?: Record<string, string> }> | undefined)
        ?.some((cmd) => cmd.type === "r" && cmd.props?.["text"] === WRITER_IMAGE_OBJECT_CHAR),
    ).toBe(false);
  });

  test("exportDocx forwards imageInputs on currentFolder target without server staging", async () => {
    const html = serializeWriterHtml(createDefaultManifest(), seedDocument([
      {
        ...makeBlock("paragraph", ""),
        inlines: [{
          text: WRITER_IMAGE_OBJECT_CHAR,
          style: { image: { src: TINY_PNG_DATA_URL, width: 64, height: 64 } },
        }],
      } as Block,
    ]));
    let capturedRun: { imageInputs?: unknown[]; output?: { surface?: string } } | null = null;
    const { host } = mockHost(
      {
        async read() {
          return {
            content: html,
            mimeType: "text/html",
            displayPath: "local.html",
            baseSha256: "abc123",
            baseRevision: 1,
          };
        },
      },
      {
        async run(args) {
          capturedRun = args;
          return { ok: true, displayPath: "local.docx", sha256: "abc", byteLength: 100 };
        },
      },
    );
    await exportDocx(
      {
        source: { surface: "currentFolder", path: "local.html" },
        target: { surface: "currentFolder", path: "local.docx" },
      },
      { nautiloApp: host },
    );
    expect(capturedRun?.output?.surface).toBe("currentFolder");
    expect(capturedRun?.imageInputs?.length).toBe(1);
  });

  test("importDocx maps picture nodes via mediaByRelId into Writer image inlines", async () => {
    let capturedCreate: { content: string } | null = null;
    const { host } = mockHost(
      {
        async createDocument(args) {
          capturedCreate = { content: args.content };
          return {
            ok: true,
            artifactPath: args.path,
            sha256: "created-hash",
            byteLength: new TextEncoder().encode(args.content).length,
          };
        },
      },
      {
        async run() {
          return {
            ok: true,
            json: {
              success: true,
              data: {
                matches: 1,
                results: [
                  {
                    path: "/body",
                    type: "body",
                    children: [
                      {
                        path: "/body/p[1]",
                        type: "paragraph",
                        children: [
                          {
                            path: "/body/p[1]/r[1]",
                            type: "picture",
                            text: "dot",
                            format: {
                              relId: "Rimg1",
                              width: "2.0cm",
                              height: "2.0cm",
                              alt: "dot",
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
            mediaByRelId: { Rimg1: TINY_PNG_DATA_URL },
          };
        },
      },
    );
    const result = await importDocx(
      {
        source: { surface: "workspace", path: "imports/one-image.docx" },
        targetPath: "imports/one-image.html",
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "imported" });
    const parsed = parseWriterHtml(capturedCreate?.content ?? "");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const inline = parsed.document.document.blocks[0]?.inlines?.[0] as
      | { text?: string; style?: { image?: { src?: string; alt?: string } } }
      | undefined;
    expect(inline?.text).toBe(WRITER_IMAGE_OBJECT_CHAR);
    expect(inline?.style?.image?.src).toBe(TINY_PNG_DATA_URL);
    expect(inline?.style?.image?.alt).toBe("dot");
  });
});
