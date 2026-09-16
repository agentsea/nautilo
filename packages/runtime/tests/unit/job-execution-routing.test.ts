import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { JobExecutor } from "../../src/job";
import {
  JobManager,
  type ForegroundExecutionRoute,
  type WorkAcceptanceSinks,
} from "../../src/job-manager";
import { forkCoordinator } from "../../src/fork/fork-coordinator";
import { InMemoryLaneLock } from "../../src/lane-lock";

type Dispatch = {
  executor: string;
  message: string;
  jobId: string;
  fork: boolean;
};

function makeHarness(options: {
  readonly taskStopSink?: (taskId: string) => Promise<void>;
} = {}) {
  let jobSequence = 0;
  let acceptanceSequence = 0;
  const dispatches: Dispatch[] = [];
  const linked: Array<{ acceptanceIds: readonly string[]; jobId: string }> = [];
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();

  const acceptanceSinks: WorkAcceptanceSinks = {
    insertAcceptance: async () => `acceptance-${++acceptanceSequence}`,
    linkAcceptancesToJob: async (acceptanceIds, jobId) => {
      linked.push({ acceptanceIds, jobId });
      return acceptanceIds.length;
    },
    terminalizeAllAcceptedWork: async () => 0,
    userCancelAcceptedWork: async () => 0,
  };
  const manager = new JobManager({
    laneLock: new InMemoryLaneLock(),
    persist: async () => `job-${++jobSequence}`,
    updateStatus: async () => {},
    acceptanceSinks,
    ...(options.taskStopSink ? { taskStopSink: options.taskStopSink } : {}),
  });

  const executor = (name: string): JobExecutor =>
    async function* (input, jobId, laneKey, signal) {
      const message = typeof input["message"] === "string" ? input["message"] : "";
      dispatches.push({
        executor: name,
        message,
        jobId,
        fork: Boolean(input["forkRun"]),
      });
      const gate = gates.get(message);
      if (gate) await gate.promise;
      if (signal.aborted) return;
      yield {
        type: "message.tokens",
        laneKey: laneKey ?? "",
        content: ".",
        chunkSequence: 1,
        done: true,
      };
    };

  return {
    manager,
    dispatches,
    linked,
    executor,
    gate(message: string) {
      const gate = Promise.withResolvers<void>();
      gates.set(message, gate);
      return gate;
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for execution route assertion");
}

function input(message: string, thread: string, room: string, user: string, bot = "bot") {
  return {
    message,
    turnId: randomUUID(),
    graphThreadId: thread,
    threadId: thread,
    roomId: room,
    ownerId: user,
    requestorId: user,
    agentId: bot,
  };
}

function serialRoute(executor: JobExecutor): ForegroundExecutionRoute {
  return { executor, coalescing: "separate", contention: "serialize" };
}

describe("D453 per-accepted-turn foreground execution routes", () => {
  test("uses the trusted pre-bound live-turn virtual Job id", async () => {
    const h = makeHarness();
    const room = randomUUID();
    const thread = `room:${room}:bot:shared`;
    const virtualJobId = randomUUID();

    const accepted = await h.manager.createForegroundJob(
      "alice",
      "alice",
      `room:${room}:user:alice:bot:shared`,
      input("pre-bound", thread, room, "alice", "shared"),
      undefined,
      undefined,
      serialRoute(h.executor("live-shadow")),
      undefined,
      undefined,
      virtualJobId,
    );
    expect(accepted.virtualJobId).toBe(virtualJobId);
    await waitFor(() => h.dispatches.length === 1);
  });

  test("shared graph thread keeps each accepted route's executor", async () => {
    const h = makeHarness();
    const room = randomUUID();
    const thread = `room:${room}:bot:shared`;
    const laneA = `room:${room}:user:alice:bot:shared`;
    const laneB = `room:${room}:user:bob:bot:shared`;
    const releaseA = h.gate("A");

    await h.manager.createForegroundJob(
      "alice",
      "alice",
      laneA,
      input("A", thread, room, "alice", "shared"),
      undefined,
      undefined,
      serialRoute(h.executor("route-A")),
    );
    await waitFor(() => h.dispatches.length === 1);

    await h.manager.createForegroundJob(
      "bob",
      "bob",
      laneB,
      input("B", thread, room, "bob", "shared"),
      undefined,
      undefined,
      serialRoute(h.executor("route-B")),
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(h.dispatches).toHaveLength(1);
    expect(h.dispatches[0]?.executor).toBe("route-A");
    expect(h.dispatches[0]?.message).toBe("A");
    expect(h.dispatches[0]?.fork).toBe(false);

    releaseA.resolve();
    await waitFor(() => h.dispatches.length === 2);
    expect(h.dispatches[1]?.executor).toBe("route-B");
    expect(h.dispatches[1]?.message).toBe("B");
    expect(h.dispatches[1]?.fork).toBe(false);
  });

  test("serialize-on-contention waits for the main turn instead of forking", async () => {
    const h = makeHarness();
    const room = randomUUID();
    const thread = `room:${room}:bot:shared`;
    const releaseMain = h.gate("main");
    const route = serialRoute(h.executor("harness"));

    await h.manager.createForegroundJob(
      "alice",
      "alice",
      `room:${room}:user:alice:bot:shared`,
      input("main", thread, room, "alice", "shared"),
      undefined,
      undefined,
      route,
    );
    await waitFor(() => h.dispatches.length === 1);
    await h.manager.createForegroundJob(
      "bob",
      "bob",
      `room:${room}:user:bob:bot:shared`,
      input("queued", thread, room, "bob", "shared"),
      undefined,
      undefined,
      route,
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(h.dispatches).toHaveLength(1);

    releaseMain.resolve();
    await waitFor(() => h.dispatches.length === 2);
    expect(h.dispatches[1]?.message).toBe("queued");
    expect(h.dispatches[1]?.executor).toBe("harness");
    expect(h.dispatches[1]?.fork).toBe(false);
  });

  test("separate routes retain distinct acceptance-to-Job links in FIFO order", async () => {
    const h = makeHarness();
    const room = randomUUID();
    const thread = `room:${room}:bot:shared`;
    const lane = `room:${room}:user:alice:bot:shared`;
    const releaseFirst = h.gate("first");
    const route = serialRoute(h.executor("harness"));

    const first = await h.manager.createForegroundJob(
      "alice", "alice", lane, input("first", thread, room, "alice", "shared"), undefined, undefined, route,
    );
    await waitFor(() => h.dispatches.length === 1);
    const second = await h.manager.createForegroundJob(
      "alice", "alice", lane, input("second", thread, room, "alice", "shared"), undefined, undefined, route,
    );
    expect(first.virtualJobId).not.toBe(second.virtualJobId);
    expect(h.linked).toHaveLength(1);
    expect(h.linked[0]?.acceptanceIds).toHaveLength(1);

    releaseFirst.resolve();
    await waitFor(() => h.dispatches.length === 2 && h.linked.length === 2);
    expect(h.dispatches.map((dispatch) => dispatch.message)).toEqual(["first", "second"]);
    expect(h.linked.map((link) => link.acceptanceIds.length)).toEqual([1, 1]);
    expect(h.linked.map((link) => link.jobId)).toEqual(["job-1", "job-2"]);
  });

  test("stopping queued routed work clears it without dispatching that route", async () => {
    const h = makeHarness();
    const room = randomUUID();
    const thread = `room:${room}:bot:shared`;
    const releaseMain = h.gate("main");
    const route = serialRoute(h.executor("harness"));
    const laneA = `room:${room}:user:alice:bot:shared`;
    const laneB = `room:${room}:user:bob:bot:shared`;

    await h.manager.createForegroundJob(
      "alice", "alice", laneA, input("main", thread, room, "alice", "shared"), undefined, undefined, route,
    );
    await waitFor(() => h.dispatches.length === 1);
    await h.manager.createForegroundJob(
      "bob", "bob", laneB, input("discard", thread, room, "bob", "shared"), undefined, undefined, route,
    );
    await h.manager.stopThread(thread);
    releaseMain.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.dispatches.map((dispatch) => dispatch.message)).not.toContain("discard");

    await h.manager.createForegroundJob(
      "bob", "bob", laneB, input("fresh", thread, room, "bob", "shared"), undefined, undefined, route,
    );
    await waitFor(() => h.dispatches.some((dispatch) => dispatch.message === "fresh"));
  });

  test("Stop terminalizes queued external TaskRuns exactly once before releasing their virtual work", async () => {
    const stoppedTasks: string[] = [];
    const h = makeHarness({
      taskStopSink: async (taskId) => { stoppedTasks.push(taskId); },
    });
    const room = randomUUID();
    const thread = `room:${room}:bot:shared`;
    const releaseMain = h.gate("main");
    const route = serialRoute(h.executor("harness"));
    const laneA = `room:${room}:user:alice:bot:shared`;
    const laneB = `room:${room}:user:bob:bot:shared`;

    await h.manager.createForegroundJob(
      "alice",
      "alice",
      laneA,
      {
        ...input("main", thread, room, "alice", "shared"),
        taskId: "task-active",
        taskRunId: "run-active",
      },
      undefined,
      undefined,
      route,
    );
    await waitFor(() => h.dispatches.length === 1);

    await h.manager.createForegroundJob(
      "bob",
      "bob",
      laneB,
      {
        ...input("follow-up", thread, room, "bob", "shared"),
        taskId: "task-queued",
        taskRunId: "run-queued",
      },
      undefined,
      undefined,
      route,
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(h.dispatches).toHaveLength(1);

    const [first, second] = await Promise.all([
      h.manager.stopThread(thread),
      h.manager.stopThread(thread),
    ]);
    expect(first.droppedQueuedTurns).toBe(1);
    expect(second.droppedQueuedTurns).toBe(0);
    expect(stoppedTasks.sort()).toEqual(["task-active", "task-queued"]);

    releaseMain.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.dispatches.map((dispatch) => dispatch.message)).not.toContain("follow-up");
  });

  test("fork reconciliation wakes a serialize route waiting behind a paused native fork", async () => {
    const h = makeHarness();
    const room = randomUUID();
    const thread = `room:${room}:bot:shared`;
    const forkThread = `${thread}:fork:paused:${randomUUID()}`;

    const mainSequence = forkCoordinator.nextSequence(thread);
    forkCoordinator.registerTurn(thread, {
      sequence: mainSequence,
      jobId: "completed-main",
      turnId: randomUUID(),
      kind: "main",
      mergedSlice: {
        message: "main",
        attachmentTextBlocks: [],
        multimodalImages: [],
      },
    });
    forkCoordinator.markMainCompleted(thread, "completed-main");
    const forkSequence = forkCoordinator.nextSequence(thread);
    forkCoordinator.registerForkTurn(thread, {
      sequence: forkSequence,
      jobId: "paused-fork",
      turnId: randomUUID(),
      mergedSlice: {
        message: "fork",
        attachmentTextBlocks: [],
        multimodalImages: [],
      },
      forkThreadId: forkThread,
    });

    await h.manager.createForegroundJob(
      "alice",
      "alice",
      `room:${room}:user:alice:bot:shared`,
      input("after approval", thread, room, "alice", "shared"),
      undefined,
      undefined,
      serialRoute(h.executor("harness")),
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(h.dispatches).toHaveLength(0);

    h.manager.reconcileForkAndResumePendingTurns(forkThread);
    await waitFor(() => h.dispatches.length === 1);
    expect(h.dispatches[0]?.message).toBe("after approval");
    expect(h.dispatches[0]?.fork).toBe(false);
  });
});
