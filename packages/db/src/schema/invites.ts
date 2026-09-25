import {
  index,
  check,
  integer,
  pgTable,
  pgPolicy,
  pgRole,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";
import { groups } from "./trust";
import { rooms } from "./rooms";

/**
 * M066 — user-minted and (future) bootstrap-trust invitations.
 * CHECK constraints + partial unique index live in migration SQL
 * (`0027_m066_invites_constraints.sql`).
 */
export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    kind: text("kind").notNull(),
    targetGroupId: uuid("target_group_id").references(() => groups.id, {
      onDelete: "cascade",
    }),
    targetRoomId: uuid("target_room_id").references(() => rooms.id, {
      onDelete: "cascade",
    }),
    maxUses: integer("max_uses"),
    usedCount: integer("used_count").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "cascade",
    }),
    displayName: text("display_name"),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    /**
     * M105 Phase C — set by `bind-logto-user` when the Logto-side sign-up
     * succeeds and the local `users` row is JIT-created with `external_id =
     * sub`. Cleared (or implicitly superseded) by the subsequent
     * `complete-profile` call which bumps `usedCount`. Idempotency key for
     * `redeemInviteWithLogtoSub` retries.
     */
    halfRedeemedAt: timestamp("half_redeemed_at"),
    /** User durably reserved by the browser half-bind. */
    halfRedeemedUserId: uuid("half_redeemed_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_invites_token_hash").on(table.tokenHash),
    index("idx_invites_created_by").on(table.createdBy),
  ],
);

export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;

/**
 * M260 — one durable browser/mobile redemption binding per Human.
 *
 * The Invite row owns aggregate limits and revocation. This child owns only
 * the per-Human bind/completion coordination needed for independent and
 * overlapping hosted-signup journeys. The Logto subject remains canonical on
 * `users.external_id`; no token or external identity is duplicated here.
 */
export const inviteRedemptions = pgTable(
  "invite_redemptions",
  {
    inviteId: uuid("invite_id")
      .notNull()
      .references(() => invites.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    boundAt: timestamp("bound_at").notNull().defaultNow(),
    boundAdmissionEpoch: integer("bound_admission_epoch").notNull().default(0),
    completedAt: timestamp("completed_at"),
    completionAdmissionEpoch: integer("completion_admission_epoch"),
    joinMessage: text("join_message"),
    reviewState: text("review_state", { enum: ["pending", "approved", "rejected"] }),
    reviewRevision: integer("review_revision").notNull().default(0),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.inviteId, table.userId] }),
    index("idx_invite_redemptions_user_id").on(table.userId),
    index("invite_redemptions_review_idx").on(table.reviewState, table.inviteId, table.userId),
    check("invite_redemptions_review_message", sql`(${table.reviewState} IS NULL AND ${table.joinMessage} IS NULL AND ${table.reviewRevision} = 0)
      OR (${table.reviewState} IS NOT NULL AND ${table.reviewState} IN ('pending', 'approved', 'rejected') AND ${table.joinMessage} IS NOT NULL
        AND length(btrim(${table.joinMessage})) > 0 AND ${table.reviewRevision} > 0)`),
    pgPolicy("invite_redemptions_product", { for: "all", to: pgRole("nautilo").existing(), using: sql`true`, withCheck: sql`true` }),
  ],
).enableRLS();

export type InviteRedemption = typeof inviteRedemptions.$inferSelect;
export type NewInviteRedemption = typeof inviteRedemptions.$inferInsert;
