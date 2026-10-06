import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  integer,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { protectedTaskExecutionSegmentReceipts } from
  "./protected-task-execution-segment-receipts";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});
const nautiloProductRole = pgRole("nautilo").existing();

/**
 * Immutable authority to continue one exact protected native segment.
 *
 * A row exists only for a closed checkpoint boundary or an interrupt that was
 * durably parked before its external effect. Uncertain effects deliberately
 * have no resumable representation in this table. A database trigger rejects
 * direct mutation while permitting its exact segment's foreign-key cascade.
 */
export const protectedTaskContinuationReceipts = pgTable(
  "protected_task_continuation_receipts",
  {
    taskRunId: uuid("task_run_id").notNull(),
    executionSegment: integer("execution_segment").notNull(),
    jobId: uuid("job_id").notNull(),
    kind: text("kind", {
      enum: ["checkpoint_safe_v1", "pre_effect_interrupt_v1"],
    }).notNull(),
    reason: text("reason", {
      enum: [
        "manual_pause",
        "time_limit",
        "grant_refresh",
        "additional_authority",
      ],
    }).notNull(),
    effectDisposition: text("effect_disposition", {
      enum: ["none_v1", "not_started_v1"],
    }).notNull(),
    interruptId: text("interrupt_id"),
    operationId: text("operation_id"),
    requestDigest: bytea("request_digest"),
    requiredAuthorityDigest: bytea("required_authority_digest"),
    sealedAt: timestamp("sealed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "protected_task_continuation_receipts_pkey",
      columns: [table.taskRunId, table.executionSegment],
    }),
    unique("uq_protected_task_continuation_receipts_job").on(table.jobId),
    foreignKey({
      name: "protected_task_continuation_receipts_segment_fk",
      columns: [table.taskRunId, table.executionSegment, table.jobId],
      foreignColumns: [
        protectedTaskExecutionSegmentReceipts.taskRunId,
        protectedTaskExecutionSegmentReceipts.executionSegment,
        protectedTaskExecutionSegmentReceipts.jobId,
      ],
    }).onDelete("cascade"),
    check(
      "protected_task_continuation_receipts_segment_resumable",
      sql`${table.executionSegment} between 1 and 2147483646`,
    ),
    check(
      "protected_task_continuation_receipts_shape_coherent",
      sql`(
        ${table.kind} = 'checkpoint_safe_v1'
        and ${table.reason} in ('manual_pause', 'time_limit', 'grant_refresh')
        and ${table.effectDisposition} = 'none_v1'
        and ${table.interruptId} is null
        and ${table.operationId} is null
        and ${table.requestDigest} is null
        and ${table.requiredAuthorityDigest} is null
      ) or (
        ${table.kind} = 'pre_effect_interrupt_v1'
        and ${table.reason} in ('grant_refresh', 'additional_authority')
        and ${table.effectDisposition} = 'not_started_v1'
        and ${table.interruptId} is not null
        and ${table.interruptId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and ${table.operationId} is not null
        and ${table.operationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and ${table.requestDigest} is not null
        and octet_length(${table.requestDigest}) = 32
        and ${table.requiredAuthorityDigest} is not null
        and octet_length(${table.requiredAuthorityDigest}) = 32
      )`,
    ),
    pgPolicy("protected_task_continuation_receipts_product_select", {
      as: "permissive",
      for: "select",
      to: nautiloProductRole,
      using: sql`true`,
    }),
    pgPolicy("protected_task_continuation_receipts_product_insert", {
      as: "permissive",
      for: "insert",
      to: nautiloProductRole,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

export type ProtectedTaskContinuationReceipt =
  typeof protectedTaskContinuationReceipts.$inferSelect;
export type NewProtectedTaskContinuationReceipt =
  typeof protectedTaskContinuationReceipts.$inferInsert;
export type ProtectedTaskContinuationKind =
  ProtectedTaskContinuationReceipt["kind"];
export type ProtectedTaskContinuationReason =
  ProtectedTaskContinuationReceipt["reason"];
