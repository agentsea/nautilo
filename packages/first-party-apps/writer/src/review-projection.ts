import { createBlock, type Block, type Document, type Inline, type InlineStyle } from "@nautilo/office-docs/node";
import type { DocumentOperationMetadata } from "./document-ops";
import type { StructuralChange } from "./structural-diff";

export const REVIEW_DELETE_STYLE: Readonly<InlineStyle> = {
  color: "#c62828",
  strikethrough: true,
};

export const REVIEW_INSERT_STYLE: Readonly<InlineStyle> = {
  color: "#2e7d32",
  underline: true,
};

export const REVIEW_FORMAT_STYLE: Readonly<InlineStyle> = {
  backgroundColor: "#fff3cd",
};

export type ReviewProjectionAnchor =
  | { role: "delete" | "insert"; blockId: string; offset: number; length: number }
  | { role: "source" | "destination"; blockId: string; index: number }
  | { role: "cell" | "table"; blockId: string; tableId: string; rowIndex?: number; colIndex?: number };

/**
 * A review item is intentionally separate from its visual spans: a replacement
 * has two spans but exactly one item, identified by its StructuralChange ID.
 */
export type ReviewProjectionItem = {
  id: string;
  kind: StructuralChange["kind"];
  changeIds: readonly string[];
  operationIndexes: readonly number[];
  anchors: readonly ReviewProjectionAnchor[];
};

export type ReviewProjection = {
  document: Document;
  items: readonly ReviewProjectionItem[];
  operationMetadata: readonly DocumentOperationMetadata[];
};

export type ReviewSurfaceState = {
  changes: readonly StructuralChange[];
  activeChangeId: string | null;
  isFinalAcceptedState: boolean;
  canSaveAcceptedChanges: boolean;
  shouldRenderProjection: true;
};

/**
 * Keeps the review surface mounted while its final accepted batch awaits the
 * single durable save. The caller supplies only the unresolved changes, so the
 * accepted detached document remains the projection source without a fallback.
 */
export function reviewSurfaceState(
  changes: readonly StructuralChange[],
  acceptedOperationIndexes: readonly number[],
  activeChangeId?: string | null,
): ReviewSurfaceState {
  const isFinalAcceptedState = changes.length === 0 && acceptedOperationIndexes.length > 0;
  return {
    changes,
    activeChangeId: activeChangeId && changes.some((change) => change.id === activeChangeId)
      ? activeChangeId
      : changes[0]?.id ?? null,
    isFinalAcceptedState,
    canSaveAcceptedChanges: isFinalAcceptedState,
    shouldRenderProjection: true,
  };
}

type TextBlock = Block & { inlines?: Inline[] };
type TextChange = Extract<StructuralChange, { kind: "inline-insert" | "inline-delete" | "inline-replace" }>;
type FormatChange = Extract<StructuralChange, { kind: "inline-style" | "block-style" | "block-type" }>;
type TableChange = Extract<StructuralChange, { tableId: string }>;
type TableCell = { blocks: TextBlock[]; style?: Record<string, unknown>; colSpan?: number; rowSpan?: number };
type TableBlock = Block & {
  type: "table";
  tableData?: { rows: Array<{ cells: TableCell[] }>; columnWidths: unknown[] };
};

function isTextBlock(block: Block): block is TextBlock {
  return Array.isArray((block as TextBlock).inlines);
}

function isTableBlock(block: Block | undefined): block is TableBlock {
  return block?.type === "table" && !!(block as TableBlock).tableData;
}

function styleAt(block: TextBlock, offset: number, preferFollowing = false): InlineStyle {
  let cursor = 0;
  for (const inline of block.inlines ?? []) {
    const end = cursor + inline.text.length;
    if (preferFollowing ? offset < end : offset <= end) return { ...inline.style };
    cursor = end;
  }
  return block.inlines?.length ? { ...block.inlines[block.inlines.length - 1]!.style } : {};
}

function appendInline(inlines: Inline[], text: string, style: InlineStyle): void {
  if (text.length > 0) inlines.push({ text, style: { ...style } });
}

function appendBaseRange(out: Inline[], block: TextBlock, start: number, end: number): void {
  let cursor = 0;
  for (const inline of block.inlines ?? []) {
    const inlineStart = cursor;
    const inlineEnd = cursor + inline.text.length;
    const rangeStart = Math.max(start, inlineStart);
    const rangeEnd = Math.min(end, inlineEnd);
    if (rangeStart < rangeEnd) {
      appendInline(out, inline.text.slice(rangeStart - inlineStart, rangeEnd - inlineStart), inline.style);
    }
    cursor = inlineEnd;
  }
}

function reviewStyle(base: InlineStyle, kind: "delete" | "insert"): InlineStyle {
  return {
    ...base,
    ...(kind === "delete" ? REVIEW_DELETE_STYLE : REVIEW_INSERT_STYLE),
  };
}

function formatStyle(base: InlineStyle): InlineStyle {
  return { ...base, ...REVIEW_FORMAT_STYLE };
}

function projectTextBlock(block: TextBlock, changes: readonly TextChange[]): TextBlock {
  const inlines: Inline[] = [];
  let cursor = 0;
  for (const change of changes) {
    appendBaseRange(inlines, block, cursor, change.start);
    if (change.before) appendInline(inlines, change.before, reviewStyle(styleAt(block, change.start, true), "delete"));
    if (change.after) appendInline(inlines, change.after, reviewStyle(styleAt(block, change.start), "insert"));
    cursor = change.end;
  }
  const textLength = (block.inlines ?? []).reduce((length, inline) => length + inline.text.length, 0);
  appendBaseRange(inlines, block, cursor, textLength);
  return { ...block, inlines: inlines.length > 0 ? inlines : [{ text: "", style: styleAt(block, 0) }] };
}

function overlayRange(block: TextBlock, start: number, end: number): TextBlock {
  const inlines: Inline[] = [];
  let cursor = 0;
  for (const inline of block.inlines ?? []) {
    const inlineStart = cursor;
    const inlineEnd = cursor + inline.text.length;
    const selectedStart = Math.max(start, inlineStart);
    const selectedEnd = Math.min(end, inlineEnd);
    if (selectedStart >= selectedEnd) {
      appendInline(inlines, inline.text, inline.style);
    } else {
      appendInline(inlines, inline.text.slice(0, selectedStart - inlineStart), inline.style);
      appendInline(inlines, inline.text.slice(selectedStart - inlineStart, selectedEnd - inlineStart), formatStyle(inline.style));
      appendInline(inlines, inline.text.slice(selectedEnd - inlineStart), inline.style);
    }
    cursor = inlineEnd;
  }
  return { ...block, inlines: inlines.length > 0 ? inlines : [{ text: "", style: formatStyle(styleAt(block, 0)) }] };
}

function overlayWholeBlock(block: TextBlock, kind: "delete" | "insert" | "format"): TextBlock {
  const style = kind === "format" ? formatStyle : (base: InlineStyle) => reviewStyle(base, kind);
  const inlines = (block.inlines ?? []).map((inline) => ({ text: inline.text, style: style(inline.style) }));
  return { ...block, inlines: inlines.length > 0 ? inlines : [{ text: "", style: style(styleAt(block, 0)) }] };
}

function textLength(block: TextBlock): number {
  return (block.inlines ?? []).reduce((length, inline) => length + inline.text.length, 0);
}

function formatRanges(change: FormatChange, metadata: readonly DocumentOperationMetadata[], block: TextBlock): Array<{ start: number; end: number }> {
  if (change.kind !== "inline-style") return [{ start: 0, end: textLength(block) }];
  const ranges = change.operationIndexes.flatMap((index) => {
    const operation = metadata[index];
    return operation?.kind === "format-inline" && operation.blockId === change.blockId && operation.range ? [operation.range] : [];
  });
  return ranges.length > 0 ? ranges : [{ start: 0, end: textLength(block) }];
}

function uniqueReviewId(existing: Set<string>, kind: string, changeId: string): string {
  const base = `review:${kind}:${changeId}`;
  let id = base;
  let suffix = 1;
  while (existing.has(id)) id = `${base}:${suffix++}`;
  existing.add(id);
  return id;
}

function textSegments(before: string, after: string): Array<{ start: number; end: number; before: string; after: string }> {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) suffix++;
  return [{
    start: prefix,
    end: before.length - suffix,
    before: before.slice(prefix, before.length - suffix),
    after: after.slice(prefix, after.length - suffix),
  }];
}

function hasNestedStyleChange(before: TextBlock, after: TextBlock): boolean {
  return before.type !== after.type ||
    JSON.stringify(before.style ?? {}) !== JSON.stringify(after.style ?? {}) ||
    JSON.stringify(before.inlines?.map((inline) => inline.style ?? {}) ?? []) !==
      JSON.stringify(after.inlines?.map((inline) => inline.style ?? {}) ?? []);
}

function projectTableTextBlock(before: TextBlock, after: TextBlock | undefined): TextBlock {
  if (!after) return overlayWholeBlock(structuredClone(before), "delete");
  const changes = textSegments(
    (before.inlines ?? []).map((inline) => inline.text).join(""),
    (after.inlines ?? []).map((inline) => inline.text).join(""),
  );
  let projected = projectTextBlock(before, changes.map((change, index) => ({
    id: `table-text:${before.id}:${index}`,
    kind: change.before ? change.after ? "inline-replace" : "inline-delete" : "inline-insert",
    blockId: before.id,
    ...change,
    operationIndexes: [],
  })) as TextChange[]);
  // Text insertions inherit their proposed inline style, while deleted text
  // retains its base style. This is especially important for table cells,
  // where a single change record can cover both wording and formatting.
  projected.inlines = projected.inlines?.map((inline) =>
    inline.style.color === REVIEW_INSERT_STYLE.color && inline.style.underline === true
      ? { ...inline, style: reviewStyle(styleAt(after, 0), "insert") }
      : inline,
  );
  if (hasNestedStyleChange(before, after)) {
    projected = { ...structuredClone(after), id: before.id, inlines: projected.inlines };
    projected = overlayWholeBlock(projected, "format");
  }
  return projected;
}

function reviewLabel(id: string, text: string): TextBlock {
  const label = createBlock("paragraph") as TextBlock;
  label.id = id;
  label.inlines = [{ text, style: { ...REVIEW_FORMAT_STYLE, color: "#7c5a00" } }];
  return label;
}

function tableChangeLabel(change: TableChange): string {
  const { start, end } = change.bounds;
  const place = start.rowIndex === end.rowIndex && start.colIndex === end.colIndex
    ? `cell R${start.rowIndex + 1}C${start.colIndex + 1}`
    : `R${start.rowIndex + 1}C${start.colIndex + 1}–R${end.rowIndex + 1}C${end.colIndex + 1}`;
  const labels: Record<TableChange["kind"], string> = {
    "table-cell-text": "Cell text changed",
    "table-cell-style": "Cell formatting changed",
    "table-row-insert": "Row inserted",
    "table-row-delete": "Row deleted",
    "table-column-insert": "Column inserted",
    "table-column-delete": "Column deleted",
    "table-merge": "Cells merged",
    "table-split": "Cell split",
    "table-delete": "Table deleted",
  };
  return `${labels[change.kind]}: ${place}`;
}

function cellAt(table: TableBlock | undefined, rowIndex: number, colIndex: number): TableCell | undefined {
  return table?.tableData?.rows[rowIndex]?.cells[colIndex];
}

function projectTable(
  base: TableBlock,
  proposed: TableBlock | undefined,
  changes: readonly TableChange[],
  ids: Set<string>,
): TableBlock {
  const hasStructuralChange = changes.some((change) =>
    change.kind !== "table-cell-text" && change.kind !== "table-cell-style",
  );
  const table = structuredClone(
    hasStructuralChange && proposed && changes.every((change) => change.kind !== "table-delete")
      ? proposed
      : base,
  );
  const baseTable = base;
  const proposedTable = proposed ?? base;
  for (const change of changes) {
    if (change.kind !== "table-cell-text" && change.kind !== "table-cell-style") continue;
    const { rowIndex, colIndex } = change.bounds.start;
    const cell = cellAt(table, rowIndex, colIndex);
    const beforeCell = cellAt(baseTable, rowIndex, colIndex);
    const afterCell = cellAt(proposedTable, rowIndex, colIndex);
    if (!cell || !beforeCell || !afterCell) continue;
    if (change.kind === "table-cell-text") {
      const afterById = new Map(afterCell.blocks.map((block) => [block.id, block]));
      const projected = beforeCell.blocks.map((block) => projectTableTextBlock(block, afterById.get(block.id)));
      for (const after of afterCell.blocks) {
        if (!beforeCell.blocks.some((block) => block.id === after.id)) projected.push(overlayWholeBlock(structuredClone(after), "insert"));
      }
      cell.blocks = projected;
    }
    if (change.kind === "table-cell-style") {
      cell.style = { ...(afterCell.style ?? {}), backgroundColor: "#fff3cd" };
      const afterById = new Map(afterCell.blocks.map((block) => [block.id, block]));
      cell.blocks = beforeCell.blocks.map((block) => projectTableTextBlock(block, afterById.get(block.id)));
      const labelId = uniqueReviewId(ids, "table-cell-style", change.id);
      cell.blocks.unshift(reviewLabel(labelId, tableChangeLabel(change)));
    }
  }
  return table;
}

function tableAnchorFor(change: TableChange, document: Document): ReviewProjectionAnchor {
  const table = document.blocks.find((block) => block.id === change.tableId);
  const { rowIndex, colIndex } = change.bounds.start;
  const cell = isTableBlock(table) ? cellAt(table, rowIndex, colIndex) : undefined;
  // Cell-style projection prepends a readable label. Focus the changed cell
  // text whenever it exists; the label is only the empty-cell fallback.
  const cellBlock = cell?.blocks.find((block) => !block.id.startsWith("review:table-cell-style:")) ?? cell?.blocks[0];
  if (change.kind === "table-cell-text" || change.kind === "table-cell-style") {
    return {
      role: "cell",
      blockId: cellBlock?.id ?? change.tableId,
      tableId: change.tableId,
      rowIndex,
      colIndex,
    };
  }
  const label = document.blocks.find((block) => block.id === `review:table-structure:${change.id}`);
  return { role: "table", blockId: label?.id ?? change.tableId, tableId: change.tableId };
}

function itemFor(change: StructuralChange, document?: Document): ReviewProjectionItem {
  if ("tableId" in change && document) {
    return {
      id: change.id,
      kind: change.kind,
      changeIds: [change.id],
      operationIndexes: [...change.operationIndexes],
      anchors: [tableAnchorFor(change, document)],
    };
  }
  if (change.kind === "move") {
    return {
      id: change.id,
      kind: change.kind,
      changeIds: [change.id],
      operationIndexes: [...change.operationIndexes],
      anchors: [
        { role: "source", blockId: change.blockId, index: change.from },
        { role: "destination", blockId: change.blockId, index: change.to },
      ],
    };
  }
  if (change.kind === "inline-insert" || change.kind === "inline-delete" || change.kind === "inline-replace") {
    const anchors: ReviewProjectionAnchor[] = [];
    if (change.before) anchors.push({ role: "delete", blockId: change.blockId, offset: change.start, length: change.before.length });
    if (change.after) anchors.push({ role: "insert", blockId: change.blockId, offset: change.start, length: change.after.length });
    return { id: change.id, kind: change.kind, changeIds: [change.id], operationIndexes: [...change.operationIndexes], anchors };
  }
  return {
    id: change.id,
    kind: change.kind,
    changeIds: [change.id],
    operationIndexes: [...change.operationIndexes],
    anchors: [{ role: "source", blockId: change.blockId, index: 0 }],
  };
}

function projectionItems(changes: readonly StructuralChange[], document: Document): ReviewProjectionItem[] {
  const emittedGroups = new Set<string>();
  return changes.flatMap((change) => {
    if (!("tableId" in change) || !["table-merge", "table-split", "table-delete"].includes(change.kind)) {
      return [itemFor(change, document)];
    }
    if (emittedGroups.has(change.groupId)) return [];
    emittedGroups.add(change.groupId);
    const grouped = changes.filter((candidate): candidate is TableChange =>
      "tableId" in candidate && candidate.groupId === change.groupId,
    );
    return [{
      ...itemFor(change, document),
      changeIds: grouped.map((candidate) => candidate.id),
      operationIndexes: [...new Set(grouped.flatMap((candidate) => candidate.operationIndexes))],
    }];
  });
}

/**
 * Builds a detached review Document and logical item index. It reads only the
 * supplied snapshots, never writes canonical state, and has no platform APIs.
 * Resolved operation metadata is retained alongside the items for callers that
 * need to associate a review item with its resolved proposal operation.
 */
export function buildReviewProjection(
  baseDoc: Document,
  proposedDoc: Document,
  changes: readonly StructuralChange[],
  operationMetadata: readonly DocumentOperationMetadata[] = [],
): ReviewProjection {
  const textChangesByBlock = new Map<string, TextChange[]>();
  const formatChangesByBlock = new Map<string, FormatChange[]>();
  const tableChangesById = new Map<string, TableChange[]>();
  const deletedBlockIds = new Set<string>();
  for (const change of changes) {
    if (change.kind === "inline-insert" || change.kind === "inline-delete" || change.kind === "inline-replace") {
      const entries = textChangesByBlock.get(change.blockId) ?? [];
      entries.push(change);
      textChangesByBlock.set(change.blockId, entries);
    } else if (change.kind === "inline-style" || change.kind === "block-style" || change.kind === "block-type") {
      const entries = formatChangesByBlock.get(change.blockId) ?? [];
      entries.push(change);
      formatChangesByBlock.set(change.blockId, entries);
    } else if (change.kind === "block-delete") {
      deletedBlockIds.add(change.blockId);
    }
    if ("tableId" in change) {
      const entries = tableChangesById.get(change.tableId) ?? [];
      entries.push(change);
      tableChangesById.set(change.tableId, entries);
    }
  }

  const document = structuredClone(baseDoc);
  const proposedById = new Map(proposedDoc.blocks.map((block) => [block.id, block]));
  const ids = new Set(document.blocks.map((block) => block.id));
  document.blocks = document.blocks.flatMap((block) => {
    if (isTableBlock(block)) {
      const tableChanges = tableChangesById.get(block.id) ?? [];
      if (tableChanges.length === 0) return block;
      const projected = projectTable(block, isTableBlock(proposedById.get(block.id)) ? proposedById.get(block.id) as TableBlock : undefined, tableChanges, ids);
      const labels = tableChanges
        .filter((change) => change.kind !== "table-cell-text" && change.kind !== "table-cell-style")
        .map((change) => reviewLabel(uniqueReviewId(ids, "table-structure", change.id), tableChangeLabel(change)));
      return [...labels, projected];
    }
    if (!isTextBlock(block)) return block;
    const changesForBlock = textChangesByBlock.get(block.id);
    let projected = changesForBlock?.length
      ? projectTextBlock(block, [...changesForBlock].sort((left, right) => left.start - right.start || left.end - right.end))
      : block;
    for (const change of formatChangesByBlock.get(block.id) ?? []) {
      const proposed = proposedById.get(block.id);
      if (proposed && isTextBlock(proposed)) {
        projected = changesForBlock?.length
          ? { ...structuredClone(proposed), id: projected.id, inlines: projected.inlines }
          : structuredClone(proposed);
      }
      for (const range of formatRanges(change, operationMetadata, projected)) projected = overlayRange(projected, range.start, range.end);
    }
    return deletedBlockIds.has(block.id) ? overlayWholeBlock(projected, "delete") : projected;
  });
  for (const block of document.blocks) ids.add(block.id);

  for (const change of changes.filter((change) => change.kind === "move")) {
    const sourceIndex = document.blocks.findIndex((block) => block.id === change.blockId);
    const source = document.blocks[sourceIndex];
    if (!source || !isTextBlock(source)) continue;
    const proposed = proposedById.get(change.blockId);
    const destination = overlayWholeBlock(
      proposed && isTextBlock(proposed) ? structuredClone(proposed) : structuredClone(source),
      "insert",
    );
    destination.id = uniqueReviewId(ids, "move-destination", change.id);
    document.blocks[sourceIndex] = overlayWholeBlock(source, "delete");
    const targetIndex = Math.max(0, Math.min(
      change.to + (change.from < change.to ? 1 : 0),
      document.blocks.length,
    ));
    document.blocks.splice(targetIndex, 0, destination);
  }

  for (const change of changes) {
    if (change.kind !== "block-insert") continue;
    const proposed = proposedById.get(change.blockId);
    if (!proposed || !isTextBlock(proposed)) continue;
    const inserted = overlayWholeBlock(structuredClone(proposed), "insert");
    inserted.id = uniqueReviewId(ids, "block-insert", change.id);
    document.blocks.splice(Math.max(0, Math.min(change.index, document.blocks.length)), 0, inserted);
  }

  return {
    document,
    items: projectionItems(changes, document),
    operationMetadata: structuredClone(operationMetadata),
  };
}

export const projectReviewDocument = buildReviewProjection;
