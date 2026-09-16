import { useState } from "react";
import type { ReactElement } from "react";
import type { TaskSummary } from "@nautilo/types";
import {
  formatCadence,
  formatNextFire,
  isScheduleEnabled,
  scheduleStatusLabel,
} from "./scheduled-tasks-view-model";

/**
 * D406 — one row in the Scheduled tasks management list.
 *
 * Presentational: the page hook owns all API calls + busy state. Toggle maps to
 * pause/unpause (suspend/re-arm the schedule without destroying it); remove maps
 * to stop (terminal) behind an inline confirm.
 */

export interface ScheduledTaskCardProps {
  readonly task: TaskSummary;
  readonly busy?: boolean;
  readonly onEnable: (taskId: string) => void;
  readonly onDisable: (taskId: string) => void;
  readonly onRemove: (taskId: string) => void;
}

export function ScheduledTaskCard({
  task,
  busy = false,
  onEnable,
  onDisable,
  onRemove,
}: ScheduledTaskCardProps): ReactElement {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const enabled = isScheduleEnabled(task.status);
  const agentName = task.agentName?.trim() || "Genie";

  return (
    <li
      className={`flex flex-col gap-1 border-b border-border px-6 py-3 ${enabled ? "" : "opacity-60"}`}
      data-testid="scheduled-task-row"
      data-task-id={task.id}
      data-status={task.status}
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-semibold text-foreground">{agentName}</span>
        <span className="shrink-0 rounded bg-background-panel px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-foreground-muted">
          {task.scheduleKind === "cron" ? "recurring" : "once"}
        </span>
        <span
          className="shrink-0 text-[11px] text-foreground-muted"
          data-testid="scheduled-task-status"
        >
          {scheduleStatusLabel(task.status)}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-foreground-muted">
            <span>{enabled ? "On" : "Off"}</span>
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={() => (enabled ? onDisable(task.id) : onEnable(task.id))}
              className="h-3.5 w-3.5 cursor-pointer disabled:cursor-wait disabled:opacity-40"
              aria-label={enabled ? "Disable schedule" : "Enable schedule"}
              data-testid="scheduled-task-toggle"
            />
          </label>

          {confirmRemove ? (
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setConfirmRemove(false);
                  onRemove(task.id);
                }}
                disabled={busy}
                className="rounded px-1 text-[11px] font-medium text-red-500 hover:underline disabled:cursor-wait disabled:opacity-40"
                data-testid="scheduled-task-remove-confirm"
              >
                confirm
              </button>
              <button
                type="button"
                onClick={() => setConfirmRemove(false)}
                className="rounded px-1 text-[11px] text-foreground-muted hover:text-foreground"
                data-testid="scheduled-task-remove-cancel"
              >
                cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRemove(true)}
              disabled={busy}
              className="rounded px-1 text-[11px] text-foreground-muted hover:text-red-500 disabled:cursor-wait disabled:opacity-40"
              aria-label="Remove schedule"
              title="Remove schedule"
              data-testid="scheduled-task-remove"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      <p className="truncate text-[13px] text-foreground" title={task.prompt}>
        {task.prompt || "(no description)"}
      </p>

      <div className="flex items-center gap-3 text-[11px] text-foreground-muted">
        <span className="font-mono" data-testid="scheduled-task-cadence">
          {formatCadence(task)}
        </span>
        <span data-testid="scheduled-task-next-fire">
          {enabled ? `next ${formatNextFire(task.nextFireAt)}` : "paused"}
          {task.nextFireAt ? (
            <span className="ml-1 text-foreground-muted/60" title={task.nextFireAt}>
              ·
            </span>
          ) : null}
        </span>
      </div>
    </li>
  );
}
