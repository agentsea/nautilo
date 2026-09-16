/**
 * D121-P4 / D087-P2B — block-edit substrate barrel export.
 *
 * Public surface consumed by `workspace-commands.ts` (the workspace-
 * zone dispatcher). Internal parser/serializer helpers live in
 * `./parser` and are imported directly by `./commands`; they are
 * NOT re-exported here because they have no consumers outside the
 * `blocks/` directory. Adding them to the barrel just to satisfy
 * "public API completeness" trips knip and rots; keep the barrel
 * to actually-consumed surface only.
 */

export type {
  Anchor,
  BlockOp,
  BlockOutline,
  ListBlocksOptions,
  ReplaceTarget,
  RewriteScope,
} from "./types";

export {
  handleInsertBlock,
  handleListBlocks,
  handleMoveBlock,
  handleReadBlock,
  handleReplaceBlock,
  handleRewriteBlock,
} from "./commands";
