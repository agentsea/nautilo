import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { assertMessageInvariants } from "@nautilo/message-invariants";
import { securityScanToolResultSchema, type SecurityScanLedgerRecord } from "@nautilo/types";
import type { NautiloState } from "../../src/agent/state";
import { localToolControlFailure } from "../../src/tools/security/research-control-feedback";
import { budgetResearchContext, prepareResearchContextOrigins, restoreResearchContextControlCycle } from "../../src/tools/security/research-context-rollover";
import { describeResearchContextIndex, describeResearchContextMessage } from "../../src/tools/security/research-context";
import { estimateTokenCount, windowResearchHistory } from "../../src/utils/history-manager";

const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openrouter:z-ai/glm-5.3" };
const system = () => new SystemMessage("Inspect source, preserve research notes and authoritative operation outcomes.");
function state() {
  return { messages: [new HumanMessage("Investigate the authorized repository.")], userId: "owner", currentTaskId: author.taskId,
    currentTaskRunId: author.taskRunId, subagentRun: true, toolWhitelist: ["file", "security_scan"], researchContextRecovery: null } as unknown as NautiloState;
}
function failures(s: NautiloState) {
  const calls = ["first", "second"].map((name) => ({ id: `${name}-${s.messages.length}`, name: "security_scan", args: { operation: "record",
    action: "append", entry: { kind: "review_unit", summary: `Unsaved ${name} behavior draft.` } } }));
  const ai = new AIMessage({ id: `ai-${s.messages.length}`, content: "Keep these independent unfinished investigations.", tool_calls: calls });
  const errors = calls.map((call) => new ToolMessage({ id: `error-${call.id}`, name: call.name, tool_call_id: call.id, status: "error",
    content: localToolControlFailure(call.name, call.args, "invalid_request", "Complete this review-unit entry before retrying.") }));
  s.messages.push(ai, ...errors);
  return { ai, errors };
}
function accepted(s: NautiloState, entry: SecurityScanLedgerRecord["entry"]) {
  const id = `accepted-${s.messages.length}`;
  const ai = new AIMessage({ id: `ai-${id}`, content: "", tool_calls: [{ id, name: "security_scan", args: { operation: "record", action: "append", entry } }] });
  const value = { ok: true, operation: "record", result: { codeEvidence: [], record: { id, revision: 1, entry,
    createdBy: author, updatedBy: author, createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z" } } };
  securityScanToolResultSchema.parse(value);
  const receipt = new ToolMessage({ id: `receipt-${id}`, name: "security_scan", tool_call_id: id, status: "success", content: JSON.stringify(value) });
  s.messages.push(ai, receipt);
  return { ai, receipt };
}
function fixture() {
  const s = state();
  const rejected = failures(s);
  const checkpoint = accepted(s, { kind: "checkpoint", summary: "Earlier drafts await correction.", nextWork: "Save the complete routing review unit.", openRecordIds: [], evidenceRefs: [] });
  const success = accepted(s, { kind: "review_unit", summary: "Routing behavior investigation.", surfaceKey: "routing", paths: ["routes.ts"],
    state: "in_progress", trace: "Follow request dispatch into handlers.", notes: "Inspect authorization before handler effects.", evidenceRefs: [], counterevidenceRefs: [], openRecordIds: [] });
  return { s, rejected, checkpoint, success };
}
function canonicalPositions(s: NautiloState, messages: readonly BaseMessage[]) {
  return messages.flatMap((message) => {
    const index = s.messages.findIndex((canonical) => canonical === message || (message.id && canonical.id === message.id));
    return index < 0 ? [] : [index];
  });
}
function expectChronological(s: NautiloState, messages: BaseMessage[]) {
  const positions = canonicalPositions(s, messages);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(() => assertMessageInvariants(messages, "research-control-order")).not.toThrow();
}

test("restored rejected batches precede the later checkpoint and complete accepted review unit", () => {
  const { s, rejected, checkpoint, success } = fixture();
  const canonical = JSON.stringify(s.messages);
  const history = [system(), ...windowResearchHistory(s.messages, 20_000).messages];
  expect(history).not.toContain(rejected.ai);
  const restored = restoreResearchContextControlCycle(s, history);
  expect(restored).toEqual([history[0]!, s.messages[0]!, rejected.ai, ...rejected.errors, checkpoint.ai, checkpoint.receipt, success.ai, success.receipt]);
  expectChronological(s, restored);
  expect(restoreResearchContextControlCycle(s, restored)).toEqual(restored);
  expect(JSON.stringify(s.messages)).toBe(canonical);
});

test("a fresh current failure stays after the accepted review unit and all older failures", () => {
  const { s, rejected, success } = fixture();
  const fresh = failures(s);
  const restored = restoreResearchContextControlCycle(s, [system(), ...windowResearchHistory(s.messages, 20_000).messages]);
  expectChronological(s, restored);
  expect(restored.indexOf(rejected.errors[1]!)).toBeLessThan(restored.indexOf(success.receipt));
  expect(restored.slice(-3)).toEqual([fresh.ai, ...fresh.errors]);
});

test("the final budget pass reinserts normalized old corrections before the current success", () => {
  const { s, rejected, success } = fixture();
  const boundary = s.messages.length - 1;
  s.researchContextRecovery = { taskRunId: author.taskRunId, throughIndex: boundary, indexRef: describeResearchContextIndex(s, boundary)!.ref,
    pendingRefs: [describeResearchContextMessage(s, s.messages.indexOf(rejected.ai))!.ref] };
  const canonical = JSON.stringify(s.messages);
  const restored = restoreResearchContextControlCycle(s, [system(), ...s.messages]);
  const origins = prepareResearchContextOrigins(s, restored);
  const normalized = origins.messages.map((message) => AIMessage.isInstance(message)
    ? new AIMessage({ content: message.content, ...(message.id ? { id: message.id } : {}), tool_calls: (message.tool_calls ?? []).map((call) => ({ ...call, id: `provider-${call.id}` })) })
    : ToolMessage.isInstance(message) ? new ToolMessage({ ...message, tool_call_id: `provider-${message.tool_call_id}` }) : message);
  origins.bind(normalized);
  const output = budgetResearchContext(s, normalized, 20_000);
  expectChronological(s, output.messages);
  const acceptedReceipt = output.messages.find((message) => message.id === success.receipt.id);
  expect(acceptedReceipt?.content).toBe(success.receipt.content);
  expect(ToolMessage.isInstance(acceptedReceipt) && acceptedReceipt.tool_call_id).toBe(`provider-${success.receipt.tool_call_id}`);
  expect(output.messages.filter((message) => ToolMessage.isInstance(message) && message.status === "error")).toHaveLength(2);
  expect(estimateTokenCount(output.messages)).toBeLessThanOrEqual(20_000);
  expect(JSON.stringify(s.messages)).toBe(canonical);
});

test("budget resets preserve chronology, mixed tool siblings, and exact canonical drafts", () => {
  const { s, rejected, success } = fixture();
  rejected.ai.content = "Unconsolidated observation with source caveats. ".repeat(1200);
  const siblingCall = { id: "successful-sibling", name: "file", args: { command: "read", path: "routes.ts" } };
  rejected.ai.tool_calls!.push(siblingCall);
  const sibling = new ToolMessage({ id: "sibling-result", name: "file", tool_call_id: siblingCall.id, status: "success", content: "Source output. ".repeat(3000) });
  s.messages.splice(s.messages.indexOf(rejected.errors[1]!) + 1, 0, sibling);
  const canonical = JSON.stringify(s.messages);
  const restored = restoreResearchContextControlCycle(s, [system(), ...windowResearchHistory(s.messages, 1800).messages]);
  const output = budgetResearchContext(s, restored, 1800);
  expectChronological(s, output.messages);
  expect(estimateTokenCount(output.messages)).toBeLessThanOrEqual(1800);
  expect(output.messages.filter((message) => ToolMessage.isInstance(message) && message.status === "error")).toHaveLength(2);
  expect(output.recovery?.pendingRefs).toContain(describeResearchContextMessage(s, s.messages.indexOf(rejected.ai))!.ref);
  expect(output.messages.some((message) => message.id === sibling.id)).toBe(true);
  expect(success.receipt.status).toBe("success");
  expect(JSON.stringify(s.messages)).toBe(canonical);
});

test("missing message IDs use exact origin bindings without substituting canonical tool IDs", () => {
  const { s, success } = fixture();
  for (const message of s.messages) delete message.id;
  const restored = restoreResearchContextControlCycle(s, [system(), ...windowResearchHistory(s.messages, 20_000).messages]);
  const origins = prepareResearchContextOrigins(s, restored);
  const transformed = origins.messages.map((message) => AIMessage.isInstance(message)
    ? new AIMessage({ content: message.content, ...(message.id ? { id: message.id } : {}), tool_calls: (message.tool_calls ?? []).map((call) => ({ ...call, id: `normalized-${call.id}` })) })
    : ToolMessage.isInstance(message) ? new ToolMessage({ ...message, tool_call_id: `normalized-${message.tool_call_id}` }) : message);
  origins.bind(transformed);
  const output = budgetResearchContext(s, transformed, 20_000);
  expect(() => assertMessageInvariants(output.messages, "idless-research-order")).not.toThrow();
  const receipt = output.messages.find((message) => ToolMessage.isInstance(message) && message.tool_call_id === `normalized-${success.receipt.tool_call_id}`);
  expect(receipt?.content).toBe(success.receipt.content);
  expect(output.messages.at(-1)).toBe(receipt);
});

test("duplicate message IDs do not erase the newer success or assign an unknown cycle a guessed origin", () => {
  const { s, rejected, success } = fixture();
  rejected.ai.id = "duplicate-message-id";
  success.ai.id = "duplicate-message-id";
  const unknown = new AIMessage({ id: "duplicate-message-id", content: "Unmapped independent material.", tool_calls: [{ id: "unknown-call", name: "file", args: { command: "read", path: "other.ts" } }] });
  const unknownResult = new ToolMessage({ tool_call_id: "unknown-call", name: "file", content: "Unmapped result bytes." });
  const restored = restoreResearchContextControlCycle(s, [system(), s.messages[0]!, unknown, unknownResult, success.ai, success.receipt]);
  expect(restored).toContain(success.ai);
  expect(restored).toContain(success.receipt);
  expect(restored).toContain(rejected.ai);
  expect(restored.indexOf(rejected.ai)).toBeLessThan(restored.indexOf(success.ai));
  expect(restored[restored.indexOf(unknown) + 1]).toBe(unknownResult);
  expect(() => assertMessageInvariants(restored, "ambiguous-research-order")).not.toThrow();
});
