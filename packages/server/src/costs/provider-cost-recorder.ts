import {
  insertProviderCostEvent,
  providerCostIdempotencyKey,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";

import type { UsageFundingProvenance } from "@nautilo/agent";

export type ServerProviderCostReceipt = Readonly<{
  identity: string;
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

export async function safelyRecordProviderCost(receipt: ServerProviderCostReceipt, insert = insertProviderCostEvent): Promise<void> {
  try {
    const funding = receipt.usageFunding;
    await insert({
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
      idempotencyKey: providerCostIdempotencyKey(`${funding?.kind === "personal" ? `personal:${funding.payerHumanId}:${funding.credentialId}:${funding.credentialRevision}:` : ""}${receipt.identity}`),
    });
  } catch {
    warn(`[provider-costs] Failed to record ${receipt.provider} ${receipt.operation}`);
  }
}
