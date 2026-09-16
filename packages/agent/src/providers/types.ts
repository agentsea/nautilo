import type { Callbacks } from "@langchain/core/callbacks/manager";
import type { BaseMessageLike } from "@langchain/core/messages";
import { REASONING_LEVEL_VALUES } from "@nautilo/types";
import type { FireworksKimiK3ServingProfileId } from "./serving-profile";

export interface ProviderInitOptions {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export interface ModelInvokeOptions {
  [key: string]: unknown;
}

export interface ChatModel<M extends BaseMessageLike = BaseMessageLike, R = unknown> {
  invoke(messages: M[], options?: ModelInvokeOptions): Promise<R>;
  stream?: (
    messages: M[],
    options?: ModelInvokeOptions,
  ) => AsyncIterable<R> | Promise<AsyncIterable<R>>;
  bindTools?: (tools: unknown[], options?: Record<string, unknown>) => ChatModel<M, R>;
}

/**
 * Venice-specific request parameters that map to the top-level `venice_parameters`
 * field on the chat completion request body. See
 * https://docs.venice.ai/api-reference/api-spec for full schema.
 *
 * Wire behavior: these values are composed into `modelKwargs.venice_parameters`
 * and spread into the OpenAI-compatible request body by `@langchain/openai`'s
 * `ChatOpenAI` (see `chat_models/completions.js:49`). The Python canonical form
 * is `ChatOpenAI(..., extra_body={"venice_parameters": {...}})` per
 * https://docs.venice.ai/overview/guides/langchain .
 *
 * Safety: The factory hardcodes `include_venice_system_prompt: false` for every
 * Venice call regardless of caller input — if Venice's default system prompt
 * were allowed through it would overwrite Nautilo's prompt engineering.
 *
 * Fields supported by Venice (2026-04-20 swagger):
 *   - `include_venice_system_prompt` (boolean, default true — we force false)
 *   - `strip_thinking_response` (boolean, strips <think>…</think> blocks)
 *   - `disable_thinking` (boolean, disables thinking channel entirely)
 *   - `enable_web_search` ("auto" | "on" | "off", string enum not boolean)
 *   - `enable_web_scraping` (boolean, $0.01/URL via Firecrawl)
 *   - `enable_web_citations` (boolean, request inline citations)
 *   - `enable_x_search` (boolean, Grok-family xAI search)
 *   - `include_search_results_in_stream` (boolean)
 *   - `return_search_results_as_documents` (boolean)
 *   - `enable_e2ee` (boolean, toggles E2EE vs TEE-only on dual-capable models)
 *   - `character_slug` (string — ignore in Nautilo; we own persona handling)
 */
export interface VeniceParameters {
  include_venice_system_prompt?: boolean;
  strip_thinking_response?: boolean;
  disable_thinking?: boolean;
  enable_web_search?: "auto" | "on" | "off";
  enable_web_scraping?: boolean;
  enable_web_citations?: boolean;
  enable_x_search?: boolean;
  include_search_results_in_stream?: boolean;
  return_search_results_as_documents?: boolean;
  enable_e2ee?: boolean;
  character_slug?: string;
}

export interface CreateModelOptions extends ProviderInitOptions {
  modelId: string;
  /** LangChain constructor callbacks (e.g. usage metering handler). */
  callbacks?: Callbacks;
  maxTokens?: number;
  /**
   * Per-request timeout (ms) forwarded to the LangChain wrapper's
   * `timeout` constructor field. `undefined` falls back to
   * `DEFAULT_PROVIDER_TIMEOUT_MS` (120 s); `null` deliberately omits it for
   * an Agent-supervised foreground attempt. Every wrapper
   * we use (`ChatOpenAI`, `ChatAnthropic`, `ChatGoogleGenerativeAI`,
   * `ChatXAI`, `ChatFireworks`, and the OpenAI-compatible Together client)
   * accepts `timeout`.
   * Without this, a hung upstream call has no escape and the agent
   * dies silently.
   */
  timeoutMs?: number | null;
  /**
   * Arbitrary pass-through fields forwarded into `ChatOpenAI.modelKwargs`.
   * Currently only honored by `createOpenAI` — other factories ignore it.
   * For Venice, callers should pass `veniceParameters` to `createUniversalModel`
   * (which composes them into `modelKwargs.venice_parameters` with the
   * non-overridable `include_venice_system_prompt: false` safety default);
   * direct use of this field is for advanced callers that need raw wire-level
   * control.
   */
  modelKwargs?: Record<string, unknown>;
  /**
   * When true, reasoning-capable models request provider reasoning output
   * (Anthropic adaptive thinking) so stream chunks reset the idle watchdog.
   * Caller-scoped: foreground chat opts in; utility/health/conductor stay off.
   */
  reasoningOutput?: boolean;
  /**
   * D331 — reasoning effort (Anthropic `output_config.effort`; maps to
   * provider effort knobs elsewhere). Defaults to `"medium"` when unset.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * D462 — reviewed Fireworks Kimi K3 serving choice. This is intentionally
   * not a general provider-kwargs surface: the factory resolves this closed
   * profile id into the only verified Fireworks request shapes.
   */
  fireworksServingProfileId?: FireworksKimiK3ServingProfileId;
  /**
   * D526 — opaque Room-scoped Fireworks cache affinity. Closed provider
   * option; only a valid UUID is projected as `x-session-affinity`.
   */
  fireworksSessionAffinityId?: string;
  /**
   * D334 — when true, direct `openai:*` reasoning models may use the OpenAI
   * Responses API (`ChatOpenAI.useResponsesApi`). Explicit opt-in only;
   * non-OpenAI providers and OpenRouter/Venice/Fireworks/gateway paths ignore
   * this flag. Foreground agent callers thread it via `invokeChatModelWithFallback`.
   */
  useOpenAIResponsesApi?: boolean;
  /**
   * D526 — direct GPT-5.6 Responses requests use the provider's explicit
   * stable-prefix breakpoint contract. Closed provider option; ignored by
   * non-OpenAI routes.
   */
  openAIExplicitPromptCache?: boolean;
}

/**
 * Provider-neutral user vocabulary. `off` is normalized from provider-specific
 * disablement values (for example OpenAI's `none`) and is valid only where a
 * reviewed provider/model mapping explicitly supports it.
 */
export const REASONING_EFFORT_VALUES = ["off", ...REASONING_LEVEL_VALUES] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORT_VALUES as readonly string[]).includes(value);
}
