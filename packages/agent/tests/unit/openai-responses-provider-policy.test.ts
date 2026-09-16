/**
 * D334 Phase 2 — OpenAI-only Responses provider gate and provider isolation.
 * Hermetic: no live OpenAI, no secrets.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  createAnthropic,
  createFireworks,
  createOpenAI,
  shouldUseOpenAIResponsesApi,
} from "../../src/providers/factory";
import { createUniversalModel } from "../../src/providers/universal";
import { resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { activateModelCatalogForTests } from "../helpers/activate-model-catalog";

beforeAll(async () => {
  await activateModelCatalogForTests([{
    id: "openai:test-non-reasoning",
    reasoning: false,
  }]);
});

afterAll(() => resetRuntimeModelCatalog());

function modelKwargs(llm: unknown): Record<string, unknown> {
  return ((llm as Record<string, unknown>)["modelKwargs"] ?? {}) as Record<string, unknown>;
}

function openAIFields(llm: unknown): Record<string, unknown> {
  return llm as Record<string, unknown>;
}

function anthropicFields(llm: unknown): Record<string, unknown> {
  return llm as Record<string, unknown>;
}

describe("shouldUseOpenAIResponsesApi (D334 transport policy)", () => {
  const baseOpts = {
    modelId: "openai:gpt-5.5-2026-04-23",
    maxTokens: 8192,
    reasoningOutput: true,
    useOpenAIResponsesApi: true,
  };

  it("returns true for direct openai reasoning models when explicitly enabled", () => {
    expect(shouldUseOpenAIResponsesApi(baseOpts, 8192)).toBe(true);
  });

  it("returns false when the explicit flag is off", () => {
    expect(
      shouldUseOpenAIResponsesApi({ ...baseOpts, useOpenAIResponsesApi: false }, 8192),
    ).toBe(false);
  });

  it("uses Responses for a direct GPT-5.6 explicit cache breakpoint even with reasoning output off", () => {
    expect(shouldUseOpenAIResponsesApi({
      ...baseOpts,
      modelId: "openai:gpt-5.6-luna",
      reasoningOutput: false,
      useOpenAIResponsesApi: false,
      openAIExplicitPromptCache: true,
    }, 8192)).toBe(true);
  });

  it("does not let the explicit cache flag widen to another model or provider", () => {
    expect(shouldUseOpenAIResponsesApi({
      ...baseOpts,
      modelId: "openai:gpt-5.5-2026-04-23",
      reasoningOutput: false,
      useOpenAIResponsesApi: false,
      openAIExplicitPromptCache: true,
    }, 8192)).toBe(false);
    expect(shouldUseOpenAIResponsesApi({
      ...baseOpts,
      modelId: "openrouter:openai/gpt-5.6-luna",
      reasoningOutput: false,
      useOpenAIResponsesApi: false,
      openAIExplicitPromptCache: true,
    }, 8192)).toBe(false);
    expect(shouldUseOpenAIResponsesApi({
      ...baseOpts,
      modelId: "openai:gpt-5.5-2026-04-23",
      useOpenAIResponsesApi: true,
      openAIExplicitPromptCache: true,
    }, 8192)).toBe(true);
  });

  it("returns false for non-reasoning openai models", () => {
    expect(
      shouldUseOpenAIResponsesApi(
        { ...baseOpts, modelId: "openai:test-non-reasoning" },
        8192,
      ),
    ).toBe(false);
  });

  it("returns false when reasoningOutput is off", () => {
    expect(
      shouldUseOpenAIResponsesApi({ ...baseOpts, reasoningOutput: false }, 8192),
    ).toBe(false);
  });

  it("returns false when maxTokens headroom is too small", () => {
    expect(shouldUseOpenAIResponsesApi(baseOpts, 5)).toBe(false);
  });

  it("returns false for OpenRouter ids even when routed through createOpenAI", () => {
    expect(
      shouldUseOpenAIResponsesApi(
        {
          ...baseOpts,
          modelId: "openrouter:openai/gpt-5.5",
          baseUrl: "https://openrouter.ai/api/v1",
        },
        8192,
      ),
    ).toBe(false);
  });

  it("returns false for Venice ids", () => {
    expect(
      shouldUseOpenAIResponsesApi(
        {
          ...baseOpts,
          modelId: "venice:zai-org-glm-5-2",
          baseUrl: "https://api.venice.ai/api/v1",
        },
        8192,
      ),
    ).toBe(false);
  });

  it("returns false for gateway ids", () => {
    expect(
      shouldUseOpenAIResponsesApi(
        { ...baseOpts, modelId: "gateway:custom-gpt" },
        8192,
      ),
    ).toBe(false);
  });
});

describe("createUniversalModel — OpenAI Responses flag isolation (D334)", () => {
  it("uses max_completion_tokens for direct GPT-6 Chat Completions utility calls", async () => {
    const llm = await createUniversalModel("openai:gpt-6-astra", {
      apiKey: "test-key",
      maxTokens: 8192,
      reasoningOutput: false,
    });

    const fields = openAIFields(llm);
    expect(fields["useResponsesApi"]).toBe(false);
    const params = (llm as unknown as {
      invocationParams(options: object): Record<string, unknown>;
    }).invocationParams({});
    expect(params["max_completion_tokens"]).toBe(8192);
    expect(params).not.toHaveProperty("max_tokens");
  });

  it("threads useOpenAIResponsesApi only for direct openai:* models", async () => {
    const llm = await createUniversalModel("openai:gpt-5.5-2026-04-23", {
      apiKey: "test-key",
      maxTokens: 8192,
      reasoningOutput: true,
      useOpenAIResponsesApi: true,
    });

    const fields = openAIFields(llm);
    expect(fields["useResponsesApi"]).toBe(true);
    expect(fields["reasoning"]).toEqual({ effort: "medium" });
    expect(modelKwargs(llm)["reasoning_effort"]).toBeUndefined();
  });

  it("adds explicit cache mode only to a direct GPT-5.6 Responses request", async () => {
    const llm = await createUniversalModel("openai:gpt-5.6-luna", {
      apiKey: "test-key",
      maxTokens: 8192,
      reasoningOutput: false,
      openAIExplicitPromptCache: true,
    });

    const fields = openAIFields(llm);
    expect(fields["useResponsesApi"]).toBe(true);
    expect(fields["reasoning"]).toBeUndefined();
    expect(modelKwargs(llm)).toEqual({
      prompt_cache_options: { mode: "explicit" },
    });
  });

  it("does not enable Responses for OpenRouter when the flag is set", async () => {
    const llm = await createOpenAI({
      modelId: "openrouter:deepseek/deepseek-v4-pro-0813",
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
      maxTokens: 8192,
      reasoningOutput: true,
      reasoningEffort: "high",
      useOpenAIResponsesApi: true,
    });

    const fields = openAIFields(llm);
    expect(fields["useResponsesApi"]).not.toBe(true);
    expect(fields["reasoning"]).toBeUndefined();
    expect(modelKwargs(llm)["reasoning"]).toEqual({ effort: "high", exclude: false });
  });

  it("does not enable Responses for Venice when the flag is set", async () => {
    const llm = await createUniversalModel("venice:zai-org-glm-5-2", {
      apiKey: "test-key",
      maxTokens: 8192,
      reasoningOutput: true,
      useOpenAIResponsesApi: true,
      modelKwargs: { venice_parameters: { include_venice_system_prompt: false } },
    });

    const fields = openAIFields(llm);
    expect(fields["useResponsesApi"]).not.toBe(true);
    expect(modelKwargs(llm)["reasoning_effort"]).toBe("medium");
    expect(modelKwargs(llm)["venice_parameters"]).toEqual({
      include_venice_system_prompt: false,
    });
  });

  it("does not enable Responses for Fireworks when the flag is set", async () => {
    const llm = await createFireworks({
      modelId: "fireworks:accounts/fireworks/models/glm-5p2",
      apiKey: "test-key",
      maxTokens: 8192,
      reasoningOutput: true,
      reasoningEffort: "low",
      useOpenAIResponsesApi: true,
    });

    expect(openAIFields(llm)["useResponsesApi"]).not.toBe(true);
    expect(modelKwargs(llm)["reasoning_effort"]).toBe("low");
  });

  it("does not enable Responses for Anthropic when the flag is set", async () => {
    const llm = await createAnthropic({
      modelId: "anthropic:claude-opus-4-8",
      apiKey: "test-key",
      maxTokens: 8192,
      reasoningOutput: true,
      useOpenAIResponsesApi: true,
    });

    const fields = anthropicFields(llm);
    expect(fields["useResponsesApi"]).toBeUndefined();
    expect(fields["thinking"]).toEqual({ type: "adaptive" });
    expect(fields["outputConfig"]).toEqual({ effort: "medium" });
  });
});
