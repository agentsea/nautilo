// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../src/view/canvas/test-canvas-env';
import { MemSlidesStore } from '../../../src/store/memory';
import { initialize, type SlidesEditor } from '../../../src/view/editor/editor';
import type { TableElement } from '../../../src/model/element';
import type { TableLayout } from '../../../src/view/canvas/table-renderer';

type Internals = {
  startTableEdgeResize(event: PointerEvent, table: TableElement, edge: {
    kind: 'col' | 'row'; index: number; position: number;
  }): void;
  startCellRangeDrag(table: TableElement, layout: TableLayout): void;
  cellSelection: { tableId: string; r0: number; c0: number; r1: number; c1: number } | null;
};

function fixture(widths = [0.05, 0.15], heights = [0.05, 0.15]) {
  const canvas = document.createElement('canvas');
  const overlay = document.createElement('div');
  document.body.append(canvas, overlay);
  const store = new MemSlidesStore();
  let tableId = '';
  store.batch(() => {
    const slideId = store.addSlide('blank');
    tableId = store.addElement(slideId, {
      type: 'table',
      frame: { x: 0, y: 0, w: widths.reduce((a, b) => a + b), h: heights.reduce((a, b) => a + b), rotation: 0 },
      data: {
        columnWidths: widths,
        rows: heights.map((height) => ({
          height,
          cells: widths.map(() => ({ body: { blocks: [] }, style: {} })),
        })),
      },
    });
  });
  const editor = initialize({ canvas, overlay, store, hostWidth: 960, hostHeight: 540, dpr: 1 });
  const table = store.read().slides[0].elements.find((el) => el.id === tableId) as TableElement;
  return { editor, internals: editor as unknown as Internals, store, table };
}

describe('tiny imported table interactions', () => {
  let editor: SlidesEditor | undefined;
  afterEach(() => {
    editor?.detach();
    document.body.innerHTML = '';
  });

  it('does not write or create undo work for a no-move resize', () => {
    const f = fixture();
    editor = f.editor;
    const update = vi.spyOn(f.store, 'updateTableColumnWidths');
    f.internals.startTableEdgeResize(
      new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }),
      f.table,
      { kind: 'col', index: 1, position: 0.05 },
    );
    document.dispatchEvent(new PointerEvent('pointerup'));
    expect(update).not.toHaveBeenCalled();
    expect(f.table.data.columnWidths).toEqual([0.05, 0.15]);
  });

  it('keeps both cells positive and preserves their total when dragged beyond bounds', () => {
    const f = fixture();
    editor = f.editor;
    const before = [...f.table.data.columnWidths];
    f.internals.startTableEdgeResize(
      new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }),
      f.table,
      { kind: 'col', index: 1, position: 0.05 },
    );
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 1e9, clientY: 0 }));
    document.dispatchEvent(new PointerEvent('pointerup'));
    const after = f.store.read().slides[0].elements.find((el) => el.id === f.table.id) as TableElement;
    expect(after.data.columnWidths.every((value) => value > 0)).toBe(true);
    expect(after.data.columnWidths[0] + after.data.columnWidths[1]).toBe(before[0] + before[1]);
    f.store.undo();
    const undone = f.store.read().slides[0].elements.find((el) => el.id === f.table.id) as TableElement;
    expect(undone.data.columnWidths).toEqual(before);
  });

  it('cancels a resize without writing', () => {
    const f = fixture();
    editor = f.editor;
    const update = vi.spyOn(f.store, 'updateTableRowHeights');
    f.internals.startTableEdgeResize(
      new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }),
      f.table,
      { kind: 'row', index: 1, position: 0.05 },
    );
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 0, clientY: 1e9 }));
    document.dispatchEvent(new PointerEvent('pointercancel'));
    expect(update).not.toHaveBeenCalled();
  });

  it('selects the terminal cell when a subpixel range drag leaves the table', () => {
    const f = fixture();
    editor = f.editor;
    f.internals.cellSelection = { tableId: f.table.id, r0: 0, c0: 0, r1: 0, c1: 0 };
    f.internals.startCellRangeDrag(f.table, {
      colX: [0, 0.05, 0.2],
      rowY: [0, 0.05, 0.2],
      rowH: [0.05, 0.15],
    });
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 1e9, clientY: 1e9 }));
    expect(f.editor.getCellSelection()).toMatchObject({ r1: 1, c1: 1 });
    document.dispatchEvent(new PointerEvent('pointercancel'));
  });
});
