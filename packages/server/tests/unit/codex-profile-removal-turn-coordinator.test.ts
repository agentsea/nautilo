import { describe, expect, test } from "bun:test";
import {
  CodexProfileRemovalTurnCoordinator,
  CodexProfileRemovalTurnCoordinatorFailure,
  type CodexProfileRemovalBindingWork,
} from "../../src/codex/profile-removal-turn-coordinator";

const TARGET = Object.freeze({
  userId: "11111111-1111-4111-8111-111111111111",
  profileId: "22222222-2222-4222-8222-222222222222",
});

function work(
  taskId: string,
  jobId: string,
): CodexProfileRemovalBindingWork {
  return { taskId, jobId };
}

describe("CodexProfileRemovalTurnCoordinator", () => {
  test("stops each retained Task once and waits for generic task and JobManager proof", async () => {
    const statuses = new Map([
      ["task-a", "running"],
      ["task-b", "paused"],
    ]);
    const jobs = new Set(["job-a", "job-b"]);
    const stopped: string[] = [];
    const coordinator = new CodexProfileRemovalTurnCoordinator({
      listBindingWork: async (target) => {
        expect(target).toEqual(TARGET);
        return [
          work("task-a", "job-a"),
          work("task-b", "job-b"),
          // The set contains the Task once even if a stale retained record is
          // encountered during recovery; Stop must remain canonical and once.
          work("task-a", "job-a"),
        ];
      },
      readTask: async (taskId) => ({ ownerId: TARGET.userId, status: statuses.get(taskId)! }),
      stopTask: async (taskId) => {
        stopped.push(taskId);
        statuses.set(taskId, "cancelled");
        jobs.delete(taskId === "task-a" ? "job-a" : "job-b");
      },
      getJob: (jobId) => jobs.has(jobId) ? { id: jobId } : undefined,
    });

    await coordinator.drain(TARGET);

    expect(stopped.sort()).toEqual(["task-a", "task-b"]);
  });

  test("re-reads to a fixed point and stops work admitted at the tombstone boundary", async () => {
    const statuses = new Map([
      ["task-a", "running"],
      ["task-b", "running"],
    ]);
    const jobs = new Set(["job-a", "job-b"]);
    const stopped: string[] = [];
    let reads = 0;
    const coordinator = new CodexProfileRemovalTurnCoordinator({
      listBindingWork: async () => {
        reads += 1;
        const first = [work("task-a", "job-a")];
        // First read admits A. The fixed-point reread observes B, which was
        // already in flight when the profile selection tombstone committed.
        if (reads === 1) return first;
        return [...first, work("task-b", "job-b")];
      },
      readTask: async (taskId) => ({ ownerId: TARGET.userId, status: statuses.get(taskId)! }),
      stopTask: async (taskId) => {
        stopped.push(taskId);
        statuses.set(taskId, "cancelled");
        jobs.delete(taskId === "task-a" ? "job-a" : "job-b");
      },
      getJob: (jobId) => jobs.has(jobId) ? { id: jobId } : undefined,
      wait: async () => undefined,
    });

    await coordinator.drain(TARGET);

    expect(stopped).toEqual(["task-a", "task-b"]);
    expect(reads).toBeGreaterThanOrEqual(4);
  });

  test("waits after Stop makes a Task terminal until JobManager releases its retained job", async () => {
    let taskStatus = "running";
    let jobRetained = true;
    let waits = 0;
    const coordinator = new CodexProfileRemovalTurnCoordinator({
      listBindingWork: async () => [work("task-a", "job-a")],
      readTask: async () => ({ ownerId: TARGET.userId, status: taskStatus }),
      stopTask: async () => { taskStatus = "cancelled"; },
      getJob: () => jobRetained ? { id: "job-a" } : undefined,
      wait: async () => {
        waits += 1;
        jobRetained = false;
      },
    });

    await coordinator.drain(TARGET);

    expect(waits).toBe(1);
  });

  test("times out retryably without re-stopping a Task when generic work never unwinds", async () => {
    let now = 0;
    let stops = 0;
    const coordinator = new CodexProfileRemovalTurnCoordinator({
      listBindingWork: async () => [work("task-a", "job-a")],
      readTask: async () => ({ ownerId: TARGET.userId, status: "running" }),
      stopTask: async () => { stops += 1; },
      getJob: () => ({ id: "job-a" }),
      now: () => now,
      timeoutMs: 10,
      pollMs: 5,
      wait: async (delay) => { now += delay; },
    });

    expect(await rejectionOf(() => coordinator.drain(TARGET))).toMatchObject({
      name: "CodexProfileRemovalTurnCoordinatorFailure",
      code: "CODEX_PROFILE_REMOVAL_DRAIN_UNAVAILABLE",
      reason: "timeout",
    } satisfies Partial<CodexProfileRemovalTurnCoordinatorFailure>);
    expect(stops).toBe(1);
  });

  test("rejects malformed retained work before invoking a lifecycle mutation", async () => {
    let stopped = false;
    const coordinator = new CodexProfileRemovalTurnCoordinator({
      listBindingWork: async () => [work("", "job-a")],
      readTask: async () => ({ ownerId: TARGET.userId, status: "running" }),
      stopTask: async () => { stopped = true; },
      getJob: () => undefined,
    });

    expect(await rejectionOf(() => coordinator.drain(TARGET))).toMatchObject({
      reason: "invalid_binding_work",
    });
    expect(stopped).toBe(false);
  });
});

async function rejectionOf(operation: () => Promise<void>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to reject");
}
