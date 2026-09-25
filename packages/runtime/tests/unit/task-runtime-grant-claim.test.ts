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
} from "@nautilo/lattice-crypto/background";
import {
  serializeDomainForegroundAuthorizationV2,
  type DomainForegroundAuthorizationPlanV2,
  type DomainForegroundAuthorizationPublicCurrentAuthorityV2,
} from "@nautilo/lattice-crypto/wire";

import type { JobExecutor } from "../../src/job";
import {
  createBackgroundAuthorizationTaskRuntimeRequestV3,
} from "../../src/protected-execution/background-authorization/lifecycle";
import {
  InMemoryBackgroundAuthorizationRepository,
  type BackgroundAuthorizationCasResult,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "../../src/protected-execution/background-authorization/repository";
import {
  createTaskRuntimeGrantClaim,
  type TaskRuntimeGrantClaimPlan,
} from "../../src/protected-execution/background-authorization/task-runtime-grant-claim";
import type { ProtectedTaskOccurrence } from "../../src/tasks/task-observer";

const NOW = 1_800_500_000_000;
const OWNER = "10000000-0000-4000-8000-000000000001";
const REQUESTOR = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const ROOM = "40000000-0000-4000-8000-000000000004";
const TASK = "50000000-0000-4000-8000-000000000005";
const RUN = "60000000-0000-4000-8000-000000000006";
const NAMESPACE = "task-runtime-namespace";
const DOMAIN = "task-runtime-domain";
const REQUEST = `task-run-authorization:${RUN}`;
const INPUT_OBJECT = `task-definition:v1:${"a".repeat(64)}`;
const RESULT_OBJECT = `task-run-result:v1:${"b".repeat(64)}`;
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

function occurrence(): ProtectedTaskOccurrence {
  return Object.freeze({
    task: Object.freeze({
      id: TASK,
      ownerId: OWNER,
      requestorId: REQUESTOR,
      agentId: AGENT,
      callingRoomId: ROOM,
      contentRepresentation: "protected" as const,
      contentNamespaceId: NAMESPACE,
      contentRevision: 1,
      cryptoObjectId: INPUT_OBJECT,
      cryptoAccessRevision: 4,
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

function initialRecord(): BackgroundAuthorizationTaskRuntimeRecordV3 {
  return Object.freeze({
    snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({
      requestId: REQUEST,
      workId: RUN,
      namespaceId: NAMESPACE,
      now: NOW,
    }),
    workIdentityHash: bytes(10),
    idempotencyKey: `task-run:${RUN}`,
    workKind: "task.execute" as const,
    purpose: "task.execute" as const,
    domainId: DOMAIN,
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 2,
    expectedNamespaceAccessRevision: 4,
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
        expectedAccessRevision: 4,
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
  let currentAuthority: DomainForegroundAuthorizationPublicCurrentAuthorityV2
    | null = null;
  let grantPlan: DomainForegroundAuthorizationPlanV2 | null = null;
  let claimCasCount = 0;
  let authorityLocksHeld = false;
  let clock = NOW + 1;
  let substituteGet: ((record: BackgroundAuthorizationRecord) =>
    BackgroundAuthorizationRecord) | null = null;
  const trackedRepository: BackgroundAuthorizationRepository = {
    create: (record) => repository.create(record),
    get: async (requestId) => {
      const record = await repository.get(requestId);
      return record === null || substituteGet === null
        ? record
        : substituteGet(record);
    },
    compareAndSwap: async (input): Promise<BackgroundAuthorizationCasResult> => {
      if (input.next.snapshot.state === "claimed") claimCasCount += 1;
      return repository.compareAndSwap(input);
    },
    acceptVerifiedResponse: (input) => repository.acceptVerifiedResponse(input),
    listEligible: (input) => repository.listEligible(input),
    listAwaitingDevicePage: (input) => repository.listAwaitingDevicePage(input),
    pruneTerminal: (input) => repository.pruneTerminal(input),
  };
  const executor: JobExecutor = async function* () { yield* []; };
  const plan = (value: ProtectedTaskOccurrence): TaskRuntimeGrantClaimPlan => ({
    initialRecord: initialRecord(),
    reference: {
      kind: "protected_task_run_v1",
      taskId: TASK,
      taskRunId: RUN,
      inputObjectId: INPUT_OBJECT,
      resultObjectId: RESULT_OBJECT,
      authorizationRequestId: REQUEST,
      policyRevision: 7,
    },
    scheduling: {
      ownerId: OWNER,
      requestorId: REQUESTOR,
      agentId: AGENT,
      roomId: ROOM,
      callingRoomId: ROOM,
      graphThreadId: value.run.graphThreadId,
    },
    executor,
    recipientAttempt: () => ({
      recipientKeyId: "task-runtime-recipient",
      expiresAt: NOW + 60_000,
    }),
    buildRequest: ({ attempt }) => {
      grantPlan = createDomainForegroundAuthorizationPlan(crypto, {
        authorizationId: REQUEST,
        policyRevision: 7,
        sessionId: `task-run:${RUN}`,
        roomId: ROOM,
        subjectHumanId: humanId(REQUESTOR),
        committerDeviceId: cryptoDeviceId("task-runtime-device"),
        committerDeviceSigningGeneration: 2,
        hostAuthorizationRevision: authorizationRevision(6),
        recipientKind: "runtime",
        recipientPrincipalId: "nautilo_task_runtime",
        recipientAuthorizationRevision: authorizationRevision(0),
        recipientRuntimeGeneration: attempt.recipientGeneration,
        recipientKeyId: attempt.recipientKeyId,
        operations: ["decrypt", "encrypt"],
        issuedAt: NOW,
        deadlineAt: attempt.expiresAt,
        maximumSecretBytes: 4_096,
        domains: [domain],
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
        sourceRoomId: ROOM,
        recipientKeyId: attempt.recipientKeyId,
        recipientPublicKey: attempt.recipientPublicKey,
        authorizationPlan: grantPlan,
        issuedAt: NOW,
        deadlineAt: attempt.expiresAt,
      });
    },
    openTransientInput: async ({ domains, signal }) => {
      expect(authorityLocksHeld).toBe(false);
      signal.throwIfAborted();
      expect(domains).toHaveLength(1);
      expect(domains[0]!.domainKey).toEqual(bytes(9));
      return { message: SENTINEL };
    },
  });
  const coordinator = createTaskRuntimeGrantClaim({
    repository: trackedRepository,
    recipients,
    plan,
    now: () => clock,
    claimId: () => "task-runtime-claim",
    withCurrentAuthority: async ({ use }) => {
      if (currentAuthority === null) return null;
      const borrowed = copyAuthority(currentAuthority);
      authorityLocksHeld = true;
      try {
        return await use(borrowed);
      } finally {
        destroyAuthority(borrowed);
        authorityLocksHeld = false;
      }
    },
  });
  return {
    crypto,
    signing,
    repository,
    trackedRepository,
    recipients,
    coordinator,
    plan,
    getPlan: () => grantPlan,
    getCurrent: () => currentAuthority,
    claimCasCount: () => claimCasCount,
    authorityLocksHeld: () => authorityLocksHeld,
    setClock: (value: number) => { clock = value; },
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

describe("Task Runtime grant claim", () => {
  test("claims one accepted grant and opens transient input only inside a one-use candidate", async () => {
    const value = await fixture();
    expect(await value.coordinator.prepareOrClaimExact(occurrence()))
      .toEqual({ status: "awaiting_authorization" });
    const prepared = await value.repository.get(REQUEST);
    expect(prepared?.snapshot.state).toBe("awaiting_device");
    expect(JSON.stringify(prepared)).not.toContain(SENTINEL);

    await acceptGrant(value);
    const result = await value.coordinator.prepareOrClaimExact(occurrence());
    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") throw new Error("grant not claimed");
    expect(value.claimCasCount()).toBe(1);
    const durable = await value.repository.get(REQUEST);
    expect(durable?.snapshot.state).toBe("claimed");
    expect(durable?.snapshot.claimExpiresAt).toBe(NOW + 60_000);
    expect(JSON.stringify(durable)).not.toContain(SENTINEL);

    const transient: Record<string, unknown>[] = [];
    await result.dispatch.candidate.run(async (input, signal) => {
      expect(value.authorityLocksHeld()).toBe(false);
      signal.throwIfAborted();
      transient.push(input);
    });
    expect(transient[0]).toEqual({ message: SENTINEL });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(result.dispatch.candidate.run(async () => {}))
      .rejects.toThrow("one-use");
    expect(value.recipients.size).toBe(0);
    expect(JSON.stringify(await value.repository.get(REQUEST)))
      .not.toContain(SENTINEL);
  });

  test("rejects stale current authority before the durable claim", async () => {
    const value = await fixture();
    await value.coordinator.prepareOrClaimExact(occurrence());
    await acceptGrant(value);
    const current = value.getCurrent();
    if (current === null) throw new Error("authority unavailable");
    const staleCoordinator = createTaskRuntimeGrantClaim({
      repository: value.trackedRepository,
      recipients: value.recipients,
      plan: value.plan,
      now: () => NOW + 2,
      claimId: () => "stale-task-runtime-claim",
      withCurrentAuthority: async ({ use }) => use({
        ...current,
        recipientRuntimeGeneration: current.recipientRuntimeGeneration + 1,
      }),
    });
    const result = await staleCoordinator.prepareOrClaimExact(occurrence());
    expect(result).toEqual({ status: "inactive" });
    expect((await value.repository.get(REQUEST))?.snapshot.state)
      .toBe("grant_ready");
  });

  test("rejects swapped durable claim identity and authorization bytes before work", async () => {
    for (const substitution of ["claim", "authorization"] as const) {
      const value = await fixture();
      await value.coordinator.prepareOrClaimExact(occurrence());
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
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(claimed.dispatch.candidate.run(async () => {
        invoked = true;
      })).rejects.toThrow();
      expect(invoked).toBe(false);
      expect(value.recipients.size).toBe(0);
    }
  });
});
