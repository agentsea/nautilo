import type { BaseMessageLike } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatFireworks } from "@langchain/fireworks";
import { ChatXAI } from "@langchain/xai";
import type { ChatModel, CreateModelOptions, ReasoningEffort } from "./types";
import { getModelMaxOutputTokens } from "./models";
import { DEFAULT_PROVIDER_TIMEOUT_MS } from "./errors";
import { wrapGeminiModelForToolSanitization } from "./gemini-schema";
import { wrapAnthropicModelForToolSchemas } from "./anthropic-schema";
import { resolveFireworksKimiK3ServingProfile } from "./serving-profile";
import { getActiveModelCatalogSync } from "../config/model-catalog/runtime-catalog";
import { OpenRouterReasoningCompletions } from "./openrouter-reasoning";
import { OpenAIGpt6Completions } from "./openai-compat";
import {
  VeniceChatOpenAICompletions,
  wrapVeniceModelForToolSchemas,
} from "./venice-compat";

/**
 * Minimum max_tokens headroom required before we turn reasoning on. Adaptive
 * thinking auto-manages its own depth (NO token ceiling), but a tiny budget
 * (e.g. health checks at maxTokens=5) leaves no room for a useful answer.
 */
const MIN_REASONING_HEADROOM_TOKENS = 2048;

const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14" as const;

/** Default reasoning effort when the operator hasn't set one (D331). */
const DEFAULT_REASONING_EFFORT = "medium" as const;

const OPAQUE_ROOM_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fireworksAffinityHeaders(options: CreateModelOptions): Record<string, string> | undefined {
  const affinityId = options.fireworksSessionAffinityId?.trim();
  if (!affinityId || !OPAQUE_ROOM_UUID_PATTERN.test(affinityId)) return undefined;
  return { "x-session-affinity": affinityId };
}

type WireReasoningEffort = Exclude<ReasoningEffort, "off">;

/**
 * Provider wire vocabularies are intentionally narrower than the normalized
 * catalog vocabulary. Per-model catalog validation remains the authority for
 * what a selected model advertises; this adapter is the second, provider-wire
 * boundary that prevents a supported level for one provider leaking to another.
 */
const PROVIDER_WIRE_REASONING_EFFORTS = {
  anthropic: ["low", "medium", "high", "xhigh", "max"],
  openrouter: ["minimal", "low", "medium", "high", "max"],
  venice: ["low", "medium", "high"],
  fireworks: ["low", "medium", "high", "max"],
  "openai-responses": ["minimal", "low", "medium", "high", "xhigh", "max"],
} as const satisfies Record<string, readonly WireReasoningEffort[]>;

function requestedReasoningEffort(options: CreateModelOptions): ReasoningEffort {
  return options.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
}

function assertProviderReasoningEffort(
  provider: keyof typeof PROVIDER_WIRE_REASONING_EFFORTS,
  effort: ReasoningEffort,
): asserts effort is WireReasoningEffort {
  if ((PROVIDER_WIRE_REASONING_EFFORTS[provider] as readonly string[]).includes(effort)) return;
  throw new Error(
    `Reasoning effort "${effort}" is not supported by the ${provider} provider mapping.`,
  );
}

function reasoningRequested(options: CreateModelOptions, maxTokens: number): boolean {
  const entry = getActiveModelCatalogSync().catalog.entries.find(
    (candidate) => candidate.id === options.modelId,
  );
  return (
    options.reasoningOutput === true &&
    entry?.features?.reasoning === true &&
    Number.isFinite(maxTokens) &&
    maxTokens >= MIN_REASONING_HEADROOM_TOKENS
  );
}

function reasoningEnabled(options: CreateModelOptions, maxTokens: number): boolean {
  return reasoningRequested(options, maxTokens) && requestedReasoningEffort(options) !== "off";
}

/**
 * Anthropic reasoning request fields.
 *
 * Live-probed 2026-06-16: Opus 4.7 AND 4.8 reject the legacy
 * `{type:"enabled", budget_tokens}` form ("use thinking.type.adaptive and
 * output_config.effort"); Sonnet 4.6 accepts both. All three accept ADAPTIVE,
 * so we use adaptive UNIFORMLY — no per-model branching, no token ceiling.
 * Depth is governed by `output_config.effort` (low|medium|high), not a budget.
 */
function anthropicReasoningFields(
  options: CreateModelOptions,
  maxTokens: number,
): Record<string, unknown> {
  if (reasoningRequested(options, maxTokens)) {
    assertProviderReasoningEffort("anthropic", requestedReasoningEffort(options));
  }
  if (!reasoningEnabled(options, maxTokens)) return {};
  const effort = requestedReasoningEffort(options);
  return {
    thinking: { type: "adaptive" },
    outputConfig: { effort },
    temperature: 1,
    betas: [INTERLEAVED_THINKING_BETA],
  };
}

function providerFromModelId(modelId: string): string | undefined {
  return modelId.includes(":") ? modelId.split(":")[0]!.toLowerCase() : undefined;
}

/**
 * D334 — OpenAI-only transport policy: direct `openai:*` reasoning models use
 * the Responses API only when explicitly opted in. Timeout budgets for
 * model-attempt liveness policy is independent of this selection — both Chat
 * Completions and Responses paths share the same reasoning-capability gate for
 * effort/headroom.
 */
export function shouldUseOpenAIResponsesApi(
  options: CreateModelOptions,
  maxTokens: number,
): boolean {
  if (providerFromModelId(options.modelId) !== "openai") return false;
  if (
    options.openAIExplicitPromptCache === true
    && /^openai:gpt-5\.6(?:-|$)/i.test(options.modelId.trim())
  ) {
    return true;
  }
  if (options.useOpenAIResponsesApi !== true) return false;
  return reasoningRequested(options, maxTokens);
}

function openAICompatibleReasoningModelKwargs(
  options: CreateModelOptions,
  maxTokens: number,
): Record<string, unknown> {
  const provider = providerFromModelId(options.modelId);
  // Normal invocation disables reasoning output for explicit off. Process that
  // control before the output/headroom gate; hiding output alone never disables
  // computation. Only a catalogued, optional reasoning control grants this.
  if (options.reasoningEffort === "off" && (provider === "openrouter" || provider === "fireworks")) {
    const entry = getActiveModelCatalogSync().catalog.entries.find((candidate) => candidate.id === options.modelId);
    const control = entry && "controls" in entry ? entry.controls?.reasoning : undefined;
    if (entry?.features?.reasoning !== true || control?.canDisable !== true || control.mandatory !== false) {
      throw new Error(`Reasoning effort "off" is not supported by the catalog controls for ${options.modelId}.`);
    }
    return provider === "openrouter" ? { reasoning: { enabled: false } } : { reasoning_effort: "none" };
  }
  if (!reasoningRequested(options, maxTokens)) return {};
  const effort = requestedReasoningEffort(options);
  switch (provider) {
    case "openrouter":
      assertProviderReasoningEffort("openrouter", effort);
      // OpenRouter normalizes reasoning across upstream providers under
      // `reasoning`; `exclude:false` lets reasoning deltas reset our watchdog.
      return { reasoning: { effort, exclude: false } };
    case "venice": {
      assertProviderReasoningEffort("venice", effort);
      return { reasoning_effort: effort };
    }
    case "fireworks": {
      assertProviderReasoningEffort("fireworks", effort);
      // OpenAI Chat Completions-compatible providers accept the OpenAI-style
      // effort knob as a top-level request body field.
      return { reasoning_effort: effort };
    }
    case "openai":
      // Live-probed 2026-06-18: direct OpenAI Chat Completions rejects
      // `reasoning_effort` when function tools are bound for GPT-5.5:
      // "Please use /v1/responses instead." Keep GPT reasoning-capable for
      // watchdog budgets, but D334 owns the Responses API migration.
      return {};
    default:
      return {};
  }
}

function resolveTimeoutMs(options: CreateModelOptions): number | undefined {
  return options.timeoutMs === null ? undefined : options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
}

export function stripProviderPrefix(modelId: string): string {
  return String(modelId || "").replace(
    /^(openai|anthropic|google|xai|fireworks|together|openrouter|gateway|venice):/i,
    "",
  );
}

const FIREWORKS_DEEPSEEK_V4_FLASH_ALIAS =
  "accounts/fireworks/models/deepseek-v4-flash" as const;
const FIREWORKS_DEEPSEEK_V4_FLASH_DEPLOYMENT =
  "accounts/fireworks/models/deepseek-v4-flash-0731" as const;

/**
 * Resolve catalog-facing Fireworks aliases to an actual deployed model path.
 *
 * Fireworks' authenticated model registry exposes DeepSeek V4 Flash only as
 * the dated `-0731` deployment. Older persisted selections may still carry
 * the shorter stable alias, so normalize it before both catalog-limit lookup
 * and provider dispatch.
 */
export function resolveFireworksWireModel(model: string): string {
  return model === FIREWORKS_DEEPSEEK_V4_FLASH_ALIAS
    ? FIREWORKS_DEEPSEEK_V4_FLASH_DEPLOYMENT
    : model;
}

function resolveFireworksExecutionModelId(modelId: string): string {
  const stripped = stripProviderPrefix(modelId);
  const deployed = resolveFireworksWireModel(stripped);
  return deployed === stripped ? modelId : `fireworks:${deployed}`;
}

/** @internal Ensures every provider request stays under its signed model ceiling. */
export async function resolveFactoryMaxTokens(
  options: CreateModelOptions,
  capabilityOptions?: Parameters<typeof getModelMaxOutputTokens>[1],
): Promise<number> {
  const modelCeiling = await getModelMaxOutputTokens(options.modelId, capabilityOptions);
  return options.maxTokens === undefined
    ? modelCeiling
    : Math.min(options.maxTokens, modelCeiling);
}

export async function createOpenAI(options: CreateModelOptions): Promise<ChatModel<BaseMessageLike, unknown>> {
  const maxTokens = await resolveFactoryMaxTokens(options);
  const useResponsesApi = shouldUseOpenAIResponsesApi(options, maxTokens);
  // `@langchain/openai` only forwards `configuration.*` into the underlying
  // OpenAI SDK client; top-level `baseURL` is silently dropped, and there is
  // no top-level `headers` field at all. OpenRouter attribution headers
  // (`HTTP-Referer`, `X-OpenRouter-Title`) and any other caller-supplied
  // headers must be merged into `configuration.defaultHeaders`, which the
  // SDK forwards on every outbound chat-completion request.
  const configuration: Record<string, unknown> = {};
  if (options.baseUrl) configuration["baseURL"] = options.baseUrl;
  if (options.headers && Object.keys(options.headers).length > 0) {
    configuration["defaultHeaders"] = { ...options.headers };
  }
  const timeoutMs = resolveTimeoutMs(options);
  const base: Record<string, unknown> = {
    model: stripProviderPrefix(options.modelId),
    maxTokens,
    streamUsage: true,
    ...(Object.keys(configuration).length > 0 ? { configuration } : {}),
  };
  if (timeoutMs !== undefined) base["timeout"] = timeoutMs;
  if (options.callbacks) base["callbacks"] = options.callbacks;
  if (options.apiKey) base["apiKey"] = options.apiKey;
  if (useResponsesApi) {
    if (reasoningRequested(options, maxTokens)) {
      const requestedEffort = requestedReasoningEffort(options);
      const effort = requestedEffort === "off" ? "none" : requestedEffort;
      if (requestedEffort !== "off") {
        assertProviderReasoningEffort("openai-responses", requestedEffort);
      }
      base["reasoning"] = { effort };
    }
    base["useResponsesApi"] = true;
    if (options.openAIExplicitPromptCache === true) {
      // The installed OpenAI SDK types predate explicit breakpoint fields,
      // while LangChain's Responses adapter deliberately spreads modelKwargs
      // into the final request. Keep this closed to the D526 mode.
      base["modelKwargs"] = {
        prompt_cache_options: { mode: "explicit" },
      };
    }
  } else {
    const modelKwargs = {
      ...openAICompatibleReasoningModelKwargs(options, maxTokens),
      ...(options.modelKwargs ?? {}),
    };
    // Pass-through for provider-specific body fields (e.g. Venice's
    // `venice_parameters`). `@langchain/openai` spreads `modelKwargs` directly
    // into the chat completion request body — see chat_models/completions.js:49.
    if (Object.keys(modelKwargs).length > 0) {
      base["modelKwargs"] = modelKwargs;
    }
  }
  const isVenice = options.modelId.toLowerCase().startsWith("venice:");
  const isDirectOpenAI = options.modelId.toLowerCase().startsWith("openai:");
  const llm = new ChatOpenAI({ ...base,
    ...(!useResponsesApi && options.modelId.toLowerCase().startsWith("openrouter:")
      ? { completions: new OpenRouterReasoningCompletions(base) }
      : !useResponsesApi && isVenice
        ? { completions: new VeniceChatOpenAICompletions(base) }
        : !useResponsesApi && isDirectOpenAI
          ? { completions: new OpenAIGpt6Completions(base) }
        : {}),
  });
  const model = llm as unknown as ChatModel<BaseMessageLike, unknown>;
  return isVenice ? wrapVeniceModelForToolSchemas(model) : model;
}

export async function createAnthropic(options: CreateModelOptions): Promise<ChatModel<BaseMessageLike, unknown>> {
  const maxTokens = await resolveFactoryMaxTokens(options);
  const timeoutMs = resolveTimeoutMs(options);
  const base: Record<string, unknown> = {
    model: stripProviderPrefix(options.modelId),
    maxTokens,
    streamUsage: true,
    ...anthropicReasoningFields(options, maxTokens),
  };
  if (timeoutMs !== undefined) base["timeout"] = timeoutMs;
  if (options.apiKey) base["apiKey"] = options.apiKey;
  if (options.callbacks) base["callbacks"] = options.callbacks;
  // `@langchain/anthropic` honors `anthropicApiUrl` (NOT `baseURL`) — see
  // chat_models.js where `this.apiUrl = fields?.anthropicApiUrl`.
  if (options.baseUrl) base["anthropicApiUrl"] = options.baseUrl;
  const llm = new ChatAnthropic(base);
  if ((llm as unknown as Record<string, unknown>)["topP"] === -1) (llm as unknown as Record<string, unknown>)["topP"] = undefined;
  if ((llm as unknown as Record<string, unknown>)["temperature"] === -1) (llm as unknown as Record<string, unknown>)["temperature"] = undefined;
  return wrapAnthropicModelForToolSchemas(
    llm as unknown as ChatModel<BaseMessageLike, unknown>,
  );
}

export async function createAnthropicWithLongContext(options: CreateModelOptions): Promise<ChatModel<BaseMessageLike, unknown>> {
  const maxTokens = await resolveFactoryMaxTokens(options, { anthropicLongContextBeta: true });
  const reasoning = anthropicReasoningFields(options, maxTokens);
  const betas = ["context-1m-2025-08-07", ...(reasoning["betas"] as string[] | undefined ?? [])];
  const timeoutMs = resolveTimeoutMs(options);
  const base: Record<string, unknown> = {
    model: stripProviderPrefix(options.modelId),
    maxTokens,
    betas,
    streamUsage: true,
    ...Object.fromEntries(Object.entries(reasoning).filter(([k]) => k !== "betas")),
  };
  if (timeoutMs !== undefined) base["timeout"] = timeoutMs;
  if (options.apiKey) base["apiKey"] = options.apiKey;
  if (options.callbacks) base["callbacks"] = options.callbacks;
  // Long-context variant must honor the same `anthropicApiUrl` routing as the
  // standard `createAnthropic` factory; otherwise a caller-supplied baseUrl
  // (proxy, gateway, regional endpoint) is silently dropped on the long-context
  // path while it works on the short-context path.
  if (options.baseUrl) base["anthropicApiUrl"] = options.baseUrl;
  const llm = new ChatAnthropic(base);
  return wrapAnthropicModelForToolSchemas(
    llm as unknown as ChatModel<BaseMessageLike, unknown>,
  );
}

export async function createGemini(options: CreateModelOptions): Promise<ChatModel<BaseMessageLike, unknown>> {
  const maxTokens = await resolveFactoryMaxTokens(options);
  // ChatGoogleGenerativeAI does not expose a top-level `timeout`
  // field; per @langchain/google-genai the per-request timeout is set
  // via `requestOptions: { timeout }` (forwarded to the underlying
  // GoogleGenerativeAI client). The agent loop also wraps invokes in
  // its own Promise.race timeout with `ProviderTimeoutError` as a
  // belt-and-suspenders safety net.
  const timeoutMs = resolveTimeoutMs(options);
  const config: Record<string, unknown> = {
    model: stripProviderPrefix(options.modelId),
    maxOutputTokens: maxTokens,
    streamUsage: true,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.callbacks ? { callbacks: options.callbacks } : {}),
  };
  if (timeoutMs !== undefined) config["requestOptions"] = { timeout: timeoutMs };
  const llm = new ChatGoogleGenerativeAI(config as unknown as ConstructorParameters<typeof ChatGoogleGenerativeAI>[0]);
  // The sanitizer recursively wraps the concrete model returned by each
  // bindTools call. It exposes that delegate through `bound`, so callback
  // inspection follows the actual bound runnable rather than a copied/stale
  // callback array on an inert wrapper.
  return wrapGeminiModelForToolSanitization(
    llm as unknown as ChatModel<BaseMessageLike, unknown>,
  );
}

export async function createFireworks(options: CreateModelOptions): Promise<ChatModel<BaseMessageLike, unknown>> {
  // Fireworks OpenAI-compatible ids are full serverless paths, e.g.
  // `accounts/fireworks/models/kimi-k2p6` — keep the path after `fireworks:`.
  const serving = options.fireworksServingProfileId === undefined
    ? undefined
    : resolveFireworksKimiK3ServingProfile(options.modelId, options.fireworksServingProfileId);
  const model = resolveFireworksWireModel(
    stripProviderPrefix(serving?.effectiveModelId ?? options.modelId),
  );
  const shortModel = model.includes("/") ? model.split("/").pop()! : model;
  const maxTokens = await resolveFactoryMaxTokens({
    ...options,
    modelId: resolveFireworksExecutionModelId(options.modelId),
  });
  // LangChain/Fireworks: non-streaming invoke can fail or truncate on long outputs;
  // enable token streaming whenever the resolved budget exceeds a small threshold.
  const useStreaming = maxTokens > 4096;
  const reasoningKwargs = openAICompatibleReasoningModelKwargs(options, maxTokens);
  const modelKwargs = {
    ...(serving?.requestModelKwargs ?? {}),
    ...reasoningKwargs,
  };
  const affinityHeaders = fireworksAffinityHeaders(options);
  const timeoutMs = resolveTimeoutMs(options);

  try {
    const base: Record<string, unknown> = {
      model,
      maxTokens,
      streaming: useStreaming,
      streamUsage: true,
    };
    if (timeoutMs !== undefined) base["timeout"] = timeoutMs;
    if (options.apiKey) base["apiKey"] = options.apiKey;
    if (options.callbacks) base["callbacks"] = options.callbacks;
    if (Object.keys(modelKwargs).length > 0) base["modelKwargs"] = modelKwargs;
    if (affinityHeaders) base["configuration"] = { defaultHeaders: affinityHeaders };
    const llm = new ChatFireworks(base);
    // @langchain/fireworks@0.1.3 unconditionally replaces the requested
    // `streamUsage: true` with false in its constructor. Fireworks' current
    // OpenAI-compatible streaming API supports `stream_options.include_usage`
    // and returns usage in the final chunk, so restore the requested value
    // after construction. Keeping ChatFireworks preserves its provider-specific
    // removal of unsupported request fields.
    llm.streamUsage = true;
    return llm as unknown as ChatModel<BaseMessageLike, unknown>;
  } catch {
    const modelForFallback = model.includes("/") ? model : shortModel;
    const base: Record<string, unknown> = {
      model: modelForFallback,
      maxTokens,
      streaming: useStreaming,
      streamUsage: true,
      configuration: {
        baseURL: options.baseUrl || "https://api.fireworks.ai/inference/v1",
        ...(affinityHeaders ? { defaultHeaders: affinityHeaders } : {}),
      },
    };
    if (timeoutMs !== undefined) base["timeout"] = timeoutMs;
    if (options.apiKey) base["apiKey"] = options.apiKey;
    if (options.callbacks) base["callbacks"] = options.callbacks;
    if (Object.keys(modelKwargs).length > 0) base["modelKwargs"] = modelKwargs;
    const llm = new ChatOpenAI(base);
    return llm as unknown as ChatModel<BaseMessageLike, unknown>;
  }
}

export async function createXAI(options: CreateModelOptions): Promise<ChatModel<BaseMessageLike, unknown>> {
  const maxTokens = await resolveFactoryMaxTokens(options);
  const timeoutMs = resolveTimeoutMs(options);
  const base: Record<string, unknown> = {
    model: stripProviderPrefix(options.modelId),
    maxTokens,
    streamUsage: true,
  };
  if (timeoutMs !== undefined) base["timeout"] = timeoutMs;
  if (options.apiKey) base["apiKey"] = options.apiKey;
  if (options.callbacks) base["callbacks"] = options.callbacks;
  const llm = new ChatXAI(base);
  return llm as unknown as ChatModel<BaseMessageLike, unknown>;
}

export async function createTogether(options: CreateModelOptions): Promise<ChatModel<BaseMessageLike, unknown>> {
  return createTogetherWithDependencies(options, {
    createClient: (fields) => new ChatOpenAI(fields) as unknown as ChatModel<BaseMessageLike, unknown>,
  });
}

export interface TogetherFactoryDependencies {
  readonly createClient: (fields: Record<string, unknown>) => ChatModel<BaseMessageLike, unknown>;
}

/**
 * Constructs Together through its documented OpenAI-compatible endpoint.
 * Keeping this seam directly testable preserves dormant `together:*` profile
 * compatibility without pulling the broad `@langchain/community` runtime
 * dependency into the production image.
 */
export async function createTogetherWithDependencies(
  options: CreateModelOptions,
  dependencies: TogetherFactoryDependencies,
): Promise<ChatModel<BaseMessageLike, unknown>> {
  const togetherBase = options.baseUrl || "https://api.together.xyz/v1";
  const maxTokens = await resolveFactoryMaxTokens(options);
  const timeoutMs = resolveTimeoutMs(options);
  const fields: Record<string, unknown> = {
    model: stripProviderPrefix(options.modelId),
    maxTokens,
    configuration: { baseURL: togetherBase },
    streamUsage: true,
  };
  if (timeoutMs !== undefined) fields["timeout"] = timeoutMs;
  if (options.apiKey) fields["apiKey"] = options.apiKey;
  if (options.callbacks) fields["callbacks"] = options.callbacks;
  return dependencies.createClient(fields);
}
