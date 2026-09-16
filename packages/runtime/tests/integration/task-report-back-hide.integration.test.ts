/**
 * M143 — hot-path regression guard for the report-back synthetic-row hiding
 * (Blast-radius S2 + S3). Inserts, into a real room, a normal user row
 * (`metadata IS NULL`), a normal assistant row, and a synthetic row tagged
 * `metadata.originatedBy='task'`, then asserts `getRoomMessagesAcrossMemberSessions`:
 *  - S2: HIDES the synthetic `originatedBy='task'` row.
 *  - S3 (NULL-safe control): still RENDERS the normal `metadata IS NULL` rows —
 *    a bare `<> 'task'` predicate would have silently dropped the whole
 *    transcript, so this is its own assert.
 *
 * Real Postgres; no API keys / LLM needed (no graph turn).
 */

import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  actors,
  agents,
  namespaces,
  rooms,
  roomMembers,
  sessions,
  sessionMessages,
  eq,
  inArray,
  type DirectDatabase,
} from "@nautilo/db";
import { ensureSession, getRoomMessagesAcrossMemberSessions } from "@nautilo/agent";
import { setupTestDb, getDirectDb, closeDirectDb, createTestUser, cleanupTestUser } from "./helpers";

let db: DirectDatabase;
let ownerId: string;
let roomId: string;

beforeAll(async () => {
  await setupTestDb();
  db = getDirectDb();
  const u = await createTestUser("m143-hide");
  ownerId = u.userId;

  const ts = Date.now().toString();
  const [userActor] = await db
    .insert(actors)
    .values({ ownerId, displayName: "User", kind: "user" })
    .returning({ id: actors.id });
  const [ag] = await db
    .insert(agents)
    .values({ handle: `m143hide${ts.slice(-6)}` })
    .returning({ id: agents.id });
  const [agActor] = await db
    .insert(actors)
    .values({ ownerId, displayName: "Genie", kind: "agent", agentId: ag!.id })
    .returning({ id: actors.id });
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m143-hide-${ts}` })
    .returning({ id: namespaces.id });

  roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    ownerId,
    type: "private",
    label: "m143 hide room",
    graphThreadId: `room:${roomId}`,
    namespaceId: ns!.id,
    humanActorIds: [userActor!.id],
  });
  await db.insert(roomMembers).values({ roomId, actorId: userActor!.id, roomRole: "admin" });
  await db.insert(roomMembers).values({ roomId, actorId: agActor!.id, roomRole: "member" });

  const sidUser = await ensureSession({ threadId: `m143-u-${ts}`, ownerId, personaId: "owner", roomId });
  const sidBot = await ensureSession({
    threadId: `m143-bot-${ts}`,
    ownerId,
    personaId: "owner",
    roomId,
    agentId: ag!.id,
  });

  const base = Date.now();
  // Normal rows (metadata NULL) — must STILL render (S3 NULL-safe control).
  await db.insert(sessionMessages).values({ sessionId: sidUser, role: "user", content: "NORMAL_USER_ROW", createdAt: new Date(base) });
  await db.insert(sessionMessages).values({ sessionId: sidBot, role: "assistant", content: "NORMAL_ASSISTANT_ROW", createdAt: new Date(base + 1000) });
  // Synthetic report-back input row — must be HIDDEN (S2).
  await db.insert(sessionMessages).values({
    sessionId: sidBot,
    role: "user",
    content: "[TASK RESULT — task xyz \"do the thing\"] SECRET_SYNTHETIC_ROW",
    createdAt: new Date(base + 2000),
    metadata: { originatedBy: "task", taskId: "xyz", taskRunId: "run-1" },
  });
  for (const role of ["user", "assistant", "tool"]) {
    await db.insert(sessionMessages).values({
      sessionId: sidBot, role, content: `INTERNAL_SUPERVISION_${role}`,
      createdAt: new Date(base + 3000),
      metadata: { originatedBy: "connected_web_operation", operationId: "op-1", controlEpoch: 1 },
    });
  }
});

afterAll(async () => {
  if (!db) return;
  try {
    const sess = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.roomId, roomId));
    const ids = sess.map((s) => s.id);
    if (ids.length > 0) {
      await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ids));
      await db.delete(sessions).where(inArray(sessions.id, ids));
    }
    await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
    await db.delete(rooms).where(eq(rooms.id, roomId));
  } finally {
    await cleanupTestUser(ownerId);
    await closeDirectDb();
  }
});

describe("M143 — synthetic report-back row hiding (S2 + S3)", () => {
  test("hides originatedBy='task' rows but renders normal (metadata NULL) rows", async () => {
    const { messages } = await getRoomMessagesAcrossMemberSessions({
      ownerId,
      roomId,
      beforeCreatedAt: new Date(Date.now() + 60_000),
      beforeId: 2_147_483_647,
      limit: 100,
    });
    const contents = messages.map((m) => {
      if (m.content === null) throw new Error("seeded room message content unavailable");
      return m.content;
    });

    // S3 — normal rows render.
    expect(contents).toContain("NORMAL_USER_ROW");
    expect(contents).toContain("NORMAL_ASSISTANT_ROW");
    // S2 — synthetic task row is hidden.
    expect(contents.some((c) => c.includes("SECRET_SYNTHETIC_ROW"))).toBe(false);
    expect(contents.some((c) => c.includes("INTERNAL_SUPERVISION_"))).toBe(false);
  });
});
