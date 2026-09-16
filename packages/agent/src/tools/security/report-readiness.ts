import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { securityScanToolResultSchema } from "@nautilo/types";

/** Only actual, paired tool receipts can qualify a model answer as a report. */
export function securityReportReadiness(messages: readonly BaseMessage[]): "completed" | "partial" | null {
  const calls = new Map<string, Record<string, unknown>>();
  let readiness: "completed" | "partial" | null = null;
  let finalizedScanId: string | null = null;
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) {
        if (call.name === "security_scan" && call.id) calls.set(call.id, call.args);
      }
      continue;
    }
    if (!ToolMessage.isInstance(message) || message.name !== "security_scan") continue;
    const call = calls.get(message.tool_call_id);
    if (!call || typeof message.content !== "string") continue;
    calls.delete(message.tool_call_id);
    // Server-local historical navigation cannot mutate the finalized scan.
    // It neither creates readiness nor invalidates an existing complete export,
    // including when a historical reference is stale and must be retried.
    if (call["operation"] === "context") continue;
    let value: unknown;
    try { value = JSON.parse(message.content); } catch { readiness = null; continue; }
    const parsed = securityScanToolResultSchema.safeParse(value);
    if (!parsed.success || !parsed.data.ok) { readiness = null; continue; }
    const receipt = parsed.data;
    const status = receipt.operation === "results" ? receipt.result.status
      : receipt.operation === "status" ? receipt.result : null;
    const fullExport = call["operation"] === "results" && call["category"] === "all"
      && call["finalize"] === true && call["probes"] === undefined
      && call["recordKinds"] === undefined && call["recordIds"] === undefined;
    // A fully retrieved immutable ledger remains qualified while the model
    // reloads an exact finding/note for synthesis. Read-only navigation must not
    // force another complete inventory transfer. Errors/mutations/new scans and
    // terminal-state drift still invalidate the proof.
    if (!fullExport && readiness !== null && status?.scanId === finalizedScanId && status.state === readiness
      && status.modelState === "completed" && status.researchProgress?.inventoryState === "complete"
      && status.researchProgress.unitsPending === 0 && !status.researchProgress.nextResearchWork) continue;
    readiness = null;
    if (receipt.operation !== "results") continue;
    const page = receipt.result;
    // This proof comes from the durable Desktop ledger, so context compaction
    // may discard startup and earlier pages without losing completion truth.
    readiness = call["category"] === "all"
      && call["finalize"] === true
      && call["probes"] === undefined && call["recordKinds"] === undefined && call["recordIds"] === undefined
      && (page.exportSnapshot !== undefined || page.nextCursor === null && page.reportReady === true)
      && page.status.coverage.length > 0
      && page.status.researchProgress?.inventoryState === "complete"
      && !page.status.researchProgress.nextResearchWork
      && page.status.researchProgress.unitsPending === 0
      && page.status.modelState === "completed"
      && (page.status.state === "completed" || page.status.state === "partial")
      ? page.status.state : null;
    finalizedScanId = readiness ? page.status.scanId : null;
  }
  return readiness;
}
