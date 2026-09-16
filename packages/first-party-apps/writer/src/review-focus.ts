import type { Block, Document, SearchMatch } from "@nautilo/office-docs/node";
import type { ReviewProjectionItem } from "./review-projection";

type TextBlock = Block & { inlines?: Array<{ text: string }> };
type TextAnchor = { role: "delete" | "insert"; blockId: string; offset: number; length: number };
type TableBlock = Block & {
  type: "table";
  tableData?: { rows: Array<{ cells: Array<{ blocks: TextBlock[] }> }> };
};

function isTableBlock(block: Block | undefined): block is TableBlock {
  return block?.type === "table" && !!(block as TableBlock).tableData;
}

function blockLength(block: TextBlock | undefined): number {
  return (block?.inlines ?? []).reduce((length, inline) => length + inline.text.length, 0);
}

function projectedBlock(document: Document, blockId: string): TextBlock | undefined {
  return document.blocks.find((block) => block.id === blockId) as TextBlock | undefined;
}

function cellBlock(
  document: Document,
  tableId: string,
  rowIndex: number | undefined,
  colIndex: number | undefined,
  blockId: string,
): { block: TextBlock; cellBlockIndex: number } | null {
  const table = document.blocks.find((block) => block.id === tableId);
  const cell = isTableBlock(table) && rowIndex !== undefined && colIndex !== undefined
    ? table.tableData!.rows[rowIndex]?.cells[colIndex]
    : undefined;
  const cellBlockIndex = cell?.blocks.findIndex((block) => block.id === blockId) ?? -1;
  return cell && cellBlockIndex >= 0 ? { block: cell.blocks[cellBlockIndex]!, cellBlockIndex } : null;
}

function textAnchorLengths(item: ReviewProjectionItem): { before: number; after: number; offset: number } | null {
  const deletion = item.anchors.find(
    (anchor): anchor is TextAnchor => anchor.role === "delete",
  );
  const insertion = item.anchors.find(
    (anchor): anchor is TextAnchor => anchor.role === "insert",
  );
  if (!deletion && !insertion) return null;
  return {
    before: deletion?.length ?? 0,
    after: insertion?.length ?? 0,
    offset: deletion?.offset ?? insertion!.offset,
  };
}

function projectedTextOffset(items: readonly ReviewProjectionItem[], item: ReviewProjectionItem, blockId: string, offset: number): number {
  let delta = 0;
  const ordered = items
    .filter((candidate) => candidate.anchors.some((anchor) =>
      (anchor.role === "delete" || anchor.role === "insert") && anchor.blockId === blockId,
    ))
    .sort((left, right) => {
      const leftLengths = textAnchorLengths(left)!;
      const rightLengths = textAnchorLengths(right)!;
      return leftLengths.offset - rightLengths.offset || leftLengths.before - rightLengths.before;
    });
  for (const candidate of ordered) {
    if (candidate === item) break;
    const lengths = textAnchorLengths(candidate);
    if (lengths && lengths.offset <= offset) delta += lengths.after;
  }
  return Math.max(0, offset + delta);
}

function matchForBlock(blockId: string, startOffset: number, endOffset: number): SearchMatch {
  return { blockId, startOffset, endOffset: Math.max(startOffset, endOffset) };
}

/**
 * Resolves review items into engine-native search matches. It deliberately
 * emits nested cell block IDs (with cell metadata), never the table container
 * ID, because DocPosition cannot resolve a table block as editable text.
 */
export function resolveReviewFocusRanges(
  document: Document,
  items: readonly ReviewProjectionItem[],
  activeChangeId: string | null,
): SearchMatch[] {
  const item = activeChangeId ? items.find((candidate) => candidate.id === activeChangeId) : undefined;
  if (!item) return [];

  const ranges: SearchMatch[] = [];
  for (const anchor of item.anchors) {
    if (anchor.role === "delete" || anchor.role === "insert") {
      const block = projectedBlock(document, anchor.blockId);
      if (!block) continue;
      const before = textAnchorLengths(item)?.before ?? 0;
      const start = projectedTextOffset(items, item, anchor.blockId, anchor.offset) +
        (anchor.role === "insert" ? before : 0);
      ranges.push(matchForBlock(anchor.blockId, start, Math.min(blockLength(block), start + anchor.length)));
      continue;
    }

    if (anchor.role === "cell") {
      const resolved = cellBlock(document, anchor.tableId, anchor.rowIndex, anchor.colIndex, anchor.blockId);
      if (!resolved) continue;
      ranges.push({
        ...matchForBlock(anchor.blockId, 0, Math.max(1, blockLength(resolved.block))),
        cellAddress: { rowIndex: anchor.rowIndex!, colIndex: anchor.colIndex! },
        cellBlockIndex: resolved.cellBlockIndex,
      });
      continue;
    }

    const destination = anchor.role === "destination"
      ? document.blocks.find((block) =>
        block.id === `review:move-destination:${item.id}` ||
        block.id.startsWith(`review:move-destination:${item.id}:`),
      ) as TextBlock | undefined
      : undefined;
    const direct = destination ?? projectedBlock(document, anchor.blockId);
    if (direct) {
      ranges.push(matchForBlock(direct.id, 0, Math.max(1, blockLength(direct))));
    }
  }

  if (ranges.length > 0) return ranges;
  const inserted = document.blocks.find((block) =>
    block.id === `review:block-insert:${item.id}` || block.id.startsWith(`review:block-insert:${item.id}:`) ||
    block.id === `review:move-destination:${item.id}` || block.id.startsWith(`review:move-destination:${item.id}:`),
  ) as TextBlock | undefined;
  return inserted ? [matchForBlock(inserted.id, 0, Math.max(1, blockLength(inserted)))] : [];
}

export type ReviewFocusScheduleTarget = { generation: number; changeId: string | null };

export type ReviewFocusScheduler = {
  cancel(): void;
};

/**
 * Waits for Wafflebase's first committed paint, then retries four bounded
 * frames. Every callback validates the immutable projection generation and
 * active change before focusing, so obsolete remounts cannot move the viewport.
 */
export function scheduleReviewFocus(
  target: ReviewFocusScheduleTarget,
  getCurrent: () => ReviewFocusScheduleTarget,
  focus: () => void,
  requestFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancelFrame: (handle: number) => void = cancelAnimationFrame,
): ReviewFocusScheduler {
  let cancelled = false;
  let handle: number | null = null;
  let frame = 0;
  const run = () => {
    if (cancelled) return;
    const current = getCurrent();
    if (current.generation !== target.generation || current.changeId !== target.changeId) return;
    frame += 1;
    if (frame >= 2) focus();
    if (frame < 6) handle = requestFrame(run);
  };
  handle = requestFrame(run);
  return {
    cancel() {
      cancelled = true;
      if (handle !== null) cancelFrame(handle);
    },
  };
}
