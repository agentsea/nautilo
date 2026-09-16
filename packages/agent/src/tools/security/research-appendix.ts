import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { securityScanToolResultSchema, type SecurityScanResultEnvelope } from "@nautilo/types";
import { securityReportReadiness } from "./report-readiness";

/** Fence accepted metadata without allowing its text to terminate the JSON block. */
function appendJsonSection(lines: string[], label: string, value: unknown): void {
  const content = JSON.stringify(value, null, 2);
  let longest = 2;
  for (const run of content.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(longest + 1);
  lines.push(`### ${label}`, "", `${fence}json`, content, fence, "");
}

/** Export accepted ledger pages, never the model's recollection of its notes. */
export function securityResearchAppendix(messages: readonly BaseMessage[]): string | null {
  if (!securityReportReadiness(messages)) return null;
  const calls = new Map<string, Record<string, unknown>>();
  let pages: SecurityScanResultEnvelope[] = [];
  let scanId: string | null = null;
  let exhausted = false;
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) {
        if (call.name === "security_scan" && call.id) calls.set(call.id, call.args);
      }
      continue;
    }
    if (!ToolMessage.isInstance(message) || message.name !== "security_scan") continue;
    const call = calls.get(message.tool_call_id);
    calls.delete(message.tool_call_id);
    if (!call || typeof message.content !== "string") continue;
    if (call["operation"] !== "results" || call["category"] !== "all" || call["finalize"] !== true
      || call["probes"] !== undefined || call["recordKinds"] !== undefined || call["recordIds"] !== undefined) continue;
    let value: unknown;
    try { value = JSON.parse(message.content); } catch { pages = []; exhausted = false; continue; }
    const parsed = securityScanToolResultSchema.safeParse(value);
    if (!parsed.success || !parsed.data.ok || parsed.data.operation !== "results") {
      pages = []; exhausted = false; continue;
    }
    const page = parsed.data.result;
    const continuing = call["continueResults"] === true || typeof call["cursor"] === "string" || call["recordId"] !== undefined;
    if (!continuing) {
      pages = [];
      scanId = page.status.scanId;
      exhausted = false;
    } else if (pages.length === 0 || exhausted || scanId !== page.status.scanId) {
      pages = []; exhausted = false; continue;
    }
    pages.push(page);
    exhausted = page.nextCursor === null && page.reportReady === true;
  }
  if (!exhausted || pages.length === 0) return null;
  return securityResearchAppendixFromPages(pages, messages);
}

/** Format an already verified complete export without routing its bytes through model context. */
export function securityResearchAppendixFromPages(
  pages: readonly SecurityScanResultEnvelope[],
  messages: readonly BaseMessage[] = [],
): string {
  if (pages.length === 0 || pages.at(-1)?.nextCursor !== null
    || pages.at(-1)?.reportReady !== true && !pages.at(-1)?.exportSnapshot) {
    throw new Error("SECURITY_RESEARCH_EXPORT_INCOMPLETE");
  }
  const records = new Map(pages.flatMap((page) => page.records).map((record) => [record.id, record]));
  const evidence = new Map(pages.flatMap((page) => page.codeEvidence).map((item) => [item.id, item]));
  const observations = new Map(pages.flatMap((page) => page.observations).map((item) => [item.id, item]));
  const inventory = new Map(pages.flatMap((page) => page.inventory ?? []).map((item) => [item.id, item]));
  const discoveryNotes = new Map<string, string>();
  const fileCalls = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) if (call.name === "file" && call.id) fileCalls.set(call.id, call.args);
      continue;
    }
    if (!ToolMessage.isInstance(message) || message.name !== "file" || typeof message.content !== "string") continue;
    const args = fileCalls.get(message.tool_call_id);
    fileCalls.delete(message.tool_call_id);
    if (!args) continue;
    let receipt: Record<string, unknown>;
    try { receipt = JSON.parse(message.content) as Record<string, unknown>; } catch { continue; }
    if (!receipt || receipt["ok"] === false || receipt["error"]) continue;
    const reasons = receipt["incompleteReasons"];
    const exclusions = receipt["scopeExclusions"];
    if (!(Array.isArray(reasons) && reasons.length > 0) && !(Array.isArray(exclusions) && exclusions.length > 0)
      && !(receipt["complete"] === false && receipt["nextCursor"] === null)) continue;
    const note = JSON.stringify({ command: receipt["command"], path: args["path"],
      complete: receipt["complete"], incompleteReasons: reasons, scopeExclusions: exclusions,
      exclusionsRecovery: receipt["exclusionsRecovery"] });
    discoveryNotes.set(note, note);
  }
  const lines = [
    "## Durable review log", "",
    "The following accepted ledger records are preserved independently of the final model narrative. Structural completion does not certify the reasoning or establish that every line was read.", "",
    `Recorded: ${records.size} research records, ${evidence.size} source citations, ${observations.size} scanner observations, ${inventory.size} inventory entries.`, "",
  ];
  lines.push("The final accepted ledger status separates source-review coverage from scanner coverage. A scanner lane marked completed can still have limited coverage; zero observations do not establish that its scope was fully scanned.", "");
  appendJsonSection(lines, "Final ledger status and scanner coverage", pages.at(-1)!.status);
  if (pages[0]!.exportSnapshot) appendJsonSection(lines, "Sealed export identity", pages[0]!.exportSnapshot);
  if (discoveryNotes.size > 0) {
    lines.push("### Discovery scope notes", "", "These are observed query constraints, not automatic repository-wide exclusions. Later source review may resolve them; consult the unit notes and inventory for the final scope decision.", "");
    for (const note of discoveryNotes.values()) lines.push(`- ${note}`);
    lines.push("");
  }
  // JSON is fenced with a dynamically longer fence so untrusted metadata cannot
  // terminate it. Scanner observations are already sanitized by the authority.
  for (const [label, items] of [
    ["Accepted research record index", [...records.values()]],
    ["Source citation index", [...evidence.values()]],
    ["Scanner observation index", [...observations.values()]],
    ["Target inventory and exclusions", [...inventory.values()]],
  ] as const) {
    appendJsonSection(lines, label, items);
  }
  return lines.join("\n");
}
