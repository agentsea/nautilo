import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, pgPolicy, pgTable, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { users } from "./users";
import { agents } from "./agents";
import { rooms } from "./rooms";
import { jobs } from "./jobs";
import { sessionMessages } from "./sessions";

const ownerPolicy = (name: string, userId: AnyPgColumn, productFactory = false) => pgPolicy(name, {
  for: "all", to: productFactory ? ["nautilo_agent", "nautilo"] : "nautilo_agent",
  using: sql`${userId} = nullif(current_setting('app.current_user_id', true), '')::uuid`,
  withCheck: sql`${userId} = nullif(current_setting('app.current_user_id', true), '')::uuid`,
});

/** Metadata only: the paired Desktop retains credentials and resolves the opaque home. */
export const bolterConnections = pgTable("bolter_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  relayId: text("relay_id").notNull(),
  desktopSessionId: text("desktop_session_id").notNull(),
  pairingGenerationRef: text("pairing_generation_ref").notNull(),
  homeHandle: text("home_handle").notNull(),
  origin: text("origin").notNull(),
  providerAgentId: text("provider_agent_id").notNull(),
  /** Hash of the verified qualified identity, not a short provider id alone. */
  identityFingerprint: text("identity_fingerprint").notNull(),
  generation: integer("generation").notNull().default(1),
  revision: integer("revision").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("bolter_connections_owner_id").on(t.userId, t.id),
  uniqueIndex("bolter_connections_home").on(t.userId, t.relayId, t.homeHandle),
  index("bolter_connections_owner").on(t.userId, t.createdAt),
  check("bolter_connections_generation", sql`${t.generation} > 0 AND ${t.revision} >= 0`),
  check("bolter_connections_revocation", sql`${t.revokedAt} IS NULL OR ${t.enabled} = false`),
  check("bolter_connections_identity", sql`${t.identityFingerprint} ~ '^[0-9a-f]{64}$' AND length(${t.providerAgentId}) > 0 AND length(${t.origin}) > 0 AND length(${t.relayId}) > 0 AND length(${t.desktopSessionId}) > 0 AND length(${t.pairingGenerationRef}) > 0`),
  check("bolter_connections_home_handle", sql`length(${t.homeHandle}) > 0 AND position('/' in ${t.homeHandle}) = 0 AND position(chr(92) in ${t.homeHandle}) = 0 AND position('..' in ${t.homeHandle}) = 0`),
  ownerPolicy("bolter_connections_owner", t.userId, true),
]).enableRLS();

/** Immutable routing coordinates. Unlinking never removes the Room context fence. */
export const bolterRoomBindings = pgTable("bolter_room_bindings", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull(),
  roomId: uuid("room_id").notNull(),
  namespaceId: uuid("namespace_id").notNull(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
  origin: text("origin").notNull(),
  providerAgentId: text("provider_agent_id").notNull(),
  chatId: text("chat_id").notNull(),
  /** Empty means the root conversation; never nullable in the identity key. */
  threadId: text("thread_id").notNull().default(""),
  revision: integer("revision").notNull().default(0),
  state: text("state", { enum: ["active", "paused", "revoked"] }).notNull().default("active"),
  /** Explicit Human approval of model funding for this external conversation. */
  modelSponsorshipAcceptedAt: timestamp("model_sponsorship_accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("bolter_bindings_owner_id").on(t.userId, t.id),
  foreignKey({ name: "bolter_bindings_connection_owner", columns: [t.userId, t.connectionId], foreignColumns: [bolterConnections.userId, bolterConnections.id] }).onDelete("restrict"),
  foreignKey({ name: "bolter_bindings_exact_namespace", columns: [t.roomId, t.namespaceId], foreignColumns: [rooms.id, rooms.namespaceId] }).onDelete("restrict"),
  uniqueIndex("bolter_bindings_external_identity").on(t.connectionId, t.origin, t.providerAgentId, t.chatId, t.threadId),
  uniqueIndex("bolter_bindings_room").on(t.roomId),
  check("bolter_bindings_revision", sql`${t.revision} >= 0`),
  check("bolter_bindings_state", sql`${t.state} IN ('active', 'paused', 'revoked')`),
  check("bolter_bindings_identity", sql`length(${t.origin}) > 0 AND length(${t.providerAgentId}) > 0 AND length(${t.chatId}) > 0`),
  ownerPolicy("bolter_bindings_owner", t.userId, true),
]).enableRLS();

/** Deduplication and provenance only; content lives in canonical session_messages. */
export const bolterInboxReceipts = pgTable("bolter_inbox_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  bindingId: uuid("binding_id").notNull(),
  bindingRevision: integer("binding_revision").notNull(),
  connectionGeneration: integer("connection_generation").notNull(),
  providerMessageId: text("provider_message_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  externalSenderId: text("external_sender_id").notNull(),
  sessionMessageId: integer("session_message_id").references(() => sessionMessages.id, { onDelete: "restrict" }),
  turnId: text("turn_id"),
  jobId: uuid("job_id").references(() => jobs.id, { onDelete: "restrict" }),
  state: text("state", { enum: ["pending", "accepted", "quarantined", "cancelled"] }).notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("bolter_inbox_owner_binding_id").on(t.userId, t.bindingId, t.id),
  foreignKey({ name: "bolter_inbox_binding_owner", columns: [t.userId, t.bindingId], foreignColumns: [bolterRoomBindings.userId, bolterRoomBindings.id] }).onDelete("restrict"),
  uniqueIndex("bolter_inbox_provider_message").on(t.bindingId, t.providerMessageId),
  uniqueIndex("bolter_inbox_canonical_message").on(t.sessionMessageId),
  check("bolter_inbox_state", sql`${t.state} IN ('pending', 'accepted', 'quarantined', 'cancelled') AND (${t.state} <> 'accepted' OR (${t.sessionMessageId} IS NOT NULL AND ${t.turnId} IS NOT NULL))`),
  check("bolter_inbox_identity", sql`${t.fingerprint} ~ '^[0-9a-f]{64}$' AND length(${t.providerMessageId}) > 0 AND length(${t.externalSenderId}) > 0 AND ${t.bindingRevision} >= 0 AND ${t.connectionGeneration} > 0`),
  ownerPolicy("bolter_inbox_owner", t.userId),
]).enableRLS();

/** Final canonical text references only. An uncertain send is never automatically retried. */
export const bolterOutbox = pgTable("bolter_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  bindingId: uuid("binding_id").notNull(),
  bindingRevision: integer("binding_revision").notNull(),
  connectionGeneration: integer("connection_generation").notNull(),
  sessionMessageId: integer("session_message_id").notNull().references(() => sessionMessages.id, { onDelete: "restrict" }),
  sourceInboxId: uuid("source_inbox_id"),
  /** Server-minted explicit share operation; outside text cannot mint this authority. */
  explicitShareId: uuid("explicit_share_id"),
  fingerprint: text("fingerprint").notNull(),
  state: text("state", { enum: ["pending", "publishing", "published", "uncertain", "cancelled"] }).notNull().default("pending"),
  claimToken: uuid("claim_token"),
  providerMessageId: text("provider_message_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "bolter_outbox_binding_owner", columns: [t.userId, t.bindingId], foreignColumns: [bolterRoomBindings.userId, bolterRoomBindings.id] }).onDelete("restrict"),
  foreignKey({ name: "bolter_outbox_reply_owner", columns: [t.userId, t.bindingId, t.sourceInboxId], foreignColumns: [bolterInboxReceipts.userId, bolterInboxReceipts.bindingId, bolterInboxReceipts.id] }).onDelete("restrict"),
  uniqueIndex("bolter_outbox_canonical_publication").on(t.bindingId, t.sessionMessageId),
  uniqueIndex("bolter_outbox_final_reply").on(t.sourceInboxId).where(sql`${t.sourceInboxId} IS NOT NULL`),
  index("bolter_outbox_owner_pending").on(t.userId, t.bindingId, t.createdAt).where(sql`${t.state} = 'pending'`),
  check("bolter_outbox_reason", sql`(${t.sourceInboxId} IS NOT NULL) <> (${t.explicitShareId} IS NOT NULL)`),
  check("bolter_outbox_identity", sql`${t.fingerprint} ~ '^[0-9a-f]{64}$' AND ${t.bindingRevision} >= 0 AND ${t.connectionGeneration} > 0`),
  check("bolter_outbox_state", sql`${t.state} IN ('pending', 'publishing', 'published', 'uncertain', 'cancelled') AND (${t.state} NOT IN ('publishing', 'published', 'uncertain') OR ${t.claimToken} IS NOT NULL) AND (${t.state} <> 'published' OR ${t.providerMessageId} IS NOT NULL)`),
  ownerPolicy("bolter_outbox_owner", t.userId),
]).enableRLS();

export type BolterConnection = typeof bolterConnections.$inferSelect;
export type BolterRoomBinding = typeof bolterRoomBindings.$inferSelect;
export type BolterInboxReceipt = typeof bolterInboxReceipts.$inferSelect;
export type BolterOutboxEntry = typeof bolterOutbox.$inferSelect;
