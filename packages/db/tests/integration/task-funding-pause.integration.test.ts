import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  agents,
  createDirectDb,
  createTask,
  ensureDatabase,
  eq,
  inArray,
  insertTaskRun,
  llmUsageEvents,
  listPendingSurplusAttempts,
  reconcileCallerFundedTaskRunAfterRestart,
  taskRuns,
  tasks,
  users,
  type DirectDatabase,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

const FIXTURE_PREFIX = "task-funding-pause-integration";
const usageIds: string[] = [];
const taskIds: string[] = [];
const agentIds: string[] = [];
const userIds: string[] = [];
let db: DirectDatabase;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);
});

afterAll(async () => {
  if (usageIds.length > 0) {
    await db?.delete(llmUsageEvents).where(inArray(llmUsageEvents.id, usageIds));
  }
  if (taskIds.length > 0) {
    await db?.delete(tasks).where(inArray(tasks.id, taskIds));
  }
  if (agentIds.length > 0) {
    await db?.delete(agents).where(inArray(agents.id, agentIds));
  }
  if (userIds.length > 0) {
    await db?.delete(users).where(inArray(users.id, userIds));
  }
  await db?.end();
});

describe("caller-funded Task restart settlement", () => {
  test("terminalizes exact-run personal and server Surplus attempts", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [user] = await db.insert(users).values({
      name: `${FIXTURE_PREFIX}:${suffix}`,
    }).returning({ id: users.id });
    const [agent] = await db.insert(agents).values({
      handle: `${FIXTURE_PREFIX}-${suffix}`,
    }).returning({ id: agents.id });
    if (!user || !agent) throw new Error("Task funding pause fixture identity was not created");
    userIds.push(user.id);
    agentIds.push(agent.id);

    const nextFireAt = new Date(Date.now() + 60 * 60 * 1_000);
    const task = await createTask(db, {
      ownerId: user.id,
      requestorId: user.id,
      agentId: agent.id,
      prompt: `${FIXTURE_PREFIX} content-free fixture`,
      preset: "schedule",
      scheduleKind: "cron",
      cron: "0 * * * *",
      targetChat: "orphan",
      targetUserIds: [user.id],
      fundingMode: "caller",
      status: "pending",
      nextFireAt,
    });
    taskIds.push(task.id);

    const credentialId = randomUUID();
    const fundingBinding = {
      kind: "personal" as const,
      providerRoute: "surplus",
      credentialId,
      credentialRevision: 4,
    };
    const olderRun = await insertTaskRun(db, {
      taskId: task.id,
      graphThreadId: `${FIXTURE_PREFIX}:older:${randomUUID()}`,
      status: "running",
      modelId: "openrouter:fixture/model",
      fundingBinding,
      startedAt: new Date(Date.now() - 2_000),
    });
    const newerRun = await insertTaskRun(db, {
      taskId: task.id,
      graphThreadId: `${FIXTURE_PREFIX}:newer:${randomUUID()}`,
      status: "running",
      modelId: "openrouter:fixture/model",
      fundingBinding,
      startedAt: new Date(Date.now() - 1_000),
    });

    const missingReceiptId = randomUUID();
    const pendingReceiptId = randomUUID();
    const blockedReceiptId = randomUUID();
    const recoveredCostId = randomUUID();
    const newerRunAttemptId = randomUUID();
    usageIds.push(
      missingReceiptId,
      pendingReceiptId,
      blockedReceiptId,
      recoveredCostId,
      newerRunAttemptId,
    );
    const usageBase = {
      userId: user.id,
      taskId: task.id,
      callType: "subagent",
      provider: "openrouter",
      model: "openrouter:fixture/model",
      endpoint: "/v1/chat/completions",
      providerRoute: "surplus",
      fundingKind: "personal" as const,
      payerHumanId: user.id,
      credentialId,
      credentialRevision: 4,
      estimatedCostUsd: "0.00000000",
    };
    const recoveredAt = new Date(Date.now() - 500);
    await db.insert(llmUsageEvents).values([
      {
        ...usageBase,
        id: missingReceiptId,
        metadata: { taskRunId: olderRun.id },
        attemptOutcome: "in_progress",
        costState: "pending",
        recoveryState: "pending",
      },
      {
        ...usageBase,
        id: pendingReceiptId,
        metadata: { taskRunId: olderRun.id },
        providerRequestId: `request-${randomUUID()}`,
        attemptOutcome: "in_progress",
        costState: "pending",
        recoveryState: "pending",
        failureCode: "receipt_not_confirmed",
      },
      {
        ...usageBase,
        id: blockedReceiptId,
        metadata: { taskRunId: olderRun.id },
        providerRequestId: `request-${randomUUID()}`,
        attemptOutcome: "in_progress",
        costState: "unknown",
        recoveryState: "blocked_repair",
        failureCode: "receipt_read_unauthorized",
      },
      {
        ...usageBase,
        id: recoveredCostId,
        metadata: { taskRunId: olderRun.id },
        providerRequestId: `request-${randomUUID()}`,
        attemptOutcome: "in_progress",
        costState: "actual",
        recoveryState: null,
        actualCostUsd: "0.00123456",
        settledAt: recoveredAt,
      },
      {
        ...usageBase,
        id: newerRunAttemptId,
        metadata: { taskRunId: newerRun.id },
        attemptOutcome: "in_progress",
        costState: "pending",
        recoveryState: "pending",
      },
    ]);

    const result = await reconcileCallerFundedTaskRunAfterRestart(db, {
      taskId: task.id,
      taskRunId: olderRun.id,
    });
    expect(result.transitioned).toBe(true);

    const [taskAfter] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(taskAfter).toMatchObject({ status: "pending", lastError: null });
    expect(taskAfter?.nextFireAt?.getTime()).toBe(nextFireAt.getTime());
    const runsAfter = await db.select().from(taskRuns).where(eq(taskRuns.taskId, task.id));
    expect(runsAfter.find((candidate) => candidate.id === olderRun.id)).toMatchObject({
      status: "errored",
      lastError: "funding_interrupted_uncertain",
    });
    expect(runsAfter.find((candidate) => candidate.id === newerRun.id)).toMatchObject({
      status: "running",
      lastError: null,
    });

    const attempts = await db.select().from(llmUsageEvents)
      .where(inArray(llmUsageEvents.id, usageIds));
    expect(attempts.find((attempt) => attempt.id === missingReceiptId)).toMatchObject({
      attemptOutcome: "interrupted",
      costState: "unknown",
      recoveryState: "pending",
      providerRequestId: null,
      failureCode: "execution_interrupted",
      payerHumanId: user.id,
      credentialId,
      credentialRevision: 4,
    });
    expect(attempts.find((attempt) => attempt.id === recoveredCostId)).toMatchObject({
      attemptOutcome: "interrupted",
      costState: "actual",
      recoveryState: null,
      actualCostUsd: "0.00123456",
      failureCode: "execution_interrupted",
      payerHumanId: user.id,
      credentialId,
      credentialRevision: 4,
    });
    expect(attempts.find((attempt) => attempt.id === recoveredCostId)?.settledAt?.getTime())
      .toBe(recoveredAt.getTime());
    expect(attempts.find((attempt) => attempt.id === pendingReceiptId)).toMatchObject({
      attemptOutcome: "interrupted",
      costState: "unknown",
      recoveryState: "pending",
      failureCode: "execution_interrupted",
    });
    expect(attempts.find((attempt) => attempt.id === blockedReceiptId)).toMatchObject({
      attemptOutcome: "interrupted",
      costState: "unknown",
      recoveryState: "blocked_repair",
      failureCode: "receipt_read_unauthorized",
    });
    expect(attempts.find((attempt) => attempt.id === newerRunAttemptId)).toMatchObject({
      attemptOutcome: "in_progress",
      costState: "pending",
      recoveryState: "pending",
      failureCode: null,
    });

    const recoverable = await listPendingSurplusAttempts({
      limit: 1_000,
      updatedBefore: new Date(Date.now() + 60_000),
    });
    expect(recoverable.some((attempt) => attempt.id === pendingReceiptId)).toBe(true);
    expect(recoverable.some((attempt) => attempt.id === blockedReceiptId)).toBe(false);

    const serverTask = await createTask(db, {
      ownerId: user.id,
      requestorId: user.id,
      agentId: agent.id,
      prompt: `${FIXTURE_PREFIX} server Surplus fixture`,
      preset: "schedule",
      scheduleKind: "cron",
      cron: "0 * * * *",
      targetChat: "orphan",
      targetUserIds: [user.id],
      fundingMode: "caller",
      status: "pending",
      nextFireAt,
    });
    taskIds.push(serverTask.id);
    const serverRun = await insertTaskRun(db, {
      taskId: serverTask.id,
      graphThreadId: `${FIXTURE_PREFIX}:server:${randomUUID()}`,
      status: "running",
      modelId: "openrouter:fixture/model",
      fundingBinding: { kind: "server", providerRoute: "openrouter" },
      startedAt: new Date(Date.now() - 1_000),
    });
    const serverMissingId = randomUUID();
    const serverPendingId = randomUUID();
    const serverActualId = randomUUID();
    const serviceAttemptId = randomUUID();
    const unrelatedRunAttemptId = randomUUID();
    usageIds.push(
      serverMissingId,
      serverPendingId,
      serverActualId,
      serviceAttemptId,
      unrelatedRunAttemptId,
    );
    const serverUsageBase = {
      userId: user.id,
      taskId: serverTask.id,
      callType: "subagent",
      provider: "openrouter",
      model: "openrouter:fixture/model",
      endpoint: "/v1/chat/completions",
      providerRoute: "surplus",
      fundingKind: "server" as const,
      estimatedCostUsd: "0.00000000",
      metadata: {
        taskRunId: serverRun.id,
        catalogModelId: "openrouter:fixture/model",
        surplusModelId: "fixture/model",
        surplusProviderPin: "openrouter",
        surplusCredentialFingerprint: "0".repeat(64),
      },
    };
    const serverRecoveredAt = new Date(Date.now() - 250);
    await db.insert(llmUsageEvents).values([
      {
        ...serverUsageBase,
        id: serverMissingId,
        attemptOutcome: "in_progress",
        costState: "pending",
        recoveryState: "pending",
      },
      {
        ...serverUsageBase,
        id: serverPendingId,
        providerRequestId: `request-${randomUUID()}`,
        attemptOutcome: "in_progress",
        costState: "pending",
        recoveryState: "retryable",
        failureCode: "receipt_not_confirmed",
      },
      {
        ...serverUsageBase,
        id: serverActualId,
        providerRequestId: `request-${randomUUID()}`,
        attemptOutcome: "in_progress",
        costState: "actual",
        recoveryState: null,
        actualCostUsd: "0.00456789",
        settledAt: serverRecoveredAt,
      },
      {
        ...serverUsageBase,
        id: serviceAttemptId,
        fundingKind: "service",
        attemptOutcome: "in_progress",
        costState: "pending",
        recoveryState: "pending",
      },
      {
        ...serverUsageBase,
        id: unrelatedRunAttemptId,
        metadata: { ...serverUsageBase.metadata, taskRunId: randomUUID() },
        attemptOutcome: "in_progress",
        costState: "pending",
        recoveryState: "pending",
      },
    ]);

    expect((await reconcileCallerFundedTaskRunAfterRestart(db, {
      taskId: serverTask.id,
      taskRunId: serverRun.id,
    })).transitioned).toBe(true);
    const serverAttempts = await db.select().from(llmUsageEvents).where(inArray(
      llmUsageEvents.id,
      [serverMissingId, serverPendingId, serverActualId, serviceAttemptId, unrelatedRunAttemptId],
    ));
    expect(serverAttempts.find((attempt) => attempt.id === serverMissingId)).toMatchObject({
      fundingKind: "server",
      payerHumanId: null,
      credentialId: null,
      credentialRevision: null,
      attemptOutcome: "interrupted",
      costState: "unknown",
      recoveryState: "pending",
      failureCode: "execution_interrupted",
    });
    expect(serverAttempts.find((attempt) => attempt.id === serverPendingId)).toMatchObject({
      attemptOutcome: "interrupted",
      costState: "unknown",
      recoveryState: "retryable",
      failureCode: "execution_interrupted",
    });
    expect(serverAttempts.find((attempt) => attempt.id === serverActualId)).toMatchObject({
      attemptOutcome: "interrupted",
      costState: "actual",
      recoveryState: null,
      actualCostUsd: "0.00456789",
      failureCode: "execution_interrupted",
    });
    expect(serverAttempts.find((attempt) => attempt.id === serverActualId)?.settledAt?.getTime())
      .toBe(serverRecoveredAt.getTime());
    expect(serverAttempts.find((attempt) => attempt.id === serviceAttemptId)).toMatchObject({
      fundingKind: "service",
      attemptOutcome: "in_progress",
      costState: "pending",
      recoveryState: "pending",
      failureCode: null,
    });
    expect(serverAttempts.find((attempt) => attempt.id === unrelatedRunAttemptId)).toMatchObject({
      fundingKind: "server",
      attemptOutcome: "in_progress",
      costState: "pending",
      recoveryState: "pending",
      failureCode: null,
    });
  });
});
