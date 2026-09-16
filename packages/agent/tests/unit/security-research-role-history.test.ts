import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { load } from "@langchain/core/load";
import { securityScanToolResultSchema, type SecurityScanLedgerRecord } from "@nautilo/types";
import type { NautiloState } from "../../src/agent/state";
import { prepareResearchRoleHistory } from "../../src/tools/security/research-role-history";
import { deriveResearchWorkContext, performResearchHandoff } from "../../src/tools/security/research-work-context";
import { budgetResearchContext } from "../../src/tools/security/research-context-rollover";
import { describeResearchContextIndex, describeResearchContextMessage, readResearchContext, serializeResearchContextMessage } from "../../src/tools/security/research-context";
import { estimateTokenCount } from "../../src/utils/history-manager";

const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openai:gpt-5.6-sol" };
function append(state: NautiloState, name: string, args: Record<string, unknown>, content: string) {
  const id = `call:${state.messages.length}`;
  const call = new AIMessage({ id: `ai:${id}`, content: "", tool_calls: [{ id, name, args }] });
  const result = new ToolMessage({ id: `tm:${id}`, name, tool_call_id: id, status: "success", content });
  state.messages.push(call, result);
  return { call, result, index: state.messages.length - 1 };
}
function save(state: NautiloState, id: string, entry: SecurityScanLedgerRecord["entry"]) {
  const value = { ok: true, operation: "record", result: { codeEvidence: [], record: { id, revision: 1, entry,
    createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z", createdBy: author, updatedBy: author } } };
  securityScanToolResultSchema.parse(value);
  append(state, "security_scan", { version: "security-scan-v1", operation: "record", action: "append", entry }, JSON.stringify(value));
}
function fixture() {
  const state = { messages: [new HumanMessage("Audit the authorized repository and preserve material notes.")], userId: "owner",
    currentTaskId: author.taskId, currentTaskRunId: author.taskRunId, subagentRun: true, toolWhitelist: ["file", "security_scan"],
    model: author.modelId, researchContextRecovery: null, researchContextPageBytes: null } as unknown as NautiloState;
  const status = { ok: true, operation: "start", result: { version: "security-scan-v1", scanId: "scan_current", state: "active", phase: "researching",
    terminalState: null, mode: "deep_research", targetFingerprint: "a".repeat(64), modelId: author.modelId, modelState: "running",
    completedSteps: 1, totalSteps: 2, lanes: ["gitleaks", "osv_scanner", "trivy", "semgrep"].map((probe) => ({ probe,
      state: "unavailable", observationCount: 0, coverage: "limited", error: { code: "probe_unavailable", message: "Unavailable in this fixture.", retryable: false } })), coverage: [], hypotheses: [] } };
  securityScanToolResultSchema.parse(status);
  append(state, "security_scan", { version: "security-scan-v1", operation: "start", mode: "deep_research", targetDirectory: "fixture" }, JSON.stringify(status));
  const archived = append(state, "file", { command: "read", path: "identity/tokens.ts" }, "ARCHIVED_SOURCE 🦀\n".repeat(3000));
  save(state, "unit_identity", { kind: "review_unit", summary: "Trace identity admission.", surfaceKey: "identity", paths: ["identity/tokens.ts"],
    state: "unreviewed", trace: "Trace token issuance through consumption.", notes: "Check admission and revocation.", evidenceRefs: [], counterevidenceRefs: [], openRecordIds: [] });
  save(state, "checkpoint_assign", { kind: "checkpoint", summary: "Saved the repository plan and prior inspection.", nextWork: "Investigate identity admission.", openRecordIds: ["unit_identity"], evidenceRefs: [] });
  const args = { version: "security-scan-v1", operation: "handoff", role: "investigator", handoffRecordId: "checkpoint_assign", unitRecordId: "unit_identity", expectedRevision: 1 };
  const handoff = append(state, "security_scan", args, "");
  state.messages.pop();
  const receipt = performResearchHandoff(state, args);
  if (!receipt.ok) throw Error(receipt.error.message);
  const accepted = new ToolMessage({ id: handoff.result.id!, name: "security_scan", tool_call_id: handoff.result.tool_call_id, status: "success", content: JSON.stringify(receipt) });
  state.messages.push(accepted);
  return { state, archived, handoff: { call: handoff.call, result: accepted }, startIndex: state.messages.length - 2 };
}

test("an accepted role transition isolates its working history while canonical source stays exactly readable", () => {
  const { state, archived, handoff, startIndex } = fixture();
  const canonical = JSON.stringify(state.messages);
  const sourceRef = describeResearchContextMessage(state, archived.index)!;
  const protectedHandoff = new AIMessage({ id: handoff.call.id!, tool_calls: handoff.call.tool_calls!, content: "Protected handoff text" });
  const protectedHistory = state.messages.map((message) => message === handoff.call ? protectedHandoff : message);
  const history = prepareResearchRoleHistory(state, protectedHistory);
  expect(deriveResearchWorkContext(state)?.startIndex).toBe(startIndex);
  expect(history).toEqual([state.messages[0]!, protectedHandoff, handoff.result]);
  expect(JSON.stringify(state.messages)).toBe(canonical);
  const page = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: sourceRef.ref, contextBytes: 200 }, { maxPageBytes: 4000 });
  expect(page.ok).toBe(true);
  if (page.ok) expect(page.result.text).toBe(Buffer.from(serializeResearchContextMessage(archived.result)!, "utf8").subarray(0, page.result.endByte).toString("utf8"));
  expect(describeResearchContextMessage(state, archived.index)).toEqual(sourceRef);
});

test("unknown protected input retains the whole old cycle without restoring raw bytes", () => {
  const { state, archived } = fixture();
  const protectedResult = new ToolMessage({ name: "file", tool_call_id: archived.result.tool_call_id, content: "Protected replacement; preserve this unknown input." });
  const history = prepareResearchRoleHistory(state, state.messages.map((message) => message === archived.result ? protectedResult : message));
  expect(history).toContain(protectedResult);
  expect(history).toContain(archived.call);
  expect(history).not.toContain(archived.result);
  expect(JSON.stringify(history)).not.toContain("ARCHIVED_SOURCE");
  const budget = budgetResearchContext(state, [new SystemMessage("Audit carefully."), ...history], 2000);
  expect(budget.messages).toContain(protectedResult);
  expect(budget.messages).toContain(archived.call);
  expect(budget.recovery).toBeNull();
});

test("role rotation retires old runtime corrections while retaining real Human instructions and current feedback", () => {
  const { state, handoff } = fixture();
  const oldCorrection = new HumanMessage({ content: "Return to coordinator; reviewer cannot finalize.", additional_kwargs: { nautilo_research_continuation: true } });
  const userInstruction = new HumanMessage("Also investigate the import boundary.");
  state.messages.splice(state.messages.indexOf(handoff.call), 0, oldCorrection, userInstruction);
  const currentCorrection = new HumanMessage({ content: "Save the current source notes.", additional_kwargs: { nautilo_research_continuation: true } });
  state.messages.push(currentCorrection);
  const canonical = JSON.stringify(state.messages);
  const history = prepareResearchRoleHistory(state, state.messages);
  expect(history).not.toContain(oldCorrection);
  expect(history).toContain(userInstruction);
  expect(history).toContain(currentCorrection);
  expect(history).toContain(state.messages[0]!);
  expect(JSON.stringify(state.messages)).toBe(canonical);
});

test("new oversized source keeps global exact refs across role projection and tighter provider retries", () => {
  const { state, archived } = fixture();
  const current = append(state, "file", { command: "read", path: "identity/consume.ts" }, "CURRENT_SOURCE 🦀\n".repeat(4000));
  const canonical = JSON.stringify(state.messages);
  const prepared = [new SystemMessage("Audit carefully."), ...prepareResearchRoleHistory(state, state.messages)];
  const budget = budgetResearchContext(state, prepared, 3000);
  const currentRef = describeResearchContextMessage(state, current.index)!.ref;
  expect(budget.recovery?.pendingRefs).toContain(currentRef);
  expect(budget.recovery?.pendingRefs).not.toContain(describeResearchContextMessage(state, archived.index)!.ref);
  const retry = budgetResearchContext({ ...state, researchContextRecovery: budget.recovery }, budget.messages, 2500);
  expect(retry.recovery?.pendingRefs).toContain(currentRef);
  expect(estimateTokenCount(retry.messages)).toBeLessThanOrEqual(2500);
  expect(JSON.stringify(state.messages)).toBe(canonical);
});

test("a role boundary cannot erase existing earlier pending source debt", () => {
  const { state, archived } = fixture();
  const throughIndex = state.messages.length - 1;
  const ref = describeResearchContextMessage(state, archived.index)!.ref;
  state.researchContextRecovery = { taskRunId: author.taskRunId, throughIndex, indexRef: describeResearchContextIndex(state, throughIndex)!.ref, pendingRefs: [ref] };
  const result = budgetResearchContext(state, [new SystemMessage("Audit carefully."), ...prepareResearchRoleHistory(state, state.messages)], 3000);
  expect(result.recovery?.pendingRefs).toContain(ref);
});

test("constructor checkpoint restart preserves role boundary and canonical source identity; foreign runs remain legacy", async () => {
  const { state, archived } = fixture();
  const restored = { ...state, messages: await Promise.all(state.messages.map((message) => load<BaseMessage>(JSON.stringify(message)))) };
  expect(deriveResearchWorkContext(restored)).toEqual(deriveResearchWorkContext(state));
  expect(describeResearchContextMessage(restored, archived.index)).toEqual(describeResearchContextMessage(state, archived.index));
  expect(prepareResearchRoleHistory(restored, restored.messages).map((message) => message.id)).toEqual(prepareResearchRoleHistory(state, state.messages).map((message) => message.id));
  const foreign = { ...state, currentTaskRunId: "33333333-3333-4333-8333-333333333333" };
  expect(deriveResearchWorkContext(foreign)).toBeNull();
  expect(prepareResearchRoleHistory(foreign, foreign.messages)).toEqual(foreign.messages);
});

test("the real pre-model path prepares only the active role through normal provider transforms", async () => {
  const { preModelNode } = await import("../../src/nodes/pre-model");
  const { activateModelCatalogForTests } = await import("../helpers/activate-model-catalog");
  const { resetRuntimeModelCatalog } = await import("../../src/config/model-catalog/runtime-catalog");
  const { ToolCatalog, initToolCatalog } = await import("@nautilo/catalog");
  const { registerAllTools } = await import("../../src/tools/register-all");
  const { COMPUTER_RESULT_DURABLE_SIDECAR_KEY } = await import("../../src/tools/computer/model-result-projector");
  const catalog = new ToolCatalog(); registerAllTools(catalog); initToolCatalog(catalog);
  await activateModelCatalogForTests([author.modelId]);
  try {
    const { state, handoff } = fixture();
    Object.assign(state, { actorRole: "owner", agentId: "test-agent", personaId: "owner", assistantName: "Genie", source: "tui", roomId: "",
      roomRoster: [], currentThreadId: "", langgraphThreadId: "", soulFile: "", memoryBrief: "", memoryDelta: "", turnId: "", skills: [],
      engagedSkillNames: [], artifactRefs: [], activatedToolNames: [], approvedToolCalls: [], pendingApproval: [], currentFolder: "", workspacePath: "",
      subagentDepth: 1, subagentMaxDepth: 3, awaitFromUserIds: [], taskRun: true });
    const current = append(state, "file", { command: "read", path: "identity/consume.ts" }, "ACTIVE_SOURCE: consume verifies the token.");
    current.result.additional_kwargs[COMPUTER_RESULT_DURABLE_SIDECAR_KEY] = { privateDiagnostic: "ROLE_HOST_ONLY_MARKER" };
    const canonical = JSON.stringify(state.messages);
    const result = await preModelNode(state);
    const prepared = result.preparedMessages!;
    expect(result.messages).toBe(state.messages);
    expect(JSON.stringify(prepared)).not.toContain("ARCHIVED_SOURCE");
    expect(JSON.stringify(prepared)).not.toContain("ROLE_HOST_ONLY_MARKER");
    expect(JSON.stringify(prepared)).toContain("ACTIVE_SOURCE");
    expect(JSON.stringify(prepared)).toContain("ACTIVE RESEARCH WORKSPACE");
    const expectedIds = [handoff.result.tool_call_id, current.result.tool_call_id].map((id) => id.replaceAll(":", "_"));
    for (const id of expectedIds) {
      expect(prepared.some((message) => AIMessage.isInstance(message) && message.tool_calls?.some((call) => call.id === id))).toBe(true);
      expect(prepared.some((message) => ToolMessage.isInstance(message) && message.tool_call_id === id)).toBe(true);
    }
    const retry = budgetResearchContext({ ...state, researchContextRecovery: result.researchContextRecovery ?? null }, prepared, estimateTokenCount(prepared) + 100);
    expect(JSON.stringify(retry.messages)).not.toContain("ARCHIVED_SOURCE");
    expect(JSON.stringify(retry.messages)).not.toContain("ROLE_HOST_ONLY_MARKER");
    expect(JSON.stringify(state.messages)).toBe(canonical);
  } finally { resetRuntimeModelCatalog(); }
});
