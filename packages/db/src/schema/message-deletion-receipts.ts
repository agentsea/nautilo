import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** Content-free facts committed with the canonical message hard delete. */
export const messageDeletionReceipts = pgTable(
  "message_deletion_receipts",
  {
    operationId: uuid("operation_id").primaryKey(),
    roomId: uuid("room_id").notNull(),
    messageId: integer("message_id").notNull(),
    actorUserId: uuid("actor_user_id").notNull(),
    actorId: uuid("actor_id"),
    source: text("source", { enum: ["room_message", "content_report", "moderation_ban"] }).notNull(),
    authority: text("authority", {
      enum: ["author", "room_owner", "room_steward", "manage_rooms", "report_action", "server_ban"],
    }).notNull(),
    reportId: uuid("report_id"),
    moderationOperationId: uuid("moderation_operation_id"),
    outcome: text("outcome", { enum: ["deleted"] }).notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("message_deletion_receipts_message").on(table.messageId),
    uniqueIndex("message_deletion_receipts_report").on(table.reportId),
    index("message_deletion_receipts_room_time").on(table.roomId, table.committedAt, table.operationId),
    index("message_deletion_receipts_actor_time").on(table.actorId, table.committedAt, table.operationId),
    check("message_deletion_receipts_message_positive", sql`${table.messageId} > 0`),
    check("message_deletion_receipts_source_valid", sql`${table.source} in ('room_message', 'content_report', 'moderation_ban')`),
    check("message_deletion_receipts_authority_valid", sql`${table.authority} in ('author', 'room_owner', 'room_steward', 'manage_rooms', 'report_action', 'server_ban')`),
    check("message_deletion_receipts_outcome_valid", sql`${table.outcome} = 'deleted'`),
    check("message_deletion_receipts_moderation_source", sql`(${table.source} = 'moderation_ban') = (${table.moderationOperationId} IS NOT NULL)`),
    check("message_deletion_receipts_moderation_authority", sql`(${table.source} = 'moderation_ban') = (${table.authority} = 'server_ban')`),
    check("message_deletion_receipts_report_source", sql`(${table.source} = 'content_report') = (${table.reportId} is not null)`),
    check("message_deletion_receipts_report_authority", sql`(${table.source} = 'content_report') = (${table.authority} = 'report_action')`),
  ],
);

export type MessageDeletionReceipt = typeof messageDeletionReceipts.$inferSelect;
