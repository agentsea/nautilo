import { candidatesForModelRole, type ModelRole } from "@nautilo/config";
import {
  getEligibleModels, listResolvedCatalogModels, resolveCatalogModel,
  type CapabilityFundingSession, type PersonalCapabilityRole,
} from "@nautilo/agent";
import {
  getPersonalCapabilityPreferences,
  PERSONAL_PROVIDER_IDS,
  type PersonalProviderId,
} from "@nautilo/db";
import {
  parseTaskFundingBinding,
  type PersonalCapabilityPreferences,
  type TaskFundingBinding,
} from "@nautilo/types";
import { ModelFundingError, resolveModelFunding, withAdmittedPersonalProviderKey, type ModelFundingDecision, type ModelFundingDeps } from "./model-funding";
import { usageFundingFor } from "./foreground-chat-funding";
import { readPersonalProviderCustody } from "./personal-provider-custody";
import { getServerDirectDb } from "./server-direct-db";
import { openServiceFunding } from "./service-funding";

const RESEARCH_ROLES = {
  webSearchSynthesis: { role: "webSearchSynthesis", env: "NAUTILO_WEB_SEARCH_MODEL", tools: false },
  deepResearchSupervisor: { role: "deepResearchSupervisor", env: "SUPERVISOR_MODEL", tools: true },
  deepResearchResearcher: { role: "deepResearchResearcher", env: "RESEARCH_MODEL", tools: true },
  deepResearchSummarization: { role: "deepResearchSynthesis", env: "SUMMARIZATION_MODEL", tools: false },
  deepResearchCompression: { role: "deepResearchSynthesis", env: "COMPRESSION_MODEL", tools: false },
  deepResearchFinalReport: { role: "deepResearchFinalReport", env: "FINAL_REPORT_MODEL", tools: false },
} satisfies Record<Exclude<PersonalCapabilityRole, "decision">, { role: ModelRole; env: string; tools: boolean }>;

function assertModel(
  modelId: string,
  workload: "research" | "decision",
  tools = false,
  resolveModel: typeof resolveCatalogModel = resolveCatalogModel,
): void {
  const row = resolveModel(modelId, { env: { NAUTILO_ALLOW_CHINA_UPSTREAM: process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] } });
  if (!["selectable", "missing_credentials"].includes(row.availability)
    || row.workload !== (workload === "decision" ? "decision" : "chat")
    || (workload === "research" && !row.output.includes("text"))
    || (workload === "decision" && !row.decision?.operations.includes("choice"))
    || (tools && !row.features.tools)) throw new ModelFundingError("unsupported_workload");
}

interface CapabilityFundingOverrides {
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
  let projectionCustody: ReturnType<typeof readPersonalProviderCustody> | undefined;
  const validateProjectionCredential = async (decision: ModelFundingDecision): Promise<void> => {
    if (!projectionDeps || decision.kind !== "personal") return;
    const provider = (PERSONAL_PROVIDER_IDS as readonly string[]).includes(decision.providerRoute)
      ? decision.providerRoute as PersonalProviderId
      : null;
    if (!provider) throw new ModelFundingError("personal_credential_unavailable");
    const credential = await projectionDeps.getCredential(decision.humanUserId, provider);
    if (!credential || credential.userId !== decision.humanUserId
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
  return {
    humanUserId,
    async resolveModel(role, configuredId) {
      await recheckAuthority();
      const preferences = await readPreferences(humanUserId);
      const explicit = configuredId?.trim() || preferences.overrides[role];
      const research = role === "decision" ? null : RESEARCH_ROLES[role];
      const configured = explicit || (research ? process.env[research.env]?.trim() : undefined);
      const workload = role === "decision" ? "decision" : "research";
      if (configured) {
        assertModel(configured, workload, research?.tools, resolveCatalog);
        // Missing credentials are reported for this choice, never replaced by
        // another model just because a different account has a usable key.
        const decision = await resolveModelFunding({ humanUserId, modelId: configured, workload }, projectionDeps);
        await validateProjectionCredential(decision);
        return { modelId: configured, preferenceRevision: preferences.revision };
      }
      const candidates = research
        ? [...candidatesForModelRole(research.role), ...getEligibleModels({ purpose: research.tools ? "chat-tools" : "chat", includeUnavailable: true }).map((row) => row.id)]
        : listResolvedCatalogModels({ includeUnavailable: true }).filter((row) => row.workload === "decision" && row.decision?.operations.includes("choice")).map((row) => row.id);
      for (const modelId of new Set(candidates)) {
        try {
          assertModel(modelId, workload, research?.tools, resolveCatalog);
          const decision = await resolveModelFunding({ humanUserId, modelId, workload }, projectionDeps);
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
      const admitted = await resolveModelFunding({ humanUserId, modelId, workload, ...(priorDecision ? { priorDecision } : {}) }, projectionDeps);
      await validateProjectionCredential(admitted);
      const resolve = async (candidate: string, transport?: "direct" | "surplus") => {
        await recheckAuthority();
        if (candidate !== modelId) throw new ModelFundingError("funding_source_changed");
        assertModel(candidate, workload, false, resolveCatalog);
        return resolveModelFunding({ humanUserId, modelId, workload, priorDecision: admitted, ...(transport ? { transport } : {}) });
      };
      let lastAttempt: ModelFundingDecision | undefined;
      return {
        binding: capabilityFundingBinding(admitted),
        fundingSession: {
          kind: admitted.kind,
          workload,
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
            return withAdmittedPersonalProviderKey(decision,
              (apiKey) => run({ usageFunding, personalCredential: { apiKey } }), undefined, admitted);
          },
        },
      };
    },
    async openService(provider, prior) {
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
export async function prepareCapabilityFundingSession(humanUserId: string, recheckAuthority: () => Promise<void>, parentFundingKind: "personal" | "server"): Promise<CapabilityFundingSession> {
  const session = createCapabilityFundingSession(humanUserId, recheckAuthority);
  const decisionModelId = await session.resolveModel("decision").then((choice) => choice.modelId).catch(() => null);
  return { ...session, decisionModelId, parentFundingKind };
}
