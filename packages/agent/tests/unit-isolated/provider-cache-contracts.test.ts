/**
 * Hermetic provider cache-contract characterization.
 *
 * Every adapter call is intercepted below its request serializer and global
 * fetch is a hard failure. These fixtures therefore pin the installed
 * LangChain 1.4.x adapter behavior without a provider request, credential, or
 * billable token.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import {
  ChatOpenAI,
  ChatOpenAICompletions,
  ChatOpenAIResponses,
  convertResponsesUsageToUsageMetadata,
} from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatFireworks } from "@langchain/fireworks";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { createUnmeteredEvaluationModel } from "../../src/providers/universal";
import { extractUsageFromLLMResult } from "../../src/usage/usage-callback";
import { projectPreparedMessagesForModelCache } from "../../src/utils/model-context-cache";

type WireRequest = Record<string, unknown>;
type GeneratedResult = { generations: Array<{ message: unknown }> };

type WireToolSignature = {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
};

let savedFetch: typeof globalThis.fetch;

function openAiCompatibleResponse(overrides: {
  readonly cachedTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly perfMetrics?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  const details: Record<string, unknown> = {
    cached_tokens: overrides.cachedTokens ?? 90,
  };
  if (overrides.cacheWriteTokens !== undefined) {
    details["cache_write_tokens"] = overrides.cacheWriteTokens;
  }
  return {
    id: "cache_fixture-hermetic",
    model: "cache_fixture-model",
    // This makes the installed OpenAI-compatible converter retain raw usage in
    // response_metadata, which is the only place its unnormalized
    // cache_write_tokens can survive.
    system_fingerprint: "cache_fixture-fingerprint",
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 7,
      total_tokens: 107,
      prompt_tokens_details: details,
    },
    ...(overrides.perfMetrics ? { perf_metrics: overrides.perfMetrics } : {}),
  };
}

function usageFromGenerated(result: GeneratedResult) {
  return extractUsageFromLLMResult({
    generations: [result.generations],
  } as unknown as LLMResult);
}

function expectOneRequest(requests: WireRequest[], expected: WireRequest): void {
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject(expected);
}

async function generate(
  model: unknown,
  messages: BaseMessage[] = [new HumanMessage("provider cache contract")],
): Promise<GeneratedResult> {
  return (model as {
    _generate: (messages: BaseMessage[], options: Record<string, never>) => Promise<GeneratedResult>;
  })._generate(messages, {});
}

function fixtureTool(name: string, description: string, schema: z.ZodType) {
  return new DynamicStructuredTool({
    name,
    description,
    schema,
    func: async () => "provider wire fixture must not execute",
  });
}

function wireToolSignatures(request: WireRequest): WireToolSignature[] {
  expect(request["tools"]).toBeArray();
  return (request["tools"] as Array<Record<string, unknown>>).map((entry) => {
    const nested = entry["function"];
    const source = nested && typeof nested === "object"
      ? nested as Record<string, unknown>
      : entry;
    expect(source["name"]).toBeString();
    expect(source["description"]).toBeString();
    expect(source["parameters"]).toBeObject();
    return {
      name: source["name"] as string,
      description: source["description"] as string,
      parameters: JSON.parse(JSON.stringify(source["parameters"])) as Record<string, unknown>,
    };
  });
}

async function invokeWithTools(model: unknown, tools: DynamicStructuredTool[]): Promise<void> {
  await (model as {
    bindTools: (boundTools: DynamicStructuredTool[]) => {
      invoke: (messages: BaseMessage[]) => Promise<unknown>;
    };
  }).bindTools(tools).invoke([new HumanMessage("selected-tool wire probe")]);
}

async function withOpenAICompatibleCompletion<T>(
  response: Record<string, unknown>,
  action: (requests: WireRequest[]) => Promise<T>,
): Promise<T> {
  const proto = ChatOpenAICompletions.prototype as unknown as {
    completionWithRetry: unknown;
  };
  const saved = proto.completionWithRetry;
  const requests: WireRequest[] = [];
  proto.completionWithRetry = async (request: WireRequest) => {
    requests.push(request);
    return response;
  };
  try {
    return await action(requests);
  } finally {
    proto.completionWithRetry = saved;
  }
}

async function withFireworksCompletion<T>(
  response: Record<string, unknown>,
  action: (requests: WireRequest[]) => Promise<T>,
): Promise<T> {
  const proto = ChatFireworks.prototype as unknown as {
    completionWithRetry: unknown;
  };
  const saved = proto.completionWithRetry;
  const requests: WireRequest[] = [];
  proto.completionWithRetry = async (request: WireRequest) => {
    requests.push(request);
    return response;
  };
  try {
    return await action(requests);
  } finally {
    proto.completionWithRetry = saved;
  }
}

async function withOpenAIResponses<T>(
  action: (requests: WireRequest[]) => Promise<T>,
): Promise<T> {
  const proto = ChatOpenAIResponses.prototype as unknown as {
    completionWithRetry: unknown;
  };
  const saved = proto.completionWithRetry;
  const requests: WireRequest[] = [];
  proto.completionWithRetry = async (request: WireRequest) => {
    requests.push(request);
    return {
      id: "resp_cache_fixture_hermetic",
      object: "response",
      created_at: 0,
      status: "completed",
      model: "gpt-5.6-luna",
      output_text: "ok",
      output: [{
        id: "msg_cache_fixture_hermetic",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      }],
      usage: {
        input_tokens: 100,
        output_tokens: 7,
        total_tokens: 107,
        input_tokens_details: { cached_tokens: 90, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
  };
  try {
    return await action(requests);
  } finally {
    proto.completionWithRetry = saved;
  }
}

beforeAll(() => {
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    throw new Error(`provider cache contract test blocked unexpected HTTP request: ${url}`);
  }) as unknown as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = savedFetch;
});

describe("provider cache contracts", () => {
  test("OpenAI, OpenRouter, and Fireworks immediately project the current ordered tool selection", async () => {
    const core = fixtureTool(
      "cache_fixture_core_tool",
      "Stable tool selected on every turn.",
      z.object({ acknowledgment: z.literal("stable") }),
    );
    const deferred = fixtureTool(
      "cache_fixture_deferred_tool",
      "tool selected only while its activation and authority remain live.",
      z.object({ query: z.string().min(1), mode: z.enum(["precise", "broad"]) }),
    );
    const stableTools = [core];
    const activatedTools = [core, deferred];

    const assertSelectionTransitions = (requests: WireRequest[]) => {
      expect(requests).toHaveLength(3);
      const stable = wireToolSignatures(requests[0]!);
      const activated = wireToolSignatures(requests[1]!);
      const deactivated = wireToolSignatures(requests[2]!);
      expect(stable.map(({ name }) => name)).toEqual(["cache_fixture_core_tool"]);
      expect(activated.map(({ name }) => name)).toEqual([
        "cache_fixture_core_tool",
        "cache_fixture_deferred_tool",
      ]);
      expect(activated[0]).toEqual(stable[0]);
      expect(deactivated).toEqual(stable);
    };

    await withOpenAIResponses(async (requests) => {
      const model = await createUnmeteredEvaluationModel("openai:gpt-5.6-luna", {
        apiKey: "cache_fixture-synthetic-key",
        maxTokens: 8192,
        openAIExplicitPromptCache: true,
      });
      await invokeWithTools(model, stableTools);
      await invokeWithTools(model, activatedTools);
      await invokeWithTools(model, stableTools);
      assertSelectionTransitions(requests);
      expect(requests.every((request) =>
        (request["prompt_cache_options"] as Record<string, unknown> | undefined)?.["mode"]
          === "implicit",
      )).toBe(true);
    });

    await withOpenAICompatibleCompletion(openAiCompatibleResponse(), async (requests) => {
      const model = await createUnmeteredEvaluationModel("openrouter:deepseek/deepseek-v4-flash", {
        apiKey: "cache_fixture-synthetic-key",
        openRouterSessionId: "22222222-2222-4222-8222-222222222222",
      });
      await invokeWithTools(model, stableTools);
      await invokeWithTools(model, activatedTools);
      await invokeWithTools(model, stableTools);
      assertSelectionTransitions(requests);
      expect(requests.every((request) =>
        request["session_id"] === "22222222-2222-4222-8222-222222222222",
      )).toBe(true);
    });

    await withFireworksCompletion(openAiCompatibleResponse(), async (requests) => {
      const model = await createUnmeteredEvaluationModel(
        "fireworks:accounts/fireworks/models/deepseek-v4-flash",
        {
          apiKey: "cache_fixture-synthetic-key",
          maxTokens: 4096,
          fireworksSessionAffinityId: "22222222-2222-4222-8222-222222222222",
        },
      );
      await invokeWithTools(model, stableTools);
      await invokeWithTools(model, activatedTools);
      await invokeWithTools(model, stableTools);
      assertSelectionTransitions(requests);
    });
  });

  test("direct OpenAI Chat Completions maps cached_tokens to Nautilo cache reads", async () => {
    await withOpenAICompatibleCompletion(openAiCompatibleResponse(), async (requests) => {
      const model = new ChatOpenAI({
        model: "gpt-5.6-luna",
        apiKey: "cache_fixture-synthetic-key",
        streamUsage: true,
      });
      const generated = await generate(model);

      expectOneRequest(requests, {
        model: "gpt-5.6-luna",
        stream: false,
      });
      expect(usageFromGenerated(generated)).toMatchObject({
        inputTokens: 100,
        outputTokens: 7,
        cachedInputTokens: 90,
        cacheCreationTokens: 0,
      });
    });
  });

  test("direct OpenAI Responses maps input_tokens_details.cached_tokens to cache reads", () => {
    expect(convertResponsesUsageToUsageMetadata({
      input_tokens: 100,
      output_tokens: 7,
      total_tokens: 107,
      input_tokens_details: { cached_tokens: 90 },
      output_tokens_details: { reasoning_tokens: 0 },
    })).toMatchObject({
      input_tokens: 100,
      output_tokens: 7,
      input_token_details: { cache_read: 90 },
    });
  });

  test("direct GPT-5.6 retains the explicit stable breakpoint with implicit history caching", async () => {
    await withOpenAIResponses(async (requests) => {
      const stable = "stable system and selected tool guidance";
      const volatile = "\nvolatile Memory, time, and message context";
      const messages = projectPreparedMessagesForModelCache(
        [new SystemMessage(stable + volatile), new HumanMessage("hello")],
        "openai:gpt-5.6-luna",
        stable.length,
        { openAIExplicitPromptCache: true },
      );
      const model = await createUnmeteredEvaluationModel("openai:gpt-5.6-luna", {
        apiKey: "cache_fixture-synthetic-key",
        maxTokens: 8192,
        openAIExplicitPromptCache: true,
      });
      const generated = await generate(model, messages);

      expectOneRequest(requests, {
        model: "gpt-5.6-luna",
        stream: false,
        prompt_cache_options: { mode: "implicit" },
        input: [
          {
            type: "message",
            role: "developer",
            content: [
              {
                type: "input_text",
                text: stable,
                prompt_cache_breakpoint: { mode: "explicit" },
              },
              { type: "input_text", text: volatile },
            ],
          },
          { type: "message", role: "user", content: "hello" },
        ],
      });
      expect(usageFromGenerated(generated)).toMatchObject({
        cachedInputTokens: 90,
      });
    });
  });

  test("direct Gemini maps cachedContentTokenCount to Nautilo cache reads", async () => {
    const proto = ChatGoogleGenerativeAI.prototype as unknown as {
      completionWithRetry: unknown;
    };
    const saved = proto.completionWithRetry;
    const requests: WireRequest[] = [];
    proto.completionWithRetry = async (request: WireRequest) => {
      requests.push(request);
      return {
        response: {
          candidates: [{
            content: { role: "model", parts: [{ text: "ok" }] },
            finishReason: "STOP",
          }],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 7,
            totalTokenCount: 107,
            cachedContentTokenCount: 90,
          },
        },
      };
    };
    try {
      const generated = await generate(new ChatGoogleGenerativeAI({
        model: "gemini-2.5-pro",
        apiKey: "cache_fixture-synthetic-key",
        streamUsage: true,
      }));

      expectOneRequest(requests, {
        contents: [{ role: "user", parts: [{ text: "provider cache contract" }] }],
      });
      expect(usageFromGenerated(generated)).toMatchObject({
        cachedInputTokens: 90,
        cacheCreationTokens: 0,
      });
    } finally {
      proto.completionWithRetry = saved;
    }
  });

  test("Fireworks perf-only cache metrics remain outside LangChain usage", async () => {
    const streamingShape = new ChatFireworks({
      model: "accounts/fireworks/models/glm-5p2",
      apiKey: "cache_fixture-synthetic-key",
      streaming: true,
    });
    // Mirrors Nautilo's factory repair for @langchain/fireworks@0.1.3.
    streamingShape.streamUsage = true;
    expect(streamingShape.invocationParams({})).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(streamingShape.invocationParams({})).not.toHaveProperty("perf_metrics_in_response");

    await withFireworksCompletion(openAiCompatibleResponse({
      cachedTokens: 0,
      perfMetrics: { "cached-prompt-tokens": 90 },
    }), async (requests) => {
      const model = new ChatFireworks({
        model: "accounts/fireworks/models/glm-5p2",
        apiKey: "cache_fixture-synthetic-key",
      });
      model.streamUsage = true;
      const generated = await generate(model);

      expectOneRequest(requests, {
        model: "accounts/fireworks/models/glm-5p2",
        stream: false,
      });
      expect(usageFromGenerated(generated)).toMatchObject({
        inputTokens: 100,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
      });
    });
  });

  test("Fireworks standard cached_tokens reaches Nautilo cache reads", async () => {
    await withFireworksCompletion(openAiCompatibleResponse({ cachedTokens: 90 }), async () => {
      const model = new ChatFireworks({
        model: "accounts/fireworks/models/deepseek-v4-flash-0731",
        apiKey: "cache_fixture-synthetic-key",
      });
      model.streamUsage = true;
      const generated = await generate(model);

      expect(usageFromGenerated(generated)).toMatchObject({
        inputTokens: 100,
        cachedInputTokens: 90,
        cacheCreationTokens: 0,
      });
    });
  });

  test("OpenRouter preserves cache reads and lets Nautilo recover raw cache writes", async () => {
    await withOpenAICompatibleCompletion(openAiCompatibleResponse({ cacheWriteTokens: 95 }), async (requests) => {
      const model = await createUnmeteredEvaluationModel("openrouter:openai/gpt-5.5", {
        apiKey: "cache_fixture-synthetic-key",
        openRouterSessionId: "22222222-2222-4222-8222-222222222222",
      });
      const generated = await generate(model);

      expect((model as unknown as { clientConfig: { baseURL: string } }).clientConfig.baseURL)
        .toBe("https://openrouter.ai/api/v1");
      expectOneRequest(requests, {
        model: "openai/gpt-5.5",
        stream: false,
        session_id: "22222222-2222-4222-8222-222222222222",
      });
      expect(usageFromGenerated(generated)).toMatchObject({
        cachedInputTokens: 90,
        cacheCreationTokens: 95,
      });
    });
  });

  test("Venice will record OpenAI-compatible cached_tokens when the provider returns them", async () => {
    await withOpenAICompatibleCompletion(openAiCompatibleResponse(), async (requests) => {
      const model = await createUnmeteredEvaluationModel("venice:zai-org-glm-5-2", {
        apiKey: "cache_fixture-synthetic-key",
      });
      const generated = await generate(model);

      expect((model as unknown as { clientConfig: { baseURL: string } }).clientConfig.baseURL)
        .toBe("https://api.venice.ai/api/v1");
      expectOneRequest(requests, {
        model: "zai-org-glm-5-2",
        stream: false,
      });
      expect(usageFromGenerated(generated)).toMatchObject({
        cachedInputTokens: 90,
        cacheCreationTokens: 0,
      });
    });
  });
});
