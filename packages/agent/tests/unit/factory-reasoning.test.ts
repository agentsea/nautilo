import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createAnthropic, createAnthropicWithLongContext, createFireworks, createOpenAI } from "../../src/providers/factory";
import { ModelCatalogSchema } from "@nautilo/types";
import { configureRuntimeModelCatalog, getActiveModelCatalogSync, hydrateRuntimeModelCatalog, resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { activateModelCatalogForTests } from "../helpers/activate-model-catalog";

beforeAll(async () => {
  await activateModelCatalogForTests([{
    id: "anthropic:test-non-reasoning",
    reasoning: false,
  }]);
  const baseline = getActiveModelCatalogSync().catalog;
  const catalog = ModelCatalogSchema.parse({ ...baseline, entries: baseline.entries.map((entry) =>
    entry.id === "openrouter:deepseek/deepseek-v4-pro-0813" ? { ...entry, controls: { reasoning: {
      levels: ["minimal", "low", "medium", "high", "xhigh", "max"], defaultLevel: "high", canDisable: true, mandatory: false,
      provenance: { kind: "provider-documentation", provider: "openrouter", verifiedAt: "2026-09-08T00:00:00Z" },
    } } } : entry.id === "venice:openai-gpt-6-sol" ? { ...entry, controls: { reasoning: {
      levels: ["low", "medium", "high", "xhigh", "max"], defaultLevel: "high", canDisable: true, mandatory: false,
      provenance: { kind: "provider-documentation", provider: "venice", verifiedAt: "2026-09-08T00:00:00Z" },
    } } } : entry) });
  configureRuntimeModelCatalog({ loader: {
    get: async () => ({ catalog, source: "remote-fresh", stale: false, fetchedAt: "2099-01-01T00:00:00Z",
      originUrl: "https://catalog.invalid/reasoning", reason: "", catalogVersion: catalog.catalogVersion }),
    refresh: async () => {}, clearCache: () => {},
  } });
  await hydrateRuntimeModelCatalog();
});

afterAll(() => resetRuntimeModelCatalog());

function anthropicFields(llm: unknown): Record<string, unknown> {
  return llm as Record<string, unknown>;
}

function modelKwargs(llm: unknown): Record<string, unknown> {
  return ((llm as Record<string, unknown>)["modelKwargs"] ?? {}) as Record<string, unknown>;
}

function openAIFields(llm: unknown): Record<string, unknown> {
  return llm as Record<string, unknown>;
}

describe("createAnthropic reasoning output (uniform adaptive)", () => {
  // Live-probed 2026-06-16: Opus 4.7 + 4.8 reject enabled+budget; all three
  // Anthropic reasoning models accept adaptive. So we use adaptive uniformly.
  for (const modelId of [
    "anthropic:claude-opus-4-8",
    "anthropic:claude-sonnet-4-6",
  ]) {
    it(`uses adaptive thinking + outputConfig.effort for ${modelId}`, async () => {
      const llm = await createAnthropic({
        modelId,
        apiKey: "test-key",
        maxTokens: 8192,
        reasoningOutput: true,
      });
      const fields = anthropicFields(llm);
      expect(fields["thinking"]).toEqual({ type: "adaptive" });
      expect(fields["outputConfig"]).toEqual({ effort: "medium" });
      expect(fields["temperature"]).toBe(1);
      expect(fields["betas"]).toEqual(["interleaved-thinking-2025-05-14"]);
    });
  }

  it("honors an explicit reasoning effort", async () => {
    const llm = await createAnthropic({
      modelId: "anthropic:claude-opus-4-8",
      apiKey: "test-key",
      maxTokens: 8192,
      reasoningOutput: true,
      reasoningEffort: "high",
    });
    const fields = anthropicFields(llm);
    expect(fields["outputConfig"]).toEqual({ effort: "high" });
  });

  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    it(`maps reviewed Anthropic ${effort} effort exactly`, async () => {
      const llm = await createAnthropic({
        modelId: "anthropic:claude-opus-4-8",
        apiKey: "test-key",
        maxTokens: 8192,
        reasoningOutput: true,
        reasoningEffort: effort,
      });
      expect(anthropicFields(llm)["outputConfig"]).toEqual({ effort });
    });
  }

  it("never uses the enabled+budget form (no token ceiling)", async () => {
    const llm = await createAnthropic({
      modelId: "anthropic:claude-opus-4-8",
      apiKey: "test-key",
      maxTokens: 8192,
      reasoningOutput: true,
    });
    const thinking = anthropicFields(llm)["thinking"] as { type?: string } | undefined;
    expect(thinking?.type).toBe("adaptive");
    expect(thinking?.type).not.toBe("enabled");
  });

  it("skips thinking when reasoningOutput is off", async () => {
    const llm = await createAnthropic({
      modelId: "anthropic:claude-opus-4-8",
      apiKey: "test-key",
      maxTokens: 8192,
      reasoningOutput: false,
    });
    const fields = anthropicFields(llm);
    const thinking = fields["thinking"] as { type?: string } | undefined;
    expect(thinking?.type).not.toBe("adaptive");
    expect(fields["outputConfig"]).toBeUndefined();
    expect(fields["betas"]).toBeUndefined();
  });

  it("skips optional thinking when maxTokens is too small", async () => {
    const llm = await createAnthropic({
      modelId: "anthropic:claude-opus-4-8",
      apiKey: "test-key",
      maxTokens: 5,
      reasoningOutput: true,
    });
    const thinking = anthropicFields(llm)["thinking"] as { type?: string } | undefined;
    expect(thinking?.type).not.toBe("adaptive");
  });

  it("skips thinking for non-reasoning models even when reasoningOutput is on", async () => {
    const llm = await createAnthropic({
      modelId: "anthropic:test-non-reasoning",
      apiKey: "test-key",
      maxTokens: 8192,
      reasoningOutput: true,
    });
    const thinking = anthropicFields(llm)["thinking"] as { type?: string } | undefined;
    expect(thinking?.type).not.toBe("adaptive");
  });

  it("keeps Opus 5.5 outputConfig effort and full output allowance with reasoning hidden", async () => {
    const llm = await createAnthropic({
      modelId: "anthropic:claude-opus-5-5",
      apiKey: "test-key",
      maxTokens: 128_000,
      reasoningOutput: false,
      reasoningEffort: "xhigh",
    });
    const fields = anthropicFields(llm);
    expect(fields["maxTokens"]).toBe(128_000);
    expect(fields["streaming"]).toBe(true);
    expect(fields["outputConfig"]).toEqual({ effort: "xhigh" });
    expect(fields["thinking"]).toEqual({ type: "adaptive" });
    expect(fields["temperature"]).toBeUndefined();
    expect(fields["betas"]).toBeUndefined();
  });

  it("keeps the long-context Opus 5.5 factory streaming at its full output allowance", async () => {
    const llm = await createAnthropicWithLongContext({
      modelId: "anthropic:claude-opus-5-5",
      apiKey: "test-key",
      maxTokens: 128_000,
      reasoningOutput: false,
      reasoningEffort: "max",
    });
    const fields = anthropicFields(llm);
    expect(fields["maxTokens"]).toBe(128_000);
    expect(fields["streaming"]).toBe(true);
    expect(fields["outputConfig"]).toEqual({ effort: "max" });
    expect(fields["thinking"]).toEqual({ type: "adaptive" });
    expect(fields["temperature"]).toBeUndefined();
    expect(fields["betas"]).toEqual(["context-1m-2025-08-07"]);
  });
});

describe("OpenAI-compatible reasoning output", () => {
  it("does not pass direct OpenAI reasoning_effort on Chat Completions", async () => {
    const llm = await createOpenAI({
      modelId: "openai:gpt-5.5-2026-04-23",
      apiKey: "test-key",
      maxTokens: 8192,
      reasoningOutput: true,
    });

    // Direct OpenAI Chat Completions rejects reasoning_effort when function
    // tools are bound for GPT-5.5. Responses API selection remains separate.
    expect(modelKwargs(llm)["reasoning_effort"]).toBeUndefined();
  });

  it("passes OpenRouter reasoning object so reasoning deltas are returned", async () => {
    const llm = await createOpenAI({
      modelId: "openrouter:deepseek/deepseek-v4-pro-0813",
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
      maxTokens: 8192,
      reasoningOutput: true,
      reasoningEffort: "high",
    });

    expect(modelKwargs(llm)["reasoning"]).toEqual({ effort: "high", exclude: false });
  });

  for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    it(`maps reviewed OpenRouter ${effort} effort exactly`, async () => {
      const llm = await createOpenAI({
        modelId: "openrouter:deepseek/deepseek-v4-pro-0813",
        apiKey: "test-key",
        baseUrl: "https://openrouter.ai/api/v1",
        maxTokens: 8192,
        reasoningOutput: true,
        reasoningEffort: effort,
      });
      expect(modelKwargs(llm)["reasoning"]).toEqual({ effort, exclude: false });
    });
  }

  it("maps normalized off only to OpenRouter's explicit disable shape", async () => {
    const llm = await createOpenAI({
      modelId: "openrouter:deepseek/deepseek-v4-pro-0813",
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
      maxTokens: 8192,
      reasoningOutput: true,
      reasoningEffort: "off",
    });
    expect(modelKwargs(llm)["reasoning"]).toEqual({ enabled: false });
  });

  it("passes Venice reasoning_effort alongside venice_parameters", async () => {
    const llm = await createOpenAI({
      modelId: "venice:openai-gpt-6-sol",
      apiKey: "test-key",
      baseUrl: "https://api.venice.ai/api/v1",
      maxTokens: 8192,
      reasoningOutput: true,
      reasoningEffort: "medium",
      modelKwargs: { venice_parameters: { include_venice_system_prompt: false } },
    });

    const kwargs = modelKwargs(llm);
    expect(kwargs["reasoning_effort"]).toBe("medium");
    expect(kwargs["venice_parameters"]).toEqual({ include_venice_system_prompt: false });
  });

  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    it(`maps reviewed Venice ${effort} effort exactly`, async () => {
      const llm = await createOpenAI({
        modelId: "venice:openai-gpt-6-sol",
        apiKey: "test-key",
        baseUrl: "https://api.venice.ai/api/v1",
        maxTokens: 8192,
        reasoningOutput: true,
        reasoningEffort: effort,
      });
      expect(modelKwargs(llm)["reasoning_effort"]).toBe(effort);
    });
  }

  it("passes Fireworks reasoning_effort for reasoning models", async () => {
    const llm = await createFireworks({
      modelId: "fireworks:accounts/fireworks/models/glm-5p3",
      apiKey: "test-key",
      maxTokens: 8192,
      reasoningOutput: true,
      reasoningEffort: "low",
    });

    expect(modelKwargs(llm)["reasoning_effort"]).toBe("low");
  });

  for (const effort of ["low", "medium", "high", "max"] as const) {
    it(`maps reviewed Fireworks ${effort} wire values only`, async () => {
      const llm = await createFireworks({
        modelId: "fireworks:accounts/fireworks/models/deepseek-v4p1-flash",
        apiKey: "test-key",
        maxTokens: 8192,
        reasoningOutput: true,
        reasoningEffort: effort,
      });
      expect(modelKwargs(llm)["reasoning_effort"]).toBe(effort);
    });
  }

  it("does not pass reasoning knobs when reasoningOutput is disabled", async () => {
    const llm = await createOpenAI({
      modelId: "openai:gpt-5.5-2026-04-23",
      apiKey: "test-key",
      maxTokens: 8192,
      reasoningOutput: false,
    });

    expect(modelKwargs(llm)["reasoning_effort"]).toBeUndefined();
    expect(modelKwargs(llm)["reasoning"]).toBeUndefined();
  });

  it("uses Responses API with reasoning.effort when explicitly opted in", async () => {
    const llm = await createOpenAI({
      modelId: "openai:gpt-5.5-2026-04-23",
      apiKey: "test-key",
      maxTokens: 8192,
      reasoningOutput: true,
      useOpenAIResponsesApi: true,
      reasoningEffort: "high",
    });

    const fields = openAIFields(llm);
    expect(fields["useResponsesApi"]).toBe(true);
    expect(fields["reasoning"]).toEqual({ effort: "high" });
    expect(modelKwargs(llm)["reasoning_effort"]).toBeUndefined();
    expect(modelKwargs(llm)["reasoning"]).toBeUndefined();
  });

  for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    it(`maps reviewed OpenAI Responses ${effort} effort exactly`, async () => {
      const llm = await createOpenAI({
        modelId: "openai:gpt-5.5-2026-04-23",
        apiKey: "test-key",
        maxTokens: 8192,
        reasoningOutput: true,
        useOpenAIResponsesApi: true,
        reasoningEffort: effort,
      });
      expect(openAIFields(llm)["reasoning"]).toEqual({ effort });
    });
  }

  it("maps OpenAI Responses off to its wire-level none value", async () => {
    const llm = await createOpenAI({
      modelId: "openai:gpt-5.5-2026-04-23",
      apiKey: "test-key",
      maxTokens: 8192,
      reasoningOutput: true,
      useOpenAIResponsesApi: true,
      reasoningEffort: "off",
    });
    const fields = openAIFields(llm);
    expect(fields["useResponsesApi"]).toBe(true);
    expect(fields["reasoning"]).toEqual({ effort: "none" });
  });

  for (const [provider, create] of [
    ["Anthropic", () => createAnthropic({
      modelId: "anthropic:claude-opus-4-8", apiKey: "test-key", maxTokens: 8192,
      reasoningOutput: true, reasoningEffort: "off",
    })],
    ["Venice", () => createOpenAI({
      modelId: "venice:openai-gpt-6-sol", apiKey: "test-key", baseUrl: "https://api.venice.ai/api/v1",
      maxTokens: 8192, reasoningOutput: true, reasoningEffort: "minimal",
    })],
    ["Fireworks", () => createFireworks({
      modelId: "fireworks:accounts/fireworks/models/glm-5p3", apiKey: "test-key", maxTokens: 8192,
      reasoningOutput: true, reasoningEffort: "minimal",
    })],
  ] as const) {
    it(`rejects an unsupported normalized effort before ${provider} invocation`, async () => {
      try {
        await create();
        throw new Error("Expected unsupported reasoning effort to reject");
      } catch (error) {
        expect(error).toHaveProperty("message", expect.stringContaining("not supported"));
      }
    });
  }

  it("stays on Chat Completions when useOpenAIResponsesApi is false", async () => {
    const llm = await createOpenAI({
      modelId: "openai:gpt-5.5-2026-04-23",
      apiKey: "test-key",
      maxTokens: 8192,
      reasoningOutput: true,
      useOpenAIResponsesApi: false,
    });

    const fields = openAIFields(llm);
    expect(fields["useResponsesApi"]).not.toBe(true);
    expect(fields["reasoning"]).toBeUndefined();
    expect(modelKwargs(llm)["reasoning_effort"]).toBeUndefined();
  });
});
