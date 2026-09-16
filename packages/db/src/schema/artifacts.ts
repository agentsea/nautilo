/**
 * M088B — Artifact DB index (M:N junction shape).
 *
 * Artifacts are namespace-gated content (like memory), not flat filesystem
 * paths. This table is the authority for artifact identity, agent scope,
 * logical path, and physical storage pointer.
 *
 * As of M088B the row no longer carries `namespace_id` / `scope_id`
 * directly. Namespace attachment lives in the `artifact_namespaces`
 * junction (mirrors `memory_namespaces` from M076); subagent-scope
 * attachment lives in `artifact_scopes` (mirrors `memory_scopes` from
 * M080). One artifact row may attach to multiple Namespaces — that is
 * the substrate `share_artifact` writes through.
 *
 * Bytes live under the server-owned artifact root
 * (`~/.nautilo/artifacts/<uuid>` by default; `NAUTILO_ARTIFACTS_ROOT`
 * overrides). `storage_uri` resolves to the corresponding `file://...`
 * URI. The DB row is what makes the artifact visible: a file on disk
 * without a row is invisible to the `file` tool's `workspace` zone.
 *
 * `artifact_id` is the stable external identifier returned to tools and
 * future UI. Generated at insert time via `crypto.randomUUID()`.
 *
 * `path` is logical/user-visible. `storage_uri` is physical/opaque.
 * Renames update `path`; bytes do not move. `share_artifact` inserts an
 * additional `artifact_namespaces` row; bytes do not move.
 */

import {
  bigint,
  check,
  customType,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { cryptoObjects } from "./crypto-storage";

export const ARTIFACT_CIPHERTEXT_MAX_BYTES = 105 * 1024 * 1024;

const bytea = customType<{
  data: Uint8Array;
  driverData: Uint8Array;
}>({ dataType: () => "bytea" });

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: text("artifact_id").notNull(),
    path: text("path"),
    mimeType: text("mime_type").default("application/octet-stream"),
    size: bigint("size", { mode: "number" }).default(0),
    storageUri: text("storage_uri"),
    revision: integer("revision").notNull().default(1),
    /** M261 — current encrypted ArtifactControlV1 object, never blob bytes. */
    cryptoObjectId: text("crypto_object_id").references(
      () => cryptoObjects.objectId,
      { onDelete: "no action" },
    ),
    cryptoAccessRevision: integer("crypto_access_revision"),
    cryptoRequiredNamespaceFingerprint: bytea(
      "crypto_required_namespace_fingerprint",
    ),
    /** Whether the retained crypto coordinates are currently selectable. */
    cryptoMappingState: text("crypto_mapping_state", {
      enum: ["unmapped", "verified", "stale"],
    }).notNull().default("unmapped"),
    /** Opaque immutable blob routing coordinates; no filesystem URI. */
    blobId: text("blob_id"),
    blobGeneration: integer("blob_generation"),
    ciphertextLength: bigint("ciphertext_length", { mode: "number" }),
    ciphertextSha256: bytea("ciphertext_sha256"),
    mimeClass: text("mime_class", {
      enum: ["text", "image", "audio", "video", "document", "archive", "binary"],
    }),
    sizeBucket: text("size_bucket", {
      enum: ["empty", "le_64_kib", "le_1_mib", "le_10_mib", "le_100_mib"],
    }),
    cryptoLifecycleState: text("crypto_lifecycle_state", {
      enum: ["active", "archived", "quarantined"],
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uniq_artifacts_artifact_id").on(table.artifactId),
    unique("uq_artifacts_crypto_object_id").on(table.cryptoObjectId),
    check("artifacts_revision_positive", sql`${table.revision} > 0`),
    check(
      "artifacts_crypto_mapping_coherent",
      sql`(
        ${table.cryptoObjectId} is null
        and ${table.cryptoMappingState} = 'unmapped'
        and ${table.path} is not null
        and ${table.mimeType} is not null
        and ${table.size} is not null
        and ${table.storageUri} is not null
        and ${table.cryptoAccessRevision} is null
        and ${table.cryptoRequiredNamespaceFingerprint} is null
        and ${table.blobId} is null
        and ${table.blobGeneration} is null
        and ${table.ciphertextLength} is null
        and ${table.ciphertextSha256} is null
        and ${table.mimeClass} is null
        and ${table.sizeBucket} is null
        and ${table.cryptoLifecycleState} is null
      ) or (
        ${table.cryptoObjectId} is not null
        and ${table.cryptoMappingState} in ('verified', 'stale')
        and (
          (
            ${table.path} is not null
            and ${table.mimeType} is not null
            and ${table.size} is not null
            and ${table.storageUri} is not null
          ) or (
            ${table.path} is null
            and ${table.mimeType} is null
            and ${table.size} is null
            and ${table.storageUri} is null
          )
        )
        and ${table.artifactId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and ${table.cryptoObjectId} ~ '^artifact:v1:[0-9a-f]{64}$'
        and ${table.cryptoAccessRevision} >= 0
        and octet_length(${table.cryptoRequiredNamespaceFingerprint}) = 32
        and ${table.blobId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and ${table.blobGeneration} > 0
        and ${table.ciphertextLength} > 0
        and ${table.ciphertextLength} <= ${sql.raw(String(ARTIFACT_CIPHERTEXT_MAX_BYTES))}
        and octet_length(${table.ciphertextSha256}) = 32
        and ${table.mimeClass} in ('text', 'image', 'audio', 'video', 'document', 'archive', 'binary')
        and ${table.sizeBucket} in ('empty', 'le_64_kib', 'le_1_mib', 'le_10_mib', 'le_100_mib')
        and ${table.cryptoLifecycleState} in ('active', 'archived', 'quarantined')
      )`,
    ),
  ],
);

export type ArtifactRow = typeof artifacts.$inferSelect;
/**
 * Ordinary production repositories admit legacy rows and Shadow dual-form
 * rows while plaintext remains authoritative. Keep their public shape
 * non-null so protected-only rows are excluded instead of partially exposed.
 */
export type Artifact = Pick<
  ArtifactRow,
  "id" | "artifactId" | "revision" | "createdAt" | "updatedAt" | "deletedAt"
> & {
  path: string;
  mimeType: string;
  size: number;
  storageUri: string;
};
export type NewArtifact = typeof artifacts.$inferInsert;
