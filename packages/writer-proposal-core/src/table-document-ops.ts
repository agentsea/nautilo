/** Browser-safe canonical table mutations shared by closed and proposal paths. */
import {
  DEFAULT_BLOCK_STYLE,
  DEFAULT_CELL_STYLE,
  createTableCell,
  generateBlockId,
  type Block,
  type CellAddress,
  type CellStyle,
  type TableData,
} from "@nautilo/office-docs/node";

export type TableOperationError = { ok: false; message: string };
export type TableOperationResult = { ok: true; tableData: TableData } | TableOperationError;

export function cloneTableData(tableData: TableData): TableData {
  return {
    rows: tableData.rows.map((row) => ({
      cells: row.cells.map((cell) => ({
        blocks: cell.blocks.map((block) => ({
          ...block,
          inlines: block.inlines.map((inline) => ({ ...inline, style: { ...inline.style } })),
          style: { ...block.style },
        })),
        style: { ...cell.style },
        ...(cell.colSpan === undefined ? {} : { colSpan: cell.colSpan }),
        ...(cell.rowSpan === undefined ? {} : { rowSpan: cell.rowSpan }),
      })),
    })),
    columnWidths: tableData.columnWidths.slice(),
    ...(tableData.rowHeights === undefined ? {} : { rowHeights: tableData.rowHeights.slice() }),
  };
}

function fail(message: string): TableOperationError {
  return { ok: false, message };
}
function cell(tableData: TableData, address: CellAddress) {
  return tableData.rows[address.rowIndex]?.cells[address.colIndex];
}
function covered(value: { colSpan?: number } | undefined): boolean {
  return value?.colSpan === 0;
}
function commit(tableData: TableData): TableOperationResult {
  return { ok: true, tableData };
}

type MergeRegion = {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
};

/**
 * Validates the grid invariant consumed by Wafflebase layout and returns every
 * active merge. `normalizeTableMerges` exists internally in Wafflebase but is
 * not part of the public package API, so structural edits fail closed rather
 * than attempting to repair malformed or intersected merges.
 */
function activeMergeRegions(tableData: TableData): MergeRegion[] | TableOperationError {
  const rowCount = tableData.rows.length;
  const colCount = tableData.columnWidths.length;
  const claimed = Array.from({ length: rowCount }, () => Array<boolean>(colCount).fill(false));
  const regions: MergeRegion[] = [];
  for (let row = 0; row < rowCount; row++) {
    const cells = tableData.rows[row]!.cells;
    if (cells.length !== colCount) return fail("table merge topology is invalid");
    for (let col = 0; col < colCount; col++) {
      const entry = cells[col]!;
      if (entry.colSpan === 0) continue;
      const rowSpan = entry.rowSpan ?? 1;
      const colSpan = entry.colSpan ?? 1;
      if (!Number.isSafeInteger(rowSpan) || !Number.isSafeInteger(colSpan) || rowSpan < 1 || colSpan < 1) {
        return fail("table merge topology is invalid");
      }
      if (rowSpan === 1 && colSpan === 1) continue;
      const endRow = row + rowSpan - 1;
      const endCol = col + colSpan - 1;
      if (endRow >= rowCount || endCol >= colCount) return fail("table merge topology is invalid");
      const region = { startRow: row, endRow, startCol: col, endCol };
      for (let coveredRow = row; coveredRow <= endRow; coveredRow++) {
        for (let coveredCol = col; coveredCol <= endCol; coveredCol++) {
          if (coveredRow === row && coveredCol === col) continue;
          const coveredCell = tableData.rows[coveredRow]!.cells[coveredCol];
          if (!coveredCell || coveredCell.colSpan !== 0 || claimed[coveredRow]![coveredCol]) {
            return fail("table merge topology is invalid");
          }
          claimed[coveredRow]![coveredCol] = true;
        }
      }
      regions.push(region);
    }
  }
  for (let row = 0; row < rowCount; row++) {
    for (let col = 0; col < colCount; col++) {
      const entry = tableData.rows[row]!.cells[col]!;
      if ((entry.colSpan === 0) !== claimed[row]![col]) return fail("table merge topology is invalid");
      if (entry.colSpan === 0 && entry.rowSpan !== undefined) return fail("table merge topology is invalid");
    }
  }
  return regions;
}

export function insertTableRow(tableData: TableData, rowIndex: number): TableOperationResult {
  const next = cloneTableData(tableData);
  if (!Number.isSafeInteger(rowIndex) || rowIndex < 0 || rowIndex > next.rows.length) return fail("row index is out of bounds");
  const merges = activeMergeRegions(next);
  if (!Array.isArray(merges)) return merges;
  if (merges.some((region) => region.startRow < rowIndex && rowIndex <= region.endRow)) {
    return fail("row insertion intersects an active merge");
  }
  next.rows.splice(rowIndex, 0, { cells: Array.from({ length: next.columnWidths.length }, () => createTableCell()) });
  if (next.rowHeights) next.rowHeights.splice(rowIndex, 0, undefined);
  return commit(next);
}
export function deleteTableRow(tableData: TableData, rowIndex: number): TableOperationResult {
  const next = cloneTableData(tableData);
  if (!Number.isSafeInteger(rowIndex) || rowIndex < 0 || rowIndex >= next.rows.length) return fail("row index is out of bounds");
  if (next.rows.length <= 1) return fail("cannot delete the last row");
  const merges = activeMergeRegions(next);
  if (!Array.isArray(merges)) return merges;
  if (merges.some((region) => region.startRow <= rowIndex && rowIndex <= region.endRow)) {
    return fail("row deletion intersects an active merge");
  }
  next.rows.splice(rowIndex, 1);
  if (next.rowHeights) next.rowHeights.splice(rowIndex, 1);
  return commit(next);
}
export function insertTableColumn(tableData: TableData, colIndex: number): TableOperationResult {
  const next = cloneTableData(tableData);
  if (!Number.isSafeInteger(colIndex) || colIndex < 0 || colIndex > next.columnWidths.length) return fail("column index is out of bounds");
  const merges = activeMergeRegions(next);
  if (!Array.isArray(merges)) return merges;
  if (merges.some((region) => region.startCol < colIndex && colIndex <= region.endCol)) {
    return fail("column insertion intersects an active merge");
  }
  next.columnWidths.splice(colIndex, 0, 0);
  for (const row of next.rows) row.cells.splice(colIndex, 0, createTableCell());
  for (let i = 0; i < next.columnWidths.length; i++) next.columnWidths[i] = 1 / next.columnWidths.length;
  return commit(next);
}
export function deleteTableColumn(tableData: TableData, colIndex: number): TableOperationResult {
  const next = cloneTableData(tableData);
  if (!Number.isSafeInteger(colIndex) || colIndex < 0 || colIndex >= next.columnWidths.length) return fail("column index is out of bounds");
  if (next.columnWidths.length <= 1) return fail("cannot delete the last column");
  const merges = activeMergeRegions(next);
  if (!Array.isArray(merges)) return merges;
  if (merges.some((region) => region.startCol <= colIndex && colIndex <= region.endCol)) {
    return fail("column deletion intersects an active merge");
  }
  next.columnWidths.splice(colIndex, 1);
  for (const row of next.rows) row.cells.splice(colIndex, 1);
  for (let i = 0; i < next.columnWidths.length; i++) next.columnWidths[i] = 1 / next.columnWidths.length;
  return commit(next);
}
export function mergeTableCells(tableData: TableData, start: CellAddress, end: CellAddress): TableOperationResult {
  const next = cloneTableData(tableData);
  const r0 = Math.min(start.rowIndex, end.rowIndex), r1 = Math.max(start.rowIndex, end.rowIndex);
  const c0 = Math.min(start.colIndex, end.colIndex), c1 = Math.max(start.colIndex, end.colIndex);
  if (r0 === r1 && c0 === c1) return fail("merge must cover at least two cells");
  if (!cell(next, { rowIndex: r0, colIndex: c0 }) || !cell(next, { rowIndex: r1, colIndex: c1 })) return fail("merge range is out of bounds");
  for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) {
    const entry = cell(next, { rowIndex: row, colIndex: col })!;
    if (covered(entry) || (entry.colSpan ?? 1) > 1 || (entry.rowSpan ?? 1) > 1) return fail("merge range contains an existing merge");
  }
  const anchor = cell(next, { rowIndex: r0, colIndex: c0 })!;
  for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) {
    if (row === r0 && col === c0) continue;
    const entry = cell(next, { rowIndex: row, colIndex: col })!;
    for (const block of entry.blocks) if (block.inlines.some((inline) => inline.text.length > 0)) {
      anchor.blocks.push({ ...block, id: generateBlockId(), inlines: block.inlines.map((inline) => ({ ...inline, style: { ...inline.style } })), style: { ...block.style } });
    }
    entry.blocks = [{ id: generateBlockId(), type: "paragraph", inlines: [{ text: "", style: {} }], style: { ...DEFAULT_BLOCK_STYLE } }];
    entry.colSpan = 0; delete entry.rowSpan;
  }
  anchor.colSpan = c1 - c0 + 1; anchor.rowSpan = r1 - r0 + 1;
  return commit(next);
}
export function splitTableCell(tableData: TableData, address: CellAddress): TableOperationResult {
  const next = cloneTableData(tableData);
  const anchor = cell(next, address);
  if (!anchor || covered(anchor)) return fail("cell is missing or covered");
  const rowSpan = anchor.rowSpan ?? 1, colSpan = anchor.colSpan ?? 1;
  if (rowSpan <= 1 && colSpan <= 1) return fail("cell is not merged");
  delete anchor.colSpan; delete anchor.rowSpan;
  for (let row = address.rowIndex; row < address.rowIndex + rowSpan; row++) for (let col = address.colIndex; col < address.colIndex + colSpan; col++) {
    if (row === address.rowIndex && col === address.colIndex) continue;
    const entry = cell(next, { rowIndex: row, colIndex: col });
    if (!entry) return fail("merged region is invalid");
    delete entry.colSpan; delete entry.rowSpan;
    entry.blocks = [{ id: generateBlockId(), type: "paragraph", inlines: [{ text: "", style: {} }], style: { ...DEFAULT_BLOCK_STYLE } }];
  }
  return commit(next);
}
export function setTableCellStyle(tableData: TableData, address: CellAddress, style: Partial<CellStyle>): TableOperationResult {
  const next = cloneTableData(tableData);
  const entry = cell(next, address);
  if (!entry || covered(entry)) return fail("cell is missing or covered");
  entry.style = { ...DEFAULT_CELL_STYLE, ...entry.style, ...style };
  return commit(next);
}
/** Removes a top-level table block without mutating the source block list. */
export function deleteTableBlock(blocks: readonly Block[], tableBlockId: string): Block[] | null {
  const index = blocks.findIndex((block) => block.id === tableBlockId && block.type === "table");
  if (index < 0) return null;
  return [...blocks.slice(0, index), ...blocks.slice(index + 1)];
}
export function replaceTableBlock(blocks: readonly Block[], tableBlockId: string, tableData: TableData): Block[] | null {
  const index = blocks.findIndex((block) => block.id === tableBlockId && block.type === "table");
  if (index < 0) return null;
  const next = blocks.slice();
  next[index] = { ...next[index]!, tableData };
  return next;
}
