import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { getContentAsString } from "@nautilo/message-invariants";
import type { NautiloState } from "../../src/agent/state";
import { budgetResearchContext, remainingResearchContextRefs, researchContextRecoveryToolError } from "../../src/tools/security/research-context-rollover";
import { describeResearchContextMessage, readResearchContext } from "../../src/tools/security/research-context";
import { estimateTokenCount } from "../../src/utils/history-manager";

const system = new SystemMessage("Keep all audit authority and instructions. ".repeat(80));
let sequence = 0;
function fixture(): NautiloState {
  return { userId: "owner", currentTaskId: "task", currentTaskRunId: "run", subagentRun: true, toolWhitelist: ["file", "security_scan"],
    model: "openai:gpt-5.6-sol", researchContextRecovery: null, researchContextPageBytes: null,
    messages: [new HumanMessage("Audit the whole application."),
      new AIMessage({ id: "source-call", content: "Follow authorization through callers.", tool_calls: [{ id: "read", name: "file", args: { command: "grep", pattern: "authorization" } }] }),
      new ToolMessage({ id: "source-result", name: "file", tool_call_id: "read", content: "original authorization source\n".repeat(6000) })],
  } as unknown as NautiloState;
}
function apply(state: NautiloState, prepared: BaseMessage[], budget: number) {
  const result = budgetResearchContext(state, prepared, budget);
  state.researchContextRecovery = result.recovery;
  state.researchContextPageBytes = result.pageBytes;
  return result;
}
function appendPage(state: NautiloState, ref: string, maxPageBytes: number, cursor?: string) {
  const args = { version: "security-scan-v1", operation: "context", contextRef: ref, ...(cursor ? { contextCursor: cursor } : {}) };
  const page = readResearchContext(state, args, { maxPageBytes });
  if (!page.ok) throw new Error(page.error.message);
  const id = `page-${sequence++}`;
  state.messages.push(new AIMessage({ id: `${id}-call`, content: "Inspect the next exact historical range.", tool_calls: [{ id, name: "security_scan", args }] }),
    new ToolMessage({ id: `${id}-result`, name: "security_scan", tool_call_id: id, content: JSON.stringify(page) }));
  return page;
}
function checkpoint(state: NautiloState) {
  const id = `checkpoint-${sequence++}`;
  const entry = { kind: "checkpoint", summary: "Retained material authorization behavior and uncertainty from the inspected page.", nextWork: "Continue the exact original source cursor; investigate remaining control paths.", openRecordIds: [], evidenceRefs: [] };
  const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: null };
  state.messages.push(new AIMessage({ id: `${id}-call`, content: "Consolidate the inspected source.", tool_calls: [{ id, name: "security_scan", args: { version: "security-scan-v1", operation: "record", action: "append", entry } }] }),
    new ToolMessage({ id: `${id}-result`, name: "security_scan", tool_call_id: id, content: JSON.stringify({ ok: true, operation: "record", result: { codeEvidence: [], record: {
      id, revision: 1, createdAt: "2026-09-07T12:00:00Z", updatedAt: "2026-09-07T12:00:00Z", createdBy: author, updatedBy: author, entry,
    } } }) }));
}
function recoveryInstruction(messages: BaseMessage[]) {
  const content = getContentAsString(messages[0]!.content);
  return JSON.parse(content.slice(content.lastIndexOf('\n{') + 1)) as { nextContextRef: string; nextContextCursor: string | null; recoveredBytes: number };
}

test("a smaller actual provider budget rewinds an unseen page to its original source cursor", () => {
  const state = fixture();
  const ref = describeResearchContextMessage(state, 2)!.ref;
  apply(state, [system, ...state.messages], 16_000);
  const first = appendPage(state, ref, 2500);
  checkpoint(state);
  apply(state, [system, ...state.messages], 16_000);
  const second = appendPage(state, ref, 25_000, first.result.nextCursor!);
  const discardedIndex = state.messages.length - 1;
  const wrapperRef = describeResearchContextMessage(state, discardedIndex)!.ref;
  const originalMessages = state.messages.map((message) => message.toDict());
  const broad = apply(state, [system, ...state.messages], 16_000);
  expect(broad.messages.some((message) => message.id === state.messages[discardedIndex]!.id && message.content === JSON.stringify(second))).toBe(true);
  // The provider rejects the prepared request; none of second's bytes were consumed.
  const smaller = apply(state, broad.messages, 3000);
  expect(estimateTokenCount(smaller.messages)).toBeLessThanOrEqual(3000);
  expect(smaller.recovery?.unpresentedReadIndices).toContain(discardedIndex);
  expect(smaller.recovery?.pendingRefs).toContain(ref);
  expect(smaller.recovery?.pendingRefs).not.toContain(wrapperRef);
  expect(recoveryInstruction(smaller.messages)).toMatchObject({ nextContextRef: ref, nextContextCursor: first.result.nextCursor, recoveredBytes: first.result.endByte });
  expect(remainingResearchContextRefs(state, smaller.recovery!)).toContain(ref);
  expect(researchContextRecoveryToolError(state, "security_scan", { operation: "context" })).toBeNull();
  expect(state.messages.map((message) => message.toDict())).toEqual(originalMessages);
  const reread = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: ref, contextCursor: first.result.nextCursor }, { maxPageBytes: smaller.pageBytes });
  expect(reread.ok).toBe(true);
  if (reread.ok) {
    expect(reread.result.startByte).toBe(first.result.endByte);
    expect(reread.result.endByte).toBeLessThan(second.result.endByte);
  }
});

test("older uncheckpointed source remains required when a newer tool call is already in history", () => {
  const state = fixture();
  state.messages.push(new AIMessage({ id: "later-call", content: "Continue tracing after this source.", tool_calls: [{ id: "later", name: "file", args: { command: "stat", path: "." } }] }),
    new ToolMessage({ id: "later-result", name: "file", tool_call_id: "later", content: "Directory exists" }));
  const result = apply(state, [system, ...state.messages], 3000);
  expect(result.recovery?.pendingRefs).toContain(describeResearchContextMessage(state, 2)!.ref);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(3000);
});
