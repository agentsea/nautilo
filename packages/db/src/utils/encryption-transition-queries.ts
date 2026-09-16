import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../config/database";
import {
  encryptionTransitionPolicy,
  ENCRYPTION_TRANSITION_MODES,
  ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1,
  type EncryptionTransitionPolicyRow,
} from "../schema/encryption-transition";

const SERVER_POLICY_ID = "server";

export const LIVE_SHADOW_ENCRYPTION_TRANSITION_MODES = [
  "plaintext_only",
  "shadow_encryption",
  "encrypted_only",
] as const;
export type LiveShadowEncryptionTransitionMode =
  (typeof LIVE_SHADOW_ENCRYPTION_TRANSITION_MODES)[number];
export type LiveShadowEncryptionTransitionBehavior = "fallback" | "strict";

export interface LiveShadowEncryptionTransitionPolicy {
  readonly mode: LiveShadowEncryptionTransitionMode;
  readonly shadowBehavior: LiveShadowEncryptionTransitionBehavior;
  readonly revision: number;
  readonly shadowEncryptionStartedAt: Date | null;
  readonly updatedAt: Date;
}

export type EncryptionTransitionPolicyDb = Pick<
  Database,
  "select" | "update"
>;

type EncryptionPublicationTransaction = Pick<Database, "select" | "execute">;

/**
 * A transaction-scoped lock, not another policy store. Shared publication
 * locks permit unrelated Rooms to commit concurrently; only an Admin policy
 * change takes the exclusive lock. Every caller must acquire it before Room
 * or entity locks and must finish crypto/provider work before this transaction.
 */
async function lockEncryptionPolicy(
  tx: Pick<Database, "execute">,
  publication: boolean,
): Promise<void> {
  await tx.execute(publication
    ? sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('nautilo:encryption-transition-policy:v1', 0))`
    : sql`SELECT pg_advisory_xact_lock(hashtextextended('nautilo:encryption-transition-policy:v1', 0))`);
}

export class EncryptionPublicationPolicyError extends Error {
  constructor(readonly reason: "ordinary_forbidden" | "crypto_forbidden") {
    super(`Encryption publication policy rejected content: ${reason}`);
    this.name = "EncryptionPublicationPolicyError";
  }
}

async function lockAndLoadEncryptionPublicationPolicy(
  tx: EncryptionPublicationTransaction,
): Promise<Readonly<{ mode: string; revision: number }>> {
  await lockEncryptionPolicy(tx, true);
  const [row] = await tx.select({
    mode: encryptionTransitionPolicy.mode,
    revision: encryptionTransitionPolicy.revision,
  }).from(encryptionTransitionPolicy)
    .where(eq(encryptionTransitionPolicy.id, SERVER_POLICY_ID));
  if (row === undefined) throw new Error("Encryption transition singleton is unavailable");
  if (!ENCRYPTION_TRANSITION_MODES.includes(row.mode)) {
    throw new UnsupportedEncryptionTransitionStateError(row.mode);
  }
  return row;
}

/**
 * Current-policy gate for legacy ordinary publication. This deliberately does
 * not claim prepared-revision freshness; callers with a prepared revision must
 * use `acquireEncryptionPublicationFence` instead.
 */
export async function acquireOrdinaryEncryptionPublicationFence(
  tx: EncryptionPublicationTransaction,
): Promise<void> {
  const row = await lockAndLoadEncryptionPublicationPolicy(tx);
  if (row.mode === "encrypted_only") {
    throw new EncryptionPublicationPolicyError("ordinary_forbidden");
  }
}

/** Hold the shared policy lock through a confidential read. Callers must load
 * the body on this same transaction before it completes. */
export async function acquireEncryptionConsumptionFence(
  tx: EncryptionPublicationTransaction,
): Promise<Readonly<{
  mode: LiveShadowEncryptionTransitionMode;
  shadowBehavior: LiveShadowEncryptionTransitionBehavior;
  revision: number;
}>> {
  await lockEncryptionPolicy(tx, true);
  const [row] = await tx.select({
    mode: encryptionTransitionPolicy.mode,
    shadowBehavior: encryptionTransitionPolicy.shadowBehavior,
    revision: encryptionTransitionPolicy.revision,
  }).from(encryptionTransitionPolicy)
    .where(eq(encryptionTransitionPolicy.id, SERVER_POLICY_ID));
  if (row === undefined) throw new Error("Encryption transition singleton is unavailable");
  assertLiveShadowEncryptionTransitionMode(row.mode);
  return row;
}

/** Call inside the existing product/Job/repair transaction before publication. */
export async function acquireEncryptionPublicationFence(
  tx: EncryptionPublicationTransaction,
  input: Readonly<{
    expectedRevision: number;
    representation: "ordinary" | "ordinary_and_protected" | "protected_only";
  }>,
): Promise<void> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new TypeError("expectedRevision must be a non-negative safe integer");
  }
  if (![
    "ordinary", "ordinary_and_protected", "protected_only",
  ].includes(input.representation)) {
    throw new TypeError("Encryption publication representation is invalid");
  }
  const row = await lockAndLoadEncryptionPublicationPolicy(tx);
  if (row.revision !== input.expectedRevision) {
    throw new EncryptionTransitionPolicyConflictError(input.expectedRevision, row.revision);
  }
  if (row.mode === "encrypted_only" && input.representation !== "protected_only") {
    throw new EncryptionPublicationPolicyError("ordinary_forbidden");
  }
  if (row.mode === "plaintext_only" && input.representation !== "ordinary") {
    throw new EncryptionPublicationPolicyError("crypto_forbidden");
  }
}

export class UnsupportedEncryptionTransitionStateError extends Error {
  constructor(readonly mode: string) {
    super(`Encryption transition mode is not supported by this server: ${mode}`);
    this.name = "UnsupportedEncryptionTransitionStateError";
  }
}

export class EncryptionTransitionPolicyConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Encryption transition policy revision ${expectedRevision} is stale; ` +
      `current revision is ${actualRevision}`,
    );
    this.name = "EncryptionTransitionPolicyConflictError";
  }
}

export interface DurableEncryptionTransitionObservationBounds {
  readonly revision: number;
  readonly bucketWidthMs: number;
  readonly retentionMs: number;
  readonly storageLimitRows: number;
  readonly latencyUpperBoundsMs: readonly number[];
  readonly configuredAt: Date;
}

export function observationBoundsFromPolicyRow(
  row: EncryptionTransitionPolicyRow,
): DurableEncryptionTransitionObservationBounds {
  const latency = row.observationLatencyUpperBoundsMs;
  if (
    row.observationBoundsRevision !==
      ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.revision ||
    row.observationBucketWidthMs !==
      ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.bucketWidthMs ||
    row.observationRetentionMs !==
      ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.retentionMs ||
    row.observationStorageLimitRows !==
      ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.storageLimitRows ||
    latency.length !==
      ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.latencyUpperBoundsMs.length ||
    latency.some((value, index) =>
      value !== ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1
        .latencyUpperBoundsMs[index]
    )
  ) throw new Error("Encryption transition observation bounds are incoherent");
  return {
    revision: row.observationBoundsRevision,
    bucketWidthMs: row.observationBucketWidthMs,
    retentionMs: row.observationRetentionMs,
    storageLimitRows: row.observationStorageLimitRows,
    latencyUpperBoundsMs: [...latency],
    configuredAt: row.observationBoundsConfiguredAt,
  };
}

export function assertLiveShadowEncryptionTransitionMode(
  mode: string,
): LiveShadowEncryptionTransitionMode {
  if (mode === "plaintext_only" || mode === "shadow_encryption"
    || mode === "encrypted_only") return mode;
  throw new UnsupportedEncryptionTransitionStateError(mode);
}

export function assertLiveShadowEncryptionTransitionBehavior(
  behavior: string,
): LiveShadowEncryptionTransitionBehavior {
  if (behavior === "fallback" || behavior === "strict") return behavior;
  throw new UnsupportedEncryptionTransitionStateError(behavior);
}

export function projectLiveShadowEncryptionTransitionPolicy(
  row: EncryptionTransitionPolicyRow,
): LiveShadowEncryptionTransitionPolicy {
  observationBoundsFromPolicyRow(row);
  const mode = assertLiveShadowEncryptionTransitionMode(row.mode);
  const shadowBehavior = assertLiveShadowEncryptionTransitionBehavior(
    row.shadowBehavior,
  );
  if (mode === "plaintext_only" && shadowBehavior !== "fallback") {
    throw new UnsupportedEncryptionTransitionStateError(
      `${mode}/${shadowBehavior}`,
    );
  }
  return {
    mode,
    shadowBehavior,
    revision: row.revision,
    shadowEncryptionStartedAt: row.shadowEncryptionStartedAt,
    updatedAt: row.updatedAt,
  };
}

async function loadPolicyRow(
  db: EncryptionTransitionPolicyDb,
): Promise<EncryptionTransitionPolicyRow> {
  const [row] = await db.select()
    .from(encryptionTransitionPolicy)
    .where(eq(encryptionTransitionPolicy.id, SERVER_POLICY_ID))
    .limit(1);
  if (!row) throw new Error("Encryption transition singleton is unavailable");
  return row;
}

export async function getEncryptionTransitionPolicy(
  db: EncryptionTransitionPolicyDb,
): Promise<LiveShadowEncryptionTransitionPolicy> {
  return projectLiveShadowEncryptionTransitionPolicy(await loadPolicyRow(db));
}

async function compareAndSwapEncryptionTransitionPolicyInTransaction(
  db: EncryptionTransitionPolicyDb,
  input: Readonly<{
    expectedRevision: number;
    targetMode: LiveShadowEncryptionTransitionMode;
    targetShadowBehavior: LiveShadowEncryptionTransitionBehavior;
    now?: Date;
  }>,
): Promise<LiveShadowEncryptionTransitionPolicy> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new TypeError("expectedRevision must be a non-negative safe integer");
  }
  const targetMode = assertLiveShadowEncryptionTransitionMode(input.targetMode);
  const requestedShadowBehavior = assertLiveShadowEncryptionTransitionBehavior(
    input.targetShadowBehavior,
  );
  if (targetMode === "plaintext_only" && requestedShadowBehavior !== "fallback") {
    throw new TypeError("plaintext_only requires fallback Shadow behavior");
  }
  const targetShadowBehavior = requestedShadowBehavior;
  const current = await loadPolicyRow(db);
  // Reserved/unknown durable values fail before any attempted downgrade.
  const currentPolicy = projectLiveShadowEncryptionTransitionPolicy(current);
  const currentMode = currentPolicy.mode;
  if (current.revision !== input.expectedRevision) {
    throw new EncryptionTransitionPolicyConflictError(
      input.expectedRevision,
      current.revision,
    );
  }
  if (
    currentMode === targetMode
    && current.shadowBehavior === targetShadowBehavior
  ) return currentPolicy;

  // Fail closed if durable operational bounds diverge from reviewed v1.
  observationBoundsFromPolicyRow(current);

  const now = input.now ?? new Date();
  const [updated] = await db.update(encryptionTransitionPolicy)
    .set({
      mode: targetMode,
      shadowBehavior: targetShadowBehavior,
      revision: current.revision + 1,
      // The existing protected-observation epoch covers both Shadow and Full.
      // Keeping it null in Full hides real protected attempts from dashboards.
      shadowEncryptionStartedAt: targetMode !== "plaintext_only"
        ? currentMode !== "plaintext_only"
          ? current.shadowEncryptionStartedAt ?? now
          : now
        : null,
      updatedAt: now,
    })
    .where(and(
      eq(encryptionTransitionPolicy.id, SERVER_POLICY_ID),
      eq(encryptionTransitionPolicy.revision, current.revision),
      eq(encryptionTransitionPolicy.mode, currentMode),
    ))
    .returning();
  if (updated) return projectLiveShadowEncryptionTransitionPolicy(updated);

  const latest = await loadPolicyRow(db);
  // If direct corruption introduced a reserved value, preserve fail-closed
  // behavior rather than describing it as an ordinary concurrent change.
  assertLiveShadowEncryptionTransitionMode(latest.mode);
  throw new EncryptionTransitionPolicyConflictError(
    input.expectedRevision,
    latest.revision,
  );
}

/** Serialize Admin CAS with publications without retaining locks during crypto. */
export async function compareAndSwapEncryptionTransitionPolicy(
  db: EncryptionTransitionPolicyDb & Pick<Database, "transaction">,
  input: Parameters<typeof compareAndSwapEncryptionTransitionPolicyInTransaction>[1],
): Promise<LiveShadowEncryptionTransitionPolicy> {
  return db.transaction(async (tx) => {
    await lockEncryptionPolicy(tx, false);
    return compareAndSwapEncryptionTransitionPolicyInTransaction(tx, input);
  });
}
