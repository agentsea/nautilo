import { LATTICE_LIMITS } from "@nautilo/lattice-crypto";

export interface TaskOrdinaryFallbackReceiptV1 {
  readonly ordinaryFallbackOperationId: string | null;
  readonly ordinaryFallbackRequestDigest: Uint8Array | null;
  readonly ordinaryFallbackReason: string | null;
  readonly ordinaryFallbackPolicyRevision: number | null;
  readonly ordinaryFallbackCompletedAt: Date | null;
}

/** Structural receipt check, never a substitute for signature or current authority. */
export function hasTaskOrdinaryFallbackReceiptV1(receipt: TaskOrdinaryFallbackReceiptV1): boolean {
  return typeof receipt.ordinaryFallbackOperationId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(receipt.ordinaryFallbackOperationId)
    && new TextEncoder().encode(receipt.ordinaryFallbackOperationId).length <= LATTICE_LIMITS.idBytes
    && receipt.ordinaryFallbackRequestDigest instanceof Uint8Array
    && receipt.ordinaryFallbackRequestDigest.length === 32
    && receipt.ordinaryFallbackReason === "target_encryption_not_ready"
    && typeof receipt.ordinaryFallbackPolicyRevision === "number"
    && Number.isSafeInteger(receipt.ordinaryFallbackPolicyRevision)
    && receipt.ordinaryFallbackPolicyRevision > 0
    && receipt.ordinaryFallbackCompletedAt instanceof Date
    && Number.isFinite(receipt.ordinaryFallbackCompletedAt.getTime());
}
