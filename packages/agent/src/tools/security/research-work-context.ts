import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { createHash } from "node:crypto";
import { z } from "zod";
import { researchHandoffReceiptSchema, securityScanStableIdSchema, securityScanToolResultSchema, type ResearchWork } from "@nautilo/types";
import type { NautiloState } from "../../agent/state";
import { deriveResearchSavedState, pairedResearchReceipts } from "./research-saved-state";
import { describeResearchContextMessage } from "./research-context";

const roleSchema = z.enum(["coordinator", "investigator", "reviewer"]);
const requestSchema = z.strictObject({
  version: z.literal("security-scan-v1"),
  operation: z.literal("handoff"),
  role: roleSchema,
  handoffRecordId: securityScanStableIdSchema,
  unitRecordId: securityScanStableIdSchema.optional(),
  expectedRevision: z.number().int().positive().optional(),
  seedRecordIds: z.array(securityScanStableIdSchema).optional(),
  reviewDecision: z.enum(["accepted", "follow_up"]).optional(),
  // The draft is ordinary model-authored tool input, preserved and protected
  // with its call. It is never interpolated into a trusted system message.
  reportDraft: z.string().trim().min(1).optional(),
});
type Work = ResearchWork;
/** Shape feedback is pure; authority and transition checks remain execution-time. */
export function parseResearchHandoffRequest(args: Record<string, unknown>) {
  const parsed = requestSchema.safeParse(args);
  return parsed.success ? { ok: true as const, request: parsed.data }
    : { ok: false as const, errorMessage: "Use handoff with role, handoffRecordId, optional unitRecordId/expectedRevision/seedRecordIds, and reviewDecision only when returning a review. " + parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
}
export type ResearchWorkContext = Work & { startIndex: number };
type WorkState = Pick<NautiloState, "messages" | "currentTaskId" | "currentTaskRunId"> &
  Partial<Pick<NautiloState, "researchWorkEnabled" | "subagentRun" | "userId" | "toolWhitelist">>;

function acceptedHandoffs(state: WorkState) {
  // Do not parse large source receipts merely to find role-control metadata.
  const calls = new Map<string, { callIndex: number; args: Record<string, unknown> }>();
  const seen = new Set<string>();
  const receipts: Array<{ index: number; callIndex: number; args: Record<string, unknown>; value: unknown }> = [];
  for (const [index, message] of state.messages.entries()) {
    if (AIMessage.isInstance(message)) for (const call of message.tool_calls ?? []) {
      if (!call.id) continue;
      if (seen.has(call.id)) { calls.delete(call.id); continue; }
      seen.add(call.id);
      if (call.name === "security_scan" && call.args["operation"] === "handoff") calls.set(call.id, { callIndex: index, args: call.args });
    }
    if (!ToolMessage.isInstance(message)) continue;
    const call = calls.get(message.tool_call_id);
    calls.delete(message.tool_call_id);
    if (!call || message.name !== "security_scan" || message.status === "error"
      || message.additional_kwargs["nautilo_tool_status"] === "error" || typeof message.content !== "string") continue;
    try { receipts.push({ ...call, index, value: JSON.parse(message.content) }); } catch { /* No accepted transition. */ }
  }
  return receipts.flatMap((receipt) => {
    const request = requestSchema.safeParse(receipt.args);
    const parsed = researchHandoffReceiptSchema.safeParse(receipt.value);
    if (!request.success || !parsed.success || parsed.data.work.taskId !== state.currentTaskId
      || parsed.data.work.taskRunId !== state.currentTaskRunId
      || parsed.data.work.role !== request.data.role
      || parsed.data.work.handoffRecordId !== request.data.handoffRecordId) return [];
    return [{ ...receipt, work: parsed.data.work }];
  });
}

/** Checkpointed canonical receipts are the execution state; no second store. */
export function deriveResearchWorkContext(state: WorkState): ResearchWorkContext | null {
  const last = acceptedHandoffs(state).at(-1);
  if (last) return { ...last.work, startIndex: last.callIndex };
  if (!state.researchWorkEnabled || !state.currentTaskId || !state.currentTaskRunId) return null;
  for (const receipt of pairedResearchReceipts(state.messages)) {
    if (!["start", "status"].includes(String(receipt.args["operation"]))) continue;
    const parsed = securityScanToolResultSchema.safeParse(receipt.value);
    if (parsed.success && parsed.data.ok && (parsed.data.operation === "start" || parsed.data.operation === "status")
      && parsed.data.result.mode === "scanners_only") return null;
  }
  return { taskId: state.currentTaskId, taskRunId: state.currentTaskRunId,
    role: "coordinator", unitRecordId: null, handoffRecordId: "", seedRecordIds: [], startIndex: 0 };
}

/** IDs/revisions only: notes remain untrusted content read through tools. */
export function buildResearchWorkContextMessage(state: WorkState): string | null {
  const work = deriveResearchWorkContext(state);
  if (!work) return null;
  const saved = deriveResearchSavedState(state);
  // Only the semantic entry points belong in the irreducible system prefix.
  // Further seed references remain in the exact handoff receipt/checkpoint,
  // available through ordinary paged retrieval rather than copied into every turn.
  const seeds = [...new Set([work.handoffRecordId, work.unitRecordId,
    ...(work.role === "coordinator" ? [work.coordinatorRecordId] : [])].filter((id): id is string => Boolean(id)))]
    .map((id) => ({ id, revision: saved.records.get(id)?.record.revision ?? null }));
  let acceptedUnitCount = 0;
  let latestCheckpoint: { id: string; revision: number; receiptIndex: number } | undefined;
  if (work.role === "coordinator") for (const { record, receiptIndex } of saved.records.values()) {
    if (record.entry.kind === "review_unit") acceptedUnitCount++;
    if (record.entry.kind === "checkpoint" && (!latestCheckpoint || receiptIndex > latestCheckpoint.receiptIndex)) {
      latestCheckpoint = { id: record.id, revision: record.revision, receiptIndex };
    }
  }
  // One selector and one checkpoint locator, irrespective of ledger size.
  // Saved assignments establish neither inspection nor reviewer acceptance.
  const savedAssignments = acceptedUnitCount > 0 ? {
    acceptedUnitCount,
    reload: { tool: "security_scan", version: "security-scan-v1", operation: "results", category: "research", recordKinds: ["review_unit"], finalize: false },
    ...(latestCheckpoint ? { latestCheckpoint: { id: latestCheckpoint.id, revision: latestCheckpoint.revision,
      reload: { tool: "security_scan", version: "security-scan-v1", operation: "results", category: "research", recordIds: [latestCheckpoint.id], finalize: false } } } : {}),
  } : undefined;
  const instructions = work.role === "coordinator"
    ? (savedAssignments
      ? "Accepted review-unit records already exist in this TaskRun. Reuse known current IDs, revisions and notes; when these are missing, use savedAssignments.reload to locate relevant work. Follow continueResults:true with the same filters as needed; an incomplete page does not establish absence. Choose the next concrete investigation or review from unfinished work. Unassigned inventory is not unfinished review work. Add work only for a specific uncovered requested behavior, changed source, or contradictory evidence. "
      : "Start from the complete inventory and targeted entry-point inspection. Create a repository map and coherent behavior assignments; group related support files and record reasoned exclusions. ")
      + "Investigate directly when useful. Use role:investigator with unitRecordId and expectedRevision only when a focused workspace will help. Its latestCheckpoint locator is not proof that it is still handoff-ready after later source work. Let risk and evidence determine depth, sampling and sequencing; document that choice in trace/notes. Per-unit reviewer handoffs are optional for specific uncertain or high-impact claims, not a completion requirement. Completed unchanged units are settled. Reopen only the affected unit for changed source, contradictory evidence or a specific unsupported claim. Draft from saved conclusions without another general source pass, then request one focused report reviewer with reportDraft before sealing. After whole-report follow_up, address the exact requested corrections and resubmit the corrected draft; do not sweep the unassigned inventory."
    : work.role === "investigator"
      ? "Reload only missing assignment details and relevant notes. Choose risk-based depth and sampling, trace actual source, and save conclusions, evidence, scope decisions and limitations in the assigned review unit. Separate hypothesis and counterevidence records are optional when they add useful detail. Resolve explicit follow-ups. Once done, save a substantive checkpoint and return role:coordinator without reviewDecision; do not repeat settled work. Use a targeted reviewer only for a concrete concern. Do not finalize or end the Task."
      : "Review the exact result against saved evidence, scope decisions and material claims. Whole-report review checks the actual draft, severity, limitations and cross-unit consistency; reuse completed notes and reopen source only for a specific unsupported, contradictory or changed claim. A targeted unit review inspects the specific concern in source. Save separate review notes and a checkpoint, then return to coordinator with accepted or follow_up. Do not update the result being reviewed or its supporting records. Identify the exact claim and correction needed in follow_up; preserve other completed work. Do not finalize the Task.";
  return `[ACTIVE RESEARCH WORKSPACE]\n${JSON.stringify({ role: work.role, unitRecordId: work.unitRecordId,
    resultRevision: work.resultRevision, seedRecords: seeds,
    ...(savedAssignments ? { savedAssignments } : {}),
    ...(work.reportDraftRef ? { reviewedDraft: { tool: "security_scan", version: "security-scan-v1", operation: "context", contextRef: work.reportDraftRef } } : {}) })}\n${instructions}\n`
    + (work.reportDraftRef ? "The complete draft is preserved in the exact referenced handoff call's reportDraft field. The reviewer retrieves it through the context tool to review the actual text. After accepted review and sealing, runtime delivery uses those exact draft bytes; do not reconstruct or regenerate the report from a checkpoint outline. " : "")
    + "Reload seed records using security_scan results category=research recordIds, finalize=false. Reuse saved evidence and conclusions; reassess only when a concrete gap, contradiction or source change warrants it. Preserve detailed notes separately from your checkpoint handoff. A handoff is a standalone tool call after saving notes; it rotates working context inside this same Task, not a Human reply. All original history remains exactly retrievable.";
}

type Saved = ReturnType<typeof deriveResearchSavedState>;
/** Bind reviews to conclusion revisions and their transitive evidence, not counters. */
function conclusionState(saved: Saved, unitRecordId: string | null) {
  const revisions = new Map<string, number>();
  const code = new Set<string>();
  function visit(id: string): void {
    if (revisions.has(id)) return;
    const record = saved.records.get(id)?.record;
    if (!record) return;
    revisions.set(id, record.revision);
    for (const ref of [...record.entry.evidenceRefs, ...("counterevidenceRefs" in record.entry ? record.entry.counterevidenceRefs : [])]) {
      if (ref.kind === "ledger_record") visit(ref.id);
      if (ref.kind === "code_evidence") code.add(ref.id);
    }
  }
  if (unitRecordId) visit(unitRecordId);
  else for (const { record } of saved.records.values()) {
    if (!["checkpoint", "evidence", "counterevidence"].includes(record.entry.kind)) visit(record.id);
  }
  return { revisions: [...revisions].sort(([a], [b]) => a.localeCompare(b)), code: [...code].sort() };
}
function conclusionFingerprint(saved: Saved, unitRecordId: string | null): string {
  return createHash("sha256").update(JSON.stringify(conclusionState(saved, unitRecordId))).digest("hex");
}

/** Reject a destructive review edit before dispatch, preserving the accepted
 * result revision. Corrections belong in separate notes and a follow-up. */
export function researchReviewMutationError(state: WorkState, args: Record<string, unknown>): string | null {
  if (args["operation"] !== "record" || args["action"] !== "update") return null;
  const current = deriveResearchWorkContext(state);
  if (current?.role !== "reviewer") return null;
  const saved = deriveResearchSavedState(state);
  if (!conclusionState(saved, current.unitRecordId).revisions.some(([id]) => id === args["recordId"])) return null;
  return "The result and supporting records under review are unchanged and were not updated. Save corrections in separate review notes, then return follow_up with the specific changed claim. For an acceptable unchanged result, return accepted; do not edit its state or attach notes by updating it.";
}

/** Structural workflow checks only; the model authors and judges the research. */
export function performResearchHandoff(state: NautiloState, args: Record<string, unknown>) {
  const fail = (message: string) => ({ ok: false as const, operation: "handoff" as const,
    error: { code: "research_handoff_invalid", message, retryable: false } });
  if (!state.subagentRun || !state.userId || !state.currentTaskId || !state.currentTaskRunId
    || !state.toolWhitelist?.includes("security_scan")) return fail("A handoff requires this authorized security research TaskRun.");
  const parsed = parseResearchHandoffRequest(args);
  if (!parsed.ok) return fail(parsed.errorMessage);
  const latest = [...state.messages].reverse().find((message) => AIMessage.isInstance(message));
  if (latest?.tool_calls?.length !== 1 || latest.tool_calls[0]?.args["operation"] !== "handoff") return fail("Save notes first, then call handoff alone. No sibling calls may cross a workspace transition.");
  const saved = deriveResearchSavedState(state);
  if (saved.latestStatus?.controls["mode"] !== "deep_research" || saved.latestStatus.controls["state"] !== "active"
    || !["pending", "running"].includes(String(saved.latestStatus.controls["modelState"]))) return fail("A handoff requires this bound, active deep_research scan; finalized, cancelled or failed research cannot change workspaces.");
  const request = parsed.request;
  const current = deriveResearchWorkContext(state);
  const role = current?.role ?? "coordinator";
  const checkpoint = saved.records.get(request.handoffRecordId);
  if (checkpoint?.record.entry.kind !== "checkpoint" || checkpoint.receiptIndex <= (current?.startIndex ?? -1)) return fail("Save a current substantive checkpoint for this workspace, then use its exact handoffRecordId.");
  const handoffCallIndex = state.messages.lastIndexOf(latest);
  const uncommitted = state.messages.slice(checkpoint.receiptIndex + 1, handoffCallIndex).some((message) =>
    ToolMessage.isInstance(message) && message.name === "file"
    || AIMessage.isInstance(message) && !message.tool_calls?.length && Boolean(message.content))
    || [...saved.records.values()].some((item) => item.receiptIndex > checkpoint.receiptIndex);
  if (uncommitted) return fail("Source work or saved notes followed this checkpoint. Save an updated cumulative checkpoint before handoff so the next workspace receives the current knowledge and unfinished work.");
  const seedRecordIds = [...new Set([request.handoffRecordId, ...(request.seedRecordIds ?? []),
    ...(request.role === "coordinator" && current?.coordinatorRecordId ? [current.coordinatorRecordId] : []),
    ...(request.unitRecordId ? [request.unitRecordId] : [])])];
  if (seedRecordIds.some((id) => !saved.records.has(id))) return fail("Every seed reference must identify a saved record accepted in this TaskRun. Reload missing records before handoff.");
  let work: Work = { taskId: state.currentTaskId, taskRunId: state.currentTaskRunId,
    role: request.role, unitRecordId: request.unitRecordId ?? null,
    handoffRecordId: request.handoffRecordId, seedRecordIds,
    ...(role === "coordinator" ? { coordinatorRecordId: request.handoffRecordId }
      : current?.coordinatorRecordId ? { coordinatorRecordId: current.coordinatorRecordId } : {}) };
  if (role === "coordinator" && request.unitRecordId && request.role !== "coordinator") {
    const prior = acceptedHandoffs(state).filter(({ work }) => work.role === "coordinator"
      && work.reviewedUnitRecordId === request.unitRecordId).at(-1)?.work;
    if (prior?.reviewDecision === "accepted" && prior.reviewedState === conclusionFingerprint(saved, request.unitRecordId)) {
      return fail("This exact unit and supporting evidence are already reviewer-accepted and unchanged. Continue pending work or report preparation. To reopen a real issue, first record the specific new claim or changed evidence and update only the affected unit; another checkpoint or renamed section is not new investigation work.");
    }
  }
  if (request.role === "investigator") {
    if (role !== "coordinator" || request.reviewDecision || request.reportDraft) return fail("Only the coordinator assigns investigation; return reviews to the coordinator first.");
  } else if (request.role === "reviewer") {
    if (role === "reviewer" || request.reviewDecision) return fail("Return the current review to the coordinator before another assignment.");
    if (role === "investigator" && request.unitRecordId !== current?.unitRecordId) return fail("Return this investigator's exact assigned unit to review.");
    if (!request.unitRecordId && (role !== "coordinator" || !request.reportDraft)) return fail("Whole-report review requires the coordinator's complete reportDraft in this handoff call.");
    if (!request.unitRecordId) {
      const descriptor = describeResearchContextMessage(state, handoffCallIndex);
      if (!descriptor) return fail("The complete report draft could not be bound to this TaskRun's exact history.");
      work.reportDraftRef = descriptor.ref;
    }
    work.reviewedState = conclusionFingerprint(saved, request.unitRecordId ?? null);
  } else if (role === "investigator" && current) {
    if (request.reviewDecision || request.reportDraft || request.unitRecordId || request.expectedRevision) return fail("Return to coordinator with the current checkpoint only; investigator return is not reviewer acceptance.");
    const result = current.unitRecordId ? saved.records.get(current.unitRecordId) : undefined;
    if (!result || result.record.entry.kind !== "review_unit" || result.receiptIndex <= current.startIndex
      || result.record.revision <= (current.resultRevision ?? result.record.revision)) return fail("Save the assigned review_unit result and a current checkpoint before returning to coordinator.");
    work = { ...work, unitRecordId: null };
  } else {
    if (role !== "reviewer" || !current || !request.reviewDecision || request.reportDraft) return fail("The reviewer returns to coordinator with reviewDecision accepted or follow_up, plus saved review notes/checkpoint.");
    // A redundant exact assignment is harmless. Never let it select another
    // result or revision; the active reviewer workspace owns that binding.
    if (request.unitRecordId !== undefined && request.unitRecordId !== current.unitRecordId
      || request.expectedRevision !== undefined && request.expectedRevision !== current.resultRevision) {
      return fail("Reviewer return must match the active unit and assigned revision. Omit unitRecordId and expectedRevision; the runtime carries the exact binding.");
    }
    if (request.reviewDecision === "accepted") {
      if (current.reviewedState !== conclusionFingerprint(saved, current.unitRecordId)) return fail("The reviewed result or its supporting evidence changed. Return follow_up; the coordinator must request review of the new revision.");
      const readCalls = new Set<string>();
      const sourceRead = state.messages.slice(current.startIndex).some((message) => {
        if (AIMessage.isInstance(message)) for (const call of message.tool_calls ?? []) {
          if (call.id && call.name === "file" && call.args["command"] === "read") readCalls.add(call.id);
        }
        return ToolMessage.isInstance(message) && readCalls.has(message.tool_call_id)
          && message.name === "file" && message.status !== "error"
          && message.additional_kwargs["nautilo_file_operation"] === "read"
          && message.additional_kwargs["nautilo_tool_status"] === "success";
      });
      const citedReview = checkpoint.record.entry.evidenceRefs.some((ref) => ref.kind === "ledger_record"
        && (saved.records.get(ref.id)?.receiptIndex ?? -1) > current.startIndex
        && ["evidence", "counterevidence"].includes(saved.records.get(ref.id)?.record.entry.kind ?? "")
        && saved.records.get(ref.id)?.record.entry.evidenceRefs.some((evidence) => evidence.kind === "code_evidence"));
      if (current.unitRecordId && (!sourceRead || !citedReview)) return fail("Review acceptance requires fresh successful source inspection and saved source-backed review notes linked from this checkpoint. This is an evidence prerequisite, not proof that your conclusion is correct.");
    }
    work = { ...work, unitRecordId: null, reviewedUnitRecordId: current.unitRecordId,
      reviewDecision: request.reviewDecision,
      ...(current.reportDraftRef ? { reportDraftRef: current.reportDraftRef } : {}),
      ...(current.resultRevision ? { resultRevision: current.resultRevision } : {}),
      ...(current.reviewedState ? { reviewedState: current.reviewedState } : {}) };
  }
  if (request.role !== "coordinator" && request.unitRecordId) {
    const savedUnit = saved.records.get(request.unitRecordId);
    const unit = savedUnit?.record;
    if (!savedUnit || unit?.entry.kind !== "review_unit" || unit.revision !== request.expectedRevision) return fail("Supply the exact saved review_unit ID and its current expectedRevision. Assign a concrete behavior before investigating.");
    if (role === "investigator" && request.role === "reviewer"
      && (!current || savedUnit.receiptIndex <= current.startIndex || unit.revision <= (current.resultRevision ?? unit.revision))) {
      return fail("Save or update this investigator's assigned review_unit result before handing it to reviewer. A checkpoint or replay of the assigned revision does not save a new investigation result.");
    }
    if (request.role === "investigator" && ["reviewed", "not_applicable"].includes(unit.entry.state)) {
      return fail("This unit is closed. Continue pending work or report preparation. If a concrete source change, contradiction or unsupported claim requires investigation, first update this exact unit to in_progress and record the specific reason; do not recreate or routinely reassign completed work.");
    }
    work.resultRevision = unit.revision;
  } else if (request.role === "investigator") return fail("An investigator requires unitRecordId and expectedRevision.");
  return { ok: true as const, operation: "handoff" as const, work };
}

export function researchWorkFinalizationError(state: WorkState): string | null {
  const current = deriveResearchWorkContext(state);
  if (!current) return null; // Legacy/scanners-only retain their existing contract.
  if (current.role !== "coordinator") return "Return your saved investigation/review to the coordinator using handoff; this role cannot finalize or end the audit.";
  const saved = deriveResearchSavedState(state);
  if (saved.latestStatus?.controls["mode"] !== "deep_research") return null;
  const reviews = acceptedHandoffs(state).filter(({ work }) => work.role === "coordinator");
  // Unit review is optional. An explicit unresolved reviewer concern is not.
  for (const { record } of saved.records.values()) {
    if (record.entry.kind !== "review_unit") continue;
    const review = reviews.filter(({ work }) => work.reviewedUnitRecordId === record.id).at(-1)?.work;
    if (review?.reviewDecision === "follow_up" && review.reviewedState === conclusionFingerprint(saved, record.id)) {
      return `Resolve the specific reviewer follow-up for ${record.id}; leave unrelated completed units closed.`;
    }
  }
  const report = reviews.filter(({ work }) => work.reviewedUnitRecordId === null).at(-1);
  if (report?.work.reviewDecision !== "accepted" || report.work.reviewedState !== conclusionFingerprint(saved, null)) return "Draft the complete report while research is open, then hand off to reviewer without unitRecordId and with reportDraft. Address follow-up before sealing.";
  // Only changes to conclusions or their transitive evidence invalidate acceptance.
  // Independent notes and checkpoints do not force another report review.
  return null;
}

/** Runtime delivery reads the exact accepted draft, rather than asking another
 * model response to reproduce it. Legacy research keeps its original final text. */
export function readReviewedResearchReportDraft(state: WorkState): string | null {
  if (!deriveResearchWorkContext(state)) return null;
  if (!state.userId || !state.subagentRun || !state.toolWhitelist?.includes("security_scan")) throw new Error("SECURITY_REPORT_REVIEW_AUTHORITY_MISSING");
  const incomplete = researchWorkFinalizationError(state);
  if (incomplete) throw new Error(`SECURITY_REPORT_REVIEW_INCOMPLETE: ${incomplete}`);
  const report = acceptedHandoffs(state).filter(({ work }) => work.role === "coordinator"
    && work.reviewedUnitRecordId === null).at(-1)?.work;
  if (report?.reviewDecision !== "accepted" || !report.reportDraftRef) throw new Error("SECURITY_REPORT_REVIEW_DRAFT_MISSING");
  for (const [index, message] of state.messages.entries()) {
    if (!AIMessage.isInstance(message) || message.tool_calls?.length !== 1) continue;
    const call = message.tool_calls[0]!;
    if (call.name !== "security_scan" || call.args["operation"] !== "handoff"
      || call.args["role"] !== "reviewer" || call.args["unitRecordId"] !== undefined
      || typeof call.args["reportDraft"] !== "string") continue;
    if (describeResearchContextMessage({ ...state, userId: state.userId,
      subagentRun: state.subagentRun, toolWhitelist: state.toolWhitelist }, index)?.ref === report.reportDraftRef) return call.args["reportDraft"];
  }
  throw new Error("SECURITY_REPORT_REVIEW_DRAFT_UNAVAILABLE");
}

/** Once a Task has a scan, lost working context cannot select another ledger. */
export function researchScanRestartError(state: WorkState): string | null {
  return deriveResearchSavedState(state).latestStatus?.controls["scanId"]
    ? "This TaskRun already has a bound scan. Use status or results to recover it; do not start or reopen another ledger within this TaskRun."
    : null;
}
