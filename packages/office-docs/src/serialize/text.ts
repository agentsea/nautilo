import { completeNestedWork, type NestedWork } from '../view/nested-work.js';
import type {
  Block,
  Document,
  HeaderFooter,
  Inline,
  TableCell,
} from '../model/types.js';

/**
 * Options for the plaintext serializer.
 *
 * - `includeHeaderFooter` — emit the document header before, and footer
 *   after, the body. Defaults to `false` because headers/footers are a
 *   page-level decoration that doesn't survive a single linear stream.
 */
export interface TextOptions {
  includeHeaderFooter?: boolean;
}

/**
 * Serialize a `Document` to a plaintext stream.
 *
 * Rules:
 * - One block per line; blocks are joined with `\n`.
 * - All inline formatting is dropped.
 * - List items emit just their text (no `-` / `1.` markers — the caller
 *   gets a flat sequence and can renumber if it cares).
 * - Tables become tab-separated rows with `\n` between rows. Merges and
 *   nested tables are flattened (cell text only).
 * - `horizontal-rule` becomes a literal `----` line.
 * - `page-break` becomes a form-feed character on its own line; some
 *   downstream tools (`less`, paginators) treat it specially.
 * - Image inlines render as `[image]`; page-number markers become `#`.
 */
export function serializeText(doc: Document, opts: TextOptions = {}): string {
  const includeHF = opts.includeHeaderFooter === true;
  const segments: string[] = [];

  if (includeHF && doc.header) {
    segments.push(serializeHeaderFooter(doc.header));
  }

  segments.push(serializeBlocks(doc.blocks));

  if (includeHF && doc.footer) {
    segments.push(serializeHeaderFooter(doc.footer));
  }

  return segments.filter((s) => s.length > 0).join('\n');
}

function serializeHeaderFooter(region: HeaderFooter): string {
  return serializeBlocks(region.blocks);
}

function serializeBlocks(blocks: Block[]): string {
  return blocks.map(blockToText).join('\n');
}

function blockToText(block: Block): string {
  return completeNestedWork(blockToTextWork(block));
}

function* blockToTextWork(block: Block): NestedWork<string> {
  switch (block.type) {
    case 'horizontal-rule':
      return '----';
    case 'page-break':
      return '\f';
    case 'table':
      return yield tableToTextWork(block);
    default:
      return inlinesToText(block.inlines);
  }
}

function * tableToTextWork(block: Block): NestedWork<string > {
  if (!block.tableData) return '';
  const rows: string[] = [];
  for (const row of block.tableData.rows
    ) {
    const cells: string[] = [];
    for (const cell of row.cells) cells.push(yield cellToTextWork(cell));
    rows.push(cells.join('\t'))
    ;
  }
  return rows.join('\n');
}

function * cellToTextWork(cell: TableCell): NestedWork<string > {
  // Flatten each cell's line breaks after its complete nested contents are
  // serialized, preserving the existing tab-separated plaintext projection.
  const parts: string[] = [];
  for (const block of cell.blocks) parts.push(yield blockToTextWork(block));
  return parts.join(' ').replace(/[\r\n]+/g, ' ');
}

function inlinesToText(inlines: Inline[]): string {
  let out = '';
  for (const inline of inlines) {
    if (inline.style.image) {
      out += '[image]';
      continue;
    }
    if (inline.style.pageNumber) {
      out += '#';
      continue;
    }
    // Strip stray ORC (U+FFFC) characters that aren't carrying
    // image/pageNumber styling — keeping them in plaintext just
    // produces tofu in terminals.
    out += inline.text.replace(/\uFFFC/g, '');
  }
  return out;
}
