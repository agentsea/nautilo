import {
  actors,
  alias,
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  roomMembers,
  rooms,
  sessionMessageCryptoRevisions,
  sessionMessageOrdinaryRepairs,
  sessionMessages,
  sessions,
  sql,
} from "@nautilo/db";
import { logicalMessageKey } from "@nautilo/types";

import type {
  MessageBackfillExactLifecycle,
  MessageBackfillRole,
} from "../../message/message-backfill-state.ts";
import { PROTECTED_TOP_LEVEL_ROOM_KINDS } from
  "../../message/protected-room-topology.ts";
import {
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresExecutor,
} from "./postgres-conversation-product-store.ts";

/** Matches the existing bounded Room-history transport page. */
export const MESSAGE_BACKFILL_CANDIDATE_PAGE_SIZE = 50;

export interface MessageBackfillDiscoveryCandidate {
  readonly messageId: number;
  readonly sessionId: string;
  readonly messageSourceRevision: number;
  readonly revision: number;
  readonly role: MessageBackfillRole;
  readonly ordinaryPresent: boolean;
  readonly cryptoObjectId: string | null;
  readonly sessionRoomId: string;
  readonly subthreadRoomId: string | null;
  readonly sourceRoomId: string;
  readonly authorityRoomId: string;
  readonly namespaceId: string;
  readonly namespaceAccessRevision: number;
  readonly sessionOwnerUserId: string;
  readonly sessionAgentId: string | null;
  readonly createdAt: Date;
  readonly humanTurnId: string | null;
  readonly logicalMessageKey: string;
  readonly supportedTopology: boolean;
  /** Current allocation class; an existing lifecycle retains its own class. */
  readonly targetKeyClass: "ai" | "human";
  readonly lifecycle: MessageBackfillExactLifecycle | null;
  readonly ordinaryRestorationAccepted: boolean;
}

export interface ReadMessageBackfillCandidatesInput {
  readonly subjectHumanId: string;
  readonly afterMessageId: number;
  readonly throughMessageId?: number;
}

export interface MessageBackfillCandidateProjectionInput {
  readonly subjectHumanId: string;
  readonly afterMessageId?: number;
  readonly throughMessageId?: number;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MESSAGE_ROLES = ["user", "assistant", "tool", "system"] as const;

function nonnegativeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a nonnegative safe integer`);
  }
}

function requiredText(row: ConversationProductDatabaseRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Message backfill ${key} must be text`);
  }
  return value;
}

function nullableText(
  row: ConversationProductDatabaseRow,
  key: string,
): string | null {
  return row[key] === null ? null : requiredText(row, key);
}

function requiredInteger(
  row: ConversationProductDatabaseRow,
  key: string,
): number {
  const value = row[key];
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof normalized !== "number"
    || !Number.isSafeInteger(normalized)
    || normalized < 0
  ) throw new TypeError(`Message backfill ${key} must be a nonnegative integer`);
  return normalized;
}

function requiredBoolean(
  row: ConversationProductDatabaseRow,
  key: string,
): boolean {
  const value = row[key];
  if (typeof value !== "boolean") {
    throw new TypeError(`Message backfill ${key} must be boolean`);
  }
  return value;
}

function requiredDate(row: ConversationProductDatabaseRow, key: string): Date {
  const raw = row[key];
  const value = typeof raw === "string" ? new Date(raw) : raw;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`Message backfill ${key} must be a date`);
  }
  return new Date(value);
}

function role(row: ConversationProductDatabaseRow): MessageBackfillRole {
  const value = requiredText(row, "role");
  if (!MESSAGE_ROLES.includes(value as MessageBackfillRole)) {
    throw new TypeError("Message backfill role is invalid");
  }
  return value as MessageBackfillRole;
}

function exactLifecycle(
  row: ConversationProductDatabaseRow,
): MessageBackfillExactLifecycle | null {
  if (row["lifecycle_session_id"] === null) return null;
  const keyClass = requiredText(row, "key_class");
  const completion = requiredText(row, "completion");
  if (keyClass !== "ai" && keyClass !== "human") {
    throw new TypeError("Message backfill key class is invalid");
  }
  if (completion !== "pending" && completion !== "complete") {
    throw new TypeError("Message backfill lifecycle completion is invalid");
  }
  return Object.freeze({
    sessionId: requiredText(row, "lifecycle_session_id"),
    messageId: requiredInteger(row, "lifecycle_message_id"),
    revision: requiredInteger(row, "lifecycle_revision"),
    cryptoObjectId: requiredText(row, "lifecycle_crypto_object_id"),
    keyClass,
    completion,
    disposition: requiredText(row, "disposition"),
    parityStatus: requiredText(row, "parity_status"),
    repairIdentityPresent: requiredBoolean(row, "repair_identity_present"),
  });
}

function candidateFromRow(
  row: ConversationProductDatabaseRow,
): MessageBackfillDiscoveryCandidate {
  const messageId = requiredInteger(row, "message_id");
  const messageRole = role(row);
  const targetKeyClass = requiredText(row, "target_key_class");
  if (targetKeyClass !== "ai" && targetKeyClass !== "human") {
    throw new TypeError("Message backfill target key class is invalid");
  }
  return Object.freeze({
    messageId,
    sessionId: requiredText(row, "session_id"),
    revision: requiredInteger(row, "edit_revision"),
    role: messageRole,
    ordinaryPresent: requiredBoolean(row, "ordinary_present"),
    cryptoObjectId: nullableText(row, "crypto_object_id"),
    sessionRoomId: requiredText(row, "session_room_id"),
    subthreadRoomId: nullableText(row, "subthread_room_id"),
    sourceRoomId: requiredText(row, "source_room_id"),
    authorityRoomId: requiredText(row, "authority_room_id"),
    namespaceId: requiredText(row, "namespace_id"),
    namespaceAccessRevision: requiredInteger(
      row,
      "namespace_access_revision",
    ),
    sessionOwnerUserId: requiredText(row, "session_owner_user_id"),
    sessionAgentId: nullableText(row, "session_agent_id"),
    messageSourceRevision: requiredInteger(row, "message_source_revision"),
    createdAt: requiredDate(row, "created_at"),
    humanTurnId: nullableText(row, "human_turn_id"),
    logicalMessageKey: logicalMessageKey({
      id: messageId,
      role: messageRole,
      fingerprint: nullableText(row, "fingerprint"),
    }),
    supportedTopology: requiredBoolean(row, "supported_topology"),
    targetKeyClass,
    lifecycle: exactLifecycle(row),
    ordinaryRestorationAccepted: requiredBoolean(
      row,
      "ordinary_restoration_accepted",
    ),
  });
}

/**
 * Build the canonical structural, caller-readable Message selection shared by
 * bounded discovery and database-side progress aggregation. It selects no
 * ordinary body column.
 */
export function messageBackfillCandidateProjection(
  input: MessageBackfillCandidateProjectionInput,
) {
  if (!UUID.test(input.subjectHumanId)) {
    throw new TypeError("Message backfill subject Human ID is invalid");
  }
  const afterMessageId = input.afterMessageId ?? 0;
  nonnegativeInteger("Message backfill cursor", afterMessageId);
  if (input.throughMessageId !== undefined) {
    nonnegativeInteger("Message backfill upper bound", input.throughMessageId);
  }

  const sourceRoom = alias(rooms, "message_backfill_source_room");
  const authorityRoom = alias(rooms, "message_backfill_authority_room");
  const subjectActor = alias(actors, "message_backfill_subject_actor");
  const sourceMembership = alias(
    roomMembers,
    "message_backfill_source_membership",
  );
  const authorityMembership = alias(
    roomMembers,
    "message_backfill_authority_membership",
  );
  const restoration = alias(
    sessionMessageOrdinaryRepairs,
    "message_backfill_ordinary_restoration",
  );
  const agentMembership = alias(
    roomMembers,
    "message_backfill_agent_membership",
  );
  const agentActor = alias(actors, "message_backfill_agent_actor");
  const authorityHasAgent = conversationProductTypedDb.select({
    present: sql<number>`1::int`.as("present"),
  }).from(agentMembership).innerJoin(
    agentActor,
    and(
      eq(agentActor.id, agentMembership.actorId),
      eq(agentActor.kind, "agent"),
    ),
  ).where(eq(agentMembership.roomId, authorityRoom.id));
  const conditions = [
    gt(sessionMessages.id, afterMessageId),
    inArray(sessionMessages.role, [...MESSAGE_ROLES]),
    isNull(sourceRoom.archivedAt),
    isNull(authorityRoom.archivedAt),
    isNull(authorityRoom.parentRoomId),
    inArray(authorityRoom.kind, [...PROTECTED_TOP_LEVEL_ROOM_KINDS]),
    or(
      and(
        isNull(sourceRoom.parentRoomId),
        isNull(sessionMessages.subthreadRoomId),
        inArray(sourceRoom.kind, [...PROTECTED_TOP_LEVEL_ROOM_KINDS]),
      ),
      and(
        eq(sourceRoom.kind, "subthread"),
        eq(sessionMessages.subthreadRoomId, sourceRoom.id),
        eq(sourceRoom.parentRoomId, authorityRoom.id),
        or(
          eq(sessions.roomId, sourceRoom.id),
          eq(sessions.roomId, authorityRoom.id),
        ),
      ),
    ),
    ...(input.throughMessageId === undefined
      ? []
      : [lte(sessionMessages.id, input.throughMessageId)]),
  ];

  return conversationProductTypedDb.select({
      message_id: sql`${sessionMessages.id}::int`.as("message_id"),
      session_id: sql`${sessionMessages.sessionId}::text`.as("session_id"),
      edit_revision: sql`${sessionMessages.editRevision}::int`.as("edit_revision"),
      role: sessionMessages.role,
      ordinary_present: sql<boolean>`CASE
        WHEN ${sessionMessages.content} IS NOT NULL THEN TRUE
        ELSE FALSE
      END`.as("ordinary_present"),
      crypto_object_id:
        sql`${sessionMessages.cryptoObjectId}`.as("crypto_object_id"),
      session_room_id: sql`${sessions.roomId}::text`.as("session_room_id"),
      subthread_room_id:
        sql`${sessionMessages.subthreadRoomId}::text`.as("subthread_room_id"),
      source_room_id: sql`${sourceRoom.id}::text`.as("source_room_id"),
      authority_room_id:
        sql`${authorityRoom.id}::text`.as("authority_room_id"),
      namespace_id:
        sql`${authorityRoom.namespaceId}::text`.as("namespace_id"),
      namespace_access_revision:
        sql`${authorityRoom.namespaceAccessRevision}::double precision`
          .as("namespace_access_revision"),
      session_owner_user_id:
        sql`${sessions.ownerId}::text`.as("session_owner_user_id"),
      session_agent_id: sql`${sessions.agentId}::text`.as("session_agent_id"),
      message_source_revision: sessions.messageSourceRevision,
      created_at: sessionMessages.createdAt,
      human_turn_id: sessionMessages.humanTurnId,
      fingerprint: sessionMessages.fingerprint,
      supported_topology: sql<boolean>`CASE
        WHEN ${inArray(
          authorityRoom.kind,
          [...PROTECTED_TOP_LEVEL_ROOM_KINDS],
        )} THEN TRUE
        ELSE FALSE
      END`.as("supported_topology"),
      target_key_class: sql<"ai" | "human">`CASE
        WHEN EXISTS (${authorityHasAgent}) THEN 'ai'
        ELSE 'human'
      END`.as("target_key_class"),
      lifecycle_session_id:
        sql`${sessionMessageCryptoRevisions.sessionId}::text`
          .as("lifecycle_session_id"),
      lifecycle_message_id:
        sql`${sessionMessageCryptoRevisions.messageId}::int`
          .as("lifecycle_message_id"),
      lifecycle_revision:
        sql`${sessionMessageCryptoRevisions.editRevision}::int`
          .as("lifecycle_revision"),
      lifecycle_crypto_object_id:
        sql`${sessionMessageCryptoRevisions.cryptoObjectId}`
          .as("lifecycle_crypto_object_id"),
      key_class: sessionMessageCryptoRevisions.keyClass,
      completion: sessionMessageCryptoRevisions.completion,
      disposition: sessionMessageCryptoRevisions.disposition,
      parity_status: sessionMessageCryptoRevisions.parityStatus,
      repair_identity_present: sql<boolean>`CASE
        WHEN ${sessionMessageCryptoRevisions.repairIdentityDigest} IS NOT NULL
          THEN TRUE
        ELSE FALSE
      END`.as("repair_identity_present"),
      ordinary_restoration_accepted: sql<boolean>`CASE
        WHEN ${restoration.messageId} IS NOT NULL THEN TRUE
        ELSE FALSE
      END`.as("ordinary_restoration_accepted"),
    }).from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
      .innerJoin(sourceRoom, eq(
        sourceRoom.id,
        sql`COALESCE(${sessionMessages.subthreadRoomId}, ${sessions.roomId})`,
      ))
      .innerJoin(authorityRoom, and(
        eq(
          authorityRoom.id,
          sql`COALESCE(${sourceRoom.parentRoomId}, ${sourceRoom.id})`,
        ),
        eq(authorityRoom.namespaceId, sourceRoom.namespaceId),
      ))
      .innerJoin(subjectActor, and(
        eq(subjectActor.id, input.subjectHumanId),
        eq(subjectActor.kind, "user"),
      ))
      .innerJoin(sourceMembership, and(
        eq(sourceMembership.roomId, sourceRoom.id),
        eq(sourceMembership.actorId, subjectActor.id),
      ))
      .innerJoin(authorityMembership, and(
        eq(authorityMembership.roomId, authorityRoom.id),
        eq(authorityMembership.actorId, subjectActor.id),
      ))
      .leftJoin(sessionMessageCryptoRevisions, and(
        eq(sessionMessageCryptoRevisions.sessionId, sessionMessages.sessionId),
        eq(sessionMessageCryptoRevisions.messageId, sessionMessages.id),
        eq(
          sessionMessageCryptoRevisions.editRevision,
          sessionMessages.editRevision,
        ),
      ))
      .leftJoin(restoration, and(
        eq(restoration.sessionId, sessionMessageCryptoRevisions.sessionId),
        eq(restoration.messageId, sessionMessageCryptoRevisions.messageId),
        eq(
          restoration.editRevision,
          sessionMessageCryptoRevisions.editRevision,
        ),
        eq(
          restoration.cryptoObjectId,
          sessionMessageCryptoRevisions.cryptoObjectId,
        ),
        eq(restoration.cryptoObjectId, sessionMessages.cryptoObjectId),
        eq(restoration.expectedKeyClass, sessionMessageCryptoRevisions.keyClass),
      ))
      .where(and(...conditions));
}

/**
 * Enumerate one structural, caller-readable Message page. The query selects no
 * ordinary body column: SQL reduces ordinary existence and repair-receipt
 * existence to booleans before any result crosses the product boundary.
 */
export async function readMessageBackfillCandidates(
  executor: ConversationProductPostgresExecutor,
  input: ReadMessageBackfillCandidatesInput,
): Promise<readonly MessageBackfillDiscoveryCandidate[]> {
  const projection = messageBackfillCandidateProjection(input);
  if (input.throughMessageId !== undefined
    && input.throughMessageId <= input.afterMessageId) return Object.freeze([]);
  const rows = await executeTypedConversationProductQuery(
    executor,
    projection
      .orderBy(asc(sessionMessages.id))
      .limit(MESSAGE_BACKFILL_CANDIDATE_PAGE_SIZE),
  );
  if (rows.length > MESSAGE_BACKFILL_CANDIDATE_PAGE_SIZE) {
    throw new TypeError("Message backfill query exceeded its page bound");
  }
  return Object.freeze(rows.map(candidateFromRow));
}
