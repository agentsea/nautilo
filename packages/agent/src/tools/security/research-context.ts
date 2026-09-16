import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { createHash } from "node:crypto";
import { z } from "zod";
import { securityScanRecordKindSchema, securityScanRelativePathSchema, type SecurityResearchContextSource, securityResearchContextReceiptSchema, type SecurityResearchContextSelection, type SecurityResearchRuntimeRecovery } from "@nautilo/types";
import { deriveResearchSavedState, pairedResearchReceipts } from "./research-saved-state";
import type { NautiloState } from "../../agent/state";

type ContextState = Pick<NautiloState, "messages" | "userId" | "currentTaskId" | "currentTaskRunId" | "subagentRun" | "toolWhitelist"> & Partial<Pick<NautiloState, "researchContextRecovery">>;
const researchContextRequestSchema = z.strictObject({
  version: z.literal("security-scan-v1"),
  operation: z.literal("context"),
  contextRef: z.string().min(1).optional(),
  continueContext: z.boolean().optional(),
  contextCursor: z.string().min(1).optional(),
  contextBytes: z.number().int().positive().safe().optional(),
  recordKinds: z.array(securityScanRecordKindSchema).optional(),
  contextSourcePath: securityScanRelativePathSchema.optional(),
});
const digest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const allowed = (state: ContextState): boolean => state.subagentRun === true
  && Boolean(state.userId && state.currentTaskId && state.currentTaskRunId)
  && state.toolWhitelist?.includes("security_scan") === true;

/** Only visible text and tool calls: never reasoning, encrypted sidecars or other kwargs. */
export function serializeResearchContextMessage(message: BaseMessage): string | null {
  if (!AIMessage.isInstance(message) && !ToolMessage.isInstance(message)) return null;
  const content = typeof message.content === "string" ? message.content : message.content.flatMap((block) => {
    if (typeof block === "string") return [block];
    return block["type"] === "text" && typeof block["text"] === "string" ? [block["text"]] : [];
  });
  return JSON.stringify({ role: AIMessage.isInstance(message) ? "assistant" : "tool", content,
    ...(message.name ? { name: message.name } : {}),
    ...(ToolMessage.isInstance(message) ? { toolCallId: message.tool_call_id } : {}),
    ...(AIMessage.isInstance(message) && message.tool_calls?.length ? { toolCalls: message.tool_calls } : {}),
  });
}

function describeVisibleMessage(state: ContextState, index: number, source?: SecurityResearchContextSource, includeOutcome = true) {
  if (!allowed(state) || !Number.isSafeInteger(index) || index < 0) return null;
  const message = state.messages[index];
  if (!message) return null;
  const serialized = serializeResearchContextMessage(message);
  if (serialized === null) return null;
  const sha256 = digest(serialized);
  // Legacy assistant messages can lack IDs. Canonical research history is never
  // windowed or reordered; its append-stable index plus digest is the fallback.
  const identity = message.id ? { messageId: message.id } : { messageIndex: index };
  const binding = digest(JSON.stringify([state.userId, state.currentTaskId, state.currentTaskRunId, identity, sha256, source ?? null]));
  return { ref: `research-context:${index}:${binding}`, sha256, totalBytes: Buffer.byteLength(serialized, "utf8"),
    messageIndex: index, ...(message.id ? { messageId: message.id } : {}),
    kind: AIMessage.isInstance(message) ? "assistant" as const : "tool" as const,
    ...(message.name ? { toolName: message.name } : {}),
    ...(ToolMessage.isInstance(message) && includeOutcome ? { outcome: researchToolOutcome(message) } : {}),
    ...(source ? { source } : {}),
  };
}

/** Execution disposition is transport authority, never a guess from result text. */
function researchToolOutcome(message: ToolMessage): "success" | "error" | "unknown" {
  const legacy = message.additional_kwargs["nautilo_tool_status"];
  if (message.status === "error" || legacy === "error") return "error";
  if (message.status === "success" || legacy === "success") return "success";
  return "unknown";
}

/** Pair against canonical history, never a provider projection or source-text guess. */
function originalFileCall(state: ContextState, resultIndex: number, includeOutcome = true): SecurityResearchContextSource {
  const calls = new Map<string, { index: number; call: NonNullable<AIMessage["tool_calls"]>[number] } | null>();
  for (let index = 0; index <= resultIndex; index++) {
    const message = state.messages[index]!;
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) if (call.id) calls.set(call.id, calls.has(call.id) ? null : { index, call });
    } else if (ToolMessage.isInstance(message)) {
      const paired = calls.get(message.tool_call_id);
      calls.delete(message.tool_call_id);
      if (index !== resultIndex) continue;
      if (!paired || paired.call.name !== "file" || message.name !== "file") break;
      const callDescription = describeVisibleMessage(state, paired.index);
      if (!callDescription) break;
      const args = paired.call.args;
      const range = args["lineRange"] as Record<string, unknown> | undefined;
      const safeNumber = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
      return { tool: "file", identity: "paired", ...(includeOutcome ? { outcome: researchToolOutcome(message) } : {}), toolCallId: message.tool_call_id, callRef: callDescription.ref,
        ...(typeof args["command"] === "string" ? { command: args["command"] } : {}),
        ...(typeof args["path"] === "string" ? { path: args["path"] } : {}),
        ...(typeof args["zone"] === "string" ? { zone: args["zone"] } : {}),
        ...(safeNumber(args["offset"]) ? { offset: args["offset"] } : {}),
        ...(safeNumber(args["limit"]) ? { limit: args["limit"] } : {}),
        ...(range && safeNumber(range["from"]) && safeNumber(range["to"]) ? { lineRange: { from: range["from"], to: range["to"] } } : {}),
        ...(typeof args["readCursor"] === "string" ? { continuedRead: true } : {}),
      };
    }
  }
  const message = state.messages[resultIndex];
  return { tool: "file", identity: "unavailable", ...(includeOutcome && message && ToolMessage.isInstance(message) ? { outcome: researchToolOutcome(message) } : {}) };
}

/** Result identity binds the original paired call as well as exact visible bytes. */
export function describeResearchContextMessage(state: ContextState, index: number, includeOutcome = true) {
  if (!allowed(state) || !Number.isSafeInteger(index) || index < 0) return null;
  const message = state.messages[index];
  const source = message && ToolMessage.isInstance(message) && message.name === "file" ? originalFileCall(state, index, includeOutcome) : undefined;
  return describeVisibleMessage(state, index, source, includeOutcome);
}

/** Frozen index over existing canonical messages; later append-only turns do not change it. */
function serializeResearchContextIndex(state: ContextState, throughIndex: number, includeOutcome = true): string | null {
  if (!allowed(state) || !Number.isSafeInteger(throughIndex) || throughIndex < 0 || throughIndex >= state.messages.length) return null;
  const messages = [];
  for (let index = 0; index <= throughIndex; index++) {
    const descriptor = describeResearchContextMessage(state, index, includeOutcome);
    if (descriptor) messages.push(descriptor);
  }
  return JSON.stringify({ version: "research-context-index-v1", throughIndex, messages });
}

export function describeResearchContextIndex(state: ContextState, throughIndex: number, includeOutcome = true) {
  const serialized = serializeResearchContextIndex(state, throughIndex, includeOutcome);
  if (serialized === null) return null;
  const sha256 = digest(serialized);
  const binding = digest(JSON.stringify([state.userId, state.currentTaskId, state.currentTaskRunId, throughIndex, sha256]));
  return { ref: `research-index:${throughIndex}:${binding}`, sha256, totalBytes: Buffer.byteLength(serialized, "utf8"),
    messageIndex: throughIndex, kind: "index" as const };
}

/** Saved identities only: no note summaries, source excerpts or completion proof. */
function serializeResearchRecordIndex(state: ContextState, throughIndex: number, filters: { recordKinds?: string[] | undefined; contextSourcePath?: string | undefined } = {}): string | null {
  if (!allowed(state) || !Number.isSafeInteger(throughIndex) || throughIndex < 0 || throughIndex >= state.messages.length) return null;
  const records = deriveResearchSavedState(state, throughIndex).locatorRows
    .filter((row) => (!filters.recordKinds || filters.recordKinds.includes(row.kind))
      && (!filters.contextSourcePath || row.sourcePaths.includes(filters.contextSourcePath)))
    .map(({ receiptIndex, ...row }) => ({ ...row,
      exactHistoricalReceipt: { tool: "security_scan", version: "security-scan-v1", operation: "context", contextRef: describeResearchContextMessage(state, receiptIndex)!.ref },
      latestRecord: { tool: "security_scan", version: "security-scan-v1", operation: "results", category: "research", recordIds: [row.id], finalize: false },
    }));
  return JSON.stringify({ version: "research-record-index-v1", throughIndex,
    notice: "Saved record identities and declared or cited paths only. This index is not source evidence, inspection, coverage or report readiness. Reload the full record before relying on its analysis.", records });
}

export function describeResearchRecordIndex(state: ContextState, throughIndex: number) {
  const serialized = serializeResearchRecordIndex(state, throughIndex);
  if (serialized === null) return null;
  const sha256 = digest(serialized);
  const binding = digest(JSON.stringify([state.userId, state.currentTaskId, state.currentTaskRunId, throughIndex, sha256]));
  return { ref: `research-records:${throughIndex}:${binding}`, sha256, totalBytes: Buffer.byteLength(serialized, "utf8"), messageIndex: throughIndex, kind: "records" as const };
}

function cursorFor(ref: string, offset: number, filterBinding?: string): string {
  return `research-page:${offset}:${digest(JSON.stringify(filterBinding === undefined ? [ref, offset] : [ref, offset, filterBinding]))}`;
}
const failure = (code: string, message: string) => ({ ok: false as const, operation: "context" as const,
  error: { code, message, retryable: false } });

/** maxPageBytes bounds the WHOLE serialized receipt, including JSON escaping and framing. */
function readExplicitResearchContext(state: ContextState, args: unknown, options: { maxPageBytes: number; includeResolvedSelection?: boolean; runtimeRecovery?: SecurityResearchRuntimeRecovery }) {
  if (!allowed(state)) return failure("context_unavailable", "Historical context is available only within its authorized security research TaskRun.");
  const parsed = researchContextRequestSchema.safeParse(args);
  if (!parsed.success) return failure("invalid_request", "Use operation=context with contextRef and optional contextCursor/contextBytes. recordKinds/contextSourcePath apply only to the saved-record index.");
  const request = parsed.data;
  if (!request.contextRef || request.continueContext) return failure("invalid_request", "Select an exact reference or use deterministic context continuation.");
  const match = /^(research-context|research-index|research-records):(\d+):[a-f0-9]{64}$/.exec(request.contextRef);
  const index = match ? Number(match[2]) : -1;
  const isIndex = match?.[1] === "research-index";
  const isRecords = match?.[1] === "research-records";
  if (!isRecords && (request.recordKinds !== undefined || request.contextSourcePath !== undefined)) return failure("invalid_request", "Record filters apply only to a saved-record index reference.");
  let description = isRecords ? describeResearchRecordIndex(state, index) : isIndex ? describeResearchContextIndex(state, index) : describeResearchContextMessage(state, index);
  let includeOutcome = true;
  if (description?.ref !== request.contextRef && !isRecords) {
    const legacy = isIndex ? describeResearchContextIndex(state, index, false) : describeResearchContextMessage(state, index, false);
    if (legacy?.ref === request.contextRef) { description = legacy; includeOutcome = false; }
  }
  if (!description || description.ref !== request.contextRef) return failure("context_reference_stale", "This context reference does not identify unchanged canonical content in this TaskRun. Use the reference in the current context projection.");
  const filterBinding = isRecords ? JSON.stringify([request.recordKinds ? [...new Set(request.recordKinds)].sort() : null, request.contextSourcePath ?? null]) : undefined;
  const serialized = isRecords ? serializeResearchRecordIndex(state, index, request)! : isIndex ? serializeResearchContextIndex(state, index, includeOutcome)! : serializeResearchContextMessage(state.messages[index]!)!;
  const bytes = Buffer.from(serialized, "utf8");
  let source = "source" in description ? description.source : undefined;
  let startByte = 0;
  if (request.contextCursor !== undefined) {
    const cursor = /^research-page:(\d+):[a-f0-9]{64}$/.exec(request.contextCursor);
    const offset = cursor ? Number(cursor[1]) : -1;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length
      || cursorFor(description.ref, offset, filterBinding) !== request.contextCursor
      || (bytes[offset]! & 0xc0) === 0x80) return failure("context_cursor_stale", "This byte continuation is invalid for the exact historical message. Use its returned nextCursor.");
    startByte = offset;
  }
  const { version: _version, operation: _operation, continueContext: _continuation, ...resolvedSelection } = request;
  const envelope = (endByte: number) => ({ ok: true as const, operation: "context" as const, ...(options.runtimeRecovery ? { runtimeRecovery: options.runtimeRecovery } : {}), result: {
    version: "research-context-v1" as const, contextRef: description.ref, sha256: isRecords ? digest(serialized) : description.sha256,
    serialization: isRecords ? "saved-record-index-json-utf8" as const : isIndex ? "visible-message-index-json-utf8" as const : "visible-message-json-utf8" as const, startByte, endByte, totalBytes: bytes.length,
    text: bytes.subarray(startByte, endByte).toString("utf8"), complete: endByte === bytes.length,
    nextCursor: endByte < bytes.length ? cursorFor(description.ref, endByte, filterBinding) : null,
    ...(options.includeResolvedSelection === false ? {} : { resolvedSelection }),
    ...(source ? { source } : {}),
  } });
  if (!Number.isSafeInteger(options.maxPageBytes) || options.maxPageBytes < 1) return failure("context_budget_unavailable", "The runtime must reserve space for a recoverable historical context page before reading it.");
  const aligned = (end: number): number => {
    while (end > startByte && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    return end;
  };
  // Provenance is part of the same escaped receipt allowance. If a path or
  // another selected field alone cannot fit, omit that whole field explicitly;
  // the fixed-size bound call reference still retrieves its exact original bytes.
  if (source?.identity === "paired") {
    const fields = ["command", "path", "zone", "offset", "limit", "lineRange", "continuedRead", "toolCallId"] as const;
    const ordered = fields.filter((field) => source && field in source).sort((a, b) =>
      JSON.stringify(source![b as keyof typeof source]).length - JSON.stringify(source![a as keyof typeof source]).length);
    const firstEnd = (() => { let end = startByte + 1; while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end++; return end; })();
    for (const field of ordered) {
      const finalPageFits = bytes.length - startByte <= (request.contextBytes ?? options.maxPageBytes)
        && Buffer.byteLength(JSON.stringify(envelope(bytes.length)), "utf8") <= options.maxPageBytes;
      if (finalPageFits || Buffer.byteLength(JSON.stringify(envelope(firstEnd)), "utf8") <= options.maxPageBytes) break;
      const { [field]: _omitted, ...retained } = source;
      source = { ...retained, fieldsNotPresented: [...(source.fieldsNotPresented ?? []), field] };
    }
  }
  let low = startByte;
  let high = Math.min(bytes.length, startByte + (request.contextBytes ?? options.maxPageBytes));
  // The final page drops its cursor, so its framing is shorter than a nearby
  // partial page. Check the complete endpoint before the monotonic search.
  const requestedEnd = aligned(high);
  if (requestedEnd > startByte && Buffer.byteLength(JSON.stringify(envelope(requestedEnd)), "utf8") <= options.maxPageBytes) return envelope(requestedEnd);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(envelope(aligned(middle))), "utf8") <= options.maxPageBytes) low = middle;
    else high = middle - 1;
  }
  const endByte = aligned(low);
  if (endByte === startByte) return failure("context_budget_unavailable", "The requested page cannot fit its framing and one complete UTF-8 character. Reserve more context space or increase contextBytes; the canonical bytes remain available.");
  return envelope(endByte);
}


/** Exact replay uses the receipt's resolved selection, never later navigation state. */
export function replayResearchContextReceipt(state: ContextState, args: unknown, value: unknown) {
  const receipt = securityResearchContextReceiptSchema.safeParse(value);
  const request = researchContextRequestSchema.safeParse(args);
  if (!receipt.success || !receipt.data.ok || !request.success) return null;
  const selection = receipt.data.result.resolvedSelection;
  if (!selection) {
    if (request.data.continueContext || !request.data.contextRef) return null;
    const expected = readExplicitResearchContext(state, args, { maxPageBytes: Buffer.byteLength(JSON.stringify(value), "utf8"), includeResolvedSelection: false, ...(receipt.data.runtimeRecovery ? { runtimeRecovery: receipt.data.runtimeRecovery } : {}) });
    return expected.ok && JSON.stringify(expected) === JSON.stringify(value) ? expected : null;
  }
  if (selection.contextRef !== receipt.data.result.contextRef) return null;
  for (const field of ["contextRef", "contextCursor", "contextBytes", "recordKinds", "contextSourcePath"] as const) {
    const given = request.data[field];
    if (given !== undefined && JSON.stringify(given) !== JSON.stringify(selection[field])) return null;
  }
  if (!request.data.continueContext && ["contextRef", "contextCursor", "contextBytes", "recordKinds", "contextSourcePath"].some((field) =>
    JSON.stringify((request.data as Record<string, unknown>)[field]) !== JSON.stringify((selection as Record<string, unknown>)[field]))) return null;
  const expected = readExplicitResearchContext(state, { version: "security-scan-v1", operation: "context", ...selection }, { maxPageBytes: Buffer.byteLength(JSON.stringify(value), "utf8"), ...(receipt.data.runtimeRecovery ? { runtimeRecovery: receipt.data.runtimeRecovery } : {}) });
  return expected.ok && JSON.stringify(expected) === JSON.stringify(value) ? expected : null;
}

/** Continue a chosen stream; optional navigation never replaces substantive input. */
function resolveAndReadContext(state: ContextState, args: unknown, options: { maxPageBytes: number; runtimeRecovery?: SecurityResearchRuntimeRecovery }) {
  if (!allowed(state)) return failure("context_unavailable", "Historical context is available only within its authorized security research TaskRun.");
  const parsed = researchContextRequestSchema.safeParse(args);
  if (!parsed.success) return failure("invalid_request", "Use contextRef for explicit selection or continueContext=true for server-managed continuation.");
  const request = parsed.data;
  if (!request.continueContext) return readExplicitResearchContext(state, request, options);
  if (request.contextCursor !== undefined) return failure("invalid_request", "Choose explicit contextCursor or continueContext=true, not both.");
  let ref = request.contextRef;
  const recovery = state.researchContextRecovery;
  if (!ref && recovery && recovery.taskRunId === state.currentTaskRunId) ref = recovery.pendingRefs.find((item) => item.startsWith("research-context:"));
  const prior = pairedResearchReceipts(state.messages).filter((receipt) => receipt.args["operation"] === "context"
    && !recovery?.unpresentedReadIndices?.includes(receipt.index)).reverse();
  let previous: ReturnType<typeof replayResearchContextReceipt> = null;
  const substantiveContinuation = !request.contextRef && Boolean(ref);
  const presented: Array<NonNullable<ReturnType<typeof replayResearchContextReceipt>>> = [];
  for (const receipt of prior) {
    const value = receipt.value as { result?: { contextRef?: unknown } };
    const candidate = value.result?.contextRef;
    if (typeof candidate !== "string" || (ref ? candidate !== ref : !candidate.startsWith("research-context:"))) continue;
    const verified = replayResearchContextReceipt(state, receipt.args, receipt.value);
    if (verified) {
      ref ??= verified.result.contextRef;
      if (!substantiveContinuation) { previous = verified; break; }
      presented.push(verified);
    }
  }
  if (substantiveContinuation) {
    let end = 0;
    for (const page of presented.sort((a, b) => a.result.startByte - b.result.startByte)) {
      if (page.result.startByte > end) break;
      if (page.result.endByte > end) { end = page.result.endByte; previous = page; }
    }
  }
  if (!ref) return failure("context_selection_required", "Choose a historical reference first; there is no substantive stream to continue.");
  if (previous?.result.complete) return failure("context_complete", "The selected historical input is fully read. Choose another reference or save the useful recovery handoff.");
  const previousSelection = previous?.result.resolvedSelection;
  const selection: SecurityResearchContextSelection = { contextRef: ref,
    ...(previous?.result.nextCursor ? { contextCursor: previous.result.nextCursor } : {}),
    ...(request.contextBytes !== undefined ? { contextBytes: request.contextBytes } : {}),
    ...(request.recordKinds !== undefined ? { recordKinds: request.recordKinds } : previousSelection?.recordKinds ? { recordKinds: previousSelection.recordKinds } : {}),
    ...(request.contextSourcePath !== undefined ? { contextSourcePath: request.contextSourcePath } : previousSelection?.contextSourcePath ? { contextSourcePath: previousSelection.contextSourcePath } : {}),
  };
  if (previousSelection && ((request.recordKinds !== undefined && JSON.stringify(request.recordKinds) !== JSON.stringify(previousSelection.recordKinds))
    || (request.contextSourcePath !== undefined && request.contextSourcePath !== previousSelection.contextSourcePath))) return failure("context_cursor_stale", "Continuation keeps the same filters. Start the chosen reference explicitly to select different filters.");
  return readExplicitResearchContext(state, { version: "security-scan-v1", operation: "context", ...selection }, options);
}


export function readResearchContext(state: ContextState, args: unknown, options: { maxPageBytes: number; runtimeRecovery?: SecurityResearchRuntimeRecovery }) {
  const receipt = resolveAndReadContext(state, args, options);
  return !receipt.ok && options.runtimeRecovery ? { ...receipt, runtimeRecovery: options.runtimeRecovery } : receipt;
}
