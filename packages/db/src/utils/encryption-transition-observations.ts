import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, count, eq, lt, lte, ne, sql } from "drizzle-orm";

import type { Database } from "../config/database";
import {
  ENCRYPTION_TRANSITION_FAMILIES,
  ENCRYPTION_TRANSITION_OPERATIONS,
  ENCRYPTION_TRANSITION_OUTCOMES,
  ENCRYPTION_TRANSITION_REASONS,
  encryptionTransitionHistoryReadAdmissions,
  encryptionTransitionObservationAdmissions,
  encryptionTransitionObservationBuckets,
  encryptionTransitionOutcomeTotals,
  encryptionTransitionPolicy,
  type EncryptionTransitionFamily,
  type EncryptionTransitionOperation,
  type EncryptionTransitionOutcome,
  type EncryptionTransitionPolicyRow,
  type EncryptionTransitionReason,
  type EncryptionTransitionHistoryReadAdmissionRow,
} from "../schema/encryption-transition";
import {
  assertLiveShadowEncryptionTransitionMode,
  observationBoundsFromPolicyRow,
} from "./encryption-transition-queries";

export interface EncryptionTransitionObservationBounds {
  readonly bucketWidthMs: number;
  readonly retentionMs: number;
  readonly storageLimitRows: number;
  readonly latencyUpperBoundsMs: readonly number[];
}

export interface PlannedEncryptionTransitionObservation {
  readonly bucketStartedAt: Date;
  readonly bucketWidthMs: number;
  readonly latencyBucket: number;
  readonly retentionCutoff: Date;
}

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

export function validateEncryptionTransitionObservationBounds(
  input: EncryptionTransitionObservationBounds,
): EncryptionTransitionObservationBounds {
  positiveSafeInteger(input.bucketWidthMs, "bucketWidthMs");
  positiveSafeInteger(input.retentionMs, "retentionMs");
  positiveSafeInteger(input.storageLimitRows, "storageLimitRows");
  if (input.retentionMs < input.bucketWidthMs) {
    throw new RangeError("retentionMs must cover at least one complete bucket");
  }
  let previous = 0;
  const latencyUpperBoundsMs = input.latencyUpperBoundsMs.map((value) => {
    positiveSafeInteger(value, "latencyUpperBoundsMs entry");
    if (value <= previous) {
      throw new RangeError("latencyUpperBoundsMs must be strictly increasing");
    }
    previous = value;
    return value;
  });
  return {
    bucketWidthMs: input.bucketWidthMs,
    retentionMs: input.retentionMs,
    storageLimitRows: input.storageLimitRows,
    latencyUpperBoundsMs,
  };
}

export function planEncryptionTransitionObservation(
  observedAt: Date,
  latencyMs: number,
  rawBounds: EncryptionTransitionObservationBounds,
): PlannedEncryptionTransitionObservation {
  const observedAtMs = observedAt.getTime();
  if (!Number.isFinite(observedAtMs)) throw new TypeError("observedAt must be valid");
  if (!Number.isSafeInteger(latencyMs) || latencyMs < 0) {
    throw new TypeError("latencyMs must be a non-negative safe integer");
  }
  const bounds = validateEncryptionTransitionObservationBounds(rawBounds);
  const bucketStartedAtMs = Math.floor(observedAtMs / bounds.bucketWidthMs) *
    bounds.bucketWidthMs;
  const latencyBucket = bounds.latencyUpperBoundsMs.findIndex(
    (upperBound) => latencyMs <= upperBound,
  );
  return {
    bucketStartedAt: new Date(bucketStartedAtMs),
    bucketWidthMs: bounds.bucketWidthMs,
    latencyBucket: latencyBucket === -1
      ? bounds.latencyUpperBoundsMs.length
      : latencyBucket,
    retentionCutoff: new Date(observedAtMs - bounds.retentionMs),
  };
}

function includes<T extends string>(values: readonly T[], value: string): value is T {
  return values.some((candidate) => candidate === value);
}

function assertObservationVocabulary(input: Readonly<{
  family: string;
  operation: string;
  outcome: string;
  reason: string;
}>): asserts input is {
  family: EncryptionTransitionFamily;
  operation: EncryptionTransitionOperation;
  outcome: EncryptionTransitionOutcome;
  reason: EncryptionTransitionReason;
} {
  if (
    !includes(ENCRYPTION_TRANSITION_FAMILIES, input.family) ||
    !includes(ENCRYPTION_TRANSITION_OPERATIONS, input.operation) ||
    !includes(ENCRYPTION_TRANSITION_OUTCOMES, input.outcome) ||
    !includes(ENCRYPTION_TRANSITION_REASONS, input.reason)
  ) throw new TypeError("Unknown encryption transition observation vocabulary");

  const coherent =
    ((input.outcome === "verified" || input.outcome === "pending") &&
      input.reason === "none") ||
    (input.outcome === "reconciling" && input.reason === "response_lost") ||
    (input.outcome === "unavailable" && [
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
      "client_observation_expired",
    ].includes(input.reason)) ||
    (input.outcome === "failed" && [
      "parity_mismatch",
      "integrity_failure",
      "publication_failure",
    ].includes(input.reason));
  if (!coherent || ((input.operation === "unsupported") !==
    (input.reason === "unsupported_operation")) ||
    (input.operation === "read" && (
      (input.family !== "message" && input.family !== "memory") ||
      !["verified", "unavailable", "failed"].includes(input.outcome) ||
      ![
        "none",
        "client_crypto_unavailable",
        "client_custody_unavailable",
        "current_read_authority_unavailable",
        "retained_key_material_unavailable",
        "signer_evidence_unavailable",
        "live_shadow_lifecycle_unavailable",
        "client_observation_expired",
        "integrity_failure",
        "parity_mismatch",
      ].includes(input.reason)
    )) || ([
      "current_read_authority_unavailable",
      "retained_key_material_unavailable",
      "signer_evidence_unavailable",
      "live_shadow_lifecycle_unavailable",
    ].includes(input.reason) && input.operation !== "read")) {
    throw new TypeError("Incoherent encryption transition outcome and reason");
  }
}

export type EncryptionTransitionObservationDb = Pick<Database, "transaction">;
type EncryptionTransitionObservationTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

export const ENCRYPTION_TRANSITION_OBSERVATION_ADMISSION_TOKEN_BYTES = 32;
export const ENCRYPTION_TRANSITION_OBSERVATION_ADMISSION_MAX_TTL_MS =
  2 * 60 * 60 * 1_000;

export interface EncryptionTransitionObservationAdmission {
  readonly token: Uint8Array;
  readonly policyRevision: number;
  readonly expiresAt: Date;
}

export interface EncryptionTransitionMemoryReadObservationBinding {
  readonly subjectHumanId: string;
  readonly memoryId: string;
  readonly cryptoObjectId: string;
  readonly contentRevision: number;
  readonly cryptoAccessRevision: number;
}

export type EncryptionTransitionObservationAdmissionConsumption =
  | { readonly status: "accepted" }
  | { readonly status: "conflict" }
  | { readonly status: "unavailable" };

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

async function loadLockedProtectedEpochPolicy(
  tx: EncryptionTransitionObservationTransaction,
): Promise<EncryptionTransitionPolicyRow> {
  const [policy] = await tx.select().from(encryptionTransitionPolicy)
    .where(eq(encryptionTransitionPolicy.id, "server"))
    .for("update");
  if (!policy) throw new Error("Encryption transition singleton is unavailable");
  const mode = assertLiveShadowEncryptionTransitionMode(policy.mode);
  if ((mode !== "shadow_encryption" && mode !== "encrypted_only") ||
    policy.shadowEncryptionStartedAt === null) {
    throw new Error("Encryption transition observations require the active protected epoch");
  }
  return policy;
}

async function recordObservationInTransaction(
  tx: EncryptionTransitionObservationTransaction,
  policy: EncryptionTransitionPolicyRow,
  input: Readonly<{
    family: EncryptionTransitionFamily;
    operation: EncryptionTransitionOperation;
    outcome: EncryptionTransitionOutcome;
    reason: EncryptionTransitionReason;
    observedAt: Date;
    latencyMs: number;
    attemptCount?: number;
  }>,
): Promise<void> {
  if (policy.shadowEncryptionStartedAt === null ||
    input.observedAt < policy.shadowEncryptionStartedAt) {
    throw new Error("Encryption transition observations require the active protected epoch");
  }
  const durableBounds = observationBoundsFromPolicyRow(policy);
  const bounds = validateEncryptionTransitionObservationBounds(durableBounds);
  const plan = planEncryptionTransitionObservation(
    input.observedAt,
    input.latencyMs,
    bounds,
  );
  const attemptCount = input.attemptCount ?? 1;
  positiveSafeInteger(attemptCount, "attemptCount");

  await tx.delete(encryptionTransitionOutcomeTotals).where(
    ne(encryptionTransitionOutcomeTotals.policyRevision, policy.revision),
  );
  await tx.insert(encryptionTransitionOutcomeTotals).values({
    policyRevision: policy.revision,
    family: input.family,
    operation: input.operation,
    outcome: input.outcome,
    reason: input.reason,
    attemptCount: BigInt(attemptCount),
    updatedAt: input.observedAt,
  }).onConflictDoUpdate({
    target: [
      encryptionTransitionOutcomeTotals.policyRevision,
      encryptionTransitionOutcomeTotals.family,
      encryptionTransitionOutcomeTotals.operation,
      encryptionTransitionOutcomeTotals.outcome,
      encryptionTransitionOutcomeTotals.reason,
    ],
    set: {
      attemptCount: sql`${encryptionTransitionOutcomeTotals.attemptCount} + ${attemptCount}`,
      updatedAt: input.observedAt,
    },
  });

  await tx.insert(encryptionTransitionObservationBuckets).values({
    policyRevision: policy.revision,
    bucketStartedAt: plan.bucketStartedAt,
    boundsRevision: durableBounds.revision,
    bucketWidthMs: plan.bucketWidthMs,
    family: input.family,
    operation: input.operation,
    outcome: input.outcome,
    reason: input.reason,
    latencyBucket: plan.latencyBucket,
    attemptCount: BigInt(attemptCount),
    updatedAt: input.observedAt,
  }).onConflictDoUpdate({
    target: [
      encryptionTransitionObservationBuckets.policyRevision,
      encryptionTransitionObservationBuckets.bucketStartedAt,
      encryptionTransitionObservationBuckets.boundsRevision,
      encryptionTransitionObservationBuckets.bucketWidthMs,
      encryptionTransitionObservationBuckets.family,
      encryptionTransitionObservationBuckets.operation,
      encryptionTransitionObservationBuckets.outcome,
      encryptionTransitionObservationBuckets.reason,
      encryptionTransitionObservationBuckets.latencyBucket,
    ],
    set: {
      attemptCount: sql`${encryptionTransitionObservationBuckets.attemptCount} + ${attemptCount}`,
      updatedAt: input.observedAt,
    },
  });
  await tx.delete(encryptionTransitionObservationBuckets).where(
    lt(encryptionTransitionObservationBuckets.bucketStartedAt, plan.retentionCutoff),
  );
  await tx.execute(sql`
    delete from ${encryptionTransitionObservationBuckets} as victim
    using (
      select policy_revision, bucket_started_at, bounds_revision, bucket_width_ms,
        family, operation, outcome, reason, latency_bucket
      from ${encryptionTransitionObservationBuckets}
      order by bucket_started_at desc, family, operation, outcome, reason, latency_bucket
      offset ${bounds.storageLimitRows}
    ) as overflow
    where victim.policy_revision = overflow.policy_revision
      and victim.bucket_started_at = overflow.bucket_started_at
      and victim.bounds_revision = overflow.bounds_revision
      and victim.bucket_width_ms = overflow.bucket_width_ms
      and victim.family = overflow.family
      and victim.operation = overflow.operation
      and victim.outcome = overflow.outcome
      and victim.reason = overflow.reason
      and victim.latency_bucket = overflow.latency_bucket
  `);
}

async function reconcileExpiredAdmissionsInTransaction(
  tx: EncryptionTransitionObservationTransaction,
  policy: EncryptionTransitionPolicyRow,
  now: Date,
): Promise<number> {
  const bounds = observationBoundsFromPolicyRow(policy);
  const expired = await tx.select().from(
    encryptionTransitionObservationAdmissions,
  ).where(and(
    eq(encryptionTransitionObservationAdmissions.policyRevision, policy.revision),
    lte(encryptionTransitionObservationAdmissions.expiresAt, now),
  )).limit(bounds.storageLimitRows).for("update");
  for (const admission of expired) {
    const unsupported = admission.operation === "unsupported";
    await recordObservationInTransaction(tx, policy, {
      family: admission.family,
      operation: admission.operation,
      outcome: "unavailable",
      reason: unsupported
        ? "unsupported_operation"
        : "client_observation_expired",
      // Expiry, not the later lazy reconciliation clock, is the exact terminal
      // attempt boundary and therefore the measured end of its latency.
      observedAt: admission.expiresAt,
      latencyMs: Math.max(
        0,
        admission.expiresAt.getTime() - admission.createdAt.getTime(),
      ),
    });
  }
  if (expired.length > 0) {
    await tx.delete(encryptionTransitionObservationAdmissions).where(and(
      eq(encryptionTransitionObservationAdmissions.policyRevision, policy.revision),
      lte(encryptionTransitionObservationAdmissions.expiresAt, now),
    ));
  }
  return expired.length;
}

/**
 * Lazily terminalize expired one-shot attempts before dashboards/capacity
 * pruning. This keeps crash/response-loss attempts in the cumulative epoch
 * denominator without adding a timer or retaining bearer-token digests.
 */
export async function reconcileExpiredEncryptionTransitionObservationAdmissions(
  db: EncryptionTransitionObservationDb,
  input: Readonly<{ now?: Date }> = {},
): Promise<number> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("now must be valid");
  return db.transaction(async (tx) => {
    const policy = await loadLockedProtectedEpochPolicy(tx);
    return reconcileExpiredAdmissionsInTransaction(tx, policy, now);
  });
}

/**
 * Issue one content-free bearer admission for one planned Shadow attempt.
 * A re-plan is a new attempt; unique current objects belong to coverage, not
 * this denominator.
 * The caller must derive family/operation from an authenticated server plan;
 * neither value is accepted back from the client during consumption.
 */
export async function issueEncryptionTransitionObservationAdmission(
  db: EncryptionTransitionObservationDb,
  input: Readonly<{
    family: EncryptionTransitionFamily;
    operation: EncryptionTransitionOperation;
    expiresAt: Date;
    now?: Date;
    memoryReadBinding?: EncryptionTransitionMemoryReadObservationBinding;
  }>,
): Promise<EncryptionTransitionObservationAdmission> {
  assertObservationVocabulary({
    family: input.family,
    operation: input.operation,
    outcome: input.operation === "unsupported" || input.operation === "read"
      ? "unavailable" : "pending",
    reason: input.operation === "unsupported" ? "unsupported_operation"
      : input.operation === "read" ? "client_observation_expired" : "none",
  });
  if ((input.family === "memory" && input.operation === "read")
    !== (input.memoryReadBinding !== undefined)) {
    throw new TypeError("Memory read observation requires its exact binding");
  }
  if (input.memoryReadBinding !== undefined && (
    input.memoryReadBinding.subjectHumanId.length === 0
    || input.memoryReadBinding.cryptoObjectId.length === 0
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(input.memoryReadBinding.memoryId)
    || !Number.isSafeInteger(input.memoryReadBinding.contentRevision)
    || input.memoryReadBinding.contentRevision < 1
    || !Number.isSafeInteger(input.memoryReadBinding.cryptoAccessRevision)
    || input.memoryReadBinding.cryptoAccessRevision < 0
  )) throw new TypeError("Memory read observation binding is invalid");
  const now = input.now ?? new Date();
  const ttlMs = input.expiresAt.getTime() - now.getTime();
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(input.expiresAt.getTime()) ||
    ttlMs <= 0 || ttlMs > ENCRYPTION_TRANSITION_OBSERVATION_ADMISSION_MAX_TTL_MS) {
    throw new RangeError("Observation admission expiry is outside the bounded lifetime");
  }
  const token = new Uint8Array(randomBytes(
    ENCRYPTION_TRANSITION_OBSERVATION_ADMISSION_TOKEN_BYTES,
  ));
  const tokenDigest = sha256(token);
  try {
    const policyRevision = await db.transaction(async (tx) => {
      const policy = await loadLockedProtectedEpochPolicy(tx);
      const bounds = observationBoundsFromPolicyRow(policy);
      await reconcileExpiredAdmissionsInTransaction(tx, policy, now);
      await tx.delete(encryptionTransitionObservationAdmissions).where(
        ne(
          encryptionTransitionObservationAdmissions.policyRevision,
          policy.revision,
        ),
      );
      const [countRow] = await tx.select({ count: count() })
        .from(encryptionTransitionObservationAdmissions);
      if (!countRow || !Number.isSafeInteger(countRow.count) || countRow.count < 0) {
        throw new Error("Observation admission count is unavailable");
      }
      if (countRow.count >= bounds.storageLimitRows) {
        throw new Error("Observation admission capacity is exhausted");
      }
      await tx.insert(encryptionTransitionObservationAdmissions).values({
        tokenDigest,
        policyRevision: policy.revision,
        family: input.family,
        operation: input.operation,
        ...(input.memoryReadBinding ?? {}),
        expiresAt: input.expiresAt,
        createdAt: now,
      });
      return policy.revision;
    });
    return { token, policyRevision, expiresAt: input.expiresAt };
  } finally {
    tokenDigest.fill(0);
  }
}

/** Atomically consume one server-issued admission and project it exactly once. */
async function consumeObservationAdmission(
  db: EncryptionTransitionObservationDb,
  input: Readonly<{
    token: Uint8Array;
    outcome: EncryptionTransitionOutcome;
    reason: EncryptionTransitionReason;
    observedAt: Date;
  }>,
  trustedServerOutcome: boolean,
  trustedExpected?: Readonly<{
    family: EncryptionTransitionFamily;
    operation: EncryptionTransitionOperation;
    policyRevision?: number;
    memoryReadBinding?: EncryptionTransitionMemoryReadObservationBinding;
  }>,
): Promise<EncryptionTransitionObservationAdmissionConsumption> {
  if (input.token.byteLength !==
    ENCRYPTION_TRANSITION_OBSERVATION_ADMISSION_TOKEN_BYTES) {
    throw new TypeError("Observation admission token must be exactly 32 bytes");
  }
  if (!trustedServerOutcome && input.outcome !== "unavailable" &&
    input.outcome !== "failed") {
    throw new TypeError(
      "Client-local observations may report only unavailable or failed",
    );
  }
  const tokenDigest = sha256(input.token);
  try {
    return await db.transaction(async (tx) => {
      const policy = await loadLockedProtectedEpochPolicy(tx);
      await reconcileExpiredAdmissionsInTransaction(tx, policy, input.observedAt);
      const rows = await tx.select().from(encryptionTransitionObservationAdmissions)
        .where(eq(encryptionTransitionObservationAdmissions.tokenDigest, tokenDigest))
        .limit(1)
        .for("update");
      const admission = rows[0];
      if (!admission || admission.policyRevision !== policy.revision ||
        admission.expiresAt <= input.observedAt) {
        return { status: "unavailable" as const };
      }
      if (trustedExpected !== undefined &&
        (admission.family !== trustedExpected.family ||
          admission.operation !== trustedExpected.operation ||
          (trustedExpected.policyRevision !== undefined
            && admission.policyRevision !== trustedExpected.policyRevision) ||
          (trustedExpected.memoryReadBinding !== undefined && (
            admission.subjectHumanId !== trustedExpected.memoryReadBinding.subjectHumanId
            || admission.memoryId !== trustedExpected.memoryReadBinding.memoryId
            || admission.cryptoObjectId !== trustedExpected.memoryReadBinding.cryptoObjectId
            || admission.contentRevision !== trustedExpected.memoryReadBinding.contentRevision
            || admission.cryptoAccessRevision
              !== trustedExpected.memoryReadBinding.cryptoAccessRevision
          )))) {
        const consumed = await tx.delete(
          encryptionTransitionObservationAdmissions,
        ).where(and(
          eq(encryptionTransitionObservationAdmissions.tokenDigest, tokenDigest),
          eq(encryptionTransitionObservationAdmissions.policyRevision, policy.revision),
        )).returning({
          tokenDigest: encryptionTransitionObservationAdmissions.tokenDigest,
        });
        if (consumed.length !== 1) return { status: "conflict" as const };
        const unsupported = admission.operation === "unsupported";
        await recordObservationInTransaction(tx, policy, {
          family: admission.family,
          operation: admission.operation,
          outcome: unsupported ? "unavailable" : "failed",
          reason: unsupported ? "unsupported_operation" : "integrity_failure",
          observedAt: input.observedAt,
          latencyMs: Math.max(
            0,
            input.observedAt.getTime() - admission.createdAt.getTime(),
          ),
        });
        return { status: "conflict" as const };
      }
      assertObservationVocabulary({
        family: admission.family,
        operation: admission.operation,
        outcome: input.outcome,
        reason: input.reason,
      });
      const consumed = await tx.delete(encryptionTransitionObservationAdmissions)
        .where(and(
          eq(encryptionTransitionObservationAdmissions.tokenDigest, tokenDigest),
          eq(encryptionTransitionObservationAdmissions.policyRevision, policy.revision),
        ))
        .returning({ tokenDigest: encryptionTransitionObservationAdmissions.tokenDigest });
      if (consumed.length !== 1) return { status: "conflict" as const };
      await recordObservationInTransaction(tx, policy, {
        family: admission.family,
        operation: admission.operation,
        outcome: input.outcome,
        reason: input.reason,
        observedAt: input.observedAt,
        latencyMs: Math.max(
          0,
          input.observedAt.getTime() - admission.createdAt.getTime(),
        ),
      });
      return { status: "accepted" as const };
    });
  } finally {
    tokenDigest.fill(0);
  }
}

/**
 * Consume a client-local failure. This boundary cannot increase the verified
 * numerator; successful and in-flight outcomes come only from trusted server
 * composition below.
 */
export function consumeEncryptionTransitionObservationAdmission(
  db: EncryptionTransitionObservationDb,
  input: Readonly<{
    token: Uint8Array;
    outcome: EncryptionTransitionOutcome;
    reason: EncryptionTransitionReason;
    observedAt: Date;
  }>,
): Promise<EncryptionTransitionObservationAdmissionConsumption> {
  return consumeObservationAdmission(db, input, false);
}

/**
 * Consume the same one-shot token from authenticated server commit/reconcile
 * composition. The durable admission still derives family and operation;
 * callers supply only the server-observed outcome.
 */
export function consumeTrustedEncryptionTransitionObservationAdmission(
  db: EncryptionTransitionObservationDb,
  input: Readonly<{
    token: Uint8Array;
    expectedFamily: EncryptionTransitionFamily;
    expectedOperation: EncryptionTransitionOperation;
    expectedPolicyRevision?: number;
    outcome: EncryptionTransitionOutcome;
    reason: EncryptionTransitionReason;
    observedAt: Date;
    memoryReadBinding?: EncryptionTransitionMemoryReadObservationBinding;
  }>,
): Promise<EncryptionTransitionObservationAdmissionConsumption> {
  return consumeObservationAdmission(db, input, true, {
    family: input.expectedFamily,
    operation: input.expectedOperation,
    ...(input.expectedPolicyRevision === undefined ? {} : {
      policyRevision: input.expectedPolicyRevision,
    }),
    ...(input.memoryReadBinding === undefined ? {} : {
      memoryReadBinding: input.memoryReadBinding,
    }),
  });
}

/**
 * Record one server-observed family attempt outcome. This path is deliberately
 * not exposed as a client endpoint; client-local failures use a one-shot
 * admission above so arbitrary retries cannot inflate the denominator.
 */
export async function recordEncryptionTransitionObservation(
  db: EncryptionTransitionObservationDb,
  input: Readonly<{
    family: EncryptionTransitionFamily;
    operation: EncryptionTransitionOperation;
    outcome: EncryptionTransitionOutcome;
    reason: EncryptionTransitionReason;
    observedAt: Date;
    latencyMs: number;
    attemptCount?: number;
  }>,
): Promise<void> {
  assertObservationVocabulary(input);

  await db.transaction(async (tx) => {
    const policy = await loadLockedProtectedEpochPolicy(tx);
    await recordObservationInTransaction(tx, policy, input);
  });
}

export const ENCRYPTION_TRANSITION_HISTORY_READ_ADMISSION_TOKEN_BYTES = 32;
export const ENCRYPTION_TRANSITION_HISTORY_READ_ADMISSION_MAX_TTL_MS = 120_000;
export const ENCRYPTION_TRANSITION_HISTORY_READ_MAX_ELIGIBLE_COUNT = 50;
export const ENCRYPTION_TRANSITION_HISTORY_READ_MAX_SELECTED_COUNT = 50;

export interface EncryptionTransitionHistoryReadResultCounts {
  readonly verified: number;
  readonly clientCryptoUnavailable: number;
  readonly clientCustodyUnavailable: number;
  readonly currentReadAuthorityUnavailable: number;
  readonly retainedKeyMaterialUnavailable: number;
  readonly signerEvidenceUnavailable: number;
  readonly liveShadowLifecycleUnavailable: number;
  readonly integrityFailure: number;
  readonly parityMismatch: number;
}

export type EncryptionTransitionHistoryReadAdmission =
  | Readonly<{
    status: "planned";
    operationId: string;
    token: Uint8Array;
    policyRevision: number;
    issuedAt: Date;
    expiresAt: Date;
    replayed: boolean;
  }>
  | Readonly<{
    status: "terminal";
    operationId: string;
    policyRevision: number;
    issuedAt: Date;
    expiresAt: Date;
    terminalState: "consumed" | "expired";
    replayed: true;
  }>;

export type EncryptionTransitionHistoryReadAdmissionConsumption =
  | { readonly status: "accepted" }
  | { readonly status: "replayed" }
  | { readonly status: "conflict" }
  | { readonly status: "unavailable" };

export interface EncryptionTransitionHistoryReadActivity {
  readonly pagesAttempted: bigint;
  readonly pagesPending: bigint;
  readonly selectedRows: bigint;
  readonly eligibleRows: bigint;
  readonly pendingEligibleRows: bigint;
}

const HISTORY_READ_COUNT_FIELDS = [
  "verified",
  "clientCryptoUnavailable",
  "clientCustodyUnavailable",
  "currentReadAuthorityUnavailable",
  "retainedKeyMaterialUnavailable",
  "signerEvidenceUnavailable",
  "liveShadowLifecycleUnavailable",
  "integrityFailure",
  "parityMismatch",
] as const satisfies readonly (keyof EncryptionTransitionHistoryReadResultCounts)[];

function exactDigest(value: Uint8Array, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError(`${name} must be exactly 32 bytes`);
  }
  return new Uint8Array(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index]);
}

function exactHistoryReadCounts(
  counts: EncryptionTransitionHistoryReadResultCounts,
  eligibleCount: number,
): EncryptionTransitionHistoryReadResultCounts {
  if (typeof counts !== "object" || counts === null || Array.isArray(counts) ||
    Object.keys(counts).sort().join("\u0000") !==
      [...HISTORY_READ_COUNT_FIELDS].sort().join("\u0000")) {
    throw new TypeError("History-read result counts have an invalid field set");
  }
  let total = 0;
  const entries = HISTORY_READ_COUNT_FIELDS.map((field) => {
    const value = counts[field];
    if (!Number.isSafeInteger(value) || value < 0 ||
      value > ENCRYPTION_TRANSITION_HISTORY_READ_MAX_ELIGIBLE_COUNT) {
      throw new RangeError(`History-read ${field} count is invalid`);
    }
    total += value;
    return [field, value] as const;
  });
  if (total !== eligibleCount) {
    throw new TypeError("History-read result counts do not close over eligibility");
  }
  return Object.freeze(Object.fromEntries(entries)) as unknown as
    EncryptionTransitionHistoryReadResultCounts;
}

function assertHistoryReadPlanInput(input: Readonly<{
  clientRequestKey: string;
  subjectHumanId: string;
  readerDeviceId: string | null;
  readerDeviceSigningKeyGeneration: number | null;
  hostAuthorizationRevision: number | null;
  roomId: string;
  selectedCoordinateDigest: Uint8Array;
  selectedCount: number;
  eligibleCount: number;
  issuedAt: Date;
  expiresAt: Date;
}>): Uint8Array {
  for (const [name, value] of [
    ["clientRequestKey", input.clientRequestKey],
    ["subjectHumanId", input.subjectHumanId],
    ["roomId", input.roomId],
  ] as const) {
    if (typeof value !== "string" || value.length === 0 || value.length > 255) {
      throw new TypeError(`${name} is invalid`);
    }
  }
  if ((input.readerDeviceId === null) !==
      (input.readerDeviceSigningKeyGeneration === null) ||
    (input.readerDeviceId === null) !==
      (input.hostAuthorizationRevision === null)) {
    throw new TypeError("History-read planned device coordinates are incomplete");
  }
  if (input.readerDeviceId !== null && (
    input.readerDeviceId.length === 0 || input.readerDeviceId.length > 255 ||
    !Number.isSafeInteger(input.readerDeviceSigningKeyGeneration) ||
    (input.readerDeviceSigningKeyGeneration as number) <= 0
  )) throw new TypeError("History-read planned device coordinates are invalid");
  if (input.hostAuthorizationRevision !== null &&
    (!Number.isSafeInteger(input.hostAuthorizationRevision) ||
      input.hostAuthorizationRevision < 0)) {
    throw new TypeError("History-read host authorization revision is invalid");
  }
  if (!Number.isSafeInteger(input.selectedCount) || input.selectedCount <= 0 ||
    input.selectedCount > ENCRYPTION_TRANSITION_HISTORY_READ_MAX_SELECTED_COUNT) {
    throw new RangeError("History-read selected count is invalid");
  }
  if (!Number.isSafeInteger(input.eligibleCount) || input.eligibleCount < 0 ||
    input.eligibleCount > input.selectedCount ||
    input.eligibleCount > ENCRYPTION_TRANSITION_HISTORY_READ_MAX_ELIGIBLE_COUNT) {
    throw new RangeError("History-read eligible count is invalid");
  }
  const ttl = input.expiresAt.getTime() - input.issuedAt.getTime();
  if (!Number.isFinite(input.issuedAt.getTime()) ||
    !Number.isFinite(input.expiresAt.getTime()) || ttl <= 0 ||
    ttl > ENCRYPTION_TRANSITION_HISTORY_READ_ADMISSION_MAX_TTL_MS) {
    throw new RangeError("History-read admission expiry is outside its bound");
  }
  return exactDigest(input.selectedCoordinateDigest, "selectedCoordinateDigest");
}

function sameHistoryReadPlan(
  row: EncryptionTransitionHistoryReadAdmissionRow,
  input: Readonly<{
    clientRequestKey?: string;
    subjectHumanId: string;
    readerDeviceId: string | null;
    readerDeviceSigningKeyGeneration: number | null;
    hostAuthorizationRevision: number | null;
    roomId: string;
    selectedCoordinateDigest: Uint8Array;
    selectedCount: number;
    eligibleCount: number;
  }>,
): boolean {
  return row.subjectHumanId === input.subjectHumanId &&
    (input.clientRequestKey === undefined ||
      row.clientRequestKey === input.clientRequestKey) &&
    row.readerDeviceId === input.readerDeviceId &&
    row.readerDeviceSigningKeyGeneration ===
      input.readerDeviceSigningKeyGeneration &&
    row.hostAuthorizationRevision === input.hostAuthorizationRevision &&
    row.roomId === input.roomId && row.selectedCount === input.selectedCount &&
    row.eligibleCount === input.eligibleCount &&
    equalBytes(row.selectedCoordinateDigest, input.selectedCoordinateDigest);
}

async function pruneHistoryReadAdmissionsInTransaction(
  tx: EncryptionTransitionObservationTransaction,
  policy: EncryptionTransitionPolicyRow,
  now: Date,
): Promise<void> {
  const bounds = observationBoundsFromPolicyRow(policy);
  const retentionCutoff = new Date(now.getTime() - bounds.retentionMs);
  await tx.delete(encryptionTransitionHistoryReadAdmissions).where(and(
    ne(encryptionTransitionHistoryReadAdmissions.state, "planned"),
    lt(encryptionTransitionHistoryReadAdmissions.updatedAt, retentionCutoff),
  ));
  const [row] = await tx.select({ count: count() })
    .from(encryptionTransitionHistoryReadAdmissions);
  if (!row || !Number.isSafeInteger(row.count) || row.count < 0) {
    throw new Error("History-read admission count is unavailable");
  }
  const overflow = row.count - bounds.storageLimitRows + 1;
  if (overflow <= 0) return;
  await tx.execute(sql`
    delete from ${encryptionTransitionHistoryReadAdmissions}
    where ${encryptionTransitionHistoryReadAdmissions.operationId} in (
      select ${encryptionTransitionHistoryReadAdmissions.operationId}
      from ${encryptionTransitionHistoryReadAdmissions}
      where ${encryptionTransitionHistoryReadAdmissions.state} <> 'planned'
      order by ${encryptionTransitionHistoryReadAdmissions.updatedAt} asc,
        ${encryptionTransitionHistoryReadAdmissions.operationId} asc
      limit ${overflow}
    )
  `);
  const [remaining] = await tx.select({ count: count() })
    .from(encryptionTransitionHistoryReadAdmissions);
  if (!remaining || remaining.count >= bounds.storageLimitRows) {
    throw new Error("History-read admission capacity is exhausted");
  }
}

async function projectHistoryReadCountsInTransaction(
  tx: EncryptionTransitionObservationTransaction,
  policy: EncryptionTransitionPolicyRow,
  input: Readonly<{
    counts: EncryptionTransitionHistoryReadResultCounts;
    observedAt: Date;
    issuedAt: Date;
  }>,
): Promise<void> {
  const projections: readonly Readonly<{
    count: number;
    outcome: EncryptionTransitionOutcome;
    reason: EncryptionTransitionReason;
  }>[] = [
    { count: input.counts.verified, outcome: "verified", reason: "none" },
    { count: input.counts.clientCryptoUnavailable, outcome: "unavailable", reason: "client_crypto_unavailable" },
    { count: input.counts.clientCustodyUnavailable, outcome: "unavailable", reason: "client_custody_unavailable" },
    { count: input.counts.currentReadAuthorityUnavailable, outcome: "unavailable", reason: "current_read_authority_unavailable" },
    { count: input.counts.retainedKeyMaterialUnavailable, outcome: "unavailable", reason: "retained_key_material_unavailable" },
    { count: input.counts.signerEvidenceUnavailable, outcome: "unavailable", reason: "signer_evidence_unavailable" },
    { count: input.counts.liveShadowLifecycleUnavailable, outcome: "unavailable", reason: "live_shadow_lifecycle_unavailable" },
    { count: input.counts.integrityFailure, outcome: "failed", reason: "integrity_failure" },
    { count: input.counts.parityMismatch, outcome: "failed", reason: "parity_mismatch" },
  ];
  const latencyMs = Math.max(0, input.observedAt.getTime() - input.issuedAt.getTime());
  for (const projection of projections) {
    if (projection.count === 0) continue;
    await recordObservationInTransaction(tx, policy, {
      family: "message",
      operation: "read",
      outcome: projection.outcome,
      reason: projection.reason,
      observedAt: input.observedAt,
      latencyMs,
      attemptCount: projection.count,
    });
  }
}

/**
 * Issue or retry one explicit Browser history-read admission. A retry rotates
 * the bearer token digest on the same planned row; changed selection or
 * authority coordinates conflict instead of creating a second denominator.
 */
export async function issueEncryptionTransitionHistoryReadAdmission(
  db: EncryptionTransitionObservationDb,
  input: Readonly<{
    clientRequestKey: string;
    subjectHumanId: string;
    readerDeviceId: string | null;
    readerDeviceSigningKeyGeneration: number | null;
    hostAuthorizationRevision: number | null;
    roomId: string;
    selectedCoordinateDigest: Uint8Array;
    selectedCount: number;
    eligibleCount: number;
    issuedAt: Date;
    expiresAt: Date;
  }>,
): Promise<EncryptionTransitionHistoryReadAdmission> {
  const selectedCoordinateDigest = assertHistoryReadPlanInput(input);
  const token = new Uint8Array(randomBytes(
    ENCRYPTION_TRANSITION_HISTORY_READ_ADMISSION_TOKEN_BYTES,
  ));
  const tokenDigest = sha256(token);
  try {
    return await db.transaction(async (tx) => {
      const policy = await loadLockedProtectedEpochPolicy(tx);
      await reconcileExpiredHistoryReadAdmissionsInTransaction(tx, policy, input.issuedAt);
      await tx.delete(encryptionTransitionHistoryReadAdmissions).where(
        ne(encryptionTransitionHistoryReadAdmissions.policyRevision, policy.revision),
      );
      const [existing] = await tx.select()
        .from(encryptionTransitionHistoryReadAdmissions)
        .where(and(
          eq(encryptionTransitionHistoryReadAdmissions.policyRevision, policy.revision),
          eq(encryptionTransitionHistoryReadAdmissions.subjectHumanId, input.subjectHumanId),
          eq(encryptionTransitionHistoryReadAdmissions.clientRequestKey, input.clientRequestKey),
        )).limit(1).for("update");
      if (existing) {
        if (!sameHistoryReadPlan(existing, { ...input, selectedCoordinateDigest })) {
          throw new Error("History-read client request key conflicts with its planned page");
        }
        if (existing.state !== "planned" || existing.expiresAt <= input.issuedAt) {
          token.fill(0);
          return {
            status: "terminal" as const,
            operationId: existing.operationId,
            policyRevision: existing.policyRevision,
            issuedAt: existing.issuedAt,
            expiresAt: existing.expiresAt,
            terminalState: existing.state === "planned"
              ? "expired" as const
              : existing.state,
            replayed: true,
          };
        }
        await tx.update(encryptionTransitionHistoryReadAdmissions).set({
          tokenDigest,
          updatedAt: input.issuedAt,
        }).where(and(
          eq(encryptionTransitionHistoryReadAdmissions.operationId, existing.operationId),
          eq(encryptionTransitionHistoryReadAdmissions.state, "planned"),
        ));
        return {
          status: "planned" as const,
          operationId: existing.operationId,
          token,
          policyRevision: policy.revision,
          issuedAt: existing.issuedAt,
          expiresAt: existing.expiresAt,
          replayed: true,
        };
      }
      await pruneHistoryReadAdmissionsInTransaction(tx, policy, input.issuedAt);
      const operationId = randomUUID();
      await tx.insert(encryptionTransitionHistoryReadAdmissions).values({
        operationId,
        clientRequestKey: input.clientRequestKey,
        policyRevision: policy.revision,
        subjectHumanId: input.subjectHumanId,
        readerDeviceId: input.readerDeviceId,
        readerDeviceSigningKeyGeneration: input.readerDeviceSigningKeyGeneration,
        hostAuthorizationRevision: input.hostAuthorizationRevision,
        roomId: input.roomId,
        selectedCoordinateDigest,
        selectedCount: input.selectedCount,
        eligibleCount: input.eligibleCount,
        tokenDigest,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        updatedAt: input.issuedAt,
      });
      return {
        status: "planned" as const,
        operationId,
        token,
        policyRevision: policy.revision,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        replayed: false,
      };
    });
  } finally {
    selectedCoordinateDigest.fill(0);
    tokenDigest.fill(0);
  }
}

function terminalReplayMatches(
  admission: EncryptionTransitionHistoryReadAdmissionRow,
  kind:
    | "signed_acknowledgement"
    | "unavailable_token"
    | "server_unavailable"
    | "ineligible",
  acknowledgementDigest: Uint8Array | null,
  counts: EncryptionTransitionHistoryReadResultCounts,
): boolean {
  return admission.state === "consumed" && admission.consumptionKind === kind &&
    (acknowledgementDigest === null
      ? admission.acknowledgementDigest === null
      : admission.acknowledgementDigest !== null &&
        equalBytes(admission.acknowledgementDigest, acknowledgementDigest)) &&
    HISTORY_READ_COUNT_FIELDS.every((field) => {
      const rowField = `${field}Count` as keyof EncryptionTransitionHistoryReadAdmissionRow;
      return admission[rowField] === counts[field];
    });
}

async function consumeHistoryReadAdmission(
  db: EncryptionTransitionObservationDb,
  input: Readonly<{
    token: Uint8Array;
    operationId: string;
    clientRequestKey: string;
    policyRevision: number;
    subjectHumanId: string;
    readerDeviceId: string | null;
    readerDeviceSigningKeyGeneration: number | null;
    hostAuthorizationRevision: number | null;
    roomId: string;
    selectedCoordinateDigest: Uint8Array;
    selectedCount: number;
    eligibleCount: number;
    counts: EncryptionTransitionHistoryReadResultCounts;
    consumptionKind:
      | "signed_acknowledgement"
      | "unavailable_token"
      | "server_unavailable"
      | "ineligible";
    acknowledgementDigest: Uint8Array | null;
    orderedResultSetDigest: Uint8Array | null;
    issuedAt: Date;
    deadlineAt: Date;
    observedAt: Date;
  }>,
): Promise<EncryptionTransitionHistoryReadAdmissionConsumption> {
  if (!(input.token instanceof Uint8Array) || input.token.byteLength !==
    ENCRYPTION_TRANSITION_HISTORY_READ_ADMISSION_TOKEN_BYTES) {
    throw new TypeError("History-read admission token must be exactly 32 bytes");
  }
  if (typeof input.operationId !== "string" || input.operationId.length === 0 ||
    input.operationId.length > 255 || !Number.isSafeInteger(input.policyRevision) ||
    input.policyRevision <= 0 || !Number.isFinite(input.observedAt.getTime())) {
    throw new TypeError("History-read consumption coordinates are invalid");
  }
  const selectedCoordinateDigest = assertHistoryReadPlanInput({
    clientRequestKey: input.clientRequestKey,
    subjectHumanId: input.subjectHumanId,
    readerDeviceId: input.readerDeviceId,
    readerDeviceSigningKeyGeneration: input.readerDeviceSigningKeyGeneration,
    hostAuthorizationRevision: input.hostAuthorizationRevision,
    roomId: input.roomId,
    selectedCoordinateDigest: input.selectedCoordinateDigest,
    selectedCount: input.selectedCount,
    eligibleCount: input.eligibleCount,
    issuedAt: input.issuedAt,
    expiresAt: input.deadlineAt,
  });
  const acknowledgementDigest = input.acknowledgementDigest === null
    ? null
    : exactDigest(input.acknowledgementDigest, "acknowledgementDigest");
  const orderedResultSetDigest = input.orderedResultSetDigest === null
    ? null
    : exactDigest(input.orderedResultSetDigest, "orderedResultSetDigest");
  const counts = exactHistoryReadCounts(input.counts, input.eligibleCount);
  const tokenDigest = sha256(input.token);
  try {
    return await db.transaction(async (tx) => {
      const policy = await loadLockedProtectedEpochPolicy(tx);
      await reconcileExpiredHistoryReadAdmissionsInTransaction(tx, policy, input.observedAt);
      const [admission] = await tx.select()
        .from(encryptionTransitionHistoryReadAdmissions)
        .where(eq(encryptionTransitionHistoryReadAdmissions.operationId, input.operationId))
        .limit(1).for("update");
      if (!admission || admission.policyRevision !== policy.revision ||
        admission.policyRevision !== input.policyRevision) {
        return { status: "unavailable" as const };
      }
      const exactPlan = equalBytes(admission.tokenDigest, tokenDigest) &&
        admission.issuedAt.getTime() === input.issuedAt.getTime() &&
        admission.expiresAt.getTime() === input.deadlineAt.getTime() &&
        sameHistoryReadPlan(admission, { ...input, selectedCoordinateDigest });
      if (admission.state !== "planned") {
        return exactPlan && terminalReplayMatches(
          admission,
          input.consumptionKind,
          acknowledgementDigest,
          counts,
        )
          ? { status: "replayed" as const }
          : { status: "conflict" as const };
      }
      if (admission.expiresAt <= input.observedAt || !exactPlan) {
        return { status: "conflict" as const };
      }
      if (input.consumptionKind === "signed_acknowledgement" && (
        input.readerDeviceId === null ||
        input.readerDeviceSigningKeyGeneration === null ||
        input.hostAuthorizationRevision === null ||
        acknowledgementDigest === null || orderedResultSetDigest === null
      )) throw new TypeError("Signed history-read consumption lacks planned device evidence");
      if (input.consumptionKind === "unavailable_token" && (
        acknowledgementDigest !== null || orderedResultSetDigest !== null ||
        counts.verified !== 0 || counts.currentReadAuthorityUnavailable !== 0 ||
        counts.retainedKeyMaterialUnavailable !== 0 ||
        counts.signerEvidenceUnavailable !== 0 ||
        counts.liveShadowLifecycleUnavailable !== 0 ||
        counts.integrityFailure !== 0 || counts.parityMismatch !== 0 ||
        !(
          counts.clientCryptoUnavailable === input.eligibleCount ||
          counts.clientCustodyUnavailable === input.eligibleCount
        )
      )) throw new TypeError("Unavailable token may report only one custody outcome");
      if (input.consumptionKind === "server_unavailable" && (
        acknowledgementDigest !== null || orderedResultSetDigest !== null ||
        counts.verified !== 0 || counts.clientCustodyUnavailable !== 0 ||
        counts.integrityFailure !== 0 || counts.parityMismatch !== 0 ||
        !(
          counts.clientCryptoUnavailable === input.eligibleCount ||
          counts.currentReadAuthorityUnavailable === input.eligibleCount ||
          counts.retainedKeyMaterialUnavailable === input.eligibleCount ||
          counts.signerEvidenceUnavailable === input.eligibleCount ||
          counts.liveShadowLifecycleUnavailable === input.eligibleCount
        )
      )) throw new TypeError("Server history-read projection has an invalid outcome");
      if (input.consumptionKind === "ineligible" && (
        input.eligibleCount !== 0 || input.readerDeviceId !== null ||
        acknowledgementDigest !== null || orderedResultSetDigest !== null ||
        HISTORY_READ_COUNT_FIELDS.some((field) => counts[field] !== 0)
      )) throw new TypeError("Ineligible history-read page has invalid evidence");
      const updated = await tx.update(encryptionTransitionHistoryReadAdmissions)
        .set({
          state: "consumed",
          consumptionKind: input.consumptionKind,
          acknowledgementDigest,
          orderedResultSetDigest,
          verifiedCount: counts.verified,
          clientCryptoUnavailableCount: counts.clientCryptoUnavailable,
          clientCustodyUnavailableCount: counts.clientCustodyUnavailable,
          currentReadAuthorityUnavailableCount:
            counts.currentReadAuthorityUnavailable,
          retainedKeyMaterialUnavailableCount:
            counts.retainedKeyMaterialUnavailable,
          signerEvidenceUnavailableCount: counts.signerEvidenceUnavailable,
          liveShadowLifecycleUnavailableCount:
            counts.liveShadowLifecycleUnavailable,
          integrityFailureCount: counts.integrityFailure,
          parityMismatchCount: counts.parityMismatch,
          terminalAt: input.observedAt,
          updatedAt: input.observedAt,
        }).where(and(
          eq(encryptionTransitionHistoryReadAdmissions.operationId, input.operationId),
          eq(encryptionTransitionHistoryReadAdmissions.state, "planned"),
        )).returning({
          operationId: encryptionTransitionHistoryReadAdmissions.operationId,
        });
      if (updated.length !== 1) return { status: "conflict" as const };
      await projectHistoryReadCountsInTransaction(tx, policy, {
        counts,
        observedAt: input.observedAt,
        issuedAt: admission.issuedAt,
      });
      return { status: "accepted" as const };
    });
  } finally {
    selectedCoordinateDigest.fill(0);
    acknowledgementDigest?.fill(0);
    orderedResultSetDigest?.fill(0);
    tokenDigest.fill(0);
  }
}

/** Consume an already cryptographically verified acknowledgement exactly once. */
export function consumeSignedEncryptionTransitionHistoryReadAcknowledgement(
  db: EncryptionTransitionObservationDb,
  input: Omit<
    Parameters<typeof consumeHistoryReadAdmission>[1],
    "consumptionKind"
  >,
): Promise<EncryptionTransitionHistoryReadAdmissionConsumption> {
  return consumeHistoryReadAdmission(db, {
    ...input,
    consumptionKind: "signed_acknowledgement",
  });
}

/** Consume a pre-signing missing-crypto/custody failure exactly once. */
export function consumeUnavailableEncryptionTransitionHistoryReadAdmission(
  db: EncryptionTransitionObservationDb,
  input: Omit<
    Parameters<typeof consumeHistoryReadAdmission>[1],
    "consumptionKind" | "acknowledgementDigest" | "orderedResultSetDigest"
  >,
): Promise<EncryptionTransitionHistoryReadAdmissionConsumption> {
  return consumeHistoryReadAdmission(db, {
    ...input,
    consumptionKind: "unavailable_token",
    acknowledgementDigest: null,
    orderedResultSetDigest: null,
  });
}

/** Record one explicit Browser page that contained no protected siblings. */
export function consumeIneligibleEncryptionTransitionHistoryReadAdmission(
  db: EncryptionTransitionObservationDb,
  input: Omit<
    Parameters<typeof consumeHistoryReadAdmission>[1],
    | "consumptionKind"
    | "acknowledgementDigest"
    | "orderedResultSetDigest"
    | "counts"
  >,
): Promise<EncryptionTransitionHistoryReadAdmissionConsumption> {
  const counts: EncryptionTransitionHistoryReadResultCounts = {
    verified: 0,
    clientCryptoUnavailable: 0,
    clientCustodyUnavailable: 0,
    currentReadAuthorityUnavailable: 0,
    retainedKeyMaterialUnavailable: 0,
    signerEvidenceUnavailable: 0,
    liveShadowLifecycleUnavailable: 0,
    integrityFailure: 0,
    parityMismatch: 0,
  };
  return consumeHistoryReadAdmission(db, {
    ...input,
    readerDeviceId: null,
    readerDeviceSigningKeyGeneration: null,
    hostAuthorizationRevision: null,
    eligibleCount: 0,
    counts,
    consumptionKind: "ineligible",
    acknowledgementDigest: null,
    orderedResultSetDigest: null,
  });
}

export const ENCRYPTION_TRANSITION_HISTORY_READ_SERVER_UNAVAILABLE_REASONS = [
  "client_crypto_unavailable",
  "current_read_authority_unavailable",
  "retained_key_material_unavailable",
  "signer_evidence_unavailable",
  "live_shadow_lifecycle_unavailable",
] as const;
export type EncryptionTransitionHistoryReadServerUnavailableReason =
  typeof ENCRYPTION_TRANSITION_HISTORY_READ_SERVER_UNAVAILABLE_REASONS[number];

/**
 * Consume a just-issued admission for one uniform server-proved unavailable
 * page. This helper cannot create a verified or failed numerator and does not
 * impersonate a device acknowledgement.
 */
export function consumeServerUnavailableEncryptionTransitionHistoryReadAdmission(
  db: EncryptionTransitionObservationDb,
  input: Omit<
    Parameters<typeof consumeHistoryReadAdmission>[1],
    | "consumptionKind"
    | "acknowledgementDigest"
    | "orderedResultSetDigest"
    | "counts"
  > & Readonly<{
    reason: EncryptionTransitionHistoryReadServerUnavailableReason;
  }>,
): Promise<EncryptionTransitionHistoryReadAdmissionConsumption> {
  if (!ENCRYPTION_TRANSITION_HISTORY_READ_SERVER_UNAVAILABLE_REASONS.includes(
    input.reason,
  )) throw new TypeError("Server history-read unavailable reason is invalid");
  const counts: EncryptionTransitionHistoryReadResultCounts = {
    verified: 0,
    clientCryptoUnavailable: input.reason === "client_crypto_unavailable"
      ? input.eligibleCount
      : 0,
    clientCustodyUnavailable: 0,
    currentReadAuthorityUnavailable:
      input.reason === "current_read_authority_unavailable"
        ? input.eligibleCount
        : 0,
    retainedKeyMaterialUnavailable:
      input.reason === "retained_key_material_unavailable"
        ? input.eligibleCount
        : 0,
    signerEvidenceUnavailable: input.reason === "signer_evidence_unavailable"
      ? input.eligibleCount
      : 0,
    liveShadowLifecycleUnavailable:
      input.reason === "live_shadow_lifecycle_unavailable"
        ? input.eligibleCount
        : 0,
    integrityFailure: 0,
    parityMismatch: 0,
  };
  const { reason: _reason, ...coordinates } = input;
  return consumeHistoryReadAdmission(db, {
    ...coordinates,
    counts,
    consumptionKind: "server_unavailable",
    acknowledgementDigest: null,
    orderedResultSetDigest: null,
  });
}

async function reconcileExpiredHistoryReadAdmissionsInTransaction(
  tx: EncryptionTransitionObservationTransaction,
  policy: EncryptionTransitionPolicyRow,
  now: Date,
): Promise<number> {
  const bounds = observationBoundsFromPolicyRow(policy);
  const expired = await tx.select()
    .from(encryptionTransitionHistoryReadAdmissions)
    .where(and(
      eq(encryptionTransitionHistoryReadAdmissions.policyRevision, policy.revision),
      eq(encryptionTransitionHistoryReadAdmissions.state, "planned"),
      lte(encryptionTransitionHistoryReadAdmissions.expiresAt, now),
    )).limit(bounds.storageLimitRows).for("update");
  for (const admission of expired) {
    const updated = await tx.update(encryptionTransitionHistoryReadAdmissions)
      .set({
        state: "expired",
        consumptionKind: "expiry",
        clientObservationExpiredCount: admission.eligibleCount,
        terminalAt: admission.expiresAt,
        updatedAt: admission.expiresAt,
      }).where(and(
        eq(encryptionTransitionHistoryReadAdmissions.operationId, admission.operationId),
        eq(encryptionTransitionHistoryReadAdmissions.state, "planned"),
      )).returning({
        operationId: encryptionTransitionHistoryReadAdmissions.operationId,
      });
    if (updated.length !== 1) continue;
    await recordObservationInTransaction(tx, policy, {
      family: "message",
      operation: "read",
      outcome: "unavailable",
      reason: "client_observation_expired",
      observedAt: admission.expiresAt,
      latencyMs: Math.max(
        0,
        admission.expiresAt.getTime() - admission.issuedAt.getTime(),
      ),
      attemptCount: admission.eligibleCount,
    });
  }
  return expired.length;
}

/** Terminalize abandoned history-read pages without erasing cumulative totals. */
export async function reconcileExpiredEncryptionTransitionHistoryReadAdmissions(
  db: EncryptionTransitionObservationDb,
  input: Readonly<{ now?: Date }> = {},
): Promise<number> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("now must be valid");
  return db.transaction(async (tx) => {
    const policy = await loadLockedProtectedEpochPolicy(tx);
    const count = await reconcileExpiredHistoryReadAdmissionsInTransaction(
      tx,
      policy,
      now,
    );
    await pruneHistoryReadAdmissionsInTransaction(tx, policy, now);
    return count;
  });
}

/**
 * User-facing page activity is deliberately separate from the eligible-row
 * success denominator. It proves whether Browser history was requested even
 * when a selected page contained zero protected siblings.
 */
export async function readEncryptionTransitionHistoryReadActivity(
  db: Database,
): Promise<EncryptionTransitionHistoryReadActivity> {
  const [policy] = await db.select({ revision: encryptionTransitionPolicy.revision })
    .from(encryptionTransitionPolicy).limit(1);
  if (!policy) {
    return Object.freeze({
      pagesAttempted: 0n,
      pagesPending: 0n,
      selectedRows: 0n,
      eligibleRows: 0n,
      pendingEligibleRows: 0n,
    });
  }
  const [row] = await db.select({
    pagesAttempted: sql<string>`count(*)::text`,
    pagesPending:
      sql<string>`count(*) filter (where ${encryptionTransitionHistoryReadAdmissions.state} = 'planned')::text`,
    selectedRows:
      sql<string>`coalesce(sum(${encryptionTransitionHistoryReadAdmissions.selectedCount}), 0)::text`,
    eligibleRows:
      sql<string>`coalesce(sum(${encryptionTransitionHistoryReadAdmissions.eligibleCount}), 0)::text`,
    pendingEligibleRows:
      sql<string>`coalesce(sum(${encryptionTransitionHistoryReadAdmissions.eligibleCount}) filter (where ${encryptionTransitionHistoryReadAdmissions.state} = 'planned'), 0)::text`,
  }).from(encryptionTransitionHistoryReadAdmissions).where(
    eq(encryptionTransitionHistoryReadAdmissions.policyRevision, policy.revision),
  );
  return Object.freeze({
    pagesAttempted: BigInt(row?.pagesAttempted ?? "0"),
    pagesPending: BigInt(row?.pagesPending ?? "0"),
    selectedRows: BigInt(row?.selectedRows ?? "0"),
    eligibleRows: BigInt(row?.eligibleRows ?? "0"),
    pendingEligibleRows: BigInt(row?.pendingEligibleRows ?? "0"),
  });
}
