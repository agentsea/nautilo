/**
 * D174 MR6 — `POST /api/rooms/:roomId/messages` (Phase 11.1 dispatcher).
 *
 * Covers MR6 cases (a)–(f) plus separate (b) job enqueue and (g) alias parity.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  actors,
  agents,
  channelIdentities,
  credentials,
  eq,
  groupMembers,
  jobs,
  messageAttachments,
  profiles,
  roomMembers,
  rooms,
  sessionMessageRecipientState,
  sessionMessages,
  sessions,
  users,
} from "@nautilo/db";
import { composeFederatedId, getServerHostname } from "@nautilo/config";
import { eventBus } from "@nautilo/runtime";
import type { ServerEvent } from "@nautilo/types";
import {
  seatPeerUser,
  setupOwnerAppFixture,
  type AppFixture,
} from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

let fx: AppFixture;
const createJobCalls: { count: number } = { count: 0 };
const lastJobInput: { value: Record<string, unknown> | null } = { value: null };
const messageNewEvents: ServerEvent[] = [];

function captureMessageNew(ev: ServerEvent): void {
  if (ev.type === "message.new") {
    messageNewEvents.push(ev);
  }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number = 6_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("condition timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  createJobCalls.count = 0;
  messageNewEvents.length = 0;
  eventBus.on(captureMessageNew);
  fx = await setupOwnerAppFixture({
    suiteName: "msgrt",
    withDefaultAgentGraph: true,
    createAppExtras: {
      chatRoutesDeps: {
        createForegroundJob: async (_memOwner, requestorId, laneKey, input) => {
          createJobCalls.count += 1;
          lastJobInput.value = input;
          const roomId = typeof input["roomId"] === "string" ? input["roomId"] : null;
          const { persistJob } = await import("@nautilo/db");
          const id = await persistJob({
            ownerId: requestorId,
            requestorId: requestorId,
            laneKey,
            roomId,
            type: "foreground",
            input: input,
          });
          return { id, virtualJobId: id };
        },
      },
    },
  });
});

afterAll(async () => {
  eventBus.off(captureMessageNew);
  if (!fx) return;
  await fx.cleanup();
});

describe("POST /api/rooms/:roomId/messages (D174 Phase 11.1)", () => {
  test("human-only room: 201, persist, no foreground job, message.new emitted", async () => {
    const beforeJobs = createJobCalls.count;
    const peerHandle = `msgrt${Date.now().toString(36).slice(-8)}`;
    const [u] = await fx.db
      .insert(users)
      .values({
        name: "msgrt-peer",
        email: `msgrt-peer-${Date.now()}@test.local`,
        handle: peerHandle,
        externalId: randomUUID(),
      })
      .returning({ id: users.id });
    if (!u) throw new Error("user");
    const [peerActor] = await fx.db
      .insert(actors)
      .values({
        ownerId: u.id,
        displayName: "Peer",
        trustState: "verified",
        kind: "user",
      })
      .returning({ id: actors.id });
    if (!peerActor) throw new Error("actor");
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

    const token = await fx.mintOwnerBearer();
    const createRoom = await authedInject(fx.app, {
      method: "POST",
      url: "/api/rooms",
      bearer: token,
      payload: {
        label: "Human-only",
        members: [
          { kind: "user", id: fx.ownerId },
          { kind: "user", id: u.id },
        ],
      },
    });
    expect(createRoom.statusCode).toBe(201);
    const humanRoomId = (JSON.parse(createRoom.body) as { id: string }).id;

    const nBefore = messageNewEvents.length;
    const send = await authedInject(fx.app, {
      method: "POST",
      url: `/api/rooms/${humanRoomId}/messages`,
      bearer: token,
      payload: { content: "hello peers" },
    });
    expect(send.statusCode).toBe(201);
    const body = JSON.parse(send.body) as {
      messageId: number;
      jobId: string | null;
      accepted: boolean;
      coalesced: boolean;
    };
    expect(body.jobId).toBeNull();
    expect(body.accepted).toBe(true);
    expect(body.coalesced).toBe(true);
    expect(typeof body.messageId).toBe("number");
    expect(body.messageId).toBeGreaterThan(0);
    expect(createJobCalls.count).toBe(beforeJobs);

    const recent = messageNewEvents.slice(nBefore);
    const hit = recent.find(
      (e) =>
        e.type === "message.new" &&
        (e as { laneKey?: string }).laneKey === `room:${humanRoomId}` &&
        Number((e as { messageId?: string }).messageId) === body.messageId,
    );
    expect(hit).toBeDefined();
    expect((hit as { senderUserId?: string }).senderUserId).toBe(fx.ownerId);

    const rs = await fx.db
      .select()
      .from(sessionMessageRecipientState)
      .where(eq(sessionMessageRecipientState.messageId, body.messageId));
    expect(rs.length).toBe(1);
    expect(rs[0]?.recipientId).toBe(u.id);
    expect(rs[0]?.readAt).toBeNull();
    expect(rs[0]?.deliveredAt).not.toBeNull();

    await fx.db
      .delete(sessionMessageRecipientState)
      .where(eq(sessionMessageRecipientState.messageId, body.messageId));
    const srows = await fx.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.roomId, humanRoomId))
      .limit(20);
    for (const s of srows) {
      await fx.db.delete(sessionMessages).where(eq(sessionMessages.sessionId, s.id));
      await fx.db.delete(sessions).where(eq(sessions.id, s.id));
    }
    await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, humanRoomId));
    await fx.db.delete(rooms).where(eq(rooms.id, humanRoomId));
    await fx.db.delete(roomMembers).where(eq(roomMembers.actorId, peerActor.id));
    await fx.db.delete(groupMembers).where(eq(groupMembers.userId, u.id));
    await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, u.id));
    await fx.db.delete(actors).where(eq(actors.ownerId, u.id));
    await fx.db.delete(users).where(eq(users.id, u.id));
  });

  test("agent-mediated room: sender is human → foreground job is created", async () => {
    const roomId = fx.defaultRoomId;
    if (!roomId) throw new Error("room");
    const token = await fx.mintOwnerBearer();
    const j0 = createJobCalls.count;
    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      bearer: token,
      payload: { content: "agent path job" },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body) as { jobId: string | null };
    expect(typeof body.jobId).toBe("string");
    expect(createJobCalls.count).toBeGreaterThan(j0);
    await fx.db.delete(jobs).where(eq(jobs.roomId, roomId));
  });

  test("Guest ordinary text and attachments in a mixed Human/Agent room persist without starting Agent work", async () => {
    const roomId = fx.defaultRoomId;
    if (!roomId) throw new Error("room");
    const guest = await seatPeerUser(fx.db, {
      suiteName: "msgrt",
      groupType: "guests",
    });
    await fx.db.insert(roomMembers).values({
      roomId,
      actorId: guest.actorId,
      roomRole: "member",
    });
    await fx.db
      .update(rooms)
      .set({ humanActorIds: [fx.ownerActorId, guest.actorId] })
      .where(eq(rooms.id, roomId));

    let messageId: number | null = null;
    let attachmentId: string | null = null;
    try {
      const pngBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      const jobsBefore = createJobCalls.count;
      const eventsBefore = messageNewEvents.length;
      const guestBearer = await fx.mintSessionBearerForUser(
        guest.actorId,
        guest.userId,
      );
      const form = new FormData();
      form.set(
        "file",
        new Blob([pngBytes], { type: "image/png" }),
        "guest-screen.png",
      );
      const upload = await fx.app.inject({
        method: "POST",
        url: `/api/message-attachments?roomId=${roomId}`,
        headers: { authorization: `Bearer ${guestBearer}` },
        payload: form,
      });
      expect(upload.statusCode).toBe(200);
      attachmentId = (JSON.parse(upload.body) as { attachmentId: string }).attachmentId;
      const send = await authedInject(fx.app, {
        method: "POST",
        url: `/api/rooms/${roomId}/messages`,
        bearer: guestBearer,
        payload: {
          content: "ordinary guest history",
          attachments: [{ attachmentId }],
        },
      });
      expect(send.statusCode).toBe(201);
      const body = JSON.parse(send.body) as {
        messageId: number;
        jobId: string | null;
        accepted: boolean;
      };
      messageId = body.messageId;
      expect(body).toMatchObject({ jobId: null, accepted: true });
      expect((body as { attachments?: Array<{ id: string; decision: string }> }).attachments)
        .toEqual([expect.objectContaining({ id: attachmentId, decision: "accept" })]);
      expect(createJobCalls.count).toBe(jobsBefore);

      const [persisted] = await fx.db
        .select({
          id: sessionMessages.id,
          content: sessionMessages.content,
        })
        .from(sessionMessages)
        .where(eq(sessionMessages.id, body.messageId));
      expect(persisted?.id).toBe(body.messageId);
      expect(persisted?.content).toEndWith("ordinary guest history");
      const event = messageNewEvents.slice(eventsBefore).find(
        (candidate) =>
          candidate.type === "message.new" &&
          Number((candidate as { messageId?: string }).messageId) === body.messageId,
      );
      expect((event as { senderUserId?: string } | undefined)?.senderUserId).toBe(
        guest.userId,
      );
      const expectedAttachment = {
        attachmentId,
        filename: "guest-screen.png",
        mimeType: "image/png",
        sizeBytes: pngBytes.byteLength,
      };
      expect(event).toMatchObject({ attachments: [expectedAttachment] });

      // Observe the live projection first, then prove history names the exact
      // same retained row for another authorized Room member.
      const ownerBearer = await fx.mintOwnerBearer();
      const history = await authedInject(fx.app, {
        method: "GET",
        url: `/api/rooms/${roomId}/messages?beforeId=${body.messageId + 1}&beforeCreatedAt=${encodeURIComponent("2999-01-01T00:00:00.000Z")}&limit=50`,
        bearer: ownerBearer,
      });
      expect(history.statusCode).toBe(200);
      const historyMessage = (JSON.parse(history.body) as {
        messages: Array<{ id: string; attachments?: unknown[] }>;
      }).messages.find((candidate) => Number(candidate.id) === body.messageId);
      expect(historyMessage?.attachments).toEqual([expectedAttachment]);

      if (!fx.defaultAgentId) throw new Error("default agent missing");
      const [agent] = await fx.db
        .select({ handle: agents.handle })
        .from(agents)
        .where(eq(agents.id, fx.defaultAgentId));
      if (!agent?.handle) throw new Error("default agent handle missing");
      const explicitContent = `@${agent.handle} answer this`;
      const explicit = await authedInject(fx.app, {
        method: "POST",
        url: `/api/rooms/${roomId}/messages`,
        bearer: guestBearer,
        payload: { content: explicitContent },
      });
      expect(explicit.statusCode).toBe(403);
      expect(JSON.parse(explicit.body)).toEqual({
        error: "invoke_agents_required",
        code: "invoke_agents_required",
        capability: "invoke_agents",
      });
      expect(createJobCalls.count).toBe(jobsBefore);
      const deniedRows = await fx.db
        .select({ id: sessionMessages.id })
        .from(sessionMessages)
        .where(eq(sessionMessages.content, explicitContent));
      expect(deniedRows).toEqual([]);
    } finally {
      if (messageId !== null) {
        await fx.db
          .delete(sessionMessageRecipientState)
          .where(eq(sessionMessageRecipientState.messageId, messageId));
        await fx.db.delete(sessionMessages).where(eq(sessionMessages.id, messageId));
      }
      if (attachmentId !== null) {
        await fx.db.delete(messageAttachments).where(eq(messageAttachments.id, attachmentId));
      }
      await fx.db
        .update(rooms)
        .set({ humanActorIds: [fx.ownerActorId] })
        .where(eq(rooms.id, roomId));
      const guestSessions = await fx.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.ownerId, guest.userId));
      for (const session of guestSessions) {
        await fx.db
          .delete(sessionMessages)
          .where(eq(sessionMessages.sessionId, session.id));
        await fx.db.delete(sessions).where(eq(sessions.id, session.id));
      }
      await fx.db.delete(roomMembers).where(eq(roomMembers.actorId, guest.actorId));
      await fx.db.delete(profiles).where(eq(profiles.userId, guest.userId));
      await fx.db.delete(actors).where(eq(actors.ownerId, guest.userId));
      await fx.db.delete(agents).where(eq(agents.id, guest.agentId));
      await fx.db.delete(groupMembers).where(eq(groupMembers.userId, guest.userId));
      await fx.db
        .delete(channelIdentities)
        .where(eq(channelIdentities.userId, guest.userId));
      await fx.db.delete(credentials).where(eq(credentials.userId, guest.userId));
      await fx.db.delete(users).where(eq(users.id, guest.userId));
    }
  });

  test("agent-mediated room: rapid same-sender sends coalesce into one async wake", async () => {
    const roomId = fx.defaultRoomId;
    if (!roomId) throw new Error("room");
    const token = await fx.mintOwnerBearer();
    const j0 = createJobCalls.count;

    const sends = [];
    for (let i = 0; i < 5; i += 1) {
      sends.push(
        await authedInject(fx.app, {
          method: "POST",
          url: `/api/rooms/${roomId}/messages`,
          bearer: token,
          payload: { content: `coalesced thought ${i + 1}` },
        }),
      );
    }

    for (const res of sends) {
      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body) as { jobId: string | null };
      expect(typeof body.jobId).toBe("string");
    }

    expect(createJobCalls.count - j0).toBe(5);
    expect(lastJobInput.value?.["message"]).toBe("coalesced thought 5");

    await fx.db.delete(jobs).where(eq(jobs.roomId, roomId));
  });

  // M155 regression guard — D300 swapped the turn's authorization envelope
  // from the human sender's actor to the responding agent's actor. An agent
  // actor has no capability subject (the M128/M133 capability model is
  // human-keyed), so `buildEnvelope` collapsed `toolPolicy` to the guest
  // 5-set and the owner lost `task`/`file`/`search_memory`/etc. This asserts
  // the owner's turn carries the FULL capability-derived policy.
  test("agent-mediated owner turn binds the owner's capability tool policy, not the guest 5-set (M155)", async () => {
    const roomId = fx.defaultRoomId;
    if (!roomId) throw new Error("room");
    const token = await fx.mintOwnerBearer();
    lastJobInput.value = null;
    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      bearer: token,
      payload: { content: "owner tool policy check" },
    });
    expect(res.statusCode).toBe(202);
    await waitForCondition(() => lastJobInput.value !== null);

    const input = lastJobInput.value;
    expect(input).not.toBeNull();
    const envelope = input?.["memoryAccessEnvelope"] as
      | { ownerId?: string; toolPolicy?: Record<string, string> }
      | undefined;
    expect(envelope).toBeDefined();
    const toolPolicy = envelope?.toolPolicy ?? {};

    // The envelope subject is the human owner, not the server-owner fallback
    // or a capability-less agent.
    expect(envelope?.ownerId).toBe(fx.ownerId);

    // Standard owner tools must NOT be forbidden — this is the regression seam.
    for (const tool of ["task", "in_background", "schedule", "file", "search_memory"]) {
      expect(toolPolicy[tool]).toBeDefined();
      expect(toolPolicy[tool]).not.toBe("forbidden");
    }

    // Sanity: a guest policy would forbid `task`; an owner policy allows it.
    expect(toolPolicy["task"]).toBe("allow");

    await fx.db.delete(jobs).where(eq(jobs.roomId, roomId));
  });

  test("MR6 (g): POST /api/chat (deprecated alias) vs canonical room route — same side-effects, distinct response shapes (D174 Phase 11.2)", async () => {
    const roomId = fx.defaultRoomId;
    if (!roomId) throw new Error("room");
    const token = await fx.mintOwnerBearer();
    const jBefore = createJobCalls.count;
    const viaChat = await authedInject(fx.app, {
      method: "POST",
      url: "/api/chat",
      bearer: token,
      payload: { message: "alias-equiv-body", roomId },
    });
    const jMid = createJobCalls.count;
    const viaRoom = await authedInject(fx.app, {
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      bearer: token,
      payload: { content: "alias-equiv-body" },
    });
    const jAfter = createJobCalls.count;
    expect(viaChat.statusCode).toBe(202);
    expect(viaRoom.statusCode).toBe(202);
    expect(jMid).toBe(jBefore + 1);
    expect(jAfter).toBe(jBefore + 2);

    const alias = JSON.parse(viaChat.body) as {
      jobId: string | null;
      laneKey: string;
      accepted?: boolean;
      attachments?: unknown[];
      coalesced?: boolean;
      messageId?: unknown;
    };
    const canonical = JSON.parse(viaRoom.body) as {
      messageId: number | null;
      jobId: string | null;
      accepted: boolean;
      attachments?: unknown[];
      coalesced: boolean;
      laneKey?: string;
    };

    // Alias preserves legacy `SendMessageResponse` (no `messageId` field).
    expect(alias.messageId).toBeUndefined();
    expect(alias.laneKey).toBe(`room:${roomId}`);
    // Optimistic delivery returns before async conductor/wake work produces jobs.
    // The two same-sender sends may coalesce into one later wake.
    expect(typeof alias.jobId).toBe("string");
    expect(typeof canonical.jobId).toBe("string");
    expect(alias.coalesced).toBe(canonical.coalesced);
    expect(alias.attachments).toEqual(canonical.attachments);
    expect(alias.accepted).toBe(true);

    // Canonical MR1 union shape (includes `messageId`; agent path may be null until async persist).
    expect("messageId" in canonical).toBe(true);
    expect(canonical.accepted).toBe(true);
    expect(canonical.laneKey).toBeUndefined();

    await fx.db.delete(jobs).where(eq(jobs.roomId, roomId));
  });

  test("non-member gets 404 when room exists (existence is not revealed)", async () => {
    const roomId = fx.defaultRoomId;
    if (!roomId) throw new Error("room");
    const peerHandle = `msgrt403${Date.now().toString(36).slice(-6)}`;
    const [u] = await fx.db
      .insert(users)
      .values({
        name: "msgrt-alien",
        email: `msgrt-alien-${Date.now()}@test.local`,
        handle: peerHandle,
        externalId: randomUUID(),
      })
      .returning({ id: users.id });
    if (!u) throw new Error("user");
    const [peerActor] = await fx.db
      .insert(actors)
      .values({
        ownerId: u.id,
        displayName: "Alien",
        trustState: "verified",
        kind: "user",
      })
      .returning({ id: actors.id });
    if (!peerActor) throw new Error("actor");
    const peerFed = composeFederatedId(peerHandle, getServerHostname());
    await fx.db.insert(channelIdentities).values([
      { channel: "tui", externalId: peerFed, userId: u.id, verifiedAt: new Date() },
      { channel: "workbench", externalId: peerFed, userId: u.id, verifiedAt: new Date() },
    ]);
    const alienToken = await fx.mintSessionBearerForUser(peerActor.id, u.id);
    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      bearer: alienToken,
      payload: { content: "nope" },
    });
    // Information-hiding contract: a non-member is NOT told the room
    // exists. The route returns 404 (not 403) so room existence isn't
    // leaked to outsiders.
    expect(res.statusCode).toBe(404);
    await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, u.id));
    await fx.db.delete(actors).where(eq(actors.ownerId, u.id));
    await fx.db.delete(users).where(eq(users.id, u.id));
  });

  test("unknown room UUID returns 404", async () => {
    const token = await fx.mintOwnerBearer();
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/rooms/${id}/messages`,
      bearer: token,
      payload: { content: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  test("replyToMessageId in different room returns 400", async () => {
    const token = await fx.mintOwnerBearer();
    const r1 = await authedInject(fx.app, {
      method: "POST",
      url: "/api/rooms",
      bearer: token,
      payload: {
        label: "R1",
        members: [{ kind: "user", id: fx.ownerId }],
      },
    });
    expect(r1.statusCode).toBe(201);
    const room1 = (JSON.parse(r1.body) as { id: string }).id;
    const first = await authedInject(fx.app, {
      method: "POST",
      url: `/api/rooms/${room1}/messages`,
      bearer: token,
      payload: { content: "first line" },
    });
    expect(first.statusCode).toBe(201);
    const mid = (JSON.parse(first.body) as { messageId: number }).messageId;

    const r2 = await authedInject(fx.app, {
      method: "POST",
      url: "/api/rooms",
      bearer: token,
      payload: {
        label: "R2",
        members: [{ kind: "user", id: fx.ownerId }],
      },
    });
    expect(r2.statusCode).toBe(201);
    const room2 = (JSON.parse(r2.body) as { id: string }).id;

    const bad = await authedInject(fx.app, {
      method: "POST",
      url: `/api/rooms/${room2}/messages`,
      bearer: token,
      payload: { content: "reply cross", replyToMessageId: mid },
    });
    expect(bad.statusCode).toBe(400);

    for (const rid of [room1, room2]) {
      const srows = await fx.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.roomId, rid));
      for (const s of srows) {
        await fx.db.delete(sessionMessages).where(eq(sessionMessages.sessionId, s.id));
        await fx.db.delete(sessions).where(eq(sessions.id, s.id));
      }
      await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, rid));
      await fx.db.delete(rooms).where(eq(rooms.id, rid));
    }
  });

  test("advisory currentFolder validation failure does not reject the turn", async () => {
    const roomId = fx.defaultRoomId;
    if (!roomId) throw new Error("room");
    const token = await fx.mintOwnerBearer();
    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      bearer: token,
      payload: {
        content: "x",
        currentFolder: "relative-oops",
      },
    });
    expect(res.statusCode).toBe(202);
  });
});
