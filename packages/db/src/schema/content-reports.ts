import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { rooms } from "./rooms";
import { users } from "./users";

export type ContentReportAttachmentPreview = Readonly<{
  filename: string;
  mimeType: string;
  sizeBytes: number;
}>;

export const contentReportTargetTypeEnum = pgEnum(
  "content_report_target_type",
  ["message", "person"],
);

export const contentReportReasonEnum = pgEnum("content_report_reason", [
  "abuse_hate_harassment",
  "sexual_exploitative",
  "violence_threats",
  "spam_scam",
  "other",
]);

export const contentReportStatusEnum = pgEnum("content_report_status", [
  "open",
  "closed",
]);

/**
 * M297 — the deliberately small, Server-local moderation inbox.
 *
 * The reporter supplies `id` as the idempotency key. Target identifiers are
 * intentionally not foreign keys: closing a report must remain possible after
 * the source message or Human disappears. The bounded preview is authored by
 * the Server when the report is created and never contains attachment bytes.
 */
export const contentReports = pgTable(
  "content_reports",
  {
    id: uuid("id").primaryKey(),
    reporterUserId: uuid("reporter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    targetType: contentReportTargetTypeEnum("target_type").notNull(),
    targetMessageId: integer("target_message_id"),
    targetUserId: uuid("target_user_id"),
    reason: contentReportReasonEnum("reason").notNull(),
    comment: varchar("comment", { length: 500 }),
    previewText: varchar("preview_text", { length: 4000 }),
    previewDisplayName: varchar("preview_display_name", { length: 255 }),
    previewHandle: text("preview_handle"),
    previewAttachments: jsonb("preview_attachments")
      .$type<ContentReportAttachmentPreview[]>()
      .notNull()
      .default([]),
    status: contentReportStatusEnum("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Kept as a stable identifier even if the administrator later leaves.
    closedByUserId: uuid("closed_by_user_id"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_content_reports_status_created").on(
      table.status,
      table.createdAt,
      table.id,
    ),
    index("idx_content_reports_reporter_created").on(
      table.reporterUserId,
      table.createdAt,
    ),
  ],
);

export type ContentReport = typeof contentReports.$inferSelect;
export type NewContentReport = typeof contentReports.$inferInsert;
