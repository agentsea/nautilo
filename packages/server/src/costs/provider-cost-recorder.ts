import {
  claimProviderCostEvent,
  insertProviderCostEvent,
  settleProviderCostEvent,
  providerCostRequestReference,
  type InsertProviderCostEventInput,
  type ProviderCostClaimOutcome,
  providerCostIdempotencyKey,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";

import type { UsageFundingProvenance } from "@nautilo/agent";

export type ServerProviderCostReceipt = Readonly<{
  identity: string;
  receiptId?: string | null;
  usageFunding?: UsageFundingProvenance;
  userId?: string | null;
  roomId?: string | null;
  agentId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  jobId?: string | null;
  workload?: string | null;
  provider: string;
  operation: string;
  estimatedCostUsd?: string | null;
  actualCostUsd?: string | null;
  evidenceState: "actual" | "estimated" | "unknown";
  attemptOutcome?: "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown" | null;
  failureCode?: string | null;
  pricingVersion?: string | null;
  measuredUnits?: number | null;
  unitType?: string | null;
}>;

function costEvent(receipt: ServerProviderCostReceipt): InsertProviderCostEventInput {
  const funding = receipt.usageFunding;
  return {
    ...(funding ? { fundingKind: funding.kind, providerRoute: funding.providerRoute } : {}),
    ...(funding?.kind === "personal" ? { payerHumanId: funding.payerHumanId, credentialId: funding.credentialId, credentialRevision: funding.credentialRevision } : {}),
    userId: receipt.userId ?? null,
    roomId: receipt.roomId ?? null,
    agentId: receipt.agentId ?? null,
    taskId: receipt.taskId ?? null,
    runId: receipt.runId ?? null,
    jobId: receipt.jobId ?? null,
    workload: receipt.workload ?? null,
    provider: receipt.provider,
    operation: receipt.operation,
    estimatedCostUsd: receipt.estimatedCostUsd ?? null,
    actualCostUsd: receipt.actualCostUsd ?? null,
    evidenceState: receipt.evidenceState,
    attemptOutcome: receipt.attemptOutcome ?? null,
    failureCode: receipt.failureCode ?? null,
    pricingVersion: receipt.pricingVersion ?? null,
    measuredUnits: receipt.measuredUnits ?? null,
    unitType: receipt.unitType ?? null,
    ...(receipt.receiptId === undefined ? {} : { requestReference: providerCostRequestReference(receipt.receiptId) }),
    idempotencyKey: providerCostIdempotencyKey(`${funding?.kind === "personal" ? `personal:${funding.payerHumanId}:${funding.credentialId}:${funding.credentialRevision}:` : ""}${receipt.identity}`),
  };
}

export type ServerProviderCostAttemptAdmission = Omit<ServerProviderCostReceipt,
  "receiptId" | "estimatedCostUsd" | "actualCostUsd" | "evidenceState" | "attemptOutcome"
  | "failureCode" | "pricingVersion" | "measuredUnits" | "unitType">;

/**
 * Persist uncertainty before dispatch. The lifecycle owner supplies a stable
 * identity and fences provider effects; ledger deduplication alone is not a
 * provider idempotency guarantee. Insertion failure must prevent dispatch.
 */
export async function beginServerProviderCostAttempt(
  admission: ServerProviderCostAttemptAdmission,
  insert = insertProviderCostEvent,
): Promise<void> {
  await insert(costEvent({ ...admission, evidenceState: "unknown", attemptOutcome: "unknown" }));
}

/**
 * Atomically claims a pre-dispatch attempt. Unlike the additive `begin`
 * helper, this exposes whether an earlier process already owns the identity.
 */
export async function claimServerProviderCostAttempt(
  admission: ServerProviderCostAttemptAdmission,
  claim = claimProviderCostEvent,
): Promise<ProviderCostClaimOutcome> {
  return claim(costEvent({ ...admission, evidenceState: "unknown", attemptOutcome: "unknown" }));
}

/** The durable owner retries settlement with the same identity after restart. */
export async function settleServerProviderCostAttempt(
  receipt: ServerProviderCostReceipt,
  settle = settleProviderCostEvent,
): Promise<void> {
  await settle(costEvent(receipt));
}

export async function safelyRecordProviderCost(receipt: ServerProviderCostReceipt, insert = insertProviderCostEvent): Promise<void> {
  try {
    await insert(costEvent(receipt));
  } catch {
    warn(`[provider-costs] Failed to record ${receipt.provider} ${receipt.operation}`);
  }
}
