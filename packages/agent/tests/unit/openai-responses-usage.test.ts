import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { OpenAIUsageResponses } from "../../src/providers/openai-compat";
import { createEvaluationModel } from "../../src/providers/model-evaluation";
import { resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { activateModelCatalogForTests } from "../helpers/activate-model-catalog";
import { extractUsageFromLLMResult } from "../../src/usage/usage-callback";
import { projectPreparedMessagesForModelCache } from "../../src/utils/model-context-cache";

type Usage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details: { cached_tokens: number; cache_write_tokens: number };
  output_tokens_details: { reasoning_tokens: number };
};

function usage(input = 100, output = 7): Usage {
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: { cached_tokens: 60, cache_write_tokens: 25 },
    output_tokens_details: { reasoning_tokens: 3 },
  };
}

function textResponse(id: string, providerUsage: Usage, text = "done") {
  return {
    id,
    object: "response",
    created_at: 0,
    status: "completed",
    model: "gpt-5.6-sol",
    output_text: text,
    output: [{
      id: `message-${id}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    usage: providerUsage,
  };
}

function model(streaming = false): OpenAIUsageResponses {
  return new OpenAIUsageResponses({
    model: "gpt-5.6-sol",
    apiKey: "hermetic-test-key",
    streaming,
  });
}

function setCompletion(
  responses: OpenAIUsageResponses,
  completion: (request: Record<string, unknown>) => Promise<unknown>,
): void {
  (responses as unknown as { completionWithRetry: typeof completion }).completionWithRetry = completion;
}

function extracted(message: unknown) {
  return extractUsageFromLLMResult({
    generations: [[{ text: "", message }]],
  } as never);
}

describe("OpenAI Responses usage preservation", () => {
  test("late handoff instructions remain developer messages after the complete tool cycle", async () => {
    const responses = model();
    const requests: Array<Record<string, unknown>> = [];
    setCompletion(responses, async request => {
      requests.push(request);
      return textResponse("handoff", usage());
    });
    const stable = "Stable tool and authority instructions.";
    const messages = [new SystemMessage(stable + "\nCurrent turn context."),
      new HumanMessage("Adjust the control."),
      new AIMessage({ content: "", tool_calls: [{ id: "observe", name: "browser_snapshot", args: {} }] }),
      new ToolMessage({ name: "browser_snapshot", tool_call_id: "observe", content: "Control value is 6." })];
    const project = (input: typeof messages) => projectPreparedMessagesForModelCache(
      input, "openai:gpt-5.6-sol", stable.length, { openAIExplicitPromptCache: true });
    await responses.invoke(project(messages));
    await responses.invoke(project([...messages, new SystemMessage("Inspect the fresh observation before repairing the plan.")]));
    const before = requests[0]?.["input"] as Array<Record<string, unknown>>;
    const after = requests[1]?.["input"] as Array<Record<string, unknown>>;
    expect(after.slice(0, -1)).toEqual(before);
    expect(after[0]?.["role"]).toBe("developer");
    expect(after.at(-2)?.["type"]).toBe("function_call_output");
    expect(after.at(-1)?.["role"]).toBe("developer");
    expect(JSON.stringify(after.at(-1))).toContain("Inspect the fresh observation");
    expect(JSON.stringify(after[0])).toContain("prompt_cache_breakpoint");
  });

  test("non-streaming invoke retains raw cache-write usage and function calls", async () => {
    const responses = model();
    let wireRequest: Record<string, unknown> | undefined;
    setCompletion(responses, async (request) => {
      wireRequest = request;
      return {
        ...textResponse("tool", usage(), ""),
        output: [{
          id: "function-1",
          type: "function_call",
          status: "completed",
          call_id: "call-1",
          name: "choose_airport",
          arguments: JSON.stringify({ code: "MAD" }),
        }],
      };
    });

    const message = await responses.invoke([new HumanMessage("choose Madrid")]);

    expect(wireRequest?.["stream"]).toBe(false);
    expect(message.tool_calls).toEqual([{
      id: "call-1",
      name: "choose_airport",
      args: { code: "MAD" },
      type: "tool_call",
    }]);
    expect(message.response_metadata["usage"]).toEqual(usage());
    expect(extracted(message)).toMatchObject({
      inputTokens: 100,
      outputTokens: 7,
      cachedInputTokens: 60,
      cacheCreationTokens: 25,
      reasoningTokens: 3,
    });
  });

  test("streaming invoke keeps response.completed raw usage without double-counting normalized cache", async () => {
    const responses = model(true);
    const providerUsage = usage();
    setCompletion(responses, async () => (async function* stream() {
      yield { type: "response.output_text.delta", sequence_number: 0, item_id: "message-stream", output_index: 0, content_index: 0, delta: "done" };
      yield {
        type: "response.completed",
        sequence_number: 1,
        response: textResponse("stream", providerUsage),
      };
    })());

    const message = await responses.invoke([new HumanMessage("stream")]);
    expect(message.content).toEqual([{ type: "text", text: "done", index: 0 }]);
    expect(message.response_metadata["usage"]).toEqual(providerUsage);
    expect(extracted(message)).toMatchObject({
      inputTokens: 100,
      outputTokens: 7,
      cachedInputTokens: 60,
      cacheCreationTokens: 25,
      reasoningTokens: 3,
    });
  });

  test("concurrent non-streaming invokes retain only their own usage", async () => {
    const responses = model();
    const releases: Array<(value: unknown) => void> = [];
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    setCompletion(responses, () => new Promise((resolve) => {
      releases.push(resolve);
      if (releases.length === 2) bothStarted();
    }));

    const first = responses.invoke([new HumanMessage("first")]);
    const second = responses.invoke([new HumanMessage("second")]);
    await started;
    expect(releases).toHaveLength(2);

    releases[1]!(textResponse("second", usage(202, 12), "second"));
    releases[0]!(textResponse("first", usage(101, 11), "first"));
    const [firstMessage, secondMessage] = await Promise.all([first, second]);

    expect(firstMessage.content).toMatchObject([{ type: "text", text: "first" }]);
    expect(extracted(firstMessage)).toMatchObject({ inputTokens: 101, outputTokens: 11 });
    expect(secondMessage.content).toMatchObject([{ type: "text", text: "second" }]);
    expect(extracted(secondMessage)).toMatchObject({ inputTokens: 202, outputTokens: 12 });
  });
});

describe("direct GPT-6 Responses function continuation", () => {
  const models = ["openai:gpt-6-astra", "openai:gpt-6-sol", "openai:gpt-6-luna"] as const;
  beforeAll(async () => { await activateModelCatalogForTests(models); });
  afterAll(() => resetRuntimeModelCatalog());
  const tool = new DynamicStructuredTool({
    name: "read_fixture",
    description: "Read a synthetic fixture by key.",
    schema: z.object({ key: z.string() }),
    func: async ({ key }) => `fixture:${key}`,
  });

  for (const modelId of models) {
    test(`${modelId} sends two real serialized Responses requests with the same tool ID`, async () => {
      const originalFetch = globalThis.fetch;
      const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
      const providerUsage = usage();
      const callId = `call_${modelId.slice("openai:".length).replaceAll("-", "_")}`;
      const effort = modelId === "openai:gpt-6-sol" ? "high" : "medium";
      globalThis.fetch = (async (input, init) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        const path = new URL(request.url).pathname;
        const body = JSON.parse(await request.text()) as Record<string, unknown>;
        requests.push({ path, body });
        if (path !== "/v1/responses" || requests.length > 2) {
          throw new Error(`Unexpected provider request: ${path}`);
        }
        const first = requests.length === 1;
        const response = first ? {
          id: "resp_tool",
          object: "response",
          created_at: 1,
          status: "completed",
          model: modelId.slice("openai:".length),
          output: [
            { type: "reasoning", id: "rs_tool", summary: [] },
            { type: "function_call", id: "fc_tool", call_id: callId, name: tool.name, arguments: JSON.stringify({ key: "safe" }), status: "completed" },
          ],
          output_text: "",
          usage: providerUsage,
        } : textResponse("final", providerUsage, "The fixture is fixture:safe.");
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      try {
        const model = await createEvaluationModel(modelId, {
          apiKey: "synthetic-key",
          maxTokens: 256,
          reasoningOutput: false,
          ...(modelId === "openai:gpt-6-astra" ? {} : { reasoningEffort: effort }),
          useOpenAIResponsesApi: true,
        });
        const prompt = new HumanMessage("Read fixture safe, then report its value.");
        const first = await model.bindTools!([tool], { tool_choice: "required" }).invoke([prompt]) as AIMessage;
        expect(first.tool_calls).toMatchObject([{ id: callId, name: tool.name, args: { key: "safe" } }]);
        expect(first.response_metadata["usage"]).toEqual(providerUsage);
        const toolResult = await tool.invoke(first.tool_calls![0]!);
        expect(ToolMessage.isInstance(toolResult)).toBe(true);
        const final = await model.bindTools!([tool], { tool_choice: "auto" }).invoke([
          prompt,
          first,
          toolResult as ToolMessage,
        ]) as AIMessage;

        expect(requests.map(({ path }) => path)).toEqual(["/v1/responses", "/v1/responses"]);
        expect(requests.map(({ body }) => body["reasoning"])).toEqual([{ effort }, { effort }]);
        for (const { body } of requests) {
          expect(body["model"]).toBe(modelId.slice("openai:".length));
          expect(body["tools"]).toEqual(expect.arrayContaining([expect.objectContaining({ name: tool.name })]));
        }
        expect(requests[0]!.body["tool_choice"]).toBe("required");
        expect(requests[1]!.body["tool_choice"]).toBe("auto");
        expect(requests[1]!.body["tool_choice"]).toBe("auto");
        const continuation = requests[1]!.body["input"] as Array<Record<string, unknown>>;
        expect(continuation.some(item => item["type"] === "reasoning" && item["id"] === "rs_tool")).toBe(true);
        expect(continuation.some(item => item["type"] === "function_call" && item["call_id"] === callId)).toBe(true);
        expect(continuation.some(item => item["type"] === "function_call_output"
          && item["call_id"] === callId && item["output"] === "fixture:safe")).toBe(true);
        expect(final.text).toContain("fixture:safe");
        expect(final.response_metadata["usage"]).toEqual(providerUsage);
        expect(extracted(final)).toMatchObject({ inputTokens: 100, outputTokens: 7, reasoningTokens: 3 });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  test("an explicit Sol off effort and empty tools retain Responses", async () => {
    const originalFetch = globalThis.fetch;
    let path = "";
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      path = new URL(request.url).pathname;
      body = JSON.parse(await request.text()) as Record<string, unknown>;
      return new Response(JSON.stringify(textResponse("off", usage(), "done")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const model = await createEvaluationModel("openai:gpt-6-sol", {
        apiKey: "synthetic-key", maxTokens: 256, reasoningOutput: false,
        reasoningEffort: "off", useOpenAIResponsesApi: true,
      });
      await model.bindTools!([], { tool_choice: "none" }).invoke([new HumanMessage("Say done.")]);
      expect(path).toBe("/v1/responses");
      expect(body["reasoning"]).toEqual({ effort: "none" });
      expect(body["tool_choice"]).toBe("none");
      expect(body).not.toHaveProperty("tools");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


test("streaming output-limit completion retains partial text, status, and usage", async () => {
  const responses = model(true);
  const partial = { ...textResponse("partial", usage(), "Partial"), status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" } };
  setCompletion(responses, async () => (async function* () {
    yield { type: "response.output_text.delta", item_id: "message-partial", output_index: 0, content_index: 0, delta: "Partial" };
    yield { type: "response.incomplete", response: partial };
  })());
  const result = await responses.invoke([new HumanMessage("Long reply")]);
  expect(result.text).toBe("Partial");
  expect(result.response_metadata["status"]).toBe("incomplete");
  expect(result.response_metadata["incomplete_details"]).toEqual({ reason: "max_output_tokens" });
  expect(extracted(result)).toMatchObject({ inputTokens: 100, outputTokens: 7 });
});

for (const yieldsAfterAbort of [false, true]) {
  test(`stream cancellation rejects partial output when another event follows: ${yieldsAfterAbort}`, async () => {
    const responses = model(true);
    const controller = new AbortController();
    const cancellation = new Error("Generation cancelled");
    setCompletion(responses, async () => (async function* () {
      yield { type: "response.output_text.delta", item_id: "message-partial", output_index: 0, content_index: 0, delta: "Partial" };
      controller.abort(cancellation);
      if (yieldsAfterAbort) yield { type: "response.completed", response: textResponse("partial", usage()) };
    })());
    const result = await responses.invoke([new HumanMessage("Reply")], { signal: controller.signal })
      .catch((error: unknown) => error);
    expect(result).toBe(cancellation);
  });
}
