/**
 * Isolated because the Surplus attempt boundary imports durable DB functions;
 * this suite replaces them with content-free receipts and must not leak those
 * module mocks into the shared unit-test process.
 */
import { AIMessage, AIMessageChunk, HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const createModelInputs: Record<string, unknown>[] = [];
const bindTools = mock((_tools: unknown[], _options?: Record<string, unknown>) => ({ invoke: async () => new AIMessage("unused") }));
let observedResponse: ((receipt: { requestId: string; providerFamily?: string; marketplaceAttempts?: number; truncated: boolean; adaptedParameters?: string; buyerCostMicro?: number }, status: number) => Promise<void>) | undefined;
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
  isSafeSurplusDirectFallback: (
    error: { code?: string } | undefined,
    status: number | undefined,
    receipt: { marketplaceAttempts?: number } | undefined,
    visibleOutput: boolean,
  ) => !visibleOutput && status === 404 && error?.code === "no_sellers_for_model"
    && receipt?.marketplaceAttempts === 0,
  SurplusOutcomeUnknownError: MockSurplusOutcomeUnknownError,
}));

const {
  openAICompatibleReasoningModelKwargs,
  openRouterSessionModelKwargs,
  surplusReasoningModelKwargs,
} = await import("../../src/providers/factory");
const {
  assertCompleteSurplusResponse,
  canUseQualifiedSurplusChatRoute,
  invokeSurplusChatAttempt,
} = await import("../../src/providers/surplus-attempt");
const { SurplusMarketplaceAttemptError } = await import("../../src/providers/surplus-error");
const { runWithUsageContext } = await import("../../src/usage/usage-context");

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
  test("requires an actual AI message even when a generic value carries terminal text", () => {
    const receipt = { truncated: false };
    for (const generic of [
      null,
      undefined,
      { content: "plausible text", response_metadata: { finish_reason: "stop" } },
      new HumanMessage({ content: "plausible text" }),
    ]) {
      expect(() => assertCompleteSurplusResponse(receipt, generic)).toThrow();
    }
    expect(() => assertCompleteSurplusResponse(receipt, new AIMessageChunk({
      content: "real streamed text",
      response_metadata: { finish_reason: "stop" },
    }))).not.toThrow();
  });

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
      config: {}, maxOutputTokens: 256, funding: { kind: "server", providerRoute: "surplus", humanUserId: "user-1" }, hasDeliveredOutput: () => false,
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
      config: {}, maxOutputTokens: 256, funding: { kind: "server", providerRoute: "surplus", humanUserId: "user-1" }, hasDeliveredOutput: () => false,
      invokeModel: async () => {
        await observedResponse!({ requestId: "recoverable-request", providerFamily: "openrouter", truncated: false }, 200);
        return response;
      },
    });
    expect(settleAttempt.mock.calls[0]?.[0]).toMatchObject({
      outcome: "succeeded", costState: "pending", providerRequestId: "recoverable-request",
    });
  });

  test("retains only canonical Memory replay correlation on the durable attempt", async () => {
    const cases = [
      {
        callType: "memory_review" as const,
        metadata: {
          workId: "memory-work-1",
          attemptId: "memory-attempt-1",
          operationId: "not-a-review-key",
          prompt: "must-not-persist",
        },
        expected: { workId: "memory-work-1", attemptId: "memory-attempt-1" },
      },
      {
        callType: "room_stenographer" as const,
        metadata: { operationId: "stenographer:room-1:7", workId: "must-not-persist" },
        expected: { operationId: "stenographer:room-1:7" },
      },
      {
        callType: "room_event_compaction" as const,
        metadata: { operationId: "compaction:room-1:rollup-1:8", attemptId: "must-not-persist" },
        expected: { operationId: "compaction:room-1:rollup-1:8" },
      },
      {
        callType: "room_reflection" as const,
        metadata: { operationId: "reflection:record-1:1", messages: ["must-not-persist"] },
        expected: { operationId: "reflection:record-1:1" },
      },
    ];

    for (const testCase of cases) {
      const response = new AIMessage({ content: "ok", response_metadata: { finish_reason: "stop" } });
      await runWithUsageContext({
        callType: testCase.callType,
        roomId: "11111111-1111-4111-8111-111111111111",
        metadata: testCase.metadata,
      }, () => invokeSurplusChatAttempt({
        route: ROUTE,
        apiKey: "synthetic-surplus-key",
        messages: [new HumanMessage("test")],
        tools: [],
        config: {},
        maxOutputTokens: 256,
        funding: { kind: "service", providerRoute: "surplus", humanUserId: "user-1" },
        hasDeliveredOutput: () => false,
        invokeModel: async () => response,
      }));
    }

    expect(beginAttempt).toHaveBeenCalledTimes(4);
    for (const [index, testCase] of cases.entries()) {
      const attempt = beginAttempt.mock.calls[index]?.[0];
      expect(attempt).toMatchObject({
        callType: testCase.callType,
        roomId: "11111111-1111-4111-8111-111111111111",
        metadata: testCase.expected,
      });
      expect(attempt?.["metadata"]).toEqual(expect.objectContaining(testCase.expected));
      expect(JSON.stringify(attempt?.["metadata"])).not.toContain("must-not-persist");
      if (testCase.callType === "memory_review") {
        expect(attempt?.["metadata"]).not.toHaveProperty("operationId");
      } else {
        expect(attempt?.["metadata"]).not.toHaveProperty("workId");
        expect(attempt?.["metadata"]).not.toHaveProperty("attemptId");
      }
    }
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
      config: {}, maxOutputTokens: 256, funding: { kind: "server", providerRoute: "surplus", humanUserId: "user-1" }, hasDeliveredOutput: () => false,
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
      config: {}, maxOutputTokens: 256, funding: { kind: "service", providerRoute: "surplus", humanUserId: "user-1" }, hasDeliveredOutput: () => false,
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
      config: {}, maxOutputTokens: 256, funding: { kind: "server", providerRoute: "surplus", humanUserId: "user-1" }, hasDeliveredOutput: () => false,
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

  test("permanent failed-response settlement failure permits direct fallback without replaying Surplus", async () => {
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
      config: {}, maxOutputTokens: 256, funding: { kind: "server", providerRoute: "surplus", humanUserId: "user-1" }, hasDeliveredOutput: () => false,
      invokeModel: async () => {
        inferenceCalls++;
        await observedResponse!({ requestId: "permanent-failure-request", providerFamily: "openrouter", truncated: false }, 200);
        return incompleteResponse;
      },
    });

    const result = await attempt;
    expect(result).toMatchObject({
      kind: "direct_fallback",
      failure: { code: "surplus_marketplace_attempt_failed" },
    });
    if (result.kind !== "direct_fallback") throw new Error("expected direct fallback");
    expect(result.failure).toBeInstanceOf(SurplusMarketplaceAttemptError);
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

  test("preserves a charged unknown marketplace attempt while permitting one undelivered direct fallback", async () => {
    const result = await invokeSurplusChatAttempt({
      route: ROUTE, apiKey: "synthetic-surplus-key", messages: [new HumanMessage("test")], tools: [],
      config: {}, maxOutputTokens: 256, funding: { kind: "server", providerRoute: "surplus", humanUserId: "user-1" },
      hasDeliveredOutput: () => false,
      invokeModel: async () => {
        await observedResponse!({
          requestId: "charged-unknown-request",
          providerFamily: "openrouter",
          buyerCostMicro: 283,
          truncated: false,
        }, 200);
        throw new Error("connection lost after marketplace service");
      },
    });

    expect(result).toMatchObject({
      kind: "direct_fallback",
      failure: { code: "surplus_marketplace_attempt_failed" },
    });
    if (result.kind !== "direct_fallback") throw new Error("expected direct fallback");
    expect(result.failure).toBeInstanceOf(SurplusMarketplaceAttemptError);
    expect(settleAttempt.mock.calls[0]?.[0]).toMatchObject({
      outcome: "unknown",
      costState: "actual",
      actualCostUsd: 0.000283,
      failureCode: "outcome_unknown",
    });
  });

  test("marks only the original pinned no-seller refusal for one unpinned retry", async () => {
    const run = async (options: {
      providerMode?: "any";
      status?: number;
      code?: string;
      marketplaceAttempts?: number;
      deliveredOutput?: boolean;
      cancelled?: boolean;
    }) => {
      const controller = new AbortController();
      if (options.cancelled) controller.abort(new Error("cancelled"));
      return invokeSurplusChatAttempt({
        route: ROUTE,
        apiKey: "synthetic-surplus-key",
        ...(options.providerMode ? { providerMode: options.providerMode } : {}),
        messages: [new HumanMessage("test")],
        tools: [],
        config: { signal: controller.signal },
        maxOutputTokens: 256,
        funding: { kind: "server", providerRoute: "surplus", humanUserId: "user-1" },
        hasDeliveredOutput: () => options.deliveredOutput === true,
        invokeModel: async () => {
          if (options.status !== undefined) {
            await observedResponse!({
              requestId: "refusal-request",
              ...(options.marketplaceAttempts === undefined
                ? {}
                : { marketplaceAttempts: options.marketplaceAttempts }),
              truncated: false,
            }, options.status);
          }
          throw Object.assign(new Error(options.code ?? "request failed"), { code: options.code });
        },
      });
    };

    expect(await run({ status: 404, code: "no_sellers_for_model", marketplaceAttempts: 0 }))
      .toMatchObject({
        kind: "direct_fallback",
        retryUnpinned: true,
        failure: {
          code: "surplus_marketplace_attempt_failed",
          vendorCode: "no_sellers_for_model",
          status: 404,
          traceId: "refusal-request",
        },
      });
    expect(await run({ providerMode: "any", status: 404, code: "no_sellers_for_model", marketplaceAttempts: 0 }))
      .toMatchObject({
        kind: "direct_fallback",
        failure: { code: "surplus_marketplace_attempt_failed", traceId: "refusal-request" },
      });
    expect(await run({ status: 404, code: "no_sellers_for_model", marketplaceAttempts: 1 }))
      .toMatchObject({
        kind: "direct_fallback",
        failure: { code: "surplus_marketplace_attempt_failed", vendorCode: "no_sellers_for_model", status: 404 },
      });
    expect(await run({ status: 401, code: "invalid_api_key" }))
      .toMatchObject({
        kind: "direct_fallback",
        failure: { code: "surplus_marketplace_attempt_failed", vendorCode: "invalid_api_key", status: 401 },
      });
    expect(await run({ code: "timeout" })).toMatchObject({
      kind: "direct_fallback",
      failure: { code: "surplus_marketplace_attempt_failed", vendorCode: "timeout" },
    });
    const delivered = await run({
      status: 404,
      code: "no_sellers_for_model",
      marketplaceAttempts: 0,
      deliveredOutput: true,
    }).catch((error: unknown) => error);
    expect(delivered).toBeInstanceOf(MockSurplusOutcomeUnknownError);
    const cancelled = await run({
      status: 404,
      code: "no_sellers_for_model",
      marketplaceAttempts: 0,
      cancelled: true,
    }).catch((error: unknown) => error);
    expect(cancelled).toBeInstanceOf(Error);
    expect((cancelled as Error).message).toBe("cancelled");
  });

  test("records unpinned attempts separately with their original catalogue binding", async () => {
    const response = new AIMessage({ content: "ok", response_metadata: { finish_reason: "stop" } });
    await invokeSurplusChatAttempt({
      route: ROUTE,
      apiKey: "synthetic-surplus-key",
      providerMode: "any",
      messages: [new HumanMessage("test")],
      tools: [],
      config: {},
      maxOutputTokens: 256,
      funding: { kind: "server", providerRoute: "surplus", humanUserId: "user-1" },
      hasDeliveredOutput: () => false,
      invokeModel: async () => {
        await observedResponse!({
          requestId: "unpinned-request",
          providerFamily: "alternate-provider",
          truncated: false,
        }, 200);
        return response;
      },
    });

    expect(createModelInputs.at(-1)).toMatchObject({ providerMode: "any" });
    expect(beginAttempt.mock.calls.at(-1)?.[0]).toMatchObject({
      model: MODEL_ID,
      provider: "openrouter",
      metadata: {
        catalogModelId: MODEL_ID,
        surplusModelId: ROUTE.surplusModelId,
        surplusProviderPin: ROUTE.providerPin,
        surplusUnpinnedModel: true,
      },
    });
    expect(settleAttempt.mock.calls.at(-1)?.[0]).toMatchObject({
      providerRequestId: "unpinned-request",
      servingProvider: "alternate-provider",
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
      hasDeliveredOutput: () => false,
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
    funding, hasDeliveredOutput: () => false, invokeModel: async () => {
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

describe("strict service fallback policy", () => {
  test("keeps a charged uncertain attempt unresolved instead of admitting direct replay", async () => {
    await Promise.resolve(expect(invokeSurplusChatAttempt({
      route: ROUTE, apiKey: "synthetic-service-key", messages: [new HumanMessage("Synthetic Soul")],
      tools: [], config: {}, maxOutputTokens: 256,
      funding: { kind: "service", providerRoute: "surplus", humanUserId: "user-1" },
      directFallbackPolicy: "pre_service_only", hasDeliveredOutput: () => false,
      invokeModel: async () => {
        await observedResponse!({ requestId: "uncertain-soul", providerFamily: "openrouter",
          buyerCostMicro: 17, truncated: false }, 200);
        throw new Error("synthetic connection loss");
      },
    })).rejects.toBeInstanceOf(MockSurplusOutcomeUnknownError));
    expect(beginAttempt).toHaveBeenCalledTimes(1);
    expect(settleAttempt).toHaveBeenCalledTimes(1);
    expect(settleAttempt.mock.calls[0]?.[0]).toMatchObject({
      outcome: "unknown", costState: "actual", actualCostUsd: 0.000017,
    });
  });

  test("retains same-model direct eligibility after a proven zero-attempt refusal", async () => {
    const result = await invokeSurplusChatAttempt({
      route: ROUTE, apiKey: "synthetic-service-key", messages: [new HumanMessage("Synthetic Soul")],
      tools: [], config: {}, maxOutputTokens: 256,
      funding: { kind: "service", providerRoute: "surplus", humanUserId: "user-1" },
      directFallbackPolicy: "pre_service_only", hasDeliveredOutput: () => false,
      invokeModel: async () => {
        await observedResponse!({ requestId: "refused-soul", marketplaceAttempts: 0, truncated: false }, 404);
        throw Object.assign(new Error("Synthetic no-seller refusal"), { code: "no_sellers_for_model" });
      },
    });
    expect(result).toMatchObject({
      kind: "direct_fallback",
      retryUnpinned: true,
      modelUnavailableBeforeService: true,
      failure: {
        code: "surplus_marketplace_attempt_failed",
        vendorCode: "no_sellers_for_model",
        status: 404,
        traceId: "refused-soul",
      },
    });
    expect(settleAttempt.mock.calls[0]?.[0]).toMatchObject({
      outcome: "failed", costState: "actual", actualCostUsd: 0, failureCode: "no_sellers_for_model",
    });
    expect(settleAttempt.mock.calls[0]?.[0]).not.toHaveProperty("providerRequestId");
  });

  test("does not admit direct replay for an incomplete successful envelope", async () => {
    await Promise.resolve(expect(invokeSurplusChatAttempt({
      route: ROUTE, apiKey: "synthetic-service-key", messages: [new HumanMessage("Synthetic Soul")],
      tools: [], config: {}, maxOutputTokens: 256,
      funding: { kind: "service", providerRoute: "surplus", humanUserId: "user-1" },
      directFallbackPolicy: "pre_service_only", hasDeliveredOutput: () => false,
      invokeModel: async () => {
        await observedResponse!({ requestId: "incomplete-soul", providerFamily: "openrouter", truncated: false }, 200);
        return new AIMessage("Soul without terminal metadata");
      },
    })).rejects.toBeInstanceOf(MockSurplusOutcomeUnknownError));
    expect(settleAttempt.mock.calls[0]?.[0]).toMatchObject({
      outcome: "interrupted", costState: "pending", failureCode: "incomplete_response",
    });
  });
});
