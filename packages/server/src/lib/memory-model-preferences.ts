import { candidatesForModelRole, fromRuntimeConfig, type ModelRole } from "@nautilo/config";
import { getEligibleModels, resolveCatalogModel } from "@nautilo/agent";
import { getCachedServerModelConfigRow } from "@nautilo/db";
import type {
  MemoryCapabilityRole,
  PersonalCapabilityPreferences,
} from "@nautilo/types";

export interface PersonalMemoryModel {
  readonly modelId: string;
  readonly displayName: string;
  readonly provider: string;
}

/** Effective operator choices after the existing inheritance chain is applied. */
export interface MemoryOperatorDefaults {
  readonly memoryReview: string | null;
  readonly memoryReflection: string | null;
  readonly memorySummarization: string | null;
}

export class MemoryModelPreferenceError extends Error {
  constructor(readonly code: "unsupported_workload" | "provider_credentials_missing") {
    super(code);
    this.name = "MemoryModelPreferenceError";
  }
}

const MEMORY_ROLE = {
  memoryReview: { modelRole: "memoryReview", tools: true },
  memoryReflection: { modelRole: "stenographer", tools: false },
  memorySummarization: { modelRole: "stenographer", tools: false },
} satisfies Record<MemoryCapabilityRole, { modelRole: ModelRole; tools: boolean }>;

/** Read the same operator inheritance used by the current Memory executors. */
export function currentMemoryOperatorDefaults(): MemoryOperatorDefaults {
  const stored = getCachedServerModelConfigRow();
  const runtimeConductor = fromRuntimeConfig().nautilo_conductor_model.trim();
  const conductor = stored?.conductorModel?.trim() || runtimeConductor;
  const stenographer = stored?.stenographerModel?.trim() || conductor;
  return {
    memoryReview: stored?.memoryReviewModel?.trim() || conductor || null,
    memoryReflection: stored?.reflectionModel?.trim() || stenographer || null,
    memorySummarization: stenographer || null,
  };
}

/** Structurally executable text models, ordered by the existing role policy. */
export function personalMemoryModels(role: MemoryCapabilityRole): PersonalMemoryModel[] {
  const definition = MEMORY_ROLE[role];
  const rows = getEligibleModels({
    includeUnavailable: true,
    purpose: definition.tools ? "chat-tools" : "chat",
    env: {},
  }).filter((row) => {
    const resolved = resolveCatalogModel(row.id, { env: {} });
    return ["selectable", "missing_credentials"].includes(resolved.availability)
      && resolved.workload === "chat"
      && resolved.output.includes("text")
      && (!definition.tools || resolved.features.tools === true);
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = [
    ...candidatesForModelRole(definition.modelRole),
    ...rows.map((row) => row.id),
  ];
  return [...new Set(ordered)].flatMap((modelId) => {
    const row = byId.get(modelId);
    return row
      ? [{ modelId: row.id, displayName: row.displayName, provider: row.provider }]
      : [];
  });
}

/**
 * Resolve a stable Memory choice without selecting a payer. The caller supplies
 * an admitted, role-compatible catalogue in priority order and separately opens
 * funding for the returned exact model.
 */
export function resolveMemoryModelPreference(
  role: MemoryCapabilityRole,
  snapshot: PersonalCapabilityPreferences,
  operatorDefaults: MemoryOperatorDefaults,
  catalogue: readonly PersonalMemoryModel[],
): { readonly modelId: string; readonly preferenceRevision: number } {
  const personal = snapshot.overrides[role]?.trim();
  const operator = operatorDefaults[role]?.trim();
  const exact = personal || operator;
  if (exact) {
    if (!catalogue.some((model) => model.modelId === exact)) {
      throw new MemoryModelPreferenceError("unsupported_workload");
    }
    return { modelId: exact, preferenceRevision: snapshot.revision };
  }
  const automatic = catalogue[0];
  if (!automatic) throw new MemoryModelPreferenceError("provider_credentials_missing");
  return { modelId: automatic.modelId, preferenceRevision: snapshot.revision };
}
