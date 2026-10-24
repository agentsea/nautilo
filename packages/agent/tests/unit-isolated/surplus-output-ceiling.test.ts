/**
 * Isolated because the Surplus attempt boundary imports durable DB functions;
 * this suite replaces them with content-free receipts and must not leak those
 * module mocks into the shared unit-test process.
 */
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, mock, test } from "bun:test";

type ObservedResponse = (
  receipt: {
    requestId: string;
    providerFamily?: string;
    marketplaceAttempts?: number;
    truncated: boolean;
    adaptedParameters?: string;
    buyerCostMicro?: number;
  },
  status: number,
) => Promise<void>;

const createModelInputs: Record<string, unknown>[] = [];
let observedResponse: ObservedResponse | undefined;
const beginAttempt = mock(async (_input: Record<string, unknown>) => {});
const attachReceipt = mock(async (_input: Record<string, unknown>) => {});
const settleAttempt = mock(async (_input: Record<string, unknown>) => {});

mock.module("@nautilo/db", () => ({
  attachSurplusRequestReceipt: attachReceipt,
  beginSurplusLlmAttempt: beginAttempt,
  settleSurplusLlmAttempt: settleAttempt,
}));

class MockSurplusOutcomeUnknownError extends Error {}

mock.module("../../src/providers/surplus-transport", () => ({
  createSurplusChatModel: (input: Record<string, unknown>) => {
    createModelInputs.push(input);
    observedResponse = input["onResponse"] as ObservedResponse;
    return { invoke: async () => new AIMessage("unused") };
  },
  isSafeSurplusDirectFallback: () => false,
  SurplusOutcomeUnknownError: MockSurplusOutcomeUnknownError,
}));

mock.module("../../src/providers/surplus-catalog", () => ({
  invalidateSurplusModelCatalog: mock(() => {}),
}));

const { invokeSurplusChatAttempt } = await import("../../src/providers/surplus-attempt");

const MAX_OUTPUT_TOKENS = 131_072;
const ROUTE = {
  catalogModelId: "openrouter:moonshotai/kimi-k3",
  surplusModelId: "kimi-k3",
  providerPin: "openrouter" as const,
  supportsTools: true,
  supportsVision: true,
  supportsReasoning: true,
  maxContextTokens: 1_000_000,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
};

beforeEach(() => {
  createModelInputs.length = 0;
  observedResponse = undefined;
  beginAttempt.mockClear();
  attachReceipt.mockClear();
  settleAttempt.mockClear();
});

function completedResponse(completionTokens: number): AIMessage {
  return new AIMessage({
    content: "Complete",
    response_metadata: {
      finish_reason: "stop",
      usage: {
        prompt_tokens: 37,
        completion_tokens: completionTokens,
        total_tokens: 37 + completionTokens,
        buyer_cost_micro: 62,
      },
    },
  });
}

describe("Surplus output-ceiling attempt boundary", () => {
  test("threads the production output cap through final validation and settles one completed attempt", async () => {
    let inferenceCalls = 0;
    const response = completedResponse(5);
    const result = await invokeSurplusChatAttempt({
      route: ROUTE,
      apiKey: "synthetic-surplus-key",
      providerMode: "any",
      messages: [new HumanMessage("Complete the probe")],
      tools: [],
      config: {},
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      funding: { kind: "server", providerRoute: "surplus", humanUserId: "user-1" },
      hasDeliveredOutput: () => false,
      invokeModel: async () => {
        inferenceCalls++;
        await observedResponse!({
          requestId: "request-kimi-ceiling",
          providerFamily: "openai",
          marketplaceAttempts: 1,
          adaptedParameters: "max_tokens",
          truncated: false,
        }, 200);
        return response;
      },
    });

    expect(result).toEqual({ kind: "served", response, requestId: "request-kimi-ceiling" });
    expect(inferenceCalls).toBe(1);
    expect(createModelInputs).toHaveLength(1);
    expect(createModelInputs[0]).toMatchObject({
      route: ROUTE,
      providerMode: "any",
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    expect(beginAttempt).toHaveBeenCalledTimes(1);
    expect(attachReceipt).toHaveBeenCalledTimes(1);
    expect(settleAttempt).toHaveBeenCalledTimes(1);
    expect(settleAttempt.mock.calls[0]?.[0]).toMatchObject({
      providerRequestId: "request-kimi-ceiling",
      servingProvider: "openai",
      outcome: "succeeded",
      costState: "actual",
      actualCostUsd: 0.000062,
      inputTokens: 37,
      outputTokens: 5,
      totalTokens: 42,
      metadata: { surplusAdaptedParameters: ["max_tokens"] },
    });
    expect(settleAttempt.mock.calls[0]?.[0]).not.toHaveProperty("failureCode");
  });

  test("preserves cost and refuses replay when delivered output exceeds the original cap", async () => {
    let inferenceCalls = 0;
    const response = completedResponse(MAX_OUTPUT_TOKENS + 1);
    const error = await invokeSurplusChatAttempt({
      route: ROUTE,
      apiKey: "synthetic-surplus-key",
      providerMode: "any",
      messages: [new HumanMessage("Complete the probe")],
      tools: [],
      config: {},
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      funding: { kind: "server", providerRoute: "surplus", humanUserId: "user-1" },
      hasDeliveredOutput: () => true,
      invokeModel: async () => {
        inferenceCalls++;
        await observedResponse!({
          requestId: "request-kimi-over-cap",
          providerFamily: "openai",
          marketplaceAttempts: 1,
          adaptedParameters: "max_tokens",
          truncated: false,
        }, 200);
        return response;
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MockSurplusOutcomeUnknownError);
    expect(inferenceCalls).toBe(1);
    expect(settleAttempt).toHaveBeenCalledTimes(1);
    expect(settleAttempt.mock.calls[0]?.[0]).toMatchObject({
      providerRequestId: "request-kimi-over-cap",
      servingProvider: "openai",
      outcome: "unknown",
      costState: "actual",
      actualCostUsd: 0.000062,
      inputTokens: 37,
      outputTokens: MAX_OUTPUT_TOKENS + 1,
      totalTokens: MAX_OUTPUT_TOKENS + 38,
      failureCode: "adapted_parameters",
      metadata: { surplusAdaptedParameters: ["max_tokens"] },
    });
  });
});
