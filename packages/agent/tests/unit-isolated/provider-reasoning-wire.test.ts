/** Real invocation/factory/serializer; only transport and DB configuration are hermetic. */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { AIMessage, AIMessageChunk, HumanMessage } from "@langchain/core/messages";
import { ChatOpenAICompletions } from "@langchain/openai";
import { ChatFireworks } from "@langchain/fireworks";
import { ChatAnthropic } from "@langchain/anthropic";
import { ModelCatalogSchema, type ModelCatalogReasoningEffort } from "@nautilo/types";
import { createAnthropic } from "../../src/providers/factory";
import { ModelOutputLimitError, modelResponseReachedOutputLimit } from "../../src/graph/model-output-limit";
import { modelOutputPreflightNode } from "../../src/nodes/model-output-preflight";
import type { NautiloState } from "../../src/agent/state";
import { configureRuntimeModelCatalog, getActiveModelCatalogSync, hydrateRuntimeModelCatalog, resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { resolveModelControlSelection, type ModelControlPolicy } from "../../src/config/model-control-selection";

const actualTrust = await import("@nautilo/trust");
mock.module("@nautilo/trust", () => ({ ...actualTrust,
  assertCanUseServerProviderCredentials: mock(async (humanUserId: string) => {
    expect(humanUserId).toBe("owner");
  }),
}));

const MODELS = [
  "openrouter:deepseek/deepseek-v4-flash-0731",
  "fireworks:accounts/fireworks/models/deepseek-v4p1-flash",
  "venice:openai-gpt-6-sol",
] as const;
const oldFetch = globalThis.fetch;
const keys = ["OPENROUTER_API_KEY", "FIREWORKS_API_KEY", "VENICE_API_KEY", "ANTHROPIC_API_KEY"] as const;
const oldKeys = keys.map((key) => process.env[key]);
const openAI = ChatOpenAICompletions.prototype as unknown as { completionWithRetry: unknown };
const fireworks = ChatFireworks.prototype as unknown as { completionWithRetry: unknown };
const anthropic = ChatAnthropic.prototype as unknown as { createStreamWithRetry: unknown };
const oldOpenAI = openAI.completionWithRetry;
const oldFireworks = fireworks.completionWithRetry;
const oldAnthropicStream = anthropic.createStreamWithRetry;
const oldFireworksTokens = ChatFireworks.prototype.getNumTokens;
const requests: Record<string, unknown>[] = [];
let rejectReasoningRequest = false;
let anthropicStopReason = "end_turn";
let invocation: typeof import("../../src/utils/chat-model-invocation");
let baseline: ReturnType<typeof getActiveModelCatalogSync>["catalog"];

beforeAll(async () => {
  for (const key of keys) process.env[key] = "synthetic-wire-test-key";
  globalThis.fetch = mock(async () => { throw new Error("Unexpected network in provider wire test"); }) as unknown as typeof fetch;
  mock.module("../../src/utils/resolve-fallback-policy", () => ({ resolveFallbackPolicy: async () => ({ enabled: false, chain: [] }) }));
  const realDb = await import("@nautilo/db");
  mock.module("@nautilo/db", () => ({ ...realDb, getCachedServerModelConfigRow: () => null,
    kickServerModelConfigRefresh: () => {}, refreshServerModelConfigCache: async () => null, primeServerModelConfigCache: () => {} }));
  invocation = await import("../../src/utils/chat-model-invocation");
  baseline = getActiveModelCatalogSync().catalog;
  const transport = async (request: Record<string, unknown>) => {
    requests.push(request);
    if (rejectReasoningRequest) {
      rejectReasoningRequest = false;
      throw Object.assign(new Error("reasoning_effort is unsupported"), { status: 400 });
    }
    if (request["stream"] === true) return (async function* () {
      yield { id: "wire", object: "chat.completion.chunk", model: request["model"], choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] };
      yield { id: "wire", object: "chat.completion.chunk", model: request["model"], choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } };
    })();
    return { id: "wire", object: "chat.completion", model: request["model"], choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } };
  };
  // The SDK estimates streaming usage after completion by downloading a
  // tokenizer. Keep that unrelated accounting hermetic; wire serialization and
  // real stream conversion remain intact.
  ChatFireworks.prototype.getNumTokens = async () => 1;
  openAI.completionWithRetry = transport;
  fireworks.completionWithRetry = transport;
  anthropic.createStreamWithRetry = async (request: Record<string, unknown>) => {
    requests.push(request);
    return (async function* () {
      yield { type: "message_start", message: { id: "wire", type: "message", role: "assistant", model: request["model"], content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } };
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
      yield { type: "content_block_stop", index: 0 };
      yield { type: "message_delta", delta: { stop_reason: anthropicStopReason, stop_sequence: null }, usage: { output_tokens: 1 } };
      yield { type: "message_stop" };
    })();
  };
});
afterAll(() => {
  openAI.completionWithRetry = oldOpenAI; fireworks.completionWithRetry = oldFireworks;
  anthropic.createStreamWithRetry = oldAnthropicStream;
  ChatFireworks.prototype.getNumTokens = oldFireworksTokens;
  globalThis.fetch = oldFetch;
  keys.forEach((key, index) => { if (oldKeys[index] === undefined) delete process.env[key]; else process.env[key] = oldKeys[index]; });
  mock.restore(); resetRuntimeModelCatalog();
});

async function catalog(
  mode: "optional" | "mandatory" | "absent" = "optional",
  limits: { contextTokens?: number; outputTokens?: number } = {},
) {
  const value = ModelCatalogSchema.parse({ ...baseline, catalogVersion: "2099.09.08.1", entries: baseline.entries.map((entry) => {
    if (!MODELS.some((id) => id === entry.id)) return entry;
    const levels = entry.provider === "openrouter"
      ? ["minimal", "low", "medium", "high", "xhigh", "max"]
      : entry.provider === "venice"
        ? ["low", "medium", "high", "xhigh", "max"]
        : ["low", "medium", "high", "max"];
    return { ...entry, defaultEnabled: true, limits: { contextTokens: limits.contextTokens ?? 32768, outputTokens: limits.outputTokens ?? 8192 }, controls: mode === "absent" ? undefined : { reasoning: {
      levels, defaultLevel: "high", canDisable: mode === "optional", mandatory: mode === "mandatory",
      provenance: { kind: "provider-documentation", provider: entry.provider, verifiedAt: "2026-09-08T00:00:00Z" },
    } } };
  }) });
  configureRuntimeModelCatalog({ loader: {
    get: async () => ({ catalog: value, source: "remote-fresh", stale: false, fetchedAt: "2099-09-08T00:00:00Z", originUrl: "https://catalog.invalid/wire", reason: "", catalogVersion: value.catalogVersion }),
    refresh: async () => {}, clearCache: () => {},
  } });
  await hydrateRuntimeModelCatalog(); requests.length = 0;
}

function call(modelId: string, effort?: ModelCatalogReasoningEffort, policy?: ModelControlPolicy, rawControl = false, reasoningOutput = true, sameModelRetryMode: "none" | "short" = "none") {
  return invocation.invokeChatModelWithFallback([new HumanMessage("Wire contract fixture")], [], modelId, "owner", "agent", null, { callbacks: [] }, {
    modelFallbackMode: "none", sameModelRetryMode, reasoningOutput, fundingHumanUserId: "owner",
    ...(effort === undefined ? {} : { resolveForegroundControls: (id: string) => {
      if (rawControl) return { canonicalModelId: id, reasoningEffort: effort };
      const resolved = resolveModelControlSelection({ catalogByModelId: new Map(getActiveModelCatalogSync().catalog.entries.map((entry) => [entry.id, entry])),
        catalogDefaultModelId: id, turnOverride: { modelId: id, reasoningEffort: effort },
        ...(policy ? { policyByModelId: new Map([[id, policy]]) } : {}) });
      if (resolved.status !== "resolved") throw new Error(resolved.reason);
      return { canonicalModelId: id, ...(resolved.effective.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.effective.reasoningEffort }) };
    } }),
  });
}

for (const model of MODELS) {
  test(`${model}: explicit off reaches the serialized request despite invocation disabling reasoning output`, async () => {
    await catalog();
    expect((await call(model, "off")).response.content).toBe("ok");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.["model"]).toBe(model.slice(model.indexOf(":") + 1));
    if (model.startsWith("openrouter:")) {
      expect(requests[0]?.["reasoning"]).toEqual({ enabled: false });
      expect(requests[0]?.["reasoning_effort"]).toBeUndefined();
    } else {
      expect(requests[0]?.["reasoning_effort"]).toBe("none");
      expect(requests[0]?.["reasoning"]).toBeUndefined();
    }
  });
  test(`${model}: advertised max remains max on the wire`, async () => {
    await catalog(); await call(model, "max");
    expect(requests).toHaveLength(1);
    expect(model.startsWith("openrouter:") ? requests[0]?.["reasoning"] : requests[0]?.["reasoning_effort"])
      .toEqual(model.startsWith("openrouter:") ? { effort: "max", exclude: false } : "max");
  });
  const supportedEfforts = model.startsWith("openrouter:")
    ? ["minimal", "low", "medium", "high", "xhigh", "max"] as const
    : model.startsWith("venice:")
      ? ["low", "medium", "high", "xhigh", "max"] as const
      : ["low", "medium", "high", "max"] as const;
  for (const effort of supportedEfforts) {
    test(`${model}: ${effort} serializes unchanged`, async () => {
      await catalog();
      expect((await call(model, effort)).response.content).toBe("ok");
      expect(requests).toHaveLength(1);
      if (model.startsWith("openrouter:")) {
        expect(requests[0]?.["reasoning"]).toEqual({ effort, exclude: false });
      } else {
        expect(requests[0]?.["reasoning_effort"]).toBe(effort);
      }
    });
  }
  test(`${model}: hiding output without an explicit off never sends disablement`, async () => {
    await catalog(); await call(model, undefined, undefined, false, false);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.["reasoning"]).toBeUndefined(); expect(requests[0]?.["reasoning_effort"]).toBeUndefined();
  });
  test(`${model}: absent/mandatory catalog controls reject off even if a caller bypasses selection`, async () => {
    for (const mode of ["absent", "mandatory"] as const) {
      await catalog(mode);
      const error: unknown = await call(model, "off", undefined, true).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("not supported by the catalog controls");
      expect(requests).toHaveLength(0);
    }
  });
  test(`${model}: canonical server policy still blocks explicit controls before provider dispatch`, async () => {
    await catalog();
    const off: unknown = await call(model, "off", { reasoningEnabled: false }).catch((error: unknown) => error);
    const max: unknown = await call(model, "max", { allowedReasoningEfforts: ["low"] }).catch((error: unknown) => error);
    expect(off).toBeInstanceOf(Error); expect((off as Error).message).toContain("reasoning-disabled-by-policy");
    expect(max).toBeInstanceOf(Error); expect((max as Error).message).toContain("reasoning-effort-not-allowed");
    expect(requests).toHaveLength(0);
  });

  test(`${model}: signed 128K output maximum reaches the provider request`, async () => {
    await catalog("optional", { contextTokens: 1_050_000, outputTokens: 128_000 });
    expect((await call(model, "max")).response.content).toBe("ok");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.["max_tokens"] ?? requests[0]?.["max_completion_tokens"]).toBe(128_000);
  });

  test(`${model}: explicit selected reasoning is not retried with reasoning disabled`, async () => {
    await catalog();
    rejectReasoningRequest = true;
    const error: unknown = await call(model, "high", undefined, false, false, "short").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(requests).toHaveLength(1);
    if (model.startsWith("openrouter:")) expect(requests[0]?.["reasoning"]).toEqual({ effort: "high", exclude: false });
    else expect(requests[0]?.["reasoning_effort"]).toBe("high");
  });
}

test("mandatory reasoning survives hidden output and a five-token budget without a retry", async () => {
  const model = "openrouter:deepseek/deepseek-v4-flash-0731";
  await catalog("mandatory", { contextTokens: 32768, outputTokens: 5 });
  rejectReasoningRequest = true;
  const error: unknown = await call(model, undefined, undefined, false, false, "short").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.["reasoning"]).toEqual({ effort: "high", exclude: false });
  expect(requests[0]?.["max_tokens"] ?? requests[0]?.["max_completion_tokens"]).toBe(5);
});

test("Opus 5.5 streams its full output limit and serializes every supported effort", async () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    requests.length = 0;
    const model = await createAnthropic({
      modelId: "anthropic:claude-opus-5-5",
      apiKey: "synthetic-wire-test-key",
      maxTokens: 128_000,
      reasoningOutput: false,
      reasoningEffort: effort,
    });
    const response = await model.invoke([new HumanMessage("Wire contract fixture")]) as AIMessageChunk;
    expect(JSON.stringify(response.content)).toContain("ok");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.["max_tokens"]).toBe(128_000);
    expect(requests[0]?.["stream"]).toBe(true);
    expect(requests[0]?.["thinking"]).toEqual({ type: "adaptive" });
    expect(requests[0]?.["output_config"]).toEqual({ effort });
    expect(requests[0]).not.toHaveProperty("temperature");
    expect(requests[0]).not.toHaveProperty("top_p");
    expect(requests[0]).not.toHaveProperty("top_k");
    expect(requests[0]?.["betas"] ?? []).toEqual([]);
  }
});

test("Anthropic streamed max_tokens reaches output-limit preflight through LangChain conversion", async () => {
  anthropicStopReason = "max_tokens";
  const model = await createAnthropic({
    modelId: "anthropic:claude-opus-5-5",
    apiKey: "synthetic-wire-test-key",
    maxTokens: 128_000,
    reasoningOutput: false,
    reasoningEffort: "high",
  });
  const response = await model.invoke([new HumanMessage("Wire contract fixture")]) as AIMessageChunk;
  anthropicStopReason = "end_turn";
  expect(response.additional_kwargs["stop_reason"]).toBe("max_tokens");
  const aiResponse = new AIMessage(response as unknown as ConstructorParameters<typeof AIMessage>[0]);
  expect(modelResponseReachedOutputLimit(aiResponse)).toBe(true);
  const state = { messages: [aiResponse] } as unknown as NautiloState;
  expect(() => modelOutputPreflightNode(state)).toThrow(ModelOutputLimitError);
});
