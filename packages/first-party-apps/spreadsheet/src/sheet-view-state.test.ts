import { describe, expect, test } from "bun:test";
import type { Range, Ref, SelectionType } from "../engine/browser.js";
import { captureSheetView, restoreSheetView, type SheetViewEditor } from "./sheet-view-state";

const host = {
  getBoundingClientRect: () => ({ left: 100, top: 200, width: 900, height: 700 }),
} as unknown as HTMLElement;

function editor(overrides: Partial<SheetViewEditor> = {}): SheetViewEditor {
  return {
    getZoom: () => 2,
    setZoom: () => {},
    getActiveCell: () => ({ r: 8, c: 3 }),
    getSelectionType: () => "cell",
    getSelectionRanges: () => [],
    getSelectedIndices: () => null,
    getScrollableGridViewportRect: () => ({ left: 20, top: 30, width: 600, height: 400 }),
    cellRefFromPoint: () => ({ r: 20, c: 10 }),
    getCellRect: () => ({ left: 15, top: 17, width: 100, height: 23 }),
    selectStart: () => {},
    selectEnd: () => {},
    addSelection: () => {},
    addSelectionEnd: () => {},
    selectRow: () => {},
    selectColumn: () => {},
    panBy: () => {},
    ...overrides,
  };
}

test("captures isolated multi-range state and restores zoom, active corner, and scroll", () => {
  const ranges: Range[] = [
    [{ r: 1, c: 1 }, { r: 2, c: 2 }],
    [{ r: 5, c: 3 }, { r: 8, c: 7 }],
  ];
  let sampledPoint: [number, number] | undefined;
  const state = captureSheetView(editor({
    getSelectionRanges: () => ranges,
    cellRefFromPoint: (x, y) => { sampledPoint = [x, y]; return { r: 20, c: 10 }; },
  }), host);
  expect(state).toBeDefined();
  if (!state) throw new Error("Expected restorable view state.");
  expect(sampledPoint).toEqual([420, 430]);

  ranges[0][0].r = 99;
  expect(state.ranges[0][0]).toEqual({ r: 1, c: 1 });

  const calls: Array<[string, unknown]> = [];
  restoreSheetView(editor({
    setZoom: (zoom) => calls.push(["zoom", zoom]),
    selectStart: (ref) => calls.push(["start", ref]),
    selectEnd: (ref) => calls.push(["end", ref]),
    addSelection: (ref) => calls.push(["add", ref]),
    addSelectionEnd: (ref) => calls.push(["add-end", ref]),
    getCellRect: () => ({ left: 555, top: 457, width: 200, height: 46 }),
    panBy: (x, y) => calls.push(["pan", [x, y]]),
  }), host, state);

  expect(calls).toEqual([
    ["zoom", 2],
    ["start", { r: 1, c: 1 }],
    ["end", { r: 2, c: 2 }],
    ["add", { r: 8, c: 3 }],
    ["add-end", { r: 5, c: 7 }],
    ["pan", [270, 220]],
  ]);
});

describe("axis selection restore", () => {
  const cases: Array<{
    type: SelectionType;
    active: Ref;
    indices: { axis: "row" | "column"; from: number; to: number };
    range: Range;
    expected: Array<[string, Ref | number]>;
  }> = [
    {
      type: "row", active: { r: 8, c: 1 }, indices: { axis: "row", from: 3, to: 8 },
      range: [{ r: 3, c: 1 }, { r: 8, c: 1000 }],
      expected: [["row", 8], ["end", { r: 3, c: 1000 }]],
    },
    {
      type: "column", active: { r: 1, c: 9 }, indices: { axis: "column", from: 4, to: 9 },
      range: [{ r: 1, c: 4 }, { r: 1000, c: 9 }],
      expected: [["column", 9], ["end", { r: 1000, c: 4 }]],
    },
  ];

  for (const item of cases) {
    test(`restores ${item.type} ranges without degrading them to cell selection`, () => {
      const state = captureSheetView(editor({
        getActiveCell: () => item.active,
        getSelectionType: () => item.type,
        getSelectionRanges: () => [item.range],
        getSelectedIndices: () => item.indices,
      }), host)!;
      const calls: Array<[string, Ref | number]> = [];
      restoreSheetView(editor({
        selectRow: (row) => calls.push(["row", row]),
        selectColumn: (column) => calls.push(["column", column]),
        selectEnd: (ref) => calls.push(["end", ref]),
      }), host, state);
      expect(calls).toEqual(item.expected);
    });
  }
});

test("refuses select-all, non-corner active ranges, and an unusable viewport", () => {
  expect(captureSheetView(editor({ getSelectionType: () => "all" }), host)).toBeUndefined();
  expect(captureSheetView(editor({
    getActiveCell: () => ({ r: 2, c: 2 }),
    getSelectionRanges: () => [[{ r: 1, c: 1 }, { r: 3, c: 3 }]],
  }), host)).toBeUndefined();
  expect(captureSheetView(editor({
    getScrollableGridViewportRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  }), host)).toBeUndefined();
});
