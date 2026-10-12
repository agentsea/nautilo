import { describe, expect, test } from "bun:test";
import { ChatAnthropic } from "@langchain/anthropic";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  convertResponsesDeltaToChatGenerationChunk,
  convertResponsesMessageToAIMessage,
} from "@langchain/openai";
import { normalizeModelToolCallIdentity } from "../../src/nodes/model-tool-call-identity";
import { OpenAIUsageResponses } from "../../src/providers/openai-compat";

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

async function captureOpenAIResponsesRequest(
  messages: BaseMessage[],
  streaming = false,
): Promise<Record<string, unknown>> {
  const model = new OpenAIUsageResponses({
    apiKey: "test-only",
    model: "gpt-test",
    streaming,
  });
  const capture = stopAfterCapture<Record<string, unknown>>((handler) => {
    (model as unknown as { completionWithRetry: typeof handler }).completionWithRetry = handler;
  });
  try {
    await model.invoke(messages);
    throw new Error("expected the request capture to stop invocation");
  } catch (error) {
    expect(error).toBe(capture.marker);
  }
  return capture.request();
}

async function captureOpenAIResponsesProjectionError(messages: BaseMessage[]): Promise<Error> {
  const model = new OpenAIUsageResponses({
    apiKey: "test-only",
    model: "gpt-test",
    streaming: false,
  });
  const boundary = new Error("request boundary reached");
  (model as unknown as {
    completionWithRetry: () => Promise<never>;
  }).completionWithRetry = async () => {
    throw boundary;
  };
  try {
    await model.invoke(messages);
    throw new Error("expected projection to fail");
  } catch (error) {
    expect(error).not.toBe(boundary);
    if (!(error instanceof Error)) throw error;
    return error;
  }
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

  test("OpenAI Responses restores native computer provider bindings only on outgoing wire", async () => {
    const safetyChecks = [{
      id: "opaque-safety-check-id",
      code: "fixture_policy",
      message: "Opaque provider safety detail",
    }];
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
          type: "message",
          id: "assistant-item-id",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Using both tools.", annotations: [] }],
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
          pending_safety_checks: safetyChecks,
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

    const sourceOutput = message.response_metadata["output"] as Array<Record<string, unknown>>;
    const expectedWire = [
        {
          type: "reasoning",
          id: "reasoning-item-id",
          summary: [],
          encrypted_content: "opaque-encrypted-reasoning",
        },
        {
          type: "message",
          id: "assistant-item-id",
          role: "assistant",
          status: "completed",
        },
        {
          type: "custom_tool_call",
          call_id: customId,
          name: "custom_fixture",
          input: "plain input",
        },
        {
          type: "computer_call",
          id: "computer-item-id",
          call_id: "shared-provider-call",
          action: { type: "screenshot" },
          pending_safety_checks: safetyChecks,
          status: "completed",
        },
        { type: "custom_tool_call_output", call_id: customId, output: "custom result" },
        {
          type: "computer_call_output",
          call_id: "shared-provider-call",
          output: { type: "input_image", image_url: "data:image/png;base64,AA==" },
        },
      ];
    for (const streaming of [false, true]) {
      const request = await captureOpenAIResponsesRequest(
        [message, customResult, computerResult],
        streaming,
      );
      const wire = request["input"] as Array<Record<string, unknown>>;
      expect(wire).toMatchObject(expectedWire);
      expect(wire[1]).toHaveProperty("id", "assistant-item-id");
      expect(wire[2]).not.toHaveProperty("id");
      expect(wire[3]).toMatchObject({
        id: "computer-item-id",
        call_id: "shared-provider-call",
        status: "completed",
        pending_safety_checks: safetyChecks,
      });
    }
    expect(sourceOutput[0]).toMatchObject({
      id: "reasoning-item-id",
      encrypted_content: "opaque-encrypted-reasoning",
    });
    expect(sourceOutput[1]).toMatchObject({ id: "assistant-item-id" });
    expect(sourceOutput[2]).toMatchObject({ id: "custom-item-id", call_id: customId });
    expect(sourceOutput[3]).toMatchObject({ id: "computer-item-id", call_id: computerId });
    expect(message.tool_calls?.[1]).toMatchObject({
      id: computerId,
      call_id: "computer-item-id",
      status: "completed",
      pending_safety_checks: safetyChecks,
    });
    expect(computerResult.tool_call_id).toBe(computerId);

    const responseMetadataWithoutRawOutput = { ...message.response_metadata };
    delete responseMetadataWithoutRawOutput["output"];
    const reconstructed = new AIMessage({
      ...(message.id === undefined ? {} : { id: message.id }),
      content: message.content,
      ...(message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls }),
      additional_kwargs: message.additional_kwargs,
      response_metadata: responseMetadataWithoutRawOutput,
    });
    for (const streaming of [false, true]) {
      const reconstructedRequest = await captureOpenAIResponsesRequest([
        reconstructed,
        customResult,
        computerResult,
      ], streaming);
      const reconstructedWire = reconstructedRequest["input"] as Array<Record<string, unknown>>;
      const reconstructedCustom = reconstructedWire.find((item) => item["type"] === "custom_tool_call");
      const reconstructedComputer = reconstructedWire.find((item) => item["type"] === "computer_call");
      const reconstructedOutput = reconstructedWire.find((item) => item["type"] === "computer_call_output");
      expect(reconstructedCustom).toMatchObject({ call_id: customId, name: "custom_fixture" });
      expect(reconstructedComputer).toMatchObject({
        id: "computer-item-id",
        call_id: "shared-provider-call",
        action: { type: "screenshot" },
        pending_safety_checks: safetyChecks,
        status: "completed",
      });
      expect(reconstructedOutput).toMatchObject({ call_id: "shared-provider-call" });
      expect(reconstructedCustom).not.toHaveProperty("id");
    }
  });

  test("OpenAI Responses fails closed when native computer provider binding is missing or ambiguous", async () => {
    const missingProviderId = normalizeModelToolCallIdentity(convertResponsesMessageToAIMessage(response({
      id: "response-id",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-test",
      output: [{
        type: "computer_call",
        id: "computer-item-id",
        call_id: "provider-call",
        action: { type: "screenshot" },
        pending_safety_checks: [],
        status: "completed",
      }],
    })));
    const identity = missingProviderId.additional_kwargs["nautilo_tool_invocations"] as {
      version: number;
      responseId: string;
      calls: Array<{ id: string; providerId: string | null }>;
    };
    const malformed = new AIMessage({
      content: missingProviderId.content,
      ...(missingProviderId.tool_calls === undefined
        ? {}
        : { tool_calls: missingProviderId.tool_calls }),
      additional_kwargs: {
        ...missingProviderId.additional_kwargs,
        nautilo_tool_invocations: {
          ...identity,
          calls: identity.calls.map((call) => ({ ...call, providerId: null })),
        },
      },
      response_metadata: missingProviderId.response_metadata,
    });
    const missingError = await captureOpenAIResponsesProjectionError([malformed]);
    expect(missingError.message).toBe("Admitted OpenAI computer call is missing its provider call ID");

    const sourceCall = missingProviderId.tool_calls?.[0];
    if (!sourceCall) throw new Error("expected native computer call");
    const responseMetadataWithoutRawOutput = { ...missingProviderId.response_metadata };
    delete responseMetadataWithoutRawOutput["output"];
    const missingRequiredMetadata = [
      { ...sourceCall, call_id: undefined },
      { ...sourceCall, status: undefined },
      { ...sourceCall, pending_safety_checks: undefined },
    ];
    for (const toolCall of missingRequiredMetadata) {
      const incomplete = new AIMessage({
        content: missingProviderId.content,
        tool_calls: [toolCall],
        additional_kwargs: missingProviderId.additional_kwargs,
        response_metadata: responseMetadataWithoutRawOutput,
      });
      const metadataError = await captureOpenAIResponsesProjectionError([incomplete]);
      expect(metadataError.message)
        .toBe("Admitted OpenAI computer call is missing required provider metadata");
    }

    const distinct = normalizeModelToolCallIdentity(convertResponsesMessageToAIMessage(response({
      id: "response-id",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-test",
      output: [
        {
          type: "computer_call",
          id: "computer-item-one",
          call_id: "provider-call-one",
          action: { type: "screenshot" },
          pending_safety_checks: [],
          status: "completed",
        },
        {
          type: "computer_call",
          id: "computer-item-two",
          call_id: "provider-call-two",
          action: { type: "wait" },
          pending_safety_checks: [],
          status: "completed",
        },
      ],
    })));
    const distinctIdentity = distinct.additional_kwargs["nautilo_tool_invocations"] as {
      version: number;
      responseId: string;
      calls: Array<{ id: string; providerId: string | null }>;
    };
    const ambiguous = new AIMessage({
      content: distinct.content,
      ...(distinct.tool_calls === undefined ? {} : { tool_calls: distinct.tool_calls }),
      additional_kwargs: {
        ...distinct.additional_kwargs,
        nautilo_tool_invocations: {
          ...distinctIdentity,
          calls: distinctIdentity.calls.map((call) => ({
            ...call,
            providerId: "shared-provider-call",
          })),
        },
      },
      response_metadata: distinct.response_metadata,
    });
    const ambiguousError = await captureOpenAIResponsesProjectionError([ambiguous]);
    expect(ambiguousError.message).toBe("Ambiguous admitted OpenAI computer call provider ID");
  });

  test("OpenAI Responses removes returned function item IDs from raw and reconstructed wire calls", async () => {
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
    const rawRequest = await captureOpenAIResponsesRequest([message, firstResult, secondResult]);
    const rawWire = rawRequest["input"] as Array<Record<string, unknown>>;
    expect(rawWire).toMatchObject([
      { type: "function_call", call_id: firstId },
      { type: "function_call", call_id: secondId },
      { type: "function_call_output", call_id: firstId },
      { type: "function_call_output", call_id: secondId },
    ]);
    expect(rawWire[0]).not.toHaveProperty("id");
    expect(rawWire[1]).not.toHaveProperty("id");

    const reconstructedRequest = await captureOpenAIResponsesRequest(
      [projected, firstResult, secondResult],
      true,
    );
    expect(reconstructedRequest["input"]).toEqual([
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
    expect(message.response_metadata["output"]).toMatchObject([
      { id: "function-item-one", call_id: firstId },
      { id: "function-item-two", call_id: secondId },
    ]);
    expect(message.additional_kwargs["__openai_function_call_ids__"]).toEqual({
      [firstId]: "function-item-one",
      [secondId]: "function-item-two",
    });
  });

  test("OpenAI Responses leaves unadmitted legacy item bindings unchanged", async () => {
    const legacy = convertResponsesMessageToAIMessage(response({
      id: "legacy-response-id",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-test",
      output: [{
        type: "function_call",
        id: "legacy-function-item",
        call_id: "legacy-provider-call",
        name: "fixture_read",
        arguments: "{}",
      }],
    }));
    const result = new ToolMessage({
      content: "legacy result",
      name: "fixture_read",
      tool_call_id: "legacy-provider-call",
    });

    const request = await captureOpenAIResponsesRequest([legacy, result]);
    expect(request["input"]).toMatchObject([
      {
        type: "function_call",
        id: "legacy-function-item",
        call_id: "legacy-provider-call",
      },
      { type: "function_call_output", call_id: "legacy-provider-call" },
    ]);
    expect(legacy.additional_kwargs).not.toHaveProperty("nautilo_tool_invocations");
    expect(legacy.response_metadata["output"]).toMatchObject([{
      id: "legacy-function-item",
      call_id: "legacy-provider-call",
    }]);

    const legacyComputer = convertResponsesMessageToAIMessage(response({
      id: "legacy-computer-response-id",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-test",
      output: [{
        type: "computer_call",
        id: "legacy-computer-item",
        call_id: "legacy-computer-call",
        action: { type: "screenshot" },
        pending_safety_checks: [{
          id: "legacy-safety-check",
          code: "legacy_policy",
          message: "Legacy opaque safety detail",
        }],
        status: "completed",
      }],
    }));
    const legacyComputerResult = new ToolMessage({
      content: "data:image/png;base64,AA==",
      name: "computer_use",
      tool_call_id: "legacy-computer-call",
      additional_kwargs: { type: "computer_call_output" },
    });
    const legacyComputerRequest = await captureOpenAIResponsesRequest([
      legacyComputer,
      legacyComputerResult,
    ]);
    expect(legacyComputerRequest["input"]).toMatchObject([
      {
        type: "computer_call",
        id: "legacy-computer-item",
        call_id: "legacy-computer-call",
        status: "completed",
        pending_safety_checks: [{
          id: "legacy-safety-check",
          code: "legacy_policy",
          message: "Legacy opaque safety detail",
        }],
      },
      { type: "computer_call_output", call_id: "legacy-computer-call" },
    ]);
    expect(legacyComputer.additional_kwargs).not.toHaveProperty("nautilo_tool_invocations");
  });

  test("OpenAI Responses admits the pinned native stream shape and restores its exact wire pair", async () => {
    const rawCall = {
      type: "computer_call" as const,
      id: "stream-computer-item",
      call_id: "stream-provider-call",
      action: { type: "screenshot" as const },
      pending_safety_checks: [{
        id: "stream-safety-check",
        code: "opaque-policy",
        message: "Opaque provider detail",
      }],
      status: "completed" as const,
    };
    const done = convertResponsesDeltaToChatGenerationChunk(responseEvent({
      type: "response.output_item.done",
      sequence_number: 1,
      output_index: 0,
      item: rawCall,
    }));
    const completed = convertResponsesDeltaToChatGenerationChunk(responseEvent({
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "stream-response-id",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "gpt-test",
        output: [rawCall],
      },
    }));
    expect(done).not.toBeNull();
    expect(completed).not.toBeNull();
    if (!done || !completed) throw new Error("expected native response stream chunks");

    const aggregated = done.message.concat(completed.message);
    if (!AIMessage.isInstance(aggregated)) throw new Error("expected an aggregated AI message");
    expect((aggregated.tool_calls?.[0] as Record<string, unknown>)["isComputerTool"])
      .toBeUndefined();
    const message = normalizeModelToolCallIdentity(aggregated);
    const canonicalId = requiredToolCallId(message, 0);
    expect((message.response_metadata["output"] as Array<Record<string, unknown>>)[0])
      .toMatchObject({ id: "stream-computer-item", call_id: canonicalId });
    expect((aggregated.response_metadata["output"] as Array<Record<string, unknown>>)[0])
      .toEqual(rawCall);
    const result = new ToolMessage({
      content: "data:image/png;base64,AA==",
      name: "computer_use",
      tool_call_id: canonicalId,
      additional_kwargs: { type: "computer_call_output" },
    });

    for (const streaming of [false, true]) {
      const request = await captureOpenAIResponsesRequest([message, result], streaming);
      const wire = request["input"] as Array<Record<string, unknown>>;
      expect(wire.filter((item) => item["type"] === "computer_call")).toEqual([rawCall]);
      expect(wire.filter((item) => item["type"] === "computer_call_output"))
        .toMatchObject([{ call_id: "stream-provider-call" }]);
      expect(wire.filter((item) => item["type"] === "function_call")).toEqual([]);
    }
    expect(result.tool_call_id).toBe(canonicalId);
  });

  test("OpenAI Responses admits an aggregated stream only after its call is complete", async () => {
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
    const request = await captureOpenAIResponsesRequest([message]);
    const wire = request["input"] as Array<Record<string, unknown>>;
    expect(wire).toMatchObject([{
      type: "function_call",
      call_id: canonicalId,
    }]);
    expect(wire[0]).not.toHaveProperty("id");
    expect((message.response_metadata["output"] as Array<Record<string, unknown>>)[0])
      .toMatchObject({ id: "stream-item-id", call_id: canonicalId });
  });
});
