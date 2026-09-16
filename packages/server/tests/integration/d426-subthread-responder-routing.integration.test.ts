/**
 * D426 Task 2.3 — live dispatch proof that a child Room uses ordinary
 * requester-private focus. The legacy durable responder table remains for
 * historical/API compatibility, but live child dispatch must not read or
 * establish it.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  channelIdentities,
  createDirectDb,
  eq,
  ensureDatabase,
  groupMembers,
  groups,
  jobs,
  roomMembers,
  rooms,
  seedTrustPersonal,
  sessionMessages,
  sessions,
  subthreadUserFocus,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { composeFederatedId, getServerHostname } from "@nautilo/config";
import { clearFocus, loadActiveFoci } from "@nautilo/trust";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

let fx: AppFixture;
let createJobCalls = 0;

type CanonicalSeedFixture = { db: ReturnType<typeof createDirectDb>; userId: string };
let canonicalSeed: CanonicalSeedFixture | null = null;

async function ensureCanonicalRbacLadder(): Promise<CanonicalSeedFixture | null> {
  await ensureDatabase();
  const db = createDirectDb(1);
  const [ownersGroup] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "owners"))
    .limit(1);
  if (ownersGroup) {
    await db.end();
    return null;
  }
  const suffix = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
  const [user] = await db
    .insert(users)
    .values({
      name: "D426 canonical seed",
      email: `d426-seed-${suffix}@test.local`,
      handle: `d426seed${suffix}`.slice(0, 48),
      externalId: `d426-seed-${suffix}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("D426 canonical seed user insert failed");
  try {
    await seedTrustPersonal(user.id, "D426 canonical seed");
  } catch (error) {
    await db.delete(users).where(eq(users.id, user.id));
    await db.end();
    throw error;
  }
  return { db, userId: user.id };
}

async function cleanupCanonicalSeedFixture(fixture: CanonicalSeedFixture | null): Promise<void> {
  if (!fixture) return;
  try {
    await fixture.db.delete(groupMembers).where(eq(groupMembers.userId, fixture.userId));
    await fixture.db.delete(channelIdentities).where(eq(channelIdentities.userId, fixture.userId));
    await fixture.db.delete(actors).where(eq(actors.ownerId, fixture.userId));
    await fixture.db.delete(users).where(eq(users.id, fixture.userId));
  } finally {
    await fixture.db.end();
  }
}

async function deleteRoomSessions(fixture: AppFixture, roomId: string): Promise<void> {
  const roomSessions = await fixture.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.roomId, roomId));
  for (const roomSession of roomSessions) {
    await fixture.db.delete(sessionMessages).where(eq(sessionMessages.sessionId, roomSession.id));
    await fixture.db.delete(sessions).where(eq(sessions.id, roomSession.id));
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 6_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  canonicalSeed = await ensureCanonicalRbacLadder();
  fx = await setupOwnerAppFixture({
    suiteName: `d426focus${Date.now().toString(36).slice(-5)}`,
    withDefaultAgentGraph: true,
    createAppExtras: {
      chatRoutesDeps: {
        createForegroundJob: async (_memoryOwner, requestorId, laneKey, input) => {
          createJobCalls += 1;
          const roomId = typeof input["roomId"] === "string" ? input["roomId"] : null;
          const { persistJob } = await import("@nautilo/db");
          const id = await persistJob({ ownerId: requestorId, requestorId, laneKey, roomId, type: "foreground", input });
          return { id, virtualJobId: id };
        },
      },
    },
  });
});

afterAll(async () => {
  try {
    if (fx) await fx.cleanup();
  } finally {
    await cleanupCanonicalSeedFixture(canonicalSeed);
  }
});

describe("D426 child dispatch uses normal Conversational Focus", () => {
  test("first natural root-affinity wake writes child focus and never establishes a durable responder", async () => {
    const agentId = fx.defaultAgentId;
    const ownershipGroupId = fx.defaultOwnershipGroupId;
    if (!agentId || !ownershipGroupId) throw new Error("default agent graph missing");
    const token = await fx.mintOwnerBearer();
    const stamp = Date.now().toString(36);
    let peerUserId: string | null = null;
    let parentRoomId: string | null = null;
    let subthreadRoomId: string | null = null;

    try {
      const peerHandle = `d426p${stamp.slice(-6)}`;
      const [peer] = await fx.db
        .insert(users)
        .values({ name: "D426 peer", email: `d426-peer-${stamp}@test.local`, handle: peerHandle, externalId: randomUUID() })
        .returning({ id: users.id });
      if (!peer) throw new Error("peer user");
      peerUserId = peer.id;
      const [peerActor] = await fx.db
        .insert(actors)
        .values({ ownerId: peer.id, displayName: "D426 peer", trustState: "verified", kind: "user" })
        .returning({ id: actors.id });
      if (!peerActor) throw new Error("peer actor");
      const federatedPeerId = composeFederatedId(peerHandle, getServerHostname());
      await fx.db.insert(channelIdentities).values([
        { channel: "tui", externalId: federatedPeerId, userId: peer.id, verifiedAt: new Date() },
        { channel: "workbench", externalId: federatedPeerId, userId: peer.id, verifiedAt: new Date() },
      ]);
      await fx.db.insert(groupMembers).values({ groupId: ownershipGroupId, userId: peer.id, grantedBy: fx.ownerActorId });

      const createParent = await authedInject(fx.app, {
        method: "POST",
        url: "/api/rooms",
        bearer: token,
        payload: {
          label: `D426 focus ${stamp}`,
          members: [{ kind: "user", id: fx.ownerId }, { kind: "user", id: peer.id }, { kind: "agent", id: agentId }],
        },
      });
      expect(createParent.statusCode).toBe(201);
      parentRoomId = (JSON.parse(createParent.body) as { id: string }).id;

      const [agent] = await fx.db
        .select({ actorId: actors.id })
        .from(actors)
        .innerJoin(agents, eq(actors.agentId, agents.id))
        .where(eq(actors.agentId, agentId))
        .limit(1);
      if (!agent) throw new Error("agent actor");
      const [session] = await fx.db
        .insert(sessions)
        .values({ threadId: `room:${parentRoomId}:d426-anchor`, ownerId: fx.ownerId, personaId: "owner", agentId, roomId: parentRoomId, channel: "tui" })
        .returning({ id: sessions.id });
      if (!session) throw new Error("anchor session");
      const [anchor] = await fx.db
        .insert(sessionMessages)
        .values({ sessionId: session.id, role: "assistant", content: "Genie root" })
        .returning({ id: sessionMessages.id });
      if (!anchor) throw new Error("anchor message");

      const createChild = await authedInject(fx.app, {
        method: "POST",
        url: `/api/rooms/${parentRoomId}/messages/${anchor.id}/subthreads`,
        bearer: token,
        payload: { label: "D426 child" },
      });
      expect(createChild.statusCode).toBe(201);
      subthreadRoomId = (JSON.parse(createChild.body) as { subthreadRoomId: string }).subthreadRoomId;

      const firstJobCount = createJobCalls;
      const firstChildTurn = await authedInject(fx.app, {
        method: "POST",
        url: `/api/rooms/${subthreadRoomId}/messages`,
        bearer: token,
        payload: { content: "Please continue this thought." },
      });
      expect(firstChildTurn.statusCode).toBe(202);
      await waitFor(() => createJobCalls === firstJobCount + 1, "root-affinity child wake");
      await waitFor(async () => {
        const foci = await loadActiveFoci(fx.db, subthreadRoomId!, fx.ownerActorId, new Date());
        return foci.some((focus) => focus.botActorId === agent.actorId);
      }, "normal child focus write");

      const responderRows = await fx.db
        .select({ botActorId: subthreadUserFocus.botActorId })
        .from(subthreadUserFocus)
        .where(eq(subthreadUserFocus.subthreadRoomId, subthreadRoomId));
      expect(responderRows).toEqual([]);

      // Clear the normal focus. A later ordinary child turn is no longer the
      // first visible reply, so root affinity must not fire a second time.
      const [activeFocus] = await loadActiveFoci(
        fx.db,
        subthreadRoomId,
        fx.ownerActorId,
        new Date(),
      );
      if (!activeFocus) throw new Error("expected child focus");
      await clearFocus(fx.db, {
        roomId: subthreadRoomId,
        userActorId: fx.ownerActorId,
        focusId: activeFocus.focusId,
        now: new Date(),
      });

      const secondJobCount = createJobCalls;
      const secondChildTurn = await authedInject(fx.app, {
        method: "POST",
        url: `/api/rooms/${subthreadRoomId}/messages`,
        bearer: token,
        payload: { content: "And what does that imply?" },
      });
      expect(secondChildTurn.statusCode).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(createJobCalls).toBe(secondJobCount);
      expect(await fx.db.select().from(subthreadUserFocus).where(eq(subthreadUserFocus.subthreadRoomId, subthreadRoomId))).toEqual([]);
    } finally {
      if (subthreadRoomId) {
        await deleteRoomSessions(fx, subthreadRoomId);
        await fx.db.delete(jobs).where(eq(jobs.roomId, subthreadRoomId));
        await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, subthreadRoomId));
        await fx.db.delete(rooms).where(eq(rooms.id, subthreadRoomId));
      }
      if (parentRoomId) {
        await deleteRoomSessions(fx, parentRoomId);
        await fx.db.delete(jobs).where(eq(jobs.roomId, parentRoomId));
        await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, parentRoomId));
        await fx.db.delete(rooms).where(eq(rooms.id, parentRoomId));
      }
      if (peerUserId) {
        await fx.db.delete(groupMembers).where(eq(groupMembers.userId, peerUserId));
        await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, peerUserId));
        await fx.db.delete(actors).where(eq(actors.ownerId, peerUserId));
        await fx.db.delete(users).where(eq(users.id, peerUserId));
      }
    }
  });
});
