/**
 * M151 (Phase 7b) — `resolveTargetRoom` DM routing (`last_dm` / `new_dm`)
 * against real Postgres.
 *
 * This is the "the peer never saw the message" guard. `ask_peer` sends the
 * REQUESTER's agent into a 1-human-1-agent DM with a PEER. The DM must be:
 *   - `kind='private'` (the trust layer's 1-human-1-agent shape; there is no
 *     `'dm'` kind in the rooms enum),
 *   - OWNED by the peer (the only human member — `createRoomFromMembers`
 *     requires the owner actor to be a member; the requester is intentionally
 *     NOT a member, decision 2),
 *   - members exactly {requesting agent actor, peer user actor},
 *   - with the peer appended to `tasks.target_user_ids` and `target_room_id`
 *     memoized (so the await reply-hook can resume on the peer's reply).
 *
 * `last_dm` must REUSE an existing requesting-agent↔peer DM, and must NOT
 * collide with the peer's own DM with their OWN agent.
 *
 * No observer tick, no API keys — pure `resolveTargetRoom` against scoped rows.
 */

import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  tasks,
  taskRuns,
  users,
  agents,
  actors,
  namespaces,
  rooms,
  roomMembers,
  createTask as dbCreateTask,
  getTaskById,
  eq,
  and,
  inArray,
  type DirectDatabase,
} from "@nautilo/db";
import { resolveTargetRoom } from "../../src/tasks/resolve-target-room";
import { botThreadId } from "../../src/conductor/thread-id";
import {
  cleanupTestUser,
  closeDirectDb,
  getDirectDb,
  setupTestDb,
} from "./helpers";
import { setupAgentTestEnv, closeAgentDb } from "./agent-helpers";

let ownerUserId: string; // the requester
let agentId: string; // the requester's agent
let agentActorId: string;
let db: DirectDatabase;

// peer (test006) — a separate local user with a handle + user actor.
let peerUserId: string;
let peerActorId: string;
let peerHandle: string;

const createdRoomIds: string[] = [];
const createdNamespaceIds: string[] = [];
const createdTaskIds: string[] = [];
const extraAgentIds: string[] = [];
const extraActorIds: string[] = [];

beforeAll(async () => {
  await setupTestDb();
  const env = await setupAgentTestEnv("m151-dm");
  ownerUserId = env.userId;
  agentId = env.agentId;
  db = getDirectDb();

  // The agent-actor mirror seeded by setupAgentTestEnv (kind='agent').
  const [aa] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, ownerUserId), eq(actors.kind, "agent")))
    .limit(1);
  agentActorId = aa!.id;

  // Peer user with a unique local handle (server IS NULL) so
  // findLocalUserByHandle resolves it.
  peerHandle = `peer_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const [peer] = await db
    .insert(users)
    .values({
      name: "Test006",
      email: `${peerHandle}@test.local`,
      handle: peerHandle,
    })
    .returning({ id: users.id });
  peerUserId = peer!.id;
  const [pa] = await db
    .insert(actors)
    .values({ ownerId: peerUserId, kind: "user", displayName: "Test006", trustState: "verified" })
    .returning({ id: actors.id });
  peerActorId = pa!.id;
});

afterAll(async () => {
  if (!db) return;
  if (createdTaskIds.length > 0) {
    await db.delete(taskRuns).where(inArray(taskRuns.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  for (const rid of createdRoomIds) {
    await db.delete(roomMembers).where(eq(roomMembers.roomId, rid));
    await db.delete(rooms).where(eq(rooms.id, rid));
  }
  for (const aid of extraActorIds) {
    await db.delete(actors).where(eq(actors.id, aid));
  }
  await db.delete(actors).where(eq(actors.id, peerActorId));
  for (const ag of extraAgentIds) {
    await db.delete(agents).where(eq(agents.id, ag));
  }
  for (const nid of createdNamespaceIds) {
    await db.delete(namespaces).where(eq(namespaces.id, nid));
  }
  await db.delete(users).where(eq(users.id, peerUserId));
  await cleanupTestUser(ownerUserId);
  await closeDirectDb();
  await closeAgentDb();
});

async function insertDmTask(args: {
  targetChat: "new_dm" | "last_dm";
  handle?: string | null;
  targetRoomId?: string | null;
}): Promise<string> {
  const row = await dbCreateTask(db, {
    ownerId: ownerUserId,
    requestorId: ownerUserId,
    agentId,
    prompt: "how are you feeling?",
    preset: "ask_peer",
    scheduleKind: "now",
    targetChat: args.targetChat,
    targetChatHandle: args.handle === undefined ? `@${peerHandle}` : args.handle,
    targetUserIds: [ownerUserId],
    awaitResponse: true,
    toolsMode: "none",
    targetRoomId: args.targetRoomId ?? null,
    // Keep the row far-future so an independently running observer cannot claim it.
    nextFireAt: new Date(Date.now() + 3_600_000),
    status: "pending",
  });
  createdTaskIds.push(row.id);
  return row.id;
}

describe("M151 — resolveTargetRoom DM routing (live PG)", () => {
  test("new_dm: creates a kind='private' room owned by the PEER with {agent, peer}; memoizes room + appends peer to target_user_ids", async () => {
    const taskId = await insertDmTask({ targetChat: "new_dm" });
    const task = await getTaskById(db, taskId);

    const resolved = await resolveTargetRoom(task!, { db });
    createdRoomIds.push(resolved.roomId);

    // The run executes on the per-(room, bot) thread so the question is visible.
    expect(resolved.graphThreadId).toBe(botThreadId(resolved.roomId, agentId));
    expect(resolved.createdHumanRoomMembers).toEqual([
      { userId: peerUserId, actorId: peerActorId },
    ]);

    const [room] = await db
      .select({
        id: rooms.id,
        kind: rooms.kind,
        ownerId: rooms.ownerId,
        humanActorIds: rooms.humanActorIds,
      })
      .from(rooms)
      .where(eq(rooms.id, resolved.roomId))
      .limit(1);
    expect(room).toBeTruthy();
    expect(room!.kind).toBe("private");
    // Owned by the PEER (the only human member); requester is NOT a member.
    expect(room!.ownerId).toBe(peerUserId);
    expect(room!.humanActorIds).toEqual([peerActorId]);

    // Membership: exactly the requesting agent actor + the peer user actor.
    const members = await db
      .select({ actorId: roomMembers.actorId })
      .from(roomMembers)
      .where(eq(roomMembers.roomId, resolved.roomId));
    const memberSet = new Set(members.map((m) => m.actorId));
    expect(memberSet.has(agentActorId)).toBe(true);
    expect(memberSet.has(peerActorId)).toBe(true);
    expect(memberSet.size).toBe(2);

    // Persistence: target_room_id memoized + peer appended to target_user_ids.
    const after = await getTaskById(db, taskId);
    expect(after!.targetRoomId).toBe(resolved.roomId);
    expect(after!.targetUserIds).toContain(ownerUserId);
    expect(after!.targetUserIds).toContain(peerUserId);
  });

  test("new_dm: re-dispatch reuses the memoized target_room_id (no new room)", async () => {
    const taskId = await insertDmTask({ targetChat: "new_dm" });
    const first = await resolveTargetRoom((await getTaskById(db, taskId))!, { db });
    createdRoomIds.push(first.roomId);
    const second = await resolveTargetRoom((await getTaskById(db, taskId))!, { db });
    expect(second.roomId).toBe(first.roomId);
    expect(second.graphThreadId).toBe(botThreadId(first.roomId, agentId));
  });

  test("last_dm: reuses an existing requesting-agent↔peer DM", async () => {
    // First create one via new_dm.
    const seedTaskId = await insertDmTask({ targetChat: "new_dm" });
    const seeded = await resolveTargetRoom((await getTaskById(db, seedTaskId))!, { db });
    createdRoomIds.push(seeded.roomId);

    // A fresh last_dm task (no memoized room) must find + reuse that DM.
    const taskId = await insertDmTask({ targetChat: "last_dm" });
    const resolved = await resolveTargetRoom((await getTaskById(db, taskId))!, { db });
    expect(resolved.roomId).toBe(seeded.roomId);
    expect(resolved.createdHumanRoomMembers).toBeUndefined();
  });

  test("last_dm: does NOT reuse the peer's OWN DM with the peer's own agent", async () => {
    // The peer has their own Genie in a private DM. A different requesting
    // agent must not collide with it (findExistingDmRoom requires the
    // REQUESTING agent be a member, not just the peer).
    const [peerAgent] = await db
      .insert(agents)
      .values({ handle: `genie_peer_${randomUUID().replace(/-/g, "").slice(0, 10)}` })
      .returning({ id: agents.id });
    extraAgentIds.push(peerAgent!.id);
    const [peerAgentActor] = await db
      .insert(actors)
      .values({ ownerId: peerUserId, kind: "agent", displayName: "PeerGenie", trustState: "verified", agentId: peerAgent!.id })
      .returning({ id: actors.id });
    extraActorIds.push(peerAgentActor!.id);

    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: `m151-peerdm-${randomUUID().slice(0, 8)}` })
      .returning({ id: namespaces.id });
    createdNamespaceIds.push(ns!.id);
    const peerOwnRoomId = randomUUID();
    await db.insert(rooms).values({
      id: peerOwnRoomId,
      ownerId: peerUserId,
      type: "private",
      kind: "private",
      label: "Peer + own Genie",
      graphThreadId: `room:${peerOwnRoomId}`,
      namespaceId: ns!.id,
      humanActorIds: [peerActorId],
    });
    createdRoomIds.push(peerOwnRoomId);
    await db.insert(roomMembers).values({ roomId: peerOwnRoomId, actorId: peerActorId, roomRole: "admin" });
    await db.insert(roomMembers).values({ roomId: peerOwnRoomId, actorId: peerAgentActor!.id, roomRole: "member" });

    // last_dm for the REQUESTER's agent must NOT pick the peer-own room; it
    // creates a new DM with the requesting agent instead.
    const taskId = await insertDmTask({ targetChat: "last_dm" });
    const resolved = await resolveTargetRoom((await getTaskById(db, taskId))!, { db });
    createdRoomIds.push(resolved.roomId);
    expect(resolved.roomId).not.toBe(peerOwnRoomId);

    const members = await db
      .select({ actorId: roomMembers.actorId })
      .from(roomMembers)
      .where(eq(roomMembers.roomId, resolved.roomId));
    const memberSet = new Set(members.map((m) => m.actorId));
    expect(memberSet.has(agentActorId)).toBe(true); // the requesting agent
    expect(memberSet.has(peerAgentActor!.id)).toBe(false); // not the peer's agent
  });

  test("last_dm: does NOT reuse a multi-party 'private' group the peer merely belongs to", async () => {
    // Repro of the live bug: a 2-human-2-agent room is labelled kind='private'
    // by deriveInitialKind. A `@> [peer]` (contains) match falsely reused it,
    // so ask_peer posted into the requester's own multi-chat. The room must be
    // EXACTLY {requesting agent, peer} to be reused.
    const [requesterUserActor] = await db
      .insert(actors)
      .values({ ownerId: ownerUserId, kind: "user", displayName: "Requester", trustState: "verified" })
      .returning({ id: actors.id });
    extraActorIds.push(requesterUserActor!.id);

    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: `m151-multichat-${randomUUID().slice(0, 8)}` })
      .returning({ id: namespaces.id });
    createdNamespaceIds.push(ns!.id);
    const multiRoomId = randomUUID();
    await db.insert(rooms).values({
      id: multiRoomId,
      ownerId: ownerUserId,
      type: "private",
      kind: "private", // 2 humans + agent(s) → deriveInitialKind() also yields 'private'
      label: "Multi-chat",
      graphThreadId: `room:${multiRoomId}`,
      namespaceId: ns!.id,
      // BOTH the requester and the peer are humans here (not a 1:1 DM).
      humanActorIds: [requesterUserActor!.id, peerActorId].sort(),
    });
    createdRoomIds.push(multiRoomId);
    await db.insert(roomMembers).values({ roomId: multiRoomId, actorId: requesterUserActor!.id, roomRole: "admin" });
    await db.insert(roomMembers).values({ roomId: multiRoomId, actorId: peerActorId, roomRole: "member" });
    await db.insert(roomMembers).values({ roomId: multiRoomId, actorId: agentActorId, roomRole: "member" });

    const taskId = await insertDmTask({ targetChat: "last_dm" });
    const resolved = await resolveTargetRoom((await getTaskById(db, taskId))!, { db });
    createdRoomIds.push(resolved.roomId);
    // Must NOT reuse the multi-chat; must mint a fresh exact {agent, peer} DM.
    expect(resolved.roomId).not.toBe(multiRoomId);
    const [fresh] = await db
      .select({ humanActorIds: rooms.humanActorIds, ownerId: rooms.ownerId })
      .from(rooms)
      .where(eq(rooms.id, resolved.roomId))
      .limit(1);
    expect(fresh!.humanActorIds).toEqual([peerActorId]);
    expect(fresh!.ownerId).toBe(peerUserId);
  });

  test("unknown handle throws", async () => {
    const taskId = await insertDmTask({ targetChat: "new_dm", handle: "@nobody_xyz_404" });
    const task = (await getTaskById(db, taskId))!;
    return expect(resolveTargetRoom(task, { db })).rejects.toThrow(/unknown peer handle/);
  });

  test("missing handle throws", async () => {
    const taskId = await insertDmTask({ targetChat: "new_dm", handle: null });
    const task = (await getTaskById(db, taskId))!;
    return expect(resolveTargetRoom(task, { db })).rejects.toThrow(/missing target_chat_handle/);
  });
});
