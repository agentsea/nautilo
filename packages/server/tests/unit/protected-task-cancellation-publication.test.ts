import { expect, test } from "bun:test";
import {
  actors, encryptionTransitionPolicy, protectedTaskRunOutputBindings, tasks, taskRuns,
  taskDefinitionCryptoRevisions, taskRunResultCryptoRevisions,
  type DirectDatabase, type PostgresJsBridgeConnection, type ProtectedTaskCancellationOutputIntent,
} from "@nautilo/db";
import {
  deriveTaskContentCryptoObjectIdV1, encodeTaskRunResultPayloadV1, TASK_RUN_RESULT_OBJECT_TYPE_V1,
  fingerprintTaskContentAuthorityV1, taskRuntimePreparedResultDigestV1,
  type EncryptionDataOperationOwner,
} from "@nautilo/lattice-bridge";
import {
  LatticeCrypto, TaskRuntimeRecipientRegistry, accessRevision, agentId,
  authorizationRevision, cryptoDeviceId, cryptoDomainId, humanId,
  namespaceGeneration, namespaceId, domainNamespaceRetainedAuthoritySetDigest,
  mintDomainForegroundAuthorization, prepareAgentRuntimeInitialization,
  prepareDomainNamespaceBundle, prepareNativeTaskRuntimeCancellationResultObject,
  type TaskRuntimeCancellationResultEvidence,
} from "@nautilo/lattice-crypto";
import {
  DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2, DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
  parseDomainForegroundAuthorizationPlanV2, serializeDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import { encodeTaskRuntimeBackgroundAuthorizationRequestV1 } from "@nautilo/lattice-crypto/background";
import { attachBackgroundAuthorizationRecipient, markBackgroundAuthorizationGrantReady,
  claimTaskRuntimeBackgroundAuthorizationRequest, markBackgroundAuthorizationRunning,
  type BackgroundAuthorizationTaskRuntimeRecordV3 } from "@nautilo/runtime";
import { createPreparedTaskRuntimeResultContentCryptoRevisionV1 } from
  "../../../lattice-bridge/src/task/task-content-prepared-revision";
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
  const manager = crypto.generateSigningKeyPair();
  const domainKey = bytes(0x41);
  const retained = [{ generation: namespaceGeneration(0), accessRevision: accessRevision(0),
    headDigest: bytes(0x43), generationKey: bytes(0x42) }];
  const retainedDigest = domainNamespaceRetainedAuthoritySetDigest(crypto, retained);
  const domain = { domainId: DOMAIN, sourceNamespaceId: NS, participantDigest: bytes(0x61),
    participantCount: 1, keyClass: "ai" as const, domainKeyGeneration: 4,
    authorizationRevision: authorizationRevision(9), headDigest: bytes(0x62),
    activeNamespaceBindingSetDigest: bytes(0x63), activeNamespaceBindingCount: 1 };
  const nativeCurrent = { serverId: SERVER, cryptoDomainId: cryptoDomainId(DOMAIN), participantDigest: domain.participantDigest,
    participantCount: 1, keyClass: "ai" as const, domainKeyGeneration: 4,
    domainAuthorizationRevision: authorizationRevision(9), domainHeadDigest: domain.headDigest,
    namespaceId: namespaceId(NS), namespaceAccessRevision: accessRevision(0),
    namespaceCurrentGeneration: namespaceGeneration(0), bundleRevision: 1, retainedAuthoritySetDigest: retainedDigest };
  const native = prepareDomainNamespaceBundle(crypto, { operationId: "cancel-result-binding", previousBindingDigest: null,
    bundle: { ...nativeCurrent, formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
      purpose: DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2, retainedGenerationCount: 1, retainedGenerations: retained },
    issuerHumanId: humanId(HUMAN), issuerDeviceId: cryptoDeviceId(DEVICE), issuerDeviceSigningGeneration: 1,
    issuerSigningPrivateKey: issuer.privateKey, issuerSigningPublicKey: issuer.publicKey, domainKey, issuedAt: NOW });
  const initialized = await prepareAgentRuntimeInitialization({ crypto, operationId: "cancel-initialization",
    agentId: agentId(AGENT), authorizationRevision: authorizationRevision(7),
    configObjects: [{ objectId: "agent-config", configRevision: authorizationRevision(1), plaintextDek: bytes(0x21) }],
    domains: [], resolveCurrentDomainCommitterAuthority: () => null,
    manager: { managerHumanId: humanId(HUMAN), managerAuthorizationRevision: authorizationRevision(2), managerDeviceId: cryptoDeviceId(DEVICE) },
    managerSigningPrivateKey: manager.privateKey, resolveCurrentManagerAuthority: () => manager.publicKey });
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
  const grant = parseDomainForegroundAuthorizationPlanV2(request.authorizationPlanBytes)!;
  const authorization = await mintDomainForegroundAuthorization(crypto, { plan: grant,
    domains: [{ ...domain, domainKey }], committerDeviceSigningPrivateKey: issuer.privateKey,
    recipientEncryptionPublicKey: attempt.attempt.recipientPublicKey });
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(authorization);
  const descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(request);
  const descriptorDigest = Buffer.from(crypto.hash(descriptorBytes)).toString("hex");
  const responseDigest = Buffer.from(crypto.hash(authorizationBytes)).toString("hex");
  const recipient = { recipientKeyId: attempt.attempt.recipientKeyId,
    recipientPublicKey: Buffer.from(attempt.attempt.recipientPublicKey).toString("base64url"), expiresAt: NOW + 60_000 };
  const awaiting = attachBackgroundAuthorizationRecipient(initial.snapshot, {
    ...recipient, descriptorDigest, recipientGeneration: request.recipientGeneration, now: NOW,
  });
  const ready = markBackgroundAuthorizationGrantReady(awaiting, {
    ...recipient, kind: "runtime", requestId: request.requestId, descriptorDigest,
    responseDigest, credentialDigest: responseDigest, issuingHumanId: HUMAN, issuingDeviceId: DEVICE,
    recipientGeneration: request.recipientGeneration, now: NOW,
  });
  const claimed = claimTaskRuntimeBackgroundAuthorizationRequest(ready, {
    claimId: CLAIM, now: NOW, requestDeadlineAt: NOW + 60_000, authorizationExpiresAt: NOW + 60_000,
  });
  const record = { ...initial, descriptorBytes, snapshot: markBackgroundAuthorizationRunning(claimed, NOW),
    acceptedMaterial: { credentialId: grant.authorizationId, responseBytes: authorizationBytes,
      authorizationExpiresAt: NOW + 60_000, issuingDeviceAuthorizationRevision: 5,
      issuerSigningPublicKeyHash: crypto.hash(issuer.publicKey) },
  } as unknown as BackgroundAuthorizationTaskRuntimeRecordV3;
  const state = { reserved: false, deny: false, expireDuringPrepare: false, crossKind: false,
    prepareCalls: 0, repositoryCalls: 0, authorityCalls: 0, insideAuthority: false,
    productCallbacks: 0, receiptTransactions: 0 };
  const requiredNamespaceFingerprint = bytes(0);
  const task = { id: TASK, ownerId: USER, requestorId: USER, agentId: AGENT, status: "cancelled",
    cancelledAt: intent.terminalAt, contentRepresentation: representation, contentNamespaceId: NS,
    contentRevision: 1, cryptoObjectId: `task-definition:v1:${"a".repeat(64)}`, cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: requiredNamespaceFingerprint, cryptoMappingState: "verified",
    lastErrorIsNull: true, promptIsEmpty: true, expectedOutputIsNull: true, callingRoomId: null };
  const run: Record<string, unknown> = { id: RUN, taskId: TASK, status: "cancelled", completedAt: intent.terminalAt,
    lastError: null, lastErrorIsNull: true, resultText: null, resultTextIsNull: true, resultTextIsCancelled: false,
    resultRepresentation: "ordinary", resultContentNamespaceId: null, resultRevision: 0, resultCryptoObjectId: null,
    resultCryptoAccessRevision: 0, resultCryptoRequiredNamespaceFingerprint: null, resultCryptoMappingState: "unmapped" };
  const binding: Record<string, unknown> = { taskRunId: RUN, bindingId: `task-run-output:${RUN}`, resultRevision: 2,
    resultOperationId: intent.resultOperationId, resultObjectId: intent.resultObjectId,
    acceptedPolicyRevision: 3, resultTerminalAt: intent.terminalAt, resultAttachedAt: null,
    deliveryMode: "none", destinationRoomId: null, destinationNamespaceId: null };
  let reservation: Record<string, unknown> | null = null;
  const writes: Record<string, unknown>[] = [];
  const rows = (table: unknown) => {
    if (table === encryptionTransitionPolicy) return [{ mode: representation === "dual" ? "shadow_encryption" : "encrypted_only", revision: 3 }];
    if (table === tasks) return [task];
    if (table === taskRuns) return [run];
    if (table === protectedTaskRunOutputBindings) return [binding];
    if (table === taskDefinitionCryptoRevisions) return [{ taskId: TASK, contentNamespaceId: NS, contentRevision: 1,
      cryptoObjectId: task.cryptoObjectId, representation, payloadVersion: 1, cryptoAccessRevision: 0,
      requiredNamespaceFingerprint, completion: "complete", disposition: "mapped", failureCode: null }];
    if (table === taskRunResultCryptoRevisions) return reservation === null ? [] : [reservation];
    if (table === actors) return [{ id: HUMAN }];
    throw new Error("Unexpected product table");
  };
  const tx = { select: () => ({ from: (table: unknown) => {
    const query = { where: () => query, limit: () => query, for: async () => rows(table) }; return query;
  } }), update: (table: unknown) => ({ set: (patch: Record<string, unknown>) => ({ where: () => ({ returning: async () => {
    if (table === taskRuns) { expect(state.insideAuthority).toBe(true); writes.push(patch); Object.assign(run, patch,
      { resultTextIsNull: patch["resultText"] === null, resultTextIsCancelled: patch["resultText"] === "Task cancelled" }); return [{ id: RUN }]; }
    if (table === protectedTaskRunOutputBindings) { Object.assign(binding, patch); return [binding]; }
    throw new Error("Unexpected product update");
  } }) }) }) };
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => state.reserved ? [{ operationId: intent.resultOperationId }] : [] }) }) }),
    transaction: async (use: (value: typeof tx) => Promise<unknown>) => {
      // Publication's product write must use the supplied tx directly. Only
      // the final attachment receipt may open an independent transaction.
      expect(state.insideAuthority).toBe(false); state.receiptTransactions++; return use(tx);
    } } as unknown as DirectDatabase;
  const restricted = {} as PostgresJsBridgeConnection;
  const authority: ProtectedTaskCancellationAuthorityPort = {
    withDiscovery: async () => { throw new Error("Unexpected discovery"); }, withBound: async () => { throw new Error("Unexpected bound"); },
    withAccepted: async input => {
      state.authorityCalls++; if (state.deny) return null;
      expect(state.insideAuthority).toBe(false); state.insideAuthority = true;
      try { await input.validateBeforeCommit();
        const result = await input.use({ ...current, plan: grant }, restricted, restricted, tx as never);
        await input.validateBeforeCommit(); return result;
      } finally { state.insideAuthority = false; }
    },
  };
  const dependencies: ProtectedTaskCancellationPublicationDependencies = {
    prepare: async input => {
      state.prepareCalls++;
      await input.assertCurrentTaskAuthority();
      const plaintext = encodeTaskRunResultPayloadV1({ formatVersion: 1, resultText: "Task cancelled", lastError: null });
      try {
        const nativePrepared = await prepareNativeTaskRuntimeCancellationResultObject(crypto, { evidence: input.evidence,
          plaintext, objectType: TASK_RUN_RESULT_OBJECT_TYPE_V1, createdAt: NOW, agentAuthorizationRevision: 7,
          runtime: initialized.runtime, signerPublication: initialized.signerPublication,
          resolveHistoricalSignerPublicationManager: () => manager.publicKey,
          namespace: { current: nativeCurrent, bindingBytes: native.bytes, expectedBindingDigest: native.bindingDigest,
            issuerSigningPublicKey: issuer.publicKey, domainKey } });
        const prepared = createPreparedTaskRuntimeResultContentCryptoRevisionV1({ coordinate, authority: input.authority, prepared: nativePrepared });
        if (state.expireDuringPrepare) clock = NOW + 60_000;
        return prepared;
      } finally { plaintext.fill(0); }
    },
    repository: async () => {
      state.repositoryCalls++;
      return { publishPreparedProtectedOrDual: async input => {
        expect(input.ordinaryContent.payload).toEqual({ formatVersion: 1, resultText: "Task cancelled", lastError: null });
        expect(input.ordinaryContent.coordinate).toEqual(coordinate);
        expect(input.requestDigest).toEqual(taskRuntimePreparedResultDigestV1(input.prepared));
        reservation = { taskId: TASK, taskRunId: RUN, contentNamespaceId: NS, anchorNamespaceId: NS,
          resultRevision: 2, operationId: intent.resultOperationId, requestDigest: input.requestDigest,
          authorityFingerprint: fingerprintTaskContentAuthorityV1(input.authority), requesterHumanId: HUMAN,
          cryptoObjectId: intent.resultObjectId, representation, payloadVersion: 1, cryptoAccessRevision: 0,
          requiredNamespaceFingerprint, completion: "pending", disposition: "active", failureCode: null };
        state.productCallbacks++;
        const context = { revalidationToken: 3 } as never;
        const product = representation === "dual"
          ? await input.publishDualProduct(input.ordinaryContent, context) : await input.publishProtectedProduct(context);
        Object.assign(run, { resultRepresentation: representation, resultRevision: 2,
          resultCryptoObjectId: intent.resultObjectId, resultCryptoMappingState: "verified" });
        return { product, representation, protectedRevision: { status: "mapped", coordinate, cryptoObjectId: intent.resultObjectId } };
      } };
    },
  };
  const publish = createProtectedTaskCancellationPublication({ db, restricted, crypto,
    owner: {} as EncryptionDataOperationOwner, serverScope: SERVER, authority, now: () => clock }, dependencies);
  const withEvidence = <Value>(use: (publication: Parameters<typeof publish>[0]) => Promise<Value>) =>
    recipients.withOpenedCancellationResultGrant({ requestId: request.requestId, workId: RUN,
      recipientGeneration: request.recipientGeneration, recipientKeyId: request.recipientKeyId,
      claimId: CLAIM, claimExpiresAt: NOW + 60_000, authorizationBytes,
      current: { authorizationId: grant.authorizationId, policyRevision: 3, sessionId: grant.sessionId, roomId: ROOM,
        subjectHumanId: grant.subjectHumanId, committerDeviceId: grant.committerDeviceId,
        committerDeviceSigningGeneration: 1, committerDeviceSigningPublicKey: issuer.publicKey, committerDeviceActive: true,
        hostAuthorizationRevision: grant.hostAuthorizationRevision, recipientKind: "runtime", recipientPrincipalId: "nautilo_task_runtime",
        recipientAuthorizationRevision: authorizationRevision(0), recipientRuntimeGeneration: request.recipientGeneration,
        recipientKeyId: request.recipientKeyId, recipientAuthorized: true, domains: [domain] },
      currentNamespaceRequirements: initial.authoritySet.namespaceRequirements,
      result: { taskId: TASK, taskRunId: RUN, contentRevision: 2, objectId: intent.resultObjectId, signerAgentId: AGENT,
        namespace: { namespaceId: NS, domainId: DOMAIN, operations: ["encrypt"], expectedAccessRevision: 0, expectedPolicyRevision: 3 } },
      operation: (domains, signal, evidence) => use({ plan, record, domains, signal, evidence, assertCurrentClaim: () => {} }) });
  return { state, publish, withEvidence, writes, binding };
}

for (const representation of ["protected", "dual"] as const) {
  test(`publishes fixed ${representation} cancellation on the held canonical product transaction`, async () => {
    const value = await fixture(representation);
    const result = await value.withEvidence(value.publish);
    expect(result.status).toBe("opened");
    expect(value.state.prepareCalls).toBe(1);
    expect(value.state.productCallbacks).toBe(1);
    expect(value.state.receiptTransactions).toBe(1);
    expect(value.binding["resultAttachedAt"]).toEqual(new Date(NOW));
    expect(value.writes).toEqual(representation === "dual" ? [{ resultText: "Task cancelled", lastError: null }] : []);
  });
}

test("existing immutable reservation refuses before preparing any new ciphertext", async () => {
  const value = await fixture(); value.state.reserved = true;
  const error = await value.withEvidence(value.publish).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect(value.state.prepareCalls).toBe(0); expect(value.state.repositoryCalls).toBe(0);
});

test("denied current authority refuses before preparation or publication", async () => {
  const value = await fixture(); value.state.deny = true;
  expect(await value.withEvidence(value.publish).catch((failure: unknown) => failure)).toBeInstanceOf(Error);
  expect(value.state.prepareCalls).toBe(0); expect(value.writes).toEqual([]);
});

test("evidence expiry during preparation refuses the repository and product write", async () => {
  const value = await fixture(); value.state.expireDuringPrepare = true;
  expect(await value.withEvidence(value.publish).catch((failure: unknown) => failure)).toBeInstanceOf(Error);
  expect(value.state.prepareCalls).toBe(1); expect(value.state.repositoryCalls).toBe(0);
});

test("cross-kind record and forged evidence cannot publish a cancellation", async () => {
  for (const scenario of ["kind", "evidence"] as const) {
    const value = await fixture();
    const result = await value.withEvidence(publication => value.publish(scenario === "kind"
      ? { ...publication, record: { ...publication.record, workKind: "task.execute", purpose: "task.execute" } }
      : { ...publication, evidence: { ...publication.evidence } as TaskRuntimeCancellationResultEvidence }))
      .catch((failure: unknown) => failure);
    expect(result).toBeInstanceOf(Error); expect(value.state.prepareCalls).toBe(0);
  }
});
