/**
 * M075 — `findRoomIdByGraphThreadIdForUser` membership boundary (trust + DB).
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
  namespaces,
  rooms,
  roomMembers,
  eq,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { findRoomIdByGraphThreadIdForUser } from "../../src/queries";

let db: ReturnType<typeof createDirectDb>;
let userAId: string;
let userBId: string;
let actorAId: string;
let roomId: string;
let namespaceId: string;
let graphThreadKey: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const ts = Date.now().toString(36);

  const [ua] = await db
    .insert(users)
    .values({
      name: "m075-room-a",
      email: `m075a-${ts}@test.local`,
      handle: `m075a${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  const [ub] = await db
    .insert(users)
    .values({
      name: "m075-room-b",
      email: `m075b-${ts}@test.local`,
      handle: `m075b${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!ua || !ub) throw new Error("users");
  userAId = ua.id;
  userBId = ub.id;

  const [actA] = await db
    .insert(actors)
    .values({
      ownerId: userAId,
      displayName: "Actor A",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  await db.insert(actors).values({
    ownerId: userBId,
    displayName: "Actor B",
    trustState: "verified",
    kind: "user",
  });
  if (!actA) throw new Error("actor A");
  actorAId = actA.id;

  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "room", label: `m075-ns-${ts}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("namespace");
  namespaceId = ns.id;

  const [rm] = await db
    .insert(rooms)
    .values({
      ownerId: userAId,
      type: "private",
      label: "M075 test room",
      graphThreadId: "pending-placeholder",
      namespaceId: ns.id,
      humanActorIds: [actorAId],
    })
    .returning({ id: rooms.id });
  if (!rm) throw new Error("room");
  roomId = rm.id;
  graphThreadKey = `room:${roomId}`;

  await db
    .update(rooms)
    .set({ graphThreadId: graphThreadKey })
    .where(eq(rooms.id, roomId));

  await db.insert(roomMembers).values({
    roomId,
    actorId: actorAId,
    roomRole: "member",
  });
});

afterAll(async () => {
  if (!db) return;
  try {
    if (roomId) {
      await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
      await db.delete(rooms).where(eq(rooms.id, roomId));
    }
    if (namespaceId) {
      await db.delete(namespaces).where(eq(namespaces.id, namespaceId));
    }
    await db.delete(actors).where(eq(actors.ownerId, userAId));
    await db.delete(actors).where(eq(actors.ownerId, userBId));
    await db.delete(users).where(eq(users.id, userAId));
    await db.delete(users).where(eq(users.id, userBId));
  } finally {
    await db.end();
  }
});

describe("findRoomIdByGraphThreadIdForUser (M075)", () => {
  test("returns room id when session user is a member and graph thread matches", async () => {
    const rid = await findRoomIdByGraphThreadIdForUser(userAId, graphThreadKey);
    expect(rid).toBe(roomId);
  });

  test("returns null for another user who is not a room member", async () => {
    const rid = await findRoomIdByGraphThreadIdForUser(userBId, graphThreadKey);
    expect(rid).toBeNull();
  });

  test("returns null when graph thread id does not match any room", async () => {
    const rid = await findRoomIdByGraphThreadIdForUser(
      userAId,
      "room:00000000-0000-4000-8000-00000000dead",
    );
    expect(rid).toBeNull();
  });
});
