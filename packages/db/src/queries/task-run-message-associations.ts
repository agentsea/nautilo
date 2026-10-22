import { createHash } from "node:crypto";
import {
  and,
  asc,
  countDistinct,
  sql,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { DirectDatabase } from "../config/direct-database";
import type { ProtectedTaskTranscriptManifestReceipt } from "./protected-task-execution-receipts";
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

export type ProtectedTaskDeliveryRoomMember = Readonly<{
  actorKind: string;
  actorAgentId: string | null;
}>;

type TranscriptAudienceTask = Readonly<{
  ownerId: string;
  requestorId: string;
  agentId: string;
  targetRoomId: string | null;
  contentRepresentation: string;
  cryptoMappingState: string | null;
  contentNamespaceId: string | null;
}>;

type TranscriptAudienceSession = Readonly<{
  ownerId: string;
  roomId: string | null;
}>;

type TranscriptAudienceRoom = Readonly<{
  id: string;
  ownerId: string;
  namespaceId: string;
  type: string;
  kind: string;
  parentRoomId: string | null;
  humanActorIds: readonly string[];
  archivedAt: Date | null;
}>;

type TranscriptAudienceMember = Readonly<{
  actorId: string;
  actorKind: string;
  actorOwnerId: string;
  actorAgentId: string | null;
}>;

function resolveProtectedTaskTranscriptAudience(input: Readonly<{
  task: TranscriptAudienceTask;
  session: TranscriptAudienceSession;
  targetRoom: TranscriptAudienceRoom;
  sourceRoom: TranscriptAudienceRoom;
  sourceMembers: readonly TranscriptAudienceMember[];
}>): "task_target" | "requester_private" | null {
  const { task, session, targetRoom, sourceRoom, sourceMembers } = input;
  if (task.targetRoomId !== targetRoom.id
    || session.roomId !== sourceRoom.id
    || session.ownerId !== sourceRoom.ownerId) return null;

  if (sourceRoom.id === targetRoom.id) {
    return sourceMembers.some(member => member.actorKind === "user"
        && member.actorOwnerId === sourceRoom.ownerId)
      && sourceMembers.some(member => member.actorKind === "agent"
        && member.actorAgentId === task.agentId)
      ? "task_target"
      : null;
  }

  if ((task.contentRepresentation !== "dual"
      && task.contentRepresentation !== "protected")
    || task.cryptoMappingState !== "verified"
    || task.contentNamespaceId === null
    || task.ownerId !== task.requestorId
    || targetRoom.ownerId !== task.ownerId
    || targetRoom.type !== "private"
    || targetRoom.kind !== "task"
    || targetRoom.archivedAt !== null
    || targetRoom.humanActorIds.length !== 0
    || sourceRoom.ownerId !== task.requestorId
    || sourceRoom.namespaceId !== task.contentNamespaceId
    || sourceRoom.type !== "private"
    || sourceRoom.kind !== "private"
    || sourceRoom.parentRoomId !== null
    || sourceRoom.archivedAt !== null
    || sourceRoom.humanActorIds.length !== 1
    || sourceMembers.length !== 2) return null;
  const requesterActorId = sourceRoom.humanActorIds[0];
  return sourceMembers.filter(member => member.actorKind === "user"
      && member.actorId === requesterActorId
      && member.actorOwnerId === task.requestorId
      && member.actorAgentId === null).length === 1
    && sourceMembers.filter(member => member.actorKind === "agent"
      && member.actorAgentId === task.agentId).length === 1
    ? "requester_private"
    : null;
}

/**
 * Derive the only Room thread that may receive a protected Task result.
 * Strict one-Human/one-target-Agent Rooms retain their canonical Room thread;
 * every larger Room uses the target Agent's stable group partition.
 */
export function deriveProtectedTaskDeliveryGraphThreadId(input: Readonly<{
  roomId: string;
  roomGraphThreadId: string;
  targetAgentId: string;
  members: readonly ProtectedTaskDeliveryRoomMember[];
}>): string | null {
  const humanCount = input.members.filter(
    member => member.actorKind === "user",
  ).length;
  const agentIds = input.members
    .filter(member => member.actorKind === "agent")
    .map(member => member.actorAgentId)
    .filter((agentId): agentId is string => typeof agentId === "string");
  const targetAgentCount = agentIds.filter(
    agentId => agentId === input.targetAgentId,
  ).length;
  if (humanCount < 1 || targetAgentCount !== 1) return null;
  return humanCount === 1
      && agentIds.length === 1
      && agentIds[0] === input.targetAgentId
    ? input.roomGraphThreadId
    : `room:${input.roomId}:bot:${input.targetAgentId}`;
}

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
    requestorId: tasks.requestorId,
    agentId: tasks.agentId,
    targetRoomId: tasks.targetRoomId,
    contentRepresentation: tasks.contentRepresentation,
    cryptoMappingState: tasks.cryptoMappingState,
    contentNamespaceId: tasks.contentNamespaceId,
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
    const roomIds = input.kind === "transcript" && session.roomId !== null
      ? [...new Set([destinationRoomId, session.roomId])].sort()
      : [destinationRoomId];
    const lockedRooms: (TranscriptAudienceRoom & Readonly<{
      graphThreadId: string;
    }>)[] = [];
    for (const roomId of roomIds) {
      const [room] = await tx.select({
      id: rooms.id,
      ownerId: rooms.ownerId,
      namespaceId: rooms.namespaceId,
      graphThreadId: rooms.graphThreadId,
      type: rooms.type,
      kind: rooms.kind,
      parentRoomId: rooms.parentRoomId,
      humanActorIds: rooms.humanActorIds,
      archivedAt: rooms.archivedAt,
      }).from(rooms).where(and(
        eq(rooms.id, roomId),
        ...(input.kind === "raw_delivery" || wakeTranscript
          ? [
              eq(rooms.namespaceId, input.expectedDestinationNamespaceId!),
              isNull(rooms.archivedAt),
            ]
          : []),
      )).limit(1).for("share");
      if (room === undefined) {
        return Object.freeze({ status: "rejected" as const, reason: "not_found" as const });
      }
      lockedRooms.push(room);
    }
    const room = lockedRooms.find(value => value.id === destinationRoomId);
    const sourceRoom = session.roomId === null
      ? undefined
      : lockedRooms.find(value => value.id === session.roomId);
    const memberRoomId = input.kind === "transcript"
      ? session.roomId
      : destinationRoomId;
    if (room === undefined || memberRoomId === null) {
      return Object.freeze({ status: "rejected" as const, reason: "not_found" as const });
    }
    const members = await tx.select({
      actorId: actors.id,
      actorKind: actors.kind,
      actorOwnerId: actors.ownerId,
      actorAgentId: actors.agentId,
    }).from(roomMembers)
      .innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(eq(roomMembers.roomId, memberRoomId))
      .for("share");
    const protectedDeliveryThreadId = room === undefined
      || input.kind !== "raw_delivery" && !wakeTranscript
      ? null
      : deriveProtectedTaskDeliveryGraphThreadId({
          roomId: room.id,
          roomGraphThreadId: room.graphThreadId,
          targetAgentId: task.agentId,
          members,
        });
    if (room.id !== destinationRoomId
      || (input.kind === "raw_delivery" || wakeTranscript)
        && (room.namespaceId !== input.expectedDestinationNamespaceId
          || protectedDeliveryThreadId !== input.expectedThreadId
          || room.archivedAt !== null)
      || (input.kind === "transcript"
        ? sourceRoom === undefined
          || resolveProtectedTaskTranscriptAudience({
            task,
            session,
            targetRoom: room,
            sourceRoom,
            sourceMembers: members,
          }) === null
        : session.roomId !== destinationRoomId
          || session.ownerId !== room.ownerId
          || !members.some(member =>
            member.actorKind === "user" && member.actorOwnerId === room.ownerId)
          || !members.some(member =>
            member.actorKind === "agent" && member.actorAgentId === task.agentId))) {
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
  | Readonly<{
      status: "ready";
      source:
        | Readonly<{ kind: "task_target"; roomId: string }>
        | Readonly<{
            kind: "requester_private";
            requesterUserId: string;
            roomId: string;
            namespaceId: string;
          }>;
      rows: readonly ProtectedTaskRunTranscriptIndexRow[];
      nextAfterMessageId: number | null;
    }>
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
 * returned only for a current Room member. A target-roomless Task remains
 * readable through its canonical requester+Agent private Room; a historical
 * Session with no Room is reported unavailable because the history projector
 * has no exact Room authority. No Message content or protected payload leaves
 * this query.
 */
export async function readProtectedTaskRunTranscriptIndex(
  db: Pick<DirectDatabase, "select">,
  input: Readonly<{
    taskId: string;
    taskRunId: string;
    agentId: string;
    viewerUserId: string;
    viewerActorId: string;
    afterMessageId?: number;
    limit: number;
  }>,
): Promise<ProtectedTaskRunTranscriptIndexRead> {
  if (
    !CANONICAL_UUID.test(input.taskId)
    || !CANONICAL_UUID.test(input.taskRunId)
    || !CANONICAL_UUID.test(input.agentId)
    || !CANONICAL_UUID.test(input.viewerUserId)
    || !CANONICAL_UUID.test(input.viewerActorId)
    || (input.afterMessageId !== undefined
      && (!Number.isSafeInteger(input.afterMessageId)
        || input.afterMessageId < 1))
    || !Number.isSafeInteger(input.limit)
    || input.limit < 1
    || input.limit === Number.MAX_SAFE_INTEGER
  ) throw new TypeError("Protected Task transcript identity is malformed");

  const lifecycleRows = await db.select({
    ownerId: tasks.ownerId,
    requestorId: tasks.requestorId,
    agentId: tasks.agentId,
    contentRepresentation: tasks.contentRepresentation,
    cryptoMappingState: tasks.cryptoMappingState,
    contentNamespaceId: tasks.contentNamespaceId,
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
    || lifecycle.agentId !== input.agentId
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
    sessionAgentId: sessions.agentId,
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
      ...(input.afterMessageId === undefined
        ? []
        : [gt(taskRunMessageAssociations.messageId, input.afterMessageId)]),
    ))
    .orderBy(asc(taskRunMessageAssociations.messageId))
    .limit(input.limit + 1);

  if (rows.length === 0) {
    if (input.afterMessageId !== undefined) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "integrity_failure" as const,
      });
    }
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
  const pageRows = rows.slice(0, input.limit);
  for (const row of pageRows) {
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
      || row.sessionAgentId !== lifecycle.agentId
      || (lifecycle.targetRoomId === null
        && row.roomId !== null
        && (row.sessionOwnerId !== lifecycle.requestorId
          || lifecycle.contentNamespaceId === null))
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
  const sourceRoomId = projected[0]?.roomId;
  if (sourceRoomId === undefined
    || [...roomIds].length !== 1
    || !roomIds.has(sourceRoomId)) {
    return Object.freeze({
      status: "unavailable" as const,
      reason: "integrity_failure" as const,
    });
  }
  let sourceKind: "task_target" | "requester_private";
  if (lifecycle.targetRoomId === null) {
    sourceKind = "requester_private";
  } else if (sourceRoomId === lifecycle.targetRoomId) {
    sourceKind = "task_target";
  } else {
    const transcriptRoomIds = [sourceRoomId, lifecycle.targetRoomId].sort();
    const transcriptRooms = await db.select({
      id: rooms.id,
      ownerId: rooms.ownerId,
      namespaceId: rooms.namespaceId,
      type: rooms.type,
      kind: rooms.kind,
      parentRoomId: rooms.parentRoomId,
      humanActorIds: rooms.humanActorIds,
      archivedAt: rooms.archivedAt,
    }).from(rooms).where(inArray(rooms.id, transcriptRoomIds))
      .orderBy(asc(rooms.id));
    const targetRoom = transcriptRooms.find(room =>
      room.id === lifecycle.targetRoomId);
    const sourceRoom = transcriptRooms.find(room => room.id === sourceRoomId);
    const sourceMembers = await db.select({
      roomId: roomMembers.roomId,
      actorId: actors.id,
      actorKind: actors.kind,
      actorOwnerId: actors.ownerId,
      actorAgentId: actors.agentId,
    }).from(roomMembers)
      .innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(eq(roomMembers.roomId, sourceRoomId));
    const first = pageRows[0];
    if (targetRoom === undefined || sourceRoom === undefined || first === undefined
      || resolveProtectedTaskTranscriptAudience({
        task: {
          ownerId: lifecycle.ownerId,
          requestorId: lifecycle.requestorId,
          agentId: lifecycle.agentId,
          targetRoomId: lifecycle.targetRoomId,
          contentRepresentation: lifecycle.contentRepresentation,
          cryptoMappingState: lifecycle.cryptoMappingState,
          contentNamespaceId: lifecycle.contentNamespaceId,
        },
        session: {
          ownerId: first.sessionOwnerId ?? "",
          roomId: first.roomId,
        },
        targetRoom,
        sourceRoom,
        sourceMembers,
      }) !== "requester_private"
      || sourceRoom.humanActorIds[0] !== input.viewerActorId
      || pageRows.some(row => row.sessionOwnerId !== first.sessionOwnerId)) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "integrity_failure" as const,
      });
    }
    sourceKind = "requester_private";
  }
  const nextAfterMessageId = rows.length > input.limit
    ? projected.at(-1)?.messageId ?? null
    : null;
  return Object.freeze({
    status: "ready" as const,
    source: sourceKind === "requester_private"
      ? Object.freeze({
          kind: "requester_private" as const,
          requesterUserId: lifecycle.requestorId,
          roomId: sourceRoomId,
          namespaceId: lifecycle.contentNamespaceId!,
        })
      : Object.freeze({
          kind: "task_target" as const,
          roomId: sourceRoomId,
        }),
    rows: Object.freeze(projected),
    nextAfterMessageId,
  });
}

/**
 * Cumulative transcript provenance at a closed execution boundary. The caller
 * must hold Task -> TaskRun UPDATE locks until sealing/parking commits: Message
 * association writers take those lifecycle locks before inserting provenance.
 * Never join Messages here; deletion must not erase the receipt denominator.
 *
 * Digest v1 is SHA-256 over UTF-8 JSON arrays separated by LF: a version/identity/
 * row-count header, then immutable publication coordinates in message-id order.
 * createdAt is deliberately not part of publication identity.
 */
export async function readProtectedTaskTranscriptManifestInTx(
  tx: Pick<DirectDatabase, "select">,
  input: Readonly<{
    taskId: string;
    taskRunId: string;
    graphThreadId: string;
  }>,
): Promise<ProtectedTaskTranscriptManifestReceipt> {
  if (!CANONICAL_UUID.test(input.taskId)
    || !CANONICAL_UUID.test(input.taskRunId)
    || typeof input.graphThreadId !== "string"
    || input.graphThreadId.length === 0) {
    throw new TypeError("Protected Task transcript manifest identity is malformed");
  }
  const [run] = await tx.select({
    id: taskRuns.id,
    taskId: taskRuns.taskId,
    graphThreadId: taskRuns.graphThreadId,
  }).from(taskRuns).where(and(
    eq(taskRuns.id, input.taskRunId),
    eq(taskRuns.taskId, input.taskId),
    eq(taskRuns.graphThreadId, input.graphThreadId),
  )).limit(1);
  if (!run || run.id !== input.taskRunId || run.taskId !== input.taskId
    || run.graphThreadId !== input.graphThreadId) {
    throw new Error("Protected Task transcript manifest lost its TaskRun");
  }
  const rows = await tx.select({
    taskRunId: taskRunMessageAssociations.taskRunId,
    sessionId: taskRunMessageAssociations.sessionId,
    messageId: taskRunMessageAssociations.messageId,
    publishedRevision: taskRunMessageAssociations.publishedRevision,
    kind: taskRunMessageAssociations.kind,
    publicationKey: taskRunMessageAssociations.publicationKey,
  }).from(taskRunMessageAssociations).where(and(
    eq(taskRunMessageAssociations.taskRunId, input.taskRunId),
    eq(taskRunMessageAssociations.kind, "transcript"),
  )).orderBy(asc(taskRunMessageAssociations.messageId));
  const hash = createHash("sha256");
  hash.update(JSON.stringify([
    "protected-task-transcript-manifest:v1", input.taskId, input.taskRunId,
    input.graphThreadId, rows.length,
  ]) + "\n", "utf8");
  let previousMessageId = 0;
  for (const row of rows) {
    if (row.taskRunId !== input.taskRunId || row.kind !== "transcript"
      || !CANONICAL_UUID.test(row.sessionId)
      || !Number.isSafeInteger(row.messageId) || row.messageId <= previousMessageId
      || !Number.isSafeInteger(row.publishedRevision) || row.publishedRevision < 0
      || typeof row.publicationKey !== "string" || row.publicationKey.length === 0) {
      throw new Error("Protected Task transcript manifest contains invalid provenance");
    }
    hash.update(JSON.stringify([
      row.taskRunId, row.sessionId, String(row.messageId),
      String(row.publishedRevision), row.kind, row.publicationKey,
    ]) + "\n", "utf8");
    previousMessageId = row.messageId;
  }
  return Object.freeze({
    contract: "protected_message_associations_v1" as const,
    expectedAssociationCount: rows.length,
    orderedDigest: new Uint8Array(hash.digest()),
  });
}
