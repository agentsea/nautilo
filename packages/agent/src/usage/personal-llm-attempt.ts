import { randomUUID } from "node:crypto";
import { beginPersonalLlmAttempt, settlePersonalLlmAttempt } from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { estimateCostFromPrice, resolveModelPrice, PRICING_VERSION } from "../config/model-pricing";
import { getUsageContext, normalizeUsageRoomId, runWithUsageContext } from "./usage-context";
import type { ExtractedUsage } from "./usage-callback";

/** Admission/accounting failure occurs before the wire and must not trigger model fallback. */
export class PersonalAttemptLedgerUnavailableError extends Error {
  constructor() { super("Personal model attempt accounting is unavailable; retry later."); }
}

/** One durable record per actual direct invocation, including SDK/supervisor retries. */
export async function runPersonalLlmAttempt<T>(input: {
  modelId: string;
  endpoint: string;
  signal?: AbortSignal | undefined;
  invoke: () => Promise<T>;
}, deps = { begin: beginPersonalLlmAttempt, settle: settlePersonalLlmAttempt }): Promise<T> {
  const context = getUsageContext();
  const funding = context?.funding;
  if (!context || funding?.kind !== "personal" || funding.providerRoute === "surplus") return input.invoke();
  const id = randomUUID();
  const pricing = structuredClone(resolveModelPrice(input.modelId, context.modelControl?.servingProfileId));
  try {
    await deps.begin({ id, userId: funding.humanUserId,
      roomId: normalizeUsageRoomId(context.roomId),
      ...(typeof context.metadata?.["taskId"] === "string" ? { taskId: context.metadata["taskId"] } : {}),
      callType: context.callType, model: input.modelId,
      provider: input.modelId.split(":", 1)[0]!, providerRoute: funding.providerRoute,
      credentialId: funding.credentialId, credentialRevision: funding.credentialRevision,
      endpoint: input.endpoint,
      metadata: { ...(context.metadata ?? {}), usagePricingSource: pricing.source,
        pricingSnapshot: pricing.price, ...(context.modelControl ?? {}) },
    });
  } catch { throw new PersonalAttemptLedgerUnavailableError(); }
  let usage: ExtractedUsage | undefined;
  let terminalOutcome: "succeeded" | "cancelled" | "unknown" | undefined;
  let initialSettlementDone = false;
  let initialSettlementSucceeded = false;
  let knownCostSettled = false;
  const settle = async (outcome: "succeeded" | "cancelled" | "unknown", preserveOutcome = false) => {
    const evidence = usage;
    const costState = evidence?.actualCostUsd != null ? "actual" as const
      : evidence ? "estimated" as const : "unknown" as const;
    try {
      await deps.settle({ attemptId: id, outcome, costState,
        ...(preserveOutcome ? { preserveOutcome: true } : {}),
        ...(evidence ? { inputTokens: evidence.inputTokens, outputTokens: evidence.outputTokens,
          reasoningTokens: evidence.reasoningTokens, cachedInputTokens: evidence.cachedInputTokens,
          ...(evidence.totalTokens === undefined ? {} : { totalTokens: evidence.totalTokens }),
          estimatedCostUsd: estimateCostFromPrice(pricing.price, evidence), pricingVersion: PRICING_VERSION,
          ...(evidence.actualCostUsd === null ? {} : { actualCostUsd: evidence.actualCostUsd }),
          metadata: { cacheCreationTokens: evidence.cacheCreationTokens },
        } : {}),
        ...(outcome === "succeeded" ? {} : { failureCode: outcome === "cancelled" ? "cancelled" : "outcome_unknown" }),
      });
      if (evidence) knownCostSettled = true;
      return true;
    } catch {
      // The pre-wire row remains unresolved. Accounting failure never repeats paid work.
      warn("[nautilo/usage] personal attempt settlement unavailable", { failureCode: "attempt_settlement_failed" });
      return false;
    }
  };
  const finish = async (outcome: NonNullable<typeof terminalOutcome>) => {
    terminalOutcome = outcome;
    const evidenceAtSettlement = usage;
    initialSettlementSucceeded = await settle(outcome);
    initialSettlementDone = true;
    // Usage can arrive while the terminal database write is in flight.
    if (usage && usage !== evidenceAtSettlement && !knownCostSettled) {
      await settle(outcome, initialSettlementSucceeded);
    }
  };
  try {
    const result = await runWithUsageContext({ ...context, trackedAttemptId: id,
      onAttemptUsage: (observed) => {
        usage = observed;
        if (terminalOutcome && initialSettlementDone && !knownCostSettled) {
          // A late financial callback cannot turn a cancelled/unknown answer into success.
          void settle(terminalOutcome, initialSettlementSucceeded);
        }
      },
    }, input.invoke);
    await finish("succeeded");
    return result;
  } catch (error) {
    await finish(input.signal?.aborted ? "cancelled" : "unknown");
    throw error;
  }
}
