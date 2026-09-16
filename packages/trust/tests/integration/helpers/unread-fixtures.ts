/**
 * M122 — shared fixtures for the room-unread integration tests. Inserts rows
 * directly via `createDirectDb` (no `ensureDatabase()` — the target instance is
 * already migrated + running; we never apply migrations from tests). Every
 * inserted id is tracked so `cleanupAll` can tear the graph down in FK order.
 */
import { randomUUID } from "node:crypto";
import {
  createDirectDb,
  and,
  eq,
  inArray,
  users,
  actors,
  agents,
  namespaces,
  rooms,
  roomMembers,
  sessions,
  sessionMessages,
  sessionMessageRecipientState,
} from "@nautilo/db";

export type Db = ReturnType<typeof createDirectDb>;

export class Tracker {
  userIds: string[] = [];
  actorIds: string[] = [];
  agentIds: string[] = [];
  namespaceIds: string[] = [];
  roomIds: string[] = [];
  sessionIds: string[] = [];
  messageIds: number[] = [];
}

const tag = () => randomUUID().slice(0, 8);

export async function mkUser(db: Db, t: Tracker, name: string): Promise<string> {
  const s = tag();
  const [u] = await db
    .insert(users)
    .values({ name: `${name}-${s}`, email: `${name}-${s}@m122.test`, handle: `${name}${s}` })
    .returning({ id: users.id });
  if (!u) throw new Error("user insert failed");
  t.userIds.push(u.id);
  return u.id;
}

export async function mkActor(
  db: Db,
  t: Tracker,
  ownerId: string,
  label: string,
  opts?: { kind?: "user" | "agent"; agentId?: string },
): Promise<string> {
  const [a] = await db
    .insert(actors)
    .values({
      ownerId,
      displayName: label,
      kind: opts?.kind ?? "user",
      agentId: opts?.agentId ?? null,
    })
    .returning({ id: actors.id });
  if (!a) throw new Error("actor insert failed");
  t.actorIds.push(a.id);
  return a.id;
}

export async function mkAgent(db: Db, t: Tracker): Promise<string> {
  const [ag] = await db
    .insert(agents)
    .values({ handle: `ag-${tag()}` })
    .returning({ id: agents.id });
  if (!ag) throw new Error("agent insert failed");
  t.agentIds.push(ag.id);
  return ag.id;
}

export async function mkNamespace(db: Db, t: Tracker): Promise<string> {
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `ns-${tag()}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("namespace insert failed");
  t.namespaceIds.push(ns.id);
  return ns.id;
}

/** Create a room + add every actorId in `memberActorIds` as a member. */
export async function mkRoom(
  db: Db,
  t: Tracker,
  args: {
    ownerId: string;
    namespaceId: string;
    humanActorIds: string[];
    memberActorIds: string[];
    kind?: "private" | "group" | "multi_agent" | "subthread" | "open" | "task" | "access";
    type?: string;
    parentRoomId?: string | null;
    threadRootMessageId?: number | null;
  },
): Promise<string> {
  const id = randomUUID();
  await db.insert(rooms).values({
    id,
    ownerId: args.ownerId,
    type: args.type ?? "private",
    kind: args.kind ?? "private",
    label: `room-${tag()}`,
    graphThreadId: `room:${id}`,
    namespaceId: args.namespaceId,
    humanActorIds: args.humanActorIds,
    parentRoomId: args.parentRoomId ?? null,
    threadRootMessageId: args.threadRootMessageId ?? null,
  });
  t.roomIds.push(id);
  for (const actorId of args.memberActorIds) {
    await db.insert(roomMembers).values({ roomId: id, actorId, roomRole: "member" });
  }
  return id;
}

/** A session is per (owner, room) — mirrors uq_sessions_owner_thread. */
export async function mkSession(
  db: Db,
  t: Tracker,
  args: { roomId: string; ownerId: string; agentId: string },
): Promise<string> {
  const [s] = await db
    .insert(sessions)
    .values({
      threadId: `room:${args.roomId}:${args.ownerId.slice(0, 8)}`,
      ownerId: args.ownerId,
      personaId: "owner",
      agentId: args.agentId,
      roomId: args.roomId,
      channel: "tui",
    })
    .returning({ id: sessions.id });
  if (!s) throw new Error("session insert failed");
  t.sessionIds.push(s.id);
  return s.id;
}

export async function mkMessage(
  db: Db,
  t: Tracker,
  args: {
    sessionId: string;
    role: "user" | "assistant" | "system" | "tool";
    content?: string;
    readAt?: Date | null;
    transcriptOrigin?: string;
  },
): Promise<number> {
  const [m] = await db
    .insert(sessionMessages)
    .values({
      sessionId: args.sessionId,
      role: args.role,
      content: args.content ?? "msg",
      readAt: args.readAt ?? null,
      transcriptOrigin: args.transcriptOrigin ?? "main",
    })
    .returning({ id: sessionMessages.id });
  if (!m) throw new Error("message insert failed");
  t.messageIds.push(m.id);
  return m.id;
}

/** Junction-substrate read stamp for a single (message, recipient). */
export async function markRecipRead(
  db: Db,
  messageId: number,
  recipientId: string,
  readAt: Date = new Date(),
): Promise<void> {
  await db
    .insert(sessionMessageRecipientState)
    .values({ messageId, recipientId, deliveredAt: readAt, readAt })
    .onConflictDoNothing();
}

export async function cleanupAll(db: Db, t: Tracker): Promise<void> {
  if (t.messageIds.length > 0) {
    await db
      .delete(sessionMessageRecipientState)
      .where(inArray(sessionMessageRecipientState.messageId, t.messageIds));
  }
  // Subthread rooms carry a `thread_root_message_id` FK with ON DELETE SET NULL.
  // Deleting the (parent) root message would null that column and trip the
  // `rooms_subthread_invariant` check. So tear subthread rooms (+ their own
  // sessions/messages) down FIRST, before any message delete removes a root.
  if (t.roomIds.length > 0) {
    const subRooms = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(inArray(rooms.id, t.roomIds), eq(rooms.kind, "subthread")));
    const subRoomIds = subRooms.map((r) => r.id);
    if (subRoomIds.length > 0) {
      const subSess = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(inArray(sessions.roomId, subRoomIds));
      const subSessIds = subSess.map((s) => s.id);
      if (subSessIds.length > 0) {
        await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, subSessIds));
        await db.delete(sessions).where(inArray(sessions.id, subSessIds));
      }
      await db.delete(rooms).where(inArray(rooms.id, subRoomIds));
    }
  }
  if (t.sessionIds.length > 0) {
    await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, t.sessionIds));
    await db.delete(sessions).where(inArray(sessions.id, t.sessionIds));
  }
  if (t.roomIds.length > 0) {
    await db.delete(roomMembers).where(inArray(roomMembers.roomId, t.roomIds));
    await db.delete(rooms).where(inArray(rooms.id, t.roomIds));
  }
  if (t.namespaceIds.length > 0) {
    await db.delete(namespaces).where(inArray(namespaces.id, t.namespaceIds));
  }
  if (t.actorIds.length > 0) {
    await db.delete(actors).where(inArray(actors.id, t.actorIds));
  }
  if (t.agentIds.length > 0) {
    await db.delete(agents).where(inArray(agents.id, t.agentIds));
  }
  if (t.userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, t.userIds));
  }
}
