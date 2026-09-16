import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { securityScanToolResultSchema } from "@nautilo/types";
import { securityReportReadiness } from "./report-readiness";

/** A receipt-backed completion check, not a new executor or Desktop grant. */
export function securityResearchContinuation(messages: readonly BaseMessage[]): string | null {
  if (securityReportReadiness(messages)) return null;
  const pairedCalls = new Set<string>();
  let failure = false;
  let detail = "Inspect status for this Task's bound scan. Only if scan_not_found, start the exact requested target; then map its sections and investigate using file and security_scan.";
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) if (call.name === "security_scan" && call.id) pairedCalls.add(call.id);
    }
    if (!ToolMessage.isInstance(message) || message.name !== "security_scan" || !pairedCalls.delete(message.tool_call_id)
      || typeof message.content !== "string") continue;
    let value: unknown;
    try { value = JSON.parse(message.content); } catch { continue; }
    const result = securityScanToolResultSchema.safeParse(value);
    if (!result.success) continue;
    if (!result.data.ok) {
      failure = ["desktop_upgrade_required", "root_not_authorized", "root_unavailable", "root_revoked", "root_path_escaped", "relay_unavailable", "model_unavailable", "model_failed", "cancelled"].includes(result.data.error.code);
      if (result.data.error.code === "research_incomplete") detail = result.data.error.continuation ?? result.data.error.message;
      continue;
    }
    failure = false;
    if ((result.data.operation === "start" || result.data.operation === "status") && result.data.result.mode === "scanners_only") return null;
    if (result.data.operation === "results") {
      detail = result.data.result.nextCursor !== null
        ? "Retrieve the remaining evidence pages with continueResults:true. If still researching, retain finalize:false."
        : "The evidence ledger is not finalized and ready. Use the remaining-work feedback to resolve concrete gaps while preserving completed work, then finalize and use the accepted export contract.";
    } else if (result.data.operation === "start" || result.data.operation === "status") {
      failure = result.data.result.state === "failed" || result.data.result.state === "cancelled";
      detail = "Continue the existing scan: inspect status/research results, work through every requested section, and finalize only after its evidence and coverage qualify.";
    }
  }
  if (failure) return null; // Let the runtime deliver the real failure, not a fabricated report.
  return "Security research has not satisfied the requested scope and report prerequisites. " + detail
    + " Continue inside this same authorized Task and scan; do not ask the Human to reschedule already requested sections or start replacement scans. Record concrete external blockers as limited coverage with corroborating evidence. A prose summary is not completion.";
}
