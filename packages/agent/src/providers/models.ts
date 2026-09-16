import { log as logInfo, warn as logWarn } from "@nautilo/logger";
import { modelSupportsInput as catalogSupportsInput } from "@nautilo/model-capabilities";
import { getActiveModelCatalogSync } from "../config/model-catalog/runtime-catalog";

export type ModelClass = "4K" | "32K" | "128K" | "160K" | "200K" | "256K" | "400K" | "512K" | "1M" | "2M" | "10M";
export type ModelInputCapability = "text" | "image" | "pdf" | "audio";

const MODEL_CLASS_TO_LIMIT: Record<ModelClass, number> = {
  "4K": 4096,
  "32K": 32768,
  "128K": 131072,
  "160K": 160000,
  "200K": 200000,
  "256K": 262144,
  "400K": 400000,
  "512K": 512000,
  "1M": 1000000,
  "2M": 2000000,
  "10M": 10000000,
};

let MODEL_TOKEN_OVERRIDES: Record<string, number> = {};
let MODEL_OUTPUT_TOKEN_OVERRIDES: Record<string, number> = {};

const OUTPUT_LIMIT_CACHE = new Map<string, number>();
const OUTPUT_LIMIT_PENDING = new Map<string, Promise<number>>();
const OUTPUT_LIMIT_SOURCE_CACHE = new Map<string, "provider" | "static" | "default">();

const DEFAULT_OUTPUT_TOKEN_LIMIT = 8_192;

/**
 * Exact **total context** sizes from provider model APIs (lowercase keys).
 * - Fireworks `glm-5p2`: Fireworks model page reports 1040K context, serverless ready
 *   with function calling and no image input (2026-06-18).
 * - Fireworks `glm-5p1` / `glm-5`: `GET https://api.fireworks.ai/inference/v1/models` → `context_length` 202_752 each (2026-05-01).
 * - OpenRouter: `GET https://openrouter.ai/api/v1/models` → `context_length` for each `openrouter:` id (e.g. `z-ai/glm-5.1` = 202_752, `moonshotai/kimi-k2.6` = 262_142).
 * - Fireworks Kimi: `kimi-k2p6` → `context_length` 262_144 (2026-05-01).
 * - Fireworks MiniMax M3: `accounts/fireworks/models/minimax-m3` model page + live
 *   chat-completions validation (2026-06-18) → 512K context.
 * - Anthropic Opus 4.7: `GET https://api.anthropic.com/v1/models/claude-opus-4-7` →
 *   `max_input_tokens` 1_000_000, `max_tokens` (max output) 128_000 (2026-05-01).
 * - Anthropic Sonnet 4.6: same endpoint for `claude-sonnet-4-6` → `max_input_tokens` 1_000_000,
 *   `max_tokens` 128_000 (2026-05-01).
 * Env `MODEL_TOKEN_OVERRIDES` / file may lower these per deployment but may
 * never raise the signed catalog ceiling.
 */
const NAUTILO_BUILTIN_CONTEXT_TOKENS: Record<string, number> = {
  "anthropic:claude-opus-5": 1_000_000,
  "anthropic:claude-opus-4-8": 1_000_000,
  "anthropic:claude-opus-4-7": 1_000_000,
  "anthropic:claude-opus-4-6": 1_000_000,
  "anthropic:claude-sonnet-4-6": 1_000_000,
  "openrouter:anthropic/claude-sonnet-4.6": 1_000_000,
  "openrouter:openai/gpt-5.5": 1_050_000,
  "openrouter:google/gemini-3.1-pro-preview": 1_048_576,
  "anthropic:claude-sonnet-5": 1_000_000,
  // D399 — Anthropic GET /v1/models/claude-fable-5 → max_input_tokens 1_000_000 (2026-07-08).
  "anthropic:claude-fable-5": 1_000_000,
  "fireworks:accounts/fireworks/models/glm-5p2": 1_040_000,
  "fireworks:accounts/fireworks/models/glm-5p1": 202_752,
  "fireworks:accounts/fireworks/models/glm-5": 202_752,
  "openrouter:z-ai/glm-5.1": 202_752,
  "fireworks:accounts/fireworks/models/minimax-m3": 512_000,
  "fireworks:accounts/fireworks/models/minimax-m2p7": 196_608,
  "fireworks:accounts/fireworks/models/deepseek-v4-pro": 1_048_576,
  "fireworks:accounts/fireworks/models/deepseek-v4-pro-0813": 1_040_000,
  "fireworks:accounts/fireworks/models/deepseek-v4-flash-0731": 1_040_000,
  "openrouter:deepseek/deepseek-v4-pro": 1_048_576,
  "openrouter:deepseek/deepseek-v4-pro-0813": 1_048_576,
  "openrouter:minimax/minimax-m2.7": 196_608,
  "fireworks:accounts/fireworks/models/kimi-k2p6": 262_144,
  "openrouter:moonshotai/kimi-k2.6": 262_142,
  "fireworks:accounts/fireworks/models/gemma-4-31b-it": 262_144,
  "fireworks:accounts/fireworks/models/gemma-4-26b-a4b-it": 262_144,
  "openrouter:google/gemma-4-31b-it": 262_144,
  "openrouter:google/gemma-4-26b-a4b-it": 262_144,
};

/**
 * Exact **max generation** (`max_tokens` / LangChain `maxTokens`) from provider docs + APIs.
 * - Fireworks GLM 5.2 / GLM 5.1 / GLM 5, MiniMax M3 / M2.7 & DeepSeek V4 Pro: Fireworks FAQ — for most models, max completion
 *   equals the model’s full context window (`https://docs.fireworks.ai/faq/models/inference/limitations-controls`).
 * - Fireworks MiniMax M3: live chat-completions accepted `max_tokens: 512000` (2026-06-18).
 * - OpenRouter DeepSeek V4 Pro: `GET /api/v1/models` → `top_provider.max_completion_tokens` = 384_000 (2026-05-01).
 * - OpenRouter `z-ai/glm-5.1`: same API → `top_provider.max_completion_tokens` = 65_535 (2026-05-01).
 * - OpenRouter `moonshotai/kimi-k2.6`: same API → `top_provider.max_completion_tokens` = 262_142 (2026-05-01).
 * - OpenRouter MiniMax M2.7: same API leaves `max_completion_tokens` null; OpenRouter request schema uses
 *   `max_tokens` in `[1, context_length)` (exclusive upper bound), hence **196_608 − 1**.
 *   (`https://openrouter.ai/docs/api/reference/overview` — `max_tokens` range.)
 * - Anthropic Opus 4.7: `GET /v1/models/claude-opus-4-7` → `max_tokens` 128_000 (2026-05-01).
 * - Anthropic Sonnet 4.6: `GET /v1/models/claude-sonnet-4-6` → `max_tokens` 128_000 (2026-05-01).
 */
const NAUTILO_BUILTIN_OUTPUT_TOKENS: Record<string, number> = {
  "anthropic:claude-opus-5": 128_000,
  "anthropic:claude-opus-4-8": 128_000,
  "anthropic:claude-opus-4-7": 128_000,
  "anthropic:claude-opus-4-6": 128_000,
  "anthropic:claude-sonnet-4-6": 128_000,
  "openrouter:anthropic/claude-sonnet-4.6": 128_000,
  "openrouter:openai/gpt-5.5": 128_000,
  "openrouter:google/gemini-3.1-pro-preview": 65_536,
  "anthropic:claude-sonnet-5": 128_000,
  // D399 — Anthropic GET /v1/models/claude-fable-5 → max_tokens 128_000 (2026-07-08).
  "anthropic:claude-fable-5": 128_000,
  "fireworks:accounts/fireworks/models/glm-5p2": 1_040_000,
  "fireworks:accounts/fireworks/models/glm-5p1": 202_752,
  "fireworks:accounts/fireworks/models/glm-5": 202_752,
  "openrouter:z-ai/glm-5.1": 65_535,
  "fireworks:accounts/fireworks/models/minimax-m3": 512_000,
  "fireworks:accounts/fireworks/models/minimax-m2p7": 196_608,
  "fireworks:accounts/fireworks/models/deepseek-v4-pro": 1_048_576,
  "fireworks:accounts/fireworks/models/deepseek-v4-pro-0813": 1_040_000,
  "fireworks:accounts/fireworks/models/deepseek-v4-flash-0731": 1_040_000,
  "openrouter:deepseek/deepseek-v4-pro": 384_000,
  "openrouter:minimax/minimax-m2.7": 196_607,
  "fireworks:accounts/fireworks/models/kimi-k2p6": 262_144,
  "openrouter:moonshotai/kimi-k2.6": 262_142,
  "fireworks:accounts/fireworks/models/gemma-4-31b-it": 262_144,
  "fireworks:accounts/fireworks/models/gemma-4-26b-a4b-it": 262_144,
  "openrouter:google/gemma-4-31b-it": 65_536,
  "openrouter:google/gemma-4-26b-a4b-it": 65_536,
};

function setModelTokenOverrides(overrides: Record<string, number>): void {
  MODEL_TOKEN_OVERRIDES = Object.fromEntries(
    Object.entries(overrides).map(([k, v]) => [k.toLowerCase(), v])
  );
}

function setModelOutputTokenOverrides(overrides: Record<string, number>): void {
  MODEL_OUTPUT_TOKEN_OVERRIDES = Object.fromEntries(
    Object.entries(overrides).map(([k, v]) => [k.toLowerCase(), v])
  );
  OUTPUT_LIMIT_CACHE.clear();
  OUTPUT_LIMIT_PENDING.clear();
  OUTPUT_LIMIT_SOURCE_CACHE.clear();
}

export interface ResolveOptions {
  anthropicLongContextBeta?: boolean;
  contextTokenOverride?: number;
  outputTokenOverride?: number;
}

interface ActiveCatalogLimitSnapshot {
  readonly catalogVersion: string;
  readonly contextTokens: number;
  readonly outputTokens: number;
}

export interface ResolvedModelExecutionLimits {
  readonly modelId: string;
  readonly catalogVersion: string | null;
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
  readonly contextSource: "override" | "catalog" | "static";
  readonly outputSource: "override" | "catalog" | "provider" | "static" | "default";
}

export class MissingModelExecutionLimitsError extends Error {
  readonly code = "NAUTILO_MISSING_MODEL_EXECUTION_LIMITS" as const;

  constructor(
    public readonly modelId: string,
    public readonly catalogVersion: string,
    reason: "not-catalogued" | "generation-workload" | "missing-limits",
  ) {
    const detail = reason === "not-catalogued"
      ? "is not present in the active signed catalog"
      : reason === "generation-workload"
        ? "is a generation workload and cannot be used for chat completion"
        : "does not declare limits.contextTokens and limits.outputTokens";
    super(
      `Model "${modelId || "<empty>"}" ${detail} (catalog ${catalogVersion}). ` +
        "Add reviewed model-specific limits to the catalog before enabling execution.",
    );
    this.name = "MissingModelExecutionLimitsError";
  }
}

function requireActiveCatalogLimitSnapshot(modelId: string): ActiveCatalogLimitSnapshot {
  const normalizedId = modelId.trim();
  const { catalog } = getActiveModelCatalogSync();
  const entry = catalog.entries.find((candidate) => candidate.id === normalizedId);
  if (!entry) {
    throw new MissingModelExecutionLimitsError(normalizedId, catalog.catalogVersion, "not-catalogued");
  }
  if ("workload" in entry && entry.workload === "generation") {
    throw new MissingModelExecutionLimitsError(normalizedId, catalog.catalogVersion, "generation-workload");
  }
  if (!entry.limits) {
    throw new MissingModelExecutionLimitsError(normalizedId, catalog.catalogVersion, "missing-limits");
  }
  return {
    catalogVersion: catalog.catalogVersion,
    contextTokens: entry.limits.contextTokens,
    outputTokens: entry.limits.outputTokens,
  };
}

function staticContextTokenLimit(modelId: string, options?: ResolveOptions): number {
  const normalizedId = modelId.toLowerCase();
  const builtin = NAUTILO_BUILTIN_CONTEXT_TOKENS[normalizedId];
  if (builtin !== undefined) return builtin;
  return MODEL_CLASS_TO_LIMIT[resolveModelClass(modelId, options)];
}

/** Descriptive-only projection for non-catalog UI rows; never use for execution. */
export function getDescriptiveModelContextTokens(modelId: string, options?: ResolveOptions): number {
  return staticContextTokenLimit(modelId, options);
}

function positiveIntegerOverride(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function classCeilingAtLeast(tokens: number): ModelClass {
  const ordered: ModelClass[] = [
    "4K",
    "32K",
    "128K",
    "160K",
    "200K",
    "256K",
    "400K",
    "512K",
    "1M",
    "2M",
    "10M",
  ];
  for (const c of ordered) {
    if (MODEL_CLASS_TO_LIMIT[c] >= tokens) return c;
  }
  return "10M";
}

export function resolveModelClass(modelId: string, options?: ResolveOptions): ModelClass {
  const id = modelId.toLowerCase();

  const override = MODEL_TOKEN_OVERRIDES[id];
  if (typeof override === "number" && override > 0) {
    return classCeilingAtLeast(override);
  }

  // Venice provider branch must come first so substrings like "claude", "gpt",
  // "grok", "kimi", "gemini" in re-hosted Venice model IDs don't get captured
  // by the other-provider branches below. Ordering within this block also
  // matters: more specific substrings (e.g. "glm-5-1", "v3.2", "kimi-k2-thinking",
  // "glm-4.7-flash") must be checked before their generic counterparts.
  if (id.startsWith(VENICE_PROVIDER_PREFIX)) {
    // E2EE family — specific IDs first, then a conservative prefix fallback
    if (id.includes("e2ee-deepseek-v4-flash")) return "1M";
    if (id.includes("e2ee-qwen3-vl-30b-a3b")) return "128K";
    if (id.includes("e2ee-qwen3-30b-a3b")) return "256K";
    if (id.includes("e2ee-qwen-2-5-7b")) return "32K";
    if (id.includes("e2ee-glm-5")) return "200K";
    if (id.includes("e2ee-glm-4-7-flash")) return "200K"; // before e2ee-glm-4-7
    if (id.includes("e2ee-glm-4-7")) return "128K";
    if (id.includes("e2ee-gpt-oss-120b")) return "128K";
    if (id.includes("e2ee-gpt-oss-20b")) return "128K";
    if (id.includes("e2ee-gemma-3-27b")) return "32K"; // availableContextTokens=40K → 32K bucket
    if (id.includes("e2ee-venice-uncensored")) return "32K";
    if (id.includes("venice:e2ee-") || id.startsWith("venice:e2ee-")) return "128K"; // conservative fallback

    // GLM family — 5-1 before 5, flash before non-flash
    if (id.includes("zai-org-glm-5-1")) return "200K";
    if (id.includes("zai-org-glm-5")) return "200K";
    if (id.includes("zai-org-glm-4.7-flash") || id.includes("zai-org-glm-4-7-flash")) return "128K";
    if (id.includes("zai-org-glm-4.7") || id.includes("zai-org-glm-4-7")) return "200K";
    if (id.includes("zai-org-glm-4.6") || id.includes("zai-org-glm-4-6")) return "200K";
    if (id.includes("glm-4.7-flash-heretic") || id.includes("glm-4-7-flash-heretic")) return "200K";

    // Kimi family — "thinking" before generic k2-*
    if (id.includes("kimi-k2-thinking")) return "256K";
    if (id.includes("kimi-k3")) return "1M";
    if (id.includes("kimi-k2-6")) return "256K";
    if (id.includes("kimi-k2-5")) return "256K";

    // MiniMax M2.7 anonymized — 198K context
    if (id.includes("minimax-m27")) return "200K";

    // Curated May-2026 anonymized / upstream SKUs (before generic DeepSeek / GPT substrings)
    if (id.includes("deepseek-v4")) return "1M";
    if (id.includes("claude-opus-4-7")) return "1M";
    if (id.includes("claude-sonnet-4-6") || id.includes("claude-sonnet-5")) return "1M";
    if (id.includes("gemini-3-1-pro-preview")) return "1M";
    if (id.includes("openai-gpt-55-pro")) return "1M";
    if (id.includes("qwen-3-6-plus")) return "1M";

    // DeepSeek — v3.2 before v3
    if (id.includes("deepseek-v3.2") || id.includes("deepseek-v3-2")) return "160K";
    if (id.includes("deepseek-v3")) return "128K";

    // Qwen 3 family — specific SKUs before generic
    if (id.includes("qwen3-next-80b")) return "256K";
    if (id.includes("qwen3-coder-480b")) return "256K";
    if (id.includes("qwen3-vl-235b")) return "256K";
    if (id.includes("qwen3-5-35b")) return "256K";
    if (id.includes("qwen3-5-9b")) return "256K";
    if (id.includes("qwen3-235b-a22b-thinking")) return "128K";
    if (id.includes("qwen3-235b-a22b-instruct")) return "128K";

    // Grok (2M context on 4-20 series; 1M on 4.1-fast)
    if (id.includes("grok-4-20")) return "2M";
    if (id.includes("grok-41-fast") || id.includes("grok-4-1-fast")) return "1M";

    // Llama / Hermes
    if (id.includes("llama-3.3-70b") || id.includes("llama-3-3-70b")) return "128K";
    if (id.includes("llama-3.2-3b") || id.includes("llama-3-2-3b")) return "128K";
    if (id.includes("hermes-3-llama-3.1-405b") || id.includes("hermes-3-llama-3-1-405b")) return "128K";

    // Mistral
    if (id.includes("mistral-small-3-2-24b")) return "256K";
    if (id.includes("mistral-small-2603") || id.includes("mistral-small-4")) return "256K";

    // Google Gemma (Venice-hosted Private variants)
    if (id.includes("google-gemma-4-26b") || id.includes("google-gemma-4-31b")) return "256K";
    if (id.includes("google-gemma-3-27b")) return "200K";

    // NVIDIA Nemotron
    if (id.includes("nemotron-cascade-2")) return "256K";
    if (id.includes("nemotron-3-nano")) return "128K";

    // Arcee Trinity
    if (id.includes("arcee-trinity")) return "256K";

    // OpenAI GPT-OSS Private on Venice (distinct from the e2ee- variants above)
    if (id.includes("openai-gpt-oss-120b") || id.includes("openai-gpt-oss-20b")) return "128K";

    // Venice-native uncensored — specific before generic
    if (id.includes("venice-uncensored-role-play")) return "128K";
    if (id.includes("venice-uncensored-1-2")) return "128K";
    if (id.includes("venice-uncensored")) return "32K";

    // Conservative fallback for unrecognized Venice SKUs
    return "128K";
  }

  if (id.startsWith("openai:")) {
    if (id.includes("gpt-5-mini")) return "200K";
    if (id.includes("gpt-5-nano")) return "128K";
    if (id.includes("gpt-5")) return "1M";
    if (id.includes("gpt-4.1")) return "1M";
    if (id.includes("o3")) return "200K";
    if (id.includes("o1")) return "200K";
    if (id.includes("gpt-4o")) return "128K";
    return "128K";
  }

  if (id.startsWith("anthropic:") || id.includes("claude")) {
    if (id.includes("sonnet-4-6")) return "1M";
    if (id.includes("claude-fable-5") || id.includes("fable-5")) return "1M";
    if (id.includes("claude-opus-5")) return "1M";
    if (id.includes("opus-4-8")) return "1M";
    if (id.includes("opus-4-7")) return "1M";
    if (id.includes("opus-4-6")) return "1M";
    if (id.includes("opus-4.1") || id.includes("opus-4-1")) return "1M";
    if (id.includes("sonnet-4")) {
      return options?.anthropicLongContextBeta ? "1M" : "200K";
    }
    if (id.includes("opus-4") || id.includes("3-5") || id.includes("3-")) return "200K";
    return "200K";
  }

  if (id.startsWith("google") || id.includes("gemini")) {
    if (id.includes("2.0-pro-experimental")) return "2M";
    if (id.includes("gemini-3")) return "1M";
    if (id.includes("2.5") || id.includes("2.0")) return "1M";
    if (id.includes("1.5-pro")) return "2M";
    if (id.includes("1.5")) return "1M";
    return "1M";
  }

  if (id.startsWith("xai:") || id.includes("grok")) {
    if (id.includes("grok-4-0709") || id.includes("grok-code-fast-1")) return "256K";
    if (id.includes("grok-4-fast-reasoning") || id.includes("grok-4-fast-non-reasoning")) return "2M";
    return "256K";
  }

  if (id.startsWith("fireworks:") || id.includes("accounts/fireworks/models/")) {
    if (id.includes("gemma-4")) return "256K";
    if (id.includes("llama4-maverick-instruct-basic") || id.includes("llama4-scout-instruct-basic")) return "1M";
    if (id.includes("deepseek-v3p1") || id.includes("deepseek-v3-0324")) return "200K";
    if (id.includes("deepseek-v3")) return "128K";
    if (id.includes("deepseek-r1")) return "200K";
    if (id.includes("qwen3-235b-a22b-thinking-2507") || id.includes("qwen3-235b-a22b-instruct-2507")) return "256K";
    if (id.includes("qwen3-235b-a22b")) return "128K";
    if (id.includes("qwen3-30b-a3b-instruct-2507") || id.includes("qwen3-coder-30b-a3b-instruct")) return "256K";
    if (id.includes("qwen3-30b-a3b-thinking-2507")) return "256K";
    if (id.includes("qwen3-coder-480b-a35b-instruct")) return "256K";
    if (id.includes("qwen3-embedding-8b")) return "32K";
    if (id.includes("qwen2p5-vl-32b-instruct")) return "128K";
    if (id.includes("glm-5p2")) return "2M";
    if (id.includes("glm-5p1")) return "256K";
    if (id.includes("glm-5")) return "256K";
    if (id.includes("glm-4p5-air") || id.includes("glm-4p5")) return "128K";
    if (id.includes("gpt-oss-120b") || id.includes("gpt-oss-20b")) return "128K";
    if (id.includes("kimi-k2p6")) return "256K";
    if (id.includes("kimi-k2p5")) return "256K";
    if (id.includes("kimi-k2-instruct-0905")) return "256K";
    if (id.includes("kimi-k2-instruct")) return "128K";
    if (id.includes("minimax-m3")) return "512K";
    if (id.includes("mixtral-8x22b-instruct")) return "32K";
    if (
      id.includes("llama-v3p1-405b-instruct") ||
      id.includes("llama-v3p1-70b-instruct") ||
      id.includes("llama-v3p1-8b-instruct") ||
      id.includes("llama-v3p3-70b-instruct")
    ) {
      return "128K";
    }
    return "256K";
  }

  if (id.startsWith("openrouter:")) {
    if (id.includes("google/gemma-4")) return "256K";
    if (id.includes("moonshotai") && id.includes("kimi-k2.6")) return "256K";
    return "128K";
  }

  if (id.includes("kimi") || id.includes("k2") || id.includes("moonshot")) return "256K";

  if (id.startsWith("qwen:") || id.includes("qwen3")) {
    if (id.includes("30b") || id.includes("a3b") || id.includes("2507")) return "256K";
    if (id.includes("8b")) return "128K";
    return "256K";
  }

  if (id.startsWith("cohere:")) return "128K";

  return "128K";
}

export function getModelTokenLimit(modelId: string, options?: ResolveOptions): number {
  const catalogLimit = requireActiveCatalogLimitSnapshot(modelId).contextTokens;
  const id = modelId.toLowerCase();
  const override = positiveIntegerOverride(options?.contextTokenOverride)
    ?? positiveIntegerOverride(MODEL_TOKEN_OVERRIDES[id]);
  return override === undefined ? catalogLimit : Math.min(catalogLimit, override);
}

export function modelSupportsInput(modelId: string, capability: ModelInputCapability): boolean {
  if (capability === "text") return true;
  if (capability !== "image") return false;
  return catalogSupportsInput(modelId, "image");
}

type ModelProvider = "anthropic" | "openai" | "google" | "xai" | "fireworks" | "openrouter" | "other";

/**
 * Venice-specific output-token limits. Checked ONLY when the model ID has the
 * `venice:` prefix, via `veniceOutputLimit()` below. Keeping these in their
 * own pattern table (rather than in `STATIC_OUTPUT_LIMIT_RULES`) prevents
 * cross-provider substring leakage — e.g. a "kimi-k2-thinking" substring rule
 * written in the shared table would incorrectly match Fireworks-hosted Kimi
 * K2 Thinking too. By short-circuiting on the `venice:` prefix we get strict
 * provider isolation for Venice's rules, symmetric with `resolveModelClass`
 * and `inferModelProvider`.
 *
 * Ordering within this table matters: more specific substrings before
 * generic ones (e.g. `e2ee-glm-4-7-flash` before `e2ee-glm-4-7`).
 */
const VENICE_OUTPUT_LIMIT_RULES: ReadonlyArray<readonly [pattern: string, limit: number]> = [
  // E2EE chat-only — 4K (most conservative; smallest context windows)
  ["e2ee-venice-uncensored", 4_096],
  ["e2ee-qwen-2-5-7b", 4_096],
  ["e2ee-gemma-3-27b", 4_096],
  ["e2ee-glm-4-7-flash", 4_096], // before e2ee-glm-4-7 (not strictly necessary here since both are 4K/8K tiers but kept for ordering consistency with resolveModelClass)
  // E2EE reasoning — 8K
  ["e2ee-glm-5", 8_192],
  ["e2ee-glm-4-7-p", 8_192],
  ["e2ee-gpt-oss-120b-p", 8_192],
  ["e2ee-gpt-oss-20b-p", 8_192],
  // E2EE tool-capable — 8K
  ["e2ee-deepseek-v4-flash", 8_192],
  ["e2ee-qwen3-vl-30b-a3b", 8_192],
  ["e2ee-qwen3-30b-a3b", 8_192],
  // Private reasoning-capable — 16K (GLM 5-1 before 5; Kimi "thinking" before k2-5/6)
  ["zai-org-glm-5-1", 16_384],
  ["zai-org-glm-5", 16_384],
  ["kimi-k2-thinking", 16_384],
  ["kimi-k2-5", 16_384],
  ["kimi-k2-6", 16_384],
  ["kimi-k3", 131_072],
  ["qwen3-235b-a22b-thinking", 16_384],
  ["minimax-m27", 16_384],
  ["arcee-trinity-large-thinking", 16_384],
  // Private large-context — 16K
  ["grok-4-20", 16_384],
  ["grok-41-fast", 16_384],
  ["grok-4-1-fast", 16_384],
  // Private standard — 8K (venice-uncensored variants, GLM 4.x, DeepSeek, Qwen, Llama, Hermes, Mistral, Gemma, Nemotron, GPT-OSS Private)
  ["venice-uncensored", 8_192],
  ["zai-org-glm-4", 8_192],
  ["olafangensan-glm-4", 8_192],
  ["deepseek-v4", 32_768],
  ["claude-opus-4-7", 128_000],
  ["claude-sonnet-4-6", 128_000],
  ["gemini-3-1-pro-preview", 65_536],
  ["openai-gpt-55-pro", 128_000],
  ["qwen-3-6-plus", 65_536],
  ["deepseek-v3", 8_192],
  ["qwen3-next-80b", 8_192],
  ["qwen3-coder-480b", 8_192],
  ["qwen3-vl-235b", 8_192],
  ["qwen3-5-35b", 8_192],
  ["qwen3-5-9b", 8_192],
  ["qwen3-235b-a22b-instruct", 8_192],
  ["llama-3.3-70b", 8_192],
  ["llama-3-3-70b", 8_192],
  ["llama-3.2-3b", 8_192],
  ["llama-3-2-3b", 8_192],
  ["hermes-3-llama", 8_192],
  ["mistral-small", 8_192],
  ["google-gemma", 8_192],
  ["nemotron", 8_192],
  ["openai-gpt-oss", 8_192],
];

/** Conservative fallback for unrecognized Venice SKUs. */
const VENICE_OUTPUT_LIMIT_DEFAULT = 8_192;

function veniceOutputLimit(idLower: string): number {
  for (const [pattern, limit] of VENICE_OUTPUT_LIMIT_RULES) {
    if (idLower.includes(pattern)) return limit;
  }
  return VENICE_OUTPUT_LIMIT_DEFAULT;
}

const STATIC_OUTPUT_LIMIT_RULES: Array<{ test: (id: string) => boolean; limit: number }> = [
  { test: (id) => id.includes("claude-opus-4-8"), limit: 128_000 },
  { test: (id) => id.includes("claude-opus-5"), limit: 128_000 },
  { test: (id) => id.includes("claude-opus-4-7"), limit: 128_000 },
  { test: (id) => id.includes("claude-opus-4-6"), limit: 128_000 },
  { test: (id) => id.includes("claude-sonnet-4-6"), limit: 128_000 },
  { test: (id) => id.includes("claude-sonnet-5"), limit: 128_000 },
  { test: (id) => id.includes("claude-fable-5"), limit: 128_000 },
  { test: (id) => id.includes("claude-sonnet-4"), limit: 16_384 },
  { test: (id) => id.includes("claude-opus-4"), limit: 16_384 },
  { test: (id) => id.includes("claude-3-5"), limit: 8_192 },
  { test: (id) => id.includes("claude-3-"), limit: 8_192 },
  { test: (id) => id.includes("claude") && id.includes("haiku"), limit: 4_096 },
  { test: (id) => id.includes("gpt-5-mini"), limit: 128_000 },
  { test: (id) => id.includes("gpt-5-nano"), limit: 8_192 },
  { test: (id) => id.includes("gpt-5"), limit: 128_000 },
  { test: (id) => id.includes("gpt-4.1"), limit: 32_768 },
  { test: (id) => id.includes("gpt-4o"), limit: 16_384 },
  { test: (id) => id.includes("gemini-3"), limit: 65_536 },
  { test: (id) => id.includes("gemini-2.5"), limit: 65_536 },
  { test: (id) => id.includes("gemini-2.0"), limit: 32_768 },
  { test: (id) => id.includes("gemini-1.5-pro"), limit: 32_768 },
  { test: (id) => id.includes("gemini-1.5"), limit: 16_384 },
  { test: (id) => id.includes("grok-4"), limit: 8_192 },
  { test: (id) => id.includes("grok-1"), limit: 8_192 },
  { test: (id) => id.includes("llama4") && id.includes("instruct"), limit: 16_384 },
  { test: (id) => id.includes("llama-v3p1"), limit: 16_384 },
  { test: (id) => id.includes("qwen3-235b"), limit: 16_384 },
  { test: (id) => id.includes("qwen3-30b"), limit: 16_384 },
  { test: (id) => id.includes("openrouter") && id.includes("glm-5.1"), limit: 65_535 },
  { test: (id) => id.includes("fireworks") && id.includes("glm-5p2"), limit: 1_040_000 },
  { test: (id) => id.includes("fireworks") && id.includes("glm-5p1"), limit: 202_752 },
  { test: (id) => id.includes("fireworks") && id.includes("glm-5") && !id.includes("glm-5p1"), limit: 202_752 },
  { test: (id) => id.includes("openrouter") && id.includes("deepseek-v4-pro"), limit: 384_000 },
  { test: (id) => id.includes("openrouter") && id.includes("moonshotai") && id.includes("kimi-k2.6"), limit: 262_142 },
  { test: (id) => id.includes("openrouter") && id.includes("minimax-m2.7"), limit: 196_607 },
  { test: (id) => id.includes("fireworks") && id.includes("kimi-k2p6"), limit: 262_144 },
  { test: (id) => id.includes("fireworks") && id.includes("minimax-m3"), limit: 512_000 },
  { test: (id) => id.includes("fireworks") && id.includes("minimax-m2p7"), limit: 196_608 },
  { test: (id) => id.includes("fireworks") && id.includes("deepseek-v4-pro-0813"), limit: 1_040_000 },
  { test: (id) => id.includes("fireworks") && id.includes("deepseek-v4-pro"), limit: 1_048_576 },
  { test: (id) => id.includes("fireworks") && id.includes("deepseek-v4-flash-0731"), limit: 1_040_000 },
  { test: (id) => id.includes("deepseek-v3"), limit: 12_288 },
  { test: () => true, limit: DEFAULT_OUTPUT_TOKEN_LIMIT },
];

function stripProviderPrefix(modelId: string): string {
  return modelId.includes(":") ? modelId.split(":").slice(1).join(":") : modelId;
}

const VENICE_PROVIDER_PREFIX = "venice:";

function inferModelProvider(modelId: string): ModelProvider {
  const id = modelId.toLowerCase();
  // Venice must short-circuit before any substring-based provider matches —
  // models like venice:e2ee-gpt-oss-120b-p or venice:claude-opus-4-7 would
  // otherwise route to "openai" / "anthropic" output-limit fetchers and
  // issue 404-ing API calls with the wrong credentials.
  if (id.startsWith(VENICE_PROVIDER_PREFIX)) return "other";
  if (id.startsWith("openrouter:")) return "openrouter";
  if (id.startsWith("fireworks:") || id.includes("accounts/fireworks/models/")) return "fireworks";
  if (id.startsWith("openai:") || id.includes("gpt-")) return "openai";
  if (id.startsWith("anthropic:") || id.includes("claude")) return "anthropic";
  if (id.startsWith("google") || id.includes("gemini")) return "google";
  if (id.startsWith("xai:") || id.includes("grok")) return "xai";
  return "other";
}

function staticOutputLimitForModel(modelIdLower: string): number | undefined {
  // Venice short-circuit: keeps Venice rules from colliding with the shared
  // substring table (e.g. a stray "kimi-k2-thinking" rule written without a
  // venice guard would otherwise match Fireworks-hosted Kimi too). Symmetric
  // with resolveModelClass and inferModelProvider.
  if (modelIdLower.startsWith(VENICE_PROVIDER_PREFIX)) {
    return veniceOutputLimit(modelIdLower);
  }
  const builtin = NAUTILO_BUILTIN_OUTPUT_TOKENS[modelIdLower];
  if (builtin !== undefined) return builtin;
  for (const rule of STATIC_OUTPUT_LIMIT_RULES) {
    if (rule.test(modelIdLower)) {
      return rule.limit;
    }
  }
  return undefined;
}

/**
 * Return a checked-in output limit only when a model matches an explicit
 * static rule. Unlike {@link getModelMaxOutputTokens}, this helper never
 * fetches provider APIs and deliberately does not apply the generic fallback:
 * callers can distinguish a known limit from an unknown/dynamic model.
 *
 * This powers D429's synchronous resolved catalog projection. It reuses the
 * existing static rule tables rather than maintaining a second limit catalog.
 */
export function getKnownModelMaxOutputTokens(modelId: string): number | null {
  const normalizedId = modelId.trim().toLowerCase();
  if (!normalizedId) return null;

  const override = getModelOutputOverride(normalizedId);
  if (override) return override;

  const builtin = NAUTILO_BUILTIN_OUTPUT_TOKENS[normalizedId];
  if (builtin !== undefined) return builtin;

  if (normalizedId.startsWith(VENICE_PROVIDER_PREFIX)) {
    for (const [pattern, limit] of VENICE_OUTPUT_LIMIT_RULES) {
      if (normalizedId.includes(pattern)) return limit;
    }
    return null;
  }

  // The final static rule is the async helper's generic 8K fallback. Exclude
  // it here so arbitrary dynamic IDs remain unknown (`null`) in the catalog.
  for (const rule of STATIC_OUTPUT_LIMIT_RULES.slice(0, -1)) {
    if (rule.test(normalizedId)) return rule.limit;
  }
  return null;
}

function sanitizeOutputLimit(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function getModelOutputOverride(modelId: string): number | undefined {
  const override = MODEL_OUTPUT_TOKEN_OVERRIDES[modelId.toLowerCase()];
  if (typeof override === "number" && override > 0) {
    return override;
  }
  return undefined;
}

function buildOutputCacheKey(modelId: string, options?: ResolveOptions): string {
  const parts = [modelId.toLowerCase()];
  if (options?.anthropicLongContextBeta) {
    parts.push("anthropicLongContextBeta");
  }
  return parts.join("|");
}

async function fetchAnthropicOutputLimit(
  modelId: string,
  options?: ResolveOptions,
): Promise<number | undefined> {
  if (typeof process === "undefined") return undefined;
  const apiKey = process.env?.["ANTHROPIC_API_KEY"];
  if (!apiKey) return undefined;
  const baseUrl = process.env?.["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com";
  const modelName = stripProviderPrefix(modelId);
  const url = `${baseUrl.replace(/\/$/, "")}/v1/models/${encodeURIComponent(modelName)}`;
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  if (options?.anthropicLongContextBeta) {
    headers["anthropic-beta"] = "context-1m-2025-08-07";
  }
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      logWarn(`[models] Failed to fetch Anthropic model capabilities (status ${response.status})`);
      return undefined;
    }
    const data = (await response.json()) as Record<string, unknown>;
    return (
      sanitizeOutputLimit(data["default_output_tokens"]) ??
      sanitizeOutputLimit(data["max_output_tokens"]) ??
      sanitizeOutputLimit(data["max_tokens"]) ??
      sanitizeOutputLimit(
        (data["capabilities"] as Record<string, unknown> | undefined)?.["max_output_tokens"],
      )
    );
  } catch (error) {
    logWarn("[models] Error fetching Anthropic model capabilities",
      error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

async function fetchOpenAIOutputLimit(modelId: string): Promise<number | undefined> {
  if (typeof process === "undefined") return undefined;
  const apiKey = process.env?.["OPENAI_API_KEY"];
  if (!apiKey) return undefined;
  const baseUrl = process.env?.["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1";
  const modelName = stripProviderPrefix(modelId);
  const url = `${baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(modelName)}`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      logWarn(`[models] Failed to fetch OpenAI model capabilities (status ${response.status})`);
      return undefined;
    }
    const data = (await response.json()) as Record<string, unknown>;
    const capabilities = data["capabilities"] as Record<string, unknown> | undefined;
    const completionCaps =
      (capabilities?.["completion"] as Record<string, unknown> | undefined) ??
      (capabilities?.["completions"] as Record<string, unknown> | undefined);
    return (
      sanitizeOutputLimit(completionCaps?.["max_output_tokens"]) ??
      sanitizeOutputLimit(completionCaps?.["maxOutputTokens"]) ??
      sanitizeOutputLimit(data["max_output_tokens"]) ??
      sanitizeOutputLimit(data["output_token_limit"])
    );
  } catch (error) {
    logWarn("[models] Error fetching OpenAI model capabilities",
      error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

async function fetchGoogleOutputLimit(modelId: string): Promise<number | undefined> {
  if (typeof process === "undefined") return undefined;
  const apiKey = process.env?.["GOOGLE_API_KEY"];
  if (!apiKey) return undefined;
  const baseUrl =
    process.env?.["GOOGLE_GENAI_API_BASE_URL"] ?? "https://generativelanguage.googleapis.com/v1beta";
  const modelName = stripProviderPrefix(modelId);
  const url = `${baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(modelName)}?key=${apiKey}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      logWarn(`[models] Failed to fetch Google model capabilities (status ${response.status})`);
      return undefined;
    }
    const data = (await response.json()) as Record<string, unknown>;
    return (
      sanitizeOutputLimit(data["outputTokenLimit"]) ??
      sanitizeOutputLimit(data["output_token_limit"]) ??
      sanitizeOutputLimit((data["capabilities"] as Record<string, unknown> | undefined)?.["output"])
    );
  } catch (error) {
    logWarn("[models] Error fetching Google model capabilities",
      error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

async function resolveProviderOutputLimit(
  modelId: string,
  provider: ModelProvider,
  options?: ResolveOptions,
): Promise<number | undefined> {
  switch (provider) {
    case "anthropic":
      return fetchAnthropicOutputLimit(modelId, options);
    case "openai":
      return fetchOpenAIOutputLimit(modelId);
    case "google":
      return fetchGoogleOutputLimit(modelId);
    default:
      return undefined;
  }
}

export async function getModelMaxOutputTokens(
  modelId: string,
  options?: ResolveOptions,
): Promise<number> {
  return (await resolveModelExecutionLimits(modelId, options)).maxOutputTokens;
}

export async function discoverModelOutputTokenLimit(
  normalizedId: string,
  options?: ResolveOptions,
): Promise<{ limit: number; source: ResolvedModelExecutionLimits["outputSource"] }> {
  const cacheKey = buildOutputCacheKey(normalizedId, options);
  const cached = OUTPUT_LIMIT_CACHE.get(cacheKey);
  if (cached) {
    logInfo("[models] Output token limit cache hit", cacheKey, cached);
    return { limit: cached, source: OUTPUT_LIMIT_SOURCE_CACHE.get(cacheKey) ?? "default" };
  }

  const pending = OUTPUT_LIMIT_PENDING.get(cacheKey);
  if (pending) {
    const limit = await pending;
    return { limit, source: OUTPUT_LIMIT_SOURCE_CACHE.get(cacheKey) ?? "default" };
  }

  let resolvedSource: ResolvedModelExecutionLimits["outputSource"] = "default";
  const resolver = (async () => {
    try {
      const provider = inferModelProvider(normalizedId);
      const providerLimit = await resolveProviderOutputLimit(normalizedId, provider, options);
      const staticLimit = staticOutputLimitForModel(normalizedId.toLowerCase());
      const resolved = providerLimit ?? staticLimit ?? DEFAULT_OUTPUT_TOKEN_LIMIT;
      resolvedSource = providerLimit != null ? "provider" : staticLimit != null ? "static" : "default";
      OUTPUT_LIMIT_CACHE.set(cacheKey, resolved);
      OUTPUT_LIMIT_SOURCE_CACHE.set(cacheKey, resolvedSource);
      logInfo("[models] Resolved output token limit", normalizedId, resolved, resolvedSource);
      return resolved;
    } catch (error) {
      logWarn("[models] Unexpected error resolving model output limit",
        error instanceof Error ? error.message : String(error));
      OUTPUT_LIMIT_CACHE.set(cacheKey, DEFAULT_OUTPUT_TOKEN_LIMIT);
      OUTPUT_LIMIT_SOURCE_CACHE.set(cacheKey, "default");
      resolvedSource = "default";
      return DEFAULT_OUTPUT_TOKEN_LIMIT;
    } finally {
      OUTPUT_LIMIT_PENDING.delete(cacheKey);
    }
  })();

  OUTPUT_LIMIT_PENDING.set(cacheKey, resolver);
  return { limit: await resolver, source: resolvedSource };
}

/**
 * Resolve one immutable execution-limit tuple from one atomic signed-catalog
 * snapshot. The signed per-model values are the hard capability ceilings.
 * Explicit per-model deployment values may request less, but can never raise
 * those ceilings. Unknown and incomplete chat routes fail closed so a catalog
 * omission cannot silently become a generic runtime limit.
 */
function resolveModelExecutionLimitsSync(
  modelId: string,
  options?: ResolveOptions,
): ResolvedModelExecutionLimits {
  const normalizedId = modelId.trim();
  const normalizedLower = normalizedId.toLowerCase();
  const catalogLimits = requireActiveCatalogLimitSnapshot(normalizedId);
  const contextOverride = positiveIntegerOverride(options?.contextTokenOverride)
    ?? MODEL_TOKEN_OVERRIDES[normalizedLower];
  const outputOverride = positiveIntegerOverride(options?.outputTokenOverride)
    ?? getModelOutputOverride(normalizedLower);
  const contextTokens = contextOverride === undefined
    ? catalogLimits.contextTokens
    : Math.min(catalogLimits.contextTokens, contextOverride);
  const maxOutputTokens = Math.min(
    catalogLimits.outputTokens,
    outputOverride ?? Number.POSITIVE_INFINITY,
    contextTokens,
  );
  const contextWasLowered = contextTokens < catalogLimits.contextTokens;
  const outputWasLowered = maxOutputTokens < catalogLimits.outputTokens;

  return {
    modelId: normalizedId,
    catalogVersion: catalogLimits.catalogVersion,
    contextTokens,
    maxOutputTokens,
    contextSource: contextWasLowered ? "override" : "catalog",
    outputSource: outputWasLowered ? "override" : "catalog",
  };
}

export function resolveModelExecutionLimits(
  modelId: string,
  options?: ResolveOptions,
): Promise<ResolvedModelExecutionLimits> {
  return Promise.resolve().then(() => resolveModelExecutionLimitsSync(modelId, options));
}

function parseOverridesJson(json: string): Record<string, number> | null {
  try {
    const obj = JSON.parse(json) as unknown;
    if (obj && typeof obj === "object") {
      const mapped: Record<string, number> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const num = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(num)) continue;
        mapped[k.toLowerCase()] = num;
      }
      return mapped;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

function loadModelOverridesFromEnv(): void {
  let fromEnv: Record<string, number> = {};
  const json = typeof process !== "undefined" ? process.env?.["MODEL_TOKEN_OVERRIDES"] : undefined;
  if (json) {
    const parsed = parseOverridesJson(json);
    if (parsed) fromEnv = parsed;
  }
  if (Object.keys(fromEnv).length === 0) {
    const path = typeof process !== "undefined" ? process.env?.["MODEL_TOKEN_OVERRIDES_PATH"] : undefined;
    if (path && typeof path === "string") {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require("fs") as {
          existsSync: (p: string) => boolean;
          readFileSync: (p: string, e: string) => string;
        };
        if (fs.existsSync(path)) {
          const contents = fs.readFileSync(path, "utf8");
          const parsed = parseOverridesJson(contents);
          if (parsed) fromEnv = parsed;
        }
      } catch {
        // Ignore file read errors
      }
    }
  }
  setModelTokenOverrides(fromEnv);
}

function loadModelOutputOverridesFromEnv(): void {
  let fromEnv: Record<string, number> = {};
  const json = typeof process !== "undefined" ? process.env?.["MODEL_OUTPUT_TOKEN_OVERRIDES"] : undefined;
  if (json) {
    const parsed = parseOverridesJson(json);
    if (parsed) fromEnv = parsed;
  }
  if (Object.keys(fromEnv).length === 0) {
    const path =
      typeof process !== "undefined" ? process.env?.["MODEL_OUTPUT_TOKEN_OVERRIDES_PATH"] : undefined;
    if (path && typeof path === "string") {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require("fs") as {
          existsSync: (p: string) => boolean;
          readFileSync: (p: string, e: string) => string;
        };
        if (fs.existsSync(path)) {
          const contents = fs.readFileSync(path, "utf8");
          const parsed = parseOverridesJson(contents);
          if (parsed) fromEnv = parsed;
        }
      } catch {
        // Ignore file read errors
      }
    }
  }
  setModelOutputTokenOverrides(fromEnv);
}

loadModelOverridesFromEnv();
loadModelOutputOverridesFromEnv();
