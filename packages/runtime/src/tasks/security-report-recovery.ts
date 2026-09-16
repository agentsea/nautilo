import { TASK_DESKTOP_WAIT_TEXT, TASK_PROVIDER_WAIT_TEXT } from "@nautilo/types";
import { and, asc, desc, eq, gt, tasks, taskRuns, type DirectDatabase, type Task, type TaskRun } from "@nautilo/db";
import { assertSecurityResearchContextFailureRecovery, assertSecurityResearchResumeBinding, createCheckpointSaver, getRelayRegistry, RelayUnavailableError, isSafelyRetryableProviderTimeout, toNoProgressOutcomeFromError, inspectTaskResumeOutcome, type RunScopeSubagentResult } from "@nautilo/agent";
import { restoreTaskReturnBindingFromCheckpoint } from "./task-return-binding";
import { eventBus } from "../event-bus";

/** Server-only TaskRun marker; never read from model prose or task metadata. */
export const SECURITY_REPORT_DELIVERY_PENDING = "SECURITY_REPORT_DELIVERY_PENDING";
const SECURITY_REPORT_DELIVERY_PAUSED_TEXT = "Investigation saved; Resume retries report delivery.";

export class SecurityReportDeliveryPendingError extends Error {
  constructor(cause: unknown) {
    super(SECURITY_REPORT_DELIVERY_PAUSED_TEXT, { cause });
    this.name = "SecurityReportDeliveryPendingError";
  }
}

export function isSecurityReportDeliveryRetry(run: TaskRun | undefined): boolean {
  return run?.status === "paused" && run.lastError === SECURITY_REPORT_DELIVERY_PENDING;
}

/** Attach an accepted security Job without reviving a Task/run paused or stopped while queued. */
export async function attachSecurityResearchJob(db: DirectDatabase, input: {
  taskId: string; taskRunId: string; ownerId: string; jobId: string;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1).for("update");
    if (!task || task.ownerId !== input.ownerId || task.status !== "running") return false;
    const [run] = await tx.select().from(taskRuns).where(and(eq(taskRuns.id, input.taskRunId), eq(taskRuns.taskId, task.id))).limit(1).for("update");
    if (run?.status !== "running") return false;
    await tx.update(taskRuns).set({ jobId: input.jobId }).where(eq(taskRuns.id, run.id));
    return true;
  });
}

/** Preserve the paused checkpoint when its exact Desktop grant cannot yet be restored. */
export async function pauseSecurityResearchResume(db: DirectDatabase, input: {
  taskId: string; taskRunId: string; ownerId: string; fireLockId: string | null; reason: string;
}): Promise<void> {
  const paused = await db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1).for("update");
    if (!task || task.ownerId !== input.ownerId || task.status !== "pending" || task.fireLockId !== input.fireLockId) return false;
    const [run] = await tx.select().from(taskRuns).where(and(eq(taskRuns.id, input.taskRunId), eq(taskRuns.taskId, task.id))).limit(1).for("update");
    if (run?.status !== "paused") return false;
    await tx.update(tasks).set({ status: "paused", fireLockId: null, fireLockedAt: null, updatedAt: new Date(),
      lastError: `Investigation saved. Reconnect the same Desktop and authorized folder, then Resume (${input.reason}).` }).where(eq(tasks.id, task.id));
    return true;
  });
  if (paused) eventBus.emit({ type: "task.status", taskId: input.taskId, ownerId: input.ownerId, status: "paused" });
}

/** Same Task-row lock order as ordinary lifecycle writers; Stop/Pause always wins if already committed. */
export async function parkSecurityReportDelivery(db: DirectDatabase, input: { taskId: string; taskRunId: string; ownerId: string }): Promise<boolean> {
  const parked = await db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1).for("update");
    if (!task || task.ownerId !== input.ownerId || task.status !== "running") return false;
    const [run] = await tx.select().from(taskRuns).where(and(eq(taskRuns.id, input.taskRunId), eq(taskRuns.taskId, task.id))).limit(1).for("update");
    if (run?.status !== "running") return false;
    await tx.update(taskRuns).set({ status: "paused", lastError: SECURITY_REPORT_DELIVERY_PENDING }).where(eq(taskRuns.id, run.id));
    await tx.update(tasks).set({ status: "paused", lastError: SECURITY_REPORT_DELIVERY_PAUSED_TEXT,
      fireLockId: null, fireLockedAt: null, updatedAt: new Date() }).where(eq(tasks.id, task.id));
    return true;
  });
  if (parked) {
    eventBus.emit({ type: "task.status", taskId: input.taskId, ownerId: input.ownerId, status: "paused" });
    eventBus.emit({ type: "task.progress", taskId: input.taskId, taskRunId: input.taskRunId, ownerId: input.ownerId, detail: SECURITY_REPORT_DELIVERY_PAUSED_TEXT });
  }
  return parked;
}

/** Native research resumes keep their checkpoint's TaskRun/model binding after dispatch revalidates it. */
export async function resumeSecurityResearchRun(db: DirectDatabase, input: {
  taskId: string; taskRunId: string; ownerId: string; threadId: string; modelId: string; deliveryOnly: boolean;
}): Promise<TaskRun | undefined> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1).for("update");
    if (!task || task.ownerId !== input.ownerId || !["pending", "running"].includes(task.status)) return undefined;
    const [run] = await tx.select().from(taskRuns).where(and(eq(taskRuns.id, input.taskRunId), eq(taskRuns.taskId, task.id))).limit(1).for("update");
    if (!run || run.status !== "paused" || run.graphThreadId !== input.threadId || run.modelId !== input.modelId
      || input.deliveryOnly && !isSecurityReportDeliveryRetry(run)) return undefined;
    const [resumed] = await tx.update(taskRuns).set({ status: "running", ...(input.deliveryOnly ? {} : { lastError: null }) }).where(eq(taskRuns.id, run.id)).returning();
    await tx.update(tasks).set({ status: "running", lastError: null, updatedAt: new Date() }).where(eq(tasks.id, task.id));
    return resumed;
  });
}

/** Verify the server marker again at execution; a job flag alone never bypasses model work. */
export async function readSecurityReportDeliveryResult(db: DirectDatabase, input: {
  taskId: string; taskRunId: string; ownerId: string; threadId: string; modelId: string;
}): Promise<Extract<RunScopeSubagentResult, { status: "completed" }>> {
  const [run] = await db.select({ id: taskRuns.id }).from(taskRuns).innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(and(eq(tasks.id, input.taskId), eq(tasks.ownerId, input.ownerId), eq(tasks.status, "running"),
      eq(taskRuns.id, input.taskRunId), eq(taskRuns.status, "running"), eq(taskRuns.lastError, SECURITY_REPORT_DELIVERY_PENDING),
      eq(taskRuns.graphThreadId, input.threadId), eq(taskRuns.modelId, input.modelId))).limit(1);
  if (!run) throw new Error("SECURITY_REPORT_DELIVERY_RETRY_NOT_AUTHORIZED");
  const outcome = await inspectTaskResumeOutcome(input.threadId, `task:${input.taskId}`);
  if (outcome.reparked || !outcome.securityResearch?.reportState || !outcome.finalText.trim()
    || outcome.finalText === "(task completed with no text)") throw new Error("SECURITY_REPORT_DELIVERY_CHECKPOINT_INCOMPLETE");
  return { status: "completed", threadId: input.threadId, finalText: outcome.finalText, finalResponseText: outcome.finalText,
    securityReportState: outcome.securityResearch.reportState, securityResearchAppendix: outcome.securityResearch.researchAppendix ?? null };
}


function isErroredResearchContextCandidate(task: Task): boolean {
  return task.status === "errored" && task.lastError === "no_progress" && task.toolsMode === "whitelist"
    && task.toolsWhitelist?.includes("security_scan") === true;
}

async function readRecoverableContextFailure(db: DirectDatabase, task: Task): Promise<TaskRun | undefined> {
  if (!isErroredResearchContextCandidate(task)) return undefined;
  const [run] = await db.select().from(taskRuns).where(eq(taskRuns.taskId, task.id)).orderBy(desc(taskRuns.startedAt)).limit(1);
  if (run?.status !== "errored" || run.lastError !== "no_progress" || !run.modelId
    || task.requestedModelId && task.requestedModelId !== run.modelId) return undefined;
  try {
    await assertSecurityResearchContextFailureRecovery({ taskId: task.id, taskRunId: run.id, userId: task.ownerId,
      threadId: run.graphThreadId, modelId: run.modelId });
    return run;
  } catch { return undefined; } // Missing/foreign checkpoints never advertise or admit recovery.
}

/** Owner projections only. This affordance is not mutation authority. */
export async function canResumeSecurityResearchContextFailure(db: DirectDatabase, task: Task): Promise<boolean> {
  return Boolean(await readRecoverableContextFailure(db, task));
}

/** Explicit unpause only: re-arm the exact saved Run after a local context failure. */
export async function recoverSecurityResearchContextFailure(db: DirectDatabase, task: Task): Promise<boolean> {
  const eligible = await readRecoverableContextFailure(db, task);
  if (!eligible) return false;
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(tasks).where(eq(tasks.id, task.id)).limit(1).for("update");
    if (!current || current.ownerId !== task.ownerId || !isErroredResearchContextCandidate(current)
      || current.requestedModelId !== task.requestedModelId) return false;
    const [run] = await tx.select().from(taskRuns).where(eq(taskRuns.taskId, task.id))
      .orderBy(desc(taskRuns.startedAt)).limit(1).for("update");
    if (!run || run.id !== eligible.id || run.status !== "errored" || run.lastError !== "no_progress"
      || run.graphThreadId !== eligible.graphThreadId || run.modelId !== eligible.modelId) return false;
    await tx.update(taskRuns).set({ status: "paused", completedAt: null }).where(eq(taskRuns.id, run.id));
    await tx.update(tasks).set({ status: "pending", nextFireAt: new Date(), fireLockId: null, fireLockedAt: null,
      updatedAt: new Date() }).where(eq(tasks.id, task.id));
    return true;
  });
}

/** Durable lifecycle reason, separate from model loop detection or report delivery. */
export const SECURITY_RESEARCH_DESKTOP_WAIT = "SECURITY_RESEARCH_DESKTOP_WAIT";
export const SECURITY_RESEARCH_PROVIDER_WAIT = "SECURITY_RESEARCH_PROVIDER_WAIT";
const DESKTOP_WAIT_TEXT = TASK_DESKTOP_WAIT_TEXT;

export async function parkSecurityResearchInterruption(db: DirectDatabase, input: {
  taskId: string; taskRunId: string; ownerId: string; error: unknown;
}): Promise<boolean> {
  const timeout = isSafelyRetryableProviderTimeout(input.error) ? input.error : undefined;
  const desktopCause = input.error instanceof RelayUnavailableError ? input.error.researchInterruption : undefined;
  if (!timeout && !desktopCause) return false;
  const cause = timeout ? timeout.details.kind : desktopCause!;
  const marker = timeout ? SECURITY_RESEARCH_PROVIDER_WAIT : SECURITY_RESEARCH_DESKTOP_WAIT;
  const detail = timeout ? TASK_PROVIDER_WAIT_TEXT : DESKTOP_WAIT_TEXT;
  const observedAt = new Date();
  const parked = await db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1).for("update");
    if (!task || task.ownerId !== input.ownerId || task.status !== "running"
      || task.toolsMode !== "whitelist" || !task.toolsWhitelist?.includes("security_scan")) return false;
    const [run] = await tx.select().from(taskRuns).where(and(eq(taskRuns.id, input.taskRunId), eq(taskRuns.taskId, task.id))).limit(1).for("update");
    if (run?.status !== "running") return false;
    const checkpoint = await createCheckpointSaver().getTuple({ configurable: { thread_id: run.graphThreadId } });
    if (timeout && (run.modelId !== timeout.modelId || !checkpoint?.config.configurable?.["checkpoint_id"])) return false;
    await tx.update(taskRuns).set({ status: "paused", lastError: marker }).where(eq(taskRuns.id, run.id));
    await tx.update(tasks).set({ status: "paused", lastError: detail,
      metadata: { ...task.metadata, lastInterruption: { code: timeout ? timeout.code : "relay_unavailable", cause,
        stoppedBy: "task_runtime", outcome: "paused", observedAt: observedAt.toISOString(),
        taskRunId: run.id, graphThreadId: run.graphThreadId,
        checkpointId: typeof checkpoint?.config.configurable?.["checkpoint_id"] === "string"
          ? String(checkpoint.config.configurable["checkpoint_id"]) : null,
        resumable: true, ...(timeout ? { modelId: timeout.modelId, attemptId: timeout.details.attemptId,
          timeoutMs: timeout.timeoutMs, elapsedMs: timeout.details.elapsedMs, abortRequested: true,
          visibleOutput: false, partialState: timeout.details.partialState, safeToFallback: true }
          : { desktopExitCause: "unknown" }) } },
      fireLockId: null, fireLockedAt: null, updatedAt: observedAt }).where(eq(tasks.id, task.id));
    return true;
  });
  if (parked) {
    eventBus.emit({ type: "task.status", taskId: input.taskId, ownerId: input.ownerId, status: "paused" });
    eventBus.emit({ type: "task.progress", taskId: input.taskId, taskRunId: input.taskRunId, ownerId: input.ownerId, detail });
  }
  return parked;
}

/** Reuse the ordinary observer/dispatch path; no retry timer or model call while offline. */
export async function resumeReconnectedSecurityResearch(db: DirectDatabase, batch: number): Promise<void> {
  let afterId: string | undefined;
  for (;;) {
    const candidates = await db.select({ task: tasks, run: taskRuns }).from(tasks)
      .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
      .where(and(eq(tasks.status, "paused"), eq(tasks.lastError, DESKTOP_WAIT_TEXT), eq(taskRuns.status, "paused"), eq(taskRuns.lastError, SECURITY_RESEARCH_DESKTOP_WAIT),
        afterId ? gt(tasks.id, afterId) : undefined))
      .orderBy(asc(tasks.id)).limit(batch);
    if (candidates.length === 0) return;
    afterId = candidates.at(-1)!.task.id;
    for (const { task, run } of candidates) {
      if (!run.modelId || task.toolsMode !== "whitelist" || !task.toolsWhitelist?.includes("security_scan")) continue;
      try {
        const checkpointState = await assertSecurityResearchResumeBinding({ taskId: task.id, taskRunId: run.id,
          userId: task.ownerId, threadId: run.graphThreadId, modelId: run.modelId });
        const binding = restoreTaskReturnBindingFromCheckpoint({ taskId: task.id, taskRunId: run.id,
          ownerId: task.ownerId, graphThreadId: run.graphThreadId, taskCreatedAt: task.createdAt, checkpointState },
          getRelayRegistry() as Parameters<typeof restoreTaskReturnBindingFromCheckpoint>[1]);
        if (binding.status !== "available") continue;
        await db.transaction(async (tx) => {
          const [current] = await tx.select().from(tasks).where(eq(tasks.id, task.id)).limit(1).for("update");
          if (current?.status !== "paused" || current.lastError !== DESKTOP_WAIT_TEXT) return;
          const [savedRun] = await tx.select().from(taskRuns).where(eq(taskRuns.id, run.id)).limit(1).for("update");
          if (savedRun?.status !== "paused" || savedRun.lastError !== SECURITY_RESEARCH_DESKTOP_WAIT) return;
          await tx.update(tasks).set({ status: "pending", nextFireAt: new Date(),
            fireLockId: null, fireLockedAt: null, updatedAt: new Date() }).where(eq(tasks.id, task.id));
        });
      } catch {
        // Checkpoint/authorization unavailable: retain the durable pause. Ordinary Resume remains available.
      }
    }
  }
}

/** An explicit Human pause disables automatic reconnect without discarding the saved failure. */
export async function holdSecurityResearchDesktop(db: DirectDatabase, taskId: string): Promise<void> {
  await db.update(tasks).set({ lastError: "Paused by you. Research saved; Resume continues the audit.", updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "paused"), eq(tasks.lastError, DESKTOP_WAIT_TEXT)));
}

/** Keep a termination's mechanism and checkpoint even after a later successful recovery. */
export async function recordSecurityResearchFailure(db: DirectDatabase, input: {
  taskId: string; taskRunId: string; ownerId: string; error: unknown;
}): Promise<void> {
  const outcome = toNoProgressOutcomeFromError(input.error);
  if (!outcome) return;
  await db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1).for("update");
    if (!task || task.ownerId !== input.ownerId || task.status !== "running"
      || task.toolsMode !== "whitelist" || !task.toolsWhitelist?.includes("security_scan")) return;
    const [run] = await tx.select().from(taskRuns).where(and(eq(taskRuns.id, input.taskRunId), eq(taskRuns.taskId, task.id))).limit(1).for("update");
    if (run?.status !== "running") return;
    const checkpoint = await createCheckpointSaver().getTuple({ configurable: { thread_id: run.graphThreadId } });
    await tx.update(tasks).set({ metadata: { ...task.metadata, lastInterruption: {
      code: "no_progress", cause: "repeated_tool_failure", stoppedBy: "no_progress_guard", outcome: "errored",
      observedAt: new Date().toISOString(), toolName: outcome.toolName, operation: outcome.operationDiscriminator,
      taskRunId: run.id, graphThreadId: run.graphThreadId,
      checkpointId: typeof checkpoint?.config.configurable?.["checkpoint_id"] === "string"
          ? String(checkpoint.config.configurable["checkpoint_id"]) : null,
      // The complete tool error is retained in the protected checkpoint, not copied into public metadata.
      resumeRequiresValidation: true,
    } } }).where(eq(tasks.id, task.id));
  });
}
