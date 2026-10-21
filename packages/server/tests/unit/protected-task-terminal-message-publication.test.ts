import { expect, test } from "bun:test";
import {
  PROTECTED_TASK_CANCELLED_RESULT,
  protectedTaskRunCancelledResultObjectId,
  protectedTaskRunMessageOperationId,
  protectedTaskRunOutputBindingId,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  deriveMessageCryptoObjectIdV2,
  encodeMessagePayloadV2,
  type EncryptionDataOperationOwner,
} from "@nautilo/lattice-bridge";
import {
  LatticeCrypto,
  TaskRuntimeRecipientRegistry,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  mintDomainForegroundAuthorization,
  type TaskRuntimeTerminalMessageEvidence,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  parseDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import {
  attachBackgroundAuthorizationRecipient,
  claimTaskRuntimeBackgroundAuthorizationRequest,
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  markBackgroundAuthorizationGrantReady,
  markBackgroundAuthorizationRunning,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";
import type { ProtectedTaskTerminalMessageAuthorityPort } from
  "../../src/routes/protected-task-terminal-message-authority";
import type { ProtectedTaskTerminalMessagePlan } from
  "../../src/routes/protected-task-terminal-message-plan";
import type { ProtectedTaskTerminalMessageIntent } from
  "../../src/routes/protected-task-terminal-message-product";
import {
  createProtectedTaskTerminalMessagePublication,
  type ProtectedTaskTerminalMessagePublicationDependencies,
} from "../../src/routes/protected-task-terminal-message-publication";

const NOW = 1_930_000_000_000;
const TASK = "10000000-0000-4000-8000-000000000741";
const RUN = "20000000-0000-4000-8000-000000000741";
const HUMAN = "30000000-0000-4000-8000-000000000741";
const PRIVATE_NS = "40000000-0000-4000-8000-000000000741";
const DESTINATION_NS = "50000000-0000-4000-8000-000000000741";
const DOMAIN = "60000000-0000-4000-8000-000000000741";
const AGENT = "70000000-0000-4000-8000-000000000741";
const USER = "80000000-0000-4000-8000-000000000741";
const ROOM = "90000000-0000-4000-8000-000000000741";
const SESSION = "a0000000-0000-4000-8000-000000000741";
const DEVICE = "task-terminal-device";
const CLAIM = "task-terminal-claim";
const POLICY = 9;
const MESSAGE_ID = 51;
const REQUEST = `task-run-delivery-message-authorization:${RUN}`;
const bytes = (value: number) => new Uint8Array(32).fill(value);

async function fixture(representation: "protected" | "dual" = "protected") {
  const crypto = new LatticeCrypto();
  const issuer = crypto.generateSigningKeyPair();
  const domainKey = bytes(0x41);
  const domain = {
    domainId: DOMAIN,
    sourceNamespaceId: DESTINATION_NS,
    participantDigest: bytes(0x61),
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 4,
    authorizationRevision: authorizationRevision(9),
    headDigest: bytes(0x62),
    activeNamespaceBindingSetDigest: bytes(0x63),
    activeNamespaceBindingCount: 1,
  };
  const intent: ProtectedTaskTerminalMessageIntent = Object.freeze({
    taskId: TASK,
    taskRunId: RUN,
    requesterUserId: USER,
    agentId: AGENT,
    contentNamespaceId: PRIVATE_NS,
    representation,
    bindingId: protectedTaskRunOutputBindingId(RUN),
    resultObjectId: protectedTaskRunCancelledResultObjectId(TASK, RUN),
    resultRevision: 2,
    acceptedPolicyRevision: 7,
    terminalAt: new Date(NOW - 3_000),
    attachedAt: new Date(NOW - 2_000),
    destinationRoomId: ROOM,
    destinationNamespaceId: DESTINATION_NS,
    messageOperationId: protectedTaskRunMessageOperationId(RUN),
  });
  const allocationBase = Object.freeze({
    sessionId: SESSION,
    messageId: MESSAGE_ID,
    revision: 0 as const,
    createdAt: NOW - 1_000,
    publicationPolicyRevision: POLICY,
  });
  const allocation = Object.freeze({
    ...allocationBase,
    objectId: deriveMessageCryptoObjectIdV2(allocationBase),
  });
  const namespaceRequirements = Object.freeze([Object.freeze({
    ordinal: 0,
    namespaceId: DESTINATION_NS,
    domainId: DOMAIN,
    operations: Object.freeze(["encrypt"] as const),
    expectedAccessRevision: 0,
    expectedPolicyRevision: POLICY,
  })]);
  const domainRequirements = Object.freeze([Object.freeze({
    ordinal: 0,
    domainId: DOMAIN,
    expectedEpoch: 4,
    expectedAuthorizationRevision: 9,
  })]);
  const initialRecord: BackgroundAuthorizationTaskRuntimeRecordV3 = {
    snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({
      requestId: REQUEST,
      workId: RUN,
      namespaceId: DESTINATION_NS,
      now: NOW,
    }),
    workIdentityHash: bytes(1),
    idempotencyKey: "terminal-message-publication-test",
    workKind: "task.deliver_message",
    purpose: "task.deliver_message",
    domainId: DOMAIN,
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 4,
    expectedNamespaceAccessRevision: 0,
    expectedPolicyRevision: POLICY,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
    authoritySet: { namespaceRequirements, domainRequirements },
  };
  const plan = Object.freeze({
    intent,
    allocation,
    publicationPolicyRevision: POLICY,
    sourceRoomId: ROOM,
    initialRecord,
  }) as unknown as ProtectedTaskTerminalMessagePlan;
  const clock = NOW;
  const recipients = new TaskRuntimeRecipientRegistry(crypto, {
    now: () => clock,
  });
  const attempt = await recipients.createAttempt({
    requestId: REQUEST,
    workId: RUN,
    recipientGeneration: 0,
    recipientKeyId: "terminal-message-recipient",
    expiresAt: NOW + 60_000,
  });
  if (attempt.status !== "created") throw new Error("recipient unavailable");
  const authorizationPlan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: REQUEST,
    policyRevision: POLICY,
    sessionId: `task-run:${RUN}`,
    roomId: ROOM,
    subjectHumanId: HUMAN as never,
    committerDeviceId: DEVICE as never,
    committerDeviceSigningGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(5),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 0,
    recipientKeyId: attempt.attempt.recipientKeyId,
    operations: ["encrypt"],
    issuedAt: NOW,
    deadlineAt: NOW + 60_000,
    maximumSecretBytes: 1024,
    domains: [domain],
  });
  const exactRequest = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: REQUEST,
    workId: RUN,
    workKind: "task.deliver_message",
    workPurpose: "task.deliver_message",
    recipientGeneration: 0,
    episodeId: `task-run:${RUN}`,
    sourceRoomId: ROOM,
    recipientKeyId: attempt.attempt.recipientKeyId,
    recipientPublicKey: attempt.attempt.recipientPublicKey,
    authorizationPlan,
    issuedAt: NOW,
    deadlineAt: NOW + 60_000,
  });
  const parsedPlan = parseDomainForegroundAuthorizationPlanV2(
    exactRequest.authorizationPlanBytes,
  );
  if (parsedPlan === null) throw new Error("authorization plan invalid");
  const authorization = await mintDomainForegroundAuthorization(crypto, {
    plan: parsedPlan,
    domains: [{ ...domain, domainKey }],
    committerDeviceSigningPrivateKey: issuer.privateKey,
    recipientEncryptionPublicKey: attempt.attempt.recipientPublicKey,
  });
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(
    authorization,
  );
  const descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
    exactRequest,
  );
  const descriptorDigest = Buffer.from(crypto.hash(descriptorBytes))
    .toString("hex");
  const responseDigest = Buffer.from(crypto.hash(authorizationBytes))
    .toString("hex");
  const recipient = {
    recipientKeyId: attempt.attempt.recipientKeyId,
    recipientPublicKey: Buffer.from(attempt.attempt.recipientPublicKey)
      .toString("base64url"),
    expiresAt: NOW + 60_000,
  };
  const awaiting = attachBackgroundAuthorizationRecipient(
    initialRecord.snapshot,
    { ...recipient, descriptorDigest, recipientGeneration: 0, now: NOW },
  );
  const ready = markBackgroundAuthorizationGrantReady(awaiting, {
    ...recipient,
    kind: "runtime",
    requestId: REQUEST,
    descriptorDigest,
    responseDigest,
    credentialDigest: responseDigest,
    issuingHumanId: HUMAN,
    issuingDeviceId: DEVICE,
    recipientGeneration: 0,
    now: NOW,
  });
  const claimed = claimTaskRuntimeBackgroundAuthorizationRequest(ready, {
    claimId: CLAIM,
    now: NOW,
    requestDeadlineAt: NOW + 60_000,
    authorizationExpiresAt: NOW + 60_000,
  });
  const record = {
    ...initialRecord,
    descriptorBytes,
    snapshot: markBackgroundAuthorizationRunning(claimed, NOW),
    acceptedMaterial: {
      credentialId: parsedPlan.authorizationId,
      responseBytes: authorizationBytes,
      authorizationExpiresAt: NOW + 60_000,
      issuingDeviceAuthorizationRevision: 5,
      issuerSigningPublicKeyHash: crypto.hash(issuer.publicKey),
    },
  } as BackgroundAuthorizationTaskRuntimeRecordV3;
  const current = Object.freeze({
    device: {
      userId: USER,
      humanActorId: HUMAN,
      deviceId: DEVICE,
    },
    plan: parsedPlan,
    domains: [domain],
    namespaceRequirements,
    policyRevision: POLICY,
  });
  const restricted = {} as PostgresJsBridgeConnection;
  const state = {
    insideAuthority: false,
    deny: false,
    allocationCurrent: true,
    changeAllocationDuringStage: false,
    allocationChecks: 0,
    stageCalls: 0,
    recoverCalls: 0,
    selected: representation as "protected" | "dual" | "ordinary",
    recovery: "mapped" as "mapped" | "pending",
  };
  const authority: ProtectedTaskTerminalMessageAuthorityPort = {
    withDiscovery: async () => { throw new Error("unexpected discovery"); },
    withBound: async () => { throw new Error("unexpected bound"); },
    withAccepted: async input => {
      if (state.deny) return null;
      state.insideAuthority = true;
      try {
        await input.validateBeforeCommit();
        const result = await input.use(
          current as never,
          restricted,
          restricted,
          {} as never,
        );
        await input.validateBeforeCommit();
        return result;
      } finally {
        state.insideAuthority = false;
      }
    },
  };
  const dependencies: ProtectedTaskTerminalMessagePublicationDependencies = {
    verifyAllocation: async (_transaction, selected) => {
      state.allocationChecks += 1;
      expect(state.insideAuthority).toBe(true);
      expect(selected).toBe(plan);
      return state.allocationCurrent;
    },
    stage: async input => {
      state.stageCalls += 1;
      expect(state.insideAuthority).toBe(true);
      expect(input.plan).toBe(plan);
      expect(input.restricted).toBe(restricted);
      await input.assertCurrentTaskAuthority();
      await input.assertCurrentClaim();
      if (state.changeAllocationDuringStage) state.allocationCurrent = false;
      return "staged";
    },
  };
  const owner = {
    runMutation: async (operation: Parameters<
      EncryptionDataOperationOwner["runMutation"]
    >[0]) => {
      const selected = operation[state.selected];
      if (selected === undefined) throw new Error("no representation adapter");
      return selected({ revalidationToken: 1 });
    },
  } as EncryptionDataOperationOwner;
  const publish = createProtectedTaskTerminalMessagePublication({
    restricted,
    crypto,
    owner,
    serverScope: "https://nautilo.example.test",
    authority,
    recover: async selected => {
      state.recoverCalls += 1;
      expect(state.insideAuthority).toBe(false);
      expect(selected).toBe(plan);
      return state.recovery;
    },
  }, dependencies);
  const payloadBytes = encodeMessagePayloadV2({
    role: "assistant",
    content: PROTECTED_TASK_CANCELLED_RESULT,
  });
  const payloadDigest = crypto.hash(payloadBytes);
  payloadBytes.fill(0);
  const message = Object.freeze({
    taskId: TASK,
    taskRunId: RUN,
    bindingId: intent.bindingId,
    messageOperationId: intent.messageOperationId,
    sessionId: SESSION,
    messageId: MESSAGE_ID,
    revision: 0,
    objectId: allocation.objectId,
    roomId: ROOM,
    namespaceId: DESTINATION_NS,
    domainId: DOMAIN,
    mode: representation === "protected"
      ? "encrypted_only" as const : "shadow_encryption" as const,
    acceptedPolicyRevision: 7,
    publicationPolicyRevision: POLICY,
    signerAgentId: AGENT,
    payloadDigest,
  });
  const withEvidence = <Value>(use: (
    publication: Parameters<typeof publish>[0],
  ) => Promise<Value>) => recipients.withOpenedTerminalMessageGrant({
    requestId: REQUEST,
    workId: RUN,
    recipientGeneration: 0,
    recipientKeyId: exactRequest.recipientKeyId,
    claimId: CLAIM,
    claimExpiresAt: NOW + 60_000,
    authorizationBytes,
    current: {
      authorizationId: parsedPlan.authorizationId,
      policyRevision: POLICY,
      sessionId: parsedPlan.sessionId,
      roomId: ROOM,
      subjectHumanId: parsedPlan.subjectHumanId,
      committerDeviceId: parsedPlan.committerDeviceId,
      committerDeviceSigningGeneration: 1,
      committerDeviceSigningPublicKey: issuer.publicKey,
      committerDeviceActive: true,
      hostAuthorizationRevision: parsedPlan.hostAuthorizationRevision,
      recipientKind: "runtime",
      recipientPrincipalId: "nautilo_task_runtime",
      recipientAuthorizationRevision: authorizationRevision(0),
      recipientRuntimeGeneration: 0,
      recipientKeyId: exactRequest.recipientKeyId,
      recipientAuthorized: true,
      domains: [domain],
    },
    currentNamespaceRequirements: namespaceRequirements,
    message,
    operation: (domains, signal, evidence) => use({
      plan,
      record,
      domains,
      signal,
      evidence,
      assertCurrentClaim: () => {},
    }),
  });
  return { state, publish, withEvidence };
}

for (const representation of ["protected", "dual"] as const) {
  test(`stages and recovers the fixed ${representation} terminal Message`, async () => {
    const value = await fixture(representation);
    const opened = await value.withEvidence(value.publish);
    expect(opened.status).toBe("opened");
    expect(value.state.stageCalls).toBe(1);
    expect(value.state.recoverCalls).toBe(1);
  });
}

test("denied authority or changed allocation refuses before crypto staging", async () => {
  for (const failure of ["authority", "allocation"] as const) {
    const value = await fixture();
    if (failure === "authority") value.state.deny = true;
    else value.state.allocationCurrent = false;
    const result = await value.withEvidence(value.publish)
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(value.state.stageCalls).toBe(0);
    expect(value.state.recoverCalls).toBe(0);
  }
});

test("allocation changing after crypto staging prevents recovery", async () => {
  const value = await fixture();
  value.state.changeAllocationDuringStage = true;
  expect(await value.withEvidence(value.publish)
    .catch((error: unknown) => error)).toBeInstanceOf(Error);
  expect(value.state.stageCalls).toBe(1);
  expect(value.state.allocationChecks).toBe(2);
  expect(value.state.recoverCalls).toBe(0);
});

test("forged evidence and cross-kind records cannot stage", async () => {
  for (const failure of ["evidence", "record"] as const) {
    const value = await fixture();
    const result = await value.withEvidence(publication => value.publish(
      failure === "evidence"
        ? { ...publication,
          evidence: { ...publication.evidence } as TaskRuntimeTerminalMessageEvidence }
        : { ...publication,
          record: { ...publication.record,
            workKind: "task.execute", purpose: "task.execute" } },
    )).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(value.state.stageCalls).toBe(0);
  }
});

test("policy routing cannot convert representation and pending recovery never restages", async () => {
  const converted = await fixture();
  converted.state.selected = "dual";
  expect(await converted.withEvidence(converted.publish)
    .catch((error: unknown) => error)).toBeInstanceOf(Error);
  expect(converted.state.stageCalls).toBe(0);

  const pending = await fixture();
  pending.state.recovery = "pending";
  expect(await pending.withEvidence(pending.publish)
    .catch((error: unknown) => error)).toBeInstanceOf(Error);
  expect(pending.state.stageCalls).toBe(1);
  expect(pending.state.recoverCalls).toBe(1);
});
