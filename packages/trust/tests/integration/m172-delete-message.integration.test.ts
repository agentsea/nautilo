/**
 * ISSUE-M172 — `deleteMessageHard` against live Postgres.
 *
 * Exercises the physical DELETE + the FK cascade/set-null cleanup + the
 * subthread-anchor refusal + the message_count decrement + the `wasUnread`
 * report. NOT part of `test:unit` — the shared test bootstrap defaults to the
 * disposable `test-cruft` database and still requires its Postgres to be running.
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  createDirectDb,
  ensureDatabase,
  eq,
  messageReactions,
  namespaces,
  rooms,
  roomMembers,
  sessionMessageRecipientState,
  sessionMessages,
  sessions,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { deleteMessageHard } from "../../src/message-delete";
import { MessageDeleteError } from "../../src/membership";

let db: ReturnType<typeof createDirectDb>;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(3);
});

afterAll(async () => {
  await db.end();
});

async function createUser(name: string): Promise<string> {
  const ts = Date.now();
  const [u] = await db
    .insert(users)
    .values({ name, email: `${name}-${ts}-${randomUUID()}@m172.test`, handle: `${name}${ts}${Math.floor(Math.random() * 1e6)}` })
    .returning({ id: users.id });
  if (!u) throw new Error("user");
  return u.id;
}

async function createHumanActor(ownerId: string, label: string): Promise<string> {
  const [a] = await db
    .insert(actors)
    .values({ ownerId, displayName: label, kind: "user" })
    .returning({ id: actors.id });
  if (!a) throw new Error("actor");
  return a.id;
}

type Fixture = {
  userId: string;
  actorId: string;
  agentId: string;
  namespaceId: string;
  roomId: string;
  sessionId: string;
};

async function makeRoomWithSession(label: string): Promise<Fixture> {
  const userId = await createUser(`m172${label}`);
  const actorId = await createHumanActor(userId, label.toUpperCase());
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `ns-${randomUUID()}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("ns");
  const [room] = await db
    .insert(rooms)
    .values({
      ownerId: userId,
      type: "private",
      label,
      graphThreadId: `gt-${randomUUID()}`,
      namespaceId: ns.id,
      humanActorIds: [actorId],
    })
    .returning({ id: rooms.id });
  if (!room) throw new Error("room");
  await db.insert(roomMembers).values({ roomId: room.id, actorId, roomRole: "admin" });
  const [agent] = await db
    .insert(agents)
    .values({ handle: `ag-${randomUUID()}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("agent");
  const [sess] = await db
    .insert(sessions)
    .values({
      threadId: `room:${room.id}`,
      ownerId: userId,
      personaId: "owner",
      agentId: agent.id,
      roomId: room.id,
      channel: "tui",
    })
    .returning({ id: sessions.id });
  if (!sess) throw new Error("sess");
  return {
    userId,
    actorId,
    agentId: agent.id,
    namespaceId: ns.id,
    roomId: room.id,
    sessionId: sess.id,
  };
}

async function insertMessage(
  sessionId: string,
  role: "user" | "assistant" | "tool",
  content: string,
  opts?: { readAt?: Date | null; replyToMessageId?: number },
): Promise<number> {
  const [msg] = await db
    .insert(sessionMessages)
    .values({
      sessionId,
      role,
      content,
      ...(opts?.readAt !== undefined ? { readAt: opts.readAt } : {}),
      ...(opts?.replyToMessageId !== undefined ? { replyToMessageId: opts.replyToMessageId } : {}),
    })
    .returning({ id: sessionMessages.id });
  if (!msg) throw new Error("msg");
  return msg.id;
}

async function cleanup(f: Fixture): Promise<void> {
  // session_messages (+ cascades) first, then session/agent/members/room/ns/actor/user.
  await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, f.sessionId));
  await db.delete(sessions).where(eq(sessions.id, f.sessionId));
  await db.delete(agents).where(eq(agents.id, f.agentId));
  await db.delete(roomMembers).where(eq(roomMembers.roomId, f.roomId));
  await db.delete(rooms).where(eq(rooms.id, f.roomId));
  await db.delete(namespaces).where(eq(namespaces.id, f.namespaceId));
  await db.delete(actors).where(eq(actors.id, f.actorId));
  await db.delete(users).where(eq(users.id, f.userId));
}

describe("M172 deleteMessageHard (live Postgres)", () => {
  test("cascades reactions + recipient-state; reports wasUnread", async () => {
    const f = await makeRoomWithSession("cascade");
    const msgId = await insertMessage(f.sessionId, "user", "delete me", { readAt: null });
    await db
      .insert(messageReactions)
      .values({ messageId: msgId, actorId: f.actorId, emoji: "👍" });
    await db
      .insert(sessionMessageRecipientState)
      .values({ messageId: msgId, recipientId: f.userId });

    const res = await deleteMessageHard(msgId);
    expect(res.roomId).toBe(f.roomId);
    expect(res.wasUnread).toBe(true);

    const remaining = await db
      .select({ id: sessionMessages.id })
      .from(sessionMessages)
      .where(eq(sessionMessages.id, msgId));
    expect(remaining.length).toBe(0);
    const reactions = await db
      .select()
      .from(messageReactions)
      .where(eq(messageReactions.messageId, msgId));
    expect(reactions.length).toBe(0);
    const recip = await db
      .select()
      .from(sessionMessageRecipientState)
      .where(eq(sessionMessageRecipientState.messageId, msgId));
    expect(recip.length).toBe(0);

    await cleanup(f);
  });

  test("quote-reply link is set NULL (replier survives)", async () => {
    const f = await makeRoomWithSession("reply");
    const a = await insertMessage(f.sessionId, "user", "original");
    const b = await insertMessage(f.sessionId, "user", "quote-reply", { replyToMessageId: a });

    await deleteMessageHard(a);

    const [replier] = await db
      .select({ id: sessionMessages.id, replyTo: sessionMessages.replyToMessageId })
      .from(sessionMessages)
      .where(eq(sessionMessages.id, b));
    expect(replier?.id).toBe(b);
    expect(replier?.replyTo).toBeNull();

    await cleanup(f);
  });

  test("refuses to delete a subthread anchor (rolls back)", async () => {
    const f = await makeRoomWithSession("anchor");
    const anchorId = await insertMessage(f.sessionId, "user", "thread starter");
    const [sub] = await db
      .insert(rooms)
      .values({
        ownerId: f.userId,
        type: "private",
        label: "sub",
        kind: "subthread",
        parentRoomId: f.roomId,
        threadRootMessageId: anchorId,
        graphThreadId: `gt-${randomUUID()}`,
        namespaceId: f.namespaceId,
        humanActorIds: [f.actorId],
      })
      .returning({ id: rooms.id });
    if (!sub) throw new Error("sub");

    let anchorErr: unknown;
    try {
      await deleteMessageHard(anchorId);
    } catch (e) {
      anchorErr = e;
    }
    expect(anchorErr).toBeInstanceOf(MessageDeleteError);
    expect((anchorErr as MessageDeleteError).reason).toBe("message_anchors_thread");

    // Anchor message + subthread row both untouched.
    const [still] = await db
      .select({ id: sessionMessages.id })
      .from(sessionMessages)
      .where(eq(sessionMessages.id, anchorId));
    expect(still?.id).toBe(anchorId);
    const [subRow] = await db
      .select({ root: rooms.threadRootMessageId })
      .from(rooms)
      .where(eq(rooms.id, sub.id));
    expect(subRow?.root).toBe(anchorId);

    await db.delete(rooms).where(eq(rooms.id, sub.id));
    await cleanup(f);
  });

  test("deletes a non-anchor message inside a subthread", async () => {
    const f = await makeRoomWithSession("subnon");
    const anchorId = await insertMessage(f.sessionId, "user", "anchor");
    const [sub] = await db
      .insert(rooms)
      .values({
        ownerId: f.userId,
        type: "private",
        label: "sub",
        kind: "subthread",
        parentRoomId: f.roomId,
        threadRootMessageId: anchorId,
        graphThreadId: `gt-${randomUUID()}`,
        namespaceId: f.namespaceId,
        humanActorIds: [f.actorId],
      })
      .returning({ id: rooms.id });
    if (!sub) throw new Error("sub");
    // A reply message that lives in the subthread's own session.
    const [subSess] = await db
      .insert(sessions)
      .values({
        threadId: `room:${sub.id}`,
        ownerId: f.userId,
        personaId: "owner",
        agentId: f.agentId,
        roomId: sub.id,
        channel: "tui",
      })
      .returning({ id: sessions.id });
    if (!subSess) throw new Error("subSess");
    const replyId = await insertMessage(subSess.id, "user", "a reply, not the anchor");

    const res = await deleteMessageHard(replyId);
    expect(res.roomId).toBe(sub.id);
    const remaining = await db
      .select({ id: sessionMessages.id })
      .from(sessionMessages)
      .where(eq(sessionMessages.id, replyId));
    expect(remaining.length).toBe(0);

    await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, subSess.id));
    await db.delete(sessions).where(eq(sessions.id, subSess.id));
    await db.delete(rooms).where(eq(rooms.id, sub.id));
    await cleanup(f);
  });

  test("decrements message_count by exactly 1 and never below 0", async () => {
    const f = await makeRoomWithSession("count");
    const msgId = await insertMessage(f.sessionId, "user", "counted");
    await db.update(sessions).set({ messageCount: 1 }).where(eq(sessions.id, f.sessionId));

    await deleteMessageHard(msgId);
    const [afterOne] = await db
      .select({ c: sessions.messageCount })
      .from(sessions)
      .where(eq(sessions.id, f.sessionId));
    expect(afterOne?.c).toBe(0);

    // A second delete (different row, count already 0) must clamp at 0.
    const msg2 = await insertMessage(f.sessionId, "user", "second");
    await deleteMessageHard(msg2);
    const [afterTwo] = await db
      .select({ c: sessions.messageCount })
      .from(sessions)
      .where(eq(sessions.id, f.sessionId));
    expect(afterTwo?.c).toBe(0);

    await cleanup(f);
  });

  test("wasUnread is false when the scalar read_at is set", async () => {
    const f = await makeRoomWithSession("readat");
    const msgId = await insertMessage(f.sessionId, "assistant", "already read", {
      readAt: new Date(),
    });
    const res = await deleteMessageHard(msgId);
    expect(res.wasUnread).toBe(false);
    await cleanup(f);
  });

  test("throws not_found for a missing message id", async () => {
    let err: unknown;
    try {
      await deleteMessageHard(2_000_000_000);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MessageDeleteError);
    expect((err as MessageDeleteError).reason).toBe("not_found");
  });
});
