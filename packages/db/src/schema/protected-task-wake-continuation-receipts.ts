import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { jobs } from "./jobs";
import { protectedTaskRunOutputBindings } from
  "./protected-task-run-output-bindings";
import type { ProtectedTaskSemanticAuthorityRequirements } from
  "./protected-task-continuation-receipts";
import { rooms } from "./rooms";
import { taskRuns } from "./task-runs";
import { tasks } from "./tasks";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});
const nautiloProductRole = pgRole("nautilo").existing();

/**
 * Immutable, content-free proof that an authenticated wake stopped at one
 * pre-effect additional-authority interrupt after its encrypted checkpoint
 * rows were drained and hashed. The original result Run remains terminal.
 */
export const protectedTaskWakeContinuationReceipts = pgTable(
  "protected_task_wake_continuation_receipts",
  {
    wakeJobId: uuid("wake_job_id").notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    segment: integer("segment").notNull(),
    taskId: uuid("task_id").notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    taskRunId: uuid("task_run_id").notNull()
      .references(() => taskRuns.id, { onDelete: "cascade" }),
    bindingId: text("binding_id").notNull(),
    wakeOperationId: text("wake_operation_id").notNull(),
    priorRecipientGeneration: integer("prior_recipient_generation").notNull(),
    wakeAuthorizationRequestId: text("wake_authorization_request_id").notNull(),
    additionalAuthorizationRequestId:
      text("additional_authorization_request_id").notNull(),
    interruptId: text("interrupt_id").notNull(),
    operationId: text("operation_id").notNull(),
    requestDigest: bytea("request_digest").notNull(),
    requiredAuthorityDigest: bytea("required_authority_digest").notNull(),
    semanticAuthorityRequirements: jsonb("semantic_authority_requirements")
      .$type<ProtectedTaskSemanticAuthorityRequirements>().notNull(),
    retainedSourceNamespaceIds: uuid("retained_source_namespace_ids")
      .array().notNull(),
    sourceEnvelopeDigest: bytea("source_envelope_digest").notNull(),
    initialPolicyRevision: integer("initial_policy_revision").notNull(),
    initialAgentAuthorizationRevision:
      integer("initial_agent_authorization_revision").notNull(),
    destinationRoomId: uuid("destination_room_id").notNull(),
    destinationNamespaceId: uuid("destination_namespace_id").notNull(),
    destinationAuthorityDigest: bytea("destination_authority_digest").notNull(),
    checkpointThreadId: text("checkpoint_thread_id").notNull(),
    checkpointContract: text("checkpoint_contract", {
      enum: ["encrypted_langgraph_v1"],
    }).notNull(),
    expectedCheckpointCount: integer("expected_checkpoint_count").notNull(),
    checkpointOrderedDigest: bytea("checkpoint_ordered_digest").notNull(),
    expectedBlobCount: integer("expected_blob_count").notNull(),
    blobOrderedDigest: bytea("blob_ordered_digest").notNull(),
    expectedPendingWriteCount:
      integer("expected_pending_write_count").notNull(),
    pendingWriteOrderedDigest: bytea("pending_write_ordered_digest").notNull(),
    sealedAt: timestamp("sealed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "protected_task_wake_continuation_receipts_pkey",
      columns: [table.wakeJobId, table.segment],
    }),
    unique("uq_protected_task_wake_continuation_authorization_generation")
      .on(table.wakeAuthorizationRequestId, table.priorRecipientGeneration),
    unique("uq_protected_task_wake_continuation_interrupt")
      .on(table.wakeJobId, table.interruptId),
    foreignKey({
      name: "protected_task_wake_continuation_binding_fk",
      columns: [table.taskRunId],
      foreignColumns: [protectedTaskRunOutputBindings.taskRunId],
    }).onDelete("cascade"),
    foreignKey({
      name: "protected_task_wake_continuation_destination_fk",
      columns: [table.destinationRoomId, table.destinationNamespaceId],
      foreignColumns: [rooms.id, rooms.namespaceId],
    }).onDelete("restrict"),
    check(
      "protected_task_wake_continuation_receipts_segment_positive",
      sql`${table.segment} between 1 and 2147483647`,
    ),
    check(
      "protected_task_wake_continuation_receipts_generation_safe",
      sql`${table.priorRecipientGeneration} between 0 and 2147483646
        and ${table.segment} = ${table.priorRecipientGeneration} + 1`,
    ),
    check(
      "protected_task_wake_continuation_receipts_identity_shape",
      sql`${table.bindingId} = 'task-run-output:' || ${table.taskRunId}::text
        and ${table.wakeOperationId} = 'task-run-delivery-wake:' || ${table.taskRunId}::text
        and ${table.wakeAuthorizationRequestId} = 'task-wake-authorization:' || ${table.wakeJobId}::text`,
    ),
    check(
      "protected_task_wake_continuation_receipts_interrupt_shape",
      sql`${table.additionalAuthorizationRequestId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and ${table.interruptId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and ${table.operationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and ${table.checkpointThreadId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'`,
    ),
    check(
      "protected_task_wake_continuation_receipts_digest_sizes",
      sql`octet_length(${table.requestDigest}) = 32
        and octet_length(${table.requiredAuthorityDigest}) = 32
        and octet_length(${table.sourceEnvelopeDigest}) = 32
        and octet_length(${table.destinationAuthorityDigest}) = 32
        and octet_length(${table.checkpointOrderedDigest}) = 32
        and octet_length(${table.blobOrderedDigest}) = 32
        and octet_length(${table.pendingWriteOrderedDigest}) = 32`,
    ),
    check(
      "protected_task_wake_continuation_receipts_public_revision_positive",
      sql`${table.initialPolicyRevision} > 0
        and ${table.initialAgentAuthorizationRevision} > 0`,
    ),
    check(
      "protected_task_wake_continuation_receipts_manifest_counts_safe",
      sql`${table.expectedCheckpointCount} between 1 and 2147483647
        and ${table.expectedBlobCount} between 0 and 2147483647
        and ${table.expectedPendingWriteCount} between 0 and 2147483647`,
    ),
    check(
      "protected_task_wake_continuation_receipts_authority_shape",
      sql`jsonb_typeof(${table.semanticAuthorityRequirements}) = 'array'
        and cardinality(${table.retainedSourceNamespaceIds}) > 0
        and array_position(${table.retainedSourceNamespaceIds}, null) is null`,
    ),
    pgPolicy("protected_task_wake_continuation_receipts_product_select", {
      as: "permissive",
      for: "select",
      to: nautiloProductRole,
      using: sql`true`,
    }),
    pgPolicy("protected_task_wake_continuation_receipts_product_insert", {
      as: "permissive",
      for: "insert",
      to: nautiloProductRole,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

export type ProtectedTaskWakeContinuationReceipt =
  typeof protectedTaskWakeContinuationReceipts.$inferSelect;
export type NewProtectedTaskWakeContinuationReceipt =
  typeof protectedTaskWakeContinuationReceipts.$inferInsert;
