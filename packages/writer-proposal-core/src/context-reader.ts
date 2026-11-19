import { getBlockText, type Block, type Document, type DocRange } from "@nautilo/office-docs/node";
import type { LiveDocumentVersion } from "@nautilo/types";

export type WriterReadScope = { kind: "document" } | { kind: "selection" } | { kind: "section"; headingBlockId: string } | { kind: "range"; fromBlockId: string; toBlockId: string } | { kind: "block"; blockId: string };
export type WriterReadEntry = {
  ordinal: number; id: string; type: string; region: "body" | "header" | "footer";
  text: string; textLength: number; startOffset: number; endOffset: number; editable: boolean;
  headingLevel?: number;
  tablePath?: Array<{ tableBlockId: string; rowIndex: number; colIndex: number; rowSpan: number; colSpan: number; covered: boolean }>;
  table?: { rowCount: number; columnCount: number };
};
export type WriterReadArgs = { sessionToken: string; documentVersion: LiveDocumentVersion; scope: WriterReadScope; cursor?: string };
export type WriterContextRead = {
  ok: true; status: "context_read"; documentVersion: LiveDocumentVersion; scope: WriterReadScope;
  sourceFingerprint: string; blockCount: number; totalEntries: number;
  bounds: { fromOrdinal: number | null; toOrdinal: number | null };
  blocks: WriterReadEntry[]; complete: boolean; nextRead: WriterReadArgs | null;
};
export type WriterReadError = { ok: false; status: "read_error"; error: string };
const fail = (error: string): WriterReadError => ({ ok: false, status: "read_error", error });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export async function writerReadFingerprint(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
}

/** Canonical preorder, including structure, covered cells and non-body regions. */
export function buildWriterReadEntries(document: Document): WriterReadEntry[] {
  const entries: WriterReadEntry[] = [];
  const visit = (blocks: Block[], region: WriterReadEntry["region"], path: NonNullable<WriterReadEntry["tablePath"]> = []) => {
    for (const block of blocks) {
      const text = getBlockText(block);
      entries.push({ ordinal: entries.length, id: block.id, type: block.type, region,
        text, textLength: text.length, startOffset: 0, endOffset: text.length,
        editable: region === "body" && block.type !== "table" && path.length <= 1 && !path.some(p => p.covered),
        ...(block.headingLevel ? { headingLevel: block.headingLevel } : {}),
        ...(path.length ? { tablePath: path } : {}),
        ...(block.tableData ? { table: { rowCount: block.tableData.rows.length, columnCount: block.tableData.rows.reduce((n, row) => Math.max(n, row.cells.length), 0) } } : {}),
      });
      block.tableData?.rows.forEach((row, rowIndex) => row.cells.forEach((cell, colIndex) => visit(cell.blocks, region,
        [...path, { tableBlockId: block.id, rowIndex, colIndex, rowSpan: cell.rowSpan ?? 1, colSpan: cell.colSpan ?? 1, covered: cell.colSpan === 0 }])));
    }
  };
  visit(document.blocks, "body");
  visit(document.header?.blocks ?? [], "header");
  visit(document.footer?.blocks ?? [], "footer");
  return entries;
}

export function parseWriterReadScope(value: unknown): WriterReadScope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  const allowed = s["kind"] === "range" ? ["kind", "fromBlockId", "toBlockId"] : s["kind"] === "block" ? ["kind", "blockId"] : s["kind"] === "section" ? ["kind", "headingBlockId"] : ["kind"];
  if (Object.keys(s).some(key => !allowed.includes(key))) return null;
  const id = (key: string) => typeof s[key] === "string" && s[key].trim().length > 0;
  if (s["kind"] === "document" || s["kind"] === "selection") return { kind: s["kind"] };
  if (s["kind"] === "section" && id("headingBlockId")) return { kind: "section", headingBlockId: s["headingBlockId"] as string };
  if (s["kind"] === "block" && id("blockId")) return { kind: "block", blockId: s["blockId"] as string };
  if (s["kind"] === "range" && id("fromBlockId") && id("toBlockId")) return { kind: "range", fromBlockId: s["fromBlockId"] as string, toBlockId: s["toBlockId"] as string };
  return null;
}

function select(entries: WriterReadEntry[], scope: WriterReadScope, selection?: DocRange): WriterReadEntry[] | WriterReadError {
  const find = (id: string) => entries.findIndex(e => e.id === id);
  const subtreeEnd = (index: number) => {
    const entry = entries[index]!;
    let end = index + 1;
    while (end < entries.length && entries[end]!.tablePath?.some(p => p.tableBlockId === entry.id)) end++;
    return end;
  };
  if (scope.kind === "document") return entries;
  if (scope.kind === "selection") {
    if (!selection) return fail("No captured Writer selection is available. Select text in Writer, then read again, or use document scope.");
    const a = find(selection.anchor.blockId), f = find(selection.focus["blockId"]);
    const valid = (i: number, n: number) => i >= 0 && Number.isInteger(n) && n >= 0 && n <= entries[i]!.textLength &&
      !(/[\uD800-\uDBFF]/u.test(entries[i]!.text.charAt(n - 1)) && /[\uDC00-\uDFFF]/u.test(entries[i]!.text.charAt(n)));
    if (!valid(a, selection.anchor.offset) || !valid(f, selection.focus.offset)) return fail("Captured selection is stale. Select the text again and restart the read without a cursor.");
    const rectangle = selection.tableCellRange;
    if (rectangle) {
      const table = entries[find(rectangle.blockId)]?.table;
      const { start, end } = rectangle;
      if (!table || ![start.rowIndex, start.colIndex, end.rowIndex, end.colIndex].every(n => Number.isInteger(n) && n >= 0) || Math.max(start.rowIndex, end.rowIndex) >= table.rowCount || Math.max(start.colIndex, end.colIndex) >= table.columnCount) return fail("Captured table selection is stale. Select the cells again and restart the read.");
      return entries.filter(e => e.tablePath?.some(p => p.tableBlockId === rectangle.blockId && p.rowIndex >= Math.min(start.rowIndex, end.rowIndex) && p.rowIndex <= Math.max(start.rowIndex, end.rowIndex) && p.colIndex >= Math.min(start.colIndex, end.colIndex) && p.colIndex <= Math.max(start.colIndex, end.colIndex)));
    }
    if (a === f && selection.anchor.offset === selection.focus.offset) return fail("The captured selection is only a caret. Select text in Writer or use block scope to read its paragraph.");
    const forward = a < f || (a === f && selection.anchor.offset <= selection.focus.offset);
    const first = forward ? selection.anchor : selection.focus, last = forward ? selection.focus : selection.anchor;
    return entries.slice(Math.min(a, f), Math.max(a, f) + 1).map(e => {
      const startOffset = e.id === first.blockId ? first.offset : 0;
      const endOffset = e.id === last.blockId ? last.offset : e.textLength;
      return { ...e, startOffset, endOffset, text: e.text.slice(startOffset, endOffset) };
    });
  }
  const start = find(scope.kind === "section" ? scope.headingBlockId : scope.kind === "range" ? scope.fromBlockId : scope.blockId);
  if (start < 0) return fail("Scope start block was not found. Refresh the document outline and restart the read without a cursor.");
  if (scope.kind === "block") return entries.slice(start, subtreeEnd(start));
  if (scope.kind === "range") {
    const end = find(scope.toBlockId);
    if (end < start || entries[end]?.region !== entries[start]?.region) return fail("Range endpoints must exist in forward order within one document region. Refresh the outline and choose valid endpoints.");
    return entries.slice(start, subtreeEnd(end));
  }
  const heading = entries[start]!;
  if (heading.type !== "heading" || heading.tablePath) return fail("Section scope requires a heading outside a table. Choose a heading from the document outline.");
  let end = start + 1;
  while (end < entries.length && entries[end]!.region === heading.region && !(entries[end]!.type === "heading" && !entries[end]!.tablePath && (entries[end]!.headingLevel ?? 1) <= (heading.headingLevel ?? 1))) end++;
  return entries.slice(start, end);
}

/** Budget is host-owned and includes the entire serialized response and continuation. */
export async function readWriterContext(input: WriterReadArgs & { document: Document; canonicalSource: string; responseBudgetBytes?: number | undefined; selection?: DocRange | undefined; sessionIdentity?: string | undefined }): Promise<WriterContextRead | WriterReadError> {
  const budget = input.responseBudgetBytes;
  if (!Number.isSafeInteger(budget) || budget! <= 0) return fail("Writer read requires a positive host readResponseBudgetBytes. Configure the active runtime response budget and retry.");
  const scope = parseWriterReadScope(input.scope);
  if (!scope) return fail("Provide scope.kind document, selection, section, range, or block with its required block IDs.");
  const entries = buildWriterReadEntries(input.document);
  const selected = select(entries, scope, input.selection);
  if (!Array.isArray(selected)) return selected;
  const sourceFingerprint = await writerReadFingerprint(input.canonicalSource);
  const binding = await writerReadFingerprint(JSON.stringify([sourceFingerprint, input.sessionIdentity ?? input.sessionToken, input.documentVersion, scope, scope.kind === "selection" ? input.selection : null]));
  let index = 0, offset = selected[0]?.startOffset ?? 0;
  if (input.cursor !== undefined) {
    try {
      const decoded: unknown = JSON.parse(atob(input.cursor));
      if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== binding || !Number.isInteger(decoded[1]) || !Number.isInteger(decoded[2])) throw new Error();
      index = decoded[1] as number; offset = decoded[2] as number;
      const entry = selected[index];
      if (!entry || offset < entry.startOffset || offset > entry.endOffset || (offset > 0 && /[\uD800-\uDBFF]/u.test(entry.text.charAt(offset - entry.startOffset - 1)) && /[\uDC00-\uDFFF]/u.test(entry.text.charAt(offset - entry.startOffset)))) throw new Error();
    } catch { return fail("Continuation cursor is malformed or stale for this source, version, session, scope, or selection. Restart the same scope without cursor against the current documentVersion."); }
  }
  const result = (blocks: WriterReadEntry[], nextIndex: number, nextOffset: number): WriterContextRead => ({
    ok: true, status: "context_read", documentVersion: input.documentVersion, scope, sourceFingerprint,
    blockCount: input.document.blocks.length, totalEntries: entries.length,
    bounds: { fromOrdinal: selected[0]?.ordinal ?? null, toOrdinal: selected.at(-1)?.ordinal ?? null }, blocks,
    complete: nextIndex >= selected.length,
    nextRead: nextIndex >= selected.length ? null : { sessionToken: input.sessionToken, documentVersion: input.documentVersion, scope, cursor: btoa(JSON.stringify([binding, nextIndex, nextOffset])) },
  });
  const output: WriterReadEntry[] = [];
  while (index < selected.length) {
    const entry = selected[index]!;
    // Keep a table row together when it fits a fresh page. Oversized rows
    // continue through the ordinary block/text path with explicit coordinates.
    const row = entry.tablePath?.[0];
    const previousRow = selected[index - 1]?.tablePath?.[0];
    if (row && offset === entry.startOffset &&
      (!previousRow || previousRow.tableBlockId !== row.tableBlockId || previousRow.rowIndex !== row.rowIndex)) {
      let rowEnd = index + 1;
      while (rowEnd < selected.length && selected[rowEnd]!.tablePath?.[0]?.tableBlockId === row.tableBlockId &&
        selected[rowEnd]!.tablePath?.[0]?.rowIndex === row.rowIndex) rowEnd++;
      const rowEntries = selected.slice(index, rowEnd);
      const rowNextOffset = selected[rowEnd]?.startOffset ?? 0;
      if (bytes(result(rowEntries, rowEnd, rowNextOffset)) <= budget!) {
        if (bytes(result([...output, ...rowEntries], rowEnd, rowNextOffset)) > budget!) break;
        output.push(...rowEntries); index = rowEnd; offset = rowNextOffset; continue;
      }
    }
    const slice = (end: number) => ({ ...entry, text: entry.text.slice(offset - entry.startOffset, end - entry.startOffset), startOffset: offset, endOffset: end });
    const nextOffset = selected[index + 1]?.startOffset ?? 0;
    if (bytes(result([...output, slice(entry.endOffset)], index + 1, nextOffset)) <= budget!) {
      output.push(slice(entry.endOffset)); index++; offset = nextOffset; continue;
    }
    // Keep an ordinary paragraph whole when it fits on its own page.
    if (output.length && bytes(result([slice(entry.endOffset)], index + 1, nextOffset)) <= budget!) break;
    // Binary search exact serialized UTF-8 size, rounding only at Unicode code points.
    const safeEnd = (end: number) => end > offset && /[\uD800-\uDBFF]/u.test(entry.text.charAt(end - entry.startOffset - 1)) && /[\uDC00-\uDFFF]/u.test(entry.text.charAt(end - entry.startOffset)) ? end - 1 : end;
    let low = offset, high = entry.endOffset;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const end = safeEnd(mid);
      if (bytes(result([...output, slice(end)], index, end)) <= budget!) low = mid;
      else high = mid - 1;
    }
    const end = safeEnd(low);
    if (end > offset) { output.push(slice(end)); offset = end; }
    break;
  }
  const page = result(output, index, offset);
  if ((selected.length > 0 && output.length === 0) || bytes(page) > budget!) return fail("Host readResponseBudgetBytes cannot fit the response envelope and one content unit. Increase the runtime response budget and restart this read; no text has been omitted.");
  return page;
}
