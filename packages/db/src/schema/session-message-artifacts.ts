/**
 * D424 — ArtifactOpenCard receive contract: durable relation between a
 * persisted user message and the workspace artifacts it opened.
 *
 * The row stores ONLY the relation + send-time ordering. It is keyed by the
 * INTERNAL `artifacts.id` (never the external `artifact_id`), and it does NOT
 * snapshot the external id, logical path, storage URI, namespace id,
 * capability, or any private locator. Safe current metadata (basename, mime,
 * size, canonical room id) is hydrated at read/event time by joining the
 * artifact row + the canonical room namespace — so a renamed, re-shared, or
 * detached artifact always projects its CURRENT state, and a detached/deleted
 * artifact is simply omitted.
 *
 * Authored ONLY for user-sent workspace-artifact focus refs (legacy
 * `artifactRefs` + `focusedResources` kind `workspace-artifact`) that are
 * attached to the canonical room namespace of the message's room. Local-file
 * and message-attachment focus refs never write rows here, and assistant cards
 * are never inferred from prose or tool text.
 *
 * `ON DELETE CASCADE` on both FKs: removing the message drops its card links,
 * and hard-deleting an artifact drops the dangling links (a soft-deleted
 * artifact is filtered at hydrate via `artifacts.deleted_at IS NULL`).
 */
import { integer, pgTable, primaryKey, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sessionMessages } from "./sessions";
import { artifacts } from "./artifacts";

export const sessionMessageArtifacts = pgTable(
  "session_message_artifacts",
  {
    messageId: integer("message_id")
      .notNull()
      .references(() => sessionMessages.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    /**
     * Zero-based ordering preserved from the user's focus-ref send order
     * (legacy `artifactRefs` first, then `focusedResources` workspace-artifact
     * entries, deduped by external id). The unique index below keeps one
     * artifact per position per message.
     */
    position: integer("position").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.artifactId] }),
    uniqueIndex("uq_session_message_artifacts_position").on(
      table.messageId,
      table.position,
    ),
  ],
);

export type SessionMessageArtifact = typeof sessionMessageArtifacts.$inferSelect;
export type NewSessionMessageArtifact = typeof sessionMessageArtifacts.$inferInsert;
