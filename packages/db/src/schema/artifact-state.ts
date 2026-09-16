/**
 * D121-P3 — interactive-artifact state, namespace-scoped.
 *
 * Stores per-`(namespace, agent, artifact, key)` JSON state for HTML
 * artifacts that opt into the host postMessage bridge. The host
 * exposes two RPC methods to the artifact runtime:
 *
 *   getArtifactState(key) → value
 *   setArtifactState(key, value)
 *
 * Reads apply the M082 subset rule via
 * `findReadableNamespacesForSubset(humanActorIds)` — a Human in Room
 * R can read state from any Namespace N' where humans(R') ⊇ humans(R).
 * Writes target the current-Room namespace per the same
 * `MemoryAccessEnvelope` discipline Memory writes use.
 *
 * Shape mirrors D121 §Design Decision D-3 verbatim. PK is the full
 * composite so the same artifact + key in different namespaces is
 * never confused; this is also the upsert key for `setArtifactState`.
 *
 * Cross-Namespace state sharing (the equivalent of `share_memory` for
 * artifact state) is explicitly out of scope for v1 — state stays in
 * the namespace it was authored in. The shape supports that future
 * migration without column churn.
 */

import {
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { namespaces } from "./trust";

export const artifactState = pgTable(
  "artifact_state",
  {
    namespaceId: uuid("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /**
     * The artifact's stable external id (matches `artifacts.artifact_id`,
     * NOT the internal `artifacts.id` row uuid). Kept as `text` per the
     * D121 D-3 spec so the agent-side key shape matches what the iframe
     * receives over the postMessage bridge without UUID parsing.
     */
    artifactId: text("artifact_id").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.namespaceId, table.agentId, table.artifactId, table.key],
    }),
  ],
);

export type ArtifactStateRow = typeof artifactState.$inferSelect;
export type NewArtifactStateRow = typeof artifactState.$inferInsert;
