import { randomUUID } from "node:crypto";
import { beginPersonalLlmAttempt, settlePersonalLlmAttempt, beginServiceLlmAttempt, settleServiceLlmAttempt, beginServerLlmAttempt, settleServerLlmAttempt, type SettlePersonalLlmAttemptInput } from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { estimateCostFromPrice, resolveModelPrice, PRICING_VERSION } from "../config/model-pricing";
import { getUsageContext, normalizeUsageRoomId, runWithUsageContext } from "./usage-context";
import type { ExtractedUsage } from "./usage-callback";
import { classifyError } from "../utils/errors";
import {
  getPersonalLlmAttemptOwner,
  type PersonalLlmAttemptOwnerBinding,
} from "./personal-llm-attempt-owner";

/** Admission/accounting failure occurs before the wire and must not trigger model fallback. */
export class PersonalAttemptLedgerUnavailableError extends Error {
  constructor() { super("Personal model attempt accounting is unavailable; retry later."); }
}

export type PersonalAttemptErrorDisposition =
  | "safe_refusal"
  | "terminal_unknown"
  | "terminal_cancelled";

/**
 * Keeps replay safety explicit without exposing the raw provider failure.
 * Callers may classify `cause` for sanitized reporting, but only a proven
 * pre-service refusal may enter another inference attempt.
 */
export class PersonalAttemptInvocationError extends Error {
  constructor(
    readonly disposition: PersonalAttemptErrorDisposition,
    override readonly cause: unknown,
  ) {
    super("Personal model attempt did not complete.");
    this.name = "PersonalAttemptInvocationError";
  }
}

/**
 * Shared request-level refusals documented by every supported personal direct
 * provider: invalid request, authentication, permission, missing model/route,
 * and rate/capacity admission. Other 4xx meanings vary by provider and remain
 * uncertain without stronger structured evidence. In particular, 408 can
 * follow accepted work and non-standard 499 can represent client cancellation.
 */
const VERIFIED_PRE_SERVICE_REFUSAL_STATUSES = new Set([400, 401, 403, 404, 429]);

export function classifyPersonalAttemptFailure(
  error: unknown,
  cancelled: boolean,
  providerWorkObserved = false,
): { outcome: "cancelled" | "failed" | "unknown"; failureCode: string; disposition: PersonalAttemptErrorDisposition } {
  if (cancelled) {
    return { outcome: "cancelled", failureCode: "cancelled", disposition: "terminal_cancelled" };
  }
  const status = classifyError(error).statusCode;
  if (!providerWorkObserved && status !== undefined && VERIFIED_PRE_SERVICE_REFUSAL_STATUSES.has(status)) {
    return { outcome: "failed", failureCode: "provider_refused", disposition: "safe_refusal" };
  }
  return { outcome: "unknown", failureCode: "outcome_unknown", disposition: "terminal_unknown" };
}

type SettlePersonalAttempt = (input: SettlePersonalLlmAttemptInput) => Promise<void>;
type PersonalAttemptDependencies = Readonly<{
  begin: typeof beginPersonalLlmAttempt;
  settle: SettlePersonalAttempt;
  owner: () => PersonalLlmAttemptOwnerBinding | null;
  beginService?: typeof beginServiceLlmAttempt;
  settleService?: SettlePersonalAttempt;
  beginServer?: typeof beginServerLlmAttempt;
  settleServer?: SettlePersonalAttempt;
}>;

const defaultDependencies: PersonalAttemptDependencies = {
  begin: beginPersonalLlmAttempt,
  settle: settlePersonalLlmAttempt,
  owner: getPersonalLlmAttemptOwner,
  beginService: beginServiceLlmAttempt, settleService: settleServiceLlmAttempt,
  beginServer: beginServerLlmAttempt, settleServer: settleServerLlmAttempt,
};

/** Retry one exact idempotent settlement without replaying inference. */
async function settlePersonalAttemptWithRetry(
  persist: SettlePersonalAttempt,
  input: SettlePersonalLlmAttemptInput,
): Promise<void> {
  const settlement = Object.freeze({ ...input, settledAt: input.settledAt ?? new Date() });
  try {
    await persist(settlement);
  } catch {
    // The first write may have committed before its acknowledgement was lost.
    // Reusing the same frozen update is safe once settlement is idempotent.
    await persist(settlement);
  }
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
  hasObservedProviderWork?: (() => boolean) | undefined;
  /** Optional live authority fence, evaluated immediately before provider work. */
  assertStillAuthorized?: (() => void | Promise<void>) | undefined;
  invoke: () => Promise<T>;
}, deps: PersonalAttemptDependencies = defaultDependencies): Promise<T> {
  const context = getUsageContext();
  const funding = context?.funding;
  const isMemoryWork = context && ["memory_review", "room_stenographer", "room_reflection", "room_event_compaction"].includes(context.callType);
  const isServerImageAssistance = context?.callType === "image_assistance" && funding?.kind === "server";
  const isSoulService = context?.callType === "soul" && funding?.kind === "service";
  if (!context || !funding || funding.providerRoute === "surplus"
    || (funding.kind !== "personal" && !isMemoryWork && !isServerImageAssistance && !isSoulService)) {
    if (input.assertStillAuthorized) {
      await input.assertStillAuthorized();
      input.signal?.throwIfAborted();
    }
    return input.invoke();
  }
  const nonpersonalBegin = funding.kind === "service" ? deps.beginService : deps.beginServer;
  const persistSettlement = funding.kind === "personal" ? deps.settle
    : funding.kind === "service" ? deps.settleService : deps.settleServer;
  if (!persistSettlement || (funding.kind !== "personal" && !nonpersonalBegin)) throw new PersonalAttemptLedgerUnavailableError();
  const owner = deps.owner();
  if (owner === null) throw new PersonalAttemptLedgerUnavailableError();
  const id = randomUUID();
  const pricing = structuredClone(resolveModelPrice(input.modelId, context.modelControl?.servingProfileId));
  try {
    const common = { id, ownerToken: owner.ownerToken,
      roomId: normalizeUsageRoomId(context.roomId),
      ...(typeof context.metadata?.["taskId"] === "string" ? { taskId: context.metadata["taskId"] } : {}),
      callType: context.callType, model: input.modelId,
      provider: input.modelId.split(":", 1)[0]!, providerRoute: funding.providerRoute,
      endpoint: input.endpoint,
      metadata: { ...(context.metadata ?? {}), usagePricingSource: pricing.source,
        pricingSnapshot: pricing.price, ...(context.modelControl ?? {}) },
    };
    if (funding.kind === "personal") await deps.begin({ ...common, userId: funding.humanUserId,
      credentialId: funding.credentialId, credentialRevision: funding.credentialRevision });
    else await nonpersonalBegin!({ ...common, userId: funding.humanUserId ?? context.userId ?? null });
  } catch { throw new PersonalAttemptLedgerUnavailableError(); }
  let usage: ExtractedUsage | undefined;
  let terminalOutcome: "succeeded" | "cancelled" | "failed" | "unknown" | undefined;
  let terminalFailureCode: string | undefined;
  let terminalProviderRequestId: string | undefined;
  let initialSettlementDone = false;
  let initialSettlementSucceeded = false;
  let knownCostSettled = false;
  let knownCostSettlementInFlight = false;
  const settle = async (
    outcome: "succeeded" | "cancelled" | "failed" | "unknown",
    preserveOutcome = false,
    knownUnsent = false,
  ) => {
    const evidence = usage;
    const hasTokenEvidence = evidence !== undefined
      && (evidence.inputTokens > 0 || evidence.outputTokens > 0
        || evidence.totalTokens !== undefined || evidence.reasoningTokens > 0
        || evidence.cachedInputTokens > 0 || evidence.cacheCreationTokens > 0);
    const costState = knownUnsent ? "actual" as const
      : evidence?.actualCostUsd != null ? "actual" as const
      : hasTokenEvidence ? "estimated" as const : "unknown" as const;
    const providerRequestId = evidence?.providerRequestId ?? terminalProviderRequestId;
    try {
      await settlePersonalAttemptWithRetry(persistSettlement, { attemptId: id, ownerToken: owner.ownerToken,
        outcome, costState,
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
        ...(knownUnsent ? { actualCostUsd: 0 } : {}),
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
  const finish = async (outcome: NonNullable<typeof terminalOutcome>, knownUnsent = false) => {
    terminalOutcome = outcome;
    const evidenceAtSettlement = usage;
    initialSettlementSucceeded = await settle(outcome, false, knownUnsent);
    initialSettlementDone = true;
    // Usage can arrive while the terminal database write is in flight.
    if (usage && usage !== evidenceAtSettlement && !knownCostSettled
      && hasKnownFinancialEvidence(usage)) {
      await settle(outcome, initialSettlementSucceeded);
    }
  };
  let authorizationGuardEntered = false;
  let invocationEntered = false;
  try {
    if (input.assertStillAuthorized) {
      authorizationGuardEntered = true;
      await input.assertStillAuthorized();
      input.signal?.throwIfAborted();
    }
    invocationEntered = true;
    const result = await runWithUsageContext({ ...context, trackedAttemptId: id,
      onAttemptUsage: (observed) => {
        usage = observed;
        if (terminalOutcome && initialSettlementDone && !knownCostSettled
          && !knownCostSettlementInFlight
          && hasKnownFinancialEvidence(observed)) {
          // A late financial callback cannot turn a cancelled/unknown answer into success.
          knownCostSettlementInFlight = true;
          void settle(terminalOutcome, initialSettlementSucceeded)
            .finally(() => { knownCostSettlementInFlight = false; });
        }
      },
    }, input.invoke);
    await finish("succeeded");
    return result;
  } catch (error) {
    if (authorizationGuardEntered && !invocationEntered) {
      const cancelled = input.signal?.aborted === true;
      terminalFailureCode = cancelled ? "cancelled" : "authorization_changed";
      await finish(cancelled ? "cancelled" : "failed", true);
      throw error;
    }
    const failure = classifyPersonalAttemptFailure(
      error,
      input.signal?.aborted === true,
      hasKnownFinancialEvidence(usage) || input.hasObservedProviderWork?.() === true,
    );
    terminalFailureCode = failure.failureCode;
    terminalProviderRequestId = providerRequestIdFromError(error);
    await finish(failure.outcome);
    throw new PersonalAttemptInvocationError(failure.disposition, error);
  }
}
