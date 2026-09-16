/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";

import { TASK_WORK_FIXTURE_NOW, TASK_WORK_LIFECYCLE_FIXTURES } from "./task-work-lifecycle-fixtures";
import { presentTaskWorkOverviewRow, shouldAnimateTaskWorkOverviewRow, taskWorkRowTiming, taskWorkStatusLabel } from "./task-work-overview-row-presentation";
import type { TaskWorkOverviewDisplayRow } from "./task-work-overview-presentation";
import type { TaskWorkRow } from "./task-work-state";

function displayRow(task: typeof TASK_WORK_LIFECYCLE_FIXTURES.running, overrides: Partial<TaskWorkRow> = {}): TaskWorkOverviewDisplayRow {
  const row: TaskWorkRow = {
    task,
    taskId: task.id,
    parentTaskId: task.parentTaskId,
    depth: task.depth,
    status: task.status === "completed" ? "done" : task.status as TaskWorkRow["status"],
    startedAtMs: TASK_WORK_FIXTURE_NOW - 65 * 60_000,
    terminalAtMs: task.status === "completed" || task.status === "errored" ? TASK_WORK_FIXTURE_NOW - 5 * 60_000 : null,
    activity: "Working…",
    ...overrides,
  };
  return { row, displayDepth: 1, displayParentTaskId: "parent-task" };
}

describe("Task work overview row presentation", () => {
  test("keeps all shared lifecycle fixture statuses textual and activity literal", () => {
    const expected = {
      running: "Working",
      awaiting: "Waiting for you",
      freshError: "Needs attention",
      completed: "Completed",
      paused: "Paused",
    } as const;
    for (const [name, task] of Object.entries(TASK_WORK_LIFECYCLE_FIXTURES)) {
      const current = displayRow(task, {
        status: task.status === "completed" ? "done" : task.status as TaskWorkRow["status"],
        activity: `exact ${name} progress`,
      });
      const presentation = presentTaskWorkOverviewRow({ displayRow: current, needsAttention: name === "awaiting" || name === "freshError", nowMs: TASK_WORK_FIXTURE_NOW });
      expect(presentation.statusLabel).toBe(expected[name as keyof typeof expected]);
      expect(presentation.activity).toBe(`exact ${name} progress`);
    }
  });

  test("preserves a long canonical prompt, semantic attention, and display-only hierarchy", () => {
    const prompt = "A deliberately long canonical Task prompt that must wrap at large text instead of replacing its lifecycle or truncating its exact activity";
    const presentation = presentTaskWorkOverviewRow({
      displayRow: displayRow(TASK_WORK_LIFECYCLE_FIXTURES.awaiting, { task: { ...TASK_WORK_LIFECYCLE_FIXTURES.awaiting, prompt }, status: "awaiting", activity: "Waiting for your reply" }),
      needsAttention: true,
      nowMs: TASK_WORK_FIXTURE_NOW,
    });
    expect(presentation).toMatchObject({
      prompt,
      needsAttention: true,
      displayParentTaskId: "parent-task",
      displayDepth: 1,
      activity: "Waiting for your reply",
    });
  });

  test("uses fixed missing-field fallbacks rather than generated Task or Genie prose", () => {
    const presentation = presentTaskWorkOverviewRow({
      displayRow: displayRow(TASK_WORK_LIFECYCLE_FIXTURES.running, { task: { ...TASK_WORK_LIFECYCLE_FIXTURES.running, prompt: "", agentName: "   " } }),
      needsAttention: false,
      nowMs: TASK_WORK_FIXTURE_NOW,
    });
    expect(presentation.prompt).toBe("Untitled task");
    expect(presentation.agentName).toBe("Assigned Genie");

    const whitespacePrompt = presentTaskWorkOverviewRow({
      displayRow: displayRow(TASK_WORK_LIFECYCLE_FIXTURES.running, { task: { ...TASK_WORK_LIFECYCLE_FIXTURES.running, prompt: "   " } }),
      needsAttention: false,
      nowMs: TASK_WORK_FIXTURE_NOW,
    });
    expect(whitespacePrompt.prompt).toBe("Untitled task");
  });

  test("preserves nonempty canonical prompt and authorized Genie label byte-for-byte", () => {
    const prompt = "  Preserve this exact prompt  ";
    const agentName = "  Jeannie  ";
    const presentation = presentTaskWorkOverviewRow({
      displayRow: displayRow(TASK_WORK_LIFECYCLE_FIXTURES.running, { task: { ...TASK_WORK_LIFECYCLE_FIXTURES.running, prompt, agentName } }),
      needsAttention: false,
      nowMs: TASK_WORK_FIXTURE_NOW,
    });
    expect(presentation.prompt).toBe(prompt);
    expect(presentation.agentName).toBe(agentName);
  });

  test("formats active elapsed and recent terminal time deterministically without invalid or future timestamps", () => {
    expect(taskWorkRowTiming("running", TASK_WORK_FIXTURE_NOW - 65 * 60_000, null, TASK_WORK_FIXTURE_NOW)).toBe("Elapsed 1h");
    expect(taskWorkRowTiming("done", TASK_WORK_FIXTURE_NOW - 90 * 60_000, TASK_WORK_FIXTURE_NOW - 5 * 60_000, TASK_WORK_FIXTURE_NOW)).toBe("Completed 5m ago");
    expect(taskWorkRowTiming("errored", TASK_WORK_FIXTURE_NOW - 90 * 60_000, TASK_WORK_FIXTURE_NOW - 5 * 60_000, TASK_WORK_FIXTURE_NOW)).toBe("Errored 5m ago");
    expect(taskWorkRowTiming("paused", TASK_WORK_FIXTURE_NOW + 1, null, TASK_WORK_FIXTURE_NOW)).toBe("Time unavailable");
    expect(taskWorkRowTiming("errored", TASK_WORK_FIXTURE_NOW, TASK_WORK_FIXTURE_NOW + 1, TASK_WORK_FIXTURE_NOW)).toBe("Time unavailable");
  });

  test("uses no synthetic lifecycle wording outside the fixed status vocabulary", () => {
    expect(["awaiting", "running", "paused", "done", "errored"].map((status) => taskWorkStatusLabel(status as TaskWorkRow["status"]))).toEqual([
      "Waiting for you", "Working", "Paused", "Completed", "Needs attention",
    ]);
  });

  test("animates only live running work and always honors reduced motion", () => {
    expect(shouldAnimateTaskWorkOverviewRow("running", false)).toBeTrue();
    expect(shouldAnimateTaskWorkOverviewRow("running", true)).toBeFalse();
    expect(shouldAnimateTaskWorkOverviewRow("awaiting", false)).toBeFalse();
  });
});
