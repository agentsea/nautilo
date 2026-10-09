import type { DecisionOperation, ModelCatalogEntry } from "@nautilo/types";
import { getActiveModelCatalogSync } from "../config/model-catalog/runtime-catalog";
import type { SurplusProviderPin } from "./surplus-route";

/** A signed native-decision row projected onto Surplus's decision wire. */
export interface QualifiedSurplusDecisionRoute {
  readonly catalogModelId: string;
  readonly surplusModelId: string;
  readonly providerPin: Extract<SurplusProviderPin, "openrouter" | "venice">;
  readonly operations: readonly DecisionOperation[];
  readonly supportsMultipleQuestions: boolean;
  readonly maxChoices: number;
  readonly maxScoreLevels?: number;
}

const DECISION_PROVIDER_PINS = Object.freeze({
  openrouter: "openrouter",
  venice: "venice",
} satisfies Readonly<Record<string, QualifiedSurplusDecisionRoute["providerPin"]>>);

function providerPinForCatalogEntry(
  entry: ModelCatalogEntry,
): QualifiedSurplusDecisionRoute["providerPin"] | null {
  return DECISION_PROVIDER_PINS[entry.provider as keyof typeof DECISION_PROVIDER_PINS] ?? null;
}

function deriveRoute(entry: ModelCatalogEntry): QualifiedSurplusDecisionRoute | null {
  const workload = "workload" in entry ? entry.workload : "chat";
  const providerPin = providerPinForCatalogEntry(entry);
  const separator = entry.id.indexOf(":");
  const surplusModelId = separator < 1 ? "" : entry.id.slice(separator + 1);
  const decision = entry.decision;
  if (!entry.defaultEnabled || workload !== "decision" || !providerPin || !surplusModelId
    || !decision || entry.id.includes(":e2ee-") || entry.privacy.label === "e2ee"
    || entry.routing === "china-anonymized") return null;
  return Object.freeze({
    catalogModelId: entry.id,
    surplusModelId,
    providerPin,
    operations: Object.freeze([...decision.operations]),
    supportsMultipleQuestions: decision.supportsMultipleQuestions === true,
    maxChoices: decision.maxChoices,
    ...(decision.maxScoreLevels === undefined ? {} : { maxScoreLevels: decision.maxScoreLevels }),
  });
}

export function resolveQualifiedSurplusDecisionRoute(
  catalogModelId: string,
): QualifiedSurplusDecisionRoute | null {
  const entry = getActiveModelCatalogSync().catalog.entries.find((row) => row.id === catalogModelId);
  return entry ? deriveRoute(entry) : null;
}

export type SurplusDecisionServingAvailability =
  | { readonly status: "not-qualified"; readonly route: null }
  | {
      readonly status: "qualified-unavailable" | "available";
      readonly route: QualifiedSurplusDecisionRoute;
    };

export interface ResolveSurplusDecisionServingAvailabilityInput {
  /** Omit only for the aggregate administrator capability projection. */
  readonly catalogModelId?: string;
  readonly policyEnabled: boolean;
  readonly keyConfigured: boolean;
  readonly fundingKind?: "server" | "personal";
}

/**
 * Runtime-first native-decision eligibility from the active signed catalogue.
 * Surplus decision access is pilot-gated by the service, so `available` means
 * an attempt is configured; the endpoint can still refuse an unentitled key.
 */
export function resolveSurplusDecisionServingAvailability(
  input: ResolveSurplusDecisionServingAvailabilityInput,
): SurplusDecisionServingAvailability {
  const route = input.catalogModelId === undefined
    ? getActiveModelCatalogSync().catalog.entries
      .map(deriveRoute)
      .find((candidate): candidate is QualifiedSurplusDecisionRoute => candidate !== null) ?? null
    : resolveQualifiedSurplusDecisionRoute(input.catalogModelId);
  if (!route) return { status: "not-qualified", route: null };
  if (!input.policyEnabled || !input.keyConfigured) {
    return { status: "qualified-unavailable", route };
  }
  return { status: "available", route };
}
