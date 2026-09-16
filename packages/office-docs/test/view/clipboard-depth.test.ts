import { describe, expect, it } from 'vitest';
import { deserializeBlocks, deserializeClipboard } from '../../src/view/clipboard.js';
import type { Block } from '../../src/model/types.js';

// Build JSON text directly so the fixture itself does not depend on the
// recursive JSON.stringify implementation for deeply nested object graphs.
function nestedJson(depth: number): string {
  const head = '{"type":"table","tableData":{"rows":[{"cells":[{"blocks":[';
  const tail = '],"style":{"padding":7}}]}],"columnWidths":[1]},"style":{}}';
  const leaf = '{"type":"paragraph","inlines":[{"text":"deep content","style":{"bold":true}}],"style":{}}';
  return head.repeat(depth) + leaf + tail.repeat(depth);
}

function assertNested(block: Block, depth: number): void {
  let cursor = block;
  for (let i = 0; i < depth; i++) {
    expect(cursor.type).toBe('table');
    expect(cursor.tableData?.rows).toHaveLength(1);
    const cell = cursor.tableData!.rows[0].cells[0];
    expect(cell.style.padding).toBe(7);
    expect(cell.blocks).toHaveLength(1);
    cursor = cell.blocks[0];
  }
  expect(cursor.inlines).toEqual([{ text: 'deep content', style: { bold: true } }]);
}

describe('internal clipboard preserves nested content', () => {
  it.each([9, 64, 3000])('keeps all %i nested tables without recursive sanitizer calls', depth => {
    const blocks = deserializeBlocks('{"version":1,"blocks":[' + nestedJson(depth) + ']}');
    expect(blocks).toHaveLength(1);
    assertNested(blocks[0], depth);
  });

  it('preserves nested content through both block and cell payload paths', () => {
    const json = '{"version":1,"blocks":[' + nestedJson(12)
      + '],"tableCells":[[{"blocks":[' + nestedJson(16) + '],"style":{}}]]}';
    const data = deserializeClipboard(json);
    assertNested(data.blocks[0], 12);
    assertNested(data.tableCells![0][0].blocks[0], 16);
  });
});
