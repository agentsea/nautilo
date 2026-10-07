/**
 * Isolated because the Surplus attempt boundary imports durable DB functions;
 * this suite replaces them with content-free receipts and must not leak those
 * module mocks into the shared unit-test process.
 */
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const createModelInputs: Record<string, unknown>[] = [];
const bindTools = mock((_tools: unknown[], _options?: Record<string, unknown>) => ({ invoke: async () => new AIMessage("unused") }));
let observedResponse: ((receipt: { requestId: string; providerFamily: string; truncated: boolean; adaptedParameters?: string }, status: number) => Promise<void>) | undefined;
const beginAttempt = mock(async (_input: Record<string, unknown>) => {});
const settleAttempt = mock(async (_input: Record<string, unknown>) => {});

mock.module("@nautilo/db", () => ({
  attachSurplusRequestReceipt: mock(async () => {}),
  beginSurplusLlmAttempt: beginAttempt,
  settleSurplusLlmAttempt: settleAttempt,
}));

class MockSurplusOutcomeUnknownError extends Error {}

mock.module("../../src/providers/surplus-transport", () => ({
  createSurplusChatModel: (input: Record<string, unknown>) => {
    createModelInputs.push(input);
    observedResponse = input["onResponse"] as typeof observedResponse;
    return { invoke: async () => new AIMessage("unused"), bindTools };
  },
  isSafeSurplusDirectFallback: () => false,
  SurplusOutcomeUnknownError: MockSurplusOutcomeUnknownError,
}));

const {
  openAICompatibleReasoningModelKwargs,
  openRouterSessionModelKwargs,
  surplusReasoningModelKwargs,
} = await import("../../src/providers/factory");
const {
  canUseQualifiedSurplusChatRoute,
  invokeSurplusChatAttempt,
} = await import("../../src/providers/surplus-attempt");

const MODEL_ID = "openrouter:openai/gpt-5.6-sol";
const ROUTE = {
  catalogModelId: MODEL_ID,
  surplusModelId: "gpt-5.6-sol",
  providerPin: "openrouter" as const,
  supportsTools: true,
  supportsVision: true,
  supportsReasoning: true,
  maxContextTokens: 1_050_000,
  maxOutputTokens: 128_000,
};

beforeEach(() => {
  createModelInputs.length = 0;
  bindTools.mockClear();
  beginAttempt.mockClear();
  settleAttempt.mockClear();
  settleAttempt.mockImplementation(async () => {});
});

describe("Surplus reasoning parity", () => {
  test("forwards only trimmed opaque UUID session state", () => {
    expect(openRouterSessionModelKwargs(
      " 22222222-2222-4222-8222-222222222222 ",
    )).toEqual({
      session_id: "22222222-2222-4222-8222-222222222222",
    });
    for (const privateState of ["room:customer-acquisition", "customer@example.com", "", "   "]) {
      const kwargs = openRouterSessionModelKwargs(privateState);
      expect(kwargs).toEqual({});
      if (privateState.trim()) expect(JSON.stringify(kwargs)).not.toContain(privateState.trim());
    }
  });

  test("uses the canonical direct-provider default and explicit OpenRouter effort shape", () => {
    expect(openAICompatibleReasoningModelKwargs({
      modelId: MODEL_ID,
      reasoningOutput: true,
    }, ROUTE.maxOutputTokens)).toEqual({
      reasoning: { effort: "medium", exclude: false },
    });
    expect(openAICompatibleReasoningModelKwargs({
      modelId: MODEL_ID,
      reasoningOutput: true,
      reasoningEffort: "xhigh",
    }, ROUTE.maxOutputTokens)).toEqual({
      reasoning: { effort: "xhigh", exclude: false },
    });
    expect(openAICompatibleReasoningModelKwargs({
      modelId: MODEL_ID,
      reasoningOutput: false,
    }, ROUTE.maxOutputTokens)).toEqual({});
  });

  test("keeps direct-provider off validation and serialization", () => {
    expect(() => openAICompatibleReasoningModelKwargs({
      modelId: MODEL_ID,
      reasoningEffort: "off",
    }, ROUTE.maxOutputTokens)).toThrow(/not supported by the catalog controls/i);
    expect(openAICompatibleReasoningModelKwargs({
      modelId: "openrouter:openai/gpt-6-sol",
      reasoningEffort: "off",
    }, ROUTE.maxOutputTokens)).toEqual({ reasoning: { enabled: false } });
  });

  test("preserves canonical reasoning intent on Surplus's common chat wire", () => {
    expect(surplusReasoningModelKwargs({
      modelId: "anthropic:claude-opus-5-5",
      reasoningEffort: "xhigh",
    }, ROUTE.maxOutputTokens)).toEqual({ reasoning: { effort: "xhigh" } });
    expect(surplusReasoningModelKwargs({
      modelId: "openai:gpt-6-sol",
      reasoningEffort: "xhigh",
      useOpenAIResponsesApi: true,
    }, ROUTE.maxOutputTokens)).toEqual({ reasoning: { effort: "xhigh" } });
    expect(surplusReasoningModelKwargs({
      modelId: "openai:gpt-6-sol",
      reasoningEffort: "off",
      useOpenAIResponsesApi: true,
    }, ROUTE.maxOutputTokens)).toEqual({ reasoning: { effort: "none" } });
    expect(() => surplusReasoningModelKwargs({
      modelId: "anthropic:claude-opus-5-5",
      reasoningEffort: "off",
    }, ROUTE.maxOutputTokens)).toThrow(/not supported by the catalog controls/i);
  });

  test("admits reasoning only for a qualified reasoning-capable route", () => {
    const base = {
      route: ROUTE,
      funding: { kind: "server" as const, providerRoute: "openrouter", humanUserId: "user-1" },
      prefersSurplus: true,
      hasSurplusCredential: true,
      needsVision: false,
      requiresTools: true,
      reasoningRequested: true,
      hasRequestChangingServingProfile: false,
      estimatedInputTokens: 1_000,
      maxOutputTokens: 2_000,
    };
    expect(canUseQualifiedSurplusChatRoute(base)).toBe(true);
    expect(canUseQualifiedSurplusChatRoute({
      ...base,
      route: { ...ROUTE, supportsReasoning: false },
    })).toBe(false);
    expect(canUseQualifiedSurplusChatRoute({
      ...base,
      funding: {
        kind: "personal" as const,
        humanUserId: "user-1",
        payerHumanId: "user-1",
        providerRoute: "surplus",
        credentialId: "credential-1",
        credentialRevision: 1,
      },
    })).toBe(true);
  });

  test("preserves required research tool choice through marketplace binding", async () => {
    const { DynamicStructuredTool } = await import("@langchain/core/tools");
    const { z } = await import("zod");
    const search = new DynamicStructuredTool({ name: "search", description: "Search", schema: z.object({ query: z.string() }), func: async () => "unused" });
    await invokeSurplusChatAttempt({
      route: ROUTE, apiKey: "synthetic-surplus-key", messages: [new HumanMessage("test")], tools: [search],
      toolBindingOptions: { tool_choice: "required" },
      config: {}, maxOutputTokens: 256, funding: { kind: "server", providerRoute: "surplus", humanUserId: "user-1" },
      invokeModel: async () => {
        await observedResponse!({ requestId: "tool-choice-request", providerFamily: "openrouter", truncated: false }, 200);
        return new AIMessage({ content: "ok", response_metadata: { finish_reason: "stop" } });
      },
    });
    expect(bindTools.mock.calls[0]?.[0]).toEqual([search]);
    expect(bindTools.mock.calls[0]?.[1]).toEqual({ tool_choice: "required" });
  });

  test("keeps a missing charge pending when its receipt has a recoverable request ID", async () => {
    const response = new AIMessage({ content: "ok", response_metadata: { finish_reason: "stop" } });
    await invokeSurplusChatAttempt({
      route: ROUTE, apiKey: "synthetic-surplus-key", messages: [new HumanMessage("test")], tools: [],
      config: {}, maxOutputTokens: 256, funding: { kind: "server", providerRoute: "surplus", humanUserId: "user-1" },
      invokeModel: async () => {
        await observedResponse!({ requestId: "recoverable-request", providerFamily: "openrouter", truncated: false }, 200);
        return response;
      },
    });
    expect(settleAttempt.mock.calls[0]?.[0]).toMatchObject({
      outcome: "succeeded", costState: "pending", providerRequestId: "recoverable-request",
    });
  });

  test("retries the same frozen settlement and preserves all terminal usage counts", async () => {
    settleAttempt.mockImplementationOnce(async () => {
      throw new Error("temporary database failure");
    });
    settleAttempt.mockImplementationOnce(async () => {});
    let inferenceCalls = 0;
    const response = new AIMessage({
      content: "ok",
      response_metadata: {
        finish_reason: "stop",
        usage: {
          prompt_tokens: 11,
          completion_tokens: 16,
          total_tokens: 27,
          completion_tokens_details: { reasoning_tokens: 10 },
          prompt_tokens_details: { cached_tokens: 3 },
          buyer_cost_micro: 283,
        },
      },
    });
    const result = await invokeSurplusChatAttempt({
      route: ROUTE, apiKey: "synthetic-surplus-key", messages: [new HumanMessage("test")], tools: [],
      config: {}, maxOutputTokens: 256, funding: { kind: "server", providerRoute: "surplus", humanUserId: "user-1" },
      invokeModel: async () => {
        inferenceCalls++;
        await observedResponse!({ requestId: "retry-request", providerFamily: "openrouter", truncated: false }, 200);
        return response;
      },
    });

    expect(result).toEqual({ kind: "served", response, requestId: "retry-request" });
    expect(inferenceCalls).toBe(1);
    expect(beginAttempt).toHaveBeenCalledTimes(1);
    expect(settleAttempt).toHaveBeenCalledTimes(2);
    const firstSettlement = settleAttempt.mock.calls[0]?.[0];
    expect(Object.isFrozen(firstSettlement)).toBe(true);
    expect(settleAttempt.mock.calls[1]?.[0]).toBe(firstSettlement);
    expect(firstSettlement).toMatchObject({
      outcome: "succeeded",
      costState: "actual",
      actualCostUsd: 0.000283,
      inputTokens: 11,
      outputTokens: 16,
      totalTokens: 27,
      reasoningTokens: 10,
      cachedInputTokens: 3,
    });
  });

  test("a completed cache-adapted journal response settles once with tokens and no replay", async () => {
    let inferenceCalls = 0;
    const response = new AIMessage({
      content: '{"operations":[]}',
      response_metadata: { finish_reason: "stop", usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57, buyer_cost_micro: 91 } },
    });
    const result = await invokeSurplusChatAttempt({
      route: ROUTE, apiKey: "synthetic-surplus-key", messages: [new HumanMessage("Extract the journal")], tools: [],
      config: {}, maxOutputTokens: 256, funding: { kind: "service", providerRoute: "surplus", humanUserId: "user-1" },
      invokeModel: async () => {
        inferenceCalls++;
        await observedResponse!({ requestId: "cache-adapted-journal", providerFamily: "openrouter", truncated: false, adaptedParameters: "prompt_cache_key" }, 200);
        return response;
      },
    });
    expect(result).toEqual({ kind: "served", response, requestId: "cache-adapted-journal" });
    expect(inferenceCalls).toBe(1);
    expect(beginAttempt).toHaveBeenCalledTimes(1);
    expect(settleAttempt).toHaveBeenCalledTimes(1);
    expect(settleAttempt.mock.calls[0]?.[0]).toMatchObject({
      outcome: "succeeded", costState: "actual", actualCostUsd: 0.000091,
      inputTokens: 50, outputTokens: 7, totalTokens: 57,
      metadata: { surplusAdaptedParameters: ["prompt_cache_key"] },
    });
    expect(settleAttempt.mock.calls[0]?.[0]).not.toHaveProperty("failureCode");
  });

  test("an uncertain committed settlement retry remains one attempt", async () => {
    const settledAttemptIds = new Set<string>();
    let settlementCalls = 0;
    settleAttempt.mockImplementation(async (input) => {
      settledAttemptIds.add(String(input["attemptId"]));
      settlementCalls++;
      if (settlementCalls === 1) throw new Error("database result lost after commit");
    });
    let inferenceCalls = 0;
    const response = new AIMessage({
      content: "ok",
      response_metadata: { finish_reason: "stop", usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
    });
    await invokeSurplusChatAttempt({
      route: ROUTE, apiKey: "synthetic-surplus-key", messages: [new HumanMessage("test")], tools: [],
      config: {}, maxOutputTokens: 256, funding: { kind: "server", providerRoute: "surplus", humanUserId: "user-1" },
      invokeModel: async () => {
        inferenceCalls++;
        await observedResponse!({ requestId: "uncertain-request", providerFamily: "openrouter", truncated: false }, 200);
        return response;
      },
    });

    expect(inferenceCalls).toBe(1);
    expect(beginAttempt).toHaveBeenCalledTimes(1);
    expect(settleAttempt).toHaveBeenCalledTimes(2);
    expect(settleAttempt.mock.calls[1]?.[0]).toBe(settleAttempt.mock.calls[0]?.[0]);
    expect(settledAttemptIds.size).toBe(1);
  });

  test("permanent failed-response settlement failure never replays inference", async () => {
    settleAttempt.mockImplementation(async () => {
      throw new Error("database unavailable");
    });
    let inferenceCalls = 0;
    const incompleteResponse = new AIMessage({
      content: "partial",
      response_metadata: {
        usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      },
    });
    const attempt = invokeSurplusChatAttempt({
      route: ROUTE, apiKey: "synthetic-surplus-key", messages: [new HumanMessage("test")], tools: [],
      config: {}, maxOutputTokens: 256, funding: { kind: "server", providerRoute: "surplus", humanUserId: "user-1" },
      invokeModel: async () => {
        inferenceCalls++;
        await observedResponse!({ requestId: "permanent-failure-request", providerFamily: "openrouter", truncated: false }, 200);
        return incompleteResponse;
      },
    });

    let failure: unknown;
    try {
      await attempt;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MockSurplusOutcomeUnknownError);
    expect(inferenceCalls).toBe(1);
    expect(beginAttempt).toHaveBeenCalledTimes(1);
    expect(settleAttempt).toHaveBeenCalledTimes(2);
    const firstSettlement = settleAttempt.mock.calls[0]?.[0];
    expect(Object.isFrozen(firstSettlement)).toBe(true);
    expect(settleAttempt.mock.calls[1]?.[0]).toBe(firstSettlement);
    expect(firstSettlement).toMatchObject({
      outcome: "interrupted",
      costState: "pending",
      inputTokens: 7,
      outputTokens: 5,
      totalTokens: 12,
      failureCode: "incomplete_response",
    });
  });

  test("threads selected reasoning and OpenRouter cache settings into the shared transport", async () => {
    const response = new AIMessage({
      content: "ok",
      response_metadata: { finish_reason: "stop" },
    });
    const result = await invokeSurplusChatAttempt({
      route: ROUTE,
      apiKey: "synthetic-surplus-key",
      messages: [new HumanMessage("test")],
      tools: [],
      config: {},
      maxOutputTokens: 256,
      reasoningEffort: "high",
      reasoningOutput: true,
      openrouterSessionId: "22222222-2222-4222-8222-222222222222",
      funding: { kind: "server", providerRoute: "surplus", humanUserId: "user-1" },
      invokeModel: async () => response,
    });

    expect(result).toEqual({ kind: "served", response });
    expect(createModelInputs).toHaveLength(1);
    expect(createModelInputs[0]).toMatchObject({
      route: ROUTE,
      maxOutputTokens: 256,
      reasoningEffort: "high",
      reasoningOutput: true,
      openrouterSessionId: "22222222-2222-4222-8222-222222222222",
    });
    expect(beginAttempt).toHaveBeenCalledTimes(1);
    expect(settleAttempt).toHaveBeenCalledTimes(1);
    expect(settleAttempt.mock.calls[0]?.[0]).toMatchObject({ outcome: "succeeded", costState: "unknown" });
  });
});


test("personal marketplace attempts retain exact credential provenance and actual buyer cost", async () => {
  const response = new AIMessage({ content: "personal output", response_metadata: {
    finish_reason: "stop", usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, buyer_cost_micro: 47 },
  } });
  const funding = { kind: "personal" as const, humanUserId: "personal-human", payerHumanId: "personal-human",
    providerRoute: "surplus", credentialId: "personal-surplus-row", credentialRevision: 9 };
  const result = await invokeSurplusChatAttempt({ route: ROUTE, apiKey: "personal-surplus-only",
    messages: [new HumanMessage("Synthetic personal prompt")], tools: [], config: {}, maxOutputTokens: 256,
    funding, invokeModel: async () => {
      await observedResponse!({ requestId: "personal-receipt", providerFamily: "openrouter", truncated: false }, 200);
      return response;
    },
  });
  expect(result.kind).toBe("served");
  expect(beginAttempt.mock.calls.at(-1)?.[0]).toMatchObject({ fundingKind: "personal", payerHumanId: funding.payerHumanId,
    credentialId: funding.credentialId, credentialRevision: 9, userId: "personal-human" });
  expect(settleAttempt.mock.calls.at(-1)?.[0]).toMatchObject({ outcome: "succeeded", costState: "actual", actualCostUsd: 0.000047 });
  expect(JSON.stringify(beginAttempt.mock.calls.at(-1))).not.toContain("personal-surplus-only");
});
