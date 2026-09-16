import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { securityScanToolResultSchema } from "@nautilo/types";
import type { NautiloState } from "../../src/agent/state";
import { describeResearchContextIndex, describeResearchContextMessage, readResearchContext, serializeResearchContextMessage } from "../../src/tools/security/research-context";
import { budgetResearchContext, currentResearchContextRecovery, remainingResearchContextRefs } from "../../src/tools/security/research-context-rollover";

const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openai:gpt-5.6-sol" };
const evidence = { id: "code_evidence_1", relativePath: "src/auth.ts", startLine: 1, endLine: 2,
  fileSha256: "a".repeat(64), rangeSha256: "b".repeat(64), rootFingerprint: "c".repeat(64),
  capturedAt: "2026-09-07T00:00:00.000Z", gitHead: "d".repeat(40), gitDirty: false };
function setup() {
  return { messages: [new HumanMessage("Audit all authorized code and save material notes."),
    new AIMessage({ id: "ai:source", content: "Read the complete source.", tool_calls: [{ id: "source", name: "file", args: { command: "read", path: "src/auth.ts" } }] }),
    new ToolMessage({ id: "tm:source", name: "file", tool_call_id: "source", content: "Actual unreviewed source bytes. ".repeat(6000) })],
    userId: "owner", currentTaskId: author.taskId, currentTaskRunId: author.taskRunId, subagentRun: true,
    toolWhitelist: ["file", "security_scan"], researchContextRecovery: null, researchContextPageBytes: null,
  } as unknown as NautiloState;
}
function append(state: NautiloState, n: number, variant = "accepted") {
  const id = `save-${n}`;
  const summary = "Classify and trace the authorized behavior before deciding coverage. ".repeat(28);
  const entry = n === 0 ? { kind: "repository_map", summary, surfaces: [], evidenceRefs: [] }
    : { kind: "review_unit", summary, surfaceKey: `surface_${n}`, paths: [`src/unit-${n}.ts`], state: "in_progress",
      trace: "Pending source investigation.", notes: "Do not treat planning as reviewed code.", evidenceRefs: [], counterevidenceRefs: [], openRecordIds: [] };
  const record = { id: `record_${n}`, revision: 1, createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z",
    createdBy: author, updatedBy: { ...author, ...(variant === "wrong_task" ? { taskId: "33333333-3333-4333-8333-333333333333" } : {}),
      ...(variant === "wrong_run" ? { taskRunId: "44444444-4444-4444-8444-444444444444" } : {}) }, entry };
  const receipt = { ok: true, operation: "record", result: { record, codeEvidence: variant === "new_evidence" ? [evidence] : [] } };
  if (variant !== "malformed") securityScanToolResultSchema.parse(receipt);
  state.messages.push(new AIMessage({ id: `ai:${id}`, content: variant === "reasoning" ? "Unsaved insight about a revocation race. ".repeat(2000) : "",
    tool_calls: [{ id, name: "security_scan", args: { version: "security-scan-v1", operation: "record", action: "append", entry } }] }),
  new ToolMessage({ id: `tm:${id}`, name: "security_scan", tool_call_id: variant === "unpaired" ? `orphan-${id}` : id,
    ...(variant === "rejected" ? { status: "error" as const } : {}), content: variant === "malformed" ? JSON.stringify({ ...receipt, unexpected: true }) : JSON.stringify(receipt) }));
  return state.messages.length - 1;
}
function queueAll(state: NautiloState) {
  const throughIndex = state.messages.length - 1;
  state.researchContextRecovery = { taskRunId: author.taskRunId, throughIndex, indexRef: describeResearchContextIndex(state, throughIndex)!.ref,
    pendingRefs: state.messages.flatMap((_, index) => { const ref = describeResearchContextMessage(state, index)?.ref; return ref ? [ref] : []; }) };
  return state.researchContextRecovery;
}

test("ten accepted empty-evidence acknowledgements leave the mandatory source queue and retain exact historical reload handles", () => {
  const state = setup();
  for (let index = 0; index < 10; index++) append(state, index);
  const canonical = JSON.stringify(state.messages);
  const prior = queueAll(state);
  const sourceRef = describeResearchContextMessage(state, 2)!.ref;
  const remaining = remainingResearchContextRefs(state, prior);
  expect(remaining).toEqual([describeResearchContextMessage(state, 1)!.ref, sourceRef]);
  const result = budgetResearchContext(state, [new SystemMessage("Immutable research instructions. ".repeat(1500)), ...state.messages], 26_000);
  expect(result.recovery!.pendingRefs).toContain(sourceRef);
  for (let index = 3; index < state.messages.length; index++) expect(result.recovery!.pendingRefs).not.toContain(describeResearchContextMessage(state, index)!.ref);
  const projections = result.messages.flatMap((message) => {
    if (!ToolMessage.isInstance(message) || typeof message.content !== "string") return [];
    try { const value = JSON.parse(message.content) as { savedResearchRecord?: { id: string; revision: number; kind: string; latestRecord: { recordIds: string[] }; exactHistoricalReceipt: { contextRef: string } } };
      return value.savedResearchRecord ? [value.savedResearchRecord] : []; } catch { return []; }
  });
  expect(projections.length).toBeGreaterThan(0);
  for (const projection of projections) {
    expect(projection.revision).toBe(1);
    expect(projection.latestRecord.recordIds).toEqual([projection.id]);
    expect(projection.exactHistoricalReceipt.contextRef).toStartWith("research-context:");
    expect(["repository_map", "review_unit"]).toContain(projection.kind);
  }
  expect(JSON.stringify(state.messages)).toBe(canonical);
});

test("rejected, malformed, unpaired, foreign-author writes remain mandatory; unsaved assistant reasoning is separate", () => {
  for (const variant of ["rejected", "malformed", "unpaired", "wrong_task", "wrong_run", "reasoning"]) {
    const state = setup();
    const receiptIndex = append(state, 1, variant);
    const recovery = queueAll(state);
    const refs = remainingResearchContextRefs(state, recovery);
    expect(refs).toContain(describeResearchContextMessage(state, receiptIndex - 1)!.ref);
    if (variant !== "reasoning") expect(refs).toContain(describeResearchContextMessage(state, receiptIndex)!.ref);
    else expect(refs).not.toContain(describeResearchContextMessage(state, receiptIndex)!.ref);
  }
});

test("another owner cannot prune saved-record references from the original bound recovery state", () => {
  const state = setup(); append(state, 0); const recovery = queueAll(state);
  const other = { ...state, userId: "another-owner" } as NautiloState;
  expect(currentResearchContextRecovery(other)).toBeNull();
  expect(remainingResearchContextRefs(other, recovery)).toEqual(recovery.pendingRefs);
});


test("accepted evidence acknowledgements retain every provenance field without manufacturing source coverage", () => {
  const state = setup();
  const receiptIndex = append(state, 1, "new_evidence");
  queueAll(state);
  const canonical = JSON.stringify(state.messages);
  const result = budgetResearchContext(state, [new SystemMessage("Authorized research instructions."), ...state.messages], 2400);
  const receiptRef = describeResearchContextMessage(state, receiptIndex)!.ref;
  const sourceRef = describeResearchContextMessage(state, 2)!.ref;
  expect(result.recovery!.pendingRefs).not.toContain(receiptRef);
  expect(result.recovery!.pendingRefs).toContain(sourceRef);
  const projected = result.messages.find((message) => message.id === "tm:save-1");
  if (!projected || typeof projected.content !== "string") throw new Error("Expected visible evidence acknowledgement");
  const value = JSON.parse(projected.content) as { savedResearchRecord: { codeEvidence: unknown; exactHistoricalReceipt: { contextRef: string } } };
  expect(value.savedResearchRecord.codeEvidence).toEqual([evidence]);
  expect(value.savedResearchRecord.exactHistoricalReceipt.contextRef).toBe(receiptRef);
  expect(projected.content).not.toContain("Actual unreviewed source bytes.");
  expect(JSON.stringify(state.messages)).toBe(canonical);
});


test("metadata beyond the selected workspace is explicitly unpresented and remains exactly retrievable", () => {
  const state = setup();
  const receiptIndex = append(state, 1, "new_evidence");
  const message = state.messages[receiptIndex]!;
  if (typeof message.content !== "string") throw new Error("Expected text receipt");
  const receipt = securityScanToolResultSchema.parse(JSON.parse(message.content));
  if (!receipt.ok || receipt.operation !== "record") throw new Error("Expected record receipt");
  receipt.result.codeEvidence = Array.from({ length: 20 }, (_, index) => ({ ...evidence, id: `code_${index}` }));
  securityScanToolResultSchema.parse(receipt);
  message.content = JSON.stringify(receipt);
  queueAll(state);
  const canonical = JSON.stringify(state.messages);
  const result = budgetResearchContext(state, [new SystemMessage("Authorized research instructions."), ...state.messages], 2400);
  const projected = result.messages.find((item) => item.id === "tm:save-1");
  if (!projected || typeof projected.content !== "string") throw new Error("Expected explicit metadata omission");
  const value = JSON.parse(projected.content) as { savedResearchRecord: { codeEvidence?: unknown; metadataNotPresented: { codeEvidenceCount: number }; exactHistoricalReceipt: { contextRef: string }; latestRecord: { recordIds: string[] } } };
  expect(value.savedResearchRecord.codeEvidence).toBeUndefined();
  expect(value.savedResearchRecord.metadataNotPresented.codeEvidenceCount).toBe(20);
  expect(value.savedResearchRecord.latestRecord.recordIds).toEqual(["record_1"]);
  expect(result.recovery!.pendingRefs).toContain(describeResearchContextMessage(state, 2)!.ref);
  let cursor: string | undefined;
  let recovered = "";
  do {
    const page = readResearchContext(state, { version: "security-scan-v1", operation: "context",
      contextRef: value.savedResearchRecord.exactHistoricalReceipt.contextRef, ...(cursor ? { contextCursor: cursor } : {}) }, { maxPageBytes: 4000 });
    if (!page.ok) throw new Error(page.error.message);
    recovered += page.result.text;
    cursor = page.result.nextCursor ?? undefined;
  } while (cursor);
  const exact = serializeResearchContextMessage(message);
  if (exact === null) throw new Error("Expected visible historical receipt");
  expect(recovered).toBe(exact);
  expect(JSON.stringify(state.messages)).toBe(canonical);
});


test("saved call-only content blocks are not unsaved reasoning, while every visible text block remains required", () => {
  for (const content of [[], [{ type: "reasoning", text: "Non-visible provider block" }], [{ type: "text", text: "" }],
    [{ type: "text", text: "A substantive unsaved observation." }], ["A substantive string block."]]) {
    const state = setup();
    const receiptIndex = append(state, 0);
    state.messages[receiptIndex - 1]!.content = content as unknown as NautiloState["messages"][number]["content"];
    const recovery = queueAll(state);
    const assistantRef = describeResearchContextMessage(state, receiptIndex - 1)!.ref;
    const remaining = remainingResearchContextRefs(state, recovery);
    const visibleText = content.some((block) => typeof block === "string" ? block.length > 0 : block.type === "text" && block.text.length > 0);
    expect(remaining.includes(assistantRef)).toBe(visibleText);
  }
});
