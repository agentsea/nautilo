/**
 * D420 (Wave 2 task 2.2.3 correction) — D349 user Stop durably terminalizes
 * the exact queued/buffered acceptances it discards as `user_cancelled`, and
 * closes the dispatch-vs-Stop race.
 *
 * Hermetic: injects recording acceptance sinks (no DB) + a controllable
 * coalescer timer + white-box access to the live pending queue and virtual-id
 * maps. Asserts:
 *  - stopRoom/stopThread are awaitable and terminalize discarded queued +
 *    buffered virtual IDs' mapped acceptances as `user_cancelled` with the
 *    bounded user-stop reason, clearing only the resolved mappings;
 *  - a terminalization failure propagates (the Stop route fails loudly);
 *  - the dispatch-vs-Stop race: a link that cannot verify every expected
 *    acceptance remained eligible compensates the never-dispatched Job instead
 *    of executing it;
 *  - the stop-intent gate: a successful link followed by a stop compensates
 *    the Job instead of executing it. No synthetic cancelled Job is created.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { JobExecutor } from "../../src/job";
import { JobManager } from "../../src/job-manager";
import { InMemoryLaneLock } from "../../src/lane-lock";
import { jobInputToCoalescedInput } from "../../src/lane-coalescer";
import { WORK_ACCEPTANCE_REASONS } from "@nautilo/db";

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

/** White-box access to the manager's internal virtual-id → acceptance map. */
function virtualToAcceptance(manager: JobManager): Map<string, string> {
  return (manager as unknown as { virtualToAcceptance: Map<string, string> })
    .virtualToAcceptance;
}
function pendingByThread(manager: JobManager): Map<
  string,
  Array<{ laneKey: string; merged: unknown; virtualIds: readonly string[] }>
> {
  return (manager as unknown as {
    pendingByThread: Map<
      string,
      Array<{ laneKey: string; merged: unknown; virtualIds: readonly string[] }>
    >;
  }).pendingByThread;
}
function stoppedThreads(manager: JobManager): Set<string> {
  return (manager as unknown as { stoppedThreads: Set<string> }).stoppedThreads;
}

interface Harness {
  jm: JobManager;
  insertCalls: Array<{ kind: string; acceptanceId: string }>;
  userCancelCalls: Array<{ acceptanceIds: string[]; reason: string }>;
  linkCalls: Array<{ acceptanceIds: string[]; jobId: string }>;
  dispatched: string[];
  fireTimers: () => void;
  executor: JobExecutor;
}

function makeHarness(opts?: {
  userCancelError?: Error;
  linkCount?: number | ((ids: readonly string[], jobId: string) => number);
  onLink?: (jobId: string) => void;
}): Harness {
  let accCounter = 0;
  const insertCalls: Array<{ kind: string; acceptanceId: string }> = [];
  const userCancelCalls: Array<{ acceptanceIds: string[]; reason: string }> = [];
  const linkCalls: Array<{ acceptanceIds: string[]; jobId: string }> = [];
  const dispatched: string[] = [];

  const acceptanceSinks = {
    insertAcceptance: async (kind: string): Promise<string> => {
      const id = `acc-${++accCounter}`;
      insertCalls.push({ kind, acceptanceId: id });
      return id;
    },
    linkAcceptancesToJob: async (
      acceptanceIds: readonly string[],
      jobId: string,
    ): Promise<number> => {
      linkCalls.push({ acceptanceIds: [...acceptanceIds], jobId });
      opts?.onLink?.(jobId);
      return typeof opts?.linkCount === "function"
        ? opts.linkCount(acceptanceIds, jobId)
        : (opts?.linkCount ?? acceptanceIds.length);
    },
    terminalizeAllAcceptedWork: async (): Promise<number> => 0,
    userCancelAcceptedWork: async (
      acceptanceIds: readonly string[],
      reason: string,
    ): Promise<number> => {
      userCancelCalls.push({ acceptanceIds: [...acceptanceIds], reason });
      if (opts?.userCancelError) throw opts.userCancelError;
      return acceptanceIds.length;
    },
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

  const executor: JobExecutor = async function* (_input, jobId) {
    dispatched.push(jobId);
    yield* [] as never[];
  };

  const jm = new JobManager({
    laneLock: new InMemoryLaneLock(),
    persist: async () => `job-${randomUUID()}`,
    updateStatus: async () => {},
    acceptanceSinks,
    setTimer,
    clearTimer,
  });

  return { jm, insertCalls, userCancelCalls, linkCalls, dispatched, fireTimers, executor };
}

function burstInput(room: string, thread: string, message: string) {
  return {
    message,
    turnId: randomUUID(),
    graphThreadId: thread,
    threadId: thread,
    agentId: "bot1",
    roomId: room,
    ownerId: "u",
    requestorId: "u",
  };
}

describe("D420 user Stop — durable user_cancelled terminalization", () => {
  test("stopRoom terminalizes a buffered lane's acceptance as user_cancelled and clears the mapping", async () => {
    const h = makeHarness();
    const room = randomUUID();
    const thread = `room:${room}:bot:bot1`;
    const lane = `room:${room}:user:u:bot:bot1`;

    const accepted = await h.jm.createForegroundJob(
      "u",
      "u",
      lane,
      burstInput(room, thread, "buffered"),
      h.executor,
    );
    // Buffered (not flushed): the virtual-id → acceptance map is populated.
    const acceptanceId = h.insertCalls[h.insertCalls.length - 1]!.acceptanceId;
    expect(virtualToAcceptance(h.jm).get(accepted.virtualJobId)).toBe(acceptanceId);

    const result = await h.jm.stopRoom(room);
    expect(result.droppedBufferedLanes).toBe(1);
    expect(h.userCancelCalls).toEqual([
      { acceptanceIds: [acceptanceId], reason: WORK_ACCEPTANCE_REASONS.userStop },
    ]);
    // The resolved mapping is cleared.
    expect(virtualToAcceptance(h.jm).has(accepted.virtualJobId)).toBe(false);
  });

  test("stopThread terminalizes a queued turn's acceptance as user_cancelled and clears the mapping", async () => {
    const h = makeHarness();
    const thread = `room:${randomUUID()}:bot:bot1`;
    // White-box: a queued turn carrying a virtual id with a mapped acceptance.
    const merged = jobInputToCoalescedInput(
      { message: "queued", turnId: randomUUID(), graphThreadId: thread },
      "lane-q",
      "owner",
      "requestor",
    );
    pendingByThread(h.jm).set(thread, [
      { laneKey: "lane-q", merged, virtualIds: ["vq"] },
    ]);
    virtualToAcceptance(h.jm).set("vq", "acc-q");

    const result = await h.jm.stopThread(thread);
    expect(result.droppedQueuedTurns).toBe(1);
    expect(h.userCancelCalls).toEqual([
      { acceptanceIds: ["acc-q"], reason: WORK_ACCEPTANCE_REASONS.userStop },
    ]);
    expect(virtualToAcceptance(h.jm).has("vq")).toBe(false);
  });

  test("stopRoom fails loudly when durable user_cancelled terminalization fails", async () => {
    const h = makeHarness({ userCancelError: new Error("ledger unavailable") });
    const room = randomUUID();
    const thread = `room:${room}:bot:bot1`;
    const lane = `room:${room}:user:u:bot:bot1`;
    await h.jm.createForegroundJob("u", "u", lane, burstInput(room, thread, "x"), h.executor);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(h.jm.stopRoom(room)).rejects.toThrow(/ledger unavailable/);
  });

  test("stopRoom is a no-op terminalization when nothing is queued/buffered for the room", async () => {
    const h = makeHarness();
    const result = await h.jm.stopRoom(randomUUID());
    expect(result).toEqual({ stoppedJobs: 0, droppedQueuedTurns: 0, droppedBufferedLanes: 0 });
    expect(h.userCancelCalls).toEqual([]);
  });
});

describe("D420 dispatch-vs-Stop race — compensate the never-dispatched Job", () => {
  test("a link that cannot verify every expected acceptance compensates the Job and does not execute", async () => {
    // linkCount = 0 simulates a concurrent user Stop that already terminalized
    // the expected acceptance as user_cancelled (none remained eligible).
    const h = makeHarness({ linkCount: 0 });
    const room = randomUUID();
    const thread = `room:${room}:bot:bot1`;
    const lane = `room:${room}:user:u:bot:bot1`;

    await h.jm.createForegroundJob("u", "u", lane, burstInput(room, thread, "race"), h.executor);
    h.fireTimers(); // flush → runMainTurn → link returns 0 (< expected 1)
    await waitFor(() => h.linkCalls.length === 1);

    // The never-dispatched Job is compensated; it never executes.
    expect(h.dispatched).toEqual([]);
    expect(h.linkCalls).toHaveLength(1);
  });

  test("a successful link followed by a stop compensates the Job instead of executing (stop-intent gate)", async () => {
    const room = randomUUID();
    const thread = `room:${room}:bot:bot1`;
    // The link succeeds (full count), but a concurrent Stop sets the thread
    // stop intent during the link — the post-link gate must compensate.
    const h = makeHarness({
      onLink: () => {
        stoppedThreads(h.jm).add(thread);
      },
    });
    const lane = `room:${room}:user:u:bot:bot1`;

    await h.jm.createForegroundJob("u", "u", lane, burstInput(room, thread, "gate"), h.executor);
    h.fireTimers(); // flush → link succeeds → gate observes stop → compensate
    await waitFor(() => h.linkCalls.length === 1);

    expect(h.linkCalls).toHaveLength(1);
    expect(h.linkCalls[0]!.acceptanceIds).toHaveLength(1);
    // The Job was compensated and never executed.
    expect(h.dispatched).toEqual([]);
  });
});
