import { candidatesForModelRole, type ModelRole } from "@nautilo/config";
import {
  getEligibleModels, listResolvedCatalogModels, resolveCatalogModel,
  type CapabilityFundingSession,
} from "@nautilo/agent";
import {
  getPersonalCapabilityPreferences,
  PERSONAL_PROVIDER_IDS,
  type PersonalProviderId,
} from "@nautilo/db";
import {
  parseTaskFundingBinding,
  type PersonalCapabilityPreferences,
  type ResearchCapabilityRole,
  isMediaCapabilityRole,
  isMemoryCapabilityRole,
  type TaskFundingBinding,
} from "@nautilo/types";
import { ModelFundingError, createModelFundingSnapshot, readModelFundingPolicy, resolveModelFunding, withAdmittedPersonalCredential, type ModelFundingDecision, type ModelFundingDeps } from "./model-funding";
import { usageFundingFor } from "./foreground-chat-funding";
import { readPersonalProviderCustody } from "./personal-provider-custody";
import { getServerDirectDb } from "./server-direct-db";
import { openServiceFunding } from "./service-funding";
import { mediaPreferenceFunding, resolvePersonalMediaModel } from "./media-model-preferences";
import { openMediaFunding } from "./media-funding";
import { currentMemoryOperatorDefaults, personalMemoryModels, resolveMemoryModelPreference } from "./memory-model-preferences";
import { resolveImageUnderstandingModel } from "./image-model-preferences";
import {
  openServerFirstPersonalRecovery,
  openSurplusPersonalDirectRecovery,
} from "./surplus-personal-recovery";

const RESEARCH_ROLES = {
  webSearchSynthesis: { role: "webSearchSynthesis", env: "NAUTILO_WEB_SEARCH_MODEL", tools: false },
  deepResearchSupervisor: { role: "deepResearchSupervisor", env: "SUPERVISOR_MODEL", tools: true },
  deepResearchResearcher: { role: "deepResearchResearcher", env: "RESEARCH_MODEL", tools: true },
  deepResearchSummarization: { role: "deepResearchSynthesis", env: "SUMMARIZATION_MODEL", tools: false },
  deepResearchCompression: { role: "deepResearchSynthesis", env: "COMPRESSION_MODEL", tools: false },
  deepResearchFinalReport: { role: "deepResearchFinalReport", env: "FINAL_REPORT_MODEL", tools: false },
} satisfies Record<ResearchCapabilityRole, { role: ModelRole; env: string; tools: boolean }>;

function assertModel(
  modelId: string,
  workload: "research" | "decision" | "memory" | "image_assistance",
  tools = false,
  resolveModel: typeof resolveCatalogModel = resolveCatalogModel,
): void {
  const row = resolveModel(modelId, { env: { NAUTILO_ALLOW_CHINA_UPSTREAM: process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] } });
  if (!["selectable", "missing_credentials"].includes(row.availability)
    || row.workload !== (workload === "decision" ? "decision" : "chat")
    || (workload !== "decision" && !row.output.includes("text"))
    || (workload === "image_assistance" && !row.input.includes("image"))
    || (workload === "decision" && !row.decision?.operations.includes("choice"))
    || (tools && !row.features.tools)) throw new ModelFundingError("unsupported_workload");
}

interface CapabilityFundingOverrides {
  readonly parentBinding?: TaskFundingBinding;
  readonly allowUnpinnedSurplusRetry?: true;
  readonly readPreferences?: (humanUserId: string) => Promise<PersonalCapabilityPreferences>;
  readonly readProjectionCustody?: typeof readPersonalProviderCustody;
  readonly resolveCatalog?: typeof resolveCatalogModel;
}

export function capabilityFundingBinding(decision: ModelFundingDecision): TaskFundingBinding {
  return decision.kind === "personal"
    ? { kind: "personal", providerRoute: decision.providerRoute, credentialId: decision.credentialId, credentialRevision: decision.credentialRevision }
    : { kind: "server", providerRoute: decision.providerRoute };
}

/** Caller must first establish an eligible own-Genie Room or canonical Task. */
export function createCapabilityFundingSession(
  humanUserId: string,
  recheckAuthority: () => Promise<void> = async () => {},
  projectionDeps?: ModelFundingDeps,
  overrides: CapabilityFundingOverrides = {},
): CapabilityFundingSession {
  const readPreferences = overrides.readPreferences
    ?? ((humanId: string) => getPersonalCapabilityPreferences(getServerDirectDb(), humanId));
  const resolveCatalog = overrides.resolveCatalog ?? resolveCatalogModel;
  const subscription = overrides.parentBinding?.kind === "personal" && overrides.parentBinding.providerRoute === "openai-chatgpt"
    ? overrides.parentBinding : undefined;
  const denySeparateFunding = () => { if (subscription) throw new ModelFundingError("unsupported_workload"); };
  const resolveFunding = (modelId: string, workload: "research" | "decision" | "memory" | "image_assistance", priorDecision?: ModelFundingDecision) => {
    if (subscription && workload !== "research") throw new ModelFundingError("unsupported_workload");
    const pinned: ModelFundingDecision | undefined = subscription
      ? { ...subscription, humanUserId, payerHumanId: humanUserId, modelId, workload } : undefined;
    if (pinned && priorDecision && (priorDecision.kind !== "personal"
      || priorDecision.providerRoute !== pinned.providerRoute || priorDecision.credentialId !== subscription?.credentialId
      || priorDecision.credentialRevision !== subscription?.credentialRevision)) throw new ModelFundingError("funding_source_changed");
    const prior = priorDecision ?? pinned;
    return resolveModelFunding({ humanUserId, modelId, workload, ...(prior ? { priorDecision: prior } : {}) }, projectionDeps);
  };
  let projectionCustody: ReturnType<typeof readPersonalProviderCustody> | undefined;
  const validateProjectionCredential = async (decision: TaskFundingBinding): Promise<void> => {
    if (!projectionDeps || decision.kind !== "personal") return;
    if (decision.providerRoute === "openai-chatgpt") {
      const registration = await projectionDeps.getSubscription?.(humanUserId, decision.credentialId);
      if (!registration?.available || registration.revision !== decision.credentialRevision) throw new ModelFundingError("personal_credential_unavailable");
      return;
    }
    const provider = (PERSONAL_PROVIDER_IDS as readonly string[]).includes(decision.providerRoute)
      ? decision.providerRoute as PersonalProviderId
      : null;
    if (!provider) throw new ModelFundingError("personal_credential_unavailable");
    const credential = await projectionDeps.getCredential(humanUserId, provider);
    if (!credential || credential.userId !== humanUserId
      || credential.provider !== provider || credential.id !== decision.credentialId
      || credential.revision !== decision.credentialRevision) {
      throw new ModelFundingError("personal_credential_unavailable");
    }
    try {
      projectionCustody ??= (overrides.readProjectionCustody ?? readPersonalProviderCustody)();
      const custody = await projectionCustody;
      if (credential.envelope.keyId === custody.resetFromKeyId
        || credential.envelope.keyId !== custody.keyId) {
        throw new ModelFundingError("personal_credential_unavailable");
      }
    } catch (error) {
      if (error instanceof ModelFundingError) throw error;
      throw new ModelFundingError("personal_credential_unavailable");
    }
  };
  const resolveImageProjection = async (
    configuredId: string | null | undefined,
    parentFundingKind?: "personal" | "server",
    currentPreferences?: PersonalCapabilityPreferences,
  ) => {
    const preferences = currentPreferences ?? await readPreferences(humanUserId);
    const explicit = configuredId?.trim();
    const snapshot = explicit
      ? { ...preferences, overrides: { ...preferences.overrides, imageUnderstanding: explicit } }
      : preferences;
    return resolveImageUnderstandingModel({
      humanUserId,
      preferences: snapshot,
      ...(parentFundingKind ? { parentFundingKind } : {}),
    }, {
      resolveCatalog,
      ...(projectionDeps ? {
        resolveFunding: (input) => resolveModelFunding(input, projectionDeps),
        validateFunding: validateProjectionCredential,
      } : {}),
    });
  };
  return {
    humanUserId,
    async resolveModel(role, configuredId) {
      await recheckAuthority();
      const preferences = await readPreferences(humanUserId);
      if (isMediaCapabilityRole(role)) {
        denySeparateFunding();
        return resolvePersonalMediaModel(humanUserId, role, configuredId, preferences, projectionDeps, validateProjectionCredential);
      }
      if (role === "imageUnderstanding") {
        denySeparateFunding();
        const selection = await resolveImageProjection(configuredId, undefined, preferences);
        return { modelId: selection.modelId, preferenceRevision: selection.preferenceRevision };
      }
      if (isMemoryCapabilityRole(role)) {
        denySeparateFunding();
        const snapshot = configuredId?.trim()
          ? { ...preferences, overrides: { ...preferences.overrides, [role]: configuredId.trim() } }
          : preferences;
        const choices = personalMemoryModels(role);
        const defaults = currentMemoryOperatorDefaults();
        const exact = snapshot.overrides[role] || defaults[role];
        const candidates = exact ? [resolveMemoryModelPreference(role, snapshot, defaults, choices)]
          : choices.map((row) => ({ modelId: row.modelId, preferenceRevision: snapshot.revision }));
        for (const selection of candidates) {
          try {
            assertModel(selection.modelId, "memory", role === "memoryReview", resolveCatalog);
            const decision = await resolveModelFunding({ humanUserId, modelId: selection.modelId, workload: "memory" }, projectionDeps);
            await validateProjectionCredential(decision);
            return selection;
          } catch (error) {
            if (exact || !(error instanceof ModelFundingError)) throw error;
          }
        }
        throw new ModelFundingError("provider_credentials_missing");
      }
      const explicit = configuredId?.trim() || preferences.overrides[role];
      const research = role === "decision" ? null : RESEARCH_ROLES[role];
      const configured = explicit || (research ? process.env[research.env]?.trim() : undefined);
      const workload = role === "decision" ? "decision" : "research";
      if (configured) {
        assertModel(configured, workload, research?.tools, resolveCatalog);
        // Missing credentials are reported for this choice, never replaced by
        // another model just because a different account has a usable key.
        const decision = await resolveFunding(configured, workload);
        await validateProjectionCredential(decision);
        return { modelId: configured, preferenceRevision: preferences.revision };
      }
      const candidates = research
        ? [...candidatesForModelRole(research.role), ...getEligibleModels({ purpose: research.tools ? "chat-tools" : "chat", includeUnavailable: true }).map((row) => row.id)]
        : listResolvedCatalogModels({ includeUnavailable: true }).filter((row) => row.workload === "decision" && row.decision?.operations.includes("choice")).map((row) => row.id);
      for (const modelId of new Set(candidates)) {
        try {
          assertModel(modelId, workload, research?.tools, resolveCatalog);
          const decision = await resolveFunding(modelId, workload);
          await validateProjectionCredential(decision);
          return { modelId, preferenceRevision: preferences.revision };
        } catch (error) {
          if (!(error instanceof ModelFundingError)) throw error;
        }
      }
      throw new ModelFundingError("provider_credentials_missing");
    },
    async openModel(modelId, workload, prior) {
      await recheckAuthority();
      assertModel(modelId, workload, false, resolveCatalog);
      const binding = prior ? parseTaskFundingBinding(prior) : undefined;
      const priorDecision: ModelFundingDecision | undefined = binding
        ? binding.kind === "personal" ? { ...binding, humanUserId, modelId, workload, payerHumanId: humanUserId } : { ...binding, humanUserId, modelId, workload }
        : undefined;
      const admitted = await resolveFunding(modelId, workload, priorDecision);
      await validateProjectionCredential(admitted);
      const fundingPolicy = workload !== "memory" && admitted.kind === "server"
        ? await readModelFundingPolicy(projectionDeps)
        : null;
      const resolve = async (candidate: string, transport?: "direct" | "surplus") => {
        await recheckAuthority();
        if (candidate !== modelId) throw new ModelFundingError("funding_source_changed");
        assertModel(candidate, workload, false, resolveCatalog);
        return resolveModelFunding({
          humanUserId,
          modelId,
          workload,
          priorDecision: admitted,
          ...(transport ? { transport } : {}),
        }, projectionDeps);
      };
      let lastAttempt: ModelFundingDecision | undefined;
      const allowUnpinnedSurplusRetry = workload !== "memory"
        && overrides.allowUnpinnedSurplusRetry === true;
      return {
        binding: capabilityFundingBinding(admitted),
        fundingSession: {
          kind: admitted.kind,
          workload,
          ...(allowUnpinnedSurplusRetry ? { allowUnpinnedSurplusRetry: true as const } : {}),
          ...(workload !== "memory" && admitted.kind === "server" && admitted.providerRoute === "surplus" ? {
            openPersonalDirectRecovery: (candidate: string) => openSurplusPersonalDirectRecovery({
              humanUserId,
              modelId: candidate,
              workload,
              primaryDecision: admitted,
              ...(allowUnpinnedSurplusRetry ? { allowUnpinnedSurplusRetry: true as const } : {}),
              recheckPrimary: () => resolve(candidate),
            }, projectionDeps),
          } : {}),
          ...(workload !== "memory" && admitted.kind === "server"
            && fundingPolicy?.fundingPreference === "server_first" ? {
              openPersonalRecovery: (candidate: string) => openServerFirstPersonalRecovery({
                humanUserId,
                modelId: candidate,
                workload,
                primaryDecision: admitted,
                ...(allowUnpinnedSurplusRetry ? { allowUnpinnedSurplusRetry: true as const } : {}),
                recheckPrimary: () => resolve(candidate),
              }, projectionDeps),
            } : {}),
          async recheckAttempt(candidate, transport) {
            const current = await resolve(candidate, transport);
            if (lastAttempt?.kind === "personal" && current.kind === "personal"
              && lastAttempt.providerRoute === current.providerRoute
              && (lastAttempt.credentialId !== current.credentialId || lastAttempt.credentialRevision !== current.credentialRevision)) throw new ModelFundingError("personal_credential_stale");
          },
          async runAttempt(candidate, run, transport) {
            const decision = await resolve(candidate, transport);
            lastAttempt = decision;
            const usageFunding = usageFundingFor(decision);
            if (decision.kind === "server") return run({ usageFunding });
            return withAdmittedPersonalCredential(decision,
              (personalCredential) => run({ usageFunding, personalCredential }), undefined, admitted);
          },
        },
      };
    },
    async projectImageUnderstandingFunding(configuredId, parentFundingKind) {
      denySeparateFunding();
      await recheckAuthority();
      const selection = await resolveImageProjection(configuredId, parentFundingKind);
      return {
        modelId: selection.modelId,
        binding: capabilityFundingBinding(selection.funding),
      };
    },
    async projectMediaFunding(modelId, role) {
      denySeparateFunding();
      await recheckAuthority();
      const funding = await mediaPreferenceFunding(humanUserId, modelId, role, projectionDeps);
      await validateProjectionCredential(funding);
      return funding.kind === "personal"
        ? { kind: "personal", providerRoute: funding.providerRoute, credentialId: funding.credentialId, credentialRevision: funding.credentialRevision }
        : { kind: "server", providerRoute: funding.providerRoute };
    },
    async openMedia(modelId, family, options) {
      denySeparateFunding();
      await recheckAuthority();
      return openMediaFunding(humanUserId, modelId, family, options, recheckAuthority);
    },
    async openService(provider, prior) {
      denySeparateFunding();
      await recheckAuthority();
      const admitted = await openServiceFunding(humanUserId, provider, prior);
      return { binding: admitted.binding, runAttempt: async (run) => {
        await recheckAuthority();
        return admitted.runAttempt(run);
      } };
    },
  };
}


/** Readiness is a projection; the selected operation still admits and rechecks live. */
export async function prepareCapabilityFundingSession(humanUserId: string, recheckAuthority: () => Promise<void>, parentFundingKind: "personal" | "server", parentBinding?: TaskFundingBinding, allowUnpinnedSurplusRetry?: true): Promise<CapabilityFundingSession> {
  await recheckAuthority();
  const [snapshot, preferences] = await Promise.all([
    createModelFundingSnapshot(humanUserId),
    getPersonalCapabilityPreferences(getServerDirectDb(), humanUserId),
  ]);
  // Share one read-only snapshot while probing candidates; execution below
  // keeps fresh policy, permission and credential checks for every attempt.
  const projection = createCapabilityFundingSession(humanUserId, undefined, snapshot.deps, {
    readPreferences: () => Promise.resolve(preferences),
    ...(parentBinding ? { parentBinding } : {}),
  });
  const session = createCapabilityFundingSession(humanUserId, recheckAuthority, undefined, {
    ...(parentBinding ? { parentBinding } : {}),
    ...(allowUnpinnedSurplusRetry ? { allowUnpinnedSurplusRetry } : {}),
  });
  const [decisionModelId, image, video, music] = await Promise.all([
    projection.resolveModel("decision").then((choice) => choice.modelId).catch(() => null),
    projection.resolveModel("imageGeneration").then(() => true).catch(() => false),
    projection.resolveModel("videoGeneration").then(() => true).catch(() => false),
    projection.resolveModel("musicGeneration").then(() => true).catch(() => false),
  ]);
  return { ...session, decisionModelId, parentFundingKind, mediaGenerationReady: { image, video, music } };
}
