import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users";

/**
 * M297 — one Server-local, directional Human block.
 *
 * The relation belongs to Human users rather than Actors: a Human has one
 * canonical user identity on this Server, while Agents are deliberately out
 * of scope. Blocking is blocker-owned and idempotent through the composite
 * primary key.
 */
export const humanBlocks = pgTable(
  "human_blocks",
  {
    blockerUserId: uuid("blocker_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedUserId: uuid("blocked_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.blockerUserId, table.blockedUserId] }),
    index("idx_human_blocks_blocked_user").on(table.blockedUserId),
    check(
      "human_blocks_no_self_check",
      sql`${table.blockerUserId} <> ${table.blockedUserId}`,
    ),
  ],
);

export type HumanBlock = typeof humanBlocks.$inferSelect;
export type NewHumanBlock = typeof humanBlocks.$inferInsert;
