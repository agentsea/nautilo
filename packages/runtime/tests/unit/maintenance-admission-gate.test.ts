import { describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { JobManager } from "../../src/job-manager";
import { dispatchTaskRun } from "../../src/tasks/dispatch-task-run";
import { TaskObserver } from "../../src/tasks/task-observer";
import {
  MaintenanceDrainError,
  type MaintenanceAcceptanceAuthority,
  type MaintenanceGate,
} from "../../src/maintenance-controller";
import type { JobExecutor } from "../../src/job";

class ToggleMaintenanceGate implements MaintenanceGate {
  constructor(public state: "normal" | "draining" = "normal") {}

  async assertAcceptingNewWork(authority?: MaintenanceAcceptanceAuthority): Promise<void> {
    if (this.state === "draining" && !authority) {
      throw new MaintenanceDrainError("draining");
    }
  }

  async isAcceptingWork(): Promise<boolean> {
    return this.state === "normal";
  }
}

function foregroundInput() {
  const roomId = randomUUID();
  return {
    message: "maintenance gate test",
    ownerId: randomUUID(),
    requestorId: randomUUID(),
    agentId: randomUUID(),
    roomId,
    graphThreadId: `room:${roomId}:bot:test`,
    turnId: randomUUID(),
  };
}

const noopExecutor: JobExecutor = async function* () {
  yield* [] as never[];
};

async function expectDrainRejection(work: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await work;
  } catch (err) {
    caught = err;
  }
  expect(caught).toMatchObject({
    code: "maintenance_draining",
    retryable: true,
    maintenanceState: "draining",
  });
}

describe("D420 maintenance admission gate", () => {
  test("rejects a new foreground enqueue before durable acceptance persists", async () => {
    const gate = new ToggleMaintenanceGate("draining");
    let inserted = 0;
    const manager = new JobManager({
      maintenanceGate: gate,
      persist: async () => randomUUID(),
      acceptanceSinks: {
        insertAcceptance: async () => {
          inserted += 1;
          return randomUUID();
        },
        linkAcceptancesToJob: async (ids: readonly string[]) => ids.length,
        terminalizeAllAcceptedWork: async () => 0,
        userCancelAcceptedWork: async () => 0,
      },
    });

    await expectDrainRejection(
      manager.createForegroundJob(
        randomUUID(),
        randomUUID(),
        "room:test",
        foregroundInput(),
        noopExecutor,
      ),
    );
    expect(inserted).toBe(0);
    expect(manager.getForegroundWorkSummary()).toEqual({
      runningJobs: 0,
      queuedTurns: 0,
      bufferedLanes: 0,
    });
  });

  test("permits only an authority-carrying system continuation after drain begins", async () => {
    const gate = new ToggleMaintenanceGate("normal");
    let inserted = 0;
    const manager = new JobManager({
      maintenanceGate: gate,
      persist: async () => randomUUID(),
      acceptanceSinks: {
        insertAcceptance: async () => {
          inserted += 1;
          return randomUUID();
        },
        linkAcceptancesToJob: async (ids: readonly string[]) => ids.length,
        terminalizeAllAcceptedWork: async () => 0,
        userCancelAcceptedWork: async () => 0,
      },
    });
    const ownerId = randomUUID();
    const accepted = await manager.createForegroundJob(
      ownerId,
      ownerId,
      "room:test",
      foregroundInput(),
      noopExecutor,
    );
    expect(accepted.acceptanceAuthority).toBeDefined();

    gate.state = "draining";
    await expectDrainRejection(
      manager.createSystemForegroundJob(
        ownerId,
        ownerId,
        "room:test",
        foregroundInput(),
        noopExecutor,
      ),
    );
    expect(inserted).toBe(1);

    await manager.createSystemForegroundJob(
      ownerId,
      ownerId,
      "room:test",
      foregroundInput(),
      noopExecutor,
      accepted.acceptanceAuthority,
    );
    expect(inserted).toBe(2);
  });

  test("rejects a new background start but permits accepted-work continuation", async () => {
    const gate = new ToggleMaintenanceGate("draining");
    let persisted = 0;
    const manager = new JobManager({
      maintenanceGate: gate,
      persist: async () => {
        persisted += 1;
        return randomUUID();
      },
    });
    await expectDrainRejection(
      manager.createBackgroundJob(randomUUID(), randomUUID(), { type: "deep-research" }),
    );
    expect(persisted).toBe(0);

    const continuationGate = new ToggleMaintenanceGate("normal");
    const continuationManager = new JobManager({
      maintenanceGate: continuationGate,
      persist: async () => randomUUID(),
    });
    const acceptedForeground = await continuationManager.createForegroundJob(
      randomUUID(),
      randomUUID(),
      "room:test",
      foregroundInput(),
      noopExecutor,
    );
    continuationGate.state = "draining";
    const continued = await continuationManager.createBackgroundJob(
      randomUUID(),
      randomUUID(),
      { type: "deep-research" },
      acceptedForeground.acceptanceAuthority,
    );
    expect(continued.id).toBeString();
  });

  test("rejects Task dispatch before it reads, claims, or writes a task run", async () => {
    const gate = new ToggleMaintenanceGate("draining");
    let createForegroundCalls = 0;
    const task = {
      id: randomUUID(),
    };
    await expectDrainRejection(
      dispatchTaskRun(task as never, {
        db: {} as never,
        jobManager: {
          createForegroundJob: async () => {
            createForegroundCalls += 1;
            throw new Error("must not create");
          },
        },
        maintenanceGate: gate,
        assertInvocation: async () => {},
      }),
    );
    expect(createForegroundCalls).toBe(0);
  });

  test("skips scheduled Task claiming while draining", async () => {
    const gate = new ToggleMaintenanceGate("draining");
    let createForegroundCalls = 0;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const observer = new TaskObserver({
      // The drain check runs before `claimDueTasks`; this deliberately
      // incomplete handle would fail if the observer tried to claim.
      db: {} as never,
      jobManager: {
        createForegroundJob: async () => {
          createForegroundCalls += 1;
          throw new Error("must not dispatch");
        },
        abortJob: () => false,
      },
      maintenanceGate: gate,
      assertInvocation: async () => {},
    });
    try {
      await observer.tick();
      expect(createForegroundCalls).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith(
        "[task-observer] new work is currently gated — skipping due-task claim this tick",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("runs server-owned live maintenance on the observer tick, not a second timer", async () => {
    const gate = new ToggleMaintenanceGate("draining");
    let maintenanceCalls = 0;
    const observer = new TaskObserver({
      db: {} as never,
      jobManager: {
        createForegroundJob: async () => {
          throw new Error("must not dispatch while draining");
        },
        abortJob: () => false,
      },
      maintenanceGate: gate,
      onMaintenance: () => {
        maintenanceCalls += 1;
      },
      assertInvocation: async () => {},
    });

    await observer.tick();
    expect(maintenanceCalls).toBe(1);
    await observer.stop();
  });
});
