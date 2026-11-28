import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgPolicy, pgRole, pgTable, uniqueIndex, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sessions } from "./sessions";
import { agents } from "./agents";
import { rooms } from "./rooms";
import type { MemoryOperationBinding } from "@nautilo/types";

/** M319: source coordinates only. No transcript or captured access envelope. */
export const memoryReviewTurns = pgTable("memory_review_turns", {
  id: uuid("id").primaryKey().defaultRandom(),
  generationId: uuid("generation_id").notNull().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").notNull(),
  actorId: text("actor_id").notNull(),
  accessScope: text("access_scope").notNull(),
  threadId: text("thread_id").notNull(),
  checkpointThreadId: text("checkpoint_thread_id").notNull(),
  turnId: text("turn_id").notNull(),
  sourceIds: jsonb("source_ids").$type<number[]>().notNull(),
  firstMessageId: integer("first_message_id").notNull(),
  hasHuman: integer("has_human").notNull().default(0),
  state: text("state").$type<"pending" | "awaiting" | "completed" | "interrupted" | "covered">().notNull().default("pending"),
  /** First accepted model, preference and payer survive retries and restarts. */
  acceptedModelBinding: jsonb("accepted_model_binding").$type<MemoryOperationBinding | { kind: "service"; modelId: string }>(),
  attemptId: uuid("attempt_id"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  retryAt: timestamp("retry_at", { withTimezone: true }),
  failurePhase: text("failure_phase"),
  failureCode: text("failure_code"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  receiptId: uuid("receipt_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("memory_review_turn_identity").on(table.sessionId, table.agentId, table.ownerId, table.accessScope, table.turnId),
  index("memory_review_open_scope_order").on(table.sessionId, table.agentId, table.ownerId,
    table.accessScope, table.firstMessageId, table.id).where(sql`${table.receiptId} IS NULL`),
  index("memory_review_pending_idx").on(table.state, table.retryAt, table.firstMessageId),
  pgPolicy("memory_review_turns_product", { for: "all", to: pgRole("nautilo").existing(), using: sql`true`, withCheck: sql`true` }),
  pgPolicy("memory_review_turns_agent", { for: "all", to: pgRole("nautilo_agent").existing(),
    using: sql`${table.agentId} = app_current_agent_id() AND (
      EXISTS (SELECT 1 FROM actors a WHERE a.id::text = ${table.actorId} AND a.owner_id = app_current_user_id() AND a.kind = 'user')
      OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = ${table.sessionId} AND s.owner_id = app_current_user_id()))`,
    withCheck: sql`${table.agentId} = app_current_agent_id() AND (
      EXISTS (SELECT 1 FROM actors a WHERE a.id::text = ${table.actorId} AND a.owner_id = app_current_user_id() AND a.kind = 'user')
      OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = ${table.sessionId} AND s.owner_id = app_current_user_id()))`,
  }),
]).enableRLS();

/** Server-only permission for one new attempt on an exact, previously blocked review. */
export const memoryReviewModelRecoveries = pgTable("memory_review_model_recoveries", {
  workId: uuid("work_id").primaryKey(),
  headTurnId: uuid("head_turn_id").notNull().references(() => memoryReviewTurns.id, { onDelete: "cascade" }),
  authorizedBy: uuid("authorized_by").notNull(),
  authorizedAt: timestamp("authorized_at", { withTimezone: true }).notNull(),
  blockedAttemptId: uuid("blocked_attempt_id").notNull(),
  turnIds: uuid("turn_ids").array().notNull(),
  /** SHA-256 over the exact transcript row identities/revisions authorized by the Human. */
  sourceRevisionFingerprint: text("source_revision_fingerprint"),
  /** A legacy, missing, or changed source snapshot is a durable hold until a fresh click. */
  sourceChangedAt: timestamp("source_changed_at", { withTimezone: true }),
  spentAt: timestamp("spent_at", { withTimezone: true }),
  recoveryAttemptId: uuid("recovery_attempt_id"),
}, (table) => [
  index("memory_review_model_recovery_head_idx").on(table.headTurnId),
  check("memory_review_model_recovery_source_fingerprint", sql`
    ${table.sourceRevisionFingerprint} is null
    or ${table.sourceRevisionFingerprint} ~ '^[0-9a-f]{64}$'
  `),
  pgPolicy("memory_review_model_recoveries_product", {
    for: "all", to: pgRole("nautilo").existing(), using: sql`true`, withCheck: sql`true`,
  }),
]).enableRLS();

/** Successful publication is authoritative, including required delivery acknowledgments. */
export const memoryReviewReceipts = pgTable("memory_review_receipts", {
  id: uuid("id").primaryKey(),
  workId: uuid("work_id").notNull(),
  actorId: text("actor_id").notNull(),
  ownerId: uuid("owner_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  modelId: text("model_id").notNull(),
  outcome: text("outcome").$type<"published" | "failed">().notNull().default("published"),
  phase: text("phase"),
  code: text("code"),
  counts: jsonb("counts").$type<{ created: number; replaced: number; promoted: number; demoted: number }>().notNull(),
  effects: jsonb("effects").$type<unknown[]>().notNull(),
  delivered: integer("delivered").notNull().default(0),
  durationMs: integer("duration_ms").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("memory_review_receipt_time_idx").on(table.createdAt),
  uniqueIndex("memory_review_publication_once").on(table.workId).where(sql`${table.outcome} = 'published'`),
  pgPolicy("memory_review_receipts_product", { for: "all", to: pgRole("nautilo").existing(), using: sql`true`, withCheck: sql`true` }),
  pgPolicy("memory_review_receipts_agent", { for: "all", to: pgRole("nautilo_agent").existing(),
    using: sql`${table.agentId} = app_current_agent_id() AND EXISTS (SELECT 1 FROM actors a WHERE a.id::text = ${table.actorId} AND a.owner_id = app_current_user_id() AND a.kind = 'user')`,
    withCheck: sql`${table.outcome} = 'published' AND ${table.agentId} = app_current_agent_id() AND EXISTS (SELECT 1 FROM actors a WHERE a.id::text = ${table.actorId} AND a.owner_id = app_current_user_id() AND a.kind = 'user')`,
  }),
]).enableRLS();
