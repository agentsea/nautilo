import { describe, expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { SECURITY_SCAN_INITIAL_LANES } from "@nautilo/types";
import type { NautiloState } from "../../src/agent/state";
import { budgetResearchContext, currentResearchContextRecovery, researchContextRecoveryToolError } from "../../src/tools/security/research-context-rollover";
import { readResearchContext } from "../../src/tools/security/research-context";
import { modelOutputPreflightNode } from "../../src/nodes/model-output-preflight";
import { securityReportReadiness } from "../../src/tools/security/report-readiness";

const status = {
  version: "security-scan-v1", scanId: "scan_test", state: "active", phase: "researching",
  terminalState: null, mode: "deep_research", modelId: "openai:test", modelState: "running",
  researchProgress: { inventoryState: "complete", inventoryFingerprint: "d".repeat(64),
    filesTotal: 1, filesAssigned: 1, filesUnassigned: 0, unitsTotal: 1, unitsCompleted: 1, unitsPending: 0,
    excludedEntriesTotal: 0, coverageTotal: 1, hypothesesTotal: 1, coverageOmitted: 0, hypothesesOmitted: 0, latestCheckpoint: null },
  completedSteps: 1, totalSteps: 2, lanes: SECURITY_SCAN_INITIAL_LANES,
  coverage: [{ surfaceKey: "auth", label: "Auth", state: "reviewed", rationale: "Traced checks." }], hypotheses: [],
};
const evidence = {
  id: "evidence_test", relativePath: "src/auth.ts", startLine: 1, endLine: 2,
  fileSha256: "a".repeat(64), rangeSha256: "b".repeat(64), rootFingerprint: "c".repeat(64),
  capturedAt: "2026-09-05T12:00:00.000Z", gitHead: null, gitDirty: null,
};
function pair(id: string, args: Record<string, unknown>, result: unknown) {
  return [new AIMessage({ content: "", tool_calls: [{ id, name: "security_scan", args }] }),
    new ToolMessage({ name: "security_scan", tool_call_id: id, content: JSON.stringify(result) })];
}
const start = () => pair("start", { operation: "start" }, { ok: true, operation: "start", result: status });
function page(overrides: Record<string, unknown> = {}, args: Record<string, unknown> = {}) {
  return pair("results", { operation: "results", category: "all", finalize: true, ...args }, {
    ok: true, operation: "results", result: {
      version: "security-scan-v1", status: { ...status, state: "completed", phase: null,
        terminalState: "completed", modelState: "completed", completedSteps: 2 },
      observations: [], codeEvidence: [evidence], records: [], nextCursor: null, reportReady: true, ...overrides,
    },
  });
}
describe("verified security report readiness", () => {
  test("does not turn a failed tool call or report-shaped apology into a report", () => {
    expect(securityReportReadiness([
      ...pair("denied", { operation: "start" }, "You do not have permission to use security_scan."),
      new AIMessage("# Security report\nI cannot run this investigation."),
    ])).toBeNull();
    expect(securityReportReadiness(page({ reportReady: false }))).toBeNull();
  });
  test("requires finalized evidence and exhaustion, not a start or status receipt", () => {
    expect(securityReportReadiness(start())).toBeNull();
    expect(securityReportReadiness([...start(), ...page({}, { finalize: false })])).toBeNull();
    expect(securityReportReadiness([...start(), ...page({ nextCursor: "cursor_next" })])).toBeNull();
    expect(securityReportReadiness([...start(), ...page({ codeEvidence: [], reportReady: false })])).toBeNull();
    expect(securityReportReadiness([...start(), ...page({}, { category: "observations" })])).toBeNull();
    expect(securityReportReadiness([...start(), ...page({}, { probes: ["gitleaks"] })])).toBeNull();
    expect(securityReportReadiness([...start(), ...page()])).toBe("completed");
  });
  test("accumulates evidence across pages and preserves truthful partial state", () => {
    const partial = { ...status, state: "partial", terminalState: "partial", phase: null, modelState: "completed" };
    expect(securityReportReadiness([...start(), ...page({ nextCursor: "cursor_next" }),
      ...page({ status: partial, codeEvidence: [] }, { continueResults: true })])).toBe("partial");
  });
  test("rejects unpaired results and legacy receipts without durable completion proof", () => {
    expect(securityReportReadiness([...start(), page()[1]!])).toBeNull();
    expect(securityReportReadiness([...start(), ...page({ reportReady: undefined })])).toBeNull();
  });
});


test("final durable proof survives compaction of startup and earlier pages", () => {
  expect(securityReportReadiness(page({ codeEvidence: [], reportReady: true }))).toBe("completed");
});


test("legacy peer labels and unfinished review work cannot qualify the audit", () => {
  const terminal = { ...status, state: "completed", terminalState: "completed", modelState: "completed", phase: null };
  expect(securityReportReadiness(page({ status: { ...terminal, researchProgress: undefined } }))).toBeNull();
  expect(securityReportReadiness(page({ status: { ...terminal, researchProgress: { ...status.researchProgress, unitsPending: 1 } } }))).toBeNull();
  expect(securityReportReadiness(page({ status: { ...terminal, researchProgress: { ...status.researchProgress, nextResearchWork: "Resolve the open access-control question." } } }))).toBeNull();
});


test("final proof survives targeted immutable synthesis reads, but not failed or foreign reads", () => {
  expect(securityReportReadiness([...page(), ...page({ reportReady: false }, { category: "research", finalize: false, recordIds: ["record_finding"] })])).toBe("completed");
  expect(securityReportReadiness([...page(), ...pair("failed", { operation: "results", category: "research" }, { ok: false, operation: "results", error: { code: "root_revoked", retryable: false, message: "Access revoked" } })])).toBeNull();
  expect(securityReportReadiness([...page(), ...page({ status: { ...status, scanId: "scan_other" }, reportReady: false }, { category: "research", finalize: false })])).toBeNull();
});

test("a restarted full export must finish before the model can deliver its replacement", () => {
  expect(securityReportReadiness([...page(), ...page({ nextCursor: "cursor_restarted", reportReady: false })])).toBeNull();
  expect(securityReportReadiness([...page(), ...page({ nextCursor: "cursor_restarted", reportReady: false }), ...page({}, { continueResults: true })])).toBe("completed");
});


test("local historical navigation preserves existing export proof but cannot create readiness", () => {
  for (const result of [{ ok: true, operation: "context", result: { text: "retained input" } },
    { ok: false, operation: "context", error: { code: "context_reference_stale" } }]) {
    const navigation = pair("historical", { operation: "context", contextRef: "historical-input" }, result);
    expect(securityReportReadiness(navigation)).toBeNull();
    expect(securityReportReadiness([...page(), ...navigation])).toBe("completed");
  }
});


test("context overflow after finalized export recovers read-only and cannot finish before its pending bytes", () => {
  const state = { messages: [...page(), ...page({ codeEvidence: Array.from({ length: 100 }, () => evidence) },
    { category: "research", finalize: false, recordIds: ["record_saved_notes"] })],
    userId: "owner", currentTaskId: "task", currentTaskRunId: "run", subagentRun: true, taskRun: true,
    toolWhitelist: ["security_scan"], researchContextRecovery: null, researchContextPageBytes: null,
  } as unknown as NautiloState;
  const original = state.messages.map((message) => message.toDict());
  const budgeted = budgetResearchContext(state, state.messages, 4000);
  state.researchContextRecovery = budgeted.recovery;
  expect(budgeted.recovery).not.toBeNull();
  expect((budgeted.messages[0]!.content as string)).toContain("already finalized");
  expect(researchContextRecoveryToolError(state, "security_scan", { operation: "record" })).toContain("already finalized");
  const premature = modelOutputPreflightNode({ ...state, messages: [...state.messages, new AIMessage("Here is the report.")] });
  expect(premature.researchContinuationRequired).toBe(true);
  for (const contextRef of budgeted.recovery!.pendingRefs) {
    const args = { version: "security-scan-v1", operation: "context", contextRef };
    const receipt = readResearchContext(state, args, { maxPageBytes: 2000000 });
    if (!receipt.ok || !receipt.result.complete) throw new Error("Expected full exact historical read");
    state.messages.push(...pair("read-final-history", args, receipt));
  }
  expect(state.messages.slice(0, original.length).map((message) => message.toDict())).toEqual(original);
  expect(currentResearchContextRecovery(state)).toBeNull();
  expect(securityReportReadiness(state.messages)).toBe("completed");
  expect(modelOutputPreflightNode({ ...state, messages: [...state.messages, new AIMessage("The complete report with its stated limitations.")] }).researchContinuationRequired).toBe(false);
});


test("sealed sampled research remains deliverable with unassigned inventory, including after synthesis reads", () => {
  const terminal = { ...status, state: "completed", terminalState: "completed", modelState: "completed", phase: null,
    researchProgress: { ...status.researchProgress, filesTotal: 12000, filesAssigned: 125, filesUnassigned: 11875, nextResearchWork: null } };
  const sealed = page({ status: terminal });
  expect(securityReportReadiness(sealed)).toBe("completed");
  expect(securityReportReadiness([...sealed, ...page({ status: terminal, reportReady: false },
    { category: "research", finalize: false, recordIds: ["record_finding"] })])).toBe("completed");
});
