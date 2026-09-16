/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { ServerEvent, TaskSummary } from "@nautilo/types";

import {
  createTaskWorkController,
  selectTaskWork,
  taskWorkViewState,
  type TaskWorkApi,
} from "./task-work-state";
import { projectTaskWorkStrip } from "./task-work-strip-presentation";
import {
  TASK_WORK_FIXTURE_NOW as now,
  taskWorkFixture as task,
  taskWorkScopeA as scopeA,
  taskWorkScopeARelogin as scopeARelogin,
  taskWorkScopeB as scopeB,
} from "./task-work-lifecycle-fixtures";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function taskEvent(event: Record<string, unknown>): ServerEvent {
  return event as ServerEvent;
}

describe("Task work selectors", () => {
  test("uses shared lifecycle order, server hierarchy, and only exact progress", () => {
    const exact = 'run_shell: rg "delegated"';
    const selectors = selectTaskWork([
      task({ id: "paused", status: "paused", createdAt: "2026-08-21T10:00:00.000Z" }),
      task({ id: "child", parentTaskId: "parent", depth: 1, status: "running", createdAt: "2026-08-21T09:00:00.000Z" }),
      task({ id: "awaiting", status: "awaiting", createdAt: "2026-08-21T11:00:00.000Z" }),
      task({ id: "error", status: "errored", createdAt: "2026-08-21T11:30:00.000Z", updatedAt: "2026-08-21T11:59:57.000Z" }),
    ], { child: { progress: exact } }, now);

    expect(selectors.actionNeeded.map((row) => row.taskId)).toEqual(["awaiting", "error"]);
    expect(selectors.active.map((row) => row.taskId)).toEqual(["child"]);
    expect(selectors.paused.map((row) => row.taskId)).toEqual(["paused"]);
    expect(selectors.active[0]).toMatchObject({ parentTaskId: "parent", depth: 1, activity: exact });
    expect(selectors.actionNeeded[0]?.activity).toBe("Needs attention");
    expect(selectors.actionNeeded[1]?.activity).toBe("Failed");
    expect(selectors.topRows.map((row) => row.taskId)).toEqual(["awaiting", "error", "child"]);
  });

  test("keeps bounded terminal history for overview but lets the strip become quiet after shared linger", () => {
    const terminal = task({
      id: "done",
      status: "completed",
      updatedAt: "2026-08-21T11:59:56.000Z",
    });
    const recent = selectTaskWork([terminal], {}, now);
    expect(recent.terminalHistory.map((row) => row.taskId)).toEqual(["done"]);
    expect(recent.newlyCompleted.map((row) => row.taskId)).toEqual(["done"]);
    expect(recent.quiet).toBeFalse();

    const atBoundary = selectTaskWork([terminal], {}, now + 999);
    expect(atBoundary.newlyCompleted.map((row) => row.taskId)).toEqual(["done"]);
    const expired = selectTaskWork([terminal], {}, now + 1_000);
    expect(expired.terminalHistory.map((row) => row.taskId)).toEqual(["done"]);
    expect(expired.newlyCompleted).toEqual([]);
    expect(expired.quiet).toBeTrue();
  });

  test("never makes pending work or invalid terminal time keep a quiet strip alive", () => {
    const selectors = selectTaskWork([
      task({ id: "pending", status: "pending" }),
      task({ id: "invalid-terminal", status: "completed", updatedAt: "not a timestamp" }),
    ], {}, now);
    expect(selectors.terminalHistory.map((row) => row.taskId)).toEqual(["invalid-terminal"]);
    expect(selectors.topRows).toEqual([]);
    expect(selectors.quiet).toBeTrue();
  });

  test("keeps paused and old errors in overview without leaving a strip or duplicating a fresh error", () => {
    const oldError = task({ id: "old-error", status: "errored", updatedAt: "2026-08-21T11:59:55.000Z" });
    const paused = task({ id: "paused", status: "paused" });
    const old = selectTaskWork([oldError, paused], {}, now);
    expect(old.actionNeeded).toEqual([]);
    expect(old.paused.map((row) => row.taskId)).toEqual(["paused"]);
    expect(old.terminalHistory.map((row) => row.taskId)).toEqual(["old-error"]);
    expect(old.quiet).toBeTrue();

    const freshError = task({ id: "fresh-error", status: "errored", updatedAt: "2026-08-21T11:59:56.000Z" });
    const fresh = selectTaskWork([freshError], {}, now);
    expect(fresh.actionNeeded.map((row) => row.taskId)).toEqual(["fresh-error"]);
    expect(fresh.topRows.map((row) => row.taskId)).toEqual(["fresh-error"]);
  });

  test("does not let a stale running overlay resurrect canonical completion", () => {
    const selectors = selectTaskWork([
      task({ id: "completed", status: "completed", updatedAt: "2026-08-21T11:59:58.000Z" }),
    ], { completed: { status: "running", progress: "old progress", terminalAtMs: 0 } }, now);
    expect(selectors.terminalHistory[0]).toMatchObject({ status: "done", activity: "Done", terminalAtMs: now - 2_000 });
    expect(selectors.active).toEqual([]);
  });

  test("uses a matching terminal receipt for linger but never its stale progress", () => {
    const selectors = selectTaskWork([
      task({ id: "error", status: "pending", updatedAt: "2026-08-21T11:00:00.000Z" }),
    ], { error: { status: "errored", progress: "stale output", terminalAtMs: now - 100 } }, now);
    expect(selectors.terminalHistory[0]).toMatchObject({
      status: "errored",
      terminalAtMs: now - 100,
      activity: "Failed",
    });
  });

  test("rejects a terminal overlay receipt when it does not match canonical terminal state", () => {
    const selectors = selectTaskWork([
      task({ id: "done", status: "completed", updatedAt: "2026-08-21T11:59:58.000Z" }),
    ], { done: { status: "errored", terminalAtMs: now - 100 } }, now);
    expect(selectors.terminalHistory[0]).toMatchObject({ status: "done", terminalAtMs: now - 2_000 });
  });
});

describe("Task work controller", () => {
  test("makes old viewer, server, logout, and same-ID re-login completions inert", async () => {
    const controller = createTaskWorkController();
    const old = deferred<TaskSummary[]>();
    const api: TaskWorkApi = {
      list(scope) {
        if (scope.serverId === "server-a" && scope.viewerEpoch === 1) return old.promise;
        return Promise.resolve([task({ id: `fresh-${scope.serverId}-${scope.viewerEpoch}` })]);
      },
    };

    controller.setScope(scopeA);
    const stale = controller.load(api);
    controller.setScope(null);
    controller.setScope(scopeARelogin);
    const relogin = controller.load(api);
    old.resolve([task({ id: "old-owner-work" })]);
    expect(await stale).toEqual({ status: "ignored" });
    expect(await relogin).toEqual({ status: "applied", data: [task({ id: "fresh-server-a-2" })] });
    expect(controller.getState().tasks.map((row) => row.id)).toEqual(["fresh-server-a-2"]);

    controller.setScope(scopeB);
    await controller.load(api);
    expect(controller.getState().tasks.map((row) => row.id)).toEqual(["fresh-server-b-1"]);

    controller.dispose();
    expect(controller.getState().tasks).toEqual([]);
  });

  test("synchronously fences a prior viewer snapshot before its scope-clearing effect runs", async () => {
    const controller = createTaskWorkController();
    controller.setScope(scopeA);
    await controller.load({ list: async () => [task({ id: "same-task", agentName: "Old Genie" })] });
    controller.applyRealtimeEvent(taskEvent({
      type: "task.progress",
      taskId: "same-task",
      taskRunId: "old-run",
      detail: "old exact progress",
      ownerId: scopeA.userId,
    }), { list: async () => [] });
    const oldSnapshot = controller.getState();

    for (const nextScope of [scopeARelogin, scopeB]) {
      const fenced = taskWorkViewState(oldSnapshot, nextScope, now);
      expect(fenced.kind).toBe("loading");
      expect(fenced.selectors).toMatchObject({ quiet: true, topRows: [], overviewRows: [] });
      expect(projectTaskWorkStrip(fenced)).toBeNull();
    }
  });

  test("does not let an ignored old-scope reconcile erase a newer scope's unknown exact progress", async () => {
    const controller = createTaskWorkController();
    const oldReconcile = deferred<TaskSummary[]>();
    const newScopeRepair = deferred<TaskSummary[]>();
    const calls = { a: 0, b: 0 };
    const api: TaskWorkApi = {
      list(scope) {
        calls[scope.serverId === "server-a" ? "a" : "b"] += 1;
        if (scope.serverId === "server-a") {
          return calls.a === 1 ? Promise.resolve([task({ id: "a-task" })]) : oldReconcile.promise;
        }
        return calls.b === 1 ? Promise.resolve([task({ id: "b-task" })]) : newScopeRepair.promise;
      },
    };
    controller.setScope(scopeA);
    await controller.load(api);
    const staleA = controller.reconcile(api);

    controller.setScope(scopeB);
    await controller.load(api);
    controller.applyRealtimeEvent(taskEvent({
      type: "task.fired",
      taskId: "b-unknown",
      taskRunId: "run-b",
      laneKey: "task:b-unknown",
      ownerId: scopeB.userId,
    }), api);
    controller.applyRealtimeEvent(taskEvent({
      type: "task.progress",
      taskId: "b-unknown",
      taskRunId: "run-b",
      detail: "exact B progress",
      ownerId: scopeB.userId,
    }), api);
    expect(controller.getState().overlays["b-unknown"]?.progress).toBe("exact B progress");

    oldReconcile.resolve([]);
    expect(await staleA).toEqual({ status: "ignored" });
    expect(controller.getState().overlays["b-unknown"]?.progress).toBe("exact B progress");

    newScopeRepair.resolve([task({ id: "b-task" }), task({ id: "b-unknown" })]);
    await Promise.resolve();
    await Promise.resolve();
    expect(selectTaskWork(controller.getState().tasks, controller.getState().overlays, now).active
      .find((row) => row.taskId === "b-unknown")?.activity).toBe("exact B progress");
  });

  test("captures reconcile generation before a re-entrant scope round-trip inside list", async () => {
    const controller = createTaskWorkController();
    const oldReconcile = deferred<TaskSummary[]>();
    const currentScopeRepair = deferred<TaskSummary[]>();
    let calls = 0;
    const api: TaskWorkApi = {
      list(scope) {
        calls += 1;
        if (calls === 1) return Promise.resolve([task()]);
        if (calls === 2) {
          controller.setScope(scopeB);
          controller.setScope(scope);
          controller.applyRealtimeEvent(taskEvent({
            type: "task.progress",
            taskId: "current-unknown",
            taskRunId: "current-run",
            detail: "current exact progress",
            ownerId: scope.userId,
          }), api);
          return oldReconcile.promise;
        }
        return currentScopeRepair.promise;
      },
    };
    controller.setScope(scopeA);
    await controller.load(api);
    const stale = controller.reconcile(api);
    expect(controller.getState().overlays["current-unknown"]?.progress).toBe("current exact progress");

    oldReconcile.resolve([]);
    expect(await stale).toEqual({ status: "ignored" });
    expect(controller.getState().overlays["current-unknown"]?.progress).toBe("current exact progress");

    currentScopeRepair.resolve([task({ id: "current-unknown" })]);
    await Promise.resolve();
    await Promise.resolve();
    expect(selectTaskWork(controller.getState().tasks, controller.getState().overlays, now).active[0]?.activity)
      .toBe("current exact progress");
  });

  test("does not carry a queued old-scope boundary refresh into a new scope repair", async () => {
    const controller = createTaskWorkController();
    const oldRepair = deferred<TaskSummary[]>();
    const calls = { a: 0, b: 0 };
    const api: TaskWorkApi = {
      list(scope) {
        calls[scope.serverId === "server-a" ? "a" : "b"] += 1;
        if (scope.serverId === "server-a") {
          return calls.a === 1 ? Promise.resolve([task({ id: "a-task" })]) : oldRepair.promise;
        }
        return Promise.resolve([task({ id: "b-task" })]);
      },
    };
    controller.setScope(scopeA);
    await controller.load(api);
    void controller.reconcile(api);
    void controller.reconcile(api, { resetLive: true });

    controller.setScope(scopeB);
    await controller.load(api);
    controller.applyRealtimeEvent(taskEvent({
      type: "task.fired",
      taskId: "b-unknown",
      taskRunId: "run-b",
      laneKey: "task:b-unknown",
      ownerId: scopeB.userId,
    }), api);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.b).toBe(2);

    oldRepair.resolve([]);
  });

  test("reports loading, empty, unsupported, and recoverable errors explicitly", async () => {
    const controller = createTaskWorkController();
    controller.setScope(scopeA);
    const pending = deferred<TaskSummary[]>();
    const loading = controller.load({ list: () => pending.promise });
    expect(controller.getState().kind).toBe("loading");
    pending.resolve([]);
    await loading;
    expect(taskWorkViewState(controller.getState(), scopeA, now).kind).toBe("empty");

    const unsupported = Object.assign(new Error("not implemented"), { status: 501 });
    await controller.retry({ list: async () => { throw unsupported; } });
    expect(taskWorkViewState(controller.getState(), scopeA, now).kind).toBe("unsupported");

    await controller.retry({ list: async () => { throw new Error("offline"); } });
    const failed = taskWorkViewState(controller.getState(), scopeA, now);
    expect(failed.kind).toBe("error");
    if (failed.kind === "error") expect(failed.error.message).toBe("offline");
  });

  test("keeps a quiet paused/history overview ready rather than calling its dataset empty", async () => {
    const controller = createTaskWorkController();
    controller.setScope(scopeA);
    await controller.load({ list: async () => [
      task({ id: "paused", status: "paused" }),
      task({ id: "old-done", status: "completed", updatedAt: "2026-08-21T11:59:55.000Z" }),
    ] });
    const view = taskWorkViewState(controller.getState(), scopeA, now);
    expect(view.kind).toBe("ready");
    expect(view.selectors.quiet).toBeTrue();
    expect(view.selectors.overviewRows.map((row) => row.taskId)).toEqual(["paused", "old-done"]);
  });

  test("does not let dispose or an older retry commit", async () => {
    const controller = createTaskWorkController();
    const first = deferred<TaskSummary[]>();
    const second = deferred<TaskSummary[]>();
    let calls = 0;
    const api: TaskWorkApi = { list: () => (++calls === 1 ? first.promise : second.promise) };
    controller.setScope(scopeA);
    const oldRetry = controller.load(api);
    const newRetry = controller.retry(api);
    first.resolve([task({ id: "old" })]);
    expect(await oldRetry).toEqual({ status: "ignored" });
    controller.dispose();
    second.resolve([task({ id: "new" })]);
    expect(await newRetry).toEqual({ status: "ignored" });
    expect(controller.getState().tasks).toEqual([]);
  });

  test("capability loss clears custody and makes an in-flight list response inert", async () => {
    const controller = createTaskWorkController();
    const pending = deferred<TaskSummary[]>();
    controller.setScope(scopeA);
    const loading = controller.load({ list: () => pending.promise });
    // The hook represents revoked Task capability with this null scope.
    controller.setScope(null);
    pending.resolve([task({ id: "must-not-return" })]);
    expect(await loading).toEqual({ status: "ignored" });
    expect(controller.getState()).toMatchObject({ kind: "idle", scope: null, tasks: [] });
    expect(taskWorkViewState(controller.getState(), null, now).kind).toBe("idle");
  });

  test("fences Task runs, latches terminal work, and keeps only exact progress", async () => {
    let currentNow = now;
    const controller = createTaskWorkController({ now: () => currentNow });
    const api: TaskWorkApi = { list: async () => [task()] };
    controller.setScope(scopeA);
    await controller.load(api);

    controller.applyRealtimeEvent(taskEvent({ type: "task.fired", taskId: "task-1", taskRunId: "run-1", laneKey: "task:task-1", ownerId: "owner-a" }), api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.progress", taskId: "task-1", taskRunId: "run-1", detail: "run_shell: rg D547", ownerId: "owner-a" }), api);
    expect(selectTaskWork(controller.getState().tasks, controller.getState().overlays, currentNow).active[0]?.activity).toBe("run_shell: rg D547");

    controller.applyRealtimeEvent(taskEvent({ type: "task.completed", taskId: "task-1", taskRunId: "run-1", status: "completed", ownerId: "owner-a" }), api);
    currentNow += 1;
    controller.applyRealtimeEvent(taskEvent({ type: "task.progress", taskId: "task-1", taskRunId: "run-1", detail: "late output", ownerId: "owner-a" }), api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.fired", taskId: "task-1", taskRunId: "run-1", laneKey: "task:task-1", ownerId: "owner-a" }), api);
    const terminal = selectTaskWork(controller.getState().tasks, controller.getState().overlays, currentNow);
    expect(terminal.active).toEqual([]);
    expect(terminal.newlyCompleted[0]).toMatchObject({ taskId: "task-1", activity: "Done" });

    controller.applyRealtimeEvent(taskEvent({ type: "task.fired", taskId: "task-1", taskRunId: "run-2", laneKey: "task:task-1", ownerId: "owner-a" }), api);
    const restarted = selectTaskWork(controller.getState().tasks, controller.getState().overlays, currentNow);
    expect(restarted.active[0]).toMatchObject({ taskId: "task-1", activity: "Working…" });
  });

  test("dedupes unknown Task repairs and preserves fresh events while the repair is in flight", async () => {
    const controller = createTaskWorkController();
    const repair = deferred<TaskSummary[]>();
    let listCalls = 0;
    const api: TaskWorkApi = {
      list: () => ++listCalls === 1 ? Promise.resolve([task()]) : repair.promise,
    };
    controller.setScope(scopeA);
    await controller.load(api);

    const unknown = taskEvent({ type: "task.fired", taskId: "new-task", taskRunId: "run-new", laneKey: "task:new-task", ownerId: "owner-a" });
    controller.applyRealtimeEvent(unknown, api);
    controller.applyRealtimeEvent(unknown, api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.progress", taskId: "task-1", taskRunId: "run-known", detail: "exact and fresh", ownerId: "owner-a" }), api);
    expect(listCalls).toBe(2);
    repair.resolve([task(), task({ id: "new-task", status: "running" })]);
    await Promise.resolve();
    await Promise.resolve();
    const selectors = selectTaskWork(controller.getState().tasks, controller.getState().overlays, now);
    expect(selectors.active.find((row) => row.taskId === "task-1")?.activity).toBe("exact and fresh");
    expect(selectors.active.find((row) => row.taskId === "new-task")?.status).toBe("running");
  });

  test("a stale terminal list response cannot suppress a newer fired run or its exact progress", async () => {
    const controller = createTaskWorkController();
    const staleRepair = deferred<TaskSummary[]>();
    let calls = 0;
    const api: TaskWorkApi = {
      list: () => ++calls === 1
        ? Promise.resolve([task({ status: "completed", updatedAt: "2026-08-21T11:59:59.000Z" })])
        : staleRepair.promise,
    };
    controller.setScope(scopeA);
    await controller.load(api);
    const repair = controller.reconcile(api, { resetLive: true });
    controller.applyRealtimeEvent(taskEvent({ type: "task.fired", taskId: "task-1", taskRunId: "run-2", laneKey: "task:task-1", ownerId: "owner-a" }), api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.progress", taskId: "task-1", taskRunId: "run-2", detail: "run_shell: fresh", ownerId: "owner-a" }), api);
    staleRepair.resolve([task({ status: "completed", updatedAt: "2026-08-21T11:59:59.000Z" })]);
    await repair;

    const selectors = selectTaskWork(controller.getState().tasks, controller.getState().overlays, now);
    expect(selectors.active[0]).toMatchObject({ taskId: "task-1", activity: "run_shell: fresh" });
    expect(selectors.terminalHistory).toEqual([]);
  });

  test("a newly-known Task fired after a request starts wins that response's stale terminal status", async () => {
    const controller = createTaskWorkController();
    const staleRepair = deferred<TaskSummary[]>();
    let calls = 0;
    const api: TaskWorkApi = {
      list: () => ++calls === 1 ? Promise.resolve([task()]) : staleRepair.promise,
    };
    controller.setScope(scopeA);
    await controller.load(api);
    const repair = controller.reconcile(api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.fired", taskId: "new-task", taskRunId: "run-new", laneKey: "task:new-task", ownerId: "owner-a" }), api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.progress", taskId: "new-task", taskRunId: "run-new", detail: "fresh unknown", ownerId: "owner-a" }), api);
    staleRepair.resolve([task(), task({ id: "new-task", status: "completed", updatedAt: "2026-08-21T11:59:59.000Z" })]);
    await repair;
    expect(selectTaskWork(controller.getState().tasks, controller.getState().overlays, now).active
      .find((row) => row.taskId === "new-task")).toMatchObject({ activity: "fresh unknown" });
  });

  test("late old-run terminal, progress, and unqualified status cannot overwrite the fresh run", async () => {
    const controller = createTaskWorkController();
    const api: TaskWorkApi = { list: async () => [task()] };
    controller.setScope(scopeA);
    await controller.load(api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.fired", taskId: "task-1", taskRunId: "run-1", laneKey: "task:task-1", ownerId: "owner-a" }), api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.completed", taskId: "task-1", taskRunId: "run-1", status: "completed", ownerId: "owner-a" }), api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.fired", taskId: "task-1", taskRunId: "run-2", laneKey: "task:task-1", ownerId: "owner-a" }), api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.errored", taskId: "task-1", taskRunId: "run-1", status: "errored", ownerId: "owner-a" }), api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.progress", taskId: "task-1", taskRunId: "run-1", detail: "old", ownerId: "owner-a" }), api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.status", taskId: "task-1", status: "paused", ownerId: "owner-a" }), api);
    const selectors = selectTaskWork(controller.getState().tasks, controller.getState().overlays, now);
    expect(selectors.active[0]).toMatchObject({ taskId: "task-1", activity: "Working…" });
    expect(selectors.paused).toEqual([]);
  });

  test("a delayed first fire cannot take custody back from a newer active run", async () => {
    const controller = createTaskWorkController();
    const api: TaskWorkApi = { list: async () => [task()] };
    controller.setScope(scopeA);
    await controller.load(api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.fired", taskId: "task-1", taskRunId: "run-1", laneKey: "task:task-1", ownerId: "owner-a" }), api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.fired", taskId: "task-1", taskRunId: "run-2", laneKey: "task:task-1", ownerId: "owner-a" }), api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.fired", taskId: "task-1", taskRunId: "run-1", laneKey: "task:task-1", ownerId: "owner-a" }), api);
    expect(controller.getState().overlays["task-1"]?.taskRunId).toBe("run-2");
  });

  test("reconciles an unqualified live pause canonically without letting it overwrite the current run locally", async () => {
    const controller = createTaskWorkController();
    let calls = 0;
    const api: TaskWorkApi = {
      list: async () => ++calls === 1 ? [task()] : [task({ status: "paused" })],
    };
    controller.setScope(scopeA);
    await controller.load(api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.fired", taskId: "task-1", taskRunId: "run-1", laneKey: "task:task-1", ownerId: "owner-a" }), api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.status", taskId: "task-1", status: "paused", ownerId: "owner-a" }), api);
    await Promise.resolve();
    await Promise.resolve();
    expect(selectTaskWork(controller.getState().tasks, controller.getState().overlays, now).paused[0]?.taskId).toBe("task-1");
  });

  test("a cron terminal latch still reconciles a later unqualified pause", async () => {
    const controller = createTaskWorkController();
    let calls = 0;
    const api: TaskWorkApi = {
      list: async () => ++calls === 1 ? [task()] : [task({ status: "paused" })],
    };
    controller.setScope(scopeA);
    await controller.load(api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.fired", taskId: "task-1", taskRunId: "cron-run", laneKey: "task:task-1", ownerId: "owner-a" }), api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.completed", taskId: "task-1", taskRunId: "cron-run", status: "pending", ownerId: "owner-a" }), api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.status", taskId: "task-1", status: "paused", ownerId: "owner-a" }), api);
    await Promise.resolve();
    await Promise.resolve();
    expect(selectTaskWork(controller.getState().tasks, controller.getState().overlays, now).paused[0]?.taskId).toBe("task-1");
  });

  test("an unknown miss cools down but a later event starts one new bounded repair", async () => {
    let currentNow = 1_000;
    const controller = createTaskWorkController({ now: () => currentNow });
    let calls = 0;
    const api: TaskWorkApi = { list: async () => { calls += 1; return calls === 1 ? [task()] : []; } };
    controller.setScope(scopeA);
    await controller.load(api);
    const event = () => controller.applyRealtimeEvent(taskEvent({ type: "task.fired", taskId: "missing", taskRunId: `run-${calls}`, laneKey: "task:missing", ownerId: "owner-a" }), api);
    event();
    await controller.reconcile(api);
    expect(calls).toBe(2);
    event();
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(controller.getState().overlays.missing).toBeUndefined();
    currentNow += 1_000;
    event();
    await controller.reconcile(api);
    expect(calls).toBe(3);
  });

  test("continuous unknown events receive one trailing repair then cool down and release their overlay", async () => {
    const controller = createTaskWorkController();
    const firstMiss = deferred<TaskSummary[]>();
    const trailingMiss = deferred<TaskSummary[]>();
    let calls = 0;
    const api: TaskWorkApi = {
      list: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve([task()]);
        if (calls === 2) return firstMiss.promise;
        return trailingMiss.promise;
      },
    };
    const fire = (run: string) => controller.applyRealtimeEvent(taskEvent({ type: "task.fired", taskId: "missing", taskRunId: run, laneKey: "task:missing", ownerId: "owner-a" }), api);
    controller.setScope(scopeA);
    await controller.load(api);
    fire("run-1");
    fire("run-2");
    firstMiss.resolve([]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(3);
    fire("run-3");
    trailingMiss.resolve([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(3);
    expect(controller.getState().overlays.missing).toBeUndefined();
  });

  test("drops provisional progress at repair boundaries and emits at the terminal linger expiry", async () => {
    let currentNow = now;
    const scheduled: { callback: (() => void) | null } = { callback: null };
    let scheduledDelay = -1;
    const controller = createTaskWorkController({
      now: () => currentNow,
      schedule: (callback, delayMs) => {
        scheduled.callback = callback;
        scheduledDelay = delayMs;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearSchedule: () => {},
    });
    const api: TaskWorkApi = { list: async () => [task()] };
    controller.setScope(scopeA);
    await controller.load(api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.progress", taskId: "task-1", taskRunId: "run-1", detail: "exact", ownerId: "owner-a" }), api);
    controller.discardProvisionalProgress();
    expect(selectTaskWork(controller.getState().tasks, controller.getState().overlays, currentNow).active[0]?.activity).toBe("Working…");

    let emissions = 0;
    controller.subscribe(() => { emissions += 1; });
    controller.applyRealtimeEvent(taskEvent({ type: "task.errored", taskId: "task-1", taskRunId: "run-1", status: "errored", ownerId: "owner-a" }), api);
    expect(scheduledDelay).toBe(5_000);
    const beforeExpiry = controller.getState();
    currentNow += 5_000;
    expect(scheduled.callback).not.toBeNull();
    scheduled.callback?.();
    expect(emissions).toBeGreaterThanOrEqual(2);
    expect(controller.getState()).not.toBe(beforeExpiry);
    expect(selectTaskWork(controller.getState().tasks, controller.getState().overlays, currentNow).quiet).toBeTrue();
  });

  test("a recent canonical terminal schedules the same finite expiry boundary", async () => {
    let currentNow = now;
    const scheduled: { callback: (() => void) | null; delay: number } = { callback: null, delay: -1 };
    const controller = createTaskWorkController({
      now: () => currentNow,
      schedule: (callback, delayMs) => {
        scheduled.callback = callback;
        scheduled.delay = delayMs;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearSchedule: () => {},
    });
    controller.setScope(scopeA);
    await controller.load({ list: async () => [task({ status: "completed", updatedAt: "2026-08-21T11:59:59.999Z" })] });
    expect(scheduled.delay).toBe(4_999);
    expect(selectTaskWork(controller.getState().tasks, controller.getState().overlays, currentNow).quiet).toBeFalse();
    const beforeExpiry = controller.getState();
    currentNow += 4_999;
    scheduled.callback?.();
    expect(controller.getState()).not.toBe(beforeExpiry);
    expect(selectTaskWork(controller.getState().tasks, controller.getState().overlays, currentNow).quiet).toBeTrue();
  });

  test("rejects cross-owner events before they can refresh or alter the current owner", async () => {
    const controller = createTaskWorkController();
    let listCalls = 0;
    const api: TaskWorkApi = { list: async () => { listCalls += 1; return [task()]; } };
    controller.setScope(scopeA);
    await controller.load(api);
    controller.applyRealtimeEvent(taskEvent({ type: "task.progress", taskId: "task-1", taskRunId: "run-1", detail: "private", ownerId: "owner-b" }), api);
    expect(listCalls).toBe(1);
    expect(selectTaskWork(controller.getState().tasks, controller.getState().overlays, now).active[0]?.activity).toBe("Working…");
  });
});
