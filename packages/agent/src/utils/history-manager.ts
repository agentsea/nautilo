import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  getContentAsString,
  getToolCalls,
  hasToolCalls,
  validateMessageHistory,
} from "@nautilo/message-invariants";
import { securityScanToolResultSchema, type SecurityScanLedgerRecord, type SecurityScanResultEnvelope } from "@nautilo/types";
import { getModelTokenLimit } from "../providers/models";
import { projectOversizedTaskRead, taskReadPageFingerprint, pageSchema, type TaskReadPendingPage } from "../tools/tasks/read-projection";

export interface HistoryConfig {
  validationEnabled: boolean;
  pruningEnabled: boolean;
  tokenBudgetFraction: number;
  windowKeepRecent: number;
  modelId: string;
  /** A restricted research Task can reload accepted notes from its existing scan ledger. */
  researchContinuity?: boolean;
}

export interface ProcessedHistory {
  messages: BaseMessage[];
  /** Retained task.read cycles keep their original receipts outside provider projection. */
  canonicalMessages?: BaseMessage[];
  validation: { repairs: string[] };
  pruning: { pruned: string[] };
  windowing: { removedCount: number; researchReloadRequired?: boolean; researchConclusionsProjected?: boolean; researchConclusionsOverview?: boolean };
  /** D276 Tier 2 — count of individual messages whose content was clamped. */
  clamping: { clampedCount: number };
}

/**
 * D276 Tier 2 — no single message may exceed this fraction of the token
 * budget. Turn-count windowing keeps the last N turns but never shrinks an
 * individual message, so one oversized message (e.g. a huge tool result) can
 * exceed the model's context window and wedge a room. This clamp is the
 * defensive backstop: it elides the MIDDLE of any over-budget message's string
 * content (keeping head+tail) so no single message can dominate the window.
 */
const PER_MESSAGE_MAX_BUDGET_FRACTION = 0.3;
/** Floor so the clamp never produces a uselessly tiny message. */
const PER_MESSAGE_MIN_CHARS = 2_000;

/** Reuse the existing per-message projection policy without truncating Task data. */
export function taskReadResponseByteBudget(
  config: Pick<HistoryConfig, "tokenBudgetFraction" | "modelId">,
  maxMessageTokens: number,
  preparedMessages: BaseMessage[],
): number {
  const tokenBudget = Math.floor(getModelTokenLimit(config.modelId) * config.tokenBudgetFraction);
  const perMessageBudget = Math.max(PER_MESSAGE_MIN_CHARS, Math.floor(tokenBudget * PER_MESSAGE_MAX_BUDGET_FRACTION) * 4);
  // Share the actual remaining workspace with the next model turn. The page
  // measures its entire escaped UTF-8 envelope, not just the inner text.
  const freeWorkspaceBytes = Math.floor(Math.max(0, maxMessageTokens - estimateTokenCount(preparedMessages)) / 2) * 4;
  return Math.min(perMessageBudget, freeWorkspaceBytes);
}

/** Preserve omitted ranges across ordinary history windowing without storing source again. */
export function pendingTaskReadPages(canonical: BaseMessage[], prepared: BaseMessage[], previous: TaskReadPendingPage[] = []): TaskReadPendingPage[] {
  const pages = (messages: BaseMessage[]) => {
    const calls = new Map<string, { name: string; args: Record<string, unknown> } | null>();
    return messages.flatMap((message) => {
      if (AIMessage.isInstance(message)) {
        for (const call of message.tool_calls ?? []) if (call.id) calls.set(call.id, calls.has(call.id) ? null : { name: call.name, args: call.args });
        return [];
      }
      if (!ToolMessage.isInstance(message)) return [];
      const call = calls.get(message.tool_call_id);
      calls.delete(message.tool_call_id);
      if (call?.name !== "task" || call.args["command"] !== "read" || message.name !== "task" || typeof message.content !== "string") return [];
      if (message.status === "error" || message.additional_kwargs["nautilo_tool_status"] === "error") return [];
      try {
        const parsed = pageSchema.safeParse(JSON.parse(message.content));
        const fingerprint = taskReadPageFingerprint(message.content);
        if (!parsed.success || !fingerprint || call.args["taskId"] !== parsed.data.taskId) return [];
        for (const field of ["runId", "readSection", "readSearch"] as const) {
          if (call.args[field] !== undefined && call.args[field] !== parsed.data[field]) return [];
        }
        if (call.args["readCursor"] !== undefined && call.args["readCursor"] !== parsed.data.resolvedSelection.readCursor) return [];
        return [{ fingerprint, page: parsed.data }];
      } catch { return []; }
    });
  };
  const retained = pages(canonical);
  const visible = pages(prepared);
  const retainedKeys = new Set(retained.map(({ fingerprint }) => fingerprint));
  const visibleKeys = new Set(visible.map(({ fingerprint }) => fingerprint));
  const pending = new Map(previous.filter((entry) => entry.startByte < entry.endByte || retainedKeys.has(entry.fingerprint))
    .map((entry) => [entry.fingerprint, entry]));
  for (const { fingerprint, page } of retained) {
    if (visibleKeys.has(fingerprint) || pending.has(fingerprint)) continue;
    pending.set(fingerprint, { fingerprint, taskId: page.taskId, runId: page.runId, readSection: page.readSection,
      ...(page.readSearch === undefined ? {} : { readSearch: page.readSearch }), sourceVersion: page.sourceVersion,
      startByte: page.startByte, endByte: page.endByte, resolvedSelection: page.resolvedSelection });
  }
  return [...pending.values()].flatMap((entry) => {
    let startByte = entry.startByte;
    let resolvedSelection = entry.resolvedSelection;
    const replacements = visible.filter(({ page }) => page.taskId === entry.taskId && page.runId === entry.runId
      && page.readSection === entry.readSection && page.readSearch === entry.readSearch && page.sourceVersion === entry.sourceVersion)
      .sort((a, b) => a.page.startByte - b.page.startByte);
    for (const { page } of replacements) {
      if (page.startByte > startByte) break;
      if (page.endByte <= startByte) continue;
      startByte = Math.min(entry.endByte, page.endByte);
      if (startByte < entry.endByte && page.nextCursor) resolvedSelection = { ...resolvedSelection, readCursor: page.nextCursor };
      if (startByte === entry.endByte) break;
    }
    // Keep an empty acknowledgment while the omitted original remains in
    // canonical history, so its projection cannot reopen already-read bytes.
    if (startByte === entry.endByte && !retainedKeys.has(entry.fingerprint)) return [];
    return [{ ...entry, startByte, resolvedSelection }];
  });
}

export function estimateTokenCount(messages: BaseMessage[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    totalChars += getContentAsString(msg.content).length;
    if (hasToolCalls(msg)) totalChars += JSON.stringify(getToolCalls(msg)).length;
  }
  return Math.ceil(totalChars / 4);
}

/** Find a durable checkpoint only through a paired, schema-valid tool acknowledgement. */
export function windowResearchHistory(
  messages: BaseMessage[],
  tokenBudget: number,
): { messages: BaseMessage[]; removedCount: number; researchReloadRequired?: boolean; researchConclusionsProjected?: boolean; researchConclusionsOverview?: boolean } {
  const calls = new Map<string, { index: number; operation: unknown; category: unknown }>();
  const finalBatches = new Map<number, { expected: Set<string>; received: Set<string>; indices: Set<number> }>();
  const finalRecords = new Map<number, SecurityScanLedgerRecord[]>();
  const finalPages = new Map<number, SecurityScanResultEnvelope>();
  let reloadedAt = -1;
  let checkpoint: { index: number; openRecordIds: Set<string>; reloadedRecordIds: Set<string> } | undefined;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (AIMessage.isInstance(message)) {
      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length > 0 && toolCalls.every((call) => call.id && call.name === "security_scan"
        && call.args["operation"] === "results" && call.args["category"] === "all"
        && call.args["finalize"] === true && call.args["probes"] === undefined
        && call.args["recordKinds"] === undefined && call.args["recordIds"] === undefined)) {
        finalBatches.set(index, { expected: new Set(toolCalls.map((call) => call.id!)),
          received: new Set(), indices: new Set([index]) });
      }
      for (const call of message.tool_calls ?? []) {
        if (call.name === "security_scan" && call.id) {
          calls.set(call.id, { index,
            operation: call.args["operation"], category: call.args["category"] });
        }
      }
    } else if (ToolMessage.isInstance(message) && message.name === "security_scan") {
      const call = calls.get(message.tool_call_id);
      calls.delete(message.tool_call_id);
      if (!call || typeof message.content !== "string") continue;
      let value: unknown;
      try { value = JSON.parse(message.content); } catch { continue; }
      const receipt = securityScanToolResultSchema.safeParse(value);
      if (!receipt.success || !receipt.data.ok || receipt.data.operation !== call.operation) continue;
      if (receipt.data.operation === "start") { checkpoint = undefined; reloadedAt = -1; finalBatches.clear(); finalRecords.clear(); finalPages.clear(); }
      if (receipt.data.operation === "results") {
        const status = receipt.data.result.status;
        const batch = finalBatches.get(call.index);
        if (batch && status.modelState === "completed" && (status.state === "completed" || status.state === "partial")) {
          batch.received.add(message.tool_call_id);
          batch.indices.add(index);
          finalRecords.set(index, receipt.data.result.records.filter((record) => record.entry.kind === "finding" || record.entry.kind === "dismissal"));
          finalPages.set(index, receipt.data.result);
        }
      }
      if (receipt.data.operation === "record"
        && receipt.data.result.record.entry.kind === "checkpoint") {
        checkpoint = { index: call.index,
          openRecordIds: new Set(receipt.data.result.record.entry.openRecordIds),
          reloadedRecordIds: new Set() };
      }
      if (receipt.data.operation === "status" && checkpoint && checkpoint.openRecordIds.size === 0) reloadedAt = index;
      if (receipt.data.operation === "results" && checkpoint
        && (call.category === "research" || call.category === "all")) {
        const activeCheckpoint = checkpoint;
        // A final page of an unrelated or empty selection does not reload the
        // checkpoint's pending work. Accumulate only actual accepted records;
        // every named open record must be visible after this checkpoint.
        for (const record of receipt.data.result.records) {
          if (checkpoint.openRecordIds.has(record.id)) checkpoint.reloadedRecordIds.add(record.id);
        }
        if (receipt.data.result.nextCursor === null
          && [...activeCheckpoint.openRecordIds].every((id) => activeCheckpoint.reloadedRecordIds.has(id))) reloadedAt = index;
      }
    }
  }
  const completeFinalBatches = [...finalBatches.entries()]
    .filter(([, batch]) => batch.received.size === batch.expected.size);
  const latestFinalBatch = completeFinalBatches.at(-1)?.[0];
  const latestBatch = completeFinalBatches.at(-1);
  const olderBatches = completeFinalBatches.filter(([index]) => index !== latestFinalBatch);
  const projectedFinalIndices = new Set(olderBatches.flatMap(([, batch]) => [...batch.indices]));
  if (!checkpoint && latestFinalBatch === undefined) return { messages: [...messages], removedCount: 0 };
  // Full conclusions remain visible during synthesis. Omit only bulky indexes
  // from older finalized pages, with an explicit provider-projection marker.
  // The canonical messages are untouched, including all appendix bytes.
  const conclusionRecords = new Map<string, { index: number; record: SecurityScanLedgerRecord }>();
  for (const [, batch] of olderBatches) for (const index of batch.indices) {
    for (const record of finalRecords.get(index) ?? []) conclusionRecords.set(record.id, { index, record });
  }
  const retainedIndices = new Set<number>();
  const replacements = new Map<number, BaseMessage>();
  const retainedBatches = olderBatches.filter(([, batch]) => [...conclusionRecords.values()].some((item) => batch.indices.has(item.index)));
  const recordsAt = (index: number) => [...conclusionRecords.values()].filter((item) => item.index === index).map((item) => item.record);
  const project = (index: number, records: SecurityScanLedgerRecord[], recordIndex?: Array<{ id: string; kind: string; title?: string }>, omittedIndexEntries = 0): void => {
    const original = messages[index]!;
    if (!ToolMessage.isInstance(original)) return;
    const page = latestBatch?.[1].indices.has(index) ? finalPages.get(index) : undefined;
    replacements.set(index, new ToolMessage({
      content: JSON.stringify({ contextProjection: {
        kind: "finalized_research_conclusions", canonicalRetained: true,
        omitted: ["inventory", "observations", "source citation index", "other research records"],
        ...(recordIndex ? { fullConclusionsOutsideWindow: true, totalConclusions: conclusionRecords.size, omittedIndexEntries,
          finalProse: "Provide an explicitly labelled overview; the full accepted review log is appended by the runtime." } : {}),
        recovery: { tool: "security_scan", operation: "results", category: "research", finalize: false, limit: 1,
          instruction: "Retrieve one needed recordId at a time using recordIds:[id], limit:1, finalize:false. For conclusions outside the index use recordKinds:[finding,dismissal], limit:1 and continueResults to page those notes. Do not replay the oversized all-results page. Continue unfinished final pagination with the original arguments and continueResults:true; nextCursor is preserved below." },
      }, records, ...(recordIndex ? { recordIndex } : {}),
      ...(page ? { finalPage: { version: page.version, status: page.status, nextCursor: page.nextCursor,
        ...(page.reportReady !== undefined ? { reportReady: page.reportReady } : {}),
        canonicalItemCounts: { records: page.records.length, observations: page.observations.length,
          codeEvidence: page.codeEvidence.length, inventory: page.inventory?.length ?? 0 } } } : {}) }),
      ...(original.name !== undefined ? { name: original.name } : {}),
      tool_call_id: original.tool_call_id,
      ...(original.id !== undefined ? { id: original.id } : {}),
      additional_kwargs: original.additional_kwargs, response_metadata: original.response_metadata,
      ...(original.status ? { status: original.status } : {}),
    }));
  };
  for (const [, batch] of retainedBatches) for (const index of batch.indices) {
    retainedIndices.add(index);
    project(index, recordsAt(index));
  }
  const buildKept = () => messages.flatMap((message, index) => {
    if (HumanMessage.isInstance(message) || SystemMessage.isInstance(message)) return [message];
    if (projectedFinalIndices.has(index) && !retainedIndices.has(index)) return [];
    if (checkpoint && index < checkpoint.index) return [];
    return [replacements.get(index) ?? message];
  });
  let kept = buildKept();
  let overview = false;
  if (latestBatch && estimateTokenCount(kept) > tokenBudget) {
    // A valid 100-item page can itself exceed context. Preserve final paging
    // authority separately from the disclosed provider-only payload projection.
    for (const index of latestBatch[1].indices) {
      for (const record of finalRecords.get(index) ?? []) conclusionRecords.set(record.id, { index, record });
      projectedFinalIndices.add(index);
      retainedIndices.add(index);
    }
    retainedBatches.push(latestBatch);
    for (const index of latestBatch[1].indices) project(index, recordsAt(index));
    kept = buildKept();
  }
  if (conclusionRecords.size > 0 && estimateTokenCount(kept) > tokenBudget) {
    // If whole conclusions cannot fit, retain a recoverable index, never a
    // head/tail slice masquerading as a complete conclusion. Consolidating the
    // index into one intact older batch also bounds repeated receipt overhead.
    overview = true;
    retainedIndices.clear();
    replacements.clear();
    // Keep the latest page's status and continuation even when the shared
    // conclusion index is consolidated into another intact tool batch.
    if (latestBatch && projectedFinalIndices.has(latestBatch[0])) {
      for (const index of latestBatch[1].indices) { retainedIndices.add(index); project(index, []); }
    }
    const indexBatch = retainedBatches.at(-1)![1];
    const indexTarget = [...indexBatch.indices].find((index) => ToolMessage.isInstance(messages[index]!))!;
    for (const index of indexBatch.indices) { retainedIndices.add(index); project(index, []); }
    const recordIndex = [...conclusionRecords.values()].map(({ record }) => ({ id: record.id, kind: record.entry.kind,
      ...("title" in record.entry ? { title: record.entry.title } : {}) }));
    // The configured model budget, rather than a record quota, determines how
    // much of the recovery index fits. Every omitted index entry is disclosed.
    let low = 0;
    let high = recordIndex.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      project(indexTarget, [], recordIndex.slice(0, middle), recordIndex.length - middle);
      if (estimateTokenCount(buildKept()) <= tokenBudget) low = middle;
      else high = middle - 1;
    }
    project(indexTarget, [], recordIndex.slice(0, low), recordIndex.length - low);
    kept = buildKept();
  }
  return {
    messages: kept,
    removedCount: messages.length - kept.length,
    ...(projectedFinalIndices.size > 0 ? { researchConclusionsProjected: true } : {}),
    ...(overview ? { researchConclusionsOverview: true } : {}),
    ...(checkpoint && latestFinalBatch === undefined && kept.length < messages.length && reloadedAt < checkpoint.index
      ? { researchReloadRequired: true } : {}),
  };
}

function windowMessages(
  messages: BaseMessage[],
  config: Pick<HistoryConfig, "tokenBudgetFraction" | "windowKeepRecent" | "modelId" | "researchContinuity">,
): { messages: BaseMessage[]; removedCount: number; researchReloadRequired?: boolean; researchConclusionsProjected?: boolean; researchConclusionsOverview?: boolean } {
  if (messages.length === 0) return { messages: [], removedCount: 0 };

  const tokenLimit = getModelTokenLimit(config.modelId);
  const tokenBudget = Math.floor(tokenLimit * config.tokenBudgetFraction);
  if (estimateTokenCount(messages) <= tokenBudget) return { messages: [...messages], removedCount: 0 };

  if (config.researchContinuity) return windowResearchHistory(messages, tokenBudget);

  const hasSystemMsg = messages[0] instanceof SystemMessage;
  const contentStart = hasSystemMsg ? 1 : 0;
  const turnBoundaries: number[] = [];
  for (let i = contentStart; i < messages.length; i++) {
    if (messages[i] instanceof HumanMessage) turnBoundaries.push(i);
  }
  if (turnBoundaries.length === 0) return { messages: [...messages], removedCount: 0 };

  const turnsToKeep = Math.max(1, Math.ceil(config.windowKeepRecent / 4));
  const turnsToRemove = Math.max(0, turnBoundaries.length - turnsToKeep);
  if (turnsToRemove === 0) return { messages: [...messages], removedCount: 0 };

  const safeStart = turnBoundaries[turnsToRemove]!;
  const result: BaseMessage[] = [];
  if (hasSystemMsg) result.push(messages[0]!);
  for (let i = safeStart; i < messages.length; i++) result.push(messages[i]!);
  return { messages: result, removedCount: safeStart - contentStart };
}

/** Elide the middle of an over-budget string, keeping head + tail + a marker. */
function clampString(
  content: string,
  maxChars: number,
  recovery = "re-read the source (e.g. file:read on the full-output path)",
): string {
  const head = Math.floor(maxChars / 2);
  const tail = maxChars - head;
  const omitted = content.length - head - tail;
  return (
    content.slice(0, head) +
    `\n\n…[${omitted} chars elided to protect the context window — re-read the source ` +
    `${recovery} if you need the middle]…\n\n` +
    content.slice(content.length - tail)
  );
}

/**
 * D276 Tier 2 — clamp the content of any SINGLE message that alone exceeds
 * `PER_MESSAGE_MAX_BUDGET_FRACTION` of the token budget. Pure transform:
 *
 * - No-op for every message under budget.
 * - Handles `ToolMessage`, `HumanMessage`, and raw Task result `AIMessage`s.
 *   Ordinary model `AIMessage`s remain exempt because their selected model
 *   already bounded them and clamping could decouple tool calls.
 * - Elides the MIDDLE (head+tail+marker); NEVER drops a message and NEVER
 *   touches `tool_call_id` / `id` / role — tool-call/tool-result pairing and
 *   message count are preserved.
 * - REBUILDS via the real constructor (same idiom as message-invariants'
 *   `removeToolCallsFromAIMessage`), never mutating the graph-state objects and
 *   keeping `lc_kwargs` consistent for provider serialization.
 */
function clampOversizedMessages(
  messages: BaseMessage[],
  config: Pick<HistoryConfig, "tokenBudgetFraction" | "modelId" | "researchContinuity">,
): { messages: BaseMessage[]; clampedCount: number; taskReadOriginals: WeakMap<BaseMessage, BaseMessage> } {
  const tokenLimit = getModelTokenLimit(config.modelId);
  const tokenBudget = Math.floor(tokenLimit * config.tokenBudgetFraction);
  const perMessageMaxChars = Math.max(
    PER_MESSAGE_MIN_CHARS,
    Math.floor(tokenBudget * PER_MESSAGE_MAX_BUDGET_FRACTION) * 4, // ~4 chars/token (mirrors estimateTokenCount)
  );

  let clampedCount = 0;
  const taskReadOriginals = new WeakMap<BaseMessage, BaseMessage>();
  const pendingCalls = new Map<string, { name: string; args: Record<string, unknown> } | null>();
  const out = messages.map((msg) => {
    if (AIMessage.isInstance(msg)) {
      for (const call of msg.tool_calls ?? []) {
        if (call.id) pendingCalls.set(call.id, pendingCalls.has(call.id) ? null : { name: call.name, args: call.args });
      }
    }
    const paired = ToolMessage.isInstance(msg) ? pendingCalls.get(msg.tool_call_id) : undefined;
    if (ToolMessage.isInstance(msg)) pendingCalls.delete(msg.tool_call_id);
    // Research source windows and accepted ledger JSON must stay recoverable
    // and parseable. Arbitrary head/tail elision destroys citation/receipt data.
    // Window only checkpointed complete cycles instead of slicing these bytes.
    if (config.researchContinuity && (ToolMessage.isInstance(msg)
      || HumanMessage.isInstance(msg))) return msg;
    if (typeof msg.content !== "string") return msg; // skip multimodal/array content
    if (msg.content.length <= perMessageMaxChars) return msg;
    // M219 Room context is already model-window-budgeted before it becomes a
    // single transient HumanMessage. Re-clamping it here would silently reduce
    // the configured percentage and could split a protected complete turn.
    if (msg.additional_kwargs?.["nautilo_room_context_budgeted"] === true) return msg;

    if (msg instanceof ToolMessage) {
      let projectedTaskRead: Record<string, unknown> | null = null;
      if (msg.name === "task" && paired?.name === "task" && paired.args["command"] === "read") {
        let value: unknown = null;
        try { value = JSON.parse(msg.content); } catch { /* Older checkpoints may already contain a lossy clamp. */ }
        projectedTaskRead = projectOversizedTaskRead(value, paired.args, perMessageMaxChars) ?? {
          version: "task-read-v1", kind: "error", code: "task_read_budget_unavailable",
          message: "The Task data and exact replay header do not fit this window. No content was shown. Reserve response space and retry the original task.read selection; continuation must recover omitted pages before advancing.",
        };
      }
      clampedCount += 1;
      const projected = new ToolMessage({
        content: projectedTaskRead ? JSON.stringify(projectedTaskRead) : clampString(msg.content, perMessageMaxChars),
        tool_call_id: msg.tool_call_id,
        ...(msg.name !== undefined ? { name: msg.name } : {}),
        ...(msg.id !== undefined ? { id: msg.id } : {}),
        additional_kwargs: msg.additional_kwargs,
        response_metadata: msg.response_metadata,
        ...(msg.artifact !== undefined ? { artifact: msg.artifact as unknown } : {}),
        ...(msg.status !== undefined ? { status: msg.status } : {}),
      });
      if (projectedTaskRead) taskReadOriginals.set(projected, msg);
      return projected;
    }
    if (msg instanceof HumanMessage) {
      clampedCount += 1;
      return new HumanMessage({
        content: clampString(msg.content, perMessageMaxChars),
        ...(msg.name !== undefined ? { name: msg.name } : {}),
        ...(msg.id !== undefined ? { id: msg.id } : {}),
        additional_kwargs: msg.additional_kwargs,
        response_metadata: msg.response_metadata,
      });
    }
    if (AIMessage.isInstance(msg) && msg.id?.startsWith("task-result:")) {
      clampedCount += 1;
      const clamped = new AIMessage({
        content: clampString(
          msg.content,
          perMessageMaxChars,
          "use task read for the corresponding full canonical task result",
        ),
        additional_kwargs: msg.additional_kwargs,
        response_metadata: msg.response_metadata,
        ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
      });
      clamped.id = msg.id;
      return clamped;
    }
    // AIMessage / SystemMessage / other roles: leave untouched.
    return msg;
  });

  return { messages: out, clampedCount, taskReadOriginals };
}

export function processHistory(messages: BaseMessage[], config: HistoryConfig): ProcessedHistory {
  let current = messages;
  const result: ProcessedHistory = {
    messages: [],
    validation: { repairs: [] },
    pruning: { pruned: [] },
    windowing: { removedCount: 0 },
    clamping: { clampedCount: 0 },
  };

  // Layer 0 — Per-message clamp (D276 Tier 2). Runs first so no single
  // oversized message survives into windowing/validation or the invoke.
  const clamped = clampOversizedMessages(current, config);
  current = clamped.messages;
  result.clamping.clampedCount = clamped.clampedCount;

  // Layer 1 — Pruning (papyrus pattern, slot reserved for future
  // per-document staleness rules). No-op today.
  // if (config.pruningEnabled) { … }

  // Layer 2 — Windowing (token budget).
  const windowing = windowMessages(current, config);
  current = windowing.messages;
  result.windowing = { removedCount: windowing.removedCount,
    ...(windowing.researchReloadRequired ? { researchReloadRequired: true } : {}),
    ...(windowing.researchConclusionsProjected ? { researchConclusionsProjected: true } : {}),
    ...(windowing.researchConclusionsOverview ? { researchConclusionsOverview: true } : {}) };

  // Layer 3 — Validation runs LAST as the final safety net.
  // This is where D143 Layer 3 (tool_call_id dedupe + orphan repair)
  // catches anything pruning/windowing produced or anything the
  // canonical state already had broken.
  if (config.validationEnabled) {
    const validation = validateMessageHistory(current);
    current = validation.messages;
    result.validation.repairs = validation.repairs;
  }

  result.messages = current;
  if (current.some((message) => clamped.taskReadOriginals.has(message))) {
    result.canonicalMessages = current.map((message) => clamped.taskReadOriginals.get(message) ?? message);
  }
  return result;
}
