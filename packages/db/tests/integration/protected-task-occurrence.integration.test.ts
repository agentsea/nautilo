import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import {
  agents,
  claimDueProtectedTasks,
  createDirectDb,
  createTask,
  cryptoObjects,
  ensureDatabase,
  eq,
  getTaskById,
  getTaskRuns,
  inArray,
  listProtectedAwaitingTaskRunsForAuthorization,
  namespaces,
  prepareClaimedProtectedTaskOccurrence,
  taskDefinitionCryptoRevisions,
  tasks,
  users,
  type Task,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let db: ReturnType<typeof createDirectDb>;
const userIds: string[] = [];
const agentIds: string[] = [];
const namespaceIds: string[] = [];
const taskIds: string[] = [];
const objectIds: string[] = [];

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(8);
});

afterAll(async () => {
  if (taskIds.length > 0) await db.delete(tasks).where(inArray(tasks.id, taskIds));
  if (taskIds.length > 0) {
    await db.delete(taskDefinitionCryptoRevisions)
      .where(inArray(taskDefinitionCryptoRevisions.taskId, taskIds));
  }
  if (objectIds.length > 0) {
    await db.delete(cryptoObjects).where(inArray(cryptoObjects.objectId, objectIds));
  }
  if (namespaceIds.length > 0) {
    await db.delete(namespaces).where(inArray(namespaces.id, namespaceIds));
  }
  if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  if (agentIds.length > 0) await db.delete(agents).where(inArray(agents.id, agentIds));
  await db.end();
});

function objectId(): string {
  const digest = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
  return `task-definition:v1:${digest}`;
}

async function createOwner(tag: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await db.insert(users).values({
    name: `Protected occurrence ${tag}`,
    email: `protected-occurrence-${tag}-${suffix}@test.local`,
  }).returning({ id: users.id });
  const [agent] = await db.insert(agents).values({
    handle: `protected-occurrence-${tag}-${suffix}`,
  }).returning({ id: agents.id });
  if (!user || !agent) throw new Error("Protected occurrence owner seed failed");
  userIds.push(user.id);
  agentIds.push(agent.id);
  return { userId: user.id, agentId: agent.id };
}

async function createProtectedTask(input: Readonly<{
  tag: string;
  representation?: "dual" | "protected";
  scheduleKind?: "now" | "one_shot" | "cron";
  scheduledFor: Date;
}>): Promise<Task> {
  const owner = await createOwner(input.tag);
  const representation = input.representation ?? "protected";
  const scheduleKind = input.scheduleKind ?? "one_shot";
  const [namespace] = await db.insert(namespaces).values({
    scope: "private",
    label: `Protected occurrence ${input.tag}`,
  }).returning({ id: namespaces.id });
  if (!namespace) throw new Error("Protected occurrence Namespace seed failed");
  namespaceIds.push(namespace.id);

  const task = await createTask(db, {
    ownerId: owner.userId,
    requestorId: owner.userId,
    agentId: owner.agentId,
    prompt: representation === "protected" ? "" : `brief ${input.tag}`,
    scheduleKind,
    ...(scheduleKind === "cron" ? { cron: "* * * * *" } : {}),
    nextFireAt: input.scheduledFor,
    status: "pending",
  });
  taskIds.push(task.id);
  const cryptoObjectId = objectId();
  objectIds.push(cryptoObjectId);
  const fingerprint = new Uint8Array(32).fill(0x31);
  await db.insert(cryptoObjects).values({
    objectId: cryptoObjectId,
    payloadHash: new Uint8Array(32).fill(0x32),
    payloadBytes: new Uint8Array([1]),
  });
  await db.insert(taskDefinitionCryptoRevisions).values({
    taskId: task.id,
    contentNamespaceId: namespace.id,
    contentRevision: 1,
    operationId: `task-occurrence:${randomUUID()}`,
    requestDigest: new Uint8Array(32).fill(0x33),
    authorityFingerprint: new Uint8Array(32).fill(0x34),
    requesterHumanId: owner.userId,
    anchorNamespaceId: namespace.id,
    cryptoObjectId,
    representation,
    requiredNamespaceFingerprint: fingerprint,
    completion: "complete",
    disposition: "mapped",
    nextAttemptAt: null,
    cryptoCompletedAt: new Date(),
  });
  const [protectedTask] = await db.update(tasks).set({
    contentRepresentation: representation,
    contentNamespaceId: namespace.id,
    contentRevision: 1,
    cryptoObjectId,
    cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: fingerprint,
    cryptoMappingState: "verified",
  }).where(eq(tasks.id, task.id)).returning();
  if (!protectedTask) throw new Error("Protected occurrence Task seed failed");
  return protectedTask;
}

function preparation(
  task: Task,
  scheduledFor: Date,
  overrides: Partial<Parameters<typeof prepareClaimedProtectedTaskOccurrence>[1]> = {},
) {
  if (
    !task.fireLockId
    || !task.contentNamespaceId
    || !task.cryptoObjectId
    || !task.cryptoRequiredNamespaceFingerprint
    || task.contentRepresentation === "ordinary"
  ) throw new Error("Task is not an exact claimed protected fixture");
  return {
    taskId: task.id,
    fireLockId: task.fireLockId,
    contentRepresentation: task.contentRepresentation,
    contentNamespaceId: task.contentNamespaceId,
    contentRevision: task.contentRevision,
    cryptoObjectId: task.cryptoObjectId,
    cryptoRequiredNamespaceFingerprint: task.cryptoRequiredNamespaceFingerprint,
    scheduledFor,
    taskRunId: randomUUID(),
    graphThreadId: `subagent:protected-task:${randomUUID()}`,
    ...overrides,
  };
}

describe("protected Task occurrence persistence", () => {
  test("protected claims exclude Plain and non-current protected rows", async () => {
    const now = new Date();
    const protectedTask = await createProtectedTask({ tag: "claim", scheduledFor: now });
    const dualTask = await createProtectedTask({ tag: "dual", representation: "dual", scheduledFor: now });
    const staleTask = await createProtectedTask({ tag: "stale", scheduledFor: now });
    await db.update(tasks).set({ cryptoMappingState: "stale" }).where(eq(tasks.id, staleTask.id));
    const owner = await createOwner("plain");
    const plain = await createTask(db, {
      ownerId: owner.userId,
      requestorId: owner.userId,
      agentId: owner.agentId,
      prompt: "plain",
      nextFireAt: now,
      status: "pending",
    });
    taskIds.push(plain.id);

    const claimed = await claimDueProtectedTasks(db, now, 10);
    expect(new Set(claimed.map((task) => task.id)))
      .toEqual(new Set([protectedTask.id, dualTask.id]));
    expect((await getTaskById(db, plain.id))?.fireLockId).toBeNull();
    expect((await getTaskById(db, staleTask.id))?.fireLockId).toBeNull();
  });

  test("concurrent observers claim disjoint protected Tasks", async () => {
    const now = new Date();
    const first = await createProtectedTask({ tag: "disjoint-a", scheduledFor: now });
    const second = await createProtectedTask({ tag: "disjoint-b", scheduledFor: now });
    const [left, right] = await Promise.all([
      claimDueProtectedTasks(db, now, 1),
      claimDueProtectedTasks(db, now, 1),
    ]);
    expect(left).toHaveLength(1);
    expect(right).toHaveLength(1);
    expect(left[0]?.id).not.toBe(right[0]?.id);
    expect(new Set([left[0]?.id, right[0]?.id]))
      .toEqual(new Set([first.id, second.id]));
  });

  test("stale lock or changed mapping inserts no TaskRun", async () => {
    const scheduledFor = new Date();
    const staleLock = await createProtectedTask({ tag: "stale-lock", scheduledFor });
    const [claimedLock] = await claimDueProtectedTasks(db, scheduledFor, 1);
    if (!claimedLock || claimedLock.id !== staleLock.id) throw new Error("Expected stale-lock claim");
    const lockResult = await prepareClaimedProtectedTaskOccurrence(db, preparation(
      claimedLock,
      scheduledFor,
      { fireLockId: randomUUID() },
    ));
    expect(lockResult.status).toBe("stale");
    expect(await getTaskRuns(db, staleLock.id)).toHaveLength(0);

    const changed = await createProtectedTask({ tag: "changed-map", scheduledFor });
    const [claimedChanged] = await claimDueProtectedTasks(db, scheduledFor, 1);
    if (!claimedChanged || claimedChanged.id !== changed.id) throw new Error("Expected changed-map claim");
    await db.update(tasks).set({ cryptoMappingState: "stale" }).where(eq(tasks.id, changed.id));
    const changedResult = await prepareClaimedProtectedTaskOccurrence(
      db,
      preparation(claimedChanged, scheduledFor),
    );
    expect(changedResult.status).toBe("stale");
    expect(await getTaskRuns(db, changed.id)).toHaveLength(0);
  });

  test("concurrent preparation consumes one exact claim once", async () => {
    const scheduledFor = new Date();
    const task = await createProtectedTask({ tag: "prepare-cas", scheduledFor });
    const [claimed] = await claimDueProtectedTasks(db, scheduledFor, 1);
    if (!claimed || claimed.id !== task.id) throw new Error("Expected preparation claim");
    const input = preparation(claimed, scheduledFor);
    const [first, second] = await Promise.all([
      prepareClaimedProtectedTaskOccurrence(db, input),
      prepareClaimedProtectedTaskOccurrence(db, { ...input, taskRunId: randomUUID() }),
    ]);
    expect([first.status, second.status].sort()).toEqual(["prepared", "stale"]);
    expect(await getTaskRuns(db, task.id)).toHaveLength(1);
    const current = await getTaskById(db, task.id);
    expect(current?.status).toBe("awaiting");
    expect(current?.nextFireAt).toBeNull();
    expect(current?.fireLockId).toBeNull();
    expect(current?.lastFiredAt?.toISOString()).toBe(scheduledFor.toISOString());
  });

  test("cron advances atomically and gives each due fire a distinct run", async () => {
    const firstFire = new Date("2026-09-23T10:00:00.000Z");
    const secondFire = new Date("2026-09-23T10:01:00.000Z");
    const thirdFire = new Date("2026-09-23T10:02:00.000Z");
    const task = await createProtectedTask({
      tag: "cron-fires",
      scheduleKind: "cron",
      scheduledFor: firstFire,
    });
    const [firstClaim] = await claimDueProtectedTasks(db, firstFire, 1);
    if (!firstClaim || firstClaim.id !== task.id) throw new Error("Expected first cron claim");
    const firstRunId = randomUUID();
    const first = await prepareClaimedProtectedTaskOccurrence(db, preparation(
      firstClaim,
      firstFire,
      { taskRunId: firstRunId, cronNextFireAt: secondFire },
    ));
    expect(first.status).toBe("prepared");
    expect(first.status === "prepared" && first.task.status).toBe("pending");

    const [secondClaim] = await claimDueProtectedTasks(db, secondFire, 1);
    if (!secondClaim || secondClaim.id !== task.id) throw new Error("Expected second cron claim");
    const secondRunId = randomUUID();
    const second = await prepareClaimedProtectedTaskOccurrence(db, preparation(
      secondClaim,
      secondFire,
      { taskRunId: secondRunId, cronNextFireAt: thirdFire },
    ));
    expect(second.status).toBe("prepared");
    const runs = await getTaskRuns(db, task.id);
    expect(new Set(runs.map((run) => run.id)))
      .toEqual(new Set([firstRunId, secondRunId]));
    expect(runs.every((run) => run.status === "awaiting" && run.resultText === null)).toBe(true);
    const current = await getTaskById(db, task.id);
    expect(current?.nextFireAt?.toISOString()).toBe(thirdFire.toISOString());
    expect(current?.lastFiredAt?.toISOString()).toBe(secondFire.toISOString());
    expect(current?.fireLockId).toBeNull();
  });

  test("restart discovery keeps cron occurrences distinct and excludes parked parents", async () => {
    const firstFire = new Date("2026-09-23T09:00:00.000Z");
    const secondFire = new Date("2026-09-23T09:01:00.000Z");
    const thirdFire = new Date("2026-09-23T09:02:00.000Z");
    const task = await createProtectedTask({
      tag: "restart-discovery",
      scheduleKind: "cron",
      scheduledFor: firstFire,
    });
    const [firstClaim] = await claimDueProtectedTasks(db, firstFire, 1);
    if (!firstClaim || firstClaim.id !== task.id) throw new Error("Expected first restart claim");
    const firstRunId = randomUUID();
    await prepareClaimedProtectedTaskOccurrence(db, preparation(firstClaim, firstFire, {
      taskRunId: firstRunId,
      cronNextFireAt: secondFire,
    }));
    const [secondClaim] = await claimDueProtectedTasks(db, secondFire, 1);
    if (!secondClaim || secondClaim.id !== task.id) throw new Error("Expected second restart claim");
    const secondRunId = randomUUID();
    await prepareClaimedProtectedTaskOccurrence(db, preparation(secondClaim, secondFire, {
      taskRunId: secondRunId,
      cronNextFireAt: thirdFire,
    }));

    const discoverable = await listProtectedAwaitingTaskRunsForAuthorization(db, 100);
    const discoveredIds = new Set(discoverable.map(({ run }) => run.id));
    expect(discoveredIds.has(firstRunId)).toBe(true);
    expect(discoveredIds.has(secondRunId)).toBe(true);
    expect(discoverable.find(({ run }) => run.id === firstRunId)?.task.id).toBe(task.id);
    expect(discoverable.find(({ run }) => run.id === secondRunId)?.task.id).toBe(task.id);
    const firstIndex = discoverable.findIndex(({ run }) => run.id === firstRunId);
    const secondIndex = discoverable.findIndex(({ run }) => run.id === secondRunId);
    const earlier = discoverable[Math.min(firstIndex, secondIndex)];
    const laterId = firstIndex < secondIndex ? secondRunId : firstRunId;
    if (!earlier) throw new Error("Expected an earlier restart occurrence");
    const afterEarlier = await listProtectedAwaitingTaskRunsForAuthorization(db, 100, {
      taskRunId: earlier.run.id,
    });
    expect(afterEarlier.some(({ run }) => run.id === earlier.run.id)).toBe(false);
    expect(afterEarlier.some(({ run }) => run.id === laterId)).toBe(true);

    await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, task.id));
    const pausedIds = new Set(
      (await listProtectedAwaitingTaskRunsForAuthorization(db, 100)).map(({ run }) => run.id),
    );
    expect(pausedIds.has(firstRunId)).toBe(false);
    expect(pausedIds.has(secondRunId)).toBe(false);

    await db.update(tasks).set({ status: "cancelled" }).where(eq(tasks.id, task.id));
    const cancelledIds = new Set(
      (await listProtectedAwaitingTaskRunsForAuthorization(db, 100)).map(({ run }) => run.id),
    );
    expect(cancelledIds.has(firstRunId)).toBe(false);
    expect(cancelledIds.has(secondRunId)).toBe(false);
  });
});
