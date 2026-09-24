import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { actors, namespaces } from "./trust";

/**
 * D476 — canonical PostgreSQL half of Room-label normalization.
 *
 * NFKC handles compatibility forms; lower-case is followed by two explicit
 * Unicode folds where JavaScript and PostgreSQL otherwise differ under the
 * supported English/Unicode runtime: combining dot-above is removed after
 * lower-casing dotted I, and final sigma is folded to ordinary sigma.
 */
export function normalizedRoomLabelSql(value: SQL): SQL {
  return sql`btrim(regexp_replace(replace(replace(lower(normalize(${value}, NFKC)), chr(775), ''), 'ς', 'σ'), '[[:space:][:punct:]]+', ' ', 'g'))`;
}

/**
 * M042B — rooms table.
 *
 * A room is the routing identity for a conversation. Today the owner's
 * deployment has exactly one seeded `type='private'` room (owner +
 * default agent). Iteration 2 adds shared rooms and per-user private
 * rooms; Iteration 5 adds cross-server rooms. The shape below is
 * intentionally minimal for M042B and designed to grow in place.
 *
 * `graphThreadId` is the opaque string we hand to LangGraph's
 * `PostgresSaver` as `configurable.thread_id`. We do NOT own the
 * langchain.* schema, so we never rewrite saver-owned rows. The
 * seeded default room sets `graph_thread_id = 'app:default'` so every
 * pre-existing checkpoint stays addressable 1:1 through the new room.
 * Rooms created after M042B get `graph_thread_id = 'room:<id>'`.
 *
 * M044 additions:
 *   - `namespaceId` — 1:1 with the Room's Namespace (REL-NSP-RMS).
 *     The Namespace is minted transactionally with the Room by
 *     `seedDefaultRoom`; it's the access-envelope unit for every
 *     memory / artifact written during the Room's conversation.
 *     NOT NULL — the canonical model has no Room-without-Namespace
 *     state.
 *   - `humanActorIds` — denormalized set of `actors.id` (kind='user')
 *     for the Room's human members. Backs the Room-subset rule
 *     (`rooms.human_actor_ids @> H(currentRoom)` → which Rooms are
 *     readable from currentRoom, REL-HUM-NSP / REL-NSP-RMS). Kept
 *     in sync by `seedDefaultRoom` on initial insert and by every
 *     future room_members mutation via `updateRoomHumanActors`
 *     (packages/trust/src/queries.ts). GIN-indexed for fast `@>`
 *     containment lookups.
 *
 * M076 — before deleting a Room or its Namespace, callers MUST run
 * `cascadeMemoriesOnNamespaceDelete(namespaceId)` so junction edges are
 * detached / re-homed; naive `DELETE FROM namespaces` fails FK RESTRICT on
 * `memory_namespaces.namespace_id`.
 */
export const rooms = pgTable(
  "rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 'private' | 'shared' | 'dm' — M042B seeds only 'private'. */
    type: text("type").notNull(),
    label: text("label").notNull(),
    /**
     * D476 — database-owned search projection for authorized Room-name
     * resolution. It is generated from the display label, so renames and
     * direct SQL updates cannot leave a stale routing key behind. This is
     * deliberately not a user-facing identifier: the resolver still returns
     * only labels and checkpoint-owned choice handles.
     *
     * The expression mirrors the ASCII/Unicode-separator portion of
     * `normalizeRoomName`: lower-case, collapse whitespace/punctuation, and
     * trim. JavaScript performs the final NFKC-aware semantic comparison once
     * the bounded candidate set is returned.
     */
    normalizedLabel: text("normalized_label").generatedAlwaysAs(
      (): ReturnType<typeof sql> =>
        normalizedRoomLabelSql(sql.raw("label")),
    ),
    /**
     * Opaque LangGraph `thread_id` for this room. Decoupled from our
     * own laneKey/threadId so we never touch saver-owned tables.
     */
    graphThreadId: text("graph_thread_id").notNull(),
    /**
     * M044 — the Room's canonical Namespace (REL-NSP-RMS 1:1). Every
     * memory / artifact written during this Room's conversation
     * carries this namespace id. NOT NULL; minted with the Room by
     * `seedDefaultRoom` in the same transaction.
     */
    namespaceId: uuid("namespace_id")
      .notNull()
      .references(() => namespaces.id),
    /**
     * M290 — product-owned monotonic authority revision for the Room-derived
     * Namespace audience. The database advances it with membership changes;
     * crypto heads bind this value instead of a Domain/binding revision.
     */
    namespaceAccessRevision: bigint("namespace_access_revision", {
      mode: "number",
    }).notNull().default(0),
    /**
     * M044 — denormalized human-member actor-id set (REL-HUM-NSP
     * subset rule). The resolver's `findReadableNamespacesForSubset`
     * uses `@> H(currentRoom)` to enumerate every Room whose human
     * set is a superset of the current Room's; that Room's Namespace
     * joins `readableNamespaces`. Kept in sync by `seedDefaultRoom`
     * (initial insert) + `updateRoomHumanActors` (future room-join /
     * classify_actor flows). Default `'{}'` is a safe empty — an
     * empty set trivially has the subset property for the owner
     * envelope path, but in practice every row gets populated at
     * insert time.
     */
    humanActorIds: uuid("human_actor_ids").array().notNull().default([]),
    /**
     * D111 — Room kind: 'private' | 'group' | 'multi_agent' | 'subthread'.
     * M124 adds 'open' — a discoverable, self-joinable public room
     * (single-tenant: 'open' ⇔ listed in this Server's directory). Distinct
     * from `type` (which is the legacy M042B 'private' | 'shared' | 'dm'
     * bucket; will be retired in a follow-up sweep). `kind` is the dispatch
     * surface for `selectRoomShape()` (D124 Phase 6) and the subthread
     * invariant (REL-RMS-RMS).
     *
     * Backfilled to 'private' for every existing M042B row in 0046; new
     * rooms set kind explicitly through the trust helpers. The DB-level
     * CHECK constraint `rooms_kind_check` is hand-maintained (migrations
     * 0047 + 0064 + 0075 + 0090) — Drizzle's `text({enum})` is TS-only and does
     * not emit SQL for it, so widening this list requires a hand-written
     * migration.
     *
     * M173 adds `'access'` — a non-conversational, humans-only membership
     * container that backs a Namespace for an exact human access set (memory
     * access bookkeeping). It never hosts a chat and is excluded from every
     * room-enumeration surface (mirrors the `'task'` exclusion precedent).
     */
    kind: text("kind", {
      enum: ["private", "group", "multi_agent", "subthread", "open", "task", "access"],
    })
      .notNull()
      .default("private"),
    /**
     * D111 / REL-RMS-RMS — parent-Room FK for Subthreads. Non-NULL iff
     * `kind = 'subthread'`. ON DELETE CASCADE so deleting a parent Room
     * removes its Subthreads transactionally.
     */
    parentRoomId: uuid("parent_room_id").references(
      (): import("drizzle-orm/pg-core").AnyPgColumn => rooms.id,
      { onDelete: "cascade" },
    ),
    /**
     * D111 / REL-RMS-RMS — anchor message FK for Subthreads. Non-NULL iff
     * `kind = 'subthread'`. ON DELETE SET NULL so deleting the anchor
     * message tombstones the Subthread (existing replies stay readable;
     * the parent message renders as 'deleted' with a "View N replies"
     * affordance — D111 Phase 4 lifecycle decision).
     *
     * FK to `session_messages.id` is enforced in migration 0046 only (no
     * Drizzle `.references()` here — avoids circular import with
     * `sessions.ts`).
     */
    threadRootMessageId: integer("thread_root_message_id"),
    /** Content-free thread anchor retained after a moderation hard delete. */
    deletedThreadRootMessageId: integer("deleted_thread_root_message_id"),
    deletedThreadReplyCount: integer("deleted_thread_reply_count").notNull().default(0),
    deletedThreadLastReplyAt: timestamp("deleted_thread_last_reply_at", { withTimezone: true }),
    deletedThreadSummaryRevision: integer("deleted_thread_summary_revision").notNull().default(0),
    createdBy: uuid("created_by").references(() => actors.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    /**
     * D287 — soft archive timestamp. Non-NULL hides the room from member
     * lists and public discovery; data is retained for unarchive / audit.
     */
    archivedAt: timestamp("archived_at"),
    /**
     * D302 — per-room routing mode. `advanced` = Floor-Manager-as-default-
     * arbiter inference (call-buyers + addressivity gate + mention_only
     * admission); `standard` = today's conductor only (explicit + focus +
     * vocative + history-owner + narrow FM tiebreaker). Additive flag — DMs
     * never reach the conductor regardless. The DB-level CHECK constraint
     * `rooms_conductor_mode_check` is hand-maintained in the migration
     * (Drizzle `text({enum})` is TS-only and emits no SQL CHECK — same as
     * `kind`). Default `advanced`; existing rows backfill to `advanced`.
     */
    conductorMode: text("conductor_mode", { enum: ["advanced", "standard"] })
      .notNull()
      .default("advanced"),
  },
  (table) => [
    check("rooms_thread_anchor_shape", sql`(${table.kind} = 'subthread') = (${table.parentRoomId} IS NOT NULL AND (${table.threadRootMessageId} IS NOT NULL OR ${table.deletedThreadRootMessageId} IS NOT NULL)) AND (${table.deletedThreadRootMessageId} IS NULL OR (${table.kind} = 'subthread' AND (${table.threadRootMessageId} IS NULL OR ${table.threadRootMessageId} = ${table.deletedThreadRootMessageId})))`),
    index("idx_rooms_owner_type").on(table.ownerId, table.type),
    // M044 — backs the `human_actor_ids @> ARRAY[...]` containment
    // lookup in findReadableNamespacesForSubset. GIN on uuid[] is
    // the canonical Postgres shape for array-containment queries.
    index("idx_rooms_human_actor_ids_gin")
      .using("gin", table.humanActorIds),
    index("idx_rooms_parent")
      .on(table.parentRoomId)
      .where(sql`${table.parentRoomId} IS NOT NULL`),
    index("idx_rooms_kind").on(table.kind),
    // D476 — exact/normalized Room-name lookup only considers live,
    // conversational Rooms. The resolver joins canonical membership before
    // using this projection, so this index is discovery-free.
    index("idx_rooms_normalized_label_live")
      .using("btree", table.normalizedLabel.op("text_pattern_ops"), table.id)
      .where(sql`${table.archivedAt} IS NULL AND ${table.kind} NOT IN ('task', 'access', 'subthread')`),
    // D476 — bounded typo/token candidate lookup. `pg_trgm` is enabled by the
    // matching migration; it never supplies an automatic destination.
    index("idx_rooms_normalized_label_trgm_live")
      .using("gist", table.normalizedLabel.op("gist_trgm_ops"))
      .where(sql`${table.archivedAt} IS NULL AND ${table.kind} NOT IN ('task', 'access', 'subthread')`),
    uniqueIndex("uq_rooms_thread_root")
      .on(table.threadRootMessageId)
      .where(sql`${table.threadRootMessageId} IS NOT NULL`),
    /**
     * M237 — supports the lifecycle ledger's composite Room→Namespace FK.
     * The separate database trigger makes namespace_id immutable even before
     * the first protected revision exists.
     */
    unique("uq_rooms_id_namespace_id").on(table.id, table.namespaceId),
  ],
);

export type Room = typeof rooms.$inferSelect;
export type NewRoom = typeof rooms.$inferInsert;

/**
 * M042B — room_members join table.
 *
 * Members are `actors` rows, regardless of whether they represent a
 * human (`actors.kind='user'`) or an agent (`actors.kind='agent'`).
 * The uniform FK keeps every group/room/approval join shape
 * consistent; agent identity flows through the same trust machinery
 * as human identity.
 */
export const roomMembers = pgTable(
  "room_members",
  {
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    /**
     * Room-admin flag — `'admin' | 'member'`. **Distinct from the Role
     * entity** (owner / household / teammate / guest): this column is
     * a per-membership admin/non-admin bit used for Iteration 2+ room
     * moderation; the Role entity is the Capability-bundling permission
     * concept governed by Groups. Renamed from `role` → `room_role` in
     * M046 to unambiguate (REL-RMS-ROL, REL-ACT-RMS).
     */
    roomRole: text("room_role").notNull().default("member"),
    /**
     * D128 — per-(Room, Agent) reply policy. NULL for non-agent members.
     * Enforced by `room_members_agent_response_mode_check` in migration 0054.
     */
    agentResponseMode: text("agent_response_mode", {
      enum: ["active", "mention_only", "observe"],
    }),
    joinedAt: timestamp("joined_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.actorId] }),
    index("idx_room_members_actor").on(table.actorId),
  ],
);

export type RoomMember = typeof roomMembers.$inferSelect;
export type NewRoomMember = typeof roomMembers.$inferInsert;
