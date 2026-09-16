import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { NautiloState } from "../../src/agent/state";
import { localToolControlFailure, researchControlErrors, outstandingResearchToolErrors } from "../../src/tools/security/research-control-feedback";
import { budgetResearchContext, currentResearchContextRecovery, restoreResearchContextControlCycle, researchRuntimeRecoveryFacts } from "../../src/tools/security/research-context-rollover";
import { describeResearchContextIndex, describeResearchContextMessage, readResearchContext, serializeResearchContextMessage } from "../../src/tools/security/research-context";
import { buildNoProgressKey } from "../../src/graph/no-progress";
import { estimateTokenCount } from "../../src/utils/history-manager";

function fixture() {
  const state = { messages: [new HumanMessage("Audit the complete repository."),
    new AIMessage({ id: "source-ai", content: "", tool_calls: [{ id: "source-call", name: "file", args: { command: "read", path: "source.ts" } }] }),
    new ToolMessage({ id: "source-result", tool_call_id: "source-call", name: "file", status: "success", content: "SOURCE BYTE 🦀\n".repeat(6000) })],
    userId: "owner", currentTaskId: "11111111-1111-4111-8111-111111111111", currentTaskRunId: "22222222-2222-4222-8222-222222222222",
    subagentRun: true, toolWhitelist: ["file", "security_scan"], researchContextPageBytes: null, researchContextRecovery: null } as unknown as NautiloState;
  state.researchContextRecovery = { taskRunId: state.currentTaskRunId!, throughIndex: 2, indexRef: describeResearchContextIndex(state, 2)!.ref,
    pendingRefs: [describeResearchContextMessage(state, 2)!.ref] };
  return state;
}
function failure(state: NautiloState, name: string, args: Record<string, unknown>, content?: string) {
  const id = `call:${state.messages.length}`;
  const call = new AIMessage({ id: `ai:${id}`, content: "", tool_calls: [{ id, name, args }] });
  const error = new ToolMessage({ id: `tm:${id}`, tool_call_id: id, name, status: "error", additional_kwargs: { nautilo_tool_status: "error" },
    content: content ?? localToolControlFailure(name, args, "invalid_request", "Correct the complete record and retry; it was not dispatched.") });
  state.messages.push(call, error); return { call, error };
}
const prepared = (state: NautiloState): BaseMessage[] => [new SystemMessage("Review source; save complete notes and unfinished work."), ...state.messages];

function acceptedEvidence(state: NautiloState, summary: string) {
  acceptedEntry(state, { kind: "evidence", summary, evidenceRefs: [] });
}
function acceptedEntry(state: NautiloState, entry: Record<string, unknown>) {
  const id = `accepted-${state.messages.length}`;
  const author = { taskId: state.currentTaskId, taskRunId: state.currentTaskRunId, modelId: "openrouter:z-ai/glm-5.3" };
  state.messages.push(new AIMessage({ id: `ai:${id}`, content: "", tool_calls: [{ id, name: "security_scan", args: { operation: "record", action: "append", entry } }] }),
    new ToolMessage({ id: `tm:${id}`, tool_call_id: id, name: "security_scan", status: "success", content: JSON.stringify({ ok: true, operation: "record", result: {
      codeEvidence: [], record: { id, revision: 1, entry, createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", createdBy: author, updatedBy: author },
    } }) }));
}

const checkpoint = (state: NautiloState) => acceptedEntry(state, { kind: "checkpoint", summary: "Saved other observations and remaining work.",
  nextWork: "Continue the module review", openRecordIds: [], evidenceRefs: [] });

test("first rollover discovers every rejected draft across unrelated checkpoints and already-windowed history", () => {
  const state = fixture(); state.researchContextRecovery = null;
  const first = failure(state, "security_scan", { operation: "record", entry: { kind: "evidence", summary: "First distinct unsaved trace. ".repeat(1200) } });
  const second = failure(state, "security_scan", { operation: "record", entry: { kind: "evidence", summary: "Second distinct unsaved trace. ".repeat(1200) } });
  checkpoint(state);
  const canonical = JSON.stringify(state.messages);
  const refs = [first, second].map(({ call }) => describeResearchContextMessage(state, state.messages.indexOf(call))!.ref);
  expect(outstandingResearchToolErrors(state.messages)).toHaveLength(2);
  const omitted = [prepared(state)[0]!, state.messages[0]!, ...state.messages.slice(-2)];
  const firstBudget = budgetResearchContext(state, omitted, 4000);
  for (const ref of refs) expect(firstBudget.recovery?.pendingRefs).toContain(ref);
  const restored = restoreResearchContextControlCycle(state, omitted);
  expect(restored).toContain(first.error); expect(restored).toContain(second.error);
  const withCorrections = budgetResearchContext(state, restored, 4000);
  for (const ref of refs) expect(withCorrections.recovery?.pendingRefs).toContain(ref);
  expect(withCorrections.messages).toContain(first.error); expect(withCorrections.messages).toContain(second.error);
  expect(estimateTokenCount(withCorrections.messages)).toBeLessThanOrEqual(4000);
  expect(JSON.stringify(state.messages)).toBe(canonical);
});

test("a rejected draft resolves only after contiguous exact recovery and a subsequent checkpoint", () => {
  const state = fixture(); state.researchContextRecovery = null;
  const draft = failure(state, "security_scan", { operation: "record", entry: { kind: "evidence", summary: "Unsaved causal trace 🦀. ".repeat(30) } });
  const ref = describeResearchContextMessage(state, state.messages.indexOf(draft.call))!.ref;
  const read = (contextCursor?: string) => {
    const args = { version: "security-scan-v1", operation: "context", contextRef: ref, ...(contextCursor ? { contextCursor } : {}) };
    const page = readResearchContext(state, args, { maxPageBytes: 20000 });
    if (!page.ok) throw Error(page.error.message);
    const id = `recovered-${state.messages.length}`;
    state.messages.push(new AIMessage({ id: `${id}-ai`, content: "", tool_calls: [{ id, name: "security_scan", args }] }),
      new ToolMessage({ id: `${id}-result`, name: "security_scan", tool_call_id: id, status: "success", content: JSON.stringify(page) }));
    return state.messages.length - 1;
  };
  checkpoint(state);
  const prefix = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: ref, contextBytes: 100 }, { maxPageBytes: 20000 });
  if (!prefix.ok || !prefix.result.nextCursor) throw Error("Expected an unpersisted prefix with exact continuation");
  read(prefix.result.nextCursor); checkpoint(state);
  expect(restoreResearchContextControlCycle(state, prepared(state).slice(0, 2))).toContain(draft.error);
  const complete = read();
  expect(restoreResearchContextControlCycle(state, prepared(state).slice(0, 2))).toContain(draft.error);
  checkpoint(state);
  expect(restoreResearchContextControlCycle(state, prepared(state).slice(0, 2))).not.toContain(draft.error);
  state.researchContextRecovery = { taskRunId: state.currentTaskRunId!, throughIndex: complete,
    indexRef: describeResearchContextIndex(state, complete)!.ref, pendingRefs: [ref], unpresentedReadIndices: [complete] };
  expect(restoreResearchContextControlCycle(state, prepared(state).slice(0, 2))).toContain(draft.error);
});

test("an oversized rejected handoff report remains required across a later checkpoint", () => {
  const state = fixture(); state.researchContextRecovery = null;
  const draft = failure(state, "security_scan", { operation: "handoff", role: "reviewer", reportDraft: "Unsaved complete report and caveats. ".repeat(1600) });
  checkpoint(state);
  const ref = describeResearchContextMessage(state, state.messages.indexOf(draft.call))!.ref;
  const result = budgetResearchContext(state, restoreResearchContextControlCycle(state, prepared(state)), 4000);
  expect(result.recovery?.pendingRefs).toContain(ref);
  expect(result.messages).toContain(draft.error);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(4000);
});

test("individually fitting rejected drafts share the complete correction budget", () => {
  const state = fixture(); state.researchContextRecovery = null;
  const drafts = Array.from({ length: 5 }, (_, index) => failure(state, "security_scan", { operation: "record",
    entry: { kind: "evidence", summary: `Independent unsaved ${index} `.repeat(120), evidenceRefs: [] } }));
  const canonical = JSON.stringify(state.messages);
  const result = budgetResearchContext(state, restoreResearchContextControlCycle(state, prepared(state)), 4000);
  for (const draft of drafts) {
    expect(result.messages).toContain(draft.error);
    expect(result.recovery?.pendingRefs).toContain(describeResearchContextMessage(state, state.messages.indexOf(draft.call))!.ref);
  }
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(4000);
  expect(JSON.stringify(state.messages)).toBe(canonical);
});

test("an unrelated accepted note cannot hide the rejected draft's correction", () => {
  const state = fixture();
  const rejected = failure(state, "security_scan", { operation: "record", entry: { kind: "evidence", summary: "Comprehensive unsaved trace", evidenceRefs: [] } });
  const draftRef = describeResearchContextMessage(state, state.messages.indexOf(rejected.call))!.ref;
  state.researchContextRecovery!.pendingRefs.push(draftRef);
  acceptedEvidence(state, "An unrelated small router note.");
  failure(state, "security_scan", { operation: "context", continueContext: true });
  expect(outstandingResearchToolErrors(state.messages).some((item) => item.index === state.messages.indexOf(rejected.error))).toBe(true);
  const restored = restoreResearchContextControlCycle(state, prepared(state).slice(0, 2));
  expect(restored).toContain(rejected.call); expect(restored).toContain(rejected.error);
  acceptedEvidence(state, "Comprehensive unsaved trace");
  expect(outstandingResearchToolErrors(state.messages).some((item) => item.index === state.messages.indexOf(rejected.error))).toBe(false);
  // Pure call metadata whose exact entry was accepted requires no reread;
  // the original bytes remain available without implying semantic coverage.
  expect(currentResearchContextRecovery(state)?.pendingRefs).not.toContain(draftRef);
  expect(describeResearchContextMessage(state, state.messages.indexOf(rejected.call))!.ref).toBe(draftRef);
});

test("accepting an exact entry cannot discard additional visible reasoning in its rejected AI message", () => {
  const state = fixture();
  const rejected = failure(state, "security_scan", { operation: "record", entry: { kind: "evidence", summary: "Saved trace", evidenceRefs: [] } });
  rejected.call.content = "Additional unsaved reasoning and unresolved contradictions.";
  const ref = describeResearchContextMessage(state, state.messages.indexOf(rejected.call))!.ref;
  state.researchContextRecovery!.pendingRefs.push(ref);
  acceptedEvidence(state, "Saved trace");
  expect(currentResearchContextRecovery(state)?.pendingRefs).toContain(ref);
  checkpoint(state); state.researchContextRecovery = null;
  const result = budgetResearchContext(state, [prepared(state)[0]!, state.messages[0]!, ...state.messages.slice(-2)], 4000);
  expect(result.recovery?.pendingRefs).toContain(ref);
});

test("exact accepted authored arguments retire draft debt when Desktop adds minted evidence references", () => {
  const state = fixture();
  const rejected = failure(state, "security_scan", { operation: "record", entry: { kind: "evidence", summary: "Source-bound accepted trace", evidenceRefs: [] } });
  const ref = describeResearchContextMessage(state, state.messages.indexOf(rejected.call))!.ref;
  state.researchContextRecovery!.pendingRefs.push(ref);
  acceptedEvidence(state, "Source-bound accepted trace");
  const receipt = state.messages.at(-1)! as ToolMessage;
  const accepted = JSON.parse(receipt.content as string) as { result: { record: { entry: { evidenceRefs: Array<{ kind: string; id: string }> } } } };
  accepted.result.record.entry.evidenceRefs = [{ kind: "code_evidence", id: "desktop_minted" }];
  receipt.content = JSON.stringify(accepted);
  expect(outstandingResearchToolErrors(state.messages)).toHaveLength(0);
  expect(currentResearchContextRecovery(state)?.pendingRefs).not.toContain(ref);
  expect(serializeResearchContextMessage(rejected.call)).toContain("Source-bound accepted trace");
});

test("rejected substantive draft and exact correction survive later context failures; only control receipt debt is optional", () => {
  const state = fixture();
  const draft = failure(state, "security_scan", { version: "security-scan-v1", operation: "record", action: "append",
    entry: { kind: "evidence", summary: "Unsaved causal source analysis.\n".repeat(90) } });
  const draftIndex = state.messages.indexOf(draft.call);
  const draftRef = describeResearchContextMessage(state, draftIndex)!.ref;
  const errorRef = describeResearchContextMessage(state, draftIndex + 1)!.ref;
  state.researchContextRecovery!.pendingRefs.push(draftRef, errorRef);
  const later = failure(state, "security_scan", { operation: "context", continueContext: true });
  const canonical = JSON.stringify(state.messages);
  const restored = restoreResearchContextControlCycle(state, prepared(state).slice(0, 2));
  const budget = budgetResearchContext(state, restored, 4000);
  const shownDraft = budget.messages.find((message) => message.id === draft.call.id) as AIMessage;
  expect(shownDraft.tool_calls).toEqual(draft.call.tool_calls);
  expect(shownDraft.content).toContain(draft.call.content as string);
  expect(budget.messages).toContain(draft.error);
  expect(budget.messages).toContain(later.call); expect(budget.messages).toContain(later.error);
  expect(budget.recovery?.pendingRefs).toContain(draftRef);
  expect(budget.recovery?.pendingRefs).not.toContain(errorRef);
  expect(estimateTokenCount(budget.messages)).toBeLessThanOrEqual(4000);
  expect(JSON.stringify(state.messages)).toBe(canonical);
  const exact = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: draftRef }, { maxPageBytes: 16000 });
  expect(exact.ok).toBe(true);
  if (exact.ok) expect(exact.result.text).toBe(serializeResearchContextMessage(draft.call)!);
});

test("known legacy blocked-file and record-validation receipts recover without exempting unknown errors or drafts", () => {
  const state = fixture();
  const blocked = "Recovered 0 verified historical bytes. Context recovery is active. Recover pending historical pages, save material notes and a checkpoint through security_scan, then continue this same audit. New investigation and finalization have not executed.";
  const known = failure(state, "file", { command: "read", path: "not-read.ts" }, blocked);
  const record = failure(state, "security_scan", { operation: "record", entry: { kind: "evidence", summary: "Unsaved draft" } },
    "Error: security_scan received invalid arguments (entry.summary: Too big: expected string to have <=2000 characters; entry: appends require a complete kind-valid entry). Correct the listed fields and retry the record operation once. Do not send scanId; the server binds this TaskRun to its scan. Do not start, finalize, or reopen a scan because this validation failure was not dispatched.");
  const unknown = failure(state, "file", { command: "read", path: "other.ts" }, blocked + " Additional unknown diagnostic/source.");
  for (const message of [known.error, record.error, record.call, unknown.error]) state.researchContextRecovery!.pendingRefs.push(describeResearchContextMessage(state, state.messages.indexOf(message))!.ref);
  expect(researchControlErrors(state.messages).map((receipt) => receipt.index)).toEqual([state.messages.indexOf(known.error), state.messages.indexOf(record.error)]);
  const pending = currentResearchContextRecovery(state)!.pendingRefs;
  expect(pending).not.toContain(describeResearchContextMessage(state, state.messages.indexOf(known.error))!.ref);
  expect(pending).not.toContain(describeResearchContextMessage(state, state.messages.indexOf(record.error))!.ref);
  expect(pending).toContain(describeResearchContextMessage(state, state.messages.indexOf(record.call))!.ref);
  expect(pending).toContain(describeResearchContextMessage(state, state.messages.indexOf(unknown.error))!.ref);
});

test("large successful siblings stay exactly recoverable while the normalized failed call and error remain visible", () => {
  const state = fixture();
  const rejected = failure(state, "security_scan", { operation: "record", entry: { kind: "evidence", summary: "Save this draft." } });
  rejected.call.tool_calls!.push({ id: "sibling", name: "file", args: { command: "read", path: "large.ts" } });
  const sibling = new ToolMessage({ id: "sibling-result", tool_call_id: "sibling", name: "file", status: "success", content: "FRESH SIBLING SOURCE\n".repeat(9000) });
  state.messages.push(sibling);
  const canonical = JSON.stringify(state.messages);
  const result = budgetResearchContext(state, restoreResearchContextControlCycle(state, prepared(state).slice(0, 2)), 4000);
  const shownDraft = result.messages.find((message) => message.id === rejected.call.id) as AIMessage;
  expect(shownDraft.tool_calls).toEqual(rejected.call.tool_calls);
  expect(shownDraft.content).toContain(rejected.call.content as string);
  expect(result.messages).toContain(rejected.error);
  expect(result.messages.some((m) => ToolMessage.isInstance(m) && m.tool_call_id === "sibling")).toBe(true);
  expect(result.messages).not.toContain(sibling);
  expect(result.recovery?.pendingRefs).toContain(describeResearchContextMessage(state, state.messages.indexOf(sibling))!.ref);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(4000);
  expect(JSON.stringify(state.messages)).toBe(canonical);
});

test("typed correction pairing rejects mismatched operation, tool and unknown codes", () => {
  for (const changed of [{ toolName: "other" }, { requestedOperation: "results" }, { error: { code: "unknown", message: "Unknown", retryable: false } }]) {
    const state = fixture(); const args = { operation: "record", entry: { summary: "Unsaved" } };
    const value = JSON.parse(localToolControlFailure("security_scan", args, "invalid_request", "Repair record.")) as Record<string, unknown>;
    failure(state, "security_scan", args, JSON.stringify({ ...value, ...changed }));
    expect(researchControlErrors(state.messages)).toHaveLength(0);
  }
});

test("globally repeated call IDs or duplicate receipts cannot qualify any control exemption", () => {
  for (const duplicate of ["call", "receipt"] as const) {
    const state = fixture();
    const first = failure(state, "security_scan", { operation: "record", entry: { summary: "Unsaved first draft" } });
    if (duplicate === "call") {
      state.messages.push(new AIMessage({ id: "later-ai", content: "Different unsaved material", tool_calls: first.call.tool_calls ?? [] }));
    } else {
      state.messages.push(new ToolMessage({ id: "later-receipt", tool_call_id: first.error.tool_call_id, name: "security_scan", status: "error", content: first.error.content }));
    }
    expect(researchControlErrors(state.messages)).toHaveLength(0);
    const ref = describeResearchContextMessage(state, state.messages.indexOf(first.error))!.ref;
    state.researchContextRecovery!.pendingRefs.push(ref);
    expect(currentResearchContextRecovery(state)?.pendingRefs).toContain(ref);
  }
});

test("typed file control errors ignore volatile runtime counters but retain real recovered-byte progress", () => {
  const state = fixture(); const args = { command: "read", path: "later.ts" };
  const first = { toolName: "file", args, status: "error" as const, errorContent: localToolControlFailure("file", args, "context_recovery_pending",
    "Recovered 0 verified historical bytes. Save a checkpoint.", researchRuntimeRecoveryFacts(state)) };
  const later = { ...first, errorContent: localToolControlFailure("file", args, "context_recovery_pending",
    "Recovered 0 verified historical bytes. Save a checkpoint.", { ...researchRuntimeRecoveryFacts(state), asOfMessageIndex: 999 }) };
  expect(buildNoProgressKey(later)).toEqual(buildNoProgressKey(first));
  expect(buildNoProgressKey({ ...later, errorContent: later.errorContent.replace("Recovered 0", "Recovered 123") })).not.toEqual(buildNoProgressKey(first));
});
