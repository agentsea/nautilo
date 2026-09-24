import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, integer, check, customType, foreignKey } from "drizzle-orm/pg-core";
import { tasks } from "./tasks";
import { jobs } from "./jobs";
import { cryptoObjects } from "./crypto-storage";
import { namespaces } from "./trust";
import { taskRunResultCryptoRevisions } from "./task-run-result-crypto-revisions";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

export const taskRuns = pgTable(
  "task_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    graphThreadId: text("graph_thread_id").notNull(),
    status: text("status", {
      enum: ["running", "awaiting", "paused", "completed", "cancelled", "errored"],
    }).notNull().default("running"),
    modelId: text("model_id"),
    resultText: text("result_text"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    resultRepresentation: text("result_representation", {
      enum: ["ordinary", "dual", "protected"],
    }).notNull().default("ordinary"),
    resultContentNamespaceId: uuid("result_content_namespace_id").references(
      () => namespaces.id,
      { onDelete: "restrict" },
    ),
    resultRevision: integer("result_revision").notNull().default(0),
    resultCryptoObjectId: text("result_crypto_object_id").references(
      () => cryptoObjects.objectId,
      { onDelete: "no action" },
    ),
    resultCryptoAccessRevision: integer("result_crypto_access_revision").notNull().default(0),
    resultCryptoRequiredNamespaceFingerprint: bytea("result_crypto_required_namespace_fingerprint"),
    resultCryptoMappingState: text("result_crypto_mapping_state", {
      enum: ["unmapped", "verified", "stale"],
    }).notNull().default("unmapped"),
  },
  (t) => [
    index("task_runs_task_idx").on(t.taskId, t.startedAt),
    foreignKey({
      name: "task_runs_current_crypto_result_revision_fk",
      columns: [t.taskId, t.id, t.resultContentNamespaceId, t.resultRevision, t.resultCryptoObjectId, t.resultCryptoRequiredNamespaceFingerprint],
      foreignColumns: [
        taskRunResultCryptoRevisions.taskId,
        taskRunResultCryptoRevisions.taskRunId,
        taskRunResultCryptoRevisions.contentNamespaceId,
        taskRunResultCryptoRevisions.resultRevision,
        taskRunResultCryptoRevisions.cryptoObjectId,
        taskRunResultCryptoRevisions.requiredNamespaceFingerprint,
      ],
    }).onDelete("restrict"),
    check("task_runs_result_revision_nonnegative", sql`${t.resultRevision} >= 0`),
    check("task_runs_result_crypto_access_revision_nonnegative", sql`${t.resultCryptoAccessRevision} >= 0`),
    check("task_runs_result_crypto_mapping_coherent", sql`(
      ${t.resultRepresentation} = 'ordinary'
      and ${t.resultContentNamespaceId} is null
      and ${t.resultRevision} = 0
      and ${t.resultCryptoObjectId} is null
      and ${t.resultCryptoAccessRevision} = 0
      and ${t.resultCryptoRequiredNamespaceFingerprint} is null
      and ${t.resultCryptoMappingState} = 'unmapped'
    ) or (
      ${t.resultRepresentation} in ('dual', 'protected')
      and ${t.resultContentNamespaceId} is not null
      and ${t.resultRevision} > 0
      and ${t.resultCryptoObjectId} is not null
      and ${t.resultCryptoAccessRevision} >= 0
      and octet_length(${t.resultCryptoRequiredNamespaceFingerprint}) = 32
      and ${t.resultCryptoMappingState} in ('verified', 'stale')
      and (${t.resultRepresentation} <> 'protected' or (${t.resultText} is null and ${t.lastError} is null))
    )`),
  ],
);

export type TaskRun = typeof taskRuns.$inferSelect;
export type NewTaskRun = typeof taskRuns.$inferInsert;
