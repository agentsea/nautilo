import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  TaskRuntimeRecipientRegistry,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  domainForegroundNamespaceBindingSetDigest,
  humanId,
  mintDomainForegroundAuthorization,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  destroyDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
  type DomainForegroundAuthorizationPlanV2,
  type DomainForegroundAuthorizationPublicCurrentAuthorityV2,
} from "@nautilo/lattice-crypto/wire";
import type { StartProtectedTaskRunInput } from "@nautilo/db";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import type { TaskScopeMemoryBinding } from "@nautilo/lattice-bridge/server";

import type { JobExecutor } from "../../src/job";
import {
  createBackgroundAuthorizationTaskRuntimeRequestV3,
} from "../../src/protected-execution/background-authorization/lifecycle";
import {
  InMemoryBackgroundAuthorizationRepository,
  type BackgroundAuthorizationCasResult,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeReplacementRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "../../src/protected-execution/background-authorization/repository";
import {
  attachExactTaskRuntimeRecipient,
  createTaskRuntimeGrantClaim,
  prepareUnclaimedParkedTaskRuntimeAuthority,
  rotateExpiredTaskRuntimeRecipient,
  sameTaskRuntimeAuthorityPlan,
  taskRuntimeStableIdempotencyKey,
  taskRuntimeStableRoutingDigest,
  type TaskRuntimeRecipientDeviceBinding,
  type TaskRuntimeRecipientCurrentAuthority,
  type TaskRuntimeGrantClaimPlan,
} from "../../src/protected-execution/background-authorization/task-runtime-grant-claim";
import type {
  ProtectedTaskAuthorityOccurrence,
  ProtectedTaskOccurrence,
  ProtectedTaskRunningOccurrence,
} from "../../src/tasks/task-observer";

const NOW = 1_800_500_000_000;
const OWNER = "10000000-0000-4000-8000-000000000001";
const REQUESTOR = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const ROOM = "40000000-0000-4000-8000-000000000004";
const PRIVATE_TASK_ROOM = "40000000-0000-4000-8000-000000000014";
const OPEN_ROOM = "40000000-0000-4000-8000-000000000024";
const TASK = "50000000-0000-4000-8000-000000000005";
const RUN = "60000000-0000-4000-8000-000000000006";
const JOB = "61000000-0000-4000-8000-000000000006";
const NAMESPACE = "70000000-0000-4000-8000-000000000007";
const SCOPE = "80000000-0000-4000-8000-000000000008";
const MEMORY_ROOM = "90000000-0000-4000-8000-000000000009";
const SCOPE_ORIGIN = "a0000000-0000-4000-8000-00000000000a";
const SCOPE_SEED = "b0000000-0000-4000-8000-00000000000b";
const SCOPE_FOREIGN_READ = "c0000000-0000-4000-8000-00000000000c";
const OUTPUT_NAMESPACE = "d0000000-0000-4000-8000-00000000000d";
const DOMAIN = "task-runtime-domain";
const REQUEST = `task-run-authorization:${RUN}`;
const INPUT_OBJECT = deriveTaskContentCryptoObjectIdV1({
  kind: "definition",
  taskId: TASK,
  contentRevision: 1,
});
const RESULT_OBJECT = deriveTaskContentCryptoObjectIdV1({
  kind: "run_result",
  taskId: TASK,
  taskRunId: RUN,
  contentRevision: 1,
});
const SENTINEL = "TASK_RUNTIME_TRANSIENT_SENTINEL";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function digest(value: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(value).digest());
}

function copyAuthority(
  current: DomainForegroundAuthorizationPublicCurrentAuthorityV2,
): DomainForegroundAuthorizationPublicCurrentAuthorityV2 {
  return {
    ...current,
    committerDeviceSigningPublicKey:
      current.committerDeviceSigningPublicKey.slice(),
    domains: current.domains.map((domain) => ({
      ...domain,
      participantDigest: domain.participantDigest.slice(),
      headDigest: domain.headDigest.slice(),
      activeNamespaceBindingSetDigest:
        domain.activeNamespaceBindingSetDigest.slice(),
    })),
  };
}

function destroyAuthority(
  current: DomainForegroundAuthorizationPublicCurrentAuthorityV2,
): void {
  current.committerDeviceSigningPublicKey.fill(0);
  for (const domain of current.domains) {
    domain.participantDigest.fill(0);
    domain.headDigest.fill(0);
    domain.activeNamespaceBindingSetDigest.fill(0);
  }
}

function occurrence(callingRoomId: string | null = ROOM): ProtectedTaskOccurrence {
  return Object.freeze({
    task: Object.freeze({
      id: TASK,
      ownerId: OWNER,
      requestorId: REQUESTOR,
      agentId: AGENT,
      callingRoomId,
      scheduleKind: "now" as const,
      contentRepresentation: "protected" as const,
      contentNamespaceId: NAMESPACE,
      contentRevision: 1,
      cryptoObjectId: INPUT_OBJECT,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: bytes(7),
    }),
    run: Object.freeze({
      id: RUN,
      taskId: TASK,
      jobId: null,
      graphThreadId: `subagent:${TASK}:${RUN}`,
      status: "awaiting" as const,
      startedAt: new Date(NOW),
    }),
  });
}

function stableIdentity(value = occurrence()): TaskRuntimeGrantClaimPlan["stableIdentity"] {
  return Object.freeze({
    taskId: value.task.id,
    taskRunId: value.run.id,
    executionSegment: 1,
    resumeContinuationFingerprint: null,
    ownerId: value.task.ownerId,
    requestorId: value.task.requestorId,
    agentId: value.task.agentId,
    callingRoomId: value.task.callingRoomId,
    scheduleKind: value.task.scheduleKind,
    graphThreadId: value.run.graphThreadId,
    startedAt: value.run.startedAt.getTime(),
    sourceRoomId: ROOM,
    targetRoomId: ROOM,
    targetUserIds: Object.freeze([value.task.requestorId]),
    outputRoomId: value.task.callingRoomId,
    outputNamespaceId: value.task.callingRoomId === null ? null : NAMESPACE,
    memoryMode: "namespace",
    scopeId: null,
    contentRepresentation: value.task.contentRepresentation,
    contentNamespaceId: value.task.contentNamespaceId,
    contentRevision: value.task.contentRevision,
    contentObjectId: value.task.cryptoObjectId,
    contentAccessRevision: value.task.cryptoAccessRevision,
    requiredNamespaceFingerprint: Buffer.from(
      value.task.cryptoRequiredNamespaceFingerprint,
    ).toString("base64url"),
  });
}

function initialRecord(): BackgroundAuthorizationTaskRuntimeRecordV3 {
  return Object.freeze({
    snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({
      requestId: REQUEST,
      workId: RUN,
      namespaceId: NAMESPACE,
      now: NOW,
    }),
    workIdentityHash: bytes(10),
    idempotencyKey: taskRuntimeStableIdempotencyKey(stableIdentity()),
    workKind: "task.execute" as const,
    purpose: "task.execute" as const,
    domainId: DOMAIN,
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 2,
    expectedNamespaceAccessRevision: 3,
    expectedPolicyRevision: 7,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
    authoritySet: Object.freeze({
      namespaceRequirements: Object.freeze([Object.freeze({
        ordinal: 0,
        namespaceId: NAMESPACE,
        domainId: DOMAIN,
        operations: Object.freeze(["decrypt", "encrypt"] as const),
        expectedAccessRevision: 3,
        expectedPolicyRevision: 7,
      })]),
      domainRequirements: Object.freeze([Object.freeze({
        ordinal: 0,
        domainId: DOMAIN,
        expectedEpoch: 2,
        expectedAuthorizationRevision: 3,
      })]),
    }),
  });
}

function requiredTaskRuntimeRecord(
  value: BackgroundAuthorizationRecord | null,
): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const snapshot = value?.snapshot;
  if (
    value === null
    || snapshot === undefined
    || snapshot.formatVersion !== 3
    || snapshot.credentialSubject.kind !== "runtime"
    || snapshot.credentialSubject.runtimeKind !== "task"
    || snapshot.credentialSubject.runtimeVersion !== 1
    || value.authoritySet === undefined
  ) {
    throw new Error("selected Task Runtime record missing");
  }
  return value as BackgroundAuthorizationTaskRuntimeRecordV3;
}

function parkedPreparation() {
  const initialOccurrence = occurrence();
  const parkedOccurrence: ProtectedTaskOccurrence = Object.freeze({
    task: initialOccurrence.task,
    run: Object.freeze({ ...initialOccurrence.run, jobId: JOB }),
  });
  const stable = Object.freeze({
    ...stableIdentity(parkedOccurrence),
    executionSegment: 2,
    resumeContinuationFingerprint:
      Buffer.from(bytes(23)).toString("base64url"),
  });
  const initial = Object.freeze({
    ...initialRecord(),
    idempotencyKey: taskRuntimeStableIdempotencyKey(stable),
  });
  return { occurrence: parkedOccurrence, stableIdentity: stable, initialRecord: initial };
}

function scopeBinding(
  readableNamespaceIds: readonly string[] = [SCOPE_ORIGIN],
): TaskScopeMemoryBinding {
  return Object.freeze({
    scopeId: SCOPE,
    memoryRoomId: MEMORY_ROOM,
    originWritableNamespaceId: SCOPE_ORIGIN,
    readableNamespaceIds: Object.freeze([...readableNamespaceIds]),
  });
}

function scopePlan(
  plan: TaskRuntimeGrantClaimPlan,
  binding: TaskScopeMemoryBinding,
  workIdentityFill: number,
): TaskRuntimeGrantClaimPlan {
  const stableIdentity = Object.freeze({
    ...plan.stableIdentity,
    memoryMode: "scope" as const,
    scopeId: binding.scopeId,
  });
  const namespaceRequirements = Object.freeze([
    plan.initialRecord.authoritySet.namespaceRequirements[0]!,
    ...binding.readableNamespaceIds
      .filter(namespaceId => namespaceId !== NAMESPACE)
      .map((namespaceId, index) => Object.freeze({
        ordinal: index + 1,
        namespaceId,
        domainId: DOMAIN,
        operations: namespaceId === binding.originWritableNamespaceId
          ? Object.freeze(["decrypt", "encrypt"] as const)
          : Object.freeze(["decrypt"] as const),
        expectedAccessRevision: 4 + index,
        expectedPolicyRevision: 7,
      })),
  ]);
  return Object.freeze({
    ...plan,
    stableIdentity,
    scopeMemory: binding,
    initialRecord: Object.freeze({
      ...plan.initialRecord,
      workIdentityHash: bytes(workIdentityFill),
      idempotencyKey: taskRuntimeStableIdempotencyKey(stableIdentity),
      authoritySet: Object.freeze({
        ...plan.initialRecord.authoritySet,
        namespaceRequirements,
      }),
    }),
  });
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const recipients = new TaskRuntimeRecipientRegistry(crypto, { now: () => NOW });
  const domain = Object.freeze({
    domainId: DOMAIN,
    sourceNamespaceId: NAMESPACE,
    participantDigest: bytes(1),
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 2,
    authorizationRevision: authorizationRevision(3),
    headDigest: bytes(4),
    activeNamespaceBindingSetDigest:
      domainForegroundNamespaceBindingSetDigest(crypto, [{
        namespaceId: NAMESPACE,
        bindingDigest: bytes(5),
      }]),
    activeNamespaceBindingCount: 1,
  });
  const binding: TaskRuntimeRecipientDeviceBinding = Object.freeze({
    userId: REQUESTOR,
    humanActorId: REQUESTOR,
    deviceId: "task-runtime-device",
  });
  let currentAuthority: DomainForegroundAuthorizationPublicCurrentAuthorityV2
    | null = null;
  let provenSourceRoomId = ROOM;
  let currentNamespaceRequirements = initialRecord()
    .authoritySet.namespaceRequirements;
  let grantPlan: DomainForegroundAuthorizationPlanV2 | null = null;
  let claimCasCount = 0;
  let recipientRotationCasCount = 0;
  let replacementCasCount = 0;
  let recipientCasBarrier: ReturnType<typeof Promise.withResolvers<void>>
    | null = null;
  let recipientCasArrivals = 0;
  let authorityLocksHeld = false;
  let beforeClaimAuthorityUse: (() => void) | null = null;
  let clock = NOW + 1;
  let substituteGet: ((record: BackgroundAuthorizationRecord) =>
    BackgroundAuthorizationRecord) | null = null;
  let substitutePlan: ((plan: TaskRuntimeGrantClaimPlan) =>
    TaskRuntimeGrantClaimPlan) | null = null;
  const startInputs: StartProtectedTaskRunInput[] = [];
  const publishedResults: string[] = [];
  const openedOccurrences: ProtectedTaskRunningOccurrence[] = [];
  const publishedOccurrences: ProtectedTaskRunningOccurrence[] = [];
  const authorityOccurrences: ProtectedTaskAuthorityOccurrence[] = [];
  let startResult: "started" | "stale" = "started";
  const trackedRepository: BackgroundAuthorizationTaskRuntimeReplacementRepository = {
    create: (record) => repository.create(record),
    get: async (requestId) => {
      const record = await repository.get(requestId);
      return record === null || substituteGet === null
        ? record
        : substituteGet(record);
    },
    compareAndSwap: async (input): Promise<BackgroundAuthorizationCasResult> => {
      if (input.next.snapshot.state === "claimed") {
        throw new Error("claim CAS escaped its held repository");
      }
      if (input.next.snapshot.state === "awaiting_recipient"
        && input.next.snapshot.lastRetryReason === "attempt_expired") {
        recipientRotationCasCount += 1;
      }
      if (
        input.next.snapshot.state === "awaiting_device"
        && recipientCasBarrier !== null
      ) {
        recipientCasArrivals += 1;
        if (recipientCasArrivals === 2) recipientCasBarrier.resolve();
        await recipientCasBarrier.promise;
      }
      return repository.compareAndSwap(input);
    },
    replaceUnclaimedTaskRuntimeAuthority: (input) => {
      replacementCasCount += 1;
      return repository.replaceUnclaimedTaskRuntimeAuthority(input);
    },
    acceptVerifiedResponse: (input) => repository.acceptVerifiedResponse(input),
    listEligible: (input) => repository.listEligible(input),
    listAwaitingDevicePage: (input) => repository.listAwaitingDevicePage(input),
    pruneTerminal: (input) => repository.pruneTerminal(input),
  };
  const heldClaimRepository = {
    compareAndSwap: async (input: Parameters<
      BackgroundAuthorizationTaskRuntimeReplacementRepository["compareAndSwap"]
    >[0]): Promise<BackgroundAuthorizationCasResult> => {
      if (input.next.snapshot.state === "claimed") claimCasCount += 1;
      return repository.compareAndSwap(input);
    },
  };
  const executor: JobExecutor = async function* () { yield* []; };
  const builtRecipientKeys: string[] = [];
  const basePlan = (
    value: ProtectedTaskOccurrence,
  ): TaskRuntimeGrantClaimPlan => {
    const identity = stableIdentity(value);
    return {
    stableIdentity: identity,
    initialRecord: Object.freeze({
      ...initialRecord(),
      idempotencyKey: taskRuntimeStableIdempotencyKey(identity),
    }),
    reference: {
      kind: "protected_task_run_v1",
      taskId: TASK,
      taskRunId: RUN,
      inputObjectId: INPUT_OBJECT,
      resultObjectId: RESULT_OBJECT,
      authorizationRequestId: REQUEST,
      policyRevision: 7,
      executionSegment: 1,
    },
    scheduling: {
      ownerId: OWNER,
      requestorId: REQUESTOR,
      agentId: AGENT,
      roomId: ROOM,
      callingRoomId: value.task.callingRoomId,
      graphThreadId: value.run.graphThreadId,
    },
    executor,
    startProtectedTaskRun: async (input) => {
      startInputs.push(input);
      return { status: startResult };
    },
    recipientAttempt: () => ({
      recipientKeyId: "task-runtime-recipient",
      expiresAt: NOW + 60_000,
    }),
    buildRequest: ({ attempt, binding: currentBinding, authority }) => {
      builtRecipientKeys.push(Buffer.from(attempt.recipientPublicKey)
        .toString("base64url"));
      grantPlan = createDomainForegroundAuthorizationPlan(crypto, {
        authorizationId: REQUEST,
        policyRevision: authority.policyRevision,
        sessionId: `task-run:${RUN}`,
        roomId: authority.sourceRoomId,
        subjectHumanId: humanId(currentBinding.humanActorId),
        committerDeviceId: cryptoDeviceId(currentBinding.deviceId),
        committerDeviceSigningGeneration: authority.device.deviceGeneration,
        hostAuthorizationRevision:
          authorizationRevision(authority.device.securityRevision),
        recipientKind: "runtime",
        recipientPrincipalId: "nautilo_task_runtime",
        recipientAuthorizationRevision: authorizationRevision(0),
        recipientRuntimeGeneration: attempt.recipientGeneration,
        recipientKeyId: attempt.recipientKeyId,
        operations: ["decrypt", "encrypt"],
        issuedAt: NOW,
        deadlineAt: attempt.expiresAt,
        maximumSecretBytes: 4_096,
        domains: authority.domains,
      });
      currentAuthority = {
        authorizationId: grantPlan.authorizationId,
        policyRevision: grantPlan.policyRevision,
        sessionId: grantPlan.sessionId,
        roomId: grantPlan.roomId,
        subjectHumanId: grantPlan.subjectHumanId,
        committerDeviceId: grantPlan.committerDeviceId,
        committerDeviceSigningGeneration:
          grantPlan.committerDeviceSigningGeneration,
        committerDeviceSigningPublicKey: signing.publicKey,
        committerDeviceActive: true,
        hostAuthorizationRevision: grantPlan.hostAuthorizationRevision,
        recipientKind: grantPlan.recipientKind,
        recipientPrincipalId: grantPlan.recipientPrincipalId,
        recipientAuthorizationRevision:
          grantPlan.recipientAuthorizationRevision,
        recipientRuntimeGeneration: grantPlan.recipientRuntimeGeneration,
        recipientKeyId: grantPlan.recipientKeyId,
        recipientAuthorized: true,
        domains: grantPlan.domains,
      };
      return createTaskRuntimeBackgroundAuthorizationRequestV1({
        requestId: REQUEST,
        workId: RUN,
        workKind: "task.execute",
        workPurpose: "task.execute",
        recipientGeneration: attempt.recipientGeneration,
        episodeId: grantPlan.sessionId,
        sourceRoomId: authority.sourceRoomId,
        recipientKeyId: attempt.recipientKeyId,
        recipientPublicKey: attempt.recipientPublicKey,
        authorizationPlan: grantPlan,
        issuedAt: NOW,
        deadlineAt: attempt.expiresAt,
      });
    },
    openTransientInput: async ({ occurrence: currentOccurrence, domains,
      evidence, signal }) => {
      expect(authorityLocksHeld).toBe(false);
      signal.throwIfAborted();
      openedOccurrences.push(currentOccurrence);
      expect(domains).toHaveLength(1);
      expect(domains[0]!.domainKey).toEqual(bytes(9));
      expect(evidence.result.taskId).toBe(TASK);
      expect(evidence.result.taskRunId).toBe(RUN);
      expect(evidence.namespaceRequirements).toEqual(currentNamespaceRequirements);
      return { message: SENTINEL };
    },
    publishResult: async ({ occurrence: currentOccurrence, payload, domains,
      evidence, signal }) => {
      expect(authorityLocksHeld).toBe(false);
      signal.throwIfAborted();
      publishedOccurrences.push(currentOccurrence);
      expect(domains).toHaveLength(1);
      expect(evidence.result.taskRunId).toBe(RUN);
      if (payload.resultText !== null) publishedResults.push(payload.resultText);
    },
  };
  };
  const plan = (value: ProtectedTaskOccurrence): TaskRuntimeGrantClaimPlan => {
    const prepared = basePlan(value);
    return substitutePlan === null ? prepared : substitutePlan(prepared);
  };
  const createCoordinator = (registry: TaskRuntimeRecipientRegistry) =>
    createTaskRuntimeGrantClaim({
      repository: trackedRepository,
      recipients: registry,
      plan,
      now: () => clock,
      claimId: () => "task-runtime-claim",
      withCurrentClaimAuthority: async ({ now, use }) => {
        if (currentAuthority === null) return null;
        const borrowed = copyAuthority(currentAuthority);
        beforeClaimAuthorityUse?.();
        const claimedAt = now();
        authorityLocksHeld = true;
        try {
          return await use({
            foreground: borrowed,
            namespaceRequirements: currentNamespaceRequirements,
          }, heldClaimRepository, claimedAt, NOW + 60_000);
        } finally {
          destroyAuthority(borrowed);
          authorityLocksHeld = false;
        }
      },
      withCurrentAuthority: async ({ occurrence: currentOccurrence, use }) => {
        if (currentAuthority === null) return null;
        authorityOccurrences.push(currentOccurrence);
        const borrowed = copyAuthority(currentAuthority);
        authorityLocksHeld = true;
        try {
          return await use({
            foreground: borrowed,
            namespaceRequirements: currentNamespaceRequirements,
          });
        } finally {
          destroyAuthority(borrowed);
          authorityLocksHeld = false;
        }
      },
    });
  const coordinator = createCoordinator(recipients);
  const recipientAuthority = (
    currentScopeMemory?: TaskScopeMemoryBinding,
  ): TaskRuntimeRecipientCurrentAuthority => ({
    device: {
      userId: binding.userId,
      humanActorId: binding.humanActorId,
      deviceId: binding.deviceId,
      deviceGeneration: 2,
      signingPublicKey: signing.publicKey,
      serverInstanceId: "task-runtime-server",
      lineageGeneration: 1,
      epoch: 1,
      securityRevision: 6,
      headDigest: bytes(6),
    },
    domains: [domain],
    namespaceRequirements: currentNamespaceRequirements,
    policyRevision: 7,
    sourceRoomId: provenSourceRoomId,
    ...(currentScopeMemory === undefined
      ? {}
      : { scopeMemory: currentScopeMemory }),
  });
  const bindRecipient = (
    owner = coordinator,
    currentBinding: TaskRuntimeRecipientDeviceBinding = binding,
    currentOccurrence: ProtectedTaskOccurrence = occurrence(),
    currentScopeMemory?: TaskScopeMemoryBinding,
  ) => owner.bindAwaitingRecipientForDevice({
    occurrence: currentOccurrence,
    binding: currentBinding,
    withCurrentAuthority: async ({ scopeMemory, targetRoomId, use }) => {
      expect(targetRoomId).toBe(ROOM);
      return use(recipientAuthority(currentScopeMemory ?? scopeMemory));
    },
  });
  return {
    crypto,
    signing,
    repository,
    trackedRepository,
    recipients,
    coordinator,
    createCoordinator,
    binding,
    recipientAuthority,
    bindRecipient,
    builtRecipientKeys,
    plan,
    getPlan: () => grantPlan,
    getCurrent: () => currentAuthority,
    claimCasCount: () => claimCasCount,
    recipientRotationCasCount: () => recipientRotationCasCount,
    replacementCasCount: () => replacementCasCount,
    authorityLocksHeld: () => authorityLocksHeld,
    startInputs,
    publishedResults,
    openedOccurrences,
    publishedOccurrences,
    authorityOccurrences,
    setStartResult: (value: "started" | "stale") => { startResult = value; },
    setClock: (value: number) => { clock = value; },
    setBeforeClaimAuthorityUse: (value: (() => void) | null) => {
      beforeClaimAuthorityUse = value;
    },
    setProvenSourceRoomId: (value: string) => { provenSourceRoomId = value; },
    enableRecipientCasBarrier: () => {
      recipientCasBarrier = Promise.withResolvers<void>();
      recipientCasArrivals = 0;
    },
    setCurrentNamespaceRequirements: (
      value: typeof currentNamespaceRequirements,
    ) => { currentNamespaceRequirements = value; },
    setSubstitutePlan: (value: typeof substitutePlan) => {
      substitutePlan = value;
    },
    setSubstituteGet: (value: typeof substituteGet) => { substituteGet = value; },
  };
}

async function acceptGrant(value: Fixture): Promise<void> {
  const record = await value.repository.get(REQUEST);
  if (record === null || record.descriptorBytes === null
    || record.snapshot.recipient === null || record.authoritySet === undefined) {
    throw new Error("prepared Task Runtime record is unavailable");
  }
  const request = decodeTaskRuntimeBackgroundAuthorizationRequestV1(
    record.descriptorBytes,
  );
  const plan = value.getPlan();
  if (request === null || plan === null) throw new Error("request unavailable");
  const authorization = await mintDomainForegroundAuthorization(value.crypto, {
    plan,
    domains: [{ ...plan.domains[0]!, domainKey: bytes(9) }],
    committerDeviceSigningPrivateKey: value.signing.privateKey,
    recipientEncryptionPublicKey: request.recipientPublicKey,
  });
  const responseBytes = serializeDomainForegroundAuthorizationV2(authorization);
  const responseHash = digest(responseBytes);
  const accepted = await value.trackedRepository.acceptVerifiedResponse({
    acceptedAt: NOW + 2,
    response: {
      formatVersion: 3,
      kind: "runtime",
      requestId: REQUEST,
      descriptorHash: digest(record.descriptorBytes),
      descriptorBytes: record.descriptorBytes,
      recipientGeneration: request.recipientGeneration,
      recipientKeyId: request.recipientKeyId,
      recipientPublicKey: request.recipientPublicKey,
      workId: RUN,
      workKind: "task.execute",
      purpose: "task.execute",
      authoritySet: record.authoritySet as BackgroundAuthorizationTaskRuntimeRecordV3["authoritySet"],
      responseBytes,
      responseHash,
      authorizationId: REQUEST,
      authorizationHash: responseHash.slice(),
      issuingHumanId: REQUESTOR,
      issuingDeviceId: "task-runtime-device",
      issuingDeviceAuthorizationRevision: 6,
      issuerSigningPublicKeyHash: digest(value.signing.publicKey),
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
    },
  });
  expect(accepted.status).toBe("accepted");
  value.setClock(NOW + 3);
}

async function prepareAndBind(value: Fixture): Promise<void> {
  expect(await value.coordinator.prepareOrClaimExact(occurrence()))
    .toEqual({ status: "awaiting_authorization" });
  expect(value.recipients.size).toBe(0);
  expect(await value.bindRecipient()).not.toBeNull();
}

describe("parked Task Runtime authority preparation", () => {
  test("creates once and recognizes an exact unclaimed replay", async () => {
    const input = parkedPreparation();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const recipients = new TaskRuntimeRecipientRegistry(new LatticeCrypto());
    expect(await prepareUnclaimedParkedTaskRuntimeAuthority({
      ...input, repository, recipients, now: () => NOW,
    })).toEqual({ status: "created" });
    expect(await prepareUnclaimedParkedTaskRuntimeAuthority({
      ...input, repository, recipients, now: () => NOW,
    })).toEqual({ status: "exact_replay" });
  });

  test("replaces changed preclaim authority and clears only the winning recipient generation", async () => {
    const input = parkedPreparation();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const changed = Object.freeze({
      ...input.initialRecord,
      workIdentityHash: bytes(99),
    });
    await repository.create(changed);
    const deleted: Array<readonly [string, number]> = [];
    const recipients = {
      delete(requestId: string, generation: number) {
        deleted.push([requestId, generation]);
        return true;
      },
    } as unknown as TaskRuntimeRecipientRegistry;

    expect(await prepareUnclaimedParkedTaskRuntimeAuthority({
      ...input, repository, recipients, now: () => NOW,
    })).toEqual({ status: "replaced" });
    expect(deleted).toEqual([[changed.snapshot.requestId, 0]]);
    expect(await prepareUnclaimedParkedTaskRuntimeAuthority({
      ...input, repository, recipients, now: () => NOW,
    })).toEqual({ status: "exact_replay" });
  });

  test("classifies claimed and terminal records without mutation", async () => {
    const input = parkedPreparation();
    const records = [
      { state: "claimed", status: "active" },
      { state: "completed", status: "inactive" },
    ] as const;
    for (const entry of records) {
      let replacements = 0;
      const current = {
        ...input.initialRecord,
        snapshot: { ...input.initialRecord.snapshot, state: entry.state },
      } as BackgroundAuthorizationTaskRuntimeRecordV3;
      const repository = {
        get: async () => current,
        create: async () => ({ status: "existing" as const, record: current }),
        replaceUnclaimedTaskRuntimeAuthority: async () => {
          replacements += 1;
          return { status: "replaced" as const, record: input.initialRecord };
        },
      } as unknown as BackgroundAuthorizationTaskRuntimeReplacementRepository;
      expect(await prepareUnclaimedParkedTaskRuntimeAuthority({
        ...input,
        repository,
        recipients: new TaskRuntimeRecipientRegistry(new LatticeCrypto()),
        now: () => NOW,
      })).toEqual({ status: entry.status });
      expect(replacements).toBe(0);
    }
  });

  test("reports a lost replacement race without deleting recipient custody", async () => {
    const input = parkedPreparation();
    const changed = Object.freeze({
      ...input.initialRecord,
      workIdentityHash: bytes(99),
    });
    const deleted: Array<readonly [string, number]> = [];
    const repository = {
      get: async () => changed,
      create: async () => ({ status: "existing" as const, record: changed }),
      replaceUnclaimedTaskRuntimeAuthority: async () => ({
        status: "stale" as const,
        current: input.initialRecord,
      }),
    } as unknown as BackgroundAuthorizationTaskRuntimeReplacementRepository;
    const recipients = {
      delete(requestId: string, generation: number) {
        deleted.push([requestId, generation]);
        return true;
      },
    } as unknown as TaskRuntimeRecipientRegistry;

    expect(await prepareUnclaimedParkedTaskRuntimeAuthority({
      ...input, repository, recipients, now: () => NOW,
    })).toEqual({ status: "stale" });
    expect(deleted).toEqual([]);
  });

  test("rejects initial-segment and legacy-idempotency substitutions", async () => {
    const input = parkedPreparation();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const recipients = new TaskRuntimeRecipientRegistry(new LatticeCrypto());
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(prepareUnclaimedParkedTaskRuntimeAuthority({
      ...input,
      stableIdentity: stableIdentity(input.occurrence),
      repository,
      recipients,
      now: () => NOW,
    })).rejects.toThrow("preparation is invalid");
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(prepareUnclaimedParkedTaskRuntimeAuthority({
      ...input,
      initialRecord: {
        ...input.initialRecord,
        idempotencyKey: `task-run:${RUN}`,
      },
      repository,
      recipients,
      now: () => NOW,
    })).rejects.toThrow("preparation is invalid");
  });
});

describe("exact Task Runtime recipient kernels", () => {
  test("attaches once, retains the winner, and rejects a stale selected revision", async () => {
    const value = await fixture();
    const currentOccurrence = occurrence();
    const plan = value.plan(currentOccurrence);
    await value.repository.create(plan.initialRecord);
    const selected = requiredTaskRuntimeRecord(
      await value.repository.get(REQUEST),
    );
    const attached = await attachExactTaskRuntimeRecipient({
      occurrence: currentOccurrence,
      selected,
      plan,
      binding: value.binding,
      authority: value.recipientAuthority(),
      repository: value.trackedRepository,
      recipients: value.recipients,
      now: () => NOW,
    });
    expect(attached?.record.snapshot.state).toBe("awaiting_device");
    expect(value.recipients.size).toBe(1);

    const losingRecipients = new TaskRuntimeRecipientRegistry(value.crypto, {
      now: () => NOW,
    });
    expect(await attachExactTaskRuntimeRecipient({
      occurrence: currentOccurrence,
      selected,
      plan,
      binding: value.binding,
      authority: value.recipientAuthority(),
      repository: value.trackedRepository,
      recipients: losingRecipients,
      now: () => NOW,
    })).toBeNull();
    expect(losingRecipients.size).toBe(0);
    expect(value.recipients.size).toBe(1);
    losingRecipients.close();
    value.recipients.close();
  });

  test("rejects mismatched authority and a changed exact plan before attachment", async () => {
    const value = await fixture();
    const currentOccurrence = occurrence();
    const plan = value.plan(currentOccurrence);
    await value.repository.create(plan.initialRecord);
    const selected = requiredTaskRuntimeRecord(
      await value.repository.get(REQUEST),
    );
    expect(await attachExactTaskRuntimeRecipient({
      occurrence: currentOccurrence,
      selected,
      plan,
      binding: value.binding,
      authority: {
        ...value.recipientAuthority(),
        policyRevision: 8,
      },
      repository: value.trackedRepository,
      recipients: value.recipients,
      now: () => NOW,
    })).toBeNull();
    expect(value.recipients.size).toBe(0);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(attachExactTaskRuntimeRecipient({
      occurrence: currentOccurrence,
      selected,
      plan: {
        ...plan,
        initialRecord: {
          ...plan.initialRecord,
          workIdentityHash: bytes(99),
        },
      },
      binding: value.binding,
      authority: value.recipientAuthority(),
      repository: value.trackedRepository,
      recipients: value.recipients,
      now: () => NOW,
    })).rejects.toThrow("attachment is invalid");
    expect(value.recipients.size).toBe(0);
    value.recipients.close();
  });

  test("destroys the new attempt when the attachment CAS throws", async () => {
    const value = await fixture();
    const currentOccurrence = occurrence();
    const plan = value.plan(currentOccurrence);
    await value.repository.create(plan.initialRecord);
    const selected = requiredTaskRuntimeRecord(
      await value.repository.get(REQUEST),
    );
    const throwingRepository = {
      get: value.trackedRepository.get.bind(value.trackedRepository),
      compareAndSwap: () => Promise.reject(new Error("attachment CAS failed")),
    };
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(attachExactTaskRuntimeRecipient({
      occurrence: currentOccurrence,
      selected,
      plan,
      binding: value.binding,
      authority: value.recipientAuthority(),
      repository: throwingRepository,
      recipients: value.recipients,
      now: () => NOW,
    })).rejects.toThrow("attachment CAS failed");
    expect(value.recipients.size).toBe(0);
    value.recipients.close();
  });

  test("compares immutable authority plans independently of lifecycle state", () => {
    const initial = initialRecord();
    expect(sameTaskRuntimeAuthorityPlan({
      ...initial,
      snapshot: {
        ...initial.snapshot,
        state: "awaiting_device",
        requestRevision: 1,
      },
    } as BackgroundAuthorizationTaskRuntimeRecordV3, initial)).toBe(true);
    expect(sameTaskRuntimeAuthorityPlan({
      ...initial,
      workIdentityHash: bytes(99),
    }, initial)).toBe(false);
  });

  test("rotates an expired recipient once and does not delete custody on a CAS loser", async () => {
    const winner = await fixture();
    await prepareAndBind(winner);
    const selected = requiredTaskRuntimeRecord(
      await winner.repository.get(REQUEST),
    );
    winner.setClock(NOW + 60_000);
    expect(await rotateExpiredTaskRuntimeRecipient({
      occurrence: occurrence(),
      selected,
      initialRecord: winner.plan(occurrence()).initialRecord,
      repository: winner.trackedRepository,
      recipients: winner.recipients,
      now: () => NOW + 60_000,
    })).toEqual({ status: "rotated" });
    expect(winner.recipients.size).toBe(0);
    expect(await rotateExpiredTaskRuntimeRecipient({
      occurrence: occurrence(),
      selected,
      initialRecord: winner.plan(occurrence()).initialRecord,
      repository: winner.trackedRepository,
      recipients: winner.recipients,
      now: () => NOW + 60_000,
    })).toEqual({ status: "stale" });
    winner.recipients.close();

    const loser = await fixture();
    await prepareAndBind(loser);
    const losingSelected = requiredTaskRuntimeRecord(
      await loser.repository.get(REQUEST),
    );
    const staleRepository = {
      get: loser.trackedRepository.get.bind(loser.trackedRepository),
      compareAndSwap: async () => ({
        status: "stale" as const,
        current: losingSelected,
      }),
    };
    expect(await rotateExpiredTaskRuntimeRecipient({
      occurrence: occurrence(),
      selected: losingSelected,
      initialRecord: loser.plan(occurrence()).initialRecord,
      repository: staleRepository,
      recipients: loser.recipients,
      now: () => NOW + 60_000,
    })).toEqual({ status: "stale" });
    expect(loser.recipients.size).toBe(1);
    loser.recipients.close();
  });
});

describe("Task Runtime grant claim", () => {
  test("preserves the durable initial request key and isolates continuation segments", () => {
    const identity = stableIdentity();
    const initial = taskRuntimeStableIdempotencyKey(identity);
    expect(initial).toBe("task-runtime-stable-v1:60000000-0000-4000-8000-000000000006:optuWJwLFjptlXGvTHSrBRnKjfqM5oYKzKpKbAIYJOQ");
    const continuation = {
      ...identity,
      executionSegment: 2,
      resumeContinuationFingerprint: Buffer.from(bytes(23)).toString("base64url"),
    };
    const resumed = taskRuntimeStableIdempotencyKey(continuation);
    expect(resumed).not.toBe(initial);
    expect(taskRuntimeStableIdempotencyKey({
      ...continuation, executionSegment: 3,
    })).not.toBe(resumed);
    expect(taskRuntimeStableIdempotencyKey({
      ...continuation,
      resumeContinuationFingerprint: Buffer.from(bytes(24)).toString("base64url"),
    })).not.toBe(resumed);
  });

  test("retains the routing commitment across segments without temporary grant state", () => {
    const identity = stableIdentity();
    const routing = { ...identity, widePrimaryWriteNamespaceId: null };
    const expected = taskRuntimeStableRoutingDigest(routing);
    expect(Buffer.from(expected).toString("base64url"))
      .toBe("TO-6wYuTe_mSOzQ1XC_R3M4yYlGbkBhfQpLnCg6uhrU");
    const continuation = {
      ...routing,
      executionSegment: 2,
      resumeContinuationFingerprint: Buffer.from(bytes(23)).toString("base64url"),
    };
    expect(taskRuntimeStableRoutingDigest(continuation)).toEqual(expected);
    for (const patch of [
      { targetRoomId: "90000000-0000-4000-8000-000000000099" },
      { targetUserIds: ["90000000-0000-4000-8000-000000000099"] },
      { callingRoomId: null },
      { scheduleKind: "cron" as const },
      { memoryMode: "scope" as const, scopeId: "90000000-0000-4000-8000-000000000099" },
      { contentRevision: identity.contentRevision + 1 },
    ]) {
      expect(taskRuntimeStableRoutingDigest({ ...routing, ...patch }))
        .not.toEqual(expected);
    }
    expect(taskRuntimeStableRoutingDigest({
      ...routing,
      memoryMode: "wide",
      widePrimaryWriteNamespaceId: identity.contentNamespaceId,
    })).not.toEqual(taskRuntimeStableRoutingDigest({
      ...routing,
      memoryMode: "wide",
      widePrimaryWriteNamespaceId:
        "90000000-0000-4000-8000-000000000099",
    }));
    expected.fill(0);
    expect(Buffer.from(taskRuntimeStableRoutingDigest(routing)).toString("base64url"))
      .toBe("TO-6wYuTe_mSOzQ1XC_R3M4yYlGbkBhfQpLnCg6uhrU");
  });

  test("rejects incomplete and noncanonical continuation identities", () => {
    for (const binding of [
      { executionSegment: 0, resumeContinuationFingerprint: null },
      { executionSegment: 1.5, resumeContinuationFingerprint: null },
      { executionSegment: 1, resumeContinuationFingerprint: "A".repeat(43) },
      { executionSegment: 2, resumeContinuationFingerprint: null },
      { executionSegment: 2, resumeContinuationFingerprint: "A".repeat(42) + "B" },
    ]) {
      expect(() => taskRuntimeStableIdempotencyKey({ ...stableIdentity(), ...binding }))
        .toThrow("execution segment identity is invalid");
    }
  });

  test("keeps continuation admission out of the initial-only grant coordinator", async () => {
    const value = await fixture();
    value.setSubstitutePlan(plan => Object.freeze({
      ...plan,
      stableIdentity: Object.freeze({
        ...plan.stableIdentity,
        executionSegment: 2,
        resumeContinuationFingerprint: Buffer.from(bytes(23)).toString("base64url"),
      }),
    }));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(value.coordinator.prepareOrClaimExact(occurrence()))
      .rejects.toThrow("disagrees with its occurrence");
    expect(await value.repository.get(REQUEST)).toBeNull();
    expect(value.recipients.size).toBe(0);
  });

  test("canonicalizes target ordering in the immutable plan commitment", () => {
    const identity = stableIdentity();
    const forward = taskRuntimeStableIdempotencyKey({
      ...identity,
      targetUserIds: [OWNER, REQUESTOR],
    });
    const reversed = taskRuntimeStableIdempotencyKey({
      ...identity,
      targetUserIds: [REQUESTOR, OWNER],
    });
    expect(reversed).toBe(forward);
    expect(taskRuntimeStableIdempotencyKey({
      ...identity,
      ownerId: REQUESTOR,
      targetUserIds: [OWNER, REQUESTOR],
    })).not.toBe(forward);
  });

  test("claims an exact read-only Memory Namespace without widening its operations", async () => {
    const value = await fixture();
    const memoryRequirement = Object.freeze({
      ordinal: 1,
      namespaceId: "z-read-only-memory-namespace",
      domainId: DOMAIN,
      operations: Object.freeze(["decrypt"] as const),
      expectedAccessRevision: 3,
      expectedPolicyRevision: 7,
    });
    const namespaceRequirements = Object.freeze([
      ...initialRecord().authoritySet.namespaceRequirements,
      memoryRequirement,
    ]);
    value.setSubstitutePlan((plan) => Object.freeze({
      ...plan,
      initialRecord: Object.freeze({
        ...plan.initialRecord,
        authoritySet: Object.freeze({
          ...plan.initialRecord.authoritySet,
          namespaceRequirements,
        }),
      }),
    }));
    value.setCurrentNamespaceRequirements(namespaceRequirements);

    await prepareAndBind(value);
    await acceptGrant(value);
    const claimed = await value.coordinator.prepareOrClaimExact(occurrence());
    expect(claimed.status).toBe("claimed");
    expect((await value.repository.get(REQUEST))?.authoritySet?.namespaceRequirements[1]
      ?.operations).toEqual(["decrypt"]);
    if (claimed.status === "claimed") claimed.dispatch.candidate.onIneligible();
  });

  test("atomically replaces a changed preclaim inventory and wipes the winning old recipient", async () => {
    const value = await fixture();
    await prepareAndBind(value);
    await acceptGrant(value);
    expect(value.recipients.size).toBe(1);
    const current = initialRecord();
    const namespaceRequirements = Object.freeze([
      ...current.authoritySet.namespaceRequirements,
      Object.freeze({
        ordinal: 1,
        namespaceId: "z-scope-retained-namespace",
        domainId: DOMAIN,
        operations: Object.freeze(["decrypt"] as const),
        expectedAccessRevision: 9,
        expectedPolicyRevision: 7,
      }),
    ]);
    value.setCurrentNamespaceRequirements(namespaceRequirements);
    value.setSubstitutePlan((plan) => Object.freeze({
      ...plan,
      initialRecord: Object.freeze({
        ...plan.initialRecord,
        workIdentityHash: bytes(11),
        authoritySet: Object.freeze({
          ...plan.initialRecord.authoritySet,
          namespaceRequirements,
        }),
      }),
    }));

    expect(await value.coordinator.prepareOrClaimExact(occurrence()))
      .toEqual({ status: "awaiting_authorization" });
    const replaced = await value.repository.get(REQUEST);
    expect(replaced?.snapshot).toMatchObject({
      state: "awaiting_recipient",
      recipientGeneration: 1,
      requestRevision: 3,
      retryCount: 0,
    });
    expect(replaced?.descriptorBytes).toBeNull();
    expect(replaced?.acceptedMaterial).toBeNull();
    expect(replaced?.authoritySet?.namespaceRequirements)
      .toEqual(namespaceRequirements);
    expect(value.recipients.size).toBe(0);
    expect(value.replacementCasCount()).toBe(1);

    const rebound = await value.bindRecipient();
    expect(rebound?.record.snapshot.recipientGeneration).toBe(1);
    expect(rebound?.record.snapshot.state).toBe("awaiting_device");
  });

  test("replaces changed fixed Scope inventory and binds only its exact current copy", async () => {
    const value = await fixture();
    const initialBinding = scopeBinding();
    value.setSubstitutePlan(plan => scopePlan(plan, initialBinding, 21));
    value.setCurrentNamespaceRequirements(
      scopePlan(value.plan(occurrence()), initialBinding, 21)
        .initialRecord.authoritySet.namespaceRequirements,
    );
    await prepareAndBind(value);
    expect(value.recipients.size).toBe(1);

    const addedNamespace = "b0000000-0000-4000-8000-00000000000b";
    const changedBinding = scopeBinding([SCOPE_ORIGIN, addedNamespace]);
    value.setSubstitutePlan(plan => scopePlan(plan, changedBinding, 22));
    const changedPlan = value.plan(occurrence());
    value.setCurrentNamespaceRequirements(
      changedPlan.initialRecord.authoritySet.namespaceRequirements,
    );

    expect(await value.coordinator.prepareOrClaimExact(occurrence()))
      .toEqual({ status: "awaiting_authorization" });
    expect(value.recipients.size).toBe(0);
    expect(value.replacementCasCount()).toBe(1);

    expect(await value.bindRecipient(
      value.coordinator,
      value.binding,
      occurrence(),
      initialBinding,
    )).toBeNull();
    expect(value.recipients.size).toBe(0);

    const rebound = await value.bindRecipient();
    expect(rebound?.record.snapshot.state).toBe("awaiting_device");
    expect(value.recipients.size).toBe(1);
  });

  test("rejects omitted or extra fixed Scope grant Namespaces", async () => {
    for (const change of ["omitted", "extra"] as const) {
      const value = await fixture();
      value.setSubstitutePlan(plan => {
        const scoped = scopePlan(plan, scopeBinding(), 23);
        const requirements = change === "omitted"
          ? scoped.initialRecord.authoritySet.namespaceRequirements.slice(0, 1)
          : [
              ...scoped.initialRecord.authoritySet.namespaceRequirements,
              Object.freeze({
                ordinal: 2,
                namespaceId: "c0000000-0000-4000-8000-00000000000c",
                domainId: DOMAIN,
                operations: Object.freeze(["decrypt"] as const),
                expectedAccessRevision: 8,
                expectedPolicyRevision: 7,
              }),
            ];
        return Object.freeze({
          ...scoped,
          initialRecord: Object.freeze({
            ...scoped.initialRecord,
            authoritySet: Object.freeze({
              ...scoped.initialRecord.authoritySet,
              namespaceRequirements: Object.freeze(requirements),
            }),
          }),
        });
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(value.coordinator.prepareOrClaimExact(occurrence()))
        .rejects.toThrow("disagrees with its occurrence");
      expect(await value.repository.get(REQUEST)).toBeNull();
    }
  });

  test("rejects a write upgrade for Scope seed or foreign read authority", async () => {
    for (const upgradedNamespace of [SCOPE_SEED, SCOPE_FOREIGN_READ]) {
      const value = await fixture();
      const binding = scopeBinding([SCOPE_ORIGIN, upgradedNamespace]);
      value.setSubstitutePlan(plan => {
        const scoped = scopePlan(plan, binding, 24);
        return Object.freeze({
          ...scoped,
          initialRecord: Object.freeze({
            ...scoped.initialRecord,
            authoritySet: Object.freeze({
              ...scoped.initialRecord.authoritySet,
              namespaceRequirements: Object.freeze(
                scoped.initialRecord.authoritySet.namespaceRequirements.map(
                  requirement => requirement.namespaceId === upgradedNamespace
                    ? Object.freeze({
                        ...requirement,
                        operations: Object.freeze(
                          ["decrypt", "encrypt"] as const,
                        ),
                      })
                    : requirement,
                ),
              ),
            }),
          }),
        });
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(value.coordinator.prepareOrClaimExact(occurrence()))
        .rejects.toThrow("disagrees with its occurrence");
      expect(await value.repository.get(REQUEST)).toBeNull();
      expect(value.replacementCasCount()).toBe(0);
    }
  });

  test("rejects an omitted distinct Scope output Namespace", async () => {
    const value = await fixture();
    value.setSubstitutePlan(plan => {
      const scoped = scopePlan(plan, scopeBinding(), 25);
      const stable = Object.freeze({
        ...scoped.stableIdentity,
        outputNamespaceId: OUTPUT_NAMESPACE,
      });
      return Object.freeze({
        ...scoped,
        stableIdentity: stable,
        initialRecord: Object.freeze({
          ...scoped.initialRecord,
          idempotencyKey: taskRuntimeStableIdempotencyKey(stable),
        }),
      });
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(value.coordinator.prepareOrClaimExact(occurrence()))
      .rejects.toThrow("disagrees with its occurrence");
    expect(await value.repository.get(REQUEST)).toBeNull();
    expect(value.replacementCasCount()).toBe(0);
  });

  test("retains a same-plan legacy dark request but refuses to replace it without a stable commitment", async () => {
    const value = await fixture();
    await value.repository.create(Object.freeze({
      ...initialRecord(),
      idempotencyKey: `task-run:${RUN}`,
    }));
    expect(await value.coordinator.prepareOrClaimExact(occurrence()))
      .toEqual({ status: "awaiting_authorization" });
    expect(value.replacementCasCount()).toBe(0);
    value.setSubstitutePlan((plan) => Object.freeze({
      ...plan,
      initialRecord: Object.freeze({
        ...plan.initialRecord,
        workIdentityHash: bytes(12),
      }),
    }));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(value.coordinator.prepareOrClaimExact(occurrence()))
      .rejects.toThrow("changed stable identity");
    expect((await value.repository.get(REQUEST))?.snapshot.requestRevision)
      .toBe(0);
  });

  test("rejects coherent source identity substitution before inventory replacement", async () => {
    const value = await fixture();
    expect(await value.coordinator.prepareOrClaimExact(occurrence()))
      .toEqual({ status: "awaiting_authorization" });
    value.setSubstitutePlan((plan) => {
      const stable = Object.freeze({
        ...plan.stableIdentity,
        sourceRoomId: PRIVATE_TASK_ROOM,
      });
      return Object.freeze({
        ...plan,
        stableIdentity: stable,
        initialRecord: Object.freeze({
          ...plan.initialRecord,
          idempotencyKey: taskRuntimeStableIdempotencyKey(stable),
          workIdentityHash: bytes(13),
        }),
      });
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(value.coordinator.prepareOrClaimExact(occurrence()))
      .rejects.toThrow("changed stable identity");
    expect(value.replacementCasCount()).toBe(0);
  });

  test("does not weaken the Task definition and result Namespace to read-only", async () => {
    const value = await fixture();
    const initial = initialRecord();
    value.setSubstitutePlan((plan) => Object.freeze({
      ...plan,
      initialRecord: Object.freeze({
        ...initial,
        authoritySet: Object.freeze({
          ...initial.authoritySet,
          namespaceRequirements: Object.freeze([Object.freeze({
            ...initial.authoritySet.namespaceRequirements[0]!,
            operations: Object.freeze(["decrypt"] as const),
          })]),
        }),
      }),
    }));

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(value.coordinator.prepareOrClaimExact(occurrence()))
      .rejects.toThrow("disagrees with its occurrence");
    expect(await value.repository.get(REQUEST)).toBeNull();
  });

  test("does not rotate another process's live unconsumed recipient", async () => {
    const value = await fixture();
    await prepareAndBind(value);
    await acceptGrant(value);
    const recoveredRecipients = new TaskRuntimeRecipientRegistry(
      value.crypto,
      { now: () => NOW + 4 },
    );
    const recovered = value.createCoordinator(recoveredRecipients);

    expect(await recovered.prepareOrClaimExact(occurrence()))
      .toEqual({ status: "awaiting_authorization" });
    const durable = await value.repository.get(REQUEST);
    expect(durable?.snapshot.state).toBe("grant_ready");
    expect(durable?.snapshot.recipientGeneration).toBe(0);
    expect(durable?.snapshot.lastRetryReason).toBeNull();
    expect(durable?.descriptorBytes).not.toBeNull();
    expect(durable?.acceptedMaterial).not.toBeNull();
    expect(value.claimCasCount()).toBe(0);
    expect(value.recipientRotationCasCount()).toBe(0);
    recoveredRecipients.close();
  });

  test("rotates an expired device request even if the old process still holds its key", async () => {
    const value = await fixture();
    await prepareAndBind(value);
    value.setClock(NOW + 60_000);

    expect(await value.coordinator.prepareOrClaimExact(occurrence()))
      .toEqual({ status: "awaiting_authorization" });
    const durable = await value.repository.get(REQUEST);
    expect(durable?.snapshot.state).toBe("awaiting_recipient");
    expect(durable?.snapshot.recipientGeneration).toBe(1);
    expect(durable?.snapshot.lastRetryReason).toBe("attempt_expired");
    expect(value.recipients.size).toBe(0);
    expect(value.recipientRotationCasCount()).toBe(1);
    expect(await value.coordinator.prepareOrClaimExact(occurrence()))
      .toEqual({ status: "awaiting_authorization" });
    expect((await value.repository.get(REQUEST))?.snapshot.recipientGeneration)
      .toBe(1);
    expect(value.recipientRotationCasCount()).toBe(1);
  });

  test("claims one accepted grant and opens transient input only inside a one-use candidate", async () => {
    const value = await fixture();
    expect(await value.coordinator.prepareOrClaimExact(occurrence()))
      .toEqual({ status: "awaiting_authorization" });
    const prepared = await value.repository.get(REQUEST);
    expect(prepared?.snapshot.state).toBe("awaiting_recipient");
    expect(prepared?.snapshot.recipient).toBeNull();
    expect(prepared?.descriptorBytes).toBeNull();
    expect(value.recipients.size).toBe(0);

    const binding = await value.bindRecipient();
    if (binding === null) throw new Error("recipient was not bound");
    const bound = await value.repository.get(REQUEST);
    expect(bound?.snapshot.state).toBe("awaiting_device");
    if (bound?.descriptorBytes === null || bound?.descriptorBytes === undefined) {
      throw new Error("bound request bytes missing");
    }
    expect(binding.requestBytes).toEqual(bound.descriptorBytes);
    expect(binding.requestBytes).not.toBe(bound.descriptorBytes);
    expect(JSON.stringify(prepared)).not.toContain(SENTINEL);

    await acceptGrant(value);
    value.setBeforeClaimAuthorityUse(() => value.setClock(NOW + 10));
    const admittedOccurrence = occurrence();
    const result = await value.coordinator.prepareOrClaimExact(admittedOccurrence);
    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") throw new Error("grant not claimed");
    expect(value.claimCasCount()).toBe(1);
    const durable = await value.repository.get(REQUEST);
    expect(durable?.snapshot.state).toBe("claimed");
    expect(durable?.snapshot.updatedAt).toBe(NOW + 10);
    expect(durable?.snapshot.claimExpiresAt).toBe(NOW + 60_000);
    expect(JSON.stringify(durable)).not.toContain(SENTINEL);

    const transient: Record<string, unknown>[] = [];
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(result.dispatch.candidate.run(async () => {}))
      .rejects.toThrow("has not started");
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(result.dispatch.candidate.start("  "))
      .rejects.toThrow("Job identity is invalid");
    expect(value.startInputs).toEqual([]);
    expect(await result.dispatch.candidate.start("protected-job-1"))
      .toEqual({ status: "started" });
    expect(admittedOccurrence.run).toMatchObject({
      status: "awaiting",
      jobId: null,
    });
    expect(value.startInputs).toEqual([{
      taskId: TASK,
      taskRunId: RUN,
      graphThreadId: `subagent:${TASK}:${RUN}`,
      jobId: "protected-job-1",
      contentRepresentation: "protected",
      contentNamespaceId: NAMESPACE,
      contentRevision: 1,
      cryptoObjectId: INPUT_OBJECT,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: bytes(7),
      jobReference: value.plan(occurrence()).reference,
    }]);
    await result.dispatch.candidate.run(async (input, signal, publication) => {
      expect(value.authorityLocksHeld()).toBe(false);
      signal.throwIfAborted();
      transient.push(input);
      await publication.publish({
        formatVersion: 1,
        resultText: "protected result",
        lastError: null,
      });
      expect(() => publication.publish({
        formatVersion: 1,
        resultText: "duplicate",
        lastError: null,
      })).toThrow("one-use");
    });
    expect(transient[0]).toEqual({ message: SENTINEL });
    expect(value.publishedResults).toEqual(["protected result"]);
    for (const observed of [
      ...value.openedOccurrences,
      ...value.publishedOccurrences,
      ...value.authorityOccurrences.filter(item => item.run.status === "running"),
    ]) {
      expect(observed.run).toMatchObject({
        id: RUN,
        status: "running",
        jobId: "protected-job-1",
      });
    }
    expect(value.openedOccurrences).toHaveLength(1);
    expect(value.publishedOccurrences).toHaveLength(1);
    expect(value.authorityOccurrences).toHaveLength(1);
    expect(value.authorityOccurrences.some(item =>
      item.run.status === "running"
      && item.run.jobId === "protected-job-1")).toBe(true);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(result.dispatch.candidate.run(async () => {}))
      .rejects.toThrow("one-use");
    expect(value.recipients.size).toBe(0);
    const completed = await value.repository.get(REQUEST);
    expect(completed?.snapshot.state).toBe("completed");
    expect(completed?.snapshot.claimId).toBeNull();
    expect(completed?.snapshot.claimExpiresAt).toBeNull();
    expect(completed?.finishedAt).toBe(NOW + 10);
    expect(JSON.stringify(completed)).not.toContain(SENTINEL);
  });

  test("a restarted coordinator rotates an expired claim that never began work", async () => {
    const value = await fixture();
    await prepareAndBind(value);
    await acceptGrant(value);
    const claimed = await value.coordinator.prepareOrClaimExact(occurrence());
    if (claimed.status !== "claimed") throw new Error("grant not claimed");
    value.recipients.close();
    value.setClock(NOW + 60_000);
    const restartedRecipients = new TaskRuntimeRecipientRegistry(value.crypto, {
      now: () => NOW + 60_000,
    });
    const restarted = value.createCoordinator(restartedRecipients);

    expect(await restarted.prepareOrClaimExact(occurrence()))
      .toEqual({ status: "awaiting_authorization" });
    const durable = await value.repository.get(REQUEST);
    expect(durable?.snapshot.state).toBe("awaiting_recipient");
    expect(durable?.snapshot.recipientGeneration).toBe(1);
    expect(durable?.snapshot.retryCount).toBe(0);
    expect(durable?.snapshot.lastRetryReason).toBe("claim_expired");
    expect(durable?.snapshot.claimId).toBeNull();
    expect(durable?.descriptorBytes).toBeNull();
    expect(durable?.acceptedMaterial).toBeNull();
    restartedRecipients.close();
  });

  test("a no-publication interrupt stays nonterminal and cannot redispatch", async () => {
    const value = await fixture();
    await prepareAndBind(value);
    await acceptGrant(value);
    const claimed = await value.coordinator.prepareOrClaimExact(occurrence());
    if (claimed.status !== "claimed") throw new Error("grant not claimed");
    expect(await claimed.dispatch.candidate.start("protected-job-interrupted"))
      .toEqual({ status: "started" });

    expect(await claimed.dispatch.candidate.run(async () => ({
      status: "interrupted" as const,
    }))).toEqual({ status: "interrupted" });
    const durable = await value.repository.get(REQUEST);
    expect(durable?.snapshot.state).toBe("running");
    expect(durable?.finishedAt).toBeNull();
    expect(await value.coordinator.prepareOrClaimExact(occurrence()))
      .toEqual({ status: "already_claimed" });
    expect(value.claimCasCount()).toBe(1);
    expect(value.startInputs).toHaveLength(1);
  });

  test("an expired running claim becomes uncertain and cannot auto-replay", async () => {
    const value = await fixture();
    await prepareAndBind(value);
    await acceptGrant(value);
    const claimed = await value.coordinator.prepareOrClaimExact(occurrence());
    if (claimed.status !== "claimed") throw new Error("grant not claimed");
    expect(await claimed.dispatch.candidate.start("protected-job-uncertain"))
      .toEqual({ status: "started" });
    const entered = Promise.withResolvers<void>();
    const releaseWork = Promise.withResolvers<void>();
    const running = claimed.dispatch.candidate.run(async () => {
      entered.resolve();
      await releaseWork.promise;
    });
    await entered.promise;
    expect((await value.repository.get(REQUEST))?.snapshot.state).toBe("running");

    value.setClock(NOW + 60_000);
    const restarted = value.createCoordinator(value.recipients);
    expect(await restarted.prepareOrClaimExact(occurrence()))
      .toEqual({ status: "inactive" });
    const terminal = await value.repository.get(REQUEST);
    expect(terminal?.snapshot.state).toBe("terminal_failure");
    expect(terminal?.snapshot.terminalReason).toBe("provider_outcome_unknown");
    expect(terminal?.snapshot.recipientGeneration).toBe(0);
    expect(terminal?.snapshot.retryCount).toBe(0);
    expect(terminal?.finishedAt).toBe(NOW + 60_000);
    expect(await restarted.prepareOrClaimExact(occurrence()))
      .toEqual({ status: "inactive" });
    expect(value.claimCasCount()).toBe(1);

    releaseWork.resolve();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(running).rejects.toThrow();
  });

  test("rejects a non-requestor before creating a recipient", async () => {
    const value = await fixture();
    await value.coordinator.prepareOrClaimExact(occurrence());
    let authorityInvoked = false;

    expect(await value.coordinator.bindAwaitingRecipientForDevice({
      occurrence: occurrence(),
      binding: {
        ...value.binding,
        userId: "70000000-0000-4000-8000-000000000007",
      },
      withCurrentAuthority: async () => {
        authorityInvoked = true;
        return null;
      },
    })).toBeNull();
    expect(authorityInvoked).toBe(false);
    expect(value.recipients.size).toBe(0);
    expect((await value.repository.get(REQUEST))?.snapshot.state)
      .toBe("awaiting_recipient");
  });

  test("binds orphan and open-Room Tasks only to the proven source Room", async () => {
    for (const scenario of [
      { callingRoomId: null, sourceRoomId: PRIVATE_TASK_ROOM },
      { callingRoomId: OPEN_ROOM, sourceRoomId: OPEN_ROOM },
    ] as const) {
      const value = await fixture();
      const currentOccurrence = occurrence(scenario.callingRoomId);
      value.setProvenSourceRoomId(scenario.sourceRoomId);
      expect(await value.coordinator.prepareOrClaimExact(currentOccurrence))
        .toEqual({ status: "awaiting_authorization" });

      const bound = await value.bindRecipient(
        value.coordinator,
        value.binding,
        currentOccurrence,
      );
      if (bound === null) throw new Error("source Room was not bound");
      const request = decodeTaskRuntimeBackgroundAuthorizationRequestV1(
        bound.requestBytes,
      );
      if (request === null) throw new Error("bound request did not decode");
      const embeddedPlan = parseDomainForegroundAuthorizationPlanV2(
        request.authorizationPlanBytes,
      );
      if (embeddedPlan === null) throw new Error("bound plan did not decode");
      try {
        expect(request.sourceRoomId).toBe(scenario.sourceRoomId);
        expect(embeddedPlan.roomId).toBe(scenario.sourceRoomId);
        if (scenario.callingRoomId === null) {
          expect(request.sourceRoomId).not.toBe(scenario.callingRoomId);
        }
      } finally {
        destroyDomainForegroundAuthorizationPlanV2(embeddedPlan);
        destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
        value.recipients.close();
      }
    }
  });

  test("rejects stale requestor Human or device binding without custody", async () => {
    for (const changed of ["human", "device"] as const) {
      const value = await fixture();
      await value.coordinator.prepareOrClaimExact(occurrence());
      const binding = {
        ...value.binding,
        ...(changed === "human"
          ? { humanActorId: "70000000-0000-4000-8000-000000000007" }
          : { deviceId: "other-task-runtime-device" }),
      };

      expect(await value.bindRecipient(value.coordinator, binding)).toBeNull();
      expect(value.recipients.size).toBe(0);
      expect((await value.repository.get(REQUEST))?.snapshot.state)
        .toBe("awaiting_recipient");
    }
  });

  test("deletes recipient custody when request construction fails", async () => {
    const value = await fixture();
    await value.coordinator.prepareOrClaimExact(occurrence());
    value.setSubstitutePlan((plan) => ({
      ...plan,
      buildRequest: () => {
        throw new Error("request construction failed");
      },
    }));

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(value.bindRecipient()).rejects.toThrow(
      "request construction failed",
    );
    expect(value.recipients.size).toBe(0);
    expect((await value.repository.get(REQUEST))?.snapshot.state)
      .toBe("awaiting_recipient");
  });

  test("one device wins a recipient race and the losing private key is deleted", async () => {
    const value = await fixture();
    await value.coordinator.prepareOrClaimExact(occurrence());
    const otherRecipients = new TaskRuntimeRecipientRegistry(value.crypto, {
      now: () => NOW + 1,
    });
    const other = value.createCoordinator(otherRecipients);
    value.enableRecipientCasBarrier();

    const results = await Promise.all([
      value.bindRecipient(),
      value.bindRecipient(other),
    ]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    const winner = results.find((result) => result !== null);
    if (winner === undefined || winner === null) {
      throw new Error("recipient race had no winner");
    }
    expect(value.recipients.size + otherRecipients.size).toBe(1);
    expect(value.builtRecipientKeys).toHaveLength(2);
    expect(new Set(value.builtRecipientKeys).size).toBe(2);
    const durable = await value.repository.get(REQUEST);
    expect(durable?.snapshot.state).toBe("awaiting_device");
    if (
      durable?.descriptorBytes === null
      || durable?.descriptorBytes === undefined
    ) throw new Error("winning request bytes missing");
    expect(winner.requestBytes).toEqual(durable.descriptorBytes);
    const winningKey = durable?.snapshot.recipient?.recipientPublicKey;
    if (winningKey === undefined) throw new Error("winning recipient missing");
    expect(value.builtRecipientKeys).toContain(winningKey);
    const losingKey = value.builtRecipientKeys.find((key) =>
      key !== winningKey
    );
    expect(losingKey).toBeDefined();
    expect(winningKey).not.toBe(losingKey);
    value.recipients.close();
    otherRecipients.close();
  });

  test("stale durable start invalidates the candidate before protected input opens", async () => {
    const value = await fixture();
    await prepareAndBind(value);
    await acceptGrant(value);
    const claimed = await value.coordinator.prepareOrClaimExact(occurrence());
    if (claimed.status !== "claimed") throw new Error("grant not claimed");
    value.setStartResult("stale");

    expect(await claimed.dispatch.candidate.start("stale-job"))
      .toEqual({ status: "stale" });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(claimed.dispatch.candidate.run(async () => {}))
      .rejects.toThrow("one-use");
    expect(value.recipients.size).toBe(0);
  });

  test("rejects stale current authority before the durable claim", async () => {
    const value = await fixture();
    await prepareAndBind(value);
    await acceptGrant(value);
    const current = value.getCurrent();
    if (current === null) throw new Error("authority unavailable");
    const staleCoordinator = createTaskRuntimeGrantClaim({
      repository: value.trackedRepository,
      recipients: value.recipients,
      plan: value.plan,
      now: () => NOW + 2,
      claimId: () => "stale-task-runtime-claim",
      withCurrentClaimAuthority: async ({ now, use }) => {
        const claimedAt = now();
        return use({
          foreground: {
            ...current,
            recipientRuntimeGeneration: current.recipientRuntimeGeneration + 1,
          },
          namespaceRequirements: initialRecord().authoritySet.namespaceRequirements,
        }, value.trackedRepository, claimedAt, NOW + 60_000);
      },
      withCurrentAuthority: async ({ use }) => use({
        foreground: current,
        namespaceRequirements: initialRecord().authoritySet.namespaceRequirements,
      }),
    });
    const result = await staleCoordinator.prepareOrClaimExact(occurrence());
    expect(result).toEqual({ status: "inactive" });
    expect((await value.repository.get(REQUEST))?.snapshot.state)
      .toBe("grant_ready");
  });

  test("rejects a non-canonical result object or signer before persistence", async () => {
    for (const substitution of ["object", "signer"] as const) {
      const value = await fixture();
      value.setSubstitutePlan((plan) => substitution === "object"
        ? {
          ...plan,
          reference: {
            ...plan.reference,
            resultObjectId: `task-run-result:v1:${"f".repeat(64)}`,
          },
        }
        : {
          ...plan,
          scheduling: {
            ...plan.scheduling,
            agentId: "70000000-0000-4000-8000-000000000007",
          },
        });

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(value.coordinator.prepareOrClaimExact(occurrence()))
        .rejects.toThrow("disagrees with its occurrence");
      expect(await value.repository.get(REQUEST)).toBeNull();
      expect(value.recipients.size).toBe(0);
    }
  });

  test("keeps the definition object revision separate from Namespace authority", async () => {
    const value = await fixture();
    expect(occurrence().task.cryptoAccessRevision).toBe(0);
    expect(initialRecord().expectedNamespaceAccessRevision).toBe(3);
    const substituted: ProtectedTaskOccurrence = Object.freeze({
      ...occurrence(),
      task: Object.freeze({
        ...occurrence().task,
        cryptoAccessRevision: 3,
      }),
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(value.coordinator.prepareOrClaimExact(substituted))
      .rejects.toThrow("disagrees with its occurrence");
    expect(await value.repository.get(REQUEST)).toBeNull();
  });

  test("rejects stale proven output Namespace facts before the durable claim", async () => {
    const value = await fixture();
    await prepareAndBind(value);
    await acceptGrant(value);
    value.setCurrentNamespaceRequirements(Object.freeze([Object.freeze({
      ...initialRecord().authoritySet.namespaceRequirements[0]!,
      expectedAccessRevision: 5,
    })]));

    expect(await value.coordinator.prepareOrClaimExact(occurrence()))
      .toEqual({ status: "inactive" });
    expect((await value.repository.get(REQUEST))?.snapshot.state)
      .toBe("grant_ready");
  });

  test("rejects output Namespace drift after claim before protected work", async () => {
    const value = await fixture();
    await prepareAndBind(value);
    await acceptGrant(value);
    const claimed = await value.coordinator.prepareOrClaimExact(occurrence());
    if (claimed.status !== "claimed") throw new Error("grant not claimed");
    value.setCurrentNamespaceRequirements(Object.freeze([Object.freeze({
      ...initialRecord().authoritySet.namespaceRequirements[0]!,
      expectedPolicyRevision: 8,
    })]));
    let invoked = false;

    expect(await claimed.dispatch.candidate.start("stale-namespace-job"))
      .toEqual({ status: "started" });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(claimed.dispatch.candidate.run(async () => {
      invoked = true;
    })).rejects.toThrow("authority is no longer current");
    expect(invoked).toBe(false);
    expect(value.recipients.size).toBe(0);
  });

  test("rejects swapped durable claim identity and authorization bytes before work", async () => {
    for (const substitution of ["claim", "authorization"] as const) {
      const value = await fixture();
      await prepareAndBind(value);
      await acceptGrant(value);
      const claimed = await value.coordinator.prepareOrClaimExact(occurrence());
      if (claimed.status !== "claimed") throw new Error("grant not claimed");
      let invoked = false;
      value.setSubstituteGet((record) => {
        if (record.snapshot.state !== "claimed") return record;
        return substitution === "claim"
          ? {
            ...record,
            snapshot: { ...record.snapshot, claimId: "swapped-claim" },
          }
          : {
            ...record,
            acceptedMaterial: record.acceptedMaterial === null
              ? null
              : {
                ...record.acceptedMaterial,
                responseBytes: Uint8Array.from([1, 2, 3]),
              },
          };
      });
      expect(await claimed.dispatch.candidate.start(`protected-job-${substitution}`))
        .toEqual({ status: "started" });
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(claimed.dispatch.candidate.run(async () => {
        invoked = true;
      })).rejects.toThrow();
      expect(invoked).toBe(false);
      expect(value.recipients.size).toBe(0);
    }
  });
});
