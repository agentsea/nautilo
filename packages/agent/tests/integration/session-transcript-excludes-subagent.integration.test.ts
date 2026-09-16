/**
 * M084 — transcript listing must never surface scope-subagent sessions
 * (`thread_id` prefix `subagent:`) as the “main” chat or in room pagination.
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
  sessions,
  sessionMessages,
  namespaces,
  rooms,
  roomMembers,
  eq,
  inArray,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  ensureSession,
  getLatestSession,
  getLatestSessionForRoom,
  getRoomMessagesBeforeCursor,
} from "../../src/store/session-store";


let db: ReturnType<typeof createDirectDb>;
let ownerId: string;
let actorId: string;
let roomId: string;
const ts = Date.now().toString(36);

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);

  const [u] = await db
    .insert(users)
    .values({
      name: `m084-tx-${ts}`,
      email: `m084tx-${ts}@test.local`,
      handle: `m084tx${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!u) throw new Error("user");
  ownerId = u.id;

  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m084-tx-ns-${ts}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("namespace");

  roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    ownerId,
    type: "private",
    label: "m084 transcript test",
    graphThreadId: `room:${roomId}`,
    namespaceId: ns.id,
    humanActorIds: [],
  });

  // D168 FORCE RLS on `sessions` requires owner membership via kind='user' actor.
  const [actor] = await db
    .insert(actors)
    .values({
      ownerId,
      kind: "user",
      displayName: "integration-test-actor",
      trustState: "verified",
    })
    .returning({ id: actors.id });
  if (!actor) throw new Error("actor");
  actorId = actor.id;
  await db.insert(roomMembers).values({
    roomId,
    actorId,
    roomRole: "admin",
  });
});

async function deleteSessionsForOwner(): Promise<void> {
  const sessRows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.ownerId, ownerId));
  const ids = sessRows.map((s) => s.id);
  if (ids.length > 0) {
    await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ids));
    await db.delete(sessions).where(inArray(sessions.id, ids));
  }
}

afterEach(async () => {
  await deleteSessionsForOwner();
});

afterAll(async () => {
  if (!db) return;
  try {
    await deleteSessionsForOwner();
    const roomRow = await db
      .select({ namespaceId: rooms.namespaceId })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    const nsId = roomRow[0]?.namespaceId;
    await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
    await db.delete(actors).where(eq(actors.id, actorId));
    await db.delete(rooms).where(eq(rooms.id, roomId));
    if (nsId) {
      await db.delete(namespaces).where(eq(namespaces.id, nsId));
    }
    await db.delete(users).where(eq(users.id, ownerId));
  } finally {
    await db.end();
  }
});

describe("session transcript excludes subagent threads (M084)", () => {
  test("getLatestSession skips subagent session even when it is most recently updated", async () => {
    const mainThread = `room:m084-latest-${ts}`;
    const subThread = `subagent:${mainThread}:abc`;

    const mainSessionId = await ensureSession({
      threadId: mainThread,
      ownerId,
      personaId: "owner",
      roomId,
    });
    const subSessionId = await ensureSession({
      threadId: subThread,
      ownerId,
      personaId: "owner",
      roomId,
    });

    const old = new Date("2020-01-01T00:00:00.000Z");
    const future = new Date("2035-06-01T00:00:00.000Z");
    await db.update(sessions).set({ endedAt: old }).where(eq(sessions.id, mainSessionId));
    await db.update(sessions).set({ endedAt: future }).where(eq(sessions.id, subSessionId));

    const latest = await getLatestSession(ownerId);
    expect(latest).not.toBeNull();
    expect(latest!.threadId).toBe(mainThread);
  });

  test("getLatestSessionForRoom returns main room session, not subagent", async () => {
    const mainThread = `room:m084-room-${ts}`;
    const subThread = `subagent:${mainThread}:xyz`;

    const mainSessionId = await ensureSession({
      threadId: mainThread,
      ownerId,
      personaId: "owner",
      roomId,
    });
    const subSessionId = await ensureSession({
      threadId: subThread,
      ownerId,
      personaId: "owner",
      roomId,
    });

    await db.update(sessions).set({ endedAt: new Date("2021-01-01") }).where(eq(sessions.id, mainSessionId));
    await db.update(sessions).set({ endedAt: new Date("2030-01-01") }).where(eq(sessions.id, subSessionId));

    const latest = await getLatestSessionForRoom(ownerId, roomId);
    expect(latest).not.toBeNull();
    expect(latest!.threadId).toBe(mainThread);
  });

  test("getRoomMessagesBeforeCursor omits messages from subagent sessions", async () => {
    const mainThread = `room:m084-cursor-${ts}`;
    const subThread = `subagent:${mainThread}:p1`;

    const mainSessionId = await ensureSession({
      threadId: mainThread,
      ownerId,
      personaId: "owner",
      roomId,
    });
    const subSessionId = await ensureSession({
      threadId: subThread,
      ownerId,
      personaId: "owner",
      roomId,
    });

    const t0 = new Date("2024-01-01T12:00:00.000Z");
    const t1 = new Date("2024-01-01T12:01:00.000Z");
    const t2 = new Date("2024-01-01T12:02:00.000Z");

    const [m0] = await db
      .insert(sessionMessages)
      .values({
        sessionId: mainSessionId,
        role: "user",
        content: "main first",
        createdAt: t0,
      })
      .returning({ id: sessionMessages.id });

    await db.insert(sessionMessages).values({
      sessionId: subSessionId,
      role: "assistant",
      content: "SECRET SUBAGENT",
      createdAt: t1,
    });

    const [m2] = await db
      .insert(sessionMessages)
      .values({
        sessionId: mainSessionId,
        role: "assistant",
        content: "main second",
        createdAt: t2,
      })
      .returning({ id: sessionMessages.id });

    if (!m0 || !m2) throw new Error("messages");

    const page = await getRoomMessagesBeforeCursor({
      ownerId,
      roomId,
      beforeCreatedAt: t2,
      beforeId: m2.id,
      limit: 10,
    });

    const texts = page.messages.map((m) => m.content);
    expect(texts).toContain("main first");
    expect(texts).not.toContain("SECRET SUBAGENT");
    expect(texts).not.toContain("main second");
  });
});
