import {
  actors,
  and,
  asc,
  eq,
  privateNamespaceBoundarySql,
  roomMembers,
  rooms,
  sql,
  type DirectDatabase,
} from "@nautilo/db";

export type ProtectedTaskRequesterPrivateRoom = Readonly<{
  roomId: string;
  namespaceId: string;
}>;

export type ProtectedTaskRequesterPrivateRoomResolver = (
  userId: string,
  agentId: string,
  expectedNamespaceId?: string,
) => Promise<ProtectedTaskRequesterPrivateRoom | null>;

type Candidate = Readonly<{
  roomId: string;
  namespaceId: string;
  type: string;
  kind: string;
  graphThreadId: string;
  createdAt: Date;
  humanActorIds: readonly string[];
  memberCount: number;
  humanCount: number;
  agentCount: number;
}>;

function exactCandidate(
  candidate: Candidate,
  humanActorId: string,
  expectedNamespaceId: string | undefined,
): boolean {
  return candidate.type === "private"
    && candidate.kind === "private"
    && candidate.memberCount === 2
    && candidate.humanCount === 1
    && candidate.agentCount === 1
    && candidate.humanActorIds.length === 1
    && candidate.humanActorIds[0] === humanActorId
    && (expectedNamespaceId === undefined
      || candidate.namespaceId === expectedNamespaceId);
}

/**
 * Resolve only the canonical requester+Agent private Room used by protected
 * Task content. Existing Tasks pin their durable Namespace; creation chooses
 * the legacy private Room first, then the oldest stable private candidate.
 */
export function createProtectedTaskRequesterPrivateRoomResolver(
  db: DirectDatabase,
): ProtectedTaskRequesterPrivateRoomResolver {
  return async (userId, agentId, expectedNamespaceId) => {
    const humans = await db.select({ id: actors.id }).from(actors).where(and(
      eq(actors.ownerId, userId),
      eq(actors.kind, "user"),
    )).limit(2);
    const human = humans[0];
    if (humans.length !== 1 || human === undefined) return null;

    const candidates = await db.select({
      roomId: rooms.id,
      namespaceId: rooms.namespaceId,
      type: rooms.type,
      kind: rooms.kind,
      graphThreadId: rooms.graphThreadId,
      createdAt: rooms.createdAt,
      humanActorIds: rooms.humanActorIds,
      memberCount: sql<number>`count(*)::int`,
      humanCount: sql<number>`count(*) filter (
        where ${actors.kind} = 'user' and ${actors.id} = ${human.id}
      )::int`,
      agentCount: sql<number>`count(*) filter (
        where ${actors.kind} = 'agent' and ${actors.agentId} = ${agentId}
      )::int`,
    }).from(rooms)
      .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
      .innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(and(
        eq(rooms.type, "private"),
        eq(rooms.kind, "private"),
        privateNamespaceBoundarySql(rooms.namespaceId),
        ...(expectedNamespaceId === undefined
          ? []
          : [eq(rooms.namespaceId, expectedNamespaceId)]),
      ))
      .groupBy(
        rooms.id,
        rooms.namespaceId,
        rooms.type,
        rooms.kind,
        rooms.graphThreadId,
        rooms.createdAt,
        rooms.humanActorIds,
      )
      .having(sql`
        count(*) = 2
        and count(*) filter (
          where ${actors.kind} = 'agent' and ${actors.agentId} = ${agentId}
        ) = 1
        and count(*) filter (
          where ${actors.kind} = 'user' and ${actors.id} = ${human.id}
        ) = 1
        and cardinality(${rooms.humanActorIds}) = 1
        and ${rooms.humanActorIds}[1] = ${human.id}
      `)
      .orderBy(
        asc(sql`case when ${rooms.graphThreadId} = 'app:default' then 0 else 1 end`),
        asc(rooms.createdAt),
        asc(rooms.id),
      )
      .limit(2);
    const exact = candidates.filter((candidate) =>
      exactCandidate(candidate, human.id, expectedNamespaceId)
    );
    if (expectedNamespaceId !== undefined && exact.length !== 1) return null;
    const selected = exact[0];
    return selected === undefined
      ? null
      : Object.freeze({
          roomId: selected.roomId,
          namespaceId: selected.namespaceId,
        });
  };
}
