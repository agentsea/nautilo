/**
 * shared model list for Workbench, server routes, and future .
 * Types only live here; orchestration uses `@nautilo/agent` (catalog + env) so we avoid
 * a circular dependency (`@nautilo/agent` already depends on `@nautilo/trust`).
 */

export type InferenceTier = "open-book" | "private" | "paranoid" | "local";

export type RoutingClass = "venice-hosted" | "western-anonymized" | "china-anonymized" | "unknown";

export type ModelAvailability =
  | "selectable"
  | "missing-key"
  | "filtered"
  | "unsupported-capability"
  | "unknown-model";

/**
 * The execution shape a model is being considered for. Availability is not a
 * global boolean: a text-only model can be runnable for chat while being
 * unavailable for vision or image generation.
 */
export type ModelPurpose =
  | "chat"
  | "chat-tools"
  | "vision"
  | "vision-tools"
  | "image-generation"
  | "embeddings"
  | "task-tool-free"
  | "task-tools";

/**
 * coarse intelligence tier. Canonical home is `@nautilo/trust`
 * (below every consumer) so the resolved catalog type can reference it without
 * pulling `@nautilo/agent`. `@nautilo/agent` re-exports this same union from
 * `config/model-selection` to keep existing import paths stable; the unions are
 * structurally identical so the agent builder assigns cleanly.
 */
export type IntelligenceTier = "frontier" | "strong" | "mid" | "small";

/**
 * machine-readable availability for a resolved catalog row.
 * Stable string reasons consumed by Genie discovery + exact-call validation.
 * `selectable` = runnable AND not routing-filtered AND not disabled.
 */
export type ResolvedCatalogAvailability =
  | "selectable"
  | "missing_credentials"
  | "routing_filtered"
  | "disabled"
  | "unknown_model";

/**
 * where this row's capability metadata came from. Mirrors
 * `@nautilo/model-capabilities` `CapabilityProvenance` plus a `catalog` value
 * for rows whose only source is the checked-in `ASSISTANT_MODELS` table.
 */
export type ResolvedCatalogProvenance =
  | "override"
  | "openrouter"
  | "smoke"
  | "default"
  | "catalog";

/**
 * modalities a model accepts / emits. Structurally identical to
 * `@nautilo/model-capabilities` `ModelInputModality` / `ModelOutputModality`;
 * duplicated here only because `@nautilo/trust` cannot depend on
 * `@nautilo/model-capabilities` (it sits below it). The agent builder maps the
 * model-capabilities values directly (no conversion needed).
 */
export type ResolvedCatalogInputModality = "text" | "image" | "file";
export type ResolvedCatalogOutputModality = "text" | "image" | "audio" | "video" | "embedding";

/** Only chat rows are candidates for chat routing. */
export type ResolvedCatalogWorkload = "chat" | "generation" | "decision" | "speech";
export interface ResolvedCatalogDecision {
  operations: readonly ["choice"];
  inputTokens: number;
  maxChoices: number;
}
export type ResolvedCatalogGenerationFamily = "image" | "video" | "music";
/** Provider input kinds, not Human-authored creative labels. */
export type ResolvedCatalogReferenceRole = "image" | "video" | "audio";

export interface ResolvedCatalogReferenceConstraints {
  maxCount?: number | undefined;
  maxBytes?: number | undefined;
  maxDurationSeconds?: number | undefined;
  allowedMimeTypes?: readonly string[] | undefined;
}

/** `null` means the catalog has no evidence either way; it is not a denial. */
export interface ResolvedCatalogReferenceCapabilities {
  roles: readonly ResolvedCatalogReferenceRole[];
  constraints?: ResolvedCatalogReferenceConstraints | undefined;
}

export interface ResolvedCatalogGenerationConstraints {
  promptCharacters?: { min: number; max: number } | undefined;
  durationSeconds?: { min: number; max: number } | undefined;
  resolutions?: readonly string[] | undefined;
  aspectRatios?: readonly string[] | undefined;
  audio?: "configurable" | "provider-managed" | "instrumental" | "lyrics-or-instrumental" | undefined;
  lyricsCharacters?: { min: number; max: number } | undefined;
  outputMimeTypes?: readonly string[] | undefined;
}

export interface ResolvedCatalogGeneration {
  family: ResolvedCatalogGenerationFamily;
  /** `null` is unknown; callers must not turn it into `false`. */
  references: ResolvedCatalogReferenceCapabilities | null;
  constraints: ResolvedCatalogGenerationConstraints | null;
}

/**
 * feature flags with an explicit `null` for "unknown / not yet
 * verified". `null` is distinct from `false`: a `false` value is a positive
 * claim "this model does NOT support X", while `null` means the catalog has no
 * evidence either way. Per , unknown is never silently coerced to false.
 */
export interface ResolvedCatalogFeatures {
  tools: boolean | null;
  structuredOutputs: boolean | null;
  reasoning: boolean | null;
  /** Screenshot-to-target coordinate grounding support; absent/null means unknown. */
  visualGrounding?: boolean | null | undefined;
  webSearch: boolean | null;
  e2ee: boolean | null;
}

/**
 * one non-secret, server-side resolved catalog row. Rich
 * enough for Genie discovery and exact-call validation. Composed by
 * `@nautilo/agent` from existing sources (ASSISTANT_MODELS, model-capabilities
 * resolver, privacy grades, intelligence tiers, cost coefficients, sync token
 * limits, credential detection) — it does NOT duplicate provider parsing or
 * metadata tables. All accessors are local / cache-backed: list/get never
 * awaits a network fetch ( decision; verified by a fetch-throws test).
 */
export interface ResolvedCatalogModel {
  // --- identity ---
  id: string;
  displayName: string;
  /** First segment of `provider:rest` ids; `"unknown"` for legacy bare ids. */
  provider: string;

  // --- runnable state + reason ---
  availability: ResolvedCatalogAvailability;
  unavailableReason?: string | undefined;

  // --- routing (separate from credentials; null = not a routed SKU) ---
  routing: RoutingClass | null;

  // --- modalities ---
  input: readonly ResolvedCatalogInputModality[];
  output: readonly ResolvedCatalogOutputModality[];
  /** Chat vs non-chat execution surface. */
  workload: ResolvedCatalogWorkload;
  /** Present only for generation rows. */
  generation: ResolvedCatalogGeneration | null;
  /** Absent on older projections; only decision rows carry these facts. */
  decision?: ResolvedCatalogDecision | null;

  // --- features (null = unknown) ---
  features: ResolvedCatalogFeatures;

  // --- privacy / intelligence / cost axes ---
  /** 1 (least private) .. 10 (most private); null = no curated grade. */
  privacyGrade: number | null;
  /** Explicit provider/catalog privacy label, not inferred from the grade. */
  privacyLabel: "standard" | "anonymized" | "e2ee" | null;
  intelligenceTier: IntelligenceTier | null;
  intelligenceRank: number | null;
  costCoefficient: number;

  // --- limits (null when not synchronously reachable; see phase-1 doc 1.2.3) ---
  contextTokens: number | null;
  maxOutputTokens: number | null;

  // --- provenance / last verification ---
  provenance: ResolvedCatalogProvenance | null;
  /** ISO-8601 of last successful smoke / cache verification, if any. */
  lastVerifiedAt: string | null;
}

/** options for resolve/list resolved catalog helpers. */
export interface ResolveCatalogModelOptions {
  includeUnavailable?: boolean;
  allowChinaUpstream?: boolean;
  /** Override the credential environment (tests / server injection). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface EligibleModelCapabilities {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  e2ee: boolean;
  webSearch: boolean;
}

/**
 * provider-neutral reasoning controls safe for discovery clients.
 * These values are catalog choice values, never a provider request shape.
 */
export type EligibleModelReasoningLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type EligibleModelReasoningEffort = EligibleModelReasoningLevel | "off";

export interface EligibleModelReasoningControl {
  levels: readonly EligibleModelReasoningLevel[];
  defaultLevel: EligibleModelReasoningEffort;
  canDisable: boolean;
  mandatory: boolean;
}

/** Human-facing intent for a documented serving option. */
export type EligibleModelServingIntent = "balanced" | "reliability" | "throughput";

/** Published USD prices per one million tokens. Omitted when not documented. */
export interface EligibleModelServingRateCard {
  inputPerMtok: number;
  cachedInputPerMtok: number;
  outputPerMtok: number;
}

/**
 * A public serving choice. `id` is a signed-catalog selection identifier;
 * selector and provenance are deliberately absent because they are resolved
 * only by the server.
 */
export interface EligibleModelServingProfile {
  id: string;
  label: string;
  description?: string;
  intent: EligibleModelServingIntent;
  pricing?: EligibleModelServingRateCard;
}

/** Optional catalog controls for a specific model. V1/model-only rows omit this. */
export interface EligibleModelControls {
  reasoning?: EligibleModelReasoningControl;
  serving?: {
    defaultProfile: string;
    profiles: readonly EligibleModelServingProfile[];
  };
}

export interface EligibleModel {
  id: string;
  displayName: string;
  /** First segment of `provider:rest` ids — duplicated on the wire for grouping without re-parsing. */
  provider: string;
  priority: number;
  costCoefficient: number;
  /**
   * Legacy catalog flag: true when this row can be chosen as the agent default model
   * (`availability === "selectable"`).
   */
  enabled: boolean;
  routing?: RoutingClass;
  capabilities: EligibleModelCapabilities;
  /** public projection of reviewed catalog controls; no provider selectors/provenance. */
  controls?: EligibleModelControls;
  availability: ModelAvailability;
  unavailableReason?: string;
}

export interface GetEligibleModelsOptions {
  /** Reserved — posture/tier filtering when inference-tier UX supplies this (not yet enforced). */
  tier?: InferenceTier;
  includeUnavailable?: boolean;
  allowChinaUpstream?: boolean;
  /** Capability context for this projection. Defaults to ordinary tool-using chat. */
  purpose?: ModelPurpose;
  /** Test/server injection seam. Never serialized to clients. */
  env?: NodeJS.ProcessEnv;
}
