import {
  finalizeProtectedTaskCheckpointPause,
  getLatestResumableTaskRun,
  getTaskById,
  getTaskLifecycleState,
  getTaskByIdWithMutationVersion,
  requestProtectedTaskCheckpointPause,
  resumeProtectedTaskCheckpointPause,
  updateTaskIfCurrent,
  transitionTaskLifecyclePaused,
  transitionTaskLifecycleTerminal,
  taskRequiresLocalExecutionRecapture,
  TASK_LOCAL_EXECUTION_RECREATE_TEXT,
  type DirectDatabase,
  type Task,
  type TaskLifecycleState,
} from "@nautilo/db";
import { log } from "@nautilo/logger";
import { randomUUID } from "node:crypto";
import { eventBus } from "../event-bus";
import { assertTaskFundingAdmission } from "../task-funding-port";
import { nextCronOccurrence } from "./cron";
import { getTaskObserver } from "./task-runtime-context";
import {
  getTaskWriterReviewBinding,
  hasTaskWriterReviewAcceptanceClaim,
  removeTaskReturnBinding,
  type TaskWriterReviewBinding,
} from "./task-return-binding";
import { holdSecurityResearchDesktop, recoverSecurityResearchContextFailure } from "./security-report-recovery";
import { reportBackTaskCancellation } from "./report-back";

/**
 * Task lifecycle: pause / unpause / stop.
 *
 * Each function is OWNER-AGNOSTIC — the caller (the `task` tool command or the
 * HTTP route) performs the owner check (`task.ownerId !== ctx.ownerId ⇒ "Task
 * not found."`) BEFORE calling here. Ordinary pause and Stop ride the shared
 * {@link JobManager.abortJob} seam.
 * Protected pause is cooperative: it requests a safe encrypted checkpoint,
 * waits for every process-owned run, and acknowledges `paused` only after the
 * database has verified the durable park receipts.
 *
 * Idempotent: pausing an already-paused task, stopping a terminal task, etc.
 * are friendly no-ops (never throw).
 */

/** The slice of `JobManager` the lifecycle needs (injectable for tests). */
export interface TaskLifecycleJobManager {
  abortJob(jobId: string, reason?: "pause" | "stop", taskRun?: { taskId: string; taskRunId: string }): boolean;
  abortProtectedTaskRunAndWait?(input: Readonly<{
    taskId: string;
    taskRunId: string;
    jobId: string;
  }>): Promise<Readonly<{ status: "stopped" | "unavailable" }>>;
  requestProtectedTaskCheckpointPauseAndWait?(input: Readonly<{
    taskId: string;
    taskRunId: string;
    jobId: string;
    pauseRequestId: string;
    reason: "manual_pause" | "time_limit";
  }>): Promise<Readonly<{ status: "settled" | "unavailable" }>>;
}

export interface TaskLifecycleDeps {
  db: DirectDatabase;
  jobManager: TaskLifecycleJobManager;
  /** Terminal cancellation delivery seam. Injectable for focused unit tests. */
  reportBackCancellation?: typeof reportBackTaskCancellation;
  /**
   * Override the observer kicked on unpause. Defaults to the process observer
   * published via `setTaskObserver` (server wiring). Test seam.
   */
  observer?: { kick(): void } | null;
  /**
   * App composition closes the exact visible Writer proposal after the Stop
   * transition has durably won, before runtime discards the binding.
   */
  onStoppedWriterReview?: (binding: TaskWriterReviewBinding) => void | Promise<void>;
}

export interface TaskLifecycleResult {
  ok: boolean;
  /** The task's status after the call (or the reason it was a no-op). */
  status: string;
  message: string;
}

const WRITER_REVIEW_AWAITING_METADATA_KEY = "writerReviewAwaiting";

function taskMetadata(task: Pick<Task, "metadata">): Record<string, unknown> {
  const metadata = task.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : {};
}

/** A typed external review is a parked receipt wait, never provider work. */
function isAwaitingWriterReview(task: Pick<Task, "status" | "metadata">): boolean {
  if (task.status !== "awaiting") return false;
  const marker = taskMetadata(task)[WRITER_REVIEW_AWAITING_METADATA_KEY];
  return Boolean(
    marker
    && typeof marker === "object"
    && !Array.isArray(marker)
    && (marker as Record<string, unknown>)["version"] === 1
    && typeof (marker as Record<string, unknown>)["taskRunId"] === "string"
    && typeof (marker as Record<string, unknown>)["proposalId"] === "string",
  );
}

function emitTaskStatus(taskId: string, ownerId: string, status: string): void {
  eventBus.emit({ type: "task.status", taskId, ownerId, status });
}

function hasProtectedContent(task: Pick<Task, "contentRepresentation">): boolean {
  return task.contentRepresentation === "protected" || task.contentRepresentation === "dual";
}

function taskObserver(deps: TaskLifecycleDeps): { kick(): void } | null {
  return deps.observer ?? getTaskObserver();
}

function protectedPausePending(task: Pick<Task, "status">): TaskLifecycleResult {
  return {
    ok: true,
    status: task.status,
    message: "Task pause requested; waiting for a safe checkpoint.",
  };
}

async function pauseProtectedTask(
  deps: TaskLifecycleDeps,
  task: Pick<TaskLifecycleState, "id" | "ownerId" | "requestorId" | "status"
    | "pauseRequestId" | "pauseRequestedAt" | "pauseReason">,
  reason: "pause" | "time_limit",
): Promise<TaskLifecycleResult> {
  const storedRequest = task.pauseRequestId !== null
    && task.pauseRequestedAt !== null
    && (task.pauseReason === "manual_pause" || task.pauseReason === "time_limit")
    ? {
        pauseRequestId: task.pauseRequestId,
        requestedAt: task.pauseRequestedAt,
        reason: task.pauseReason,
      }
    : null;
  const request = await requestProtectedTaskCheckpointPause(deps.db, {
    taskId: task.id,
    requesterUserId: task.requestorId,
    pauseRequestId: storedRequest?.pauseRequestId ?? randomUUID(),
    reason: storedRequest?.reason ?? (reason === "pause" ? "manual_pause" : "time_limit"),
    requestedAt: storedRequest?.requestedAt ?? new Date(),
  });
  if (request.status !== "requested" && request.status !== "exact_replay") {
    const current = await getTaskLifecycleState(deps.db, task.id);
    if (!current) return { ok: false, status: "not_found", message: "Task not found." };
    return {
      ok: false,
      status: current.status,
      message: request.status === "conflict"
        ? "Task pause request changed. Reload and try again."
        : `Cannot pause a ${current.status} task.`,
    };
  }

  const pause = deps.jobManager.requestProtectedTaskCheckpointPauseAndWait === undefined
    ? null
    : (input: Parameters<NonNullable<TaskLifecycleJobManager[
        "requestProtectedTaskCheckpointPauseAndWait"
      ]>>[0]) => deps.jobManager.requestProtectedTaskCheckpointPauseAndWait!(input);
  if (pause) {
    await Promise.allSettled(request.runs.map(async run => {
      if (run.jobId === null) return;
      await pause({
        taskId: task.id,
        taskRunId: run.taskRunId,
        jobId: run.jobId,
        pauseRequestId: request.request.pauseRequestId,
        reason: request.request.reason,
      });
    }));
  }

  const finalized = await finalizeProtectedTaskCheckpointPause(deps.db, {
    taskId: task.id,
    pauseRequestId: request.request.pauseRequestId,
  });
  if (finalized === "paused" || finalized === "exact_replay") {
    emitTaskStatus(task.id, task.ownerId, "paused");
    log(`[task-lifecycle] checkpoint-paused task=${task.id} reason=${request.request.reason}`);
    return {
      ok: true,
      status: "paused",
      message: finalized === "exact_replay" ? "Task is already paused." : "Task paused.",
    };
  }

  const current = await getTaskLifecycleState(deps.db, task.id);
  if (!current) return { ok: false, status: "not_found", message: "Task not found." };
  if (finalized === "pending") {
    taskObserver(deps)?.kick();
    return protectedPausePending(current);
  }
  return { ok: false, status: current.status, message: `Cannot pause a ${current.status} task.` };
}

/**
 * R2 — pause an ordinary Task through its atomic status transition and abort,
 * or ask a protected Task to drain into a verified encrypted checkpoint. The
 * time-limit watchdog (R5) uses the same representation-aware route.
 */
export async function pauseTask(
  deps: TaskLifecycleDeps,
  taskId: string,
  reason: "pause" | "time_limit" = "pause",
): Promise<TaskLifecycleResult> {
  const { db, jobManager } = deps;
  const current = await getTaskLifecycleState(db, taskId);
  if (!current) return { ok: false, status: "not_found", message: "Task not found." };
  if (hasProtectedContent(current)) {
    return pauseProtectedTask(deps, current, reason);
  }
  if (reason === "pause") await holdSecurityResearchDesktop(db, taskId);
  const result = await transitionTaskLifecyclePaused(db, taskId);
  const { task, run } = result;
  if (result.outcome === "protected_checkpoint_required") {
    if (!result.protectedTask) {
      return { ok: false, status: "not_found", message: "Task not found." };
    }
    return pauseProtectedTask(deps, result.protectedTask, reason);
  }
  if (!task) return { ok: false, status: "not_found", message: "Task not found." };
  if (result.outcome === "already_paused") {
    return { ok: true, status: "paused", message: "Task is already paused." };
  }
  if (result.outcome === "task_terminal") {
    return { ok: false, status: task.status, message: `Cannot pause a ${task.status} task.` };
  }
  if (result.outcome === "writer_review_pending") {
    return { ok: false, status: "awaiting",
      message: "Task is already awaiting external Writer review; there is no provider work to pause." };
  }
  // Admission and finalization share the committed paused pair's row lock.
  // Any worker admitted first is now found by exact run; later claims fail.
  if (run) jobManager.abortJob(run.jobId ?? "", "pause", { taskId, taskRunId: run.id });
  emitTaskStatus(taskId, task.ownerId, "paused");
  log(`[task-lifecycle] paused task=${taskId} reason=${reason} run=${run?.id ?? "none"}`);
  return { ok: true, status: "paused", message: "Task paused." };
}

async function unpauseProtectedTask(
  deps: TaskLifecycleDeps,
  task: TaskLifecycleState,
): Promise<TaskLifecycleResult> {
  if (task.pauseRequestId === null) {
    return {
      ok: false,
      status: task.status,
      message: task.status === "paused"
        ? "Cannot resume a protected Task without its safe checkpoint request."
        : `Cannot resume a ${task.status} task (only paused tasks resume).`,
    };
  }
  if (task.status !== "paused") {
    taskObserver(deps)?.kick();
    return {
      ok: false,
      status: task.status,
      message: "Task is still waiting for its safe checkpoint before it can resume.",
    };
  }

  const fundingSnapshot = await getTaskLifecycleState(deps.db, task.id);
  if (!fundingSnapshot || fundingSnapshot.status !== "paused"
    || !hasProtectedContent(fundingSnapshot)
    || fundingSnapshot.pauseRequestId !== task.pauseRequestId) {
    return {
      ok: false,
      status: fundingSnapshot?.status ?? "not_found",
      message: "Task changed before resume. Reload and try again.",
    };
  }
  if (fundingSnapshot.localExecutionRecaptureRequired) {
    return { ok: false, status: "paused", message: TASK_LOCAL_EXECUTION_RECREATE_TEXT };
  }
  if (fundingSnapshot.fundingOutcomeUncertain
    && (fundingSnapshot.latestRunPaused || fundingSnapshot.scheduleKind !== "cron")) {
    return { ok: false, status: "paused",
      message: "The previous provider outcome is uncertain. Review its saved result and start a fresh Task." };
  }
  // This only clears a verified pause intent. Fresh grant admission owns
  // funding and source revalidation before resumed execution can begin.

  const resumed = await resumeProtectedTaskCheckpointPause(deps.db, {
    taskId: task.id,
    requesterUserId: fundingSnapshot.requestorId,
    pauseRequestId: task.pauseRequestId,
  });
  const current = await getTaskLifecycleState(deps.db, task.id);
  if (!current) return { ok: false, status: "not_found", message: "Task not found." };
  if (resumed !== "resumed") {
    if (resumed === "pending") taskObserver(deps)?.kick();
    if (resumed === "recapture_required") {
      return { ok: false, status: current.status, message: TASK_LOCAL_EXECUTION_RECREATE_TEXT };
    }
    if (resumed === "funding_uncertain") {
      return { ok: false, status: current.status,
        message: "The previous provider outcome is uncertain. Review its saved result and start a fresh Task." };
    }
    return {
      ok: false,
      status: current.status,
      message: resumed === "pending"
        ? "Task is still waiting for its safe checkpoint before it can resume."
        : "Task pause request changed. Reload and try again.",
    };
  }

  taskObserver(deps)?.kick();
  emitTaskStatus(task.id, task.ownerId, current.status);
  log(`[task-lifecycle] checkpoint-resumed task=${task.id} status=${current.status}`);
  return { ok: true, status: current.status, message: "Task resumed." };
}

export type ResumeFireMode =
  | "checkpoint"
  | "cron_rearm"
  | "one_shot_rearm"
  | "immediate";

/**
 * Decide when a resumed (unpaused) task should next fire. Pure +
 * timezone-aware so it is unit-testable without a DB.
 *
 *  - A preserved checkpoint (`hasResumableRun`) → fire NOW to continue the
 *    parked run.
 *  - Otherwise a dormant `cron` schedule → its NEXT natural occurrence, so
 *    toggling a recurring task back on does not fire immediately.
 *  - A future `one_shot` with no checkpoint → preserve its scheduled instant.
 *    Pausing a reminder before it fires must not turn Resume into Run now.
 *  - An overdue `one_shot`, or a `now` task with no checkpoint → fire NOW.
 */
export function computeResumeFireAt(
  task: Pick<Task, "scheduleKind" | "cron" | "timezone" | "nextFireAt">,
  hasResumableRun: boolean,
  now: Date,
): { nextFireAt: Date; mode: ResumeFireMode } {
  if (hasResumableRun) return { nextFireAt: now, mode: "checkpoint" };
  if (task.scheduleKind === "cron" && task.cron) {
    return {
      nextFireAt: nextCronOccurrence(task.cron, task.timezone, now),
      mode: "cron_rearm",
    };
  }
  if (
    task.scheduleKind === "one_shot" &&
    task.nextFireAt &&
    task.nextFireAt.getTime() > now.getTime()
  ) {
    return { nextFireAt: task.nextFireAt, mode: "one_shot_rearm" };
  }
  return { nextFireAt: now, mode: "immediate" };
}

/**
 * R4 — resume a paused Task. A protected Task clears only its verified durable
 * pause intent and keeps the same Run/thread. An ordinary Task has two cases,
 * decided by whether a preserved checkpoint exists:
 *
 *  1. **Checkpoint resume** (a parked `paused` run exists — the task was paused
 *     mid-run by the user or the time-limit watchdog): set `next_fire_at = now`
 *     so the observer re-claims it immediately and `dispatchTaskRun` continues
 *     from the parked run's `graphThreadId` (does NOT cold-start).
 *  2. **Schedule re-arm** (no parked run; the task was a *dormant*
 *     recurring schedule toggled off while sleeping between fires): re-arm to
 *     the NEXT natural cron occurrence rather than firing immediately. Toggling
 *     a "every weekday 9am" reminder back on at 3pm must not fire at 3pm — it
 *     should simply resume the schedule. A future one-shot likewise preserves
 *     its original scheduled instant; only an overdue one-shot or a `now` task
 *     with no checkpoint fires immediately.
 *
 * Clears any fire-lock and kicks the observer. Idempotent on a non-paused task.
 */
export async function unpauseTask(
  deps: TaskLifecycleDeps,
  taskId: string,
): Promise<TaskLifecycleResult> {
  const { db } = deps;
  const state = await getTaskLifecycleState(db, taskId);
  if (!state) return { ok: false, status: "not_found", message: "Task not found." };
  if (hasProtectedContent(state)) return unpauseProtectedTask(deps, state);
  const task = await getTaskById(db, taskId, { ordinaryOnly: true });
  if (!task) return { ok: false, status: "not_found", message: "Task not found." };
  if (task.status === "errored" && await recoverSecurityResearchContextFailure(db, task)) {
    const observer = deps.observer ?? getTaskObserver();
    observer?.kick();
    emitTaskStatus(taskId, task.ownerId, "pending");
    return { ok: true, status: "pending", message: "Saved research resumed after its local context failure." };
  }
  if (task.status !== "paused") {
    return {
      ok: false,
      status: task.status,
      message: `Cannot resume a ${task.status} task (only paused tasks resume).`,
    };
  }
  if (taskRequiresLocalExecutionRecapture(task)) {
    return { ok: false, status: "paused", message: TASK_LOCAL_EXECUTION_RECREATE_TEXT };
  }
  // Defensive compatibility fence: a legacy caller must not turn an
  // externally-reviewed run into a fresh provider dispatch merely because it
  // managed to write `paused` before this lifecycle was installed.
  if (isAwaitingWriterReview({ ...task, status: "awaiting" })) {
    return {
      ok: false,
      status: "paused",
      message: "Cannot resume a Task awaiting external Writer review.",
    };
  }

  // A parked (`paused`) run means there is a checkpoint to continue → fire now.
  // Absent that, a `cron` task is a dormant schedule → re-arm to its next
  // occurrence instead of firing on re-enable.
  const fundingSnapshot = await getTaskByIdWithMutationVersion(db, taskId, { ordinaryOnly: true });
  if (!fundingSnapshot || fundingSnapshot.status !== "paused") {
    return { ok: false, status: fundingSnapshot?.status ?? "not_found", message: "Task changed before resume. Reload and try again." };
  }
  if (taskRequiresLocalExecutionRecapture(fundingSnapshot)) {
    return { ok: false, status: "paused", message: TASK_LOCAL_EXECUTION_RECREATE_TEXT };
  }
  const resumableRun = await getLatestResumableTaskRun(db, taskId);
  if (
    fundingSnapshot?.lastError === "funding_interrupted_uncertain"
    && (resumableRun || fundingSnapshot.scheduleKind !== "cron")
  ) {
    return { ok: false, status: "paused",
      message: "The previous provider outcome is uncertain. Review its saved result and start a fresh Task." };
  }
  await assertTaskFundingAdmission(fundingSnapshot ?? task, resumableRun);
  const { nextFireAt, mode: resumeMode } = computeResumeFireAt(
    fundingSnapshot ?? task,
    Boolean(resumableRun),
    new Date(),
  );

  const patch = { status: "pending" as const, nextFireAt, fireLockId: null, fireLockedAt: null };
  {
    const rearmed = await updateTaskIfCurrent(db, {
      id: taskId, ownerId: fundingSnapshot.ownerId, expectedStatus: "paused",
      expectedMutationVersion: fundingSnapshot.mutationVersion,
      expectedContentRevision: fundingSnapshot.contentRevision,
    }, { ...patch, lastError: null });
    if (!rearmed) return { ok: false, status: "changed", message: "Task changed before resume. Reload and try again." };
  }

  const observer = deps.observer ?? getTaskObserver();
  observer?.kick();

  emitTaskStatus(taskId, task.ownerId, "pending");
  log(
    `[task-lifecycle] unpaused task=${taskId} (${resumeMode}; next_fire_at=${nextFireAt.toISOString()})`,
  );
  return { ok: true, status: "pending", message: "Task resumed." };
}

/**
 * R2 — abort the task's in-flight run (if any) and terminate it `cancelled`
 * (sets `cancelledAt`). Terminal; not resumable. Idempotent on an
 * already-terminal task.
 */
export async function stopTask(
  deps: TaskLifecycleDeps,
  taskId: string,
  expectedInvocation?: {
    humanUserId: string;
    taskRunId: string;
    jobId?: string;
  },
): Promise<TaskLifecycleResult> {
  const { db, jobManager } = deps;
  // The canonical Writer save has already claimed this exact Task proposal.
  // Let its receipt settle atomically; cancelling now would produce a saved
  // document paired with a cancelled Task and no authorized finalization.
  if (hasTaskWriterReviewAcceptanceClaim(taskId)) {
    return {
      ok: false,
      status: "awaiting",
      message: "Task review acceptance is being saved and can no longer be stopped.",
    };
  }
  // This is intentionally one transaction with every completion/error writer:
  // a serialized external run can exist before it gets a concrete jobId. The
  // transition checks a Writer reservation under this same row lock, so a
  // concurrent canonical Writer save and Stop have one durable winner.
  const transition = await transitionTaskLifecycleTerminal(db, {
    taskId,
    taskStatus: "cancelled",
    taskPatch: { cancelledAt: new Date() },
    runStatus: "cancelled",
    blockPendingWriterWorkspaceAcceptance: true,
    ...(expectedInvocation ? { expectedInvocation, runId: expectedInvocation.taskRunId } : {}),
  });
  const task = transition.task ?? transition.protectedTask;
  if (!task) return { ok: false, status: "not_found", message: "Task not found." };
  if (transition.outcome === "authority_changed") {
    return { ok: false, status: "authority_changed", message: "Task invocation changed." };
  }
  if (transition.outcome === "writer_review_pending") {
    return {
      ok: false,
      status: "awaiting",
      message: "Task review acceptance is being saved and can no longer be stopped.",
    };
  }
  const protectedContent = task.contentRepresentation === "dual"
    || task.contentRepresentation === "protected";
  if (!transition.transitioned) {
    if (protectedContent && transition.outcome === "same_terminal"
      && task.status === "cancelled") {
      const observer = deps.observer ?? getTaskObserver();
      observer?.kick();
    }
    return {
      ok: true,
      status: task.status,
      message: `Task is already ${task.status}.`,
    };
  }

  // A rejected/racing Stop must leave the live review authority intact so the
  // already-reserved canonical Writer save can settle. Once this transition
  // won durably, revoke it before aborting/reporting the terminal outcome.
  const stoppedWriterReview = getTaskWriterReviewBinding(taskId);
  if (
    stoppedWriterReview &&
    stoppedWriterReview.resolution === null &&
    !stoppedWriterReview.acceptanceClaimed
  ) {
    await deps.onStoppedWriterReview?.(stoppedWriterReview);
  }
  removeTaskReturnBinding(taskId);
  const run = transition.run ?? transition.protectedRun;
  if (protectedContent) {
    const observer = deps.observer ?? getTaskObserver();
    observer?.kick();
  }
  if (run && protectedContent && expectedInvocation?.jobId !== undefined
    && jobManager.abortProtectedTaskRunAndWait !== undefined) {
    try {
      await jobManager.abortProtectedTaskRunAndWait({
        taskId,
        taskRunId: run.id,
        jobId: expectedInvocation.jobId,
      });
    } catch {
      // The Task/Run/Job terminal transaction is already authoritative. The
      // quiescence owner aborts locally before its redundant Job persistence,
      // so a changed publication policy cannot reopen this execution.
      log(
        `[task-lifecycle] protected Task process settlement failed task=${taskId} run=${run.id}`,
      );
    }
  } else if (run) {
    jobManager.abortJob(run.jobId ?? "", "stop", { taskId, taskRunId: run.id });
  }

  emitTaskStatus(taskId, task.ownerId, "cancelled");
  if (!protectedContent) {
    if (!transition.task) {
      throw new Error("Ordinary Task Stop lost its full Task row");
    }
    await (deps.reportBackCancellation ?? reportBackTaskCancellation)(
      { db },
      transition.task,
      transition.run?.id,
    );
  }
  log(`[task-lifecycle] stopped task=${taskId} run=${run?.id ?? "none"}`);
  return { ok: true, status: "cancelled", message: "Task stopped." };
}
