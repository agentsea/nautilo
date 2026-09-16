/**
 * D128 — end-to-end mention gating via POST /api/rooms/:roomId/messages.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

// NOTE: do NOT hardcode DB_CONNECTION_STRING / DB_DIRECT_CONNECTION here.
// `setupOwnerAppFixture` → `ensureDatabase()` resolves the connection from
// the active instance bundle (NAUTILO_INSTANCE_ID). Pinning them to a
// specific host/port (previously the protected default instance) split reads
// and writes across two databases when the suite was
// run against another named instance: the fixture seeded users
// in the resolved instance while the app `db` wrote elsewhere, producing a
// recipient_state FK 500. Let the instance resolver decide.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  actors,
  agents,
  and,
  channelIdentities,
  eq,
  groupMembers,
  inArray,
  jobs,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { composeFederatedId, getServerHostname } from "@nautilo/config";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

let fx: AppFixture;
const createJobCalls = { count: 0 };
let agentHandle = "";
let agentActorId = "";
let agentId = "";
let prevTestMode: string | undefined;
let prevTestToken: string | undefined;
const createdRoomIds: string[] = [];
const createdPeerUserIds: string[] = [];

beforeAll(async () => {
  bootstrapTestDbInstance();
  prevTestMode = process.env["NAUTILO_TEST_MODE"];
  prevTestToken = process.env["NAUTILO_TEST_TOKEN"];
  delete process.env["NAUTILO_TEST_MODE"];
  delete process.env["NAUTILO_TEST_TOKEN"];
  createJobCalls.count = 0;
  fx = await setupOwnerAppFixture({
    suiteName: "mgate",
    withDefaultAgentGraph: true,
    createAppExtras: {
      chatRoutesDeps: {
        createForegroundJob: async (_memOwner, requestorId, laneKey, input) => {
          createJobCalls.count += 1;
          const roomId = typeof input["roomId"] === "string" ? input["roomId"] : null;
          const { persistJob } = await import("@nautilo/db");
          const id = await persistJob({
            ownerId: requestorId,
            requestorId,
            laneKey,
            roomId,
            type: "foreground",
            input,
          });
          return { id, virtualJobId: id };
        },
      },
    },
  });

  agentId = fx.defaultAgentId ?? "";
  if (!agentId) throw new Error("default agent");

  const [ag] = await fx.db.select({ handle: agents.handle }).from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!ag) throw new Error("agent row");
  agentHandle = ag.handle;

  const [act] = await fx.db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.agentId, agentId), eq(actors.kind, "agent")))
    .limit(1);
  if (!act) throw new Error("agent actor");
  agentActorId = act.id;
});

afterAll(async () => {
  for (const roomId of createdRoomIds) {
    await cleanupRoom(roomId);
  }
  for (const peerUserId of createdPeerUserIds) {
    const peerActors = await fx.db
      .select({ id: actors.id })
      .from(actors)
      .where(eq(actors.ownerId, peerUserId));
    const peerActorIds = peerActors.map((row) => row.id);
    if (peerActorIds.length > 0) {
      await fx.db.delete(roomMembers).where(inArray(roomMembers.actorId, peerActorIds));
    }
    await fx.db.delete(groupMembers).where(eq(groupMembers.userId, peerUserId));
    await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, peerUserId));
    await fx.db.delete(actors).where(eq(actors.ownerId, peerUserId));
    await fx.db.delete(users).where(eq(users.id, peerUserId));
  }
  if (fx) await fx.cleanup();
  if (prevTestMode === undefined) delete process.env["NAUTILO_TEST_MODE"];
  else process.env["NAUTILO_TEST_MODE"] = prevTestMode;
  if (prevTestToken === undefined) delete process.env["NAUTILO_TEST_TOKEN"];
  else process.env["NAUTILO_TEST_TOKEN"] = prevTestToken;
});

async function createTwoHumanAgentRoom(token: string): Promise<string> {
  const peerHandle = `mgate${Date.now().toString(36).slice(-8)}`;
  const [u] = await fx.db
    .insert(users)
    .values({
      name: "mgate-peer",
      email: `mgate-peer-${Date.now()}@test.local`,
      handle: peerHandle,
      externalId: randomUUID(),
    })
    .returning({ id: users.id });
  if (!u) throw new Error("peer user");
  createdPeerUserIds.push(u.id);

  const [peerActor] = await fx.db
    .insert(actors)
    .values({
      ownerId: u.id,
      displayName: "Peer",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!peerActor) throw new Error("peer actor");

  const ogId = fx.defaultOwnershipGroupId;
  if (!ogId) throw new Error("og");
  const peerFed = composeFederatedId(peerHandle, getServerHostname());
  await fx.db.insert(channelIdentities).values([
    { channel: "tui", externalId: peerFed, userId: u.id, verifiedAt: new Date() },
    { channel: "workbench", externalId: peerFed, userId: u.id, verifiedAt: new Date() },
  ]);
  await fx.db.insert(groupMembers).values({
    groupId: ogId,
    userId: u.id,
    grantedBy: fx.ownerActorId,
  });

  const createRoom = await authedInject(fx.app, {
    method: "POST",
    url: "/api/rooms",
    bearer: token,
    payload: {
      label: "Mention-gate group",
      members: [
        { kind: "user", id: fx.ownerId },
        { kind: "user", id: u.id },
        { kind: "agent", id: agentId },
      ],
    },
  });
  expect(createRoom.statusCode).toBe(201);
  const roomId = (JSON.parse(createRoom.body) as { id: string }).id;
  createdRoomIds.push(roomId);

  const [modeRow] = await fx.db
    .select({ mode: roomMembers.agentResponseMode })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, agentActorId)))
    .limit(1);
  expect(modeRow?.mode).toBe("mention_only");

  return roomId;
}

/** Poll a counter until it reaches `target` (async conductor wake) or time out. */
async function waitForCount(
  read: () => number,
  target: number,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (read() < target) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout ${timeoutMs}ms waiting for count ≥ ${target}; saw ${read()}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function cleanupRoom(roomId: string): Promise<void> {
  const srows = await fx.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.roomId, roomId));
  for (const s of srows) {
    await fx.db.delete(sessionMessages).where(eq(sessionMessages.sessionId, s.id));
  }
  await fx.db.delete(sessions).where(eq(sessions.roomId, roomId));
  await fx.db.delete(jobs).where(eq(jobs.roomId, roomId));
  await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
  await fx.db.delete(rooms).where(eq(rooms.id, roomId));
}

describe("mention gating (D128 dispatch)", () => {
  test("mention_only group: no mention → message persisted, no job", async () => {
    const token = await fx.mintOwnerBearer();
    const roomId = await createTwoHumanAgentRoom(token);
    const j0 = createJobCalls.count;

    const send = await authedInject(fx.app, {
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      bearer: token,
      payload: { content: "what's for dinner?" },
    });
    expect(send.statusCode).toBe(202);
    const body = JSON.parse(send.body) as { messageId: number | null; jobId: string | null };
    expect(body.jobId).toBeNull();
    expect(typeof body.messageId).toBe("number");
    expect(body.messageId).toBeGreaterThan(0);
    expect(createJobCalls.count).toBe(j0);

    const rows = await fx.db
      .select({ id: sessionMessages.id })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
      .where(eq(sessions.roomId, roomId));
    expect(rows.length).toBeGreaterThan(0);

    await cleanupRoom(roomId);
  });

  test("mention_only group: @handle → job fires", async () => {
    const token = await fx.mintOwnerBearer();
    const roomId = await createTwoHumanAgentRoom(token);
    const j0 = createJobCalls.count;

    const send = await authedInject(fx.app, {
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      bearer: token,
      payload: { content: `@${agentHandle} vegan nearby?` },
    });
    expect(send.statusCode).toBe(202);
    // A multi-human room routes through the conductor's optimistic-delivery path
    // (D302 P4 / Stack 24): the human row is persisted + broadcast synchronously
    // (so `jobId` is null on the response) and the addressed bot is woken
    // ASYNCHRONOUSLY. The fired job is observed via the `createForegroundJob`
    // spy, not the response — poll for it rather than reading `body.jobId`.
    const body = JSON.parse(send.body) as { messageId: number | null; jobId: string | null };
    expect(typeof body.messageId).toBe("number");

    await waitForCount(() => createJobCalls.count, j0 + 1);
    expect(createJobCalls.count).toBeGreaterThan(j0);

    await fx.db.delete(jobs).where(eq(jobs.roomId, roomId));
    await cleanupRoom(roomId);
  });

  test("observe mode: @handle does not fire job", async () => {
    const token = await fx.mintOwnerBearer();
    const roomId = await createTwoHumanAgentRoom(token);

    await fx.db
      .update(roomMembers)
      .set({ agentResponseMode: "observe" })
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, agentActorId)));

    const j0 = createJobCalls.count;
    const send = await authedInject(fx.app, {
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      bearer: token,
      payload: { content: `@${agentHandle} hello again` },
    });
    expect(send.statusCode).toBe(202);
    const body = JSON.parse(send.body) as { messageId: number | null; jobId: string | null };
    expect(body.jobId).toBeNull();
    expect(typeof body.messageId).toBe("number");
    expect(createJobCalls.count).toBe(j0);

    await cleanupRoom(roomId);
  });
});
