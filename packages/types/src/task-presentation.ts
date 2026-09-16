import type { TaskPreparationProgress } from "./realtime";
/**
 * D547 — runtime-free presentation semantics shared by every Task work surface.
 *
 * This is deliberately a small projection contract rather than UI state: the
 * canonical Task API remains the source of ownership and lifecycle truth.
 * Consumers may retain realtime detail locally, but must use these rules when
 * choosing status, order, hierarchy, lifecycle copy, and terminal timing.
 */

/** The only lifecycle states a delegated-work surface presents. */
export type TaskPresentationStatus =
  | "running"
  | "paused"
  | "awaiting"
  | "done"
  | "errored";

/** Canonical Task hierarchy as supplied by the owner-scoped Task API. */
export interface TaskPresentationHierarchy {
  readonly parentTaskId: string | null;
  readonly depth: number;
}

/** Minimal stable fields needed to order any delegated-work row. */
export interface TaskPresentationItem extends TaskPresentationHierarchy {
  readonly taskId: string;
  readonly status: TaskPresentationStatus;
  /** Stable Task/run start time. Callers supply a known value; this module never reads the clock. */
  readonly startedAtMs: number;
  /** A live terminal receipt time, or null when the row is not lingering. */
  readonly terminalAtMs: number | null;
}

/** Task API lifecycle normalization. Pending and unknown rows have no live work presentation. */
export function normalizeTaskPresentationStatus(taskStatus: string): TaskPresentationStatus | null {
  switch (taskStatus) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "awaiting":
      return "awaiting";
    case "completed":
    case "cancelled":
      return "done";
    case "errored":
      return "errored";
    case "pending":
    default:
      return null;
  }
}

/** Lower values receive attention first in every work surface. */
export const TASK_PRESENTATION_STATUS_PRIORITY: Record<TaskPresentationStatus, number> = {
  awaiting: 0,
  errored: 1,
  running: 2,
  paused: 3,
  done: 4,
};

export function isTerminalTaskPresentationStatus(status: TaskPresentationStatus): boolean {
  return status === "done" || status === "errored";
}

/** Stable, total ordering; activity/progress is intentionally not an input. */
export function compareTaskPresentationItems(
  a: TaskPresentationItem,
  b: TaskPresentationItem,
): number {
  const priority =
    TASK_PRESENTATION_STATUS_PRIORITY[a.status] -
    TASK_PRESENTATION_STATUS_PRIORITY[b.status];
  if (priority !== 0) return priority;
  if (a.startedAtMs !== b.startedAtMs) return a.startedAtMs - b.startedAtMs;
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

export function sortTaskPresentationItems<T extends TaskPresentationItem>(
  items: readonly T[],
): T[] {
  return [...items].sort(compareTaskPresentationItems);
}

/** Fixed lifecycle copy used when no exact `task.progress.detail` is known. */
export function taskPresentationLifecycleText(status: TaskPresentationStatus): string {
  switch (status) {
    case "running":
      return "Working…";
    case "paused":
      return "Paused";
    case "awaiting":
      return "Needs attention";
    case "done":
      return "Done";
    case "errored":
      return "Failed";
  }
}

/**
 * Exact progress always wins byte-for-byte. There is no transcript, count, or
 * generated-summary fallback: reconnect and unknown activity use lifecycle
 * copy above until a new exact progress event arrives.
 */
export function taskPresentationActivityText(
  status: TaskPresentationStatus,
  progress: string | null | undefined,
): string {
  return progress ?? taskPresentationLifecycleText(status);
}

/** Linger terminal rows briefly before their canonical bounded Done history takes over. */
export const TASK_PRESENTATION_TERMINAL_LINGER_MS = 5000;

/**
 * Parse a server-authored timestamp without ever reading `Date.now()`. Invalid
 * or absent timestamps sort deterministically after server-dated siblings.
 */
export function parseTaskPresentationTimestamp(value: string | null | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

const RESEARCH_ACTIVITIES: Record<NonNullable<TaskPreparationProgress["activity"]>, string> = {
  recovering_context: "Recovering audit context",
  reading_source: "Reading source code", searching_source: "Searching source code",
  mapping_repository: "Mapping repository scope", loading_research: "Loading saved research",
  saving_research: "Saving research notes", checkpoint_saved: "Research checkpoint saved",
  review_saved: "Review notes saved", hypothesis_saved: "Hypothesis assessment saved",
  evidence_saved: "Source evidence saved", finding_saved: "Finding recorded for the report",
  coverage_saved: "Coverage assessment saved", validating_report: "Validating report completeness",
};

/** Strict metadata projection; only the explicit accepted assignment subject
 * may contain model-authored text, never arbitrary tool/source payloads. */
export function readTaskPreparation(value: unknown): (TaskPreparationProgress & { taskRunId: string; updatedAt: string }) | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item["taskRunId"] !== "string" || typeof item["updatedAt"] !== "string"
    || !Number.isFinite(Date.parse(item["updatedAt"]))) return null;
  const stage = item["stage"];
  if (!["preparing_model", "waiting_model", "model_responding", "using_tools", "preparing_scanners", "scanner_started", "scanner_finished", "recording_evidence", "research_ready", "inventory_progress"].includes(String(stage))) return null;
  const probe = item["probe"];
  if (stage === "scanner_started" || stage === "scanner_finished") {
    if (!["gitleaks", "osv_scanner", "trivy", "semgrep"].includes(String(probe))) return null;
  } else if (probe !== undefined) return null;
  const filesObserved = item["filesObserved"];
  const directoriesObserved = item["directoriesObserved"];
  if (stage === "inventory_progress") {
    if (!Number.isSafeInteger(filesObserved) || (filesObserved as number) < 0
      || !Number.isSafeInteger(directoriesObserved) || (directoriesObserved as number) < 0) return null;
  } else if (filesObserved !== undefined || directoriesObserved !== undefined) return null;
  const activity = item["activity"];
  if (activity !== undefined && (typeof activity !== "string"
    || !Object.hasOwn(RESEARCH_ACTIVITIES, activity))) return null;
  const rawResearch = item["research"];
  let research: TaskPreparationProgress["research"];
  if (rawResearch !== undefined) {
    if (!rawResearch || typeof rawResearch !== "object" || Array.isArray(rawResearch)) return null;
    const counts = rawResearch as Record<string, unknown>;
    const keys = ["unitsTotal", "unitsCompleted", "unitsPending", "filesTotal", "filesAssigned"] as const;
    if (keys.some((key) => !Number.isSafeInteger(counts[key]) || (counts[key] as number) < 0)) return null;
    research = { unitsTotal: counts["unitsTotal"] as number,
      unitsCompleted: counts["unitsCompleted"] as number, unitsPending: counts["unitsPending"] as number,
      filesTotal: counts["filesTotal"] as number, filesAssigned: counts["filesAssigned"] as number };
    if (research.unitsCompleted + research.unitsPending !== research.unitsTotal
      || research.filesAssigned > research.filesTotal) return null;
  }
  const rawRecovery = item["contextRecovery"];
  let contextRecovery: TaskPreparationProgress["contextRecovery"];
  if (rawRecovery !== undefined) {
    if (!rawRecovery || typeof rawRecovery !== "object" || Array.isArray(rawRecovery)) return null;
    const pendingInputs = (rawRecovery as Record<string, unknown>)["pendingInputs"];
    if (!Number.isSafeInteger(pendingInputs) || (pendingInputs as number) < 0) return null;
    const facts = rawRecovery as Record<string, unknown>;
    const phase = facts["phase"];
    if (phase !== undefined && phase !== "inactive" && phase !== "reading" && phase !== "consolidation_required") return null;
    const recoveredInputBytes = facts["recoveredInputBytes"];
    const retainedUnconsolidatedPages = facts["retainedUnconsolidatedPages"];
    if ([recoveredInputBytes, retainedUnconsolidatedPages].some((value) => value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0))) return null;
    if ((phase === "reading" && pendingInputs === 0) || phase === "inactive" && pendingInputs !== 0) return null;
    contextRecovery = { pendingInputs: pendingInputs as number,
      ...(phase !== undefined ? { phase } : {}),
      ...(recoveredInputBytes !== undefined ? { recoveredInputBytes: recoveredInputBytes as number } : {}),
      ...(retainedUnconsolidatedPages !== undefined ? { retainedUnconsolidatedPages: retainedUnconsolidatedPages as number } : {}),
    };
  }
  const rawPage = item["contextPage"];
  let contextPage: TaskPreparationProgress["contextPage"];
  if (rawPage !== undefined) {
    if (activity !== "recovering_context" || !rawPage || typeof rawPage !== "object" || Array.isArray(rawPage)) return null;
    const page = rawPage as Record<string, unknown>;
    if (["startByte", "endByte", "totalBytes"].some((key) => !Number.isSafeInteger(page[key]) || (page[key] as number) < 0)) return null;
    contextPage = { startByte: page["startByte"] as number, endByte: page["endByte"] as number, totalBytes: page["totalBytes"] as number };
    if (contextPage.startByte >= contextPage.endByte || contextPage.endByte > contextPage.totalBytes) return null;
  }
  const rawWork = item["researchWork"];
  let researchWork: TaskPreparationProgress["researchWork"];
  if (rawWork !== undefined) {
    if (!rawWork || typeof rawWork !== "object" || Array.isArray(rawWork)) return null;
    const work = rawWork as Record<string, unknown>;
    const role = work["role"], subject = work["subject"], reviewDecision = work["reviewDecision"];
    if (role !== "coordinator" && role !== "investigator" && role !== "reviewer") return null;
    if (subject !== undefined && (typeof subject !== "string" || !subject.trim())) return null;
    if (reviewDecision !== undefined && (role !== "coordinator" || reviewDecision !== "accepted" && reviewDecision !== "follow_up")) return null;
    researchWork = { role, ...(typeof subject === "string" ? { subject } : {}),
      ...(reviewDecision === "accepted" || reviewDecision === "follow_up" ? { reviewDecision } : {}) };
  }
  return { stage: stage as TaskPreparationProgress["stage"],
    ...(researchWork ? { researchWork } : {}),
    ...(contextRecovery ? { contextRecovery } : {}), ...(contextPage ? { contextPage } : {}),
    ...(stage === "inventory_progress" ? { filesObserved: filesObserved as number,
      directoriesObserved: directoriesObserved as number } : {}),
    ...(activity !== undefined ? { activity: activity as NonNullable<TaskPreparationProgress["activity"]> } : {}),
    ...(research ? { research } : {}),
    ...(probe !== undefined ? { probe: probe as NonNullable<TaskPreparationProgress["probe"]> } : {}),
    taskRunId: item["taskRunId"], updatedAt: item["updatedAt"] };
}

export function taskPreparationText(progress: TaskPreparationProgress): string {
  const activity = progress.activity ? RESEARCH_ACTIVITIES[progress.activity] : null;
  const research = progress.research;
  const work = progress.researchWork;
  const role = work?.role === "investigator" ? "Investigating" : work?.role === "reviewer" ? "Reviewing" : work ? "Coordinating audit" : null;
  if (activity || research || progress.contextRecovery || work) {
    const parts = [role, work?.subject ? `Model-assigned focus: ${work.subject}` : null,
      work?.reviewDecision === "accepted" ? "Reviewer accepted the result; model judgment" : work?.reviewDecision === "follow_up" ? "Reviewer requested follow-up" : null, activity,
      progress.contextRecovery ? progress.contextRecovery.phase === "inactive"
        ? "No runtime context recovery pending"
        : progress.contextRecovery.phase === "consolidation_required"
          ? `Runtime recovery: saving checkpoint; ${progress.contextRecovery.pendingInputs} historical inputs remain`
        : progress.contextRecovery.pendingInputs > 0
          ? `Runtime recovery: ${progress.contextRecovery.pendingInputs} historical inputs await recovery`
          : "Runtime recovery: historical input recovered; saving checkpoint before continuing" : null,
      progress.contextPage ? `Historical bytes ${progress.contextPage.startByte}–${progress.contextPage.endByte} of ${progress.contextPage.totalBytes}` : null,
      research ? `${research.unitsTotal > 0
        ? `${research.unitsCompleted}/${research.unitsTotal} review units complete; ${research.unitsPending} pending`
        : "Review plan pending"}; ${research.filesAssigned}/${research.filesTotal} files assigned` : null,
      progress.stage === "waiting_model" ? "Waiting for model" : null,
      progress.stage === "model_responding" ? "Model response in progress" : null];
    return parts.filter(Boolean).join(" · ");
  }
  switch (progress.stage) {
    case "inventory_progress": return `Mapping repository: ${progress.filesObserved} files found across ${progress.directoriesObserved} directories; discovery in progress`;
    case "preparing_model": return "Preparing task context and model";
    case "waiting_model": return "Waiting for the model response";
    case "model_responding": return "The model is responding";
    case "using_tools": return "Running a task tool";
    case "preparing_scanners": return "Preparing security scanners: verifying cached tools or downloading signed tools";
    case "scanner_started": return `Running ${progress.probe}`;
    case "scanner_finished": return `${progress.probe} finished; collecting the remaining scanner results`;
    case "recording_evidence": return "Saving scanner observations to the research ledger";
    case "research_ready": return "Scanner leads ready; starting model-led code investigation";
  }
}

/** Durable paused-task copy, shared by runtime and reconnect projections. */
export const TASK_DESKTOP_WAIT_TEXT = "Waiting for Desktop. Research saved; the audit resumes when its authorized Desktop reconnects.";

export const TASK_PROVIDER_WAIT_TEXT =
  "Model request timed out after retries. Research saved; Resume continues the same audit with the selected model.";
