import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgRole,
  pgTable,
  serial,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { rooms } from "./rooms";
import { sessions } from "./sessions";

export const CONVERSATION_HUMAN_PEER_SHADOW_DIGEST_BYTES = 32;
export const CONVERSATION_HUMAN_PEER_SHADOW_ID_BYTES = 128;
export const CONVERSATION_HUMAN_PEER_SHADOW_MAX_RECONCILIATION_ATTEMPTS = 8;

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});
const nautiloProductRole = pgRole("nautilo").existing();

/**
 * Product-owned, content-free identity for one Human-authored protected sibling
 * in a closed Human-only Room. Agent, Grant, Runtime, stream, and tool fields
 * are intentionally absent rather than nullable.
 */
export const conversationHumanPeerShadowOperations = pgTable(
  "conversation_human_peer_shadow_operations",
  {
    sequence: serial("sequence").primaryKey(),
    operationId: text("operation_id").notNull(),
    clientIdempotencyKey: text("client_idempotency_key").notNull(),
    policyRevision: integer("policy_revision").notNull(),
    sessionId: uuid("session_id").notNull(),
    roomId: uuid("room_id").notNull(),
    humanMessageId: integer("human_message_id").notNull(),
    humanMessageCreatedAt: timestamp("human_message_created_at", {
      withTimezone: true,
    }).notNull(),
    transcriptOrdinal: integer("transcript_ordinal").notNull(),
    subjectHumanId: text("subject_human_id").notNull(),
    committerDeviceId: text("committer_device_id").notNull(),
    committerDeviceSigningKeyGeneration: bigint(
      "committer_device_signing_key_generation",
      { mode: "number" },
    ).notNull(),
    hostAuthorizationRevision: bigint("host_authorization_revision", {
      mode: "number",
    }).notNull(),
    namespaceId: uuid("namespace_id").notNull(),
    namespaceAccessRevision: integer("namespace_access_revision").notNull(),
    namespaceKeyGeneration: integer("namespace_key_generation").notNull(),
    namespaceHeadDigest: bytea("namespace_head_digest").notNull(),
    namespacePublicationDigest: bytea("namespace_publication_digest").notNull(),
    namespacePublicationSetDigest: bytea(
      "namespace_publication_set_digest",
    ).notNull(),
    namespaceAudienceFingerprint: bytea(
      "namespace_audience_fingerprint",
    ).notNull(),
    cryptoObjectId: text("crypto_object_id").notNull(),
    attemptCoordinate: text("attempt_coordinate").notNull(),
    planDigest: bytea("plan_digest").notNull(),
    planBytes: bytea("plan_bytes").notNull(),
    humanRequestDigest: bytea("human_request_digest"),
    humanRequestBytes: bytea("human_request_bytes"),
    protectedMessageDigest: bytea("protected_message_digest"),
    finalEventDigest: bytea("final_event_digest"),
    state: text("state", {
      enum: [
        "planned",
        "human_verified",
        "published",
        "fallback",
        "failed",
      ],
    }).notNull().default("planned"),
    terminalStage: text("terminal_stage", {
      enum: [
        "plan",
        "human_admission",
        "ordinary_commit",
        "protected_completion",
        "product_mapping",
        "realtime_publication",
        "shutdown",
      ],
    }),
    terminalReason: text("terminal_reason", {
      enum: [
        "protected_unavailable",
        "stale_authority",
        "recipient_sync_required",
        "integrity_failure",
        "parity_mismatch",
        "deadline_expired",
        "product_conflict",
        "policy_changed",
        "authority_changed",
        "storage_failure",
        "transport_failure",
      ],
    }),
    reconciliationAttemptCount: smallint("reconciliation_attempt_count")
      .notNull().default(0),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    humanVerifiedAt: timestamp("human_verified_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "conversation_human_peer_shadow_operations_session_fk",
      columns: [table.sessionId],
      foreignColumns: [sessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "conversation_human_peer_shadow_operations_room_namespace_fk",
      columns: [table.roomId, table.namespaceId],
      foreignColumns: [rooms.id, rooms.namespaceId],
    }).onDelete("cascade"),
    unique("uq_conversation_human_peer_shadow_operations_id")
      .on(table.operationId),
    unique("uq_conversation_human_peer_shadow_operations_attempt")
      .on(table.attemptCoordinate),
    unique("uq_conversation_human_peer_shadow_operations_object")
      .on(table.cryptoObjectId),
    uniqueIndex("uq_conversation_human_peer_shadow_operations_client_request")
      .on(table.sessionId, table.clientIdempotencyKey),
    uniqueIndex("uq_conversation_human_peer_shadow_operations_message")
      .on(table.sessionId, table.humanMessageId),
    index("idx_conversation_human_peer_shadow_operations_due")
      .on(table.state, table.deadlineAt, table.sequence)
      .where(sql`${table.state} in ('planned', 'human_verified')`),
    check(
      "conversation_human_peer_shadow_operations_ids_portable",
      sql`octet_length(${table.operationId}) between 1 and ${sql.raw(
        String(CONVERSATION_HUMAN_PEER_SHADOW_ID_BYTES),
      )}
        and ${table.operationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.clientIdempotencyKey}) between 1 and ${sql.raw(
          String(CONVERSATION_HUMAN_PEER_SHADOW_ID_BYTES),
        )}
        and ${table.clientIdempotencyKey} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.subjectHumanId}) between 1 and ${sql.raw(
          String(CONVERSATION_HUMAN_PEER_SHADOW_ID_BYTES),
        )}
        and ${table.subjectHumanId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.committerDeviceId}) between 1 and ${sql.raw(
          String(CONVERSATION_HUMAN_PEER_SHADOW_ID_BYTES),
        )}
        and ${table.committerDeviceId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.cryptoObjectId}) between 1 and ${sql.raw(
          String(CONVERSATION_HUMAN_PEER_SHADOW_ID_BYTES),
        )}
        and ${table.cryptoObjectId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.attemptCoordinate}) between 1 and ${sql.raw(
          String(CONVERSATION_HUMAN_PEER_SHADOW_ID_BYTES),
        )}
        and ${table.attemptCoordinate} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'`,
    ),
    check(
      "conversation_human_peer_shadow_operations_coordinates",
      sql`${table.policyRevision} > 0
        and ${table.humanMessageId} > 0
        and ${table.transcriptOrdinal} > 0
        and ${table.committerDeviceSigningKeyGeneration} >= 0
        and ${table.hostAuthorizationRevision} >= 0
        and ${table.namespaceAccessRevision} >= 0
        and ${table.namespaceKeyGeneration} >= 0
        and ${table.reconciliationAttemptCount} between 0 and ${sql.raw(
          String(CONVERSATION_HUMAN_PEER_SHADOW_MAX_RECONCILIATION_ATTEMPTS),
        )}`,
    ),
    check(
      "conversation_human_peer_shadow_operations_digests",
      sql`octet_length(${table.namespaceHeadDigest}) = ${sql.raw(
        String(CONVERSATION_HUMAN_PEER_SHADOW_DIGEST_BYTES),
      )}
        and octet_length(${table.namespacePublicationDigest}) = ${sql.raw(
          String(CONVERSATION_HUMAN_PEER_SHADOW_DIGEST_BYTES),
        )}
        and octet_length(${table.namespacePublicationSetDigest}) = ${sql.raw(
          String(CONVERSATION_HUMAN_PEER_SHADOW_DIGEST_BYTES),
        )}
        and octet_length(${table.namespaceAudienceFingerprint}) = ${sql.raw(
          String(CONVERSATION_HUMAN_PEER_SHADOW_DIGEST_BYTES),
        )}
        and octet_length(${table.planDigest}) = ${sql.raw(
          String(CONVERSATION_HUMAN_PEER_SHADOW_DIGEST_BYTES),
        )}
        and (${table.humanRequestDigest} is null
          or octet_length(${table.humanRequestDigest}) = ${sql.raw(
            String(CONVERSATION_HUMAN_PEER_SHADOW_DIGEST_BYTES),
          )})
        and (${table.protectedMessageDigest} is null
          or octet_length(${table.protectedMessageDigest}) = ${sql.raw(
            String(CONVERSATION_HUMAN_PEER_SHADOW_DIGEST_BYTES),
          )})
        and (${table.finalEventDigest} is null
          or octet_length(${table.finalEventDigest}) = ${sql.raw(
            String(CONVERSATION_HUMAN_PEER_SHADOW_DIGEST_BYTES),
          )})`,
    ),
    check(
      "conversation_human_peer_shadow_operations_receipts",
      sql`(
          ${table.state} = 'planned'
          and ${table.humanRequestDigest} is null
          and ${table.humanRequestBytes} is null
          and ${table.protectedMessageDigest} is null
          and ${table.finalEventDigest} is null
          and ${table.humanVerifiedAt} is null
          and ${table.terminalStage} is null
          and ${table.terminalReason} is null
          and ${table.terminalAt} is null
        ) or (
          ${table.state} = 'human_verified'
          and ${table.humanRequestDigest} is not null
          and ${table.humanRequestBytes} is not null
          and ${table.protectedMessageDigest} is null
          and ${table.finalEventDigest} is null
          and ${table.humanVerifiedAt} is not null
          and ${table.terminalStage} is null
          and ${table.terminalReason} is null
          and ${table.terminalAt} is null
        ) or (
          ${table.state} = 'published'
          and ${table.humanRequestDigest} is not null
          and ${table.humanRequestBytes} is not null
          and ${table.protectedMessageDigest} is not null
          and ${table.finalEventDigest} is not null
          and ${table.humanVerifiedAt} is not null
          and ${table.terminalStage} is null
          and ${table.terminalReason} is null
          and ${table.terminalAt} is not null
        ) or (
          ${table.state} in ('fallback', 'failed')
          and ${table.terminalStage} is not null
          and ${table.terminalReason} is not null
          and ${table.terminalAt} is not null
        )`,
    ),
    check(
      "conversation_human_peer_shadow_operations_time_order",
      sql`${table.deadlineAt} > ${table.createdAt}
        and ${table.updatedAt} >= ${table.createdAt}
        and (${table.humanVerifiedAt} is null
          or ${table.humanVerifiedAt} >= ${table.createdAt})
        and (${table.terminalAt} is null
          or ${table.terminalAt} >= ${table.createdAt})`,
    ),
    pgPolicy("conversation_human_peer_shadow_operations_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

/** One independent live-read result for one recipient device. */
export const conversationHumanPeerShadowAcknowledgements = pgTable(
  "conversation_human_peer_shadow_acknowledgements",
  {
    sequence: serial("sequence").primaryKey(),
    operationId: text("operation_id").notNull(),
    subjectHumanId: text("subject_human_id").notNull(),
    committerDeviceId: text("committer_device_id").notNull(),
    committerDeviceSigningKeyGeneration: bigint(
      "committer_device_signing_key_generation",
      { mode: "number" },
    ).notNull(),
    hostAuthorizationRevision: bigint("host_authorization_revision", {
      mode: "number",
    }).notNull(),
    acknowledgementDigest: bytea("acknowledgement_digest").notNull(),
    status: text("status", { enum: ["verified", "fallback"] }).notNull(),
    reason: text("reason", {
      enum: [
        "matched",
        "authority_stale",
        "sender_evidence_unavailable",
        "namespace_unavailable",
        "protected_open_failed",
        "parity_mismatch",
        "transport_unavailable",
      ],
    }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "conversation_human_peer_shadow_acknowledgements_operation_fk",
      columns: [table.operationId],
      foreignColumns: [conversationHumanPeerShadowOperations.operationId],
    }).onDelete("cascade"),
    uniqueIndex("uq_conversation_human_peer_shadow_acknowledgements_device")
      .on(
        table.operationId,
        table.committerDeviceId,
        table.committerDeviceSigningKeyGeneration,
      ),
    check(
      "conversation_human_peer_shadow_acknowledgements_shape",
      sql`octet_length(${table.operationId}) between 1 and ${sql.raw(
        String(CONVERSATION_HUMAN_PEER_SHADOW_ID_BYTES),
      )}
        and octet_length(${table.subjectHumanId}) between 1 and ${sql.raw(
          String(CONVERSATION_HUMAN_PEER_SHADOW_ID_BYTES),
        )}
        and octet_length(${table.committerDeviceId}) between 1 and ${sql.raw(
          String(CONVERSATION_HUMAN_PEER_SHADOW_ID_BYTES),
        )}
        and ${table.committerDeviceSigningKeyGeneration} >= 0
        and ${table.hostAuthorizationRevision} >= 0
        and octet_length(${table.acknowledgementDigest}) = ${sql.raw(
          String(CONVERSATION_HUMAN_PEER_SHADOW_DIGEST_BYTES),
        )}
        and ((${table.status} = 'verified' and ${table.reason} = 'matched')
          or (${table.status} = 'fallback' and ${table.reason} <> 'matched'))
        and ${table.deadlineAt} > ${table.issuedAt}`,
    ),
    pgPolicy("conversation_human_peer_shadow_acknowledgements_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

/** Retry-idempotent denominator before Browser custody is opened. */
export const conversationHumanPeerShadowPlanAttempts = pgTable(
  "conversation_human_peer_shadow_plan_attempts",
  {
    sequence: serial("sequence").primaryKey(),
    sessionId: uuid("session_id").notNull(),
    roomId: uuid("room_id").notNull(),
    clientIdempotencyKey: text("client_idempotency_key").notNull(),
    policyRevision: integer("policy_revision").notNull(),
    subjectUserId: uuid("subject_user_id").notNull(),
    state: text("state", {
      enum: ["checking", "planned", "unavailable"],
    }).notNull().default("checking"),
    unavailableReason: text("unavailable_reason", {
      enum: [
        "device_unavailable",
        "namespace_unavailable",
        "recipient_sync_required",
        "unsupported_topology",
        "reservation_unavailable",
      ],
    }),
    operationId: text("operation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "conversation_human_peer_shadow_plan_attempts_session_fk",
      columns: [table.sessionId],
      foreignColumns: [sessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "conversation_human_peer_shadow_plan_attempts_room_fk",
      columns: [table.roomId],
      foreignColumns: [rooms.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "conversation_human_peer_shadow_plan_attempts_operation_fk",
      columns: [table.operationId],
      foreignColumns: [conversationHumanPeerShadowOperations.operationId],
    }).onDelete("cascade"),
    uniqueIndex("uq_conversation_human_peer_shadow_plan_attempts_request")
      .on(table.sessionId, table.clientIdempotencyKey),
    uniqueIndex("uq_conversation_human_peer_shadow_plan_attempts_operation")
      .on(table.operationId)
      .where(sql`${table.operationId} is not null`),
    check(
      "conversation_human_peer_shadow_plan_attempts_shape",
      sql`${table.policyRevision} > 0
        and octet_length(${table.clientIdempotencyKey}) between 1 and ${sql.raw(
          String(CONVERSATION_HUMAN_PEER_SHADOW_ID_BYTES),
        )}
        and ${table.clientIdempotencyKey} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and (
          (${table.state} = 'checking'
            and ${table.unavailableReason} is null
            and ${table.operationId} is null)
          or (${table.state} = 'unavailable'
            and ${table.unavailableReason} is not null
            and ${table.operationId} is null)
          or (${table.state} = 'planned'
            and ${table.unavailableReason} is null
            and ${table.operationId} is not null)
        )
        and ${table.updatedAt} >= ${table.createdAt}`,
    ),
    pgPolicy("conversation_human_peer_shadow_plan_attempts_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

export type ConversationHumanPeerShadowOperation =
  typeof conversationHumanPeerShadowOperations.$inferSelect;
export type NewConversationHumanPeerShadowOperation =
  typeof conversationHumanPeerShadowOperations.$inferInsert;
export type ConversationHumanPeerShadowAcknowledgement =
  typeof conversationHumanPeerShadowAcknowledgements.$inferSelect;
export type NewConversationHumanPeerShadowAcknowledgement =
  typeof conversationHumanPeerShadowAcknowledgements.$inferInsert;
