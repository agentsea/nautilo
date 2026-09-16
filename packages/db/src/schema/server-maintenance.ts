import {
  pgTable,
  text,
  varchar,
  uuid,
  timestamp,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * D420 — permanent, lockable server maintenance lease.
 *
 * A 1:1 leased property of the Server entity (R10). Exactly one row lives
 * in the table for the lifetime of the DB (`singleton_key = 'upgrade'`),
 * lazily inserted by the maintenance query layer if a restored/partial DB
 * lacks it. It is never deleted; transitions mutate the row in place.
 * Admission and state transitions serialize on the single row via
 * `SELECT ... FOR UPDATE` inside {@link queries/maintenance.ts}
 * transactions, so two operator CLIs cannot both believe they own the
 * drain.
 *
 * State machine:
 *   normal ──enter──▶ draining ──apply──▶ applying ──clear──▶ normal
 *                       │                     │
 *                       └──clear──▶ normal    └──clear──▶ normal
 * Any invalid / cross-owner transition throws (fail closed). An abandoned
 * or restored `applying` row returns to `normal` once `hard_expires_at`
 * passes (recoverExpired), so a dead CLI or a restored snapshot cannot
 * strand the server in maintenance forever.
 *
 * `lease_expires_at` is the renewable soft deadline the owning CLI
 * renews before; `hard_expires_at` is the absolute ceiling past which
 * recovery reclaims the lease. Renewal is capped at the hard expiry.
 */
export const serverMaintenance = pgTable(
  "server_maintenance",
  {
    /** Permanent singleton discriminator; today always `'upgrade'`. */
    singletonKey: text("singleton_key").primaryKey().default("upgrade"),
    state: varchar("state", { length: 16 })
      .notNull()
      .default("normal"),
    /** Owning operation id; NULL only when `state = 'normal'`. */
    operationId: uuid("operation_id"),
    /** Renewable soft deadline; NULL when `state = 'normal'`. */
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** Absolute recovery ceiling; NULL when `state = 'normal'`. */
    hardExpiresAt: timestamp("hard_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "server_maintenance_state_check",
      sql`${table.state} IN ('normal', 'draining', 'applying')`,
    ),
  ],
);

export type ServerMaintenanceRow = typeof serverMaintenance.$inferSelect;
export type NewServerMaintenanceRow = typeof serverMaintenance.$inferInsert;

export type MaintenanceState = "normal" | "draining" | "applying";
