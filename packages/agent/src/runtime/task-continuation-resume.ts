import { Command } from "@langchain/langgraph";
import { resetStreakForKey, serializeNoProgressKey } from "../graph/no-progress";
import type { NautiloState } from "../agent/state";
import { isRecoverableResearchContextBudgetStop } from "./research-context-budget-recovery";
import { hasAvailableTaskReportBackContinuation, type TaskReportBackContinuation } from "./task-report-back-continuation";

type ContinuationUpdate = { taskReportBackContinuation: TaskReportBackContinuation } &
  Partial<Pick<NautiloState, "noProgressStreaks" | "noProgressPendingCorrection" | "noProgressPendingStop">>;

/** Server-only resume input. Never reconstruct messages or reroute pending work. */
export function taskContinuationResumeCommand(saved: Partial<NautiloState>, input: {
  taskId: string;
  taskRunId: string;
  ownerId: string;
  graphThreadId: string;
  continuation: TaskReportBackContinuation;
}): Command<never, ContinuationUpdate, never> {
  // A disconnected attempt must not overwrite the sole durable grant with a
  // status-only value; the same Desktop may reconnect on the next Resume.
  if (!hasAvailableTaskReportBackContinuation(input.continuation)) {
    throw new Error("TASK_CONTINUATION_UNAVAILABLE");
  }
  if (!saved.taskRun || saved.currentTaskId !== input.taskId || saved.currentTaskRunId !== input.taskRunId
    || saved.userId !== input.ownerId || saved.langgraphThreadId !== input.graphThreadId) {
    throw new Error("TASK_CONTINUATION_CHECKPOINT_BINDING_MISMATCH");
  }
  const prior = saved.taskReportBackContinuation;
  if (!hasAvailableTaskReportBackContinuation(prior)
    || (["relayId", "desktopSessionId", "pairingGeneration", "currentFolder", "workspacePath"] as const)
      .some((key) => prior[key] !== input.continuation[key])
    || (input.continuation.browserSessionId !== undefined && input.continuation.browserSessionId !== prior.browserSessionId)
    || (prior.bindingCapturedAt !== undefined && input.continuation.bindingCapturedAt !== prior.bindingCapturedAt)) {
    throw new Error("TASK_CONTINUATION_AUTHORITY_CHANGED");
  }
  // LangGraph's Command update writes only this channel into the parked
  // checkpoint. Unlike ordinary graph input it does not replay START, consume
  // completed tool calls, or replace the canonical message history.
  const update: ContinuationUpdate = { taskReportBackContinuation: input.continuation };
  // An explicit Resume can retry this local runtime failure after repair.
  // Retain every note, recovery reference and role; reset only its breaker episode.
  if (isRecoverableResearchContextBudgetStop(saved) && saved.noProgressPendingStop) {
    update.noProgressStreaks = resetStreakForKey(saved.noProgressStreaks ?? new Map(), saved.noProgressPendingStop);
    if (!saved.noProgressPendingCorrection || serializeNoProgressKey(saved.noProgressPendingCorrection) === serializeNoProgressKey(saved.noProgressPendingStop)) {
      update.noProgressPendingCorrection = null;
    }
    update.noProgressPendingStop = null;
  }
  return new Command<never, ContinuationUpdate, never>({ update });
}
