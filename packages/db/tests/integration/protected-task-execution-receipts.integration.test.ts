import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import {
  __resetSharedDirectDbForTests,
  agents,
  createDirectDb,
  cryptoObjects,
  eq,
  getSharedDirectDb,
  jobs,
  namespaces,
  protectedTaskContinuationReceipts,
  protectedTaskExecutionSegmentReceipts,
  readProtectedTaskExecutionContinuationProof,
  sealProtectedTaskContinuationReceipt,
  sealProtectedTaskExecutionSegmentReceipt,
  sql,
  taskDefinitionCryptoRevisions,
  taskRuns,
  tasks,
  users,
  type SealProtectedTaskContinuationReceiptInput,
  type SealProtectedTaskExecutionSegmentReceiptInput,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

type AdminDb = ReturnType<typeof createDirectDb>;
type ProductDb = ReturnType<typeof getSharedDirectDb>;

type Fixture = Readonly<{
  userId: string;
  agentId: string;
  namespaceId: string;
  taskId: string;
  taskRunId: string;
  jobId: string;
  staleJobId: string;
  cryptoObjectId: string;
}>;
type CheckpointContinuationInput = Extract<
  SealProtectedTaskContinuationReceiptInput,
  { kind: "checkpoint_safe_v1" }
>;

let admin: AdminDb;
let product: ProductDb;

beforeAll(() => {
  bootstrapTestDbInstance();
  admin = createDirectDb(2);
  product = getSharedDirectDb();
});

afterAll(async () => {
  await __resetSharedDirectDbForTests();
  await admin.end();
});

function fixtureIds(): Fixture {
  const digest = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
  return Object.freeze({
    userId: randomUUID(),
    agentId: randomUUID(),
    namespaceId: randomUUID(),
    taskId: randomUUID(),
    taskRunId: randomUUID(),
    jobId: randomUUID(),
    staleJobId: randomUUID(),
    cryptoObjectId: `task-definition:v1:${digest}`,
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

async function createFixture(): Promise<Fixture> {
  const fixture = fixtureIds();
  const fingerprint = new Uint8Array(32).fill(0x41);
  try {
    await admin.insert(users).values({
      id: fixture.userId,
      name: "Protected Task receipt fixture",
      email: `task-receipt-${fixture.userId}@test.local`,
    });
    await admin.insert(agents).values({
      id: fixture.agentId,
      handle: `task-receipt-${fixture.agentId}`,
    });
    await admin.insert(namespaces).values({
      id: fixture.namespaceId,
      scope: "private",
      label: "Protected Task receipt fixture",
    });
    await admin.insert(tasks).values({
      id: fixture.taskId,
      ownerId: fixture.userId,
      requestorId: fixture.userId,
      agentId: fixture.agentId,
      prompt: "",
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
      operationId: `task-receipt:${fixture.taskId}`,
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
      input: {
        kind: "protected_task_run_v1",
        taskId: fixture.taskId,
        taskRunId: fixture.taskRunId,
        executionSegment: 1,
      },
    });
    await admin.insert(taskRuns).values({
      id: fixture.taskRunId,
      taskId: fixture.taskId,
      jobId: fixture.jobId,
      graphThreadId: `subagent:task-receipt:${fixture.taskRunId}`,
      status: "running",
    });
    return fixture;
  } catch (error) {
    await cleanupFixture(fixture);
    throw error;
  }
}

function segmentInput(
  fixture: Fixture,
  overrides: Partial<SealProtectedTaskExecutionSegmentReceiptInput> = {},
): SealProtectedTaskExecutionSegmentReceiptInput {
  return {
    taskId: fixture.taskId,
    taskRunId: fixture.taskRunId,
    jobId: fixture.jobId,
    executionSegment: 1,
    route: "native_langgraph_v1",
    transcript: {
      contract: "protected_message_associations_v1",
      expectedAssociationCount: 2,
      orderedDigest: new Uint8Array(32).fill(0x51),
    },
    checkpoint: {
      contract: "encrypted_langgraph_v1",
      expectedCheckpointCount: 1,
      checkpointOrderedDigest: new Uint8Array(32).fill(0x52),
      expectedBlobCount: 1,
      blobOrderedDigest: new Uint8Array(32).fill(0x53),
      expectedPendingWriteCount: 0,
      pendingWriteOrderedDigest: new Uint8Array(32).fill(0x54),
    },
    sealedAt: new Date("2026-10-06T12:00:00.000Z"),
    ...overrides,
  };
}

function continuationInput(
  fixture: Fixture,
  overrides: Partial<CheckpointContinuationInput> = {},
): CheckpointContinuationInput {
  return {
    taskId: fixture.taskId,
    taskRunId: fixture.taskRunId,
    jobId: fixture.jobId,
    executionSegment: 1,
    kind: "checkpoint_safe_v1",
    reason: "manual_pause",
    effectDisposition: "none_v1",
    sealedAt: new Date("2026-10-06T12:00:01.000Z"),
    ...overrides,
  };
}

function postgresCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  const value = error as { code?: unknown; cause?: { code?: unknown } };
  return value.code ?? value.cause?.code;
}

async function rejectedCode(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return postgresCode(error);
  }
}

test("protected Task execution receipts are exact, resumable and append-only for the product role", async () => {
  const fixture = await createFixture();
  try {
    const identity = await product.execute(sql`
      SELECT current_user::text AS current_user
    `);
    expect(identity[0]?.["current_user"]).toBe("nautilo");

    const continuation = continuationInput(fixture);
    expect(await sealProtectedTaskContinuationReceipt(
      product,
      continuation,
    )).toEqual({ status: "rejected", reason: "missing_segment" });

    expect(await sealProtectedTaskExecutionSegmentReceipt(
      product,
      segmentInput(fixture, { jobId: fixture.staleJobId }),
    )).toEqual({ status: "rejected", reason: "stale_job" });

    const segment = segmentInput(fixture);
    expect(await sealProtectedTaskExecutionSegmentReceipt(product, segment))
      .toMatchObject({ status: "sealed", receipt: { jobId: fixture.jobId } });
    expect(await sealProtectedTaskExecutionSegmentReceipt(product, {
      ...segment,
      sealedAt: new Date("2026-10-06T13:00:00.000Z"),
    })).toMatchObject({ status: "exact_replay" });
    expect(await sealProtectedTaskExecutionSegmentReceipt(product, {
      ...segment,
      checkpoint: {
        ...segment.checkpoint,
        checkpointOrderedDigest: new Uint8Array(32).fill(0x61),
      },
    })).toEqual({ status: "rejected", reason: "conflict" });

    const invalidConstraintCode = await product.transaction(tx =>
      rejectedCode(async () => {
        await tx.transaction(savepoint => savepoint.insert(
          protectedTaskContinuationReceipts,
        ).values({
          taskRunId: fixture.taskRunId,
          executionSegment: 1,
          jobId: fixture.jobId,
          kind: "checkpoint_safe_v1",
          reason: "manual_pause",
          effectDisposition: "not_started_v1" as "none_v1",
          interruptId: null,
          operationId: null,
          requestDigest: null,
          requiredAuthorityDigest: null,
          semanticAuthorityRequirements: null,
          sealedAt: new Date("2026-10-06T12:00:01.000Z"),
        }));
      })
    );
    expect(invalidConstraintCode).toBe("23514");

    expect(await sealProtectedTaskContinuationReceipt(product, continuation))
      .toMatchObject({
        status: "sealed",
        receipt: { kind: "checkpoint_safe_v1", reason: "manual_pause" },
      });
    expect(await sealProtectedTaskContinuationReceipt(product, {
      ...continuation,
      sealedAt: new Date("2026-10-06T14:00:00.000Z"),
    })).toMatchObject({ status: "exact_replay" });
    expect(await sealProtectedTaskContinuationReceipt(product, {
      ...continuation,
      reason: "time_limit",
    })).toEqual({ status: "rejected", reason: "conflict" });

    expect(await readProtectedTaskExecutionContinuationProof(product, {
      taskId: fixture.taskId,
      taskRunId: fixture.taskRunId,
      jobId: fixture.jobId,
      executionSegment: 1,
    })).toMatchObject({
      segment: { route: "native_langgraph_v1" },
      continuation: { kind: "checkpoint_safe_v1" },
    });

    const privileges = await product.execute(sql`
      SELECT
        has_table_privilege(
          'nautilo',
          'protected_task_execution_segment_receipts',
          'UPDATE'
        ) AS segment_table_update,
        has_column_privilege(
          'nautilo',
          'protected_task_execution_segment_receipts',
          'task_run_id',
          'UPDATE'
        ) AS segment_identity_update,
        has_table_privilege(
          'nautilo',
          'protected_task_continuation_receipts',
          'DELETE'
        ) AS continuation_delete
    `);
    expect(privileges[0]).toMatchObject({
      segment_table_update: false,
      segment_identity_update: true,
      continuation_delete: true,
    });

    const updateCode = await product.transaction(tx => rejectedCode(async () => {
      await tx.transaction(savepoint => savepoint.update(
        protectedTaskExecutionSegmentReceipts,
      ).set({ taskRunId: fixture.taskRunId }).where(eq(
        protectedTaskExecutionSegmentReceipts.taskRunId,
        fixture.taskRunId,
      )));
    }));
    expect(updateCode).toBe("23514");
    const semanticManifestUpdateCode = await product.transaction(tx =>
      rejectedCode(async () => {
        await tx.transaction(savepoint => savepoint.update(
          protectedTaskContinuationReceipts,
        ).set({ semanticAuthorityRequirements: null }).where(eq(
          protectedTaskContinuationReceipts.taskRunId,
          fixture.taskRunId,
        )));
      })
    );
    // Product has no UPDATE privilege on continuation content; PostgreSQL
    // rejects this before the immutable-row trigger can run.
    expect(semanticManifestUpdateCode).toBe("42501");
    const continuationDeleteCode = await product.transaction(tx =>
      rejectedCode(async () => {
        await tx.transaction(savepoint => savepoint.delete(
          protectedTaskContinuationReceipts,
        ).where(eq(
          protectedTaskContinuationReceipts.taskRunId,
          fixture.taskRunId,
        )));
      })
    );
    expect(continuationDeleteCode).toBe("23514");
    const segmentDeleteCode = await product.transaction(tx => rejectedCode(async () => {
      await tx.transaction(savepoint => savepoint.delete(
        protectedTaskExecutionSegmentReceipts,
      ).where(eq(
        protectedTaskExecutionSegmentReceipts.taskRunId,
        fixture.taskRunId,
      )));
    }));
    expect(segmentDeleteCode).toBe("23514");

    const deletedTasks = await product.delete(tasks).where(eq(
      tasks.id,
      fixture.taskId,
    )).returning({ id: tasks.id });
    expect(deletedTasks).toEqual([{ id: fixture.taskId }]);
    expect(await product.select({
      taskRunId: protectedTaskExecutionSegmentReceipts.taskRunId,
    }).from(protectedTaskExecutionSegmentReceipts).where(eq(
      protectedTaskExecutionSegmentReceipts.taskRunId,
      fixture.taskRunId,
    ))).toEqual([]);
    expect(await product.select({
      taskRunId: protectedTaskContinuationReceipts.taskRunId,
    }).from(protectedTaskContinuationReceipts).where(eq(
      protectedTaskContinuationReceipts.taskRunId,
      fixture.taskRunId,
    ))).toEqual([]);
  } finally {
    await cleanupFixture(fixture);
  }
});
