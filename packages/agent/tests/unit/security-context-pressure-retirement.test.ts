import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { NautiloState } from "../../src/agent/state";
import { localToolControlFailure } from "../../src/tools/security/research-control-feedback";
import { budgetResearchContext, currentResearchContextRecovery, researchRuntimeRecoveryFacts, restoreResearchContextControlCycle } from "../../src/tools/security/research-context-rollover";
import { describeResearchContextIndex, describeResearchContextMessage, readResearchContext, serializeResearchContextMessage } from "../../src/tools/security/research-context";

function pair(state: NautiloState, args: Record<string, unknown>, content: string, status: "success" | "error" = "success", prose = "") {
  const id = `call-${state.messages.length}`;
  const call = new AIMessage({ id: `ai-${id}`, content: prose, tool_calls: [{ id, name: "security_scan", args }] });
  const receipt = new ToolMessage({ id: `tm-${id}`, tool_call_id: id, name: "security_scan", status, content });
  state.messages.push(call, receipt);
  return { call, receipt };
}
function page(state: NautiloState) {
  const args = { version: "security-scan-v1" as const, operation: "context" as const, contextRef: state.researchContextRecovery!.pendingRefs[0]!, contextBytes: 128 };
  const result = readResearchContext(state, args, { maxPageBytes: 4000 });
  if (!result.ok) throw Error(`Fixture page failed: ${result.error.code}`);
  pair(state, args, JSON.stringify(result));
}
function checkpoint(state: NautiloState, kind = "checkpoint", authorRun = state.currentTaskRunId, status: "success" | "error" = "success") {
  const entry = kind === "checkpoint" ? { kind, summary: "Consolidated the presented batch; prior findings remain open.", nextWork: "Read remaining input, then resume review units.", openRecordIds: [], evidenceRefs: [] }
    : { kind, summary: "Another evidence note.", evidenceRefs: [] };
  const author = { taskId: state.currentTaskId, taskRunId: authorRun, modelId: "openrouter:z-ai/glm-5.3" };
  return pair(state, { operation: "record", action: "append", entry }, JSON.stringify({ ok: true, operation: "record", result: { codeEvidence: [], record: {
    id: `checkpoint-${state.messages.length}`, revision: 1, entry, createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", createdBy: author, updatedBy: author,
  } } }), status);
}
function pressure(state: NautiloState, code: "context_recovery_pending" | "invalid_request" = "context_recovery_pending", phase: "reading" | "consolidation_required" = "consolidation_required") {
  const args = { operation: "context", continueContext: true };
  return pair(state, args, localToolControlFailure("security_scan", args, code,
    "The current model workspace needs consolidation before another context page can fit. Save useful notes and a cumulative checkpoint in this model turn.",
    { phase, pendingInputCount: 1, recoveredInputBytes: 128, retainedUnconsolidatedPages: phase === "reading" ? 0 : 1, asOfMessageIndex: state.messages.length, nextContextRef: state.researchContextRecovery!.pendingRefs[0]! }), "error", "I will recover the remaining input after saving useful notes.");
}
function fixture() {
  const state = { messages: [new HumanMessage("Audit the complete repository."),
    new AIMessage({ id: "source-call", content: "", tool_calls: [{ id: "source", name: "file", args: { command: "read", path: "tokens.ts" } }] }),
    new ToolMessage({ id: "source-result", tool_call_id: "source", name: "file", status: "success", content: "Original source bytes 🦀\n".repeat(300) })],
    userId: "owner", currentTaskId: "11111111-1111-4111-8111-111111111111", currentTaskRunId: "22222222-2222-4222-8222-222222222222",
    subagentRun: true, toolWhitelist: ["file", "security_scan"], researchContextPageBytes: 4000, researchContextRecovery: null } as unknown as NautiloState;
  state.researchContextRecovery = { taskRunId: state.currentTaskRunId!, throughIndex: 2, indexRef: describeResearchContextIndex(state, 2)!.ref,
    pendingRefs: [describeResearchContextMessage(state, 2)!.ref] };
  page(state);
  state.researchContextRecovery.consolidationRequired = true;
  return state;
}
function windowed(state: NautiloState): BaseMessage[] {
  return [new SystemMessage("Audit source and retain detailed evidence."), state.messages[0]!, ...state.messages.slice(-2)];
}

test("GLM8 pressure correction retires after an accepted checkpoint releases the current workspace", () => {
  const state = fixture();
  const blocked = pressure(state);
  expect(researchRuntimeRecoveryFacts(state).phase).toBe("consolidation_required");
  expect(restoreResearchContextControlCycle(state, windowed(state).slice(0, 2))).toContain(blocked.receipt);
  checkpoint(state);
  const canonical = JSON.stringify(state.messages);
  const pending = currentResearchContextRecovery(state)!.pendingRefs;
  expect(researchRuntimeRecoveryFacts(state).phase).toBe("reading");
  const restored = restoreResearchContextControlCycle(state, windowed(state));
  expect(restored).not.toContain(blocked.receipt);
  expect(restored).not.toContain(blocked.call);
  const budget = budgetResearchContext(state, restored, 8000);
  expect(budget.messages).not.toContain(blocked.receipt);
  expect(budget.recovery?.pendingRefs).toEqual(pending);
  expect(JSON.stringify(state.messages)).toBe(canonical);
  expect(serializeResearchContextMessage(blocked.call)).toContain("after saving useful notes");
  const exact = readResearchContext(state, { operation: "context", version: "security-scan-v1", contextRef: describeResearchContextMessage(state, 2)!.ref }, { maxPageBytes: 20000 });
  expect(exact.ok && exact.result.text).toBe(serializeResearchContextMessage(state.messages[2]!)!);
});

test("failed, foreign, unrelated and pre-error checkpoints cannot retire pressure feedback", () => {
  for (const variant of ["failed", "foreign", "evidence", "before"] as const) {
    const state = fixture();
    if (variant === "before") checkpoint(state);
    const blocked = pressure(state);
    if (variant !== "before") checkpoint(state, variant === "evidence" ? "evidence" : "checkpoint",
      variant === "foreign" ? "33333333-3333-4333-8333-333333333333" : state.currentTaskRunId, variant === "failed" ? "error" : "success");
    expect(restoreResearchContextControlCycle(state, windowed(state).slice(0, 2))).toContain(blocked.receipt);
  }
});

test("stale or wrong-run recovery is not evidence that consolidation completed", () => {
  for (const variant of ["index", "run"] as const) {
    const state = fixture(); const blocked = pressure(state); checkpoint(state);
    if (variant === "index") state.researchContextRecovery!.indexRef = `research-index:2:${"0".repeat(64)}`;
    else state.researchContextRecovery!.taskRunId = "33333333-3333-4333-8333-333333333333";
    expect(currentResearchContextRecovery(state)).toBeNull();
    expect(restoreResearchContextControlCycle(state, windowed(state))).toContain(blocked.receipt);
  }
});

test("a newly pressured or unconsolidated workspace keeps its actionable correction", () => {
  const state = fixture(); const blocked = pressure(state); checkpoint(state);
  page(state); state.researchContextRecovery!.consolidationRequired = true;
  expect(researchRuntimeRecoveryFacts(state).phase).toBe("consolidation_required");
  expect(restoreResearchContextControlCycle(state, [...windowed(state).slice(0, 2), blocked.call, blocked.receipt])).toContain(blocked.receipt);
  const latest = pressure(state); checkpoint(state);
  expect(restoreResearchContextControlCycle(state, windowed(state))).not.toContain(latest.receipt);
  const next = pressure(state);
  expect(restoreResearchContextControlCycle(state, windowed(state).slice(0, 2))).toContain(next.receipt);
});

test("checkpoint does not retire validation, generic recovery blocks, unknown errors or rejected prose drafts", () => {
  for (const variant of ["validation", "reading", "unknown", "draft"] as const) {
    const state = fixture();
    const args = { operation: "record", entry: { kind: "evidence", summary: "Rejected full causal analysis and counterevidence." } };
    const rejected = variant === "validation" ? pressure(state, "invalid_request") : variant === "reading" ? pressure(state, "context_recovery_pending", "reading")
      : variant === "unknown" ? pair(state, { operation: "context" }, "Unknown source or control failure.", "error")
        : pair(state, args, localToolControlFailure("security_scan", args, "invalid_request", "Correct the rejected draft."), "error", "Additional unsaved reasoning.");
    checkpoint(state);
    const restored = restoreResearchContextControlCycle(state, windowed(state));
    expect(restored).toContain(rejected.call); expect(restored).toContain(rejected.receipt);
  }
});

test("naturally retained pressure feedback is explicitly superseded without changing its historical error outcome", () => {
  const state = fixture(); const blocked = pressure(state); const accepted = checkpoint(state);
  const canonical = JSON.stringify(state.messages);
  const restored = restoreResearchContextControlCycle(state, [new SystemMessage("Audit"), ...state.messages]);
  const projected = restored.find((message) => message.id === blocked.receipt.id) as ToolMessage;
  expect(projected.status).toBe("error"); expect(projected.tool_call_id).toBe(blocked.receipt.tool_call_id);
  const value = (JSON.parse(projected.content as string) as { contextControlFeedback: {
    exactHistoricalReceipt: { contextRef: string }; supersededByCheckpoint: { contextRef: string };
  } }).contextControlFeedback;
  expect(value).toMatchObject({ superseded: true, notDispatched: true, historicalOutcome: "error", runtimeRecovery: { phase: "reading" } });
  expect(value.exactHistoricalReceipt.contextRef).toBe(describeResearchContextMessage(state, state.messages.indexOf(blocked.receipt))!.ref);
  expect(value.supersededByCheckpoint.contextRef).toBe(describeResearchContextMessage(state, state.messages.indexOf(accepted.receipt))!.ref);
  expect(projected.content).not.toContain("Save useful notes and a cumulative checkpoint in this model turn.");
  expect(JSON.stringify(state.messages)).toBe(canonical);
});

test("superseded pressure in a rejected draft's sibling batch keeps exact draft/prose and valid tool pairing", () => {
  const state = fixture(); const blocked = pressure(state);
  const args = { operation: "record", entry: { kind: "evidence", summary: "Unsaved complete causal trace and counterevidence." } };
  blocked.call.tool_calls!.push({ id: "draft-sibling", name: "security_scan", args });
  const rejected = new ToolMessage({ id: "draft-result", name: "security_scan", tool_call_id: "draft-sibling", status: "error",
    content: localToolControlFailure("security_scan", args, "invalid_request", "Preserve and correct the rejected draft.") });
  state.messages.push(rejected); checkpoint(state);
  const canonical = JSON.stringify(state.messages);
  const restored = restoreResearchContextControlCycle(state, windowed(state));
  expect(restored).toContain(blocked.call); expect(restored).toContain(rejected);
  expect(blocked.call.content).toContain("after saving useful notes");
  const projected = restored.find((message) => message.id === blocked.receipt.id) as ToolMessage;
  expect(projected.status).toBe("error");
  expect(JSON.parse(projected.content as string) as unknown).toMatchObject({ contextControlFeedback: { superseded: true } });
  expect(restored.filter(ToolMessage.isInstance).filter((message) => blocked.call.tool_calls!.some((call) => call.id === message.tool_call_id))).toHaveLength(2);
  const budget = budgetResearchContext(state, restored, 8000);
  const preparedCall = budget.messages.find((message) => message.id === blocked.call.id) as AIMessage;
  expect(preparedCall.tool_calls).toEqual(blocked.call.tool_calls);
  expect(preparedCall.content).toContain(blocked.call.content as string);
  expect(budget.messages).toContain(rejected);
  expect(budget.messages.find((message) => message.id === projected.id)?.content).not.toContain("Save useful notes and a cumulative checkpoint in this model turn.");
  expect(JSON.stringify(state.messages)).toBe(canonical);
});

test("a colliding message ID cannot project a different call or tool as superseded", () => {
  const state = fixture(); const blocked = pressure(state); checkpoint(state);
  for (const mismatch of [{ name: "file", tool_call_id: blocked.receipt.tool_call_id }, { name: "security_scan", tool_call_id: "unmatched" }]) {
    const unrelated = new ToolMessage({ id: blocked.receipt.id!, ...mismatch, content: "Independent unrecovered diagnostic.", status: "error" });
    expect(restoreResearchContextControlCycle(state, [...windowed(state), unrelated])).toContain(unrelated);
  }
});
