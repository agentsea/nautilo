import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  check,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { jobs } from "./jobs";

/**
 * D420 — payload-free work-acceptance ledger (R11).
 *
 * One row per accepted unit of executable intent, persisted BEFORE the
 * unit is enqueued in the runtime coalescer. The row carries identity and
 * lifecycle ONLY — never prompt text, room/user ids, tool input, or
 * checkpoint references (those stay in the `jobs` row linked at
 * dispatch). This keeps the ledger safe to inspect/restore and keeps
 * coalesced intent durable across the drain boundary.
 *
 * Lifecycle:
 *   accepted ──dispatch──▶ dispatched     (linked to a Job at run time)
 *   accepted ──maintenance drain──▶ maintenance_cancelled  (never dispatched;
 *   terminalized at the drain deadline by the operator sweep — R8/R11)
 *   accepted ──user Stop──▶ user_cancelled  (never dispatched; a D349 user
 *   Stop dropped its queued/buffered intent — distinct from maintenance)
 * `dispatched` is terminal for the ledger; the linked Job row carries the
 * job-level cancellation outcome. A `maintenance_cancelled` row records a
 * truthful durable outcome for intent that never started because the operator
 * drained it. A `user_cancelled` row records intent a user explicitly stopped
 * before dispatch; the maintenance sweep must leave it untouched.
 *
 * Coalescing: N segments accepted into one merged turn produce N
 * `accepted` rows; at dispatch all N are linked to the single created
 * Job. The runtime tracks `virtualJobId → acceptanceId` so the coalesced
 * group can be linked without storing payload on the ledger.
 */
export const workAcceptances = pgTable(
  "work_acceptances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: varchar("kind", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 })
      .notNull()
      .default("accepted"),
    /** The Job this acceptance became at dispatch; NULL until then. */
    jobId: uuid("job_id").references(() => jobs.id, {
      onDelete: "set null",
    }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    /** Bounded reason text only; no prompt/room/user/tool payload. */
    cancellationReason: text("cancellation_reason"),
  },
  (table) => [
    check(
      "work_acceptances_kind_check",
      sql`${table.kind} IN ('foreground', 'system_report_back')`,
    ),
    check(
      "work_acceptances_status_check",
      sql`${table.status} IN ('accepted', 'dispatched', 'user_cancelled', 'maintenance_cancelled')`,
    ),
    index("idx_work_acceptances_status").on(table.status),
    index("idx_work_acceptances_job").on(table.jobId),
  ],
);

export type WorkAcceptanceRow = typeof workAcceptances.$inferSelect;
export type NewWorkAcceptanceRow = typeof workAcceptances.$inferInsert;

export type WorkAcceptanceKind = "foreground" | "system_report_back";
export type WorkAcceptanceStatus =
  | "accepted"
  | "dispatched"
  | "user_cancelled"
  | "maintenance_cancelled";
