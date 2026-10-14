import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatGPTPlanResponses, createChatGPTPlanModel } from "../../../src/providers/chatgpt-plan";

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
function model() { return new ChatGPTPlanResponses({ model: "gpt-6.1-sol", apiKey: "synthetic-access", maxRetries: 0, streaming: false }); }
async function drain(stream: AsyncIterable<unknown>) { for await (const _chunk of stream) { /* consume terminal events */ } }
async function failure(promise: Promise<unknown>) { try { await promise; return null; } catch (error) { return String(error); } }

describe("subscription Responses wire", () => {
  test("always streams without storage or unsupported parameters", () => {
    const params = model().invocationParams({ previous_response_id: "synthetic-previous", temperature: 0.5 });
    expect(params.stream).toBe(true); expect(params.store).toBe(false);
    for (const key of ["previous_response_id", "temperature", "max_output_tokens", "metadata", "truncation"]) expect(key in params).toBe(false);
    expect(params.include).toEqual(["reasoning.encrypted_content"]);
  });
  test("puts client functions in a namespace and rejects unsupported hosted tools", () => {
    const params = model().invocationParams({ tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }] });
    expect(params.tools?.[0]).toMatchObject({ type: "namespace", name: "nautilo", tools: [{ type: "function", name: "lookup" }] });
    expect(() => model().invocationParams({ tools: [{ type: "file_search", vector_store_ids: ["synthetic"] }] })).toThrow("unsupported_input");
  });
  test("converts system history and refuses a stream without completion", async () => {
    const instance = model();
    spies.push(spyOn(instance, "completionWithRetry").mockImplementation((async (request: Parameters<ChatGPTPlanResponses["completionWithRetry"]>[0]) => {
      expect(request.stream).toBe(true); expect(request.store).toBe(false);
      expect(request.input).toMatchObject([{ role: "developer" }, { role: "user" }]);
      return (async function* () { yield { type: "response.output_text.delta", delta: "Partial", item_id: "synthetic-item", output_index: 0, content_index: 0, sequence_number: 1 }; })();
    }) as ChatGPTPlanResponses["completionWithRetry"]));
    expect(await failure(drain(instance._streamResponseChunks([new SystemMessage("Follow the rules"), new HumanMessage("Hello")], {})))).toContain("stream_interrupted");
  });
  test("usage limit after text stays a failure", async () => {
    const instance = model();
    spies.push(spyOn(instance, "completionWithRetry").mockImplementation(async () => (async function* () {
      yield { type: "response.output_text.delta", delta: "Partial", item_id: "synthetic-item", output_index: 0, content_index: 0, sequence_number: 1 };
      yield { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } };
    })() as never));
    expect(await failure(drain(instance._streamResponseChunks([new HumanMessage("Hello")], {})))).toContain("subscription_limit");
  });
  test("factory rejects use of subscription credentials for another provider", () => {
    expect(() => createChatGPTPlanModel({ modelId: "venice:example" }, "synthetic-access")).toThrow("unsupported_input");
  });
});

test("factory bindTools and invoke use the subscription transport and replay encrypted reasoning", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
    const body = JSON.parse(init.body) as Record<string, unknown>; bodies.push(body);
    const sequence = [
      { type: "response.created", response: { id: "resp_synthetic", model: "gpt-6.1-sol" } },
      { type: "response.output_text.delta", delta: "Hello", item_id: "msg_synthetic", output_index: 0, content_index: 0 },
      { type: "response.completed", response: { id: "resp_synthetic", model: "gpt-6.1-sol", status: "completed",
        output: [{ type: "reasoning", id: "rs_synthetic", summary: [], encrypted_content: "synthetic-opaque-reasoning" },
          { type: "message", role: "assistant", id: "msg_synthetic", status: "completed", content: [{ type: "output_text", text: "Hello", annotations: [] }] }],
        usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } },
    ];
    return new Response(sequence.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  });
  spies.push(fetchSpy);
  const llm = createChatGPTPlanModel({ modelId: "openai:gpt-6.1-sol" }, "synthetic-access");
  const bound = llm.bindTools!([{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }]);
  const reply = await bound.invoke([new HumanMessage("Hello")]);
  const { AIMessage } = await import("@langchain/core/messages");
  expect(AIMessage.isInstance(reply)).toBe(true);
  if (!AIMessage.isInstance(reply)) throw new Error("Missing model response");
  await bound.invoke([new HumanMessage("Hello"), reply, new HumanMessage("Continue")]);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toMatchObject({ stream: true, store: false, tools: [{ type: "namespace" }] });
  expect(bodies[1]!["input"]).toContainEqual({ type: "reasoning", id: "rs_synthetic", summary: [], encrypted_content: "synthetic-opaque-reasoning" });
  expect(bodies[1]!["previous_response_id"]).toBeUndefined();
});
