import { useState, type ReactElement } from "react";
import type { TaskRunSummaryV1 } from "@nautilo/types";
import type { EncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import type { WorkbenchProtectedHumanTaskController } from
  "../../lib/protected-human-task-controller";
import { ProtectedTaskRunResult } from
  "../../modes/rooms/subagents/ProtectedTaskRunResult";
import type {
  ProtectedScheduledTaskHistory,
  ProtectedScheduledTaskRow,
} from "./use-scheduled-tasks";
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
  controller,
  owner,
  scopeKey,
  history,
  onOpenHistory,
  onCloseHistory,
}: Readonly<{
  row: ProtectedScheduledTaskRow;
  busy?: boolean;
  onEnable(taskId: string): void;
  onDisable(taskId: string): void;
  onRemove(taskId: string): void;
  controller: WorkbenchProtectedHumanTaskController | undefined;
  owner: EncryptionDataOperationOwner;
  scopeKey: string;
  history: ProtectedScheduledTaskHistory | null;
  onOpenHistory(taskId: string): void;
  onCloseHistory(taskId: string): void;
}>): ReactElement {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [selectedRun, setSelectedRun] = useState<Readonly<{
    scopeKey: string;
    taskId: string;
    taskRunId: string;
  }> | null>(null);
  const { task } = row;
  const controllable = task.status === "pending" || task.status === "running"
    || task.status === "awaiting" || task.status === "paused";
  const enabled = controllable && isScheduleEnabled(task.status);
  const cadence = task.scheduleKind === "cron" ? task.cron || "recurring" : "once";
  const unavailableLabel = row.availability === "unavailable"
    ? protectedTaskUnavailableLabel(row.reason)
    : null;
  const currentHistory = history?.taskId === task.id ? history : null;
  const selectedRunId = selectedRun !== null
    && selectedRun.scopeKey === scopeKey
    && selectedRun.taskId === task.id
    && currentHistory?.state === "ready"
    && currentHistory.runs.some((run) => run.id === selectedRun.taskRunId)
    ? selectedRun.taskRunId
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
            <input type="checkbox" checked={enabled} disabled={busy || !controllable}
              onChange={() => (enabled ? onDisable(task.id) : onEnable(task.id))}
              aria-label={!controllable ? "Finished protected schedule"
                : enabled ? "Disable protected schedule" : "Enable protected schedule"}
              className="h-3.5 w-3.5 cursor-pointer disabled:cursor-wait disabled:opacity-40" />
          </label>
          {confirmRemove ? (
            <span className="flex items-center gap-1">
              <button type="button" disabled={busy || !controllable} className="rounded px-1 text-[11px] font-medium text-red-500"
                onClick={() => { setConfirmRemove(false); onRemove(task.id); }}>
                confirm
              </button>
              <button type="button" className="rounded px-1 text-[11px] text-foreground-muted"
                onClick={() => setConfirmRemove(false)}>cancel</button>
            </span>
          ) : (
            <button type="button" disabled={busy || !controllable} aria-label="Remove protected schedule"
              className="rounded px-1 text-[11px] text-foreground-muted hover:text-red-500"
              onClick={() => setConfirmRemove(true)}>Remove</button>
          )}
        </div>
      </div>
      {row.availability === "opened" ? (
        <>
          <p className="truncate text-[13px] text-foreground" title={row.prompt}>
            {row.prompt}
          </p>
          {row.retainedHistoricalError !== null ? (
            <p className="truncate text-[11px] text-foreground-muted"
              data-testid="task-retained-historical-error"
              title={row.retainedHistoricalError}>
              Earlier error: {row.retainedHistoricalError}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-[13px] text-foreground-muted" role="status">
          {unavailableLabel}
        </p>
      )}
      <div className="flex items-center gap-3 text-[11px] text-foreground-muted">
        <span className="font-mono">{cadence}</span>
        <span>{!controllable ? "No future runs"
          : enabled ? `next ${formatNextFire(task.nextFireAt)}` : "paused"}</span>
        {row.availability === "opened" ? (
          <button type="button" className="font-medium text-primary"
            aria-expanded={currentHistory !== null}
            onClick={() => {
              setSelectedRun(null);
              if (currentHistory === null) onOpenHistory(task.id);
              else onCloseHistory(task.id);
            }}>
            {currentHistory === null ? "Run history" : "Hide runs"}
          </button>
        ) : null}
      </div>
      {currentHistory !== null ? (
        <div className="mt-2 space-y-2 border-t border-border pt-2"
          data-testid="protected-scheduled-task-history">
          {currentHistory.state === "loading" ? (
            <p className="text-xs text-foreground-muted" role="status">
              Loading run history…
            </p>
          ) : currentHistory.state === "error" ? (
            <div className="flex items-center gap-2 text-xs text-red-500" role="alert">
              <span>{currentHistory.message}</span>
              <button type="button" className="font-medium underline"
                onClick={() => onOpenHistory(task.id)}>Try again</button>
            </div>
          ) : currentHistory.runs.length === 0 ? (
            <p className="text-xs text-foreground-muted" role="status">
              No runs yet.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5" aria-label="Protected task runs">
                {currentHistory.runs.map((run, index) => {
                  const label = protectedRunLabel(run, index);
                  return (
                    <button key={run.id} type="button"
                      aria-pressed={selectedRunId === run.id}
                      className={`rounded border px-2 py-1 text-[11px] ${
                        selectedRunId === run.id
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border text-foreground-muted"
                      }`}
                      onClick={() => setSelectedRun({
                        scopeKey,
                        taskId: task.id,
                        taskRunId: run.id,
                      })}>
                      <span>{label}</span>
                      <span className="ml-1 uppercase">{run.status}</span>
                    </button>
                  );
                })}
              </div>
              {selectedRunId === null ? (
                <p className="text-xs text-foreground-muted" role="status">
                  Choose a run to open its protected result.
                </p>
              ) : (
                <ProtectedTaskRunResult
                  agentId={task.agentId}
                  controller={controller}
                  owner={owner}
                  scopeKey={scopeKey}
                  taskId={task.id}
                  taskRunId={selectedRunId}
                />
              )}
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}

function protectedRunLabel(run: TaskRunSummaryV1, index: number): string {
  const timestamp = run.completedAt ?? run.startedAt;
  if (timestamp === null) return `Run ${index + 1}`;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return `Run ${index + 1}`;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
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
      return "Locked — Task content could not be verified.";
  }
}
