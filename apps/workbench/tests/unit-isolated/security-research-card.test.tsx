import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { SECURITY_SCAN_INITIAL_LANES } from "@nautilo/types";
import { securityScanRenderer } from "../../src/components/tool-card/renderers/security-scan";

test("research cards distinguish complete work, assignment and omitted summaries", () => {
  reapplyHappyDomGlobals();
  const result = { ok: true, operation: "status", result: {
    version: "security-scan-v1", scanId: "scan_card", state: "active", phase: "researching",
    terminalState: null, mode: "deep_research", modelId: "openai:test", modelState: "running",
    completedSteps: 1, totalSteps: 2, lanes: SECURITY_SCAN_INITIAL_LANES, coverage: [], hypotheses: [],
    researchProgress: { inventoryState: "complete", inventoryFingerprint: "a".repeat(64),
      filesTotal: 100, filesAssigned: 90, filesUnassigned: 10, unitsTotal: 15, unitsCompleted: 4, unitsPending: 11,
      excludedEntriesTotal: 3, unavailableEntriesTotal: 2, coverageTotal: 12, hypothesesTotal: 40,
      coverageOmitted: 12, hypothesesOmitted: 40,
      latestCheckpoint: { id: "record_checkpoint", summary: "Traced queue admission", nextWork: "Check worker authority after revocation", openRecordIds: ["record_worker"] },
    },
  } };
  const Body = securityScanRenderer.ExpandedBody;
  const view = render(<Body args={{ operation: "status" }} result={result} resultText={JSON.stringify(result)} state="success" event={undefined} resultTruncated={false} />);
  expect(view.container.textContent).toContain("27% of review plan · 4/15 review units complete");
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("27");
  expect(securityScanRenderer.collapsedSummary?.({ args: { operation: "status" }, result, resultText: JSON.stringify(result), state: "success" })).toContain("27% of review plan");
  expect(view.container.textContent).toContain("90 of 100 inventoried files assigned");
  expect(view.container.textContent).toContain("Assignment does not mean reviewed");
  expect(view.container.textContent).toContain("2 unavailable entries");
  expect(view.container.textContent).toContain("Check worker authority after revocation");
  expect(view.container.textContent).toContain("omits 12 section summaries and 40 hypotheses");
  view.unmount();
});

import {
  projectTaskTranscriptToolResult,
  securityScanCardProjectionSchema,
  securityScanToolResultSchema,
} from "@nautilo/types";
import { projectToolResultTextForDisplay } from "../../src/components/tool-argument-preview";

// The live failure had valid Desktop-authored receipts with links at
// result.record.entry.evidenceRefs[0]. Generic depth projection replaced each
// link with "[omitted]", and the card then rejected the entire receipt.
function linkedRecordReceipt(kind: "finding" | "review_unit" = "finding", references = 7) {
  const evidenceRefs = Array.from({ length: references }, (_, index) => ({ kind: "ledger_record", id: `record_evidence_${index}` }));
  const entry = kind === "finding" ? {
    kind, title: "Permission remains in a retained decision", summary: "A later request reuses authority recorded before revocation.",
    confidence: "high", impact: "A revoked member retains access.", exploitPreconditions: "The member first obtained an allowed decision.",
    evidenceRefs, counterevidenceRefs: [{ kind: "ledger_record", id: "record_control" }],
  } : {
    kind, summary: "Trace retained decisions across membership changes", surfaceKey: "membership",
    state: "reviewed", paths: ["membership/access.js", "membership/state.js"],
    trace: "Request admission reads membership and passes the decision into retained state.",
    notes: "Checked the consuming call site after revocation and the control that repeats authorization.",
    evidenceRefs, counterevidenceRefs: [{ kind: "ledger_record", id: "record_control" }], openRecordIds: [],
  };
  const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openai:gpt-5.6-sol" };
  return { ok: true, operation: "record", result: { record: {
    id: "record_retained_decision", revision: 2, createdAt: "2026-09-07T12:00:00.000Z", updatedAt: "2026-09-07T12:01:00.000Z",
    createdBy: author, updatedBy: author, entry,
  }, codeEvidence: [] } };
}

test("linked accepted finding and review notes survive the actual transcript and ToolCard display boundaries", () => {
  reapplyHappyDomGlobals();
  for (const kind of ["finding", "review_unit"] as const) {
    const receipt = linkedRecordReceipt(kind);
    const raw = JSON.stringify(receipt);
    expect(securityScanToolResultSchema.safeParse(receipt).success).toBe(true);
    const historyResult = projectTaskTranscriptToolResult(raw)!;
    const cardResult = projectToolResultTextForDisplay(historyResult)!;
    expect(cardResult).toBe(historyResult);
    const projection = securityScanCardProjectionSchema.parse(JSON.parse(cardResult));
    expect(projection.record?.evidenceCount).toBe(7);
    expect(projection.record?.counterevidenceCount).toBe(1);
    expect(cardResult).not.toContain("record_evidence_0");
    const Body = securityScanRenderer.ExpandedBody;
    const view = render(<Body args={{ operation: "record" }} result={undefined} resultText={cardResult} state="success" event={undefined} resultTruncated={false} />);
    const text = view.container.textContent ?? "";
    expect(text).toContain(receipt.result.record.entry.summary);
    if ("trace" in receipt.result.record.entry) {
      expect(text).toContain(receipt.result.record.entry.trace);
      expect(text).toContain(receipt.result.record.entry.notes);
    } else expect(text).toContain(receipt.result.record.entry.impact);
    expect(text).toContain("7 evidence links · 1 counterevidence link");
    expect(text).toContain("saved research and final report");
    expect(text).not.toContain("Security research · record");
    expect(JSON.stringify(receipt)).toBe(raw);
    view.unmount();
  }
});

test("accumulated reference cardinality cannot remove accepted text or expand the card reference payload", () => {
  const receipt = linkedRecordReceipt("finding", 6_000);
  const raw = JSON.stringify(receipt);
  expect(raw.length).toBeGreaterThan(262_144); // Cross the existing generic preview boundary.
  const projected = projectTaskTranscriptToolResult(raw)!;
  const display = securityScanCardProjectionSchema.parse(JSON.parse(projected));
  expect(display.record?.evidenceCount).toBe(6_000);
  expect(display.record?.entry.summary).toBe(receipt.result.record.entry.summary);
  expect(projected).not.toContain("record_evidence_");
  expect(securityScanToolResultSchema.parse(JSON.parse(raw))).toEqual(receipt);
});

test("results display discloses omitted indexes and continuation without exposing cursor or claiming report readiness", () => {
  reapplyHappyDomGlobals();
  const receipt = { ok: true, operation: "results", result: {
    version: "security-scan-v1", reportReady: false, nextCursor: "cursor_private_recovery",
    status: { version: "security-scan-v1", scanId: "scan_card", state: "active", phase: "researching", terminalState: null,
      mode: "deep_research", modelId: "openai:gpt-5.6-sol", modelState: "running", completedSteps: 1, totalSteps: 2,
      lanes: SECURITY_SCAN_INITIAL_LANES, coverage: [], hypotheses: [] },
    observations: [], codeEvidence: [], records: [linkedRecordReceipt().result.record], inventory: [],
  } };
  const projected = projectTaskTranscriptToolResult(JSON.stringify(receipt))!;
  expect(projected).not.toContain("cursor_private_recovery");
  expect(projected).not.toContain("reportReady");
  const Body = securityScanRenderer.ExpandedBody;
  const view = render(<Body args={{ operation: "results" }} result={undefined} resultText={projected} state="success" event={undefined} resultTruncated={false} />);
  expect(view.container.textContent).toContain("1 research records");
  expect(view.container.textContent).toContain("More results remain");
  expect(view.container.textContent).toContain("Their contents are omitted from this card");
  expect(view.container.innerHTML).not.toContain("cursor_private_recovery");
  expect(view.container.innerHTML).not.toContain("reportReady");
  view.unmount();
});

test("malformed receipts and oversized unrelated results keep the safe generic fallback", () => {
  const malformed = linkedRecordReceipt();
  malformed.result.record.entry.evidenceRefs[0] = "[omitted]" as never;
  const result = projectTaskTranscriptToolResult(JSON.stringify(malformed))!;
  expect(securityScanCardProjectionSchema.safeParse(JSON.parse(result)).success).toBe(false);
  expect(projectTaskTranscriptToolResult('{"operation":"record","secret":"unfinished')).toBe("[structured result could not be safely previewed]");
  expect(projectTaskTranscriptToolResult(JSON.stringify({ operation: "record", output: "x".repeat(262_145) }))).toBe("[result too large to preview]");
  const withCredential = linkedRecordReceipt();
  withCredential.result.record.entry.summary = "Checked Bearer abcdefghijklmnopqrstuvwxyz at the boundary.";
  const safe = projectTaskTranscriptToolResult(JSON.stringify(withCredential))!;
  expect(safe).toContain("Bearer [redacted]");
  expect(safe).not.toContain("abcdefghijklmnopqrstuvwxyz");
});


test("direct rendering redacts credentials, escapes note markup and preserves accepted error recovery", () => {
  reapplyHappyDomGlobals();
  const receipt = linkedRecordReceipt();
  receipt.result.record.entry.summary = "<script>bad()</script> Checked Bearer abcdefghijklmnopqrstuvwxyz at the boundary.";
  const Body = securityScanRenderer.ExpandedBody;
  const view = render(<Body args={{ operation: "record" }} result={undefined} resultText={JSON.stringify(receipt)} state="success" event={undefined} resultTruncated={false} />);
  expect(view.container.textContent).toContain("Bearer [redacted]");
  expect(view.container.innerHTML).not.toContain("abcdefghijklmnopqrstuvwxyz");
  expect(view.container.querySelector("script")).toBeNull();
  expect(view.container.textContent).toContain("<script>bad()</script>");
  view.unmount();
  const error = { ok: false, operation: "record", error: { code: "record_conflict", retryable: true,
    message: "Research note revision changed.", continuation: "Reload the accepted record and use its current revision." } };
  const failure = render(<Body args={{ operation: "record" }} result={undefined} resultText={JSON.stringify(error)} state="error" event={undefined} resultTruncated={false} />);
  expect(failure.container.textContent).toContain(error.error.message);
  expect(failure.container.textContent).toContain(error.error.continuation);
  expect(failure.container.textContent).not.toContain("Research note accepted");
  failure.unmount();
});

test("historical context pages survive display projection with exact byte metadata and read-only CodeMirror", () => {
  reapplyHappyDomGlobals();
  const text = '{"note":"recover the full audit trace"}';
  const receipt = { ok: true, operation: "context", result: { version: "research-context-v1", contextRef: "private-context-reference",
    sha256: "a".repeat(64), serialization: "visible-message-json-utf8", startByte: 500, endByte: 500 + new TextEncoder().encode(text).length,
    totalBytes: 1000, text, complete: false, nextCursor: "private-context-cursor",
    source: { tool: "file", identity: "paired", outcome: "success", toolCallId: "private-origin-id", callRef: "private-origin-reference",
      command: "read", path: "identity/tokens.js", zone: "current", lineRange: { from: 40, to: 90 }, offset: 39, limit: 51, continuedRead: true } } };
  const projected = projectTaskTranscriptToolResult(JSON.stringify(receipt))!;
  expect(projected).not.toContain("private-context");
  expect(projected).not.toContain("sha256");
  expect(projected).not.toContain("private-origin");
  expect(projectToolResultTextForDisplay(projected)).toBe(projected);
  const Body = securityScanRenderer.ExpandedBody;
  const view = render(<Body args={{ operation: "context" }} result={undefined} resultText={projected} state="success" event={undefined} resultTruncated={false} />);
  expect(view.container.textContent).toContain(`bytes 500–${receipt.result.endByte} of 1000`);
  expect(view.container.textContent).toContain("More bytes remain");
  expect(view.container.textContent).toContain("file.read · identity/tokens.js · zone current · lines 40–90 · offset 39 · limit 51 · continued read");
  expect(view.container.textContent).toContain("does not prove source review or audit completion");
  expect(view.container.querySelector('.cm-content[contenteditable="false"]')).not.toBeNull();
  expect(view.container.querySelector(".cm-content")?.textContent).toContain(text);
  expect(view.container.textContent).not.toContain("could not be displayed");
  view.unmount();
});

test("unpaired historical file results show unavailable identity without inventing source paths", () => {
  reapplyHappyDomGlobals();
  const text = "return token;";
  const receipt = { ok: true, operation: "context", result: { version: "research-context-v1", contextRef: "private-context-reference",
    sha256: "a".repeat(64), serialization: "visible-message-json-utf8", startByte: 0, endByte: text.length,
    totalBytes: text.length, text, complete: true, nextCursor: null, source: { tool: "file", identity: "unavailable" } } };
  const projected = projectTaskTranscriptToolResult(JSON.stringify(receipt))!;
  const Body = securityScanRenderer.ExpandedBody;
  const view = render(<Body args={{ operation: "context" }} result={undefined} resultText={projected} state="success" event={undefined} resultTruncated={false} />);
  expect(view.container.textContent).toContain("Original file request identity is unavailable");
  expect(view.container.textContent).toContain("do not infer a source path");
  view.unmount();
});

test("saved record locators render as an index rather than recovered source work", () => {
  reapplyHappyDomGlobals();
  const text = '{"records":[{"id":"saved-note","sourcePaths":["identity/tokens.js"]}]}';
  const receipt = { ok: true, operation: "context", result: { version: "research-context-v1", contextRef: "private-record-index",
    sha256: "a".repeat(64), serialization: "saved-record-index-json-utf8", startByte: 0, endByte: text.length,
    totalBytes: text.length, text, complete: true, nextCursor: null } };
  const projected = projectTaskTranscriptToolResult(JSON.stringify(receipt))!;
  const Body = securityScanRenderer.ExpandedBody;
  const view = render(<Body args={{ operation: "context" }} result={undefined} resultText={projected} state="success" event={undefined} resultTruncated={false} />);
  expect(view.container.textContent).toContain("Saved research index");
  expect(view.container.textContent).not.toContain("Recovering historical context");
  expect(view.container.textContent).not.toContain("private-record-index");
  expect(view.container.querySelector('.cm-content[contenteditable="false"]')?.textContent).toContain("identity/tokens.js");
  expect(view.container.textContent).toContain("Reading this index does not count as source inspection");
  view.unmount();
});

test("historical paging errors remain useful and inconsistent page receipts are rejected", () => {
  const failed = { ok: false, operation: "context", error: { code: "context_cursor_stale", message: "Use the returned continuation for this historical input.", retryable: false } };
  expect(securityScanRenderer.collapsedSummary?.({ args: { operation: "context" }, result: undefined, state: "error", resultText: JSON.stringify(failed) }))
    .toBe(failed.error.message);
  const invalid = { ok: true, operation: "context", result: { version: "research-context-v1", contextRef: "private-ref", sha256: "a".repeat(64),
    serialization: "visible-message-json-utf8", startByte: 0, endByte: 100, totalBytes: 100, text: "too short", complete: true, nextCursor: null } };
  expect(securityScanCardProjectionSchema.safeParse(JSON.parse(projectTaskTranscriptToolResult(JSON.stringify(invalid))!)).success).toBe(false);
});

test("plain record validation and blocked-finalization errors show their complete sanitized recovery guidance", () => {
  reapplyHappyDomGlobals();
  const cases = [
    { operation: "record", text: "Error: security_scan received invalid arguments (entry.summary: Too big: expected string to have <=2000 characters). Correct the listed fields and retry the record operation once. This validation failure was not dispatched." },
    { operation: "record", text: "Error: security_scan received invalid arguments (fileCitations: evidence records require a durable reference or revalidated file citation). Add top-level fileCitations and retry one corrected record alone." },
    { operation: "results", text: "Error: security_scan received invalid arguments (category: Invalid option: expected one of all, observations, research, inventory). Correct the listed fields and retry the results operation once." },
    { operation: "results", text: "Recovered 33132 verified historical bytes. Context recovery is active. Recover pending historical pages, save material notes and a checkpoint through security_scan, then continue this same audit. New investigation and finalization have not executed." },
  ];
  const Body = securityScanRenderer.ExpandedBody;
  for (const { operation, text } of cases) {
    const resultText = projectToolResultTextForDisplay(text)!;
    expect(securityScanRenderer.collapsedSummary?.({ args: { operation }, result: undefined, resultText, state: "error" })).toBe(text);
    const view = render(<Body args={{ operation }} result={undefined} resultText={resultText} state="error" event={undefined} resultTruncated={false} />);
    expect(view.container.textContent).toBe(text);
    expect(view.container.querySelector(".text-tool-error")).not.toBeNull();
    expect(view.container.textContent).not.toContain("could not be displayed");
    view.unmount();
  }
});

test("plaintext error fallback requires an error outcome and never dumps structured or credential-bearing bodies", () => {
  reapplyHappyDomGlobals();
  const Body = securityScanRenderer.ExpandedBody;
  const error = "Error: <script>bad()</script> Authorization expired for Bearer abcdefghijklmnopqrstuvwxyz";
  const view = render(<Body args={{ operation: "record" }} result={undefined} resultText={error} state="error" event={undefined} resultTruncated={true} />);
  expect(view.container.textContent).toContain("Bearer [redacted]");
  expect(view.container.innerHTML).not.toContain("abcdefghijklmnopqrstuvwxyz");
  expect(view.container.querySelector("script")).toBeNull();
  expect(view.container.textContent).toContain("only part of this receipt");
  view.unmount();
  for (const resultText of [JSON.stringify({ error: "unvalidated", cursor: "private-capability" }), '{"error":"unterminated','["partial"']) {
    const invalid = render(<Body args={{ operation: "record" }} result={undefined} resultText={resultText} state="error" event={undefined} resultTruncated={false} />);
    expect(invalid.container.textContent).toContain("could not be displayed");
    expect(invalid.container.textContent).not.toContain("private-capability");
    expect(invalid.container.textContent).not.toContain("unvalidated");
    invalid.unmount();
  }
  for (const state of ["success", "running"] as const) {
    const ordinary = render(<Body args={{ operation: "record" }} result={undefined} resultText="Error: this text is not an error outcome" state={state} event={undefined} resultTruncated={false} />);
    expect(ordinary.container.textContent).not.toContain("this text is not an error outcome");
    expect(ordinary.container.querySelector(".text-tool-error")).toBeNull();
    ordinary.unmount();
  }
});


// GLM5 attempted a file read during context recovery. The saved ToolMessage
// carried this error, even though paging that message later succeeds.
const blockedHistoricalRead = "Recovered 0 verified historical bytes. Context recovery is active. Recover pending historical pages, save material notes and a checkpoint through security_scan, then continue this same audit. New investigation and finalization have not executed.";
function historicalAttemptReceipt(outcome?: "success" | "error" | "unknown") {
  const text = JSON.stringify({ role: "tool", content: blockedHistoricalRead, name: "file", outcome: outcome ?? "unknown" });
  return { ok: true, operation: "context", result: { version: "research-context-v1", contextRef: "private-attempt-ref",
    sha256: "a".repeat(64), serialization: "visible-message-json-utf8", startByte: 0, endByte: new TextEncoder().encode(text).length,
    totalBytes: new TextEncoder().encode(text).length, text, complete: true, nextCursor: null,
    source: { tool: "file", identity: "paired", callRef: "private-attempt-call", toolCallId: "private-attempt-id",
      command: "read", path: "identity/roles.js", ...(outcome ? { outcome } : {}) } } };
}

test("paging a blocked historical read shows its authoritative failure despite successful page retrieval", () => {
  reapplyHappyDomGlobals();
  const receipt = historicalAttemptReceipt("error");
  const projected = projectTaskTranscriptToolResult(JSON.stringify(receipt))!;
  const Body = securityScanRenderer.ExpandedBody;
  const props = { args: { operation: "context" }, result: undefined, resultText: projected, state: "success" as const, event: undefined, resultTruncated: false };
  const view = render(<Body {...props} />);
  expect(securityScanRenderer.collapsedSummary?.(props)).toContain("Historical file attempt · error");
  expect(view.container.textContent).toContain("Original attempt: file.read · identity/roles.js");
  expect(view.container.querySelector(".text-tool-error")?.textContent).toContain("original file operation returned an error");
  expect(view.container.textContent).toContain("does not establish a successful read");
  expect(view.container.querySelector('.cm-content[contenteditable="false"]')?.textContent).toContain(blockedHistoricalRead);
  expect(view.container.innerHTML).not.toContain("private-attempt");
  expect(view.container.textContent).not.toContain("could not be displayed");
  view.unmount();
});

test("legacy and unknown historical outcomes remain attempts without inferring success from content", () => {
  reapplyHappyDomGlobals();
  for (const outcome of [undefined, "unknown"] as const) {
    const receipt = historicalAttemptReceipt(outcome);
    const projected = projectTaskTranscriptToolResult(JSON.stringify(receipt))!;
    const Body = securityScanRenderer.ExpandedBody;
    const view = render(<Body args={{ operation: "context" }} result={undefined} resultText={projected} state="success" event={undefined} resultTruncated={false} />);
    expect(view.container.textContent).toContain("Historical file attempt · outcome unknown");
    expect(view.container.textContent).toContain("Do not infer that the file was successfully read");
    expect(view.container.querySelector(".cm-content")?.textContent).toContain(blockedHistoricalRead);
    view.unmount();
  }
});

test("lookup pages are optional navigation and cannot claim source inspection", () => {
  reapplyHappyDomGlobals();
  for (const serialization of ["saved-record-index-json-utf8", "visible-message-index-json-utf8"]) {
    const receipt = historicalAttemptReceipt();
    const { source: _source, ...page } = receipt.result;
    const projected = projectTaskTranscriptToolResult(JSON.stringify({ ...receipt, result: { ...page, serialization } }))!;
    const Body = securityScanRenderer.ExpandedBody;
    const view = render(<Body args={{ operation: "context" }} result={undefined} resultText={projected} state="success" event={undefined} resultTruncated={false} />);
    expect(view.container.textContent).toContain("lookup only");
    expect(view.container.textContent).toContain("Optional lookup metadata");
    expect(view.container.textContent).toContain("Reading this index does not count as source inspection");
    view.unmount();
  }
});

test("runtime recovery facts stay distinct from the model's self-authored checkpoint", () => {
  reapplyHappyDomGlobals();
  const receipt = { ...linkedRecordReceipt(), runtimeRecovery: { phase: "reading", pendingInputCount: 2,
    recoveredInputBytes: 4300, retainedUnconsolidatedPages: 3, asOfMessageIndex: 52, nextContextRef: "private-runtime-handle" } };
  const checkpoint = { kind: "checkpoint", summary: "All recovery is complete", nextWork: "Write the report", openRecordIds: [], evidenceRefs: [] };
  const raw = JSON.stringify({ ...receipt, result: { ...receipt.result, record: { ...receipt.result.record, entry: checkpoint } } });
  const projected = projectTaskTranscriptToolResult(raw)!;
  const Body = securityScanRenderer.ExpandedBody;
  const view = render(<Body args={{ operation: "record" }} result={undefined} resultText={projected} state="success" event={undefined} resultTruncated={false} />);
  expect(view.container.textContent).toContain(checkpoint.summary);
  const runtime = view.container.querySelector('[aria-label="Runtime recovery"]');
  expect(runtime?.textContent).toContain("2 saved inputs await recovery");
  expect(runtime?.textContent).toContain("4300 historical input bytes recovered");
  expect(runtime?.textContent).not.toContain(checkpoint.summary);
  expect(view.container.innerHTML).not.toContain("private-runtime-handle");
  expect(projected).not.toContain("nextContextRef");
  view.unmount();
});


test("navigation handles are hidden in the card while ordinary source text remains intact", () => {
  reapplyHappyDomGlobals();
  const text = JSON.stringify({ records: [{ id: "record_saved", title: "Membership boundary note", sourcePaths: ["identity/roles.js"], contextRef: "private-navigation-handle", nextCursor: "private-navigation-cursor" }] });
  const receipt = historicalAttemptReceipt("success");
  const { source: _source, ...page } = receipt.result;
  const raw = JSON.stringify({ ...receipt, result: { ...page, serialization: "saved-record-index-json-utf8", text,
    endByte: text.length, totalBytes: text.length } });
  const projected = projectTaskTranscriptToolResult(raw)!;
  expect(projected).not.toContain("private-navigation");
  expect(projected).toContain("identity/roles.js");
  expect(projected).toContain("Membership boundary note");
  const Body = securityScanRenderer.ExpandedBody;
  const view = render(<Body args={{ operation: "context" }} result={undefined} resultText={projected} state="success" event={undefined} resultTruncated={false} />);
  expect(view.container.querySelector('.cm-content[contenteditable="false"]')).not.toBeNull();
  expect(view.container.textContent).toContain("Display omits internal navigation handles");
  expect(view.container.textContent).not.toContain("could not be displayed");
  view.unmount();
  const sourceText = 'const contextRef = "ordinary source identifier";';
  const source = { ...receipt, result: { ...receipt.result, text: sourceText, endByte: sourceText.length, totalBytes: sourceText.length } };
  const sourceProjected = projectTaskTranscriptToolResult(JSON.stringify(source))!;
  const sourceView = render(<Body args={{ operation: "context" }} result={undefined} resultText={sourceProjected} state="success" event={undefined} resultTruncated={false} />);
  expect(sourceView.container.querySelector(".cm-content")?.textContent).toContain(sourceText);
  sourceView.unmount();
});


test("incomplete navigation JSON discloses the withheld preview while retaining its exact range", () => {
  reapplyHappyDomGlobals();
  const receipt = historicalAttemptReceipt();
  const { source: _source, ...page } = receipt.result;
  const text = '{"records":[{"contextRef":"private-partial-navigation';
  const projected = projectTaskTranscriptToolResult(JSON.stringify({ ...receipt, result: { ...page,
    serialization: "saved-record-index-json-utf8", text, startByte: 0, endByte: text.length,
    totalBytes: text.length + 100, complete: false, nextCursor: "private-continuation" } }))!;
  const Body = securityScanRenderer.ExpandedBody;
  const view = render(<Body args={{ operation: "context" }} result={undefined} resultText={projected} state="success" event={undefined} resultTruncated={false} />);
  expect(view.container.textContent).toContain(`bytes 0–${text.length} of ${text.length + 100}`);
  expect(view.container.textContent).toContain("More bytes remain");
  expect(view.container.textContent).toContain("Partial navigation page");
  expect(view.container.textContent).toContain("Display omits internal navigation handles");
  expect(view.container.innerHTML).not.toContain("private-");
  expect(view.container.textContent).not.toContain("could not be displayed");
  view.unmount();
});
