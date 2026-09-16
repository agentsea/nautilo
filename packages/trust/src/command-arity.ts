/**
 * M037 — per-tool arity declaration for the command-approval classifier.
 *
 * Sibling of `tool-policies.ts` / `file-tool-policies.ts`. This is the
 * ONLY thing a tool author touches to widen how `room`/`always` standing
 * approvals generalize a tool call. Anything undeclared defaults to
 * `opaque` (exact match) — new tools are safe-by-default.
 *
 * Generalization strategy is chosen per slot-kind (see
 * `command-approvals.ts` for the classifier that consumes this):
 *
 * | Slot kind       | Strategy                                   | Match     |
 * |-----------------|--------------------------------------------|-----------|
 * | `discriminator` | keep literal (defines arity)               | equality  |
 * | `path`          | → parent directory `<directory:…>`         | prefix    |
 * | `directory`     | → directory prefix                         | prefix    |
 * | `shell_command` | tokenize: verb-chain head literal, rest    | per-token |
 * | `amount`        | (future) threshold ≤ X; interim: opaque    | equality  |
 * | `opaque`        | no generalization                          | equality  |
 *
 * See ISSUE-M037 "Locked design decisions (2026-06-03)".
 */

export type SlotKind =
  | "discriminator"
  | "path"
  | "directory"
  | "shell_command"
  | "amount"
  | "opaque";

export interface ToolArity {
  /** Param → slot kind. Undeclared params are `opaque`. */
  params: Record<string, SlotKind>;
}

/**
 * Declared tool arities. Everything not listed here (and every param not
 * listed under a declared tool) defaults to `opaque` → exact match.
 */
export const TOOL_ARITY: Record<string, ToolArity> = {
  run_shell: { params: { command: "shell_command" } },
  file: { params: { command: "discriminator", path: "path" } },
  // …declare more over time; everything else is opaque (exact match).
};

/**
 * Resolve the slot kind for a tool param. Undeclared tools and undeclared
 * params both default to `opaque` — the safe-by-default contract.
 */
export function slotKindFor(toolName: string, param: string): SlotKind {
  return TOOL_ARITY[toolName]?.params[param] ?? "opaque";
}
