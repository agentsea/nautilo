import { and, eq, sql } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import { memories } from "../schema/memories";
import { memoryNamespaces } from "../schema/memory-namespaces";
import { rooms } from "../schema/rooms";
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
    })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
    .innerJoin(rooms, eq(rooms.id, sessions.roomId))
    .where(and(
      eq(sessionMessages.id, messageId),
      eq(sessions.roomId, roomId),
      eq(rooms.namespaceId, namespaceId),
    ))
    .limit(2);
  const row = rows.length === 1 ? rows[0]! : null;
  return row?.roomId ? { ...row, roomId: row.roomId } : null;
}
