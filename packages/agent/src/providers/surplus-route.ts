import { getActiveModelCatalogSync } from "../config/model-catalog/runtime-catalog";

/**
 * A serving mapping is a release decision, not a match from `/v1/models`.
 * Each row must be backed by an exact-model, pinned-provider, feature, and
 * settlement qualification before it is added here. An empty release list is
 * intentional while funded qualification is pending.
 */
export interface QualifiedSurplusChatRoute {
  readonly catalogModelId: string;
  readonly surplusModelId: string;
  readonly providerPin: "anthropic" | "openai" | "google" | "fireworks" | "openrouter" | "venice";
  readonly supportsTools: boolean;
  readonly supportsVision: boolean;
  readonly supportsReasoning: boolean;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly qualifiedAt: string;
}

const QUALIFIED_CHAT_ROUTES: readonly QualifiedSurplusChatRoute[] = Object.freeze([]);

/** Never synthesize a route from a provider prefix, alias, or public market. */
export function resolveQualifiedSurplusChatRoute(
  catalogModelId: string,
  routes: readonly QualifiedSurplusChatRoute[] = QUALIFIED_CHAT_ROUTES,
): QualifiedSurplusChatRoute | null {
  const entry = getActiveModelCatalogSync().catalog.entries.find((row) => row.id === catalogModelId);
  if (!entry || !entry.defaultEnabled) return null;
  const output = entry.modalities?.output;
  const workload = "workload" in entry ? entry.workload : "chat";
  if (workload !== "chat" || (output && !output.includes("text"))) return null;
  if (catalogModelId.includes(":e2ee-") || entry.routing === "china-anonymized") return null;
  const route = routes.find((candidate) => candidate.catalogModelId === catalogModelId);
  if (!route || route.maxContextTokens < 1 || route.maxOutputTokens < 1) return null;
  if (!route.surplusModelId.trim() || !route.qualifiedAt.trim()) return null;
  if (catalogModelId.split(":", 1)[0] !== route.providerPin) return null;
  // The qualified route may narrow signed limits, never broaden them.
  if (entry.limits?.contextTokens && route.maxContextTokens > entry.limits.contextTokens) return null;
  if (entry.limits?.outputTokens && route.maxOutputTokens > entry.limits.outputTokens) return null;
  return route;
}
