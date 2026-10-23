import { expect, test } from "bun:test";

import {
  protectedTaskRunCancelledResultObjectId,
  protectedTaskRunMessageOperationId,
  protectedTaskRunOutputBindingId,
} from "@nautilo/db";
import {
  deriveMessageCryptoObjectIdV2,
  type ConversationRevisionLifecycle,
} from "@nautilo/lattice-bridge";
import type { InitialTaskRuntimeNamespaceAuthority } from
  "@nautilo/lattice-bridge/server";
import {
  LatticeCrypto,
  authorizationRevision,
  type DomainForegroundAuthorityEntry,
} from "@nautilo/lattice-crypto";
import { agentRuntimeObjectSignerKeyIdV1, parseDomainForegroundAuthorizationPlanV2 } from
  "@nautilo/lattice-crypto/wire";
import {
  isTaskExecutionWorkKind,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type TaskRuntimeRecipientCurrentAuthority,
} from "@nautilo/runtime";
import {
  createProtectedTaskTerminalMessagePlan,
  protectedTaskTerminalMessageRequestId,
  type ProtectedTaskTerminalMessageAllocation,
} from "../../src/routes/protected-task-terminal-message-plan";
import type { ProtectedTaskTerminalMessageIntent } from
  "../../src/routes/protected-task-terminal-message-product";

const NOW = 1_801_000_000_000;
const REQUESTER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const TASK = "40000000-0000-4000-8000-000000000004";
const RUN = "50000000-0000-4000-8000-000000000005";
const ROOM = "60000000-0000-4000-8000-000000000006";
const SESSION = "70000000-0000-4000-8000-000000000007";
const CONTENT_NAMESPACE = "80000000-0000-4000-8000-000000000008";
const DESTINATION_NAMESPACE = "90000000-0000-4000-8000-000000000009";
const DOMAIN = "a0000000-0000-4000-8000-00000000000a";
const DEVICE = "b0000000-0000-4000-8000-00000000000b";
const MESSAGE_ID = 41;
const POLICY_REVISION = 9;

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function intent(
  representation: "dual" | "protected" = "protected",
  patch: Partial<ProtectedTaskTerminalMessageIntent> = {},
): ProtectedTaskTerminalMessageIntent {
  return {
    taskId: TASK,
    taskRunId: RUN,
    requesterUserId: REQUESTER,
    agentId: AGENT,
    contentNamespaceId: CONTENT_NAMESPACE,
    representation,
    bindingId: protectedTaskRunOutputBindingId(RUN),
    resultObjectId: protectedTaskRunCancelledResultObjectId(TASK, RUN),
    resultRevision: 2,
    acceptedPolicyRevision: 7,
    terminalAt: new Date(NOW - 3_000),
    attachedAt: new Date(NOW - 2_000),
    destinationRoomId: ROOM,
    destinationNamespaceId: DESTINATION_NAMESPACE,
    messageOperationId: protectedTaskRunMessageOperationId(RUN),
    ...patch,
  };
}

function allocation(
  patch: Partial<ProtectedTaskTerminalMessageAllocation> = {},
): ProtectedTaskTerminalMessageAllocation {
  const base = {
    sessionId: SESSION,
    messageId: MESSAGE_ID,
    revision: 0 as const,
    createdAt: NOW - 1_000,
    publicationPolicyRevision: POLICY_REVISION,
  };
  return {
    ...base,
    objectId: deriveMessageCryptoObjectIdV2(base),
    ...patch,
  };
}

function lifecycle(
  representation: "dual" | "protected" = "protected",
  patch: Partial<ConversationRevisionLifecycle> = {},
): ConversationRevisionLifecycle {
  const allocated = allocation();
  return {
    sequence: 1,
    sessionId: allocated.sessionId,
    messageId: allocated.messageId,
    revision: allocated.revision,
    roomId: ROOM,
    namespaceIdAtAllocation: DESTINATION_NAMESPACE,
    cryptoObjectId: allocated.objectId,
    objectIdScheme: "message_v2",
    representationMode: representation === "protected"
      ? "full_encryption" : "shadow_encryption",
    publicationPolicyRevision: representation === "protected"
      ? POLICY_REVISION : null,
    taskWakeOperationId: null,
    shadowOperationId: null,
    humanPeerShadowOperationId: null,
    sharedAgentShadowOperationId: null,
    sharedAgentShadowExecutionId: null,
    shadowTranscriptOrdinal: null,
    shadowReservedCreatedAt: null,
    shadowStreamId: null,
    shadowStreamStartDigest: null,
    shadowStreamTerminalDigest: null,
    shadowStreamedTextDigest: null,
    shadowDurableEventDigest: null,
    keyClass: "ai",
    authorRole: "assistant",
    subthreadReplyClassification: "counted",
    completion: "pending",
    disposition: "active",
    parityStatus: "pending",
    attemptCount: 0,
    nextAttemptAt: null,
    failureCode: null,
    leaseToken: null,
    leaseExpiresAt: null,
    appendIdempotencyKey: protectedTaskRunMessageOperationId(RUN),
    allocationRequestDigest: bytes(1),
    repairIdentityDigest: null,
    repairPublisherKind: null,
    repairPublisherId: null,
    repairPublisherHumanId: null,
    repairSourceRevision: null,
    repairSourceDigest: null,
    repairAttestationDigest: null,
    terminalOperationId: null,
    terminalOperationType: null,
    terminalExpectedRevision: null,
    terminalRequestDigest: null,
    ...patch,
  };
}

function namespaceAuthority(
  patch: Partial<InitialTaskRuntimeNamespaceAuthority> = {},
): InitialTaskRuntimeNamespaceAuthority {
  return {
    sourceRoomId: ROOM,
    sourceNamespaceId: CONTENT_NAMESPACE,
    facts: [{
      namespaceId: DESTINATION_NAMESPACE,
      domainId: DOMAIN,
      expectedAccessRevision: 4,
      expectedPolicyRevision: POLICY_REVISION,
      expectedDomainEpoch: 6,
      expectedAuthorizationRevision: 12,
    }],
    ...patch,
  };
}

function currentDomain(
  patch: Partial<DomainForegroundAuthorityEntry> = {},
): DomainForegroundAuthorityEntry {
  return Object.freeze({
    domainId: DOMAIN,
    sourceNamespaceId: DESTINATION_NAMESPACE,
    participantDigest: bytes(2),
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 6,
    authorizationRevision: authorizationRevision(12),
    headDigest: bytes(3),
    activeNamespaceBindingSetDigest: bytes(4),
    activeNamespaceBindingCount: 1,
    ...patch,
  });
}

function currentAuthority(
  plan: ReturnType<typeof createProtectedTaskTerminalMessagePlan>,
  patch: Partial<TaskRuntimeRecipientCurrentAuthority> = {},
): TaskRuntimeRecipientCurrentAuthority {
  return {
    device: {
      userId: REQUESTER,
      humanActorId: HUMAN,
      deviceId: DEVICE,
      deviceGeneration: 2,
      signingPublicKey: new Uint8Array(65).fill(5),
      serverInstanceId: "c0000000-0000-4000-8000-00000000000c",
      lineageGeneration: 3,
      epoch: 4,
      securityRevision: 5,
      headDigest: bytes(6),
    },
    sourceRoomId: ROOM,
    policyRevision: POLICY_REVISION,
    namespaceRequirements:
      plan.initialRecord.authoritySet.namespaceRequirements,
    domains: Object.freeze([currentDomain()]),
    ...patch,
  };
}

function nextGeneration(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): BackgroundAuthorizationTaskRuntimeRecordV3 {
  return Object.freeze({
    ...record,
    snapshot: Object.freeze({
      ...record.snapshot,
      recipientGeneration: record.snapshot.recipientGeneration + 1,
      requestRevision: record.snapshot.requestRevision + 1,
      updatedAt: record.snapshot.updatedAt + 1,
    }),
  });
}

function buildRequest(
  plan: ReturnType<typeof createProtectedTaskTerminalMessagePlan>,
  record: BackgroundAuthorizationTaskRuntimeRecordV3 = plan.initialRecord,
  now = NOW,
  authority: TaskRuntimeRecipientCurrentAuthority = currentAuthority(plan),
) {
  const crypto = new LatticeCrypto();
  const signerPublicKey = new Uint8Array(32).fill(9);
  const recipient = plan.recipientAttempt({ record, now });
  const attempt = Object.freeze({
    requestId: record.snapshot.requestId,
    workId: RUN,
    recipientGeneration: record.snapshot.recipientGeneration,
    recipientKeyId: recipient.recipientKeyId,
    recipientPublicKey: new Uint8Array(65).fill(7),
    expiresAt: recipient.expiresAt,
    signer: Object.freeze({ agentId: AGENT, runtimeGeneration: 0 as const,
      signerKeyId: agentRuntimeObjectSignerKeyIdV1(crypto, signerPublicKey), signerPublicKey }),
  });
  return {
    recipient,
    request: plan.buildRequest({
      record,
      attempt,
      binding: { userId: REQUESTER, humanActorId: HUMAN, deviceId: DEVICE },
      authority,
    }),
  };
}

for (const representation of ["protected", "dual"] as const) {
  test(`builds an allocation-bound ${representation} Message request with destination-only authority`, () => {
    const crypto = new LatticeCrypto();
    const plan = createProtectedTaskTerminalMessagePlan({
      intent: intent(representation),
      allocation: allocation(),
      lifecycle: lifecycle(representation),
      namespaceAuthority: namespaceAuthority(),
      crypto,
      now: NOW,
      recipientTtlMs: 60_000,
    });

    expect(plan.allocation).toEqual(allocation());
    expect(plan.sourceRoomId).toBe(ROOM);
    expect(plan.publicationPolicyRevision).toBe(POLICY_REVISION);
    expect(plan.initialRecord).toMatchObject({
      workKind: "task.deliver_message",
      purpose: "task.deliver_message",
      expectedPolicyRevision: POLICY_REVISION,
      domainId: DOMAIN,
    });
    expect(isTaskExecutionWorkKind(plan.initialRecord.workKind)).toBe(false);
    expect(plan.initialRecord.snapshot).toMatchObject({
      requestId: protectedTaskTerminalMessageRequestId(RUN),
      workId: RUN,
      namespaceId: DESTINATION_NAMESPACE,
      recipientGeneration: 0,
    });
    expect(plan.initialRecord.authoritySet.namespaceRequirements).toEqual([{
      ordinal: 0,
      namespaceId: DESTINATION_NAMESPACE,
      domainId: DOMAIN,
      operations: ["encrypt"],
      expectedAccessRevision: 4,
      expectedPolicyRevision: POLICY_REVISION,
    }]);
    expect(plan.initialRecord.authoritySet.namespaceRequirements)
      .not.toContainEqual(expect.objectContaining({
        namespaceId: CONTENT_NAMESPACE,
      }));

    const { recipient, request } = buildRequest(plan);
    expect(request.formatVersion).toBe(3);
    expect(recipient.recipientKeyId)
      .toBe(`task-delivery-runtime:${RUN}:0`);
    const authorization = parseDomainForegroundAuthorizationPlanV2(
      request.baseRequest.authorizationPlanBytes,
    );
    expect(authorization).toMatchObject({
      authorizationId: protectedTaskTerminalMessageRequestId(RUN),
      sessionId: `task-run:${RUN}`,
      roomId: ROOM,
      recipientKeyId: recipient.recipientKeyId,
      operations: ["encrypt"],
      domainCount: 1,
    });
    expect(request.baseRequest).toMatchObject({
      requestId: protectedTaskTerminalMessageRequestId(RUN),
      workId: RUN,
      workKind: "task.deliver_message",
      workPurpose: "task.deliver_message",
      sourceRoomId: ROOM,
    });
    expect(request.work).toMatchObject({ kind: "task.deliver_message", taskId: TASK,
      taskRunId: RUN, contentRevision: 2, messageObjectId: plan.allocation.objectId });
  });
}

test("keeps one logical Message identity across fresh recipient attempts", () => {
  const input = {
    intent: intent(),
    allocation: allocation(),
    lifecycle: lifecycle(),
    namespaceAuthority: namespaceAuthority(),
    crypto: new LatticeCrypto(),
    now: NOW,
    recipientTtlMs: 60_000,
  };
  const plan = createProtectedTaskTerminalMessagePlan(input);
  const rebuilt = createProtectedTaskTerminalMessagePlan({
    ...input,
    now: NOW + 5_000,
  });
  const exactAllocation = allocation();
  const reorderedAllocation: ProtectedTaskTerminalMessageAllocation = {
    publicationPolicyRevision: exactAllocation.publicationPolicyRevision,
    createdAt: exactAllocation.createdAt,
    objectId: exactAllocation.objectId,
    revision: exactAllocation.revision,
    messageId: exactAllocation.messageId,
    sessionId: exactAllocation.sessionId,
  };
  const reordered = createProtectedTaskTerminalMessagePlan({
    ...input,
    allocation: reorderedAllocation,
    now: NOW + 6_000,
  });
  const refreshed = nextGeneration(plan.initialRecord);
  const first = buildRequest(plan, plan.initialRecord, NOW);
  const second = buildRequest(plan, refreshed, NOW + 10_000);

  expect(first.recipient.recipientKeyId)
    .toBe(`task-delivery-runtime:${RUN}:0`);
  expect(second.recipient.recipientKeyId)
    .toBe(`task-delivery-runtime:${RUN}:1`);
  expect(second.recipient.expiresAt).toBe(first.recipient.expiresAt + 10_000);
  expect(refreshed.idempotencyKey).toBe(plan.initialRecord.idempotencyKey);
  expect(refreshed.workIdentityHash).toEqual(plan.initialRecord.workIdentityHash);
  expect(rebuilt.initialRecord.idempotencyKey)
    .toBe(plan.initialRecord.idempotencyKey);
  expect(rebuilt.initialRecord.workIdentityHash)
    .toEqual(plan.initialRecord.workIdentityHash);
  expect(reordered.initialRecord.idempotencyKey)
    .toBe(plan.initialRecord.idempotencyKey);
  expect(reordered.initialRecord.workIdentityHash)
    .toEqual(plan.initialRecord.workIdentityHash);
  expect(first.request.baseRequest.requestId).toBe(second.request.baseRequest.requestId);
  expect(first.request.baseRequest.workId).toBe(second.request.baseRequest.workId);
  expect(first.request.work.kind).toBe("task.deliver_message");
  expect(second.request.work.kind).toBe("task.deliver_message");
  expect(plan.allocation.objectId).toBe(
    deriveMessageCryptoObjectIdV2(plan.allocation),
  );
});

test("rejects every changed allocation and Message lifecycle coordinate", () => {
  const exactAllocation = allocation();
  const exactLifecycle = lifecycle();
  const cases: ReadonlyArray<Readonly<{
    allocation?: ProtectedTaskTerminalMessageAllocation;
    lifecycle?: ConversationRevisionLifecycle;
  }>> = [
    { allocation: { ...exactAllocation, objectId: `${exactAllocation.objectId}:wrong` } },
    { allocation: { ...exactAllocation, publicationPolicyRevision: 6 } },
    { lifecycle: { ...exactLifecycle, revision: 1 } },
    { lifecycle: { ...exactLifecycle, cryptoObjectId: `${exactLifecycle.cryptoObjectId}:wrong` } },
    { lifecycle: { ...exactLifecycle, roomId: "d0000000-0000-4000-8000-00000000000d" } },
    { lifecycle: { ...exactLifecycle, namespaceIdAtAllocation: CONTENT_NAMESPACE } },
    { lifecycle: { ...exactLifecycle, appendIdempotencyKey: "wrong-operation" } },
    { lifecycle: { ...exactLifecycle, representationMode: "shadow_encryption" } },
    { lifecycle: { ...exactLifecycle, publicationPolicyRevision: POLICY_REVISION + 1 } },
  ];
  for (const changed of cases) {
    expect(() => createProtectedTaskTerminalMessagePlan({
      intent: intent(),
      allocation: changed.allocation ?? exactAllocation,
      lifecycle: changed.lifecycle ?? exactLifecycle,
      namespaceAuthority: namespaceAuthority(),
      crypto: new LatticeCrypto(),
      now: NOW,
      recipientTtlMs: 60_000,
    })).toThrow("allocation and destination");
  }
});

test("rejects mismatched detached destination Namespace authority", () => {
  const exact = namespaceAuthority();
  const fact = exact.facts[0]!;
  const authorities: InitialTaskRuntimeNamespaceAuthority[] = [
    { ...exact, sourceRoomId: "d0000000-0000-4000-8000-00000000000d" },
    { ...exact, sourceNamespaceId: DESTINATION_NAMESPACE },
    { ...exact, facts: [] },
    { ...exact, facts: [fact, { ...fact }] },
    { ...exact, facts: [{ ...fact, namespaceId: CONTENT_NAMESPACE }] },
    { ...exact, facts: [{ ...fact,
      expectedPolicyRevision: POLICY_REVISION + 1 }] },
  ];
  for (const authority of authorities) {
    expect(() => createProtectedTaskTerminalMessagePlan({
      intent: intent(),
      allocation: allocation(),
      lifecycle: lifecycle(),
      namespaceAuthority: authority,
      crypto: new LatticeCrypto(),
      now: NOW,
      recipientTtlMs: 60_000,
    })).toThrow("allocation and destination");
  }
});
