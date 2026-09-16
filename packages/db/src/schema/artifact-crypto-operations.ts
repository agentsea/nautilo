import { sql } from "drizzle-orm";
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
} from "drizzle-orm/pg-core";
import { ARTIFACT_CRYPTO_HASH_BYTES, ARTIFACT_CRYPTO_ID_BYTES } from "./artifact-crypto-blobs";

export const ARTIFACT_CRYPTO_OPERATION_MAX_ATTEMPTS = 8;

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});
const nautiloProductRole = pgRole("nautilo").existing();

/** M261 — content-free identity and bounded retry for one Artifact publication. */
export const artifactCryptoOperations = pgTable(
  "artifact_crypto_operations",
  {
    sequence: serial("sequence").primaryKey(),
    operationId: text("operation_id").notNull(),
    /** Preallocated internal Artifact UUID; the product row is published later. */
    artifactRowId: uuid("artifact_row_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    anchorNamespaceId: uuid("anchor_namespace_id").notNull(),
    operationType: text("operation_type", {
      enum: ["create", "content", "control", "access"],
    }).notNull(),
    expectedArtifactRevision: integer("expected_artifact_revision").notNull(),
    resultArtifactRevision: integer("result_artifact_revision").notNull(),
    expectedAccessRevision: integer("expected_access_revision").notNull(),
    resultAccessRevision: integer("result_access_revision").notNull(),
    expectedBlobGeneration: integer("expected_blob_generation").notNull(),
    resultBlobGeneration: integer("result_blob_generation").notNull(),
    expectedBlobId: text("expected_blob_id"),
    resultBlobId: text("result_blob_id").notNull(),
    requestDigest: bytea("request_digest").notNull(),
    expectedRequiredNamespaceFingerprint: bytea(
      "expected_required_namespace_fingerprint",
    ),
    targetRequiredNamespaceFingerprint: bytea(
      "target_required_namespace_fingerprint",
    ).notNull(),
    completion: text("completion", { enum: ["pending", "complete"] })
      .notNull().default("pending"),
    disposition: text("disposition", {
      enum: ["active", "complete", "blocked", "quarantined"],
    }).notNull().default("active"),
    attemptCount: smallint("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    failureCode: text("failure_code", {
      enum: [
        "namespace_unresolved", "crypto_absent", "crypto_incomplete",
        "crypto_mismatch", "authorization_unavailable", "recipient_unavailable",
        "target_encryption_not_ready", "blob_unavailable", "blob_mismatch",
        "storage_transient", "mapping_conflict", "retry_exhausted",
      ],
    }),
    cryptoCompletedAt: timestamp("crypto_completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_artifact_crypto_operations_id").on(table.operationId),
    index("idx_artifact_crypto_operations_artifact").on(
      table.artifactRowId, table.sequence,
    ),
    index("idx_artifact_crypto_operations_due")
      .on(table.disposition, table.nextAttemptAt, table.sequence, table.completion)
      .where(sql`${table.disposition} = 'active'`),
    check(
      "artifact_crypto_operations_ids_portable",
      sql`octet_length(${table.operationId}) between 1 and ${sql.raw(String(ARTIFACT_CRYPTO_ID_BYTES))}
        and ${table.operationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and ${table.artifactId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and (${table.expectedBlobId} is null or ${table.expectedBlobId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        and ${table.resultBlobId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "artifact_crypto_operations_shape",
      sql`(
        ${table.operationType} = 'create'
        and ${table.expectedArtifactRevision} = 0
        and ${table.resultArtifactRevision} = 1
        and ${table.expectedAccessRevision} = 0
        and ${table.resultAccessRevision} = 0
        and ${table.expectedBlobGeneration} = 0
        and ${table.resultBlobGeneration} = 1
        and ${table.expectedBlobId} is null
        and ${table.expectedRequiredNamespaceFingerprint} is null
      ) or (
        ${table.operationType} = 'content'
        and ${table.expectedArtifactRevision} > 0
        and ${table.resultArtifactRevision} = ${table.expectedArtifactRevision} + 1
        and ${table.expectedAccessRevision} >= 0
        and ${table.resultAccessRevision} = 0
        and ${table.expectedBlobGeneration} > 0
        and ${table.resultBlobGeneration} = ${table.expectedBlobGeneration} + 1
        and ${table.expectedBlobId} is not null
        and ${table.resultBlobId} <> ${table.expectedBlobId}
        and ${table.expectedRequiredNamespaceFingerprint} is not null
      ) or (
        ${table.operationType} = 'control'
        and ${table.expectedArtifactRevision} > 0
        and ${table.resultArtifactRevision} = ${table.expectedArtifactRevision} + 1
        and ${table.expectedAccessRevision} >= 0
        and ${table.resultAccessRevision} = 0
        and ${table.expectedBlobGeneration} > 0
        and ${table.resultBlobGeneration} = ${table.expectedBlobGeneration}
        and ${table.expectedBlobId} is not null
        and ${table.resultBlobId} = ${table.expectedBlobId}
        and ${table.expectedRequiredNamespaceFingerprint} is not null
      ) or (
        ${table.operationType} = 'access'
        and ${table.expectedArtifactRevision} > 0
        and ${table.resultArtifactRevision} = ${table.expectedArtifactRevision}
        and ${table.expectedAccessRevision} >= 0
        and ${table.resultAccessRevision} = ${table.expectedAccessRevision} + 1
        and ${table.expectedBlobGeneration} > 0
        and ${table.resultBlobGeneration} = ${table.expectedBlobGeneration}
        and ${table.expectedBlobId} is not null
        and ${table.resultBlobId} = ${table.expectedBlobId}
        and ${table.expectedRequiredNamespaceFingerprint} is not null
      )`,
    ),
    check(
      "artifact_crypto_operations_digest_sizes",
      sql`octet_length(${table.requestDigest}) = ${sql.raw(String(ARTIFACT_CRYPTO_HASH_BYTES))}
        and (${table.expectedRequiredNamespaceFingerprint} is null
          or octet_length(${table.expectedRequiredNamespaceFingerprint}) = ${sql.raw(String(ARTIFACT_CRYPTO_HASH_BYTES))})
        and octet_length(${table.targetRequiredNamespaceFingerprint}) = ${sql.raw(String(ARTIFACT_CRYPTO_HASH_BYTES))}`,
    ),
    check(
      "artifact_crypto_operations_completion_coherent",
      sql`(
        ${table.completion} = 'pending'
        and ${table.cryptoCompletedAt} is null
        and ${table.disposition} in ('active', 'blocked', 'quarantined')
      ) or (
        ${table.completion} = 'complete'
        and ${table.cryptoCompletedAt} is not null
        and ${table.disposition} = 'complete'
      )`,
    ),
    check(
      "artifact_crypto_operations_retry_coherent",
      sql`${table.attemptCount} between 0 and ${sql.raw(String(ARTIFACT_CRYPTO_OPERATION_MAX_ATTEMPTS))}
        and (${table.leaseToken} is null) = (${table.leaseExpiresAt} is null)`,
    ),
    check(
      "artifact_crypto_operations_failure_code_check",
      sql`(
        ${table.disposition} in ('active', 'complete')
        and ${table.failureCode} is null
      ) or (
        ${table.disposition} in ('blocked', 'quarantined')
        and ${table.failureCode} in (
        'namespace_unresolved', 'crypto_absent', 'crypto_incomplete',
        'crypto_mismatch', 'authorization_unavailable', 'recipient_unavailable',
        'target_encryption_not_ready', 'blob_unavailable', 'blob_mismatch',
        'storage_transient', 'mapping_conflict', 'retry_exhausted'
        )
      )`,
    ),
    pgPolicy("artifact_crypto_operations_product_all", {
      as: "permissive", for: "all", to: nautiloProductRole,
      using: sql`true`, withCheck: sql`true`,
    }),
  ],
).enableRLS();

export type ArtifactCryptoOperation = typeof artifactCryptoOperations.$inferSelect;
export type NewArtifactCryptoOperation = typeof artifactCryptoOperations.$inferInsert;
