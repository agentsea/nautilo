import { describe, expect, test } from "bun:test";
import type { TaskWorkRow, TaskWorkViewState } from "./task-work-state";

import { createTaskDetailHandoffCoordinator } from "./task-detail-handoff";

const TASK_A = "b487068d-9720-4f0f-a7a0-e84d9e4bff54";
const TASK_B = "6f1b16fb-b1a6-46c8-a3ca-690c4d87931b";
const scope = { serverId: "server-a", userId: "owner-a", actorId: "actor-a", viewerEpoch: 1 };
const row = (taskId: string): TaskWorkRow => ({ task: { id: taskId } as TaskWorkRow["task"], taskId, parentTaskId: null, depth: 0, status: "running", startedAtMs: 0, terminalAtMs: null, activity: "Working…" });
const view = (rows: readonly TaskWorkRow[] = [row(TASK_A)]): TaskWorkViewState => ({
  kind: "ready", scope, selectors: { overviewRows: rows, quiet: false, topRows: [], actionNeeded: [], active: [], paused: [], terminalHistory: [], newlyCompleted: [] },
});
const input = (patch: Partial<Parameters<ReturnType<typeof createTaskDetailHandoffCoordinator>["begin"]>[0]> = {}) => ({
  openOverviewScopeKey: "room\u0000https://a\u0000server-a\u0000owner-a\u0000actor-a\u00001",
  currentOverviewScopeKey: "room\u0000https://a\u0000server-a\u0000owner-a\u0000actor-a\u00001",
  roomId: "db598925-a465-4b0a-b3c8-9f7c6cffc011",
  taskId: TASK_A,
  view: view(),
  ...patch,
});

describe("task detail overview handoff", () => {
  test("hands one current scoped row to the exact detail locator", () => {
    const handoff = createTaskDetailHandoffCoordinator();
    expect(handoff.begin(input())).toEqual({ status: "navigate", taskId: TASK_A, originRoomId: "db598925-a465-4b0a-b3c8-9f7c6cffc011" });
  });

  test("native and Mobile Web share a one-shot handoff despite rapid multi-tap", () => {
    const handoff = createTaskDetailHandoffCoordinator();
    expect(handoff.begin(input())).toMatchObject({ status: "navigate", taskId: TASK_A });
    expect(handoff.begin(input({ taskId: TASK_B, view: view([row(TASK_A), row(TASK_B)]) }))).toEqual({ status: "ignored" });
    handoff.reset();
    expect(handoff.begin(input({ taskId: TASK_B, view: view([row(TASK_A), row(TASK_B)]) }))).toMatchObject({ status: "navigate", taskId: TASK_B });
  });

  test("does not hand a stale overview, changed server/viewer scope, or non-member Task to detail", () => {
    for (const stale of [
      input({ openOverviewScopeKey: null }),
      input({ currentOverviewScopeKey: "room\u0000https://b\u0000server-b\u0000owner-a\u0000actor-a\u00001" }),
      input({ currentOverviewScopeKey: "room\u0000https://a\u0000server-a\u0000owner-b\u0000actor-b\u00002" }),
      input({ taskId: TASK_B }),
      input({ taskId: "not-a-task" }),
    ]) {
      expect(createTaskDetailHandoffCoordinator().begin(stale)).toEqual({ status: "ignored" });
    }
  });
});
