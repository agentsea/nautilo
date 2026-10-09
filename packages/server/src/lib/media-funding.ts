import {
  listMediaGenerationModels, resolveCatalogModel, VENICE_MEDIA_MODELS,
  type AdmittedCapabilityMedia,
} from "@nautilo/agent";
import {
  isPaidServiceProvider,
  type DurableServiceFundingBinding,
} from "@nautilo/types";
import { ModelFundingError, resolveModelFunding, type ModelFundingDeps, type ModelFundingDecision } from "./model-funding";
import { bindAdmittedServiceFunding, runWithDurableServiceFunding } from "./service-funding";

export type MediaFundingFamily = "image" | "video" | "music";

/** Structural catalogue admission is independent of server credential presence. */
function assertMediaFundingModel(modelId: string, family: MediaFundingFamily): void {
  const row = resolveCatalogModel(modelId);
  if (row.workload !== "generation" || row.generation?.family !== family
    || !["selectable", "missing_credentials"].includes(row.availability)
    || !(listMediaGenerationModels(family).some((model) => model.id === modelId)
      || (family === "video" && modelId === `venice:${VENICE_MEDIA_MODELS.seedanceReference}`))) {
    throw new ModelFundingError("unsupported_workload");
  }
}

export async function resolveMediaFunding(
  humanUserId: string,
  modelId: string,
  family: MediaFundingFamily,
  projectionDeps?: ModelFundingDeps,
) {
  assertMediaFundingModel(modelId, family);
  return resolveModelFunding({ humanUserId, modelId, workload: "generation" }, projectionDeps);
}

/** One model selection fixes the payer, transport and exact creating credential. */
export async function openMediaFunding(
  humanUserId: string,
  modelId: string,
  family: MediaFundingFamily,
  options?: { readonly operation?: "generate" | "edit"; readonly directOnly?: boolean; readonly prior?: DurableServiceFundingBinding },
  recheckAuthority: () => Promise<void> = async () => {},
): Promise<AdmittedCapabilityMedia> {
  await recheckAuthority();
  assertMediaFundingModel(modelId, family);
  const prior = options?.prior;
  if (prior && prior.humanUserId !== humanUserId) throw new ModelFundingError("funding_source_changed");
  const priorDecision: ModelFundingDecision | undefined = prior
    ? prior.binding.kind === "personal"
      ? { ...prior.binding, humanUserId, payerHumanId: humanUserId, modelId, workload: "generation" }
      : { ...prior.binding, humanUserId, modelId, workload: "generation" }
    : undefined;
  const decision = await resolveModelFunding({
    humanUserId, modelId, workload: "generation",
    ...(priorDecision ? { priorDecision } : {}),
  });
  if (!isPaidServiceProvider(decision.providerRoute)) throw new ModelFundingError("unsupported_provider");
  const funding = prior ?? await bindAdmittedServiceFunding(humanUserId, decision.providerRoute,
    decision.kind === "personal"
      ? { kind: "personal", providerRoute: decision.providerRoute, credentialId: decision.credentialId, credentialRevision: decision.credentialRevision }
      : { kind: "server", providerRoute: decision.providerRoute });
  if (funding.provider !== decision.providerRoute) throw new ModelFundingError("funding_source_changed");
  return {
    modelId, family, funding,
    async runAttempt(run) {
      await recheckAuthority();
      assertMediaFundingModel(modelId, family);
      return runWithDurableServiceFunding(funding, "spend", run);
    },
  };
}
