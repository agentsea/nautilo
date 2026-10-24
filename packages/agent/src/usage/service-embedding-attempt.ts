import { randomUUID } from "node:crypto";
import {
  beginServiceLlmAttempt,
  settleServiceLlmAttempt,
  type BeginServiceLlmAttemptInput,
  type SettlePersonalLlmAttemptInput,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";
import type { EmbeddingProvider } from "@nautilo/types";
import {
  estimateCostFromPrice,
  PRICING_VERSION,
  resolveModelPrice,
} from "../config/model-pricing";
import {
  getPersonalLlmAttemptOwner,
  type PersonalLlmAttemptOwnerBinding,
} from "./personal-llm-attempt-owner";
import { getUsageContext, normalizeUsageRoomId } from "./usage-context";

/** Service-funded embeddings must have a durable row before provider dispatch. */
export class ServiceEmbeddingAttemptLedgerUnavailableError extends Error {
  constructor() {
    super("Service embedding attempt accounting is unavailable; retry later.");
    this.name = "ServiceEmbeddingAttemptLedgerUnavailableError";
  }
}

export interface ServiceEmbeddingAttemptEvidence {
  /** Provider-reported input tokens. Explicit zero remains evidence. */
  inputTokens?: number;
  /** Provider-reported total tokens. Explicit zero remains evidence. */
  totalTokens?: number;
  /** Provider-reported cost. Explicit zero is an actual-cost receipt. */
  actualCostUsd?: number;
  providerRequestId?: string;
}

export interface ServiceEmbeddingAttemptInput<T> {
  provider: EmbeddingProvider;
  /** Exact provider model, without adding another provider prefix. */
  model: string;
  endpoint: string;
  dimensions: number;
  signal?: AbortSignal;
  /** Revalidate the selected route and credential after durable admission. */
  assertStillAuthorized?: () => void;
  invoke: (
    observeEvidence: (evidence: ServiceEmbeddingAttemptEvidence) => void,
  ) => Promise<T>;
}

type SettleServiceAttempt = (input: SettlePersonalLlmAttemptInput) => Promise<void>;

export interface ServiceEmbeddingAttemptDependencies {
  begin: (input: BeginServiceLlmAttemptInput) => Promise<void>;
  settle: SettleServiceAttempt;
  owner: () => PersonalLlmAttemptOwnerBinding | null;
}

const defaultDependencies: ServiceEmbeddingAttemptDependencies = {
  begin: beginServiceLlmAttempt,
  settle: settleServiceLlmAttempt,
  owner: getPersonalLlmAttemptOwner,
};

function causalHumanId(): string | null {
  const context = getUsageContext();
  const candidate = context?.funding?.humanUserId ?? context?.userId;
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

/** Retry one exact idempotent settlement without ever replaying provider work. */
async function settleWithRetry(
  persist: SettleServiceAttempt,
  input: SettlePersonalLlmAttemptInput,
): Promise<void> {
  const settlement = Object.freeze({ ...input, settledAt: input.settledAt ?? new Date() });
  try {
    await persist(settlement);
  } catch {
    await persist(settlement);
  }
}

function taskIdFromContext(): string | undefined {
  const taskId = getUsageContext()?.metadata?.["taskId"];
  return typeof taskId === "string" && taskId.trim() ? taskId : undefined;
}

function serviceMetadata(): Record<string, unknown> {
  const metadata = { ...(getUsageContext()?.metadata ?? {}) };
  for (const key of [
    "funding",
    "fundingKind",
    "payerHumanId",
    "credentialId",
    "credentialRevision",
    "providerRoute",
  ]) delete metadata[key];
  return metadata;
}

/**
 * Account for one direct service-funded embedding wire attempt. Ambient
 * personal/server funding may provide causal attribution, but never payer or
 * credential provenance; the service DB admission freezes those fields.
 */
export async function runServiceEmbeddingAttempt<T>(
  input: ServiceEmbeddingAttemptInput<T>,
  deps: ServiceEmbeddingAttemptDependencies = defaultDependencies,
): Promise<T> {
  const owner = deps.owner();
  if (owner === null) throw new ServiceEmbeddingAttemptLedgerUnavailableError();

  const context = getUsageContext();
  const attemptId = randomUUID();
  const modelId = `${input.provider}:${input.model}`;
  const pricing = structuredClone(resolveModelPrice(modelId));
  const taskId = taskIdFromContext();
  try {
    await deps.begin({
      id: attemptId,
      ownerToken: owner.ownerToken,
      userId: causalHumanId(),
      roomId: normalizeUsageRoomId(context?.roomId),
      ...(taskId === undefined ? {} : { taskId }),
      callType: "embedding",
      provider: input.provider,
      model: modelId,
      providerRoute: input.provider,
      endpoint: input.endpoint,
      metadata: {
        ...serviceMetadata(),
        embeddingDimensions: input.dimensions,
        usagePricingSource: pricing.source,
        pricingSnapshot: pricing.price,
      },
    });
  } catch {
    throw new ServiceEmbeddingAttemptLedgerUnavailableError();
  }

  let evidence: ServiceEmbeddingAttemptEvidence | undefined;
  const observeEvidence = (next: ServiceEmbeddingAttemptEvidence): void => {
    evidence = { ...(evidence ?? {}), ...next };
  };
  const settle = async (
    outcome: "succeeded" | "failed" | "cancelled" | "unknown",
    failureCode?: string,
    knownPreWireZero = false,
  ): Promise<void> => {
    const hasReportedUsage = evidence?.inputTokens !== undefined
      || evidence?.totalTokens !== undefined;
    const hasActualCost = evidence?.actualCostUsd !== undefined;
    const costState = knownPreWireZero
      ? "actual" as const
      : hasActualCost
      ? "actual" as const
      : hasReportedUsage
        ? "estimated" as const
        : "unknown" as const;
    const billableInputTokens = evidence?.inputTokens ?? evidence?.totalTokens;
    const estimatedCostUsd = hasReportedUsage
      ? estimateCostFromPrice(pricing.price, {
          inputTokens: billableInputTokens ?? 0,
          outputTokens: 0,
        })
      : undefined;
    try {
      await settleWithRetry(deps.settle, {
        attemptId,
        ownerToken: owner.ownerToken,
        outcome,
        costState,
        ...(evidence?.inputTokens === undefined
          ? {}
          : { inputTokens: evidence.inputTokens }),
        ...(evidence?.totalTokens === undefined
          ? {}
          : { totalTokens: evidence.totalTokens }),
        ...(estimatedCostUsd === undefined
          ? {}
          : { estimatedCostUsd, pricingVersion: PRICING_VERSION }),
        ...(knownPreWireZero
          ? { actualCostUsd: 0 }
          : evidence?.actualCostUsd === undefined
            ? {}
            : { actualCostUsd: evidence.actualCostUsd }),
        ...(evidence?.providerRequestId === undefined
          ? {}
          : { providerRequestId: evidence.providerRequestId }),
        ...(failureCode === undefined ? {} : { failureCode }),
        metadata: { embeddingDimensions: input.dimensions },
      });
    } catch {
      // The pre-wire row remains recoverable. Accounting failure must never
      // cause another provider request.
      warn("[nautilo/usage] service embedding attempt settlement unavailable", {
        failureCode: "attempt_settlement_failed",
      });
    }
  };

  let providerDispatched = false;
  try {
    input.assertStillAuthorized?.();
    input.signal?.throwIfAborted();
    providerDispatched = true;
    const value = await input.invoke(observeEvidence);
    await settle("succeeded");
    return value;
  } catch (error) {
    if (!providerDispatched) {
      if (input.signal?.aborted === true) await settle("cancelled", "cancelled", true);
      else await settle("failed", "pre_wire_authorization_changed", true);
    } else if (input.signal?.aborted === true) await settle("cancelled", "cancelled");
    else await settle("unknown", "outcome_unknown");
    throw error;
  }
}
