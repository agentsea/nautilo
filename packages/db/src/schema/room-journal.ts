import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { cryptoObjects } from "./crypto-storage";
import { reflectionRecords } from "./reflection-records";
import { rooms } from "./rooms";

const JOURNAL_ERROR_CODES = sql.raw(
  "'provider', 'timeout', 'invalid_output', 'input_too_large', 'lease_lost', 'persistence', 'unknown'",
);

export const ROOM_JOURNAL_CRYPTO_PUBLICATION_LIMITS = Object.freeze({
  attachmentPlanBytes: 128 * 1_024,
  maximumOutputObjects: 5,
  maximumAttempts: 8,
  leaseSeconds: 2 * 60,
});

const bytea = customType<{
  data: Uint8Array;
  driverData: Uint8Array;
}>({
  dataType: () => "bytea",
});

const nautiloProductRole = pgRole("nautilo").existing();

function productPolicy(tableName: string) {
  return pgPolicy(`${tableName}_product_all`, {
    as: "permissive",
    for: "all",
    to: nautiloProductRole,
    using: sql`true`,
    withCheck: sql`true`,
  });
}

function portableJournalCryptoId(name: string, column: AnyPgColumn) {
  return check(
    name,
    sql`octet_length(${column}) between 1 and 128
      and ${column} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'`,
  );
}

/**
 * M219 — one durable Stenographer cursor, lease, retry record, and compaction
 * lease per Room. Eligibility is evaluated from current Room membership; the
 * row intentionally survives Agent-free suspension so re-entry can resume
 * after the skipped interval without backfilling it.
 */
export const roomJournalState = pgTable(
  "room_journal_state",
  {
    roomId: uuid("room_id")
      .primaryKey()
      .references(() => rooms.id, { onDelete: "cascade" }),
    lastProcessedMessageId: integer("last_processed_message_id").notNull().default(0),
    lastProcessedAt: timestamp("last_processed_at", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    compactionLeaseToken: uuid("compaction_lease_token"),
    compactionLeaseExpiresAt: timestamp("compaction_lease_expires_at", {
      withTimezone: true,
    }),
    /** Authority is missing before an exact crypto request can be described. */
    extractionAuthorizationWaitLane: text("extraction_authorization_wait_lane", {
      enum: ["live", "historical", "rebuild"],
    }),
    extractionAuthorizationWaitingSince: timestamp("extraction_authorization_waiting_since", {withTimezone: true}),
    compactionAuthorizationWaitingSince: timestamp("compaction_authorization_waiting_since", {withTimezone: true}),
    extractionFailureCount: integer("extraction_failure_count").notNull().default(0),
    extractionRetryAfter: timestamp("extraction_retry_after", { withTimezone: true }),
    lastExtractionErrorCode: text("last_extraction_error_code"),
    lastExtractionErrorAt: timestamp("last_extraction_error_at", { withTimezone: true }),
    lastExtractionCompletedAt: timestamp("last_extraction_completed_at", {
      withTimezone: true,
    }),
    compactionDueAt: timestamp("compaction_due_at", { withTimezone: true }),
    compactionFailureCount: integer("compaction_failure_count").notNull().default(0),
    compactionRetryAfter: timestamp("compaction_retry_after", { withTimezone: true }),
    lastCompactionErrorCode: text("last_compaction_error_code"),
    lastCompactionErrorAt: timestamp("last_compaction_error_at", { withTimezone: true }),
    lastCompactionErrorAttempt: integer("last_compaction_error_attempt"),
    lastCompactionErrorModelId: text("last_compaction_error_model_id"),
    lastCompactionCompletedAt: timestamp("last_compaction_completed_at", {
      withTimezone: true,
    }),
    extractorVersion: text("extractor_version").notNull(),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    /**
     * Existing rows become `pending` when the historical-backfill migration is
     * applied. New Rooms explicitly insert `not_needed`; their live cursor
     * already begins before the first message.
     */
    historicalBackfillStatus: text("historical_backfill_status", {
      enum: ["pending", "completed", "not_needed"],
    }).notNull().default("pending"),
    historicalBackfillCursorMessageId: integer(
      "historical_backfill_cursor_message_id",
    ),
    historicalBackfillTargetMessageId: integer(
      "historical_backfill_target_message_id",
    ),
    historicalBackfillCompletedAt: timestamp(
      "historical_backfill_completed_at",
      { withTimezone: true },
    ),
    /** M230 — increments on every committed edit invalidating derived state. */
    rebuildGeneration: integer("rebuild_generation").notNull().default(0),
    /** M230 — non-NULL while journal/rollup context is fail-closed. */
    rebuildRequestedAt: timestamp("rebuild_requested_at", { withTimezone: true }),
    /** M230 — fixed transcript head captured for the current rebuild generation. */
    rebuildTargetMessageId: integer("rebuild_target_message_id"),
    /** M267 — bounded, restart-safe legacy-event conversion progress. */
    recordConversionStatus: text("record_conversion_status", {
      enum: ["pending", "completed", "not_needed"],
    }).notNull().default("not_needed"),
    recordConversionCursorSequence: integer(
      "record_conversion_cursor_sequence",
    ).notNull().default(0),
    recordConversionFailureCount: integer(
      "record_conversion_failure_count",
    ).notNull().default(0),
    recordConversionRetryAfter: timestamp(
      "record_conversion_retry_after",
      { withTimezone: true },
    ),
    recordConversionLeaseToken: uuid("record_conversion_lease_token"),
    recordConversionLeaseExpiresAt: timestamp(
      "record_conversion_lease_expires_at",
      { withTimezone: true },
    ),
    recordConversionLastErrorCode: text("record_conversion_last_error_code", {
      enum: [
        "legacy_open_unavailable",
        "authorization_unavailable",
        "publication_ambiguous",
        "projection_conflict",
        "source_unavailable",
        "persistence",
      ],
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_room_journal_state_extraction_retry").on(table.extractionRetryAfter),
    index("idx_room_journal_state_compaction_due").on(table.compactionDueAt),
    index("idx_room_journal_state_historical_backfill").on(
      table.historicalBackfillStatus,
      table.updatedAt,
    ),
    index("idx_room_journal_state_record_conversion").on(
      table.recordConversionStatus,
      table.recordConversionRetryAfter,
      table.recordConversionLeaseExpiresAt,
    ),
    check("room_journal_state_extraction_authorization_wait", sql`(
      ${table.extractionAuthorizationWaitLane} IS NULL AND ${table.extractionAuthorizationWaitingSince} IS NULL
    ) OR (
      ${table.extractionAuthorizationWaitLane} IS NOT NULL
      AND ${table.extractionAuthorizationWaitLane} IN ('live', 'historical', 'rebuild')
      AND ${table.extractionAuthorizationWaitingSince} IS NOT NULL
    )`),
    check(
      "room_journal_state_cursor_nonnegative",
      sql`${table.lastProcessedMessageId} >= 0`,
    ),
    check(
      "room_journal_state_extraction_failures_nonnegative",
      sql`${table.extractionFailureCount} >= 0`,
    ),
    check(
      "room_journal_state_compaction_failures_nonnegative",
      sql`${table.compactionFailureCount} >= 0`,
    ),
    check(
      "room_journal_state_extraction_lease_pair",
      sql`(${table.leaseToken} IS NULL) = (${table.leaseExpiresAt} IS NULL)`,
    ),
    check(
      "room_journal_state_compaction_lease_pair",
      sql`(${table.compactionLeaseToken} IS NULL) = (${table.compactionLeaseExpiresAt} IS NULL)`,
    ),
    check(
      "room_journal_state_extraction_error_code",
      sql`${table.lastExtractionErrorCode} IS NULL OR ${table.lastExtractionErrorCode} IN (${JOURNAL_ERROR_CODES})`,
    ),
    check(
      "room_journal_state_compaction_error_code",
      sql`${table.lastCompactionErrorCode} IS NULL OR ${table.lastCompactionErrorCode} IN (${JOURNAL_ERROR_CODES})`,
    ),
    check(
      "room_journal_state_compaction_error_attempt_nonnegative",
      sql`${table.lastCompactionErrorAttempt} IS NULL OR ${table.lastCompactionErrorAttempt} >= 0`,
    ),
    check(
      "room_journal_state_historical_cursor_nonnegative",
      sql`${table.historicalBackfillCursorMessageId} IS NULL OR ${table.historicalBackfillCursorMessageId} >= 0`,
    ),
    check(
      "room_journal_state_historical_target_nonnegative",
      sql`${table.historicalBackfillTargetMessageId} IS NULL OR ${table.historicalBackfillTargetMessageId} >= 0`,
    ),
    check(
      "room_journal_state_historical_range",
      sql`${table.historicalBackfillCursorMessageId} IS NULL OR ${table.historicalBackfillTargetMessageId} IS NULL OR ${table.historicalBackfillCursorMessageId} <= ${table.historicalBackfillTargetMessageId}`,
    ),
    check(
      "room_journal_state_historical_status",
      sql`${table.historicalBackfillStatus} IN ('pending', 'completed', 'not_needed')`,
    ),
    check(
      "room_journal_state_rebuild_generation_nonnegative",
      sql`${table.rebuildGeneration} >= 0`,
    ),
    check(
      "room_journal_state_rebuild_target_nonnegative",
      sql`${table.rebuildTargetMessageId} IS NULL OR ${table.rebuildTargetMessageId} >= 0`,
    ),
    check(
      "room_journal_state_record_conversion_status",
      sql`${table.recordConversionStatus} IN ('pending', 'completed', 'not_needed')`,
    ),
    check(
      "room_journal_state_record_conversion_cursor_nonnegative",
      sql`${table.recordConversionCursorSequence} >= 0`,
    ),
    check(
      "room_journal_state_record_conversion_failures_nonnegative",
      sql`${table.recordConversionFailureCount} >= 0`,
    ),
    check(
      "room_journal_state_record_conversion_lease_pair",
      sql`(${table.recordConversionLeaseToken} IS NULL) = (${table.recordConversionLeaseExpiresAt} IS NULL)`,
    ),
  ],
);

/**
 * A range-identified extraction receipt. The unique range tuple is the durable
 * idempotency boundary; prompts and raw model responses are never stored.
 */
export const roomJournalBatches = pgTable(
  "room_journal_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    fromMessageIdExclusive: integer("from_message_id_exclusive").notNull(),
    throughMessageIdInclusive: integer("through_message_id_inclusive").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    /** M267 — legacy writers leave V1; native Record publication writes V2. */
    observationPublicationVersion: smallint(
      "observation_publication_version",
    ).notNull().default(1),
    ordinaryFallbackReason: text("ordinary_fallback_reason", {
      enum: ["device", "authority"],
    }),
    ordinaryFallbackRebuildGeneration: integer(
      "ordinary_fallback_rebuild_generation",
    ),
    ordinaryOutputFingerprint: bytea("ordinary_output_fingerprint"),
    lane: text("lane", {
      enum: ["live", "historical"],
    })
      .notNull()
      .default("live"),
    status: text("status", {
      enum: ["pending", "running", "completed", "failed"],
    }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    operationCount: integer("operation_count"),
    modelId: text("model_id"),
    errorCode: text("error_code"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastErrorAttempt: integer("last_error_attempt"),
    lastErrorModelId: text("last_error_model_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_room_journal_batches_range").on(
      table.roomId,
      table.fromMessageIdExclusive,
      table.throughMessageIdInclusive,
      table.extractorVersion,
      table.lane,
    ),
    index("idx_room_journal_batches_room_status").on(table.roomId, table.status),
    index("idx_room_journal_batches_last_error").on(table.lastErrorAt),
    check(
      "room_journal_batches_valid_range",
      sql`${table.throughMessageIdInclusive} > ${table.fromMessageIdExclusive}`,
    ),
    check("room_journal_batches_attempt_nonnegative", sql`${table.attemptCount} >= 0`),
    check(
      "room_journal_batches_operation_count",
      sql`${table.operationCount} IS NULL OR ${table.operationCount} BETWEEN 0 AND 5`,
    ),
    check(
      "room_journal_batches_lane",
      sql`${table.lane} IN ('live', 'historical')`,
    ),
    check(
      "room_journal_batches_status",
      sql`${table.status} IN ('pending', 'running', 'completed', 'failed')`,
    ),
    check(
      "room_journal_batches_error_code",
      sql`${table.errorCode} IS NULL OR ${table.errorCode} IN (${JOURNAL_ERROR_CODES})`,
    ),
    check(
      "room_journal_batches_last_error_attempt_nonnegative",
      sql`${table.lastErrorAttempt} IS NULL OR ${table.lastErrorAttempt} >= 0`,
    ),
    check(
      "room_journal_batches_observation_publication_version",
      sql`${table.observationPublicationVersion} IN (1, 2)`,
    ),
    check(
      "room_journal_batches_ordinary_fallback_provenance",
      sql`(
        ${table.ordinaryFallbackReason} IS NULL
        AND ${table.ordinaryFallbackRebuildGeneration} IS NULL
        AND ${table.ordinaryOutputFingerprint} IS NULL
      ) OR (
        ${table.status} = 'completed'
        AND ${table.observationPublicationVersion} = 2
        AND ${table.ordinaryFallbackReason} IS NOT NULL
        AND ${table.ordinaryFallbackReason} IN ('device', 'authority')
        AND ${table.ordinaryFallbackRebuildGeneration} IS NOT NULL
        AND ${table.ordinaryFallbackRebuildGeneration} >= 0
        AND ${table.ordinaryOutputFingerprint} IS NOT NULL
        AND octet_length(${table.ordinaryOutputFingerprint}) = 32
      )`,
    ),
  ],
);

/**
 * Append-only semantic Room events. Supersede/resolve operations add a new
 * row and transition the referenced row's effective status transactionally.
 */
export const roomEvents = pgTable(
  "room_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    kind: text("kind", {
      enum: [
        "decision",
        "commitment",
        "goal",
        "state_change",
        "fact",
        "preference_or_norm",
        "open_question",
        "risk",
      ],
    }).notNull(),
    /** Legacy semantic body only; native projections resolve Record payloads. */
    statement: text("statement"),
    status: text("status", { enum: ["active", "superseded", "resolved"] })
      .notNull()
      .default("active"),
    supersedesEventId: uuid("supersedes_event_id").references(
      (): AnyPgColumn => roomEvents.id,
      { onDelete: "restrict" },
    ),
    resolvesEventId: uuid("resolves_event_id").references(
      (): AnyPgColumn => roomEvents.id,
      { onDelete: "restrict" },
    ),
    sourceMessageIds: integer("source_message_ids").array().notNull(),
    sourceBatchId: uuid("source_batch_id")
      .notNull()
      .references(() => roomJournalBatches.id, { onDelete: "restrict" }),
    batchLocalOrdinal: integer("batch_local_ordinal").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    projectionKind: text("projection_kind", {
      enum: ["legacy", "native"],
    }).notNull().default("legacy"),
    recordId: text("record_id").references(
      () => reflectionRecords.recordId,
      { onDelete: "restrict" },
    ),
    cryptoObjectId: text("crypto_object_id").references(
      () => cryptoObjects.objectId,
      { onDelete: "no action" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    nativeAttachedAt: timestamp("native_attached_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_room_events_sequence").on(table.roomId, table.sequence),
    uniqueIndex("uq_room_events_batch_ordinal").on(
      table.sourceBatchId,
      table.batchLocalOrdinal,
    ),
    unique("uq_room_events_crypto_object_id").on(table.cryptoObjectId),
    index("idx_room_events_effective").on(table.roomId, table.status, table.sequence),
    index("idx_room_events_created_at").on(table.createdAt),
    index("idx_room_events_conversion").on(
      table.projectionKind,
      table.roomId,
      table.sequence,
    ),
    check("room_events_sequence_positive", sql`${table.sequence} > 0`),
    check(
      "room_events_kind",
      sql`${table.kind} IN ('decision', 'commitment', 'goal', 'state_change', 'fact', 'preference_or_norm', 'open_question', 'risk')`,
    ),
    check(
      "room_events_statement_size",
      sql`${table.statement} IS NULL OR char_length(${table.statement}) BETWEEN 1 AND 500`,
    ),
    check(
      "room_events_status",
      sql`${table.status} IN ('active', 'superseded', 'resolved')`,
    ),
    check(
      "room_events_source_cardinality",
      sql`cardinality(${table.sourceMessageIds}) BETWEEN 1 AND 16`,
    ),
    check(
      "room_events_batch_ordinal_nonnegative",
      sql`${table.batchLocalOrdinal} >= 0`,
    ),
    check(
      "room_events_single_transition_link",
      sql`NOT (${table.supersedesEventId} IS NOT NULL AND ${table.resolvesEventId} IS NOT NULL)`,
    ),
    check(
      "room_events_projection_kind",
      sql`${table.projectionKind} IN ('legacy', 'native')`,
    ),
    check(
      "room_events_projection_shape",
      sql`(
        ${table.projectionKind} = 'legacy'
        AND ${table.statement} IS NOT NULL
        AND ${table.recordId} IS NULL
        AND ${table.nativeAttachedAt} IS NULL
      ) OR (
        ${table.projectionKind} = 'native'
        AND ${table.statement} IS NULL
        AND ${table.cryptoObjectId} IS NULL
        AND ${table.recordId} = ${table.id}::text
        AND ${table.nativeAttachedAt} IS NOT NULL
      )`,
    ),
  ],
);

/**
 * One durable, forward-only server writer fence. Its trigger finalizer
 * serializes the first native publication against legacy batch completion.
 */
export const roomJournalRecordCutover = pgTable(
  "room_journal_record_cutover",
  {
    singletonKey: smallint("singleton_key").primaryKey().default(1),
    cutoverVersion: smallint("cutover_version").notNull().default(1),
    firstNativeRecordId: text("first_native_record_id")
      .notNull()
      .references(() => reflectionRecords.recordId, { onDelete: "restrict" }),
    activatedAt: timestamp("activated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("room_journal_record_cutover_singleton", sql`${table.singletonKey} = 1`),
    check("room_journal_record_cutover_version_v1", sql`${table.cutoverVersion} = 1`),
    productPolicy("room_journal_record_cutover"),
  ],
).enableRLS();

/**
 * Content-free bridge between an M230 rebuild generation and the native
 * observation Records displaced by it. It exists only until stale Records are
 * terminalized after that exact generation completes.
 */
export const roomJournalRecordRebuildRetirements = pgTable(
  "room_journal_record_rebuild_retirements",
  {
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    rebuildGeneration: integer("rebuild_generation").notNull(),
    recordId: text("record_id")
      .notNull()
      .references(() => reflectionRecords.recordId, { onDelete: "restrict" }),
    state: text("state", { enum: ["pending", "sunset"] })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      name: "pk_room_journal_record_rebuild_retirements",
      columns: [table.roomId, table.rebuildGeneration, table.recordId],
    }),
    index("idx_room_journal_record_rebuild_retirements_pending").on(
      table.roomId,
      table.state,
      table.rebuildGeneration,
    ),
    check(
      "room_journal_record_rebuild_retirements_generation_positive",
      sql`${table.rebuildGeneration} > 0`,
    ),
    check(
      "room_journal_record_rebuild_retirements_state",
      sql`${table.state} IN ('pending', 'sunset')`,
    ),
    productPolicy("room_journal_record_rebuild_retirements"),
  ],
).enableRLS();

/** Cumulative, bounded prompt projection over the older effective journal. */
export const roomEventRollups = pgTable(
  "room_event_rollups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    throughEventSequence: integer("through_event_sequence").notNull(),
    // A current protected representation may exist without an ordinary sibling.
    content: text("content"),
    sourceEventCount: integer("source_event_count").notNull(),
    modelId: text("model_id").notNull(),
    compactorVersion: text("compactor_version").notNull(),
    cryptoObjectId: text("crypto_object_id").references(
      () => cryptoObjects.objectId,
      { onDelete: "no action" },
    ),
    ordinaryFallbackReason: text("ordinary_fallback_reason", {
      enum: ["device", "authority"],
    }),
    ordinaryFallbackRebuildGeneration: integer(
      "ordinary_fallback_rebuild_generation",
    ),
    ordinaryOutputFingerprint: bytea("ordinary_output_fingerprint"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_room_event_rollups_cursor").on(
      table.roomId,
      table.throughEventSequence,
      table.compactorVersion,
    ),
    unique("uq_room_event_rollups_crypto_object_id").on(
      table.cryptoObjectId,
    ),
    index("idx_room_event_rollups_latest").on(
      table.roomId,
      table.throughEventSequence,
    ),
    index("idx_room_event_rollups_created_at").on(table.createdAt),
    check(
      "room_event_rollups_sequence_positive",
      sql`${table.throughEventSequence} > 0`,
    ),
    check(
      "room_event_rollups_source_count_positive",
      sql`${table.sourceEventCount} > 0`,
    ),
    check(
      "room_event_rollups_content_size",
      sql`char_length(${table.content}) BETWEEN 1 AND 12000`,
    ),
    check(
      "room_event_rollups_ordinary_fallback_provenance",
      sql`(
        ${table.ordinaryFallbackReason} IS NULL
        AND ${table.ordinaryFallbackRebuildGeneration} IS NULL
        AND ${table.ordinaryOutputFingerprint} IS NULL
      ) OR (
        ${table.ordinaryFallbackReason} IS NOT NULL
        AND ${table.ordinaryFallbackReason} IN ('device', 'authority')
        AND ${table.ordinaryFallbackRebuildGeneration} IS NOT NULL
        AND ${table.ordinaryFallbackRebuildGeneration} >= 0
        AND ${table.ordinaryOutputFingerprint} IS NOT NULL
        AND octet_length(${table.ordinaryOutputFingerprint}) = 32
      )`,
    ),
  ],
);

/**
 * M241 — product-owned, content-free receipt that reconciles a crypto-first
 * journal publication with later Room-event attachment or tombstoning.
 * `attachment_plan_bytes` is a strict versioned metadata plan; it must never
 * contain event statements, rollup content, prompts, or model output.
 */
export const roomJournalCryptoPublications = pgTable(
  "room_journal_crypto_publications",
  {
    publicationId: text("publication_id").primaryKey(),
    requestId: text("request_id").notNull(),
    roomId: uuid("room_id").notNull(),
    namespaceIdAtAllocation: uuid("namespace_id_at_allocation").notNull(),
    workId: text("work_id").notNull(),
    sourceBatchId: uuid("source_batch_id").references(
      () => roomJournalBatches.id,
      { onDelete: "restrict" },
    ),
    rebuildGeneration: integer("rebuild_generation").notNull(),
    workIdentityHash: bytea("work_identity_hash").notNull(),
    descriptorHash: bytea("descriptor_hash").notNull(),
    attachmentPlanVersion: smallint("attachment_plan_version").notNull(),
    attachmentPlanHash: bytea("attachment_plan_hash").notNull(),
    attachmentPlanBytes: bytea("attachment_plan_bytes").notNull(),
    outputObjectCount: smallint("output_object_count").notNull(),
    state: text("state").notNull(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    retryCount: smallint("retry_count").notNull(),
    maximumAttempts: smallint("maximum_attempts").notNull(),
    failureCode: text("failure_code"),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    cryptoCommittedAt: timestamp("crypto_committed_at", {
      withTimezone: true,
    }),
    attachedAt: timestamp("attached_at", { withTimezone: true }),
    tombstoneRequestedAt: timestamp("tombstone_requested_at", {
      withTimezone: true,
    }),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    lastAuditedAt: timestamp("last_audited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.roomId, table.namespaceIdAtAllocation],
      foreignColumns: [rooms.id, rooms.namespaceId],
      name: "room_journal_crypto_publications_room_namespace_fk",
    }).onDelete("restrict"),
    unique("uq_room_journal_crypto_publications_request").on(
      table.requestId,
    ),
    unique("uq_room_journal_crypto_publications_work").on(table.workId),
    unique("uq_room_journal_crypto_publications_work_identity").on(
      table.workIdentityHash,
    ),
    portableJournalCryptoId(
      "room_journal_crypto_publications_id_portable",
      table.publicationId,
    ),
    portableJournalCryptoId(
      "room_journal_crypto_publications_request_id_portable",
      table.requestId,
    ),
    portableJournalCryptoId(
      "room_journal_crypto_publications_work_id_portable",
      table.workId,
    ),
    check(
      "room_journal_crypto_publications_rebuild_generation",
      sql`${table.rebuildGeneration} >= 0`,
    ),
    check(
      "room_journal_crypto_publications_work_identity_hash_size",
      sql`octet_length(${table.workIdentityHash}) = 32`,
    ),
    check(
      "room_journal_crypto_publications_descriptor_hash_size",
      sql`octet_length(${table.descriptorHash}) = 32`,
    ),
    check(
      "room_journal_crypto_publications_attachment_plan",
      sql`${table.attachmentPlanVersion} in (1, 2)
        and octet_length(${table.attachmentPlanHash}) = 32
        and octet_length(${table.attachmentPlanBytes}) between 1
          and ${sql.raw(
            String(
              ROOM_JOURNAL_CRYPTO_PUBLICATION_LIMITS.attachmentPlanBytes,
            ),
          )}`,
    ),
    check(
      "room_journal_crypto_publications_output_count",
      sql`${table.outputObjectCount} between 0
        and ${sql.raw(
          String(
            ROOM_JOURNAL_CRYPTO_PUBLICATION_LIMITS.maximumOutputObjects,
          ),
        )}`,
    ),
    check(
      "room_journal_crypto_publications_state",
      sql`${table.state} in (
        'reserved',
        'crypto_committed',
        'attached',
        'quarantined',
        'superseded',
        'tombstone_pending',
        'tombstoned'
      )`,
    ),
    check(
      "room_journal_crypto_publications_lease_coherent",
      sql`(
        ${table.leaseToken} is null
        and ${table.leaseExpiresAt} is null
      ) or (
        ${table.state} in (
          'reserved',
          'crypto_committed',
          'tombstone_pending'
        )
        and ${table.leaseToken} is not null
        and ${table.leaseExpiresAt} is not null
        and ${table.updatedAt} < ${table.leaseExpiresAt}
        and ${table.leaseExpiresAt}
          <= ${table.updatedAt} + interval '${
            sql.raw(
              String(
                ROOM_JOURNAL_CRYPTO_PUBLICATION_LIMITS.leaseSeconds,
              ),
            )
          } seconds'
      )`,
    ),
    check(
      "room_journal_crypto_publications_retry_bounds",
      sql`${table.retryCount} between 0 and ${table.maximumAttempts}
        and ${table.maximumAttempts} = ${sql.raw(
          String(ROOM_JOURNAL_CRYPTO_PUBLICATION_LIMITS.maximumAttempts),
        )}`,
    ),
    check(
      "room_journal_crypto_publications_failure_code",
      sql`${table.failureCode} is null or ${table.failureCode} in (
        'stale_authority',
        'crypto_publication_failed',
        'mapping_conflict',
        'attachment_failed',
        'integrity_failure',
        'rebuild_superseded',
        'lease_lost',
        'tombstone_failed'
      )`,
    ),
    check(
      "room_journal_crypto_publications_failure_coherent",
      sql`(
        ${table.failureCode} is null
        and ${table.lastFailureAt} is null
        and ${table.state} <> 'quarantined'
      ) or (
        ${table.failureCode} is not null
        and ${table.lastFailureAt} is not null
      )`,
    ),
    check(
      "room_journal_crypto_publications_publication_coherent",
      sql`(
        ${table.state} = 'reserved'
        and ${table.cryptoCommittedAt} is null
        and ${table.attachedAt} is null
        and ${table.tombstoneRequestedAt} is null
        and ${table.tombstonedAt} is null
      ) or (
        ${table.state} = 'crypto_committed'
        and ${table.cryptoCommittedAt} is not null
        and ${table.attachedAt} is null
        and ${table.tombstoneRequestedAt} is null
        and ${table.tombstonedAt} is null
      ) or (
        ${table.state} = 'attached'
        and ${table.cryptoCommittedAt} is not null
        and ${table.attachedAt} is not null
        and ${table.tombstoneRequestedAt} is null
        and ${table.tombstonedAt} is null
      ) or (
        ${table.state} = 'tombstone_pending'
        and ${table.cryptoCommittedAt} is not null
        and (
          ${table.attachedAt} is null
          or ${table.cryptoCommittedAt} <= ${table.attachedAt}
        )
        and ${table.tombstoneRequestedAt} is not null
        and ${table.tombstonedAt} is null
      ) or (
        ${table.state} = 'tombstoned'
        and ${table.cryptoCommittedAt} is not null
        and (
          ${table.attachedAt} is null
          or ${table.cryptoCommittedAt} <= ${table.attachedAt}
        )
        and ${table.tombstoneRequestedAt} is not null
        and ${table.tombstonedAt} is not null
      ) or (
        ${table.state} = 'quarantined'
        and ${table.attachedAt} is null
        and ${table.tombstoneRequestedAt} is null
        and ${table.tombstonedAt} is null
      ) or (
        ${table.state} = 'superseded'
        and ${table.cryptoCommittedAt} is null
        and ${table.attachedAt} is null
        and ${table.tombstoneRequestedAt} is null
        and ${table.tombstonedAt} is null
      )`,
    ),
    check(
      "room_journal_crypto_publications_time_order",
      sql`${table.createdAt} <= ${table.updatedAt}
        and (
          ${table.cryptoCommittedAt} is null
          or ${table.createdAt} <= ${table.cryptoCommittedAt}
        )
        and (
          ${table.attachedAt} is null
          or (
            ${table.cryptoCommittedAt} is not null
            and ${table.cryptoCommittedAt} <= ${table.attachedAt}
          )
        )
        and (
          ${table.tombstoneRequestedAt} is null
          or (
            ${table.cryptoCommittedAt} is not null
            and ${table.cryptoCommittedAt} <= ${table.tombstoneRequestedAt}
            and (
              ${table.attachedAt} is null
              or ${table.attachedAt} <= ${table.tombstoneRequestedAt}
            )
          )
        )
        and (
          ${table.tombstonedAt} is null
          or (
            ${table.tombstoneRequestedAt} is not null
            and ${table.tombstoneRequestedAt} <= ${table.tombstonedAt}
          )
        )
        and (
          ${table.lastFailureAt} is null
          or ${table.createdAt} <= ${table.lastFailureAt}
        )
        and (
          ${table.lastAuditedAt} is null
          or ${table.createdAt} <= ${table.lastAuditedAt}
        )`,
    ),
    index("idx_room_journal_crypto_publications_reconciliation").on(
      table.state,
      table.updatedAt,
    ),
    index("idx_room_journal_crypto_publications_lease").on(
      table.state,
      table.leaseExpiresAt,
    ),
    index("idx_room_journal_crypto_publications_audit").on(
      table.lastAuditedAt,
    ),
  ],
);

export type RoomJournalState = typeof roomJournalState.$inferSelect;
export type NewRoomJournalState = typeof roomJournalState.$inferInsert;
export type RoomJournalBatch = typeof roomJournalBatches.$inferSelect;
export type NewRoomJournalBatch = typeof roomJournalBatches.$inferInsert;
export type RoomEvent = typeof roomEvents.$inferSelect;
export type NewRoomEvent = typeof roomEvents.$inferInsert;
export type RoomJournalRecordCutover =
  typeof roomJournalRecordCutover.$inferSelect;
export type RoomEventRollup = typeof roomEventRollups.$inferSelect;
export type NewRoomEventRollup = typeof roomEventRollups.$inferInsert;
export type RoomJournalCryptoPublication =
  typeof roomJournalCryptoPublications.$inferSelect;
export type NewRoomJournalCryptoPublication =
  typeof roomJournalCryptoPublications.$inferInsert;
