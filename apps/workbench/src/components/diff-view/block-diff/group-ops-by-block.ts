import type { BlockOp } from "../../../lib/block-op-types";

export type BlockDiffOpKind = "modified" | "added" | "deleted" | "moved";

/** One rendered section per staging `BlockOp` (range replaces use a composite id). */
export type BlockDiffSection = {
  blockId: string;
  tag: string;
  op: BlockDiffOpKind;
  before: string | null;
  after: string | null;
  blockOp: BlockOp;
};

function inferTag(before: string | null, after: string | null): string {
  const src =
    after !== null && after !== undefined && after.length > 0 ? after : (before ?? "");
  const m = src.match(/<\s*([\w-]+)/i);
  return m ? m[1].toLowerCase() : "block";
}

function extractBlockIdFromHtml(html: string): string | null {
  const m = html.match(/\bid\s*=\s*["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function replaceBlockId(target: BlockOp & { op: "replace" }): string {
  if ("block" in target.target) return target.target.block;
  // Range labels read better with " .. " than "-" — the hyphen looks
  // like a compound id rather than a range. (D121-P5 viz polish.)
  return `${target.target.range.from} .. ${target.target.range.to}`;
}

/**
 * Maps each `BlockOp` from the staged envelope to a display section.
 * Snapshots are already populated by P6; this only derives labels + ids.
 */
export function groupOpsByBlock(blockOps: BlockOp[]): BlockDiffSection[] {
  return blockOps.map((blockOp) => {
    switch (blockOp.op) {
      case "replace": {
        const blockId = replaceBlockId(blockOp);
        const tag = inferTag(blockOp.before, blockOp.after);
        let op: BlockDiffOpKind;
        if (blockOp.after === "") op = "deleted";
        else if (blockOp.before === "") op = "added";
        else op = "modified";
        return {
          blockId,
          tag,
          op,
          before: blockOp.before,
          after: blockOp.after,
          blockOp,
        };
      }
      case "insert": {
        const id = extractBlockIdFromHtml(blockOp.after) ?? "new";
        const tag = inferTag(null, blockOp.after);
        return {
          blockId: id,
          tag,
          op: "added",
          before: null,
          after: blockOp.after,
          blockOp,
        };
      }
      case "move": {
        const tag = inferTag(blockOp.before, null);
        return {
          blockId: blockOp.blockId,
          tag,
          op: "moved",
          before: blockOp.before,
          after: blockOp.after,
          blockOp,
        };
      }
      case "rewrite": {
        const tag = inferTag(blockOp.before, blockOp.after);
        return {
          blockId: blockOp.blockId,
          tag,
          op: "modified",
          before: blockOp.before,
          after: blockOp.after,
          blockOp,
        };
      }
    }
  });
}
