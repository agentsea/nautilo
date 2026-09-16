import { sql } from "drizzle-orm";
import {
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { rooms } from "./rooms";
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
    provider: text("provider").notNull(),
    operation: text("operation").notNull(),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 14, scale: 8 }),
    actualCostUsd: numeric("actual_cost_usd", { precision: 14, scale: 8 }),
    evidenceState: text("evidence_state", {
      enum: ["actual", "estimated", "unknown"],
    }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("uq_provider_cost_events_idempotency_key").on(table.idempotencyKey),
    index("idx_provider_cost_events_occurred_at").on(table.occurredAt),
    index("idx_provider_cost_events_user_id").on(table.userId),
    index("idx_provider_cost_events_provider_operation").on(table.provider, table.operation),
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
      sql`COALESCE(${table.estimatedCostUsd}, 0) >= 0 AND COALESCE(${table.actualCostUsd}, 0) >= 0`,
    ),
    check(
      "provider_cost_events_idempotency_digest_check",
      sql`${table.idempotencyKey} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export type ProviderCostEvent = typeof providerCostEvents.$inferSelect;
export type NewProviderCostEvent = typeof providerCostEvents.$inferInsert;
