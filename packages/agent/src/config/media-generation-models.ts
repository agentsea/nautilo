import { candidatesForModelRole } from "@nautilo/config";
import { getCachedServerModelConfigRow } from "@nautilo/db";
import { VENICE_MEDIA_MODELS } from "../media-generation/contracts";
import { listResolvedCatalogModels } from "./resolved-catalog";

export type MediaGenerationFamily = "image" | "music" | "video";

export interface MediaGenerationModel {
  id: string;
  displayName: string;
  provider: string;
  enabled: boolean;
  unavailableReason?: string;
}

const IMAGE_PROVIDERS = new Set(["venice", "openrouter", "openai", "google"]);
const DEFAULT_VIDEO_MODELS = new Set<string>([
  `venice:${VENICE_MEDIA_MODELS.seedance}`,
  `venice:${VENICE_MEDIA_MODELS.minimaxH3}`,
]);
const MUSIC_MODELS = new Set<string>([
  `venice:${VENICE_MEDIA_MODELS.sonilo}`,
  `venice:${VENICE_MEDIA_MODELS.minimaxMusic}`,
]);

/** Catalogue facts narrowed by implemented adapters; reference-only video is not a generic default. */
export function listMediaGenerationModels(
  kind: MediaGenerationFamily,
  env: NodeJS.ProcessEnv = process.env,
): MediaGenerationModel[] {
  const output = kind === "music" ? "audio" : kind;
  // The managed Gateway supports chat and embeddings only. Evaluate catalog
  // credential availability for media using the existing direct credentials,
  // while retaining every routing/privacy/catalog decision from the resolver.
  const directMediaEnv = {
    ...env,
    NAUTILO_MANAGED_GATEWAY_API_KEY: undefined,
    NAUTILO_MANAGED_GATEWAY_BASE_URL: undefined,
  };
  return listResolvedCatalogModels({ includeUnavailable: true, env: directMediaEnv })
    .filter((row) => row.workload === "generation"
      && row.generation?.family === kind
      && row.output.includes(output)
      && (kind === "image" ? IMAGE_PROVIDERS.has(row.provider)
        : kind === "video" ? DEFAULT_VIDEO_MODELS.has(row.id) : MUSIC_MODELS.has(row.id)))
    .map((row) => {
      const directImageCredentialMissing = kind === "image"
        && row.provider === "openrouter"
        && !env["OPENROUTER_API_KEY"]?.trim();
      return {
        id: row.id,
        displayName: row.displayName,
        provider: row.provider,
        enabled: row.availability === "selectable" && !directImageCredentialMissing,
        ...(directImageCredentialMissing
          ? { unavailableReason: "OpenRouter credential is not configured" }
          : row.unavailableReason ? { unavailableReason: row.unavailableReason } : {}),
      };
    });
}

/** Resolve at request preparation, never again for an approved or queued media job. */
export function getDefaultMediaGenerationModel(
  kind: MediaGenerationFamily,
  env: NodeJS.ProcessEnv = process.env,
): MediaGenerationModel {
  const stored = getCachedServerModelConfigRow()?.[`${kind}Model`];
  // Keep the existing image operator override. Empty stored value explicitly selects Automatic.
  const selection = stored ?? (kind === "image" ? env["NAUTILO_IMAGE_MODEL"] : undefined);
  const models = listMediaGenerationModels(kind, env);
  const id = selection?.trim();
  if (id) {
    const exact = models.find((model) => model.id === id);
    const aliases = models.filter((model) => model.id.slice(model.id.indexOf(":") + 1) === id);
    const selected = exact ?? (aliases.length === 1 ? aliases[0] : undefined);
    if (!selected) throw new Error(`Unknown configured ${kind} model "${id}".`);
    if (!selected.enabled) {
      throw new Error(`Configured ${kind} model "${selected.id}" is unavailable: ${selected.unavailableReason ?? "catalog row is not selectable"}.`);
    }
    return selected;
  }
  if (kind === "image") {
    // Provider preference also applies to newly released image models, not just the named defaults.
    for (const provider of IMAGE_PROVIDERS) {
      const preferred = candidatesForModelRole("imageGeneration")
        .map((candidate) => models.find((model) => model.id === candidate && model.provider === provider && model.enabled))
        .find((model) => model !== undefined);
      const selected = preferred ?? models.find((model) => model.provider === provider && model.enabled);
      if (selected) return selected;
    }
  } else {
    const selected = models.find((model) => model.enabled);
    if (selected) return selected;
  }
  throw new Error(`No configured, credentialed ${kind}-generation model is runnable.`);
}

/** Missing model means server default; explicit provider API ids remain authoritative. */
export function withMediaGenerationDefault(kind: "music" | "video", intent: unknown): unknown {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return intent;
  const input = intent as Record<string, unknown>;
  if (input["model"] !== undefined) return intent;
  const selected = getDefaultMediaGenerationModel(kind);
  return { ...input, model: selected.id.slice(selected.id.indexOf(":") + 1) };
}
