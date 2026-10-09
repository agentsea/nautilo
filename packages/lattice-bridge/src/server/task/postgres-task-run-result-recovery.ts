import {
  and,
  eq,
  isNull,
  lockExactProtectedTaskRunResultPublicationInTx,
  lte,
  or,
  sql,
  taskRunResultCryptoRevisions,
  taskRuns,
  type ExactProtectedTaskRunResultPublicationProof,
  type PostgresJsBridgeConnection,
  type ProtectedTaskRunResultPublicationTransaction,
  type SettlePublishedProtectedTaskRunAuthorizationInput,
} from "@nautilo/db";

import type { TaskContentAuthorityV1 } from "../../task/task-content-authority-v1.ts";
import {
  TASK_CONTENT_PAYLOAD_VERSION_V1,
  TASK_CONTENT_RECONCILE_MAX_ATTEMPTS,
  TASK_RUN_RESULT_OBJECT_TYPE_V1,
  deriveTaskContentCryptoObjectIdV1,
  fingerprintTaskContentAuthorityIdentityV1,
  fingerprintTaskContentAuthorityV1,
  sameTaskContentCoordinateV1,
  type TaskContentCryptoRevisionReferenceV1,
  type VerifiedTaskContentCryptoRevisionV1,
} from "../../task/task-content-repository.ts";
import {
  withTaskContentNamespaceAuthority,
  type TaskContentNamespaceAuthorityInput,
} from "./initial-task-runtime-namespace-authority.ts";
import {
  taskContentReconciliationFailureValues,
  taskContentReconciliationLeaseExpiry,
} from "./task-content-reconciliation-policy.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ledger = taskRunResultCryptoRevisions;

type Proof = ExactProtectedTaskRunResultPublicationProof;
type Transaction = ProtectedTaskRunResultPublicationTransaction;
export type TaskRunResultRecoveryOutcome = "mapped" | "pending" | "quarantined";

export type PostgresTaskRunResultRecoveryInput = Readonly<{
  authority: TaskContentNamespaceAuthorityInput;
  publication: SettlePublishedProtectedTaskRunAuthorizationInput;
  leaseToken: string;
  verify(
    reference: TaskContentCryptoRevisionReferenceV1,
    authority: TaskContentAuthorityV1,
  ): Promise<VerifiedTaskContentCryptoRevisionV1 | null>;
  /** Settle the exact authorization/Job failure before committing quarantine. */
  settleIntegrityFailure(
    transaction: Transaction, proof: Proof, restricted: PostgresJsBridgeConnection,
  ): Promise<boolean>;
}>;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function referenceFromProof(proof: Proof): TaskContentCryptoRevisionReferenceV1 {
  const coordinate = Object.freeze({ kind: "run_result" as const,
    taskId: proof.task.id, taskRunId: proof.run.id, contentRevision: 1 });
  if (deriveTaskContentCryptoObjectIdV1(coordinate) !== proof.lifecycle.cryptoObjectId) {
    throw new Error("Task result recovery object identity is invalid");
  }
  return Object.freeze({
    coordinate,
    objectId: proof.lifecycle.cryptoObjectId,
    objectType: TASK_RUN_RESULT_OBJECT_TYPE_V1,
    expectedAccessRevision: 0,
    expectedAuthorityFingerprint: proof.lifecycle.authorityFingerprint.slice(),
    expectedAuthorityIdentityFingerprint: fingerprintTaskContentAuthorityIdentityV1({
      requesterHumanId: proof.lifecycle.requesterHumanId,
      namespaceId: proof.lifecycle.contentNamespaceId,
      keyClass: "ai",
    }),
  });
}

function verifiedMatches(
  reference: TaskContentCryptoRevisionReferenceV1,
  namespaceId: string,
  verified: VerifiedTaskContentCryptoRevisionV1 | null,
): boolean {
  return verified !== null
    && sameTaskContentCoordinateV1(reference.coordinate, verified.coordinate)
    && verified.objectId === reference.objectId
    && verified.objectType === reference.objectType
    && verified.payloadVersion === TASK_CONTENT_PAYLOAD_VERSION_V1
    && verified.namespaceId === namespaceId
    && equalBytes(verified.authorityFingerprint, reference.expectedAuthorityFingerprint);
}

/**
 * Recover only one terminal result backed by its exact durable receipt. Crypto
 * verification runs outside product/authority transactions; both claim and
 * final mapping re-prove the full lifecycle under current Namespace authority.
 */
export async function reconcilePostgresTaskRunResultPublication(
  input: PostgresTaskRunResultRecoveryInput,
  dependencies: Readonly<{
    withAuthority: typeof withTaskContentNamespaceAuthority;
    lockProof: typeof lockExactProtectedTaskRunResultPublicationInTx;
  }> = {
    withAuthority: withTaskContentNamespaceAuthority,
    lockProof: lockExactProtectedTaskRunResultPublicationInTx,
  },
): Promise<TaskRunResultRecoveryOutcome> {
  if (!UUID.test(input.leaseToken)
    || input.authority.taskId !== input.publication.reference.taskId
    || input.authority.expectedPolicyRevision !== input.publication.reference.policyRevision) {
    throw new TypeError("Task result recovery coordinates are invalid");
  }
  // Own immutable request coordinates across the out-of-transaction verify.
  const publication = Object.freeze({ ...input.publication,
    reference: Object.freeze({ ...input.publication.reference }) });
  const authority = Object.freeze({ ...input.authority });
  const leaseToken = input.leaseToken;
  const verify = input.verify;
  const settleIntegrityFailure = input.settleIntegrityFailure;
  if (typeof verify !== "function" || typeof settleIntegrityFailure !== "function") {
    throw new TypeError("Task result recovery callbacks are invalid");
  }

  async function withProof<Value>(
    use: (transaction: Transaction, proof: Proof, current: TaskContentAuthorityV1,
      restricted: PostgresJsBridgeConnection) => Promise<Value>,
  ): Promise<Value | null> {
    let proof: Proof | null = null;
    return dependencies.withAuthority({
      ...authority,
      validateCurrentTaskRun: async (_product, transaction) => {
        proof = await dependencies.lockProof(transaction, publication, "unmapped");
        return proof !== null
          && proof.task.requestorId === authority.requesterUserId
          && proof.lifecycle.requesterHumanId === authority.requesterHumanId
          && proof.lifecycle.contentNamespaceId === authority.contentNamespaceId;
      },
      use: async (held, _product, transaction, restricted) => {
        if (proof === null) return null;
        const fact = held.facts[0];
        if (held.facts.length !== 1 || fact === undefined
          || fact.namespaceId !== proof.lifecycle.contentNamespaceId) return null;
        const current: TaskContentAuthorityV1 = Object.freeze({
          authorityVersion: 1, kind: "requester_private_namespace", keyClass: "ai",
          requesterHumanId: proof.lifecycle.requesterHumanId,
          namespaceId: fact.namespaceId, domainId: fact.domainId,
          expectedAccessRevision: fact.expectedAccessRevision,
          expectedPolicyRevision: fact.expectedPolicyRevision,
        });
        if (!equalBytes(fingerprintTaskContentAuthorityV1(current),
          proof.lifecycle.authorityFingerprint)) return null;
        return use(transaction, proof, current, restricted);
      },
    });
  }

  const claimed = await withProof(async (transaction, proof, current) => {
    const reference = referenceFromProof(proof);
    const [row] = await transaction.update(ledger).set({
      leaseToken, leaseExpiresAt: taskContentReconciliationLeaseExpiry(),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    }).where(and(
      eq(ledger.sequence, proof.lifecycle.sequence),
      eq(ledger.disposition, "active"),
      sql`${ledger.attemptCount} < ${TASK_CONTENT_RECONCILE_MAX_ATTEMPTS}`,
      or(isNull(ledger.nextAttemptAt), lte(ledger.nextAttemptAt, sql`CURRENT_TIMESTAMP`)),
      or(isNull(ledger.leaseToken), lte(ledger.leaseExpiresAt, sql`CURRENT_TIMESTAMP`)),
    )).returning({ sequence: ledger.sequence });
    return row === undefined ? null : Object.freeze({ reference,
      namespaceId: proof.lifecycle.contentNamespaceId, authority: current });
  });
  if (claimed === null) return "pending";

  let verified: VerifiedTaskContentCryptoRevisionV1 | null = null;
  try {
    verified = await verify(claimed.reference, claimed.authority);
  } catch {
    // Storage errors use the existing bounded retry lifecycle, never replay.
  }
  const valid = verifiedMatches(claimed.reference, claimed.namespaceId, verified);
  const outcome = await withProof(async (transaction, proof, _current, restricted): Promise<TaskRunResultRecoveryOutcome> => {
    if (proof.lifecycle.leaseToken !== leaseToken
      || !equalBytes(proof.lifecycle.authorityFingerprint,
        claimed.reference.expectedAuthorityFingerprint)) return "pending";
    const exactLease = and(eq(ledger.sequence, proof.lifecycle.sequence),
      eq(ledger.disposition, "active"), eq(ledger.leaseToken, leaseToken),
      sql`${ledger.leaseExpiresAt} > CURRENT_TIMESTAMP`);
    if (!valid) {
      const exhausted = proof.lifecycle.attemptCount + 1 >= TASK_CONTENT_RECONCILE_MAX_ATTEMPTS;
      // Verify lease before a separate authorization transaction can be changed.
      const [live] = await transaction.select({ sequence: ledger.sequence })
        .from(ledger).where(exactLease).limit(1);
      if (live === undefined) return "pending";
      if (exhausted && !await settleIntegrityFailure(transaction, proof, restricted)) return "pending";
      const [failed] = await transaction.update(ledger)
        .set(taskContentReconciliationFailureValues(ledger.attemptCount))
        .where(exactLease).returning({ sequence: ledger.sequence });
      if (failed === undefined) throw new Error("Task result recovery lost its retry lease");
      return exhausted ? "quarantined" : "pending";
    }
    const [completed] = await transaction.update(ledger).set({
      completion: "complete", disposition: "mapped",
      cryptoCompletedAt: proof.lifecycle.cryptoCompletedAt ?? sql`CURRENT_TIMESTAMP`,
      failureCode: null, leaseToken: null, leaseExpiresAt: null,
      nextAttemptAt: null, updatedAt: sql`CURRENT_TIMESTAMP`,
    }).where(exactLease).returning({ sequence: ledger.sequence });
    if (completed === undefined) return "pending";
    const [mapped] = await transaction.update(taskRuns).set({
      resultRepresentation: proof.lifecycle.representation,
      resultContentNamespaceId: proof.lifecycle.contentNamespaceId,
      resultRevision: 1, resultCryptoObjectId: proof.lifecycle.cryptoObjectId,
      resultCryptoAccessRevision: 0,
      resultCryptoRequiredNamespaceFingerprint: proof.lifecycle.requiredNamespaceFingerprint,
      resultCryptoMappingState: "verified",
    }).where(and(eq(taskRuns.id, proof.run.id), eq(taskRuns.taskId, proof.task.id),
      eq(taskRuns.jobId, proof.job.id), eq(taskRuns.status, proof.run.outcome),
      eq(taskRuns.completedAt, proof.run.completedAt), eq(taskRuns.resultRevision, 0),
      eq(taskRuns.resultRepresentation, "ordinary"),
      eq(taskRuns.resultCryptoMappingState, "unmapped"),
      isNull(taskRuns.resultCryptoObjectId), isNull(taskRuns.resultContentNamespaceId),
    )).returning({ id: taskRuns.id });
    if (mapped === undefined) throw new Error("Task result recovery lost its exact Run");
    return "mapped";
  });
  return outcome ?? "pending";
}
