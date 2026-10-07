import { randomUUID } from "node:crypto";
import type { ToolContext } from "@nautilo/catalog";
import {
  insertProviderCostEvent,
  settleProviderCostEvent,
  providerCostIdempotencyKey,
  type InsertProviderCostEventInput,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";

import { getUsageContext, type UsageFundingProvenance } from "./usage-context";

export type ProviderCostReceipt = Readonly<{
  usageFunding?: UsageFundingProvenance;
  provider: string;
  operation: string;
  receiptId?: string | null;
  estimatedCostUsd?: string | null;
  actualCostUsd?: string | null;
  evidenceState: "actual" | "estimated" | "unknown";
}>;

export type ProviderCostRecorder = (receipt: ProviderCostReceipt) => Promise<void>;

export function createToolProviderCostRecorder(
  context?: ToolContext,
  insert: (input: InsertProviderCostEventInput) => Promise<void> = insertProviderCostEvent,
): ProviderCostRecorder {
  let sequence = 0;
  const recorderId = randomUUID();
  return async (receipt) => {
    const ordinal = sequence++;
    const localExecutionId = String(
      context?.["toolCallId"] ?? context?.["turnId"] ?? context?.["turnContextId"] ?? recorderId,
    );
    try {
      const funding = receipt.usageFunding ?? getUsageContext()?.funding;
      await insert({
        ...providerCostFundingFields(funding),
        userId: typeof context?.["userId"] === "string"
          ? context["userId"]
          : typeof context?.["ownerId"] === "string" ? context["ownerId"] : null,
        roomId: typeof context?.["roomId"] === "string" ? context["roomId"] : null,
        agentId: typeof context?.["agentId"] === "string" ? context["agentId"] : null,
        provider: receipt.provider,
        operation: receipt.operation,
        estimatedCostUsd: receipt.estimatedCostUsd ?? null,
        actualCostUsd: receipt.actualCostUsd ?? null,
        evidenceState: receipt.evidenceState,
        idempotencyKey: providerCostIdempotencyKey(
          `${funding?.kind === "personal" ? `personal:${funding.payerHumanId}:${funding.credentialId}:${funding.credentialRevision}:` : ""}${receipt.provider}:${receipt.operation}:${receipt.receiptId ?? `${localExecutionId}:${ordinal}`}`,
        ),
      });
    } catch {
      warn(`[provider-costs] Failed to record ${receipt.provider} ${receipt.operation}`);
    }
  };
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
  admission: Pick<ProviderCostReceipt, "provider" | "operation"> & { usageFunding: UsageFundingProvenance },
  deps: { insert?: typeof insertProviderCostEvent; settle?: typeof settleProviderCostEvent } = {},
): Promise<ProviderCostRecorder> {
  const input: InsertProviderCostEventInput = {
    ...providerCostFundingFields(admission.usageFunding),
    userId: admission.usageFunding.humanUserId ?? null,
    roomId: typeof context?.["roomId"] === "string" ? context["roomId"] : null,
    agentId: typeof context?.["agentId"] === "string" ? context["agentId"] : null,
    provider: admission.provider, operation: admission.operation,
    evidenceState: "unknown", idempotencyKey: providerCostIdempotencyKey(randomUUID()),
  };
  await (deps.insert ?? insertProviderCostEvent)(input);
  return async (receipt) => {
    if (receipt.provider !== admission.provider || receipt.operation !== admission.operation) throw new Error("Provider cost attempt identity changed");
    await (deps.settle ?? settleProviderCostEvent)({ ...input,
      evidenceState: receipt.evidenceState,
      estimatedCostUsd: receipt.estimatedCostUsd ?? null,
      actualCostUsd: receipt.actualCostUsd ?? null,
    });
  };
}
