/**
 * D124 — migration 0047 read-state columns (live Postgres).
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createDirectDb,
  ensureDatabase,
  users,
  actors,
  agents,
  namespaces,
  rooms,
  roomMembers,
  sessions,
  sessionMessages,
  sessionMessageRecipientState,
  eq,
  sql,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let db: ReturnType<typeof createDirectDb>;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(3);
});

afterAll(async () => {
  await db.end();
});

describe("migration 0047 — D124 read-state", () => {
  test("session_messages exposes D124 columns (select round-trip)", async () => {
    const rows = await db
      .select({
        deliveredAt: sessionMessages.deliveredAt,
        readAt: sessionMessages.readAt,
        replyToMessageId: sessionMessages.replyToMessageId,
      })
      .from(sessionMessages)
      .limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });

  test("users exposes last_seen_at", async () => {
    const rows = await db.select({ lastSeenAt: users.lastSeenAt }).from(users).limit(1);
    expect(rows.length).toBeGreaterThanOrEqual(0);
  });

  test("session_message_recipient_state exists with PK and FK cascade on message delete", async () => {
    const u = await db
      .insert(users)
      .values({
        name: "m047-u",
        email: `m047-${Date.now()}@t.local`,
        handle: `m047${Date.now()}`,
      })
      .returning({ id: users.id });
    const uid = u[0]?.id;
    if (!uid) throw new Error("u");
    const [actor] = await db
      .insert(actors)
      .values({ ownerId: uid, displayName: "A", kind: "user" })
      .returning({ id: actors.id });
    if (!actor) throw new Error("actor");
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: "ns-m047" })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("ns");
    const [room] = await db
      .insert(rooms)
      .values({
        ownerId: uid,
        type: "private",
        label: "r",
        graphThreadId: `gt-m047-${Date.now()}`,
        namespaceId: ns.id,
        humanActorIds: [actor.id],
      })
      .returning({ id: rooms.id });
    if (!room) throw new Error("room");
    await db.insert(roomMembers).values({ roomId: room.id, actorId: actor.id, roomRole: "admin" });
    const [agent] = await db
      .insert(agents)
      .values({ handle: `m047-ag-${Date.now()}` })
      .returning({ id: agents.id });
    if (!agent) throw new Error("agent");
    const [sess] = await db
      .insert(sessions)
      .values({
        threadId: `room:${room.id}`,
        ownerId: uid,
        personaId: "owner",
        agentId: agent.id,
        roomId: room.id,
        channel: "tui",
      })
      .returning({ id: sessions.id });
    if (!sess) throw new Error("sess");
    const [msg] = await db
      .insert(sessionMessages)
      .values({ sessionId: sess.id, role: "user", content: "x" })
      .returning({ id: sessionMessages.id });
    if (!msg) throw new Error("msg");
    await db.insert(sessionMessageRecipientState).values({
      messageId: msg.id,
      recipientId: uid,
      deliveredAt: new Date(),
    });
    await db.delete(sessionMessages).where(eq(sessionMessages.id, msg.id));
    const [gone] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(sessionMessageRecipientState)
      .where(eq(sessionMessageRecipientState.messageId, msg.id));
    expect(gone?.c).toBe(0);

    await db.delete(sessions).where(eq(sessions.id, sess.id));
    await db.delete(agents).where(eq(agents.id, agent.id));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, room.id));
    await db.delete(rooms).where(eq(rooms.id, room.id));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
    await db.delete(actors).where(eq(actors.id, actor.id));
    await db.delete(users).where(eq(users.id, uid));
  });
});
