import { afterEach, expect, test } from "bun:test";
import { localToolControlReceiptSchema } from "@nautilo/types";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { clearToolCatalog, initToolCatalog, ToolCatalog } from "@nautilo/catalog";
import type { NautiloState } from "../../src/agent/state";
import { createNautiloToolInvocationSession, createServerToolInvocationContext, setRelayRegistry } from "../../src/tools/invocation-service";
import { registerAllTools } from "../../src/tools/register-all";
import { describeResearchContextIndex, describeResearchContextMessage, readResearchContext, serializeResearchContextMessage } from "../../src/tools/security/research-context";

function setup(overrides: Partial<NautiloState> = {}): NautiloState {
  const catalog = new ToolCatalog();
  registerAllTools(catalog, { officeCliAvailable: () => false });
  initToolCatalog(catalog);
  setRelayRegistry(null);
  return {
    messages: [new ToolMessage({ id: "tm:original", name: "file", tool_call_id: "original", content: "An exact retained code result" })],
    approvedToolCalls: [], actorRole: "owner", userId: "owner", personaId: "owner", turnId: "turn", agentId: "agent", roomId: "room",
    model: "openai:gpt-5.6-sol", currentTaskId: "task", currentTaskRunId: "run", currentFolder: "/repo", subagentRun: true,
    toolWhitelist: ["file", "security_scan"], activatedToolNames: ["security_scan"], activatedToolLeases: [], engagedSkillNames: [],
    memoryAccessEnvelope: null, relayCapabilities: { canReadWorkspace: true }, requiredHostRelays: {}, verifiedOrdinaryOrigin: null,
    researchContextPageBytes: 1500, ...overrides,
  } as unknown as NautiloState;
}
afterEach(() => { setRelayRegistry(null); clearToolCatalog(); });

test("retrieves canonical bytes through real admitted invocation with no Desktop registry or host selection", async () => {
  const state = setup();
  const ref = describeResearchContextMessage(state, 0)!;
  const context = createServerToolInvocationContext(state, () => ({ status: "allowed" }));
  const receipt = await createNautiloToolInvocationSession(context).invoke({ callId: "context", toolName: "security_scan",
    args: { version: "security-scan-v1", operation: "context", contextRef: ref.ref }, authorityRef: "admitted-context" });
  expect(receipt.status).toBe("success");
  expect(JSON.parse(receipt.content as string)).toMatchObject({ ok: true, operation: "context", result: { complete: true, text: serializeResearchContextMessage(state.messages[0]!) } });
  expect(receipt.additionalKwargs?.["nautilo_file_operation"]).toBeUndefined();
});

test("real invocation does not bypass whitelist or cross-run content authority", async () => {
  const state = setup();
  const ref = describeResearchContextMessage(state, 0)!;
  const invoke = (input: NautiloState) => createNautiloToolInvocationSession(createServerToolInvocationContext(input, () => ({ status: "allowed" }))).invoke({
    callId: "context", toolName: "security_scan", args: { version: "security-scan-v1", operation: "context", contextRef: ref.ref }, authorityRef: "admitted-context",
  });
  expect((await invoke({ ...state, toolWhitelist: ["file"] })).status).toBe("error");
  const stale = await invoke({ ...state, currentTaskRunId: "different-run" });
  expect(stale.status).toBe("error");
  expect(JSON.parse(stale.content as string)).toMatchObject({ ok: false, error: { code: "context_reference_stale" } });
});


test("parallel historical reads share one runtime page allowance", async () => {
  const state = setup({ messages: [new ToolMessage({ id: "tm:original", name: "file", tool_call_id: "original", content: "source material\n".repeat(2000) })], researchContextPageBytes: 6000 });
  const descriptor = describeResearchContextMessage(state, 0)!;
  const calls = ["left", "right"].map((id) => ({ id, name: "security_scan", args: { version: "security-scan-v1", operation: "context", contextRef: descriptor.ref } }));
  state.messages.push(new AIMessage({ content: "Recover both input pages.", tool_calls: calls }));
  const session = createNautiloToolInvocationSession(createServerToolInvocationContext(state, () => ({ status: "allowed" })));
  const receipts = await Promise.all(calls.map((call) => session.invoke({ callId: call.id, toolName: call.name, args: call.args, authorityRef: "admitted-context" })));
  expect(receipts.every((receipt) => receipt.status === "success")).toBe(true);
  expect(receipts.reduce((bytes, receipt) => bytes + Buffer.byteLength(receipt.content as string, "utf8"), 0)).toBeLessThanOrEqual(6000);
});


test("a pressure-blocked read-ahead keeps actionable checkpoint feedback in a validated non-execution receipt", async () => {
  const state = setup();
  const ref = describeResearchContextMessage(state, 0)!.ref;
  state.researchContextRecovery = { taskRunId: "run", throughIndex: 0,
    indexRef: describeResearchContextIndex(state, 0)!.ref, pendingRefs: [ref] };
  const args = { version: "security-scan-v1", operation: "context", contextRef: ref };
  const page = readResearchContext(state, args, { maxPageBytes: 1500 });
  expect(page.ok).toBe(true);
  state.messages.push(new AIMessage({ content: "Read the retained source.", tool_calls: [{ id: "page", name: "security_scan", args }] }),
    new ToolMessage({ name: "security_scan", tool_call_id: "page", content: JSON.stringify(page) }));
  state.researchContextRecovery.consolidationRequired = true;
  const receipt = await createNautiloToolInvocationSession(createServerToolInvocationContext(state, () => ({ status: "allowed" }))).invoke({
    callId: "read-ahead", toolName: "security_scan", args, authorityRef: "admitted-context",
  });
  expect(receipt.status).toBe("error");
  const parsed = localToolControlReceiptSchema.parse(JSON.parse(receipt.content as string));
  expect(parsed).toMatchObject({ ok: false, notDispatched: true, toolName: "security_scan", requestedOperation: "context" });
  expect(parsed.error.message).toContain("cumulative checkpoint");
  expect(parsed.runtimeRecovery).toMatchObject({ phase: "consolidation_required", retainedUnconsolidatedPages: 1 });
});
