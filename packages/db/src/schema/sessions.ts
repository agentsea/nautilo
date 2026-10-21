import { sql } from "drizzle-orm";
import {
  check,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { agents } from "./agents";
import { rooms } from "./rooms";
import { cryptoObjects } from "./crypto-storage";

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: text("thread_id").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    personaId: text("persona_id").notNull().default("owner"),
    // Nullable for legacy rows; seedDefaultAgent backfills existing rows on first boot.
    agentId: uuid("agent_id").references(() => agents.id),
    // Nullable for legacy rows; seedDefaultRoom backfills existing rows on first boot.
    roomId: uuid("room_id").references(() => rooms.id),
    /**
     * Channel that opened the session ('tui', 'electron', or a future connector).
     * Legacy rows remain nullable; seed initialization backfills 'tui'. Request
     * context and device pairing use the concrete channel at session creation.
     */
    channel: text("channel"),
    title: text("title"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    messageCount: integer("message_count").notNull().default(0),
    /** Canonical transcript source generation; maintained only by Message source triggers. */
    messageSourceRevision: integer("message_source_revision").notNull().default(0),
    tokenCount: integer("token_count").notNull().default(0),
  },
  (table) => [
    check("sessions_message_source_revision", sql`${table.messageSourceRevision} >= 0`),
    index("idx_sessions_thread_id").on(table.threadId),
    index("idx_sessions_owner_id").on(table.ownerId),
    /** Room journal/recent-context readers fan in every Room session. */
    index("idx_sessions_room_id").on(table.roomId),
    /** at most one session row per (human owner, LangGraph thread). */
    uniqueIndex("uq_sessions_owner_thread").on(table.ownerId, table.threadId),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export const sessionMessages = pgTable(
  "session_messages",
  {
    id: serial("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    role: text("role").notNull(),
    content: text("content"),
    toolCalls: text("tool_calls"),
    /** Persisted LangChain tool name on `role = 'tool'` rows; NULL for other roles / legacy. */
    toolName: text("tool_name"),
    /** idempotent transcript writes; NULL on legacy rows (excluded from uniqueness). */
    fingerprint: text("fingerprint"),
    /**
     * durable server-authored identity of a Human turn. Written only
     * on `role = 'user'` rows from the append call's `humanTurnId`; NULL for
     * assistant/tool/system and historical rows. Unlike `fingerprint`, this
     * retains the opaque turn UUID so a later Agent response can pair-validate
     * its causal Human and turn in the same Room/Subthread scope.
     */
    humanTurnId: text("human_turn_id"),
    /** Restrictive provenance retained even after bridge metadata is removed. */
    externalAuthorship: boolean("external_authorship").notNull().default(false),
    /**
     * nullable shadow mapping to the one canonical encrypted revision.
     * The existing plaintext columns remain authoritative while activation is
     * disabled. A successful edit advances this mapping to a fresh object.
     */
    cryptoObjectId: text("crypto_object_id").references(
      () => cryptoObjects.objectId,
    ),
    /** Database-maintained; NULL with ordinary content selects literal overflow search. */
    contentSearch: tsvector("content_search"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** NULL until the first successful Human-authored text edit. */
    editedAt: timestamp("edited_at", { withTimezone: true }),
    /** optimistic-concurrency token for Human-authored text edits. */
    editRevision: integer("edit_revision").notNull().default(0),
    /**
     * `main` (default) vs `subagent`. Subagent rows use a dedicated
     * `sessions.thread_id` but are tagged so combined views can filter.
     */
    transcriptOrigin: text("transcript_origin").notNull().default("main"),
    /** Parent LangGraph thread when `transcript_origin = 'subagent'`. */
    parentThreadId: text("parent_thread_id"),
    scopeId: uuid("scope_id"),
    /**
     * Denormalization: which Subthread does this
     * message live in? NULL means top-level Room message. Set by the
     * trust helper that inserts a Subthread reply.
     *
     * TODO(stack-3 phase-4): wire `subthread_room_id` from the Subthread
     * reply insert path once the drawer route lands.
     */
    subthreadRoomId: uuid("subthread_room_id").references(() => rooms.id, {
      onDelete: "set null",
    }),
    /**
     * denormalized reply count on root messages (only). Maintained
     * by the trust helper on Subthread reply insert/delete. Default 0.
     * Top-level messages without an anchored Subthread keep this at 0.
     */
    replyCount: integer("reply_count").notNull().default(0),
    /**
     * denormalized last-reply timestamp on root messages (only).
     * NULL until the first reply lands.
     */
    lastReplyAt: timestamp("last_reply_at", { withTimezone: true }),
    /**
     * monotonic revision of this root's denormalized reply summary
     * (`reply_count` + `last_reply_at`). Bumped exactly once per
     * transactional recompute that actually changes the summary (a new
     * counted child reply is inserted, or a counted child reply is
     * deleted). Replay / dedup of an already-persisted reply does NOT
     * bump it. Lets clients detect stale summary hydration and
     * reconcile optimistic root metadata. 0 until the first counted
     * reply lands. Only authoritative on root (anchor) rows; child rows
     * carry no summary and keep this at 0.
     */
    summaryRevision: integer("summary_revision").notNull().default(0),
    /**
     * Per-message read state. For 1:1 Rooms, the scalar is the
     * truth. For group Rooms (3+ Humans), use session_message_recipient_state
     * junction; the scalar may be NULL or aggregated server-side.
     *
     * delivered_at: server stamps when the message has been published to
     * at least one recipient's WS connection (best-effort; no MLS-style
     * cryptographic delivery proof in M1).
     *
     * read_at: client stamps when the message scrolls into view in the
     * active Room.
     */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    /**
     * Quote-reply linkage. Same-Room references; cross-Room
     * quoting is out of scope. ON DELETE SET NULL so a deleted original
     * doesn't break the reply (renders as "(deleted message)" inline).
     *
     * TODO(stack-3 phase-7): wire `reply_to_message_id` from the quote-reply route.
     */
    replyToMessageId: integer("reply_to_message_id").references(
      (): import("drizzle-orm/pg-core").AnyPgColumn => sessionMessages.id,
      { onDelete: "set null" },
    ),
    /**
     * Used by the Task report-back ping to tag and hide
     * `originatedBy='task'` rows; nullable for ordinary messages.
     */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    index("idx_session_messages_session_id").on(table.sessionId),
    /** cursor/range scans within the Room's member sessions. */
    index("idx_session_messages_session_id_id").on(table.sessionId, table.id),
    index("idx_session_messages_session_created_id").on(table.sessionId, table.createdAt, table.id),
    index("idx_session_messages_content_search").using(
      "gin",
      table.contentSearch,
    ),
    // Allows the search OR to combine ordinary GIN hits with only overflow rows.
    index("idx_session_messages_search_overflow").on(table.sessionId)
      .where(sql`${table.contentSearch} IS NULL AND ${table.content} IS NOT NULL`),
    uniqueIndex("uq_session_messages_session_fingerprint")
      .on(table.sessionId, table.fingerprint)
      .where(sql`${table.fingerprint} IS NOT NULL`),
    unique("uq_session_messages_crypto_object_id").on(table.cryptoObjectId),
    index("idx_session_messages_human_turn_id")
      .on(table.humanTurnId)
      .where(sql`${table.humanTurnId} IS NOT NULL`),
    check(
      "session_messages_edit_revision_nonnegative",
      sql`${table.editRevision} >= 0`,
    ),
    check(
      "session_messages_human_turn_id_role_check",
      sql`${table.humanTurnId} IS NULL OR ${table.role} = 'user'`,
    ),
    check("session_messages_external_authorship_role_check", sql`NOT ${table.externalAuthorship} OR ${table.role} = 'user'`),
    index("idx_session_messages_subthread")
      .on(table.subthreadRoomId)
      .where(sql`${table.subthreadRoomId} IS NOT NULL`),
    index("idx_session_messages_reply_to")
      .on(table.replyToMessageId)
      .where(sql`${table.replyToMessageId} IS NOT NULL`),
  ],
);

export type SessionMessage = typeof sessionMessages.$inferSelect;
export type NewSessionMessage = typeof sessionMessages.$inferInsert;
