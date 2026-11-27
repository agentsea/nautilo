import { sql } from "drizzle-orm";
import { index, jsonb, pgPolicy, pgRole, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import type { MemoryRecoveryLaneResult } from "@nautilo/types";

type Lane = "stenographer" | "reflection" | "memory";
type PageReceipt = Extract<MemoryRecoveryLaneResult, { state: "assessed" }> & { after: string | null; pages: number };
type RecoveryProgress = Partial<Record<Lane, PageReceipt>> & { lastServicedAt?: string };

/** Each operator click authorizes one snapshot of existing failures. */
export const memoryRecoveryRuns = pgTable("memory_recovery_runs", {
  id: uuid("id").primaryKey(),
  authorizedBy: uuid("authorized_by").notNull(),
  observedThrough: timestamp("observed_through", { withTimezone: true }).notNull(),
  progress: jsonb("progress").$type<RecoveryProgress>(),
  stenographer: jsonb("stenographer").$type<MemoryRecoveryLaneResult>(),
  reflection: jsonb("reflection").$type<MemoryRecoveryLaneResult>(),
  memory: jsonb("memory").$type<MemoryRecoveryLaneResult>(),
}, table => [
  index("memory_recovery_runs_latest").on(table.observedThrough),
  index("memory_recovery_runs_pending").on(table.observedThrough, table.id)
    .where(sql`${table.stenographer} IS NULL OR ${table.reflection} IS NULL OR ${table.memory} IS NULL`),
  pgPolicy("memory_recovery_runs_product", {
    for: "all", to: pgRole("nautilo").existing(), using: sql`true`, withCheck: sql`true`,
  }),
]).enableRLS();
