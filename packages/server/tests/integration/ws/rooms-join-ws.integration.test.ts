/**
 * M124 — Blast-Radius scenario 18: a real WS subscriber on `room:<id>`
 * receives `room_members_changed` when another user self-joins the open room.
 *
 * The hermetic route unit test (`rooms-routes-m124.test.ts`) only proves
 * `publishRoomMembersChanged` is *called*; this pins the actual wire fan-out
 * end-to-end (HTTP join → ws-publisher → connected client).
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect } from "bun:test";
import {
  deviceAdmissionChallengeResponseSchema,
  deviceAdmissionProofResponseSchema,
} from "@nautilo/api-client";
import { hashPin } from "@nautilo/trust";
import { composeFederatedId, getServerHostname } from "@nautilo/config";
import {
  users,
  actors,
  credentials,
  channelIdentities,
  createPostgresJsBridgeConnection,
  encryptionTransitionPolicy,
  getSharedDirectCryptoDb,
  nautiloInstanceIdentity,
  rooms,
  roomMembers,
  namespaces,
  sessions,
  sessionMessages,
  eq,
  inArray,
  feedEvents,
  sql,
} from "@nautilo/db";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  createDeviceAdmissionProof,
  deviceAdmissionChallengeFromDto,
  deviceAdmissionProofToDto,
} from "@nautilo/lattice-bridge";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@nautilo/db/schema";
import { setupOwnerAppFixture } from "../helpers/app-fixture";
import {
  seedBackfillDevice,
  type BackfillDeviceCustodyFixture,
} from "../helpers/message-backfill-custody";
import { withListeningServer, authedInject } from "../helpers/request-helpers";
import { connectWsTestClient, httpBaseToWsUrl } from "./helpers/ws-test-client";

async function deleteRoomAndNamespace(
  db: Awaited<ReturnType<typeof setupOwnerAppFixture>>["db"],
  roomId: string,
): Promise<void> {
  await db.delete(feedEvents).where(eq(sql<string>`${feedEvents.data}->>'roomId'`, roomId));
  const [row] = await db
    .select({ namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  // Join/leave append room system messages, which create `sessions` rows
  // referencing the room (sessions.room_id FK). Clear them before the room.
  const sessionRows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.roomId, roomId));
  const sessionIds = sessionRows.map((s) => s.id);
  if (sessionIds.length > 0) {
    await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessionIds));
    await db.delete(sessions).where(inArray(sessions.id, sessionIds));
  }
  await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
  await db.delete(rooms).where(eq(rooms.id, roomId));
  if (row?.namespaceId) {
    await db.delete(namespaces).where(eq(namespaces.id, row.namespaceId));
  }
}

interface RoomMembersChangedFrame {
  type: "room_members_changed";
  roomId: string;
  event: { kind: string; actorId?: string };
  recipientSyncNamespaceId?: string;
}

function isRoomMembersChangedFor(
  roomId: string,
): (e: unknown) => e is RoomMembersChangedFrame {
  return (e: unknown): e is RoomMembersChangedFrame =>
    typeof e === "object" &&
    e !== null &&
    (e as { type?: unknown }).type === "room_members_changed" &&
    (e as { roomId?: unknown }).roomId === roomId;
}

async function admitDevice(input: Readonly<{
  app: Awaited<ReturnType<typeof setupOwnerAppFixture>>["app"];
  bearer: string;
  device: BackfillDeviceCustodyFixture;
  crypto: LatticeCrypto;
}>): Promise<void> {
  const challengeResponse = await authedInject(input.app, {
    method: "POST",
    url: "/api/crypto-device-admission/challenge",
    bearer: input.bearer,
    payload: {
      requestVersion: 1,
      deviceId: input.device.deviceId,
    },
  });
  expect(challengeResponse.statusCode).toBe(200);
  const challenge = deviceAdmissionChallengeResponseSchema.parse(
    JSON.parse(challengeResponse.body),
  ).challenge;
  const proof = createDeviceAdmissionProof({
    crypto: input.crypto,
    challenge: deviceAdmissionChallengeFromDto(challenge),
    signingPrivateKey: input.device.signing.privateKey,
  });
  const proofResponse = await authedInject(input.app, {
    method: "POST",
    url: "/api/crypto-device-admission/proof",
    bearer: input.bearer,
    payload: {
      requestVersion: 1,
      proof: deviceAdmissionProofToDto(proof),
    },
  });
  expect(proofResponse.statusCode).toBe(200);
  deviceAdmissionProofResponseSchema.parse(JSON.parse(proofResponse.body));
}

describe("/ws — open-room self-join fan-out (M124 scenario 18)", () => {
  test("a Full-mode peer join carries the public Room's protected convergence hint", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "rjws" });
    const adminUrl = process.env["LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL"];
    if (!adminUrl) {
      await fx.cleanup();
      throw new Error("Explicit disposable integration admin database is required");
    }
    const adminClient = postgres(adminUrl, { max: 1, prepare: false });
    const adminDb = drizzle(adminClient, { schema });
    const crypto = new LatticeCrypto();
    const restricted = createPostgresJsBridgeConnection(getSharedDirectCryptoDb());
    const devices: BackfillDeviceCustodyFixture[] = [];
    let openRoomId: string | null = null;
    let openNamespaceId: string | null = null;
    let peerUserId: string | null = null;
    let peerActorId: string | null = null;
    let restoreEncryptionPolicy: (() => Promise<void>) | null = null;
    try {
      const adminToken = await fx.mintOwnerBearer();
      const [identity] = await adminDb
        .select({ serverInstanceId: nautiloInstanceIdentity.serverInstanceId })
        .from(nautiloInstanceIdentity)
        .where(eq(nautiloInstanceIdentity.id, "self"))
        .limit(1);
      if (!identity) throw new Error("server identity");
      const ownerDevice = await seedBackfillDevice({
        adminDb,
        restricted,
        crypto,
        userId: fx.ownerId,
        humanActorId: fx.ownerActorId,
        serverInstanceId: identity.serverInstanceId,
      });
      devices.push(ownerDevice);
      await admitDevice({
        app: fx.app,
        bearer: adminToken,
        device: ownerDevice,
        crypto,
      });

      // Admin creates the open room (owner is now a member → its WS client
      // will be subscribed to the room lane on connect).
      const createRes = await authedInject(fx.app, {
        method: "POST",
        url: "/api/rooms",
        bearer: adminToken,
        payload: { label: "#ws-fanout", kind: "open" },
      });
      expect(createRes.statusCode).toBe(201);
      openRoomId = (JSON.parse(createRes.body) as { id: string }).id;
      const [openRoom] = await fx.db
        .select({ namespaceId: rooms.namespaceId })
        .from(rooms)
        .where(eq(rooms.id, openRoomId))
        .limit(1);
      if (!openRoom) throw new Error("open room");
      openNamespaceId = openRoom.namespaceId;

      const [previousPolicy] = await fx.db
        .select({
          mode: encryptionTransitionPolicy.mode,
          shadowBehavior: encryptionTransitionPolicy.shadowBehavior,
          shadowEncryptionStartedAt: encryptionTransitionPolicy.shadowEncryptionStartedAt,
        })
        .from(encryptionTransitionPolicy)
        .where(eq(encryptionTransitionPolicy.id, "server"))
        .limit(1);
      if (!previousPolicy) throw new Error("encryption transition policy");
      await fx.db
        .update(encryptionTransitionPolicy)
        .set({
          mode: "encrypted_only",
          shadowEncryptionStartedAt: previousPolicy.shadowEncryptionStartedAt ?? new Date(),
        })
        .where(eq(encryptionTransitionPolicy.id, "server"));
      restoreEncryptionPolicy = async () => {
        await fx.db
          .update(encryptionTransitionPolicy)
          .set(previousPolicy)
          .where(eq(encryptionTransitionPolicy.id, "server"));
      };

      // Seed a non-admin peer + bearer.
      const peerHandle = `rjwspeer${Date.now().toString(36).slice(-8)}`;
      const [u] = await fx.db
        .insert(users)
        .values({
          name: "rjws-peer",
          email: `rjws-peer-${Date.now()}@test.local`,
          handle: peerHandle,
          externalId: randomUUID(),
        })
        .returning({ id: users.id });
      if (!u) throw new Error("user");
      peerUserId = u.id;
      const [a] = await fx.db
        .insert(actors)
        .values({ ownerId: u.id, displayName: "Peer", trustState: "verified", kind: "user" })
        .returning({ id: actors.id });
      if (!a) throw new Error("actor");
      peerActorId = a.id;
      await fx.db
        .insert(credentials)
        .values({ userId: u.id, type: "pin", value: await hashPin("918273") });
      const fed = composeFederatedId(peerHandle, getServerHostname());
      await fx.db
        .insert(channelIdentities)
        .values([{ channel: "tui", externalId: fed, userId: u.id, verifiedAt: new Date() }]);
      const peerToken = await fx.mintSessionBearerForUser(a.id, u.id);
      const peerDevice = await seedBackfillDevice({
        adminDb,
        restricted,
        crypto,
        userId: u.id,
        humanActorId: a.id,
        serverInstanceId: identity.serverInstanceId,
      });
      devices.push(peerDevice);
      await admitDevice({
        app: fx.app,
        bearer: peerToken,
        device: peerDevice,
        crypto,
      });

      await withListeningServer(fx.app, async (base) => {
        const wsUrl = httpBaseToWsUrl(base, "/ws");
        // Owner connects AFTER the room exists → subscribed to room:<id>.
        const ownerClient = await connectWsTestClient({ url: wsUrl, token: adminToken });
        const secondSession = await connectWsTestClient({ url: wsUrl, token: adminToken });
        const isFeedChanged = (event: unknown): event is { type: "event_feed.changed" } =>
          typeof event === "object" && event !== null && "type" in event && event.type === "event_feed.changed";

        const joinRes = await authedInject(fx.app, {
          method: "POST",
          url: `/api/rooms/${openRoomId}/join`,
          bearer: peerToken,
          payload: {},
        });
        expect(joinRes.statusCode).toBe(200);

        const frame = await ownerClient.waitForEvent(
          isRoomMembersChangedFor(openRoomId as string),
          8_000,
        );
        expect(frame.event.kind).toBe("member_added");
        expect(frame.event.actorId).toBe(peerActorId as string);
        expect(frame.recipientSyncNamespaceId).toBe(openNamespaceId as string);

        expect(await ownerClient.waitForEvent(isFeedChanged)).toEqual({ type: "event_feed.changed" });
        expect(await secondSession.waitForEvent(isFeedChanged)).toEqual({ type: "event_feed.changed" });
        ownerClient.events.length = 0;
        secondSession.events.length = 0;
        const marked = await authedInject(fx.app, { method: "POST", url: "/api/event-feed/mark-all-read", bearer: adminToken, payload: {} });
        expect(marked.statusCode).toBe(200);
        expect(await ownerClient.waitForEvent(isFeedChanged)).toEqual({ type: "event_feed.changed" });
        expect(await secondSession.waitForEvent(isFeedChanged)).toEqual({ type: "event_feed.changed" });
        const count = await authedInject(fx.app, { method: "GET", url: "/api/event-feed/unread-count", bearer: adminToken });
        expect(JSON.parse(count.body)).toEqual({ unreadCount: 0 });
        await secondSession.close();
        await ownerClient.close();
      });
    } finally {
      if (restoreEncryptionPolicy) await restoreEncryptionPolicy();
      if (openRoomId) await deleteRoomAndNamespace(fx.db, openRoomId);
      for (const device of devices.reverse()) await device.cleanup();
      if (peerUserId) {
        await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, peerUserId));
        await fx.db.delete(credentials).where(eq(credentials.userId, peerUserId));
        if (peerActorId) await fx.db.delete(actors).where(eq(actors.id, peerActorId));
        await fx.db.delete(users).where(eq(users.id, peerUserId));
      }
      await adminClient.end();
      await fx.cleanup();
    }
  });
});
