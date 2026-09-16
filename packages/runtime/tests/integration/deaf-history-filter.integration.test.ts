/**
 * D279 Phase 3 — deaf-window ingestion filter integration tests.
 *
 * Asserts messages authored during a deaf window never appear in bot-facing
 * reads, even after the window expires. Includes a load-bearing NO-OP check:
 * without the filter the secret message WOULD leak.
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createDirectDb,
  users,
  actors,
  agents,
  sessions,
  sessionMessages,
  namespaces,
  rooms,
  roomMembers,
  roomSilenceState,
  eq,
  inArray,
  sql,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { ensureSession } from "@nautilo/agent";
import {
  roomMessagesSince,
  recentRoomMessages,
  searchRoomHistory,
} from "@nautilo/runtime";
import { deafWindowExclusionSql } from "../../src/conductor/history-search";

if (!process.env["DB_CONNECTION_STRING"]) {
  process.env["DB_CONNECTION_STRING"] =
    "postgresql://postgres:postgres@localhost:6834/nautilo";
}

let db: ReturnType<typeof createDirectDb>;
const ts = Date.now().toString(36);

let ownerId = "";
let userActorId = "";
let agentId = "";
let agentActorId = "";
let roomId = "";
let sessionId = "";

const DEAF_START = new Date("2026-06-02T10:00:00.000Z");
const DEAF_END = new Date("2026-06-02T10:30:00.000Z");
const SECRET_MSG_TS = new Date("2026-06-02T10:15:00.000Z");
const AFTER_DEAF_TS = new Date("2026-06-02T11:00:00.000Z");
const SECRET_CONTENT = `deaf-secret-${ts}`;

beforeAll(async () => {
  bootstrapTestDbInstance();
  db = createDirectDb(1);

  const [u] = await db
    .insert(users)
    .values({
      name: `d279-${ts}`,
      email: `d279-${ts}@test.local`,
      handle: `d279${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  ownerId = u!.id;

  const [ua] = await db
    .insert(actors)
    .values({ ownerId, displayName: "Tester", kind: "user" })
    .returning({ id: actors.id });
  userActorId = ua!.id;

  const [ag] = await db
    .insert(agents)
    .values({ handle: `bot${ts.slice(-6)}` })
    .returning({ id: agents.id });
  agentId = ag!.id;

  const [aa] = await db
    .insert(actors)
    .values({ ownerId, displayName: "Bot", kind: "agent", agentId })
    .returning({ id: actors.id });
  agentActorId = aa!.id;

  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `d279-ns-${ts}` })
    .returning({ id: namespaces.id });

  roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    ownerId,
    type: "private",
    label: "d279 deaf filter",
    graphThreadId: `room:${roomId}`,
    namespaceId: ns!.id,
    humanActorIds: [userActorId],
  });
  await db.insert(roomMembers).values({ roomId, actorId: userActorId, roomRole: "admin" });
  await db.insert(roomMembers).values({ roomId, actorId: agentActorId, roomRole: "member" });

  sessionId = await ensureSession({
    threadId: `d279-${ts}`,
    ownerId,
    personaId: "owner",
    roomId,
  });

  await db.insert(sessionMessages).values({
    sessionId,
    role: "user",
    content: SECRET_CONTENT,
    createdAt: SECRET_MSG_TS,
  });
  await db.insert(sessionMessages).values({
    sessionId,
    role: "user",
    content: `visible-after-deaf-${ts}`,
    createdAt: AFTER_DEAF_TS,
  });

  await db.insert(roomSilenceState).values({
    roomId,
    botActorId: null,
    kind: "deaf",
    setByUserId: ownerId,
    startedAt: DEAF_START,
    expiresAt: DEAF_END,
  });
});

afterAll(async () => {
  if (!db) return;
  try {
    await db.delete(roomSilenceState).where(eq(roomSilenceState.roomId, roomId));
    const sess = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.roomId, roomId));
    const ids = sess.map((s) => s.id);
    if (ids.length > 0) {
      await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ids));
      await db.delete(sessions).where(inArray(sessions.id, ids));
    }
    await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
    const r = await db
      .select({ namespaceId: rooms.namespaceId })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    await db.delete(rooms).where(eq(rooms.id, roomId));
    if (r[0]?.namespaceId) {
      await db.delete(namespaces).where(eq(namespaces.id, r[0].namespaceId));
    }
    await db.delete(actors).where(eq(actors.ownerId, ownerId));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.delete(users).where(eq(users.id, ownerId));
  } finally {
    await db.end();
  }
});

describe("deaf-window ingestion filter (D279)", () => {
  test("roomMessagesSince excludes deaf-window message for woken bot after expiry", async () => {
    const msgs = await roomMessagesSince(db, {
      roomId,
      since: null,
      limit: 50,
      botActorId: agentActorId,
    });
    const contents = msgs.map((m) => m.snippet);
    expect(contents.some((c) => c.includes(SECRET_CONTENT))).toBe(false);
    expect(contents.some((c) => c.includes(`visible-after-deaf-${ts}`))).toBe(true);
  });

  test("recentRoomMessages applies the same deaf filter", async () => {
    const recent = await recentRoomMessages(db, {
      roomId,
      limit: 50,
      botActorId: agentActorId,
    });
    expect(recent.some((m) => m.snippet.includes(SECRET_CONTENT))).toBe(false);
  });

  test("searchRoomHistory excludes deaf-window message for bot-scoped search", async () => {
    const hits = await searchRoomHistory(db, {
      roomId,
      query: "deaf-secret",
      limit: 10,
      botActorId: agentActorId,
    });
    expect(hits.some((h) => h.snippet.includes(SECRET_CONTENT))).toBe(false);
  });

  test("NO-OP: without deaf filter the secret message WOULD leak", async () => {
    type ContentRow = { content: string };
    function rowsFromExecute(
      result:
        | readonly Record<string, unknown>[]
        | { rows: readonly Record<string, unknown>[] },
    ): ContentRow[] {
      const rows = Array.isArray(result)
        ? result
        : (result as { rows: readonly Record<string, unknown>[] }).rows;
      return rows as ContentRow[];
    }

    const raw = await db.execute(sql`
      SELECT sm.content AS content
      FROM session_messages sm
      INNER JOIN sessions s ON s.id = sm.session_id
      WHERE s.room_id = ${roomId}
        AND sm.content LIKE ${`%${SECRET_CONTENT}%`}
    `);
    expect(rowsFromExecute(raw).length).toBeGreaterThan(0);

    const filtered = await db.execute(sql`
      SELECT sm.content AS content
      FROM session_messages sm
      INNER JOIN sessions s ON s.id = sm.session_id
      WHERE s.room_id = ${roomId}
        AND sm.content LIKE ${`%${SECRET_CONTENT}%`}
        ${deafWindowExclusionSql(roomId, agentActorId)}
    `);
    expect(rowsFromExecute(filtered).length).toBe(0);
  });
});
