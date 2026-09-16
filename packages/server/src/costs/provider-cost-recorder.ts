import {
  estimateProviderToolCostUsd,
  insertProviderCostEvent,
  providerCostIdempotencyKey,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";

export type ServerProviderCostReceipt = Readonly<{
  identity: string;
  userId?: string | null;
  roomId?: string | null;
  agentId?: string | null;
  provider: string;
  operation: string;
  estimatedCostUsd?: string | null;
  actualCostUsd?: string | null;
  evidenceState: "actual" | "estimated" | "unknown";
}>;

export async function safelyRecordProviderCost(receipt: ServerProviderCostReceipt): Promise<void> {
  try {
    await insertProviderCostEvent({
      userId: receipt.userId ?? null,
      roomId: receipt.roomId ?? null,
      agentId: receipt.agentId ?? null,
      provider: receipt.provider,
      operation: receipt.operation,
      estimatedCostUsd: receipt.estimatedCostUsd ?? null,
      actualCostUsd: receipt.actualCostUsd ?? null,
      evidenceState: receipt.evidenceState,
      idempotencyKey: providerCostIdempotencyKey(receipt.identity),
    });
  } catch {
    warn(`[provider-costs] Failed to record ${receipt.provider} ${receipt.operation}`);
  }
}

/** ElevenLabs v3 public API baseline: $0.10 per 1,000 input characters. */
export function estimateElevenLabsV3TtsUsd(text: string): string {
  return estimateProviderToolCostUsd("elevenlabs:v3_character", text.length) ?? "0.00000000";
}
