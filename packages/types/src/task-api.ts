/**
 * M146 (Phase 5) — HTTP request/response contracts for the Task primitive's
 * create/read/list/update API (`POST/GET/PATCH /api/tasks` + `GET
 * /api/tasks/:id`). Single-sources the shape the route module and the `task`
 * tool's JSON output both consume. Mirrors how `jobs` exposes
 * `CreateBackgroundJobRequest` / `JobStatusResponse`.
 *
 * Lifecycle (`pause`/`unpause`/`stop`) is M147 / Phase 6 — see
 * {@link TaskLifecycleResponse}. Still-deferred params (`await_response`,
 * `privacy_mode`, `*_dm` targets, cross-user `target_user_ids`) are deliberately
 * NOT in these types (R3 — rejected, never persisted) until their engine ships.
 * (`time_limit_seconds` graduated in M147; `privacy_mode` was replaced by the
 * M152 `selectionProfile` / `selectionSpec` multi-axis fields below.)
 */

import type { SelectionProfile, ComboSpec } from "./model-selection";

export type TaskScheduleKind = "now" | "one_shot" | "cron";

/** Phase-5 reachable `target_chat` values (DM targets are Phase 7). */
export type TaskTargetChat = "orphan" | "last_in_namespace" | "new_in_namespace";

export type TaskToolsArg = string[];

export type TaskResultDelivery = "wake" | "raw" | "raw_and_wake";

/** Body for `POST /api/tasks`. All optional except `prompt`. `runAt` is an ISO string. */
export interface TaskCreatePayload {
  prompt: string;
  expectedOutput?: string;
  scheduleKind?: TaskScheduleKind;
  /** ISO-8601 string; required when `scheduleKind === "one_shot"`. */
  runAt?: string;
  /** Raw 5-field cron; required when `scheduleKind === "cron"`. */
  cron?: string;
  /** IANA timezone for cron compute/display; defaults from context, NULL→"UTC". */
  timezone?: string;
  targetChat?: TaskTargetChat;
  useScope?: boolean;
  scopeId?: string | null;
  tools?: TaskToolsArg;
  resultDelivery?: TaskResultDelivery;
  parentTaskId?: string | null;
  /** M147 — max wall-clock seconds before the watchdog auto-pauses a run. */
  timeLimitSeconds?: number | null;
  /** M152 — named model-selection intent (Tier-1). Defaults to `balanced`. */
  selectionProfile?: SelectionProfile;
  /** M152 — explicit {band?, objective} selection override (Tier-2). */
  selectionSpec?: ComboSpec | null;
  /**
   * D429 Phase 3 — exact model pin (strict same-model pin; no cross-model
   * fallback). Mutually exclusive with `selectionProfile` / `selectionSpec`.
   * Only curated ids returned by the resolved catalog are valid in v1. Null
   * (or omitted) = no pin (the dispatch seam falls back to the profile/spec
   * resolver).
   */
  requestedModelId?: string | null;
}

/** Body for `PATCH /api/tasks/:id` — the mutable subset (pending/paused only). */
export interface TaskUpdatePayload {
  prompt?: string;
  expectedOutput?: string;
  scheduleKind?: TaskScheduleKind;
  runAt?: string;
  cron?: string;
  timezone?: string;
  targetChat?: TaskTargetChat;
  tools?: TaskToolsArg;
  resultDelivery?: TaskResultDelivery;
  /** M147 — max wall-clock seconds before the watchdog auto-pauses a run. */
  timeLimitSeconds?: number | null;
  /** M152 — named model-selection intent (Tier-1). */
  selectionProfile?: SelectionProfile;
  /** M152 — explicit {band?, objective} selection override (Tier-2). */
  selectionSpec?: ComboSpec | null;
  /**
   * D429 Phase 3 — exact model pin. Explicit clearing semantics: `null`
   * clears the pin; a string sets it; omission preserves the existing value.
   * Mutually exclusive with `selectionProfile` / `selectionSpec`.
   */
  requestedModelId?: string | null;
}

/** M147 (R8) — response for `POST /api/tasks/:id/{pause,unpause,stop}`. */
export interface TaskLifecycleResponse {
  taskId: string;
  status: string;
  message: string;
}

/** M147 (R8b) — response for `POST /api/jobs/:id/stop`. */
export interface JobStopResponse {
  stopped: boolean;
}

/** D349 — response for conversation-scoped `POST /api/rooms/:id/stop`. */
export interface RoomStopResponse {
  stopped: boolean;
  stoppedJobs: number;
  /** Durable Tasks terminalized through calling-Room or target-Room ownership. */
  stoppedTasks?: number;
  droppedQueuedTurns: number;
  droppedBufferedLanes: number;
}

export interface RoomActiveJobsResponse {
  jobIds: string[];
}

/** Query for `GET /api/tasks`. */
export interface ListTasksQuery {
  status?: string;
  /**
   * Include terminal tasks. HTTP callers receive a server-bounded,
   * newest-first terminal window alongside the complete non-terminal set.
   * Omit (or set false) for active work only.
   */
  includeTerminal?: boolean;
  /**
   * Optional size for the recent terminal window. The server supplies a small
   * default and clamps this to its documented hard maximum; it has no effect
   * without terminal inclusion (or an exact terminal `status`).
   */
  recentTerminalLimit?: number;
}

/** Compact row for list/summary surfaces. */
export interface TaskSummary {
  /** Owner-only verified recovery affordance; unpause revalidates current authority and checkpoint. */
  canResumeResearch?: boolean;
  /** Latest fixed preparation stage; no source or tool arguments. */
  preparation?: import("./realtime").TaskPreparationProgress & { taskRunId: string; updatedAt: string };
  id: string;
  /**
   * Canonical parent Task, or `null` when this row is a root or its parent was
   * deleted. Pair with `depth`: a null parent at depth > 0 is an orphaned
   * lineage, not a client-authored root.
   */
  parentTaskId: string | null;
  /** Server-authored nesting depth. Root Tasks are depth 0. */
  depth: number;
  status: string;
  preset: string;
  /** Server-authored external harness selected for this Task, when any. */
  harnessId?: string | null;
  /** Truncated prompt (≤ 80 chars) for list views. */
  prompt: string;
  scheduleKind: string;
  /** Raw 5-field cron expression for `cron` schedules; null/absent otherwise. */
  cron?: string | null;
  nextFireAt: string | null;
  callingRoomId: string | null;
  /** Stable Task-level pause/error reason; null while no reason is recorded. */
  lastError: string | null;
  /**
   * M152 — the model id the task's MOST RECENT run actually used (resolved by
   * the multi-axis selection at dispatch). `null` when the task has not run yet
   * (no `task_runs` row).
   */
  lastModelId?: string | null;
  /**
   * D429 Phase 3 — the exact model id the task is PINNED to (the requested
   * selection), distinct from `lastModelId` (the actual run model). `null` /
   * absent when no exact pin is set (the run uses the M152 profile/spec
   * resolver).
   */
  requestedModelId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  targetRoomId?: string | null;
  /** ISO-8601 */
  createdAt?: string;
  /** ISO-8601 server-authored lifecycle/update time; terminal recency uses this key. */
  updatedAt?: string;
}

/** One run of a task. */
export interface TaskRunSummary {
  id: string;
  status: string;
  /** M152 — the model id this run actually executed on (resolved at dispatch). */
  modelId: string | null;
  resultText: string | null;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /**
   * M163 — the run's agent-authored transcript (`assistant`/`tool` rows only),
   * present for EVERY task (no longer orphan-only). May be `[]` for peer-owned
   * DM sessions read under the requester's RLS context.
   */
  transcript?: TaskRunTranscriptMessage[];
}

/** M163 — one tool call the agent emitted on an `assistant` turn. */
export interface TaskRunToolCall {
  name: string;
  args: Record<string, unknown>;
  id: string | null;
}

/**
 * One message from a run's agent-authored transcript (`assistant`/`tool` rows
 * only). M163 added `toolCalls`, the agent's own per-turn tool inputs.
 */
export interface TaskRunTranscriptMessage {
  /** Authoritative persisted tool presentation; absent for legacy rows. */
  toolCallId?: string;
  toolStatus?: "success" | "error";
  role: string;
  content: string;
  toolName: string | null;
  /** M163 — parsed tool-call args; non-null only on assistant rows with tool calls. */
  toolCalls: TaskRunToolCall[] | null;
  createdAt: string;
}

/** Full detail for `GET /api/tasks/:id`. */
export interface TaskDetail {
  task: TaskSummary & {
    expectedOutput: string | null;
    cron: string | null;
    runAt: string | null;
    timezone: string;
    targetChat: string;
    resultDelivery: string;
    useScope: boolean;
    scopeId: string | null;
    toolsMode: string;
    toolsWhitelist: string[];
    /** M152 — the task's model-selection intent + explicit override. */
    selectionProfile: SelectionProfile;
    selectionSpec: ComboSpec | null;
    /**
     * D429 Phase 3 — the exact model id the task is pinned to (the requested
     * selection), distinct from the per-run actual model in `runs[].modelId`.
     * `null` when no exact pin is set.
     */
    requestedModelId: string | null;
    createdAt: string;
    updatedAt: string;
  };
  runs: TaskRunSummary[];
}

/** 201 response for `POST /api/tasks`. */
export interface TaskCreateResponse {
  taskId: string;
  status: string;
  nextFireAt: string | null;
}
