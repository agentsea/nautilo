import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type { DirectDatabase } from "../config/direct-database";
import { encryptionTransitionPolicy } from "../schema/encryption-transition";
import { jobs } from "../schema/jobs";
import { protectedTaskRunOutputBindings } from
  "../schema/protected-task-run-output-bindings";
import { taskDefinitionCryptoRevisions } from
  "../schema/task-definition-crypto-revisions";
import { taskRunResultCryptoRevisions } from
  "../schema/task-run-result-crypto-revisions";
import { taskRuns } from "../schema/task-runs";
import { tasks } from "../schema/tasks";
import {
  protectedTaskRunOutputBindingId,
  protectedTaskRunMessageOperationId,
  protectedTaskRunResultObjectId,
  protectedTaskRunResultOperationId,
  protectedTaskRunWakeOperationId,
} from "./protected-task-output-binding-identities";
import { PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY } from "./tasks";
import { protectedTaskDefinitionSupportsPolicy } from "../utils/encryption-transition-queries";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
// Lexical cleanup correlation only; execution/opening verifies canonical provenance and signed history.
const DEFINITION_OBJECT = /^(?:task-definition|task-historical):v1:[0-9a-f]{64}$/u;
const RESULT_OBJECT = /^task-run-result:v1:[0-9a-f]{64}$/u;
const CONTINUATION = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const MAX_IDENTIFIER_BYTES = 128;
const encoder = new TextEncoder();

export const PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY =
  "nautilo.protectedTaskRunAbandonment.v1";

export type ProtectedTaskRunningRecoveryCursor = Readonly<{
  startedAt: Date;
  taskRunId: string;
}>;

export type ProtectedTaskRunningRecoveryCandidate = Readonly<{
  taskId: string;
  taskRunId: string;
  startedAt: Date;
}>;

export type ProtectedTaskRunningRecoveryPage = Readonly<{
  candidates: readonly ProtectedTaskRunningRecoveryCandidate[];
  next: ProtectedTaskRunningRecoveryCursor | null;
}>;

export type ProtectedTaskRunningAuthorizationProof = Readonly<{
  taskId: string;
  taskRunId: string;
  jobId: string;
  jobStatus: "running" | "failed" | "timed_out" | "cancelled";
  authorizationRequestId: string;
  contentNamespaceId: string;
  acceptedPolicyRevision: number;
  executionSegment: number;
}>;

export type ProtectedTaskRunningAuthorizationSettlement = Readonly<{
  requestRevision: number;
  recipientGeneration: number;
  settledAt: Date;
}>;

export type ProtectedTaskRunningRecoveryResult = Readonly<{
  status: "settled" | "exact_replay" | "reserved" | "inactive" | "policy_wait";
  cleanup?: Readonly<{ requestId: string; generation: number }>;
}>;

type DurableReference = Readonly<{
  kind: "protected_task_run_v1";
  taskId: string;
  taskRunId: string;
  inputObjectId: string;
  resultObjectId: string;
  authorizationRequestId: string;
  policyRevision: number;
  executionSegment: number;
  resumeAcceptanceId?: string;
  resumeContinuationFingerprint?: string;
}>;

export type ProtectedTaskRunAbandonmentReceipt = Readonly<{
  version: 1;
  taskId: string;
  taskRunId: string;
  authorizationRequestId: string;
  requestRevision: number;
  recipientGeneration: number;
  executionSegment: number;
  reason: "provider_outcome_unknown";
  settledAt: string;
  parentTaskTerminalized: boolean;
}>;
type AbandonmentReceipt = ProtectedTaskRunAbandonmentReceipt;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function sameBytes(left: Uint8Array | null, right: Uint8Array): boolean {
  return left !== null && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function exactDeliveryBinding(
  binding: typeof protectedTaskRunOutputBindings.$inferSelect,
  taskRunId: string,
): boolean {
  if (binding.deliveryMode === "none") {
    return binding.destinationRoomId === null
      && binding.destinationNamespaceId === null
      && binding.messageOperationId === null && binding.wakeOperationId === null;
  }
  if (binding.destinationRoomId === null || binding.destinationNamespaceId === null) {
    return false;
  }
  const message = protectedTaskRunMessageOperationId(taskRunId);
  const wake = protectedTaskRunWakeOperationId(taskRunId);
  return binding.deliveryMode === "raw"
    ? binding.messageOperationId === message && binding.wakeOperationId === null
    : binding.deliveryMode === "wake"
      ? binding.messageOperationId === null && binding.wakeOperationId === wake
      : binding.deliveryMode === "raw_and_wake"
        && binding.messageOperationId === message && binding.wakeOperationId === wake;
}

function exactReference(value: unknown): value is DurableReference {
  if (!record(value)) return false;
  const segment = value["executionSegment"];
  const resumed = Number.isSafeInteger(segment) && (segment as number) > 1;
  const hasAcceptance = Object.hasOwn(value, "resumeAcceptanceId");
  const hasContinuation = Object.hasOwn(value, "resumeContinuationFingerprint");
  const keys = resumed
    ? hasAcceptance
      ? "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,resumeAcceptanceId,taskId,taskRunId"
      : "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,resumeContinuationFingerprint,taskId,taskRunId"
    : "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,taskId,taskRunId";
  return Object.keys(value).sort().join(",") === keys
    && value["kind"] === "protected_task_run_v1"
    && typeof value["taskId"] === "string" && CANONICAL_UUID.test(value["taskId"])
    && typeof value["taskRunId"] === "string" && CANONICAL_UUID.test(value["taskRunId"])
    && typeof value["inputObjectId"] === "string" && DEFINITION_OBJECT.test(value["inputObjectId"])
    && typeof value["resultObjectId"] === "string" && RESULT_OBJECT.test(value["resultObjectId"])
    && typeof value["authorizationRequestId"] === "string"
    && PORTABLE_ID.test(value["authorizationRequestId"])
    && encoder.encode(value["authorizationRequestId"]).length <= MAX_IDENTIFIER_BYTES
    && Number.isSafeInteger(value["policyRevision"])
    && (value["policyRevision"] as number) >= 1
    && Number.isSafeInteger(segment) && (segment as number) >= 1
    && (resumed ? hasAcceptance !== hasContinuation : !hasAcceptance && !hasContinuation)
    && (!hasAcceptance || typeof value["resumeAcceptanceId"] === "string"
      && PORTABLE_ID.test(value["resumeAcceptanceId"])
      && encoder.encode(value["resumeAcceptanceId"]).length <= MAX_IDENTIFIER_BYTES)
    && (!hasContinuation
      || typeof value["resumeContinuationFingerprint"] === "string"
      && CONTINUATION.test(value["resumeContinuationFingerprint"]));
}

// This cleanup grants no access to content. The immutable mapped ledger and its
// schema-checked historical metadata identify the input whose effects are now
// unknown; signature verification remains with the execution/read owners.
export function exactDefinitionFamily(row: Readonly<{
  cryptoObjectId: string; contentRevision: number; representation: string;
  historicalRepair: unknown;
}>): boolean {
  if (/^task-definition:v1:[0-9a-f]{64}$/u.test(row.cryptoObjectId)) {
    return row.historicalRepair == null
      || record(row.historicalRepair) && row.historicalRepair["version"] === 1;
  }
  const p = row.historicalRepair;
  return /^task-historical:v1:[0-9a-f]{64}$/u.test(row.cryptoObjectId)
    && row.contentRevision === 1 && row.representation === "dual"
    && record(p) && p["version"] === 2 && p["sourceRevision"] === 0
    && Object.keys(p).sort().join(",") === "claimId,genesisManifestHash,publisherDeviceId,signedRequestDigest,sourceDigest,sourcePayloadHash,sourceRevision,version"
    && typeof p["claimId"] === "string" && CANONICAL_UUID.test(p["claimId"])
    && typeof p["publisherDeviceId"] === "string" && PORTABLE_ID.test(p["publisherDeviceId"])
    && encoder.encode(p["publisherDeviceId"]).length <= MAX_IDENTIFIER_BYTES
    && ["genesisManifestHash", "signedRequestDigest", "sourceDigest", "sourcePayloadHash"]
      .every(key => typeof p[key] === "string" && /^[0-9a-f]{64}$/u.test(p[key]));
}

function exactReceipt(value: unknown, expected: AbandonmentReceipt): boolean {
  return record(value)
    && Object.keys(value).sort().join(",")
      === "authorizationRequestId,executionSegment,parentTaskTerminalized,reason,recipientGeneration,requestRevision,settledAt,taskId,taskRunId,version"
    && Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

function validSettlement(
  value: ProtectedTaskRunningAuthorizationSettlement | null,
): value is ProtectedTaskRunningAuthorizationSettlement {
  return value !== null
    && Number.isSafeInteger(value.requestRevision) && value.requestRevision >= 1
    && Number.isSafeInteger(value.recipientGeneration) && value.recipientGeneration >= 0
    && finiteDate(value.settledAt);
}

/** Bound one restart pass to rows that existed when the pass began. */
export async function getProtectedTaskRunningRecoveryBoundary(
  db: DirectDatabase,
): Promise<ProtectedTaskRunningRecoveryCursor | null> {
  const [row] = await db.select({
    startedAt: taskRuns.startedAt,
    taskRunId: taskRuns.id,
  }).from(taskRuns).innerJoin(tasks, eq(tasks.id, taskRuns.taskId)).where(and(
    eq(taskRuns.status, "running"),
    or(eq(tasks.contentRepresentation, "dual"), eq(tasks.contentRepresentation, "protected")),
  )).orderBy(desc(taskRuns.startedAt), desc(taskRuns.id)).limit(1);
  return row === undefined ? null : Object.freeze({
    startedAt: new Date(row.startedAt.getTime()), taskRunId: row.taskRunId,
  });
}

/** Discover content-free coordinates only; settlement re-proves every row. */
export async function listProtectedTaskRunningRecoveryCandidates(
  db: DirectDatabase,
  input: Readonly<{
    limit: number;
    through: ProtectedTaskRunningRecoveryCursor;
    after?: ProtectedTaskRunningRecoveryCursor;
  }>,
): Promise<ProtectedTaskRunningRecoveryPage> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1
    || !finiteDate(input.through.startedAt)
    || !CANONICAL_UUID.test(input.through.taskRunId)
    || input.after !== undefined && (!finiteDate(input.after.startedAt)
      || !CANONICAL_UUID.test(input.after.taskRunId))) {
    throw new TypeError("Protected Task running recovery page is invalid");
  }
  const rows = await db.select({
    taskId: tasks.id,
    taskRunId: taskRuns.id,
    startedAt: taskRuns.startedAt,
  }).from(tasks).innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id)).where(and(
    eq(taskRuns.status, "running"),
    or(eq(tasks.contentRepresentation, "dual"), eq(tasks.contentRepresentation, "protected")),
    or(
      lt(taskRuns.startedAt, input.through.startedAt),
      and(eq(taskRuns.startedAt, input.through.startedAt), lte(taskRuns.id, input.through.taskRunId)),
    ),
    input.after === undefined ? undefined : or(
      gt(taskRuns.startedAt, input.after.startedAt),
      and(eq(taskRuns.startedAt, input.after.startedAt), gt(taskRuns.id, input.after.taskRunId)),
    ),
  )).orderBy(asc(taskRuns.startedAt), asc(taskRuns.id)).limit(input.limit);
  const candidates = rows.map(row => Object.freeze({
    taskId: row.taskId,
    taskRunId: row.taskRunId,
    startedAt: new Date(row.startedAt.getTime()),
  }));
  const last = candidates.at(-1);
  return Object.freeze({
    candidates: Object.freeze(candidates),
    next: rows.length < input.limit || last === undefined ? null : Object.freeze({
      startedAt: new Date(last.startedAt.getTime()), taskRunId: last.taskRunId,
    }),
  });
}

/**
 * Terminalize a protected run only after an exact durable authorization proves
 * that its provider outcome cannot safely be replayed.
 */
export async function settleAbandonedProtectedTaskRun(
  db: DirectDatabase,
  input: Readonly<{ taskId: string; taskRunId: string }>,
  settleAuthorization: (
    proof: ProtectedTaskRunningAuthorizationProof,
  ) => Promise<ProtectedTaskRunningAuthorizationSettlement | null>,
): Promise<ProtectedTaskRunningRecoveryResult> {
  if (!CANONICAL_UUID.test(input.taskId) || !CANONICAL_UUID.test(input.taskRunId)
    || typeof settleAuthorization !== "function") {
    throw new TypeError("Protected Task running recovery input is invalid");
  }
  return db.transaction(async tx => {
    const [policy] = await tx.select({
      mode: encryptionTransitionPolicy.mode,
      revision: encryptionTransitionPolicy.revision,
    }).from(encryptionTransitionPolicy).where(eq(encryptionTransitionPolicy.id, "server"))
      .limit(1).for("share");
    const [task] = await tx.select({
      id: tasks.id,
      requestorId: tasks.requestorId,
      scheduleKind: tasks.scheduleKind,
      status: tasks.status,
      pauseRequestId: tasks.pauseRequestId,
      contentRepresentation: tasks.contentRepresentation,
      contentNamespaceId: tasks.contentNamespaceId,
      contentRevision: tasks.contentRevision,
      cryptoObjectId: tasks.cryptoObjectId,
      cryptoAccessRevision: tasks.cryptoAccessRevision,
      cryptoRequiredNamespaceFingerprint: tasks.cryptoRequiredNamespaceFingerprint,
      cryptoMappingState: tasks.cryptoMappingState,
      promptIsEmpty: sql<boolean>`${tasks.prompt} = ''`,
      expectedOutputIsNull: isNull(tasks.expectedOutput).mapWith(Boolean),
      lastErrorIsNull: isNull(tasks.lastError).mapWith(Boolean),
    }).from(tasks).where(eq(tasks.id, input.taskId)).limit(1).for("update");
    if (!task || task.contentRepresentation === "ordinary") return { status: "inactive" };
    const [run] = await tx.select({
      id: taskRuns.id,
      taskId: taskRuns.taskId,
      jobId: taskRuns.jobId,
      status: taskRuns.status,
      startedAt: taskRuns.startedAt,
      completedAt: taskRuns.completedAt,
      resultTextIsNull: isNull(taskRuns.resultText).mapWith(Boolean),
      lastErrorIsNull: isNull(taskRuns.lastError).mapWith(Boolean),
      resultRepresentation: taskRuns.resultRepresentation,
      resultContentNamespaceId: taskRuns.resultContentNamespaceId,
      resultRevision: taskRuns.resultRevision,
      resultCryptoObjectId: taskRuns.resultCryptoObjectId,
      resultCryptoAccessRevision: taskRuns.resultCryptoAccessRevision,
      resultCryptoRequiredNamespaceFingerprint: taskRuns.resultCryptoRequiredNamespaceFingerprint,
      resultCryptoMappingState: taskRuns.resultCryptoMappingState,
    }).from(taskRuns).where(and(eq(taskRuns.id, input.taskRunId), eq(taskRuns.taskId, input.taskId)))
      .limit(1).for("update");
    if (!run || run.jobId === null) return { status: "inactive" };
    const [job] = await tx.select({
      id: jobs.id,
      ownerId: jobs.ownerId,
      requestorId: jobs.requestorId,
      laneKey: jobs.laneKey,
      type: jobs.type,
      status: jobs.status,
      input: jobs.input,
      resultIsNull: isNull(jobs.result).mapWith(Boolean),
      messageIsNull: isNull(jobs.message).mapWith(Boolean),
      startedAt: jobs.startedAt,
      completedAt: jobs.completedAt,
      metadata: jobs.metadata,
    }).from(jobs).where(eq(jobs.id, run.jobId)).limit(1).for("update");
    if (!job || !exactReference(job.input)) return { status: "inactive" };
    const reference = job.input;
    const definitions = await tx.select({
      taskId: taskDefinitionCryptoRevisions.taskId,
      contentNamespaceId: taskDefinitionCryptoRevisions.contentNamespaceId,
      contentRevision: taskDefinitionCryptoRevisions.contentRevision,
      cryptoObjectId: taskDefinitionCryptoRevisions.cryptoObjectId,
      representation: taskDefinitionCryptoRevisions.representation,
      payloadVersion: taskDefinitionCryptoRevisions.payloadVersion,
      cryptoAccessRevision: taskDefinitionCryptoRevisions.cryptoAccessRevision,
      requiredNamespaceFingerprint: taskDefinitionCryptoRevisions.requiredNamespaceFingerprint,
      anchorNamespaceId: taskDefinitionCryptoRevisions.anchorNamespaceId,
      completion: taskDefinitionCryptoRevisions.completion,
      disposition: taskDefinitionCryptoRevisions.disposition,
      failureCode: taskDefinitionCryptoRevisions.failureCode,
      historicalRepair: taskDefinitionCryptoRevisions.historicalRepair,
    }).from(taskDefinitionCryptoRevisions).where(and(
      eq(taskDefinitionCryptoRevisions.taskId, task.id),
      or(
        eq(taskDefinitionCryptoRevisions.contentRevision, task.contentRevision),
        eq(taskDefinitionCryptoRevisions.cryptoObjectId, reference.inputObjectId),
      ),
    )).orderBy(asc(taskDefinitionCryptoRevisions.contentRevision)).for("share");
    const definition = definitions.find(row => row.contentRevision === task.contentRevision);
    const executionDefinition = definitions.find(row =>
      row.cryptoObjectId === reference.inputObjectId);
    if (!definition || !executionDefinition) return { status: "inactive" };
    const reservations = await tx.select({ sequence: taskRunResultCryptoRevisions.sequence })
      .from(taskRunResultCryptoRevisions).where(and(
        eq(taskRunResultCryptoRevisions.taskId, task.id),
        eq(taskRunResultCryptoRevisions.taskRunId, run.id),
        eq(taskRunResultCryptoRevisions.resultRevision, 1),
    )).limit(1).for("share");
    if (reservations.length > 0) return { status: "reserved" };
    const [binding] = await tx.select().from(protectedTaskRunOutputBindings)
      .where(eq(protectedTaskRunOutputBindings.taskRunId, run.id)).limit(1).for("update");
    if (!binding) return { status: "inactive" };

    const [newest] = await tx.select({ id: taskRuns.id }).from(taskRuns)
      .where(eq(taskRuns.taskId, task.id))
      .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id)).limit(1);
    const newestRun = newest?.id === run.id;
    const metadata = record(job.metadata) ? job.metadata : {};
    const existingReceipt = metadata[PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY];
    const common = reference.taskId === task.id && reference.taskRunId === run.id
      && reference.resultObjectId === protectedTaskRunResultObjectId(task.id, run.id)
      && job.id === run.jobId && job.ownerId === task.requestorId
      && job.requestorId === task.requestorId && job.laneKey === `task:${task.id}`
      && job.type === "foreground" && finiteDate(job.startedAt)
      && job.resultIsNull && job.messageIsNull
      && metadata[PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY] === undefined
      && (task.scheduleKind === "cron" ? task.status === "pending"
        : task.status === "running" || task.status === "errored" && run.status === "errored")
      && task.contentNamespaceId !== null && task.cryptoMappingState === "verified"
      && (task.contentRepresentation === "dual"
        || task.promptIsEmpty && task.expectedOutputIsNull && task.lastErrorIsNull)
      && definition.taskId === task.id
      && definition.contentNamespaceId === task.contentNamespaceId
      && definition.contentRevision === task.contentRevision
      && definition.cryptoObjectId === task.cryptoObjectId
      && definition.representation === task.contentRepresentation
      && definition.payloadVersion === 1 && definition.cryptoAccessRevision === 0
      && definition.anchorNamespaceId === task.contentNamespaceId
      && definition.requiredNamespaceFingerprint instanceof Uint8Array
      && definition.requiredNamespaceFingerprint.length === 32
      && Number.isSafeInteger(task.cryptoAccessRevision) && task.cryptoAccessRevision >= 0
      && exactDefinitionFamily(definition)
      && sameBytes(task.cryptoRequiredNamespaceFingerprint,
        definition.requiredNamespaceFingerprint)
      && definition.completion === "complete" && definition.disposition === "mapped"
      && definition.failureCode === null
      // Cron definition edits do not replace a running occurrence's input.
      // Prove that retained input independently of the current Task mapping.
      && executionDefinition.taskId === task.id
      && executionDefinition.contentNamespaceId === task.contentNamespaceId
      && executionDefinition.contentRevision >= 1
      && executionDefinition.contentRevision <= task.contentRevision
      && executionDefinition.cryptoObjectId === reference.inputObjectId
      && exactDefinitionFamily(executionDefinition)
      && executionDefinition.representation === task.contentRepresentation
      && executionDefinition.payloadVersion === 1
      && executionDefinition.cryptoAccessRevision === 0
      && executionDefinition.anchorNamespaceId === task.contentNamespaceId
      && executionDefinition.requiredNamespaceFingerprint instanceof Uint8Array
      && executionDefinition.requiredNamespaceFingerprint.length === 32
      && executionDefinition.completion === "complete"
      && executionDefinition.disposition === "mapped"
      && executionDefinition.failureCode === null
      && binding.taskRunId === run.id
      && binding.bindingId === protectedTaskRunOutputBindingId(run.id)
      && binding.resultRevision === 1
      && binding.resultOperationId === protectedTaskRunResultOperationId(run.id)
      && binding.resultObjectId === reference.resultObjectId
      && exactDeliveryBinding(binding, run.id)
      && binding.acceptedPolicyRevision <= reference.policyRevision
      && finiteDate(binding.acceptedAt)
      && binding.resultTerminalAt === null && binding.resultAttachedAt === null
      && binding.messageId === null && binding.messagePublishedAt === null
      && binding.wakeJobId === null && binding.wakeScheduledAt === null
      && binding.completedAt === null
      && run.resultTextIsNull && run.lastErrorIsNull
      && run.resultRepresentation === "ordinary"
      && run.resultContentNamespaceId === null && run.resultRevision === 0
      && run.resultCryptoObjectId === null && run.resultCryptoAccessRevision === 0
      && run.resultCryptoRequiredNamespaceFingerprint === null
      && run.resultCryptoMappingState === "unmapped";
    if (!common) return { status: "inactive" };

    if (run.status === "errored" && finiteDate(run.completedAt) && record(existingReceipt)) {
      const replay = existingReceipt;
      const settledAt = new Date(String(replay["settledAt"]));
      if (!finiteDate(settledAt)) return { status: "inactive" };
      const expected: AbandonmentReceipt = {
        version: 1, taskId: task.id, taskRunId: run.id,
        authorizationRequestId: reference.authorizationRequestId,
        requestRevision: Number(replay["requestRevision"]),
        recipientGeneration: Number(replay["recipientGeneration"]),
        executionSegment: reference.executionSegment,
        reason: "provider_outcome_unknown",
        settledAt: settledAt.toISOString(),
        parentTaskTerminalized: replay["parentTaskTerminalized"] === true,
      };
      if (run.completedAt.getTime() !== settledAt.getTime()
        || expected.parentTaskTerminalized && task.status !== "errored"
        || task.scheduleKind === "cron" && expected.parentTaskTerminalized
        || !exactReceipt(existingReceipt, expected)) return { status: "inactive" };
      return Object.freeze({ status: "exact_replay", cleanup: Object.freeze({
        requestId: reference.authorizationRequestId,
        generation: expected.recipientGeneration,
      }) });
    }
    if (run.status !== "running" || run.completedAt !== null || existingReceipt !== undefined
      || !(job.status === "running" && job.completedAt === null
        || ["failed", "timed_out", "cancelled"].includes(job.status)
          && finiteDate(job.completedAt))) return { status: "inactive" };
    if (!policy || !protectedTaskDefinitionSupportsPolicy(task.contentRepresentation, policy.mode)
      || policy.revision < reference.policyRevision) return { status: "policy_wait" };

    const contentNamespaceId = task.contentNamespaceId;
    if (contentNamespaceId === null) return { status: "inactive" };
    const proof: ProtectedTaskRunningAuthorizationProof = Object.freeze({
      taskId: task.id, taskRunId: run.id, jobId: job.id,
      jobStatus: job.status as ProtectedTaskRunningAuthorizationProof["jobStatus"],
      authorizationRequestId: reference.authorizationRequestId,
      contentNamespaceId,
      acceptedPolicyRevision: reference.policyRevision,
      executionSegment: reference.executionSegment,
    });
    const settlement = await settleAuthorization(proof);
    if (!validSettlement(settlement)) return { status: "inactive" };
    const receipt: AbandonmentReceipt = Object.freeze({
      version: 1, taskId: task.id, taskRunId: run.id,
      authorizationRequestId: reference.authorizationRequestId,
      requestRevision: settlement.requestRevision,
      recipientGeneration: settlement.recipientGeneration,
      executionSegment: reference.executionSegment,
      reason: "provider_outcome_unknown",
      settledAt: settlement.settledAt.toISOString(),
      parentTaskTerminalized: newestRun && task.scheduleKind !== "cron" && task.pauseRequestId == null,
    });
    const [updatedJob] = await tx.update(jobs).set({
      ...(job.status === "running" ? { status: "failed", completedAt: settlement.settledAt } : {}),
      metadata: { ...metadata, [PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY]: receipt },
    }).where(and(eq(jobs.id, job.id), eq(jobs.status, job.status),
      job.completedAt === null ? isNull(jobs.completedAt) : eq(jobs.completedAt, job.completedAt)))
      .returning({ id: jobs.id });
    if (!updatedJob) throw new Error("Protected Task abandonment lost its Job");
    const [updatedRun] = await tx.update(taskRuns).set({
      status: "errored", completedAt: settlement.settledAt,
    }).where(and(eq(taskRuns.id, run.id), eq(taskRuns.taskId, task.id),
      eq(taskRuns.jobId, job.id), eq(taskRuns.status, "running"),
      isNull(taskRuns.completedAt), isNull(taskRuns.resultText), isNull(taskRuns.lastError)))
      .returning({ id: taskRuns.id });
    if (!updatedRun) throw new Error("Protected Task abandonment lost its TaskRun");
    if (receipt.parentTaskTerminalized) {
      const [updatedTask] = await tx.update(tasks).set({
        status: "errored", updatedAt: settlement.settledAt,
      }).where(and(eq(tasks.id, task.id), eq(tasks.status, "running"), isNull(tasks.lastError)))
        .returning({ id: tasks.id });
      if (!updatedTask) throw new Error("Protected Task abandonment lost its Task");
    }
    return Object.freeze({ status: "settled", cleanup: Object.freeze({
      requestId: reference.authorizationRequestId,
      generation: settlement.recipientGeneration,
    }) });
  });
}
