import {
  deliverAuthoredMemorySemanticChange,
  type AuthoredMemorySemanticChangeKind,
} from "./authored-memory-semantic-change";

export type CommittedForegroundMemoryEffectReceipt = Readonly<{
  operationId: string;
  memoryId: string;
  changeKind: AuthoredMemorySemanticChangeKind;
  completion: "complete";
  acknowledgedAt: Date | null;
}>;

export type ForegroundMemoryEffectAcknowledgement = Readonly<{
  operationId: string;
  memoryId: string;
  changeKind: AuthoredMemorySemanticChangeKind;
}>;

/**
 * Delivers one committed foreground Memory effect with its durable operation
 * identity. Delivery and acknowledgement are intentionally post-commit: a
 * failure leaves the receipt pending for an identical retry and cannot change
 * the outcome of the Memory mutation.
 */
export async function deliverForegroundMemoryMutationEffect(input: Readonly<{
  receipt: CommittedForegroundMemoryEffectReceipt;
  acknowledge(
    acknowledgement: ForegroundMemoryEffectAcknowledgement,
  ): Promise<"acknowledged" | "already_acknowledged">;
}>): Promise<"acknowledged" | "pending"> {
  const { receipt } = input;
  if (receipt.acknowledgedAt !== null) return "acknowledged";
  const acknowledgement = Object.freeze({
    operationId: receipt.operationId,
    memoryId: receipt.memoryId,
    changeKind: receipt.changeKind,
  });
  try {
    await deliverAuthoredMemorySemanticChange(Object.freeze({
      memoryId: receipt.memoryId,
      changeKind: receipt.changeKind,
      changeRef: `memory-change:stable:${receipt.operationId}`,
    }));
    await input.acknowledge(acknowledgement);
    return "acknowledged";
  } catch {
    return "pending";
  }
}
