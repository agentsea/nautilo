import {
  ASSISTANT_MODELS,
  getCostCoefficient,
  getProviderFromModelId,
} from "./assistant-models";
import { getActiveModelCatalogSync } from "./model-catalog/runtime-catalog";

/**
 * Costs dashboard — per-model USD pricing.
 *
 * Nautilo receives token counts (not dollars) from most providers, so spend is
 * *estimated* as `tokens × price`. This table is the maintained source of those
 * prices. Bump {@link PRICING_VERSION} whenever a number changes so historical
 * rows (which freeze the estimate at insert) remain auditable.
 *
 * Prices are USD per 1,000,000 tokens. The Anthropic Sonnet baseline is
 * $3 in / $15 out (matches the `costCoefficient = 1.0` anchor in
 * `assistant-models.ts`).
 *
 * Cache rates: providers price cached prompt tokens differently.
 * - `cachedInputPerMtok` = cache-READ rate (Anthropic 0.1× input, OpenAI
 * ≈0.5×, Gemini ≈0.25×). Omit → cache reads bill at the normal input rate.
 * - `cacheWritePerMtok` = cache-WRITE/creation rate (for example Anthropic
 * 1.25× input and supported OpenAI models' published write rate). Omit → cache-creation
 * tokens bill at the normal input rate.
 * These rates are operator-confirmable from provider pricing sources.
 */
export interface ModelPrice {
  /** USD per 1M input (prompt) tokens. */
  inputPerMtok: number;
  /** USD per 1M output (completion) tokens. Reasoning tokens bill at this rate. */
  outputPerMtok: number;
  /** USD per 1M cached-READ input tokens, when the provider prices them lower. */
  cachedInputPerMtok?: number;
  /** USD per 1M cache-WRITE/creation input tokens (Anthropic 1.25× input). */
  cacheWritePerMtok?: number;
  /** Optional whole-request rate band selected when total input exceeds the threshold. */
  longContext?: {
    inputTokensAbove: number;
    rates: Omit<ModelPrice, "longContext">;
  };
}

/** Bump on any price change. Stored on each usage row for later reconciliation. */
export const PRICING_VERSION = "2026-09-23.1";

/** Baseline used to derive an estimate for models absent from the explicit table. */
const SONNET_BASELINE: ModelPrice = { inputPerMtok: 3, outputPerMtok: 15 };

/**
 * Explicit per-model prices (USD / 1M tokens). Keyed by full model id.
 * Models not listed fall back to a `costCoefficient`-scaled Sonnet baseline.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // OpenRouter Jev 1.13 model page, verified 2026-09-18. Output usage is free.
  "openrouter:typesafe/jev-1.13": { inputPerMtok: 0.042, outputPerMtok: 0 },
  // --- Anthropic (cache read 0.1× input, cache write 1.25× input) ---
  "anthropic:claude-sonnet-4-6": { inputPerMtok: 3, outputPerMtok: 15, cachedInputPerMtok: 0.3, cacheWritePerMtok: 3.75 },
  "anthropic:claude-sonnet-5": { inputPerMtok: 3, outputPerMtok: 15, cachedInputPerMtok: 0.3, cacheWritePerMtok: 3.75 },
  "anthropic:claude-fable-5": { inputPerMtok: 10, outputPerMtok: 50, cachedInputPerMtok: 1, cacheWritePerMtok: 12.5 },
  "anthropic:claude-opus-5": { inputPerMtok: 5, outputPerMtok: 25, cachedInputPerMtok: 0.5, cacheWritePerMtok: 6.25 },
  // Anthropic Opus 5.5, published rates verified 2026-09-23; usage aggregates cache TTLs.
  "anthropic:claude-opus-5-5": { inputPerMtok: 4, outputPerMtok: 20, cachedInputPerMtok: 0.2, cacheWritePerMtok: 5 },
  "anthropic:claude-opus-4-8": { inputPerMtok: 5, outputPerMtok: 25, cachedInputPerMtok: 0.5, cacheWritePerMtok: 6.25 },
  "anthropic:claude-opus-4-7": { inputPerMtok: 5, outputPerMtok: 25, cachedInputPerMtok: 0.5, cacheWritePerMtok: 6.25 },
  // --- OpenAI (rates are model-specific; cache writes and long-context tiers apply to GPT-6) ---
  "openai:gpt-5.5-2026-04-23": { inputPerMtok: 6, outputPerMtok: 30, cachedInputPerMtok: 3 },
  "openai:gpt-5.4-2026-03-05": { inputPerMtok: 3, outputPerMtok: 15, cachedInputPerMtok: 1.5 },
  // GPT-6 Sol/Luna rates and whole-request long-context bands, verified 2026-09-23:
  // https://developers.openai.com/api/docs/models/gpt-6-sol
  // https://developers.openai.com/api/docs/models/gpt-6-luna
  "openai:gpt-6-sol": {
    inputPerMtok: 2,
    outputPerMtok: 10,
    cachedInputPerMtok: 0.2,
    cacheWritePerMtok: 2.5,
    longContext: {
      inputTokensAbove: 272_000,
      rates: { inputPerMtok: 4, outputPerMtok: 15, cachedInputPerMtok: 0.4, cacheWritePerMtok: 5 },
    },
  },
  "openai:gpt-6-luna": {
    inputPerMtok: 0.1,
    outputPerMtok: 0.5,
    cachedInputPerMtok: 0.01,
    cacheWritePerMtok: 0.125,
    longContext: {
      inputTokensAbove: 272_000,
      rates: { inputPerMtok: 0.2, outputPerMtok: 0.75, cachedInputPerMtok: 0.02, cacheWritePerMtok: 0.25 },
    },
  },
  // GPT-5.6 standard rates and whole-request long-context pricing, verified 2026-09-18:
  // https://developers.openai.com/api/docs/models/gpt-5.6-sol
  // https://developers.openai.com/api/docs/models/gpt-5.6-terra
  // https://developers.openai.com/api/docs/models/gpt-5.6-luna
  "openai:gpt-5.6-sol": {
    inputPerMtok: 4,
    outputPerMtok: 20,
    cachedInputPerMtok: 0.4,
    cacheWritePerMtok: 5,
    longContext: {
      inputTokensAbove: 272_000,
      rates: { inputPerMtok: 8, outputPerMtok: 30, cachedInputPerMtok: 0.8, cacheWritePerMtok: 10 },
    },
  },
  "openai:gpt-5.6-terra": {
    inputPerMtok: 2,
    outputPerMtok: 12,
    cachedInputPerMtok: 0.2,
    cacheWritePerMtok: 2.5,
    longContext: {
      inputTokensAbove: 272_000,
      rates: { inputPerMtok: 4, outputPerMtok: 18, cachedInputPerMtok: 0.4, cacheWritePerMtok: 5 },
    },
  },
  "openai:gpt-5.6-luna": {
    inputPerMtok: 0.2,
    outputPerMtok: 1.2,
    cachedInputPerMtok: 0.02,
    cacheWritePerMtok: 0.25,
    longContext: {
      inputTokensAbove: 272_000,
      rates: { inputPerMtok: 0.4, outputPerMtok: 1.8, cachedInputPerMtok: 0.04, cacheWritePerMtok: 0.5 },
    },
  },
  // --- Google (implicit cache read ≈0.25× input, no separate write charge) ---
  "google:gemini-2.5-pro": { inputPerMtok: 1.25, outputPerMtok: 10, cachedInputPerMtok: 0.3125 },
  "google:gemini-3.1-pro-preview": { inputPerMtok: 1.5, outputPerMtok: 12, cachedInputPerMtok: 0.375 },
  "google:gemini-3-flash-preview": { inputPerMtok: 0.3, outputPerMtok: 2.5, cachedInputPerMtok: 0.075 },
  "google:gemini-3.1-flash-lite-preview": { inputPerMtok: 0.1, outputPerMtok: 0.4, cachedInputPerMtok: 0.025 },
  // --- Fireworks ---
  "fireworks:accounts/fireworks/models/kimi-k2p6": { inputPerMtok: 0.6, outputPerMtok: 2.5 },
  "fireworks:accounts/fireworks/models/kimi-k3": { inputPerMtok: 3, cachedInputPerMtok: 0.3, outputPerMtok: 15 },
  // Fireworks model page, verified 2026-09-08; full GLM-5.3, not Flash.
  "fireworks:accounts/fireworks/models/glm-5p3": { inputPerMtok: 1.4, cachedInputPerMtok: 0.26, outputPerMtok: 4.4 },
  "fireworks:accounts/fireworks/models/glm-5p2": { inputPerMtok: 0.55, outputPerMtok: 2.2 },
  "fireworks:accounts/fireworks/models/glm-5p1": { inputPerMtok: 0.55, outputPerMtok: 2.2 },
  "fireworks:accounts/fireworks/models/deepseek-v4-pro": { inputPerMtok: 0.9, outputPerMtok: 3 },
  "fireworks:accounts/fireworks/models/deepseek-v4-pro-0813": { inputPerMtok: 1.32, cachedInputPerMtok: 0.044, outputPerMtok: 3.96 },
  "openrouter:deepseek/deepseek-v4-pro-0813": { inputPerMtok: 0.435, cachedInputPerMtok: 0.003625, outputPerMtok: 0.87 },
  // OpenRouter public model API base rates, verified 2026-09-19. The provider
  // advertises scheduled override windows, so these remain dashboard estimates.
  "openrouter:deepseek/deepseek-v4.1-flash": { inputPerMtok: 0.15, cachedInputPerMtok: 0.003, outputPerMtok: 0.6 },
  "fireworks:accounts/fireworks/models/deepseek-v4-flash-0731": { inputPerMtok: 0.14, cachedInputPerMtok: 0.028, outputPerMtok: 0.28 },
  // Fireworks DeepSeek V4.1 Flash serverless model page, verified 2026-09-23.
  "fireworks:accounts/fireworks/models/deepseek-v4p1-flash": { inputPerMtok: 0.22, cachedInputPerMtok: 0.007, outputPerMtok: 0.66 },
  "fireworks:accounts/fireworks/models/minimax-m3": { inputPerMtok: 0.5, outputPerMtok: 2 },
  // --- OpenRouter ---
  // OpenRouter /api/v1/models route rates, verified 2026-09-23; standard 5m cache-write rate.
  "openrouter:anthropic/claude-opus-5.5": { inputPerMtok: 4, outputPerMtok: 20, cachedInputPerMtok: 0.2, cacheWritePerMtok: 5 },
  "openrouter:openai/gpt-6-sol": {
    inputPerMtok: 2,
    outputPerMtok: 10,
    cachedInputPerMtok: 0.2,
    cacheWritePerMtok: 2.5,
    longContext: {
      inputTokensAbove: 272_000,
      rates: { inputPerMtok: 4, outputPerMtok: 15, cachedInputPerMtok: 0.4, cacheWritePerMtok: 5 },
    },
  },
  "openrouter:openai/gpt-6-luna": {
    inputPerMtok: 0.1,
    outputPerMtok: 0.5,
    cachedInputPerMtok: 0.01,
    cacheWritePerMtok: 0.125,
    longContext: {
      inputTokensAbove: 272_000,
      rates: { inputPerMtok: 0.2, outputPerMtok: 0.75, cachedInputPerMtok: 0.02, cacheWritePerMtok: 0.25 },
    },
  },
  // --- Venice ---
  // Venice /api/v1/models rates, verified 2026-09-23; usage exposes aggregated cache writes.
  "venice:claude-opus-5-5": { inputPerMtok: 4.8, outputPerMtok: 24, cachedInputPerMtok: 0.24, cacheWritePerMtok: 6 },
  "venice:openai-gpt-6-sol": {
    inputPerMtok: 2.5,
    outputPerMtok: 12.5,
    cachedInputPerMtok: 0.25,
    cacheWritePerMtok: 3.125,
    longContext: {
      inputTokensAbove: 272_000,
      rates: { inputPerMtok: 5, outputPerMtok: 18.75, cachedInputPerMtok: 0.5, cacheWritePerMtok: 6.25 },
    },
  },
  "venice:openai-gpt-6-luna": {
    inputPerMtok: 0.125,
    outputPerMtok: 0.625,
    cachedInputPerMtok: 0.0125,
    cacheWritePerMtok: 0.15625,
    longContext: {
      inputTokensAbove: 272_000,
      rates: { inputPerMtok: 0.25, outputPerMtok: 0.9375, cachedInputPerMtok: 0.025, cacheWritePerMtok: 0.3125 },
    },
  },
  "venice:deepseek-v4-flash": { inputPerMtok: 0.17, cachedInputPerMtok: 0.03, outputPerMtok: 0.35 },
  // --- Embeddings ---
  "openai:text-embedding-3-small": { inputPerMtok: 0.02, outputPerMtok: 0 },
  "openai:text-embedding-3-large": { inputPerMtok: 0.13, outputPerMtok: 0 },
};

/** Exact alternate serving-path rate cards, keyed by canonical model then reviewed profile. */
const MODEL_SERVING_PROFILE_PRICES: Record<string, Record<string, ModelPrice>> = {
  "fireworks:accounts/fireworks/models/kimi-k3": {
    standard: { inputPerMtok: 3, cachedInputPerMtok: 0.3, outputPerMtok: 15 },
    priority: { inputPerMtok: 3.75, cachedInputPerMtok: 0.375, outputPerMtok: 18.75 },
    fast: { inputPerMtok: 4.5, cachedInputPerMtok: 0.45, outputPerMtok: 22.5 },
  },
};

/**
 * Per-image pricing (USD per generated image) for image-gen calls, which are
 * priced per image rather than per token. Keyed by full model id; falls back to
 * {@link DEFAULT_IMAGE_PRICE_USD} for unknown image models.
 */
export const IMAGE_PRICES_USD: Record<string, number> = {
  "openai:gpt-image-1": 0.04,
  "google:imagen-4": 0.04,
};

export const DEFAULT_IMAGE_PRICE_USD = 0.04;

/** How token-based usage rows derived their frozen USD estimate at insert. */
export type PricingSource = "explicit" | "catalog_decision" | "serving_profile" | "catalog_coefficient" | "baseline_default";

/** How image-gen usage rows derived their frozen USD estimate at insert. */
export type ImagePricingSource = "image_explicit" | "image_default";

/** Reserved `llm_usage_events.metadata.usagePricingSource` values. */
export type UsagePricingSource = PricingSource | ImagePricingSource;

/** Stored metadata sources that indicate a coefficient/default fallback estimate. */
export const FALLBACK_USAGE_PRICING_SOURCES = [
  "catalog_coefficient",
  "baseline_default",
  "image_default",
] as const satisfies readonly UsagePricingSource[];

export type FallbackUsagePricingSource = (typeof FALLBACK_USAGE_PRICING_SOURCES)[number];

export interface ResolvedModelPrice {
  price: ModelPrice;
  source: PricingSource;
}

export interface ResolvedImagePrice {
  priceUsd: number;
  source: ImagePricingSource;
}

function pricingSourceForDerivedModel(modelId: string): PricingSource {
  const active = getActiveModelCatalogSync().catalog.entries.find(
    (entry) => entry.id === modelId,
  );
  if (active) return "catalog_coefficient";
  const row = ASSISTANT_MODELS.find((m) => m.id === modelId);
  if (row) return "catalog_coefficient";
  return "baseline_default";
}

/**
 * Resolve a price for a model id, using the explicit table when present and
 * otherwise a canonical `getCostCoefficient`-scaled Sonnet baseline. Always
 * returns a price so estimates never silently drop to zero for unknown/dynamic
 * models.
 */
export function resolveModelPrice(modelId: string, servingProfileId?: string): ResolvedModelPrice {
  const servingProfilePrice = servingProfileId === undefined ? undefined : MODEL_SERVING_PROFILE_PRICES[modelId]?.[servingProfileId];
  if (servingProfilePrice) return { price: servingProfilePrice, source: "serving_profile" };
  const entry = getActiveModelCatalogSync().catalog.entries.find((row) => row.id === modelId);
  if (entry && "decision" in entry && entry.decision && "pricing" in entry.decision && entry.decision.pricing) {
    const { inputPerMtok, cachedInputPerMtok, outputPerMtok } = entry.decision.pricing;
    return { price: { inputPerMtok, cachedInputPerMtok, outputPerMtok }, source: "catalog_decision" };
  }
  const direct = MODEL_PRICES[modelId];
  if (direct) return { price: direct, source: "explicit" };
  const coeff = getCostCoefficient(modelId);
  return {
    price: {
      inputPerMtok: SONNET_BASELINE.inputPerMtok * coeff,
      outputPerMtok: SONNET_BASELINE.outputPerMtok * coeff,
    },
    source: pricingSourceForDerivedModel(modelId),
  };
}

/** Resolve a per-image price and its provenance. */
export function resolveImagePrice(modelId: string): ResolvedImagePrice {
  const explicit = IMAGE_PRICES_USD[modelId];
  if (explicit !== undefined) {
    return { priceUsd: explicit, source: "image_explicit" };
  }
  return { priceUsd: DEFAULT_IMAGE_PRICE_USD, source: "image_default" };
}

/**
 * Resolve a price for a model id. Prefer {@link resolveModelPrice} when the
 * pricing source is needed for metering metadata.
 */
export function getModelPrice(modelId: string, servingProfileId?: string): ModelPrice {
  return resolveModelPrice(modelId, servingProfileId).price;
}

export interface UsageTokens {
  inputTokens?: number;
  outputTokens?: number;
  /** Reasoning/thinking tokens; assumed to be a subset of output — not billed twice. */
  reasoningTokens?: number;
  /** Cache-READ input tokens; billed at the model's cached-read rate. */
  cachedInputTokens?: number;
  /** Cache-WRITE/creation input tokens (Anthropic); billed at the write rate. */
  cacheCreationTokens?: number;
}

/**
 * Estimate USD cost for a token-based call.
 *
 * Providers fold cache reads + cache creation INTO `inputTokens`
 * (LangChain normalizes `usage_metadata.input_tokens = uncached + cache_read
 * + cache_creation`). So we split them out and bill each band at its rate:
 * uncached → inputPerMtok
 * cache_read → cachedInputPerMtok (fallback: inputPerMtok)
 * cache_creation→ cacheWritePerMtok (fallback: inputPerMtok)
 * output → outputPerMtok (reasoning tokens are already inside output)
 */
export function estimateCostUsd(modelId: string, tokens: UsageTokens, servingProfileId?: string): number {
  const resolvedPrice = resolveModelPrice(modelId, servingProfileId).price;
  const input = Math.max(0, tokens.inputTokens ?? 0);
  const output = Math.max(0, tokens.outputTokens ?? 0);
  const price = resolvedPrice.longContext && input > resolvedPrice.longContext.inputTokensAbove
    ? resolvedPrice.longContext.rates
    : resolvedPrice;
  const cacheRead = Math.max(0, Math.min(tokens.cachedInputTokens ?? 0, input));
  const cacheCreation = Math.max(
    0,
    Math.min(tokens.cacheCreationTokens ?? 0, input - cacheRead),
  );
  const uncached = Math.max(0, input - cacheRead - cacheCreation);

  const readRate = price.cachedInputPerMtok ?? price.inputPerMtok;
  const writeRate = price.cacheWritePerMtok ?? price.inputPerMtok;

  let cost = 0;
  cost += (uncached * price.inputPerMtok) / 1_000_000;
  cost += (cacheRead * readRate) / 1_000_000;
  cost += (cacheCreation * writeRate) / 1_000_000;
  cost += (output * price.outputPerMtok) / 1_000_000;
  return cost;
}

/** Estimate USD cost for an image-generation call. */
export function estimateImageCostUsd(modelId: string, imageCount: number): number {
  return resolveImagePrice(modelId).priceUsd * Math.max(0, imageCount);
}

/** True when we have an explicit (non-derived) price for this model. */
export function hasExplicitPrice(modelId: string): boolean {
  return modelId in MODEL_PRICES;
}

export { getProviderFromModelId };
