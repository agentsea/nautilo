// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialize, type EditorAPI } from '../../src/view/editor.js';
import { MemDocStore } from '../../src/store/memory.js';
import { createEmptyBlock, createTableBlock, type Block } from '../../src/model/types.js';

function paragraph(text: string): Block {
  return { ...createEmptyBlock(), inlines: [{ text, style: {} }] };
}

describe('undo and redo cursor position without history presence', () => {
  let container: HTMLDivElement;
  let editor: EditorAPI;
  let store: MemDocStore;
  let blocks: Block[];

  beforeEach(() => {
    const measureText = (text: string) => ({
      width: text.length * 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2,
    });
    const context = new Proxy({}, {
      get: (_target, key) => key === 'measureText' ? measureText : () => {},
      set: () => true,
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => context) as unknown as typeof HTMLCanvasElement.prototype.getContext);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('OffscreenCanvas', class { getContext() { return { measureText }; } });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientHeight', { value: 600 });
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 600, width: 900, height: 600,
      toJSON: () => ({}),
    });
    vi.spyOn(document.body, 'getBoundingClientRect').mockImplementation(() => container.getBoundingClientRect());
    blocks = Array.from({ length: 60 }, (_, i) => paragraph(`Paragraph ${i} has editable text.`));
    store = new MemDocStore({ blocks });
    editor = initialize(container, store);
  });

  afterEach(() => {
    editor.dispose();
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function move(block: Block, offset: number) {
    editor.restoreLocalCursor({ blockId: block.id, offset, lineAffinity: 'forward' }, null);
  }

  function key(key: string, options: KeyboardEventInit = {}) {
    container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true, ...options,
    }));
  }

  it('toolbar undo/redo preserves a later-page caret and visible scroll position', () => {
    const block = blocks[45];
    move(block, 8);
    key('ArrowRight');
    const cursor = editor._getCursorForTest();
    const scrollTop = container.scrollTop;
    expect(scrollTop).toBeGreaterThan(0);
    store.snapshot();
    store.insertText(block.id, 0, 'Added ');
    editor.getDoc().refresh();
    editor.render();
    editor.undo();
    editor.focus();
    expect(editor._getCursorForTest()).toEqual(cursor);
    expect(container.scrollTop).toBe(scrollTop);
    expect(editor.getDoc().getBlock(block.id).inlines[0].text).toBe(block.inlines[0].text);
    editor.redo();
    expect(editor._getCursorForTest()).toEqual(cursor);
    expect(container.scrollTop).toBe(scrollTop);
    expect(editor.getDoc().getBlock(block.id).inlines[0].text).toMatch(/^Added /);
  });

  it('keyboard undo and redo use the same cursor-preserving path', () => {
    const block = blocks[30];
    move(block, 5);
    const cursor = editor._getCursorForTest();
    store.snapshot();
    store.insertText(block.id, 0, 'Added ');
    key('z', { ctrlKey: true });
    expect(editor._getCursorForTest()).toEqual(cursor);
    key('z', { ctrlKey: true, shiftKey: true });
    expect(editor._getCursorForTest()).toEqual(cursor);
  });

  it('clamps the offset when undo shortens the current paragraph', () => {
    const block = blocks[30];
    store.snapshot();
    store.insertText(block.id, block.inlines[0].text.length, 'Extra text');
    editor.getDoc().refresh();
    move(editor.getDoc().getBlock(block.id), block.inlines[0].text.length + 10);
    editor.undo();
    expect(editor._getCursorForTest()).toEqual({
      blockId: block.id, offset: block.inlines[0].text.length, lineAffinity: 'forward',
    });
  });

  it('undoing a paragraph split lands at the preceding surviving paragraph', () => {
    const block = blocks[30];
    move(block, 8);
    key('Enter');
    expect(editor._getCursorForTest().blockId).not.toBe(block.id);
    editor.undo();
    expect(editor._getCursorForTest()).toMatchObject({
      blockId: block.id, offset: 8,
    });
  });

  it('redoing a block deletion chooses a surviving neighbor', () => {
    const block = blocks[30];
    store.snapshot();
    store.deleteBlock(block.id);
    editor.undo();
    move(block, 5);
    editor.redo();
    expect(editor._getCursorForTest()).toMatchObject({
      blockId: blocks[29].id, offset: blocks[29].inlines[0].text.length,
    });
  });

  it('keeps the cursor inside an edited table cell', () => {
    const table = createTableBlock(1, 1);
    const cell = table.tableData!.rows[0].cells[0].blocks[0];
    cell.inlines = [{ text: 'Cell text', style: {} }];
    store.insertBlock(30, table);
    editor.getDoc().refresh();
    move(cell, 4);
    store.snapshot();
    store.insertText(cell.id, 0, 'Added ');
    editor.undo();
    expect(editor._getCursorForTest()).toMatchObject({ blockId: cell.id, offset: 4 });
  });

  it('retains a header caret and its editing context', () => {
    const header = paragraph('Header text');
    store.setHeader({ blocks: [header], marginFromEdge: 24 });
    editor.getDoc().refresh();
    move(header, 4);
    store.snapshot();
    store.insertText(header.id, 0, 'Added ');
    editor.undo();
    expect(editor._getCursorForTest()).toMatchObject({ blockId: header.id, offset: 4 });
    expect(editor.getEditContext()).toBe('header');
  });

  it('still prefers a valid cursor supplied by history presence', () => {
    store.snapshot();
    store.insertText(blocks[30].id, 0, 'Added ');
    move(blocks[30], 5);
    Object.assign(store, { getPresenceCursorPos: () => ({
      blockId: blocks[20].id, offset: 3, lineAffinity: 'forward',
    }) });
    editor.undo();
    expect(editor._getCursorForTest()).toEqual({
      blockId: blocks[20].id, offset: 3, lineAffinity: 'forward',
    });
  });

  it('refocuses the hidden input without browser scrolling', () => {
    const focus = vi.spyOn(container.querySelector('textarea')!, 'focus');
    editor.focus();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});
