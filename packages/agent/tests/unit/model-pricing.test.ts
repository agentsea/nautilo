import { afterEach, describe, expect, test } from "bun:test";
import {
  estimateCostUsd,
  estimateImageCostUsd,
  getModelPrice,
  hasExplicitPrice,
  PRICING_VERSION,
  resolveImagePrice,
  resolveModelPrice,
} from "../../src/config/model-pricing";
import {
  configureRuntimeModelCatalog,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "../../src/config/model-catalog/runtime-catalog";
import { ModelCatalogSchema } from "@nautilo/types";
import {
  extractNativeWebSearchRequests,
  extractUsageFromLLMResult,
} from "../../src/usage/usage-callback";

describe("model pricing (D405)", () => {
  test("Sonnet baseline is $3 in / $15 out per Mtok", () => {
    const price = getModelPrice("anthropic:claude-sonnet-4-6");
    expect(price.inputPerMtok).toBe(3);
    expect(price.outputPerMtok).toBe(15);
  });

  test("full Fireworks GLM 5.3 usage uses its exact input/cache/output rates", () => {
    const id = "fireworks:accounts/fireworks/models/glm-5p3";
    expect(hasExplicitPrice(id)).toBe(true);
    expect(getModelPrice(id)).toEqual({ inputPerMtok: 1.4, cachedInputPerMtok: 0.26, outputPerMtok: 4.4 });
    expect(estimateCostUsd(id, { inputTokens: 2_000_000, cachedInputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(6.06, 6);
  });

  test("estimateCostUsd computes tokens × price", () => {
    // 1M input @ $3 + 1M output @ $15 = $18
    const cost = estimateCostUsd("anthropic:claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(18, 6);
  });

  test("cached input tokens bill at the cached rate", () => {
    // 1M input of which 1M cached @ $0.30 + 0 output = $0.30
    const cost = estimateCostUsd("anthropic:claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.3, 6);
  });

  test("unknown model falls back to a coefficient-scaled estimate (never zero)", () => {
    const price = getModelPrice("openrouter:some/unlisted-model");
    expect(price.inputPerMtok).toBeGreaterThan(0);
    expect(price.outputPerMtok).toBeGreaterThan(0);
    expect(hasExplicitPrice("openrouter:some/unlisted-model")).toBe(false);
  });

  test("image pricing is per-image", () => {
    expect(estimateImageCostUsd("openai:gpt-image-1", 3)).toBeCloseTo(0.12, 6);
    // unknown image model → default per-image price, still > 0
    expect(estimateImageCostUsd("unknown:model", 1)).toBeGreaterThan(0);
  });

  test("pricing version is a non-empty tag", () => {
    expect(typeof PRICING_VERSION).toBe("string");
    expect(PRICING_VERSION.length).toBeGreaterThan(0);
  });
});

describe("cache-aware pricing (D407)", () => {
  test("D462 — Kimi K3 serving profiles use published uncached, cached, and output rates", () => {
    const model = "fireworks:accounts/fireworks/models/kimi-k3";
    expect(resolveModelPrice(model)).toEqual({
      source: "explicit",
      price: { inputPerMtok: 3, cachedInputPerMtok: 0.3, outputPerMtok: 15 },
    });
    const expected = {
      standard: { input: 3, cached: 0.3, output: 15 },
      priority: { input: 3.75, cached: 0.375, output: 18.75 },
      fast: { input: 4.5, cached: 0.45, output: 22.5 },
    } as const;
    for (const [profile, rates] of Object.entries(expected)) {
      expect(resolveModelPrice(model, profile)).toEqual({
        source: "serving_profile",
        price: { inputPerMtok: rates.input, cachedInputPerMtok: rates.cached, outputPerMtok: rates.output },
      });
      expect(estimateCostUsd(model, { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 1_000_000 }, profile)).toBeCloseTo(rates.cached + rates.output, 8);
    }
  });

  test("DeepSeek V4 Pro 0813 uses provider-published Fireworks and OpenRouter rates", () => {
    expect(resolveModelPrice("fireworks:accounts/fireworks/models/deepseek-v4-pro-0813")).toEqual({
      source: "explicit",
      price: { inputPerMtok: 1.32, cachedInputPerMtok: 0.044, outputPerMtok: 3.96 },
    });
    expect(resolveModelPrice("openrouter:deepseek/deepseek-v4-pro-0813")).toEqual({
      source: "explicit",
      price: { inputPerMtok: 0.435, cachedInputPerMtok: 0.003625, outputPerMtok: 0.87 },
    });
  });

  test("Anthropic cache_read bills at 0.1× input", () => {
    // 1M input, all cache reads @ $0.30/M → $0.30
    const cost = estimateCostUsd("anthropic:claude-sonnet-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.3, 6);
  });

  test("Anthropic cache_creation bills at 1.25× input", () => {
    // 1M input, all cache-creation @ $3.75/M → $3.75
    const cost = estimateCostUsd("anthropic:claude-sonnet-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(3.75, 6);
  });

  test("Anthropic mixed bands: uncached@1× + read@0.1× + creation@1.25×", () => {
    // input 1M = 800k uncached + 150k read + 50k creation
    // 800000*3 + 150000*0.3 + 50000*3.75 all /1e6 = 2.4 + 0.045 + 0.1875
    const cost = estimateCostUsd("anthropic:claude-sonnet-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 150_000,
      cacheCreationTokens: 50_000,
    });
    expect(cost).toBeCloseTo(2.6325, 6);
  });

  test("OpenAI cache_read bills at ≈0.5× input (no separate write rate)", () => {
    // gpt-5.5 input $6/M, cached read $3/M → 1M cache reads = $3.00
    const cost = estimateCostUsd("openai:gpt-5.5-2026-04-23", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(3, 6);
  });

  test("Stack 166 — gpt-5.6-sol has explicit pricing incl. a separate cache-write rate", () => {
    expect(hasExplicitPrice("openai:gpt-5.6-sol")).toBe(true);
    const resolved = resolveModelPrice("openai:gpt-5.6-sol");
    expect(resolved.source).toBe("explicit");
    expect(resolved.price.inputPerMtok).toBe(5);
    expect(resolved.price.outputPerMtok).toBe(30);
    expect(resolved.price.cacheWritePerMtok).toBe(6.25);
    // 1M cache-creation tokens @ $6.25/M = $6.25 (5.6 publishes a write rate)
    const cost = estimateCostUsd("openai:gpt-5.6-sol", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(6.25, 6);
  });

  test("gpt-5.6-terra explicit pricing remains authoritative", () => {
    const resolved = resolveModelPrice("openai:gpt-5.6-terra");
    expect(resolved.source).toBe("explicit");
    expect(resolved.price.inputPerMtok).toBe(2.5);
    expect(resolved.price.outputPerMtok).toBe(15);
  });

  test("Venice DeepSeek V4 Flash uses its explicit published rates", () => {
    expect(resolveModelPrice("venice:deepseek-v4-flash")).toEqual({
      source: "explicit",
      price: { inputPerMtok: 0.17, cachedInputPerMtok: 0.03, outputPerMtok: 0.35 },
    });
  });

  test("static catalog coefficient scales the Sonnet baseline", () => {
    resetRuntimeModelCatalog();
    const resolved = resolveModelPrice("openrouter:moonshotai/kimi-k2.6");
    expect(resolved.source).toBe("catalog_coefficient");
    expect(resolved.price.inputPerMtok).toBeCloseTo(3 * 0.22, 6);
    expect(resolved.price.outputPerMtok).toBeCloseTo(15 * 0.22, 6);
  });

  test("unknown dynamic id uses baseline_default with coefficient 1.0", () => {
    resetRuntimeModelCatalog();
    const resolved = resolveModelPrice("openrouter:some/unlisted-model");
    expect(resolved.source).toBe("baseline_default");
    expect(resolved.price.inputPerMtok).toBe(3);
    expect(resolved.price.outputPerMtok).toBe(15);
  });

  test("image pricing exposes explicit vs default sources", () => {
    expect(resolveImagePrice("openai:gpt-image-1").source).toBe("image_explicit");
    expect(resolveImagePrice("unknown:model").source).toBe("image_default");
  });
});

describe("runtime-catalog pricing (ISSUE-M217)", () => {
  afterEach(() => {
    resetRuntimeModelCatalog();
  });

  test("active runtime-catalog-only coefficient scales the Sonnet baseline", async () => {
    const runtimeOnlyId = "openrouter:runtime-catalog-only-test";
    const catalog = ModelCatalogSchema.parse({
      version: 1,
      catalogVersion: "2026.07.20.1",
      publishedAt: "2026-07-20T10:00:00Z",
      entries: [
        {
          id: runtimeOnlyId,
          displayName: "Runtime Only (OpenRouter)",
          provider: "openrouter",
          routing: "openrouter",
          priority: 99,
          defaultEnabled: true,
          modalities: { input: ["text"], output: ["text"] },
          features: { tools: true, structuredOutputs: false, reasoning: false },
          limits: { contextTokens: 128_000, outputTokens: 8_000 },
          cost: { coefficient: 2.5 },
          privacy: { grade: 2 },
          intelligence: { tier: "frontier" },
          capabilityProvenance: "override",
        },
      ],
    });
    configureRuntimeModelCatalog({
      loader: {
        get: async () => ({
          catalog,
          source: "remote-fresh",
          stale: false,
          fetchedAt: "2026-07-20T10:00:00.000Z",
          originUrl: "https://example.test/pointer.json",
          reason: "",
          catalogVersion: catalog.catalogVersion,
        }),
        refresh: async () => ({
          catalog,
          source: "remote-fresh",
          stale: false,
          fetchedAt: "2026-07-20T10:00:00.000Z",
          originUrl: "https://example.test/pointer.json",
          reason: "",
          catalogVersion: catalog.catalogVersion,
        }),
        clearCache: () => {},
      },
    });
    await hydrateRuntimeModelCatalog();

    const resolved = resolveModelPrice(runtimeOnlyId);
    expect(resolved.source).toBe("catalog_coefficient");
    expect(resolved.price.inputPerMtok).toBeCloseTo(7.5, 6);
    expect(resolved.price.outputPerMtok).toBeCloseTo(37.5, 6);
    expect(getModelPrice(runtimeOnlyId)).toEqual(resolved.price);
  });
});

describe("usage extraction from LLMResult (D405)", () => {
  test("reads usage_metadata incl. cache-read + reasoning details", () => {
    const usage = extractUsageFromLLMResult({
      generations: [
        [
          {
            text: "hi",
            message: {
              usage_metadata: {
                input_tokens: 100,
                output_tokens: 40,
                total_tokens: 140,
                input_token_details: { cache_read: 25, cache_creation: 15 },
                output_token_details: { reasoning: 10 },
              },
            },
          },
        ],
      ],
    } as never);
    expect(usage).not.toBeNull();
    expect(usage?.inputTokens).toBe(100);
    expect(usage?.outputTokens).toBe(40);
    expect(usage?.cachedInputTokens).toBe(25);
    expect(usage?.cacheCreationTokens).toBe(15);
    expect(usage?.reasoningTokens).toBe(10);
  });

  test("captures provider-reported actual cost when present (OpenRouter)", () => {
    const usage = extractUsageFromLLMResult({
      generations: [
        [
          {
            text: "hi",
            message: {
              usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
              response_metadata: { usage: { cost: 0.0123 } },
            },
          },
        ],
      ],
    } as never);
    expect(usage?.actualCostUsd).toBeCloseTo(0.0123, 6);
  });

  test("falls back to llmOutput.tokenUsage (OpenAI shape)", () => {
    const usage = extractUsageFromLLMResult({
      generations: [[{ text: "hi", message: {} }]],
      llmOutput: { tokenUsage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } },
    } as never);
    expect(usage?.inputTokens).toBe(7);
    expect(usage?.outputTokens).toBe(3);
  });

  test("returns null when there is no usage signal", () => {
    expect(extractUsageFromLLMResult({ generations: [[{ text: "" }]] } as never)).toBeNull();
  });

  test("counts provider-native OpenAI and Anthropic web-search receipts", () => {
    expect(extractNativeWebSearchRequests({
      generations: [[{
        text: "searched",
        message: {
          additional_kwargs: {
            tool_outputs: [{ type: "web_search_call" }, { type: "web_search_call" }],
          },
          response_metadata: {
            usage: { server_tool_use: { web_search_requests: 3 } },
          },
        },
      }]],
    } as never)).toBe(5);
  });
});
