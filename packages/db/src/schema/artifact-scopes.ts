/**
 * M088B — junction for agent_scopes ↔ artifacts. Mirror of
 * `memory_scopes` shape (M080).
 *
 * `onDelete: 'cascade'` on both sides:
 *   - artifact dropped → its scope rows go too
 *   - scope dropped → its artifact rows go too (close_scope path)
 *
 * `origin`: seed rows come from `add_artifact_to_scope` (read-only to
 * subagents); `scope` rows are authored inside a scope-mode subagent
 * run. Mirrors M080 / M084 memory semantics.
 *
 * Schema lands in M088B even though scope BEHAVIOR is deferred to
 * M088 Phase 4 — same rationale M080 used for memory.
 */

import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { artifacts } from "./artifacts";
import { agentScopes } from "./agent-scopes";

export const artifactScopes = pgTable(
  "artifact_scopes",
  {
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => agentScopes.id, { onDelete: "cascade" }),
    /** `"seed"` | `"scope"` — text for a simple additive migration */
    origin: text("origin").notNull().default("seed"),
    attachedAt: timestamp("attached_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.scopeId] }),
    index("idx_artifact_scopes_scope").on(table.scopeId),
    index("idx_artifact_scopes_artifact").on(table.artifactId),
  ],
);

export type ArtifactScope = typeof artifactScopes.$inferSelect;
export type NewArtifactScope = typeof artifactScopes.$inferInsert;
