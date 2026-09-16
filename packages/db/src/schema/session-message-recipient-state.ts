import {
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { sessionMessages } from "./sessions";

/**
 * D124 — Per-recipient read state for group Rooms (3+ Humans). 1:1
 * Rooms still use the scalar columns on session_messages; this
 * junction is populated only for group Rooms (the trust helper
 * decides at insert time based on room composition).
 *
 * Cardinality: one row per (message, recipient). Recipient is the
 * Human user, not the Actor — a Human reading on multiple devices
 * still has one row; "delivered to which device" is out of scope.
 */
export const sessionMessageRecipientState = pgTable(
  "session_message_recipient_state",
  {
    messageId: integer("message_id")
      .notNull()
      .references(() => sessionMessages.id, { onDelete: "cascade" }),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.recipientId] }),
    index("idx_smrs_recipient").on(table.recipientId),
  ],
);

export type SessionMessageRecipientState =
  typeof sessionMessageRecipientState.$inferSelect;
