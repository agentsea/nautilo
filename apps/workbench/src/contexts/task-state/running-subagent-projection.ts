import { TASK_DESKTOP_WAIT_TEXT, TASK_PROVIDER_WAIT_TEXT, taskPreparationText } from "@nautilo/types";
/**
 * M214 Phase 8 — pure projection from owner-scoped `TaskSummary` rows to the
 * Subagent activity dock view-model. Extracted from `nautilo-runtime.tsx` so
 * the shared task store and unit tests can reuse it without pulling WS wiring.
 */

import {
  isTerminalTaskPresentationStatus,
  normalizeTaskPresentationStatus,
  parseTaskPresentationTimestamp,
  taskPresentationActivityText,
  taskPresentationLifecycleText,
  type TaskSummary,
} from "@nautilo/types";
import {
  type RunningSubagent,
  type RunningSubagentStatus,
  type SubagentKind,
} from "../../modes/rooms/subagents/running-subagents-model";

const SUBAGENT_KINDS = new Set<SubagentKind>([
  "in_scope",
  "in_background",
  "ask_peer",
  "in_private_namespace",
  "schedule",
  "task",
  "repo_docs",
]);

/** Map wire `tasks.status` → card status; `null` = drop (pending / unknown). */
export function mapTaskStatusToCardStatus(
  taskStatus: string,
): RunningSubagentStatus | null {
  return normalizeTaskPresentationStatus(taskStatus);
}

function mapPresetToKind(preset: string): SubagentKind | null {
  if (SUBAGENT_KINDS.has(preset as SubagentKind)) {
    return preset as SubagentKind;
  }
  return null;
}

/** Coarse lifecycle line when no `task.progress` has arrived yet. */
export function defaultLine3ForStatus(status: RunningSubagentStatus): string {
  return taskPresentationLifecycleText(status);
}

export function taskSummaryToRunningSubagent(
  task: TaskSummary,
  statusOverride?: RunningSubagentStatus | null,
): RunningSubagent | null {
  const status = statusOverride ?? mapTaskStatusToCardStatus(task.status);
  if (!status) return null;
  const startedAtMs = parseTaskPresentationTimestamp(task.createdAt);
  return {
    ...(status === "errored" && task.canResumeResearch === true ? { canResumeResearch: true } : {}),
    taskId: task.id,
    parentTaskId: task.parentTaskId,
    depth: task.depth,
    taskRunId: null,
    agentName: task.agentName?.trim() || "Genie",
    modelId: task.lastModelId ?? null,
    kind: mapPresetToKind(task.preset),
    harnessId: task.harnessId ?? null,
    prompt: task.prompt,
    status,
    // Seed/reconnect has no exact progress event to retain. Use only shared
    // lifecycle copy until a fresh `task.progress.detail` arrives.
    line3: status === "paused" && (task.lastError === TASK_DESKTOP_WAIT_TEXT || task.lastError === TASK_PROVIDER_WAIT_TEXT) ? task.lastError
      : taskPresentationActivityText(status, status === "running" && task.preparation ? taskPreparationText(task.preparation) : undefined),
    researchProgress: task.preparation?.research,
    recentActivity: [],
    harnessActivity: [],
    awaitingRoomId:
      null,
    startedAtMs,
    terminalAtMs: isTerminalTaskPresentationStatus(status)
      ? parseTaskPresentationTimestamp(task.updatedAt ?? task.createdAt)
      : null,
  };
}

/** Overlay fields WS events add on top of the seeded `TaskSummary` row. */
export interface RunningSubagentOverlay {
  taskRunId?: string | null;
  /** The run that entered terminal linger; only a different `task.fired` may reset it. */
  terminalTaskRunId?: string | null;
  line3?: string;
  researchProgress?: RunningSubagent["researchProgress"];
  awaitingRoomId?: string | null;
  startedAtMs?: number;
  terminalAtMs?: number | null;
  status?: RunningSubagentStatus;
  recentActivity?: readonly string[];
  harnessActivity?: RunningSubagent["harnessActivity"];
}

function mergeRunningSubagentProjection(
  task: TaskSummary,
  overlay: RunningSubagentOverlay | undefined,
): RunningSubagent | null {
  const canonicalStatus = mapTaskStatusToCardStatus(task.status);
  // A fetched completed/errored Task is durable truth and must never be
  // resurrected by an older in-memory running/paused overlay. An event terminal
  // overlay may still linger a cron Task whose durable status is already pending.
  const status =
    canonicalStatus && (isTerminalTaskPresentationStatus(canonicalStatus)
      || canonicalStatus === "paused" && (task.lastError === TASK_DESKTOP_WAIT_TEXT || task.lastError === TASK_PROVIDER_WAIT_TEXT))
      ? canonicalStatus
      : (overlay?.status ?? canonicalStatus);
  if (!status) return null;
  const base = taskSummaryToRunningSubagent(task, status);
  if (!base) return null;
  if (!overlay) return base;
  const terminal = isTerminalTaskPresentationStatus(status);
  return {
    ...base,
    taskRunId: overlay.taskRunId ?? base.taskRunId,
    status,
    // Terminal lifecycle wins its linger. Stale progress/activity cannot be
    // rendered after completion or error.
    line3: terminal ? defaultLine3ForStatus(status)
      : status === "paused" && (task.lastError === TASK_DESKTOP_WAIT_TEXT || task.lastError === TASK_PROVIDER_WAIT_TEXT) ? task.lastError
      : (overlay.line3 ?? base.line3),
    researchProgress: overlay.researchProgress !== undefined ? overlay.researchProgress
      : overlay.taskRunId && overlay.taskRunId !== task.preparation?.taskRunId ? null : base.researchProgress,
    recentActivity: terminal ? [] : (overlay.recentActivity ?? base.recentActivity),
    harnessActivity: terminal ? [] : (overlay.harnessActivity ?? base.harnessActivity),
    awaitingRoomId:
      terminal
        ? null
        : overlay.awaitingRoomId !== undefined
        ? overlay.awaitingRoomId
        : base.awaitingRoomId,
    startedAtMs: overlay.startedAtMs ?? base.startedAtMs,
    terminalAtMs:
      terminal && !isTerminalTaskPresentationStatus(overlay.status ?? status)
        ? base.terminalAtMs
        : overlay.terminalAtMs !== undefined ? overlay.terminalAtMs : base.terminalAtMs,
  };
}

export function buildRunningSubagentsMap(
  taskMap: Readonly<Record<string, TaskSummary>>,
  overlays: Readonly<Record<string, RunningSubagentOverlay>>,
  visibleTaskIds: ReadonlySet<string>,
): Readonly<Record<string, RunningSubagent>> {
  const next: Record<string, RunningSubagent> = {};
  for (const taskId of visibleTaskIds) {
    const task = taskMap[taskId];
    if (!task) continue;
    const mapped = mergeRunningSubagentProjection(task, overlays[taskId]);
    if (mapped) next[taskId] = mapped;
  }
  return next;
}
