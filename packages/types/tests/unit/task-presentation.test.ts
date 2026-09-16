import { describe, expect, test } from "bun:test";
import {
  compareTaskPresentationItems,
  isTerminalTaskPresentationStatus,
  normalizeTaskPresentationStatus,
  parseTaskPresentationTimestamp,
  TASK_PRESENTATION_STATUS_PRIORITY,
  TASK_PRESENTATION_TERMINAL_LINGER_MS,
  taskPresentationActivityText,
  taskPresentationLifecycleText,
  readTaskPreparation,
  taskPreparationText,
  type TaskPresentationItem,
} from "../../src/task-presentation";

function item(partial: Partial<TaskPresentationItem> & Pick<TaskPresentationItem, "taskId" | "status">): TaskPresentationItem {
  return {
    parentTaskId: null,
    depth: 0,
    startedAtMs: 100,
    terminalAtMs: null,
    ...partial,
  };
}

describe("D547 task presentation contract", () => {
  test("normalizes the canonical Task lifecycle without inventing unknown states", () => {
    expect(normalizeTaskPresentationStatus("completed")).toBe("done");
    expect(normalizeTaskPresentationStatus("cancelled")).toBe("done");
    expect(normalizeTaskPresentationStatus("pending")).toBeNull();
    expect(normalizeTaskPresentationStatus("other")).toBeNull();
  });

  test("orders attention by awaiting, errored, running, paused, then done", () => {
    expect(Object.keys(TASK_PRESENTATION_STATUS_PRIORITY)).toEqual([
      "awaiting", "errored", "running", "paused", "done",
    ]);
    expect(compareTaskPresentationItems(
      item({ taskId: "later", status: "running", startedAtMs: 2 }),
      item({ taskId: "first", status: "running", startedAtMs: 1 }),
    )).toBeGreaterThan(0);
    expect(compareTaskPresentationItems(
      item({ taskId: "b", status: "running" }),
      item({ taskId: "a", status: "running" }),
    )).toBeGreaterThan(0);
  });

  test("passes hierarchy through exactly and holds terminal rows for five seconds", () => {
    const nested = item({ taskId: "child", status: "paused", parentTaskId: "parent", depth: 2 });
    expect(nested).toMatchObject({ parentTaskId: "parent", depth: 2 });
    expect(TASK_PRESENTATION_TERMINAL_LINGER_MS).toBe(5000);
    expect(isTerminalTaskPresentationStatus("done")).toBe(true);
    expect(isTerminalTaskPresentationStatus("errored")).toBe(true);
  });

  test("uses exact progress or fixed lifecycle copy, never synthetic activity", () => {
    const exact = "  run_shell: rg --files  ";
    expect(taskPresentationActivityText("running", exact)).toBe(exact);
    expect(taskPresentationActivityText("running", "")).toBe("");
    expect(taskPresentationActivityText("running", null)).toBe("Working…");
    expect(taskPresentationLifecycleText("awaiting")).toBe("Needs attention");
  });

  test("parses server time deterministically without a wall-clock fallback", () => {
    expect(parseTaskPresentationTimestamp("2026-08-21T12:00:00.000Z")).toBe(1787313600000);
    expect(parseTaskPresentationTimestamp(undefined)).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseTaskPresentationTimestamp("not-a-date")).toBe(Number.MAX_SAFE_INTEGER);
  });
});


describe("durable observed research progress", () => {
  const base = { taskRunId: "run-1", updatedAt: "2026-09-07T12:00:00Z", stage: "waiting_model" };
  test("reconnect retains useful work and validated counts without retaining source or finding text", () => {
    const preparation = readTaskPreparation({ ...base, activity: "review_saved", rawArgs: "secret",
      detail: "private source", research: { unitsTotal: 8, unitsCompleted: 2, unitsPending: 6,
        filesTotal: 80, filesAssigned: 40, sourceSnippet: "secret" } })!;
    expect(preparation).not.toBeNull();
    expect(JSON.stringify(preparation)).not.toContain("secret");
    expect(JSON.stringify(preparation)).not.toContain("private source");
    expect(taskPreparationText(preparation)).toBe("Review notes saved · 2/8 review units complete; 6 pending; 40/80 files assigned · Waiting for model");
  });
  test("inventory admission shows observed scope while discovery is still underway", () => {
    const preparation = readTaskPreparation({ ...base, stage: "inventory_progress", filesObserved: 400, directoriesObserved: 30 })!;
    expect(taskPreparationText(preparation)).toBe("Mapping repository: 400 files found across 30 directories; discovery in progress");
    expect(readTaskPreparation({ ...base, stage: "inventory_progress", filesObserved: 400 })).toBeNull();
  });
  test("invalid semantic activity or contradictory counters cannot become durable progress", () => {
    expect(readTaskPreparation({ ...base, activity: "Invented review" })).toBeNull();
    expect(readTaskPreparation({ ...base, research: { unitsTotal: 3, unitsCompleted: 4,
      unitsPending: 0, filesTotal: 10, filesAssigned: 3 } })).toBeNull();
    expect(readTaskPreparation({ ...base, research: { unitsTotal: 3, unitsCompleted: 1,
      unitsPending: 2, filesTotal: 10, filesAssigned: 30 } })).toBeNull();
  });
});
