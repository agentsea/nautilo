/**
 * M322 — content-free terminal receipts for ordinary Memory/Artifact access.
 *
 * Attachments remain the sole access authority. A receipt records only the
 * historical result of one exact request; it never authorizes a replay. A
 * currently authorized caller must match the operation id and canonical
 * request digest before returning the stored result without mutating access.
 * Receipt identity follows the referenced object's lifetime and is not TTL
 * prunable, preventing an old grant from being replayed after a later revoke.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgPolicy,
  pgRole,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { artifacts } from "./artifacts";
import { memories } from "./memories";
import { actors } from "./trust";
import { users } from "./users";

const productRole = pgRole("nautilo").existing();

export const CONTENT_ACCESS_OPERATION_OUTCOMES = [
  "applied",
  "already_applied",
  "partial",
  "denied",
  "stale",
  "failed",
] as const;

export const contentAccessOperations = pgTable(
  "content_access_operations",
  {
    /** Stable caller-bound UUID; no server default may create a new replay identity. */
    operationId: uuid("operation_id").primaryKey(),
    /** SHA-256 of source/action/object-revision/sensitivity/policy bindings. */
    requestDigest: varchar("request_digest", { length: 64 }).notNull(),
    /** Nullable so the historical receipt survives requester deletion. */
    requesterUserId: uuid("requester_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    requesterActorId: uuid("requester_actor_id").references(() => actors.id, {
      onDelete: "set null",
    }),
    /** Exactly one content identity is present; its hard deletion retires the receipt. */
    memoryId: uuid("memory_id").references(() => memories.id, {
      onDelete: "cascade",
    }),
    artifactId: uuid("artifact_id").references(() => artifacts.id, {
      onDelete: "cascade",
    }),
    outcome: text("outcome", {
      enum: CONTENT_ACCESS_OPERATION_OUTCOMES,
    }).notNull(),
    /** Whether this operation changed attachment state at its original commit. */
    changed: boolean("changed").notNull(),
    attachedCount: integer("attached_count").notNull(),
    detachedCount: integer("detached_count").notNull(),
    skippedCount: integer("skipped_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_content_access_operations_memory").on(table.memoryId),
    index("idx_content_access_operations_artifact").on(table.artifactId),
    check(
      "content_access_operations_request_digest_canonical",
      sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "content_access_operations_one_object",
      sql`num_nonnulls(${table.memoryId}, ${table.artifactId}) = 1`,
    ),
    check(
      "content_access_operations_outcome_check",
      sql`${table.outcome} in ('applied', 'already_applied', 'partial', 'denied', 'stale', 'failed')`,
    ),
    check(
      "content_access_operations_counts_nonnegative",
      sql`${table.attachedCount} >= 0 and ${table.detachedCount} >= 0 and ${table.skippedCount} >= 0`,
    ),
    check(
      "content_access_operations_changed_coherent",
      sql`${table.changed} = (${table.attachedCount} > 0 or ${table.detachedCount} > 0)`,
    ),
    check(
      "content_access_operations_outcome_coherent",
      sql`(
        (${table.outcome} = 'applied' and ${table.changed})
        or ${table.outcome} = 'partial'
        or (
          ${table.outcome} in ('already_applied', 'denied', 'stale', 'failed')
          and not ${table.changed}
        )
      )`,
    ),
    pgPolicy("content_access_operations_product_read", {
      for: "select",
      to: productRole,
      using: sql`true`,
    }),
    pgPolicy("content_access_operations_product_append", {
      for: "insert",
      to: productRole,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

export type ContentAccessOperation = typeof contentAccessOperations.$inferSelect;
export type NewContentAccessOperation = typeof contentAccessOperations.$inferInsert;
