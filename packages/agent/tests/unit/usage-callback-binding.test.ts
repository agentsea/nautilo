import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import {
  __setUsageRecorderForTests,
  countNautiloUsageCallbacks,
  createUsageCallbackHandler,
} from "../../src/usage/usage-callback";
import { createUniversalModel } from "../../src/providers/universal";
import type { RecordUsageInput } from "../../src/usage/record-usage";
import { runWithUsageContext } from "../../src/usage/usage-context";
import { resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { activateModelCatalogForTests } from "../helpers/activate-model-catalog";

beforeAll(async () => {
  await activateModelCatalogForTests([
    "gateway:test-model",
    "together:test-model",
  ]);
});

afterAll(() => resetRuntimeModelCatalog());

function invokeHandlerEnd(
  handler: ReturnType<typeof createUsageCallbackHandler>,
  output: LLMResult,
  runId = "test-run",
): void {
  if (!handler.handleLLMEnd) throw new Error("UsageCallbackHandler missing handleLLMEnd");
  handler.handleLLMEnd(output, runId);
}

const CONSTRUCT_OPTS = {
  apiKey: "test-dummy-key",
  maxTokens: 1024,
};

function syntheticUsageResult(): LLMResult {
  return {
    generations: [
      [
        {
          text: "ok",
          message: {
            usage_metadata: {
              input_tokens: 11,
              output_tokens: 7,
              total_tokens: 18,
              input_token_details: { cache_read: 3, cache_creation: 2 },
              output_token_details: { reasoning: 4 },
            },
          },
        },
      ],
    ],
  } as unknown as LLMResult;
}

async function assertOneUsageCallbackBeforeAndAfterBindTools(
  modelId: string,
  extraOptions: Record<string, unknown> = {},
): Promise<void> {
  const model = await createUniversalModel(modelId, { ...CONSTRUCT_OPTS, ...extraOptions });
  expect(countNautiloUsageCallbacks(model)).toBe(1);
  if (!model.bindTools) {
    throw new Error(`Expected bindTools support for ${modelId}`);
  }
  const bound = model.bindTools([]);
  expect(countNautiloUsageCallbacks(bound)).toBe(1);
}

describe("usage callback constructor binding", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      "OPENROUTER_API_KEY",
      "NAUTILO_GATEWAY_API_KEY",
      "NAUTILO_GATEWAY_BASE_URL",
      "VENICE_API_KEY",
      "FIREWORKS_API_KEY",
      "TOGETHER_API_KEY",
    ]) {
      savedEnv[key] = process.env[key];
    }
    process.env["OPENROUTER_API_KEY"] = "test-openrouter-key";
    process.env["NAUTILO_GATEWAY_API_KEY"] = "test-gateway-key";
    process.env["NAUTILO_GATEWAY_BASE_URL"] = "https://gateway.example/v1";
    process.env["VENICE_API_KEY"] = "test-venice-key";
    process.env["FIREWORKS_API_KEY"] = "test-fireworks-key";
    process.env["TOGETHER_API_KEY"] = "test-together-key";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("openai:gpt-5.6-luna keeps one nautilo_usage callback through bindTools", async () => {
    await assertOneUsageCallbackBeforeAndAfterBindTools("openai:gpt-5.6-luna");
  });

  it("openai:gpt-5.6-sol keeps one nautilo_usage callback through bindTools", async () => {
    await assertOneUsageCallbackBeforeAndAfterBindTools("openai:gpt-5.6-sol");
  });

  it("openai:gpt-5.6-terra keeps one nautilo_usage callback through bindTools", async () => {
    await assertOneUsageCallbackBeforeAndAfterBindTools("openai:gpt-5.6-terra");
  });

  for (const modelId of ["openai:gpt-5.6-sol", "openai:gpt-5.6-terra"]) {
    it(`${modelId} Responses API keeps one nautilo_usage callback through bindTools`, async () => {
      await assertOneUsageCallbackBeforeAndAfterBindTools(modelId, {
        useOpenAIResponsesApi: true,
        reasoningOutput: true,
        maxTokens: 8192,
      });
    });
  }

  it("anthropic model keeps one nautilo_usage callback through bindTools", async () => {
    await assertOneUsageCallbackBeforeAndAfterBindTools("anthropic:claude-sonnet-4-6");
  });

  it("fireworks model keeps one nautilo_usage callback through bindTools", async () => {
    await assertOneUsageCallbackBeforeAndAfterBindTools(
      "fireworks:accounts/fireworks/models/glm-5p3",
    );
  });

  it("openrouter model keeps one nautilo_usage callback through bindTools", async () => {
    await assertOneUsageCallbackBeforeAndAfterBindTools("openrouter:anthropic/claude-sonnet-4.6");
  });

  it("gateway model keeps one nautilo_usage callback through bindTools", async () => {
    await assertOneUsageCallbackBeforeAndAfterBindTools("gateway:test-model");
  });

  it("google gemini wrapper keeps one nautilo_usage callback through bindTools", async () => {
    const model = await createUniversalModel("google:gemini-2.5-pro", CONSTRUCT_OPTS);
    expect((model as { callbacks?: unknown }).callbacks).toBeUndefined();
    expect(countNautiloUsageCallbacks(model)).toBe(1);
    if (!model.bindTools) throw new Error("Expected Gemini bindTools support");
    const bound = model.bindTools([]);
    // The plain sanitizer shell intentionally owns no callbacks. This count
    // therefore succeeds only when the concrete bound delegate retained them.
    expect((bound as { callbacks?: unknown }).callbacks).toBeUndefined();
    expect(countNautiloUsageCallbacks(bound)).toBe(1);
  });

  it("venice model keeps one nautilo_usage callback through bindTools", async () => {
    await assertOneUsageCallbackBeforeAndAfterBindTools("venice:zai-org-glm-5-2");
  });

  it("together model keeps one nautilo_usage callback through bindTools", async () => {
    await assertOneUsageCallbackBeforeAndAfterBindTools("together:test-model");
  });

  it("normalizes Anthropic cache counters and preserves ambient turn attribution", () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    try {
      const calls: RecordUsageInput[] = [];
      __setUsageRecorderForTests((input) => {
        calls.push(input);
      });
      const metadata = { turnId: "turn-usage-cache-baseline", experiment: "baseline" };
      runWithUsageContext(
        {
          callType: "chat",
          userId: "user-usage-binding",
          roomId: "room-usage-binding",
          metadata,
        },
        () => invokeHandlerEnd(createUsageCallbackHandler("anthropic:claude-sonnet-4-6"), syntheticUsageResult(), "provider-run-usage-binding"),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        model: "anthropic:claude-sonnet-4-6",
        callType: "chat",
        userId: "user-usage-binding",
        roomId: "room-usage-binding",
        inputTokens: 11,
        outputTokens: 7,
        cachedInputTokens: 3,
        cacheCreationTokens: 2,
        reasoningTokens: 4,
        totalTokens: 18,
        metadata,
      });
      // `handleLLMEnd` attributes via UsageContext; its LangChain run ID is
      // not promoted to record metadata by the current callback contract.
      expect(calls[0]?.metadata).not.toHaveProperty("runId");
    } finally {
      __setUsageRecorderForTests(null);
      delete process.env["NAUTILO_TEST_MODE"];
    }
  });

  it("preserves routed provider identity for every Wave 4 family candidate", () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    const calls: RecordUsageInput[] = [];
    __setUsageRecorderForTests((input) => calls.push(input));
    try {
      const ids = [
        "openrouter:openai/gpt-5.5",
        "openrouter:anthropic/claude-sonnet-4.6",
        "openrouter:google/gemini-3.1-pro-preview",
        "venice:openai-gpt-55-pro",
        "venice:claude-sonnet-4-6",
        "venice:gemini-3-1-pro-preview",
      ];
      for (const id of ids) invokeHandlerEnd(createUsageCallbackHandler(id), syntheticUsageResult(), id);
      expect(calls.map((call) => call.model)).toEqual(ids);
    } finally {
      __setUsageRecorderForTests(null);
      delete process.env["NAUTILO_TEST_MODE"];
    }
  });

  it("model-owned callback records once when invoke callbacks are empty", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    try {
      const calls: RecordUsageInput[] = [];
      __setUsageRecorderForTests((input) => {
        calls.push(input);
      });
      const model = await createUniversalModel("openai:gpt-5.6-sol", CONSTRUCT_OPTS);
      if (!model.bindTools) throw new Error("Expected OpenAI bindTools support");
      const bound = model.bindTools([]);
      (bound as unknown as { _generate: () => Promise<unknown> })._generate = async () => {
        const message = new AIMessage("ok");
        (message as unknown as { usage_metadata: Record<string, number> }).usage_metadata = {
          input_tokens: 13,
          output_tokens: 5,
          total_tokens: 18,
        };
        return {
          generations: [{ text: "ok", message }],
          llmOutput: {},
        };
      };

      await runWithUsageContext(
        {
          callType: "chat",
          userId: "user-r4",
          roomId: "room-r4",
          metadata: { turnId: "turn-r4" },
        },
        () => bound.invoke([new HumanMessage("hello")], { callbacks: [] }),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        model: "openai:gpt-5.6-sol",
        callType: "chat",
        userId: "user-r4",
        roomId: "room-r4",
        inputTokens: 13,
        outputTokens: 5,
        totalTokens: 18,
        metadata: { turnId: "turn-r4" },
      });
    } finally {
      __setUsageRecorderForTests(null);
      delete process.env["NAUTILO_TEST_MODE"];
    }
  });
});
