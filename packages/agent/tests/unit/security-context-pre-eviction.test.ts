import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { NautiloState } from "../../src/agent/state";
import { assertMessageInvariants } from "@nautilo/message-invariants";
import { budgetResearchContext, captureResearchContextPresentation, currentResearchContextRecovery, researchContextRecoveryToolError } from "../../src/tools/security/research-context-rollover";
import { describeResearchContextMessage, readResearchContext } from "../../src/tools/security/research-context";
import { estimateTokenCount } from "../../src/utils/history-manager";

const owner = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openrouter:z-ai/glm-5.3" };
const system = new SystemMessage("Inspect the authorized source and save substantive findings and unresolved work.");
function call(state: NautiloState, name: string, args: Record<string, unknown>, content: string, status: "success" | "error" = "success") {
  const id = `call-${state.messages.length}`;
  state.messages.push(new AIMessage({ id: `ai-${id}`, content: "", tool_calls: [{ id, name, args }] }),
    new ToolMessage({ id: `tm-${id}`, name, tool_call_id: id, content, status }));
}
function fixture() {
  const state = { userId: "owner", currentTaskId: owner.taskId, currentTaskRunId: owner.taskRunId,
    subagentRun: true, toolWhitelist: ["file", "security_scan"], researchContextRecovery: null,
    messages: [new HumanMessage("Audit the authorized repository.")] } as unknown as NautiloState;
  call(state, "file", { command: "read", path: "auth.js", zone: "current" }, "exact inspected source αβ\n".repeat(150));
  const old = state.messages.at(-1)!;
  const oldRef = describeResearchContextMessage(state, 2)!.ref;
  state.researchContextPresentation = captureResearchContextPresentation(state, [system, ...state.messages]);
  call(state, "file", { command: "read", path: "routes.js", zone: "current" }, "exact UNSEEN source γδ\n".repeat(900));
  const unseen = state.messages.at(-1)!;
  const unseenRef = describeResearchContextMessage(state, 4)!.ref;
  return { state, old, oldRef, unseen, unseenRef, prepared: [system, ...state.messages], budget: 2200 };
}
function checkpoint(state: NautiloState, accepted = true) {
  const entry = { kind: "checkpoint", summary: "Saved the authentication behavior and its still unresolved checks.", nextWork: "Inspect the withheld routes and compare their authority checks.", openRecordIds: [], evidenceRefs: [] };
  const record = { id: `checkpoint-${state.messages.length}`, revision: 1, entry, createdBy: owner, updatedBy: owner,
    createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z" };
  call(state, "security_scan", { version: "security-scan-v1", operation: "record", action: "append", entry },
    JSON.stringify(accepted ? { ok: true, operation: "record", result: { record, codeEvidence: [] } }
      : { ok: false, operation: "record", error: { code: "invalid_request", message: "Correct the checkpoint fields." } }), accepted ? "success" : "error");
}

test("pressure consolidates the actual previous input while new paired results remain exact unread references", () => {
  const { state, old, oldRef, unseen, unseenRef, prepared, budget } = fixture();
  const canonical = JSON.stringify(state.messages);
  const result = budgetResearchContext(state, prepared, budget);
  expect(result.recovery?.preEviction).toBeDefined();
  expect(result.recovery?.pendingRefs).toEqual([unseenRef]);
  expect(result.recovery?.pendingRefs).not.toContain(oldRef);
  expect(result.messages.find((message) => message.id === old.id)?.content).toEqual(old.content);
  expect(result.messages.find((message) => message.id === unseen.id)?.content).toBe(JSON.stringify({ unreadContextRef: unseenRef }));
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(budget);
  expect(() => assertMessageInvariants(result.messages, "pre-eviction-test")).not.toThrow();
  expect(JSON.stringify(state.messages)).toBe(canonical);
  const metadata = JSON.stringify(state.researchContextPresentation);
  expect(metadata).not.toContain("exact inspected");
  expect(metadata).not.toContain(system.content as string);
});

test("a rejected checkpoint and serialized restart retain old source; acceptance cannot consolidate unseen results", () => {
  const { state, old, oldRef, unseenRef, prepared, budget } = fixture();
  const first = budgetResearchContext(state, prepared, budget);
  state.researchContextRecovery = JSON.parse(JSON.stringify(first.recovery)) as typeof first.recovery;
  state.researchContextPresentation = JSON.parse(JSON.stringify(state.researchContextPresentation)) as NonNullable<NautiloState["researchContextPresentation"]>;
  checkpoint(state, false);
  const retry = budgetResearchContext(state, [system, ...state.messages], budget);
  expect(retry.recovery?.preEviction).toBeDefined();
  expect(retry.messages.find((message) => message.id === old.id)?.content).toEqual(old.content);
  expect(retry.messages.at(-1)?.content).toContain("Correct the checkpoint fields");
  state.researchContextRecovery = retry.recovery;
  expect(researchContextRecoveryToolError(state, "file", { command: "read" })).not.toBeNull();
  expect(researchContextRecoveryToolError(state, "security_scan", { operation: "record" })).toBeNull();
  checkpoint(state);
  expect(currentResearchContextRecovery(state)?.consolidationRequired).toBe(false);
  expect(currentResearchContextRecovery(state)?.pendingRefs).toEqual([unseenRef]);
  const next = budgetResearchContext(state, [system, ...state.messages], budget);
  expect(next.recovery?.pendingRefs).toContain(unseenRef);
  expect(next.recovery?.pendingRefs).not.toContain(oldRef);
  const exact = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: unseenRef }, { maxPageBytes: 100000 });
  expect(exact.ok).toBe(true);
  if (exact.ok) expect(exact.result.text).toContain("exact UNSEEN source");
});

test("a smaller provider uses exact recovery when the prior workspace cannot fit, without losing source or pending input", () => {
  const { state, oldRef, unseenRef, prepared, budget } = fixture();
  const first = budgetResearchContext(state, prepared, budget);
  state.researchContextRecovery = first.recovery;
  const smaller = budgetResearchContext(state, first.messages, 950);
  expect(smaller.recovery?.preEviction).toBeUndefined();
  expect(smaller.recovery?.pendingRefs).toContain(oldRef);
  expect(smaller.recovery?.pendingRefs).toContain(unseenRef);
  expect(() => assertMessageInvariants(smaller.messages, "smaller-provider")).not.toThrow();
});

test("projection pointers, changed protected bodies and another TaskRun cannot manufacture prior presentation", () => {
  const { state, old, oldRef, prepared, budget } = fixture();
  const projected = new ToolMessage({ ...old as ToolMessage, content: "source not presented" });
  const receipt = captureResearchContextPresentation(state, [system, projected]);
  expect(receipt?.messageRefs).not.toContain(oldRef);
  const changed = prepared.map((message) => message === old ? projected : message);
  expect(budgetResearchContext(state, changed, budget).recovery?.preEviction).toBeUndefined();
  state.currentTaskRunId = "33333333-3333-4333-8333-333333333333";
  expect(budgetResearchContext(state, prepared, budget).recovery?.preEviction).toBeUndefined();
});

test("mixed and unknown provider cycles stay paired and full while only verified new file results are withheld", () => {
  const { state, prepared, budget, unseenRef } = fixture();
  const unknownCall = new AIMessage({ id: "unknown-call", content: "Unsaved reasoning remains explicit.", tool_calls: [{ id: "unknown", name: "file", args: { command: "grep", pattern: "unknown scope" } }] });
  const unknownResult = new ToolMessage({ id: "unknown-result", tool_call_id: "unknown", name: "file", status: "error", content: "Exact unmatched control failure and useful detail." });
  const result = budgetResearchContext(state, [...prepared, unknownCall, unknownResult], budget);
  expect(result.recovery?.preEviction).toBeDefined();
  expect(result.messages).toContain(unknownCall);
  expect(result.messages).toContain(unknownResult);
  expect(result.recovery?.pendingRefs).toEqual([unseenRef]);
  expect(() => assertMessageInvariants(result.messages, "unknown-cycle")).not.toThrow();
});

test("only an unambiguous security_scan checkpoint can end the new consolidation boundary", () => {
  const { state, prepared, budget } = fixture();
  state.researchContextRecovery = budgetResearchContext(state, prepared, budget).recovery;
  checkpoint(state);
  const accepted = state.messages.at(-1) as ToolMessage;
  const args = (state.messages.at(-2) as AIMessage).tool_calls![0]!.args;
  state.messages.splice(-2);
  call(state, "file", args, accepted.content as string);
  expect(currentResearchContextRecovery(state)?.consolidationRequired).toBe(true);
  state.messages.splice(-2);
  checkpoint(state);
  const duplicate = state.messages.at(-2) as AIMessage;
  state.messages.push(new AIMessage({ content: "", tool_calls: [{ id: duplicate.tool_calls![0]!.id!, name: "security_scan", args }], id: "ambiguous-checkpoint" }));
  expect(currentResearchContextRecovery(state)?.consolidationRequired).toBe(true);
});

test("known scan cancellation leaves the pre-eviction phase without erasing withheld bytes or claiming a checkpoint", async () => {
  const { SECURITY_SCAN_INITIAL_LANES, securityScanToolResultSchema } = await import("@nautilo/types");
  const { isResearchPreEvictionConsolidating } = await import("../../src/tools/security/research-context-rollover");
  const { createSecurityScanTool } = await import("../../src/tools/security/security-scan");
  const { state, prepared, budget, unseenRef } = fixture();
  state.researchContextRecovery = budgetResearchContext(state, prepared, budget).recovery;
  const cancelled = securityScanToolResultSchema.parse({ ok: true, operation: "cancel", result: {
    version: "security-scan-v1", scanId: "scan_cancel_test", state: "cancelled", terminalState: "cancelled", phase: null,
    mode: "deep_research", modelId: owner.modelId, modelState: "cancelled", completedSteps: 0, totalSteps: 1, lanes: SECURITY_SCAN_INITIAL_LANES, coverage: [], hypotheses: [],
  } });
  const original = JSON.stringify(state.messages);
  call(state, "security_scan", { version: "security-scan-v1", operation: "cancel" }, JSON.stringify(cancelled));
  expect(isResearchPreEvictionConsolidating(state)).toBe(false);
  expect(currentResearchContextRecovery(state)?.pendingRefs).toContain(unseenRef);
  expect(currentResearchContextRecovery(state)?.consolidationRequired).toBe(false);
  const rejectedCancel: unknown = await createSecurityScanTool(true).invoke({ version: "security-scan-v1", operation: "cancel" }).catch((error: unknown) => error);
  expect(rejectedCancel).toBeInstanceOf(Error);
  expect((rejectedCancel as Error).message).toContain("Received tool input did not match expected schema");
  expect(JSON.stringify(state.messages.slice(0, -2))).toBe(original);
  expect(budgetResearchContext({ ...state, researchContextRecovery: null }, [system, ...state.messages], budget).recovery?.preEviction).toBeUndefined();
});
