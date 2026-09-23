/**
 * OpenAI-only Responses provider gate and provider isolation.
 * Hermetic: no live OpenAI, no secrets.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  createAnthropic,
  createFireworks,
  createOpenAI,
  shouldUseOpenAIResponsesApi,
} from "../../src/providers/factory";
import { createUniversalModel } from "../../src/providers/universal";
import { resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { activateModelCatalogForTests } from "../helpers/activate-model-catalog";
import { projectPreparedMessagesForModelCache } from "../../src/utils/model-context-cache";

beforeAll(async () => {
  await activateModelCatalogForTests([
    { id: "openai:test-non-reasoning", reasoning: false },
    "openai:gpt-6-astra", "openai:gpt-6-sol", "openai:gpt-6-luna",
  ]);
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

describe("shouldUseOpenAIResponsesApi ( transport policy)", () => {
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

describe("createUniversalModel — OpenAI Responses flag isolation ", () => {
  it("preserves GPT-6 Chat Completions token parameters without disabling reasoning for text utilities", async () => {
    for (const modelId of ["openai:gpt-6-astra", "openai:gpt-6-sol", "openai:gpt-6-luna"]) {
      const llm = await createUniversalModel(modelId, {
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
      expect(params["reasoning_effort"]).toBeUndefined();
      expect(params).not.toHaveProperty("max_tokens");
    }
  });

  it("honors direct GPT-6 opt-in independently of output and headroom", async () => {
    for (const modelId of ["openai:gpt-6-astra", "openai:gpt-6-sol", "openai:gpt-6-luna"]) {
      const options = { modelId, apiKey: "test-key", maxTokens: 128, reasoningOutput: false, useOpenAIResponsesApi: true };
      expect(shouldUseOpenAIResponsesApi(options, 128)).toBe(true);
      expect(shouldUseOpenAIResponsesApi({ ...options, useOpenAIResponsesApi: false }, 128)).toBe(false);
      const llm = await createUniversalModel(modelId, options);
      expect(openAIFields(llm)["useResponsesApi"]).toBe(true);
      expect(openAIFields(llm)["reasoning"]).toEqual({ effort: "medium" });
      expect(createUniversalModel(modelId, { ...options, reasoningEffort: "minimal" })).rejects.toThrow("not supported");
    }
  });

  it("preserves explicit effort and validates deliberate disablement on direct GPT-6", async () => {
    for (const modelId of ["openai:gpt-6-astra", "openai:gpt-6-sol", "openai:gpt-6-luna"]) {
      const options = { apiKey: "test-key", reasoningOutput: false, useOpenAIResponsesApi: true };
      const llm = await createUniversalModel(modelId, { ...options, reasoningEffort: "high" });
      expect(openAIFields(llm)["reasoning"]).toEqual({ effort: "high" });
      if (modelId === "openai:gpt-6-astra") {
        expect(createUniversalModel(modelId, { ...options, reasoningEffort: "off" })).rejects.toThrow("not supported");
      } else {
        const disabled = await createUniversalModel(modelId, { ...options, reasoningEffort: "off" });
        expect(openAIFields(disabled)["reasoning"]).toEqual({ effort: "none" });
      }
    }
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

  it("combines implicit history caching with the explicit stable breakpoint only for direct GPT-5.6", async () => {
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
      prompt_cache_options: { mode: "implicit" },
    });

    const stable = "stable system and tool guidance";
    const projected = projectPreparedMessagesForModelCache(
      [new SystemMessage(`${stable}\nvolatile turn context`), new HumanMessage("hello")],
      "openai:gpt-5.6-luna",
      stable.length,
      { openAIExplicitPromptCache: true },
    );
    expect(projected[0]?.content).toEqual([
      {
        type: "input_text",
        text: stable,
        prompt_cache_breakpoint: { mode: "explicit" },
      },
      { type: "input_text", text: "\nvolatile turn context" },
    ]);
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
