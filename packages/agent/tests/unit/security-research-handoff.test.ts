import { afterEach, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { assignStableToolMessageId } from "@nautilo/message-invariants";
import { SECURITY_SCAN_INITIAL_LANES, securityScanOperationSchema, securityScanToolResultSchema, type SecurityScanLedgerRecord } from "@nautilo/types";
import { clearToolCatalog, initToolCatalog, ToolCatalog } from "@nautilo/catalog";
import type { NautiloState } from "../../src/agent/state";
import { buildResearchWorkContextMessage, deriveResearchWorkContext, performResearchHandoff, readReviewedResearchReportDraft, researchWorkFinalizationError, researchReviewMutationError } from "../../src/tools/security/research-work-context";
import { modelOutputPreflightNode } from "../../src/nodes/model-output-preflight";
import { createNautiloToolInvocationSession, createServerToolInvocationContext, setRelayRegistry } from "../../src/tools/invocation-service";
import { registerAllTools } from "../../src/tools/register-all";
import { createSecurityScanTool } from "../../src/tools/security/security-scan";

const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openrouter:z-ai/glm-5.3" };
const status = { version: "security-scan-v1", scanId: "scan_fixture", state: "active", phase: "researching", terminalState: null,
  mode: "deep_research", modelId: author.modelId, modelState: "running", completedSteps: 1, totalSteps: 2,
  lanes: SECURITY_SCAN_INITIAL_LANES, coverage: [], hypotheses: [] };
function call(s: NautiloState, args: Record<string, unknown>, name = "security_scan") {
  const id = `call-${s.messages.length}`;
  s.messages.push(new AIMessage({ id: `ai:${id}`, content: "", tool_calls: [{ id, name, args }] }));
  return id;
}
function result(s: NautiloState, id: string, value: unknown, name = "security_scan", ok = true) {
  const message = new ToolMessage({ name, tool_call_id: id, status: ok ? "success" : "error",
    content: JSON.stringify(value), additional_kwargs: { nautilo_tool_status: ok ? "success" : "error",
      ...(name === "file" ? { nautilo_file_operation: "read" } : {}) } });
  assignStableToolMessageId(message); s.messages.push(message);
}
function save(s: NautiloState, id: string, entry: SecurityScanLedgerRecord["entry"], revision = 1) {
  const value = { ok: true, operation: "record", result: { codeEvidence: [], record: { id, revision, entry,
    createdBy: author, updatedBy: author, createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z" } } };
  securityScanToolResultSchema.parse(value);
  result(s, call(s, { version: "security-scan-v1", operation: "record", action: revision === 1 ? "append" : "update", entry }), value);
}
const unit = { kind: "review_unit" as const, summary: "Trace queued-download authorization after membership changes.", surfaceKey: "downloads",
  paths: ["downloads.ts"], state: "reviewed" as const, trace: "Request checks membership; execution trusts the queued principal.",
  notes: "Revocation between queueing and execution is not rechecked.", evidenceRefs: [], counterevidenceRefs: [], openRecordIds: [] };
function checkpoint(s: NautiloState, id: string, refs: string[] = []) {
  save(s, id, { kind: "checkpoint", summary: "Saved the concrete trace and remaining questions.", nextWork: "Check execution authorization and alternate callers.",
    openRecordIds: [], evidenceRefs: refs.map((id) => ({ kind: "ledger_record", id })) });
}
function fixture() {
  const s = { messages: [new HumanMessage("Audit the requested code; do not execute it.")], userId: "owner", currentTaskId: author.taskId,
    currentTaskRunId: author.taskRunId, subagentRun: true, taskRun: true, researchWorkEnabled: true,
    toolWhitelist: ["file", "security_scan"], researchContextRecovery: null, model: author.modelId, noProgressStreaks: new Map() } as unknown as NautiloState;
  result(s, call(s, { operation: "start" }), { ok: true, operation: "start", result: status });
  save(s, "unit_download", { ...unit, state: "in_progress" }); checkpoint(s, "plan");
  return s;
}
function handoff(s: NautiloState, args: Record<string, unknown>, persist = true) {
  const request = { version: "security-scan-v1", operation: "handoff", ...args };
  const id = call(s, request);
  const receipt = performResearchHandoff(s, request);
  if (persist) result(s, id, receipt, "security_scan", receipt.ok);
  return receipt;
}
function investigate(s: NautiloState) {
  const assigned = handoff(s, { role: "investigator", unitRecordId: "unit_download", expectedRevision: 1, handoffRecordId: "plan" });
  expect(assigned.ok).toBe(true);
  save(s, "unit_download", { ...unit, notes: "Investigator traced queued execution and saved the current result." }, 2);
  checkpoint(s, "investigation");
  expect(handoff(s, { role: "reviewer", unitRecordId: "unit_download", expectedRevision: 2, handoffRecordId: "investigation" }).ok).toBe(true);
}
function reviewNotes(s: NautiloState, key: string) {
  result(s, call(s, { command: "read", path: "downloads.ts" }, "file"), "Source inspected at queue execution.", "file");
  save(s, `evidence_${key}`, { kind: "counterevidence", summary: "Inspected execution and alternate authorized path.", evidenceRefs: [{ kind: "code_evidence", id: `code_${key}` }] });
  checkpoint(s, key, [`evidence_${key}`]);
}
afterEach(() => { clearToolCatalog(); setRelayRegistry(null); });

type AssignmentPromptHeader = { unitRecordId: string | null; savedAssignments: {
  acceptedUnitCount: number; reload: Record<string, unknown> & { tool: string };
  latestCheckpoint: { id: string; reload: Record<string, unknown> & { tool: string } };
} };

test("coordinator discovers accepted assignments with canonical selectors instead of restarting the plan", () => {
  const s = fixture();
  save(s, "unit_pending", { ...unit, state: "unreviewed", summary: "Untrusted unit notes must remain tool data." });
  checkpoint(s, "latest_plan");
  result(s, call(s, { command: "read", path: "downloads.ts" }, "file"), "New source work after the checkpoint.", "file");
  const before = JSON.stringify(s.messages);
  const prompt = buildResearchWorkContextMessage(s)!;
  const header = JSON.parse(prompt.split("\n")[1]!) as AssignmentPromptHeader;
  const schema = createSecurityScanTool().schema as { parse(input: unknown): unknown };
  const { tool, ...selection } = header.savedAssignments.reload;
  expect(tool).toBe("security_scan");
  expect(schema.parse(selection)).toEqual({ version: "security-scan-v1", operation: "results", category: "research", recordKinds: ["review_unit"], finalize: false });
  expect(securityScanOperationSchema.safeParse({ ...selection, scanId: status.scanId }).success).toBe(true);
  expect(header.savedAssignments.acceptedUnitCount).toBe(2);
  expect(header.savedAssignments.latestCheckpoint.id).toBe("latest_plan");
  const { tool: checkpointTool, ...checkpointSelection } = header.savedAssignments.latestCheckpoint.reload;
  expect(checkpointTool).toBe("security_scan");
  expect(schema.parse(checkpointSelection)).toEqual({ version: "security-scan-v1", operation: "results", category: "research", recordIds: ["latest_plan"], finalize: false });
  expect(securityScanOperationSchema.safeParse({ ...checkpointSelection, scanId: status.scanId }).success).toBe(true);
  expect(prompt).toContain("continueResults:true with the same filters as needed");
  expect(prompt).toContain("Reuse known current IDs, revisions and notes");
  expect(prompt).toContain("an incomplete page does not establish absence");
  expect(prompt).not.toContain("until nextCursor is null");
  expect(prompt).toContain("Choose the next concrete investigation or review");
  expect(prompt).toContain("role:investigator");
  expect(prompt).toContain("expectedRevision");
  expect(prompt).toContain("not proof that it is still handoff-ready");
  expect(prompt).toContain("Unassigned inventory is not unfinished review work");
  expect(prompt).toContain("address the exact requested corrections and resubmit the corrected draft");
  expect(prompt).not.toContain("Keep unassigned inventory");
  expect(prompt).not.toContain("Start from the complete inventory");
  expect(prompt).not.toContain("Untrusted unit notes must remain tool data.");
  expect(header.unitRecordId).toBeNull();
  expect(JSON.stringify(s.messages)).toBe(before);
  // A locator never bypasses the existing checkpoint freshness requirement.
  expect(handoff(s, { role: "investigator", unitRecordId: "unit_pending", expectedRevision: 1, handoffRecordId: "latest_plan" }, false).ok).toBe(false);
  checkpoint(s, "current_plan");
  expect(handoff(s, { role: "investigator", unitRecordId: "unit_pending", expectedRevision: 1, handoffRecordId: "current_plan" }).ok).toBe(true);
  expect(buildResearchWorkContextMessage(s)).not.toContain("savedAssignments");
});

test("coordinator assignment affordance excludes rejected and foreign records and preserves initial and legacy guidance", () => {
  const s = fixture();
  s.messages = s.messages.slice(0, 3);
  result(s, call(s, { operation: "record", action: "append", entry: unit }), { ok: false, operation: "record", error: { code: "invalid_request", message: "Rejected entry.", retryable: false } }, "security_scan", false);
  expect(buildResearchWorkContextMessage(s)).toContain("Start from the complete inventory");
  expect(buildResearchWorkContextMessage(s)).not.toContain("savedAssignments");
  const foreign = { ...fixture(), currentTaskRunId: "33333333-3333-4333-8333-333333333333" };
  expect(buildResearchWorkContextMessage(foreign)).not.toContain("savedAssignments");
  expect(buildResearchWorkContextMessage({ ...s, researchWorkEnabled: false })).toBeNull();
});

test("assignment prompt growth depends on its count, not the number or size of saved notes", () => {
  const s = fixture();
  const before = buildResearchWorkContextMessage(s)!;
  for (let index = 0; index < 20; index++) save(s, `unit_${index}`, { ...unit, notes: "Repository-authored text. ".repeat(1000) });
  const after = buildResearchWorkContextMessage(s)!;
  expect((JSON.parse(after.split("\n")[1]!) as AssignmentPromptHeader).savedAssignments.acceptedUnitCount).toBe(21);
  expect(after.replace('"acceptedUnitCount":21', '"acceptedUnitCount":1')).toBe(before);
});

test("a complete investigation-review-report loop survives real saver serialization and retains the coordinator plan", async () => {
  let s = fixture(); investigate(s);
  const serde = new PostgresSaver({} as never).serde;
  const before = deriveResearchWorkContext(s);
  const [encoding, bytes] = await serde.dumpsTyped(s);
  s = await serde.loadsTyped(encoding, bytes) as NautiloState;
  expect(deriveResearchWorkContext(s)).toEqual(before);
  reviewNotes(s, "review");
  expect(handoff(s, { role: "coordinator", handoffRecordId: "review", reviewDecision: "accepted" }).ok).toBe(true);
  expect(deriveResearchWorkContext(s)?.seedRecordIds).toContain("plan");
  expect(researchWorkFinalizationError(s)).toContain("complete report");
  expect(() => readReviewedResearchReportDraft(s)).toThrow("SECURITY_REPORT_REVIEW_INCOMPLETE");
  checkpoint(s, "draft_plan");
  const draft = "\n  # Audit 🦀\nThe queued download lacks execution-time membership revalidation.\nEvidence and limits follow.\n\n";
  expect(handoff(s, { role: "reviewer", handoffRecordId: "draft_plan", reportDraft: draft }).ok).toBe(true);
  reviewNotes(s, "report_review");
  expect(handoff(s, { role: "coordinator", handoffRecordId: "report_review", reviewDecision: "accepted" }).ok).toBe(true);
  expect(researchWorkFinalizationError(s)).toBeNull();
  s.messages.push(new AIMessage("A regenerated final response that omits the finding."));
  expect(readReviewedResearchReportDraft(s)).toBe(draft);
  const [finalEncoding, finalBytes] = await serde.dumpsTyped(s);
  expect(readReviewedResearchReportDraft(await serde.loadsTyped(finalEncoding, finalBytes) as NautiloState)).toBe(draft);
  save(s, "unit_download", { ...unit, notes: "The execution caller changed; prior review no longer establishes this claim." }, 3);
  expect(researchWorkFinalizationError(s)).toContain("complete report");
  expect(() => readReviewedResearchReportDraft(s)).toThrow("SECURITY_REPORT_REVIEW_INCOMPLETE");
  expect(readReviewedResearchReportDraft({ ...s, currentTaskRunId: "other", researchWorkEnabled: false })).toBeNull();
});

test("reviewers return precise follow-up and cannot accept changed revisions or summary-only inspection", () => {
  const s = fixture(); investigate(s); checkpoint(s, "review_without_source");
  const rejected = handoff(s, { role: "coordinator", handoffRecordId: "review_without_source", reviewDecision: "accepted" });
  expect(rejected.ok).toBe(false);
  if (!rejected.ok) expect(rejected.error.message).toContain("fresh successful source inspection");
  reviewNotes(s, "review_changed"); save(s, "unit_download", { ...unit, notes: "Changed claim." }, 3); checkpoint(s, "changed_checkpoint", ["evidence_review_changed"]);
  const stale = handoff(s, { role: "coordinator", handoffRecordId: "changed_checkpoint", reviewDecision: "accepted" });
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.error.message).toContain("changed");
  expect(handoff(s, { role: "coordinator", handoffRecordId: "changed_checkpoint", reviewDecision: "follow_up" }).ok).toBe(true);
  expect(researchWorkFinalizationError(s)).toContain("complete report");
});

test("handoff refuses sibling calls, stale checkpoints, wrong ownership and silent post-checkpoint source loss", () => {
  const s = fixture();
  const args = { version: "security-scan-v1", operation: "handoff", role: "investigator", handoffRecordId: "plan", unitRecordId: "unit_download", expectedRevision: 1 };
  const id = call(s, args); const message = s.messages.at(-1) as AIMessage;
  message.tool_calls!.push({ id: "sibling", name: "file", args: { command: "read", path: "downloads.ts" } });
  expect(performResearchHandoff(s, args).ok).toBe(false);
  result(s, id, { ok: false });
  result(s, call(s, { command: "read", path: "downloads.ts" }, "file"), "New source after checkpoint", "file");
  const stale = handoff(s, args);
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.error.message).toContain("followed this checkpoint");
  checkpoint(s, "updated_plan");
  expect(handoff({ ...s, currentTaskRunId: "33333333-3333-4333-8333-333333333333" }, { ...args, handoffRecordId: "updated_plan" }).ok).toBe(false);
});

test("worker prose continues its role while revoked authority can end with a truthful failure", () => {
  const s = fixture(); investigate(s);
  s.messages.push(new AIMessage("The audit is complete."));
  const feedback = modelOutputPreflightNode(s);
  expect(feedback.researchContinuationRequired).toBe(true);
  expect(feedback.messages?.at(-1)?.content).toContain("coordinator");
  result(s, call(s, { operation: "status" }), { ok: false, operation: "status", error: { code: "root_revoked", message: "Access revoked", retryable: false } }, "security_scan", false);
  s.messages.push(new AIMessage("Source access was revoked. The saved partial investigation remains available."));
  expect(modelOutputPreflightNode(s).researchContinuationRequired).toBe(false);
  expect(deriveResearchWorkContext({ ...s, currentTaskRunId: "other", researchWorkEnabled: false })).toBeNull();
});

test("real admitted local handoff uses canonical result protection without a relay and respects tool authority", async () => {
  const s = fixture(); const catalog = new ToolCatalog(); registerAllTools(catalog, { officeCliAvailable: () => false }); initToolCatalog(catalog); setRelayRegistry(null);
  Object.assign(s, { approvedToolCalls: [], actorRole: "owner", personaId: "owner", turnId: "turn", agentId: "agent", roomId: "room", currentFolder: "/repo",
    activatedToolNames: ["security_scan"], activatedToolLeases: [], engagedSkillNames: [], memoryAccessEnvelope: null,
    relayCapabilities: { canReadWorkspace: true }, requiredHostRelays: {}, verifiedOrdinaryOrigin: null });
  const args = { version: "security-scan-v1", operation: "handoff", role: "investigator", handoffRecordId: "plan", unitRecordId: "unit_download", expectedRevision: 1 };
  const id = call(s, args);
  const invoke = (state: NautiloState) => createNautiloToolInvocationSession(createServerToolInvocationContext(state, () => ({ status: "allowed" }))).invoke({ callId: id, toolName: "security_scan", args, authorityRef: "admitted" });
  const response = await invoke(s);
  expect(response.status).toBe("success");
  expect(JSON.parse(response.content as string)).toMatchObject({ ok: true, operation: "handoff", work: { role: "investigator", taskRunId: author.taskRunId } });
  expect((await invoke({ ...s, toolWhitelist: ["file"] })).status).toBe("error");
});


test("unlinked notes and checkpoints preserve report acceptance; changed conclusions require a revised report", () => {
  for (const kind of ["evidence", "counterevidence"] as const) for (const update of [false, true]) {
    const s = fixture(); investigate(s); reviewNotes(s, "unit_review");
    expect(handoff(s, { role: "coordinator", handoffRecordId: "unit_review", reviewDecision: "accepted" }).ok).toBe(true);
    const entry = { kind, summary: "Unlinked source observation before report review.", evidenceRefs: [] };
    if (update) save(s, "unlinked_note", entry);
    checkpoint(s, "report_plan");
    const draft = "# Reviewed report\nConclusions and acknowledged limitations.";
    expect(handoff(s, { role: "reviewer", handoffRecordId: "report_plan", reportDraft: draft }).ok).toBe(true);
    reviewNotes(s, "report_review");
    expect(handoff(s, { role: "coordinator", handoffRecordId: "report_review", reviewDecision: "accepted" }).ok).toBe(true);
    expect(researchWorkFinalizationError(s)).toBeNull();
    expect(readReviewedResearchReportDraft(s)).toBe(draft);
    if (update) {
      save(s, "unlinked_note", entry); // Exact accepted revision replay is not new work.
      const replay = JSON.parse(s.messages.at(-1)!.content as string) as { result: { record: SecurityScanLedgerRecord } };
      const page = { ok: true, operation: "results", result: { version: "security-scan-v1", status,
        records: [replay.result.record], codeEvidence: [], observations: [], nextCursor: null, reportReady: false } };
      securityScanToolResultSchema.parse(page);
      result(s, call(s, { operation: "results", category: "research", finalize: false }), page);
    }
    const rejectedId = call(s, { operation: "record", action: "append", entry });
    result(s, rejectedId, { ok: false, operation: "record", error: { code: "invalid_request", message: "Rejected", retryable: false } }, "security_scan", false);
    save(s, "foreign_note", entry);
    const foreignReceipt = s.messages.at(-1) as ToolMessage;
    const foreignValue = JSON.parse(foreignReceipt.content as string) as { result: { record: SecurityScanLedgerRecord } };
    foreignValue.result.record.updatedBy.taskRunId = "33333333-3333-4333-8333-333333333333";
    foreignReceipt.content = JSON.stringify(foreignValue);
    expect(researchWorkFinalizationError(s)).toBeNull();
    save(s, "unlinked_note", { ...entry, summary: "Newly saved source observation requires reconsidering the report." }, update ? 2 : 1);
    expect(researchWorkFinalizationError(s)).toBeNull();
    expect(readReviewedResearchReportDraft(s)).toBe(draft);
    save(s, "unit_download", { ...unit, notes: "A concrete changed conclusion incorporates the new observation." }, 3);
    expect(researchWorkFinalizationError(s)).toContain("report");
    expect(() => readReviewedResearchReportDraft(s)).toThrow("SECURITY_REPORT_REVIEW_INCOMPLETE");
    // The unrelated unit review remains accepted; only the whole report needs review.
    checkpoint(s, "revised_report_plan");
    const revisedDraft = "# Revised report\nIncludes the later source observation.";
    expect(handoff(s, { role: "reviewer", handoffRecordId: "revised_report_plan", reportDraft: revisedDraft }).ok).toBe(true);
    reviewNotes(s, "revised_report_review");
    expect(handoff(s, { role: "coordinator", handoffRecordId: "revised_report_review", reviewDecision: "accepted" }).ok).toBe(true);
    expect(researchWorkFinalizationError(s)).toBeNull();
    expect(readReviewedResearchReportDraft(s)).toBe(revisedDraft);
  }
});

test("investigator review handoff requires its assigned result to be saved in this investigator epoch", () => {
  const s = fixture();
  expect(handoff(s, { role: "investigator", unitRecordId: "unit_download", expectedRevision: 1, handoffRecordId: "plan" }).ok).toBe(true);
  checkpoint(s, "checkpoint_only");
  const unchanged = handoff(s, { role: "reviewer", unitRecordId: "unit_download", expectedRevision: 1, handoffRecordId: "checkpoint_only" });
  expect(unchanged.ok).toBe(false);
  if (!unchanged.ok) expect(unchanged.error.message).toContain("assigned review_unit");
  save(s, "unit_download", unit); // An idempotent replay cannot masquerade as a fresh result.
  checkpoint(s, "after_replay");
  expect(handoff(s, { role: "reviewer", unitRecordId: "unit_download", expectedRevision: 1, handoffRecordId: "after_replay" }).ok).toBe(false);
  save(s, "unit_download", { ...unit, notes: "Foreign investigator result." }, 2);
  const receipt = s.messages.at(-1) as ToolMessage;
  const foreign = JSON.parse(receipt.content as string) as { result: { record: SecurityScanLedgerRecord } };
  foreign.result.record.updatedBy.taskRunId = "33333333-3333-4333-8333-333333333333";
  receipt.content = JSON.stringify(foreign);
  checkpoint(s, "after_foreign");
  expect(handoff(s, { role: "reviewer", unitRecordId: "unit_download", expectedRevision: 2, handoffRecordId: "after_foreign" }).ok).toBe(false);
  save(s, "unit_download", { ...unit, notes: "Fresh investigation saved its result in the assigned unit." }, 2);
  checkpoint(s, "after_result");
  expect(handoff(s, { role: "reviewer", unitRecordId: "unit_download", expectedRevision: 1, handoffRecordId: "after_result" }).ok).toBe(false);
  expect(handoff(s, { role: "reviewer", unitRecordId: "unit_download", expectedRevision: 2, handoffRecordId: "after_result" }).ok).toBe(true);
});


test("review return accepts redundant exact assignment identifiers without another review cycle", () => {
  const s = fixture(); investigate(s); reviewNotes(s, "exact_return");
  const rejected = handoff(s, { role: "coordinator", handoffRecordId: "exact_return", reviewDecision: "accepted", unitRecordId: "unit_wrong", expectedRevision: 2 });
  expect(rejected.ok).toBe(false);
  const stale = handoff(s, { role: "coordinator", handoffRecordId: "exact_return", reviewDecision: "accepted", unitRecordId: "unit_download", expectedRevision: 1 });
  expect(stale.ok).toBe(false);
  const accepted = handoff(s, { role: "coordinator", handoffRecordId: "exact_return", reviewDecision: "accepted", unitRecordId: "unit_download", expectedRevision: 2 });
  expect(accepted.ok).toBe(true);
  if (accepted.ok) expect(accepted.work).toMatchObject({ unitRecordId: null, reviewedUnitRecordId: "unit_download", resultRevision: 2, reviewDecision: "accepted" });
});

test("reviewer records separate corrections without mutating the bound result or evidence", () => {
  const s = fixture();
  save(s, "primary_evidence", { kind: "evidence", summary: "Original trace", evidenceRefs: [] });
  save(s, "unit_download", { ...unit, evidenceRefs: [{ kind: "ledger_record", id: "primary_evidence" }] }, 2);
  checkpoint(s, "ready_for_review");
  expect(handoff(s, { role: "reviewer", unitRecordId: "unit_download", expectedRevision: 2, handoffRecordId: "ready_for_review" }).ok).toBe(true);
  const before = JSON.stringify(s.messages);
  for (const recordId of ["unit_download", "primary_evidence"]) {
    expect(researchReviewMutationError(s, { operation: "record", action: "update", recordId })).toContain("separate review notes");
  }
  expect(researchReviewMutationError(s, { operation: "record", action: "append", entry: { kind: "counterevidence" } })).toBeNull();
  expect(researchReviewMutationError(s, { operation: "results" })).toBeNull();
  expect(JSON.stringify(s.messages)).toBe(before);
  reviewNotes(s, "separate_review");
  expect(researchReviewMutationError(s, { operation: "record", action: "update", recordId: "evidence_separate_review" })).toBeNull();
  expect(handoff(s, { role: "coordinator", handoffRecordId: "separate_review", reviewDecision: "accepted" }).ok).toBe(true);
  expect(researchReviewMutationError(s, { operation: "record", action: "update", recordId: "unit_download" })).toBeNull();
});


test("closed unchanged units cannot be reassigned after restart, new notes or checkpoints", async () => {
  let s = fixture(); investigate(s); reviewNotes(s, "closed_unit");
  expect(handoff(s, { role: "coordinator", handoffRecordId: "closed_unit", reviewDecision: "accepted" }).ok).toBe(true);
  save(s, "independent_note", { kind: "evidence", summary: "Unrelated report organization note", evidenceRefs: [] });
  checkpoint(s, "new_plan");
  const serde = new PostgresSaver({} as never).serde;
  const [encoding, bytes] = await serde.dumpsTyped(s);
  s = await serde.loadsTyped(encoding, bytes) as NautiloState;
  for (const role of ["investigator", "reviewer"] as const) {
    const repeated = handoff(s, { role, handoffRecordId: "new_plan", unitRecordId: "unit_download", expectedRevision: 2 });
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) expect(repeated.error.message).toContain("already reviewer-accepted and unchanged");
  }
  // A recorded change to the affected conclusion creates real work, while
  // independent notes and another checkpoint above could not reopen it.
  save(s, "unit_download", { ...unit, state: "in_progress", notes: "New caller evidence contradicts the execution identity assumption." }, 3);
  checkpoint(s, "changed_plan");
  expect(handoff(s, { role: "investigator", handoffRecordId: "changed_plan", unitRecordId: "unit_download", expectedRevision: 3 }).ok).toBe(true);
});


test("investigator can return its completed result directly and one report review needs no redundant source read", () => {
  const s = fixture();
  expect(handoff(s, { role: "investigator", unitRecordId: "unit_download", expectedRevision: 1, handoffRecordId: "plan" }).ok).toBe(true);
  checkpoint(s, "unchanged");
  expect(handoff(s, { role: "coordinator", handoffRecordId: "unchanged" }).ok).toBe(false);
  save(s, "unit_download", { ...unit, notes: "Traced queue execution; supporting wrappers sampled. No separate unit review needed." }, 2);
  checkpoint(s, "finished");
  expect(handoff(s, { role: "coordinator", handoffRecordId: "finished", reviewDecision: "accepted" }).ok).toBe(false);
  expect(handoff(s, { role: "coordinator", handoffRecordId: "finished" }).ok).toBe(true);
  expect(deriveResearchWorkContext(s)?.role).toBe("coordinator");
  const draft = "# Audit\nQueued execution trusts stale membership. Wrappers sampled; limits disclosed.";
  checkpoint(s, "draft");
  expect(handoff(s, { role: "reviewer", handoffRecordId: "draft", reportDraft: draft }).ok).toBe(true);
  checkpoint(s, "report_assessment", ["unit_download"]);
  expect(handoff(s, { role: "coordinator", handoffRecordId: "report_assessment", reviewDecision: "accepted" }).ok).toBe(true);
  expect(researchWorkFinalizationError(s)).toBeNull();
  expect(readReviewedResearchReportDraft(s)).toBe(draft);
  checkpoint(s, "delivery");
  expect(readReviewedResearchReportDraft(s)).toBe(draft);
});


test("a directly completed unit cannot be sent around another investigator loop", () => {
  const s = fixture();
  save(s, "unit_download", unit, 2); checkpoint(s, "done");
  const repeated = handoff(s, { role: "investigator", unitRecordId: "unit_download", expectedRevision: 2, handoffRecordId: "done" });
  expect(repeated.ok).toBe(false);
  if (!repeated.ok) expect(repeated.error.message).toContain("unit is closed");
  save(s, "unit_download", { ...unit, state: "in_progress", notes: "New queue caller contradicts the saved identity assumption; inspect only that caller." }, 3);
  checkpoint(s, "specific_followup");
  expect(handoff(s, { role: "investigator", unitRecordId: "unit_download", expectedRevision: 3, handoffRecordId: "specific_followup" }).ok).toBe(true);
});
