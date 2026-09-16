/**
 * D406 — pure view-model for the Scheduled tasks management page.
 *
 * Kept free of React / DOM / network so the filter + formatting logic is
 * unit-testable in isolation (mirrors `memory-view-model.ts`).
 */

import type { TaskSummary } from "@nautilo/types";

/** The `scheduleKind`s that represent a real, user-facing schedule. */
const SCHEDULE_KINDS: ReadonlySet<string> = new Set(["cron", "one_shot"]);

/**
 * A schedule is "on" unless it has been explicitly paused (toggled off). The
 * live states (`pending`/`running`/`awaiting`) all mean the schedule is armed.
 */
export function isScheduleEnabled(status: string): boolean {
  return status !== "paused";
}

function nextFireMs(t: TaskSummary): number {
  if (!t.nextFireAt) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(t.nextFireAt);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** Sort by soonest next fire; null/never-firing last; stable by id. */
export function compareByNextFire(a: TaskSummary, b: TaskSummary): number {
  const am = nextFireMs(a);
  const bm = nextFireMs(b);
  if (am !== bm) return am - bm;
  return a.id.localeCompare(b.id);
}

/**
 * Keep only real schedules (`cron` / `one_shot`) out of the mixed active-task
 * list (which also carries transient `now`/background/ping tasks), soonest
 * first.
 */
export function filterScheduledTasks(tasks: readonly TaskSummary[]): TaskSummary[] {
  return tasks.filter((t) => SCHEDULE_KINDS.has(t.scheduleKind)).sort(compareByNextFire);
}

/**
 * Free-text filter over the schedule list. Matches (case-insensitive) against
 * the prompt, owning agent, raw cron, cadence kind, and status so a user can
 * find a task by any of the things visible on its row. Empty query → unchanged.
 */
export function filterBySearch(
  tasks: readonly TaskSummary[],
  query: string,
): TaskSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return tasks.slice();
  return tasks.filter((t) => {
    const haystack = [
      t.prompt,
      t.agentName ?? "",
      t.cron ?? "",
      t.scheduleKind === "cron" ? "recurring cron" : "once one_shot",
      t.status,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Cadence label for a row. `cron` shows the raw 5-field expression (locked v1
 * decision — no cron→prose compiler yet); `one_shot` shows "once".
 */
export function formatCadence(task: TaskSummary): string {
  if (task.scheduleKind === "cron") return task.cron ? task.cron : "recurring";
  if (task.scheduleKind === "one_shot") return "once";
  return task.scheduleKind;
}

/**
 * Humanized next-fire, relative to `now`. Returns e.g. "in 5m", "in 3h",
 * "in 2d", "due now", or "—" when there is no scheduled fire. Deliberately
 * coarse — the exact instant is available on hover / in detail.
 */
export function formatNextFire(nextFireAt: string | null, now: Date = new Date()): string {
  if (!nextFireAt) return "—";
  const target = Date.parse(nextFireAt);
  if (!Number.isFinite(target)) return "—";
  const deltaMs = target - now.getTime();
  if (deltaMs <= 0) return "due now";

  const mins = Math.round(deltaMs / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

/** Short status label for the row. */
export function scheduleStatusLabel(status: string): string {
  switch (status) {
    case "paused":
      return "paused";
    case "running":
      return "running";
    case "awaiting":
      return "waiting";
    case "pending":
      return "active";
    default:
      return status;
  }
}
