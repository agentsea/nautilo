import {
  and,
  eq,
  isNotNull,
  isNull,
  memories,
  memoryCryptoRevisions,
  sql,
} from "@nautilo/db";

import {
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductPostgresTransaction,
} from "../message/postgres-conversation-product-store.ts";
import {
  readCurrentTaskScopeMemoryMutationMetadata,
  type TaskScopeCoordinates,
} from "./task-scope-memory-metadata.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type TaskScopeMemoryOriginAdoptionResult =
  | "adopted"
  | "replayed"
  | "stale";

export type TaskScopeMemoryOriginAdoptionInput = Readonly<{
  transaction: ConversationProductPostgresTransaction;
  coordinates: TaskScopeCoordinates;
  memoryId: string;
}>;

function exactCoordinates(value: TaskScopeCoordinates): boolean {
  return Object.keys(value).sort().join(",")
      === "agentId,memoryRoomId,originWritableNamespaceId,requesterUserId,scopeId,taskId"
    && UUID.test(value.taskId)
    && UUID.test(value.requesterUserId)
    && UUID.test(value.agentId)
    && UUID.test(value.scopeId)
    && UUID.test(value.memoryRoomId)
    && UUID.test(value.originWritableNamespaceId);
}

/**
 * Adopt one selected legacy Scope-authored ordinary Memory into the current
 * Task Memory Namespace. The caller retains the policy, Task/Run/Job, grant,
 * Namespace and Room locks on this exact product transaction. This leaf takes
 * only the later Scope and selected Memory locks and never infers an origin for
 * reads. A non-null origin is immutable: the same origin replays, while a
 * different winner is stale.
 */
export async function adoptLegacyTaskScopeMemoryOrigin(
  input: TaskScopeMemoryOriginAdoptionInput,
): Promise<TaskScopeMemoryOriginAdoptionResult> {
  if (!exactCoordinates(input.coordinates) || !UUID.test(input.memoryId)) {
    throw new TypeError("Task Scope Memory origin coordinates are invalid");
  }
  const coordinates = Object.freeze({ ...input.coordinates });
  const metadata = await readCurrentTaskScopeMemoryMutationMetadata({
    transaction: input.transaction,
    coordinates,
    memoryId: input.memoryId,
  });
  const memory = metadata?.[0];
  if (metadata === null || metadata.length !== 1 || memory === undefined
    || memory.memoryId !== input.memoryId || memory.origin !== "scope") {
    return "stale";
  }
  if (memory.scopeOriginNamespaceId !== null) {
    return memory.scopeOriginNamespaceId
        === coordinates.originWritableNamespaceId
      ? "replayed"
      : "stale";
  }

  // The metadata reader exposes this sentinel only for a Scope-authored row
  // with an ordinary body and no ordinary audience, protected mapping, or
  // stored origin. Keep the leaf coupled to that explicit contract.
  if (memory.requiredNamespaceIds.length !== 0
    || memory.ordinaryNamespaceIds.length !== 0
    || memory.cryptoObjectId !== null
    || memory.mappingState !== "unmapped"
    || memory.requiredNamespaceFingerprint !== null) return "stale";

  // Do not lock lifecycle rows here. Mapping CAS takes lifecycle before Memory;
  // this operation already holds Memory and must not introduce the reverse
  // lock order. Schema constraints own allocation shape; only an already
  // mapped revision makes this ordinary row contradictory.
  const mappedRows = await executeTypedConversationProductQuery(
    input.transaction,
    conversationProductTypedDb.select({
      memory_id: memoryCryptoRevisions.memoryId,
      content_revision: memoryCryptoRevisions.contentRevision,
    }).from(memoryCryptoRevisions).where(and(
      eq(memoryCryptoRevisions.memoryId, input.memoryId),
      eq(memoryCryptoRevisions.disposition, "mapped"),
    )).limit(1),
  );
  if (mappedRows.length !== 0) return "stale";

  const updated = await executeTypedConversationProductQuery(
    input.transaction,
    conversationProductTypedDb.update(memories).set({
      scopeOriginNamespaceId: coordinates.originWritableNamespaceId,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    }).where(and(
      eq(memories.id, input.memoryId),
      isNotNull(memories.type),
      isNotNull(memories.content),
      eq(memories.contentRevision, memory.contentRevision),
      eq(memories.cryptoAccessRevision, memory.cryptoAccessRevision),
      isNull(memories.cryptoObjectId),
      eq(memories.cryptoMappingState, "unmapped"),
      isNull(memories.cryptoRequiredNamespaceFingerprint),
      isNull(memories.scopeOriginNamespaceId),
    )).returning({ id: memories.id }),
  );
  return updated.length === 1 && updated[0]?.id === input.memoryId
    ? "adopted"
    : "stale";
}
