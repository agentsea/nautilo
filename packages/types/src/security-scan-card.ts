/** Display-only security receipt projection. Never use this shape as execution or report authority. */
import { z } from "zod";
import {
  securityScanToolResultSchema,
  securityResearchRuntimeRecoverySchema,
  securityScanRecordKindSchema,
  securityScanRelativePathSchema,
  securityScanRecordPatchSchema,
  securityScanResearchProgressSchema,
  securityScanStatusSchema,
  securityScanRunStateSchema,
  securityScanModelStateSchema,
  securityScanCatalogModelIdSchema,
  securityScanStableIdSchema,
  securityScanErrorSchema,
  type SecurityScanResearchProgress,
  type SecurityScanStatus,
} from "./security-scan";

const recovery = "Full references and indexes remain in the saved research and final report.";
const count = z.number().int().nonnegative();
const byteCount = z.number().int().nonnegative().safe();
const contextOutcomeSchema = z.enum(["success", "error", "unknown"]);
const contextSourceFields = {
  outcome: contextOutcomeSchema.optional(),
  command: z.string().optional(), path: z.string().optional(), zone: z.string().optional(),
  offset: byteCount.optional(), limit: byteCount.optional(),
  lineRange: z.strictObject({ from: byteCount, to: byteCount }).optional(),
  continuedRead: z.literal(true).optional(),
  fieldsNotPresented: z.array(z.enum(["command", "path", "zone", "offset", "limit", "lineRange", "continuedRead", "toolCallId"])).optional(),
};
const contextSourceDisplaySchema = z.union([
  z.strictObject({ tool: z.literal("file"), identity: z.literal("paired"), ...contextSourceFields }),
  z.strictObject({ tool: z.literal("file"), identity: z.literal("unavailable"), outcome: contextOutcomeSchema.optional() }),
]);
export const securityResearchContextSourceSchema = z.union([
  z.strictObject({ tool: z.literal("file"), identity: z.literal("paired"), ...contextSourceFields,
    callRef: z.string().min(1), toolCallId: z.string().optional() }),
  z.strictObject({ tool: z.literal("file"), identity: z.literal("unavailable"), outcome: contextOutcomeSchema.optional() }),
]);
export type SecurityResearchContextSource = z.infer<typeof securityResearchContextSourceSchema>;
export const securityResearchContextSelectionSchema = z.strictObject({
  contextRef: z.string().min(1), contextCursor: z.string().min(1).optional(),
  contextBytes: z.number().int().positive().safe().optional(),
  recordKinds: z.array(securityScanRecordKindSchema).optional(), contextSourcePath: securityScanRelativePathSchema.optional(),
});
export type SecurityResearchContextSelection = z.infer<typeof securityResearchContextSelectionSchema>;
const contextPageSchema = z.strictObject({
  serialization: z.enum(["visible-message-index-json-utf8", "saved-record-index-json-utf8", "visible-message-json-utf8"]),
  startByte: byteCount, endByte: byteCount, totalBytes: byteCount,
  text: z.string(), complete: z.boolean(),
  source: contextSourceDisplaySchema.optional(),
}).refine((page) => page.startByte < page.endByte && page.endByte <= page.totalBytes
  && page.complete === (page.endByte === page.totalBytes), "inconsistent context page range");
const contextErrorSchema = z.strictObject({ code: z.string().min(1), message: z.string(), retryable: z.literal(false) });
/** Local historical paging receipt, separate from Desktop scan execution authority. */
export const securityResearchContextReceiptSchema = z.union([
  z.strictObject({ ok: z.literal(true), operation: z.literal("context"), runtimeRecovery: securityResearchRuntimeRecoverySchema.optional(), result: contextPageSchema.safeExtend({
    source: securityResearchContextSourceSchema.optional(),
    resolvedSelection: securityResearchContextSelectionSchema.optional(),
    version: z.literal("research-context-v1"), contextRef: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    nextCursor: z.string().min(1).nullable(),
  }).refine((page) => (page.nextCursor === null) === page.complete
    && new TextEncoder().encode(page.text).length === page.endByte - page.startByte, "inconsistent context page bytes") }),
  z.strictObject({ ok: z.literal(false), operation: z.literal("context"), runtimeRecovery: securityResearchRuntimeRecoverySchema.optional(), error: contextErrorSchema }),
]);
const checkpointShape = securityScanResearchProgressSchema.shape.latestCheckpoint.unwrap().shape;
const progressSchema = securityScanResearchProgressSchema.omit({ inventoryFingerprint: true, latestCheckpoint: true }).extend({
  latestCheckpoint: z.strictObject({
    summary: checkpointShape.summary,
    nextWork: checkpointShape.nextWork,
    openRecordCount: count,
  }).nullable(),
});
const statusSchema = z.strictObject({
  state: securityScanRunStateSchema,
  modelId: securityScanCatalogModelIdSchema.nullable(),
  modelState: securityScanModelStateSchema,
  coverage: securityScanStatusSchema.shape.coverage,
  researchProgress: progressSchema.optional(),
});
// Reuse the accepted record's field contracts. Index arrays deliberately stay
// in the canonical ledger; card size never grows with accumulated references.
const entrySchema = securityScanRecordPatchSchema.omit({
  paths: true, surfaces: true, evidenceRefs: true, counterevidenceRefs: true, openRecordIds: true,
});
export const securityScanCardProjectionSchema = z.strictObject({
  displayFormat: z.literal("security-research-card-v1"),
  recovery: z.literal(recovery),
  ok: z.boolean(),
  operation: z.enum(["start", "status", "results", "record", "cancel", "context"]),
  context: contextPageSchema.extend({ displayNotice: z.string().optional() }).optional(),
  runtimeRecovery: securityResearchRuntimeRecoverySchema.omit({ nextContextRef: true }).optional(),
  status: statusSchema.optional(),
  researchProgress: progressSchema.optional(),
  record: z.strictObject({
    id: securityScanStableIdSchema,
    revision: z.number().int().positive(),
    entry: entrySchema,
    evidenceCount: count,
    counterevidenceCount: count,
    openRecordCount: count,
    pathCount: count,
    surfaceCount: count,
    codeEvidenceCount: count,
  }).optional(),
  page: z.strictObject({ observations: count, codeEvidence: count, records: count, inventory: count, moreResults: z.boolean() }).optional(),
  error: z.union([securityScanErrorSchema, contextErrorSchema]).optional(),
}).superRefine((value, context) => {
  const valid = !value.ok
    ? value.error !== undefined && value.status === undefined && value.record === undefined && value.page === undefined && value.context === undefined
    : value.operation === "context"
      ? value.error === undefined && value.context !== undefined && value.status === undefined && value.record === undefined && value.page === undefined
    : value.context === undefined && value.error === undefined && (value.operation === "record"
      ? value.record !== undefined && value.status === undefined && value.page === undefined
      : value.status !== undefined && value.record === undefined && (value.operation === "results" ? value.page !== undefined : value.page === undefined));
  if (!valid) context.addIssue({ code: "custom", message: "inconsistent security card projection" });
});
export type SecurityScanCardProjection = z.infer<typeof securityScanCardProjectionSchema>;

function progressProjection(progress: SecurityScanResearchProgress): z.infer<typeof progressSchema> {
  const { inventoryFingerprint: _fingerprint, latestCheckpoint, ...work } = progress;
  return { ...work, latestCheckpoint: latestCheckpoint === null ? null : {
    summary: latestCheckpoint.summary, nextWork: latestCheckpoint.nextWork, openRecordCount: latestCheckpoint.openRecordIds.length,
  } };
}
function statusProjection(status: SecurityScanStatus): z.infer<typeof statusSchema> {
  return { state: status.state, modelId: status.modelId, modelState: status.modelState, coverage: status.coverage,
    ...(status.researchProgress ? { researchProgress: progressProjection(status.researchProgress) } : {}),
  };
}

/** Navigation is structured metadata, never source text. Partial JSON cannot
 * safely distinguish opaque handles from human-readable data; keep its range
 * facts and disclose the display omission instead of leaking fragments. */
function navigationDisplay(text: string): { text: string; displayNotice: string } {
  const displayNotice = "Display omits internal navigation handles. Exact navigation bytes remain available to the research runtime.";
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const rows = Array.isArray(value["messages"]) ? value["messages"] : Array.isArray(value["records"]) ? value["records"] : null;
    if (!rows) return { text: "Partial navigation page; see its byte range and research status.", displayNotice };
    const displayed = rows.map((row: unknown) => {
      if (typeof row !== "object" || row === null) return {};
      const data = row as Record<string, unknown>;
      const fields = ["messageIndex", "kind", "toolName", "outcome", "totalBytes", "revision", "title", "state", "sourcePaths"];
      const output = Object.fromEntries(fields.filter((field) => data[field] !== undefined).map((field) => [field, data[field]]));
      const source = securityResearchContextSourceSchema.safeParse(data["source"]);
      if (source.success) output["source"] = source.data.identity === "paired"
        ? (({ callRef: _ref, toolCallId: _id, ...identity }) => identity)(source.data) : source.data;
      return output;
    });
    return { text: JSON.stringify({ entries: displayed }, null, 2), displayNotice };
  } catch {
    return { text: "Partial navigation page; see its byte range and research status.", displayNotice };
  }
}

/** Validate the complete canonical receipt before omitting any presentation-only indexes. */
export function projectSecurityScanCardResult(raw: unknown): SecurityScanCardProjection | null {
  // Repeated live/history/card projection remains idempotent. This display
  // schema carries no cursor, file authority, or report-readiness proof.
  const displayed = securityScanCardProjectionSchema.safeParse(raw);
  if (displayed.success) return displayed.data;
  const historical = securityResearchContextReceiptSchema.safeParse(raw);
  if (historical.success) {
    const receipt = historical.data;
    const runtimeRecovery = receipt.runtimeRecovery ? (({ nextContextRef: _ref, ...facts }) => facts)(receipt.runtimeRecovery) : undefined;
    const base = { displayFormat: "security-research-card-v1" as const, recovery, ok: receipt.ok, operation: "context" as const, ...(runtimeRecovery ? { runtimeRecovery } : {}) } as const;
    if (!receipt.ok) return { ...base, error: receipt.error };
    const { contextRef: _ref, sha256: _sha, nextCursor: _cursor, version: _version, resolvedSelection: _selection, source, ...context } = receipt.result;
    const displayedSource = source?.identity === "paired"
      ? (({ callRef: _callRef, toolCallId: _callId, ...identity }) => identity)(source) : source;
    return { ...base, context: { ...context, ...(context.serialization !== "visible-message-json-utf8" ? navigationDisplay(context.text) : {}), ...(displayedSource ? { source: displayedSource } : {}) } };
  }
  const parsed = securityScanToolResultSchema.safeParse(raw);
  if (!parsed.success) return null;
  const receipt = parsed.data;
  const runtimeRecovery = receipt.runtimeRecovery ? (({ nextContextRef: _ref, ...facts }) => facts)(receipt.runtimeRecovery) : undefined;
  const base = { displayFormat: "security-research-card-v1" as const, recovery, ok: receipt.ok, operation: receipt.operation, ...(runtimeRecovery ? { runtimeRecovery } : {}) } as const;
  if (!receipt.ok) return { ...base, error: receipt.error };
  if (receipt.operation === "record") {
    const { record, codeEvidence, researchProgress } = receipt.result;
    const { paths, surfaces, evidenceRefs, counterevidenceRefs, openRecordIds, ...entry } = securityScanRecordPatchSchema.parse(record.entry);
    return { ...base, ...(researchProgress ? { researchProgress: progressProjection(researchProgress) } : {}),
      record: { id: record.id, revision: record.revision, entry,
        evidenceCount: evidenceRefs?.length ?? 0, counterevidenceCount: counterevidenceRefs?.length ?? 0,
        openRecordCount: openRecordIds?.length ?? 0, pathCount: paths?.length ?? 0, surfaceCount: surfaces?.length ?? 0,
        codeEvidenceCount: codeEvidence.length,
      },
    };
  }
  if (receipt.operation === "results") {
    const result = receipt.result;
    return { ...base, status: statusProjection(result.status), page: {
      observations: result.observations.length, codeEvidence: result.codeEvidence.length,
      records: result.records.length, inventory: result.inventory?.length ?? 0, moreResults: result.nextCursor !== null,
    } };
  }
  return { ...base, status: statusProjection(receipt.result) };
}
