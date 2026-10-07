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
}

const admittedAttempts = new WeakSet<object>();

function admitDecisionFundingAttempt(
  usageFunding: UsageFundingProvenance,
  providerRoute: "direct" | "surplus",
  personalApiKey?: string,
): AdmittedDecisionFundingAttempt {
  const admitted = {
    usageFunding,
    providerRoute,
    ...(personalApiKey === undefined ? {} : { personalApiKey }),
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
  transport: "direct" | "surplus",
  invoke: (deps: DecisionDependencies) => Promise<T>,
): Promise<T> {
  return prepared.fundingSession.runAttempt(prepared.modelId, async (attempt) => {
    const ambient = getUsageContext();
    const personalApiKey = attempt.personalCredential?.apiKey;
    const admittedFundingAttempt = admitDecisionFundingAttempt(
      attempt.usageFunding,
      transport,
      personalApiKey,
    );
    return runWithUsageContext({
      callType: ambient?.callType ?? "other",
      userId: attempt.usageFunding.humanUserId ?? ambient?.userId ?? null,
      roomId: ambient?.roomId ?? null,
      ...(ambient?.metadata === undefined ? {} : { metadata: ambient.metadata }),
      funding: attempt.usageFunding,
    }, () => invoke({
      providerRoute: transport,
      admittedFundingAttempt,
      ...(attempt.personalCredential === undefined
        ? {}
        : { apiKey: attempt.personalCredential.apiKey }),
    }));
  }, transport);
}

/**
 * Execute within the admitted payer. A proven pre-service marketplace refusal
 * may try the same model directly; the funding owner rejects cross-payer use.
 */
export async function runPreparedDecision<T>(
  prepared: PreparedDecisionFunding,
  invoke: (deps: DecisionDependencies) => Promise<T>,
): Promise<T> {
  const preferred = prepared.binding.providerRoute === "surplus" ? "surplus" : "direct";
  try {
    return await runTransport(prepared, preferred, invoke);
  } catch (error) {
    if (preferred !== "surplus" || !(error instanceof SurplusDecisionDirectFallbackError)) throw error;
    return runTransport(prepared, "direct", invoke);
  }
}
