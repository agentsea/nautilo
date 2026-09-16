/**
 * D307 (Stack 87) — pure, runtime-free model for the Subagent activity dock.
 *
 * Kept separate from the hook/component so the logic is unit-testable without
 * a DOM or a live WebSocket, mirroring `members-panel-model.ts` (D278).
 *
 * The list uses the available panel height. Action-needed cards (`awaiting` /
 * `errored`) sort first so they remain easy to discover above the fold. The sort is
 * status-priority with a stable start-time tiebreak and NEVER reorders on live
 * activity (line-3 updates do not change status or start time → row order is
 * stable; the stop button never becomes a moving target).
 */

import {
  compareTaskPresentationItems,
  isTerminalTaskPresentationStatus,
  sortTaskPresentationItems,
  TASK_PRESENTATION_STATUS_PRIORITY,
  TASK_PRESENTATION_TERMINAL_LINGER_MS,
  type TaskPreparationProgress,
  type TaskPresentationHierarchy,
  type TaskPresentationStatus,
} from "@nautilo/types";

/** D547 shared lifecycle vocabulary; Desktop keeps this alias for its UI API. */
export type RunningSubagentStatus = TaskPresentationStatus;

/** A subagent's delegation kind, from the task `preset`. */
export type SubagentKind =
  | "in_scope"
  | "in_background"
  | "ask_peer"
  | "in_private_namespace"
  | "schedule"
  | "task"
  | "repo_docs";

/**
 * View-model for one card. Deliberately decoupled from the wire `task.*`
 * events: the hook normalizes WS payloads + the seed fetch into this shape so
 * the model stays dependency-free and testable. Line 3 is `line3` (coarse
 * lifecycle text in P1–2; the live `task.progress` tool step in P3).
 */
export interface RunningSubagent extends TaskPresentationHierarchy {
  /** Owner-verified recovery affordance, revalidated by unpause. */
  readonly canResumeResearch?: boolean;
  readonly taskId: string;
  readonly taskRunId: string | null;
  /** Resolved agent display name (enriched `TaskSummary.agentName`); "Genie" fallback. */
  readonly agentName: string;
  /** Model the run executed on (`TaskRunSummary.modelId` / `TaskSummary.lastModelId`). */
  readonly modelId: string | null;
  readonly kind: SubagentKind | null;
  /** External harness selected for this Task, when it is not Nautilo-native. */
  readonly harnessId: string | null;
  /** One-line description (truncated task prompt). */
  readonly prompt: string;
  readonly status: RunningSubagentStatus;
  /** Live work line (lifecycle-coarse in P1–2; tool step in P3). */
  readonly line3: string;
  /** Latest accepted ledger counts; null clears the prior run on a new firing. */
  readonly researchProgress?: TaskPreparationProgress["research"] | null;
  /** Bounded, newest-last semantic activity received during this live run. */
  readonly recentActivity: readonly string[];
  /** Rich activity cards, merged in place by stable harness item id. */
  readonly harnessActivity: readonly TaskHarnessActivity[];
  /** Present for `awaiting` cards — the room a human reply must land in. */
  readonly awaitingRoomId: string | null;
  /**
   * Epoch ms the run started (from `task.fired` receipt or seeded `createdAt`).
   * Stable tiebreak key — never recomputed on activity.
   */
  readonly startedAtMs: number;
  /**
   * Epoch ms the card entered a terminal state (`done`/`errored`), or null.
   * The hook uses this to drive the ~5s linger-then-dismiss (Q3).
   */
  readonly terminalAtMs: number | null;
}

/**
 * Status priority for the dock sort (lower = higher in the list). Action-needed
 * states float to the top of the scrollable list.
 */
export const STATUS_PRIORITY: Record<RunningSubagentStatus, number> =
  TASK_PRESENTATION_STATUS_PRIORITY;

/** True for terminal states (eligible for linger-then-dismiss). */
export function isTerminalStatus(status: RunningSubagentStatus): boolean {
  return isTerminalTaskPresentationStatus(status);
}

/**
 * Comparator: status-priority first, then stable start-time ascending (oldest
 * first), then taskId for total determinism. Does NOT read `line3` / progress,
 * so live activity never reorders rows.
 */
export function compareRunningSubagents(a: RunningSubagent, b: RunningSubagent): number {
  return compareTaskPresentationItems(a, b);
}

export function sortRunningSubagents(list: readonly RunningSubagent[]): RunningSubagent[] {
  return sortTaskPresentationItems(list);
}

/**
 * The collapsed heartbeat bar payload (§5.12): the count + a single live line
 * that **prioritizes any action-needed card** so a collapsed dock still signals
 * when the user is the blocker.
 */
export interface SubagentHeartbeat {
  readonly count: number;
  /** The line to show next to the count, or "" when nothing is running. */
  readonly line: string;
}

/**
 * Derive the heartbeat from the live set. Picks the top-of-sort card; if any
 * card is action-needed (`awaiting`/`errored`) that one wins regardless of
 * start time, so the bar screams when attention is required.
 */
export function deriveHeartbeat(list: readonly RunningSubagent[]): SubagentHeartbeat {
  if (list.length === 0) return { count: 0, line: "" };
  const sorted = sortRunningSubagents(list);
  const top = sorted[0];
  const lead =
    top.status === "awaiting"
      ? `${top.agentName} needs your reply`
      : top.status === "errored"
        ? `${top.agentName} errored`
        : top.status === "paused"
          ? `${top.agentName} paused`
        : top.status === "done"
          ? `${top.agentName} completed`
        : `${top.agentName} › ${top.line3 || "working…"}`;
  return { count: list.length, line: lead };
}

/** Default ms a terminal (`done`/`errored`) card lingers before auto-dismiss (Q3). */
export const TERMINAL_LINGER_MS = TASK_PRESENTATION_TERMINAL_LINGER_MS;
import type { TaskHarnessActivity } from "@nautilo/types";
