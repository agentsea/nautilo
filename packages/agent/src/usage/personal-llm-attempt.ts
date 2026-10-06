import { randomUUID } from "node:crypto";
import { beginPersonalLlmAttempt, settlePersonalLlmAttempt } from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { estimateCostFromPrice, resolveModelPrice, PRICING_VERSION } from "../config/model-pricing";
import { getUsageContext, normalizeUsageRoomId, runWithUsageContext } from "./usage-context";
import type { ExtractedUsage } from "./usage-callback";
import { classifyError } from "../utils/errors";

/** Admission/accounting failure occurs before the wire and must not trigger model fallback. */
export class PersonalAttemptLedgerUnavailableError extends Error {
  constructor() { super("Personal model attempt accounting is unavailable; retry later."); }
}

/**
 * A concrete 4xx response proves that the provider refused this invocation.
 * HTTP 408 remains uncertain because the remote service can time out after
 * accepting work. Transport errors and 5xx responses are likewise not proof
 * that paid execution never began.
 */
export function classifyPersonalAttemptFailure(
  error: unknown,
  cancelled: boolean,
): { outcome: "cancelled" | "failed" | "unknown"; failureCode: string } {
  if (cancelled) return { outcome: "cancelled", failureCode: "cancelled" };
  const status = classifyError(error).statusCode;
  if (status !== undefined && status >= 400 && status <= 499 && status !== 408) {
    return { outcome: "failed", failureCode: "provider_refused" };
  }
  return { outcome: "unknown", failureCode: "outcome_unknown" };
}

function hasKnownFinancialEvidence(evidence: ExtractedUsage | undefined): boolean {
  return evidence !== undefined && (evidence.actualCostUsd !== null
    || evidence.inputTokens > 0 || evidence.outputTokens > 0
    || evidence.totalTokens !== undefined || evidence.reasoningTokens > 0
    || evidence.cachedInputTokens > 0 || evidence.cacheCreationTokens > 0);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requestIdHeader(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const get = (value as { get?: unknown }).get;
  if (typeof get === "function") {
    for (const name of ["x-request-id", "request-id", "anthropic-request-id"]) {
      const candidate = nonEmptyString(get.call(value, name));
      if (candidate) return candidate;
    }
  }
  const record = value as Record<string, unknown>;
  for (const name of ["x-request-id", "request-id", "anthropic-request-id"]) {
    const candidate = nonEmptyString(record[name] ?? record[name.toUpperCase()]);
    if (candidate) return candidate;
  }
  return undefined;
}

function providerRequestIdFromError(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const response = record["response"] && typeof record["response"] === "object"
    ? record["response"] as Record<string, unknown> : undefined;
  const cause = record["cause"] && typeof record["cause"] === "object"
    ? record["cause"] as Record<string, unknown> : undefined;
  for (const source of [record, response, cause]) {
    const explicit = nonEmptyString(source?.["requestID"])
      ?? nonEmptyString(source?.["request_id"])
      ?? nonEmptyString(source?.["requestId"])
      ?? nonEmptyString(source?.["response_id"]);
    if (explicit) return explicit;
    const header = requestIdHeader(source?.["headers"]);
    if (header) return header;
  }
  return undefined;
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
  let terminalOutcome: "succeeded" | "cancelled" | "failed" | "unknown" | undefined;
  let terminalFailureCode: string | undefined;
  let terminalProviderRequestId: string | undefined;
  let initialSettlementDone = false;
  let initialSettlementSucceeded = false;
  let knownCostSettled = false;
  const settle = async (
    outcome: "succeeded" | "cancelled" | "failed" | "unknown",
    preserveOutcome = false,
  ) => {
    const evidence = usage;
    const hasTokenEvidence = evidence !== undefined
      && (evidence.inputTokens > 0 || evidence.outputTokens > 0
        || evidence.totalTokens !== undefined || evidence.reasoningTokens > 0
        || evidence.cachedInputTokens > 0 || evidence.cacheCreationTokens > 0);
    const costState = evidence?.actualCostUsd != null ? "actual" as const
      : hasTokenEvidence ? "estimated" as const : "unknown" as const;
    const providerRequestId = evidence?.providerRequestId ?? terminalProviderRequestId;
    try {
      await deps.settle({ attemptId: id, outcome, costState,
        ...(preserveOutcome ? { preserveOutcome: true } : {}),
        ...(evidence && (hasTokenEvidence || evidence.actualCostUsd !== null)
          ? { inputTokens: evidence.inputTokens, outputTokens: evidence.outputTokens,
          reasoningTokens: evidence.reasoningTokens, cachedInputTokens: evidence.cachedInputTokens,
          ...(evidence.totalTokens === undefined ? {} : { totalTokens: evidence.totalTokens }),
          ...(hasTokenEvidence ? {
            estimatedCostUsd: estimateCostFromPrice(pricing.price, evidence),
            pricingVersion: PRICING_VERSION,
          } : {}),
          ...(evidence.actualCostUsd === null ? {} : { actualCostUsd: evidence.actualCostUsd }),
          metadata: { cacheCreationTokens: evidence.cacheCreationTokens },
        } : {}),
        ...(providerRequestId === undefined ? {} : { providerRequestId }),
        ...(outcome === "succeeded" ? {} : { failureCode: terminalFailureCode
          ?? (outcome === "cancelled" ? "cancelled"
            : outcome === "failed" ? "provider_refused" : "outcome_unknown") }),
      });
      if (costState !== "unknown") knownCostSettled = true;
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
    if (usage && usage !== evidenceAtSettlement && !knownCostSettled
      && hasKnownFinancialEvidence(usage)) {
      await settle(outcome, initialSettlementSucceeded);
    }
  };
  try {
    const result = await runWithUsageContext({ ...context, trackedAttemptId: id,
      onAttemptUsage: (observed) => {
        usage = observed;
        if (terminalOutcome && initialSettlementDone && !knownCostSettled
          && hasKnownFinancialEvidence(observed)) {
          // A late financial callback cannot turn a cancelled/unknown answer into success.
          void settle(terminalOutcome, initialSettlementSucceeded);
        }
      },
    }, input.invoke);
    await finish("succeeded");
    return result;
  } catch (error) {
    const failure = classifyPersonalAttemptFailure(error, input.signal?.aborted === true);
    terminalFailureCode = failure.failureCode;
    terminalProviderRequestId = providerRequestIdFromError(error);
    await finish(failure.outcome);
    throw error;
  }
}
