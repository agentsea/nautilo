/**
 * D353 — `getActiveJobIdsForRoom` read seam for reconnect run-state reconcile.
 * Hermetic unit test (no DB, no network).
 */
import { describe, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import type { JobExecutor } from "../../src/job";
import { JobManager } from "../../src/job-manager";
import { InMemoryLaneLock } from "../../src/lane-lock";

function makeHarness() {
  let idCounter = 0;
  const persist = async (): Promise<string> => `job-${++idCounter}`;
  const updateStatus = async (): Promise<void> => {};

  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();

  function gate(message: string): ReturnType<typeof Promise.withResolvers<void>> {
    const g = Promise.withResolvers<void>();
    gates.set(message, g);
    return g;
  }

  const executor: JobExecutor = async function* (input, _jobId, laneKey) {
    const message = typeof input["message"] === "string" ? input["message"] : "";
    const g = gates.get(message);
    if (g) await g.promise;

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
    setTimer,
    clearTimer,
  });

  return { jm, executor, gate, fireTimers };
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

describe("D353 getActiveJobIdsForRoom", () => {
  test("returns running jobs for the target room, excludes other rooms and terminal jobs", async () => {
    const h = makeHarness();
    const roomA = ROOM();
    const roomB = ROOM();
    const a = ids(roomA, "bot1", "userA");
    const b = ids(roomB, "bot1", "userB");

    h.gate("running-A");
    await h.jm.createForegroundJob(
      a.user,
      a.user,
      a.lane,
      input("running-A", a.thread, a.user, a.bot, roomA),
      h.executor,
    );
    h.fireTimers();
    await waitFor(() => h.jm.getActiveJobs().length >= 1);

    h.gate("running-B");
    await h.jm.createForegroundJob(
      b.user,
      b.user,
      b.lane,
      input("running-B", b.thread, b.user, b.bot, roomB),
      h.executor,
    );
    h.fireTimers();
    await waitFor(() => h.jm.getActiveJobs().length >= 2);

    const jobIdA = h.jm.getActiveJobs().find((j) => j.input["message"] === "running-A")!.id;
    const activeInA = h.jm.getActiveJobIdsForRoom(roomA);
    expect(activeInA).toEqual([jobIdA]);
    expect(h.jm.getActiveJobIdsForRoom(roomB).length).toBe(1);

    await h.jm.createForegroundJob(
      a.user,
      a.user,
      a.lane,
      input("completed", a.thread, a.user, a.bot, roomA),
      h.executor,
    );
    h.fireTimers();
    await waitFor(() => h.jm.getActiveJobs().length === 2);

    const activeAfterComplete = h.jm.getActiveJobIdsForRoom(roomA);
    expect(activeAfterComplete).toEqual([jobIdA]);
    expect(activeAfterComplete).not.toContain(
      h.jm.getActiveJobs().find((j) => j.input["message"] === "completed")?.id,
    );
  });

  test("empty roomId returns []", () => {
    const h = makeHarness();
    expect(h.jm.getActiveJobIdsForRoom("")).toEqual([]);
  });
});
