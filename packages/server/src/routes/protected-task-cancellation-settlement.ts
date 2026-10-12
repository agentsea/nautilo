import {
  settleProtectedTaskCancellationOutput,
  type DirectDatabase,
  type ProtectedTaskCancellationOutputSettlementProof,
} from "@nautilo/db";
import { fingerprintTaskContentAuthorityV1 } from "@nautilo/lattice-bridge";
import type { TaskRuntimeRecipientRegistry } from "@nautilo/lattice-crypto";
import {
  completeBackgroundAuthorizationRequest,
  isExactCompletedTaskRuntimeSuccessor,
  parseBackgroundAuthorizationRecord,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";
import {
  protectedTaskCancellationIdempotencyKey,
  protectedTaskCancellationRequestId,
} from "./protected-task-cancellation-plan";

export function exactPublicationRecord(
  record: BackgroundAuthorizationRecord | null,
  proof: Pick<ProtectedTaskCancellationOutputSettlementProof,
    "intent" | "requesterHumanId" | "authorityFingerprint">,
): record is BackgroundAuthorizationTaskRuntimeRecordV3 {
  const { intent } = proof;
  if (record === null || record.snapshot.formatVersion !== 3
    || record.snapshot.credentialSubject.kind !== "runtime"
    || record.snapshot.credentialSubject.runtimeKind !== "task"
    || record.snapshot.credentialSubject.runtimeVersion !== 1
    || record.workKind !== "task.cancel_result" || record.purpose !== "task.cancel_result"
    || record.snapshot.requestId !== protectedTaskCancellationRequestId(intent.taskRunId)
    || record.snapshot.workId !== intent.taskRunId
    || record.snapshot.namespaceId !== intent.contentNamespaceId
    || record.idempotencyKey !== protectedTaskCancellationIdempotencyKey(intent)
    || record.expectedPolicyRevision !== intent.policyRevision
    || record.processorAuthorizationRevision !== null
    || record.snapshot.acceptedResponse?.issuingHumanId !== proof.requesterHumanId
    || record.authoritySet === undefined) return false;
  const namespace = record.authoritySet.namespaceRequirements[0];
  const domain = record.authoritySet.domainRequirements[0];
  if (record.authoritySet.namespaceRequirements.length !== 1
    || record.authoritySet.domainRequirements.length !== 1
    || namespace === undefined || domain === undefined
    || namespace.ordinal !== 0 || domain.ordinal !== 0
    || namespace.namespaceId !== intent.contentNamespaceId
    || namespace.domainId !== domain.domainId || namespace.domainId !== record.domainId
    || namespace.expectedAccessRevision !== record.expectedNamespaceAccessRevision
    || namespace.expectedPolicyRevision !== intent.policyRevision
    || domain.expectedEpoch !== record.expectedDomainEpoch
    || namespace.operations.length !== 1 || namespace.operations[0] !== "encrypt") return false;
  const fingerprint = fingerprintTaskContentAuthorityV1({
    authorityVersion: 1, kind: "requester_private_namespace", keyClass: "ai",
    requesterHumanId: proof.requesterHumanId, namespaceId: namespace.namespaceId,
    domainId: namespace.domainId, expectedAccessRevision: namespace.expectedAccessRevision,
    expectedPolicyRevision: namespace.expectedPolicyRevision,
  });
  return Buffer.from(fingerprint).equals(proof.authorityFingerprint);
}

/** Called only under the mapped-product settlement locks when its old request was pruned. */
export type VerifyStagedCancellationSettlement = (
  proof: ProtectedTaskCancellationOutputSettlementProof,
) => Promise<Readonly<{ requestId: string; recipientGeneration: number }> | null>;

/** Settle an already mapped cancellation receipt without reopening any grant. */
export function createProtectedTaskCancellationSettlement(input: Readonly<{
  db: DirectDatabase;
  repository: Pick<BackgroundAuthorizationRepository, "get" | "compareAndSwap">;
  recipients: Pick<TaskRuntimeRecipientRegistry, "delete">;
  now?: () => number;
  settle?: typeof settleProtectedTaskCancellationOutput;
}>) {
  const now = input.now ?? Date.now;
  return async (coordinates: Readonly<{ taskId: string; taskRunId: string }>,
    verifyStaged?: VerifyStagedCancellationSettlement): Promise<boolean> => {
    let released: Readonly<{ requestId: string; generation: number }> | undefined;
    const result = await (input.settle ?? settleProtectedTaskCancellationOutput)(
      input.db, coordinates, async proof => {
        const raw = await input.repository.get(protectedTaskCancellationRequestId(proof.intent.taskRunId));
        if (raw === null) {
          const staged = await verifyStaged?.(proof);
          if (staged == null
            || staged.requestId !== protectedTaskCancellationRequestId(proof.intent.taskRunId)
            || !Number.isSafeInteger(staged.recipientGeneration) || staged.recipientGeneration < 0) return false;
          released = { requestId: staged.requestId, generation: staged.recipientGeneration };
          return true;
        }
        const record = parseBackgroundAuthorizationRecord(raw);
        if (!exactPublicationRecord(record, proof)) return false;
        if (record.snapshot.state === "completed") {
          if (record.finishedAt !== record.snapshot.updatedAt) return false;
        } else {
          if (record.finishedAt !== null || (record.snapshot.state !== "running"
            && record.snapshot.state !== "publication_reconciliation")) return false;
          const completedAt = now();
          const next = parseBackgroundAuthorizationRecord({ ...record,
            snapshot: completeBackgroundAuthorizationRequest(record.snapshot, completedAt),
            finishedAt: completedAt,
          });
          let completed: BackgroundAuthorizationRecord | null;
          try {
            const update = await input.repository.compareAndSwap({
              expectedRequestRevision: record.snapshot.requestRevision, next,
            });
            completed = update.status === "updated" ? update.record : update.current;
          } catch {
            completed = await input.repository.get(record.snapshot.requestId);
          }
          if (!isExactCompletedTaskRuntimeSuccessor(completed, record)) return false;
        }
        released = { requestId: record.snapshot.requestId,
          generation: record.snapshot.recipientGeneration };
        return true;
      },
    );
    if (result.status === "rejected" || released === undefined) return false;
    input.recipients.delete(released.requestId, released.generation);
    return true;
  };
}
