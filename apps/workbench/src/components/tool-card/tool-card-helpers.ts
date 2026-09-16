/**
 * D083 Phase 1 — pure helpers for the inline ToolCard primitive.
 *
 * Everything that's a function of tool state (not of React
 * lifecycle) lives here so the unit test surface stays clean —
 * no jsdom, no testing-library, no framework coupling. The
 * React component imports from this module.
 */

import type { ToolActivityEvent } from "../../adapters/runtime-contexts";

/**
 * Full card state vocabulary per ISSUE-D083. Five states ordered
 * by lifecycle: pending → running → one of {success, error, blocked}.
 *
 * `pending` and `blocked` don't exist in the current
 * `ToolActivityEvent.status` vocabulary (`running | ok | error`);
 * they're here so the component can render them when upstream
 * starts emitting those (Phase 3 streaming, pre-execution
 * security blocks) without a type-level rewrite.
 */
export type ToolCardState =
  | "unknown"
  | "pending"
  | "running"
  | "paused"
  | "awaiting"
  | "success"
  | "cancelled"
  | "error"
  | "blocked";

/**
 * Assistant-UI's tool-call status shape. We only inspect the
 * `type` field; the rest varies by framework release.
 */
export interface AssistantUiToolStatus {
  type: string;
}

export interface DeriveStateInput {
  /** Assistant-UI status (source of truth for "is this still in flight"). */
  uiStatus: AssistantUiToolStatus;
  /** Optional matching ToolActivityEvent (from useToolActivity). */
  event?: ToolActivityEvent;
  /** Framework's isError hint. */
  isError?: boolean;
  /** Raw result body. Sniffed as a last-resort fallback when the tool
   *  handler returned an error-shaped string but the upstream lifecycle
   *  signals never flipped to "error" (happens for tools that return
   *  error strings rather than throwing — e.g. `file.apply_patch`
   *  returning "Error: patchId not found"). */
  resultText?: string;
}

/**
 * Merge the assistant-ui status + WS-backed ToolActivityEvent into
 * a single card state.
 *
 * Priority (highest wins):
 *   1. event.status === "error"   → "error"
 *   2. isError === true           → "error"
 *   3. resultText is a canonical cancelled result → "cancelled"
 *   4. resultText looks like an error body → "error"
 *   5. event.status === "ok"      → "success"
 *   6. event.status === "running" → "running"
 *   7. uiStatus.type === "complete" → "success"
 *   8. other in-flight UI state   → "running"
 *   9. default                    → "pending"
 */
export function deriveCardState(input: DeriveStateInput): ToolCardState {
  const { uiStatus, event, isError, resultText } = input;

  if (event?.status === "error" || isError === true) return "error";
  if (typeof resultText === "string" && looksLikeCancelledResult(resultText)) {
    return "cancelled";
  }
  if (typeof resultText === "string" && looksLikeErrorBody(resultText)) return "error";
  if (event?.status === "ok") return "success";
  // A graph leg may complete while a tool is parked for Human review. The
  // WS-backed activity remains canonical until its matching tool.end arrives.
  if (event?.status === "running") return "running";
  if (uiStatus.type === "complete") return "success";
  if (uiStatus.type === "running" || uiStatus.type === "requires-action") {
    return "running";
  }
  return "pending";
}

/** A completed transport can still carry a canonical cancelled command result. */
function looksLikeCancelledResult(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Boolean(
      parsed &&
        typeof parsed === "object" &&
        "cancelled" in parsed &&
        parsed.cancelled === true,
    );
  } catch {
    return false;
  }
}

/**
 * Heuristic: does a tool-result string look like an error body rather
 * than a success message?
 *
 * We intentionally use string-sniffing as a fallback instead of forcing
 * every tool handler to return structured JSON. The vocabulary is tight
 * on purpose — "Error:" is the ONLY accepted prefix from Nautilo-authored
 * tools, matching the convention in packages/agent/src/tools/**. JSON
 * envelopes with `{"ok": false, ...}` are also recognized because the
 * staged-patch / apply-patch paths emit those shapes.
 *
 * False positives would just flip a legitimately-successful card to red,
 * which is less bad than the inverse (silent failures rendering as ✓).
 */
function looksLikeErrorBody(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.length === 0) return false;
  if (/^Error:/i.test(trimmed)) return true;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && "ok" in parsed && parsed.ok === false) {
        return true;
      }
    } catch {
      // Not valid JSON — not an error envelope. Fall through.
    }
  }
  return false;
}

/**
 * Map a card state to its glyph. Unicode only so the component has
 * zero icon-font dependency. Matches the ASCII-art chart in the
 * D083 issue doc.
 *
 * Note: when `state === "running"`, the visual is rendered as an
 * animated <RunningSpinner/> in tool-card.tsx (see shouldRenderSpinner).
 * The "●" returned here is the screen-reader / non-React fallback.
 */
export function glyphFor(state: ToolCardState): string {
  switch (state) {
    case "unknown":
      return "?";
    case "pending":
      return "◌";
    case "running":
      return "●";
    case "paused":
      return "Ⅱ";
    case "awaiting":
      return "◷";
    case "success":
      return "✓";
    case "cancelled":
      return "■";
    case "error":
      return "✗";
    case "blocked":
      return "⊘";
  }
}

/**
 * D113A Defect 3 — does this state get an animated spinner instead of
 * a static glyph? Single source of truth so the component swap and any
 * future renderer (e.g. a status sidebar) stay in lock-step.
 *
 * Today only `running` opts in: it's the only state where the user
 * needs a "still working" affordance. Others use the static glyph from
 * `glyphFor`.
 */
export function shouldRenderSpinner(state: ToolCardState): boolean {
  return state === "running";
}

/**
 * Human-readable state label — used in aria-label + screen-reader
 * announcements so users-with-screen-readers get the same state
 * information the glyph communicates visually.
 */
export function stateLabelFor(state: ToolCardState): string {
  switch (state) {
    case "unknown":
      return "outcome unavailable";
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "awaiting":
      return "awaiting reply";
    case "success":
      return "succeeded";
    case "cancelled":
      return "cancelled";
    case "error":
      return "errored";
    case "blocked":
      return "blocked";
  }
}

/**
 * Duration formatter — tuned for the Cursor-style inline-card UX.
 *
 * - < 1000ms → "350ms"
 * - 1–60s   → "2.3s"
 * - ≥ 60s   → "1m 30s"  (whole seconds only at the minute boundary)
 *
 * Returns "" when endedAt is not yet available AND elapsed is the
 * caller's responsibility (component does its own 1Hz tick during
 * running state).
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    const secs = ms / 1000;
    // one decimal for clarity; 2.0s → "2s" to avoid dangling zero
    const rounded = Math.round(secs * 10) / 10;
    return rounded % 1 === 0 ? `${rounded.toFixed(0)}s` : `${rounded.toFixed(1)}s`;
  }
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const remSecs = totalSecs % 60;
  return `${mins}m ${remSecs}s`;
}

/**
 * Compute the duration to display, given the event (if any) and
 * the current wall-clock time. For running cards, callers pass
 * `now` from a 1Hz tick so the displayed time ticks up live.
 */
export function computeElapsedMs(
  event: ToolActivityEvent | undefined,
  now: number,
  state: ToolCardState,
): number | null {
  if (!event) return null;
  if (state === "pending") return null;
  if (event.endedAt) return event.endedAt - event.startedAt;
  if (state === "running") return now - event.startedAt;
  return null;
}

/**
 * One-liner args summary for the collapsed card — e.g.
 * `run_shell(brew install jq)`. Prefers a commonly-significant
 * field per tool; falls back to the first string-valued arg
 * truncated. Matches the "collapsed" sample in ISSUE-D083 §
 * "Canonical shape".
 *
 * Phase 1 ships the generic fallback only (it's a PRIMITIVE, not
 * a per-tool specialization). Phase 2 will replace per-tool
 * (run_shell → `$ cmd`, read_file → `path:lines`, etc.).
 */
const ARG_PREFERENCE: readonly string[] = [
  // shells / commands
  "command",
  "cmd",
  "script",
  // file ops
  "path",
  "file",
  "filename",
  "target",
  // search / match
  "query",
  "pattern",
  "prompt",
  "url",
  "message",
];

export function argsSummary(args: Record<string, unknown>, maxChars = 60): string {
  const isRedactionMarker = (value: unknown): boolean =>
    value === "[redacted]" || value === "[REDACTED TOOL ARG]";
  for (const key of ARG_PREFERENCE) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0 && !isRedactionMarker(v)) {
      return truncate(v, maxChars);
    }
  }
  // fallback: first string-valued entry
  for (const [, v] of Object.entries(args)) {
    if (typeof v === "string" && v.length > 0 && !isRedactionMarker(v)) {
      return truncate(v, maxChars);
    }
  }
  // fallback: first non-null primitive (number/boolean/bigint/symbol)
  for (const [, v] of Object.entries(args)) {
    if (typeof v === "number" || typeof v === "boolean") {
      return truncate(String(v), maxChars);
    }
    if (typeof v === "bigint") {
      return truncate(String(v), maxChars);
    }
    if (typeof v === "symbol") {
      return truncate(v.description ?? "symbol", maxChars);
    }
  }
  return "";
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

/**
 * Full aria-label for the whole card. Combines tool name + state
 * + summary + duration so a screen reader gets the same
 * information the sighted user picks up at a glance.
 */
export function cardAriaLabel(input: {
  toolName: string;
  state: ToolCardState;
  summary: string;
  durationMs: number | null;
}): string {
  const parts = [
    input.toolName,
    stateLabelFor(input.state),
  ];
  if (input.summary) parts.push(`— ${input.summary}`);
  if (input.durationMs !== null) parts.push(`in ${formatDuration(input.durationMs)}`);
  return parts.join(" ");
}
