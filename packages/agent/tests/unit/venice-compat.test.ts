import { describe, expect, test } from "bun:test";
import { AIMessage, AIMessageChunk, HumanMessage, SystemMessageChunk } from "@langchain/core/messages";
import { Validator, type Schema } from "@cfworker/json-schema";
import { createManageConnectedWebOperationTool } from "../../src/tools/connected-web-accounts/manage-connected-web-operation";
import { createOpenAI } from "../../src/providers/factory";
import type { ChatModel } from "../../src/providers/types";
import {
  convertToolToVeniceTool,
  VeniceChatOpenAICompletions,
  wrapVeniceModelForToolSchemas,
} from "../../src/providers/venice-compat";

function openAIFunctionSchema(tool: unknown): Schema {
  const descriptor = tool as {
    type: string;
    function: { parameters: Schema };
  };
  expect(descriptor.type).toBe("function");
  return descriptor.function.parameters;
}

describe("Venice tool-schema compatibility", () => {
  test("the Venice factory installs both schema and streamed-role compatibility", async () => {
    const model = await createOpenAI({
      modelId: "venice:openai-gpt-56-terra",
      apiKey: "test-key",
    });
    expect((model as unknown as { completions?: unknown }).completions)
      .toBeInstanceOf(VeniceChatOpenAICompletions);

    const bound = model.bindTools!([createManageConnectedWebOperationTool()]);
    const tools = (bound as unknown as {
      defaultOptions?: { tools?: unknown[] };
    }).defaultOptions?.tools;
    expect(tools).toHaveLength(1);
    expect(openAIFunctionSchema(tools?.[0]).type).toBe("object");
  });

  test("projects the real connected-web supervision union to an object-root OpenAI tool", () => {
    const tool = createManageConnectedWebOperationTool();
    const converted = convertToolToVeniceTool(tool);
    const schema = openAIFunctionSchema(converted);

    expect(schema.type).toBe("object");
    expect(schema).not.toHaveProperty("anyOf");
    expect(schema).not.toHaveProperty("oneOf");
    expect(schema).not.toHaveProperty("allOf");
    expect(schema.required).toEqual(["operation", "operationId", "expectedControlEpoch"]);
    expect(Object.keys(schema.properties ?? {})).toEqual([
      "operation",
      "operationId",
      "expectedControlEpoch",
      "activityBefore",
      "dueAt",
      "instruction",
    ]);

    const validInspect = {
      operation: "inspect",
      operationId: "01695590-17e0-4ce1-8e26-3f6f5cdd4037",
      expectedControlEpoch: 1,
      activityBefore: 12,
    };
    expect(tool.schema.safeParse(validInspect).success).toBe(true);
    expect(new Validator(schema).validate(validInspect).valid).toBe(true);

    // The provider projection admits the union of branch properties, while
    // the original tool remains the execution-time authority for combinations.
    expect(tool.schema.safeParse({ ...validInspect, dueAt: "2026-09-10T12:00:00Z" }).success).toBe(false);
  });

  test("keeps OpenAI descriptors and recursively normalizes bound tools", () => {
    const captured: unknown[][] = [];
    const makeModel = (): ChatModel => ({
      invoke: async () => ({}),
      bindTools: (tools) => {
        captured.push(tools);
        return makeModel();
      },
    });
    const schema = {
      anyOf: [
        { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
      ],
    };
    const rebound = wrapVeniceModelForToolSchemas(makeModel()).bindTools!([
      { type: "function", function: { name: "lookup", parameters: schema } },
    ]);
    rebound.bindTools!([{ type: "function", function: { name: "again", parameters: schema } }]);

    for (const bound of captured) {
      const projected = openAIFunctionSchema(bound[0]);
      expect(projected.type).toBe("object");
      expect(projected).not.toHaveProperty("anyOf");
      expect(Object.keys(projected.properties ?? {})).toEqual(["query", "ref"]);
    }
    expect(schema).not.toHaveProperty("type");
  });
});

describe("Venice streamed-role compatibility", () => {
  function rolelessTerraCompletions() {
    const completions = new VeniceChatOpenAICompletions({
      model: "openai-gpt-56-terra",
      apiKey: "test-key",
      streaming: true,
      streamUsage: true,
    });
    const chunks = [
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "openai-gpt-56-terra",
        choices: [{ index: 0, delta: { content: "Hello " }, finish_reason: null }],
      },
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "openai-gpt-56-terra",
        choices: [{ index: 0, delta: { content: "from Terra" }, finish_reason: "stop" }],
      },
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "openai-gpt-56-terra",
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      },
    ];
    (completions as unknown as {
      completionWithRetry: () => Promise<AsyncIterable<unknown>>;
    }).completionWithRetry = async () => (async function* stream() {
      for (const chunk of chunks) yield chunk;
    })();
    return completions;
  }

  function convert(delta: Record<string, unknown>) {
    const completions = new VeniceChatOpenAICompletions({
      model: "openai-gpt-56-terra",
      apiKey: "test-key",
    });
    const exposed = completions as unknown as {
      _convertCompletionsDeltaToBaseMessageChunk(
        delta: Record<string, unknown>,
        rawResponse: Record<string, unknown>,
      ): unknown;
    };
    return exposed._convertCompletionsDeltaToBaseMessageChunk(delta, {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "openai-gpt-56-terra",
      choices: [{ index: 0, delta }],
    });
  }

  test("recognizes roleless text as assistant output without changing its content", () => {
    const chunk = convert({ content: "Hello from Terra" });
    expect(AIMessageChunk.isInstance(chunk)).toBe(true);
    expect((chunk as AIMessageChunk).content).toBe("Hello from Terra");
  });

  test("recognizes an empty roleless delta as assistant so terminal validation can reject it", () => {
    const chunk = convert({});
    expect(AIMessageChunk.isInstance(chunk)).toBe(true);
    expect((chunk as AIMessageChunk).content).toBe("");
  });

  test("preserves an explicit non-assistant role", () => {
    const chunk = convert({ role: "system", content: "provider notice" });
    expect(SystemMessageChunk.isInstance(chunk)).toBe(true);
    expect((chunk as SystemMessageChunk).content).toBe("provider notice");
  });

  test("streams and aggregates roleless Terra text as a recognized assistant message", async () => {
    const streamed = [];
    for await (const chunk of await rolelessTerraCompletions().stream([
      new HumanMessage("Hello"),
    ])) {
      streamed.push(chunk);
    }
    expect(streamed.every((chunk) => AIMessageChunk.isInstance(chunk))).toBe(true);
    expect(streamed.map((chunk) => typeof chunk.content === "string" ? chunk.content : "").join(""))
      .toBe("Hello from Terra");

    const result = await rolelessTerraCompletions().invoke([
      new HumanMessage("Hello"),
    ]);
    expect(AIMessage.isInstance(result)).toBe(true);
    expect(result.content).toBe("Hello from Terra");
    expect(result.usage_metadata).toMatchObject({
      input_tokens: 4,
      output_tokens: 3,
      total_tokens: 7,
    });
  });
});
