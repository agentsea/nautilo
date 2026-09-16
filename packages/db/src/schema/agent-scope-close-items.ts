import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import {
  AGENT_SCOPE_CLOSE_DIGEST_BYTES,
  AGENT_SCOPE_CLOSE_ID_BYTES,
  AGENT_SCOPE_CLOSE_MAX_ITEMS,
  agentScopeCloseOperations,
} from "./agent-scope-close-operations";

export const AGENT_SCOPE_CLOSE_ITEM_MAX_ATTEMPTS = 8;

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

/** One content-free captured Memory transition in a protected scope close. */
export const agentScopeCloseItems = pgTable(
  "agent_scope_close_items",
  {
    operationId: text("operation_id")
      .notNull()
      .references(() => agentScopeCloseOperations.operationId, {
        onDelete: "cascade",
      }),
    ordinal: smallint("ordinal").notNull(),
    memoryId: uuid("memory_id").notNull(),
    origin: text("origin", { enum: ["seed", "scope"] }).notNull(),
    cryptoObjectId: text("crypto_object_id").notNull(),
    expectedContentRevision: integer("expected_content_revision").notNull(),
    expectedAccessRevision: integer("expected_access_revision").notNull(),
    expectedRequiredNamespaceFingerprint: bytea(
      "expected_required_namespace_fingerprint",
    ).notNull(),
    sourceOriginNamespaceId: uuid("source_origin_namespace_id"),
    action: text("action", {
      enum: ["detach_seed", "promote_origin"],
    }).notNull(),
    targetNamespaceId: uuid("target_namespace_id"),
    state: text("state", {
      enum: ["pending", "claimed", "complete", "stale", "quarantined"],
    }).notNull().default("pending"),
    attemptCount: smallint("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull().defaultNow(),
    claimToken: uuid("claim_token"),
    claimOwner: text("claim_owner"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    failureCode: text("failure_code", {
      enum: [
        "scope_state_conflict",
        "memory_state_conflict",
        "authorization_unavailable",
        "target_encryption_not_ready",
        "storage_transient",
        "retry_exhausted",
      ],
    }),
    productReceiptRef: text("product_receipt_ref"),
    cryptoReceiptRef: text("crypto_receipt_ref"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull().defaultNow(),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.operationId, table.ordinal] }),
    unique("uq_agent_scope_close_items_memory").on(
      table.operationId,
      table.memoryId,
    ),
    index("idx_agent_scope_close_items_due")
      .on(table.state, table.nextAttemptAt, table.operationId, table.ordinal)
      .where(sql`${table.state} in ('pending', 'claimed')`),
    check(
      "agent_scope_close_items_ordinal_bounded",
      sql`${table.ordinal} between 0 and ${sql.raw(String(AGENT_SCOPE_CLOSE_MAX_ITEMS - 1))}`,
    ),
    check(
      "agent_scope_close_items_origin_check",
      sql`${table.origin} in ('seed', 'scope')`,
    ),
    check(
      "agent_scope_close_items_crypto_object_portable",
      sql`octet_length(${table.cryptoObjectId}) between 1 and ${sql.raw(String(AGENT_SCOPE_CLOSE_ID_BYTES))}
        and ${table.cryptoObjectId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'`,
    ),
    check(
      "agent_scope_close_items_revisions_nonnegative",
      sql`${table.expectedContentRevision} > 0
        and ${table.expectedAccessRevision} >= 0`,
    ),
    check(
      "agent_scope_close_items_fingerprint_size",
      sql`octet_length(${table.expectedRequiredNamespaceFingerprint}) = ${sql.raw(String(AGENT_SCOPE_CLOSE_DIGEST_BYTES))}`,
    ),
    check(
      "agent_scope_close_items_action_coherent",
      sql`(
        ${table.origin} = 'seed'
        and ${table.action} = 'detach_seed'
        and ${table.sourceOriginNamespaceId} is null
        and ${table.targetNamespaceId} is null
      ) or (
        ${table.origin} = 'scope'
        and ${table.action} = 'promote_origin'
        and ${table.sourceOriginNamespaceId} is not null
        and ${table.targetNamespaceId} is not null
      )`,
    ),
    check(
      "agent_scope_close_items_attempt_bound",
      sql`${table.attemptCount} between 0 and ${sql.raw(String(AGENT_SCOPE_CLOSE_ITEM_MAX_ATTEMPTS))}`,
    ),
    check(
      "agent_scope_close_items_failure_code_check",
      sql`${table.failureCode} is null or ${table.failureCode} in (
        'scope_state_conflict',
        'memory_state_conflict',
        'authorization_unavailable',
        'target_encryption_not_ready',
        'storage_transient',
        'retry_exhausted'
      )`,
    ),
    check(
      "agent_scope_close_items_claim_owner_portable",
      sql`${table.claimOwner} is null or (
        octet_length(${table.claimOwner}) between 1 and ${sql.raw(String(AGENT_SCOPE_CLOSE_ID_BYTES))}
        and ${table.claimOwner} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
      )`,
    ),
    check(
      "agent_scope_close_items_receipts_portable",
      sql`(${table.productReceiptRef} is null or (
          octet_length(${table.productReceiptRef}) between 1 and ${sql.raw(String(AGENT_SCOPE_CLOSE_ID_BYTES))}
          and ${table.productReceiptRef} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        )) and (${table.cryptoReceiptRef} is null or (
          octet_length(${table.cryptoReceiptRef}) between 1 and ${sql.raw(String(AGENT_SCOPE_CLOSE_ID_BYTES))}
          and ${table.cryptoReceiptRef} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        ))`,
    ),
    check(
      "agent_scope_close_items_lifecycle_coherent",
      sql`(
        ${table.state} = 'pending'
        and ${table.claimToken} is null
        and ${table.claimOwner} is null
        and ${table.claimExpiresAt} is null
        and ${table.failureCode} is null
        and ${table.productReceiptRef} is null
        and ${table.cryptoReceiptRef} is null
        and ${table.terminalAt} is null
      ) or (
        ${table.state} = 'claimed'
        and ${table.claimToken} is not null
        and ${table.claimOwner} is not null
        and ${table.claimExpiresAt} is not null
        and ${table.failureCode} is null
        and ${table.productReceiptRef} is null
        and ${table.cryptoReceiptRef} is null
        and ${table.terminalAt} is null
      ) or (
        ${table.state} = 'complete'
        and ${table.claimToken} is null
        and ${table.claimOwner} is null
        and ${table.claimExpiresAt} is null
        and ${table.failureCode} is null
        and ${table.productReceiptRef} is not null
        and ${table.cryptoReceiptRef} is not null
        and ${table.terminalAt} is not null
      ) or (
        ${table.state} in ('stale', 'quarantined')
        and ${table.claimToken} is null
        and ${table.claimOwner} is null
        and ${table.claimExpiresAt} is null
        and ${table.failureCode} is not null
        and ${table.productReceiptRef} is null
        and ${table.cryptoReceiptRef} is null
        and ${table.terminalAt} is not null
      )`,
    ),
  ],
);

export type AgentScopeCloseItem = typeof agentScopeCloseItems.$inferSelect;
export type NewAgentScopeCloseItem = typeof agentScopeCloseItems.$inferInsert;
