import { expect, test } from "bun:test";
import { getWorksheetEntries, replaceWorksheetCells, parseRef, type Worksheet, type Ref, type Cell } from "../engine/node.js";
import { addSheet, createSheetDocument } from "./sheet-document";
import { recalculateWorkbook } from "./sheet-calculation";

function setWorksheetGridCell(sheet: Worksheet, ref: Ref, cell: Cell) { replaceWorksheetCells(sheet, [...getWorksheetEntries(sheet).map(([ref,cell]) => [parseRef(ref),cell] as [Ref,Cell]), [ref,cell]]); }

async function expectRejectedMessage(promise: Promise<unknown>, expected: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    expect(error.message).toBe(expected);
    return;
  }
  throw new Error(`Expected rejection: ${expected}`);
}

test("recalculates local and multi-hop cross-sheet formulas before reading inactive caches", async () => {
  let doc = createSheetDocument();
  doc = addSheet(doc, "Middle").document;
  doc = addSheet(doc, "Last").document;
  const [a, b, c] = doc.tabOrder;
  setWorksheetGridCell(doc.sheets[a], { r: 1, c: 1 }, { v: "21" });
  setWorksheetGridCell(doc.sheets[b], { r: 1, c: 1 }, { f: "=Sheet1!A1*2", v: "1" });
  setWorksheetGridCell(doc.sheets[c], { r: 1, c: 1 }, { f: "=Middle!A1+1", v: "1" });
  setWorksheetGridCell(doc.sheets[c], { r: 1, c: 2 }, { f: "=A1+1" });
  const result = await recalculateWorkbook(doc);
  expect(new Map(getWorksheetEntries(result.sheets[c])).get("A1")?.v).toBe("43");
  expect(new Map(getWorksheetEntries(result.sheets[c])).get("B1")?.v).toBe("44");
  expect(new Map(getWorksheetEntries(doc.sheets[c])).get("A1")?.v).toBe("1");
});

test("cross-sheet cycles and downstream formulas produce deterministic engine errors", async () => {
  let doc = addSheet(createSheetDocument(), "Other").document;
  const [a,b] = doc.tabOrder;
  setWorksheetGridCell(doc.sheets[a], {r:1,c:1}, {f:"=Other!A1"});
  setWorksheetGridCell(doc.sheets[b], {r:1,c:1}, {f:"=Sheet1!A1"});
  setWorksheetGridCell(doc.sheets[b], {r:1,c:2}, {f:"=A1+1"});
  doc = await recalculateWorkbook(doc);
  expect(getWorksheetEntries(doc.sheets[b]).map(([,cell])=>cell.v)).toEqual(["#REF!", "#REF!"]);
});

test("refuses cross-sheet unbounded references before changing the input", async () => {
  const doc = addSheet(createSheetDocument(), "Other").document;
  const [sheet, other] = doc.tabOrder;
  setWorksheetGridCell(doc.sheets[other], { r: 1, c: 1 }, { v: "3" });
  setWorksheetGridCell(doc.sheets[sheet], { r: 1, c: 1 }, { f: "=SUM(Other!A:A)", v: "stale" });
  const before = structuredClone(doc);

  await expectRejectedMessage(
    recalculateWorkbook(doc),
    "Cross-sheet unbounded range references are unsupported: OTHER!A:A",
  );
  expect(doc).toEqual(before);
});

test("continues to calculate local whole-column ranges against used bounds", async () => {
  const doc = createSheetDocument();
  const sheet = doc.sheets[doc.tabOrder[0]];
  setWorksheetGridCell(sheet, { r: 1, c: 1 }, { v: "2" });
  setWorksheetGridCell(sheet, { r: 3, c: 1 }, { v: "5" });
  setWorksheetGridCell(sheet, { r: 1, c: 2 }, { f: "=SUM(A:A)" });

  const result = await recalculateWorkbook(doc);
  expect(new Map(getWorksheetEntries(result.sheets[result.tabOrder[0]])).get("B1")?.v).toBe("7");
});

test("rebuilds dependencies after a formula creates spill ghosts", async () => {
  const doc = createSheetDocument();
  const sheet = doc.sheets[doc.tabOrder[0]];
  // A1 is deliberately stored before D1. Its dependency on D1 only becomes
  // visible after D1 materializes the E2 spill ghost.
  setWorksheetGridCell(sheet, { r: 1, c: 1 }, { f: "=E2+1", v: "stale" });
  setWorksheetGridCell(sheet, { r: 1, c: 4 }, { f: "=MUNIT(2)" });

  const result = await recalculateWorkbook(doc);
  const grid = new Map(getWorksheetEntries(result.sheets[result.tabOrder[0]]));
  expect(grid.get("A1")?.v).toBe("2");
  expect(grid.get("D1")).toMatchObject({ f: "=MUNIT(2)", v: "1", spillRows: 2, spillCols: 2 });
  expect(grid.get("E2")).toMatchObject({ v: "1", spillAnchor: "D1" });
});

test("rejects a repeated spill ownership topology as unstable", async () => {
  const doc = createSheetDocument();
  const sheet = doc.sheets[doc.tabOrder[0]];
  // E2 alternates between being D1's spill ghost and being empty. The repeat
  // is detected from canonical ownership metadata rather than a pass limit.
  setWorksheetGridCell(sheet, { r: 1, c: 4 }, { f: "=MUNIT(2-E2)" });

  await expectRejectedMessage(
    recalculateWorkbook(doc),
    "Formula recalculation produced unstable spill ownership.",
  );
});

test("cleans cyclic spill ownership while preserving unknown cell fields", async () => {
  const doc = createSheetDocument();
  const sheet = doc.sheets[doc.tabOrder[0]];
  setWorksheetGridCell(sheet, { r: 1, c: 1 }, {
    f: "=A1",
    v: "stale",
    spillRows: 2,
    spillCols: 1,
    futureAnchor: { keep: true },
  } as unknown as Cell);
  setWorksheetGridCell(sheet, { r: 2, c: 1 }, {
    v: "stale ghost",
    spillAnchor: "A1",
    s: { b: true },
    futureGhost: "keep",
  } as unknown as Cell);

  const result = await recalculateWorkbook(doc);
  const grid = new Map(getWorksheetEntries(result.sheets[result.tabOrder[0]]));
  expect(grid.get("A1") as unknown).toEqual({
    f: "=A1",
    v: "#REF!",
    futureAnchor: { keep: true },
  });
  expect(grid.get("A2") as unknown).toEqual({
    s: { b: true },
    futureGhost: "keep",
  });
});

test("uses datasource values without recalculating their formula caches", async () => {
  const doc = addSheet(createSheetDocument(), "Source").document;
  const [sheetId, sourceId] = doc.tabOrder;
  doc.tabs[sourceId].type = "datasource";
  setWorksheetGridCell(doc.sheets[sourceId], { r: 1, c: 1 }, {
    f: "=1+1",
    v: "authoritative-cache",
    futureSource: "keep",
  } as unknown as Cell);
  setWorksheetGridCell(doc.sheets[sheetId], { r: 1, c: 1 }, { f: "=Source!A1" });
  const sourceBefore = structuredClone(doc.sheets[sourceId]);

  const result = await recalculateWorkbook(doc);
  expect(result.sheets[sourceId]).toEqual(sourceBefore);
  expect(new Map(getWorksheetEntries(result.sheets[sheetId])).get("A1")?.v)
    .toBe("authoritative-cache");
});
