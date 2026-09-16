import type { Cell } from '../model/core/types';
import { createWorksheet } from '../model/workbook/worksheet-document';
import {
  ensureWorksheetExtent,
  replaceWorksheetCells,
} from '../model/workbook/worksheet-grid';
import type { Ref } from '../model/core/types';
import { cellFromInput } from '../model/worksheet/input';
import type { ImportedSheet } from './imported-sheet';

/**
 * `toImportText` renders one source value as the text `inferInput` would have
 * seen had the same table arrived as CSV.
 *
 * The parameter is `unknown` rather than `string` because the callers disagree:
 * a CSV parser hands over `string[]`, while an in-process caller (a query
 * result, a future non-CSV importer) hands over real `number`s, `Date`s and
 * `null`s. Both have to land on the same cell — otherwise where a table came
 * from would decide its cell types.
 *
 * There is deliberately **no** ISO-8601 normalization for strings: this
 * function also serves the CSV path, so normalizing here would rewrite a plain
 * text file that happens to contain a timestamp. The `Date` branch exists only
 * because `importTable` accepts `unknown` and `JSON.stringify(new Date())`
 * yields a *quoted* string, which would be silently wrong rather than merely
 * unhandled — it normalizes to the two forms `inferInput` recognizes.
 */
function toImportText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    // UTC. A midnight timestamp becomes a plain date so it infers as one.
    const iso = value.toISOString();
    const time = iso.slice(11, 19);
    return time === '00:00:00'
      ? iso.slice(0, 10)
      : `${iso.slice(0, 10)} ${time}`;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  ) {
    return String(value);
  }
  // `?? ''` because `JSON.stringify` returns `undefined`, not a string, for a
  // value whose `toJSON()` yields `undefined` — the return type says otherwise
  // and TypeScript does not catch it. Unreachable from CSV, where every field
  // arrives as a string, but `importTable` takes `unknown` on purpose.
  if (typeof value === 'object') return JSON.stringify(value) ?? '';
  return Object.prototype.toString.call(value);
}

/**
 * `toImportCell` normalizes one field through `cellFromInput`, the same entry
 * point a paste and a JSON import use, with one deliberate exception: a leading
 * `=` is kept as literal text.
 *
 * The import path writes the document directly and never runs the calculator,
 * so a formula cell would carry no cached value and render blank
 * (`toDisplayString` reads only `v`). XLSX can store a formula because Excel
 * ships its cached value alongside; CSV has none. Re-entering the cell commits
 * a real formula.
 *
 * The `=` test is `inferInput`'s own (it classifies a formula by exactly this
 * prefix on the trimmed input), applied before `cellFromInput` rather than
 * after so the text is inferred once.
 */
function toImportCell(value: unknown): Cell | undefined {
  const text = toImportText(value);
  // `inferInput` trims, so a whitespace-only field would store an empty `v`.
  // Skip it instead — one less CRDT subtree, same rendered result.
  const trimmed = text.trim();
  if (trimmed === '') {
    return undefined;
  }

  if (trimmed.startsWith('=')) {
    return { v: trimmed };
  }
  return cellFromInput(text);
}

export type ImportPolicy = {
  /** Optional caller-owned ceiling on non-empty cells materialized. */
  maxCells?: number;
};

export type ImportBudgetRejection = 'cells';

/**
 * Tracks an optional caller-owned cell limit used by table imports.
 *
 * Kept separate from the CSV parser so another row-major importer can reject
 * an over-limit document before it writes any cells.
 */
export function createImportBudget(policy?: ImportPolicy): {
  tryAddRow(cells: ReadonlyArray<Cell>): ImportBudgetRejection | undefined;
} {
  const maxCells = policy?.maxCells;
  if (
    maxCells !== undefined &&
    (!Number.isSafeInteger(maxCells) || maxCells < 0)
  ) {
    throw new Error('Import maxCells must be a non-negative safe integer.');
  }
  let cellCount = 0;

  return {
    tryAddRow(cells: ReadonlyArray<Cell>): ImportBudgetRejection | undefined {
      if (maxCells !== undefined && cellCount + cells.length > maxCells) {
        return 'cells';
      }
      cellCount += cells.length;
      return undefined;
    },
  };
}

/**
 * What a streamed table import produces.
 *
 * Extends the format-neutral `ImportedSheet` the XLSX and JSON importers
 * already return, so a table can go straight into
 * `createSpreadsheetDocumentFromImportedSheets` with them. `truncated` is the
 * one field they have no use for: neither of those importers has a budget, so
 * neither can stop short.
 */
export interface ImportedTable extends ImportedSheet {
  /**
   * How many rows the imported sheet has — its row extent, the position of the
   * last row holding a cell.
   *
   * Deliberately the extent rather than a count of rows that produced cells,
   * because this number is what the truncation message shows the user and the
   * extent is the only one of the three candidates they can check. A file with
   * blank separator rows makes all three diverge (measured: 55 source lines,
   * 54 rows of extent, 50 rows that produced a cell) — of those, the source's
   * line count is not tracked here at all, and a count of populated rows
   * matches neither the file the user opens in an editor nor the sheet they
   * are looking at. The extent matches the sheet.
   *
   * Trailing blank rows are excluded (the extent stops at the last cell), so
   * this never overstates what arrived.
   */
  rowCount: number;
  /**
   * Cells actually written — the exact figure, not `rowCount * columns`, which
   * overstates any table with a blank row or a ragged edge.
   */
  cellCount: number;
  /**
   * The source had more data than an explicit caller policy allowed.
   */
  truncated: boolean;
}

/**
 * A row-at-a-time worksheet builder.
 *
 * This exists because the client parser is a *stream*: papaparse hands rows to
 * a callback one at a time, so there is no array for a caller to iterate. The
 * writer owns the loop position instead, and `push` returning `false` is the
 * signal to stop feeding — the caller turns that into `parser.abort()`, which
 * is what keeps import cost proportional to the budget rather than to file
 * size.
 *
 * The cell budget lives here rather than in any caller: this is the one place
 * every *row-major table* import (CSV/TSV today) meets, and a budget enforced
 * in only some of them would let *how* a table arrived decide whether it
 * imports at all.
 *
 * This does **not** cover XLSX: `xlsx-importer.ts` builds a `Worksheet`
 * directly from workbook XML and never calls `createTableWriter`/`importTable`,
 * so it has no size cap of its own today — noted here because a claim like
 * "every import path" invites exactly that assumption.
 */
export interface TableWriter {
  /**
   * Writes one row. Returns `false` when the budget is exhausted — in which
   * case the row was **not** written and the caller must stop.
   */
  push(row: ReadonlyArray<unknown>): boolean;
  /** Builds the final table. Throws when nothing could be imported. */
  finish(): ImportedTable;
}

/**
 * `createTableWriter` starts a worksheet that rows can be streamed into.
 *
 * `hasHeader` defaults to true because most callers cannot tell: papaparse
 * reports no such signal, so the CSV path assumes a header the way every
 * spreadsheet import does. Pass `false` only when the source actually says so —
 * bolding a record the user wrote is worse than leaving a header plain.
 */
export interface TableImportOptions extends ImportPolicy {
  hasHeader?: boolean;
  /**
   * Names the resulting sheet, the way `importJsonText` takes its `sheetName`.
   * A CSV carries no internal name of its own — it is just rows — so the only
   * caller that can supply one is whoever knows where the rows came from.
   */
  sheetName?: string;
}

export function createTableWriter(options?: TableImportOptions): TableWriter {
  const worksheet = createWorksheet();
  // Cells are collected and written in one pass at `finish` rather than as they
  // arrive. Writing each cell straight into the worksheet grows the row axis by
  // one per row, and every growth rescans that axis to keep its generated ids
  // unique — which makes the fill quadratic in row count (measurably: ~20s for
  // 50k cells, ~30ms buffered). The buffer is released when `finish` builds the
  // worksheet; callers that need an admission ceiling can supply `maxCells`.
  const pending: Array<[Ref, Cell]> = [];
  let maxColumn = 0;
  let cellCount = 0;
  const budget = createImportBudget(options);
  let rowIndex = 0;
  let truncated = false;
  // The header is the first row that produced a cell, not necessarily row 1:
  // leading blank rows are kept, and bolding one of those would leave the real
  // header plain.
  let headerRow = 0;

  return {
    push(row: ReadonlyArray<unknown>): boolean {
      // Rejection closes the stream. Otherwise a later narrow row could fit
      // the remaining policy after an earlier wide row was rejected, silently
      // deleting a row from the middle of the imported table.
      if (truncated) return false;

      // Converted before anything is committed, so an explicit policy can count
      // what the row actually writes while it can still be rejected whole. A row
      // half-written would have a column count silently different from every
      // row above it.
      const converted: Array<[number, Cell]> = [];
      for (let columnIndex = 0; columnIndex < row.length; columnIndex++) {
        const cell = toImportCell(row[columnIndex]);
        if (!cell) continue;
        converted.push([columnIndex + 1, cell]);
      }

      // Charged on cells written, not on fields parsed. A blank field costs
      // nothing to store, so counting it truncated a sparse table early — and,
      // worse, made the empty row papaparse emits for a file's trailing newline
      // flip `truncated` on an import that had dropped nothing: a file of
      // exactly at the caller's limit reported "Only the first N rows were
      // imported" while holding every one of them.
      //
      // Checked before writing, so truncation always lands on a row boundary.
      const budgetRejection = budget.tryAddRow(
        converted.map(([, cell]) => cell),
      );
      if (budgetRejection === 'cells') {
        truncated = true;
        return false;
      }

      rowIndex += 1;
      for (const [column, cell] of converted) {
        pending.push([{ r: rowIndex, c: column }, cell]);
        if (column > maxColumn) maxColumn = column;
        if (headerRow === 0) headerRow = rowIndex;
      }
      cellCount += converted.length;
      return true;
    },

    finish(): ImportedTable {
      // Guard on what was written, not on the row count: an empty source, a
      // whitespace-only one and one of entirely empty fields all arrive here
      // with rows but no cells. This also guarantees `headerRow` was set below.
      if (cellCount === 0) {
        // A first populated row over the caller's policy is different from an
        // empty file and must identify the policy that rejected it.
        if (truncated) {
          throw new Error(
            `This file exceeds the caller cell limit (${options?.maxCells}).`,
          );
        }
        throw new Error('This file does not contain any data.');
      }

      // Grow both axes to the final extent once, then fill. The last buffered
      // cell is the bottom-most one written, so its row is the extent — which
      // is also what `rowCount` reports, since a trailing blank row must not
      // inflate either the grid or the number the user is shown.
      const rowCount = pending[pending.length - 1][0].r;
      ensureWorksheetExtent(worksheet, { r: rowCount, c: maxColumn });
      replaceWorksheetCells(worksheet, pending);

      // One range patch for the whole header row rather than a style on each
      // cell: every per-cell patch is its own CRDT subtree, and stamping the
      // row cell-by-cell is what makes an imported document balloon (the XLSX
      // importer coalesces its patches for the same reason). The width is
      // `maxColumn` — the table's actual populated extent, already tracked
      // above at no extra cost — not the header row's own raw field count.
      // Using the header row's `row.length` instead was a bug: a header with
      // empty trailing fields (`name,qty,,` — `row.length` 4, 2 populated)
      // would bold columns the table never uses, so typing into one of those
      // columns later inherits bold unexpectedly. A header narrower than the
      // widest data row is the opposite case, and `maxColumn` gets that right
      // too — the bold band matches the table's real width either way.
      //
      // Skipped outright when the caller knows there is no header: the first
      // row is then one of the user's own records, and styling it as a heading
      // is a claim about their data that nothing supports.
      if (options?.hasHeader !== false) {
        worksheet.rangeStyles = [
          {
            range: [
              { r: headerRow, c: 1 },
              { r: headerRow, c: maxColumn },
            ],
            style: { b: true },
          },
        ];
      }

      return {
        name: options?.sheetName?.trim() || 'Imported Sheet',
        worksheet,
        rowCount,
        cellCount,
        columnCount: maxColumn,
        truncated,
      };
    },
  };
}

/**
 * `importTable` writes a row-major table into a single editable worksheet.
 *
 * A thin loop over `createTableWriter` so an in-memory table and a streamed one
 * cannot disagree about the budget, the header, or the empty-input error. Use
 * the writer directly when rows arrive incrementally.
 */
export function importTable(
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  options?: TableImportOptions,
): ImportedTable {
  const writer = createTableWriter(options);
  for (const row of rows) {
    if (!writer.push(row)) break;
  }
  return writer.finish();
}
// Modified by Nautilo: imported engine lint and type safety.
