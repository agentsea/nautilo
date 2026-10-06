import {
  and,
  asc,
  countDistinct,
  sql,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { DirectDatabase } from "../config/direct-database";
import { sessionMessageCryptoRevisions } from
  "../schema/session-message-crypto-revisions";
import { sessionMessages, sessions } from "../schema/sessions";
import { roomMembers, rooms } from "../schema/rooms";
import {
  taskRunMessageAssociations,
  type TaskRunMessageAssociation,
  type TaskRunMessageAssociationKind,
} from "../schema/task-run-message-associations";
import { taskRuns } from "../schema/task-runs";
import { tasks } from "../schema/tasks";
import { actors } from "../schema/trust";
import { protectedTaskRunOutputBindings } from
  "../schema/protected-task-run-output-bindings";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type TaskRunMessageAssociationInput = Readonly<{
  taskId: string;
  taskRunId: string;
  sessionId: string;
  expectedThreadId: string;
  messageId: number;
  publishedRevision: number;
  kind: TaskRunMessageAssociationKind;
  publicationKey: string;
  /** Required only for raw delivery and pinned to its accepted output binding. */
  expectedDestinationRoomId?: string;
  /** Required only for raw delivery and pinned to its accepted output binding. */
  expectedDestinationNamespaceId?: string;
  /** Required together for a wake continuation Message in the accepted destination. */
  expectedWakeOperationId?: string;
  expectedWakeOrdinal?: number;
  createdAt?: Date;
}>;

export type RecordTaskRunMessageAssociationResult =
  | Readonly<{
      status: "recorded" | "exact_replay";
      association: TaskRunMessageAssociation;
    }>
  | Readonly<{
      status: "rejected";
      reason: "conflict" | "not_found";
    }>;

type TaskRunMessageAssociationTx = Pick<
  DirectDatabase,
  "insert" | "select"
>;

function assertAssociationInput(
  input: TaskRunMessageAssociationInput,
): void {
  const wake = input.expectedWakeOperationId !== undefined
    || input.expectedWakeOrdinal !== undefined;
  if (
    !CANONICAL_UUID.test(input.taskId)
    || !CANONICAL_UUID.test(input.taskRunId)
    || !CANONICAL_UUID.test(input.sessionId)
    || input.expectedThreadId.length < 1
    || !Number.isSafeInteger(input.messageId)
    || input.messageId < 1
    || !Number.isSafeInteger(input.publishedRevision)
    || input.publishedRevision < 0
    || input.kind !== "transcript" && input.kind !== "raw_delivery" && input.kind !== "wake"
    || input.kind === "raw_delivery"
      && (!CANONICAL_UUID.test(input.expectedDestinationRoomId ?? "")
        || !CANONICAL_UUID.test(input.expectedDestinationNamespaceId ?? ""))
    || input.kind !== "wake" && wake
    || input.kind === "wake" && !wake
    || (input.kind === "transcript" || input.kind === "wake") && (wake
      ? !CANONICAL_UUID.test(input.expectedDestinationRoomId ?? "")
        || !CANONICAL_UUID.test(input.expectedDestinationNamespaceId ?? "")
        || input.expectedWakeOperationId
          !== `task-run-delivery-wake:${input.taskRunId}`
        || !Number.isSafeInteger(input.expectedWakeOrdinal)
        || (input.expectedWakeOrdinal ?? 0) < 1
      : input.expectedDestinationRoomId !== undefined
        || input.expectedDestinationNamespaceId !== undefined)
    || input.publicationKey.length < 1
    || Buffer.byteLength(input.publicationKey, "utf8") > 512
    || input.createdAt !== undefined && (
      !(input.createdAt instanceof Date)
      || !Number.isFinite(input.createdAt.getTime())
    )
  ) throw new TypeError("TaskRun Message association is malformed");
}

function exactAssociation(
  association: TaskRunMessageAssociation,
  input: TaskRunMessageAssociationInput,
): boolean {
  return association.taskRunId === input.taskRunId
    && association.sessionId === input.sessionId
    && association.messageId === input.messageId
    && association.publishedRevision === input.publishedRevision
    && association.kind === input.kind
    && association.publicationKey === input.publicationKey
    && (input.createdAt === undefined
      || association.createdAt.getTime() === input.createdAt.getTime());
}

/**
 * Record one exact TaskRun-to-Message publication inside the caller's
 * canonical Message transaction. The helper validates Task/Run authority and
 * treats either identity being reused for different coordinates as conflict.
 */
export async function recordTaskRunMessageAssociationInTx(
  tx: TaskRunMessageAssociationTx,
  input: TaskRunMessageAssociationInput,
): Promise<RecordTaskRunMessageAssociationResult> {
  assertAssociationInput(input);
  const [task] = await tx.select({
    id: tasks.id,
    ownerId: tasks.ownerId,
    agentId: tasks.agentId,
    targetRoomId: tasks.targetRoomId,
  }).from(tasks).where(eq(tasks.id, input.taskId)).limit(1).for("share");
  const [run] = await tx.select({
    id: taskRuns.id,
    taskId: taskRuns.taskId,
    graphThreadId: taskRuns.graphThreadId,
  }).from(taskRuns).where(and(
    eq(taskRuns.id, input.taskRunId),
    eq(taskRuns.taskId, input.taskId),
  )).limit(1).for("share");
  if (!run) {
    return Object.freeze({ status: "rejected" as const, reason: "not_found" as const });
  }
  const [session] = await tx.select({
    id: sessions.id,
    threadId: sessions.threadId,
    ownerId: sessions.ownerId,
    agentId: sessions.agentId,
    roomId: sessions.roomId,
  }).from(sessions).where(eq(sessions.id, input.sessionId))
    .limit(1).for("share");
  const [message] = await tx.select({
    id: sessionMessages.id,
    sessionId: sessionMessages.sessionId,
    editRevision: sessionMessages.editRevision,
    role: sessionMessages.role,
  }).from(sessionMessages).where(and(
    eq(sessionMessages.id, input.messageId),
    eq(sessionMessages.sessionId, input.sessionId),
    eq(sessionMessages.editRevision, input.publishedRevision),
  )).limit(1).for("share");
  const baseSessionMatchesTask = task !== undefined
    && session !== undefined
    && session.agentId === task.agentId
    && session.threadId === input.expectedThreadId;
  const wakeTranscript = input.kind === "wake";
  const roleAndThreadMatch = input.kind !== "raw_delivery"
    ? session?.threadId === (wakeTranscript
      ? input.expectedThreadId : run.graphThreadId)
      && ["assistant", "tool", "system"].includes(message?.role ?? "")
    : message?.role === "assistant";
  if (!baseSessionMatchesTask || !roleAndThreadMatch || message === undefined) {
    return Object.freeze({ status: "rejected" as const, reason: "not_found" as const });
  }

  let destinationRoomId = wakeTranscript
    ? input.expectedDestinationRoomId! : task.targetRoomId;
  if (input.kind === "raw_delivery" || wakeTranscript) {
    const [binding] = await tx.select({
      taskRunId: protectedTaskRunOutputBindings.taskRunId,
      deliveryMode: protectedTaskRunOutputBindings.deliveryMode,
      destinationRoomId: protectedTaskRunOutputBindings.destinationRoomId,
      destinationNamespaceId:
        protectedTaskRunOutputBindings.destinationNamespaceId,
      messageOperationId: protectedTaskRunOutputBindings.messageOperationId,
      wakeOperationId: protectedTaskRunOutputBindings.wakeOperationId,
      resultAttachedAt: protectedTaskRunOutputBindings.resultAttachedAt,
      completedAt: protectedTaskRunOutputBindings.completedAt,
    }).from(protectedTaskRunOutputBindings).where(eq(
      protectedTaskRunOutputBindings.taskRunId,
      input.taskRunId,
    )).limit(1).for("share");
    if (binding === undefined
      || binding.taskRunId !== input.taskRunId
      || (wakeTranscript
        ? binding.deliveryMode !== "wake"
          && binding.deliveryMode !== "raw_and_wake"
        : binding.deliveryMode !== "raw"
          && binding.deliveryMode !== "raw_and_wake")
      || binding.destinationRoomId !== input.expectedDestinationRoomId
      || binding.destinationNamespaceId
        !== input.expectedDestinationNamespaceId
      || (wakeTranscript
        ? binding.wakeOperationId !== input.expectedWakeOperationId
          || input.publicationKey
            !== `${input.expectedWakeOperationId}:${input.expectedWakeOrdinal}`
        : binding.messageOperationId !== input.publicationKey)
      || !(binding.resultAttachedAt instanceof Date)
      || binding.completedAt !== null) {
      return Object.freeze({
        status: "rejected" as const,
        reason: "not_found" as const,
      });
    }
    destinationRoomId = binding.destinationRoomId;
  }
  if (destinationRoomId === null) {
    if (input.kind !== "transcript"
      || session.roomId !== null
      || session.ownerId !== task.ownerId) {
      return Object.freeze({ status: "rejected" as const, reason: "not_found" as const });
    }
  } else {
    const [room] = await tx.select({
      id: rooms.id,
      ownerId: rooms.ownerId,
      namespaceId: rooms.namespaceId,
      graphThreadId: rooms.graphThreadId,
      archivedAt: rooms.archivedAt,
    }).from(rooms).where(and(
      eq(rooms.id, destinationRoomId),
      ...(input.kind === "raw_delivery" || wakeTranscript
        ? [
            eq(rooms.namespaceId, input.expectedDestinationNamespaceId!),
            isNull(rooms.archivedAt),
          ]
        : []),
    ))
      .limit(1).for("share");
    const members = await tx.select({
      actorKind: actors.kind,
      actorOwnerId: actors.ownerId,
      actorAgentId: actors.agentId,
    }).from(roomMembers)
      .innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(eq(roomMembers.roomId, destinationRoomId))
      .for("share");
    if (room === undefined
      || room.id !== destinationRoomId
      || (input.kind === "raw_delivery" || wakeTranscript)
        && (room.namespaceId !== input.expectedDestinationNamespaceId
          || room.graphThreadId !== input.expectedThreadId
          || room.archivedAt !== null)
      || session.roomId !== destinationRoomId
      || session.ownerId !== room.ownerId
      || !members.some(member =>
        member.actorKind === "user" && member.actorOwnerId === room.ownerId)
      || !members.some(member =>
        member.actorKind === "agent" && member.actorAgentId === task.agentId)) {
      return Object.freeze({ status: "rejected" as const, reason: "not_found" as const });
    }
  }

  // Immutable receipts need no row lock: Task/Run locks retain their parent,
  // and unique keys serialize competing inserts. FOR SHARE needs UPDATE grants.
  const existing = await tx.select().from(taskRunMessageAssociations)
    .where(or(
      eq(taskRunMessageAssociations.messageId, input.messageId),
      and(
        eq(taskRunMessageAssociations.taskRunId, input.taskRunId),
        eq(taskRunMessageAssociations.kind, input.kind),
        eq(taskRunMessageAssociations.publicationKey, input.publicationKey),
      ),
    )).limit(2);
  if (existing.length > 0) {
    return existing.length === 1 && exactAssociation(existing[0]!, input)
      ? Object.freeze({
          status: "exact_replay" as const,
          association: existing[0]!,
        })
      : Object.freeze({ status: "rejected" as const, reason: "conflict" as const });
  }

  const [inserted] = await tx.insert(taskRunMessageAssociations).values({
    taskRunId: input.taskRunId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    publishedRevision: input.publishedRevision,
    kind: input.kind,
    publicationKey: input.publicationKey,
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
  }).onConflictDoNothing().returning();
  if (inserted) {
    return Object.freeze({ status: "recorded" as const, association: inserted });
  }

  const raced = await tx.select().from(taskRunMessageAssociations)
    .where(or(
      eq(taskRunMessageAssociations.messageId, input.messageId),
      and(
        eq(taskRunMessageAssociations.taskRunId, input.taskRunId),
        eq(taskRunMessageAssociations.kind, input.kind),
        eq(taskRunMessageAssociations.publicationKey, input.publicationKey),
      ),
    )).limit(2);
  return raced.length === 1 && exactAssociation(raced[0]!, input)
    ? Object.freeze({ status: "exact_replay" as const, association: raced[0]! })
    : Object.freeze({ status: "rejected" as const, reason: "conflict" as const });
}

export type TaskRunMessageMappingCounts = Readonly<{
  kind: TaskRunMessageAssociationKind;
  associatedCount: number;
  presentMessageCount: number;
  verifiedMappedCount: number;
  verifiedShadowMappedCount: number;
  verifiedFullMappedCount: number;
  pendingOrStaleCount: number;
  missingMessageCount: number;
}>;

/** Count only exact current Message revisions with complete verified mappings. */
export async function readTaskRunMessageMappingCounts(
  db: Pick<DirectDatabase, "select">,
  taskRunId: string,
): Promise<readonly TaskRunMessageMappingCounts[]> {
  if (!CANONICAL_UUID.test(taskRunId)) {
    throw new TypeError("TaskRun Message count identity is malformed");
  }
  const shadowRevision = alias(
    sessionMessageCryptoRevisions,
    "task_message_shadow_revision",
  );
  const fullRevision = alias(
    sessionMessageCryptoRevisions,
    "task_message_full_revision",
  );
  const rows = await db.select({
    kind: taskRunMessageAssociations.kind,
    associatedCount: countDistinct(taskRunMessageAssociations.messageId),
    presentMessageCount: countDistinct(sessionMessages.id),
    verifiedShadowMappedCount: countDistinct(sql`CASE WHEN ${shadowRevision.sequence} IS NOT NULL THEN ${sessionMessages.id} END`),
    verifiedFullMappedCount: countDistinct(sql`CASE WHEN ${fullRevision.sequence} IS NOT NULL THEN ${sessionMessages.id} END`),
    verifiedMappedCount: countDistinct(sql`CASE WHEN ${shadowRevision.sequence} IS NOT NULL OR ${fullRevision.sequence} IS NOT NULL THEN ${sessionMessages.id} END`),
  }).from(taskRunMessageAssociations)
    .leftJoin(sessionMessages, and(
      eq(sessionMessages.id, taskRunMessageAssociations.messageId),
      eq(sessionMessages.sessionId, taskRunMessageAssociations.sessionId),
      eq(sessionMessages.editRevision,
        taskRunMessageAssociations.publishedRevision),
    ))
    .leftJoin(shadowRevision, and(
      eq(shadowRevision.sessionId,
        taskRunMessageAssociations.sessionId),
      eq(shadowRevision.messageId,
        taskRunMessageAssociations.messageId),
      eq(shadowRevision.editRevision,
        taskRunMessageAssociations.publishedRevision),
      eq(shadowRevision.cryptoObjectId,
        sessionMessages.cryptoObjectId),
      eq(shadowRevision.representationMode, "shadow_encryption"),
      isNull(shadowRevision.publicationPolicyRevision),
      eq(shadowRevision.completion, "complete"),
      eq(shadowRevision.disposition, "mapped"),
      inArray(shadowRevision.parityStatus, [
        "server_verified",
        "client_verified",
      ]),
      isNotNull(shadowRevision.cryptoCompletedAt),
      isNull(shadowRevision.failureCode),
    ))
    .leftJoin(fullRevision, and(
      eq(fullRevision.sessionId, taskRunMessageAssociations.sessionId),
      eq(fullRevision.messageId, taskRunMessageAssociations.messageId),
      eq(fullRevision.editRevision,
        taskRunMessageAssociations.publishedRevision),
      eq(fullRevision.cryptoObjectId, sessionMessages.cryptoObjectId),
      eq(fullRevision.representationMode, "full_encryption"),
      isNull(sessionMessages.content),
      isNull(sessionMessages.toolCalls),
      isNull(sessionMessages.toolName),
      isNull(sessionMessages.metadata),
      isNotNull(fullRevision.publicationPolicyRevision),
      eq(fullRevision.completion, "complete"),
      eq(fullRevision.disposition, "mapped"),
      inArray(fullRevision.parityStatus, [
        "server_authenticated",
        "client_authenticated",
      ]),
      isNotNull(fullRevision.cryptoCompletedAt),
      isNull(fullRevision.failureCode),
    ))
    .where(eq(taskRunMessageAssociations.taskRunId, taskRunId))
    .groupBy(taskRunMessageAssociations.kind);

  return rows.map((row) => {
    const associatedCount = Number(row.associatedCount);
    const presentMessageCount = Number(row.presentMessageCount);
    const verifiedShadowMappedCount = Number(row.verifiedShadowMappedCount);
    const verifiedFullMappedCount = Number(row.verifiedFullMappedCount);
    const verifiedMappedCount = Number(row.verifiedMappedCount);
    if (![associatedCount, presentMessageCount, verifiedShadowMappedCount,
      verifiedFullMappedCount, verifiedMappedCount].every(value =>
      Number.isSafeInteger(value) && value >= 0)
      || presentMessageCount > associatedCount
      || verifiedMappedCount > presentMessageCount
      || verifiedShadowMappedCount > verifiedMappedCount
      || verifiedFullMappedCount > verifiedMappedCount) {
      throw new TypeError("TaskRun Message coverage counts are inconsistent");
    }
    return Object.freeze({
      kind: row.kind,
      associatedCount,
      presentMessageCount,
      verifiedMappedCount,
      verifiedShadowMappedCount,
      verifiedFullMappedCount,
      pendingOrStaleCount: presentMessageCount - verifiedMappedCount,
      missingMessageCount: associatedCount - presentMessageCount,
    });
  });
}

export type ProtectedTaskRunTranscriptIndexRow = Readonly<{
  sessionId: string;
  roomId: string;
  messageId: number;
  editRevision: number;
  role: "assistant" | "tool" | "system";
  createdAt: Date;
}>;

export type ProtectedTaskRunTranscriptIndexRead =
  | Readonly<{ status: "ready"; rows: readonly ProtectedTaskRunTranscriptIndexRow[] }>
  | Readonly<{ status: "waiting"; reason: "transcript_not_mapped" }>
  | Readonly<{
      status: "unavailable";
      reason:
        | "transcript_not_protected"
        | "not_in_message_audience"
        | "message_history_unavailable"
        | "integrity_failure";
    }>
  | Readonly<{ status: "not_found" }>;

/**
 * Resolve only the Message coordinates owned by one exact protected TaskRun.
 * Task ownership and Message audience remain separate: Room transcripts are
 * returned only for a current Room member, while a roomless private Session is
 * recognized but reported unavailable until it has an exact protected-history
 * reader. No Message content or protected payload leaves this query.
 */
export async function readProtectedTaskRunTranscriptIndex(
  db: Pick<DirectDatabase, "select">,
  input: Readonly<{
    taskId: string;
    taskRunId: string;
    viewerUserId: string;
    viewerActorId: string;
  }>,
): Promise<ProtectedTaskRunTranscriptIndexRead> {
  if (
    !CANONICAL_UUID.test(input.taskId)
    || !CANONICAL_UUID.test(input.taskRunId)
    || !CANONICAL_UUID.test(input.viewerUserId)
    || !CANONICAL_UUID.test(input.viewerActorId)
  ) throw new TypeError("Protected Task transcript identity is malformed");

  const lifecycleRows = await db.select({
    ownerId: tasks.ownerId,
    contentRepresentation: tasks.contentRepresentation,
    cryptoMappingState: tasks.cryptoMappingState,
    targetRoomId: tasks.targetRoomId,
    runTaskId: taskRuns.taskId,
    graphThreadId: taskRuns.graphThreadId,
    runStatus: taskRuns.status,
  }).from(tasks).innerJoin(taskRuns, and(
    eq(taskRuns.id, input.taskRunId),
    eq(taskRuns.taskId, tasks.id),
  )).where(eq(tasks.id, input.taskId)).limit(2);
  const lifecycle = lifecycleRows[0];
  if (lifecycleRows.length !== 1 || lifecycle === undefined
    || lifecycle.ownerId !== input.viewerUserId
    || lifecycle.runTaskId !== input.taskId) {
    return Object.freeze({ status: "not_found" as const });
  }
  if ((lifecycle.contentRepresentation !== "dual"
      && lifecycle.contentRepresentation !== "protected")
    || lifecycle.cryptoMappingState !== "verified") {
    return Object.freeze({
      status: "unavailable" as const,
      reason: "transcript_not_protected" as const,
    });
  }

  const rows = await db.select({
    associatedSessionId: taskRunMessageAssociations.sessionId,
    associatedMessageId: taskRunMessageAssociations.messageId,
    associatedRevision: taskRunMessageAssociations.publishedRevision,
    sessionId: sessions.id,
    roomId: sessions.roomId,
    sessionOwnerId: sessions.ownerId,
    threadId: sessions.threadId,
    messageId: sessionMessages.id,
    messageSessionId: sessionMessages.sessionId,
    editRevision: sessionMessages.editRevision,
    role: sessionMessages.role,
    cryptoObjectId: sessionMessages.cryptoObjectId,
    createdAt: sessionMessages.createdAt,
  }).from(taskRunMessageAssociations)
    .leftJoin(sessions, eq(
      sessions.id,
      taskRunMessageAssociations.sessionId,
    ))
    .leftJoin(sessionMessages, and(
      eq(sessionMessages.id, taskRunMessageAssociations.messageId),
      eq(sessionMessages.sessionId, taskRunMessageAssociations.sessionId),
      eq(sessionMessages.editRevision,
        taskRunMessageAssociations.publishedRevision),
    ))
    .where(and(
      eq(taskRunMessageAssociations.taskRunId, input.taskRunId),
      eq(taskRunMessageAssociations.kind, "transcript"),
    ))
    .orderBy(asc(taskRunMessageAssociations.messageId));

  if (rows.length === 0) {
    return lifecycle.runStatus === "running"
        || lifecycle.runStatus === "awaiting"
        || lifecycle.runStatus === "paused"
      ? Object.freeze({
          status: "waiting" as const,
          reason: "transcript_not_mapped" as const,
        })
      : Object.freeze({
          status: "unavailable" as const,
          reason: "transcript_not_protected" as const,
        });
  }

  const roomIds = new Set<string>();
  const projected: ProtectedTaskRunTranscriptIndexRow[] = [];
  for (const row of rows) {
    if (row.sessionId === null
      || row.messageId === null
      || row.editRevision === null
      || row.role === null
      || row.cryptoObjectId === null
      || row.createdAt === null
      || row.associatedSessionId !== row.sessionId
      || row.associatedMessageId !== row.messageId
      || row.associatedRevision !== row.editRevision
      || row.messageSessionId !== row.sessionId
      || row.threadId !== lifecycle.graphThreadId
      || row.roomId !== lifecycle.targetRoomId
      || !["assistant", "tool", "system"].includes(row.role)) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "integrity_failure" as const,
      });
    }
    if (row.roomId === null) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: row.sessionOwnerId === input.viewerUserId
          ? "message_history_unavailable" as const
          : "not_in_message_audience" as const,
      });
    }
    roomIds.add(row.roomId);
    projected.push(Object.freeze({
      sessionId: row.sessionId,
      roomId: row.roomId,
      messageId: row.messageId,
      editRevision: row.editRevision,
      role: row.role as "assistant" | "tool" | "system",
      createdAt: row.createdAt,
    }));
  }

  const memberships = await db.select({ roomId: roomMembers.roomId })
    .from(roomMembers).where(and(
      inArray(roomMembers.roomId, [...roomIds]),
      eq(roomMembers.actorId, input.viewerActorId),
    ));
  const readableRooms = new Set(memberships.map((row) => row.roomId));
  if ([...roomIds].some((roomId) => !readableRooms.has(roomId))) {
    return Object.freeze({
      status: "unavailable" as const,
      reason: "not_in_message_audience" as const,
    });
  }
  return Object.freeze({
    status: "ready" as const,
    rows: Object.freeze(projected),
  });
}
