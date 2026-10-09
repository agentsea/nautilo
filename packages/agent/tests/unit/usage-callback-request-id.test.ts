import { describe, expect, test } from "bun:test";
import type { LLMResult } from "@langchain/core/outputs";
import { extractUsageFromLLMResult } from "../../src/usage/usage-callback";

function result(input: {
  responseMetadata?: Record<string, unknown>;
  messageId?: string;
  llmOutput?: Record<string, unknown>;
}): LLMResult {
  return {
    generations: [[{
      text: "answer",
      message: {
        id: input.messageId,
        response_metadata: input.responseMetadata ?? {},
      },
    }]],
    llmOutput: input.llmOutput,
  } as unknown as LLMResult;
}

describe("provider request provenance extraction", () => {
  test("keeps explicit provider response metadata without inventing usage", () => {
    expect(extractUsageFromLLMResult(result({
      responseMetadata: { request_id: " request-provider-1 " },
    }))).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      actualCostUsd: null,
      providerRequestId: "request-provider-1",
    });
  });

  test("reads a provider response id from llmOutput even when tokens are present", () => {
    expect(extractUsageFromLLMResult(result({
      llmOutput: {
        id: "resp_provider_2",
        tokenUsage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
      },
    }))).toMatchObject({ providerRequestId: "resp_provider_2", totalTokens: 6 });
  });

  test("accepts a provider-namespaced AIMessage id but rejects LangChain run ids", () => {
    expect(extractUsageFromLLMResult(result({ messageId: "chatcmpl-provider-message" })))
      .toMatchObject({ providerRequestId: "chatcmpl-provider-message" });
    expect(extractUsageFromLLMResult(result({
      responseMetadata: { id: "run-langchain-callback" },
      messageId: "3beac757-c33e-4ca9-9a2c-83beee38c796",
      llmOutput: { id: "lc_run:callback" },
    }))).toBeNull();
  });

  test("prefers an explicit request id over a distinct response id for the same wire", () => {
    expect(extractUsageFromLLMResult(result({
      responseMetadata: { request_id: "request-one" },
      messageId: "chatcmpl-response-one",
      llmOutput: { response_id: "request-two" },
    }))).toMatchObject({ providerRequestId: "request-one" });
  });

  test("drops conflicting explicit request ids across generations", () => {
    expect(extractUsageFromLLMResult({
      generations: [[
        { text: "one", message: { response_metadata: { requestID: "request-one" } } },
        { text: "two", message: { response_metadata: { _request_id: "request-two" } } },
      ]],
    } as unknown as LLMResult)).toBeNull();
  });
});
