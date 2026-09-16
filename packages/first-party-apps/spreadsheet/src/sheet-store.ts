import {
  MemStore,
  applyWorksheetMove,
  applyWorksheetShift,
  getWorksheetEntries,
  moveFormula,
  moveCrossTabDataRanges,
  normalizeConditionalFormatRule,
  normalizeDataValidationRule,
  normalizeRangeStylePatch,
  normalizeStoredCell,
  parseRef,
  replaceWorksheetCells,
  shiftFormula,
  shiftCrossTabDataRanges,
  type Axis,
  type Cell,
  type Grid,
  type Sref,
  type Ref,
  type Range,
  type Store,
  type Worksheet,
} from "../engine/node.js";
import { validateSheetDocument, type SheetDocument } from "./sheet-document";

export type SheetStore = {
  store: Store;
  snapshot(): Promise<SheetDocument>;
  adoptCalculated(base: SheetDocument, next: SheetDocument): Promise<boolean>;
  withoutHistory<T>(work: (store: Store) => Promise<T>): Promise<T>;
  dispose(): void;
};

type HistoryEntry = {
  document: SheetDocument;
  affectedTabId?: string;
  affectedRange?: Range;
};

export class SheetHistory {
  private undoEntries: HistoryEntry[] = [];
  private redoEntries: HistoryEntry[] = [];

  record(
    before: SheetDocument,
    after: SheetDocument,
    affectedTabId?: string,
    affectedRange?: Range,
  ): boolean {
    if (stableJson(before) === stableJson(after)) return false;
    this.undoEntries.push({
      document: structuredClone(before),
      affectedTabId,
      affectedRange: structuredClone(affectedRange),
    });
    this.redoEntries.length = 0;
    return true;
  }

  undo(current: SheetDocument, activeTabId: string): { document: SheetDocument; result: { success: boolean; affectedRange?: Range } } {
    const entry = this.undoEntries.pop();
    if (!entry) return { document: structuredClone(current), result: { success: false } };
    this.redoEntries.push({
      document: structuredClone(current),
      affectedTabId: entry.affectedTabId,
      affectedRange: structuredClone(entry.affectedRange),
    });
    return {
      document: structuredClone(entry.document),
      result: {
        success: true,
        ...(entry.affectedTabId === activeTabId && entry.affectedRange
          ? { affectedRange: structuredClone(entry.affectedRange) }
          : {}),
      },
    };
  }

  redo(current: SheetDocument, activeTabId: string): { document: SheetDocument; result: { success: boolean; affectedRange?: Range } } {
    const entry = this.redoEntries.pop();
    if (!entry) return { document: structuredClone(current), result: { success: false } };
    this.undoEntries.push({
      document: structuredClone(current),
      affectedTabId: entry.affectedTabId,
      affectedRange: structuredClone(entry.affectedRange),
    });
    return {
      document: structuredClone(entry.document),
      result: {
        success: true,
        ...(entry.affectedTabId === activeTabId && entry.affectedRange
          ? { affectedRange: structuredClone(entry.affectedRange) }
          : {}),
      },
    };
  }

  canUndo(): boolean { return this.undoEntries.length > 0; }
  canRedo(): boolean { return this.redoEntries.length > 0; }
  clear(): void { this.undoEntries.length = 0; this.redoEntries.length = 0; }
}

export function createSheetHistory(): SheetHistory {
  return new SheetHistory();
}

type DirtyGroup =
  | "cells"
  | "dimensions"
  | "styles"
  | "rangeStyles"
  | "conditionalFormats"
  | "dataValidations"
  | "merges"
  | "filter"
  | "hidden"
  | "pivot"
  | "freeze"
  | "comments"
  | "structure";

const GROUP_BY_MUTATOR: Record<string, DirtyGroup> = {
  set: "cells",
  delete: "cells",
  deleteRange: "cells",
  setGrid: "cells",
  setDimensionSize: "dimensions",
  setColumnStyle: "styles",
  setRowStyle: "styles",
  setSheetStyle: "styles",
  addRangeStyle: "rangeStyles",
  setRangeStyles: "rangeStyles",
  setConditionalFormats: "conditionalFormats",
  setDataValidations: "dataValidations",
  setMerge: "merges",
  deleteMerge: "merges",
  setFilterState: "filter",
  setHiddenState: "hidden",
  setPivotDefinition: "pivot",
  setFreezePane: "freeze",
  addThread: "comments",
  addReply: "comments",
  editComment: "comments",
  deleteComment: "comments",
  setThreadResolved: "comments",
};

const CELL_FIELDS = new Set(["v", "f", "s", "spillRows", "spillCols", "spillAnchor", "spillBlocked"]);
function unknownCellFields(cell: Cell | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(cell ?? {}).filter(([key]) => !CELL_FIELDS.has(key)));
}
function preserveCell(cell: Cell): Cell | null {
  const normalized = normalizeStoredCell(cell);
  const unknown = unknownCellFields(cell);
  return Object.keys(unknown).length ? { ...normalized, ...unknown } : normalized;
}

function numericRecord<T>(value: Record<string, T> | undefined, label: string): Array<[number, T]> {
  const result: Array<[number, T]> = [];
  for (const [key, item] of Object.entries(value ?? {})) {
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 1 || String(index) !== key) {
      throw new Error(`${label} must use positive 1-based integer keys`);
    }
    result.push([index, structuredClone(item)]);
  }
  return result;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function assertCanonicalMetadata<T>(
  values: T[] | undefined,
  label: string,
  normalize: (value: T) => T | null | undefined,
): void {
  for (const value of values ?? []) {
    let normalized: T | null | undefined;
    try {
      normalized = normalize(value);
    } catch {
      normalized = undefined;
    }
    if (!normalized || stableJson(normalized) !== stableJson(value)) {
      throw new Error(`${label} contains a value the store cannot preserve exactly`);
    }
  }
}

async function hydrate(store: MemStore, worksheet: Worksheet): Promise<void> {
  assertCanonicalMetadata(worksheet.rangeStyles, "rangeStyles", normalizeRangeStylePatch);
  assertCanonicalMetadata(
    worksheet.conditionalFormats,
    "conditionalFormats",
    normalizeConditionalFormatRule,
  );
  assertCanonicalMetadata(worksheet.dataValidations, "dataValidations", normalizeDataValidationRule);
  // Comments have no identity-preserving setter. Seed only that private
  // MemStore field through load(), then overwrite every supported mutable
  // field through public setters below. This deliberately does not rely on
  // load() for the indexed metadata it currently drops.
  store.load({
    ...structuredClone(worksheet),
    cells: {},
    rowHeights: {},
    colWidths: {},
    rowStyles: {},
    colStyles: {},
    sheetStyle: undefined,
    rangeStyles: [],
    conditionalFormats: [],
    dataValidations: [],
    merges: {},
    filter: undefined,
    hiddenRows: undefined,
    hiddenColumns: undefined,
    pivotTable: undefined,
    frozenRows: 0,
    frozenCols: 0,
  });
  await store.setGrid(new Map(getWorksheetEntries(worksheet)));
  for (const [index, size] of numericRecord(worksheet.rowHeights, "rowHeights")) {
    if (!Number.isFinite(size)) throw new Error("rowHeights values must be finite numbers");
    await store.setDimensionSize("row", index, size);
  }
  for (const [index, size] of numericRecord(worksheet.colWidths, "colWidths")) {
    if (!Number.isFinite(size)) throw new Error("colWidths values must be finite numbers");
    await store.setDimensionSize("column", index, size);
  }
  for (const [index, style] of numericRecord(worksheet.rowStyles, "rowStyles")) {
    await store.setRowStyle(index, style);
  }
  for (const [index, style] of numericRecord(worksheet.colStyles, "colStyles")) {
    await store.setColumnStyle(index, style);
  }
  if (worksheet.sheetStyle !== undefined) await store.setSheetStyle(structuredClone(worksheet.sheetStyle));
  await store.setRangeStyles(structuredClone(worksheet.rangeStyles ?? []));
  await store.setConditionalFormats(structuredClone(worksheet.conditionalFormats ?? []));
  await store.setDataValidations(structuredClone(worksheet.dataValidations ?? []));
  for (const [sref, span] of Object.entries(worksheet.merges ?? {})) {
    await store.setMerge(parseRef(sref), structuredClone(span));
  }
  if (worksheet.filter) {
    await store.setFilterState({
      range: [
        { r: worksheet.filter.startRow, c: worksheet.filter.startCol },
        { r: worksheet.filter.endRow, c: worksheet.filter.endCol },
      ],
      columns: structuredClone(worksheet.filter.columns),
      hiddenRows: [...worksheet.filter.hiddenRows],
    });
  }
  if (worksheet.hiddenRows !== undefined || worksheet.hiddenColumns !== undefined) {
    await store.setHiddenState({
      rows: [...(worksheet.hiddenRows ?? [])],
      columns: [...(worksheet.hiddenColumns ?? [])],
    });
  }
  if (worksheet.pivotTable !== undefined) await store.setPivotDefinition(structuredClone(worksheet.pivotTable));
  await store.setFreezePane(worksheet.frozenRows, worksheet.frozenCols);
}

function mapRecord<T>(map: Map<number, T>): Record<string, T> {
  return Object.fromEntries([...map].map(([index, value]) => [String(index), structuredClone(value)]));
}

function assertStructuralArgs(axis: unknown, index: unknown, count: unknown): asserts axis is Axis {
  if (axis !== "row" && axis !== "column") throw new Error("axis must be row or column");
  if (!Number.isSafeInteger(index) || (index as number) < 1) throw new Error("structural index must be a positive integer");
  if (!Number.isSafeInteger(count) || (count as number) === 0) throw new Error("structural count must be a non-zero integer");
}

const LOCAL_REF = String.raw`(?:\$?[A-Za-z]+\$?[1-9][0-9]*|\$?[A-Za-z]+|[1-9][0-9]*)`;
const CROSS_SHEET_REFERENCE = new RegExp(
  String.raw`^(?:'([^']+)'|([A-Za-z][A-Za-z0-9]*))!(${LOCAL_REF}(?::${LOCAL_REF})?)(?![A-Za-z0-9_$])`,
);

function rewriteCrossSheetReferences(
  formula: string,
  sheetName: string,
  rewriteLocal: (localFormula: string) => string,
): string {
  let result = "";
  let index = 0;
  let inString = false;
  while (index < formula.length) {
    const char = formula[index];
    if (char === '"') {
      if (inString && formula[index + 1] === '"') {
        result += '""';
        index += 2;
        continue;
      }
      inString = !inString;
      result += char;
      index += 1;
      continue;
    }
    if (!inString) {
      const match = CROSS_SHEET_REFERENCE.exec(formula.slice(index));
      if (match && (match[1] ?? match[2]).toUpperCase() === sheetName.toUpperCase()) {
        const prefixLength = match[0].length - match[3].length;
        result += match[0].slice(0, prefixLength) + rewriteLocal(`=${match[3]}`).slice(1);
        index += match[0].length;
        continue;
      }
    }
    result += char;
    index += 1;
  }
  return result;
}

function rewriteDependentSheetFormulas(
  document: SheetDocument,
  sourceTabId: string,
  rewriteLocal: (localFormula: string) => string,
): void {
  const sheetName = document.tabs[sourceTabId].name;
  for (const otherTabId of document.tabOrder) {
    if (otherTabId === sourceTabId) continue;
    for (const [, cell] of getWorksheetEntries(document.sheets[otherTabId])) {
      if (!cell.f) continue;
      const rewritten = rewriteCrossSheetReferences(cell.f, sheetName, rewriteLocal);
      if (rewritten !== cell.f) {
        cell.f = rewritten;
        delete cell.v;
      }
    }
  }
}

function assertSupportedMutation(property: string, args: unknown[]): void {
  const supported = (normalize: (value: never) => unknown, value: unknown): boolean => {
    try {
      return !!normalize(value as never);
    } catch {
      return false;
    }
  };
  if (property === "addRangeStyle") {
    if (!supported(normalizeRangeStylePatch, args[0])) throw new Error("range style patch is unsupported");
    return;
  }
  if (property === "setRangeStyles") {
    if (!Array.isArray(args[0]) || args[0].some((value) => !supported(normalizeRangeStylePatch, value))) {
      throw new Error("range style patches contain an unsupported value");
    }
    return;
  }
  if (property === "setConditionalFormats") {
    if (!Array.isArray(args[0]) || args[0].some((value) => !supported(normalizeConditionalFormatRule, value))) {
      throw new Error("conditional formats contain an unsupported value");
    }
    return;
  }
  if (property === "setDataValidations") {
    if (!Array.isArray(args[0]) || args[0].some((value) => !supported(normalizeDataValidationRule, value))) {
      throw new Error("data validations contain an unsupported value");
    }
  }
}

function unionRanges(left: Range | undefined, right: Range | undefined): Range | undefined {
  if (!left) return right ? structuredClone(right) : undefined;
  if (!right) return structuredClone(left);
  return [
    { r: Math.min(left[0].r, right[0].r), c: Math.min(left[0].c, right[0].c) },
    { r: Math.max(left[1].r, right[1].r), c: Math.max(left[1].c, right[1].c) },
  ];
}

function affectedRangeFor(property: string, args: unknown[]): Range | undefined {
  const single = (value: unknown): Range | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const ref = value as Partial<Ref>;
    if (!Number.isSafeInteger(ref.r) || !Number.isSafeInteger(ref.c)) return undefined;
    return [structuredClone(ref as Ref), structuredClone(ref as Ref)];
  };
  if (property === "set" || property === "delete" || property === "deleteMerge") return single(args[0]);
  if (property === "deleteRange") return structuredClone(args[0] as Range);
  if (property === "setGrid" && args[0] instanceof Map) {
    let affected: Range | undefined;
    for (const sref of args[0].keys()) affected = unionRanges(affected, single(parseRef(String(sref))));
    return affected;
  }
  if (property === "setDimensionSize" || property === "setColumnStyle" || property === "setRowStyle") {
    const axis = property === "setDimensionSize" ? args[0] : property === "setRowStyle" ? "row" : "column";
    const index = property === "setDimensionSize" ? args[1] : args[0];
    if (!Number.isSafeInteger(index)) return undefined;
    return single(axis === "row" ? { r: index as number, c: 1 } : { r: 1, c: index as number });
  }
  if (property === "addRangeStyle") return structuredClone((args[0] as { range: Range }).range);
  if (property === "setMerge") {
    const anchor = args[0] as Ref;
    const span = args[1] as { rs: number; cs: number };
    return [structuredClone(anchor), { r: anchor.r + span.rs - 1, c: anchor.c + span.cs - 1 }];
  }
  if (property === "setFilterState") return structuredClone((args[0] as { range?: Range } | undefined)?.range);
  return undefined;
}

export async function createSheetStore(
  document: SheetDocument,
  tabId: string,
  onChange: () => void,
  history: SheetHistory = createSheetHistory(),
  onEditActivity: (active: boolean) => void = () => undefined,
): Promise<SheetStore> {
  let canonical = structuredClone(validateSheetDocument(document));
  if (canonical.tabs[tabId]?.type !== "sheet") {
    throw new Error("This source tab is read-only. Open an ordinary sheet to edit the workbook.");
  }
  if (!canonical.sheets[tabId] || !canonical.tabOrder.includes(tabId)) {
    throw new Error(`sheet does not exist: ${tabId}`);
  }

  let inner = new MemStore();
  await hydrate(inner, structuredClone(canonical.sheets[tabId]));
  let suppressHistory = 0;
  const batchGroups = new Set<DirtyGroup>();
  let requestedBatchDepth = 0;
  let activeBatchDepth = 0;
  let batchStart: SheetDocument | undefined;
  let batchAffectedRange: Range | undefined;
  let batchChanged = false;
  let batchFailure: unknown;
  let snapshotFailure: unknown;
  let disposed = false;
  let pending: Promise<unknown> = Promise.resolve();
  let operations = 0;

  const enqueue = <T>(operation: () => Promise<T> | T): Promise<T> => {
    operations += 1;
    if (!disposed) onEditActivity(true);
    const result = pending.then(operation).finally(() => {
      operations -= 1;
      if (!disposed) onEditActivity(operations > 0 || requestedBatchDepth > 0);
    });
    pending = result.catch(() => undefined);
    return result;
  };

  const signal = () => {
    if (!disposed) onChange();
  };

  const materialize = async (
    base: SheetDocument,
    groups: Iterable<DirtyGroup>,
  ): Promise<SheetDocument> => {
    const selected = new Set(groups);
    const next = structuredClone(base);
    const ws = next.sheets[tabId];

    if (selected.has("cells")) {
      const bounds = await inner.getUsedBounds();
      const grid: Grid = bounds ? await inner.getGrid(bounds) : new Map<Sref, Cell>();
      const entries: Array<[ReturnType<typeof parseRef>, Cell]> = [];
      for (const [sref, cell] of grid) entries.push([parseRef(sref), structuredClone(cell)]);
      replaceWorksheetCells(ws, entries);
    }
    if (selected.has("dimensions")) {
      ws.rowHeights = mapRecord(await inner.getDimensionSizes("row"));
      ws.colWidths = mapRecord(await inner.getDimensionSizes("column"));
    }
    if (selected.has("styles")) {
      ws.rowStyles = mapRecord(await inner.getRowStyles());
      ws.colStyles = mapRecord(await inner.getColumnStyles());
      ws.sheetStyle = structuredClone(await inner.getSheetStyle());
    }
    if (selected.has("rangeStyles")) ws.rangeStyles = structuredClone(await inner.getRangeStyles());
    if (selected.has("conditionalFormats")) {
      ws.conditionalFormats = structuredClone(await inner.getConditionalFormats());
    }
    if (selected.has("dataValidations")) {
      ws.dataValidations = structuredClone(await inner.getDataValidations());
    }
    if (selected.has("merges")) {
      ws.merges = Object.fromEntries(
        [...await inner.getMerges()].map(([sref, span]) => [sref, structuredClone(span)]),
      );
    }
    if (selected.has("filter")) {
      const filter = await inner.getFilterState();
      ws.filter = filter ? {
        startRow: filter.range[0].r,
        endRow: filter.range[1].r,
        startCol: filter.range[0].c,
        endCol: filter.range[1].c,
        columns: structuredClone(filter.columns),
        hiddenRows: [...filter.hiddenRows],
      } : undefined;
    }
    if (selected.has("hidden")) {
      const hidden = await inner.getHiddenState();
      ws.hiddenRows = hidden ? [...hidden.rows] : undefined;
      ws.hiddenColumns = hidden ? [...hidden.columns] : undefined;
    }
    if (selected.has("pivot")) ws.pivotTable = structuredClone(await inner.getPivotDefinition());
    if (selected.has("freeze")) {
      const freeze = await inner.getFreezePane();
      ws.frozenRows = freeze.frozenRows;
      ws.frozenCols = freeze.frozenCols;
    }
    return validateSheetDocument(next);
  };

  const commit = (
    before: SheetDocument,
    next: SheetDocument,
    affectedRange?: Range,
  ): boolean => {
    if (stableJson(before) === stableJson(next)) return false;
    canonical = next;
    if (activeBatchDepth > 0) {
      batchChanged = true;
      batchAffectedRange = unionRanges(batchAffectedRange, affectedRange);
      return true;
    }
    if (suppressHistory === 0) history.record(before, next, tabId, affectedRange);
    signal();
    return true;
  };

  const restore = async (documentToRestore: SheetDocument): Promise<void> => {
    const replacement = new MemStore();
    await hydrate(replacement, structuredClone(documentToRestore.sheets[tabId]));
    inner = replacement;
    canonical = structuredClone(documentToRestore);
  };

  const runStructural = async (method: "shiftCells" | "moveCells", args: unknown[]) => {
    if (batchGroups.size > 0) {
      canonical = await materialize(canonical, batchGroups);
      batchGroups.clear();
    }
    const before = structuredClone(canonical);
    const next = structuredClone(canonical);
    const ws = next.sheets[tabId];
    const knownWorksheetFields = new Set(["cells", "rowOrder", "colOrder", "nextRowId", "nextColId", "rowHeights", "colWidths", "colStyles", "rowStyles", "sheetStyle", "rangeStyles", "conditionalFormats", "dataValidations", "merges", "filter", "hiddenRows", "hiddenColumns", "charts", "images", "comments", "frozenRows", "frozenCols", "pivotTable"]);
    if (Object.keys(ws).some(key => !knownWorksheetFields.has(key))) {
      throw new Error("Structural editing cannot safely move unsupported worksheet metadata.");
    }
    if (method === "shiftCells" && (args[2] as number) < 0) {
      const [axis, index, count] = args as [Axis, number, number];
      if (getWorksheetEntries(ws).some(([ref, cell]) => {
        const position = parseRef(ref)[axis === "row" ? "r" : "c"];
        return position >= index && position < index - count && Object.keys(unknownCellFields(cell)).length;
      })) throw new Error("This operation would discard unsupported cell metadata.");
    }
    if (method === "shiftCells") {
      const [axis, index, count] = args;
      assertStructuralArgs(axis, index, count);
      applyWorksheetShift({
        ws,
        axis,
        index: index as number,
        count: count as number,
        normalizeCell: preserveCell,
        invalidateFormulaValues: true,
      });
      shiftCrossTabDataRanges(next.sheets, tabId, axis, index as number, count as number);
      rewriteDependentSheetFormulas(
        next,
        tabId,
        (formula) => shiftFormula(formula, axis, index as number, count as number),
      );

    } else {
      const [axis, srcIndex, count, dstIndex] = args;
      assertStructuralArgs(axis, srcIndex, count);
      if ((count as number) < 1 || !Number.isSafeInteger(dstIndex) || (dstIndex as number) < 1) {
        throw new Error("moveCells requires positive count and destination index");
      }
      applyWorksheetMove({
        ws,
        axis,
        srcIndex: srcIndex as number,
        count: count as number,
        dstIndex: dstIndex as number,
        normalizeCell: preserveCell,
        invalidateFormulaValues: true,
      });
      moveCrossTabDataRanges(
        next.sheets,
        tabId,
        axis,
        srcIndex as number,
        count as number,
        dstIndex as number,
      );
      rewriteDependentSheetFormulas(
        next,
        tabId,
        (formula) => moveFormula(
          formula,
          axis,
          srcIndex as number,
          count as number,
          dstIndex as number,
        ),
      );

    }
    const [axis, firstIndex, count, destination] = args;
    const startIndex = method === "moveCells"
      ? Math.min(firstIndex as number, destination as number)
      : firstIndex as number;
    const lastIndex = method === "moveCells"
      ? Math.max(firstIndex as number + (count as number) - 1, destination as number)
      : firstIndex as number + Math.abs(count as number) - 1;
    const affected: Range = axis === "row"
      ? [{ r: startIndex, c: 1 }, { r: lastIndex, c: 1 }]
      : [{ r: 1, c: startIndex }, { r: 1, c: lastIndex }];
    // Hydrate the canonical shifted workbook. MemStore's own shift normalizer
    // drops fields it does not understand, which would corrupt a later save.
    const replacement = new MemStore();
    await hydrate(replacement, next.sheets[tabId]);
    inner = replacement;
    commit(before, validateSheetDocument(next), affected);
  };

  const proxy = new Proxy(inner as Store, {
    get(_target, property) {
      if (property === "beginBatch") {
        return () => {
          requestedBatchDepth += 1;
          void enqueue(() => {
            if (activeBatchDepth === 0) {
              batchStart = structuredClone(canonical);
              batchFailure = undefined;
            }
            activeBatchDepth += 1;
            inner.beginBatch();
          });
        };
      }
      if (property === "endBatch") {
        return () => {
          if (requestedBatchDepth === 0) throw new Error("endBatch called without beginBatch");
          requestedBatchDepth -= 1;
          void enqueue(async () => {
            try {
              inner.endBatch();
              if (activeBatchDepth === 1 && !batchFailure && batchGroups.size > 0) {
                const next = await materialize(canonical, batchGroups);
                batchChanged = batchChanged || stableJson(canonical) !== stableJson(next);
                canonical = next;
              }
            } catch (error) {
              batchFailure = error;
              snapshotFailure = error;
            } finally {
              activeBatchDepth -= 1;
              if (activeBatchDepth === 0) {
                if (batchFailure) await restore(batchStart ?? canonical);
                else if (batchChanged && batchStart) {
                  if (suppressHistory === 0) history.record(batchStart, canonical, tabId, batchAffectedRange);
                  signal();
                }
                batchGroups.clear();
                batchStart = undefined;
                batchAffectedRange = undefined;
                batchChanged = false;
                batchFailure = undefined;
              }
            }
          });
        };
      }
      if (property === "undo" || property === "redo") {
        return () => enqueue(async () => {
          if (activeBatchDepth > 0 || requestedBatchDepth > 0) {
            throw new Error(`cannot ${property} while a store batch is open`);
          }
          const current = structuredClone(canonical);
          const change = property === "undo" ? history.undo(current, tabId) : history.redo(current, tabId);
          if (!change.result.success) return change.result;
          try { await restore(change.document); }
          catch (error) {
            if (property === "undo") history.redo(change.document, tabId);
            else history.undo(change.document, tabId);
            throw error;
          }
          signal();
          return change.result;
        });
      }
      if (property === "canUndo") return () => history.canUndo();
      if (property === "canRedo") return () => history.canRedo();
      if (property === "shiftCells" || property === "moveCells") {
        return (...args: unknown[]) => enqueue(async () => {
          const before = structuredClone(canonical);
          try {
            if (batchFailure) throw asError(batchFailure);
            return await runStructural(property, structuredClone(args));
          } catch (error) {
            if (activeBatchDepth > 0) { batchFailure = error; snapshotFailure = error; }
            await restore(batchStart ?? before);
            batchGroups.clear();
            throw error;
          }
        });
      }
      if (typeof property === "string" && Object.hasOwn(GROUP_BY_MUTATOR, property)) {
        return (...args: unknown[]) => enqueue(async () => {
          const before = canonical;
          try {
          if (batchFailure) throw asError(batchFailure);
          if (property === "addThread" || property === "addReply" || property === "editComment" ||
              property === "deleteComment" || property === "setThreadResolved") {
            throw new Error("comment mutation is unavailable because MemStore cannot preserve persisted thread IDs");
          }
          assertSupportedMutation(property, args);
            const safeArgs = structuredClone(args);
            if (property === "set") {
              const existing = await inner.get(safeArgs[0] as Ref);
              safeArgs[1] = { ...unknownCellFields(existing), ...(safeArgs[1] as Cell) };
            }
            if (property === "setGrid") {
              for (const [ref, cell] of safeArgs[0] as Map<string, Cell>) {
                const existing = await inner.get(parseRef(ref));
                (safeArgs[0] as Map<string, Cell>).set(ref, { ...unknownCellFields(existing), ...cell });
              }
            }
            if (property === "delete" || property === "deleteRange") {
              const candidates = property === "delete" ? [await inner.get(safeArgs[0] as Ref)] : [...(await inner.getGrid(safeArgs[0] as Range)).values()];
              if (candidates.some(cell => Object.keys(unknownCellFields(cell)).length)) throw new Error("This operation would discard unsupported cell metadata.");
            }
            const method = Reflect.get(inner, property, inner) as (...values: unknown[]) => unknown;
            const result = await method.apply(inner, safeArgs);
            if (result === false || (result instanceof Set && result.size === 0)) return result;
            if (activeBatchDepth > 0) {
              batchGroups.add(GROUP_BY_MUTATOR[property]);
              batchAffectedRange = unionRanges(batchAffectedRange, affectedRangeFor(property, args));
            } else {
              const next = await materialize(canonical, [GROUP_BY_MUTATOR[property]]);
              commit(before, next, affectedRangeFor(property, args));
            }
            return result;
          } catch (error) {
            if (activeBatchDepth > 0) { batchFailure = error; snapshotFailure = error; }
            await restore(batchStart ?? before);
            batchGroups.clear();
            throw error;
          }
        });
      }
      const value: unknown = Reflect.get(inner, property, inner);
      return typeof value === "function" ? (...args: unknown[]): unknown => Reflect.apply(value, inner, args) : value;
    },
  });

  return {
    store: proxy,
    async snapshot(): Promise<SheetDocument> {
      await pending;
      if (activeBatchDepth > 0 || requestedBatchDepth > 0) {
        throw new Error("cannot snapshot while a store batch is open");
      }
      if (snapshotFailure) {
        const error = snapshotFailure;
        snapshotFailure = undefined;
        throw asError(error);
      }
      return structuredClone(canonical);
    },
    adoptCalculated(base: SheetDocument, next: SheetDocument): Promise<boolean> {
      return enqueue(async () => {
        // A user may edit while headless calculation awaits. Never replace that
        // newer store with a result computed from the previous snapshot.
        if (stableJson(canonical) !== stableJson(base)) return false;
        if (stableJson(base) !== stableJson(next)) await restore(next);
        return true;
      });
    },
    async withoutHistory<T>(work: (store: Store) => Promise<T>): Promise<T> {
      suppressHistory += 1;
      try { const result = await work(proxy); await pending; return result; }
      finally { suppressHistory -= 1; }
    },
    dispose() {
      disposed = true;
    },
  };
}
