import { ProtectedTaskExecutionDidNotBeginError } from "../../src/tasks/protected-task-execution-candidate";
import { describe, expect, test } from "bun:test";
import type { PersistJobPayload } from "@nautilo/db";
import type { JobStatus, ServerEvent } from "@nautilo/types";

import { eventBus } from "../../src/event-bus";
import {
  ProtectedTaskJobStartNotOwnedError,
  type JobExecutor,
} from "../../src/job";
import { JobManager, type WorkAcceptanceSinks } from "../../src/job-manager";
import { InMemoryLaneLock } from "../../src/lane-lock";
import type { ProtectedTaskExecutionCandidate } from
  "../../src/tasks/protected-task-execution-candidate";
import type { ProtectedTaskJobReferenceV1 } from
  "../../src/tasks/protected-task-job-reference";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const REQUESTOR_ID = "20000000-0000-4000-8000-000000000002";
const AGENT_ID = "30000000-0000-4000-8000-000000000003";
const ROOM_ID = "40000000-0000-4000-8000-000000000004";
const TASK_ID = "50000000-0000-4000-8000-000000000005";
const RUN_ID = "60000000-0000-4000-8000-000000000006";
const THREAD_ID = `subagent:${TASK_ID}:${RUN_ID}`;
const publication = Object.freeze({
  publish: async () => {},
  park: async () => {},
  awaitSettled: async () => true,
});
const startProtectedTaskJob = async () => "started" as const;
const settleProtectedTaskJobTerminal = async (
  _jobId: string,
  _reference: unknown,
  requested: "completed" | "failed" | "cancelled",
) => ({ kind: "transitioned", status: requested } as const);

function reference(
  taskId = TASK_ID,
  taskRunId = RUN_ID,
  suffix = "a",
): ProtectedTaskJobReferenceV1 {
  return {
    kind: "protected_task_run_v1",
    taskId,
    taskRunId,
    inputObjectId: `task-definition:v1:${suffix.repeat(64)}`,
    resultObjectId: `task-run-result:v1:${suffix.repeat(64)}`,
    authorizationRequestId: `task-run-authorization:${taskRunId}`,
    policyRevision: 7,
    executionSegment: 1,
  };
}

function scheduling(graphThreadId = THREAD_ID) {
  return {
    ownerId: OWNER_ID,
    requestorId: REQUESTOR_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    callingRoomId: null,
    graphThreadId,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for protected Task Job state");
}

function acceptanceSinks(
  events: string[],
  linkedCount: (ids: readonly string[]) => number = (ids) => ids.length,
): WorkAcceptanceSinks {
  return {
    insertAcceptance: async () => {
      events.push("accept");
      return `acceptance-${events.length}`;
    },
    linkAcceptancesToJob: async (ids) => {
      events.push("link");
      return linkedCount(ids);
    },
    terminalizeAllAcceptedWork: async () => 0,
    userCancelAcceptedWork: async (ids) => ids.length,
  };
}

describe("JobManager protected Task execution", () => {
  test("persists and links content-free state before opening transient input", async () => {
    const longThreadId = `subagent:${"a".repeat(300)}`;
    const order: string[] = [];
    const persisted: PersistJobPayload[] = [];
    const updates: Array<{ status: JobStatus; fields: unknown }> = [];
    const serverEvents: ServerEvent[] = [];
    const listener = (event: ServerEvent) => serverEvents.push(event);
    eventBus.on(listener);
    const sentinel = "PROTECTED_TASK_TRANSIENT_SENTINEL";
    let executorInput: Record<string, unknown> | null = null;
    let manager: JobManager;
    const startStatuses: Array<JobStatus | undefined> = [];
    const executor: JobExecutor = async function* (input) {
      order.push("executor");
      executorInput = input;
      yield {
        type: "message.tokens",
        laneKey: `task:${TASK_ID}`,
        content: sentinel,
        chunkSequence: 1,
        done: true,
      };
    };
    const candidate: ProtectedTaskExecutionCandidate = {
      async start(jobId) {
        order.push("start");
        startStatuses.push(manager.getJob(jobId)?.status);
        return { status: "started" };
      },
      async run(work) {
        order.push("open");
        return work({ message: sentinel, expectedOutput: `${sentinel}:expected` },
          new AbortController().signal, publication);
      },
      onIneligible() {
        order.push("ineligible");
      },
    };
    const jm = manager = new JobManager({
      laneLock: new InMemoryLaneLock(),
      acceptanceSinks: acceptanceSinks(order),
      startProtectedTaskJob,
      settleProtectedTaskJobTerminal,
      persist: async (payload) => {
        order.push("persist");
        persisted.push(payload);
        return "protected-job-1";
      },
      updateStatus: async (_jobId, status, fields) => {
        updates.push({ status, fields });
      },
    });

    try {
      await jm.createProtectedTaskJob({
        scheduling: scheduling(longThreadId),
        reference: reference(),
        executor,
        candidate,
      });
      await waitFor(() => order.includes("executor"));

      expect(order.slice(0, 6)).toEqual([
        "accept",
        "persist",
        "link",
        "start",
        "open",
        "executor",
      ]);
      expect(startStatuses).toEqual(["queued"]);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.input).toEqual(reference());
      expect(persisted[0]!.publicationPolicy).toEqual({
        expectedRevision: 7,
        representation: "protected_only",
      });
      expect(executorInput).toMatchObject({
        message: sentinel,
        expectedOutput: `${sentinel}:expected`,
        taskId: TASK_ID,
        taskRunId: RUN_ID,
        graphThreadId: longThreadId,
      });
      expect(executorInput).toHaveProperty("protectedTaskResultPublication", publication);
      expect(JSON.stringify({ persisted, updates, serverEvents })).not.toContain(sentinel);
      expect(order).not.toContain("ineligible");
    } finally {
      eventBus.off(listener);
    }
  });

  test("keeps same-thread protected occurrences separate and serialized", async () => {
    const persisted: PersistJobPayload[] = [];
    const started: string[] = [];
    const firstGate = Promise.withResolvers<void>();
    const executor: JobExecutor = async function* (input) {
      const message = String(input["message"]);
      started.push(message);
      if (message === "first") await firstGate.promise;
      yield* [];
    };
    const jm = new JobManager({
      laneLock: new InMemoryLaneLock(),
      acceptanceSinks: acceptanceSinks([]),
      startProtectedTaskJob,
      settleProtectedTaskJobTerminal,
      persist: async (payload) => {
        persisted.push(payload);
        return `protected-job-${persisted.length}`;
      },
      updateStatus: async () => {},
    });
    const candidate = (message: string): ProtectedTaskExecutionCandidate => ({
      start: async () => ({ status: "started" }),
      run: (work) => work({ message }, new AbortController().signal, publication),
      onIneligible: () => {},
    });
    const secondRunId = "70000000-0000-4000-8000-000000000007";

    await jm.createProtectedTaskJob({
      scheduling: scheduling(), reference: reference(), executor,
      candidate: candidate("first"),
    });
    await waitFor(() => started.length === 1);
    await jm.createProtectedTaskJob({
      scheduling: scheduling(),
      reference: reference(TASK_ID, secondRunId, "b"),
      executor,
      candidate: candidate("second"),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual(["first"]);
    expect(persisted).toHaveLength(1);

    firstGate.resolve();
    await waitFor(() => started.length === 2);
    expect(started).toEqual(["first", "second"]);
    expect(persisted.map((payload) => payload.input)).toEqual([
      reference(),
      reference(TASK_ID, secondRunId, "b"),
    ]);
  });

  test("a failed acceptance link never opens content and releases the candidate", async () => {
    let opened = 0;
    let started = 0;
    let ineligible = 0;
    const jm = new JobManager({
      laneLock: new InMemoryLaneLock(),
      acceptanceSinks: acceptanceSinks([], () => 0),
      startProtectedTaskJob,
      settleProtectedTaskJobTerminal,
      persist: async () => "protected-job-link-race",
      updateStatus: async () => {},
    });

    await jm.createProtectedTaskJob({
      scheduling: scheduling(),
      reference: reference(),
      executor: async function* () { yield* []; },
      candidate: {
        async start() {
          started += 1;
          return { status: "started" };
        },
        async run(work) {
          opened += 1;
          return work({ message: "must-not-open" }, new AbortController().signal, publication);
        },
        onIneligible() {
          ineligible += 1;
        },
      },
    });
    await waitFor(() => ineligible === 1);
    expect(started).toBe(0);
    expect(opened).toBe(0);
  });

  test("a stale protected lifecycle start uses exact recovery without a generic write", async () => {
    const order: string[] = [];
    const updates: Array<{ status: JobStatus; fields: unknown }> = [];
    let opened = 0;
    let ineligible = 0;
    const jm = new JobManager({
      laneLock: new InMemoryLaneLock(),
      acceptanceSinks: acceptanceSinks(order),
      startProtectedTaskJob,
      settleProtectedTaskJobTerminal,
      persist: async () => {
        order.push("persist");
        return "protected-job-stale";
      },
      updateStatus: async (_jobId, status, fields) => {
        updates.push({ status, fields });
      },
    });

    await jm.createProtectedTaskJob({
      scheduling: scheduling("subagent:protected-stale-start"),
      reference: reference(),
      executor: async function* () { yield* []; },
      candidate: {
        async start() {
          order.push("start");
          return { status: "stale" };
        },
        async run(work) {
          opened += 1;
          return work({ message: "must-not-open" }, new AbortController().signal, publication);
        },
        async deferBeforeExecution(jobId) {
          expect(jobId).toBe("protected-job-stale");
          order.push("recover");
          return true;
        },
        onIneligible() {
          ineligible += 1;
        },
      },
    });
    await waitFor(() => ineligible === 1);
    expect(order).toContain("recover");
    expect(updates).toEqual([]);

    expect(order.slice(0, 4)).toEqual(["accept", "persist", "link", "start"]);
    expect(opened).toBe(0);
    expect(ineligible).toBe(1);
  });

  test("a Stop racing lifecycle start releases the candidate before recovery", async () => {
    const order: string[] = [];
    let finished = false;
    let opened = 0;
    let manager: JobManager;
    const jm = manager = new JobManager({
      laneLock: new InMemoryLaneLock(),
      acceptanceSinks: acceptanceSinks([]),
      startProtectedTaskJob,
      settleProtectedTaskJobTerminal,
      persist: async () => "protected-job-start-stop-race",
      updateStatus: async () => {},
    });

    await jm.createProtectedTaskJob({
      scheduling: scheduling("subagent:protected-start-stop-race"),
      reference: reference(),
      executor: async function* () { yield* []; },
      candidate: {
        async start(jobId) {
          order.push("start");
          expect(await manager.cancelJob(jobId)).toBe(true);
          return { status: "started" };
        },
        async run(work) {
          opened += 1;
          return work(
            { message: "must-not-open" },
            new AbortController().signal,
            publication,
          );
        },
        async deferBeforeExecution(jobId) {
          expect(jobId).toBe("protected-job-start-stop-race");
          expect(finished).toBe(true);
          order.push("recover");
          return true;
        },
        onIneligible() {
          if (finished) return;
          finished = true;
          order.push("ineligible");
          throw new Error("candidate cleanup diagnostic");
        },
      },
    });
    await waitFor(() => order.includes("recover"));
    await waitFor(() => jm.getJob("protected-job-start-stop-race") === undefined);

    expect(order).toEqual(["start", "ineligible", "recover"]);
    expect(opened).toBe(0);
  });

  test("a protected lifecycle start failure cannot open content", async () => {
    let opened = 0;
    let recoveryAttempts = 0;
    let writes = 0;
    const jm = new JobManager({
      laneLock: new InMemoryLaneLock(),
      acceptanceSinks: acceptanceSinks([]),
      startProtectedTaskJob,
      settleProtectedTaskJobTerminal,
      persist: async () => "protected-job-start-failure",
      updateStatus: async () => { writes += 1; },
    });

    await jm.createProtectedTaskJob({
      scheduling: scheduling("subagent:protected-start-failure"),
      reference: reference(),
      executor: async function* () { yield* []; },
      candidate: {
        async start() {
          throw new Error("durable start unavailable");
        },
        async run(work) {
          opened += 1;
          return work({ message: "must-not-open" }, new AbortController().signal, publication);
        },
        async deferBeforeExecution() {
          recoveryAttempts += 1;
          throw new Error("recovery response unknown");
        },
        onIneligible() {},
      },
    });
    await waitFor(() => recoveryAttempts === 1);
    await waitFor(() => jm.getJob("protected-job-start-failure") === undefined);
    expect(writes).toBe(0);
    expect(opened).toBe(0);
  });

  test("a protected dispatch listener failure cannot strand execution after start", async () => {
    let executed = 0;
    let diagnosticInspected = false;
    const error = new Error();
    Object.defineProperty(error, "message", {
      get() {
        diagnosticInspected = true;
        throw new Error("protected diagnostic must remain opaque");
      },
    });
    const listener = (event: ServerEvent) => {
      if (event.type === "job.dispatched" && event.jobId === "protected-job-event") {
        throw error;
      }
    };
    eventBus.on(listener);
    const jm = new JobManager({
      laneLock: new InMemoryLaneLock(),
      acceptanceSinks: acceptanceSinks([]),
      startProtectedTaskJob,
      settleProtectedTaskJobTerminal,
      persist: async () => "protected-job-event",
      updateStatus: async () => {},
    });

    try {
      await jm.createProtectedTaskJob({
        scheduling: scheduling("subagent:protected-dispatch-event"),
        reference: reference(),
        executor: async function* () {
          executed += 1;
          yield* [];
        },
        candidate: {
          start: async () => ({ status: "started" }),
          run: (work) => work(
            { message: "protected-message" },
            new AbortController().signal,
            publication,
          ),
          onIneligible() {},
        },
      });
      await waitFor(() => executed === 1);
      expect(diagnosticInspected).toBe(false);
    } finally {
      eventBus.off(listener);
    }
  });

  test("Stop drops a queued candidate without persisting or opening content", async () => {
    const laneLock = new InMemoryLaneLock();
    const release = await laneLock.acquire(THREAD_ID);
    const stoppedTasks: string[] = [];
    const cancelledAcceptances: string[][] = [];
    let persisted = 0;
    let opened = 0;
    let ineligible = 0;
    const sinks = acceptanceSinks([]);
    sinks.userCancelAcceptedWork = async (ids) => {
      cancelledAcceptances.push([...ids]);
      return ids.length;
    };
    const jm = new JobManager({
      laneLock,
      acceptanceSinks: sinks,
      startProtectedTaskJob,
      settleProtectedTaskJobTerminal,
      taskStopSink: async (taskId) => {
        stoppedTasks.push(taskId);
      },
      persist: async () => {
        persisted += 1;
        return "must-not-persist";
      },
      updateStatus: async () => {},
    });

    try {
      await jm.createProtectedTaskJob({
        scheduling: scheduling(),
        reference: reference(),
        executor: async function* () { yield* []; },
        candidate: {
          start: async () => ({ status: "started" }),
          async run(work) {
            opened += 1;
            return work({ message: "must-not-open" }, new AbortController().signal, publication);
          },
          onIneligible() {
            ineligible += 1;
          },
        },
      });
      await jm.stopThread(THREAD_ID);
      expect(stoppedTasks).toEqual([TASK_ID]);
      expect(cancelledAcceptances).toHaveLength(1);
      expect(ineligible).toBe(1);
      expect(opened).toBe(0);
      expect(persisted).toBe(0);
    } finally {
      await release();
    }
  });

  test("planned shutdown drops process-local queued authority and does not recover it", async () => {
    const laneLock = new InMemoryLaneLock();
    const release = await laneLock.acquire(THREAD_ID);
    let opened = 0;
    let ineligible = 0;
    const jm = new JobManager({
      laneLock,
      acceptanceSinks: acceptanceSinks([]),
      startProtectedTaskJob,
      settleProtectedTaskJobTerminal,
      persist: async () => "must-not-persist",
      updateStatus: async () => {},
    });
    try {
      await jm.createProtectedTaskJob({
        scheduling: scheduling(),
        reference: reference(),
        executor: async function* () { yield* []; },
        candidate: {
          start: async () => ({ status: "started" }),
          async run(work) {
            opened += 1;
            return work({ message: "must-not-open" }, new AbortController().signal, publication);
          },
          onIneligible() {
            ineligible += 1;
          },
        },
      });
      await jm.cancelForegroundJobsForPlannedShutdown();
      await release();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(ineligible).toBe(1);
      expect(opened).toBe(0);
    } finally {
      await release().catch(() => {});
    }
  });

  test("a protected Job start loss releases local tracking without terminal writes", async () => {
    for (const disposition of ["rejected", "unknown"] as const) {
      const jobId = `protected-job-start-${disposition}`;
      const updates: JobStatus[] = [];
      let executed = 0;
      let startInput: readonly unknown[] | undefined;
      const jm = new JobManager({
        laneLock: new InMemoryLaneLock(),
        acceptanceSinks: acceptanceSinks([]),
        persist: async () => jobId,
        updateStatus: async (_jobId, status) => { updates.push(status); },
        startProtectedTaskJob: async (...input) => {
          startInput = input;
          if (disposition === "unknown") throw new Error("response lost");
          return "rejected";
        },
      });

      await jm.createProtectedTaskJob({
        scheduling: scheduling(`subagent:protected-job-start-${disposition}`),
        reference: reference(),
        executor: async function* () { executed += 1; yield* []; },
        candidate: {
          start: async () => ({ status: "started" }),
          run: (work) => work(
            { message: "must-not-open" },
            new AbortController().signal,
            publication,
          ),
          onIneligible() {},
        },
      });
      await waitFor(() => startInput !== undefined);
      await waitFor(() => jm.getJob(jobId) === undefined);

      expect(executed).toBe(0);
      expect(updates).toEqual([]);
      expect(startInput).toEqual([
        jobId,
        reference(),
        { expectedRevision: 7, representation: "protected_only" },
      ]);
    }
  });

  test("a typed pre-executor failure settles through guarded recovery, never generic fail", async () => {
    let writes = 0;
    let recovered = 0;
    let executed = 0;
    const jm = new JobManager({
      laneLock: new InMemoryLaneLock(), acceptanceSinks: acceptanceSinks([]),
      persist: async () => "protected-before-work",
      updateStatus: async () => { writes += 1; },
      startProtectedTaskJob,
      settleProtectedTaskJobTerminal,
    });
    await jm.createProtectedTaskJob({
      scheduling: scheduling("subagent:protected-before-work"), reference: reference(),
      executor: async function* () { executed += 1; yield* []; },
      candidate: {
        start: async () => ({ status: "started" }),
        run: async () => { throw new ProtectedTaskExecutionDidNotBeginError(); },
        deferBeforeExecution: async jobId => {
          expect(jobId).toBe("protected-before-work"); recovered += 1; return true;
        },
        onIneligible() {},
      },
    });
    await waitFor(() => recovered === 1);
    await waitFor(() => jm.getJob("protected-before-work") === undefined);
    expect(writes).toBe(0);
    expect(executed).toBe(0);
  });

  test("a start-shaped candidate close failure after confirmed running is terminalized normally", async () => {
    const updates: JobStatus[] = [];
    let executed = 0;
    const jm = new JobManager({
      laneLock: new InMemoryLaneLock(),
      acceptanceSinks: acceptanceSinks([]),
      persist: async () => "protected-job-post-start-failure",
      updateStatus: async () => {},
      startProtectedTaskJob,
      settleProtectedTaskJobTerminal: async (
        _jobId, _reference, requested,
      ) => {
        updates.push(requested);
        return { kind: "transitioned", status: requested };
      },
    });

    await jm.createProtectedTaskJob({
      scheduling: scheduling("subagent:protected-job-post-start-failure"),
      reference: reference(),
      executor: async function* () { executed += 1; yield* []; },
      candidate: {
        start: async () => ({ status: "started" }),
        async run(work) {
          await work(
            { message: "opened" },
            new AbortController().signal,
            Object.freeze({
              publish: async () => {},
              park: async () => {},
              awaitSettled: async () => false,
            }),
          );
          throw new ProtectedTaskJobStartNotOwnedError("rejected");
        },
        onIneligible() {},
      },
    });
    await waitFor(() => updates.includes("failed"));
    await waitFor(() => jm.getJob("protected-job-post-start-failure") === undefined);

    expect(executed).toBe(1);
    expect(updates).toEqual(["failed"]);
  });

  test("ordinary foreground dispatch retains its existing execution path", async () => {
    const persisted: PersistJobPayload[] = [];
    const executed: string[] = [];
    let protectedStarts = 0;
    const executor: JobExecutor = async function* (input) {
      executed.push(String(input["message"]));
      yield* [];
    };
    const jm = new JobManager({
      laneLock: new InMemoryLaneLock(),
      acceptanceSinks: acceptanceSinks([]),
      startProtectedTaskJob: async () => {
        protectedStarts += 1;
        return "started";
      },
      persist: async (payload) => {
        persisted.push(payload);
        return "ordinary-job";
      },
      updateStatus: async () => {},
    });

    await jm.createForegroundJob(
      OWNER_ID,
      REQUESTOR_ID,
      "room:ordinary",
      {
        message: "ordinary-message",
        ownerId: OWNER_ID,
        requestorId: REQUESTOR_ID,
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        graphThreadId: "room:ordinary",
        turnId: "ordinary-turn",
      },
      executor,
      undefined,
      {
        executor,
        coalescing: "separate",
        contention: "serialize",
      },
    );
    await waitFor(() => executed.length === 1);

    expect(executed).toEqual(["ordinary-message"]);
    expect(protectedStarts).toBe(0);
    expect(persisted[0]?.input).toMatchObject({ message: "ordinary-message" });
    expect(persisted[0]?.publicationPolicy).toBeUndefined();
  });
});
