import { sql } from "drizzle-orm";
import {
  check,
  customType,
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

import { taskRuns } from "./task-runs";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});
const nautiloProductRole = pgRole("nautilo").existing();

/**
 * Immutable, content-free proof of the physical writers closed by one
 * protected Task execution segment. These manifests do not prove that an
 * external effect did or did not happen. A database trigger rejects direct
 * mutation while permitting TaskRun and child-receipt foreign-key work.
 */
export const protectedTaskExecutionSegmentReceipts = pgTable(
  "protected_task_execution_segment_receipts",
  {
    taskRunId: uuid("task_run_id")
      .notNull()
      .references(() => taskRuns.id, { onDelete: "cascade" }),
    executionSegment: integer("execution_segment").notNull(),
    jobId: uuid("job_id").notNull(),
    route: text("route", {
      enum: [
        "native_langgraph_v1",
        "hermes_acp_v1",
        "opencode_acp_v1",
        "codex_acp_v1",
        "claude_code_acp_v1",
      ],
    }).notNull(),
    transcriptContract: text("transcript_contract", {
      enum: ["none_v1", "protected_message_associations_v1"],
    }).notNull(),
    expectedTranscriptAssociationCount: integer(
      "expected_transcript_association_count",
    ).notNull(),
    transcriptAssociationDigest: bytea("transcript_association_digest"),
    checkpointContract: text("checkpoint_contract", {
      enum: ["none_v1", "encrypted_langgraph_v1"],
    }).notNull(),
    expectedCheckpointCount: integer("expected_checkpoint_count").notNull(),
    checkpointDigest: bytea("checkpoint_digest"),
    expectedCheckpointBlobCount: integer(
      "expected_checkpoint_blob_count",
    ).notNull(),
    checkpointBlobDigest: bytea("checkpoint_blob_digest"),
    expectedPendingWriteCount: integer(
      "expected_pending_write_count",
    ).notNull(),
    pendingWriteDigest: bytea("pending_write_digest"),
    sealedAt: timestamp("sealed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "protected_task_execution_segment_receipts_pkey",
      columns: [table.taskRunId, table.executionSegment],
    }),
    unique("uq_protected_task_execution_segment_receipts_job")
      .on(table.jobId),
    unique("uq_protected_task_execution_segment_receipts_identity")
      .on(table.taskRunId, table.executionSegment, table.jobId),
    check(
      "protected_task_execution_segment_receipts_segment_positive",
      sql`${table.executionSegment} > 0`,
    ),
    check(
      "protected_task_execution_segment_receipts_counts_nonnegative",
      sql`${table.expectedTranscriptAssociationCount} >= 0
        and ${table.expectedCheckpointCount} >= 0
        and ${table.expectedCheckpointBlobCount} >= 0
        and ${table.expectedPendingWriteCount} >= 0`,
    ),
    check(
      "protected_task_execution_segment_receipts_transcript_coherent",
      sql`(
        ${table.transcriptContract} = 'none_v1'
        and ${table.expectedTranscriptAssociationCount} = 0
        and ${table.transcriptAssociationDigest} is null
      ) or (
        ${table.transcriptContract} = 'protected_message_associations_v1'
        and ${table.transcriptAssociationDigest} is not null
        and octet_length(${table.transcriptAssociationDigest}) = 32
      )`,
    ),
    check(
      "protected_task_execution_segment_receipts_checkpoint_coherent",
      sql`(
        ${table.checkpointContract} = 'none_v1'
        and ${table.expectedCheckpointCount} = 0
        and ${table.expectedCheckpointBlobCount} = 0
        and ${table.expectedPendingWriteCount} = 0
        and ${table.checkpointDigest} is null
        and ${table.checkpointBlobDigest} is null
        and ${table.pendingWriteDigest} is null
      ) or (
        ${table.checkpointContract} = 'encrypted_langgraph_v1'
        and ${table.checkpointDigest} is not null
        and octet_length(${table.checkpointDigest}) = 32
        and ${table.checkpointBlobDigest} is not null
        and octet_length(${table.checkpointBlobDigest}) = 32
        and ${table.pendingWriteDigest} is not null
        and octet_length(${table.pendingWriteDigest}) = 32
      )`,
    ),
    check(
      "protected_task_execution_segment_receipts_route_coherent",
      sql`(
        ${table.route} = 'native_langgraph_v1'
        and ${table.transcriptContract}
          = 'protected_message_associations_v1'
        and ${table.checkpointContract} = 'encrypted_langgraph_v1'
      ) or (
        ${table.route} in (
          'hermes_acp_v1', 'opencode_acp_v1', 'codex_acp_v1',
          'claude_code_acp_v1'
        )
        and ${table.transcriptContract} = 'none_v1'
        and ${table.checkpointContract} = 'none_v1'
      )`,
    ),
    pgPolicy("protected_task_execution_segment_receipts_product_select", {
      as: "permissive",
      for: "select",
      to: nautiloProductRole,
      using: sql`true`,
    }),
    pgPolicy("protected_task_execution_segment_receipts_product_insert", {
      as: "permissive",
      for: "insert",
      to: nautiloProductRole,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

export type ProtectedTaskExecutionSegmentReceipt =
  typeof protectedTaskExecutionSegmentReceipts.$inferSelect;
export type NewProtectedTaskExecutionSegmentReceipt =
  typeof protectedTaskExecutionSegmentReceipts.$inferInsert;
export type ProtectedTaskExecutionRoute =
  ProtectedTaskExecutionSegmentReceipt["route"];
export type ProtectedTaskTranscriptReceiptContract =
  ProtectedTaskExecutionSegmentReceipt["transcriptContract"];
export type ProtectedTaskCheckpointReceiptContract =
  ProtectedTaskExecutionSegmentReceipt["checkpointContract"];
