import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { NautiloState } from "../../src/agent/state";
import { localToolControlFailure } from "../../src/tools/security/research-control-feedback";
import { budgetResearchContext, restoreResearchContextControlCycle } from "../../src/tools/security/research-context-rollover";
import { describeResearchContextMessage, readResearchContext, serializeResearchContextMessage } from "../../src/tools/security/research-context";
import { estimateTokenCount } from "../../src/utils/history-manager";

const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openrouter:z-ai/glm-5.3" };
function fixture(large = false) {
  const args = { operation: "record", action: "append", entry: { kind: "review_unit", summary: "Unaccepted causal analysis and counterevidence. 🦀\n".repeat(large ? 1000 : 2) } };
  const call = new AIMessage({ id: "draft-call", content: "Unresolved authored observation.", tool_calls: [{ id: "draft", name: "security_scan", args }] });
  const error = new ToolMessage({ id: "draft-error", tool_call_id: "draft", name: "security_scan", status: "error",
    content: localToolControlFailure("security_scan", args, "invalid_request", "entry.paths: required; entry.trace: required.") });
  const state = { messages: [new HumanMessage("Audit the authorized source."), call, error], userId: "owner", currentTaskId: author.taskId,
    currentTaskRunId: author.taskRunId, subagentRun: true, toolWhitelist: ["file", "security_scan"], researchContextRecovery: null } as unknown as NautiloState;
  return { state, call, error };
}
function prepared(state: NautiloState) { return [new SystemMessage("Audit source and preserve detailed notes."), ...state.messages]; }
function guidance(messages: readonly BaseMessage[]) {
  const call = messages.find((message) => message.id === "draft-call");
  if (typeof call?.content !== "string") throw Error("Expected visible draft guidance");
  const line = call.content.split("\n").find((line) => line.startsWith('{"rejectedDraftRecovery":'));
  if (!line) throw Error("Expected exact rejected-draft recovery selector");
  return (JSON.parse(line) as { rejectedDraftRecovery: { exactHistoricalMessage: Record<string, unknown>; notice: string } }).rejectedDraftRecovery;
}
function checkpoint(state: NautiloState) {
  const id = `checkpoint-${state.messages.length}`;
  const entry = { kind: "checkpoint", summary: "Preserved useful recovered analysis and remaining work.", nextWork: "Continue the unresolved review.", openRecordIds: [], evidenceRefs: [] };
  state.messages.push(new AIMessage({ id: `${id}-call`, content: "", tool_calls: [{ id, name: "security_scan", args: { operation: "record", action: "append", entry } }] }),
    new ToolMessage({ id: `${id}-result`, name: "security_scan", tool_call_id: id, status: "success", content: JSON.stringify({ ok: true, operation: "record", result: { codeEvidence: [], record: {
      id, revision: 1, entry, createdBy: author, updatedBy: author, createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z",
    } } }) }));
}
function read(state: NautiloState, selector: Record<string, unknown>, contextBytes?: number) {
  const { tool: _tool, ...args } = selector;
  const request = { ...args, ...(contextBytes ? { contextBytes } : {}) };
  const page = readResearchContext(state, request, { maxPageBytes: 100000 });
  if (!page.ok) throw Error(page.error.code);
  const id = `read-${state.messages.length}`;
  state.messages.push(new AIMessage({ id: `${id}-call`, content: "", tool_calls: [{ id, name: "security_scan", args: request }] }),
    new ToolMessage({ id: `${id}-result`, name: "security_scan", tool_call_id: id, status: "success", content: JSON.stringify(page) }));
  return page;
}

test("visible rejected drafts expose exact optional recovery without changing error, args, canonical bytes or debt", () => {
  const { state, call, error } = fixture();
  const canonical = JSON.stringify(state.messages);
  const result = budgetResearchContext(state, prepared(state), 4000);
  const hint = guidance(result.messages);
  expect(hint.exactHistoricalMessage).toEqual({ tool: "security_scan", version: "security-scan-v1", operation: "context", contextRef: describeResearchContextMessage(state, 1)!.ref });
  expect(hint.notice).toContain("read it completely");
  expect(hint.notice).toContain("Different replacements/checkpoints alone do not retire it");
  const shown = result.messages.find((message) => message.id === call.id) as AIMessage;
  expect(shown.tool_calls).toEqual(call.tool_calls);
  expect(shown.content).toContain("Unresolved authored observation.");
  expect(result.messages).toContain(error);
  expect(result.recovery?.pendingRefs ?? []).toEqual([]);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(4000);
  expect(JSON.stringify(state.messages)).toBe(canonical);
  const again = budgetResearchContext(state, result.messages, 4000);
  expect(guidance(again.messages)).toEqual(hint);
  expect((again.messages.find((message) => message.id === call.id)!.content as string).match(/rejectedDraftRecovery/g)).toHaveLength(1);
  expect(again.recovery?.pendingRefs ?? []).toEqual([]);
  const { tool: _tool, ...foreignSelection } = hint.exactHistoricalMessage;
  const foreign = readResearchContext({ ...state, currentTaskRunId: "33333333-3333-4333-8333-333333333333" }, foreignSelection, { maxPageBytes: 100000 });
  expect(foreign.ok).toBe(false);
});

test("the exposed route retires only after the complete exact call is presented and a later checkpoint is accepted", () => {
  const { state, call } = fixture();
  const hint = guidance(budgetResearchContext(state, prepared(state), 4000).messages);
  checkpoint(state);
  expect(restoreResearchContextControlCycle(state, [state.messages[0]!])).toContain(call);
  const partial = read(state, hint.exactHistoricalMessage, 64);
  expect(partial.result.complete).toBe(false);
  checkpoint(state);
  expect(restoreResearchContextControlCycle(state, [state.messages[0]!])).toContain(call);
  const full = read(state, hint.exactHistoricalMessage);
  expect(full.result.text).toBe(serializeResearchContextMessage(call)!);
  expect(full.result.complete).toBe(true);
  expect(restoreResearchContextControlCycle(state, [state.messages[0]!])).toContain(call);
  checkpoint(state);
  expect(restoreResearchContextControlCycle(state, [state.messages[0]!])).not.toContain(call);
});

test("oversized rejected drafts retain their exact recovery route and original correction inside the actual budget", () => {
  const { state, call, error } = fixture(true);
  const canonical = JSON.stringify(state.messages);
  const result = budgetResearchContext(state, prepared(state), 2000);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(2000);
  expect(result.messages).toContain(error);
  const shown = result.messages.find((message) => message.id === call.id)!;
  expect(shown.content).toContain("read it completely");
  expect(shown.content).toContain("mandatory recovery input");
  expect(shown.content).toContain(describeResearchContextMessage(state, 1)!.ref);
  const again = budgetResearchContext(state, result.messages, 2000);
  expect(again.messages.find((message) => message.id === call.id)!.content).toBe(shown.content);
  expect(result.recovery?.pendingRefs).toContain(describeResearchContextMessage(state, 1)!.ref);
  expect(JSON.stringify(state.messages)).toBe(canonical);
});
