import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { securityScanHypothesisStatusPreview, securityScanToolResultSchema, type SecurityScanLedgerRecord, type SecurityScanStatus } from "@nautilo/types";
import type { NautiloState } from "../../src/agent/state";
import { estimateTokenCount } from "../../src/utils/history-manager";
import { deriveResearchSavedState } from "../../src/tools/security/research-saved-state";
import { describeResearchContextIndex, describeResearchContextMessage, describeResearchRecordIndex, readResearchContext, serializeResearchContextMessage, replayResearchContextReceipt } from "../../src/tools/security/research-context";
import { budgetResearchContext, remainingResearchContextRefs, researchContextRecoveryToolError } from "../../src/tools/security/research-context-rollover";

const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openai:gpt-5.6-sol" };
const code = (id: string, relativePath: string) => ({ id, relativePath, startLine: 1, endLine: 2, fileSha256: "a".repeat(64), rangeSha256: "b".repeat(64), rootFingerprint: "c".repeat(64), capturedAt: "2026-09-07T00:00:00.000Z", gitHead: null, gitDirty: false });
const progress = { inventoryState: "complete" as const, inventoryFingerprint: "b".repeat(64), filesTotal: 2, filesAssigned: 0, filesUnassigned: 2,
  unitsTotal: 0, unitsCompleted: 0, unitsPending: 0, nextResearchWork: "Classify remaining files into review units.", excludedEntriesTotal: 0, unavailableEntriesTotal: 0,
  coverageTotal: 1, hypothesesTotal: 0, coverageOmitted: 0, hypothesesOmitted: 0, latestCheckpoint: null };
const baseStatus: SecurityScanStatus = { version: "security-scan-v1", scanId: "scan_current", state: "active", phase: "researching", terminalState: null,
  mode: "deep_research", targetFingerprint: "c".repeat(64), modelId: author.modelId, modelState: "running", completedSteps: 1, totalSteps: 2,
  lanes: ["gitleaks", "osv_scanner", "trivy", "semgrep"].map((probe) => ({ probe: probe as SecurityScanStatus["lanes"][number]["probe"], state: "unavailable", observationCount: 0, coverage: "limited",
    error: { code: "probe_unavailable", message: "Scanner executable unavailable; this is not clean coverage.", retryable: false } })),
  researchProgress: progress, coverage: [], hypotheses: [] };
function messageText(message: BaseMessage): string {
  if (typeof message.content !== "string") throw new Error("Expected text fixture");
  return message.content;
}
function state() { return { messages: [new HumanMessage("Audit the authorized repository and preserve detailed analysis.")], userId: "owner", currentTaskId: author.taskId, currentTaskRunId: author.taskRunId,
  subagentRun: true, toolWhitelist: ["file", "security_scan"], researchContextRecovery: null } as unknown as NautiloState; }
function append(s: NautiloState, args: Record<string, unknown>, result: unknown, validate = true) {
  if (validate) securityScanToolResultSchema.parse(result);
  const id = `call-${s.messages.length}`;
  s.messages.push(new AIMessage({ id: `ai:${id}`, content: "", tool_calls: [{ id, name: "security_scan", args: { version: "security-scan-v1", ...args } }] }),
    new ToolMessage({ id: `tm:${id}`, name: "security_scan", tool_call_id: id, content: JSON.stringify(result) }));
  return s.messages.length - 1;
}
function save(s: NautiloState, id: string, entry: SecurityScanLedgerRecord["entry"], evidence: ReturnType<typeof code>[] = [], revision = 1) {
  const record: SecurityScanLedgerRecord = { id, revision, entry, createdBy: author, updatedBy: author, createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z" };
  const index = append(s, { operation: "record", action: "append", entry }, { ok: true, operation: "record", result: { record, codeEvidence: evidence } });
  return { record, index };
}
function setup() {
  const s = state();
  append(s, { operation: "start" }, { ok: true, operation: "start", result: baseStatus });
  const tokenCode = code("code_tokens", "identity/tokens.js"), shareCode = code("code_sharing", "documents/sharing.js");
  const token = save(s, "record_tokens", { kind: "evidence", summary: "Verified token admission and consuming call sites. ".repeat(30), evidenceRefs: [{ kind: "code_evidence", id: tokenCode.id }] }, [tokenCode]);
  const sharing = save(s, "record_sharing", { kind: "evidence", summary: "Traced organization-wide delivery and authorization. ".repeat(30), evidenceRefs: [{ kind: "code_evidence", id: shareCode.id }] }, [shareCode]);
  const checkpoint = save(s, "record_checkpoint", { kind: "checkpoint", summary: "Saved the latest source page.", nextWork: "Investigate remaining behavior and reuse earlier evidence.", openRecordIds: [], evidenceRefs: [] });
  return { s, token, sharing, checkpoint, tokenCode, shareCode };
}
function results(status: SecurityScanStatus, records: SecurityScanLedgerRecord[] = [], codeEvidence: ReturnType<typeof code>[] = [], extra = {}) {
  return { ok: true, operation: "results", result: { version: "security-scan-v1", status, records, codeEvidence, observations: [], nextCursor: null, reportReady: false, ...extra } };
}
function queue(s: NautiloState) {
  const throughIndex = s.messages.length - 1;
  s.researchContextRecovery = { taskRunId: author.taskRunId, throughIndex, indexRef: describeResearchContextIndex(s, throughIndex)!.ref,
    pendingRefs: s.messages.flatMap((_, index) => { const ref = describeResearchContextMessage(s, index)?.ref; return ref ? [ref] : []; }) };
  return s.researchContextRecovery;
}

test("repeated exact research reloads add no mandatory debt while original source, changed, foreign and unknown input remain", () => {
  const { s, token, tokenCode } = setup();
  const first = append(s, { operation: "results", category: "research", finalize: false }, results(baseStatus, [token.record], [tokenCode]));
  for (let i = 0; i < 6; i++) append(s, { operation: "results", category: "research", finalize: false }, results(baseStatus, [token.record], [tokenCode]));
  const derived = deriveResearchSavedState(s);
  expect(derived.exempt.has(first)).toBe(true);
  const pending = remainingResearchContextRefs(s, queue(s));
  for (let i = first; i < s.messages.length; i += 2) expect(pending).not.toContain(describeResearchContextMessage(s, i)!.ref);
  for (const variant of ["changed", "whitespace", "foreign", "unknown", "new_evidence", "final"]) {
    const record = structuredClone(token.record);
    if (variant === "changed" && record.entry.kind === "evidence") record.entry.summary = "New analysis returned unexpectedly.";
    if (variant === "whitespace" && record.entry.kind === "evidence") record.entry.summary = ` ${record.entry.summary} `;
    if (variant === "foreign") record.updatedBy.taskRunId = "33333333-3333-4333-8333-333333333333";
    const value = results(baseStatus, [record], [variant === "new_evidence" ? code("code_new", "new.js") : tokenCode], variant === "unknown" ? { unknownSource: "new bytes" } : {});
    const index = append(s, { operation: "results", category: "research", finalize: variant === "final" }, value, variant !== "unknown");
    expect(deriveResearchSavedState(s).exempt.has(index)).toBe(false);
    expect(remainingResearchContextRefs(s, queue(s))).toContain(describeResearchContextMessage(s, index)!.ref);
  }
});

test("only later identical inventory pages are aliases; initial bytes and changed target, fingerprint or entries remain required", () => {
  const { s } = setup();
  const inventory = [{ id: "file_tokens", relativePath: "identity/tokens.js", kind: "file", sizeBytes: 120, sourceVersion: "a".repeat(64), reason: "Inventory classification." }];
  const first = append(s, { operation: "results", category: "inventory" }, results(baseStatus, [], [], { inventory }));
  const echo = append(s, { operation: "results", category: "inventory" }, results(baseStatus, [], [], { inventory }));
  expect(deriveResearchSavedState(s).exempt.has(first)).toBe(false);
  expect(deriveResearchSavedState(s).exempt.has(echo)).toBe(true);
  const pending = remainingResearchContextRefs(s, queue(s));
  expect(pending).toContain(describeResearchContextMessage(s, first)!.ref);
  expect(pending).not.toContain(describeResearchContextMessage(s, echo)!.ref);
  for (const variant of ["target", "fingerprint", "entries", "whitespace"]) {
    const status = structuredClone(baseStatus);
    if (variant === "target") status.targetFingerprint = "d".repeat(64);
    if (variant === "fingerprint") status.researchProgress!.inventoryFingerprint = "e".repeat(64);
    const index = append(s, { operation: "results", category: "inventory" }, results(status, [], [], { inventory: variant === "entries" ? [{ ...inventory[0], sizeBytes: 121 }] : variant === "whitespace" ? [{ ...inventory[0], reason: " Inventory classification. " }] : inventory }));
    expect(deriveResearchSavedState(s).exempt.has(index)).toBe(false);
  }
});

test("long saved hypotheses do not turn repeated inventory into mandatory source debt", () => {
  const { s } = setup();
  const inventory = [{ id: "file_tokens", relativePath: "identity/tokens.js", kind: "file", sizeBytes: 120, sourceVersion: "a".repeat(64), reason: null }];
  const first = append(s, { operation: "results", category: "inventory" }, results(baseStatus, [], [], { inventory }));
  const summary = "Inspect whether revoked membership is checked by deferred consumers.\n".repeat(12) + "Distinct complete conclusion at the end.";
  const note = save(s, "record_long_hypothesis", { kind: "hypothesis", summary, state: "investigating", evidenceRefs: [], counterevidenceRefs: [] });
  const status = { ...baseStatus, hypotheses: [{ id: note.record.id, state: "unresolved" as const, summary: securityScanHypothesisStatusPreview(summary) }] };
  const echoes = [0, 1].map(() => append(s, { operation: "results", category: "inventory" }, results(status, [], [], { inventory })));
  const before = JSON.stringify(s.messages);
  const derived = deriveResearchSavedState(s);
  expect(derived.exempt.has(first)).toBe(false);
  for (const echo of echoes) expect(derived.exempt.has(echo)).toBe(true);
  const pending = remainingResearchContextRefs(s, queue(s));
  expect(pending).toContain(describeResearchContextMessage(s, first)!.ref);
  for (const echo of echoes) expect(pending).not.toContain(describeResearchContextMessage(s, echo)!.ref);
  expect(derived.latestStatus?.value).toMatchObject({ hypotheses: [{ id: note.record.id, state: "unresolved", savedProse: { id: note.record.id, revision: 1, kind: "hypothesis" } }] });
  const savedEntry = derived.records.get(note.record.id)?.rawRecord.entry;
  if (savedEntry?.kind !== "hypothesis") throw new Error("Expected saved hypothesis");
  expect(savedEntry.summary).toBe(summary);
  // A preview names the saved revision, not an unseen current full revision.
  expect(JSON.stringify(derived.latestStatus?.value)).not.toContain("latestRecord");
  for (const index of [first, note.index]) {
    const page = readResearchContext(s, { version: "security-scan-v1", operation: "context", contextRef: describeResearchContextMessage(s, index)!.ref }, { maxPageBytes: 20_000 });
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("Expected exact historical receipt");
    const original = serializeResearchContextMessage(s.messages[index]!);
    if (original === null) throw new Error("Expected visible historical message");
    expect(page.result.text).toBe(original);
  }
  expect(JSON.stringify(s.messages)).toBe(before);
});

test("status previews fail closed for changed bytes, missing fields, unknown identities and foreign scope", () => {
  for (const variant of ["changed", "short_prefix", "whitespace", "missing", "wrong_id", "wrong_kind", "foreign_task", "foreign_run", "target", "scan"]) {
    const { s } = setup();
    const inventory = [{ id: "file_tokens", relativePath: "identity/tokens.js", kind: "file", sizeBytes: 1, sourceVersion: "a".repeat(64), reason: null }];
    append(s, { operation: "results", category: "inventory" }, results(baseStatus, [], [], { inventory }));
    const summary = "Detailed source-backed hypothesis with unresolved questions. ".repeat(12);
    const note = save(s, "record_long_hypothesis", variant === "wrong_kind"
      ? { kind: "evidence", summary, evidenceRefs: [] }
      : { kind: "hypothesis", summary, state: "investigating", evidenceRefs: [], counterevidenceRefs: [] });
    const preview = securityScanHypothesisStatusPreview(summary);
    const rawSummary = variant === "changed" ? "X" + preview.slice(1) : variant === "short_prefix" ? preview.slice(0, -1)
      : variant === "whitespace" ? " " + preview.slice(1) : preview;
    const status = { ...baseStatus, ...(variant === "target" ? { targetFingerprint: "d".repeat(64) } : {}),
      ...(variant === "scan" ? { scanId: "scan_other" } : {}),
      hypotheses: [{ id: variant === "wrong_id" ? "record_unknown" : note.record.id, state: "investigating",
        ...(variant === "missing" ? {} : { summary: rawSummary }) }] };
    const echo = append(s, { operation: "results", category: "inventory" }, results(status as SecurityScanStatus, [], [], { inventory }), variant !== "missing");
    if (variant === "foreign_task") s.currentTaskId = "33333333-3333-4333-8333-333333333333";
    if (variant === "foreign_run") s.currentTaskRunId = "33333333-3333-4333-8333-333333333333";
    expect(deriveResearchSavedState(s).exempt.has(echo)).toBe(false);
  }
});

test("status projects only verified saved prose and preserves current coverage state, scanner errors, counts and cursor", () => {
  const { s, checkpoint } = setup();
  save(s, "record_map", { kind: "repository_map", summary: "Repository boundaries.", evidenceRefs: [], surfaces: [{ key: "core_store", label: "Persistence", coverage: "in_progress", rationale: "Follow mutable state and authorization." }] });
  const status = structuredClone(baseStatus);
  status.coverage = [{ surfaceKey: "core_store", label: "Persistence", state: "unreviewed", rationale: "Follow mutable state and authorization." }];
  if (checkpoint.record.entry.kind !== "checkpoint") throw new Error("checkpoint");
  status.researchProgress!.latestCheckpoint = { id: checkpoint.record.id, summary: checkpoint.record.entry.summary, nextWork: checkpoint.record.entry.nextWork, openRecordIds: [] };
  const index = append(s, { operation: "status" }, { ok: true, operation: "status", result: status });
  const saved = deriveResearchSavedState(s);
  expect(saved.exempt.has(index)).toBe(true);
  const projected = saved.latestStatus!.value as Record<string, unknown>;
  expect(projected["lanes"]).toEqual(status.lanes);
  expect(projected["coverage"]).toEqual([{ surfaceKey: "core_store", state: "unreviewed", savedProse: { id: "record_map", revision: 1, kind: "repository_map" } }]);
  expect(projected["researchProgress"]).toMatchObject({ filesUnassigned: 2, nextResearchWork: progress.nextResearchWork });
  const reload = append(s, { operation: "results", category: "research" }, results(status, [], [], { nextCursor: "next_page" }));
  expect(JSON.stringify(deriveResearchSavedState(s).projections.get(reload))).toContain('"nextCursor":"next_page"');
  const whitespace = structuredClone(status);
  whitespace.coverage[0]!.rationale = ` ${whitespace.coverage[0]!.rationale} `;
  const changedProse = append(s, { operation: "status" }, { ok: true, operation: "status", result: whitespace });
  expect(deriveResearchSavedState(s).exempt.has(changedProse)).toBe(false);
  status.coverage[0]!.rationale = "New unmatched limitation returned by Desktop.";
  const unknown = append(s, { operation: "status" }, { ok: true, operation: "status", result: status });
  expect(deriveResearchSavedState(s).exempt.has(unknown)).toBe(false);
  expect(JSON.stringify(deriveResearchSavedState(s).latestStatus)).toContain("New unmatched limitation");
  status.lanes[0]!.error!.message = "New scanner failure never previously returned.";
  const error = append(s, { operation: "status" }, { ok: true, operation: "status", result: status });
  expect(deriveResearchSavedState(s).exempt.has(error)).toBe(false);
});

test("exact coverage prose aliases its first immutable status without claiming new state was previously read", () => {
  const { s } = setup();
  const status = structuredClone(baseStatus);
  status.coverage = [{ surfaceKey: "route_work", label: "Request routing", state: "in_progress", rationale: "Assigned behavior work awaits current source verification." }];
  const first = append(s, { operation: "status" }, { ok: true, operation: "status", result: status });
  const nextStatus = structuredClone(status);
  nextStatus.coverage[0]!.state = "reviewed";
  nextStatus.researchProgress!.unitsCompleted = 1;
  const second = append(s, { operation: "status" }, { ok: true, operation: "status", result: nextStatus });
  const third = append(s, { operation: "status" }, { ok: true, operation: "status", result: nextStatus });
  const canonical = JSON.stringify(s.messages);
  const saved = deriveResearchSavedState(s, undefined, (index) => ({ contextRef: describeResearchContextMessage(s, index)!.ref }));
  expect(saved.exempt.has(first)).toBe(false);
  expect(saved.exempt.has(second)).toBe(true);
  expect(saved.exempt.has(third)).toBe(true);
  expect(saved.latestStatus!.value).toMatchObject({ coverage: [{ surfaceKey: "route_work", state: "reviewed", historicalProse: {
    exactHistoricalReceipt: { contextRef: describeResearchContextMessage(s, first)!.ref }, surfaceKey: "route_work",
  } }], researchProgress: { unitsCompleted: 1 } });
  const pending = remainingResearchContextRefs(s, queue(s));
  expect(pending).toContain(describeResearchContextMessage(s, first)!.ref);
  expect(pending).not.toContain(describeResearchContextMessage(s, second)!.ref);
  expect(pending).not.toContain(describeResearchContextMessage(s, third)!.ref);
  const page = readResearchContext(s, { version: "security-scan-v1", operation: "context", contextRef: describeResearchContextMessage(s, first)!.ref }, { maxPageBytes: 10_000 });
  if (!page.ok) throw new Error(page.error.message);
  expect(page.result.complete).toBe(true);
  expect(JSON.parse(page.result.text)).toMatchObject({ content: messageText(s.messages[first]!) });
  expect(JSON.stringify(s.messages)).toBe(canonical);
});

test("coverage aliases do not normalize novel prose, scope drift, invalid receipts or foreign run history", () => {
  for (const variant of ["label", "rationale", "whitespace", "surface", "scan", "target", "directory", "missing_target", "foreign_run", "invalid_first", "failed_first"]) {
    const { s } = setup();
    const status = structuredClone(baseStatus);
    status.coverage = [{ surfaceKey: "route_work", label: "Request routing", state: "in_progress", rationale: "Unsaved runtime explanation." }];
    const first = append(s, { operation: "status" }, { ok: true, operation: "status", result: status });
    if (variant === "invalid_first") s.messages[first]!.content = "unstructured status";
    if (variant === "failed_first") (s.messages[first] as ToolMessage).status = "error";
    if (variant === "foreign_run") s.currentTaskRunId = "33333333-3333-4333-8333-333333333333";
    if (variant === "label") status.coverage[0]!.label = "Different label";
    if (variant === "rationale") status.coverage[0]!.rationale = "New limitation.";
    if (variant === "whitespace") status.coverage[0]!.rationale = ` ${status.coverage[0]!.rationale} `;
    if (variant === "surface") status.coverage[0]!.surfaceKey = "different_surface";
    if (variant === "scan") status.scanId = "scan_other";
    if (variant === "target") status.targetFingerprint = "d".repeat(64);
    if (variant === "directory") status.targetDirectory = "other";
    if (variant === "missing_target") delete status.targetFingerprint;
    const changed = append(s, { operation: "status" }, { ok: true, operation: "status", result: status });
    const saved = deriveResearchSavedState(s);
    expect(saved.exempt.has(first)).toBe(false);
    expect(saved.exempt.has(changed)).toBe(false);
  }
});

test("nonfinal all pages project only exact accepted records and evidence while retaining the current page cursor", () => {
  const { s, token, tokenCode } = setup();
  const status = structuredClone(baseStatus);
  status.coverage = [{ surfaceKey: "route_work", label: "Request routing", state: "in_progress", rationale: "Derived current work remains incomplete." }];
  const first = append(s, { operation: "status" }, { ok: true, operation: "status", result: status });
  const page = append(s, { operation: "results", category: "all", finalize: false }, results(status, [token.record], [tokenCode], { nextCursor: "next_all_page" }));
  const saved = deriveResearchSavedState(s);
  expect(saved.exempt.has(first)).toBe(false);
  expect(saved.exempt.has(page)).toBe(true);
  expect(saved.projections.get(page)).toMatchObject({ savedResearchResults: { reportReady: false, nextCursor: "next_all_page",
    records: [{ id: token.record.id, revision: token.record.revision }], codeEvidence: [tokenCode] } });
  const defaulted = save(s, "record_empty_map", { kind: "repository_map", summary: "Map awaiting classification.", evidenceRefs: [], surfaces: [] });
  for (const variant of ["changed_record", "changed_evidence", "unknown_record", "foreign_record", "new_inventory", "new_observation", "final", "report_ready", "sealed", "raw_missing_default"]) {
    const record = structuredClone(variant === "raw_missing_default" ? defaulted.record : token.record);
    const evidence = structuredClone(tokenCode);
    if (variant === "changed_record" && record.entry.kind === "evidence") record.entry.summary += " New unsaved conclusion.";
    if (variant === "unknown_record") record.id = "record_unknown";
    if (variant === "foreign_record") record.updatedBy.taskRunId = "33333333-3333-4333-8333-333333333333";
    if (variant === "changed_evidence") evidence.fileSha256 = "d".repeat(64);
    const value = results(status, [record], [evidence], {
      ...(variant === "new_inventory" ? { inventory: [{ id: "file_new", relativePath: "new.js", kind: "file", sizeBytes: 1, sourceVersion: "a".repeat(64), reason: null }] } : {}),
      ...(variant === "new_observation" ? { observations: [{ id: "observation_new", probe: "semgrep", sourceScope: "current_tree", severity: "high",
        summary: "A new scanner observation.", relativePath: "new.js", startLine: 1, endLine: 1, ruleId: "rule_new", advisoryId: null, packageName: null, secretRedacted: true }] } : {}),
      ...(variant === "report_ready" ? { reportReady: true } : {}),
      ...(variant === "sealed" ? { exportSnapshot: { sha256: "d".repeat(64), itemCount: 2 } } : {}),
    });
    if (variant === "raw_missing_default") Reflect.deleteProperty(record.entry, "surfaces");
    const changed = append(s, { operation: "results", category: "all", finalize: variant === "final" }, value);
    expect(deriveResearchSavedState(s).exempt.has(changed)).toBe(false);
  }
});

test("an empty latest checkpoint still exposes prior tokens and sharing notes through the retained frozen locator", () => {
  const { s, token, sharing } = setup();
  const canonical = JSON.stringify(s.messages);
  const output = budgetResearchContext(s, [new SystemMessage("Immutable research instructions."), ...s.messages], 1500);
  const text = messageText(output.messages[0]!);
  expect(text).toContain("empty openRecordIds");
  expect(text).toContain("contextSourcePath");
  const ref = /research-records:\d+:[a-f0-9]{64}/.exec(text)![0];
  for (const [path, id] of [["identity/tokens.js", token.record.id], ["documents/sharing.js", sharing.record.id]]) {
    const page = readResearchContext(s, { version: "security-scan-v1", operation: "context", contextRef: ref, contextSourcePath: path, recordKinds: ["evidence"] }, { maxPageBytes: 10_000 });
    if (!page.ok) throw new Error(page.error.message);
    const locator = JSON.parse(page.result.text) as { records: Array<{ id: string; sourcePaths: string[]; latestRecord: { recordIds: string[] }; exactHistoricalReceipt: { contextRef: string } }> };
    expect(locator.records).toHaveLength(1);
    expect(locator.records[0]!.id).toBe(id!);
    expect(locator.records[0]!.sourcePaths).toEqual([path!]);
    expect(locator.records[0]!.latestRecord.recordIds).toEqual([id!]);
    expect(locator.records[0]!.exactHistoricalReceipt.contextRef).toStartWith("research-context:");
  }
  expect(JSON.stringify(s.messages)).toBe(canonical);
});

test("saved-record pages preserve exact UTF-8, full titles and frozen continuations across appends; filters and authority cannot change", () => {
  const { s } = setup();
  save(s, "record_finding", { kind: "finding", title: 'Complete title with "quotes" and 🔒', summary: "Evidence-backed finding.", confidence: "high", impact: "Private document read.", exploitPreconditions: "Untrusted actor invokes endpoint.", evidenceRefs: [{ kind: "ledger_record", id: "record_tokens" }], counterevidenceRefs: [] });
  const boundary = s.messages.length - 1;
  const ref = describeResearchRecordIndex(s, boundary)!.ref;
  const request = { version: "security-scan-v1", operation: "context", contextRef: ref };
  const whole = readResearchContext(s, request, { maxPageBytes: 100_000 });
  if (!whole.ok) throw new Error(whole.error.message);
  let cursor: string | undefined, text = "";
  do {
    const page = readResearchContext(s, { ...request, ...(cursor ? { contextCursor: cursor } : {}) }, { maxPageBytes: 950 });
    if (!page.ok) throw new Error(page.error.message);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(950);
    text += page.result.text;
    cursor = page.result.nextCursor ?? undefined;
    append(s, request, page, false);
    expect(describeResearchRecordIndex(s, boundary)!.ref).toBe(ref);
    if (cursor) {
      const invalid = readResearchContext(s, { ...request, contextCursor: cursor, recordKinds: ["finding"] }, { maxPageBytes: 950 });
      expect(invalid.ok).toBe(false);
    }
  } while (cursor);
  expect(text).toBe(whole.result.text);
  expect(text).toContain('Complete title with \\"quotes\\" and 🔒');
  save(s, "record_later", { kind: "checkpoint", summary: "Later handoff.", nextWork: "Continue.", openRecordIds: [], evidenceRefs: [] });
  expect(describeResearchRecordIndex(s, boundary)!.ref).toBe(ref);
  const latest = describeResearchRecordIndex(s, s.messages.length - 1)!;
  expect(latest.ref).not.toBe(ref);
  expect(readResearchContext({ ...s, userId: "other" }, request, { maxPageBytes: 950 }).ok).toBe(false);
  expect(readResearchContext({ ...s, subagentRun: false }, request, { maxPageBytes: 950 }).ok).toBe(false);
  const ordinary = describeResearchContextMessage(s, 2)!.ref;
  expect(readResearchContext(s, { ...request, contextRef: ordinary, recordKinds: [] }, { maxPageBytes: 950 }).ok).toBe(false);
  s.messages[4]!.content = messageText(s.messages[4]!).replace("Verified token", "Altered token");
  expect(readResearchContext(s, request, { maxPageBytes: 950 }).ok).toBe(false);
});

test("locator reads neither demand semantic checkpoints nor advance the original-source recovery guard", () => {
  const { s } = setup();
  s.messages.push(new AIMessage({ id: "source-call", content: "", tool_calls: [{ id: "source", name: "file", args: { command: "read", path: "pending.js" } }] }),
    new ToolMessage({ id: "source-result", name: "file", tool_call_id: "source", content: "Unconsolidated source. ".repeat(1000) }));
  const sourceRef = describeResearchContextMessage(s, s.messages.length - 1)!.ref;
  const recovery = queue(s);
  recovery.pendingRefs = [sourceRef];
  const before = researchContextRecoveryToolError(s, "file", { command: "read" });
  const locators: string[] = [];
  for (let i = 0; i < 3; i++) {
    save(s, `record_checkpoint_${i}`, { kind: "checkpoint", summary: "Metadata browsing does not inspect pending source.", nextWork: "Read remaining source.", openRecordIds: [], evidenceRefs: [] });
    const locator = describeResearchRecordIndex(s, s.messages.length - 1)!.ref;
    locators.push(locator);
    const args = { version: "security-scan-v1", operation: "context", contextRef: locator, recordKinds: ["evidence"] };
    const page = readResearchContext(s, args, { maxPageBytes: 1000 });
    if (!page.ok) throw new Error(page.error.message);
    append(s, args, page, false);
    expect(researchContextRecoveryToolError(s, "security_scan", args)).toBeNull();
    expect(researchContextRecoveryToolError(s, "security_scan", { ...args, contextRef: sourceRef, recordKinds: undefined })).toBeNull();
    expect(researchContextRecoveryToolError(s, "file", { command: "read" })).toBe(before);
    expect(remainingResearchContextRefs(s, recovery)).toEqual([sourceRef]);
  }
  const output = budgetResearchContext(s, [new SystemMessage("Immutable research instructions."), ...s.messages], 1800);
  for (const locator of locators) expect(output.recovery!.pendingRefs).not.toContain(locator);
  expect(output.recovery!.pendingRefs).toContain(sourceRef);
});


test("small model budgets keep locator access and canonical bytes; irreducible instructions expose zero page capacity", () => {
  const { s } = setup();
  const canonical = JSON.stringify(s.messages);
  const system = new SystemMessage("Immutable research instructions.");
  const result = budgetResearchContext(s, [system, ...s.messages], 1600);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(1600);
  expect(messageText(result.messages[0]!)).toContain("research-records:");
  const impossible = budgetResearchContext(s, [new SystemMessage("Immutable authorized instruction. ".repeat(1000)), ...s.messages], 100);
  expect(impossible.pageBytes).toBe(0);
  expect(estimateTokenCount(impossible.messages)).toBeGreaterThan(100);
  expect(JSON.stringify(s.messages)).toBe(canonical);
});

test("novel status prose and scanner text never become protected system instructions or disappear from mandatory input", () => {
  const { s } = setup();
  const status = structuredClone(baseStatus);
  status.coverage = Array.from({ length: 30 }, (_, i) => ({ surfaceKey: `surface_${i}`, label: `Surface ${i}`, state: "unreviewed" as const, rationale: "UNTRUSTED_STATUS_PROSE ".repeat(20) }));
  status.lanes[0]!.error!.message = "UNTRUSTED_SCANNER_PROSE ".repeat(8);
  const index = append(s, { operation: "status" }, { ok: true, operation: "status", result: status });
  const canonical = JSON.stringify(s.messages);
  queue(s);
  const system = new SystemMessage("Immutable authorized research configuration. ".repeat(1064));
  const result = budgetResearchContext(s, [system, ...s.messages], 20_388);
  const prompt = messageText(result.messages[0]!);
  expect(prompt).not.toContain("UNTRUSTED_STATUS_PROSE");
  expect(prompt).not.toContain("UNTRUSTED_SCANNER_PROSE");
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(20_388);
  expect(result.recovery!.pendingRefs).toContain(describeResearchContextMessage(s, index)!.ref);
  expect(JSON.stringify(s.messages)).toBe(canonical);
});


test("filtered multi-page locator bytes have their own digest and a filter-bound continuation", () => {
  const { s } = setup();
  const request = { version: "security-scan-v1", operation: "context", contextRef: describeResearchRecordIndex(s, s.messages.length - 1)!.ref, recordKinds: ["evidence"], contextSourcePath: "identity/tokens.js" };
  let text = "", cursor: string | undefined, sha: string | undefined, pages = 0;
  do {
    const page = readResearchContext(s, { ...request, ...(cursor ? { contextCursor: cursor } : {}) }, { maxPageBytes: 800 });
    if (!page.ok) throw new Error(page.error.message);
    if (sha) expect(page.result.sha256).toBe(sha);
    sha = page.result.sha256;
    text += page.result.text;
    cursor = page.result.nextCursor ?? undefined;
    pages++;
  } while (cursor);
  expect(pages).toBeGreaterThan(1);
  expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(sha);
  const filtered = JSON.parse(text) as { records: Array<{ id: string }> };
  expect(filtered.records.map((row) => row.id)).toEqual(["record_tokens"]);
});

test("newer accepted record progress replaces stale status counts with its exact provenance", () => {
  const { s, token } = setup();
  const newer = { ...progress, filesAssigned: 1, filesUnassigned: 1, unitsTotal: 1, unitsPending: 1 };
  const index = append(s, { operation: "record", action: "update", entry: token.record.entry }, { ok: true, operation: "record", result: { record: { ...token.record, revision: 2 }, codeEvidence: [], researchProgress: newer } });
  const derived = deriveResearchSavedState(s);
  expect(derived.latestStatus!.controls["researchProgress"]).toMatchObject({ filesAssigned: 1, filesUnassigned: 1, unitsTotal: 1 });
  expect(derived.latestStatus!.progressReceiptIndex).toBe(index);
  const result = budgetResearchContext(s, [new SystemMessage("Immutable research instructions."), ...s.messages], 10_000);
  expect(messageText(result.messages[0]!)).toContain(describeResearchContextMessage(s, index)!.ref);
});


test("defaulted repository-map fields stay safe, and ambiguous paired call IDs cannot prune unsaved input", () => {
  const { s } = setup();
  const map = save(s, "record_default_map", { kind: "repository_map", summary: "Map without declared surfaces.", evidenceRefs: [], surfaces: [] });
  const raw = JSON.parse(messageText(s.messages[map.index]!)) as { result: { record: { entry: { surfaces?: unknown } } } };
  delete raw.result.record.entry.surfaces;
  s.messages[map.index]!.content = JSON.stringify(raw);
  const status = structuredClone(baseStatus);
  status.coverage = [{ surfaceKey: "novel_surface", label: "New surface", state: "unreviewed", rationale: "Not in saved map." }];
  append(s, { operation: "status" }, { ok: true, operation: "status", result: status });
  expect(() => deriveResearchSavedState(s)).not.toThrow();
  const ai = s.messages[map.index - 1]!;
  if (!AIMessage.isInstance(ai)) throw new Error("Expected assistant call");
  ai.tool_calls!.push({ ...ai.tool_calls![0]!, args: { operation: "record", entry: { kind: "evidence", summary: "Unaccepted earlier argument." } } });
  expect(deriveResearchSavedState(s).exempt.has(map.index)).toBe(false);
  const refs = remainingResearchContextRefs(s, queue(s));
  expect(refs).toContain(describeResearchContextMessage(s, map.index - 1)!.ref);
  expect(refs).toContain(describeResearchContextMessage(s, map.index)!.ref);
});

test("metadata-only locator navigation can reset the provider workspace without creating mandatory historical-index debt", () => {
  const { s } = setup();
  const prefix = new SystemMessage("Immutable authorized research configuration. ".repeat(1064));
  const before = budgetResearchContext(s, [prefix, ...s.messages], 20_388);
  expect(before.recovery).toBeNull();
  const locator = describeResearchRecordIndex(s, s.messages.length - 1)!.ref;
  let cursor: string | undefined;
  for (let i = 0; i < 40; i++) {
    const args = { version: "security-scan-v1", operation: "context", contextRef: locator, ...(cursor ? { contextCursor: cursor } : {}) };
    const page = readResearchContext(s, args, { maxPageBytes: 1200 });
    if (!page.ok) throw new Error(page.error.message);
    append(s, args, page, false);
    cursor = page.result.nextCursor ?? undefined;
  }
  const canonical = JSON.stringify(s.messages);
  const result = budgetResearchContext(s, [prefix, ...s.messages], 20_388);
  // Reset keeps the current navigation response paired with its request so
  // the model can act on it; earlier locator pages create no recovery debt.
  const latestCycle = s.messages.slice(-2);
  const retainedCycle: BaseMessage[] = result.messages.filter((message) => AIMessage.isInstance(message) || ToolMessage.isInstance(message));
  expect(retainedCycle).toEqual(latestCycle);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(20_388);
  expect(result.recovery).toBeNull();
  expect(messageText(result.messages[0]!)).toContain(locator);
  expect(messageText(result.messages[0]!)).not.toContain("[RESEARCH CONTEXT RECOVERY]");
  expect(result.pageBytes).toBeGreaterThan(0);
  expect(JSON.stringify(s.messages)).toBe(canonical);

  // Metadata remains exempt, but new visible reasoning is genuine input even
  // when the only tool traffic around it consists of optional locator reads.
  s.messages.push(new AIMessage({ id: "unsaved-after-locator", content: "Unsaved authority-boundary insight. ".repeat(3000) }));
  const noteIndex = s.messages.length - 1;
  const withNote = budgetResearchContext(s, [prefix, ...s.messages], 20_388);
  expect(withNote.recovery!.pendingRefs).toContain(describeResearchContextMessage(s, noteIndex)!.ref);
  expect(withNote.recovery!.pendingRefs).not.toContain(locator);
  expect(estimateTokenCount(withNote.messages)).toBeLessThanOrEqual(20_388);
});


test("changing runtime snapshots do not turn exact saved ledger or inventory echoes into new source debt", () => {
  const { s, token, tokenCode } = setup();
  const runtime = (index: number) => ({ phase: "reading", pendingInputCount: 10 - index, recoveredInputBytes: index * 500,
    retainedUnconsolidatedPages: index, asOfMessageIndex: s.messages.length - 1, nextContextRef: "research-context:runtime-owned" });
  const inventory = [{ id: "file_tokens", relativePath: "identity/tokens.js", kind: "file", sizeBytes: 120, sourceVersion: "a".repeat(64), reason: "Inventory classification." }];
  const initial = append(s, { operation: "results", category: "inventory" }, { ...results(baseStatus, [], [], { inventory }), runtimeRecovery: runtime(0) });
  const echoes: number[] = [];
  for (let index = 1; index < 4; index++) {
    echoes.push(append(s, { operation: "results", category: "research" }, { ...results(baseStatus, [token.record], [tokenCode]), runtimeRecovery: runtime(index) }));
    echoes.push(append(s, { operation: "results", category: "inventory" }, { ...results(baseStatus, [], [], { inventory }), runtimeRecovery: runtime(index) }));
    echoes.push(append(s, { operation: "status" }, { ok: true, operation: "status", result: baseStatus, runtimeRecovery: runtime(index) }));
  }
  const saved = deriveResearchSavedState(s);
  expect(saved.exempt.has(initial)).toBe(false);
  for (const index of echoes) expect(saved.exempt.has(index)).toBe(true);
  const pending = remainingResearchContextRefs(s, queue(s));
  expect(pending).toContain(describeResearchContextMessage(s, initial)!.ref);
  for (const index of echoes) expect(pending).not.toContain(describeResearchContextMessage(s, index)!.ref);
});


test("explicit saved-index continuation preserves frozen filters and replay selection after later saved notes", () => {
  const { s } = setup();
  const contextRef = describeResearchRecordIndex(s, s.messages.length - 1)!.ref;
  const args = { version: "security-scan-v1", operation: "context", contextRef, recordKinds: ["evidence"], contextSourcePath: "identity/tokens.js", contextBytes: 60 };
  const first = readResearchContext(s, args, { maxPageBytes: 1800 });
  if (!first.ok) throw Error(first.error.message);
  append(s, args, first, false);
  const nextArgs = { version: "security-scan-v1", operation: "context", contextRef, continueContext: true, contextBytes: 60 };
  const next = readResearchContext(s, nextArgs, { maxPageBytes: 1800 });
  if (!next.ok) throw Error(next.error.message);
  expect(next.result.startByte).toBe(first.result.endByte);
  expect(next.result.resolvedSelection).toMatchObject({ contextRef, recordKinds: ["evidence"], contextSourcePath: "identity/tokens.js" });
  append(s, nextArgs, next, false);
  save(s, "record_later", { kind: "open_question", question: "New note after the frozen lookup.", evidenceRefs: [] });
  expect(replayResearchContextReceipt(s, nextArgs, next)).toEqual(next);
  expect(readResearchContext(s, { ...nextArgs, contextSourcePath: "documents/sharing.js" }, { maxPageBytes: 1800 })).toMatchObject({ ok: false, error: { code: "context_cursor_stale" } });
  expect(replayResearchContextReceipt(s, { ...args, recordKinds: ["finding"] }, first)).toBeNull();
});
