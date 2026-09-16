import type { TaskSummary } from "@nautilo/types";

import type { TaskWorkScope } from "./task-work-state";

/** One clock and vocabulary shared by the controller and strip qualification. */
export const TASK_WORK_FIXTURE_NOW = Date.parse("2026-08-21T12:00:00.000Z");

export const taskWorkScopeA: TaskWorkScope = {
  serverId: "server-a",
  userId: "owner-a",
  actorId: "actor-a",
  viewerEpoch: 1,
};
export const taskWorkScopeARelogin: TaskWorkScope = { ...taskWorkScopeA, viewerEpoch: 2 };
export const taskWorkScopeB: TaskWorkScope = {
  serverId: "server-b",
  userId: "owner-b",
  actorId: "actor-b",
  viewerEpoch: 1,
};

export function taskWorkFixture(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "task-1",
    parentTaskId: null,
    depth: 0,
    status: "running",
    preset: "delegated",
    prompt: "Look into it",
    scheduleKind: "now",
    nextFireAt: null,
    callingRoomId: "room-1",
    lastError: null,
    createdAt: "2026-08-21T11:00:00.000Z",
    updatedAt: "2026-08-21T11:00:00.000Z",
    agentName: "Jeannie",
    ...overrides,
  };
}

/** Canonical rows spanning every strip-relevant lifecycle priority. */
export const TASK_WORK_LIFECYCLE_FIXTURES = Object.freeze({
  running: taskWorkFixture({ id: "running", agentName: "Moxie" }),
  awaiting: taskWorkFixture({ id: "awaiting", status: "awaiting" }),
  freshError: taskWorkFixture({
    id: "error",
    status: "errored",
    updatedAt: "2026-08-21T11:59:57.000Z",
  }),
  completed: taskWorkFixture({
    id: "done",
    status: "completed",
    updatedAt: "2026-08-21T11:59:56.000Z",
  }),
  paused: taskWorkFixture({ id: "paused", status: "paused" }),
});
