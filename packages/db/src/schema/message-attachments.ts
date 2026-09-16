/**
 * D271 — composer attachment upload storage.
 *
 * Separate from `artifacts`: chat uploads are message content, not Workspace
 * artifacts, and must never appear in the Workspace tab. Namespace-gated
 * (M127 namespace-only); the uploader binding lives only on the transient
 * pending capability.
 *
 * Four-state lifecycle (bounded — the table never accumulates "everything
 * ever attached"):
 *   - pending:  uploaded, not yet sent. Has `expires_at`; blob present. GC'd
 *               on expiry; deleted on cancel; resolved on send.
 *   - consumed: text/image materialized INTO the message turn at send; blob
 *               released. (`resolved_at` set.)
 *   - retained: audio (and future deferred-read types). Blob kept so the
 *               agent can read it by `attachmentId` ON EXPLICIT request
 *               (transcribe_audio). Audio is metadata-only at ingest BY
 *               DESIGN — no auto-transcribe (see ISSUE-D271). (`resolved_at` set.)
 *   - deleted:  cancelled / expired / GC'd. (`deleted_at` set.)
 *
 * D391 — durable message attachments: `retained` now also covers images
 * (blob kept, not released), and `turn_id` links a retained attachment to
 * the human turn (by M134 `fingerprint`) so the room history read can join
 * + render attachments from reload and for other room members. No
 * per-bot `message_id` FK: the room read reconciles attachments at the
 * M134 read-side dedup (`session-store.ts`), joining on `turn_id`.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { actors, namespaces } from "./trust";

export const MESSAGE_ATTACHMENT_STATUSES = [
  "pending",
  "consumed",
  "retained",
  "deleted",
] as const;

export type MessageAttachmentStatus = (typeof MESSAGE_ATTACHMENT_STATUSES)[number];

export const messageAttachments = pgTable(
  "message_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    namespaceId: uuid("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "restrict" }),
    uploaderActorId: uuid("uploader_actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull().default("application/octet-stream"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    storageUri: text("storage_uri").notNull(),
    claimedMime: text("claimed_mime"),
    /**
     * D391 — durable message attachments. The M134 dedup key (the
     * `session_messages.fingerprint` of the human turn this attachment
     * was sent with). Nullable: pre-D391 rows + pending/consumed rows
     * have no link. The room history read joins attachments → the
     * deduped human message by this column, so an attachment shows
     * once per turn regardless of how many per-bot copies of the
     * message exist. Stores the fingerprint (not the raw `humanTurnId`
     * uuid) because `session_messages` exposes `fingerprint`, not the
     * raw turn id — that is the joinable key.
     */
    turnId: text("turn_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Pending rows only; GC deletes expired pending rows + their blobs. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Set when a pending row resolves to consumed or retained at send time. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Set when cancelled / expired / GC'd. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "message_attachments_status_check",
      sql`${table.status} IN ('pending', 'consumed', 'retained', 'deleted')`,
    ),
    check(
      "message_attachments_lifecycle_check",
      sql`(
      (${table.status} = 'pending' AND ${table.expiresAt} IS NOT NULL AND ${table.resolvedAt} IS NULL AND ${table.deletedAt} IS NULL)
      OR (${table.status} = 'consumed' AND ${table.resolvedAt} IS NOT NULL AND ${table.deletedAt} IS NULL)
      OR (${table.status} = 'retained' AND ${table.resolvedAt} IS NOT NULL AND ${table.deletedAt} IS NULL)
      OR (${table.status} = 'deleted' AND ${table.deletedAt} IS NOT NULL)
    )`,
    ),
    check("message_attachments_size_nonnegative", sql`${table.sizeBytes} >= 0`),
    index("idx_message_attachments_pending_owner_expiry")
      .on(table.uploaderActorId, table.expiresAt)
      .where(sql`${table.status} = 'pending'`),
    index("idx_message_attachments_namespace_status").on(table.namespaceId, table.status),
    index("idx_message_attachments_turn").on(table.turnId).where(sql`${table.turnId} IS NOT NULL`),
    index("idx_message_attachments_expired_pending")
      .on(table.expiresAt)
      .where(sql`${table.status} = 'pending'`),
  ],
);

export type MessageAttachment = typeof messageAttachments.$inferSelect;
export type NewMessageAttachment = typeof messageAttachments.$inferInsert;
