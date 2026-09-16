import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { JobManager } from "../../src/job-manager";
import { eventBus } from "../../src/event-bus";
import { echoExecutor } from "../../src/executors/echo-executor";
import type { ServerEvent } from "@nautilo/types";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import {
  setupTestDb,
  createTestUser,
  cleanupTestUser,
  closeDirectDb,
  pollUntilComplete,
  getJobFromDb,
  slowExecutor,
  waitForRunningForegroundJob,
  waitForDispatchedJobCount,
} from "./helpers";

const fastCoalesce = {
  coalescerWindowMs: 45,
  coalescerFirstSegmentQuietMs: 45,
} as const;

let userId: string;
let jobManager: JobManager;

async function expectRejects(
  run: () => Promise<unknown>,
  assert: (err: unknown) => void,
): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeDefined();
  assert(thrown);
}

beforeAll(async () => {
  await setupTestDb();
  const result = await createTestUser("job-manager");
  userId = result.userId;
  jobManager = new JobManager(fastCoalesce);
});

afterAll(async () => {
  await cleanupTestUser(userId);
  await closeDirectDb();
});

describe("JobManager (integration)", () => {
  test("createForegroundJob creates and runs a job", async () => {
    await jobManager.createForegroundJob(
      userId,
      userId,
      `test:mgr:${Date.now()}`,
      { message: "hello" },
      echoExecutor,
    );

    const job = await waitForRunningForegroundJob(jobManager);

    expect(job.id).toBeTruthy();

    await pollUntilComplete(job, 10_000);
    expect(job.status).toBe("completed");

    const row = await getJobFromDb(job.id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("completed");
  });

  test("two jobs on same lane run sequentially after the first completes", async () => {
    const lane = `test:serial:${Date.now()}`;
    const order: string[] = [];

    async function* trackingExecutor(
      input: Record<string, unknown>,
      _jobId: string,
      laneKey: string | null,
      signal: AbortSignal,
    ): AsyncGenerator<ServerEvent> {
      const label =
        typeof input["label"] === "string" ? input["label"] : "unknown";
      order.push(`start:${label}`);

      for (let i = 1; i <= 5; i++) {
        if (signal.aborted) return;
        await new Promise((r) => setTimeout(r, 200));
        yield {
          type: "message.tokens",
          laneKey: laneKey ?? "default",
          content: `${label}-${i} `,
          chunkSequence: i,
          done: i === 5,
        };
      }

      order.push(`end:${label}`);
    }

    await jobManager.createForegroundJob(
      userId,
      userId,
      lane,
      { message: "a", label: "A" },
      trackingExecutor,
    );

    const jobA = await waitForRunningForegroundJob(jobManager);

    await pollUntilComplete(jobA, 15_000);

    await jobManager.createForegroundJob(
      userId,
      userId,
      lane,
      { message: "b", label: "B" },
      trackingExecutor,
    );

    const jobB = await waitForRunningForegroundJob(jobManager);

    await pollUntilComplete(jobB, 15_000);

    expect(jobA.status).toBe("completed");
    expect(jobB.status).toBe("completed");

    const startB = order.indexOf("start:B");
    const endA = order.indexOf("end:A");
    expect(endA).toBeLessThan(startB);
  });

  test("two jobs on different lanes run concurrently", async () => {
    const ts = Date.now();
    const order: string[] = [];

    async function* trackingExecutor(
      input: Record<string, unknown>,
      _jobId: string,
      laneKey: string | null,
      signal: AbortSignal,
    ): AsyncGenerator<ServerEvent> {
      const label =
        typeof input["label"] === "string" ? input["label"] : "unknown";
      order.push(`start:${label}`);

      for (let i = 1; i <= 3; i++) {
        if (signal.aborted) return;
        await new Promise((r) => setTimeout(r, 200));
        yield {
          type: "message.tokens",
          laneKey: laneKey ?? "default",
          content: `${label}-${i} `,
          chunkSequence: i,
          done: i === 3,
        };
      }

      order.push(`end:${label}`);
    }

    const laneA = `test:concurrent-a:${ts}`;
    const laneB = `test:concurrent-b:${ts}`;

    const bothDispatched = waitForDispatchedJobCount(jobManager, 2);

    await jobManager.createForegroundJob(
      userId,
      userId,
      laneA,
      { message: "a", label: "A" },
      trackingExecutor,
    );

    await jobManager.createForegroundJob(
      userId,
      userId,
      laneB,
      { message: "b", label: "B" },
      trackingExecutor,
    );

    const active = await bothDispatched;
    const jobA = active.find((j) => j.laneKey === laneA)!;
    const jobB = active.find((j) => j.laneKey === laneB)!;

    await pollUntilComplete(jobA, 10_000);
    await pollUntilComplete(jobB, 10_000);

    expect(jobA.status).toBe("completed");
    expect(jobB.status).toBe("completed");

    const startA = order.indexOf("start:A");
    const startB = order.indexOf("start:B");
    const endA = order.indexOf("end:A");
    const endB = order.indexOf("end:B");

    expect(startA).toBeLessThan(endA);
    expect(startB).toBeLessThan(endB);
    expect(startB).toBeLessThan(endA);
  });

  test("cancelJob cancels a running job", async () => {
    await jobManager.createForegroundJob(
      userId,
      userId,
      `test:cancel:${Date.now()}`,
      { message: "cancel me" },
      slowExecutor,
    );

    const job = await waitForRunningForegroundJob(jobManager);

    await new Promise((r) => setTimeout(r, 600));
    const cancelled = await jobManager.cancelJob(job.id);
    expect(cancelled).toBe(true);

    await pollUntilComplete(job, 5_000);
    expect(job.status).toBe("cancelled");
  });

  test("cancelJob returns false for unknown job", async () => {
    const result = await jobManager.cancelJob("nonexistent-id");
    expect(result).toBe(false);
  });

  test("empty message fails and persists failed status in DB", async () => {
    await jobManager.createForegroundJob(
      userId,
      userId,
      `test:empty:${Date.now()}`,
      { message: "" },
    );

    const job = await waitForRunningForegroundJob(jobManager);

    await pollUntilComplete(job, 10_000);
    expect(job.status).toBe("failed");

    const row = await getJobFromDb(job.id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("failed");
    // D141 friendly-error wrapping; see packages/runtime/tests/unit/job-friendly-errors.test.ts for the canonical contract.
    expect(row!.message).toMatch(/\[MDL\d{3}\]$/);
    expect(row!.message?.length ?? 0).toBeLessThan(200);
  });

  // D353 follow-up — regression for the stale Stop / isRunning bug after
  // approval-resumed turns. `runResumeJobLifecycle` wraps a resume chain in
  // a synthetic Job lifecycle (dispatched → running → terminal) so the
  // workbench gets a terminal `job.status` to clear `liveJobIdsRef` /
  // `isRunning`. Without this wrapper, the resumed graph stream runs
  // outside any Job and the workbench's optimistic `setIsRunning(true)`
  // from `submitApprovalAsk` never clears.
  describe("runResumeJobLifecycle (D353 stale-Stop fix)", () => {
    test("emits dispatched → running → completed around a successful resume", async () => {
      const events: ServerEvent[] = [];
      const handler = (ev: ServerEvent) => events.push(ev);
      eventBus.on(handler);
      try {
        const laneKey = `test:resume-ok:${Date.now()}`;
        await jobManager.runResumeJobLifecycle({ laneKey, roomId: randomUUID(), graphThreadId: laneKey, humanUserId: userId }, async () => {
          /* resolve silently — simulates a resume that finishes cleanly */
        }, createAcceptedInvocationAuthority(userId));

        const statuses = events
          .filter((ev) => ev.type === "job.status")
          .map((ev) => (ev as { status: string }).status);
        const dispatched = events.filter((ev) => ev.type === "job.dispatched");

        expect(dispatched.length).toBe(1);
        expect(statuses).toEqual(["running", "completed"]);
        const terminal = events.find(
          (ev) => ev.type === "job.status" && (ev as { status: string }).status === "completed",
        ) as { laneKey?: string } | undefined;
        expect(terminal?.laneKey).toBe(laneKey);
      } finally {
        eventBus.off(handler);
      }
    });

    test("emits dispatched → running → failed when the resume rejects", async () => {
      const events: ServerEvent[] = [];
      const handler = (ev: ServerEvent) => events.push(ev);
      eventBus.on(handler);
      try {
        const laneKey = `test:resume-fail:${Date.now()}`;
        await expectRejects(
          () => jobManager.runResumeJobLifecycle({ laneKey, roomId: randomUUID(), graphThreadId: laneKey, humanUserId: userId }, async () => {
            throw new Error("synthetic resume failure");
          }, createAcceptedInvocationAuthority(userId)),
          (err) => {
            expect(err).toBeInstanceOf(Error);
            expect((err as Error).message).toContain("synthetic resume failure");
          },
        );

        const statuses = events
          .filter((ev) => ev.type === "job.status")
          .map((ev) => (ev as { status: string }).status);
        expect(statuses).toEqual(["running", "failed"]);
        const failed = events.find(
          (ev) => ev.type === "job.status" && (ev as { status: string }).status === "failed",
        ) as { laneKey?: string; message?: string } | undefined;
        expect(failed?.laneKey).toBe(laneKey);
        expect(failed?.message).toContain("[MDL007]");
      } finally {
        eventBus.off(handler);
      }
    });

    test("emits exact resumed turn identity on the ephemeral terminal lifecycle", async () => {
      const events: ServerEvent[] = [];
      const handler = (event: ServerEvent) => events.push(event);
      eventBus.on(handler);
      try {
        const laneKey = `test:resume-identity:${Date.now()}`;
        await jobManager.runResumeJobLifecycle({
          laneKey,
          roomId: randomUUID(),
          graphThreadId: laneKey,
          humanUserId: userId,
          turnId: "turn-resume-identity",
          authorAgentId: "agent-resume-identity",
        }, async () => {}, createAcceptedInvocationAuthority(userId));

        expect(events.find((event) =>
          event.type === "job.status" && event.status === "completed"
        )).toMatchObject({
          turnId: "turn-resume-identity",
          authorAgentId: "agent-resume-identity",
        });
      } finally {
        eventBus.off(handler);
      }
    });

    test("redacts an ephemeral Full resume failure from logs and lifecycle events", async () => {
      const sentinel = "FULL_RESUME_PRIVATE_FAILURE_SENTINEL";
      const events: ServerEvent[] = [];
      const handler = (event: ServerEvent) => events.push(event);
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      eventBus.on(handler);
      try {
        const laneKey = `test:full-resume-fail:${Date.now()}`;
        await expectRejects(
          () => jobManager.runResumeJobLifecycle({
            laneKey,
            roomId: randomUUID(),
            graphThreadId: laneKey,
            humanUserId: userId,
            ephemeralSinkDisposition: "full",
          }, async () => {
            throw new Error(sentinel);
          }, createAcceptedInvocationAuthority(userId)),
          (error) => expect((error as Error).message).toBe(sentinel),
        );
        expect(JSON.stringify({ events, logs: errorSpy.mock.calls }))
          .not.toContain(sentinel);
        expect(events.find((event) =>
          event.type === "job.status" && event.status === "failed"
        )).toMatchObject({ message: "Protected operation failed [MDL007]" });
      } finally {
        eventBus.off(handler);
        errorSpy.mockRestore();
      }
    });

    test("registers the resume as active and stopRoom aborts its shared signal", async () => {
      const roomId = randomUUID();
      const laneKey = `room:${roomId}:user:test:bot:test`;
      const graphThreadId = `room:${roomId}:bot:test`;
      let observedSignal: AbortSignal | undefined;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      const running = jobManager.runResumeJobLifecycle(
        { laneKey, roomId, graphThreadId, humanUserId: userId },
        async (signal) => {
          observedSignal = signal;
          await waiting;
        },
        createAcceptedInvocationAuthority(userId),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(jobManager.getActiveJobIdsForRoom(roomId).length).toBe(1);

      const stopped = await jobManager.stopRoom(roomId);
      expect(stopped.stoppedJobs).toBe(1);
      expect(observedSignal?.aborted).toBe(true);
      release();
      await running;
      expect(jobManager.getActiveJobIdsForRoom(roomId)).toEqual([]);
    });
  });
});
