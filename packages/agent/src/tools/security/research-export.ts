import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { createHash } from "node:crypto";
import { securityScanToolResultSchema, type SecurityScanResultEnvelope } from "@nautilo/types";
import type { NautiloState } from "../../agent/state";
import { securityReportReadiness } from "./report-readiness";
import { securityResearchAppendix, securityResearchAppendixFromPages } from "./research-appendix";
import { readSecurityResearchExportPage } from "../invocation-service";
import type { TaskReportBackContinuation } from "../../runtime/task-report-back-continuation";
import { isRecoverableResearchContextBudgetStop } from "../../runtime/research-context-budget-recovery";
import { readReviewedResearchReportDraft } from "./research-work-context";

type SealedPage = SecurityScanResultEnvelope & { exportSnapshot: NonNullable<SecurityScanResultEnvelope["exportSnapshot"]> };

function sealedPage(messages: readonly BaseMessage[]): SealedPage | null {
  const calls = new Map<string, Record<string, unknown> | null>();
  let latest: SealedPage | null = null;
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) if (call.id) {
        calls.set(call.id, calls.has(call.id) ? null : call.name === "security_scan" ? call.args : null);
      }
      continue;
    }
    if (!ToolMessage.isInstance(message)) continue;
    const call = calls.get(message.tool_call_id);
    calls.delete(message.tool_call_id);
    if (!call || message.name !== "security_scan" || message.status === "error"
      || message.additional_kwargs["nautilo_tool_status"] === "error" || typeof message.content !== "string"
      || call["operation"] !== "results" || call["category"] !== "all" || call["finalize"] !== true
      || call["probes"] !== undefined || call["recordKinds"] !== undefined || call["recordIds"] !== undefined) continue;
    let value: unknown;
    try { value = JSON.parse(message.content); } catch { continue; }
    const parsed = securityScanToolResultSchema.safeParse(value);
    if (parsed.success && parsed.data.ok && parsed.data.operation === "results" && parsed.data.result.exportSnapshot) {
      latest = parsed.data.result as SealedPage;
    }
  }
  return latest;
}

export interface SecurityResearchExportInput {
  threadId: string;
  taskId: string;
  taskRunId: string;
  userId: string;
  modelId: string;
  signal?: AbortSignal;
  /** Recheck durable Task lifecycle between reads and before publication. */
  assertActive?: () => Promise<void>;
  /** Runtime-validated transport refresh; never supplied by model arguments. */
  continuation?: TaskReportBackContinuation;
}

/** Read-only collector. Its private pages never enter graph state or prepared model messages. */
export async function collectFinalizedSecurityResearch(
  state: Readonly<NautiloState>,
  input: Readonly<SecurityResearchExportInput>,
  readPage: (cursor: string | undefined, signal?: AbortSignal) => Promise<unknown>,
): Promise<{ researchAppendix: string; reportState: "completed" | "partial"; reviewedReportDraft?: string }> {
  input.signal?.throwIfAborted();
  await input.assertActive?.();
  if (!state.subagentRun || !state.toolWhitelist?.includes("security_scan") || state.currentTaskId !== input.taskId
    || state.currentTaskRunId !== input.taskRunId || state.userId !== input.userId || state.model !== input.modelId) {
    throw new Error("SECURITY_RESEARCH_EXPORT_SCOPE_MISMATCH");
  }
  const reportState = securityReportReadiness(state.messages);
  if (!reportState) throw new Error("SECURITY_RESEARCH_EXPORT_NOT_SEALED");
  const reviewedReportDraft = readReviewedResearchReportDraft(state);
  const seal = sealedPage(state.messages);
  if (!seal) {
    const legacy = securityResearchAppendix(state.messages);
    if (!legacy) throw new Error("SECURITY_RESEARCH_EXPORT_INCOMPLETE");
    return { researchAppendix: legacy, reportState, ...(reviewedReportDraft === null ? {} : { reviewedReportDraft }) };
  }
  const pages: SecurityScanResultEnvelope[] = [];
  const cursors = new Set<string>();
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    input.signal?.throwIfAborted();
    await input.assertActive?.();
    const value = await readPage(cursor, input.signal);
    input.signal?.throwIfAborted();
    const parsed = securityScanToolResultSchema.safeParse(value);
    if (parsed.success && !parsed.data.ok) throw new Error(`SECURITY_RESEARCH_EXPORT_REJECTED:${parsed.data.error.code}`);
    if (!parsed.success || !parsed.data.ok || parsed.data.operation !== "results") {
      throw new Error("SECURITY_RESEARCH_EXPORT_READ_FAILED");
    }
    const page = parsed.data.result;
    if (page.status.scanId !== seal.status.scanId || page.status.state !== reportState
      || page.status.modelState !== "completed" || page.status.modelId !== seal.status.modelId
      || page.exportSnapshot?.sha256 !== seal.exportSnapshot.sha256
      || page.exportSnapshot.itemCount !== seal.exportSnapshot.itemCount) {
      throw new Error("SECURITY_RESEARCH_EXPORT_SNAPSHOT_CHANGED");
    }
    const items = [...page.records, ...page.observations, ...page.codeEvidence, ...(page.inventory ?? [])];
    for (const item of items) {
      if (ids.has(item.id)) throw new Error("SECURITY_RESEARCH_EXPORT_DUPLICATE_ITEM");
      ids.add(item.id);
    }
    if (ids.size > seal.exportSnapshot.itemCount || page.nextCursor !== null && items.length === 0) {
      throw new Error("SECURITY_RESEARCH_EXPORT_INCOMPLETE");
    }
    pages.push(page);
    if (page.nextCursor === null) break;
    if (cursors.has(page.nextCursor)) throw new Error("SECURITY_RESEARCH_EXPORT_CURSOR_REPEATED");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  if (ids.size !== seal.exportSnapshot.itemCount) throw new Error("SECURITY_RESEARCH_EXPORT_INCOMPLETE");
  const digest = createHash("sha256");
  const items = pages.flatMap((page) => [...page.records, ...page.observations, ...page.codeEvidence, ...(page.inventory ?? [])])
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const item of items) digest.update(item.id).update("\0").update(JSON.stringify(item)).update("\0");
  if (digest.digest("hex") !== seal.exportSnapshot.sha256) throw new Error("SECURITY_RESEARCH_EXPORT_CONTENT_MISMATCH");
  input.signal?.throwIfAborted();
  await input.assertActive?.();
  return { researchAppendix: securityResearchAppendixFromPages(pages, state.messages), reportState,
    ...(reviewedReportDraft === null ? {} : { reviewedReportDraft }) };
}

async function readResearchCheckpoint(threadId: string): Promise<NautiloState> {
  const [{ createNautiloGraph }, { createCheckpointSaver }, { getPolicyResolver }, { defaultPostModelDeps }] = await Promise.all([
    import("../../agent/graph"), import("../../checkpoints/checkpoint-saver"), import("@nautilo/trust"), import("../../agent/post-model-deps"),
  ]);
  const graph = createNautiloGraph(createCheckpointSaver(), getPolicyResolver(), defaultPostModelDeps);
  const checkpoint = await graph.getState({ configurable: { thread_id: threadId } });
  if (!checkpoint?.values || !Array.isArray(checkpoint.values["messages"])) throw new Error("SECURITY_RESEARCH_EXPORT_CHECKPOINT_UNAVAILABLE");
  return checkpoint.values as NautiloState;
}

/** A paused native research graph keeps its original TaskRun and model identity. */
export async function assertSecurityResearchResumeBinding(input: Readonly<SecurityResearchExportInput>) {
  const state = await readResearchCheckpoint(input.threadId);
  return securityResearchResumeBinding(state, input);
}

function securityResearchResumeBinding(state: NautiloState, input: Readonly<SecurityResearchExportInput>) {
  if (!state.subagentRun || !state.taskRun || state.trustedExecutionEntrypoint !== "background.task"
    || !state.toolWhitelist?.includes("security_scan") || state.currentTaskId !== input.taskId
    || state.currentTaskRunId !== input.taskRunId || state.userId !== input.userId || state.model !== input.modelId
    || state.langgraphThreadId !== input.threadId) {
    throw new Error("SECURITY_RESEARCH_RESUME_SCOPE_MISMATCH");
  }
  return { taskRun: true as const, userId: state.userId, currentTaskId: state.currentTaskId,
    currentTaskRunId: state.currentTaskRunId, langgraphThreadId: state.langgraphThreadId,
    taskReportBackContinuation: state.taskReportBackContinuation ?? null };
}

/** Read-only eligibility for an explicit retry of this exact local failure. */
export async function assertSecurityResearchContextFailureRecovery(input: Readonly<SecurityResearchExportInput>): Promise<void> {
  const state = await readResearchCheckpoint(input.threadId);
  securityResearchResumeBinding(state, input);
  if (!isRecoverableResearchContextBudgetStop(state)) throw new Error("SECURITY_RESEARCH_CONTEXT_FAILURE_NOT_RECOVERABLE");
}

/** Only trusted runtime delivery supplies this checkpoint identity, never tool/model arguments. */
export async function exportFinalizedSecurityResearch(input: Readonly<SecurityResearchExportInput>) {
  input.signal?.throwIfAborted();
  const saved = await readResearchCheckpoint(input.threadId);
  if (input.continuation) {
    const prior = saved.taskReportBackContinuation;
    if (input.continuation.status !== "available" || prior?.status !== "available"
      || (["relayId", "desktopSessionId", "pairingGeneration", "currentFolder", "workspacePath"] as const)
        .some((key) => input.continuation![key] !== prior[key])) throw new Error("SECURITY_RESEARCH_EXPORT_HOST_REVOKED");
  }
  const state = input.continuation ? { ...saved, taskReportBackContinuation: input.continuation } : saved;
  return collectFinalizedSecurityResearch(state, input, (cursor, signal) => readSecurityResearchExportPage(state, cursor, signal));
}
