import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export const memberRollouts = pgTable(
  "member_rollouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverInstanceId: uuid("server_instance_id").notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    manifest: jsonb("manifest").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("applying"),
    /** Null after the creator's account is removed; receipt remains auditable. */
    createdBy: uuid("created_by").$type<string>().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("member_rollouts_fingerprint_check", sql`${table.fingerprint} ~ '^[a-f0-9]{64}$'`),
    check(
      "member_rollouts_status_check",
      sql`${table.status} IN ('applying', 'complete', 'partial', 'repair_required')`,
    ),
    uniqueIndex("uq_member_rollouts_instance_idempotency")
      .on(table.serverInstanceId, table.idempotencyKey),
    index("idx_member_rollouts_created_by_created_at").on(table.createdBy, table.createdAt),
  ],
);

export const memberRolloutItems = pgTable(
  "member_rollout_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rolloutId: uuid("rollout_id").notNull().references(() => memberRollouts.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    handle: varchar("handle", { length: 64 }).notNull(),
    roleSlug: varchar("role_slug", { length: 32 }).notNull(),
    targetGroupId: uuid("target_group_id").notNull(),
    state: varchar("state", { length: 32 }).notNull().default("planned"),
    receiptId: uuid("receipt_id"),
    memberId: uuid("member_id").references(() => users.id, { onDelete: "set null" }),
    errorCode: varchar("error_code", { length: 64 }),
    credentialDisposition: varchar("credential_disposition", { length: 32 }).notNull().default("none"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("member_rollout_items_sequence_check", sql`${table.sequence} >= 0`),
    check(
      "member_rollout_items_state_check",
      sql`${table.state} IN ('planned', 'external_pending', 'nautilo_committed', 'credential_delivered', 'repair_required', 'complete', 'failed_before_change', 'unknown')`,
    ),
    check(
      "member_rollout_items_credential_disposition_check",
      sql`${table.credentialDisposition} IN ('none', 'issued', 'not_reissued')`,
    ),
    uniqueIndex("uq_member_rollout_items_sequence").on(table.rolloutId, table.sequence),
    uniqueIndex("uq_member_rollout_items_handle").on(table.rolloutId, table.handle),
    index("idx_member_rollout_items_state").on(table.rolloutId, table.state),
  ],
);

export type MemberRolloutRow = typeof memberRollouts.$inferSelect;
export type MemberRolloutItemRow = typeof memberRolloutItems.$inferSelect;
