import { sql } from "drizzle-orm";
import { index, jsonb, pgPolicy, pgRole, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { actors } from "./trust";
import { users } from "./users";

const productRole = pgRole("nautilo").existing();
const readerRole = pgRole("nautilo_feed_reader").existing();
const writer = sql`current_setting('app.event_feed_writer', true) = 'on'`;
const viewer = sql`nullif(current_setting('app.current_user_id', true), '')::uuid`;

/** Reference-only personal feed facts; resource deletion never removes history. */
export const feedEvents = pgTable("feed_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  occurrenceKey: text("occurrence_key").notNull(),
  type: text("type").notNull(),
  actorKind: text("actor_kind", { enum: ["human", "agent"] }).notNull(),
  actorId: uuid("actor_id").references(() => actors.id, { onDelete: "set null" }),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("feed_events_occurrence_key_unique").on(table.occurrenceKey),
  index("feed_events_page_idx").on(table.createdAt, table.id),
  pgPolicy("feed_events_read", { for: "select", to: readerRole, using: sql`exists (select 1 from feed_recipients r where r.event_id = ${table.id} and r.user_id = ${viewer})` }),
  pgPolicy("feed_events_record_read", { for: "select", to: productRole, using: writer }),
  pgPolicy("feed_events_append", { for: "insert", to: productRole, withCheck: writer }),
]).enableRLS();

/** Only this Human owns read state; no duplicated unread-counter authority. */
export const feedRecipients = pgTable("feed_recipients", {
  eventId: uuid("event_id").notNull().references(() => feedEvents.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  readAt: timestamp("read_at", { withTimezone: true, precision: 3 }),
}, (table) => [
  primaryKey({ columns: [table.eventId, table.userId] }),
  index("feed_recipients_user_idx").on(table.userId, table.eventId),
  index("feed_recipients_unread_idx").on(table.userId).where(sql`${table.readAt} is null`),
  pgPolicy("feed_recipients_read", { for: "select", to: readerRole, using: sql`${table.userId} = ${viewer}` }),
  pgPolicy("feed_recipients_record_read", { for: "select", to: productRole, using: writer }),
  pgPolicy("feed_recipients_append", { for: "insert", to: productRole, withCheck: writer }),
  pgPolicy("feed_recipients_read_state", { for: "update", to: readerRole, using: sql`${table.userId} = ${viewer}`, withCheck: sql`${table.userId} = ${viewer}` }),
]).enableRLS();
