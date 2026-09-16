import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

describe('owned Slides dependency package boundary', () => {
  it('loads the emitted ESM and CJS model entries without browser globals', () => {
    const result = spawnSync('node', ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      for (const key of ['window', 'document', 'HTMLElement', 'OffscreenCanvas']) {
        Object.defineProperty(globalThis, key, { get() { throw new Error('DOM access: ' + key); } });
      }
      for (const load of [p => import(p), p => Promise.resolve(require(p))]) {
        const docs = await load('@nautilo/office-docs/node');
        assert.equal(docs.getBlockText(docs.createEmptyBlock()), '');
        assert.equal(docs.initialize, undefined);
        const slides = await load('@nautilo/office-slides/node');
        const store = new slides.MemSlidesStore();
        store.batch(() => store.addSlide('blank'));
        assert.equal(store.read().slides.length, 1);
        assert.equal(slides.initializeEditor, undefined);
        assert.equal(typeof slides.exportPptx, 'function');
      }
    `], { cwd: root, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('bundles emitted browser entries with the spell dictionary runtime asset', () => {
    const result = spawnSync('bun', ['--eval', `
      import { fileURLToPath } from 'node:url';
      const entrypoints = ['docs', 'slides'].map(kind =>
        fileURLToPath(import.meta.resolve('@nautilo/office-' + kind + '/browser')));
      const result = await Bun.build({entrypoints, target: 'browser', splitting: true});
      if (!result.success) throw new AggregateError(result.logs);
      const chunks = await Promise.all(result.outputs.map(output => output.text()));
      if (!chunks.some(text => text.includes('NOSUGGEST'))) throw new Error('Spell dictionary missing');
    `], { cwd: root, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('resolves every declared export and retains package notices', () => {
    function check(value: unknown, dir: string): void {
      if (typeof value === 'string') expect(existsSync(resolve(dir, value)), value).toBe(true);
      else if (value && typeof value === 'object') {
        for (const child of Object.values(value)) check(child, dir);
      }
    }
    for (const kind of ['docs', 'slides']) {
      const dir = resolve(root, 'packages', `office-${kind}`);
      const manifest = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as {
        exports: unknown; files: string[];
      };
      check(manifest.exports, dir);
      for (const path of ['LICENSE', 'NOTICE.md', ...(kind === 'docs' ? ['DICTIONARY-LICENSE.txt'] : [])]) {
        expect(manifest.files).toContain(path);
        expect(existsSync(resolve(dir, path))).toBe(true);
      }
    }
  });
});
