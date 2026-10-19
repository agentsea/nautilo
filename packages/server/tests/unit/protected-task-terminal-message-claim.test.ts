import { createHash } from "node:crypto";

import { expect, test } from "bun:test";

import {
  PROTECTED_TASK_CANCELLED_RESULT,
  protectedTaskRunCancelledResultObjectId,
  protectedTaskRunMessageOperationId,
  protectedTaskRunOutputBindingId,
} from "@nautilo/db";
import {
  deriveMessageCryptoObjectIdV2,
  encodeMessagePayloadV2,
  type ConversationRevisionLifecycle,
} from "@nautilo/lattice-bridge";
import type { CurrentTaskRuntimeAuthority } from
  "@nautilo/lattice-bridge/server";
import {
  LatticeCrypto,
  authorizationRevision,
  type DomainForegroundAuthorityEntry,
} from "@nautilo/lattice-crypto";
import {
  encodeTaskRuntimeBackgroundAuthorizationRequestV3,
  encodeTaskRuntimeBackgroundAuthorizationResponseV2,
} from "@nautilo/lattice-crypto/background";
import { agentRuntimeObjectSignerKeyIdV1,
  parseDomainForegroundAuthorizationPlanV2 } from
  "@nautilo/lattice-crypto/wire";
import {
  isTaskExecutionWorkKind,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";
import { createProtectedTaskTerminalMessageClaim } from
  "../../src/routes/protected-task-terminal-message-claim";
import type { ProtectedTaskTerminalMessageAuthorityPort } from
  "../../src/routes/protected-task-terminal-message-authority";
import {
  createProtectedTaskTerminalMessagePlan,
  type ProtectedTaskTerminalMessagePlan,
} from "../../src/routes/protected-task-terminal-message-plan";

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
const CLAIM = "c0000000-0000-4000-8000-00000000000c";
const POLICY_REVISION = 9;

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function lifecycle(objectId: string): ConversationRevisionLifecycle {
  return {
    sequence: 1,
    sessionId: SESSION,
    messageId: 41,
    revision: 0,
    roomId: ROOM,
    namespaceIdAtAllocation: DESTINATION_NAMESPACE,
    cryptoObjectId: objectId,
    objectIdScheme: "message_v2",
    representationMode: "full_encryption",
    publicationPolicyRevision: POLICY_REVISION,
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
  };
}

function domain(): DomainForegroundAuthorityEntry {
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
  });
}

function fixture(options: Readonly<{ publicationError?: Error }> = {}) {
  const crypto = new LatticeCrypto();
  const allocation = {
    sessionId: SESSION,
    messageId: 41,
    revision: 0 as const,
    createdAt: NOW - 1_000,
    publicationPolicyRevision: POLICY_REVISION,
  };
  const objectId = deriveMessageCryptoObjectIdV2(allocation);
  const plan = createProtectedTaskTerminalMessagePlan({
    intent: {
      taskId: TASK,
      taskRunId: RUN,
      requesterUserId: REQUESTER,
      agentId: AGENT,
      contentNamespaceId: CONTENT_NAMESPACE,
      representation: "protected",
      bindingId: protectedTaskRunOutputBindingId(RUN),
      resultObjectId: protectedTaskRunCancelledResultObjectId(TASK, RUN),
      resultRevision: 2,
      acceptedPolicyRevision: 7,
      terminalAt: new Date(NOW - 3_000),
      attachedAt: new Date(NOW - 2_000),
      destinationRoomId: ROOM,
      destinationNamespaceId: DESTINATION_NAMESPACE,
      messageOperationId: protectedTaskRunMessageOperationId(RUN),
    },
    allocation: { ...allocation, objectId },
    lifecycle: lifecycle(objectId),
    namespaceAuthority: {
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
    },
    crypto,
    now: NOW,
    recipientTtlMs: 60_000,
  });
  const recipientPublicKey = new Uint8Array(65).fill(5);
  const signer = crypto.generateSigningKeyPair();
  const request = plan.buildRequest({
    record: plan.initialRecord,
    attempt: {
      requestId: plan.initialRecord.snapshot.requestId,
      workId: RUN,
      recipientGeneration: 0,
      recipientKeyId: `task-delivery-runtime:${RUN}:0`,
      recipientPublicKey,
      expiresAt: NOW + 60_000,
      signer: { agentId: AGENT, runtimeGeneration: 0,
        signerKeyId: agentRuntimeObjectSignerKeyIdV1(crypto, signer.publicKey),
        signerPublicKey: signer.publicKey },
    },
    binding: { userId: REQUESTER, humanActorId: HUMAN, deviceId: DEVICE },
    authority: {
      device: {
        userId: REQUESTER,
        humanActorId: HUMAN,
        deviceId: DEVICE,
        deviceGeneration: 2,
        signingPublicKey: new Uint8Array(65).fill(6),
        serverInstanceId: "d0000000-0000-4000-8000-00000000000d",
        lineageGeneration: 1,
        epoch: 1,
        securityRevision: 3,
        headDigest: bytes(7),
      },
      sourceRoomId: ROOM,
      policyRevision: POLICY_REVISION,
      namespaceRequirements:
        plan.initialRecord.authoritySet.namespaceRequirements,
      domains: [domain()],
    },
  });
  signer.privateKey.fill(0);
  signer.publicKey.fill(0);
  const baseRequest = request.baseRequest;
  const foreground = parseDomainForegroundAuthorizationPlanV2(
    baseRequest.authorizationPlanBytes,
  );
  if (foreground === null) throw new Error("terminal fixture plan is invalid");
  const descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV3(crypto, request);
  const responseBytes = encodeTaskRuntimeBackgroundAuthorizationResponseV2({
    authorizationBytes: bytes(8), certificateBytes: bytes(10),
  });
  const selected: BackgroundAuthorizationTaskRuntimeRecordV3 = {
    ...plan.initialRecord,
    snapshot: {
      ...plan.initialRecord.snapshot,
      state: "grant_ready",
      requestRevision: 2,
      updatedAt: NOW,
      descriptorDigest: createHash("sha256").update(descriptorBytes).digest("hex"),
      recipient: {
        recipientKeyId: baseRequest.recipientKeyId,
        recipientPublicKey: Buffer.from(recipientPublicKey).toString("base64url"),
        expiresAt: baseRequest.deadlineAt,
      },
      acceptedResponse: {
        kind: "runtime",
        responseDigest: createHash("sha256").update(responseBytes).digest("hex"),
        credentialDigest: "33".repeat(32),
        issuingHumanId: HUMAN,
        issuingDeviceId: DEVICE,
        recipientGeneration: 0,
        acceptedAt: NOW,
      },
    },
    descriptorBytes,
    acceptedMaterial: {
      responseBytes,
      credentialId: baseRequest.requestId,
      issuingDeviceAuthorizationRevision: authorizationRevision(3),
      issuerSigningPublicKeyHash: bytes(9),
      authorizationExpiresAt: NOW + 60_000,
    },
  };
  const currentAuthority: CurrentTaskRuntimeAuthority = {
    device: {
      userId: REQUESTER,
      humanActorId: HUMAN,
      deviceId: DEVICE,
      deviceGeneration: 2,
      signingPublicKey: new Uint8Array(65).fill(6),
      serverInstanceId: "d0000000-0000-4000-8000-00000000000d",
      lineageGeneration: 1,
      epoch: 1,
      securityRevision: 3,
      headDigest: bytes(7),
    },
    plan: foreground,
    domains: [domain()],
    namespaceRequirements: selected.authoritySet.namespaceRequirements,
    policyRevision: POLICY_REVISION,
  };
  const events: string[] = [];
  const state: { record: BackgroundAuthorizationRecord } = {
    record: selected,
  };
  const repository = {
    get: async () => state.record,
    compareAndSwap: async (operation: Readonly<{
      expectedRequestRevision: number;
      next: BackgroundAuthorizationRecord;
    }>) => {
      events.push(`cas:${operation.next.snapshot.state}`);
      if (state.record.snapshot.requestRevision
        !== operation.expectedRequestRevision) {
        return { status: "stale" as const, current: state.record };
      }
      state.record = operation.next;
      return { status: "updated" as const, record: operation.next };
    },
  };
  const authority: ProtectedTaskTerminalMessageAuthorityPort = {
    withDiscovery: async () => { throw new Error("unexpected discovery"); },
    withBound: async () => { throw new Error("unexpected bound authority"); },
    withAccepted: async operation => {
      events.push("authority:enter");
      expect(operation.intent).toEqual(plan.intent);
      expect(operation.publicationPolicyRevision).toBe(POLICY_REVISION);
      const value = await operation.use(
        currentAuthority,
        {} as never,
        {} as never,
        {} as never,
      );
      await operation.validateBeforeCommit();
      events.push("authority:exit");
      return value;
    },
  };
  let registryCalls = 0;
  let publicationCalls = 0;
  let deletes = 0;
  let proofDigest: Uint8Array | null = null;
  const claim = createProtectedTaskTerminalMessageClaim({
    crypto,
    authority,
    repository: async () => repository,
    now: () => NOW + 1,
    claimId: () => CLAIM,
    publish: async publication => {
      events.push("publish");
      publicationCalls += 1;
      expect(publication.plan).toBe(plan);
      expect(publication.record.snapshot).toMatchObject({
        state: "running",
        claimId: CLAIM,
        recipientGeneration: 0,
      });
      await publication.assertCurrentClaim();
      if (options.publicationError !== undefined) {
        throw options.publicationError;
      }
    },
    recipients: {
      withOpenedTerminalMessageGrant: async operation => {
        events.push("registry");
        registryCalls += 1;
        expect(operation).toMatchObject({
          requestId: selected.snapshot.requestId,
          workId: RUN,
          recipientGeneration: 0,
          recipientKeyId: baseRequest.recipientKeyId,
          claimId: CLAIM,
        });
        expect(operation.currentNamespaceRequirements).toEqual([{
          ordinal: 0,
          namespaceId: DESTINATION_NAMESPACE,
          domainId: DOMAIN,
          operations: ["encrypt"],
          expectedAccessRevision: 4,
          expectedPolicyRevision: POLICY_REVISION,
        }]);
        expect(operation.message).toMatchObject({
          taskId: TASK,
          taskRunId: RUN,
          bindingId: protectedTaskRunOutputBindingId(RUN),
          messageOperationId: protectedTaskRunMessageOperationId(RUN),
          sessionId: SESSION,
          messageId: 41,
          revision: 0,
          objectId,
          roomId: ROOM,
          namespaceId: DESTINATION_NAMESPACE,
          domainId: DOMAIN,
          mode: "encrypted_only",
          acceptedPolicyRevision: 7,
          publicationPolicyRevision: POLICY_REVISION,
          signerAgentId: AGENT,
        });
        expect(operation.certifiedSigning?.expectedPublication).toMatchObject({
          kind: "task.deliver_message", taskId: TASK, taskRunId: RUN,
          contentRevision: 2, messageObjectId: objectId,
        });
        const encoded = encodeMessagePayloadV2({
          role: "assistant",
          content: PROTECTED_TASK_CANCELLED_RESULT,
        });
        const expectedDigest = crypto.hash(encoded);
        encoded.fill(0);
        try {
          expect(operation.message.payloadDigest).toEqual(expectedDigest);
          proofDigest = operation.message.payloadDigest.slice();
        } finally {
          expectedDigest.fill(0);
        }
        const value = await operation.operation(
          [],
          new AbortController().signal,
          {} as never,
        );
        return { status: "opened" as const, value };
      },
      delete: (requestId, generation) => {
        events.push("delete");
        expect(requestId).toBe(selected.snapshot.requestId);
        expect(generation).toBe(0);
        deletes += 1;
        return true;
      },
    },
  });
  return {
    claim,
    plan,
    selected,
    state,
    events,
    request,
    registryCalls: () => registryCalls,
    publicationCalls: () => publicationCalls,
    deletes: () => deletes,
    proofDigest: () => proofDigest,
  };
}

test("publishes one exact allocated Message with destination-only custody", async () => {
  const value = fixture();
  const completed = await value.claim({
    plan: value.plan,
    record: value.selected,
    restricted: {} as never,
    signal: new AbortController().signal,
  });
  expect(completed?.snapshot.state).toBe("completed");
  expect(completed?.finishedAt).toBe(NOW + 1);
  expect(isTaskExecutionWorkKind(completed!.workKind)).toBe(false);
  expect("occurrence" in value.plan).toBe(false);
  expect(value.events).toEqual([
    "authority:enter",
    "cas:claimed",
    "cas:running",
    "authority:exit",
    "registry",
    "publish",
    "cas:completed",
    "delete",
  ]);
  expect(value.proofDigest()).not.toBeNull();
  expect(value.registryCalls()).toBe(1);
  expect(value.publicationCalls()).toBe(1);
  expect(value.deletes()).toBe(1);

  expect(await value.claim({
    plan: value.plan,
    record: value.selected,
    restricted: {} as never,
    signal: new AbortController().signal,
  })).toBeNull();
  expect(value.registryCalls()).toBe(1);
  expect(value.publicationCalls()).toBe(1);
});

test("rejects substituted terminal work before custody opens", async () => {
  const cases: ReadonlyArray<Readonly<{
    name: string;
    plan?(plan: ProtectedTaskTerminalMessagePlan): ProtectedTaskTerminalMessagePlan;
    record?(record: BackgroundAuthorizationTaskRuntimeRecordV3):
      BackgroundAuthorizationTaskRuntimeRecordV3;
  }>> = [{
    name: "wrong plan",
    plan: plan => ({
      ...plan,
      intent: { ...plan.intent,
        taskRunId: "e0000000-0000-4000-8000-00000000000e" },
    }),
  }, {
    name: "execution work",
    record: record => ({ ...record,
      workKind: "task.execute", purpose: "task.execute" }),
  }, {
    name: "wrong Namespace",
    record: record => ({ ...record,
      snapshot: { ...record.snapshot, namespaceId: CONTENT_NAMESPACE },
      authoritySet: { ...record.authoritySet,
        namespaceRequirements: [{
          ...record.authoritySet.namespaceRequirements[0]!,
          namespaceId: CONTENT_NAMESPACE,
        }] },
    }),
  }, {
    name: "wrong policy",
    record: record => ({ ...record,
      expectedPolicyRevision: POLICY_REVISION + 1,
      authoritySet: { ...record.authoritySet,
        namespaceRequirements: [{
          ...record.authoritySet.namespaceRequirements[0]!,
          expectedPolicyRevision: POLICY_REVISION + 1,
        }] },
    }),
  }, {
    name: "wrong recipient generation",
    record: record => ({ ...record,
      snapshot: { ...record.snapshot,
        recipientGeneration: 1,
        acceptedResponse: {
          ...record.snapshot.acceptedResponse!, recipientGeneration: 1,
        },
      },
    }),
  }, {
    name: "wrong recipient key",
    record: record => ({ ...record,
      snapshot: { ...record.snapshot, recipient: {
        ...record.snapshot.recipient!, recipientKeyId: "substituted",
      } } }),
  }];
  for (const current of cases) {
    const value = fixture();
    const plan = current.plan?.(value.plan) ?? value.plan;
    const record = current.record?.(value.selected) ?? value.selected;
    expect(await value.claim({
      plan,
      record,
      restricted: {} as never,
      signal: new AbortController().signal,
    }), current.name).toBeNull();
    expect(value.registryCalls(), current.name).toBe(0);
    expect(value.publicationCalls(), current.name).toBe(0);
    expect(value.state.record.snapshot.state, current.name)
      .toBe("grant_ready");
  }
});

test("publication failure preserves durable running work for reconciliation", async () => {
  const failure = new Error("terminal publication failed");
  const value = fixture({ publicationError: failure });
  expect(await value.claim({
    plan: value.plan,
    record: value.selected,
    restricted: {} as never,
    signal: new AbortController().signal,
  }).catch((error: unknown) => error)).toBe(failure);
  expect(value.state.record.snapshot.state).toBe("running");
  expect(value.registryCalls()).toBe(1);
  expect(value.publicationCalls()).toBe(1);
  expect(value.deletes()).toBe(0);
  expect(await value.claim({
    plan: value.plan,
    record: value.selected,
    restricted: {} as never,
    signal: new AbortController().signal,
  })).toBeNull();
  expect(value.registryCalls()).toBe(1);
});
