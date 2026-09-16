import {
  clearTaskWriterReviewAwaitingMarker,
  completeTaskRunAndRequeueWriterReviewAccepted,
  getTaskById,
  markTaskAwaitingWriterReview,
  recordTaskWriterReviewAcceptedReceipt,
  type DirectDatabase,
} from "@nautilo/db";
import { eventBus } from "../event-bus";
import { getTaskObserver } from "./task-runtime-context";
import {
  completeTaskWriterReviewFinalization,
  finishTaskWriterReviewModel,
  getTaskWriterReviewBinding,
  type TaskWriterReviewBinding,
} from "./task-return-binding";
import {
  reportBackTaskError,
  reportBackTaskWriterReviewRejected,
  SAFE_WRITER_REVIEW_ACCEPTED_RESULT,
  SAFE_WRITER_REVIEW_FAILED_RESULT,
  SAFE_WRITER_REVIEW_SAVED_VERIFICATION_LOST_RESULT,
} from "./report-back";

export type TaskWriterReviewModelOutcome =
  | "no_review"
  | "awaiting_review"
  | "terminalized"
  /** Durable finalization failed transiently; observer maintenance owns retry. */
  | "finalization_pending"
  | "terminalized_by_race";

/**
 * Narrow, app-neutral handoff from a server-owned canonical write receipt.
 * The runtime does not validate a document or session here; it only fences an
 * already-validated receipt to the exact durable TaskRun and proposal.
 */
export type TaskExternalReviewAcceptedReceipt = Readonly<{
  taskId: string;
  taskRunId: string;
  proposalId: string;
  resultRevision: unknown;
}>;

export type FinalizeTaskExternalReviewReceiptResult =
  | { status: "requeued" | "already_requeued" }
  | { status: "not_found" | "stale" | "conflict" };

/**
 * Persist then complete exactly one accepted external-review TaskRun before
 * atomically requeueing its Task for fresh verification. This deliberately
 * bypasses terminal report-back: acceptance is a lifecycle continuation, not
 * user-facing Task completion.
 */
export async function finalizeTaskExternalReviewAcceptedReceipt(
  db: DirectDatabase,
  receipt: TaskExternalReviewAcceptedReceipt,
): Promise<FinalizeTaskExternalReviewReceiptResult> {
  const recorded = await recordTaskWriterReviewAcceptedReceipt(db, receipt);
  if (recorded.status === "already_requeued") return { status: "already_requeued" };
  if (!("task" in recorded)) {
    return recorded;
  }
  const transition = await completeTaskRunAndRequeueWriterReviewAccepted(db, {
    ...receipt,
    resultText: SAFE_WRITER_REVIEW_ACCEPTED_RESULT,
  });
  if (transition.status === "not_found" || transition.status === "stale" || transition.status === "conflict") {
    return transition;
  }
  if (transition.status === "requeued") {
    eventBus.emit({
      type: "task.status",
      taskId: transition.task.id,
      ownerId: transition.task.ownerId,
      status: "pending",
    });
    getTaskObserver()?.kick();
  }
  return { status: transition.status };
}

/** Finalize one already-validated exact Writer proposal resolution. */
export async function finalizeTaskWriterReviewResolution(
  db: DirectDatabase,
  binding: TaskWriterReviewBinding,
): Promise<void> {
  const resolution = binding.resolution;
  if (!resolution) return;
  const task = await getTaskById(db, binding.taskId);
  if (!task) {
    completeTaskWriterReviewFinalization(binding);
    return;
  }
  if (resolution.outcome === "accepted") {
    await finalizeTaskExternalReviewAcceptedReceipt(db, {
      taskId: binding.taskId,
      taskRunId: binding.taskRunId,
      proposalId: binding.proposalId,
      resultRevision: resolution.documentVersion,
    });
    completeTaskWriterReviewFinalization(binding);
    return;
  } else if (resolution.outcome === "rejected") {
    await reportBackTaskWriterReviewRejected(
      { db },
      { taskId: binding.taskId, runId: binding.taskRunId },
    );
  } else {
    await reportBackTaskError(
      { db },
      {
        taskId: binding.taskId,
        runId: binding.taskRunId,
        scheduleKind: task.scheduleKind,
        error: resolution.code,
        failureResultText: resolution.code === "LIVE_WRITER_VERIFICATION_SESSION_UNAVAILABLE"
          ? SAFE_WRITER_REVIEW_SAVED_VERIFICATION_LOST_RESULT
          : SAFE_WRITER_REVIEW_FAILED_RESULT,
      },
    );
  }
  // Terminal truth wins first. Marker cleanup is bookkeeping and must never
  // strand an awaiting Task if a terminal transition throws midway through.
  await clearTaskWriterReviewAwaitingMarker(db, {
    taskId: binding.taskId,
    taskRunId: binding.taskRunId,
    proposalId: binding.proposalId,
  });
  completeTaskWriterReviewFinalization(binding);
}

/**
 * Model completion is not Task completion when a Writer proposal exists.
 * Park the exact run until review resolves, or consume a fast Human decision
 * that raced ahead of the model's final response.
 */
export async function settleTaskWriterReviewAfterModel(
  db: DirectDatabase,
  input: { taskId: string; taskRunId: string; ownerId: string },
): Promise<TaskWriterReviewModelOutcome> {
  const binding = finishTaskWriterReviewModel(input.taskId, input.taskRunId);
  if (!binding) return "no_review";
  if (binding.ownerId !== input.ownerId) {
    throw new Error("TASK_WRITER_REVIEW_OWNER_MISMATCH");
  }
  if (binding.resolution) {
    if (binding.resolution.outcome === "accepted") {
      const parked = await markTaskAwaitingWriterReview(db, {
        taskId: binding.taskId,
        taskRunId: binding.taskRunId,
        proposalId: binding.proposalId,
      });
      if (!parked) return "terminalized_by_race";
    }
    try {
      await finalizeTaskWriterReviewResolution(db, binding);
    } catch (error) {
      // A Human decision may arrive while the producing model is still
      // winding down.  In that race this is the first durable-finalizer
      // attempt, not a model/provider failure.  If its exact resolved
      // process-local binding survived, leave it for the existing observer
      // maintenance retry rather than entering the executor's generic
      // report-back path (which would delete that retry identity).
      const pending = getTaskWriterReviewBinding(binding.taskId);
      if (
        pending?.finalizationPending === true &&
        pending.modelFinished &&
        pending.taskRunId === binding.taskRunId &&
        pending.ownerId === binding.ownerId &&
        pending.proposalId === binding.proposalId
      ) return "finalization_pending";
      throw error;
    }
    return "terminalized";
  }
  const parked = await markTaskAwaitingWriterReview(db, {
    taskId: binding.taskId,
    taskRunId: binding.taskRunId,
    proposalId: binding.proposalId,
  });
  if (!parked) return "terminalized_by_race";
  eventBus.emit({
    type: "task.status",
    taskId: binding.taskId,
    ownerId: binding.ownerId,
    status: "awaiting",
  });
  return "awaiting_review";
}
