import { describe, expect, test } from "bun:test";
import type { JobExecutor } from "../../src/job";
import {
  JobManager,
  type WorkAcceptanceSinks,
} from "../../src/job-manager";
import { InMemoryLaneLock } from "../../src/lane-lock";
import type { LaneLock, ReleaseFn, TryAcquireResult } from "../../src/types";
import type {
  ProtectedTaskExecutionCandidate,
} from "../../src/tasks/protected-task-execution-candidate";
import type { ProtectedTaskJobReferenceV1 } from
  "../../src/tasks/protected-task-job-reference";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const REQUESTOR_ID = "20000000-0000-4000-8000-000000000002";
const AGENT_ID = "30000000-0000-4000-8000-000000000003";
const ROOM_ID = "40000000-0000-4000-8000-000000000004";
const TASK_ID = "50000000-0000-4000-8000-000000000005";
const RUN_ID = "60000000-0000-4000-8000-000000000006";
const JOB_ID = "protected-quiescence-job";
const THREAD_ID = `subagent:${TASK_ID}:${RUN_ID}`;

const publication = Object.freeze({
  publish: async () => {},
  awaitPublished: async () => false,
});
const startProtectedTaskJob = async () => "started" as const;
const settleProtectedTaskJobTerminal = async (
  _jobId: string,
  _reference: unknown,
  requested: "completed" | "failed" | "cancelled",
) => ({ kind: "transitioned", status: requested } as const);

function reference(): ProtectedTaskJobReferenceV1 {
  return {
    kind: "protected_task_run_v1",
    taskId: TASK_ID,
    taskRunId: RUN_ID,
    inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
    resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
    authorizationRequestId: `task-run-authorization:${RUN_ID}`,
    policyRevision: 7,
    executionSegment: 1,
  };
}

function acceptanceSinks(): WorkAcceptanceSinks {
  return {
    insertAcceptance: async () => "acceptance-1",
    linkAcceptancesToJob: async (ids) => ids.length,
    terminalizeAllAcceptedWork: async () => 0,
    userCancelAcceptedWork: async (ids) => ids.length,
  };
}

function candidate(
  afterWork?: () => Promise<void>,
  resultPublication = publication,
): ProtectedTaskExecutionCandidate {
  return {
    start: async () => ({ status: "started" }),
    async run<T>(work: Parameters<ProtectedTaskExecutionCandidate["run"]>[0]): Promise<T> {
      const result = await work(
        {},
        new AbortController().signal,
        resultPublication,
      ) as T;
      await afterWork?.();
      return result;
    },
    onIneligible() {},
  };
}

async function dispatchProtected(
  manager: JobManager,
  executor: JobExecutor,
  executionCandidate: ProtectedTaskExecutionCandidate,
): Promise<void> {
  await manager.createProtectedTaskJob({
    reference: reference(),
    scheduling: {
      ownerId: OWNER_ID,
      requestorId: REQUESTOR_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      callingRoomId: null,
      graphThreadId: THREAD_ID,
    },
    executor,
    candidate: executionCandidate,
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for protected Task settlement state");
}

class DeferredReleaseLaneLock implements LaneLock {
  readonly releaseStarted = Promise.withResolvers<void>();
  readonly allowRelease = Promise.withResolvers<void>();

  async acquire(): Promise<ReleaseFn> {
    throw new Error("Unexpected blocking lane acquisition");
  }

  async tryAcquire(): Promise<TryAcquireResult> {
    return {
      acquired: true,
      release: async () => {
        this.releaseStarted.resolve();
        await this.allowRelease.promise;
      },
    };
  }
}

describe("JobManager protected Task worker settlement", () => {
  test("registers before lifecycle start and a failed start does not poison the thread sequence", async () => {
    const startEntered = Promise.withResolvers<void>();
    const allowStartReturn = Promise.withResolvers<void>();
    let executorCalls = 0;
    let ineligible = 0;
    let persistCalls = 0;
    const manager = new JobManager({
      laneLock: new InMemoryLaneLock(),
      acceptanceSinks: acceptanceSinks(),
      startProtectedTaskJob,
      settleProtectedTaskJobTerminal,
      persist: async () => persistCalls++ === 0
        ? JOB_ID
        : "protected-after-start-race",
      updateStatus: async () => {},
    });
    await dispatchProtected(
      manager,
      async function* () {
        executorCalls += 1;
        yield* [];
      },
      {
        async start() {
          startEntered.resolve();
          await allowStartReturn.promise;
          return { status: "started" };
        },
        run: candidate().run,
        onIneligible() {
          ineligible += 1;
        },
      },
    );
    await startEntered.promise;

    let resolved = false;
    const stopped = manager.abortProtectedTaskRunAndWait({
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      jobId: JOB_ID,
    }).then((value) => {
      resolved = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(resolved).toBe(false);

    allowStartReturn.resolve();
    expect(await stopped).toEqual({ status: "stopped" });
    expect(executorCalls).toBe(0);
    expect(ineligible).toBe(1);
    expect(manager.getJob(JOB_ID)).toBeUndefined();

    await dispatchProtected(
      manager,
      async function* () {
        executorCalls += 1;
        yield* [];
      },
      candidate(undefined, Object.freeze({
        publish: async () => {},
        awaitPublished: async () => true,
      })),
    );
    await waitFor(() => executorCalls === 1);
    await waitFor(() => manager.getJob("protected-after-start-race") === undefined);
  });

  test("waits for executor, candidate, durable cancellation, lane release, and registry cleanup", async () => {
    const laneLock = new DeferredReleaseLaneLock();
    const executorEntered = Promise.withResolvers<void>();
    const allowExecutorReturn = Promise.withResolvers<void>();
    const workReturned = Promise.withResolvers<void>();
    const allowCandidateClose = Promise.withResolvers<void>();
    let signal: AbortSignal | null = null;
    const getSignal = (): AbortSignal | null => signal;
    const manager = new JobManager({
      laneLock,
      acceptanceSinks: acceptanceSinks(),
      startProtectedTaskJob,
      settleProtectedTaskJobTerminal,
      persist: async () => JOB_ID,
      updateStatus: async () => {},
    });
    await dispatchProtected(
      manager,
      async function* (_input, _jobId, _lane, activeSignal) {
        signal = activeSignal;
        executorEntered.resolve();
        await allowExecutorReturn.promise;
        yield* [];
      },
      candidate(async () => {
        workReturned.resolve();
        await allowCandidateClose.promise;
      }),
    );
    await executorEntered.promise;

    let resolved = false;
    const stopped = manager.abortProtectedTaskRunAndWait({
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      jobId: JOB_ID,
    }).then((value) => {
      resolved = true;
      return value;
    });
    expect(getSignal()?.aborted).toBe(true);
    await Promise.resolve();
    expect(resolved).toBe(false);

    allowExecutorReturn.resolve();
    await workReturned.promise;
    expect(resolved).toBe(false);
    allowCandidateClose.resolve();
    await laneLock.releaseStarted.promise;
    expect(resolved).toBe(false);
    laneLock.allowRelease.resolve();

    expect(await stopped).toEqual({ status: "stopped" });
    expect(manager.getJob(JOB_ID)).toBeUndefined();
    expect(await manager.abortProtectedTaskRunAndWait({
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      jobId: JOB_ID,
    })).toEqual({ status: "unavailable" });
  });

  test("missing process ownership and mismatched identity cannot fabricate stopped proof", async () => {
    const entered = Promise.withResolvers<void>();
    const allowReturn = Promise.withResolvers<void>();
    let signal: AbortSignal | null = null;
    const getSignal = (): AbortSignal | null => signal;
    const manager = new JobManager({
      laneLock: new InMemoryLaneLock(),
      acceptanceSinks: acceptanceSinks(),
      startProtectedTaskJob,
      settleProtectedTaskJobTerminal,
      persist: async () => JOB_ID,
      updateStatus: async () => {},
    });
    await dispatchProtected(
      manager,
      async function* (_input, _jobId, _lane, activeSignal) {
        signal = activeSignal;
        entered.resolve();
        await allowReturn.promise;
        yield* [];
      },
      candidate(),
    );
    await entered.promise;

    expect(await manager.abortProtectedTaskRunAndWait({
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      jobId: "unknown-owner-job",
    })).toEqual({ status: "unavailable" });
    expect(manager.abortProtectedTaskRunAndWait({
      taskId: `${TASK_ID}-other`,
      taskRunId: RUN_ID,
      jobId: JOB_ID,
    })).rejects.toThrow("identity does not match");
    expect(getSignal()?.aborted).toBe(false);

    const stopped = manager.abortProtectedTaskRunAndWait({
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      jobId: JOB_ID,
    });
    allowReturn.resolve();
    expect(await stopped).toEqual({ status: "stopped" });
  });

  test("does not report stopped before cancellation persistence finishes", async () => {
    const executorEntered = Promise.withResolvers<void>();
    const cancelPersistStarted = Promise.withResolvers<void>();
    const allowCancelPersist = Promise.withResolvers<void>();
    const manager = new JobManager({
      laneLock: new InMemoryLaneLock(),
      acceptanceSinks: acceptanceSinks(),
      startProtectedTaskJob,
      settleProtectedTaskJobTerminal: async (
        _jobId, _reference, requested,
      ) => {
        if (requested === "cancelled") {
          cancelPersistStarted.resolve();
          await allowCancelPersist.promise;
        }
        return { kind: "transitioned", status: requested };
      },
      persist: async () => JOB_ID,
      updateStatus: async () => {},
    });
    await dispatchProtected(
      manager,
      async function* (_input, _jobId, _lane, signal) {
        executorEntered.resolve();
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        yield* [];
      },
      candidate(),
    );
    await executorEntered.promise;

    let resolved = false;
    const stopped = manager.abortProtectedTaskRunAndWait({
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      jobId: JOB_ID,
    }).then((value) => {
      resolved = true;
      return value;
    });
    await cancelPersistStarted.promise;
    expect(resolved).toBe(false);
    expect(manager.getJob(JOB_ID)).toBeDefined();

    allowCancelPersist.resolve();
    expect(await stopped).toEqual({ status: "stopped" });
    expect(manager.getJob(JOB_ID)).toBeUndefined();
  });

  test("Plain foreground cleanup does not wait for lane release", async () => {
    const laneLock = new DeferredReleaseLaneLock();
    const executor: JobExecutor = async function* () { yield* []; };
    const manager = new JobManager({
      laneLock,
      acceptanceSinks: acceptanceSinks(),
      persist: async () => "plain-job",
      updateStatus: async () => {},
    });
    await manager.createForegroundJob(
      OWNER_ID,
      REQUESTOR_ID,
      "room:plain",
      {
        message: "plain",
        ownerId: OWNER_ID,
        requestorId: REQUESTOR_ID,
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        graphThreadId: "room:plain",
        turnId: "plain-turn",
      },
      executor,
      undefined,
      {
        executor,
        coalescing: "separate",
        contention: "serialize",
      },
    );

    await laneLock.releaseStarted.promise;
    await waitFor(() => manager.getJob("plain-job") === undefined);
    laneLock.allowRelease.resolve();
  });
});
