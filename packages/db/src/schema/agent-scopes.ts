import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents";
import { users } from "./users";

/**
 * M080 — agent-private memory bags.
 *
 * Owned by `(parent_agent_id, speaker_user_id)`. Names are unique
 * within that pair. Lifecycle is purely manual: created by
 * `create_scope`, closed by `close_scope`. No TTL.
 *
 * NOT a Namespace; the Namespace ↔ Room 1:1 invariant is intact.
 * Membership lives in the parallel `memory_scopes` junction.
 */
export const agentScopes = pgTable(
  "agent_scopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentAgentId: uuid("parent_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    speakerUserId: uuid("speaker_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    purpose: text("purpose"),
    /** Wave 15 — protected close freezes all new protected mutations. */
    lifecycleState: text("lifecycle_state", {
      enum: ["open", "closing"],
    }).notNull().default("open"),
    revision: integer("revision").notNull().default(0),
    /** Durable portable operation identity while the protected close is live. */
    closeOperationId: text("close_operation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uniq_agent_scopes_name").on(
      table.parentAgentId,
      table.speakerUserId,
      table.name,
    ),
    index("idx_agent_scopes_owner").on(
      table.parentAgentId,
      table.speakerUserId,
    ),
    check(
      "agent_scopes_lifecycle_state_check",
      sql`${table.lifecycleState} in ('open', 'closing')`,
    ),
    check("agent_scopes_revision_nonnegative", sql`${table.revision} >= 0`),
    check(
      "agent_scopes_close_operation_portable",
      sql`${table.closeOperationId} is null or (
        octet_length(${table.closeOperationId}) between 1 and 128
        and ${table.closeOperationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
      )`,
    ),
    check(
      "agent_scopes_close_lifecycle_coherent",
      sql`(${table.lifecycleState} = 'open' and ${table.closeOperationId} is null)
        or (${table.lifecycleState} = 'closing' and ${table.closeOperationId} is not null)`,
    ),
  ],
);

export type AgentScope = typeof agentScopes.$inferSelect;
export type NewAgentScope = typeof agentScopes.$inferInsert;
