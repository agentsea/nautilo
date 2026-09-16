import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { assertMessageInvariants, mergeMessagesPreservingInvariants } from "@nautilo/message-invariants";
import type { NautiloState } from "../../src/agent/state";
import { budgetResearchContext, captureResearchContextPresentation, currentResearchContextRecovery, isResearchPreEvictionConsolidating, researchRuntimeRecoveryFacts } from "../../src/tools/security/research-context-rollover";
import { describeResearchContextIndex, describeResearchContextMessage, readResearchContext } from "../../src/tools/security/research-context";
import { createSecurityScanTool, projectSecurityResearchConsolidationTools } from "../../src/tools/security/security-scan";
import { createFileTool } from "../../src/tools/file/file-tool";
import { estimateBoundToolTokens } from "../../src/utils/chat-model-invocation";
import { estimateTokenCount } from "../../src/utils/history-manager";

const owner = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openrouter:z-ai/glm-5.3" };
const system = new SystemMessage("Protected authority and volatile context stay exact: αβ. Audit the authorized source.");
function append(state: NautiloState, name: string, args: Record<string, unknown>, content: string, status: "success" | "error" = "success") {
  const id = `call-${state.messages.length}`;
  const cycle = [new AIMessage({ id: `ai-${id}`, content: "", tool_calls: [{ id, name, args }] }),
    new ToolMessage({ id: `tm-${id}`, name, tool_call_id: id, content, status })];
  state.messages.push(...cycle);
  return cycle;
}
function record(state: NautiloState, kind: "evidence" | "checkpoint", accepted = true) {
  const entry = kind === "checkpoint"
    ? { kind, summary: "Saved the presented authentication behavior and unresolved cases.", nextWork: "Continue the exact remaining source range, then test its trust boundary.", openRecordIds: [], evidenceRefs: [] }
    : { kind, summary: "Material analysis of the inspected authentication conditions and unresolved trust boundary. ".repeat(9), evidenceRefs: [] };
  const saved = { id: `record-${state.messages.length}`, revision: 1, entry, createdBy: owner, updatedBy: owner,
    createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z" };
  return append(state, "security_scan", { version: "security-scan-v1", operation: "record", action: "append", entry }, JSON.stringify(accepted
    ? { ok: true, operation: "record", result: { record: saved, codeEvidence: [] } }
    : { ok: false, operation: "record", error: { code: "invalid_request", message: "Correct the checkpoint fields while preserving the material notes." } }), accepted ? "success" : "error");
}
function page(state: NautiloState) {
  const args = { version: "security-scan-v1" as const, operation: "context" as const, continueContext: true };
  const receipt = readResearchContext(state, args, { maxPageBytes: 4200 });
  if (!receipt.ok) throw new Error(receipt.error.code);
  return { receipt, cycle: append(state, "security_scan", args, JSON.stringify(receipt)), index: state.messages.length - 1 };
}
function fixture() {
  const state = { messages: [new HumanMessage("Audit the source.")], userId: "owner", subagentRun: true, toolWhitelist: ["file", "security_scan"],
    currentTaskId: owner.taskId, currentTaskRunId: owner.taskRunId, researchContextRecovery: null } as unknown as NautiloState;
  append(state, "file", { command: "read", path: "auth.js", zone: "current" }, "Exact source αβ and unresolved condition.\n".repeat(600));
  const ref = describeResearchContextMessage(state, 2)!.ref;
  state.researchContextRecovery = { taskRunId: owner.taskRunId, throughIndex: 2, indexRef: describeResearchContextIndex(state, 2)!.ref, pendingRefs: [ref], unpresentedReadIndices: [] };
  const earlier = page(state);
  state.researchContextRecovery.unpresentedReadIndices = [earlier.index];
  const checkpoint = record(state, "checkpoint");
  const first = page(state);
  const oldPrepared = [system, state.messages[0]!, ...checkpoint, ...first.cycle];
  state.researchContextPresentation = captureResearchContextPresentation(state, oldPrepared);
  const second = page(state);
  // The prior checkpoint call can leave the ordinary window without making
  // the still-unconsolidated page or the existing unread ranges disappear.
  const prepared = [system, state.messages[0]!, ...first.cycle, ...second.cycle];
  const fullTools = [createFileTool(state), createSecurityScanTool()];
  const toolSavings = estimateBoundToolTokens(fullTools) - estimateBoundToolTokens(projectSecurityResearchConsolidationTools(fullTools, true));
  const normalBudget = estimateTokenCount(prepared) - 100;
  return { state, ref, earlier, first, second, prepared, normalBudget, narrowBudget: normalBudget + toolSavings };
}

test("active recovery enters consolidation before page eviction, retaining old debt and the complete newest partial page", () => {
  const { state, ref, earlier, first, second, prepared, normalBudget, narrowBudget } = fixture();
  const canonical = JSON.stringify(state.messages);
  const facts = researchRuntimeRecoveryFacts(state);
  expect(currentResearchContextRecovery(state)?.consolidationRequired).not.toBe(true);
  expect(second.receipt.result.complete).toBe(false);
  const next = budgetResearchContext(state, prepared, normalBudget, narrowBudget);
  expect(isResearchPreEvictionConsolidating({ ...state, researchContextRecovery: next.recovery })).toBe(true);
  expect(next.recovery?.preEviction?.withheldRefs).toEqual([]);
  expect(next.recovery?.pendingRefs).toEqual([ref]);
  expect(next.recovery?.unpresentedReadIndices).toEqual([earlier.index]);
  expect(next.recovery?.throughIndex).toBe(state.messages.length - 1);
  expect(next.recovery?.indexRef).toBe(describeResearchContextIndex(state, state.messages.length - 1)?.ref);
  for (const item of [first, second]) expect(next.messages.find((message) => message.id === state.messages[item.index]!.id)?.content).toEqual(state.messages[item.index]!.content);
  expect(researchRuntimeRecoveryFacts({ ...state, researchContextRecovery: next.recovery }).recoveredInputBytes).toBe(facts.recoveredInputBytes);
  expect(estimateTokenCount(next.messages)).toBeLessThanOrEqual(narrowBudget);
  expect(next.messages[0]?.content).toContain(system.content as string);
  expect(() => assertMessageInvariants(next.messages, "active-recovery-entry")).not.toThrow();
  expect(JSON.stringify(state.messages)).toBe(canonical);
});

test("notes and rejected checkpoint remain usable before acceptance; remaining bytes resume at the exact partial cursor", () => {
  const { state, ref, earlier, first, second, prepared, normalBudget, narrowBudget } = fixture();
  let next = budgetResearchContext(state, prepared, normalBudget, narrowBudget);
  const step = (cycle: BaseMessage[]) => {
    state.researchContextRecovery = next.recovery;
    next = budgetResearchContext(state, mergeMessagesPreservingInvariants(next.messages, cycle), narrowBudget);
  };
  step(record(state, "evidence"));
  expect(isResearchPreEvictionConsolidating({ ...state, researchContextRecovery: next.recovery })).toBe(true);
  step(record(state, "checkpoint", false));
  expect(isResearchPreEvictionConsolidating({ ...state, researchContextRecovery: next.recovery })).toBe(true);
  expect(next.messages.at(-1)?.content).toContain("Correct the checkpoint fields");
  for (const item of [first, second]) expect(next.messages.find((message) => message.id === state.messages[item.index]!.id)?.content).toEqual(state.messages[item.index]!.content);
  expect(next.recovery?.unpresentedReadIndices).toEqual([earlier.index]);
  const before = JSON.stringify(state.messages);
  const accepted = record(state, "checkpoint");
  state.researchContextRecovery = next.recovery;
  next = budgetResearchContext(state, [...next.messages, ...accepted], normalBudget);
  state.researchContextRecovery = next.recovery;
  expect(isResearchPreEvictionConsolidating(state)).toBe(false);
  expect(next.recovery?.pendingRefs).toEqual([ref]);
  expect(next.recovery?.unpresentedReadIndices).toEqual([earlier.index]);
  const continuation = readResearchContext(state, { version: "security-scan-v1", operation: "context", continueContext: true }, { maxPageBytes: 4200 });
  expect(continuation.ok).toBe(true);
  if (continuation.ok) {
    expect(continuation.result.contextRef).toBe(ref);
    expect(continuation.result.startByte).toBe(second.receipt.result.endByte);
    expect(continuation.result.resolvedSelection?.contextCursor ?? null).toBe(second.receipt.result.nextCursor);
  }
  expect(JSON.stringify(state.messages.slice(0, -2))).toBe(before);
  expect(() => assertMessageInvariants(next.messages, "active-recovery-checkpoint")).not.toThrow();
});

test("smaller provider falls back to the same exact source without clearing old unseen ranges", () => {
  const { state, ref, earlier, first, second, prepared, normalBudget, narrowBudget } = fixture();
  const entered = budgetResearchContext(state, prepared, normalBudget, narrowBudget);
  state.researchContextRecovery = entered.recovery;
  const canonical = JSON.stringify(state.messages);
  const small = budgetResearchContext(state, entered.messages, 1700);
  expect(isResearchPreEvictionConsolidating({ ...state, researchContextRecovery: small.recovery })).toBe(false);
  expect(small.recovery?.pendingRefs).toContain(ref);
  for (const index of [earlier.index, first.index, second.index]) expect(small.recovery?.unpresentedReadIndices).toContain(index);
  state.researchContextRecovery = small.recovery;
  const reread = readResearchContext(state, { version: "security-scan-v1", operation: "context", continueContext: true }, { maxPageBytes: 4200 });
  expect(reread.ok).toBe(true);
  if (reread.ok) expect(reread.result.startByte).toBe(0);
  expect(JSON.stringify(state.messages)).toBe(canonical);
  expect(() => assertMessageInvariants(small.messages, "active-recovery-small-provider")).not.toThrow();
});

test("empty withholding cannot create a phase from raw source, unpresented pages or a foreign presentation", () => {
  const { state, ref, first, prepared, normalBudget, narrowBudget } = fixture();
  const entered = budgetResearchContext(state, prepared, normalBudget, narrowBudget);
  state.researchContextRecovery = { ...entered.recovery!, preEviction: { ...entered.recovery!.preEviction!, retainedRefs: [ref] } };
  expect(isResearchPreEvictionConsolidating(state)).toBe(false);
  state.researchContextRecovery = { ...entered.recovery!, unpresentedReadIndices: [...entered.recovery!.unpresentedReadIndices!, first.index] };
  expect(isResearchPreEvictionConsolidating(state)).toBe(false);
  const { preEviction: _boundary, ...recovery } = entered.recovery!;
  state.researchContextRecovery = recovery;
  state.researchContextPresentation = { ...state.researchContextPresentation!, taskRunId: "33333333-3333-4333-8333-333333333333" };
  expect(budgetResearchContext(state, prepared, normalBudget, narrowBudget).recovery?.preEviction).toBeUndefined();
});
