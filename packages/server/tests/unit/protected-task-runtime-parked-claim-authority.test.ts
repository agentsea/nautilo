import { expect, test } from "bun:test";

import type { ParkedProtectedTaskAdditionalAuthority } from "@nautilo/db";
import {
  LatticeCrypto,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  domainForegroundNamespaceBindingSetDigest,
  humanId,
  type DomainForegroundAuthorityEntry,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import type {
  CurrentTaskRuntimeAuthority,
  ParkedTaskRuntimeCurrentRoutingFacts,
} from "@nautilo/lattice-bridge/server";
import {
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type BackgroundAuthorizationTaskRuntimeReplacementRepository,
} from "@nautilo/runtime";

import type { ParkedProtectedTaskRuntimeMemoryPlan } from
  "../../src/routes/protected-task-runtime-parked-memory-plan";
import {
  createParkedTaskRuntimeAuthorizationRecord,
  type ParkedTaskRuntimeAuthorizationPlan,
} from "../../src/routes/protected-task-runtime-parked-plan";
import {
  createProtectedTaskRuntimeParkedClaimAuthority,
} from "../../src/routes/protected-task-runtime-parked-claim-authority";

const NOW = 1_900_000_000_000;
const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const TASK = "40000000-0000-4000-8000-000000000004";
const RUN = "50000000-0000-4000-8000-000000000005";
const PRIOR_JOB = "60000000-0000-4000-8000-000000000006";
const CONTENT = "70000000-0000-4000-8000-000000000007";
const SOURCE = "80000000-0000-4000-8000-000000000008";
const TARGET = "90000000-0000-4000-8000-000000000009";
const DOMAIN = "a0000000-0000-4000-8000-00000000000a";
const REQUEST = "task-run-authorization:v2:parked-claim";
const INPUT = `task-definition:v1:${"a".repeat(64)}`;
const RESULT = `task-run-result:v1:${"b".repeat(64)}`;

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

async function fixture() {
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const domain: DomainForegroundAuthorityEntry = Object.freeze({
    domainId: DOMAIN,
    sourceNamespaceId: CONTENT,
    participantDigest: bytes(1),
    participantCount: 1,
    keyClass: "ai",
    domainKeyGeneration: 2,
    authorizationRevision: authorizationRevision(3),
    headDigest: bytes(2),
    activeNamespaceBindingSetDigest: domainForegroundNamespaceBindingSetDigest(
      crypto,
      [{ namespaceId: CONTENT, bindingDigest: bytes(3) }],
    ),
    activeNamespaceBindingCount: 1,
  });
  const facts: ParkedTaskRuntimeCurrentRoutingFacts = {
    taskId: TASK, taskRunId: RUN, ownerId: USER, requestorId: USER,
    agentId: AGENT, callingRoomId: SOURCE, scheduleKind: "now",
    graphThreadId: "task-thread", startedAt: new Date(NOW - 1_000),
    sourceRoomId: SOURCE, targetRoomId: TARGET, targetUserIds: [USER],
    memoryMode: "namespace", wideBringBack: false, scopeId: null,
    contentRepresentation: "dual", contentNamespaceId: CONTENT,
    contentRevision: 1, contentObjectId: INPUT, contentAccessRevision: 0,
    requiredNamespaceFingerprint: bytes(4),
  };
  const occurrence = {
    task: { id: TASK, ownerId: USER, requestorId: USER, agentId: AGENT,
      callingRoomId: SOURCE, scheduleKind: "now" as const,
      contentRepresentation: "dual" as const, contentNamespaceId: CONTENT,
      contentRevision: 1, cryptoObjectId: INPUT, cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: facts.requiredNamespaceFingerprint },
    run: { id: RUN, taskId: TASK, jobId: PRIOR_JOB,
      graphThreadId: facts.graphThreadId, status: "awaiting" as const,
      startedAt: new Date(NOW - 1_000) },
  };
  const expected = {
    occurrence,
    priorJob: { reference: { resultObjectId: RESULT } },
    proof: { continuation: { semanticAuthorityRequirements: [] } },
    authorizationRequestId: REQUEST,
    continuationFingerprint: Buffer.alloc(32, 5).toString("base64url"),
    nextExecutionSegment: 2,
  } as unknown as ParkedProtectedTaskAdditionalAuthority;
  const memory: ParkedProtectedTaskRuntimeMemoryPlan = {
    routing: { taskId: TASK, taskRunId: RUN, requesterUserId: USER,
      requesterHumanId: HUMAN, agentId: AGENT, sourceRoomId: SOURCE,
      sourceNamespaceId: CONTENT, targetRoomId: TARGET, targetUserIds: [USER],
      memoryMode: "namespace", scopeId: null, targetChat: "new_in_namespace",
      wideBringBack: false, widePrivateNamespaceId: null,
      outputRoomId: SOURCE, outputNamespaceId: CONTENT },
    resolution: { mode: "namespace", authorityStatus: "exact",
      provenance: "target_users_namespace", envelope: { memoryMode: "namespace",
        ownerId: USER, actorId: HUMAN, agentId: AGENT, roomId: TARGET,
        readableNamespaces: [CONTENT], mutableNamespaces: [CONTENT],
        writableNamespaces: [CONTENT], toolPolicy: {} } },
  };
  const resolved = Object.freeze({
    expected,
    output: { taskRunId: RUN, bindingId: `task-run-output:${RUN}`,
      resultOperationId: `task-run-result:${RUN}`, resultObjectId: RESULT,
      destinationRoomId: SOURCE, destinationNamespaceId: CONTENT,
      deliveryMode: "raw" as const, acceptedPolicyRevision: 7 },
    policy: { mode: "shadow_encryption" as const,
      shadowBehavior: "strict" as const, revision: 7 },
    memory,
    inventory: Object.freeze({ namespaceIds: Object.freeze([CONTENT]),
      operations: () => Object.freeze(["decrypt" as const, "encrypt" as const]) }),
    validateCurrentRouting: (value: ParkedTaskRuntimeCurrentRoutingFacts) =>
      value.taskRunId === facts.taskRunId && value.targetRoomId === facts.targetRoomId,
  }) as unknown as ParkedTaskRuntimeAuthorizationPlan;
  const authorityFact = { namespaceId: CONTENT, domainId: DOMAIN,
    expectedAccessRevision: 0, expectedPolicyRevision: 7,
    expectedDomainEpoch: 2, expectedAuthorizationRevision: 3 };
  const canonical = createParkedTaskRuntimeAuthorizationRecord(
    resolved,
    facts,
    [authorityFact],
    NOW,
  );
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: REQUEST, policyRevision: 7, sessionId: "episode:parked",
    roomId: SOURCE, subjectHumanId: humanId(HUMAN),
    committerDeviceId: cryptoDeviceId("device:parked"),
    committerDeviceSigningGeneration: 2,
    hostAuthorizationRevision: authorizationRevision(4),
    recipientKind: "runtime", recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 1, recipientKeyId: "recipient:parked",
    operations: ["decrypt", "encrypt"], issuedAt: NOW,
    deadlineAt: NOW + 60_000, maximumSecretBytes: 4_096, domains: [domain],
  });
  const request = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: REQUEST, workId: RUN, workKind: "task.execute",
    workPurpose: "task.execute", recipientGeneration: 1,
    episodeId: plan.sessionId, sourceRoomId: SOURCE,
    recipientKeyId: plan.recipientKeyId, recipientPublicKey: recipient.publicKey,
    authorizationPlan: plan, issuedAt: NOW, deadlineAt: NOW + 60_000,
  });
  const descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(request);
  const selected = {
    ...canonical.initialRecord,
    snapshot: { ...canonical.initialRecord.snapshot, state: "grant_ready" as const,
      requestRevision: 2, updatedAt: NOW + 1, descriptorDigest: "11".repeat(32),
      recipientGeneration: 1, recipient: { recipientKeyId: plan.recipientKeyId,
        recipientPublicKey: Buffer.from(recipient.publicKey).toString("base64url"),
        expiresAt: NOW + 60_000 },
      acceptedResponse: { kind: "runtime" as const,
        responseDigest: "22".repeat(32), credentialDigest: "22".repeat(32),
        issuingHumanId: HUMAN, issuingDeviceId: plan.committerDeviceId,
        recipientGeneration: 1, acceptedAt: NOW + 1 } },
    descriptorBytes,
    acceptedMaterial: { responseBytes: new Uint8Array([1, 2, 3]),
      credentialId: REQUEST,
      issuingDeviceAuthorizationRevision: plan.hostAuthorizationRevision,
      issuerSigningPublicKeyHash: crypto.hash(signing.publicKey),
      authorizationExpiresAt: NOW + 60_000 },
  } as BackgroundAuthorizationTaskRuntimeRecordV3;
  const current: CurrentTaskRuntimeAuthority = {
    device: { userId: USER, humanActorId: HUMAN,
      deviceId: plan.committerDeviceId, deviceGeneration: 2,
      serverInstanceId: "b0000000-0000-4000-8000-00000000000b",
      lineageGeneration: 1, epoch: 1, securityRevision: 4,
      headDigest: bytes(6), signingPublicKey: signing.publicKey },
    plan, domains: [domain],
    namespaceRequirements: selected.authoritySet.namespaceRequirements,
    policyRevision: 7,
  };
  recipient.privateKey.fill(0);
  return { crypto, signing, facts, occurrence, resolved, canonical, request,
    selected, current };
}

test("lends only the exact selected canonical record through the held repository", async () => {
  const f = await fixture();
  let held = false;
  let repositoryReads = 0;
  const repository = { get: async (requestId: string) => {
    expect(held).toBe(true);
    expect(requestId).toBe(REQUEST);
    repositoryReads += 1;
    return f.selected;
  } } as BackgroundAuthorizationTaskRuntimeReplacementRepository;
  const adapter = createProtectedTaskRuntimeParkedClaimAuthority({
    db: {} as never, restricted: {} as never, crypto: f.crypto,
    serverScope: "https://server.example", resolvePlan: async input => {
      expect(input.occurrence).toEqual(f.occurrence);
      return f.resolved;
    }, now: () => NOW + 2,
  }, {
    productContext: async () => ({ canonicalRunner: {} }) as never,
    withAuthority: async input => {
      expect(input.validateCurrentRouting(f.facts)).toBe(true);
      held = true;
      try { return await input.use(f.current, {} as never, { persistJob: async () => {
        throw new Error("unexpected persistence");
      } }); }
      finally { held = false; }
    },
    repository: async () => repository,
  });
  let callbackHeld = false;
  const result = await adapter.withPlan({ occurrence: f.occurrence,
    record: f.selected, request: f.request }, async value => {
    callbackHeld = held;
    expect(value.canonical.initialRecord.idempotencyKey)
      .toBe(f.canonical.initialRecord.idempotencyKey);
    expect(value.repository).toBe(repository);
    return "accepted";
  });
  expect(result).toBe("accepted");
  expect(callbackHeld).toBe(true);
  expect(held).toBe(false);
  expect(repositoryReads).toBe(1);
  f.signing.privateKey.fill(0);
});

test("rejects expired requests and claims without entering the caller use", async () => {
  const f = await fixture();
  let useCalls = 0;
  let clock = NOW + 60_000;
  const adapter = createProtectedTaskRuntimeParkedClaimAuthority({
    db: {} as never, restricted: {} as never, crypto: f.crypto,
    serverScope: "https://server.example", resolvePlan: async () => f.resolved,
    now: () => clock,
  }, {
    productContext: async () => ({ canonicalRunner: {} }) as never,
    withAuthority: async input => {
      expect(input.validateCurrentRouting(f.facts)).toBe(true);
      return input.use(f.current, {} as never, { persistJob: async () => {
        throw new Error("unexpected persistence");
      } });
    },
    repository: async () => ({ get: async () => f.selected }) as never,
  });
  expect(await adapter.claim({ occurrence: f.occurrence, record: f.selected,
    request: f.request, now: () => NOW + 60_000,
    use: () => { useCalls += 1; return "claimed"; } })).toBeNull();
  clock = NOW + 3;
  const claimed = { ...f.selected, snapshot: { ...f.selected.snapshot,
    state: "claimed" as const, claimId: "claim:parked",
    claimedAt: NOW, claimExpiresAt: NOW + 2 } };
  expect(await adapter.withPlan({ occurrence: f.occurrence, record: claimed,
    request: f.request }, async () => { useCalls += 1; })).toBeNull();
  expect(useCalls).toBe(0);
  f.signing.privateKey.fill(0);
});

test("uses an immutable caller snapshot across asynchronous plan resolution", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let resolvedJobId: string | null | undefined;
  const adapter = createProtectedTaskRuntimeParkedClaimAuthority({
    db: {} as never, restricted: {} as never, crypto: f.crypto,
    serverScope: "https://server.example", resolvePlan: async input => {
      entered.resolve();
      await release.promise;
      resolvedJobId = input.occurrence?.run.jobId;
      return f.resolved;
    }, now: () => NOW + 2,
  }, {
    productContext: async () => ({ canonicalRunner: {} }) as never,
    withAuthority: async input => {
      expect(input.validateCurrentRouting(f.facts)).toBe(true);
      return input.use(f.current, {} as never, { persistJob: async () => {
        throw new Error("unexpected persistence");
      } });
    },
    repository: async () => ({ get: async () => f.selected }) as never,
  });
  const occurrence = structuredClone(f.occurrence);
  const record = structuredClone(f.selected);
  const pending = adapter.withPlan({ occurrence, record, request: f.request },
    async () => "snapshot");
  await entered.promise;
  occurrence.run.jobId = "job:substituted";
  Reflect.set(record.snapshot, "requestId", "request:substituted");
  release.resolve();
  expect(await pending).toBe("snapshot");
  expect(resolvedJobId).toBe(PRIOR_JOB);
  f.signing.privateKey.fill(0);
});
