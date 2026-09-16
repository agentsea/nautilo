import {
  HeadlessSheet,
  MemStore,
  calculateSheet,
  expandUnboundedRanges,
  extractReferences,
  getWorksheetEntries,
  isCrossSheetRef,
  parseCrossSheetRef,
  parseRanges,
  parseRef,
  replaceWorksheetCells,
  type Cell,
  type Grid,
  type Range,
  type Sref,
} from "../engine/node.js";
import { validateSheetDocument, type SheetDocument } from "./sheet-document";
import { refreshSheetFilters } from "./sheet-filter";

type Node = {
  id: string;
  sheetId: string;
  ref: Sref;
  dependencies: Set<string>;
  dependants: Set<string>;
};

const KNOWN_CELL_KEYS = new Set([
  "v",
  "f",
  "s",
  "spillRows",
  "spillCols",
  "spillAnchor",
  "spillBlocked",
]);
const FULL_REFERENCE = /^\$?[A-Za-z]+\$?[1-9][0-9]*$/;

function inside(ref: Sref, range: Range): boolean {
  const point = parseRef(ref);
  return point.r >= range[0].r && point.r <= range[1].r && point.c >= range[0].c && point.c <= range[1].c;
}

function unknownCellFields(cell: Cell): Record<string, unknown> {
  return Object.fromEntries(Object.entries(cell).filter(([key]) => !KNOWN_CELL_KEYS.has(key)));
}

function assertNoCrossSheetUnboundedRanges(document: SheetDocument): void {
  for (const tabId of document.tabOrder) {
    if (document.tabs[tabId].type !== "sheet") continue;
    for (const [, cell] of getWorksheetEntries(document.sheets[tabId])) {
      if (!cell.f) continue;
      for (const reference of extractReferences(cell.f)) {
        if (!isCrossSheetRef(reference)) continue;
        const { localRef } = parseCrossSheetRef(reference);
        if (!localRef.includes(":")) continue;
        const [from, to, ...rest] = localRef.split(":");
        if (rest.length > 0 || !FULL_REFERENCE.test(from ?? "") || !FULL_REFERENCE.test(to ?? "")) {
          throw new Error(`Cross-sheet unbounded range references are unsupported: ${reference}`);
        }
      }
    }
  }
}

function spillTopology(grids: Map<string, Grid>): string {
  const topology: unknown[] = [];
  for (const [sheetId, grid] of grids) {
    for (const [ref, cell] of grid) {
      if (
        cell.spillAnchor === undefined &&
        cell.spillRows === undefined &&
        cell.spillCols === undefined &&
        cell.spillBlocked === undefined
      ) continue;
      topology.push([
        sheetId,
        ref,
        cell.spillAnchor ?? null,
        cell.spillRows ?? null,
        cell.spillCols ?? null,
        cell.spillBlocked ?? false,
      ]);
    }
  }
  topology.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify(topology);
}

async function refreshGrid(
  sheetId: string,
  stores: Map<string, MemStore>,
  grids: Map<string, Grid>,
): Promise<void> {
  const store = stores.get(sheetId)!;
  const bounds = await store.getUsedBounds();
  grids.set(sheetId, bounds ? await store.getGrid(bounds) : new Map<Sref, Cell>());
}

async function buildDependencyGraph(
  formulaNodes: ReadonlyArray<{ sheetId: string; ref: Sref }>,
  names: Map<string, string>,
  grids: Map<string, Grid>,
  stores: Map<string, MemStore>,
): Promise<Map<string, Node>> {
  const nodeId = (sheetId: string, ref: Sref) => JSON.stringify([sheetId, ref]);
  const nodes = new Map<string, Node>();
  for (const formulaNode of formulaNodes) {
    const id = nodeId(formulaNode.sheetId, formulaNode.ref);
    nodes.set(id, {
      id,
      ...formulaNode,
      dependencies: new Set(),
      dependants: new Set(),
    });
  }

  for (const node of nodes.values()) {
    const store = stores.get(node.sheetId)!;
    const formula = grids.get(node.sheetId)!.get(node.ref)?.f;
    if (!formula) continue;
    const expanded = expandUnboundedRanges(formula, await store.getUsedBounds());
    for (const reference of extractReferences(expanded)) {
      const cross = isCrossSheetRef(reference) ? parseCrossSheetRef(reference) : undefined;
      const sheetId = cross ? names.get(cross.sheetName.toUpperCase()) : node.sheetId;
      if (!sheetId) continue;
      const ranges = parseRanges(cross?.localRef ?? reference);
      for (const candidate of nodes.values()) {
        if (candidate.sheetId !== sheetId) continue;
        if (ranges.some((range) => inside(candidate.ref, range))) node.dependencies.add(candidate.id);
      }
      // A formula that reads any current spill ghost depends on the owning
      // formula, because the ghost's cached value is derived from that anchor.
      for (const [ref, cell] of grids.get(sheetId) ?? new Map<Sref, Cell>()) {
        if (!cell.spillAnchor || !ranges.some((range) => inside(ref, range))) continue;
        const anchorId = nodeId(sheetId, cell.spillAnchor);
        if (nodes.has(anchorId)) node.dependencies.add(anchorId);
      }
    }
    for (const dependency of node.dependencies) nodes.get(dependency)!.dependants.add(node.id);
  }
  return nodes;
}

async function cleanCyclicFormula(
  node: Node,
  stores: Map<string, MemStore>,
  grids: Map<string, Grid>,
): Promise<void> {
  const store = stores.get(node.sheetId)!;
  const grid = grids.get(node.sheetId)!;
  for (const [ref, cell] of grid) {
    if (cell.spillAnchor !== node.ref) continue;
    const preserved = unknownCellFields(cell);
    const replacement = {
      ...preserved,
      ...(cell.s === undefined ? {} : { s: cell.s }),
    } as Cell;
    if (Object.keys(replacement).length > 0) await store.set(parseRef(ref), replacement);
    else await store.delete(parseRef(ref));
  }

  const anchor = grid.get(node.ref)!;
  await store.set(parseRef(node.ref), {
    ...unknownCellFields(anchor),
    ...(anchor.s === undefined ? {} : { s: anchor.s }),
    f: anchor.f,
    v: "#REF!",
  } as Cell);
  await refreshGrid(node.sheetId, stores, grids);
}

async function evaluateDependencyPass(
  formulaNodes: ReadonlyArray<{ sheetId: string; ref: Sref }>,
  names: Map<string, string>,
  grids: Map<string, Grid>,
  stores: Map<string, MemStore>,
  sheets: Map<string, HeadlessSheet>,
): Promise<void> {
  const nodes = await buildDependencyGraph(formulaNodes, names, grids, stores);
  const remaining = new Map([...nodes].map(([id, node]) => [id, node.dependencies.size]));
  const queue = [...nodes.values()].filter((node) => node.dependencies.size === 0);

  for (let index = 0; index < queue.length; index++) {
    const node = queue[index];
    await calculateSheet(sheets.get(node.sheetId)!, new Map(), [node.ref]);
    await refreshGrid(node.sheetId, stores, grids);
    remaining.delete(node.id);
    for (const dependant of node.dependants) {
      const count = remaining.get(dependant)! - 1;
      remaining.set(dependant, count);
      if (count === 0) queue.push(nodes.get(dependant)!);
    }
  }

  for (const id of remaining.keys()) {
    await cleanCyclicFormula(nodes.get(id)!, stores, grids);
  }
}

/** Evaluate editable-sheet formulas with the pinned Wafflebase calculator in
 * workbook dependency order. Datasource and lakehouse caches remain source
 * data. The calculation repeats only while spill ownership changes. */
export async function recalculateWorkbook(input: SheetDocument): Promise<SheetDocument> {
  const document = structuredClone(validateSheetDocument(input));
  assertNoCrossSheetUnboundedRanges(document);

  const names = new Map(document.tabOrder.map((id) => [document.tabs[id].name.toUpperCase(), id]));
  const grids = new Map<string, Grid>();
  const stores = new Map<string, MemStore>();
  const sheets = new Map<string, HeadlessSheet>();
  const formulaNodes: Array<{ sheetId: string; ref: Sref }> = [];

  for (const id of document.tabOrder) {
    const store = new MemStore();
    const grid = new Map(getWorksheetEntries(document.sheets[id]));
    await store.setGrid(grid);
    for (const [ref, span] of Object.entries(document.sheets[id].merges ?? {})) {
      await store.setMerge(parseRef(ref), span);
    }
    const sheet = new HeadlessSheet(store);
    await sheet.loadMerges();
    sheet.setGridResolver((name, refs) => {
      const remoteId = names.get(name.toUpperCase());
      if (!remoteId) return undefined;
      const remoteGrid = grids.get(remoteId)!;
      return new Map([...remoteGrid].filter(([ref]) => refs.has(ref)));
    });
    grids.set(id, grid);
    stores.set(id, store);
    sheets.set(id, sheet);

    if (document.tabs[id].type !== "sheet") continue;
    for (const [ref, cell] of grid) {
      if (cell.f) formulaNodes.push({ sheetId: id, ref });
    }
  }

  // Warm formulas once so dynamic-array ghosts exist before dependency edges
  // are built. Values from this pass are provisional.
  for (const node of formulaNodes) {
    await calculateSheet(sheets.get(node.sheetId)!, new Map(), [node.ref]);
    await refreshGrid(node.sheetId, stores, grids);
  }

  const seenTopologies = new Set<string>();
  while (true) {
    const before = spillTopology(grids);
    if (seenTopologies.has(before)) {
      throw new Error("Formula recalculation produced unstable spill ownership.");
    }
    seenTopologies.add(before);
    await evaluateDependencyPass(formulaNodes, names, grids, stores, sheets);
    const after = spillTopology(grids);
    if (after === before) break;
    if (seenTopologies.has(after)) {
      throw new Error("Formula recalculation produced unstable spill ownership.");
    }
  }

  for (const id of document.tabOrder) {
    const original = new Map(getWorksheetEntries(document.sheets[id]));
    const grid = grids.get(id)!;
    for (const [ref, previous] of original) {
      const preserved = {
        ...unknownCellFields(previous),
        ...(previous.s === undefined ? {} : { s: previous.s }),
      };
      if (Object.keys(preserved).length > 0) {
        grid.set(ref, { ...preserved, ...(grid.get(ref) ?? {}) } as Cell);
      }
    }
    replaceWorksheetCells(
      document.sheets[id],
      [...grid].map(([ref, cell]) => [parseRef(ref), cell]),
    );
  }
  refreshSheetFilters(document);
  return validateSheetDocument(document);
}
