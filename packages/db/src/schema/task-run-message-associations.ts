import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgPolicy,
  pgRole,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { taskRuns } from "./task-runs";

const nautiloProductRole = pgRole("nautilo").existing();

/**
 * Content-free provenance for Messages published by one exact TaskRun.
 *
 * `message_id` deliberately has no foreign key. Message deletion must not
 * erase the denominator used to account for Task transcript and delivery
 * coverage. Writers insert this receipt in the canonical Message transaction.
 * A database trigger rejects direct mutation while permitting deletion only
 * through the owning TaskRun's foreign-key cascade.
 */
export const taskRunMessageAssociations = pgTable(
  "task_run_message_associations",
  {
    taskRunId: uuid("task_run_id")
      .notNull()
      .references(() => taskRuns.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull(),
    messageId: integer("message_id").notNull(),
    publishedRevision: integer("published_revision").notNull(),
    kind: text("kind", {
      enum: ["transcript", "raw_delivery", "wake"],
    }).notNull(),
    publicationKey: text("publication_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("uq_task_run_message_associations_message")
      .on(table.messageId),
    unique("uq_task_run_message_associations_publication")
      .on(table.taskRunId, table.kind, table.publicationKey),
    index("idx_task_run_message_associations_run_kind_message")
      .on(table.taskRunId, table.kind, table.messageId),
    check(
      "task_run_message_associations_kind_valid",
      sql`${table.kind} IN ('transcript', 'raw_delivery', 'wake')`,
    ),
    check(
      "task_run_message_associations_message_positive",
      sql`${table.messageId} > 0`,
    ),
    check(
      "task_run_message_associations_revision_nonnegative",
      sql`${table.publishedRevision} >= 0`,
    ),
    check(
      "task_run_message_associations_publication_key_bounded",
      sql`octet_length(${table.publicationKey}) between 1 and 512`,
    ),
    pgPolicy("task_run_message_associations_product_select", {
      as: "permissive",
      for: "select",
      to: nautiloProductRole,
      using: sql`true`,

    }),
    pgPolicy("task_run_message_associations_product_insert", {
      as: "permissive", for: "insert", to: nautiloProductRole, withCheck: sql`true`,
    }),
  ],
).enableRLS();

export type TaskRunMessageAssociation =
  typeof taskRunMessageAssociations.$inferSelect;
export type NewTaskRunMessageAssociation =
  typeof taskRunMessageAssociations.$inferInsert;
export type TaskRunMessageAssociationKind =
  TaskRunMessageAssociation["kind"];
