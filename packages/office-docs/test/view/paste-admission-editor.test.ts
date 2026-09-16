// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initialize, type EditorAPI } from '../../src/view/editor.js';
import { WAFFLEDOCS_MIME } from '../../src/view/clipboard.js';
import { DEFAULT_BLOCK_STYLE, type Block, type Document } from '../../src/model/types.js';
import { MemDocStore } from '../../src/store/memory.js';

let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
let editors: EditorAPI[];

function installCanvasShim(): void {
  originalGetContext = HTMLCanvasElement.prototype.getContext;
  originalResizeObserver = globalThis.ResizeObserver;
  const context = new Proxy({}, {
    get: (_target, property) => property === 'measureText'
      ? (text: string) => ({
          width: text.length * 6,
          actualBoundingBoxAscent: 8,
          actualBoundingBoxDescent: 2,
        })
      : () => {},
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = ((kind: string) =>
    kind === '2d' ? context : null) as typeof HTMLCanvasElement.prototype.getContext;
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

function paragraph(id: string, text: string): Block {
  return {
    id,
    type: 'paragraph',
    inlines: [{ text, style: {} }],
    style: { ...DEFAULT_BLOCK_STYLE },
  };
}

function nestedTable(depth: number): Block {
  let block = paragraph('nested-content', 'preserved');
  for (let index = 1; index <= depth; index++) {
    block = {
      id: `table-${index}`,
      type: 'table',
      inlines: [],
      style: { ...DEFAULT_BLOCK_STYLE },
      tableData: {
        rows: [{ cells: [{ blocks: [block], style: { padding: 4 } }] }],
        columnWidths: [1],
      },
    };
  }
  return block;
}

function setup(): { editor: EditorAPI; textarea: HTMLTextAreaElement } {
  const store = new MemDocStore({ blocks: [paragraph('destination', 'hello')] });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = initialize(container, store);
  editors.push(editor);
  return { editor, textarea: container.querySelector('textarea')! };
}

function dispatchInternalPaste(
  textarea: HTMLTextAreaElement,
  content: { blocks: Block[]; tableCells?: unknown[][] },
): void {
  const payload = JSON.stringify({ version: 1, ...content });
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      types: [WAFFLEDOCS_MIME],
      getData: (type: string) => type === WAFFLEDOCS_MIME ? payload : '',
      items: [],
    },
  });
  textarea.dispatchEvent(event);
}

function countTables(blocks: Block[]): number {
  let count = 0;
  const work = [...blocks];
  while (work.length > 0) {
    const block = work.pop()!;
    if (block.type !== 'table' || !block.tableData) continue;
    count += 1;
    for (const row of block.tableData.rows) {
      for (const cell of row.cells) work.push(...cell.blocks);
    }
  }
  return count;
}

describe('editor rich-paste admission', () => {
  beforeEach(() => {
    editors = [];
    installCanvasShim();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    for (const editor of editors) editor.dispose();
    document.body.innerHTML = '';
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    if (originalResizeObserver === undefined) {
      delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    }
    else globalThis.ResizeObserver = originalResizeObserver;
  });

  it('reports invalid nested list content before changing the document or selection', () => {
    const { editor, textarea } = setup();
    const selection = {
      anchor: { blockId: 'destination', offset: 1 },
      focus: { blockId: 'destination', offset: 4 },
    };
    editor._setSelectionForTest(selection);
    const before = structuredClone(editor.getDoc().document);
    let reported: Error | undefined;
    const onError = (event: ErrorEvent): void => {
      reported = event.error as Error;
      event.preventDefault();
    };
    window.addEventListener('error', onError);
    try {
      const table = nestedTable(30);
      let leaf = table;
      while (leaf.tableData) leaf = leaf.tableData.rows[0].cells[0].blocks[0];
      leaf.type = 'list-item';
      leaf.listKind = 'unordered';
      leaf.listLevel = Number.MAX_SAFE_INTEGER + 1;
      dispatchInternalPaste(textarea, { blocks: [table] });
    } finally {
      window.removeEventListener('error', onError);
    }

    expect(reported).toBeInstanceOf(RangeError);
    expect(reported?.message).toContain('List levels must be nonnegative safe integers');
    expect(editor.getDoc().document).toEqual(before);
    expect(editor.getActiveSelection()).toEqual(selection);
  });

  it('preserves deep nested tables through editor paste, undo, redo and reopen', () => {
    const { editor, textarea } = setup();
    editor._setSelectionForTest({
      anchor: { blockId: 'destination', offset: 5 },
      focus: { blockId: 'destination', offset: 5 },
    });

    dispatchInternalPaste(textarea, { blocks: [nestedTable(100)] });
    const pasted = JSON.stringify(editor.getDoc().document);
    expect(countTables(editor.getDoc().document.blocks)).toBe(100);
    editor.undo();
    expect(countTables(editor.getDoc().document.blocks)).toBe(0);
    editor.redo();
    expect(JSON.stringify(editor.getDoc().document)).toBe(pasted);
    const reopened = new MemDocStore(JSON.parse(pasted) as Document);
    expect(JSON.stringify(reopened.getDocument())).toBe(pasted);
  });

  it('preserves the additional containing table when pasting cells outside a table', () => {
    const { editor, textarea } = setup();
    let reported: Error | undefined;
    const onError = (event: ErrorEvent): void => {
      reported = event.error as Error;
      event.preventDefault();
    };
    window.addEventListener('error', onError);
    try {
      dispatchInternalPaste(textarea, {
        blocks: [],
        tableCells: [[{
          blocks: [nestedTable(20)],
          style: { padding: 4 },
        }]],
      });
    } finally {
      window.removeEventListener('error', onError);
    }

    expect(reported).toBeUndefined();
    expect(countTables(editor.getDoc().document.blocks)).toBe(21);
  });
});
