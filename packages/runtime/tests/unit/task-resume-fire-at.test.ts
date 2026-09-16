import { describe, test, expect } from "bun:test";
import type { Task } from "@nautilo/db";
import { computeResumeFireAt } from "../../src/tasks/lifecycle";

/**
 * D406 — `computeResumeFireAt` decides when a resumed (unpaused) task next
 * fires. The load-bearing case: toggling a DORMANT recurring schedule back on
 * must re-arm to the next cron occurrence, NOT fire immediately.
 */

type ScheduleFields = Pick<Task, "scheduleKind" | "cron" | "timezone" | "nextFireAt">;

const cronTask: ScheduleFields = {
  scheduleKind: "cron",
  cron: "0 9 * * 1-5", // 09:00 Mon–Fri
  timezone: "UTC",
  nextFireAt: new Date("2026-06-09T09:00:00.000Z"),
};

describe("D406 — computeResumeFireAt", () => {
  test("dormant cron (no checkpoint) re-arms to the NEXT occurrence, not now", () => {
    const now = new Date("2026-06-08T15:00:00Z"); // Monday 3pm
    const { nextFireAt, mode } = computeResumeFireAt(cronTask, false, now);
    expect(mode).toBe("cron_rearm");
    // Next weekday-9am is Tuesday 09:00 UTC — crucially NOT `now` (3pm Monday).
    expect(nextFireAt.toISOString()).toBe("2026-06-09T09:00:00.000Z");
    expect(nextFireAt.getTime()).toBeGreaterThan(now.getTime());
  });

  test("cron re-arm is timezone-aware", () => {
    const now = new Date("2026-06-08T15:00:00Z");
    const { nextFireAt } = computeResumeFireAt(
      { ...cronTask, timezone: "America/New_York" },
      false,
      now,
    );
    // 09:00 New York (EDT, UTC-4 in June) = 13:00 UTC, next day.
    expect(nextFireAt.toISOString()).toBe("2026-06-09T13:00:00.000Z");
  });

  test("a preserved checkpoint fires NOW to continue the parked run", () => {
    const now = new Date("2026-06-08T15:00:00Z");
    const { nextFireAt, mode } = computeResumeFireAt(cronTask, true, now);
    expect(mode).toBe("checkpoint");
    expect(nextFireAt.getTime()).toBe(now.getTime());
  });

  test("future one_shot with no checkpoint preserves its scheduled instant", () => {
    const now = new Date("2026-06-08T15:00:00Z");
    const scheduledFor = new Date("2026-06-09T09:00:00Z");
    const oneShot: ScheduleFields = {
      scheduleKind: "one_shot",
      cron: null,
      timezone: "UTC",
      nextFireAt: scheduledFor,
    };
    const { nextFireAt, mode } = computeResumeFireAt(oneShot, false, now);
    expect(mode).toBe("one_shot_rearm");
    expect(nextFireAt.getTime()).toBe(scheduledFor.getTime());
  });

  test("overdue one_shot with no checkpoint fires NOW (immediate)", () => {
    const now = new Date("2026-06-08T15:00:00Z");
    const oneShot: ScheduleFields = {
      scheduleKind: "one_shot",
      cron: null,
      timezone: "UTC",
      nextFireAt: new Date("2026-06-08T14:00:00Z"),
    };
    const { nextFireAt, mode } = computeResumeFireAt(oneShot, false, now);
    expect(mode).toBe("immediate");
    expect(nextFireAt.getTime()).toBe(now.getTime());
  });

  test("cron kind but missing cron string falls back to immediate (defensive)", () => {
    const now = new Date("2026-06-08T15:00:00Z");
    const { nextFireAt, mode } = computeResumeFireAt(
      { scheduleKind: "cron", cron: null, timezone: "UTC", nextFireAt: null },
      false,
      now,
    );
    expect(mode).toBe("immediate");
    expect(nextFireAt.getTime()).toBe(now.getTime());
  });
});
