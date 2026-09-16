import { Command } from "@langchain/langgraph";
import { createNautiloGraph, type NautiloGraphDeps } from "../agent/graph";
import { bindProtectedMemoryResumeDeps } from "./protected-memory-resume-deps";
import { defaultPostModelDeps } from "../agent/post-model-deps";
import type { LiveShadowToolBoundary } from "../nodes/tools";
import { createCheckpointSaver } from "../checkpoints/checkpoint-saver";
import type { EncryptedCheckpointSaver } from "../checkpoints/encrypted-checkpoint-saver";
import { getPolicyResolver } from "@nautilo/trust";
import { log, warn, runWithTurn } from "@nautilo/logger";
import type { ApprovalReplyVerb } from "@nautilo/types";
import { emitChainedInterrupts, type StreamEventProcessor } from "./resume-approval";
import { readTurnIdFromCheckpoint } from "./turn-id";
import {
  resolveGraphExecutionPolicy,
  GraphExecutionMetrics,
  toGraphBudgetOutcome,
} from "./execution-policy";
import { requirePendingApprovalAskInterrupt } from "./interrupt-mapping";

/**
 * Resume an interrupted graph after an `approval.ask` reply (D061 Phase 2).
 *
 * Sibling of `resumeGraphWithApproval` (M036 prove_it resume). Differs
 * only in the shape of the resume payload — ask-verb carries a
 * `ApprovalReplyVerb` so post-model can persist session/always rules
 * alongside the approve/deny decision.
 *
 * The server calls this from `POST /api/auth/approval-reply`.
 *
 * M042B: `threadId` is the opaque LangGraph saver key (`graphThreadId`,
 * = `"app:default"` for the seeded default room). Lane-key routing is
 * handled by the caller via the event bus processor.
 *
 * D084 — after the resume stream drains, scans for a chained interrupt
 * (approval_ask raised on the VERY next step). Without this, a
 * multi-step continuous run with per-step graduated approval stalls
 * silently after step 1 — the dock never re-appears and the graph
 * sits parked in the checkpointer.
 */
export async function resumeGraphWithAskReply(
  threadId: string,
  verb: ApprovalReplyVerb,
  processEvent: StreamEventProcessor,
  laneKey?: string,
  invocationCheckpointSaver?: EncryptedCheckpointSaver,
  signal?: AbortSignal,
  localMcpInstallApprovalId?: string,
  localMcpInstallDigest?: string,
  localMcpInstallLaneKey?: string,
  structuredSshApprovalId?: string,
  mediaGenerationApprovalId?: string,
  mediaGenerationDigest?: string,
  mediaGenerationQuoteDigest?: string,
  mediaGenerationLaneKey?: string,
  mediaGenerationRevision?: number,
  liveShadowToolBoundaryForState?: () => LiveShadowToolBoundary | undefined,
  invocationMemoryDeps?: NautiloGraphDeps,
  expectedApprovalId?: string,
): Promise<void> {
  const checkpointSaver =
    invocationCheckpointSaver ?? createCheckpointSaver();
  const policyResolver = getPolicyResolver();
  // Stack 208 P0 — one shared graph execution policy seam (recursion ceiling
  // resolved here, threaded into `resumeConfig` below). Metrics counts
  // supersteps / model invocations / tool calls from the existing
  // `streamEvents` hook; logged at stream end / on error (telemetry-only).
  const executionPolicy = resolveGraphExecutionPolicy();
  const metrics = new GraphExecutionMetrics();
  const memoryResume = invocationMemoryDeps === undefined ? undefined
    : bindProtectedMemoryResumeDeps({ ...defaultPostModelDeps, ...invocationMemoryDeps,
      ...(liveShadowToolBoundaryForState === undefined ? {} : { liveShadowToolBoundaryForState }) });
  const graph = createNautiloGraph(
    checkpointSaver,
    policyResolver,
    memoryResume?.deps ?? (liveShadowToolBoundaryForState === undefined
      ? defaultPostModelDeps
      : { ...defaultPostModelDeps, liveShadowToolBoundaryForState }),
  );
  // D082 PR B — re-bind the original chat-entry turnId so the
  // approval-reply leg of the flow grep-correlates with the
  // preceding post_model interrupt.
  const turnId = await readTurnIdFromCheckpoint(graph, threadId);

  const resumeConfig = {
    configurable: { thread_id: threadId },
    version: "v2" as const,
    recursionLimit: executionPolicy.recursionLimit,
    ...(signal ? { signal } : {}),
  };

  const approved = verb !== "deny";
  const preResumeCheckpoint = expectedApprovalId === undefined
    ? undefined
    : await graph.getState({ configurable: { thread_id: threadId } });
  if (expectedApprovalId !== undefined) {
    requirePendingApprovalAskInterrupt(
      preResumeCheckpoint as { tasks?: Array<Record<string, unknown>> } | undefined,
      expectedApprovalId,
    );
  }

  await runWithTurn(turnId, async () => {
    log(`[agent/resume-approval-ask] Resuming thread ${threadId} with verb=${verb} (approved=${approved})`);

    try {
      await processEvent.beginResume?.(threadId, turnId);
      // Cover preparation with the same interruption lifecycle as streaming.
      if (memoryResume !== undefined) {
        const checkpoint = preResumeCheckpoint ?? await graph.getState({
          configurable: { thread_id: threadId },
        });
        if (approved) await memoryResume.restoreCheckpoint(checkpoint);
        else memoryResume.bindCheckpoint(checkpoint);
      }
      const resumePayload = {
        approved,
        verb,
        ...(localMcpInstallApprovalId !== undefined
          ? { localMcpInstallApprovalId }
          : {}),
        ...(localMcpInstallDigest !== undefined ? { localMcpInstallDigest } : {}),
        ...(localMcpInstallLaneKey !== undefined ? { localMcpInstallLaneKey } : {}),
        ...(structuredSshApprovalId !== undefined
          ? { structuredSshApprovalId }
          : {}),
        ...(mediaGenerationApprovalId !== undefined
          ? { mediaGenerationApprovalId }
          : {}),
        ...(mediaGenerationDigest !== undefined ? { mediaGenerationDigest } : {}),
        ...(mediaGenerationQuoteDigest !== undefined
          ? { mediaGenerationQuoteDigest }
          : {}),
        ...(mediaGenerationLaneKey !== undefined
          ? { mediaGenerationLaneKey }
          : {}),
        ...(mediaGenerationRevision !== undefined
          ? { mediaGenerationRevision }
          : {}),
      };
      let resume: typeof resumePayload | Record<string, typeof resumePayload> = resumePayload;
      if (expectedApprovalId !== undefined) {
        const currentCheckpoint = await graph.getState({
          configurable: { thread_id: threadId },
        });
        const pending = requirePendingApprovalAskInterrupt(
          currentCheckpoint as { tasks?: Array<Record<string, unknown>> } | undefined,
          expectedApprovalId,
        );
        if (pending.id !== undefined) resume = { [pending.id]: resumePayload };
      }
      for await (const ev of graph.streamEvents(
        new Command({ resume }),
        resumeConfig,
      )) {
        metrics.noteStreamEvent(ev);
        await Promise.resolve(processEvent.process(ev));
      }

      await emitChainedInterrupts(graph, threadId, laneKey, processEvent, "resume-approval-ask");

      processEvent.flush();
      log(`[agent/resume-approval-ask] Thread ${threadId} resume complete ${metrics.formatLogToken()}`);
    } catch (error) {
      await processEvent.failResume?.();
      processEvent.flush();
      // Stack 208 P0 — surface the typed internal graph-budget outcome distinctly
      // in telemetry (R9). The user-safe sentence is produced by
      // `toFriendlyError` at the runtime job-loop catch site.
      const budgetOutcome = toGraphBudgetOutcome(error, executionPolicy.recursionLimit);
      if (budgetOutcome) {
        warn(
          `[agent/resume-approval-ask] Graph budget exceeded thread=${threadId} ` +
            `outcome=${budgetOutcome.kind} recursionLimit=${budgetOutcome.recursionLimit} ${metrics.formatLogToken()}`,
        );
      } else {
        warn(
          `[agent/resume-approval-ask] Resume failed: ${error instanceof Error ? error.message : String(error)} ${metrics.formatLogToken()}`,
        );
      }
      throw error;
    }
  });
}
