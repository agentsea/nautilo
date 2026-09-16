// Modified by Nautilo: DOM-free entry for server-side spreadsheet work.
export { MemStore } from './store/memory';
export type { Store } from './store/store';
export { Sheet as HeadlessSheet } from './model/worksheet/sheet';
export { calculate as calculateSheet } from './model/worksheet/calculator';

export { extractReferences, expandUnboundedRanges, extractTokens } from './formula/formula';
export {
  parseRef,
  parseRanges,
  toSref,
  isCrossSheetRef,
  parseCrossSheetRef,
} from './model/core/coordinates';
export type {
  Axis,
  Cell,
  CellStyle,
  Grid,
  Range,
  Ref,
  SelectionType,
  Sref,
} from './model/core/types';
export {
  moveFormula,
  shiftFormula,
} from './model/worksheet/shifting';
export { normalizeConditionalFormatRule } from './model/worksheet/conditional-format';
export { normalizeDataValidationRule } from './model/worksheet/data-validation';
export { normalizeRangeStylePatch } from './model/worksheet/range-styles';
export { cellFromInput } from './model/worksheet/input';
export {
  createSpreadsheetDocument,
  createWorksheet,
} from './model/workbook/worksheet-document';
export type {
  SpreadsheetDocument,
  Worksheet,
} from './model/workbook/worksheet-document';
export {
  generateTabId,
  getNextDefaultSheetName,
  getUniqueTabName,
  normalizeTabName,
} from './model/workbook/tab-name';
export {
  getWorksheetCell,
  getWorksheetEntries,
  normalizeStoredCell,
  replaceWorksheetCells,
  writeWorksheetCell,
} from './model/workbook/worksheet-grid';
export { parseWorksheetCellKey } from './model/workbook/worksheet-record';
export {
  applyWorksheetMove,
  applyWorksheetShift,
  moveCrossTabDataRanges,
  shiftCrossTabDataRanges,
} from './model/workbook/worksheet-structure';

// Modified by Nautilo: shared data operations use the same display/filter semantics.
export { formatValue } from './model/worksheet/format';
export { matchesFilterCondition } from './model/worksheet/filter';
export { resolveWorksheetCellStyle } from './model/workbook/worksheet-grid';
