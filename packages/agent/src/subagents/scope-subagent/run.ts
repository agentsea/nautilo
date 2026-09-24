import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { taskContinuationResumeCommand } from "../../runtime/task-continuation-resume";
import { createNautiloGraph } from "../../agent/graph";
import type { NautiloState, TrustedExecutionEntrypoint } from "../../agent/state";
import { defaultPostModelDeps } from "../../agent/post-model-deps";
import { createCheckpointSaver } from "../../checkpoints/checkpoint-saver";
import { EncryptedCheckpointSaver } from "../../checkpoints/encrypted-checkpoint-saver";
import { getPolicyResolver } from "@nautilo/trust";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  resolveGraphExecutionPolicy,
  GraphExecutionMetrics,
  toGraphBudgetOutcome,
} from "../../graph/execution-policy";
import { AgentToolCallTracker, emitAgentEvent } from "../../runtime-hooks";
import { isScopeMemoryEnvelope } from "@nautilo/trust";
import {
  appendTranscriptMessages,
  SUBAGENT_GRAPH_THREAD_PREFIX,
} from "../../store/session-store";
import { computeMessageFingerprint } from "../../store/fingerprint";
import { recordStreamActivityFromEvent, turnContextKey } from "../../runtime/turn-context";
import { nanoid } from "../deep-research/shared/nanoid";
import { getCurrentTurnId, log } from "@nautilo/logger";
import type { ModelFallbackMode } from "../../utils/chat-model-invocation";
import { omitSensitiveToolArgs } from "../../utils/tool-argument-redaction";
import { runWithInitiatingClientSurface } from "../../runtime/initiating-client-surface-context";
import { runWithTaskCausalHuman } from "../../runtime/causal-human-context";
import { runWithLiveMiniAppExecutionContext } from "../../runtime/live-mini-app-execution-context";
import type {
  ActiveMiniAppRequestContext,
  TrustedLiveMiniAppSessionContext,
} from "@nautilo/types";
import { ScopeSubagentTokenStream } from "./token-stream";
import { researchHandoffReceiptSchema, securityResearchContextReceiptSchema, securityScanToolResultSchema, taskPreparationText, type TaskPreparationProgress } from "@nautilo/types";
import { deriveResearchSavedState } from "../../tools/security/research-saved-state";
import { deriveResearchWorkContext } from "../../tools/security/research-work-context";
import { securityResearchAppendix } from "../../tools/security/research-appendix";
import { securityReportReadiness } from "../../tools/security/report-readiness";
import { createResearchNoteDraft } from "../../tools/security/research-note-draft";
import type { MessageArtifactOpenRef } from "@nautilo/types";
import {
  findArtifactInternalIdsForCanonicalNamespace,
  getRoomNamespaceId,
  hydrateMessageArtifacts,
  recordMessageArtifacts,
} from "@nautilo/db";

function extractPersistedMessagesFromChainEnd(ev: unknown): BaseMessage[] {
  if (!ev || typeof ev !== "object") return [];
  const eventObj = ev as Record<string, unknown>;
  if (eventObj["event"] !== "on_chain_end") return [];
  const name = typeof eventObj["name"] === "string" ? eventObj["name"] : "";
  if (name !== "agent" && name !== "post_model" && name !== "tools") return [];
  const data = eventObj["data"] as Record<string, unknown> | undefined;
  if (!data) return [];
  const output = data["output"] as Record<string, unknown> | undefined;
  if (!output) return [];
  const outMessages = output["messages"] as BaseMessage[] | undefined;
  const inputObj = data["input"] as Record<string, unknown> | undefined;
  const inMessages = inputObj
    ? (inputObj["messages"] as BaseMessage[] | undefined)
    : undefined;
  const inputLen = Array.isArray(inMessages) ? inMessages.length : 0;
  if (Array.isArray(outMessages) && outMessages.length > inputLen) {
    return outMessages.slice(inputLen);
  }
  return [];
}

const TASK_PROGRESS_THROTTLE_MS = 500;

function summarizeToolArgsForProgress(args: unknown, maxLength = 200): string {
  if (!args) return "";
  try {
    if (typeof args !== "object" || Array.isArray(args)) return "";
    const sourceArgs = args as Record<string, unknown>;
    if (Object.keys(sourceArgs).length === 0) return "{}";
    const safeArgs = omitSensitiveToolArgs(sourceArgs);
    if (Object.keys(safeArgs).length === 0) return "";
    const str = JSON.stringify(safeArgs);
    return str.length > maxLength ? str.slice(0, maxLength) + "..." : str;
  } catch {
    return "[args]";
  }
}

export type ObservedTaskProgress = { detail: string; preparation: TaskPreparationProgress };

/** Restore observed work from this graph's accepted same-run handoff, never
 * a default role or a model-authored status sentence. Node starts also run on
 * checkpoint resume, before provider activity can replace the persisted stage. */
function researchWorkProgressFromNodeInput(input: Record<string, unknown> | undefined): TaskPreparationProgress["researchWork"] {
  if (input?.["taskRun"] !== true || input["subagentRun"] !== true
    || typeof input["currentTaskId"] !== "string" || !input["currentTaskId"]
    || typeof input["currentTaskRunId"] !== "string" || !input["currentTaskRunId"]
    || !Array.isArray(input["toolWhitelist"]) || !input["toolWhitelist"].includes("security_scan")
    || !Array.isArray(input["messages"])) return undefined;
  const state = { currentTaskId: input["currentTaskId"], currentTaskRunId: input["currentTaskRunId"],
    messages: input["messages"].filter((message): message is BaseMessage => AIMessage.isInstance(message) || ToolMessage.isInstance(message)) };
  const work = deriveResearchWorkContext(state);
  if (!work?.handoffRecordId) return undefined;
  const unitId = work.unitRecordId ?? work.reviewedUnitRecordId;
  const saved = deriveResearchSavedState(state);
  const unit = unitId ? saved.records.get(unitId)?.record : undefined;
  const subject = unit?.entry.kind === "review_unit" ? unit.entry.summary
    : (work.role === "reviewer" && work.unitRecordId === null) || work.reviewedUnitRecordId === null ? "Complete audit report" : undefined;
  return { role: work.role, ...(subject ? { subject } : {}),
    ...(work.reviewDecision ? { reviewDecision: work.reviewDecision } : {}) };
}

/** Public, observed work only. Tool completion must have an accepted typed receipt. */
export function extractTaskProgressFromStreamEvent(ev: unknown): ObservedTaskProgress | null {
  if (!ev || typeof ev !== "object") return null;
  const eventObj = ev as Record<string, unknown>;
  if (eventObj["event"] === "on_chat_model_start") return {
    detail: "Waiting for the model response", preparation: { stage: "waiting_model" },
  };
  if (eventObj["event"] === "on_chat_model_stream") return {
    detail: "The model is responding", preparation: { stage: "model_responding" },
  };
  const toolName = typeof eventObj["name"] === "string" ? eventObj["name"] : "tool";
  const data = eventObj["data"] as Record<string, unknown> | undefined;
  if ((toolName === "pre_model" || toolName === "agent")
    && (eventObj["event"] === "on_chain_start" || eventObj["event"] === "on_chain_end")) {
    const input = data?.["input"] as Record<string, unknown> | undefined;
    const researchWork = researchWorkProgressFromNodeInput(input);
    const output = data?.["output"] as Record<string, unknown> | undefined;
    const recovery = (eventObj["event"] === "on_chain_start" ? input : output)?.["researchContextRecovery"] as Record<string, unknown> | null | undefined;
    if (input?.["subagentRun"] !== true || !input["currentTaskId"] || !input["currentTaskRunId"]
      || !Array.isArray(input["toolWhitelist"]) || !input["toolWhitelist"].includes("security_scan")) return null;
    if (recovery && recovery["taskRunId"] === input["currentTaskRunId"]
      && Array.isArray(recovery["pendingRefs"]) && recovery["pendingRefs"].every((ref) => typeof ref === "string")) {
      const preparation: TaskPreparationProgress = { stage: "preparing_model", activity: "recovering_context",
        ...(researchWork ? { researchWork } : {}), contextRecovery: { pendingInputs: recovery["pendingRefs"].length,
          phase: recovery["consolidationRequired"] === true || recovery["pendingRefs"].length === 0
            ? "consolidation_required" : "reading" } };
      return { detail: taskPreparationText(preparation), preparation };
    }
    if (recovery === null && input["researchContextRecovery"]) {
      const preparation: TaskPreparationProgress = { stage: "preparing_model", activity: "loading_research",
        ...(researchWork ? { researchWork } : {}), contextRecovery: { pendingInputs: 0, phase: "inactive" } };
      return { detail: researchWork ? taskPreparationText(preparation)
        : "Context recovered; continuing the audit with saved research", preparation };
    }
    if (eventObj["event"] === "on_chain_start" && researchWork) {
      const preparation: TaskPreparationProgress = { stage: "preparing_model", researchWork };
      return { detail: taskPreparationText(preparation), preparation };
    }
    return null;
  }
  if (toolName === "tools" && (eventObj["event"] === "on_chain_start" || eventObj["event"] === "on_chain_end")) {
    // Relay dispatch bypasses LangChain Tool.invoke tracing. The canonical
    // tools node executes the first approved call and appends its ToolMessage.
    // Observe that node locally; enabling its room telemetry would leak or
    // duplicate background Task activity into the foreground stream.
    const input = data?.["input"] as Record<string, unknown> | undefined;
    const approved = input?.["approvedToolCalls"];
    const call = Array.isArray(approved) ? approved[0] as Record<string, unknown> | undefined : undefined;
    if (!call || typeof call["id"] !== "string" || typeof call["name"] !== "string") return null;
    if (eventObj["event"] === "on_chain_start") return extractTaskProgressFromStreamEvent({
      event: "on_tool_start", name: call["name"], data: { input: call["args"] },
    });
    const output = data?.["output"] as Record<string, unknown> | undefined;
    const before = input?.["messages"];
    const after = output?.["messages"];
    if (!Array.isArray(before) || !Array.isArray(after)) return null;
    const appended: unknown[] = after.slice(before.length);
    const result = appended.find((message): message is ToolMessage => ToolMessage.isInstance(message)
      && message.tool_call_id === call["id"] && message.name === call["name"]);
    if (!result) return null;
    if ((result.status === "error" || result.additional_kwargs?.["nautilo_tool_status"] === "error") && call["name"] !== "security_scan") return null;
    if (call["name"] === "file") {
      // Only the invocation service can attest the executed normalized command.
      // File bodies can resemble JSON receipts; do not derive activity from them
      // or from the malformed model args that preceded a repaired invocation.
      if (result.additional_kwargs?.["nautilo_tool_status"] !== "success") return null;
      const command = result.additional_kwargs["nautilo_file_operation"];
      const activity = command === "read" ? "reading_source"
        : command === "grep" ? "searching_source"
        : command === "glob" || command === "list" ? "mapping_repository" : undefined;
      if (!activity) return null;
      const preparation: TaskPreparationProgress = { stage: "using_tools", activity };
      return { detail: taskPreparationText(preparation), preparation };
    }
    if (call["name"] === "security_scan" && typeof result.content === "string"
      && (result.status === "success" || result.additional_kwargs["nautilo_tool_status"] === "success")) {
      let value: unknown;
      try { value = JSON.parse(result.content); } catch { value = null; }
      const receipt = researchHandoffReceiptSchema.safeParse(value);
      const args = call["args"] as Record<string, unknown> | undefined;
      if (receipt.success && args?.["operation"] === "handoff" && args["role"] === receipt.data.work.role
        && args["handoffRecordId"] === receipt.data.work.handoffRecordId
        && receipt.data.work.taskId === input?.["currentTaskId"] && receipt.data.work.taskRunId === input?.["currentTaskRunId"]
        && result.status !== "error" && result.additional_kwargs["nautilo_tool_status"] !== "error") {
        const work = receipt.data.work;
        const saved = deriveResearchSavedState({ currentTaskId: work.taskId, currentTaskRunId: work.taskRunId,
          messages: after.filter((message): message is BaseMessage => AIMessage.isInstance(message) || ToolMessage.isInstance(message)) });
        const unitId = work.unitRecordId ?? work.reviewedUnitRecordId;
        const unit = unitId ? saved.records.get(unitId)?.record : undefined;
        const subject = unit?.entry.kind === "review_unit" ? unit.entry.summary
          : work.role === "reviewer" && work.unitRecordId === null || work.reviewedUnitRecordId === null ? "Complete audit report" : undefined;
        const preparation: TaskPreparationProgress = { stage: "using_tools", researchWork: {
          role: work.role, ...(subject ? { subject } : {}), ...(work.reviewDecision ? { reviewDecision: work.reviewDecision } : {}),
        } };
        return { detail: taskPreparationText(preparation), preparation };
      }
    }
    return extractTaskProgressFromStreamEvent({ event: "on_tool_end", name: call["name"], data: { output: result } });
  }
  if (eventObj["event"] === "on_tool_end" && toolName === "security_scan") {
    let output = data?.["output"];
    const failed = ToolMessage.isInstance(output) && (output.status === "error" || output.additional_kwargs?.["nautilo_tool_status"] === "error");
    if (output && typeof output === "object" && "content" in output) output = output.content;
    if (typeof output === "string") {
      try { output = JSON.parse(output); } catch { return null; }
    }
    const context = securityResearchContextReceiptSchema.safeParse(output);
    const parsed = securityScanToolResultSchema.safeParse(output);
    const runtime = context.success ? context.data.runtimeRecovery : parsed.success ? parsed.data.runtimeRecovery : undefined;
    const contextRecovery: TaskPreparationProgress["contextRecovery"] = runtime ? {
      pendingInputs: runtime.pendingInputCount, phase: runtime.phase,
      recoveredInputBytes: runtime.recoveredInputBytes, retainedUnconsolidatedPages: runtime.retainedUnconsolidatedPages,
    } : undefined;
    if (failed || context.success && !context.data.ok || parsed.success && !parsed.data.ok) {
      if (!contextRecovery) return null;
      const preparation: TaskPreparationProgress = { stage: "using_tools", contextRecovery,
        ...(contextRecovery.phase !== "inactive" ? { activity: "recovering_context" as const } : {}) };
      return { detail: taskPreparationText(preparation), preparation };
    }
    if (context.success && context.data.ok) {
      if (context.data.result.serialization !== "visible-message-json-utf8") {
        const preparation: TaskPreparationProgress = { stage: "using_tools", activity: "loading_research", ...(contextRecovery ? { contextRecovery } : {}) };
        return { detail: (context.data.result.serialization === "saved-record-index-json-utf8"
          ? "Looking up saved research notes; lookup is not source inspection"
          : "Looking up saved messages; lookup is not source inspection") + (contextRecovery ? ` · ${taskPreparationText({ stage: "using_tools", contextRecovery })}` : ""), preparation };
      }
      const { startByte, endByte, totalBytes } = context.data.result;
      const preparation: TaskPreparationProgress = { stage: "using_tools", activity: "recovering_context",
        contextPage: { startByte, endByte, totalBytes }, ...(contextRecovery ? { contextRecovery } : {}) };
      return { detail: taskPreparationText(preparation), preparation };
    }
    if (!parsed.success || !parsed.data.ok) return null;
    const receipt = parsed.data;
    const preparation: TaskPreparationProgress = { stage: "using_tools", ...(contextRecovery ? { contextRecovery } : {}) };
    if (receipt.operation === "record") {
      const research = receipt.result.researchProgress;
      if (research) preparation.research = {
        unitsTotal: research.unitsTotal, unitsCompleted: research.unitsCompleted,
        unitsPending: research.unitsPending, filesTotal: research.filesTotal,
        filesAssigned: research.filesAssigned,
      };
      const entry = receipt.result.record.entry;
      const activities: Partial<Record<typeof entry.kind, TaskPreparationProgress["activity"]>> = {
        checkpoint: "checkpoint_saved", review_unit: "review_saved", hypothesis: "hypothesis_saved",
        evidence: "evidence_saved", counterevidence: "evidence_saved", finding: "finding_saved",
        dismissal: "hypothesis_saved", coverage: "coverage_saved", repository_map: "mapping_repository",
      };
      preparation.activity = activities[entry.kind] ?? "saving_research";
      // The accepted public summary can be shown in the owner-scoped live event;
      // durable preparation retains only its fixed kind, never its text.
      const summary = "summary" in entry ? entry.summary : "rationale" in entry ? entry.rationale : "";
      return { detail: `${taskPreparationText(preparation)}${summary ? `: ${entry.kind === "checkpoint" ? "Model checkpoint: " : ""}${summary}` : ""}`, preparation };
    }
    const status = receipt.operation === "results" ? receipt.result.status : receipt.result;
    const research = status.researchProgress;
    if (research) preparation.research = {
      unitsTotal: research.unitsTotal, unitsCompleted: research.unitsCompleted,
      unitsPending: research.unitsPending, filesTotal: research.filesTotal,
      filesAssigned: research.filesAssigned,
    };
    preparation.activity = "loading_research";
    return { detail: taskPreparationText(preparation), preparation };
  }
  if (eventObj["event"] !== "on_tool_start") return null;
  const input = data?.["input"];
  const args = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
  const preparation: TaskPreparationProgress = { stage: "using_tools" };
  if (toolName === "file") {
    if (args["command"] === "read") preparation.activity = "reading_source";
    if (args["command"] === "grep") preparation.activity = "searching_source";
    if (args["command"] === "glob" || args["command"] === "list") preparation.activity = "mapping_repository";
    if (preparation.activity) {
      const path = typeof args["path"] === "string" ? args["path"] : null;
      return { detail: `${taskPreparationText(preparation)}${path ? `: ${path}` : ""}`, preparation };
    }
  }
  if (toolName === "security_scan") {
    if (args["operation"] === "handoff") return { detail: "Preparing research handoff", preparation };
    const savedNoteLookup = typeof args["contextRef"] === "string" && /^(research-records|research-index):/.test(args["contextRef"]);
    preparation.activity = args["operation"] === "context" ? savedNoteLookup ? "loading_research" : "recovering_context"
      : args["operation"] === "record" ? "saving_research"
      : args["finalize"] === true ? "validating_report" : "loading_research";
    return { detail: taskPreparationText(preparation), preparation };
  }
  const argsSummary = summarizeToolArgsForProgress(input);
  return { detail: argsSummary ? `${toolName}: ${argsSummary}` : toolName, preparation };
}

/** Compatibility helper for callers that only display the owner-scoped detail. */
export function extractToolProgressDetailFromStreamEvent(ev: unknown): string | null {
  return extractTaskProgressFromStreamEvent(ev)?.detail ?? null;
}

/** Provider activity is secondary to the last observed task work, including on reconnect. */
export function retainTaskWorkProgress(
  previous: ObservedTaskProgress | null,
  incoming: ObservedTaskProgress,
): ObservedTaskProgress {
  const provider = incoming.preparation.stage === "waiting_model"
    || incoming.preparation.stage === "model_responding";
  const preparation: TaskPreparationProgress = {
    ...incoming.preparation,
    ...(previous?.preparation.researchWork && !incoming.preparation.researchWork
      ? { researchWork: previous.preparation.researchWork } : {}),
    ...(previous?.preparation.research && !incoming.preparation.research
      ? { research: previous.preparation.research } : {}),
    ...((provider || incoming.preparation.activity === "recovering_context" || previous?.preparation.contextRecovery?.phase !== undefined) && previous?.preparation.contextRecovery
      && !incoming.preparation.contextRecovery ? { contextRecovery: previous.preparation.contextRecovery } : {}),
    ...(provider && previous?.preparation.contextPage ? { contextPage: previous.preparation.contextPage } : {}),
    ...(provider && previous?.preparation.activity ? { activity: previous.preparation.activity } : {}),
  };
  if (!provider || !previous?.preparation.activity && !previous?.preparation.researchWork) return { ...incoming, preparation,
    detail: (preparation.researchWork && !incoming.preparation.researchWork
      ? `${taskPreparationText({ stage: "using_tools", researchWork: preparation.researchWork })} · ` : "")
      + incoming.detail + (preparation.contextRecovery && !incoming.preparation.contextRecovery
      ? ` · ${taskPreparationText({ stage: preparation.stage, contextRecovery: preparation.contextRecovery })}` : ""),
  };
  // Keep the concrete operation or accepted notes visible while tokens arrive.
  // Strip only suffixes this projection itself added, never model/source text.
  const suffixes = [" · Waiting for model", " · Model response in progress"];
  let detail = previous.detail;
  for (const suffix of suffixes) if (detail.endsWith(suffix)) detail = detail.slice(0, -suffix.length);
  return { detail: detail + (incoming.preparation.stage === "waiting_model"
    ? suffixes[0] : suffixes[1]), preparation };
}

type TaskProgressTap = {
  noteToolProgress(progress: ObservedTaskProgress): void;
  flush(): void;
  dispose(): void;
};

export function createTaskProgressTap(opts: {
  progressTaskId?: string | undefined;
  progressTaskRunId?: string | undefined;
  progressOwnerId?: string | undefined;
}): TaskProgressTap | null {
  if (!opts.progressTaskId || !opts.progressOwnerId) return null;

  let lastEmitAt = 0;
  let lastProgress: ObservedTaskProgress | null = null;
  let pendingProgress: ObservedTaskProgress | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const emitNow = () => {
    if (!pendingProgress) return;
    emitAgentEvent({
      type: "task.progress",
      taskId: opts.progressTaskId!,
      taskRunId: opts.progressTaskRunId ?? "",
      detail: pendingProgress.detail,
      preparation: pendingProgress.preparation,
      ownerId: opts.progressOwnerId!,
    });
    pendingProgress = null;
    lastEmitAt = Date.now();
  };

  const scheduleDeferredFlush = (delayMs: number) => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      emitNow();
    }, delayMs);
  };

  return {
    noteToolProgress(progress: ObservedTaskProgress) {
      const retained = retainTaskWorkProgress(lastProgress, progress);
      if (lastProgress && JSON.stringify(retained) === JSON.stringify(lastProgress)) return;
      lastProgress = retained;
      pendingProgress = retained;
      const elapsed = Date.now() - lastEmitAt;
      if (lastEmitAt === 0 || elapsed >= TASK_PROGRESS_THROTTLE_MS) {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        emitNow();
        return;
      }
      scheduleDeferredFlush(TASK_PROGRESS_THROTTLE_MS - elapsed);
    },
    dispose() {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      pendingProgress = null;
      lastProgress = null;
    },
    flush() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (pendingProgress) emitNow();
    },
  };
}

function extractPendingInterruptValue(
  graphState: { tasks?: Array<Record<string, unknown>> } | undefined,
): Record<string, unknown> | null {
  const tasks = graphState?.tasks;
  if (!tasks) return null;
  for (const task of tasks) {
    const interrupts = task["interrupts"] as Array<Record<string, unknown>> | undefined;
    if (!interrupts) continue;
    for (const intr of interrupts) {
      const value = intr["value"] as Record<string, unknown> | undefined;
      if (value && typeof value === "object") return value;
    }
  }
  return null;
}

/**
 * Flatten LangChain message content (string, multimodal blocks, or JSON) for
 * parent-facing subagent transcripts.
 */
export function messageContentToPlainString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (!block || typeof block !== "object") return "";
        const b = block as Record<string, unknown>;
        if (b["type"] === "text") {
          const t = b["text"];
          if (typeof t === "string") return t;
        }
        try {
          return JSON.stringify(block);
        } catch {
          return "";
        }
      })
      .filter((s) => s.length > 0)
      .join("\n");
  }
  if (content === null || content === undefined) return "";
  if (typeof content === "object") {
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  if (typeof content === "number" || typeof content === "boolean") {
    return String(content);
  }
  return "";
}

export function lastAssistantPlainText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (AIMessage.isInstance(m)) {
      const t = messageContentToPlainString(m.content).trim();
      if (t) return t;
    }
  }
  return "";
}

const SUBAGENT_TRANSCRIPT_HEADER =
  "[Subagent run — full transcript for parent model; not shown verbatim to the end user]";

/**
 * Serializes the subagent message list so the parent model receives tool
 * results and every assistant turn (including multimodal/string content),
 * not only the last string AIMessage.
 *
 * Returns "" when there is no displayable content (caller may fall back).
 */
export function formatSubagentTranscriptForParent(messages: BaseMessage[]): string {
  const blocks: string[] = [];
  for (const m of messages) {
    if (SystemMessage.isInstance(m)) {
      const t = messageContentToPlainString(m.content).trim();
      if (t) blocks.push(`[system]\n${t}`);
    } else if (HumanMessage.isInstance(m)) {
      const t = messageContentToPlainString(m.content).trim();
      if (t) blocks.push(`[user]\n${t}`);
    } else if (AIMessage.isInstance(m)) {
      const t = messageContentToPlainString(m.content).trim();
      const callNames =
        m.tool_calls?.map((c) => (typeof c.name === "string" ? c.name : "tool")) ?? [];
      const callLine =
        callNames.length > 0 ? `(tool_calls requested: ${callNames.join(", ")})` : "";
      if (t || callLine) {
        blocks.push(`[assistant]\n${[t, callLine].filter(Boolean).join("\n")}`);
      }
    } else if (ToolMessage.isInstance(m)) {
      const t = messageContentToPlainString(m.content).trim();
      const name = typeof m.name === "string" && m.name ? m.name : "tool";
      if (t) blocks.push(`[tool:${name}]\n${t}`);
    }
  }
  if (blocks.length === 0) return "";
  return [SUBAGENT_TRANSCRIPT_HEADER, "", ...blocks].join("\n\n").trim();
}

export type RunScopeSubagentOpts = {
  parentThreadId: string;
  parentTurnId: string;
  parentOwnerId: string;
  /** Persisted initiating Human for paid provider admission on this run. */
  causalHumanUserId?: string;
  /**
   * the user id that OWNS the run's transcript session (the `sessions`
   * row). Defaults to `parentOwnerId`. For an `ask_peer` DM the target room is
   * owned by the PEER (the only human member), and the room transcript reader
   * (`getRoomMessagesAcrossMemberSessions`) only surfaces sessions whose owner
   * is a room MEMBER — so the question must be persisted under the peer, not
   * the requester, or the peer never sees it. For namespace targets this equals
   * `parentOwnerId` (the requester IS the room owner), so behavior is unchanged.
   */
  transcriptOwnerId?: string;
  /** omit for wide (namespace) runs; set for scope runs. */
  scopeId?: string;
  brief: string;
  expectedOutput?: string;
  /**
   * `undefined` selects progressive exposure (core plus activated tools).
   * `[]` is tool-free. An explicit list is a strict ceiling over both core
   * exposure and activation, and is seeded as the cold-start activation set so
   * the tools requested for a background run are callable on its first model
   * step. It never bypasses policy, relay, namespace, or approval checks.
   */
  toolWhitelist?: string[];
  /**
   * Process-local cold-start activation for a server-admitted live Task. It
   * widens no policy and, unlike a whitelist, leaves progressive discovery
   * available after the first model step.
   */
  initialActivatedToolNames?: readonly string[];
  /** scope envelope OR full namespace envelope. */
  subEnvelope: MemoryAccessEnvelope;
  actorRole: string;
  assistantName: string;
  soulFile: string;
  modelId: string;
  currentFolder: string;
  workspacePath: string;
  /**
   * server-resolved exact live Task Desktop binding. It is absent for
   * ordinary subagents and unavailable task runs; host admission revalidates
   * it again at each relay dispatch.
   */
  taskReportBackContinuation?: NautiloState["taskReportBackContinuation"];
  /** Sanitized child prompt projection; safe to checkpoint. */
  activeMiniApp?: ActiveMiniAppRequestContext | null;
  /** Process-local only; graph state is always initialized with null. */
  liveMiniAppSession?: TrustedLiveMiniAppSessionContext | null;
  subagentDepth: number;
  subagentMaxDepth: number;
  securityAuditClientMeta: NautiloState["securityAuditClientMeta"];
  roomRoster: NautiloState["roomRoster"];
  roomId: string;
  /** Exact foreground Room that originated a background Task. */
  callingRoomId?: string;
  /** Exact durable Task currently executing this background graph. */
  currentTaskId?: string;
  /** Exact durable TaskRun currently executing this background graph. */
  currentTaskRunId?: string;
  /** Server-resolved workspace Artifact context for an exact peer handoff. */
  artifactRefs?: NautiloState["artifactRefs"];
  focusedResources?: NautiloState["focusedResources"];
  /** Trusted task-dispatch stamp: author cards on visible assistant rows. */
  assistantArtifactExternalIds?: readonly string[];
  relayCapabilities?: NautiloState["relayCapabilities"];
  /**
   * mark this run as a background/async Task run. Drives the
   * relay-drop → `relay_unavailable` failure path in the tools node (no
   * present human to relay the error to). Defaults to `false` for
   * in-chat scope runs.
   */
  taskRun?: boolean;
  /** Scheduled wake delivery owns the visible assistant message. */
  deferAssistantOutputToReportBack?: boolean;
  /** only task-run-executor may supply the background-task stamp. */
  trustedExecutionEntrypoint?: "background.task";
  /**
   * Wave 9 — exact child-thread saver for an invocation-bound protected child.
   *
   * Background/task runs must omit it and continue through their legacy saver
   * until Wave 10 gives them independently acquired authority.
   */
  invocationCheckpointSaver?: EncryptedCheckpointSaver;
  /** Resume payload after a bridged interrupt (same shape as HTTP resume) */
  resume?: unknown;
  /** When resuming, reuse the same subagent thread */
  subagentThreadId?: string;
  /**
   * — continue a previously-aborted run from its preserved
   * LangGraph checkpoint. Unlike `resume` (which carries an interrupt reply
   * `Command`), this streams with a **null** input so the graph simply
   * resumes from the last persisted checkpoint where a pause abort cut it
   * off. Requires `subagentThreadId` (the prior run's thread) to be set so
   * the checkpoint matches; a fresh brief is NOT re-injected.
   */
  continueFromCheckpoint?: boolean;
  signal?: AbortSignal;
  /**
   * (Task ) — when true the run parks on `await_human_reply`
   * after the agent's final (no-tool-call) message, waiting for a human reply
   * in `awaitRoomId` from one of `awaitFromUserIds`. The task identifiers make
   * the owner-scoped `task.awaiting_reply` WS event self-describing.
   */
  awaitResponse?: boolean;
  awaitRoomId?: string;
  awaitFromUserIds?: string[];
  awaitTaskId?: string;
  awaitTaskRunId?: string;
  awaitOwnerId?: string;
  /**
   * when set, emit owner-scoped `task.progress` on `on_tool_start`
   * (task runs only; in-chat scope runs omit these).
   */
  progressTaskId?: string;
  /** Canonical checkpointed approval reply lane. */
  approvalLaneKey?: string;
  progressTaskRunId?: string;
  progressOwnerId?: string;
  /**
   * explicit fallback mode for this subagent run. `"none"`
   * (strict / no-chain) is set by `taskRunExecutor` when the dispatch seam
   * flagged an exact Task `model_id` pin (`exactModelSelection: true` on the
   * job input); it suppresses every cross-model hop inside
   * `invokeChatModelWithFallback`. `"agent_chain"` (default) preserves the
   * existing fallback chain for foreground / non-exact callers. Persisted in
   * cold-start graph state so checkpoint resume retains the same mode.
   */
  modelFallbackMode?: ModelFallbackMode;
};

/**
 * A dedicated subagent's explicit tool list is both its requested initial set
 * and its immutable exposure ceiling. Seeding the same names into activation
 * makes discoverable members runnable on the first model call without adding
 * meta-tools or bypassing the catalog's normal eligibility gates.
 */
export function scopeSubagentToolComposition(
  toolWhitelist: string[] | undefined,
  initialActivatedToolNames: readonly string[] | undefined = undefined,
): Partial<Pick<NautiloState, "toolWhitelist" | "activatedToolNames">> {
  if (toolWhitelist === undefined) {
    return initialActivatedToolNames && initialActivatedToolNames.length > 0
      ? { activatedToolNames: [...initialActivatedToolNames] }
      : {};
  }
  return {
    toolWhitelist,
    activatedToolNames: toolWhitelist,
  };
}

export function subagentMemoryModeNote(subEnvelope: MemoryAccessEnvelope, toolWhitelist?: string[]): string {
  if (toolWhitelist?.includes("security_scan")) return "\n\n[Internal] This research Task retains its notes in the existing security_scan ledger. Record material source analysis, protections, decisions and pending work as you investigate. Save accepted checkpoints before context fills; use results pages to reload notes after compaction. The final report must account for unfinished work. Only use the tools exposed to this Task.";
  if (toolWhitelist && !toolWhitelist.includes("manage_memory")) return "\n\n[Internal] Use only the tools exposed to this Task and preserve important work with the available durable tools. Return the result within the authorized delegation scope.";
  return isScopeMemoryEnvelope(subEnvelope)
    ? "\n\n[Internal] You are running in scope-only memory mode: use search_memory / manage_memory — they apply to the delegation scope only. When finished, reply with a concise final answer for the parent agent."
    : "\n\n[Internal] You are running in the requesting user's private namespace: search_memory / manage_memory and file/artifact tools apply to their full private scope. Do NOT echo private content verbatim into your final answer unless it is exactly what they asked you to surface; return a concise result for the parent agent to relay.";
}

export type RunScopeSubagentResult =
  | {
      status: "completed";
      threadId: string;
      /** Full parent-facing transcript, including tool activity. */
      finalText: string;
      /** Last public assistant answer, safe for direct Task result delivery. */
      finalResponseText: string;
      /** Derived from scan receipts, never the model's final prose. */
      securityReportState?: "completed" | "partial" | null;
      securityResearchAppendix?: string | null;
    }
  | { status: "interrupted"; threadId: string; interrupt: Record<string, unknown> };

/** Missing or mismatched task provenance remains null rather than becoming main. */
export function resolveScopeSubagentExecutionEntrypoint(
  taskRun: boolean | undefined,
  trustedExecutionEntrypoint: "background.task" | undefined,
): TrustedExecutionEntrypoint | null {
  if (taskRun === true) {
    return trustedExecutionEntrypoint === "background.task"
      ? "background.task"
      : null;
  }
  return "foreground.subagent";
}

/**
 * one stream pass for a scope subagent (fresh or resumed).
 */
export function runScopeSubagentUntilPause(
  opts: RunScopeSubagentOpts,
): Promise<RunScopeSubagentResult> {
  return runWithLiveMiniAppExecutionContext(
    opts.liveMiniAppSession && opts.activeMiniApp
      ? Object.freeze({
          liveMiniAppSession: opts.liveMiniAppSession,
          activeMiniApp: opts.activeMiniApp,
        })
      : null,
    () => runWithTaskCausalHuman(opts.causalHumanUserId ?? "", () =>
      runWithInitiatingClientSurface("unknown", () => runScopeSubagentUntilPauseInternal(opts))),
  );
}

async function runScopeSubagentUntilPauseInternal(
  opts: RunScopeSubagentOpts,
): Promise<RunScopeSubagentResult> {
  if (
    opts.invocationCheckpointSaver !== undefined
    && !(opts.invocationCheckpointSaver instanceof EncryptedCheckpointSaver)
  ) {
    throw new TypeError(
      "Invocation-bound subagent requires an encrypted checkpoint saver",
    );
  }
  if (opts.taskRun && opts.invocationCheckpointSaver !== undefined) {
    throw new TypeError(
      "Background task subagent cannot inherit foreground checkpoint authority",
    );
  }
  const checkpointSaver = opts.invocationCheckpointSaver ?? createCheckpointSaver();
  const policyResolver = getPolicyResolver();
  // one shared graph execution policy seam (recursion ceiling
  // resolved here, threaded into `streamConfig` below). Metrics counts
  // supersteps / model invocations / tool calls from the existing
  // `streamEvents` hook; logged at stream end / on error (telemetry-only).
  const executionPolicy = resolveGraphExecutionPolicy();
  const metrics = new GraphExecutionMetrics();
  const researchNoteDraft = opts.taskRun && opts.toolWhitelist?.includes("security_scan")
    ? createResearchNoteDraft(opts.signal) : undefined;
  const graph = createNautiloGraph(
    checkpointSaver,
    policyResolver,
    researchNoteDraft ? { ...defaultPostModelDeps, researchNoteDraft } : defaultPostModelDeps,
  );

  const subThreadId =
    opts.subagentThreadId ??
    `${SUBAGENT_GRAPH_THREAD_PREFIX}${opts.parentThreadId}:${nanoid()}`;

  const memoryModeNote = subagentMemoryModeNote(opts.subEnvelope, opts.toolWhitelist);

  const briefLines = [
    opts.brief.trim(),
    opts.expectedOutput?.trim()
      ? `\n\nExpected output shape / success criteria:\n${opts.expectedOutput.trim()}`
      : "",
    memoryModeNote,
  ]
    .filter(Boolean)
    .join("");

  const userMessage = new HumanMessage(briefLines);

  const graphInput: Partial<NautiloState> = {
    noProgressStreaks: new Map(),
    browserDecision: null,
    noProgressPendingCorrection: null,
    noProgressPendingStop: null,
    // Fresh Tasks/subagents never inherit an earlier run's recovery phase.
    // Checkpoint continuation and approval resumes bypass this graphInput.
    researchContextRecovery: null,
    researchContextPageBytes: null,
    taskReadPageBytes: null,
    taskReadPendingPages: [],
    researchContinuationRequired: false,
    researchWorkEnabled: opts.toolWhitelist?.includes("security_scan") === true,
    messages: [userMessage],
    userId: opts.parentOwnerId,
    personaId: "owner",
    assistantName: opts.assistantName,
    soulFile: opts.soulFile,
    memoryBrief: "",
    memoryDelta: "",
    voiceMode: false,
    source: "subagent",
    model: opts.modelId,
    currentThreadId: subThreadId,
    langgraphThreadId: subThreadId,
    approvalLaneKey: opts.approvalLaneKey ?? subThreadId,
    memoryAccessEnvelope: opts.subEnvelope,
    actorRole: opts.actorRole,
    agentId: opts.subEnvelope.agentId,
    roomId: opts.roomId,
    callingRoomId: opts.callingRoomId ?? "",
    currentTaskId: opts.currentTaskId ?? "",
    currentTaskRunId: opts.currentTaskRunId ?? "",
    artifactRefs: opts.artifactRefs ?? [],
    focusedResources: opts.focusedResources ?? [],
    roomRoster: opts.roomRoster,
    turnId: opts.parentTurnId,
    currentFolder: opts.currentFolder,
    workspacePath: opts.workspacePath,
    activeMiniApp: opts.activeMiniApp ?? null,
    // A raw capability must never enter the checkpoint. Background sites read
    // only the AsyncLocalStorage context established around the whole runner.
    liveMiniAppSession: null,
    taskReportBackContinuation: opts.taskReportBackContinuation ?? null,
    securityAuditClientMeta: opts.securityAuditClientMeta,
    // Preserve the three composition states exactly: omitted = progressive
    // default, [] = none, explicit list = progressive hard ceiling plus the
    // cold-start activation seed. Without that seed a whitelist containing
    // only deferred tools exposes zero schemas and also excludes the core
    // activate_tools escape hatch, leaving the run unable to do its one job.
    ...scopeSubagentToolComposition(
      opts.toolWhitelist,
      opts.initialActivatedToolNames,
    ),
    subagentDepth: opts.subagentDepth,
    subagentMaxDepth: opts.subagentMaxDepth,
    suppressToolLifecycleEvents: true,
    subagentRun: true,
    taskRun: opts.taskRun ?? false,
    trustedExecutionEntrypoint: resolveScopeSubagentExecutionEntrypoint(
      opts.taskRun,
      opts.trustedExecutionEntrypoint,
    ),
    desktopAutomationProvenance: null,
    desktopAutomationRouteBinding: null,
    relayCapabilities: opts.relayCapabilities,
    verifiedOrdinaryOrigin: null,
    causalHumanUserId: opts.causalHumanUserId ?? "",
    // await-response context (only meaningful when awaitResponse is set).
    awaitResponse: opts.awaitResponse ?? false,
    awaitRoomId: opts.awaitRoomId ?? "",
    awaitFromUserIds: opts.awaitFromUserIds ?? [],
    awaitTaskId: opts.awaitTaskId ?? "",
    awaitTaskRunId: opts.awaitTaskRunId ?? "",
    awaitOwnerId: opts.awaitOwnerId ?? "",
    // persist the explicit fallback mode in cold-start graph
    // state so a checkpoint resume reads it back rather than re-deriving it
    // (a strict run must not widen into chain behavior on resume). Default
    // `"agent_chain"` keeps foreground / non-exact callers on the chain.
    modelFallbackMode: opts.modelFallbackMode ?? "agent_chain",
  };

  const streamConfig: Record<string, unknown> = {
    configurable: { thread_id: subThreadId },
    signal: opts.signal,
    recursionLimit: executionPolicy.recursionLimit,
    version: "v2",
    /**
     * Do not inherit the parent graph's streamEvents handler (ALS +
     * merged callbacks) — those tokens would fan out on the main chat
     * WebSocket. Background Tasks instead use the explicitly Room-scoped
     * token bridge below.
     */
    callbacks: [],
  };

  // Three stream-entry modes:
  // • continueFromCheckpoint → `null` input resumes the parked checkpoint on
  // the reused thread (an unpause after a pause abort; no interrupt reply,
  // no fresh brief). A revalidated security Task uses a continuation-only
  // Command below to refresh its socket binding without replacing history.
  // • resume defined → an interrupt reply `Command` (approval / await).
  // • else → a cold start with the freshly-built brief `graphInput`.
  //
  // INVARIANT (the related invariants): this is the ONLY place `graphInput.messages` is
  // constructed, and the cold-start branch builds it from exactly the brief —
  // NEVER from checkpoint/transcript history. The two resume branches stream a
  // `null` / `Command` and re-inject no messages. `classifyTurnKind` maps both
  // resume branches to `"resume"`; the subagent path keeps the parked
  // checkpoint (spec decision 10.2.3) and has no foreground-style "read history
  // + concat" seam to rebuild. Do not turn any branch into a rebuilt
  // `messages` array — that would be a behavior change ( §7).
  let streamInput = opts.continueFromCheckpoint
    ? null
    : opts.resume !== undefined
      ? new Command({ resume: opts.resume })
      : graphInput;
  // A resumed security Task keeps the same Run and canonical graph. Runtime
  // revalidates its original Desktop grant before dispatch; refresh only the
  // transport binding so a same-Desktop server reconnect can continue work.
  if (opts.continueFromCheckpoint && opts.taskRun && opts.toolWhitelist?.includes("security_scan")
    && opts.taskReportBackContinuation) {
    const saved = await graph.getState({ configurable: { thread_id: subThreadId } });
    streamInput = taskContinuationResumeCommand(saved?.values ?? {}, {
      taskId: opts.currentTaskId ?? "", taskRunId: opts.currentTaskRunId ?? "",
      ownerId: opts.parentOwnerId, graphThreadId: subThreadId,
      continuation: opts.taskReportBackContinuation,
    });
  }

  const savedFingerprints = new Set<string>();
  const progressTap = createTaskProgressTap(opts);
  const tokenStream =
    opts.taskRun && !opts.deferAssistantOutputToReportBack
      && opts.roomId && opts.subEnvelope.agentId && opts.parentTurnId
      ? new ScopeSubagentTokenStream({
          laneKey: `room:${opts.roomId}`,
          authorAgentId: opts.subEnvelope.agentId,
          turnId: opts.parentTurnId,
          emit: emitAgentEvent,
        })
      : null;

  try {
    const eventStream = graph.streamEvents(streamInput, streamConfig);
    for await (const ev of eventStream) {
      if (opts.signal?.aborted) break;
      metrics.noteStreamEvent(ev);
      // Report only into this subagent's canonical slot. A group turn can run
      // several agents concurrently, so a bare parent turn ID is unsafe.
      const activeTurnId = getCurrentTurnId() ?? opts.parentTurnId;
      recordStreamActivityFromEvent(
        ev,
        activeTurnId && opts.subEnvelope.agentId
          ? turnContextKey(activeTurnId, opts.subEnvelope.agentId)
          : undefined,
      );
      tokenStream?.noteStreamEvent(ev);
      const progressDetail = extractTaskProgressFromStreamEvent(ev);
      if (progressDetail) progressTap?.noteToolProgress(progressDetail);
      const batch = extractPersistedMessagesFromChainEnd(ev);
      if (batch.length === 0) continue;
      const assistantMessageKey = tokenStream?.completeMessage();
      await persistSubagentBatch(
        subThreadId,
        opts.transcriptOwnerId ?? opts.parentOwnerId,
        batch,
        savedFingerprints,
        {
          agentId: opts.subEnvelope.agentId,
          roomId: opts.roomId,
          humanTurnId: opts.parentTurnId,
          parentThreadId: opts.parentThreadId,
          ...(opts.deferAssistantOutputToReportBack
            ? { deferAssistantOutputToReportBack: true }
            : {}),
          ...(opts.scopeId !== undefined ? { scopeId: opts.scopeId } : {}),
          ...(assistantMessageKey ? { assistantMessageKey } : {}),
          ...(opts.assistantArtifactExternalIds?.length
            ? { assistantArtifactExternalIds: opts.assistantArtifactExternalIds }
            : {}),
        },
      );
    }
    progressTap?.flush();
    log(`[scope-subagent] stream complete thread=${subThreadId} ${metrics.formatLogToken()}`);
  } catch (err) {
    // surface the typed internal graph-budget outcome distinctly
    // in telemetry . The user-safe sentence is produced by
    // `toFriendlyError` at the runtime job-loop catch site when the
    // subagent error propagates up to a foreground / fork job.
    const budgetOutcome = toGraphBudgetOutcome(err, executionPolicy.recursionLimit);
    if (budgetOutcome) {
      log(
        `[scope-subagent] graph budget exceeded thread=${subThreadId} ` +
          `outcome=${budgetOutcome.kind} recursionLimit=${budgetOutcome.recursionLimit} ${metrics.formatLogToken()}`,
      );
    } else {
      log(
        `[scope-subagent] stream error: ${err instanceof Error ? err.message : String(err)} thread=${subThreadId} ${metrics.formatLogToken()}`,
      );
    }
    throw err;
  } finally {
    progressTap?.dispose();
    researchNoteDraft?.dispose();
    tokenStream?.dispose();
  }

  // INVARIANT : this end-of-run `getState` read is OUTPUT EXTRACTION
  // ONLY. `postState.values.messages` produces the parent-facing final text
  // (`formatSubagentTranscriptForParent` / `lastAssistantPlainText`) and the
  // pending-interrupt check — it is NEVER fed back into `graphInput.messages`
  // as turn history. This is the one legitimate `.values.messages` read in the
  // runner; the invariant is "no checkpoint history → `graphInput.messages`",
  // not "no `getState` at all" ( §3 ).
  const postState = (await graph.getState({
    configurable: { thread_id: subThreadId },
  })) as
    | {
        values?: { messages?: BaseMessage[] };
        tasks?: Array<Record<string, unknown>>;
      }
    | undefined;

  const interrupt = extractPendingInterruptValue(postState);
  if (interrupt) {
    return { status: "interrupted", threadId: subThreadId, interrupt };
  }

  const messages = postState?.values?.messages ?? [];
  const transcript = formatSubagentTranscriptForParent(messages);
  const finalResponseText =
    lastAssistantPlainText(messages) ||
    "(subagent completed with no text)";
  return {
    status: "completed",
    threadId: subThreadId,
    finalText: transcript || finalResponseText,
    finalResponseText,
    securityReportState: securityReportReadiness(messages),
    securityResearchAppendix: securityResearchAppendix(messages),
  };
}

async function persistSubagentBatch(
  threadId: string,
  ownerId: string,
  batch: BaseMessage[],
  savedFingerprints: Set<string>,
  meta: {
    agentId: string;
    roomId: string;
    humanTurnId: string;
    parentThreadId: string;
    deferAssistantOutputToReportBack?: boolean;
    scopeId?: string;
    assistantMessageKey?: string;
    assistantArtifactExternalIds?: readonly string[];
  },
): Promise<void> {
  const newPairs: Array<{ msg: BaseMessage; fp: string }> = [];
  for (const msg of batch) {
    const fp = computeMessageFingerprint(
      msg,
      meta.humanTurnId ? { humanTurnId: meta.humanTurnId } : {},
    );
    if (savedFingerprints.has(fp)) continue;
    newPairs.push({ msg, fp });
  }
  if (newPairs.length === 0) return;

  const result = await appendTranscriptMessages(
    threadId,
    ownerId,
    "owner",
    newPairs.map((p) => p.msg),
    {
      agentId: meta.agentId,
      roomId: meta.roomId,
      humanTurnId: meta.humanTurnId,
      transcriptOrigin: "subagent",
      parentThreadId: meta.parentThreadId,
      ...(meta.deferAssistantOutputToReportBack
        ? { metadata: { originatedBy: "scheduled_task_internal" } }
        : {}),
      ...(meta.scopeId !== undefined ? { scopeId: meta.scopeId } : {}),
    },
  );

  if (meta.roomId) {
    const toolTracker = new AgentToolCallTracker(
      `room:${meta.roomId}`,
      meta.agentId || undefined,
      meta.humanTurnId || undefined,
    );
    for (const { msg } of newPairs) {
      if (AIMessage.isInstance(msg)) {
        for (const call of msg.tool_calls ?? []) {
          const toolCallId = typeof call.id === "string" ? call.id : "";
          const toolName = typeof call.name === "string" ? call.name : "tool";
          if (!toolCallId) continue;
          emitAgentEvent(toolTracker.toolStart(toolCallId, toolName, call.args));
        }
      } else if (ToolMessage.isInstance(msg)) {
        const raw = msg as unknown as {
          tool_call_id?: unknown;
          name?: unknown;
        };
        const toolCallId =
          typeof raw.tool_call_id === "string" ? raw.tool_call_id : "";
        const toolName = typeof raw.name === "string" && raw.name ? raw.name : "tool";
        if (!toolCallId) continue;
        const failed = msg.status === "error" || msg.additional_kwargs["nautilo_tool_status"] === "error";
        emitAgentEvent(
          toolTracker.toolEnd(
            toolCallId,
            toolName,
            failed ? "error" : "success",
            undefined,
            messageContentToPlainString(msg.content),
          ),
        );
      }
    }

    for (const row of result.insertedRows) {
      if (row.role !== "assistant") continue;
      if (row.content === null) {
        throw new Error("Subagent transcript ordinary content is unavailable");
      }
      if (row.content.trim().length === 0) continue;
      let artifacts: MessageArtifactOpenRef[] | undefined;
      if (meta.assistantArtifactExternalIds?.length) {
        try {
          artifacts = await authorAssistantArtifactCards({
            messageId: row.id,
            roomId: meta.roomId,
            externalArtifactIds: meta.assistantArtifactExternalIds,
          });
        } catch {
          log(
            "[scope-subagent] Artifact card authoring failed without blocking peer delivery",
          );
        }
      }
      if (meta.deferAssistantOutputToReportBack) continue;
      emitAgentEvent({
        type: "message.new",
        laneKey: `room:${meta.roomId}`,
        messageId: row.id,
        role: "ai",
        content: row.content,
        ...(meta.agentId ? { authorAgentId: meta.agentId } : {}),
        ...(meta.assistantMessageKey
          ? { assistantMessageKey: meta.assistantMessageKey }
          : {}),
        ...(artifacts?.length ? { artifacts } : {}),
      });
    }
  }

  for (const p of newPairs) savedFingerprints.add(p.fp);
}

/**
 * author Artifact cards only from the runtime-stamped ask_peer path.
 * The canonical Room namespace is re-checked both before relation insertion
 * and during hydration; arbitrary assistant prose can never reach this seam.
 */
export async function authorAssistantArtifactCards(args: {
  messageId: string | number;
  roomId: string;
  externalArtifactIds: readonly string[];
}): Promise<MessageArtifactOpenRef[] | undefined> {
  const messageId = Number(args.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0 || !args.roomId || args.externalArtifactIds.length === 0) {
    return undefined;
  }
  const canonicalRoomNamespaceId = await getRoomNamespaceId(args.roomId);
  if (!canonicalRoomNamespaceId) return undefined;
  const internalRows = await findArtifactInternalIdsForCanonicalNamespace({
    externalArtifactIds: args.externalArtifactIds,
    canonicalRoomNamespaceId,
  });
  const ordered = args.externalArtifactIds.flatMap((externalId) => {
    const internalId = internalRows.get(externalId);
    return internalId ? [internalId] : [];
  }).filter((internalId, index, all) => all.indexOf(internalId) === index);
  if (ordered.length === 0) return undefined;
  await recordMessageArtifacts({ messageId, artifactInternalIds: ordered });
  const hydrated = await hydrateMessageArtifacts({
    messageIds: [messageId],
    canonicalRoomNamespaceId,
    roomId: args.roomId,
  });
  const current = hydrated.get(messageId);
  return current?.length ? current : undefined;
}
