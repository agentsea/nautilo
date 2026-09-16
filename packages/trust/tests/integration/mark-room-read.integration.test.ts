/**
 * M122 — `markRoomRead` across both substrate branches: happy path, idempotency,
 * `upToMessageId` bound, self-authored exclusion. Live instance, no migrations.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createDirectDb } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { getRoomUnreadCountsForRecipients } from "../../src/queries";
import { markRoomRead } from "../../src/read-state";
import {
  Tracker,
  cleanupAll,
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

/** 1:1 human↔agent room (scalar branch) with `n` unread assistant messages. */
async function scalarRoom(n: number): Promise<{ roomId: string; uid: string; ids: number[] }> {
  const ns = await mkNamespace(db, t);
  const agentId = await mkAgent(db, t);
  const uid = await mkUser(db, t, "mrr");
  const human = await mkActor(db, t, uid, "H");
  const agentActor = await mkActor(db, t, uid, "Hbot", { kind: "agent", agentId });
  const roomId = await mkRoom(db, t, {
    ownerId: uid,
    namespaceId: ns,
    humanActorIds: [human],
    memberActorIds: [human, agentActor],
    kind: "private",
  });
  const sess = await mkSession(db, t, { roomId, ownerId: uid, agentId });
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(await mkMessage(db, t, { sessionId: sess, role: "assistant" }));
  return { roomId, uid, ids };
}

/** 3-human group room (junction branch) with `n` unread assistant messages. */
async function groupRoom(n: number): Promise<{
  roomId: string;
  uid: string;
  sessionId: string;
  ids: number[];
}> {
  const ns = await mkNamespace(db, t);
  const agentId = await mkAgent(db, t);
  const uid = await mkUser(db, t, "mrrg");
  const u2 = await mkUser(db, t, "mrrg2");
  const u3 = await mkUser(db, t, "mrrg3");
  const a1 = await mkActor(db, t, uid, "G1");
  const a2 = await mkActor(db, t, u2, "G2");
  const a3 = await mkActor(db, t, u3, "G3");
  const roomId = await mkRoom(db, t, {
    ownerId: uid,
    namespaceId: ns,
    humanActorIds: [a1, a2, a3],
    memberActorIds: [a1, a2, a3],
    kind: "group",
    type: "group",
  });
  const sess = await mkSession(db, t, { roomId, ownerId: uid, agentId });
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(await mkMessage(db, t, { sessionId: sess, role: "assistant" }));
  return { roomId, uid, sessionId: sess, ids };
}

describe("M122 markRoomRead", () => {
  test("scalar happy path: 5 unread → marked 5 → unread 0", async () => {
    const { roomId, uid } = await scalarRoom(5);
    expect(await unread(roomId, uid)).toBe(5);
    const r = await markRoomRead({ roomId, userId: uid });
    expect(r.marked).toBe(5);
    expect(await unread(roomId, uid)).toBe(0);
  });

  test("scalar idempotent: re-call returns marked 0", async () => {
    const { roomId, uid } = await scalarRoom(3);
    expect((await markRoomRead({ roomId, userId: uid })).marked).toBe(3);
    expect((await markRoomRead({ roomId, userId: uid })).marked).toBe(0);
    expect(await unread(roomId, uid)).toBe(0);
  });

  test("scalar upToMessageId: only id <= bound flips", async () => {
    const { roomId, uid, ids } = await scalarRoom(5);
    const r = await markRoomRead({ roomId, userId: uid, upToMessageId: ids[2]! });
    expect(r.marked).toBe(3); // ids[0..2]
    expect(await unread(roomId, uid)).toBe(2);
  });

  test("group happy path + idempotent", async () => {
    const { roomId, uid } = await groupRoom(4);
    expect(await unread(roomId, uid)).toBe(4);
    expect((await markRoomRead({ roomId, userId: uid })).marked).toBe(4);
    expect(await unread(roomId, uid)).toBe(0);
    expect((await markRoomRead({ roomId, userId: uid })).marked).toBe(0);
  });

  test("group upToMessageId: only id <= bound flips", async () => {
    const { roomId, uid, ids } = await groupRoom(5);
    const r = await markRoomRead({ roomId, userId: uid, upToMessageId: ids[2]! });
    expect(r.marked).toBe(3); // ids[0..2]
    expect(await unread(roomId, uid)).toBe(2);
  });

  test("group self-authored messages are excluded", async () => {
    const { roomId, uid, sessionId } = await groupRoom(1);
    await mkMessage(db, t, { sessionId, role: "user" });

    expect(await unread(roomId, uid)).toBe(1);
    expect((await markRoomRead({ roomId, userId: uid })).marked).toBe(1);
    expect(await unread(roomId, uid)).toBe(0);
  });

  test("self-authored messages are never flipped and never counted", async () => {
    const ns = await mkNamespace(db, t);
    const agentId = await mkAgent(db, t);
    const uid = await mkUser(db, t, "mrrself");
    const human = await mkActor(db, t, uid, "S");
    const agentActor = await mkActor(db, t, uid, "Sbot", { kind: "agent", agentId });
    const roomId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human, agentActor],
      kind: "private",
    });
    const sess = await mkSession(db, t, { roomId, ownerId: uid, agentId });
    for (let i = 0; i < 3; i++) await mkMessage(db, t, { sessionId: sess, role: "user" });
    await mkMessage(db, t, { sessionId: sess, role: "assistant" });
    // Only the 1 assistant message is unread / markable; 3 self user rows excluded.
    expect(await unread(roomId, uid)).toBe(1);
    const r = await markRoomRead({ roomId, userId: uid });
    expect(r.marked).toBe(1);
    expect(await unread(roomId, uid)).toBe(0);
  });
});
