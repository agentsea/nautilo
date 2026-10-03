import { ChatOpenAI } from "@langchain/openai";
import type { ChatModel, ReasoningEffort } from "./types";
import type { QualifiedSurplusChatRoute } from "./surplus-route";
import { OpenRouterReasoningCompletions } from "./openrouter-reasoning";
import { openAICompatibleReasoningModelKwargs, openRouterSessionModelKwargs } from "./factory";
import {
  VeniceChatOpenAICompletions,
  wrapVeniceModelForToolSchemas,
} from "./venice-compat";

const SURPLUS_API_ROOT = "https://api.surplusintelligence.ai/v1";
const SURPLUS_CHAT_PATH = "/v1/chat/completions";

export interface SurplusWireReceipt {
  readonly requestId?: string;
  readonly servedBy?: string;
  readonly providerFamily?: string;
  readonly marketplaceAttempts?: number;
  readonly buyerCostMicro?: number;
  readonly adaptedParameters?: string;
  readonly truncated: boolean;
}

export class SurplusOutcomeUnknownError extends Error {
  readonly code = "surplus_outcome_unknown" as const;

  constructor() {
    super("The Surplus request may have been processed or billed. Check its request status before trying again.");
    this.name = "SurplusOutcomeUnknownError";
  }
}

/** Only a proven, unserved and uncharged refusal may switch transports. */
export function isSafeSurplusDirectFallback(
  error: unknown,
  responseStatus: number | undefined,
  receipt: SurplusWireReceipt | undefined,
  visibleOutput: boolean,
): boolean {
  if (visibleOutput || responseStatus !== 404) return false;
  if (receipt?.marketplaceAttempts !== 0 || receipt.buyerCostMicro !== 0) return false;
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return code === "no_sellers_for_model";
}

function nonEmpty(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function nonnegativeInteger(value: string | null): number | undefined {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function readSurplusWireReceipt(headers: Headers): SurplusWireReceipt {
  const requestId = nonEmpty(headers.get("x-request-id"));
  const servedBy = nonEmpty(headers.get("x-si-served-by"));
  const providerFamily = nonEmpty(headers.get("x-si-provider-family"));
  const marketplaceAttempts = nonnegativeInteger(headers.get("x-si-marketplace-attempts"));
  const buyerCostMicro = nonnegativeInteger(headers.get("x-si-buyer-cost-micro"));
  const adaptedParameters = nonEmpty(headers.get("x-si-adapted-params"));
  const truncated = headers.get("x-si-truncated")?.trim();
  return {
    ...(requestId ? { requestId } : {}),
    ...(servedBy ? { servedBy } : {}),
    ...(providerFamily ? { providerFamily } : {}),
    ...(marketplaceAttempts !== undefined ? { marketplaceAttempts } : {}),
    ...(buyerCostMicro !== undefined ? { buyerCostMicro } : {}),
    ...(adaptedParameters ? { adaptedParameters } : {}),
    // An unreadable truncation signal cannot certify a complete answer.
    truncated: truncated !== undefined && truncated !== "0",
  };
}

/**
 * The SDK's HTTP hook sees headers before it begins consuming a stream.
 * Fail closed on redirects or a changed target: no Surplus credential may be
 * forwarded to another origin or endpoint.
 */
export function createSurplusObservedFetch(
  onResponse: (receipt: SurplusWireReceipt, status: number) => Promise<void> | void,
  fetchImpl: typeof fetch = globalThis.fetch,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = input instanceof Request ? input.url : String(input);
    const url = new URL(target);
    if (url.origin !== "https://api.surplusintelligence.ai" || url.pathname !== SURPLUS_CHAT_PATH) {
      throw new Error("Surplus request target is outside the qualified chat endpoint.");
    }
    const response = await fetchImpl(input, { ...init, redirect: "error" });
    try {
      await onResponse(readSurplusWireReceipt(response.headers), response.status);
    } catch (error) {
      // Stop an unread stream when its receipt fails validation. Cancellation
      // cannot prove that the upstream stopped or that the request was free.
      try {
        await response.body?.cancel();
      } catch {
        // Preserve the receipt failure even if the connection already closed.
      }
      throw error;
    }
    return response;
  }) as typeof fetch;
}

export interface CreateSurplusChatModelInput {
  readonly route: QualifiedSurplusChatRoute;
  readonly apiKey: string;
  readonly maxOutputTokens: number;
  readonly reasoningEffort?: ReasoningEffort;
  readonly reasoningOutput?: boolean;
  readonly openrouterSessionId?: string;
  readonly onResponse: (receipt: SurplusWireReceipt, status: number) => Promise<void> | void;
  readonly fetchImpl?: typeof fetch;
}

/** Surplus may repeat the terminal choice when attaching its final usage receipt. */
class SurplusOpenRouterCompletions extends OpenRouterReasoningCompletions {
  override invocationParams(
    ...args: Parameters<OpenRouterReasoningCompletions["invocationParams"]>
  ) {
    const params = super.invocationParams(...args);
    // Surplus documents max_tokens as the canonical budget field and
    // max_completion_tokens as its equivalent alias. Preserve the value.
    if (params.max_completion_tokens !== undefined) {
      params.max_tokens = params.max_completion_tokens;
      delete params.max_completion_tokens;
    }
    return params;
  }

  override async *_streamResponseChunks(
    ...args: Parameters<OpenRouterReasoningCompletions["_streamResponseChunks"]>
  ) {
    // State belongs to this stream, so concurrent invocations cannot share a
    // terminal marker. Keep the SDK's final usage chunk and all reasoning.
    let terminalReason: string | undefined;
    for await (const chunk of super._streamResponseChunks(...args)) {
      const reason: unknown = chunk.generationInfo?.["finish_reason"];
      if (typeof reason === "string") {
        if (terminalReason !== undefined) {
          const hasToolDelta = "tool_call_chunks" in chunk.message
            && Array.isArray(chunk.message.tool_call_chunks) && chunk.message.tool_call_chunks.length > 0;
          // LangChain concatenates string metadata, so a repeated terminal
          // marker would otherwise become `tool_callstool_calls`.
          if (reason === terminalReason && chunk.text === "" && !hasToolDelta) {
            delete chunk.generationInfo?.["finish_reason"];
            delete chunk.generationInfo?.["model_name"];
          }
          // Keep conflicting markers intact for the completion validator.
          // Finishing the stream first retains its final charge receipt.
        } else {
          terminalReason = reason;
        }
      }
      // LangChain's callback-preferred streaming invoke path concatenates
      // generation chunks directly and does not project generationInfo onto
      // message metadata. Room streaming uses that path, while plain invoke
      // uses the SDK's normal projection. Keep both paths semantically equal.
      chunk.message.response_metadata = {
        ...chunk.generationInfo,
        ...chunk.message.response_metadata,
      };
      yield chunk;
    }
  }
}

/** Server-funded, pinned text-chat wire. Caller owns attempt persistence. */
export function createSurplusChatModel(input: CreateSurplusChatModelInput): ChatModel {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("Surplus credential is not configured.");
  if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1) {
    throw new Error("Invalid Surplus output budget.");
  }
  if (input.maxOutputTokens > input.route.maxOutputTokens) {
    throw new Error("Surplus output budget exceeds the qualified route limit.");
  }
  const isVenice = input.route.providerPin === "venice";
  const base = {
    model: input.route.surplusModelId,
    apiKey,
    maxTokens: input.maxOutputTokens,
    maxRetries: 0,
    streaming: true,
    streamUsage: true,
    modelKwargs: {
      provider: input.route.providerPin,
      ...openAICompatibleReasoningModelKwargs({
        modelId: input.route.catalogModelId,
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        ...(input.reasoningOutput === undefined ? {} : { reasoningOutput: input.reasoningOutput }),
      }, input.maxOutputTokens),
      ...(input.route.providerPin === "openrouter"
        ? openRouterSessionModelKwargs(input.openrouterSessionId)
        : {}),
      ...(isVenice
        ? { venice_parameters: { include_venice_system_prompt: false } }
        : {}),
    },
    configuration: {
      baseURL: SURPLUS_API_ROOT,
      fetch: createSurplusObservedFetch(input.onResponse, input.fetchImpl),
    },
  };
  const model = new ChatOpenAI({
    ...base,
    ...(isVenice
      ? { completions: new VeniceChatOpenAICompletions(base) }
      : input.route.providerPin === "openrouter"
        ? { completions: new SurplusOpenRouterCompletions(base) }
        : {}),
  }) as unknown as ChatModel;
  return isVenice
    ? wrapVeniceModelForToolSchemas(model)
    : model;
}
