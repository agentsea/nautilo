import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { rooms } from "./rooms";
import { taskRuns } from "./task-runs";

/**
 * Content-free, per-occurrence output intent and publication receipts for a
 * protected TaskRun. This is a lifecycle ledger, not an execution queue: the
 * Task result, Message and wake Job remain owned by their product tables.
 */
export const protectedTaskRunOutputBindings = pgTable(
  "protected_task_run_output_bindings",
  {
    taskRunId: uuid("task_run_id")
      .primaryKey()
      .references(() => taskRuns.id, { onDelete: "cascade" }),
    bindingId: text("binding_id").notNull().unique(),
    deliveryMode: text("delivery_mode", {
      enum: ["none", "wake", "raw", "raw_and_wake"],
    }).notNull(),
    destinationRoomId: uuid("destination_room_id"),
    destinationNamespaceId: uuid("destination_namespace_id"),
    resultOperationId: text("result_operation_id").notNull().unique(),
    resultObjectId: text("result_object_id").notNull().unique(),
    messageOperationId: text("message_operation_id").unique(),
    wakeOperationId: text("wake_operation_id").unique(),
    acceptedPolicyRevision: integer("accepted_policy_revision").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    resultTerminalAt: timestamp("result_terminal_at", { withTimezone: true }),
    resultAttachedAt: timestamp("result_attached_at", { withTimezone: true }),
    messageId: integer("message_id"),
    messagePublishedAt: timestamp("message_published_at", {
      withTimezone: true,
    }),
    wakeJobId: uuid("wake_job_id").unique(),
    wakeScheduledAt: timestamp("wake_scheduled_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "protected_task_run_output_bindings_destination_fk",
      columns: [table.destinationRoomId, table.destinationNamespaceId],
      foreignColumns: [rooms.id, rooms.namespaceId],
    }).onDelete("restrict"),
    index("idx_protected_task_run_output_bindings_recovery").on(
      table.completedAt,
      table.acceptedAt,
      table.taskRunId,
    ),
    check(
      "protected_task_run_output_bindings_policy_revision_positive",
      sql`${table.acceptedPolicyRevision} > 0`,
    ),
    check(
      "protected_task_run_output_bindings_result_identity_shape",
      sql`${table.bindingId} = 'task-run-output:' || ${table.taskRunId}::text
        and ${table.resultOperationId} = 'task-run-result:' || ${table.taskRunId}::text
        and ${table.resultObjectId} ~ '^task-run-result:v1:[0-9a-f]{64}$'`,
    ),
    check(
      "protected_task_run_output_bindings_delivery_shape",
      sql`(
        ${table.deliveryMode} = 'none'
        and ${table.destinationRoomId} is null
        and ${table.destinationNamespaceId} is null
        and ${table.messageOperationId} is null
        and ${table.wakeOperationId} is null
      ) or (
        ${table.deliveryMode} = 'raw'
        and ${table.destinationRoomId} is not null
        and ${table.destinationNamespaceId} is not null
        and ${table.messageOperationId} = 'task-run-delivery-message:' || ${table.taskRunId}::text
        and ${table.wakeOperationId} is null
      ) or (
        ${table.deliveryMode} = 'wake'
        and ${table.destinationRoomId} is not null
        and ${table.destinationNamespaceId} is not null
        and ${table.messageOperationId} is null
        and ${table.wakeOperationId} = 'task-run-delivery-wake:' || ${table.taskRunId}::text
      ) or (
        ${table.deliveryMode} = 'raw_and_wake'
        and ${table.destinationRoomId} is not null
        and ${table.destinationNamespaceId} is not null
        and ${table.messageOperationId} = 'task-run-delivery-message:' || ${table.taskRunId}::text
        and ${table.wakeOperationId} = 'task-run-delivery-wake:' || ${table.taskRunId}::text
      )`,
    ),
    check(
      "protected_task_run_output_bindings_message_receipt_coherent",
      sql`(${table.messageId} is null) = (${table.messagePublishedAt} is null)
        and (${table.messageId} is null or ${table.messageOperationId} is not null)`,
    ),
    check(
      "protected_task_run_output_bindings_wake_receipt_coherent",
      sql`(${table.wakeJobId} is null) = (${table.wakeScheduledAt} is null)
        and (${table.wakeJobId} is null or ${table.wakeOperationId} is not null)`,
    ),
    check(
      "protected_task_run_output_bindings_result_receipt_coherent",
      sql`${table.resultAttachedAt} is null
        or (${table.resultTerminalAt} is not null
          and ${table.resultAttachedAt} >= ${table.resultTerminalAt})`,
    ),
    check(
      "protected_task_run_output_bindings_completion_coherent",
      sql`${table.completedAt} is null or (
        ${table.resultAttachedAt} is not null
        and (${table.messageOperationId} is null or ${table.messagePublishedAt} is not null)
        and (${table.wakeOperationId} is null or ${table.wakeScheduledAt} is not null)
        and ${table.completedAt} >= ${table.acceptedAt}
      )`,
    ),
  ],
);

export type ProtectedTaskRunOutputBinding =
  typeof protectedTaskRunOutputBindings.$inferSelect;
export type NewProtectedTaskRunOutputBinding =
  typeof protectedTaskRunOutputBindings.$inferInsert;
