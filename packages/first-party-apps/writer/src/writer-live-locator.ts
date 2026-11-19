import { type Block } from "@nautilo/office-docs/node";
import { normalizeProposalText, type ResolvedRange } from "./proposal-resolver";

export type WriterLiveAnchor = {
  before?: string;
  target: string;
  after?: string;
};

export type WriterLiveLocatorResult =
  | { ok: true; range: ResolvedRange }
  | { ok: false; code: "anchor_not_found" | "anchor_ambiguous"; message: string };

function occurrences(text: string, needle: string): number[] {
  const indexes: number[] = [];
  for (let from = 0; from <= text.length - needle.length;) {
    const index = text.indexOf(needle, from);
    if (index < 0) break;
    indexes.push(index);
    from = index + Math.max(1, needle.length);
  }
  return indexes;
}

/**
 * Resolves a small target using immediately adjacent, canonical context.
 * The returned offsets stay server-internal; callers mint an opaque handle.
 */
export function locateWriterText(
  text: string,
  anchor: WriterLiveAnchor,
): WriterLiveLocatorResult {
  const normalized = normalizeProposalText(text);
  const before = normalizeProposalText(anchor.before ?? "").text;
  const target = normalizeProposalText(anchor.target).text;
  const after = normalizeProposalText(anchor.after ?? "").text;
  if (!target) return { ok: false, code: "anchor_not_found", message: "target is empty after normalization" };

  const candidates = occurrences(normalized.text, target).filter((start) => {
    const end = start + target.length;
    return (!before || normalized.text.slice(0, start).trimEnd().endsWith(before))
      && (!after || normalized.text.slice(end).trimStart().startsWith(after));
  });
  if (candidates.length === 0) {
    return { ok: false, code: "anchor_not_found", message: "before/target/after context does not occur in the specified block" };
  }
  if (candidates.length > 1) {
    return { ok: false, code: "anchor_ambiguous", message: "before/target/after context occurs more than once in the specified block" };
  }
  const start = candidates[0]!;
  const end = start + target.length;
  return {
    ok: true,
    range: {
      start: normalized.starts[start]!,
      end: normalized.ends[end - 1]!,
    },
  };
}

/** Finds a text block without ever flattening table content or exposing covered cells. */
export function findCanonicalTextBlock(blocks: readonly Block[], blockId: string): Block | null {
  const topLevel = blocks.find((block) => block.id === blockId);
  if (topLevel) return Array.isArray(topLevel.inlines) ? topLevel : null;
  for (const table of blocks) {
    if (table.type !== "table" || !table.tableData) continue;
    for (const row of table.tableData.rows) for (const cell of row.cells) {
      if (cell.colSpan === 0) continue;
      const nested = cell.blocks.find((block) => block.id === blockId);
      if (nested) return nested;
    }
  }
  return null;
}
