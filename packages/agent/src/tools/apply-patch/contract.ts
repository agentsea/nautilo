/**
 * D448 Phase 0 — public contract for the top-level `apply_patch` tool.
 *
 * This module is deliberately pure: it validates the model-authored envelope,
 * runtime-provided preflight/output summaries, and normalized
 * result shapes. It does not parse operations or hunks, inspect target bytes,
 * resolve paths, select a zone/relay, spawn a runtime, or mutate files.
 * Those operations are owned by the trusted router and target runtimes.
 */

import { z } from "zod";

/**
 * Strictly model-authored wire input. Current providers use object-shaped tool
 * schemas, so the Codex freeform body is carried in one field rather than
 * exposing a provider-specific raw-input tool. `target` is a model-authored,
 * non-authoritative selector only; routing context is deliberately absent and
 * must be supplied by trusted server/relay code.
 */
export const applyPatchRequestSchema = z.object({
  patch: z
    .string()
    .min(1)
    .describe("A complete Codex apply_patch body bounded by *** Begin Patch and *** End Patch."),
  target: z
    .enum(["workspace", "current"])
    .describe('Optional compatibility selector. Use "current" for Desktop Current Folder work; "workspace" returns unsupported_target.')
    .optional(),
}).strict();
export type ApplyPatchRequest = z.infer<typeof applyPatchRequestSchema>;

const opaqueIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/, "identifier must be an opaque safe token");

function isCanonicalAbsoluteRoot(value: string): boolean {
  if (value.includes("\0") || value === "/" || /^[A-Za-z]:[\\/]?$/.test(value)) return false;
  const posix = value.startsWith("/");
  const windows = /^[A-Za-z]:[\\/]/.test(value);
  if (!posix && !windows) return false;
  if (/[\\/]$/.test(value)) return false;
  const body = windows ? value.slice(3) : value.slice(1);
  const segments = body.split(/[\\/]/);
  return segments.length > 0 && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const absoluteRootSchema = z
  .string()
  .min(2)
  .refine(isCanonicalAbsoluteRoot, "root must be a canonical non-root absolute path");

const trustedContextBase = {
  agentId: opaqueIdSchema,
  turnId: opaqueIdSchema,
};

/**
 * Trusted execution metadata. Workspace execution has no relay; Current Folder
 * and authorized absolute workstation execution require a selected relay.
 * Never merge this object into the model-authored `ApplyPatchRequest`.
 */
export const applyPatchTrustedContextSchema = z.discriminatedUnion("zone", [
  // A Workspace is a logical, UUID/DB-backed artifact namespace. It is never
  // represented by its physical artifact-store directory: the native runtime
  // operates only in an invocation-private staging tree.
  z.object({ zone: z.literal("workspace"), ...trustedContextBase, workspaceId: opaqueIdSchema, relayId: z.null() }).strict(),
  z.object({ zone: z.literal("current"), ...trustedContextBase, root: absoluteRootSchema, relayId: opaqueIdSchema }).strict(),
  z.object({ zone: z.literal("absolute"), ...trustedContextBase, root: absoluteRootSchema, relayId: opaqueIdSchema }).strict(),
]);
export type ApplyPatchTrustedContext = z.infer<typeof applyPatchTrustedContextSchema>;

export const APPLY_PATCH_ERROR_CODES = [
  "invalid_request",
  "parse_error",
  "missing_context",
  "ambiguous_target",
  "unsupported_target",
  "stale_context",
  "human_edit_conflict",
  "reapply_required",
  "unsupported_encoding_or_type",
  "denied_path",
  "runtime_unavailable",
  "runtime_corrupt",
  "cancelled",
  "partial_execution",
] as const;

export type ApplyPatchErrorCode = (typeof APPLY_PATCH_ERROR_CODES)[number];

// The pinned parser/engine owns patch-path semantics. This boundary retains
// only the representation requirement needed to correlate plan and result;
// filesystem containment and policy are enforced by the existing authority
// path (Workspace namespace or the platform sandbox), never here.
const patchPathSchema = z.string().min(1);

/** Public errors are structured and stable; normalization sanitizes their messages. */
export const applyPatchErrorSchema = z
  .object({
    code: z.enum(APPLY_PATCH_ERROR_CODES),
    message: z.string().min(1),
    path: patchPathSchema.optional(),
    retryable: z.boolean(),
  })
  .strict();
export type ApplyPatchError = z.infer<typeof applyPatchErrorSchema>;

function contractError(
  code: ApplyPatchErrorCode,
  message: string,
  retryable = false,
): ApplyPatchError {
  return { code, message, retryable };
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Gross boundary recognition aligned with the pinned parser: the first and
 * last logical lines are trimmed before marker comparison. Empty bodies are
 * allowed here because the pinned extractor/parser owns operation grammar and
 * supplies the authoritative parse error later.
 */
export function hasApplyPatchEnvelope(patch: string): boolean {
  if (containsUnpairedSurrogate(patch)) return false;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length >= 2 && lines[0]?.trim() === "*** Begin Patch" && lines.at(-1)?.trim() === "*** End Patch";
}

export type ApplyPatchValidation =
  | { ok: true; request: ApplyPatchRequest }
  | { ok: false; error: ApplyPatchError };

/** Validate only model input that is knowable before runtime parsing/spawn. */
export function validateApplyPatchRequest(input: unknown): ApplyPatchValidation {
  const parsed = applyPatchRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: contractError("invalid_request", "apply_patch accepts one patch string and an optional target selector.") };
  }
  if (containsUnpairedSurrogate(parsed.data.patch)) {
    return { ok: false, error: contractError("parse_error", "Patch must be valid UTF-8 text.") };
  }
  if (!hasApplyPatchEnvelope(parsed.data.patch)) {
    return {
      ok: false,
      error: contractError("parse_error", "Patch must be bounded by *** Begin Patch / *** End Patch lines."),
    };
  }
  return { ok: true, request: parsed.data };
}

const nonMoveOperationSchema = z.enum(["add", "update", "delete"]);
const operationCountsSchema = z
  .object({
    add: z.number().int().nonnegative(),
    update: z.number().int().nonnegative(),
    move: z.number().int().nonnegative(),
    delete: z.number().int().nonnegative(),
  })
  .strict();

const plannedNonMoveOperationSchema = z
  .object({
    operation: nonMoveOperationSchema,
    path: patchPathSchema,
  })
  .strict();

const plannedMoveOperationSchema = z
  .object({
    operation: z.literal("move"),
    fromPath: patchPathSchema,
    path: patchPathSchema,
  })
  .strict();

export const applyPatchPlannedOperationSchema = z.union([
  plannedNonMoveOperationSchema,
  plannedMoveOperationSchema,
]);
export type ApplyPatchPlannedOperation = z.infer<typeof applyPatchPlannedOperationSchema>;

/** Trusted parser/preflight output; this contract validates it but never derives it from patch text. */
export const applyPatchPreflightSummarySchema = z
  .object({
    operations: z.array(applyPatchPlannedOperationSchema).min(1),
  })
  .strict();
export type ApplyPatchPreflightSummary = z.infer<typeof applyPatchPreflightSummarySchema>;

export function validateApplyPatchPreflight(
  input: unknown,
):
  | { ok: true; summary: ApplyPatchPreflightSummary }
  | { ok: false; error: ApplyPatchError } {
  const parsed = applyPatchPreflightSummarySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: contractError("parse_error", "Invalid apply_patch preflight summary.") };
  }
  return { ok: true, summary: parsed.data };
}

/** Explicit process facts reported by the trusted spawn wrapper, not the child JSON. */
export const applyPatchProcessOutputSchema = z
  .object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().int().min(0).max(255).nullable(),
    signal: z.string().min(1).nullable(),
    cancelled: z.boolean(),
  })
  .strict()
  .superRefine((output, context) => {
    if (output.exitCode !== null && output.signal !== null) {
      context.addIssue({ code: "custom", message: "process cannot have both exitCode and signal" });
    }
    if (
      output.exitCode === null &&
      output.signal === null &&
      !output.cancelled
    ) {
      context.addIssue({ code: "custom", message: "process output requires a terminal fact" });
    }
  });
export type ApplyPatchProcessOutput = z.infer<typeof applyPatchProcessOutputSchema>;

export function validateApplyPatchProcessOutput(
  input: unknown,
):
  | { ok: true; output: ApplyPatchProcessOutput }
  | { ok: false; error: ApplyPatchError } {
  const parsed = applyPatchProcessOutputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: contractError("parse_error", "Invalid apply_patch process output.") };
  }
  if (parsed.data.cancelled) {
    return { ok: false, error: contractError("cancelled", "apply_patch was cancelled.", true) };
  }
  return { ok: true, output: parsed.data };
}

const childAppliedNonMoveSchema = z
  .object({
    operation: nonMoveOperationSchema,
    path: patchPathSchema,
    status: z.literal("applied"),
    bytesTouched: z.number().int().nonnegative().optional(),
  })
  .strict();

const childAppliedMoveSchema = z
  .object({
    operation: z.literal("move"),
    fromPath: patchPathSchema,
    path: patchPathSchema,
    status: z.literal("applied"),
    bytesTouched: z.number().int().nonnegative().optional(),
  })
  .strict();

const childDefiniteRemainderNonMoveSchema = z
  .object({
    operation: nonMoveOperationSchema,
    path: patchPathSchema,
    status: z.enum(["failed", "not_applied"]),
    bytesTouched: z.literal(0).optional(),
    diagnostic: z.string().min(1),
  })
  .strict();

const childDefiniteRemainderMoveSchema = z
  .object({
    operation: z.literal("move"),
    fromPath: patchPathSchema,
    path: patchPathSchema,
    status: z.enum(["failed", "not_applied"]),
    bytesTouched: z.literal(0).optional(),
    diagnostic: z.string().min(1),
  })
  .strict();

const childUnknownNonMoveSchema = z
  .object({
    operation: nonMoveOperationSchema,
    path: patchPathSchema,
    status: z.literal("unknown"),
    bytesTouched: z.null().optional(),
    diagnostic: z.string().min(1),
  })
  .strict();

const childUnknownMoveSchema = z
  .object({
    operation: z.literal("move"),
    fromPath: patchPathSchema,
    path: patchPathSchema,
    status: z.literal("unknown"),
    bytesTouched: z.null().optional(),
    diagnostic: z.string().min(1),
  })
  .strict();

export const applyPatchChildPathResultSchema = z.union([
  childAppliedNonMoveSchema,
  childAppliedMoveSchema,
  childDefiniteRemainderNonMoveSchema,
  childDefiniteRemainderMoveSchema,
  childUnknownNonMoveSchema,
  childUnknownMoveSchema,
]);
export type ApplyPatchChildPathResult = z.infer<typeof applyPatchChildPathResultSchema>;

const childExecutionBaseSchema = z.object({
  operationCounts: operationCountsSchema,
  pathResults: z.array(applyPatchChildPathResultSchema).min(1),
  unifiedDiff: z.string(),
});

/** Untrusted child report: it cannot assert turn, runtime version, or revisions. */
export const applyPatchChildExecutionReportSchema = z
  .union([
    childExecutionBaseSchema
      .extend({ status: z.literal("applied"), partial: z.literal(false) })
      .strict(),
    childExecutionBaseSchema
      .extend({
        status: z.literal("partial"),
        partial: z.literal(true),
        diagnostic: z.string().min(1),
      })
      .strict(),
  ]);
export type ApplyPatchChildExecutionReport = z.infer<typeof applyPatchChildExecutionReportSchema>;

const trustedRevisionSchema = z
  .object({ path: patchPathSchema, revisionId: opaqueIdSchema })
  .strict();

/** Trusted server-owned facts injected only after execution and local revision recording. */
export const applyPatchNormalizationMetadataSchema = z
  .object({
    context: applyPatchTrustedContextSchema,
    /** Invocation-private filesystem root, required only for Workspace redaction. */
    redactionRoot: absoluteRootSchema.optional(),
    runtimeVersion: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+@-]*$/, "runtime version must be a safe token"),
    preflight: applyPatchPreflightSummarySchema,
    revisions: z.array(trustedRevisionSchema),
    rebased: z.literal(true).optional(),
  })
  .strict()
  .superRefine((metadata, context) => {
    if (metadata.context.zone === "workspace" && metadata.redactionRoot === undefined) {
      context.addIssue({ code: "custom", message: "workspace normalization requires its private redaction root" });
    }
    if (metadata.context.zone !== "workspace" && metadata.redactionRoot !== undefined) {
      context.addIssue({ code: "custom", message: "path-rooted normalization must not provide a second root" });
    }
    const paths = metadata.revisions.map((revision) => revision.path);
    const ids = metadata.revisions.map((revision) => revision.revisionId);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: "custom", message: "revision paths must be unique" });
    }
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "revision ids must be unique" });
    }
  });
export type ApplyPatchNormalizationMetadata = z.infer<
  typeof applyPatchNormalizationMetadataSchema
>;

const publicAppliedNonMoveSchema = childAppliedNonMoveSchema
  .extend({ revisionId: opaqueIdSchema })
  .strict();
const publicAppliedMoveSchema = childAppliedMoveSchema
  .extend({ revisionId: opaqueIdSchema })
  .strict();
const publicDefiniteRemainderNonMoveSchema = childDefiniteRemainderNonMoveSchema
  .omit({ diagnostic: true })
  .extend({ revisionId: z.null(), error: applyPatchErrorSchema })
  .strict();
const publicDefiniteRemainderMoveSchema = childDefiniteRemainderMoveSchema
  .omit({ diagnostic: true })
  .extend({ revisionId: z.null(), error: applyPatchErrorSchema })
  .strict();
const publicUnknownNonMoveSchema = childUnknownNonMoveSchema
  .omit({ diagnostic: true })
  .extend({ revisionId: z.null(), error: applyPatchErrorSchema })
  .strict();
const publicUnknownMoveSchema = childUnknownMoveSchema
  .omit({ diagnostic: true })
  .extend({ revisionId: z.null(), error: applyPatchErrorSchema })
  .strict();

export const applyPatchPathResultSchema = z.union([
  publicAppliedNonMoveSchema,
  publicAppliedMoveSchema,
  publicDefiniteRemainderNonMoveSchema,
  publicDefiniteRemainderMoveSchema,
  publicUnknownNonMoveSchema,
  publicUnknownMoveSchema,
]);
export type ApplyPatchPathResult = z.infer<typeof applyPatchPathResultSchema>;

const publicAppliedPathSchema = z.union([
  publicAppliedNonMoveSchema,
  publicAppliedMoveSchema,
]);

type PublicAppliedPath = z.infer<typeof publicAppliedPathSchema>;

function appliedPathFingerprint(pathResult: PublicAppliedPath): string {
  return JSON.stringify({
    operation: pathResult.operation,
    path: pathResult.path,
    ...(pathResult.operation === "move" ? { fromPath: pathResult.fromPath } : {}),
    status: pathResult.status,
    ...(pathResult.bytesTouched === undefined ? {} : { bytesTouched: pathResult.bytesTouched }),
    revisionId: pathResult.revisionId,
  });
}

const normalizedResultBaseSchema = z.object({
  rebased: z.literal(true).optional(),
  operationCounts: operationCountsSchema,
  pathResults: z.array(applyPatchPathResultSchema).min(1),
  changedFiles: z.array(publicAppliedPathSchema),
  revisionIds: z.array(opaqueIdSchema),
  unifiedDiff: z.string(),
  runtimeVersion: z.string().min(1),
  turnId: opaqueIdSchema,
});

/** Model/UI-facing complete and partial result contract. */
export const applyPatchResultSchema = z
  .union([
    normalizedResultBaseSchema
      .extend({ status: z.literal("applied"), partial: z.literal(false) })
      .strict()
      .refine((result) => result.changedFiles.length > 0 && result.revisionIds.length > 0, {
        message: "complete results require applied paths and revisions",
      }),
    normalizedResultBaseSchema
      .extend({
        status: z.literal("partial"),
        partial: z.literal(true),
        error: applyPatchErrorSchema.refine((error) => error.code === "partial_execution", {
          message: "partial results must use partial_execution",
        }),
      })
      .strict(),
  ])
  .superRefine((result, context) => {
    if (new Set(result.revisionIds).size !== result.revisionIds.length) {
      context.addIssue({ code: "custom", message: "public revision ids must be unique" });
    }
    if (!operationCountsMatch(result.operationCounts, result.pathResults)) {
      context.addIssue({ code: "custom", message: "operation counts must match applied path results" });
    }
    const applied = result.pathResults.filter(
      (pathResult): pathResult is PublicAppliedPath => pathResult.status === "applied",
    );
    const changedFilesMatch =
      result.changedFiles.length === applied.length &&
      result.changedFiles.every(
        (changedFile, index) =>
          applied[index] !== undefined &&
          appliedPathFingerprint(changedFile) === appliedPathFingerprint(applied[index]),
      );
    if (!changedFilesMatch) {
      context.addIssue({ code: "custom", message: "changedFiles must exactly match applied path results" });
    }
    const expectedRevisionIds = applied.map((pathResult) => pathResult.revisionId);
    if (
      result.revisionIds.length !== expectedRevisionIds.length ||
      result.revisionIds.some((revisionId, index) => revisionId !== expectedRevisionIds[index])
    ) {
      context.addIssue({ code: "custom", message: "revisionIds must match applied path results in order" });
    }
  });
export type ApplyPatchResult = z.infer<typeof applyPatchResultSchema>;

function operationCountsMatch(
  counts: z.infer<typeof operationCountsSchema>,
  pathResults: ReadonlyArray<{
    operation: "add" | "update" | "move" | "delete";
    status: "applied" | "failed" | "not_applied" | "unknown";
  }>,
): boolean {
  const actual = { add: 0, update: 0, move: 0, delete: 0 };
  for (const pathResult of pathResults) {
    if (pathResult.status === "applied") actual[pathResult.operation] += 1;
  }
  return Object.keys(actual).every(
    (operation) =>
      actual[operation as keyof typeof actual] === counts[operation as keyof typeof counts],
  );
}

function reportMatchesPlan(
  report: ApplyPatchChildExecutionReport,
  preflight: ApplyPatchPreflightSummary,
): boolean {
  if (report.pathResults.length !== preflight.operations.length) return false;
  return report.pathResults.every((result, index) => {
    const planned = preflight.operations[index];
    if (!planned) return false;
    if (result.operation !== planned.operation || result.path !== planned.path) return false;
    if (result.operation === "move" &&
      (planned.operation !== "move" || result.fromPath !== planned.fromPath)) {
      return false;
    }
    return true;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rootVariants(root: string): string[] {
  return [...new Set([root, root.replaceAll("\\", "/"), root.replaceAll("/", "\\")])]
    .filter((variant) => variant.length > 1)
    .sort((left, right) => right.length - left.length);
}

function sanitizePublicText(value: string, root: string): string {
  const insensitive = /^[A-Za-z]:[\\/]/.test(root);
  return rootVariants(root).reduce(
    (sanitized, variant) =>
      sanitized.replace(new RegExp(escapeRegExp(variant), insensitive ? "gi" : "g"), "[authorized-root]"),
    value,
  );
}

function publicTextContainsRoot(value: string, root: string): boolean {
  const insensitive = /^[A-Za-z]:[\\/]/.test(root);
  return rootVariants(root).some((variant) =>
    new RegExp(escapeRegExp(variant), insensitive ? "i" : undefined).test(value),
  );
}

function isContiguousPartial(report: ApplyPatchChildExecutionReport): boolean {
  if (report.status !== "partial") return false;
  const firstRemainder = report.pathResults.findIndex((result) => result.status !== "applied");
  // A partial report can truthfully have no committed prefix at all: every
  // planned operation may be failed, not_applied, or unknown. All-applied
  // partials remain invalid because they have no remainder.
  if (firstRemainder < 0) return false;
  return report.pathResults.slice(firstRemainder).every((result) => result.status !== "applied");
}

/**
 * Normalize untrusted child facts with trusted server metadata. The configured
 * root is redacted from child diagnostics and diffs before any public result is
 * returned; this is a root-reference sanitizer, not a general secret scanner.
 */
export function normalizeApplyPatchResult(
  childInput: unknown,
  metadataInput: unknown,
):
  | { ok: true; result: ApplyPatchResult }
  | { ok: false; error: ApplyPatchError } {
  const child = applyPatchChildExecutionReportSchema.safeParse(childInput);
  if (!child.success) {
    return { ok: false, error: contractError("parse_error", "Invalid apply_patch child report.") };
  }
  const metadata = applyPatchNormalizationMetadataSchema.safeParse(metadataInput);
  if (!metadata.success) {
    return { ok: false, error: contractError("missing_context", "Invalid trusted normalization metadata.") };
  }
  const preflight = validateApplyPatchPreflight(metadata.data.preflight);
  if (!preflight.ok) return preflight;
  if (!reportMatchesPlan(child.data, metadata.data.preflight)) {
    return { ok: false, error: contractError("stale_context", "Child report does not match the trusted preflight plan.") };
  }
  if (!operationCountsMatch(child.data.operationCounts, child.data.pathResults)) {
    return { ok: false, error: contractError("parse_error", "Operation counts do not match applied paths.") };
  }
  if (
    child.data.status === "applied" &&
    child.data.pathResults.some((pathResult) => pathResult.status !== "applied")
  ) {
    return { ok: false, error: contractError("parse_error", "Complete result contains an unapplied path.") };
  }
  if (child.data.status === "partial" && !isContiguousPartial(child.data)) {
    return {
      ok: false,
      error: contractError("parse_error", "Partial result must be an applied prefix followed by a non-applied remainder."),
    };
  }

  const applied = child.data.pathResults.filter((pathResult) => pathResult.status === "applied");

  const revisionByPath = new Map(
    metadata.data.revisions.map((revision) => [revision.path, revision.revisionId]),
  );
  if (
    revisionByPath.size !== applied.length ||
    applied.some((pathResult) => !revisionByPath.has(pathResult.path))
  ) {
    return {
      ok: false,
      error: contractError("missing_context", "Trusted revisions must exactly cover applied paths."),
    };
  }

  const root = metadata.data.context.zone === "workspace"
    ? metadata.data.redactionRoot!
    : metadata.data.context.root;
  const publicPathResults = child.data.pathResults.map((pathResult) => {
    const publicPaths = {
      path: sanitizePublicText(pathResult.path, root),
      ...(pathResult.operation === "move" ? { fromPath: sanitizePublicText(pathResult.fromPath, root) } : {}),
    };
    if (pathResult.status === "applied") {
      return { ...pathResult, ...publicPaths, revisionId: revisionByPath.get(pathResult.path) };
    }
    const { diagnostic, ...rest } = pathResult;
    return {
      ...rest,
      ...publicPaths,
      revisionId: null,
      error: {
        code: "partial_execution" as const,
        message: sanitizePublicText(diagnostic, root),
        retryable: false,
      },
    };
  });
  const unifiedDiff = sanitizePublicText(child.data.unifiedDiff, root);
  const partialError =
    child.data.status === "partial"
      ? {
          code: "partial_execution" as const,
          message: sanitizePublicText(child.data.diagnostic, root),
          retryable: false,
        }
      : undefined;
  const changedFiles = publicPathResults.filter((pathResult) => pathResult.status === "applied");
  const revisionIds = changedFiles.map((pathResult) => pathResult.revisionId);
  const result = {
    status: child.data.status,
    partial: child.data.partial,
    ...(metadata.data.rebased === true ? { rebased: true as const } : {}),
    operationCounts: child.data.operationCounts,
    pathResults: publicPathResults,
    changedFiles,
    revisionIds,
    unifiedDiff,
    runtimeVersion: metadata.data.runtimeVersion,
    turnId: metadata.data.context.turnId,
    ...(partialError ? { error: partialError } : {}),
  };
  const validatedResult = applyPatchResultSchema.safeParse(result);
  if (!validatedResult.success) {
    return { ok: false, error: contractError("parse_error", "Invalid normalized apply_patch result.") };
  }
  const publicMessages = validatedResult.data.pathResults
    .filter((pathResult) => pathResult.status !== "applied")
    .map((pathResult) => pathResult.error.message);
  if (
    validatedResult.data.pathResults.some((pathResult) =>
      publicTextContainsRoot(pathResult.path, root) ||
      (pathResult.operation === "move" && publicTextContainsRoot(pathResult.fromPath, root)),
    ) ||
    publicTextContainsRoot(validatedResult.data.unifiedDiff, root) ||
    publicMessages.some((message) => publicTextContainsRoot(message, root)) ||
    (validatedResult.data.status === "partial" &&
      publicTextContainsRoot(validatedResult.data.error.message, root))
  ) {
    return { ok: false, error: contractError("runtime_corrupt", "Public apply_patch output contains the authorized root.") };
  }
  return { ok: true, result: validatedResult.data };
}
