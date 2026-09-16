import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  channelIdentities,
  groupMembers,
  jobs,
  inArray,
  namespaces,
  profiles,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  users,
  eq,
} from "@nautilo/db";
import {
  seatPeerUser,
  setupOwnerAppFixture,
  type AppFixture,
} from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";
import { findOrCreateHumanOnlyDirectRoom } from "@nautilo/trust";

type Peer = Awaited<ReturnType<typeof seatPeerUser>>;

async function deleteRooms(
  fx: AppFixture,
  roomIds: readonly string[],
): Promise<void> {
  if (roomIds.length === 0) return;
  const roomRows = await fx.db
    .select({ id: rooms.id, namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(inArray(rooms.id, [...roomIds]));
  const ids = roomRows.map(({ id }) => id);
  const sessionRows = ids.length > 0
    ? await fx.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.roomId, ids))
    : [];
  const sessionIds = sessionRows.map(({ id }) => id);
  if (sessionIds.length > 0) {
    await fx.db
      .delete(sessionMessages)
      .where(inArray(sessionMessages.sessionId, sessionIds));
    await fx.db.delete(sessions).where(inArray(sessions.id, sessionIds));
  }
  if (ids.length > 0) {
    await fx.db.delete(jobs).where(inArray(jobs.roomId, ids));
    await fx.db.delete(roomMembers).where(inArray(roomMembers.roomId, ids));
    await fx.db.delete(rooms).where(inArray(rooms.id, ids));
  }
  const namespaceIds = roomRows.map(({ namespaceId }) => namespaceId);
  if (namespaceIds.length > 0) {
    await fx.db.delete(namespaces).where(inArray(namespaces.id, namespaceIds));
  }
}

async function deletePeer(fx: AppFixture, peer: Peer): Promise<void> {
  await fx.db.delete(groupMembers).where(eq(groupMembers.userId, peer.userId));
  await fx.db
    .delete(channelIdentities)
    .where(eq(channelIdentities.userId, peer.userId));
  await fx.db.delete(profiles).where(eq(profiles.userId, peer.userId));
  await fx.db.delete(actors).where(eq(actors.ownerId, peer.userId));
  await fx.db.delete(agents).where(eq(agents.id, peer.agentId));
  await fx.db.delete(users).where(eq(users.id, peer.userId));
}

describe("M259 server-authoritative Guest landing", () => {
  let fx: AppFixture;
  let publicRoomId: string;
  let peerPublic: Peer;
  let peerFallback: Peer;
  const dynamicRoomIds: string[] = [];

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({
      suiteName: "m259land",
      withDefaultAgentGraph: true,
    });
    if (!fx.defaultRoomId) throw new Error("M259 default Agent Room");

    peerPublic = await seatPeerUser(fx.db, {
      suiteName: "m259pub",
      groupType: "guests",
    });
    peerFallback = await seatPeerUser(fx.db, {
      suiteName: "m259dm",
      groupType: "guests",
    });

    const [namespace] = await fx.db
      .insert(namespaces)
      .values({ scope: "shared", label: "M259 public" })
      .returning({ id: namespaces.id });
    if (!namespace) throw new Error("M259 public Namespace");
    const id = randomUUID();
    const extraHumanActors = await fx.db
      .insert(actors)
      .values(
        Array.from({ length: 32 }, (_, index) => ({
          ownerId: fx.ownerId,
          displayName: `M259 public member ${index}`,
          trustState: "verified" as const,
          kind: "user" as const,
        })),
      )
      .returning({ id: actors.id });
    const publicHumanActorIds = [
      fx.ownerActorId,
      ...extraHumanActors.map(({ id: actorId }) => actorId),
    ];
    await fx.db.insert(rooms).values({
      id,
      ownerId: fx.ownerId,
      type: "shared",
      kind: "open",
      label: "M259 human public",
      graphThreadId: `room:${id}`,
      namespaceId: namespace.id,
      humanActorIds: publicHumanActorIds,
      createdBy: fx.ownerActorId,
    });
    await fx.db.insert(roomMembers).values(
      publicHumanActorIds.map((actorId, index) => ({
        roomId: id,
        actorId,
        roomRole: index === 0 ? "admin" as const : "member" as const,
      })),
    );
    const [agentActor] = await fx.db
      .select({ id: actors.id })
      .from(actors)
      .where(eq(actors.agentId, fx.defaultAgentId!))
      .limit(1);
    if (!agentActor) throw new Error("M260 Agent Actor");
    await fx.db.insert(roomMembers).values({
      roomId: id,
      actorId: agentActor.id,
      roomRole: "member",
      agentResponseMode: "active",
    });
    publicRoomId = id;
    dynamicRoomIds.push(id);
  });

  afterAll(async () => {
    const peerActorIds = [peerPublic.actorId, peerFallback.actorId];
    await deleteRooms(fx, [...new Set(dynamicRoomIds)]);
    await fx.db
      .delete(roomMembers)
      .where(inArray(roomMembers.actorId, peerActorIds));
    await deletePeer(fx, peerPublic);
    await deletePeer(fx, peerFallback);
    await fx.cleanup();
  });

  test("auto-joins the largest eligible Agent-bearing public Room idempotently", async () => {
    const first = await authedInject(fx.app, {
      method: "POST",
      url: "/api/rooms/resolve-landing",
      bearer: peerPublic.bearer,
    });
    expect(first.statusCode).toBe(200);
    expect((JSON.parse(first.body) as { id: string }).id).toBe(
      publicRoomId,
    );

    const second = await authedInject(fx.app, {
      method: "POST",
      url: "/api/rooms/resolve-landing",
      bearer: peerPublic.bearer,
    });
    expect(second.statusCode).toBe(200);
    expect((JSON.parse(second.body) as { id: string }).id).toBe(
      publicRoomId,
    );
    const rows = await fx.db
      .select({ actorId: roomMembers.actorId })
      .from(roomMembers)
      .where(eq(roomMembers.roomId, publicRoomId));
    expect(rows.filter(({ actorId }) => actorId === peerPublic.actorId)).toHaveLength(1);
  });

  test("the PostgreSQL fallback converges on one human-only owner DM", async () => {
    const first = await findOrCreateHumanOnlyDirectRoom({
      ownerUserId: fx.ownerId,
      ownerActorId: fx.ownerActorId,
      guestActorId: peerFallback.actorId,
      label: "M259 owner DM",
    });
    const firstId = first.id;
    dynamicRoomIds.push(firstId);

    const second = await findOrCreateHumanOnlyDirectRoom({
      ownerUserId: fx.ownerId,
      ownerActorId: fx.ownerActorId,
      guestActorId: peerFallback.actorId,
      label: "M259 owner DM",
    });
    expect(second.id).toBe(firstId);

    const roster = await fx.db
      .select({ kind: actors.kind, actorId: actors.id })
      .from(roomMembers)
      .innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(eq(roomMembers.roomId, firstId));
    expect(roster).toHaveLength(2);
    expect(roster.every(({ kind }) => kind === "user")).toBe(true);
    expect(roster.map(({ actorId }) => actorId).sort()).toEqual(
      [fx.ownerActorId, peerFallback.actorId].sort(),
    );
  });
});
