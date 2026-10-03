/**
 * Isolated because the Surplus attempt boundary imports durable DB functions;
 * this suite replaces them with content-free receipts and must not leak those
 * module mocks into the shared unit-test process.
 */
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const createModelInputs: Record<string, unknown>[] = [];
const beginAttempt = mock(async () => {});
const settleAttempt = mock(async () => {});

mock.module("@nautilo/db", () => ({
  attachSurplusRequestReceipt: mock(async () => {}),
  beginSurplusLlmAttempt: beginAttempt,
  settleSurplusLlmAttempt: settleAttempt,
}));

class MockSurplusOutcomeUnknownError extends Error {}

mock.module("../../src/providers/surplus-transport", () => ({
  createSurplusChatModel: (input: Record<string, unknown>) => {
    createModelInputs.push(input);
    return { invoke: async () => new AIMessage("unused") };
  },
  isSafeSurplusDirectFallback: () => false,
  SurplusOutcomeUnknownError: MockSurplusOutcomeUnknownError,
}));

const {
  openAICompatibleReasoningModelKwargs,
  openRouterSessionModelKwargs,
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
  qualifiedAt: "2026-10-03",
};

beforeEach(() => {
  createModelInputs.length = 0;
  beginAttempt.mockClear();
  settleAttempt.mockClear();
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

  test("admits reasoning only for a qualified reasoning-capable route", () => {
    const base = {
      route: ROUTE,
      funding: { kind: "server" as const, providerRoute: "openrouter", humanUserId: "user-1" },
      prefersSurplus: true,
      hasSurplusCredential: true,
      needsVision: false,
      requiresTools: true,
      reasoningRequested: true,
      usesResponsesApi: false,
      hasServingProfile: false,
      estimatedInputTokens: 1_000,
      maxOutputTokens: 2_000,
    };
    expect(canUseQualifiedSurplusChatRoute(base)).toBe(true);
    expect(canUseQualifiedSurplusChatRoute({
      ...base,
      route: { ...ROUTE, supportsReasoning: false },
    })).toBe(false);
    expect(canUseQualifiedSurplusChatRoute({ ...base, usesResponsesApi: true })).toBe(false);
    expect(canUseQualifiedSurplusChatRoute({
      ...base,
      funding: {
        kind: "personal" as const,
        humanUserId: "user-1",
        payerHumanId: "user-1",
        providerRoute: "openrouter",
        credentialId: "credential-1",
        credentialRevision: 1,
      },
    })).toBe(false);
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
  });
});
