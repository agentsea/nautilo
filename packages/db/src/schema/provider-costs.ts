import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
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

/**
 * Paid non-model operations shown beside the existing LLM Costs ledger.
 *
 * Rows intentionally contain no provider payloads or raw operation IDs. The
 * unique digest is a one-way replay key derived at the provider boundary.
 */
export const providerCostEvents = pgTable(
  "provider_cost_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    roomId: uuid("room_id").references(() => rooms.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => taskRuns.id, { onDelete: "set null" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    operation: text("operation").notNull(),
    workload: text("workload"),
    fundingKind: varchar("funding_kind", {
      length: 16,
      enum: ["personal", "server", "service"],
    }),
    /** Human whose provider account paid. Retained after credential deletion. */
    payerHumanId: uuid("payer_human_id"),
    providerRoute: text("provider_route"),
    credentialId: uuid("credential_id"),
    credentialRevision: integer("credential_revision"),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 14, scale: 8 }),
    actualCostUsd: numeric("actual_cost_usd", { precision: 14, scale: 8 }),
    /** Terminal service-call outcome. NULL preserves historical rows. */
    attemptOutcome: varchar("attempt_outcome", {
      length: 16,
      enum: ["succeeded", "failed", "cancelled", "interrupted", "unknown"],
    }),
    failureCode: text("failure_code"),
    pricingVersion: text("pricing_version"),
    measuredUnits: numeric("measured_units", { precision: 20, scale: 8 }),
    unitType: text("unit_type"),
    /** One-way display reference derived from a provider request receipt. */
    requestReference: varchar("request_reference", { length: 16 }),
    evidenceState: text("evidence_state", {
      enum: ["actual", "estimated", "unknown"],
    }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("uq_provider_cost_events_idempotency_key").on(table.idempotencyKey),
    index("idx_provider_cost_events_occurred_at").on(table.occurredAt),
    index("idx_provider_cost_events_user_id").on(table.userId),
    index("idx_provider_cost_events_payer_human_id").on(table.payerHumanId),
    index("idx_provider_cost_events_task_id").on(table.taskId),
    index("idx_provider_cost_events_run_id").on(table.runId),
    index("idx_provider_cost_events_job_id").on(table.jobId),
    index("idx_provider_cost_events_provider_operation").on(table.provider, table.operation),
    check(
      "provider_cost_events_funding_provenance_check",
      sql`(
        (${table.fundingKind} IS NULL AND ${table.payerHumanId} IS NULL AND ${table.providerRoute} IS NULL AND ${table.credentialId} IS NULL AND ${table.credentialRevision} IS NULL)
        OR (${table.fundingKind} = 'personal' AND ${table.payerHumanId} IS NOT NULL AND ${table.providerRoute} IS NOT NULL AND length(${table.providerRoute}) > 0 AND ${table.credentialId} IS NOT NULL AND ${table.credentialRevision} IS NOT NULL AND ${table.credentialRevision} >= 1)
        OR (${table.fundingKind} IN ('server', 'service') AND ${table.payerHumanId} IS NULL AND ${table.providerRoute} IS NOT NULL AND length(${table.providerRoute}) > 0 AND ${table.credentialId} IS NULL AND ${table.credentialRevision} IS NULL)
      )`,
    ),
    check(
      "provider_cost_events_evidence_check",
      sql`(
        (${table.evidenceState} = 'actual' AND ${table.actualCostUsd} IS NOT NULL)
        OR (${table.evidenceState} = 'estimated' AND ${table.actualCostUsd} IS NULL AND ${table.estimatedCostUsd} IS NOT NULL)
        OR (${table.evidenceState} = 'unknown' AND ${table.actualCostUsd} IS NULL AND ${table.estimatedCostUsd} IS NULL)
      )`,
    ),
    check(
      "provider_cost_events_nonnegative_check",
      sql`COALESCE(${table.estimatedCostUsd}, 0) >= 0 AND COALESCE(${table.actualCostUsd}, 0) >= 0 AND COALESCE(${table.measuredUnits}, 0) >= 0`,
    ),
    check(
      "provider_cost_events_idempotency_digest_check",
      sql`${table.idempotencyKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "provider_cost_events_request_reference_check",
      sql`${table.requestReference} IS NULL OR ${table.requestReference} ~ '^req_[0-9a-f]{12}$'`,
    ),
  ],
);

export type ProviderCostEvent = typeof providerCostEvents.$inferSelect;
export type NewProviderCostEvent = typeof providerCostEvents.$inferInsert;
