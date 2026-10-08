import { describe, expect, test } from "bun:test";
import { ChatAnthropic } from "@langchain/anthropic";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  convertMessagesToResponsesInput,
  convertResponsesDeltaToChatGenerationChunk,
  convertResponsesMessageToAIMessage,
} from "@langchain/openai";
import { normalizeModelToolCallIdentity } from "../../src/nodes/model-tool-call-identity";

function stopAfterCapture<T>(assign: (capture: (request: T) => Promise<never>) => void) {
  const marker = new Error("request captured");
  let request: T | undefined;
  assign(async (value) => {
    request = value;
    throw marker;
  });
  return {
    marker,
    request: () => {
      expect(request).toBeDefined();
      return request!;
    },
  };
}

function response(value: unknown): Parameters<typeof convertResponsesMessageToAIMessage>[0] {
  return value as Parameters<typeof convertResponsesMessageToAIMessage>[0];
}

function responseEvent(value: unknown): Parameters<typeof convertResponsesDeltaToChatGenerationChunk>[0] {
  return value as Parameters<typeof convertResponsesDeltaToChatGenerationChunk>[0];
}

function requiredToolCallId(message: AIMessage, index: number): string {
  const id = message.tool_calls?.[index]?.id;
  if (!id) throw new Error(`expected tool call ${index} to have an id`);
  return id;
}

describe("canonical tool-call provider pairing", () => {
  test("Anthropic sends one canonical tool_use/tool_result pair without changing signed thinking", async () => {
    const signature = "opaque-anthropic-thinking-signature";
    const redacted = "opaque-redacted-thinking-data";
    const message = normalizeModelToolCallIdentity(new AIMessage({
      content: [
        { type: "thinking", thinking: "private reasoning", signature },
        { type: "redacted_thinking", data: redacted },
        { type: "tool_use", id: "provider-call", name: "fixture_read", input: { path: "one" } },
      ],
      tool_calls: [{
        id: "provider-call",
        name: "fixture_read",
        args: { path: "one" },
        type: "tool_call",
      }],
    }));
    const canonicalId = message.tool_calls![0]!.id!;
    const result = new ToolMessage({
      content: "fixture result",
      name: "fixture_read",
      tool_call_id: canonicalId,
    });
    const model = new ChatAnthropic({
      apiKey: "test-only",
      model: "claude-sonnet-4-5",
      maxTokens: 256,
      streaming: false,
    });
    const capture = stopAfterCapture<Record<string, unknown>>((handler) => {
      (model as unknown as { completionWithRetry: typeof handler }).completionWithRetry = handler;
    });

    try {
      await model.invoke([new HumanMessage("Run it."), message, result]);
      throw new Error("expected the request capture to stop invocation");
    } catch (error) {
      expect(error).toBe(capture.marker);
    }

    const request = capture.request();
    const messages = request["messages"] as Array<{ role: string; content: unknown }>;
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning", signature },
        { type: "redacted_thinking", data: redacted },
        { type: "tool_use", id: canonicalId, name: "fixture_read", input: { path: "one" } },
      ],
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", content: "fixture result", tool_use_id: canonicalId }],
    });
  });

  test("Anthropic admits a completed streamed zero-argument call and serializes its exact pair", async () => {
    const streamModel = new ChatAnthropic({
      apiKey: "test-only",
      model: "claude-sonnet-4-5",
      maxTokens: 256,
      streaming: true,
    });
    async function* stream() {
      yield {
        type: "message_start",
        message: {
          id: "message-id",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      } as never;
      yield {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      } as never;
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "private reasoning" },
      } as never;
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "opaque-stream-signature" },
      } as never;
      yield { type: "content_block_stop", index: 0 } as never;
      yield {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "provider-call",
          name: "fixture_empty",
          input: {},
        },
      } as never;
      yield { type: "content_block_stop", index: 1 } as never;
      yield {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 1 },
      } as never;
      yield { type: "message_stop" } as never;
    }
    (streamModel as unknown as {
      createStreamWithRetry: () => Promise<AsyncIterable<never>>;
    }).createStreamWithRetry = async () => stream();

    const completed = await streamModel.invoke([new HumanMessage("Run it.")], {
      tools: [{
        name: "fixture_empty",
        description: "Zero-argument fixture",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      }],
    });
    if (!AIMessage.isInstance(completed)) throw new Error("expected a completed AI message");
    expect(completed.content).toEqual([
      {
        index: 0,
        type: "thinking",
        thinking: "private reasoning",
        signature: "opaque-stream-signature",
      },
      {
        index: 1,
        type: "tool_use",
        id: "provider-call",
        name: "fixture_empty",
        input: "",
      },
    ]);
    expect(completed.tool_calls).toEqual([{
      type: "tool_call",
      id: "provider-call",
      name: "fixture_empty",
      args: {},
    }]);

    const message = normalizeModelToolCallIdentity(completed);
    const canonicalId = requiredToolCallId(message, 0);
    expect(message.content).toEqual([
      {
        index: 0,
        type: "thinking",
        thinking: "private reasoning",
        signature: "opaque-stream-signature",
      },
      {
        index: 1,
        type: "tool_use",
        id: canonicalId,
        name: "fixture_empty",
        input: "",
      },
    ]);

    const result = new ToolMessage({
      content: "fixture result",
      name: "fixture_empty",
      tool_call_id: canonicalId,
    });
    const sendModel = new ChatAnthropic({
      apiKey: "test-only",
      model: "claude-sonnet-4-5",
      maxTokens: 256,
      streaming: false,
    });
    const capture = stopAfterCapture<Record<string, unknown>>((handler) => {
      (sendModel as unknown as { completionWithRetry: typeof handler }).completionWithRetry = handler;
    });

    try {
      await sendModel.invoke([new HumanMessage("Run it."), message, result]);
      throw new Error("expected the request capture to stop invocation");
    } catch (error) {
      expect(error).toBe(capture.marker);
    }

    const messages = capture.request()["messages"] as Array<{ role: string; content: unknown }>;
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "private reasoning",
          signature: "opaque-stream-signature",
        },
        { type: "tool_use", id: canonicalId, name: "fixture_empty", input: {} },
      ],
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", content: "fixture result", tool_use_id: canonicalId }],
    });
  });

  test("Gemini rekeys the exact function thought signature and pairs the result by name", async () => {
    const signature = "opaque-gemini-function-signature";
    const message = normalizeModelToolCallIdentity(new AIMessage({
      content: [{
        type: "functionCall",
        functionCall: { id: "provider-call", name: "fixture_read", args: { path: "one" } },
      }],
      tool_calls: [{
        id: "provider-call",
        name: "fixture_read",
        args: { path: "one" },
        type: "tool_call",
      }],
      additional_kwargs: {
        __gemini_function_call_thought_signatures__: { "provider-call": signature },
      },
    }));
    const canonicalId = message.tool_calls![0]!.id!;
    expect(message.additional_kwargs["__gemini_function_call_thought_signatures__"])
      .toEqual({ [canonicalId]: signature });
    expect((message.content[0] as unknown as { functionCall: { id: string } }).functionCall.id)
      .toBe(canonicalId);
    const result = new ToolMessage({
      content: "fixture result",
      name: "fixture_read",
      tool_call_id: canonicalId,
    });
    const model = new ChatGoogleGenerativeAI({
      apiKey: "test-only",
      model: "gemini-3-pro-preview",
      streaming: false,
    });
    const capture = stopAfterCapture<Record<string, unknown>>((handler) => {
      (model as unknown as { completionWithRetry: typeof handler }).completionWithRetry = handler;
    });

    try {
      await model.invoke([new HumanMessage("Run it."), message, result]);
      throw new Error("expected the request capture to stop invocation");
    } catch (error) {
      expect(error).toBe(capture.marker);
    }

    const contents = capture.request()["contents"] as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    expect(contents[1]).toEqual({
      role: "model",
      parts: [{
        functionCall: { name: "fixture_read", args: { path: "one" } },
        thoughtSignature: signature,
      }],
    });
    expect(contents[2]).toEqual({
      role: "user",
      parts: [{
        functionResponse: { name: "fixture_read", response: { result: "fixture result" } },
      }],
    });
  });

  test("OpenAI Responses rewrites native custom/computer call IDs while preserving item IDs", () => {
    const message = normalizeModelToolCallIdentity(convertResponsesMessageToAIMessage(response({
      id: "response-id",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-test",
      output: [
        {
          type: "reasoning",
          id: "reasoning-item-id",
          summary: [],
          encrypted_content: "opaque-encrypted-reasoning",
        },
        {
          type: "custom_tool_call",
          id: "custom-item-id",
          call_id: "shared-provider-call",
          name: "custom_fixture",
          input: "plain input",
        },
        {
          type: "computer_call",
          id: "computer-item-id",
          call_id: "shared-provider-call",
          action: { type: "screenshot" },
          pending_safety_checks: [],
          status: "completed",
        },
      ],
    })));
    const customId = requiredToolCallId(message, 0);
    const computerId = requiredToolCallId(message, 1);
    expect(customId).not.toBe(computerId);
    const customResult = new ToolMessage({
      content: "custom result",
      name: "custom_fixture",
      tool_call_id: customId,
      additional_kwargs: { customTool: true },
    });
    const computerResult = new ToolMessage({
      content: "data:image/png;base64,AA==",
      name: "computer_use",
      tool_call_id: computerId,
      additional_kwargs: { type: "computer_call_output" },
    });

    expect(convertMessagesToResponsesInput({
      messages: [message, customResult, computerResult],
      zdrEnabled: false,
      model: "gpt-test",
    }))
      .toMatchObject([
        {
          type: "reasoning",
          id: "reasoning-item-id",
          summary: [],
          encrypted_content: "opaque-encrypted-reasoning",
        },
        {
          type: "custom_tool_call",
          id: "custom-item-id",
          call_id: customId,
          name: "custom_fixture",
          input: "plain input",
        },
        {
          type: "computer_call",
          id: "computer-item-id",
          call_id: computerId,
          action: { type: "screenshot" },
          pending_safety_checks: [],
          status: "completed",
        },
        { type: "custom_tool_call_output", call_id: customId, output: "custom result" },
        {
          type: "computer_call_output",
          call_id: computerId,
          output: { type: "input_image", image_url: "data:image/png;base64,AA==" },
        },
      ]);
  });

  test("OpenAI Responses rebuilds duplicate call-id item bindings by raw output position", () => {
    const message = normalizeModelToolCallIdentity(convertResponsesMessageToAIMessage(response({
      id: "response-id",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-test",
      output: [
        {
          type: "function_call",
          id: "function-item-one",
          call_id: "shared-provider-call",
          name: "fixture_read",
          arguments: '{"path":"one"}',
        },
        {
          type: "function_call",
          id: "function-item-two",
          call_id: "shared-provider-call",
          name: "fixture_read",
          arguments: '{"path":"two"}',
        },
      ],
    })));
    const firstId = requiredToolCallId(message, 0);
    const secondId = requiredToolCallId(message, 1);
    expect(firstId).not.toBe(secondId);
    expect(message.additional_kwargs["__openai_function_call_ids__"]).toEqual({
      [firstId]: "function-item-one",
      [secondId]: "function-item-two",
    });

    const wire = convertMessagesToResponsesInput({
      messages: [message],
      zdrEnabled: false,
      model: "gpt-test",
    });
    expect(wire).toMatchObject([
      { type: "function_call", id: "function-item-one", call_id: firstId },
      { type: "function_call", id: "function-item-two", call_id: secondId },
    ]);

    const responseMetadataWithoutRawOutput = { ...message.response_metadata };
    delete responseMetadataWithoutRawOutput["output"];
    const projected = new AIMessage({
      content: message.content,
      ...(message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls }),
      ...(message.invalid_tool_calls === undefined
        ? {}
        : { invalid_tool_calls: message.invalid_tool_calls }),
      additional_kwargs: message.additional_kwargs,
      response_metadata: responseMetadataWithoutRawOutput,
    });
    const firstResult = new ToolMessage({
      content: "first result",
      name: "fixture_read",
      tool_call_id: firstId,
    });
    const secondResult = new ToolMessage({
      content: "second result",
      name: "fixture_read",
      tool_call_id: secondId,
    });
    expect(convertMessagesToResponsesInput({
      messages: [projected, firstResult, secondResult],
      zdrEnabled: false,
      model: "gpt-test",
    })).toMatchObject([
      { type: "function_call", id: "function-item-one", call_id: firstId },
      { type: "function_call", id: "function-item-two", call_id: secondId },
      { type: "function_call_output", call_id: firstId },
      { type: "function_call_output", call_id: secondId },
    ]);
    expect(convertMessagesToResponsesInput({
      messages: [projected, firstResult, secondResult],
      zdrEnabled: true,
      model: "gpt-test",
    })).toEqual([
      {
        type: "function_call",
        name: "fixture_read",
        arguments: '{"path":"one"}',
        call_id: firstId,
      },
      {
        type: "function_call",
        name: "fixture_read",
        arguments: '{"path":"two"}',
        call_id: secondId,
      },
      { type: "function_call_output", call_id: firstId, output: "first result" },
      { type: "function_call_output", call_id: secondId, output: "second result" },
    ]);
  });

  test("OpenAI Responses admits an aggregated stream only after its call is complete", () => {
    const added = convertResponsesDeltaToChatGenerationChunk(responseEvent({
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: {
        type: "function_call",
        id: "stream-item-id",
        call_id: "stream-provider-call",
        name: "fixture_read",
        arguments: "",
      },
    }));
    const argumentsDelta = convertResponsesDeltaToChatGenerationChunk(responseEvent({
      type: "response.function_call_arguments.delta",
      sequence_number: 2,
      output_index: 0,
      item_id: "stream-item-id",
      delta: '{"path":"one"}',
    }));
    const completed = convertResponsesDeltaToChatGenerationChunk(responseEvent({
      type: "response.completed",
      sequence_number: 3,
      response: {
        id: "response-id",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "gpt-test",
        output: [{
          type: "function_call",
          id: "stream-item-id",
          call_id: "stream-provider-call",
          name: "fixture_read",
          arguments: '{"path":"one"}',
        }],
      },
    }));
    expect(added).not.toBeNull();
    expect(argumentsDelta).not.toBeNull();
    expect(completed).not.toBeNull();
    if (!added || !argumentsDelta || !completed) throw new Error("expected response stream chunks");

    const aggregated = added.message.concat(argumentsDelta.message).concat(completed.message);
    if (!AIMessage.isInstance(aggregated)) throw new Error("expected an aggregated AI message");
    const message = normalizeModelToolCallIdentity(aggregated);
    const canonicalId = requiredToolCallId(message, 0);
    expect(message.tool_calls).toEqual([{
      type: "tool_call",
      id: canonicalId,
      name: "fixture_read",
      args: { path: "one" },
    }]);
    expect(message).not.toHaveProperty("tool_call_chunks");
    expect(message.additional_kwargs["__openai_function_call_ids__"])
      .toEqual({ [canonicalId]: "stream-item-id" });
    expect(convertMessagesToResponsesInput({
      messages: [message],
      zdrEnabled: false,
      model: "gpt-test",
    })).toMatchObject([{
      type: "function_call",
      id: "stream-item-id",
      call_id: canonicalId,
    }]);
  });
});
