import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { rooms } from "./rooms";
import { actors } from "./trust";
import { users } from "./users";

/**
 * D190 / D279 Phase 3 — transient room silence windows (mute + deaf).
 *
 * `bot_actor_id IS NULL` = all bots in the room; set = a single bot.
 * `observe` (per-bot permanent mode) is a separate axis — this table is
 * the time-bounded window substrate with auto-expiry.
 *
 * Active-window predicate: `now ∈ [started_at, expires_at]` AND
 * (`bot_actor_id IS NULL OR bot_actor_id = <bot>`). deaf takes precedence
 * over mute when both match.
 */
export const roomSilenceState = pgTable(
  "room_silence_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    /** NULL = all bots; set = single-bot window. */
    botActorId: uuid("bot_actor_id").references(() => actors.id, {
      onDelete: "cascade",
    }),
    kind: text("kind", { enum: ["mute", "deaf"] }).notNull(),
    setByUserId: uuid("set_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "room_silence_state_kind_check",
      sql`${table.kind} IN ('mute', 'deaf')`,
    ),
    index("idx_room_silence_state_room_expires").on(
      table.roomId,
      table.expiresAt,
    ),
  ],
);

export type RoomSilenceState = typeof roomSilenceState.$inferSelect;
export type NewRoomSilenceState = typeof roomSilenceState.$inferInsert;
