import type {
  EligibleModel,
  EligibleModelCapabilities,
  EligibleModelControls,
  GetEligibleModelsOptions,
  ModelAvailability,
  ModelPurpose,
  RoutingClass,
} from "@nautilo/trust";
import type { ModelCatalogEntry } from "@nautilo/types";
import { resolveCatalogModel, resolveChinaUpstreamConsent } from "./resolved-catalog";
import { scheduleVeniceCatalogRefreshIfNeeded } from "./venice-catalog-cache";
import { getActiveModelCatalogSync } from "./model-catalog/runtime-catalog";

function capabilityFailure(
  row: ReturnType<typeof resolveCatalogModel>,
  purpose: ModelPurpose,
): string | undefined {
  if (purpose === "image-generation") {
    return row.output.includes("image") ? undefined : "model does not generate images";
  }
  if (purpose === "embeddings") {
    return row.output.includes("embedding") ? undefined : "model does not generate embeddings";
  }
  if (!row.output.includes("text")) return "model does not produce text";
  if (row.workload !== "chat") return `${row.workload} workload cannot be used for chat`;
  if ((purpose === "vision" || purpose === "vision-tools") && !row.input.includes("image")) {
    return "model does not accept image input";
  }
  if (
    (purpose === "chat-tools" || purpose === "vision-tools" || purpose === "task-tools") &&
    row.features.tools !== true
  ) {
    return row.features.tools === false
      ? "model does not support tool/function calling"
      : "tool/function calling capability is unverified";
  }
  return undefined;
}

function isVeniceModelId(id: string): boolean {
  return id.toLowerCase().startsWith("venice:");
}

function routingToClass(routing: string | undefined): RoutingClass {
  return routing === "venice-hosted" ||
    routing === "western-anonymized" ||
    routing === "china-anonymized"
    ? routing
    : "unknown";
}

/**
 * capabilities now project from the canonical resolved row
 * ({@link resolveCatalogModel}) so the picker and exact-call validation share
 * one capability source. Unknown feature values (`null`) map to the legacy UX
 * defaults for chat: `tools → true` (optimistic), others → `false`. Non-chat
 * rows never project tool calling. Selection itself
 * remains strict: capability qualification uses the nullable resolved row and
 * every provider route requires its own credential.
 */
function projectEligibleCapabilities(modelId: string): EligibleModelCapabilities {
  const row = resolveCatalogModel(modelId);
  const f = row.features;
  return {
    tools: row.workload === "chat" && (f.tools ?? true),
    vision: row.input.includes("image"),
    reasoning: f.reasoning ?? false,
    e2ee: f.e2ee ?? false,
    webSearch: f.webSearch ?? false,
  };
}

/**
 * Project the reviewed v2 catalog controls across the discovery boundary.
 * This is intentionally a field-by-field allow-list: selector/provenance are
 * execution-only catalog data and must never become browser-visible DTOs.
 */
function projectEligibleControls(entry: ModelCatalogEntry): EligibleModelControls | undefined {
  const controls = entry.controls;
  if (!controls) return undefined;

  const reasoning = controls.reasoning
    ? {
        levels: [...controls.reasoning.levels],
        defaultLevel: controls.reasoning.defaultLevel,
        canDisable: controls.reasoning.canDisable,
        mandatory: controls.reasoning.mandatory,
      }
    : undefined;
  const serving = controls.serving
    ? {
        defaultProfile: controls.serving.defaultProfile,
        profiles: controls.serving.profiles.map((profile) => ({
          id: profile.id,
          label: profile.label,
          ...(profile.description !== undefined ? { description: profile.description } : {}),
          intent: profile.intent,
          ...(profile.pricing !== undefined
            ? {
                pricing: {
                  inputPerMtok: profile.pricing.inputPerMtok,
                  cachedInputPerMtok: profile.pricing.cachedInputPerMtok,
                  outputPerMtok: profile.pricing.outputPerMtok,
                },
              }
            : {}),
        })),
      }
    : undefined;

  return {
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(serving !== undefined ? { serving } : {}),
  };
}

function toEligibleModel(
  entry: ModelCatalogEntry,
  availability: ModelAvailability,
  unavailableReason: string | undefined,
  routingClass: RoutingClass | undefined,
): EligibleModel {
  const selectable = availability === "selectable";
  const controls = projectEligibleControls(entry);
  return {
    id: entry.id,
    displayName: entry.displayName,
    provider: entry.provider,
    priority: entry.priority,
    costCoefficient: entry.cost.coefficient,
    enabled: selectable,
    ...(routingClass !== undefined ? { routing: routingClass } : {}),
    capabilities: projectEligibleCapabilities(entry.id),
    ...(controls !== undefined ? { controls } : {}),
    availability,
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
  };
}

/**
 * Trust-aware model list for every selector. Each signed route requires its
 * own credential; China-routed Venice SKUs are hidden unless
 * `allowChinaUpstream: true`. Purpose qualification is applied after the base
 * catalog/credential/routing decision.
 *
 * membership now iterates the active released snapshot (validated
 * remote catalog, or the checked-in fallback). A newly published supported row
 * appears here without a server restart once the runtime seam has hydrated the
 * snapshot. Non-venice rows the release marks `defaultEnabled: false` are
 * restricted (excluded from the picker, mirroring the legacy
 * `getSelectableModels` enabled gate). Remote metadata can never make an
 * unsupported provider selectable (the resolved-row provider-support gate
 * enforces that).
 */
export function getEligibleModels(opts: GetEligibleModelsOptions = {}): EligibleModel[] {
  const {
    includeUnavailable = false,
    allowChinaUpstream = resolveChinaUpstreamConsent(undefined, opts.env),
    purpose = "chat-tools",
    tier: _reservedTier,
  } = opts;
  void _reservedTier; // Inference-tier filtering when posture UX is wired .

  const { catalog } = getActiveModelCatalogSync();
  const out: EligibleModel[] = [];

  for (const entry of catalog.entries) {
    // Release disablement is absolute for every provider, including Venice.
    // Credentials and routing consent may narrow a released row but never
    // enable one whose signed metadata says `defaultEnabled: false`.
    if (!entry.defaultEnabled) {
      if (includeUnavailable) {
        out.push(
          toEligibleModel(entry, "filtered", "catalog row disabled", undefined),
        );
      }
      continue;
    }

    const resolved = resolveCatalogModel(entry.id, {
      allowChinaUpstream,
      ...(opts.env === undefined ? {} : { env: opts.env }),
    });
    const routingClass = isVeniceModelId(entry.id)
      ? routingToClass(entry.routing)
      : undefined;
    let availability: ModelAvailability;
    let reason = resolved.unavailableReason;
    switch (resolved.availability) {
      case "selectable": {
        const failure = capabilityFailure(resolved, purpose);
        availability = failure ? "unsupported-capability" : "selectable";
        reason = failure;
        break;
      }
      case "missing_credentials":
        availability = "missing-key";
        break;
      case "routing_filtered":
      case "disabled":
        availability = "filtered";
        break;
      case "unknown_model":
        availability = "unknown-model";
        break;
    }
    if (availability !== "selectable" && !includeUnavailable) continue;
    out.push(toEligibleModel(entry, availability, reason, routingClass));
  }

  // Canonical-row projection already merges venice capability hints, so the
  // legacy second-pass overlay is no longer needed. Keep the background refresh
  // kick so the cache warms for the next call.
  scheduleVeniceCatalogRefreshIfNeeded();

  return out.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

export const MAX_RETAINED_MODEL_IDS = 25;

export class ModelUnavailableError extends Error {
  readonly code = "model_unavailable" as const;

  constructor(
    readonly modelId: string,
    readonly availability: ModelAvailability,
    readonly reason: string,
  ) {
    super(`Model "${modelId}" is unavailable: ${reason}`);
    this.name = "ModelUnavailableError";
  }
}

/**
 * Resolve only the persisted ids a client actually needs to render. Unknown or
 * formerly-custom ids remain visible as unavailable legacy state without
 * exposing the entire unavailable catalog.
 */
export function resolveRetainedModels(
  ids: readonly string[],
  opts: Omit<GetEligibleModelsOptions, "includeUnavailable"> = {},
): EligibleModel[] {
  const normalized = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
  if (normalized.length > MAX_RETAINED_MODEL_IDS) {
    throw new RangeError(`at most ${MAX_RETAINED_MODEL_IDS} retained model ids may be resolved`);
  }
  const all = getEligibleModels({ ...opts, includeUnavailable: true });
  const byId = new Map(all.map((row) => [row.id, row]));
  return normalized.map((id) => {
    const found = byId.get(id);
    if (found) return found;
    return {
      id,
      displayName: id,
      provider: id.includes(":") ? id.split(":", 1)[0]! : "unknown",
      priority: Number.MAX_SAFE_INTEGER,
      costCoefficient: 1,
      enabled: false,
      capabilities: {
        tools: false,
        vision: false,
        reasoning: false,
        e2ee: false,
        webSearch: false,
      },
      availability: "unknown-model",
      unavailableReason: "model is not present in the current signed catalog",
    };
  });
}

/** Server-side save/start guard. Clients are advisory; this is authoritative. */
export function assertModelRunnable(
  modelId: string,
  opts: Omit<GetEligibleModelsOptions, "includeUnavailable"> = {},
): void {
  const row = resolveRetainedModels([modelId], opts)[0]!;
  if (row.availability === "selectable") return;
  throw new ModelUnavailableError(
    modelId,
    row.availability,
    row.unavailableReason ?? "model is not runnable for this operation",
  );
}
