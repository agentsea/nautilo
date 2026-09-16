import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredTool } from "@langchain/core/tools";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { isInteropZodSchema } from "@langchain/core/utils/types";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { log, getCurrentTurnId } from "@nautilo/logger";
import {
  bindModelAttemptProgressSinkByKey,
  clearModelAttemptProgressSinkByKey,
  getAgentTurnContextByKey,
  turnContextKey,
} from "../runtime/turn-context";
import { ProviderTimeoutError, formatProviderError, isProviderTimeoutError, isSafelyRetryableProviderTimeout } from "../providers/errors";
import { getModelById } from "../config/assistant-models";
import { ModelUnavailableError, resolveRetainedModels } from "../config/eligible-models";
import { createUniversalModel } from "../providers/universal";
import { modelRouteProvider } from "../providers/model-route";
import { hasStubModelForTests } from "../providers/stub-model-state";
import type { ReasoningEffort } from "../providers/types";
import { resolveFireworksKimiK3ServingProfile, type ResolvedFireworksKimiK3ServingProfile } from "../providers/serving-profile";
import { modelSupportsInput, resolveModelExecutionLimits } from "../providers/models";
import { estimateTokenCount } from "./history-manager";
import { classifyError, getRetryStrategy, messageImpliesCapabilityMismatch, waitForRetryDelay, type ClassifiedError } from "./errors";
import { isModelHealthy, markModelInvokeFailure } from "./model-health";
import { messagesContainImageInputs } from "./message-modalities";
import { resolveFallbackPolicy, type ResolvedFallbackPolicy } from "./resolve-fallback-policy";
import { mapCategory, type FriendlyErrorCategory } from "./friendly-errors";
import { emitAgentEvent } from "../runtime-hooks";
import { getUsageContext, runWithUsageContext } from "../usage/usage-context";
import {
  hasProjectableStableSystemPrefix,
  modelUsesOpenAIExplicitPromptCache,
  projectPreparedMessagesForModelCache,
} from "./model-context-cache";
import {
  ModelAttemptSupervisor,
  resolveModelAttemptPolicy,
  classifyModelStreamProgress,
  type ResolvedModelAttemptPolicy,
} from "./model-attempt-policy";

/**
 * D429 Phase 4 — explicit fallback-mode representation threaded from Task
 * dispatch through the subagent graph into chat-model invocation.
 *
 * - `"agent_chain"` (default): the existing per-user/per-agent fallback
 *   chain walks normally. Foreground chat and non-exact Task callers stay
 *   here, preserving backwards-compatible behavior.
 * - `"none"`: strict / no-chain mode. An exact Task `model_id` pin MUST NOT
 *   silently execute another model. Every cross-model hop is suppressed
 *   (provider error, context preflight, vision incompatibility, capability
 *   error). Bounded same-model short retries are preserved (they live in
 *   `invokeOnceWithShortRetries`, below the chain-walk seam).
 *
 * No `agent_chain` opt-in escape hatch ships in v1: a strict run cannot widen
 * back into chain behavior, including across checkpoint resume (the field is
 * persisted in cold-start graph state, so a resume reads it from the
 * checkpoint rather than re-deriving it).
 */
export type ModelFallbackMode = "agent_chain" | "none";

/** One already-resolved foreground tuple, re-created for every fallback candidate. */
export interface ResolvedForegroundModelControls {
  readonly canonicalModelId: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly servingProfileId?: string;
}
export type ResolveForegroundModelControls = (canonicalModelId: string) => ResolvedForegroundModelControls | undefined;

/** D429 Phase 4 — convert the Phase-3 `exactModelSelection` job flag into the explicit fallback mode. */
export function modelFallbackModeFromExactSelection(exactModelSelection: boolean): ModelFallbackMode {
  return exactModelSelection ? "none" : "agent_chain";
}

/** D429 Phase 4 — true when the resolved mode suppresses every cross-model hop. */
export function isStrictNoChain(mode: ModelFallbackMode | undefined): boolean {
  return mode === "none";
}

const COMPLETION_SAFETY_MARGIN_TOKENS = 4_096;
const SAME_MODEL_RETRYABLE_ATTEMPTS = 2;

/** @internal Tests may shorten the first-token budget without waiting 60s. */
let firstTokenTimeoutMsOverride: number | undefined;

export function _setFirstTokenTimeoutMsForTests(ms: number | undefined): void {
  firstTokenTimeoutMsOverride = ms;
}

function hasAssistantVisibleOutputForCurrentTurn(agentId: string | null): boolean {
  const turnId = getCurrentTurnId();
  if (!turnId?.trim()) return false;
  // D421 Phase 4.2 — resolve the per-agent slot so two bots sharing one
  // human `turnId` cannot read each other's `assistantVisibleOutput`.
  const key = agentId ? turnContextKey(turnId, agentId) : turnId;
  const ctx = getAgentTurnContextByKey(key);
  return ctx?.assistantVisibleOutput === true;
}

/** Provider-local observation also covers background streams without a Room visibility flag. */
function contextRecoveryVisibilityFence() {
  let visible = false;
  const hasText = (content: unknown): boolean => typeof content === "string" ? content.length > 0
    : Array.isArray(content) && content.some((block: unknown) => typeof block === "string" ? block.length > 0
      : block !== null && typeof block === "object" && "type" in block && block.type === "text"
        && "text" in block && typeof block.text === "string" && block.text.length > 0);
  const handler = BaseCallbackHandler.fromMethods({
    handleLLMNewToken: (token, _indices, _runId, _parentRunId, _tags, fields) => {
      // A structured chat chunk is authoritative: provider token strings can
      // contain reasoning or tool arguments even when visible content is empty.
      const chunk = fields?.chunk;
      if (chunk && "message" in chunk) visible ||= hasText(chunk.message.content);
      else visible ||= token.length > 0;
    },
    handleChatModelStreamEvent: (event) => {
      if (event.event === "content-block-delta" && event.delta.type === "text-delta") visible ||= event.delta.text.length > 0;
      if (event.event === "content-block-start" || event.event === "content-block-finish") visible ||= hasText([event.content]);
    },
  });
  // Set the flag before provider rejection can reach the recovery catch.
  handler.awaitHandlers = true;
  return { handler, hasVisibleOutput: () => visible };
}

/** Thrown when estimated input (+ margin) does not leave room for completion under a model's context window. */
export class PreparedContextExceededError extends Error {
  readonly code = "NAUTILO_PREPARED_CONTEXT_EXCEEDED" as const;

  constructor(
    public readonly modelId: string,
    public readonly estimatedInputTokens: number,
    public readonly contextWindowTokens: number,
  ) {
    super(
      `Prepared messages exceed ${modelId}'s usable context window ` +
        `(${estimatedInputTokens} estimated input tokens, ${contextWindowTokens} context tokens). ` +
        `Start a fresh thread or switch to a larger-context model.`,
    );
    this.name = "PreparedContextExceededError";
  }
}

export function isPreparedContextExceededError(error: unknown): error is PreparedContextExceededError {
  return error instanceof PreparedContextExceededError;
}

/** Provider rejected thinking/beta/temp/budget — retry once with reasoning off. */
export function messageImpliesThinkingConfigRejection(message: string): boolean {
  const lower = message.toLowerCase();
  const mentionsThinking =
    lower.includes("thinking") ||
    lower.includes("reasoning") ||
    lower.includes("reasoning_effort") ||
    lower.includes("budget_tokens") ||
    lower.includes("interleaved-thinking") ||
    lower.includes("anthropic-beta");
  if (!mentionsThinking) return false;
  return (
    lower.includes("invalid") ||
    lower.includes("unsupported") ||
    lower.includes("not supported") ||
    lower.includes("unexpected") ||
    lower.includes("unknown parameter") ||
    lower.includes("unrecognized") ||
    lower.includes("does not support")
  );
}

function shouldRetryWithoutReasoning(classified: ClassifiedError): boolean {
  return (
    classified.category === "INVALID_REQUEST" &&
    messageImpliesThinkingConfigRejection(classified.message)
  );
}

/** @internal D331 — test seam for reasoning-config retry planning. */
export function planChatModelInvokeRetry(
  classified: ClassifiedError,
  disableReasoningOutput: boolean,
): "retry_same_model_no_reasoning" | "fallback_or_throw" {
  if (!disableReasoningOutput && shouldRetryWithoutReasoning(classified)) {
    return "retry_same_model_no_reasoning";
  }
  return "fallback_or_throw";
}

/** Whether we should try the next catalog fallback model after this failure. */
export function shouldFallbackToNextModel(classified: ClassifiedError): boolean {
  if (classified.category === "AUTH_ERROR") return false;
  if (classified.retryable) return true;
  if (classified.category === "TOKEN_LIMIT") return true;
  if (classified.category === "INVALID_REQUEST" && messageImpliesCapabilityMismatch(classified.message)) return true;
  return false;
}

function shouldCooldownAfterFailure(classified: ClassifiedError): boolean {
  return (
    classified.category === "RATE_LIMIT" ||
    classified.category === "TIMEOUT" ||
    classified.category === "NETWORK_ERROR" ||
    classified.category === "SERVICE_ERROR"
  );
}

/** Same chars/token estimator as message history, applied to complete bound definitions. */
export function estimateBoundToolTokens(tools: readonly StructuredTool[]): number {
  if (tools.length === 0) return 0;
  const definitions = tools.map((tool) => ({ type: "function", function: {
    name: tool.name, description: tool.description,
    parameters: isInteropZodSchema(tool.schema) ? toJsonSchema(tool.schema) : tool.schema,
  } }));
  return Math.ceil(JSON.stringify(definitions).length / 4);
}

export interface PreparedContextRecoveryInput {
  messages: BaseMessage[];
  modelId: string;
  contextWindowTokens: number;
  estimatedMessageTokens: number;
  /** Model allowance after the bound tool definitions and completion margin. */
  maxMessageTokens: number;
  source: "preflight" | "provider";
  signal?: AbortSignal;
}

/** Caller-owned recovery uses the ordinary selected model, never a hidden summarizer. */
export type RecoverPreparedContext = (input: PreparedContextRecoveryInput) =>
  BaseMessage[] | null | Promise<BaseMessage[] | null>;

export async function resolveCompletionBudget(modelId: string, messages: BaseMessage[], tools: readonly StructuredTool[] = []): Promise<number> {
  const limits = await resolveModelExecutionLimits(modelId);
  const contextWindow = limits.contextTokens;
  const maxOutputTokens = limits.maxOutputTokens;
  const estimatedInput = estimateTokenCount(messages) + estimateBoundToolTokens(tools);
  const available = contextWindow - estimatedInput - COMPLETION_SAFETY_MARGIN_TOKENS;

  if (available < 1) {
    throw new PreparedContextExceededError(modelId, estimatedInput, contextWindow);
  }

  // The per-model catalog/provider limit is authoritative. Only remaining
  // context may reduce it; a global ceiling silently defeats curated model
  // capabilities and can exhaust reasoning before any visible response.
  const resolved = Math.max(1, Math.min(maxOutputTokens, available));
  if (resolved < maxOutputTokens) {
    log(
      `[nautilo/agent] Clamped maxTokens for ${modelId}: input=${estimatedInput} context=${contextWindow} maximum=${maxOutputTokens} resolved=${resolved}`,
    );
  }
  return resolved;
}

/** One Agent-owned supervisor guards this actual provider invocation. */
async function invokeModelWithAttemptSupervisor(
  model: { invoke(messages: BaseMessage[], options?: RunnableConfig): Promise<unknown> },
  messages: BaseMessage[],
  llmCallConfig: RunnableConfig,
  agentId: string | null,
  attemptPolicy: ResolvedModelAttemptPolicy,
  isolatedProgress = false,
): Promise<AIMessage> {
  const turnId = getCurrentTurnId();
  const key = !isolatedProgress && turnId?.trim() ? (agentId ? turnContextKey(turnId, agentId) : turnId) : undefined;
  const supervisor = new ModelAttemptSupervisor(attemptPolicy, {
    ...(llmCallConfig?.signal ? { parentSignal: llmCallConfig.signal } : {}),
    isVisibleOutput: () => !isolatedProgress && hasAssistantVisibleOutputForCurrentTurn(agentId),
    onTimeout: (outcome) => {
      const timeoutMs = outcome.timeoutKind === "first_progress_timeout"
        ? attemptPolicy.firstProgressMs
        : outcome.timeoutKind === "progress_idle_timeout"
          ? attemptPolicy.progressIdleMs
          : attemptPolicy.absoluteMs ?? 0;
      return new ProviderTimeoutError(attemptPolicy.modelId, timeoutMs, {
        kind: outcome.timeoutKind,
        attemptId: attemptPolicy.attemptId,
        policyProvenance: attemptPolicy.provenance,
        elapsedMs: outcome.elapsedMs,
        visibleOutput: outcome.visibleOutput,
        partialState: outcome.partialState,
        abortRequested: outcome.abortRequested,
        safeToFallback: outcome.safeToFallback,
      });
    },
  });
  if (key) bindModelAttemptProgressSinkByKey(key, supervisor);
  // Start before `model.invoke`: some LangChain implementations synchronously
  // emit their first stream delta before their returned promise yields.
  supervisor.start();

  let outputTokens = 0;
  const localProgress = isolatedProgress ? BaseCallbackHandler.fromMethods({
    handleLLMNewToken: (token, _indices, _runId, _parentRunId, _tags, fields) => {
      const chunk = fields?.chunk;
      const progress = classifyModelStreamProgress({ data: { chunk: chunk && "message" in chunk ? chunk.message : token } }, outputTokens);
      outputTokens = Math.max(outputTokens, progress.outputTokens ?? 0);
      if (progress.meaningful) supervisor.reportMeaningfulProgress(attemptPolicy.attemptId);
    },
  }) : undefined;
  if (localProgress) localProgress.awaitHandlers = true;

  try {
    const metadata = (llmCallConfig as Record<string, unknown> | undefined)?.["metadata"] as Record<string, unknown> | undefined;
    const invokePromise = model.invoke(messages, {
      ...llmCallConfig,
      ...(localProgress ? { callbacks: CallbackManager.configure(llmCallConfig.callbacks, [localProgress])! } : {}),
      metadata: {
        ...metadata,
        model_id: attemptPolicy.modelId,
        model_attempt_id: attemptPolicy.attemptId,
      },
      signal: supervisor.signal,
    }) as Promise<AIMessage>;
    return await supervisor.race(invokePromise);
  } finally {
    if (key) clearModelAttemptProgressSinkByKey(key, attemptPolicy.attemptId);
    supervisor.dispose();
  }
}

async function invokeOnceWithShortRetries(
  modelWithTools: { invoke(messages: BaseMessage[], options?: RunnableConfig): Promise<unknown> },
  messages: BaseMessage[],
  llmCallConfig: RunnableConfig,
  modelId: string,
  agentId: string | null,
  attemptPolicyOptions: { readonly providerTimeoutMs?: number; readonly callerSuppliedProviderTimeout: boolean; readonly firstProgressTimeoutMs?: number; readonly isolatedProgress?: boolean },
  maximumAttempts = SAME_MODEL_RETRYABLE_ATTEMPTS,
): Promise<AIMessage> {
  for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
    if (llmCallConfig.signal?.aborted) {
      throw llmCallConfig.signal.reason instanceof Error
        ? llmCallConfig.signal.reason
        : new Error("Model invocation cancelled by caller");
    }
    try {
      const attemptPolicy = resolveModelAttemptPolicy(modelId, {
        ...attemptPolicyOptions,
        ...(firstTokenTimeoutMsOverride === undefined ? {} : { firstProgressMsOverride: firstTokenTimeoutMsOverride }),
      });
      return await invokeModelWithAttemptSupervisor(modelWithTools, messages, llmCallConfig, agentId, attemptPolicy, attemptPolicyOptions.isolatedProgress);
    } catch (error) {
      // Caller cancellation is a terminal control-flow outcome, not a model
      // failure. Never turn it into a same-model retry because a provider's
      // cooperative AbortError happens to resemble a timeout.
      if (llmCallConfig.signal?.aborted) throw error;
      // Unknown/visible timeout outcomes cannot be replayed. Safe supervised timeouts
      // use the existing bounded same-model retry policy, including strict model mode.
      if (isProviderTimeoutError(error) && (!isSafelyRetryableProviderTimeout(error)
        || hasAssistantVisibleOutputForCurrentTurn(agentId))) throw error;
      const classified = classifyError(error);
      if (attempt >= maximumAttempts || !classified.retryable) throw error;
      const strategy = getRetryStrategy(classified);
      if (!strategy.shouldRetry) throw error;
      log(`[nautilo/agent] Retryable error on ${modelId} (attempt ${attempt}/${maximumAttempts}), backing off`);
      await waitForRetryDelay(attempt, strategy);
    }
  }
  throw new Error("invokeOnceWithShortRetries: exhausted attempts");
}

function servingSelectorForUsage(serving: ResolvedFireworksKimiK3ServingProfile): string {
  if (serving.requestModelKwargs) return "request-parameter:service_tier=priority";
  return serving.effectiveModelId === serving.canonicalModelId ? "default" : `model-override:${serving.effectiveModelId}`;
}

async function invokeForegroundAttemptWithUsageContext(
  modelWithTools: { invoke(messages: BaseMessage[], options?: RunnableConfig): Promise<unknown> },
  messages: BaseMessage[],
  llmCallConfig: RunnableConfig,
  modelId: string,
  agentId: string | null,
  controls: ResolvedForegroundModelControls | undefined,
  serving: ResolvedFireworksKimiK3ServingProfile | undefined,
  reasoningOutput: boolean,
  sameModelRetryMode: "none" | "short",
  attemptPolicyOptions: { readonly providerTimeoutMs?: number; readonly callerSuppliedProviderTimeout: boolean; readonly firstProgressTimeoutMs?: number; readonly isolatedProgress?: boolean },
): Promise<AIMessage> {
  const invoke = () => invokeOnceWithShortRetries(
    modelWithTools,
    messages,
    llmCallConfig,
    modelId,
    agentId,
    attemptPolicyOptions,
    sameModelRetryMode === "none" ? 1 : SAME_MODEL_RETRYABLE_ATTEMPTS,
  );
  if (!controls) return invoke();
  const parent = getUsageContext();
  return runWithUsageContext({
    callType: parent?.callType ?? "chat",
    userId: parent?.userId ?? null,
    roomId: parent?.roomId ?? null,
    ...(parent?.metadata ? { metadata: parent.metadata } : {}),
    modelControl: {
      canonicalModelId: controls.canonicalModelId,
      effectiveModelId: serving?.effectiveModelId ?? controls.canonicalModelId,
      ...(controls.reasoningEffort === undefined ? {} : { requestedReasoningEffort: controls.reasoningEffort }),
      ...(controls.reasoningEffort === undefined ? {} : { effectiveReasoningEffort: reasoningOutput ? controls.reasoningEffort : "off" }),
      ...(serving === undefined ? {} : { servingProfileId: serving.profileId }),
      ...(serving === undefined ? {} : { servingSelector: servingSelectorForUsage(serving) }),
    },
  }, invoke);
}

/**
 * D141 P3 — emit a `model.fallback` WS event for every hop, regardless
 * of which of the three hop sites fires it (vision-skip, context-
 * exceeded pre-flight, classified-error post-attempt). Privacy posture
 * matches LD-8: zero echoed content; only catalog IDs + category enum.
 *
 * No-op when `laneKey` is null (system tasks / tests with no room
 * context). The fallback walk itself is unaffected — just no WS
 * announcement to anyone.
 */
function emitFallbackHop(
  from: string,
  to: string,
  reason: FriendlyErrorCategory,
  laneKey: string | null,
): void {
  if (!laneKey) return;
  emitAgentEvent({
    type: "model.fallback",
    laneKey,
    turnId: getCurrentTurnId() ?? "",
    from,
    to,
    reason,
  });
}

/**
 * D141 P2 / LD-1 — walk the user's policy-defined chain.
 *
 * Replaces the pre-D141 `nextFallbackCandidate` which traversed the
 * global catalog priority order. The chain is what the user (or
 * per-agent override) authored. If the current model IS in the chain,
 * we walk forward to the next entry. If it ISN'T, we still walk —
 * starting from the head (index 0) — so a recoverable failure on an
 * out-of-chain selected model still falls back to the user's chain.
 *
 * D370 implicit-head: the selected model is always attempt #1. On a
 * recoverable failure, walk the FULL user chain from the top even
 * when the selected model isn't a member of the chain. Dedupe guards
 * against re-attempting the originally-selected model during the walk
 * (relevant when an out-of-chain selected model also appears in the
 * chain, or when the walk restarts from the head on a later hop).
 *
 * `initialModelId` is the originally-selected model for THIS invoke
 * call. It is threaded through (rather than derived from `currentId`,
 * which mutates as the walk advances) so the dedupe is stable across
 * all three call sites: vision-skip preflight, context-exceeded
 * pre-flight, and the post-error catch.
 *
 * Returns `undefined` when:
 *   - The user has fallback disabled OR an empty chain
 *   - We've walked off the end of the chain
 *   - All remaining chain entries are unhealthy or vision-incompatible
 */
function nextInUserChain(
  currentId: string,
  policy: ResolvedFallbackPolicy,
  needsVision: boolean,
  requiresTools: boolean,
  initialModelId: string,
  strictNoChain: boolean,
): string | undefined {
  // D429 Phase 4 — strict / no-chain mode suppresses EVERY cross-model hop
  // (vision-skip preflight, context-exceeded preflight, provider failure,
  // capability error). Returning undefined here makes each of the three call
  // sites throw the original error instead of hopping, while same-model short
  // retries (invokeOnceWithShortRetries) remain unaffected.
  if (strictNoChain) return undefined;
  if (!policy.enabled) return undefined;
  if (policy.chain.length === 0) return undefined;

  const idx = policy.chain.indexOf(currentId);
  // D370 implicit-head: out-of-chain selected model → begin the walk
  // at the head of the chain (index 0) instead of returning undefined.
  // In-chain selected model → walk forward from idx + 1 (unchanged).
  const startIdx = idx === -1 ? 0 : idx + 1;

  for (let i = startIdx; i < policy.chain.length; i++) {
    const candidate = policy.chain[i];
    if (!candidate) continue;
    // D370 implicit-head dedupe: never re-attempt the originally
    // selected model during the walk. The selected model was attempt
    // #1; it just failed (or was skipped) and must not be revisited.
    if (candidate === initialModelId) {
      log(`[nautilo/agent] Skipping chain entry equal to initial selected model: ${candidate}`);
      continue;
    }
    if (!isModelHealthy(candidate)) {
      log(`[nautilo/agent] Skipping unhealthy chain entry: ${candidate}`);
      continue;
    }
    const availability = resolveRetainedModels([candidate], {
      purpose: needsVision
        ? requiresTools ? "vision-tools" : "vision"
        : requiresTools ? "chat-tools" : "chat",
    })[0]!;
    if (availability.availability !== "selectable") {
      log(`[nautilo/agent] Skipping unavailable chain entry: ${candidate}`);
      continue;
    }
    if (needsVision && !modelSupportsInput(candidate, "image")) {
      log(`[nautilo/agent] Skipping text-only chain entry (thread has images): ${candidate}`);
      continue;
    }
    if (!getModelById(candidate)) {
      log(`[nautilo/agent] Skipping unknown chain entry (not in catalog): ${candidate}`);
      continue;
    }
    return candidate;
  }
  return undefined;
}

/**
 * D141 P2 wire-in. Caller threads `userId` + optional `agentId` so the
 * resolver can read the right fallback policy at invocation time. The
 * chat path (agent.ts) always has both; system-task callers (LD-2)
 * should not call this function; internal roles resolve their own shared
 * candidate policy and fail truthfully when none is runnable.
 *
 * Pre-D141 callers that omit user/agent will fail the typecheck — this
 * is intentional. The single legitimate caller is `agent.ts`, which
 * already has `state.userId` and `state.agentId` in scope.
 */
export async function invokeChatModelWithFallback(
  messages: BaseMessage[],
  tools: StructuredTool[],
  initialModelId: string,
  userId: string,
  agentId: string | null,
  /**
   * D141 P3 — used by the runtime layer to scope `model.fallback`
   * events to the right room. Callers without a room context (system
   * tasks, tests) pass `null` and no WS events are emitted; the
   * fallback behavior is unchanged.
   */
  laneKey: string | null,
  invocationConfig?: RunnableConfig,
  invokeOptions?: {
    /** Global force: when false, reasoning output is off for every hop (e.g. conductor). */
    reasoningOutput?: boolean;
    /** Per-model operator override map (D331). Resolved per fallback hop; absent key ⇒ ON. */
    reasoningOverrides?: Record<string, boolean>;
    /**
     * D334 — opt direct `openai:*` reasoning models into the Responses API.
     * Off by default; conductor, health checks, and utility models do not pass this.
     */
    useOpenAIResponsesApi?: boolean;
    /**
     * D429 Phase 4 — explicit fallback mode. `"none"` (strict / no-chain)
     * suppresses every cross-model hop; `"agent_chain"` (default) preserves
     * the existing per-user/per-agent fallback chain. Foreground chat and
     * non-exact Task callers omit this (or pass `"agent_chain"`) so default
     * behavior is backwards-compatible.
     */
    modelFallbackMode?: ModelFallbackMode;
    /** Durable background queues own retries; suppress inline same-model retries there. */
    sameModelRetryMode?: "none" | "short";
    /** Per-attempt provider deadline. Foreground calls retain the existing default. */
    providerTimeoutMs?: number;
    /** Initial provider silence allowance. Existing progress-idle policy remains independent. */
    firstProgressTimeoutMs?: number;
    /** Concurrent tool-free advice uses a local supervisor, never the auditor's ambient turn sink. */
    isolatedProgress?: boolean;
    /** D462 server resolver, called afresh for every candidate attempt. */
    resolveForegroundControls?: ResolveForegroundModelControls;
    /** D526 content-free boundary used to project cache metadata per attempt. */
    preparedStableSystemPrefixLength?: number;
    /** D526 opaque Room UUID used only for provider routing affinity. */
    providerCacheRoomId?: string | null;
    /** Restricted research only: recover a rejected context on this same model. */
    recoverContext?: RecoverPreparedContext;
  },
): Promise<{ response: AIMessage; modelUsed: string }> {
  const callerProviderTimeoutMs = invokeOptions?.providerTimeoutMs;
  const callerFirstProgressTimeoutMs = invokeOptions?.firstProgressTimeoutMs;
  if (callerProviderTimeoutMs !== undefined && (!Number.isSafeInteger(callerProviderTimeoutMs) || callerProviderTimeoutMs < 1)) {
    throw new RangeError("providerTimeoutMs must be a positive safe integer");
  }
  if (callerFirstProgressTimeoutMs !== undefined && (!Number.isSafeInteger(callerFirstProgressTimeoutMs) || callerFirstProgressTimeoutMs < 1)) {
    throw new RangeError("firstProgressTimeoutMs must be a positive safe integer");
  }
  const policy = await resolveFallbackPolicy(userId, agentId);
  const strictNoChain = isStrictNoChain(invokeOptions?.modelFallbackMode);
  let currentModelId = initialModelId;
  const attemptedModels: string[] = [];
  const needsVision = messagesContainImageInputs(messages);
  const requiresTools = tools.length > 0;
  // D331 — resolve reasoning output PER hop: a per-model override map (foreground)
  // wins per `currentModelId`; otherwise the global boolean (default ON). This
  // ensures a fallback from an opted-out model A to model B honors B's setting.
  const resolveReasoningForModel = (modelId: string): boolean => {
    if (invokeOptions?.reasoningOverrides) {
      return invokeOptions.reasoningOverrides[modelId] ?? true;
    }
    return invokeOptions?.reasoningOutput ?? true;
  };
  let disableReasoningOutput = false;
  const assertNotCancelled = () => {
    if (invocationConfig?.signal?.aborted) throw invocationConfig.signal.reason instanceof Error
      ? invocationConfig.signal.reason : new Error("Model invocation cancelled by caller");
  };
  const recoverContext = async (source: PreparedContextRecoveryInput["source"]): Promise<boolean> => {
    if (!invokeOptions?.recoverContext) return false;
    assertNotCancelled();
    const estimatedMessageTokens = estimateTokenCount(messages);
    const limits = await resolveModelExecutionLimits(currentModelId);
    const maxMessageTokens = limits.contextTokens - estimateBoundToolTokens(tools) - COMPLETION_SAFETY_MARGIN_TOKENS;
    if (maxMessageTokens < 1) return false;
    const recovered = await invokeOptions.recoverContext({
      messages, modelId: currentModelId, contextWindowTokens: limits.contextTokens,
      estimatedMessageTokens, maxMessageTokens, source,
      ...(invocationConfig?.signal ? { signal: invocationConfig.signal } : {}),
    });
    assertNotCancelled();
    // A strictly decreasing integer estimate provides the termination bound.
    // An unchanged workspace must never become an unbounded provider retry.
    if (!recovered?.length || estimateTokenCount(recovered) >= estimatedMessageTokens) return false;
    messages = recovered;
    attemptedModels.pop();
    log(`[nautilo/agent] Reduced research context for ${currentModelId}; retrying the same model (${source})`);
    return true;
  };

  while (true) {
    assertNotCancelled();
    if (!hasStubModelForTests()) {
      const availability = resolveRetainedModels([currentModelId], {
        purpose: needsVision
          ? requiresTools ? "vision-tools" : "vision"
          : requiresTools ? "chat-tools" : "chat",
      })[0]!;
      if (availability.availability !== "selectable") {
        const next = nextInUserChain(
          currentModelId,
          policy,
          needsVision,
          requiresTools,
          initialModelId,
          strictNoChain,
        );
        if (next) {
          emitFallbackHop(currentModelId, next, "bad_request", laneKey);
          currentModelId = next;
          continue;
        }
        throw new ModelUnavailableError(
          currentModelId,
          availability.availability,
          availability.unavailableReason ?? "model is not runnable for chat",
        );
      }
    }
    const modelConfig = getModelById(currentModelId);
    if (!modelConfig) {
      throw new Error(`No available models remaining. Attempted: ${attemptedModels.join(", ")}`);
    }
    if (needsVision && !modelSupportsInput(currentModelId, "image")) {
      log(`[nautilo/agent] Current model ${currentModelId} is text-only but thread has images; consulting user chain for vision-capable hop`);
      const skipTo = nextInUserChain(currentModelId, policy, needsVision, requiresTools, initialModelId, strictNoChain);
      if (!skipTo) throw new Error(`No vision-capable models in fallback chain after ${currentModelId}`);
      // D141 P3 — vision-incompatibility classifies as a capability
      // mismatch (FriendlyErrorCategory: bad_request), same posture
      // as `messageImpliesCapabilityMismatch` returning bad_request.
      emitFallbackHop(currentModelId, skipTo, "bad_request", laneKey);
      currentModelId = skipTo;
      continue;
    }

    attemptedModels.push(currentModelId);

    let maxTokens: number;
    try {
      maxTokens = await resolveCompletionBudget(currentModelId, messages, tools);
    } catch (error) {
      if (isPreparedContextExceededError(error)) {
        if (await recoverContext("preflight")) continue;
        // Recovery-enabled research retains its configured route even when
        // immutable instructions themselves cannot fit.
        if (invokeOptions?.recoverContext) throw error;
        log(`[nautilo/agent] Model ${currentModelId} cannot fit prepared messages; consulting user chain for fallback`);
        const next = nextInUserChain(currentModelId, policy, needsVision, requiresTools, initialModelId, strictNoChain);
        if (!next) throw error;
        // D141 P3 — preflight token budget rejection is the
        // context_exceeded user-visible category (same mapping as
        // `mapCategory("TOKEN_LIMIT")`).
        emitFallbackHop(currentModelId, next, "context_exceeded", laneKey);
        currentModelId = next;
        continue;
      }
      throw error;
    }

    const recoveryVisibility = invokeOptions?.recoverContext ? contextRecoveryVisibilityFence() : null;
    try {
      log(`[nautilo/agent] Attempting model: ${currentModelId}`);
      const controls = invokeOptions?.resolveForegroundControls?.(currentModelId);
      if (controls && controls.canonicalModelId !== currentModelId) {
        throw new Error(`Resolved foreground controls belong to "${controls.canonicalModelId}", not attempted model "${currentModelId}".`);
      }
      const serving = controls?.servingProfileId === undefined ? undefined : resolveFireworksKimiK3ServingProfile(currentModelId, controls.servingProfileId);
      const requestedReasoningEffort = controls?.reasoningEffort;
      const reasoningOutput = resolveReasoningForModel(currentModelId) && !disableReasoningOutput && requestedReasoningEffort !== "off";
      const stableSystemPrefixLength = invokeOptions?.preparedStableSystemPrefixLength ?? 0;
      const openAIExplicitPromptCache =
        invokeOptions?.useOpenAIResponsesApi === true
        && modelUsesOpenAIExplicitPromptCache(currentModelId)
        && hasProjectableStableSystemPrefix(messages, stableSystemPrefixLength);
      const attemptProvider = modelRouteProvider(currentModelId);
      const openRouterSessionId = attemptProvider === "openrouter"
        ? invokeOptions?.providerCacheRoomId ?? undefined
        : undefined;
      const fireworksSessionAffinityId = attemptProvider === "fireworks"
        ? invokeOptions?.providerCacheRoomId ?? undefined
        : undefined;
      const model = await createUniversalModel(currentModelId, {
        maxTokens,
        // Foreground attempts are supervised above. `null` deliberately
        // suppresses the provider wrapper's unrelated 120s default; an
        // explicit caller absolute remains owned by the supervisor.
        timeoutMs: null,
        reasoningOutput,
        ...(requestedReasoningEffort === undefined ? {} : { reasoningEffort: requestedReasoningEffort }),
        ...(serving === undefined ? {} : { servingProfileId: serving.profileId }),
        ...(invokeOptions?.useOpenAIResponsesApi === true
          ? { useOpenAIResponsesApi: true }
          : {}),
        ...(openAIExplicitPromptCache ? { openAIExplicitPromptCache: true } : {}),
        ...(openRouterSessionId ? { openRouterSessionId } : {}),
        ...(fireworksSessionAffinityId ? { fireworksSessionAffinityId } : {}),
      });
      const modelWithTools = model.bindTools!(tools);
      // D526 — project the stable cache breakpoint for the provider that is
      // actually running. Room controls and fallback can change the selected
      // provider after pre-model prepared this byte-identical prompt.
      const attemptMessages = projectPreparedMessagesForModelCache(
        messages,
        currentModelId,
        stableSystemPrefixLength,
        { openAIExplicitPromptCache },
      );
      const llmCallConfig = {
        ...invocationConfig,
        ...(recoveryVisibility ? { callbacks: CallbackManager.configure(invocationConfig?.callbacks, [recoveryVisibility.handler])! } : {}),
        metadata: {
          ...((invocationConfig as Record<string, unknown> | undefined)?.["metadata"] as Record<string, unknown> | undefined),
          node_name: "agent-reasoning",
          model_id: currentModelId,
        },
      };
      const response = await invokeForegroundAttemptWithUsageContext(
        modelWithTools,
        attemptMessages,
        llmCallConfig,
        currentModelId,
        agentId,
        controls,
        serving,
        reasoningOutput,
        invokeOptions?.sameModelRetryMode ?? "short",
        {
          ...(callerProviderTimeoutMs === undefined ? {} : { providerTimeoutMs: callerProviderTimeoutMs }),
          callerSuppliedProviderTimeout: callerProviderTimeoutMs !== undefined,
          ...(callerFirstProgressTimeoutMs === undefined ? {} : { firstProgressTimeoutMs: callerFirstProgressTimeoutMs }),
          ...(invokeOptions?.isolatedProgress ? { isolatedProgress: true } : {}),
        },
      );
      if (attemptedModels.length > 1) log(`[nautilo/agent] Model ${currentModelId} succeeded after ${attemptedModels.length - 1} fallback(s)`);
      return { response, modelUsed: currentModelId };
    } catch (error) {
      // The caller owns this cancellation. It must bypass error
      // classification, health cooldown, reasoning retries, and chain
      // fallback even if the provider surfaced a timeout-shaped AbortError.
      if (invocationConfig?.signal?.aborted) throw error;
      const classified = classifyError(error);
      if (classified.category === "TOKEN_LIMIT" && invokeOptions?.recoverContext) {
        // Never retry after visible partial output, or echo a provider error
        // that could include the rejected source payload.
        if (recoveryVisibility?.hasVisibleOutput() || hasAssistantVisibleOutputForCurrentTurn(agentId)) throw error;
        if (await recoverContext("provider")) continue;
        throw error;
      }
      log(
        `[nautilo/agent] Model ${currentModelId} failed: ${error instanceof Error ? error.message : String(error)} ` +
          `(${classified.category}, retryable=${classified.retryable})`,
      );
      log(
        `[nautilo/agent] Model ${currentModelId} upstream details: ${formatProviderError(error)}`,
      );

      if (shouldCooldownAfterFailure(classified)) {
        markModelInvokeFailure(currentModelId, classified.message);
      }

      if (planChatModelInvokeRetry(classified, disableReasoningOutput) === "retry_same_model_no_reasoning") {
        log(
          `[nautilo/agent] Thinking config rejected for ${currentModelId}; retrying once with reasoning disabled`,
        );
        disableReasoningOutput = true;
        attemptedModels.pop();
        continue;
      }
      disableReasoningOutput = false;

      if (!shouldFallbackToNextModel(classified)) throw error;

      if (hasAssistantVisibleOutputForCurrentTurn(agentId)) {
        log(
          `[nautilo/agent] Refusing fallback from ${currentModelId} after assistant-visible output this turn`,
        );
        throw error;
      }

      const nextModelId = nextInUserChain(currentModelId, policy, needsVision, requiresTools, initialModelId, strictNoChain);
      if (!nextModelId) {
        // No more chain entries (or policy disabled). Friendly-error
        // translator at runtime/job.ts:LD-7 picks up the throw and
        // converts to the bracketed `[MDL00x]` chat message (LD-9).
        throw error;
      }
      // D141 P3 — surface the hop to the user via the room-scoped
      // `model.fallback` WS event so the workbench can render the
      // inline "X failed — trying Y" notice on the in-flight bubble.
      // `mapCategory` collapses the 8-bucket internal enum into the
      // 7-bucket user-visible enum (same one used by LD-9 codes).
      emitFallbackHop(currentModelId, nextModelId, mapCategory(classified.category), laneKey);
      log(`[nautilo/agent] Falling back from ${currentModelId} to ${nextModelId} (user chain)`);
      currentModelId = nextModelId;
    }
  }
}
