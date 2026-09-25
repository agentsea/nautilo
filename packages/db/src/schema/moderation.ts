import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgPolicy, pgRole, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { groups } from "./trust";
import { rooms } from "./rooms";
import { users } from "./users";

const productRole = pgRole("nautilo").existing();
const productPolicy = (name: string) => pgPolicy(name, {
  for: "all", to: productRole, using: sql`true`, withCheck: sql`true`,
});

/** Scope must be conveyed by the same Group as the Room capability. */
export const groupModerationScopes = pgTable("group_moderation_scopes", {
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
}, (t) => [
  primaryKey({ columns: [t.groupId, t.roomId] }),
  index("group_moderation_scopes_room_idx").on(t.roomId),
  productPolicy("group_moderation_scopes_product"),
]).enableRLS();

/** A retained identity match survives deletion of its local Human row. */
export const moderationSubjects = pgTable("moderation_subjects", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  identityDigest: text("identity_digest"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("moderation_subjects_user_idx").on(t.userId),
  uniqueIndex("moderation_subjects_identity_idx").on(t.identityDigest),
  check("moderation_subjects_digest_check", sql`${t.identityDigest} IS NULL OR ${t.identityDigest} ~ '^[0-9a-f]{64}$'`),
  productPolicy("moderation_subjects_product"),
]).enableRLS();

/**
 * Historical outcomes are not authority. The generated row guard permits
 * delivery checkpoints and text erasure, but never changes replay identity.
 * Scope UUIDs intentionally have no Room FK: Room deletion must not turn a
 * Room action into a Server action or delete a replay tombstone.
 */
export const moderationActions = pgTable("moderation_actions", {
  operationId: uuid("operation_id").primaryKey(),
  requestDigest: text("request_digest").notNull(),
  requesterUserId: uuid("requester_user_id"),
  subjectId: uuid("subject_id").notNull().references(() => moderationSubjects.id),
  roomId: uuid("room_id"),
  action: text("action", { enum: ["ban", "kick", "timeout", "mute", "lift"] }).notNull(),
  restrictionId: uuid("restriction_id"),
  reason: text("reason"),
  privateNote: text("private_note"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  auditRecordedAt: timestamp("audit_recorded_at", { withTimezone: true }),
  convergedAt: timestamp("converged_at", { withTimezone: true }),
  deleteCommunityMessages: boolean("delete_community_messages").notNull().default(false),
  communityMessagesDeletedAt: timestamp("community_messages_deleted_at", { withTimezone: true }),
}, (t) => [
  index("moderation_actions_subject_cursor_idx").on(t.subjectId, t.createdAt, t.operationId),
  index("moderation_actions_scope_cursor_idx").on(t.roomId, t.createdAt, t.operationId),
  index("moderation_actions_pending_audit_idx").on(t.createdAt, t.operationId).where(sql`${t.auditRecordedAt} IS NULL`),
  index("moderation_actions_pending_convergence_idx").on(t.createdAt, t.operationId).where(sql`${t.convergedAt} IS NULL`),
  check("moderation_actions_message_cleanup_scope", sql`NOT ${t.deleteCommunityMessages} OR (${t.action} = 'ban' AND ${t.roomId} IS NULL)`),
  check("moderation_actions_digest_check", sql`${t.requestDigest} ~ '^[0-9a-f]{64}$'`),
  check("moderation_actions_kind_check", sql`${t.action} IN ('ban', 'kick', 'timeout', 'mute', 'lift')`),
  check("moderation_actions_restriction_check", sql`(${t.action} = 'kick') = (${t.restrictionId} IS NULL)`),
  productPolicy("moderation_actions_product"),
]).enableRLS();

/** Independent restrictions compose; lifting one does not enable an account. */
export const moderationRestrictions = pgTable("moderation_restrictions", {
  id: uuid("id").primaryKey(),
  subjectId: uuid("subject_id").notNull().references(() => moderationSubjects.id),
  roomId: uuid("room_id"),
  kind: text("kind", { enum: ["access", "participation"] }).notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  liftedAt: timestamp("lifted_at", { withTimezone: true }),
  revision: integer("revision").notNull().default(1),
  createOperationId: uuid("create_operation_id").notNull().references(() => moderationActions.operationId),
  liftOperationId: uuid("lift_operation_id").references(() => moderationActions.operationId),
}, (t) => [
  index("moderation_restrictions_active_idx").on(t.subjectId, t.roomId, t.kind, t.expiresAt).where(sql`${t.liftedAt} IS NULL`),
  check("moderation_restrictions_kind_check", sql`${t.kind} IN ('access', 'participation')`),
  check("moderation_restrictions_times_check", sql`${t.expiresAt} IS NULL OR ${t.expiresAt} > ${t.startsAt}`),
  check("moderation_restrictions_revision_check", sql`${t.revision} > 0`),
  check("moderation_restrictions_lift_check", sql`(${t.liftedAt} IS NULL) = (${t.liftOperationId} IS NULL)`),
  productPolicy("moderation_restrictions_product"),
]).enableRLS();

/** Admission withdrawal preserves the Human's account and canonical graph. */
export const serverAdmission = pgTable("server_admission", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  epoch: integer("epoch").notNull().default(0),
  admitted: boolean("admitted").notNull().default(false),
  operationId: uuid("operation_id").references(() => moderationActions.operationId),
}, (t) => [
  check("server_admission_epoch_check", sql`${t.epoch} >= 0`),
  productPolicy("server_admission_product"),
]).enableRLS();

export type ModerationActionRow = typeof moderationActions.$inferSelect;
export type ModerationRestrictionRow = typeof moderationRestrictions.$inferSelect;

/** One Server-owned switch, shared by all Invite publication transactions. */
export const serverModerationPolicy = pgTable("server_moderation_policy", {
  singleton: boolean("singleton").primaryKey().default(true),
  enabled: boolean("enabled").notNull().default(false),
  joinsPaused: boolean("joins_paused").notNull().default(false),
  approvalRequired: boolean("approval_required").notNull().default(false),
  revision: integer("revision").notNull().default(1),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("server_moderation_policy_singleton", sql`${t.singleton}`),
  check("server_moderation_policy_revision", sql`${t.revision} > 0`),
  productPolicy("server_moderation_policy_product"),
]).enableRLS();
