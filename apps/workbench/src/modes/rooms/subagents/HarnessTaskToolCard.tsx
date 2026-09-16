import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { TaskDetail, TaskHarnessActivity } from "@nautilo/types";
import { ResearchProgress } from "../../../components/tool-card/research-progress";
import { ToolCard, type ToolCardProps } from "../../../components/tool-card/tool-card";
import type { ToolCardState } from "../../../components/tool-card/tool-card-helpers";
import {
  useConversationEncryptionPolicyMode,
  useRunningSubagents,
  useToolActivity,
  type ToolActivityEvent,
} from "../../../adapters/runtime-contexts";
import { useTaskState } from "../../../contexts/task-state/task-state-context";
import { useAuth } from "../../../hooks/use-auth";
import { apiClient } from "../../../lib/api";
import { HarnessActivityFeed } from "./HarnessActivityFeed";
import {
  harnessPresentation,
  harnessReceiptEmptyLabel,
  type HarnessPresentation,
} from "./harness-presentation";
import { isToolRow } from "./transcript-vm";
import { useSubagentTranscript } from "./use-subagent-transcript";
import { ScrollableTaskTranscript } from "./VirtualTranscriptRows";
import {
  shouldShowTaskContentAccessRecovery,
  TaskContentAccessRecoveryNotice,
} from "./TaskContentAccessRecoveryNotice";

interface HarnessTaskResult {
  readonly taskId: string;
  readonly status?: string;
  readonly execution?: string;
  readonly message?: string;
}

export function settleHarnessActivity(
  activity: readonly TaskHarnessActivity[],
  terminalStatus: string | undefined,
  terminalAt: number | undefined,
): TaskHarnessActivity[] {
  return activity.map((item) =>
    (terminalStatus === "completed" || terminalStatus === "cancelled" || terminalStatus === "errored") && item.status === "running"
      ? {
          ...item,
          status: terminalStatus === "errored" ? "failed" as const : "completed" as const,
          endedAt: Math.max(item.startedAt, terminalAt ?? item.startedAt),
        }
      : item,
  );
}

export function isHarnessTaskActive(
  canonicalStatus: string | undefined,
  liveStatus: string | undefined,
): boolean {
  const status = canonicalStatus ?? liveStatus;
  return status === "pending" || status === "running" || status === "awaiting" || status === "paused";
}

function taskCardState(status: string | undefined): ToolCardState | undefined {
  switch (status) {
    case "pending": case "running": case "paused": case "awaiting": case "cancelled": return status;
    case "completed": return "success";
    case "errored": return "error";
    default: return undefined;
  }
}

export function parseHarnessTaskResult(value: unknown): HarnessTaskResult | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.taskId !== "string" || record.taskId.length === 0) return null;
  return {
    taskId: record.taskId,
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(typeof record.execution === "string" ? { execution: record.execution } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
  };
}

export function harnessTaskFailureOutcome(
  presentation: HarnessPresentation,
  detail: TaskDetail | null,
  canonicalStatus?: string,
): string | null {
  if (canonicalStatus && canonicalStatus !== "errored") return null;
  if (detail?.task.status !== "errored") return null;
  const latestRun = detail.runs.at(-1);
  const durableResult = latestRun?.resultText?.trim();
  return durableResult || `${presentation.displayName} failed. This older Task did not record a detailed failure outcome. Review the workspace before retrying.`;
}

/**
 * assistant-ui specialization for Nautilo's generic `task` tool.
 *
 * Native `in_background` receipts and reviewed external-harness results become
 * live execution surfaces with canonical Task Stop. Stable activity rows update
 * in place and completed rows replay from the existing Task transcript.
 */
function HarnessTaskToolCard(props: ToolCardProps): ReactElement {
  const events = useToolActivity();
  const taskToolEvent = events.find((event) => event.toolCallId === props.toolCallId);
  const taskResult = useMemo(
    () => parseHarnessTaskResult(taskToolEvent?.result ?? props.result),
    [props.result, taskToolEvent?.result],
  );
  const presentation = harnessPresentation(taskResult?.execution);

  if (!presentation || !taskResult) return <ToolCard {...props} />;
  return (
    <HarnessExecutionToolCard
      {...props}
      taskResult={taskResult}
      taskToolEvent={taskToolEvent}
      presentation={presentation}
    />
  );
}

/** Every tool surface that can return a deterministic external Task receipt. */
export const harnessTaskToolRenderers = {
  task: HarnessTaskToolCard,
  in_background: HarnessTaskToolCard,
} as const;

function HarnessExecutionToolCard({
  taskResult,
  taskToolEvent,
  presentation,
  ...props
}: ToolCardProps & {
  readonly taskResult: HarnessTaskResult;
  readonly taskToolEvent: ToolActivityEvent | undefined;
  readonly presentation: HarnessPresentation;
}): ReactElement {
  const { list } = useRunningSubagents();
  const { busyIds, lastSuccessfulAtMs, stopTask, taskMap } = useTaskState();
  const auth = useAuth();
  const encryptionPolicyMode = useConversationEncryptionPolicyMode();
  const [durableDetail, setDurableDetail] = useState<TaskDetail | null>(null);
  const [stopRequested, setStopRequested] = useState(false);
  const [stopError, setStopError] = useState(false);
  const entry = list.find((item) => item.taskId === taskResult.taskId);
  const liveCanonicalStatus = taskMap[taskResult.taskId]?.status;
  useEffect(() => {
    let current = true;
    setDurableDetail(null);
    void apiClient.getTask(taskResult.taskId).then(
      (detail) => { if (current) setDurableDetail(detail); },
      () => { /* The owner-scoped receipt fallback remains available. */ },
    );
    return () => { current = false; };
  }, [entry?.status, entry?.terminalAtMs, liveCanonicalStatus, taskResult.taskId]);
  const researchProgress = entry ? entry.researchProgress
    : (taskMap[taskResult.taskId] ?? durableDetail?.task)?.preparation?.research;
  const canonicalStatus = liveCanonicalStatus ?? durableDetail?.task.status;
  const taskStatus = canonicalStatus ?? entry?.status ?? taskResult.status;
  const serverOrigin = typeof window === "undefined" ? "" : window.location.origin;
  const viewerId = auth.viewer.sessionUserId ?? "";
  const recoveryScopeKey = `${serverOrigin}\0${auth.viewerGeneration}\0${viewerId}\0${taskResult.taskId}`;
  const showContentAccessRecovery = shouldShowTaskContentAccessRecovery({
    mode: encryptionPolicyMode,
    viewerVerified: auth.viewer.isVerified && viewerId.length > 0 && serverOrigin.length > 0,
    taskId: taskResult.taskId,
    scopeKey: recoveryScopeKey,
  });
  const cancelled = taskStatus === "cancelled" || stopRequested;
  const failureOutcome = harnessTaskFailureOutcome(presentation, durableDetail, canonicalStatus);
  const { messages, error } = useSubagentTranscript(taskResult.taskId, { enabled: true });
  const transcriptTools = messages.filter(isToolRow);
  const lastLiveActivity = useRef<readonly TaskHarnessActivity[]>([]);
  // Durable Task truth wins over a lagging process-local activity overlay.
  // Stoppable work includes parked Tasks; only actual running work gets a
  // spinner or live transcript following. Paused/awaiting canonical status
  // must win even while the process overlay still reports model activity.
  const active = !cancelled && isHarnessTaskActive(taskStatus, undefined);
  const running = !cancelled && taskStatus === "running";
  const syntheticEvent: ToolActivityEvent | undefined = running
    ? {
        toolCallId: props.toolCallId,
        toolName: props.toolName,
        args: props.args,
        status: "running",
        startedAt: taskToolEvent?.startedAt ?? entry?.startedAtMs ?? Date.now(),
        ...(taskToolEvent?.result ? { result: taskToolEvent.result } : {}),
      }
    : taskToolEvent;
  if ((entry?.harnessActivity.length ?? 0) > 0) {
    lastLiveActivity.current = entry!.harnessActivity;
  }
  const activitySource = (entry?.harnessActivity.length ?? 0) > 0
    ? entry!.harnessActivity
    : lastLiveActivity.current;
  const visibleActivity = useMemo(
    () => settleHarnessActivity(
      activitySource,
      !active ? canonicalStatus : undefined,
      entry?.terminalAtMs ?? taskToolEvent?.endedAt,
    ),
    [active, activitySource, canonicalStatus, entry?.terminalAtMs, taskToolEvent?.endedAt],
  );

  return (
    <ToolCard
      {...props}
      displayName={presentation.displayName}
      activityOverride={syntheticEvent}
      stateOverride={
        cancelled ? "cancelled" : taskCardState(taskStatus)
      }
      defaultExpanded
      expandedContent={
        <div
          className="space-y-2 border-t border-border px-3 py-2"
          data-testid="harness-task-tool-body"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium text-foreground">
              {cancelled
                ? presentation.stoppedLabel
                : taskStatus === "errored"
                  ? presentation.failedLabel
                  : taskStatus === "awaiting"
                    ? "Waiting for your reply"
                    : taskStatus === "paused"
                      ? "Paused"
                      : running
                        ? presentation.workingLabel
                        : presentation.taskLabel}
            </span>
            <span className="truncate text-foreground-muted">
              {cancelled
                ? "Stopped by you"
                : taskStatus === "paused"
                  ? "Resume this task to continue."
                  : taskStatus === "awaiting"
                    ? "A reply is needed to continue."
                    : running
                      ? entry?.line3 || taskResult.message || ""
                      : taskStatus === "pending" ? "Waiting to start." : ""}
            </span>
            {active && presentation.supportsTaskStop ? (
              <button
                type="button"
                disabled={busyIds.has(taskResult.taskId)}
                onClick={() => {
                  setStopError(false);
                  void stopTask(taskResult.taskId)
                    .then(() => setStopRequested(true))
                    .catch(() => setStopError(true));
                }}
                className="ml-auto shrink-0 rounded border border-border px-2 py-1 font-medium text-foreground-muted hover:bg-background hover:text-foreground disabled:opacity-50"
              >
                {busyIds.has(taskResult.taskId) ? "Stopping…" : "Stop task"}
              </button>
            ) : null}
          </div>

          {researchProgress && <ResearchProgress progress={researchProgress} />}

          {stopError ? (
            <p className="text-xs text-[var(--error)]" role="alert">
              This Task could not be stopped. Try again.
            </p>
          ) : null}

          {showContentAccessRecovery ? (
            <TaskContentAccessRecoveryNotice
              key={recoveryScopeKey}
              taskId={taskResult.taskId}
              taskStatus={taskStatus}
              scopeKey={recoveryScopeKey}
              discoveryGeneration={lastSuccessfulAtMs ?? 0}
            />
          ) : null}

          {failureOutcome ? (
            <p className="rounded bg-background px-2 py-1.5 text-xs text-foreground-muted" data-testid="harness-task-failure-outcome">
              {failureOutcome}
            </p>
          ) : null}

          {visibleActivity.length > 0 ? (
            <HarnessActivityFeed
              activity={visibleActivity}
              defaultExpanded
              terminalState={cancelled ? "cancelled" : undefined}
            />
          ) : transcriptTools.length > 0 ? (
            <ScrollableTaskTranscript key={taskResult.taskId} messages={transcriptTools} isRunning={running} />
          ) : failureOutcome ? null : (
            <p className="rounded bg-background px-2 py-1.5 text-xs text-foreground-muted">
              {error
                ? `Activity unavailable: ${error}`
                : harnessReceiptEmptyLabel(
                    presentation,
                    cancelled ? "cancelled" : taskStatus,
                    taskResult.status,
                    running,
                  )}
            </p>
          )}
        </div>
      }
    />
  );
}
