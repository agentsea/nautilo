/**
 * M145 regression — `resolveTargetRoom` `last_in_namespace` actor resolution
 * against real Postgres.
 *
 * Guards the array-binding fix in `resolve-target-room.ts`: the previous
 * `ANY(${task.targetUserIds}::uuid[])` form bound the uuid[] list as a bare
 * scalar param and threw Postgres "malformed array literal", so any task with a
 * non-empty `target_user_ids` and `target_chat:"last_in_namespace"` failed to
 * dispatch. `last_in_namespace` was unexercised until M145's `schedule` shortcut
 * became its first consumer. This proves the resolver:
 *   - returns the most-recent owner room whose `human_actor_ids` contains the
 *     target user's actor (the bot thread for that room), and
 *   - does NOT throw on a single-element target list (the failing shape).
 */

import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  tasks,
  taskRuns,
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

let userId: string;
let agentId: string;
let userActorId: string;
let agentActorId: string;
let db: DirectDatabase;

const createdRoomIds: string[] = [];
const createdNamespaceIds: string[] = [];
const createdTaskIds: string[] = [];

beforeAll(async () => {
  await setupTestDb();
  const env = await setupAgentTestEnv("m145-resolve-ns");
  userId = env.userId;
  agentId = env.agentId;
  db = getDirectDb();

  const [aa] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.agentId, agentId), eq(actors.kind, "agent")))
    .limit(1);
  if (!aa) throw new Error("m145-resolve-ns: agent actor missing");
  agentActorId = aa.id;

  const [ua] = await db
    .insert(actors)
    .values({ ownerId: userId, kind: "user", displayName: "Owner", trustState: "verified" })
    .returning({ id: actors.id });
  userActorId = ua!.id;
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
  await db
    .delete(actors)
    .where(and(eq(actors.id, userActorId)));
  for (const nid of createdNamespaceIds) {
    await db.delete(namespaces).where(eq(namespaces.id, nid));
  }
  await cleanupTestUser(userId);
  await closeDirectDb();
  await closeAgentDb();
});

async function makeRoom(
  label: string,
  options: {
    kind?: "private" | "access";
    includeAgent?: boolean;
  } = {},
): Promise<string> {
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m145-rtr-${label}-${randomUUID().slice(0, 8)}` })
    .returning({ id: namespaces.id });
  createdNamespaceIds.push(ns!.id);
  const roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    ownerId: userId,
    type: "private",
    kind: options.kind ?? "private",
    label,
    graphThreadId: `room:${roomId}`,
    namespaceId: ns!.id,
    humanActorIds: [userActorId],
  });
  createdRoomIds.push(roomId);
  await db.insert(roomMembers).values({ roomId, actorId: userActorId, roomRole: "admin" });
  if (options.includeAgent !== false) {
    await db.insert(roomMembers).values({ roomId, actorId: agentActorId, roomRole: "member" });
  }
  return roomId;
}

async function insertLastInNamespaceTask(): Promise<string> {
  const row = await dbCreateTask(db, {
    ownerId: userId,
    requestorId: userId,
    agentId,
    prompt: "resolve probe",
    scheduleKind: "one_shot",
    runAt: new Date(Date.now() + 60_000),
    targetChat: "last_in_namespace",
    toolsMode: "auto",
    targetUserIds: [userId],
    nextFireAt: new Date(Date.now() + 60_000),
    status: "pending",
  });
  createdTaskIds.push(row.id);
  return row.id;
}

describe("M145 — resolveTargetRoom last_in_namespace (live PG)", () => {
  test("resolves to the most-recent owner room containing the target user's actor (single-element list does not throw)", async () => {
    await makeRoom("older");
    const newer = await makeRoom("newer");

    const taskId = await insertLastInNamespaceTask();
    const task = await getTaskById(db, taskId);

    const resolved = await resolveTargetRoom(task!, { db });

    // Most recent matching room wins (ordered by created_at DESC).
    expect(resolved.roomId).toBe(newer);
    expect(resolved.graphThreadId).toBe(botThreadId(newer, agentId));
  });

  test("skips newer internal and non-member Rooms", async () => {
    const eligible = await makeRoom("eligible conversation");
    await makeRoom("newer hidden access projection", { kind: "access" });
    await makeRoom("newer conversation for another Genie", { includeAgent: false });

    const taskId = await insertLastInNamespaceTask();
    const task = await getTaskById(db, taskId);

    const resolved = await resolveTargetRoom(task!, { db });

    expect(resolved.roomId).toBe(eligible);
    expect(resolved.graphThreadId).toBe(botThreadId(eligible, agentId));
  });
});
