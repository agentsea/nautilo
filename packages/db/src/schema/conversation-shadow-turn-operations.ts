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

export const CONVERSATION_SHADOW_TURN_DIGEST_BYTES = 32;
export const CONVERSATION_SHADOW_TURN_RECIPIENT_PUBLIC_KEY_BYTES = 65;
export const CONVERSATION_SHADOW_TURN_AGENT_SIGNER_PUBLIC_KEY_BYTES = 32;
export const CONVERSATION_SHADOW_TURN_MAX_RECONCILIATION_ATTEMPTS = 8;
export const CONVERSATION_SHADOW_TURN_ID_BYTES = 128;
export const CONVERSATION_SHADOW_TURN_AGENT_GRANT_PLAN_BYTES =
  8 * 1024 * 1024;
export const CONVERSATION_SHADOW_TURN_PLAN_BYTES = 8 * 1024 * 1024;
export const CONVERSATION_SHADOW_TURN_HUMAN_REQUEST_BYTES =
  18 * 1024 * 1024;

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});
const nautiloProductRole = pgRole("nautilo").existing();

/**
 * M282 — product-owned, content-free identity for one live Browser shadow
 * conversation turn. The row is reserved before the Human Message exists.
 * It owns turn-level replay, fallback, final-event, and Browser-verification
 * state; per-Message crypto completion remains in
 * `session_message_crypto_revisions`.
 *
 * Recipient private keys, plaintext, ciphertext, manifests, envelopes, Grant
 * bytes, and stream frames are deliberately absent. A process restart closes
 * a live protected attempt because its ephemeral recipient private key is
 * gone; it must never be reconstructed from this receipt.
 */
export const conversationShadowTurnOperations = pgTable(
  "conversation_shadow_turn_operations",
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
    subjectHumanId: text("subject_human_id").notNull(),
    committerDeviceId: text("committer_device_id").notNull(),
    committerDeviceSigningKeyGeneration: bigint(
      "committer_device_signing_key_generation",
      { mode: "number" },
    ),
    hostAuthorizationRevision: bigint("host_authorization_revision", {
      mode: "number",
    }).notNull(),
    agentId: uuid("agent_id").notNull(),
    agentAuthorizationRevision: bigint("agent_authorization_revision", {
      mode: "number",
    }).notNull(),
    namespaceId: uuid("namespace_id").notNull(),
    namespaceAuthorityScheme: text("namespace_authority_scheme")
      .notNull().default("domain_key_v2"),
    namespaceBindingHash: bytea("namespace_binding_hash"),
    namespaceAccessRevision: integer("namespace_access_revision").notNull(),
    namespaceKeyGeneration: integer("namespace_key_generation").notNull(),
    bindingRevisionAtWrap: integer("binding_revision_at_wrap"),
    domainId: text("domain_id"),
    domainEpoch: bigint("domain_epoch", { mode: "number" }),
    namespaceHeadDigest: bytea("namespace_head_digest"),
    namespacePublicationDigest: bytea("namespace_publication_digest"),
    namespacePublicationSetDigest: bytea(
      "namespace_publication_set_digest",
    ),
    namespaceAudienceFingerprint: bytea("namespace_audience_fingerprint"),
    grantDomainId: text("grant_domain_id"),
    grantDomainParticipantDigest: bytea("grant_domain_participant_digest"),
    grantDomainKeyGeneration: bigint("grant_domain_key_generation", {
      mode: "number",
    }),
    grantDomainHeadDigest: bytea("grant_domain_head_digest"),
    grantDomainPublicationDigest: bytea("grant_domain_publication_digest"),
    grantDomainAuthorizationRevision: bigint(
      "grant_domain_authorization_revision",
      { mode: "number" },
    ),
    namespaceBundleRevision: bigint("namespace_bundle_revision", {
      mode: "number",
    }),
    namespaceBundleDigest: bytea("namespace_bundle_digest"),
    agentGrantPlanBytes: bytea("agent_grant_plan_bytes"),
    agentGrantPlanDigest: bytea("agent_grant_plan_digest"),
    recipientId: text("recipient_id").notNull(),
    recipientKeyId: text("recipient_key_id").notNull(),
    recipientPublicKey: bytea("recipient_public_key").notNull(),
    attemptCoordinate: text("attempt_coordinate").notNull(),
    planDigest: bytea("plan_digest").notNull(),
    planBytes: bytea("plan_bytes"),
    humanRequestDigest: bytea("human_request_digest"),
    humanRequestBytes: bytea("human_request_bytes"),
    grantDigest: bytea("grant_digest"),
    finalCausalEventDigest: bytea("final_causal_event_digest"),
    clientVerificationDigest: bytea("client_verification_digest"),
    jobId: uuid("job_id"),
    state: text("state", {
      enum: [
        "planned",
        "human_verified",
        "running",
        "fallback",
        "completed",
        "client_verified",
        "failed",
      ],
    }).notNull().default("planned"),
    terminalStage: text("terminal_stage", {
      enum: [
        "plan",
        "session_establishment",
        "session_reuse",
        "human_admission",
        "agent_input",
        "assistant_stream",
        "assistant_message",
        "tool_call",
        "tool_result",
        "durable_transcript",
        "client_verification",
        "shutdown",
      ],
    }),
    terminalReason: text("terminal_reason", {
      enum: [
        "protected_unavailable",
        "stale_authority",
        "integrity_failure",
        "parity_mismatch",
        "deadline_expired",
        "recipient_lost",
        "cancelled",
        "product_conflict",
        "policy_changed",
        "authority_changed",
        "stream_incomplete",
        "client_unavailable",
        "unsupported_payload",
        "storage_failure",
        "transport_failure",
      ],
    }),
    reconciliationAttemptCount: smallint("reconciliation_attempt_count")
      .notNull().default(0),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "conversation_shadow_turn_operations_session_fk",
      columns: [table.sessionId],
      foreignColumns: [sessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "conversation_shadow_turn_operations_room_fk",
      columns: [table.roomId],
      foreignColumns: [rooms.id],
    }).onDelete("cascade"),
    unique("uq_conversation_shadow_turn_operations_id").on(table.operationId),
    unique("uq_conversation_shadow_turn_operations_attempt").on(
      table.attemptCoordinate,
    ),
    uniqueIndex("uq_conversation_shadow_turn_operations_client_request")
      .on(table.sessionId, table.clientIdempotencyKey),
    uniqueIndex("uq_conversation_shadow_turn_operations_job")
      .on(table.jobId).where(sql`${table.jobId} is not null`),
    index("idx_conversation_shadow_turn_operations_due")
      .on(table.state, table.deadlineAt, table.sequence)
      .where(sql`${table.state} in ('planned', 'human_verified', 'running')`),
    check(
      "conversation_shadow_turn_operations_ids_portable",
      sql`octet_length(${table.operationId}) between 1 and ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_ID_BYTES))
      }
        and ${table.operationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.clientIdempotencyKey}) between 1 and ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_ID_BYTES))
      }
        and ${table.clientIdempotencyKey} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.subjectHumanId}) between 1 and ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_ID_BYTES))
      }
        and ${table.subjectHumanId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.committerDeviceId}) between 1 and ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_ID_BYTES))
      }
        and ${table.committerDeviceId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.domainId}) between 1 and ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_ID_BYTES))
      }
        and ${table.domainId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.grantDomainId}) between 1 and ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_ID_BYTES))
      }
        and ${table.grantDomainId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.recipientId}) between 1 and ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_ID_BYTES))
      }
        and ${table.recipientId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.recipientKeyId}) between 1 and ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_ID_BYTES))
      }
        and ${table.recipientKeyId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length(${table.attemptCoordinate}) between 1 and ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_ID_BYTES))
      }
        and ${table.attemptCoordinate} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'`,
    ),
    check(
      "conversation_shadow_turn_operations_coordinate_shape",
      sql`${table.policyRevision} > 0
        and ${table.humanMessageId} > 0
        and ${table.hostAuthorizationRevision} >= 0
        and ${table.agentAuthorizationRevision} >= 0
        and ${table.namespaceAccessRevision} >= 0
        and ${table.namespaceKeyGeneration} >= 0
        and (${table.committerDeviceSigningKeyGeneration} is null
          or ${table.committerDeviceSigningKeyGeneration} >= 0)
        and (${table.bindingRevisionAtWrap} is null
          or ${table.bindingRevisionAtWrap} >= 0)
        and (${table.domainEpoch} is null or ${table.domainEpoch} >= 0)
        and (${table.grantDomainKeyGeneration} is null
          or ${table.grantDomainKeyGeneration} >= 1)
        and (${table.grantDomainAuthorizationRevision} is null
          or ${table.grantDomainAuthorizationRevision} >= 0)
        and (${table.namespaceBundleRevision} is null
          or ${table.namespaceBundleRevision} >= 1)`,
    ),
    check(
      "conversation_shadow_turn_operations_authority_scheme",
      sql`(${table.namespaceAuthorityScheme} = 'domain_key_v2'
        and ${table.committerDeviceSigningKeyGeneration} is not null
        and ${table.namespaceBindingHash} is null
        and ${table.bindingRevisionAtWrap} is null
        and ${table.domainId} is null
        and ${table.domainEpoch} is null
        and ${table.namespaceHeadDigest} is not null
        and ${table.namespacePublicationDigest} is not null
        and ${table.namespacePublicationSetDigest} is not null
        and ${table.namespaceAudienceFingerprint} is not null
        and ${table.grantDomainId} is not null
        and ${table.grantDomainParticipantDigest} is not null
        and ${table.grantDomainKeyGeneration} is not null
        and ${table.grantDomainHeadDigest} is not null
        and ${table.grantDomainPublicationDigest} is not null
        and ${table.grantDomainAuthorizationRevision} is not null
        and ${table.namespaceBundleRevision} is not null
        and ${table.namespaceBundleDigest} is not null
        and ${table.agentGrantPlanBytes} is not null
        and ${table.agentGrantPlanDigest} is not null
      )`,
    ),
    check(
      "conversation_shadow_turn_operations_digest_shape",
      sql`(${table.namespaceBindingHash} is null or octet_length(${table.namespaceBindingHash}) = ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_DIGEST_BYTES))
      })
        and (${table.namespaceHeadDigest} is null or octet_length(${table.namespaceHeadDigest}) = ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_DIGEST_BYTES))
      })
        and (${table.namespacePublicationDigest} is null or octet_length(${table.namespacePublicationDigest}) = ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_DIGEST_BYTES))
      })
        and (${table.namespacePublicationSetDigest} is null or octet_length(${table.namespacePublicationSetDigest}) = ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_DIGEST_BYTES))
      })
        and (${table.namespaceAudienceFingerprint} is null or octet_length(${table.namespaceAudienceFingerprint}) = ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_DIGEST_BYTES))
      })
        and (${table.grantDomainParticipantDigest} is null or octet_length(${table.grantDomainParticipantDigest}) = ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_DIGEST_BYTES))
      })
        and (${table.grantDomainHeadDigest} is null or octet_length(${table.grantDomainHeadDigest}) = ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_DIGEST_BYTES))
      })
        and (${table.grantDomainPublicationDigest} is null or octet_length(${table.grantDomainPublicationDigest}) = ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_DIGEST_BYTES))
      })
        and (${table.namespaceBundleDigest} is null or octet_length(${table.namespaceBundleDigest}) = ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_DIGEST_BYTES))
      })
        and (${table.agentGrantPlanDigest} is null or octet_length(${table.agentGrantPlanDigest}) = ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_DIGEST_BYTES))
      })
        and (${table.agentGrantPlanBytes} is null or octet_length(${table.agentGrantPlanBytes}) between 1 and ${
          sql.raw(String(CONVERSATION_SHADOW_TURN_AGENT_GRANT_PLAN_BYTES))
        })
        and octet_length(${table.planDigest}) = ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_DIGEST_BYTES))
      }
        and (${table.planBytes} is null or octet_length(${table.planBytes}) between 1 and ${
          sql.raw(String(CONVERSATION_SHADOW_TURN_PLAN_BYTES))
        })
        and (${table.humanRequestDigest} is null or octet_length(${table.humanRequestDigest}) = ${
          sql.raw(String(CONVERSATION_SHADOW_TURN_DIGEST_BYTES))
        })
        and (${table.humanRequestBytes} is null or octet_length(${table.humanRequestBytes}) between 1 and ${
          sql.raw(String(CONVERSATION_SHADOW_TURN_HUMAN_REQUEST_BYTES))
        })
        and (${table.grantDigest} is null or octet_length(${table.grantDigest}) = ${
          sql.raw(String(CONVERSATION_SHADOW_TURN_DIGEST_BYTES))
        })
        and (${table.finalCausalEventDigest} is null or octet_length(${table.finalCausalEventDigest}) = ${
          sql.raw(String(CONVERSATION_SHADOW_TURN_DIGEST_BYTES))
        })
        and (${table.clientVerificationDigest} is null or octet_length(${table.clientVerificationDigest}) = ${
          sql.raw(String(CONVERSATION_SHADOW_TURN_DIGEST_BYTES))
        })`,
    ),
    check(
      "conversation_shadow_turn_operations_recipient_key_shape",
      sql`octet_length(${table.recipientPublicKey}) = ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_RECIPIENT_PUBLIC_KEY_BYTES))
      }`,
    ),
    check(
      "conversation_shadow_turn_operations_receipt_coherent",
      sql`((${table.planBytes} is null and ${table.humanRequestBytes} is null)
          or (${table.planBytes} is not null
            and ${table.humanRequestBytes} is not null
            and ${table.humanRequestDigest} is not null))
        and (${table.humanRequestDigest} is null) = (${table.grantDigest} is null)
        and (${table.state} not in ('human_verified', 'running', 'completed', 'client_verified')
          or ${table.humanRequestDigest} is not null)
        and (${table.clientVerificationDigest} is null
          or ${table.state} in ('client_verified', 'failed'))
        and (${table.finalCausalEventDigest} is null
          or ${table.state} in ('completed', 'client_verified'))`,
    ),
    check(
      "conversation_shadow_turn_operations_terminal_coherent",
      sql`(
        ${table.state} in ('planned', 'human_verified', 'running')
        and ${table.terminalStage} is null
        and ${table.terminalReason} is null
        and ${table.terminalAt} is null
      ) or (
        ${table.state} in ('fallback', 'failed')
        and ${table.terminalStage} is not null
        and ${table.terminalReason} is not null
        and ${table.terminalAt} is not null
      ) or (
        ${table.state} in ('completed', 'client_verified')
        and ${table.terminalStage} is null
        and ${table.terminalReason} is null
        and ${table.terminalAt} is not null
      )`,
    ),
    check(
      "conversation_shadow_turn_operations_attempt_bound",
      sql`${table.reconciliationAttemptCount} between 0 and ${
        sql.raw(String(CONVERSATION_SHADOW_TURN_MAX_RECONCILIATION_ATTEMPTS))
      }`,
    ),
    check(
      "conversation_shadow_turn_operations_time_order",
      sql`${table.deadlineAt} > ${table.createdAt}
        and (${table.startedAt} is null or ${table.startedAt} >= ${table.createdAt})
        and (${table.terminalAt} is null or ${table.terminalAt} >= ${table.createdAt})
        and ${table.updatedAt} >= ${table.createdAt}`,
    ),
    pgPolicy("conversation_shadow_turn_operations_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

export type ConversationShadowTurnOperation =
  typeof conversationShadowTurnOperations.$inferSelect;
export type NewConversationShadowTurnOperation =
  typeof conversationShadowTurnOperations.$inferInsert;

/** Immutable public signer coordinates for the process-local Agent key that
 * one Human-signed live turn plan authorizes. Kept additive so an older
 * content-free attempt can remain terminal without inventing key material. */
export const conversationShadowTurnAgentSigners = pgTable(
  "conversation_shadow_turn_agent_signers",
  {
    operationId: text("operation_id").primaryKey(),
    agentRuntimeGeneration: bigint("agent_runtime_generation", {
      mode: "number",
    }).notNull(),
    agentSignerKeyId: text("agent_signer_key_id").notNull(),
    agentSignerPublicKey: bytea("agent_signer_public_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull().defaultNow(),
  },
  (table) => [
    index("idx_shadow_turn_retained_signer").on(
      table.agentSignerKeyId,
      table.agentRuntimeGeneration,
      table.createdAt,
      table.operationId,
    ),
    foreignKey({
      name: "conversation_shadow_turn_agent_signers_operation_fk",
      columns: [table.operationId],
      foreignColumns: [conversationShadowTurnOperations.operationId],
    }).onDelete("cascade"),
    check(
      "conversation_shadow_turn_agent_signers_shape",
      sql`${table.agentRuntimeGeneration} >= 0
        and octet_length(${table.agentSignerKeyId}) between 1 and ${
          sql.raw(String(CONVERSATION_SHADOW_TURN_ID_BYTES))
        }
        and ${table.agentSignerKeyId} ~ '^agent_runtime_signer_[0-9a-f]{64}$'
        and octet_length(${table.agentSignerPublicKey}) = ${
          sql.raw(String(CONVERSATION_SHADOW_TURN_AGENT_SIGNER_PUBLIC_KEY_BYTES))
        }`,
    ),
    pgPolicy("conversation_shadow_turn_agent_signers_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

/**
 * One retry-idempotent denominator for an eligible Browser send. It exists
 * before restricted crypto readiness is inspected, so an unavailable device,
 * Domain, or Room Namespace is observable without fabricating a turn plan.
 * Replanning the same ordinary send updates this row and can link it to the
 * single durable turn operation; it never creates a second denominator.
 */
export const conversationShadowTurnPlanAttempts = pgTable(
  "conversation_shadow_turn_plan_attempts",
  {
    sequence: serial("sequence").primaryKey(),
    sessionId: uuid("session_id").notNull(),
    roomId: uuid("room_id").notNull(),
    clientIdempotencyKey: text("client_idempotency_key").notNull(),
    policyRevision: integer("policy_revision").notNull(),
    subjectUserId: uuid("subject_user_id").notNull(),
    subjectHumanActorId: uuid("subject_human_actor_id").notNull(),
    state: text("state", {
      enum: ["checking", "planned", "unavailable"],
    }).notNull().default("checking"),
    unavailableReason: text("unavailable_reason", {
      enum: [
        "device_unavailable",
        "agent_authority_unavailable",
        "domain_unavailable",
        "namespace_unavailable",
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
      name: "conversation_shadow_turn_plan_attempts_session_fk",
      columns: [table.sessionId],
      foreignColumns: [sessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "conversation_shadow_turn_plan_attempts_room_fk",
      columns: [table.roomId],
      foreignColumns: [rooms.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "conversation_shadow_turn_plan_attempts_operation_fk",
      columns: [table.operationId],
      foreignColumns: [conversationShadowTurnOperations.operationId],
    }).onDelete("cascade"),
    uniqueIndex("uq_conversation_shadow_turn_plan_attempts_request")
      .on(table.sessionId, table.clientIdempotencyKey),
    uniqueIndex("uq_conversation_shadow_turn_plan_attempts_operation")
      .on(table.operationId).where(sql`${table.operationId} is not null`),
    check(
      "conversation_shadow_turn_plan_attempts_shape",
      sql`${table.policyRevision} > 0
        and octet_length(${table.clientIdempotencyKey}) between 1 and ${
          sql.raw(String(CONVERSATION_SHADOW_TURN_ID_BYTES))
        }
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
        )`,
    ),
    check(
      "conversation_shadow_turn_plan_attempts_time_order",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    pgPolicy("conversation_shadow_turn_plan_attempts_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

export type ConversationShadowTurnPlanAttempt =
  typeof conversationShadowTurnPlanAttempts.$inferSelect;
export type NewConversationShadowTurnPlanAttempt =
  typeof conversationShadowTurnPlanAttempts.$inferInsert;
