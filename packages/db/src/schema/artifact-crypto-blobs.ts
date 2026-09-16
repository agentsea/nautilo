import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  index,
  integer,
  pgPolicy,
  pgRole,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { ARTIFACT_CIPHERTEXT_MAX_BYTES } from "./artifacts";

export const ARTIFACT_CRYPTO_HASH_BYTES = 32;
export const ARTIFACT_CRYPTO_ID_BYTES = 128;
export const ARTIFACT_CRYPTO_STORAGE_REF_BYTES = 512;

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});
const nautiloProductRole = pgRole("nautilo").existing();

/** M261 — immutable ciphertext file generation; never plaintext or a key. */
export const artifactCryptoBlobs = pgTable(
  "artifact_crypto_blobs",
  {
    sequence: serial("sequence").primaryKey(),
    /** Preallocated internal Artifact UUID; the product row is published later. */
    artifactRowId: uuid("artifact_row_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    blobId: text("blob_id").notNull(),
    blobGeneration: integer("blob_generation").notNull(),
    publicationOperationId: text("publication_operation_id").notNull(),
    storageRef: text("storage_ref").notNull(),
    ciphertextLength: bigint("ciphertext_length", { mode: "number" }).notNull(),
    ciphertextSha256: bytea("ciphertext_sha256").notNull(),
    state: text("state", {
      enum: ["staging", "published", "orphaned", "quarantined"],
    }).notNull().default("staging"),
    failureCode: text("failure_code", {
      enum: [
        "storage_transient",
        "publication_conflict",
        "ciphertext_mismatch",
        "orphan_expired",
        "retry_exhausted",
      ],
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
  },
  (table) => [
    unique("uq_artifact_crypto_blobs_id").on(table.blobId),
    unique("uq_artifact_crypto_blobs_publication_operation").on(
      table.publicationOperationId,
    ),
    unique("uq_artifact_crypto_blobs_generation").on(
      table.artifactRowId,
      table.artifactId,
      table.blobGeneration,
    ),
    unique("uq_artifact_crypto_blobs_exact_reference").on(
      table.blobId,
      table.artifactRowId,
      table.artifactId,
      table.blobGeneration,
    ),
    index("idx_artifact_crypto_blobs_state").on(table.state, table.sequence),
    check(
      "artifact_crypto_blobs_ids_portable",
      sql`${table.artifactId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and ${table.blobId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and octet_length(${table.publicationOperationId}) between 1 and ${sql.raw(String(ARTIFACT_CRYPTO_ID_BYTES))}
        and ${table.publicationOperationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'`,
    ),
    check("artifact_crypto_blobs_generation_positive", sql`${table.blobGeneration} > 0`),
    check(
      "artifact_crypto_blobs_storage_ref_safe",
      sql`octet_length(${table.storageRef}) between 1 and ${sql.raw(String(ARTIFACT_CRYPTO_STORAGE_REF_BYTES))}
        and ${table.storageRef} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and ${table.storageRef} !~ '(^|/)\\.\\.(/|$)'
        and ${table.storageRef} !~ '^file:'`,
    ),
    check(
      "artifact_crypto_blobs_ciphertext_bounded",
      sql`${table.ciphertextLength} > 0
        and ${table.ciphertextLength} <= ${sql.raw(String(ARTIFACT_CIPHERTEXT_MAX_BYTES))}
        and octet_length(${table.ciphertextSha256}) = ${sql.raw(String(ARTIFACT_CRYPTO_HASH_BYTES))}`,
    ),
    check(
      "artifact_crypto_blobs_lifecycle_coherent",
      sql`(
        ${table.state} = 'staging'
        and ${table.failureCode} is null
        and ${table.publishedAt} is null
        and ${table.terminalAt} is null
      ) or (
        ${table.state} = 'published'
        and ${table.failureCode} is null
        and ${table.publishedAt} is not null
        and ${table.terminalAt} is null
      ) or (
        ${table.state} in ('orphaned', 'quarantined')
        and ${table.failureCode} is not null
        and ${table.terminalAt} is not null
      )`,
    ),
    check(
      "artifact_crypto_blobs_failure_code_check",
      sql`${table.failureCode} is null or ${table.failureCode} in (
        'storage_transient', 'publication_conflict', 'ciphertext_mismatch',
        'orphan_expired', 'retry_exhausted'
      )`,
    ),
    pgPolicy("artifact_crypto_blobs_product_all", {
      as: "permissive", for: "all", to: nautiloProductRole,
      using: sql`true`, withCheck: sql`true`,
    }),
  ],
).enableRLS();

export type ArtifactCryptoBlob = typeof artifactCryptoBlobs.$inferSelect;
export type NewArtifactCryptoBlob = typeof artifactCryptoBlobs.$inferInsert;
