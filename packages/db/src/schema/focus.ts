import { index, integer, pgTable, serial, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { rooms } from "./rooms";
import { actors } from "./trust";

/**
 * M134 Phase 1 — append-only, server-written focus event log.
 *
 * A "focus link" is a transient, server-owned relationship between one
 * human Actor and one Agent in one Room (the "don't re-@ a bot" substrate).
 * Active focus is DERIVED by folding this log (see `deriveActiveFoci`); the
 * table is never UPDATEd. Bots can never write here — the only authorized
 * writer is `packages/trust/src/focus/writer.ts`.
 *
 * event_type:
 *   'opened'   — a new focus link (focus_id) starts; sets expires_at.
 *   'extended' — sliding TTL push-forward on an already-active focus_id.
 *   'expired'  — window lapsed; written LAZILY on next touch. For this row
 *                `expires_at` holds the LAPSED window (the expires_at that ran
 *                out), `occurred_at` is the wall-clock the row was written.
 *   'cleared'  — explicit user clear; final for that focus_id (clearing wins).
 *
 * The DB-level CHECK constraints `focus_events_event_type_check` and
 * `focus_events_source_check` are hand-maintained in the generated migration
 * (drizzle `text({enum})` is TS-only and does not emit SQL CHECKs).
 */
export const focusEvents = pgTable(
  "focus_events",
  {
    id: serial("id").primaryKey(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userActorId: uuid("user_actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    botActorId: uuid("bot_actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    /** Stable per focus link. New focus = new focus_id; cleared ids never reused. */
    focusId: uuid("focus_id").notNull(),
    eventType: text("event_type", {
      enum: ["opened", "extended", "expired", "cleared"],
    }).notNull(),
    /** mention | reply | ui | inferred — only on opened/extended. NULL otherwise. */
    source: text("source", { enum: ["mention", "reply", "ui", "inferred"] }),
    /** Human-readable rationale for inferred opens / clears. */
    reason: text("reason"),
    /** D302 R8 — optional persisted message that opened this focus. FK enforced in SQL migration. */
    anchorMessageId: integer("anchor_message_id"),
    /** Sliding-TTL target on opened/extended; lapsed window on 'expired'; NULL on 'cleared'. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Server clock the event was recorded. */
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_focus_events_room_user").on(
      table.roomId,
      table.userActorId,
      table.occurredAt,
    ),
    index("idx_focus_events_focus_id").on(table.focusId),
  ],
);

export type FocusEvent = typeof focusEvents.$inferSelect;
export type NewFocusEvent = typeof focusEvents.$inferInsert;
