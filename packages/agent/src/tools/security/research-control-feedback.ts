import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { isDeepStrictEqual } from "node:util";
import { localToolControlReceiptSchema, localToolRequestedOperation, researchHandoffErrorSchema, researchHandoffReceiptSchema, securityResearchContextReceiptSchema,
  securityScanToolResultSchema, type LocalToolControlReceipt, type SecurityResearchRuntimeRecovery } from "@nautilo/types";

export function localToolControlFailure(toolName: string, args: Record<string, unknown>, code: LocalToolControlReceipt["error"]["code"],
  message: string, runtimeRecovery?: SecurityResearchRuntimeRecovery): string {
  return JSON.stringify(localToolControlReceiptSchema.parse({ ok: false, operation: "local_tool_control", toolName,
    requestedOperation: localToolRequestedOperation(toolName, args), notDispatched: true,
    error: { code, message, retryable: false }, ...(runtimeRecovery ? { runtimeRecovery } : {}) }));
}

/** Unique, matching canonical tool pairs only. Failed calls can still contain unsaved drafts. */
export function pairedResearchToolReceipts(messages: readonly BaseMessage[]) {
  const callCounts = new Map<string, number>();
  const receiptCounts = new Map<string, number>();
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) if (call.id) callCounts.set(call.id, (callCounts.get(call.id) ?? 0) + 1);
    } else if (ToolMessage.isInstance(message)) receiptCounts.set(message.tool_call_id, (receiptCounts.get(message.tool_call_id) ?? 0) + 1);
  }
  const calls = new Map<string, { callIndex: number; name: string; args: Record<string, unknown> } | null>();
  const receipts: Array<{ index: number; callIndex: number; name: string; args: Record<string, unknown>; error: boolean; text: string; value: unknown }> = [];
  messages.forEach((message, index) => {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) if (call.id) calls.set(call.id, calls.has(call.id) ? null : { callIndex: index, name: call.name, args: call.args });
    } else if (ToolMessage.isInstance(message)) {
      const call = calls.get(message.tool_call_id); calls.delete(message.tool_call_id);
      if (!call || message.name !== call.name || callCounts.get(message.tool_call_id) !== 1 || receiptCounts.get(message.tool_call_id) !== 1) return;
      const text = typeof message.content === "string" ? message.content : "";
      let value: unknown = null; try { value = JSON.parse(text); } catch { /* Exact legacy formats checked separately. */ }
      receipts.push({ ...call, index, text, value, error: message.status === "error" || message.additional_kwargs["nautilo_tool_status"] === "error" });
    }
  });
  return receipts;
}
type Receipt = ReturnType<typeof pairedResearchToolReceipts>[number];

export function hasRejectedResearchDraft(receipt: Receipt): boolean {
  // Malformed operation/version placement does not make authored entry bytes
  // disposable. This identifies retained input, never a request to execute.
  return receipt.name === "security_scan" && (receipt.args["operation"] === "record" || receipt.args["entry"] !== undefined || receipt.args["reportDraft"] !== undefined);
}

function hasVisibleProse(message: BaseMessage | undefined): boolean {
  if (!message) return false;
  return typeof message.content === "string" ? message.content.length > 0 : message.content.some((block) =>
    block.type === "text" && typeof block["text"] === "string" && block["text"].length > 0);
}

function isKnownLocalControlError(receipt: Receipt): boolean {
  if (!receipt.error) return false;
  const parsed = localToolControlReceiptSchema.safeParse(receipt.value);
  const operation = localToolRequestedOperation(receipt.name, receipt.args);
  if (parsed.success) return parsed.data.toolName === receipt.name && parsed.data.requestedOperation === operation;
  if (receipt.name === "security_scan" && operation === "handoff") return researchHandoffErrorSchema.safeParse(receipt.value).success;
  if (receipt.name === "security_scan" && operation === "context") {
    const context = securityResearchContextReceiptSchema.safeParse(receipt.value);
    if (context.success && !context.data.ok && ["context_recovery_pending", "context_budget_unavailable", "context_complete",
      "context_cursor_stale", "context_reference_stale", "context_selection_required", "context_unavailable"].includes(context.data.error.code)) return true;
  }
  // Compatibility with the exact server producers used before typed receipts.
  // Require the full fixed diagnostic, canonical error marker and tool pairing;
  // an unknown failure or source containing a familiar prefix stays required.
  if (receipt.name === "file" && /^Recovered \d+ verified historical bytes\. Context recovery is active\. Recover pending historical pages, save material notes and a checkpoint through security_scan, then continue this same audit\. New investigation and finalization have not executed\.$/.test(receipt.text)) return true;
  if (receipt.name !== "security_scan" || !["status", "results", "record", "cancel"].includes(operation)) return false;
  const prefix = "Error: security_scan received invalid arguments";
  const correction = `. Correct the listed fields and retry the ${operation} operation once. Do not send scanId; the server binds this TaskRun to its scan. Do not start, finalize, or reopen a scan because this validation failure was not dispatched.`;
  const citation = " Add top-level fileCitations:[{relativePath:<exact inspected path relative to Current Folder>,startLine:<first inspected line>,endLine:<last inspected line>}]. Mentioning paths in entry.summary is not a citation. Retry one corrected record alone and inspect its receipt.";
  const text = receipt.text.endsWith(citation) ? receipt.text.slice(0, -citation.length) : receipt.text;
  if (!text.startsWith(prefix) || !text.endsWith(correction)) return false;
  const detail = text.slice(prefix.length, -correction.length);
  return detail === "" || (detail.startsWith(" (") && detail.endsWith(")"));
}

export function researchControlErrors(messages: readonly BaseMessage[]) {
  return pairedResearchToolReceipts(messages).filter(isKnownLocalControlError);
}

function isContextPressureError(receipt: Receipt): boolean {
  if (!receipt.error || receipt.name !== "security_scan" || receipt.args["operation"] !== "context") return false;
  const parsed = localToolControlReceiptSchema.safeParse(receipt.value);
  return parsed.success && parsed.data.toolName === "security_scan" && parsed.data.requestedOperation === "context"
    && parsed.data.error.code === "context_recovery_pending" && parsed.data.runtimeRecovery?.phase === "consolidation_required";
}

/** Call only after current recovery authority confirms reading/inactive. */
export function resolvedResearchContextPressureErrors(messages: readonly BaseMessage[], owner: { taskId: string; taskRunId: string }): Map<number, number> {
  const waiting: Receipt[] = [];
  const resolved = new Map<number, number>();
  for (const receipt of pairedResearchToolReceipts(messages)) {
    if (isContextPressureError(receipt)) { waiting.push(receipt); continue; }
    if (receipt.error || receipt.name !== "security_scan" || receipt.args["operation"] !== "record") continue;
    const accepted = securityScanToolResultSchema.safeParse(receipt.value);
    if (!accepted.success || !accepted.data.ok || accepted.data.operation !== "record"
      || accepted.data.result.record.entry.kind !== "checkpoint"
      || accepted.data.result.record.updatedBy.taskId !== owner.taskId
      || accepted.data.result.record.updatedBy.taskRunId !== owner.taskRunId) continue;
    for (const failed of waiting) if (receipt.callIndex > failed.index && !resolved.has(failed.index)) resolved.set(failed.index, receipt.index);
  }
  return resolved;
}

/** Keep each rejected draft until accepted exactly or explicitly consolidated
 * after verified recovery. A later accepted checkpoint supersedes typed pressure
 * only when the caller has revalidated that this run no longer needs consolidation.
 * Other operations retain their latest correction. */
export function outstandingResearchToolErrors(messages: readonly BaseMessage[], consolidatedDraftCalls: ReadonlySet<number> = new Set(),
  resolvedContextPressure: ReadonlyMap<number, number> = new Map()) {
  const outstanding = new Map<string, Receipt[]>();
  for (const receipt of pairedResearchToolReceipts(messages)) {
    const key = `${receipt.name}:${localToolRequestedOperation(receipt.name, receipt.args)}`;
    if (!receipt.error) {
      const prior = outstanding.get(key);
      if (receipt.name === "security_scan" && receipt.args["operation"] === "record" && prior?.length) {
        const accepted = securityScanToolResultSchema.safeParse(receipt.value);
        if (!accepted.success || !accepted.data.ok || accepted.data.operation !== "record") continue;
        const remaining = prior.filter((failed) => failed.args["reportDraft"] !== undefined || hasVisibleProse(messages[failed.callIndex]) || !isDeepStrictEqual(failed.args["entry"], receipt.args["entry"]));
        if (remaining.length) { outstanding.set(key, remaining); continue; }
        outstanding.delete(key); continue;
      }
      if (receipt.name === "security_scan" && receipt.args["operation"] === "handoff" && prior?.some(hasRejectedResearchDraft)) {
        if (!researchHandoffReceiptSchema.safeParse(receipt.value).success) continue;
        const remaining = prior.filter((failed) => hasRejectedResearchDraft(failed)
          && (failed.args["entry"] !== undefined || hasVisibleProse(messages[failed.callIndex]) || !isDeepStrictEqual(failed.args["reportDraft"], receipt.args["reportDraft"])));
        if (remaining.length) { outstanding.set(key, remaining); continue; }
        outstanding.delete(key); continue;
      }
      const drafts = prior?.filter(hasRejectedResearchDraft);
      if (drafts?.length) { outstanding.set(key, drafts); continue; }
      outstanding.delete(key); continue;
    }
    if (resolvedContextPressure.has(receipt.index) && !hasRejectedResearchDraft(receipt)) continue;
    const draft = hasRejectedResearchDraft(receipt);
    if (draft && consolidatedDraftCalls.has(receipt.callIndex)) continue;
    const prior = outstanding.get(key);
    outstanding.set(key, prior && (draft || prior.some(hasRejectedResearchDraft) || prior[0]?.callIndex === receipt.callIndex) ? [...prior, receipt] : [receipt]);
  }
  return [...outstanding.values()].flat();
}
