import type { TaskPresentationStatus } from "@nautilo/types";

import type { TaskWorkOverviewDisplayRow } from "./task-work-overview-presentation";

export type TaskWorkOverviewRowPresentation = {
  readonly prompt: string;
  readonly agentName: string;
  /** Text is deliberately primary: color is never the only lifecycle cue. */
  readonly statusLabel: string;
  readonly activity: string;
  readonly timing: string;
  readonly needsAttention: boolean;
  /** Both values are display projection values, never raw Task ancestry. */
  readonly displayParentTaskId: string | null;
  readonly displayDepth: number;
};

/**
 * Keep compact-row copy pure and deliberately literal. Activity is passed
 * through from the canonical projection: it is exact progress or the shared
 * fixed lifecycle fallback, never a transcript/tool-derived paraphrase.
 */
export function presentTaskWorkOverviewRow(input: {
  readonly displayRow: TaskWorkOverviewDisplayRow;
  readonly needsAttention: boolean;
  readonly nowMs: number;
}): TaskWorkOverviewRowPresentation {
  const { row } = input.displayRow;
  return {
    // Render every nonempty server value byte-for-byte; whitespace is only
    // inspected to decide whether the fixed missing-identity fallback applies.
    prompt: row.task.prompt.trim() ? row.task.prompt : "Untitled task",
    agentName: row.task.agentName?.trim() ? row.task.agentName : "Assigned Genie",
    statusLabel: taskWorkStatusLabel(row.status),
    activity: row.activity,
    timing: taskWorkRowTiming(row.status, row.startedAtMs, row.terminalAtMs, input.nowMs),
    needsAttention: input.needsAttention,
    displayParentTaskId: input.displayRow.displayParentTaskId,
    displayDepth: input.displayRow.displayDepth,
  };
}

/** Running is the only earned visual state; reduced motion always remains static. */
export function shouldAnimateTaskWorkOverviewRow(status: TaskPresentationStatus, reducedMotion: boolean): boolean {
  return status === "running" && !reducedMotion;
}

export function taskWorkStatusLabel(status: TaskPresentationStatus): string {
  switch (status) {
    case "awaiting": return "Waiting for you";
    case "running": return "Working";
    case "paused": return "Paused";
    case "done": return "Completed";
    case "errored": return "Needs attention";
  }
}

/** Canonical timestamps only; invalid/future values never produce invented time. */
export function taskWorkRowTiming(
  status: TaskPresentationStatus,
  startedAtMs: number,
  terminalAtMs: number | null,
  nowMs: number,
): string {
  if (!Number.isFinite(nowMs)) return "Time unavailable";
  if ((status === "done" || status === "errored") && terminalAtMs !== null) {
    return relativeTaskWorkTime(status === "done" ? "Completed" : "Errored", terminalAtMs, nowMs);
  }
  if (!Number.isFinite(startedAtMs) || startedAtMs > nowMs) return "Time unavailable";
  return `Elapsed ${compactDuration(nowMs - startedAtMs)}`;
}

function relativeTaskWorkTime(prefix: string, timestampMs: number, nowMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs > nowMs) return "Time unavailable";
  const duration = compactDuration(nowMs - timestampMs);
  return duration === "now" ? `${prefix} now` : `${prefix} ${duration} ago`;
}

function compactDuration(durationMs: number): string {
  const seconds = Math.floor(Math.max(0, durationMs) / 1_000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
