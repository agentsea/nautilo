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
  getJobFromDb,
  failingExecutor,
  slowExecutor,
} from "./helpers";

let userId: string;

beforeAll(async () => {
  await setupTestDb();
  const result = await createTestUser("job-lifecycle");
  userId = result.userId;
});

afterAll(async () => {
  await cleanupTestUser(userId);
  await closeDirectDb();
});

function createTestJob(
  executor: typeof echoExecutor,
  overrides?: Partial<{ laneKey: string; input: Record<string, unknown> }>,
) {
  return new Job({
    ownerId: userId,
    requestorId: userId,
    laneKey: overrides?.laneKey ?? `test:lifecycle:${Date.now()}`,
    type: "foreground",
    input: overrides?.input ?? { message: "test" },
    executor,
    persist: persistJob,
    updateStatus: updateJobStatus,
  });
}

describe("Job lifecycle (integration)", () => {
  test("foreground job completes with echo executor", async () => {
    const job = createTestJob(echoExecutor);
    await job.persist();

    expect(job.id).toBeTruthy();
    expect(job.status).toBe("queued");

    await job.execute();

    expect(job.status).toBe("completed");

    const row = await getJobFromDb(job.id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("completed");
    expect(row!.startedAt).not.toBeNull();
    expect(row!.completedAt).not.toBeNull();
  });

  test("job persists to database on creation", async () => {
    const job = createTestJob(echoExecutor);
    await job.persist();

    const row = await getJobFromDb(job.id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("queued");
    expect(row!.input).toEqual({ message: "test" });
    expect(row!.ownerId).toBe(userId);
  });

  test("failed executor sets failed status in DB", async () => {
    const job = createTestJob(failingExecutor);
    await job.persist();
    await job.execute();

    expect(job.status).toBe("failed");

    const row = await getJobFromDb(job.id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("failed");
    // D141 friendly-error wrapping; see packages/runtime/tests/unit/job-friendly-errors.test.ts for the canonical contract.
    expect(row!.message).toMatch(/\[MDL\d{3}\]$/);
    expect(row!.message?.length ?? 0).toBeLessThan(200);
  });

  test("cancelled job sets cancelled status in DB", async () => {
    const job = createTestJob(slowExecutor);
    await job.persist();

    const execPromise = job.execute();

    await new Promise((r) => setTimeout(r, 600));
    await job.cancel();
    await execPromise;

    expect(job.status).toBe("cancelled");

    const row = await getJobFromDb(job.id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("cancelled");
  });

  test("job emits events through event bus", async () => {
    const { events, cleanup } = collectEvents(eventBus);
    try {
      const job = createTestJob(echoExecutor);
      await job.persist();
      await job.execute();

      const statusEvents = events.filter(
        (e): e is ServerEvent & { type: "job.status" } =>
          e.type === "job.status" && "jobId" in e && e.jobId === job.id,
      );
      const tokenEvents = events.filter(
        (e) => e.type === "message.tokens" && e.laneKey === job.laneKey,
      );

      expect(statusEvents.length).toBeGreaterThanOrEqual(2);
      expect(statusEvents[0]!.status).toBe("running");
      expect(statusEvents[statusEvents.length - 1]!.status).toBe("completed");
      expect(tokenEvents.length).toBe(10);
    } finally {
      cleanup();
    }
  });
});
