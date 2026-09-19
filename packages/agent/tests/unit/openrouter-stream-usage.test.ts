import { describe, expect, test } from "bun:test";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { HumanMessage, type AIMessage } from "@langchain/core/messages";
import type { ChatGeneration, LLMResult } from "@langchain/core/outputs";
import { OpenRouterReasoningCompletions } from "../../src/providers/openrouter-reasoning";
import { extractUsageFromLLMResult } from "../../src/usage/usage-callback";

type StreamChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: string | null;
  }>;
  usage?: Usage;
};

type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number;
  prompt_tokens_details: {
    cached_tokens: number;
    cache_write_tokens: number;
  };
  completion_tokens_details: { reasoning_tokens: number };
};

const usage: Usage = {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  cost: 0.0123,
  prompt_tokens_details: { cached_tokens: 15, cache_write_tokens: 7 },
  completion_tokens_details: { reasoning_tokens: 5 },
};

const chunk = (
  choices: StreamChunk["choices"],
  reportedUsage?: Usage,
): StreamChunk => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  created: 0,
  model: "test/model",
  choices,
  ...(reportedUsage ? { usage: reportedUsage } : {}),
});

const choice = (
  content: string,
  finishReason: string | null = null,
): StreamChunk["choices"][number] => ({
  index: 0,
  delta: { role: "assistant", content },
  finish_reason: finishReason,
});

function asResult(message: AIMessage): LLMResult {
  const generation: ChatGeneration = {
    text: typeof message.content === "string" ? message.content : "",
    message,
  };
  return {
    generations: [[generation]],
  };
}

function sseResponse(chunks: StreamChunk[]): Response {
  const body = `${chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

class CaptureLLMEnd extends BaseCallbackHandler {
  name = "capture_openrouter_usage";
  output: LLMResult | undefined;

  override handleLLMEnd(output: LLMResult): void {
    this.output = output;
  }
}

async function invokeStream(baseURL: string, chunks: StreamChunk[]) {
  const requests: string[] = [];
  const capture = new CaptureLLMEnd();
  const model = new OpenRouterReasoningCompletions({
    model: "test/model",
    apiKey: "unused-test-key",
    streaming: true,
    maxRetries: 0,
    callbacks: [capture],
    configuration: {
      baseURL,
      fetch: (input: Parameters<typeof fetch>[0]) => {
        requests.push(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        return Promise.resolve(sseResponse(chunks));
      },
    },
  });

  const message = await model.invoke([new HumanMessage("synthetic prompt")]);
  if (!capture.output) throw new Error("Expected the completed invocation callback");
  return { message, output: capture.output, requests };
}

describe.each([
  ["direct OpenRouter", "https://openrouter.ai/api/v1"],
  ["Nautilo Gateway", "http://127.0.0.1:43318/v1"],
])("OpenRouter streaming usage through %s", (_label, baseURL) => {
  test("records a choice-attached provider receipt exactly once", async () => {
    const { message, output, requests } = await invokeStream(baseURL, [
      chunk([choice("hello", "stop")], usage),
    ]);

    expect(requests).toEqual([`${baseURL}/chat/completions`]);
    expect(message.content).toBe("hello");
    expect(extractUsageFromLLMResult(output)).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      reasoningTokens: 5,
      cachedInputTokens: 15,
      cacheCreationTokens: 7,
      actualCostUsd: 0.0123,
    });
  });

  test("keeps a usage-only final frame", async () => {
    const { message, output } = await invokeStream(baseURL, [
      chunk([choice("hello")]),
      chunk([choice("", "stop")]),
      chunk([], usage),
    ]);

    expect(message.content).toBe("hello");
    expect(extractUsageFromLLMResult(output)?.actualCostUsd).toBe(0.0123);
    expect(extractUsageFromLLMResult(output)?.cacheCreationTokens).toBe(7);
  });

  test("uses the final cumulative receipt when choice frames repeat usage", async () => {
    const partialUsage: Usage = {
      ...usage,
      completion_tokens: 10,
      total_tokens: 110,
      cost: 0.006,
      completion_tokens_details: { reasoning_tokens: 2 },
    };
    const { message, output } = await invokeStream(baseURL, [
      chunk([choice("hel")], partialUsage),
      chunk([choice("lo", "stop")], usage),
    ]);

    expect(message.content).toBe("hello");
    expect(extractUsageFromLLMResult(output)).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      reasoningTokens: 5,
      cachedInputTokens: 15,
      cacheCreationTokens: 7,
      actualCostUsd: 0.0123,
    });
  });

  test("preserves content when the provider omits usage", async () => {
    const { message, output } = await invokeStream(baseURL, [
      chunk([choice("hello", "stop")]),
    ]);

    expect(message.content).toBe("hello");
    const extracted = extractUsageFromLLMResult(output);
    expect(extracted?.inputTokens).toBeGreaterThan(0);
    expect(extracted?.outputTokens).toBeGreaterThan(0);
    expect(extracted?.actualCostUsd).toBeNull();
    expect(extracted?.cacheCreationTokens).toBe(0);
  });
});

test("non-streaming usage remains unchanged", async () => {
  const model = new OpenRouterReasoningCompletions({
    model: "test/model",
    apiKey: "unused-test-key",
    maxRetries: 0,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      fetch: () => Promise.resolve(new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "test/model",
        system_fingerprint: "test",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "hello" },
          finish_reason: "stop",
        }],
        usage,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })),
    },
  });

  const message = await model.invoke([new HumanMessage("synthetic prompt")]);
  expect(extractUsageFromLLMResult(asResult(message))).toMatchObject({
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    reasoningTokens: 5,
    cachedInputTokens: 15,
    actualCostUsd: 0.0123,
  });
});
