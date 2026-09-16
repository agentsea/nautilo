import { privacyGradeOf } from "./model-privacy";
import { getCostCoefficient, ASSISTANT_MODELS } from "./assistant-models";
import {
  type SelectionProfile,
  type SelectionAxis,
  type ComboSpec,
} from "@nautilo/types";
// D429 Phase 1 — `IntelligenceTier` now lives canonically in `@nautilo/trust`
// (below every consumer) so the resolved catalog type can reference it without
// a cycle. Re-exported here to keep `@nautilo/agent`'s existing import paths
// stable; the unions are structurally identical.
import type { IntelligenceTier } from "@nautilo/trust";
export type { IntelligenceTier };

/** Coarse intelligence tier. Assign EVERY ASSISTANT_MODELS id one bucket (A2). */
export const INTELLIGENCE_RANK: Record<IntelligenceTier, number> = {
  small: 1,
  mid: 2,
  strong: 3,
  frontier: 4,
};

export const MODEL_INTELLIGENCE_TIER: Record<string, IntelligenceTier> = {
  // frontier
  "anthropic:claude-opus-4-8": "frontier",
  "anthropic:claude-opus-4-7": "frontier",
  "openai:gpt-5.6-sol": "frontier",
  "openai:gpt-5.5-2026-04-23": "frontier",
  "anthropic:claude-sonnet-4-6": "frontier",
  "anthropic:claude-sonnet-5": "frontier",
  "anthropic:claude-fable-5": "frontier",
  "anthropic:claude-opus-5": "frontier",
  "google:gemini-3.1-pro-preview": "frontier",
  "venice:claude-opus-4-7": "frontier",
  "venice:openai-gpt-55-pro": "frontier",
  "venice:claude-sonnet-4-6": "frontier",
  "venice:gemini-3-1-pro-preview": "frontier",
  "fireworks:accounts/fireworks/models/minimax-m3": "frontier",
  "fireworks:accounts/fireworks/models/kimi-k3": "frontier",
  // strong
  "openai:gpt-5.6-terra": "strong",
  "openai:gpt-5.4-2026-03-05": "strong",
  "google:gemini-2.5-pro": "strong",
  "fireworks:accounts/fireworks/models/deepseek-v4-pro": "strong",
  "fireworks:accounts/fireworks/models/deepseek-v4-pro-0813": "strong",
  "fireworks:accounts/fireworks/models/deepseek-v4-flash-0731": "strong",
  "openrouter:deepseek/deepseek-v4-pro": "strong",
  "openrouter:deepseek/deepseek-v4-pro-0813": "strong",
  "fireworks:accounts/fireworks/models/kimi-k2p6": "strong",
  "openrouter:moonshotai/kimi-k2.6": "strong",
  "fireworks:accounts/fireworks/models/glm-5p2": "strong",
  "fireworks:accounts/fireworks/models/glm-5p1": "strong",
  "openrouter:z-ai/glm-5.1": "strong",
  "venice:deepseek-v4-pro": "strong",
  "venice:qwen-3-6-plus": "strong",
  "venice:zai-org-glm-5-1": "strong",
  "venice:e2ee-deepseek-v4-flash": "strong",
  "venice:deepseek-v4-flash": "strong",
  "venice:kimi-k3": "strong",
  // mid
  "openrouter:minimax/minimax-m2.7": "mid",
  "openai:gpt-5.6-luna": "mid",
  "google:gemini-3-flash-preview": "mid",
  "google:gemini-3.1-flash-lite-preview": "mid",
  "venice:minimax-m27": "mid",
  // small
  "openrouter:google/gemma-4-31b-it": "small",
  "openrouter:google/gemma-4-26b-a4b-it": "small",
  "venice:google-gemma-4-31b-it": "small",
  "venice:google-gemma-3-27b-it": "small",
  "venice:google-gemma-4-26b-a4b-it": "small",
};
export const DEFAULT_INTELLIGENCE_TIER: IntelligenceTier = "mid";

/**
 * The non-secret intelligence projection supplied by an active resolved
 * catalog row. Keep this deliberately structural: `model-selection` is a
 * dependency of `resolved-catalog`, so importing the resolved-row type here
 * would create a runtime cycle.
 */
export interface ResolvedCatalogIntelligence {
  intelligenceTier?: IntelligenceTier | null;
  intelligenceRank?: number | null;
}

/**
 * Prefer the active catalog's reviewed intelligence assertion when one is
 * available. The static table remains the compatibility fallback for legacy
 * callers and genuinely unknown ids that do not have a resolved catalog row.
 */
export function intelligenceRankOf(
  modelId: string,
  resolved?: ResolvedCatalogIntelligence,
): number {
  if (resolved?.intelligenceRank != null) return resolved.intelligenceRank;
  if (resolved?.intelligenceTier != null) return INTELLIGENCE_RANK[resolved.intelligenceTier];
  return INTELLIGENCE_RANK[MODEL_INTELLIGENCE_TIER[modelId] ?? DEFAULT_INTELLIGENCE_TIER];
}

/**
 * Band constants (A5).
 *  - PRIVACY: ABSOLUTE categorical floor (provider trust is stable).
 *  - SMART:   RELATIVE — keep models within this many tiers of the best eligible.
 *  - CHEAP:   RELATIVE — keep models within this cost multiple of the cheapest eligible.
 */
export const PRIVACY_FLOOR_GRADE = 4;
export const SMART_BAND_TOLERANCE = 1;
export const CHEAP_BAND_FACTOR = 1.5;

/** profile → ComboSpec. `balanced` is a sentinel handled by the resolver. */
export const COMBO_SPECS: Record<Exclude<SelectionProfile, "balanced">, ComboSpec> = {
  most_private: { objective: "privacy" },
  smartest: { objective: "smart" },
  cheapest: { objective: "cheap" },
  private_cheap: { band: "privacy", objective: "cheap" },
  private_smart: { band: "privacy", objective: "smart" },
  cheap_private: { band: "cheap", objective: "privacy" },
  cheap_smart: { band: "cheap", objective: "smart" },
  smart_private: { band: "smart", objective: "privacy" },
  smart_cheap: { band: "smart", objective: "cheap" },
};

export interface ModelAxes {
  privacy: number;
  smart: number;
  cost: number;
}
export function modelAxesOf(
  modelId: string,
  resolved?: ResolvedCatalogIntelligence,
): ModelAxes {
  return {
    privacy: privacyGradeOf(modelId),
    smart: intelligenceRankOf(modelId, resolved),
    cost: getCostCoefficient(modelId),
  };
}

/** Human-readable view: every catalog model with all three axes side by side. */
export function selectionTable(): Array<{ id: string; tier: IntelligenceTier } & ModelAxes> {
  return ASSISTANT_MODELS.map((m) => ({
    id: m.id,
    tier: MODEL_INTELLIGENCE_TIER[m.id] ?? DEFAULT_INTELLIGENCE_TIER,
    ...modelAxesOf(m.id),
  }));
}

export type { SelectionProfile, SelectionAxis, ComboSpec };
