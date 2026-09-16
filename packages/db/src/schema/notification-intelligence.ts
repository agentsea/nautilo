import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { rooms } from "./rooms";
import { sessionMessages } from "./sessions";
import { users } from "./users";

export const NOTIFICATION_LEVELS = ["none", "direct", "all"] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export const DIRECTED_RECIPIENT_REASONS = [
  "direct_room",
  "mention",
  "explicit_reply",
  "agent_response",
] as const;
export type DirectedRecipientReason =
  (typeof DIRECTED_RECIPIENT_REASONS)[number];

export const SUBTHREAD_PARTICIPATION_REASONS = [
  "posted",
  "mention",
  "explicit_reply",
] as const;
export type SubthreadParticipationReason =
  (typeof SUBTHREAD_PARTICIPATION_REASONS)[number];

/**
 * M233 — Human-owned account notification policy.
 *
 * Absence is meaningful and resolves to `direct` in the trust service. The
 * database default protects explicit inserts while avoiding a migration that
 * rewrites every existing Human.
 */
export const userNotificationSettings = pgTable(
  "user_notification_settings",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    defaultLevel: text("default_level", { enum: NOTIFICATION_LEVELS })
      .notNull()
      .default("direct"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "user_notification_settings_level_check",
      sql`${table.defaultLevel} IN ('none', 'direct', 'all')`,
    ),
  ],
);

/**
 * M233 — optional Human policy override for one top-level Room.
 *
 * The service owns current-membership and top-level-Room validation.
 * `inherit` is never stored: the mutation deletes this row.
 */
export const roomNotificationSettings = pgTable(
  "room_notification_settings",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    level: text("level", { enum: NOTIFICATION_LEVELS }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.roomId] }),
    check(
      "room_notification_settings_level_check",
      sql`${table.level} IN ('none', 'direct', 'all')`,
    ),
    index("idx_room_notification_settings_room").on(table.roomId, table.userId),
  ],
);

/**
 * M233 — immutable message-to-Human directed facts.
 *
 * Reasons remain additive. The composite key makes retry and multi-producer
 * convergence idempotent without mutating historical classification.
 */
export const sessionMessageDirectedRecipients = pgTable(
  "session_message_directed_recipients",
  {
    messageId: integer("message_id")
      .notNull()
      .references(() => sessionMessages.id, { onDelete: "cascade" }),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason", { enum: DIRECTED_RECIPIENT_REASONS }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.messageId, table.recipientId, table.reason],
    }),
    check(
      "session_message_directed_recipients_reason_check",
      sql`${table.reason} IN ('direct_room', 'mention', 'explicit_reply', 'agent_response')`,
    ),
    index("idx_smdr_recipient_message").on(table.recipientId, table.messageId),
  ],
);

/**
 * M233 — prospective per-Human notification participation in a Subthread.
 *
 * The first insert wins. Service validation proves both that the Room is a
 * Subthread and that `from_message_id` belongs to it.
 */
export const subthreadNotificationParticipants = pgTable(
  "subthread_notification_participants",
  {
    subthreadRoomId: uuid("subthread_room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fromMessageId: integer("from_message_id")
      .notNull()
      .references(() => sessionMessages.id, { onDelete: "cascade" }),
    reason: text("reason", { enum: SUBTHREAD_PARTICIPATION_REASONS }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.subthreadRoomId, table.userId] }),
    check(
      "subthread_notification_participants_reason_check",
      sql`${table.reason} IN ('posted', 'mention', 'explicit_reply')`,
    ),
    index("idx_snp_user_room_message").on(
      table.userId,
      table.subthreadRoomId,
      table.fromMessageId,
    ),
  ],
);

export type UserNotificationSetting =
  typeof userNotificationSettings.$inferSelect;
export type NewUserNotificationSetting =
  typeof userNotificationSettings.$inferInsert;
export type RoomNotificationSetting =
  typeof roomNotificationSettings.$inferSelect;
export type NewRoomNotificationSetting =
  typeof roomNotificationSettings.$inferInsert;
export type SessionMessageDirectedRecipient =
  typeof sessionMessageDirectedRecipients.$inferSelect;
export type NewSessionMessageDirectedRecipient =
  typeof sessionMessageDirectedRecipients.$inferInsert;
export type SubthreadNotificationParticipant =
  typeof subthreadNotificationParticipants.$inferSelect;
export type NewSubthreadNotificationParticipant =
  typeof subthreadNotificationParticipants.$inferInsert;
