import { expect, test } from "bun:test";

import type {
  DirectDatabase,
  ParkedProtectedTaskAdditionalAuthority,
  ProtectedTaskRunOutputBinding,
} from "@nautilo/db";
import {
  LatticeCrypto,
  TaskRuntimeRecipientRegistry,
  authorizationRevision,
  domainForegroundNamespaceBindingSetDigest,
} from "@nautilo/lattice-crypto";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import type {
  InitialTaskRuntimeRecipientAuthority,
  ParkedTaskRuntimeCurrentRoutingFacts,
} from "@nautilo/lattice-bridge/server";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import {
  InMemoryBackgroundAuthorizationRepository,
  attachExactTaskRuntimeRecipient,
  taskRuntimeStableRoutingDigest,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type BackgroundAuthorizationTaskRuntimeReplacementRepository,
} from "@nautilo/runtime";

import {
  createProtectedTaskRuntimeParkedDeviceAuthorization,
} from "../../src/routes/protected-task-runtime-parked-device-authorization";
import type {
  ParkedProtectedTaskRuntimeMemoryPlan,
} from "../../src/routes/protected-task-runtime-parked-memory-plan";
import {
  createParkedTaskRuntimeAuthorizationPlanResolver,
  createParkedTaskRuntimeAuthorizationRecord,
  type ParkedTaskRuntimeAuthorizationPlan,
} from "../../src/routes/protected-task-runtime-parked-plan";

const NOW = 1_800_500_000_000;
const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const TASK = "40000000-0000-4000-8000-000000000004";
const RUN = "50000000-0000-4000-8000-000000000005";
const JOB = "60000000-0000-4000-8000-000000000006";
const CONTENT = "70000000-0000-4000-8000-000000000007";
const SOURCE = "80000000-0000-4000-8000-000000000008";
const TARGET = "90000000-0000-4000-8000-000000000009";
const DOMAIN = "a0000000-0000-4000-8000-00000000000a";
const DEVICE = "b0000000-0000-4000-8000-00000000000b";
const SERVER = "c0000000-0000-4000-8000-00000000000c";
const REQUEST = "task-run-authorization:v2:parked-device-fixture";
const INPUT = deriveTaskContentCryptoObjectIdV1({
  kind: "definition",
  taskId: TASK,
  contentRevision: 1,
});
const RESULT = deriveTaskContentCryptoObjectIdV1({
  kind: "run_result",
  taskId: TASK,
  taskRunId: RUN,
  contentRevision: 1,
});

type Overrides = NonNullable<Parameters<
  typeof createProtectedTaskRuntimeParkedDeviceAuthorization
>[1]>;

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function cloneRecord(
  value: BackgroundAuthorizationTaskRuntimeRecordV3,
): BackgroundAuthorizationTaskRuntimeRecordV3 {
  return structuredClone(value);
}

async function resolvedFixture(): Promise<Readonly<{
  resolved: ParkedTaskRuntimeAuthorizationPlan;
  routing: ParkedTaskRuntimeCurrentRoutingFacts;
}>> {
  const routing: ParkedTaskRuntimeCurrentRoutingFacts = {
    taskId: TASK,
    taskRunId: RUN,
    ownerId: USER,
    requestorId: USER,
    agentId: AGENT,
    callingRoomId: SOURCE,
    scheduleKind: "now",
    graphThreadId: "parked-device-thread",
    startedAt: new Date(NOW),
    sourceRoomId: SOURCE,
    targetRoomId: TARGET,
    targetUserIds: [USER],
    memoryMode: "namespace",
    wideBringBack: true,
    scopeId: null,
    contentRepresentation: "protected",
    contentNamespaceId: CONTENT,
    contentRevision: 1,
    contentObjectId: INPUT,
    contentAccessRevision: 0,
    requiredNamespaceFingerprint: bytes(1),
  };
  const expected = {
    occurrence: {
      task: {
        id: TASK,
        ownerId: USER,
        requestorId: USER,
        agentId: AGENT,
        callingRoomId: SOURCE,
        scheduleKind: "now",
        contentRepresentation: "protected",
        contentNamespaceId: CONTENT,
        contentRevision: 1,
        cryptoObjectId: INPUT,
        cryptoAccessRevision: 0,
        cryptoRequiredNamespaceFingerprint:
          routing.requiredNamespaceFingerprint,
      },
      run: {
        id: RUN,
        taskId: TASK,
        jobId: JOB,
        graphThreadId: routing.graphThreadId,
        status: "awaiting",
        startedAt: new Date(NOW),
      },
    },
    priorJob: { reference: { resultObjectId: RESULT } },
    proof: {
      continuation: {
        stableRoutingDigest: taskRuntimeStableRoutingDigest({
          ...routing,
          startedAt: NOW,
          requiredNamespaceFingerprint: Buffer.from(
            routing.requiredNamespaceFingerprint,
          ).toString("base64url"),
          outputRoomId: SOURCE,
          outputNamespaceId: CONTENT,
          widePrimaryWriteNamespaceId: null,
        }),
        semanticAuthorityRequirements: [],
      },
    },
    authorizationRequestId: REQUEST,
    continuationFingerprint: Buffer.from(bytes(2)).toString("base64url"),
    nextExecutionSegment: 2,
  } as unknown as ParkedProtectedTaskAdditionalAuthority;
  const output = {
    taskRunId: RUN,
    bindingId: `task-run-output:${RUN}`,
    resultOperationId: `task-run-result:${RUN}`,
    resultObjectId: RESULT,
    destinationRoomId: SOURCE,
    destinationNamespaceId: CONTENT,
    deliveryMode: "raw",
    acceptedPolicyRevision: 7,
  } as ProtectedTaskRunOutputBinding;
  const memory: ParkedProtectedTaskRuntimeMemoryPlan = {
    expectedNamespaceParticipants: [{
      namespaceId: CONTENT,
      participantHumanIds: [HUMAN],
      match: "exact",
    }],
    routing: {
      taskId: TASK,
      taskRunId: RUN,
      requesterUserId: USER,
      requesterHumanId: HUMAN,
      agentId: AGENT,
      sourceRoomId: SOURCE,
      sourceNamespaceId: CONTENT,
      targetRoomId: TARGET,
      targetUserIds: [USER],
      memoryMode: "namespace",
      scopeId: null,
      targetChat: "new_in_namespace",
      wideBringBack: true,
      widePrivateNamespaceId: null,
      outputRoomId: SOURCE,
      outputNamespaceId: CONTENT,
    },
    resolution: {
      mode: "namespace",
      authorityStatus: "exact",
      provenance: "target_users_namespace",
      envelope: {
        memoryMode: "namespace",
        ownerId: USER,
        actorId: HUMAN,
        agentId: AGENT,
        roomId: TARGET,
        readableNamespaces: [CONTENT],
        mutableNamespaces: [CONTENT],
        writableNamespaces: [CONTENT],
        toolPolicy: {},
      },
    },
  };
  const resolve = createParkedTaskRuntimeAuthorizationPlanResolver({
    db: {} as DirectDatabase,
    discover: async () => expected,
    readOutput: async () => output,
    readPolicy: async () => ({
      mode: "encrypted_only",
      shadowBehavior: "strict",
      revision: 7,
    }),
    resolveMemory: async () => memory,
  });
  const resolved = await resolve({
    taskRunId: RUN,
    authorizationRequestId: REQUEST,
  });
  if (resolved === null) throw new Error("Parked device plan fixture failed");
  return { resolved, routing };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const { resolved, routing } = await resolvedFixture();
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const recipients = new TaskRuntimeRecipientRegistry(crypto, {
    now: () => NOW,
  });
  const backing = new InMemoryBackgroundAuthorizationRepository();
  let held = false;
  let productCalls = 0;
  let ownerCalls = 0;
  let repositoryCalls = 0;
  let repositoryGets = 0;
  let repositoryMutations = 0;
  let clock = NOW;
  let substituteGet: ((record: BackgroundAuthorizationRecord) =>
    BackgroundAuthorizationRecord) | null = null;
  const namespaceFacts = [{
    namespaceId: CONTENT,
    domainId: DOMAIN,
    expectedAccessRevision: 3,
    expectedPolicyRevision: 7,
    expectedDomainEpoch: 2,
    expectedAuthorizationRevision: 3,
  }];
  const canonical = createParkedTaskRuntimeAuthorizationRecord(
    resolved,
    routing,
    namespaceFacts,
    NOW,
  );
  await backing.create(canonical.initialRecord);
  const tracked: BackgroundAuthorizationTaskRuntimeReplacementRepository = {
    create: async record => {
      expect(held).toBe(true);
      repositoryMutations += 1;
      return backing.create(record);
    },
    get: async requestId => {
      expect(held).toBe(true);
      repositoryGets += 1;
      const record = await backing.get(requestId);
      return record === null || substituteGet === null
        ? record
        : substituteGet(record);
    },
    compareAndSwap: async input => {
      expect(held).toBe(true);
      repositoryMutations += 1;
      return backing.compareAndSwap(input);
    },
    replaceUnclaimedTaskRuntimeAuthority: async input => {
      expect(held).toBe(true);
      repositoryMutations += 1;
      return backing.replaceUnclaimedTaskRuntimeAuthority(input);
    },
    acceptVerifiedResponse: input => backing.acceptVerifiedResponse(input),
    listEligible: input => backing.listEligible(input),
    listAwaitingDevicePage: input => backing.listAwaitingDevicePage(input),
    pruneTerminal: input => backing.pruneTerminal(input),
  };
  const admission = {
    userId: USER,
    humanActorId: HUMAN,
    deviceId: DEVICE,
    deviceGeneration: 2,
    serverInstanceId: SERVER,
    lineageGeneration: 1,
    epoch: 1,
    securityRevision: 3,
    headDigest: bytes(3),
    expiresAt: NOW + 120_000,
  };
  const subject = {
    userId: USER,
    humanActorId: HUMAN,
    deviceId: DEVICE,
    admission: { ...admission, headDigest: admission.headDigest.slice() },
  };
  const device = {
    ...admission,
    headDigest: admission.headDigest.slice(),
    signingPublicKey: signing.publicKey.slice(),
  };
  const domain = {
    domainId: DOMAIN,
    sourceNamespaceId: CONTENT,
    participantDigest: bytes(4),
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 2,
    authorizationRevision: authorizationRevision(3),
    headDigest: bytes(5),
    activeNamespaceBindingSetDigest:
      domainForegroundNamespaceBindingSetDigest(crypto, [{
        namespaceId: CONTENT,
        bindingDigest: bytes(6),
      }]),
    activeNamespaceBindingCount: 1,
  };
  const currentAuthority = (): InitialTaskRuntimeRecipientAuthority => ({
    sourceRoomId: SOURCE,
    sourceNamespaceId: CONTENT,
    device: {
      ...device,
      headDigest: device.headDigest.slice(),
      signingPublicKey: device.signingPublicKey.slice(),
    },
    domains: [{
      ...domain,
      participantDigest: domain.participantDigest.slice(),
      headDigest: domain.headDigest.slice(),
      activeNamespaceBindingSetDigest:
        domain.activeNamespaceBindingSetDigest.slice(),
    }],
    namespaceRequirements: canonical.authority.namespaces,
    policyRevision: 7,
  });
  const restricted = { query: async () => [] } as never;
  const overrides: Overrides = {
    db: {} as DirectDatabase,
    crypto,
    serverScope: "https://server.test",
    now: () => clock,
    resolvePlan: async () => resolved,
    productContext: async () => {
      productCalls += 1;
      return { canonicalRunner: {} } as never;
    },
    withRecipientAuthority: async input => {
      ownerCalls += 1;
      if (!await input.validateCurrentRouting(routing)) return null;
      const current = currentAuthority();
      held = true;
      try {
        return await input.use(current, restricted);
      } finally {
        current.device.headDigest.fill(0);
        current.device.signingPublicKey.fill(0);
        for (const entry of current.domains) {
          entry.participantDigest.fill(0);
          entry.headDigest.fill(0);
          entry.activeNamespaceBindingSetDigest.fill(0);
        }
        held = false;
      }
    },
    repository: async () => {
      expect(held).toBe(true);
      repositoryCalls += 1;
      return tracked;
    },
  };
  const createHooks = (patch: Overrides = {}) =>
    createProtectedTaskRuntimeParkedDeviceAuthorization({
      resolver: {} as Parameters<
        typeof createProtectedTaskRuntimeParkedDeviceAuthorization
      >[0]["resolver"],
      recipients,
    }, { ...overrides, ...patch });
  const operation = (record: BackgroundAuthorizationTaskRuntimeRecordV3) => ({
    subject,
    admission,
    device,
    restricted,
    record,
  });
  const close = () => {
    recipients.close();
    signing.privateKey.fill(0);
    signing.publicKey.fill(0);
  };
  return {
    resolved,
    routing,
    canonical,
    recipients,
    backing,
    tracked,
    subject,
    admission,
    device,
    restricted,
    createHooks,
    operation,
    close,
    counts: () => ({
      productCalls,
      ownerCalls,
      repositoryCalls,
      repositoryGets,
      repositoryMutations,
    }),
    setSubstituteGet: (
      value: typeof substituteGet,
    ) => { substituteGet = value; },
    setClock: (value: number) => { clock = value; },
  };
}

async function bind(f: Fixture) {
  const hooks = f.createHooks();
  const bound = await hooks.bindTaskRecipient(
    f.operation(cloneRecord(f.canonical.initialRecord)),
  );
  if (bound === null) throw new Error("Parked recipient did not bind");
  return { hooks, bound };
}

test("binds the exact parked request through the held repository", async () => {
  const f = await fixture();
  try {
    const { hooks, bound } = await bind(f);
    const request = decodeTaskRuntimeBackgroundAuthorizationRequestV1(
      bound.requestBytes,
    );
    expect(request).not.toBeNull();
    expect(request).toMatchObject({
      requestId: REQUEST,
      workId: RUN,
      recipientGeneration: 0,
      sourceRoomId: SOURCE,
    });
    expect(bound.record.snapshot.state).toBe("awaiting_device");
    expect(bound.record.descriptorBytes).toEqual(bound.requestBytes);
    expect(hooks.isTaskRecipientActive(bound.record)).toBe(true);
    expect(f.counts()).toEqual({
      productCalls: 1,
      ownerCalls: 1,
      repositoryCalls: 1,
      repositoryGets: 2,
      repositoryMutations: 1,
    });
    if (request !== null) {
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
    }
  } finally {
    f.close();
  }
});

test("keeps decoded authority live through the awaited callback and destroys it after", async () => {
  const f = await fixture();
  try {
    const { hooks, bound } = await bind(f);
    type Use = Parameters<typeof hooks.withTaskAuthority>[0]["use"];
    const retained: {
      request: Parameters<Use>[0] | null;
      plan: Parameters<Use>[1] | null;
      domain: Parameters<Use>[2][number] | null;
      device: Parameters<Use>[3] | null;
    } = { request: null, plan: null, domain: null, device: null };
    const result = await hooks.withTaskAuthority({
      subject: f.subject,
      admission: f.admission,
      restricted: f.restricted,
      record: bound.record,
      use: async (request, plan, domains, device, restricted) => {
        retained.request = request;
        retained.plan = plan;
        retained.domain = domains[0] ?? null;
        retained.device = device;
        await Promise.resolve();
        expect(request.recipientPublicKey.some(value => value !== 0)).toBe(true);
        expect(plan.domains[0]?.participantDigest.some(value => value !== 0))
          .toBe(true);
        expect(domains[0]?.participantDigest.some(value => value !== 0))
          .toBe(true);
        expect(device.signingPublicKey.some(value => value !== 0)).toBe(true);
        expect(restricted).toBe(f.restricted);
        return "accepted";
      },
    });
    expect(result).toBe("accepted");
    expect(retained.request?.recipientPublicKey.every(value => value === 0))
      .toBe(true);
    expect(retained.plan?.domains[0]?.participantDigest.every(
      value => value === 0,
    ))
      .toBe(true);
    expect(retained.domain?.participantDigest.every(value => value === 0))
      .toBe(true);
    expect(retained.device?.signingPublicKey.every(value => value === 0))
      .toBe(true);
  } finally {
    f.close();
  }
});

test("rejects response callbacks that cross request or admission expiry", async () => {
  const requestExpiry = await fixture();
  try {
    const { hooks, bound } = await bind(requestExpiry);
    let callbacks = 0;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(hooks.withTaskAuthority({
      subject: requestExpiry.subject,
      admission: requestExpiry.admission,
      restricted: requestExpiry.restricted,
      record: bound.record,
      use: async request => {
        callbacks += 1;
        await Promise.resolve();
        requestExpiry.setClock(request.deadlineAt);
        return true;
      },
    })).rejects.toThrow("authorization expired before commit");
    expect(callbacks).toBe(1);
  } finally {
    requestExpiry.close();
  }

  const admissionExpiry = await fixture();
  try {
    const { hooks, bound } = await bind(admissionExpiry);
    let callbacks = 0;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(hooks.withTaskAuthority({
      subject: admissionExpiry.subject,
      admission: admissionExpiry.admission,
      restricted: admissionExpiry.restricted,
      record: bound.record,
      use: async () => {
        callbacks += 1;
        await Promise.resolve();
        admissionExpiry.setClock(admissionExpiry.admission.expiresAt);
        return true;
      },
    })).rejects.toThrow("device admission expired before commit");
    expect(callbacks).toBe(1);
  } finally {
    admissionExpiry.close();
  }
});

test("deletes newly attached custody when held admission expires", async () => {
  const f = await fixture();
  try {
    const hooks = f.createHooks({
      attach: async input => {
        const bound = await attachExactTaskRuntimeRecipient(input);
        f.setClock(f.admission.expiresAt);
        return bound;
      },
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(hooks.bindTaskRecipient(
      f.operation(cloneRecord(f.canonical.initialRecord)),
    )).rejects.toThrow("device admission expired before commit");
    expect(f.recipients.size).toBe(0);
  } finally {
    f.close();
  }
});

test("rejects wrong Human, revision, plan, and routing before mutation", async () => {
  const wrongHuman = await fixture();
  try {
    const hooks = wrongHuman.createHooks();
    expect(await hooks.bindTaskRecipient({
      ...wrongHuman.operation(cloneRecord(wrongHuman.canonical.initialRecord)),
      subject: {
        ...wrongHuman.subject,
        humanActorId: "d0000000-0000-4000-8000-00000000000d",
      },
    })).toBeNull();
    expect(wrongHuman.counts()).toEqual({
      productCalls: 0,
      ownerCalls: 0,
      repositoryCalls: 0,
      repositoryGets: 0,
      repositoryMutations: 0,
    });
  } finally {
    wrongHuman.close();
  }

  const staleRevision = await fixture();
  try {
    const selected: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...cloneRecord(staleRevision.canonical.initialRecord),
      expectedPolicyRevision:
        staleRevision.canonical.initialRecord.expectedPolicyRevision + 1,
    };
    expect(await staleRevision.createHooks().bindTaskRecipient(
      staleRevision.operation(selected),
    )).toBeNull();
    expect(staleRevision.counts().ownerCalls).toBe(0);
    expect(staleRevision.counts().repositoryMutations).toBe(0);
  } finally {
    staleRevision.close();
  }

  const stalePlan = await fixture();
  try {
    const selected = cloneRecord(stalePlan.canonical.initialRecord);
    selected.workIdentityHash.fill(9);
    expect(await stalePlan.createHooks().bindTaskRecipient(
      stalePlan.operation(selected),
    )).toBeNull();
    expect(stalePlan.counts().repositoryCalls).toBe(0);
    expect(stalePlan.counts().repositoryMutations).toBe(0);
  } finally {
    stalePlan.close();
  }

  const staleRouting = await fixture();
  try {
    const hooks = staleRouting.createHooks({
      withRecipientAuthority: async input => {
        const changed = {
          ...staleRouting.routing,
          targetRoomId: SOURCE,
        };
        expect(await input.validateCurrentRouting(changed)).toBe(false);
        return null;
      },
    });
    expect(await hooks.bindTaskRecipient(
      staleRouting.operation(cloneRecord(staleRouting.canonical.initialRecord)),
    )).toBeNull();
    expect(staleRouting.counts().repositoryCalls).toBe(0);
    expect(staleRouting.counts().repositoryMutations).toBe(0);
  } finally {
    staleRouting.close();
  }
});

test("rejects changed descriptors and missing process custody without mutation", async () => {
  const descriptor = await fixture();
  try {
    const { hooks, bound } = await bind(descriptor);
    const mutationBaseline = descriptor.counts().repositoryMutations;
    descriptor.setSubstituteGet(record => {
      const current = record as BackgroundAuthorizationTaskRuntimeRecordV3;
      const changed = cloneRecord(current);
      if (changed.descriptorBytes === null) return changed;
      changed.descriptorBytes[0] = changed.descriptorBytes[0]! ^ 0xff;
      return changed;
    });
    let callbacks = 0;
    expect(await hooks.withTaskAuthority({
      subject: descriptor.subject,
      admission: descriptor.admission,
      restricted: descriptor.restricted,
      record: bound.record,
      use: async () => { callbacks += 1; return true; },
    })).toBeNull();
    expect(callbacks).toBe(0);
    expect(descriptor.counts().repositoryMutations).toBe(mutationBaseline);
  } finally {
    descriptor.close();
  }

  const custody = await fixture();
  try {
    const { hooks, bound } = await bind(custody);
    const recipient = bound.record.snapshot.recipient;
    if (recipient === null) throw new Error("Bound recipient missing");
    expect(custody.recipients.delete(
      bound.record.snapshot.requestId,
      bound.record.snapshot.recipientGeneration,
    )).toBe(true);
    const mutationBaseline = custody.counts().repositoryMutations;
    let callbacks = 0;
    expect(await hooks.withTaskAuthority({
      subject: custody.subject,
      admission: custody.admission,
      restricted: custody.restricted,
      record: bound.record,
      use: async () => { callbacks += 1; return true; },
    })).toBeNull();
    expect(callbacks).toBe(0);
    expect(custody.counts().repositoryMutations).toBe(mutationBaseline);
  } finally {
    custody.close();
  }
});

test("snapshots inputs before resolution and keeps repository use inside the owner", async () => {
  const f = await fixture();
  try {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const hooks = f.createHooks({
      resolvePlan: async () => {
        entered.resolve();
        await release.promise;
        return f.resolved;
      },
    });
    const source = f.operation(cloneRecord(f.canonical.initialRecord));
    const operation = {
      ...source,
      subject: structuredClone(source.subject),
      admission: structuredClone(source.admission),
      record: structuredClone(source.record),
    };
    const pending = hooks.bindTaskRecipient(operation);
    await entered.promise;
    operation.subject.humanActorId =
      "d0000000-0000-4000-8000-00000000000d";
    operation.admission.headDigest.fill(9);
    operation.record.workIdentityHash.fill(9);
    release.resolve();
    const bound = await pending;
    expect(bound?.record.snapshot.state).toBe("awaiting_device");
    expect(f.counts()).toEqual({
      productCalls: 1,
      ownerCalls: 1,
      repositoryCalls: 1,
      repositoryGets: 2,
      repositoryMutations: 1,
    });
  } finally {
    f.close();
  }
});

test("a null Plain-mode plan never enters product or recipient authority", async () => {
  const f = await fixture();
  try {
    const hooks = f.createHooks({ resolvePlan: async () => null });
    expect(await hooks.bindTaskRecipient(
      f.operation(cloneRecord(f.canonical.initialRecord)),
    )).toBeNull();
    expect(f.counts()).toEqual({
      productCalls: 0,
      ownerCalls: 0,
      repositoryCalls: 0,
      repositoryGets: 0,
      repositoryMutations: 0,
    });
  } finally {
    f.close();
  }
});
