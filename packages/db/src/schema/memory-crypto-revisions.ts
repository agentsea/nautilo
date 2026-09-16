import { sql, type SQL } from "drizzle-orm";
import {
  check,
  customType,
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
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const MEMORY_CRYPTO_REVISION_DIGEST_BYTES = 32;
export const MEMORY_CRYPTO_REVISION_MAX_ATTEMPTS = 8;
export const MEMORY_CRYPTO_REVISION_ID_BYTES = 128;

const bytea = customType<{
  data: Uint8Array;
  driverData: Uint8Array;
}>({ dataType: () => "bytea" });

const nautiloProductRole = pgRole("nautilo").existing();
const nautiloAgentRole = pgRole("nautilo_agent").existing();

function portableId(name: string, column: AnyPgColumn) {
  return check(
    name,
    sql`${column} is null or (
      octet_length(${column}) between 1 and ${
        sql.raw(String(MEMORY_CRYPTO_REVISION_ID_BYTES))
      }
      and ${column} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
    )`,
  );
}

function agentMemoryReceiptScope(anchorNamespaceId: AnyPgColumn): SQL {
  return sql`app_current_user_id() is not null
    and exists (
      select 1
        from public.rooms memory_receipt_room
        join public.actors memory_receipt_actor
          on memory_receipt_actor.id = any(memory_receipt_room.human_actor_ids)
       where memory_receipt_room.namespace_id = ${anchorNamespaceId}
         and memory_receipt_actor.owner_id = app_current_user_id()
         and memory_receipt_actor.kind = 'user'
         and app_agent_in_room(memory_receipt_room.id)
    )`;
}

/**
 * M243 — content-free product lifecycle for protected Memory revisions.
 *
 * There is intentionally no FK to memories or crypto_objects: allocation is
 * product-first, crypto completion uses a separate restricted role, and exact
 * terminal replay must survive physical Memory/object retirement.
 */
export const memoryCryptoRevisions = pgTable(
  "memory_crypto_revisions",
  {
    sequence: serial("sequence").primaryKey(),
    memoryId: uuid("memory_id").notNull(),
    contentRevision: integer("content_revision").notNull(),
    anchorNamespaceId: uuid("anchor_namespace_id").notNull(),
    cryptoObjectId: text("crypto_object_id").notNull(),
    payloadVersion: smallint("payload_version").notNull().default(1),
    allocationRequestDigest: bytea("allocation_request_digest").notNull(),
    requiredNamespaceFingerprint: bytea(
      "required_namespace_fingerprint",
    ).notNull(),
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
    attemptCount: smallint("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
    }).defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** Closed code only: never provider text, content, or a stack trace. */
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => {
    const agentScope = agentMemoryReceiptScope(table.anchorNamespaceId);
    return [
      unique("uq_memory_crypto_revisions_coordinate").on(
        table.memoryId,
        table.contentRevision,
      ),
      unique("uq_memory_crypto_revisions_object").on(table.cryptoObjectId),
      index("idx_memory_crypto_revisions_due")
        .on(
          table.disposition,
          table.nextAttemptAt,
          table.sequence,
          table.completion,
        )
        .where(sql`${table.disposition} = 'active'`),
      index("idx_memory_crypto_revisions_memory").on(
        table.memoryId,
        table.contentRevision,
      ),
      check(
        "memory_crypto_revisions_revision_positive",
        sql`${table.contentRevision} > 0`,
      ),
      check(
        "memory_crypto_revisions_payload_version",
        sql`${table.payloadVersion} = 1`,
      ),
      check(
        "memory_crypto_revisions_allocation_digest_size",
        sql`octet_length(${table.allocationRequestDigest}) = ${
          sql.raw(String(MEMORY_CRYPTO_REVISION_DIGEST_BYTES))
        }`,
      ),
      check(
        "memory_crypto_revisions_namespace_fingerprint_size",
        sql`octet_length(${table.requiredNamespaceFingerprint}) = ${
          sql.raw(String(MEMORY_CRYPTO_REVISION_DIGEST_BYTES))
        }`,
      ),
      check(
        "memory_crypto_revisions_completion_check",
        sql`${table.completion} in ('pending', 'complete')`,
      ),
      check(
        "memory_crypto_revisions_disposition_check",
        sql`${table.disposition} in (
          'active', 'mapped', 'blocked', 'quarantined',
          'superseded', 'hard_delete', 'stale_mapping'
        )`,
      ),
      check(
        "memory_crypto_revisions_completion_coherent",
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
        "memory_crypto_revisions_attempt_bound",
        sql`${table.attemptCount} between 0 and ${
          sql.raw(String(MEMORY_CRYPTO_REVISION_MAX_ATTEMPTS))
        }`,
      ),
      check(
        "memory_crypto_revisions_lease_coherent",
        sql`(${table.leaseToken} is null) = (${table.leaseExpiresAt} is null)`,
      ),
      portableId(
        "memory_crypto_revisions_object_id_portable",
        table.cryptoObjectId,
      ),
      pgPolicy("memory_crypto_revisions_product_all", {
        as: "permissive",
        for: "all",
        to: nautiloProductRole,
        using: sql`true`,
        withCheck: sql`true`,
      }),
      pgPolicy("memory_crypto_revisions_agent_select", {
        as: "permissive",
        for: "select",
        to: nautiloAgentRole,
        using: agentScope,
      }),
      pgPolicy("memory_crypto_revisions_agent_insert", {
        as: "permissive",
        for: "insert",
        to: nautiloAgentRole,
        withCheck: agentScope,
      }),
      pgPolicy("memory_crypto_revisions_agent_update", {
        as: "permissive",
        for: "update",
        to: nautiloAgentRole,
        using: agentScope,
        withCheck: agentScope,
      }),
    ];
  },
).enableRLS();

export type MemoryCryptoRevision = typeof memoryCryptoRevisions.$inferSelect;
export type NewMemoryCryptoRevision =
  typeof memoryCryptoRevisions.$inferInsert;
