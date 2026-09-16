import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgPolicy, pgRole, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { actors } from "./trust";
import { sessionMessages } from "./sessions";

const productRole = pgRole("nautilo").existing();

/** One resumable sweep and at most one exact active claim per Human, never a corpus ledger. */
export const messageBackfillScans = pgTable("message_backfill_scans", {
  humanActorId: uuid("human_actor_id").primaryKey().references(() => actors.id, { onDelete: "cascade" }),
  cursorMessageId: integer("cursor_message_id").notNull().default(0),
  sweepStartedAt: timestamp("sweep_started_at", { withTimezone: true }).notNull().defaultNow(),
  lastSweepAt: timestamp("last_sweep_at", { withTimezone: true }),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  resumeAt: timestamp("resume_at", { withTimezone: true }),
  leaseToken: uuid("lease_token"),
  leaseDeviceId: text("lease_device_id"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  /** Closed validated structural claim only: no plaintext, ciphertext, signatures, keys or errors. */
  claim: jsonb("claim").$type<Record<string, unknown>>(),
  /** One replaceable urgent visible selection; ordinary sweep cursor never follows this lane. */
  urgentMessageId: integer("urgent_message_id").references(() => sessionMessages.id, { onDelete: "set null" }),
  claimIsUrgent: integer("claim_is_urgent").notNull().default(0),
}, (table) => [
  check("message_backfill_scans_cursor", sql`${table.cursorMessageId} >= 0`),
  check("message_backfill_scans_urgent", sql`${table.claimIsUrgent} in (0, 1)`),
  check("message_backfill_scans_claim", sql`case when ${table.leaseToken} is null
    then ${table.leaseDeviceId} is null and ${table.leaseExpiresAt} is null and ${table.claim} is null
    else ${table.leaseDeviceId} is not null and ${table.leaseExpiresAt} is not null and ${table.claim} is not null end`),
  pgPolicy("message_backfill_scans_product", { for: "all", to: productRole, using: sql`true`, withCheck: sql`true` }),
]).enableRLS();

/** Sparse actionable failures only. No success or availability counter is durable here. */
export const messageBackfillFailures = pgTable("message_backfill_failures", {
  messageId: integer("message_id").primaryKey().references(() => sessionMessages.id, { onDelete: "cascade" }),
  editRevision: integer("edit_revision").notNull(),
  /** Tool pairing also depends on predecessor Messages in this exact Session source. */
  sourceRevision: integer("source_revision"),
  namespaceAccessRevision: integer("namespace_access_revision").notNull(),
  policyRevision: integer("policy_revision").notNull(),
  cryptoObjectId: text("crypto_object_id"),
  reason: text("reason", { enum: ["integrity_failure", "parity_mismatch", "unsupported"] }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("message_backfill_failures_coordinates", sql`${table.editRevision} >= 0 and ${table.namespaceAccessRevision} >= 0 and ${table.policyRevision} > 0`),
  check("message_backfill_failures_reason", sql`${table.reason} in ('integrity_failure', 'parity_mismatch', 'unsupported')`),
  pgPolicy("message_backfill_failures_product", { for: "all", to: productRole, using: sql`true`, withCheck: sql`true` }),
]).enableRLS();
