// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Block } from '../../src/model/types.js';
import { initializeTextBox } from '../../src/view/text-box-editor.js';

/**
 * Regression: docs `text-box-editor.ts` (used by docs tables and slides
 * text-boxes) must wire `onComposingContextChange` so partial Hangul jamo
 * and browser IME pre-edits render into the layout. Without the wiring,
 * the user sees nothing in the box until the syllable commits — which
 * surfaced first via slides P2.6 type-to-edit smoke testing.
 *
 * This file covers the model-side invariants of the composition path
 * (interim text stays view-local; commit lands once). The pixel-level
 * render proof lives in the browser smoke scenario, since reading the
 * injected composing run requires a real Canvas 2D pipeline.
 */

function flushRaf(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 16));
}

function emptyPara(id = 'p1'): Block {
  return { id, type: 'paragraph', inlines: [{ text: '', style: {} }], style: {} } as Block;
}

describe('text-box composing-context wiring', () => {
  let container: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let originalGetContext: HTMLCanvasElement['getContext'];

  beforeEach(() => {
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    const noop = (): void => {};
    HTMLCanvasElement.prototype.getContext = ((kind: string) => kind === '2d' ? {
      fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1,
      font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', globalAlpha: 1,
      fillRect: noop, clearRect: noop, fillText: noop, setTransform: noop,
      save: noop, restore: noop, scale: noop, translate: noop, rotate: noop,
      transform: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
      arc: noop, rect: noop, clip: noop, fill: noop, stroke: noop,
      measureText: (text: string) => ({ width: text.length * 8 }),
    } : null) as HTMLCanvasElement['getContext'];
    document.body.innerHTML = '';
    container = document.createElement('div');
    container.style.position = 'absolute';
    canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 200;
    container.appendChild(canvas);
    document.body.appendChild(container);
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  function textareaOf(): HTMLTextAreaElement {
    const ta = container.querySelector('textarea');
    if (ta === null) throw new Error('textarea not mounted');
    return ta;
  }

  function inputJamo(value: string): void {
    const ta = textareaOf();
    ta.value = value;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('software Hangul: interim jamo stays view-local, commits on blur', async () => {
    let committed: Block[] | null = null;
    const api = initializeTextBox({
      container,
      canvas,
      blocks: [emptyPara()],
      contentWidth: 400,
      contentHeight: 200,
      onCommit: (next) => { committed = next; },
    });
    await flushRaf();
    api.focus();
    await flushRaf();

    // First jamo: assembler buffers it, no model write yet.
    inputJamo('ㄱ');
    expect(committed).toBeNull();

    // Second jamo completes the syllable, still view-local.
    inputJamo('ㅏ');
    expect(committed).toBeNull();
    expect(api.getDraftSnapshot().blocks[0].inlines.map((i) => i.text).join('')).toBe('가');

    // Blur flushes the in-progress syllable + commits one undo unit.
    api.blur();
    await flushRaf();
    expect(committed).not.toBeNull();
    const text = committed![0].inlines.map((i) => i.text).join('');
    expect(text).toBe('가');
    api.detach();
  });

  it('browser IME exposes an exact non-mutating draft and change event before compositionend', async () => {
    const changes = vi.fn();
    let committed: Block[] | null = null;
    const original = [emptyPara()];
    const api = initializeTextBox({
      container,
      canvas,
      blocks: original,
      contentWidth: 400,
      contentHeight: 200,
      onDraftChange: changes,
      onCommit: (next) => { committed = next; },
    });
    api.focus();
    const ta = textareaOf();
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    ta.value = '日本';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();

    const draft = api.getDraftSnapshot();
    expect(draft.blocks[0].inlines.map((inline) => inline.text).join('')).toBe('日本');
    expect(changes).toHaveBeenCalledTimes(1);
    expect(committed).toBeNull();
    expect(document.activeElement).toBe(ta);
    expect(original).toEqual([emptyPara()]);

    draft.blocks[0].inlines[0].text = 'mutated return value';
    expect(api.getDraftSnapshot().blocks[0].inlines.map((inline) => inline.text).join('')).toBe('日本');
    api.detach();
  });

  it('software Hangul: requestAnimationFrame fires after each composing step', async () => {
    // The fix is the wiring `onComposingContextChange → composingContext +
    // layoutCache = undefined + requestRender()`. Without the requestRender
    // call, the canvas wouldn't repaint and the user would see nothing.
    // We spy on `requestAnimationFrame` directly — `onContentHeightChange`
    // would only fire when total height actually changes, so a single
    // jamo on an empty block wouldn't reliably trip that signal even when
    // the render path runs. Comparing rAF call counts before vs after the
    // jamo input proves the composing-context wiring drove a new frame.
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    const api = initializeTextBox({
      container,
      canvas,
      blocks: [emptyPara()],
      contentWidth: 400,
      contentHeight: 200,
      onCommit: () => {},
    });
    await flushRaf();
    api.focus();
    await flushRaf();
    const baseline = rafSpy.mock.calls.length;
    inputJamo('ㄱ');
    await flushRaf();
    expect(rafSpy.mock.calls.length).toBeGreaterThan(baseline);
    rafSpy.mockRestore();
    api.detach();
  });

  it('commits a one-jamo standalone (e.g. user types "ㄱ" and exits)', async () => {
    // Software Hangul flushes the LEAD-only state as its standalone jamo
    // — verifies the blur path still works for the slides P2.6 case where
    // the user typed exactly one consonant before leaving.
    let committed: Block[] | null = null;
    const api = initializeTextBox({
      container,
      canvas,
      blocks: [emptyPara()],
      contentWidth: 400,
      contentHeight: 200,
      onCommit: (next) => { committed = next; },
    });
    await flushRaf();
    api.focus();
    await flushRaf();
    inputJamo('ㄱ');
    api.blur();
    await flushRaf();
    expect(committed).not.toBeNull();
    const text = committed![0].inlines.map((i) => i.text).join('');
    expect(text).toBe('ㄱ');
    api.detach();
  });
});
