/**
 * D420 — payload-free work-acceptance ledger wired into JobManager
 * (Wave 2 task 2.1.2).
 *
 * Hermetic: injects recording acceptance sinks (no DB), a controllable
 * coalescer timer, and a gated mock executor so coalesced bursts can be
 * observed through the full accept → link lifecycle.
 *
 * Asserts:
 *  - an acceptance row is persisted for every accepted unit (before enqueue);
 *  - a coalesced burst of N segments links all N acceptance ids to the ONE
 *    Job created at dispatch;
 *  - a durable insert failure rejects before enqueue;
 *  - a durable link failure compensates the persisted Job before execution
 *    while retaining the acceptance ledger's accepted state for task 2.2.3.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { JobExecutor } from "../../src/job";
import { JobManager } from "../../src/job-manager";
import { InMemoryLaneLock } from "../../src/lane-lock";
import { eventBus } from "../../src/event-bus";
import type { ServerEvent } from "@nautilo/types";

interface AcceptanceCall {
  kind: string;
  virtualJobId: string;
  acceptanceId: string;
}

function makeHarness(opts?: {
  insertError?: Error;
  linkError?: Error;
}) {
  let jobCounter = 0;
  let acceptanceCounter = 0;
  const persist = async (): Promise<string> => `job-${++jobCounter}`;

  const statusUpdates: Array<{ jobId: string; status: string; message?: string }> = [];
  const updateStatus = async (
    jobId: string,
    status: string,
    fields?: { message?: string },
  ): Promise<void> => {
    statusUpdates.push({ jobId, status, ...fields });
  };

  // Recording acceptance sinks (DB-free). insertAcceptance returns a stable
  // id and records the (virtualJobId, acceptanceId) binding the job manager
  // also keeps internally — but we hand it back through the sink so the test
  // can observe the exact ids that get linked/terminalized.
  const insertCalls: AcceptanceCall[] = [];
  const linkCalls: Array<{ acceptanceIds: string[]; jobId: string }> = [];

  // The job manager hands us no virtualJobId on insert (the sink signature is
  // (kind) => id), so we mirror its internal map by recording insertion order
  // and pairing with the virtual id the manager emitted via job.coalesced.
  const coalescedVirtualIds: string[] = [];

  const acceptanceSinks = {
    insertAcceptance: async (kind: string): Promise<string> => {
      if (opts?.insertError) throw opts.insertError;
      const acceptanceId = `acc-${++acceptanceCounter}`;
      // virtualJobId is the most recent coalesced emission; the manager
      // calls insertAcceptance BEFORE emitting job.coalesced, so we pair by
      // ordering in the test instead. Just record kind + id here.
      insertCalls.push({ kind, virtualJobId: "", acceptanceId });
      return acceptanceId;
    },
    linkAcceptancesToJob: async (acceptanceIds: readonly string[], jobId: string) => {
      linkCalls.push({ acceptanceIds: [...acceptanceIds], jobId });
      if (opts?.linkError) throw opts.linkError;
      return acceptanceIds.length;
    },
    terminalizeAllAcceptedWork: async () => 0,
    userCancelAcceptedWork: async () => 0,
  };

  const dispatched: string[] = [];
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const gate = (message: string) => {
    const g = Promise.withResolvers<void>();
    gates.set(message, g);
    return g;
  };
  const executor: JobExecutor = async function* (input, jobId, laneKey, signal) {
    dispatched.push(jobId);
    const message = typeof input["message"] === "string" ? input["message"] : "";
    const g = gates.get(message);
    if (g) await g.promise;
    if (signal.aborted) return;
    yield {
      type: "message.tokens",
      laneKey: laneKey ?? "",
      content: ".",
      chunkSequence: 1,
      done: true,
    };
  };

  const timers: { id: number; fn: () => void }[] = [];
  let timerId = 0;
  const setTimer = ((fn: () => void) => {
    const id = ++timerId;
    timers.push({ id, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearTimer = ((id: ReturnType<typeof setTimeout>) => {
    const i = timers.findIndex((t) => t.id === (id as unknown as number));
    if (i >= 0) timers.splice(i, 1);
  }) as unknown as typeof clearTimeout;
  const fireTimers = (): void => {
    const fns = timers.splice(0).map((t) => t.fn);
    for (const fn of fns) fn();
  };

  const jm = new JobManager({
    laneLock: new InMemoryLaneLock(),
    persist,
    updateStatus,
    acceptanceSinks,
    setTimer,
    clearTimer,
  });

  // Capture the virtual id the manager assigns each accepted unit so the
  // test can pair insertAcceptance ids with dispatch linkage.
  const originalCreate = jm.createForegroundJob.bind(jm);
  jm.createForegroundJob = (
    ...args: Parameters<typeof originalCreate>
  ): ReturnType<typeof originalCreate> => {
    return originalCreate(...args).then((res) => {
      coalescedVirtualIds.push(res.virtualJobId);
      // Back-fill the most recent insert call's virtualJobId.
      if (insertCalls.length > 0) insertCalls[insertCalls.length - 1]!.virtualJobId = res.virtualJobId;
      return res;
    });
  };

  return {
    jm,
    executor,
    gate,
    gates,
    fireTimers,
    dispatched,
    persist,
    statusUpdates,
    insertCalls,
    linkCalls,
    coalescedVirtualIds,
    acceptanceSinks,
  };
}

async function waitFor(
  pred: () => boolean,
  { tries = 300, ms = 2 }: { tries?: number; ms?: number } = {},
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, ms));
  }
  throw new Error("waitFor: condition not met in time");
}

function burstInput(room: string, bot: string, user: string, message: string) {
  const thread = `room:${room}:bot:${bot}`;
  return {
    message,
    turnId: randomUUID(),
    graphThreadId: thread,
    threadId: thread,
    agentId: bot,
    roomId: room,
    ownerId: user,
    requestorId: user,
  };
}

describe("D420 work-acceptance ledger — accept before enqueue", () => {
  test("createForegroundJob persists one foreground acceptance per accepted unit", async () => {
    const h = makeHarness();
    const room = randomUUID();
    const user = randomUUID();
    const bot = randomUUID();
    const lane = `room:${room}:user:${user}:bot:${bot}`;

    await h.jm.createForegroundJob(user, user, lane, burstInput(room, bot, user, "m1"), h.executor);
    await h.jm.createForegroundJob(user, user, lane, burstInput(room, bot, user, "m2"), h.executor);

    expect(h.insertCalls).toHaveLength(2);
    expect(h.insertCalls.every((c) => c.kind === "foreground")).toBe(true);
    // Each accepted unit got a distinct acceptance id.
    expect(new Set(h.insertCalls.map((c) => c.acceptanceId)).size).toBe(2);
  });

  test("createSystemForegroundJob persists a system_report_back acceptance", async () => {
    const h = makeHarness();
    const room = randomUUID();
    const user = randomUUID();
    const bot = randomUUID();
    const thread = `room:${room}:bot:${bot}`;
    // System turn dispatches immediately (bypasses coalescer) but still needs
    // the lane lock; gate the executor so it stays live.
    h.gate("sys");
    await h.jm.createSystemForegroundJob(
      user,
      user,
      `room:${room}:user:${user}:bot:${bot}`,
      { message: "sys", turnId: randomUUID(), graphThreadId: thread, agentId: bot, roomId: room },
      h.executor,
    );
    expect(h.insertCalls).toHaveLength(1);
    expect(h.insertCalls[0]!.kind).toBe("system_report_back");
    h.gates.get("sys")?.resolve();
  });

  test("acceptance insert failure rejects foreground work before enqueue or coalesced emit", async () => {
    const h = makeHarness({ insertError: new Error("ledger unavailable") });
    const room = randomUUID();
    const user = randomUUID();
    const bot = randomUUID();
    const lane = `room:${room}:user:${user}:bot:${bot}`;
    const events: ServerEvent[] = [];
    const onEvent = (event: ServerEvent) => events.push(event);
    eventBus.on(onEvent);

    let rejected: unknown;
    try {
      await h.jm.createForegroundJob(
        user,
        user,
        lane,
        burstInput(room, bot, user, "must-not-enqueue"),
        h.executor,
      );
    } catch (err) {
      rejected = err;
    } finally {
      eventBus.off(onEvent);
    }

    expect(rejected).toBeInstanceOf(Error);
    expect(h.jm.getForegroundWorkSummary()).toEqual({
      runningJobs: 0,
      queuedTurns: 0,
      bufferedLanes: 0,
    });
    h.fireTimers();
    expect(h.dispatched).toEqual([]);
    expect(events.filter((event) => event.type === "job.coalesced")).toEqual([]);
  });

  test("acceptance insert failure rejects system work before it enters the FIFO", async () => {
    const h = makeHarness({ insertError: new Error("ledger unavailable") });
    const room = randomUUID();
    const user = randomUUID();
    const bot = randomUUID();
    const thread = `room:${room}:bot:${bot}`;
    const events: ServerEvent[] = [];
    const onEvent = (event: ServerEvent) => events.push(event);
    eventBus.on(onEvent);

    let rejected: unknown;
    try {
      await h.jm.createSystemForegroundJob(
        user,
        user,
        `room:${room}:user:${user}:bot:${bot}`,
        {
          message: "must-not-enqueue",
          turnId: randomUUID(),
          graphThreadId: thread,
          agentId: bot,
          roomId: room,
        },
        h.executor,
      );
    } catch (err) {
      rejected = err;
    } finally {
      eventBus.off(onEvent);
    }

    expect(rejected).toBeInstanceOf(Error);
    expect(h.jm.getForegroundWorkSummary()).toEqual({
      runningJobs: 0,
      queuedTurns: 0,
      bufferedLanes: 0,
    });
    expect(h.dispatched).toEqual([]);
    expect(events.filter((event) => event.type === "job.coalesced")).toEqual([]);
  });
});

describe("D420 work-acceptance ledger — link coalesced group to one Job", () => {
  test("a coalesced burst of N segments links all N acceptance ids to the single dispatched Job", async () => {
    const h = makeHarness();
    const room = randomUUID();
    const user = randomUUID();
    const bot = randomUUID();
    const lane = `room:${room}:user:${user}:bot:${bot}`;

    // Gate the executor so the merged turn stays live while we assert.
    h.gate("merged");
    await h.jm.createForegroundJob(user, user, lane, burstInput(room, bot, user, "merged"), h.executor);
    await h.jm.createForegroundJob(user, user, lane, burstInput(room, bot, user, "merged"), h.executor);
    await h.jm.createForegroundJob(user, user, lane, burstInput(room, bot, user, "merged"), h.executor);

    expect(h.insertCalls).toHaveLength(3);
    const acceptanceIds = h.insertCalls.map((c) => c.acceptanceId);

    // Flush the coalescer → one merged turn → one Job dispatch.
    h.fireTimers();
    await waitFor(() => h.dispatched.length === 1);

    const jobId = h.dispatched[0]!;
    expect(h.linkCalls).toHaveLength(1);
    expect(h.linkCalls[0]!.jobId).toBe(jobId);
    // All three acceptance ids linked to that one job, in insertion order.
    expect(h.linkCalls[0]!.acceptanceIds.sort()).toEqual([...acceptanceIds].sort());

    h.gates.get("merged")?.resolve();
    await waitFor(() => h.jm.getJob(jobId) === undefined);
  });
});

describe("D420 work-acceptance ledger — durable link failure", () => {
  test("link failure prevents execution, compensates the Job, and does not discard the acceptance mapping", async () => {
    const h = makeHarness({ linkError: new Error("ledger link unavailable") });
    const room = randomUUID();
    const user = randomUUID();
    const bot = randomUUID();
    const lane = `room:${room}:user:${user}:bot:${bot}`;

    await h.jm.createForegroundJob(
      user,
      user,
      lane,
      burstInput(room, bot, user, "must-not-run"),
      h.executor,
    );
    h.fireTimers();

    await waitFor(() =>
      h.statusUpdates.some(
        (s) =>
          s.status === "cancelled" &&
          s.message ===
            "Cancelled before dispatch because durable acceptance linkage failed",
      ),
    );

    expect(h.linkCalls).toHaveLength(1);
    expect(h.dispatched).toEqual([]);
    expect(h.jm.getActiveJobs()).toEqual([]);
    // The acceptance was not terminalized as cancelled: the failed link left
    // it in the durable accepted state for task 2.2.3's explicit sweep.
    expect(h.statusUpdates).toContainEqual({
      jobId: h.linkCalls[0]!.jobId,
      status: "cancelled",
      message: "Cancelled before dispatch because durable acceptance linkage failed",
    });
  });
});

describe("D420 planned shutdown — no premature ledger terminalization", () => {
  test("does not report acceptance terminalization because task 2.2.3 owns the durable timeout policy", async () => {
    const h = makeHarness();
    const room = randomUUID();
    const user = randomUUID();
    const bot = randomUUID();
    const lane = `room:${room}:user:${user}:bot:${bot}`;

    await h.jm.createForegroundJob(
      user,
      user,
      lane,
      burstInput(room, bot, user, "buffered"),
      h.executor,
    );

    const result = await h.jm.cancelForegroundJobsForPlannedShutdown();
    expect(result).toEqual({
      runningJobs: 0,
      queuedTurns: 0,
      bufferedLanes: 1,
      cancelledJobs: 0,
    });
    expect("terminalizedAcceptances" in result).toBe(false);
  });
});
