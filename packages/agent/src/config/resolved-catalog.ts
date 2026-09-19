/**
 * resolved catalog projection.
 *
 * Composes ONE non-secret, server-side {@link ResolvedCatalogModel} row per
 * active signed-catalog entry by reusing existing sources only:
 *
 * - identity / cost / routing : `ASSISTANT_MODELS` (`./assistant-models`)
 * - modalities / features / provenance / lastVerifiedAt
 * : `resolveModelCapabilities` (`@nautilo/model-capabilities`)
 * - venice capability overlay : `readVeniceCapabilityHintsSync` (`./venice-catalog-cache`)
 * - privacy grade : `MODEL_PRIVACY_GRADE` (`./model-privacy`)
 * - intelligence tier / rank : `MODEL_INTELLIGENCE_TIER` / `INTELLIGENCE_RANK` (`./model-selection`)
 * - signed execution limits : active model-catalog entry
 * - unknown-id display hint : `getDescriptiveModelContextTokens` / `getKnownModelMaxOutputTokens`
 * (`../providers/models`)
 * - credential detection : `modelHasRunnableCredentials` (`../chat/model-runtime-credentials`)
 *
 * It does NOT duplicate provider-prefix parsing, privacy grades, intelligence
 * tiers, or limit tables. List/get are pure / cache-backed: they never await a
 * network fetch ( decision; `tests/unit/resolved-catalog.test.ts`
 * stubs `globalThis.fetch` to throw to prove it). Venice refresh may warm the
 * cache asynchronously via `scheduleVeniceCatalogRefreshIfNeeded`, but the
 * returned rows are computed only from checked-in data / current caches.
 */
import type {
  ModelCatalogEntry,
} from "@nautilo/types";
import type {
  ResolvedCatalogModel,
  ResolvedCatalogAvailability,
  ResolvedCatalogFeatures,
  ResolvedCatalogInputModality,
  ResolvedCatalogOutputModality,
  ResolvedCatalogProvenance,
  ResolveCatalogModelOptions,
  RoutingClass,
} from "@nautilo/trust";
import { resolveModelCapabilities } from "@nautilo/model-capabilities";
import {
  ASSISTANT_MODELS,
  getCostCoefficient,
  getModelById,
  getProviderFromModelId,
  type AssistantModelConfig,
  type VeniceRouting,
} from "./assistant-models";
import { MODEL_PRIVACY_GRADE } from "./model-privacy";
import {
  INTELLIGENCE_RANK,
  MODEL_INTELLIGENCE_TIER,
} from "./model-selection";
import { modelHasRunnableCredentials } from "../chat/model-runtime-credentials";
import {
  getDescriptiveModelContextTokens,
  getKnownModelMaxOutputTokens,
} from "../providers/models";
import {
  readVeniceCapabilityHintsSync,
  readVeniceCatalogSnapshotSync,
  isVeniceCatalogSnapshotFresh,
  scheduleVeniceCatalogRefreshIfNeeded,
  type VeniceCatalogSnapshot,
  type VeniceParsedCaps,
} from "./venice-catalog-cache";
import {
  getActiveModelCatalogSync,
  type ModelCatalogProvenance,
} from "./model-catalog/runtime-catalog";
import { isSupportedModelCatalogWorkload } from "./model-catalog/supported-providers";

/** Explicit caller consent overrides the operator setting; injected environments are authoritative. */
export function resolveChinaUpstreamConsent(
  explicit: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof explicit === "boolean") return explicit;
  const token = env["NAUTILO_ALLOW_CHINA_UPSTREAM"]?.trim().toLowerCase();
  return token === "1" || token === "true" || token === "yes";
}

function isVeniceModelId(id: string): boolean {
  return id.toLowerCase().startsWith("venice:");
}

function routingToClass(routing: AssistantModelConfig["routing"]): RoutingClass | null {
  return routing ?? null;
}

/** Map model-capabilities provenance → resolved catalog provenance. */
function mapProvenance(
  provenance: "override" | "openrouter" | "smoke" | "default",
  veniceHintPresent: boolean,
  isCurated: boolean,
): ResolvedCatalogProvenance | null {
  if (veniceHintPresent) return "catalog";
  if (provenance === "default") return isCurated ? "catalog" : null;
  return provenance;
}

/** Stable, machine-readable credential-missing reason per provider prefix. */
function missingCredentialReason(id: string): string {
  const colon = id.indexOf(":");
  const prefix = colon >= 0 ? id.slice(0, colon).toLowerCase() : "";
  switch (prefix) {
    case "anthropic":
      return "Anthropic credential is not configured";
    case "openai":
      return "OpenAI credential is not configured";
    case "openrouter":
      return "OpenRouter credential is not configured";
    case "gateway":
      return "gateway credential or endpoint is not configured";
    case "google":
      return "Google credential is not configured";
    case "xai":
      return "xAI credential is not configured";
    case "fireworks":
      return "Fireworks credential is not configured";
    case "together":
      return "Together credential is not configured";
    case "venice":
      return "Venice credential is not configured";
    default:
      // Legacy bare ids infer anthropic/openai/google; the credential checker
      // already resolved the provider, so a miss here means the inferred
      // provider's key is absent.
      return "required provider API key not set";
  }
}

interface AvailabilityOutcome {
  availability: ResolvedCatalogAvailability;
  reason: string | undefined;
}

/**
 * Resolve runnable state + reason. Routing policy is evaluated SEPARATELY
 * from credentials : a china-routed Venice SKU without opt-in is
 * `routing_filtered` even when a Venice key is present; a keyed western SKU
 * is `selectable`; a non-venice disabled catalog row is `disabled`.
 */
function resolveAvailability(
  config: AssistantModelConfig,
  id: string,
  env: NodeJS.ProcessEnv,
  allowChinaUpstream: boolean,
  workload: ResolvedCatalogModel["workload"],
): AvailabilityOutcome {
  // Provider and workload adapters are local code. Remote metadata cannot
  // make an unsupported transport selectable.
  const provider = getProviderFromModelId(id);
  if (!isSupportedModelCatalogWorkload(provider, workload)) {
    return {
      availability: "disabled",
      reason: `provider "${provider}" is not supported for the ${workload} workload on this server`,
    };
  }
  // Release disablement is absolute for every provider. Local credentials,
  // routing consent, or legacy static flags may only narrow a released row;
  // they can never re-enable `defaultEnabled: false`.
  if (!config.enabled) {
    return { availability: "disabled", reason: "catalog row disabled" };
  }
  if (isVeniceModelId(id)) {
    const routing = config.routing;
    if (routing === "china-anonymized" && !allowChinaUpstream) {
      return {
        availability: "routing_filtered",
        reason: "china-anonymized routing requires allowChinaUpstream",
      };
    }
    // Curated venice rows always carry a routing class. A non-curated venice
    // id reaches here only via getModelById's dynamic path, which currently
    // does not synthesize venice configs — so routing is always defined for
    // venice rows that get this far. Defensive guard kept for safety.
    if (routing === undefined && !allowChinaUpstream) {
      return {
        availability: "routing_filtered",
        reason: "non-curated venice:* routing unknown; requires allowChinaUpstream",
      };
    }
  }

  if (!modelHasRunnableCredentials(id, env)) {
    return {
      availability: "missing_credentials",
      reason: missingCredentialReason(id),
    };
  }
  return { availability: "selectable", reason: undefined };
}

/**
 * Fresh complete Venice inventory can safely narrow a signed fallback, but
 * stale/partial/failed cache data remains observational only. This makes a
 * provider-confirmed removal/offline state actionable without letting a
 * transient or legacy cache deny a model.
 */
function refineVeniceAvailability(
  base: AvailabilityOutcome,
  id: string,
  snapshot: VeniceCatalogSnapshot | null,
): AvailabilityOutcome {
  if (!isVeniceModelId(id) || !snapshot || !snapshot.complete || !isVeniceCatalogSnapshotFresh(snapshot)) {
    return base;
  }
  const sku = id.slice("venice:".length);
  const live = snapshot.models.get(sku);
  if (!live) {
    return {
      availability: "disabled",
      reason: "model absent from fresh complete Venice catalog",
    };
  }
  if (live.offline === true) {
    return {
      availability: "disabled",
      reason: "Venice reports this model offline",
    };
  }
  return base;
}

/** Features with explicit `null` for unknown (: never coerce unknown→false). */
function resolveFeatures(id: string): ResolvedCatalogFeatures {
  const resolved = resolveModelCapabilities(id);
  const f = resolved.features;
  const features: ResolvedCatalogFeatures = {
    tools: f ? f.tools : null,
    structuredOutputs: f ? f.structuredOutputs : null,
    reasoning: f ? f.reasoning : null,
    visualGrounding: f?.visualGrounding ?? null,
    webSearch: null,
    e2ee: null,
  };
  if (isVeniceModelId(id)) {
    const hint = readVeniceCapabilityHintsSync().get(id);
    if (hint) {
      features.tools = hint.tools;
      features.reasoning = hint.reasoning;
      features.e2ee = hint.e2ee;
      features.webSearch = hint.webSearch;
      // Venice hints do not carry structuredOutputs → stays null.
    }
  }
  return features;
}

/**
 * active released snapshot seam. Membership and descriptive
 * metadata come from the validated remote catalog (or the checked-in fallback
 * when no remote snapshot is hydrated). The snapshot is read SYNCHRONOUSLY and
 * atomically; this never awaits a network fetch ( invariant preserved).
 */
function findActiveCatalogEntry(id: string): ModelCatalogEntry | undefined {
  const { catalog } = getActiveModelCatalogSync();
  return catalog.entries.find((entry) => entry.id === id);
}

/** Active snapshot provenance for diagnostics (non-secret). */
export function getActiveModelCatalogProvenance(): ModelCatalogProvenance {
  return getActiveModelCatalogSync().provenance;
}

/**
 * Derive the local `AssistantModelConfig`-shaped config used by
 * {@link resolveAvailability}. The active snapshot is published truth; the
 * checked-in catalog is the runtime snapshot fallback.
 */
function resolveCatalogConfig(
  id: string,
  entry: ModelCatalogEntry | undefined,
): AssistantModelConfig | undefined {
  if (entry) {
    const base = {
      id: entry.id,
      displayName: entry.displayName,
      priority: entry.priority,
      enabled: entry.defaultEnabled,
      costCoefficient: entry.cost.coefficient,
    };
    if (entry.provider === "venice") {
      return { ...base, routing: entry.routing as VeniceRouting };
    }
    return base;
  }
  return getModelById(id);
}

/** Snapshot-aware modality resolution with local fallback (preserves unknown semantics). */
function resolveModalitiesFor(
  id: string,
  entry: ModelCatalogEntry | undefined,
): {
  input: readonly ResolvedCatalogInputModality[];
  output: readonly ResolvedCatalogOutputModality[];
  veniceHint: VeniceParsedCaps | undefined;
} {
  const resolved = resolveModelCapabilities(id);
  let input = resolved.input as readonly ResolvedCatalogInputModality[];
  const output = resolved.output as readonly ResolvedCatalogOutputModality[];
  let veniceHint: VeniceParsedCaps | undefined;
  if (isVeniceModelId(id)) {
    veniceHint = readVeniceCapabilityHintsSync().get(id);
    // Live Venice metadata enriches legacy rows whose signed entry omitted
    // modalities. An explicit signed modality tuple is authoritative in both
    // directions and cannot be widened or narrowed by the observational cache.
    if (!entry?.modalities && veniceHint?.vision && !input.includes("image")) {
      input = [...input, "image"];
    }
  }
  return { input, output, veniceHint };
}

/**
 * The signed catalog is the only source for generation family/reference facts.
 * A missing reference record remains `null` (unknown), never a fabricated
 * negative capability from a text-only or stale provider response.
 */
function resolveGenerationFor(
  entry: ModelCatalogEntry | undefined,
): ResolvedCatalogModel["generation"] {
  if (!entry?.generation) return null;
  const { generation } = entry;
  const references = generation.references
    ? {
        roles: [...generation.references.roles],
        ...(generation.references.constraints
          ? {
              constraints: {
                ...generation.references.constraints,
                ...(generation.references.constraints.allowedMimeTypes
                  ? { allowedMimeTypes: [...generation.references.constraints.allowedMimeTypes] }
                  : {}),
              },
            }
          : {}),
      }
    : null;
  const constraints = generation.constraints
    ? {
        ...generation.constraints,
        ...(generation.constraints.resolutions
          ? { resolutions: [...generation.constraints.resolutions] }
          : {}),
        ...(generation.constraints.aspectRatios
          ? { aspectRatios: [...generation.constraints.aspectRatios] }
          : {}),
        ...(generation.constraints.outputMimeTypes
          ? { outputMimeTypes: [...generation.constraints.outputMimeTypes] }
          : {}),
      }
    : null;
  return { family: generation.family, references, constraints };
}

/** Snapshot-aware feature resolution with local fallback (preserves unknown → null). */
function resolveFeaturesFor(
  id: string,
  entry: ModelCatalogEntry | undefined,
): ResolvedCatalogFeatures {
  // Decision capability facts are not chat/tool capabilities. An observational
  // provider cache must never fill in chat features for this separate workload.
  if (entry?.workload === "decision") {
    return {
      tools: null,
      structuredOutputs: null,
      reasoning: null,
      visualGrounding: null,
      webSearch: null,
      e2ee: null,
    };
  }
  if (entry?.features) {
    const resolved = resolveModelCapabilities(id);
    const features = resolved.features ?? entry.features;
    return {
      tools: features.tools,
      structuredOutputs: features.structuredOutputs,
      reasoning: features.reasoning,
      visualGrounding: features.visualGrounding ?? null,
      webSearch: null,
      e2ee: null,
    };
  }
  return resolveFeatures(id);
}

/**
 * Resolve a single catalog row by exact id. Signed snapshot ids resolve.
 * Truly unknown or legacy custom ids return `availability: "unknown_model"` so
 * exact-call validation can distinguish "not in catalog" from "missing
 * credentials".
 *
 * Never awaits a fetch — all sources are sync / cache-backed. Remote
 * metadata can add/correct descriptive fields but can never supply URLs /
 * credentials, make China routing consent true, or make an unsupported
 * provider runnable .
 */
export function resolveCatalogModel(
  id: string,
  options: ResolveCatalogModelOptions = {},
): ResolvedCatalogModel {
  const env = options.env ?? process.env;
  const entry = findActiveCatalogEntry(id);
  const config = resolveCatalogConfig(id, entry);

  if (!config) {
    return {
      id,
      displayName: id,
      provider: getProviderFromModelId(id),
      availability: "unknown_model",
      unavailableReason: "model is not present in the current signed catalog",
      routing: null,
      input: ["text"],
      output: ["text"],
      workload: "chat",
      generation: null,
      decision: null,
      features: {
        tools: null,
        structuredOutputs: null,
        reasoning: null,
        visualGrounding: null,
        webSearch: null,
        e2ee: null,
      },
      privacyGrade: null,
      privacyLabel: null,
      intelligenceTier: null,
      intelligenceRank: null,
      costCoefficient: getCostCoefficient(id),
      contextTokens: null,
      maxOutputTokens: null,
      provenance: null,
      lastVerifiedAt: null,
    };
  }

  const veniceSnapshot = isVeniceModelId(id) ? readVeniceCatalogSnapshotSync() : null;
  const baseAvailability = resolveAvailability(
    config,
    id,
    env,
    resolveChinaUpstreamConsent(options.allowChinaUpstream, env),
    entry?.workload ?? "chat",
  );
  const { availability, reason } = refineVeniceAvailability(baseAvailability, id, veniceSnapshot);
  const { input, output, veniceHint } = resolveModalitiesFor(id, entry);
  const workload = entry?.workload ?? "chat";
  const generation = resolveGenerationFor(entry);
  const features = resolveFeaturesFor(id, entry);
  // Descriptive axes prefer the published snapshot; fall back to local tables
  // for dynamic ids not present in the snapshot.
  const tier: ResolvedCatalogModel["intelligenceTier"] = entry
    ? (entry.intelligence?.tier ?? null)
    : (MODEL_INTELLIGENCE_TIER[id] ?? null);
  const privacyGrade: number | null = entry ? entry.privacy.grade : (MODEL_PRIVACY_GRADE[id] ?? null);
  const costCoefficient: number = entry ? entry.cost.coefficient : getCostCoefficient(id);
  const contextTokens: number | null = workload !== "chat"
    ? null
    : entry?.limits
    ? entry.limits.contextTokens
    : getDescriptiveModelContextTokens(id);
  const maxOutputTokens: number | null = workload !== "chat"
    ? null
    : entry?.limits
    ? entry.limits.outputTokens
    : getKnownModelMaxOutputTokens(id);
  // Provenance: prefer the published capabilityProvenance; fall back to the
  // local model-capabilities resolver for ids the snapshot doesn't assert.
  const resolved = resolveModelCapabilities(id);
  const isCurated = ASSISTANT_MODELS.some((m) => m.id === id);
  const provenance: ResolvedCatalogProvenance | null = entry
    ? (entry.capabilityProvenance ?? mapProvenance(resolved.provenance, Boolean(veniceHint), isCurated))
    : mapProvenance(resolved.provenance, Boolean(veniceHint), isCurated);

  const row: ResolvedCatalogModel = {
    id,
    displayName: config.displayName,
    provider: getProviderFromModelId(id),
    availability,
    ...(reason !== undefined ? { unavailableReason: reason } : {}),
    routing: routingToClass(config.routing),
    input,
    output,
    workload,
    generation,
    decision: entry?.decision ? { ...entry.decision, operations: [...entry.decision.operations] } : null,
    features,
    privacyGrade,
    privacyLabel: entry?.privacy.label ?? null,
    intelligenceTier: tier,
    intelligenceRank: tier ? INTELLIGENCE_RANK[tier] : null,
    costCoefficient,
    contextTokens,
    maxOutputTokens,
    provenance,
    lastVerifiedAt: veniceSnapshot?.models.has(id.slice("venice:".length))
      ? veniceSnapshot.fetchedAt
      : (resolved.lastVerifiedAt ?? null),
  };

  // Warm the venice cache asynchronously (never awaited; rows use current cache).
  if (isVeniceModelId(id)) {
    scheduleVeniceCatalogRefreshIfNeeded();
  }

  return row;
}

/**
 * List resolved catalog rows for every entry in the active released snapshot
 * (validated remote catalog, or the checked-in fallback when no remote
 * snapshot is hydrated). Per , dynamic/arbitrary ids are excluded from
 * the v1 list (they remain resolvable via {@link resolveCatalogModel}).
 * Unavailable rows are omitted unless `includeUnavailable` is set. Sorted by
 * priority then id, matching the legacy picker ordering. A newly published
 * supported row appears here without a server restart once the runtime seam
 * has hydrated/refreshed the snapshot.
 */
export function listResolvedCatalogModels(
  options: ResolveCatalogModelOptions = {},
): ResolvedCatalogModel[] {
  const { includeUnavailable = false } = options;
  const { catalog } = getActiveModelCatalogSync();
  const out: ResolvedCatalogModel[] = [];
  for (const entry of catalog.entries) {
    const row = resolveCatalogModel(entry.id, options);
    if (row.availability !== "selectable" && !includeUnavailable) continue;
    out.push(row);
  }
  return out.sort((a, b) => {
    const pa = findActiveCatalogEntry(a.id)?.priority ?? getModelById(a.id)?.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = findActiveCatalogEntry(b.id)?.priority ?? getModelById(b.id)?.priority ?? Number.MAX_SAFE_INTEGER;
    return pa - pb || a.id.localeCompare(b.id);
  });
}
