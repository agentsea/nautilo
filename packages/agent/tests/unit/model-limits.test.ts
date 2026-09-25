import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  discoverModelOutputTokenLimit,
  getDescriptiveModelContextTokens,
  getModelMaxOutputTokens,
  getModelTokenLimit,
  modelSupportsInput,
  resolveModelClass,
} from "../../src/providers/models";
import { resolveCompletionBudget } from "../../src/utils/chat-model-invocation";
import { HumanMessage } from "@langchain/core/messages";

const PROVIDER_KEY_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"] as const;
let originalProviderKeys: Partial<Record<(typeof PROVIDER_KEY_NAMES)[number], string>>;

beforeEach(() => {
  originalProviderKeys = {};
  for (const key of PROVIDER_KEY_NAMES) {
    const value = process.env[key];
    if (value !== undefined) originalProviderKeys[key] = value;
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PROVIDER_KEY_NAMES) {
    const value = originalProviderKeys[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("model token limits", () => {
  test("Claude Sonnet 4.6 has 1M context", () => {
    expect(getModelTokenLimit("anthropic:claude-sonnet-4-6")).toBe(1_000_000);
  });

  test("Claude Sonnet 4.6 output limit is 128000 (Anthropic GET /v1/models max_tokens)", async () => {
    const limit = await getModelMaxOutputTokens("anthropic:claude-sonnet-4-6");
    expect(limit).toBe(128_000);
  });

  test("OpenRouter Claude Sonnet 4.6 discovery records its 1M context and 128000 output limit", async () => {
    const modelId = "openrouter:anthropic/claude-sonnet-4.6";
    expect(getDescriptiveModelContextTokens(modelId)).toBe(1_000_000);
    expect(await discoverModelOutputTokenLimit(modelId)).toEqual({
      limit: 128_000,
      source: "static",
    });
  });

  test("OpenRouter frontier candidate discovery retains exact routed limits", async () => {
    const candidates = [
      ["openrouter:openai/gpt-5.5", 1_050_000, 128_000],
      ["openrouter:anthropic/claude-sonnet-4.6", 1_000_000, 128_000],
      ["openrouter:google/gemini-3.1-pro-preview", 1_048_576, 65_536],
    ] as const;

    for (const [modelId, contextTokens, outputTokens] of candidates) {
      expect(getDescriptiveModelContextTokens(modelId)).toBe(contextTokens);
      expect((await discoverModelOutputTokenLimit(modelId)).limit).toBe(outputTokens);
    }
  });

  test("Claude Opus 4.7 discovery records 1M context (Anthropic GET /v1/models max_input_tokens)", () => {
    expect(getDescriptiveModelContextTokens("anthropic:claude-opus-4-7")).toBe(1_000_000);
  });

  test("Claude Opus 4.7 discovery records 128000 output (Anthropic GET /v1/models max_tokens)", async () => {
    expect((await discoverModelOutputTokenLimit("anthropic:claude-opus-4-7")).limit).toBe(128_000);
  });

  test("Claude Fable 5 has 1M context (Anthropic GET /v1/models max_input_tokens)", () => {
    expect(getModelTokenLimit("anthropic:claude-fable-5")).toBe(1_000_000);
    expect(resolveModelClass("anthropic:claude-fable-5")).toBe("1M");
  });

  test("Claude Fable 5 output limit is 128000 (Anthropic GET /v1/models max_tokens)", async () => {
    const limit = await getModelMaxOutputTokens("anthropic:claude-fable-5");
    expect(limit).toBe(128_000);
  });

  test("Claude Sonnet 4 has 200K context by default", () => {
    expect(resolveModelClass("anthropic:claude-sonnet-4-5-20250929")).toBe("200K");
  });

  test("Claude Sonnet 4 gets 1M with long context beta", () => {
    expect(
      resolveModelClass("anthropic:claude-sonnet-4-5-20250929", { anthropicLongContextBeta: true }),
    ).toBe("1M");
  });

  test("GPT-4o has 128K context", () => {
    expect(getDescriptiveModelContextTokens("openai:gpt-4o")).toBe(131072);
  });

  test("GPT-4o output limit is 16384", async () => {
    expect((await discoverModelOutputTokenLimit("openai:gpt-4o")).limit).toBe(16_384);
  });

  test("GPT-5 output limit is 128000", async () => {
    expect((await discoverModelOutputTokenLimit("openai:gpt-5")).limit).toBe(128_000);
  });

  test("Gemini 2.5 Pro has 1M context", () => {
    expect(resolveModelClass("google:gemini-2.5-pro")).toBe("1M");
  });

  test("Gemini 2.5 output limit is 65536", async () => {
    const limit = await getModelMaxOutputTokens("google:gemini-2.5-pro");
    expect(limit).toBe(65_536);
  });

  test("Gemini 3.1 Pro Preview output limit is 65536 (Google static cap)", async () => {
    const limit = await getModelMaxOutputTokens("google:gemini-3.1-pro-preview");
    expect(limit).toBe(65_536);
  });

  test("Gemma 4 Fireworks + OpenRouter context + output (built-in caps)", async () => {
    expect(getDescriptiveModelContextTokens("fireworks:accounts/fireworks/models/gemma-4-31b-it")).toBe(262_144);
    expect((await discoverModelOutputTokenLimit("fireworks:accounts/fireworks/models/gemma-4-31b-it")).limit).toBe(262_144);
    expect(getDescriptiveModelContextTokens("openrouter:google/gemma-4-31b-it")).toBe(262_144);
    expect((await discoverModelOutputTokenLimit("openrouter:google/gemma-4-31b-it")).limit).toBe(65_536);
    expect(resolveModelClass("openrouter:google/gemma-4-26b-a4b-it")).toBe("256K");
  });

  test("unknown model discovery remains explicit and separate from execution", async () => {
    expect((await discoverModelOutputTokenLimit("unknown:mystery-model")).limit).toBe(8_192);
  });

  test("empty model discovery remains explicit and separate from execution", async () => {
    expect((await discoverModelOutputTokenLimit("")).limit).toBe(8_192);
  });

  test("Fireworks Llama gets 16384 output", async () => {
    expect((await discoverModelOutputTokenLimit("fireworks:llama-v3p1-70b-instruct")).limit)
      .toBe(16_384);
  });

  test("Fireworks DeepSeek-v3 gets 12288 output", async () => {
    expect((await discoverModelOutputTokenLimit("fireworks:deepseek-v3")).limit).toBe(12_288);
  });

  test("Fireworks MiniMax M3 / M2.7 and DeepSeek V4 Pro context + output (API-sourced)", async () => {
    for (const [id, contextTokens, outputTokens] of [
      ["fireworks:accounts/fireworks/models/minimax-m3", 512_000, 512_000],
      ["fireworks:accounts/fireworks/models/minimax-m2p7", 196_608, 196_608],
      ["fireworks:accounts/fireworks/models/deepseek-v4-pro", 1_048_576, 1_048_576],
      ["fireworks:accounts/fireworks/models/deepseek-v4-pro-0813", 1_040_000, 1_040_000],
    ] as const) {
      expect(getDescriptiveModelContextTokens(id)).toBe(contextTokens);
      expect((await discoverModelOutputTokenLimit(id)).limit).toBe(outputTokens);
    }
  });

  test("OpenRouter DeepSeek V4 Pro + MiniMax M2.7 limits (API-sourced)", async () => {
    expect(getDescriptiveModelContextTokens("openrouter:deepseek/deepseek-v4-pro")).toBe(1_048_576);
    expect((await discoverModelOutputTokenLimit("openrouter:deepseek/deepseek-v4-pro")).limit).toBe(384_000);
    expect(getDescriptiveModelContextTokens("openrouter:deepseek/deepseek-v4-pro-0813")).toBe(1_048_576);
    expect((await discoverModelOutputTokenLimit("openrouter:deepseek/deepseek-v4-pro-0813")).limit).toBe(384_000);
    expect(getDescriptiveModelContextTokens("openrouter:minimax/minimax-m2.7")).toBe(196_608);
    expect((await discoverModelOutputTokenLimit("openrouter:minimax/minimax-m2.7")).limit).toBe(196_607);
  });

  test("unknown OpenRouter models use a conservative context fallback", () => {
    expect(getDescriptiveModelContextTokens("openrouter:unknown/provider-model")).toBe(131_072);
  });

  test("GLM 5.2 / 5.1 Fireworks + OpenRouter limits (API-sourced)", async () => {
    expect(getDescriptiveModelContextTokens("fireworks:accounts/fireworks/models/glm-5p2")).toBe(1_040_000);
    expect((await discoverModelOutputTokenLimit("fireworks:accounts/fireworks/models/glm-5p2")).limit).toBe(1_040_000);
    expect(resolveModelClass("fireworks:accounts/fireworks/models/glm-5p2")).toBe("2M");
    expect(getDescriptiveModelContextTokens("fireworks:accounts/fireworks/models/glm-5p1")).toBe(202_752);
    expect((await discoverModelOutputTokenLimit("fireworks:accounts/fireworks/models/glm-5p1")).limit).toBe(202_752);
    expect(getDescriptiveModelContextTokens("openrouter:z-ai/glm-5.1")).toBe(202_752);
    expect((await discoverModelOutputTokenLimit("openrouter:z-ai/glm-5.1")).limit).toBe(65_535);
  });

  test("Kimi K2.6 Fireworks + OpenRouter context + output (API-sourced)", async () => {
    expect(getDescriptiveModelContextTokens("fireworks:accounts/fireworks/models/kimi-k2p6")).toBe(262_144);
    expect((await discoverModelOutputTokenLimit("fireworks:accounts/fireworks/models/kimi-k2p6")).limit).toBe(262_144);
    expect(getDescriptiveModelContextTokens("openrouter:moonshotai/kimi-k2.6")).toBe(262_142);
    expect((await discoverModelOutputTokenLimit("openrouter:moonshotai/kimi-k2.6")).limit).toBe(262_142);
    expect(resolveModelClass("openrouter:moonshotai/kimi-k2.6")).toBe("256K");
  });

  test("model input capabilities identify MiniMax modalities and vision-capable families", () => {
    expect(modelSupportsInput("fireworks:accounts/fireworks/models/minimax-m3", "text")).toBe(true);
    expect(modelSupportsInput("fireworks:accounts/fireworks/models/minimax-m3", "image")).toBe(true);
    expect(modelSupportsInput("fireworks:accounts/fireworks/models/minimax-m2p7", "text")).toBe(true);
    expect(modelSupportsInput("fireworks:accounts/fireworks/models/minimax-m2p7", "image")).toBe(false);
    expect(modelSupportsInput("openrouter:minimax/minimax-m2.7", "image")).toBe(false);
    expect(modelSupportsInput("fireworks:accounts/fireworks/models/glm-5p2", "text")).toBe(true);
    expect(modelSupportsInput("fireworks:accounts/fireworks/models/glm-5p2", "image")).toBe(false);
    expect(modelSupportsInput("fireworks:accounts/fireworks/models/gemma-4-31b-it", "image")).toBe(true);
    expect(modelSupportsInput("anthropic:claude-sonnet-4-6", "image")).toBe(true);
    expect(modelSupportsInput("google:gemini-2.5-pro", "image")).toBe(true);
    expect(modelSupportsInput("openrouter:anthropic/claude-sonnet-4.6", "image")).toBe(true);
  });

  test("DeepSeek V4.1 Flash completion budget uses remaining context instead of a global ceiling", async () => {
    const longInput = "x".repeat(102_381 * 4);
    const budget = await resolveCompletionBudget("fireworks:accounts/fireworks/models/deepseek-v4p1-flash", [
      new HumanMessage(longInput),
    ]);
    expect(budget).toBeLessThan(1_048_576);
    expect(budget).toBeGreaterThan(16_384);
  });

  test("OpenRouter slugs are not resolved through direct provider capability APIs", async () => {
    const originalFetch = globalThis.fetch;
    const originalAnthropicKey = process.env["ANTHROPIC_API_KEY"];
    let fetchCalls = 0;

    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-route-guard";
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ max_output_tokens: 123 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const { limit } = await discoverModelOutputTokenLimit("openrouter:anthropic/claude-3-haiku-route-guard");
      expect(limit).toBe(8_192);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalAnthropicKey === undefined) {
        delete process.env["ANTHROPIC_API_KEY"];
      } else {
        process.env["ANTHROPIC_API_KEY"] = originalAnthropicKey;
      }
    }
  });

  test("all major models have output limits > 2048", async () => {
    const models = [
      "anthropic:claude-sonnet-4-6",
      "anthropic:claude-opus-4-7",
      "openai:gpt-5",
      "openai:gpt-5-mini",
      "openai:gpt-4o",
      "google:gemini-2.5-pro",
      "google:gemini-3.1-pro-preview",
    ];

    for (const modelId of models) {
      const { limit } = await discoverModelOutputTokenLimit(modelId);
      expect(limit).toBeGreaterThan(2048);
    }
  });
});
