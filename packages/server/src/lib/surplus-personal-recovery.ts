import type { ForegroundChatFundingSession } from "@nautilo/agent";
import {
  ModelFundingError,
  resolveModelFunding,
  withAdmittedPersonalCredential,
  type ModelFundingDecision,
  type ModelFundingDeps,
  type ModelFundingWorkload,
} from "./model-funding";

export type SurplusPersonalRecoveryWorkload = Exclude<ModelFundingWorkload, "memory">;

export type SurplusPersonalRecoveryInput = Readonly<{
  humanUserId: string;
  modelId: string;
  workload: SurplusPersonalRecoveryWorkload;
  primaryDecision: ModelFundingDecision;
  /** Rechecks the original authority and pinned server Surplus admission. */
  recheckPrimary: () => Promise<ModelFundingDecision>;
}>;

function assertPrimary(input: SurplusPersonalRecoveryInput, current: ModelFundingDecision): void {
  const original = input.primaryDecision;
  if (original.kind !== "server" || original.providerRoute !== "surplus"
    || original.humanUserId !== input.humanUserId || original.modelId !== input.modelId
    || original.workload !== input.workload || current.kind !== "server"
    || current.providerRoute !== "surplus" || current.humanUserId !== original.humanUserId
    || current.modelId !== original.modelId || current.workload !== original.workload) {
    throw new ModelFundingError("funding_source_changed");
  }
}

function usageFundingFor(decision: Extract<ModelFundingDecision, { kind: "personal" }>) {
  return {
    kind: "personal" as const,
    humanUserId: decision.humanUserId,
    payerHumanId: decision.payerHumanId,
    providerRoute: decision.providerRoute,
    credentialId: decision.credentialId,
    credentialRevision: decision.credentialRevision,
  };
}

/**
 * Opens the one permitted cross-payer recovery: an exact-model personal
 * direct attempt after the caller has established an unanswered server
 * Surplus attempt. This request-local session cannot be serialized or spawn
 * separately funded child work.
 */
export async function openSurplusPersonalDirectRecovery(
  input: SurplusPersonalRecoveryInput,
  deps?: ModelFundingDeps,
): Promise<ForegroundChatFundingSession> {
  const resolve = (priorDecision?: ModelFundingDecision) => resolveModelFunding({
    humanUserId: input.humanUserId,
    modelId: input.modelId,
    workload: input.workload,
    fundingKind: "personal",
    directOnly: true,
    ...(priorDecision ? { priorDecision } : {}),
  }, deps);
  const admitted = await resolveSurplusPersonalDirectRecovery(input, deps);

  const resolveCurrent = async (modelId: string, transport?: "direct" | "surplus") => {
    if (modelId !== input.modelId || transport === "surplus") {
      throw new ModelFundingError("funding_source_changed");
    }
    assertPrimary(input, await input.recheckPrimary());
    const current = await resolve(admitted);
    if (current.kind !== "personal" || current.providerRoute !== admitted.providerRoute
      || current.credentialId !== admitted.credentialId
      || current.credentialRevision !== admitted.credentialRevision) {
      throw new ModelFundingError("personal_credential_stale");
    }
    return current;
  };

  return {
    kind: "personal",
    ...(input.workload === "research" || input.workload === "decision"
      || input.workload === "image_assistance" ? { workload: input.workload } : {}),
    async recheckAttempt(modelId, transport) {
      await resolveCurrent(modelId, transport);
    },
    async runAttempt(modelId, run, transport) {
      const current = await resolveCurrent(modelId, transport);
      return withAdmittedPersonalCredential(current,
        (personalCredential) => run({ usageFunding: usageFundingFor(current), personalCredential }),
        deps, admitted);
    },
  };
}

/** Resolve and pin the non-secret personal direct decision for a safe caller-owned boundary. */
export async function resolveSurplusPersonalDirectRecovery(
  input: SurplusPersonalRecoveryInput,
  deps?: ModelFundingDeps,
): Promise<Extract<ModelFundingDecision, { kind: "personal" }>> {
  if ((input.workload as ModelFundingWorkload) === "memory") {
    throw new ModelFundingError("unsupported_workload");
  }
  assertPrimary(input, await input.recheckPrimary());
  const admitted = await resolveModelFunding({
    humanUserId: input.humanUserId,
    modelId: input.modelId,
    workload: input.workload,
    fundingKind: "personal",
    directOnly: true,
  }, deps);
  if (admitted.kind !== "personal" || admitted.providerRoute === "surplus"
    || admitted.providerRoute === "openai-chatgpt") {
    throw new ModelFundingError("funding_source_changed");
  }
  return admitted;
}
