import type { Block, Document, Inline, InlineStyle } from "@nautilo/office-docs/node";
import type { BlockTypeChange, InlineStylePatch } from "./proposal-contract";
import { normalizeProposalOperations } from "./proposal-normalizer";
import type { ResolvedProposalOperation, ResolvedRange } from "./proposal-resolver";
import {
  deleteTableBlock,
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
  mergeTableCells,
  setTableCellStyle,
  splitTableCell,
} from "./table-document-ops";

export type DocumentOperationMetadata = {
  /** Source proposal identity; never the physical application position. */
  operationIndex?: number;
  kind: ResolvedProposalOperation["kind"];
  blockId: string;
  range?: ResolvedRange;
  /** Stable logical review group; all members must be accepted together. */
  groupId?: string;
  /** Earlier operations required for this operation to remain valid. */
  dependencyOperationIndexes?: number[];
};
export type DocumentOperationResult =
  | { ok: true; document: Document; operations: DocumentOperationMetadata[] }
  | { ok: false; code: "unknown_block" | "invalid_range" | "invalid_destination" | "duplicate_id" | "invalid_table"; message: string; document: Document; operationIndex?: number };

type TextBlock = Block & { inlines: Inline[] };

function cloneDocument(document: Document): Document {
  return structuredClone(document);
}
function textOf(block: TextBlock): string {
  return block.inlines.map((inline) => inline.text).join("");
}
function isTextBlock(block: Block | undefined): block is TextBlock {
  return !!block && Array.isArray((block as { inlines?: unknown }).inlines);
}
function rangeIsValid(range: ResolvedRange, text: string): boolean {
  return Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.start <= range.end && range.end <= text.length;
}
function styleAt(block: TextBlock, offset: number): InlineStyle {
  let cursor = 0;
  for (const inline of block.inlines) {
    const end = cursor + inline.text.length;
    if (offset <= end) return { ...inline.style };
    cursor = end;
  }
  return block.inlines.length > 0 ? { ...block.inlines[block.inlines.length - 1]!.style } : {};
}
function pushInline(out: Inline[], text: string, style: InlineStyle): void {
  if (text.length > 0) out.push({ text, style: { ...style } });
}
function replaceTextRange(block: TextBlock, range: ResolvedRange, replacement: string): TextBlock {
  const next: Inline[] = [];
  let cursor = 0;
  let inserted = false;
  const replacementStyle = styleAt(block, range.start);
  for (const inline of block.inlines) {
    const start = cursor;
    const end = start + inline.text.length;
    if (end <= range.start || start >= range.end) {
      if (!inserted && start >= range.end) {
        pushInline(next, replacement, replacementStyle);
        inserted = true;
      }
      pushInline(next, inline.text, inline.style);
    } else {
      pushInline(next, inline.text.slice(0, Math.max(0, range.start - start)), inline.style);
      if (!inserted) {
        pushInline(next, replacement, replacementStyle);
        inserted = true;
      }
      pushInline(next, inline.text.slice(Math.max(0, range.end - start)), inline.style);
    }
    cursor = end;
  }
  if (!inserted) pushInline(next, replacement, replacementStyle);
  return { ...block, inlines: next.length > 0 ? next : [{ text: "", style: replacementStyle }] };
}
function formatTextRange(block: TextBlock, range: ResolvedRange, patch: InlineStylePatch): TextBlock {
  const next: Inline[] = [];
  let cursor = 0;
  for (const inline of block.inlines) {
    const start = cursor;
    const end = start + inline.text.length;
    const selectedStart = Math.max(start, range.start);
    const selectedEnd = Math.min(end, range.end);
    if (selectedStart >= selectedEnd) {
      pushInline(next, inline.text, inline.style);
    } else {
      pushInline(next, inline.text.slice(0, selectedStart - start), inline.style);
      pushInline(next, inline.text.slice(selectedStart - start, selectedEnd - start), { ...inline.style, ...patch });
      pushInline(next, inline.text.slice(selectedEnd - start), inline.style);
    }
    cursor = end;
  }
  return { ...block, inlines: next };
}
function applyBlockType(block: TextBlock, change: BlockTypeChange): TextBlock {
  const next = { ...block, type: change.type } as TextBlock & { headingLevel?: number; listKind?: "ordered" | "unordered"; listLevel?: number };
  delete next.headingLevel;
  delete next.listKind;
  delete next.listLevel;
  if (change.type === "heading") next.headingLevel = change.headingLevel ?? 1;
  if (change.type === "list-item") {
    next.listKind = change.listKind ?? "unordered";
    next.listLevel = change.listLevel ?? 0;
  }
  return next;
}
function duplicateIds(blocks: readonly Block[]): boolean {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (ids.has(block.id)) return true;
    ids.add(block.id);
    if (block.type === "table" && block.tableData) {
      for (const row of block.tableData.rows) for (const cell of row.cells) for (const nested of cell.blocks) {
        if (ids.has(nested.id)) return true;
        ids.add(nested.id);
      }
    }
  }
  return false;
}
function nestedBlockLocation(blocks: Block[], id: string): { tableIndex: number; rowIndex: number; cellIndex: number; blockIndex: number } | null {
  for (let tableIndex = 0; tableIndex < blocks.length; tableIndex++) {
    const table = blocks[tableIndex];
    if (table?.type !== "table" || !table.tableData) continue;
    for (let rowIndex = 0; rowIndex < table.tableData.rows.length; rowIndex++) {
      const row = table.tableData.rows[rowIndex]!;
      for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex++) {
        const cell = row.cells[cellIndex]!;
        if (cell.colSpan === 0) continue;
        const blockIndex = cell.blocks.findIndex((block) => block.id === id);
        if (blockIndex >= 0) return { tableIndex, rowIndex, cellIndex, blockIndex };
      }
    }
  }
  return null;
}

/**
 * Applies an already-resolved operation batch to a cloned document. On failure,
 * callers receive the original document reference so no partial proposal escapes.
 */
export function applyDocumentOperations(
  document: Document,
  operations: readonly ResolvedProposalOperation[],
): DocumentOperationResult {
  if (duplicateIds(document.blocks)) return { ok: false, code: "duplicate_id", message: "document contains duplicate block IDs", document };
  // Resolved proposal batches carry source identities and use the shared base
  // planner. This primitive also supports legacy local document transforms,
  // which intentionally retain their explicit caller-provided order.
  const normalized = operations.every((operation) => operation.operationIndex !== undefined)
    ? normalizeProposalOperations(document, operations)
    : { ok: true as const, operations: [...operations] };
  if (!normalized.ok) return { ok: false, code: "invalid_range", message: normalized.message, document };
  const next = cloneDocument(document);
  const metadata: DocumentOperationMetadata[] = [];
  for (let physicalIndex = 0; physicalIndex < normalized.operations.length; physicalIndex++) {
    const operation = normalized.operations[physicalIndex]!;
    const operationIndex = operation.operationIndex ?? physicalIndex;
    if ("tableBlockId" in operation) {
      const tableIndex = next.blocks.findIndex((block) => block.id === operation.tableBlockId && block.type === "table" && block.tableData);
      if (tableIndex < 0) return { ok: false, code: "unknown_block", message: `table "${operation.tableBlockId}" does not exist`, document, operationIndex };
      if (operation.kind === "delete-table") {
        const nextBlocks = deleteTableBlock(next.blocks, operation.tableBlockId);
        if (!nextBlocks) return { ok: false, code: "unknown_block", message: `table "${operation.tableBlockId}" does not exist`, document, operationIndex };
        next.blocks = nextBlocks;
        metadata.push({ operationIndex, kind: operation.kind, blockId: operation.tableBlockId });
        continue;
      }
      const table = next.blocks[tableIndex]!;
      const source = table.tableData!;
      const result = operation.kind === "insert-table-row" ? insertTableRow(source, operation.rowIndex)
        : operation.kind === "delete-table-row" ? deleteTableRow(source, operation.rowIndex)
        : operation.kind === "insert-table-column" ? insertTableColumn(source, operation.colIndex)
        : operation.kind === "delete-table-column" ? deleteTableColumn(source, operation.colIndex)
        : operation.kind === "merge-table-cells" ? mergeTableCells(source, operation.start, operation.end)
        : operation.kind === "split-table-cell" ? splitTableCell(source, operation.cell)
        : setTableCellStyle(source, operation.cell, operation.style);
      if (!result.ok) return { ok: false, code: "invalid_table", message: result.message, document, operationIndex };
      next.blocks[tableIndex] = { ...table, tableData: result.tableData };
      metadata.push({ operationIndex, kind: operation.kind, blockId: operation.tableBlockId });
      continue;
    }
    const index = next.blocks.findIndex((block) => block.id === operation.blockId);
    const nested = index < 0 ? nestedBlockLocation(next.blocks, operation.blockId) : null;
    if (index < 0 && !nested) return { ok: false, code: "unknown_block", message: `block "${operation.blockId}" does not exist`, document, operationIndex };
    if (operation.kind === "move-block") {
      if (nested) return { ok: false, code: "invalid_destination", message: "nested table cell blocks cannot be moved", document, operationIndex };
      const [moved] = next.blocks.splice(index, 1);
      if (!moved) return { ok: false, code: "unknown_block", message: `block "${operation.blockId}" does not exist`, document, operationIndex };
      let destination = next.blocks.length;
      if (operation.destination.position === "start") destination = 0;
      const destinationSpec = operation.destination;
      if (destinationSpec.position === "after") {
        const after = next.blocks.findIndex((block) => block.id === destinationSpec.afterBlockId);
        if (after < 0) return { ok: false, code: "invalid_destination", message: "move destination does not exist", document, operationIndex };
        destination = after + 1;
      }
      next.blocks.splice(destination, 0, moved);
      metadata.push({ operationIndex, kind: operation.kind, blockId: operation.blockId });
      continue;
    }
    const block = nested
      ? next.blocks[nested.tableIndex]!.tableData!.rows[nested.rowIndex]!.cells[nested.cellIndex]!.blocks[nested.blockIndex]
      : next.blocks[index];
    if (!isTextBlock(block)) return { ok: false, code: "invalid_range", message: `block "${operation.blockId}" does not carry inline text`, document, operationIndex };
    const propertyOnly = operation.kind === "format-block" || operation.kind === "set-block-type";
    // Property-only operations retain a base-snapshot range for review
    // metadata, but never consume text coordinates while applying.
    if (!propertyOnly && !rangeIsValid(operation.range, textOf(block))) {
      return { ok: false, code: "invalid_range", message: "resolved range is outside the logical block text", document, operationIndex };
    }
    switch (operation.kind) {
      case "insert":
        if (operation.range.start !== operation.range.end) return { ok: false, code: "invalid_range", message: "insert requires a collapsed range", document, operationIndex };
        if (nested) next.blocks[nested.tableIndex]!.tableData!.rows[nested.rowIndex]!.cells[nested.cellIndex]!.blocks[nested.blockIndex] = replaceTextRange(block, operation.range, operation.text);
        else next.blocks[index] = replaceTextRange(block, operation.range, operation.text);
        break;
      case "delete":
        if (nested) next.blocks[nested.tableIndex]!.tableData!.rows[nested.rowIndex]!.cells[nested.cellIndex]!.blocks[nested.blockIndex] = replaceTextRange(block, operation.range, "");
        else next.blocks[index] = replaceTextRange(block, operation.range, "");
        break;
      case "replace":
        if (nested) next.blocks[nested.tableIndex]!.tableData!.rows[nested.rowIndex]!.cells[nested.cellIndex]!.blocks[nested.blockIndex] = replaceTextRange(block, operation.range, operation.text);
        else next.blocks[index] = replaceTextRange(block, operation.range, operation.text);
        break;
      case "format-inline":
        if (nested) next.blocks[nested.tableIndex]!.tableData!.rows[nested.rowIndex]!.cells[nested.cellIndex]!.blocks[nested.blockIndex] = formatTextRange(block, operation.range, operation.style);
        else next.blocks[index] = formatTextRange(block, operation.range, operation.style);
        break;
      case "format-block":
        if (nested) next.blocks[nested.tableIndex]!.tableData!.rows[nested.rowIndex]!.cells[nested.cellIndex]!.blocks[nested.blockIndex] = { ...block, style: { ...block.style, ...operation.style } };
        else next.blocks[index] = { ...block, style: { ...block.style, ...operation.style } };
        break;
      case "set-block-type":
        if (nested) next.blocks[nested.tableIndex]!.tableData!.rows[nested.rowIndex]!.cells[nested.cellIndex]!.blocks[nested.blockIndex] = applyBlockType(block, operation.blockType);
        else next.blocks[index] = applyBlockType(block, operation.blockType);
        break;
    }
    metadata.push({ operationIndex, kind: operation.kind, blockId: operation.blockId, range: operation.range });
  }
  return duplicateIds(next.blocks)
    ? { ok: false, code: "duplicate_id", message: "operation produced duplicate block IDs", document }
    : { ok: true, document: next, operations: metadata };
}
