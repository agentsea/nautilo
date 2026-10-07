import { randomUUID } from "node:crypto";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import { recordLlmUsage, type RecordUsageInput } from "./record-usage";
import { getUsageContext, normalizeUsageRoomId } from "./usage-context";
import { createToolProviderCostRecorder } from "./provider-cost-recorder";
import { estimateProviderToolCostUsd } from "@nautilo/db";

export interface ExtractedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  actualCostUsd: number | null;
  /** Content-free provider response/request identity when the adapter exposes one. */
  providerRequestId?: string;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function explicitProviderRequestId(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  for (const key of [
    "request_id", "requestID", "requestId", "_request_id",
    "response_id", "responseId", "id",
  ] as const) {
    const candidate = record[key];
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (!normalized || /^(?:run|lc[_-]?run|langchain)[_:-]/iu.test(normalized)) continue;
    return normalized;
  }
  return undefined;
}

function recognizedProviderMessageId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  // LangChain callback run ids are commonly UUIDs or `run-*`. Only accept
  // provider-owned response-id namespaces from AIMessage.id.
  return /^(?:chatcmpl-|resp_|msg_|gen-)/u.test(normalized)
    ? normalized
    : undefined;
}

export function extractNativeWebSearchRequests(output: LLMResult): number {
  let requests = 0;
  const generations = (output.generations ?? []) as unknown[][];
  for (const row of generations) {
    for (const generation of row) {
      const message = asRecord(asRecord(generation)?.["message"]);
      const additional = asRecord(message?.["additional_kwargs"]);
      const toolOutputs = additional?.["tool_outputs"];
      if (Array.isArray(toolOutputs)) {
        requests += toolOutputs.filter((entry) => {
          const type = asRecord(entry)?.["type"];
          return typeof type === "string" && type.toLowerCase() === "web_search_call";
        }).length;
      }
      const responseMetadata = asRecord(message?.["response_metadata"]);
      const responseUsage = asRecord(responseMetadata?.["usage"]);
      const serverToolUse = asRecord(responseUsage?.["server_tool_use"]);
      requests += num(serverToolUse?.["web_search_requests"]);
    }
  }
  return requests;
}

/**
 * Pull normalized token usage out of a LangChain `LLMResult`. Prefers the
 * per-message `usage_metadata` (present on all providers with `streamUsage`),
 * falling back to the OpenAI-style `llmOutput.tokenUsage`. Also best-effort
 * extracts a provider-reported dollar cost (OpenRouter/gateway) where present.
 */
export function extractUsageFromLLMResult(output: LLMResult): ExtractedUsage | null {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens: number | undefined;
  let reasoningTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let actualCostUsd: number | null = null;
  const explicitMetadataRequestIds = new Set<string>();
  const fallbackMessageRequestIds = new Set<string>();

  const generations = (output.generations ?? []) as unknown[][];
  for (const row of generations) {
    for (const gen of row) {
      const message = asRecord(asRecord(gen)?.["message"]);
      const messageRequestId = recognizedProviderMessageId(message?.["id"]);
      const um = asRecord(message?.["usage_metadata"]);
      const respMeta = asRecord(message?.["response_metadata"]);
      const respUsage = asRecord(respMeta?.["usage"]);
      const responseRequestId = explicitProviderRequestId(respMeta);
      if (responseRequestId) explicitMetadataRequestIds.add(responseRequestId);
      else if (messageRequestId) fallbackMessageRequestIds.add(messageRequestId);
      if (um) {
        inputTokens += num(um["input_tokens"]);
        outputTokens += num(um["output_tokens"]);
        totalTokens = (totalTokens ?? 0) + num(um["total_tokens"]);
        const inDetails = asRecord(um["input_token_details"]);
        const normalizedCacheRead = num(inDetails?.["cache_read"]);
        const normalizedCacheCreation = num(inDetails?.["cache_creation"]);
        if (inDetails) {
          cachedInputTokens += normalizedCacheRead;
          cacheCreationTokens += normalizedCacheCreation;
        }
        // OpenRouter's OpenAI-compatible usage object reports explicit cache
        // writes as `prompt_tokens_details.cache_write_tokens`. LangChain 1.4
        // normalizes `cached_tokens` but not that write field. Its streaming
        // final chunk can retain the raw usage object in response_metadata, so
        // use it only when the canonical usage metadata did not already supply
        // the same value. Non-streaming adapters that discard raw metadata
        // remain an evidence gap rather than a value we invent.
        const rawInputDetails =
          asRecord(respUsage?.["prompt_tokens_details"]) ??
          asRecord(respUsage?.["input_tokens_details"]);
        if (normalizedCacheRead === 0) {
          cachedInputTokens += num(rawInputDetails?.["cached_tokens"]);
        }
        if (normalizedCacheCreation === 0) {
          cacheCreationTokens += num(rawInputDetails?.["cache_write_tokens"]);
        }
        const outDetails = asRecord(um["output_token_details"]);
        if (outDetails) reasoningTokens += num(outDetails["reasoning"]);
      }
      // Provider-reported cost (OpenRouter surfaces `usage.cost` on response_metadata).
      const cost = respUsage?.["cost"] ?? respMeta?.["cost"];
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
        actualCostUsd = (actualCostUsd ?? 0) + cost;
      }
    }
  }

  const llmOutput = asRecord(output.llmOutput);
  const outputRequestId = explicitProviderRequestId(llmOutput);
  if (inputTokens === 0 && outputTokens === 0) {
    const tokenUsage = asRecord(llmOutput?.["tokenUsage"]) ?? asRecord(llmOutput?.["estimatedTokenUsage"]);
    if (tokenUsage) {
      inputTokens = num(tokenUsage["promptTokens"]);
      outputTokens = num(tokenUsage["completionTokens"]);
      totalTokens = num(tokenUsage["totalTokens"]) || undefined;
    }
  }

  // Prefer an adapter's explicit request reference over its response/message
  // identity. Some providers expose both for the same wire and they need not
  // be equal. Conflicting ids at the same evidence level remain unbound.
  const providerRequestId = explicitMetadataRequestIds.size > 0
    ? explicitMetadataRequestIds.size === 1
      ? explicitMetadataRequestIds.values().next().value as string
      : undefined
    : outputRequestId
      ?? (fallbackMessageRequestIds.size === 1
        ? fallbackMessageRequestIds.values().next().value as string
        : undefined);
  if (inputTokens === 0 && outputTokens === 0 && actualCostUsd === null
    && providerRequestId === undefined) return null;

  return {
    inputTokens,
    outputTokens,
    ...(totalTokens ? { totalTokens } : {}),
    reasoningTokens,
    cachedInputTokens,
    cacheCreationTokens,
    actualCostUsd,
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
  };
}

type RecordUsageFn = (input: RecordUsageInput) => void;

let recordUsageImpl: RecordUsageFn = recordLlmUsage;

/**
 * Test-only seam to assert exactly-once persistence without touching the DB.
 * Requires `NAUTILO_TEST_MODE=stub`.
 */
export function __setUsageRecorderForTests(fn: RecordUsageFn | null): void {
  if (process.env["NAUTILO_TEST_MODE"] !== "stub") {
    throw new Error("Usage recorder test seam requires NAUTILO_TEST_MODE=stub");
  }
  recordUsageImpl = fn ?? recordLlmUsage;
}

/**
 * A LangChain callback handler bound to one model id. On every successful LLM
 * completion it records a usage row, attributing it to the ambient
 * {@link getUsageContext} (user/room/call-type) when a call site set one.
 */
class UsageCallbackHandler extends BaseCallbackHandler {
  name = "nautilo_usage";

  constructor(private readonly modelId: string) {
    super();
  }

  override handleLLMEnd(output: LLMResult, runId?: string): void {
    const usage = extractUsageFromLLMResult(output);
    const ctx = getUsageContext();
    // Surplus has a durable pre-wire attempt row and exact buyer receipt.
    // Recording a second callback row would double-count this invocation.
    if (ctx?.funding?.providerRoute === "surplus") return;
    if (ctx?.trackedAttemptId) {
      if (usage) ctx.onAttemptUsage?.(usage);
      return;
    }
    const nativeSearchRequests = extractNativeWebSearchRequests(output);
    const nativeSearchProvider = this.modelId.startsWith("openai:")
      ? "openai"
      : this.modelId.startsWith("anthropic:") ? "anthropic" : null;
    if (nativeSearchRequests > 0 && nativeSearchProvider) {
      const recordProviderCost = createToolProviderCostRecorder({
        userId: ctx?.userId,
        roomId: ctx?.roomId,
        agentId: ctx?.metadata?.["agentId"],
        turnId: ctx?.metadata?.["turnId"],
      });
      const estimatedCostUsd = estimateProviderToolCostUsd(
        `${nativeSearchProvider}:web_search_call`,
        nativeSearchRequests,
      );
      if (estimatedCostUsd) void recordProviderCost({
        provider: nativeSearchProvider,
        operation: "native_web_search",
        receiptId: `${runId ?? randomUUID()}:native-web-search`,
        estimatedCostUsd,
        evidenceState: "estimated",
      });
    }
    if (!usage) return;
    try {
      recordUsageImpl({
        model: this.modelId,
        callType: ctx?.callType ?? "other",
        userId: ctx?.userId ?? ctx?.funding?.humanUserId ?? null,
        roomId: normalizeUsageRoomId(ctx?.roomId),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
        reasoningTokens: usage.reasoningTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        actualCostUsd: usage.actualCostUsd,
        ...(ctx?.modelControl ? { modelControl: ctx.modelControl } : {}),
        ...(ctx?.funding ? { funding: ctx.funding } : {}),
        ...(ctx?.metadata ? { metadata: ctx.metadata } : {}),
      });
    } catch {
      // Metering must never break a completed LLM call.
    }
  }
}

/** Constructor-safe factory for the shared `nautilo_usage` LangChain handler. */
export function createUsageCallbackHandler(modelId: string): BaseCallbackHandler {
  return new UsageCallbackHandler(modelId);
}

/** Count effective `nautilo_usage` handlers on a model or RunnableBinding chain. */
export function countNautiloUsageCallbacks(model: unknown): number {
  const handlers = new Set<unknown>();
  let current: unknown = model;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const callbacks = (current as { callbacks?: unknown }).callbacks;
    if (Array.isArray(callbacks)) {
      for (const cb of callbacks) {
        if (
          cb &&
          typeof cb === "object" &&
          (cb as { name?: unknown }).name === "nautilo_usage"
        ) {
          handlers.add(cb);
        }
      }
    }
    const inner = (current as { bound?: unknown }).bound;
    if (!inner) break;
    current = inner;
  }
  return handlers.size;
}
