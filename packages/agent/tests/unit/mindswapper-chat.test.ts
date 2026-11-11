import { afterEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  withMindSwapperConnection,
  withMindSwapperModels,
  type MindSwapperChatModel,
} from "../../src/config/mindswapper-models";
import { getEligibleModels, resolveRetainedModels } from "../../src/config/eligible-models";
import { resolveCatalogModel } from "../../src/config/resolved-catalog";
import { validateExactTaskModelSelection } from "../../src/config/validate-exact-task-model";
import { resolveModelRole } from "../../src/config/model-role-resolution";
import { createUnmeteredEvaluationModel } from "../../src/providers/universal";
import { resolveModelExecutionLimits } from "../../src/providers/models";
import { createDiscoverModelsTool } from "../../src/tools/meta/discover-models";
import { buildForegroundModelControlPlan } from "../../src/config/foreground-model-controls";
import { resolveCompletionBudget, resolvePreparedMessageBudget } from "../../src/utils/chat-model-invocation";

const modelId = "mindswapper:maker/Test-model";
const upstreamId = "maker/Test-model";
const requestId = "c9c6d06b-1ba7-40df-b07d-34b0169b6684";
const connection = { baseUrl: "https://gateway.example.test/v1", apiKey: "fixture-key" };
const model: MindSwapperChatModel = {
  id: modelId,
  displayName: "Example Chat",
  offers: [{ inputModalities: ["text"], supportedParameters: ["tools"], maxInputTokens: 8_192, maxOutputTokens: 2_048 }],
};
const usage = { prompt_tokens: 15, completion_tokens: 4, total_tokens: 19 };
const initialFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = initialFetch; });

function withConnection<T>(run: () => T, row = model): T {
  return withMindSwapperModels([row], () => withMindSwapperConnection(connection, run));
}

function stubFetch(run: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(run(url, init));
  }) as typeof fetch;
}

function wireBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("expected a JSON request body");
  return JSON.parse(init.body) as Record<string, unknown>;
}

function completion(): Response {
  return Response.json({
    id: requestId, object: "chat.completion", created: 1, model: upstreamId, usage,
    choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  }, { headers: { "x-request-id": requestId } });
}

function frame(choices: unknown[], cumulativeUsage?: typeof usage): string {
  return `data: ${JSON.stringify({ id: requestId, object: "chat.completion.chunk", created: 1, model: upstreamId, choices,
    ...(cumulativeUsage ? { usage: cumulativeUsage } : {}) })}\n\n`;
}

function streamResponse(data: string, terminated: boolean): Response {
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(data));
      if (terminated) {
        controller.enqueue(enc.encode("data: [DO"));
        controller.enqueue(enc.encode("NE]\n\n"));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "x-request-id": requestId } });
}

describe("scoped MindSwapper model catalogue", () => {
  test("projects a discovered exact model only inside its authorized scope", async () => {
    expect(resolveCatalogModel(modelId).availability).toBe("unknown_model");
    await withMindSwapperModels([model], async () => {
      await Promise.resolve();
      expect(getEligibleModels({ purpose: "chat-tools" }).find((row) => row.id === modelId)?.provider).toBe("mindswapper");
      expect(resolveModelRole("chat", { configuredId: modelId })).toBe(modelId);
      expect(() => resolveModelRole("chat", { env: {} })).toThrow("No signed, credentialed model");
      const plan = buildForegroundModelControlPlan(null, { modelId }, "openai:gpt-5", new Map());
      expect(plan.initialModelId).toBe(modelId);
      expect(plan.resolveForegroundControls?.(modelId)).toBeUndefined();
      expect(() => resolveModelRole("webSearchSynthesis", { configuredId: modelId })).toThrow("native text Tasks");
      expect(validateExactTaskModelSelection({ requestedModelId: modelId })).toBeNull();
      expect(await resolveModelExecutionLimits(modelId)).toMatchObject({
        maxInputTokens: 8_192, maxOutputTokens: 2_048, contextTokens: 10_240,
      });
    });
    expect(validateExactTaskModelSelection({ requestedModelId: modelId })?.code).toBe("unknown_model");
    expect(resolveRetainedModels([modelId])[0]?.unavailableReason).toContain("MindSwapper connection");
  });

  test("honors separate input and output limits for a small-context model", async () => {
    await withMindSwapperModels([{ ...model, offers: [{
      inputModalities: ["text"], supportedParameters: [], maxInputTokens: 1_024, maxOutputTokens: 256,
    }] }], async () => {
      expect(await resolvePreparedMessageBudget(modelId)).toBe(1_024);
      expect(await resolveCompletionBudget(modelId, [new HumanMessage("hello")])).toBe(256);
    });
  });

  test("keeps tool capability and image limits on a single offer", () => {
    const offers: MindSwapperChatModel = { ...model, offers: [...model.offers, {
      inputModalities: ["text", "image"], supportedParameters: ["response_format"], maxInputTokens: 32_768, maxOutputTokens: 4_096,
    }] };
    withMindSwapperModels([offers], () => {
      expect(resolveCatalogModel(modelId)).toMatchObject({
        input: ["text"], maxOutputTokens: 2_048, features: { tools: true, structuredOutputs: false },
      });
      expect(getEligibleModels({ purpose: "vision-tools" }).some((row) => row.id === modelId)).toBe(false);
    });
  });

  test("keeps tool discovery isolated across concurrent caller scopes", async () => {
    const tool = createDiscoverModelsTool({ env: {} });
    const anotherId = "mindswapper:maker/other";
    const lookup = async () => {
      const result = await tool.invoke({ command: "get", model_id: modelId });
      return JSON.parse(result) as { found: boolean; model?: { id: string } };
    };
    const [selected, hidden] = await Promise.all([
      withMindSwapperModels([model], lookup),
      withMindSwapperModels([{ ...model, id: anotherId }], lookup),
    ]);
    expect(selected).toMatchObject({ found: true, model: { id: modelId } });
    expect(hidden.found).toBe(false);
  });

  test("shows unavailable saved selections without making them runnable", () => {
    const disabled = { ...model, offers: [], unavailableReason: "MindSwapper model is temporarily unavailable" };
    withMindSwapperModels([disabled], () => {
      expect(resolveRetainedModels([modelId])[0]).toMatchObject({
        displayName: model.displayName, enabled: false, unavailableReason: disabled.unavailableReason,
      });
      expect(validateExactTaskModelSelection({ requestedModelId: modelId })?.code).toBe("disabled");
    });
  });
});

describe("MindSwapper Chat Completions", () => {
  test("requires a trusted connection instead of accepting arbitrary factory overrides", async () => {
    await assert.rejects(withMindSwapperModels([model], () => createUnmeteredEvaluationModel(modelId, connection)), /requires an admitted connection/);
  });

  test("sends the exact discovered model, explicit key and output limit and preserves receipt identity", async () => {
    let requests = 0;
    stubFetch((url, init) => {
      requests++;
      expect(url).toBe(`${connection.baseUrl}/chat/completions`);
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${connection.apiKey}`);
      expect(wireBody(init)).toMatchObject({
        model: upstreamId, max_tokens: 123, messages: [{ role: "user", content: "hello" }], stream: false,
      });
      return completion();
    });
    const response = await withConnection(async () => {
      const chat = await createUnmeteredEvaluationModel(modelId, { maxTokens: 123, useOpenAIResponsesApi: true });
      return chat.invoke([new HumanMessage("hello")]) as Promise<AIMessage>;
    });
    expect(response.content).toBe("hello");
    expect(response.response_metadata["request_id"]).toBe(requestId);
    expect(response.usage_metadata).toMatchObject({ total_tokens: 19 });
    expect(requests).toBe(1);
  });

  test("streams a function call, records terminal usage once and accepts its matching result", async () => {
    const tool = { type: "function", function: { name: "look_up", parameters: { type: "object", properties: {} } } };
    let requests = 0;
    stubFetch((_url, init) => {
      requests++;
      const wire = wireBody(init);
      expect(wire["tools"]).toEqual([tool]);
      if (requests === 1) {
        expect(wire["stream_options"]).toEqual({ include_usage: true });
        return streamResponse(frame([{ index: 0, delta: { role: "assistant", tool_calls: [
          { index: 0, id: "call_fixture", type: "function", function: { name: "look_up", arguments: "{}" } },
        ] }, finish_reason: null }]) + frame([{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage) + frame([], usage), true);
      }
      const messages = wire["messages"] as unknown[];
      expect(messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_fixture", content: "result" });
      return completion();
    });
    await withConnection(async () => {
      const chat = (await createUnmeteredEvaluationModel(modelId, { maxTokens: 128 })).bindTools!([tool]);
      const messages = [new HumanMessage("look it up")];
      let aggregate: AIMessageChunk | undefined;
      for await (const value of await chat.stream!(messages)) {
        const chunk = value as AIMessageChunk;
        aggregate = aggregate ? aggregate.concat(chunk) : chunk;
      }
      expect(aggregate?.tool_calls?.[0]).toMatchObject({ name: "look_up", id: "call_fixture", args: {} });
      expect(aggregate?.usage_metadata).toMatchObject({ total_tokens: 19 });
      expect(aggregate?.response_metadata["request_id"]).toBe(requestId);
      const response = await chat.invoke([
        ...messages,
        new AIMessage({ content: "", tool_calls: aggregate?.tool_calls ?? [] }),
        new ToolMessage({ content: "result", tool_call_id: "call_fixture" }),
      ]) as AIMessage;
      expect(response.content).toBe("hello");
    });
    expect(requests).toBe(2);
  });

  test("rejects an unsupported input before sending any request", async () => {
    let requests = 0;
    stubFetch(() => { requests++; return completion(); });
    await assert.rejects(withConnection(async () => {
      const chat = await createUnmeteredEvaluationModel(modelId);
      return chat.invoke([new HumanMessage({ content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ] })]);
    }), { code: "unsupported_request", status: 400 });
    expect(requests).toBe(0);
  });

  test("distinguishes insufficient credit without leaking the provider error body or retrying", async () => {
    let requests = 0;
    stubFetch(() => {
      requests++;
      return Response.json({ error: { message: "untrusted provider details" } }, { status: 402 });
    });
    await assert.rejects(withConnection(async () => {
      const chat = await createUnmeteredEvaluationModel(modelId);
      return chat.invoke([new HumanMessage("hello")]);
    }), { status: 402, code: "insufficient_balance", outcomeUnknown: false });
    expect(requests).toBe(1);
  });

  test("rejects a disconnected stream even when it has emitted visible content", async () => {
    let requests = 0;
    stubFetch((_url, init) => {
      requests++;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frame([
            { index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null },
          ])));
          init?.signal?.addEventListener("abort", () => controller.error(new Error("stream cancelled")), { once: true });
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    await withConnection(async () => {
      const chat = await createUnmeteredEvaluationModel(modelId);
      const abort = new AbortController();
      const stream = await chat.stream!([new HumanMessage("hello")], { signal: abort.signal });
      await assert.rejects(async () => {
        for await (const chunk of stream) {
          expect(chunk).toMatchObject({ content: "partial" });
          abort.abort();
        }
      });
    });
    expect(requests).toBe(1);
  });

  test("treats EOF without the required SSE terminator as unknown", async () => {
    stubFetch(() => streamResponse(frame([{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: "stop" }]), false));
    await assert.rejects(withConnection(async () => {
      const chat = await createUnmeteredEvaluationModel(modelId);
      for await (const _ of await chat.stream!([new HumanMessage("hello")])) { /* consume */ }
    }), { code: "outcome_unknown", outcomeUnknown: true });
  });
});
