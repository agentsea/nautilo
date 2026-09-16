import { describe, expect, test } from "bun:test";
import type { TaskSummary } from "@nautilo/types";
import {
  createTaskStateStore,
  shouldSuppressWsOpenSeed,
  SEED_SUPPRESS_AFTER_MOUNT_MS,
} from "../../src/contexts/task-state/task-state-store";
import { filterScheduledTasks } from "../../src/pages/scheduled-tasks/scheduled-tasks-view-model";

function task(over: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "task-1",
    parentTaskId: null,
    depth: 0,
    status: "running",
    preset: "in_background",
    prompt: "do work",
    scheduleKind: "now",
    nextFireAt: null,
    callingRoomId: null,
    agentName: "Genie",
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("shouldSuppressWsOpenSeed", () => {
  test("suppresses ws-open when mount seed completed recently", () => {
    expect(
      shouldSuppressWsOpenSeed({
        source: "ws-open",
        seedInflight: false,
        lastSeedCompletedAtMs: 1000,
        nowMs: 1500,
        suppressWindowMs: SEED_SUPPRESS_AFTER_MOUNT_MS,
      }),
    ).toBe(true);
  });

  test("does not suppress mount seed", () => {
    expect(
      shouldSuppressWsOpenSeed({
        source: "mount",
        seedInflight: false,
        lastSeedCompletedAtMs: 1000,
        nowMs: 1100,
        suppressWindowMs: SEED_SUPPRESS_AFTER_MOUNT_MS,
      }),
    ).toBe(false);
  });

  test("joins in-flight mount seed on ws-open", () => {
    expect(
      shouldSuppressWsOpenSeed({
        source: "ws-open",
        seedInflight: true,
        lastSeedCompletedAtMs: null,
        nowMs: 500,
        suppressWindowMs: SEED_SUPPRESS_AFTER_MOUNT_MS,
      }),
    ).toBe(true);
  });
});

describe("createTaskStateStore — startup seed", () => {
  test("mount then ws-open issues one list fetch when mount completes first", async () => {
    let calls = 0;
    const store = createTaskStateStore({
      listActiveTasks: async () => {
        calls += 1;
        return [task()];
      },
      now: () => 5000,
    });

    await store.seed("mount");
    await store.seed("ws-open");

    expect(calls).toBe(1);
  });

  test("mount then ws-open shares one in-flight fetch", async () => {
    let calls = 0;
    const gate = deferred<TaskSummary[]>();
    const store = createTaskStateStore({
      listActiveTasks: async () => {
        calls += 1;
        return gate.promise;
      },
    });

    const mount = store.seed("mount");
    const wsOpen = store.seed("ws-open");
    gate.resolve([task()]);
    await Promise.all([mount, wsOpen]);

    expect(calls).toBe(1);
  });
});

describe("createTaskStateStore — shared scheduled/running projection", () => {
  test("scheduled tasks and running subagents read the same canonical map", async () => {
    const store = createTaskStateStore({
      listActiveTasks: async () => [
        task({ id: "run-1", status: "running", scheduleKind: "now" }),
        task({
          id: "sched-1",
          status: "pending",
          scheduleKind: "cron",
          cron: "0 9 * * *",
          nextFireAt: "2026-07-18T09:00:00.000Z",
        }),
      ],
    });

    await store.seed("mount");
    const snapshot = store.getSnapshot();

    expect(filterScheduledTasks(snapshot.tasks).map((t) => t.id)).toEqual(["sched-1"]);
    expect(Object.keys(snapshot.runningSubagentsMap)).toEqual(["run-1"]);
  });
});

describe("createTaskStateStore — lifecycle reconciliation", () => {
  test("pause refreshes canonical map after mutation", async () => {
    let listCalls = 0;
    const store = createTaskStateStore({
      listActiveTasks: async () => {
        listCalls += 1;
        if (listCalls === 1) {
          return [
            task({
              id: "sched-1",
              status: "pending",
              scheduleKind: "cron",
              cron: "0 9 * * *",
            }),
          ];
        }
        return [
          task({
            id: "sched-1",
            status: "paused",
            scheduleKind: "cron",
            cron: "0 9 * * *",
          }),
        ];
      },
      lifecycle: {
        pauseTask: async () => ({ ok: true }),
        unpauseTask: async () => ({ ok: true }),
        stopTask: async () => ({ ok: true }),
      },
    });

    await store.seed("mount");
    await store.pauseTask("sched-1");

    expect(store.getSnapshot().taskMap["sched-1"]?.status).toBe("paused");
    expect(listCalls).toBe(2);
  });
});

describe("createTaskStateStore — non-overlapping refresh/poll", () => {
  test("refresh calls do not overlap", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const gate = deferred<TaskSummary[]>();
    const store = createTaskStateStore({
      listActiveTasks: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await gate.promise;
        } finally {
          inFlight -= 1;
        }
      },
    });

    const first = store.refresh();
    const second = store.refresh();
    gate.resolve([task()]);
    await Promise.all([first, second]);

    expect(maxInFlight).toBe(1);
  });

  test("dashboard poll chains after completion without overlap", async () => {
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const scheduled: Array<() => void> = [];
    const store = createTaskStateStore({
      pollIntervalMs: 50,
      schedule: (fn, _delayMs) => {
        scheduled.push(fn);
        return scheduled.length as ReturnType<typeof setTimeout>;
      },
      clearSchedule: () => {},
      listActiveTasks: async () => {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return [task({ id: `t-${calls}` })];
      },
    });

    await store.seed("mount");
    expect(calls).toBe(1);

    store.setDashboardPollingEnabled(true);
    expect(scheduled.length).toBe(1);

    scheduled[0]();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    expect(maxInFlight).toBe(1);
    expect(scheduled.length).toBe(2);

    store.setDashboardPollingEnabled(false);
    expect(calls).toBe(2);
  });
});

describe("createTaskStateStore — viewer scope", () => {
  test("clearForViewerChange drops prior viewer task data", async () => {
    const store = createTaskStateStore({
      listActiveTasks: async () => [task({ id: "viewer-a-task" })],
    });

    await store.seed("mount");
    expect(store.getSnapshot().tasks).toHaveLength(1);

    store.clearForViewerChange();
    const cleared = store.getSnapshot();
    expect(cleared.tasks).toHaveLength(0);
    expect(cleared.loading).toBe(true);
    expect(Object.keys(cleared.runningSubagentsMap)).toHaveLength(0);
  });
});

describe("createTaskStateStore — WS enrichment", () => {
  test("task.fired reconciles through the canonical refresh", async () => {
    let listCalls = 0;
    const store = createTaskStateStore({
      listActiveTasks: async () => {
        listCalls += 1;
        return [task({ id: "run-1", status: "running" })];
      },
    });
    await store.seed("mount");

    // Simulate a stale running projection; the canonical map remains the
    // source of truth and the fired event must refresh through its single
    // refresh path before restoring the card.
    store.applyWsEvent({
      type: "task.status",
      taskId: "run-1",
      status: "pending",
      ownerId: "owner",
    });
    store.applyWsEvent({
      type: "task.fired",
      taskId: "run-1",
      taskRunId: "run-1",
      laneKey: "task:run-1",
      ownerId: "owner",
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(listCalls).toBe(2);
    expect(store.getSnapshot().runningSubagentsMap["run-1"]?.taskRunId).toBe("run-1");
  });

  test("task.fired joins an in-flight canonical refresh", async () => {
    let listCalls = 0;
    const refreshGate = deferred<TaskSummary[]>();
    const store = createTaskStateStore({
      listActiveTasks: async () => {
        listCalls += 1;
        return listCalls === 1 ? [task({ id: "run-1", status: "running" })] : refreshGate.promise;
      },
    });
    await store.seed("mount");

    const refresh = store.refresh();
    store.applyWsEvent({
      type: "task.status",
      taskId: "run-1",
      status: "pending",
      ownerId: "owner",
    });
    store.applyWsEvent({
      type: "task.fired",
      taskId: "run-1",
      taskRunId: "run-2",
      laneKey: "task:run-1",
      ownerId: "owner",
    });

    expect(listCalls).toBe(2);
    refreshGate.resolve([task({ id: "run-1", status: "running" })]);
    await refresh;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(listCalls).toBe(2);
    expect(store.getSnapshot().runningSubagentsMap["run-1"]?.taskRunId).toBe("run-2");
  });

  test("task.fired retains activity that arrives before canonical refresh completes", async () => {
    let listCalls = 0;
    const refreshGate = deferred<TaskSummary[]>();
    const store = createTaskStateStore({
      listActiveTasks: async () => {
        listCalls += 1;
        return listCalls === 1 ? [] : refreshGate.promise;
      },
    });
    await store.seed("mount");

    store.applyWsEvent({
      type: "task.fired",
      taskId: "run-1",
      taskRunId: "turn-1",
      laneKey: "task:run-1",
      ownerId: "owner",
    });
    store.applyWsEvent({
      type: "task.progress",
      taskId: "run-1",
      taskRunId: "turn-1",
      detail: "Command completed",
      activity: {
        id: "command-1",
        kind: "command",
        name: "run_command",
        status: "completed",
        args: { command: "pwd" },
        result: "/workspace",
        startedAt: 1000,
        endedAt: 1001,
      },
      ownerId: "owner",
    });

    refreshGate.resolve([task({ id: "run-1", status: "running", harnessId: "codex" })]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(store.getSnapshot().runningSubagentsMap["run-1"]).toMatchObject({
      taskRunId: "turn-1",
      harnessActivity: [{
        id: "command-1",
        args: { command: "pwd" },
        result: "/workspace",
      }],
    });
  });

  test("task.fired remains visibly queued until semantic harness progress arrives", async () => {
    let calls = 0;
    const store = createTaskStateStore({
      listActiveTasks: async () => {
        calls += 1;
        return calls === 1 ? [] : [task({ id: "run-1", status: "running", harnessId: "codex" })];
      },
    });
    await store.seed("mount");
    store.applyWsEvent({
      type: "task.fired",
      taskId: "run-1",
      taskRunId: "turn-1",
      laneKey: "task:run-1",
      ownerId: "owner",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(store.getSnapshot().runningSubagentsMap["run-1"]?.line3).toBe("Queued for execution…");
    store.applyWsEvent({
      type: "task.progress",
      taskId: "run-1",
      taskRunId: "turn-1",
      detail: "Codex turn started",
      ownerId: "owner",
    });
    expect(store.getSnapshot().runningSubagentsMap["run-1"]?.line3).toBe("Codex turn started");
  });

  test("seeded work uses the shared fixed lifecycle fallback until exact live activity arrives", async () => {
    const store = createTaskStateStore({
      listActiveTasks: async () => [task({ id: "codex-1", status: "running", harnessId: "codex" })],
    });
    await store.seed("mount");
    expect(store.getSnapshot().runningSubagentsMap["codex-1"]?.line3).toBe("Working…");

    const native = createTaskStateStore({
      listActiveTasks: async () => [task({ id: "native-1", status: "running", harnessId: null })],
    });
    await native.seed("mount");
    expect(native.getSnapshot().runningSubagentsMap["native-1"]?.line3).toBe("Working…");
  });

  test("terminal linger rejects late same-run progress and stale status until a new fired run", async () => {
    const store = createTaskStateStore({
      listActiveTasks: async () => [task({ id: "run-1", status: "running" })],
    });
    await store.seed("mount");
    store.applyWsEvent({
      type: "task.fired", taskId: "run-1", taskRunId: "run-1", laneKey: "task:run-1", ownerId: "owner",
    });
    store.applyWsEvent({
      type: "task.completed", taskId: "run-1", taskRunId: "run-1", status: "completed", ownerId: "owner",
    });
    store.applyWsEvent({
      type: "task.progress", taskId: "run-1", taskRunId: "run-1", detail: "stale progress", ownerId: "owner",
    });
    store.applyWsEvent({
      type: "task.status", taskId: "run-1", status: "running", ownerId: "owner",
    });

    expect(store.getSnapshot().runningSubagentsMap["run-1"]).toMatchObject({
      status: "done", line3: "Done", recentActivity: [],
    });
    expect(store.getSnapshot().taskMap["run-1"]?.status).toBe("completed");

    store.applyWsEvent({
      type: "task.fired", taskId: "run-1", taskRunId: "run-2", laneKey: "task:run-1", ownerId: "owner",
    });
    expect(store.getSnapshot().runningSubagentsMap["run-1"]).toMatchObject({
      status: "running", taskRunId: "run-2", line3: "Queued for execution…",
    });
  });

  test("same-run completion during fired reconciliation cannot be resurrected by a stale running seed", async () => {
    let calls = 0;
    const gate = deferred<TaskSummary[]>();
    const store = createTaskStateStore({
      listActiveTasks: async () => {
        calls += 1;
        return calls === 1 ? [] : gate.promise;
      },
    });
    await store.seed("mount");
    store.applyWsEvent({
      type: "task.fired", taskId: "run-1", taskRunId: "run-1", laneKey: "task:run-1", ownerId: "owner",
    });
    store.applyWsEvent({
      type: "task.completed", taskId: "run-1", taskRunId: "run-1", status: "completed", ownerId: "owner",
    });

    gate.resolve([task({ id: "run-1", status: "running" })]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(calls).toBe(2);
    expect(store.getSnapshot().runningSubagentsMap["run-1"]).toMatchObject({
      status: "done", taskRunId: "run-1", line3: "Done",
    });
  });

  test("ws-open clears provisional progress before a suppressed seed", async () => {
    let calls = 0;
    const store = createTaskStateStore({
      listActiveTasks: async () => {
        calls += 1;
        return [task({ id: "run-1", status: "running", harnessId: "codex" })];
      },
      now: () => 1000,
    });
    await store.seed("mount");
    store.applyWsEvent({
      type: "task.progress", taskId: "run-1", taskRunId: "run-1", detail: "exact before disconnect", ownerId: "owner",
    });

    await store.seed("ws-open");

    expect(calls).toBe(1);
    expect(store.getSnapshot().runningSubagentsMap["run-1"]).toMatchObject({
      line3: "Working…", recentActivity: [], harnessActivity: [],
    });
  });

  test("ws-open clears provisional progress even when its seed fails", async () => {
    let calls = 0;
    const store = createTaskStateStore({
      listActiveTasks: async () => {
        calls += 1;
        if (calls === 1) return [task({ id: "run-1", status: "running", harnessId: "codex" })];
        throw new Error("offline");
      },
      seedSuppressAfterMountMs: 0,
    });
    await store.seed("mount");
    store.applyWsEvent({
      type: "task.progress", taskId: "run-1", taskRunId: "run-1", detail: "exact before disconnect", ownerId: "owner",
    });

    await store.seed("ws-open");

    expect(calls).toBe(2);
    expect(store.getSnapshot().runningSubagentsMap["run-1"]).toMatchObject({
      line3: "Working…", recentActivity: [], harnessActivity: [],
    });
  });

  test("fresh progress during an in-flight ws-open seed survives reconciliation", async () => {
    let calls = 0;
    const gate = deferred<TaskSummary[]>();
    const store = createTaskStateStore({
      listActiveTasks: async () => {
        calls += 1;
        return calls === 1 ? [task({ id: "run-1", status: "running" })] : gate.promise;
      },
      seedSuppressAfterMountMs: 0,
    });
    await store.seed("mount");
    store.applyWsEvent({
      type: "task.progress", taskId: "run-1", taskRunId: "run-1", detail: "before disconnect", ownerId: "owner",
    });

    const reconnect = store.seed("ws-open");
    store.applyWsEvent({
      type: "task.progress", taskId: "run-1", taskRunId: "run-2", detail: "fresh after reconnect", ownerId: "owner",
    });
    gate.resolve([task({ id: "run-1", status: "running" })]);
    await reconnect;

    expect(store.getSnapshot().runningSubagentsMap["run-1"]?.line3).toBe("fresh after reconnect");
  });

  test("keeps only 20 harness activities and one current operation", async () => {
    const store = createTaskStateStore({
      listActiveTasks: async () => [task({ id: "run-1", status: "running", harnessId: "codex" })],
    });
    await store.seed("mount");
    for (let index = 0; index < 25; index += 1) {
      store.applyWsEvent({
        type: "task.progress",
        taskId: "run-1",
        taskRunId: "turn-1",
        detail: `completed-${index}`,
        activity: {
          id: `completed-${index}`,
          kind: "command",
          name: "run_command",
          status: "completed",
          args: {},
          startedAt: index,
          endedAt: index,
        },
        ownerId: "owner",
      });
    }
    for (const id of ["running-one", "running-two"]) {
      store.applyWsEvent({
        type: "task.progress",
        taskId: "run-1",
        taskRunId: "turn-1",
        detail: id,
        activity: { id, kind: "command", name: "run_command", status: "running", args: {}, startedAt: 100 },
        ownerId: "owner",
      });
    }
    const activity = store.getSnapshot().runningSubagentsMap["run-1"]?.harnessActivity ?? [];
    expect(activity.length).toBeLessThanOrEqual(20);
    expect(activity.filter((item) => item.status === "running" || item.status === "waiting")).toHaveLength(1);
    expect(activity.at(-1)?.id).toBe("running-two");
  });

  test("bounds the plain semantic activity fallback to the same 20-item / 64KiB envelope", async () => {
    const store = createTaskStateStore({
      listActiveTasks: async () => [task({ id: "run-1", status: "running", harnessId: "codex" })],
    });
    await store.seed("mount");
    for (let index = 0; index < 24; index += 1) {
      store.applyWsEvent({
        type: "task.progress",
        taskId: "run-1",
        taskRunId: "turn-1",
        detail: `${index}:${"x".repeat(4_000)}`,
        ownerId: "owner",
      });
    }
    const activity = store.getSnapshot().runningSubagentsMap["run-1"]?.recentActivity ?? [];
    expect(activity.length).toBeLessThanOrEqual(20);
    expect(Buffer.byteLength(JSON.stringify(activity), "utf8")).toBeLessThanOrEqual(64 * 1024);
  });

  test("strictly bounds a single pathological rich activity including args and result", async () => {
    const store = createTaskStateStore({
      listActiveTasks: async () => [task({ id: "run-1", status: "running", harnessId: "codex" })],
    });
    await store.seed("mount");
    store.applyWsEvent({
      type: "task.progress",
      taskId: "run-1",
      taskRunId: "turn-1",
      detail: "Command running",
      activity: {
        id: "x".repeat(100_000),
        kind: "command",
        name: "y".repeat(100_000),
        status: "running",
        args: { command: "z".repeat(100_000) },
        result: "r".repeat(100_000),
        startedAt: 1,
      },
      ownerId: "owner",
    });
    const activity = store.getSnapshot().runningSubagentsMap["run-1"]?.harnessActivity ?? [];
    expect(activity).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(activity), "utf8")).toBeLessThanOrEqual(64 * 1024);
  });

  test("review counts seed, update live, reject stale runs and clear for a new run", async () => {
    const initial = { unitsCompleted: 4, unitsTotal: 15, unitsPending: 11, filesTotal: 36, filesAssigned: 30 };
    const store = createTaskStateStore({
      listActiveTasks: async () => [task({ id: "audit", status: "running", preparation: {
        stage: "using_tools", research: initial, taskRunId: "run-1", updatedAt: "2026-09-09T00:00:00Z",
      } })],
    });
    await store.seed("mount");
    const current = () => store.getSnapshot().runningSubagentsMap["audit"]?.researchProgress;
    expect(current()).toEqual(initial);
    const event = { type: "task.progress" as const, taskId: "audit", taskRunId: "run-1", ownerId: "owner", detail: "Review notes saved" };
    const updated = { ...initial, unitsCompleted: 5, unitsPending: 10 };
    store.applyWsEvent({ ...event, preparation: { stage: "using_tools", research: updated } });
    expect(current()).toEqual(updated);
    store.applyWsEvent({ ...event, taskRunId: "stale", preparation: { stage: "using_tools", research: initial } });
    expect(current()).toEqual(updated);
    store.applyWsEvent({ ...event, preparation: { stage: "waiting_model" } });
    expect(current()).toEqual(updated);
    store.applyWsEvent({ ...event, preparation: { stage: "using_tools", research: { ...initial, unitsCompleted: 80 } } });
    expect(current()).toEqual(updated);
    store.applyWsEvent({ type: "task.fired", taskId: "audit", taskRunId: "run-2", ownerId: "owner" });
    expect(current()).toBeNull();
    store.applyWsEvent({ ...event, preparation: { stage: "using_tools", research: updated } });
    expect(current()).toBeNull();
    store.clearForViewerChange();
  });

  test("task.progress updates line3 and retains a bounded, de-duplicated live feed", async () => {
    const store = createTaskStateStore({
      listActiveTasks: async () => [task({ id: "run-1", status: "running" })],
    });
    await store.seed("mount");

    store.applyWsEvent({
      type: "task.progress",
      taskId: "run-1",
      taskRunId: "run-1",
      detail: "run_shell: ls",
      ownerId: "owner",
    });
    store.applyWsEvent({
      type: "task.progress",
      taskId: "run-1",
      taskRunId: "run-1",
      detail: "run_shell: ls",
      ownerId: "owner",
    });
    store.applyWsEvent({
      type: "task.progress",
      taskId: "run-1",
      taskRunId: "run-1",
      detail: "apply_patch: 2 files",
      ownerId: "owner",
    });

    expect(store.getSnapshot().runningSubagentsMap["run-1"]).toMatchObject({
      line3: "apply_patch: 2 files",
      recentActivity: ["run_shell: ls", "apply_patch: 2 files"],
    });
  });

  test("accumulates assistant response chunks continuously in one activity", async () => {
    const store = createTaskStateStore({
      listActiveTasks: async () => [task({ id: "run-1", status: "running" })],
    });
    await store.seed("mount");

    for (const [result, startedAt] of [["Hello ", 1], ["world", 2]] as const) {
      store.applyWsEvent({
        type: "task.progress",
        taskId: "run-1",
        taskRunId: "run-1",
        detail: "Writing response",
        activity: {
          id: "codex-item-1",
          kind: "status",
          name: "assistant_response",
          status: "running",
          args: {},
          result,
          appendResult: true,
          appendResultSeparator: "",
          startedAt,
        },
        ownerId: "owner",
      });
    }

    expect(store.getSnapshot().runningSubagentsMap["run-1"]).toMatchObject({
      line3: "Writing response",
      harnessActivity: [{
        id: "codex-item-1",
        result: "Hello world",
        startedAt: 1,
      }],
    });
  });
});


describe("verified research failure recovery", () => {
  test("reload retains only eligible errored cards beyond terminal linger", async () => {
    const store = createTaskStateStore({ listActiveTasks: async () => [
      task({ status: "errored", canResumeResearch: true }),
      task({ id: "ordinary-error", status: "errored" }),
      task({ id: "done", status: "completed", canResumeResearch: true }),
    ] });
    await store.seed("mount");
    store.flushLingerTimersForTests();
    expect(Object.keys(store.getSnapshot().runningSubagentsMap)).toEqual(["task-1"]);
    expect(store.getSnapshot().runningSubagentsMap["task-1"]?.canResumeResearch).toBe(true);
  });

  test("an error event discovers eligibility and Resume discards a late pre-action list", async () => {
    const stale = deferred<TaskSummary[]>();
    let calls = 0;
    const store = createTaskStateStore({
      listActiveTasks: async () => {
        calls += 1;
        if (calls === 1) return [task()];
        if (calls === 2) return [task({ status: "errored", canResumeResearch: true })];
        if (calls === 3) return stale.promise;
        return [task({ status: "running" })];
      },
      lifecycle: { pauseTask: async () => undefined, stopTask: async () => undefined,
        unpauseTask: async () => undefined },
    });
    await store.seed("mount");
    store.applyWsEvent({ type: "task.errored", taskId: "task-1", taskRunId: "same-run", status: "errored", error: "no_progress" });
    await store.refresh();
    store.flushLingerTimersForTests();
    expect(store.getSnapshot().runningSubagentsMap["task-1"]?.canResumeResearch).toBe(true);
    const oldRefresh = store.refresh();
    const resumed = store.unpauseTask("task-1");
    stale.resolve([task({ status: "errored", canResumeResearch: true })]);
    await Promise.all([oldRefresh, resumed]);
    expect(calls).toBe(4);
    expect(store.getSnapshot().runningSubagentsMap["task-1"]?.status).toBe("running");
    expect(store.getSnapshot().runningSubagentsMap["task-1"]?.canResumeResearch).toBeUndefined();
    store.flushLingerTimersForTests();
    expect(store.getSnapshot().runningSubagentsMap["task-1"]?.status).toBe("running");
  });
});


test("an error waits out a pre-error list before discovering owner recovery", async () => {
  const stale = deferred<TaskSummary[]>();
  const requestedAfterError = deferred<void>();
  let calls = 0;
  const store = createTaskStateStore({ listActiveTasks: async () => {
    calls += 1;
    if (calls === 1) return [task()];
    if (calls === 2) return stale.promise;
    requestedAfterError.resolve();
    return [task({ status: "errored", canResumeResearch: true })];
  } });
  await store.seed("mount");
  const beforeError = store.refresh();
  store.applyWsEvent({ type: "task.errored", taskId: "task-1", taskRunId: "same-run", status: "errored", error: "no_progress" });
  stale.resolve([task()]);
  await beforeError;
  await requestedAfterError.promise;
  await store.refresh();
  expect(store.getSnapshot().runningSubagentsMap["task-1"]?.canResumeResearch).toBe(true);
  store.flushLingerTimersForTests();
  expect(store.getSnapshot().runningSubagentsMap["task-1"]?.status).toBe("errored");
});
