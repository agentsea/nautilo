/**
 * M151 — `findAwaitingTaskForRoom` against live Postgres.
 *
 * Covers the await/resume reply-hook lookup: newest `awaiting` task + run
 * parked on a target room when `fromUserId` is the requester or a named peer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ensureDatabase,
  createDirectDb,
  eq,
  inArray,
  users,
  agents,
  namespaces,
  rooms,
  tasks,
  taskRuns,
  cryptoObjects,
  taskDefinitionCryptoRevisions,
  createTask,
  insertTaskRun,
  findAwaitingTaskForRoom,
  markTaskAwaitingWriterReview,
  clearTaskWriterReviewAwaitingMarker,
  listAwaitingWriterReviewTasks,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let db: ReturnType<typeof createDirectDb>;

const FAR_FUTURE = () => new Date(Date.now() + 3_600_000);

const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdNamespaceIds: string[] = [];
const createdRoomIds: string[] = [];
const createdTaskIds: string[] = [];
const createdObjectIds: string[] = [];

/** Seed a fresh user + agent; returns their ids. */
async function seedUserAndAgent(tag: string) {
  const ts = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const [user] = await db
    .insert(users)
    .values({ name: `m151-${tag}`, email: `m151-${tag}-${ts}@test.local` })
    .returning({ id: users.id });
  const [agent] = await db
    .insert(agents)
    .values({ handle: `m151-${tag}-${ts}` })
    .returning({ id: agents.id });
  if (!user || !agent) throw new Error("seed user/agent failed");
  createdUserIds.push(user.id);
  createdAgentIds.push(agent.id);
  return { userId: user.id, agentId: agent.id };
}

async function seedUserOnly(tag: string) {
  const ts = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const [user] = await db
    .insert(users)
    .values({ name: `m151-${tag}`, email: `m151-${tag}-${ts}@test.local` })
    .returning({ id: users.id });
  if (!user) throw new Error("seed user failed");
  createdUserIds.push(user.id);
  return user.id;
}

async function makeTargetRoom(ownerUserId: string, label: string): Promise<string> {
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "test", label: `m151-${label}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("namespace insert failed");
  createdNamespaceIds.push(ns.id);

  const [room] = await db
    .insert(rooms)
    .values({
      ownerId: ownerUserId,
      type: "private",
      label: `m151-${label}`,
      graphThreadId: `m151-room-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      namespaceId: ns.id,
      kind: "task",
    })
    .returning({ id: rooms.id });
  if (!room) throw new Error("room insert failed");
  createdRoomIds.push(room.id);
  return room.id;
}

interface AwaitingFixture {
  taskId: string;
  runId: string;
  graphThreadId: string;
}

async function insertAwaitingTaskForRoom(opts: {
  owner: { userId: string; agentId: string };
  roomId: string;
  requestorId: string;
  targetUserIds: string[];
  graphThreadId: string;
  runStartedAt?: Date;
  prompt?: string;
}): Promise<AwaitingFixture> {
  const task = await createTask(db, {
    ownerId: opts.owner.userId,
    requestorId: opts.requestorId,
    agentId: opts.owner.agentId,
    prompt: opts.prompt ?? "await probe",
    status: "awaiting",
    targetRoomId: opts.roomId,
    targetUserIds: opts.targetUserIds,
    nextFireAt: FAR_FUTURE(),
  });
  createdTaskIds.push(task.id);

  const run = await insertTaskRun(db, {
    taskId: task.id,
    graphThreadId: opts.graphThreadId,
    status: "awaiting",
    ...(opts.runStartedAt ? { startedAt: opts.runStartedAt } : {}),
  });

  return { taskId: task.id, runId: run.id, graphThreadId: opts.graphThreadId };
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(5);
});

afterAll(async () => {
  if (createdTaskIds.length > 0) {
    await db.delete(taskRuns).where(inArray(taskRuns.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
    await db.delete(taskDefinitionCryptoRevisions)
      .where(inArray(taskDefinitionCryptoRevisions.taskId, createdTaskIds));
  }
  if (createdObjectIds.length > 0) {
    await db.delete(cryptoObjects)
      .where(inArray(cryptoObjects.objectId, createdObjectIds));
  }
  for (const roomId of createdRoomIds) {
    await db.delete(rooms).where(eq(rooms.id, roomId));
  }
  for (const nsId of createdNamespaceIds) {
    await db.delete(namespaces).where(eq(namespaces.id, nsId));
  }
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
  for (const id of createdAgentIds) {
    await db.delete(agents).where(eq(agents.id, id));
  }
  await db.end();
});

describe("M151 — findAwaitingTaskForRoom (live PG)", () => {
  test("matches the awaiting task for the requester", async () => {
    const owner = await seedUserAndAgent("requester");
    const roomId = await makeTargetRoom(owner.userId, "requester-room");
    const fixture = await insertAwaitingTaskForRoom({
      owner,
      roomId,
      requestorId: owner.userId,
      targetUserIds: [],
      graphThreadId: "room:R:bot:A",
    });

    const found = await findAwaitingTaskForRoom(db, roomId, owner.userId);
    expect(found).toBeDefined();
    expect(found!.task.id).toBe(fixture.taskId);
    expect(found!.graphThreadId).toBe("room:R:bot:A");
    expect(found!.runId).toBe(fixture.runId);
    expect((await findAwaitingTaskForRoom(db, roomId, owner.userId, "ordinary"))?.task.id)
      .toBe(fixture.taskId);
    expect(await findAwaitingTaskForRoom(db, roomId, owner.userId, "protected"))
      .toBeUndefined();
  });

  test("matches when fromUserId is in target_user_ids (the ask_peer peer)", async () => {
    const owner = await seedUserAndAgent("peer-owner");
    const peerUserId = await seedUserOnly("peer");
    const roomId = await makeTargetRoom(owner.userId, "peer-room");
    const fixture = await insertAwaitingTaskForRoom({
      owner,
      roomId,
      requestorId: owner.userId,
      targetUserIds: [peerUserId],
      graphThreadId: "room:R:bot:peer",
    });

    const found = await findAwaitingTaskForRoom(db, roomId, peerUserId);
    expect(found).toBeDefined();
    expect(found!.task.id).toBe(fixture.taskId);
    expect(found!.graphThreadId).toBe("room:R:bot:peer");
    expect(found!.runId).toBe(fixture.runId);
  });

  test("returns undefined for a non-matching user", async () => {
    const owner = await seedUserAndAgent("nomatch-owner");
    const peerUserId = await seedUserOnly("nomatch-peer");
    const unrelatedUserId = await seedUserOnly("nomatch-unrelated");
    const roomId = await makeTargetRoom(owner.userId, "nomatch-room");
    await insertAwaitingTaskForRoom({
      owner,
      roomId,
      requestorId: owner.userId,
      targetUserIds: [peerUserId],
      graphThreadId: "room:R:bot:nomatch",
    });

    const found = await findAwaitingTaskForRoom(db, roomId, unrelatedUserId);
    expect(found).toBeUndefined();
  });

  test("returns undefined when the task is not awaiting", async () => {
    const owner = await seedUserAndAgent("not-awaiting");
    const roomId = await makeTargetRoom(owner.userId, "running-room");
    const task = await createTask(db, {
      ownerId: owner.userId,
      requestorId: owner.userId,
      agentId: owner.agentId,
      prompt: "running probe",
      status: "running",
      targetRoomId: roomId,
      nextFireAt: FAR_FUTURE(),
    });
    createdTaskIds.push(task.id);
    await insertTaskRun(db, {
      taskId: task.id,
      graphThreadId: "room:R:bot:running",
      status: "running",
    });

    const found = await findAwaitingTaskForRoom(db, roomId, owner.userId);
    expect(found).toBeUndefined();
  });

  test("returns undefined for the wrong room", async () => {
    const owner = await seedUserAndAgent("wrong-room");
    const roomId = await makeTargetRoom(owner.userId, "correct-room");
    await insertAwaitingTaskForRoom({
      owner,
      roomId,
      requestorId: owner.userId,
      targetUserIds: [],
      graphThreadId: "room:R:bot:wrong",
    });

    const found = await findAwaitingTaskForRoom(db, crypto.randomUUID(), owner.userId);
    expect(found).toBeUndefined();
  });

  test("returns the NEWEST awaiting task when two exist for the same (room,user)", async () => {
    const owner = await seedUserAndAgent("newest");
    const roomId = await makeTargetRoom(owner.userId, "newest-room");
    const olderStartedAt = new Date(Date.now() - 10_000);
    const newerStartedAt = new Date(Date.now() - 1_000);

    const older = await insertAwaitingTaskForRoom({
      owner,
      roomId,
      requestorId: owner.userId,
      targetUserIds: [],
      graphThreadId: "room:R:bot:older",
      runStartedAt: olderStartedAt,
    });
    const newer = await insertAwaitingTaskForRoom({
      owner,
      roomId,
      requestorId: owner.userId,
      targetUserIds: [],
      graphThreadId: "room:R:bot:newer",
      runStartedAt: newerStartedAt,
    });

    const found = await findAwaitingTaskForRoom(db, roomId, owner.userId);
    expect(found).toBeDefined();
    expect(found!.task.id).toBe(newer.taskId);
    expect(found!.graphThreadId).toBe("room:R:bot:newer");
    expect(found!.runId).toBe(newer.runId);
    expect(found!.task.id).not.toBe(older.taskId);
  });

  test("an encrypted wait cannot hide an older ordinary reply from Plain routing", async () => {
    const owner = await seedUserAndAgent("mixed-waits");
    const roomId = await makeTargetRoom(owner.userId, "mixed-waits-room");
    const older = await insertAwaitingTaskForRoom({
      owner, roomId, requestorId: owner.userId, targetUserIds: [],
      graphThreadId: "room:R:bot:ordinary-wait",
      runStartedAt: new Date(Date.now() - 10_000),
    });
    const newer = await insertAwaitingTaskForRoom({
      owner, roomId, requestorId: owner.userId, targetUserIds: [],
      graphThreadId: "room:R:bot:protected-wait",
      runStartedAt: new Date(Date.now() - 1_000), prompt: "",
    });
    const [room] = await db.select({ namespaceId: rooms.namespaceId })
      .from(rooms).where(eq(rooms.id, roomId)).limit(1);
    if (!room?.namespaceId) throw new Error("Protected wait Namespace missing");
    const digest = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    const objectId = `task-definition:v1:${digest}`;
    createdObjectIds.push(objectId);
    const fingerprint = new Uint8Array(32).fill(17);
    await db.insert(cryptoObjects).values({
      objectId,
      payloadHash: new Uint8Array(32).fill(18),
      payloadBytes: new Uint8Array([1]),
    });
    await db.insert(taskDefinitionCryptoRevisions).values({
      taskId: newer.taskId,
      contentNamespaceId: room.namespaceId,
      contentRevision: 1,
      operationId: `task-reply-routing:${crypto.randomUUID()}`,
      requestDigest: new Uint8Array(32).fill(19),
      authorityFingerprint: new Uint8Array(32).fill(20),
      requesterHumanId: owner.userId,
      anchorNamespaceId: room.namespaceId,
      cryptoObjectId: objectId,
      representation: "protected",
      requiredNamespaceFingerprint: fingerprint,
      completion: "complete",
      disposition: "mapped",
      cryptoCompletedAt: new Date(),
    });
    await db.update(tasks).set({
      contentRepresentation: "protected",
      contentNamespaceId: room.namespaceId,
      contentRevision: 1,
      cryptoObjectId: objectId,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: fingerprint,
      cryptoMappingState: "verified",
    }).where(eq(tasks.id, newer.taskId));

    expect((await findAwaitingTaskForRoom(db, roomId, owner.userId))?.task.id)
      .toBe(newer.taskId);
    expect((await findAwaitingTaskForRoom(db, roomId, owner.userId, "ordinary"))?.task.id)
      .toBe(older.taskId);
  });

  test("parks Writer review runs durably without letting room replies resume them", async () => {
    const owner = await seedUserAndAgent("writer-review");
    const roomId = await makeTargetRoom(owner.userId, "writer-review-room");
    const task = await createTask(db, {
      ownerId: owner.userId,
      requestorId: owner.userId,
      agentId: owner.agentId,
      prompt: "correct this document",
      status: "running",
      targetRoomId: roomId,
      nextFireAt: FAR_FUTURE(),
    });
    createdTaskIds.push(task.id);
    const run = await insertTaskRun(db, {
      taskId: task.id,
      graphThreadId: "room:R:bot:writer-review",
      status: "running",
    });
    expect(await markTaskAwaitingWriterReview(db, {
      taskId: task.id,
      taskRunId: run.id,
      proposalId: "proposal-1",
    })).toBe(true);
    expect(await findAwaitingTaskForRoom(db, roomId, owner.userId)).toBeUndefined();
    const parked = await listAwaitingWriterReviewTasks(db, { limit: 20 });
    expect(parked).toHaveLength(1);
    expect(parked[0]?.task.id).toBe(task.id);
    expect(parked[0]?.task.status).toBe("awaiting");
    expect(parked[0]?.run.id).toBe(run.id);
    expect(parked[0]?.run.status).toBe("awaiting");
    expect(parked[0]?.marker).toEqual({
      version: 1,
      taskRunId: run.id,
      proposalId: "proposal-1",
    });
    expect(await clearTaskWriterReviewAwaitingMarker(db, {
      taskId: task.id,
      taskRunId: run.id,
      proposalId: "proposal-1",
    })).toBe(true);
    expect((await findAwaitingTaskForRoom(db, roomId, owner.userId))?.task.id).toBe(task.id);
  });
});
