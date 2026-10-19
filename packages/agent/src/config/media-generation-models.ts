import { candidatesForModelRole } from "@nautilo/config";
import { getCachedServerModelConfigRow } from "@nautilo/db";
import { VENICE_MEDIA_MODELS } from "../media-generation/contracts";
import { resolveSurplusMediaRoute } from "../media-generation/surplus-lifecycle";
import { deriveSurplusMediaModelId } from "../providers/surplus-media-route";
import { resolveProviderKey } from "../resolve-provider-key";
import { listResolvedCatalogModels } from "./resolved-catalog";

export type MediaGenerationFamily = "image" | "music" | "video";

export interface MediaGenerationModel {
  id: string;
  displayName: string;
  provider: string;
  enabled: boolean;
  unavailableReason?: string;
}

export interface ServerSurplusMediaAvailability {
  readonly policyEnabled?: boolean;
  readonly keyConfigured?: boolean;
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

function hasImplementedSurplusRoute(kind: MediaGenerationFamily, catalogModelId: string): boolean {
  const surplusModelId = deriveSurplusMediaModelId(catalogModelId);
  if (!surplusModelId) return false;
  if (kind === "image") return true;
  return catalogModelId.startsWith("venice:")
    && resolveSurplusMediaRoute(catalogModelId.slice("venice:".length)) !== null;
}

/** Catalogue facts narrowed by implemented adapters; reference-only video is not a generic default. */
export function listMediaGenerationModels(
  kind: MediaGenerationFamily,
  env: NodeJS.ProcessEnv = process.env,
  serverSurplus: ServerSurplusMediaAvailability = {},
): MediaGenerationModel[] {
  const output = kind === "music" ? "audio" : kind;
  const policyEnabled = serverSurplus.policyEnabled
    ?? getCachedServerModelConfigRow()?.preferSurplus === true;
  const keyConfigured = serverSurplus.keyConfigured
    ?? (env === process.env
      ? resolveProviderKey("surplus") !== null
      : Boolean(env["SURPLUS_API_KEY"]?.trim()));
  return listResolvedCatalogModels({ includeUnavailable: true, env })
    .filter((row) => row.workload === "generation"
      && row.generation?.family === kind
      && row.output.includes(output)
      && (kind === "image" ? IMAGE_PROVIDERS.has(row.provider)
        : kind === "video" ? DEFAULT_VIDEO_MODELS.has(row.id) : MUSIC_MODELS.has(row.id)))
    .map((row) => {
      const directImageCredentialMissing = kind === "image"
        && row.provider === "openrouter"
        && !env["OPENROUTER_API_KEY"]?.trim();
      const surplusEligible = policyEnabled && keyConfigured
        && row.availability === "missing_credentials"
        && hasImplementedSurplusRoute(kind, row.id);
      return {
        id: row.id,
        displayName: row.displayName,
        provider: row.provider,
        enabled: (row.availability === "selectable" && !directImageCredentialMissing)
          || surplusEligible,
        ...(surplusEligible ? {}
          : directImageCredentialMissing
          ? { unavailableReason: "OpenRouter credential is not configured" }
          : row.unavailableReason ? { unavailableReason: row.unavailableReason } : {}),
      };
    });
}

/** Shared Automatic order; explicit selections resolve by identity below. */
export function listOrderedMediaGenerationModels(
  kind: MediaGenerationFamily,
  env: NodeJS.ProcessEnv = process.env,
  serverSurplus: ServerSurplusMediaAvailability = {},
): MediaGenerationModel[] {
  const models = listMediaGenerationModels(kind, env, serverSurplus);
  if (kind !== "image") return models;
  const ordered: MediaGenerationModel[] = [];
  const seen = new Set<string>();
  const append = (model: MediaGenerationModel | undefined) => {
    if (!model || seen.has(model.id)) return;
    seen.add(model.id);
    ordered.push(model);
  };
  const roleCandidates = candidatesForModelRole("imageGeneration");
  for (const provider of IMAGE_PROVIDERS) {
    for (const candidate of roleCandidates) {
      append(models.find((model) => model.id === candidate && model.provider === provider));
    }
    for (const model of models) {
      if (model.provider === provider) append(model);
    }
  }
  return ordered;
}

/** Resolve at request preparation, never again for an approved or queued media job. */
export function getDefaultMediaGenerationModel(
  kind: MediaGenerationFamily,
  env: NodeJS.ProcessEnv = process.env,
  serverSurplus: ServerSurplusMediaAvailability = {},
): MediaGenerationModel {
  const stored = getCachedServerModelConfigRow()?.[`${kind}Model`];
  // Keep the existing image operator override. Empty stored value explicitly selects Automatic.
  const selection = stored ?? (kind === "image" ? env["NAUTILO_IMAGE_MODEL"] : undefined);
  const models = listOrderedMediaGenerationModels(kind, env, serverSurplus);
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
  const automatic = models.find((model) => model.enabled);
  if (automatic) return automatic;
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
