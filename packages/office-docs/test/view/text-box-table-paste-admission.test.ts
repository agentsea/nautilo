// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { serializeClipboard, WAFFLEDOCS_MIME } from '../../src/view/clipboard.js';
import { initializeTextBox } from '../../src/view/text-box-editor.js';
import { DEFAULT_BLOCK_STYLE, type Block } from '../../src/model/types.js';

function paragraph(id: string, text: string): Block {
  return {
    id,
    type: 'paragraph',
    inlines: [{ text, style: {} }],
    style: { ...DEFAULT_BLOCK_STYLE },
  };
}

function table(): Block {
  return {
    id: 'table',
    type: 'table',
    inlines: [],
    style: { ...DEFAULT_BLOCK_STYLE },
    tableData: {
      columnWidths: [1],
      rows: [{ cells: [{ blocks: [paragraph('cell', 'nested')], style: { padding: 4 } }] }],
    },
  };
}

describe('slide text-box table paste admission', () => {
  it('rejects an actual internal paste before selection deletion or commit', () => {
    const context = new Proxy({ measureText: (text: string) => ({ width: text.length * 8 }) }, {
      get: (target, property) => property in target
        ? target[property as keyof typeof target]
        : () => undefined,
      set: () => true,
    }) as unknown as CanvasRenderingContext2D;
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((() => context) as unknown as HTMLCanvasElement['getContext']);
    const container = document.createElement('div');
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    document.body.appendChild(container);
    let committed: Block[] | undefined;
    const onCommit = vi.fn((blocks: Block[]) => { committed = blocks; });
    const api = initializeTextBox({
      container,
      canvas,
      blocks: [paragraph('destination', 'keep me')],
      contentWidth: 400,
      contentHeight: 200,
      onCommit,
    });
    const textarea = container.querySelector('textarea')!;
    const payload = serializeClipboard({ blocks: [table()] });
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [],
        getData: (type: string) => type === WAFFLEDOCS_MIME ? payload : '',
      },
    });

    api.focus();
    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'a', metaKey: true, ctrlKey: true, bubbles: true,
    }));
    let reported: Error | undefined;
    const onError = (error: ErrorEvent) => {
      reported = error.error as Error;
      error.preventDefault();
    };
    window.addEventListener('error', onError);
    textarea.dispatchEvent(event);
    window.removeEventListener('error', onError);
    expect(reported?.message).toBe(
      "Tables can't be pasted into a slide text box. Use Insert > Table, or paste as plain text.",
    );

    // Applying a style after the refusal proves the pre-paste selection still
    // exists; if paste had cleared it, this would only set a pending caret style.
    api.applyStyle({ bold: true });
    api.blur();
    expect(onCommit).toHaveBeenCalledOnce();
    expect(committed?.[0].inlines).toEqual([
      { text: 'keep me', style: { bold: true } },
    ]);
    api.detach();
    getContext.mockRestore();
  });

  it('reports the exact refusal through the host callback without mutating', () => {
    const context = new Proxy({ measureText: (text: string) => ({ width: text.length * 8 }) }, {
      get: (target, property) => property in target
        ? target[property as keyof typeof target]
        : () => undefined,
      set: () => true,
    }) as unknown as CanvasRenderingContext2D;
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((() => context) as unknown as HTMLCanvasElement['getContext']);
    const container = document.createElement('div');
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    document.body.appendChild(container);
    const onCommit = vi.fn();
    const onPasteRejected = vi.fn();
    const api = initializeTextBox({
      container,
      canvas,
      blocks: [paragraph('destination', 'keep me')],
      contentWidth: 400,
      contentHeight: 200,
      onCommit,
      onPasteRejected,
    });
    const textarea = container.querySelector('textarea')!;
    const payload = serializeClipboard({ blocks: [table()] });
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: { items: [], getData: (type: string) => type === WAFFLEDOCS_MIME ? payload : '' },
    });

    api.focus();
    textarea.dispatchEvent(event);
    expect(onPasteRejected).toHaveBeenCalledOnce();
    expect(onPasteRejected).toHaveBeenCalledWith(
      "Tables can't be pasted into a slide text box. Use Insert > Table, or paste as plain text.",
    );
    api.blur();
    expect(onCommit.mock.calls[0][0]).toEqual([paragraph('destination', 'keep me')]);
    api.detach();
    getContext.mockRestore();
  });
});
