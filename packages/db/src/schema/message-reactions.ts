import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  integer,
} from "drizzle-orm/pg-core";
import { sessionMessages } from "./sessions";
import { actors } from "./trust";

/**
 * D212 / M121 — Slack-style reactions on session messages.
 *
 * Cardinality: one row per (message, actor, emoji). A single actor can
 * attach multiple distinct emoji to the same message. Toggling the same
 * emoji a second time removes the row.
 *
 * Reactors include both humans and agents. Both are Actors in the
 * multi-actor model (REL-ACT-AGT / REL-ACT-HUM): a human reacts as their
 * user-kind actor, an agent as its agent-kind mirror actor. This table
 * keys on `actor_id` — NOT `user_id` — because an agent has no users row.
 */
export const messageReactions = pgTable(
  "message_reactions",
  {
    messageId: integer("message_id")
      .notNull()
      .references(() => sessionMessages.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.actorId, table.emoji] }),
    index("idx_message_reactions_message").on(table.messageId),
    index("idx_message_reactions_actor").on(table.actorId),
  ],
);

export type MessageReaction = typeof messageReactions.$inferSelect;
export type NewMessageReaction = typeof messageReactions.$inferInsert;
