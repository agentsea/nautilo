import { getBlockText, type Block } from "@nautilo/office-docs/node";
import { normalizeProposalText, type ResolvedRange } from "./proposal-resolver";

export const TABLE_READ_CELL_LIMIT = 50;
export const TABLE_READ_BYTE_LIMIT = 4_000;

/**
 * A validated logical position, not a source-document offset. A later page
 * recomputes its text slice from this coordinate against the session's
 * canonical revision.
 */
export type TableReadCursor = {
  rowIndex: number;
  colIndex: number;
  blockIndex: number;
  sliceIndex: number;
};

export type CanonicalTableCell = {
  rowIndex: number;
  colIndex: number;
  editable: boolean;
  textComplete: boolean;
  blocks?: Array<{
    id: string;
    type: string;
    text: string;
    textComplete: boolean;
    continuation?: TableReadCursor;
  }>;
  mergedAnchor?: { rowSpan: number; colSpan: number };
  coveredBy?: { rowIndex: number; colIndex: number };
};

export type CanonicalTablePayload = {
  tableBlockId: string;
  rowCount: number;
  columnCount: number;
  cells: CanonicalTableCell[];
  nextCursor?: TableReadCursor;
};

export type WriterLiveAnchor = {
  before?: string;
  target: string;
  after?: string;
};

export type WriterLiveLocatorResult =
  | { ok: true; range: ResolvedRange }
  | { ok: false; code: "anchor_not_found" | "anchor_ambiguous"; message: string };

function occurrences(text: string, needle: string): number[] {
  const indexes: number[] = [];
  for (let from = 0; from <= text.length - needle.length;) {
    const index = text.indexOf(needle, from);
    if (index < 0) break;
    indexes.push(index);
    from = index + Math.max(1, needle.length);
  }
  return indexes;
}

/**
 * Resolves a small target using immediately adjacent, canonical context.
 * The returned offsets stay server-internal; callers mint an opaque handle.
 */
export function locateWriterText(
  text: string,
  anchor: WriterLiveAnchor,
): WriterLiveLocatorResult {
  const normalized = normalizeProposalText(text);
  const before = normalizeProposalText(anchor.before ?? "").text;
  const target = normalizeProposalText(anchor.target).text;
  const after = normalizeProposalText(anchor.after ?? "").text;
  if (!target) return { ok: false, code: "anchor_not_found", message: "target is empty after normalization" };

  const candidates = occurrences(normalized.text, target).filter((start) => {
    const end = start + target.length;
    return (!before || normalized.text.slice(0, start).trimEnd().endsWith(before))
      && (!after || normalized.text.slice(end).trimStart().startsWith(after));
  });
  if (candidates.length === 0) {
    return { ok: false, code: "anchor_not_found", message: "before/target/after context does not occur in the specified block" };
  }
  if (candidates.length > 1) {
    return { ok: false, code: "anchor_ambiguous", message: "before/target/after context occurs more than once in the specified block" };
  }
  const start = candidates[0]!;
  const end = start + target.length;
  return {
    ok: true,
    range: {
      start: normalized.starts[start]!,
      end: normalized.ends[end - 1]!,
    },
  };
}

export function boundedCanonicalBlocks(
  blocks: readonly Block[],
  blockId: string,
  beforeBlocks = 0,
  afterBlocks = 0,
): Array<{ id: string; type: string; text: string }> | null {
  const index = blocks.findIndex((block) => block?.id === blockId);
  if (index < 0) {
    for (const table of blocks) {
      if (table.type !== "table" || !table.tableData) continue;
      for (const row of table.tableData.rows) for (const cell of row.cells) {
        if (cell.colSpan === 0) continue;
        const nestedIndex = cell.blocks.findIndex((block) => block.id === blockId);
        if (nestedIndex >= 0) {
          const start = Math.max(0, nestedIndex - beforeBlocks);
          const end = Math.min(cell.blocks.length, nestedIndex + afterBlocks + 1);
          return cell.blocks.slice(start, end).map((block) => ({ id: block.id, type: block.type, text: getBlockText(block) }));
        }
      }
    }
    return null;
  }
  const start = Math.max(0, index - beforeBlocks);
  const end = Math.min(blocks.length, index + afterBlocks + 1);
  return blocks.slice(start, end).map((block) => ({
    id: block.id,
    type: block.type,
    text: getBlockText(block),
  }));
}

function coveredBy(
  table: Block,
  rowIndex: number,
  colIndex: number,
): { rowIndex: number; colIndex: number } | undefined {
  const rows = table.tableData!.rows;
  for (let row = 0; row <= rowIndex; row++) {
    for (let col = 0; col <= colIndex; col++) {
      const candidate = rows[row]?.cells[col];
      if (!candidate || candidate.colSpan === 0) continue;
      const rowSpan = candidate.rowSpan ?? 1;
      const colSpan = candidate.colSpan ?? 1;
      if (row + rowSpan > rowIndex && col + colSpan > colIndex) {
        return { rowIndex: row, colIndex: col };
      }
    }
  }
  return undefined;
}

/**
 * Reads table cells as addressable nested blocks. This deliberately never
 * joins cell text: text remains associated with its editable cell block.
 */
export function isTableReadCursor(value: unknown): value is TableReadCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as TableReadCursor;
  return [cursor.rowIndex, cursor.colIndex, cursor.blockIndex, cursor.sliceIndex]
    .every((part) => Number.isInteger(part) && part >= 0);
}

function nextCellCursor(table: Block, rowIndex: number, colIndex: number): TableReadCursor | undefined {
  const rows = table.tableData!.rows;
  if (colIndex + 1 < rows[rowIndex]!.cells.length) {
    return { rowIndex, colIndex: colIndex + 1, blockIndex: 0, sliceIndex: 0 };
  }
  for (let row = rowIndex + 1; row < rows.length; row++) {
    if (rows[row]!.cells.length > 0) return { rowIndex: row, colIndex: 0, blockIndex: 0, sliceIndex: 0 };
  }
  return undefined;
}

function utf8CodePointByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index)!;
    bytes += utf8CodePointByteLength(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  return bytes;
}

type Utf8Slice = { text: string; byteLength: number; textComplete: boolean };

/**
 * Replays the fixed-byte chunking in one bounded scan. The cursor contains a
 * chunk ordinal, never a source offset; its maximum is validated before this
 * runs so a malicious sliceIndex cannot induce an unbounded loop.
 */
function utf8SliceAtIndex(source: string, sliceIndex: number): Utf8Slice | null {
  const totalBytes = utf8ByteLength(source);
  const maximumSlices = Math.ceil(totalBytes / (TABLE_READ_BYTE_LIMIT - 3));
  if (!Number.isSafeInteger(sliceIndex) || sliceIndex < 0 || sliceIndex >= Math.max(1, maximumSlices)) {
    return null;
  }

  let currentSlice = 0;
  let sliceStart = 0;
  let sliceBytes = 0;
  for (let index = 0; index < source.length;) {
    const codePoint = source.codePointAt(index)!;
    const codePointLength = codePoint > 0xffff ? 2 : 1;
    const codePointBytes = utf8CodePointByteLength(codePoint);
    if (sliceBytes > 0 && sliceBytes + codePointBytes > TABLE_READ_BYTE_LIMIT) {
      if (currentSlice === sliceIndex) {
        return { text: source.slice(sliceStart, index), byteLength: sliceBytes, textComplete: false };
      }
      currentSlice += 1;
      sliceStart = index;
      sliceBytes = 0;
    }
    sliceBytes += codePointBytes;
    index += codePointLength;
  }
  if (currentSlice !== sliceIndex) return null;
  return { text: source.slice(sliceStart), byteLength: sliceBytes, textComplete: true };
}

function cursorIsValid(table: Block, cursor: TableReadCursor): boolean {
  if (!isTableReadCursor(cursor)) return false;
  const cell = table.tableData!.rows[cursor.rowIndex]?.cells[cursor.colIndex];
  if (!cell) return false;
  if (cell.colSpan === 0) return cursor.blockIndex === 0 && cursor.sliceIndex === 0;
  const block = cell.blocks[cursor.blockIndex];
  if (!block) return false;
  if (cursor.sliceIndex === 0) return true;
  return utf8SliceAtIndex(getBlockText(block), cursor.sliceIndex) !== null;
}

/**
 * Reads table cells as addressable nested blocks. This deliberately never
 * joins cell text: text remains associated with its editable cell block.
 * Pagination positions are logical coordinates so no raw document offsets
 * cross the tool boundary.
 */
export function boundedCanonicalTable(
  table: Block,
  cursor: TableReadCursor = { rowIndex: 0, colIndex: 0, blockIndex: 0, sliceIndex: 0 },
): CanonicalTablePayload | null {
  if (table.type !== "table" || !table.tableData) return null;
  if (!cursorIsValid(table, cursor)) return null;
  const { rows, columnWidths } = table.tableData;
  const cells: CanonicalTableCell[] = [];
  let remainingBytes = TABLE_READ_BYTE_LIMIT;

  for (let rowIndex = cursor.rowIndex; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!;
    const firstCol = rowIndex === cursor.rowIndex ? cursor.colIndex : 0;
    for (let colIndex = firstCol; colIndex < row.cells.length; colIndex++) {
      if (cells.length >= TABLE_READ_CELL_LIMIT) {
        return {
          tableBlockId: table.id,
          rowCount: rows.length,
          columnCount: columnWidths.length,
          cells,
          nextCursor: { rowIndex, colIndex, blockIndex: 0, sliceIndex: 0 },
        };
      }
      const cell = row.cells[colIndex]!;
      if (cell.colSpan === 0) {
        const coveringCell = coveredBy(table, rowIndex, colIndex);
        cells.push({
          rowIndex,
          colIndex,
          editable: false,
          textComplete: true,
          ...(coveringCell === undefined ? {} : { coveredBy: coveringCell }),
        });
        continue;
      }

      const isCursorCell = rowIndex === cursor.rowIndex && colIndex === cursor.colIndex;
      const firstBlock = isCursorCell ? cursor.blockIndex : 0;
      const firstSlice = isCursorCell ? cursor.sliceIndex : 0;
      const blocks: NonNullable<CanonicalTableCell["blocks"]> = [];
      for (let blockIndex = firstBlock; blockIndex < cell.blocks.length; blockIndex++) {
        const block = cell.blocks[blockIndex]!;
        const source = getBlockText(block);
        const sliceIndex = blockIndex === firstBlock ? firstSlice : 0;
        const slice = utf8SliceAtIndex(source, sliceIndex);
        if (!slice) return null;
        if (slice.byteLength > remainingBytes) {
          return {
            tableBlockId: table.id,
            rowCount: rows.length,
            columnCount: columnWidths.length,
            cells,
            nextCursor: { rowIndex, colIndex, blockIndex, sliceIndex },
          };
        }
        const continuation = slice.textComplete
          ? undefined
          : { rowIndex, colIndex, blockIndex, sliceIndex: sliceIndex + 1 };
        blocks.push({
          id: block.id,
          type: block.type,
          text: slice.text,
          textComplete: slice.textComplete,
          ...(continuation ? { continuation } : {}),
        });
        remainingBytes -= slice.byteLength;
        if (!slice.textComplete) {
          cells.push({
            rowIndex,
            colIndex,
            editable: true,
            textComplete: false,
            blocks,
            ...(cell.rowSpan! > 1 || cell.colSpan! > 1
              ? { mergedAnchor: { rowSpan: cell.rowSpan ?? 1, colSpan: cell.colSpan ?? 1 } }
              : {}),
          });
          return {
            tableBlockId: table.id,
            rowCount: rows.length,
            columnCount: columnWidths.length,
            cells,
            ...(continuation === undefined ? {} : { nextCursor: continuation }),
          };
        }
      }
      const rowSpan = cell.rowSpan ?? 1;
      const colSpan = cell.colSpan ?? 1;
      cells.push({
        rowIndex,
        colIndex,
        editable: true,
        textComplete: firstBlock === 0 && firstSlice === 0,
        blocks,
        ...(rowSpan > 1 || colSpan > 1 ? { mergedAnchor: { rowSpan, colSpan } } : {}),
      });
      if (cells.length === TABLE_READ_CELL_LIMIT) {
        const nextCursor = nextCellCursor(table, rowIndex, colIndex);
        return {
          tableBlockId: table.id,
          rowCount: rows.length,
          columnCount: columnWidths.length,
          cells,
          ...(nextCursor ? { nextCursor } : {}),
        };
      }
      if (remainingBytes === 0) {
        const nextCursor = nextCellCursor(table, rowIndex, colIndex);
        return {
          tableBlockId: table.id,
          rowCount: rows.length,
          columnCount: columnWidths.length,
          cells,
          ...(nextCursor ? { nextCursor } : {}),
        };
      }
    }
  }

  return {
    tableBlockId: table.id,
    rowCount: rows.length,
    columnCount: columnWidths.length,
    cells,
  };
}

/** Finds a text block without ever flattening table content or exposing covered cells. */
export function findCanonicalTextBlock(blocks: readonly Block[], blockId: string): Block | null {
  const topLevel = blocks.find((block) => block.id === blockId);
  if (topLevel) return Array.isArray(topLevel.inlines) ? topLevel : null;
  for (const table of blocks) {
    if (table.type !== "table" || !table.tableData) continue;
    for (const row of table.tableData.rows) for (const cell of row.cells) {
      if (cell.colSpan === 0) continue;
      const nested = cell.blocks.find((block) => block.id === blockId);
      if (nested) return nested;
    }
  }
  return null;
}
