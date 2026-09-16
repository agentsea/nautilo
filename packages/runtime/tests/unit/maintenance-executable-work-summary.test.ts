import { describe, expect, test } from "bun:test";
import { Job, type JobExecutor } from "../../src/job";
import { JobManager } from "../../src/job-manager";

const pendingExecutor: JobExecutor = async function* () {
  await new Promise<void>(() => {});
  yield* [] as never[];
};

function makeJob(
  type: "foreground" | "background",
  input: Record<string, unknown>,
  id: string,
): Job {
  return new Job({
    ownerId: "owner",
    requestorId: "requestor",
    laneKey: type === "foreground" ? "lane" : null,
    type,
    input,
    executor: pendingExecutor,
    persist: async () => id,
    updateStatus: async () => {},
  });
}

function activeJobs(manager: JobManager): Map<string, Job> {
  // Unit-only white-box seam: JobManager's public summary is derived from this
  // live map, and manual Job persistence lets the test pin queued/running work
  // without needing a real executor/DB.
  return (manager as unknown as { active: Map<string, Job> }).active;
}

describe("D420 executable Job work summary", () => {
  test("counts foreground/background jobs while excluding Task-run Jobs for durable task accounting", async () => {
    const manager = new JobManager();
    const ordinaryForeground = makeJob("foreground", { message: "ordinary" }, "foreground-1");
    const taskForeground = makeJob(
      "foreground",
      { taskRunId: "task-run-1", message: "task work" },
      "task-job-1",
    );
    const background = makeJob("background", { task: "deep research" }, "background-1");
    await ordinaryForeground.persist();
    await taskForeground.persist();
    await background.persist();
    activeJobs(manager).set(ordinaryForeground.id, ordinaryForeground);
    activeJobs(manager).set(taskForeground.id, taskForeground);
    activeJobs(manager).set(background.id, background);

    expect(manager.getExecutableJobWorkSummary()).toEqual({
      runningForegroundJobs: 1,
      runningBackgroundJobs: 1,
      queuedTurns: 0,
      bufferedLanes: 0,
    });
    // Legacy readiness retains its historical foreground-only view.
    expect(manager.getForegroundWorkSummary().runningJobs).toBe(2);
  });
});
