import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  agents,
  createDirectDb,
  cryptoObjects,
  eq,
  jobs,
  namespaces,
  protectedTaskContinuationReceipts,
  protectedTaskExecutionSegmentReceipts,
  resolveAppDatabaseConnectionString,
  sealAndParkProtectedTaskRun,
  sql,
  taskDefinitionCryptoRevisions,
  taskRuns,
  tasks,
  transitionTaskLifecycleTerminal,
  users,
  type ProtectedTaskDurableJobReference,
  type SealAndParkProtectedTaskRunInput,
} from "@nautilo/db";
import { protectedTaskRunResultObjectId } from
  "../../src/queries/protected-task-output-binding-identities";
import * as schema from "../../src/schema/index";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

type AdminDb = ReturnType<typeof createDirectDb>;
type ProductDb = ReturnType<typeof createProductDb>;

type Fixture = Readonly<{
  userId: string;
  agentId: string;
  namespaceId: string;
  taskId: string;
  taskRunId: string;
  jobId: string;
  cryptoObjectId: string;
  graphThreadId: string;
  jobReference: ProtectedTaskDurableJobReference;
}>;

let admin: AdminDb;
let productA: ProductDb;
let productB: ProductDb;

function createProductDb() {
  const client = postgres(resolveAppDatabaseConnectionString(), { max: 1 });
  return Object.assign(drizzle(client, { schema }), {
    end: () => client.end({ timeout: 1 }),
  });
}

beforeAll(() => {
  bootstrapTestDbInstance();
  admin = createDirectDb(2);
  productA = createProductDb();
  productB = createProductDb();
});

afterAll(async () => {
  await Promise.all([productA.end(), productB.end(), admin.end()]);
});

function fixtureIds(): Fixture {
  const taskId = randomUUID();
  const taskRunId = randomUUID();
  const digest = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
  const cryptoObjectId = `task-definition:v1:${digest}`;
  return Object.freeze({
    userId: randomUUID(),
    agentId: randomUUID(),
    namespaceId: randomUUID(),
    taskId,
    taskRunId,
    jobId: randomUUID(),
    cryptoObjectId,
    graphThreadId: `subagent:task-seal-and-park:${taskRunId}`,
    jobReference: Object.freeze({
      kind: "protected_task_run_v1" as const,
      taskId,
      taskRunId,
      inputObjectId: cryptoObjectId,
      resultObjectId: protectedTaskRunResultObjectId(taskId, taskRunId),
      authorizationRequestId: `task-run-authorization:${taskRunId}`,
      policyRevision: 1,
      executionSegment: 1,
    }),
  });
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await admin.delete(tasks).where(eq(tasks.id, fixture.taskId));
  await admin.delete(taskRuns).where(eq(taskRuns.id, fixture.taskRunId));
  await admin.delete(jobs).where(eq(jobs.id, fixture.jobId));
  await admin.delete(taskDefinitionCryptoRevisions).where(eq(
    taskDefinitionCryptoRevisions.taskId,
    fixture.taskId,
  ));
  await admin.delete(cryptoObjects).where(eq(
    cryptoObjects.objectId,
    fixture.cryptoObjectId,
  ));
  await admin.delete(namespaces).where(eq(namespaces.id, fixture.namespaceId));
  await admin.delete(users).where(eq(users.id, fixture.userId));
  await admin.delete(agents).where(eq(agents.id, fixture.agentId));
}

async function createFixture(options: Readonly<{
  startedJob?: boolean;
}> = {}): Promise<Fixture> {
  const fixture = fixtureIds();
  const fingerprint = new Uint8Array(32).fill(0x41);
  try {
    await admin.insert(users).values({
      id: fixture.userId,
      name: "Protected Task atomic park fixture",
      email: `task-atomic-park-${fixture.userId}@test.local`,
    });
    await admin.insert(agents).values({
      id: fixture.agentId,
      handle: `task-atomic-park-${fixture.agentId}`,
    });
    await admin.insert(namespaces).values({
      id: fixture.namespaceId,
      scope: "private",
      label: "Protected Task atomic park fixture",
    });
    await admin.insert(tasks).values({
      id: fixture.taskId,
      ownerId: fixture.userId,
      requestorId: fixture.userId,
      agentId: fixture.agentId,
      prompt: "",
      expectedOutput: null,
      status: "running",
    });
    await admin.insert(cryptoObjects).values({
      objectId: fixture.cryptoObjectId,
      payloadHash: new Uint8Array(32).fill(0x42),
      payloadBytes: new Uint8Array([1]),
    });
    await admin.insert(taskDefinitionCryptoRevisions).values({
      taskId: fixture.taskId,
      contentNamespaceId: fixture.namespaceId,
      contentRevision: 1,
      operationId: `task-atomic-park:${fixture.taskId}`,
      requestDigest: new Uint8Array(32).fill(0x43),
      authorityFingerprint: new Uint8Array(32).fill(0x44),
      requesterHumanId: fixture.userId,
      anchorNamespaceId: fixture.namespaceId,
      cryptoObjectId: fixture.cryptoObjectId,
      representation: "protected",
      requiredNamespaceFingerprint: fingerprint,
      completion: "complete",
      disposition: "mapped",
      nextAttemptAt: null,
      cryptoCompletedAt: new Date(),
    });
    await admin.update(tasks).set({
      contentRepresentation: "protected",
      contentNamespaceId: fixture.namespaceId,
      contentRevision: 1,
      cryptoObjectId: fixture.cryptoObjectId,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: fingerprint,
      cryptoMappingState: "verified",
    }).where(eq(tasks.id, fixture.taskId));
    await admin.insert(jobs).values({
      id: fixture.jobId,
      ownerId: fixture.userId,
      requestorId: fixture.userId,
      laneKey: `task:${fixture.taskId}`,
      type: "foreground",
      status: "running",
      input: fixture.jobReference,
      startedAt: options.startedJob === false
        ? null
        : new Date("2026-10-07T12:00:00.000Z"),
    });
    await admin.insert(taskRuns).values({
      id: fixture.taskRunId,
      taskId: fixture.taskId,
      jobId: fixture.jobId,
      graphThreadId: fixture.graphThreadId,
      status: "running",
    });
    return fixture;
  } catch (error) {
    await cleanupFixture(fixture);
    throw error;
  }
}

function input(fixture: Fixture): SealAndParkProtectedTaskRunInput {
  return {
    park: {
      taskId: fixture.taskId,
      taskRunId: fixture.taskRunId,
      graphThreadId: fixture.graphThreadId,
      jobId: fixture.jobId,
      generation: 1,
      executionSegment: 1,
      interrupts: [{
        id: "interrupt:authority:1",
        kind: "additional_authority",
        requestId: "authority-request:1",
      }],
      parkedAt: new Date("2026-10-07T12:34:56.000Z"),
      jobReference: fixture.jobReference,
    },
    segment: {
      route: "native_langgraph_v1",
      checkpoint: {
        contract: "encrypted_langgraph_v1",
        expectedCheckpointCount: 1,
        checkpointOrderedDigest: new Uint8Array(32).fill(0x51),
        expectedBlobCount: 1,
        blobOrderedDigest: new Uint8Array(32).fill(0x52),
        expectedPendingWriteCount: 0,
        pendingWriteOrderedDigest: new Uint8Array(32).fill(0x55),
      },
    },
    continuation: {
      kind: "pre_effect_interrupt_v1",
      reason: "additional_authority",
      effectDisposition: "not_started_v1",
      interruptId: "interrupt:authority:1",
      operationId: "task-effect:1",
      requestDigest: new Uint8Array(32).fill(0x53),
      requiredAuthorityDigest: new Uint8Array(32).fill(0x54),
    },
  };
}

test("product role atomically seals and parks one exact protected execution segment", async () => {
  const fixture = await createFixture();
  try {
    const identities = await Promise.all([productA, productB].map(db => db.execute(sql`
      SELECT current_user::text AS current_user
    `)));
    expect(identities.map(rows => rows[0]?.["current_user"]))
      .toEqual(["nautilo", "nautilo"]);

    const results = await Promise.all([
      sealAndParkProtectedTaskRun(productA, input(fixture)),
      sealAndParkProtectedTaskRun(productB, input(fixture)),
    ]);
    expect(results.map(result => result.status).sort())
      .toEqual(["exact_replay", "parked"]);

    expect(await productA.select().from(protectedTaskExecutionSegmentReceipts)
      .where(eq(
        protectedTaskExecutionSegmentReceipts.taskRunId,
        fixture.taskRunId,
      ))).toHaveLength(1);
    expect(await productA.select().from(protectedTaskContinuationReceipts)
      .where(eq(
        protectedTaskContinuationReceipts.taskRunId,
        fixture.taskRunId,
      ))).toHaveLength(1);
    const [persistedRun] = await productA.select().from(taskRuns)
      .where(eq(taskRuns.id, fixture.taskRunId)).limit(1);
    const [persistedJob] = await productA.select().from(jobs)
      .where(eq(jobs.id, fixture.jobId)).limit(1);
    expect(persistedRun?.status).toBe("awaiting");
    expect(persistedJob?.status).toBe("completed");
  } finally {
    await cleanupFixture(fixture);
  }
});

test("a late park rejection rolls back product-role immutable receipt inserts", async () => {
  const fixture = await createFixture({ startedJob: false });
  try {
    expect(await sealAndParkProtectedTaskRun(productA, input(fixture))).toEqual({
      status: "rejected",
      stage: "park",
      reason: "stale",
    });
    expect(await productA.select().from(protectedTaskExecutionSegmentReceipts)
      .where(eq(
        protectedTaskExecutionSegmentReceipts.taskRunId,
        fixture.taskRunId,
      ))).toEqual([]);
    expect(await productA.select().from(protectedTaskContinuationReceipts)
      .where(eq(
        protectedTaskContinuationReceipts.taskRunId,
        fixture.taskRunId,
      ))).toEqual([]);
    const [persistedRun] = await productA.select().from(taskRuns)
      .where(eq(taskRuns.id, fixture.taskRunId)).limit(1);
    const [persistedJob] = await productA.select().from(jobs)
      .where(eq(jobs.id, fixture.jobId)).limit(1);
    expect(persistedRun?.status).toBe("running");
    expect(persistedJob?.status).toBe("running");
    expect(persistedJob?.completedAt).toBeNull();
  } finally {
    await cleanupFixture(fixture);
  }
});

test("conflicting checkpoint digests race on independent product transactions", async () => {
  const fixture = await createFixture();
  try {
    const left = input(fixture);
    const right: SealAndParkProtectedTaskRunInput = {
      ...input(fixture),
      segment: {
        ...input(fixture).segment,
        checkpoint: {
          ...input(fixture).segment.checkpoint,
          checkpointOrderedDigest: new Uint8Array(32).fill(0x61),
        },
      },
    };
    const results = await Promise.all([
      sealAndParkProtectedTaskRun(productA, left),
      sealAndParkProtectedTaskRun(productB, right),
    ]);
    expect(results.filter(result => result.status === "parked")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected"))
      .toEqual([{ status: "rejected", stage: "segment", reason: "conflict" }]);

    const segments = await productA.select()
      .from(protectedTaskExecutionSegmentReceipts)
      .where(eq(
        protectedTaskExecutionSegmentReceipts.taskRunId,
        fixture.taskRunId,
      ));
    const continuations = await productA.select()
      .from(protectedTaskContinuationReceipts)
      .where(eq(
        protectedTaskContinuationReceipts.taskRunId,
        fixture.taskRunId,
      ));
    expect(segments).toHaveLength(1);
    expect(continuations).toHaveLength(1);
    expect([
      left.segment.checkpoint.checkpointOrderedDigest,
      right.segment.checkpoint.checkpointOrderedDigest,
    ]).toContainEqual(segments[0]!.checkpointDigest);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("cancellation and atomic park serialize without retaining loser receipts", async () => {
  const fixture = await createFixture();
  try {
    const cancelledAt = new Date("2026-10-07T12:34:56.000Z");
    const [parkResult, cancellationResult] = await Promise.all([
      sealAndParkProtectedTaskRun(productA, input(fixture)),
      transitionTaskLifecycleTerminal(productB, {
        taskId: fixture.taskId,
        taskStatus: "cancelled",
        taskPatch: { cancelledAt },
        runId: fixture.taskRunId,
        runStatus: "cancelled",
        runPatch: { completedAt: cancelledAt },
        requireRunningPair: true,
      }),
    ]);
    const segments = await productA.select()
      .from(protectedTaskExecutionSegmentReceipts)
      .where(eq(
        protectedTaskExecutionSegmentReceipts.taskRunId,
        fixture.taskRunId,
      ));
    const continuations = await productA.select()
      .from(protectedTaskContinuationReceipts)
      .where(eq(
        protectedTaskContinuationReceipts.taskRunId,
        fixture.taskRunId,
      ));

    if (parkResult.status === "parked") {
      expect(cancellationResult).toMatchObject({
        transitioned: false,
        outcome: "not_running",
      });
      expect(segments).toHaveLength(1);
      expect(continuations).toHaveLength(1);
    } else {
      expect(parkResult).toEqual({
        status: "rejected",
        stage: "park",
        reason: "stale",
      });
      expect(cancellationResult).toMatchObject({
        transitioned: true,
        outcome: "transitioned",
      });
      expect(segments).toEqual([]);
      expect(continuations).toEqual([]);
    }
  } finally {
    await cleanupFixture(fixture);
  }
});
