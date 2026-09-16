import type { NautiloState } from "../agent/state";
import { deriveResearchSavedState } from "../tools/security/research-saved-state";
import { hasAvailableTaskReportBackContinuation } from "./task-report-back-continuation";

/** A local, checkpointed context-page failure, never arbitrary provider prose. */
export function isRecoverableResearchContextBudgetStop(state: Partial<NautiloState>): boolean {
  const stop = state.noProgressPendingStop;
  if (!state.subagentRun || !state.taskRun || state.trustedExecutionEntrypoint !== "background.task"
    || !state.toolWhitelist?.includes("security_scan") || !state.currentTaskId || !state.currentTaskRunId
    || !Array.isArray(state.messages) || !hasAvailableTaskReportBackContinuation(state.taskReportBackContinuation)
    || stop?.toolName !== "security_scan" || stop.operationDiscriminator !== "context") return false;
  try {
    const error: unknown = JSON.parse(stop.normalizedError);
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "context_budget_unavailable") return false;
  } catch { return false; }
  const status = deriveResearchSavedState({ messages: state.messages, currentTaskId: state.currentTaskId,
    currentTaskRunId: state.currentTaskRunId }).latestStatus?.controls;
  return status?.["mode"] === "deep_research" && status["state"] === "active"
    && status["modelState"] === "running" && typeof status["scanId"] === "string";
}
