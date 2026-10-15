import {
  getEligibleModels,
  resolveCatalogModel,
  resolveModelPrice,
} from "@nautilo/agent";
import { getCachedServerModelConfigRow } from "@nautilo/db";
import type { PersonalCapabilityPreferences } from "@nautilo/types";
import {
  ModelFundingError,
  resolveModelFunding,
  type ModelFundingDecision,
} from "./model-funding";

export interface ImageUnderstandingModel {
  readonly modelId: string;
  readonly displayName: string;
  readonly provider: string;
}

type CatalogResolver = typeof resolveCatalogModel;

export interface ImageUnderstandingPreferenceDeps {
  readonly listModels?: typeof getEligibleModels;
  readonly resolveCatalog?: CatalogResolver;
  readonly resolvePrice?: typeof resolveModelPrice;
  readonly resolveFunding?: typeof resolveModelFunding;
  readonly validateFunding?: (decision: ModelFundingDecision) => Promise<void>;
  readonly getServerSelection?: () => string | null | undefined;
}

export interface ResolvedImageUnderstandingModel {
  readonly modelId: string;
  readonly preferenceRevision: number;
  readonly funding: ModelFundingDecision;
  /** Safe server configuration snapshot; null means Automatic. */
  readonly serverSelection: string | null;
}

export function isSignedImageUnderstandingModel(
  modelId: string,
  deps: Pick<ImageUnderstandingPreferenceDeps, "resolveCatalog"> = {},
): boolean {
  const model = (deps.resolveCatalog ?? resolveCatalogModel)(modelId, { env: {} });
  return model.availability !== "disabled"
    && model.availability !== "unknown_model"
    && model.workload === "chat"
    && model.input.includes("image")
    && model.output.includes("text");
}

/** Live routing consent is independent of structural catalogue membership. */
export function isImageUnderstandingRoutingAllowed(
  modelId: string,
  deps: Pick<ImageUnderstandingPreferenceDeps, "resolveCatalog"> = {},
): boolean {
  const model = (deps.resolveCatalog ?? resolveCatalogModel)(modelId, {
    env: { NAUTILO_ALLOW_CHINA_UPSTREAM: process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] },
  });
  return model.availability === "selectable" || model.availability === "missing_credentials";
}

export function isImageUnderstandingPrivacyCompatible(
  mainModelId: string | undefined,
  modelId: string,
  deps: Pick<ImageUnderstandingPreferenceDeps, "resolveCatalog"> = {},
): boolean {
  if (mainModelId === undefined) return true;
  const resolve = deps.resolveCatalog ?? resolveCatalogModel;
  const main = resolve(mainModelId, { env: {} });
  // The empty environment deliberately avoids treating ambient credentials as
  // structural metadata. Routing consent is enforced by the funding owner, so
  // a signed routing-filtered main model must not fail this privacy comparison.
  if (main.availability === "disabled" || main.availability === "unknown_model") return false;
  const candidate = resolve(modelId, { env: {} });
  if (main.features.e2ee === true || main.privacyLabel === "e2ee") {
    return candidate.features.e2ee === true || candidate.privacyLabel === "e2ee";
  }
  if (main.privacyLabel === "anonymized") {
    return candidate.privacyLabel === "anonymized"
      || candidate.privacyLabel === "e2ee"
      || candidate.features.e2ee === true;
  }
  return true;
}

export function mainModelRequiresDirectImageUnderstanding(
  mainModelId: string | undefined,
  deps: Pick<ImageUnderstandingPreferenceDeps, "resolveCatalog">,
): boolean {
  if (mainModelId === undefined) return false;
  const main = (deps.resolveCatalog ?? resolveCatalogModel)(mainModelId, { env: {} });
  return main.features.e2ee === true
    || main.privacyLabel === "e2ee"
    || main.privacyLabel === "anonymized";
}

export function listPersonalImageUnderstandingModels(
  deps: Pick<ImageUnderstandingPreferenceDeps, "listModels" | "resolveCatalog"> = {},
): readonly ImageUnderstandingModel[] {
  return (deps.listModels ?? getEligibleModels)({
    purpose: "vision",
    includeUnavailable: true,
    env: {},
  }).filter((model) => isSignedImageUnderstandingModel(model.id, deps))
    .map((model) => ({
      modelId: model.id,
      displayName: model.displayName,
      provider: model.provider,
    }));
}

/** Shared deterministic order for Automatic selection and settings projection. */
export function listOrderedImageUnderstandingModels(
  deps: Pick<ImageUnderstandingPreferenceDeps, "listModels" | "resolveCatalog" | "resolvePrice"> = {},
): readonly ImageUnderstandingModel[] {
  return listPersonalImageUnderstandingModels(deps).map((model) => {
    const price = (deps.resolvePrice ?? resolveModelPrice)(model.modelId).price;
    const cost = price.inputPerMtok + price.outputPerMtok;
    return { model, cost: Number.isFinite(cost) && cost >= 0 ? cost : Number.POSITIVE_INFINITY };
  }).sort((a, b) => a.cost - b.cost || a.model.modelId.localeCompare(b.model.modelId))
    .map(({ model }) => model);
}

function shouldPropagateAutomaticFundingError(error: ModelFundingError): boolean {
  return error.code === "personal_credential_unavailable"
    || error.code === "personal_credential_stale"
    || error.code === "funding_source_changed"
    || error.code === "personal_credentials_forbidden"
    || error.code === "server_credentials_forbidden"
    || error.code === "personal_credentials_disabled";
}

/**
 * Resolve one image-understanding helper from Human preference, server default,
 * or the current cheapest admissible signed vision route. Explicit choices are
 * authoritative and are never silently substituted.
 */
export async function resolveImageUnderstandingModel(
  input: Readonly<{
    humanUserId: string;
    preferences: PersonalCapabilityPreferences;
    parentFundingKind?: "server" | "personal";
    mainModelId?: string;
  }>,
  deps: ImageUnderstandingPreferenceDeps = {},
): Promise<ResolvedImageUnderstandingModel> {
  const serverSelection = (deps.getServerSelection
    ? deps.getServerSelection()
    : getCachedServerModelConfigRow()?.imageUnderstandingModel)?.trim() || null;
  const explicit = input.preferences.overrides.imageUnderstanding?.trim() || serverSelection;
  const models = listOrderedImageUnderstandingModels(deps);
  const candidates = explicit
    ? models.filter((model) => model.modelId === explicit)
    : models;

  if (explicit && candidates.length === 0) throw new ModelFundingError("unsupported_workload");
  for (const candidate of candidates) {
    if (!isImageUnderstandingRoutingAllowed(candidate.modelId, deps)
      || !isImageUnderstandingPrivacyCompatible(input.mainModelId, candidate.modelId, deps)) {
      if (explicit) throw new ModelFundingError("unsupported_workload");
      continue;
    }
    try {
      const funding = await (deps.resolveFunding ?? resolveModelFunding)({
        humanUserId: input.humanUserId,
        modelId: candidate.modelId,
        workload: "image_assistance",
        ...(input.parentFundingKind ? { fundingKind: input.parentFundingKind } : {}),
        ...(mainModelRequiresDirectImageUnderstanding(input.mainModelId, deps)
          ? { transport: "direct" as const }
          : {}),
      });
      await deps.validateFunding?.(funding);
      return {
        modelId: candidate.modelId,
        preferenceRevision: input.preferences.revision,
        funding,
        serverSelection,
      };
    } catch (error) {
      if (!(error instanceof ModelFundingError)) throw error;
      if (explicit || shouldPropagateAutomaticFundingError(error)) throw error;
    }
  }
  throw new ModelFundingError("provider_credentials_missing");
}
