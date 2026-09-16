import { describe, test, expect } from "bun:test";
import type { TaskSummary } from "@nautilo/types";
import {
  compareByNextFire,
  filterBySearch,
  filterScheduledTasks,
  formatCadence,
  formatNextFire,
  isScheduleEnabled,
  scheduleStatusLabel,
} from "../../src/pages/scheduled-tasks/scheduled-tasks-view-model";

function task(over: Partial<TaskSummary>): TaskSummary {
  return {
    id: "t",
    parentTaskId: null,
    depth: 0,
    status: "pending",
    preset: "schedule",
    prompt: "do the thing",
    scheduleKind: "cron",
    cron: "0 9 * * 1-5",
    nextFireAt: "2026-07-10T09:00:00.000Z",
    callingRoomId: null,
    ...over,
  };
}

describe("D406 — scheduled-tasks view-model", () => {
  test("filterScheduledTasks keeps only cron/one_shot, drops now/background", () => {
    const list = [
      task({ id: "a", scheduleKind: "cron" }),
      task({ id: "b", scheduleKind: "one_shot" }),
      task({ id: "c", scheduleKind: "now" }),
    ];
    const out = filterScheduledTasks(list);
    expect(out.map((t) => t.id).sort()).toEqual(["a", "b"]);
  });

  test("sorts by soonest next fire, nulls last, stable by id", () => {
    const soon = task({ id: "soon", nextFireAt: "2026-07-10T09:00:00.000Z" });
    const later = task({ id: "later", nextFireAt: "2026-07-20T09:00:00.000Z" });
    const never = task({ id: "never", nextFireAt: null });
    const out = filterScheduledTasks([never, later, soon]);
    expect(out.map((t) => t.id)).toEqual(["soon", "later", "never"]);
  });

  test("compareByNextFire tiebreaks by id when fire times equal", () => {
    const a = task({ id: "a" });
    const b = task({ id: "b" });
    expect(compareByNextFire(a, b)).toBeLessThan(0);
  });

  test("isScheduleEnabled: paused is off, everything else on", () => {
    expect(isScheduleEnabled("paused")).toBe(false);
    expect(isScheduleEnabled("pending")).toBe(true);
    expect(isScheduleEnabled("running")).toBe(true);
    expect(isScheduleEnabled("awaiting")).toBe(true);
  });

  test("formatCadence shows raw cron for cron, 'once' for one_shot", () => {
    expect(formatCadence(task({ scheduleKind: "cron", cron: "0 9 * * 1-5" }))).toBe("0 9 * * 1-5");
    expect(formatCadence(task({ scheduleKind: "cron", cron: null }))).toBe("recurring");
    expect(formatCadence(task({ scheduleKind: "one_shot", cron: null }))).toBe("once");
  });

  test("formatNextFire is coarse + relative", () => {
    const now = new Date("2026-07-10T08:00:00.000Z");
    expect(formatNextFire("2026-07-10T08:30:00.000Z", now)).toBe("in 30m");
    expect(formatNextFire("2026-07-10T11:00:00.000Z", now)).toBe("in 3h");
    expect(formatNextFire("2026-07-12T08:00:00.000Z", now)).toBe("in 2d");
    expect(formatNextFire("2026-07-10T07:00:00.000Z", now)).toBe("due now");
    expect(formatNextFire(null, now)).toBe("—");
  });

  test("scheduleStatusLabel maps pending→active", () => {
    expect(scheduleStatusLabel("pending")).toBe("active");
    expect(scheduleStatusLabel("paused")).toBe("paused");
    expect(scheduleStatusLabel("running")).toBe("running");
  });

  describe("filterBySearch", () => {
    const list = [
      task({ id: "a", prompt: "send weekly digest", agentName: "Genie" }),
      task({ id: "b", prompt: "backup database", agentName: "Ops", cron: "0 2 * * 0" }),
      task({ id: "c", prompt: "standup reminder", scheduleKind: "one_shot", cron: null }),
    ];

    test("empty query returns all (copy, not the same array)", () => {
      const out = filterBySearch(list, "  ");
      expect(out.map((t) => t.id)).toEqual(["a", "b", "c"]);
      expect(out).not.toBe(list);
    });

    test("matches prompt (case-insensitive)", () => {
      expect(filterBySearch(list, "DIGEST").map((t) => t.id)).toEqual(["a"]);
    });

    test("matches agent name", () => {
      expect(filterBySearch(list, "ops").map((t) => t.id)).toEqual(["b"]);
    });

    test("matches raw cron", () => {
      expect(filterBySearch(list, "0 2 * * 0").map((t) => t.id)).toEqual(["b"]);
    });

    test("matches cadence kind synonyms (once / recurring)", () => {
      expect(filterBySearch(list, "once").map((t) => t.id)).toEqual(["c"]);
      expect(filterBySearch(list, "recurring").map((t) => t.id).sort()).toEqual(["a", "b"]);
    });

    test("no match returns empty", () => {
      expect(filterBySearch(list, "nonexistent")).toEqual([]);
    });
  });
});
