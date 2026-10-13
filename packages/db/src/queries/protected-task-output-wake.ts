import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
} from "drizzle-orm";

import type { DirectDatabase } from "../config/direct-database";
import { encryptionTransitionPolicy } from "../schema/encryption-transition";
import { jobs } from "../schema/jobs";
import {
  protectedTaskRunOutputBindings,
  type ProtectedTaskRunOutputBinding,
} from "../schema/protected-task-run-output-bindings";
import { roomMembers, rooms } from "../schema/rooms";
import { sessions } from "../schema/sessions";
import { taskRuns } from "../schema/task-runs";
import { tasks } from "../schema/tasks";
import { actors } from "../schema/trust";
import {
  protectedTaskRunCancelledResultObjectId,
  protectedTaskRunCancelledResultOperationId,
  protectedTaskRunOutputBindingId,
  protectedTaskRunResultObjectId,
  protectedTaskRunResultOperationId,
  protectedTaskRunWakeJobId,
  protectedTaskRunWakeOperationId,
} from "./protected-task-output-binding-identities";
import { PROTECTED_TASK_CANCELLED_RESULT } from
  "./protected-task-cancellation-output";
import type { ProtectedTaskRunWakeReferenceV1 } from
  "./protected-task-output-bindings";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

class InsertedWakeConflict extends Error {}

export type ProtectedTaskWakeScheduling = Readonly<{
  taskId: string;
  taskRunId: string;
  jobId: string;
  ownerId: string;
  requestorId: string;
  agentId: string;
  roomId: string;
  namespaceId: string;
  sessionId: string;
  sessionOwnerId: string;
  graphThreadId: string;
  laneKey: string;
  reference: ProtectedTaskRunWakeReferenceV1;
  jobState: "queued" | "running" | "completed" | "failed";
}>;

export type ProtectedTaskWakeLifecycleCoordinates = Readonly<{
  taskId: string;
  taskRunId: string;
  jobId: string;
}>;

export type ProtectedTaskWakeAuthorityCallback = (
  transaction: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0],
  scheduling: ProtectedTaskWakeScheduling,
) => Promise<boolean>;

export type ClaimProtectedTaskWakeJobResult =
  | Readonly<{
      status: "started";
      scheduling: ProtectedTaskWakeScheduling;
    }>
  | Readonly<{
      status: "rejected";
      reason:
        | "authority_changed"
        | "claim_rejected"
        | "conflict"
        | "not_found"
        | "not_ready"
        | "uncertain_execution";
    }>;

export type SettleProtectedTaskWakeJobResult =
  | Readonly<{
      status: "settled" | "exact_replay";
      jobStatus: "completed" | "failed";
      scheduling: ProtectedTaskWakeScheduling;
    }>
  | Readonly<{
      status: "rejected";
      reason:
        | "authority_changed"
        | "claim_rejected"
        | "conflict"
        | "not_found"
        | "not_ready";
    }>;

export type InsertOrAdoptProtectedTaskWakeJobResult =
  | Readonly<{
      status: "scheduled" | "exact_replay";
      scheduling: ProtectedTaskWakeScheduling;
      binding: ProtectedTaskRunOutputBinding;
    }>
  | Readonly<{
      status: "rejected";
      reason:
        | "authority_changed"
        | "conflict"
        | "not_found"
        | "not_ready";
    }>;

export type ProtectedTaskWakeDiscoveryCursor = Readonly<{
  throughTime: Date;
  createdAt: Date;
  jobId: string;
}>;

export type ProtectedTaskWakeExecutionCandidate = Readonly<{
  taskId: string;
  taskRunId: string;
  jobId: string;
  state: "awaiting_authority" | "uncertain_execution";
}>;

export type ProtectedTaskWakeDiscoveryPage = Readonly<{
  candidates: readonly ProtectedTaskWakeExecutionCandidate[];
  next: ProtectedTaskWakeDiscoveryCursor | null;
}>;

function rejected(
  reason: Extract<InsertOrAdoptProtectedTaskWakeJobResult, {
    status: "rejected";
  }>["reason"],
): InsertOrAdoptProtectedTaskWakeJobResult {
  return Object.freeze({ status: "rejected" as const, reason });
}

function wakeReference(
  taskId: string,
  binding: ProtectedTaskRunOutputBinding,
): ProtectedTaskRunWakeReferenceV1 | null {
  if (binding.wakeOperationId === null) return null;
  return Object.freeze({
    kind: "protected_task_delivery_v1" as const,
    bindingId: binding.bindingId,
    taskId,
    taskRunId: binding.taskRunId,
    resultObjectId: binding.resultObjectId,
    wakeOperationId: binding.wakeOperationId,
  });
}

function exactReference(
  value: unknown,
  expected: ProtectedTaskRunWakeReferenceV1,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",")
      === "bindingId,kind,resultObjectId,taskId,taskRunId,wakeOperationId"
    && record["kind"] === expected.kind
    && record["bindingId"] === expected.bindingId
    && record["taskId"] === expected.taskId
    && record["taskRunId"] === expected.taskRunId
    && record["resultObjectId"] === expected.resultObjectId
    && record["wakeOperationId"] === expected.wakeOperationId;
}

type WakeTaskMetadata = Readonly<{
  id: string;
  ownerId: string;
  requestorId: string;
  agentId: string;
  callingRoomId: string | null;
  resultDelivery: string;
  status: string;
  cancelledAt: Date | null;
  contentRepresentation: string;
  contentNamespaceId: string | null;
  contentRevision: number;
  cryptoObjectId: string | null;
  cryptoAccessRevision: number;
  cryptoRequiredNamespaceFingerprint: Uint8Array | null;
  cryptoMappingState: string;
  promptIsEmpty: boolean;
  expectedOutputIsNull: boolean;
  lastErrorIsNull: boolean;
}>;

type WakeRunMetadata = Readonly<{
  id: string;
  taskId: string;
  status: string;
  completedAt: Date | null;
  resultRepresentation: string;
  resultRevision: number;
  resultContentNamespaceId: string | null;
  resultCryptoObjectId: string | null;
  resultCryptoAccessRevision: number;
  resultCryptoRequiredNamespaceFingerprint: Uint8Array | null;
  resultCryptoMappingState: string;
  resultTextIsNull: boolean;
  resultTextIsCancelled: boolean;
  lastErrorIsNull: boolean;
}>;

type WakePolicyMetadata = Readonly<{ mode: string; revision: number }>;
type WakeRoomMetadata = Readonly<{
  id: string;
  ownerId: string;
  namespaceId: string;
  graphThreadId: string;
  archivedAt: Date | null;
}>;
type WakeMemberMetadata = Readonly<{
  kind: string;
  ownerId: string;
  agentId: string | null;
}>;
type WakeSessionMetadata = Readonly<{
  id: string;
  ownerId: string;
  agentId: string | null;
  roomId: string | null;
  threadId: string;
  personaId: string;
}>;
type WakeJobMetadata = Readonly<{
  id: string;
  ownerId: string;
  requestorId: string;
  laneKey: string | null;
  roomId: string | null;
  type: string;
  status: string;
  input: Record<string, unknown> | null;
  resultIsNull: boolean;
  messageIsNull: boolean;
  metadataIsEmpty: boolean;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}>;

type WakeClosedMetadata = Readonly<{
  task: WakeTaskMetadata;
  run: WakeRunMetadata;
  binding: ProtectedTaskRunOutputBinding;
  policy: WakePolicyMetadata;
  room: WakeRoomMetadata;
  members: readonly WakeMemberMetadata[];
  session: WakeSessionMetadata;
  reference: ProtectedTaskRunWakeReferenceV1;
  graphThreadId: string;
}>;

type WakeMetadataRejection = Readonly<{
  status: "rejected";
  reason: "authority_changed" | "conflict" | "not_found" | "not_ready";
}>;

function validateWakeTerminalMetadata(input: Readonly<{
  task: WakeTaskMetadata;
  run: WakeRunMetadata;
  binding: ProtectedTaskRunOutputBinding;
  policy: WakePolicyMetadata;
}>): WakeMetadataRejection | null {
  const { task, run, binding, policy } = input;
  const expectedMode = task.contentRepresentation === "dual"
    ? "shadow_encryption"
    : task.contentRepresentation === "protected"
      ? "encrypted_only"
      : null;
  if (expectedMode === null || policy.mode !== expectedMode
    || policy.revision < binding.acceptedPolicyRevision
    || task.ownerId !== task.requestorId
    || task.cryptoMappingState !== "verified"
    || task.contentNamespaceId === null
    || task.contentRevision < 1
    || task.cryptoObjectId === null
    || task.cryptoAccessRevision < 0
    || task.cryptoRequiredNamespaceFingerprint === null
    || task.cryptoRequiredNamespaceFingerprint.length !== 32
    || task.contentRepresentation === "protected"
      && (!task.promptIsEmpty || !task.expectedOutputIsNull || !task.lastErrorIsNull)) {
    return Object.freeze({ status: "rejected", reason: "authority_changed" });
  }
  const exactDestination = binding.deliveryMode === "wake"
      || binding.deliveryMode === "raw_and_wake"
    ? task.callingRoomId !== null
      && task.callingRoomId === binding.destinationRoomId
      && task.resultDelivery === binding.deliveryMode
      && binding.destinationNamespaceId !== null
    : false;
  const exactNormal = (run.status === "completed" || run.status === "errored")
    && run.resultRevision === 1
    && binding.resultRevision === 1
    && binding.resultObjectId === protectedTaskRunResultObjectId(task.id, run.id)
    && binding.resultOperationId === protectedTaskRunResultOperationId(run.id)
    && run.resultCryptoObjectId === binding.resultObjectId;
  const exactCancelled = task.status === "cancelled"
    && task.cancelledAt !== null
    && run.status === "cancelled"
    && run.completedAt?.getTime() === task.cancelledAt.getTime()
    && run.resultRevision === 2
    && binding.resultRevision === 2
    && binding.resultOperationId === protectedTaskRunCancelledResultOperationId(run.id)
    && binding.resultObjectId === protectedTaskRunCancelledResultObjectId(task.id, run.id)
    && run.resultCryptoObjectId === binding.resultObjectId
    && run.lastErrorIsNull
    && (run.resultRepresentation === "protected"
      ? run.resultTextIsNull
      : run.resultTextIsCancelled);
  if (!exactDestination
    || binding.bindingId !== protectedTaskRunOutputBindingId(run.id)
    || binding.wakeOperationId !== protectedTaskRunWakeOperationId(run.id)
    || run.resultRepresentation !== task.contentRepresentation
    || run.resultContentNamespaceId !== task.contentNamespaceId
    || run.completedAt === null
    || binding.resultTerminalAt?.getTime() !== run.completedAt.getTime()
    || run.resultCryptoMappingState !== "verified"
    || run.resultCryptoAccessRevision < 0
    || run.resultCryptoRequiredNamespaceFingerprint === null
    || run.resultCryptoRequiredNamespaceFingerprint.length !== 32
    || task.contentRepresentation === "protected"
      && (!run.resultTextIsNull || !run.lastErrorIsNull)
    || (!exactNormal && !exactCancelled)
    || binding.resultAttachedAt === null
    || binding.wakeOperationId === null
    || binding.destinationRoomId === null
    || binding.destinationNamespaceId === null
    || binding.deliveryMode === "raw_and_wake"
      && binding.messagePublishedAt === null) {
    return Object.freeze({ status: "rejected", reason: "not_ready" });
  }
  return null;
}

function validateWakeAudienceMetadata(input: Readonly<{
  task: WakeTaskMetadata;
  binding: ProtectedTaskRunOutputBinding;
  room: WakeRoomMetadata;
  members: readonly WakeMemberMetadata[];
  session: WakeSessionMetadata | undefined;
}>): Readonly<{ graphThreadId: string }> | null {
  const { task, binding, room, members, session } = input;
  if (room.namespaceId !== binding.destinationNamespaceId
    || room.archivedAt !== null) return null;
  const humans = members.filter(member => member.kind === "user");
  const agents = members.filter(member => member.kind === "agent");
  if (!humans.some(member => member.ownerId === task.requestorId)
    || !humans.some(member => member.ownerId === room.ownerId)
    || !agents.some(member => member.agentId === task.agentId)) return null;
  const graphThreadId = canonicalThreadId({
    roomId: room.id,
    roomGraphThreadId: room.graphThreadId,
    agentId: task.agentId,
    humanCount: humans.length,
    agentCount: agents.length,
    soleAgentId: agents[0]?.agentId ?? null,
  });
  if (!session || session.ownerId !== room.ownerId
    || session.agentId !== task.agentId || session.roomId !== room.id
    || session.threadId !== graphThreadId
    || session.personaId !== "owner") return null;
  return Object.freeze({ graphThreadId });
}

function exactWakeJobMetadata(input: Readonly<{
  task: WakeTaskMetadata;
  binding: ProtectedTaskRunOutputBinding;
  room: WakeRoomMetadata;
  reference: ProtectedTaskRunWakeReferenceV1;
  job: WakeJobMetadata;
}>): boolean {
  const { task, binding, room, reference, job } = input;
  return binding.wakeJobId === job.id
    && binding.wakeScheduledAt?.getTime() === job.createdAt.getTime()
    && binding.completedAt?.getTime() === job.createdAt.getTime()
    && job.id === protectedTaskRunWakeJobId(binding.taskRunId)
    && job.ownerId === task.ownerId
    && job.requestorId === task.requestorId
    && job.roomId === room.id
    && job.laneKey === `room:${room.id}`
    && job.type === "foreground"
    && job.resultIsNull
    && job.messageIsNull
    && job.metadataIsEmpty
    && exactReference(job.input, reference)
    && binding.resultAttachedAt !== null
    && job.createdAt.getTime() >= binding.resultAttachedAt.getTime()
    && (binding.messagePublishedAt === null
      || job.createdAt.getTime() >= binding.messagePublishedAt.getTime());
}

function canonicalThreadId(input: Readonly<{
  roomId: string;
  roomGraphThreadId: string;
  agentId: string;
  humanCount: number;
  agentCount: number;
  soleAgentId: string | null;
}>): string {
  return input.humanCount === 1
      && input.agentCount === 1
      && input.soleAgentId === input.agentId
    ? input.roomGraphThreadId
    : `room:${input.roomId}:bot:${input.agentId}`;
}

/**
 * Persist or adopt the one content-free foreground wake Job and its output
 * receipt atomically. This schedules durable intent only; it grants no crypto
 * authority and never starts model execution.
 */
export async function insertOrAdoptProtectedTaskWakeJob(
  db: DirectDatabase,
  input: Readonly<{ taskId: string; taskRunId: string }>,
): Promise<InsertOrAdoptProtectedTaskWakeJobResult> {
  if (!CANONICAL_UUID.test(input.taskId)
    || !CANONICAL_UUID.test(input.taskRunId)) {
    throw new TypeError("Protected Task wake coordinates are malformed");
  }
  try {
    return await db.transaction(async tx => {
    const [task] = await tx.select({
      id: tasks.id,
      ownerId: tasks.ownerId,
      requestorId: tasks.requestorId,
      agentId: tasks.agentId,
      callingRoomId: tasks.callingRoomId,
      resultDelivery: tasks.resultDelivery,
      status: tasks.status,
      cancelledAt: tasks.cancelledAt,
      contentRepresentation: tasks.contentRepresentation,
      contentNamespaceId: tasks.contentNamespaceId,
      contentRevision: tasks.contentRevision,
      cryptoObjectId: tasks.cryptoObjectId,
      cryptoAccessRevision: tasks.cryptoAccessRevision,
      cryptoRequiredNamespaceFingerprint:
        tasks.cryptoRequiredNamespaceFingerprint,
      cryptoMappingState: tasks.cryptoMappingState,
      promptIsEmpty: eq(tasks.prompt, "").mapWith(Boolean),
      expectedOutputIsNull: isNull(tasks.expectedOutput).mapWith(Boolean),
      lastErrorIsNull: isNull(tasks.lastError).mapWith(Boolean),
    }).from(tasks).where(eq(tasks.id, input.taskId)).limit(1).for("update");
    if (!task) return rejected("not_found");
    const [run] = await tx.select({
      id: taskRuns.id,
      taskId: taskRuns.taskId,
      status: taskRuns.status,
      completedAt: taskRuns.completedAt,
      resultRepresentation: taskRuns.resultRepresentation,
      resultRevision: taskRuns.resultRevision,
      resultContentNamespaceId: taskRuns.resultContentNamespaceId,
      resultCryptoObjectId: taskRuns.resultCryptoObjectId,
      resultCryptoAccessRevision: taskRuns.resultCryptoAccessRevision,
      resultCryptoRequiredNamespaceFingerprint:
        taskRuns.resultCryptoRequiredNamespaceFingerprint,
      resultCryptoMappingState: taskRuns.resultCryptoMappingState,
      resultTextIsNull: isNull(taskRuns.resultText).mapWith(Boolean),
      resultTextIsCancelled: eq(
        taskRuns.resultText,
        PROTECTED_TASK_CANCELLED_RESULT,
      ).mapWith(Boolean),
      lastErrorIsNull: isNull(taskRuns.lastError).mapWith(Boolean),
    }).from(taskRuns).where(and(
      eq(taskRuns.id, input.taskRunId),
      eq(taskRuns.taskId, input.taskId),
    )).limit(1).for("update");
    if (!run) return rejected("not_found");
    const [binding] = await tx.select().from(protectedTaskRunOutputBindings)
      .where(eq(protectedTaskRunOutputBindings.taskRunId, input.taskRunId))
      .limit(1).for("update");
    if (!binding) return rejected("not_found");

    const [policy] = await tx.select({
      mode: encryptionTransitionPolicy.mode,
      revision: encryptionTransitionPolicy.revision,
    }).from(encryptionTransitionPolicy)
      .where(eq(encryptionTransitionPolicy.id, "server"))
      .limit(1).for("share");
    if (!policy) return rejected("authority_changed");
    const terminalRejection = validateWakeTerminalMetadata({
      task,
      run,
      binding,
      policy,
    });
    if (terminalRejection !== null) return terminalRejection;
    const destinationRoomId = binding.destinationRoomId;
    const resultAttachedAt = binding.resultAttachedAt;
    if (destinationRoomId === null || resultAttachedAt === null) {
      return rejected("not_ready");
    }

    const [room] = await tx.select({
      id: rooms.id,
      ownerId: rooms.ownerId,
      namespaceId: rooms.namespaceId,
      graphThreadId: rooms.graphThreadId,
      archivedAt: rooms.archivedAt,
    }).from(rooms).where(eq(rooms.id, destinationRoomId))
      .limit(1).for("share");
    if (!room) return rejected("authority_changed");

    const members = await tx.select({
      kind: actors.kind,
      ownerId: actors.ownerId,
      agentId: actors.agentId,
    }).from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(eq(roomMembers.roomId, room.id)).for("share");
    const humans = members.filter(member => member.kind === "user");
    const agents = members.filter(member => member.kind === "agent");
    const graphThreadId = canonicalThreadId({
      roomId: room.id,
      roomGraphThreadId: room.graphThreadId,
      agentId: task.agentId,
      humanCount: humans.length,
      agentCount: agents.length,
      soleAgentId: agents[0]?.agentId ?? null,
    });
    const sessionRows = await tx.select({
      id: sessions.id,
      ownerId: sessions.ownerId,
      agentId: sessions.agentId,
      roomId: sessions.roomId,
      threadId: sessions.threadId,
      personaId: sessions.personaId,
    }).from(sessions).where(and(
      eq(sessions.ownerId, room.ownerId),
      eq(sessions.threadId, graphThreadId),
    )).limit(2).for("share");
    const session = sessionRows.length === 1 ? sessionRows[0] : undefined;
    const audience = validateWakeAudienceMetadata({
      task,
      binding,
      room,
      members,
      session,
    });
    if (audience === null || audience.graphThreadId !== graphThreadId
      || session === undefined) {
      return rejected("authority_changed");
    }

    const reference = wakeReference(task.id, binding);
    if (reference === null) return rejected("conflict");
    const jobId = protectedTaskRunWakeJobId(run.id);
    const hasReceipt = binding.wakeJobId !== null
      || binding.wakeScheduledAt !== null
      || binding.completedAt !== null;
    if (hasReceipt && (binding.wakeJobId !== jobId
      || binding.wakeScheduledAt === null || binding.completedAt === null)) {
      return rejected("conflict");
    }
    const inserted = hasReceipt ? [] : await tx.insert(jobs).values({
        id: jobId,
        ownerId: task.ownerId,
        requestorId: task.requestorId,
        laneKey: `room:${room.id}`,
        roomId: room.id,
        type: "foreground",
        status: "queued",
        input: reference,
        result: null,
        message: null,
        metadata: {},
      }).onConflictDoNothing({ target: jobs.id }).returning({ id: jobs.id });
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId))
      .limit(1).for("update");
    const validState = job?.status === "queued"
      ? job.startedAt === null && job.completedAt === null
      : job?.status === "running"
        ? job.startedAt !== null && job.completedAt === null
        : job?.status === "completed"
          ? job.startedAt !== null && job.completedAt !== null
          : false;
    if (!job || !validState || job.ownerId !== task.ownerId
      || job.requestorId !== task.requestorId
      || job.roomId !== room.id || job.laneKey !== `room:${room.id}`
      || job.type !== "foreground" || job.result !== null
      || job.message !== null || Object.keys(job.metadata).length !== 0
      || !exactReference(job.input, reference)
      || job.createdAt.getTime() < resultAttachedAt.getTime()
      || binding.messagePublishedAt !== null
        && job.createdAt.getTime() < binding.messagePublishedAt.getTime()) {
      if (inserted.length > 0) {
        throw new InsertedWakeConflict();
      }
      return rejected("conflict");
    }

    let nextBinding = binding;
    let status: "scheduled" | "exact_replay" = "exact_replay";
    if (binding.wakeJobId === null && binding.wakeScheduledAt === null
      && binding.completedAt === null) {
      const [updated] = await tx.update(protectedTaskRunOutputBindings).set({
        wakeJobId: job.id,
        wakeScheduledAt: job.createdAt,
        completedAt: job.createdAt,
      }).where(and(
        eq(protectedTaskRunOutputBindings.taskRunId, binding.taskRunId),
        isNull(protectedTaskRunOutputBindings.wakeJobId),
        isNull(protectedTaskRunOutputBindings.wakeScheduledAt),
        isNull(protectedTaskRunOutputBindings.completedAt),
      )).returning();
      if (!updated) throw new Error("Protected Task wake receipt lost its binding");
      nextBinding = updated;
      status = "scheduled";
    } else if (binding.wakeJobId !== job.id
      || binding.wakeScheduledAt?.getTime() !== job.createdAt.getTime()
      || binding.completedAt?.getTime() !== job.createdAt.getTime()) {
      return rejected("conflict");
    }

    return Object.freeze({ status, binding: nextBinding, scheduling: Object.freeze({
      taskId: task.id,
      taskRunId: run.id,
      jobId: job.id,
      ownerId: task.ownerId,
      requestorId: task.requestorId,
      agentId: task.agentId,
      roomId: room.id,
      namespaceId: room.namespaceId,
      sessionId: session.id,
      sessionOwnerId: session.ownerId,
      graphThreadId,
      laneKey: `room:${room.id}`,
      reference,
      jobState: job.status as "queued" | "running" | "completed",
    }) });
    });
  } catch (error) {
    if (error instanceof InsertedWakeConflict) return rejected("conflict");
    throw error;
  }
}

type WakeTransaction = Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];

function lifecycleRejected(
  reason: WakeMetadataRejection["reason"],
): WakeMetadataRejection {
  return Object.freeze({ status: "rejected" as const, reason });
}

async function loadProtectedTaskWakeClosedMetadata(
  tx: WakeTransaction,
  input: ProtectedTaskWakeLifecycleCoordinates,
): Promise<WakeClosedMetadata | WakeMetadataRejection> {
  const [task] = await tx.select({
    id: tasks.id,
    ownerId: tasks.ownerId,
    requestorId: tasks.requestorId,
    agentId: tasks.agentId,
    callingRoomId: tasks.callingRoomId,
    resultDelivery: tasks.resultDelivery,
    status: tasks.status,
    cancelledAt: tasks.cancelledAt,
    contentRepresentation: tasks.contentRepresentation,
    contentNamespaceId: tasks.contentNamespaceId,
    contentRevision: tasks.contentRevision,
    cryptoObjectId: tasks.cryptoObjectId,
    cryptoAccessRevision: tasks.cryptoAccessRevision,
    cryptoRequiredNamespaceFingerprint:
      tasks.cryptoRequiredNamespaceFingerprint,
    cryptoMappingState: tasks.cryptoMappingState,
    promptIsEmpty: eq(tasks.prompt, "").mapWith(Boolean),
    expectedOutputIsNull: isNull(tasks.expectedOutput).mapWith(Boolean),
    lastErrorIsNull: isNull(tasks.lastError).mapWith(Boolean),
  }).from(tasks).where(eq(tasks.id, input.taskId)).limit(1).for("update");
  if (!task) return lifecycleRejected("not_found");

  const [run] = await tx.select({
    id: taskRuns.id,
    taskId: taskRuns.taskId,
    status: taskRuns.status,
    completedAt: taskRuns.completedAt,
    resultRepresentation: taskRuns.resultRepresentation,
    resultRevision: taskRuns.resultRevision,
    resultContentNamespaceId: taskRuns.resultContentNamespaceId,
    resultCryptoObjectId: taskRuns.resultCryptoObjectId,
    resultCryptoAccessRevision: taskRuns.resultCryptoAccessRevision,
    resultCryptoRequiredNamespaceFingerprint:
      taskRuns.resultCryptoRequiredNamespaceFingerprint,
    resultCryptoMappingState: taskRuns.resultCryptoMappingState,
    resultTextIsNull: isNull(taskRuns.resultText).mapWith(Boolean),
    resultTextIsCancelled: eq(
      taskRuns.resultText,
      PROTECTED_TASK_CANCELLED_RESULT,
    ).mapWith(Boolean),
    lastErrorIsNull: isNull(taskRuns.lastError).mapWith(Boolean),
  }).from(taskRuns).where(and(
    eq(taskRuns.id, input.taskRunId),
    eq(taskRuns.taskId, input.taskId),
  )).limit(1).for("update");
  if (!run) return lifecycleRejected("not_found");

  const [binding] = await tx.select().from(protectedTaskRunOutputBindings)
    .where(eq(protectedTaskRunOutputBindings.taskRunId, input.taskRunId))
    .limit(1).for("update");
  if (!binding) return lifecycleRejected("not_found");

  const [policy] = await tx.select({
    mode: encryptionTransitionPolicy.mode,
    revision: encryptionTransitionPolicy.revision,
  }).from(encryptionTransitionPolicy)
    .where(eq(encryptionTransitionPolicy.id, "server"))
    .limit(1).for("share");
  if (!policy) return lifecycleRejected("authority_changed");
  const terminalRejection = validateWakeTerminalMetadata({
    task,
    run,
    binding,
    policy,
  });
  if (terminalRejection !== null) return terminalRejection;

  if (binding.destinationRoomId === null) {
    return lifecycleRejected("not_ready");
  }
  const [room] = await tx.select({
    id: rooms.id,
    ownerId: rooms.ownerId,
    namespaceId: rooms.namespaceId,
    graphThreadId: rooms.graphThreadId,
    archivedAt: rooms.archivedAt,
  }).from(rooms).where(eq(rooms.id, binding.destinationRoomId))
    .limit(1).for("share");
  if (!room) return lifecycleRejected("authority_changed");

  const members = await tx.select({
    kind: actors.kind,
    ownerId: actors.ownerId,
    agentId: actors.agentId,
  }).from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(eq(roomMembers.roomId, room.id)).for("share");
  const humans = members.filter(member => member.kind === "user");
  const agents = members.filter(member => member.kind === "agent");
  const graphThreadId = canonicalThreadId({
    roomId: room.id,
    roomGraphThreadId: room.graphThreadId,
    agentId: task.agentId,
    humanCount: humans.length,
    agentCount: agents.length,
    soleAgentId: agents[0]?.agentId ?? null,
  });
  const sessionRows = await tx.select({
    id: sessions.id,
    ownerId: sessions.ownerId,
    agentId: sessions.agentId,
    roomId: sessions.roomId,
    threadId: sessions.threadId,
    personaId: sessions.personaId,
  }).from(sessions).where(and(
    eq(sessions.ownerId, room.ownerId),
    eq(sessions.threadId, graphThreadId),
  )).limit(2).for("share");
  const audience = validateWakeAudienceMetadata({
    task,
    binding,
    room,
    members,
    session: sessionRows.length === 1 ? sessionRows[0] : undefined,
  });
  if (audience === null) return lifecycleRejected("authority_changed");

  const reference = wakeReference(task.id, binding);
  if (reference === null
    || input.jobId !== protectedTaskRunWakeJobId(run.id)
    || binding.wakeJobId !== input.jobId
    || binding.wakeScheduledAt === null
    || binding.completedAt === null) {
    return lifecycleRejected("conflict");
  }
  return Object.freeze({
    task,
    run,
    binding,
    policy,
    room,
    members: Object.freeze([...members]),
    session: sessionRows[0]!,
    reference,
    graphThreadId: audience.graphThreadId,
  });
}

async function loadProtectedTaskWakeJob(
  tx: WakeTransaction,
  input: ProtectedTaskWakeLifecycleCoordinates,
): Promise<WakeJobMetadata | undefined> {
  const rows = await tx.select({
    id: jobs.id,
    ownerId: jobs.ownerId,
    requestorId: jobs.requestorId,
    laneKey: jobs.laneKey,
    roomId: jobs.roomId,
    type: jobs.type,
    status: jobs.status,
    input: jobs.input,
    resultIsNull: isNull(jobs.result).mapWith(Boolean),
    messageIsNull: isNull(jobs.message).mapWith(Boolean),
    metadataIsEmpty: eq(jobs.metadata, {}).mapWith(Boolean),
    createdAt: jobs.createdAt,
    startedAt: jobs.startedAt,
    completedAt: jobs.completedAt,
  }).from(jobs).where(eq(jobs.id, input.jobId))
    .limit(1).for("update");
  return rows.length === 1 ? rows[0] : undefined;
}

function lifecycleScheduling(
  state: WakeClosedMetadata,
  job: WakeJobMetadata,
): ProtectedTaskWakeScheduling {
  return Object.freeze({
    taskId: state.task.id,
    taskRunId: state.run.id,
    jobId: job.id,
    ownerId: state.task.ownerId,
    requestorId: state.task.requestorId,
    agentId: state.task.agentId,
    roomId: state.room.id,
    namespaceId: state.room.namespaceId,
    sessionId: state.session.id,
    sessionOwnerId: state.session.ownerId,
    graphThreadId: state.graphThreadId,
    laneKey: `room:${state.room.id}`,
    reference: state.reference,
    jobState: job.status as ProtectedTaskWakeScheduling["jobState"],
  });
}

function validJobTimestamps(job: WakeJobMetadata): boolean {
  if (job.status === "queued") {
    return job.startedAt === null && job.completedAt === null;
  }
  if (job.status === "running") {
    return job.startedAt !== null && job.completedAt === null;
  }
  if (job.status === "completed" || job.status === "failed") {
    return job.startedAt !== null && job.completedAt !== null;
  }
  return false;
}

function malformedLifecycleCoordinates(
  input: ProtectedTaskWakeLifecycleCoordinates,
): boolean {
  return input === null || typeof input !== "object"
    || Object.keys(input).sort().join(",") !== "jobId,taskId,taskRunId"
    || !CANONICAL_UUID.test(input.taskId)
    || !CANONICAL_UUID.test(input.taskRunId)
    || !CANONICAL_UUID.test(input.jobId);
}

/** Read closed scheduling on the caller's canonical product transaction. */
export async function readProtectedTaskWakeScheduling(
  transaction: WakeTransaction,
  input: ProtectedTaskWakeLifecycleCoordinates,
): Promise<ProtectedTaskWakeScheduling | null> {
  if (malformedLifecycleCoordinates(input)) {
    throw new TypeError("Protected Task wake scheduling input is malformed");
  }
  const state = await loadProtectedTaskWakeClosedMetadata(transaction, input);
  if ("status" in state) return null;
  const job = await loadProtectedTaskWakeJob(transaction, input);
  if (job === undefined || !exactWakeJobMetadata({
    task: state.task, binding: state.binding, room: state.room,
    reference: state.reference, job,
  }) || !validJobTimestamps(job)) return null;
  return lifecycleScheduling(state, job);
}

/** Claim exactly one queued, already-scheduled protected wake Job. */
export async function claimProtectedTaskWakeJob(
  db: Pick<DirectDatabase, "transaction">,
  input: ProtectedTaskWakeLifecycleCoordinates,
  assertCurrentAuthority: ProtectedTaskWakeAuthorityCallback,
): Promise<ClaimProtectedTaskWakeJobResult> {
  if (malformedLifecycleCoordinates(input)
    || typeof assertCurrentAuthority !== "function") {
    throw new TypeError("Protected Task wake claim input is malformed");
  }
  return db.transaction(async tx => {
    const state = await loadProtectedTaskWakeClosedMetadata(tx, input);
    if ("status" in state) return state;
    const job = await loadProtectedTaskWakeJob(tx, input);
    if (job === undefined) return lifecycleRejected("not_found");
    if (!exactWakeJobMetadata({
      task: state.task,
      binding: state.binding,
      room: state.room,
      reference: state.reference,
      job,
    }) || !validJobTimestamps(job)) return lifecycleRejected("conflict");
    if (job.status === "running") {
      return Object.freeze({
        status: "rejected" as const,
        reason: "uncertain_execution" as const,
      });
    }
    if (job.status !== "queued") return lifecycleRejected("conflict");
    const scheduling = lifecycleScheduling(state, job);
    if (!await assertCurrentAuthority(tx, scheduling)) {
      return Object.freeze({
        status: "rejected" as const,
        reason: "claim_rejected" as const,
      });
    }
    const startedAt = new Date();
    const updated = await tx.update(jobs).set({
      status: "running",
      startedAt,
    }).where(and(
      eq(jobs.id, job.id),
      eq(jobs.ownerId, job.ownerId),
      eq(jobs.requestorId, job.requestorId),
      eq(jobs.roomId, state.room.id),
      eq(jobs.laneKey, `room:${state.room.id}`),
      eq(jobs.type, "foreground"),
      eq(jobs.status, "queued"),
      eq(jobs.input, { ...state.reference }),
      eq(jobs.metadata, {}),
      isNull(jobs.result),
      isNull(jobs.message),
      isNull(jobs.startedAt),
      isNull(jobs.completedAt),
    )).returning({
      id: jobs.id,
      status: jobs.status,
      startedAt: jobs.startedAt,
      completedAt: jobs.completedAt,
    });
    const claimed = updated[0];
    if (updated.length !== 1 || claimed?.id !== job.id
      || claimed.status !== "running" || claimed.startedAt === null
      || claimed.completedAt !== null) return lifecycleRejected("conflict");
    const runningJob = Object.freeze({
      ...job,
      status: "running",
      startedAt: claimed.startedAt,
      completedAt: null,
    });
    return Object.freeze({
      status: "started" as const,
      scheduling: lifecycleScheduling(state, runningJob),
    });
  });
}

/** Settle one exact running wake, or validate an exact terminal replay. */
export async function settleProtectedTaskWakeJob(
  db: Pick<DirectDatabase, "transaction">,
  input: ProtectedTaskWakeLifecycleCoordinates & Readonly<{
    requestedStatus: "completed" | "failed";
  }>,
  assertCurrentClaim: ProtectedTaskWakeAuthorityCallback,
): Promise<SettleProtectedTaskWakeJobResult> {
  const coordinates = {
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    jobId: input.jobId,
  };
  if (malformedLifecycleCoordinates(coordinates)
    || (input.requestedStatus !== "completed" && input.requestedStatus !== "failed")
    || Object.keys(input).sort().join(",")
      !== "jobId,requestedStatus,taskId,taskRunId"
    || typeof assertCurrentClaim !== "function") {
    throw new TypeError("Protected Task wake settlement input is malformed");
  }
  return db.transaction(async tx => {
    const state = await loadProtectedTaskWakeClosedMetadata(tx, coordinates);
    if ("status" in state) return state;
    const job = await loadProtectedTaskWakeJob(tx, coordinates);
    if (job === undefined) return lifecycleRejected("not_found");
    if (!exactWakeJobMetadata({
      task: state.task,
      binding: state.binding,
      room: state.room,
      reference: state.reference,
      job,
    }) || !validJobTimestamps(job)) return lifecycleRejected("conflict");
    if (job.status === "queued") return lifecycleRejected("not_ready");
    if (job.status !== "running"
      && job.status !== input.requestedStatus) return lifecycleRejected("conflict");
    const scheduling = lifecycleScheduling(state, job);
    if (!await assertCurrentClaim(tx, scheduling)) {
      return Object.freeze({
        status: "rejected" as const,
        reason: "claim_rejected" as const,
      });
    }
    if (job.status === input.requestedStatus) {
      return Object.freeze({
        status: "exact_replay" as const,
        jobStatus: input.requestedStatus,
        scheduling,
      });
    }
    const completedAt = new Date();
    const updated = await tx.update(jobs).set({
      status: input.requestedStatus,
      completedAt,
    }).where(and(
      eq(jobs.id, job.id),
      eq(jobs.ownerId, job.ownerId),
      eq(jobs.requestorId, job.requestorId),
      eq(jobs.roomId, state.room.id),
      eq(jobs.laneKey, `room:${state.room.id}`),
      eq(jobs.type, "foreground"),
      eq(jobs.status, "running"),
      eq(jobs.input, { ...state.reference }),
      eq(jobs.metadata, {}),
      isNull(jobs.result),
      isNull(jobs.message),
      isNotNull(jobs.startedAt),
      isNull(jobs.completedAt),
    )).returning({
      id: jobs.id,
      status: jobs.status,
      startedAt: jobs.startedAt,
      completedAt: jobs.completedAt,
    });
    const settled = updated[0];
    if (updated.length !== 1 || settled?.id !== job.id
      || settled.status !== input.requestedStatus
      || settled.startedAt === null || settled.completedAt === null) {
      return lifecycleRejected("conflict");
    }
    const terminalJob = Object.freeze({
      ...job,
      status: input.requestedStatus,
      completedAt: settled.completedAt,
    });
    return Object.freeze({
      status: "settled" as const,
      jobStatus: input.requestedStatus,
      scheduling: lifecycleScheduling(state, terminalJob),
    });
  });
}

/** Discover scheduled wakes without treating a crash-uncertain running Job as replayable. */
export async function listProtectedTaskWakeExecutionCandidates(
  db: DirectDatabase,
  input: Readonly<{
    limit: number;
    throughTime: Date;
    cursor?: ProtectedTaskWakeDiscoveryCursor;
  }>,
): Promise<ProtectedTaskWakeDiscoveryPage> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 0
    || !(input.throughTime instanceof Date)
    || !Number.isFinite(input.throughTime.getTime())) {
    throw new TypeError("Protected Task wake discovery page is malformed");
  }
  if (input.cursor && (!(input.cursor.throughTime instanceof Date)
    || input.cursor.throughTime.getTime() !== input.throughTime.getTime()
    || !(input.cursor.createdAt instanceof Date)
    || !Number.isFinite(input.cursor.createdAt.getTime())
    || input.cursor.createdAt.getTime() > input.throughTime.getTime()
    || !CANONICAL_UUID.test(input.cursor.jobId))) {
    throw new TypeError("Protected Task wake discovery cursor is malformed");
  }
  if (input.limit === 0) {
    return Object.freeze({ candidates: Object.freeze([]), next: null });
  }
  const rows = await db.select({
    taskId: tasks.id,
    taskRunId: taskRuns.id,
    taskOwnerId: tasks.ownerId,
    taskRequestorId: tasks.requestorId,
    bindingId: protectedTaskRunOutputBindings.bindingId,
    resultObjectId: protectedTaskRunOutputBindings.resultObjectId,
    wakeOperationId: protectedTaskRunOutputBindings.wakeOperationId,
    wakeJobId: protectedTaskRunOutputBindings.wakeJobId,
    wakeScheduledAt: protectedTaskRunOutputBindings.wakeScheduledAt,
    bindingCompletedAt: protectedTaskRunOutputBindings.completedAt,
    destinationRoomId: protectedTaskRunOutputBindings.destinationRoomId,
    jobId: jobs.id,
    jobOwnerId: jobs.ownerId,
    jobRequestorId: jobs.requestorId,
    jobRoomId: jobs.roomId,
    jobLaneKey: jobs.laneKey,
    jobType: jobs.type,
    jobStatus: jobs.status,
    jobInput: jobs.input,
    jobResultIsNull: isNull(jobs.result),
    jobMessageIsNull: isNull(jobs.message),
    jobCreatedAt: jobs.createdAt,
    jobStartedAt: jobs.startedAt,
    jobCompletedAt: jobs.completedAt,
  }).from(protectedTaskRunOutputBindings)
    .innerJoin(taskRuns, eq(taskRuns.id, protectedTaskRunOutputBindings.taskRunId))
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .innerJoin(jobs, eq(jobs.id, protectedTaskRunOutputBindings.wakeJobId))
    .where(and(
      inArray(protectedTaskRunOutputBindings.deliveryMode, ["wake", "raw_and_wake"]),
      isNotNull(protectedTaskRunOutputBindings.wakeJobId),
      isNotNull(protectedTaskRunOutputBindings.wakeScheduledAt),
      isNotNull(protectedTaskRunOutputBindings.completedAt),
      inArray(jobs.status, ["queued", "running"]),
      lte(jobs.createdAt, input.throughTime),
      input.cursor ? or(
        gt(jobs.createdAt, input.cursor.createdAt),
        and(eq(jobs.createdAt, input.cursor.createdAt), gt(jobs.id, input.cursor.jobId)),
      ) : undefined,
    )).orderBy(asc(jobs.createdAt), asc(jobs.id)).limit(input.limit + 1);
  const pageRows = rows.slice(0, input.limit);
  const candidates = Object.freeze(pageRows.flatMap(row => {
    const reference = row.wakeOperationId === null ? null : Object.freeze({
      kind: "protected_task_delivery_v1" as const,
      bindingId: row.bindingId,
      taskId: row.taskId,
      taskRunId: row.taskRunId,
      resultObjectId: row.resultObjectId,
      wakeOperationId: row.wakeOperationId,
    });
    const exact = reference !== null
      && row.wakeJobId === row.jobId
      && row.jobId === protectedTaskRunWakeJobId(row.taskRunId)
      && row.jobOwnerId === row.taskOwnerId
      && row.jobRequestorId === row.taskRequestorId
      && row.jobRoomId === row.destinationRoomId
      && row.jobLaneKey === `room:${row.destinationRoomId}`
      && row.jobType === "foreground"
      && row.jobResultIsNull && row.jobMessageIsNull
      && exactReference(row.jobInput, reference)
      && row.wakeScheduledAt?.getTime() === row.jobCreatedAt.getTime()
      && row.bindingCompletedAt?.getTime() === row.jobCreatedAt.getTime()
      && (row.jobStatus === "queued"
        ? row.jobStartedAt === null && row.jobCompletedAt === null
        : row.jobStatus === "running"
          && row.jobStartedAt !== null && row.jobCompletedAt === null);
    return exact ? [Object.freeze({
      taskId: row.taskId,
      taskRunId: row.taskRunId,
      jobId: row.jobId,
      state: row.jobStatus === "queued"
        ? "awaiting_authority" as const
        : "uncertain_execution" as const,
    })] : [];
  }));
  const last = pageRows.at(-1);
  return Object.freeze({
    candidates,
    next: rows.length > input.limit && last
      ? Object.freeze({
          throughTime: new Date(input.throughTime.getTime()),
          createdAt: new Date(last.jobCreatedAt.getTime()),
          jobId: last.jobId,
        })
      : null,
  });
}
