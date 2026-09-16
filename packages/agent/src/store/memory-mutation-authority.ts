import {
  acquireRoomWriteLock, actors, agentScopes, and, capabilities,
  createNamespaceBoundaryProjection, eq, groupMembers, groupRoles, groups,
  inArray, namespaceSubsetPredicate, roleCapabilities, roles, roomMembers, rooms,
} from "@nautilo/db";
import { isScopeMemoryEnvelope, type MemoryAccessEnvelope } from "@nautilo/trust";
import type { TrustAgentTx } from "./trust-agent-db";

import { MemoryMutationAuthorityError } from "./memory-mutation-error";
export { MemoryMutationAuthorityError } from "./memory-mutation-error";

/**
 * Shared Memory authority check for foreground and review publication. The
 * caller owns the SERIALIZABLE, authenticated product transaction and acquires
 * its encryption-policy fence before this function takes Room/member locks.
 * No provider or crypto work belongs inside this boundary.
 */
export async function revalidateMemoryMutationAuthority(
  tx: TrustAgentTx,
  input: Readonly<{
    envelope: MemoryAccessEnvelope;
    speakerUserId: string;
    mutation: boolean;
  }>,
): Promise<void> {
  return revalidateCurrentMemoryAuthority(tx, input, "agent");
}

/** The Memory library acts as the Human, even when its envelope carries an
 * Agent as surrounding UI context. It does not borrow that Agent's authority. */
export async function revalidateHumanMemoryMutationAuthority(
  tx: TrustAgentTx,
  input: Readonly<{
    envelope: MemoryAccessEnvelope;
    speakerUserId: string;
    mutation: boolean;
  }>,
): Promise<void> {
  if (isScopeMemoryEnvelope(input.envelope)) {
    throw new MemoryMutationAuthorityError("memory_unavailable");
  }
  return revalidateCurrentMemoryAuthority(tx, input, "human");
}

async function revalidateCurrentMemoryAuthority(
  tx: TrustAgentTx,
  input: Readonly<{
    envelope: MemoryAccessEnvelope;
    speakerUserId: string;
    mutation: boolean;
  }>,
  principal: "agent" | "human",
): Promise<void> {
  const { envelope, speakerUserId } = input;
  if (speakerUserId !== envelope.ownerId || !envelope.roomId) {
    throw new MemoryMutationAuthorityError("memory_unavailable");
  }
  await acquireRoomWriteLock(tx, envelope.roomId);
  const [room] = await tx.select().from(rooms)
    .where(eq(rooms.id, envelope.roomId)).for("update");
  if (!room || room.archivedAt) {
    throw new MemoryMutationAuthorityError("memory_unavailable");
  }
  const members = await tx.select({
    actorId: actors.id, ownerId: actors.ownerId,
    kind: actors.kind, agentId: actors.agentId,
  }).from(roomMembers).innerJoin(actors, eq(roomMembers.actorId, actors.id))
    .where(eq(roomMembers.roomId, envelope.roomId)).orderBy(actors.id)
    .for("share", { of: [actors, roomMembers] });
  if (!members.some((member) => member.actorId === envelope.actorId
      && member.kind === "user" && member.ownerId === speakerUserId)
    || (principal === "agent" && !members.some((member) => member.kind === "agent"
      && member.agentId === envelope.agentId))) {
    throw new MemoryMutationAuthorityError("memory_unavailable");
  }
  const capabilityRows = await tx.select({ slug: capabilities.slug })
    .from(groupMembers).innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
    .innerJoin(roles, eq(roles.id, groupRoles.roleId))
    .innerJoin(roleCapabilities, eq(roleCapabilities.roleId, roles.id))
    .innerJoin(capabilities, eq(capabilities.id, roleCapabilities.capabilityId))
    .where(and(eq(groupMembers.userId, speakerUserId),
      inArray(capabilities.slug, ["read_memories", "manage_memories"])))
    .orderBy(groupMembers.groupId, groupRoles.roleId, roleCapabilities.capabilityId)
    .for("share", { of: [groupMembers, groups, groupRoles, roles, roleCapabilities, capabilities] });
  if (!capabilityRows.some((row) => row.slug === "read_memories")
    || (input.mutation && !capabilityRows.some((row) => row.slug === "manage_memories"))) {
    throw new MemoryMutationAuthorityError("memory_unavailable");
  }
  if (isScopeMemoryEnvelope(envelope)) {
    const [scope] = await tx.select().from(agentScopes)
      .where(eq(agentScopes.id, envelope.scopeId)).for("update");
    if (!scope || scope.parentAgentId !== envelope.agentId
      || scope.speakerUserId !== speakerUserId || scope.lifecycleState !== "open") {
      throw new MemoryMutationAuthorityError("memory_unavailable");
    }
    return;
  }
  const boundary = createNamespaceBoundaryProjection();
  const [source] = await tx.select({ publicRoomId: boundary.publicBoundaryRoomId })
    .from(boundary.sourceRoom)
    .leftJoin(boundary.publicBoundaryRoom, boundary.publicBoundaryJoin)
    .where(eq(boundary.sourceRoom.id, envelope.roomId));
  const candidates = room.humanActorIds?.length
    ? await tx.select({ namespaceId: rooms.namespaceId }).from(rooms)
      .where(namespaceSubsetPredicate(room.humanActorIds, source?.publicRoomId != null))
    : [];
  const readable = [...new Set([room.namespaceId, ...candidates.map((candidate) => candidate.namespaceId)])].sort();
  const same = (left: readonly string[], right: readonly string[]) =>
    JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
  if (!same(envelope.readableNamespaces, readable)
    || !same(envelope.mutableNamespaces, readable)
    || !same(envelope.writableNamespaces, [room.namespaceId])) {
    throw new MemoryMutationAuthorityError("source_changed");
  }
}
