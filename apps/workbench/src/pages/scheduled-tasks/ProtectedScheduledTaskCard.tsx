import { useState, type ReactElement } from "react";
import type { ProtectedScheduledTaskRow } from "./use-scheduled-tasks";
import {
  formatNextFire,
  isScheduleEnabled,
  scheduleStatusLabel,
} from "./scheduled-tasks-view-model";

export function ProtectedScheduledTaskCard({
  row,
  busy = false,
  onEnable,
  onDisable,
  onRemove,
}: Readonly<{
  row: ProtectedScheduledTaskRow;
  busy?: boolean;
  onEnable(taskId: string): void;
  onDisable(taskId: string): void;
  onRemove(taskId: string): void;
}>): ReactElement {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { task } = row;
  const enabled = isScheduleEnabled(task.status);
  const cadence = task.scheduleKind === "cron" ? task.cron || "recurring" : "once";
  const unavailableLabel = row.availability === "unavailable"
    ? protectedTaskUnavailableLabel(row.reason)
    : null;

  return (
    <li className={`flex flex-col gap-1 border-b border-border px-6 py-3 ${enabled ? "" : "opacity-60"}`}
      data-testid="protected-scheduled-task-row" data-task-id={task.id}
      data-status={task.status}>
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-semibold text-foreground">
          {task.agentName?.trim() || "Genie"}
        </span>
        <span className="shrink-0 rounded bg-background-panel px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-foreground-muted">
          protected
        </span>
        <span className="shrink-0 text-[11px] text-foreground-muted">
          {scheduleStatusLabel(task.status)}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-foreground-muted">
            <span>{enabled ? "On" : "Off"}</span>
            <input type="checkbox" checked={enabled} disabled={busy}
              onChange={() => (enabled ? onDisable(task.id) : onEnable(task.id))}
              aria-label={enabled ? "Disable protected schedule" : "Enable protected schedule"}
              className="h-3.5 w-3.5 cursor-pointer disabled:cursor-wait disabled:opacity-40" />
          </label>
          {confirmRemove ? (
            <span className="flex items-center gap-1">
              <button type="button" disabled={busy} className="rounded px-1 text-[11px] font-medium text-red-500"
                onClick={() => { setConfirmRemove(false); onRemove(task.id); }}>
                confirm
              </button>
              <button type="button" className="rounded px-1 text-[11px] text-foreground-muted"
                onClick={() => setConfirmRemove(false)}>cancel</button>
            </span>
          ) : (
            <button type="button" disabled={busy} aria-label="Remove protected schedule"
              className="rounded px-1 text-[11px] text-foreground-muted hover:text-red-500"
              onClick={() => setConfirmRemove(true)}>Remove</button>
          )}
        </div>
      </div>
      {row.availability === "opened" ? (
        <p className="truncate text-[13px] text-foreground" title={row.prompt}>
          {row.prompt}
        </p>
      ) : (
        <p className="text-[13px] text-foreground-muted" role="status">
          {unavailableLabel}
        </p>
      )}
      <div className="flex items-center gap-3 text-[11px] text-foreground-muted">
        <span className="font-mono">{cadence}</span>
        <span>{enabled ? `next ${formatNextFire(task.nextFireAt)}` : "paused"}</span>
      </div>
    </li>
  );
}

function protectedTaskUnavailableLabel(
  reason: Extract<ProtectedScheduledTaskRow, { availability: "unavailable" }>["reason"],
): string {
  switch (reason) {
    case "waiting_for_authorization":
      return "Waiting for an available authorized device. This task will unlock automatically.";
    case "device_not_ready":
      return "Waiting for this device to become ready. This task will unlock automatically.";
    case "authority_changed":
      return "Task access changed. Refresh to try again.";
    case "unsupported_client":
      return "This client cannot unlock the task.";
    case "integrity_failure":
      return "Task content could not be verified.";
  }
}
