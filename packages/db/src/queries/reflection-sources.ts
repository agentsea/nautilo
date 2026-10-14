import { and, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import type { DirectDatabase } from "../config/direct-database";
import { profiles } from "../schema/profiles";
import { actors } from "../schema/trust";
import { users } from "../schema/users";
import { memories } from "../schema/memories";
import { memoryNamespaces } from "../schema/memory-namespaces";
import { rooms } from "../schema/rooms";
import { roomEventRollups, roomEvents } from "../schema/room-journal";
import { sessionMessages, sessions } from "../schema/sessions";

/** Read one exact Room owner while rejecting unexpected duplicate rows. */
export async function findReflectionRoomOwnerIdWith(
  db: DirectDatabase,
  roomId: string,
): Promise<string | null> {
  const rows = await db
    .select({ ownerId: rooms.ownerId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(2);
  return rows.length === 1 ? rows[0]!.ownerId : null;
}

/** Read one exact ordinary Memory only through its canonical Namespace edge. */
export async function findReflectionMemorySourceWith(
  db: DirectDatabase,
  memoryId: string,
  namespaceId: string,
) {
  const rows = await db
    .select({
      id: memories.id,
      type: memories.type,
      content: memories.content,
      tier: memories.tier,
      contentRevision: memories.contentRevision,
      modelExposureDependencies: memories.modelExposureDependencies,
      updatedAt: memories.updatedAt,
      updatedAtCoordinate: sql<string>`to_char(${memories.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(memories)
    .innerJoin(memoryNamespaces, and(
      eq(memoryNamespaces.memoryId, memories.id),
      eq(memoryNamespaces.namespaceId, namespaceId),
    ))
    .where(eq(memories.id, memoryId))
    .limit(2);
  return rows.length === 1 ? rows[0]! : null;
}

/** Maximum current Namespace edges retained as a complete Memory proof. */
export const REFLECTION_MEMORY_NAMESPACE_PROOF_LIMIT = 256;

/**
 * Read every current Namespace edge for an exact Memory. A null result means
 * the current edge set exceeds the bounded proof limit. An empty result means
 * the selected edge is absent (or the Memory has no edges); query failures
 * throw.
 */
export async function findReflectionMemoryNamespaceIdsWith(
  db: DirectDatabase,
  memoryId: string,
  selectedNamespaceId: string,
): Promise<readonly string[] | null> {
  const selectedMemoryNamespaces = alias(
    memoryNamespaces,
    "selected_memory_namespaces",
  );
  const selectedNamespaceEdge = new QueryBuilder()
    .select({ value: selectedMemoryNamespaces.memoryId })
    .from(selectedMemoryNamespaces)
    .where(and(
      eq(selectedMemoryNamespaces.memoryId, memoryNamespaces.memoryId),
      eq(selectedMemoryNamespaces.namespaceId, selectedNamespaceId),
    ));
  const rows = await db
    .select({
      namespaceId: memoryNamespaces.namespaceId,
      selectedNamespacePresent: exists(selectedNamespaceEdge),
    })
    .from(memoryNamespaces)
    .where(eq(memoryNamespaces.memoryId, memoryId))
    .orderBy(memoryNamespaces.namespaceId)
    .limit(REFLECTION_MEMORY_NAMESPACE_PROOF_LIMIT + 1);
  if (rows.some((row) => !row.selectedNamespacePresent)) return [];
  return rows.length > REFLECTION_MEMORY_NAMESPACE_PROOF_LIMIT
    ? null
    : rows.map((row) => row.namespaceId);
}

/** Read one exact ordinary Message through its Room and Namespace anchors. */
export async function findReflectionMessageSourceWith(
  db: DirectDatabase,
  messageId: number,
  roomId: string,
  namespaceId: string,
) {
  const rows = await db
    .select({
      id: sessionMessages.id,
      roomId: sessions.roomId,
      namespaceId: rooms.namespaceId,
      content: sessionMessages.content,
      editRevision: sessionMessages.editRevision,
      role: sessionMessages.role,
      externalAuthorship: sessionMessages.externalAuthorship,
      sourceUserId: sessions.ownerId,
      agentId: sessions.agentId,
      metadata: sessionMessages.metadata,
      sourceUserDisabledAt: users.disabledAt,
    })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
    .innerJoin(rooms, eq(rooms.id, sessions.roomId))
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .where(and(
      eq(sessionMessages.id, messageId),
      eq(sessions.roomId, roomId),
      eq(rooms.namespaceId, namespaceId),
    ))
    .limit(2);
  const row = rows.length === 1 ? rows[0]! : null;
  return row?.roomId ? { ...row, roomId: row.roomId } : null;
}

/** Resolve an exact effective Room audience from actor IDs to enabled Humans. */
export async function findReflectionEnabledHumanOwnersWith(
  db: DirectDatabase,
  actorIds: readonly string[],
): Promise<readonly string[] | null> {
  const exactActorIds = [...new Set(actorIds)].sort();
  if (exactActorIds.length === 0) return [];
  const rows = await db
    .select({ actorId: actors.id, userId: actors.ownerId })
    .from(actors)
    .innerJoin(users, eq(users.id, actors.ownerId))
    .where(and(
      inArray(actors.id, exactActorIds),
      eq(actors.kind, "user"),
      isNull(users.disabledAt),
    ));
  const byActor = new Map(rows.map((row) => [row.actorId, row.userId]));
  if (byActor.size !== exactActorIds.length) return null;
  return [...new Set(exactActorIds.map((actorId) => byActor.get(actorId)!))]
    .sort();
}

/** Read one canonical Profile Soul and its current Agent ownership mirror. */
export async function findReflectionProfileSoulSourceWith(
  db: DirectDatabase,
  agentId: string,
) {
  const rows = await db
    .select({
      profileId: profiles.id,
      userId: profiles.userId,
      agentId: profiles.agentId,
      soulFile: profiles.soulFile,
      soulRevision: profiles.soulRevision,
      ownerActorId: actors.id,
      disabledAt: users.disabledAt,
    })
    .from(profiles)
    .innerJoin(actors, and(
      eq(actors.agentId, profiles.agentId),
      eq(actors.ownerId, profiles.userId),
      eq(actors.kind, "agent"),
    ))
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(eq(profiles.agentId, agentId))
    .limit(2);
  return rows.length === 1 ? rows[0]! : null;
}

/** Read one exact ordinary rollup through its Room and Namespace anchors. */
export async function findReflectionRollupSourceWith(
  db: DirectDatabase,
  rollupId: string,
  roomId: string,
  namespaceId: string,
) {
  const rows = await db
    .select({
      id: roomEventRollups.id,
      roomId: roomEventRollups.roomId,
      namespaceId: rooms.namespaceId,
      throughEventSequence: roomEventRollups.throughEventSequence,
      content: roomEventRollups.content,
      compactorVersion: roomEventRollups.compactorVersion,
      modelExposureDependencies: roomEventRollups.modelExposureDependencies,
    })
    .from(roomEventRollups)
    .innerJoin(rooms, eq(rooms.id, roomEventRollups.roomId))
    .where(and(
      eq(roomEventRollups.id, rollupId),
      eq(roomEventRollups.roomId, roomId),
      eq(rooms.namespaceId, namespaceId),
    ))
    .limit(2);
  return rows.length === 1 ? rows[0]! : null;
}

/** Legacy journal rows have exact coordinates but no retained author proof. */
export async function findReflectionLegacyJournalEventSourceWith(
  db: DirectDatabase,
  eventId: string,
  roomId: string,
  namespaceId: string,
) {
  const rows = await db
    .select({
      id: roomEvents.id,
      roomId: roomEvents.roomId,
      namespaceId: rooms.namespaceId,
      sequence: roomEvents.sequence,
      kind: roomEvents.kind,
      statement: roomEvents.statement,
      status: roomEvents.status,
      projectionKind: roomEvents.projectionKind,
    })
    .from(roomEvents)
    .innerJoin(rooms, eq(rooms.id, roomEvents.roomId))
    .where(and(
      eq(roomEvents.id, eventId),
      eq(roomEvents.roomId, roomId),
      eq(rooms.namespaceId, namespaceId),
      eq(roomEvents.projectionKind, "legacy"),
    ))
    .limit(2);
  return rows.length === 1 ? rows[0]! : null;
}
