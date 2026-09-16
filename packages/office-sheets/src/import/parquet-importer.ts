import type { ImportedSheet } from './imported-sheet';
import { createImportBudget, type ImportPolicy } from './csv-importer';
import { cellFromInput } from '../model/worksheet/input';
import type { Cell, Ref } from '../model/core/types';
import { toCell } from '../store/readonly';
import { createWorksheet } from '../model/workbook/worksheet-document';
import {
  ensureWorksheetExtent,
  replaceWorksheetCells,
} from '../model/workbook/worksheet-grid';

export type ParquetImportOptions = ImportPolicy & {
  sheetName: string;
};

function binaryToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function parquetDateCell(value: Date): Cell {
  const iso = value.toISOString();
  const time = iso.slice(11, 19);
  return cellFromInput(
    time === '00:00:00' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${time}`,
  );
}

function parquetCellForValue(value: unknown): Cell | undefined {
  if (value === null || value === undefined) return undefined;
  // A JavaScript number loses precision beyond Number.MAX_SAFE_INTEGER, so an
  // INT64/UINT64 must remain literal text instead of passing through inference.
  if (typeof value === 'bigint') return { v: value.toString() };
  if (value instanceof Uint8Array) return { v: binaryToHex(value) };
  if (value instanceof Date) return parquetDateCell(value);
  return cellFromInput(toCell(value));
}

/**
 * Parses a local Parquet file into one editable sheet in the browser.
 */
export async function importParquetFile(
  file: ArrayBuffer,
  options: ParquetImportOptions,
): Promise<ImportedSheet> {
  // Keep browser-only ESM dependencies out of server-side consumers that import
  // the sheets public API (for example, backend Jest tests).
  const [{ parquetMetadata, parquetRead, parquetSchema }, { compressors }] =
    await Promise.all([
      import('hyparquet'),
      import('hyparquet-compressors'),
    ]);
  const metadata = parquetMetadata(file);
  const columns = parquetSchema(metadata).children.map(
    (column) => column.element.name,
  );
  if (columns.length === 0) {
    throw new Error('Parquet import contains no columns');
  }

  const rowCount = Number(metadata.num_rows);
  const budget = createImportBudget(options);
  const headerCells = columns.map<Cell>((column) => ({
    v: column,
    s: { b: true },
  }));
  if (budget.tryAddRow(headerCells)) {
    throw new Error('Parquet import exceeds the caller cell limit');
  }
  const pending: Array<[Ref, Cell]> = headerCells.map((cell, index) => [
    { r: 1, c: index + 1 },
    cell,
  ]);

  let cellCount = headerCells.length;
  let budgetExceeded = false;
  // Logical UTF-8 columns remain strings, while unannotated BYTE_ARRAY values
  // stay Uint8Array for the binary formatter below.
  await parquetRead({
    file,
    metadata,
    compressors,
    utf8: false,
    onChunk: ({ columnName, columnData, rowStart }) => {
      const columnIndex = columns.indexOf(columnName);
      if (columnIndex < 0 || budgetExceeded) return;

      for (let index = 0; index < columnData.length; index++) {
        const cell = parquetCellForValue(columnData[index]);
        if (!cell) continue;
        if (budget.tryAddRow([cell])) {
          budgetExceeded = true;
          return;
        }
        pending.push([
          { r: rowStart + index + 2, c: columnIndex + 1 },
          cell,
        ]);
        cellCount += 1;
      }
    },
  });
  if (budgetExceeded) {
    throw new Error('Parquet import exceeds the caller cell limit');
  }

  const worksheet = createWorksheet();
  ensureWorksheetExtent(worksheet, { r: rowCount + 1, c: columns.length });
  replaceWorksheetCells(worksheet, pending);

  return {
    name: options.sheetName.trim() || 'Imported Parquet',
    worksheet,
    cellCount,
    rowCount: rowCount + 1,
    columnCount: columns.length,
  };
}

// Modified by Nautilo: make import admission policy caller-owned and atomic.
