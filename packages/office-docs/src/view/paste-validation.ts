import type { Block, TableCell } from '../model/types.js';
import { walkBlockArrays } from '../model/block-walk.js';

export type RichPasteContent =
  | { blocks: Block[]; tableCells?: never }
  | { blocks?: never; tableCells: TableCell[][] };

/** Validate a complete rich-paste plan before the editor mutates anything. */
export function validateRichPaste(
  content: RichPasteContent,
): void {
  const roots: Block[][] = [];
  if (content.blocks) roots.push(content.blocks);
  if (content.tableCells) {
    for (const row of content.tableCells) {
      for (const cell of row) roots.push(cell.blocks);
    }
  }

  for (const blocks of walkBlockArrays(roots)) {
    for (const block of blocks) {
      if (block.type === 'list-item') {
        const level = block.listLevel ?? 0;
        if (!Number.isSafeInteger(level) || level < 0) {
          throw new RangeError(
            'Cannot paste a list with an invalid indentation level. List levels must be nonnegative safe integers.',
          );
        }
        const indent = 36 * (level + 1);
        if (!Number.isFinite(indent)) {
          throw new RangeError(
            'Cannot paste a list whose indentation cannot be represented safely.',
          );
        }
      }
    }
  }
}
