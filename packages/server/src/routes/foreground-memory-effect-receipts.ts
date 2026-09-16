import { deliverForegroundMemoryMutationEffect } from "@nautilo/agent";
import {
  and,
  eq,
  inArray,
  isNull,
  memoryCryptoOperations,
} from "@nautilo/db";
import type {
  ProtectedAgentMemoryRepository,
  ProtectedMemoryAuthority,
  ProtectedMemoryResult,
} from "@nautilo/lattice-bridge";
import type {
  AgentMemoryPublicationBoundary,
  ConversationProductCanonicalTransactionRunner,
  HumanMemoryPublicationBoundary,
  HumanMemoryProductAuthority,
} from "@nautilo/lattice-bridge/server";

export type ForegroundMemoryEffectReceiptStatus =
  | "not_required"
  | "acknowledged"
  | "pending";

export type DeliverForegroundMemoryEffectReceipt = (input: Readonly<{
  authority: ProtectedMemoryAuthority;
  operationId: string;
  memoryId: string;
}>) => Promise<ForegroundMemoryEffectReceiptStatus>;

async function withMutationEffect<Value>(
  result: ProtectedMemoryResult<Value>,
  receipt: Readonly<{
    authority: ProtectedMemoryAuthority;
    operationId: string;
    memoryId: string;
  }>,
  deliver: DeliverForegroundMemoryEffectReceipt,
  wakeRecovery: () => void,
): Promise<ProtectedMemoryResult<Value>> {
  if (result.status !== "success") return result;
  try {
    const status = await deliver(receipt);
    if (status !== "pending") return result;
    inputWake(wakeRecovery);
    return Object.freeze({ ...result, followUpPending: true as const });
  } catch {
    inputWake(wakeRecovery);
    return Object.freeze({ ...result, followUpPending: true as const });
  }
}

function inputWake(wake: () => void): void {
  try {
    wake();
  } catch {
    // Wake failure cannot change or hide the already-committed mutation.
  }
}

/** Adds post-commit effect delivery without changing Memory mutation authority. */
export function withForegroundMemoryEffectReceipts(input: Readonly<{
  repository: ProtectedAgentMemoryRepository;
  deliver: DeliverForegroundMemoryEffectReceipt;
  wakeRecovery: () => void;
}>): ProtectedAgentMemoryRepository {
  return Object.freeze({
    search: (request: Parameters<ProtectedAgentMemoryRepository["search"]>[0]) =>
      input.repository.search(request),
    async save(request: Parameters<ProtectedAgentMemoryRepository["save"]>[0]) {
      const result = await input.repository.save(request);
      if (result.status !== "success") return result;
      return withMutationEffect(result, {
        authority: request.authority,
        operationId: request.operationId,
        memoryId: result.value.id,
      }, input.deliver, input.wakeRecovery);
    },
    async replace(request: Parameters<ProtectedAgentMemoryRepository["replace"]>[0]) {
      const result = await input.repository.replace(request);
      return withMutationEffect(result, {
        authority: request.authority,
        operationId: request.operationId,
        memoryId: request.memoryId,
      }, input.deliver, input.wakeRecovery);
    },
    async setTier(request: Parameters<ProtectedAgentMemoryRepository["setTier"]>[0]) {
      const result = await input.repository.setTier(request);
      return withMutationEffect(result, {
        authority: request.authority,
        operationId: request.operationId,
        memoryId: request.memoryId,
      }, input.deliver, input.wakeRecovery);
    },
  });
}

function readableNamespaceIds(
  authority: ProtectedMemoryAuthority,
): readonly string[] {
  return authority.mode === "namespace"
    ? authority.readableNamespaceIds
    : [authority.originWritableNamespaceId];
}

/** Deliver and acknowledge only one exact, already-committed mutation receipt. */
export async function deliverCommittedForegroundMemoryEffect(input: Readonly<{
  canonicalRunner: ConversationProductCanonicalTransactionRunner;
  beforeLocks: AgentMemoryPublicationBoundary["beforeLocks"];
  authority: ProtectedMemoryAuthority;
  operationId: string;
  memoryId: string;
}>): Promise<ForegroundMemoryEffectReceiptStatus> {
  if (input.canonicalRunner.role !== "nautilo_agent") {
    throw new TypeError("Foreground Memory effects require a nautilo_agent canonical runner");
  }
  return deliverCommittedMemoryEffect({
    canonicalRunner: input.canonicalRunner,
    namespaces: readableNamespaceIds(input.authority),
    operationId: input.operationId,
    memoryId: input.memoryId,
    fence: (transaction) => input.beforeLocks({
      transaction, authority: input.authority, mutation: false,
    }),
  });
}

/** Human library mutations use their ordinary product-role transaction, not
 * an invented Agent identity. Both actors deliver the same durable receipt. */
export async function deliverCommittedHumanMemoryEffect(input: Readonly<{
  canonicalRunner: ConversationProductCanonicalTransactionRunner;
  publication: Pick<HumanMemoryPublicationBoundary, "fence">;
  authority: HumanMemoryProductAuthority;
  operationId: string;
  memoryId: string;
}>): Promise<ForegroundMemoryEffectReceiptStatus> {
  if (input.canonicalRunner.role !== "nautilo") {
    throw new TypeError("Human Memory effects require a nautilo canonical runner");
  }
  return deliverCommittedMemoryEffect({
    canonicalRunner: input.canonicalRunner,
    namespaces: input.authority.mutableNamespaceIds,
    operationId: input.operationId,
    memoryId: input.memoryId,
    fence: (transaction) => input.publication.fence({
      transaction, authority: input.authority, mutation: true,
    }),
  });
}

async function deliverCommittedMemoryEffect(input: Readonly<{
  canonicalRunner: ConversationProductCanonicalTransactionRunner;
  namespaces: readonly string[];
  operationId: string;
  memoryId: string;
  fence: (transaction: Parameters<HumanMemoryPublicationBoundary["fence"]>[0]["transaction"])
    => Promise<void>;
}>): Promise<ForegroundMemoryEffectReceiptStatus> {
  const namespaces = input.namespaces;
  if (namespaces.length === 0) return "pending";
  let receipt;
  try {
    receipt = await input.canonicalRunner.transaction(async (transaction) => {
      await input.fence(transaction);
      const rows = await transaction.select({
        operationId: memoryCryptoOperations.operationId,
        memoryId: memoryCryptoOperations.memoryId,
        changeKind: memoryCryptoOperations.semanticChangeKind,
        completion: memoryCryptoOperations.completion,
        acknowledgedAt: memoryCryptoOperations.semanticChangeAcknowledgedAt,
      }).from(memoryCryptoOperations).where(and(
        eq(memoryCryptoOperations.operationId, input.operationId),
        eq(memoryCryptoOperations.memoryId, input.memoryId),
        inArray(memoryCryptoOperations.anchorNamespaceId, namespaces),
      )).limit(2);
      return rows.length === 1 ? rows[0]! : null;
    }, { isolationLevel: "serializable" });
  } catch {
    return "pending";
  }

  if (receipt === null || (receipt.completion !== "complete"
    && receipt.completion !== "ordinary_fallback")) return "pending";
  if (receipt.changeKind === null) return "not_required";
  if (receipt.acknowledgedAt !== null) return "acknowledged";
  const changeKind = receipt.changeKind;

  return deliverForegroundMemoryMutationEffect({
    receipt: {
      operationId: receipt.operationId,
      memoryId: receipt.memoryId,
      changeKind,
      completion: "complete",
      acknowledgedAt: null,
    },
    acknowledge: async () => input.canonicalRunner.transaction(
      async (transaction) => {
        await input.fence(transaction);
        const acknowledged = await transaction.update(memoryCryptoOperations)
          .set({ semanticChangeAcknowledgedAt: new Date() })
          .where(and(
            eq(memoryCryptoOperations.operationId, input.operationId),
            eq(memoryCryptoOperations.memoryId, input.memoryId),
            eq(memoryCryptoOperations.semanticChangeKind, changeKind),
            inArray(memoryCryptoOperations.completion,
              ["complete", "ordinary_fallback"]),
            inArray(memoryCryptoOperations.anchorNamespaceId, namespaces),
            isNull(memoryCryptoOperations.semanticChangeAcknowledgedAt),
          )).returning({ operationId: memoryCryptoOperations.operationId });
        if (acknowledged.length === 1) return "acknowledged" as const;
        const exact = await transaction.select({
          acknowledgedAt: memoryCryptoOperations.semanticChangeAcknowledgedAt,
        }).from(memoryCryptoOperations).where(and(
          eq(memoryCryptoOperations.operationId, input.operationId),
          eq(memoryCryptoOperations.memoryId, input.memoryId),
          eq(memoryCryptoOperations.semanticChangeKind, changeKind),
          inArray(memoryCryptoOperations.completion,
            ["complete", "ordinary_fallback"]),
          inArray(memoryCryptoOperations.anchorNamespaceId, namespaces),
        )).limit(2);
        if (exact.length === 1 && exact[0]!.acknowledgedAt !== null) {
          return "already_acknowledged" as const;
        }
        throw new Error("Foreground Memory effect acknowledgement lost its exact receipt");
      },
      { isolationLevel: "serializable" },
    ),
  });
}
