// Modified by Nautilo: verifies the owned browser/headless package contract.
import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

describe('Nautilo package entries', () => {
  test('browser entry calculates formulas without Node globals', async () => {
    const browser = await import('@nautilo/office-sheets/browser');
    expect([...browser.extractReferences('=A1+B2')]).toEqual(['A1', 'B2']);
    expect(typeof browser.Spreadsheet).toBe('function');
    const bundle = await readFile(
      fileURLToPath(new URL('../dist/browser.js', import.meta.url)),
      'utf8',
    );
    expect(bundle).not.toMatch(/from\s*["'](?:assert|util)["']/);
  });

  test('node entry exposes the Stack 414 model and calculator contract', async () => {
    const node = await import('@nautilo/office-sheets/node');
    const store = new node.MemStore();
    await store.set(node.parseRef('A1'), { v: '2' });
    await store.set(node.parseRef('A2'), { f: '=A1+3' });
    const sheet = new node.HeadlessSheet(store);
    await node.calculateSheet(sheet, new Map(), ['A2']);
    expect((await store.get(node.parseRef('A2')))?.v).toBe('5');
    const bundle = await readFile(
      fileURLToPath(new URL('../dist/node.js', import.meta.url)),
      'utf8',
    );
    expect(bundle).not.toMatch(
      /(?:from\s*|require\(\s*)["'](?:node:)?(?:assert|util)(?:\/[^"']*)?["']/,
    );
  });
});
