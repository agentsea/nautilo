/**
 * M088B — junction for artifacts ↔ namespaces. Mirror of
 * `memory_namespaces` shape (M076).
 *
 * `onDelete: 'cascade'` on the artifact side: dropping an artifact row
 * (hard delete) drops every junction row that pointed at it.
 *
 * `onDelete: 'restrict'` on the namespace side mirrors memory's policy:
 * a namespace can't be deleted while artifacts still reference it. The
 * future namespace-cleanup helper memory uses (drain attached content
 * first) is the path forward when namespace deletion needs to happen.
 *
 * Multi-attachment is the whole point. `share_artifact` inserts an
 * additional row here instead of mutating `artifacts.namespace_id` (the
 * column that no longer exists). Reads `INNER JOIN` through this table
 * and filter by `readableNamespaceIds`.
 */

import {
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { artifacts } from "./artifacts";
import { namespaces } from "./trust";

export const artifactNamespaces = pgTable(
  "artifact_namespaces",
  {
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    namespaceId: uuid("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "restrict" }),
    attachedAt: timestamp("attached_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.namespaceId] }),
    index("idx_artifact_namespaces_namespace").on(table.namespaceId),
    index("idx_artifact_namespaces_artifact").on(table.artifactId),
  ],
);

export type ArtifactNamespace = typeof artifactNamespaces.$inferSelect;
export type NewArtifactNamespace = typeof artifactNamespaces.$inferInsert;
