import { Command } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import { createNautiloGraph } from "../agent/graph";
import { defaultPostModelDeps } from "../agent/post-model-deps";
import { createCheckpointSaver } from "../checkpoints/checkpoint-saver";
import { getPolicyResolver } from "@nautilo/trust";
import { log, warn, runWithTurn } from "@nautilo/logger";
import { emitChainedInterrupts, type StreamEventProcessor } from "./resume-approval";
import { collectPendingInterruptEvents } from "./interrupt-mapping";
import { readTurnIdFromCheckpoint } from "./turn-id";
import {
  resolveGraphExecutionPolicy,
  GraphExecutionMetrics,
  toGraphBudgetOutcome,
} from "./execution-policy";
import {
  formatSubagentTranscriptForParent,
  lastAssistantPlainText,
} from "../subagents/scope-subagent/run";

/**
 * M151 (Task Phase 7a) — resume a run parked on `await_human_reply`.
 *
 * Sibling of `resumeGraphWithAskReply`. Resumes the parked checkpoint with
 * `Command({ resume: { reply, fromUserId } })`; the `await_reply` node injects
 * the reply as a `HumanMessage`, clears `awaitResponse`, and drives one more
 * agent turn that produces the run's final reply.
 *
 * The await/resume leg runs OUTSIDE `taskRunExecutor`, so the executor's
 * completion seam (which calls `reportBackTaskCompletion`) is never reached.
 * This function therefore returns the run's final assistant text + whether the
 * resume RE-PARKED on a chained `await_human_reply` (a multi-turn negotiation).
 * The caller (`maybeResumeAwaitingTask` in the server) is responsible for
 * calling `reportBackTaskCompletion` only when `reparked === false` —
 * `@nautilo/agent` cannot import `@nautilo/runtime` (cycle).
 */
export interface ResumeHumanReplyResult {
  /** True when the resume hit another `await_human_reply` and stays awaiting. */
  reparked: boolean;
  /** The run's final assistant text (for report-back); "" when re-parked. */
  finalText: string;
}

export async function resumeGraphWithHumanReply(
  threadId: string,
  replyText: string,
  fromUserId: string,
  processEvent: StreamEventProcessor,
  laneKey?: string,
  signal?: AbortSignal,
): Promise<ResumeHumanReplyResult> {
  const checkpointSaver = createCheckpointSaver();
  const policyResolver = getPolicyResolver();
  // Stack 208 P0 — one shared graph execution policy seam (recursion ceiling
  // resolved here, threaded into `resumeConfig` below). Metrics counts
  // supersteps / model invocations / tool calls from the existing
  // `streamEvents` hook; logged at stream end / on error (telemetry-only).
  const executionPolicy = resolveGraphExecutionPolicy();
  const metrics = new GraphExecutionMetrics();
  const graph = createNautiloGraph(
    checkpointSaver,
    policyResolver,
    defaultPostModelDeps,
  );

  const turnId = await readTurnIdFromCheckpoint(graph, threadId);

  const resumeConfig = {
    ...(signal ? { signal } : {}),
    configurable: { thread_id: threadId },
    version: "v2" as const,
    recursionLimit: executionPolicy.recursionLimit,
  };

  return runWithTurn(turnId, async () => {
    log(`[agent/resume-human-reply] Resuming thread ${threadId} (from=${fromUserId})`);

    try {
      await processEvent.beginResume?.(threadId, turnId);
      for await (const ev of graph.streamEvents(
        new Command({ resume: { reply: replyText, fromUserId } }),
        resumeConfig,
      )) {
        metrics.noteStreamEvent(ev);
        await Promise.resolve(processEvent.process(ev));
      }

      // Surface a chained interrupt (e.g. an approval_ask raised on the
      // post-reply turn) the same way the approval resume paths do.
      await emitChainedInterrupts(graph, threadId, laneKey, processEvent, "resume-human-reply");

      processEvent.flush();

      const postState = (await graph.getState({
        configurable: { thread_id: threadId },
      })) as
        | { values?: { messages?: BaseMessage[] }; tasks?: Array<Record<string, unknown>> }
        | undefined;

      // Re-parked if a pending interrupt remains (another `await_human_reply`
      // or any other interrupt). Leave the task `awaiting`; do NOT finalize.
      const pending = collectPendingInterruptEvents(
        postState,
        threadId,
        laneKey ?? threadId,
      );
      if (pending.length > 0) {
        log(`[agent/resume-human-reply] Thread ${threadId} re-parked (${pending.length} interrupt)`);
        return { reparked: true, finalText: "" };
      }

      const messages = postState?.values?.messages ?? [];
      const finalText =
        formatSubagentTranscriptForParent(messages) ||
        lastAssistantPlainText(messages) ||
        "(task completed with no text)";

      log(`[agent/resume-human-reply] Thread ${threadId} resume complete ${metrics.formatLogToken()}`);
      return { reparked: false, finalText };
    } catch (error) {
      await processEvent.failResume?.();
      processEvent.flush();
      // Stack 208 P0 — surface the typed internal graph-budget outcome distinctly
      // in telemetry (R9). The user-safe sentence is produced by
      // `toFriendlyError` at the runtime job-loop catch site.
      const budgetOutcome = toGraphBudgetOutcome(error, executionPolicy.recursionLimit);
      if (budgetOutcome) {
        warn(
          `[agent/resume-human-reply] Graph budget exceeded thread=${threadId} ` +
            `outcome=${budgetOutcome.kind} recursionLimit=${budgetOutcome.recursionLimit} ${metrics.formatLogToken()}`,
        );
      } else {
        warn(
          `[agent/resume-human-reply] Resume failed: ${error instanceof Error ? error.message : String(error)} ${metrics.formatLogToken()}`,
        );
      }
      throw error;
    }
  });
}
