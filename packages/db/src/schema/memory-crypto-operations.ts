import { sql, type SQL } from "drizzle-orm";
import {
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  serial,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const MEMORY_CRYPTO_OPERATION_DIGEST_BYTES = 32;
export const MEMORY_CRYPTO_OPERATION_MAX_ATTEMPTS = 8;
export const MEMORY_CRYPTO_OPERATION_ID_BYTES = 128;

const bytea = customType<{
  data: Uint8Array;
  driverData: Uint8Array;
}>({ dataType: () => "bytea" });

const nautiloProductRole = pgRole("nautilo").existing();
const nautiloAgentRole = pgRole("nautilo_agent").existing();

export type HumanMemoryProductOutcomeV1 = Readonly<{
  formatVersion: 1;
  memoryId: string;
  contentRevision: number;
  cryptoAccessRevision: number;
  importance: number;
  tier: number;
  createdAt: string;
  updatedAt: string;
  namespaceIds: readonly string[];
  requiredNamespaceIds: readonly string[];
  scopeOrigin: "seed" | "scope" | null;
}>;

function agentMemoryOperationScope(anchorNamespaceId: AnyPgColumn): SQL {
  return sql`app_current_user_id() is not null
    and exists (
      select 1
        from public.rooms memory_operation_room
        join public.actors memory_operation_actor
          on memory_operation_actor.id = any(memory_operation_room.human_actor_ids)
       where memory_operation_room.namespace_id = ${anchorNamespaceId}
         and memory_operation_actor.owner_id = app_current_user_id()
         and memory_operation_actor.kind = 'user'
         and app_agent_in_room(memory_operation_room.id)
    )`;
}

/**
 * M243 — append-only identity and bounded retry state for every logical
 * protected Memory update, access-set change, or hard delete.
 *
 * Repeated access changes intentionally receive separate rows. There is no FK
 * to memories or crypto objects so exact replay survives product deletion.
 */
export const memoryCryptoOperations = pgTable(
  "memory_crypto_operations",
  {
    sequence: serial("sequence").primaryKey(),
    operationId: text("operation_id").notNull(),
    memoryId: uuid("memory_id").notNull(),
    anchorNamespaceId: uuid("anchor_namespace_id").notNull(),
    /**
     * `metadata` covers replay-safe product mutations such as tier changes
     * that require fresh crypto authorization but do not advance ciphertext
     * or access-manifest revisions.
     */
    operationType: text("operation_type", {
      enum: ["update", "access", "delete", "metadata"],
    }).notNull(),
    expectedContentRevision: integer("expected_content_revision").notNull(),
    resultContentRevision: integer("result_content_revision"),
    expectedAccessRevision: integer("expected_access_revision").notNull(),
    resultAccessRevision: integer("result_access_revision"),
    requestDigest: bytea("request_digest").notNull(),
    targetRequiredNamespaceFingerprint: bytea(
      "target_required_namespace_fingerprint",
    ),
    completion: text("completion", {
      enum: ["pending", "complete", "ordinary_fallback"],
    }).notNull().default("pending"),
    disposition: text("disposition", {
      enum: ["active", "complete", "blocked", "quarantined"],
    }).notNull().default("active"),
    attemptCount: smallint("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
    }).defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    failureCode: text("failure_code", {
      enum: [
        "namespace_unresolved",
        "scope_origin_unresolved",
        "crypto_absent",
        "crypto_incomplete",
        "crypto_mismatch",
        "authorization_unavailable",
        "recipient_unavailable",
        "target_encryption_not_ready",
        "embedding_unavailable",
        "storage_transient",
        "mapping_conflict",
        "retry_exhausted",
      ],
    }),
    cryptoCompletedAt: timestamp("crypto_completed_at", {
      withTimezone: true,
    }),
    ordinaryFallbackCompletedAt: timestamp(
      "ordinary_fallback_completed_at",
      { withTimezone: true },
    ),
    ordinaryFallbackReason: text("ordinary_fallback_reason", {
      enum: ["encryption_pending", "target_encryption_not_ready"],
    }),
    /**
     * Content-free foreground semantic effect retained on the mutation
     * receipt. `operationId` is its stable delivery identity; acknowledgement
     * is deliberately separate from product completion so delivery failure
     * never rolls back or misreports an already committed mutation.
     *
     * A future pruning owner may treat a null kind as effect-ineligible and a
     * non-null kind as effect-eligible only after acknowledgement. Product
     * completion, retention and access checks remain separate prerequisites.
     */
    semanticChangeKind: text("semantic_change_kind", {
      enum: ["replace", "demote", "archive", "restore", "scope", "delete"],
    }),
    semanticChangeAcknowledgedAt: timestamp(
      "semantic_change_acknowledged_at",
      { withTimezone: true },
    ),
    foregroundStableRequestDigest: bytea("foreground_stable_request_digest"),
    foregroundMutationKind: text("foreground_mutation_kind", {
      enum: ["save", "replace", "promote", "demote"],
    }),
    foregroundRequiredNamespaceIds: uuid(
      "foreground_required_namespace_ids",
    ).array(),
    foregroundSaveSimilarity: doublePrecision("foreground_save_similarity"),
    humanProductOutcome: jsonb("human_product_outcome")
      .$type<HumanMemoryProductOutcomeV1>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => {
    const agentScope = agentMemoryOperationScope(table.anchorNamespaceId);
    return [
      unique("uq_memory_crypto_operations_id").on(table.operationId),
      index("idx_memory_crypto_operations_due")
        .on(
          table.disposition,
          table.nextAttemptAt,
          table.sequence,
          table.completion,
        )
        .where(sql`${table.disposition} = 'active'`),
      index("idx_memory_crypto_operations_memory").on(
        table.memoryId,
        table.sequence,
      ),
      index("idx_memory_crypto_operations_unacknowledged_semantic_effect")
        .on(table.sequence)
        .where(sql`${table.completion} in ('complete', 'ordinary_fallback')
          and ${table.semanticChangeKind} is not null
          and ${table.semanticChangeAcknowledgedAt} is null`),
      check(
        "memory_crypto_operations_id_portable",
        sql`octet_length(${table.operationId}) between 1 and ${
          sql.raw(String(MEMORY_CRYPTO_OPERATION_ID_BYTES))
        }
          and ${table.operationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'`,
      ),
      check(
        "memory_crypto_operations_revisions_nonnegative",
        sql`${table.expectedContentRevision} >= 0
          and ${table.expectedAccessRevision} >= 0
          and (${table.resultContentRevision} is null or ${table.resultContentRevision} > 0)
          and (${table.resultAccessRevision} is null or ${table.resultAccessRevision} >= 0)`,
      ),
      check(
        "memory_crypto_operations_request_digest_size",
        sql`octet_length(${table.requestDigest}) = ${
          sql.raw(String(MEMORY_CRYPTO_OPERATION_DIGEST_BYTES))
        }`,
      ),
      check(
        "memory_crypto_operations_shape",
        sql`(
          ${table.operationType} = 'update'
          and ${table.resultContentRevision} = ${table.expectedContentRevision} + 1
          and ${table.resultAccessRevision} is null
          and ${table.targetRequiredNamespaceFingerprint} is null
        ) or (
          ${table.operationType} = 'access'
          and ${table.resultContentRevision} is null
          and ${table.resultAccessRevision} = ${table.expectedAccessRevision} + 1
          and octet_length(${table.targetRequiredNamespaceFingerprint}) = ${
            sql.raw(String(MEMORY_CRYPTO_OPERATION_DIGEST_BYTES))
          }
        ) or (
          ${table.operationType} = 'delete'
          and ${table.resultContentRevision} is null
          and ${table.resultAccessRevision} is null
          and ${table.targetRequiredNamespaceFingerprint} is null
        ) or (
          ${table.operationType} = 'metadata'
          and ${table.resultContentRevision} is null
          and ${table.resultAccessRevision} is null
          and ${table.targetRequiredNamespaceFingerprint} is null
        )`,
      ),
      check(
        "memory_crypto_operations_completion_coherent",
        sql`(
          ${table.completion} = 'pending'
          and ${table.cryptoCompletedAt} is null
          and ${table.ordinaryFallbackCompletedAt} is null
          and ${table.ordinaryFallbackReason} is null
          and ${table.disposition} in ('active', 'blocked', 'quarantined')
        ) or (
          ${table.completion} = 'complete'
          and ${table.cryptoCompletedAt} is not null
          and ${table.ordinaryFallbackCompletedAt} is null
          and ${table.ordinaryFallbackReason} is null
          and ${table.disposition} = 'complete'
        ) or (
          ${table.completion} = 'ordinary_fallback'
          and ${table.cryptoCompletedAt} is null
          and ${table.ordinaryFallbackCompletedAt} is not null
          and ${table.ordinaryFallbackReason} is not null
          and ${table.ordinaryFallbackReason} in (
            'encryption_pending', 'target_encryption_not_ready'
          )
          and ${table.disposition} = 'complete'
        )`,
      ),
      check(
        "memory_crypto_operations_attempt_bound",
        sql`${table.attemptCount} between 0 and ${
          sql.raw(String(MEMORY_CRYPTO_OPERATION_MAX_ATTEMPTS))
        }`,
      ),
      check(
        "memory_crypto_operations_lease_coherent",
        sql`(${table.leaseToken} is null) = (${table.leaseExpiresAt} is null)`,
      ),
      check(
        "memory_crypto_operations_semantic_change_ack_coherent",
        sql`(
          ${table.semanticChangeKind} is null
          or ${table.semanticChangeKind} in (
            'replace', 'demote', 'archive', 'restore', 'scope', 'delete'
          )
        ) and (
          ${table.semanticChangeAcknowledgedAt} is null or (
            ${table.semanticChangeKind} is not null
            and ${table.completion} in ('complete', 'ordinary_fallback')
          )
        )`,
      ),
      check(
        "memory_crypto_operations_foreground_replay_coherent",
        sql`(
          ${table.foregroundStableRequestDigest} is null
          and ${table.foregroundMutationKind} is null
          and ${table.foregroundRequiredNamespaceIds} is null
          and ${table.foregroundSaveSimilarity} is null
        ) or (
          ${table.foregroundStableRequestDigest} is not null
          and ${table.foregroundMutationKind} is not null
          and ${table.foregroundRequiredNamespaceIds} is not null
          and octet_length(${table.foregroundStableRequestDigest}) = ${
            sql.raw(String(MEMORY_CRYPTO_OPERATION_DIGEST_BYTES))
          }
          and ${table.foregroundMutationKind} in ('save', 'replace', 'promote', 'demote')
          and cardinality(${table.foregroundRequiredNamespaceIds}) > 0
          and array_position(${table.foregroundRequiredNamespaceIds}, null) is null
          and (
            (${table.foregroundMutationKind} = 'save'
              and (${table.foregroundSaveSimilarity} is null
                or ${table.foregroundSaveSimilarity} between -1 and 1))
            or (${table.foregroundMutationKind} <> 'save'
              and ${table.foregroundSaveSimilarity} is null)
          )
        )`,
      ),
      check(
        "memory_crypto_operations_human_outcome_coherent",
        sql`${table.humanProductOutcome} is null or (
          ${table.completion} in ('complete', 'ordinary_fallback')
          and ${table.disposition} = 'complete'
        )`,
      ),
      pgPolicy("memory_crypto_operations_product_all", {
        as: "permissive",
        for: "all",
        to: nautiloProductRole,
        using: sql`true`,
        withCheck: sql`true`,
      }),
      pgPolicy("memory_crypto_operations_agent_select", {
        as: "permissive",
        for: "select",
        to: nautiloAgentRole,
        using: agentScope,
      }),
      pgPolicy("memory_crypto_operations_agent_insert", {
        as: "permissive",
        for: "insert",
        to: nautiloAgentRole,
        withCheck: agentScope,
      }),
      pgPolicy("memory_crypto_operations_agent_update", {
        as: "permissive",
        for: "update",
        to: nautiloAgentRole,
        using: agentScope,
        withCheck: agentScope,
      }),
    ];
  },
).enableRLS();

export type MemoryCryptoOperation = typeof memoryCryptoOperations.$inferSelect;
export type NewMemoryCryptoOperation =
  typeof memoryCryptoOperations.$inferInsert;
