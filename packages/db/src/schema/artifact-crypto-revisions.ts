import { sql } from "drizzle-orm";
import {
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
  uuid,
} from "drizzle-orm/pg-core";
import {
  ARTIFACT_CRYPTO_HASH_BYTES,
  artifactCryptoBlobs,
} from "./artifact-crypto-blobs";

export const ARTIFACT_CRYPTO_REVISION_MAX_ATTEMPTS = 8;

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});
const nautiloProductRole = pgRole("nautilo").existing();

/** M261 — one encrypted ArtifactControlV1 object per Artifact revision. */
export const artifactCryptoRevisions = pgTable(
  "artifact_crypto_revisions",
  {
    sequence: serial("sequence").primaryKey(),
    /** Preallocated internal Artifact UUID; the product row is published later. */
    artifactRowId: uuid("artifact_row_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    artifactRevision: integer("artifact_revision").notNull(),
    anchorNamespaceId: uuid("anchor_namespace_id").notNull(),
    cryptoObjectId: text("crypto_object_id").notNull(),
    payloadVersion: smallint("payload_version").notNull().default(1),
    allocationRequestDigest: bytea("allocation_request_digest").notNull(),
    requiredNamespaceFingerprint: bytea("required_namespace_fingerprint").notNull(),
    blobId: text("blob_id").notNull(),
    blobGeneration: integer("blob_generation").notNull(),
    /** Closed routing buckets; never exact MIME or plaintext length. */
    mimeClass: text("mime_class", {
      enum: ["text", "image", "audio", "video", "document", "archive", "binary"],
    }).notNull(),
    sizeBucket: text("size_bucket", {
      enum: ["empty", "le_64_kib", "le_1_mib", "le_10_mib", "le_100_mib"],
    }).notNull(),
    blobReferenceState: text("blob_reference_state", {
      enum: ["retained", "released"],
    }).notNull().default("retained"),
    completion: text("completion", { enum: ["pending", "complete"] })
      .notNull().default("pending"),
    disposition: text("disposition", {
      enum: ["active", "mapped", "blocked", "quarantined", "superseded", "stale_mapping"],
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
    unique("uq_artifact_crypto_revisions_internal_coordinate").on(
      table.artifactRowId, table.artifactRevision,
    ),
    unique("uq_artifact_crypto_revisions_stable_coordinate").on(
      table.artifactId, table.artifactRevision,
    ),
    unique("uq_artifact_crypto_revisions_object").on(table.cryptoObjectId),
    index("idx_artifact_crypto_revisions_due")
      .on(table.disposition, table.nextAttemptAt, table.sequence, table.completion)
      .where(sql`${table.disposition} = 'active'`),
    foreignKey({
      name: "artifact_crypto_revisions_exact_blob_fk",
      columns: [table.blobId, table.artifactRowId, table.artifactId, table.blobGeneration],
      foreignColumns: [
        artifactCryptoBlobs.blobId,
        artifactCryptoBlobs.artifactRowId,
        artifactCryptoBlobs.artifactId,
        artifactCryptoBlobs.blobGeneration,
      ],
    }).onDelete("restrict"),
    check(
      "artifact_crypto_revisions_identity_shape",
      sql`${table.artifactRevision} > 0
        and ${table.blobGeneration} > 0
        and ${table.payloadVersion} = 1
        and ${table.artifactId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and ${table.cryptoObjectId} ~ '^artifact:v1:[0-9a-f]{64}$'
        and ${table.blobId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and ${table.mimeClass} in ('text', 'image', 'audio', 'video', 'document', 'archive', 'binary')
        and ${table.sizeBucket} in ('empty', 'le_64_kib', 'le_1_mib', 'le_10_mib', 'le_100_mib')`,
    ),
    check(
      "artifact_crypto_revisions_digest_sizes",
      sql`octet_length(${table.allocationRequestDigest}) = ${sql.raw(String(ARTIFACT_CRYPTO_HASH_BYTES))}
        and octet_length(${table.requiredNamespaceFingerprint}) = ${sql.raw(String(ARTIFACT_CRYPTO_HASH_BYTES))}`,
    ),
    check(
      "artifact_crypto_revisions_lifecycle_coherent",
      sql`(
        ${table.completion} = 'pending'
        and ${table.cryptoCompletedAt} is null
        and ${table.disposition} in ('active', 'blocked', 'quarantined')
      ) or (
        ${table.completion} = 'complete'
        and ${table.cryptoCompletedAt} is not null
        and ${table.disposition} in ('active', 'mapped', 'quarantined', 'superseded', 'stale_mapping')
      )`,
    ),
    check(
      "artifact_crypto_revisions_reference_coherent",
      sql`${table.blobReferenceState} = 'retained'
        or (${table.blobReferenceState} = 'released'
          and ${table.disposition} in ('quarantined', 'superseded', 'stale_mapping'))`,
    ),
    check(
      "artifact_crypto_revisions_retry_coherent",
      sql`${table.attemptCount} between 0 and ${sql.raw(String(ARTIFACT_CRYPTO_REVISION_MAX_ATTEMPTS))}
        and (${table.leaseToken} is null) = (${table.leaseExpiresAt} is null)`,
    ),
    check(
      "artifact_crypto_revisions_failure_code_check",
      sql`(
        ${table.disposition} in ('active', 'mapped', 'superseded')
        and ${table.failureCode} is null
      ) or (
        ${table.disposition} in ('blocked', 'quarantined', 'stale_mapping')
        and ${table.failureCode} in (
        'namespace_unresolved', 'crypto_absent', 'crypto_incomplete',
        'crypto_mismatch', 'authorization_unavailable', 'recipient_unavailable',
        'target_encryption_not_ready', 'blob_unavailable', 'blob_mismatch',
        'storage_transient', 'mapping_conflict', 'retry_exhausted'
        )
      )`,
    ),
    pgPolicy("artifact_crypto_revisions_product_all", {
      as: "permissive", for: "all", to: nautiloProductRole,
      using: sql`true`, withCheck: sql`true`,
    }),
  ],
).enableRLS();

export type ArtifactCryptoRevision = typeof artifactCryptoRevisions.$inferSelect;
export type NewArtifactCryptoRevision = typeof artifactCryptoRevisions.$inferInsert;
