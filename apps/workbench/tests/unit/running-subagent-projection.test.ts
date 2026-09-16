import { describe, expect, test } from "bun:test";
import { TASK_DESKTOP_WAIT_TEXT, TASK_PROVIDER_WAIT_TEXT, type TaskSummary } from "@nautilo/types";
import {
  buildRunningSubagentsMap,
  taskSummaryToRunningSubagent,
  type RunningSubagentOverlay,
} from "../../src/contexts/task-state/running-subagent-projection";

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
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
    createdAt: "2026-08-21T12:00:00.000Z",
    ...overrides,
  };
}

describe("D547 running-subagent shared projection", () => {
  test("passes canonical hierarchy and lifecycle fallback through without a wall clock", () => {
    const projected = taskSummaryToRunningSubagent(task({
      parentTaskId: "parent-1",
      depth: 2,
      harnessId: "codex",
    }));
    expect(projected).toMatchObject({
      parentTaskId: "parent-1",
      depth: 2,
      line3: "Working…",
      startedAtMs: 1787313600000,
    });
  });

  test("reconnect restores receipt-derived review progress and keeps provider wait secondary", () => {
    const projected = taskSummaryToRunningSubagent(task({ preparation: { stage: "waiting_model",
      activity: "checkpoint_saved", taskRunId: "run-1", updatedAt: "2026-09-07T12:00:00Z",
      research: { unitsTotal: 10, unitsCompleted: 3, unitsPending: 7, filesTotal: 100, filesAssigned: 90 } } }));
    expect(projected?.line3).toBe("Research checkpoint saved · 3/10 review units complete; 7 pending; 90/100 files assigned · Waiting for model");
  });

  test("reconnect shows the active audit role and assigned subject before provider wait", () => {
    const projected = taskSummaryToRunningSubagent(task({ preparation: { stage: "waiting_model",
      activity: "reading_source", taskRunId: "run-1", updatedAt: "2026-09-07T12:00:00Z",
      researchWork: { role: "reviewer", subject: "Trace token revocation through access checks" },
      contextRecovery: { phase: "consolidation_required", pendingInputs: 7 } } }));
    expect(projected?.line3).toBe("Reviewing · Model-assigned focus: Trace token revocation through access checks · Reading source code · Runtime recovery: saving checkpoint; 7 historical inputs remain · Waiting for model");
  });

  test("canonical terminal status wins over stale nonterminal overlay fields", () => {
    const terminalTask = task({
      status: "completed",
      targetRoomId: "room-1",
      updatedAt: "2026-08-21T12:01:00.000Z",
    });
    const stale: RunningSubagentOverlay = {
      taskRunId: "run-1",
      status: "awaiting",
      line3: "run_shell: stale",
      awaitingRoomId: "room-1",
      terminalAtMs: null,
      recentActivity: ["run_shell: stale"],
    };
    const projected = buildRunningSubagentsMap(
      { [terminalTask.id]: terminalTask },
      { [terminalTask.id]: stale },
      new Set([terminalTask.id]),
    )[terminalTask.id];

    expect(projected).toMatchObject({
      status: "done",
      line3: "Done",
      awaitingRoomId: null,
      terminalAtMs: 1787313660000,
      recentActivity: [],
    });
  });
});


test("only an errored owner capability advertises research Resume", () => {
  expect(taskSummaryToRunningSubagent(task({ status: "errored", canResumeResearch: true }))?.canResumeResearch).toBe(true);
  for (const status of ["errored", "completed", "cancelled", "running"]) {
    expect(taskSummaryToRunningSubagent(task({ status, ...(status === "errored" ? {} : { canResumeResearch: true }) }))?.canResumeResearch).toBeUndefined();
  }
});


test("reconnect restores the durable Desktop wait instead of stale working progress", () => {
  const paused = task({ status: "paused", lastError: TASK_DESKTOP_WAIT_TEXT });
  expect(taskSummaryToRunningSubagent(paused)?.line3).toBe(TASK_DESKTOP_WAIT_TEXT);
  expect(buildRunningSubagentsMap({ "task-1": paused }, { "task-1": { status: "paused", line3: "Reading source" } }, new Set(["task-1"]))["task-1"]?.line3)
    .toBe(TASK_DESKTOP_WAIT_TEXT);
});


test("provider timeout pause remains visible after reconnect and overrides stale working progress", () => {
  const paused = task({ status: "paused", lastError: TASK_PROVIDER_WAIT_TEXT });
  expect(taskSummaryToRunningSubagent(paused)?.line3).toBe(TASK_PROVIDER_WAIT_TEXT);
  const merged = buildRunningSubagentsMap({ [paused.id]: paused }, {
    [paused.id]: { status: "running", line3: "Model is responding" },
  }, new Set([paused.id]));
  expect(merged[paused.id]?.status).toBe("paused");
  expect(merged[paused.id]?.line3).toBe(TASK_PROVIDER_WAIT_TEXT);
});
