/**
 * M077 — `/api/sessions/latest` role gate: stranger must not read own DB
 * rows until role is owner/household/teammate (ISSUE-M077 §D.1).
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { hashPin } from "@nautilo/trust";
import { composeFederatedId, getServerHostname } from "@nautilo/config";
import {
  users,
  actors,
  credentials,
  channelIdentities,
  sessions,
  groupMembers,
  roomMembers,
  eq,
  and,
} from "@nautilo/db";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

let fx: AppFixture;

beforeAll(async () => {
  fx = await setupOwnerAppFixture({
    suiteName: "sess-mu",
    withDefaultAgentGraph: true,
  });
});

afterAll(async () => {
  if (!fx) return;
  await fx.cleanup();
});

describe("sessions multi-user (Logto JWT)", () => {
  test("stranger role cannot read transcripts even when a session row exists", async () => {
    const peerPin = "918273";
    const peerHandle = `smpeer${Date.now().toString(36).slice(-8)}`;
    const [u] = await fx.db
      .insert(users)
      .values({
        name: "sess-mu-peer",
        email: `sess-mu-peer-${Date.now()}@test.local`,
        handle: peerHandle,
        externalId: randomUUID(),
      })
      .returning({ id: users.id });
    if (!u) throw new Error("user");
    const [a] = await fx.db
      .insert(actors)
      .values({
        ownerId: u.id,
        displayName: "Peer",
        trustState: "verified",
        kind: "user",
      })
      .returning({ id: actors.id });
    if (!a) throw new Error("actor");
    await fx.db.insert(credentials).values({
      userId: u.id,
      type: "pin",
      value: await hashPin(peerPin),
    });
    const fed = composeFederatedId(peerHandle, getServerHostname());
    await fx.db.insert(channelIdentities).values([
      { channel: "tui", externalId: fed, userId: u.id, verifiedAt: new Date() },
    ]);

    const threadPeer = `sess-mu-peer-thread-${Date.now()}`;
    const [peerSession] = await fx.db
      .insert(sessions)
      .values({
        ownerId: u.id,
        threadId: threadPeer,
        title: "peer",
      })
      .returning({ id: sessions.id });
    if (!peerSession) throw new Error("session");

    const threadOwner = `sess-mu-owner-thread-${Date.now()}`;
    const [ownerSession] = await fx.db
      .insert(sessions)
      .values({
        ownerId: fx.ownerId,
        threadId: threadOwner,
        title: "owner",
      })
      .returning({ id: sessions.id });
    if (!ownerSession) throw new Error("session");

    const tokenPeer = await fx.mintSessionBearerForUser(a.id, u.id);
    const peerLatest = await authedInject(fx.app, {
      method: "GET",
      url: "/api/sessions/latest",
      bearer: tokenPeer,
    });
    expect(peerLatest.statusCode).toBe(200);
    const peerBody = JSON.parse(peerLatest.body) as { session: { id: string } | null };
    expect(peerBody.session).toBeNull();

    const tokenOwner = await fx.mintOwnerBearer();
    const ownerLatest = await authedInject(fx.app, {
      method: "GET",
      url: "/api/sessions/latest",
      bearer: tokenOwner,
    });
    expect(ownerLatest.statusCode).toBe(200);
    const ownerBody = JSON.parse(ownerLatest.body) as { session: { id: string } | null };
    expect(ownerBody.session?.id).toBe(ownerSession.id);

    await fx.db.delete(sessions).where(eq(sessions.id, peerSession.id));
    await fx.db.delete(sessions).where(eq(sessions.id, ownerSession.id));
    await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, u.id));
    await fx.db.delete(credentials).where(eq(credentials.userId, u.id));
    await fx.db.delete(actors).where(eq(actors.ownerId, u.id));
    await fx.db.delete(users).where(eq(users.id, u.id));
  });
});

describe("sessions multi-user — ownership member vs alien room", () => {
  test("member sees own latest session; cannot load owner's room transcript (404)", async () => {
    const fxg = fx;
    const roomId = fxg.defaultRoomId;
    const ogId = fxg.defaultOwnershipGroupId;
    if (!roomId || !ogId) throw new Error("graph");

    const peerHandle = `smugp${Date.now().toString(36).slice(-8)}`;
    const [u] = await fxg.db
      .insert(users)
      .values({
        name: "sess-mug-peer",
        email: `sess-mug-peer-${Date.now()}@test.local`,
        handle: peerHandle,
        externalId: randomUUID(),
      })
      .returning({ id: users.id });
    if (!u) throw new Error("user");
    const [peerActor] = await fxg.db
      .insert(actors)
      .values({
        ownerId: u.id,
        displayName: "Peer",
        trustState: "verified",
        kind: "user",
      })
      .returning({ id: actors.id });
    if (!peerActor) throw new Error("actor");
    const fedPeer = composeFederatedId(peerHandle, getServerHostname());
    await fxg.db.insert(channelIdentities).values([
      { channel: "tui", externalId: fedPeer, userId: u.id, verifiedAt: new Date() },
      { channel: "workbench", externalId: fedPeer, userId: u.id, verifiedAt: new Date() },
    ]);
    await fxg.db.insert(groupMembers).values({
      groupId: ogId,
      userId: u.id,
      grantedBy: fxg.ownerActorId,
    });

    const threadPeer = `sess-mug-peer-${Date.now()}`;
    const [peerSession] = await fxg.db
      .insert(sessions)
      .values({
        ownerId: u.id,
        threadId: threadPeer,
        title: "peer",
      })
      .returning({ id: sessions.id });
    if (!peerSession) throw new Error("session");

    const threadOwner = `sess-mug-owner-${Date.now()}`;
    const [ownerSession] = await fxg.db
      .insert(sessions)
      .values({
        ownerId: fxg.ownerId,
        threadId: threadOwner,
        title: "owner",
      })
      .returning({ id: sessions.id });
    if (!ownerSession) throw new Error("session");

    const tokenPeer = await fxg.mintSessionBearerForUser(peerActor.id, u.id);
    const peerLatest = await authedInject(fxg.app, {
      method: "GET",
      url: "/api/sessions/latest",
      bearer: tokenPeer,
    });
    expect(peerLatest.statusCode).toBe(200);
    const peerBody = JSON.parse(peerLatest.body) as { session: { id: string } | null };
    expect(peerBody.session?.id).toBe(peerSession.id);

    const tokenOwner = await fxg.mintOwnerBearer();
    const ownerLatest = await authedInject(fxg.app, {
      method: "GET",
      url: "/api/sessions/latest",
      bearer: tokenOwner,
    });
    const ownerBody = JSON.parse(ownerLatest.body) as { session: { id: string } | null };
    expect(ownerBody.session?.id).toBe(ownerSession.id);

    const qs =
      "beforeId=1&beforeCreatedAt=" +
      encodeURIComponent("2020-01-01T00:00:00.000Z") +
      "&limit=50";
    const alienRoom = await authedInject(fxg.app, {
      method: "GET",
      url: `/api/rooms/${roomId}/messages?${qs}`,
      bearer: tokenPeer,
    });
    expect(alienRoom.statusCode).toBe(404);

    await fxg.db.delete(sessions).where(eq(sessions.id, peerSession.id));
    await fxg.db.delete(sessions).where(eq(sessions.id, ownerSession.id));
    await fxg.db
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, ogId), eq(groupMembers.userId, u.id)));
    await fxg.db.delete(channelIdentities).where(eq(channelIdentities.userId, u.id));
    await fxg.db.delete(actors).where(eq(actors.ownerId, u.id));
    await fxg.db.delete(users).where(eq(users.id, u.id));
  });

  test("ownership peer in default room can list rooms and load room detail", async () => {
    const fxg = fx;
    const roomId = fxg.defaultRoomId;
    const ogId = fxg.defaultOwnershipGroupId;
    if (!roomId || !ogId) throw new Error("graph");

    const peerHandle = `smugr${Date.now().toString(36).slice(-8)}`;
    const [u] = await fxg.db
      .insert(users)
      .values({
        name: "sess-mug-room-peer",
        email: `sess-mug-room-peer-${Date.now()}@test.local`,
        handle: peerHandle,
        externalId: randomUUID(),
      })
      .returning({ id: users.id });
    if (!u) throw new Error("user");
    const [peerActor] = await fxg.db
      .insert(actors)
      .values({
        ownerId: u.id,
        displayName: "PeerRm",
        trustState: "verified",
        kind: "user",
      })
      .returning({ id: actors.id });
    if (!peerActor) throw new Error("actor");
    const fedPeer = composeFederatedId(peerHandle, getServerHostname());
    await fxg.db.insert(channelIdentities).values([
      { channel: "tui", externalId: fedPeer, userId: u.id, verifiedAt: new Date() },
      { channel: "workbench", externalId: fedPeer, userId: u.id, verifiedAt: new Date() },
    ]);
    await fxg.db.insert(groupMembers).values({
      groupId: ogId,
      userId: u.id,
      grantedBy: fxg.ownerActorId,
    });
    await fxg.db.insert(roomMembers).values({
      roomId,
      actorId: peerActor.id,
      roomRole: "member",
    });

    const tokenPeer = await fxg.mintSessionBearerForUser(peerActor.id, u.id);
    const listRes = await authedInject(fxg.app, {
      method: "GET",
      url: "/api/rooms",
      bearer: tokenPeer,
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.body) as { rooms: Array<{ id: string }> };
    expect(listBody.rooms.some((r) => r.id === roomId)).toBe(true);

    const detailRes = await authedInject(fxg.app, {
      method: "GET",
      url: `/api/rooms/${roomId}`,
      bearer: tokenPeer,
    });
    expect(detailRes.statusCode).toBe(200);

    await fxg.db
      .delete(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, peerActor.id)));
    await fxg.db
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, ogId), eq(groupMembers.userId, u.id)));
    await fxg.db.delete(channelIdentities).where(eq(channelIdentities.userId, u.id));
    await fxg.db.delete(actors).where(eq(actors.ownerId, u.id));
    await fxg.db.delete(users).where(eq(users.id, u.id));
  });
});
