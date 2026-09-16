/**
 * M146 regression — `resolveTargetRoom(new_in_namespace)` against real PG.
 *
 * M144's `in_background` shortcut only ever used `target_chat:"orphan"`, so the
 * `new_in_namespace` engine path was UNEXERCISED until M146 made it reachable
 * from the low-level `task create`. A requester-only task has an empty
 * `targetUserIds`; `resolveNewInNamespace` must still include the owner's own
 * user actor in the member set, else `createRoomFromMembers` throws
 * "ownerActorId must appear in members" and the observer dispatch fails. This
 * test pins that fix.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createTask as dbCreateTask,
  rooms,
  roomMembers,
  namespaces,
  actors,
  eq,
  inArray,
  type DirectDatabase,
  type Task,
} from "@nautilo/db";
import { resolveTargetRoom } from "../../src/tasks/resolve-target-room";
import {
  setupTestDb,
  getDirectDb,
  closeDirectDb,
  cleanupTestUser,
} from "./helpers";
import { setupAgentTestEnv, closeAgentDb } from "./agent-helpers";

let db: DirectDatabase;
let userId: string;
let agentId: string;
let ownerUserActorId: string;
const createdRoomIds: string[] = [];
const createdNamespaceIds: string[] = [];

beforeAll(async () => {
  await setupTestDb();
  const env = await setupAgentTestEnv("m146-new-in-ns");
  userId = env.userId;
  agentId = env.agentId;
  db = getDirectDb();
  // setupAgentTestEnv seeds only the agent actor; the owner's own user actor
  // (present in production via redeem-invite) must be seeded for the
  // new_in_namespace resolver + createRoomFromMembers owner-membership check.
  const [ua] = await db
    .insert(actors)
    .values({
      ownerId: userId,
      kind: "user",
      displayName: "m146-owner-actor",
      trustState: "verified",
    })
    .returning({ id: actors.id });
  if (!ua) throw new Error("failed to seed owner user actor");
  ownerUserActorId = ua.id;
});

afterAll(async () => {
  if (createdRoomIds.length > 0) {
    await db.delete(roomMembers).where(inArray(roomMembers.roomId, createdRoomIds));
    await db.delete(rooms).where(inArray(rooms.id, createdRoomIds));
  }
  if (createdNamespaceIds.length > 0) {
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds));
  }
  await cleanupTestUser(userId);
  await closeAgentDb();
  await closeDirectDb();
});

describe("M146 — resolveTargetRoom(new_in_namespace) includes the owner", () => {
  test("requester-only task creates a room with the owner as a member", async () => {
    const task: Task = await dbCreateTask(db, {
      ownerId: userId,
      requestorId: userId,
      agentId,
      prompt: "fresh chat helper",
      targetChat: "new_in_namespace",
      scheduleKind: "now",
      nextFireAt: new Date(),
      status: "pending",
    });

    const resolved = await resolveTargetRoom(task, { db });
    expect(resolved.roomId).toBeTruthy();

    const [room] = await db
      .select({ id: rooms.id, ownerId: rooms.ownerId, namespaceId: rooms.namespaceId })
      .from(rooms)
      .where(eq(rooms.id, resolved.roomId))
      .limit(1);
    expect(room).toBeDefined();
    expect(room?.ownerId).toBe(userId);
    createdRoomIds.push(resolved.roomId);
    if (room?.namespaceId) createdNamespaceIds.push(room.namespaceId);

    const members = await db
      .select({ actorId: roomMembers.actorId })
      .from(roomMembers)
      .where(eq(roomMembers.roomId, resolved.roomId));
    const memberActorIds = members.map((m) => m.actorId);
    expect(memberActorIds).toContain(ownerUserActorId);
  });
});
