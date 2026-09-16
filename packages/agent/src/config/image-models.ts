import { getDefaultMediaGenerationModel, listMediaGenerationModels } from "./media-generation-models";

export type ImageProvider = "openai" | "google" | "openrouter" | "venice";

export interface ImageModelConfig {
  id: string;
  apiModel: string;
  displayName: string;
  provider: ImageProvider;
  enabled: boolean;
  unavailableReason?: string;
}

function catalogImageModels(
  env: NodeJS.ProcessEnv = process.env,
): ImageModelConfig[] {
  return listMediaGenerationModels("image", env)
    .map((row) => ({
      id: row.id,
      apiModel: row.id.slice(row.id.indexOf(":") + 1),
      displayName: row.displayName,
      provider: row.provider as ImageProvider,
      enabled: row.enabled,
      ...(row.unavailableReason ? { unavailableReason: row.unavailableReason } : {}),
    }));
}

/** Resolve an exact catalog id, or an unambiguous provider API-model alias. */
export function getImageModel(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): ImageModelConfig | undefined {
  const models = catalogImageModels(env);
  const exact = models.find((model) => model.id === id);
  if (exact) return exact;
  const aliases = models.filter((model) => model.apiModel === id);
  return aliases.length === 1 ? aliases[0] : undefined;
}

export function getDefaultImageModel(env: NodeJS.ProcessEnv = process.env): ImageModelConfig {
  const selected = getDefaultMediaGenerationModel("image", env);
  return {
    ...selected,
    apiModel: selected.id.slice(selected.id.indexOf(":") + 1),
    provider: selected.provider as ImageProvider,
  };
}
