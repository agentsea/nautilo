/**
 * M124 — `listDiscoverableRoomsForUser` server-level open-room discovery.
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
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
  sessions,
  sessionMessages,
  inArray,
} from "@nautilo/db";
import {
  createOpenRoom,
  joinOpenRoom,
  listDiscoverableRoomsForUser,
} from "../../src/queries";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

let db: ReturnType<typeof createDirectDb>;
let creatorUserId: string;
let creatorActorId: string;
let viewerUserId: string;
let viewerActorId: string;
let remoteUserId: string;
let remoteActorId: string;
let openRoom1Id: string;
let openRoom2Id: string;
let privateRoomId: string;
let remoteOpenRoomId: string;
const namespaceIds: string[] = [];
const roomIds: string[] = [];

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const ts = Date.now().toString(36);

  const [creator] = await db
    .insert(users)
    .values({
      name: "m124-disc-creator",
      email: `m124discc-${ts}@test.local`,
      handle: `m124dc${ts.slice(-6)}`,
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

  const open1 = await createOpenRoom({
    creatorUserId,
    creatorActorId,
    label: "#open-one",
  });
  openRoom1Id = open1.id;
  roomIds.push(openRoom1Id);

  const open2 = await createOpenRoom({
    creatorUserId,
    creatorActorId,
    label: "#open-two",
  });
  openRoom2Id = open2.id;
  roomIds.push(openRoom2Id);

  const [viewer] = await db
    .insert(users)
    .values({
      name: "m124-disc-viewer",
      email: `m124discv-${ts}@test.local`,
      handle: `m124dv${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!viewer) throw new Error("viewer user");
  viewerUserId = viewer.id;

  const [viewerActor] = await db
    .insert(actors)
    .values({
      ownerId: viewerUserId,
      displayName: "Viewer",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!viewerActor) throw new Error("viewer actor");
  viewerActorId = viewerActor.id;

  const [privateNs] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m124-disc-private-${ts}` })
    .returning({ id: namespaces.id });
  if (!privateNs) throw new Error("private namespace");
  namespaceIds.push(privateNs.id);

  privateRoomId = randomUUID();
  roomIds.push(privateRoomId);
  await db.insert(rooms).values({
    id: privateRoomId,
    ownerId: creatorUserId,
    type: "private",
    kind: "private",
    label: "Hidden private",
    graphThreadId: `room:${privateRoomId}`,
    namespaceId: privateNs.id,
    humanActorIds: [creatorActorId],
  });
  await db.insert(roomMembers).values({
    roomId: privateRoomId,
    actorId: creatorActorId,
    roomRole: "admin",
  });

  const [remoteUser] = await db
    .insert(users)
    .values({
      name: "m124-disc-remote",
      email: `m124discr-${ts}@test.local`,
      handle: `m124dr${ts.slice(-6)}`,
      server: "remote.example",
    })
    .returning({ id: users.id });
  if (!remoteUser) throw new Error("remote user");
  remoteUserId = remoteUser.id;

  const [remoteActor] = await db
    .insert(actors)
    .values({
      ownerId: remoteUserId,
      displayName: "Remote owner",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!remoteActor) throw new Error("remote actor");
  remoteActorId = remoteActor.id;

  const remoteOpen = await createOpenRoom({
    creatorUserId: remoteUserId,
    creatorActorId: remoteActorId,
    label: "#remote",
  });
  remoteOpenRoomId = remoteOpen.id;
  roomIds.push(remoteOpenRoomId);

  const seededRooms = await db
    .select({ id: rooms.id, namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(inArray(rooms.id, roomIds));
  for (const row of seededRooms) {
    if (!namespaceIds.includes(row.namespaceId)) {
      namespaceIds.push(row.namespaceId);
    }
  }
});

afterAll(async () => {
  if (!db) return;
  try {
    if (roomIds.length > 0) {
      const sessRows = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(inArray(sessions.roomId, roomIds));
      const sessIds = sessRows.map((s) => s.id);
      if (sessIds.length > 0) {
        await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessIds));
        await db.delete(sessions).where(inArray(sessions.id, sessIds));
      }
      await db.delete(roomMembers).where(inArray(roomMembers.roomId, roomIds));
      await db.delete(rooms).where(inArray(rooms.id, roomIds));
    }
    if (namespaceIds.length > 0) {
      await db.delete(namespaces).where(inArray(namespaces.id, namespaceIds));
    }
    const actorIds = [creatorActorId, viewerActorId, remoteActorId].filter(
      Boolean,
    );
    if (actorIds.length > 0) {
      await db.delete(actors).where(inArray(actors.id, actorIds));
    }
    const userIds = [creatorUserId, viewerUserId, remoteUserId].filter(Boolean);
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  } finally {
    await db.end();
  }
});

describe("listDiscoverableRoomsForUser (M124)", () => {
  test("lists local open rooms the viewer has not joined", async () => {
    const got = await listDiscoverableRoomsForUser(viewerUserId);
    const ids = got.map((r) => r.id);

    expect(ids).toContain(openRoom1Id);
    expect(ids).toContain(openRoom2Id);
    expect(ids).not.toContain(privateRoomId);
    expect(ids).not.toContain(remoteOpenRoomId);
    expect(got.every((r) => r.kind === "open")).toBe(true);
  });

  test("excludes rooms after the viewer joins them", async () => {
    await joinOpenRoom({
      userId: viewerUserId,
      actorId: viewerActorId,
      roomId: openRoom1Id,
    });

    const got = await listDiscoverableRoomsForUser(viewerUserId);
    const ids = got.map((r) => r.id);

    expect(ids).not.toContain(openRoom1Id);
    expect(ids).toContain(openRoom2Id);
  });
});
