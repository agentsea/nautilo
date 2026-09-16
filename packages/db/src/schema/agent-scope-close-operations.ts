import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { users } from "./users";

export const AGENT_SCOPE_CLOSE_MAX_ITEMS = 256;
export const AGENT_SCOPE_CLOSE_DIGEST_BYTES = 32;
export const AGENT_SCOPE_CLOSE_ID_BYTES = 128;

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

/**
 * Wave 15 — content-free, append-only identity for one protected scope close.
 * There is deliberately no FK to agent_scopes: exact terminal replay survives
 * deletion of the successfully closed scope.
 */
export const agentScopeCloseOperations = pgTable(
  "agent_scope_close_operations",
  {
    sequence: serial("sequence").primaryKey(),
    operationId: text("operation_id").notNull(),
    scopeId: uuid("scope_id").notNull(),
    parentAgentId: uuid("parent_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    speakerUserId: uuid("speaker_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceScopeRevision: integer("source_scope_revision").notNull(),
    capturedItemCount: integer("captured_item_count").notNull(),
    inventoryDigest: bytea("inventory_digest").notNull(),
    state: text("state", {
      enum: ["active", "complete", "quarantined"],
    }).notNull().default("active"),
    failureCode: text("failure_code", {
      enum: [
        "scope_state_conflict",
        "inventory_conflict",
        "uncaptured_item",
        "item_quarantined",
      ],
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull().defaultNow(),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
  },
  (table) => [
    unique("uq_agent_scope_close_operations_id").on(table.operationId),
    unique("uq_agent_scope_close_operations_scope").on(table.scopeId),
    index("idx_agent_scope_close_operations_owner").on(
      table.parentAgentId,
      table.speakerUserId,
      table.sequence,
    ),
    check(
      "agent_scope_close_operations_id_portable",
      sql`octet_length(${table.operationId}) between 1 and ${sql.raw(String(AGENT_SCOPE_CLOSE_ID_BYTES))}
        and ${table.operationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'`,
    ),
    check(
      "agent_scope_close_operations_source_revision_nonnegative",
      sql`${table.sourceScopeRevision} >= 0`,
    ),
    check(
      "agent_scope_close_operations_item_count_bounded",
      sql`${table.capturedItemCount} between 0 and ${sql.raw(String(AGENT_SCOPE_CLOSE_MAX_ITEMS))}`,
    ),
    check(
      "agent_scope_close_operations_inventory_digest_size",
      sql`octet_length(${table.inventoryDigest}) = ${sql.raw(String(AGENT_SCOPE_CLOSE_DIGEST_BYTES))}`,
    ),
    check(
      "agent_scope_close_operations_state_check",
      sql`${table.state} in ('active', 'complete', 'quarantined')`,
    ),
    check(
      "agent_scope_close_operations_failure_code_check",
      sql`${table.failureCode} is null or ${table.failureCode} in (
        'scope_state_conflict',
        'inventory_conflict',
        'uncaptured_item',
        'item_quarantined'
      )`,
    ),
    check(
      "agent_scope_close_operations_terminal_coherent",
      sql`(
        ${table.state} = 'active'
        and ${table.failureCode} is null
        and ${table.terminalAt} is null
      ) or (
        ${table.state} = 'complete'
        and ${table.failureCode} is null
        and ${table.terminalAt} is not null
      ) or (
        ${table.state} = 'quarantined'
        and ${table.failureCode} is not null
        and ${table.terminalAt} is not null
      )`,
    ),
  ],
);

export type AgentScopeCloseOperation =
  typeof agentScopeCloseOperations.$inferSelect;
export type NewAgentScopeCloseOperation =
  typeof agentScopeCloseOperations.$inferInsert;
