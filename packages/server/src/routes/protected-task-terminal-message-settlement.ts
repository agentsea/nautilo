import { sha256 } from "@noble/hashes/sha2.js";
import { PROTECTED_TASK_CANCELLED_RESULT, type PostgresJsBridgeConnection } from
  "@nautilo/db";
import { deriveMessageCryptoObjectIdV2, encodeMessagePayloadV2 } from
  "@nautilo/lattice-bridge";
import {
  assertVerifiedStagedTaskTerminalMessagePublication,
  type NativeTaskTerminalMessageCurrentAuthority,
  type VerifiedStagedTaskTerminalMessagePublication,
} from "@nautilo/lattice-bridge/server";
import type { TaskRuntimeRecipientRegistry } from "@nautilo/lattice-crypto";
import {
  completeBackgroundAuthorizationRequest,
  isExactCompletedTaskRuntimeSuccessor,
  parseBackgroundAuthorizationRecord,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";
import type { TerminalMessageRecoverySettlementInput } from
  "./protected-task-terminal-message-recovery";
import type { ProtectedTaskTerminalMessageIntent } from
  "./protected-task-terminal-message-product";

type Dependencies = Readonly<{
  assertStaged: typeof assertVerifiedStagedTaskTerminalMessagePublication;
}>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function fixedPayloadDigest(): string {
  const encoded = encodeMessagePayloadV2({
    role: "assistant", content: PROTECTED_TASK_CANCELLED_RESULT,
  });
  try {
    return Buffer.from(sha256(encoded)).toString("hex");
  } finally {
    encoded.fill(0);
  }
}

function exactProofCoordinates(
  intent: ProtectedTaskTerminalMessageIntent,
  proof: VerifiedStagedTaskTerminalMessagePublication,
  current: NativeTaskTerminalMessageCurrentAuthority,
): boolean {
  const staged = proof.intent;
  const mode = intent.representation === "protected"
    ? "encrypted_only" : "shadow_encryption";
  return intent.resultRevision === 2
    && Number.isSafeInteger(proof.recipientGeneration)
    && proof.recipientGeneration >= 0
    && proof.claimId.length > 0
    && proof.authorizationDigest.length === 32
    && proof.requestId === staged.requestId
    && staged.requestId
      === `task-run-delivery-message-authorization:${intent.taskRunId}`
    && staged.taskId === intent.taskId
    && staged.taskRunId === intent.taskRunId
    && staged.bindingId === intent.bindingId
    && staged.messageOperationId === intent.messageOperationId
    && staged.roomId === intent.destinationRoomId
    && staged.namespaceId === intent.destinationNamespaceId
    && staged.mode === mode
    && staged.acceptedPolicyRevision === intent.acceptedPolicyRevision
    && staged.signerAgentId === intent.agentId
    && staged.role === "assistant"
    && staged.payloadDigest === fixedPayloadDigest()
    && staged.revision === 0
    && staged.objectId === deriveMessageCryptoObjectIdV2({
      sessionId: staged.sessionId,
      messageId: staged.messageId,
      revision: staged.revision,
    })
    && staged.publicationPolicyRevision >= staged.acceptedPolicyRevision
    && Number.isSafeInteger(staged.createdAt) && staged.createdAt >= 0
    && current.taskId === staged.taskId
    && current.taskRunId === staged.taskRunId
    && current.bindingId === staged.bindingId
    && current.messageOperationId === staged.messageOperationId
    && current.sessionId === staged.sessionId
    && current.messageId === staged.messageId
    && current.revision === staged.revision
    && current.objectId === staged.objectId
    && current.roomId === staged.roomId
    && current.namespaceId === staged.namespaceId
    && current.domainId === staged.domainId
    && current.mode === staged.mode
    && current.acceptedPolicyRevision === staged.acceptedPolicyRevision
    && current.currentPolicyRevision >= staged.publicationPolicyRevision
    && Number.isSafeInteger(current.namespaceAccessRevision)
    && current.namespaceAccessRevision >= 0;
}

function exactPublicationRecord(
  record: BackgroundAuthorizationRecord,
  context: TerminalMessageRecoverySettlementInput,
): record is BackgroundAuthorizationTaskRuntimeRecordV3 {
  const { proof, currentAuthority: current } = context;
  const staged = proof.intent;
  const responseDigest = Buffer.from(proof.authorizationDigest).toString("hex");
  if (record.snapshot.formatVersion !== 3
    || record.snapshot.credentialSubject.kind !== "runtime"
    || record.snapshot.credentialSubject.runtimeKind !== "task"
    || record.snapshot.credentialSubject.runtimeVersion !== 1
    || record.workKind !== "task.deliver_message"
    || record.purpose !== "task.deliver_message"
    || record.snapshot.requestId !== proof.requestId
    || record.snapshot.workId !== staged.taskRunId
    || record.snapshot.namespaceId !== staged.namespaceId
    || !/^task-delivery-message:[0-9a-f]{64}$/u.test(record.idempotencyKey)
    || record.processorAuthorizationRevision !== null
    || record.expectedPolicyRevision !== staged.publicationPolicyRevision
    || record.expectedNamespaceAccessRevision
      !== current.namespaceAccessRevision
    || record.domainId !== staged.domainId
    || record.snapshot.recipientGeneration !== proof.recipientGeneration
    || (record.snapshot.state === "completed"
        || record.snapshot.state === "publication_reconciliation"
      ? record.snapshot.claimId !== null
      : record.snapshot.claimId !== proof.claimId)
    || record.snapshot.acceptedResponse?.kind !== "runtime"
    || record.snapshot.acceptedResponse.recipientGeneration
      !== proof.recipientGeneration
    || record.snapshot.acceptedResponse.issuingHumanId
      !== context.requesterHumanId
    || record.snapshot.acceptedResponse.responseDigest !== responseDigest
    || record.acceptedMaterial === null
    || !sameBytes(sha256(record.acceptedMaterial.responseBytes),
      proof.authorizationDigest)
    || record.authoritySet === undefined) return false;
  const namespace = record.authoritySet.namespaceRequirements[0];
  const domain = record.authoritySet.domainRequirements[0];
  return record.authoritySet.namespaceRequirements.length === 1
    && record.authoritySet.domainRequirements.length === 1
    && namespace !== undefined && domain !== undefined
    && namespace.ordinal === 0 && domain.ordinal === 0
    && namespace.namespaceId === staged.namespaceId
    && namespace.domainId === staged.domainId
    && namespace.domainId === domain.domainId
    && namespace.operations.length === 1
    && namespace.operations[0] === "encrypt"
    && namespace.expectedAccessRevision === current.namespaceAccessRevision
    && namespace.expectedPolicyRevision === staged.publicationPolicyRevision
    && domain.expectedEpoch === record.expectedDomainEpoch;
}

/** Settle only the authorization whose immutable ciphertext was mapped. */
export function createProtectedTaskTerminalMessageSettlement(input: Readonly<{
  recipients: Pick<TaskRuntimeRecipientRegistry, "delete">;
  repository(connection: PostgresJsBridgeConnection):
    Pick<BackgroundAuthorizationRepository, "get" | "compareAndSwap">
    | Promise<Pick<BackgroundAuthorizationRepository, "get" | "compareAndSwap">>;
  now?: () => number;
}>, overrides: Partial<Dependencies> = {}) {
  const now = input.now ?? Date.now;
  const assertStaged = overrides.assertStaged
    ?? assertVerifiedStagedTaskTerminalMessagePublication;
  return async (context: TerminalMessageRecoverySettlementInput): Promise<boolean> => {
    try {
      assertStaged(context.proof, context.currentAuthority);
    } catch {
      return false;
    }
    if (!exactProofCoordinates(
      context.intent, context.proof, context.currentAuthority,
    )) return false;
    const repository = await input.repository(context.restricted);
    const raw = await repository.get(context.proof.requestId);
    if (raw === null) {
      try {
        assertStaged(context.proof, context.currentAuthority);
      } catch {
        return false;
      }
      context.deferRecipientCleanup(() => {
        input.recipients.delete(
          context.proof.requestId, context.proof.recipientGeneration,
        );
      });
      return true;
    }
    const record = parseBackgroundAuthorizationRecord(raw);
    if (!exactPublicationRecord(record, context)) return false;
    if (record.snapshot.state === "completed") {
      if (record.finishedAt !== record.snapshot.updatedAt) return false;
    } else {
      if (record.finishedAt !== null
        || record.snapshot.state !== "running"
          && record.snapshot.state !== "publication_reconciliation") {
        return false;
      }
      const completedAt = now();
      const next = parseBackgroundAuthorizationRecord({
        ...record,
        snapshot: completeBackgroundAuthorizationRequest(
          record.snapshot, completedAt,
        ),
        finishedAt: completedAt,
      });
      let completed: BackgroundAuthorizationRecord | null;
      try {
        const result = await repository.compareAndSwap({
          expectedRequestRevision: record.snapshot.requestRevision,
          next,
        });
        completed = result.status === "updated" ? result.record : result.current;
      } catch {
        completed = await repository.get(record.snapshot.requestId);
      }
      if (!isExactCompletedTaskRuntimeSuccessor(completed, record)) return false;
    }
    try {
      assertStaged(context.proof, context.currentAuthority);
    } catch {
      return false;
    }
    context.deferRecipientCleanup(() => {
      input.recipients.delete(
        record.snapshot.requestId, record.snapshot.recipientGeneration,
      );
    });
    return true;
  };
}
