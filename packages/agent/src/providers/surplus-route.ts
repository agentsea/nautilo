import type { ModelCatalogEntry } from "@nautilo/types";
import { getActiveModelCatalogSync } from "../config/model-catalog/runtime-catalog";

export type SurplusProviderPin =
  | "anthropic"
  | "openai"
  | "google-ai-studio"
  | "fireworks"
  | "openrouter"
  | "together"
  | "venice";

/** The name is retained for compatibility with the serving and receipt layers. */
export interface QualifiedSurplusChatRoute {
  readonly catalogModelId: string;
  readonly surplusModelId: string;
  readonly providerPin: SurplusProviderPin;
  readonly supportsTools: boolean;
  readonly supportsVision: boolean;
  readonly supportsReasoning: boolean;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
}

const SURPLUS_PROVIDER_PINS = Object.freeze({
  anthropic: "anthropic",
  openai: "openai",
  google: "google-ai-studio",
  fireworks: "fireworks",
  openrouter: "openrouter",
  together: "together",
  venice: "venice",
} satisfies Readonly<Record<string, SurplusProviderPin>>);

function providerPinForCatalogEntry(entry: ModelCatalogEntry): SurplusProviderPin | null {
  return SURPLUS_PROVIDER_PINS[entry.provider as keyof typeof SURPLUS_PROVIDER_PINS] ?? null;
}

function isEligibleSignedChatEntry(entry: ModelCatalogEntry): boolean {
  const workload = "workload" in entry ? entry.workload : "chat";
  return entry.defaultEnabled
    && workload === "chat"
    && (entry.modalities?.output?.includes("text") ?? true)
    && !entry.id.includes(":e2ee-")
    && entry.privacy.label !== "e2ee"
    && entry.routing !== "china-anonymized";
}

function deriveRoute(entry: ModelCatalogEntry): QualifiedSurplusChatRoute | null {
  const providerPin = providerPinForCatalogEntry(entry);
  const separator = entry.id.indexOf(":");
  const surplusModelId = separator < 1 ? "" : entry.id.slice(separator + 1);
  const maxContextTokens = entry.limits?.contextTokens;
  const maxOutputTokens = entry.limits?.outputTokens;
  if (!providerPin || !surplusModelId || !isEligibleSignedChatEntry(entry)
    || !Number.isSafeInteger(maxContextTokens) || !Number.isSafeInteger(maxOutputTokens)
    || (maxContextTokens ?? 0) < 1 || (maxOutputTokens ?? 0) < 1) return null;
  return Object.freeze({
    catalogModelId: entry.id,
    surplusModelId,
    providerPin,
    supportsTools: entry.features?.tools === true,
    supportsVision: entry.modalities?.input?.includes("image") === true,
    supportsReasoning: entry.features?.reasoning === true,
    maxContextTokens: maxContextTokens!,
    maxOutputTokens: maxOutputTokens!,
  });
}

function validateInjectedRoute(
  entry: ModelCatalogEntry,
  route: QualifiedSurplusChatRoute,
): QualifiedSurplusChatRoute | null {
  const expectedProviderPin = providerPinForCatalogEntry(entry);
  if (!isEligibleSignedChatEntry(entry) || !expectedProviderPin) return null;
  if (route.providerPin !== expectedProviderPin) return null;
  if (!Number.isSafeInteger(route.maxContextTokens) || !Number.isSafeInteger(route.maxOutputTokens)
    || route.maxContextTokens < 1 || route.maxOutputTokens < 1) return null;
  if (!route.surplusModelId.trim()) return null;
  if (entry.limits?.contextTokens && route.maxContextTokens > entry.limits.contextTokens) return null;
  if (entry.limits?.outputTokens && route.maxOutputTokens > entry.limits.outputTokens) return null;
  return route;
}

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
  /** Pure injection seam for offline transport and narrowed-limit tests. */
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

export function resolveQualifiedSurplusChatRoute(
  catalogModelId: string,
  routes?: readonly QualifiedSurplusChatRoute[],
): QualifiedSurplusChatRoute | null {
  const entry = getActiveModelCatalogSync().catalog.entries.find((row) => row.id === catalogModelId);
  if (!entry) return null;
  if (routes === undefined) return deriveRoute(entry);
  const route = routes.find((candidate) => candidate.catalogModelId === catalogModelId);
  return route ? validateInjectedRoute(entry, route) : null;
}

/**
 * One fail-closed projection for signed-catalog Surplus chat capability.
 * Personal funding cannot use the server Surplus credential.
 */
export function resolveSurplusChatServingAvailability(
  input: ResolveSurplusChatServingAvailabilityInput,
): SurplusChatServingAvailability {
  const route = input.catalogModelId === undefined
    ? getActiveModelCatalogSync().catalog.entries
      .map((entry) => resolveQualifiedSurplusChatRoute(entry.id, input.routes))
      .find((candidate): candidate is QualifiedSurplusChatRoute => candidate !== null) ?? null
    : resolveQualifiedSurplusChatRoute(input.catalogModelId, input.routes);
  if (!route) return { status: "not-qualified", route: null };
  if (!input.policyEnabled || !input.keyConfigured) {
    return { status: "qualified-unavailable", route };
  }
  return { status: "available", route };
}
