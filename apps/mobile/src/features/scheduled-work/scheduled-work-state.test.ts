/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { TaskDetail, TaskSummary } from "@nautilo/types";

import type { SettingsDataScope } from "@/features/settings/settings-data-state";
import {
  canResumeScheduledWork,
  createScheduledWorkController,
  scheduleCadence,
  scheduleNextFire,
  scheduledWorkFailure,
  scheduledWorkRows,
  type ScheduledWorkApi,
} from "./scheduled-work-state";

const scopeA: SettingsDataScope = { serverId: "server-a", userId: "owner-a", actorId: "actor-a" };
const scopeB: SettingsDataScope = { serverId: "server-b", userId: "owner-b", actorId: "actor-b" };
const scopeSameServerOtherViewer: SettingsDataScope = { serverId: "server-a", userId: "owner-b", actorId: "actor-b" };

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "schedule-1", parentTaskId: null, depth: 0, status: "pending", preset: "schedule", prompt: "Check the inbox",
    scheduleKind: "cron", cron: "0 9 * * *", nextFireAt: "2026-08-10T09:00:00.000Z",
    callingRoomId: "room-1", targetRoomId: "room-1", lastError: null, ...overrides,
  };
}

function detail(row = task()): TaskDetail {
  return {
    task: {
      ...row, expectedOutput: null, cron: row.cron ?? null, runAt: null, timezone: "UTC",
      targetChat: "last_in_namespace", resultDelivery: "wake", useScope: false, scopeId: null,
      toolsMode: "all", toolsWhitelist: [],
      selectionProfile: "balanced", selectionSpec: null, requestedModelId: null,
      createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
    }, runs: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("scheduled work presentation", () => {
  test("shows only schedules, sorted by the server's next fire", () => {
    expect(scheduledWorkRows([
      task({ id: "late", nextFireAt: "2026-08-12T09:00:00.000Z" }),
      task({ id: "now-task", scheduleKind: "now" }),
      task({ id: "early", nextFireAt: "2026-08-10T08:00:00.000Z" }),
      task({ id: "never", nextFireAt: null }),
    ]).map((row) => row.id)).toEqual(["early", "late", "never"]);
    expect(scheduleCadence(task({ scheduleKind: "one_shot", cron: null }))).toBe("Once");
    expect(scheduleNextFire("2026-08-10T09:00:00.000Z", new Date("2026-08-10T08:30:00.000Z"))).toBe("In 30 min");
  });

  test("maps direct auth and authorization failures to actionable scheduled-work states", () => {
    expect(scheduledWorkFailure(Object.assign(new Error("expired"), { status: 401 }))).toEqual({ kind: "signed-out" });
    expect(scheduledWorkFailure(Object.assign(new Error("forbidden"), { status: 403 }))).toEqual({
      kind: "unavailable",
      message: "This schedule changed on the server. Reload to continue.",
    });
  });

  test("offers resume only for a paused schedule and an invocation-capable Human", () => {
    expect(canResumeScheduledWork("paused", true)).toBe(true);
    expect(canResumeScheduledWork("paused", false)).toBe(false);
    expect(canResumeScheduledWork("pending", true)).toBe(false);
  });
});

describe("scheduled work controller", () => {
  test("uses owner-scoped canonical list and lifecycle endpoints, then reloads", async () => {
    const controller = createScheduledWorkController();
    const calls: string[] = [];
    let listed = false;
    const api: ScheduledWorkApi = {
      async list(scope) { calls.push(`list:${scope.serverId}`); return listed ? [task({ status: "paused" })] : [task()]; },
      async detail(scope, id) { calls.push(`detail:${scope.serverId}:${id}`); return detail(); },
      async pause(scope, id) { calls.push(`pause:${scope.serverId}:${id}`); listed = true; },
      async resume() {}, async stop() {},
    };
    controller.setScope(scopeA);
    await controller.load(api);
    expect((await controller.pause("schedule-1", api)).status).toBe("applied");
    expect(controller.getState().data?.[0]?.status).toBe("paused");
    expect(calls).toEqual(["list:server-a", "pause:server-a:schedule-1", "list:server-a"]);
  });

  test("does not mutate stale, foreign, or wrong-status rows", async () => {
    const controller = createScheduledWorkController();
    let calls = 0;
    const api: ScheduledWorkApi = {
      async list() { return [task({ id: "paused", status: "paused" }), task({ id: "now", scheduleKind: "now" })]; },
      async detail() { return detail(); },
      async pause() { calls += 1; }, async resume() { calls += 1; }, async stop() { calls += 1; },
    };
    controller.setScope(scopeA); await controller.load(api);
    expect(await controller.pause("paused", api)).toEqual({ status: "ignored" });
    expect(await controller.stop("now", api)).toEqual({ status: "ignored" });
    expect(await controller.stop("foreign", api)).toEqual({ status: "ignored" });
    expect(calls).toBe(0);
  });

  test("retries only the canonical reload after a POST succeeded but reload failed", async () => {
    const controller = createScheduledWorkController();
    const calls: string[] = []; let lists = 0;
    const api: ScheduledWorkApi = {
      async list() { lists += 1; calls.push("list"); if (lists === 2) throw new Error("offline"); return lists === 1 ? [task()] : [task({ status: "paused" })]; },
      async detail() { return detail(); },
      async pause() { calls.push("pause"); }, async resume() {}, async stop() {},
    };
    controller.setScope(scopeA); await controller.load(api);
    expect((await controller.pause("schedule-1", api)).status).toBe("failed");
    expect(controller.hasPendingCanonicalRefresh()).toBe(true);
    expect((await controller.pause("schedule-1", api)).status).toBe("applied");
    expect(calls).toEqual(["list", "pause", "list", "list"]);
    expect(controller.hasPendingCanonicalRefresh()).toBeFalse();
  });

  test("an explicit reload clears the lifecycle recovery fence", async () => {
    const controller = createScheduledWorkController();
    let lists = 0;
    const api: ScheduledWorkApi = {
      async list() {
        lists += 1;
        if (lists === 2) throw new Error("offline");
        return [task({ status: lists === 1 ? "pending" : "paused" })];
      },
      async detail() { return detail(); },
      async pause() {}, async resume() {}, async stop() {},
    };
    controller.setScope(scopeA);
    await controller.load(api);
    expect((await controller.pause("schedule-1", api)).status).toBe("failed");
    expect(controller.hasPendingCanonicalRefresh()).toBeTrue();

    expect((await controller.retry(api)).status).toBe("applied");
    expect(controller.hasPendingCanonicalRefresh()).toBeFalse();
  });

  test("does not replay a lifecycle POST after an uncertain request failure", async () => {
    const controller = createScheduledWorkController();
    const calls: string[] = []; let lists = 0;
    const api: ScheduledWorkApi = {
      async list() { lists += 1; calls.push("list"); return lists === 1 ? [task()] : [task({ status: "paused" })]; },
      async detail() { return detail(); },
      async pause() { calls.push("pause"); throw new Error("connection dropped"); }, async resume() {}, async stop() {},
    };
    controller.setScope(scopeA); await controller.load(api);
    expect((await controller.pause("schedule-1", api)).status).toBe("failed");
    expect(controller.hasPendingCanonicalRefresh()).toBe(true);
    expect((await controller.pause("schedule-1", api)).status).toBe("applied");
    expect(calls).toEqual(["list", "pause", "list"]);
  });

  test("emits exactly one lifecycle POST while a duplicate pause gesture is pending", async () => {
    const controller = createScheduledWorkController();
    const calls: string[] = [];
    const pendingPause = deferred<void>();
    const api: ScheduledWorkApi = {
      async list() {
        calls.push("list");
        return calls.includes("pause") ? [task({ status: "paused" })] : [task()];
      },
      async detail() { return detail(); },
      pause() { calls.push("pause"); return pendingPause.promise; },
      async resume() {}, async stop() {},
    };
    controller.setScope(scopeA);
    await controller.load(api);

    const first = controller.pause("schedule-1", api);
    const duplicate = controller.pause("schedule-1", api);
    expect(await duplicate).toEqual({ status: "ignored" });
    expect(calls).toEqual(["list", "pause"]);

    pendingPause.resolve();
    expect((await first).status).toBe("applied");
    expect(calls).toEqual(["list", "pause", "list"]);
  });

  test("does not retain a prior Human's schedules on the same server", async () => {
    const controller = createScheduledWorkController();
    const old = deferred<TaskSummary[]>();
    const api: ScheduledWorkApi = {
      list(scope) {
        return scope.userId === "owner-a" ? old.promise : Promise.resolve([task({ id: "new-viewer-schedule" })]);
      },
      async detail() { return detail(); }, async pause() {}, async resume() {}, async stop() {},
    };
    controller.setScope(scopeA);
    const stale = controller.load(api);
    controller.setScope(scopeSameServerOtherViewer);
    const fresh = controller.load(api);
    old.resolve([task({ id: "old-viewer-schedule" })]);

    expect(await stale).toEqual({ status: "ignored" });
    expect((await fresh).status).toBe("applied");
    expect(controller.getState().data?.[0]?.id).toBe("new-viewer-schedule");
  });

  test("makes old-server list and detail completions inert", async () => {
    const controller = createScheduledWorkController();
    const oldList = deferred<TaskSummary[]>(); const oldDetail = deferred<TaskDetail>();
    const api: ScheduledWorkApi = {
      list(scope) { return scope.serverId === "server-a" ? oldList.promise : Promise.resolve([task({ id: "server-b" })]); },
      detail() { return oldDetail.promise; }, async pause() {}, async resume() {}, async stop() {},
    };
    controller.setScope(scopeA);
    const readingList = controller.load(api);
    controller.setScope(scopeB);
    await controller.load(api);
    oldList.resolve([task({ id: "stale-a" })]);
    expect(await readingList).toEqual({ status: "ignored" });
    expect(controller.getState().data?.map((row) => row.id)).toEqual(["server-b"]);

    const readingDetail = controller.getDetail("server-b", api);
    controller.setScope(scopeA);
    oldDetail.resolve(detail(task({ id: "server-b" })));
    expect(await readingDetail).toEqual({ status: "ignored" });
    expect(controller.getDetailState().data).toBeNull();
  });

  test("uses the verified detail epoch and clears exact detail on reauth or capability loss", async () => {
    const controller = createScheduledWorkController();
    const detailScope = { ...scopeA, viewerEpoch: 1 };
    const taskId = "b487068d-9720-4f0f-a7a0-e84d9e4bff54";
    const api: ScheduledWorkApi = { async list() { return [task({ id: taskId })]; }, async detail() { return detail(task({ id: taskId })); }, async pause() {}, async resume() {}, async stop() {} };
    controller.setScope(scopeA, "https://server-a", detailScope);
    await controller.load(api);
    expect((await controller.getDetail(taskId, api)).status).toBe("applied");
    expect(controller.getDetailState().data?.task.id).toBe(taskId);
    controller.setScope(scopeA, "https://server-a", { ...detailScope, viewerEpoch: 2 });
    expect(controller.getDetailState().data).toBeNull();
    controller.setScope(scopeA, "https://server-a", null);
    expect(await controller.getDetail(taskId, api)).toEqual({ status: "ignored" });
  });
});
