import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { assertMessageInvariants } from "@nautilo/message-invariants";
import { securityScanToolResultSchema, type SecurityScanLedgerRecord, type SecurityScanStatus } from "@nautilo/types";
import type { NautiloState } from "../../src/agent/state";
import { budgetResearchContext } from "../../src/tools/security/research-context-rollover";
import { describeResearchContextIndex, describeResearchContextMessage, readResearchContext, serializeResearchContextMessage } from "../../src/tools/security/research-context";
import { localToolControlFailure } from "../../src/tools/security/research-control-feedback";
import { estimateTokenCount } from "../../src/utils/history-manager";

const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openrouter:z-ai/glm-5.3" };
const status: SecurityScanStatus = { version: "security-scan-v1", scanId: "scan_current", state: "active", phase: "researching", terminalState: null,
  mode: "deep_research", targetFingerprint: "c".repeat(64), modelId: author.modelId, modelState: "running", completedSteps: 1, totalSteps: 2,
  lanes: (["gitleaks", "osv_scanner", "trivy", "semgrep"] as const).map((probe) => ({ probe, state: "unavailable", observationCount: 0, coverage: "limited",
    error: { code: "probe_unavailable", message: "Scanner unavailable; not clean coverage.", retryable: false } })), coverage: [], hypotheses: [] };
function fixture(repeat = 20) {
  const state = { messages: [new HumanMessage("Audit the authorized repository and assign the next unit.")], userId: "owner", currentTaskId: author.taskId,
    currentTaskRunId: author.taskRunId, subagentRun: true, toolWhitelist: ["file", "security_scan"], researchContextRecovery: null } as unknown as NautiloState;
  const append = (calls: Array<{ name: string; args: Record<string, unknown>; content: string; error?: boolean }>, prose = "") => {
    const id = `cycle-${state.messages.length}`;
    const cycle = [new AIMessage({ id, content: prose, tool_calls: calls.map((call, index) => ({ id: `${id}-${index}`, name: call.name, args: call.args })) }),
      ...calls.map((call, index) => new ToolMessage({ id: `tm-${id}-${index}`, name: call.name, tool_call_id: `${id}-${index}`, status: call.error ? "error" : "success", content: call.content }))];
    state.messages.push(...cycle);
    return cycle;
  };
  const record: SecurityScanLedgerRecord = { id: "unit-auth", revision: 1, createdBy: author, updatedBy: author,
    createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z", entry: { kind: "review_unit", summary: "Trace queued authorization after revocation. ".repeat(repeat),
      surfaceKey: "auth", paths: ["auth.ts"], state: "unreviewed", trace: "Trace the authorization boundary.", notes: "No inspection yet.", evidenceRefs: [], counterevidenceRefs: [], openRecordIds: [] } };
  const save = (saved: SecurityScanLedgerRecord) => {
    const value = { ok: true, operation: "record", result: { record: saved, codeEvidence: [] } };
    securityScanToolResultSchema.parse(value);
    append([{ name: "security_scan", args: { operation: "record", action: "append", entry: saved.entry }, content: JSON.stringify(value) }]);
  };
  save(record);
  save({ ...record, id: "checkpoint", entry: { kind: "checkpoint", summary: "Prior notes saved.", nextWork: "Reload the current assignment and hand it off.", openRecordIds: [], evidenceRefs: [] } });
  append([{ name: "file", args: { command: "read", path: "auth.ts" }, content: "Exact unread source. ".repeat(1600) }]);
  const sourceRef = describeResearchContextMessage(state, state.messages.length - 1)!.ref;
  state.researchContextRecovery = { taskRunId: author.taskRunId, throughIndex: state.messages.length - 1,
    indexRef: describeResearchContextIndex(state, state.messages.length - 1)!.ref, pendingRefs: [sourceRef], unpresentedReadIndices: [] };
  const invalidArgs = { operation: "unsupported" };
  append([{ name: "security_scan", args: invalidArgs, error: true,
    content: localToolControlFailure("security_scan", invalidArgs, "invalid_request", "Select a supported operation before retrying.") }]);
  const resultArgs = { version: "security-scan-v1", operation: "results", category: "research", recordKinds: ["review_unit"], finalize: false };
  const value = { ok: true, operation: "results", result: { version: "security-scan-v1", status, records: [record], codeEvidence: [], observations: [], nextCursor: null, reportReady: false } };
  securityScanToolResultSchema.parse(value);
  const reload = (sibling = false) => append([{ name: "security_scan", args: resultArgs, content: JSON.stringify(value) },
    ...(sibling ? [{ name: "file", args: { command: "read", path: "next.ts" }, content: "New sibling source must remain exact and unread. ".repeat(900) }] : [])], "Choose the next assignment from the returned current unit.");
  for (let index = 0; index < 25; index++) reload();
  return { state, record, sourceRef, reload, append, value };
}
function shownResult(messages: BaseMessage[], original: BaseMessage) {
  const shown = messages.find((message) => message.id === original.id);
  if (!shown || typeof shown.content !== "string") throw Error("Latest response is missing");
  return { shown, body: JSON.parse(shown.content) as { savedResearchReload?: { savedResearchResults?: { records: unknown; requestedRowsNotPresented?: boolean; notice?: string } } } };
}

test("after checkpointing, reset retains the latest complete results cycle without a retained context page", () => {
  const { state, record, sourceRef, reload } = fixture();
  const latest = reload();
  const canonical = JSON.stringify(state.messages);
  const result = budgetResearchContext(state, [new SystemMessage("Follow the current assignment; keep source authority unchanged."), ...state.messages], 4000);
  const { body } = shownResult(result.messages, latest[1]!);
  expect(body.savedResearchReload?.savedResearchResults?.records).toEqual([record]);
  expect(result.messages.find((message) => message.id === latest[0]!.id)?.content).toBe(latest[0]!.content);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(4000);
  expect(result.recovery?.pendingRefs).toContain(sourceRef);
  expect(result.recovery?.pendingRefs).not.toContain(describeResearchContextMessage(state, state.messages.length - 2)!.ref);
  expect(() => assertMessageInvariants(result.messages, "latest-results-after-reset")).not.toThrow();
  expect(JSON.stringify(state.messages)).toBe(canonical);
});

test("a large latest result keeps exact retrieval guidance and its successful source sibling stays paired", () => {
  const { state, sourceRef, reload } = fixture(650);
  const latest = reload(true);
  const canonical = JSON.stringify(state.messages);
  const result = budgetResearchContext(state, [new SystemMessage("Audit the authorized source."), ...state.messages], 4000);
  const { body } = shownResult(result.messages, latest[1]!);
  expect(body.savedResearchReload?.savedResearchResults?.requestedRowsNotPresented).toBe(true);
  expect(body.savedResearchReload?.savedResearchResults?.notice).toContain("single row");
  for (const member of latest) expect(result.messages.some((message) => message.id === member.id)).toBe(true);
  expect(result.recovery?.pendingRefs).toContain(sourceRef);
  const siblingRef = describeResearchContextMessage(state, state.messages.length - 1)!.ref;
  expect(result.recovery?.pendingRefs).toContain(siblingRef);
  const page = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: siblingRef }, { maxPageBytes: 100000 });
  expect(page.ok && page.result.text).toBe(serializeResearchContextMessage(latest[2]!)!);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(4000);
  expect(() => assertMessageInvariants(result.messages, "latest-results-mixed-cycle")).not.toThrow();
  expect(JSON.stringify(state.messages)).toBe(canonical);
});

test("record-kind reload retention never restores protection-altered note bytes", () => {
  const { state, record, reload } = fixture();
  const latest = reload();
  const original = latest[1] as ToolMessage;
  const value = JSON.parse(original.content as string) as { result: { records: SecurityScanLedgerRecord[] } };
  if (value.result.records[0]!.entry.kind !== "review_unit" || record.entry.kind !== "review_unit") throw Error("Expected review unit");
  value.result.records[0]!.entry.summary = "[protected note]";
  const protectedResult = new ToolMessage({ ...original, content: JSON.stringify(value) });
  const input = [new SystemMessage("Audit the authorized source."), ...state.messages.map((message) => message === original ? protectedResult : message)];
  const result = budgetResearchContext(state, input, 4000);
  expect(shownResult(result.messages, original).shown.content).not.toContain(record.entry.summary);
  expect(() => assertMessageInvariants(result.messages, "latest-results-protected")).not.toThrow();
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(4000);
});

test("unfiltered research and a second selected result in the latest batch both present their complete rows when they fit", () => {
  const { state, record, append, value } = fixture();
  const latest = append([
    { name: "security_scan", args: { operation: "results", category: "research", finalize: false }, content: JSON.stringify(value) },
    { name: "security_scan", args: { operation: "results", category: "research", recordKinds: ["review_unit"], finalize: false }, content: JSON.stringify(value) },
  ], "Use the returned saved assignment rather than repeat the lookup.");
  const result = budgetResearchContext(state, [new SystemMessage("Audit the authorized source."), ...state.messages], 5000);
  for (const member of latest.slice(1)) {
    const { body } = shownResult(result.messages, member);
    expect(body.savedResearchReload?.savedResearchResults?.records).toEqual([record]);
    expect(body.savedResearchReload?.savedResearchResults?.requestedRowsNotPresented).not.toBe(true);
  }
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(5000);
  expect(() => assertMessageInvariants(result.messages, "latest-results-two-reloads")).not.toThrow();
});

test("a changed unfiltered research result refills only its prepared bytes, or keeps exact paging when oversized", () => {
  for (const mode of ["full", "protected", "oversized"] as const) {
    const { state, record, sourceRef, append, value } = fixture();
    const changed = { ...record, revision: 2, entry: { ...record.entry, summary: "New accepted assignment revision. ".repeat(mode === "oversized" ? 900 : 15) } };
    const latest = append([{ name: "security_scan", args: { operation: "results", category: "research", finalize: false },
      content: JSON.stringify({ ...value, result: { ...value.result, records: [changed] } }) }]);
    const original = latest[1] as ToolMessage;
    const safe = mode === "protected" ? new ToolMessage({ ...original, content: (original.content as string).replace(changed.entry.summary, "[protected new note]") }) : original;
    const canonical = JSON.stringify(state.messages);
    const input = [new SystemMessage("Audit the authorized source."), ...state.messages.map((message) => message === original ? safe : message)];
    const result = budgetResearchContext(state, input, 4000);
    const shown = shownResult(result.messages, original).shown;
    if (mode === "oversized") {
      expect(shown.content).not.toContain(changed.entry.summary);
      expect(shown.content).toContain(describeResearchContextMessage(state, state.messages.length - 1)!.ref);
    } else expect(shown.content).toBe(safe.content);
    expect(result.recovery?.pendingRefs).toContain(sourceRef);
    expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(4000);
    expect(() => assertMessageInvariants(result.messages, "latest-changed-research-result")).not.toThrow();
    expect(JSON.stringify(state.messages)).toBe(canonical);
  }
});
