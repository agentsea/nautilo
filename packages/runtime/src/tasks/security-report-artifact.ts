import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  createWorkspaceBinaryArtifact,
  exportFinalizedSecurityResearch,
  type CreateWorkspaceBinaryArtifactResult,
} from "@nautilo/agent";
import { and, eq, tasks, taskRuns, type DirectDatabase } from "@nautilo/db";
import { eventBus } from "../event-bus";
import type { ServerEvent } from "@nautilo/types";
import { SecurityReportDeliveryPendingError } from "./security-report-recovery";

export const SECURITY_REPORT_MIME_TYPE = "text/markdown";

type SecurityReportArtifactWriter = typeof createWorkspaceBinaryArtifact;
let writerOverrideForTests: SecurityReportArtifactWriter | null = null;
let exporterOverrideForTests: typeof exportFinalizedSecurityResearch | null = null;

export function _setSecurityReportExporterForTests(exporter: typeof exportFinalizedSecurityResearch | null): void {
  exporterOverrideForTests = exporter;
}

export async function assertSecurityReportTaskActive(db: DirectDatabase, taskId: string, taskRunId: string, ownerId: string): Promise<void> {
  const [active] = await db.select({ id: taskRuns.id }).from(taskRuns).innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(and(eq(taskRuns.id, taskRunId), eq(tasks.id, taskId), eq(tasks.ownerId, ownerId),
      eq(tasks.status, "running"), eq(taskRuns.status, "running"))).limit(1);
  if (!active) throw new Error("SECURITY_RESEARCH_EXPORT_TASK_NOT_ACTIVE");
}

export function _setSecurityReportArtifactWriterForTests(
  writer: SecurityReportArtifactWriter | null,
): void {
  writerOverrideForTests = writer;
}

function safePathSegment(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "unknown";
}

export function isSecurityResearchTask(input: Record<string, unknown>): boolean {
  return Array.isArray(input["toolWhitelist"])
    && input["toolWhitelist"].includes("security_scan");
}

export function securityReportLogicalPath(taskId: string, taskRunId: string): string {
  return `artifacts/security-reports/security-scan-${safePathSegment(taskId)}-${safePathSegment(taskRunId)}.md`;
}

export function buildSecurityReportMarkdown(input: {
  taskId: string;
  taskRunId: string;
  modelId: string;
  generatedAt: string;
  report: string;
  researchAppendix?: string | null | undefined;
  reportState: "completed" | "partial";
}): string {
  return [
    input.reportState === "partial" ? "# Partial codebase security scan report" : "# Codebase security scan report",
    "",
    `- Task: \`${input.taskId}\``,
    `- Run: \`${input.taskRunId}\``,
    `- Model: \`${input.modelId || "not recorded"}\``,
    `- Generated: ${input.generatedAt}`,
    "",
    input.reportState === "partial" ? "**The finalized ledger is partial. Repository research coverage and scanner coverage are separate: inspect the recorded source gaps, probe failures and external assumptions below. Execution completion and full ledger retrieval do not establish a comprehensive audit.**\n\n## Report and limitations" : "## Research report",
    "",
    input.report,
    ...(input.researchAppendix ? ["", input.researchAppendix] : []),
    "",
  ].join("\n");
}

export interface CreatedSecurityReportArtifact {
  artifactId: string;
  artifactInternalId: string;
  displayPath: string;
  markdown: string;
}

/**
 * Materialize the Task's complete model-authored report in the canonical
 * Workspace artifact store before the Task is allowed to complete.
 */
export async function createSecurityReportArtifact(
  input: {
    envelope: MemoryAccessEnvelope;
    taskId: string;
    taskRunId: string;
    modelId: string;
    report: string;
    researchAppendix?: string | null | undefined;
    reportState: "completed" | "partial";
    generatedAt?: Date;
  },
  writer?: SecurityReportArtifactWriter,
): Promise<CreatedSecurityReportArtifact> {
  if (input.reportState !== "completed" && input.reportState !== "partial") {
    throw new Error("SECURITY_RESEARCH_INCOMPLETE: No verified research report. No artifact was created.");
  }
  const markdown = buildSecurityReportMarkdown({
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    modelId: input.modelId,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    report: input.report,
    researchAppendix: input.researchAppendix,
    reportState: input.reportState,
  });
  const logicalPath = securityReportLogicalPath(input.taskId, input.taskRunId);
  const saved: CreateWorkspaceBinaryArtifactResult = await (
    writer ?? writerOverrideForTests ?? createWorkspaceBinaryArtifact
  )({
    envelope: input.envelope,
    // Internal Task finalization is not an interactive Artifact addition.
    actor: null,
    logicalPath,
    bytes: Buffer.from(markdown, "utf8"),
    mimeType: SECURITY_REPORT_MIME_TYPE,
    // Task finalization may be retried after a delivery failure. The run-scoped
    // path makes distinct runs immutable while keeping same-run finalization
    // idempotent.
    overwrite: true,
  });
  if (!saved.ok) {
    throw new Error(`SECURITY_REPORT_ARTIFACT_FAILED:${saved.code}:${saved.message}`);
  }
  return {
    artifactId: saved.artifactId,
    artifactInternalId: saved.artifactInternalId,
    displayPath: saved.displayPath,
    markdown,
  };
}

export function securityReportDeliveryText(
  displayPath: string,
  report: string,
  reportState: "completed" | "partial" = "completed",
): string {
  return [
    `${reportState === "partial" ? "Partial" : "Research"} Markdown report: \`${displayPath}\``,
    "",
    report.trim(),
  ].join("\n");
}

/** Shared by uninterrupted and approval-resumed research completion. */
export async function finalizeSecurityReportDelivery(input: {
  taskId: string;
  taskRunId: string;
  modelId: string;
  report: string;
  researchAppendix?: string | null | undefined;
  reportState: "completed" | "partial" | null | undefined;
  envelope: MemoryAccessEnvelope | null | undefined;
  threadId?: string;
  continuation?: Parameters<typeof exportFinalizedSecurityResearch>[0]["continuation"];
  userId?: string;
  signal?: AbortSignal;
  assertActive?: () => Promise<void>;
}): Promise<string> {
  const cancellation = new AbortController();
  const onStatus = (event: ServerEvent) => {
    if (event.type === "task.status" && event.taskId === input.taskId && event.ownerId === input.userId
      && (event.status === "cancelled" || event.status === "paused")) cancellation.abort();
  };
  const signal = input.signal ? AbortSignal.any([input.signal, cancellation.signal]) : cancellation.signal;
  eventBus.on(onStatus);
  try {
    signal.throwIfAborted();
    if (!input.envelope) throw new Error("SECURITY_RESEARCH_EXPORT_AUTHORITY_UNAVAILABLE");
    let researchAppendix = input.researchAppendix;
    let reportState = input.reportState;
    let report = input.report;
    if (input.threadId !== undefined) {
      if (!input.userId) throw new Error("SECURITY_RESEARCH_EXPORT_AUTHORITY_UNAVAILABLE");
      const exported = await (exporterOverrideForTests ?? exportFinalizedSecurityResearch)({
        threadId: input.threadId, taskId: input.taskId, taskRunId: input.taskRunId,
        userId: input.userId, modelId: input.modelId, signal,
        ...(input.continuation ? { continuation: input.continuation } : {}),
        ...(input.assertActive ? { assertActive: input.assertActive } : {}),
      });
      researchAppendix = exported.researchAppendix;
      reportState = exported.reportState;
      report = exported.reviewedReportDraft ?? report;
    }
    if (!reportState || !researchAppendix?.trim()) {
      throw new Error("SECURITY_RESEARCH_INCOMPLETE: No verified, finalized and fully paged research evidence. No security report was created.");
    }
    signal.throwIfAborted();
    await input.assertActive?.();
    const artifact = await createSecurityReportArtifact({ ...input, report, researchAppendix, reportState, envelope: input.envelope });
    signal.throwIfAborted();
    await input.assertActive?.();
    return securityReportDeliveryText(artifact.displayPath, report, reportState);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const rejected = message.startsWith("SECURITY_RESEARCH_EXPORT_REJECTED:")
      && !["relay_unavailable", "internal", "artifact_corrupt", "artifact_too_large", "invalid_request"].includes(message.slice("SECURITY_RESEARCH_EXPORT_REJECTED:".length));
    const authorityFailure = ["SECURITY_RESEARCH_EXPORT_AUTHORITY_UNAVAILABLE", "SECURITY_RESEARCH_EXPORT_HOST_REVOKED",
      "SECURITY_RESEARCH_EXPORT_SCOPE_MISMATCH", "SECURITY_RESEARCH_EXPORT_NOT_SEALED", "SECURITY_RESEARCH_EXPORT_TASK_NOT_ACTIVE"].includes(message);
    // Only completed model work with sealed evidence can become delivery-only
    // retry. Cancellation, revoked authority and research/provider failures keep
    // their normal lifecycle; this never manufactures a resumable investigation.
    if (input.threadId && input.reportState && input.report.trim() && input.envelope
      && !signal.aborted && !rejected && !authorityFailure && !message.startsWith("SECURITY_REPORT_REVIEW_")) {
      throw new SecurityReportDeliveryPendingError(error);
    }
    throw error;
  } finally {
    eventBus.off(onStatus);
  }
}
