import { describe, expect, test } from "bun:test";
import type { TaskDetail, TaskLifecycleResponse } from "@nautilo/types";

import { createTaskDetailLifecycleController, taskDetailLifecycleActions, type TaskDetailLifecycleApi } from "./task-detail-lifecycle";
import type { TaskDetailTarget } from "./task-detail-state";

const A = "b487068d-9720-4f0f-a7a0-e84d9e4bff54";
const B = "6f1b16fb-b1a6-46c8-a3ca-690c4d87931b";
const target = (taskId = A, patch: Partial<TaskDetailTarget> = {}): TaskDetailTarget => ({ serverId: "server-a", serverUrl: "https://a.example", userId: "owner-a", actorId: "actor-a", viewerEpoch: 1, taskId, ...patch });
const task = (status: string): TaskDetail => ({ task: {
  id: A, parentTaskId: null, depth: 0, status, preset: "delegated", prompt: "Exact task", scheduleKind: "now", nextFireAt: null, callingRoomId: null, lastError: null,
  expectedOutput: null, cron: null, runAt: null, timezone: "UTC", targetChat: "orphan", resultDelivery: "wake", useScope: false, scopeId: null, toolsMode: "all", toolsWhitelist: [], selectionProfile: "balanced", selectionSpec: null, requestedModelId: null, createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z",
} as TaskDetail["task"], runs: [] });
const response = (status: string, message = status): TaskLifecycleResponse => ({ taskId: A, status, message });
const applied = (status: string) => Promise.resolve({ status: "applied" as const, data: task(status) });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

function api(overrides: Partial<TaskDetailLifecycleApi> = {}, calls: string[] = []): TaskDetailLifecycleApi {
  return {
    pause: async () => { calls.push("pause"); return response("paused"); },
    resume: async () => { calls.push("resume"); return response("pending"); },
    stop: async () => { calls.push("stop"); return response("cancelled"); },
    reconcile: async () => { calls.push("get"); return applied("paused"); },
    ...overrides,
  };
}

describe("task detail lifecycle actions", () => {
  test("projects only the locked canonical action matrix", () => {
    expect(taskDetailLifecycleActions("running")).toEqual(["pause", "stop"]);
    expect(taskDetailLifecycleActions("paused")).toEqual(["resume", "stop"]);
    for (const status of ["pending", "awaiting", "completed", "cancelled", "errored", "unknown", null]) expect(taskDetailLifecycleActions(status)).toEqual([]);
  });

  test("posts the exact endpoint then waits for post-boundary canonical detail", async () => {
    const calls: string[] = []; const controller = createTaskDetailLifecycleController(); controller.setTarget(target());
    const result = await controller.act("pause", "running", api({}, calls));
    expect(result.status).toBe("applied");
    expect(calls).toEqual(["pause", "get"]);
    expect(controller.getState().phase).toBe("idle");
  });

  test("does not post invalid statuses or any action while another action is pending", async () => {
    const calls: string[] = []; const pending = deferred<TaskLifecycleResponse>();
    const controller = createTaskDetailLifecycleController(); controller.setTarget(target());
    const source = api({ pause: () => { calls.push("pause"); return pending.promise; } }, calls);
    expect(await controller.act("pause", "pending", source)).toEqual({ status: "ignored" });
    const first = controller.act("pause", "running", source);
    expect(await controller.act("stop", "running", source)).toEqual({ status: "ignored" });
    expect(calls).toEqual(["pause"]);
    pending.resolve(response("paused")); await first;
    expect(calls).toEqual(["pause", "get"]);
  });

  test("uses canonical detail over a conflicting successful receipt and preserves its exact message", async () => {
    const controller = createTaskDetailLifecycleController(); controller.setTarget(target());
    await controller.act("pause", "running", api({ pause: async () => response("completed", "Task completed elsewhere."), reconcile: async () => applied("running") }));
    // The receipt does not patch the row: the later canonical status wins.
    expect(controller.getState()).toMatchObject({ phase: "idle", notice: "Task completed elsewhere." });
  });

  test("does not trust a malformed receipt task identity and still exact-GET reconciles", async () => {
    const calls: string[] = []; const controller = createTaskDetailLifecycleController(); controller.setTarget(target());
    await controller.act("pause", "running", api({ pause: async () => { calls.push("pause"); return { taskId: B, status: "paused", message: "foreign" }; }, reconcile: async () => { calls.push("get"); return applied("paused"); } }, calls));
    expect(calls).toEqual(["pause", "get"]);
    expect(controller.getState()).toMatchObject({ phase: "idle", notice: null });
    expect(controller.getState().error).toContain("invalid task response");
  });

  test("a rejected POST still reconciles and restores the canonical action state", async () => {
    const controller = createTaskDetailLifecycleController(); controller.setTarget(target());
    await controller.act("pause", "running", api({ pause: async () => { throw Object.assign(new Error("Task changed"), { status: 409 }); }, reconcile: async () => applied("running") }));
    expect(controller.getState()).toMatchObject({ phase: "idle", error: "Task changed The current task status is shown." });
  });

  test("an uncertain network POST that still shows incompatible work fences further POSTs", async () => {
    const calls: string[] = []; const controller = createTaskDetailLifecycleController(); controller.setTarget(target());
    const source = api({ pause: async () => { calls.push("pause"); throw new TypeError("offline"); }, reconcile: async () => { calls.push("get"); return applied("running"); } }, calls);
    expect((await controller.act("pause", "running", source)).status).toBe("applied");
    expect(controller.getState().phase).toBe("recovery-required");
    expect(await controller.act("pause", "running", source)).toEqual({ status: "ignored" });
    expect(calls).toEqual(["pause", "get"]);
  });

  test("an uncertain POST clears only after a later canonical result proves the intent or terminal winner", async () => {
    const controller = createTaskDetailLifecycleController(); controller.setTarget(target());
    await controller.act("resume", "paused", api({ resume: async () => { throw new TypeError("offline"); }, reconcile: async () => applied("paused") }));
    expect(controller.getState().phase).toBe("recovery-required");
    controller.observeCanonical("running");
    expect(controller.getState().phase).toBe("idle");
  });

  test("recovery mode offers GET-only reload and does not replay the uncertain POST", async () => {
    const calls: string[] = []; const controller = createTaskDetailLifecycleController(); controller.setTarget(target());
    const source = api({ stop: async () => { calls.push("stop"); throw new TypeError("offline"); }, reconcile: async () => { calls.push("get"); return applied("running"); } }, calls);
    await controller.act("stop", "running", source);
    await controller.reload(source);
    expect(calls).toEqual(["stop", "get", "get"]);
    expect(controller.getState().phase).toBe("recovery-required");
  });

  test("a POST deadline never replays and remains fenced until canonical detail settles it", async () => {
    let expire!: () => void; const pending = deferred<TaskLifecycleResponse>();
    const controller = createTaskDetailLifecycleController({ requestDeadlineMs: 1, scheduleRequestDeadline: (callback) => { expire = callback; return 1 as unknown as ReturnType<typeof setTimeout>; }, clearRequestDeadline: () => {} });
    controller.setTarget(target());
    const source = api({ pause: () => pending.promise, reconcile: async () => applied("running") });
    const action = controller.act("pause", "running", source); expire(); await action;
    expect(controller.getState().phase).toBe("recovery-required");
    pending.resolve(response("paused"));
    expect(await controller.act("pause", "running", source)).toEqual({ status: "ignored" });
    controller.observeCanonical("cancelled");
    expect(controller.getState().phase).toBe("idle");
  });

  test("a failed post-boundary GET requires a successful GET-only reload", async () => {
    const controller = createTaskDetailLifecycleController(); controller.setTarget(target()); let reads = 0;
    const source = api({ reconcile: async () => { reads += 1; return reads === 1 ? { status: "failed" as const, error: new Error("offline") } : applied("paused"); } });
    await controller.act("pause", "running", source);
    expect(controller.getState().phase).toBe("recovery-required");
    await controller.reload(source);
    expect(controller.getState().phase).toBe("idle");
  });

  test("scope switches and concurrent terminal reconciliation make late lifecycle results inert", async () => {
    const post = deferred<TaskLifecycleResponse>(); const controller = createTaskDetailLifecycleController(); controller.setTarget(target());
    const action = controller.act("pause", "running", api({ pause: () => post.promise }));
    controller.setTarget(target(B)); post.resolve(response("paused"));
    expect(await action).toEqual({ status: "ignored" });

    controller.setTarget(target());
    await controller.act("stop", "running", api({ reconcile: async () => applied("completed") }));
    expect(controller.getState().phase).toBe("idle");
  });
});
