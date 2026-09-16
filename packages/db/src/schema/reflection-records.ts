import { sql } from "drizzle-orm";
import {
  boolean,
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

export const REFLECTION_RECORD_BYTE_LIMITS = Object.freeze({
  portableId: 128,
  payload: 256 * 1_024,
  requestCommitment: 32,
  authorityCommitment: 32,
  sourceDependencyCommitment: 32,
  semanticAdmissionCommitment: 32,
  sealedCheckpoint: 256 * 1_024,
  failureCode: 64,
});

export const REFLECTION_RECORD_COLLECTION_LIMITS = Object.freeze({
  maximumAttempts: 8,
  leaseSeconds: 2 * 60,
  // Mirrors Reflection's existing durable Record traversal-page maximum.
  repairPageMaximum: 256,
});

export const REFLECTION_RECORD_SEMANTIC_WORK_STAGES = Object.freeze([
  "authority_projection",
  "search_projection",
  "organization",
] as const);

export type ReflectionRecordSemanticWorkStage =
  (typeof REFLECTION_RECORD_SEMANTIC_WORK_STAGES)[number];

export const REFLECTION_RECORD_SEMANTIC_WORK_STATES = Object.freeze([
  "due",
  "claimed",
  "checkpointed",
  "deferred",
  "complete",
  "quarantined",
] as const);

export type ReflectionRecordSemanticWorkState =
  (typeof REFLECTION_RECORD_SEMANTIC_WORK_STATES)[number];

export const REFLECTION_RECORD_SEMANTIC_WORK_ORDINARY_FALLBACK_REASONS =
  Object.freeze([
    "recoverable_availability",
    "key_waiting",
  ] as const);

export type ReflectionRecordSemanticWorkOrdinaryFallbackReason =
  (typeof REFLECTION_RECORD_SEMANTIC_WORK_ORDINARY_FALLBACK_REASONS)[number];

/** Same-generation admission keeps the strongest reason in this order. */
export const REFLECTION_RECORD_SEMANTIC_WORK_CHANGE_REASONS = Object.freeze([
  "scheduled_review",
  "created",
  "revised",
  "dependency_lost",
  "parent_conflict",
] as const);

export type ReflectionRecordSemanticWorkChangeReason =
  (typeof REFLECTION_RECORD_SEMANTIC_WORK_CHANGE_REASONS)[number];

export const REFLECTION_RECORD_SEMANTIC_WORK_FAILURE_CODES = Object.freeze([
  "authority_unavailable",
  "record_unavailable",
  "embedding_unavailable",
  "projection_unavailable",
  "candidate_unavailable",
  "invalid_model_output",
  "publication_unavailable",
  "unexpected_failure",
  "retry_exhausted",
] as const);

export type ReflectionRecordSemanticWorkFailureCode =
  (typeof REFLECTION_RECORD_SEMANTIC_WORK_FAILURE_CODES)[number];

export function nextReflectionRecordSemanticWorkStage(
  stage: ReflectionRecordSemanticWorkStage,
): ReflectionRecordSemanticWorkStage | undefined {
  if (stage === "authority_projection") return "search_projection";
  if (stage === "search_projection") return "organization";
  return undefined;
}

export const REFLECTION_RECORD_SEARCH_PROJECTION_LIMITS = Object.freeze({
  providerText: 256,
  canonicalModelText: 256,
  dimensions: 1_536,
  projectionVersion: 1,
  embeddingContractVersion: 1,
});

const bytea = customType<{
  data: Uint8Array;
  driverData: Uint8Array;
}>({ dataType: () => "bytea" });

const vector = customType<{
  data: number[];
  driverData: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? REFLECTION_RECORD_SEARCH_PROJECTION_LIMITS.dimensions})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: unknown): number[] {
    if (typeof value === "string") return JSON.parse(value) as number[];
    return value as number[];
  },
});

const nautiloProductRole = pgRole("nautilo").existing();

function portableId(name: string, column: AnyPgColumn) {
  return check(
    name,
    sql`octet_length(${column}) between 1 and ${
      sql.raw(String(REFLECTION_RECORD_BYTE_LIMITS.portableId))
    }
      and ${column} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'`,
  );
}

function productPolicy(tableName: string) {
  return pgPolicy(`${tableName}_product_all`, {
    as: "permissive",
    for: "all",
    to: nautiloProductRole,
    using: sql`true`,
    withCheck: sql`true`,
  });
}

/**
 * Opaque durable identity and mutable operational posture for one immutable
 * semantic Record. Semantic bytes live exclusively in the selected payload
 * representation.
 */
export const reflectionRecords = pgTable(
  "reflection_records",
  {
    recordId: text("record_id").primaryKey(),
    lifecycle: text("lifecycle", {
      enum: ["current", "stale", "superseded", "resolved", "sunset"],
    }).notNull(),
    structuralHeight: integer("structural_height").notNull(),
    producerPolicyVersion: text("producer_policy_version").notNull(),
    processingGeneration: integer("processing_generation").notNull(),
    payloadVersion: smallint("payload_version").notNull().default(1),
    disposition: text("disposition", {
      enum: ["available", "blocked", "purged"],
    }).notNull().default("available"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    portableId("reflection_records_id_portable", table.recordId),
    portableId(
      "reflection_records_policy_version_portable",
      table.producerPolicyVersion,
    ),
    check(
      "reflection_records_height_nonnegative",
      sql`${table.structuralHeight} >= 0`,
    ),
    check(
      "reflection_records_lifecycle_closed",
      sql`${table.lifecycle} in ('current', 'stale', 'superseded', 'resolved', 'sunset')`,
    ),
    check(
      "reflection_records_disposition_closed",
      sql`${table.disposition} in ('available', 'blocked', 'purged')`,
    ),
    check(
      "reflection_records_processing_generation_positive",
      sql`${table.processingGeneration} > 0`,
    ),
    check(
      "reflection_records_payload_version_v1",
      sql`${table.payloadVersion} = 1`,
    ),
    index("idx_reflection_records_lifecycle").on(
      table.disposition,
      table.lifecycle,
      table.recordId,
    ),
    productPolicy("reflection_records"),
  ],
).enableRLS();

/** Direct Record-to-Record support edges; source dependencies stay encrypted. */
export const reflectionRecordDependencies = pgTable(
  "reflection_record_dependencies",
  {
    parentRecordId: text("parent_record_id")
      .notNull()
      .references(() => reflectionRecords.recordId, { onDelete: "restrict" }),
    childRecordId: text("child_record_id")
      .notNull()
      .references(() => reflectionRecords.recordId, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({ columns: [table.parentRecordId, table.childRecordId] }),
    check(
      "reflection_record_dependencies_no_self",
      sql`${table.parentRecordId} <> ${table.childRecordId}`,
    ),
    index("idx_reflection_record_dependencies_child").on(
      table.childRecordId,
      table.parentRecordId,
    ),
    productPolicy("reflection_record_dependencies"),
  ],
).enableRLS();

/** Rebuildable reverse projection of authenticated model exposure, not semantic support edges. */
export const reflectionRecordAuthorityDependencies = pgTable(
  "reflection_record_authority_dependencies",
  {
    recordId: text("record_id").notNull()
      .references(() => reflectionRecords.recordId, { onDelete: "restrict" }),
    dependencyRecordId: text("dependency_record_id").notNull()
      .references(() => reflectionRecords.recordId, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({ columns: [table.recordId, table.dependencyRecordId] }),
    check("reflection_record_authority_dependencies_no_self", sql`${table.recordId} <> ${table.dependencyRecordId}`),
    index("idx_reflection_record_authority_dependencies_source").on(table.dependencyRecordId, table.recordId),
    productPolicy("reflection_record_authority_dependencies"),
  ],
).enableRLS();

/** Immutable successor history; one accepted terminal successor wins. */
export const reflectionRecordSuccessors = pgTable(
  "reflection_record_successors",
  {
    predecessorRecordId: text("predecessor_record_id")
      .primaryKey()
      .references(() => reflectionRecords.recordId, { onDelete: "restrict" }),
    successorRecordId: text("successor_record_id")
      .notNull()
      .references(() => reflectionRecords.recordId, { onDelete: "restrict" }),
    relation: text("relation", {
      enum: ["supersedes", "resolves"],
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("uq_reflection_record_successors_successor").on(
      table.successorRecordId,
    ),
    check(
      "reflection_record_successors_no_self",
      sql`${table.predecessorRecordId} <> ${table.successorRecordId}`,
    ),
    check(
      "reflection_record_successors_relation_closed",
      sql`${table.relation} in ('supersedes', 'resolves')`,
    ),
    index("idx_reflection_record_successors_successor").on(
      table.successorRecordId,
      table.predecessorRecordId,
    ),
    productPolicy("reflection_record_successors"),
  ],
).enableRLS();

/** Immutable generation-addressed ordinary or protected payload material. */
export const reflectionRecordPayloadRepresentations = pgTable(
  "reflection_record_payload_representations",
  {
    recordId: text("record_id")
      .notNull()
      .references(() => reflectionRecords.recordId, { onDelete: "restrict" }),
    representation: text("representation", {
      enum: ["ordinary", "protected"],
    }).notNull(),
    representationGeneration: integer("representation_generation").notNull(),
    payloadVersion: smallint("payload_version").notNull().default(1),
    plaintextPayloadBytes: bytea("plaintext_payload_bytes"),
    cryptoObjectId: text("crypto_object_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.recordId,
        table.representation,
        table.representationGeneration,
      ],
    }),
    uniqueIndex("uq_reflection_record_payload_crypto_object")
      .on(table.cryptoObjectId)
      .where(sql`${table.cryptoObjectId} is not null`),
    check(
      "reflection_record_payload_generation_positive",
      sql`${table.representationGeneration} > 0`,
    ),
    check(
      "reflection_record_payload_representation_closed",
      sql`${table.representation} in ('ordinary', 'protected')`,
    ),
    check(
      "reflection_record_payload_version_v1",
      sql`${table.payloadVersion} = 1`,
    ),
    check(
      "reflection_record_payload_shape",
      sql`(
        ${table.representation} = 'ordinary'
        and octet_length(${table.plaintextPayloadBytes}) between 1 and ${
          sql.raw(String(REFLECTION_RECORD_BYTE_LIMITS.payload))
        }
        and ${table.cryptoObjectId} is null
      ) or (
        ${table.representation} = 'protected'
        and ${table.plaintextPayloadBytes} is null
        and ${table.cryptoObjectId} is not null
      )`,
    ),
    portableId(
      "reflection_record_payload_crypto_object_portable",
      table.cryptoObjectId,
    ),
    productPolicy("reflection_record_payload_representations"),
  ],
).enableRLS();

/** One CAS-swappable current head per Record and representation. */
export const reflectionRecordPayloadRepresentationHeads = pgTable(
  "reflection_record_payload_representation_heads",
  {
    recordId: text("record_id").notNull(),
    representation: text("representation", {
      enum: ["ordinary", "protected"],
    }).notNull(),
    currentRepresentationGeneration: integer(
      "current_representation_generation",
    ).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.recordId, table.representation] }),
    foreignKey({
      name: "reflection_record_payload_heads_representation_fk",
      columns: [
        table.recordId,
        table.representation,
        table.currentRepresentationGeneration,
      ],
      foreignColumns: [
        reflectionRecordPayloadRepresentations.recordId,
        reflectionRecordPayloadRepresentations.representation,
        reflectionRecordPayloadRepresentations.representationGeneration,
      ],
    }).onDelete("restrict"),
    check(
      "reflection_record_payload_heads_generation_positive",
      sql`${table.currentRepresentationGeneration} > 0`,
    ),
    check(
      "reflection_record_payload_heads_representation_closed",
      sql`${table.representation} in ('ordinary', 'protected')`,
    ),
    productPolicy("reflection_record_payload_representation_heads"),
  ],
).enableRLS();

/**
 * Content-free replay/recovery receipt. `request_commitment` is a keyed
 * product commitment; an unkeyed semantic content hash is forbidden.
 */
export const reflectionRecordPublications = pgTable(
  "reflection_record_publications",
  {
    publicationId: text("publication_id").primaryKey(),
    recordId: text("record_id").notNull(),
    representation: text("representation", {
      enum: ["ordinary", "protected"],
    }).notNull(),
    representationGeneration: integer("representation_generation").notNull(),
    payloadVersion: smallint("payload_version").notNull().default(1),
    requestCommitment: bytea("request_commitment").notNull(),
    publicationBindingRef: text("publication_binding_ref").notNull(),
    // Optional for legacy receipts; new exact-access publications persist the
    // immutable semantic cohort separately from their current access binding.
    originPublicationBindingRef: text("origin_publication_binding_ref"),
    // Absent on legacy receipts; never infer missing replay structure.
    replayStructuralHeight: integer("replay_structural_height"),
    replayProcessingGeneration: integer("replay_processing_generation"),
    replayPredecessorRecordId: text("replay_predecessor_record_id"),
    replayPredecessorRelation: text("replay_predecessor_relation", { enum: ["supersedes", "resolves"] }),
    // Non-authoritative routing hint for the planned protected output slot.
    // Only cryptoObjectId identifies a verified completed crypto publication.
    reservedCryptoObjectId: text("reserved_crypto_object_id"),
    cryptoObjectId: text("crypto_object_id"),
    state: text("state", {
      enum: [
        "reserved",
        "crypto_complete",
        "product_attached",
        "complete",
        "blocked",
        "quarantined",
        "retry_exhausted",
      ],
    }).notNull(),
    attemptCount: smallint("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    failureCode: text("failure_code", {
      enum: [
        "authorization_unavailable",
        "crypto_absent",
        "crypto_incomplete",
        "crypto_mismatch",
        "integrity_failure",
        "mapping_conflict",
        "storage_transient",
        "retry_exhausted",
        "blocked",
        "purged",
      ],
    }),
    cryptoCompletedAt: timestamp("crypto_completed_at", { withTimezone: true }),
    productAttachedAt: timestamp("product_attached_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cryptoRetiredAt: timestamp("crypto_retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("reflection_record_publications_replay_shape", sql`(
      ${table.replayStructuralHeight} IS NULL AND ${table.replayProcessingGeneration} IS NULL
      AND ${table.replayPredecessorRecordId} IS NULL AND ${table.replayPredecessorRelation} IS NULL
    ) OR (
      ${table.replayStructuralHeight} IS NOT NULL AND ${table.replayStructuralHeight} >= 0
      AND ${table.replayProcessingGeneration} IS NOT NULL AND ${table.replayProcessingGeneration} > 0
      AND ((${table.replayPredecessorRecordId} IS NULL AND ${table.replayPredecessorRelation} IS NULL)
        OR (${table.replayPredecessorRecordId} IS NOT NULL
          AND ${table.replayPredecessorRelation} IS NOT NULL
          AND ${table.replayPredecessorRelation} IN ('supersedes', 'resolves')))
    )`),
    unique("uq_reflection_record_publications_coordinate").on(
      table.recordId,
      table.representation,
      table.representationGeneration,
    ),
    uniqueIndex("uq_reflection_record_publications_crypto_object")
      .on(table.cryptoObjectId)
      .where(sql`${table.cryptoObjectId} is not null`),
    portableId(
      "reflection_record_publications_id_portable",
      table.publicationId,
    ),
    portableId(
      "reflection_record_publications_record_id_portable",
      table.recordId,
    ),
    portableId(
      "reflection_record_publications_binding_portable",
      table.publicationBindingRef,
    ),
    portableId(
      "reflection_record_publications_origin_binding_portable",
      table.originPublicationBindingRef,
    ),
    portableId(
      "reflection_record_publications_crypto_object_portable",
      table.cryptoObjectId,
    ),
    portableId(
      "reflection_record_publications_reserved_crypto_object_portable",
      table.reservedCryptoObjectId,
    ),
    check(
      "reflection_record_publications_generation_positive",
      sql`${table.representationGeneration} > 0`,
    ),
    check(
      "reflection_record_publications_representation_closed",
      sql`${table.representation} in ('ordinary', 'protected')`,
    ),
    check(
      "reflection_record_publications_state_closed",
      sql`${table.state} in (
        'reserved', 'crypto_complete', 'product_attached', 'complete',
        'blocked', 'quarantined', 'retry_exhausted'
      )`,
    ),
    check(
      "reflection_record_publications_payload_version_v1",
      sql`${table.payloadVersion} = 1`,
    ),
    check(
      "reflection_record_publications_commitment_size",
      sql`octet_length(${table.requestCommitment}) = ${
        sql.raw(String(REFLECTION_RECORD_BYTE_LIMITS.requestCommitment))
      }`,
    ),
    check(
      "reflection_record_publications_representation_shape",
      sql`(
        ${table.representation} = 'ordinary'
        and ${table.cryptoObjectId} is null
        and ${table.cryptoRetiredAt} is null
        and ${table.state} = 'complete'
        and ${table.attemptCount} = 0
      ) or (
        ${table.representation} = 'protected'
      )`,
    ),
    check(
      "reflection_record_publications_attempt_bound",
      sql`${table.attemptCount} between 0 and ${
        sql.raw(String(REFLECTION_RECORD_COLLECTION_LIMITS.maximumAttempts))
      }`,
    ),
    check(
      "reflection_record_publications_lease_coherent",
      sql`(${table.leaseToken} is null) = (${table.leaseExpiresAt} is null)`,
    ),
    check(
      "reflection_record_publications_crypto_state_coherent",
      sql`(
        ${table.representation} = 'ordinary'
        and ${table.cryptoCompletedAt} is null
      ) or (
        ${table.representation} = 'protected'
        and (
          (${table.state} = 'reserved'
            and ${table.cryptoObjectId} is null
            and ${table.cryptoCompletedAt} is null)
          or (${table.state} in ('crypto_complete', 'product_attached', 'complete')
            and ${table.cryptoObjectId} is not null
            and ${table.cryptoCompletedAt} is not null)
          or ${table.state} in ('blocked', 'quarantined', 'retry_exhausted')
        )
      )`,
    ),
    check(
      "reflection_record_publications_attachment_coherent",
      sql`(
        ${table.state} in ('reserved', 'crypto_complete')
        and ${table.productAttachedAt} is null
        and ${table.completedAt} is null
      ) or (
        ${table.state} = 'product_attached'
        and ${table.productAttachedAt} is not null
        and ${table.completedAt} is null
      ) or (
        ${table.state} = 'complete'
        and ${table.productAttachedAt} is not null
        and ${table.completedAt} is not null
      ) or (
        ${table.state} in ('blocked', 'quarantined', 'retry_exhausted')
        and ${table.completedAt} is null
      )`,
    ),
    check(
      "reflection_record_publications_failure_coherent",
      sql`(
        ${table.state} in ('blocked', 'quarantined', 'retry_exhausted')
        and ${table.failureCode} is not null
      ) or (
        ${table.state} not in ('blocked', 'quarantined', 'retry_exhausted')
        and ${table.failureCode} is null
      )`,
    ),
    check(
      "reflection_record_publications_terminal_schedule_clear",
      sql`${table.state} not in ('complete', 'blocked', 'quarantined', 'retry_exhausted')
        or (
          ${table.nextAttemptAt} is null
          and ${table.leaseToken} is null
          and ${table.leaseExpiresAt} is null
        )`,
    ),
    check(
      "reflection_record_publications_failure_code_closed",
      sql`${table.failureCode} is null or ${table.failureCode} in (
        'authorization_unavailable', 'crypto_absent', 'crypto_incomplete',
        'crypto_mismatch', 'integrity_failure', 'mapping_conflict',
        'storage_transient', 'retry_exhausted', 'blocked', 'purged'
      )`,
    ),
    check(
      "reflection_record_publications_retirement_coherent",
      sql`${table.cryptoRetiredAt} is null or ${table.cryptoObjectId} is not null`,
    ),
    check(
      "reflection_record_publications_failure_code_bound",
      sql`${table.failureCode} is null or octet_length(${table.failureCode}) <= ${
        sql.raw(String(REFLECTION_RECORD_BYTE_LIMITS.failureCode))
      }`,
    ),
    index("idx_reflection_record_publications_reconcile").on(
      table.state,
      table.nextAttemptAt,
      table.createdAt,
    ),
    index("idx_reflection_record_publications_record").on(
      table.recordId,
      table.representation,
      table.representationGeneration,
    ),
    productPolicy("reflection_record_publications"),
  ],
).enableRLS();

/**
 * Product-keyed, content-free reverse index for authored source dependencies.
 * The commitment is a server-keyed digest, never a raw logical source ID or
 * an unkeyed semantic hash. It lets protected Records be invalidated without
 * decrypting or scanning every payload.
 */
export const reflectionRecordSourceDependencyIndex = pgTable(
  "reflection_record_source_dependency_index",
  {
    sourceDependencyCommitment: bytea("source_dependency_commitment")
      .notNull(),
    recordId: text("record_id")
      .notNull()
      .references(() => reflectionRecords.recordId, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.sourceDependencyCommitment, table.recordId],
    }),
    check(
      "reflection_record_source_dependency_commitment_size",
      sql`octet_length(${table.sourceDependencyCommitment}) = ${
        sql.raw(String(REFLECTION_RECORD_BYTE_LIMITS.sourceDependencyCommitment))
      }`,
    ),
    index("idx_reflection_record_source_dependency_record").on(
      table.recordId,
      table.sourceDependencyCommitment,
    ),
    productPolicy("reflection_record_source_dependency_index"),
  ],
).enableRLS();

/**
 * Content-free replay receipt for one canonical change fact. A server-keyed
 * commitment suppresses replay even after later changes have advanced the
 * coalesced work row; the assigned generation is monotonically unique only
 * within its Record.
 */
export const reflectionRecordSemanticWorkAdmissions = pgTable(
  "reflection_record_semantic_work_admissions",
  {
    recordId: text("record_id")
      .notNull()
      .references(() => reflectionRecords.recordId, { onDelete: "cascade" }),
    admissionCommitment: bytea("admission_commitment").notNull(),
    assignedGeneration: integer("assigned_generation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.recordId, table.admissionCommitment] }),
    unique("uq_reflection_semantic_work_admission_generation").on(
      table.recordId,
      table.assignedGeneration,
    ),
    check(
      "reflection_semantic_work_admission_commitment_size",
      sql`octet_length(${table.admissionCommitment}) = ${
        sql.raw(String(REFLECTION_RECORD_BYTE_LIMITS.semanticAdmissionCommitment))
      }`,
    ),
    check(
      "reflection_semantic_work_admission_generation_positive",
      sql`${table.assignedGeneration} > 0`,
    ),
    productPolicy("reflection_record_semantic_work_admissions"),
  ],
).enableRLS();

/**
 * Durable, content-free cursor for one authored-source change. Canonical
 * source mutation and product semantic admission cannot share a role-bound
 * transaction, so the Server first reserves this HMAC-only fact and the
 * bounded worker advances dependent Records page by page after restarts.
 */
export const reflectionRecordSourceChangeRepairs = pgTable(
  "reflection_record_source_change_repairs",
  {
    sourceChangeCommitment: bytea("source_change_commitment").primaryKey(),
    sourceDependencyCommitment: bytea("source_dependency_commitment")
      .notNull(),
    continuation: text("continuation"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "reflection_source_change_repair_commitment_sizes",
      sql`octet_length(${table.sourceChangeCommitment}) = ${
        sql.raw(String(REFLECTION_RECORD_BYTE_LIMITS.semanticAdmissionCommitment))
      }
        and octet_length(${table.sourceDependencyCommitment}) = ${
        sql.raw(String(REFLECTION_RECORD_BYTE_LIMITS.sourceDependencyCommitment))
      }`,
    ),
    check(
      "reflection_source_change_repair_continuation_bound",
      sql`${table.continuation} is null or (
        octet_length(${table.continuation}) between 1 and ${
          sql.raw(String(REFLECTION_RECORD_BYTE_LIMITS.portableId))
        }
        and ${table.continuation} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
      )`,
    ),
    check(
      "reflection_source_change_repair_completion_coherent",
      sql`${table.completedAt} is null or ${table.updatedAt} = ${table.completedAt}`,
    ),
    index("idx_reflection_source_change_repairs_due").on(
      table.completedAt,
      table.createdAt,
      table.sourceChangeCommitment,
    ),
    productPolicy("reflection_record_source_change_repairs"),
  ],
).enableRLS();

/**
 * Durable cursor for one child-Record lifecycle/disposition change. The
 * changed Record is already an opaque product coordinate, while the keyed
 * commitment makes transition replay exact. Direct parents are admitted in
 * bounded pages; each parent transition reserves the next hop of the cascade.
 */
export const reflectionRecordDependencyChangeRepairs = pgTable(
  "reflection_record_dependency_change_repairs",
  {
    changeCommitment: bytea("change_commitment").primaryKey(),
    changedRecordId: text("changed_record_id")
      .notNull()
      .references(() => reflectionRecords.recordId, { onDelete: "cascade" }),
    continuation: text("continuation"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "reflection_record_dependency_change_repair_commitment_size",
      sql`octet_length(${table.changeCommitment}) = ${
        sql.raw(String(REFLECTION_RECORD_BYTE_LIMITS.semanticAdmissionCommitment))
      }`,
    ),
    check(
      "reflection_record_dependency_change_repair_continuation_bound",
      sql`${table.continuation} is null or (
        octet_length(${table.continuation}) between 1 and ${
          sql.raw(String(REFLECTION_RECORD_BYTE_LIMITS.portableId))
        }
        and ${table.continuation} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
      )`,
    ),
    check(
      "reflection_record_dependency_change_repair_completion_coherent",
      sql`${table.completedAt} is null or ${table.updatedAt} = ${table.completedAt}`,
    ),
    index("idx_reflection_record_dependency_change_repairs_due").on(
      table.completedAt,
      table.createdAt,
      table.changeCommitment,
    ),
    index("idx_reflection_record_dependency_change_repairs_record").on(
      table.changedRecordId,
      table.completedAt,
    ),
    productPolicy("reflection_record_dependency_change_repairs"),
  ],
).enableRLS();

/**
 * One content-free, coalesced semantic work fact per native Record. Each
 * first-seen admission receipt assigns the next generation; a newer admission
 * invalidates an older lease while any replay resolves through its immutable
 * receipt. Stage checkpoints resume authority -> projection -> Organizer.
 */
export const reflectionRecordSemanticWork = pgTable(
  "reflection_record_semantic_work",
  {
    recordId: text("record_id")
      .primaryKey()
      .references(() => reflectionRecords.recordId, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    completedGeneration: integer("completed_generation").notNull().default(0),
    changeReason: text("change_reason", {
      enum: REFLECTION_RECORD_SEMANTIC_WORK_CHANGE_REASONS,
    }).notNull(),
    stage: text("stage", {
      enum: REFLECTION_RECORD_SEMANTIC_WORK_STAGES,
    }).notNull(),
    state: text("state", {
      enum: REFLECTION_RECORD_SEMANTIC_WORK_STATES,
    }).notNull(),
    claimGeneration: integer("claim_generation"),
    attemptCount: smallint("attempt_count").notNull().default(0),
    quarantineRound: integer("quarantine_round").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    recoverAfter: timestamp("recover_after", { withTimezone: true }),
    failureCode: text("failure_code", {
      enum: REFLECTION_RECORD_SEMANTIC_WORK_FAILURE_CODES,
    }),
    ordinaryFallbackReason: text("ordinary_fallback_reason", {
      enum: REFLECTION_RECORD_SEMANTIC_WORK_ORDINARY_FALLBACK_REASONS,
    }),
    dueSince: timestamp("due_since", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** First accepted authority claim for the current generation. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "reflection_record_semantic_work_generations_coherent",
      sql`${table.generation} > 0
        and ${table.completedGeneration} >= 0
        and ${table.completedGeneration} <= ${table.generation}
        and (${table.claimGeneration} is null or ${table.claimGeneration} > 0)`,
    ),
    check(
      "reflection_record_semantic_work_reason_closed_v2",
      sql`${table.changeReason} in (
        'scheduled_review', 'created', 'revised', 'dependency_lost',
        'parent_conflict'
      )`,
    ),
    check(
      "reflection_record_semantic_work_stage_closed",
      sql`${table.stage} in ('authority_projection', 'search_projection', 'organization')`,
    ),
    check(
      "reflection_record_semantic_work_state_closed",
      sql`${table.state} in (
        'due', 'claimed', 'checkpointed', 'deferred', 'complete', 'quarantined'
      )`,
    ),
    check(
      "reflection_record_semantic_work_attempt_bound",
      sql`${table.attemptCount} between 0 and ${
        sql.raw(String(REFLECTION_RECORD_COLLECTION_LIMITS.maximumAttempts))
      }`,
    ),
    check(
      "reflection_record_semantic_work_quarantine_round_bound",
      sql`${table.quarantineRound} >= 0`,
    ),
    check(
      "reflection_record_semantic_work_claim_coherent",
      sql`(
        ${table.state} = 'claimed'
        and ${table.claimGeneration} = ${table.generation}
        and ${table.leaseToken} is not null
        and ${table.leaseExpiresAt} is not null
      ) or (
        ${table.state} <> 'claimed'
        and ${table.claimGeneration} is null
        and ${table.leaseToken} is null
        and ${table.leaseExpiresAt} is null
      )`,
    ),
    check(
      "reflection_record_semantic_work_schedule_coherent",
      sql`(${table.state} in ('due', 'checkpointed', 'deferred'))
        = (${table.nextAttemptAt} is not null)`,
    ),
    check(
      "reflection_record_semantic_work_recovery_coherent",
      sql`(${table.state} = 'quarantined') = (${table.recoverAfter} is not null)
        and (${table.quarantineRound} > 0 or ${table.state} <> 'quarantined')`,
    ),
    check(
      "reflection_record_semantic_work_failure_coherent",
      sql`(${table.state} in ('deferred', 'quarantined'))
        = (${table.failureCode} is not null)`,
    ),
    check(
      "reflection_record_semantic_work_ordinary_fallback_coherent",
      sql`${table.ordinaryFallbackReason} is null or (
        ${table.state} = 'complete'
        and ${table.ordinaryFallbackReason} in (
          'recoverable_availability', 'key_waiting'
        )
      )`,
    ),
    check(
      "reflection_record_semantic_work_failure_code_bound",
      sql`${table.failureCode} is null or (
        octet_length(${table.failureCode}) between 1 and ${
          sql.raw(String(REFLECTION_RECORD_BYTE_LIMITS.failureCode))
        }
        and ${table.failureCode} in (
          'authority_unavailable', 'record_unavailable',
          'embedding_unavailable', 'projection_unavailable',
          'candidate_unavailable', 'invalid_model_output',
          'publication_unavailable', 'unexpected_failure',
          'retry_exhausted'
        )
      )`,
    ),
    check(
      "reflection_record_semantic_work_completion_coherent",
      sql`(
        ${table.state} = 'complete'
        and (
          ${table.stage} = 'organization'
          or ${table.changeReason} = 'parent_conflict'
        )
        and ${table.completedGeneration} = ${table.generation}
        and ${table.completedAt} is not null
      ) or (
        ${table.state} <> 'complete'
        and ${table.completedAt} is null
      )`,
    ),
    check(
      "reflection_record_semantic_work_started_coherent",
      sql`${table.startedAt} is null or ${table.startedAt} >= ${table.dueSince}`,
    ),
    check(
      "reflection_record_semantic_work_checkpoint_coherent",
      sql`${table.state} <> 'checkpointed'
        or ${table.stage} in ('search_projection', 'organization')`,
    ),
    check(
      "reflection_record_semantic_work_due_starts_authority",
      sql`${table.state} <> 'due' or ${table.stage} = 'authority_projection'`,
    ),
    index("idx_reflection_record_semantic_work_due").on(
      table.state,
      table.nextAttemptAt,
      table.dueSince,
      table.recordId,
    ),
    index("idx_reflection_record_semantic_work_lease").on(
      table.state,
      table.leaseExpiresAt,
      table.recordId,
    ),
    index("idx_reflection_record_semantic_work_recovery").on(
      table.state,
      table.recoverAfter,
      table.dueSince,
      table.recordId,
    ),
    index("idx_reflection_record_semantic_work_health").on(
      table.state,
      table.attemptCount,
      table.dueSince,
    ),
    productPolicy("reflection_record_semantic_work"),
  ],
).enableRLS();

/** Rebuildable complete terminal-authority closure and opaque reverse index. */
export const reflectionRecordAuthorityClosure = pgTable(
  "reflection_record_authority_closure",
  {
    recordId: text("record_id")
      .notNull()
      .references(() => reflectionRecords.recordId, { onDelete: "cascade" }),
    terminalLeafHandle: text("terminal_leaf_handle").notNull(),
    closureGeneration: integer("closure_generation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.recordId,
        table.closureGeneration,
        table.terminalLeafHandle,
      ],
    }),
    portableId(
      "reflection_record_authority_closure_leaf_portable",
      table.terminalLeafHandle,
    ),
    check(
      "reflection_record_authority_closure_generation_positive",
      sql`${table.closureGeneration} > 0`,
    ),
    index("idx_reflection_record_authority_closure_reverse").on(
      table.terminalLeafHandle,
      table.recordId,
      table.closureGeneration,
    ),
    index("idx_reflection_record_authority_closure_record").on(
      table.recordId,
      table.closureGeneration,
      table.terminalLeafHandle,
    ),
    productPolicy("reflection_record_authority_closure"),
  ],
).enableRLS();

/** One complete immutable audience generation; only one generation is current. */
export const reflectionRecordAuthorityProjections = pgTable(
  "reflection_record_authority_projections",
  {
    recordId: text("record_id")
      .notNull()
      .references(() => reflectionRecords.recordId, { onDelete: "cascade" }),
    projectionGeneration: integer("projection_generation").notNull(),
    sourceChangeGeneration: integer("source_change_generation").notNull(),
    processingState: text("processing_state", {
      enum: ["current", "dirty", "reconciling", "unavailable", "purged"],
    }).notNull(),
    unavailableReason: text("unavailable_reason", {
      enum: [
        "no_authority_leaves",
        "no_effective_audience",
        "source_unavailable",
        "representation_capacity_exceeded",
      ],
    }),
    audienceSetCommitment: bytea("audience_set_commitment"),
    current: boolean("current").notNull().default(false),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    dirtySince: timestamp("dirty_since", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.recordId, table.projectionGeneration] }),
    uniqueIndex("uq_reflection_record_authority_projection_current")
      .on(table.recordId)
      .where(sql`${table.current} = true`),
    check(
      "reflection_record_authority_projection_generation_positive",
      sql`${table.projectionGeneration} > 0 and ${table.sourceChangeGeneration} > 0`,
    ),
    check(
      "reflection_record_authority_projection_state_closed",
      sql`${table.processingState} in ('current', 'dirty', 'reconciling', 'unavailable', 'purged')`,
    ),
    check(
      "reflection_record_authority_projection_unavailable_coherent",
      sql`(
        ${table.processingState} = 'unavailable'
        and ${table.unavailableReason} is not null
      ) or (
        ${table.processingState} <> 'unavailable'
        and ${table.unavailableReason} is null
      )`,
    ),
    check(
      "reflection_record_authority_projection_commitment_size",
      sql`${table.audienceSetCommitment} is null or octet_length(${table.audienceSetCommitment}) = ${
        sql.raw(String(REFLECTION_RECORD_BYTE_LIMITS.authorityCommitment))
      }`,
    ),
    check(
      "reflection_record_authority_projection_dirty_time_coherent",
      sql`(${table.processingState} in ('dirty', 'reconciling')) = (${table.dirtySince} is not null)`,
    ),
    index("idx_reflection_record_authority_projection_health").on(
      table.current,
      table.processingState,
      table.dirtySince,
      table.recordId,
    ),
    productPolicy("reflection_record_authority_projections"),
  ],
).enableRLS();

/** Exact normalized audience alternatives for one all-or-nothing generation. */
export const reflectionRecordAuthorityAlternatives = pgTable(
  "reflection_record_authority_alternatives",
  {
    recordId: text("record_id").notNull(),
    projectionGeneration: integer("projection_generation").notNull(),
    alternativeOrdinal: smallint("alternative_ordinal").notNull(),
    // Deliberately no FK: Human/Room hard deletion must not be obstructed by
    // a rebuildable projection. A missing Namespace fails eligibility closed
    // and reconciliation repairs the projection.
    accessNamespaceId: uuid("access_namespace_id").notNull(),
    includesPublicBoundary: boolean("includes_public_boundary")
      .notNull()
      .default(false),
    alternativeCommitment: bytea("alternative_commitment").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.recordId,
        table.projectionGeneration,
        table.alternativeOrdinal,
      ],
    }),
    foreignKey({
      name: "reflection_record_authority_alternatives_projection_fk",
      columns: [table.recordId, table.projectionGeneration],
      foreignColumns: [
        reflectionRecordAuthorityProjections.recordId,
        reflectionRecordAuthorityProjections.projectionGeneration,
      ],
    }).onDelete("cascade"),
    unique(
      "uq_reflection_record_authority_alternative_namespace_public",
    ).on(
      table.recordId,
      table.projectionGeneration,
      table.accessNamespaceId,
      table.includesPublicBoundary,
    ),
    check(
      "reflection_record_authority_alternative_ordinal_bound",
      sql`${table.alternativeOrdinal} between 0 and 255`,
    ),
    check(
      "reflection_record_authority_alternative_commitment_size",
      sql`octet_length(${table.alternativeCommitment}) = ${
        sql.raw(String(REFLECTION_RECORD_BYTE_LIMITS.authorityCommitment))
      }`,
    ),
    index("idx_reflection_record_authority_alternative_eligibility").on(
      table.accessNamespaceId,
      table.includesPublicBoundary,
      table.recordId,
      table.projectionGeneration,
      table.alternativeOrdinal,
    ),
    productPolicy("reflection_record_authority_alternatives"),
  ],
).enableRLS();

/** Durable canonical source-authority change admission, keyed only by opaque handle. */
export const reflectionRecordAuthorityChanges = pgTable(
  "reflection_record_authority_changes",
  {
    changeId: text("change_id").primaryKey(),
    terminalLeafHandle: text("terminal_leaf_handle").notNull(),
    sourceChangeGeneration: integer("source_change_generation").notNull(),
    admittedAt: timestamp("admitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    portableId("reflection_record_authority_changes_id_portable", table.changeId),
    portableId(
      "reflection_record_authority_changes_leaf_portable",
      table.terminalLeafHandle,
    ),
    unique("uq_reflection_record_authority_change_leaf_generation").on(
      table.terminalLeafHandle,
      table.sourceChangeGeneration,
    ),
    check(
      "reflection_record_authority_change_generation_positive",
      sql`${table.sourceChangeGeneration} > 0`,
    ),
    index("idx_reflection_record_authority_changes_leaf").on(
      table.terminalLeafHandle,
      table.sourceChangeGeneration,
    ),
    productPolicy("reflection_record_authority_changes"),
  ],
).enableRLS();

/** Bounded, content-free reconciliation receipt; checkpoints must be sealed. */
export const reflectionRecordAuthorityReconciliations = pgTable(
  "reflection_record_authority_reconciliations",
  {
    reconciliationId: text("reconciliation_id").primaryKey(),
    recordId: text("record_id")
      .notNull()
      .references(() => reflectionRecords.recordId, { onDelete: "cascade" }),
    expectedProjectionGeneration: integer(
      "expected_projection_generation",
    ).notNull(),
    sourceChangeGeneration: integer("source_change_generation").notNull(),
    state: text("state", {
      enum: ["pending", "leased", "crypto_complete", "attached", "complete", "quarantined"],
    }).notNull(),
    sealedCheckpoint: bytea("sealed_checkpoint"),
    attemptCount: smallint("attempt_count").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    targetRepresentationGeneration: integer(
      "target_representation_generation",
    ),
    targetCryptoObjectId: text("target_crypto_object_id"),
    /** Exact access materialization retained for deterministic protected replay. */
    targetAccessNamespaceIds: text("target_access_namespace_ids").array(),
    targetAudienceSetCommitment: bytea("target_audience_set_commitment"),
    targetCryptoRetiredAt: timestamp("target_crypto_retired_at", { withTimezone: true }),
    formerCryptoObjectId: text("former_crypto_object_id"),
    formerCryptoRetiredAt: timestamp("former_crypto_retired_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    portableId(
      "reflection_record_authority_reconciliations_id_portable",
      table.reconciliationId,
    ),
    portableId(
      "reflection_record_authority_reconciliations_crypto_object_portable",
      table.targetCryptoObjectId,
    ),
    portableId(
      "reflection_record_authority_reconciliations_former_crypto_object_portable",
      table.formerCryptoObjectId,
    ),
    unique("uq_reflection_record_authority_reconciliation_generation").on(
      table.recordId,
      table.sourceChangeGeneration,
    ),
    check(
      "reflection_record_authority_reconciliation_generations_positive",
      sql`${table.expectedProjectionGeneration} >= 0 and ${table.sourceChangeGeneration} > 0
        and (${table.targetRepresentationGeneration} is null or ${table.targetRepresentationGeneration} > 0)`,
    ),
    check(
      "reflection_record_authority_reconciliation_state_closed",
      sql`${table.state} in ('pending', 'leased', 'crypto_complete', 'attached', 'complete', 'quarantined')`,
    ),
    check(
      "reflection_record_authority_reconciliation_attempt_bound",
      sql`${table.attemptCount} between 0 and ${
        sql.raw(String(REFLECTION_RECORD_COLLECTION_LIMITS.maximumAttempts))
      }`,
    ),
    check(
      "reflection_record_authority_reconciliation_lease_coherent",
      sql`(${table.leaseToken} is null) = (${table.leaseExpiresAt} is null)
        and (${table.state} = 'leased') = (${table.leaseToken} is not null)`,
    ),
    check(
      "reflection_record_authority_reconciliation_checkpoint_bound",
      sql`${table.sealedCheckpoint} is null or octet_length(${table.sealedCheckpoint}) between 1 and ${
        sql.raw(String(REFLECTION_RECORD_BYTE_LIMITS.sealedCheckpoint))
      }`,
    ),
    check(
      "reflection_record_authority_reconciliation_failure_code_closed",
      sql`${table.failureCode} is null or (
        octet_length(${table.failureCode}) between 1 and ${
          sql.raw(String(REFLECTION_RECORD_BYTE_LIMITS.failureCode))
        }
        and ${table.failureCode} in (
          'authorization_unavailable', 'integrity_failure', 'mapping_conflict',
          'source_unavailable', 'storage_transient'
        )
      )`,
    ),
    check(
      "reflection_record_authority_reconciliation_completion_coherent",
      sql`(${table.state} = 'complete' and ${table.completedAt} is not null)
        or (${table.state} <> 'complete' and (${table.completedAt} is null
          or (${table.targetCryptoObjectId} is not null and ${table.state} in ('crypto_complete', 'attached', 'quarantined'))))`,
    ),
    check(
      "reflection_record_authority_reconciliation_crypto_coherent",
      sql`(
        ${table.targetCryptoObjectId} is null
        and ${table.targetRepresentationGeneration} is null
      ) or (
        ${table.targetCryptoObjectId} is not null
        and ${table.targetRepresentationGeneration} is not null
      )`,
    ),
    check(
      "reflection_record_authority_reconciliation_retirement_coherent",
      sql`${table.formerCryptoRetiredAt} is null or ${table.formerCryptoObjectId} is not null`,
    ),
    check(
      "reflection_record_authority_reconciliation_target_access_coherent",
      sql`(${table.targetAccessNamespaceIds} is null and ${table.targetAudienceSetCommitment} is null)
        or (${table.targetCryptoObjectId} is not null
          and ${table.targetAccessNamespaceIds} is not null
          and ${table.targetAudienceSetCommitment} is not null
          and cardinality(${table.targetAccessNamespaceIds}) between 1 and 256
          and array_position(${table.targetAccessNamespaceIds}, null) is null
          and octet_length(${table.targetAudienceSetCommitment}) = 32)`,
    ),
    check(
      "reflection_record_authority_reconciliation_target_retirement_coherent",
      sql`${table.targetCryptoRetiredAt} is null or
        (${table.targetCryptoObjectId} is not null and ${table.state} = 'quarantined')`,
    ),
    index("idx_reflection_record_authority_reconciliation_due").on(
      table.state,
      table.nextAttemptAt,
      table.createdAt,
      table.reconciliationId,
    ),
    index("idx_reflection_record_authority_reconciliation_record").on(
      table.recordId,
      table.sourceChangeGeneration,
    ),
    productPolicy("reflection_record_authority_reconciliations"),
  ],
).enableRLS();

/** Immediate fail-closed Record or opaque-leaf disposition. */
export const reflectionRecordAuthorityBlocks = pgTable(
  "reflection_record_authority_blocks",
  {
    blockId: text("block_id").primaryKey(),
    recordId: text("record_id").references(() => reflectionRecords.recordId, {
      onDelete: "cascade",
    }),
    terminalLeafHandle: text("terminal_leaf_handle"),
    disposition: text("disposition", {
      enum: ["blocked", "purged"],
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    portableId("reflection_record_authority_blocks_id_portable", table.blockId),
    portableId(
      "reflection_record_authority_blocks_leaf_portable",
      table.terminalLeafHandle,
    ),
    check(
      "reflection_record_authority_blocks_exact_target",
      sql`(${table.recordId} is null) <> (${table.terminalLeafHandle} is null)`,
    ),
    check(
      "reflection_record_authority_blocks_disposition_closed",
      sql`${table.disposition} in ('blocked', 'purged')`,
    ),
    uniqueIndex("uq_reflection_record_authority_blocks_record")
      .on(table.recordId)
      .where(sql`${table.recordId} is not null`),
    uniqueIndex("uq_reflection_record_authority_blocks_leaf")
      .on(table.terminalLeafHandle)
      .where(sql`${table.terminalLeafHandle} is not null`),
    index("idx_reflection_record_authority_blocks_leaf_lookup").on(
      table.terminalLeafHandle,
      table.disposition,
    ),
    productPolicy("reflection_record_authority_blocks"),
  ],
).enableRLS();

/**
 * Deliberately plaintext, rebuildable semantic-search projection. This is the
 * only Wave-6 disclosure exception and contains no statement or source data.
 */
export const reflectionRecordSearchProjections = pgTable(
  "reflection_record_search_projections",
  {
    recordId: text("record_id")
      .primaryKey()
      .references(() => reflectionRecords.recordId, { onDelete: "cascade" }),
    recordProcessingGeneration: integer(
      "record_processing_generation",
    ).notNull(),
    projectionVersion: smallint("projection_version").notNull().default(1),
    projectionGeneration: integer("projection_generation").notNull(),
    embeddingProvider: text("embedding_provider").notNull(),
    embeddingCanonicalModel: text("embedding_canonical_model").notNull(),
    embeddingDimensions: smallint("embedding_dimensions").notNull(),
    embeddingContractVersion: smallint(
      "embedding_contract_version",
    ).notNull(),
    embedding: vector("embedding", {
      dimensions: REFLECTION_RECORD_SEARCH_PROJECTION_LIMITS.dimensions,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    portableId(
      "reflection_record_search_projections_record_id_portable",
      table.recordId,
    ),
    check(
      "reflection_record_search_projections_generations_positive",
      sql`${table.recordProcessingGeneration} > 0 and ${table.projectionGeneration} > 0`,
    ),
    check(
      "reflection_record_search_projections_version_v1",
      sql`${table.projectionVersion} = ${
        sql.raw(String(REFLECTION_RECORD_SEARCH_PROJECTION_LIMITS.projectionVersion))
      }`,
    ),
    check(
      "reflection_record_search_projections_provider_bounded",
      sql`octet_length(${table.embeddingProvider}) between 1 and ${
        sql.raw(String(REFLECTION_RECORD_SEARCH_PROJECTION_LIMITS.providerText))
      }
        and ${table.embeddingProvider} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'`,
    ),
    check(
      "reflection_record_search_projections_model_bounded",
      sql`octet_length(${table.embeddingCanonicalModel}) between 1 and ${
        sql.raw(String(REFLECTION_RECORD_SEARCH_PROJECTION_LIMITS.canonicalModelText))
      }
        and ${table.embeddingCanonicalModel} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'`,
    ),
    check(
      "reflection_record_search_projections_dimensions_v1",
      sql`${table.embeddingDimensions} = ${
        sql.raw(String(REFLECTION_RECORD_SEARCH_PROJECTION_LIMITS.dimensions))
      }
        and vector_dims(${table.embedding}) = ${
          sql.raw(String(REFLECTION_RECORD_SEARCH_PROJECTION_LIMITS.dimensions))
        }
        and vector_norm(${table.embedding}) > 0`,
    ),
    check(
      "reflection_record_search_projections_contract_v1",
      sql`${table.embeddingContractVersion} = ${
        sql.raw(String(REFLECTION_RECORD_SEARCH_PROJECTION_LIMITS.embeddingContractVersion))
      }`,
    ),
    index("idx_reflection_record_search_projections_provenance").on(
      table.projectionVersion,
      table.embeddingContractVersion,
      table.embeddingProvider,
      table.embeddingCanonicalModel,
      table.embeddingDimensions,
      table.recordId,
    ),
    index("idx_reflection_record_search_projections_record").on(
      table.recordId,
      table.recordProcessingGeneration,
      table.projectionGeneration,
    ),
    productPolicy("reflection_record_search_projections"),
  ],
).enableRLS();

export const REFLECTION_RECORD_TABLES = Object.freeze([
  reflectionRecords,
  reflectionRecordDependencies,
  reflectionRecordAuthorityDependencies,
  reflectionRecordSuccessors,
  reflectionRecordPayloadRepresentations,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPublications,
  reflectionRecordSourceDependencyIndex,
  reflectionRecordSemanticWorkAdmissions,
  reflectionRecordSourceChangeRepairs,
  reflectionRecordDependencyChangeRepairs,
  reflectionRecordSemanticWork,
  reflectionRecordAuthorityClosure,
  reflectionRecordAuthorityProjections,
  reflectionRecordAuthorityAlternatives,
  reflectionRecordAuthorityChanges,
  reflectionRecordAuthorityReconciliations,
  reflectionRecordAuthorityBlocks,
  reflectionRecordSearchProjections,
] as const);
