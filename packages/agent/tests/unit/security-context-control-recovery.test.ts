import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { NautiloState } from "../../src/agent/state";
import { describeResearchContextIndex, describeResearchContextMessage, readResearchContext, serializeResearchContextMessage } from "../../src/tools/security/research-context";
import { budgetResearchContext, restoreResearchContextControlCycle, currentResearchContextRecovery, researchContextRecoveryToolError, researchRuntimeRecoveryFacts } from "../../src/tools/security/research-context-rollover";
import { pairedResearchReceipts } from "../../src/tools/security/research-saved-state";
import { localToolControlFailure } from "../../src/tools/security/research-control-feedback";
import { estimateTokenCount } from "../../src/utils/history-manager";

const continuation = { version: "security-scan-v1", operation: "context", continueContext: true };
function fixture() {
  const state = { messages: [new HumanMessage("Audit the source"),
    new AIMessage({ id: "original-call", content: "", tool_calls: [{ id: "source", name: "file", args: { command: "read", path: "identity/tokens.js", zone: "current" } }] }),
    new ToolMessage({ id: "original-result", name: "file", tool_call_id: "source", status: "success", content: "source 🦀\n".repeat(4000) })],
    userId: "owner", currentTaskId: "11111111-1111-4111-8111-111111111111", currentTaskRunId: "22222222-2222-4222-8222-222222222222",
    subagentRun: true, toolWhitelist: ["file", "security_scan"], researchContextRecovery: null, researchContextPageBytes: null } as unknown as NautiloState;
  state.researchContextRecovery = { taskRunId: state.currentTaskRunId!, throughIndex: 2,
    indexRef: describeResearchContextIndex(state, 2)!.ref, pendingRefs: [describeResearchContextMessage(state, 2)!.ref, describeResearchContextMessage(state, 1)!.ref] };
  const page = readResearchContext(state, { ...continuation, contextBytes: 600 }, { maxPageBytes: 3000 });
  if (!page.ok) throw Error(page.error.message);
  state.messages.push(new AIMessage({ id: "page-call", content: "", tool_calls: [{ id: "page", name: "security_scan", args: { ...continuation, contextBytes: 600 } }] }),
    new ToolMessage({ id: "page-result", name: "security_scan", tool_call_id: "page", status: "success", content: JSON.stringify(page) }));
  state.researchContextRecovery.consolidationRequired = true;
  return state;
}
function failure(state: NautiloState, options: { code?: string; legacy?: boolean; malformed?: boolean; visible?: string; sibling?: boolean } = {}) {
  const id = `failed-${state.messages.length}`;
  const calls = [{ id, name: "security_scan", args: continuation }];
  if (options.sibling) calls.push({ id: `${id}-sibling`, name: "file", args: { command: "read" } as unknown as typeof continuation });
  const call = new AIMessage({ id: `${id}-call`, content: options.visible ?? "", tool_calls: calls });
  const message = new ToolMessage({ id: `${id}-result`, name: "security_scan", tool_call_id: id,
    ...(options.legacy ? { additional_kwargs: { nautilo_tool_status: "error" } } : { status: "error" as const }),
    content: options.malformed ? "unstructured new input" : JSON.stringify({ ok: false, operation: "context", runtimeRecovery: researchRuntimeRecoveryFacts(state),
      error: { code: options.code ?? "context_recovery_pending", message: "Save useful notes and a cumulative checkpoint before another page.", retryable: false } }) });
  state.messages.push(call, message);
  if (options.sibling) state.messages.push(new ToolMessage({ id: `${id}-sibling-result`, name: "file", tool_call_id: `${id}-sibling`, status: "error", content: "unclassified sibling source failure" }));
  return { call, message };
}
const prepared = (state: NautiloState): BaseMessage[] => [new SystemMessage("Audit carefully; preserve evidence and unfinished work."), ...state.messages];

test("invalid role handoffs preserve actionable feedback without creating new source debt", () => {
  const state = fixture();
  const refs = [...state.researchContextRecovery!.pendingRefs];
  const call = new AIMessage({ id: "handoff-call", content: "", tool_calls: [{ id: "handoff", name: "security_scan", args: {
    version: "security-scan-v1", operation: "handoff", role: "reviewer", handoffRecordId: "stale_checkpoint",
  } }] });
  const error = new ToolMessage({ id: "handoff-error", tool_call_id: "handoff", name: "security_scan", status: "error", content: JSON.stringify({
    ok: false, operation: "handoff", error: { code: "research_handoff_invalid", message: "Save an updated cumulative checkpoint before handoff.", retryable: false },
  }) });
  state.messages.push(call, error);
  state.researchContextRecovery!.pendingRefs.push(describeResearchContextMessage(state, state.messages.length - 1)!.ref);
  expect(currentResearchContextRecovery(state)?.pendingRefs).toEqual(refs);
  const restored = restoreResearchContextControlCycle(state, prepared(state).slice(0, 6));
  const budget = budgetResearchContext(state, restored, 4000);
  expect(budget.messages).toContain(call);
  expect(budget.messages).toContain(error);
  expect(budget.recovery?.pendingRefs).toEqual(refs);
  expect(researchContextRecoveryToolError(state, "security_scan", { operation: "handoff" })).toContain("Context recovery is active");
  call.tool_calls![0]!.args["reportDraft"] = "Unsaved material report draft.";
  const draftRef = describeResearchContextMessage(state, state.messages.indexOf(call))!.ref;
  state.researchContextRecovery!.pendingRefs.push(draftRef);
  expect(currentResearchContextRecovery(state)?.pendingRefs).toContain(draftRef);
});

test("twenty repeated control errors stay optional and the latest paired failure survives the source-retaining reset", () => {
  const state = fixture();
  const canonicalSource = serializeResearchContextMessage(state.messages[2]!);
  const originalRefs = [...state.researchContextRecovery!.pendingRefs];
  const retainedPage = state.messages[4]!;
  const beforeBytes = researchRuntimeRecoveryFacts(state).recoveredInputBytes;
  let latest!: ReturnType<typeof failure>;
  for (let i = 0; i < 20; i++) {
    latest = failure(state, { legacy: i % 2 === 0 });
    // Replay persisted debt from the faulty build as well as new failures.
    state.researchContextRecovery!.pendingRefs.push(describeResearchContextMessage(state, state.messages.length - 1)!.ref);
  }
  expect(currentResearchContextRecovery(state)?.pendingRefs).toEqual(originalRefs);
  expect(researchRuntimeRecoveryFacts(state).recoveredInputBytes).toBe(beforeBytes);
  expect(pairedResearchReceipts(state.messages)).toHaveLength(1);
  const result = budgetResearchContext(state, prepared(state), 4000);
  expect(result.recovery?.pendingRefs).toEqual(originalRefs);
  expect(result.messages).toContain(latest.call);
  expect(result.messages).toContain(latest.message);
  expect(result.messages).toContain(retainedPage);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(4000);
  expect(serializeResearchContextMessage(state.messages[2]!)).toBe(canonicalSource);
  // The ordinary earlier window may already have omitted every error cycle.
  const restored = budgetResearchContext(state, restoreResearchContextControlCycle(state, prepared(state).slice(0, 6)), 4000);
  expect(restored.messages).toContain(latest.call);
  expect(restored.messages).toContain(latest.message);
  expect(restored.recovery?.pendingRefs).toEqual(originalRefs);
  expect(researchContextRecoveryToolError(state, "security_scan", { operation: "record", action: "append" })).toBeNull();
  const exactFailure = readResearchContext(state, { ...continuation, continueContext: undefined, contextRef: describeResearchContextMessage(state, state.messages.length - 1)!.ref }, { maxPageBytes: 4000 });
  expect(exactFailure.ok).toBe(true);
});

test("unknown errors and unsaved reasoning remain recoverable while actionable failures keep paired siblings", () => {
  const state = fixture();
  const unknown = failure(state, { code: "unrecognized_new_input", visible: "Unsaved hypothesis about a source flow." });
  const unknownIndex = state.messages.indexOf(unknown.message);
  const visibleIndex = state.messages.indexOf(unknown.call);
  failure(state, { malformed: true });
  const malformedIndex = state.messages.length - 1;
  const latest = failure(state, { sibling: true, visible: "Unconsolidated analysis ".repeat(300) });
  const sibling = state.messages.at(-1)!;
  const result = budgetResearchContext(state, prepared(state), 1200);
  const latestRef = describeResearchContextMessage(state, state.messages.indexOf(latest.call))!.ref;
  const latestProjection = result.messages.find((message) => message.id === latest.call.id) as AIMessage;
  expect(latestProjection).toBeDefined();
  expect(latestProjection.content).toContain(latestRef);
  expect(latestProjection.tool_calls).toEqual(latest.call.tool_calls);
  expect(result.recovery?.pendingRefs).toContain(latestRef);
  const exact = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: latestRef }, { maxPageBytes: 16000 });
  expect(exact.ok).toBe(true);
  if (exact.ok) expect(exact.result.text).toBe(serializeResearchContextMessage(latest.call)!);
  expect(result.messages).toContain(latest.message);
  expect(result.messages).toContain(sibling);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(1200);
  const irreducible = budgetResearchContext(state, prepared(state), 600);
  expect(irreducible.messages).toContain(latest.message);
  expect(irreducible.messages).toContain(sibling);
  expect(estimateTokenCount(irreducible.messages)).toBeGreaterThan(600); // Actual provider preflight rejects irreducible correction overhead.
  for (const index of [unknownIndex, visibleIndex, malformedIndex]) expect(result.recovery?.pendingRefs).toContain(describeResearchContextMessage(state, index)!.ref);
});

test("restored control batches cross ordinary provider normalization and host-sidecar removal before budget retries", async () => {
  const { preModelNode } = await import("../../src/nodes/pre-model");
  const { COMPUTER_RESULT_DURABLE_SIDECAR_KEY } = await import("../../src/tools/computer/model-result-projector");
  const { activateModelCatalogForTests } = await import("../helpers/activate-model-catalog");
  const { resetRuntimeModelCatalog } = await import("../../src/config/model-catalog/runtime-catalog");
  const { ToolCatalog, initToolCatalog } = await import("@nautilo/catalog");
  const { registerAllTools } = await import("../../src/tools/register-all");
  const catalog = new ToolCatalog(); registerAllTools(catalog); initToolCatalog(catalog);
  await activateModelCatalogForTests(["openai:gpt-5.6-sol"]);
  try {
    const state = fixture();
    Object.assign(state, { model: "openai:gpt-5.6-sol", actorRole: "owner", agentId: "test-agent", personaId: "owner", assistantName: "Genie",
      source: "tui", roomId: "", roomRoster: [], currentThreadId: "", langgraphThreadId: "", soulFile: "", memoryBrief: "", memoryDelta: "",
      turnId: "", skills: [], engagedSkillNames: [], artifactRefs: [], activatedToolNames: [], approvedToolCalls: [], pendingApproval: [],
      currentFolder: "", workspacePath: "", subagentDepth: 1, subagentMaxDepth: 3, awaitFromUserIds: [], taskRun: true });
    const latest = failure(state, { sibling: true, visible: "Retain this unsaved causal note." });
    const sibling = state.messages.at(-1) as ToolMessage;
    latest.call.tool_calls![0]!.id = "control:1";
    latest.call.tool_calls![0]!.args = { operation: "record", action: "append", entry: { kind: "evidence", summary: "Exact unsaved draft after a validation failure." } };
    latest.message.content = localToolControlFailure("security_scan", latest.call.tool_calls![0]!.args, "invalid_request", "Correct the evidence record and retry; this draft was not saved.");
    latest.call.tool_calls![1]!.id = "sibling:2";
    latest.message.tool_call_id = "control:1"; sibling.tool_call_id = "sibling:2";
    sibling.additional_kwargs[COMPUTER_RESULT_DURABLE_SIDECAR_KEY] = { privateDiagnostic: "HOST_ONLY_TEST_MARKER" };
    const canonical = JSON.stringify(state.messages);
    const result = await preModelNode(state);
    const messages = result.preparedMessages!;
    const call = messages.find((message) => AIMessage.isInstance(message) && message.tool_calls?.some((tool) => tool.id === "control_1")) as AIMessage;
    expect(call).toBeDefined();
    expect(call.content).toContain("Retain this unsaved causal note.");
    expect(call.tool_calls?.[0]?.args["entry"]).toEqual({ kind: "evidence", summary: "Exact unsaved draft after a validation failure." });
    for (const id of ["control_1", "sibling_2"]) expect(messages.some((message) => ToolMessage.isInstance(message) && message.tool_call_id === id)).toBe(true);
    expect(JSON.stringify(messages)).not.toContain("HOST_ONLY_TEST_MARKER");
    const retry = budgetResearchContext({ ...state, researchContextRecovery: result.researchContextRecovery ?? null }, messages, estimateTokenCount(messages) + 100);
    for (const id of ["control_1", "sibling_2"]) expect(retry.messages.some((message) => ToolMessage.isInstance(message) && message.tool_call_id === id)).toBe(true);
    expect(JSON.stringify(retry.messages)).not.toContain("HOST_ONLY_TEST_MARKER");
    expect(JSON.stringify(state.messages)).toBe(canonical);
  } finally { resetRuntimeModelCatalog(); }
});
