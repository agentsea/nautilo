import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgPolicy,
  pgRole,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { jobs } from "./jobs";
import { rooms } from "./rooms";
import { taskRuns } from "./task-runs";
import { tasks } from "./tasks";
import { users } from "./users";

const productRole = pgRole("nautilo").existing();

/**
 * Content-free CloudConvert lifecycle receipt. Source and destination bytes,
 * logical paths, credentials, and export URLs never enter this table.
 */
export const conversionOperations = pgTable(
  "conversion_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationKey: varchar("operation_key", { length: 64 }).notNull(),
    /** Opaque user-facing recovery handle; it grants no authority by itself. */
    recoveryHandle: varchar("recovery_handle", { length: 36 }).notNull(),
    causalHumanUserId: uuid("causal_human_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    roomId: uuid("room_id").references(() => rooms.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => taskRuns.id, { onDelete: "set null" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    fundingKind: varchar("funding_kind", {
      length: 16,
      enum: ["personal", "server"],
    }).notNull(),
    providerRoute: text("provider_route").notNull(),
    providerSandbox: boolean("provider_sandbox").notNull(),
    providerRegion: varchar("provider_region", { length: 32 }),
    credentialId: uuid("credential_id"),
    credentialRevision: integer("credential_revision"),
    /** Hash of the exact admitted provider-account credential revision. */
    credentialFingerprint: varchar("credential_fingerprint", { length: 64 }).notNull(),
    sourceKind: varchar("source_kind", {
      length: 16,
      enum: ["inline", "artifact"],
    }).notNull(),
    sourceArtifactId: uuid("source_artifact_id"),
    sourceArtifactRevision: integer("source_artifact_revision"),
    sourceSha256: varchar("source_sha256", { length: 64 }).notNull(),
    sourceAuthorityDigest: varchar("source_authority_digest", { length: 64 }).notNull(),
    destinationArtifactId: uuid("destination_artifact_id"),
    destinationArtifactRevision: integer("destination_artifact_revision"),
    destinationNamespaceId: uuid("destination_namespace_id").notNull(),
    destinationPathDigest: varchar("destination_path_digest", { length: 64 }).notNull(),
    destinationAuthorityDigest: varchar("destination_authority_digest", { length: 64 }).notNull(),
    inputFormat: varchar("input_format", { length: 32 }).notNull(),
    outputFormat: varchar("output_format", { length: 32 }).notNull(),
    maxOutputBytes: integer("max_output_bytes").notNull(),
    /** Opaque lookup tag. CloudConvert does not treat this as idempotency. */
    providerTag: varchar("provider_tag", { length: 64 }).notNull(),
    providerJobId: text("provider_job_id"),
    /** Fences a live provider create request from cross-process recovery. */
    submissionLeaseId: varchar("submission_lease_id", { length: 64 }),
    submissionLeaseExpiresAt: timestamp("submission_lease_expires_at", { withTimezone: true }),
    cancellationRequestedAt: timestamp("cancellation_requested_at", { withTimezone: true }),
    status: varchar("status", {
      length: 32,
      enum: [
        "prepared",
        "submitting",
        "submission_unknown",
        "submitted",
        "processing",
        "provider_finished",
        "ready_to_publish",
        "publication_committing",
        "published",
        "cancel_requested",
        "cancelled",
        "failed",
        "publication_failed",
        "expired",
        "recovery_ambiguous",
      ],
    }).notNull().default("prepared"),
    providerCredits: numeric("provider_credits", { precision: 20, scale: 8 }),
    outputSha256: varchar("output_sha256", { length: 64 }),
    outputBytes: bigint("output_bytes", { mode: "number" }),
    publicationRevisionId: uuid("publication_revision_id"),
    publicationArtifactId: text("publication_artifact_id"),
    failureCode: text("failure_code"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    pgPolicy("conversion_operations_product_all", {
      as: "permissive", for: "all", to: productRole, using: sql`true`, withCheck: sql`true`,
    }),
    uniqueIndex("uq_conversion_operations_operation_key").on(table.operationKey),
    uniqueIndex("uq_conversion_operations_recovery_handle").on(table.recoveryHandle),
    uniqueIndex("uq_conversion_operations_provider_tag").on(table.providerTag),
    index("idx_conversion_operations_provider_job").on(table.providerJobId),
    index("idx_conversion_operations_recovery").on(table.status, table.updatedAt),
    index("idx_conversion_operations_human").on(table.causalHumanUserId, table.createdAt),
    check("conversion_operations_operation_key_digest", sql`${table.operationKey} ~ '^[0-9a-f]{64}$'`),
    check("conversion_operations_recovery_handle_shape", sql`${table.recoveryHandle} ~ '^cvr_[0-9a-f]{32}$'`),
    check("conversion_operations_credential_fingerprint_digest", sql`${table.credentialFingerprint} ~ '^[0-9a-f]{64}$'`),
    check("conversion_operations_source_sha_digest", sql`${table.sourceSha256} ~ '^[0-9a-f]{64}$'`),
    check("conversion_operations_source_authority_digest", sql`${table.sourceAuthorityDigest} ~ '^[0-9a-f]{64}$'`),
    check("conversion_operations_destination_path_digest", sql`${table.destinationPathDigest} ~ '^[0-9a-f]{64}$'`),
    check("conversion_operations_destination_authority_digest", sql`${table.destinationAuthorityDigest} ~ '^[0-9a-f]{64}$'`),
    check("conversion_operations_output_sha_digest", sql`${table.outputSha256} IS NULL OR ${table.outputSha256} ~ '^[0-9a-f]{64}$'`),
    check("conversion_operations_version_positive", sql`${table.version} > 0`),
    check("conversion_operations_output_bytes_nonnegative", sql`${table.outputBytes} IS NULL OR ${table.outputBytes} >= 0`),
    check("conversion_operations_max_output_bytes_positive", sql`${table.maxOutputBytes} > 0`),
    check("conversion_operations_provider_credits_nonnegative", sql`${table.providerCredits} IS NULL OR ${table.providerCredits} >= 0`),
    check(
      "conversion_operations_funding_binding",
      sql`(
        (${table.fundingKind} = 'personal' AND ${table.credentialId} IS NOT NULL AND ${table.credentialRevision} >= 1)
        OR (${table.fundingKind} = 'server' AND ${table.credentialId} IS NULL AND ${table.credentialRevision} IS NULL)
      )`,
    ),
    check(
      "conversion_operations_source_binding",
      sql`(
        (${table.sourceKind} = 'inline' AND ${table.sourceArtifactId} IS NULL AND ${table.sourceArtifactRevision} IS NULL)
        OR (${table.sourceKind} = 'artifact' AND ${table.sourceArtifactId} IS NOT NULL AND ${table.sourceArtifactRevision} >= 1)
      )`,
    ),
    check(
      "conversion_operations_provider_job_phase",
      sql`(
        (${table.status} IN ('prepared', 'submitting', 'submission_unknown', 'recovery_ambiguous') AND ${table.providerJobId} IS NULL)
        OR (${table.status} NOT IN ('prepared', 'submitting', 'submission_unknown', 'recovery_ambiguous') AND ${table.providerJobId} IS NOT NULL)
        OR (${table.status} = 'cancelled' AND ${table.providerJobId} IS NULL
          AND ${table.failureCode} IS NOT DISTINCT FROM 'cancelled_before_provider_dispatch')
      )`,
    ),
    check(
      "conversion_operations_submission_lease",
      sql`(
        (${table.status} = 'submitting' AND ${table.submissionLeaseId} IS NOT NULL AND ${table.submissionLeaseExpiresAt} IS NOT NULL)
        OR (${table.status} <> 'submitting' AND ${table.submissionLeaseId} IS NULL AND ${table.submissionLeaseExpiresAt} IS NULL)
      )`,
    ),
    check(
      "conversion_operations_publication_receipt",
      sql`(
        (${table.status} = 'published' AND ${table.publicationRevisionId} IS NOT NULL AND ${table.publicationArtifactId} IS NOT NULL AND ${table.publishedAt} IS NOT NULL)
        OR (${table.status} <> 'published' AND ${table.publicationRevisionId} IS NULL AND ${table.publicationArtifactId} IS NULL AND ${table.publishedAt} IS NULL)
      )`,
    ),
  ],
).enableRLS();

export type ConversionOperation = typeof conversionOperations.$inferSelect;
export type NewConversionOperation = typeof conversionOperations.$inferInsert;
