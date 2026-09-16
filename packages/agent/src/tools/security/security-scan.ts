/**
 * D560 — model-facing contract for the Desktop-owned security-scan lane.
 *
 * The Desktop coordinator receives this tool only through invocation-service,
 * where its operation is paired with server-authored Task/TaskRun/model
 * context. Calling this LangChain tool directly is therefore always a bug.
 */
import { DynamicStructuredTool, type StructuredTool } from "@langchain/core/tools";
import {
  SECURITY_SCAN_MAX_FILE_CITATIONS_PER_CALL,
  SECURITY_SCAN_MAX_RESULTS,
  SECURITY_SCAN_VERSION,
  securityScanConfidenceSchema,
  securityScanCoverageStateSchema,
  securityScanHypothesisStateSchema,
  securityScanModeSchema,
  securityScanProbeSchema,
  securityScanRecordKindSchema,
  securityScanResearchTextSchema,
  securityScanRelativePathSchema,
  securityScanStableIdSchema,
} from "@nautilo/types";
import { z } from "zod";

const modelText = (maximum: number) => z.string().trim().min(1).max(maximum);
const modelEvidenceReferenceSchema = z.strictObject({
  kind: z.enum(["scanner_observation", "ledger_record"]),
  id: securityScanStableIdSchema,
});
const modelFileCitationSchema = z.strictObject({
  relativePath: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  searchQuery: modelText(500).optional(),
});

/**
 * Provider-facing schema only. Some OpenAI-compatible gateways discard a
 * root-level `oneOf`, which made the strict operation union appear to GLM as
 * an argument-less tool. Keep one ordinary object on the wire and let
 * invocation-service apply the canonical operation-specific validator before
 * any relay dispatch.
 */
const securityScanModelOperationSchema = z.strictObject({
  version: z.literal(SECURITY_SCAN_VERSION).describe(`Always ${SECURITY_SCAN_VERSION}.`),
  operation: z.enum(["start", "status", "results", "record", "cancel", "context", "handoff"])
    .describe("Choose exactly one operation. Start first; later operations are bound to this TaskRun automatically."),
  role: z.enum(["coordinator", "investigator", "reviewer"]).optional().describe("For handoff: destination workspace role within this Task; follow ACTIVE RESEARCH WORKSPACE instructions."),
  handoffRecordId: securityScanStableIdSchema.optional().describe("For handoff: exact current checkpoint saved after this workspace's last source work and notes. Call handoff alone."),
  unitRecordId: securityScanStableIdSchema.optional().describe("For investigator assignment or unit review: exact saved review_unit, paired with expectedRevision. Omit for whole-report review and reviewer return."),
  seedRecordIds: z.array(securityScanStableIdSchema).optional().describe("For handoff: additional exact saved note IDs useful to the next workspace."),
  reviewDecision: z.enum(["accepted", "follow_up"]).optional().describe("Only for reviewer return to coordinator; binds the exact reviewed result/evidence revision."),
  reportDraft: z.string().trim().min(1).optional().describe("For coordinator handoff to whole-report reviewer without unitRecordId: the complete proposed Markdown report. Ordinary protected tool input, bounded by the active model context."),
  contextRef: z.string().min(1).optional().describe("For context only: exact historical message or saved-record index reference supplied by the runtime context projection. It is bound to this TaskRun and immutable message bytes."),
  continueContext: z.boolean().optional().describe("For context: true lets the runtime carry the exact continuation. Omit contextRef to continue required substantive recovery; optional navigation never changes it. With contextRef, continue that selected index/source with unchanged filters. Use explicit contextRef without continuation to restart or choose different filters."),
  contextCursor: z.string().min(1).optional().describe("For context only: exact nextCursor from the preceding historical message page."),
  contextBytes: z.number().int().positive().safe().optional().describe("For context only: request a smaller UTF-8 byte page. The runtime also bounds the complete escaped response by currently reserved context space."),
  targetDirectory: z.string().min(1).optional().describe("Required for start: the exact requested directory, absolute or relative to Current Folder. Use . only when the Human requested Current Folder itself. Never omit or substitute a parent folder."),
  mode: securityScanModeSchema.optional().describe("Required only for start."),
  priorScanId: z.string().optional().describe("Optional prior scanId to reopen on start."),
  category: z.enum(["all", "observations", "research", "inventory"]).optional().describe("Required only for results."),
  probes: z.array(securityScanProbeSchema).max(4).optional(),
  recordKinds: z.array(securityScanRecordKindSchema).optional().describe("For results or a saved-record index context read: select record kinds; preserve the same filters while following its cursor."),
  contextSourcePath: securityScanRelativePathSchema.optional().describe("Only for a saved-record index context read: exact declared or cited relative source path. Find earlier saved notes before declaring a file unread. Index metadata is not source evidence and does not require a semantic checkpoint."),
  recordIds: z.array(securityScanStableIdSchema).optional().describe("For results only: fetch exact known ledger records for checkpoint recovery; omit for final report paging."),
  cursor: securityScanStableIdSchema.optional()
    .describe("Deprecated compatibility field. Do not copy cursors; use continueResults instead."),
  continueResults: z.boolean().optional()
    .describe("For results only: true requests the next page; the server supplies the exact cursor."),
  limit: z.number().int().min(1).max(SECURITY_SCAN_MAX_RESULTS).optional(),
  finalize: z.boolean().optional()
    .describe("For the final results fetch only: true closes the research ledger as completed or partial before returning it."),
  action: z.enum(["append", "update"]).optional().describe("Required only for record."),
  recordId: securityScanStableIdSchema.optional().describe("Required only when updating a record."),
  expectedRevision: z.number().int().positive().optional()
    .describe("For a record update or a handoff selecting an exact unit revision."),
  entry: z.strictObject({
    kind: securityScanRecordKindSchema,
    title: securityScanResearchTextSchema.optional(),
    summary: securityScanResearchTextSchema.optional().describe(
      "Required on kinds whose append contract includes summary; omit unchanged fields on update. For coverage/open_question it can supply rationale/question when omitted.",
    ),
    question: securityScanResearchTextSchema.optional(),
    state: z.union([securityScanHypothesisStateSchema, securityScanCoverageStateSchema]).optional(),
    confidence: securityScanConfidenceSchema.optional(),
    impact: securityScanResearchTextSchema.optional(),
    exploitPreconditions: securityScanResearchTextSchema.optional(),
    surfaceKey: securityScanStableIdSchema.optional(),
    rationale: securityScanResearchTextSchema.optional(),
    resolution: securityScanResearchTextSchema.optional().describe("For an answered open_question: the source-backed answer; retain its evidenceRefs and cite the inspected source."),
    blocker: securityScanResearchTextSchema.optional().describe("For limited coverage only: the concrete external dependency or unavailable source preventing further investigation, corroborated by cited evidence."),
    nextWork: securityScanResearchTextSchema.optional(),
    paths: z.array(z.string().min(1)).min(1).optional().describe("For review_unit: exact inventory file paths assigned to this concrete behavior, unchanged from the receipt."),
    trace: securityScanResearchTextSchema.optional().describe("For review_unit: when unreviewed or in_progress, describe the planned entry points and behavior to trace, clearly distinguishing inspected steps from unknowns. When reviewed, describe the entry point, caller, transformation, authority check, sink and outcome actually inspected. Link additional evidence notes rather than omit detail."),
    notes: securityScanResearchTextSchema.optional().describe("For review_unit: when unreviewed or in_progress, record investigation questions, protections to check and remaining work; do not invent completed inspection. When reviewed, record inspected protections, counterexamples, conclusions and remaining uncertainty. Detailed notes can span linked evidence records; not_applicable needs a justified exclusion."),
    surfaces: z.array(z.strictObject({
      key: securityScanStableIdSchema,
      label: securityScanResearchTextSchema,
      coverage: securityScanCoverageStateSchema,
      rationale: securityScanResearchTextSchema,
    })).optional(),
    evidenceRefs: z.array(modelEvidenceReferenceSchema).optional(),
    counterevidenceRefs: z.array(modelEvidenceReferenceSchema).optional(),
    openRecordIds: z.array(securityScanStableIdSchema).optional(),
  }).optional().describe([
    "Required only for record. Fields are strict by entry.kind:",
    "review_unit={kind,summary,surfaceKey,paths,state,trace,notes,evidenceRefs,counterevidenceRefs,openRecordIds,blocker?}; planned work uses state unreviewed or in_progress; reviewed requires a documented conclusion and relevant current source evidence, with no unresolved explicit follow-ups; trace/notes explain depth, sampling, selected source and limitations; not every assigned file needs a citation, and separate hypothesis/counterevidence records are optional; not_applicable requires an explicit justified exclusion;",
    "repository_map={kind,summary,surfaces,evidenceRefs} (surfaces may be omitted on the initial broad map and refined later);",
    "hypothesis={kind,summary,state,evidenceRefs,counterevidenceRefs};",
    "evidence/counterevidence={kind,summary,evidenceRefs} (cite scanner observations or provide fileCitations; these primary-evidence records do not cite other narrative ledger records); code_evidence IDs are Desktop-owned and are never model input;",
    "finding={kind,title,summary,confidence,impact,exploitPreconditions,evidenceRefs,counterevidenceRefs} (evidenceRefs may start empty when fileCitations are supplied);",
    "dismissal={kind,summary,evidenceRefs,counterevidenceRefs} (evidenceRefs may start empty when fileCitations are supplied; counterevidenceRefs may be empty when the dismissal directly cites the disproved evidence);",
    "coverage={kind,surfaceKey,state,rationale,evidenceRefs,blocker?} (link resolved hypotheses or exact completed review_unit IDs in evidenceRefs; reuse unit evidence when reconciling differently named map sections, without repeating source investigation; limited requires a concrete blocker);",
    "checkpoint={kind,summary,nextWork,openRecordIds,evidenceRefs};",
    "open_question={kind,question,evidenceRefs,resolution?}.",
    "For append, include every required field and required array. For update, include kind plus only the fields that change; Desktop merges them into the current server-owned revision. References must be exact scanner_observation or ledger_record IDs returned by this TaskRun; never invent or rename an ID. A citation-less evidence/counterevidence/finding/dismissal append immediately after one or more successful bounded file.read calls is bound to those exact server-observed read ranges; otherwise supply fileCitations explicitly. An immediate hypothesis transition to supported/rejected is bound to the immediately preceding evidence/counterevidence record, so do not copy its internal ID. Do not add fields from another kind.",
  ].join(" ")),
  fileCitations: z.array(modelFileCitationSchema)
    .max(SECURITY_SCAN_MAX_FILE_CITATIONS_PER_CALL).optional()
    .describe("For source evidence, counterevidence, findings, and dismissals, supply exact inspected relativePath/startLine/endLine citations here at top level. Paths written in entry.summary do not count. Desktop revalidates each citation. This is a per-request citation batch only: save further citations through successive updates with the returned expectedRevision, omitting entry.evidenceRefs to retain prior links. Durable evidenceRefs and counterevidenceRefs have no count ceiling."),
  reason: modelText(240).optional().describe("Optional only for cancel."),
});

export const SECURITY_SCAN_TOOL_DESCRIPTION = [
  "TASK-INTERNAL WORKER TOOL. Use only inside an authorized durable Task. From a Room call in_background with tools [file, security_scan], result_delivery raw_and_wake, the exact requested directory and a brief requiring the complete Markdown report as final response. Preserve explicit model/privacy choices. Task acceptance is not scanner startup. The runtime creates the Workspace report artifact; never request file.write. Server authority binds TaskRun, model, folder and Desktop; no shell or source mutation is allowed.",
  "Operation reference: start requires mode and explicit targetDirectory; use . only when Current Folder itself was requested. Never send scanId back. status reads current progress; results requires category and finalize:false during investigation. Continue an unchanged selection with continueResults:true when nextCursor is non-null. record requires a kind-valid entry; updates require recordId/expectedRevision and only changed fields. cancel stops this scan. Follow the single research workflow in the Task system instructions.",
  "handoff changes workspace inside this same Task when ACTIVE RESEARCH WORKSPACE enables it: save a current checkpoint, then call handoff alone with destination role and handoffRecordId. Investigator/unit-review assignments require unitRecordId/expectedRevision. Investigator returns directly to coordinator after saving its result and checkpoint, without reviewDecision. Per-unit reviewer handoffs are optional for a concrete concern. Reviewer returns to coordinator with reviewDecision. Whole-report review requires complete reportDraft, no unitRecordId. Legacy and scanners_only runs do not acquire mandatory roles.",
  "context retrieves exact historical visible bytes; use continueContext:true for required recovery, or explicit contextRef to select optional navigation/source. Follow runtime requiredAction: checkpoint means consolidate before more substantive pages. Context metadata is not execution, citation or inspection proof. Partial JSON is incomplete data; source identity/outcome must be verified. Runtime recovery facts are as-of snapshots. History indexes are optional navigation.",
  "Only after research and required review finish, results category:all finalize:true seals mutations; never batch first sealing with research/handoff. An accepted exportSnapshot delegates the complete sealed appendix to runtime export, so return the final narrative without model export paging. Without exportSnapshot, continue the same final selection until nextCursor:null. Preserve partial source/scanner limitations; a sealed/retrieved ledger is not semantic certification.",
].join("\n\n");

const consolidationSchema = securityScanModelOperationSchema.pick({
  version: true, operation: true, action: true, recordId: true, expectedRevision: true, entry: true, fileCitations: true,
  contextRef: true, contextCursor: true, contextBytes: true, continueContext: true, contextSourcePath: true,
  recordKinds: true, category: true, recordIds: true, limit: true, continueResults: true, finalize: true,
}).extend({ operation: z.enum(["record", "context", "results"]), finalize: z.literal(false).optional() });

/** Provider presentation only: current policy/catalog eligibility remains the ceiling. */
export function projectSecurityResearchConsolidationTools(tools: readonly StructuredTool[], consolidating: boolean): StructuredTool[] {
  if (!consolidating) return [...tools];
  return tools.filter((tool) => tool.name === "security_scan").map(() => createSecurityScanTool(true));
}

/**
 * This factory intentionally has no execution port. Invocation-service is the
 * sole caller allowed to add the private, server-authored relay envelope.
 */
export function createSecurityScanTool(consolidating = false): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "security_scan",
    description: consolidating
      ? "Save material research notes and cumulative checkpoints. All record kinds and canonical validation remain available. Use nonfinal results for needed saved notes and context for exact recovery when runtime permits. New investigation resumes after consolidation; no source mutation or finalization is available."
      : SECURITY_SCAN_TOOL_DESCRIPTION,
    schema: consolidating ? consolidationSchema : securityScanModelOperationSchema,
    func: () => Promise.reject(
      new Error(
        "security_scan is a Desktop relay tool — execution goes through the trusted security-scan invocation path, not direct invocation.",
      ),
    ),
  });
}
