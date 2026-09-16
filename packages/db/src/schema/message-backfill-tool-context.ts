import { sql } from "drizzle-orm";
import { bigint, check, integer, pgPolicy, pgRole, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { actors } from "./trust";

const productRole = pgRole("nautilo").existing();
/** One active parser per Human. Every field is a source coordinate or parser cursor. */
export const messageBackfillToolContexts = pgTable("message_backfill_tool_contexts", {
  humanActorId: uuid("human_actor_id").primaryKey().references(() => actors.id, {onDelete: "cascade"}),
  sessionId: uuid("session_id").notNull(),
  targetMessageId: integer("target_message_id").notNull(),
  targetRevision: integer("target_revision").notNull(),
  sourceRevision: integer("source_revision").notNull(),
  phase: text("phase", {enum: ["scan", "clear", "ready", "invalid"]}).notNull(),
  afterCreatedAt: timestamp("after_created_at", {withTimezone: true, mode: "string"}),
  afterMessageId: integer("after_message_id").notNull().default(0),
  currentMessageId: integer("current_message_id"),
  callOrdinal: integer("call_ordinal").notNull().default(0),
  comparisonSequence: bigint("comparison_sequence", {mode: "number"}).notNull().default(0),
  nextSequence: bigint("next_sequence", {mode: "number"}).notNull().default(0),
  selectedMessageId: integer("selected_message_id"),
  selectedRevision: integer("selected_revision"),
  selectedCallOrdinal: integer("selected_call_ordinal"),
}, table => [
  check("message_backfill_tool_context_coordinates", sql`${table.targetMessageId} > 0 and ${table.targetRevision} >= 0 and ${table.sourceRevision} >= 0 and ${table.afterMessageId} >= 0 and ${table.callOrdinal} >= 0 and ${table.comparisonSequence} >= 0 and ${table.nextSequence} >= 0`),
  check("message_backfill_tool_context_phase", sql`${table.phase} in ('scan', 'clear', 'ready', 'invalid')`),
  pgPolicy("message_backfill_tool_context_product", {for: "all", to: productRole, using: sql`true`, withCheck: sql`true`}),
]).enableRLS();

/** Only unresolved source references. Provider IDs, names, arguments and hashes never persist. */
export const messageBackfillToolPendingCalls = pgTable("message_backfill_tool_pending_calls", {
  humanActorId: uuid("human_actor_id").notNull().references(() => actors.id, {onDelete: "cascade"}),
  sequence: bigint("sequence", {mode: "number"}).notNull(),
  sourceMessageId: integer("source_message_id").notNull(),
  sourceRevision: integer("source_revision").notNull(),
  callOrdinal: integer("call_ordinal").notNull(),
}, table => [
  primaryKey({columns: [table.humanActorId, table.sequence]}),
  check("message_backfill_tool_pending_coordinates", sql`${table.sequence} > 0 and ${table.sourceMessageId} > 0 and ${table.sourceRevision} >= 0 and ${table.callOrdinal} >= 0`),
  pgPolicy("message_backfill_tool_pending_product", {for: "all", to: productRole, using: sql`true`, withCheck: sql`true`}),
]).enableRLS();
