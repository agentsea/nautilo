import { getTaskById, type DirectDatabase, type NewTask, type Task } from "@nautilo/db";
import type { SelectionProfile, ComboSpec, TaskHarnessActivity } from "@nautilo/types";

/**
 * Dependency-injection seam for the `task` tool.
 *
 * The `task` tool lives in `@nautilo/agent`, but its `create` command must
 * reach the runtime `createTask` (depth-cap + `next_fire_at` compute +
 * `observer.kick()`), which lives in `@nautilo/runtime`. `@nautilo/agent`
 * cannot import `@nautilo/runtime` (runtime depends on agent — that would be
 * a cycle). Mirroring the existing module-singleton pattern
 * (`setTaskRunDb` / `setTaskObserver` / `jobManager`), server wiring publishes
 * a live DB handle + a bound `createTask` here and the tool reads them.
 *
 * Tests inject a stub runtime (DB-free) via {@link setTaskToolRuntime}.
 */

/** Minimal create input the `task` tool's `create` command forwards. Mirrors
 *  the runtime `TaskCreateInput` (`Omit<NewTask, "nextFireAt" | "status">`)
 *  without importing it from `@nautilo/runtime`. */
export interface TaskToolCreateInput {
  ownerId: string;
  requestorId: string;
  agentId: string;
  prompt: string;
  expectedOutput?: string | undefined;
  scheduleKind?: "now" | "one_shot" | "cron";
  /** Scheduling fields. `one_shot` sets runAt; `cron` sets cron;
   *  timezone interprets cron occurrences. runAt is a Date (shortcut parses
   *  the ISO string) so it stays assignable to the runtime TaskCreateInput. */
  runAt?: Date;
  cron?: string | null;
  timezone?: string;
  callingRoomId?: string | null;
  targetRoomId?: string | null;
  targetChat?: "last_in_namespace" | "new_in_namespace" | "last_dm" | "new_dm" | "orphan";
  targetChatHandle?: string | null;
  resultDelivery?: "wake" | "raw" | "raw_and_wake";
  toolsMode?: "auto" | "none" | "whitelist";
  toolsWhitelist?: string[];
  useScope?: boolean;
  awaitResponse?: boolean;
  depth?: number;
  // Scoping-preset fields. Optional so generic `task create` keeps its
  // minimal shape; the intent shortcuts set them.
  /** Attribution; mirrors the `tasks.preset` enum. */
  preset?:
    | "task"
    | "in_scope"
    | "in_private_namespace"
    | "in_background"
    | "schedule"
    | "ask_peer"
    | "ping"
    | "repo_docs";
  /** Users targeted in the namespace. */
  targetUserIds?: string[];
  /** Pre-existing scope to reuse; null/omitted → dispatch mints an ephemeral one. */
  scopeId?: string | null;
  /** Mirrors the `tasks.metadata jsonb` column. `in_private_namespace`
   *  stores `{ bringBack }` here so the dispatch seam can read it. */
  metadata?: Record<string, unknown>;
  /** Parent linkage (`tasks.parent_task_id`); the runtime
   *  `createTask` derives/enforces the depth cap from `depth`. */
  parentTaskId?: string | null;
  /** Maximum wall-clock seconds before the watchdog pauses a run. */
  timeLimitSeconds?: number | null;
  /** Named selection intent. Defaults to `balanced`. */
  selectionProfile?: SelectionProfile;
  /** Explicit {band?, objective} selection override. */
  selectionSpec?: ComboSpec | null;
  /**
   * Exact model pin. Mutually exclusive with
   * {@link selectionProfile} / {@link selectionSpec}. Null/omitted = no pin
   * (the dispatch seam falls back to the profile/spec resolver). A strict
   * pin: retries use the same model, with no cross-model fallback. Only
   * curated ids are valid in v1.
   */
  requestedModelId?: string | null;
}

/** A deliberate provider-neutral external execution selection. Native task
 * creation stays on {@link TaskToolRuntime.createTask}; this narrow shape is
 * routed through the server, which alone authors sealed execution metadata. */
/** Facts that an external harness may receive before the server seals its
 * execution contract. Native model selection is intentionally excluded. */
export type TaskToolHarnessCreateBaseInput = Omit<
  TaskToolCreateInput,
  "requestedModelId" | "selectionProfile" | "selectionSpec"
>;

export interface TaskToolCodexHarnessCreateInput extends TaskToolHarnessCreateBaseInput {
  harness: "codex";
  collaborationMode: "work" | "plan";
  harnessModelId?: string;
  /** Host-local starting directory. Codex's native posture owns access. */
  workingDirectory?: string;
}

/** Hermes ACP admits only the current owner/Genie/Room prompt. Every routing,
 * scheduling, scope, tool, model, provider, path, and metadata field is
 * server-authored after admission. */
export interface TaskToolHermesAcpHarnessCreateInput {
  readonly ownerId: string;
  readonly requestorId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly callingRoomId: string | null;
  /** Canonical lineage computed by the Task dispatcher, never model-authored. */
  readonly parentTaskId?: string;
  /** Canonical child depth computed from the same exact parent. */
  readonly depth?: number;
  harness: "hermes-acp";
}

/** Claude Code admits only a direct, root Task in the current Room. */
export interface TaskToolClaudeCodeHarnessCreateInput {
  readonly ownerId: string;
  readonly requestorId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly callingRoomId: string | null;
  readonly harness: "claude-code";
  readonly harnessModelId?: string;
}

/** Dormant OpenCode ACP admission seam. The public task schema and dispatcher
 * do not expose this provider until the activation vertical is composed. */
export interface TaskToolOpenCodeAcpHarnessCreateInput {
  readonly ownerId: string;
  readonly requestorId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly callingRoomId: string | null;
  readonly harness: "opencode-acp";
  readonly executionProfile: "interactive" | "autonomous" | "plan";
}

export type TaskToolHarnessCreateInput =
  | TaskToolCodexHarnessCreateInput
  | TaskToolHermesAcpHarnessCreateInput
  | TaskToolClaudeCodeHarnessCreateInput
  | TaskToolOpenCodeAcpHarnessCreateInput;

export type TaskToolHarnessCreateResult = {
  taskId: string;
  status: string;
  execution: "codex";
} | {
  taskId: string;
  status: string;
  execution: "hermes-acp";
} | {
  taskId: string;
  status: string;
  execution: "opencode-acp";
} | {
  taskId: string;
  status: string;
  execution: "claude-code";
  model: {
    readonly catalogModelId: string;
    readonly selectedModel: string;
  };
};

export interface TaskToolHarnessSteerInput {
  readonly taskId: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly roomId: string;
  readonly text: string;
}

export interface TaskToolHarnessSteerResult {
  readonly ok: true;
  readonly status: "steered";
}

/** Server-owned optional enrichment for a generic Task read in its calling Room. */
export interface TaskToolHarnessInspection {
  readonly taskRunId: string;
  readonly jobId: string;
  readonly jobStatus: string | null;
  readonly jobCreatedAt: string | null;
  readonly jobStartedAt: string | null;
  readonly jobCompletedAt: string | null;
  /** Null means the linked Job exists but this process has not observed a semantic Codex event. */
  readonly lastActivityAt: string | null;
  readonly activity: readonly TaskHarnessActivity[];
}

/**
 * Result of a lifecycle command, mirroring the runtime
 * `TaskLifecycleResult` without importing `@nautilo/runtime` (cycle).
 */
export interface TaskToolLifecycleResult {
  ok: boolean;
  status: string;
  message: string;
}

export type TaskToolCreateLineageResult =
  | Readonly<{ ok: true; parentTaskId?: string; depth: number }>
  | Readonly<{ ok: false; message: string }>;

/** One canonical parent/depth resolver shared by advanced and shortcut creates. */
export async function resolveTaskToolCreateLineage(input: {
  ownerId: string;
  db: DirectDatabase;
  currentTaskId?: string;
  requestedParentTaskId?: string;
}): Promise<TaskToolCreateLineageResult> {
  if (input.currentTaskId) {
    const parent = await getTaskById(input.db, input.currentTaskId);
    if (!parent || parent.ownerId !== input.ownerId) {
      return { ok: false, message: "Cannot create task: current task not found." };
    }
    if (
      input.requestedParentTaskId !== undefined
      && input.requestedParentTaskId !== parent.id
    ) {
      return { ok: false, message: "Cannot create task: parent task conflicts with the current task." };
    }
    return { ok: true, parentTaskId: parent.id, depth: parent.depth + 1 };
  }
  if (input.requestedParentTaskId) {
    const parent = await getTaskById(input.db, input.requestedParentTaskId);
    if (!parent || parent.ownerId !== input.ownerId) {
      return { ok: false, message: "Cannot create task: parent task not found." };
    }
    return { ok: true, parentTaskId: parent.id, depth: parent.depth + 1 };
  }
  return { ok: true, depth: 0 };
}

export interface TaskToolRuntime {
  onDefinitionChanged?(task: Pick<Task, "id" | "ownerId" | "status">): void;
  db: DirectDatabase;
  /** Production policy fence until Agent Task content publication and reads are wired. */
  canUseLegacyTaskContent?(): Promise<boolean>;
  /**
   * Trusted live classification for an otherwise bounded native root Task
   * selection. The server resolves the effective Agent default/profile/exact
   * model against the caller's runnable union and returns true only when that
   * model has no permitted server-funded route. No credential material crosses
   * this seam.
   */
  isPersonalOnlyTaskSelection?(input: Readonly<{
    requestorId: string;
    agentId: string;
    callingRoomId: string;
    requestedModelId?: string | null;
    selectionProfile?: SelectionProfile | null;
    selectionSpec?: ComboSpec | null;
  }>): Promise<boolean>;
  /**
   * Server-owned funding admission for mutations that can make a Task
   * runnable. Production composition rechecks the effective Task selection
   * and live funding authority before persistence or unpause. The seam stays
   * optional for legacy test runtimes; personal-control callers fail closed
   * when it is absent.
   */
  assertMutationFunding?(input: Readonly<{
    task: Task;
    operation: "update" | "unpause";
    patch?: Readonly<Partial<NewTask>>;
  }>): Promise<void>;
  /** Server-published opt-in. Omitted runtimes retain the legacy tool surface. */
  readonly claudeCodeTasksEnabled?: true;
  /** Bound to runtime `createTask({ db, observer }, input)`. */
  createTask(
    input: TaskToolCreateInput,
  ): Promise<{ taskId: string; status: string; nextFireAt?: Date | undefined }>;
  /**
   * Server-owned harness admission. Optional during bootstrap/test
   * wiring so legacy Native task callers retain their established seam.
   */
  createHarnessTask?(
    input: TaskToolHarnessCreateInput,
  ): Promise<TaskToolHarnessCreateResult>;
  listHarnessModels?(input: {
    readonly ownerId: string;
    readonly harness: "codex" | "claude-code";
  }): Promise<readonly {
    readonly id: string;
    readonly displayName: string;
    readonly description: string;
    readonly isDefault: boolean;
    readonly isPreferred: boolean;
  }[]>;
  /** Explicit same-turn steering; ordinary messages never enter this path. */
  steerHarnessTask?(
    input: TaskToolHarnessSteerInput,
  ): Promise<TaskToolHarnessSteerResult>;
  /**
   * Optional live execution view. The server owns both its authorization and
   * its process-local cache; the agent package never reaches browser state.
   */
  inspectHarnessTask?(input: {
    readonly taskId: string;
    readonly ownerId: string;
    readonly agentId: string;
    readonly roomId: string;
  }): Promise<TaskToolHarnessInspection | null>;
  /**
   * Bound to runtime `computeNextFireAt`. `@nautilo/agent` cannot
   * import `@nautilo/runtime` (cycle), so the `update` command reaches the
   * shared schedule compute through this seam (same pattern as `createTask`).
   */
  computeNextFireAt(
    scheduleKind: "now" | "one_shot" | "cron",
    runAt: Date | null | undefined,
    cron: string | null | undefined,
    timezone: string,
    now?: Date,
  ): Date;
  /**
   * Lifecycle operations, bound to runtime `pauseTask`/`unpauseTask`/
   * `stopTask` (same cycle-avoidance DI pattern as `createTask`). The
   * dispatcher does the owner check BEFORE calling these.
   */
  /** Owner-checked read affordance; unpause repeats canonical eligibility and authority checks. */
  canResumeResearch?(task: Task): Promise<boolean>;
  pauseTask(taskId: string): Promise<TaskToolLifecycleResult>;
  unpauseTask(taskId: string): Promise<TaskToolLifecycleResult>;
  stopTask(taskId: string): Promise<TaskToolLifecycleResult>;
}

let _taskToolRuntime: TaskToolRuntime | null = null;

export function setTaskToolRuntime(runtime: TaskToolRuntime | null): void {
  _taskToolRuntime = runtime;
}

export function getTaskToolRuntime(): TaskToolRuntime {
  if (!_taskToolRuntime) {
    throw new Error(
      "task-tool runtime not set — call setTaskToolRuntime() (server wiring / test setup) before the task tool runs",
    );
  }
  return _taskToolRuntime;
}

/** Safe before server composition and in legacy test runtimes. */
export function isClaudeCodeTasksEnabled(): boolean {
  return _taskToolRuntime?.claudeCodeTasksEnabled === true;
}
