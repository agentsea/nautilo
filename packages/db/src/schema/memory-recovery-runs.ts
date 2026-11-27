import { sql } from "drizzle-orm";
import { index, jsonb, pgPolicy, pgRole, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import type { MemoryRecoveryLaneResult } from "@nautilo/types";

/** Each operator click authorizes one snapshot of existing failures. */
export const memoryRecoveryRuns = pgTable("memory_recovery_runs", {
  id: uuid("id").primaryKey(),
  authorizedBy: uuid("authorized_by").notNull(),
  observedThrough: timestamp("observed_through", { withTimezone: true }).notNull(),
  stenographer: jsonb("stenographer").$type<MemoryRecoveryLaneResult>(),
  reflection: jsonb("reflection").$type<MemoryRecoveryLaneResult>(),
  memory: jsonb("memory").$type<MemoryRecoveryLaneResult>(),
}, table => [
  index("memory_recovery_runs_latest").on(table.observedThrough),
  pgPolicy("memory_recovery_runs_product", {
    for: "all", to: pgRole("nautilo").existing(), using: sql`true`, withCheck: sql`true`,
  }),
]).enableRLS();
