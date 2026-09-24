import {
  getLatestResumableTaskRun,
  getTaskById,
  transitionTaskLifecyclePaused,
  transitionTaskLifecycleTerminal,
  updateTask,
  type DirectDatabase,
  type Task,
} from "@nautilo/db";
import { log } from "@nautilo/logger";
import { eventBus } from "../event-bus";
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
 * M147 (Phase 6) — task lifecycle: pause / unpause / stop.
 *
 * Each function is OWNER-AGNOSTIC — the caller (the `task` tool command or the
 * HTTP route) performs the owner check (`task.ownerId !== ctx.ownerId ⇒ "Task
 * not found."`) BEFORE calling here. All three ride the single shared
 * {@link JobManager.abortJob} seam (no second termination path); the pause-vs-
 * stop distinction lives entirely in the `tasks` / `task_runs` status, not in
 * the job status (at the job level every abort is the same terminal-cancel).
 *
 * Idempotent: pausing an already-paused task, stopping a terminal task, etc.
 * are friendly no-ops (never throw).
 */

/** The slice of `JobManager` the lifecycle needs (injectable for tests). */
export interface TaskLifecycleJobManager {
  abortJob(jobId: string, reason?: "pause" | "stop", taskRun?: { taskId: string; taskRunId: string }): boolean;
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

/**
 * R2 — abort the task's in-flight run (keep the task + its checkpoint so it can
 * resume) and park it `paused`. The LangGraph checkpoint is preserved (no
 * checkpoint deletion); `unpauseTask` resumes from it. Reused verbatim by the
 * time-limit watchdog (R5).
 */
export async function pauseTask(
  deps: TaskLifecycleDeps,
  taskId: string,
  reason: "pause" | "time_limit" = "pause",
): Promise<TaskLifecycleResult> {
  const { db, jobManager } = deps;
  if (reason === "pause") await holdSecurityResearchDesktop(db, taskId);
  const result = await transitionTaskLifecyclePaused(db, taskId);
  const { task, run } = result;
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

export type ResumeFireMode =
  | "checkpoint"
  | "cron_rearm"
  | "one_shot_rearm"
  | "immediate";

/**
 * D406 — decide when a resumed (unpaused) task should next fire. Pure +
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
 * R4 — resume a paused task. Two distinct cases, decided by whether a preserved
 * checkpoint exists:
 *
 *  1. **Checkpoint resume** (a parked `paused` run exists — the task was paused
 *     mid-run by the user or the time-limit watchdog): set `next_fire_at = now`
 *     so the observer re-claims it immediately and `dispatchTaskRun` continues
 *     from the parked run's `graphThreadId` (does NOT cold-start).
 *  2. **Schedule re-arm** (D406 — no parked run; the task was a *dormant*
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
  const task = await getTaskById(db, taskId);
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
  // occurrence instead of firing on re-enable (D406).
  const resumableRun = await getLatestResumableTaskRun(db, taskId);
  const { nextFireAt, mode: resumeMode } = computeResumeFireAt(
    task,
    Boolean(resumableRun),
    new Date(),
  );

  await updateTask(db, taskId, {
    status: "pending",
    nextFireAt,
    fireLockId: null,
    fireLockedAt: null,
  });

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
  expectedInvocation?: { humanUserId: string; taskRunId: string },
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
  // transition checks a D448 reservation under this same row lock, so a
  // concurrent canonical Writer save and Stop have one durable winner.
  const transition = await transitionTaskLifecycleTerminal(db, {
    taskId,
    taskStatus: "cancelled",
    taskPatch: { cancelledAt: new Date() },
    runStatus: "cancelled",
    blockPendingWriterWorkspaceAcceptance: true,
    ...(expectedInvocation ? { expectedInvocation, runId: expectedInvocation.taskRunId } : {}),
  });
  const task = transition.task;
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
  if (!transition.transitioned) {
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
  const run = transition.run;
  if (run) jobManager.abortJob(run.jobId ?? "", "stop", { taskId, taskRunId: run.id });

  emitTaskStatus(taskId, task.ownerId, "cancelled");
  await (deps.reportBackCancellation ?? reportBackTaskCancellation)(
    { db },
    task,
    run?.id,
  );
  log(`[task-lifecycle] stopped task=${taskId} run=${run?.id ?? "none"}`);
  return { ok: true, status: "cancelled", message: "Task stopped." };
}
