import type { DirectDatabase } from "@nautilo/db";
import {
  copyTaskScopeMemoryBinding,
  discoverTaskScopeMemoryNamespaceInventory,
  type TaskScopeMemoryBinding,
} from "@nautilo/lattice-bridge/server";
import type {
  ProtectedTaskOccurrence,
  ProtectedTaskPredispatchPlan,
} from "@nautilo/runtime";
import {
  findActorByOwnerId,
  findAgentOwnerPrivateRoom,
} from "@nautilo/trust";

import { getServerDirectDb } from "../lib/server-direct-db";
import { createHumanProductTransactionContext } from
  "./human-message-product-store";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type ProductContext = Awaited<ReturnType<
  typeof createHumanProductTransactionContext
>>;

export type ProtectedTaskScopeMemoryInventoryResolverInput = Readonly<{
  occurrence: ProtectedTaskOccurrence;
  predispatch: ProtectedTaskPredispatchPlan;
}>;

export type ProtectedTaskScopeMemoryInventoryResolverDependencies = Readonly<{
  db: DirectDatabase;
  resolveRequesterHuman(userId: string): Promise<Readonly<{
    id: string;
  }> | null>;
  resolveRequesterPrivateRoom(
    userId: string,
    agentId: string,
  ): Promise<Readonly<{
    roomId: string;
    namespaceId: string;
  }> | null>;
  createProductContext(
    userId: string,
    database: DirectDatabase,
  ): Promise<ProductContext>;
  discoverInventory: typeof discoverTaskScopeMemoryNamespaceInventory;
}>;

type PinnedScopeCoordinates = Readonly<{
  taskId: string;
  taskRunId: string;
  requesterUserId: string;
  agentId: string;
  contentNamespaceId: string;
  scopeId: string;
  memoryRoomId: string;
  originWritableNamespaceId: string;
  requesterActorId: string;
}>;

function pinScopeCoordinates(
  input: ProtectedTaskScopeMemoryInventoryResolverInput,
): PinnedScopeCoordinates {
  const { occurrence, predispatch } = input;
  const envelope = predispatch.memory.envelope;
  const originWritableNamespaceId = "originWritableNamespaceId" in envelope
    ? envelope.originWritableNamespaceId
    : null;
  if (envelope.memoryMode !== "scope"
    || predispatch.memory.mode !== "scope"
    || predispatch.memory.authorityStatus !== "exact"
    || predispatch.memory.provenance !== "scope_existing"
    || typeof originWritableNamespaceId !== "string"
    || predispatch.occurrence.task.id !== occurrence.task.id
    || predispatch.occurrence.task.requestorId !== occurrence.task.requestorId
    || predispatch.occurrence.task.agentId !== occurrence.task.agentId
    || predispatch.occurrence.task.contentNamespaceId
      !== occurrence.task.contentNamespaceId
    || predispatch.occurrence.run.id !== occurrence.run.id
    || predispatch.occurrence.run.taskId !== occurrence.run.taskId
    || envelope.ownerId !== occurrence.task.requestorId
    || envelope.agentId !== occurrence.task.agentId
    || ![
      occurrence.task.id,
      occurrence.run.id,
      occurrence.task.requestorId,
      occurrence.task.agentId,
      occurrence.task.contentNamespaceId,
      envelope.scopeId,
      envelope.roomId,
      originWritableNamespaceId,
      envelope.actorId,
    ].every(value => UUID.test(value))) {
    throw new TypeError("Protected Task Scope Memory coordinates are invalid");
  }
  return Object.freeze({
    taskId: occurrence.task.id,
    taskRunId: occurrence.run.id,
    requesterUserId: occurrence.task.requestorId,
    agentId: occurrence.task.agentId,
    contentNamespaceId: occurrence.task.contentNamespaceId,
    scopeId: envelope.scopeId,
    memoryRoomId: envelope.roomId,
    originWritableNamespaceId,
    requesterActorId: envelope.actorId,
  });
}

function scopeCoordinatesRemainExact(
  input: ProtectedTaskScopeMemoryInventoryResolverInput,
  expected: PinnedScopeCoordinates,
): boolean {
  try {
    const current = pinScopeCoordinates(input);
    return Object.entries(expected).every(
      ([key, value]) => current[key as keyof PinnedScopeCoordinates] === value,
    );
  } catch {
    return false;
  }
}

/**
 * Discover the fixed Namespace set for one existing Task Scope. This detached
 * product-role read grants no authority; the initial authority owner must lock
 * and reprove the same binding before issuing the Runtime grant.
 */
export function createProtectedTaskScopeMemoryInventoryResolver(
  overrides: Partial<ProtectedTaskScopeMemoryInventoryResolverDependencies>
    = {},
): (
  input: ProtectedTaskScopeMemoryInventoryResolverInput,
) => Promise<TaskScopeMemoryBinding> {
  const db = overrides.db ?? getServerDirectDb();
  const resolveRequesterHuman = overrides.resolveRequesterHuman
    ?? findActorByOwnerId;
  const resolveRequesterPrivateRoom = overrides.resolveRequesterPrivateRoom
    ?? findAgentOwnerPrivateRoom;
  const createProductContext = overrides.createProductContext
    ?? createHumanProductTransactionContext;
  const discoverInventory = overrides.discoverInventory
    ?? discoverTaskScopeMemoryNamespaceInventory;

  return async input => {
    const pinned = pinScopeCoordinates(input);
    const [requesterHuman, sourceRoom] = await Promise.all([
      resolveRequesterHuman(pinned.requesterUserId),
      resolveRequesterPrivateRoom(pinned.requesterUserId, pinned.agentId),
    ]);
    if (requesterHuman === null
      || requesterHuman.id !== pinned.requesterActorId
      || sourceRoom === null
      || sourceRoom.namespaceId !== pinned.contentNamespaceId
      || !scopeCoordinatesRemainExact(input, pinned)) {
      throw new TypeError(
        "Protected Task Scope Memory source authority is unavailable",
      );
    }

    const product = await createProductContext(pinned.requesterUserId, db);
    const inventory = await product.canonicalRunner.transaction(
      (_transaction, executor) => discoverInventory({
        transaction: executor,
        coordinates: Object.freeze({
          taskId: pinned.taskId,
          requesterUserId: pinned.requesterUserId,
          agentId: pinned.agentId,
          scopeId: pinned.scopeId,
          memoryRoomId: pinned.memoryRoomId,
          originWritableNamespaceId: pinned.originWritableNamespaceId,
        }),
        sourceRoomId: sourceRoom.roomId,
        requesterHumanId: requesterHuman.id,
      }),
      { isolationLevel: "serializable" },
    );
    if (inventory === null
      || inventory.scopeId !== pinned.scopeId
      || inventory.originWritableNamespaceId
        !== pinned.originWritableNamespaceId
      || !scopeCoordinatesRemainExact(input, pinned)) {
      throw new TypeError("Protected Task Scope Memory inventory changed");
    }
    return copyTaskScopeMemoryBinding({
      scopeId: pinned.scopeId,
      memoryRoomId: pinned.memoryRoomId,
      originWritableNamespaceId: pinned.originWritableNamespaceId,
      readableNamespaceIds: inventory.readableNamespaceIds,
    });
  };
}
