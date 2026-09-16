import { ResearchProgress, researchReviewLabel } from "../research-progress";
import { CodePreview } from "../../../editors/code-editor";
import { projectSecurityScanCardResult, type SecurityScanCardProjection } from "@nautilo/types";
import { projectToolResultTextForDisplay } from "../../tool-argument-preview";
import type { ToolRenderer, ToolRendererProps } from "./types";

function parseSecurityResult(raw: string | undefined): SecurityScanCardProjection | null {
  if (!raw) return null;
  // Direct renderer callers cross the same disclosure boundary as live and
  // historical ToolCards. No raw transport/capability envelope reaches the DOM.
  try { return projectSecurityScanCardResult(JSON.parse(projectToolResultTextForDisplay(raw) ?? "")); }
  catch { return null; }
}
function plainErrorText(raw: string | undefined, state: ToolRendererProps["state"]): string | null {
  if (state !== "error" || !raw?.trim()) return null;
  if (raw.trimStart().startsWith("{") || raw.trimStart().startsWith("[")) return null;
  try { JSON.parse(raw); return null; } catch { /* Only plain errors use this fallback. */ }
  return projectToolResultTextForDisplay(raw)?.trim() || null;
}
function contextTitle(context: NonNullable<SecurityScanCardProjection["context"]>): string {
  if (context.serialization === "saved-record-index-json-utf8") return "Saved research index · lookup only";
  if (context.serialization === "visible-message-index-json-utf8") return "Historical message index · lookup only";
  if (context.source?.outcome === "error") return "Historical file attempt · error";
  if (context.source && context.source.outcome !== "success") return "Historical file attempt · outcome unknown";
  return "Recovering historical context";
}
function summary(args: Record<string, unknown>, receipt: SecurityScanCardProjection | null): string {
  if (receipt?.error) return receipt.error.message;
  if (receipt?.context) return `${contextTitle(receipt.context)} · bytes ${receipt.context.startByte}–${receipt.context.endByte} of ${receipt.context.totalBytes}`;
  if (receipt?.record) {
    const entry = receipt.record.entry;
    if (entry.kind === "review_unit") return `${entry.summary} · ${entry.state?.replaceAll("_", " ")}`;
    if (entry.kind === "coverage") return `${entry.surfaceKey} · ${entry.state?.replaceAll("_", " ")}`;
    if (entry.kind === "checkpoint") return `Model checkpoint: ${entry.summary}`;
    return entry.summary ?? entry.question ?? "Research note accepted";
  }
  if (receipt?.status) {
    const status = receipt.status;
    const progress = status.researchProgress;
    if (progress) return `${status.state === "active" ? "Research in progress" : status.state} · ${researchReviewLabel(progress)} · ${progress.filesUnassigned} files not individually assigned`;
    const reviewed = status.coverage.filter((section) => section.state === "reviewed" || section.state === "not_applicable").length;
    return `${status.state === "active" ? "Research in progress" : status.state} · ${reviewed}/${status.coverage.length} listed sections reviewed`;
  }
  return args.operation === "start" ? "Preparing security research" : `Security research · ${typeof args.operation === "string" ? args.operation : "working"}`;
}
const noteFields = {
  title: "Title", trace: "Trace", notes: "Notes", impact: "Impact", exploitPreconditions: "Exploit preconditions",
  confidence: "Confidence", rationale: "Rationale", blocker: "Blocker", nextWork: "Next work", resolution: "Resolution",
} as const;
function SecurityScanBody({ args, resultText, resultTruncated, state }: ToolRendererProps) {
  const receipt = parseSecurityResult(resultText);
  const plainError = receipt ? null : plainErrorText(resultText, state);
  const status = receipt?.status;
  const progress = status?.researchProgress ?? receipt?.researchProgress;
  const record = receipt?.record;
  const linkedDetails = record ? [
    [record.evidenceCount, "evidence link"], [record.counterevidenceCount, "counterevidence link"],
    [record.pathCount, "file"], [record.surfaceCount, "mapped section"], [record.codeEvidenceCount, "source receipt"],
  ].filter(([count]) => Number(count) > 0).map(([count, label]) => `${count} ${label}${count === 1 ? "" : "s"}`).join(" · ") : "";
  return <div className="space-y-3 border-t border-border px-3 py-2 text-xs">
    <p className={receipt?.error || plainError ? "text-tool-error" : "text-foreground"}>{plainError ?? summary(args, receipt)}</p>
    {receipt?.error && "continuation" in receipt.error && receipt.error.continuation && <p className="text-foreground">{receipt.error.continuation}</p>}
    {receipt?.context && <section aria-label="Historical context page" className="space-y-2">
      {receipt.context.source && <p className="text-foreground-muted">{receipt.context.source.identity === "unavailable"
        ? "Original file request identity is unavailable; do not infer a source path from this page."
        : <>Original {receipt.context.source.outcome === "success" ? "request" : "attempt"}: file.{receipt.context.source.command ?? "(command not shown)"} · {receipt.context.source.path ?? "path not shown"}
          {receipt.context.source.zone ? ` · zone ${receipt.context.source.zone}` : " · zone not provided"}
          {receipt.context.source.lineRange ? ` · lines ${receipt.context.source.lineRange.from}–${receipt.context.source.lineRange.to}` : ""}
          {receipt.context.source.offset !== undefined ? ` · offset ${receipt.context.source.offset}` : ""}
          {receipt.context.source.limit !== undefined ? ` · limit ${receipt.context.source.limit}` : ""}
          {receipt.context.source.continuedRead ? " · continued read" : ""}
          {receipt.context.source.fieldsNotPresented?.length ? ". Some request fields are not shown; recover the original request before relying on them." : ""}</>}</p>}
      {receipt.context.source?.outcome === "error" && <p className="text-tool-error">The original file operation returned an error. This entry does not establish a successful read.</p>}
      {receipt.context.source && receipt.context.source.outcome !== "success" && receipt.context.source.outcome !== "error" && <p className="text-tool-warning">The original file operation outcome is unavailable. Do not infer that the file was successfully read.</p>}
      <p className="text-foreground-muted">{receipt.context.serialization !== "visible-message-json-utf8"
        ? "Optional lookup metadata for finding saved messages or research notes. Reading this index does not count as source inspection."
        : "Saved message content; it does not prove source review or audit completion."} {receipt.context.complete ? "This page reaches the end of the saved input." : "More bytes remain in this saved input."}</p>
      {receipt.context.displayNotice && <p className="text-foreground-muted">{receipt.context.displayNotice}</p>}
      <CodePreview value={receipt.context.text} path="historical-context.json" />
    </section>}
    {receipt?.runtimeRecovery && <section aria-label="Runtime recovery" className="space-y-1">
      <p><span className="font-medium">Runtime recovery:</span> {receipt.runtimeRecovery.phase === "reading"
        ? `${receipt.runtimeRecovery.pendingInputCount} saved inputs await recovery`
        : receipt.runtimeRecovery.phase === "consolidation_required"
          ? "Recovered context awaits saved notes and a checkpoint"
          : "No context recovery is pending"}</p>
      {(receipt.runtimeRecovery.recoveredInputBytes > 0 || receipt.runtimeRecovery.retainedUnconsolidatedPages > 0) && <p className="text-foreground-muted">{receipt.runtimeRecovery.recoveredInputBytes} historical input bytes recovered · {receipt.runtimeRecovery.retainedUnconsolidatedPages} recovered pages await consolidation. Lookup indexes do not count as source inspection.</p>}
    </section>}
    {record && <div aria-label="Accepted research notes" className="space-y-2">
      {Object.entries(noteFields).map(([key, label]) => {
        const value = record.entry[key as keyof typeof noteFields];
        return value ? <p key={key}><span className="font-medium">{label}:</span> {value}</p> : null;
      })}
      {record.openRecordCount > 0 && <p className="text-tool-warning">{record.openRecordCount} follow-ups remain open.</p>}
      {linkedDetails && <p className="text-foreground-muted">{linkedDetails}. Full references and indexes are in the saved research and final report.</p>}
      <details className="text-foreground-muted"><summary className="cursor-pointer">Record details</summary>{record.id} · revision {record.revision}</details>
    </div>}
    {status && <p className="text-foreground-muted">Model: {status.modelId ?? "not selected"} · {status.modelState.replaceAll("_", " ")}</p>}
    {progress && <div aria-label="Research work progress" className="space-y-1">
      <ResearchProgress progress={progress} />
      <p className="text-foreground-muted">{progress.unitsPending} review units pending</p>
      <p className="text-foreground-muted">{progress.filesAssigned} of {progress.filesTotal} inventoried files assigned · {progress.excludedEntriesTotal} excluded entries · {progress.unavailableEntriesTotal ?? 0} unavailable entries. Assignment does not mean reviewed.</p>
      {progress.inventoryState === "legacy" && <p className="text-tool-warning">This scan predates accountable source inventory. Its reviewed labels do not establish complete coverage.</p>}
      {progress.latestCheckpoint && <>
        <p><span className="font-medium">Model checkpoint:</span> {progress.latestCheckpoint.summary}</p>
        <p><span className="font-medium">Model’s planned next work:</span> {progress.latestCheckpoint.nextWork}</p>
        {progress.latestCheckpoint.openRecordCount > 0 && <p>{progress.latestCheckpoint.openRecordCount} checkpoint follow-ups; their IDs remain in the research ledger.</p>}
      </>}
      {progress.nextResearchWork && <p><span className="font-medium">Remaining work:</span> {progress.nextResearchWork}</p>}
      {(progress.coverageOmitted > 0 || progress.hypothesesOmitted > 0) && <p className="text-foreground-muted">This card omits {progress.coverageOmitted} section summaries and {progress.hypothesesOmitted} hypotheses. Full records remain available in the paged research ledger and final review log.</p>}
    </div>}
    {status && status.coverage.length > 0 && <ul aria-label="Research section coverage" className="space-y-2">
      {status.coverage.map((section) => <li key={section.surfaceKey}>
        <span className="font-medium">{section.label}</span> · {section.state.replaceAll("_", " ")}
        <p className="text-foreground-muted">{section.rationale}</p>
      </li>)}
    </ul>}
    {receipt?.page && <p className="text-foreground-muted">This results page contains {receipt.page.records} research records, {receipt.page.observations} scanner observations, {receipt.page.codeEvidence} source receipts and {receipt.page.inventory} inventory entries. Their contents are omitted from this card; consult the saved research or final report. {receipt.page.moreResults ? "More results remain; continue the same results query." : "This query has no further page; that alone does not prove the full audit is complete."}</p>}
    {receipt && <p className="text-foreground-muted">The final report includes the recorded scope and limitations.</p>}
    {!resultText && state === "running" && <p className="text-foreground-muted">Waiting for the tool receipt. Live scanner stages appear in Task activity.</p>}
    {resultTruncated && <p className="text-tool-warning">The transport returned only part of this receipt.</p>}
    {resultText && !receipt && !plainError && <p className="text-tool-warning">This receipt could not be displayed as a validated research record. Consult the Task transcript and research ledger for the full result.</p>}
  </div>;
}
export const securityScanRenderer: ToolRenderer = {
  displayName: "Security research",
  collapsedSummary: ({ args, resultText, state }) => plainErrorText(resultText, state) ?? summary(args, parseSecurityResult(resultText)),
  ExpandedBody: SecurityScanBody,
};
