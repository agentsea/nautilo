/**
 * M067D Phase 3 — shared constants for the `file` tool dispatch matrix
 * and the guard that partitions schema commands vs integration coverage.
 */

import type { FileToolCommand } from "../src/tools/file/schema";

/** Ten D079 path/zone commands exercised by `file-tool-matrix.test.ts`. */
export const FILE_TOOL_MATRIX_COVERED_COMMANDS = [
  "list",
  "read",
  "stat",
  "write",
  "insert",
  "str_replace",
  "move",
  "copy",
  "delete",
] as const satisfies readonly FileToolCommand[];

/**
 * Native commands covered by the D446 Workspace projection and typed Desktop
 * relay matrices. They intentionally do not enter the legacy direct-FS
 * dispatcher, but they are first-class covered commands rather than schema
 * exclusions.
 */
export const FILE_TOOL_NATIVE_SEARCH_MATRIX_COMMANDS = [
  "glob",
  "grep",
] as const satisfies readonly FileToolCommand[];

/**
 * Commands validated elsewhere (staged-patch / history / office
 * integration or unit suites). Every `FileToolCommand` must appear in
 * either this set or `FILE_TOOL_MATRIX_COVERED_COMMANDS`, never both.
 */
export const FILE_TOOL_MATRIX_EXCLUDED_FROM_MATRIX = [
  "undo",
  "undo_turn",
  "redo",
  "list_revisions",
  "pin_revision",
  "unpin_revision",
  // D121-P4 / D087-P2B — block-edit commands. Workspace-zone only;
  // exercised by `packages/agent/tests/unit/blocks/` (parser
  // round-trip + per-command handler tests). Not part of the
  // D079 ten-command path/zone matrix because they don't compose
  // with the FS-zone behavior — they go through the workspace
  // dispatcher path that resolves the artifact DB row first.
  "list_blocks",
  "read_block",
  "replace_block",
  "insert_block",
  "move_block",
  "rewrite_block",
] as const satisfies readonly FileToolCommand[];
