/**
 * D543 — Server-local social directory pin (live Postgres).
 *
 * Two active local Humans can discover and start a conversation with each
 * other before any shared Room exists. Joining an open Room must not be the
 * event that grants this basic social reachability.
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
  rooms,
  roomMembers,
  namespaces,
  sessions,
  sessionMessages,
  eq,
  inArray,
} from "@nautilo/db";
import {
  createOpenRoom,
  joinOpenRoom,
  listDirectoryHumans,
  assertCanCreateRoomMembers,
} from "../../src/queries";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

let db: ReturnType<typeof createDirectDb>;
let userAId: string;
let userBId: string;
let userCId: string;
let actorAId: string;
let actorBId: string;
let actorCId: string;
let openRoomId: string;
let openNamespaceId: string;

async function seedUserWithActor(
  ts: string,
  tag: string,
): Promise<{ userId: string; actorId: string }> {
  const [u] = await db
    .insert(users)
    .values({
      name: `m124-rr-${tag}`,
      email: `m124rr-${tag}-${ts}@test.local`,
      handle: `m124rr${tag}${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!u) throw new Error(`user ${tag}`);
  const [a] = await db
    .insert(actors)
    .values({ ownerId: u.id, displayName: `RR ${tag}`, trustState: "verified", kind: "user" })
    .returning({ id: actors.id });
  if (!a) throw new Error(`actor ${tag}`);
  return { userId: u.id, actorId: a.id };
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const ts = Date.now().toString(36);

  ({ userId: userAId, actorId: actorAId } = await seedUserWithActor(ts, "a"));
  ({ userId: userBId, actorId: actorBId } = await seedUserWithActor(ts, "b"));
  ({ userId: userCId, actorId: actorCId } = await seedUserWithActor(ts, "c"));
});

afterAll(async () => {
  if (!db) return;
  try {
    if (openRoomId) {
      const sessRows = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.roomId, openRoomId));
      const sessIds = sessRows.map((s) => s.id);
      if (sessIds.length > 0) {
        await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessIds));
        await db.delete(sessions).where(inArray(sessions.id, sessIds));
      }
      await db.delete(roomMembers).where(eq(roomMembers.roomId, openRoomId));
      await db.delete(rooms).where(eq(rooms.id, openRoomId));
    }
    if (openNamespaceId) {
      await db.delete(namespaces).where(eq(namespaces.id, openNamespaceId));
    }
    await db.delete(actors).where(eq(actors.ownerId, userAId));
    await db.delete(actors).where(eq(actors.ownerId, userBId));
    await db.delete(actors).where(eq(actors.ownerId, userCId));
    await db.delete(users).where(eq(users.id, userAId));
    await db.delete(users).where(eq(users.id, userBId));
    await db.delete(users).where(eq(users.id, userCId));
  } finally {
    await db.end();
  }
});

describe("D543 Server-local Human reachability", () => {
  test("before joining: A can discover and reach B", async () => {
    const dir = await listDirectoryHumans(userAId, { isAdmin: false });
    expect(dir.some((u) => u.userId === userBId)).toBe(true);

    await assertCanCreateRoomMembers({
      callerUserId: userAId,
      members: [{ kind: "user", id: userBId }],
      isAdmin: false,
    });
  });

  test("after both join an open Room: reachability remains unchanged", async () => {
    const detail = await createOpenRoom({
      creatorUserId: userCId,
      creatorActorId: actorCId,
      label: "#water-cooler",
    });
    openRoomId = detail.id;
    const [roomRow] = await db
      .select({ namespaceId: rooms.namespaceId })
      .from(rooms)
      .where(eq(rooms.id, openRoomId))
      .limit(1);
    openNamespaceId = roomRow?.namespaceId ?? "";

    await joinOpenRoom({ userId: userAId, actorId: actorAId, roomId: openRoomId });
    await joinOpenRoom({ userId: userBId, actorId: actorBId, roomId: openRoomId });

    const dir = await listDirectoryHumans(userAId, { isAdmin: false });
    expect(dir.some((u) => u.userId === userBId)).toBe(true);

    // No throw == reachable.
    await assertCanCreateRoomMembers({
      callerUserId: userAId,
      members: [{ kind: "user", id: userBId }],
      isAdmin: false,
    });
  });
});
