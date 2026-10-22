import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessageChunk,
} from "@langchain/core/messages";
import type { ChatGeneration, LLMResult } from "@langchain/core/outputs";
import { describe, expect, test } from "bun:test";
import { readSurplusResponseUsage } from "../../src/providers/surplus-attempt";
import { createSurplusChatModel } from "../../src/providers/surplus-transport";
import type { QualifiedSurplusChatRoute } from "../../src/providers/surplus-route";

const ROUTES: QualifiedSurplusChatRoute[] = [
  {
    catalogModelId: "openrouter:openai/gpt-5.6-sol",
    surplusModelId: "gpt-5.6-sol",
    providerPin: "openrouter",
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    maxContextTokens: 1_050_000,
    maxOutputTokens: 128_000,
  },
  {
    catalogModelId: "openai:gpt-5.6-luna",
    surplusModelId: "gpt-5.6-luna",
    providerPin: "openai",
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    maxContextTokens: 1_050_000,
    maxOutputTokens: 128_000,
  },
];

const ROLELESS_FRAMES = [
  {
    id: "chatcmpl-roleless",
    object: "chat.completion.chunk",
    created: 1,
    model: "seller-model",
    choices: [{
      index: 0,
      delta: { content: "Checking ", reasoning: "synthetic reasoning" },
      finish_reason: null,
    }],
  },
  {
    id: "chatcmpl-roleless",
    object: "chat.completion.chunk",
    created: 1,
    model: "seller-model",
    choices: [{
      index: 0,
      delta: {
        content: "the report.",
        tool_calls: [{
          index: 0,
          id: "call-report",
          type: "function",
          function: { name: "report_probe", arguments: "{\"stat" },
        }],
      },
      finish_reason: null,
    }],
  },
  {
    id: "chatcmpl-roleless",
    object: "chat.completion.chunk",
    created: 1,
    model: "seller-model",
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index: 0, function: { arguments: "us\":\"ok\"}" } }],
      },
      finish_reason: null,
    }],
  },
  {
    id: "chatcmpl-roleless",
    object: "chat.completion.chunk",
    created: 1,
    model: "seller-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  },
  {
    id: "chatcmpl-roleless",
    object: "chat.completion.chunk",
    created: 1,
    model: "seller-model",
    choices: [],
    usage: {
      prompt_tokens: 596,
      completion_tokens: 64,
      total_tokens: 660,
      buyer_cost_micro: 687,
    },
  },
];

const TOOL = {
  type: "function",
  function: {
    name: "report_probe",
    description: "Report the synthetic probe status.",
    parameters: {
      type: "object",
      properties: { status: { type: "string" } },
      required: ["status"],
      additionalProperties: false,
    },
  },
};

class CaptureLLMEnd extends BaseCallbackHandler {
  name = "capture_surplus_roleless_stream";
  readonly lc_prefer_streaming = true;
  output: LLMResult | undefined;

  override handleLLMEnd(output: LLMResult): void {
    this.output = output;
  }
}

function asSse(frames: readonly unknown[]): string {
  return `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
}

function rolelessModel(route: QualifiedSurplusChatRoute, frames = ROLELESS_FRAMES) {
  const model = createSurplusChatModel({
    route,
    apiKey: "synthetic-key",
    maxOutputTokens: 256,
    onResponse: () => {},
    fetchImpl: (async () => new Response(asSse(frames), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch,
  });
  return model.bindTools!([TOOL as never]);
}

function expectCompleteRolelessResult(message: AIMessage): void {
  expect(AIMessage.isInstance(message)).toBe(true);
  expect(message.content).toBe("Checking the report.");
  expect(message.tool_calls).toEqual([{
    id: "call-report",
    name: "report_probe",
    args: { status: "ok" },
    type: "tool_call",
  }]);
  expect(message.additional_kwargs["reasoning"]).toBe("synthetic reasoning");
  expect(message.response_metadata["finish_reason"]).toBe("tool_calls");
  expect(message.response_metadata["model_name"]).toBe("seller-model");
  expect(readSurplusResponseUsage(message)).toMatchObject({
    inputTokens: 596,
    outputTokens: 64,
    totalTokens: 660,
    buyerCostMicro: 687,
  });
}

describe("Surplus roleless OpenAI-compatible streams", () => {
  test.each(ROUTES)("reconstructs fragmented tools through invoke for $providerPin", async (route) => {
    const result = await rolelessModel(route).invoke([
      new HumanMessage("Run the report probe."),
    ]);

    expectCompleteRolelessResult(result as AIMessage);
  });

  test.each(ROUTES)("preserves all roleless chunks through stream for $providerPin", async (route) => {
    const chunks: AIMessageChunk[] = [];
    const model = rolelessModel(route);
    if (!model.stream) throw new Error("Surplus model does not expose streaming.");
    for await (const chunk of await model.stream([
      new HumanMessage("Run the report probe."),
    ])) {
      expect(AIMessageChunk.isInstance(chunk)).toBe(true);
      chunks.push(chunk as AIMessageChunk);
    }

    expect(chunks.map((chunk) => chunk.text).join("")).toBe("Checking the report.");
    expect(chunks.flatMap((chunk) => chunk.tool_call_chunks ?? [])).toEqual([
      {
        id: "call-report",
        name: "report_probe",
        args: "{\"stat",
        index: 0,
        type: "tool_call_chunk",
      },
      {
        args: "us\":\"ok\"}",
        index: 0,
        type: "tool_call_chunk",
      },
    ]);
    expect(chunks.some((chunk) => chunk.additional_kwargs["reasoning"] === "synthetic reasoning"))
      .toBe(true);
    expect(chunks.some((chunk) => chunk.response_metadata["finish_reason"] === "tool_calls"))
      .toBe(true);
    expect(chunks.some((chunk) => readSurplusResponseUsage(chunk)?.buyerCostMicro === 687))
      .toBe(true);
  });

  test.each(ROUTES)("reconstructs fragmented tools through callback-preferred invoke for $providerPin", async (route) => {
    const capture = new CaptureLLMEnd();
    const result = await rolelessModel(route).invoke(
      [new HumanMessage("Run the report probe.")],
      { callbacks: [capture] },
    );
    const generation = capture.output?.generations[0]?.[0] as ChatGeneration | undefined;

    expectCompleteRolelessResult(result as AIMessage);
    expect(generation).toBeDefined();
    expectCompleteRolelessResult(generation?.message as AIMessage);
    expect(generation?.generationInfo?.["finish_reason"]).toBe("tool_calls");
    expect(generation?.generationInfo?.["model_name"]).toBe("seller-model");
  });

  test.each(ROUTES)("preserves an explicit non-assistant role for $providerPin", async (route) => {
    const frames = [{
      id: "chatcmpl-explicit-role",
      object: "chat.completion.chunk",
      created: 1,
      model: "seller-model",
      choices: [{
        index: 0,
        delta: { role: "system", content: "provider notice" },
        finish_reason: "stop",
      }],
    }];
    const chunks: unknown[] = [];
    const model = rolelessModel(route, frames);
    if (!model.stream) throw new Error("Surplus model does not expose streaming.");
    for await (const chunk of await model.stream([
      new HumanMessage("Return the provider notice."),
    ])) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(SystemMessageChunk.isInstance(chunks[0])).toBe(true);
    expect((chunks[0] as SystemMessageChunk).content).toBe("provider notice");
  });
});
