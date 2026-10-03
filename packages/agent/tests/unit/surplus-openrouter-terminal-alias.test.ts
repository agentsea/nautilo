import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { ChatGeneration, LLMResult } from "@langchain/core/outputs";
import { describe, expect, test } from "bun:test";
import {
  assertCompleteSurplusResponse,
  readSurplusResponseUsage,
  SurplusIncompleteResponseError,
} from "../../src/providers/surplus-attempt";
import { createSurplusChatModel } from "../../src/providers/surplus-transport";

const ROUTE = {
  catalogModelId: "openrouter:openai/gpt-5.6-sol",
  surplusModelId: "gpt-5.6-sol",
  providerPin: "openrouter" as const,
  supportsTools: true,
  supportsVision: true,
  supportsReasoning: true,
  maxContextTokens: 1_050_000,
  maxOutputTokens: 128_000,
  qualifiedAt: "2026-10-03",
};

class CaptureLLMEnd extends BaseCallbackHandler {
  name = "capture_surplus_terminal_alias";
  readonly lc_prefer_streaming = true;
  output: LLMResult | undefined;

  override handleLLMEnd(output: LLMResult): void {
    this.output = output;
  }
}

describe("Surplus OpenRouter terminal aliases", () => {
  test("deduplicates an empty repeated stop across route and upstream model names", async () => {
    const frames = [
      {
        id: "synthetic",
        object: "chat.completion.chunk",
        model: "openai/gpt-5.6-sol",
        created: 1,
        choices: [{
          index: 0,
          delta: { role: "assistant", content: "SURPLUS_ROOM_OK" },
          finish_reason: "stop",
        }],
      },
      {
        id: "synthetic",
        object: "chat.completion.chunk",
        model: "gpt-5.6-sol",
        created: 1,
        choices: [{
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 2_900,
          completion_tokens: 12,
          total_tokens: 2_912,
          buyer_cost_micro: 23_748,
        },
      },
    ];
    const model = createSurplusChatModel({
      route: ROUTE,
      apiKey: "synthetic-key",
      maxOutputTokens: 256,
      onResponse: () => {},
      fetchImpl: (async () => new Response(
        `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch,
    });

    const capture = new CaptureLLMEnd();
    const response = await model.invoke(
      [new HumanMessage("Reply with SURPLUS_ROOM_OK")],
      { callbacks: [capture] },
    ) as AIMessage;
    const generation = capture.output?.generations[0]?.[0] as ChatGeneration | undefined;

    expect(response.content).toBe("SURPLUS_ROOM_OK");
    expect(generation?.generationInfo?.["finish_reason"]).toBe("stop");
    expect(generation?.generationInfo?.["model_name"]).toBe("openai/gpt-5.6-sol");
    expect(generation?.message.response_metadata["finish_reason"]).toBe("stop");
    expect(generation?.message.response_metadata["model_name"]).toBe("openai/gpt-5.6-sol");
    expect(response.response_metadata["finish_reason"]).toBe("stop");
    expect(response.response_metadata["model_name"]).toBe("openai/gpt-5.6-sol");
    expect(readSurplusResponseUsage(response)).toMatchObject({
      inputTokens: 2_900,
      outputTokens: 12,
      totalTokens: 2_912,
      buyerCostMicro: 23_748,
    });
    expect(() => assertCompleteSurplusResponse(
      { providerFamily: "openrouter", truncated: false },
      response,
    )).not.toThrow();
  });

  test("retains conflicting terminal reasons and their final usage on the streaming callback path", async () => {
    const frames = [
      {
        id: "synthetic",
        object: "chat.completion.chunk",
        model: "openai/gpt-5.6-sol",
        created: 1,
        choices: [{
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: "tool_calls",
        }],
      },
      {
        id: "synthetic",
        object: "chat.completion.chunk",
        model: "gpt-5.6-sol",
        created: 1,
        choices: [{
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 72,
          completion_tokens: 18,
          total_tokens: 90,
          buyer_cost_micro: 162,
        },
      },
    ];
    const model = createSurplusChatModel({
      route: ROUTE,
      apiKey: "synthetic-key",
      maxOutputTokens: 256,
      onResponse: () => {},
      fetchImpl: (async () => new Response(
        `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch,
    });

    const capture = new CaptureLLMEnd();
    const response = await model.invoke(
      [new HumanMessage("Synthetic conflicting terminal test")],
      { callbacks: [capture] },
    ) as AIMessage;
    const generation = capture.output?.generations[0]?.[0] as ChatGeneration | undefined;

    // ChatGenerationChunk uses last-write-wins generationInfo, while message
    // metadata concatenation retains both signals for the completeness guard.
    expect(generation?.generationInfo?.["finish_reason"]).toBe("stop");
    expect(generation?.message.response_metadata["finish_reason"]).toBe("tool_callsstop");
    expect(response.response_metadata["finish_reason"]).toBe("tool_callsstop");
    expect(readSurplusResponseUsage(response)).toMatchObject({
      inputTokens: 72,
      outputTokens: 18,
      totalTokens: 90,
      buyerCostMicro: 162,
    });
    expect(() => assertCompleteSurplusResponse(
      { providerFamily: "openrouter", marketplaceAttempts: 1, truncated: false },
      response,
    )).toThrow(SurplusIncompleteResponseError);
  });
});
