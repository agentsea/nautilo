import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { projectSecurityScanCardResult } from "@nautilo/types";
import type { NautiloState } from "../../src/agent/state";
import { describeResearchContextIndex, describeResearchContextMessage, readResearchContext, replayResearchContextReceipt, serializeResearchContextMessage } from "../../src/tools/security/research-context";
import { budgetResearchContext, currentResearchContextRecovery, researchContextRecoveryToolError, researchRuntimeRecoveryFacts } from "../../src/tools/security/research-context-rollover";
import { estimateTokenCount } from "../../src/utils/history-manager";

const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openai:gpt-5.6-sol" };
function fixture() {
  const state = { messages: [new HumanMessage("Audit the source"),
    new AIMessage({ id: "original-call", content: "", tool_calls: [{ id: "source", name: "file", args: { command: "read", path: "identity/tokens.js", zone: "current" } }] }),
    new ToolMessage({ id: "original-result", name: "file", tool_call_id: "source", status: "success", content: "token source 🦀\n".repeat(4000) })],
    userId: "owner", currentTaskId: author.taskId, currentTaskRunId: author.taskRunId, subagentRun: true, toolWhitelist: ["file", "security_scan"],
    researchContextRecovery: null, researchContextPageBytes: null } as unknown as NautiloState;
  state.researchContextRecovery = { taskRunId: author.taskRunId, throughIndex: 2,
    indexRef: describeResearchContextIndex(state, 2)!.ref, pendingRefs: [describeResearchContextMessage(state, 2)!.ref] };
  return state;
}
function append(state: NautiloState, args: Record<string, unknown>, result: unknown) {
  const id = `page-${state.messages.length}`;
  state.messages.push(new AIMessage({ id: `ai-${id}`, content: "", tool_calls: [{ id, name: "security_scan", args }] }),
    new ToolMessage({ id: `tm-${id}`, name: "security_scan", tool_call_id: id, content: JSON.stringify(result), status: "success" }));
  return state.messages.length - 1;
}
function checkpoint(state: NautiloState) {
  const entry = { kind: "checkpoint", summary: "Consolidated the useful batch and retained the overall audit plan.", nextWork: "Trace the remaining token flows and compare prior evidence.", openRecordIds: [], evidenceRefs: [] };
  const id = `checkpoint-${state.messages.length}`;
  state.messages.push(new AIMessage({ content: "", tool_calls: [{ id, name: "security_scan", args: { version: "security-scan-v1", operation: "record", action: "append", entry } }] }),
    new ToolMessage({ name: "security_scan", tool_call_id: id, content: JSON.stringify({ ok: true, operation: "record", result: { codeEvidence: [], record: { id, revision: 1, createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z", createdBy: author, updatedBy: author, entry } } }) }));
}
const continuation = { version: "security-scan-v1", operation: "context", continueContext: true };

test("server continuation stays on substantive bytes across optional index lookup and exact replay ignores later navigation", () => {
  const state = fixture();
  const before = serializeResearchContextMessage(state.messages[2]!)!;
  const first = readResearchContext(state, continuation, { maxPageBytes: 2000, runtimeRecovery: researchRuntimeRecoveryFacts(state) });
  if (!first.ok) throw Error(first.error.message);
  append(state, continuation, first);
  const indexArgs = { version: "security-scan-v1", operation: "context", contextRef: state.researchContextRecovery!.indexRef };
  const navigation = readResearchContext(state, indexArgs, { maxPageBytes: 1200 });
  if (!navigation.ok) throw Error(navigation.error.message);
  append(state, indexArgs, navigation);
  const next = readResearchContext(state, continuation, { maxPageBytes: 2000 });
  if (!next.ok) throw Error(next.error.message);
  expect(next.result.contextRef).toBe(first.result.contextRef);
  expect(next.result.startByte).toBe(first.result.endByte);
  expect(next.result.resolvedSelection?.contextCursor).toBe(first.result.nextCursor ?? undefined);
  append(state, continuation, next);
  state.researchContextRecovery!.pendingRefs.reverse();
  expect(replayResearchContextReceipt(state, continuation, first)).toEqual(first);
  expect(replayResearchContextReceipt(state, continuation, next)).toEqual(next);
  expect(replayResearchContextReceipt({ ...state, currentTaskRunId: "other" }, continuation, next)).toBeNull();
  expect(replayResearchContextReceipt(state, { ...continuation, contextRef: indexArgs.contextRef }, next)).toBeNull();
  expect(serializeResearchContextMessage(state.messages[2]!)).toBe(before);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(2000);
});

test("a smaller-provider hole rewinds to the first unpresented byte even when a later page is complete", () => {
  const state = fixture();
  const first = readResearchContext(state, { ...continuation, contextBytes: 1000 }, { maxPageBytes: 3000 });
  if (!first.ok) throw Error(first.error.message);
  const lostIndex = append(state, { ...continuation, contextBytes: 1000 }, first);
  const final = readResearchContext(state, continuation, { maxPageBytes: 200000 });
  if (!final.ok) throw Error(final.error.message);
  expect(final.result.complete).toBe(true);
  append(state, continuation, final);
  state.researchContextRecovery!.unpresentedReadIndices = [lostIndex];
  const rewind = readResearchContext(state, continuation, { maxPageBytes: 3000 });
  if (!rewind.ok) throw Error(rewind.error.message);
  expect(rewind.result.startByte).toBe(0);
  expect(rewind.result.text).toBe(serializeResearchContextMessage(state.messages[2]!)!.slice(0, rewind.result.text.length));
  append(state, continuation, rewind);
  const next = readResearchContext(state, continuation, { maxPageBytes: 3000 });
  // Once the replayed prefix bridges the later verified range, the input is complete.
  expect(next).toMatchObject({ ok: false, error: { code: "context_complete" } });
});

test("legacy index-only debt clears with no source progress or checkpoint while its partial cursor remains readable", () => {
  const state = fixture();
  const index = describeResearchContextIndex(state, 2, false)!;
  state.researchContextRecovery = { taskRunId: author.taskRunId, throughIndex: 2, indexRef: index.ref, pendingRefs: [index.ref] };
  const args = { version: "security-scan-v1", operation: "context", contextRef: index.ref, contextBytes: 100 };
  const page = readResearchContext(state, args, { maxPageBytes: 1500 });
  if (!page.ok) throw Error(page.error.message);
  append(state, args, page);
  expect(page.result.complete).toBe(false);
  expect(currentResearchContextRecovery(state)).toBeNull();
  expect(researchRuntimeRecoveryFacts(state)).toMatchObject({ phase: "inactive", pendingInputCount: 0, recoveredInputBytes: 0, retainedUnconsolidatedPages: 0 });
  expect(researchContextRecoveryToolError(state, "file", { command: "read" })).toBeNull();
  expect(readResearchContext(state, { ...continuation, contextRef: index.ref }, { maxPageBytes: 1500 })).toMatchObject({ ok: true, result: { startByte: page.result.endByte } });
  // Removing index debt must not remove an actual unresolved source.
  state.researchContextRecovery.pendingRefs.push(describeResearchContextMessage(state, 2, false)!.ref);
  expect(currentResearchContextRecovery(state)?.pendingRefs).toEqual([describeResearchContextMessage(state, 2, false)!.ref]);
});

test("several source pages remain visible until actual pressure requests one useful consolidation handoff", () => {
  const state = fixture();
  const prepared = () => [new SystemMessage("Perform a thorough audit with evidence and a cumulative plan."), ...state.messages];
  let result = budgetResearchContext(state, prepared(), 8000);
  state.researchContextRecovery = result.recovery;
  const pages: BaseMessage[] = [];
  // Small pages are chosen deliberately; there must be no arbitrary one-page ritual.
  for (let index = 0; index < 3; index++) {
    expect(researchContextRecoveryToolError(state, "security_scan", continuation)).toBeNull();
    const args = { ...continuation, contextBytes: 200 };
    const page = readResearchContext(state, args, { maxPageBytes: result.pageBytes, runtimeRecovery: researchRuntimeRecoveryFacts(state) });
    if (!page.ok) throw Error(page.error.message);
    append(state, args, page); pages.push(state.messages.at(-1)!);
    result = budgetResearchContext(state, prepared(), 8000); state.researchContextRecovery = result.recovery;
    for (const retained of pages) expect(result.messages.some((message) => message.id === retained.id && message.content === retained.content)).toBe(true);
    expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(8000);
  }
  expect(researchRuntimeRecoveryFacts(state).retainedUnconsolidatedPages).toBe(3);
  // Use real assembled cost, keeping retained pages but leaving too little framing space.
  const tighterBudget = estimateTokenCount(result.messages) + 100;
  const tight = budgetResearchContext(state, result.messages, tighterBudget);
  state.researchContextRecovery = tight.recovery;
  expect(tight.recovery?.consolidationRequired).toBe(true);
  for (const retained of pages) expect(tight.messages.some((message) => message.id === retained.id && message.content === retained.content)).toBe(true);
  expect(researchContextRecoveryToolError(state, "security_scan", continuation)).toContain("needs consolidation");
  expect(researchContextRecoveryToolError(state, "security_scan", { ...continuation, contextRef: state.researchContextRecovery!.indexRef })).toBeNull();
  checkpoint(state);
  const resumed = budgetResearchContext(state, prepared(), 8000); state.researchContextRecovery = resumed.recovery;
  expect(researchContextRecoveryToolError(state, "security_scan", continuation)).toBeNull();
  expect(researchRuntimeRecoveryFacts(state).retainedUnconsolidatedPages).toBe(0);
});

test("file outcomes bind transport authority and legacy references preserve exact payload without upgrading unknown success", () => {
  const state = fixture();
  const result = state.messages[2] as ToolMessage;
  const canonical = serializeResearchContextMessage(result);
  const legacy = describeResearchContextMessage(state, 2, false)!.ref;
  result.status = "error";
  const failedRef = describeResearchContextMessage(state, 2)!.ref;
  const failed = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: failedRef }, { maxPageBytes: 2000 });
  if (!failed.ok) throw Error(failed.error.message);
  expect(failed.result.source).toMatchObject({ path: "identity/tokens.js", outcome: "error" });
  expect(readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: legacy }, { maxPageBytes: 2000 })).toMatchObject({ ok: true });
  result.status = "success";
  expect(readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: failedRef }, { maxPageBytes: 2000 })).toMatchObject({ ok: false, error: { code: "context_reference_stale" } });
  result.additional_kwargs["nautilo_tool_status"] = "error";
  expect(describeResearchContextMessage(state, 2)?.source?.outcome).toBe("error");
  delete result.additional_kwargs["nautilo_tool_status"];
  Reflect.deleteProperty(result, "status");
  expect(describeResearchContextMessage(state, 2)?.source?.outcome).toBe("unknown");
  expect(serializeResearchContextMessage(result)).toBe(canonical);
});

test("runtime facts survive context errors and card projection without navigation handles or source censorship", () => {
  const state = fixture();
  const runtimeRecovery = researchRuntimeRecoveryFacts(state);
  const error = readResearchContext(state, { ...continuation, contextCursor: "invalid" }, { maxPageBytes: 2000, runtimeRecovery });
  expect(error).toMatchObject({ ok: false, runtimeRecovery });
  const projected = projectSecurityScanCardResult(error)!;
  expect(projected.runtimeRecovery).toMatchObject({ phase: "reading", pendingInputCount: 1, recoveredInputBytes: 0 });
  expect(JSON.stringify(projected)).not.toContain(runtimeRecovery.nextContextRef!);
  const nav = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: state.researchContextRecovery!.indexRef }, { maxPageBytes: 10000 });
  const card = projectSecurityScanCardResult(nav)!;
  expect(card.context?.displayNotice).toContain("omits internal navigation handles");
  expect(card.context?.text).toContain("identity/tokens.js");
  expect(JSON.stringify(card)).not.toContain("research-context:");
  const source = readResearchContext(state, continuation, { maxPageBytes: 2000 });
  if (!source.ok) throw Error(source.error.message);
  expect(projectSecurityScanCardResult(source)?.context?.text).toBe(source.result.text);
});


test("an unmatched transformed result retains its known complete provider tool cycle alongside other recovery debt", () => {
  const state = fixture();
  const call = state.messages[1] as AIMessage;
  call.tool_calls!.push({ id: "sibling", name: "file", args: { command: "read", path: "sibling.js" } });
  const sibling = new ToolMessage({ id: "known-sibling", tool_call_id: "sibling", name: "file", content: "known sibling result" });
  state.messages.push(sibling, new AIMessage({ id: "unsaved-large", content: "Unsaved analysis needing exact recovery. ".repeat(3000) }));
  const transformed = new ToolMessage({ id: "unknown-transformed", name: "file", tool_call_id: "source", content: "Unmapped provider-visible result with unique bytes." });
  const prepared = [new SystemMessage("Audit"), state.messages[0]!, call, transformed, sibling, state.messages.at(-1)!];
  const budgeted = budgetResearchContext(state, prepared, 4000);
  expect(budgeted.recovery?.pendingRefs).toContain(describeResearchContextMessage(state, state.messages.length - 1)!.ref);
  expect(estimateTokenCount(budgeted.messages)).toBeLessThanOrEqual(4000);
  const cycle = budgeted.messages.slice(budgeted.messages.indexOf(call), budgeted.messages.indexOf(call) + 3);
  expect(cycle).toEqual([call, transformed, sibling]);
  expect(state.messages).not.toContain(transformed);
});
