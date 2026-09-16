/**
 * D487 — durable ownership, selection history, and idempotency substrate for
 * custom Human and Agent photos.
 *
 * `profiles.avatar_ref` remains the one current Agent pointer. These records
 * describe owned custom bytes and the append-only choices that have pointed at
 * them; they do not duplicate a current value.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  smallint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { AvatarRef } from "@nautilo/types";
import { agents } from "./agents";
import { users } from "./users";

export const OWNED_PHOTO_SUBJECT_KIND = {
  AGENT: "agent",
  HUMAN: "human",
} as const;
export type OwnedPhotoSubjectKind =
  (typeof OWNED_PHOTO_SUBJECT_KIND)[keyof typeof OWNED_PHOTO_SUBJECT_KIND];

export const OWNED_PHOTO_AVATAR_KIND = {
  GENERATED: "generated",
  UPLOADED: "uploaded",
} as const;
export type OwnedPhotoAvatarKind =
  (typeof OWNED_PHOTO_AVATAR_KIND)[keyof typeof OWNED_PHOTO_AVATAR_KIND];

export const OWNED_PHOTO_SOURCE = {
  UPLOAD: "upload",
  GENERATION: "generation",
  BUNDLE_IMPORT: "bundle_import",
  LEGACY_BACKFILL: "legacy_backfill",
  OPERATOR_ADOPTION: "operator_adoption",
} as const;
export type OwnedPhotoSource =
  (typeof OWNED_PHOTO_SOURCE)[keyof typeof OWNED_PHOTO_SOURCE];

export const OWNED_PHOTO_ORIGIN = {
  WORKBENCH: "workbench",
  MOBILE: "mobile",
  DESKTOP_WIZARD: "desktop_wizard",
  CLI_SETUP: "cli_setup",
  MANAGE_AVATAR: "manage_avatar",
  BUNDLE_IMPORT: "bundle_import",
  LEGACY_BACKFILL: "legacy_backfill",
  OPERATOR_ADOPTION: "operator_adoption",
} as const;
export type OwnedPhotoOrigin =
  (typeof OWNED_PHOTO_ORIGIN)[keyof typeof OWNED_PHOTO_ORIGIN];

/** Selection is an actual user/tool choice, never a legacy/adoption import. */
export const AGENT_PHOTO_SELECTION_ORIGIN = {
  WORKBENCH: "workbench",
  MOBILE: "mobile",
  DESKTOP_WIZARD: "desktop_wizard",
  CLI_SETUP: "cli_setup",
  MANAGE_AVATAR: "manage_avatar",
  BUNDLE_IMPORT: "bundle_import",
} as const;
export type AgentPhotoSelectionOrigin =
  (typeof AGENT_PHOTO_SELECTION_ORIGIN)[keyof typeof AGENT_PHOTO_SELECTION_ORIGIN];

export const PHOTO_LIBRARY_OPERATION_KIND = {
  CREATE: "create",
  SELECT: "select",
  UNDO: "undo",
  DELETE: "delete",
  RESTORE: "restore",
} as const;
export type PhotoLibraryOperationKind =
  (typeof PHOTO_LIBRARY_OPERATION_KIND)[keyof typeof PHOTO_LIBRARY_OPERATION_KIND];

export const PHOTO_LIBRARY_OPERATION_STATE = {
  PENDING: "pending",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;
export type PhotoLibraryOperationState =
  (typeof PHOTO_LIBRARY_OPERATION_STATE)[keyof typeof PHOTO_LIBRARY_OPERATION_STATE];

/**
 * An owned non-preset image. The server instance UUID mirrors existing
 * server-scoped persistence: it is copied from `nautilo_instance_identity`
 * by trusted service code instead of inventing a cross-table singleton FK.
 */
export const ownedPhotoEntries = pgTable(
  "owned_photo_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverInstanceId: uuid("server_instance_id").notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    subjectKind: text("subject_kind").notNull(),
    /** Required exactly for Agent subjects; NULL is canonical for Humans. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "restrict" }),
    avatarKind: text("avatar_kind").notNull(),
    /** Opaque safe identifier, never a client-visible storage path. */
    blobId: text("blob_id").notNull(),
    source: text("source").notNull(),
    origin: text("origin").notNull(),
    /** Stable idempotency/audit link from the trusted mutation service. */
    operationId: uuid("operation_id").notNull(),
    /** SHA-256 of the entry-creation semantics, never image bytes. */
    requestFingerprint: text("request_fingerprint").notNull(),
    /**
     * Generation provenance. The complete composed policy prompt, provider
     * response, and credentials are intentionally never persisted here.
     */
    generationPrompt: text("generation_prompt"),
    generationProvider: text("generation_provider"),
    generationModel: text("generation_model"),
    generationBatchOrdinal: bigint("generation_batch_ordinal", { mode: "number" }),
    /** Upload/import lifecycle facts; never an originating client path. */
    mediaMimeType: text("media_mime_type").notNull(),
    mediaByteSize: bigint("media_byte_size", { mode: "number" }).notNull(),
    mediaSha256: text("media_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    /** A bounded GC worker claims before touching known owned files. */
    gcClaimToken: uuid("gc_claim_token"),
    gcClaimedAt: timestamp("gc_claimed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_owned_photo_entries_server_blob").on(
      table.serverInstanceId,
      table.avatarKind,
      table.blobId,
    ),
    index("idx_owned_photo_entries_agent_recent").on(
      table.serverInstanceId,
      table.ownerUserId,
      table.agentId,
      table.createdAt.desc(),
      table.id.desc(),
    ).where(sql`${table.deletedAt} IS NULL`),
    index("idx_owned_photo_entries_agent_deleted").on(
      table.serverInstanceId,
      table.ownerUserId,
      table.agentId,
      table.deletedAt,
      table.purgeAfter,
    ).where(sql`${table.deletedAt} IS NOT NULL`),
    index("idx_owned_photo_entries_gc_claimable").on(
      table.purgeAfter,
      table.id,
    ).where(sql`${table.deletedAt} IS NOT NULL AND ${table.gcClaimedAt} IS NULL`),
    check(
      "owned_photo_entries_subject_check",
      sql`${table.subjectKind} IN ('agent', 'human')`,
    ),
    check(
      "owned_photo_entries_subject_agent_check",
      sql`(
        (${table.subjectKind} = 'agent' AND ${table.agentId} IS NOT NULL)
        OR (${table.subjectKind} = 'human' AND ${table.agentId} IS NULL)
      )`,
    ),
    check(
      "owned_photo_entries_avatar_kind_check",
      sql`${table.avatarKind} IN ('generated', 'uploaded')`,
    ),
    check(
      "owned_photo_entries_blob_id_check",
      sql`length(${table.blobId}) BETWEEN 1 AND 256 AND ${table.blobId} ~ '^[A-Za-z0-9._-]+$'`,
    ),
    check(
      "owned_photo_entries_source_check",
      sql`${table.source} IN ('upload', 'generation', 'bundle_import', 'legacy_backfill', 'operator_adoption')`,
    ),
    check(
      "owned_photo_entries_origin_check",
      sql`${table.origin} IN ('workbench', 'mobile', 'desktop_wizard', 'cli_setup', 'manage_avatar', 'bundle_import', 'legacy_backfill', 'operator_adoption')`,
    ),
    check(
      "owned_photo_entries_maintenance_origin_check",
      sql`(
        (${table.source} IN ('bundle_import', 'legacy_backfill', 'operator_adoption')
          AND ${table.origin} = ${table.source})
        OR (${table.source} NOT IN ('bundle_import', 'legacy_backfill', 'operator_adoption')
          AND ${table.origin} IN ('workbench', 'mobile', 'desktop_wizard', 'cli_setup', 'manage_avatar'))
      )`,
    ),
    check(
      "owned_photo_entries_request_fingerprint_check",
      sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "owned_photo_entries_generation_provenance_check",
      sql`(
        (${table.generationPrompt} IS NULL OR length(${table.generationPrompt}) <= 500)
        AND (${table.generationProvider} IS NULL OR length(trim(${table.generationProvider})) BETWEEN 1 AND 100)
        AND (${table.generationModel} IS NULL OR length(trim(${table.generationModel})) BETWEEN 1 AND 200)
        AND (${table.generationBatchOrdinal} IS NULL OR ${table.generationBatchOrdinal} >= 0)
        AND (
          ${table.source} <> 'generation'
          OR (
            ${table.generationProvider} IS NOT NULL
            AND ${table.generationModel} IS NOT NULL
          )
        )
      )`,
    ),
    check(
      "owned_photo_entries_media_provenance_check",
      sql`(
        length(trim(${table.mediaMimeType})) BETWEEN 1 AND 255
        AND ${table.mediaByteSize} > 0
        AND ${table.mediaSha256} ~ '^[0-9a-f]{64}$'
      )`,
    ),
    check(
      "owned_photo_entries_delete_lifecycle_check",
      sql`(
        (${table.deletedAt} IS NULL AND ${table.purgeAfter} IS NULL)
        OR (${table.deletedAt} IS NOT NULL AND ${table.purgeAfter} IS NOT NULL AND ${table.purgeAfter} >= ${table.deletedAt})
      )`,
    ),
    check(
      "owned_photo_entries_gc_claim_lifecycle_check",
      sql`(
        (${table.gcClaimToken} IS NULL AND ${table.gcClaimedAt} IS NULL)
        OR (
          ${table.gcClaimToken} IS NOT NULL
          AND ${table.gcClaimedAt} IS NOT NULL
          AND ${table.deletedAt} IS NOT NULL
          AND ${table.purgeAfter} IS NOT NULL
        )
      )`,
    ),
  ],
);

/**
 * Durable, post-commit cleanup receipt for blobs whose account ownership was
 * removed. The row deliberately has no User/Agent FK: it must remain after
 * the account transaction commits, until the exact known media bytes have
 * been removed or reconciled as already absent.
 */
export const accountDeletionPhotoCleanup = pgTable(
  "account_deletion_photo_cleanup",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverInstanceId: uuid("server_instance_id").notNull(),
    avatarKind: text("avatar_kind").notNull(),
    blobId: text("blob_id").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimToken: uuid("claim_token"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_account_deletion_photo_cleanup_blob").on(
      table.serverInstanceId,
      table.avatarKind,
      table.blobId,
    ),
    index("idx_account_deletion_photo_cleanup_pending").on(
      table.createdAt,
      table.id,
    ),
    check(
      "account_deletion_photo_cleanup_avatar_kind_check",
      sql`${table.avatarKind} IN ('generated', 'uploaded')`,
    ),
    check(
      "account_deletion_photo_cleanup_blob_id_check",
      sql`length(${table.blobId}) BETWEEN 1 AND 256 AND ${table.blobId} ~ '^[A-Za-z0-9._-]+$'`,
    ),
    check(
      "account_deletion_photo_cleanup_claim_shape_check",
      sql`(${table.claimedAt} IS NULL) = (${table.claimToken} IS NULL)`,
    ),
    check(
      "account_deletion_photo_cleanup_attempts_check",
      sql`${table.attempts} >= 0`,
    ),
  ],
);

/**
 * Append-only history of Agent `profiles.avatar_ref` selections. Preset
 * selections intentionally have null entry ids; custom refs must resolve via
 * service-level scope checks before this row is inserted.
 */
export const agentPhotoSelectionRevisions = pgTable(
  "agent_photo_selection_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverInstanceId: uuid("server_instance_id").notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    /** Positive value equals the committed profiles.avatar_selection_revision. */
    revision: bigint("revision", { mode: "number" }).notNull(),
    beforeAvatarRef: jsonb("before_avatar_ref").$type<AvatarRef | null>(),
    /** NULL is an explicit clear of the one canonical profile pointer. */
    afterAvatarRef: jsonb("after_avatar_ref").$type<AvatarRef | null>(),
    beforeEntryId: uuid("before_entry_id").references(() => ownedPhotoEntries.id, {
      onDelete: "restrict",
    }),
    afterEntryId: uuid("after_entry_id").references(() => ownedPhotoEntries.id, {
      onDelete: "restrict",
    }),
    /** Null after a non-owner actor removes their account; selection history survives. */
    actorUserId: uuid("actor_user_id").$type<string>()
      .references(() => users.id, { onDelete: "set null" }),
    origin: text("origin").notNull(),
    operationId: uuid("operation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_agent_photo_selection_revisions_agent_revision").on(
      table.agentId,
      table.revision,
    ),
    uniqueIndex("uq_agent_photo_selection_revisions_scoped_operation").on(
      table.serverInstanceId,
      table.ownerUserId,
      table.agentId,
      table.operationId,
    ),
    index("idx_agent_photo_selection_revisions_agent_recent").on(
      table.serverInstanceId,
      table.ownerUserId,
      table.agentId,
      table.revision.desc(),
    ),
    index("idx_agent_photo_selection_revisions_before_entry").on(table.beforeEntryId),
    index("idx_agent_photo_selection_revisions_after_entry").on(table.afterEntryId),
    check(
      "agent_photo_selection_revisions_revision_positive",
      sql`${table.revision} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "agent_photo_selection_revisions_origin_check",
      sql`${table.origin} IN ('workbench', 'mobile', 'desktop_wizard', 'cli_setup', 'manage_avatar', 'bundle_import')`,
    ),
    check(
      "agent_photo_selection_revisions_before_ref_check",
      avatarRefCheck(table.beforeAvatarRef),
    ),
    check(
      "agent_photo_selection_revisions_after_ref_check",
      avatarRefCheck(table.afterAvatarRef),
    ),
  ],
);

/**
 * Durable operation receipt. The mutation service owns the transaction and
 * writes the exact final result so transport retry does not add a second
 * entry/revision or turn an operation-id reuse into a silent new request.
 */
export const photoLibraryOperations = pgTable(
  "photo_library_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverInstanceId: uuid("server_instance_id").notNull(),
    /** Null after a non-owner viewer removes their account; owner receipt survives. */
    viewerUserId: uuid("viewer_user_id").$type<string>()
      .references(() => users.id, { onDelete: "set null" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    operationId: uuid("operation_id").notNull(),
    operationKind: text("operation_kind").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    state: text("state").notNull().default("pending"),
    /** Exact safe public result/error envelope returned on idempotent retry. */
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Create operations reserve 1–4 capacity slots before provider/storage work. */
    reservedSlots: smallint("reserved_slots").notNull().default(0),
    /** Pending create reservations are reclaimable after their short lease. */
    reservationExpiresAt: timestamp("reservation_expires_at", { withTimezone: true }),
    reservationLeaseToken: uuid("reservation_lease_token"),
    /** A failed expired create remains cleanup-eligible until artifacts are removed. */
    artifactCleanupCompletedAt: timestamp("artifact_cleanup_completed_at", { withTimezone: true }),
    /** Exact retry receipt horizon; later maintenance may prune after this. */
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '90 days'`),
  },
  (table) => [
    uniqueIndex("uq_photo_library_operations_scoped_operation").on(
      table.serverInstanceId,
      table.viewerUserId,
      table.ownerUserId,
      table.agentId,
      table.operationId,
    ),
    index("idx_photo_library_operations_agent_created").on(
      table.serverInstanceId,
      table.ownerUserId,
      table.agentId,
      table.createdAt.desc(),
    ),
    index("idx_photo_library_operations_expiry").on(table.expiresAt, table.id),
    index("idx_photo_library_operations_live_create_reservations")
      .on(table.serverInstanceId, table.ownerUserId, table.agentId, table.reservationExpiresAt)
      .where(sql`${table.operationKind} = 'create' AND ${table.state} = 'pending'`),
    check(
      "photo_library_operations_kind_check",
      sql`${table.operationKind} IN ('create', 'select', 'undo', 'delete', 'restore')`,
    ),
    check(
      "photo_library_operations_fingerprint_check",
      sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "photo_library_operations_state_check",
      sql`${table.state} IN ('pending', 'completed', 'failed')`,
    ),
    check(
      "photo_library_operations_result_lifecycle_check",
      sql`(
        (${table.state} = 'pending' AND ${table.result} IS NULL AND ${table.completedAt} IS NULL)
        OR (${table.state} IN ('completed', 'failed') AND ${table.result} IS NOT NULL AND ${table.completedAt} IS NOT NULL)
      )`,
    ),
    check(
      "photo_library_operations_result_size_check",
      sql`${table.result} IS NULL OR pg_column_size(${table.result}) <= 65536`,
    ),
    check(
      "photo_library_operations_reservation_check",
      sql`(
        (${table.operationKind} = 'create' AND ${table.reservedSlots} BETWEEN 1 AND 4 AND ${table.reservationExpiresAt} IS NOT NULL AND ${table.reservationLeaseToken} IS NOT NULL)
        OR (${table.operationKind} <> 'create' AND ${table.reservedSlots} = 0 AND ${table.reservationExpiresAt} IS NULL AND ${table.reservationLeaseToken} IS NULL)
      )`,
    ),
    check(
      "photo_library_operations_expiry_check",
      sql`${table.expiresAt} = ${table.createdAt} + interval '90 days'`,
    ),
  ],
);

function avatarRefCheck(column: AnyPgColumn) {
  return sql`(
    ${column} IS NULL
    OR (
      jsonb_typeof(${column}) = 'object'
      AND (
        (
          ${column}->>'kind' = 'preset'
          AND jsonb_typeof(${column}->'id') = 'string'
          AND length(trim(${column}->>'id')) > 0
          AND ${column} - ARRAY['kind', 'id'] = '{}'::jsonb
        )
        OR (
          ${column}->>'kind' IN ('generated', 'uploaded')
          AND jsonb_typeof(${column}->'blobId') = 'string'
          AND ${column}->>'blobId' ~ '^[A-Za-z0-9._-]+$'
          AND ${column} - ARRAY['kind', 'blobId'] = '{}'::jsonb
        )
      )
    )
  )`;
}

export type OwnedPhotoEntry = typeof ownedPhotoEntries.$inferSelect;
export type NewOwnedPhotoEntry = typeof ownedPhotoEntries.$inferInsert;
export type AccountDeletionPhotoCleanup = typeof accountDeletionPhotoCleanup.$inferSelect;
export type NewAccountDeletionPhotoCleanup = typeof accountDeletionPhotoCleanup.$inferInsert;
export type AgentPhotoSelectionRevision = typeof agentPhotoSelectionRevisions.$inferSelect;
export type NewAgentPhotoSelectionRevision = typeof agentPhotoSelectionRevisions.$inferInsert;
export type PhotoLibraryOperation = typeof photoLibraryOperations.$inferSelect;
export type NewPhotoLibraryOperation = typeof photoLibraryOperations.$inferInsert;
