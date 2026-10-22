import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { actors } from "./trust";

const productRole = pgRole("nautilo").existing();

/** One bounded Task-content sweep and at most one structural device claim per Human. */
export const taskContentBackfillScans = pgTable("task_content_backfill_scans", {
  humanActorId: uuid("human_actor_id").primaryKey()
    .references(() => actors.id, { onDelete: "cascade" }),
  phase: text("phase", { enum: ["definition", "result"] })
    .notNull().default("definition"),
  cursorAt: timestamp("cursor_at", { withTimezone: true }),
  cursorTaskId: uuid("cursor_task_id"),
  cursorTaskRunId: uuid("cursor_task_run_id"),
  throughAt: timestamp("through_at", { withTimezone: true }),
  throughTaskId: uuid("through_task_id"),
  throughTaskRunId: uuid("through_task_run_id"),
  sweepStartedAt: timestamp("sweep_started_at", { withTimezone: true })
    .notNull().defaultNow(),
  lastSweepAt: timestamp("last_sweep_at", { withTimezone: true }),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true })
    .notNull().defaultNow(),
  resumeAt: timestamp("resume_at", { withTimezone: true }),
  leaseToken: uuid("lease_token"),
  leaseDeviceId: text("lease_device_id"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  /** Content-free validated coordinates only; never content, ciphertext, keys, or signatures. */
  claim: jsonb("claim").$type<Record<string, unknown>>(),
}, (table) => [
  check("task_content_backfill_scans_phase", sql`${table.phase} in ('definition', 'result')`),
  check("task_content_backfill_scans_cursor", sql`(
    (${table.cursorAt} is null and ${table.cursorTaskId} is null and ${table.cursorTaskRunId} is null)
    or (${table.phase} = 'definition' and ${table.cursorAt} is not null
      and ${table.cursorTaskId} is not null and ${table.cursorTaskRunId} is null)
    or (${table.phase} = 'result' and ${table.cursorAt} is not null
      and ${table.cursorTaskId} is not null and ${table.cursorTaskRunId} is not null)
  )`),
  check("task_content_backfill_scans_through", sql`(
    (${table.throughAt} is null and ${table.throughTaskId} is null and ${table.throughTaskRunId} is null)
    or (${table.phase} = 'definition' and ${table.throughAt} is not null
      and ${table.throughTaskId} is not null and ${table.throughTaskRunId} is null)
    or (${table.phase} = 'result' and ${table.throughAt} is not null
      and ${table.throughTaskId} is not null and ${table.throughTaskRunId} is not null)
  )`),
  check("task_content_backfill_scans_lease", sql`case when ${table.leaseToken} is null
    then ${table.leaseDeviceId} is null and ${table.leaseExpiresAt} is null and ${table.claim} is null
    else ${table.leaseDeviceId} is not null and ${table.leaseExpiresAt} is not null and ${table.claim} is not null end`),
  pgPolicy("task_content_backfill_scans_product", {
    for: "all", to: productRole, using: sql`true`, withCheck: sql`true`,
  }),
]).enableRLS();

/** Sparse source-version dispositions. Successful mappings remain authoritative in their revision ledgers. */
export const taskContentBackfillFailures = pgTable("task_content_backfill_failures", {
  kind: text("kind", { enum: ["definition", "result"] }).notNull(),
  entityId: uuid("entity_id").notNull(),
  // No product FK: discovery holds the per-Human scan row, while publication
  // holds Task/Run rows before re-locking that scan. FK key locks here would
  // invert that order. Stale sparse dispositions disappear from aggregates.
  taskId: uuid("task_id").notNull(),
  taskRunId: uuid("task_run_id"),
  sourceRevision: integer("source_revision").notNull(),
  sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }).notNull(),
  sourceStatus: text("source_status").notNull(),
  sourceCompletedAt: timestamp("source_completed_at", { withTimezone: true }),
  policyRevision: integer("policy_revision").notNull(),
  reason: text("reason", {
    enum: ["unsupported", "no_content", "integrity", "waiting_parent"],
  }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.kind, table.entityId] }),
  index("idx_task_content_backfill_failures_task").on(table.taskId, table.taskRunId),
  check("task_content_backfill_failures_coordinate", sql`(
    ${table.kind} = 'definition' and ${table.entityId} = ${table.taskId} and ${table.taskRunId} is null
  ) or (
    ${table.kind} = 'result' and ${table.entityId} = ${table.taskRunId} and ${table.taskRunId} is not null
  )`),
  check("task_content_backfill_failures_revision", sql`${table.sourceRevision} >= 0 and ${table.policyRevision} > 0`),
  check("task_content_backfill_failures_reason", sql`${table.reason} in ('unsupported', 'no_content', 'integrity', 'waiting_parent')`),
  pgPolicy("task_content_backfill_failures_product", {
    for: "all", to: productRole, using: sql`true`, withCheck: sql`true`,
  }),
]).enableRLS();

export type TaskContentBackfillScan = typeof taskContentBackfillScans.$inferSelect;
export type NewTaskContentBackfillScan = typeof taskContentBackfillScans.$inferInsert;
export type TaskContentBackfillFailure = typeof taskContentBackfillFailures.$inferSelect;
export type NewTaskContentBackfillFailure = typeof taskContentBackfillFailures.$inferInsert;
