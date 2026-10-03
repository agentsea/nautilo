import { getActiveModelCatalogSync } from "../config/model-catalog/runtime-catalog";

/**
 * A serving mapping is a release decision, not a match from `/v1/models`.
 * Each row must be backed by an exact-model, pinned-provider, feature, and
 * settlement qualification before it is added here.
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

const QUALIFIED_CHAT_ROUTES: readonly QualifiedSurplusChatRoute[] = Object.freeze([
  Object.freeze({
    catalogModelId: "openrouter:openai/gpt-5.6-sol",
    surplusModelId: "gpt-5.6-sol",
    providerPin: "openrouter",
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    maxContextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    qualifiedAt: "2026-10-03",
  }),
]);

export type SurplusChatServingStatus = "not-qualified" | "qualified-unavailable" | "available";

export type SurplusChatServingAvailability =
  | { readonly status: "not-qualified"; readonly route: null }
  | { readonly status: "qualified-unavailable" | "available"; readonly route: QualifiedSurplusChatRoute };

export interface ResolveSurplusChatServingAvailabilityInput {
  /** Omit only for the aggregate administrator capability projection. */
  readonly catalogModelId?: string;
  readonly policyEnabled: boolean;
  readonly keyConfigured: boolean;
  readonly fundingKind?: "server" | "personal";
  /** Pure injection seam for offline qualification tests. */
  readonly routes?: readonly QualifiedSurplusChatRoute[];
}

export class SurplusDirectFallbackUnavailableError extends Error {
  readonly code = "surplus_direct_fallback_unavailable" as const;

  constructor(readonly reason: "surplus-unavailable" | "request-not-qualified" = "surplus-unavailable") {
    super(reason === "request-not-qualified"
      ? "This request is outside the selected model's qualified Surplus capability or token limits, and its original provider credential is not configured."
      : "Surplus could not serve the selected model, and its original provider credential is not configured.");
    this.name = "SurplusDirectFallbackUnavailableError";
  }
}

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
  if (!route || !Number.isSafeInteger(route.maxContextTokens) || !Number.isSafeInteger(route.maxOutputTokens)
    || route.maxContextTokens < 1 || route.maxOutputTokens < 1) return null;
  if (!route.surplusModelId.trim() || !route.qualifiedAt.trim()) return null;
  if (catalogModelId.split(":", 1)[0] !== route.providerPin) return null;
  // The qualified route may narrow signed limits, never broaden them.
  if (entry.limits?.contextTokens && route.maxContextTokens > entry.limits.contextTokens) return null;
  if (entry.limits?.outputTokens && route.maxOutputTokens > entry.limits.outputTokens) return null;
  return route;
}

/**
 * One fail-closed projection for released Surplus chat capability. It does not
 * infer mappings from provider names and never treats a key as qualification.
 * Personal funding cannot use the server Surplus credential.
 */
export function resolveSurplusChatServingAvailability(
  input: ResolveSurplusChatServingAvailabilityInput,
): SurplusChatServingAvailability {
  const routes = input.routes ?? QUALIFIED_CHAT_ROUTES;
  const route = input.catalogModelId === undefined
    ? routes.map((candidate) => resolveQualifiedSurplusChatRoute(candidate.catalogModelId, routes))
      .find((candidate): candidate is QualifiedSurplusChatRoute => candidate !== null) ?? null
    : resolveQualifiedSurplusChatRoute(input.catalogModelId, routes);
  if (!route) return { status: "not-qualified", route: null };
  if (input.fundingKind === "personal" || !input.policyEnabled || !input.keyConfigured) {
    return { status: "qualified-unavailable", route };
  }
  return { status: "available", route };
}
