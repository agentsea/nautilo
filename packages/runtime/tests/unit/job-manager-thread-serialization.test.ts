/**
 * M136 — Room Conductor per-bot checkpoint serialization.
 *
 * These tests verify that the runtime coordinates turns on the per-(room,bot)
 * checkpoint thread (`graphThreadId`), while **coalescing** stays on the
 * per-(room,user,bot) lane and ordinary busy turns fork. They run fully
 * in-process (no DB, no server) by
 * injecting no-op `persist`/`updateStatus` sinks and a controllable timer into
 * `JobManager`, plus a mock executor that gates on per-message promises so we
 * can interleave turns deterministically.
 *
 * Scenario map (issue §5 / blast subset):
 *   1 — same user rapid burst → ONE coalesced turn
 *   2 — two users, second arrives while first running → fork (no merge)
 *   3 — two users, both before dispatch → two ordered turns (no merge)
 *   4 — one message wakes two DIFFERENT bots → parallel (distinct threads)
 *   5 — DM (single lane) → 1:1 lane↔thread, unchanged ordering
 *   6 — completion drains the next turn for the thread (cross-user, R5)
 *   7 — error in the running turn releases the thread lock; next turn proceeds
 *   8 — empty graphThreadId is fail-closed (§8.5), never serialized on laneKey
 */
import { describe, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import type { JobExecutor } from "../../src/job";
import type { JobStatus, ServerEvent } from "@nautilo/types";
import type { ForegroundTurnCandidate } from "../../src/foreground-turn-lifecycle";
import { eventBus } from "../../src/event-bus";
import { JobManager, type WorkAcceptanceSinks } from "../../src/job-manager";
import { InMemoryLaneLock } from "../../src/lane-lock";

interface DispatchRecord {
  message: string;
  jobId: string;
  laneKey: string;
  isFork: boolean;
  parentThreadId?: string;
  sequence?: number;
}

function makeHarness(options: {
  readonly taskStopSink?: (taskId: string) => Promise<void>;
  readonly persist?: () => Promise<string>;
  readonly acceptanceSinks?: WorkAcceptanceSinks;
} = {}) {
  let idCounter = 0;
  const persist = options.persist ?? (async (): Promise<string> => `job-${++idCounter}`);
  const statuses: Array<{ jobId: string; status: JobStatus; fields: unknown }> = [];
  const updateStatus = async (jobId: string, status: JobStatus, fields?: unknown): Promise<void> => {
    statuses.push({ jobId, status, fields });
  };

  const dispatches: DispatchRecord[] = [];
  const completed: string[] = [];
  const failed: string[] = [];
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();

  function gate(message: string): ReturnType<typeof Promise.withResolvers<void>> {
    const g = Promise.withResolvers<void>();
    gates.set(message, g);
    return g;
  }

  const executor: JobExecutor = async function* (input, jobId, laneKey) {
    const message = typeof input["message"] === "string" ? input["message"] : "";
    const forkRun = input["forkRun"] as
      | { parentThreadId?: string; sequence?: number }
      | undefined;
    const rec: DispatchRecord = {
      message,
      jobId,
      laneKey: laneKey ?? "",
      isFork: !!forkRun,
    };
    if (forkRun?.parentThreadId) rec.parentThreadId = forkRun.parentThreadId;
    if (typeof forkRun?.sequence === "number") rec.sequence = forkRun.sequence;
    dispatches.push(rec);

    const g = gates.get(message);
    if (g) await g.promise;

    if (message.includes("throw")) {
      failed.push(message);
      throw new Error(`boom:${message}`);
    }

    yield {
      type: "message.tokens",
      laneKey: laneKey ?? "",
      content: ".",
      chunkSequence: 1,
      done: true,
    };
    completed.push(message);
  };

  // Controllable timer: capture flush callbacks and fire them on demand so the
  // exact moment a lane flushes (and thus its dispatch ordering) is deterministic.
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
    setTimer,
    clearTimer,
    ...(options.taskStopSink ? { taskStopSink: options.taskStopSink } : {}),
    ...(options.acceptanceSinks ? { acceptanceSinks: options.acceptanceSinks } : {}),
  });

  return {
    jm,
    executor,
    dispatches,
    completed,
    failed,
    statuses,
    gate,
    fireTimers,
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

const ROOM = () => `R-${randomUUID()}`;
function ids(room: string, bot: string, user: string) {
  return {
    thread: `room:${room}:bot:${bot}`,
    lane: `room:${room}:user:${user}:bot:${bot}`,
    user,
    bot,
    room,
  };
}

function input(message: string, thread: string, user: string, bot: string, room: string) {
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

const candidate = (token: symbol): ForegroundTurnCandidate => ({
  onMainTurn: () => {},
  onIneligible: () => {},
  coalescingContext: { clientSessionToken: token, initiatingClientSurface: "unknown" },
});

function ordinary(
  h: ReturnType<typeof makeHarness>,
  lane: ReturnType<typeof ids>,
  message: string,
  source?: ForegroundTurnCandidate,
  verifiedOrdinaryOrigin?: Record<string, unknown>,
) {
  return h.jm.createForegroundJob(
    lane.user, lane.user, lane.lane,
    { ...input(message, lane.thread, lane.user, lane.bot, lane.room), ...(verifiedOrdinaryOrigin ? { verifiedOrdinaryOrigin } : {}) },
    h.executor, undefined,
    {
      executor: h.executor,
      coalescing: "coalesce",
      coalescingBoundary: "exact-client",
      contention: "fork",
    },
    undefined, source,
  );
}

describe("M136 per-(room,bot) checkpoint serialization", () => {
  test("D513 6.1 fences direct bursts by exact session and verified-origin presence", async () => {
    const run = async (
      first: ForegroundTurnCandidate | undefined,
      second: ForegroundTurnCandidate | undefined,
      firstOrigin?: Record<string, unknown>,
      secondOrigin?: Record<string, unknown>,
    ) => {
      const h = makeHarness();
      const lane = ids(ROOM(), "bot", "user");
      await ordinary(h, lane, "one", first, firstOrigin);
      await ordinary(h, lane, "two", second, secondOrigin);
      h.fireTimers();
      await waitFor(() => h.dispatches.length >= 1);
      return h.dispatches.map((dispatch) => dispatch.message);
    };
    const sameSession = candidate(Symbol("same-session"));
    const origin = { kind: "local_electron" };

    expect(await run(sameSession, sameSession)).toEqual(["one\n\ntwo"]);
    expect(await run(candidate(Symbol("a")), candidate(Symbol("b")))).toEqual(["one", "two"]);
    expect(await run(undefined, undefined)).toEqual(["one", "two"]);
    expect(await run(sameSession, sameSession, origin, origin)).toEqual(["one", "two"]);
    expect(await run(sameSession, sameSession, origin)).toEqual(["one", "two"]);
    expect(await run(sameSession, sameSession, undefined, origin)).toEqual(["one", "two"]);
  });

  test("D513 6.1 drops a stopped boundary before the next client can run", async () => {
    const h = makeHarness();
    const lane = ids(ROOM(), "bot", "user");
    await ordinary(h, lane, "stopped", candidate(Symbol("first")));
    await h.jm.stopRoom(lane.room);
    await ordinary(h, lane, "next", candidate(Symbol("second")));
    h.fireTimers();
    await waitFor(() => h.dispatches.length === 1);
    expect(h.dispatches[0]!.message).toBe("next");
  });

  test("ordinary exact-client turns fork instead of waiting behind a busy main", async () => {
    const h = makeHarness();
    const lane = ids(ROOM(), "bot", "user");
    const source = candidate(Symbol("same-session"));
    const mainGate = h.gate("main");
    const forkGate = h.gate("fork");

    await ordinary(h, lane, "main", source);
    h.fireTimers();
    await waitFor(() => h.dispatches.some((dispatch) => dispatch.message === "main"));

    await ordinary(h, lane, "fork", source);
    h.fireTimers();
    await waitFor(() => h.dispatches.some((dispatch) => dispatch.message === "fork"));

    const main = h.dispatches.find((dispatch) => dispatch.message === "main")!;
    const fork = h.dispatches.find((dispatch) => dispatch.message === "fork")!;
    expect(main.isFork).toBe(false);
    expect(fork.isFork).toBe(true);
    expect(fork.parentThreadId).toBe(lane.thread);
    expect(h.completed).toEqual([]);

    mainGate.resolve();
    forkGate.resolve();
    await waitFor(() => h.completed.includes("main") && h.completed.includes("fork"));
  });

  test("scenario 1 — same user rapid burst on one bot → ONE coalesced turn", async () => {
    const h = makeHarness();
    const room = ROOM();
    const a = ids(room, "bot1", "userA");

    for (const msg of ["m1", "m2", "m3"]) {
      await h.jm.createForegroundJob(
        a.user,
        a.user,
        a.lane,
        input(msg, a.thread, a.user, a.bot, room),
        h.executor,
      );
    }
    // All three buffered on the same lane → one merged flush.
    h.fireTimers();

    await waitFor(() => h.dispatches.length >= 1);
    await new Promise((r) => setTimeout(r, 10));

    expect(h.dispatches.length).toBe(1);
    expect(h.dispatches[0]!.message).toBe("m1\n\nm2\n\nm3");
    expect(h.dispatches[0]!.isFork).toBe(false);
  });

  test("scenario 2 — two users, second arrives while first is running → fork, no merge", async () => {
    const h = makeHarness();
    const room = ROOM();
    const a = ids(room, "bot1", "userA");
    const b = ids(room, "bot1", "userB"); // same bot → same thread, different lane

    expect(a.thread).toBe(b.thread);
    expect(a.lane).not.toBe(b.lane);

    const gateA = h.gate("A");
    await h.jm.createForegroundJob(a.user, a.user, a.lane, input("A", a.thread, a.user, a.bot, room), h.executor);
    h.fireTimers();
    // A holds the thread lock (gated, running).
    await waitFor(() => h.dispatches.some((d) => d.message === "A"));

    await h.jm.createForegroundJob(b.user, b.user, b.lane, input("B", b.thread, b.user, b.bot, room), h.executor);
    h.fireTimers();
    await waitFor(() => h.dispatches.some((d) => d.message === "B"));

    const dA = h.dispatches.find((d) => d.message === "A")!;
    const dB = h.dispatches.find((d) => d.message === "B")!;
    expect(dA.isFork).toBe(false); // A is the main turn
    expect(dB.isFork).toBe(true); // B forks (thread busy)
    expect(dB.parentThreadId).toBe(a.thread); // forks the bot's checkpoint, not the lane
    // No merge: two distinct turns with distinct messages.
    expect(dA.message).toBe("A");
    expect(dB.message).toBe("B");

    gateA.resolve();
    await waitFor(() => h.completed.includes("A") && h.completed.includes("B"));
  });

  test("scenario 3 — two users, both before dispatch → two ordered turns, NOT merged", async () => {
    const h = makeHarness();
    const room = ROOM();
    const a = ids(room, "bot1", "userA");
    const b = ids(room, "bot1", "userB");

    // Both enqueue before either flushes; firing both timers together lands
    // both on the SAME thread queue prior to dispatch.
    await h.jm.createForegroundJob(a.user, a.user, a.lane, input("A", a.thread, a.user, a.bot, room), h.executor);
    await h.jm.createForegroundJob(b.user, b.user, b.lane, input("B", b.thread, b.user, b.bot, room), h.executor);
    h.fireTimers();

    await waitFor(() => h.dispatches.length >= 2);

    const order = h.dispatches.map((d) => d.message);
    // Distinct turns (no cross-user merge) in arrival order.
    expect(order).toEqual(["A", "B"]);
    expect(h.dispatches[0]!.isFork).toBe(false); // first runs main
    // The second serializes against the same thread (fork-in-order, M085).
    expect(h.dispatches[1]!.parentThreadId ?? a.thread).toBe(a.thread);

    await waitFor(() => h.completed.includes("A") && h.completed.includes("B"));
  });

  test("scenario 4 — one message wakes two DIFFERENT bots → run in parallel", async () => {
    const h = makeHarness();
    const room = ROOM();
    const b1 = ids(room, "bot1", "userA");
    const b2 = ids(room, "bot2", "userA");
    expect(b1.thread).not.toBe(b2.thread);

    const g1 = h.gate("toBot1");
    const g2 = h.gate("toBot2");
    await h.jm.createForegroundJob(b1.user, b1.user, b1.lane, input("toBot1", b1.thread, b1.user, b1.bot, room), h.executor);
    await h.jm.createForegroundJob(b2.user, b2.user, b2.lane, input("toBot2", b2.thread, b2.user, b2.bot, room), h.executor);
    h.fireTimers();

    // Both start (and remain) running concurrently — distinct threads, no
    // cross-serialization. Neither has completed yet (both gated).
    await waitFor(() => h.dispatches.length >= 2);
    expect(h.dispatches.every((d) => !d.isFork)).toBe(true);
    expect(h.completed.length).toBe(0);

    g1.resolve();
    g2.resolve();
    await waitFor(() => h.completed.includes("toBot1") && h.completed.includes("toBot2"));
  });

  test("scenario 5 — DM (single lane) → 1:1 lane↔thread, runs main, ordering unchanged", async () => {
    const h = makeHarness();
    const room = ROOM();
    // DM: lane is room-level, thread is rooms.graph_thread_id — DIFFERENT
    // strings, strictly 1:1 per room (issue §8.3).
    const lane = `room:${room}`;
    const thread = `gthread-${randomUUID()}`;
    expect(lane).not.toBe(thread);

    await h.jm.createForegroundJob("u", "u", lane, input("hello", thread, "u", "bot1", room), h.executor);
    h.fireTimers();
    await waitFor(() => h.dispatches.length >= 1);

    expect(h.dispatches.length).toBe(1);
    expect(h.dispatches[0]!.isFork).toBe(false);
    expect(h.dispatches[0]!.laneKey).toBe(lane);
    await waitFor(() => h.completed.includes("hello"));
  });

  test("scenario 6 — cross-user turn serializes on the thread, not stranded/merged (R5)", async () => {
    const h = makeHarness();
    const room = ROOM();
    const a = ids(room, "bot1", "userA");
    const b = ids(room, "bot1", "userB");

    // Gate BOTH so neither completes until we say so.
    const gateA = h.gate("A");
    const gateB = h.gate("B");

    await h.jm.createForegroundJob(a.user, a.user, a.lane, input("A", a.thread, a.user, a.bot, room), h.executor);
    h.fireTimers();
    await waitFor(() => h.dispatches.some((d) => d.message === "A"));

    // B arrives on a DIFFERENT user's lane while A runs. The old per-lane
    // completion hook (`flushIfPending(laneA)`) would never wake B; the
    // per-thread dispatch serializes it onto A's bot checkpoint instead.
    await h.jm.createForegroundJob(b.user, b.user, b.lane, input("B", b.thread, b.user, b.bot, room), h.executor);
    h.fireTimers();
    await waitFor(() => h.dispatches.some((d) => d.message === "B"));

    const dA = h.dispatches.find((d) => d.message === "A")!;
    const dB = h.dispatches.find((d) => d.message === "B")!;
    // Not merged: two distinct turns. Serialized on the SAME bot thread:
    // A is main, B forks that thread's checkpoint (never the lane).
    expect(dA.isFork).toBe(false);
    expect(dB.isFork).toBe(true);
    expect(dB.parentThreadId).toBe(a.thread);
    expect(h.completed.length).toBe(0);

    gateA.resolve();
    gateB.resolve();
    await waitFor(() => h.completed.includes("A") && h.completed.includes("B"));
    expect(new Set(h.dispatches.map((d) => d.message))).toEqual(new Set(["A", "B"]));
  });

  test("scenario 7 — error in the running turn releases the lock; next turn proceeds", async () => {
    const h = makeHarness();
    const room = ROOM();
    const a = ids(room, "bot1", "userA");
    const b = ids(room, "bot1", "userB");

    const gateErr = h.gate("throw-A");
    await h.jm.createForegroundJob(a.user, a.user, a.lane, input("throw-A", a.thread, a.user, a.bot, room), h.executor);
    h.fireTimers();
    await waitFor(() => h.dispatches.some((d) => d.message === "throw-A"));

    // Let A run and throw — the finally path must release the thread lock.
    gateErr.resolve();
    await waitFor(() => h.failed.includes("throw-A"));

    // A later turn on the SAME thread now finds the lock free → runs as main,
    // proving no deadlock / no stranded lock.
    await h.jm.createForegroundJob(b.user, b.user, b.lane, input("B", b.thread, b.user, b.bot, room), h.executor);
    h.fireTimers();
    await waitFor(() => h.completed.includes("B"));

    const dB = h.dispatches.find((d) => d.message === "B")!;
    expect(dB.isFork).toBe(false);
  });

  test("Full candidate rejection fails the durable Job, releases the lane, and runs the next turn", async () => {
    const h = makeHarness();
    const room = randomUUID();
    const first = ids(room, "bot1", "userA");
    const next = ids(room, "bot1", "userB");
    const sentinel = "FULL_CANDIDATE_REJECTION_SECRET";
    let executorCalls = 0;
    const rejecting: ForegroundTurnCandidate = {
      onMainTurn: () => {}, onIneligible: () => {},
      durableJobInputDisposition: "full",
      durableJobInputReference: { kind: "full_encryption_foreground_operation_v1",
        operationId: "full-candidate-reject", policyRevision: 7, roomId: room },
      runMainTurn: async () => { throw new Error(sentinel); },
    };
    const executor: JobExecutor = async function* () {
      executorCalls += 1;
      yield* ([] as ServerEvent[]);
    };
    await h.jm.createForegroundJob(first.user, first.user, first.lane,
      input("transient-full", first.thread, first.user, first.bot, room), executor,
      undefined, { executor, coalescing: "separate", contention: "serialize" },
      undefined, rejecting);
    h.fireTimers();
    await waitFor(() => h.statuses.some((entry) => entry.status === "failed"));
    expect(executorCalls).toBe(0);
    const failed = h.statuses.find((entry) => entry.status === "failed")!;
    expect(JSON.stringify(failed)).not.toContain(sentinel);
    expect(failed.fields).toBeUndefined();

    await h.jm.createForegroundJob(next.user, next.user, next.lane,
      input("B", next.thread, next.user, next.bot, room), h.executor);
    h.fireTimers();
    await waitFor(() => h.completed.includes("B"));
    expect(h.dispatches.find((entry) => entry.message === "B")?.isFork).toBe(false);
  });

  test("Full fork candidate rejection terminalizes its Job and releases fork ordering", async () => {
    const h = makeHarness();
    const room = randomUUID();
    const first = ids(room, "bot1", "userA");
    const fork = ids(room, "bot1", "userB");
    const gate = h.gate("A");
    await h.jm.createForegroundJob(first.user, first.user, first.lane,
      input("A", first.thread, first.user, first.bot, room), h.executor);
    h.fireTimers();
    await waitFor(() => h.dispatches.some((entry) => entry.message === "A"));
    let executorCalls = 0;
    const rejecting: ForegroundTurnCandidate = {
      onMainTurn: () => {}, onForkTurn: () => {}, onIneligible: () => {},
      durableJobInputDisposition: "full",
      durableJobInputReference: { kind: "full_encryption_foreground_operation_v1",
        operationId: "full-fork-reject", policyRevision: 7, roomId: room },
      runForkTurn: async () => { throw new Error("FULL_FORK_REJECTION_SECRET"); },
    };
    const executor: JobExecutor = async function* () {
      executorCalls += 1;
      yield* ([] as ServerEvent[]);
    };
    await h.jm.createForegroundJob(fork.user, fork.user, fork.lane,
      input("transient-fork", fork.thread, fork.user, fork.bot, room), executor,
      undefined, { executor, coalescing: "separate", contention: "fork" },
      undefined, rejecting);
    h.fireTimers();
    await waitFor(() => h.statuses.some((entry) => entry.status === "failed"));
    expect(executorCalls).toBe(0);
    expect(JSON.stringify(h.statuses)).not.toContain("FULL_FORK_REJECTION_SECRET");
    gate.resolve();
    await waitFor(() => h.completed.includes("A"));
    await h.jm.createForegroundJob(fork.user, fork.user, fork.lane,
      input("C", fork.thread, fork.user, fork.bot, room), h.executor);
    h.fireTimers();
    await waitFor(() => h.completed.includes("C"));
  });

  test("pre-execution main persistence failure stays accepted, emits no detail, and releases the lane", async () => {
    let persistCalls = 0;
    let acceptanceCalls = 0;
    const userCancelled: string[][] = [];
    const h = makeHarness({
      persist: async () => {
        persistCalls += 1;
        if (persistCalls === 1) throw new Error("SECRET persistence detail");
        return `job-${persistCalls}`;
      },
      acceptanceSinks: {
        insertAcceptance: async () => `acceptance-${++acceptanceCalls}`,
        linkAcceptancesToJob: async (ids) => ids.length,
        terminalizeAllAcceptedWork: async () => 0,
        userCancelAcceptedWork: async (ids) => {
          userCancelled.push([...ids]);
          return ids.length;
        },
      },
    });
    const lane = ids(ROOM(), "bot", "user");
    const events: unknown[] = [];
    const onEvent = (event: unknown) => { events.push(event); };
    eventBus.on(onEvent as never);
    try {
      const first = await ordinary(h, lane, "first");
      h.fireTimers();
      await waitFor(() => events.some((event) =>
        (event as { type?: string; jobId?: string }).type === "job.status"
        && (event as { jobId?: string }).jobId === first.virtualJobId
      ));
      expect(h.dispatches).toEqual([]);
      expect(JSON.stringify(events)).not.toContain("SECRET persistence detail");
      expect(events).toContainEqual({
        type: "job.status",
        jobId: first.virtualJobId,
        status: "failed",
        laneKey: lane.lane,
      });

      await ordinary(h, lane, "second");
      h.fireTimers();
      await waitFor(() => h.completed.includes("second"));
      expect(h.dispatches).toHaveLength(1);
      expect(h.dispatches[0]).toMatchObject({ message: "second", isFork: false });

      await h.jm.stopRoom(lane.room);
      expect(userCancelled).toContainEqual(["acceptance-1"]);
    } finally {
      eventBus.off(onEvent as never);
    }
  });

  test("pre-execution fork persistence failure is contained without running its executor", async () => {
    let persistCalls = 0;
    const h = makeHarness({
      persist: async () => {
        persistCalls += 1;
        if (persistCalls === 2) throw new Error("SECRET fork persistence detail");
        return `job-${persistCalls}`;
      },
    });
    const lane = ids(ROOM(), "bot", "user");
    const source = candidate(Symbol("same-client"));
    const mainGate = h.gate("main");
    const events: unknown[] = [];
    const onEvent = (event: unknown) => { events.push(event); };
    eventBus.on(onEvent as never);
    try {
      await ordinary(h, lane, "main", source);
      h.fireTimers();
      await waitFor(() => h.dispatches.some((entry) => entry.message === "main"));
      const failedFork = await ordinary(h, lane, "fork", source);
      h.fireTimers();
      await waitFor(() => events.some((event) =>
        (event as { type?: string; jobId?: string }).type === "job.status"
        && (event as { jobId?: string }).jobId === failedFork.virtualJobId
      ));
      expect(h.dispatches.map((entry) => entry.message)).toEqual(["main"]);
      expect(JSON.stringify(events)).not.toContain("SECRET fork persistence detail");
      mainGate.resolve();
      await waitFor(() => h.completed.includes("main"));
    } finally {
      eventBus.off(onEvent as never);
    }
  });

  test("invalid Full durable reference fails structurally and does not strand the lane", async () => {
    let persistCalls = 0;
    const h = makeHarness({ persist: async () => `job-${++persistCalls}` });
    const lane = ids(ROOM(), "bot", "user");
    const invalidFull: ForegroundTurnCandidate = {
      ...candidate(Symbol("full-invalid")),
      durableJobInputDisposition: "full",
    };
    const events: unknown[] = [];
    const onEvent = (event: unknown) => { events.push(event); };
    eventBus.on(onEvent as never);
    try {
      const failed = await ordinary(h, lane, "full-invalid", invalidFull);
      h.fireTimers();
      await waitFor(() => events.some((event) =>
        (event as { type?: string; jobId?: string }).type === "job.status"
        && (event as { jobId?: string }).jobId === failed.virtualJobId
      ));
      expect(h.dispatches).toEqual([]);
      expect(persistCalls).toBe(0);
      await ordinary(h, lane, "after-invalid");
      h.fireTimers();
      await waitFor(() => h.completed.includes("after-invalid"));
      expect(h.dispatches).toHaveLength(1);
      expect(persistCalls).toBe(1);
    } finally {
      eventBus.off(onEvent as never);
    }
  });

  test("D349 — stopRoom aborts active turn and drops same-room coalesced buffer", async () => {
    const h = makeHarness();
    const room = ROOM();
    const a = ids(room, "bot1", "userA");
    const gateA = h.gate("A");

    await h.jm.createForegroundJob(a.user, a.user, a.lane, input("A", a.thread, a.user, a.bot, room), h.executor);
    h.fireTimers();
    await waitFor(() => h.dispatches.some((d) => d.message === "A"));

    await h.jm.createForegroundJob(a.user, a.user, a.lane, input("B", a.thread, a.user, a.bot, room), h.executor);
    const stopped = await h.jm.stopRoom(room);
    expect(stopped.stoppedJobs).toBe(1);
    expect(stopped.droppedBufferedLanes).toBe(1);

    gateA.resolve();
    h.fireTimers();
    await waitFor(() => h.jm.getActiveJobs().length === 0);
    expect(h.dispatches.map((d) => d.message)).toEqual(["A"]);
  });

  test("D349 — one room Stop aborts the main turn and every active ordinary fork", async () => {
    const h = makeHarness();
    const lane = ids(ROOM(), "bot", "user");
    const source = candidate(Symbol("same-session"));
    const gates = [h.gate("main"), h.gate("fork-1"), h.gate("fork-2")];

    for (const message of ["main", "fork-1", "fork-2"]) {
      await ordinary(h, lane, message, source);
      h.fireTimers();
      await waitFor(() => h.dispatches.some((dispatch) => dispatch.message === message));
    }

    expect(h.dispatches.map((dispatch) => dispatch.isFork)).toEqual([false, true, true]);
    expect(h.jm.getActiveJobIdsForRoom(lane.room)).toHaveLength(3);

    const stopped = await h.jm.stopRoom(lane.room);
    expect(stopped.stoppedJobs).toBe(3);
    expect(h.jm.getActiveJobIdsForRoom(lane.room)).toEqual([]);

    for (const gate of gates) gate.resolve();
    await waitFor(() => h.jm.getActiveJobs().length === 0);
    expect(h.completed).toEqual([]);
  });

  test("D453 — stopRoom delegates a task-backed Job to the canonical task lifecycle exactly once", async () => {
    const stoppedTaskIds: string[] = [];
    const ref: { current: ReturnType<typeof makeHarness> | null } = { current: null };
    const h = makeHarness({
      taskStopSink: async (taskId) => {
        stoppedTaskIds.push(taskId);
        const taskJob = ref.current?.jm.getActiveJobs().find(
          (job) => job.input["taskId"] === taskId,
        );
        if (taskJob) ref.current?.jm.abortJob(taskJob.id, "stop");
      },
    });
    ref.current = h;
    const room = ROOM();
    const a = ids(room, "bot1", "userA");
    const taskId = randomUUID();
    const gate = h.gate("Codex task");
    const taskInput = {
      ...input("Codex task", a.thread, a.user, a.bot, room),
      taskId,
      taskRunId: randomUUID(),
    };

    await h.jm.createForegroundJob(a.user, a.user, a.lane, taskInput, h.executor);
    h.fireTimers();
    await waitFor(() => h.dispatches.some((entry) => entry.message === "Codex task"));

    const stopped = await h.jm.stopRoom(room);
    expect(stoppedTaskIds).toEqual([taskId]);
    expect(stopped.stoppedJobs).toBe(1);

    gate.resolve();
    await waitFor(() => h.jm.getActiveJobs().length === 0);
    expect(h.completed).toEqual([]);
  });

  test("D560 — calling-Room Stop cancels a Task executing in its orphan Room", async () => {
    const stoppedTaskIds: string[] = [];
    const ref: { current: ReturnType<typeof makeHarness> | null } = { current: null };
    const h = makeHarness({
      taskStopSink: async (taskId) => {
        stoppedTaskIds.push(taskId);
        const taskJob = ref.current?.jm.getActiveJobs().find(
          (job) => job.input["taskId"] === taskId,
        );
        if (taskJob) ref.current?.jm.abortJob(taskJob.id, "stop");
      },
    });
    ref.current = h;
    const callingRoom = ROOM();
    const executionRoom = ROOM();
    const lane = ids(executionRoom, "bot1", "userA");
    const taskId = randomUUID();
    const gate = h.gate("Security research");

    await h.jm.createForegroundJob(
      lane.user,
      lane.user,
      lane.lane,
      {
        ...input("Security research", lane.thread, lane.user, lane.bot, executionRoom),
        callingRoomId: callingRoom,
        taskId,
        taskRunId: randomUUID(),
      },
      h.executor,
    );
    h.fireTimers();
    await waitFor(() => h.dispatches.some((entry) => entry.message === "Security research"));

    expect(h.jm.getActiveJobIdsForRoom(callingRoom)).toHaveLength(1);
    const stopped = await h.jm.stopRoom(callingRoom);
    expect(stoppedTaskIds).toEqual([taskId]);
    expect(stopped.stoppedJobs).toBe(1);

    gate.resolve();
    await waitFor(() => h.jm.getActiveJobs().length === 0);
    expect(h.completed).toEqual([]);
  });

  test("D349 — stopRoom clears queued same-room turn and allows next user send", async () => {
    const h = makeHarness();
    const room = ROOM();
    const a = ids(room, "bot1", "userA");
    const b = ids(room, "bot1", "userB");
    const gateA = h.gate("A");

    await h.jm.createForegroundJob(a.user, a.user, a.lane, input("A", a.thread, a.user, a.bot, room), h.executor);
    h.fireTimers();
    await waitFor(() => h.dispatches.some((d) => d.message === "A"));

    await h.jm.createSystemForegroundJob(b.user, b.user, b.lane, input("B", b.thread, b.user, b.bot, room), h.executor);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.dispatches.map((d) => d.message)).toEqual(["A"]);

    const stopped = await h.jm.stopRoom(room);
    expect(stopped.stoppedJobs).toBe(1);
    expect(stopped.droppedQueuedTurns).toBe(1);

    gateA.resolve();
    await waitFor(() => h.jm.getActiveJobs().length === 0);
    expect(h.dispatches.map((d) => d.message)).toEqual(["A"]);

    await h.jm.createForegroundJob(b.user, b.user, b.lane, input("C", b.thread, b.user, b.bot, room), h.executor);
    h.fireTimers();
    await waitFor(() => h.dispatches.some((d) => d.message === "C"));
    expect(h.dispatches.map((d) => d.message)).toEqual(["A", "C"]);
  });

  test("D349 — system wake after stop does not clear stop intent", async () => {
    const h = makeHarness();
    const room = ROOM();
    const a = ids(room, "bot1", "userA");

    const stopped = await h.jm.stopRoom(room);
    expect(stopped.stoppedJobs).toBe(0);

    await h.jm.createSystemForegroundJob(a.user, a.user, a.lane, input("system", a.thread, a.user, a.bot, room), h.executor);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.dispatches).toEqual([]);

    await h.jm.createForegroundJob(a.user, a.user, a.lane, input("user", a.thread, a.user, a.bot, room), h.executor);
    h.fireTimers();
    await waitFor(() => h.dispatches.some((d) => d.message === "user"));
    expect(h.dispatches.map((d) => d.message)).toEqual(["user"]);
  });

  test("D349 — stopRoom leaves other rooms running", async () => {
    const h = makeHarness();
    const roomA = ROOM();
    const roomB = ROOM();
    const a = ids(roomA, "bot1", "userA");
    const b = ids(roomB, "bot1", "userB");
    const gateA = h.gate("A");
    const gateB = h.gate("B");

    await h.jm.createForegroundJob(a.user, a.user, a.lane, input("A", a.thread, a.user, a.bot, roomA), h.executor);
    await h.jm.createForegroundJob(b.user, b.user, b.lane, input("B", b.thread, b.user, b.bot, roomB), h.executor);
    h.fireTimers();
    await waitFor(() => h.dispatches.length === 2);

    const stopped = await h.jm.stopRoom(roomA);
    expect(stopped.stoppedJobs).toBe(1);

    gateA.resolve();
    gateB.resolve();
    await waitFor(() => h.jm.getActiveJobs().length === 0);
    expect(h.completed).toEqual(["B"]);
    expect(h.dispatches.map((d) => d.message).sort()).toEqual(["A", "B"]);
  });

  test("scenario 8 — empty graphThreadId is fail-closed (never serialized on laneKey)", async () => {
    const h = makeHarness();
    const room = ROOM();
    const lane = `room:${room}:user:u:bot:bot1`;
    // Explicit empty graphThreadId — the §8.5 hazard. Must be rejected.
    const bad = {
      message: "orphan",
      turnId: randomUUID(),
      graphThreadId: "",
      threadId: "",
      agentId: "bot1",
      roomId: room,
      ownerId: "u",
      requestorId: "u",
    };
    await h.jm.createForegroundJob("u", "u", lane, bad, h.executor);
    h.fireTimers();

    // Give the dispatch path ample time; nothing must ever run.
    await new Promise((r) => setTimeout(r, 30));
    expect(h.dispatches.length).toBe(0);
    expect(h.completed.length).toBe(0);
  });
});
