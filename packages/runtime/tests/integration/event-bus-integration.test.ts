import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Job } from "../../src/job";
import { eventBus } from "../../src/event-bus";
import { echoExecutor } from "../../src/executors/echo-executor";
import { persistJob, updateJobStatus } from "@nautilo/db";
import type { ServerEvent } from "@nautilo/types";
import {
  setupTestDb,
  createTestUser,
  cleanupTestUser,
  closeDirectDb,
  collectEvents,
  slowExecutor,
} from "./helpers";

let userId: string;

beforeAll(async () => {
  await setupTestDb();
  const result = await createTestUser("event-bus-integ");
  userId = result.userId;
});

afterAll(async () => {
  await cleanupTestUser(userId);
  await closeDirectDb();
});

function createTestJob(
  executor: typeof echoExecutor,
  laneKey?: string,
) {
  return new Job({
    ownerId: userId,
    requestorId: userId,
    laneKey: laneKey ?? `test:events:${Date.now()}`,
    type: "foreground",
    input: { message: "event-test" },
    executor,
    persist: persistJob,
    updateStatus: updateJobStatus,
  });
}

describe("EventBus integration", () => {
  test("job execution emits status events in order", async () => {
    const { events, cleanup } = collectEvents(eventBus);
    try {
      const laneKey = `test:event-order:${Date.now()}`;
      const job = createTestJob(echoExecutor, laneKey);
      await job.persist();
      await job.execute();

      const statusEvents = events.filter(
        (e): e is ServerEvent & { type: "job.status" } =>
          e.type === "job.status" && "jobId" in e && e.jobId === job.id,
      );
      const tokenEvents = events.filter(
        (e): e is ServerEvent & { type: "message.tokens" } =>
          e.type === "message.tokens" &&
          "laneKey" in e &&
          e.laneKey === laneKey,
      );

      expect(statusEvents.length).toBeGreaterThanOrEqual(2);
      expect(statusEvents[0]!.status).toBe("running");
      expect(statusEvents[statusEvents.length - 1]!.status).toBe("completed");

      expect(tokenEvents.length).toBe(10);

      const runningIdx = events.indexOf(statusEvents[0]!);
      const completedIdx = events.indexOf(
        statusEvents[statusEvents.length - 1]!,
      );
      const firstTokenIdx = events.indexOf(tokenEvents[0]!);
      const lastTokenIdx = events.indexOf(tokenEvents[tokenEvents.length - 1]!);

      expect(runningIdx).toBeLessThan(firstTokenIdx);
      expect(lastTokenIdx).toBeLessThan(completedIdx);
    } finally {
      cleanup();
    }
  });

  test("multiple concurrent jobs emit interleaved events", async () => {
    const { events, cleanup } = collectEvents(eventBus);
    try {
      const ts = Date.now();
      const jobA = createTestJob(echoExecutor, `test:interleave-a:${ts}`);
      const jobB = createTestJob(echoExecutor, `test:interleave-b:${ts}`);

      await jobA.persist();
      await jobB.persist();

      const execA = jobA.execute();
      const execB = jobB.execute();
      await Promise.all([execA, execB]);

      const eventsA = events.filter(
        (e) => "jobId" in e && e.jobId === jobA.id,
      );
      const eventsB = events.filter(
        (e) => "jobId" in e && e.jobId === jobB.id,
      );

      expect(eventsA.length).toBeGreaterThan(0);
      expect(eventsB.length).toBeGreaterThan(0);

      const statusA = eventsA.filter(
        (e): e is ServerEvent & { type: "job.status" } =>
          e.type === "job.status",
      );
      const statusB = eventsB.filter(
        (e): e is ServerEvent & { type: "job.status" } =>
          e.type === "job.status",
      );

      expect(statusA[0]!.status).toBe("running");
      expect(statusA[statusA.length - 1]!.status).toBe("completed");
      expect(statusB[0]!.status).toBe("running");
      expect(statusB[statusB.length - 1]!.status).toBe("completed");
    } finally {
      cleanup();
    }
  });

  test("cancelled job emits cancelled status event", async () => {
    const { events, cleanup } = collectEvents(eventBus);
    try {
      const job = createTestJob(slowExecutor);
      await job.persist();

      const execPromise = job.execute();

      await new Promise((r) => setTimeout(r, 600));
      await job.cancel();
      await execPromise;

      const statusEvents = events.filter(
        (e): e is ServerEvent & { type: "job.status" } =>
          e.type === "job.status" && "jobId" in e && e.jobId === job.id,
      );

      const statuses = statusEvents.map((e) => e.status);
      expect(statuses).toContain("cancelled");
    } finally {
      cleanup();
    }
  });
});
