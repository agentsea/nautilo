import { expect, test } from "bun:test";
import type { DirectDatabase, PostgresJsBridgeConnection, ProtectedTaskCancellationOutputIntent } from "@nautilo/db";
import { deriveTaskContentCryptoObjectIdV1, type EncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import {
  LatticeCrypto, TaskRuntimeRecipientRegistry,
  authorizationRevision,
  mintDomainForegroundAuthorization,
  type TaskRuntimeCancellationResultEvidence,
} from "@nautilo/lattice-crypto";
import {
  parseDomainForegroundAuthorizationPlanV2, serializeDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import { encodeTaskRuntimeBackgroundAuthorizationRequestV3, createTaskRuntimeSignerAuthorizationV2, encodeTaskRuntimeBackgroundAuthorizationResponseV2, taskRuntimeBackgroundAuthorizationIssuerV3 } from "@nautilo/lattice-crypto/background";
import { attachBackgroundAuthorizationRecipient, markBackgroundAuthorizationGrantReady,
  claimTaskRuntimeBackgroundAuthorizationRequest, markBackgroundAuthorizationRunning,
  type BackgroundAuthorizationTaskRuntimeRecordV3 } from "@nautilo/runtime";
import { createProtectedTaskCancellationPlan } from "../../src/routes/protected-task-cancellation-plan";
import type { ProtectedTaskCancellationAuthorityPort } from "../../src/routes/protected-task-cancellation-authority";
import {
  createProtectedTaskCancellationPublication,
  type ProtectedTaskCancellationPublicationDependencies,
} from "../../src/routes/protected-task-cancellation-publication";

const NOW = 1_920_000_000_000;
const TASK = "10000000-0000-4000-8000-000000000711";
const RUN = "20000000-0000-4000-8000-000000000711";
const HUMAN = "30000000-0000-4000-8000-000000000711";
const NS = "40000000-0000-4000-8000-000000000711";
const DOMAIN = "50000000-0000-4000-8000-000000000711";
const AGENT = "60000000-0000-4000-8000-000000000711";
const USER = "70000000-0000-4000-8000-000000000711";
const ROOM = "80000000-0000-4000-8000-000000000711";
const DEVICE = "task-cancel-device";
const SERVER = "https://nautilo.example";
const CLAIM = "task-cancel-claim";
const bytes = (value: number) => new Uint8Array(32).fill(value);

async function fixture(representation: "protected" | "dual" = "protected") {
  const crypto = new LatticeCrypto();
  const issuer = crypto.generateSigningKeyPair();
  const domainKey = bytes(0x41);
  const domain = { domainId: DOMAIN, sourceNamespaceId: NS, participantDigest: bytes(0x61),
    participantCount: 1, keyClass: "ai" as const, domainKeyGeneration: 4,
    authorizationRevision: authorizationRevision(9), headDigest: bytes(0x62),
    activeNamespaceBindingSetDigest: bytes(0x63), activeNamespaceBindingCount: 1 };
  const coordinate = { kind: "run_result" as const, taskId: TASK, taskRunId: RUN, contentRevision: 2 as const };
  const intent: ProtectedTaskCancellationOutputIntent = { taskId: TASK, taskRunId: RUN, requesterUserId: USER,
    agentId: AGENT, contentNamespaceId: NS, representation, resultRevision: 2,
    resultOperationId: `task-run-cancelled-result:${RUN}`, resultObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
    policyRevision: 3, taskStatus: "cancelled", runStatus: "cancelled", terminalAt: new Date(NOW) };
  const plan = createProtectedTaskCancellationPlan({ intent, crypto, now: NOW, recipientTtlMs: 60_000,
    namespaceAuthority: { sourceRoomId: ROOM, sourceNamespaceId: NS,
      facts: [{ namespaceId: NS, domainId: DOMAIN, expectedAccessRevision: 0, expectedPolicyRevision: 3,
        expectedDomainEpoch: 4, expectedAuthorizationRevision: 9 }] } });
  let clock = NOW;
  const recipients = new TaskRuntimeRecipientRegistry(crypto, { now: () => clock });
  const initial = plan.initialRecord;
  const recipientPlan = plan.recipientAttempt({ record: initial, now: NOW });
  const attempt = await recipients.createAttempt({ requestId: initial.snapshot.requestId, workId: RUN,
    recipientGeneration: initial.snapshot.recipientGeneration, ...recipientPlan });
  if (attempt.status !== "created") throw new Error("recipient unavailable");
  const device = { userId: USER, humanActorId: HUMAN, deviceId: DEVICE, deviceGeneration: 1,
    signingPublicKey: issuer.publicKey, serverInstanceId: "server", lineageGeneration: 1, epoch: 1,
    securityRevision: 5, headDigest: bytes(8) };
  const current = { device, domains: [domain], namespaceRequirements: initial.authoritySet.namespaceRequirements,
    policyRevision: 3, sourceRoomId: ROOM };
  const request = plan.buildRequest({ record: initial, attempt: attempt.attempt,
    binding: { userId: USER, humanActorId: HUMAN, deviceId: DEVICE }, authority: current });
  const base = request.baseRequest;
  const grant = parseDomainForegroundAuthorizationPlanV2(base.authorizationPlanBytes)!;
  const authorization = await mintDomainForegroundAuthorization(crypto, { plan: grant,
    domains: [{ ...domain, domainKey }], committerDeviceSigningPrivateKey: issuer.privateKey,
    recipientEncryptionPublicKey: attempt.attempt.recipientPublicKey });
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(authorization);
  const descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV3(crypto, request);
  const certificateBytes = createTaskRuntimeSignerAuthorizationV2(crypto, {
    requestBytes: descriptorBytes, authorizationBytes,
    expectedAuthorizationPlanBytes: base.authorizationPlanBytes,
    expectedAuthorizationHash: crypto.hash(authorizationBytes), issuerSigningPrivateKey: issuer.privateKey,
  });
  const responseBytes = encodeTaskRuntimeBackgroundAuthorizationResponseV2({ authorizationBytes, certificateBytes });
  const descriptorDigest = Buffer.from(crypto.hash(descriptorBytes)).toString("hex");
  const responseDigest = Buffer.from(crypto.hash(responseBytes)).toString("hex");
  const recipient = { recipientKeyId: attempt.attempt.recipientKeyId,
    recipientPublicKey: Buffer.from(attempt.attempt.recipientPublicKey).toString("base64url"), expiresAt: NOW + 60_000 };
  const awaiting = attachBackgroundAuthorizationRecipient(initial.snapshot, {
    ...recipient, descriptorDigest, recipientGeneration: base.recipientGeneration, now: NOW,
  });
  const ready = markBackgroundAuthorizationGrantReady(awaiting, {
    ...recipient, kind: "runtime", requestId: base.requestId, descriptorDigest,
    responseDigest, credentialDigest: Buffer.from(crypto.hash(authorizationBytes)).toString("hex"), issuingHumanId: HUMAN, issuingDeviceId: DEVICE,
    recipientGeneration: base.recipientGeneration, now: NOW,
  });
  const claimed = claimTaskRuntimeBackgroundAuthorizationRequest(ready, {
    claimId: CLAIM, now: NOW, requestDeadlineAt: NOW + 60_000, authorizationExpiresAt: NOW + 60_000,
  });
  const record = { ...initial, descriptorBytes, snapshot: markBackgroundAuthorizationRunning(claimed, NOW),
    acceptedMaterial: { credentialId: grant.authorizationId, responseBytes,
      authorizationExpiresAt: NOW + 60_000, issuingDeviceAuthorizationRevision: 5,
      issuerSigningPublicKeyHash: crypto.hash(issuer.publicKey) },
  } as unknown as BackgroundAuthorizationTaskRuntimeRecordV3;
  const state = { reserved: false, deny: false, expireDuringStage: false,
    stageCalls: 0, recoverCalls: 0, authorityCalls: 0, insideAuthority: false,
    committed: false, pending: false, reserveBeforeLock: false, selected: representation as "protected" | "dual" | "ordinary" };
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => state.reserved ? [{ operationId: intent.resultOperationId }] : [] }) }) }) } as unknown as DirectDatabase;
  const restricted = {} as PostgresJsBridgeConnection;
  const authority: ProtectedTaskCancellationAuthorityPort = {
    withDiscovery: async () => { throw new Error("Unexpected discovery"); }, withBound: async () => { throw new Error("Unexpected bound"); },
    withAccepted: async input => {
      state.authorityCalls++; if (state.deny) return null;
      expect(state.insideAuthority).toBe(false); state.insideAuthority = true;
      if (state.reserveBeforeLock) state.reserved = true;
      try { await input.validateBeforeCommit();
        const result = await input.use({ ...current, plan: grant }, restricted, restricted, db as never);
        await input.validateBeforeCommit(); state.committed = true; return result;
      } finally { state.insideAuthority = false; }
    },
  };
  const dependencies: ProtectedTaskCancellationPublicationDependencies = {
    stage: async input => {
      state.stageCalls++;
      expect(state.insideAuthority).toBe(true);
      expect(input.restricted).toBe(restricted);
      expect(input.intent).toEqual(intent);
      await input.assertCurrentTaskAuthority();
      await input.assertCurrentClaim();
      if (state.expireDuringStage) clock = NOW + 60_000;
      return "staged";
    },
    recover: async coordinates => {
      state.recoverCalls++;
      expect(state.insideAuthority).toBe(false);
      expect(state.committed).toBe(true);
      expect(coordinates).toEqual({ taskId: TASK, taskRunId: RUN });
      return state.pending ? "pending" : "mapped";
    },
  };
  const owner = { runMutation: async (operation: Parameters<EncryptionDataOperationOwner["runMutation"]>[0]) => {
    const selected = operation[state.selected];
    if (selected === undefined) throw new Error("No representation adapter");
    // Composition fences are independent of the persisted policy revision (3).
    return selected({ revalidationToken: 999 });
  } } as EncryptionDataOperationOwner;
  const publish = createProtectedTaskCancellationPublication({ db, restricted, crypto,
    owner, serverScope: SERVER, authority, now: () => clock }, dependencies);
  const withEvidence = <Value>(use: (publication: Parameters<typeof publish>[0]) => Promise<Value>) =>
    recipients.withOpenedCancellationResultGrant({ requestId: base.requestId, workId: RUN,
      recipientGeneration: base.recipientGeneration, recipientKeyId: base.recipientKeyId,
      claimId: CLAIM, claimExpiresAt: NOW + 60_000, authorizationBytes,
      certifiedSigning: { requestBytes: descriptorBytes, certificateBytes,
        currentIssuer: taskRuntimeBackgroundAuthorizationIssuerV3(request), expectedPublication: request.work },
      current: { authorizationId: grant.authorizationId, policyRevision: 3, sessionId: grant.sessionId, roomId: ROOM,
        subjectHumanId: grant.subjectHumanId, committerDeviceId: grant.committerDeviceId,
        committerDeviceSigningGeneration: 1, committerDeviceSigningPublicKey: issuer.publicKey, committerDeviceActive: true,
        hostAuthorizationRevision: grant.hostAuthorizationRevision, recipientKind: "runtime", recipientPrincipalId: "nautilo_task_runtime",
        recipientAuthorizationRevision: authorizationRevision(0), recipientRuntimeGeneration: base.recipientGeneration,
        recipientKeyId: base.recipientKeyId, recipientAuthorized: true, domains: [domain] },
      currentNamespaceRequirements: initial.authoritySet.namespaceRequirements,
      result: { taskId: TASK, taskRunId: RUN, contentRevision: 2, objectId: intent.resultObjectId, signerAgentId: AGENT,
        namespace: { namespaceId: NS, domainId: DOMAIN, operations: ["encrypt"], expectedAccessRevision: 0, expectedPolicyRevision: 3 } },
      operation: (domains, signal, evidence) => use({ plan, record, domains, signal, evidence, assertCurrentClaim: () => {} }) });
  return { state, publish, withEvidence };
}

for (const representation of ["protected", "dual"] as const) {
  test(`stages ${representation} cancellation under authority then recovers after commit`, async () => {
    const value = await fixture(representation);
    const result = await value.withEvidence(value.publish);
    expect(result.status).toBe("opened");
    expect(value.state.stageCalls).toBe(1);
    expect(value.state.recoverCalls).toBe(1);
    expect(value.state.authorityCalls).toBe(1);
  });
}

test("existing immutable reservation refuses before preparing any new ciphertext", async () => {
  const value = await fixture(); value.state.reserved = true;
  const error = await value.withEvidence(value.publish).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect(value.state.stageCalls).toBe(0); expect(value.state.recoverCalls).toBe(0);
});

test("denied current authority refuses before preparation or publication", async () => {
  const value = await fixture(); value.state.deny = true;
  expect(await value.withEvidence(value.publish).catch((failure: unknown) => failure)).toBeInstanceOf(Error);
  expect(value.state.stageCalls).toBe(0); expect(value.state.recoverCalls).toBe(0);
});

test("evidence expiry during preparation refuses the repository and product write", async () => {
  const value = await fixture(); value.state.expireDuringStage = true;
  expect(await value.withEvidence(value.publish).catch((failure: unknown) => failure)).toBeInstanceOf(Error);
  expect(value.state.stageCalls).toBe(1); expect(value.state.recoverCalls).toBe(0);
});

test("cross-kind record and forged evidence cannot publish a cancellation", async () => {
  for (const scenario of ["kind", "evidence"] as const) {
    const value = await fixture();
    const result = await value.withEvidence(publication => value.publish(scenario === "kind"
      ? { ...publication, record: { ...publication.record, workKind: "task.execute", purpose: "task.execute" } }
      : { ...publication, evidence: { ...publication.evidence } as TaskRuntimeCancellationResultEvidence }))
      .catch((failure: unknown) => failure);
    expect(result).toBeInstanceOf(Error); expect(value.state.stageCalls).toBe(0);
  }
});

for (const selected of ["ordinary", "dual"] as const) {
  test(`policy selecting ${selected} cannot stage a protected cancellation`, async () => {
    const value = await fixture(); value.state.selected = selected;
    expect(await value.withEvidence(value.publish).catch((failure: unknown) => failure)).toBeInstanceOf(Error);
    expect(value.state.stageCalls).toBe(0);
    expect(value.state.recoverCalls).toBe(0);
  });
}

test("pending recovery leaves staged result for the observer without another preparation", async () => {
  const value = await fixture(); value.state.pending = true;
  expect(await value.withEvidence(value.publish).catch((failure: unknown) => failure)).toBeInstanceOf(Error);
  expect(value.state.committed).toBe(true);
  expect(value.state.stageCalls).toBe(1);
  expect(value.state.recoverCalls).toBe(1);
});

test("reservation appearing before the held Run lock prevents staging", async () => {
  const value = await fixture(); value.state.reserveBeforeLock = true;
  expect(await value.withEvidence(value.publish).catch((failure: unknown) => failure)).toBeInstanceOf(Error);
  expect(value.state.stageCalls).toBe(0);
  expect(value.state.recoverCalls).toBe(0);
});
