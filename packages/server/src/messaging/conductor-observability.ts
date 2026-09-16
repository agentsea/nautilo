/**
 * D421 Phase 3 (3.1 / 3.2) — safe Conductor observability helpers.
 *
 * Two concerns live here, both enforcing the same privacy boundary: the
 * always-on `[conductor]` decision log and the requester-private
 * `conductor.decision` receipt must carry ONLY controlled counts/booleans/
 * enums + a server-authored reason code. Validated public roster handles are
 * attached separately by the Phase 4 producer via `selectedHandles`.
 * Raw user content, transcript snippets, the raw search query, raw Floor
 * Manager / provider error text, and any future redirect tool reason never
 * cross this boundary.
 *
 * This module is pure (no I/O, no bus, no DB). Phase 4's redirect producer
 * will call {@link classifyRedirectDecision}; {@link sanitizeRoutingTrace}
 * is consumed by the dispatch-side decision log.
 */
import type { SafeDecisionOutcome } from "../realtime/ws-publisher";

/**
 * D421 Phase 3 (3.2.1) — controlled redirect outcome codes the Phase 4
 * producer passes to {@link classifyRedirectDecision}. This is the ONLY
 * input surface for redirect receipts: there is intentionally NO raw
 * `reason` argument. The producer maps its internal gate results to one of
 * these controlled codes; the classifier then maps to a wire
 * `ConductorDecisionReasonCode` + a server-authored display sentence.
 *
 * Vocabulary (Phase 0 §0.2.4 + Phase 3 §3.1.2):
 *   - `accepted`            → `redirected` (wake; the one-hop redirect fired)
 *   - `explicit_selection`  → rejected (turn was a UI pick)
 *   - `visible_output`      → rejected (assistant had already emitted tokens)
 *   - `duplicate`          → rejected (turn already redirected; depth exhausted)
 *   - `unknown_target`     → rejected (handle matched no roster agent)
 *   - `ineligible_target`   → rejected (target not eligible to take over)
 *   - `self_target`         → rejected (target === source)
 *   - `enqueue_failed`      → error (target enqueue rejected)
 */
export type RedirectOutcomeCode =
  | "accepted"
  | "explicit_selection"
  | "visible_output"
  | "duplicate"
  | "unknown_target"
  | "ineligible_target"
  | "self_target"
  | "enqueue_failed";

/**
 * D421 Phase 3 (3.2.1) — map a controlled redirect outcome code to a
 * privacy-safe requester receipt outcome + reason code + display reason.
 *
 * Pure: accepts ONLY the controlled code — no raw reason, handle, or other
 * caller-provided text — and performs no I/O. The display reason is entirely
 * server-authored and stable. Phase 4 attaches the canonically validated public
 * target handle separately through the receipt's existing `selectedHandles`
 * field after roster resolution. Reuse the existing
 * `outcome: wake|silent|ask_user|error` vocabulary — accepted is `wake`,
 * rejections are `silent`, enqueue failure is `error` — so no new outcome
 * variant is added.
 */
export function classifyRedirectDecision(
  code: RedirectOutcomeCode,
): SafeDecisionOutcome {
  switch (code) {
    case "accepted":
      return {
        outcome: "wake",
        reasonCode: "redirected",
        displayReason: "Redirected to another assistant.",
      };
    case "explicit_selection":
      return {
        outcome: "silent",
        reasonCode: "redirect_rejected_explicitly_selected",
        displayReason: "Redirect skipped — you explicitly selected this assistant.",
      };
    case "visible_output":
      return {
        outcome: "silent",
        reasonCode: "redirect_rejected_visible_output",
        displayReason: "Redirect skipped — this assistant had already started replying.",
      };
    case "duplicate":
      return {
        outcome: "silent",
        reasonCode: "redirect_rejected_duplicate",
        displayReason: "Redirect skipped — this turn was already redirected.",
      };
    case "unknown_target":
      return {
        outcome: "silent",
        reasonCode: "redirect_rejected_no_target",
        displayReason: "Redirect skipped — that assistant wasn't found in this room.",
      };
    case "ineligible_target":
      return {
        outcome: "silent",
        reasonCode: "redirect_rejected_ineligible_target",
        displayReason: "Redirect skipped — that assistant isn't eligible to take over here.",
      };
    case "self_target":
      return {
        outcome: "silent",
        reasonCode: "redirect_rejected_same_source",
        displayReason: "Redirect skipped — an assistant can't redirect to itself.",
      };
    case "enqueue_failed":
      return {
        outcome: "error",
        reasonCode: "redirect_rejected_enqueue_failed",
        displayReason: "Redirect failed — couldn't enqueue the target assistant.",
      };
  }
}

/**
 * D421 Phase 3 audit correction — explicit structural allowlists for the
 * always-on trace boundary. Unknown steps are dropped in full. Within a known
 * step, values survive only when BOTH their key and type/value are allowlisted.
 * This prevents a future scalar `messageId: 101` (or user-derived step name)
 * from crossing the boundary merely because it happens to be numeric/string.
 */
const SAFE_TRACE_STEPS: ReadonlySet<string> = new Set([
  "filters",
  "explicit",
  "human-mention",
  "human-vocative",
  "direct-address",
  "active-focus",
  "history",
  "floor-manager",
  "routing-packet",
  "addressivity",
  "history-baseline",
  "coalesced-burst",
  "redirect",
]);

const SAFE_NUMERIC_KEYS: ReadonlySet<string> = new Set([
  "candidates",
  "coldVolunteer",
  "count",
  "matches",
  "active",
  "hits",
  "rawHits",
  "presence",
  "replyTargets",
  "tempo",
  "recentCounterparts",
  "score",
  "threshold",
]);

const SAFE_BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  "structural",
  "owner",
  "invoked",
  "failed",
  "bought",
  "failOpen",
]);

const SAFE_SIGNAL_KEYS: ReadonlySet<string> = new Set([
  "interrogativity",
  "directed",
  "relationalRecency",
]);

const SAFE_STRING_ENUMS: Readonly<Record<string, ReadonlySet<string>>> = {
  source: new Set(["mention", "reply", "ui", "inferred"]),
  intent: new Set([
    "who-talking-about",
    "what-decide-about",
    "where-discussing",
  ]),
  gated: new Set([
    "no structural signal or intent",
    "no searchRoomHistory dep",
  ]),
  code: new Set<RedirectOutcomeCode>([
    "accepted",
    "explicit_selection",
    "visible_output",
    "duplicate",
    "unknown_target",
    "ineligible_target",
    "self_target",
    "enqueue_failed",
  ]),
};

function sanitizeSignals(value: unknown): Record<string, number> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (
      SAFE_SIGNAL_KEYS.has(key) &&
      typeof candidate === "number" &&
      Number.isFinite(candidate)
    ) {
      out[key] = candidate;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeTraceDetail(
  step: string,
  detail: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (
      SAFE_NUMERIC_KEYS.has(key) &&
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      out[key] = value;
      continue;
    }
    if (SAFE_BOOLEAN_KEYS.has(key) && typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    const allowedStrings = SAFE_STRING_ENUMS[key];
    if (
      allowedStrings !== undefined &&
      (key !== "code" || step === "redirect") &&
      typeof value === "string" &&
      allowedStrings.has(value)
    ) {
      out[key] = value;
      continue;
    }
    if (key === "signals") {
      const signals = sanitizeSignals(value);
      if (signals !== undefined) out["signals"] = signals;
    }
  }
  return out;
}

/**
 * D421 Phase 3 (3.1.1/3.1.3) — reduce a routing trace to counts/booleans/enums
 * for the always-on `[conductor]` decision log.
 *
 * Only allowlisted step names survive. Detail fields require an allowlisted
 * key plus the expected primitive type/controlled value; nested `signals`
 * retains only the three known numeric signal keys. Everything else is
 * dropped, including scalar numeric ids, arrays, handles, display names,
 * queries, snippets, errors, and raw reasons.
 */
export function sanitizeRoutingTrace(
  trace: ReadonlyArray<{ step: string; detail: Record<string, unknown> }>,
): Array<{ step: string; detail: Record<string, unknown> }> {
  return trace
    .filter((entry) => SAFE_TRACE_STEPS.has(entry.step))
    .map((entry) => ({
      step: entry.step,
      detail: sanitizeTraceDetail(entry.step, entry.detail),
    }));
}
