/**
 * D124 — `getRoomMessagesAcrossMemberSessions` fans in transcript rows from
 * every human member session in a room (and still hides subagent threads).
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import {
  createDirectDb,
  ensureDatabase,
  users,
  actors,
  agents,
  sessions,
  sessionMessages,
  namespaces,
  rooms,
  roomMembers,
  eq,
  inArray,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { ensureSession, getRoomMessagesAcrossMemberSessions } from "../../src/store/session-store";


let db: ReturnType<typeof createDirectDb>;
let ownerA: string;
let ownerB: string;
let roomId: string;
const ts = Date.now().toString(36);

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);

  const [ua] = await db
    .insert(users)
    .values({
      name: `d124-a-${ts}`,
      email: `d124a-${ts}@test.local`,
      handle: `d124a${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  const [ub] = await db
    .insert(users)
    .values({
      name: `d124-b-${ts}`,
      email: `d124b-${ts}@test.local`,
      handle: `d124b${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!ua || !ub) throw new Error("users");
  ownerA = ua.id;
  ownerB = ub.id;

  const [aa] = await db
    .insert(actors)
    .values({ ownerId: ownerA, displayName: "A", kind: "user" })
    .returning({ id: actors.id });
  const [ab] = await db
    .insert(actors)
    .values({ ownerId: ownerB, displayName: "B", kind: "user" })
    .returning({ id: actors.id });
  if (!aa || !ab) throw new Error("actors");

  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `d124-ns-${ts}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("namespace");

  roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    ownerId: ownerA,
    type: "private",
    label: "d124 cross-session",
    graphThreadId: `room:${roomId}`,
    namespaceId: ns.id,
    humanActorIds: [aa.id, ab.id],
  });
  await db.insert(roomMembers).values({ roomId, actorId: aa.id, roomRole: "admin" });
  await db.insert(roomMembers).values({ roomId, actorId: ab.id, roomRole: "member" });
});

async function deleteSessionsInRoom(): Promise<void> {
  const sessRows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.roomId, roomId));
  const ids = sessRows.map((s) => s.id);
  if (ids.length > 0) {
    await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ids));
    await db.delete(sessions).where(inArray(sessions.id, ids));
  }
}

afterEach(async () => {
  await deleteSessionsInRoom();
});

afterAll(async () => {
  if (!db) return;
  try {
    await deleteSessionsInRoom();
    const roomRow = await db
      .select({ namespaceId: rooms.namespaceId })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    const nsId = roomRow[0]?.namespaceId;
    await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
    await db.delete(rooms).where(eq(rooms.id, roomId));
    if (nsId) {
      await db.delete(namespaces).where(eq(namespaces.id, nsId));
    }
    await db.delete(actors).where(eq(actors.ownerId, ownerA));
    await db.delete(actors).where(eq(actors.ownerId, ownerB));
    await db.delete(users).where(eq(users.id, ownerA));
    await db.delete(users).where(eq(users.id, ownerB));
  } finally {
    await db.end();
  }
});

describe("getRoomMessagesAcrossMemberSessions (D124)", () => {
  test("returns user messages from both human owners with sourceUserId", async () => {
    const threadA = `room-d124-a-${ts}`;
    const threadB = `room-d124-b-${ts}`;
    const sidA = await ensureSession({
      threadId: threadA,
      ownerId: ownerA,
      personaId: "owner",
      roomId,
    });
    const sidB = await ensureSession({
      threadId: threadB,
      ownerId: ownerB,
      personaId: "owner",
      roomId,
    });

    const t0 = new Date("2024-06-01T10:00:00.000Z");
    const t1 = new Date("2024-06-01T10:01:00.000Z");
    const t2 = new Date("2024-06-01T10:02:00.000Z");

    const [m0] = await db
      .insert(sessionMessages)
      .values({ sessionId: sidA, role: "user", content: "from A", createdAt: t0 })
      .returning({ id: sessionMessages.id });
    const [m1] = await db
      .insert(sessionMessages)
      .values({ sessionId: sidB, role: "user", content: "from B", createdAt: t1 })
      .returning({ id: sessionMessages.id });
    if (!m0 || !m1) throw new Error("msgs");

    const page = await getRoomMessagesAcrossMemberSessions({
      ownerId: ownerA,
      roomId,
      beforeCreatedAt: t2,
      beforeId: 9_999_999,
      limit: 20,
    });

    const byContent = Object.fromEntries(page.messages.map((m) => {
      if (m.content === null) throw new Error("Expected ordinary test message");
      return [m.content, m] as const;
    }));
    expect(byContent["from A"]?.sourceUserId).toBe(ownerA);
    expect(byContent["from B"]?.sourceUserId).toBe(ownerB);
  });

  test("omits rows from subagent sessions in the same room", async () => {
    const mainThread = `room-d124-main-${ts}`;
    const subThread = `subagent:${mainThread}:x`;
    const sidMain = await ensureSession({
      threadId: mainThread,
      ownerId: ownerA,
      personaId: "owner",
      roomId,
    });
    const sidSub = await ensureSession({
      threadId: subThread,
      ownerId: ownerA,
      personaId: "owner",
      roomId,
    });

    const t0 = new Date("2024-07-01T08:00:00.000Z");
    const t1 = new Date("2024-07-01T08:01:00.000Z");
    const t2 = new Date("2024-07-01T08:02:00.000Z");

    await db
      .insert(sessionMessages)
      .values({ sessionId: sidMain, role: "user", content: "visible", createdAt: t0 });
    await db
      .insert(sessionMessages)
      .values({ sessionId: sidSub, role: "user", content: "SUB HIDDEN", createdAt: t1 });

    const page = await getRoomMessagesAcrossMemberSessions({
      ownerId: ownerA,
      roomId,
      beforeCreatedAt: t2,
      beforeId: 9_999_999,
      limit: 20,
    });

    const texts = page.messages.map((m) => m.content);
    expect(texts).toContain("visible");
    expect(texts).not.toContain("SUB HIDDEN");
  });

  test("omits known react tool rows but retains legacy NULL tool names", async () => {
    const sessionId = await ensureSession({
      threadId: `room-d430-react-${ts}`,
      ownerId: ownerA,
      personaId: "owner",
      roomId,
    });
    const before = new Date("2025-03-01T12:00:00.000Z");
    await db.insert(sessionMessages).values([
      { sessionId, role: "tool", content: "known react", toolName: "react", createdAt: before },
      { sessionId, role: "tool", content: "legacy unknown", toolName: null, createdAt: new Date("2025-03-01T12:01:00.000Z") },
    ]);

    const page = await getRoomMessagesAcrossMemberSessions({
      ownerId: ownerA,
      roomId,
      beforeCreatedAt: new Date("2025-03-01T12:02:00.000Z"),
      beforeId: 9_999_999,
      limit: 20,
    });
    expect(page.messages.map((message) => message.content)).not.toContain("known react");
    expect(page.messages.map((message) => message.content)).toContain("legacy unknown");
  });

  test("dedupes fanned-out system audit rows across human member sessions", async () => {
    const sidA = await ensureSession({
      threadId: `room-d124-system-a-${ts}`,
      ownerId: ownerA,
      personaId: "owner",
      roomId,
    });
    const sidB = await ensureSession({
      threadId: `room-d124-system-b-${ts}`,
      ownerId: ownerB,
      personaId: "owner",
      roomId,
    });

    const t0 = new Date("2024-08-01T10:00:00.000Z");
    const t1 = new Date("2024-08-01T10:05:00.000Z");
    const t2 = new Date("2024-08-01T10:06:00.000Z");
    const toolCalls = JSON.stringify({
      kind: "silence_set",
      silenceKind: "mute",
      setByDisplayName: "Room Admin",
      durationLabel: "30m",
    });

    await db.insert(sessionMessages).values([
      { sessionId: sidA, role: "system", content: "Room Admin muted bots for 30m", toolCalls, createdAt: t0 },
      { sessionId: sidB, role: "system", content: "Room Admin muted bots for 30m", toolCalls, createdAt: t0 },
      { sessionId: sidA, role: "system", content: "Room Admin muted bots for 30m", toolCalls, createdAt: t1 },
    ]);

    const page = await getRoomMessagesAcrossMemberSessions({
      ownerId: ownerA,
      roomId,
      beforeCreatedAt: t2,
      beforeId: 9_999_999,
      limit: 20,
    });

    const rows = page.messages.filter((m) => m.content === "Room Admin muted bots for 30m");
    expect(rows).toHaveLength(2);
    expect(rows.map((m) => m.createdAt.toISOString())).toEqual([
      t0.toISOString(),
      t1.toISOString(),
    ]);
  });

  test("returns distinct authorAgentId for assistant/tool rows in same-owner multi-agent room", async () => {
    const dbLocal = db;
    const [genieAgent] = await dbLocal
      .insert(agents)
      .values({ handle: `d300-genie-${ts}` })
      .returning({ id: agents.id });
    const [jeannieAgent] = await dbLocal
      .insert(agents)
      .values({ handle: `d300-jeannie-${ts}` })
      .returning({ id: agents.id });
    if (!genieAgent || !jeannieAgent) throw new Error("agents");

    const humanActor = await dbLocal
      .select({ id: actors.id })
      .from(actors)
      .where(eq(actors.ownerId, ownerA))
      .limit(1);
    const humanActorId = humanActor[0]?.id;
    if (!humanActorId) throw new Error("human actor");

    const [genieActor] = await dbLocal
      .insert(actors)
      .values({
        ownerId: ownerA,
        displayName: "Genie",
        kind: "agent",
        agentId: genieAgent.id,
      })
      .returning({ id: actors.id });
    const [jeannieActor] = await dbLocal
      .insert(actors)
      .values({
        ownerId: ownerA,
        displayName: "Jeannie",
        kind: "agent",
        agentId: jeannieAgent.id,
      })
      .returning({ id: actors.id });
    if (!genieActor || !jeannieActor) throw new Error("agent actors");

    const [ns] = await dbLocal
      .insert(namespaces)
      .values({ scope: "private", label: `d300-ns-${ts}` })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("namespace");

    const multiRoomId = randomUUID();
    await dbLocal.insert(rooms).values({
      id: multiRoomId,
      ownerId: ownerA,
      type: "private",
      label: "d300 multi-agent",
      graphThreadId: `room:${multiRoomId}`,
      namespaceId: ns.id,
      humanActorIds: [humanActorId],
      kind: "multi_agent",
    });
    await dbLocal.insert(roomMembers).values([
      { roomId: multiRoomId, actorId: humanActorId, roomRole: "admin" },
      { roomId: multiRoomId, actorId: genieActor.id, roomRole: "member", agentResponseMode: "active" },
      { roomId: multiRoomId, actorId: jeannieActor.id, roomRole: "member", agentResponseMode: "active" },
    ]);

    try {
      const sidGenie = await ensureSession({
        threadId: `room-d300-genie-${ts}`,
        ownerId: ownerA,
        personaId: "owner",
        roomId: multiRoomId,
        agentId: genieAgent.id,
      });
      const sidJeannie = await ensureSession({
        threadId: `room-d300-jeannie-${ts}`,
        ownerId: ownerA,
        personaId: "owner",
        roomId: multiRoomId,
        agentId: jeannieAgent.id,
      });

      const t0 = new Date("2025-01-01T12:00:00.000Z");
      const t1 = new Date("2025-01-01T12:01:00.000Z");
      const t2 = new Date("2025-01-01T12:02:00.000Z");
      const t3 = new Date("2025-01-01T12:03:00.000Z");

      await dbLocal.insert(sessionMessages).values([
        { sessionId: sidGenie, role: "assistant", content: "Genie says hi", createdAt: t0 },
        {
          sessionId: sidJeannie,
          role: "assistant",
          content: "Jeannie says hi",
          toolCalls: JSON.stringify([{ id: "tc1", name: "lookup" }]),
          createdAt: t1,
        },
        {
          sessionId: sidJeannie,
          role: "tool",
          content: "ok",
          toolName: "lookup",
          createdAt: t2,
        },
      ]);

      const page = await getRoomMessagesAcrossMemberSessions({
        ownerId: ownerA,
        roomId: multiRoomId,
        beforeCreatedAt: t3,
        beforeId: 9_999_999,
        limit: 20,
      });

      const byContent = Object.fromEntries(page.messages.map((m) => {
        if (m.content === null) throw new Error("Expected ordinary test message");
        return [m.content, m] as const;
      }));
      expect(byContent["Genie says hi"]?.authorAgentId).toBe(genieAgent.id);
      expect(byContent["Jeannie says hi"]?.authorAgentId).toBe(jeannieAgent.id);
      expect(byContent["ok"]?.authorAgentId).toBe(jeannieAgent.id);
      expect(byContent["Genie says hi"]?.sourceUserId).toBe(ownerA);
      expect(byContent["Genie says hi"]?.authorAgentId).not.toBe(
        byContent["Jeannie says hi"]?.authorAgentId,
      );
    } finally {
      const sessRows = await dbLocal
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.roomId, multiRoomId));
      const ids = sessRows.map((s) => s.id);
      if (ids.length > 0) {
        await dbLocal.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ids));
        await dbLocal.delete(sessions).where(inArray(sessions.id, ids));
      }
      await dbLocal.delete(roomMembers).where(eq(roomMembers.roomId, multiRoomId));
      await dbLocal.delete(rooms).where(eq(rooms.id, multiRoomId));
      await dbLocal.delete(namespaces).where(eq(namespaces.id, ns.id));
      await dbLocal.delete(actors).where(eq(actors.id, genieActor.id));
      await dbLocal.delete(actors).where(eq(actors.id, jeannieActor.id));
      await dbLocal.delete(agents).where(inArray(agents.id, [genieAgent.id, jeannieAgent.id]));
    }
  });
});
