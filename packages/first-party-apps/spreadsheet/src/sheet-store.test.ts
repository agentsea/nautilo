import { describe, expect, test } from "bun:test";
import {
  MemStore,
  getWorksheetCell,
  writeWorksheetCell,
  type Worksheet,
} from "../engine/node.js";
import { addSheet, createSheetDocument } from "./sheet-document";
import { createSheetStore } from "./sheet-store";

describe("sheet store adapter", () => {
  test("avoids the upstream MemStore.load indexed-metadata loss", async () => {
    const document = createSheetDocument();
    const worksheet = document.sheets["tab-1"];
    writeWorksheetCell(worksheet, { r: 2, c: 2 }, { v: "kept" });
    worksheet.rowHeights["2"] = 31;
    worksheet.rowStyles["2"] = { bg: "#ffeeaa" };

    const direct = new MemStore();
    direct.load(structuredClone(worksheet));
    expect(await direct.getDimensionSizes("row")).toEqual(new Map());
    expect(await direct.getRowStyles()).toEqual(new Map());

    const adapter = await createSheetStore(document, "tab-1", () => undefined);
    const untouched = await adapter.snapshot();
    expect(untouched).toEqual(document);
    expect(untouched.sheets["tab-1"].rowOrder).toEqual(worksheet.rowOrder);
    expect(untouched.sheets["tab-1"].colOrder).toEqual(worksheet.colOrder);
    await adapter.store.set({ r: 1, c: 1 }, { v: "7" });
    const changed = await adapter.snapshot();
    expect(changed.sheets["tab-1"].rowHeights).toEqual({ "2": 31 });
    expect(changed.sheets["tab-1"].rowStyles).toEqual({ "2": { bg: "#ffeeaa" } });
    expect(getWorksheetCell(changed.sheets["tab-1"], { r: 2, c: 2 })?.v).toBe("kept");
  });

  test("hydrates and snapshots supported worksheet state without sharing persisted objects", async () => {
    const document = createSheetDocument();
    const worksheet = document.sheets["tab-1"];
    writeWorksheetCell(worksheet, { r: 3, c: 4 }, { v: "42", s: { b: true } });
    worksheet.colWidths["4"] = 144;
    worksheet.colStyles["4"] = { al: "right" };
    worksheet.sheetStyle = { va: "middle" };
    worksheet.merges = { D3: { rs: 2, cs: 2 } };
    worksheet.frozenRows = 1;
    worksheet.frozenCols = 2;
    (worksheet as Worksheet & Record<string, unknown>)["futureMetadata"] = { preserve: true };

    let changes = 0;
    const adapter = await createSheetStore(document, "tab-1", () => { changes += 1; });
    await adapter.store.setDimensionSize("column", 4, 155);
    await adapter.store.set({ r: 3, c: 4 }, { v: "99", s: { b: true } });
    await adapter.store.setFreezePane(2, 2);
    const snapshot = await adapter.snapshot();

    expect(changes).toBe(3);
    expect(snapshot.sheets["tab-1"].colWidths).toEqual({ "4": 155 });
    expect(getWorksheetCell(snapshot.sheets["tab-1"], { r: 3, c: 4 })?.v).toBe("99");
    expect(snapshot.sheets["tab-1"].frozenRows).toBe(2);
    expect((snapshot.sheets["tab-1"] as Worksheet & Record<string, unknown>)["futureMetadata"])
      .toEqual({ preserve: true });

    snapshot.sheets["tab-1"].colWidths["4"] = 1;
    expect((await adapter.snapshot()).sheets["tab-1"].colWidths["4"]).toBe(155);
  });

  test("keeps structural edits coherent across cells and dependent sheet formulas", async () => {
    const added = addSheet(createSheetDocument(), "Summary");
    const source = added.document.sheets["tab-1"];
    const summary = added.document.sheets[added.tabId];
    writeWorksheetCell(source, { r: 2, c: 1 }, { v: "10" });
    writeWorksheetCell(summary, { r: 1, c: 1 }, {
      f: '=Sheet1!A2+SUM(Sheet1!A2:A3)+"Sheet1!A2"',
      v: "stale",
    });

    const adapter = await createSheetStore(added.document, "tab-1", () => undefined);
    await adapter.store.shiftCells("row", 2, 1);
    const snapshot = await adapter.snapshot();
    expect(getWorksheetCell(snapshot.sheets["tab-1"], { r: 3, c: 1 })?.v).toBe("10");
    expect(getWorksheetCell(snapshot.sheets[added.tabId], { r: 1, c: 1 })?.f)
      .toBe('=Sheet1!A3+SUM(Sheet1!A3:A4)+"Sheet1!A2"');
    expect(getWorksheetCell(snapshot.sheets[added.tabId], { r: 1, c: 1 })?.v).toBeUndefined();
  });

  test("signals successful mutations once per async batch and rejects unsafe mutation", async () => {
    const document = createSheetDocument();
    let changes = 0;
    const adapter = await createSheetStore(document, "tab-1", () => { changes += 1; });

    expect(await adapter.store.delete({ r: 8, c: 8 })).toBe(false);
    expect(changes).toBe(0);
    adapter.store.beginBatch();
    const first = adapter.store.set({ r: 1, c: 1 }, { v: "1" });
    const second = adapter.store.set({ r: 2, c: 1 }, { v: "2" });
    expect(adapter.snapshot()).rejects.toThrow("batch is open");
    adapter.store.endBatch();
    await Promise.all([first, second]);
    await adapter.snapshot();
    expect(changes).toBe(1);

    expect(adapter.store.addThread(
      { kind: "sheet-cell", tabId: "tab-1", rowId: "r1", colId: "c1" },
      "comment",
      { userId: "u1", username: "User" },
    )).rejects.toThrow("cannot preserve persisted thread IDs");
    expect(changes).toBe(1);
  });

  test("records one undo step for a grouped paste and invalidates redo after a new edit", async () => {
    const adapter = await createSheetStore(createSheetDocument(), "tab-1", () => undefined);
    expect(await adapter.store.delete({ r: 9, c: 9 })).toBe(false);
    expect(adapter.store.canUndo()).toBe(false);

    adapter.store.beginBatch();
    const first = adapter.store.set({ r: 1, c: 1 }, { v: "left" });
    const second = adapter.store.set({ r: 1, c: 2 }, { v: "right" });
    adapter.store.endBatch();
    await Promise.all([first, second]);
    await adapter.snapshot();

    expect(adapter.store.canUndo()).toBe(true);
    expect(await adapter.store.undo()).toEqual({
      success: true,
      affectedRange: [{ r: 1, c: 1 }, { r: 1, c: 2 }],
    });
    let snapshot = await adapter.snapshot();
    expect(getWorksheetCell(snapshot.sheets["tab-1"], { r: 1, c: 1 })).toBeUndefined();
    expect(getWorksheetCell(snapshot.sheets["tab-1"], { r: 1, c: 2 })).toBeUndefined();
    expect((await adapter.store.undo()).success).toBe(false);

    expect(await adapter.store.redo()).toEqual({
      success: true,
      affectedRange: [{ r: 1, c: 1 }, { r: 1, c: 2 }],
    });
    snapshot = await adapter.snapshot();
    expect(getWorksheetCell(snapshot.sheets["tab-1"], { r: 1, c: 1 })?.v).toBe("left");
    await adapter.store.set({ r: 2, c: 1 }, { v: "new branch" });
    expect(adapter.store.canRedo()).toBe(false);
  });

  test("keeps a preceding in-flight edit outside a later explicit batch", async () => {
    const adapter = await createSheetStore(createSheetDocument(), "tab-1", () => undefined);
    const preceding = adapter.store.set({ r: 3, c: 1 }, { v: "before batch" });
    adapter.store.beginBatch();
    const batched = adapter.store.set({ r: 4, c: 1 }, { v: "inside batch" });
    adapter.store.endBatch();
    await Promise.all([preceding, batched]);

    expect((await adapter.store.undo()).success).toBe(true);
    let snapshot = await adapter.snapshot();
    expect(getWorksheetCell(snapshot.sheets["tab-1"], { r: 3, c: 1 })?.v).toBe("before batch");
    expect(getWorksheetCell(snapshot.sheets["tab-1"], { r: 4, c: 1 })).toBeUndefined();
    expect((await adapter.store.undo()).success).toBe(true);
    snapshot = await adapter.snapshot();
    expect(getWorksheetCell(snapshot.sheets["tab-1"], { r: 3, c: 1 })).toBeUndefined();
  });

  test("undoes dimensions, styles, structure, and cross-tab references as one batch", async () => {
    const added = addSheet(createSheetDocument(), "Summary");
    const source = added.document.sheets["tab-1"];
    const summary = added.document.sheets[added.tabId];
    writeWorksheetCell(source, { r: 2, c: 1 }, { v: "source" });
    writeWorksheetCell(summary, { r: 1, c: 1 }, { f: "=Sheet1!A2" });
    summary.charts!["chart-1"] = {
      id: "chart-1",
      type: "line",
      sourceTabId: "tab-1",
      sourceRange: "A2:A3",
      anchor: "C1",
      offsetX: 0,
      offsetY: 0,
      width: 320,
      height: 180,
    };
    const rowId = source.rowOrder[1];
    const colId = source.colOrder[0];
    source.comments!["thread-7"] = {
      id: "thread-7",
      anchor: { kind: "sheet-cell", tabId: "tab-1", rowId, colId },
      comments: [{
        id: "comment-9",
        author: { userId: "u1", username: "User" },
        body: "preserve",
        createdAt: 1,
      }],
      resolved: false,
      createdAt: 1,
    };
    (added.document as unknown as Record<string, unknown>)["futureRoot"] = { untouched: true };

    const adapter = await createSheetStore(added.document, "tab-1", () => undefined);
    expect((await adapter.store.listThreads()).map((thread) => thread.id)).toEqual(["thread-7"]);
    adapter.store.beginBatch();
    const dimension = adapter.store.setDimensionSize("row", 2, 44);
    const style = adapter.store.setRowStyle(2, { bg: "#ffaa00" });
    const structure = adapter.store.shiftCells("row", 2, 1);
    adapter.store.endBatch();
    await Promise.all([dimension, style, structure]);
    let snapshot = await adapter.snapshot();
    expect(snapshot.sheets["tab-1"].rowHeights["3"]).toBe(44);
    expect(snapshot.sheets["tab-1"].rowStyles["3"]).toEqual({ bg: "#ffaa00" });
    expect(snapshot.sheets[added.tabId].charts!["chart-1"].sourceRange).toBe("A3:A4");

    expect((await adapter.store.undo()).success).toBe(true);
    snapshot = await adapter.snapshot();
    expect(snapshot.sheets["tab-1"].rowHeights).toEqual({});
    expect(snapshot.sheets["tab-1"].rowStyles).toEqual({});
    expect(getWorksheetCell(snapshot.sheets["tab-1"], { r: 2, c: 1 })?.v).toBe("source");
    expect(getWorksheetCell(snapshot.sheets[added.tabId], { r: 1, c: 1 })?.f).toBe("=Sheet1!A2");
    expect(snapshot.sheets[added.tabId].charts!["chart-1"].sourceRange).toBe("A2:A3");
    expect((snapshot as unknown as Record<string, unknown>)["futureRoot"]).toEqual({ untouched: true });
    expect((await adapter.store.listThreads()).map((thread) => thread.id)).toEqual(["thread-7"]);

    expect((await adapter.store.redo()).success).toBe(true);
    snapshot = await adapter.snapshot();
    expect(snapshot.sheets["tab-1"].rowHeights["3"]).toBe(44);
    expect(getWorksheetCell(snapshot.sheets[added.tabId], { r: 1, c: 1 })?.f).toBe("=Sheet1!A3");
  });

  test("rejects malformed indexed metadata before creating a live store", async () => {
    const document = createSheetDocument();
    document.sheets["tab-1"].rowHeights["01"] = 20;
    expect(createSheetStore(document, "tab-1", () => undefined))
      .rejects.toThrow("positive 1-based integer keys");

    const unsupported = createSheetDocument();
    unsupported.sheets["tab-1"].rangeStyles = [{
      range: [{ r: 1, c: 1 }, { r: 1, c: 1 }],
      style: {},
    }];
    expect(createSheetStore(unsupported, "tab-1", () => undefined))
      .rejects.toThrow("cannot preserve exactly");
  });
});

test("shared workbook history survives switching sheets without erasing a newer tab edit", async () => {
  const { createSheetHistory } = await import("./sheet-store");
  const added = addSheet(createSheetDocument(), "Other");
  const history = createSheetHistory();
  const first = await createSheetStore(added.document, "tab-1", () => {}, history);
  await first.store.set({r:1,c:1}, {v:"first"});
  const second = await createSheetStore(await first.snapshot(), added.tabId, () => {}, history);
  first.dispose();
  await second.store.set({r:1,c:1}, {v:"second"});
  const current = await second.snapshot();
  const undone = history.undo(current, "tab-1");
  expect(getWorksheetCell(undone.document.sheets["tab-1"], {r:1,c:1})?.v).toBe("first");
  expect(getWorksheetCell(undone.document.sheets[added.tabId], {r:1,c:1})).toBeUndefined();
  expect(undone.result.affectedRange).toBeUndefined();
});

test("large paste is one history step and preserves unknown cell metadata on replacement", async () => {
  const source = createSheetDocument();
  writeWorksheetCell(source.sheets["tab-1"], {r:1,c:1}, {v:"before", future:"preserve"} as never);
  const adapter = await createSheetStore(source, "tab-1", () => {});
  adapter.store.beginBatch();
  for (let row=1; row<=1000; row++) await adapter.store.set({r:row,c:1}, {v:String(row)});
  adapter.store.endBatch();
  const next = await adapter.snapshot();
  expect(getWorksheetCell(next.sheets["tab-1"], {r:1000,c:1})?.v).toBe("1000");
  expect(getWorksheetCell(next.sheets["tab-1"], {r:1,c:1})).toMatchObject({future:"preserve"});
  await adapter.store.undo();
  expect(await adapter.snapshot()).toEqual(source);
  expect(adapter.store.canUndo()).toBe(false);
});

test("failed batch rolls back the entire paste and permits subsequent edits", async () => {
  const doc = createSheetDocument();
  const cell = { v: "protected", futureCellMetadata: { keep: true } };
  writeWorksheetCell(doc.sheets['tab-1'], { r: 2, c: 1 }, cell);
  let changes = 0;
  const adapter = await createSheetStore(doc, 'tab-1', () => { changes++; });
  adapter.store.beginBatch();
  await adapter.store.set({ r: 1, c: 1 }, { v: 'temporary' });
  expect(adapter.store.delete({ r: 2, c: 1 })).rejects.toThrow('unsupported cell metadata');
  adapter.store.endBatch();
  expect(adapter.snapshot()).rejects.toThrow('unsupported cell metadata');
  expect(await adapter.snapshot()).toEqual(doc);
  expect(adapter.store.canUndo()).toBe(false);
  expect(changes).toBe(0);
  await adapter.store.set({ r: 1, c: 1 }, { v: 'recovered' });
  expect(getWorksheetCell((await adapter.snapshot()).sheets['tab-1'], { r: 1, c: 1 })?.v).toBe('recovered');
  expect(changes).toBe(1);
});

test("structural edits and setGrid retain unknown cell fields on later saves", async () => {
  const doc = createSheetDocument();
  const futureCell = { v: 'keep', future: { id: 7 } };
  writeWorksheetCell(doc.sheets['tab-1'], { r: 2, c: 1 }, futureCell);
  const adapter = await createSheetStore(doc, 'tab-1', () => undefined);
  await adapter.store.shiftCells('row', 1, 1);
  await adapter.store.setGrid(new Map([['A3', { v: 'changed' }]]));
  expect(getWorksheetCell((await adapter.snapshot()).sheets['tab-1'], { r: 3, c: 1 })).toEqual({ ...futureCell, v: 'changed' });
  expect(adapter.store.shiftCells('row', 3, -1)).rejects.toThrow('unsupported cell metadata');
  expect(getWorksheetCell((await adapter.snapshot()).sheets['tab-1'], { r: 3, c: 1 })?.v).toBe('changed');
});

test("unrecognized worksheet metadata refuses structural moves before mutation", async () => {
  const doc = createSheetDocument();
  Object.assign(doc.sheets['tab-1'], { futureCoordinates: { row: 2 } });
  const adapter = await createSheetStore(doc, 'tab-1', () => undefined);
  expect(adapter.store.shiftCells('row', 1, 1)).rejects.toThrow('unsupported worksheet metadata');
  expect(await adapter.snapshot()).toEqual(doc);
});

test("a later edit survives a calculation from an older snapshot", async () => {
  const adapter = await createSheetStore(createSheetDocument(), "tab-1", () => undefined);
  const base = await adapter.snapshot();
  const calculated = structuredClone(base);
  writeWorksheetCell(calculated.sheets["tab-1"], { r: 1, c: 1 }, { v: "old calculation" });
  await adapter.store.set({ r: 1, c: 1 }, { v: "newer user edit" });
  expect(await adapter.adoptCalculated(base, calculated)).toBe(false);
  expect(getWorksheetCell((await adapter.snapshot()).sheets["tab-1"], { r: 1, c: 1 })?.v).toBe("newer user edit");
});

test("a sparse row beyond upstream selection extension size survives edit and save", async () => {
  const doc = createSheetDocument();
  writeWorksheetCell(doc.sheets["tab-1"], { r: 10001, c: 2 }, { v: "distant" });
  const adapter = await createSheetStore(doc, "tab-1", () => undefined);
  await adapter.store.set({ r: 1, c: 1 }, { v: "nearby" });
  expect(getWorksheetCell((await adapter.snapshot()).sheets["tab-1"], { r: 10001, c: 2 })?.v).toBe("distant");
});
