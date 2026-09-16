import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { NautiloState } from "../../src/agent/state";
import { budgetResearchContext, researchContextRecoveryToolError } from "../../src/tools/security/research-context-rollover";
import { readResearchContext } from "../../src/tools/security/research-context";
import { estimateTokenCount } from "../../src/utils/history-manager";

function initialRecovery() {
  const messages = [new HumanMessage("Review the authorized source and save substantive notes."),
    new AIMessage({ content: "Trace the source.", tool_calls: [{ id: "read", name: "file", args: { command: "read", path: "src/service.ts" } }] }),
    new ToolMessage({ tool_call_id: "read", name: "file", content: "Source behavior requiring investigation.\n".repeat(3000) })];
  const state = { messages, userId: "owner", currentTaskId: "task", currentTaskRunId: "run", subagentRun: true,
    toolWhitelist: ["file", "security_scan"], researchContextRecovery: null } as unknown as NautiloState;
  const prepared = [new SystemMessage("Investigate authorized code."), ...messages];
  const result = budgetResearchContext(state, prepared, 4000);
  state.researchContextRecovery = result.recovery;
  if (!result.recovery) throw new Error("Expected historical input recovery");
  return { state, result };
}

function action(messages: BaseMessage[]) {
  const system = messages.find((message) => SystemMessage.isInstance(message));
  if (typeof system?.content !== "string") throw new Error("Expected leading system text");
  const suffix = system.content.split("[RESEARCH CONTEXT RECOVERY]").at(-1)!;
  const line = suffix.split("\n").find((entry) => entry.startsWith('{"requiredAction"'));
  if (!line) throw new Error("Expected runtime recovery action");
  return { text: suffix, value: JSON.parse(line) as { requiredAction: string; continueWith: Record<string, unknown>; pendingContextCount: number; finish: string } };
}

test("reading phase advertises an admitted automatic context operation", () => {
  const { state, result } = initialRecovery();
  const { value } = action(result.messages);
  expect(value.requiredAction).toBe("read");
  expect(value.continueWith).toEqual({ tool: "security_scan", version: "security-scan-v1", operation: "context", continueContext: true });
  expect(researchContextRecoveryToolError(state, "security_scan", value.continueWith)).toBeNull();
});

test("workspace pressure advertises a model-authored checkpoint even while source inputs remain", () => {
  const { state } = initialRecovery();
  const args = { version: "security-scan-v1", operation: "context", contextRef: state.researchContextRecovery!.pendingRefs[0] };
  const receipt = readResearchContext(state, args, { maxPageBytes: 1500 });
  if (!receipt.ok) throw new Error(receipt.error.message);
  state.messages.push(new AIMessage({ content: "", tool_calls: [{ id: "page", name: "security_scan", args }] }),
    new ToolMessage({ tool_call_id: "page", name: "security_scan", content: JSON.stringify(receipt) }));
  state.researchContextRecovery = { ...state.researchContextRecovery!, consolidationRequired: true };
  const before = state.messages.map((message) => message.toDict());
  const result = budgetResearchContext(state, [new SystemMessage("Investigate authorized code."), ...state.messages], 1800);
  state.researchContextRecovery = result.recovery;
  const { text, value } = action(result.messages);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(1800);
  expect(value.pendingContextCount).toBeGreaterThan(0);
  expect(value.requiredAction).toBe("checkpoint");
  expect(value.continueWith).toEqual({ tool: "security_scan", version: "security-scan-v1", operation: "record", action: "append" });
  expect(researchContextRecoveryToolError(state, "security_scan", value.continueWith)).toBeNull();
  expect(researchContextRecoveryToolError(state, "security_scan", { operation: "context", continueContext: true })).not.toBeNull();
  expect(text).toContain("do not wait for all pending reads");
  expect(text).toContain("the runtime does not author them");
  expect(value.finish).toContain("before any further source page");
  expect(state.messages.map((message) => message.toDict())).toEqual(before);
});

test("exhausted historical input requests a checkpoint instead of an impossible next page", () => {
  const { state } = initialRecovery();
  const refs = state.researchContextRecovery!.pendingRefs;
  for (const [index, contextRef] of refs.entries()) {
    const args = { version: "security-scan-v1", operation: "context", contextRef };
    const receipt = readResearchContext(state, args, { maxPageBytes: 1000000 });
    if (!receipt.ok || !receipt.result.complete) throw new Error("Expected complete historical input");
    state.messages.push(new AIMessage({ content: "", tool_calls: [{ id: `context-${index}`, name: "security_scan", args }] }),
      new ToolMessage({ tool_call_id: `context-${index}`, name: "security_scan", content: JSON.stringify(receipt) }));
  }
  const result = budgetResearchContext(state, [new SystemMessage("Investigate authorized code."), ...state.messages], 1000000);
  const { value } = action(result.messages);
  expect(value.pendingContextCount).toBe(0);
  expect(value.requiredAction).toBe("checkpoint");
  expect(value.continueWith["operation"]).toBe("record");
  expect(value.continueWith["continueContext"]).toBeUndefined();
});
