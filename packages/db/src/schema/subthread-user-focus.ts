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
import { actors } from "./trust";

/**
 * D426 Phase 2 — durable, requester-private Thread Responder state.
 *
 * A "Thread Responder" is the single Genie a given human has chosen to keep
 * answering them inside one Subthread Room. It is:
 *
 *   - **Private per (Subthread, human).** Keyed by
 *     `(subthread_room_id, user_actor_id)`; one row per pair. Two humans in
 *     the same Subthread carry independent responders and never see each
 *     other's selection.
 *   - **Durable.** No idle expiry / sliding TTL — this is NOT the transient
 *     90-second parent-room `focus_events` link. It survives until the human
 *     clears it, the Genie becomes ineligible (parent membership removal /
 *     `observe`), or the Subthread is archived. The `focus_events` table is
 *     untouched; this substrate does not add an expiry-based variant of it.
 *   - **Status-bearing.** `active` (the selected Genie answers), `cleared`
 *     (the human dismissed it), or `invalidated` (an eligibility change made
 *     the stored Genie unavailable). `cleared` and `invalidated` are both
 *     terminal-ish but a later `replace` can re-establish into `active`.
 *
 * Revision is monotonic: bumped exactly once per mutating write (insert,
 * replace, clear, invalidate). Lets the requester-private realtime delta
 * (Phase 2.5, owned by a later agent) detect stale hydration.
 *
 * Eligibility is NOT stored — it is resolved dynamically from the PARENT
 * Room's `room_members.agent_response_mode` at read time (see
 * `packages/trust/src/agent-response.ts` → `resolveSubthreadAgentEligibility`).
 * That keeps `observe` from drifting into child rooms: even if a child
 * `room_members` row says `active`, a parent `observe` makes the responder
 * unavailable. Parent focus and parent silence stay separate axes and never
 * flow through this table.
 *
 * The DB-level CHECK constraints `subthread_user_focus_status_check` and
 * `subthread_user_focus_source_check` are hand-maintained in the generated
 * migration (drizzle `text({enum})` is TS-only and emits no SQL CHECK — same
 * convention as `focus_events`).
 */
export const subthreadUserFocus = pgTable(
  "subthread_user_focus",
  {
    /** The Subthread Room this responder lives in. FK CASCADE on room delete. */
    subthreadRoomId: uuid("subthread_room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    /** The human Actor who owns this private responder. FK CASCADE on actor delete. */
    userActorId: uuid("user_actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    /** The selected Genie Actor. FK CASCADE on actor delete. */
    botActorId: uuid("bot_actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    /** `active` | `cleared` | `invalidated`. CHECK-enforced in the migration. */
    status: text("status", {
      enum: ["active", "cleared", "invalidated"],
    })
      .notNull()
      .default("active"),
    /**
     * How the current `active` responder was established. NULL on
     * `cleared`/`invalidated` rows that were never re-established. CHECK-
     * enforced in the migration (NULL OR one of the enum).
     */
    source: text("source", {
      enum: ["mention", "reply", "ui", "inferred", "affinity"],
    }),
    /**
     * D426 Phase 2.4 — optional persisted message that established this
     * responder (the first qualifying message below an eligible Genie root).
     * FK enforced in SQL migration; ON DELETE SET NULL so deleting the
     * establishing message tombstones the link without losing the responder.
     */
    establishedMessageId: integer("established_message_id")
      .references(() => sessionMessages.id, { onDelete: "set null" }),
    /** Wall-clock the current `active` responder was established. */
    establishedAt: timestamp("established_at", { withTimezone: true }),
    /** Monotonic per-pair revision; bumped once per mutating write. */
    revision: integer("revision").notNull().default(0),
    /** Why an `invalidated` row was invalidated; NULL otherwise. */
    invalidatedReason: text("invalidated_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.subthreadRoomId, table.userActorId] }),
    check(
      "subthread_user_focus_status_check",
      sql`${table.status} IN ('active', 'cleared', 'invalidated')`,
    ),
    check(
      "subthread_user_focus_source_check",
      sql`${table.source} IS NULL OR ${table.source} IN ('mention', 'reply', 'ui', 'inferred', 'affinity')`,
    ),
    index("idx_subthread_user_focus_bot").on(table.botActorId),
    index("idx_subthread_user_focus_user").on(table.userActorId),
  ],
);

export type SubthreadUserFocus = typeof subthreadUserFocus.$inferSelect;
export type NewSubthreadUserFocus = typeof subthreadUserFocus.$inferInsert;
