/**
 * D426 Phase 1 §1.2 / §1.4 — Subthread reply-summary persistence invariants
 * (live Postgres). Proves that `appendTranscriptMessages` with
 * `subthreadRoomId` writes child linkage + an authoritative root summary
 * in ONE transaction, that replayed inserts do not double-count, and that
 * inline quote-replies never perturb subthread summary fields.
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import {
  createDirectDb,
  ensureDatabase,
  users,
  actors,
  agents,
  namespaces,
  rooms,
  roomMembers,
  sessions,
  sessionMessages,
  eq,
  inArray,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { appendTranscriptMessages } from "../../src/store/session-store";

let db: ReturnType<typeof createDirectDb>;
let ownerH1: string;
let ownerH2: string;
let actorH1: string;
let actorH2: string;
let agentId: string;
let nsId: string;
const ts = Date.now().toString(36);

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);

  const [u1] = await db
    .insert(users)
    .values({ name: `d426-h1-${ts}`, email: `d426h1-${ts}@test.local`, handle: `d426h1${ts.slice(-6)}` })
    .returning({ id: users.id });
  const [u2] = await db
    .insert(users)
    .values({ name: `d426-h2-${ts}`, email: `d426h2-${ts}@test.local`, handle: `d426h2${ts.slice(-6)}` })
    .returning({ id: users.id });
  if (!u1 || !u2) throw new Error("users");
  ownerH1 = u1.id;
  ownerH2 = u2.id;

  const [a1] = await db
    .insert(actors)
    .values({ ownerId: ownerH1, displayName: "H1", kind: "user" })
    .returning({ id: actors.id });
  const [a2] = await db
    .insert(actors)
    .values({ ownerId: ownerH2, displayName: "H2", kind: "user" })
    .returning({ id: actors.id });
  if (!a1 || !a2) throw new Error("actors");
  actorH1 = a1.id;
  actorH2 = a2.id;

  const [ag] = await db
    .insert(agents)
    .values({ handle: `d426-ag-${ts}` })
    .returning({ id: agents.id });
  if (!ag) throw new Error("agent");
  agentId = ag.id;

  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `d426-ns-${ts}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("ns");
  nsId = ns.id;
});
afterAll(async () => {
  if (!db) return;
  try {
    await db.delete(actors).where(eq(actors.ownerId, ownerH1));
    await db.delete(actors).where(eq(actors.ownerId, ownerH2));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.delete(namespaces).where(eq(namespaces.id, nsId));
    await db.delete(users).where(eq(users.id, ownerH1));
    await db.delete(users).where(eq(users.id, ownerH2));
  } finally {
    await db.end();
  }
});
interface Fixture {
  parentRoomId: string;
  subthreadRoomId: string;
  anchorMessageId: number;
  parentSessionId: string;
}

/**
 * Build a parent room + a subthread room anchored on a fresh root message
 * authored by H1. Returns ids and a teardown helper. The subthread room is
 * inserted directly (not via `createSubthreadRoom`) because that helper is
 * not re-exported from `@nautilo/trust`'s public surface.
 */
async function makeSubthreadFixture(): Promise<{ fixture: Fixture; cleanup: () => Promise<void> }> {
  const parentRoomId = randomUUID();
  await db.insert(rooms).values({
    id: parentRoomId,
    ownerId: ownerH1,
    type: "private",
    label: "d426 parent",
    graphThreadId: `room:${parentRoomId}`,
    namespaceId: nsId,
    humanActorIds: [actorH1, actorH2].sort(),
    createdBy: actorH1,
  });
  await db.insert(roomMembers).values([
    { roomId: parentRoomId, actorId: actorH1, roomRole: "admin" },
    { roomId: parentRoomId, actorId: actorH2, roomRole: "member" },
  ]);

  const [parentSess] = await db
    .insert(sessions)
    .values({
      threadId: `room:${parentRoomId}`,
      ownerId: ownerH1,
      personaId: "owner",
      agentId,
      roomId: parentRoomId,
      channel: "tui",
    })
    .returning({ id: sessions.id });
  if (!parentSess) throw new Error("parentSess");

  const [anchor] = await db
    .insert(sessionMessages)
    .values({ sessionId: parentSess.id, role: "user", content: "root anchor msg" })
    .returning({ id: sessionMessages.id });
  if (!anchor) throw new Error("anchor");

  const subthreadRoomId = randomUUID();
  await db.insert(rooms).values({
    id: subthreadRoomId,
    ownerId: ownerH1,
    type: "private",
    label: "d426 sub",
    graphThreadId: `room:${subthreadRoomId}`,
    namespaceId: nsId,
    humanActorIds: [actorH1, actorH2].sort(),
    createdBy: actorH1,
    kind: "subthread",
    parentRoomId,
    threadRootMessageId: anchor.id,
  });
  await db.insert(roomMembers).values([
    { roomId: subthreadRoomId, actorId: actorH1, roomRole: "admin" },
    { roomId: subthreadRoomId, actorId: actorH2, roomRole: "member" },
  ]);

  const cleanup = async () => {
    // Delete child rows in the subthread room's sessions, then the
    // subthread room (cascades its room_members), then the parent
    // session/messages, then the parent room.
    const subSessions = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.roomId, subthreadRoomId));
    const subSessionIds = subSessions.map((s) => s.id);
    if (subSessionIds.length > 0) {
      await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, subSessionIds));
      await db.delete(sessions).where(inArray(sessions.id, subSessionIds));
    }
    await db.delete(rooms).where(eq(rooms.id, subthreadRoomId));
    await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, parentSess.id));
    await db.delete(sessions).where(eq(sessions.id, parentSess.id));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, parentRoomId));
    await db.delete(rooms).where(eq(rooms.id, parentRoomId));
  };

  return {
    fixture: { parentRoomId, subthreadRoomId, anchorMessageId: anchor.id, parentSessionId: parentSess.id },
    cleanup,
  };
}

async function readRoot(anchorMessageId: number) {
  const [row] = await db
    .select({
      replyCount: sessionMessages.replyCount,
      lastReplyAt: sessionMessages.lastReplyAt,
      summaryRevision: sessionMessages.summaryRevision,
      subthreadRoomId: sessionMessages.subthreadRoomId,
    })
    .from(sessionMessages)
    .where(eq(sessionMessages.id, anchorMessageId))
    .limit(1);
  return row;
}

async function childRows(subthreadRoomId: string) {
  return db
    .select({
      id: sessionMessages.id,
      role: sessionMessages.role,
      content: sessionMessages.content,
      subthreadRoomId: sessionMessages.subthreadRoomId,
    })
    .from(sessionMessages)
    .where(eq(sessionMessages.subthreadRoomId, subthreadRoomId));
}

describe("D426 Phase 1 subthread summary persistence", () => {
  test("first counted reply stamps child linkage and recomputes root summary", async () => {
    const { fixture, cleanup } = await makeSubthreadFixture();
    try {
      const res = await appendTranscriptMessages(
        `room:${fixture.subthreadRoomId}`,
        ownerH2,
        "owner",
        [new HumanMessage("reply 1")],
        { agentId, roomId: fixture.subthreadRoomId, subthreadRoomId: fixture.subthreadRoomId, humanTurnId: "turn-1" },
      );
      expect(res.insertedCount).toBe(1);
      expect(res.rootSummary?.replyCount).toBe(1);
      expect(res.rootSummary?.revision).toBe(1);
      expect(res.rootSummary?.lastReplyAt).toBeInstanceOf(Date);

      const root = await readRoot(fixture.anchorMessageId);
      expect(root?.replyCount).toBe(1);
      expect(root?.summaryRevision).toBe(1);
      expect(root?.lastReplyAt).not.toBeNull();
      expect(root?.subthreadRoomId).toBeNull(); // root is not a child

      const children = await childRows(fixture.subthreadRoomId);
      expect(children.length).toBe(1);
      expect(children[0]?.subthreadRoomId).toBe(fixture.subthreadRoomId);
    } finally {
      await cleanup();
    }
  });

  test("second counted reply advances count and revision", async () => {
    const { fixture, cleanup } = await makeSubthreadFixture();
    try {
      await appendTranscriptMessages(
        `room:${fixture.subthreadRoomId}`,
        ownerH2,
        "owner",
        [new HumanMessage("reply 1")],
        { agentId, roomId: fixture.subthreadRoomId, subthreadRoomId: fixture.subthreadRoomId, humanTurnId: "turn-1" },
      );
      const res2 = await appendTranscriptMessages(
        `room:${fixture.subthreadRoomId}`,
        ownerH1,
        "owner",
        [new HumanMessage("reply 2")],
        { agentId, roomId: fixture.subthreadRoomId, subthreadRoomId: fixture.subthreadRoomId, humanTurnId: "turn-2" },
      );
      expect(res2.rootSummary?.replyCount).toBe(2);
      expect(res2.rootSummary?.revision).toBe(2);

      const root = await readRoot(fixture.anchorMessageId);
      expect(root?.replyCount).toBe(2);
      expect(root?.summaryRevision).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("replayed insert (fingerprint dedup) does not double-count or bump revision", async () => {
    const { fixture, cleanup } = await makeSubthreadFixture();
    try {
      await appendTranscriptMessages(
        `room:${fixture.subthreadRoomId}`,
        ownerH2,
        "owner",
        [new HumanMessage("reply 1")],
        { agentId, roomId: fixture.subthreadRoomId, subthreadRoomId: fixture.subthreadRoomId, humanTurnId: "turn-1" },
      );
      const before = await readRoot(fixture.anchorMessageId);
      expect(before?.summaryRevision).toBe(1);

      // Replay the exact same human turn (same content + same humanTurnId
      // => same fingerprint). The unique index dedups; nothing is inserted.
      const replay = await appendTranscriptMessages(
        `room:${fixture.subthreadRoomId}`,
        ownerH2,
        "owner",
        [new HumanMessage("reply 1")],
        { agentId, roomId: fixture.subthreadRoomId, subthreadRoomId: fixture.subthreadRoomId, humanTurnId: "turn-1" },
      );
      expect(replay.insertedCount).toBe(0);
      expect(replay.rootSummary).toBeUndefined();

      const after = await readRoot(fixture.anchorMessageId);
      expect(after?.replyCount).toBe(1);
      expect(after?.summaryRevision).toBe(1); // unchanged

      const children = await childRows(fixture.subthreadRoomId);
      expect(children.length).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("non-counted child rows (empty assistant turn) do not bump revision", async () => {
    const { fixture, cleanup } = await makeSubthreadFixture();
    try {
      await appendTranscriptMessages(
        `room:${fixture.subthreadRoomId}`,
        ownerH2,
        "owner",
        [new HumanMessage("reply 1")],
        { agentId, roomId: fixture.subthreadRoomId, subthreadRoomId: fixture.subthreadRoomId, humanTurnId: "turn-1" },
      );
      const before = await readRoot(fixture.anchorMessageId);
      expect(before?.summaryRevision).toBe(1);

      // Empty-content assistant turn (pure tool-call) is NOT a counted reply.
      const res = await appendTranscriptMessages(
        `room:${fixture.subthreadRoomId}`,
        ownerH2,
        "owner",
        [new AIMessage({ content: "", tool_calls: [{ name: "noop", args: {}, id: "tc1" }] })],
        { agentId, roomId: fixture.subthreadRoomId, subthreadRoomId: fixture.subthreadRoomId },
      );
      expect(res.insertedCount).toBe(1);
      expect(res.rootSummary).toBeUndefined();

      const after = await readRoot(fixture.anchorMessageId);
      expect(after?.replyCount).toBe(1);
      expect(after?.summaryRevision).toBe(1); // unchanged
    } finally {
      await cleanup();
    }
  });

  test("inline quote-reply in the parent room never affects subthread summary", async () => {
    const { fixture, cleanup } = await makeSubthreadFixture();
    try {
      await appendTranscriptMessages(
        `room:${fixture.subthreadRoomId}`,
        ownerH2,
        "owner",
        [new HumanMessage("reply 1")],
        { agentId, roomId: fixture.subthreadRoomId, subthreadRoomId: fixture.subthreadRoomId, humanTurnId: "turn-1" },
      );
      const before = await readRoot(fixture.anchorMessageId);
      expect(before?.replyCount).toBe(1);
      expect(before?.summaryRevision).toBe(1);

      // A quote-reply is a TOP-LEVEL parent-room message (no subthreadRoomId)
      // that carries reply_to_message_id. It must not touch the subthread
      // summary fields on the anchor.
      const quote = new HumanMessage({
        content: "replying to the anchor inline",
        additional_kwargs: { nautilo_reply_to_message_id: fixture.anchorMessageId },
      });
      const res = await appendTranscriptMessages(
        `room:${fixture.parentRoomId}`,
        ownerH1,
        "owner",
        [quote],
        { agentId, roomId: fixture.parentRoomId, humanTurnId: "quote-turn-1" },
      );
      expect(res.insertedCount).toBe(1);
      expect(res.rootSummary).toBeUndefined();

      const after = await readRoot(fixture.anchorMessageId);
      expect(after?.replyCount).toBe(1);
      expect(after?.summaryRevision).toBe(1); // quote-reply did not bump it
      expect(after?.lastReplyAt).toEqual(before?.lastReplyAt);
    } finally {
      await cleanup();
    }
  });

  test("root/child membership and anchor ownership are correct", async () => {
    const { fixture, cleanup } = await makeSubthreadFixture();
    try {
      // The subthread room's anchor is the root message id.
      const [sub] = await db
        .select({ root: rooms.threadRootMessageId, kind: rooms.kind, parent: rooms.parentRoomId })
        .from(rooms)
        .where(eq(rooms.id, fixture.subthreadRoomId))
        .limit(1);
      expect(sub?.kind).toBe("subthread");
      expect(sub?.parent).toBe(fixture.parentRoomId);
      expect(sub?.root).toBe(fixture.anchorMessageId);

      await appendTranscriptMessages(
        `room:${fixture.subthreadRoomId}`,
        ownerH2,
        "owner",
        [new HumanMessage("reply 1")],
        { agentId, roomId: fixture.subthreadRoomId, subthreadRoomId: fixture.subthreadRoomId, humanTurnId: "turn-1" },
      );

      // Root row carries no subthread_room_id; child rows carry the subthread id.
      const root = await readRoot(fixture.anchorMessageId);
      expect(root?.subthreadRoomId).toBeNull();
      const children = await childRows(fixture.subthreadRoomId);
      expect(children.length).toBe(1);
      expect(children.every((c) => c.subthreadRoomId === fixture.subthreadRoomId)).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
// End D426 subthread summary persistence integration coverage.
