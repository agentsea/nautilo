import { sql, type SQL } from "drizzle-orm";
import {
  boolean,
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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { rooms } from "./rooms";
import { sessions } from "./sessions";
import { conversationShadowTurnOperations } from "./conversation-shadow-turn-operations";
import { conversationHumanPeerShadowOperations } from "./conversation-human-peer-shadow-operations";
import {
  conversationSharedAgentShadowExecutions,
  conversationSharedAgentShadowOperations,
} from "./conversation-shared-agent-shadow-operations";

export const SESSION_MESSAGE_CRYPTO_REVISION_MAX_ATTEMPTS = 8;
export const SESSION_MESSAGE_CRYPTO_REVISION_DIGEST_BYTES = 32;
export const SESSION_MESSAGE_CRYPTO_REVISION_ID_BYTES = 128;

const bytea = customType<{
  data: Uint8Array;
  driverData: Uint8Array;
}>({
  dataType: () => "bytea",
});

const nautiloProductRole = pgRole("nautilo").existing();
const nautiloAgentRole = pgRole("nautilo_agent").existing();

function portableId(name: string, column: AnyPgColumn) {
  return check(
    name,
    sql`${column} is null or (
      octet_length(${column}) between 1 and ${
        sql.raw(String(SESSION_MESSAGE_CRYPTO_REVISION_ID_BYTES))
      }
      and ${column} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
    )`,
  );
}

function agentMemberScope(roomId: AnyPgColumn): SQL {
  return sql`app_current_user_id() is not null
    and app_agent_in_room(${roomId})`;
}

function agentMutableRevision(
  sessionId: AnyPgColumn,
  roomId: AnyPgColumn,
  keyClass: AnyPgColumn,
  authorRole: AnyPgColumn,
  parityStatus: AnyPgColumn,
  repairIdentityDigest: AnyPgColumn,
): SQL {
  return sql`${agentMemberScope(roomId)}
    and exists (
      select 1
        from ${sessions}
       where ${sessions.id} = ${sessionId}
         and ${sessions.roomId} = ${roomId}
    )
    and ${keyClass} = 'ai'
    and (
      (
        ${authorRole} <> 'user'
        and exists (
          select 1
            from ${sessions}
           where ${sessions.id} = ${sessionId}
             and ${sessions.roomId} = ${roomId}
             and ${sessions.agentId} = app_current_agent_id()
        )
      )
      or ${repairIdentityDigest} is not null
    )
    and ${parityStatus} not in ('client_verified', 'client_authenticated')`;
}

/**
 * M237 — content-free product-owned receipt/lifecycle ledger for protected
 * conversation revisions.
 *
 * `crypto_object_id` intentionally has no FK to `crypto_objects`: the product
 * transaction must allocate this pending row before the separate crypto-role
 * transaction creates the deterministic object/access set. The nullable
 * `session_messages.crypto_object_id` remains the FK-backed publication point.
 *
 * There is deliberately no FK to `session_messages`, because a hard-delete
 * receipt must survive after the physical product row is gone.
 */
export const sessionMessageCryptoRevisions = pgTable(
  "session_message_crypto_revisions",
  {
    sequence: serial("sequence").primaryKey(),
    sessionId: uuid("session_id").notNull(),
    messageId: integer("message_id").notNull(),
    editRevision: integer("edit_revision").notNull(),
    roomId: uuid("room_id").notNull(),
    namespaceIdAtAllocation: uuid("namespace_id_at_allocation").notNull(),
    cryptoObjectId: text("crypto_object_id").notNull(),
    /**
     * Existing and historical Message revisions retain the deterministic V2
     * scheme. M282 live turns use a domain-separated scheme that additionally
     * binds the operation, transcript ordinal, and canonical author role.
     * Human edits use their own operation-scoped candidate identity; the
     * winning revision CAS selects it without reusing an abandoned candidate.
     */
    objectIdScheme: text("object_id_scheme", {
      enum: ["message_v2", "live_shadow_v1", "human_message_edit_v1"],
    }).notNull().default("message_v2"),
    representationMode: text("representation_mode", {
      enum: ["shadow_encryption", "full_encryption"],
    }).notNull().default("shadow_encryption"),
    publicationPolicyRevision: integer("publication_policy_revision"),
    shadowOperationId: text("shadow_operation_id"),
    humanPeerShadowOperationId: text("human_peer_shadow_operation_id"),
    sharedAgentShadowOperationId: text("shared_agent_shadow_operation_id"),
    sharedAgentShadowExecutionId: text("shared_agent_shadow_execution_id"),
    shadowTranscriptOrdinal: integer("shadow_transcript_ordinal"),
    shadowReservedCreatedAt: timestamp("shadow_reserved_created_at", {
      withTimezone: true,
    }),
    shadowStreamId: text("shadow_stream_id"),
    shadowStreamStartDigest: bytea("shadow_stream_start_digest"),
    shadowStreamTerminalDigest: bytea("shadow_stream_terminal_digest"),
    shadowStreamedTextDigest: bytea("shadow_streamed_text_digest"),
    shadowDurableEventDigest: bytea("shadow_durable_event_digest"),
    payloadVersion: smallint("payload_version").notNull().default(2),
    keyClass: text("key_class", { enum: ["ai", "human"] }).notNull(),
    /**
     * Authorship is not key class: a Human-authored message can intentionally
     * be AI-readable. This closed role also survives hard deletion so parity
     * accounting never guesses from crypto policy.
     */
    authorRole: text("author_role", {
      enum: ["user", "assistant", "tool", "system"],
    }).notNull(),
    /**
     * Closed cleartext projection used for Subthread summary maintenance.
     * Protected product paths never inspect content or free-form metadata to
     * decide whether a row contributes to the root reply summary.
     */
    subthreadReplyClassification: text("subthread_reply_classification", {
      enum: ["counted", "excluded"],
    }).notNull().default("excluded"),
    /**
     * Present only on revision zero. Replay compares the accompanying digest;
     * matching key with different request bytes is a durable conflict.
     */
    appendIdempotencyKey: text("append_idempotency_key"),
    allocationRequestDigest: bytea("allocation_request_digest").notNull(),
    /** Publisher-neutral identity for one exact existing-Message repair. */
    repairIdentityDigest: bytea("repair_identity_digest"),
    /** Current Tool source after an unpublished allocation resumes across a predecessor edit. */
    repairSourceRevision: integer("repair_source_revision"),
    repairSourceDigest: bytea("repair_source_digest"),
    /** Winning repair publisher; original Message authorship is unchanged. */
    repairPublisherKind: text("repair_publisher_kind", {
      enum: ["foreground_runtime", "human_device"],
    }),
    repairPublisherId: text("repair_publisher_id"),
    /** Repairing Human, independent of original Message authorship. */
    repairPublisherHumanId: uuid("repair_publisher_human_id"),
    repairAttestationDigest: bytea("repair_attestation_digest"),
    completion: text("completion", {
      enum: ["pending", "complete"],
    }).notNull().default("pending"),
    disposition: text("disposition", {
      enum: [
        "active",
        "mapped",
        "blocked",
        "quarantined",
        "superseded",
        "hard_delete",
        "stale_mapping",
      ],
    }).notNull().default("active"),
    parityStatus: text("parity_status", {
      enum: [
        "pending",
        "server_verified",
        "client_verified",
        "server_authenticated",
        "client_authenticated",
      ],
    }).notNull().default("pending"),
    attemptCount: smallint("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
    }).defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** Closed code only; never provider text, plaintext, or a stack trace. */
    failureCode: text("failure_code", {
      enum: [
        "namespace_unresolved",
        "namespace_mismatch",
        "crypto_absent",
        "crypto_incomplete",
        "crypto_mismatch",
        "authorization_unavailable",
        "recipient_unavailable",
        "storage_transient",
        "mapping_conflict",
        "retry_exhausted",
      ],
    }),
    /**
     * An edit stores its terminal receipt on the superseded prior revision;
     * a delete stores it on the deleted revision. The digest makes a repeated
     * operation ID with changed parameters a conflict after response loss.
     */
    terminalOperationId: text("terminal_operation_id"),
    /** Shared durable identity for every physical row in one logical edit. */
    terminalOperationGroupId: text("terminal_operation_group_id"),
    terminalOperationType: text("terminal_operation_type", {
      enum: ["edit", "delete"],
    }),
    terminalExpectedRevision: integer("terminal_expected_revision"),
    terminalRequestDigest: bytea("terminal_request_digest"),
    /**
     * Retained only for a leased explicit quarantine, so a worker can replay
     * the exact committed request after the live lease fields are cleared.
     */
    quarantineLeaseToken: uuid("quarantine_lease_token"),
    /**
     * Durable product-side effects returned by the physical delete. These
     * fields let an idempotent replay reproduce the same outward result after
     * the SessionMessage itself is gone.
     */
    deleteWasUnread: boolean("delete_was_unread"),
    deleteOrphanedTurnId: text("delete_orphaned_turn_id"),
    deleteRootParentRoomId: uuid("delete_root_parent_room_id"),
    deleteRootAnchorMessageId: integer("delete_root_anchor_message_id"),
    deleteRootReplyCount: integer("delete_root_reply_count"),
    deleteRootLastReplyAt: timestamp("delete_root_last_reply_at", {
      withTimezone: true,
    }),
    deleteRootSummaryRevision: integer("delete_root_summary_revision"),
    cryptoCompletedAt: timestamp("crypto_completed_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => {
    const agentScope = agentMemberScope(table.roomId);
    const agentMutable = agentMutableRevision(
      table.sessionId,
      table.roomId,
      table.keyClass,
      table.authorRole,
      table.parityStatus,
      table.repairIdentityDigest,
    );
    return [
      check(
        "session_message_crypto_revisions_full_policy_revision_check",
        sql`${table.representationMode} <> 'full_encryption' or ${table.publicationPolicyRevision} is not null`,
      ),
      check(
        "session_message_crypto_revisions_policy_revision_check",
        sql`${table.publicationPolicyRevision} is null or ${table.publicationPolicyRevision} >= 0`,
      ),
      foreignKey({
        name: "session_message_crypto_revisions_session_fk",
        columns: [table.sessionId],
        foreignColumns: [sessions.id],
      }).onDelete("cascade"),
      foreignKey({
        name: "session_message_crypto_revisions_room_namespace_fk",
        columns: [table.roomId, table.namespaceIdAtAllocation],
        foreignColumns: [rooms.id, rooms.namespaceId],
      }).onDelete("cascade"),
      foreignKey({
        name: "session_message_crypto_revisions_shadow_operation_fk",
        columns: [table.shadowOperationId],
      foreignColumns: [conversationShadowTurnOperations.operationId],
      }).onDelete("cascade"),
      foreignKey({
        name: "session_message_crypto_revisions_human_peer_operation_fk",
        columns: [table.humanPeerShadowOperationId],
        foreignColumns: [conversationHumanPeerShadowOperations.operationId],
      }).onDelete("cascade"),
      foreignKey({
        name: "session_message_crypto_revisions_shared_agent_operation_fk",
        columns: [table.sharedAgentShadowOperationId],
        foreignColumns: [conversationSharedAgentShadowOperations.operationId],
      }).onDelete("cascade"),
      foreignKey({
        name: "session_message_crypto_revisions_shared_agent_execution_fk",
        columns: [table.sharedAgentShadowExecutionId],
        foreignColumns: [conversationSharedAgentShadowExecutions.executionId],
      }).onDelete("cascade"),
      unique("uq_session_message_crypto_revisions_coordinate").on(
        table.sessionId,
        table.messageId,
        table.editRevision,
      ),
      unique("uq_session_message_crypto_revisions_coordinate_object").on(
        table.sessionId,
        table.messageId,
        table.editRevision,
        table.cryptoObjectId,
      ),
      unique("uq_session_message_crypto_revisions_object").on(
        table.cryptoObjectId,
      ),
      uniqueIndex("uq_session_message_crypto_revisions_shadow_ordinal")
        .on(table.shadowOperationId, table.shadowTranscriptOrdinal)
        .where(sql`${table.shadowOperationId} is not null`),
      uniqueIndex("uq_session_message_crypto_revisions_human_peer_ordinal")
        .on(table.humanPeerShadowOperationId, table.shadowTranscriptOrdinal)
        .where(sql`${table.humanPeerShadowOperationId} is not null`),
      uniqueIndex("uq_session_message_crypto_revisions_shared_agent_operation_ordinal")
        .on(table.sharedAgentShadowOperationId, table.shadowTranscriptOrdinal)
        .where(sql`${table.sharedAgentShadowOperationId} is not null`),
      uniqueIndex("uq_session_message_crypto_revisions_shared_agent_execution_ordinal")
        .on(table.sharedAgentShadowExecutionId, table.shadowTranscriptOrdinal)
        .where(sql`${table.sharedAgentShadowExecutionId} is not null`),
      uniqueIndex(
        "uq_session_message_crypto_revisions_append_idempotency",
      )
        .on(table.sessionId, table.appendIdempotencyKey)
        .where(sql`${table.appendIdempotencyKey} is not null`),
      uniqueIndex(
        "uq_session_message_crypto_revisions_terminal_operation",
      )
        .on(table.terminalOperationId)
        .where(sql`${table.terminalOperationId} is not null`),
      index("idx_session_message_crypto_revisions_due")
        .on(
          table.disposition,
          table.nextAttemptAt,
          table.sequence,
          table.completion,
        )
        .where(sql`${table.disposition} = 'active'`),
      check(
        "session_message_crypto_revisions_revision_nonnegative",
        sql`${table.editRevision} >= 0`,
      ),
      check(
        "session_message_crypto_revisions_message_id_positive",
        sql`${table.messageId} > 0`,
      ),
      check(
        "session_message_crypto_revisions_payload_version",
        sql`${table.payloadVersion} = 2`,
      ),
      check(
        "session_message_crypto_revisions_object_id_scheme",
        sql`(
          ${table.objectIdScheme} = 'message_v2'
          and ${table.shadowOperationId} is null
          and ${table.humanPeerShadowOperationId} is null
          and ${table.sharedAgentShadowOperationId} is null
          and ${table.sharedAgentShadowExecutionId} is null
          and ${table.shadowTranscriptOrdinal} is null
          and ${table.shadowReservedCreatedAt} is null
          and ${table.shadowStreamId} is null
          and ${table.shadowStreamStartDigest} is null
          and ${table.shadowStreamTerminalDigest} is null
          and ${table.shadowStreamedTextDigest} is null
          and ${table.shadowDurableEventDigest} is null
        ) or (
          ${table.objectIdScheme} = 'human_message_edit_v1'
          and ${table.authorRole} = 'user'
          and ${table.editRevision} > 0
          and ${table.cryptoObjectId} ~ '^message-edit:v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{64}$'
          and (
            (${table.shadowOperationId} is not null
              and ${table.humanPeerShadowOperationId} is null
              and ${table.sharedAgentShadowOperationId} is null
              and ${table.sharedAgentShadowExecutionId} is null)
            or (${table.shadowOperationId} is null
              and ${table.humanPeerShadowOperationId} is not null
              and ${table.sharedAgentShadowOperationId} is null
              and ${table.sharedAgentShadowExecutionId} is null)
            or (${table.shadowOperationId} is null
              and ${table.humanPeerShadowOperationId} is null
              and ${table.sharedAgentShadowOperationId} is not null
              and ${table.sharedAgentShadowExecutionId} is null)
          )
        ) or (
          ${table.objectIdScheme} = 'live_shadow_v1'
          and (
            (${table.shadowOperationId} is not null
              and ${table.humanPeerShadowOperationId} is null
              and ${table.sharedAgentShadowOperationId} is null
              and ${table.sharedAgentShadowExecutionId} is null)
            or (${table.shadowOperationId} is null
              and ${table.humanPeerShadowOperationId} is not null
              and ${table.sharedAgentShadowOperationId} is null
              and ${table.sharedAgentShadowExecutionId} is null)
            or (${table.shadowOperationId} is null
              and ${table.humanPeerShadowOperationId} is null
              and ${table.sharedAgentShadowOperationId} is not null
              and ${table.sharedAgentShadowExecutionId} is null)
            or (${table.shadowOperationId} is null
              and ${table.humanPeerShadowOperationId} is null
              and ${table.sharedAgentShadowOperationId} is null
              and ${table.sharedAgentShadowExecutionId} is not null)
          )
          and ${table.shadowTranscriptOrdinal} > 0
          and ${table.shadowReservedCreatedAt} is not null
        )`,
      ),
      check(
        "session_message_crypto_revisions_human_peer_shape",
        sql`${table.humanPeerShadowOperationId} is null or (
          ${table.keyClass} = 'human'
          and ${table.authorRole} = 'user'
          and ${table.shadowStreamId} is null
          and ${table.shadowStreamStartDigest} is null
          and ${table.shadowStreamTerminalDigest} is null
          and ${table.shadowStreamedTextDigest} is null
        )`,
      ),
      check(
        "session_message_crypto_revisions_shared_agent_shape",
        sql`(${table.sharedAgentShadowOperationId} is null
            and ${table.sharedAgentShadowExecutionId} is null)
          or (${table.sharedAgentShadowOperationId} is not null
            and ${table.sharedAgentShadowExecutionId} is null
            and ${table.keyClass} = 'ai'
            and ${table.authorRole} = 'user'
            and ${table.shadowStreamId} is null
            and ${table.shadowStreamStartDigest} is null
            and ${table.shadowStreamTerminalDigest} is null
            and ${table.shadowStreamedTextDigest} is null)
          or (${table.sharedAgentShadowOperationId} is null
            and ${table.sharedAgentShadowExecutionId} is not null
            and ${table.keyClass} = 'ai'
            and ${table.authorRole} <> 'user')`,
      ),
      check(
        "session_message_crypto_revisions_shadow_digest_shape",
        sql`(${table.shadowStreamStartDigest} is null
          or octet_length(${table.shadowStreamStartDigest}) = ${
            sql.raw(String(SESSION_MESSAGE_CRYPTO_REVISION_DIGEST_BYTES))
          })
          and (${table.shadowStreamTerminalDigest} is null
          or octet_length(${table.shadowStreamTerminalDigest}) = ${
            sql.raw(String(SESSION_MESSAGE_CRYPTO_REVISION_DIGEST_BYTES))
          })
          and (${table.shadowStreamedTextDigest} is null
            or octet_length(${table.shadowStreamedTextDigest}) = ${
              sql.raw(String(SESSION_MESSAGE_CRYPTO_REVISION_DIGEST_BYTES))
            })
          and (${table.shadowDurableEventDigest} is null
            or octet_length(${table.shadowDurableEventDigest}) = ${
              sql.raw(String(SESSION_MESSAGE_CRYPTO_REVISION_DIGEST_BYTES))
            })
          and ((${table.shadowStreamId} is null
              and ${table.shadowStreamStartDigest} is null
              and ${table.shadowStreamTerminalDigest} is null
              and ${table.shadowStreamedTextDigest} is null)
            or (${table.shadowStreamId} is not null
              and octet_length(${table.shadowStreamId}) between 1 and 128
              and ${table.shadowStreamId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
              and ${table.shadowStreamStartDigest} is not null
              and ${table.shadowStreamTerminalDigest} is not null
              and ${table.shadowStreamedTextDigest} is not null))`,
      ),
      check(
        "session_message_crypto_revisions_key_class",
        sql`${table.keyClass} in ('ai', 'human')`,
      ),
      check(
        "session_message_crypto_revisions_author_role",
        sql`${table.authorRole} in ('user', 'assistant', 'tool', 'system')`,
      ),
      check(
        "session_message_crypto_revisions_subthread_reply_classification",
        sql`${table.subthreadReplyClassification} in ('counted', 'excluded')`,
      ),
      check(
        "session_message_crypto_revisions_append_receipt_coherent",
        sql`(
          ${table.editRevision} = 0
          and ${table.appendIdempotencyKey} is not null
        ) or (
          ${table.editRevision} > 0
          and ${table.appendIdempotencyKey} is null
        )`,
      ),
      check(
        "session_message_crypto_revisions_allocation_digest_size",
        sql`octet_length(${table.allocationRequestDigest}) = ${
          sql.raw(String(SESSION_MESSAGE_CRYPTO_REVISION_DIGEST_BYTES))
        }`,
      ),
      check(
        "session_message_crypto_revisions_repair_human_publisher",
        sql`case when ${table.repairPublisherKind} = 'human_device'
          then ${table.repairPublisherHumanId} is not null
          else ${table.repairPublisherHumanId} is null end`,
      ),
      check(
        "session_message_crypto_revisions_repair_evidence_coherent",
        sql`(
          ${table.repairIdentityDigest} is null
          and ${table.repairPublisherKind} is null
          and ${table.repairPublisherId} is null
          and ${table.repairAttestationDigest} is null
        ) or (
          octet_length(${table.repairIdentityDigest}) = ${
            sql.raw(String(SESSION_MESSAGE_CRYPTO_REVISION_DIGEST_BYTES))
          }
          and (
            (${table.repairPublisherKind} is null
              and ${table.repairPublisherId} is null
              and ${table.repairAttestationDigest} is null
              and ${table.completion} = 'pending')
            or (${table.repairPublisherKind} in ('foreground_runtime', 'human_device')
              and octet_length(${table.repairPublisherId}) between 1 and ${
                sql.raw(String(SESSION_MESSAGE_CRYPTO_REVISION_ID_BYTES))
              }
              and ${table.repairPublisherId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
              and octet_length(${table.repairAttestationDigest}) = ${
                sql.raw(String(SESSION_MESSAGE_CRYPTO_REVISION_DIGEST_BYTES))
              }
              and ${table.completion} in ('pending', 'complete'))
          )
        )`,
      ),
      check(
        "session_message_crypto_revisions_completion",
        sql`${table.completion} in ('pending', 'complete')`,
      ),
      check(
        "session_message_crypto_revisions_disposition",
        sql`${table.disposition} in (
          'active', 'mapped', 'blocked', 'quarantined',
          'superseded', 'hard_delete', 'stale_mapping'
        )`,
      ),
      check(
        "session_message_crypto_revisions_completion_coherent",
        sql`(
          ${table.completion} = 'pending'
          and ${table.cryptoCompletedAt} is null
          and ${table.disposition} not in ('mapped', 'stale_mapping')
        ) or (
          ${table.completion} = 'complete'
          and ${table.cryptoCompletedAt} is not null
        )`,
      ),
      check(
        "session_message_crypto_revisions_parity_status",
        sql`${table.parityStatus} in (
          'pending', 'server_verified', 'client_verified',
          'server_authenticated', 'client_authenticated'
        )`,
      ),
      check(
        "session_message_crypto_revisions_parity_author_coherent",
        sql`${table.parityStatus} = 'pending'
          or (
            ${table.completion} = 'complete'
            and (
              (
                ${table.parityStatus} in ('client_verified', 'client_authenticated')
              )
              or (
                ${table.parityStatus} in ('server_verified', 'server_authenticated')
                and ${table.keyClass} = 'ai'
                and (
                  ${table.authorRole} <> 'user'
                  or ${table.repairPublisherKind} = 'foreground_runtime'
                )
              )
            )
          )`,
      ),
      check(
        "session_message_crypto_revisions_attempt_bound",
        sql`${table.attemptCount} between 0 and ${
          sql.raw(String(SESSION_MESSAGE_CRYPTO_REVISION_MAX_ATTEMPTS))
        }`,
      ),
      check(
        "session_message_crypto_revisions_retry_coherent",
        sql`(
          ${table.disposition} = 'active'
          and ${table.nextAttemptAt} is not null
          and ${table.attemptCount} < ${
            sql.raw(String(SESSION_MESSAGE_CRYPTO_REVISION_MAX_ATTEMPTS))
          }
        ) or (
          ${table.disposition} <> 'active'
          and ${table.nextAttemptAt} is null
        )`,
      ),
      check(
        "session_message_crypto_revisions_lease_coherent",
        sql`(
          ${table.leaseToken} is null
          and ${table.leaseExpiresAt} is null
        ) or (
          ${table.disposition} = 'active'
          and ${table.leaseToken} is not null
          and ${table.leaseExpiresAt} is not null
        )`,
      ),
      check(
        "session_message_crypto_revisions_terminal_operation_coherent",
        sql`(
          ${table.disposition} = 'superseded'
          and ${table.terminalOperationId} is not null
          and ${table.terminalOperationGroupId} is not null
          and ${table.terminalOperationType} = 'edit'
          and ${table.terminalExpectedRevision} = ${table.editRevision}
          and ${table.terminalRequestDigest} is not null
        ) or (
          ${table.disposition} = 'hard_delete'
          and ${table.terminalOperationId} is not null
          and ${table.terminalOperationGroupId} is null
          and ${table.terminalOperationType} = 'delete'
          and ${table.terminalExpectedRevision} = ${table.editRevision}
          and ${table.terminalRequestDigest} is not null
        ) or (
          ${table.disposition} not in ('superseded', 'hard_delete')
          and ${table.terminalOperationId} is null
          and ${table.terminalOperationGroupId} is null
          and ${table.terminalOperationType} is null
          and ${table.terminalExpectedRevision} is null
          and ${table.terminalRequestDigest} is null
        )`,
      ),
      check(
        "session_message_crypto_revisions_terminal_digest_size",
        sql`${table.terminalRequestDigest} is null
          or octet_length(${table.terminalRequestDigest}) = ${
            sql.raw(String(SESSION_MESSAGE_CRYPTO_REVISION_DIGEST_BYTES))
          }`,
      ),
      check(
        "session_message_crypto_revisions_quarantine_receipt_coherent",
        sql`${table.quarantineLeaseToken} is null
          or (
            ${table.disposition} = 'quarantined'
            and ${table.leaseToken} is null
            and ${table.leaseExpiresAt} is null
          )`,
      ),
      check(
        "session_message_crypto_revisions_delete_effects_coherent",
        sql`(
          ${table.disposition} = 'hard_delete'
          and ${table.deleteWasUnread} is not null
        ) or (
          ${table.disposition} <> 'hard_delete'
          and ${table.deleteWasUnread} is null
          and ${table.deleteOrphanedTurnId} is null
          and ${table.deleteRootParentRoomId} is null
          and ${table.deleteRootAnchorMessageId} is null
          and ${table.deleteRootReplyCount} is null
          and ${table.deleteRootLastReplyAt} is null
          and ${table.deleteRootSummaryRevision} is null
        )`,
      ),
      check(
        "session_message_crypto_revisions_delete_root_summary_coherent",
        sql`(
          ${table.deleteRootParentRoomId} is null
          and ${table.deleteRootAnchorMessageId} is null
          and ${table.deleteRootReplyCount} is null
          and ${table.deleteRootLastReplyAt} is null
          and ${table.deleteRootSummaryRevision} is null
        ) or (
          ${table.deleteRootParentRoomId} is not null
          and ${table.deleteRootAnchorMessageId} is not null
          and ${table.deleteRootReplyCount} is not null
          and ${table.deleteRootSummaryRevision} is not null
        )`,
      ),
      check(
        "session_message_crypto_revisions_delete_root_time_coherent",
        sql`${table.deleteRootReplyCount} is null
          or (
            ${table.deleteRootReplyCount} = 0
            and ${table.deleteRootLastReplyAt} is null
          )
          or (
            ${table.deleteRootReplyCount} > 0
            and ${table.deleteRootLastReplyAt} is not null
          )`,
      ),
      check(
        "session_message_crypto_revisions_delete_root_anchor_positive",
        sql`${table.deleteRootAnchorMessageId} is null
          or ${table.deleteRootAnchorMessageId} > 0`,
      ),
      check(
        "session_message_crypto_revisions_delete_root_reply_count_nonnegative",
        sql`${table.deleteRootReplyCount} is null
          or ${table.deleteRootReplyCount} >= 0`,
      ),
      check(
        "session_message_crypto_revisions_delete_root_revision_nonnegative",
        sql`${table.deleteRootSummaryRevision} is null
          or ${table.deleteRootSummaryRevision} >= 0`,
      ),
      portableId(
        "session_message_crypto_revisions_delete_orphaned_turn_id_portable",
        table.deleteOrphanedTurnId,
      ),
      portableId(
        "session_message_crypto_revisions_object_id_portable",
        table.cryptoObjectId,
      ),
      portableId(
        "session_message_crypto_revisions_append_idempotency_portable",
        table.appendIdempotencyKey,
      ),
      portableId(
        "session_message_crypto_revisions_operation_id_portable",
        table.terminalOperationId,
      ),
      portableId(
        "session_message_crypto_revisions_operation_group_id_portable",
        table.terminalOperationGroupId,
      ),
      check(
        "session_message_crypto_revisions_failure_code",
        sql`${table.failureCode} is null or ${table.failureCode} in (
          'namespace_unresolved', 'namespace_mismatch', 'crypto_absent',
          'crypto_incomplete', 'crypto_mismatch',
          'authorization_unavailable', 'recipient_unavailable',
          'storage_transient', 'mapping_conflict', 'retry_exhausted'
        )`,
      ),
      check(
        "session_message_crypto_revisions_failure_coherent",
        sql`(
          ${table.disposition} in ('blocked', 'quarantined')
          and ${table.failureCode} is not null
        ) or (
          ${table.disposition} in ('mapped', 'superseded', 'hard_delete')
          and ${table.failureCode} is null
        ) or ${table.disposition} in ('active', 'stale_mapping')`,
      ),
      check(
        "session_message_crypto_revisions_retry_exhausted_coherent",
        sql`${table.failureCode} <> 'retry_exhausted'
          or (
            ${table.disposition} = 'quarantined'
            and ${table.attemptCount} = ${
              sql.raw(String(SESSION_MESSAGE_CRYPTO_REVISION_MAX_ATTEMPTS))
            }
          )`,
      ),
      check(
        "session_message_crypto_revisions_attempt_exhaustion_terminal",
        sql`${table.attemptCount} < ${
          sql.raw(String(SESSION_MESSAGE_CRYPTO_REVISION_MAX_ATTEMPTS))
        }
          or (
            ${table.disposition} = 'quarantined'
            and ${table.failureCode} = 'retry_exhausted'
          )`,
      ),
      check(
        "session_message_crypto_revisions_time_order",
        sql`${table.updatedAt} >= ${table.createdAt}`,
      ),
      check("session_message_crypto_revisions_repair_source_coherent", sql`
        (${table.repairSourceRevision} is null and ${table.repairSourceDigest} is null)
        or (${table.repairSourceRevision} is not null and ${table.repairSourceDigest} is not null
          and ${table.repairSourceRevision} >= 0 and octet_length(${table.repairSourceDigest}) = 32
          and ${table.authorRole} = 'tool' and ${table.repairIdentityDigest} is not null)
      `),
      pgPolicy("session_message_crypto_revisions_product_all", {
        for: "all",
        to: nautiloProductRole,
        using: sql`true`,
        withCheck: sql`true`,
      }),
      pgPolicy("session_message_crypto_revisions_agent_select", {
        for: "select",
        to: nautiloAgentRole,
        using: agentScope,
      }),
      pgPolicy("session_message_crypto_revisions_agent_insert", {
        for: "insert",
        to: nautiloAgentRole,
        withCheck: agentMutable,
      }),
      pgPolicy("session_message_crypto_revisions_agent_update", {
        for: "update",
        to: nautiloAgentRole,
        using: agentMutable,
        withCheck: agentMutable,
      }),
    ];
  },
).enableRLS();

export type SessionMessageCryptoRevision =
  typeof sessionMessageCryptoRevisions.$inferSelect;
export type NewSessionMessageCryptoRevision =
  typeof sessionMessageCryptoRevisions.$inferInsert;
