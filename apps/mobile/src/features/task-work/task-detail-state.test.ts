import { describe, expect, test } from "bun:test";
import type { TaskDetail, TaskSummary } from "@nautilo/types";

import { createTaskDetailController, type TaskDetailTarget } from "./task-detail-state";

const A = "b487068d-9720-4f0f-a7a0-e84d9e4bff54";
const B = "6f1b16fb-b1a6-46c8-a3ca-690c4d87931b";
const target = (taskId: string, patch: Partial<TaskDetailTarget> = {}): TaskDetailTarget => ({
  serverId: "server-a", serverUrl: "https://a.example", userId: "owner-a", actorId: "actor-a", viewerEpoch: 1, taskId, ...patch,
});
const row = (id: string): TaskSummary => ({ id, parentTaskId: null, depth: 0, status: "running", preset: "delegated", prompt: "Exact task", scheduleKind: "now", nextFireAt: null, callingRoomId: null, lastError: null });
const detail = (id: string): TaskDetail => ({ task: { ...row(id), expectedOutput: null, cron: null, runAt: null, timezone: "UTC", targetChat: "orphan", resultDelivery: "wake", useScope: false, scopeId: null, toolsMode: "all", toolsWhitelist: [], selectionProfile: "balanced", selectionSpec: null, requestedModelId: null, createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" }, runs: [] });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

describe("exact task detail controller", () => {
  test("starts B immediately after A target changes and makes A inert", async () => {
    const controller = createTaskDetailController(); const a = deferred<TaskDetail>(); const calls: string[] = [];
    controller.setTarget(target(A));
    const old = controller.load({ detail: (next) => { calls.push(next.taskId); return a.promise; } });
    controller.setTarget(target(B));
    const fresh = controller.load({ detail: async (next) => { calls.push(next.taskId); return detail(next.taskId); } });
    expect(calls).toEqual([A, B]);
    a.resolve(detail(A));
    expect(await old).toEqual({ status: "ignored" });
    expect((await fresh).status).toBe("applied");
    expect(controller.getState().data?.task.id).toBe(B);
  });

  test("rejects malformed locators and response-ID mismatches without rendering detail", async () => {
    const controller = createTaskDetailController(); let calls = 0;
    controller.setTarget(target("not-a-uuid"));
    await controller.load({ detail: async () => { calls += 1; return detail(A); } });
    expect(calls).toBe(0); expect(controller.getState().unavailable).toBe(true);
    controller.setTarget(target(A));
    await controller.load({ detail: async () => detail(B) });
    expect(controller.getState().data).toBeNull(); expect(controller.getState().unavailable).toBe(true);
  });

  test("hides retained data for auth, ownership, and deletion failures", async () => {
    for (const status of [401, 403, 404]) {
      const controller = createTaskDetailController(); controller.setTarget(target(A));
      await controller.load({ detail: async () => detail(A) });
      await controller.refresh({ detail: async () => { throw Object.assign(new Error("denied"), { status }); } });
      expect(controller.getState().data).toBeNull(); expect(controller.getState().unavailable).toBe(true);
      expect(controller.getState().authRequired).toBe(status === 401);
    }
  });

  test("synchronously clears the same Task on every authority boundary and disposes late reads", async () => {
    const controller = createTaskDetailController(); const pending = deferred<TaskDetail>();
    controller.setTarget(target(A)); const old = controller.load({ detail: async () => pending.promise });
    for (const next of [
      target(A, { serverId: "server-b", serverUrl: "https://b.example" }),
      target(A, { userId: "owner-b", actorId: "actor-b" }),
      target(A, { viewerEpoch: 2 }),
      null,
    ]) {
      controller.setTarget(next);
      expect(controller.getState().data).toBeNull();
      expect(controller.getState().loading).toBe(false);
    }
    controller.dispose(); pending.resolve(detail(A));
    expect(await old).toEqual({ status: "ignored" });
  });

  test("retains only same-target verified detail for recoverable network and server failures", async () => {
    for (const error of [new TypeError("offline"), Object.assign(new Error("server"), { status: 500 })]) {
      const controller = createTaskDetailController(); controller.setTarget(target(A));
      await controller.load({ detail: async () => detail(A) });
      await controller.refresh({ detail: async () => { throw error; } });
      expect(controller.getState().data?.task.id).toBe(A); expect(controller.getState().error).not.toBeNull();
    }
    const initial = createTaskDetailController(); initial.setTarget(target(A));
    await initial.load({ detail: async () => { throw new TypeError("offline"); } });
    expect(initial.getState().data).toBeNull(); expect(initial.getState().error).not.toBeNull();
  });

  test("coalesces refreshes with at most one trailing canonical request", async () => {
    const controller = createTaskDetailController(); const first = deferred<TaskDetail>(); let calls = 0;
    controller.setTarget(target(A));
    const initial = controller.load({ detail: async () => { calls += 1; return first.promise; } });
    const one = controller.refresh({ detail: async () => { calls += 1; return detail(A); } });
    const two = controller.refresh({ detail: async () => { calls += 1; return detail(A); } });
    first.resolve(detail(A)); await initial; await one; await two;
    await Promise.resolve();
    expect(calls).toBe(2);
  });

  test("mutation reconciliation awaits a GET that starts after an older read", async () => {
    const controller = createTaskDetailController();
    const old = deferred<TaskDetail>();
    const calls: string[] = [];
    controller.setTarget(target(A));
    const initial = controller.load({ detail: async () => { calls.push("old"); return old.promise; } });
    const reconciled = controller.reconcileAfterMutation({ detail: async () => { calls.push("post"); return detail(A); } });
    old.resolve(detail(A));
    expect((await initial).status).toBe("applied");
    expect((await reconciled).status).toBe("applied");
    expect(calls).toEqual(["old", "post"]);
  });

  test("target changes fence a pending mutation reconciliation barrier", async () => {
    const controller = createTaskDetailController();
    const old = deferred<TaskDetail>();
    controller.setTarget(target(A));
    void controller.load({ detail: async () => old.promise });
    const reconciled = controller.reconcileAfterMutation({ detail: async () => detail(A) });
    controller.setTarget(target(B));
    expect(await reconciled).toEqual({ status: "ignored" });
    old.resolve(detail(A));
  });

  test("a finite deadline releases recovery and fences a late response", async () => {
    let deadline!: () => void; const controller = createTaskDetailController({ readDeadlineMs: 1, scheduleReadDeadline: (callback) => { deadline = callback; return 1 as unknown as ReturnType<typeof setTimeout>; }, clearReadDeadline: () => {} });
    const pending = deferred<TaskDetail>(); controller.setTarget(target(A));
    const timed = controller.load({ detail: async () => pending.promise }); deadline();
    expect((await timed).status).toBe("failed"); expect(controller.getState().loading).toBe(false);
    pending.resolve(detail(A)); await Promise.resolve(); expect(controller.getState().data).toBeNull();
    expect((await controller.refresh({ detail: async () => detail(A) })).status).toBe("applied");
  });
});
