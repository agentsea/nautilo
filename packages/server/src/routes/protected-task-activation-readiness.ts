import {
  readProtectedTaskActivationProductReadinessInTransaction,
  type LiveShadowEncryptionTransitionPolicy,
  type ProtectedTaskActivationOperationalReadiness,
  type ProtectedTaskActivationProductReadiness,
} from "@nautilo/db";
import type { CryptoPostgresHandle } from "@nautilo/lattice-bridge/server";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

import {
  readProtectedTaskActivationCryptoReadiness,
  type ProtectedTaskActivationCryptoReadiness,
  type ProtectedTaskActivationCryptoReadinessCounts,
} from "./protected-task-activation-crypto-readiness";

export type { ProtectedTaskActivationOperationalReadiness } from "@nautilo/db";

export type ProtectedTaskActivationReadinessContext = Readonly<{
  transaction: CanonicalTranscriptTx;
  current: LiveShadowEncryptionTransitionPolicy;
  requested: Readonly<{
    expectedRevision: number;
    targetMode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
  }>;
  restricted: CryptoPostgresHandle;
  now: Date;
  readOperational(input: Readonly<{
    transaction: CanonicalTranscriptTx;
    policyRevision: number;
    now: Date;
  }>): Promise<ProtectedTaskActivationOperationalReadiness>;
  /** Actively assert the production ports mounted for this held policy. */
  assertCurrentMountedCapabilities(input: Readonly<{
    transaction: CanonicalTranscriptTx;
    policyRevision: number;
    targetMode: "encrypted_only";
  }>): Promise<void>;
  /** Re-prove every parked Job against transcript and physical checkpoint. */
  inspectParkedExecutionIntegrity(input: Readonly<{
    transaction: CanonicalTranscriptTx;
    policyRevision: number;
    expectedJobs: bigint;
    now: Date;
  }>): Promise<Readonly<{
    status: "verified" | "unavailable";
    verifiedJobs: bigint;
  }>>;
}>;

export type ProtectedTaskActivationReadinessFailure =
  | "policy_not_current"
  | "full_not_requested"
  | "product_not_ready"
  | "crypto_not_ready"
  | "runtime_not_ready"
  | "persistence_not_ready"
  | "maintenance_not_drained";

export class ProtectedTaskActivationReadinessError extends Error {
  constructor(readonly reason: ProtectedTaskActivationReadinessFailure) {
    super(`Protected Task activation readiness failed: ${reason}`);
    this.name = "ProtectedTaskActivationReadinessError";
  }
}

type Dependencies = Readonly<{
  readProduct(
    transaction: CanonicalTranscriptTx,
    input: Readonly<{ now: Date }>,
  ): Promise<ProtectedTaskActivationProductReadiness>;
  readCrypto(input: Readonly<{
    transaction: CanonicalTranscriptTx;
    restricted: CryptoPostgresHandle;
    now: Date;
  }>): Promise<ProtectedTaskActivationCryptoReadiness>;
}>;

function fail(reason: ProtectedTaskActivationReadinessFailure): never {
  throw new ProtectedTaskActivationReadinessError(reason);
}

function isZero(value: bigint): boolean {
  return value === 0n;
}

function productReady(value: ProtectedTaskActivationProductReadiness): boolean {
  const definition = value.definitions.blockers;
  const result = value.results.blockers;
  return [
    definition.ordinarySupported,
    definition.artifactDependentCandidates,
    definition.invalidCurrentMapping,
    definition.pendingRevisions,
    definition.completeUnmappedRevisions,
    definition.quarantinedRevisions,
    definition.staleMappingRevisions,
    result.ordinarySupported,
    result.artifactDependentCandidates,
    result.invalidCurrentMapping,
    result.pendingRevisions,
    result.completeUnmappedRevisions,
    result.quarantinedRevisions,
    result.staleMappingRevisions,
    value.operations.blockers.activeBackfillClaims,
    value.operations.blockers.incompleteOutputBindings,
  ].every(isZero);
}

function cryptoCountsReady(value: ProtectedTaskActivationCryptoReadinessCounts): boolean {
  return Object.values(value.blockers).every(isZero);
}

function cryptoReady(value: ProtectedTaskActivationCryptoReadiness): boolean {
  return Object.values(value.objects).every(cryptoCountsReady)
    && Object.values(value.staging).every(cryptoCountsReady);
}

function operationalReady(
  value: ProtectedTaskActivationOperationalReadiness,
  policyRevision: number,
  now: Date,
): ProtectedTaskActivationReadinessFailure | null {
  if (value.policyRevision !== policyRevision) return "policy_not_current";
  const maintenance = value.maintenance;
  if (maintenance.state !== "draining"
    || maintenance.operationId === null
    || maintenance.operationId.length === 0
    || maintenance.leaseExpiresAt === null
    || maintenance.hardExpiresAt === null
    || maintenance.leaseExpiresAt.getTime() <= now.getTime()
    || maintenance.hardExpiresAt.getTime() <= now.getTime()) {
    return "maintenance_not_drained";
  }
  const activity = Object.values(value.activity);
  if (activity.some(count => !Number.isSafeInteger(count) || count < 0)
    || activity.some(count => count !== 0)) {
    return "maintenance_not_drained";
  }
  if (value.persistence.protectedTaskBackedJobs < 0n
    || value.persistence.protectedJobContentViolations < 0n
    || value.persistence.parkedJobsRequiringIntegrityProof < 0n
    || value.persistence.protectedJobContentViolations !== 0n
    || value.persistence.parkedJobsRequiringIntegrityProof
      > value.persistence.protectedTaskBackedJobs) {
    return "persistence_not_ready";
  }
  return null;
}

const productionDependencies: Dependencies = Object.freeze({
  readProduct: readProtectedTaskActivationProductReadinessInTransaction,
  readCrypto: readProtectedTaskActivationCryptoReadiness,
});

/**
 * Full-only assertion held by the exclusive validated policy CAS. The route
 * owns the websocket flush barrier and immediate second activity check.
 */
export function createProtectedTaskActivationReadinessAssertion(
  dependencies: Partial<Dependencies> = {},
) {
  const ports: Dependencies = Object.freeze({
    ...productionDependencies,
    ...dependencies,
  });
  return async (input: ProtectedTaskActivationReadinessContext): Promise<void> => {
    if (!Number.isFinite(input.now.getTime())) fail("policy_not_current");
    if (input.requested.targetMode !== "encrypted_only") fail("full_not_requested");
    if (!Number.isSafeInteger(input.requested.expectedRevision)
      || input.requested.expectedRevision !== input.current.revision) {
      fail("policy_not_current");
    }
    const product = await ports.readProduct(input.transaction, { now: input.now });
    if (!productReady(product)) fail("product_not_ready");
    const crypto = await ports.readCrypto({
      transaction: input.transaction,
      restricted: input.restricted,
      now: input.now,
    });
    if (crypto.observedAt.getTime() !== input.now.getTime() || !cryptoReady(crypto)) {
      fail("crypto_not_ready");
    }
    const operational = await input.readOperational({
      transaction: input.transaction,
      policyRevision: input.current.revision,
      now: input.now,
    });
    const failure = operationalReady(operational, input.current.revision, input.now);
    if (failure !== null) fail(failure);
    try {
      await input.assertCurrentMountedCapabilities({
        transaction: input.transaction,
        policyRevision: input.current.revision,
        targetMode: "encrypted_only",
      });
    } catch {
      fail("runtime_not_ready");
    }
    let integrity: Awaited<ReturnType<
      ProtectedTaskActivationReadinessContext["inspectParkedExecutionIntegrity"]
    >>;
    try {
      integrity = await input.inspectParkedExecutionIntegrity({
        transaction: input.transaction,
        policyRevision: input.current.revision,
        expectedJobs: operational.persistence.parkedJobsRequiringIntegrityProof,
        now: input.now,
      });
    } catch {
      fail("persistence_not_ready");
    }
    if (integrity.status !== "verified"
      || integrity.verifiedJobs
        !== operational.persistence.parkedJobsRequiringIntegrityProof) {
      fail("persistence_not_ready");
    }
  };
}
