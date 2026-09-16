import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { securityResearchAppendix } from "../tools/security/research-appendix";
import { securityReportReadiness } from "../tools/security/report-readiness";
import type { BaseMessage } from "@langchain/core/messages";
import { createNautiloGraph } from "../agent/graph";
import { defaultPostModelDeps } from "../agent/post-model-deps";
import { createCheckpointSaver } from "../checkpoints/checkpoint-saver";
import { getPolicyResolver } from "@nautilo/trust";
import { collectPendingInterruptEvents } from "./interrupt-mapping";
import {
  lastAssistantPlainText,
} from "../subagents/scope-subagent/run";

/**
 * M164 — outcome of a Task/subagent approval resume, computed by inspecting the
 * checkpoint AFTER the resume stream has drained.
 */
export interface TaskResumeOutcome {
  /** True when a pending interrupt remains (the resume re-parked on another
   *  approval / PIN / identity challenge). The Task stays `awaiting`. */
  reparked: boolean;
  /** The run's final assistant text (for report-back); "" when re-parked. */
  finalText: string;
  securityResearch?: { researchAppendix?: string | null; reportState: "completed" | "partial" | null; envelope: MemoryAccessEnvelope | null };
}

/**
 * Inspect a Task run's checkpoint after an approval/PIN/identity resume drained
 * and decide whether the graph re-parked (chained interrupt) or reached a
 * terminal state, plus the final text to report back.
 *
 * Mirror of the tail of `resumeGraphWithHumanReply` (M151) — extracted so the
 * Task approval resume path (M164) can reuse the same reparked-vs-completed +
 * final-text logic without duplicating it in the runtime layer. The chained
 * interrupt itself is emitted by the resume helper's `emitChainedInterrupts`
 * (via a Task-aware processor); this function ONLY reads state to drive
 * finalization. It does NOT emit, so there is no double-fanout.
 */
export async function inspectTaskResumeOutcome(
  threadId: string,
  laneKey: string,
): Promise<TaskResumeOutcome> {
  const graph = createNautiloGraph(
    createCheckpointSaver(),
    getPolicyResolver(),
    defaultPostModelDeps,
  );

  const postState = (await graph.getState({
    configurable: { thread_id: threadId },
  })) as
    | { values?: { messages?: BaseMessage[]; toolWhitelist?: string[]; memoryAccessEnvelope?: MemoryAccessEnvelope | null }; tasks?: Array<Record<string, unknown>> }
    | undefined;

  const pending = collectPendingInterruptEvents(postState, threadId, laneKey);
  if (pending.length > 0) {
    return { reparked: true, finalText: "" };
  }

  const messages = postState?.values?.messages ?? [];
  const finalText =
    lastAssistantPlainText(messages) ||
    "(task completed with no text)";
  return { reparked: false, finalText,
    ...(postState?.values?.toolWhitelist?.includes("security_scan") ? {
      securityResearch: {
        reportState: securityReportReadiness(messages),
        researchAppendix: securityResearchAppendix(messages),
        envelope: postState.values.memoryAccessEnvelope ?? null,
      },
    } : {}),
  };
}
