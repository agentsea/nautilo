import { and, asc, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";

import type { DirectDatabase } from "../config/direct-database";
import { jobs, type Job } from "../schema/jobs";
import { protectedTaskExecutionSegmentReceipts } from
  "../schema/protected-task-execution-segment-receipts";
import { protectedTaskRunOutputBindings } from "../schema/protected-task-run-output-bindings";
import { taskRuns, type TaskRun } from "../schema/task-runs";
import { tasks, type Task } from "../schema/tasks";
import { taskDefinitionCryptoRevisions } from "../schema/task-definition-crypto-revisions";
import { exactDefinitionFamily } from "./protected-task-running-recovery";
import { readProtectedTaskExecutionContinuationProof } from
  "./protected-task-execution-receipts";
import { protectedTaskRunResultObjectId } from "./protected-task-output-binding-identities";
import {
  PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY,
  TASK_LOCAL_EXECUTION_RECREATE_TEXT,
} from "./tasks";

export type ProtectedTaskCheckpointPauseRequest = Readonly<{
  taskId: string;
  pauseRequestId: string;
  reason: "manual_pause" | "time_limit";
  requestedAt: Date;
  requesterUserId: string;
  agentId: string;
}>;
export type ProtectedTaskCheckpointPauseRun = Readonly<{
  taskRunId: string;
  jobId: string | null;
  graphThreadId: string;
  status: "running" | "awaiting";
}>;
export type RequestProtectedTaskCheckpointPauseResult =
  | Readonly<{
      status: "requested" | "exact_replay";
      request: ProtectedTaskCheckpointPauseRequest;
      runs: readonly ProtectedTaskCheckpointPauseRun[];
    }>
  | Readonly<{ status: "inactive" | "conflict" }>;

export type ProtectedTaskCheckpointPauseRecoveryCursor = Readonly<{
  taskId: string;
}>;
export type ProtectedTaskCheckpointPauseRecoveryCandidate = Readonly<{
  taskId: string;
  pauseRequestId: string;
}>;
export type ProtectedTaskCheckpointPauseRecoveryPage = Readonly<{
  candidates: readonly ProtectedTaskCheckpointPauseRecoveryCandidate[];
  next: ProtectedTaskCheckpointPauseRecoveryCursor | null;
}>;

type Tx = Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];
type PauseTask = Pick<Task, "id" | "requestorId" | "agentId" | "status" | "contentNamespaceId"
  | "scheduleKind" | "contentRepresentation" | "pauseRequestId" | "pauseRequestedAt" | "pauseReason">
  & Readonly<{
    localExecutionDelegationIsNull: boolean;
    lastErrorIsLocalRecapture: boolean;
    fundingOutcomeUncertain: boolean;
  }>;
type PauseRun = Pick<TaskRun, "id" | "jobId" | "graphThreadId" | "status" | "completedAt"
  | "modelId" | "fundingBinding" | "fundingPredecessorRunId" | "resultRepresentation"
  | "resultRevision" | "resultContentNamespaceId" | "resultCryptoObjectId"
  | "resultCryptoAccessRevision" | "resultCryptoRequiredNamespaceFingerprint" | "resultCryptoMappingState">
  & Readonly<{ resultTextIsNull: boolean; lastErrorIsNull: boolean }>;
type PauseJob = Pick<Job, "id" | "ownerId" | "requestorId" | "laneKey" | "type"
  | "status" | "input" | "metadata" | "startedAt" | "completedAt">
  & Readonly<{ resultIsNull: boolean; messageIsNull: boolean }>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function protectedTask(task: PauseTask | undefined): task is PauseTask {
  return task !== undefined && (task.contentRepresentation === "protected"
    || task.contentRepresentation === "dual");
}
function active(task: PauseTask): boolean {
  return ["pending", "running", "awaiting", "paused"].includes(task.status);
}
function validRequest(task: PauseTask, requestId: string): boolean {
  return task.pauseRequestId === requestId && task.pauseRequestedAt !== null
    && task.pauseReason !== null;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function pristine(run: PauseRun): boolean {
  return run.completedAt === null && run.resultTextIsNull && run.lastErrorIsNull
    && run.resultRepresentation === "ordinary" && run.resultRevision === 0
    && run.resultContentNamespaceId === null && run.resultCryptoObjectId === null
    && run.resultCryptoAccessRevision === 0
    && run.resultCryptoRequiredNamespaceFingerprint === null
    && run.resultCryptoMappingState === "unmapped";
}
async function lockTask(tx: Tx, taskId: string): Promise<PauseTask | undefined> {
  return (await tx.select({ id: tasks.id, requestorId: tasks.requestorId, agentId: tasks.agentId,
    status: tasks.status, scheduleKind: tasks.scheduleKind, contentRepresentation: tasks.contentRepresentation,
    contentNamespaceId: tasks.contentNamespaceId,
    pauseRequestId: tasks.pauseRequestId, pauseRequestedAt: tasks.pauseRequestedAt, pauseReason: tasks.pauseReason,
    localExecutionDelegationIsNull: isNull(tasks.localExecutionDelegation).mapWith(Boolean),
    lastErrorIsLocalRecapture: and(isNotNull(tasks.lastError),
      eq(tasks.lastError, TASK_LOCAL_EXECUTION_RECREATE_TEXT))!.mapWith(Boolean),
    fundingOutcomeUncertain: and(isNotNull(tasks.lastError),
      eq(tasks.lastError, "funding_interrupted_uncertain"))!.mapWith(Boolean),
  }).from(tasks).where(eq(tasks.id, taskId))
    .limit(1).for("update"))[0];
}
async function lockRuns(tx: Tx, taskId: string): Promise<PauseRun[]> {
  return tx.select({ id: taskRuns.id, jobId: taskRuns.jobId, graphThreadId: taskRuns.graphThreadId,
    status: taskRuns.status, completedAt: taskRuns.completedAt, modelId: taskRuns.modelId,
    fundingBinding: taskRuns.fundingBinding, fundingPredecessorRunId: taskRuns.fundingPredecessorRunId,
    resultRepresentation: taskRuns.resultRepresentation, resultRevision: taskRuns.resultRevision,
    resultContentNamespaceId: taskRuns.resultContentNamespaceId, resultCryptoObjectId: taskRuns.resultCryptoObjectId,
    resultCryptoAccessRevision: taskRuns.resultCryptoAccessRevision,
    resultCryptoRequiredNamespaceFingerprint: taskRuns.resultCryptoRequiredNamespaceFingerprint,
    resultCryptoMappingState: taskRuns.resultCryptoMappingState,
    resultTextIsNull: isNull(taskRuns.resultText).mapWith(Boolean),
    lastErrorIsNull: isNull(taskRuns.lastError).mapWith(Boolean),
  }).from(taskRuns).where(eq(taskRuns.taskId, taskId))
    .orderBy(asc(taskRuns.startedAt), asc(taskRuns.id)).for("update");
}

/** List only stable operational coordinates for unfinished pause intents. */
export async function listProtectedTaskCheckpointPauseRecoveryCandidates(
  db: DirectDatabase,
  input: Readonly<{
    limit: number;
    after?: ProtectedTaskCheckpointPauseRecoveryCursor;
  }>,
): Promise<ProtectedTaskCheckpointPauseRecoveryPage> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1
    || input.after !== undefined && !uuid.test(input.after.taskId)) {
    throw new TypeError("Protected Task checkpoint pause recovery page is invalid");
  }
  const rows = await db.select({
    taskId: tasks.id,
    pauseRequestId: tasks.pauseRequestId,
  }).from(tasks).where(and(
    or(eq(tasks.contentRepresentation, "dual"), eq(tasks.contentRepresentation, "protected")),
    inArray(tasks.status, ["pending", "running", "awaiting"]),
    isNotNull(tasks.pauseRequestId),
    input.after === undefined ? undefined : gt(tasks.id, input.after.taskId),
  )).orderBy(asc(tasks.id)).limit(input.limit);
  const candidates = rows.flatMap(row => row.pauseRequestId === null ? [] : [Object.freeze({
    taskId: row.taskId,
    pauseRequestId: row.pauseRequestId,
  })]);
  const last = candidates.at(-1);
  return Object.freeze({
    candidates: Object.freeze(candidates),
    next: rows.length < input.limit || last === undefined
      ? null
      : Object.freeze({ taskId: last.taskId }),
  });
}

/** Persist the cooperative request; it is not a claim that running effects stopped. */
export async function requestProtectedTaskCheckpointPause(
  db: DirectDatabase,
  input: Readonly<{
    taskId: string; requesterUserId: string; pauseRequestId: string;
    reason: "manual_pause" | "time_limit"; requestedAt: Date;
  }>,
): Promise<RequestProtectedTaskCheckpointPauseResult> {
  if (!uuid.test(input.taskId) || !uuid.test(input.pauseRequestId)
    || !uuid.test(input.requesterUserId)
    || !["manual_pause", "time_limit"].includes(input.reason)
    || !(input.requestedAt instanceof Date) || !Number.isFinite(input.requestedAt.getTime())) {
    throw new TypeError("Protected Task pause request is malformed");
  }
  const requestedAt = new Date(input.requestedAt.getTime());
  return db.transaction(async tx => {
    const task = await lockTask(tx, input.taskId);
    if (!protectedTask(task) || task.requestorId !== input.requesterUserId
      || !active(task)) return { status: "inactive" };
    const replay = task.pauseRequestId != null;
    if (replay && (!validRequest(task, input.pauseRequestId)
      || task.pauseReason !== input.reason
      || task.pauseRequestedAt!.getTime() !== requestedAt.getTime())) {
      return { status: "conflict" };
    }
    const runs = await lockRuns(tx, task.id);
    if (!replay) await tx.update(tasks).set({
      pauseRequestId: input.pauseRequestId, pauseRequestedAt: requestedAt,
      pauseReason: input.reason, fireLockId: null, fireLockedAt: null,
      updatedAt: requestedAt,
    }).where(eq(tasks.id, task.id)).returning({ id: tasks.id });
    return {
      status: replay ? "exact_replay" : "requested",
      request: Object.freeze({ taskId: task.id, pauseRequestId: input.pauseRequestId,
        reason: input.reason, requestedAt: new Date(requestedAt.getTime()),
        requesterUserId: task.requestorId, agentId: task.agentId }),
      runs: Object.freeze(runs.filter(run => run.status === "running" || run.status === "awaiting")
        .map(run => Object.freeze({ taskRunId: run.id, jobId: run.jobId,
          graphThreadId: run.graphThreadId, status: run.status as "running" | "awaiting" }))),
    };
  });
}

/** Accept only the existing park owner and immutable physical receipt, never Job absence. */
async function safelyParked(tx: Tx, task: PauseTask, run: PauseRun, job: PauseJob): Promise<boolean> {
  const receipt = object(job.metadata) ? job.metadata[PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY] : null;
  const reference = job.input;
  if (!object(receipt) || !object(reference) || job.status !== "completed"
    || job.ownerId !== task.requestorId || job.requestorId !== task.requestorId
    || job.laneKey !== `task:${task.id}` || job.type !== "foreground"
    || !job.resultIsNull || !job.messageIsNull || job.startedAt === null
    || job.completedAt === null || reference["kind"] !== "protected_task_run_v1"
    || reference["taskId"] !== task.id || reference["taskRunId"] !== run.id
    || typeof reference["inputObjectId"] !== "string"
    || !/^(?:task-definition|task-historical):v1:[0-9a-f]{64}$/u.test(reference["inputObjectId"])
    || reference["resultObjectId"] !== protectedTaskRunResultObjectId(task.id, run.id)
    || typeof reference["authorizationRequestId"] !== "string"
    || !Number.isSafeInteger(reference["policyRevision"]) || (reference["policyRevision"] as number) < 1
    || typeof receipt["stableRoutingDigest"] !== "string"
    || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(receipt["stableRoutingDigest"])
    || receipt["version"] !== 1 || receipt["taskId"] !== task.id
    || receipt["taskRunId"] !== run.id || receipt["jobId"] !== job.id
    || receipt["graphThreadId"] !== run.graphThreadId
    || receipt["parkedAt"] !== job.completedAt.toISOString()
    || !Number.isSafeInteger(receipt["generation"]) || (receipt["generation"] as number) < 0
    || !Number.isSafeInteger(receipt["executionSegment"])
    || (receipt["executionSegment"] as number) < 1
    || reference["executionSegment"] !== receipt["executionSegment"]
    || !Array.isArray(receipt["interrupts"])) return false;
  if (reference["inputObjectId"].startsWith("task-historical:")) {
    if (task.contentNamespaceId === null) return false;
    // This proves retained input identity for a lifecycle control only.
    // Execution still obtains fresh grant and mapped-content authority.
    const [definition] = await tx.select({
      cryptoObjectId: taskDefinitionCryptoRevisions.cryptoObjectId,
      contentRevision: taskDefinitionCryptoRevisions.contentRevision,
      representation: taskDefinitionCryptoRevisions.representation,
      historicalRepair: taskDefinitionCryptoRevisions.historicalRepair,
      requiredNamespaceFingerprint: taskDefinitionCryptoRevisions.requiredNamespaceFingerprint,
    }).from(taskDefinitionCryptoRevisions).where(and(
      eq(taskDefinitionCryptoRevisions.taskId, task.id),
      eq(taskDefinitionCryptoRevisions.cryptoObjectId, reference["inputObjectId"]),
      eq(taskDefinitionCryptoRevisions.contentNamespaceId, task.contentNamespaceId),
      eq(taskDefinitionCryptoRevisions.anchorNamespaceId, task.contentNamespaceId),
      eq(taskDefinitionCryptoRevisions.payloadVersion, 1),
      eq(taskDefinitionCryptoRevisions.completion, "complete"),
      eq(taskDefinitionCryptoRevisions.disposition, "mapped"),
      isNull(taskDefinitionCryptoRevisions.failureCode),
    )).limit(1).for("share");
    if (!definition || !exactDefinitionFamily(definition)
      || definition.requiredNamespaceFingerprint.length !== 32) return false;
  }
  const executionSegment = receipt["executionSegment"] as number;
  const [segment] = await tx.select().from(protectedTaskExecutionSegmentReceipts).where(and(
    eq(protectedTaskExecutionSegmentReceipts.taskRunId, run.id),
    eq(protectedTaskExecutionSegmentReceipts.jobId, job.id),
    eq(protectedTaskExecutionSegmentReceipts.executionSegment, executionSegment),
  )).limit(1);
  if (!segment || segment.route !== "native_langgraph_v1"
    || segment.checkpointContract !== "encrypted_langgraph_v1"
    || segment.expectedCheckpointCount < 1
    || segment.sealedAt.getTime() !== job.completedAt.getTime()) return false;
  const interrupts: unknown[] = receipt["interrupts"];
  if (interrupts.length > 0 && interrupts.every(interrupt => object(interrupt)
    && typeof interrupt["id"] === "string" && interrupt["id"].length > 0
    && ["approval", "prove_it", "identity", "await_reply"].includes(interrupt["kind"] as string))) {
    return true;
  }
  const proof = await readProtectedTaskExecutionContinuationProof(tx, {
    taskId: task.id, taskRunId: run.id, jobId: job.id, executionSegment,
  });
  if (!proof || proof.continuation.sealedAt.getTime() !== job.completedAt.getTime()) return false;
  if (interrupts.length === 0) return proof.continuation.kind === "checkpoint_safe_v1"
    && proof.continuation.effectDisposition === "none_v1"
    && typeof receipt["stableRoutingDigest"] === "string"
    && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(receipt["stableRoutingDigest"]);
  return proof.continuation.kind === "pre_effect_interrupt_v1"
    && proof.continuation.effectDisposition === "not_started_v1"
    && interrupts.some(interrupt => object(interrupt)
      && interrupt["kind"] === "additional_authority"
      && interrupt["id"] === proof.continuation.interruptId);
}
async function allRunsSafe(tx: Tx, task: PauseTask, runs: readonly PauseRun[]): Promise<boolean> {
  // Lock all linked Jobs in one stable order, after all Runs have been locked.
  const jobIds = [...new Set(runs.flatMap(run => run.jobId === null ? [] : [run.jobId]))].sort();
  const lockedJobs = jobIds.length === 0 ? [] : await tx.select({ id: jobs.id,
    ownerId: jobs.ownerId, requestorId: jobs.requestorId, laneKey: jobs.laneKey,
    type: jobs.type, status: jobs.status, input: jobs.input, metadata: jobs.metadata,
    startedAt: jobs.startedAt, completedAt: jobs.completedAt,
    resultIsNull: isNull(jobs.result).mapWith(Boolean),
    messageIsNull: isNull(jobs.message).mapWith(Boolean),
  }).from(jobs)
    .where(inArray(jobs.id, jobIds)).orderBy(asc(jobs.id)).for("update");
  const byId = new Map(lockedJobs.map(job => [job.id, job]));
  for (const run of runs) {
    if (["completed", "errored", "cancelled"].includes(run.status)) continue;
    if (run.status !== "awaiting" || !pristine(run)) return false;
    if (run.jobId === null) {
      if (run.modelId !== null || run.fundingBinding !== null
        || run.fundingPredecessorRunId !== null) return false;
      // Job deletion nulls the FK; retained segment evidence must never be
      // mistaken for an occurrence that has not begun execution.
      const [priorSegment] = await tx.select({ taskRunId: protectedTaskExecutionSegmentReceipts.taskRunId })
        .from(protectedTaskExecutionSegmentReceipts)
        .where(eq(protectedTaskExecutionSegmentReceipts.taskRunId, run.id)).limit(1);
      if (priorSegment) return false;
      const [acceptedBinding] = await tx.select({ taskRunId: protectedTaskRunOutputBindings.taskRunId })
        .from(protectedTaskRunOutputBindings)
        .where(eq(protectedTaskRunOutputBindings.taskRunId, run.id)).limit(1);
      if (acceptedBinding) return false;
      continue;
    }
    const job = byId.get(run.jobId);
    if (!job || !await safelyParked(tx, task, run, job)) return false;
  }
  return true;
}

export async function finalizeProtectedTaskCheckpointPause(
  db: DirectDatabase,
  input: Readonly<{ taskId: string; pauseRequestId: string }>,
): Promise<"paused" | "exact_replay" | "pending" | "inactive"> {
  return db.transaction(async tx => {
    const task = await lockTask(tx, input.taskId);
    if (!protectedTask(task) || !active(task) || !validRequest(task, input.pauseRequestId)) return "inactive";
    const runs = await lockRuns(tx, task.id);
    if (!await allRunsSafe(tx, task, runs)) return "pending";
    if (task.status === "paused") return "exact_replay";
    await tx.update(tasks).set({ status: "paused", fireLockId: null, fireLockedAt: null })
      .where(eq(tasks.id, task.id)).returning({ id: tasks.id });
    return "paused";
  });
}

export async function resumeProtectedTaskCheckpointPause(
  db: DirectDatabase,
  input: Readonly<{ taskId: string; requesterUserId: string; pauseRequestId: string }>,
): Promise<"resumed" | "pending" | "inactive" | "recapture_required" | "funding_uncertain"> {
  return db.transaction(async tx => {
    const task = await lockTask(tx, input.taskId);
    if (!protectedTask(task) || task.requestorId !== input.requesterUserId
      || !active(task) || !validRequest(task, input.pauseRequestId)) return "inactive";
    if (task.status !== "paused") return "pending";
    const runs = await lockRuns(tx, task.id);
    if (task.localExecutionDelegationIsNull && task.lastErrorIsLocalRecapture) {
      return "recapture_required";
    }
    if (task.fundingOutcomeUncertain
      && (runs.at(-1)?.status === "paused" || task.scheduleKind !== "cron")) {
      return "funding_uncertain";
    }
    if (!await allRunsSafe(tx, task, runs)) return "pending";
    const latest = runs.at(-1);
    const status = task.scheduleKind === "cron" || latest === undefined ? "pending"
      : runs.some(run => run.status === "awaiting") ? "awaiting"
      : latest.status === "completed" ? "completed"
      : latest.status === "cancelled" ? "cancelled" : "errored";
    await tx.update(tasks).set({ status, pauseRequestId: null, pauseRequestedAt: null,
      pauseReason: null, fireLockId: null, fireLockedAt: null })
      .where(eq(tasks.id, task.id)).returning({ id: tasks.id });
    return "resumed";
  });
}
