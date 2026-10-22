import { PROTECTED_TASK_CANCELLED_RESULT } from "@nautilo/db";
import { encodeMessagePayloadV2 } from "@nautilo/lattice-bridge";
import type { LatticeCrypto, TaskRuntimeRecipientRegistry, TaskRuntimeTerminalMessageProof } from "@nautilo/lattice-crypto";
import { sameTaskRuntimeAuthorityPlan } from "@nautilo/runtime";
import {
  createProtectedTaskPublicationClaim,
  type TaskPublicationClaimDependencies,
} from "./protected-task-cancellation-claim";
import type { ProtectedTaskTerminalMessageAuthorityPort } from "./protected-task-terminal-message-authority";
import type { ProtectedTaskTerminalMessagePlan } from "./protected-task-terminal-message-plan";
import type { ProtectedTaskTerminalMessagePublication } from "./protected-task-terminal-message-publication";

export function createProtectedTaskTerminalMessageClaim(input: Readonly<{
  crypto: Pick<LatticeCrypto, "hash">;
  authority: ProtectedTaskTerminalMessageAuthorityPort;
  recipients: Pick<TaskRuntimeRecipientRegistry, "delete" | "withOpenedTerminalMessageGrant">;
  repository: TaskPublicationClaimDependencies<ProtectedTaskTerminalMessagePlan>["repository"];
  publish: ProtectedTaskTerminalMessagePublication;
  now?: () => number;
  claimId?: () => string;
}>) {
  return createProtectedTaskPublicationClaim<ProtectedTaskTerminalMessagePlan>({
    workKind: "task.deliver_message", recipients: input.recipients,
    repository: input.repository,
    coordinates: plan => ({ workId: plan.intent.taskRunId,
      requesterUserId: plan.intent.requesterUserId }),
    matchesPlan: (record, plan) => record.workKind === "task.deliver_message"
      && record.purpose === "task.deliver_message"
      && record.snapshot.requestId === plan.initialRecord.snapshot.requestId
      && record.snapshot.workId === plan.intent.taskRunId
      && record.snapshot.namespaceId === plan.intent.destinationNamespaceId
      && record.expectedPolicyRevision === plan.publicationPolicyRevision
      && record.idempotencyKey === plan.initialRecord.idempotencyKey
      && sameTaskRuntimeAuthorityPlan(record, plan.initialRecord),
    withAccepted: ({ plan, ...operation }) => input.authority.withAccepted({
      ...operation, intent: plan.intent, publicationPolicyRevision: plan.publicationPolicyRevision }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.claimId === undefined ? {} : { claimId: input.claimId }),
    openGrant: async ({ plan, request, certifiedSigning, authorizationBytes,
      record, claimId, claimExpiresAt, authority, signal, assertCurrentClaim }) => {
      const namespace = record.authoritySet.namespaceRequirements[0]!;
      const payload = encodeMessagePayloadV2({ role: "assistant", content: PROTECTED_TASK_CANCELLED_RESULT });
      const digest = input.crypto.hash(payload);
      try {
        const message: TaskRuntimeTerminalMessageProof = Object.freeze({
          taskId: plan.intent.taskId, taskRunId: plan.intent.taskRunId,
          bindingId: plan.intent.bindingId, messageOperationId: plan.intent.messageOperationId,
          sessionId: plan.allocation.sessionId, messageId: plan.allocation.messageId,
          revision: plan.allocation.revision, objectId: plan.allocation.objectId,
          roomId: plan.intent.destinationRoomId, namespaceId: plan.intent.destinationNamespaceId,
          domainId: namespace.domainId,
          mode: plan.intent.representation === "protected" ? "encrypted_only" : "shadow_encryption",
          acceptedPolicyRevision: plan.intent.acceptedPolicyRevision,
          publicationPolicyRevision: plan.publicationPolicyRevision,
          signerAgentId: plan.intent.agentId, payloadDigest: digest,
        });
        const expectedPublication = Object.freeze({
          kind: "task.deliver_message" as const,
          taskId: message.taskId,
          taskRunId: message.taskRunId,
          contentRevision: 2 as const,
          messageObjectId: message.objectId,
          workIdentityHash: Uint8Array.from(record.workIdentityHash),
        });
        try {
          const opened = await input.recipients.withOpenedTerminalMessageGrant({
            requestId: request.requestId, workId: request.workId,
            recipientGeneration: record.snapshot.recipientGeneration,
            recipientKeyId: request.recipientKeyId, claimId, claimExpiresAt,
            authorizationBytes, current: authority.foreground,
            currentNamespaceRequirements: authority.namespaceRequirements,
            message, signal,
            certifiedSigning: Object.freeze({
              ...certifiedSigning, expectedPublication,
            }),
            operation: async (domains, activeSignal, evidence) => {
              await assertCurrentClaim();
              await input.publish({ plan, record, domains, evidence,
                signal: activeSignal, assertCurrentClaim });
            },
          });
          return opened.status === "opened";
        } finally {
          expectedPublication.workIdentityHash.fill(0);
        }
      } finally { payload.fill(0); digest.fill(0); }
    },
  });
}
