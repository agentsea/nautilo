import { sql } from "drizzle-orm";
import { check, customType, index, integer, pgPolicy, pgRole, pgTable, serial, smallint, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { namespaces } from "./trust";
import { TASK_CRYPTO_DIGEST_BYTES, TASK_CRYPTO_FAILURE_CODES, TASK_CRYPTO_MAX_ATTEMPTS, TASK_CRYPTO_PORTABLE_ID_BYTES } from "./task-definition-crypto-revisions";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => "bytea" });
const nautiloProductRole = pgRole("nautilo").existing();

/** Product-owned receipt and lifecycle for one protected TaskRun result revision. */
export const taskRunResultCryptoRevisions = pgTable(
  "task_run_result_crypto_revisions",
  {
    sequence: serial("sequence").primaryKey(),
    taskId: uuid("task_id").notNull(),
    taskRunId: uuid("task_run_id").notNull(),
    contentNamespaceId: uuid("content_namespace_id").notNull(),
    resultRevision: integer("result_revision").notNull(),
    operationId: text("operation_id").notNull(),
    requestDigest: bytea("request_digest").notNull(),
    authorityFingerprint: bytea("authority_fingerprint").notNull(),
    requesterHumanId: uuid("requester_human_id").notNull(),
    anchorNamespaceId: uuid("anchor_namespace_id").notNull().references(
      () => namespaces.id,
      { onDelete: "restrict" },
    ),
    cryptoObjectId: text("crypto_object_id").notNull(),
    representation: text("representation", {
      enum: ["protected", "dual"],
    }).notNull(),
    payloadVersion: smallint("payload_version").notNull().default(1),
    cryptoAccessRevision: integer("crypto_access_revision").notNull().default(0),
    requiredNamespaceFingerprint: bytea("required_namespace_fingerprint").notNull(),
    completion: text("completion", { enum: ["pending", "complete"] }).notNull().default("pending"),
    disposition: text("disposition", { enum: ["active", "mapped", "quarantined", "stale_mapping"] }).notNull().default("active"),
    attemptCount: smallint("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    failureCode: text("failure_code", { enum: TASK_CRYPTO_FAILURE_CODES }),
    cryptoCompletedAt: timestamp("crypto_completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_task_run_result_crypto_revisions_coordinate").on(table.taskRunId, table.resultRevision),
    unique("uq_task_run_result_crypto_revisions_mapping").on(table.taskId, table.taskRunId, table.contentNamespaceId, table.resultRevision, table.cryptoObjectId, table.requiredNamespaceFingerprint),
    unique("uq_task_run_result_crypto_revisions_operation").on(table.operationId),
    unique("uq_task_run_result_crypto_revisions_object").on(table.cryptoObjectId),
    index("idx_task_run_result_crypto_revisions_due").on(table.disposition, table.nextAttemptAt, table.sequence, table.completion).where(sql`${table.disposition} = 'active'`),
    index("idx_task_run_result_crypto_revisions_task").on(table.taskId, table.taskRunId, table.resultRevision),
    check("task_run_result_crypto_revisions_revision_positive", sql`${table.resultRevision} > 0`),
    check("task_run_result_crypto_revisions_payload_version", sql`${table.payloadVersion} = 1`),
    check("task_run_result_crypto_revisions_access_revision", sql`${table.cryptoAccessRevision} = 0`),
    check("task_run_result_crypto_revisions_namespace_authority", sql`${table.contentNamespaceId} = ${table.anchorNamespaceId}`),
    check("task_run_result_crypto_revisions_operation_portable", sql`octet_length(${table.operationId}) between 1 and ${sql.raw(String(TASK_CRYPTO_PORTABLE_ID_BYTES))} and ${table.operationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'`),
    check("task_run_result_crypto_revisions_object_shape", sql`${table.cryptoObjectId} ~ '^task-run-result:v1:[0-9a-f]{64}$'`),
    check("task_run_result_crypto_revisions_digest_sizes", sql`octet_length(${table.requestDigest}) = ${sql.raw(String(TASK_CRYPTO_DIGEST_BYTES))} and octet_length(${table.authorityFingerprint}) = ${sql.raw(String(TASK_CRYPTO_DIGEST_BYTES))} and octet_length(${table.requiredNamespaceFingerprint}) = ${sql.raw(String(TASK_CRYPTO_DIGEST_BYTES))}`),
    check("task_run_result_crypto_revisions_retry_coherent", sql`${table.attemptCount} between 0 and ${sql.raw(String(TASK_CRYPTO_MAX_ATTEMPTS))} and (${table.leaseToken} is null) = (${table.leaseExpiresAt} is null)`),
    check("task_run_result_crypto_revisions_lifecycle_coherent", sql`(${table.completion} = 'pending' and ${table.cryptoCompletedAt} is null and ${table.disposition} in ('active', 'quarantined')) or (${table.completion} = 'complete' and ${table.cryptoCompletedAt} is not null and ${table.disposition} in ('active', 'mapped', 'quarantined', 'stale_mapping'))`),
    check("task_run_result_crypto_revisions_failure_coherent", sql`(${table.disposition} in ('active', 'mapped') and ${table.failureCode} is null) or (${table.disposition} in ('quarantined', 'stale_mapping') and ${table.failureCode} in ('authority_stale', 'crypto_absent', 'crypto_incomplete', 'crypto_mismatch', 'storage_transient', 'mapping_conflict', 'retry_exhausted'))`),
    pgPolicy("task_run_result_crypto_revisions_product_all", { as: "permissive", for: "all", to: nautiloProductRole, using: sql`true`, withCheck: sql`true` }),
  ],
).enableRLS();

export type TaskRunResultCryptoRevision = typeof taskRunResultCryptoRevisions.$inferSelect;
export type NewTaskRunResultCryptoRevision = typeof taskRunResultCryptoRevisions.$inferInsert;
