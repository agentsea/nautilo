import type { ForegroundChatFundingAttempt } from "../runtime/foreground-chat-funding";
import { canBroadenSurplusModelRoute } from "./surplus-route";
import type { TaskFundingBinding } from "@nautilo/types";
import {
  getCapabilityFundingSession,
} from "../runtime/capability-funding";
import { getUsageContext, runWithUsageContext } from "../usage/usage-context";
import type { ForegroundChatFundingSession } from "../runtime/foreground-chat-funding";
import type { UsageFundingProvenance } from "../usage/usage-context";
import { ChoiceRequestError } from "./choice";
import { SurplusDecisionDirectFallbackError } from "./surplus-decision-attempt";
import type { DecisionDependencies } from "./decision-transport";

export interface PreparedDecisionFunding {
  readonly modelId: string;
  readonly preferenceRevision: number;
  readonly binding: TaskFundingBinding;
  readonly fundingSession: ForegroundChatFundingSession;
}

export interface AdmittedDecisionFundingAttempt {
  readonly usageFunding: UsageFundingProvenance;
  readonly providerRoute: "direct" | "surplus";
  readonly personalApiKey?: string;
  readonly surplusProviderMode?: "any";
}

const admittedAttempts = new WeakSet<object>();

function admitDecisionFundingAttempt(
  usageFunding: UsageFundingProvenance,
  providerRoute: "direct" | "surplus",
  personalApiKey?: string,
  surplusProviderMode?: "any",
): AdmittedDecisionFundingAttempt {
  const admitted = {
    usageFunding,
    providerRoute,
    ...(personalApiKey === undefined ? {} : { personalApiKey }),
    ...(surplusProviderMode === undefined ? {} : { surplusProviderMode }),
  };
  admittedAttempts.add(admitted);
  return admitted;
}

/** Internal transport check for an authority minted inside runAttempt. */
export function isAdmittedDecisionFundingAttempt(
  value: unknown,
): value is AdmittedDecisionFundingAttempt {
  return typeof value === "object" && value !== null && admittedAttempts.has(value);
}

/** Resolve the preference before admission and preserve an explicit exact id. */
export async function prepareDecisionFunding(
  configuredModelId: string | undefined,
  prior?: TaskFundingBinding,
): Promise<PreparedDecisionFunding | null> {
  const capability = getCapabilityFundingSession();
  if (!capability) return null;
  const configured = configuredModelId?.trim() || undefined;
  const selected = await capability.resolveModel("decision", configured);
  if (configured && selected.modelId !== configured) {
    throw new ChoiceRequestError("unsupported_model");
  }
  const admitted = await capability.openModel(selected.modelId, "decision", prior);
  return {
    modelId: selected.modelId,
    preferenceRevision: selected.preferenceRevision,
    binding: admitted.binding,
    fundingSession: admitted.fundingSession,
  };
}

async function runTransport<T>(
  prepared: PreparedDecisionFunding,
  transport: "direct" | "surplus" | undefined,
  invoke: (deps: DecisionDependencies) => Promise<T>,
  providerMode?: "any",
): Promise<T> {
  const run = async (attempt: ForegroundChatFundingAttempt) => {
    const actualTransport = attempt.usageFunding.providerRoute === "surplus" ? "surplus" : "direct";
    const ambient = getUsageContext();
    const personalApiKey = attempt.personalCredential?.apiKey;
    const admittedFundingAttempt = admitDecisionFundingAttempt(
      attempt.usageFunding,
      actualTransport,
      personalApiKey,
      actualTransport === "surplus" ? providerMode : undefined,
    );
    return runWithUsageContext({
      callType: "decision",
      userId: attempt.usageFunding.humanUserId ?? ambient?.userId ?? null,
      roomId: ambient?.roomId ?? null,
      ...(ambient?.metadata === undefined ? {} : { metadata: ambient.metadata }),
      funding: attempt.usageFunding,
    }, () => invoke({
      providerRoute: actualTransport,
      ...(actualTransport === "surplus" && providerMode ? { surplusProviderMode: providerMode } : {}),
      admittedFundingAttempt,
      ...(attempt.personalCredential === undefined
        ? {}
        : { apiKey: attempt.personalCredential.apiKey }),
    }));
  };
  return prepared.fundingSession.runAttempt(prepared.modelId, run, transport);
}

/** One payer's bounded pinned-marketplace, model-marketplace, direct sequence. */
async function runDecisionSource<T>(
  prepared: PreparedDecisionFunding,
  initialTransport: "direct" | "surplus" | undefined,
  invoke: (deps: DecisionDependencies) => Promise<T>,
): Promise<T> {
  let actualTransport: "direct" | "surplus" | undefined;
  const attempt = (transport?: "direct" | "surplus", mode?: "any") => runTransport(prepared, transport,
    (deps) => { actualTransport = deps.providerRoute; return invoke(deps); }, mode);
  try {
    return await attempt(initialTransport);
  } catch (error) {
    if (actualTransport !== "surplus" || !(error instanceof SurplusDecisionDirectFallbackError)) throw error;
    if (error.retryUnpinned && prepared.fundingSession.allowUnpinnedSurplusRetry === true
      && canBroadenSurplusModelRoute(prepared.modelId)) {
      try { return await attempt("surplus", "any"); }
      catch (unpinnedError) {
        if (!(unpinnedError instanceof SurplusDecisionDirectFallbackError)) throw unpinnedError;
      }
    }
    return attempt("direct");
  }
}

function mayRecoverDecisionSource(error: unknown): boolean {
  if (error instanceof ChoiceRequestError) {
    return ["network_error", "provider_error", "invalid_response", "context_length_exceeded", "missing_credentials"].includes(error.code);
  }
  return typeof error === "object" && error !== null && "code" in error
    && error.code === "provider_credentials_missing";
}

/** Preserve the primary binding while an explicit server-first authority may recover personally. */
export async function runPreparedDecision<T>(
  prepared: PreparedDecisionFunding,
  invoke: (deps: DecisionDependencies) => Promise<T>,
): Promise<T> {
  const preferred = prepared.binding.providerRoute === "surplus" ? "surplus" : "direct";
  try {
    return await runDecisionSource(prepared, preferred, invoke);
  } catch (error) {
    if (prepared.fundingSession.kind !== "server" || !mayRecoverDecisionSource(error)) throw error;
    if (prepared.fundingSession.openPersonalRecovery) {
      const personal = await prepared.fundingSession.openPersonalRecovery(prepared.modelId);
      return runDecisionSource({ ...prepared, fundingSession: personal }, undefined, invoke);
    }
    // Compatibility with the narrower direct-only authority on older callers.
    if (typeof error !== "object" || error === null || !("code" in error)
      || error.code !== "provider_credentials_missing" || !prepared.fundingSession.openPersonalDirectRecovery) throw error;
    const personal = await prepared.fundingSession.openPersonalDirectRecovery(prepared.modelId);
    return runDecisionSource({ ...prepared, fundingSession: personal }, "direct", invoke);
  }
}
