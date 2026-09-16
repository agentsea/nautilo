/** D378 — durable Video-project lineage for one D525 receipt. */
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { artifacts } from "./artifacts";
import { mediaGenerations } from "./media-generations";
import { namespaces } from "./trust";
import { users } from "./users";

export const videoGenerationLinks = pgTable(
  "video_generation_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Client-safe opaque take identity. It is not a provider or artifact id. */
    takeId: text("take_id").notNull(),
    receiptId: text("receipt_id").notNull().references(() => mediaGenerations.receiptId, { onDelete: "restrict" }),
    ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    roomId: uuid("room_id").notNull(),
    namespaceId: uuid("namespace_id").notNull().references(() => namespaces.id, { onDelete: "restrict" }),
    projectArtifactInternalId: uuid("project_artifact_internal_id").notNull().references(() => artifacts.id, { onDelete: "restrict" }),
    requestId: uuid("request_id").notNull(),
    shotId: text("shot_id").notNull(),
    shotLabel: text("shot_label").notNull(),
    briefDigest: text("brief_digest").notNull(),
    documentRevision: integer("document_revision").notNull(),
    /** Null until D525 has durably acknowledged paid admission. */
    admittedAt: timestamp("admitted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_video_generation_links_take_id").on(table.takeId),
    uniqueIndex("uq_video_generation_links_receipt_id").on(table.receiptId),
    uniqueIndex("uq_video_generation_links_project_request").on(table.ownerId, table.roomId, table.projectArtifactInternalId, table.requestId),
    index("idx_video_generation_links_project_created").on(table.ownerId, table.roomId, table.namespaceId, table.projectArtifactInternalId, table.createdAt),
    index("idx_video_generation_links_project_admitted").on(table.ownerId, table.roomId, table.namespaceId, table.projectArtifactInternalId, table.admittedAt),
    check("video_generation_links_take_id", sql`octet_length(${table.takeId}) between 21 and 133 and ${table.takeId} ~ '^take_[A-Za-z0-9_-]{16,128}$'`),
    check("video_generation_links_brief_digest", sql`${table.briefDigest} ~ '^sha256:[0-9a-f]{64}$'`),
    check("video_generation_links_document_revision", sql`${table.documentRevision} >= 0`),
  ],
);

export type VideoGenerationLink = typeof videoGenerationLinks.$inferSelect;
export type NewVideoGenerationLink = typeof videoGenerationLinks.$inferInsert;
