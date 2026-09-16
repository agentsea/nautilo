/**
 * D121 §Editing Surface + D087-P2B — types for the block-edit substrate.
 *
 * The agent's surgical editing surface consists of 6 new `command`
 * branches on the unified `file` tool: `list_blocks`, `read_block`,
 * `replace_block`, `insert_block`, `move_block`, `rewrite_block`.
 * All target HTML5 + `<nw-*>` custom-element artifacts; block identity
 * is the native `id` attribute (no ULID overlay, no sidecar cache).
 *
 * Output: each mutating command produces a single `StagedPatch`
 * carrying `blockOps[]` metadata that rides the existing D087 P1
 * staged-patch + DiffView pipeline unchanged. P7's block-aware
 * DiffView renderer consumes the `before` / `after` HTML snapshots
 * populated here.
 *
 * Load-bearing principle: the agent never emits content it didn't
 * author. `move_block` emits **zero** content; `rewrite_block` only
 * emits the new short string; `replace_block` only emits the new
 * block(s). No command requires the agent to re-emit existing content
 * as a search key.
 */

/** Where to position a new / moved block relative to an anchor element. */
export type Anchor = { rel: "before" | "after" | "inside"; id: string };

/** Discriminator for `replace_block`'s target: single block by id OR a
 *  contiguous range of same-parent siblings. */
export type ReplaceTarget =
  | { block: string }
  | { range: { from: string; to: string } };

/** Three scopes for `rewrite_block`'s within-block surgery. */
export type RewriteScope = "text" | "attr" | "html";

/**
 * The discriminated `blockOps[]` entry produced by every mutating
 * command. `before` / `after` are the affected block's serialized
 * HTML in the original and resulting documents respectively — P7's
 * `<BlockDiffSection>` renderer consumes these directly per the
 * coordination in `phase-7-d121-block-aware-diff-view.md` §Acceptance
 * option (a).
 *
 *  - `op="replace"` — single block or range; `before` is the joined
 *    serialization of the affected siblings; `after` is the joined
 *    serialization of the inserted content (empty string when the
 *    op is a delete, i.e. newContent === "").
 *  - `op="insert"`  — anchor + inserted content; `before` is null
 *    (nothing existed to overwrite); `after` is the inserted block's
 *    serialization.
 *  - `op="move"`    — relocation only, zero new content; `before` is
 *    the moved block's pre-move serialization, `after` is null
 *    because semantically nothing CHANGED in the block (it just
 *    moved). P7 renders this as "Block X moved before Y" with no
 *    within-block diff.
 *  - `op="rewrite"` — within-block surgical edit; `before` and `after`
 *    are the block's full serialization on each side so the diff
 *    renderer can word-diff inside.
 */
export type BlockOp =
  | {
      op: "replace";
      target: ReplaceTarget;
      before: string;
      after: string;
    }
  | {
      op: "insert";
      anchor: Anchor;
      before: null;
      after: string;
    }
  | {
      op: "move";
      blockId: string;
      anchor: Anchor;
      before: string;
      after: null;
    }
  | {
      op: "rewrite";
      blockId: string;
      scope: RewriteScope;
      old: string;
      new: string;
      before: string;
      after: string;
    };

/** Outline node returned by `list_blocks` / `read_block`. */
export interface BlockOutline {
  id: string;
  tag: string;
  /** First ~80 chars of `textContent`, whitespace-collapsed. */
  preview: string;
  /** Present only when the request had `include_content: true` or the
   *  caller is `read_block`. */
  content?: string;
  /** Present only when descending (`depth > 0` or omitted) and the
   *  element has element children with `id`. */
  children?: BlockOutline[];
}

/** Listing options passed to `list_blocks` (handler validates). */
export interface ListBlocksOptions {
  /** 0 → top-level only (children of <body>); omitted → full tree. */
  depth?: number;
  /** Optional narrowing filter. `id` narrows to subtree rooted at that
   *  id; `tag` filters to elements matching that tag (case-insensitive). */
  filter?: { id?: string; tag?: string };
  /** When true, include each outline node's `outerHTML` as `content`. */
  includeContent?: boolean;
}
