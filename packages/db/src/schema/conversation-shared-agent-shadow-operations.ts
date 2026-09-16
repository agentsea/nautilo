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

export const CONVERSATION_SHARED_AGENT_SHADOW_DIGEST_BYTES = 32;
export const CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES = 128;
export const CONVERSATION_SHARED_AGENT_SHADOW_MAX_RECONCILIATION_ATTEMPTS = 8;

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});
const nautiloProductRole = pgRole("nautilo").existing();

/**
 * Product-owned, content-free identity for one Human-authored protected sibling
 * in a closed Human/AI-readable Room. Agent execution state is deliberately
 * separate: this row owns one Human write whether the Conductor later selects
 * zero, one, or many Agents.
 */
export const conversationSharedAgentShadowOperations = pgTable(
  "conversation_shared_agent_shadow_operations",
  {
    sequence: serial("sequence").primaryKey(),
    operationId: text("operation_id").notNull(),
    clientIdempotencyKey: text("client_idempotency_key").notNull(),
    policyRevision: integer("policy_revision").notNull(),
    sessionId: uuid("session_id").notNull(),
    roomId: uuid("room_id").notNull(),
    /** Legacy M296 recipient coordinate; Runtime-principal writes leave null. */
    agentId: uuid("agent_id"),
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
    participantHumanCount: integer("participant_human_count").notNull(),
    protectedParticipantHumanCount: integer(
      "protected_participant_human_count",
    ).notNull(),
    plaintextParticipantHumanCount: integer(
      "plaintext_participant_human_count",
    ).notNull(),
    protectedRecipientDeviceCount: integer(
      "protected_recipient_device_count",
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
    conductorState: text("conductor_state", {
      enum: [
        "pending",
        "awaiting_user",
        "not_selected",
        "selected",
        "unavailable",
      ],
    }).notNull().default("pending"),
    conductorReason: text("conductor_reason"),
    conductorResolvedAt: timestamp("conductor_resolved_at", {
      withTimezone: true,
    }),
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
      name: "conversation_shared_agent_shadow_operations_session_fk",
      columns: [table.sessionId],
      foreignColumns: [sessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "conversation_shared_agent_shadow_operations_room_namespace_fk",
      columns: [table.roomId, table.namespaceId],
      foreignColumns: [rooms.id, rooms.namespaceId],
    }).onDelete("cascade"),
    unique("uq_conversation_shared_agent_shadow_operations_id")
      .on(table.operationId),
    unique("uq_conversation_shared_agent_shadow_operations_attempt")
      .on(table.attemptCoordinate),
    unique("uq_conversation_shared_agent_shadow_operations_object")
      .on(table.cryptoObjectId),
    uniqueIndex("uq_conversation_shared_agent_shadow_operations_client_request")
      .on(table.sessionId, table.clientIdempotencyKey),
    uniqueIndex("uq_conversation_shared_agent_shadow_operations_message")
      .on(table.sessionId, table.humanMessageId),
    index("idx_conversation_shared_agent_shadow_operations_due")
      .on(table.state, table.deadlineAt, table.sequence)
      .where(sql`${table.state} in ('planned', 'human_verified')`),
    check(
      "conversation_shared_agent_shadow_operations_ids_portable",
      sql`octet_length(${table.operationId}) between 1 and ${sql.raw(
        String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
      )}
        and ${table.operationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.clientIdempotencyKey}) between 1 and ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
        )}
        and ${table.clientIdempotencyKey} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.subjectHumanId}) between 1 and ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
        )}
        and ${table.subjectHumanId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.committerDeviceId}) between 1 and ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
        )}
        and ${table.committerDeviceId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.cryptoObjectId}) between 1 and ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
        )}
        and ${table.cryptoObjectId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.attemptCoordinate}) between 1 and ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
        )}
        and ${table.attemptCoordinate} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'`,
    ),
    check(
      "conversation_shared_agent_shadow_operations_coordinates",
      sql`${table.policyRevision} > 0
        and ${table.humanMessageId} > 0
        and ${table.transcriptOrdinal} > 0
        and ${table.committerDeviceSigningKeyGeneration} >= 0
        and ${table.hostAuthorizationRevision} >= 0
        and ${table.namespaceAccessRevision} >= 0
        and ${table.namespaceKeyGeneration} >= 0
        and ${table.participantHumanCount} >= 1
        and ${table.protectedParticipantHumanCount} >= 1
        and ${table.protectedParticipantHumanCount}
          <= ${table.participantHumanCount}
        and ${table.plaintextParticipantHumanCount}
          = ${table.participantHumanCount}
            - ${table.protectedParticipantHumanCount}
        and ${table.protectedRecipientDeviceCount}
          >= ${table.protectedParticipantHumanCount}
        and ${table.reconciliationAttemptCount} between 0 and ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_MAX_RECONCILIATION_ATTEMPTS),
        )}`,
    ),
    check(
      "conversation_shared_agent_shadow_operations_digests",
      sql`octet_length(${table.namespaceHeadDigest}) = ${sql.raw(
        String(CONVERSATION_SHARED_AGENT_SHADOW_DIGEST_BYTES),
      )}
        and octet_length(${table.namespacePublicationDigest}) = ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_DIGEST_BYTES),
        )}
        and octet_length(${table.namespacePublicationSetDigest}) = ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_DIGEST_BYTES),
        )}
        and octet_length(${table.namespaceAudienceFingerprint}) = ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_DIGEST_BYTES),
        )}
        and octet_length(${table.planDigest}) = ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_DIGEST_BYTES),
        )}
        and (${table.humanRequestDigest} is null
          or octet_length(${table.humanRequestDigest}) = ${sql.raw(
            String(CONVERSATION_SHARED_AGENT_SHADOW_DIGEST_BYTES),
          )})
        and (${table.protectedMessageDigest} is null
          or octet_length(${table.protectedMessageDigest}) = ${sql.raw(
            String(CONVERSATION_SHARED_AGENT_SHADOW_DIGEST_BYTES),
          )})
        and (${table.finalEventDigest} is null
          or octet_length(${table.finalEventDigest}) = ${sql.raw(
            String(CONVERSATION_SHARED_AGENT_SHADOW_DIGEST_BYTES),
          )})`,
    ),
    check(
      "conversation_shared_agent_shadow_operations_receipts",
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
      "conversation_shared_agent_shadow_operations_conductor",
      sql`(${table.conductorState} = 'pending'
          and ${table.conductorReason} is null
          and ${table.conductorResolvedAt} is null)
        or (${table.conductorState} in ('awaiting_user', 'not_selected', 'selected', 'unavailable')
          and ${table.conductorReason} is not null
          and ${table.conductorResolvedAt} is not null)`,
    ),
    check(
      "conversation_shared_agent_shadow_operations_time_order",
      sql`${table.deadlineAt} > ${table.createdAt}
        and ${table.updatedAt} >= ${table.createdAt}
        and (${table.humanVerifiedAt} is null
          or ${table.humanVerifiedAt} >= ${table.createdAt})
        and (${table.conductorResolvedAt} is null
          or ${table.conductorResolvedAt} >= ${table.createdAt})
        and (${table.terminalAt} is null
          or ${table.terminalAt} >= ${table.createdAt})`,
    ),
    pgPolicy("conversation_shared_agent_shadow_operations_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

/**
 * One foreground Runtime authorization application over one exact protected
 * Human input set. This row owns content authority; Agent execution identity
 * remains in the child execution rows.
 */
export const conversationSharedAgentShadowInvocations = pgTable(
  "conversation_shared_agent_shadow_invocations",
  {
    sequence: serial("sequence").primaryKey(),
    invocationId: text("invocation_id").notNull(),
    policyRevision: integer("policy_revision").notNull(),
    sessionId: uuid("session_id").notNull(),
    roomId: uuid("room_id").notNull(),
    invokingHumanId: text("invoking_human_id").notNull(),
    invokingDeviceId: text("invoking_device_id").notNull(),
    /** Device that approved this Runtime application; may differ on resume. */
    authorizationDeviceId: text("authorization_device_id").notNull(),
    clientActionSessionId: text("client_action_session_id").notNull(),
    inputCount: integer("input_count").notNull(),
    inputSetDigest: bytea("input_set_digest").notNull(),
    authorizationPlanBytes: bytea("authorization_plan_bytes"),
    authorizationPlanDigest: bytea("authorization_plan_digest"),
    recipientKeyId: text("recipient_key_id"),
    authorizationDisposition: text("authorization_disposition", {
      enum: ["establish", "reuse"],
    }),
    authorizationDigest: bytea("authorization_digest"),
    authorizationSessionReference: text("authorization_session_reference"),
    state: text("state", {
      enum: [
        "awaiting_authorization",
        "authorized",
        "running",
        "completed",
        "fallback",
        "failed",
      ],
    }).notNull().default("awaiting_authorization"),
    terminalReason: text("terminal_reason"),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "conversation_shared_agent_shadow_invocations_session_fk",
      columns: [table.sessionId],
      foreignColumns: [sessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "conversation_shared_agent_shadow_invocations_room_fk",
      columns: [table.roomId],
      foreignColumns: [rooms.id],
    }).onDelete("cascade"),
    unique("uq_conversation_shared_agent_shadow_invocations_id")
      .on(table.invocationId),
    index("idx_conversation_shared_agent_shadow_invocations_due")
      .on(table.state, table.deadlineAt, table.sequence)
      .where(sql`${table.state} in ('awaiting_authorization', 'authorized', 'running')`),
    index("idx_conversation_shared_agent_shadow_invocations_conductor")
      .on(
        table.policyRevision,
        table.createdAt,
        table.state,
        table.terminalReason,
      ),
    check(
      "conversation_shared_agent_shadow_invocations_shape",
      sql`octet_length(${table.invocationId}) between 1 and ${sql.raw(
        String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
      )}
        and ${table.invocationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.invokingHumanId}) between 1 and ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
        )}
        and octet_length(${table.invokingDeviceId}) between 1 and ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
        )}
        and octet_length(${table.authorizationDeviceId}) between 1 and ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
        )}
        and octet_length(${table.clientActionSessionId}) between 1 and ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
        )}
        and ${table.policyRevision} > 0
        and ${table.inputCount} > 0
        and octet_length(${table.inputSetDigest}) = ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_DIGEST_BYTES),
        )}
        and (${table.authorizationDigest} is null
          or octet_length(${table.authorizationDigest}) = ${sql.raw(
            String(CONVERSATION_SHARED_AGENT_SHADOW_DIGEST_BYTES),
          )})
        and (${table.authorizationPlanDigest} is null
          or octet_length(${table.authorizationPlanDigest}) = ${sql.raw(
            String(CONVERSATION_SHARED_AGENT_SHADOW_DIGEST_BYTES),
          )})
        and ${table.deadlineAt} > ${table.createdAt}
        and ${table.updatedAt} >= ${table.createdAt}`,
    ),
    check(
      "conversation_shared_agent_shadow_invocations_authorization",
      sql`(${table.state} = 'awaiting_authorization'
          and ${table.authorizationDisposition} is null
          and ${table.authorizationDigest} is null
          and ${table.authorizationSessionReference} is null
          and ${table.authorizedAt} is null
          and ${table.terminalAt} is null)
        or (${table.state} in ('authorized', 'running')
          and ${table.authorizationDisposition} is not null
          and ${table.authorizationDigest} is not null
          and ${table.authorizationSessionReference} is not null
          and ${table.authorizedAt} is not null
          and ${table.terminalAt} is null)
        or (${table.state} in ('completed', 'fallback', 'failed')
          and ${table.terminalAt} is not null)`,
    ),
    check(
      "conversation_shared_agent_shadow_invocations_plan",
      sql`(${table.authorizationPlanBytes} is null
          and ${table.authorizationPlanDigest} is null
          and ${table.recipientKeyId} is null)
        or (${table.authorizationPlanBytes} is not null
          and ${table.authorizationPlanDigest} is not null
          and ${table.recipientKeyId} is not null)`,
    ),
    pgPolicy("conversation_shared_agent_shadow_invocations_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

/** One actual Conductor-selected Agent execution over one ordered input set. */
// Its product-valid trigger is defined in protected-room-message-authority.ts
// and generated by finalize-m314-public-room-message-authority.ts.
export const conversationSharedAgentShadowExecutions = pgTable(
  "conversation_shared_agent_shadow_executions",
  {
    sequence: serial("sequence").primaryKey(),
    executionId: text("execution_id").notNull(),
    /** Null only for historical per-Agent authorization rows. */
    invocationId: text("invocation_id"),
    policyRevision: integer("policy_revision").notNull(),
    sessionId: uuid("session_id").notNull(),
    roomId: uuid("room_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    invokingHumanId: text("invoking_human_id").notNull(),
    /** Device that authored the retained Human input set. */
    invokingDeviceId: text("invoking_device_id").notNull(),
    /** Device that approved this exact foreground Runtime execution. */
    authorizationDeviceId: text("authorization_device_id").notNull(),
    clientActionSessionId: text("client_action_session_id").notNull(),
    executionKind: text("execution_kind", {
      enum: ["turn", "resume"],
    }).notNull().default("turn"),
    inputCount: integer("input_count").notNull(),
    inputSetDigest: bytea("input_set_digest").notNull(),
    planBytes: bytea("plan_bytes"),
    planDigest: bytea("plan_digest"),
    authorizationPlanBytes: bytea("authorization_plan_bytes"),
    authorizationPlanDigest: bytea("authorization_plan_digest"),
    recipientKeyId: text("recipient_key_id"),
    agentRuntimeGeneration: bigint("agent_runtime_generation", {
      mode: "number",
    }),
    agentSignerKeyId: text("agent_signer_key_id"),
    agentSignerPublicKey: bytea("agent_signer_public_key"),
    finalCausalEventDigest: bytea("final_causal_event_digest"),
    authorizationDisposition: text("authorization_disposition", {
      enum: ["establish", "reuse"],
    }),
    authorizationDigest: bytea("authorization_digest"),
    authorizationSessionReference: text("authorization_session_reference"),
    state: text("state", {
      enum: [
        "awaiting_authorization",
        "authorized",
        "running",
        "completed",
        "fallback",
        "failed",
      ],
    }).notNull().default("awaiting_authorization"),
    terminalReason: text("terminal_reason"),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "conversation_shared_agent_shadow_executions_invocation_fk",
      columns: [table.invocationId],
      foreignColumns: [
        conversationSharedAgentShadowInvocations.invocationId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "conversation_shared_agent_shadow_executions_session_fk",
      columns: [table.sessionId],
      foreignColumns: [sessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "conversation_shared_agent_shadow_executions_room_fk",
      columns: [table.roomId],
      foreignColumns: [rooms.id],
    }).onDelete("cascade"),
    unique("uq_conversation_shared_agent_shadow_executions_id")
      .on(table.executionId),
    index("idx_shared_agent_execution_retained_signer").on(
      table.agentId,
      table.agentRuntimeGeneration,
      table.agentSignerKeyId,
      table.sequence,
    ),
    index("idx_conversation_shared_agent_shadow_executions_due")
      .on(table.state, table.deadlineAt, table.sequence)
      .where(sql`${table.state} in ('awaiting_authorization', 'authorized', 'running')`),
    check(
      "conversation_shared_agent_shadow_executions_shape",
      sql`octet_length(${table.executionId}) between 1 and ${sql.raw(
        String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
      )}
        and ${table.executionId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.invokingHumanId}) between 1 and ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
        )}
        and octet_length(${table.invokingDeviceId}) between 1 and ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
        )}
        and octet_length(${table.authorizationDeviceId}) between 1 and ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
        )}
        and octet_length(${table.clientActionSessionId}) between 1 and ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
        )}
        and ${table.policyRevision} > 0
        and ${table.inputCount} > 0
        and octet_length(${table.inputSetDigest}) = ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_DIGEST_BYTES),
        )}
        and (${table.authorizationDigest} is null
          or octet_length(${table.authorizationDigest}) = ${sql.raw(
            String(CONVERSATION_SHARED_AGENT_SHADOW_DIGEST_BYTES),
          )})
        and (${table.planDigest} is null
          or octet_length(${table.planDigest}) = ${sql.raw(
            String(CONVERSATION_SHARED_AGENT_SHADOW_DIGEST_BYTES),
          )})
        and (${table.authorizationPlanDigest} is null
          or octet_length(${table.authorizationPlanDigest}) = ${sql.raw(
            String(CONVERSATION_SHARED_AGENT_SHADOW_DIGEST_BYTES),
          )})
        and (${table.finalCausalEventDigest} is null
          or octet_length(${table.finalCausalEventDigest}) = ${sql.raw(
            String(CONVERSATION_SHARED_AGENT_SHADOW_DIGEST_BYTES),
          )})
        and (${table.agentRuntimeGeneration} is null
          or ${table.agentRuntimeGeneration} >= 0)
        and ${table.deadlineAt} > ${table.createdAt}
        and ${table.updatedAt} >= ${table.createdAt}`,
    ),
    check(
      "conversation_shared_agent_shadow_executions_authorization",
      sql`(${table.state} = 'awaiting_authorization'
          and ${table.authorizationDisposition} is null
          and ${table.authorizationDigest} is null
          and ${table.authorizationSessionReference} is null
          and ${table.authorizedAt} is null
          and ${table.terminalAt} is null)
        or (${table.state} in ('authorized', 'running')
          and ((${table.invocationId} is null
              and ${table.authorizationDisposition} is not null
              and ${table.authorizationDigest} is not null
              and ${table.authorizationSessionReference} is not null)
            or (${table.invocationId} is not null
              and ${table.authorizationDisposition} is null
              and ${table.authorizationDigest} is null
              and ${table.authorizationSessionReference} is null))
          and ${table.authorizedAt} is not null
          and ${table.terminalAt} is null)
        or (${table.state} in ('completed', 'fallback', 'failed')
          and ${table.terminalAt} is not null)`,
    ),
    check(
      "conversation_shared_agent_shadow_executions_plan",
      sql`(${table.invocationId} is null
          and ((${table.planBytes} is null
          and ${table.planDigest} is null
          and ${table.authorizationPlanBytes} is null
          and ${table.authorizationPlanDigest} is null
          and ${table.recipientKeyId} is null
          and ${table.agentRuntimeGeneration} is null
          and ${table.agentSignerKeyId} is null
          and ${table.agentSignerPublicKey} is null)
        or (${table.planBytes} is not null
          and ${table.planDigest} is not null
          and ${table.authorizationPlanBytes} is not null
          and ${table.authorizationPlanDigest} is not null
          and ${table.recipientKeyId} is not null
          and ${table.agentRuntimeGeneration} is not null
          and ${table.agentSignerKeyId} is not null
          and ${table.agentSignerPublicKey} is not null
          and octet_length(${table.agentSignerPublicKey}) > 0))
        or (${table.invocationId} is not null
          and ${table.authorizationPlanBytes} is null
          and ${table.authorizationPlanDigest} is null
          and ${table.recipientKeyId} is null
          and ((${table.planBytes} is null
              and ${table.planDigest} is null
              and ${table.agentRuntimeGeneration} is null
              and ${table.agentSignerKeyId} is null
              and ${table.agentSignerPublicKey} is null)
            or (${table.planBytes} is not null
              and ${table.planDigest} is not null
              and ${table.agentRuntimeGeneration} is not null
              and ${table.agentSignerKeyId} is not null
              and ${table.agentSignerPublicKey} is not null
              and octet_length(${table.agentSignerPublicKey}) > 0))))`,
    ),
    check(
      "conversation_shared_agent_shadow_executions_final_evidence",
      sql`(${table.state} = 'completed'
          and ${table.finalCausalEventDigest} is not null)
        or (${table.state} <> 'completed'
          and ${table.finalCausalEventDigest} is null)`,
    ),
    pgPolicy("conversation_shared_agent_shadow_executions_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

/** Exact canonical ordering of protected Human writes consumed by an execution. */
export const conversationSharedAgentShadowExecutionInputs = pgTable(
  "conversation_shared_agent_shadow_execution_inputs",
  {
    sequence: serial("sequence").primaryKey(),
    executionId: text("execution_id").notNull(),
    inputOrdinal: integer("input_ordinal").notNull(),
    humanOperationId: text("human_operation_id").notNull(),
    messageId: integer("message_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "conversation_shared_agent_shadow_execution_inputs_execution_fk",
      columns: [table.executionId],
      foreignColumns: [conversationSharedAgentShadowExecutions.executionId],
    }).onDelete("cascade"),
    foreignKey({
      name: "conversation_shared_agent_shadow_execution_inputs_operation_fk",
      columns: [table.humanOperationId],
      foreignColumns: [conversationSharedAgentShadowOperations.operationId],
    }).onDelete("cascade"),
    uniqueIndex("uq_conversation_shared_agent_shadow_execution_inputs_ordinal")
      .on(table.executionId, table.inputOrdinal),
    uniqueIndex("uq_conversation_shared_agent_shadow_execution_inputs_operation")
      .on(table.executionId, table.humanOperationId),
    check(
      "conversation_shared_agent_shadow_execution_inputs_shape",
      sql`${table.inputOrdinal} > 0 and ${table.messageId} > 0`,
    ),
    pgPolicy("conversation_shared_agent_shadow_execution_inputs_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

/** One independent live-read result for one recipient device. */
export const conversationSharedAgentShadowAcknowledgements = pgTable(
  "conversation_shared_agent_shadow_acknowledgements",
  {
    sequence: serial("sequence").primaryKey(),
    operationId: text("operation_id").notNull(),
    operationKind: text("operation_kind", {
      enum: ["human_message", "agent_execution"],
    }).notNull(),
    messageId: integer("message_id").notNull(),
    editRevision: integer("edit_revision").notNull(),
    authorRole: text("author_role", {
      enum: ["user", "assistant", "tool", "system"],
    }).notNull(),
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
    uniqueIndex("uq_conversation_shared_agent_shadow_acknowledgements_device")
      .on(
        table.operationId,
        table.messageId,
        table.editRevision,
        table.committerDeviceId,
        table.committerDeviceSigningKeyGeneration,
      ),
    check(
      "conversation_shared_agent_shadow_acknowledgements_shape",
      sql`octet_length(${table.operationId}) between 1 and ${sql.raw(
        String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
      )}
        and ${table.messageId} > 0
        and ${table.editRevision} >= 0
        and ((${table.operationKind} = 'human_message'
            and ${table.authorRole} = 'user')
          or (${table.operationKind} = 'agent_execution'
            and ${table.authorRole} <> 'user'))
        and octet_length(${table.subjectHumanId}) between 1 and ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
        )}
        and octet_length(${table.committerDeviceId}) between 1 and ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
        )}
        and ${table.committerDeviceSigningKeyGeneration} >= 0
        and ${table.hostAuthorizationRevision} >= 0
        and octet_length(${table.acknowledgementDigest}) = ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_DIGEST_BYTES),
        )}
        and ((${table.status} = 'verified' and ${table.reason} = 'matched')
          or (${table.status} = 'fallback' and ${table.reason} <> 'matched'))
        and ${table.deadlineAt} > ${table.issuedAt}`,
    ),
    pgPolicy("conversation_shared_agent_shadow_acknowledgements_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

/** Retry-idempotent denominator before Browser custody is opened. */
export const conversationSharedAgentShadowPlanAttempts = pgTable(
  "conversation_shared_agent_shadow_plan_attempts",
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
      name: "conversation_shared_agent_shadow_plan_attempts_session_fk",
      columns: [table.sessionId],
      foreignColumns: [sessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "conversation_shared_agent_shadow_plan_attempts_room_fk",
      columns: [table.roomId],
      foreignColumns: [rooms.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "conversation_shared_agent_shadow_plan_attempts_operation_fk",
      columns: [table.operationId],
      foreignColumns: [conversationSharedAgentShadowOperations.operationId],
    }).onDelete("cascade"),
    uniqueIndex("uq_conversation_shared_agent_shadow_plan_attempts_request")
      .on(table.sessionId, table.clientIdempotencyKey),
    uniqueIndex("uq_conversation_shared_agent_shadow_plan_attempts_operation")
      .on(table.operationId)
      .where(sql`${table.operationId} is not null`),
    check(
      "conversation_shared_agent_shadow_plan_attempts_shape",
      sql`${table.policyRevision} > 0
        and octet_length(${table.clientIdempotencyKey}) between 1 and ${sql.raw(
          String(CONVERSATION_SHARED_AGENT_SHADOW_ID_BYTES),
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
    pgPolicy("conversation_shared_agent_shadow_plan_attempts_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

export type ConversationSharedAgentShadowOperation =
  typeof conversationSharedAgentShadowOperations.$inferSelect;
export type NewConversationSharedAgentShadowOperation =
  typeof conversationSharedAgentShadowOperations.$inferInsert;
export type ConversationSharedAgentShadowExecution =
  typeof conversationSharedAgentShadowExecutions.$inferSelect;
export type NewConversationSharedAgentShadowExecution =
  typeof conversationSharedAgentShadowExecutions.$inferInsert;
export type ConversationSharedAgentShadowExecutionInput =
  typeof conversationSharedAgentShadowExecutionInputs.$inferSelect;
export type NewConversationSharedAgentShadowExecutionInput =
  typeof conversationSharedAgentShadowExecutionInputs.$inferInsert;
export type ConversationSharedAgentShadowAcknowledgement =
  typeof conversationSharedAgentShadowAcknowledgements.$inferSelect;
export type NewConversationSharedAgentShadowAcknowledgement =
  typeof conversationSharedAgentShadowAcknowledgements.$inferInsert;
export type ConversationSharedAgentShadowPlanAttempt =
  typeof conversationSharedAgentShadowPlanAttempts.$inferSelect;
export type NewConversationSharedAgentShadowPlanAttempt =
  typeof conversationSharedAgentShadowPlanAttempts.$inferInsert;
