import { serializeText } from '../../src/serialize/text.js';
import { serializeBlocks, deserializeBlocks, cloneTableCells } from '../../src/view/clipboard.js';
import { stringifyJsonData } from '../../src/model/json-data.js';
import { describe, expect, it } from 'vitest';
import { Doc } from '../../src/model/document.js';
import { walkBlockArrays } from '../../src/model/block-walk.js';
import { DEFAULT_BLOCK_STYLE, type Block, type Document } from '../../src/model/types.js';
import { MemDocStore } from '../../src/store/memory.js';
import { cloneBlockWithFreshIds } from '../../src/store/block-helpers.js';
import { computeTableLayout, findRowSplitHeight } from '../../src/view/table-layout.js';
import { renderTableBackgrounds, renderTableContent } from '../../src/view/table-renderer.js';
import { stubMeasurer } from './_stub-measurer.js';

function deepTable(depth: number): Block {
  let block: Block = {
    id: 'leaf', type: 'paragraph', style: { ...DEFAULT_BLOCK_STYLE },
    inlines: [{ text: 'deep content', style: {} }],
  };
  for (let level = 0; level < depth; level++) {
    block = {
      id: `table-${level}`, type: 'table', style: { ...DEFAULT_BLOCK_STYLE }, inlines: [],
      tableData: {
        columnWidths: [1],
        rows: [{ cells: [{ blocks: [block], style: { padding: 0 } }] }],
      },
    };
  }
  return block;
}

describe('nested table consumers without a depth ceiling', () => {
  it('lays out, paints and locates text through 1000 tables with exact parent identities', () => {
    const block = deepTable(1000);
    const layout = computeTableLayout(block.tableData!, block.id, stubMeasurer(), 400);
    expect(layout.blockParentMap.size).toBe(1000);
    expect(layout.blockParentMap.get('leaf')?.tableBlockId).toBe('table-0');
    const drawn: string[] = [];
    const ctx = new Proxy({}, {
      get: (_target, property) => property === 'fillText'
        ? (text: string) => { drawn.push(text); }
        : () => {},
      set: () => true,
    }) as CanvasRenderingContext2D;
    renderTableBackgrounds(ctx, block.tableData!, layout, 0, 0);
    renderTableContent(ctx, block.tableData!, layout, 0, 0);
    expect(drawn.join('')).toBe('deep content');
    expect(Number.isFinite(findRowSplitHeight(layout, 0, 10))).toBe(true);

    const doc = new Doc(new MemDocStore({ blocks: [block] }));
    expect(doc.getBlock('leaf').inlines[0].text).toBe('deep content');
    doc.setBlockParentMap(layout.blockParentMap);
    expect(doc.getBlock('leaf').inlines[0].text).toBe('deep content');
    expect(doc.dropStaleStyleOffAll()).toBe(false);
    expect(doc.searchText('deep')).toEqual([{ blockId: 'leaf', startOffset: 0, endOffset: 4 }]);
  });

  it('gives every copied cell descendant an independent identity and data tree', () => {
    const source = [{ cells: [{ blocks: [deepTable(1000)], style: { padding: 0 } }] }];
    const copy = cloneTableCells(source.map(row => row.cells));
    const before = stringifyJsonData(source);
    const ids = new Set<string>();
    for (const blocks of walkBlockArrays([copy[0][0].blocks])) {
      for (const block of blocks) {
        expect(block.id).not.toBe('leaf');
        expect(block.id.startsWith('table-')).toBe(false);
        ids.add(block.id);
        if (block.type === 'paragraph') block.inlines[0].text = 'edited clone';
      }
    }
    expect(ids.size).toBe(1001);
    expect(stringifyJsonData(source)).toBe(before);
    expect(serializeText({ blocks: copy[0][0].blocks })).toBe('edited clone');
  });

  it('finds deeply nested matches before later top-level siblings', () => {
    const after: Block = { id: 'after', type: 'paragraph', style: { ...DEFAULT_BLOCK_STYLE },
      inlines: [{ text: 'deep after', style: {} }] };
    const doc = new Doc(new MemDocStore({ blocks: [deepTable(1000), after] }));
    expect(doc.searchText('deep').map(match => match.blockId)).toEqual(['leaf', 'after']);
  });

  it('copies identities, edits the deepest block, undoes and reopens without losing nested content', () => {
    const block = deepTable(1000);
    expect(serializeText({ blocks: [block] })).toBe('deep content');
    expect(serializeText({ blocks: deserializeBlocks(serializeBlocks([block])) }))
      .toBe('deep content');
    const copy = cloneBlockWithFreshIds(block);
    const ids = new Set<string>();
    for (const blocks of walkBlockArrays([[copy]])) {
      for (const child of blocks) {
        expect(child.id).not.toBe('leaf');
        expect(child.id.startsWith('table-')).toBe(false);
        ids.add(child.id);
      }
    }
    expect(ids.size).toBe(1001);
    const store = new MemDocStore({ blocks: [block] });
    const before = stringifyJsonData(store.getDocument());
    store.batch(() => store.insertText('leaf', 0, 'edited '));
    expect(store.getBlock('leaf')?.inlines[0].text).toBe('edited deep content');
    const saved = stringifyJsonData(store.getDocument());
    store.undo();
    expect(stringifyJsonData(store.getDocument())).toBe(before);
    store.redo();
    expect(stringifyJsonData(store.getDocument())).toBe(saved);
    expect(new MemDocStore(JSON.parse(saved) as Document).getBlock('leaf')?.inlines[0].text)
      .toBe('edited deep content');
  });
});
