import { randomUUID } from "node:crypto";
import type { ToolContext } from "@nautilo/catalog";
import {
  insertProviderCostEvent,
  settleProviderCostEvent,
  providerCostIdempotencyKey,
  providerCostRequestReference,
  estimateProviderToolCostUsd,
  PROVIDER_TOOL_PRICING_VERSION,
  type InsertProviderCostEventInput,
  type ProviderToolPriceKey,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";

import { getUsageContext, type UsageContext, type UsageFundingProvenance } from "./usage-context";

export type ProviderCostReceipt = Readonly<{
  usageFunding?: UsageFundingProvenance;
  provider: string;
  operation: string;
  receiptId?: string | null;
  estimatedCostUsd?: string | null;
  actualCostUsd?: string | null;
  evidenceState: "actual" | "estimated" | "unknown";
  attemptOutcome?: "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown" | null;
  failureCode?: string | null;
  pricingVersion?: string | null;
  measuredUnits?: number | null;
  unitType?: string | null;
}>;

type ProviderCostAttemptAdmission = Pick<ProviderCostReceipt, "provider" | "operation"> & {
  usageFunding?: UsageFundingProvenance;
};

export type ProviderCostRecorder = ((receipt: ProviderCostReceipt) => Promise<void>) & Readonly<{
  /** Opens the durable unknown row before a paid provider dispatch. */
  beginAttempt?: (admission: ProviderCostAttemptAdmission) => Promise<ProviderCostRecorder>;
  /** True when this recorder settles an attempt that has already been opened. */
  attemptStarted?: boolean;
}>;

/** Captures the current rate card and only labels provider-reported units as measured. */
export function providerToolEstimateReceipt(
  priceKey: ProviderToolPriceKey,
  reportedUnits: number | null | undefined,
  fallbackUnits: number,
  unitType: string,
): Pick<ProviderCostReceipt,
  "estimatedCostUsd" | "evidenceState" | "pricingVersion" | "measuredUnits" | "unitType"> {
  const measuredUnits = typeof reportedUnits === "number"
    && Number.isFinite(reportedUnits) && reportedUnits >= 0
    ? reportedUnits
    : null;
  const estimatedCostUsd = estimateProviderToolCostUsd(priceKey, measuredUnits ?? fallbackUnits);
  return {
    estimatedCostUsd,
    evidenceState: estimatedCostUsd === null ? "unknown" : "estimated",
    pricingVersion: estimatedCostUsd === null ? null : PROVIDER_TOOL_PRICING_VERSION,
    measuredUnits,
    unitType: measuredUnits === null ? null : unitType,
  };
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function providerCostAttributionFields(
  context: ToolContext | undefined,
  usage: ReturnType<typeof getUsageContext>,
  funding: UsageFundingProvenance | undefined = usage?.funding,
) {
  return {
    userId: trimmedString(context?.["userId"])
      ?? trimmedString(context?.["ownerId"])
      ?? trimmedString(usage?.userId)
      ?? trimmedString(funding?.humanUserId),
    roomId: trimmedString(context?.["roomId"]) ?? trimmedString(usage?.roomId),
    agentId: trimmedString(context?.["agentId"]) ?? trimmedString(usage?.metadata?.["agentId"]),
    taskId: trimmedString(context?.["currentTaskId"]) ?? trimmedString(usage?.metadata?.["taskId"]),
    runId: trimmedString(context?.["currentTaskRunId"]) ?? trimmedString(usage?.metadata?.["taskRunId"]),
    jobId: trimmedString(context?.["jobId"]) ?? trimmedString(usage?.metadata?.["jobId"]),
    workload: usage?.callType ?? null,
  };
}

function providerCostEvidenceFields(receipt: ProviderCostReceipt) {
  return {
    estimatedCostUsd: receipt.estimatedCostUsd ?? null,
    actualCostUsd: receipt.actualCostUsd ?? null,
    evidenceState: receipt.evidenceState,
    attemptOutcome: receipt.attemptOutcome ?? null,
    failureCode: receipt.failureCode ?? null,
    pricingVersion: receipt.pricingVersion ?? null,
    measuredUnits: receipt.measuredUnits ?? null,
    unitType: receipt.unitType ?? null,
    requestReference: providerCostRequestReference(receipt.receiptId),
  };
}

export function createToolProviderCostRecorder(
  context?: ToolContext,
  insert: (input: InsertProviderCostEventInput) => Promise<void> = insertProviderCostEvent,
  settle: (input: InsertProviderCostEventInput) => Promise<void> = settleProviderCostEvent,
): ProviderCostRecorder {
  let sequence = 0;
  const recorderId = randomUUID();
  const usage = getUsageContext();
  const recorder = async (receipt: ProviderCostReceipt) => {
    const ordinal = sequence++;
    const localExecutionId = String(
      context?.["toolCallId"] ?? context?.["turnId"] ?? context?.["turnContextId"] ?? recorderId,
    );
    try {
      const funding = receipt.usageFunding ?? usage?.funding;
      await insert({
        ...providerCostFundingFields(funding),
        ...providerCostAttributionFields(context, usage, funding),
        provider: receipt.provider,
        operation: receipt.operation,
        ...providerCostEvidenceFields(receipt),
        idempotencyKey: providerCostIdempotencyKey(
          `${funding?.kind === "personal" ? `personal:${funding.payerHumanId}:${funding.credentialId}:${funding.credentialRevision}:` : ""}${receipt.provider}:${receipt.operation}:${receipt.receiptId ?? `${localExecutionId}:${ordinal}`}`,
        ),
      });
    } catch {
      warn(`[provider-costs] Failed to record ${receipt.provider} ${receipt.operation}`);
    }
  };
  return Object.assign(recorder, {
    beginAttempt: (admission: ProviderCostAttemptAdmission) =>
      beginToolProviderCostAttempt(context, {
        ...admission,
        ...(admission.usageFunding || !usage?.funding ? {} : { usageFunding: usage.funding }),
      }, { insert, settle, usageContext: usage ?? null }),
  });
}


function providerCostFundingFields(funding?: UsageFundingProvenance) {
  return funding ? {
    fundingKind: funding.kind,
    providerRoute: funding.providerRoute,
    ...(funding.kind === "personal" ? {
      payerHumanId: funding.payerHumanId,
      credentialId: funding.credentialId,
      credentialRevision: funding.credentialRevision,
    } : {}),
  } : {};
}

/** Fail closed before dispatch; a lost response leaves one truthful unknown row. */
export async function beginToolProviderCostAttempt(
  context: ToolContext | undefined,
  admission: ProviderCostAttemptAdmission,
  deps: {
    insert?: typeof insertProviderCostEvent;
    settle?: typeof settleProviderCostEvent;
    /** Internal/test seam for attribution captured by an enclosing recorder. */
    usageContext?: UsageContext | null;
  } = {},
): Promise<ProviderCostRecorder> {
  const usage = deps.usageContext === undefined ? getUsageContext() : deps.usageContext ?? undefined;
  const funding = admission.usageFunding ?? usage?.funding;
  const input: InsertProviderCostEventInput = {
    ...providerCostFundingFields(funding),
    ...providerCostAttributionFields(context, usage, funding),
    provider: admission.provider, operation: admission.operation,
    evidenceState: "unknown", attemptOutcome: "unknown",
    idempotencyKey: providerCostIdempotencyKey(randomUUID()),
  };
  await (deps.insert ?? insertProviderCostEvent)(input);
  const settleAttempt = async (receipt: ProviderCostReceipt) => {
    if (receipt.provider !== admission.provider || receipt.operation !== admission.operation) throw new Error("Provider cost attempt identity changed");
    try {
      await (deps.settle ?? settleProviderCostEvent)({
        ...input,
        ...providerCostEvidenceFields(receipt),
        attemptOutcome: receipt.attemptOutcome ?? input.attemptOutcome ?? "unknown",
      });
    } catch {
      warn(`[provider-costs] Failed to settle ${receipt.provider} ${receipt.operation}`);
    }
  };
  return Object.assign(settleAttempt, { attemptStarted: true as const });
}

/** Opens an attempt when supported, while preserving simple recorder test seams. */
export async function openProviderCostAttempt(
  recorder: ProviderCostRecorder | undefined,
  admission: Pick<ProviderCostReceipt, "provider" | "operation">,
): Promise<ProviderCostRecorder | undefined> {
  if (!recorder || recorder.attemptStarted) return recorder;
  return recorder.beginAttempt ? recorder.beginAttempt(admission) : recorder;
}
