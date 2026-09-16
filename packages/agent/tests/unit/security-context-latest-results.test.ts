import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { securityScanOperationSchema, securityScanToolResultSchema, type SecurityScanStatus } from "@nautilo/types";
import type { NautiloState } from "../../src/agent/state";
import { budgetResearchContext } from "../../src/tools/security/research-context-rollover";
import { describeResearchContextMessage, readResearchContext, serializeResearchContextMessage } from "../../src/tools/security/research-context";
import { normalizeSecurityScanOperationArgs } from "../../src/tools/invocation-service";
import { estimateTokenCount } from "../../src/utils/history-manager";

const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openrouter:z-ai/glm-5.3" };
const status: SecurityScanStatus = { version: "security-scan-v1", scanId: "scan_current", state: "active", phase: "researching", terminalState: null,
  mode: "deep_research", targetFingerprint: "c".repeat(64), modelId: author.modelId, modelState: "running", completedSteps: 1, totalSteps: 2,
  lanes: (["gitleaks", "osv_scanner", "trivy", "semgrep"] as const).map((probe) => ({ probe, state: "unavailable", observationCount: 0, coverage: "limited",
    error: { code: "probe_unavailable", message: "Scanner unavailable; no clean coverage claim.", retryable: false } })), coverage: [], hypotheses: [], researchProgress: { inventoryState: "complete", inventoryFingerprint: "b".repeat(64), filesTotal: 37,
    filesAssigned: 0, filesUnassigned: 37, unitsTotal: 0, unitsCompleted: 0, unitsPending: 0, nextResearchWork: "Choose relevant behavior to investigate.",
    excludedEntriesTotal: 0, unavailableEntriesTotal: 0, coverageTotal: 0, hypothesesTotal: 0, coverageOmitted: 0, hypothesesOmitted: 0, latestCheckpoint: null } };
function fixture() {
  const state = { messages: [new HumanMessage("Investigate the authorized repository.")], userId: "owner", currentTaskId: author.taskId,
    currentTaskRunId: author.taskRunId, subagentRun: true, toolWhitelist: ["file", "security_scan"], researchContextRecovery: null } as unknown as NautiloState;
  const append = (args: Record<string, unknown>, value: unknown) => {
    securityScanToolResultSchema.parse(value);
    const id = `call-${state.messages.length}`;
    state.messages.push(new AIMessage({ id: `ai-${id}`, content: "", tool_calls: [{ id, name: "security_scan", args: { version: "security-scan-v1", ...args } }] }),
      new ToolMessage({ id: `tm-${id}`, name: "security_scan", tool_call_id: id, status: "success", content: JSON.stringify(value) }));
    return state.messages.length - 1;
  };
  const entry = { kind: "evidence", summary: "Previously accepted source notes.", evidenceRefs: [] };
  append({ operation: "record", action: "append", entry }, { ok: true, operation: "record", result: { codeEvidence: [], record: {
    id: "known-note", revision: 1, entry, createdBy: author, updatedBy: author, createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z",
  } } });
  const inventory = Array.from({ length: 37 }, (_, index) => ({ id: `file-${index}`, relativePath: `source/exact-${index}.ts`, kind: "file", sizeBytes: index + 100,
    sourceVersion: "d".repeat(64), reason: "  Exact inventory classification 🦀 with meaningful whitespace.  " }));
  const indices = Array.from({ length: 3 }, () => append({ operation: "results", category: "inventory", finalize: false }, {
    ok: true, operation: "results", result: { version: "security-scan-v1", status, records: [], codeEvidence: [], observations: [], inventory,
      nextCursor: "exact-inventory-continuation", reportReady: false },
  }));
  return { state, inventory, indices, append };
}
function inventoryResult(state: NautiloState, messages: NautiloState["messages"], index: number) {
  const canonical = state.messages[index] as ToolMessage;
  const shown = messages.find((message) => ToolMessage.isInstance(message) && message.tool_call_id === canonical.tool_call_id);
  if (typeof shown?.content !== "string") throw Error("Expected retained inventory receipt");
  return (JSON.parse(shown.content) as { savedResearchReload: { savedResearchInventory: { inventory: unknown; nextCursor: string; status: unknown } } }).savedResearchReload.savedResearchInventory;
}

test("latest requested inventory keeps every exact row and cursor when its existing paired window fits", () => {
  const { state, inventory, indices } = fixture();
  const canonical = JSON.stringify(state.messages);
  const unknownCall = new AIMessage({ id: "unknown-call", content: "Unmapped current reasoning.", tool_calls: [{ id: "unknown", name: "file", args: { command: "read", path: "unmapped.ts" } }] });
  const unknownResult = new ToolMessage({ id: "unknown-result", tool_call_id: "unknown", name: "file", content: "Exact unmapped source result." });
  const result = budgetResearchContext(state, [new SystemMessage("Review the source carefully. ".repeat(40)), ...state.messages, unknownCall, unknownResult], 6000);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(6000);
  expect(inventoryResult(state, result.messages, indices[2]!).inventory).toEqual(inventory);
  expect(JSON.stringify(inventoryResult(state, result.messages, indices[2]!))).not.toContain('"requestedRowsNotPresented":true');
  expect(inventoryResult(state, result.messages, indices[2]!).nextCursor).toBe("exact-inventory-continuation");
  expect(inventoryResult(state, result.messages, indices[1]!).inventory).toMatchObject({ entries: 37 });
  expect(result.messages).toContain(unknownCall); expect(result.messages).toContain(unknownResult);
  const original = state.messages[indices[2]!] as ToolMessage;
  const shown = result.messages.find((message) => message.id === original.id) as ToolMessage;
  expect(shown.status).toBe("success"); expect(shown.tool_call_id).toBe(original.tool_call_id);
  const call = result.messages.find((message) => message.id === state.messages[indices[2]! - 1]!.id) as AIMessage;
  expect(call.tool_calls![0]!.id).toBe(shown.tool_call_id);
  expect(result.recovery?.pendingRefs ?? []).not.toContain(describeResearchContextMessage(state, indices[2]!)!.ref);
  expect(JSON.stringify(state.messages)).toBe(canonical);
});

test("an inventory page that cannot fit remains exactly retrievable without weakening the byte budget", () => {
  const { state, inventory, indices } = fixture();
  const canonical = JSON.stringify(state.messages);
  const result = budgetResearchContext(state, [new SystemMessage("Review carefully."), ...state.messages], 2200);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(2200);
  const index = indices[2]!;
  const canonicalRef = describeResearchContextMessage(state, index)!;
  const shown = result.messages.find((message) => message.id === state.messages[index]!.id);
  if (shown) expect(inventoryResult(state, result.messages, index).inventory).toMatchObject({ entries: inventory.length });
  const page = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: canonicalRef.ref }, { maxPageBytes: 100000 });
  expect(page.ok).toBe(true);
  if (!page.ok) throw Error(page.error.code);
  expect(page.result.text).toBe(serializeResearchContextMessage(state.messages[index]!)!);
  expect(result.recovery?.pendingRefs ?? []).not.toContain(canonicalRef.ref);
  expect(JSON.stringify(state.messages)).toBe(canonical);
});


test("inventory refill never replaces protection-altered prepared rows with canonical fields", () => {
  const { state, indices } = fixture();
  const index = indices[2]!;
  const original = state.messages[index] as ToolMessage;
  const value = JSON.parse(original.content as string) as { result: { inventory: Array<{ relativePath: string }> } };
  value.result.inventory[0]!.relativePath = "[protected path]";
  const protectedReceipt = new ToolMessage({ id: original.id!, tool_call_id: original.tool_call_id, name: "security_scan", status: "success", content: JSON.stringify(value) });
  const input = [new SystemMessage("Review carefully."), ...state.messages.map((message) => message === original ? protectedReceipt : message)];
  const result = budgetResearchContext(state, input, 6000);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(6000);
  expect(inventoryResult(state, result.messages, index).inventory).toMatchObject({ entries: 37 });
  expect(original.content).toContain("source/exact-0.ts");
  expect(protectedReceipt.content).toContain("[protected path]");
});


function targetedFixture() {
  const { state, append } = fixture();
  state.messages.splice(3);
  const codeEvidence = [{ id: "code-tokens", relativePath: "identity/tokens.ts", startLine: 1, endLine: 2, fileSha256: "a".repeat(64), rangeSha256: "b".repeat(64),
    rootFingerprint: "c".repeat(64), capturedAt: "2026-09-08T00:00:00Z", gitHead: null, gitDirty: false }];
  const entry = { kind: "evidence", summary: "Verified token admission and consuming call sites. ".repeat(30), evidenceRefs: [{ kind: "code_evidence", id: codeEvidence[0]!.id }] };
  const record = { id: "requested-note", revision: 1, entry, createdBy: author, updatedBy: author, createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z" };
  append({ operation: "record", action: "append", entry }, { ok: true, operation: "record", result: { record, codeEvidence } });
  const checkpoint = { kind: "checkpoint", summary: "Detailed notes saved.", nextWork: "Investigate remaining input and reuse saved conclusions.", openRecordIds: [], evidenceRefs: [] };
  append({ operation: "record", action: "append", entry: checkpoint }, { ok: true, operation: "record", result: { codeEvidence: [], record: {
    ...record, id: "checkpoint", entry: checkpoint,
  } } });
  state.messages.push(new AIMessage({ id: "source-call", content: "", tool_calls: [{ id: "source", name: "file", args: { command: "read", path: "next.ts" } }] }),
    new ToolMessage({ id: "source-result", name: "file", tool_call_id: "source", status: "success", content: "Uncheckpointed source bytes requiring reasoning. ".repeat(1000) }));
  const index = append({ operation: "results", category: "research", recordIds: [record.id], finalize: false }, { ok: true, operation: "results", result: {
    version: "security-scan-v1", status, records: [record], codeEvidence, observations: [], nextCursor: "requested-record-cursor", reportReady: false,
  } });
  return { state, index, record, codeEvidence };
}

test("an explicit saved-note reload presents its complete accepted record, provenance and continuation when they fit", () => {
  const { state, index, record, codeEvidence } = targetedFixture();
  const canonical = JSON.stringify(state.messages);
  const result = budgetResearchContext(state, [new SystemMessage("Audit with complete notes."), ...state.messages], 4000);
  const shown = result.messages.find((message) => message.id === state.messages[index]!.id) as ToolMessage;
  const body = (JSON.parse(shown.content as string) as { savedResearchReload: { savedResearchResults: { records: unknown; codeEvidence: unknown; nextCursor: string } } }).savedResearchReload.savedResearchResults;
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(4000);
  expect(body.records).toEqual([record]);
  expect(body.codeEvidence).toEqual(codeEvidence);
  expect(body.nextCursor).toBe("requested-record-cursor");
  expect(shown.status).toBe("success");
  expect(result.recovery?.pendingRefs).toContain(describeResearchContextMessage(state, index - 2)!.ref);
  expect(JSON.stringify(state.messages)).toBe(canonical);
});

test("a targeted record that cannot fit keeps its exact pointer and protection changes cannot restore omitted note text", () => {
  for (const protectedInput of [false, true]) {
    const { state, index, record } = targetedFixture();
    const original = state.messages[index] as ToolMessage;
    const input = [new SystemMessage("Audit with complete notes."), ...state.messages];
    if (protectedInput) {
      const value = JSON.parse(original.content as string) as { result: { records: Array<{ entry: { summary: string } }> } };
      value.result.records[0]!.entry.summary = "[protected note]";
      input[input.indexOf(original)] = new ToolMessage({ id: original.id!, name: "security_scan", tool_call_id: original.tool_call_id, status: "success", content: JSON.stringify(value) });
    }
    const budget = protectedInput ? 4000 : 3000;
    const result = budgetResearchContext(state, input, budget);
    expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(budget);
    const shown = result.messages.find((message) => message.id === original.id) as ToolMessage;
    expect(shown.content).not.toContain(record.entry.summary);
    const body = (JSON.parse(shown.content as string) as { savedResearchReload: { savedResearchResults: { records: Array<{ id: string; latestRecord: unknown }> } } }).savedResearchReload.savedResearchResults;
    expect((body as typeof body & { requestedRowsNotPresented?: boolean }).requestedRowsNotPresented).toBe(protectedInput ? undefined : true);
    expect(body.records[0]!.id).toBe(record.id);
    expect(body.records[0]!.latestRecord).toMatchObject({ operation: "results", category: "research", recordIds: [record.id] });
    const page = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: describeResearchContextMessage(state, index)!.ref }, { maxPageBytes: 100000 });
    expect(page.ok && page.result.text === serializeResearchContextMessage(original)).toBe(true);
  }
});


test("an omitted latest inventory exposes a smaller selected query without discarding novel status or advancing past unseen rows", () => {
  const { state, append, inventory } = fixture();
  const coverage = [{ surfaceKey: "current-boundary", label: "Current boundary", state: "in_progress", rationale: "First receipt of this exact authority-boundary observation; preserve every byte while rows are omitted." }];
  const index = append({ operation: "results", category: "inventory", finalize: false, limit: 50 }, { ok: true, operation: "results", result: {
    version: "security-scan-v1", status: { ...status, coverage }, records: [], codeEvidence: [], observations: [], inventory,
    nextCursor: "current-inventory-next", reportReady: false,
  } });
  const canonical = JSON.stringify(state.messages);
  const original = state.messages[index] as ToolMessage;
  const input = [new SystemMessage("Preserve useful source and all exact new status information."), ...state.messages];
  const result = budgetResearchContext(state, input, 4000);
  const body = inventoryResult(state, result.messages, index) as ReturnType<typeof inventoryResult> & { requestedRowsNotPresented?: boolean };
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(4000);
  expect(body.requestedRowsNotPresented).toBe(true);
  expect(Array.isArray(body.inventory)).toBe(false);
  expect(body.nextCursor).toBe("current-inventory-next");
  expect(body.status).toMatchObject({ coverage });
  const ref = describeResearchContextMessage(state, index)!.ref;
  expect(result.recovery?.pendingRefs).toContain(ref);
  const exact = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: ref }, { maxPageBytes: 100000 });
  expect(exact.ok && exact.result.text).toBe(serializeResearchContextMessage(original)!);
  expect(JSON.stringify(state.messages)).toBe(canonical);
  // Reissuing the selected query with a smaller row count must not advance
  // to its old next cursor; continuation applies only after reading a page.
  const query = { version: "security-scan-v1", operation: "results", category: "inventory", finalize: false, limit: 1 };
  const initial = normalizeSecurityScanOperationArgs(query, { nextResultsCursor: "current-inventory-next" });
  expect(securityScanOperationSchema.safeParse(initial).success).toBe(true);
  expect(initial["cursor"]).toBeUndefined();
  expect(initial["limit"]).toBe(1);
  const next = normalizeSecurityScanOperationArgs({ ...query, continueResults: true }, { nextResultsCursor: "smaller-page-next" });
  expect(next["cursor"]).toBe("smaller-page-next");
  expect(next["category"]).toBe(initial["category"]);
});
