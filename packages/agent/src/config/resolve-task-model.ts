import { getEligibleModels, resolveRetainedModels } from "./eligible-models";
import {
  COMBO_SPECS,
  modelAxesOf,
  PRIVACY_FLOOR_GRADE,
  SMART_BAND_TOLERANCE,
  CHEAP_BAND_FACTOR,
} from "./model-selection";
import { resolveCatalogModel, resolveChinaUpstreamConsent } from "./resolved-catalog";
import { getActiveModelCatalogSync } from "./model-catalog/runtime-catalog";
import type {
  SelectionProfile,
  SelectionAxis,
  ComboSpec,
  ModelCatalogTaskPreference,
} from "@nautilo/types";

/** Thrown when an absolute band/floor cannot be satisfied by any eligible model. */
export class ModelSelectionError extends Error {
  constructor(public readonly detail: ModelSelectionFailure) {
    super(detail.message);
    this.name = "ModelSelectionError";
  }
}
export interface ModelSelectionFailure {
  message: string;
  profile?: SelectionProfile;
  reason: "privacy_band_empty" | "absolute_floor_empty";
  eligibleCount: number;
  bestPrivacyAvailable: number;
}

export interface ResolveTaskModelInput {
  baseModelId: string;
  profile?: SelectionProfile | null;
  spec?: ComboSpec | null;
  /** Provider-neutral preference asserted by reviewed signed-catalog rows. */
  taskPreference?: ModelCatalogTaskPreference | null;
  /** Explicit routing consent; otherwise the process-level operator setting is used. */
  allowChinaUpstream?: boolean;
}
export interface ResolveTaskModelResult {
  modelId: string;
  taskPreferenceApplied?: ModelCatalogTaskPreference;
}

interface PoolModel {
  id: string;
  priority: number;
  privacy: number;
  smart: number;
  cost: number;
}

/** Direction per axis: privacy↑, smart↑, cheap↓ (lower cost is better). */
function axisVal(m: PoolModel, axis: SelectionAxis): number {
  return axis === "cheap" ? m.cost : axis === "smart" ? m.smart : m.privacy;
}
function better(a: PoolModel, b: PoolModel, axis: SelectionAxis): number {
  const av = axisVal(a, axis),
    bv = axisVal(b, axis);
  return axis === "cheap" ? av - bv : bv - av;
}

export function resolveTaskModel(input: ResolveTaskModelInput): ResolveTaskModelResult {
  const { baseModelId } = input;
  const allowChinaUpstream = resolveChinaUpstreamConsent(input.allowChinaUpstream);
  const defaultSelection = input.spec == null && (input.profile == null || input.profile === "balanced");
  if (defaultSelection && input.taskPreference == null) {
    const base = resolveRetainedModels([baseModelId], { purpose: "task-tools", allowChinaUpstream })[0]!;
    if (base.availability !== "selectable") {
      throw new ModelSelectionError({
        ...(input.profile ? { profile: input.profile } : {}),
        reason: "absolute_floor_empty",
        eligibleCount: 0,
        bestPrivacyAvailable: 0,
        message:
          `The base model "${baseModelId}" is not runnable ` +
          `(${base.unavailableReason ?? base.availability}). Choose a runnable model or configure its provider.`,
      });
    }
    return { modelId: baseModelId };
  }
  const pool: PoolModel[] = getEligibleModels({ purpose: "task-tools", allowChinaUpstream })
    .map((m) => {
      // Eligibility remains authoritative for runnable/tool-capable models.
      // The active resolved catalog owns its reviewed intelligence metadata,
      // which lets newly released catalog rows participate without duplicating
      // their tier in the legacy static compatibility map.
      const resolved = resolveCatalogModel(m.id);
      return { id: m.id, priority: m.priority, ...modelAxesOf(m.id, resolved) };
    });
  if (pool.length === 0) {
    throw new ModelSelectionError({
      ...(input.profile ? { profile: input.profile } : {}),
      reason: "absolute_floor_empty",
      eligibleCount: 0,
      bestPrivacyAvailable: 0,
      message: "No runnable Task model is configured. Ask a server administrator to configure a model provider.",
    });
  }

  if (defaultSelection && input.taskPreference != null) {
    const taskPreference = input.taskPreference;
    const preferredIds = new Set(
      getActiveModelCatalogSync().catalog.entries
        .filter((entry) =>
          "taskPreferences" in entry
          && entry.taskPreferences?.includes(taskPreference)
        )
        .map((entry) => entry.id),
    );
    const preferred = pool
      .filter((model) => preferredIds.has(model.id))
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    if (preferred[0]) {
      return {
        modelId: preferred[0].id,
        taskPreferenceApplied: taskPreference,
      };
    }

    // A preference is deliberately soft. If no reviewed preferred row is
    // runnable, retain balanced's exact base-model semantics instead of
    // silently turning the preference into a different global optimizer.
    const base = resolveRetainedModels([baseModelId], {
      purpose: "task-tools",
      allowChinaUpstream,
    })[0]!;
    if (base.availability !== "selectable") {
      throw new ModelSelectionError({
        ...(input.profile ? { profile: input.profile } : {}),
        reason: "absolute_floor_empty",
        eligibleCount: pool.length,
        bestPrivacyAvailable: Math.max(...pool.map((model) => model.privacy)),
        message:
          `The base model "${baseModelId}" is not runnable ` +
          `(${base.unavailableReason ?? base.availability}). Choose a runnable model or configure its provider.`,
      });
    }
    return { modelId: baseModelId };
  }

  const spec: ComboSpec =
    input.spec ?? COMBO_SPECS[input.profile as Exclude<SelectionProfile, "balanced">];

  let qualifying = pool;
  if (spec.band === "privacy") {
    qualifying = pool.filter((m) => m.privacy >= PRIVACY_FLOOR_GRADE);
  } else if (spec.band === "smart") {
    const best = Math.max(...pool.map((m) => m.smart));
    qualifying = pool.filter((m) => m.smart >= best - SMART_BAND_TOLERANCE);
  } else if (spec.band === "cheap") {
    const cheapest = Math.min(...pool.map((m) => m.cost));
    qualifying = pool.filter((m) => m.cost <= cheapest * CHEAP_BAND_FACTOR);
  }
  const f = spec.absoluteFloors;
  if (f) {
    qualifying = qualifying.filter(
      (m) =>
        (f.privacy == null || m.privacy >= f.privacy) &&
        (f.intelligenceRank == null || m.smart >= f.intelligenceRank) &&
        (f.maxCost == null || m.cost <= f.maxCost),
    );
  }

  if (qualifying.length === 0) {
    const bestPrivacy = Math.max(...pool.map((m) => m.privacy));
    throw new ModelSelectionError({
      ...(input.profile ? { profile: input.profile } : {}),
      reason: spec.band === "privacy" ? "privacy_band_empty" : "absolute_floor_empty",
      eligibleCount: pool.length,
      bestPrivacyAvailable: bestPrivacy,
      message: buildFailureMessage(input.profile ?? undefined, spec, pool.length, bestPrivacy),
    });
  }

  const order: SelectionAxis[] = [spec.objective];
  if (spec.band && spec.band !== spec.objective) order.push(spec.band);
  for (const a of ["privacy", "smart", "cheap"] as SelectionAxis[])
    if (!order.includes(a)) order.push(a);

  qualifying.sort((a, b) => {
    for (const axis of order) {
      const d = better(a, b, axis);
      if (d !== 0) return d;
    }
    return a.id.localeCompare(b.id);
  });
  return { modelId: qualifying[0]!.id };
}

/**
 * Create-time validator: the same logic with a try/catch. Returns the failure
 * detail instead of throwing so tool/HTTP layers can surface a clean message
 * before the row is inserted.
 */
export function validateTaskModelSelection(
  input: ResolveTaskModelInput,
): ModelSelectionFailure | null {
  try {
    resolveTaskModel(input);
    return null;
  } catch (e) {
    if (e instanceof ModelSelectionError) return e.detail;
    throw e;
  }
}

function buildFailureMessage(
  profile: SelectionProfile | undefined,
  spec: ComboSpec,
  eligibleCount: number,
  bestPrivacy: number,
): string {
  const which = profile ? `the "${profile}" profile` : "the requested model-selection constraints";
  const need =
    spec.band === "privacy"
      ? `a model with privacy grade ≥ ${PRIVACY_FLOOR_GRADE} (best available is ${bestPrivacy})`
      : `the requested absolute floor(s)`;
  return (
    `No configured model can satisfy ${which}: needs ${need}. ` +
    `${eligibleCount} model(s) have credentials configured. ` +
    `Relax the ask (drop the profile, or pick a smart/cheap combo with no privacy floor) ` +
    `or ask a server administrator to configure a private model provider.`
  );
}
