import { createHash } from "node:crypto";
import {
  deriveMessageCryptoObjectIdV2,
  type ConversationRevisionLifecycle,
} from "@nautilo/lattice-bridge";
import type { InitialTaskRuntimeNamespaceAuthority } from "@nautilo/lattice-bridge/server";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import type { TaskRuntimeBackgroundAuthorizationRequestV3 } from
  "@nautilo/lattice-crypto/background";
import {
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  parseBackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type TaskRuntimeRecipientRequestPlan,
} from "@nautilo/runtime";
import type { ProtectedTaskTerminalMessageIntent } from "./protected-task-terminal-message-product";
import { createProtectedTaskTerminalMessageRecipientRequestPlan } from "./protected-task-runtime-recipient-request-plan";

export type ProtectedTaskTerminalMessageAllocation = Readonly<{
  sessionId: string;
  messageId: number;
  revision: 0;
  objectId: string;
  createdAt: number;
  publicationPolicyRevision: number;
}>;

export type ProtectedTaskTerminalMessagePlan = TaskRuntimeRecipientRequestPlan<
  TaskRuntimeBackgroundAuthorizationRequestV3
> & Readonly<{
  intent: ProtectedTaskTerminalMessageIntent;
  allocation: ProtectedTaskTerminalMessageAllocation;
  publicationPolicyRevision: number;
  sourceRoomId: string;
}>;

export function protectedTaskTerminalMessageRequestId(taskRunId: string): string {
  return `task-run-delivery-message-authorization:${taskRunId}`;
}

/** Allocation precedes authorization so every recipient attempt targets the same Message. */
export function createProtectedTaskTerminalMessagePlan(input: Readonly<{
  intent: ProtectedTaskTerminalMessageIntent;
  allocation: ProtectedTaskTerminalMessageAllocation;
  lifecycle: ConversationRevisionLifecycle;
  namespaceAuthority: InitialTaskRuntimeNamespaceAuthority;
  crypto: Pick<LatticeCrypto, "hash">;
  now: number;
  recipientTtlMs: number;
}>): ProtectedTaskTerminalMessagePlan {
  const intent = Object.freeze({ ...input.intent,
    terminalAt: new Date(input.intent.terminalAt), attachedAt: new Date(input.intent.attachedAt) });
  const allocation = Object.freeze({ ...input.allocation });
  const { lifecycle, namespaceAuthority: authority } = input;
  const fact = authority.facts[0];
  const full = intent.representation === "protected";
  if (allocation.revision !== 0 || allocation.objectId !== deriveMessageCryptoObjectIdV2(allocation)
    || !Number.isSafeInteger(allocation.createdAt) || allocation.createdAt > input.now
    || !Number.isSafeInteger(allocation.publicationPolicyRevision)
    || allocation.publicationPolicyRevision < intent.acceptedPolicyRevision
    || lifecycle.sessionId !== allocation.sessionId || lifecycle.messageId !== allocation.messageId
    || lifecycle.revision !== allocation.revision || lifecycle.cryptoObjectId !== allocation.objectId
    || lifecycle.roomId !== intent.destinationRoomId
    || lifecycle.namespaceIdAtAllocation !== intent.destinationNamespaceId
    || lifecycle.appendIdempotencyKey !== intent.messageOperationId
    || lifecycle.authorRole !== "assistant" || lifecycle.keyClass !== "ai"
    || lifecycle.objectIdScheme !== "message_v2"
    || lifecycle.representationMode !== (full ? "full_encryption" : "shadow_encryption")
    || lifecycle.publicationPolicyRevision !== (full ? allocation.publicationPolicyRevision : null)
    || authority.sourceRoomId !== intent.destinationRoomId
    || authority.sourceNamespaceId !== intent.contentNamespaceId
    || authority.facts.length !== 1 || fact === undefined
    || fact.namespaceId !== intent.destinationNamespaceId
    || fact.expectedPolicyRevision !== allocation.publicationPolicyRevision) {
    throw new TypeError("Terminal Task Message plan does not match its allocation and destination");
  }
  const namespaces = Object.freeze([Object.freeze({ ordinal: 0,
    namespaceId: fact.namespaceId, domainId: fact.domainId,
    operations: Object.freeze(["encrypt"] as const),
    expectedAccessRevision: fact.expectedAccessRevision,
    expectedPolicyRevision: fact.expectedPolicyRevision })]);
  const domains = Object.freeze([Object.freeze({ ordinal: 0, domainId: fact.domainId,
    expectedEpoch: fact.expectedDomainEpoch,
    expectedAuthorizationRevision: fact.expectedAuthorizationRevision })]);
  const stableIdentity = JSON.stringify([
    "nautilo/task-terminal-message/v1", intent.taskId, intent.taskRunId,
    intent.bindingId, intent.messageOperationId, intent.resultObjectId, intent.resultRevision,
    intent.requesterUserId, intent.agentId, intent.contentNamespaceId,
    intent.destinationRoomId, intent.destinationNamespaceId, intent.representation,
    intent.acceptedPolicyRevision, intent.terminalAt.getTime(), intent.attachedAt.getTime(),
    allocation.sessionId, allocation.messageId, allocation.revision,
    allocation.objectId, allocation.createdAt,
  ]);
  const initialRecord = parseBackgroundAuthorizationRecord({
    snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({
      requestId: protectedTaskTerminalMessageRequestId(intent.taskRunId),
      workId: intent.taskRunId, namespaceId: intent.destinationNamespaceId, now: input.now }),
    workIdentityHash: createHash("sha256").update(JSON.stringify([
      stableIdentity, namespaces, domains,
    ])).digest(),
    idempotencyKey: `task-delivery-message:${createHash("sha256").update(stableIdentity).digest("hex")}`,
    workKind: "task.deliver_message", purpose: "task.deliver_message",
    domainId: fact.domainId, processorAuthorizationRevision: null,
    expectedDomainEpoch: fact.expectedDomainEpoch,
    expectedNamespaceAccessRevision: fact.expectedAccessRevision,
    expectedPolicyRevision: fact.expectedPolicyRevision,
    descriptorBytes: null, acceptedMaterial: null, finishedAt: null,
    authoritySet: { namespaceRequirements: namespaces, domainRequirements: domains },
  }) as BackgroundAuthorizationTaskRuntimeRecordV3;
  return Object.freeze({ intent, allocation,
    publicationPolicyRevision: allocation.publicationPolicyRevision,
    sourceRoomId: authority.sourceRoomId, initialRecord,
    ...createProtectedTaskTerminalMessageRecipientRequestPlan({
      taskId: intent.taskId, taskRunId: intent.taskRunId,
      agentId: intent.agentId, messageObjectId: allocation.objectId,
      requesterUserId: intent.requesterUserId,
      destinationNamespaceId: intent.destinationNamespaceId,
      initialRecord, sourceRoomId: authority.sourceRoomId,
      authority: { policyRevision: fact.expectedPolicyRevision, namespaces, domains },
      crypto: input.crypto, createdAt: input.now, recipientTtlMs: input.recipientTtlMs,
    }),
  });
}
