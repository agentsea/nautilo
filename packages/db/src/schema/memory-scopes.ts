import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { memories } from "./memories";
import { agentScopes } from "./agent-scopes";

/**
 * M080 — junction for agent_scopes ↔ memories. Mirror of
 * `memory_namespaces` shape (M076), minus the namespace FK.
 *
 * `onDelete: 'cascade'` on both sides:
 *   - memory dropped → its scope rows go too
 *   - scope dropped → its memory rows go too (close_scope path)
 *
 * M084 — `origin`: seed rows come from `add_memory_to_scope` (read-only to
 * subagents); `scope` rows are authored inside a scope-mode subagent run.
 */
export const memoryScopes = pgTable(
  "memory_scopes",
  {
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
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
    primaryKey({ columns: [table.memoryId, table.scopeId] }),
    index("idx_memory_scopes_scope").on(table.scopeId),
    index("idx_memory_scopes_memory").on(table.memoryId),
    check(
      "memory_scopes_origin_check",
      sql`${table.origin} in ('seed', 'scope')`,
    ),
  ],
);

export type MemoryScope = typeof memoryScopes.$inferSelect;
export type NewMemoryScope = typeof memoryScopes.$inferInsert;
