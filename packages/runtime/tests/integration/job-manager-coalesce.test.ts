import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import type { JobExecutor } from "../../src/job";
import type { ForegroundTurnCandidate } from "../../src/foreground-turn-lifecycle";
import { JobManager } from "../../src/job-manager";
import { InMemoryLaneLock } from "../../src/lane-lock";
import { eventBus } from "../../src/event-bus";
import {
  collectEvents,
  createTestUser,
  cleanupTestUser,
  closeDirectDb,
  setupTestDb,
} from "./helpers";

/** Fast timers — tests stay milliseconds-fast (production defaults: 1500 ms / 2000 ms). */
const FAST = {
  coalescerWindowMs: 45,
  coalescerFirstSegmentQuietMs: 45,
} as const;

let userId: string;

beforeAll(async () => {
  await setupTestDb();
  userId = (await createTestUser("job-mgr-coalesce")).userId;
});

afterAll(async () => {
  await cleanupTestUser(userId);
  await closeDirectDb();
});

describe("JobManager coalesce (Spacebot-style idle flush)", () => {
  test("D513 only arms one main candidate and invalidates every coalesced source", async () => {
    const laneLock = new InMemoryLaneLock();
    const jm = new JobManager({ laneLock, ...FAST });
    const calls: string[] = [];
    const candidate = (name: string): ForegroundTurnCandidate => ({
      onMainTurn: (turnId) => calls.push(`${name}:main:${turnId}`),
      onIneligible: () => calls.push(`${name}:ineligible`),
    });
    const executor: JobExecutor = async function* () {
      yield { type: "message.tokens", laneKey: "lane", content: ".", chunkSequence: 1, done: true };
    };
    const lane = `d513:${Date.now()}`;
    const base = { ownerId: userId, agentId: "a1", roomId: "", threadId: lane, graphThreadId: lane };
    await jm.createForegroundJob(userId, userId, lane, { ...base, message: "one", turnId: "turn-one" }, executor, undefined, undefined, undefined, candidate("one"));
    await jm.createForegroundJob(userId, userId, lane, { ...base, message: "two", turnId: "turn-two" }, executor, undefined, undefined, undefined, candidate("two"));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(calls.sort()).toEqual(["one:ineligible", "two:ineligible"]);
  });

  test("5 sequential sends → one execution with all segments merged (no immediate first turn)", async () => {
    const laneLock = new InMemoryLaneLock();
    const execMessages: string[] = [];
    const gate = Promise.withResolvers<void>();

    const executor: JobExecutor = async function* (input, _jobId, laneKey, _signal) {
      await gate.promise;
      execMessages.push(typeof input["message"] === "string" ? input["message"] : "");
      yield {
        type: "message.tokens",
        laneKey: laneKey ?? "lane",
        content: ".",
        chunkSequence: 1,
        done: true,
      };
    };

    const jm = new JobManager({ laneLock, ...FAST });
    const lane = `coalesce:${Date.now()}`;
    const base = {
      ownerId: userId,
      agentId: "a1",
      roomId: "",
      threadId: `th-${Date.now()}`,
      graphThreadId: lane,
    };

    for (let i = 1; i <= 5; i++) {
      const r = await jm.createForegroundJob(
        userId,
        userId,
        lane,
        { ...base, message: `msg${i}`, turnId: randomUUID() },
        executor,
      );
      expect(r.virtualJobId).toBeTruthy();
    }

    gate.resolve();

    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (execMessages.length >= 1) break;
    }

    expect(execMessages.length).toBe(1);
    expect(execMessages[0]).toBe("msg1\n\nmsg2\n\nmsg3\n\nmsg4\n\nmsg5");
  });

  test("job.coalesced ×2 then job.dispatched with merged virtual ids", async () => {
    const laneLock = new InMemoryLaneLock();
    const gate = Promise.withResolvers<void>();

    const executor: JobExecutor = async function* (_input, _jobId, laneKey, _signal) {
      await gate.promise;
      yield {
        type: "message.tokens",
        laneKey: laneKey ?? "lane",
        content: ".",
        chunkSequence: 1,
        done: true,
      };
    };

    const jm = new JobManager({ laneLock, ...FAST });
    const { events, cleanup } = collectEvents(eventBus);
    const lane = `evt:${Date.now()}`;
    const base = {
      ownerId: userId,
      agentId: "a1",
      roomId: "",
      threadId: `th-${Date.now()}`,
      graphThreadId: lane,
    };

    await jm.createForegroundJob(userId, userId, lane, { ...base, message: "a", turnId: randomUUID() }, executor);
    await jm.createForegroundJob(userId, userId, lane, { ...base, message: "b", turnId: randomUUID() }, executor);

    expect(events.filter((e) => e.type === "job.coalesced").length).toBe(2);

    gate.resolve();

    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (events.some((e) => e.type === "job.dispatched")) break;
    }

    const dispatched = events.filter((e) => e.type === "job.dispatched");
    expect(dispatched.length).toBeGreaterThanOrEqual(1);
    const d = dispatched[0]!;
    expect(d.type).toBe("job.dispatched");
    if (d.type === "job.dispatched") {
      expect(d.virtualJobIds.length).toBe(2);
    }
    cleanup();
  });
});
