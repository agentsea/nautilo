/**
 * M124 — `findOtherAdminMembers` lists human admins excluding the caller.
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
  inArray,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { createOpenRoom, findOtherAdminMembers } from "../../src/queries";

let db: ReturnType<typeof createDirectDb>;
let creatorUserId: string;
let creatorActorId: string;
let secondUserId: string;
let secondActorId: string;
let roomId: string;
let namespaceId: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const ts = Date.now().toString(36);

  const [creator] = await db
    .insert(users)
    .values({
      name: "m124-foam-creator",
      email: `m124foamc-${ts}@test.local`,
      handle: `m124fc${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!creator) throw new Error("creator user");
  creatorUserId = creator.id;

  const [creatorActor] = await db
    .insert(actors)
    .values({
      ownerId: creatorUserId,
      displayName: "Creator",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!creatorActor) throw new Error("creator actor");
  creatorActorId = creatorActor.id;

  const openRoom = await createOpenRoom({
    creatorUserId,
    creatorActorId,
    label: "#admins",
  });
  roomId = openRoom.id;

  const [roomRow] = await db
    .select({ namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (!roomRow) throw new Error("room");
  namespaceId = roomRow.namespaceId;

  const [secondUser] = await db
    .insert(users)
    .values({
      name: "m124-foam-second",
      email: `m124foams-${ts}@test.local`,
      handle: `m124fs${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!secondUser) throw new Error("second user");
  secondUserId = secondUser.id;

  const [secondActor] = await db
    .insert(actors)
    .values({
      ownerId: secondUserId,
      displayName: "Second admin",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!secondActor) throw new Error("second actor");
  secondActorId = secondActor.id;
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
    const actorIds = [creatorActorId, secondActorId].filter(Boolean);
    if (actorIds.length > 0) {
      await db.delete(actors).where(inArray(actors.id, actorIds));
    }
    const userIds = [creatorUserId, secondUserId].filter(Boolean);
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  } finally {
    await db.end();
  }
});

describe("findOtherAdminMembers (M124)", () => {
  test("returns empty when the excluded actor is the sole admin", async () => {
    const got = await findOtherAdminMembers(roomId, creatorActorId);
    expect(got).toEqual([]);
  });

  test("returns the other human admin after a second admin joins", async () => {
    await db.insert(roomMembers).values({
      roomId,
      actorId: secondActorId,
      roomRole: "admin",
    });

    const fromCreator = await findOtherAdminMembers(roomId, creatorActorId);
    expect(fromCreator).toEqual([secondActorId]);

    const fromSecond = await findOtherAdminMembers(roomId, secondActorId);
    expect(fromSecond).toEqual([creatorActorId]);
  });
});
