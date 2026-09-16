/**
 * Severity resolver — fuses tool-level `impact` (from @nautilo/catalog) and
 * runtime command severity (from @nautilo/security's scanCommand) into a
 * single `CombinedSeverity`, then maps it (with `SecurityLevel`) to a verb.
 *
 * Combines the declared tool impact and scanner evidence into the
 * severity used by the approval boundary.
 */

import type { ToolImpactLevel } from "@nautilo/types";
import type { CommandScanResult } from "./command-scanner";
import type { SecurityLevel } from "./security-config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Re-export for downstream consumers that want the D061-relevant impact
 *  alphabet without pulling `@nautilo/types` transitively. This is an
 *  alias, not a new type — same string union as ToolImpactLevel. */
export type ToolImpact = ToolImpactLevel;

/** The fused severity that verb-mapping keys on. */
export type CombinedSeverity =
  | "critical"
  | "destructive-high"
  | "destructive-medium"
  | "destructive-low"
  | "high-impact"
  | "low";

/** The four graduated approval verbs described in D061. */
export type ApprovalVerb = "auto" | "ask" | "prove_it" | "block";

/** M079 — LLM-declared sensitivity for `approvalMode: "hybrid"` tools. */
export type HybridSensitivity = "normal" | "sensitive";

export interface ResolveSeverityInput {
  /** Tool-level impact from `ToolCatalog.getToolPolicy(name).impact`. */
  toolImpact: ToolImpact;
  /** Optional runtime scan result from `scanCommand(cmd, level)`.
   *  Only set for `run_shell`; undefined for non-shell tools. */
  commandScan?: CommandScanResult;
  /** True when the command's first token is a path to a file Nautilo
   *  did not write. See `external-binary.ts` for the heuristic. */
  isExternalUnknownBinary?: boolean;
  /**
   * Optional tool name — drives user-facing phrasing in
   * `describeReason`. Pass the catalog tool name (e.g. `"file"`,
   * `"run_shell"`, `"web_search"`) so the approval-dock reason line
   * can avoid saying "this action changes files" for a shell command.
   *
   * D087 PR-013 MINOR #7. Optional for back-compat; when omitted the
   * phrasing falls back to the generic "this action…" wording that
   * pre-dated the fix.
   */
  toolName?: string;
  /** M079 — when set, bypasses static impact fusion (hybrid approval path). */
  hybridSensitivity?: HybridSensitivity | undefined;
  /** True when args were missing/invalid; reason copy reflects fail-closed. */
  hybridSensitivityWasInvalid?: boolean | undefined;
}

export interface ResolvedApproval {
  severity: CombinedSeverity;
  verb: ApprovalVerb;
  /** Human-readable explanation, suitable for the approval dialog reason line. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Severity fusion
// ---------------------------------------------------------------------------

/**
 * Fuse tool impact and (optional) command-scanner output into a single
 * `CombinedSeverity`. Scanner output wins when it fired — a shell command
 * that scanned as `critical` is critical regardless of the tool's static
 * impact. Otherwise fall back to the tool's declared impact.
 *
 * Note: the external-binary flag does NOT influence severity — it affects
 * the *verb* only (see `resolveApproval`). That keeps severity pure and
 * auditable independent of the heuristic.
 */
export function resolveSeverity(input: ResolveSeverityInput): CombinedSeverity {
  const scan = input.commandScan;
  if (scan && !scan.allowed && scan.severity) {
    if (scan.severity === "critical") return "critical";
    if (scan.severity === "high") return "destructive-high";
    if (scan.severity === "medium") return "destructive-medium";
  }

  switch (input.toolImpact) {
    case "destructive":
      return "destructive-low";
    case "high":
      return "high-impact";
    case "low":
    case "read-only":
      return "low";
    default: {
      // Defensive fail-closed: an unrecognized impact value (e.g. a future
      // catalog schema change or a corrupted MCP registration) maps to
      // destructive-high so policy decisions err toward friction, never
      // away. TypeScript's exhaustive check means this should never fire
      // at compile time — it exists for runtime-unsafe callers (JSON,
      // schema drift, unknown MCP tools).
      const _exhaustive: never = input.toolImpact;
      void _exhaustive;
      return "destructive-high";
    }
  }
}

// ---------------------------------------------------------------------------
// Tier → verb map (§unified tier map in the issue)
// ---------------------------------------------------------------------------

const VERB_MAP: Record<CombinedSeverity, Record<SecurityLevel, ApprovalVerb>> = {
  // critical never reaches any approval path — instant-loss patterns
  // (fork bomb, disk wipe, rm -rf /) block even at yolo so nobody gets
  // an unrecoverable mistake on a "trust me" flag.
  critical:             { yolo: "block",    permissive: "block",    standard: "block",    cautious: "block",    paranoid: "block" },
  "destructive-high":   { yolo: "auto",     permissive: "ask",      standard: "prove_it", cautious: "prove_it", paranoid: "prove_it" },
  "destructive-medium": { yolo: "auto",     permissive: "ask",      standard: "ask",      cautious: "ask",      paranoid: "prove_it" },
  "destructive-low":    { yolo: "auto",     permissive: "auto",     standard: "ask",      cautious: "ask",      paranoid: "ask" },
  "high-impact":        { yolo: "auto",     permissive: "auto",     standard: "auto",     cautious: "ask",      paranoid: "ask" },
  low:                  { yolo: "auto",     permissive: "auto",     standard: "auto",     cautious: "auto",     paranoid: "auto" },
};

/** Table lookup — pure. */
export function resolveVerb(severity: CombinedSeverity, level: SecurityLevel): ApprovalVerb {
  return VERB_MAP[severity][level];
}

/**
 * M079 — runtime-safe normalization for hybrid `sensitivity`.
 * Only `"normal"` and `"sensitive"` are valid; anything else fails closed to
 * `"sensitive"` (matches ISSUE-M079 §Requirements item 4).
 */
export function coerceHybridSensitivity(raw: unknown): {
  value: HybridSensitivity;
  wasInvalid: boolean;
} {
  if (raw === "normal" || raw === "sensitive") {
    return { value: raw, wasInvalid: false };
  }
  return { value: "sensitive", wasInvalid: true };
}

/** M079 — hybrid tool verb from LLM `sensitivity` × security level. */
export function resolveHybridVerb(sensitivity: unknown, level: SecurityLevel): ApprovalVerb {
  const { value } = coerceHybridSensitivity(sensitivity);
  if (level === "yolo") return "auto";
  return value === "sensitive" ? "prove_it" : "ask";
}

// ---------------------------------------------------------------------------
// Combined entry point
// ---------------------------------------------------------------------------

function describeHybridReason(
  input: ResolveSeverityInput,
  sensitivity: HybridSensitivity,
  verb: ApprovalVerb,
  sensitivityInvalid: boolean,
): string {
  const action = input.toolName ? `tool ${input.toolName}` : "hybrid action";
  const prefix = sensitivityInvalid
    ? `missing or invalid sensitivity for ${action}; treated as sensitive`
    : `LLM marked ${action} as ${sensitivity}`;
  const verbNote =
    verb === "prove_it" ? "requires PIN" :
    verb === "ask" ? "needs approval" :
    verb === "auto" ? "auto-approved" :
    "blocked";
  return `${prefix} — ${verbNote}`;
}

/**
 * The single entry post_model will call in Phase 2. Returns severity, verb,
 * and a short human-readable reason suitable for the dialog's "why this is
 * gated" line.
 *
 * External-binary policy: forces the verb to at least `ask`. Never
 * downgrades an already-heavier verb (prove_it / block stay as-is) because
 * attribution is orthogonal to severity — a user who just needs to say
 * "yes this is mine" is distinct from a user who must prove they're human.
 */
export function resolveApproval(
  input: ResolveSeverityInput,
  level: SecurityLevel,
): ResolvedApproval {
  if (input.hybridSensitivity !== undefined) {
    const coerced = coerceHybridSensitivity(input.hybridSensitivity);
    const sensitivity = coerced.value;
    const sensitivityInvalid =
      coerced.wasInvalid || Boolean(input.hybridSensitivityWasInvalid);
    const verb = resolveHybridVerb(sensitivity, level);
    const severity: CombinedSeverity =
      sensitivity === "sensitive" ? "destructive-high" : "destructive-low";
    return {
      severity,
      verb,
      reason: describeHybridReason(input, sensitivity, verb, sensitivityInvalid),
    };
  }

  const severity = resolveSeverity(input);
  let verb = resolveVerb(severity, level);

  if (input.isExternalUnknownBinary && verb === "auto") {
    verb = "ask";
  }

  return { severity, verb, reason: describeReason(input, severity, verb) };
}

function describeReason(
  input: ResolveSeverityInput,
  _severity: CombinedSeverity,
  verb: ApprovalVerb,
): string {
  const parts: string[] = [];

  if (input.commandScan && !input.commandScan.allowed && input.commandScan.matchedPatterns.length > 0) {
    const top = input.commandScan.matchedPatterns[0]!;
    parts.push(top.description);
  } else {
    // Impact and severity remain internal routing inputs. They are not a
    // truthful user-facing description of an individual invocation: `pwd`
    // does not change the system, and entering a private context is not a
    // destructive mutation. Keep the copy static and narrow; the concrete
    // tool-call preview below the reason shows the proposed action.
    parts.push(
      input.toolName === "run_shell"
        ? "Shell execution"
        : input.toolName === "in_private_namespace"
          ? "Starting work in a private context"
          : "This tool",
    );
  }

  if (input.isExternalUnknownBinary) {
    parts.push("running an external script Nautilo did not create or install");
  }

  const verbNote =
    verb === "block"    ? "blocked" :
    verb === "prove_it" ? "requires PIN" :
    verb === "ask"      ? "needs approval" :
    "auto-approved";

  return `${parts.join("; ")} — ${verbNote}`;
}
