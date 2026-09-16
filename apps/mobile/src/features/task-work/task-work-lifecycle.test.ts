import { expect, test } from "bun:test";
import type { TaskDetail, TaskLifecycleResponse, TaskSummary } from "@nautilo/types";
import { TASK_PRESENTATION_TERMINAL_LINGER_MS } from "@nautilo/types";

import { createTaskDetailController, type TaskDetailTarget } from "./task-detail-state";
import { createTaskDetailLifecycleController, type TaskDetailLifecycleApi } from "./task-detail-lifecycle";
import { projectTaskWorkOverview } from "./task-work-overview-presentation";
import { createTaskWorkController, selectTaskWork, type TaskWorkApi } from "./task-work-state";
import { taskRoomHandoffTarget } from "./task-room-handoff";

const TASK_PARENT = "b487068d-9720-4f0f-a7a0-e84d9e4bff54";
const TASK_CHILD = "6f1b16fb-b1a6-46c8-a3ca-690c4d87931b";
const ROOM = "db598925-a465-4b0a-b3c8-9f7c6cffc011";
const scope = { serverId: "server-a", userId: "owner-a", actorId: "actor-a", viewerEpoch: 1 };
const detailTarget: TaskDetailTarget = { ...scope, serverUrl: "https://a.example", taskId: TASK_CHILD };
const nowBase = Date.parse("2026-08-21T12:00:00.000Z");

const task = (patch: Partial<TaskSummary> = {}): TaskSummary => ({
  id: TASK_PARENT, parentTaskId: null, depth: 0, status: "running", preset: "delegated", prompt: "Parent task", scheduleKind: "now", nextFireAt: null, callingRoomId: "room-1", targetRoomId: ROOM, lastError: null,
  createdAt: "2026-08-21T11:00:00.000Z", updatedAt: "2026-08-21T11:00:00.000Z", ...patch,
});
const detail = (status: string): TaskDetail => ({ task: { ...task({ id: TASK_CHILD, status }), expectedOutput: null, cron: null, runAt: null, timezone: "UTC", targetChat: "room", resultDelivery: "wake", useScope: false, scopeId: null, toolsMode: "all", toolsWhitelist: [], selectionProfile: "balanced", selectionSpec: null, requestedModelId: null, createdAt: "2026-08-21T11:00:00.000Z", updatedAt: "2026-08-21T11:00:00.000Z" }, runs: [] });

test("delegated work stays canonical from nested discovery through reconnect, attention/control, disappearing detail, and bounded Done", async () => {
  let clock = nowBase;
  const work = createTaskWorkController({ now: () => clock, schedule: () => 1 as unknown as ReturnType<typeof setTimeout>, clearSchedule: () => {} });
  const active = [
    task(),
    task({ id: TASK_CHILD, parentTaskId: TASK_PARENT, depth: 1, prompt: "Child task", status: "running" }),
  ];
  let canonical: TaskSummary[] = active;
  const api: TaskWorkApi = { list: async () => canonical };
  work.setScope(scope);
  await work.load(api);
  let selectors = selectTaskWork(work.getState().tasks, work.getState().overlays, clock);
  let overview = projectTaskWorkOverview({ overviewRows: selectors.overviewRows, newlyCompleted: selectors.newlyCompleted, doneExpanded: true });
  expect(overview.sections[1].rows.map((row) => [row.row.taskId, row.displayParentTaskId, row.displayDepth])).toEqual([
    [TASK_PARENT, null, 0], [TASK_CHILD, TASK_PARENT, 1],
  ]);

  work.applyRealtimeEvent({ type: "task.progress", taskId: TASK_CHILD, taskRunId: "run-1", detail: "run_shell: exact progress", ownerId: scope.userId } as never, api);
  expect(selectTaskWork(work.getState().tasks, work.getState().overlays, clock).active.find((row) => row.taskId === TASK_CHILD)?.activity).toBe("run_shell: exact progress");
  // A reconnect clears provisional bytes before the one bounded canonical repair.
  work.discardProvisionalProgress();
  await work.reconcile(api, { resetLive: true });
  expect(selectTaskWork(work.getState().tasks, work.getState().overlays, clock).active.find((row) => row.taskId === TASK_CHILD)?.activity).toBe("Working…");

  // Task detail owns lifecycle POSTs and the post-boundary GET, while an exact
  // attention request remains primary over an otherwise valid target Room.
  const lifecycle = createTaskDetailLifecycleController(); lifecycle.setTarget(detailTarget);
  const lifecycleApi: TaskDetailLifecycleApi = {
    pause: async (): Promise<TaskLifecycleResponse> => ({ taskId: TASK_CHILD, status: "paused", message: "paused" }),
    resume: async (): Promise<TaskLifecycleResponse> => ({ taskId: TASK_CHILD, status: "pending", message: "resumed" }),
    stop: async (): Promise<TaskLifecycleResponse> => ({ taskId: TASK_CHILD, status: "cancelled", message: "stopped" }),
    reconcile: async () => ({ status: "applied", data: detail("paused") }),
  };
  await lifecycle.act("pause", "running", lifecycleApi);
  expect(lifecycle.getState().phase).toBe("idle");
  expect(taskRoomHandoffTarget({ detailTarget, taskStatus: "awaiting", targetRoomId: ROOM, attentionPending: true })).toBeNull();
  expect(taskRoomHandoffTarget({ detailTarget, taskStatus: "awaiting", targetRoomId: ROOM, attentionPending: false })?.targetRoomId).toBe(ROOM);

  // A detail deleted after overview discovery becomes the route's non-leaking
  // unavailable state; no stale parent or Room data is retained.
  const reader = createTaskDetailController(); reader.setTarget(detailTarget);
  await reader.load({ detail: async () => { throw Object.assign(new Error("not found"), { status: 404 }); } });
  expect(reader.getState()).toMatchObject({ data: null, unavailable: true, error: null });

  work.applyRealtimeEvent({ type: "task.errored", taskId: TASK_CHILD, taskRunId: "run-1", status: "errored", ownerId: scope.userId } as never, api);
  selectors = selectTaskWork(work.getState().tasks, work.getState().overlays, clock);
  overview = projectTaskWorkOverview({ overviewRows: selectors.overviewRows, newlyCompleted: selectors.newlyCompleted });
  expect(overview.sections[0]).toMatchObject({ id: "needs-you", count: 1 });
  expect(overview.sections[2]).toMatchObject({ id: "done", count: 0, collapsed: true });

  clock += TASK_PRESENTATION_TERMINAL_LINGER_MS;
  // Reconciliation replaces the terminal window with exactly the five rows
  // supplied by the server. Mobile neither pages nor manufactures a sixth.
  canonical = [
    task({ id: TASK_CHILD, parentTaskId: TASK_PARENT, depth: 1, status: "errored", prompt: "Child task", updatedAt: new Date(nowBase).toISOString() }),
    ...[1, 2, 3, 4].map((offset) => task({ id: `server-terminal-${offset}`, status: "completed", prompt: `Bounded terminal ${offset}`, updatedAt: "2026-08-21T10:00:00.000Z" })),
  ];
  await work.reconcile(api);
  selectors = selectTaskWork(work.getState().tasks, work.getState().overlays, clock);
  overview = projectTaskWorkOverview({ overviewRows: selectors.overviewRows, newlyCompleted: selectors.newlyCompleted });
  expect(overview.sections[0].count).toBe(0);
  expect(overview.sections[2]).toMatchObject({ id: "done", count: 5, rows: [], collapsed: true });
  expect(selectors.terminalHistory.map((row) => row.taskId)).toEqual(canonical.map((row) => row.id));
  expect(selectors.terminalHistory.length).toBeLessThanOrEqual(5);
});

test("a canonical reconcile removes a disappeared Task, its overlays, and any downstream Room eligibility", async () => {
  const work = createTaskWorkController();
  let canonical: TaskSummary[] = [task({ id: TASK_CHILD, status: "running" })];
  const api: TaskWorkApi = { list: async () => canonical };
  work.setScope(scope);
  await work.load(api);
  work.applyRealtimeEvent({ type: "task.progress", taskId: TASK_CHILD, taskRunId: "run-1", detail: "exact but provisional", ownerId: scope.userId } as never, api);
  canonical = [];
  await work.reconcile(api, { resetLive: true });
  const selectors = selectTaskWork(work.getState().tasks, work.getState().overlays, nowBase);
  expect(selectors.overviewRows).toEqual([]);
  expect(work.getState().overlays[TASK_CHILD]).toBeUndefined();
  expect(taskRoomHandoffTarget({ detailTarget: null, taskStatus: "awaiting", targetRoomId: ROOM, attentionPending: false })).toBeNull();
});
