import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const nautiloProductRole = pgRole("nautilo").existing();
const nautiloAgentRole = pgRole("nautilo_agent").existing();
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

export const ENCRYPTION_TRANSITION_MODES = [
  "plaintext_only",
  "shadow_encryption",
  "encrypted_only",
] as const;

export type EncryptionTransitionMode =
  (typeof ENCRYPTION_TRANSITION_MODES)[number];

export const ENCRYPTION_TRANSITION_SHADOW_BEHAVIORS = [
  "fallback",
  "strict",
] as const;
export type EncryptionTransitionShadowBehavior =
  (typeof ENCRYPTION_TRANSITION_SHADOW_BEHAVIORS)[number];

export const STRICT_SHADOW_BOUNDARY_STATES = [
  "verified",
  "waiting_for_authority",
  "repairing",
  "unsupported",
  "failed",
] as const;
export type StrictShadowBoundaryState =
  (typeof STRICT_SHADOW_BOUNDARY_STATES)[number];

export const STRICT_SHADOW_BOUNDARY_ACTOR_CLASSES = [
  "human",
  "agent",
  "conductor",
  "tool",
  "background",
] as const;
export type StrictShadowBoundaryActorClass =
  (typeof STRICT_SHADOW_BOUNDARY_ACTOR_CLASSES)[number];

export const STRICT_SHADOW_BOUNDARY_REASONS = [
  "none",
  "device_membership_converging",
  "domain_authority_converging",
  "namespace_authority_converging",
  "missing_protected_sibling",
  "unsupported_operation",
  "device_not_enrolled",
  "device_stale",
  "device_removed",
  "recovery_required",
  "authority_unrecoverable",
  "integrity_failure",
  "parity_mismatch",
  "publication_failure",
  "deadline_expired",
  "stale_authority",
  "unknown_boundary",
  "unknown_result",
] as const;
export type StrictShadowBoundaryReason =
  (typeof STRICT_SHADOW_BOUNDARY_REASONS)[number];

/**
 * Reviewed server-wide M274 v1 operational contract, not caller- or
 * operator-configurable: hourly buckets support operational latency review,
 * 30 days is a maximum bucket age, 10,000 rows is the earlier hard storage
 * cap, and fixed latency boundaries cover foreground work through the 30s
 * failure ceiling. Cumulative current-epoch outcome totals are separate, so
 * cap pruning never weakens attempt-success accounting. A later measured
 * revision must be durable, never an ad-hoc writer input.
 */
export const ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1 = {
  revision: 1,
  bucketWidthMs: 60 * 60 * 1_000,
  retentionMs: 30 * 24 * 60 * 60 * 1_000,
  storageLimitRows: 10_000,
  latencyUpperBoundsMs: [
    50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
  ],
} as const;

/**
 * M274 — deployment-neutral, server-wide encryption transition authority.
 *
 * M282 replaces the split write/read transition with one causal
 * `shadow_encryption` mode. `encrypted_only` remains reserved until a later
 * cutover milestone can prove the complete adjacent vertical.
 */
export const encryptionTransitionPolicy = pgTable(
  "encryption_transition_policy",
  {
    id: text("id").primaryKey().default("server"),
    mode: text("mode", { enum: ENCRYPTION_TRANSITION_MODES })
      .notNull()
      .default("plaintext_only"),
    shadowBehavior: text("shadow_behavior", {
      enum: ENCRYPTION_TRANSITION_SHADOW_BEHAVIORS,
    }).notNull().default("fallback"),
    revision: integer("revision").notNull().default(0),
    /** Epoch for the current transition attempt denominator. */
    shadowEncryptionStartedAt: timestamp("shadow_encryption_started_at", {
      withTimezone: true,
    }),
    /** Fixed reviewed M274 v1 projection policy; not operator-configurable. */
    observationBoundsRevision: integer("observation_bounds_revision")
      .notNull()
      .default(ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.revision),
    observationBucketWidthMs: bigint("observation_bucket_width_ms", {
      mode: "number",
    }).notNull().default(
      ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.bucketWidthMs,
    ),
    observationRetentionMs: bigint("observation_retention_ms", {
      mode: "number",
    }).notNull().default(
      ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.retentionMs,
    ),
    observationStorageLimitRows: integer("observation_storage_limit_rows")
      .notNull()
      .default(ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.storageLimitRows),
    observationLatencyUpperBoundsMs: integer(
      "observation_latency_upper_bounds_ms",
    ).array().notNull().default(sql`ARRAY[
      50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000
    ]::integer[]`),
    observationBoundsConfiguredAt: timestamp(
      "observation_bounds_configured_at",
      { withTimezone: true },
    ).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("encryption_transition_policy_singleton", sql`${table.id} = 'server'`),
    check(
      "encryption_transition_policy_mode_check",
      sql`${table.mode} in ('plaintext_only', 'shadow_encryption', 'encrypted_only')`,
    ),
    check(
      "encryption_transition_policy_shadow_behavior_check",
      sql`${table.shadowBehavior} in ('fallback', 'strict')
        and (${table.mode} <> 'plaintext_only' or ${table.shadowBehavior} = 'fallback')`,
    ),
    check(
      "encryption_transition_policy_revision_nonnegative",
      sql`${table.revision} >= 0`,
    ),
    check(
      "encryption_transition_policy_shadow_epoch_coherent",
      sql`(${table.mode} = 'plaintext_only' and ${table.shadowEncryptionStartedAt} is null)
        or (${table.mode} <> 'plaintext_only' and ${table.shadowEncryptionStartedAt} is not null)`,
    ),
    check(
      "encryption_transition_policy_observation_bounds_coherent",
      sql`${table.observationBoundsRevision} = 1
        and ${table.observationBucketWidthMs} = 3600000
        and ${table.observationRetentionMs} = 2592000000
        and ${table.observationStorageLimitRows} = 10000
        and ${table.observationLatencyUpperBoundsMs} = ARRAY[
          50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000
        ]::integer[]
        and ${table.observationBoundsConfiguredAt} is not null`,
    ),
    pgPolicy("encryption_transition_policy_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("encryption_transition_policy_agent_select", {
      as: "permissive",
      for: "select",
      to: nautiloAgentRole,
      using: sql`true`,
    }),
  ],
).enableRLS();

/**
 * Fixed-cardinality current signal for the reviewed Strict Shadow registry.
 * Writers validate boundary IDs against the executable registry before this
 * upsert; the database retains one content-free latest row per policy epoch
 * and boundary, never one row per product object or attempt.
 */
export const encryptionTransitionBoundaryHealth = pgTable(
  "encryption_transition_boundary_health",
  {
    policyRevision: integer("policy_revision").notNull(),
    boundaryId: text("boundary_id").notNull(),
    family: text("family").notNull(),
    operation: text("operation").notNull(),
    actorClass: text("actor_class", {
      enum: STRICT_SHADOW_BOUNDARY_ACTOR_CLASSES,
    }).notNull(),
    state: text("state", { enum: STRICT_SHADOW_BOUNDARY_STATES }).notNull(),
    reason: text("reason", { enum: STRICT_SHADOW_BOUNDARY_REASONS }).notNull(),
    retryable: boolean("retryable").notNull(),
    occurrenceCount: bigint("occurrence_count", { mode: "bigint" })
      .notNull().default(sql`1`),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true })
      .notNull().defaultNow(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true })
      .notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "encryption_transition_boundary_health_pk",
      columns: [table.policyRevision, table.boundaryId],
    }),
    index("idx_encryption_transition_boundary_health_latest")
      .on(table.policyRevision, table.lastObservedAt),
    check(
      "encryption_transition_boundary_health_shape",
      sql`${table.policyRevision} > 0
        and length(${table.boundaryId}) between 1 and 256
        and length(${table.family}) between 1 and 64
        and length(${table.operation}) between 1 and 64
        and ${table.actorClass} in ('human', 'agent', 'conductor', 'tool', 'background')
        and ${table.state} in ('verified', 'waiting_for_authority', 'repairing', 'unsupported', 'failed')
        and ${table.reason} in (
          'none', 'device_membership_converging',
          'domain_authority_converging', 'namespace_authority_converging',
          'missing_protected_sibling', 'unsupported_operation',
          'device_not_enrolled', 'device_stale', 'device_removed',
          'recovery_required', 'authority_unrecoverable',
          'integrity_failure', 'parity_mismatch', 'publication_failure',
          'deadline_expired',
          'stale_authority', 'unknown_boundary', 'unknown_result'
        )
        and ${table.occurrenceCount} > 0
        and ${table.lastObservedAt} >= ${table.firstObservedAt}
        and ((${table.state} = 'verified') = (${table.reason} = 'none'))
        and (${table.state} not in ('waiting_for_authority', 'repairing') or ${table.retryable})`,
    ),
    pgPolicy("encryption_transition_boundary_health_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

export const ENCRYPTION_TRANSITION_FAMILIES = [
  "message",
  "memory",
  "artifact",
  "record",
] as const;
export type EncryptionTransitionFamily =
  (typeof ENCRYPTION_TRANSITION_FAMILIES)[number];

export const ENCRYPTION_TRANSITION_OPERATIONS = [
  "create",
  "update",
  "access_update",
  "read",
  "read_repair",
  "unsupported",
] as const;
export type EncryptionTransitionOperation =
  (typeof ENCRYPTION_TRANSITION_OPERATIONS)[number];

export const ENCRYPTION_TRANSITION_OUTCOMES = [
  "verified",
  "pending",
  "reconciling",
  "unavailable",
  "failed",
] as const;
export type EncryptionTransitionOutcome =
  (typeof ENCRYPTION_TRANSITION_OUTCOMES)[number];

export const ENCRYPTION_TRANSITION_REASONS = [
  "none",
  "response_lost",
  "client_observation_expired",
  "unmigrated",
  "unsupported_operation",
  "client_crypto_unavailable",
  "client_crypto_preparation_failed",
  "client_custody_unavailable",
  "current_read_authority_unavailable",
  "retained_key_material_unavailable",
  "signer_evidence_unavailable",
  "live_shadow_lifecycle_unavailable",
  "namespace_encryption_not_ready",
  "stale_authority_product",
  "parity_mismatch",
  "integrity_failure",
  "publication_failure",
] as const;
export type EncryptionTransitionReason =
  (typeof ENCRYPTION_TRANSITION_REASONS)[number];

/**
 * Bounded, non-authoritative aggregate observations. Rows contain no exact
 * product or authority coordinates. The query layer requires an explicit,
 * reviewed v1 bounds policy for bucket width, retention, latency boundaries
 * and maximum row count. Writers cannot supply alternate bucket identities.
 */
export const encryptionTransitionObservationBuckets = pgTable(
  "encryption_transition_observation_buckets",
  {
    /** Exact server policy revision that owns this Shadow attempt epoch. */
    policyRevision: integer("policy_revision").notNull(),
    bucketStartedAt: timestamp("bucket_started_at", { withTimezone: true })
      .notNull(),
    boundsRevision: integer("bounds_revision").notNull(),
    bucketWidthMs: bigint("bucket_width_ms", { mode: "number" }).notNull(),
    family: text("family", { enum: ENCRYPTION_TRANSITION_FAMILIES }).notNull(),
    operation: text("operation", {
      enum: ENCRYPTION_TRANSITION_OPERATIONS,
    }).notNull(),
    outcome: text("outcome", { enum: ENCRYPTION_TRANSITION_OUTCOMES }).notNull(),
    reason: text("reason", { enum: ENCRYPTION_TRANSITION_REASONS }).notNull(),
    /** Index into caller-supplied measured latency boundaries. */
    latencyBucket: integer("latency_bucket").notNull(),
    attemptCount: bigint("attempt_count", { mode: "bigint" })
      .notNull()
      .default(sql`1`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "encryption_transition_observation_buckets_pk",
      columns: [
        table.policyRevision,
        table.bucketStartedAt,
        table.boundsRevision,
        table.bucketWidthMs,
        table.family,
        table.operation,
        table.outcome,
        table.reason,
        table.latencyBucket,
      ],
    }),
    index("idx_encryption_transition_observations_prune")
      .on(table.bucketStartedAt),
    check(
      "encryption_transition_observations_family_check",
      sql`${table.family} in ('message', 'memory', 'artifact', 'record')`,
    ),
    check(
      "encryption_transition_observations_operation_check",
      sql`${table.operation} in ('create', 'update', 'access_update', 'read', 'read_repair', 'unsupported')`,
    ),
    check(
      "encryption_transition_observations_outcome_reason_coherent",
      sql`(
        (${table.outcome} in ('verified', 'pending') and ${table.reason} = 'none')
        or (${table.outcome} = 'reconciling' and ${table.reason} = 'response_lost')
        or (${table.outcome} = 'unavailable' and ${table.reason} in (
          'unmigrated', 'unsupported_operation', 'client_crypto_unavailable',
          'client_crypto_preparation_failed', 'client_custody_unavailable',
          'current_read_authority_unavailable',
          'retained_key_material_unavailable', 'signer_evidence_unavailable',
          'live_shadow_lifecycle_unavailable',
          'namespace_encryption_not_ready', 'stale_authority_product',
          'client_observation_expired'
        ))
        or (${table.outcome} = 'failed' and ${table.reason} in (
          'parity_mismatch', 'integrity_failure', 'publication_failure'
        ))
      ) and (
        (${table.operation} = 'unsupported' and ${table.reason} = 'unsupported_operation')
        or (${table.operation} <> 'unsupported' and ${table.reason} <> 'unsupported_operation')
      ) and (
        ${table.operation} <> 'read'
        or (${table.family} in ('message', 'memory')
          and ${table.outcome} in ('verified', 'unavailable', 'failed')
          and ${table.reason} in (
            'none', 'client_crypto_unavailable', 'client_custody_unavailable',
            'current_read_authority_unavailable',
            'retained_key_material_unavailable', 'signer_evidence_unavailable',
            'live_shadow_lifecycle_unavailable', 'client_observation_expired',
            'integrity_failure', 'parity_mismatch'
          ))
      ) and (
        ${table.reason} not in (
          'current_read_authority_unavailable',
          'retained_key_material_unavailable', 'signer_evidence_unavailable',
          'live_shadow_lifecycle_unavailable'
        ) or ${table.operation} = 'read'
      )`,
    ),
    check(
      "encryption_transition_observations_bucket_shape",
      sql`${table.policyRevision} > 0
        and ${table.boundsRevision} > 0
        and ${table.bucketWidthMs} > 0
        and ${table.latencyBucket} >= 0`,
    ),
    check(
      "encryption_transition_observations_count_positive",
      sql`${table.attemptCount} > 0`,
    ),
    pgPolicy("encryption_transition_observations_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

/**
 * Fixed-cardinality current-epoch totals. Latency buckets are prunable, but
 * the Admin claim "since Shadow writes began" is derived from these rows and
 * therefore remains exact for the entire active policy revision.
 */
export const encryptionTransitionOutcomeTotals = pgTable(
  "encryption_transition_outcome_totals",
  {
    policyRevision: integer("policy_revision").notNull(),
    family: text("family", { enum: ENCRYPTION_TRANSITION_FAMILIES }).notNull(),
    operation: text("operation", {
      enum: ENCRYPTION_TRANSITION_OPERATIONS,
    }).notNull(),
    outcome: text("outcome", { enum: ENCRYPTION_TRANSITION_OUTCOMES }).notNull(),
    reason: text("reason", { enum: ENCRYPTION_TRANSITION_REASONS }).notNull(),
    attemptCount: bigint("attempt_count", { mode: "bigint" })
      .notNull()
      .default(sql`1`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "encryption_transition_outcome_totals_pk",
      columns: [
        table.policyRevision,
        table.family,
        table.operation,
        table.outcome,
        table.reason,
      ],
    }),
    check(
      "encryption_transition_outcome_totals_epoch_check",
      sql`${table.policyRevision} > 0`,
    ),
    check(
      "encryption_transition_outcome_totals_count_positive",
      sql`${table.attemptCount} > 0`,
    ),
    check(
      "encryption_transition_outcome_totals_vocabulary_check",
      sql`${table.family} in ('message', 'memory', 'artifact', 'record')
        and ${table.operation} in ('create', 'update', 'access_update', 'read', 'read_repair', 'unsupported')
        and (
          (${table.outcome} in ('verified', 'pending') and ${table.reason} = 'none')
          or (${table.outcome} = 'reconciling' and ${table.reason} = 'response_lost')
          or (${table.outcome} = 'unavailable' and ${table.reason} in (
            'unmigrated', 'unsupported_operation', 'client_crypto_unavailable',
            'client_crypto_preparation_failed', 'client_custody_unavailable',
            'current_read_authority_unavailable',
            'retained_key_material_unavailable', 'signer_evidence_unavailable',
            'live_shadow_lifecycle_unavailable',
            'namespace_encryption_not_ready', 'stale_authority_product',
            'client_observation_expired'
          ))
          or (${table.outcome} = 'failed' and ${table.reason} in (
            'parity_mismatch', 'integrity_failure', 'publication_failure'
          ))
        )
        and (
          (${table.operation} = 'unsupported' and ${table.reason} = 'unsupported_operation')
          or (${table.operation} <> 'unsupported' and ${table.reason} <> 'unsupported_operation')
        )
        and (
          ${table.operation} <> 'read'
          or (${table.family} in ('message', 'memory')
            and ${table.outcome} in ('verified', 'unavailable', 'failed')
            and ${table.reason} in (
              'none', 'client_crypto_unavailable', 'client_custody_unavailable',
              'current_read_authority_unavailable',
              'retained_key_material_unavailable', 'signer_evidence_unavailable',
              'live_shadow_lifecycle_unavailable', 'client_observation_expired',
              'integrity_failure', 'parity_mismatch'
            ))
        )
        and (
          ${table.reason} not in (
            'current_read_authority_unavailable',
            'retained_key_material_unavailable', 'signer_evidence_unavailable',
            'live_shadow_lifecycle_unavailable'
          ) or ${table.operation} = 'read'
        )`,
    ),
    pgPolicy("encryption_transition_outcome_totals_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

/**
 * One-shot client-failure admission. One accepted/retried plan execution is
 * one attempt; unique-object health is reported separately as stored coverage.
 * Rows contain no plaintext or key material. Memory-read admissions retain an
 * exact content-free Human/object/revision binding until consume or expiry so
 * a signed acknowledgement cannot be substituted across reads. The random
 * token itself never enters PostgreSQL; only its digest does. Accepted rows are
 * deleted in the same transaction that records
 * the aggregate so the admission cap cannot become hidden retained pressure.
 */
export const encryptionTransitionObservationAdmissions = pgTable(
  "encryption_transition_observation_admissions",
  {
    tokenDigest: bytea("token_digest").primaryKey(),
    policyRevision: integer("policy_revision").notNull(),
    family: text("family", { enum: ENCRYPTION_TRANSITION_FAMILIES }).notNull(),
    operation: text("operation", {
      enum: ENCRYPTION_TRANSITION_OPERATIONS,
    }).notNull(),
    subjectHumanId: text("subject_human_id"),
    memoryId: uuid("memory_id"),
    cryptoObjectId: text("crypto_object_id"),
    contentRevision: integer("content_revision"),
    cryptoAccessRevision: integer("crypto_access_revision"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_encryption_transition_observation_admissions_expiry")
      .on(table.expiresAt),
    check(
      "encryption_transition_observation_admissions_digest_shape",
      sql`octet_length(${table.tokenDigest}) = 32`,
    ),
    check(
      "encryption_transition_observation_admissions_epoch_check",
      sql`${table.policyRevision} > 0`,
    ),
    check(
      "encryption_transition_observation_admissions_vocabulary_check",
      sql`${table.family} in ('message', 'memory', 'artifact', 'record')
        and ${table.operation} in ('create', 'update', 'access_update', 'read', 'read_repair', 'unsupported')`,
    ),
    check(
      "encryption_transition_observation_admissions_memory_read_binding",
      sql`(${table.family} = 'memory' and ${table.operation} = 'read'
        and ${table.subjectHumanId} is not null and length(${table.subjectHumanId}) > 0
        and ${table.memoryId} is not null
        and ${table.cryptoObjectId} is not null and length(${table.cryptoObjectId}) > 0
        and ${table.contentRevision} is not null and ${table.contentRevision} > 0
        and ${table.cryptoAccessRevision} is not null and ${table.cryptoAccessRevision} >= 0)
        or (not (${table.family} = 'memory' and ${table.operation} = 'read')
          and ${table.subjectHumanId} is null and ${table.memoryId} is null
          and ${table.cryptoObjectId} is null and ${table.contentRevision} is null
          and ${table.cryptoAccessRevision} is null)`,
    ),
    check(
      "encryption_transition_observation_admissions_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    pgPolicy("encryption_transition_observation_admissions_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

export const ENCRYPTION_TRANSITION_HISTORY_READ_ADMISSION_STATES = [
  "planned",
  "consumed",
  "expired",
] as const;
export type EncryptionTransitionHistoryReadAdmissionState =
  typeof ENCRYPTION_TRANSITION_HISTORY_READ_ADMISSION_STATES[number];

export const ENCRYPTION_TRANSITION_HISTORY_READ_CONSUMPTION_KINDS = [
  "signed_acknowledgement",
  "unavailable_token",
  "server_unavailable",
  "ineligible",
  "expiry",
] as const;
export type EncryptionTransitionHistoryReadConsumptionKind =
  typeof ENCRYPTION_TRANSITION_HISTORY_READ_CONSUMPTION_KINDS[number];

/**
 * M275 — one bounded content-free receipt for one explicit Browser history
 * read. Product coordinates are retained only long enough to make request
 * replay, changed-selection conflict, signature authority, count closure, and
 * exactly-once aggregate projection decidable. The bearer token is never
 * persisted; only its digest crosses the database boundary.
 */
export const encryptionTransitionHistoryReadAdmissions = pgTable(
  "encryption_transition_history_read_admissions",
  {
    operationId: text("operation_id").primaryKey(),
    clientRequestKey: text("client_request_key").notNull(),
    policyRevision: integer("policy_revision").notNull(),
    subjectHumanId: text("subject_human_id").notNull(),
    /** Null only for a server-projected explicit-intent/no-device attempt. */
    readerDeviceId: text("reader_device_id"),
    readerDeviceSigningKeyGeneration: bigint(
      "reader_device_signing_key_generation",
      { mode: "number" },
    ),
    hostAuthorizationRevision: bigint("host_authorization_revision", {
      mode: "number",
    }),
    roomId: uuid("room_id").notNull(),
    selectedCoordinateDigest: bytea("selected_coordinate_digest").notNull(),
    selectedCount: integer("selected_count").notNull().default(1),
    eligibleCount: integer("eligible_count").notNull(),
    tokenDigest: bytea("token_digest").notNull(),
    state: text("state", {
      enum: ENCRYPTION_TRANSITION_HISTORY_READ_ADMISSION_STATES,
    }).notNull().default("planned"),
    consumptionKind: text("consumption_kind", {
      enum: ENCRYPTION_TRANSITION_HISTORY_READ_CONSUMPTION_KINDS,
    }),
    acknowledgementDigest: bytea("acknowledgement_digest"),
    orderedResultSetDigest: bytea("ordered_result_set_digest"),
    verifiedCount: integer("verified_count").notNull().default(0),
    clientCryptoUnavailableCount: integer("client_crypto_unavailable_count")
      .notNull().default(0),
    clientCustodyUnavailableCount: integer("client_custody_unavailable_count")
      .notNull().default(0),
    currentReadAuthorityUnavailableCount: integer(
      "current_read_authority_unavailable_count",
    ).notNull().default(0),
    retainedKeyMaterialUnavailableCount: integer(
      "retained_key_material_unavailable_count",
    ).notNull().default(0),
    signerEvidenceUnavailableCount: integer(
      "signer_evidence_unavailable_count",
    ).notNull().default(0),
    liveShadowLifecycleUnavailableCount: integer(
      "live_shadow_lifecycle_unavailable_count",
    ).notNull().default(0),
    integrityFailureCount: integer("integrity_failure_count")
      .notNull().default(0),
    parityMismatchCount: integer("parity_mismatch_count")
      .notNull().default(0),
    clientObservationExpiredCount: integer("client_observation_expired_count")
      .notNull().default(0),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_encryption_transition_history_read_request")
      .on(table.policyRevision, table.subjectHumanId, table.clientRequestKey),
    uniqueIndex("uq_encryption_transition_history_read_token_digest")
      .on(table.tokenDigest),
    index("idx_encryption_transition_history_read_admissions_expiry")
      .on(table.state, table.expiresAt),
    check(
      "encryption_transition_history_read_admissions_identity_shape",
      sql`length(${table.operationId}) between 1 and 255
        and length(${table.clientRequestKey}) between 1 and 255
        and length(${table.subjectHumanId}) between 1 and 255
        and ${table.policyRevision} > 0
        and octet_length(${table.selectedCoordinateDigest}) = 32
        and octet_length(${table.tokenDigest}) = 32
        and ${table.selectedCount} between 1 and 50
        and ${table.eligibleCount} between 0 and ${table.selectedCount}`,
    ),
    check(
      "encryption_transition_history_read_admissions_device_shape",
      sql`(${table.readerDeviceId} is null) =
          (${table.readerDeviceSigningKeyGeneration} is null)
        and (${table.readerDeviceId} is null) =
          (${table.hostAuthorizationRevision} is null)
        and (${table.readerDeviceId} is null
          or (length(${table.readerDeviceId}) between 1 and 255
            and ${table.readerDeviceSigningKeyGeneration} > 0
            and ${table.hostAuthorizationRevision} >= 0))`,
    ),
    check(
      "encryption_transition_history_read_admissions_time_shape",
      sql`${table.expiresAt} > ${table.issuedAt}
        and ${table.updatedAt} >= ${table.issuedAt}
        and (${table.terminalAt} is null or ${table.terminalAt} >= ${table.issuedAt})`,
    ),
    check(
      "encryption_transition_history_read_admissions_counts_nonnegative",
      sql`${table.verifiedCount} >= 0
        and ${table.clientCryptoUnavailableCount} >= 0
        and ${table.clientCustodyUnavailableCount} >= 0
        and ${table.currentReadAuthorityUnavailableCount} >= 0
        and ${table.retainedKeyMaterialUnavailableCount} >= 0
        and ${table.signerEvidenceUnavailableCount} >= 0
        and ${table.liveShadowLifecycleUnavailableCount} >= 0
        and ${table.integrityFailureCount} >= 0
        and ${table.parityMismatchCount} >= 0
        and ${table.clientObservationExpiredCount} >= 0`,
    ),
    check(
      "encryption_transition_history_read_admissions_state_shape",
      sql`(
        ${table.state} = 'planned'
        and ${table.consumptionKind} is null
        and ${table.acknowledgementDigest} is null
        and ${table.orderedResultSetDigest} is null
        and ${table.terminalAt} is null
        and ${table.verifiedCount} + ${table.clientCryptoUnavailableCount}
          + ${table.clientCustodyUnavailableCount}
          + ${table.currentReadAuthorityUnavailableCount}
          + ${table.retainedKeyMaterialUnavailableCount}
          + ${table.signerEvidenceUnavailableCount}
          + ${table.liveShadowLifecycleUnavailableCount}
          + ${table.integrityFailureCount} + ${table.parityMismatchCount}
          + ${table.clientObservationExpiredCount} = 0
      ) or (
        ${table.state} = 'consumed'
        and ${table.consumptionKind} in (
          'signed_acknowledgement', 'unavailable_token', 'server_unavailable',
          'ineligible'
        )
        and ${table.terminalAt} is not null
        and ${table.terminalAt} < ${table.expiresAt}
        and ${table.clientObservationExpiredCount} = 0
        and ${table.verifiedCount} + ${table.clientCryptoUnavailableCount}
          + ${table.clientCustodyUnavailableCount}
          + ${table.currentReadAuthorityUnavailableCount}
          + ${table.retainedKeyMaterialUnavailableCount}
          + ${table.signerEvidenceUnavailableCount}
          + ${table.liveShadowLifecycleUnavailableCount}
          + ${table.integrityFailureCount} + ${table.parityMismatchCount}
          = ${table.eligibleCount}
        and (
          (${table.consumptionKind} = 'signed_acknowledgement'
            and ${table.readerDeviceId} is not null
            and octet_length(${table.acknowledgementDigest}) = 32
            and octet_length(${table.orderedResultSetDigest}) = 32)
          or (${table.consumptionKind} = 'unavailable_token'
            and ${table.acknowledgementDigest} is null
            and ${table.orderedResultSetDigest} is null
            and ${table.verifiedCount} = 0
            and ${table.currentReadAuthorityUnavailableCount} = 0
            and ${table.retainedKeyMaterialUnavailableCount} = 0
            and ${table.signerEvidenceUnavailableCount} = 0
            and ${table.liveShadowLifecycleUnavailableCount} = 0
            and ${table.integrityFailureCount} = 0
            and ${table.parityMismatchCount} = 0
            and (${table.clientCryptoUnavailableCount} = ${table.eligibleCount}
              or ${table.clientCustodyUnavailableCount} = ${table.eligibleCount}))
          or (${table.consumptionKind} = 'server_unavailable'
            and ${table.acknowledgementDigest} is null
            and ${table.orderedResultSetDigest} is null
            and ${table.verifiedCount} = 0
            and ${table.clientCustodyUnavailableCount} = 0
            and ${table.integrityFailureCount} = 0
            and ${table.parityMismatchCount} = 0
            and (
              ${table.clientCryptoUnavailableCount} = ${table.eligibleCount}
              or ${table.currentReadAuthorityUnavailableCount} = ${table.eligibleCount}
              or ${table.retainedKeyMaterialUnavailableCount} = ${table.eligibleCount}
              or ${table.signerEvidenceUnavailableCount} = ${table.eligibleCount}
              or ${table.liveShadowLifecycleUnavailableCount} = ${table.eligibleCount}
            ))
          or (${table.consumptionKind} = 'ineligible'
            and ${table.eligibleCount} = 0
            and ${table.readerDeviceId} is null
            and ${table.acknowledgementDigest} is null
            and ${table.orderedResultSetDigest} is null)
        )
      ) or (
        ${table.state} = 'expired'
        and ${table.consumptionKind} = 'expiry'
        and ${table.acknowledgementDigest} is null
        and ${table.orderedResultSetDigest} is null
        and ${table.terminalAt} = ${table.expiresAt}
        and ${table.clientObservationExpiredCount} = ${table.eligibleCount}
        and ${table.verifiedCount} + ${table.clientCryptoUnavailableCount}
          + ${table.clientCustodyUnavailableCount}
          + ${table.currentReadAuthorityUnavailableCount}
          + ${table.retainedKeyMaterialUnavailableCount}
          + ${table.signerEvidenceUnavailableCount}
          + ${table.liveShadowLifecycleUnavailableCount}
          + ${table.integrityFailureCount} + ${table.parityMismatchCount} = 0
      )`,
    ),
    pgPolicy("encryption_transition_history_read_admissions_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

export type EncryptionTransitionPolicyRow =
  typeof encryptionTransitionPolicy.$inferSelect;
export type NewEncryptionTransitionPolicyRow =
  typeof encryptionTransitionPolicy.$inferInsert;
export type EncryptionTransitionObservationBucketRow =
  typeof encryptionTransitionObservationBuckets.$inferSelect;
export type NewEncryptionTransitionObservationBucketRow =
  typeof encryptionTransitionObservationBuckets.$inferInsert;
export type EncryptionTransitionOutcomeTotalRow =
  typeof encryptionTransitionOutcomeTotals.$inferSelect;
export type NewEncryptionTransitionOutcomeTotalRow =
  typeof encryptionTransitionOutcomeTotals.$inferInsert;
export type EncryptionTransitionObservationAdmissionRow =
  typeof encryptionTransitionObservationAdmissions.$inferSelect;
export type NewEncryptionTransitionObservationAdmissionRow =
  typeof encryptionTransitionObservationAdmissions.$inferInsert;
export type EncryptionTransitionHistoryReadAdmissionRow =
  typeof encryptionTransitionHistoryReadAdmissions.$inferSelect;
export type NewEncryptionTransitionHistoryReadAdmissionRow =
  typeof encryptionTransitionHistoryReadAdmissions.$inferInsert;
