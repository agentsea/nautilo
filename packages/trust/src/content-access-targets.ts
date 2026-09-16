import {
  and, asc, eq, inArray, isNull, ne,
  actors, users, rooms, roomMembers, privateNamespaceBoundarySql,
  type InviteSeedTx, type RoomAuthoritySnapshot,
} from "@nautilo/db";
import { ContentAccessAuthorityError, type ContentAccessPrincipal } from "./content-access-authority";
import type { AuthorizedRoomDestinationSnapshot } from "./content-access-plan";
import { pickDefaultRoomFromPrivateMemberCandidates } from "./queries";

/** Current local identities; this reads and locks but never creates a target. */
export async function lockContentAccessHumansInTx(tx: InviteSeedTx, actorIds: readonly string[]) {
  const ids = [...new Set(actorIds)].sort();
  if (!ids.length) throw new ContentAccessAuthorityError("denied");
  const humans = await tx.select({ actorId: actors.id, userId: users.id })
    .from(actors).innerJoin(users, eq(users.id, actors.ownerId))
    .where(and(inArray(actors.id, ids), eq(actors.kind, "user"),
      isNull(users.disabledAt), isNull(users.server)))
    .orderBy(asc(actors.id)).for("share");
  if (humans.length !== ids.length) throw new ContentAccessAuthorityError("denied");
  return humans;
}

export type ContentAccessRoomTarget = Readonly<{
  destination: AuthorizedRoomDestinationSnapshot;
  /** Internal semantic authority, hashed before any public projection. */
  authority: Readonly<{
    requestedRoomId: string;
    requestedKind: string;
    requestedRevision: number;
    ownerKind: string;
    ownerRevision: number;
  }>;
}>;

/** Child entry membership is distinct from the inherited Namespace audience. */
export async function lockContentAccessRoomTargetInTx(
  tx: InviteSeedTx, principal: ContentAccessPrincipal, roomId: string,
  lockedRooms: readonly RoomAuthoritySnapshot[],
  boundAgentActorId?: string,
): Promise<ContentAccessRoomTarget> {
  const requested = lockedRooms.find((room) => room.id === roomId);
  if (!requested || requested.kind === "access") throw new ContentAccessAuthorityError("denied");
  const [membership] = await tx.select({ actorId: roomMembers.actorId }).from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, principal.actorId)))
    .for("share");
  if (!membership) throw new ContentAccessAuthorityError("denied");
  const owners = lockedRooms.filter((room) => room.namespaceId === requested.namespaceId && room.kind !== "subthread");
  const owner = owners[0];
  if (owners.length !== 1 || !owner || owner.kind === "access"
    || !owner.humanActorIds.includes(principal.actorId)) {
    throw new ContentAccessAuthorityError("denied");
  }
  const humans = await tx.select({ actorId: actors.id }).from(roomMembers)
    .innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(and(eq(roomMembers.roomId, owner.id), eq(actors.kind, "user")))
    .orderBy(asc(actors.id)).for("share");
  const audience = [...new Set(owner.humanActorIds)].sort();
  if (humans.length !== audience.length || humans.some((human, index) => human.actorId !== audience[index])) {
    throw new ContentAccessAuthorityError("unavailable");
  }
  if (boundAgentActorId) {
    const [agentMembership] = await tx.select({ actorId: actors.id }).from(roomMembers)
      .innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(and(eq(roomMembers.roomId, owner.id), eq(actors.id, boundAgentActorId),
        eq(actors.kind, "agent"), eq(actors.agentId, principal.agentId!))).for("share");
    if (!agentMembership) throw new ContentAccessAuthorityError("unavailable");
  }
  return Object.freeze({
    destination: Object.freeze({
      roomId: owner.id, namespaceId: owner.namespaceId,
      humanActorIds: Object.freeze(audience),
    }),
    authority: Object.freeze({
      requestedRoomId: requested.id, requestedKind: requested.kind,
      requestedRevision: requested.namespaceAccessRevision,
      ownerKind: owner.kind, ownerRevision: owner.namespaceAccessRevision,
    }),
  });
}

/** Reuse an existing canonical personal Room; never guess an Agent or mint. */
export async function discoverContentAccessPrivateTargetInTx(
  tx: InviteSeedTx, principal: ContentAccessPrincipal,
): Promise<Readonly<{ roomId: string; boundAgentActorId?: string }>> {
  const [source] = await tx.select().from(rooms).where(eq(rooms.id, principal.sourceRoomId));
  if (!source) throw new ContentAccessAuthorityError("unavailable");
  const owners = await tx.select().from(rooms).where(and(eq(rooms.namespaceId, source.namespaceId),
    ne(rooms.kind, "subthread")));
  const owner = owners[0];
  if (owners.length !== 1 || !owner) throw new ContentAccessAuthorityError("unavailable");
  if (owner.kind === "private" && owner.humanActorIds.length === 1
    && owner.humanActorIds[0] === principal.actorId) return { roomId: owner.id };
  if (!principal.agentId) throw new ContentAccessAuthorityError("unavailable");
  const [agent] = await tx.select({ actorId: actors.id }).from(actors)
    .where(and(eq(actors.kind, "agent"), eq(actors.agentId, principal.agentId)));
  if (!agent) throw new ContentAccessAuthorityError("unavailable");
  const agentRooms = tx.select({ roomId: roomMembers.roomId }).from(roomMembers)
    .where(eq(roomMembers.actorId, agent.actorId));
  const candidates = await tx.select({
    id: rooms.id, type: rooms.type, graphThreadId: rooms.graphThreadId,
    createdAt: rooms.createdAt, humanActorIds: rooms.humanActorIds,
  }).from(rooms).innerJoin(roomMembers, and(eq(roomMembers.roomId, rooms.id),
    eq(roomMembers.actorId, principal.actorId)))
    .where(and(eq(rooms.kind, "private"), eq(rooms.type, "private"),
      inArray(rooms.id, agentRooms), privateNamespaceBoundarySql(rooms.namespaceId)))
    .orderBy(asc(rooms.id));
  const selected = pickDefaultRoomFromPrivateMemberCandidates(candidates.filter((room) =>
    room.humanActorIds.length === 1 && room.humanActorIds[0] === principal.actorId));
  if (!selected) throw new ContentAccessAuthorityError("unavailable");
  return { roomId: selected.id, boundAgentActorId: agent.actorId };
}
