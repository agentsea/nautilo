import type { Range, Ref, SelectionType, Spreadsheet } from "../engine/browser.js";

type SelectedIndices = { axis: "row" | "column"; from: number; to: number };

export type SheetViewEditor = Pick<Spreadsheet,
  | "addSelection"
  | "addSelectionEnd"
  | "cellRefFromPoint"
  | "getActiveCell"
  | "getCellRect"
  | "getScrollableGridViewportRect"
  | "getSelectedIndices"
  | "getSelectionRanges"
  | "getSelectionType"
  | "getZoom"
  | "panBy"
  | "selectColumn"
  | "selectEnd"
  | "selectRow"
  | "selectStart"
  | "setZoom"
>;

export type SheetViewState = {
  zoom: number;
  activeCell: Ref;
  selectionType: Exclude<SelectionType, "all">;
  ranges: Range[];
  selectedIndices: SelectedIndices | null;
  scrollAnchor: { ref: Ref; left: number; top: number };
};

function cloneRef(ref: Ref): Ref {
  return { r: ref.r, c: ref.c };
}

function cloneRange(range: Range): Range {
  return [cloneRef(range[0]), cloneRef(range[1])];
}

function isRangeCorner(ref: Ref, range: Range): boolean {
  return (ref.r === range[0].r || ref.r === range[1].r)
    && (ref.c === range[0].c || ref.c === range[1].c);
}

function oppositeCorner(anchor: Ref, range: Range): Ref {
  return {
    r: anchor.r === range[0].r ? range[1].r : range[0].r,
    c: anchor.c === range[0].c ? range[1].c : range[0].c,
  };
}

function finiteRect(rect: { left: number; top: number; width: number; height: number }): boolean {
  return Number.isFinite(rect.left) && Number.isFinite(rect.top)
    && Number.isFinite(rect.width) && Number.isFinite(rect.height)
    && rect.width > 0 && rect.height > 0;
}

/** Captures only view state that can be reconstructed through Spreadsheet's
 * public API. `undefined` asks the caller to defer a destructive remount. */
export function captureSheetView(editor: SheetViewEditor, gridHost: HTMLElement): SheetViewState | undefined {
  const selectionType = editor.getSelectionType();
  const activeCell = editor.getActiveCell();
  if (!activeCell || !selectionType || selectionType === "all") return undefined;

  const ranges = editor.getSelectionRanges().map(cloneRange);
  const lastRange = ranges.at(-1);
  if (selectionType === "cell" && lastRange && !isRangeCorner(activeCell, lastRange)) return undefined;

  const selectedIndices = editor.getSelectedIndices();
  if (selectionType === "row" || selectionType === "column") {
    if (!selectedIndices || selectedIndices.axis !== selectionType || ranges.length !== 1) return undefined;
    const coordinate = selectionType === "row" ? activeCell.r : activeCell.c;
    if (coordinate !== selectedIndices.from && coordinate !== selectedIndices.to) return undefined;
  }

  const viewport = editor.getScrollableGridViewportRect();
  const hostRect = gridHost.getBoundingClientRect();
  if (!finiteRect(viewport) || !finiteRect(hostRect)) return undefined;
  const anchor = editor.cellRefFromPoint(
    hostRect.left + viewport.left + viewport.width / 2,
    hostRect.top + viewport.top + viewport.height / 2,
  );
  const anchorRect = editor.getCellRect(anchor);
  const zoom = editor.getZoom();
  if (!finiteRect(anchorRect) || !Number.isFinite(zoom) || zoom <= 0) return undefined;

  return {
    zoom,
    activeCell: cloneRef(activeCell),
    selectionType,
    ranges,
    selectedIndices: selectedIndices ? { ...selectedIndices } : null,
    scrollAnchor: {
      ref: cloneRef(anchor),
      left: anchorRect.left - viewport.left,
      top: anchorRect.top - viewport.top,
    },
  };
}

function restoreCellSelection(editor: SheetViewEditor, state: SheetViewState): void {
  if (state.ranges.length === 0) {
    editor.selectStart(state.activeCell);
    return;
  }
  state.ranges.forEach((range, index) => {
    const isLast = index === state.ranges.length - 1;
    const anchor = isLast ? state.activeCell : range[0];
    const end = oppositeCorner(anchor, range);
    if (index === 0) {
      editor.selectStart(anchor);
      editor.selectEnd(end);
    } else {
      editor.addSelection(anchor);
      editor.addSelectionEnd(end);
    }
  });
}

function restoreAxisSelection(editor: SheetViewEditor, state: SheetViewState): void {
  const indices = state.selectedIndices!;
  const range = state.ranges[0];
  if (state.selectionType === "row") {
    editor.selectRow(state.activeCell.r);
    if (indices.from !== indices.to) {
      const otherRow = state.activeCell.r === indices.from ? indices.to : indices.from;
      editor.selectEnd({ r: otherRow, c: range[1].c });
    }
    return;
  }
  editor.selectColumn(state.activeCell.c);
  if (indices.from !== indices.to) {
    const otherColumn = state.activeCell.c === indices.from ? indices.to : indices.from;
    editor.selectEnd({ r: range[1].r, c: otherColumn });
  }
}

export function restoreSheetView(editor: SheetViewEditor, _gridHost: HTMLElement, state: SheetViewState): void {
  editor.setZoom(state.zoom);
  if (state.selectionType === "cell") restoreCellSelection(editor, state);
  else restoreAxisSelection(editor, state);

  const viewport = editor.getScrollableGridViewportRect();
  const anchorRect = editor.getCellRect(state.scrollAnchor.ref);
  const deltaX = (anchorRect.left - viewport.left - state.scrollAnchor.left) / state.zoom;
  const deltaY = (anchorRect.top - viewport.top - state.scrollAnchor.top) / state.zoom;
  if (deltaX !== 0 || deltaY !== 0) editor.panBy(deltaX, deltaY);
}
