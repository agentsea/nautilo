import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  agents,
  artifacts,
  acquireWorkspaceDocumentMutationOperationLock,
  createDirectDb,
  findWorkspaceEditorSaveForWriterReviewRecovery,
  createTask,
  ensureDatabase,
  eq,
  getTaskById,
  getTaskRuns,
  insertTaskRun,
  insertArtifact,
  insertWorkspaceDocumentMutationReceipt,
  workspaceDocumentMutations,
  recordTaskWriterReviewAcceptedReceipt,
  reserveTaskWriterReviewWorkspaceOperation,
  startTaskRunForWriterReviewVerification,
  taskRuns,
  tasks,
  updateTask,
  users,
  type DirectDatabase,
} from "@nautilo/db";
import type { DocumentMutationCommittedEvent } from "@nautilo/types";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  clearTaskReturnBindings,
  advanceTaskLiveMiniAppBindingDocumentVersion,
  claimTaskWriterReviewAcceptance,
  registerTaskLiveMiniAppBinding,
  registerTaskWriterReviewProposal,
  pendingTaskWriterReviewFinalizations,
  resolveTaskWriterReviewProposal,
  resolveTaskLiveMiniAppBinding,
  taskReturnBindingRegistryForTests,
} from "../../src/tasks/task-return-binding";
import {
  finalizeTaskWriterReviewResolution,
  finalizeTaskExternalReviewAcceptedReceipt,
  settleTaskWriterReviewAfterModel,
} from "../../src/tasks/writer-review-task-lifecycle";
import { pauseTask, stopTask } from "../../src/tasks/lifecycle";
import {
  SAFE_BACKGROUND_TASK_FAILURE_RESULT,
  SAFE_WRITER_REVIEW_ACCEPTED_RESULT,
  SAFE_WRITER_REVIEW_FAILED_RESULT,
  SAFE_WRITER_REVIEW_REJECTED_RESULT,
  SAFE_WRITER_REVIEW_SAVED_VERIFICATION_LOST_RESULT,
} from "../../src/tasks/report-back";
import { TaskObserver } from "../../src/tasks/task-observer";
import { permissiveMaintenanceGate, type MaintenanceGate } from "../../src/maintenance-controller";

let db: DirectDatabase & { end(): Promise<void> };
const createdTaskIds: string[] = [];
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(5);
});

beforeEach(() => clearTaskReturnBindings());

afterAll(async () => {
  clearTaskReturnBindings();
  if (createdTaskIds.length > 0) {
    await db.delete(taskRuns).where(eq(taskRuns.taskId, createdTaskIds[0]!));
    for (const taskId of createdTaskIds.slice(1)) {
      await db.delete(taskRuns).where(eq(taskRuns.taskId, taskId));
    }
    for (const taskId of createdTaskIds) await db.delete(tasks).where(eq(tasks.id, taskId));
  }
  for (const userId of createdUserIds) await db.delete(users).where(eq(users.id, userId));
  for (const agentId of createdAgentIds) await db.delete(agents).where(eq(agents.id, agentId));
  await db.end();
});

async function seedRunningTask() {
  const suffix = crypto.randomUUID();
  const [user] = await db.insert(users).values({
    name: "writer-review-owner",
    email: `writer-review-${suffix}@test.local`,
  }).returning({ id: users.id });
  const [agent] = await db.insert(agents).values({
    handle: `writer-review-${suffix}`,
  }).returning({ id: agents.id });
  if (!user || !agent) throw new Error("fixture insert failed");
  createdUserIds.push(user.id);
  createdAgentIds.push(agent.id);
  const task = await createTask(db, {
    ownerId: user.id,
    requestorId: user.id,
    agentId: agent.id,
    prompt: "correct this document",
    scheduleKind: "now",
    status: "running",
    nextFireAt: new Date(),
  });
  createdTaskIds.push(task.id);
  const run = await insertTaskRun(db, {
    taskId: task.id,
    graphThreadId: `writer-review:${suffix}`,
    status: "running",
  });
  return { user, task, run };
}

describe("D569 Writer review Task lifecycle (live PG)", () => {
  test("an ordinary observer tick retries only resolved Writer finalizers after a transient DB failure", async () => {
    const createResolvedReview = async (input: {
      suffix: string;
      resolution:
        | { outcome: "accepted"; documentVersion: { kind: "artifact_revision"; revision: number } }
        | { outcome: "failed"; code: string };
    }) => {
      const { user, task, run } = await seedRunningTask();
      const documentVersion = { kind: "artifact_revision" as const, revision: 7 };
      const context = {
        ownerId: user.id,
        activeMiniApp: { appId: "nautilo-writer", updatedAt: 1 },
        liveMiniAppSession: {
          appId: "nautilo-writer",
          sessionToken: `opaque-live-token:${input.suffix}`,
          sessionId: `writer-session:${input.suffix}`,
          documentVersion,
          instructions: "Writer",
        },
      };
      expect(registerTaskLiveMiniAppBinding(task.id, context, () => context.liveMiniAppSession)).toBe(true);
      expect(registerTaskWriterReviewProposal({
        taskId: task.id,
        taskRunId: run.id,
        ownerId: user.id,
        sessionId: context.liveMiniAppSession.sessionId,
        proposalId: `proposal:${input.suffix}`,
        documentVersion,
      })).toBe(true);
      expect(await settleTaskWriterReviewAfterModel(db, {
        taskId: task.id,
        taskRunId: run.id,
        ownerId: user.id,
      })).toBe("awaiting_review");
      const resolved = resolveTaskWriterReviewProposal({
        ownerId: user.id,
        sessionId: context.liveMiniAppSession.sessionId,
        proposalId: `proposal:${input.suffix}`,
        documentVersion,
        resolution: input.resolution,
      });
      expect(resolved).toMatchObject({ status: "resolved", finalizeNow: true });
      if (resolved.status !== "resolved") throw new Error("expected exact resolved Writer review");
      return { task, run, binding: resolved.binding };
    };
    const rejectingGate: MaintenanceGate = {
      assertAcceptingNewWork: async () => {},
      isAcceptingWork: async () => false,
    };
    const observer = new TaskObserver({
      db,
      jobManager: {
        abortJob: () => false,
        createForegroundJob: async () => {
          throw new Error("maintenance retry must not dispatch provider work");
        },
      },
      maintenanceGate: rejectingGate,
      onMaintenance: async () => {
        for (const binding of pendingTaskWriterReviewFinalizations()) {
          await finalizeTaskWriterReviewResolution(db, binding);
        }
      },
    });
    const failTransactionAttempt = (attemptToFail = 1): DirectDatabase => {
      let attempts = 0;
      return new Proxy(db, {
        get(target, property, receiver) {
          if (property === "transaction") {
            return (...args: Parameters<DirectDatabase["transaction"]>) => {
              attempts += 1;
              if (attempts === attemptToFail) {
                return Promise.reject(new Error("transient finalizer database failure"));
              }
              return target.transaction(...args);
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          return (value as (...args: unknown[]) => unknown).bind(target);
        },
      }) as DirectDatabase;
    };

    // A resolution before the model leg ends remains a Human-visible review,
    // never an observer-finalization candidate.
    const unfinished = await seedRunningTask();
    const unfinishedVersion = { kind: "artifact_revision" as const, revision: 7 };
    const unfinishedContext = {
      ownerId: unfinished.user.id,
      activeMiniApp: { appId: "nautilo-writer", updatedAt: 1 },
      liveMiniAppSession: {
        appId: "nautilo-writer",
        sessionToken: "opaque-live-token:unfinished",
        sessionId: "writer-session:unfinished",
        documentVersion: unfinishedVersion,
        instructions: "Writer",
      },
    };
    expect(registerTaskLiveMiniAppBinding(
      unfinished.task.id,
      unfinishedContext,
      () => unfinishedContext.liveMiniAppSession,
    )).toBe(true);
    expect(registerTaskWriterReviewProposal({
      taskId: unfinished.task.id,
      taskRunId: unfinished.run.id,
      ownerId: unfinished.user.id,
      sessionId: unfinishedContext.liveMiniAppSession.sessionId,
      proposalId: "proposal:unfinished",
      documentVersion: unfinishedVersion,
    })).toBe(true);
    expect(resolveTaskWriterReviewProposal({
      ownerId: unfinished.user.id,
      sessionId: unfinishedContext.liveMiniAppSession.sessionId,
      proposalId: "proposal:unfinished",
      documentVersion: unfinishedVersion,
      resolution: { outcome: "failed", code: "LIVE_WRITER_REVIEW_REMOTE_CHANGED" },
    })).toMatchObject({ status: "resolved", finalizeNow: false });
    expect(pendingTaskWriterReviewFinalizations()).toEqual([]);

    const accepted = await createResolvedReview({
      suffix: "accepted-retry",
      resolution: { outcome: "accepted", documentVersion: { kind: "artifact_revision", revision: 8 } },
    });
    let acceptedFailure: unknown;
    try {
      await finalizeTaskWriterReviewResolution(failTransactionAttempt(), accepted.binding);
    } catch (error) {
      acceptedFailure = error;
    }
    expect(acceptedFailure).toBeInstanceOf(Error);
    expect((acceptedFailure as Error).message).toBe("transient finalizer database failure");
    expect(await getTaskById(db, accepted.task.id)).toMatchObject({ status: "awaiting" });
    expect(pendingTaskWriterReviewFinalizations().map((binding) => binding.taskId))
      .toContain(accepted.task.id);

    await observer.tick();
    expect(await getTaskById(db, accepted.task.id)).toMatchObject({ status: "pending" });
    expect((await getTaskRuns(db, accepted.task.id))).toHaveLength(1);
    expect((await getTaskRuns(db, accepted.task.id))[0]).toMatchObject({
      status: "completed",
      resultText: SAFE_WRITER_REVIEW_ACCEPTED_RESULT,
    });

    const failed = await createResolvedReview({
      suffix: "failed-retry",
      resolution: { outcome: "failed", code: "LIVE_WRITER_REVIEW_REMOTE_CHANGED" },
    });
    let failedFailure: unknown;
    try {
      await finalizeTaskWriterReviewResolution(failTransactionAttempt(), failed.binding);
    } catch (error) {
      failedFailure = error;
    }
    expect(failedFailure).toBeInstanceOf(Error);
    expect((failedFailure as Error).message).toBe("transient finalizer database failure");
    expect(await getTaskById(db, failed.task.id)).toMatchObject({ status: "awaiting" });
    expect(pendingTaskWriterReviewFinalizations().map((binding) => binding.taskId))
      .toContain(failed.task.id);

    await observer.tick();
    expect(await getTaskById(db, failed.task.id)).toMatchObject({
      status: "errored",
      lastError: "LIVE_WRITER_REVIEW_REMOTE_CHANGED",
    });
    expect((await getTaskRuns(db, failed.task.id))).toHaveLength(1);
    expect(pendingTaskWriterReviewFinalizations()).toEqual([]);

    // A Human outcome can win just before its producing model reports done.
    // The model-finish lifecycle attempt is then the first durable finalizer.
    // A transient failure must remain an exact Writer finalization for observer
    // maintenance, never fall through task-run-executor's generic failure
    // finalizer (which would remove this process-local retry binding).
    const createFastResolvedReview = async (input: {
      suffix: string;
      resolution:
        | { outcome: "accepted"; documentVersion: { kind: "artifact_revision"; revision: number } }
        | { outcome: "rejected" }
        | { outcome: "failed"; code: string };
    }) => {
      const { user, task, run } = await seedRunningTask();
      const documentVersion = { kind: "artifact_revision" as const, revision: 7 };
      const context = {
        ownerId: user.id,
        activeMiniApp: { appId: "nautilo-writer", updatedAt: 1 },
        liveMiniAppSession: {
          appId: "nautilo-writer",
          sessionToken: `opaque-live-token:fast:${input.suffix}`,
          sessionId: `writer-session:fast:${input.suffix}`,
          documentVersion,
          instructions: "Writer",
        },
      };
      expect(registerTaskLiveMiniAppBinding(task.id, context, () => context.liveMiniAppSession)).toBe(true);
      expect(registerTaskWriterReviewProposal({
        taskId: task.id,
        taskRunId: run.id,
        ownerId: user.id,
        sessionId: context.liveMiniAppSession.sessionId,
        proposalId: `proposal:fast:${input.suffix}`,
        documentVersion,
      })).toBe(true);
      const resolved = resolveTaskWriterReviewProposal({
        ownerId: user.id,
        sessionId: context.liveMiniAppSession.sessionId,
        proposalId: `proposal:fast:${input.suffix}`,
        documentVersion,
        resolution: input.resolution,
      });
      expect(resolved).toMatchObject({ status: "resolved", finalizeNow: false });
      return { user, task, run };
    };

    const fastAccepted = await createFastResolvedReview({
      suffix: "accepted",
      resolution: { outcome: "accepted", documentVersion: { kind: "artifact_revision", revision: 8 } },
    });
    // Accepted fast-race settlement first parks the producing run, so fail
    // its following receipt/requeue transaction rather than the park itself.
    expect(await settleTaskWriterReviewAfterModel(failTransactionAttempt(2), {
      taskId: fastAccepted.task.id,
      taskRunId: fastAccepted.run.id,
      ownerId: fastAccepted.user.id,
    })).toBe("finalization_pending");
    expect(await getTaskById(db, fastAccepted.task.id)).toMatchObject({ status: "awaiting" });
    expect(pendingTaskWriterReviewFinalizations().map((binding) => binding.taskId))
      .toContain(fastAccepted.task.id);
    await observer.tick();
    expect(await getTaskById(db, fastAccepted.task.id)).toMatchObject({ status: "pending" });
    expect((await getTaskRuns(db, fastAccepted.task.id))[0]).toMatchObject({
      status: "completed",
      resultText: SAFE_WRITER_REVIEW_ACCEPTED_RESULT,
    });

    const fastRejected = await createFastResolvedReview({
      suffix: "rejected",
      resolution: { outcome: "rejected" },
    });
    expect(await settleTaskWriterReviewAfterModel(failTransactionAttempt(), {
      taskId: fastRejected.task.id,
      taskRunId: fastRejected.run.id,
      ownerId: fastRejected.user.id,
    })).toBe("finalization_pending");
    expect(await getTaskById(db, fastRejected.task.id)).toMatchObject({ status: "running" });
    expect(pendingTaskWriterReviewFinalizations().map((binding) => binding.taskId))
      .toContain(fastRejected.task.id);
    await observer.tick();
    expect(await getTaskById(db, fastRejected.task.id)).toMatchObject({ status: "cancelled" });
    expect((await getTaskRuns(db, fastRejected.task.id))[0]).toMatchObject({
      status: "cancelled",
      resultText: SAFE_WRITER_REVIEW_REJECTED_RESULT,
    });

    const fastFailed = await createFastResolvedReview({
      suffix: "failed",
      resolution: { outcome: "failed", code: "LIVE_WRITER_REVIEW_REMOTE_CHANGED" },
    });
    expect(await settleTaskWriterReviewAfterModel(failTransactionAttempt(), {
      taskId: fastFailed.task.id,
      taskRunId: fastFailed.run.id,
      ownerId: fastFailed.user.id,
    })).toBe("finalization_pending");
    expect(await getTaskById(db, fastFailed.task.id)).toMatchObject({ status: "running" });
    expect(pendingTaskWriterReviewFinalizations().map((binding) => binding.taskId))
      .toContain(fastFailed.task.id);
    await observer.tick();
    expect(await getTaskById(db, fastFailed.task.id)).toMatchObject({
      status: "errored",
      lastError: "LIVE_WRITER_REVIEW_REMOTE_CHANGED",
    });
    expect((await getTaskRuns(db, fastFailed.task.id))[0]).toMatchObject({
      status: "errored",
      resultText: SAFE_WRITER_REVIEW_FAILED_RESULT,
    });
    expect((await getTaskRuns(db, fastFailed.task.id))[0]?.resultText)
      .not.toBe(SAFE_BACKGROUND_TASK_FAILURE_RESULT);
    expect(pendingTaskWriterReviewFinalizations()).toEqual([]);
    await observer.stop();
  });

  test("a model proposal awaits, then requeues verification only after persisted acceptance", async () => {
    const { user, task, run } = await seedRunningTask();
    const liveContext = {
      ownerId: user.id,
      activeMiniApp: { appId: "nautilo-writer", updatedAt: 1 },
      liveMiniAppSession: {
        appId: "nautilo-writer",
        sessionToken: "opaque-live-token",
        sessionId: "writer-session",
        documentVersion: { kind: "artifact_revision" as const, revision: 7 },
        instructions: "Writer",
      },
    };
    let currentSession = liveContext.liveMiniAppSession;
    expect(registerTaskLiveMiniAppBinding(
      task.id,
      liveContext,
      () => currentSession,
    )).toBe(true);
    expect(registerTaskWriterReviewProposal({
      taskId: task.id,
      taskRunId: run.id,
      ownerId: user.id,
      sessionId: "writer-session",
      proposalId: "proposal-1",
      documentVersion: { kind: "artifact_revision", revision: 7 },
    })).toBe(true);

    expect(await settleTaskWriterReviewAfterModel(db, {
      taskId: task.id,
      taskRunId: run.id,
      ownerId: user.id,
    })).toBe("awaiting_review");
    expect((await getTaskById(db, task.id))?.status).toBe("awaiting");
    expect((await getTaskRuns(db, task.id))[0]?.status).toBe("awaiting");

    const resolution = resolveTaskWriterReviewProposal({
      ownerId: user.id,
      sessionId: "writer-session",
      proposalId: "proposal-1",
      documentVersion: { kind: "artifact_revision", revision: 7 },
      resolution: {
        outcome: "accepted",
        documentVersion: { kind: "artifact_revision", revision: 8 },
      },
    });
    expect(resolution).toMatchObject({ status: "resolved", finalizeNow: true });
    if (resolution.status !== "resolved") return;
    await finalizeTaskWriterReviewResolution(db, resolution.binding);

    expect(await getTaskById(db, task.id)).toMatchObject({
      status: "pending",
      metadata: {
        writerReviewAcceptedReceipt: {
          taskRunId: run.id,
          proposalId: "proposal-1",
          acceptedResultRevision: { kind: "artifact_revision", revision: 8 },
        },
      },
    });
    expect((await getTaskById(db, task.id))?.metadata["writerReviewAwaiting"]).toBeUndefined();
    const [finishedRun] = await getTaskRuns(db, task.id);
    expect(finishedRun?.status).toBe("completed");
    expect(finishedRun?.resultText).toBe(SAFE_WRITER_REVIEW_ACCEPTED_RESULT);
    expect(taskReturnBindingRegistryForTests.writerReviewSize()).toBe(1);
    expect(await finalizeTaskExternalReviewAcceptedReceipt(db, {
      taskId: task.id,
      taskRunId: run.id,
      proposalId: "proposal-1",
      resultRevision: { kind: "artifact_revision", revision: 8 },
    })).toEqual({ status: "already_requeued" });
    expect(await finalizeTaskExternalReviewAcceptedReceipt(db, {
      taskId: task.id,
      taskRunId: run.id,
      proposalId: "proposal-1",
      resultRevision: { kind: "artifact_revision", revision: 9 },
    })).toEqual({ status: "conflict" });

    currentSession = {
      ...currentSession,
      documentVersion: { kind: "artifact_revision", revision: 8 },
    };
    expect(advanceTaskLiveMiniAppBindingDocumentVersion({
      taskId: task.id,
      ownerId: user.id,
      sessionId: "writer-session",
      previousDocumentVersion: { kind: "artifact_revision", revision: 7 },
      resultDocumentVersion: { kind: "artifact_revision", revision: 8 },
    })).toBe(true);
    await updateTask(db, task.id, { status: "running" });
    const secondRun = await insertTaskRun(db, {
      taskId: task.id,
      graphThreadId: `writer-review:second:${crypto.randomUUID()}`,
      status: "running",
    });
    expect(registerTaskWriterReviewProposal({
      taskId: task.id,
      taskRunId: secondRun.id,
      ownerId: user.id,
      sessionId: "writer-session",
      proposalId: "proposal-2",
      documentVersion: { kind: "artifact_revision", revision: 8 },
    })).toBe(true);
    expect(await settleTaskWriterReviewAfterModel(db, {
      taskId: task.id,
      taskRunId: secondRun.id,
      ownerId: user.id,
    })).toBe("awaiting_review");
    const secondResolution = resolveTaskWriterReviewProposal({
      ownerId: user.id,
      sessionId: "writer-session",
      proposalId: "proposal-2",
      documentVersion: { kind: "artifact_revision", revision: 8 },
      resolution: {
        outcome: "accepted",
        documentVersion: { kind: "artifact_revision", revision: 9 },
      },
    });
    expect(secondResolution).toMatchObject({ status: "resolved", finalizeNow: true });
    if (secondResolution.status !== "resolved") return;
    await finalizeTaskWriterReviewResolution(db, secondResolution.binding);
    expect(await getTaskById(db, task.id)).toMatchObject({
      status: "pending",
      metadata: {
        writerReviewAcceptedReceipt: {
          taskRunId: secondRun.id,
          proposalId: "proposal-2",
          acceptedResultRevision: { kind: "artifact_revision", revision: 9 },
        },
      },
    });
    expect((await getTaskRuns(db, task.id)).filter((candidate) =>
      candidate.status === "completed"
    )).toHaveLength(2);
  });

  test("external review rejects pause and Stop invalidates late acceptance", async () => {
    const { user, task, run } = await seedRunningTask();
    const liveContext = {
      ownerId: user.id,
      activeMiniApp: { appId: "nautilo-writer", updatedAt: 1 },
      liveMiniAppSession: {
        appId: "nautilo-writer",
        sessionToken: "opaque-live-token",
        sessionId: "writer-session-stop",
        documentVersion: { kind: "artifact_revision" as const, revision: 7 },
        instructions: "Writer",
      },
    };
    registerTaskLiveMiniAppBinding(task.id, liveContext, () => liveContext.liveMiniAppSession);
    registerTaskWriterReviewProposal({
      taskId: task.id,
      taskRunId: run.id,
      ownerId: user.id,
      sessionId: "writer-session-stop",
      proposalId: "proposal-stop",
      documentVersion: { kind: "artifact_revision", revision: 7 },
    });
    expect(await settleTaskWriterReviewAfterModel(db, {
      taskId: task.id,
      taskRunId: run.id,
      ownerId: user.id,
    })).toBe("awaiting_review");

    const jobManager = { abortJob: () => false };
    const stoppedReviews: Array<{ sessionId: string; proposalId: string }> = [];
    expect(await pauseTask({ db, jobManager }, task.id)).toMatchObject({
      ok: false,
      status: "awaiting",
    });
    expect((await getTaskById(db, task.id))?.status).toBe("awaiting");
    expect((await getTaskRuns(db, task.id))[0]?.status).toBe("awaiting");

    expect(await stopTask({
      db,
      jobManager,
      onStoppedWriterReview: (binding) => {
        stoppedReviews.push({ sessionId: binding.sessionId, proposalId: binding.proposalId });
      },
    }, task.id)).toMatchObject({
      ok: true,
      status: "cancelled",
    });
    expect(stoppedReviews).toEqual([{
      sessionId: "writer-session-stop",
      proposalId: "proposal-stop",
    }]);
    expect(claimTaskWriterReviewAcceptance({
      ownerId: user.id,
      sessionId: "writer-session-stop",
      proposalId: "proposal-stop",
      documentVersion: { kind: "artifact_revision", revision: 7 },
    })).toMatchObject({ status: "invalidated", taskId: task.id, taskRunId: run.id });
  });

  test("a durable D448 reservation refuses Stop before the canonical result is known", async () => {
    const { user, task, run } = await seedRunningTask();
    const liveContext = {
      ownerId: user.id,
      activeMiniApp: { appId: "nautilo-writer", updatedAt: 1 },
      liveMiniAppSession: {
        appId: "nautilo-writer",
        sessionToken: "opaque-live-token",
        sessionId: "writer-session-d448-stop",
        documentVersion: { kind: "artifact_revision" as const, revision: 7 },
        instructions: "Writer",
      },
    };
    expect(registerTaskLiveMiniAppBinding(
      task.id,
      liveContext,
      () => liveContext.liveMiniAppSession,
    )).toBe(true);
    expect(await reserveTaskWriterReviewWorkspaceOperation(db, {
      taskId: task.id,
      taskRunId: run.id,
      proposalId: "proposal-d448-reservation",
      operationId: "workspace-editor:reserved-operation",
      clientMutationId: "live-review:reserved-client-mutation",
      artifactInternalId: "artifact-internal-reserved",
    })).toMatchObject({ status: "reserved" });
    const abortCalls: string[] = [];
    expect(await stopTask({
      db,
      jobManager: { abortJob: (jobId) => (abortCalls.push(jobId), true) },
    }, task.id)).toMatchObject({ ok: false, status: "awaiting" });
    expect(abortCalls).toEqual([]);
    expect(await getTaskById(db, task.id)).toMatchObject({ status: "running" });
    expect((await getTaskRuns(db, task.id)).find((candidate) => candidate.id === run.id))
      .toMatchObject({ status: "running" });
    expect(resolveTaskLiveMiniAppBinding(task.id, user.id)).toMatchObject({
      status: "available",
    });
  });

  test("accepted D448 lineage survives requeue and verification-run claim", async () => {
    const { task, run } = await seedRunningTask();
    const lineage = {
      operationId: `workspace-editor:lineage:${crypto.randomUUID()}`,
      clientMutationId: `live-review:${"1".repeat(64)}`,
      artifactInternalId: crypto.randomUUID(),
    };
    expect(await reserveTaskWriterReviewWorkspaceOperation(db, {
      taskId: task.id,
      taskRunId: run.id,
      proposalId: "proposal-d448-lineage",
      ...lineage,
    })).toMatchObject({ status: "reserved" });
    expect(await recordTaskWriterReviewAcceptedReceipt(db, {
      taskId: task.id,
      taskRunId: run.id,
      proposalId: "proposal-d448-lineage",
      resultRevision: { kind: "artifact_revision", revision: 9 },
    })).toMatchObject({ status: "recorded" });
    expect(await finalizeTaskExternalReviewAcceptedReceipt(db, {
      taskId: task.id,
      taskRunId: run.id,
      proposalId: "proposal-d448-lineage",
      resultRevision: { kind: "artifact_revision", revision: 9 },
    })).toMatchObject({ status: "requeued" });
    const verification = await startTaskRunForWriterReviewVerification(db, {
      taskId: task.id,
      graphThreadId: `writer-review:lineage:${crypto.randomUUID()}`,
      status: "running",
    });
    expect(verification).toBeDefined();
    expect((await getTaskById(db, task.id))?.metadata["writerReviewAcceptedReceipt"])
      .toMatchObject({
        acceptedWorkspaceOperationId: lineage.operationId,
        acceptedWorkspaceClientMutationId: lineage.clientMutationId,
        acceptedWorkspaceArtifactId: lineage.artifactInternalId,
        verificationRunId: verification?.id,
      });
  });

  test("restart proves a matching reserved D448 save, then terminalizes without requeueing", async () => {
    const { user, task, run } = await seedRunningTask();
    const operationId = `workspace-editor:writer-recovery:${crypto.randomUUID()}`;
    const receiptSuffix = crypto.randomUUID();
    const clientMutationId = `live-review:${"a".repeat(64)}`;
    const artifact = await insertArtifact({
      artifactId: `writer-recovery-${crypto.randomUUID()}`,
      path: "writer/recovery.html",
      storageUri: "file:///writer-recovery-after",
      mimeType: "application/vnd.nautilo.writer+html",
      size: 2,
    }, db);
    try {
      expect(await reserveTaskWriterReviewWorkspaceOperation(db, {
        taskId: task.id,
        taskRunId: run.id,
        proposalId: "proposal-d448-found",
        operationId,
        clientMutationId,
        artifactInternalId: artifact.id,
      })).toMatchObject({ status: "reserved" });
      const before = {
        identity: { kind: "workspace_artifact" as const, artifactId: artifact.id, logicalPath: artifact.path },
        backendVersion: { kind: "artifact_revision" as const, revision: artifact.revision },
        sha256: "b".repeat(64),
      };
      const after = {
        ...before,
        backendVersion: { kind: "artifact_revision" as const, revision: artifact.revision + 1 },
        sha256: "c".repeat(64),
      };
      const event: Extract<DocumentMutationCommittedEvent, { mutation: "update" }> = {
        type: "document.mutation.committed",
        operationId,
        revisionGroupId: `writer-recovery-group:${operationId}`,
        sequence: 0,
        outcome: "applied",
        actor: { kind: "human", humanId: user.id },
        mutation: "update",
        path: { kind: "update", before: before.identity, after: after.identity },
        before,
        after,
        editorSave: { checkpoint: true, clientMutationId },
      };
      await db.transaction(async (tx) => {
        const lock = await acquireWorkspaceDocumentMutationOperationLock(tx, operationId);
        await insertWorkspaceDocumentMutationReceipt(tx, lock, {
          operationId,
          requestDigest: "d".repeat(64),
          revisionGroupId: event.revisionGroupId,
          ownerId: user.id,
          userId: user.id,
          actorKind: "human",
          actorId: user.id,
          lane: "editor_save",
          clientMutationId,
          editorRequestFingerprint: "e".repeat(64),
          entries: [{
            sequence: 0,
            kind: "update",
            revisionIds: [`writer-recovery-revision:${receiptSuffix}`],
            undoRecordIds: [`writer-recovery-undo:${receiptSuffix}`],
            artifactInternalId: artifact.id,
            beforeLogicalPath: artifact.path,
            afterLogicalPath: artifact.path,
            beforeRevision: artifact.revision,
            afterRevision: artifact.revision + 1,
            beforeSha256: before.sha256,
            afterSha256: after.sha256,
            beforeSize: 1,
            afterSize: 2,
            beforeStorageUri: "file:///writer-recovery-before",
            afterStorageUri: "file:///writer-recovery-after",
            checkpoint: true,
          }],
          eventBatch: {
            operationId,
            revisionGroupId: event.revisionGroupId,
            idempotencyKey: `document-mutation:v1:${JSON.stringify([operationId, event.revisionGroupId])}`,
            events: [event],
          },
        });
      });
      expect(await db.transaction(async (tx) => {
        const lock = await acquireWorkspaceDocumentMutationOperationLock(tx, operationId);
        return findWorkspaceEditorSaveForWriterReviewRecovery(tx, lock, {
          clientMutationId,
          actorId: user.id,
          artifactInternalId: artifact.id,
        });
      })).toEqual({
        kind: "match",
        revision: artifact.revision + 1,
        sha256: after.sha256,
      });
      for (const expected of [
        { clientMutationId: `live-review:${"f".repeat(64)}`, actorId: user.id, artifactInternalId: artifact.id },
        { clientMutationId, actorId: crypto.randomUUID(), artifactInternalId: artifact.id },
        { clientMutationId, actorId: user.id, artifactInternalId: crypto.randomUUID() },
      ]) {
        expect(await db.transaction(async (tx) => {
          const lock = await acquireWorkspaceDocumentMutationOperationLock(tx, operationId);
          return findWorkspaceEditorSaveForWriterReviewRecovery(tx, lock, expected);
        })).toEqual({ kind: "invalid" });
      }
      expect(await db.transaction(async (tx) => {
        const lock = await acquireWorkspaceDocumentMutationOperationLock(
          tx,
          `workspace-editor:writer-recovery:absent:${crypto.randomUUID()}`,
        );
        return findWorkspaceEditorSaveForWriterReviewRecovery(tx, lock, {
          clientMutationId,
          actorId: user.id,
          artifactInternalId: artifact.id,
        });
      })).toEqual({ kind: "absent" });
      const observer = new TaskObserver({
        db,
        jobManager: {
          abortJob: () => false,
          createForegroundJob: () => {
            throw new Error("recovered Writer receipt must not requeue provider work");
          },
        },
        maintenanceGate: permissiveMaintenanceGate,
      });
      await observer.start();
      try {
        expect(await getTaskById(db, task.id)).toMatchObject({
          status: "errored",
          lastError: "LIVE_WRITER_VERIFICATION_LOST_ON_RESTART",
        });
        expect((await getTaskRuns(db, task.id))).toHaveLength(1);
        expect((await getTaskRuns(db, task.id))[0]).toMatchObject({
          status: "errored",
          resultText: SAFE_WRITER_REVIEW_SAVED_VERIFICATION_LOST_RESULT,
        });
        expect((await getTaskById(db, task.id))?.metadata["writerReviewAwaiting"]).toBeUndefined();
        expect((await getTaskById(db, task.id))?.metadata["writerReviewAcceptedReceipt"])
          .toMatchObject({
            taskRunId: run.id,
            proposalId: "proposal-d448-found",
            acceptedResultRevision: { kind: "artifact_revision", revision: artifact.revision + 1 },
            acceptedWorkspaceOperationId: operationId,
            acceptedWorkspaceClientMutationId: clientMutationId,
            acceptedWorkspaceArtifactId: artifact.id,
          });
      } finally {
        await observer.stop();
      }
    } finally {
      await db.delete(workspaceDocumentMutations)
        .where(eq(workspaceDocumentMutations.operationId, operationId));
      await db.delete(artifacts).where(eq(artifacts.id, artifact.id));
    }
  });

  test("restart reports saved work but never reconstructs authority for verification", async () => {
    const { task, run } = await seedRunningTask();
    // The Human may accept before the model leg returns. The exact receipt
    // must already be durable while the TaskRun is still running.
    expect(await recordTaskWriterReviewAcceptedReceipt(db, {
      taskId: task.id,
      taskRunId: run.id,
      proposalId: "proposal-restart-accepted",
      resultRevision: { kind: "artifact_revision", revision: 8 },
    })).toMatchObject({ status: "recorded" });
    expect(await getTaskById(db, task.id)).toMatchObject({ status: "running" });

    const observer = new TaskObserver({
      db,
      jobManager: {
        abortJob: () => false,
        createForegroundJob: () => {
          throw new Error("restart must not dispatch Writer verification without live authority");
        },
      },
      maintenanceGate: permissiveMaintenanceGate,
    });
    await observer.start();
    try {
      expect(await getTaskById(db, task.id)).toMatchObject({
        status: "errored",
        lastError: "LIVE_WRITER_VERIFICATION_LOST_ON_RESTART",
      });
      expect((await getTaskRuns(db, task.id))[0]).toMatchObject({
        status: "errored",
        resultText: SAFE_WRITER_REVIEW_SAVED_VERIFICATION_LOST_RESULT,
      });
    } finally {
      await observer.stop();
    }
  });

  test("restart terminalizes an already-requeued verification without creating another run", async () => {
    const { task, run } = await seedRunningTask();
    expect(await recordTaskWriterReviewAcceptedReceipt(db, {
      taskId: task.id,
      taskRunId: run.id,
      proposalId: "proposal-restart-requeued",
      resultRevision: { kind: "artifact_revision", revision: 8 },
    })).toMatchObject({ status: "recorded" });
    expect(await finalizeTaskExternalReviewAcceptedReceipt(db, {
      taskId: task.id,
      taskRunId: run.id,
      proposalId: "proposal-restart-requeued",
      resultRevision: { kind: "artifact_revision", revision: 8 },
    })).toEqual({ status: "requeued" });
    expect(await getTaskById(db, task.id)).toMatchObject({ status: "pending" });
    expect((await getTaskRuns(db, task.id))[0]).toMatchObject({
      status: "completed",
      resultText: SAFE_WRITER_REVIEW_ACCEPTED_RESULT,
    });

    const observer = new TaskObserver({
      db,
      jobManager: {
        abortJob: () => false,
        createForegroundJob: () => {
          throw new Error("restart must not create a Writer verification run without live authority");
        },
      },
      maintenanceGate: permissiveMaintenanceGate,
    });
    await observer.start();
    try {
      expect(await getTaskById(db, task.id)).toMatchObject({
        status: "errored",
        lastError: "LIVE_WRITER_VERIFICATION_LOST_ON_RESTART",
      });
      const runs = await getTaskRuns(db, task.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        status: "completed",
        resultText: SAFE_WRITER_REVIEW_ACCEPTED_RESULT,
      });
    } finally {
      await observer.stop();
    }
  });

  test("restart terminalizes a verification run started just before process loss", async () => {
    const { task, run } = await seedRunningTask();
    expect(await recordTaskWriterReviewAcceptedReceipt(db, {
      taskId: task.id,
      taskRunId: run.id,
      proposalId: "proposal-restart-running-verification",
      resultRevision: { kind: "artifact_revision", revision: 8 },
    })).toMatchObject({ status: "recorded" });
    expect(await finalizeTaskExternalReviewAcceptedReceipt(db, {
      taskId: task.id,
      taskRunId: run.id,
      proposalId: "proposal-restart-running-verification",
      resultRevision: { kind: "artifact_revision", revision: 8 },
    })).toEqual({ status: "requeued" });
    const verificationRun = await startTaskRunForWriterReviewVerification(db, {
      taskId: task.id,
      graphThreadId: `writer-review:verification:${crypto.randomUUID()}`,
      status: "running",
    });
    expect(verificationRun).toBeDefined();
    expect(await getTaskById(db, task.id)).toMatchObject({ status: "running" });

    const observer = new TaskObserver({
      db,
      jobManager: {
        abortJob: () => false,
        createForegroundJob: () => {
          throw new Error("restart must not wait for or create Writer verification provider work");
        },
      },
      maintenanceGate: permissiveMaintenanceGate,
    });
    await observer.start();
    try {
      expect(await getTaskById(db, task.id)).toMatchObject({
        status: "errored",
        lastError: "LIVE_WRITER_VERIFICATION_LOST_ON_RESTART",
      });
      const runs = await getTaskRuns(db, task.id);
      expect(runs).toHaveLength(2);
      expect(runs.find((candidate) => candidate.id === run.id)).toMatchObject({
        status: "completed",
        resultText: SAFE_WRITER_REVIEW_ACCEPTED_RESULT,
      });
      expect(runs.find((candidate) => candidate.id === verificationRun?.id)).toMatchObject({
        status: "errored",
        resultText: SAFE_WRITER_REVIEW_SAVED_VERIFICATION_LOST_RESULT,
      });
    } finally {
      await observer.stop();
    }
  });
});
