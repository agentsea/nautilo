/**
 * D261 P6b — channel-3 agent notification ring buffer.
 *
 * Stores bounded `(namespace, agent, artifact)` event queues for
 * `nwState.emit(topic, payload)` → `POST .../events`. Distinct from
 * `artifact_state` (channel 2 UI state) and file edits (channel 1).
 *
 * Rows are append-only until drained by the agent on its next turn.
 * Cap N=50 per scope with drop-oldest enforced in query helpers.
 */

import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { namespaces } from "./trust";

export const pendingArtifactEvents = pgTable(
  "pending_artifact_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    namespaceId: uuid("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /**
     * External artifact id (matches `artifacts.artifact_id` /
     * `artifact_state.artifact_id`), not the internal row uuid.
     */
    artifactId: text("artifact_id").notNull(),
    topic: text("topic").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_pending_artifact_events_scope_created").on(
      table.namespaceId,
      table.agentId,
      table.artifactId,
      table.createdAt,
    ),
  ],
);

export type PendingArtifactEventRow = typeof pendingArtifactEvents.$inferSelect;
export type NewPendingArtifactEventRow = typeof pendingArtifactEvents.$inferInsert;
