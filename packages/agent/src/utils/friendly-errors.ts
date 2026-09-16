/**
 * D141 Phase 1 — Friendly error translator.
 *
 * Public surface for translating raw upstream-provider / agent-side
 * errors into the seven user-visible categories the chat UI is allowed
 * to render. Builds on (does not replace) `classifyError` from
 * `./errors` and `formatProviderError` from `../providers/errors`.
 *
 * Why the layering:
 *
 *   - `classifyError` — eight internal `ErrorCategory` buckets that
 *     drive retry / cooldown / fallback decisions inside
 *     `chat-model-invocation.ts`. Stays as-is. P-13 audit-log
 *     discipline: raw upstream payloads continue to land in
 *     `nautilo-server.log` via the existing
 *     `formatProviderError(error)` log line at the
 *     invocation-loop's catch site. Nothing about that path
 *     changes.
 *
 *   - `toFriendlyError` — collapses the eight internal buckets
 *     into seven user-visible categories with one-line human
 *     sentences. Returns the raw provider blob in
 *     `detailsForLog` so the user-facing surface (workbench
 *     job.status renderer) can offer a "Details" disclosure for
 *     power users without coupling that surface to the SDK
 *     `APIError` shape.
 *
 * Wire-in is at the single user-facing chokepoint:
 * `packages/runtime/src/job.ts`'s `Job.run()` catch block. Every
 * agent-thrown error funnels through that one site on its way to
 * the `job.status: failed` ServerEvent. See ISSUE-D141 for the full
 * design rationale and the four-phase plan.
 */

import { classifyError, type ErrorCategory } from "./errors";
import { formatProviderError } from "../providers/errors";
import {
  isGraphRecursionError,
  DEFAULT_GRAPH_RECURSION_LIMIT,
} from "../graph/execution-policy";
import {
  isNoProgressError,
  toNoProgressOutcomeFromError,
  formatNoProgressLogToken,
  type NoProgressOutcome,
} from "../graph/no-progress";
import { isEmptyTerminalResponseError } from "../graph/empty-terminal-response";

/**
 * User-visible error categories. Deliberately a thinner re-grouping
 * of the internal {@link ErrorCategory} so chat copy stays
 * consistent across providers — the user should see the same
 * sentence whether OpenAI 429 or Anthropic 529 fired.
 *
 * P-7 (cross-boundary discriminated unions): exhaustive set; any
 * error must map to one of these. Adding a new variant is a
 * deliberate cross-boundary decision (translator + workbench
 * renderer + locked-decisions doc).
 */
export type FriendlyErrorCategory =
  | "timeout"
  | "rate_limit"
  | "auth"
  | "bad_request"
  | "context_exceeded"
  | "provider_unavailable"
  | "unknown";

/**
 * Stable provider-error code, 1:1 with {@link FriendlyErrorCategory}.
 *
 * Per ISSUE-D141 §LD-9, every user-visible model/provider error gets a
 * stable code that travels in the bracket-suffixed chat sentence
 * (`"... [MDL003]"`) and as a structured field on the `[nautilo/job]`
 * server-log line. The code is what bridges a reporter's "I saw [MDL003]
 * in chat" report to Claude's first-move `rg "MDL003" server.log`.
 *
 * Adding a new code is a deliberate cross-boundary decision: extend
 * {@link FriendlyErrorCategory} AND {@link CATEGORY_CODES} together. The
 * exhaustiveness check in `mapCategory` plus the `Record<...>` shape on
 * `CATEGORY_CODES` will both fail at typecheck if either side drifts.
 *
 * NOT shipping in this MVP per LD-9's explicit non-goals:
 * `expected`/`actual`/`rule` triplet, `agentSafety` field, factory
 * pattern, repair-id metadata. Re-evaluate at the 4-week gate.
 */
export type MdlCode =
  | "MDL001"
  | "MDL002"
  | "MDL003"
  | "MDL004"
  | "MDL005"
  | "MDL006"
  | "MDL007";

export interface FriendlyError {
  /** One-line human sentence safe to render in the chat bubble. */
  message: string;
  /** Stable category tag for telemetry, tests, and renderer styling. */
  category: FriendlyErrorCategory;
  /**
   * Stable MDL00x code paired 1:1 with {@link category}. The wire-in
   * at `runtime/src/job.ts` brackets this code into the user-visible
   * message (`"... [MDL003]"`) and emits it as a structured token on
   * the server-log line so `rg "MDL003" server.log` lands on every
   * occurrence. See ISSUE-D141 §LD-9.
   */
  code: MdlCode;
  /**
   * Full upstream-provider detail string (status, type, code, param,
   * message, allowlisted headers) extracted by `formatProviderError`.
   * **SERVER-LOG ONLY** in D141-P1.
   *
   * SECURITY: `providers/errors.ts`'s docstring forbids putting this
   * string in any user-facing message because `error.message` can
   * echo prompt content or upstream model output. The runtime's
   * `job.status: failed` WS event is routed by `laneKey: "room:<uuid>"`
   * and broadcast to every member of a multi-user room — putting
   * `detailsForLog` there would cross-user-leak prompt content. So
   * the wire-in at `runtime/src/job.ts` writes this string to
   * `server.log` (via `[nautilo/job]` log line) but NEVER to a WS
   * event. A future user-scoped error-details event (Stack 17 /
   * D141-P3) can carry it to the request originator only. See
   * ISSUE-D141 §"Locked Decisions" LD-8.
   */
  detailsForLog: string;
}

/**
 * Map an internal {@link ErrorCategory} to its user-visible bucket.
 *
 * INVALID_REQUEST is special: capability-mismatch wording (e.g.
 * "model does not support image input") is functionally a
 * "the model can't handle this" failure, not a developer-grade
 * validation error. We still bucket it as `bad_request` for v1 —
 * the message handles disambiguation. If product wants a separate
 * `capability_mismatch` user-visible category later, it's a
 * one-line addition here + a renderer string.
 */
export function mapCategory(internal: ErrorCategory): FriendlyErrorCategory {
  switch (internal) {
    case "TIMEOUT":
      return "timeout";
    case "RATE_LIMIT":
      return "rate_limit";
    case "AUTH_ERROR":
      return "auth";
    case "INVALID_REQUEST":
      return "bad_request";
    case "TOKEN_LIMIT":
      return "context_exceeded";
    case "SERVICE_ERROR":
    case "NETWORK_ERROR":
      return "provider_unavailable";
    case "UNKNOWN":
      return "unknown";
    default: {
      // Exhaustiveness: TS will error here if a new ErrorCategory is added
      // without a corresponding mapping. Intentional cross-boundary guard.
      const _exhaustive: never = internal;
      void _exhaustive;
      return "unknown";
    }
  }
}

/**
 * Sentences are deliberately short and action-oriented. The chat input
 * itself remains the primary "retry" affordance (see prior-art survey:
 * opencode, openclaw, hermes-desktop all rely on type-to-continue
 * after exhaustion). No "Try again" button in P1 — the friendly
 * sentence is the deliverable.
 */
const FRIENDLY_MESSAGES: Record<FriendlyErrorCategory, string> = {
  timeout:
    "The model took too long to respond. Try again, or switch to a faster model in Settings → Models.",
  rate_limit:
    "The model provider is rate-limiting requests right now. Wait about a minute and try again, or switch models in Settings → Models.",
  auth:
    "The model provider couldn't authenticate. Check your provider API key in Settings.",
  bad_request:
    "The model rejected this request. Try rephrasing or simplifying your message.",
  context_exceeded:
    "This conversation is too long for the selected model. Start a fresh thread or pick a larger-context model in Settings → Models.",
  provider_unavailable:
    "The model provider is overloaded or unavailable right now. Wait a minute and retry, or switch to a different model in Settings → Models.",
  unknown:
    "Something went wrong reaching the model. Try again in a moment, or switch models in Settings → Models.",
};

/**
 * Stable MDL00x codes paired 1:1 with each user-visible category.
 *
 * Code assignment is intentionally stable: MDL001 = timeout forever,
 * MDL002 = rate_limit forever, etc. Adding a new category appends a
 * new MDL00x to the end of the sequence — never renumber existing
 * codes, as that would break `rg`-able log/chat history.
 *
 * Lives next to {@link FRIENDLY_MESSAGES} so the two stay co-located
 * and a future category addition forces both updates in the same diff.
 */
const CATEGORY_CODES: Record<FriendlyErrorCategory, MdlCode> = {
  timeout: "MDL001",
  rate_limit: "MDL002",
  auth: "MDL003",
  bad_request: "MDL004",
  context_exceeded: "MDL005",
  provider_unavailable: "MDL006",
  unknown: "MDL007",
};

/**
 * Stack 208 P0 — user-safe sentence for a graph that exhausted its recursion
 * ceiling. Distinct from the seven category sentences above: the WS
 * `JobStatusEvent.errorCategory` union is a closed set in `@nautilo/types`
 * (not owned by this stack), so the graph-budget failure rides the existing
 * `unknown` category + `MDL007` code on the wire while this dedicated
 * sentence is what the user actually reads. The raw framework detail
 * (troubleshooting URL, literal limit) stays in `detailsForLog` → server.log
 * (R9 — framework failure remains distinct in telemetry, not in the WS
 * category union).
 */
const GRAPH_BUDGET_MESSAGE =
  "This task ran longer than the allowed number of steps. Try simplifying the request or breaking it into smaller steps.";

/**
 * Stack 208 P2 — user-safe sentence for a no-progress stop. The agent
 * repeated the same failing tool operation past the corrective turn, so the
 * breaker stopped it. The sentence is generic on purpose: it names no tool,
 * no arguments, and no raw error (R9 / spec — never expose raw tool output or
 * secrets). Only the grep-able `no_progress` token plus sanitized tool and
 * operation labels ride `detailsForLog`; normalized error content never does.
 *
 * Category stays `unknown` / `MDL007` on the wire (the closed
 * `JobStatusEvent.errorCategory` union in `@nautilo/types` is not owned by
 * this stack); the dedicated sentence is what the user reads.
 */
const NO_PROGRESS_MESSAGE =
  "This task got stuck repeating the same failing step. Try rephrasing the request, simplifying the goal, or breaking it into smaller steps.";

const EMPTY_TERMINAL_RESPONSE_MESSAGE =
  "The model stopped without returning a reply. Try again, or switch models in Settings → Models.";

const PROVIDER_TOOL_SCHEMA_REJECTION_MESSAGE =
  "The model provider rejected Nautilo's tool definitions. Ask an administrator to update Nautilo, or switch models in Settings → Models.";

const STRICT_SHADOW_PROTECTED_CONTENT_REQUIRED_CODE =
  "strict_shadow_protected_content_required";

const STRICT_SHADOW_PROTECTED_CONTENT_REQUIRED_MESSAGE =
  "Encrypted history is not available for this turn yet. Try again after protected history is ready, or ask an administrator to switch back to Fallback Shadow.";

const STRICT_SHADOW_DEADLINE_EXPIRED_MESSAGE =
  "The encryption authorization expired before this turn finished. Please try again.";

const PROTECTED_FOREGROUND_RESUME_FAILED_MESSAGE =
  "The protected action could not resume. No completion was confirmed.";

function isProtectedForegroundResumeFailure(error: unknown): boolean {
  return error instanceof Error
    && error.message === "protected_foreground_resume_failed";
}

function isStrictShadowProtectedContentRequired(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === STRICT_SHADOW_PROTECTED_CONTENT_REQUIRED_CODE;
}

function strictShadowReason(error: unknown): unknown {
  if (
    !isStrictShadowProtectedContentRequired(error)
    || !("decision" in (error as object))
  ) return undefined;
  const decision = (error as { decision?: unknown }).decision;
  return typeof decision === "object" && decision !== null && "reason" in decision
    ? decision.reason
    : undefined;
}

/**
 * Match only the provider-owned structural rejection observed for an
 * Anthropic-routed OpenAI-compatible tool. A generic HTTP 400 can still be a
 * Human-authored request problem and keeps the ordinary bad-request guidance.
 */
function isProviderToolSchemaRejectionMessage(message: string): boolean {
  return /\btools(?:\.\d+|\[\d+\])\.custom\.input_schema\.type\s*:\s*(?:field\s+required|required|missing)\b/iu
    .test(message);
}

/**
 * Translate an arbitrary thrown value into a user-safe
 * {@link FriendlyError}. Defensive against any input shape — strings,
 * Errors, SDK `APIError` objects, plain objects, `null`, primitives.
 *
 * NOT idempotent: passing a {@link FriendlyError}-shaped object back
 * in re-classifies the literal object (almost always landing in
 * `unknown`). The single-chokepoint wire-in at `runtime/src/job.ts`
 * means a thrown value only passes through this translator once, so
 * the non-idempotency is unreachable in practice. If a future caller
 * needs idempotency, add a brand check (`if (looksLikeFriendlyError)
 * return it`) here — do NOT silently re-classify.
 */
export function toFriendlyError(error: unknown): FriendlyError {
  if (error instanceof Error && error.name === "OrdinaryContentAccessRetryRequiredError") {
    return {
      message: "The sharing outcome needs verification. Check the original operation before requesting another share; repeating the request could create a different access change.",
      category: "unknown",
      code: "MDL007",
      detailsForLog: "ordinary_content_access_retry_required",
    };
  }
  if (error instanceof Error && "code" in error && error.code === "approval_request_stale") {
    return {
      message: "That approval is no longer pending. Refresh this chat to review the current request.",
      category: "bad_request",
      code: "MDL004",
      detailsForLog: "approval_request_stale",
    };
  }
  if (error instanceof Error && error.message === "protected_memory_approval_expired") {
    return {
      message: "This sharing preview expired before approval. Nothing was shared by this attempt. Ask for a fresh preview.",
      category: "timeout",
      code: "MDL001",
      detailsForLog: "protected_memory_approval_expired",
    };
  }
  if (isProtectedForegroundResumeFailure(error)) {
    return {
      message: PROTECTED_FOREGROUND_RESUME_FAILED_MESSAGE,
      category: "unknown",
      code: "MDL007",
      detailsForLog: "protected_foreground_resume_failed",
    };
  }
  if (isStrictShadowProtectedContentRequired(error)) {
    if (strictShadowReason(error) === "deadline_expired") {
      return {
        message: STRICT_SHADOW_DEADLINE_EXPIRED_MESSAGE,
        category: "timeout",
        code: "MDL001",
        detailsForLog: "strict_shadow_deadline_expired",
      };
    }
    return {
      message: STRICT_SHADOW_PROTECTED_CONTENT_REQUIRED_MESSAGE,
      category: "unknown",
      code: "MDL007",
      detailsForLog: STRICT_SHADOW_PROTECTED_CONTENT_REQUIRED_CODE,
    };
  }
  if (isEmptyTerminalResponseError(error)) {
    return {
      message: EMPTY_TERMINAL_RESPONSE_MESSAGE,
      category: "unknown",
      code: "MDL007",
      detailsForLog: "empty_terminal_response",
    };
  }
  // Stack 208 P2 — map the no-progress breaker's typed error BEFORE the
  // generic classifier so the user sees the no-progress sentence (not the
  // generic "something went wrong reaching the model"). Category stays
  // `unknown` / `MDL007` on the wire (closed WS union untouched); the raw
  // grep-able `no_progress` token plus sanitized tool/operation labels ride
  // `detailsForLog`; normalized error content is never logged (R9).
  if (isNoProgressError(error)) {
    const outcome = toNoProgressOutcomeFromError(error);
    return toFriendlyNoProgressError(outcome ?? undefined);
  }
  // Stack 208 P0 — map LangGraph's raw GraphRecursionError BEFORE the generic
  // classifier so the user sees a graph-budget sentence (not the generic
  // "something went wrong reaching the model"). Category stays `unknown` /
  // `MDL007` on the wire (closed WS union untouched); the raw framework
  // detail is preserved on `detailsForLog` for server.log only.
  if (isGraphRecursionError(error)) {
    return toFriendlyGraphBudgetError(DEFAULT_GRAPH_RECURSION_LIMIT, error);
  }
  const classified = classifyError(error);
  const category = mapCategory(classified.category);
  const message = classified.category === "INVALID_REQUEST"
    && isProviderToolSchemaRejectionMessage(classified.message)
    ? PROVIDER_TOOL_SCHEMA_REJECTION_MESSAGE
    : FRIENDLY_MESSAGES[category];
  const code = CATEGORY_CODES[category];
  const detailsForLog = formatProviderError(error);
  return { message, category, code, detailsForLog };
}

/**
 * Stack 208 P0 — build the user-safe {@link FriendlyError} for a graph-budget
 * (recursion-limit) failure. Category is `unknown` / `MDL007` (the WS
 * `errorCategory` union is closed in `@nautilo/types` and not owned by this
 * stack); the dedicated {@link GRAPH_BUDGET_MESSAGE} sentence is the
 * user-visible deliverable. `detailsForLog` carries the raw framework
 * message (incl. LangGraph's troubleshooting URL + the literal limit) for
 * `server.log` only — never room-broadcast.
 */
export function toFriendlyGraphBudgetError(
  recursionLimit: number = DEFAULT_GRAPH_RECURSION_LIMIT,
  rawError?: unknown,
): FriendlyError {
  return {
    message: GRAPH_BUDGET_MESSAGE,
    category: "unknown",
    code: "MDL007",
    detailsForLog: rawError !== undefined ? formatProviderError(rawError) : `graph_budget_exceeded recursionLimit=${recursionLimit}`,
  };
}

/**
 * Stack 208 P2 — build the user-safe {@link FriendlyError} for a no-progress
 * stop. Category is `unknown` / `MDL007` (the WS `errorCategory` union is
 * closed in `@nautilo/types` and not owned by this stack); the dedicated
 * {@link NO_PROGRESS_MESSAGE} sentence is the user-visible deliverable.
 * `detailsForLog` carries only the grep-able `no_progress` token plus
 * sanitized tool / operation labels. The normalized error is checkpoint-only
 * and is never logged because it may contain paths, user content, or secrets.
 */
export function toFriendlyNoProgressError(outcome?: NoProgressOutcome): FriendlyError {
  return {
    message: NO_PROGRESS_MESSAGE,
    category: "unknown",
    code: "MDL007",
    detailsForLog:
      outcome !== undefined
        ? formatNoProgressLogToken(outcome)
        : "no_progress",
  };
}

/** Lookup helper for renderers / tests that need the canonical sentence for a category. */
export function friendlyMessageFor(category: FriendlyErrorCategory): string {
  return FRIENDLY_MESSAGES[category];
}

/** Lookup helper for renderers / tests that need the stable MDL00x code for a category. */
export function codeFor(category: FriendlyErrorCategory): MdlCode {
  return CATEGORY_CODES[category];
}

/**
 * Render a {@link FriendlyError} as the bracket-suffixed sentence that
 * the room-broadcast WS event carries (`"... [MDL003]"`).
 *
 * Called from the single wire-in chokepoint at
 * `packages/runtime/src/job.ts`. The bracket position is end-of-message
 * so screen readers parse the sentence first; the bracketed code is the
 * shared vocabulary token bridging chat ↔ server.log ↔ issues per LD-9.
 */
export function friendlyMessageWithCode(friendly: FriendlyError): string {
  return `${friendly.message} [${friendly.code}]`;
}
