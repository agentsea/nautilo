/**
 * D426 Phase 1 §1.2 / §1.4 — `deleteMessageHard` recomputes the root anchor
 * summary when a counted Subthread child reply is deleted (newest-reply and
 * final-reply deletion), and leaves it untouched for non-counted child rows.
 * Live Postgres; run against a scratch instance.
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
  namespaces,
  rooms,
  roomMembers,
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

async function createUser(label: string): Promise<string> {
  const ts = Date.now();
  const [u] = await db
    .insert(users)
    .values({ name: label, email: `${label}-${ts}-${randomUUID()}@d426.test`, handle: `${label}${ts}${Math.floor(Math.random() * 1e6)}` })
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

interface Fixture {
  userId: string;
  actorId: string;
  agentId: string;
  namespaceId: string;
  parentRoomId: string;
  parentSessionId: string;
  subthreadRoomId: string;
  anchorMessageId: number;
  subSessionId: string;
}

async function makeFixture(label: string): Promise<Fixture> {
  const userId = await createUser(`d426del${label}`);
  const actorId = await createHumanActor(userId, label.toUpperCase());
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `ns-${randomUUID()}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("ns");
  const parentRoomId = randomUUID();
  await db.insert(rooms).values({
    id: parentRoomId,
    ownerId: userId,
    type: "private",
    label: `parent-${label}`,
    graphThreadId: `room:${parentRoomId}`,
    namespaceId: ns.id,
    humanActorIds: [actorId],
    createdBy: actorId,
  });
  await db.insert(roomMembers).values({ roomId: parentRoomId, actorId, roomRole: "admin" });
  const [ag] = await db
    .insert(agents)
    .values({ handle: `ag-${randomUUID()}` })
    .returning({ id: agents.id });
  if (!ag) throw new Error("agent");
  const [parentSess] = await db
    .insert(sessions)
    .values({
      threadId: `room:${parentRoomId}`,
      ownerId: userId,
      personaId: "owner",
      agentId: ag.id,
      roomId: parentRoomId,
      channel: "tui",
    })
    .returning({ id: sessions.id });
  if (!parentSess) throw new Error("parentSess");
  const [anchor] = await db
    .insert(sessionMessages)
    .values({ sessionId: parentSess.id, role: "user", content: "anchor" })
    .returning({ id: sessionMessages.id });
  if (!anchor) throw new Error("anchor");

  const subthreadRoomId = randomUUID();
  await db.insert(rooms).values({
    id: subthreadRoomId,
    ownerId: userId,
    type: "private",
    label: `sub-${label}`,
    graphThreadId: `room:${subthreadRoomId}`,
    namespaceId: ns.id,
    humanActorIds: [actorId],
    createdBy: actorId,
    kind: "subthread",
    parentRoomId,
    threadRootMessageId: anchor.id,
  });
  await db.insert(roomMembers).values({ roomId: subthreadRoomId, actorId, roomRole: "admin" });
  const [subSess] = await db
    .insert(sessions)
    .values({
      threadId: `room:${subthreadRoomId}`,
      ownerId: userId,
      personaId: "owner",
      agentId: ag.id,
      roomId: subthreadRoomId,
      channel: "tui",
    })
    .returning({ id: sessions.id });
  if (!subSess) throw new Error("subSess");

  return {
    userId,
    actorId,
    agentId: ag.id,
    namespaceId: ns.id,
    parentRoomId,
    parentSessionId: parentSess.id,
    subthreadRoomId,
    anchorMessageId: anchor.id,
    subSessionId: subSess.id,
  };
}

async function insertChildReply(
  f: Fixture,
  content: string,
  createdAt: Date,
  opts?: { role?: "user" | "assistant"; originatedByTask?: boolean },
): Promise<number> {
  const [msg] = await db
    .insert(sessionMessages)
    .values({
      sessionId: f.subSessionId,
      role: opts?.role ?? "user",
      content,
      createdAt,
      subthreadRoomId: f.subthreadRoomId,
      ...(opts?.originatedByTask ? { metadata: { originatedBy: "task" } } : {}),
    })
    .returning({ id: sessionMessages.id });
  if (!msg) throw new Error("child");
  return msg.id;
}

async function setRootBaseline(f: Fixture, replyCount: number, lastReplyAt: Date | null, revision: number): Promise<void> {
  await db
    .update(sessionMessages)
    .set({ replyCount, lastReplyAt, summaryRevision: revision })
    .where(eq(sessionMessages.id, f.anchorMessageId));
}

async function readRoot(anchorMessageId: number) {
  const [row] = await db
    .select({
      replyCount: sessionMessages.replyCount,
      lastReplyAt: sessionMessages.lastReplyAt,
      summaryRevision: sessionMessages.summaryRevision,
    })
    .from(sessionMessages)
    .where(eq(sessionMessages.id, anchorMessageId))
    .limit(1);
  return row;
}

async function cleanup(f: Fixture): Promise<void> {
  await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, f.subSessionId));
  await db.delete(sessions).where(eq(sessions.id, f.subSessionId));
  await db.delete(rooms).where(eq(rooms.id, f.subthreadRoomId));
  await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, f.parentSessionId));
  await db.delete(sessions).where(eq(sessions.id, f.parentSessionId));
  await db.delete(roomMembers).where(eq(roomMembers.roomId, f.parentRoomId));
  await db.delete(rooms).where(eq(rooms.id, f.parentRoomId));
  await db.delete(namespaces).where(eq(namespaces.id, f.namespaceId));
  await db.delete(agents).where(eq(agents.id, f.agentId));
  await db.delete(actors).where(eq(actors.id, f.actorId));
  await db.delete(users).where(eq(users.id, f.userId));
}

describe("D426 deleteMessageHard root-summary recompute", () => {
  test("newest-reply deletion updates last_reply_at to the next-newest", async () => {
    const f = await makeFixture("newest");
    try {
      const t1 = new Date("2024-08-01T10:00:00.000Z");
      const t2 = new Date("2024-08-01T11:00:00.000Z");
      await insertChildReply(f, "reply A", t1);
      const newerId = await insertChildReply(f, "reply B (newest)", t2);
      await setRootBaseline(f, 2, t2, 2);

      const res = await deleteMessageHard(newerId);
      expect(res.rootSummary?.parentRoomId).toBe(f.parentRoomId);
      expect(res.rootSummary?.anchorMessageId).toBe(f.anchorMessageId);
      expect(res.rootSummary?.replyCount).toBe(1);
      expect(res.rootSummary?.revision).toBe(3);

      const root = await readRoot(f.anchorMessageId);
      expect(root?.replyCount).toBe(1);
      expect(root?.summaryRevision).toBe(3);
      expect(root?.lastReplyAt?.toISOString()).toBe(t1.toISOString());
    } finally {
      await cleanup(f);
    }
  });

  test("final-reply deletion resets count to 0 and last_reply_at to NULL", async () => {
    const f = await makeFixture("final");
    try {
      const t1 = new Date("2024-08-02T10:00:00.000Z");
      const onlyId = await insertChildReply(f, "only reply", t1);
      await setRootBaseline(f, 1, t1, 1);

      const res = await deleteMessageHard(onlyId);
      expect(res.rootSummary?.parentRoomId).toBe(f.parentRoomId);
      expect(res.rootSummary?.anchorMessageId).toBe(f.anchorMessageId);
      expect(res.rootSummary?.replyCount).toBe(0);
      expect(res.rootSummary?.lastReplyAt).toBeNull();
      expect(res.rootSummary?.revision).toBe(2);

      const root = await readRoot(f.anchorMessageId);
      expect(root?.replyCount).toBe(0);
      expect(root?.lastReplyAt).toBeNull();
      expect(root?.summaryRevision).toBe(2);
    } finally {
      await cleanup(f);
    }
  });

  test("deleting a non-counted child row (empty assistant turn) does not bump revision", async () => {
    const f = await makeFixture("noncounted");
    try {
      const t1 = new Date("2024-08-03T10:00:00.000Z");
      const t2 = new Date("2024-08-03T11:00:00.000Z");
      await insertChildReply(f, "real reply", t1);
      const emptyAssistantId = await insertChildReply(f, "", t2, { role: "assistant" });
      await setRootBaseline(f, 1, t1, 1); // only the counted human reply counts

      const res = await deleteMessageHard(emptyAssistantId);
      expect(res.rootSummary).toBeNull(); // non-counted delete → no recompute

      const root = await readRoot(f.anchorMessageId);
      expect(root?.replyCount).toBe(1);
      expect(root?.summaryRevision).toBe(1); // unchanged
    } finally {
      await cleanup(f);
    }
  });

  test("deleting a transient task-originated child row does not bump revision", async () => {
    const f = await makeFixture("task");
    try {
      const t1 = new Date("2024-08-04T10:00:00.000Z");
      const t2 = new Date("2024-08-04T11:00:00.000Z");
      await insertChildReply(f, "real reply", t1);
      const taskRowId = await insertChildReply(f, "synthetic", t2, { originatedByTask: true });
      await setRootBaseline(f, 1, t1, 1);

      const res = await deleteMessageHard(taskRowId);
      expect(res.rootSummary).toBeNull();

      const root = await readRoot(f.anchorMessageId);
      expect(root?.replyCount).toBe(1);
      expect(root?.summaryRevision).toBe(1);
    } finally {
      await cleanup(f);
    }
  });

  test("still refuses to delete the subthread anchor (D308 preserved)", async () => {
    const f = await makeFixture("anchorref");
    try {
      let err: unknown;
      try {
        await deleteMessageHard(f.anchorMessageId);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(MessageDeleteError);
      expect((err as MessageDeleteError).reason).toBe("message_anchors_thread");

      const [still] = await db
        .select({ id: sessionMessages.id })
        .from(sessionMessages)
        .where(eq(sessionMessages.id, f.anchorMessageId));
      expect(still?.id).toBe(f.anchorMessageId);
    } finally {
      await cleanup(f);
    }
  });
});
