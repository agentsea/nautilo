import type {
  ModelCatalogEntry,
  ModelCatalogReasoningControl,
  ModelCatalogReasoningEffort,
  ModelCatalogServingControl,
  ModelCatalogServingProfile,
  ModelControlSelection,
} from "@nautilo/types";
export type { ModelControlSelection } from "@nautilo/types";

/**
 * D462's pure catalog + policy + preference resolver. The catalog shape is
 * composed from the shared signed-catalog contract, including its explicit
 * `off` value for persisted/requested disablement.
 */

/**
 * Minimal hydrated catalog projection consumed by this resolver. It derives
 * every control field from the signed shared contract while deliberately
 * excluding provenance, selectors, labels, and prices that resolution does
 * not need to inspect.
 */
export type ModelControlCatalogEntry = Pick<ModelCatalogEntry, "id"> & {
  readonly controls?: {
    readonly reasoning?: Pick<
      ModelCatalogReasoningControl,
      "levels" | "defaultLevel" | "canDisable" | "mandatory"
    > | undefined;
    readonly serving?: Pick<ModelCatalogServingControl, "defaultProfile"> & {
      readonly profiles: readonly Pick<ModelCatalogServingProfile, "id">[];
    } | undefined;
  } | undefined;
};

/** Policy cannot add a capability; it can only deny or narrow catalog values. */
export interface ModelControlPolicy {
  readonly reasoningEnabled?: boolean;
  readonly allowedReasoningEfforts?: readonly ModelCatalogReasoningEffort[];
  readonly defaultReasoningEffort?: ModelCatalogReasoningEffort;
  readonly allowedServingProfileIds?: readonly string[];
  readonly defaultServingProfileId?: string;
}

export interface ResolveModelControlSelectionInput {
  /** O(1) lookup keyed by canonical model ID. */
  readonly catalogByModelId: ReadonlyMap<string, ModelControlCatalogEntry>;
  readonly policyByModelId?: ReadonlyMap<string, ModelControlPolicy>;
  readonly turnOverride?: ModelControlSelection | null;
  readonly roomAgentOverride?: ModelControlSelection | null;
  readonly agentDefault?: ModelControlSelection | null;
  readonly serverDefault?: ModelControlSelection | null;
  /** The model selected when every persisted scope is absent. */
  readonly catalogDefaultModelId: string;
}

export type ModelControlSelectionSource =
  | "turn"
  | "room-agent"
  | "agent"
  | "server"
  | "catalog";

export type ModelControlStaleReason =
  | "unknown-model"
  | "reasoning-not-supported"
  | "unsupported-reasoning-effort"
  | "serving-not-supported"
  | "unsupported-serving-profile"
  | "invalid-catalog-default";

export type ModelControlBlockedReason =
  | "reasoning-disabled-by-policy"
  | "reasoning-effort-not-allowed"
  | "serving-profile-not-allowed"
  | "invalid-policy-default";

interface ModelControlResolutionBase {
  readonly source: ModelControlSelectionSource;
  readonly requested: ModelControlSelection;
}

export interface ResolvedModelControlSelection extends ModelControlResolutionBase {
  readonly status: "resolved";
  readonly effective: ModelControlSelection;
}

export interface StaleModelControlSelection extends ModelControlResolutionBase {
  readonly status: "stale";
  readonly reason: ModelControlStaleReason;
  readonly axis?: "reasoning" | "serving";
}

export interface BlockedModelControlSelection extends ModelControlResolutionBase {
  readonly status: "blocked";
  readonly reason: ModelControlBlockedReason;
  readonly axis: "reasoning" | "serving";
}

export type ModelControlResolution =
  | ResolvedModelControlSelection
  | StaleModelControlSelection
  | BlockedModelControlSelection;

function chooseRequested(input: ResolveModelControlSelectionInput): {
  source: ModelControlSelectionSource;
  selection: ModelControlSelection;
} {
  if (input.turnOverride) return { source: "turn", selection: input.turnOverride };
  if (input.roomAgentOverride) return { source: "room-agent", selection: input.roomAgentOverride };
  if (input.agentDefault) return { source: "agent", selection: input.agentDefault };
  if (input.serverDefault) return { source: "server", selection: input.serverDefault };
  return { source: "catalog", selection: { modelId: input.catalogDefaultModelId } };
}

function stale(
  source: ModelControlSelectionSource,
  requested: ModelControlSelection,
  reason: ModelControlStaleReason,
  axis?: "reasoning" | "serving",
): StaleModelControlSelection {
  return { status: "stale", source, requested, reason, ...(axis ? { axis } : {}) };
}

function blocked(
  source: ModelControlSelectionSource,
  requested: ModelControlSelection,
  reason: ModelControlBlockedReason,
  axis: "reasoning" | "serving",
): BlockedModelControlSelection {
  return { status: "blocked", source, requested, reason, axis };
}

/**
 * Resolve one immutable selection. It makes no database or network calls and
 * never silently replaces a stale/blocked requested choice. Callers resolving
 * a fallback hop must call it again with the fallback target's own scopes.
 */
export function resolveModelControlSelection(
  input: ResolveModelControlSelectionInput,
): ModelControlResolution {
  const { source, selection: requested } = chooseRequested(input);
  const entry = input.catalogByModelId.get(requested.modelId);
  if (!entry) return stale(source, requested, "unknown-model");
  const policy = input.policyByModelId?.get(entry.id);
  const reasoning = entry.controls?.reasoning;
  const serving = entry.controls?.serving;

  let reasoningEffort: ModelCatalogReasoningEffort | undefined;
  if (requested.reasoningEffort !== undefined) {
    if (!reasoning) return stale(source, requested, "reasoning-not-supported", "reasoning");
    if (requested.reasoningEffort === "off") {
      if (!reasoning.canDisable || reasoning.mandatory) {
        return stale(source, requested, "unsupported-reasoning-effort", "reasoning");
      }
    } else if (!reasoning.levels.includes(requested.reasoningEffort)) {
      return stale(source, requested, "unsupported-reasoning-effort", "reasoning");
    }
    reasoningEffort = requested.reasoningEffort;
  } else if (reasoning) {
    reasoningEffort = policy?.defaultReasoningEffort ?? reasoning.defaultLevel;
    if (reasoningEffort === "off") {
      if (!reasoning.canDisable || reasoning.mandatory) {
        return policy?.defaultReasoningEffort === "off"
          ? blocked(source, requested, "invalid-policy-default", "reasoning")
          : stale(source, requested, "invalid-catalog-default", "reasoning");
      }
    } else if (!reasoning.levels.includes(reasoningEffort)) {
      return policy?.defaultReasoningEffort !== undefined
        ? blocked(source, requested, "invalid-policy-default", "reasoning")
        : stale(source, requested, "invalid-catalog-default", "reasoning");
    }
  }

  if (reasoningEffort !== undefined) {
    if (policy?.reasoningEnabled === false) {
      return blocked(source, requested, "reasoning-disabled-by-policy", "reasoning");
    }
    if (
      policy?.allowedReasoningEfforts !== undefined &&
      !policy.allowedReasoningEfforts.includes(reasoningEffort)
    ) {
      return blocked(source, requested, "reasoning-effort-not-allowed", "reasoning");
    }
  }

  let servingProfileId: string | undefined;
  if (requested.servingProfileId !== undefined) {
    if (!serving) return stale(source, requested, "serving-not-supported", "serving");
    if (!serving.profiles.some((profile) => profile.id === requested.servingProfileId)) {
      return stale(source, requested, "unsupported-serving-profile", "serving");
    }
    servingProfileId = requested.servingProfileId;
  } else if (serving) {
    servingProfileId = policy?.defaultServingProfileId ?? serving.defaultProfile;
    if (!serving.profiles.some((profile) => profile.id === servingProfileId)) {
      return policy?.defaultServingProfileId !== undefined
        ? blocked(source, requested, "invalid-policy-default", "serving")
        : stale(source, requested, "invalid-catalog-default", "serving");
    }
  }

  if (
    servingProfileId !== undefined &&
    policy?.allowedServingProfileIds !== undefined &&
    !policy.allowedServingProfileIds.includes(servingProfileId)
  ) {
    return blocked(source, requested, "serving-profile-not-allowed", "serving");
  }

  return {
    status: "resolved",
    source,
    requested,
    effective: {
      modelId: entry.id,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(servingProfileId === undefined ? {} : { servingProfileId }),
    },
  };
}
