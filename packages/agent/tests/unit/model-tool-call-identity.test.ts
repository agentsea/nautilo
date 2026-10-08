import { describe, expect, test } from "bun:test";
import { AIMessage, AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import { load } from "@langchain/core/load";
import { convertMessagesToCompletionsMessageParams, convertMessagesToResponsesInput } from "@langchain/openai";
import { mergeMessagesPreservingInvariants, validateMessageHistory, assignStableToolMessageId } from "@nautilo/message-invariants";
import { normalizeModelToolCallIdentity } from "../../src/nodes/model-tool-call-identity";
import { computeMessageFingerprint } from "../../src/store/fingerprint";
import { modelOutputPreflightNode } from "../../src/nodes/model-output-preflight";
import type { NautiloState } from "../../src/agent/state";

const call = (id?: string, args = {}) => ({ ...(id === undefined ? {} : { id }), name: "fixture_read", args, type: "tool_call" as const });
function admit(id = "fixture_read:0"): AIMessage {
  return normalizeModelToolCallIdentity(new AIMessage({ content: "Checking", tool_calls: [call(id)] }));
}
function result(message: AIMessage): ToolMessage {
  const tool = new ToolMessage({ content: "same result", tool_call_id: message.tool_calls![0]!.id!, name: "fixture_read" });
  assignStableToolMessageId(tool);
  return tool;
}

describe("model tool invocation admission", () => {
  test("fresh identical calls stay separate in merge, history, and fingerprints; real replay deduplicates", () => {
    const first = admit(); const second = admit();
    expect(first.tool_calls![0]!.id).not.toBe(second.tool_calls![0]!.id);
    const firstResult = result(first); const secondResult = result(second);
    expect(computeMessageFingerprint(firstResult)).not.toBe(computeMessageFingerprint(secondResult));
    const history = mergeMessagesPreservingInvariants([first, firstResult], [second, secondResult]);
    expect(history).toHaveLength(4);
    expect(validateMessageHistory(history).messages).toHaveLength(4);
    const replay = mergeMessagesPreservingInvariants(history, [secondResult]);
    expect(replay).toHaveLength(4);
    expect(replay.filter((message) => ToolMessage.isInstance(message))).toHaveLength(2);
    expect(normalizeModelToolCallIdentity(second)).toBe(second);
    expect(computeMessageFingerprint(result(second))).toBe(computeMessageFingerprint(secondResult));
  });

  test("same-response duplicate and missing IDs are distinct and provider safe", () => {
    const source = new AIMessage({ content: "", tool_calls: [call("same"), call("same"), call()] });
    const message = normalizeModelToolCallIdentity(source);
    const ids = message.tool_calls!.map((entry) => entry.id!);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(source.tool_calls!.map((entry) => entry.id)).toEqual(["same", "same", undefined]);
    expect(message.additional_kwargs["nautilo_tool_invocations"]).toMatchObject({
      version: 1, calls: [{ providerId: "same" }, { providerId: "same" }, { providerId: null }],
    });
  });

  test("rewrites structured, content, and raw calls together without changing arguments or signed content", () => {
    const source = new AIMessage({ id: "provider-response", content: [
      { type: "thinking", thinking: "opaque", signature: "signed-value" },
      { type: "tool_use", id: "same", name: "fixture_read", input: { path: "one" } },
      { type: "tool_use", id: "same", name: "fixture_read", input: { path: "two" } },
    ], tool_calls: [call("same", { path: "one" }), call("same", { path: "two" })],
    additional_kwargs: { tool_calls: [
      { id: "same", type: "function", function: { name: "fixture_read", arguments: '{"path":"two"}' } },
      { id: "same", type: "function", function: { name: "fixture_read", arguments: '{"path":"one"}' } },
    ] } });
    Object.assign(source, { usage_metadata: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } });
    const message = normalizeModelToolCallIdentity(source);
    const ids = message.tool_calls!.map((entry) => entry.id!);
    expect(message.id).toBe(source.id);
    expect(message.usage_metadata).toEqual(source.usage_metadata);
    expect(message.content[0]).toEqual(source.content[0]);
    expect((message.content as { id?: string }[]).slice(1).map((block) => block.id)).toEqual(ids);
    expect(message.additional_kwargs.tool_calls!.map((entry) => entry.id)).toEqual([...ids].reverse());
    expect(message.tool_calls!.map((entry) => entry.args)).toEqual([{ path: "one" }, { path: "two" }]);
    expect((source.content as { id?: string }[]).slice(1).map((block) => block.id)).toEqual(["same", "same"]);
  });

  test("aggregated stream survives actual checkpoint serialization with no raw IDs to rebuild", async () => {
    const chunk = new AIMessageChunk({ content: "", tool_call_chunks: [{ id: "shared", index: 0, name: "fixture_read", args: "{", type: "tool_call_chunk" }] })
      .concat(new AIMessageChunk({ content: "", tool_call_chunks: [{ index: 0, args: "}", type: "tool_call_chunk" }] }));
    const message = normalizeModelToolCallIdentity(chunk);
    const restored = await load<AIMessage>(JSON.stringify(message));
    expect(restored.tool_calls).toEqual(message.tool_calls);
    expect(normalizeModelToolCallIdentity(restored)).toBe(restored);
    expect(restored).not.toHaveProperty("tool_call_chunks");
    expect(result(restored).id).toBe(result(message).id);
  });

  test("normalizes invalid siblings before feedback pairing and preserves valid calls", () => {
    const message = normalizeModelToolCallIdentity(new AIMessage({ content: "", tool_calls: [call("shared")],
      invalid_tool_calls: [{ id: "shared", name: "fixture_read", args: "{broken", type: "invalid_tool_call" }] }));
    const validId = message.tool_calls![0]!.id!;
    const invalidId = message.invalid_tool_calls![0]!.id!;
    expect(validId).not.toBe(invalidId);
    const update = modelOutputPreflightNode({ messages: [message], approvedToolCalls: [] } as unknown as NautiloState);
    expect(update.modelRejectedToolCallIds).toEqual([invalidId]);
    expect((update.messages![0] as AIMessage).tool_calls!.map((entry) => entry.id)).toEqual([validId, invalidId]);
    expect((update.messages![1] as ToolMessage).tool_call_id).toBe(invalidId);
  });

  test("does not alias invalid empty completion arguments to a valid zero-argument sibling", () => {
    const message = normalizeModelToolCallIdentity(new AIMessage({
      content: "",
      tool_calls: [call("shared", {})],
      invalid_tool_calls: [{
        id: "shared",
        name: "fixture_read",
        args: "",
        type: "invalid_tool_call",
      }],
      additional_kwargs: {
        tool_calls: [
          {
            id: "shared",
            type: "function",
            function: { name: "fixture_read", arguments: "" },
          },
          {
            id: "shared",
            type: "function",
            function: { name: "fixture_read", arguments: "{}" },
          },
        ],
      },
    }));
    const validId = message.tool_calls?.[0]?.id;
    const invalidId = message.invalid_tool_calls?.[0]?.id;
    if (!validId || !invalidId) throw new Error("expected normalized valid and invalid calls");
    const rawCalls = message.additional_kwargs["tool_calls"] as Array<{ id: string }>;

    expect(validId).not.toBe(invalidId);
    expect(rawCalls.map((entry) => entry.id)).toEqual([invalidId, validId]);
  });

  test("provider-safe IDs cannot collide after character sanitization", () => {
    const first = admit("tool:0"); const second = admit("tool_0");
    expect(first.tool_calls![0]!.id).not.toBe(second.tool_calls![0]!.id);
  });

  test("loads legacy checkpoint history without changing its completed invocation identity", async () => {
    const legacy = new AIMessage({ content: "legacy", tool_calls: [call("legacy:0")] });
    const legacyResult = result(legacy);
    const restoredCall = await load<AIMessage>(JSON.stringify(legacy));
    const restoredResult = await load<ToolMessage>(JSON.stringify(legacyResult));
    const history = validateMessageHistory([restoredCall, restoredResult]).messages;
    expect(history).toHaveLength(2);
    expect((history[0] as AIMessage).tool_calls![0]!.id).toBe("legacy:0");
    expect((history[1] as ToolMessage).tool_call_id).toBe("legacy:0");
    expect(computeMessageFingerprint(restoredResult)).toBe(computeMessageFingerprint(legacyResult));
    const completed = new AIMessage("Done");
    expect(normalizeModelToolCallIdentity(completed)).toBe(completed);
  });

  test("rejects contradictory raw correlation and lossy signature maps before tools execute", () => {
    const contradictory = new AIMessage({ content: [{ type: "tool_use", id: "same", name: "fixture_read", input: { path: "other" } }],
      tool_calls: [call("same", { path: "one" })] });
    expect(() => normalizeModelToolCallIdentity(contradictory)).toThrow("Ambiguous model tool-call correlation");
    const lossy = new AIMessage({ content: "", tool_calls: [call("same"), call("same")],
      additional_kwargs: { __gemini_function_call_thought_signatures__: { same: "opaque-signature" } } });
    expect(() => normalizeModelToolCallIdentity(lossy)).toThrow("Ambiguous model tool-call correlation");
  });
});

describe("provider serialization after admission", () => {
  test("Completions sends each canonical call and result as one matching pair", () => {
    const first = admit(); const second = admit();
    const wire = convertMessagesToCompletionsMessageParams({ messages: [first, result(first), second, result(second)] });
    expect(wire).toMatchObject([
      { tool_calls: [{ id: first.tool_calls![0]!.id! }] }, { tool_call_id: first.tool_calls![0]!.id! },
      { tool_calls: [{ id: second.tool_calls![0]!.id! }] }, { tool_call_id: second.tool_calls![0]!.id! },
    ]);
  });

  test("Responses preserves provider item IDs while rekeying calls, including raw output priority", () => {
    const message = normalizeModelToolCallIdentity(new AIMessage({ content: "", tool_calls: [call("provider-call")],
      additional_kwargs: { __openai_function_call_ids__: { "provider-call": "fc_item" },
        __gemini_function_call_thought_signatures__: { "provider-call": "signature" } },
      response_metadata: { output: [{ type: "function_call", id: "fc_item", call_id: "provider-call", name: "fixture_read", arguments: "{}" }] } }));
    const id = message.tool_calls![0]!.id!;
    expect(message.additional_kwargs["__openai_function_call_ids__"]).toEqual({ [id]: "fc_item" });
    expect(message.additional_kwargs["__gemini_function_call_thought_signatures__"]).toEqual({ [id]: "signature" });
    const wire = convertMessagesToResponsesInput({ messages: [message, result(message)], zdrEnabled: false, model: "gpt-6-sol" });
    expect(wire).toMatchObject([
      { type: "function_call", id: "fc_item", call_id: id }, { type: "function_call_output", call_id: id },
    ]);
  });
});
