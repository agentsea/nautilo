// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { CellInput } from '../../src/view/cellinput';
import { FormulaBar } from '../../src/view/formulabar';
import { Sheet } from '../../src/model/worksheet/sheet';
import { MemStore } from '../../src/store/memory';

// A quoted sheet name accepts every character but the closing quote, so a
// single REFERENCE token can carry arbitrary HTML into the highlighter.
const Payload = "='<img src=x onerror=alert(1)>'!A1";

// escapeHTML renders a space as &nbsp;, which reads back as U+00A0.
function renderedText(el: HTMLElement): string {
  return (el.textContent ?? '').replace(/\u00a0/g, ' ');
}

describe('formula highlighting', () => {
  it('escapes a reference in the cell input instead of building elements', () => {
    const input = new CellInput();

    input.show(0, 0, Payload, false);

    expect(input.getInput().querySelector('img')).toBeNull();
    expect(renderedText(input.getInput())).toBe(Payload);

    input.cleanup();
  });

  it('escapes a reference in the formula bar instead of building elements', () => {
    const bar = new FormulaBar();

    bar.setValue(Payload);

    expect(bar.getFormulaInput().querySelector('img')).toBeNull();
    expect(renderedText(bar.getFormulaInput())).toBe(Payload);

    bar.cleanup();
  });

  it('leaves an entity in a sheet name undecoded', () => {
    const formula = "='M&amp;A'!A1";
    const bar = new FormulaBar();

    bar.setValue(formula);

    expect(renderedText(bar.getFormulaInput())).toBe(formula);

    bar.cleanup();
  });

  it('does not repaint the formula bar from stored data during composition', async () => {
    const sheet = new Sheet(new MemStore());
    await sheet.setData({ r: 1, c: 1 }, '21');
    const bar = new FormulaBar();
    bar.initialize(sheet);
    await bar.render();
    const input = bar.getFormulaInput();
    expect(input.innerText).toBe('21');

    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.innerText = '999';
    await bar.render();
    expect(input.innerText).toBe('999');

    input.dispatchEvent(new CompositionEvent('compositionend'));
    expect(input.innerText).toBe('999');
    bar.cleanup();
  });
});
