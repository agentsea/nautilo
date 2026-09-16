import { describe, expect, it } from 'vitest';
import type { PDFPage } from 'pdf-lib';
import { completeNestedWork } from '../../src/view/nested-work.js';
import type { LayoutTable } from '../../src/view/table-layout.js';
import type { TableData } from '../../src/model/types.js';
import { paintTableRowsWork } from '../../src/export/pdf-table-painter.js';

describe('paintTableRowsWork', () => {
  it('preserves background, nested content, border paint order', () => {
    const order: string[] = [];
    const page = {
      drawRectangle: () => order.push('background'),
      drawLine: () => order.push('border'),
      pushOperators: () => undefined,
    } as unknown as PDFPage;
    const data: TableData = {
      rows: [{ cells: [{
        blocks: [],
        style: { backgroundColor: '#ffffff' },
      }] }],
      columnWidths: [1],
    };
    const layout: LayoutTable = {
      cells: [[{ lines: [], blockBoundaries: [], width: 20, height: 20, merged: false }]],
      columnXOffsets: [0],
      columnPixelWidths: [20],
      rowYOffsets: [0],
      rowHeights: [20],
      totalWidth: 20,
      totalHeight: 20,
      blockParentMap: new Map(),
    };

    completeNestedWork(paintTableRowsWork(
      page, data, layout, 0, 0, 100, {
        renderStartRow: 0,
        pageStartRow: 0,
        endRowIndex: 1,
      },
      function* () {
        order.push('content');
        yield* [];
      },
    ));

    expect(order).toEqual([
      'background',
      'content',
      'border', 'border', 'border', 'border',
    ]);
  });
});
