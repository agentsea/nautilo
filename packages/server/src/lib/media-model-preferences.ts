import {
  listOrderedMediaGenerationModels, listSpeechModels, resolveCatalogModel,
} from "@nautilo/agent";
import { getCachedServerModelConfigRow } from "@nautilo/db";
import type { MediaCapabilityRole, PersonalCapabilityPreferences, TaskFundingBinding } from "@nautilo/types";
import { ModelFundingError, type ModelFundingDeps } from "./model-funding";
import { resolveMediaFunding, type MediaFundingFamily } from "./media-funding";
import { resolveServiceFunding } from "./service-funding";

function mediaFamilyForRole(role: Exclude<MediaCapabilityRole, "speech">): MediaFundingFamily {
  return role === "imageGeneration" ? "image" : role === "videoGeneration" ? "video" : "music";
}

export function personalMediaModels(role: MediaCapabilityRole) {
  const rows = role === "speech"
    ? listSpeechModels()
    : listOrderedMediaGenerationModels(mediaFamilyForRole(role));
  return rows.filter((model) => {
    const row = resolveCatalogModel(model.id);
    return ["selectable", "missing_credentials"].includes(row.availability);
  }).map((model) => ({ modelId: model.id, displayName: model.displayName, provider: model.provider }));
}

export async function mediaPreferenceFunding(
  humanUserId: string, modelId: string, role: MediaCapabilityRole, deps?: ModelFundingDeps,
) {
  if (!personalMediaModels(role).some((model) => model.modelId === modelId)) {
    throw new ModelFundingError("unsupported_workload");
  }
  if (role !== "speech") return resolveMediaFunding(humanUserId, modelId, mediaFamilyForRole(role), deps);
  // Settings projections use a request-local credential snapshot and never decrypt.
  return resolveServiceFunding(humanUserId, "elevenlabs", undefined, deps ? {
    ...deps, serverKey: () => process.env["ELEVENLABS_API_KEY"]?.trim() || null,
  } : undefined);
}

/** Explicit call model > Human override > server default > admitted automatic choice. */
export async function resolvePersonalMediaModel(
  humanUserId: string, role: MediaCapabilityRole, configuredId: string | null | undefined,
  preferences: PersonalCapabilityPreferences, deps?: ModelFundingDeps,
  validateFunding: (binding: TaskFundingBinding) => Promise<void> = async () => {},
) {
  const config = getCachedServerModelConfigRow();
  const stored = role === "speech" ? config?.speechModel : config?.[`${mediaFamilyForRole(role)}Model`];
  const selected = configuredId?.trim() || preferences.overrides[role] || stored?.trim()
    || (role === "imageGeneration" && stored == null ? process.env["NAUTILO_IMAGE_MODEL"]?.trim() : undefined);
  const models = personalMediaModels(role);
  if (selected) {
    const exact = models.find((model) => model.modelId === selected);
    const aliases = models.filter((model) => model.modelId.slice(model.modelId.indexOf(":") + 1) === selected);
    const choice = exact ?? (aliases.length === 1 ? aliases[0] : undefined);
    if (!choice) throw new ModelFundingError("unsupported_workload");
    await validateFunding(await mediaPreferenceFunding(humanUserId, choice.modelId, role, deps));
    return { modelId: choice.modelId, preferenceRevision: preferences.revision };
  }
  for (const model of models) {
    try {
      await validateFunding(await mediaPreferenceFunding(humanUserId, model.modelId, role, deps));
      return { modelId: model.modelId, preferenceRevision: preferences.revision };
    } catch (error) {
      if (!(error instanceof ModelFundingError)) throw error;
      // Broken custody or an accepted credential is never treated as absence.
      if (error.code === "personal_credential_unavailable" || error.code === "personal_credential_stale") throw error;
    }
  }
  throw new ModelFundingError("provider_credentials_missing");
}
