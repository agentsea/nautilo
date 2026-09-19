import {
  isReasoningEffort,
  type ChatModel,
  type CreateModelOptions,
  type VeniceParameters,
} from "./types";
import {
  isFireworksKimiK3ServingProfileId,
  FIREWORKS_KIMI_K3_MODEL_ID,
} from "./serving-profile";
import {
  createOpenAI,
  createAnthropic,
  createAnthropicWithLongContext,
  createGemini,
  createFireworks,
  createXAI,
  createTogether,
} from "./factory";
import { VENICE_API_V1_BASE } from "./venice-api";
import { getModelById, type VeniceRouting } from "../config/assistant-models";
import { resolveChinaUpstreamConsent } from "../config/resolved-catalog";
import { createUsageCallbackHandler } from "../usage/usage-callback";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import {
  getStubModelForTests,
  setStubModelForTests,
} from "./stub-model-state";
import { resolveOpenRouterTransport } from "./openrouter-transport";

/**
 * Compose the final `venice_parameters` object that will be forwarded on the
 * chat completion request body.
 *
 * Precedence (lowest → highest wins):
 *   1. Raw `venice_parameters` pulled from `modelKwargs.venice_parameters`
 *      (escape-hatch path for advanced callers).
 *   2. Typed `veniceParameters` (canonical API for Venice-specific fields).
 *   3. Nautilo safety defaults (non-overridable — see below).
 *
 * Safety default: `include_venice_system_prompt: false` is NON-OVERRIDABLE by
 * callers. If Venice's default system prompt were allowed through it would
 * prepend on top of Nautilo's prompt engineering (verified in Venice swagger —
 * the field defaults to `true` server-side).
 */
function composeVeniceParameters(
  caller?: VeniceParameters,
  fromModelKwargs?: Record<string, unknown>,
): VeniceParameters {
  return {
    ...(fromModelKwargs ?? {}),
    ...(caller ?? {}),
    include_venice_system_prompt: false,
  };
}

/**
 * Test-only seam for deterministic LangGraph runs without API keys.
 * Throws unless `NAUTILO_TEST_MODE=stub` is set — production cannot
 * register a stub accidentally.
 */
export function __setStubModelForTests(model: ChatModel | null): void {
  setStubModelForTests(model);
}

const DEFAULT_GATEWAY_LABEL = "OpenAI-compatible gateway";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve the catalog `routing` for a `venice:*` id. Returns:
 *   - the curated routing class when the id is in `ASSISTANT_MODELS`
 *   - `undefined` for custom (non-curated) `venice:*` ids whose upstream
 *     routing the agent cannot classify
 */
function resolveVeniceRouting(id: string): VeniceRouting | undefined {
  return getModelById(id.trim())?.routing;
}

function readAllowChinaUpstreamFlag(cleanOptions: Record<string, unknown>): boolean {
  const fromOptions = cleanOptions["allowChinaUpstream"];
  return resolveChinaUpstreamConsent(typeof fromOptions === "boolean" ? fromOptions : undefined);
}

/**
 * Runtime enforcement of the picker's China-routing gate (D086 Phase 4 review
 * blocker #1). `getEligibleModels()` hides china-routed Venice catalog SKUs
 * unless `allowChinaUpstream` is true, but a custom `venice:*` id can still be
 * saved as a profile defaultModel and invoked directly through
 * `createUniversalModel`. This gate fires before any wire request goes out:
 *
 *   - curated `china-anonymized` SKUs require explicit opt-in
 *   - custom (non-curated) `venice:*` ids have unknown routing (could resolve
 *     to a Chinese upstream); also require explicit opt-in
 *   - curated `venice-hosted` / `western-anonymized` rows pass without opt-in
 *
 * The opt-in flag is read first from caller `options.allowChinaUpstream`,
 * then from `NAUTILO_ALLOW_CHINA_UPSTREAM` env (`1` / `true` / `yes`).
 */
function assertVeniceRoutingAllowed(id: string, allowChinaUpstream: boolean): void {
  const routing = resolveVeniceRouting(id);
  if (routing === "venice-hosted" || routing === "western-anonymized") return;
  if (allowChinaUpstream) return;
  if (routing === "china-anonymized") {
    throw new Error(
      `Venice model "${id}" routes through a China-anonymized upstream. ` +
      `Set NAUTILO_ALLOW_CHINA_UPSTREAM=1 (or pass { allowChinaUpstream: true }) to opt in.`,
    );
  }
  throw new Error(
    `Venice model "${id}" is not in the curated catalog so its upstream routing cannot be classified. ` +
    `Custom venice:* ids could route through a China-anonymized upstream; refusing to invoke without opt-in. ` +
    `Set NAUTILO_ALLOW_CHINA_UPSTREAM=1 (or pass { allowChinaUpstream: true }) if you understand the routing.`,
  );
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value as Record<string, unknown>)) {
    const normalized = nonEmptyString(headerValue);
    if (normalized) headers[key] = normalized;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function buildOpenRouterHeaders(cleanOptions: Record<string, unknown>): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  const referer = safeHeaderValue(
    cleanOptions["openRouterReferer"] ??
      cleanOptions["openrouterReferer"] ??
      process.env?.["OPENROUTER_HTTP_REFERER"],
  );
  const title = safeHeaderValue(
    cleanOptions["openRouterTitle"] ??
      cleanOptions["openrouterTitle"] ??
      process.env?.["OPENROUTER_TITLE"],
  );

  if (referer) headers["HTTP-Referer"] = referer;
  if (title) headers["X-OpenRouter-Title"] = title;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function safeHeaderValue(value: unknown): string | undefined {
  const normalized = nonEmptyString(value);
  if (!normalized || /[\r\n]/.test(normalized)) return undefined;
  return normalized;
}

export function buildOpenRouterCreateModelOptions(
  modelId: string,
  cleanOptions: Record<string, unknown>,
  callbacks?: Callbacks,
): CreateModelOptions {
  const transport = resolveOpenRouterTransport({
    directApiKey: cleanOptions["apiKey"],
  });
  if (!transport) {
    throw new Error("The OpenRouter credential is not configured for this model route.");
  }
  const options: CreateModelOptions = {
    modelId,
    apiKey: transport.apiKey,
    baseUrl: transport.baseUrl,
    ...(transport.kind === "managed-gateway"
      ? { maxRetries: 0, forbidRedirects: true }
      : {}),
  };
  if (callbacks) options.callbacks = callbacks;
  const headers = transport.kind === "openrouter"
    ? buildOpenRouterHeaders(cleanOptions)
    : undefined;
  if (headers) options.headers = headers;
  const sessionId = nonEmptyString(cleanOptions["openRouterSessionId"]);
  if (sessionId && UUID_PATTERN.test(sessionId)) {
    options.modelKwargs = { session_id: sessionId };
  }
  return options;
}

function normalizeGatewayBaseUrl(value: unknown): string | undefined {
  const baseUrl = nonEmptyString(value);
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return baseUrl.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function gatewayLabel(cleanOptions: Record<string, unknown>): string {
  return (
    safeHeaderValue(cleanOptions["gatewayLabel"]) ??
    safeHeaderValue(cleanOptions["label"]) ??
    safeHeaderValue(process.env?.["NAUTILO_GATEWAY_LABEL"]) ??
    DEFAULT_GATEWAY_LABEL
  );
}

export function buildGatewayCreateModelOptions(
  modelId: string,
  cleanOptions: Record<string, unknown>,
  callbacks?: Callbacks,
): { options: CreateModelOptions; label: string } {
  const label = gatewayLabel(cleanOptions);
  const apiKey = nonEmptyString(cleanOptions["apiKey"]) ?? nonEmptyString(process.env?.["NAUTILO_GATEWAY_API_KEY"]);
  if (!apiKey) {
    throw new Error(`Missing NAUTILO_GATEWAY_API_KEY for ${label}. Generic gateway requests do not use OPENAI_API_KEY fallback.`);
  }

  const baseUrl = normalizeGatewayBaseUrl(cleanOptions["baseUrl"] ?? cleanOptions["baseURL"] ?? process.env?.["NAUTILO_GATEWAY_BASE_URL"]);
  if (!baseUrl) {
    throw new Error(`Missing NAUTILO_GATEWAY_BASE_URL for ${label}. Set an http(s) OpenAI-compatible base URL.`);
  }

  return {
    label,
    options: {
      modelId,
      apiKey,
      baseUrl,
      ...(callbacks ? { callbacks } : {}),
    },
  };
}

export function withGatewayErrorLabel(
  model: ChatModel,
  label: string,
  policy: Readonly<{ sanitize?: boolean }> = {},
): ChatModel {
  const invoke: ChatModel["invoke"] = async (messages, options) => {
    try {
      return await model.invoke(messages, options);
    } catch (error) {
      throw labelGatewayError(error, label, policy.sanitize === true);
    }
  };
  const stream: NonNullable<ChatModel["stream"]> = async function* (messages, options) {
    if (!model.stream) {
      throw new Error(`${label} model does not support streaming`);
    }
    try {
      const stream = await model.stream(messages, options);
      for await (const chunk of stream) {
        yield chunk;
      }
    } catch (error) {
      throw labelGatewayError(error, label, policy.sanitize === true);
    }
  };
  const bindTools: NonNullable<ChatModel["bindTools"]> = (tools, options) => {
    if (!model.bindTools) {
      throw new Error(`${label} model does not support tool binding`);
    }
    return withGatewayErrorLabel(model.bindTools(tools, options), label, policy);
  };

  // Preserve the concrete LangChain instance and all of its configuration
  // fields. A plain facade breaks capability/config inspection and hides
  // RunnableBinding internals such as `bound`; the proxy replaces only the
  // three failure-producing methods while transparently forwarding everything
  // else to the real model.
  return new Proxy(model as ChatModel & object, {
    get(target, property, receiver) {
      if (property === "invoke") return invoke;
      if (property === "stream") return stream;
      if (property === "bindTools") return bindTools;
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  }) as ChatModel;
}

function managedGatewayFailureMessage(error: unknown): string {
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    name?: unknown;
    code?: unknown;
  } | null;
  const status = typeof candidate?.status === "number"
    ? candidate.status
    : typeof candidate?.statusCode === "number"
      ? candidate.statusCode
      : undefined;
  if (status === 401 || status === 403) return "The Gateway rejected the Nautilo credential.";
  if (status === 402) return "The Gateway reports insufficient test capacity.";
  if (status === 429) return "The Gateway rate-limited the request.";
  if (status !== undefined && status >= 500) return "The Gateway is temporarily unavailable.";
  if (
    candidate?.name === "AbortError"
    || candidate?.name === "ProviderTimeoutError"
    || candidate?.code === "NAUTILO_PROVIDER_TIMEOUT"
  ) {
    return "The Gateway request was cancelled or timed out.";
  }
  return "The Gateway request failed.";
}

function labelGatewayError(error: unknown, label: string, sanitize = false): Error {
  if (error instanceof Error) {
    if (!sanitize && error.message.startsWith(`${label}:`)) return error;
    const wrapped = new Error(`${label}: ${sanitize ? managedGatewayFailureMessage(error) : error.message}`);
    if (!sanitize) wrapped.cause = error;
    copyErrorStatus(error, wrapped);
    return wrapped;
  }
  return new Error(`${label}: ${sanitize ? managedGatewayFailureMessage(error) : String(error)}`);
}

/**
 * LangChain / OpenAI-compatible clients attach `status` / `statusCode` on HTTP
 * errors; preserve them on wrapped errors so `classifyError` still works.
 */
function copyErrorStatus(source: Error, target: Error): void {
  const src = source as Error & { status?: unknown; statusCode?: unknown };
  const tgt = target as Error & { status?: unknown; statusCode?: unknown };
  if (typeof src.status === "number") tgt.status = src.status;
  if (typeof src.statusCode === "number") tgt.statusCode = src.statusCode;
}

/**
 * Create a chat model by routing to direct provider factories.
 *
 * Bypasses LangChain's `initChatModel` because it wraps models in a
 * `ConfigurableModel` whose `_getModelInstance` calls `JSON.stringify(config)`
 * on the full LangGraph runtime config, which contains circular references.
 * This crashes PostgresSaver serialization.
 */
export async function createUniversalModel(
  modelId: string,
  options?: Record<string, unknown>,
): Promise<ChatModel> {
  const stubModel = getStubModelForTests();
  if (stubModel) {
    // Stub graph harness models stay intentionally unmetered to avoid test DB pollution.
    return stubModel;
  }
  const resolvedModelId = String(modelId || "");
  const usageCallback = createUsageCallbackHandler(resolvedModelId);
  return createUniversalModelInternal(modelId, options, [usageCallback]);
}

/**
 * Narrow development-evaluation seam. It preserves the exact provider factory,
 * credential, routing, timeout, and safety behavior while intentionally
 * omitting Nautilo's DB-backed usage callback. Exported only through the
 * `@nautilo/agent/model-evaluation` package subpath.
 */
export async function createUnmeteredEvaluationModel(
  modelId: string,
  options?: Record<string, unknown>,
): Promise<ChatModel> {
  const stubModel = getStubModelForTests();
  if (stubModel) return stubModel;
  return createUniversalModelInternal(modelId, options);
}

async function createUniversalModelInternal(
  modelId: string,
  options?: Record<string, unknown>,
  usageCallbacks?: Callbacks,
): Promise<ChatModel> {
  const id = String(modelId || "");
  if (!id) {
    throw new Error(`Invalid modelId: ${modelId}`);
  }

  const cleanOptions: Record<string, unknown> = {};
  if (options) {
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined && (value !== null || key === "timeoutMs")) {
        cleanOptions[key] = value;
      }
    }
  }

  const anthropicLongContext =
    typeof cleanOptions["anthropicLongContextBeta"] === "boolean"
      ? Boolean(cleanOptions["anthropicLongContextBeta"])
      : typeof cleanOptions["useClaudeLongContext"] === "boolean"
        ? Boolean(cleanOptions["useClaudeLongContext"])
        : typeof cleanOptions["useAnthropicLongContext"] === "boolean"
          ? Boolean(cleanOptions["useAnthropicLongContext"])
          : undefined;

  delete cleanOptions["anthropicLongContextBeta"];
  delete cleanOptions["useClaudeLongContext"];
  delete cleanOptions["useAnthropicLongContext"];

  const factoryOpts: CreateModelOptions = { modelId: id };
  if (usageCallbacks) factoryOpts.callbacks = usageCallbacks;
  const apiKey = cleanOptions["apiKey"] as string | undefined;
  const baseUrl = (cleanOptions["baseUrl"] ?? cleanOptions["baseURL"]) as string | undefined;
  const headers = readHeaders(cleanOptions["headers"]);
  if (apiKey) factoryOpts.apiKey = apiKey;
  if (baseUrl) factoryOpts.baseUrl = baseUrl;
  if (headers) factoryOpts.headers = headers;

  const resolvedMaxTokens =
    typeof cleanOptions["maxTokens"] === "number" &&
    Number.isFinite(cleanOptions["maxTokens"]) &&
    (cleanOptions["maxTokens"]) > 0
      ? Math.floor(cleanOptions["maxTokens"])
      : undefined;
  if (resolvedMaxTokens !== undefined) factoryOpts.maxTokens = resolvedMaxTokens;

  // `null` is intentional: supervised foreground attempts omit the wrapper's
  // 120s local timer. Omitted/invalid values keep the utility default.
  const resolvedTimeoutMs =
    typeof cleanOptions["timeoutMs"] === "number" &&
    Number.isFinite(cleanOptions["timeoutMs"]) &&
    (cleanOptions["timeoutMs"]) > 0
      ? Math.floor(cleanOptions["timeoutMs"])
      : cleanOptions["timeoutMs"] === null
        ? null
        : undefined;
  if (resolvedTimeoutMs !== undefined) factoryOpts.timeoutMs = resolvedTimeoutMs;
  delete cleanOptions["timeoutMs"];

  const reasoningOutput =
    typeof cleanOptions["reasoningOutput"] === "boolean"
      ? cleanOptions["reasoningOutput"]
      : false;
  delete cleanOptions["reasoningOutput"];
  factoryOpts.reasoningOutput = reasoningOutput;

  const reasoningEffortRaw = cleanOptions["reasoningEffort"];
  if (reasoningEffortRaw !== undefined) {
    if (!isReasoningEffort(reasoningEffortRaw)) {
      throw new Error("Unsupported reasoning effort.");
    }
    factoryOpts.reasoningEffort = reasoningEffortRaw;
  }
  delete cleanOptions["reasoningEffort"];

  const useOpenAIResponsesApi =
    typeof cleanOptions["useOpenAIResponsesApi"] === "boolean"
      ? cleanOptions["useOpenAIResponsesApi"]
      : false;
  delete cleanOptions["useOpenAIResponsesApi"];
  factoryOpts.useOpenAIResponsesApi = useOpenAIResponsesApi;

  const openAIExplicitPromptCache =
    typeof cleanOptions["openAIExplicitPromptCache"] === "boolean"
      ? cleanOptions["openAIExplicitPromptCache"]
      : false;
  delete cleanOptions["openAIExplicitPromptCache"];
  factoryOpts.openAIExplicitPromptCache = openAIExplicitPromptCache;

  const fireworksSessionAffinityId = nonEmptyString(
    cleanOptions["fireworksSessionAffinityId"],
  );
  delete cleanOptions["fireworksSessionAffinityId"];

  // Pass-through for caller-supplied Venice parameters and generic modelKwargs.
  const callerVeniceParameters = cleanOptions["veniceParameters"] as VeniceParameters | undefined;
  const callerModelKwargs = cleanOptions["modelKwargs"] as Record<string, unknown> | undefined;
  delete cleanOptions["veniceParameters"];
  delete cleanOptions["modelKwargs"];
  // Snapshot `allowChinaUpstream` for the venice gate, then strip it so it
  // cannot leak into any downstream factory's clean-options surface.
  const allowChinaUpstream = readAllowChinaUpstreamFlag(cleanOptions);
  delete cleanOptions["allowChinaUpstream"];

  const provider = id.includes(":") ? id.split(":")[0]!.toLowerCase() : undefined;
  const idLower = id.toLowerCase();

  const servingProfileRaw = cleanOptions["servingProfileId"];
  delete cleanOptions["servingProfileId"];
  if (servingProfileRaw !== undefined) {
    if (provider !== "fireworks" || id !== FIREWORKS_KIMI_K3_MODEL_ID) {
      throw new Error(`Serving profiles are not available for model "${id}".`);
    }
    if (!isFireworksKimiK3ServingProfileId(servingProfileRaw)) {
      throw new Error("Unsupported Fireworks Kimi K3 serving profile.");
    }
    factoryOpts.fireworksServingProfileId = servingProfileRaw;
  }

  switch (provider) {
    case "anthropic":
      if (anthropicLongContext) return createAnthropicWithLongContext(factoryOpts);
      return createAnthropic(factoryOpts);
    case "openai":
      return createOpenAI(factoryOpts);
    case "openrouter": {
      const orOpts = buildOpenRouterCreateModelOptions(id, cleanOptions, usageCallbacks);
      const openRouterTransport = resolveOpenRouterTransport({
        directApiKey: cleanOptions["apiKey"],
      });
      if (resolvedMaxTokens !== undefined) orOpts.maxTokens = resolvedMaxTokens;
      if (resolvedTimeoutMs !== undefined) orOpts.timeoutMs = resolvedTimeoutMs;
      orOpts.reasoningOutput = reasoningOutput;
      if (factoryOpts.reasoningEffort) orOpts.reasoningEffort = factoryOpts.reasoningEffort;
      const managedGateway = openRouterTransport?.kind === "managed-gateway";
      return withGatewayErrorLabel(
        await createOpenAI(orOpts),
        managedGateway ? "Nautilo Gateway" : "OpenRouter",
        { sanitize: managedGateway },
      );
    }
    case "gateway": {
      const gateway = buildGatewayCreateModelOptions(id, cleanOptions, usageCallbacks);
      if (resolvedMaxTokens !== undefined) gateway.options.maxTokens = resolvedMaxTokens;
      if (resolvedTimeoutMs !== undefined) gateway.options.timeoutMs = resolvedTimeoutMs;
      gateway.options.reasoningOutput = reasoningOutput;
      if (factoryOpts.reasoningEffort) gateway.options.reasoningEffort = factoryOpts.reasoningEffort;
      return withGatewayErrorLabel(await createOpenAI(gateway.options), gateway.label);
    }
    case "google":
      return createGemini(factoryOpts);
    case "xai":
      return createXAI(factoryOpts);
    case "fireworks":
      return createFireworks({
        ...factoryOpts,
        ...(fireworksSessionAffinityId && UUID_PATTERN.test(fireworksSessionAffinityId)
          ? { fireworksSessionAffinityId }
          : {}),
      });
    case "together":
      return createTogether(factoryOpts);
    case "venice": {
      // Routing gate (D086 Phase 4 review blocker #1) — fires before key
      // resolution / network access. Curated china-anonymized SKUs and any
      // custom (non-curated) `venice:*` id require explicit opt-in via
      // `options.allowChinaUpstream` or `NAUTILO_ALLOW_CHINA_UPSTREAM` env.
      assertVeniceRoutingAllowed(id, allowChinaUpstream);

      // Venice is OpenAI-wire-compatible. We route through createOpenAI with a
      // swapped baseURL and an explicit VENICE_API_KEY read.
      //
      // SECURITY: We MUST NOT let ChatOpenAI fall back to its built-in default
      // of process.env.OPENAI_API_KEY. Doing so would ship the user's OpenAI
      // bearer token to api.venice.ai. We throw early if no Venice credential
      // is available rather than leak a foreign-provider key.
      //
      // venice_parameters are composed with a non-overridable safety default
      // that disables Venice's own system prompt (otherwise it prepends over
      // Nautilo's). See composeVeniceParameters() above.
      const veniceApiKey = factoryOpts.apiKey ?? (typeof process !== "undefined" ? process.env?.["VENICE_API_KEY"] : undefined);
      if (!veniceApiKey) {
        throw new Error(
          `VENICE_API_KEY not set; cannot invoke Venice model "${id}". ` +
          `Set VENICE_API_KEY in your environment (get a key at https://venice.ai/settings/api) ` +
          `or pass { apiKey } when constructing the model. ` +
          `We refuse to fall back to OPENAI_API_KEY because that would ship your OpenAI key to api.venice.ai.`,
        );
      }
      // Extract any pre-existing venice_parameters from caller's modelKwargs
      // so we can merge (rather than silently overwrite) them with our typed
      // veniceParameters + safety default.
      const modelKwargsRest: Record<string, unknown> = { ...(callerModelKwargs ?? {}) };
      const veniceParamsFromModelKwargs = modelKwargsRest["venice_parameters"] as Record<string, unknown> | undefined;
      delete modelKwargsRest["venice_parameters"];
      const veniceParameters = composeVeniceParameters(callerVeniceParameters, veniceParamsFromModelKwargs);
      const modelKwargs = {
        ...modelKwargsRest,
        venice_parameters: veniceParameters,
      };
      return withGatewayErrorLabel(
        await createOpenAI({
          ...factoryOpts,
          apiKey: veniceApiKey,
          baseUrl: factoryOpts.baseUrl ?? VENICE_API_V1_BASE,
          modelKwargs,
        }),
        "Venice",
      );
    }
    default:
      if (idLower.includes("claude")) {
        if (anthropicLongContext) return createAnthropicWithLongContext(factoryOpts);
        return createAnthropic(factoryOpts);
      }
      if (idLower.includes("gpt") || idLower.includes("o1") || idLower.includes("o3")) {
        return createOpenAI(factoryOpts);
      }
      if (idLower.includes("gemini")) {
        return createGemini(factoryOpts);
      }
      return createOpenAI(factoryOpts);
  }
}
