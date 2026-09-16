import type { Block, Document, Inline } from "@nautilo/office-docs/node";
import type { DocumentOperationMetadata } from "./document-ops";

export type StructuralChange =
  | { id: string; kind: "inline-insert" | "inline-delete" | "inline-replace"; blockId: string; start: number; end: number; before: string; after: string; operationIndexes: number[] }
  | { id: string; kind: "inline-style" | "block-style" | "block-type"; blockId: string; before: unknown; after: unknown; operationIndexes: number[] }
  | { id: string; kind: "block-insert" | "block-delete"; blockId: string; index: number; operationIndexes: number[] }
  | { id: string; kind: "move"; blockId: string; from: number; to: number; operationIndexes: number[] }
  | TableStructuralChange;

export type TableBounds = {
  start: { rowIndex: number; colIndex: number };
  end: { rowIndex: number; colIndex: number };
};

export type TableStructuralChange = {
  id: string;
  kind: "table-cell-text" | "table-cell-style" | "table-row-insert" | "table-row-delete" | "table-column-insert" | "table-column-delete" | "table-merge" | "table-split" | "table-delete";
  blockId: string;
  tableId: string;
  bounds: TableBounds;
  before?: unknown;
  after?: unknown;
  operationIndexes: number[];
  /** Records that must travel together to preserve table geometry. */
  groupId: string;
  /** Earlier table operations which must remain accepted for this record. */
  dependencyOperationIndexes: number[];
};

type TextBlock = Block & { inlines?: Inline[]; style?: unknown; type?: unknown };
type TableBlock = Block & {
  type: "table";
  tableData?: {
    rows: Array<{ cells: Array<{ blocks: TextBlock[]; style?: unknown; colSpan?: number; rowSpan?: number }> }>;
    columnWidths: unknown[];
  };
};

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function changeId(kind: StructuralChange["kind"], blockId: string, detail: unknown): string {
  return `${kind}:${blockId}:${stableHash(JSON.stringify(detail))}`;
}

function textOf(block: TextBlock | undefined): string {
  return Array.isArray(block?.inlines) ? block.inlines.map((inline) => inline.text).join("") : "";
}

function isTable(block: Block | undefined): block is TableBlock {
  return block?.type === "table" && !!(block as TableBlock).tableData;
}

function tableCellText(cell: { blocks: TextBlock[] }): string {
  return cell.blocks.map((block) => textOf(block)).join("\n");
}

function tableCellStyle(cell: { blocks: TextBlock[]; style?: unknown }): unknown {
  return {
    cell: cell.style ?? {},
    blocks: cell.blocks.map((block) => ({
      id: block.id,
      style: block.style ?? {},
      inlines: (block.inlines ?? []).map((inline) => inline.style ?? {}),
    })),
  };
}

function tableCellBlockIds(table: TableBlock): Set<string> {
  return new Set(table.tableData!.rows.flatMap((row) => row.cells.flatMap((cell) => cell.blocks.map((block) => block.id))));
}

function bounds(rowIndex: number, colIndex: number, endRow = rowIndex, endCol = colIndex): TableBounds {
  return { start: { rowIndex, colIndex }, end: { rowIndex: endRow, colIndex: endCol } };
}

function operationIndexes(operations: readonly DocumentOperationMetadata[], blockId: string, kinds: readonly string[]): number[] {
  return operations.flatMap((operation, index) =>
    operation.blockId === blockId && kinds.includes(operation.kind) ? [operation.operationIndex ?? index] : [],
  );
}

type TextSegment = { start: number; end: number; before: string; after: string };

function textOperationIndexes(
  operations: readonly DocumentOperationMetadata[],
  blockId: string,
  segment: TextSegment,
): number[] {
  return operations.flatMap((operation, index) => {
    if (operation.blockId !== blockId || !operation.range ||
      !["insert", "delete", "replace"].includes(operation.kind)) return [];
    const range = operation.range;
    const overlaps = segment.start === segment.end
      ? range.start <= segment.start && range.end >= segment.start
      : range.start < segment.end && range.end > segment.start;
    return overlaps ? [operation.operationIndex ?? index] : [];
  });
}

function inlineStyles(block: TextBlock): unknown[] {
  return (block.inlines ?? []).flatMap((inline) =>
    Array.from({ length: inline.text.length }, () => inline.style ?? {}),
  );
}

function canonicalStyleSet(block: TextBlock): string[] {
  return [...new Set((block.inlines ?? []).map((inline) => JSON.stringify(inline.style ?? {})))].sort();
}

function actualInlineStyleDelta(before: TextBlock, after: TextBlock): { before: unknown; after: unknown } | null {
  const beforeText = textOf(before);
  const afterText = textOf(after);
  const beforeStyles = inlineStyles(before);
  const afterStyles = inlineStyles(after);
  if (beforeText.length * afterText.length > 1_000_000) {
    let prefix = 0;
    while (prefix < beforeText.length && prefix < afterText.length && beforeText[prefix] === afterText[prefix]) {
      if (JSON.stringify(beforeStyles[prefix]) !== JSON.stringify(afterStyles[prefix])) {
        return { before: beforeStyles[prefix], after: afterStyles[prefix] };
      }
      prefix++;
    }
    let suffix = 1;
    while (suffix <= beforeText.length - prefix && suffix <= afterText.length - prefix &&
      beforeText[beforeText.length - suffix] === afterText[afterText.length - suffix]) {
      const beforeStyle = beforeStyles[beforeStyles.length - suffix];
      const afterStyle = afterStyles[afterStyles.length - suffix];
      if (JSON.stringify(beforeStyle) !== JSON.stringify(afterStyle)) {
        return { before: beforeStyle, after: afterStyle };
      }
      suffix++;
    }
    const beforeSet = canonicalStyleSet(before);
    const afterSet = canonicalStyleSet(after);
    return JSON.stringify(beforeSet) === JSON.stringify(afterSet) ? null : { before: beforeSet, after: afterSet };
  }
  const rows = Array.from({ length: beforeText.length + 1 }, () => new Uint16Array(afterText.length + 1));
  for (let i = beforeText.length - 1; i >= 0; i--) {
    for (let j = afterText.length - 1; j >= 0; j--) {
      rows[i]![j] = beforeText[i] === afterText[j]
        ? rows[i + 1]![j + 1]! + 1
        : Math.max(rows[i + 1]![j]!, rows[i]![j + 1]!);
    }
  }
  const changed: Array<{ before: unknown; after: unknown }> = [];
  let i = 0;
  let j = 0;
  while (i < beforeText.length && j < afterText.length) {
    if (beforeText[i] === afterText[j]) {
      if (JSON.stringify(beforeStyles[i]) !== JSON.stringify(afterStyles[j])) {
        changed.push({ before: beforeStyles[i], after: afterStyles[j] });
      }
      i++; j++;
    } else if (rows[i]![j + 1]! >= rows[i + 1]![j]!) j++;
    else i++;
  }
  if (changed.length > 0) return { before: changed.map((entry) => entry.before), after: changed.map((entry) => entry.after) };
  const beforeSet = canonicalStyleSet(before);
  const afterSet = canonicalStyleSet(after);
  return JSON.stringify(beforeSet) === JSON.stringify(afterSet) ? null : { before: beforeSet, after: afterSet };
}

/** Character LCS keeps separated edits separated; bounded to avoid quadratic work on large bodies. */
function textSegments(before: string, after: string): TextSegment[] {
  if (before.length * after.length > 1_000_000) {
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    return [{ start: prefix, end: before.length - suffix, before: before.slice(prefix, before.length - suffix), after: after.slice(prefix, after.length - suffix) }];
  }
  const rows = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      rows[i]![j] = before[i] === after[j] ? rows[i + 1]![j + 1]! + 1 : Math.max(rows[i + 1]![j]!, rows[i]![j + 1]!);
    }
  }
  const segments: TextSegment[] = [];
  let i = 0;
  let j = 0;
  let start = -1;
  let removed = "";
  let inserted = "";
  const flush = () => {
    if (start >= 0) segments.push({ start, end: start + removed.length, before: removed, after: inserted });
    start = -1; removed = ""; inserted = "";
  };
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      flush(); i++; j++; continue;
    }
    if (start < 0) start = i;
    if (j < after.length && (i === before.length || rows[i]![j + 1]! >= rows[i + 1]![j]!)) inserted += after[j++]!;
    else if (i < before.length) removed += before[i++]!;
  }
  flush();
  return segments;
}

function tableChanges(
  before: TableBlock,
  after: TableBlock,
  operations: readonly DocumentOperationMetadata[],
): TableStructuralChange[] {
  const beforeData = before.tableData!;
  const afterData = after.tableData!;
  const tableId = before.id;
  const nestedIds = new Set([...tableCellBlockIds(before), ...tableCellBlockIds(after)]);
  const tableIndexes = operations.flatMap((operation, index) =>
    (operation.blockId === tableId || nestedIds.has(operation.blockId)) ? [operation.operationIndex ?? index] : [],
  );
  const operationIndexesFor = (kinds: readonly string[]) => operations.flatMap((operation, index) =>
    (operation.blockId === tableId || nestedIds.has(operation.blockId)) && kinds.includes(operation.kind) ? [operation.operationIndex ?? index] : [],
  );
  const dependenciesFor = (indexes: readonly number[]) => {
    const first = indexes[0] ?? Number.MAX_SAFE_INTEGER;
    return tableIndexes.filter((index) => index < first);
  };
  const make = (
    kind: TableStructuralChange["kind"],
    area: TableBounds,
    detail: Record<string, unknown>,
    indexes: number[],
    groupId = `${kind}:${tableId}`,
  ): TableStructuralChange => ({
    id: changeId(kind, tableId, { bounds: area, ...detail }),
    kind,
    blockId: tableId,
    tableId,
    bounds: area,
    ...("before" in detail ? { before: detail["before"] } : {}),
    ...("after" in detail ? { after: detail["after"] } : {}),
    operationIndexes: indexes,
    groupId,
    dependencyOperationIndexes: dependenciesFor(indexes),
  });
  const changes: TableStructuralChange[] = [];
  const beforeRows = beforeData.rows.length;
  const afterRows = afterData.rows.length;
  const beforeCols = beforeData.columnWidths.length;
  const afterCols = afterData.columnWidths.length;
  if (beforeRows !== afterRows) {
    const kind = afterRows > beforeRows ? "table-row-insert" : "table-row-delete";
    const count = Math.abs(afterRows - beforeRows);
    const shared = Math.min(beforeRows, afterRows);
    let rowIndex = 0;
    while (rowIndex < shared && JSON.stringify(beforeData.rows[rowIndex]) === JSON.stringify(afterData.rows[rowIndex])) rowIndex++;
    changes.push(make(kind, bounds(rowIndex, 0, rowIndex + count - 1, Math.max(beforeCols, afterCols) - 1), { before: beforeRows, after: afterRows }, operationIndexesFor([kind === "table-row-insert" ? "insert-table-row" : "delete-table-row"])));
  }
  if (beforeCols !== afterCols) {
    const kind = afterCols > beforeCols ? "table-column-insert" : "table-column-delete";
    const count = Math.abs(afterCols - beforeCols);
    const shared = Math.min(beforeCols, afterCols);
    let colIndex = 0;
    while (colIndex < shared && beforeData.rows.every((row, rowIndex) =>
      JSON.stringify(row.cells[colIndex]) === JSON.stringify(afterData.rows[rowIndex]?.cells[colIndex]))) colIndex++;
    changes.push(make(kind, bounds(0, colIndex, Math.max(beforeRows, afterRows) - 1, colIndex + count - 1), { before: beforeCols, after: afterCols }, operationIndexesFor([kind === "table-column-insert" ? "insert-table-column" : "delete-table-column"])));
  }
  const rows = Math.min(beforeRows, afterRows);
  const cols = Math.min(beforeCols, afterCols);
  for (let rowIndex = 0; rowIndex < rows; rowIndex++) for (let colIndex = 0; colIndex < cols; colIndex++) {
    const beforeCell = beforeData.rows[rowIndex]!.cells[colIndex]!;
    const afterCell = afterData.rows[rowIndex]!.cells[colIndex]!;
    const beforeSpan = { rowSpan: beforeCell.rowSpan ?? 1, colSpan: beforeCell.colSpan ?? 1 };
    const afterSpan = { rowSpan: afterCell.rowSpan ?? 1, colSpan: afterCell.colSpan ?? 1 };
    if (JSON.stringify(beforeSpan) !== JSON.stringify(afterSpan)) {
      const merge = (afterCell.colSpan ?? 1) === 0 || afterSpan.rowSpan > beforeSpan.rowSpan || afterSpan.colSpan > beforeSpan.colSpan;
      const kind = merge ? "table-merge" : "table-split";
      const endRow = merge ? rowIndex + Math.max(beforeSpan.rowSpan, afterSpan.rowSpan) - 1 : rowIndex;
      const endCol = merge ? colIndex + Math.max(beforeSpan.colSpan, afterSpan.colSpan) - 1 : colIndex;
      const opKind = merge ? "merge-table-cells" : "split-table-cell";
      const indexes = operationIndexesFor([opKind]);
      changes.push(make(kind, bounds(rowIndex, colIndex, endRow, endCol), { before: beforeSpan, after: afterSpan }, indexes, `${kind}:${tableId}:${indexes.join(",") || `${rowIndex}:${colIndex}`}`));
      continue;
    }
    const beforeText = tableCellText(beforeCell);
    const afterText = tableCellText(afterCell);
    const textIndexes = operations.flatMap((operation, index) =>
      beforeCell.blocks.some((block) => block.id === operation.blockId) || afterCell.blocks.some((block) => block.id === operation.blockId)
        ? ["insert", "delete", "replace"].includes(operation.kind) ? [operation.operationIndex ?? index] : []
        : [],
    );
    if (beforeText !== afterText) changes.push(make("table-cell-text", bounds(rowIndex, colIndex), { before: beforeText, after: afterText }, textIndexes));
    const beforeStyle = tableCellStyle(beforeCell);
    const afterStyle = tableCellStyle(afterCell);
    if (JSON.stringify(beforeStyle) !== JSON.stringify(afterStyle)) {
      const styleIndexes = operations.flatMap((operation, index) =>
        beforeCell.blocks.some((block) => block.id === operation.blockId) || afterCell.blocks.some((block) => block.id === operation.blockId)
          ? ["format-inline", "format-block", "set-block-type"].includes(operation.kind) ? [operation.operationIndex ?? index] : []
          : operation.blockId === tableId && operation.kind === "set-table-cell-style" ? [operation.operationIndex ?? index] : [],
      );
      changes.push(make("table-cell-style", bounds(rowIndex, colIndex), { before: beforeStyle, after: afterStyle }, styleIndexes));
    }
  }
  // A merge followed by a split can leave the final geometry unchanged, but
  // each operation is still an independently reviewable, shape-sensitive
  // decision. Preserve it as a conservative whole-table record.
  for (const [operationKind, kind] of [
    ["merge-table-cells", "table-merge"],
    ["split-table-cell", "table-split"],
  ] as const) {
    for (const index of operationIndexesFor([operationKind])) {
      if (changes.some((change) => change.kind === kind && change.operationIndexes.includes(index))) continue;
      changes.push(make(
        kind,
        bounds(0, 0, Math.max(beforeRows, afterRows) - 1, Math.max(beforeCols, afterCols) - 1),
        { before: null, after: null },
        [index],
        `${kind}:${tableId}:${index}`,
      ));
    }
  }
  return changes;
}

/** Produces deterministic, ID-first review records without mutating either document. */
export function structuralDiff(
  base: Document,
  proposed: Document,
  operations: readonly DocumentOperationMetadata[] = [],
): StructuralChange[] {
  const baseById = new Map(base.blocks.map((block, index) => [block.id, { block: block as TextBlock, index }]));
  const proposedById = new Map(proposed.blocks.map((block, index) => [block.id, { block: block as TextBlock, index }]));
  const changes: StructuralChange[] = [];

  for (const [blockId, { block, index }] of baseById) {
    if (!proposedById.has(blockId)) {
      if (isTable(block)) {
        const data = block.tableData!;
        const indexes = operationIndexes(operations, blockId, ["delete-table"]);
        const area = bounds(0, 0, data.rows.length - 1, data.columnWidths.length - 1);
        changes.push({
          id: changeId("table-delete", blockId, { bounds: area }),
          kind: "table-delete",
          blockId,
          tableId: blockId,
          bounds: area,
          operationIndexes: indexes,
          groupId: `table-delete:${blockId}:${indexes.join(",") || "document"}`,
          dependencyOperationIndexes: [],
        });
        continue;
      }
      const detail = { index, text: textOf(block) };
      changes.push({ id: changeId("block-delete", blockId, detail), kind: "block-delete", blockId, index, operationIndexes: operationIndexes(operations, blockId, []) });
    }
  }
  for (const [blockId, { block, index }] of proposedById) {
    if (!baseById.has(blockId)) {
      const detail = { index, text: textOf(block) };
      changes.push({ id: changeId("block-insert", blockId, detail), kind: "block-insert", blockId, index, operationIndexes: operationIndexes(operations, blockId, []) });
    }
  }

  for (const [blockId, beforeEntry] of baseById) {
    const afterEntry = proposedById.get(blockId);
    if (!afterEntry) continue;
    const before = beforeEntry.block;
    const after = afterEntry.block;
    if (isTable(before) && isTable(after)) {
      changes.push(...tableChanges(before, after, operations));
      continue;
    }
    const moveIndexes = operationIndexes(operations, blockId, ["move-block"]);
    if (beforeEntry.index !== afterEntry.index && moveIndexes.length > 0) {
      const detail = { from: beforeEntry.index, to: afterEntry.index };
      changes.push({ id: changeId("move", blockId, detail), kind: "move", blockId, from: beforeEntry.index, to: afterEntry.index, operationIndexes: moveIndexes });
    }

    const beforeText = textOf(before);
    const afterText = textOf(after);
    if (beforeText !== afterText) {
      for (const detail of textSegments(beforeText, afterText)) {
        const kind = detail.before.length === 0 ? "inline-insert" : detail.after.length === 0 ? "inline-delete" : "inline-replace";
        changes.push({
          id: changeId(kind, blockId, detail), kind, blockId, ...detail,
          operationIndexes: textOperationIndexes(operations, blockId, detail),
        });
      }
    }

    const formatIndexes = operationIndexes(operations, blockId, ["format-inline"]);
    const styleDelta = formatIndexes.length > 0 ? actualInlineStyleDelta(before, after) : null;
    if (styleDelta) {
      changes.push({ id: changeId("inline-style", blockId, styleDelta), kind: "inline-style", blockId, ...styleDelta, operationIndexes: formatIndexes });
    }
    if (JSON.stringify(before.style ?? {}) !== JSON.stringify(after.style ?? {})) {
      const detail = { before: before.style ?? {}, after: after.style ?? {} };
      changes.push({ id: changeId("block-style", blockId, detail), kind: "block-style", blockId, ...detail, operationIndexes: operationIndexes(operations, blockId, ["format-block"]) });
    }
    const beforeType = { type: before.type, headingLevel: (before as { headingLevel?: unknown }).headingLevel, listKind: (before as { listKind?: unknown }).listKind, listLevel: (before as { listLevel?: unknown }).listLevel };
    const afterType = { type: after.type, headingLevel: (after as { headingLevel?: unknown }).headingLevel, listKind: (after as { listKind?: unknown }).listKind, listLevel: (after as { listLevel?: unknown }).listLevel };
    if (JSON.stringify(beforeType) !== JSON.stringify(afterType)) {
      const detail = { before: beforeType, after: afterType };
      changes.push({ id: changeId("block-type", blockId, detail), kind: "block-type", blockId, ...detail, operationIndexes: operationIndexes(operations, blockId, ["set-block-type"]) });
    }
  }
  return changes;
}
