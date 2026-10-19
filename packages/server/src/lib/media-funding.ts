import {
  listMediaGenerationModels, resolveCatalogModel, VENICE_MEDIA_MODELS,
  findSurplusMediaModel,
  type AdmittedCapabilityMedia,
} from "@nautilo/agent";
import {
  isPaidServiceProvider,
  type DurableServiceFundingBinding,
} from "@nautilo/types";
import { resolveSurplusPersonalDirectRecovery } from "./surplus-personal-recovery";
import { ModelFundingError, resolveModelFunding, type ModelFundingDeps, type ModelFundingDecision } from "./model-funding";
import { bindAdmittedServiceFunding, runWithDurableServiceFunding } from "./service-funding";

export type MediaFundingFamily = "image" | "video" | "music";

/** One bounded pre-spend window for media discovery, estimates, and exact quotes. */
export const MEDIA_PRESPEND_TIMEOUT_MS = 10_000;

export interface MediaFundingDependencies {
  readonly resolveFunding?: typeof resolveModelFunding;
  readonly bindFunding?: typeof bindAdmittedServiceFunding;
  readonly runFunding?: typeof runWithDurableServiceFunding;
  readonly findModel?: typeof findSurplusMediaModel;
  readonly resolvePersonalRecovery?: typeof resolveSurplusPersonalDirectRecovery;
}

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
  options?: {
    readonly operation?: "generate" | "edit";
    readonly directOnly?: boolean;
    readonly transport?: "direct";
    readonly prior?: DurableServiceFundingBinding;
    readonly surplusRequirements?: Readonly<{ durationSeconds?: number; aspectRatio?: string; resolution?: string; audio?: boolean }>;
  },
  recheckAuthority: () => Promise<void> = async () => {},
  dependencies: MediaFundingDependencies = {},
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
  const resolveFunding = dependencies.resolveFunding ?? resolveModelFunding;
  const bindFunding = dependencies.bindFunding ?? bindAdmittedServiceFunding;
  const runFunding = dependencies.runFunding ?? runWithDurableServiceFunding;
  const findModel = dependencies.findModel ?? findSurplusMediaModel;
  if (prior && options?.transport === "direct") {
    // A safe provider refusal does not waive the original account binding.
    // Replacing a server key or losing personal custody ends this operation.
    await runFunding(prior, "spend", async () => {});
  }
  const resolveDirect = async (primary: ModelFundingDecision) => {
    try {
      return await resolveFunding({ humanUserId, modelId, workload: "generation", priorDecision: primary, transport: "direct", directOnly: true });
    } catch (error) {
      if (!(error instanceof ModelFundingError) || error.code !== "provider_credentials_missing"
        || primary.kind !== "server" || primary.providerRoute !== "surplus") throw error;
      return (dependencies.resolvePersonalRecovery ?? resolveSurplusPersonalDirectRecovery)({
        humanUserId, modelId, workload: "generation", primaryDecision: primary,
        recheckPrimary: async () => {
          await recheckAuthority();
          return resolveFunding({ humanUserId, modelId, workload: "generation", priorDecision: primary, transport: "surplus" });
        },
      });
    }
  };
  let decision = priorDecision && options?.transport === "direct"
    ? await resolveDirect(priorDecision)
    : await resolveFunding({
    humanUserId, modelId, workload: "generation",
    ...(priorDecision ? { priorDecision } : {}),
    ...(options?.directOnly ? { directOnly: true } : {}),
    ...(options?.transport ? { transport: options.transport } : {}),
  });
  if (!isPaidServiceProvider(decision.providerRoute)) throw new ModelFundingError("unsupported_provider");
  const bindDecision = async (selected: ModelFundingDecision) => {
    if (!isPaidServiceProvider(selected.providerRoute)) throw new ModelFundingError("unsupported_provider");
    if (prior?.provider === selected.providerRoute) return prior;
    if (prior && (options?.transport !== "direct" || prior.provider !== "surplus"
      || (selected.kind !== prior.binding.kind
        && !(prior.binding.kind === "server" && selected.kind === "personal")))) throw new ModelFundingError("funding_source_changed");
    return bindFunding(humanUserId, selected.providerRoute,
      selected.kind === "personal"
        ? { kind: "personal", providerRoute: selected.providerRoute, credentialId: selected.credentialId, credentialRevision: selected.credentialRevision }
        : { kind: "server", providerRoute: selected.providerRoute });
  };
  let funding = await bindDecision(decision);
  if (!prior && funding.provider === "surplus") {
    // A content-free lookup uses the admitted account. Unknown catalogue state
    // is not evidence that another model/version may be substituted.
    const found = await runFunding(funding, "spend", ({ apiKey }) => findModel({
      catalogModelId: modelId, family, apiKey,
      signal: AbortSignal.timeout(MEDIA_PRESPEND_TIMEOUT_MS),
      ...(options?.surplusRequirements ? { requirements: options.surplusRequirements } : {}),
    }));
    if (!found) {
      await recheckAuthority();
      await runFunding(funding, "spend", async () => {});
      decision = await resolveDirect(decision);
      // This is before generation or an approval-bound reservation. Only
      // the explicit server-Surplus recovery may admit an own personal key.
      if (decision.kind !== funding.binding.kind
        && !(funding.binding.kind === "server" && decision.kind === "personal")) {
        throw new ModelFundingError("funding_source_changed");
      }
      if (!isPaidServiceProvider(decision.providerRoute) || decision.providerRoute === "surplus") {
        throw new ModelFundingError("funding_source_changed");
      }
      funding = await bindFunding(humanUserId, decision.providerRoute,
        decision.kind === "personal"
          ? { kind: "personal", providerRoute: decision.providerRoute, credentialId: decision.credentialId, credentialRevision: decision.credentialRevision }
          : { kind: "server", providerRoute: decision.providerRoute });
    }
  }
  if (funding.provider !== decision.providerRoute) throw new ModelFundingError("funding_source_changed");
  return {
    modelId, family, funding,
    async runAttempt(run) {
      await recheckAuthority();
      assertMediaFundingModel(modelId, family);
      return runFunding(funding, "spend", run);
    },
  };
}
