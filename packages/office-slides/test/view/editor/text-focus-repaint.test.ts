// @vitest-environment jsdom
import { expect, it } from 'vitest';
import '../../../src/view/canvas/test-canvas-env';
import { MemSlidesStore } from '../../../src/store/memory';
import { makeDefaultSlidesTextBlock } from '../../../src/view/editor/default-text';
import { initialize } from '../../../src/view/editor/editor';

it('keeps the focused native text input connected through chrome repaint', () => {
  const canvas = document.createElement('canvas');
  const overlay = document.createElement('div');
  document.body.append(canvas, overlay);
  const store = new MemSlidesStore();
  let id = '';
  store.batch(() => {
    const slide = store.addSlide('blank');
    id = store.addElement(slide, {
      type: 'shape', frame: { x: -120, y: -100, w: 240, h: 200, rotation: 0 },
      data: { kind: 'roundRect', text: { blocks: [makeDefaultSlidesTextBlock('note')] } },
    });
  });
  const editor = initialize({ canvas, overlay, store, hostWidth: 960, hostHeight: 540, dpr: 1, viewport: { panX: 480, panY: 270, zoom: 1 } });
  try {
    editor.enterTextEditing(id);
    const input = overlay.querySelector('textarea');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    editor.markDirty();
    editor.render();
    expect(document.activeElement).toBe(input);
    expect(overlay.querySelector('textarea')).toBe(input);
    expect(editor.isTextEditing()).toBe(true);
    editor.markDirty();
    expect(document.activeElement).toBe(input);
  } finally {
    editor.detach();
    canvas.remove();
    overlay.remove();
  }
});
