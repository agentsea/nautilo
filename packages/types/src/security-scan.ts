import { z } from "zod";

/**
 * D560 — browser-safe contract for the one `security_scan` tool family.
 *
 * The model supplies research intent and notes. Task, TaskRun, authorized
 * root, relay, and selected model are resolved by the server from the active
 * tool invocation; they are deliberately not part of the start arguments.
 */
export const SECURITY_SCAN_VERSION = "security-scan-v1" as const;

export const SECURITY_SCAN_MAX_RESULTS = 100;
/** Legacy per-request citation framing only; accumulated durable references are not capped. */
export const SECURITY_SCAN_MAX_FILE_CITATIONS_PER_CALL = 20;
/** Compact status projection only; saved repository maps have no section count ceiling. */
export const SECURITY_SCAN_MAX_STATUS_COVERAGE = 32;
/** Legacy diagnostic/inventory framing; this never limits research or scanner notes. */
export const SECURITY_SCAN_MAX_TEXT_CHARS = 2_000;

const STABLE_ID_PATTERN = /^[a-z][a-z0-9_-]{1,127}$/;
const boundedText = (maximum: number) => z.string()
  .trim()
  .min(1)
  .max(maximum)
  .refine((value) => !/\p{Cc}/u.test(value), "text must not contain control characters");

/** Authored investigation is durable content, not a transport-sized label. */
export const securityScanResearchTextSchema = z.string().min(1)
  .refine((value) => value.trim().length > 0, "research text must not be blank")
  .refine((value) => !/\p{Cc}/u.test(value.replace(/[\t\n\r]/g, "")), "research text must not contain non-text control characters");

function isSafeRelativePath(value: string): boolean {
  if (!value) return false;
  if (/[/\\]/.test(value.slice(0, 1)) || /^[A-Za-z]:\//.test(value)) return false;
  if (/\\|\p{Cc}/u.test(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Server-authored opaque identifiers that a model may only echo after receipt. */
export const securityScanStableIdSchema = z.string()
  .regex(STABLE_ID_PATTERN, "identifier must be a stable lowercase token");

/** Catalog model ids retain their existing provider-qualified spelling. */
export const securityScanCatalogModelIdSchema = z.string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/, "invalid catalog model identifier");

export const securityScanIdSchema = z.string()
  .regex(/^scan_[a-z0-9_-]{2,123}$/, "invalid security scan identifier");

export const securityScanRelativePathSchema = z.string()
  .refine(isSafeRelativePath, {
    message: "path must be a normalized relative path",
  });

export const securityScanModeSchema = z.enum(["deep_research", "scanners_only"]);
export type SecurityScanMode = z.infer<typeof securityScanModeSchema>;

export const securityScanProbeSchema = z.enum([
  "gitleaks",
  "osv_scanner",
  "trivy",
  "semgrep",
]);
export type SecurityScanProbe = z.infer<typeof securityScanProbeSchema>;

export const securityScanProbeLaneStateSchema = z.enum([
  "pending",
  "running",
  "completed",
  "skipped",
  "unavailable",
  "failed",
  "capped",
  "cancelled",
]);
export type SecurityScanProbeLaneState = z.infer<typeof securityScanProbeLaneStateSchema>;

export const securityScanPhaseSchema = z.enum([
  "admitting",
  "mapping",
  "probing",
  "researching",
  "coverage_audit",
  "finalizing",
]);
export type SecurityScanPhase = z.infer<typeof securityScanPhaseSchema>;

export const securityScanTerminalStateSchema = z.enum([
  "completed",
  "partial",
  "failed",
  "cancelled",
]);
export type SecurityScanTerminalState = z.infer<typeof securityScanTerminalStateSchema>;

export const securityScanRunStateSchema = z.enum([
  "active",
  "completed",
  "partial",
  "failed",
  "cancelled",
]);
export type SecurityScanRunState = z.infer<typeof securityScanRunStateSchema>;

export const securityScanCoverageStateSchema = z.enum([
  "unreviewed",
  "in_progress",
  "reviewed",
  "limited",
  "not_applicable",
]);
export type SecurityScanCoverageState = z.infer<typeof securityScanCoverageStateSchema>;

export const securityScanModelStateSchema = z.enum([
  "disabled",
  "pending",
  "running",
  "completed",
  "unavailable",
  "failed",
  "cancelled",
]);

export const securityScanErrorCodeSchema = z.enum([
  "invalid_request",
  "scan_not_found",
  "scan_not_active",
  "research_incomplete",
  "desktop_upgrade_required",
  "root_not_authorized",
  "root_unavailable",
  "root_revoked",
  "root_path_escaped",
  "relay_unavailable",
  "model_unavailable",
  "model_failed",
  "probe_unavailable",
  "probe_failed",
  "probe_capped",
  "probe_output_invalid",
  "rules_unavailable",
  "evidence_not_found",
  "evidence_not_authorized",
  "record_conflict",
  "artifact_corrupt",
  "artifact_too_large",
  "cancelled",
  "internal",
]);
export type SecurityScanErrorCode = z.infer<typeof securityScanErrorCodeSchema>;

export const securityScanErrorSchema = z.strictObject({
  code: securityScanErrorCodeSchema,
  retryable: z.boolean(),
  /** Fixed safe message; never scanner stderr, an absolute path, or a secret. */
  message: boundedText(240),
  /** Actionable research repair; separate from the short status label. */
  continuation: boundedText(SECURITY_SCAN_MAX_TEXT_CHARS).optional(),
});
export type SecurityScanError = z.infer<typeof securityScanErrorSchema>;

/**
 * Trusted server context, kept separate from model arguments. `toolCallId` is
 * the server-authoritative idempotency source for later ledger writes; a model
 * never supplies a separate idempotency key.
 */
export const securityScanTrustedContextSchema = z.strictObject({
  taskId: z.uuid(),
  taskRunId: z.uuid(),
  toolCallId: boundedText(512),
  /** The Task's actual resolved catalog model; scan mode never selects it. */
  modelId: securityScanCatalogModelIdSchema.nullable(),
});
export type SecurityScanTrustedContext = z.infer<typeof securityScanTrustedContextSchema>;

export const securityScanEvidenceReferenceSchema = z.strictObject({
  /** File citations become Desktop-minted `code_evidence` before use. */
  kind: z.enum(["scanner_observation", "code_evidence", "ledger_record"]),
  id: securityScanStableIdSchema,
});
export type SecurityScanEvidenceReference = z.infer<typeof securityScanEvidenceReferenceSchema>;

// Durable links accumulate across accepted citation batches and survive full export.
const evidenceReferencesSchema = z.array(securityScanEvidenceReferenceSchema);

/**
 * A model may cite a bounded file range, but never an excerpt. The Desktop
 * coordinator re-reads and hashes this range before minting durable evidence.
 */
export const securityScanFileCitationInputSchema = z.strictObject({
  relativePath: securityScanRelativePathSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  searchQuery: boundedText(500).optional(),
}).superRefine((value, context) => {
  if (value.endLine < value.startLine) {
    context.addIssue({ code: "custom", message: "endLine cannot precede startLine", path: ["endLine"] });
  }
});
export type SecurityScanFileCitationInput = z.infer<typeof securityScanFileCitationInputSchema>;

const fileCitationsSchema = z.array(securityScanFileCitationInputSchema)
  .max(SECURITY_SCAN_MAX_FILE_CITATIONS_PER_CALL, {
    message: `Submit at most ${SECURITY_SCAN_MAX_FILE_CITATIONS_PER_CALL} file citations per request. Save every citation in successive record updates using each accepted revision; omit entry.evidenceRefs to retain earlier links. Do not discard citations.`,
  });

export const securityScanRecordKindSchema = z.enum([
  "repository_map",
  "review_unit",
  "hypothesis",
  "evidence",
  "counterevidence",
  "finding",
  "dismissal",
  "coverage",
  "checkpoint",
  "open_question",
]);
export type SecurityScanRecordKind = z.infer<typeof securityScanRecordKindSchema>;

export const securityScanHypothesisStateSchema = z.enum([
  "planned",
  "investigating",
  "supported",
  "rejected",
  "unresolved",
]);

export const securityScanConfidenceSchema = z.enum(["low", "medium", "high"]);

const securityScanRepositorySurfaceInputSchema = z.strictObject({
  key: securityScanStableIdSchema,
  label: securityScanResearchTextSchema,
  coverage: securityScanCoverageStateSchema,
  rationale: securityScanResearchTextSchema,
});

export const securityScanRecordInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("review_unit"),
    summary: securityScanResearchTextSchema,
    surfaceKey: securityScanStableIdSchema,
    paths: z.array(securityScanRelativePathSchema).min(1),
    state: securityScanCoverageStateSchema,
    trace: securityScanResearchTextSchema,
    notes: securityScanResearchTextSchema,
    blocker: securityScanResearchTextSchema.optional(),
    evidenceRefs: evidenceReferencesSchema,
    counterevidenceRefs: evidenceReferencesSchema,
    openRecordIds: z.array(securityScanStableIdSchema),
  }),
  z.strictObject({
    kind: z.literal("repository_map"),
    summary: securityScanResearchTextSchema,
    surfaces: z.array(securityScanRepositorySurfaceInputSchema)
      .default([]),
    evidenceRefs: evidenceReferencesSchema,
  }),
  z.strictObject({
    kind: z.literal("hypothesis"),
    summary: securityScanResearchTextSchema,
    state: securityScanHypothesisStateSchema,
    evidenceRefs: evidenceReferencesSchema,
    counterevidenceRefs: evidenceReferencesSchema,
  }),
  z.strictObject({
    kind: z.literal("evidence"),
    summary: securityScanResearchTextSchema,
    /** May be bootstrapped by a revalidated file citation on the record call. */
    evidenceRefs: evidenceReferencesSchema,
  }),
  z.strictObject({
    kind: z.literal("counterevidence"),
    summary: securityScanResearchTextSchema,
    /** May be bootstrapped by a revalidated file citation on the record call. */
    evidenceRefs: evidenceReferencesSchema,
  }),
  z.strictObject({
    kind: z.literal("finding"),
    title: securityScanResearchTextSchema,
    summary: securityScanResearchTextSchema,
    confidence: securityScanConfidenceSchema,
    impact: securityScanResearchTextSchema,
    exploitPreconditions: securityScanResearchTextSchema,
    /** May be bootstrapped by a revalidated file citation on the record call. */
    evidenceRefs: evidenceReferencesSchema,
    counterevidenceRefs: evidenceReferencesSchema,
  }),
  z.strictObject({
    kind: z.literal("dismissal"),
    summary: securityScanResearchTextSchema,
    /** May be bootstrapped by a revalidated file citation on the record call. */
    evidenceRefs: evidenceReferencesSchema,
    /** Optional links to separately recorded counterevidence; the dismissal itself carries the disproof. */
    counterevidenceRefs: evidenceReferencesSchema,
  }),
  z.strictObject({
    kind: z.literal("coverage"),
    blocker: securityScanResearchTextSchema.optional(),
    surfaceKey: securityScanStableIdSchema,
    state: securityScanCoverageStateSchema,
    rationale: securityScanResearchTextSchema,
    evidenceRefs: evidenceReferencesSchema,
  }),
  z.strictObject({
    kind: z.literal("checkpoint"),
    summary: securityScanResearchTextSchema,
    nextWork: securityScanResearchTextSchema,
    openRecordIds: z.array(securityScanStableIdSchema),
    evidenceRefs: evidenceReferencesSchema,
  }),
  z.strictObject({
    kind: z.literal("open_question"),
    resolution: securityScanResearchTextSchema.optional(),
    question: securityScanResearchTextSchema,
    evidenceRefs: evidenceReferencesSchema,
  }),
]);
export type SecurityScanRecordInput = z.infer<typeof securityScanRecordInputSchema>;

/**
 * Updates are patches over a server-owned ledger record. The model identifies
 * the immutable kind and sends only fields it intends to change; Desktop
 * merges the patch with the current revision before revalidating the complete
 * kind-specific record.
 */
export const securityScanRecordPatchSchema = z.strictObject({
  kind: securityScanRecordKindSchema,
  title: securityScanResearchTextSchema.optional(),
  summary: securityScanResearchTextSchema.optional(),
  question: securityScanResearchTextSchema.optional(),
  resolution: securityScanResearchTextSchema.optional(),
  state: z.union([securityScanHypothesisStateSchema, securityScanCoverageStateSchema]).optional(),
  confidence: securityScanConfidenceSchema.optional(),
  impact: securityScanResearchTextSchema.optional(),
  exploitPreconditions: securityScanResearchTextSchema.optional(),
  surfaceKey: securityScanStableIdSchema.optional(),
  rationale: securityScanResearchTextSchema.optional(),
  blocker: securityScanResearchTextSchema.optional(),
  nextWork: securityScanResearchTextSchema.optional(),
  paths: z.array(securityScanRelativePathSchema).min(1).optional(),
  trace: securityScanResearchTextSchema.optional(),
  notes: securityScanResearchTextSchema.optional(),
  surfaces: z.array(securityScanRepositorySurfaceInputSchema)
    .optional(),
  evidenceRefs: evidenceReferencesSchema.optional(),
  counterevidenceRefs: evidenceReferencesSchema.optional(),
  openRecordIds: z.array(securityScanStableIdSchema).optional(),
});
export type SecurityScanRecordPatch = z.infer<typeof securityScanRecordPatchSchema>;

export const securityScanRecordAuthorSchema = z.strictObject({
  taskId: z.uuid(),
  taskRunId: z.uuid(),
  modelId: securityScanCatalogModelIdSchema.nullable(),
});
export type SecurityScanRecordAuthor = z.infer<typeof securityScanRecordAuthorSchema>;

/** Stable server-authored identity, authorship, revision, and timestamps. */
export const securityScanLedgerRecordSchema = z.strictObject({
  id: securityScanStableIdSchema,
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  createdBy: securityScanRecordAuthorSchema,
  updatedBy: securityScanRecordAuthorSchema,
  entry: securityScanRecordInputSchema,
}).superRefine((value, context) => {
  if ((value.entry.kind === "finding" || value.entry.kind === "dismissal") && value.entry.evidenceRefs.length === 0) {
    context.addIssue({ code: "custom", message: "persisted conclusions require durable evidence", path: ["entry", "evidenceRefs"] });
  }
});
export type SecurityScanLedgerRecord = z.infer<typeof securityScanLedgerRecordSchema>;

const securityScanObservationInputSchema = z.strictObject({
  id: securityScanStableIdSchema,
  probe: securityScanProbeSchema,
  /** Whether a cited path came from the readable tree or Git history. */
  sourceScope: z.enum(["current_tree", "git_history"]).default("current_tree"),
  /** Rule/advisory/package identifiers are attribution, never unbounded tool output. */
  ruleId: z.string().trim().min(1).max(256).nullable(),
  advisoryId: z.string().trim().min(1).max(256).nullable(),
  packageName: z.string().trim().min(1).max(256).nullable(),
  /** Readable only when sourceScope is current_tree. */
  relativePath: securityScanRelativePathSchema.nullable(),
  /** Historical provenance only. Never pass this path to the file tool. */
  historyOnlyPath: securityScanRelativePathSchema.nullable().optional(),
  startLine: z.number().int().positive().nullable(),
  endLine: z.number().int().positive().nullable(),
  severity: z.enum(["info", "low", "medium", "high", "critical", "unknown"]),
  summary: securityScanResearchTextSchema,
  /** Raw detected values and source excerpts are never part of this contract. */
  secretRedacted: z.boolean(),
}).superRefine((value, context) => {
  if (value.startLine !== null && value.endLine !== null && value.endLine < value.startLine) {
    context.addIssue({ code: "custom", message: "endLine cannot precede startLine", path: ["endLine"] });
  }
  if (value.sourceScope === "current_tree" && value.historyOnlyPath != null) {
    context.addIssue({ code: "custom", message: "current-tree observations cannot carry a history-only path", path: ["historyOnlyPath"] });
  }
}).transform((value) => value.sourceScope === "git_history"
  ? {
      ...value,
      relativePath: null,
      historyOnlyPath: value.historyOnlyPath ?? value.relativePath,
    }
  : {
      ...value,
      historyOnlyPath: null,
    });

/** Normalizes legacy history observations so provenance never looks current-tree readable. */
export const securityScanObservationSchema = securityScanObservationInputSchema;
export type SecurityScanObservation = z.infer<typeof securityScanObservationSchema>;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "expected a lowercase SHA-256 digest");

/**
 * Desktop-minted proof for one bounded source range. It deliberately carries
 * no source excerpt or absolute path; the digests bind it to the locally
 * revalidated root and exact bytes that Desktop read.
 */
export const securityScanCodeEvidenceSchema = z.strictObject({
  id: securityScanStableIdSchema,
  relativePath: securityScanRelativePathSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  sourceVersion: sha256Schema.optional(),
  fileSha256: sha256Schema,
  rangeSha256: sha256Schema,
  rootFingerprint: sha256Schema,
  capturedAt: z.iso.datetime(),
  gitHead: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  gitDirty: z.boolean().nullable(),
}).superRefine((value, context) => {
  if (value.endLine < value.startLine) {
    context.addIssue({ code: "custom", message: "endLine cannot precede startLine", path: ["endLine"] });
  }
});
export type SecurityScanCodeEvidence = z.infer<typeof securityScanCodeEvidenceSchema>;

export const securityScanProbeLaneSchema = z.strictObject({
  probe: securityScanProbeSchema,
  state: securityScanProbeLaneStateSchema,
  observationCount: z.number().int().nonnegative(),
  coverage: securityScanCoverageStateSchema,
  error: securityScanErrorSchema.nullable(),
}).superRefine((value, context) => {
  const errorRequired = value.state === "unavailable" || value.state === "failed" || value.state === "capped";
  if (errorRequired && value.error === null) {
    context.addIssue({ code: "custom", message: "this lane state requires an error", path: ["error"] });
  }
  if (!errorRequired && value.error !== null) {
    context.addIssue({ code: "custom", message: "only unavailable, failed, or capped lanes carry an error", path: ["error"] });
  }
});
export type SecurityScanProbeLane = z.infer<typeof securityScanProbeLaneSchema>;

/** The default makes the unimplemented Semgrep lane visible and truthful. */
export const SECURITY_SCAN_INITIAL_LANES: readonly SecurityScanProbeLane[] = [
  { probe: "gitleaks", state: "pending", observationCount: 0, coverage: "unreviewed", error: null },
  { probe: "osv_scanner", state: "pending", observationCount: 0, coverage: "unreviewed", error: null },
  { probe: "trivy", state: "pending", observationCount: 0, coverage: "unreviewed", error: null },
  {
    probe: "semgrep",
    state: "unavailable",
    observationCount: 0,
    coverage: "limited",
    error: {
      code: "rules_unavailable",
      retryable: true,
      message: "Semgrep probe and approved rules are unavailable.",
    },
  },
];

export const securityScanCoverageSummarySchema = z.strictObject({
  surfaceKey: securityScanStableIdSchema,
  label: securityScanResearchTextSchema,
  state: securityScanCoverageStateSchema,
  /** Status preview only; full authored rationale remains in the ledger record. */
  rationale: z.string().max(500),
});
export type SecurityScanCoverageSummary = z.infer<typeof securityScanCoverageSummarySchema>;

/** Existing status-only preview contract; authored hypothesis text stays lossless. */
export const SECURITY_SCAN_HYPOTHESIS_STATUS_PREVIEW_CHARS = 500;
export function securityScanHypothesisStatusPreview(summary: string): string {
  return summary.slice(0, SECURITY_SCAN_HYPOTHESIS_STATUS_PREVIEW_CHARS);
}

export const securityScanHypothesisSummarySchema = z.strictObject({
  id: securityScanStableIdSchema,
  state: securityScanHypothesisStateSchema,
  /** Status preview only; full authored hypothesis remains in the ledger record. */
  summary: z.string().max(SECURITY_SCAN_HYPOTHESIS_STATUS_PREVIEW_CHARS),
});
export type SecurityScanHypothesisSummary = z.infer<typeof securityScanHypothesisSummarySchema>;

/** Desktop-authored target inventory; a file is classified, never implicitly reviewed. */
export const securityScanInventoryEntrySchema = z.strictObject({
  id: securityScanStableIdSchema,
  relativePath: securityScanRelativePathSchema,
  kind: z.enum(["file", "excluded", "unavailable"]),
  sizeBytes: z.number().int().nonnegative(),
  sourceVersion: sha256Schema.nullable(),
  reason: boundedText(SECURITY_SCAN_MAX_TEXT_CHARS).nullable(),
});
export type SecurityScanInventoryEntry = z.infer<typeof securityScanInventoryEntrySchema>;

export const securityScanResearchProgressSchema = z.strictObject({
  inventoryState: z.enum(["complete", "legacy"]),
  inventoryFingerprint: sha256Schema.nullable(),
  filesTotal: z.number().int().nonnegative(),
  filesAssigned: z.number().int().nonnegative(),
  filesUnassigned: z.number().int().nonnegative(),
  unitsTotal: z.number().int().nonnegative(),
  unitsCompleted: z.number().int().nonnegative(),
  unitsPending: z.number().int().nonnegative(),
  /** Exact trusted completion repair; absent on older peers. Null does not prove source freshness or report readiness. */
  nextResearchWork: z.string().nullable().optional(),
  excludedEntriesTotal: z.number().int().nonnegative(),
  unavailableEntriesTotal: z.number().int().nonnegative().default(0),
  coverageTotal: z.number().int().nonnegative(),
  hypothesesTotal: z.number().int().nonnegative(),
  coverageOmitted: z.number().int().nonnegative(),
  hypothesesOmitted: z.number().int().nonnegative(),
  latestCheckpoint: z.strictObject({
    id: securityScanStableIdSchema,
    summary: securityScanResearchTextSchema,
    nextWork: securityScanResearchTextSchema,
    openRecordIds: z.array(securityScanStableIdSchema),
  }).nullable(),
});
export type SecurityScanResearchProgress = z.infer<typeof securityScanResearchProgressSchema>;

export const securityScanStatusSchema = z.strictObject({
  version: z.literal(SECURITY_SCAN_VERSION),
  scanId: securityScanIdSchema,
  state: securityScanRunStateSchema,
  phase: securityScanPhaseSchema.nullable(),
  terminalState: securityScanTerminalStateSchema.nullable(),
  mode: securityScanModeSchema,
  /** Canonical scan target, relative to Current Folder. Absent on legacy ledgers. */
  targetDirectory: z.string().min(1).optional(),
  targetFingerprint: sha256Schema.optional(),
  researchProgress: securityScanResearchProgressSchema.optional(),
  /** Server-resolved Task model, never a tool-request selector. */
  modelId: securityScanCatalogModelIdSchema.nullable(),
  modelState: securityScanModelStateSchema,
  completedSteps: z.number().int().nonnegative(),
  totalSteps: z.number().int().positive(),
  lanes: z.array(securityScanProbeLaneSchema).length(4),
  coverage: z.array(securityScanCoverageSummarySchema).max(SECURITY_SCAN_MAX_STATUS_COVERAGE),
  hypotheses: z.array(securityScanHypothesisSummarySchema).max(20),
}).superRefine((value, context) => {
  if (value.completedSteps > value.totalSteps) {
    context.addIssue({ code: "custom", message: "completedSteps cannot exceed totalSteps", path: ["completedSteps"] });
  }
  const seenProbes = new Set(value.lanes.map((lane) => lane.probe));
  if (seenProbes.size !== 4 || [...seenProbes].some((probe) => !securityScanProbeSchema.options.includes(probe))) {
    context.addIssue({ code: "custom", message: "lanes must contain every probe exactly once", path: ["lanes"] });
  }
  const terminal = value.state === "active" ? null : value.state;
  if (value.terminalState !== terminal) {
    context.addIssue({ code: "custom", message: "terminalState must match the run state", path: ["terminalState"] });
  }
  if (value.mode === "scanners_only" && (value.modelId !== null || value.modelState !== "disabled")) {
    context.addIssue({ code: "custom", message: "scanners-only runs must not identify or run a model", path: ["modelId"] });
  }
  if (value.mode === "deep_research" && value.modelId === null) {
    context.addIssue({ code: "custom", message: "deep research requires the Task-resolved model id", path: ["modelId"] });
  }
});
export type SecurityScanStatus = z.infer<typeof securityScanStatusSchema>;

export const securityScanResultEnvelopeSchema = z.strictObject({
  /** Exact immutable, unfiltered export identity; populated only after sealing. */
  exportSnapshot: z.strictObject({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    itemCount: z.number().int().nonnegative().safe(),
  }).optional(),
  /** Desktop-derived proof of finalized, evidenced, fully paged research. */
  reportReady: z.boolean().optional(),
  version: z.literal(SECURITY_SCAN_VERSION),
  status: securityScanStatusSchema,
  observations: z.array(securityScanObservationSchema).max(SECURITY_SCAN_MAX_RESULTS),
  codeEvidence: z.array(securityScanCodeEvidenceSchema).max(SECURITY_SCAN_MAX_RESULTS),
  records: z.array(securityScanLedgerRecordSchema).max(SECURITY_SCAN_MAX_RESULTS),
  inventory: z.array(securityScanInventoryEntrySchema).max(SECURITY_SCAN_MAX_RESULTS).optional(),
  nextCursor: securityScanStableIdSchema.nullable(),
}).superRefine((value, context) => {
  if (value.observations.length + value.codeEvidence.length + value.records.length + (value.inventory?.length ?? 0) > SECURITY_SCAN_MAX_RESULTS) {
    context.addIssue({ code: "custom", message: "result page exceeds the aggregate item limit" });
  }
});
export type SecurityScanResultEnvelope = z.infer<typeof securityScanResultEnvelopeSchema>;

export const securityScanRecordAcknowledgementSchema = z.strictObject({
  researchProgress: securityScanResearchProgressSchema.optional(),
  record: securityScanLedgerRecordSchema,
  /** Newly minted evidence only; prior evidence remains available via results. */
  codeEvidence: z.array(securityScanCodeEvidenceSchema)
    .max(SECURITY_SCAN_MAX_FILE_CITATIONS_PER_CALL),
});
export type SecurityScanRecordAcknowledgement = z.infer<typeof securityScanRecordAcknowledgementSchema>;

const statusOperationSchema = z.strictObject({
  version: z.literal(SECURITY_SCAN_VERSION),
  operation: z.literal("status"),
  /** Opaque continuation target, not a filesystem or authority reference. */
  scanId: securityScanIdSchema,
});

const startOperationSchema = z.strictObject({
  version: z.literal(SECURITY_SCAN_VERSION),
  operation: z.literal("start"),
  mode: securityScanModeSchema,
  /** Explicit directory within the authorized Current Folder; never inferred. */
  targetDirectory: z.string().min(1).refine((value) => !/[\p{Cc}]/u.test(value), "invalid target directory"),
  /** Resume an earlier scan from a continuation TaskRun when present. */
  priorScanId: securityScanIdSchema.optional(),
});

const resultsOperationSchema = z.strictObject({
  version: z.literal(SECURITY_SCAN_VERSION),
  operation: z.literal("results"),
  scanId: securityScanIdSchema,
  category: z.enum(["all", "observations", "research", "inventory"]),
  probes: z.array(securityScanProbeSchema).max(4).optional(),
  recordKinds: z.array(securityScanRecordKindSchema).max(securityScanRecordKindSchema.options.length).optional(),
  recordIds: z.array(securityScanStableIdSchema).optional(),
  cursor: securityScanStableIdSchema.optional(),
  limit: z.number().int().min(1).max(SECURITY_SCAN_MAX_RESULTS).default(50),
  /** The final deterministic fetch closes model-led research before reporting. */
  finalize: z.boolean().default(false),
});

const recordOperationSchema = z.strictObject({
  version: z.literal(SECURITY_SCAN_VERSION),
  operation: z.literal("record"),
  scanId: securityScanIdSchema,
  action: z.enum(["append", "update"]),
  /** Required only for an update; the handler verifies model-pass ownership. */
  recordId: securityScanStableIdSchema.optional(),
  /** Optimistic concurrency guard; required only for an update. */
  expectedRevision: z.number().int().positive().optional(),
  entry: securityScanRecordPatchSchema,
  fileCitations: fileCitationsSchema.default([]),
}).superRefine((value, context) => {
  if (value.action === "update" && (value.recordId === undefined || value.expectedRevision === undefined)) {
    context.addIssue({ code: "custom", message: "updates require a recordId and expectedRevision", path: ["recordId"] });
  }
  if (value.action === "append" && (value.recordId !== undefined || value.expectedRevision !== undefined)) {
    context.addIssue({ code: "custom", message: "appends must not supply record identity or revision", path: ["recordId"] });
  }
  if (value.action === "append") {
    const complete = securityScanRecordInputSchema.safeParse(value.entry);
    if (!complete.success) {
      for (const issue of complete.error.issues) context.addIssue({ ...issue, path: ["entry", ...issue.path] });
    }
  }
  if (
    value.action === "append"
    &&
    (value.entry.kind === "evidence" || value.entry.kind === "counterevidence" || value.entry.kind === "finding" || value.entry.kind === "dismissal")
    && (value.entry.evidenceRefs?.length ?? 0) === 0
    && value.fileCitations.length === 0
  ) {
    context.addIssue({
      code: "custom",
      message: "evidence records require a durable reference or revalidated file citation",
      path: ["fileCitations"],
    });
  }
});

const cancelOperationSchema = z.strictObject({
  version: z.literal(SECURITY_SCAN_VERSION),
  operation: z.literal("cancel"),
  scanId: securityScanIdSchema,
  reason: boundedText(240).optional(),
});

/** All and only the model-facing `security_scan` operations. */
export const securityScanOperationSchema = z.discriminatedUnion("operation", [
  startOperationSchema,
  statusOperationSchema,
  resultsOperationSchema,
  recordOperationSchema,
  cancelOperationSchema,
]);
export type SecurityScanOperation = z.infer<typeof securityScanOperationSchema>;

/**
 * Private server-to-Desktop relay envelope. The `operation` is the only
 * model-authored portion; invocation-service mints `trustedContext` after
 * admission and never accepts it back from a model call.
 */
export const securityScanRelayRequestSchema = z.strictObject({
  operation: securityScanOperationSchema,
  trustedContext: securityScanTrustedContextSchema,
  /** Server-authored stale assertion; Desktop remains the path authority. */
  expectedCurrentFolder: z.string()
    .min(1)
    .refine((value) => value.startsWith("/") && !/\p{Cc}/u.test(value), {
      message: "expectedCurrentFolder must be an absolute control-free path",
    }),
});
export type SecurityScanRelayRequest = z.infer<typeof securityScanRelayRequestSchema>;

/** Server-derived TaskRun recovery facts; never ledger or model completion authority. */
export const securityResearchRuntimeRecoverySchema = z.strictObject({
  phase: z.enum(["inactive", "reading", "consolidation_required"]),
  pendingInputCount: z.number().int().nonnegative(),
  recoveredInputBytes: z.number().int().nonnegative().safe(),
  retainedUnconsolidatedPages: z.number().int().nonnegative(),
  asOfMessageIndex: z.number().int().nonnegative(),
  nextContextRef: z.string().nullable(),
});
export type SecurityResearchRuntimeRecovery = z.infer<typeof securityResearchRuntimeRecoverySchema>;

const securityScanSuccessSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    ok: z.literal(true),
    operation: z.literal("start"),
    runtimeRecovery: securityResearchRuntimeRecoverySchema.optional(),
    result: securityScanStatusSchema,
  }),
  z.strictObject({
    ok: z.literal(true),
    operation: z.literal("status"),
    runtimeRecovery: securityResearchRuntimeRecoverySchema.optional(),
    result: securityScanStatusSchema,
  }),
  z.strictObject({
    ok: z.literal(true),
    operation: z.literal("cancel"),
    runtimeRecovery: securityResearchRuntimeRecoverySchema.optional(),
    result: securityScanStatusSchema,
  }),
  z.strictObject({
    ok: z.literal(true),
    operation: z.literal("results"),
    runtimeRecovery: securityResearchRuntimeRecoverySchema.optional(),
    result: securityScanResultEnvelopeSchema,
  }),
  z.strictObject({
    ok: z.literal(true),
    operation: z.literal("record"),
    runtimeRecovery: securityResearchRuntimeRecoverySchema.optional(),
    result: securityScanRecordAcknowledgementSchema,
  }),
]);

export const securityScanToolResultSchema = z.union([
  securityScanSuccessSchema,
  z.strictObject({
    ok: z.literal(false),
    operation: z.enum(["start", "status", "results", "record", "cancel"]),
    runtimeRecovery: securityResearchRuntimeRecoverySchema.optional(),
    error: securityScanErrorSchema,
  }),
]);
export type SecurityScanToolResult = z.infer<typeof securityScanToolResultSchema>;

function compareById<T extends { readonly id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id);
}

function markdownText(value: string): string {
  const htmlSafe = value.replace(/[&<>]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
  })[character]!);
  return htmlSafe.replace(/[\\`*_[\]{}()!|]/g, "\\$&");
}

/** Canonical, bounded JSON suitable for deterministic tool-result storage. */
export function securityScanResultEnvelopeToJson(value: SecurityScanResultEnvelope): string {
  const envelope = securityScanResultEnvelopeSchema.parse(value);
  return JSON.stringify({
    version: envelope.version,
    status: {
      version: envelope.status.version,
      scanId: envelope.status.scanId,
      state: envelope.status.state,
      phase: envelope.status.phase,
      terminalState: envelope.status.terminalState,
      mode: envelope.status.mode,
      modelId: envelope.status.modelId,
      modelState: envelope.status.modelState,
      completedSteps: envelope.status.completedSteps,
      totalSteps: envelope.status.totalSteps,
      lanes: [...envelope.status.lanes].sort((a, b) => a.probe.localeCompare(b.probe)),
      coverage: [...envelope.status.coverage].sort((a, b) => a.surfaceKey.localeCompare(b.surfaceKey)),
      hypotheses: [...envelope.status.hypotheses].sort(compareById),
    },
    observations: [...envelope.observations].sort(compareById),
    codeEvidence: [...envelope.codeEvidence].sort(compareById),
    records: [...envelope.records].sort(compareById),
    nextCursor: envelope.nextCursor,
  });
}

/** A deterministic human projection that never includes raw scanner output or source excerpts. */
export function securityScanResultEnvelopeToMarkdown(value: SecurityScanResultEnvelope): string {
  const envelope = securityScanResultEnvelopeSchema.parse(value);
  const lanes = [...envelope.status.lanes].sort((a, b) => a.probe.localeCompare(b.probe));
  const coverage = [...envelope.status.coverage].sort((a, b) => a.surfaceKey.localeCompare(b.surfaceKey));
  const observations = [...envelope.observations].sort(compareById);
  const codeEvidence = [...envelope.codeEvidence].sort(compareById);
  const records = [...envelope.records].sort(compareById);
  const lines = [
    "# Security scan",
    "",
    `- Scan: ${envelope.status.scanId}`,
    `- State: ${envelope.status.state}`,
    `- Phase: ${envelope.status.phase ?? "terminal"}`,
    `- Mode: ${envelope.status.mode}`,
    `- Model: ${envelope.status.modelId ?? "scanners only"}`,
    `- Progress: ${envelope.status.completedSteps}/${envelope.status.totalSteps}`,
    "",
    "## Probe lanes",
    "",
    ...lanes.map((lane) => `- ${lane.probe}: ${lane.state}; ${lane.observationCount} observations; coverage ${lane.coverage}`),
    "",
    "## Coverage",
    "",
    ...(coverage.length === 0
      ? ["- No repository surfaces recorded yet."]
      : coverage.map((surface) => `- ${surface.surfaceKey}: ${surface.state} — ${markdownText(surface.rationale)}`)),
    "",
    "## Observations",
    "",
    ...(observations.length === 0
      ? ["- No scanner observations in this page."]
      : observations.map((observation) => `- ${observation.id}: ${observation.probe}/${observation.severity}/${observation.sourceScope} — ${markdownText(observation.summary)}`)),
    "",
    "## Code evidence",
    "",
    ...(codeEvidence.length === 0
      ? ["- No revalidated code evidence in this page."]
      : codeEvidence.map((evidence) => `- ${evidence.id}: ${markdownText(evidence.relativePath)}:${evidence.startLine}-${evidence.endLine}`)),
    "",
    "## Research records",
    "",
    ...(records.length === 0
      ? ["- No research records in this page."]
      : records.map((record) => `- ${record.id}: ${record.entry.kind}`)),
  ];
  return lines.join("\n");
}
