import {
  classifyModelStreamProgress,
  modelAttemptIdFromStreamEvent,
  type ModelAttemptProgressSink,
} from "../utils/model-attempt-policy";

/**
 * D128 — per-turn agent flags shared between tools and post-turn fallback policy.
 *
 * D421 Phase 4.2 — per-agent execution context isolation. Group multi-wake
 * jobs share the human `turnId` (= `humanTurnId`); keying skip / redirect /
 * visible-output / depth state solely by that ID would let one bot's `skip`
 * suppress another bot's fallback, or one bot's visible-output flag block
 * another bot's redirect. The map is therefore keyed by a per-agent
 * `turnContextId` = `turnContextKey(humanTurnId, agentId)` on explicit
 * `*ByKey` paths. Legacy callers keep using the bare `turnId` helpers.
 *
 * Tools mutate the turn-scoped store via `turnId` (from ToolContext). The
 * langgraph executor / stream processor reads the same store when deciding
 * whether to emit fallback assistant text (see `post-turn-hook.ts`).
 */
export interface AgentTurnContext {
  /**
   * Absolute wall-clock deadline shared by every `run_web_search` invocation
   * in this Agent turn.  The first invocation sets it; later invocations must
   * consume the same budget rather than restarting a long research window.
   */
  webSearchDeadlineAt?: number;
  /** When true, suppress post-turn fallback text emission for this turn. */
  skipFlag?: boolean;
  /**
   * When true, an explicit user-visible reply already went out this turn
   * (e.g. a future `reply` tool). Fallback suppression still applies only
   * to the redundant tail text — not to synchronous reply emissions.
   */
  replyAlreadySent?: boolean;
  /**
   * D264 — true once `message.tokens` with visible assistant text has
   * been emitted. Prevents automatic model fallback from splicing a
   * second provider into a message the user has already started seeing.
   */
  assistantVisibleOutput?: boolean;
  /** D563 — the one active Agent-owned supervisor for this turn/agent slot. */
  modelAttemptProgressSink?: ModelAttemptProgressSink;
  /**
   * D563 — the exact attempt announced by `on_chat_model_start` for the
   * scope-subagent stream. Subsequent chunks need not repeat this metadata.
   */
  modelAttemptProgressAttemptId?: string;
  /** D563 — per-attempt generated-token high-water mark for meaningful stream progress. */
  modelOutputTokensHighWaterMark?: number;
  /**
   * D421 Phase 4 / 6.4 — one immutable redirect request recorded by a
   * target-bearing `skip` invocation, consumed exactly once by the runtime on the
   * executor success path. `undefined` until a request is accepted.
   */
  redirectRequest?: AgentRedirectRequest;
  /**
   * D421 Phase 4 — turn-scoped redirect depth. `0` (or undefined) means no
   * redirect has been recorded yet; `1` means a request was recorded (or the
   * turn was seeded as a redirect target by Phase 4.2). A later request on a
   * depth-1 turn is rejected as a duplicate.
   */
  redirectDepth?: 0 | 1;
  /**
   * D421 Phase 4 — consume-once flag set by the runtime after it has read the
   * recorded request. A second consume returns nothing so the request can
   * never be dispatched twice even if the seam is re-entered.
   */
  redirectConsumed?: boolean;
}

/**
 * D421 Phase 4 — the immutable redirect request recorded on the source
 * agent's turn context. Depth is always `1`: a valid request changes the
 * turn's `redirectDepth` from `0 → 1`, and the target turn is seeded at
 * depth `1` so it cannot redirect again.
 */
export interface AgentRedirectRequest {
  readonly targetHandle: string;
  readonly reason?: string;
  readonly depth: 1;
}

/**
 * D421 Phase 4 — controlled rejection reasons for a redirect request. The
 * tool surfaces these as stable reason codes in its structured JSON result;
 * the requester-private receipt (Phase 4.2/4.3) maps them to the
 * `redirect_rejected_*` vocabulary locked in the Phase 0 contract. The raw
 * model `reason` is never echoed across this boundary.
 */
export type AgentRedirectRejectionReason =
  /** `assistantVisibleOutput === true` when the tool attempted to record. */
  | "visible_output"
  /** `redirectDepth === 1` already (a request was recorded or the turn was seeded). */
  | "duplicate"
  /** `target_handle` failed schema shape/normalization. */
  | "invalid_target"
  /** `target_handle` byte-equals the resolved source handle. */
  | "self_target";

export type AgentRedirectRecordResult =
  | { readonly ok: true; readonly request: AgentRedirectRequest }
  | { readonly ok: false; readonly reason: AgentRedirectRejectionReason };

const turnContexts = new Map<string, AgentTurnContext>();

/**
 * D421 Phase 4.2 — derive the deterministic per-agent execution context key
 * from the human turn id + the canonical agent id. Stable within one bot
 * execution and distinct across bots sharing one human turn.
 */
export function turnContextKey(humanTurnId: string, agentId: string): string {
  const t = humanTurnId.trim();
  const a = agentId.trim();
  if (!t) return "";
  if (!a) return t;
  return `${t}::${a}`;
}

export function getOrCreateAgentTurnContext(turnId: string): AgentTurnContext {
  const key = turnId.trim();
  if (!key) return {};
  let ctx = turnContexts.get(key);
  if (!ctx) {
    ctx = {};
    turnContexts.set(key, ctx);
  }
  return ctx;
}

export function getAgentTurnContext(turnId: string): AgentTurnContext | undefined {
  const key = turnId.trim();
  if (!key) return undefined;
  return turnContexts.get(key);
}

/**
 * D421 Phase 4.2 — key-explicit variants for runtime/server seams that hold
 * the precomputed per-agent key (the executor's success-path consumer) so
 * Identical semantics to the bare-`turnId` variants otherwise.
 */
export function getOrCreateAgentTurnContextByKey(key: string): AgentTurnContext {
  const k = key.trim();
  if (!k) return {};
  let ctx = turnContexts.get(k);
  if (!ctx) {
    ctx = {};
    turnContexts.set(k, ctx);
  }
  return ctx;
}

export function getAgentTurnContextByKey(key: string): AgentTurnContext | undefined {
  const k = key.trim();
  if (!k) return undefined;
  return turnContexts.get(k);
}

/** LangGraph `streamEvents` event name for a chat-model token chunk. */
const CHAT_MODEL_STREAM_EVENT_NAME = "on_chat_model_stream";

/** Bind exactly one Agent-owned supervisor to a per-turn execution slot. */
export function bindModelAttemptProgressSinkByKey(key: string | undefined, sink: ModelAttemptProgressSink): void {
  const k = key?.trim();
  if (!k) return;
  getOrCreateAgentTurnContextByKey(k).modelAttemptProgressSink = sink;
}

/** Clear only the sink we installed; never let an old attempt erase a newer one. */
export function clearModelAttemptProgressSinkByKey(key: string | undefined, attemptId: string): void {
  const k = key?.trim();
  if (!k) return;
  const context = getAgentTurnContextByKey(k);
  if (context?.modelAttemptProgressSink?.attemptId === attemptId) {
    delete context.modelAttemptProgressSink;
    delete context.modelAttemptProgressAttemptId;
    delete context.modelOutputTokensHighWaterMark;
  }
}

/** Runtime's dumb one-way report seam. Stale/mismatched attempt IDs are ignored by the sink. */
export function reportModelAttemptProgressByKey(key: string | undefined, attemptId: string | undefined): boolean {
  const k = key?.trim();
  if (!k || !attemptId) return false;
  return getAgentTurnContextByKey(k)?.modelAttemptProgressSink?.reportMeaningfulProgress(attemptId) ?? false;
}

/**
 * Shared recognizer for scope-subagent streaming. The foreground Runtime has
 * its own high-water mark and reports directly through the same sink. `key`
 * must be the canonical per-agent turn-context key, never a bare shared turn.
 *
 * Scope-subagent events use this helper so they share the exact same narrow
 * meaningful-progress classifier as the foreground Runtime.
 */
export function recordStreamActivityFromEvent(ev: unknown, key: string | undefined): boolean {
  if (!ev || typeof ev !== "object") return false;
  if (!key?.trim()) return false;
  const event = (ev as { event?: unknown }).event;
  const context = getOrCreateAgentTurnContextByKey(key);
  if (event === "on_chat_model_start") {
    const attemptId = modelAttemptIdFromStreamEvent(ev);
    if (attemptId) context.modelAttemptProgressAttemptId = attemptId;
    else delete context.modelAttemptProgressAttemptId;
    // A model start always begins a fresh generated-token counter, even when
    // a provider subsequently omits `model_attempt_id` on its delta chunks.
    delete context.modelOutputTokensHighWaterMark;
    return false;
  }
  if (event !== CHAT_MODEL_STREAM_EVENT_NAME) return false;
  const explicitAttemptId = modelAttemptIdFromStreamEvent(ev);
  const activeAttemptId = context.modelAttemptProgressSink?.attemptId;
  // An explicit ID is authoritative: never let a late chunk carrying an old
  // attempt ID borrow the current attempt's retained start metadata.
  if (explicitAttemptId && activeAttemptId && explicitAttemptId !== activeAttemptId) return false;
  const attemptId = explicitAttemptId ?? context.modelAttemptProgressAttemptId;
  if (!attemptId) return false;
  const progress = classifyModelStreamProgress(ev, context.modelOutputTokensHighWaterMark ?? 0);
  if (progress.outputTokens !== undefined && progress.outputTokens > (context.modelOutputTokensHighWaterMark ?? 0)) {
    context.modelOutputTokensHighWaterMark = progress.outputTokens;
  }
  if (!progress.meaningful) return false;
  return reportModelAttemptProgressByKey(key, attemptId);
}

export function clearAgentTurnContext(turnId: string): void {
  const key = turnId.trim();
  if (!key) return;
  turnContexts.delete(key);
}

/**
 * D421 Phase 4.2 — key-explicit cleanup for the executor's terminal paths.
 * The executor computes the per-agent key once and passes it here. Also the
 * only way for a runtime seam to clear an isolated per-agent slot.
 */
export function clearAgentTurnContextByKey(key: string): void {
  const k = key.trim();
  if (!k) return;
  turnContexts.delete(k);
}

// ---------------------------------------------------------------------------
// D421 Phase 4 — one-hop agent redirect request seam.
//
// Target-bearing `skip` is a dumb recorder: it validates the `target_handle`
// shape, prevalidates a self-target against the already-
// supplied roomRoster snapshot, then calls `tryRecordAgentRedirect` to
// compare-and-set exactly one immutable request on the source turn's
// `AgentTurnContext`. The runtime consumes that request exactly once on the
// executor success path (Phase 4.2). The tool never touches the DB, the
// JobManager, focus writers, or the event bus; the server remains
// authoritative for canonical target resolution, enqueue, and focus
// transfer (Phase 4.2/4.3).
// ---------------------------------------------------------------------------

/**
 * D421 Phase 4 — compare-and-set the source turn's redirect request.
 *
 * Records exactly one immutable {@link AgentRedirectRequest} only when the
 * current `redirectDepth` is `0` AND `assistantVisibleOutput !== true`. On
 * acceptance it also sets `skipFlag` so subsequent source output is
 * suppressed (the tool-time gate that guarantees no visible output precedes
 * the accepted request; it cannot retract tokens already emitted).
 *
 * Rejection is controlled and never mutates state:
 * - `self_target` — `targetHandle` byte-equals the supplied `sourceHandle`
 *   (only checked when a source handle is available; the server remains
 *   authoritative for the final canonical check).
 * - `visible_output` — `assistantVisibleOutput === true`.
 * - `duplicate` — `redirectDepth === 1` (a request was already recorded or
 *   the turn was seeded as a redirect target).
 *
 * `invalid_target` (schema shape) is a tool-level prevalidation concern and
 * is surfaced through the same {@link AgentRedirectRejectionReason} union
 * without reaching this helper.
 */
export function tryRecordAgentRedirect(
  turnId: string,
  candidate: { readonly targetHandle: string; readonly reason?: string },
  options: { readonly sourceHandle?: string } = {},
): AgentRedirectRecordResult {
  const key = turnId.trim();
  if (!key) return { ok: false, reason: "invalid_target" };
  if (options.sourceHandle && candidate.targetHandle === options.sourceHandle) {
    return { ok: false, reason: "self_target" };
  }
  const ctx = getOrCreateAgentTurnContextByKey(key);
  if (ctx.assistantVisibleOutput === true) {
    return { ok: false, reason: "visible_output" };
  }
  if (ctx.redirectDepth === 1) {
    return { ok: false, reason: "duplicate" };
  }
  const request: AgentRedirectRequest = Object.freeze({
    targetHandle: candidate.targetHandle,
    ...(candidate.reason ? { reason: candidate.reason } : {}),
    depth: 1,
  });
  ctx.redirectRequest = request;
  ctx.redirectDepth = 1;
  ctx.skipFlag = true;
  return { ok: true, request };
}

/**
 * D421 Phase 4.2 — key-explicit recorder for runtime seams that hold the
 * precomputed per-agent key. Same CAS semantics as {@link tryRecordAgentRedirect}.
 */
export function tryRecordAgentRedirectByKey(
  key: string,
  candidate: { readonly targetHandle: string; readonly reason?: string },
  options: { readonly sourceHandle?: string } = {},
): AgentRedirectRecordResult {
  const k = key.trim();
  if (!k) return { ok: false, reason: "invalid_target" };
  if (options.sourceHandle && candidate.targetHandle === options.sourceHandle) {
    return { ok: false, reason: "self_target" };
  }
  const ctx = getOrCreateAgentTurnContextByKey(k);
  if (ctx.assistantVisibleOutput === true) {
    return { ok: false, reason: "visible_output" };
  }
  if (ctx.redirectDepth === 1) {
    return { ok: false, reason: "duplicate" };
  }
  const request: AgentRedirectRequest = Object.freeze({
    targetHandle: candidate.targetHandle,
    ...(candidate.reason ? { reason: candidate.reason } : {}),
    depth: 1,
  });
  ctx.redirectRequest = request;
  ctx.redirectDepth = 1;
  ctx.skipFlag = true;
  return { ok: true, request };
}

/**
 * D421 Phase 4 — read the recorded redirect request without consuming it.
 * Returns a defensive copy (never the internal frozen reference) or
 * `undefined` when no request was recorded or it has already been consumed.
 */
export function peekAgentRedirectRequest(
  turnId: string,
): AgentRedirectRequest | undefined {
  const key = turnId.trim();
  if (!key) return undefined;
  const ctx = getAgentTurnContextByKey(key);
  if (!ctx || ctx.redirectConsumed) return undefined;
  return copyRedirectRequest(ctx.redirectRequest);
}

/**
 * D421 Phase 4.2 — key-explicit peek for the per-agent slot. Returns a
 * defensive copy or `undefined` when no request was recorded or it has
 * already been consumed.
 */
export function peekAgentRedirectRequestByKey(
  key: string,
): AgentRedirectRequest | undefined {
  const k = key.trim();
  if (!k) return undefined;
  const ctx = getAgentTurnContextByKey(k);
  if (!ctx || ctx.redirectConsumed) return undefined;
  return copyRedirectRequest(ctx.redirectRequest);
}

/**
 * D421 Phase 4 — consume the recorded redirect request exactly once.
 * Returns a defensive copy the first time it is called after a request was
 * recorded, and `undefined` thereafter (including when no request exists).
 * The internal frozen reference is never handed out, so callers cannot
 * mutate turn state through the returned value.
 */
export function consumeAgentRedirectRequest(
  turnId: string,
): AgentRedirectRequest | undefined {
  const key = turnId.trim();
  if (!key) return undefined;
  const ctx = getAgentTurnContextByKey(key);
  if (!ctx || ctx.redirectConsumed) return undefined;
  const copy = copyRedirectRequest(ctx.redirectRequest);
  if (copy) {
    ctx.redirectConsumed = true;
  }
  return copy;
}

/**
 * D421 Phase 4.2 — key-explicit consume-once for the runtime success seam.
 * The executor passes the precomputed per-agent key. Returns the defensive
 * copy the first time it is called and `undefined` thereafter.
 */
export function consumeAgentRedirectRequestByKey(
  key: string,
): AgentRedirectRequest | undefined {
  const k = key.trim();
  if (!k) return undefined;
  const ctx = getAgentTurnContextByKey(k);
  if (!ctx || ctx.redirectConsumed) return undefined;
  const copy = copyRedirectRequest(ctx.redirectRequest);
  if (copy) {
    ctx.redirectConsumed = true;
  }
  return copy;
}

function copyRedirectRequest(
  request: AgentRedirectRequest | undefined,
): AgentRedirectRequest | undefined {
  if (!request) return undefined;
  return {
    targetHandle: request.targetHandle,
    ...(request.reason ? { reason: request.reason } : {}),
    depth: 1,
  };
}

/**
 * D421 Phase 4.2 — seed a target turn at redirect depth `1` so the target
 * cannot record another redirect. Sets only `redirectDepth` (never
 * `skipFlag` — the target should answer normally) and is idempotent: a turn
 * already carrying a recorded request or a seeded depth is left unchanged.
 */
export function seedAgentRedirectDepth(turnId: string): void {
  const key = turnId.trim();
  if (!key) return;
  const ctx = getOrCreateAgentTurnContextByKey(key);
  if (ctx.redirectDepth === undefined || ctx.redirectDepth === 0) {
    ctx.redirectDepth = 1;
  }
}

/**
 * D421 Phase 4.2 — key-explicit target seeding. The executor calls this at
 * target execution ingress, before graph/model/tool work, so a queued job
 * cancelled before start cannot leak context. Idempotent.
 */
export function seedAgentRedirectDepthByKey(key: string): void {
  const k = key.trim();
  if (!k) return;
  const ctx = getOrCreateAgentTurnContextByKey(k);
  if (ctx.redirectDepth === undefined || ctx.redirectDepth === 0) {
    ctx.redirectDepth = 1;
  }
}

/** Test-only — reset all in-memory turn contexts. */
export function _resetAgentTurnContextsForTests(): void {
  turnContexts.clear();
}

/**
 * Merge turn-scoped flags into the opaque ToolContext object passed to tool
 * factories. Call sites should spread the returned fields onto their context.
 */
export function withAgentTurnContextFields(
  turnId: string | undefined,
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!turnId?.trim()) return base;
  const turnContext = getOrCreateAgentTurnContext(turnId ?? "");
  return { ...base, turnId, turnContext, skipFlag: turnContext.skipFlag === true };
}
