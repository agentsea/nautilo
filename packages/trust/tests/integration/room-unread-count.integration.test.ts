/**
 * M122 — `unreadCount` correctness across the bifurcated D124 substrate.
 *
 * Exercises `getRoomUnreadCountsForRecipients` (the single-room recompute CTE,
 * same SQL `listRoomsForActor` inlines) plus `listRoomsForActor` /
 * `resolveViewerUserIdForActor` for the agent-actor short-circuit. Runs against
 * a live, already-migrated instance (NAUTILO_INSTANCE_ID selects it) — does NOT
 * call ensureDatabase, so no migrations are applied.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createDirectDb,
  subthreadNotificationParticipants,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  getRoomUnreadCountsForRecipients,
  listRoomsForActor,
  resolveViewerUserIdForActor,
} from "../../src/queries";
import {
  Tracker,
  cleanupAll,
  markRecipRead,
  mkActor,
  mkAgent,
  mkMessage,
  mkNamespace,
  mkRoom,
  mkSession,
  mkUser,
  type Db,
} from "./helpers/unread-fixtures";

let db: Db;
const t = new Tracker();

beforeAll(() => {
  bootstrapTestDbInstance();
  db = createDirectDb(2);
});

afterAll(async () => {
  try {
    await cleanupAll(db, t);
  } finally {
    await db.end();
  }
});

async function unread(roomId: string, userId: string): Promise<number> {
  const m = await getRoomUnreadCountsForRecipients(roomId, [userId]);
  return m.get(userId) ?? 0;
}

describe("M122 unreadCount substrate correctness", () => {
  test("case 1 — 1:1 human↔agent DM (scalar): self excluded, read excluded", async () => {
    const ns = await mkNamespace(db, t);
    const agentId = await mkAgent(db, t);
    const uid = await mkUser(db, t, "c1");
    const human = await mkActor(db, t, uid, "C1");
    const agentActor = await mkActor(db, t, uid, "C1bot", { kind: "agent", agentId });
    const roomId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human, agentActor],
      kind: "private",
    });
    const sess = await mkSession(db, t, { roomId, ownerId: uid, agentId });
    const past = new Date(Date.now() - 60_000);
    for (let i = 0; i < 3; i++) await mkMessage(db, t, { sessionId: sess, role: "user" });
    // 2 assistant already read (scalar read_at) + 3 unread → unread = 3.
    for (let i = 0; i < 2; i++) {
      await mkMessage(db, t, { sessionId: sess, role: "assistant", readAt: past });
    }
    for (let i = 0; i < 3; i++) await mkMessage(db, t, { sessionId: sess, role: "assistant" });
    expect(await unread(roomId, uid)).toBe(3);
  });

  test("case 2 — 2-human DM (per-recipient): each viewer sees the other's messages", async () => {
    const ns = await mkNamespace(db, t);
    const agentId = await mkAgent(db, t);
    const userA = await mkUser(db, t, "c2a");
    const userB = await mkUser(db, t, "c2b");
    const aAct = await mkActor(db, t, userA, "User A");
    const bAct = await mkActor(db, t, userB, "User B");
    const roomId = await mkRoom(db, t, {
      ownerId: userA,
      namespaceId: ns,
      humanActorIds: [aAct, bAct],
      memberActorIds: [aAct, bAct],
      kind: "private",
    });
    const aSess = await mkSession(db, t, { roomId, ownerId: userA, agentId });
    const bSess = await mkSession(db, t, { roomId, ownerId: userB, agentId });
    for (let i = 0; i < 4; i++) await mkMessage(db, t, { sessionId: aSess, role: "user" });
    for (let i = 0; i < 2; i++) await mkMessage(db, t, { sessionId: bSess, role: "user" });
    // User B sees User A's 4 (their 2 excluded as self-authored).
    expect(await unread(roomId, userB)).toBe(4);
    // User A sees User B's 2.
    expect(await unread(roomId, userA)).toBe(2);
  });

  test("case 3 — group room (3 humans, junction): per-recipient divergence", async () => {
    const ns = await mkNamespace(db, t);
    const agentId = await mkAgent(db, t);
    const owner = await mkUser(db, t, "c3o");
    const reader = await mkUser(db, t, "c3a");
    const bob = await mkUser(db, t, "c3b");
    const oAct = await mkActor(db, t, owner, "Owner");
    const aAct = await mkActor(db, t, reader, "Reader");
    const bAct = await mkActor(db, t, bob, "Bob");
    const roomId = await mkRoom(db, t, {
      ownerId: owner,
      namespaceId: ns,
      humanActorIds: [oAct, aAct, bAct],
      memberActorIds: [oAct, aAct, bAct],
      kind: "group",
      type: "group",
    });
    // 10 assistant (agent-authored) messages → unread for every human.
    const sess = await mkSession(db, t, { roomId, ownerId: owner, agentId });
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) ids.push(await mkMessage(db, t, { sessionId: sess, role: "assistant" }));
    for (let i = 0; i < 5; i++) await markRecipRead(db, ids[i]!, reader);
    expect(await unread(roomId, reader)).toBe(5);
    expect(await unread(roomId, bob)).toBe(10);
  });

  test("case 4 — participating subthread retains an independent legacy own count", async () => {
    const ns = await mkNamespace(db, t);
    const agentId = await mkAgent(db, t);
    const uid = await mkUser(db, t, "c4");
    const human = await mkActor(db, t, uid, "C4");
    const agentActor = await mkActor(db, t, uid, "C4bot", { kind: "agent", agentId });
    const parentId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human, agentActor],
      kind: "private",
    });
    const pSess = await mkSession(db, t, { roomId: parentId, ownerId: uid, agentId });
    let rootMsg = 0;
    for (let i = 0; i < 2; i++) {
      rootMsg = await mkMessage(db, t, { sessionId: pSess, role: "assistant" });
    }
    // subthread invariant requires both parent_room_id + thread_root_message_id.
    const subId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human, agentActor],
      kind: "subthread",
      parentRoomId: parentId,
      threadRootMessageId: rootMsg,
    });
    const sSess = await mkSession(db, t, { roomId: subId, ownerId: uid, agentId });
    const firstChildMessage = await mkMessage(db, t, {
      sessionId: sSess,
      role: "assistant",
    });
    await db.insert(subthreadNotificationParticipants).values({
      subthreadRoomId: subId,
      userId: uid,
      fromMessageId: firstChildMessage,
      reason: "mention",
    });
    for (let i = 0; i < 2; i++) {
      await mkMessage(db, t, { sessionId: sSess, role: "assistant" });
    }
    expect(await unread(parentId, uid)).toBe(2);
    expect(await unread(subId, uid)).toBe(3);
  });

  test("case 5 — agent-actor caller: 0 everywhere + null viewer resolution", async () => {
    const ns = await mkNamespace(db, t);
    const agentId = await mkAgent(db, t);
    const uid = await mkUser(db, t, "c5");
    const human = await mkActor(db, t, uid, "C5");
    const agentActor = await mkActor(db, t, uid, "C5bot", { kind: "agent", agentId });
    const roomId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human, agentActor],
      kind: "private",
    });
    const sess = await mkSession(db, t, { roomId, ownerId: uid, agentId });
    for (let i = 0; i < 4; i++) await mkMessage(db, t, { sessionId: sess, role: "assistant" });

    expect(await resolveViewerUserIdForActor(agentActor)).toBeNull();
    const rowsForAgent = await listRoomsForActor(agentActor);
    expect(rowsForAgent.every((r) => r.unreadCount === 0)).toBe(true);
    // sanity: the human DOES see the 4.
    expect(await unread(roomId, uid)).toBe(4);
  });

  test("case 6 — empty room: 0", async () => {
    const ns = await mkNamespace(db, t);
    const uid = await mkUser(db, t, "c6");
    const human = await mkActor(db, t, uid, "C6");
    const roomId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human],
      kind: "private",
    });
    expect(await unread(roomId, uid)).toBe(0);
  });

  test("case 7 — all-read room: 0", async () => {
    const ns = await mkNamespace(db, t);
    const agentId = await mkAgent(db, t);
    const uid = await mkUser(db, t, "c7");
    const human = await mkActor(db, t, uid, "C7");
    const agentActor = await mkActor(db, t, uid, "C7bot", { kind: "agent", agentId });
    const roomId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human, agentActor],
      kind: "private",
    });
    const sess = await mkSession(db, t, { roomId, ownerId: uid, agentId });
    const past = new Date(Date.now() - 60_000);
    for (let i = 0; i < 3; i++) {
      await mkMessage(db, t, { sessionId: sess, role: "assistant", readAt: past });
    }
    expect(await unread(roomId, uid)).toBe(0);
  });

  test("case 8 — self-only room: 0 (all messages self-authored)", async () => {
    const ns = await mkNamespace(db, t);
    const agentId = await mkAgent(db, t);
    const uid = await mkUser(db, t, "c8");
    const human = await mkActor(db, t, uid, "C8");
    const agentActor = await mkActor(db, t, uid, "C8bot", { kind: "agent", agentId });
    const roomId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human, agentActor],
      kind: "private",
    });
    const sess = await mkSession(db, t, { roomId, ownerId: uid, agentId });
    for (let i = 0; i < 5; i++) await mkMessage(db, t, { sessionId: sess, role: "user" });
    expect(await unread(roomId, uid)).toBe(0);
  });
});
