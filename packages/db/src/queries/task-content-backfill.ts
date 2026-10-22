import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "../config/database";
import {
  taskContentBackfillFailures,
  taskContentBackfillScans,
  type TaskContentBackfillFailure,
  type TaskContentBackfillScan,
} from "../schema/task-content-backfill";
import { taskRuns } from "../schema/task-runs";
import { isProtectedTaskPreset, tasks } from "../schema/tasks";
import { actors } from "../schema/trust";
import { acquireEncryptionConsumptionFence } from
  "../utils/encryption-transition-queries";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TERMINAL_RUN_STATUSES = ["completed", "errored", "cancelled"] as const;
const clearLease = Object.freeze({
  leaseToken: null,
  leaseDeviceId: null,
  leaseExpiresAt: null,
  claim: null,
});

export type TaskContentBackfillDefinitionCandidate = Readonly<{
  kind: "definition";
  taskId: string;
  sourceCreatedAt: Date;
  sourceUpdatedAt: Date;
  sourceRevision: number;
  sourceStatus: string;
}>;

export type TaskContentBackfillResultCandidate = Readonly<{
  kind: "result";
  taskId: string;
  taskRunId: string;
  sourceUpdatedAt: Date;
  sourceStartedAt: Date;
  sourceCompletedAt: Date;
  sourceRevision: number;
  sourceStatus: "completed" | "errored" | "cancelled";
}>;

export type TaskContentBackfillCandidate =
  | TaskContentBackfillDefinitionCandidate
  | TaskContentBackfillResultCandidate;

export type TaskContentBackfillClaim = Readonly<{
  claimId: string;
  humanActorId: string;
  requesterUserId: string;
  deviceId: string;
  policyRevision: number;
  expiresAt: Date;
  candidate: TaskContentBackfillCandidate;
}>;

export type TaskContentBackfillDisposition =
  | "unsupported"
  | "no_content"
  | "integrity"
  | "waiting_parent";

export type TaskContentBackfillDiscovery =
  | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "full_wait" }>
  | Readonly<{ status: "waiting"; resumeAt: Date | null }>
  | Readonly<{ status: "claimed"; claim: TaskContentBackfillClaim }>
  | Readonly<{
      status: "candidate";
      candidate: TaskContentBackfillCandidate;
      policyRevision: number;
      requesterUserId: string;
    }>
  | Readonly<{ status: "more" }>
  | Readonly<{ status: "swept"; resumeAt: Date }>;

export interface TaskContentBackfillProgress {
  readonly eligibleDefinitions: number;
  readonly mappedDefinitions: number;
  readonly eligibleResults: number;
  readonly mappedResults: number;
  readonly claimedRepairing: number;
  readonly waiting: number;
  readonly unsupported: number;
  readonly failed: number;
  readonly noContent: number;
  readonly pending: number;
}

type DefinitionRow = Readonly<{
  taskId: string;
  ownerId: string;
  preset: string;
  depth: number;
  createdAt: Date;
  updatedAt: Date;
  status: string;
  contentRevision: number;
  parentTaskId: string | null;
  failureReason: TaskContentBackfillDisposition | null;
  failureSourceRevision: number | null;
  failureSourceUpdatedAt: Date | null;
  failureSourceStatus: string | null;
  failurePolicyRevision: number | null;
}>;

type ResultRow = Readonly<{
  taskId: string;
  taskRunId: string;
  taskUpdatedAt: Date;
  startedAt: Date;
  completedAt: Date;
  status: "completed" | "errored" | "cancelled";
  resultRevision: number;
  parentRepresentation: "ordinary" | "dual" | "protected";
  parentMappingState: "unmapped" | "verified" | "stale";
  parentStatus: string;
  parentFailureReason: TaskContentBackfillDisposition | null;
  parentFailureRevision: number | null;
  parentFailureUpdatedAt: Date | null;
  parentFailureStatus: string | null;
  parentFailurePolicyRevision: number | null;
  failureReason: TaskContentBackfillDisposition | null;
  failureSourceRevision: number | null;
  failureSourceUpdatedAt: Date | null;
  failureSourceStatus: string | null;
  failureSourceCompletedAt: Date | null;
  failurePolicyRevision: number | null;
}>;

function positiveLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Task content backfill page limit must be positive");
  }
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length
    && keys.every((key, index) => key === sortedExpected[index]);
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left === null ? right === null
    : right !== null && left.getTime() === right.getTime();
}

function exactFailure(
  failure: Pick<TaskContentBackfillFailure,
    "sourceRevision" | "sourceUpdatedAt" | "sourceStatus"
    | "sourceCompletedAt" | "policyRevision">,
  candidate: TaskContentBackfillCandidate,
  policyRevision: number,
): boolean {
  return failure.sourceRevision === candidate.sourceRevision
    && failure.sourceUpdatedAt.getTime() === candidate.sourceUpdatedAt.getTime()
    && failure.sourceStatus === candidate.sourceStatus
    && failure.policyRevision === policyRevision
    && sameDate(
      failure.sourceCompletedAt,
      candidate.kind === "result" ? candidate.sourceCompletedAt : null,
    );
}

function failureFromDefinition(row: DefinitionRow): TaskContentBackfillFailure | null {
  if (row.failureReason === null || row.failureSourceRevision === null
    || row.failureSourceUpdatedAt === null || row.failureSourceStatus === null
    || row.failurePolicyRevision === null) return null;
  return {
    kind: "definition",
    entityId: row.taskId,
    taskId: row.taskId,
    taskRunId: null,
    sourceRevision: row.failureSourceRevision,
    sourceUpdatedAt: row.failureSourceUpdatedAt,
    sourceStatus: row.failureSourceStatus,
    sourceCompletedAt: null,
    policyRevision: row.failurePolicyRevision,
    reason: row.failureReason,
    observedAt: row.failureSourceUpdatedAt,
  };
}

function failureFromResult(row: ResultRow): TaskContentBackfillFailure | null {
  if (row.failureReason === null || row.failureSourceRevision === null
    || row.failureSourceUpdatedAt === null || row.failureSourceStatus === null
    || row.failurePolicyRevision === null) return null;
  return {
    kind: "result",
    entityId: row.taskRunId,
    taskId: row.taskId,
    taskRunId: row.taskRunId,
    sourceRevision: row.failureSourceRevision,
    sourceUpdatedAt: row.failureSourceUpdatedAt,
    sourceStatus: row.failureSourceStatus,
    sourceCompletedAt: row.failureSourceCompletedAt,
    policyRevision: row.failurePolicyRevision,
    reason: row.failureReason,
    observedAt: row.failureSourceUpdatedAt,
  };
}

function definitionCandidate(row: DefinitionRow): TaskContentBackfillDefinitionCandidate {
  return Object.freeze({
    kind: "definition",
    taskId: row.taskId,
    sourceCreatedAt: new Date(row.createdAt),
    sourceUpdatedAt: new Date(row.updatedAt),
    sourceRevision: row.contentRevision,
    sourceStatus: row.status,
  });
}

function resultCandidate(row: ResultRow): TaskContentBackfillResultCandidate {
  return Object.freeze({
    kind: "result",
    taskId: row.taskId,
    taskRunId: row.taskRunId,
    sourceUpdatedAt: new Date(row.taskUpdatedAt),
    sourceStartedAt: new Date(row.startedAt),
    sourceCompletedAt: new Date(row.completedAt),
    sourceRevision: row.resultRevision,
    sourceStatus: row.status,
  });
}

function encodeCandidate(candidate: TaskContentBackfillCandidate): Record<string, unknown> {
  return candidate.kind === "definition" ? {
    kind: candidate.kind,
    taskId: candidate.taskId,
    sourceCreatedAt: candidate.sourceCreatedAt.toISOString(),
    sourceUpdatedAt: candidate.sourceUpdatedAt.toISOString(),
    sourceRevision: candidate.sourceRevision,
    sourceStatus: candidate.sourceStatus,
  } : {
    kind: candidate.kind,
    taskId: candidate.taskId,
    taskRunId: candidate.taskRunId,
    sourceUpdatedAt: candidate.sourceUpdatedAt.toISOString(),
    sourceStartedAt: candidate.sourceStartedAt.toISOString(),
    sourceCompletedAt: candidate.sourceCompletedAt.toISOString(),
    sourceRevision: candidate.sourceRevision,
    sourceStatus: candidate.sourceStatus,
  };
}

function decodeCandidate(value: unknown): TaskContentBackfillCandidate | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row["kind"] !== "definition" && row["kind"] !== "result") return null;
  const expectedKeys = row["kind"] === "definition"
    ? ["kind", "taskId", "sourceCreatedAt", "sourceUpdatedAt", "sourceRevision", "sourceStatus"]
    : ["kind", "taskId", "taskRunId", "sourceUpdatedAt", "sourceStartedAt", "sourceCompletedAt",
        "sourceRevision", "sourceStatus"];
  if (!hasExactKeys(row, expectedKeys)) return null;
  if (typeof row["taskId"] !== "string" || !UUID.test(row["taskId"])
    || typeof row["sourceRevision"] !== "number"
    || !Number.isSafeInteger(row["sourceRevision"]) || row["sourceRevision"] < 0
    || typeof row["sourceStatus"] !== "string"
    || typeof row["sourceUpdatedAt"] !== "string") return null;
  const sourceUpdatedAt = new Date(row["sourceUpdatedAt"]);
  if (!validDate(sourceUpdatedAt)) return null;
  if (row["kind"] === "definition") {
    if (typeof row["sourceCreatedAt"] !== "string") return null;
    const sourceCreatedAt = new Date(row["sourceCreatedAt"]);
    if (!validDate(sourceCreatedAt)) return null;
    return Object.freeze({
      kind: "definition",
      taskId: row["taskId"],
      sourceCreatedAt,
      sourceUpdatedAt,
      sourceRevision: row["sourceRevision"],
      sourceStatus: row["sourceStatus"],
    });
  }
  if (typeof row["taskRunId"] !== "string" || !UUID.test(row["taskRunId"])
    || typeof row["sourceStartedAt"] !== "string"
    || typeof row["sourceCompletedAt"] !== "string"
    || !TERMINAL_RUN_STATUSES.includes(row["sourceStatus"] as typeof TERMINAL_RUN_STATUSES[number])) {
    return null;
  }
  const sourceStartedAt = new Date(row["sourceStartedAt"]);
  const sourceCompletedAt = new Date(row["sourceCompletedAt"]);
  if (!validDate(sourceStartedAt) || !validDate(sourceCompletedAt)) return null;
  return Object.freeze({
    kind: "result",
    taskId: row["taskId"],
    taskRunId: row["taskRunId"],
    sourceUpdatedAt,
    sourceStartedAt,
    sourceCompletedAt,
    sourceRevision: row["sourceRevision"],
    sourceStatus: row["sourceStatus"] as TaskContentBackfillResultCandidate["sourceStatus"],
  });
}

function decodeClaim(scan: TaskContentBackfillScan): TaskContentBackfillClaim | null {
  const value = scan.claim;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value;
  if (!hasExactKeys(row, [
    "claimId", "humanActorId", "requesterUserId", "deviceId", "policyRevision", "expiresAt", "candidate",
  ])) return null;
  const candidate = decodeCandidate(row["candidate"]);
  if (candidate === null || typeof row["claimId"] !== "string" || !UUID.test(row["claimId"])
    || typeof row["humanActorId"] !== "string" || !UUID.test(row["humanActorId"])
    || typeof row["requesterUserId"] !== "string" || !UUID.test(row["requesterUserId"])
    || typeof row["deviceId"] !== "string" || row["deviceId"].length < 1
    || typeof row["policyRevision"] !== "number" || !Number.isSafeInteger(row["policyRevision"])
    || row["policyRevision"] < 1 || typeof row["expiresAt"] !== "string") return null;
  const expiresAt = new Date(row["expiresAt"]);
  if (!validDate(expiresAt)
    || scan.leaseToken === null || row["claimId"] !== scan.leaseToken
    || row["humanActorId"] !== scan.humanActorId
    || scan.leaseDeviceId === null || row["deviceId"] !== scan.leaseDeviceId
    || scan.leaseExpiresAt === null || expiresAt.getTime() !== scan.leaseExpiresAt.getTime()) return null;
  return Object.freeze({
    claimId: row["claimId"],
    humanActorId: row["humanActorId"],
    requesterUserId: row["requesterUserId"],
    deviceId: row["deviceId"],
    policyRevision: row["policyRevision"],
    expiresAt,
    candidate,
  });
}

function encodeClaim(claim: TaskContentBackfillClaim): Record<string, unknown> {
  return {
    claimId: claim.claimId,
    humanActorId: claim.humanActorId,
    requesterUserId: claim.requesterUserId,
    deviceId: claim.deviceId,
    policyRevision: claim.policyRevision,
    expiresAt: claim.expiresAt.toISOString(),
    candidate: encodeCandidate(claim.candidate),
  };
}

function cursorUpdate(candidate: TaskContentBackfillCandidate) {
  return candidate.kind === "definition" ? {
    cursorAt: candidate.sourceCreatedAt,
    cursorTaskId: candidate.taskId,
    cursorTaskRunId: null,
  } : {
    cursorAt: candidate.sourceCompletedAt,
    cursorTaskId: candidate.taskId,
    cursorTaskRunId: candidate.taskRunId,
  };
}

function candidateIsAfterCursor(
  scan: TaskContentBackfillScan,
  candidate: TaskContentBackfillCandidate,
): boolean {
  if (scan.cursorAt === null || scan.cursorTaskId === null) return true;
  if (candidate.kind === "definition") {
    return candidate.sourceCreatedAt.getTime() > scan.cursorAt.getTime()
      || candidate.sourceCreatedAt.getTime() === scan.cursorAt.getTime()
        && candidate.taskId > scan.cursorTaskId;
  }
  return candidate.sourceCompletedAt.getTime() > scan.cursorAt.getTime()
    || candidate.sourceCompletedAt.getTime() === scan.cursorAt.getTime()
      && (candidate.taskId > scan.cursorTaskId
        || candidate.taskId === scan.cursorTaskId
          && candidate.taskRunId > (scan.cursorTaskRunId ?? ""));
}

function candidateIsWithinThrough(
  scan: TaskContentBackfillScan,
  candidate: TaskContentBackfillCandidate,
): boolean {
  if (scan.throughAt === null || scan.throughTaskId === null) return false;
  const at = candidate.kind === "definition"
    ? candidate.sourceCreatedAt : candidate.sourceCompletedAt;
  if (at.getTime() !== scan.throughAt.getTime()) return at.getTime() < scan.throughAt.getTime();
  if (candidate.taskId !== scan.throughTaskId) return candidate.taskId < scan.throughTaskId;
  return candidate.kind === "definition"
    || scan.throughTaskRunId !== null && candidate.taskRunId <= scan.throughTaskRunId;
}

async function requesterUserId(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], humanActorId: string) {
  const rows = await tx.select({ ownerId: actors.ownerId }).from(actors).where(and(
    eq(actors.id, humanActorId), eq(actors.kind, "user"),
  )).limit(2);
  return rows.length === 1 ? rows[0]!.ownerId : null;
}

async function upsertFailure(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  candidate: TaskContentBackfillCandidate,
  policyRevision: number,
  reason: TaskContentBackfillDisposition,
  now: Date,
): Promise<void> {
  const value = {
    kind: candidate.kind,
    entityId: candidate.kind === "definition" ? candidate.taskId : candidate.taskRunId,
    taskId: candidate.taskId,
    taskRunId: candidate.kind === "result" ? candidate.taskRunId : null,
    sourceRevision: candidate.sourceRevision,
    sourceUpdatedAt: candidate.sourceUpdatedAt,
    sourceStatus: candidate.sourceStatus,
    sourceCompletedAt: candidate.kind === "result" ? candidate.sourceCompletedAt : null,
    policyRevision,
    reason,
    observedAt: now,
  } as const;
  await tx.insert(taskContentBackfillFailures).values(value).onConflictDoUpdate({
    target: [taskContentBackfillFailures.kind, taskContentBackfillFailures.entityId],
    set: value,
  });
}

async function setHighWater(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  scan: TaskContentBackfillScan,
  userId: string,
): Promise<TaskContentBackfillScan> {
  if (scan.throughAt !== null) return scan;
  if (scan.phase === "definition") {
    const [last] = await tx.select({
      at: definitionAt,
      taskId: tasks.id,
    }).from(tasks).where(and(
      eq(tasks.requestorId, userId), eq(tasks.contentRepresentation, "ordinary"),
    )).orderBy(desc(definitionAt), desc(tasks.id)).limit(1);
    if (last === undefined) {
      const [next] = await tx.update(taskContentBackfillScans).set({
        phase: "result", cursorAt: null, cursorTaskId: null, cursorTaskRunId: null,
        throughAt: null, throughTaskId: null, throughTaskRunId: null,
      }).where(eq(taskContentBackfillScans.humanActorId, scan.humanActorId)).returning();
      if (next === undefined) throw new Error("Task content backfill phase was lost");
      return setHighWater(tx, next, userId);
    }
    const [next] = await tx.update(taskContentBackfillScans).set({
      throughAt: last.at, throughTaskId: last.taskId, throughTaskRunId: null,
    }).where(eq(taskContentBackfillScans.humanActorId, scan.humanActorId)).returning();
    if (next === undefined) throw new Error("Task content backfill high-water mark was lost");
    return next;
  }
  const [last] = await tx.select({
    at: resultAt,
    taskId: taskRuns.taskId,
    taskRunId: taskRuns.id,
  }).from(taskRuns).innerJoin(tasks, eq(tasks.id, taskRuns.taskId)).where(and(
    eq(tasks.requestorId, userId),
    eq(taskRuns.resultRepresentation, "ordinary"),
    inArray(taskRuns.status, TERMINAL_RUN_STATUSES),
    isNotNull(taskRuns.completedAt),
  )).orderBy(desc(resultAt), desc(taskRuns.taskId), desc(taskRuns.id)).limit(1);
  if (last === undefined || last.at === null) return scan;
  const [next] = await tx.update(taskContentBackfillScans).set({
    throughAt: last.at, throughTaskId: last.taskId, throughTaskRunId: last.taskRunId,
  }).where(eq(taskContentBackfillScans.humanActorId, scan.humanActorId)).returning();
  if (next === undefined) throw new Error("Task content backfill high-water mark was lost");
  return next;
}

// Durable scan cursors are JSON/JavaScript dates. PostgreSQL microseconds must
// share that millisecond ordering, including the entity-ID tie breakers.
const definitionAt = sql<Date>`date_trunc('milliseconds', ${tasks.createdAt})`.mapWith(tasks.createdAt);
const resultAt = sql<Date | null>`date_trunc('milliseconds', ${taskRuns.completedAt})`.mapWith(taskRuns.completedAt);

function afterDefinition(scan: TaskContentBackfillScan) {
  return scan.cursorAt === null || scan.cursorTaskId === null ? undefined : or(
    gt(definitionAt, sql`${scan.cursorAt.toISOString()}::timestamptz`),
    and(eq(definitionAt, sql`${scan.cursorAt.toISOString()}::timestamptz`), gt(tasks.id, scan.cursorTaskId)),
  );
}

function throughDefinition(scan: TaskContentBackfillScan) {
  if (scan.throughAt === null || scan.throughTaskId === null) return isNull(tasks.id);
  return or(
    lt(definitionAt, sql`${scan.throughAt.toISOString()}::timestamptz`),
    and(eq(definitionAt, sql`${scan.throughAt.toISOString()}::timestamptz`), lte(tasks.id, scan.throughTaskId)),
  );
}

function afterResult(scan: TaskContentBackfillScan) {
  if (scan.cursorAt === null || scan.cursorTaskId === null || scan.cursorTaskRunId === null) return undefined;
  return or(
    gt(resultAt, sql`${scan.cursorAt.toISOString()}::timestamptz`),
    and(eq(resultAt, sql`${scan.cursorAt.toISOString()}::timestamptz`), gt(taskRuns.taskId, scan.cursorTaskId)),
    and(eq(resultAt, sql`${scan.cursorAt.toISOString()}::timestamptz`), eq(taskRuns.taskId, scan.cursorTaskId),
      gt(taskRuns.id, scan.cursorTaskRunId)),
  );
}

function throughResult(scan: TaskContentBackfillScan) {
  if (scan.throughAt === null || scan.throughTaskId === null || scan.throughTaskRunId === null) {
    return isNull(taskRuns.id);
  }
  return or(
    lt(resultAt, sql`${scan.throughAt.toISOString()}::timestamptz`),
    and(eq(resultAt, sql`${scan.throughAt.toISOString()}::timestamptz`), lt(taskRuns.taskId, scan.throughTaskId)),
    and(eq(resultAt, sql`${scan.throughAt.toISOString()}::timestamptz`), eq(taskRuns.taskId, scan.throughTaskId),
      lte(taskRuns.id, scan.throughTaskRunId)),
  );
}

/** Discover bounded structural work. The query never projects Task or result content. */
export async function discoverTaskContentBackfill(
  database: Database,
  input: Readonly<{
    humanActorId: string;
    deviceId: string;
    now: Date;
    pageLimit: number;
    resumeAt: Date;
  }>,
): Promise<TaskContentBackfillDiscovery> {
  positiveLimit(input.pageLimit);
  if (!UUID.test(input.humanActorId) || input.deviceId.length < 1
    || !validDate(input.now) || !validDate(input.resumeAt)) {
    throw new TypeError("Task content backfill discovery is invalid");
  }
  return database.transaction(async (tx) => {
    const policy = await acquireEncryptionConsumptionFence(tx);
    if (policy.mode === "plaintext_only") return { status: "disabled" as const };
    if (policy.mode === "encrypted_only") return { status: "full_wait" as const };
    const userId = await requesterUserId(tx, input.humanActorId);
    if (userId === null) return { status: "disabled" as const };
    await tx.insert(taskContentBackfillScans).values({ humanActorId: input.humanActorId })
      .onConflictDoNothing();
    let [scan] = await tx.select().from(taskContentBackfillScans)
      .where(eq(taskContentBackfillScans.humanActorId, input.humanActorId)).for("update");
    if (scan === undefined) throw new Error("Task content backfill scan is unavailable");

    if (scan.leaseToken !== null) {
      const retained = decodeClaim(scan);
      if (retained !== null && scan.leaseExpiresAt !== null
        && scan.leaseExpiresAt.getTime() > input.now.getTime()) {
        return retained.deviceId === input.deviceId
          ? { status: "claimed" as const, claim: retained }
          : { status: "waiting" as const, resumeAt: new Date(scan.leaseExpiresAt) };
      }
      const advance = retained === null ? {} : cursorUpdate(retained.candidate);
      [scan] = await tx.update(taskContentBackfillScans).set({
        ...clearLease, ...advance, lastActiveAt: input.now,
      }).where(eq(taskContentBackfillScans.humanActorId, input.humanActorId)).returning();
      if (scan === undefined) throw new Error("Task content backfill expired lease was lost");
    }
    if (scan.resumeAt !== null && scan.resumeAt.getTime() > input.now.getTime()) {
      return { status: "waiting" as const, resumeAt: new Date(scan.resumeAt) };
    }

    // A phase with no candidates advances immediately; at most two phases are inspected.
    for (let phaseAttempt = 0; phaseAttempt < 2; phaseAttempt += 1) {
      scan = await setHighWater(tx, scan, userId);
      if (scan.phase === "definition") {
        if (scan.throughAt === null) continue;
        const failure = taskContentBackfillFailures;
        const rows = await tx.select({
          taskId: tasks.id,
          ownerId: tasks.ownerId,
          preset: tasks.preset,
          depth: tasks.depth,
          createdAt: definitionAt,
          updatedAt: tasks.updatedAt,
          status: tasks.status,
          contentRevision: tasks.contentRevision,
          parentTaskId: tasks.parentTaskId,
          failureReason: failure.reason,
          failureSourceRevision: failure.sourceRevision,
          failureSourceUpdatedAt: failure.sourceUpdatedAt,
          failureSourceStatus: failure.sourceStatus,
          failurePolicyRevision: failure.policyRevision,
        }).from(tasks).leftJoin(failure, and(
          eq(failure.kind, "definition"), eq(failure.entityId, tasks.id),
        )).where(and(
          eq(tasks.requestorId, userId), eq(tasks.contentRepresentation, "ordinary"),
          afterDefinition(scan), throughDefinition(scan),
        )).orderBy(asc(definitionAt), asc(tasks.id)).limit(input.pageLimit);
        for (const row of rows) {
          const candidate = definitionCandidate(row);
          const cached = failureFromDefinition(row);
          if (cached !== null && exactFailure(cached, candidate, policy.revision)) {
            await tx.update(taskContentBackfillScans).set(cursorUpdate(candidate))
              .where(eq(taskContentBackfillScans.humanActorId, input.humanActorId));
            scan = { ...scan, ...cursorUpdate(candidate) };
            continue;
          }
          if (row.parentTaskId !== null || row.depth !== 0
            || !isProtectedTaskPreset(row.preset) || row.ownerId !== userId) {
            await upsertFailure(tx, candidate, policy.revision, "unsupported", input.now);
            await tx.update(taskContentBackfillScans).set(cursorUpdate(candidate))
              .where(eq(taskContentBackfillScans.humanActorId, input.humanActorId));
            scan = { ...scan, ...cursorUpdate(candidate) };
            continue;
          }
          return { status: "candidate" as const, candidate, policyRevision: policy.revision, requesterUserId: userId };
        }
        if (rows.length === input.pageLimit) return { status: "more" as const };
        [scan] = await tx.update(taskContentBackfillScans).set({
          phase: "result", cursorAt: null, cursorTaskId: null, cursorTaskRunId: null,
          throughAt: null, throughTaskId: null, throughTaskRunId: null,
        }).where(eq(taskContentBackfillScans.humanActorId, input.humanActorId)).returning();
        if (scan === undefined) throw new Error("Task content backfill result phase was lost");
        continue;
      }

      if (scan.throughAt === null) {
        await tx.update(taskContentBackfillScans).set({
          ...clearLease,
          phase: "definition", cursorAt: null, cursorTaskId: null, cursorTaskRunId: null,
          throughAt: null, throughTaskId: null, throughTaskRunId: null,
          lastSweepAt: input.now, sweepStartedAt: input.now, lastActiveAt: input.now,
          resumeAt: input.resumeAt,
        }).where(eq(taskContentBackfillScans.humanActorId, input.humanActorId));
        return { status: "swept" as const, resumeAt: new Date(input.resumeAt) };
      }
      const resultFailure = alias(taskContentBackfillFailures, "task_result_backfill_failure");
      const parentFailure = alias(taskContentBackfillFailures, "task_definition_backfill_failure");
      const rows = await tx.select({
        taskId: taskRuns.taskId,
        taskRunId: taskRuns.id,
        taskUpdatedAt: tasks.updatedAt,
        startedAt: taskRuns.startedAt,
        completedAt: resultAt,
        status: taskRuns.status,
        resultRevision: taskRuns.resultRevision,
        parentRepresentation: tasks.contentRepresentation,
        parentMappingState: tasks.cryptoMappingState,
        parentStatus: tasks.status,
        parentFailureReason: parentFailure.reason,
        parentFailureRevision: parentFailure.sourceRevision,
        parentFailureUpdatedAt: parentFailure.sourceUpdatedAt,
        parentFailureStatus: parentFailure.sourceStatus,
        parentFailurePolicyRevision: parentFailure.policyRevision,
        failureReason: resultFailure.reason,
        failureSourceRevision: resultFailure.sourceRevision,
        failureSourceUpdatedAt: resultFailure.sourceUpdatedAt,
        failureSourceStatus: resultFailure.sourceStatus,
        failureSourceCompletedAt: resultFailure.sourceCompletedAt,
        failurePolicyRevision: resultFailure.policyRevision,
      }).from(taskRuns).innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
        .leftJoin(parentFailure, and(eq(parentFailure.kind, "definition"), eq(parentFailure.entityId, tasks.id)))
        .leftJoin(resultFailure, and(eq(resultFailure.kind, "result"), eq(resultFailure.entityId, taskRuns.id)))
        .where(and(
          eq(tasks.requestorId, userId), eq(taskRuns.resultRepresentation, "ordinary"),
          inArray(taskRuns.status, TERMINAL_RUN_STATUSES),
          isNotNull(taskRuns.completedAt), afterResult(scan), throughResult(scan),
        )).orderBy(asc(resultAt), asc(taskRuns.taskId), asc(taskRuns.id))
        .limit(input.pageLimit);
      for (const untyped of rows) {
        const row = untyped as ResultRow;
        const candidate = resultCandidate(row);
        const cached = failureFromResult(row);
        const exactCached = cached !== null
          && exactFailure(cached, candidate, policy.revision) ? cached : null;
        if (exactCached !== null && exactCached.reason !== "waiting_parent") {
          await tx.update(taskContentBackfillScans).set(cursorUpdate(candidate))
            .where(eq(taskContentBackfillScans.humanActorId, input.humanActorId));
          scan = { ...scan, ...cursorUpdate(candidate) };
          continue;
        }
        const parentMapped = (row.parentRepresentation === "dual" || row.parentRepresentation === "protected")
          && row.parentMappingState === "verified";
        if (parentMapped) {
          if (exactCached !== null) {
            await tx.delete(taskContentBackfillFailures).where(and(
              eq(taskContentBackfillFailures.kind, "result"),
              eq(taskContentBackfillFailures.entityId, candidate.taskRunId),
            ));
          }
          return { status: "candidate" as const, candidate, policyRevision: policy.revision, requesterUserId: userId };
        }
        if (!parentMapped) {
          const parentUnsupported = row.parentFailureReason === "unsupported"
            && row.parentFailureRevision === 0
            && row.parentFailureUpdatedAt?.getTime() === row.taskUpdatedAt.getTime()
            && row.parentFailureStatus === row.parentStatus
            && row.parentFailurePolicyRevision === policy.revision;
          await upsertFailure(tx, candidate, policy.revision,
            parentUnsupported ? "unsupported" : "waiting_parent", input.now);
          await tx.update(taskContentBackfillScans).set(cursorUpdate(candidate))
            .where(eq(taskContentBackfillScans.humanActorId, input.humanActorId));
          scan = { ...scan, ...cursorUpdate(candidate) };
          continue;
        }
      }
      if (rows.length === input.pageLimit) return { status: "more" as const };
      await tx.update(taskContentBackfillScans).set({
        ...clearLease,
        phase: "definition", cursorAt: null, cursorTaskId: null, cursorTaskRunId: null,
        throughAt: null, throughTaskId: null, throughTaskRunId: null,
        lastSweepAt: input.now, sweepStartedAt: input.now, lastActiveAt: input.now,
        resumeAt: input.resumeAt,
      }).where(eq(taskContentBackfillScans.humanActorId, input.humanActorId));
      return { status: "swept" as const, resumeAt: new Date(input.resumeAt) };
    }
    return { status: "more" as const };
  }, { isolationLevel: "read committed" });
}

/** Install the exact structural candidate under the per-Human scan CAS. */
export async function claimTaskContentBackfill(
  database: Database,
  input: Readonly<{
    humanActorId: string;
    requesterUserId: string;
    deviceId: string;
    claimId: string;
    policyRevision: number;
    candidate: TaskContentBackfillCandidate;
    now: Date;
    expiresAt: Date;
  }>,
): Promise<Readonly<{ status: "claimed"; claim: TaskContentBackfillClaim }>
  | Readonly<{ status: "stale" | "held" | "disabled" }>> {
  if (!UUID.test(input.claimId) || !validDate(input.now) || !validDate(input.expiresAt)
    || !UUID.test(input.humanActorId) || !UUID.test(input.requesterUserId)
    || input.deviceId.length < 1 || decodeCandidate(encodeCandidate(input.candidate)) === null
    || input.expiresAt.getTime() <= input.now.getTime()) throw new TypeError("Task content backfill claim is invalid");
  return database.transaction(async (tx) => {
    const policy = await acquireEncryptionConsumptionFence(tx);
    if (policy.mode !== "shadow_encryption") return { status: "disabled" as const };
    if (policy.revision !== input.policyRevision
      || await requesterUserId(tx, input.humanActorId) !== input.requesterUserId) return { status: "stale" as const };
    const [detachedScan] = await tx.select().from(taskContentBackfillScans)
      .where(eq(taskContentBackfillScans.humanActorId, input.humanActorId)).limit(1);
    if (detachedScan === undefined) return { status: "stale" as const };
    if (detachedScan.leaseToken !== null && detachedScan.leaseExpiresAt !== null
      && detachedScan.leaseExpiresAt.getTime() > input.now.getTime()) return { status: "held" as const };
    if (detachedScan.phase !== input.candidate.kind
      || !candidateIsAfterCursor(detachedScan, input.candidate)
      || !candidateIsWithinThrough(detachedScan, input.candidate)) return { status: "stale" as const };

    // Preserve the canonical product order: Task -> TaskRun -> scan. The
    // detached scan is only an optimistic gate; the final locked reread below
    // decides whether this structurally current candidate can be installed.
    const current = await currentCandidate(tx, input.candidate, input.requesterUserId);
    if (current === null || !sameCandidate(current, input.candidate)) return { status: "stale" as const };

    const [scan] = await tx.select().from(taskContentBackfillScans)
      .where(eq(taskContentBackfillScans.humanActorId, input.humanActorId)).for("update");
    if (scan === undefined) return { status: "stale" as const };
    if (scan.leaseToken !== null && scan.leaseExpiresAt !== null
      && scan.leaseExpiresAt.getTime() > input.now.getTime()) return { status: "held" as const };
    if (scan.phase !== current.kind || !candidateIsAfterCursor(scan, current)
      || !candidateIsWithinThrough(scan, current)) return { status: "stale" as const };
    const claim = Object.freeze({
      claimId: input.claimId,
      humanActorId: input.humanActorId,
      requesterUserId: input.requesterUserId,
      deviceId: input.deviceId,
      policyRevision: input.policyRevision,
      expiresAt: new Date(input.expiresAt),
      candidate: current,
    });
    await tx.update(taskContentBackfillScans).set({
      leaseToken: claim.claimId,
      leaseDeviceId: claim.deviceId,
      leaseExpiresAt: claim.expiresAt,
      claim: encodeClaim(claim),
      lastActiveAt: input.now,
      resumeAt: null,
    }).where(eq(taskContentBackfillScans.humanActorId, input.humanActorId));
    return { status: "claimed" as const, claim };
  }, { isolationLevel: "read committed" });
}

export async function renewTaskContentBackfillLease(
  database: Database,
  input: Readonly<{ claim: TaskContentBackfillClaim; now: Date; expiresAt: Date }>,
): Promise<TaskContentBackfillClaim | null> {
  if (!validDate(input.now) || !validDate(input.expiresAt)
    || input.expiresAt.getTime() <= input.now.getTime()) throw new TypeError("Task content backfill renewal is invalid");
  return database.transaction(async (tx) => {
    const policy = await acquireEncryptionConsumptionFence(tx);
    if (policy.mode !== "shadow_encryption" || policy.revision !== input.claim.policyRevision) return null;
    const [scan] = await tx.select().from(taskContentBackfillScans).where(and(
      eq(taskContentBackfillScans.humanActorId, input.claim.humanActorId),
      eq(taskContentBackfillScans.leaseToken, input.claim.claimId),
      eq(taskContentBackfillScans.leaseDeviceId, input.claim.deviceId),
    )).for("update");
    const retained = scan === undefined ? null : decodeClaim(scan);
    if (retained === null || scan!.leaseExpiresAt === null
      || scan!.leaseExpiresAt.getTime() <= input.now.getTime()
      || !sameClaim(retained, input.claim)) return null;
    const renewed = Object.freeze({ ...retained, expiresAt: new Date(input.expiresAt) });
    await tx.update(taskContentBackfillScans).set({
      leaseExpiresAt: renewed.expiresAt, claim: encodeClaim(renewed), lastActiveAt: input.now,
    }).where(eq(taskContentBackfillScans.humanActorId, input.claim.humanActorId));
    return renewed;
  }, { isolationLevel: "read committed" });
}

export async function releaseTaskContentBackfillLease(
  database: Database,
  input: Readonly<{ claim: TaskContentBackfillClaim; now: Date; advance: boolean }>,
): Promise<boolean> {
  if (!validDate(input.now)) throw new TypeError("Task content backfill release is invalid");
  return database.transaction(async (tx) => {
    const policy = await acquireEncryptionConsumptionFence(tx);
    if (policy.mode !== "shadow_encryption") return false;
    const [scan] = await tx.select().from(taskContentBackfillScans).where(and(
      eq(taskContentBackfillScans.humanActorId, input.claim.humanActorId),
      eq(taskContentBackfillScans.leaseToken, input.claim.claimId),
      eq(taskContentBackfillScans.leaseDeviceId, input.claim.deviceId),
    )).for("update");
    const retained = scan === undefined ? null : decodeClaim(scan);
    if (retained === null || retained.policyRevision !== policy.revision
      || !sameClaim(retained, input.claim)) return false;
    await tx.update(taskContentBackfillScans).set({
      ...clearLease,
      ...(input.advance ? cursorUpdate(retained.candidate) : {}),
      lastActiveAt: input.now,
    }).where(eq(taskContentBackfillScans.humanActorId, input.claim.humanActorId));
    return true;
  }, { isolationLevel: "read committed" });
}

async function currentCandidate(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  candidate: TaskContentBackfillCandidate,
  expectedRequesterUserId: string,
): Promise<TaskContentBackfillCandidate | null> {
  if (candidate.kind === "definition") {
    const [row] = await tx.select({
      taskId: tasks.id, createdAt: tasks.createdAt, updatedAt: tasks.updatedAt,
      status: tasks.status, contentRevision: tasks.contentRevision,
      representation: tasks.contentRepresentation, requestorId: tasks.requestorId,
      parentTaskId: tasks.parentTaskId,
    }).from(tasks).where(eq(tasks.id, candidate.taskId)).limit(1).for("update");
    return row !== undefined && row.requestorId === expectedRequesterUserId
      && row.representation === "ordinary" && row.parentTaskId === null
      ? Object.freeze({ kind: "definition", taskId: row.taskId,
        sourceCreatedAt: row.createdAt, sourceUpdatedAt: row.updatedAt,
        sourceRevision: row.contentRevision, sourceStatus: row.status }) : null;
  }
  const [task] = await tx.select({
    taskId: tasks.id,
    updatedAt: tasks.updatedAt,
    requestorId: tasks.requestorId,
    representation: tasks.contentRepresentation,
    mappingState: tasks.cryptoMappingState,
  }).from(tasks).where(eq(tasks.id, candidate.taskId)).limit(1).for("update");
  if (task === undefined || task.requestorId !== expectedRequesterUserId
    || (task.representation !== "dual" && task.representation !== "protected")
    || task.mappingState !== "verified") return null;
  const [row] = await tx.select({
    taskId: taskRuns.taskId, taskRunId: taskRuns.id,
    startedAt: taskRuns.startedAt, completedAt: taskRuns.completedAt,
    status: taskRuns.status, resultRevision: taskRuns.resultRevision,
    representation: taskRuns.resultRepresentation,
  }).from(taskRuns).where(and(
    eq(taskRuns.id, candidate.taskRunId), eq(taskRuns.taskId, candidate.taskId),
  )).limit(1).for("update");
  if (row === undefined || row.representation !== "ordinary" || row.completedAt === null
    || !TERMINAL_RUN_STATUSES.includes(row.status as typeof TERMINAL_RUN_STATUSES[number])) return null;
  return Object.freeze({ kind: "result", taskId: row.taskId, taskRunId: row.taskRunId,
    sourceUpdatedAt: task.updatedAt, sourceStartedAt: row.startedAt,
    sourceCompletedAt: row.completedAt, sourceRevision: row.resultRevision,
    sourceStatus: row.status as TaskContentBackfillResultCandidate["sourceStatus"] });
}

async function mappedCandidate(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  candidate: TaskContentBackfillCandidate,
  expectedRequesterUserId: string,
): Promise<boolean> {
  if (candidate.kind === "definition") {
    const [row] = await tx.select({
      representation: tasks.contentRepresentation,
      revision: tasks.contentRevision,
      mappingState: tasks.cryptoMappingState,
      requestorId: tasks.requestorId,
    }).from(tasks).where(eq(tasks.id, candidate.taskId)).limit(1).for("update");
    return row !== undefined
      && row.requestorId === expectedRequesterUserId
      && (row.representation === "dual" || row.representation === "protected")
      && row.revision === candidate.sourceRevision + 1
      && row.mappingState === "verified";
  }
  const [row] = await tx.select({
    taskId: taskRuns.taskId,
    representation: taskRuns.resultRepresentation,
    revision: taskRuns.resultRevision,
    mappingState: taskRuns.resultCryptoMappingState,
    status: taskRuns.status,
    completedAt: taskRuns.completedAt,
  }).from(taskRuns).where(and(
    eq(taskRuns.id, candidate.taskRunId), eq(taskRuns.taskId, candidate.taskId),
  )).limit(1).for("update");
  return row !== undefined && row.taskId === candidate.taskId
    && (row.representation === "dual" || row.representation === "protected")
    && row.revision === candidate.sourceRevision + 1
    && row.mappingState === "verified"
    && row.status === candidate.sourceStatus
    && row.completedAt !== null
    && row.completedAt.getTime() === candidate.sourceCompletedAt.getTime();
}

function sameCandidate(left: TaskContentBackfillCandidate, right: TaskContentBackfillCandidate): boolean {
  return left.kind === right.kind && left.taskId === right.taskId
    && left.sourceRevision === right.sourceRevision
    && left.sourceUpdatedAt.getTime() === right.sourceUpdatedAt.getTime()
    && left.sourceStatus === right.sourceStatus
    && (left.kind === "definition" && right.kind === "definition"
      ? left.sourceCreatedAt.getTime() === right.sourceCreatedAt.getTime()
      : left.kind === "result" && right.kind === "result"
        && left.taskRunId === right.taskRunId
        && left.sourceStartedAt.getTime() === right.sourceStartedAt.getTime()
        && left.sourceCompletedAt.getTime() === right.sourceCompletedAt.getTime());
}

function sameClaim(left: TaskContentBackfillClaim, right: TaskContentBackfillClaim): boolean {
  return left.claimId === right.claimId
    && left.humanActorId === right.humanActorId
    && left.requesterUserId === right.requesterUserId
    && left.deviceId === right.deviceId
    && left.policyRevision === right.policyRevision
    && left.expiresAt.getTime() === right.expiresAt.getTime()
    && sameCandidate(left.candidate, right.candidate);
}

export type TaskContentBackfillTransaction =
  Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Lock and revalidate one live structural claim inside its caller's product
 * transaction. Product source/publication owners add their Namespace and
 * device authority around this guard; this function never reads content.
 */
export async function lockCurrentTaskContentBackfillClaim(
  tx: TaskContentBackfillTransaction,
  input: Readonly<{
    humanActorId: string;
    deviceId: string;
    claimId: string;
    now: Date;
  }>,
): Promise<TaskContentBackfillClaim | null> {
  if (!UUID.test(input.humanActorId) || !UUID.test(input.claimId)
    || input.deviceId.length < 1 || !validDate(input.now)) return null;
  const policy = await acquireEncryptionConsumptionFence(tx);
  if (policy.mode !== "shadow_encryption") return null;
  const [detachedScan] = await tx.select().from(taskContentBackfillScans).where(and(
    eq(taskContentBackfillScans.humanActorId, input.humanActorId),
    eq(taskContentBackfillScans.leaseToken, input.claimId),
    eq(taskContentBackfillScans.leaseDeviceId, input.deviceId),
  )).limit(1);
  const detached = detachedScan === undefined ? null : decodeClaim(detachedScan);
  if (detached === null || detached.policyRevision !== policy.revision
    || detached.expiresAt.getTime() <= input.now.getTime()
    || await requesterUserId(tx, input.humanActorId) !== detached.requesterUserId) return null;

  const current = await currentCandidate(tx, detached.candidate, detached.requesterUserId);
  if (current === null || !sameCandidate(current, detached.candidate)) return null;

  const [lockedScan] = await tx.select().from(taskContentBackfillScans).where(and(
    eq(taskContentBackfillScans.humanActorId, input.humanActorId),
    eq(taskContentBackfillScans.leaseToken, input.claimId),
    eq(taskContentBackfillScans.leaseDeviceId, input.deviceId),
  )).for("update");
  const locked = lockedScan === undefined ? null : decodeClaim(lockedScan);
  return locked !== null && sameClaim(detached, locked)
    && locked.expiresAt.getTime() > input.now.getTime() ? locked : null;
}

/** Read a live structural lease without assuming its source remains ordinary. */
export async function readCurrentTaskContentBackfillClaim(
  database: Database,
  input: Readonly<{ humanActorId: string; deviceId: string; claimId: string; now: Date }>,
): Promise<TaskContentBackfillClaim | null> {
  if (!UUID.test(input.humanActorId) || !UUID.test(input.claimId)
    || input.deviceId.length < 1 || !validDate(input.now)) return null;
  return database.transaction(async tx => {
    const policy = await acquireEncryptionConsumptionFence(tx);
    if (policy.mode !== "shadow_encryption") return null;
    const [scan] = await tx.select().from(taskContentBackfillScans).where(and(
      eq(taskContentBackfillScans.humanActorId, input.humanActorId),
      eq(taskContentBackfillScans.leaseToken, input.claimId),
      eq(taskContentBackfillScans.leaseDeviceId, input.deviceId),
    )).limit(1);
    const claim = scan === undefined ? null : decodeClaim(scan);
    return claim !== null && claim.policyRevision === policy.revision
      && claim.expiresAt.getTime() > input.now.getTime()
      && await requesterUserId(tx, input.humanActorId) === claim.requesterUserId
      ? claim : null;
  });
}

/** Record only a source-proxy outcome or a proven mapped counterpart, then advance atomically. */
export async function acknowledgeTaskContentBackfill(
  database: Database,
  input: Readonly<{
    claim: TaskContentBackfillClaim;
    outcome: TaskContentBackfillDisposition;
    now: Date;
  }> | Readonly<{
    claim: TaskContentBackfillClaim;
    outcome: "mapped";
    now: Date;
    /** Read-only immutable-ledger assertion; it must not mutate the transaction. */
    assertMapped(
      tx: TaskContentBackfillTransaction,
      claim: TaskContentBackfillClaim,
    ): Promise<boolean>;
  }>,
): Promise<"acknowledged" | "lease_lost" | "source_changed" | "not_mapped" | "disabled"> {
  return database.transaction(async (tx) => {
    const policy = await acquireEncryptionConsumptionFence(tx);
    if (policy.mode !== "shadow_encryption") return "disabled" as const;
    const [detachedScan] = await tx.select().from(taskContentBackfillScans).where(and(
      eq(taskContentBackfillScans.humanActorId, input.claim.humanActorId),
      eq(taskContentBackfillScans.leaseToken, input.claim.claimId),
      eq(taskContentBackfillScans.leaseDeviceId, input.claim.deviceId),
    )).limit(1);
    const detached = detachedScan === undefined ? null : decodeClaim(detachedScan);
    if (detached === null || detached.policyRevision !== policy.revision
      || detached.expiresAt.getTime() <= input.now.getTime()) return "lease_lost" as const;

    // Canonical product locks precede the scan lock. The later exact scan
    // reread catches expiry, release, renewal, and claim replacement races.
    const current = await currentCandidate(tx, detached.candidate, detached.requesterUserId);
    if (input.outcome === "mapped") {
      if (current !== null || !await mappedCandidate(
        tx,
        detached.candidate,
        detached.requesterUserId,
      )
        || !await input.assertMapped(tx, detached)) {
        return "not_mapped" as const;
      }
    } else {
      if (current === null || !sameCandidate(current, detached.candidate)) return "source_changed" as const;
    }

    const [lockedScan] = await tx.select().from(taskContentBackfillScans).where(and(
      eq(taskContentBackfillScans.humanActorId, input.claim.humanActorId),
      eq(taskContentBackfillScans.leaseToken, input.claim.claimId),
      eq(taskContentBackfillScans.leaseDeviceId, input.claim.deviceId),
    )).for("update");
    const retained = lockedScan === undefined ? null : decodeClaim(lockedScan);
    if (retained === null || !sameClaim(detached, retained)
      || retained.expiresAt.getTime() <= input.now.getTime()) return "lease_lost" as const;

    if (input.outcome !== "mapped") {
      if (current === null) return "source_changed" as const;
      await upsertFailure(tx, current, policy.revision, input.outcome, input.now);
    }
    if (input.outcome === "mapped") {
      await tx.delete(taskContentBackfillFailures).where(and(
        eq(taskContentBackfillFailures.kind, retained.candidate.kind),
        eq(taskContentBackfillFailures.entityId, retained.candidate.kind === "definition"
          ? retained.candidate.taskId : retained.candidate.taskRunId),
      ));
    }
    await tx.update(taskContentBackfillScans).set({
      ...clearLease, ...cursorUpdate(retained.candidate), lastActiveAt: input.now,
    }).where(eq(taskContentBackfillScans.humanActorId, input.claim.humanActorId));
    return "acknowledged" as const;
  }, { isolationLevel: "read committed" });
}

function aggregateCount(value: unknown, label: string): number {
  const count = typeof value === "bigint" ? Number(value) : value;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`Task content backfill ${label} is invalid`);
  }
  return count;
}

/** Content-free complete accounting; scan cursors are liveness only. */
export async function readTaskContentBackfillProgress(
  database: Database,
  input: Readonly<{ humanActorId: string; now: Date }>,
): Promise<TaskContentBackfillProgress | null> {
  return database.transaction(async (tx) => {
    const policy = await acquireEncryptionConsumptionFence(tx);
    if (policy.mode === "plaintext_only") return null;
    const userId = await requesterUserId(tx, input.humanActorId);
    if (userId === null) return null;
    const definitionFailure = taskContentBackfillFailures;
    const [definitions] = await tx.select({
      eligible: sql<number>`count(*)::double precision`,
      mapped: sql<number>`count(*) filter (where ${tasks.contentRepresentation} in ('dual', 'protected') and ${tasks.cryptoMappingState} = 'verified')::double precision`,
      waiting: sql<number>`count(*) filter (where ${definitionFailure.reason} = 'waiting_parent')::double precision`,
      unsupported: sql<number>`count(*) filter (where ${definitionFailure.reason} = 'unsupported')::double precision`,
      failed: sql<number>`count(*) filter (where ${definitionFailure.reason} = 'integrity')::double precision`,
      noContent: sql<number>`count(*) filter (where ${definitionFailure.reason} = 'no_content')::double precision`,
    }).from(tasks).leftJoin(definitionFailure, and(
      eq(definitionFailure.kind, "definition"), eq(definitionFailure.entityId, tasks.id),
      eq(definitionFailure.sourceRevision, tasks.contentRevision),
      eq(definitionFailure.sourceUpdatedAt, tasks.updatedAt),
      eq(definitionFailure.sourceStatus, tasks.status),
      eq(definitionFailure.policyRevision, policy.revision),
    )).where(eq(tasks.requestorId, userId));
    const resultFailure = taskContentBackfillFailures;
    const [results] = await tx.select({
      eligible: sql<number>`count(*)::double precision`,
      mapped: sql<number>`count(*) filter (where ${taskRuns.resultRepresentation} in ('dual', 'protected') and ${taskRuns.resultCryptoMappingState} = 'verified')::double precision`,
      waiting: sql<number>`count(*) filter (where ${resultFailure.reason} = 'waiting_parent')::double precision`,
      unsupported: sql<number>`count(*) filter (where ${resultFailure.reason} = 'unsupported')::double precision`,
      failed: sql<number>`count(*) filter (where ${resultFailure.reason} = 'integrity')::double precision`,
      noContent: sql<number>`count(*) filter (where ${resultFailure.reason} = 'no_content')::double precision`,
    }).from(taskRuns).innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
      .leftJoin(resultFailure, and(
        eq(resultFailure.kind, "result"), eq(resultFailure.entityId, taskRuns.id),
        eq(resultFailure.sourceRevision, taskRuns.resultRevision),
        eq(resultFailure.sourceUpdatedAt, tasks.updatedAt),
        eq(resultFailure.sourceStatus, taskRuns.status),
        eq(resultFailure.sourceCompletedAt, taskRuns.completedAt),
        eq(resultFailure.policyRevision, policy.revision),
      )).where(and(eq(tasks.requestorId, userId),
        inArray(taskRuns.status, TERMINAL_RUN_STATUSES), isNotNull(taskRuns.completedAt)));
    if (definitions === undefined || results === undefined) throw new Error("Task content backfill progress is unavailable");
    const eligibleDefinitions = aggregateCount(definitions.eligible, "eligible definitions");
    const mappedDefinitions = aggregateCount(definitions.mapped, "mapped definitions");
    const eligibleResults = aggregateCount(results.eligible, "eligible results");
    const mappedResults = aggregateCount(results.mapped, "mapped results");
    const waiting = aggregateCount(definitions.waiting, "waiting definitions")
      + aggregateCount(results.waiting, "waiting results");
    const unsupported = aggregateCount(definitions.unsupported, "unsupported definitions")
      + aggregateCount(results.unsupported, "unsupported results");
    const failed = aggregateCount(definitions.failed, "failed definitions")
      + aggregateCount(results.failed, "failed results");
    const noContent = aggregateCount(definitions.noContent, "empty definitions")
      + aggregateCount(results.noContent, "empty results");
    const [scan] = await tx.select({
      claim: taskContentBackfillScans.claim,
      leaseExpiresAt: taskContentBackfillScans.leaseExpiresAt,
    })
      .from(taskContentBackfillScans).where(eq(taskContentBackfillScans.humanActorId, input.humanActorId));
    const claimedRepairing = scan?.claim === null || scan === undefined
      || scan.leaseExpiresAt === null
      || scan.leaseExpiresAt.getTime() <= input.now.getTime() ? 0 : 1;
    return Object.freeze({
      eligibleDefinitions, mappedDefinitions, eligibleResults, mappedResults,
      claimedRepairing, waiting, unsupported, failed, noContent,
      pending: Math.max(0, eligibleDefinitions + eligibleResults - mappedDefinitions
        - mappedResults - unsupported - failed - noContent),
    });
  }, { isolationLevel: "read committed" });
}
