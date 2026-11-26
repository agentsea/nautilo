import { describe, expect, test } from "bun:test";
import { createTableBlock, DEFAULT_BLOCK_STYLE, type Block, type Document } from "@nautilo/office-docs/node";
import { buildWriterReadEntries, readWriterContext, type WriterReadArgs, type WriterContextRead } from "../src/context-reader";
const paragraph = (id: string, text: string): Block => ({ id, type: "paragraph", inlines: [{ text, style: {} }], style: { ...DEFAULT_BLOCK_STYLE } });
const version = { kind: "artifact_revision", revision: 3 } as const;
const base = { sessionToken: "session", documentVersion: version, scope: { kind: "document" } as const, responseBudgetBytes: 100000 };
const read = (document: Document, args: Partial<Parameters<typeof readWriterContext>[0]> = {}) => readWriterContext({ ...base, document, canonicalSource: JSON.stringify(document), ...args });
async function page(document: Document, args: Partial<Parameters<typeof readWriterContext>[0]> = {}): Promise<WriterContextRead> {
  const result = await read(document, args); if (!result.ok) throw new Error(result.error); return result;
}
describe("budgeted canonical Writer context", () => {
  test("reads an ordinary essay beyond five blocks and all regions in one response", async () => {
    const document = { blocks: Array.from({ length: 30 }, (_, i) => paragraph(`p${i}`, `Paragraph ${i}.`)), header: { blocks: [paragraph("header", "Header")], marginFromEdge: 12 } };
    const result = await page(document);
    expect(result.complete).toBe(true); expect(result.nextRead).toBeNull(); expect(result.blocks).toHaveLength(31);
    expect(result.blocks.at(-1)).toMatchObject({ region: "header", editable: false });
  });
  test("resolves sections, inclusive ranges, blocks and reversed text selection", async () => {
    const document = { blocks: [paragraph("a", "intro"), { ...paragraph("h", "Heading"), type: "heading", headingLevel: 1 }, paragraph("b", "body"), { ...paragraph("sub", "Sub"), type: "heading", headingLevel: 2 }, paragraph("c", "child"), { ...paragraph("next", "Next"), type: "heading", headingLevel: 1 }] } as Document;
    expect((await page(document, { scope: { kind: "section", headingBlockId: "h" } })).blocks.map(b => b.id)).toEqual(["h", "b", "sub", "c"]);
    expect((await page(document, { scope: { kind: "range", fromBlockId: "b", toBlockId: "c" } })).blocks.map(b => b.id)).toEqual(["b", "sub", "c"]);
    expect((await page(document, { scope: { kind: "block", blockId: "b" } })).blocks.map(b => b.id)).toEqual(["b"]);
    expect((await page(document, { scope: { kind: "selection" }, selection: { anchor: { blockId: "b", offset: 2 }, focus: { blockId: "a", offset: 3 } } })).blocks.map(b => b.text)).toEqual(["ro", "Heading", "bo"]);
    expect((await read(document, { scope: { kind: "selection" } })).ok).toBe(false);
    expect((await read(document, { scope: { kind: "selection" }, selection: { anchor: { blockId: "a", offset: 99 }, focus: { blockId: "b", offset: 0 } } })).ok).toBe(false);
  });
  test("paginates exact escaped UTF-8 text within the entire JSON envelope", async () => {
    const text = '😀漢字"\\\n'.repeat(1000);
    const document = { blocks: [paragraph("long", text), paragraph("tail", "end")] };
    let args: Partial<WriterReadArgs> = {}; const pieces: string[] = []; let offset = 0;
    do {
      const result = await page(document, { ...args, responseBudgetBytes: 1400 });
      expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(1400);
      for (const b of result.blocks.filter(b => b.id === "long")) {
        expect(b.startOffset).toBe(offset); expect(b.text).toBe(text.slice(b.startOffset, b.endOffset));
        expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(b.text)).toBe(false);
        offset = b.endOffset; pieces.push(b.text);
      }
      if (!result.nextRead) break; args = result.nextRead;
    } while (args.cursor);
    expect(pieces.join("")).toBe(text);
  });
  test("binds continuation to canonical source, version, scope and selection", async () => {
    const document = { blocks: [paragraph("p", "x".repeat(10000))] };
    const first = await page(document, { responseBudgetBytes: 1200 });
    expect(first.nextRead).not.toBeNull();
    for (const change of [{ canonicalSource: "changed" }, { documentVersion: { kind: "artifact_revision", revision: 4 } as const }, { scope: { kind: "block", blockId: "p" } as const }, { sessionToken: "other" }, { cursor: "garbage" }]) {
      const result = await read(document, { ...first.nextRead!, ...change });
      expect(result).toMatchObject({ ok: false });
    }
  });
  test("preserves table addresses, merged coverage and nested read-only content", async () => {
    const table = createTableBlock(2, 2); table.id = "table";
    table.tableData!.rows[0]!.cells[0]!.colSpan = 2;
    table.tableData!.rows[0]!.cells[1]!.colSpan = 0;
    const nested = createTableBlock(1, 1); nested.id = "nested";
    nested.tableData!.rows[0]!.cells[0]!.blocks = [paragraph("deep", "nested text")];
    table.tableData!.rows[1]!.cells[0]!.blocks = [nested];
    const document = { blocks: [table] };
    const entries = buildWriterReadEntries(document);
    expect(entries.find(e => e.id === "deep")).toMatchObject({ editable: false, tablePath: [{ tableBlockId: "table", rowIndex: 1, colIndex: 0 }, { tableBlockId: "nested", rowIndex: 0, colIndex: 0 }] });
    expect(entries.filter(e => e.tablePath?.some(p => p.covered)).every(e => !e.editable)).toBe(true);
    const collected = []; let args: Partial<WriterReadArgs> = {};
    do { const result = await page(document, { ...args, responseBudgetBytes: 1600 }); collected.push(...result.blocks); if (!result.nextRead) break; args = result.nextRead; } while (args.cursor);
    expect(collected).toEqual(entries);
    const selected = await page(document, { scope: { kind: "selection" }, selection: { anchor: { blockId: entries[1]!.id, offset: 0 }, focus: { blockId: entries[1]!.id, offset: 0 }, tableCellRange: { blockId: "table", start: { rowIndex: 1, colIndex: 0 }, end: { rowIndex: 1, colIndex: 0 } } } });
    expect(selected.blocks.map(e => e.id)).toEqual(["nested", "deep"]);
  });
  test("keeps ordinary paragraphs whole when the remaining page is too small", async () => {
    const document = { blocks: Array.from({ length: 10 }, (_, i) => paragraph(`p${i}`, "x".repeat(300))) };
    const result = await page(document, { responseBudgetBytes: 1500 });
    expect(result.complete).toBe(false);
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks.every(b => b.startOffset === 0 && b.endOffset === b.textLength)).toBe(true);
    const second = await page(document, { ...result.nextRead!, responseBudgetBytes: 1500 });
    expect(second.blocks[0]!.ordinal).toBe(result.blocks.at(-1)!.ordinal + 1);
  });
  test("rejects collapsed selections and malformed scope fields", async () => {
    const document = { blocks: [paragraph("p", "text")] };
    expect(await read(document, { scope: { kind: "selection" }, selection: { anchor: { blockId: "p", offset: 2 }, focus: { blockId: "p", offset: 2 } } })).toMatchObject({ ok: false, status: "read_error" });
    expect(await read(document, { scope: { kind: "document", blockId: "p" } as unknown as WriterReadArgs["scope"] })).toMatchObject({ ok: false });
  });
  test("selection pages preserve their exact partial interval and selection binding", async () => {
    const document = { blocks: [paragraph("p", "x".repeat(5000))] };
    const selection = { anchor: { blockId: "p", offset: 10 }, focus: { blockId: "p", offset: 4000 } };
    const first = await page(document, { scope: { kind: "selection" }, selection, responseBudgetBytes: 1300 });
    expect(first.blocks[0]!.startOffset).toBe(10);
    const changed = await read(document, { ...first.nextRead!, selection: { ...selection, focus: { blockId: "p", offset: 3999 } } });
    expect(changed).toMatchObject({ ok: false });
    const second = await page(document, { ...first.nextRead!, selection, responseBudgetBytes: 1300 });
    expect(second.blocks[0]!.startOffset).toBe(first.blocks[0]!.endOffset);
  });
  test("keeps a table row together when it fits on a fresh page", async () => {
    const table = createTableBlock(2, 2); table.id = "rows";
    table.tableData!.rows.forEach((row, r) => row.cells.forEach((cell, c) => { cell.blocks = [paragraph(`cell-${r}-${c}`, "x".repeat(100))]; }));
    const document = { blocks: [paragraph("before", "x".repeat(200)), table] };
    let args: Partial<WriterReadArgs> = {}; const rowPages = new Map<number, Set<number>>(); let pageIndex = 0;
    do {
      const result = await page(document, { ...args, responseBudgetBytes: 2000 });
      for (const entry of result.blocks) {
        const row = entry.tablePath?.[0]?.rowIndex;
        if (row === undefined) continue;
        const pages = rowPages.get(row) ?? new Set<number>(); pages.add(pageIndex); rowPages.set(row, pages);
      }
      pageIndex++;
      if (!result.nextRead) break; args = result.nextRead;
    } while (args.cursor);
    expect(rowPages.size).toBe(2);
    expect([...rowPages.values()].every(pages => pages.size === 1)).toBe(true);
    expect(pageIndex).toBeGreaterThan(1);
  });
  test("rejects captured selection coordinates inside a surrogate pair", async () => {
    const document = { blocks: [paragraph("p", "a😀b")] };
    for (const selection of [
      { anchor: { blockId: "p", offset: 2 }, focus: { blockId: "p", offset: 4 } },
      { anchor: { blockId: "p", offset: 0 }, focus: { blockId: "p", offset: 2 } },
    ]) expect(await read(document, { scope: { kind: "selection" }, selection })).toMatchObject({ ok: false, status: "read_error" });
    expect((await page(document, { scope: { kind: "selection" }, selection: { anchor: { blockId: "p", offset: 1 }, focus: { blockId: "p", offset: 3 } } })).blocks[0]!.text).toBe("😀");
  });
  test("empty document completes and missing or insufficient host budgets fail explicitly", async () => {
    expect(await page({ blocks: [] })).toMatchObject({ complete: true, totalEntries: 0, blocks: [] });
    expect(await read({ blocks: [] }, { responseBudgetBytes: undefined })).toMatchObject({ ok: false });
    expect(await read({ blocks: [paragraph("p", "text")] }, { responseBudgetBytes: 1 })).toMatchObject({ ok: false });
  });
});
