import { randomUUID } from "node:crypto";
import type { ToolContext } from "@nautilo/catalog";
import {
  insertProviderCostEvent,
  providerCostIdempotencyKey,
  type InsertProviderCostEventInput,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";

export type ProviderCostReceipt = Readonly<{
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
      await insert({
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
          `${receipt.provider}:${receipt.operation}:${receipt.receiptId ?? `${localExecutionId}:${ordinal}`}`,
        ),
      });
    } catch {
      warn(`[provider-costs] Failed to record ${receipt.provider} ${receipt.operation}`);
    }
  };
}
