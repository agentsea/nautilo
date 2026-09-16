/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import type { TaskPresentationStatus, TaskSummary } from "@nautilo/types";

import { projectTaskWorkOverview, taskWorkOverviewTabWrap } from "./task-work-overview-presentation";
import type { TaskWorkRow } from "./task-work-state";

const startedAtMs = 1_000;

function row(input: Partial<Omit<TaskWorkRow, "task">> & {
  readonly taskId: string;
  readonly status?: TaskPresentationStatus;
}): TaskWorkRow {
  const status = input.status ?? "running";
  return {
    task: {
      id: input.taskId,
      parentTaskId: input.parentTaskId ?? null,
      depth: input.depth ?? 0,
      status,
      prompt: input.taskId,
    } as TaskSummary,
    taskId: input.taskId,
    parentTaskId: input.parentTaskId ?? null,
    depth: input.depth ?? 0,
    status,
    startedAtMs: input.startedAtMs ?? startedAtMs,
    terminalAtMs: input.terminalAtMs ?? null,
    activity: input.activity ?? "Working…",
  };
}

function projection(rows: readonly TaskWorkRow[], newlyCompleted: readonly TaskWorkRow[] = [], doneExpanded = false) {
  return projectTaskWorkOverview({ overviewRows: rows, newlyCompleted, doneExpanded });
}

function section(result: ReturnType<typeof projection>, id: "needs-you" | "working-paused" | "done") {
  const found = result.sections.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing ${id} section`);
  return found;
}

function ids(result: ReturnType<typeof projection>, id: "needs-you" | "working-paused" | "done") {
  return section(result, id).rows.map((displayRow) => displayRow.row.taskId);
}

describe("Task work overview presentation", () => {
  test("wraps browser dialog Tab focus only at the first and last shell target", () => {
    expect(taskWorkOverviewTabWrap({ focusableCount: 3, activeIndex: 2, shiftKey: false })).toBe(0);
    expect(taskWorkOverviewTabWrap({ focusableCount: 3, activeIndex: 0, shiftKey: true })).toBe(2);
    expect(taskWorkOverviewTabWrap({ focusableCount: 3, activeIndex: 1, shiftKey: false })).toBeNull();
    expect(taskWorkOverviewTabWrap({ focusableCount: 0, activeIndex: -1, shiftKey: false })).toBeNull();
  });
  test("allocates each shuffled canonical row once with exact section counts and shared ordering", () => {
    const freshError = row({ taskId: "fresh-error", status: "errored", startedAtMs: 4 });
    const source = [
      row({ taskId: "z-paused", status: "paused", startedAtMs: 9 }),
      row({ taskId: "b-running", startedAtMs: 7 }),
      row({ taskId: "awaiting", status: "awaiting", startedAtMs: 20 }),
      row({ taskId: "done", status: "done", startedAtMs: 30 }),
      freshError,
      row({ taskId: "a-running", startedAtMs: 7 }),
      row({ taskId: "old-error", status: "errored", startedAtMs: 8 }),
    ];
    const result = projection(source, [freshError], true);

    expect(result).toMatchObject({ empty: false, totalCount: source.length });
    expect(section(result, "needs-you").count).toBe(2);
    expect(section(result, "working-paused").count).toBe(3);
    expect(section(result, "done").count).toBe(2);
    expect(ids(result, "needs-you")).toEqual(["awaiting", "fresh-error"]);
    expect(ids(result, "working-paused")).toEqual(["a-running", "b-running", "z-paused"]);
    expect(ids(result, "done")).toEqual(["old-error", "done"]);
    const allocated = result.sections.flatMap((candidate) => candidate.rows.map((displayRow) => displayRow.row.taskId));
    expect(allocated).toHaveLength(source.length);
    expect(new Set(allocated).size).toBe(source.length);
  });

  test("keeps equal-time task-id ordering stable and ignores live progress for order", () => {
    const source = [
      row({ taskId: "task-b", activity: "First exact update" }),
      row({ taskId: "task-a", activity: "Different exact update" }),
    ];
    const changedProgress = source.map((candidate) => ({ ...candidate, activity: `${candidate.activity}!` }));

    expect(ids(projection(source), "working-paused")).toEqual(["task-a", "task-b"]);
    expect(ids(projection(changedProgress), "working-paused")).toEqual(["task-a", "task-b"]);
  });

  test("preserves canonical rows while rendering valid parent-first hierarchy capped at two visual levels", () => {
    const source = [
      row({ taskId: "great", parentTaskId: "grand", depth: 3, startedAtMs: 1 }),
      row({ taskId: "child", parentTaskId: "root", depth: 1, startedAtMs: 1 }),
      row({ taskId: "root", depth: 0, startedAtMs: 5 }),
      row({ taskId: "grand", parentTaskId: "child", depth: 2, startedAtMs: 1 }),
    ];
    const sourceBefore = JSON.stringify(source);
    const result = projection(source);
    const displayed = section(result, "working-paused").rows;

    expect(displayed.map((item) => [item.row.taskId, item.displayParentTaskId, item.displayDepth])).toEqual([
      ["root", null, 0], ["child", "root", 1], ["grand", "child", 2], ["great", "grand", 2],
    ]);
    expect(displayed.map((item) => item.row)).toContain(source[0]);
    expect(JSON.stringify(source)).toBe(sourceBefore);
  });

  test("degrades every malformed, cross-section, cyclic, and invalid-ancestor relationship to a terminating root", () => {
    const source = [
      row({ taskId: "awaiting-parent", status: "awaiting" }),
      row({ taskId: "cross-section", parentTaskId: "awaiting-parent", depth: 1 }),
      row({ taskId: "orphan", parentTaskId: null, depth: 1 }),
      row({ taskId: "missing", parentTaskId: "gone", depth: 1 }),
      row({ taskId: "self", parentTaskId: "self", depth: 1 }),
      row({ taskId: "cycle-a", parentTaskId: "cycle-b", depth: 1 }),
      row({ taskId: "cycle-b", parentTaskId: "cycle-a", depth: 2 }),
      row({ taskId: "cycle-child", parentTaskId: "cycle-a", depth: 2 }),
      row({ taskId: "negative-depth", depth: -1 }),
      row({ taskId: "fractional-depth", depth: 1.5 }),
      row({ taskId: "jump-parent", depth: 0 }),
      row({ taskId: "depth-jump", parentTaskId: "jump-parent", depth: 3 }),
      row({ taskId: "invalid-ancestor", parentTaskId: "depth-jump", depth: 4 }),
    ];
    const result = projection(source);
    const working = section(result, "working-paused").rows;

    expect(working).toHaveLength(source.length - 1);
    expect(working.every((item) => item.displayDepth === 0)).toBeTrue();
    expect(working.every((item) => item.displayParentTaskId === null)).toBeTrue();
    expect(new Set(working.map((item) => item.row.taskId)).size).toBe(working.length);
    expect(ids(result, "needs-you")).toEqual(["awaiting-parent"]);
  });

  test("retains the bounded Done count while collapsed and reveals only loaded terminal history when expanded", () => {
    const freshError = row({ taskId: "fresh-error", status: "errored" });
    const source = [
      freshError,
      row({ taskId: "old-error", status: "errored", startedAtMs: 2 }),
      row({ taskId: "done", status: "done", startedAtMs: 3 }),
    ];
    const collapsed = projection(source, [freshError]);
    const expanded = projection(source, [freshError], true);

    expect(section(collapsed, "done")).toMatchObject({ count: 2, collapsed: true, rows: [] });
    expect(section(expanded, "done")).toMatchObject({ count: 2, collapsed: false });
    expect(ids(expanded, "done")).toEqual(["old-error", "done"]);
    expect(ids(expanded, "needs-you")).toEqual(["fresh-error"]);
  });

  test("moves a lingering errored row from Needs you to Done exactly once when its linger ends", () => {
    const errored = row({ taskId: "error", status: "errored" });
    const lingering = projection([errored], [errored], true);
    const expired = projection([errored], [], true);

    expect(section(lingering, "needs-you").count).toBe(1);
    expect(section(lingering, "done").count).toBe(0);
    expect(section(expired, "needs-you").count).toBe(0);
    expect(ids(expired, "done")).toEqual(["error"]);
  });

  test("derives empty only from canonical overview rows", () => {
    const result = projection([]);

    expect(result.empty).toBeTrue();
    expect(result.totalCount).toBe(0);
    expect(result.sections.map((candidate) => candidate.count)).toEqual([0, 0, 0]);
    expect(result.sections.flatMap((candidate) => candidate.rows)).toEqual([]);
  });
});
