import type {
  ActiveModelCapabilityCatalogEntry,
  ModelCapabilityFeatures,
  ModelInputModality,
  ModelOutputModality,
  ResolvedModelCapabilities,
} from "./types";
import {
  MODEL_CAPABILITY_OVERRIDES,
  NAUTILO_ID_TO_OPENROUTER_SLUG,
  overrideRowToResolved,
} from "./overrides";
import { getCachedOpenRouterModels } from "./cache";

const TEXT_ONLY: ResolvedModelCapabilities = {
  modelId: "",
  input: ["text"],
  output: ["text"],
  provenance: "default",
};

const OPENROUTER_PREFIX = "openrouter:";

let activeCatalogCapabilities: ReadonlyMap<string, ActiveModelCapabilityCatalogEntry> | null = null;

/**
 * Atomically replace the trusted signed-catalog capability projection.
 *
 * This is an internal runtime seam, not a model- or request-controlled
 * override. Passing `null` restores the package's checked-in/OpenRouter
 * fallback behavior for isolated tests and consumers without a runtime
 * catalog owner.
 */
export function replaceActiveModelCapabilityCatalog(
  entries: readonly ActiveModelCapabilityCatalogEntry[] | null,
): void {
  if (entries === null) {
    activeCatalogCapabilities = null;
    return;
  }
  const next = new Map<string, ActiveModelCapabilityCatalogEntry>();
  for (const entry of entries) {
    next.set(entry.id, {
      id: entry.id,
      ...(entry.modalities
        ? {
            modalities: {
              input: [...entry.modalities.input],
              output: [...entry.modalities.output],
            },
          }
        : {}),
      ...(entry.features ? { features: { ...entry.features } } : {}),
      ...(entry.capabilityProvenance
        ? { capabilityProvenance: entry.capabilityProvenance }
        : {}),
    });
  }
  activeCatalogCapabilities = next;
}

function openRouterSlugForModelId(id: string): string | undefined {
  if (id.toLowerCase().startsWith(OPENROUTER_PREFIX)) {
    const slug = id.slice(OPENROUTER_PREFIX.length).trim();
    return slug || undefined;
  }
  return NAUTILO_ID_TO_OPENROUTER_SLUG[id];
}

export function resolveModelCapabilities(modelId: string): ResolvedModelCapabilities {
  const id = String(modelId || "").trim();
  if (!id) {
    return { ...TEXT_ONLY, modelId: "" };
  }

  const catalogEntry = activeCatalogCapabilities?.get(id);
  const override = MODEL_CAPABILITY_OVERRIDES[id];
  let fallback: ResolvedModelCapabilities | undefined;
  if (override) {
    fallback = overrideRowToResolved(id, override);
  }

  if (!fallback) {
    const slug = openRouterSlugForModelId(id);
    const cache = getCachedOpenRouterModels();
    if (slug && cache?.models[slug]) {
      const snap = cache.models[slug];
      fallback = {
        modelId: id,
        input: snap.input,
        output: snap.output,
        ...(snap.features ? { features: snap.features } : {}),
        provenance: "openrouter",
        fetchedAt: cache.fetchedAt,
      };
    }
  }

  fallback ??= { modelId: id, input: ["text"], output: ["text"], provenance: "default" };
  if (!catalogEntry) return fallback;

  return {
    ...fallback,
    modelId: id,
    input: catalogEntry.modalities?.input ?? fallback.input,
    output: catalogEntry.modalities?.output ?? fallback.output,
    ...(catalogEntry.features ? { features: catalogEntry.features } : {}),
    provenance: catalogEntry.capabilityProvenance ?? fallback.provenance,
  };
}

export function modelSupportsInput(modelId: string, modality: ModelInputModality): boolean {
  return resolveModelCapabilities(modelId).input.includes(modality);
}

export function modelSupportsOutput(modelId: string, modality: ModelOutputModality): boolean {
  return resolveModelCapabilities(modelId).output.includes(modality);
}

export function resolveModelFeatures(modelId: string): ModelCapabilityFeatures | undefined {
  return resolveModelCapabilities(modelId).features;
}

export function modelSupportsFeature(
  modelId: string,
  feature: keyof ModelCapabilityFeatures,
): boolean {
  const row = resolveModelCapabilities(modelId).features;
  return row ? row[feature] === true : false;
}
