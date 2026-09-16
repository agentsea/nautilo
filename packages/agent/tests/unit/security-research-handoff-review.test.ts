import { afterEach, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { assignStableToolMessageId } from "@nautilo/message-invariants";
import { clearToolCatalog, initToolCatalog, ToolCatalog } from "@nautilo/catalog";
import { SECURITY_SCAN_INITIAL_LANES, type SecurityScanLedgerRecord } from "@nautilo/types";
import type { NautiloState } from "../../src/agent/state";
import { buildResearchWorkContextMessage, performResearchHandoff } from "../../src/tools/security/research-work-context";
import { prepareResearchRoleHistory } from "../../src/tools/security/research-role-history";
import { readResearchContext } from "../../src/tools/security/research-context";
import { createNautiloToolInvocationSession, createServerToolInvocationContext, setRelayRegistry, type ToolRelayRegistry } from "../../src/tools/invocation-service";
import { registerAllTools } from "../../src/tools/register-all";
const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openrouter:z-ai/glm-5.3" };
function pair(state: NautiloState, args: Record<string, unknown>, value: unknown, name = "security_scan") {
  const id = `call_${state.messages.length}`;
  state.messages.push(new AIMessage({ id: `ai_${id}`, content: "", tool_calls: [{ id, name, args }] }));
  const message = new ToolMessage({ name, tool_call_id: id, status: "success", additional_kwargs: { nautilo_tool_status: "success", ...(name === "file" ? { nautilo_file_operation: args["command"] } : {}) }, content: JSON.stringify(value) });
  assignStableToolMessageId(message); state.messages.push(message);
}
function stateFixture() {
  const state = { messages: [new HumanMessage("Audit the requested source")], userId: "owner", currentTaskId: author.taskId, currentTaskRunId: author.taskRunId,
    subagentRun: true, taskRun: true, researchWorkEnabled: true, toolWhitelist: ["file", "security_scan"], model: author.modelId } as unknown as NautiloState;
  pair(state, { operation: "start" }, { ok: true, operation: "start", result: { version: "security-scan-v1", scanId: "scan_fixture", state: "active", phase: "researching", terminalState: null,
    mode: "deep_research", modelId: author.modelId, modelState: "running", completedSteps: 1, totalSteps: 2, lanes: SECURITY_SCAN_INITIAL_LANES, coverage: [], hypotheses: [] } });
  return state;
}
function save(state: NautiloState, id: string, entry: SecurityScanLedgerRecord["entry"]) {
  pair(state, { version: "security-scan-v1", operation: "record", action: "append", entry }, { ok: true, operation: "record", result: { codeEvidence: [], record: { id, entry, revision: 1,
    createdBy: author, updatedBy: author, createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z" } } });
}
function handoff(state: NautiloState, fields: Record<string, unknown>) {
  const args = { version: "security-scan-v1", operation: "handoff", ...fields };
  const id = `handoff_${state.messages.length}`;
  state.messages.push(new AIMessage({ id: `ai_${id}`, content: "", tool_calls: [{ id, name: "security_scan", args }] }));
  const receipt = performResearchHandoff(state, args);
  if (!receipt.ok) throw Error(receipt.error.message);
  expect(receipt.ok).toBe(true);
  const message = new ToolMessage({ name: "security_scan", tool_call_id: id, content: JSON.stringify(receipt), status: "success" });
  assignStableToolMessageId(message); state.messages.push(message);
}
afterEach(() => { clearToolCatalog(); setRelayRegistry(null); });

test("returned coordinator can reconstruct the exact reviewed draft from its prompt reference; stale and foreign reads fail", () => {
  const state = stateFixture();
  save(state, "draft_plan", { kind: "checkpoint", summary: "Review complete proposed report", nextWork: "Independently verify claims", openRecordIds: [], evidenceRefs: [] });
  const draft = "# Complete audit\nExact findings, counterexamples 🦀 and limitations.\n".repeat(150);
  handoff(state, { role: "reviewer", handoffRecordId: "draft_plan", reportDraft: draft });
  const draftIndex = state.messages.length - 2;
  pair(state, { command: "read", path: "source.ts" }, "Inspected current source", "file");
  save(state, "review_notes", { kind: "counterevidence", summary: "Verified report claims against fresh source", evidenceRefs: [{ kind: "code_evidence", id: "code_review" }] });
  save(state, "review_checkpoint", { kind: "checkpoint", summary: "Report independently checked", nextWork: "Return accepted draft", openRecordIds: [], evidenceRefs: [{ kind: "ledger_record", id: "review_notes" }] });
  handoff(state, { role: "coordinator", handoffRecordId: "review_checkpoint", reviewDecision: "accepted" });
  const canonical = JSON.stringify(state.messages);
  expect(JSON.stringify(prepareResearchRoleHistory(state, state.messages))).not.toContain("# Complete audit");
  const prompt = buildResearchWorkContextMessage(state)!;
  const control = JSON.parse(prompt.split("\n")[1]!) as { reviewedDraft: { contextRef: string } };
  const args = { version: "security-scan-v1", operation: "context", contextRef: control.reviewedDraft.contextRef };
  let text = ""; let cursor: string | undefined;
  do {
    const page = readResearchContext(state, { ...args, ...(cursor ? { contextCursor: cursor } : {}) }, { maxPageBytes: 2000 });
    if (!page.ok) throw Error(page.error.message);
    text += page.result.text; cursor = page.result.nextCursor ?? undefined;
  } while (cursor);
  const visible = JSON.parse(text) as { toolCalls: Array<{ args: { reportDraft: string } }> };
  expect(visible.toolCalls[0]!.args.reportDraft).toBe(draft);
  expect(JSON.stringify(state.messages)).toBe(canonical);
  expect(readResearchContext({ ...state, currentTaskRunId: "foreign" }, args, { maxPageBytes: 2000 }).ok).toBe(false);
  const originalCall = state.messages[draftIndex] as AIMessage;
  originalCall.tool_calls![0]!.args["reportDraft"] = "changed draft";
  expect(readResearchContext(state, args, { maxPageBytes: 2000 }).ok).toBe(false);
});

test("an admitted priorScanId restart cannot dispatch after this TaskRun already owns its scan", async () => {
  const state = stateFixture(); const catalog = new ToolCatalog(); registerAllTools(catalog, { officeCliAvailable: () => false }); initToolCatalog(catalog);
  let dispatched = 0;
  setRelayRegistry({ findByCapabilityForUser: () => ["relay"], getCapabilities: () => ({ canReadWorkspace: true, currentFolderRoot: "/repo", workspaceRoot: "/workspace" }),
    isRelayHeartbeatFresh: () => true, getUserId: () => "owner", getRelaySessionId: () => "session", getDesktopSessionId: () => "desktop", getPairingGeneration: () => "pairing",
    dispatch: async () => { dispatched++; return { status: "ok", result: "unexpected" }; } } as unknown as ToolRelayRegistry);
  Object.assign(state, { approvedToolCalls: [], actorRole: "owner", personaId: "owner", turnId: "turn", agentId: "agent", roomId: "room", currentFolder: "/repo",
    activatedToolNames: ["security_scan"], activatedToolLeases: [], engagedSkillNames: [], memoryAccessEnvelope: null, relayCapabilities: { canReadWorkspace: true }, requiredHostRelays: { restart: "relay" },
    verifiedOrdinaryOrigin: { kind: "local_electron", userId: "owner", actorId: "owner", relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "pairing", requestId: "request" },
    taskReportBackContinuation: { status: "available", relayId: "relay", relaySessionId: "session", desktopSessionId: "desktop", pairingGeneration: "pairing", currentFolder: "/repo", workspacePath: "/workspace" } });
  const args = { version: "security-scan-v1", operation: "start", mode: "deep_research", targetDirectory: ".", priorScanId: "scan_other" };
  state.messages.push(new AIMessage({ content: "", tool_calls: [{ id: "restart", name: "security_scan", args }] }));
  const result = await createNautiloToolInvocationSession(createServerToolInvocationContext(state, () => ({ status: "allowed" }))).invoke({ callId: "restart", toolName: "security_scan", args, authorityRef: "admitted" });
  expect(result.status).toBe("error");
  expect(result.content).toContain("already");
  expect(dispatched).toBe(0);
});

test("review result edits are refused by the real invocation path before ledger dispatch", async () => {
  const state = stateFixture(); const catalog = new ToolCatalog(); registerAllTools(catalog, { officeCliAvailable: () => false }); initToolCatalog(catalog);
  save(state, "review_unit", { kind: "review_unit", summary: "Reviewed behavior", surfaceKey: "identity", paths: ["source.ts"], state: "reviewed", trace: "Guard precedes output", notes: "Checked alternate branch", evidenceRefs: [], counterevidenceRefs: [], openRecordIds: [] });
  save(state, "review_plan", { kind: "checkpoint", summary: "Review exact result", nextWork: "Review", evidenceRefs: [], openRecordIds: [] });
  handoff(state, { role: "reviewer", unitRecordId: "review_unit", expectedRevision: 1, handoffRecordId: "review_plan" });
  let dispatched = 0;
  setRelayRegistry({ findByCapabilityForUser: () => ["relay"], getCapabilities: () => ({ canReadWorkspace: true, currentFolderRoot: "/repo", workspaceRoot: "/workspace" }),
    isRelayHeartbeatFresh: () => true, getUserId: () => "owner", getRelaySessionId: () => "session", getDesktopSessionId: () => "desktop", getPairingGeneration: () => "pairing",
    dispatch: async () => { dispatched++; return { status: "ok", result: "unexpected" }; } } as unknown as ToolRelayRegistry);
  Object.assign(state, { approvedToolCalls: [], actorRole: "owner", personaId: "owner", turnId: "turn", agentId: "agent", roomId: "room", currentFolder: "/repo",
    activatedToolNames: ["security_scan"], activatedToolLeases: [], engagedSkillNames: [], memoryAccessEnvelope: null, relayCapabilities: { canReadWorkspace: true }, requiredHostRelays: { restart: "relay" },
    verifiedOrdinaryOrigin: { kind: "local_electron", userId: "owner", actorId: "owner", relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "pairing", requestId: "request" },
    taskReportBackContinuation: { status: "available", relayId: "relay", relaySessionId: "session", desktopSessionId: "desktop", pairingGeneration: "pairing", currentFolder: "/repo", workspacePath: "/workspace" } });
  const args = { version: "security-scan-v1", operation: "record", action: "update", recordId: "review_unit", expectedRevision: 1, entry: { kind: "review_unit", notes: "Append reviewer notes by rewriting result" } };
  state.messages.push(new AIMessage({ content: "", tool_calls: [{ id: "restart", name: "security_scan", args }] }));
  const result = await createNautiloToolInvocationSession(createServerToolInvocationContext(state, () => ({ status: "allowed" }))).invoke({ callId: "restart", toolName: "security_scan", args, authorityRef: "admitted" });
  expect(result.status).toBe("error");
  expect(result.content).toContain("invalid_request");
  expect(result.content).toContain("separate review notes");
  expect(dispatched).toBe(0);
});
