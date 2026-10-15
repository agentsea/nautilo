import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { PersonalProviderCredentialEnvelope } from "../queries/personal-provider-credentials";
import { users } from "./users";

/** Server-owned encrypted registrations, separate from the Human's API keys. */
export const chatgptRegistrations = pgTable("chatgpt_registrations", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull(),
  serverInstanceId: uuid("server_instance_id").notNull(),
  hostId: text("host_id").notNull(),
  authorityRevision: integer("authority_revision").notNull(),
  tokenGeneration: integer("token_generation").notNull(),
  selected: boolean("selected").notNull().default(false),
  state: text("state", { enum: ["connected", "reconnect_required", "disconnected"] }).notNull(),
  identityEnvelope: jsonb("identity_envelope").$type<PersonalProviderCredentialEnvelope>().notNull(),
  envelope: jsonb("envelope").$type<PersonalProviderCredentialEnvelope | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("uq_chatgpt_registrations_user_client").on(table.userId, table.clientId),
  uniqueIndex("uq_chatgpt_registrations_selected").on(table.userId).where(sql`${table.selected} = true`),
  check("chatgpt_registrations_versions", sql`${table.authorityRevision} >= 1 and ${table.tokenGeneration} >= 1`),
  check("chatgpt_registrations_state", sql`${table.state} in ('connected', 'reconnect_required', 'disconnected')`),
  check("chatgpt_registrations_envelope", sql`(${table.state} = 'connected' and ${table.envelope} is not null) or (${table.state} <> 'connected' and ${table.envelope} is null)`),
]);
export type ChatGPTRegistrationRecord = typeof chatgptRegistrations.$inferSelect;
