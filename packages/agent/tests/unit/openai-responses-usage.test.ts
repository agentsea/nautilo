import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { OpenAIUsageResponses } from "../../src/providers/openai-compat";
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
