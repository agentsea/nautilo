/**
 * D448 Phase 8.2 — durable Workspace document-mutation receipts.
 *
 * This is deliberately separate from `pending_artifact_events`: that table
 * is a bounded, best-effort agent notification queue. These tables hold the
 * durable commit receipt and transactional event outbox for a mutation.
 */

import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { artifacts } from "./artifacts";
import { agents } from "./agents";
import { rooms } from "./rooms";
import { users } from "./users";

export const workspaceDocumentMutationOutboxStateValues = [
  "pending",
  "claimed",
  "dispatched",
] as const;

export const workspaceDocumentMutations = pgTable(
  "workspace_document_mutations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stable request-operation identity. Retry uses this plus requestDigest. */
    operationId: text("operation_id").notNull(),
    /** SHA-256 of the canonical request/plan; checked before idempotent reuse. */
    requestDigest: text("request_digest").notNull(),
    revisionGroupId: text("revision_group_id").notNull(),
    /** Trusted request context for recovery/audit, never browser supplied. */
    /** Shared mutation receipt remains after the originating account is removed. */
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    roomId: uuid("room_id").references(() => rooms.id, { onDelete: "set null" }),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    lane: text("lane").notNull(),
    clientMutationId: text("client_mutation_id"),
    requestId: text("request_id"),
    /** Agent turn correlation; human/editor imports may legitimately omit it. */
    turnId: text("turn_id"),
    /** Bounded SHA-256 of exact editor request semantics; never raw content. */
    editorRequestFingerprint: text("editor_request_fingerprint"),
    /** Pinning one exposed revision pins the complete committed mutation. */
    pinned: boolean("pinned").notNull().default(false),
    accessedAt: timestamp("accessed_at", { withTimezone: true }),
    /** Exact coordinator batch key; every header is already committed. */
    outboxBatchIdempotencyKey: text("outbox_batch_idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_workspace_document_mutations_operation").on(table.operationId),
    uniqueIndex("uq_workspace_document_mutations_outbox_batch_idempotency").on(
      table.outboxBatchIdempotencyKey,
    ),
    index("idx_workspace_document_mutations_request_digest").on(table.requestDigest),
    index("idx_workspace_document_mutations_revision_group").on(table.revisionGroupId),
    index("idx_workspace_document_mutations_agent_history").on(
      table.agentId,
      table.createdAt.desc(),
    ),
    index("idx_workspace_document_mutations_turn_history").on(
      table.agentId,
      table.turnId,
      table.createdAt.desc(),
    ),
    unique("uq_workspace_document_mutations_outbox_binding").on(
      table.id,
      table.outboxBatchIdempotencyKey,
    ),
    check(
      "workspace_document_mutations_actor_kind_check",
      sql`${table.actorKind} in ('human', 'agent')`,
    ),
    check(
      "workspace_document_mutations_lane_check",
      sql`${table.lane} in ('editor_save', 'apply_patch', 'file_tool', 'officecli', 'artifact_lifecycle', 'desktop_files_ui')`,
    ),
    check(
      "workspace_document_mutations_operation_id_check",
      sql`length(trim(${table.operationId})) > 0`,
    ),
    check(
      "workspace_document_mutations_revision_group_id_check",
      sql`length(trim(${table.revisionGroupId})) > 0`,
    ),
    check(
      "workspace_document_mutations_actor_id_check",
      sql`length(trim(${table.actorId})) > 0`,
    ),
    check(
      "workspace_document_mutations_request_digest_check",
      sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "workspace_document_mutations_editor_request_fingerprint_check",
      sql`${table.editorRequestFingerprint} is null or ${table.editorRequestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "workspace_document_mutations_turn_id_check",
      sql`${table.turnId} is null or length(trim(${table.turnId})) > 0`,
    ),
    check(
      "workspace_document_mutations_outbox_binding_check",
      sql`length(trim(${table.outboxBatchIdempotencyKey})) > 0`,
    ),
  ],
);

export const workspaceDocumentMutationEntries = pgTable(
  "workspace_document_mutation_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mutationId: uuid("mutation_id")
      .notNull()
      .references(() => workspaceDocumentMutations.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    mutationKind: text("mutation_kind").notNull(),
    artifactInternalId: uuid("artifact_internal_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "restrict" }),
    beforeLogicalPath: text("before_logical_path"),
    afterLogicalPath: text("after_logical_path"),
    beforeRevision: integer("before_revision"),
    afterRevision: integer("after_revision"),
    beforeSha256: text("before_sha256"),
    afterSha256: text("after_sha256"),
    beforeSize: bigint("before_size", { mode: "number" }),
    afterSize: bigint("after_size", { mode: "number" }),
    beforeStorageUri: text("before_storage_uri"),
    afterStorageUri: text("after_storage_uri"),
    /** Authoritative Workspace row metadata for replay/undo reconstruction. */
    beforeMimeType: text("before_mime_type"),
    afterMimeType: text("after_mime_type"),
    destinationBeforeArtifactInternalId: uuid("destination_before_artifact_internal_id")
      .references(() => artifacts.id, { onDelete: "restrict" }),
    destinationBeforeLogicalPath: text("destination_before_logical_path"),
    destinationBeforeRevision: integer("destination_before_revision"),
    destinationBeforeSha256: text("destination_before_sha256"),
    destinationBeforeSize: bigint("destination_before_size", { mode: "number" }),
    destinationBeforeStorageUri: text("destination_before_storage_uri"),
    /**
     * Stable product operation label used by history summaries and restore
     * provenance. It is separate from the structural receipt kind.
     */
    historyOperation: text("history_operation").notNull().default("editor_save"),
    /**
     * Every commit remains canonical truth. This flag only controls whether
     * the entry participates in user-visible undo/history (for example sparse
     * human checkpoints versus ordinary autosaves).
     */
    historyEligible: boolean("history_eligible").notNull().default(false),
    /** A restore/redo entry points to the exact prior canonical history row. */
    restoreFromEntryId: uuid("restore_from_entry_id"),
    checkpoint: boolean("checkpoint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_workspace_document_mutation_entries_sequence").on(
      table.mutationId,
      table.sequence,
    ),
    index("idx_workspace_document_mutation_entries_artifact").on(table.artifactInternalId),
    index("idx_workspace_document_mutation_entries_history_artifact").on(
      table.artifactInternalId,
      table.historyEligible,
      table.createdAt.desc(),
    ),
    index("idx_workspace_document_mutation_entries_redo").on(
      table.artifactInternalId,
      table.restoreFromEntryId,
      table.createdAt.desc(),
    ),
    foreignKey({
      name: "workspace_document_mutation_entries_restore_from_entry_fk",
      columns: [table.restoreFromEntryId],
      foreignColumns: [table.id],
    }).onDelete("set null"),
    check(
      "workspace_document_mutation_entries_sequence_check",
      sql`${table.sequence} >= 0`,
    ),
    check(
      "workspace_document_mutation_entries_kind_check",
      sql`${table.mutationKind} in ('create', 'update', 'move', 'delete')`,
    ),
    check(
      "workspace_document_mutation_entries_history_operation_check",
      sql`length(trim(${table.historyOperation})) > 0`,
    ),
    check(
      "workspace_document_mutation_entries_before_sha_check",
      sql`${table.beforeSha256} is null or ${table.beforeSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "workspace_document_mutation_entries_after_sha_check",
      sql`${table.afterSha256} is null or ${table.afterSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "workspace_document_mutation_entries_destination_sha_check",
      sql`${table.destinationBeforeSha256} is null or ${table.destinationBeforeSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "workspace_document_mutation_entries_storage_uri_check",
      sql`(
        (${table.beforeStorageUri} is null or length(trim(${table.beforeStorageUri})) > 0) and
        (${table.afterStorageUri} is null or length(trim(${table.afterStorageUri})) > 0) and
        (${table.destinationBeforeStorageUri} is null or length(trim(${table.destinationBeforeStorageUri})) > 0)
      )`,
    ),
    check(
      "workspace_document_mutation_entries_mime_type_check",
      sql`(
        (${table.beforeMimeType} is null or length(trim(${table.beforeMimeType})) > 0) and
        (${table.afterMimeType} is null or length(trim(${table.afterMimeType})) > 0) and
        ((${table.beforeMimeType} is null) = (${table.afterMimeType} is null))
      )`,
    ),
    // D448's only Workspace metadata transition is an editor update. Keep
    // create/move/delete explicitly null until their complete source/
    // destination metadata proof is designed in a dedicated migration.
    check(
      "workspace_document_mutation_entries_mime_update_only_check",
      sql`(
        ${table.mutationKind} = 'update' or
        (${table.beforeMimeType} is null and ${table.afterMimeType} is null)
      )`,
    ),
    check(
      "workspace_document_mutation_entries_nonnegative_values_check",
      sql`(
        (${table.beforeRevision} is null or ${table.beforeRevision} >= 0) and
        (${table.afterRevision} is null or ${table.afterRevision} >= 0) and
        (${table.destinationBeforeRevision} is null or ${table.destinationBeforeRevision} >= 0) and
        (${table.beforeSize} is null or ${table.beforeSize} >= 0) and
        (${table.afterSize} is null or ${table.afterSize} >= 0) and
        (${table.destinationBeforeSize} is null or ${table.destinationBeforeSize} >= 0)
      )`,
    ),
    check(
      "workspace_document_mutation_entries_exact_size_check",
      // These bigint columns use Drizzle mode:number, so values above the
      // JavaScript exact-integer boundary cannot be read without rounding.
      // This is representation safety, not a product or file-size ceiling.
      sql`(
        (${table.beforeSize} is null or ${table.beforeSize} <= 9007199254740991) and
        (${table.afterSize} is null or ${table.afterSize} <= 9007199254740991) and
        (${table.destinationBeforeSize} is null or ${table.destinationBeforeSize} <= 9007199254740991)
      )`,
    ),
    check(
      "workspace_document_mutation_entries_proof_shape_check",
      sql`(
        (
          ${table.mutationKind} = 'create' and
          ${table.beforeLogicalPath} is null and ${table.beforeRevision} is null and
          ${table.beforeSha256} is null and ${table.beforeSize} is null and
          ${table.beforeStorageUri} is null and
          ${table.afterLogicalPath} is not null and ${table.afterRevision} is not null and
          ${table.afterSha256} is not null and ${table.afterSize} is not null and
          ${table.afterStorageUri} is not null and
          ${table.destinationBeforeArtifactInternalId} is null and
          ${table.destinationBeforeLogicalPath} is null and
          ${table.destinationBeforeRevision} is null and
          ${table.destinationBeforeSha256} is null and
          ${table.destinationBeforeSize} is null and
          ${table.destinationBeforeStorageUri} is null
        ) or (
          ${table.mutationKind} = 'update' and
          ${table.beforeLogicalPath} is not null and ${table.beforeRevision} is not null and
          ${table.beforeSha256} is not null and ${table.beforeSize} is not null and
          ${table.beforeStorageUri} is not null and
          ${table.afterLogicalPath} is not null and ${table.afterRevision} is not null and
          ${table.afterSha256} is not null and ${table.afterSize} is not null and
          ${table.afterStorageUri} is not null and
          ${table.destinationBeforeArtifactInternalId} is null and
          ${table.destinationBeforeLogicalPath} is null and
          ${table.destinationBeforeRevision} is null and
          ${table.destinationBeforeSha256} is null and
          ${table.destinationBeforeSize} is null and
          ${table.destinationBeforeStorageUri} is null
        ) or (
          ${table.mutationKind} = 'move' and
          ${table.beforeLogicalPath} is not null and ${table.beforeRevision} is not null and
          ${table.beforeSha256} is not null and ${table.beforeSize} is not null and
          ${table.beforeStorageUri} is not null and
          ${table.afterLogicalPath} is not null and ${table.afterRevision} is not null and
          ${table.afterSha256} is not null and ${table.afterSize} is not null and
          ${table.afterStorageUri} is not null and
          (
            (
              ${table.destinationBeforeArtifactInternalId} is null and
              ${table.destinationBeforeLogicalPath} is null and
              ${table.destinationBeforeRevision} is null and
              ${table.destinationBeforeSha256} is null and
              ${table.destinationBeforeSize} is null and
              ${table.destinationBeforeStorageUri} is null
            ) or (
              ${table.destinationBeforeArtifactInternalId} is not null and
              ${table.destinationBeforeLogicalPath} is not null and
              ${table.destinationBeforeRevision} is not null and
              ${table.destinationBeforeSha256} is not null and
              ${table.destinationBeforeSize} is not null and
              ${table.destinationBeforeStorageUri} is not null
            )
          )
        ) or (
          ${table.mutationKind} = 'delete' and
          ${table.beforeLogicalPath} is not null and ${table.beforeRevision} is not null and
          ${table.beforeSha256} is not null and ${table.beforeSize} is not null and
          ${table.beforeStorageUri} is not null and
          ${table.afterLogicalPath} is null and ${table.afterRevision} is null and
          ${table.afterSha256} is null and ${table.afterSize} is null and
          ${table.afterStorageUri} is null and
          ${table.destinationBeforeArtifactInternalId} is null and
          ${table.destinationBeforeLogicalPath} is null and
          ${table.destinationBeforeRevision} is null and
          ${table.destinationBeforeSha256} is null and
          ${table.destinationBeforeSize} is null and
          ${table.destinationBeforeStorageUri} is null
        )
      )`,
    ),
  ],
);

/**
 * Ordered opaque identifiers from BackendCommittedEntryReceipt. One entry may
 * produce several revision/undo ids (notably moves); values remain globally
 * unique across both kinds exactly as the coordinator validates them.
 */
export const workspaceDocumentMutationEntryIdentities = pgTable(
  "workspace_document_mutation_entry_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mutationEntryId: uuid("mutation_entry_id")
      .notNull()
      .references(() => workspaceDocumentMutationEntries.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    sequence: integer("sequence").notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    unique("uq_workspace_document_mutation_entry_identities_sequence").on(
      table.mutationEntryId,
      table.kind,
      table.sequence,
    ),
    uniqueIndex("uq_workspace_document_mutation_entry_identities_value").on(table.value),
    check(
      "workspace_document_mutation_entry_identities_kind_check",
      sql`${table.kind} in ('revision', 'undo_record')`,
    ),
    check(
      "workspace_document_mutation_entry_identities_sequence_check",
      sql`${table.sequence} >= 0`,
    ),
    check(
      "workspace_document_mutation_entry_identities_value_check",
      sql`length(trim(${table.value})) > 0`,
    ),
  ],
);

export const workspaceDocumentMutationOutbox = pgTable(
  "workspace_document_mutation_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mutationId: uuid("mutation_id").notNull(),
    sequence: integer("sequence").notNull(),
    /** One mutation may publish several ordered events as one durable batch. */
    batchIdempotencyKey: text("batch_idempotency_key").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    dispatchState: text("dispatch_state").notNull().default("pending"),
    dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_workspace_document_mutation_outbox_sequence").on(
      table.mutationId,
      table.sequence,
    ),
    unique("uq_workspace_document_mutation_outbox_batch_sequence").on(
      table.batchIdempotencyKey,
      table.sequence,
    ),
    index("idx_workspace_document_mutation_outbox_claim").on(
      table.dispatchState,
      table.nextAttemptAt,
      table.createdAt,
    ),
    index("idx_workspace_document_mutation_outbox_batch").on(
      table.batchIdempotencyKey,
      table.sequence,
    ),
    foreignKey({
      name: "workspace_document_mutation_outbox_committed_mutation_fk",
      columns: [table.mutationId, table.batchIdempotencyKey],
      foreignColumns: [
        workspaceDocumentMutations.id,
        workspaceDocumentMutations.outboxBatchIdempotencyKey,
      ],
    }).onDelete("cascade"),
    check(
      "workspace_document_mutation_outbox_sequence_check",
      sql`${table.sequence} >= 0`,
    ),
    check(
      "workspace_document_mutation_outbox_state_check",
      sql`${table.dispatchState} in ('pending', 'claimed', 'dispatched')`,
    ),
    check(
      "workspace_document_mutation_outbox_event_type_check",
      sql`${table.eventType} = 'document.mutation.committed'`,
    ),
    check(
      "workspace_document_mutation_outbox_payload_type_check",
      sql`${table.payload}->>'type' = 'document.mutation.committed'`,
    ),
    check(
      "workspace_document_mutation_outbox_dispatch_attempts_check",
      sql`${table.dispatchAttempts} >= 0`,
    ),
    check(
      "workspace_document_mutation_outbox_batch_idempotency_check",
      sql`length(trim(${table.batchIdempotencyKey})) > 0`,
    ),
    check(
      "workspace_document_mutation_outbox_state_timestamps_check",
      sql`(
        (${table.dispatchState} = 'pending' and ${table.claimedBy} is null and ${table.claimedAt} is null and ${table.dispatchedAt} is null) or
        (${table.dispatchState} = 'claimed' and ${table.claimedBy} is not null and ${table.claimedAt} is not null and ${table.dispatchedAt} is null) or
        (${table.dispatchState} = 'dispatched' and ${table.claimedBy} is null and ${table.claimedAt} is null and ${table.dispatchedAt} is not null)
      )`,
    ),
  ],
);

export type WorkspaceDocumentMutation = typeof workspaceDocumentMutations.$inferSelect;
export type NewWorkspaceDocumentMutation = typeof workspaceDocumentMutations.$inferInsert;
export type WorkspaceDocumentMutationEntry = typeof workspaceDocumentMutationEntries.$inferSelect;
export type NewWorkspaceDocumentMutationEntry = typeof workspaceDocumentMutationEntries.$inferInsert;
export type WorkspaceDocumentMutationEntryIdentity = typeof workspaceDocumentMutationEntryIdentities.$inferSelect;
export type NewWorkspaceDocumentMutationEntryIdentity = typeof workspaceDocumentMutationEntryIdentities.$inferInsert;
export type WorkspaceDocumentMutationOutboxRow = typeof workspaceDocumentMutationOutbox.$inferSelect;
export type NewWorkspaceDocumentMutationOutboxRow = typeof workspaceDocumentMutationOutbox.$inferInsert;
