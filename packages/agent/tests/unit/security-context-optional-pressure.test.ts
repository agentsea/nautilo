import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { NautiloState } from "../../src/agent/state";
import { describeResearchContextIndex, describeResearchContextMessage, readResearchContext, replayResearchContextReceipt } from "../../src/tools/security/research-context";
import { budgetResearchContext, currentResearchContextRecovery, researchContextRecoveryToolError, researchRuntimeRecoveryFacts } from "../../src/tools/security/research-context-rollover";
import { estimateTokenCount } from "../../src/utils/history-manager";

const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openrouter:z-ai/glm-5.3" };
const continuation = { version: "security-scan-v1", operation: "context", continueContext: true };
function append(state: NautiloState, args: Record<string, unknown>, result: unknown) {
  const id = `call-${state.messages.length}`;
  state.messages.push(new AIMessage({ id: `ai-${id}`, content: "", tool_calls: [{ id, name: "security_scan", args }] }),
    new ToolMessage({ id: `tm-${id}`, tool_call_id: id, name: "security_scan", status: "success", content: JSON.stringify(result) }));
  return state.messages.at(-1)!;
}
function checkpoint(state: NautiloState) {
  const entry = { kind: "checkpoint", summary: "Saved useful observations and retained the overall audit plan.", nextWork: "Continue the selected historical source stream.", openRecordIds: [], evidenceRefs: [] };
  append(state, { version: "security-scan-v1", operation: "record", action: "append", entry }, { ok: true, operation: "record", result: { codeEvidence: [], record: {
    id: `checkpoint-${state.messages.length}`, revision: 1, entry, createdBy: author, updatedBy: author, createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z",
  } } });
}
function fixture(navigation = false) {
  const state = { messages: [new HumanMessage("Audit the authorized source."),
    new AIMessage({ id: "source-call", content: "", tool_calls: [{ id: "source", name: "file", args: { command: "read", path: "identity/tokens.js", zone: "current" } }] }),
    new ToolMessage({ id: "source-result", tool_call_id: "source", name: "file", status: "success", content: "Exact original source 🦀\n".repeat(1000) })],
    userId: "owner", currentTaskId: author.taskId, currentTaskRunId: author.taskRunId, subagentRun: true, toolWhitelist: ["file", "security_scan"], researchContextRecovery: null } as unknown as NautiloState;
  const sourceRef = describeResearchContextMessage(state, 2)!.ref;
  const initial = { version: "security-scan-v1", operation: "context", contextRef: sourceRef };
  const full = readResearchContext(state, initial, { maxPageBytes: 100000 });
  if (!full.ok || !full.result.complete) throw Error("Fixture must have complete old coverage");
  append(state, initial, full);
  checkpoint(state);
  const checkpointStart = state.messages.length - 2;
  const entry = { kind: "evidence", summary: "Saved observations with exact durable notes. ".repeat(100), evidenceRefs: [] };
  append(state, { version: "security-scan-v1", operation: "record", action: "append", entry }, { ok: true, operation: "record", result: { codeEvidence: [], record: {
    id: "saved-note", revision: 1, entry, createdBy: author, updatedBy: author, createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z",
  } } });
  const contextRef = navigation ? describeResearchContextIndex(state, 2)!.ref : sourceRef;
  const args = { ...initial, contextRef, contextBytes: 200 };
  const first = readResearchContext(state, args, { maxPageBytes: 3000 });
  if (!first.ok || first.result.complete) throw Error("Fixture must have a partial voluntary stream");
  const firstMessage = append(state, args, first);
  const nextArgs = { ...continuation, contextRef, contextBytes: 200 };
  const second = readResearchContext(state, nextArgs, { maxPageBytes: 3000 });
  if (!second.ok) throw Error(second.error.message);
  const secondMessage = append(state, nextArgs, second);
  const prepared = [new SystemMessage("Preserve exact source and all unresolved notes."), state.messages[0]!, ...state.messages.slice(checkpointStart)];
  return { state, prepared, sourceRef, firstMessage, secondMessage, second };
}
function tightBudget(state: NautiloState, prepared: BaseMessage[]) {
  const ordinary = budgetResearchContext(state, prepared, 8000);
  return estimateTokenCount(ordinary.messages) + 70;
}

test("voluntary source pressure requests consolidation despite old full coverage and resumes the exact new cursor", () => {
  const { state, prepared, sourceRef, firstMessage, secondMessage, second } = fixture();
  const canonical = JSON.stringify(state.messages);
  const budget = tightBudget(state, prepared);
  const result = budgetResearchContext(state, prepared, budget);
  state.researchContextRecovery = result.recovery;
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(budget);
  expect(result.recovery).toMatchObject({ pendingRefs: [], consolidationRequired: true });
  expect(result.recovery?.unpresentedReadIndices ?? []).toEqual([]);
  expect(researchRuntimeRecoveryFacts(state)).toMatchObject({ phase: "consolidation_required", pendingInputCount: 0, retainedUnconsolidatedPages: 2 });
  for (const page of [firstMessage, secondMessage]) expect(result.messages.some((message) => message.id === page.id && message.content === page.content)).toBe(true);
  expect(researchContextRecoveryToolError(state, "security_scan", continuation)).not.toBeNull();
  expect(researchContextRecoveryToolError(state, "security_scan", { version: "security-scan-v1", operation: "record", action: "append", entry: { kind: "checkpoint" } })).toBeNull();
  expect(JSON.stringify(state.messages)).toBe(canonical);
  const retried = budgetResearchContext(state, result.messages, budget);
  expect(estimateTokenCount(retried.messages)).toBeLessThanOrEqual(budget);
  expect(retried.recovery?.pendingRefs).toEqual([]);
  expect(retried.recovery?.unpresentedReadIndices ?? []).toEqual([]);
  for (const page of [firstMessage, secondMessage]) expect(retried.messages.some((message) => message.id === page.id && message.content === page.content)).toBe(true);
  const selected = second.result.resolvedSelection!;
  expect(replayResearchContextReceipt(state, { version: "security-scan-v1", operation: "context", ...selected }, second)).toEqual(second);
  checkpoint(state);
  expect(currentResearchContextRecovery(state)).toBeNull();
  const after = budgetResearchContext(state, [prepared[0]!, ...state.messages], 8000);
  state.researchContextRecovery = after.recovery;
  expect(after.recovery).toBeNull();
  expect(researchContextRecoveryToolError(state, "security_scan", continuation)).toBeNull();
  const next = readResearchContext(state, continuation, { maxPageBytes: after.pageBytes });
  expect(next).toMatchObject({ ok: true, result: { contextRef: sourceRef, startByte: second.result.endByte } });
  expect(next.ok && next.result.resolvedSelection?.contextCursor).toBe(second.result.nextCursor ?? undefined);
});

test("optional navigation pressure does not create source debt or a semantic checkpoint", () => {
  const { state, prepared } = fixture(true);
  const canonical = JSON.stringify(state.messages);
  const result = budgetResearchContext(state, prepared, tightBudget(state, prepared));
  expect(result.recovery).toBeNull();
  expect(researchRuntimeRecoveryFacts({ ...state, researchContextRecovery: result.recovery }).phase).toBe("inactive");
  expect(JSON.stringify(state.messages)).toBe(canonical);
});
