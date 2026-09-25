import { describe, expect, test } from "bun:test";
import type { PersistJobPayload } from "@nautilo/db";
import type { JobStatus, ServerEvent } from "@nautilo/types";

import { eventBus } from "../../src/event-bus";
import type { JobExecutor } from "../../src/job";
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
      async run(work) {
        order.push("open");
        return work({ message: sentinel, expectedOutput: `${sentinel}:expected` },
          new AbortController().signal);
      },
      onIneligible() {
        order.push("ineligible");
      },
    };
    const jm = new JobManager({
      laneLock: new InMemoryLaneLock(),
      acceptanceSinks: acceptanceSinks(order),
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

      expect(order.slice(0, 5)).toEqual([
        "accept",
        "persist",
        "link",
        "open",
        "executor",
      ]);
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
      persist: async (payload) => {
        persisted.push(payload);
        return `protected-job-${persisted.length}`;
      },
      updateStatus: async () => {},
    });
    const candidate = (message: string): ProtectedTaskExecutionCandidate => ({
      run: (work) => work({ message }, new AbortController().signal),
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
    let ineligible = 0;
    const jm = new JobManager({
      laneLock: new InMemoryLaneLock(),
      acceptanceSinks: acceptanceSinks([], () => 0),
      persist: async () => "protected-job-link-race",
      updateStatus: async () => {},
    });

    await jm.createProtectedTaskJob({
      scheduling: scheduling(),
      reference: reference(),
      executor: async function* () { yield* []; },
      candidate: {
        async run(work) {
          opened += 1;
          return work({ message: "must-not-open" }, new AbortController().signal);
        },
        onIneligible() {
          ineligible += 1;
        },
      },
    });
    await waitFor(() => ineligible === 1);
    expect(opened).toBe(0);
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
          async run(work) {
            opened += 1;
            return work({ message: "must-not-open" }, new AbortController().signal);
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
      persist: async () => "must-not-persist",
      updateStatus: async () => {},
    });
    try {
      await jm.createProtectedTaskJob({
        scheduling: scheduling(),
        reference: reference(),
        executor: async function* () { yield* []; },
        candidate: {
          async run(work) {
            opened += 1;
            return work({ message: "must-not-open" }, new AbortController().signal);
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
});
