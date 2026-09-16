import { describe, expect, it } from 'vitest';
import type { Block } from '../../src/model/types.js';
import { DEFAULT_BLOCK_STYLE } from '../../src/model/types.js';
import {
  validateRichPaste,
} from '../../src/view/paste-validation.js';

function paragraph(listLevel?: number): Block {
  return {
    id: crypto.randomUUID(),
    type: listLevel === undefined ? 'paragraph' : 'list-item',
    inlines: [{ text: 'content', style: {} }],
    style: { ...DEFAULT_BLOCK_STYLE },
    ...(listLevel === undefined ? {} : { listKind: 'unordered' as const, listLevel }),
  };
}

function nestedTable(depth: number): Block {
  let block = paragraph();
  for (let i = 0; i < depth; i++) {
    block = {
      id: crypto.randomUUID(),
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

describe('validateRichPaste', () => {
  it('validates deeply nested content without a table-depth cutoff', () => {
    expect(() => validateRichPaste({ blocks: [nestedTable(3000)] })).not.toThrow();
    });

  it('validates nested table-cell payloads without an implicit containing-table cap', () => { const tableCells = [[{ blocks: [nestedTable(1000)], style: { padding: 4 } }]];
    expect(() => validateRichPaste({ tableCells })).not.toThrow();
  });

  it.each([1.5, -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid list level %s',
    (level) => {
      expect(() => validateRichPaste({ blocks: [paragraph(level)] }))
      .toThrow('List levels must be nonnegative safe integers');
    } ,
  );

  it('accepts deep but safely represented list levels', () => {
    expect(() => validateRichPaste({ blocks: [paragraph(Number.MAX_SAFE_INTEGER)] })).not.toThrow();
  });
});
