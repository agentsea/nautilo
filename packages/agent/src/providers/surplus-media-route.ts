import { getActiveModelCatalogSync } from "../config/model-catalog/runtime-catalog";

const SURPLUS_MODELS_URL = "https://api.surplusintelligence.ai/v1/models";

export type SurplusMediaFamily = "image" | "video" | "music";

export interface SurplusMediaRequirements {
  readonly durationSeconds?: number;
  readonly aspectRatio?: string;
  readonly resolution?: string;
  readonly audio?: boolean;
}

function resolveSignedMediaRoute(catalogModelId: string): {
  readonly surplusModelId: string;
  readonly family: SurplusMediaFamily;
} | null {
  const entry = getActiveModelCatalogSync().catalog.entries.find(
    (candidate) => candidate.id === catalogModelId,
  );
  const workload = entry && "workload" in entry ? entry.workload : "chat";
  const generation = entry && "generation" in entry ? entry.generation : undefined;
  const privacyLabel = entry && "label" in entry.privacy ? entry.privacy.label : undefined;
  if (entry?.provider !== "venice" || entry.defaultEnabled !== true
    || workload !== "generation"
    || !generation || !["image", "video", "music"].includes(generation.family)
    || entry.id.includes(":e2ee-") || privacyLabel === "e2ee"
    || entry.routing === "china-anonymized" || !entry.id.startsWith("venice:")) {
    return null;
  }
  const nativeModelId = entry.id.slice("venice:".length);
  return nativeModelId
    ? { surplusModelId: `venice-${nativeModelId}`, family: generation.family }
    : null;
}

/**
 * Maps one signed Venice generation row to the documented Surplus spelling.
 * Other providers and workloads deliberately have no inferred marketplace id.
 */
export function deriveSurplusMediaModelId(catalogModelId: string): string | null {
  return resolveSignedMediaRoute(catalogModelId)?.surplusModelId ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

function includesAll(values: readonly string[] | null, required: readonly string[]): boolean {
  return values !== null && required.every((value) => values.includes(value));
}

function includesExact(value: unknown, expected: string | number): boolean {
  return Array.isArray(value)
    && value.every((item) => typeof item === typeof expected)
    && value.includes(expected);
}

function advertisesFamily(row: Record<string, unknown>, family: SurplusMediaFamily): boolean {
  const architecture = isRecord(row["architecture"]) ? row["architecture"] : null;
  const outputModalities = architecture
    ? stringList(architecture["output_modalities"])
    : null;
  const supportedParameters = stringList(row["supported_parameters"]);
  const supportedFeatures = stringList(row["supported_features"]);

  switch (family) {
    case "image":
      return includesAll(outputModalities, ["image"])
        && includesAll(supportedParameters, ["prompt", "model"])
        && includesAll(supportedFeatures, ["image"]);
    case "video":
      return includesAll(outputModalities, ["video"])
        && includesAll(supportedParameters, ["async", "text-to-video", "artifact"]);
    case "music":
      return includesAll(outputModalities, ["music"])
        && includesAll(supportedParameters, [
          "async",
          "music",
          "artifact",
          "instrumental",
          "lyrics",
        ]);
  }
}

function advertisesRequirements(
  row: Record<string, unknown>,
  requirements: SurplusMediaRequirements | undefined,
): boolean {
  if (!requirements) return true;
  const supportedParameters = stringList(row["supported_parameters"]);
  if (requirements.durationSeconds !== undefined
    && (!Number.isFinite(requirements.durationSeconds)
      || !includesExact(row["durations_seconds"], requirements.durationSeconds))) return false;
  if (requirements.aspectRatio !== undefined
    && !includesExact(row["aspect_ratios"], requirements.aspectRatio)) return false;
  if (requirements.resolution !== undefined
    && !includesExact(row["resolutions"], requirements.resolution)) return false;
  if (requirements.audio !== undefined && !includesAll(supportedParameters, ["audio"])) return false;
  return true;
}

/** Read-only account-scoped discovery for one exact signed media model. */
export async function findSurplusMediaModel(input: {
  readonly catalogModelId: string;
  readonly family: SurplusMediaFamily;
  readonly apiKey: string;
  readonly requirements?: Readonly<SurplusMediaRequirements>;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  const route = resolveSignedMediaRoute(input.catalogModelId);
  if (!route || route.family !== input.family
    || (input.requirements !== undefined && input.family !== "video")) return false;

  let response: Response;
  try {
    response = await (input.fetchImpl ?? globalThis.fetch)(SURPLUS_MODELS_URL, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.apiKey}`,
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch {
    return false;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return false;
  }
  if (!isRecord(payload) || !Array.isArray(payload["data"])) return false;

  const exactMatches = payload["data"].filter(
    (row): row is Record<string, unknown> => isRecord(row) && row["id"] === route.surplusModelId,
  );
  return exactMatches.length === 1
    && advertisesFamily(exactMatches[0]!, input.family)
    && advertisesRequirements(exactMatches[0]!, input.requirements);
}
