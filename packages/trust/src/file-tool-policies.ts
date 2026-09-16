/**
 * D079 Phase 4 / G2 — per-command trust policies for the unified
 * `file` tool.
 *
 * The `file` tool (D079 Phase 4) dispatches to 10 commands (+6 block
 * commands at D081 maturity). Each command has a distinct
 * destructive-vs-read-only posture, so the `file` tool can't be
 * policied as a single tool-level entry the way existing tools are.
 *
 * This module holds:
 *   - `FILE_COMMAND_POLICIES` — the authoritative per-command table
 *   - `resolveFileCommandPolicy(command)` — lookup helper
 *   - `isDestructiveFileCommand(command)` — predicate for HIL gating
 *   - `listFileCommandNames()` — introspection for tests + the
 *     runtime tool registry validator
 *
 * Ship-time (G3 commits) the `file` tool handler looks up the
 * command's policy here, and the approval dock (G4 commit 11)
 * displays `file.<command>` as the composite verb.
 *
 * Deliberately in `@nautilo/trust` (not `@nautilo/catalog`) because
 * the catalog's `ToolCatalogEntry` is per-tool, and retrofitting a
 * per-command sub-table into the catalog's shape would widen the
 * entry type for a single tool's benefit. Keeping it here isolates
 * the complexity to the one place it applies.
 *
 * Decision record anchor:
 *   pr-reviews/DECISION-2026-04-21-file-tool-shape.md (§Command matrix,
 *   §Costs we accept → "Per-command trust policy layer")
 *
 * H-025 heuristic applies: tool names describe MECHANISM; unified
 * command-dispatch for destructive/edit clusters when extension
 * horizon justifies.
 */

/**
 * Severity buckets for `file` command policies.
 *
 *   read_only       — parallel-safe; no disk mutation.
 *   destructive_low — mutates but non-destructive to source
 *                     (e.g. copy). HIL outside workspace.
 *   destructive     — mutates; single-file impact. HIL outside
 *                     workspace.
 *   destructive_high — high blast radius (recursive delete).
 *                     HIL always, including inside workspace.
 *
 * These buckets are file-tool-specific. Mapping to the existing
 * `ToolImpactLevel` (read-only / low / high / destructive) happens
 * at the HIL routing layer in `@nautilo/agent` — this enum is the
 * unit of truth for the `file` tool's approval posture.
 */
export type FileCommandSeverity =
  | "read_only"
  | "destructive_low"
  | "destructive"
  | "destructive_high";

/**
 * All commands shipping on the `file` tool in D079 Phase 4.
 *
 * Commands added later (D081's 6 block commands, future sheet /
 * notebook commands) extend this union inline; their policies land
 * as new rows in FILE_COMMAND_POLICIES when their trigger conditions
 * fire. Non-breaking extension contract from the decision record.
 */
export type FileCommandName =
  // Read (non-destructive, parallel-safe)
  | "list"
  | "read"
  | "glob"
  | "grep"
  | "stat"
  // Write / Edit (destructive; HIL-gated outside workspace)
  | "write"
  | "insert"
  | "str_replace"
  | "move"
  | "copy"
  | "delete"
  // D087 Phase 1 §1.3.5 — move / copy / delete apply immediately.
  // reverse-diff patches; the DiffView Accept click(s) are the real
  // HIL gate, same as the other staging-layer entries below.
  | "undo"
  | "undo_turn"
  | "redo"
  // D087 Phase 3 §3.4 — read-only enumeration. Pure SELECT; no
  // disk, no staging. Safe to call mid-turn without approval.
  | "list_revisions"
  // D087 Phase 3 §3.5 — metadata-only flag toggle (GC exemption).
  // Neither touches disk nor stages a patch. Read-only at the
  // approval-dock layer.
  | "pin_revision"
  | "unpin_revision"
  | "write_xlsx"
  | "write_pptx"
  // D121-P6 — block-edit commands (workspace-only HTML5 + <nw-*>
  // artifacts). `list_blocks` / `read_block` are read-only tree reads;
  // the four mutators apply immediately and are revertable (M162). All
  // are read_only at the approval dock — same posture as write /
  // str_replace. Without these rows they fell through to the
  // `destructive_high` fail-closed default and popped an approval
  // prompt on every call, including the read-only reads.
  | "list_blocks"
  | "read_block"
  | "replace_block"
  | "insert_block"
  | "move_block"
  | "rewrite_block";

/**
 * Authoritative per-command policy table.
 *
 * Source of truth for `file` tool's severity decisions. Callers
 * MUST go through `resolveFileCommandPolicy()` rather than reading
 * this table directly — the helper enforces the unknown-command
 * fail-closed default (treat as destructive; never silently allow).
 */
const FILE_COMMAND_POLICIES: Record<FileCommandName, FileCommandSeverity> = {
  list: "read_only",
  read: "read_only",
  glob: "read_only",
  grep: "read_only",
  stat: "read_only",
  // D087 Phase 1 §1.3 — write/insert/str_replace are STAGING commands.
  // They do not mutate disk at call time; they produce a staged patch
  // that the workbench DiffView presents with Accept / Reject buttons.
  //
  // SECURITY NOTE — this classification is an approval-dock UX
  // optimization, NOT a defense-in-depth layer. The actual gate that
  // keeps forbidden-envelope actors (guests, restricted household
  // members) from reaching the staging path is the upstream catalog
  // filter at `packages/catalog/src/tool-catalog.ts::getFiltered`,
  // which drops every tool entry whose `toolPolicy[name] === "forbidden"`
  // before the LLM ever sees it. If you add a caller that bypasses
  // that filter — a server-side sub-graph, an MCP stdio surface, a
  // direct-invoke API — you MUST re-apply the forbidden check there.
  //
  // Classified as read_only here so the approval dock doesn't
  // double-gate after the DiffView click; the actual disk write runs
  // through apply_patch under the external-change hash guard.
  write: "read_only",
  insert: "read_only",
  str_replace: "read_only",
  // D087 Phase 1 §1.3.5 — move / copy / delete all flow through the
  // staged-patch substrate now. Same caveat as write/insert/str_replace
  // above: read_only here is an approval-dock UX optimization, not a
  // security boundary. The catalog filter is the gate.
  //
  // The delete case especially benefits from the UX change — the old
  // `destructive_high` posture popped an approval dock even inside
  // the workspace, which the staging flow now replaces with a
  // Reject-friendly preview of what's about to disappear.
  move: "read_only",
  copy: "read_only",
  delete: "read_only",
  // D087 Phase 3 §3.1 — undo STAGES a reverse-diff patch. Same
  // rationale as write/str_replace/delete above: the staging call
  // itself doesn't touch disk; the DiffView Accept is the real HIL
  // gate. Read-only classification here keeps the approval dock
  // from double-gating after the user clicks Accept on the undo's
  // DiffView preview. The overridden write posture from the doc
  // (§3.1.3 called for destructive_low) is reconciled with the
  // phase-1 decision-record convention here — staging is staging,
  // regardless of the semantic (forward edit vs. backward restore).
  undo: "read_only",
  // D087 Phase 3 §3.2 — `undo_turn` is a BATCH of undo stages.
  // Same reasoning: each DiffView Accept is the per-file gate, and
  // the Accept-all batch flow already exists for normal multi-file
  // turns. One classification for the whole batch.
  undo_turn: "read_only",
  // D087 Phase 3 §3.3 — `redo` shares the undo staging pipeline,
  // just with a different revision-selection rule. Same policy.
  redo: "read_only",
  // D087 Phase 3 §3.4 — pure SELECT over file_revisions. No
  // side effects at all. read_only is the honest classification.
  list_revisions: "read_only",
  // D087 Phase 3 §3.5 — single-column UPDATE on file_revisions.
  // The row's `pinned` flag only affects GC eviction; no disk,
  // no staged patch. read_only for approval-dock purposes —
  // pinning isn't "destructive" in any meaningful sense.
  pin_revision: "read_only",
  unpin_revision: "read_only",
  write_xlsx: "read_only",
  write_pptx: "read_only",
  // D121-P6 / M162 — block-edit commands. Workspace-only; the real
  // authorization boundary is the catalog `forbidden` filter +
  // namespace-gated envelope, NOT this table (see the SECURITY NOTE
  // above). `list_blocks` / `read_block` are genuine reads; the four
  // mutators apply immediately and are revertable, so read_only here
  // matches the M162 no-pre-write-prompt model (ISSUE-M162 §7). These
  // rows close the gap where block commands fell through to the
  // `destructive_high` fail-closed default and gated on every call.
  list_blocks: "read_only",
  read_block: "read_only",
  replace_block: "read_only",
  insert_block: "read_only",
  move_block: "read_only",
  rewrite_block: "read_only",
};

/**
 * Look up the severity for a `file` command. Unknown commands
 * default to `destructive_high` — the fail-closed choice. A typo'd
 * command string should never sneak past the approval dock; better
 * to over-gate and surface a clear error than to under-gate and
 * silently execute.
 *
 * Callers passing arbitrary string input (e.g. from LLM tool calls
 * before Zod validation) should still get a meaningful policy
 * rather than an exception. The Zod schema is a separate layer.
 */
export function resolveFileCommandPolicy(
  command: string | null | undefined,
): FileCommandSeverity {
  if (typeof command !== "string") return "destructive_high";
  const entry = (FILE_COMMAND_POLICIES as Record<string, FileCommandSeverity>)[command];
  return entry ?? "destructive_high";
}

/**
 * Predicate used by the HIL layer to decide whether a command
 * needs approval. Any non-`read_only` severity is destructive.
 * `recursive` delete is flagged separately at the command handler
 * level — this predicate answers "does the category require HIL?"
 * not "exactly which HIL bucket?".
 */
export function isDestructiveFileCommand(
  command: string | null | undefined,
): boolean {
  return resolveFileCommandPolicy(command) !== "read_only";
}

/**
 * Return the list of all known `file` command names — for
 * introspection in tests and the runtime tool registry validator.
 * Order matches the declaration order in FILE_COMMAND_POLICIES.
 */
export function listFileCommandNames(): FileCommandName[] {
  return Object.keys(FILE_COMMAND_POLICIES) as FileCommandName[];
}

/**
 * Helper for the approval dock (G4 commit 11) — construct the
 * composite verb string `file.<command>` when rendering approval
 * prompts for `file` tool calls. Falls back to bare `toolName` for
 * all other tools. Centralized here so the dock and any future
 * approval-surface consumer use the same format.
 *
 * Per the decision record's "Approval-dock display" mitigation:
 * "dock displays `file.<command>` (e.g. `file.str_replace`), not
 * bare `file`. Cosmetic fix, high-value."
 */
export function formatFileToolVerb(
  toolName: string,
  toolArgs: Record<string, unknown> | null | undefined,
): string {
  if (toolName !== "file") return toolName;
  const command =
    toolArgs && typeof toolArgs["command"] === "string"
      ? (toolArgs["command"])
      : null;
  return command ? `${toolName}.${command}` : toolName;
}
