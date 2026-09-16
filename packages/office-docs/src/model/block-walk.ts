import type { Block } from './types.js';

/** Visit each containing array before its nested cells, in document order. */
export function* walkBlockArrays(roots: Block[][]): Generator<Block[]> {
  const work = roots.slice().reverse();
  while (work.length > 0) {
    const blocks = work.pop()!;
    yield blocks;
    for (let b = blocks.length - 1; b >= 0; b--) {
      const rows = blocks[b].tableData?.rows;
      if (!rows) continue;
      for (let r = rows.length - 1; r >= 0; r--) {
        const cells = rows[r].cells;
        for (let c = cells.length - 1; c >= 0; c--) work.push(cells[c].blocks);
      }
    }
  }
}

/** Visit blocks in document order, descending into a table before its sibling. */
export function* walkBlocks(blocks: Block[]): Generator<Block> {
  const work = blocks.slice().reverse();
  while (work.length > 0) {
    const block = work.pop()!;
    yield block;
    const rows = block.tableData?.rows;
    if (!rows) continue;
    for (let r = rows.length - 1; r >= 0; r--) {
      const cells = rows[r].cells;
      for (let c = cells.length - 1; c >= 0; c--) {
        const children = cells[c].blocks;
        for (let b = children.length - 1; b >= 0; b--) work.push(children[b]);
      }
    }
  }
}
