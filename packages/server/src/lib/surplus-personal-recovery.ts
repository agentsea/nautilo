import type { ForegroundChatFundingSession } from "@nautilo/agent";
import {
  ModelFundingError,
  readModelFundingPolicy,
  resolveModelFunding,
  withAdmittedPersonalCredential,
  type ModelFundingDecision,
  type ModelFundingDeps,
  type ModelFundingWorkload,
} from "./model-funding";

export type SurplusPersonalRecoveryWorkload = Exclude<ModelFundingWorkload, "memory">;

export type ServerFirstPersonalRecoveryWorkload = Exclude<ModelFundingWorkload, "memory">;

export type ServerFirstPersonalRecoveryInput = Readonly<{
  humanUserId: string;
  modelId: string;
  workload: ServerFirstPersonalRecoveryWorkload;
  primaryDecision: ModelFundingDecision;
  allowUnpinnedSurplusRetry?: true;
  /** Rechecks the initiating operation's authority and exact primary server route. */
  recheckPrimary: () => Promise<ModelFundingDecision>;
}>;

export type SurplusPersonalRecoveryInput = Readonly<{
  humanUserId: string;
  modelId: string;
  workload: SurplusPersonalRecoveryWorkload;
  primaryDecision: ModelFundingDecision;
  allowUnpinnedSurplusRetry?: true;
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

function assertServerPrimary(
  input: ServerFirstPersonalRecoveryInput,
  current: ModelFundingDecision,
): void {
  const original = input.primaryDecision;
  if (original.kind !== "server" || original.humanUserId !== input.humanUserId
    || original.modelId !== input.modelId || original.workload !== input.workload
    || current.kind !== "server" || current.providerRoute !== original.providerRoute
    || current.humanUserId !== original.humanUserId || current.modelId !== original.modelId
    || current.workload !== original.workload) {
    throw new ModelFundingError("funding_source_changed");
  }
}

function assertPinnedPersonal(
  admitted: Extract<ModelFundingDecision, { kind: "personal" }>,
  current: ModelFundingDecision,
): asserts current is Extract<ModelFundingDecision, { kind: "personal" }> {
  if (current.kind !== "personal" || current.humanUserId !== admitted.humanUserId
    || current.payerHumanId !== admitted.payerHumanId || current.modelId !== admitted.modelId
    || current.workload !== admitted.workload || current.providerRoute !== admitted.providerRoute) {
    throw new ModelFundingError("funding_source_changed");
  }
  if (current.credentialId !== admitted.credentialId
    || current.credentialRevision !== admitted.credentialRevision) {
    throw new ModelFundingError("personal_credential_stale");
  }
}

async function assertServerFirstPrimary(
  input: ServerFirstPersonalRecoveryInput,
  deps?: ModelFundingDeps,
): Promise<void> {
  if ((input.workload as ModelFundingWorkload) === "memory") {
    throw new ModelFundingError("unsupported_workload");
  }
  assertServerPrimary(input, await input.recheckPrimary());
  if ((await readModelFundingPolicy(deps)).fundingPreference !== "server_first") {
    throw new ModelFundingError("funding_source_changed");
  }
}

/**
 * Opens the exact-model personal sequence that may follow a fully unanswered
 * server-first sequence. The initial personal API-key route follows live
 * policy. A personal Surplus key remains pinned until an explicit direct
 * transition pins the model provider's own key at its separate revision.
 */
export async function openServerFirstPersonalRecovery(
  input: ServerFirstPersonalRecoveryInput,
  deps?: ModelFundingDeps,
): Promise<ForegroundChatFundingSession> {
  const resolvePersonal = (
    priorDecision?: ModelFundingDecision,
    transport?: "direct" | "surplus",
  ) => resolveModelFunding({
    humanUserId: input.humanUserId,
    modelId: input.modelId,
    workload: input.workload,
    fundingKind: "personal",
    apiKeyOnly: true,
    ...(priorDecision ? { priorDecision } : {}),
    ...(transport ? { transport } : {}),
  }, deps);

  await assertServerFirstPrimary(input, deps);
  const initial = await resolvePersonal();
  if (initial.kind !== "personal" || initial.providerRoute === "openai-chatgpt") {
    throw new ModelFundingError("funding_source_changed");
  }
  const admitted = initial;
  let directAdmitted: Extract<ModelFundingDecision, { kind: "personal" }> | undefined;

  const resolveCurrent = async (
    modelId: string,
    transport?: "direct" | "surplus",
  ): Promise<Extract<ModelFundingDecision, { kind: "personal" }>> => {
    if (modelId !== input.modelId) throw new ModelFundingError("funding_source_changed");
    await assertServerFirstPrimary(input, deps);

    // Re-run fresh personal selection so a live Surplus preference, route, or
    // credential change cannot silently alter the admitted recovery sequence.
    const preferred = await resolvePersonal();
    assertPinnedPersonal(admitted, preferred);

    if (transport === "surplus" && admitted.providerRoute !== "surplus") {
      throw new ModelFundingError("funding_source_changed");
    }
    if (transport !== "direct" || admitted.providerRoute !== "surplus") {
      const current = await resolvePersonal(admitted, transport);
      assertPinnedPersonal(admitted, current);
      return current;
    }

    // The direct provider key is a second pin. Passing the original Surplus
    // admission as priorDecision rechecks that credential before every direct
    // attempt, while the local pin detects replacement of the direct key.
    const current = await resolvePersonal(admitted, "direct");
    if (current.kind !== "personal" || current.providerRoute === "surplus"
      || current.providerRoute === "openai-chatgpt") {
      throw new ModelFundingError("funding_source_changed");
    }
    if (!directAdmitted) directAdmitted = current;
    else assertPinnedPersonal(directAdmitted, current);
    return current;
  };

  return {
    kind: "personal",
    ...(input.allowUnpinnedSurplusRetry ? { allowUnpinnedSurplusRetry: true as const } : {}),
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
    ...(input.allowUnpinnedSurplusRetry ? { allowUnpinnedSurplusRetry: true as const } : {}),
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
