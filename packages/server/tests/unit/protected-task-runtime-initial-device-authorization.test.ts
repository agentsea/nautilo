import { expect, test } from "bun:test";
import {
  LatticeCrypto,
  TaskRuntimeRecipientRegistry,
  authorizationRevision,
  domainForegroundNamespaceBindingSetDigest,
} from "@nautilo/lattice-crypto";
import type { StartProtectedTaskRunInput } from "@nautilo/db";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import {
  InMemoryBackgroundAuthorizationRepository,
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  createTaskRuntimeGrantClaim,
  taskRuntimeStableIdempotencyKey,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type ProtectedTaskOccurrence,
  type TaskRuntimeGrantClaimPlan,
  type TaskRuntimeRecipientCurrentAuthority,
} from "@nautilo/runtime";

import {
  createProtectedTaskRuntimeInitialDeviceAuthorization,
} from "../../src/routes/protected-task-runtime-initial-device-authorization";
import { createProtectedTaskRuntimeRecipientRequestPlan } from
  "../../src/routes/protected-task-runtime-recipient-request-plan";

const NOW = 1_800_500_000_000;
const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const TASK = "40000000-0000-4000-8000-000000000004";
const RUN = "50000000-0000-4000-8000-000000000005";
const JOB = "60000000-0000-4000-8000-000000000006";
const ROOM = "70000000-0000-4000-8000-000000000007";
const NAMESPACE = "80000000-0000-4000-8000-000000000008";
const DEVICE = "90000000-0000-4000-8000-000000000009";
const SERVER = "a0000000-0000-4000-8000-00000000000a";
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

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function occurrence(jobId: string | null = null): ProtectedTaskOccurrence {
  return {
    task: {
      id: TASK,
      ownerId: USER,
      requestorId: USER,
      agentId: AGENT,
      callingRoomId: ROOM,
      scheduleKind: "now",
      contentRepresentation: "protected",
      contentNamespaceId: NAMESPACE,
      contentRevision: 1,
      cryptoObjectId: INPUT_OBJECT,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: bytes(1),
    },
    run: {
      id: RUN,
      taskId: TASK,
      jobId,
      graphThreadId: `subagent:${TASK}:${RUN}`,
      status: "awaiting",
      startedAt: new Date(NOW),
    },
  };
}

function stableIdentity(value = occurrence()): TaskRuntimeGrantClaimPlan["stableIdentity"] {
  return {
    taskId: TASK,
    taskRunId: RUN,
    executionSegment: value.run.jobId === null ? 1 : 2,
    resumeContinuationFingerprint: value.run.jobId === null
      ? null
      : Buffer.from(bytes(8)).toString("base64url"),
    ownerId: USER,
    requestorId: USER,
    agentId: AGENT,
    callingRoomId: ROOM,
    scheduleKind: "now",
    graphThreadId: value.run.graphThreadId,
    startedAt: NOW,
    sourceRoomId: ROOM,
    targetRoomId: ROOM,
    targetUserIds: [USER],
    outputRoomId: ROOM,
    outputNamespaceId: NAMESPACE,
    memoryMode: "namespace",
    scopeId: null,
    contentRepresentation: "protected",
    contentNamespaceId: NAMESPACE,
    contentRevision: 1,
    contentObjectId: INPUT_OBJECT,
    contentAccessRevision: 0,
    requiredNamespaceFingerprint: Buffer.from(bytes(1)).toString("base64url"),
  };
}

function initialRecord(
  identity = stableIdentity(),
): BackgroundAuthorizationTaskRuntimeRecordV3 {
  return {
    snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({
      requestId: REQUEST,
      workId: RUN,
      namespaceId: NAMESPACE,
      now: NOW,
    }),
    workIdentityHash: bytes(2),
    idempotencyKey: taskRuntimeStableIdempotencyKey(identity),
    workKind: "task.execute",
    purpose: "task.execute",
    domainId: DOMAIN,
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 2,
    expectedNamespaceAccessRevision: 3,
    expectedPolicyRevision: 7,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
    authoritySet: {
      namespaceRequirements: [{
        ordinal: 0,
        namespaceId: NAMESPACE,
        domainId: DOMAIN,
        operations: ["decrypt", "encrypt"],
        expectedAccessRevision: 3,
        expectedPolicyRevision: 7,
      }],
      domainRequirements: [{
        ordinal: 0,
        domainId: DOMAIN,
        expectedEpoch: 2,
        expectedAuthorizationRevision: 3,
      }],
    },
  };
}

async function fixture(
  resolve: () => ProtectedTaskOccurrence | null = occurrence,
) {
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  let clock = NOW + 1;
  const recipients = new TaskRuntimeRecipientRegistry(crypto, {
    now: () => clock,
  });
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const initial = initialRecord();
  await repository.create(initial);
  const domain = {
    domainId: DOMAIN,
    sourceNamespaceId: NAMESPACE,
    participantDigest: bytes(3),
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
  };
  const device = {
    userId: USER,
    humanActorId: HUMAN,
    deviceId: DEVICE,
    deviceGeneration: 2,
    serverInstanceId: SERVER,
    lineageGeneration: 1,
    epoch: 1,
    securityRevision: 4,
    headDigest: bytes(6),
    signingPublicKey: signing.publicKey.slice(),
  };
  const current: TaskRuntimeRecipientCurrentAuthority = {
    device,
    domains: [domain],
    namespaceRequirements: initial.authoritySet.namespaceRequirements,
    policyRevision: 7,
    sourceRoomId: ROOM,
  };
  const requestPlan = createProtectedTaskRuntimeRecipientRequestPlan({
    crypto,
    occurrence: occurrence(),
    initialRecord: initial,
    sourceRoomId: ROOM,
    authority: {
      policyRevision: 7,
      namespaces: initial.authoritySet.namespaceRequirements,
      domains: initial.authoritySet.domainRequirements,
    },
    createdAt: NOW,
    recipientTtlMs: 60_000,
  });
  const plan = (value: ProtectedTaskOccurrence): TaskRuntimeGrantClaimPlan => ({
    stableIdentity: stableIdentity(value),
    initialRecord: initialRecord(stableIdentity(value)),
    reference: {
      kind: "protected_task_run_v1",
      taskId: TASK,
      taskRunId: RUN,
      inputObjectId: INPUT_OBJECT,
      resultObjectId: RESULT_OBJECT,
      authorizationRequestId: REQUEST,
      policyRevision: 7,
      executionSegment: value.run.jobId === null ? 1 : 2,
      ...(value.run.jobId === null
        ? {}
        : { resumeContinuationFingerprint:
          Buffer.from(bytes(8)).toString("base64url") }),
    },
    scheduling: {
      ownerId: USER,
      requestorId: USER,
      agentId: AGENT,
      roomId: ROOM,
      callingRoomId: ROOM,
      graphThreadId: value.run.graphThreadId,
    },
    executor: async function* () { yield* []; },
    startProtectedTaskRun: async (_input: StartProtectedTaskRunInput) => ({
      status: "started" as const,
    }),
    ...requestPlan,
    openTransientInput: async () => ({}),
    publishResult: async () => {},
  });
  const claim = createTaskRuntimeGrantClaim({
    repository,
    recipients,
    plan,
    withCurrentClaimAuthority: async () => null,
    withCurrentAuthority: async () => null,
    now: () => clock,
  });
  const restricted = { query: async () => [] } as never;
  const withRecipientAuthority = (async input => input.use({
    ...current,
    restricted: input.restricted ?? restricted,
  }, repository)) as Parameters<
    typeof createProtectedTaskRuntimeInitialDeviceAuthorization
  >[0]["withRecipientAuthority"];
  const hooks = createProtectedTaskRuntimeInitialDeviceAuthorization({
    recipients,
    claim,
    plan: async value => plan(value),
    resolveOccurrence: async () => resolve(),
    withRecipientAuthority,
    now: () => clock,
  });
  const admission = {
    userId: USER,
    humanActorId: HUMAN,
    deviceId: DEVICE,
    deviceGeneration: 2,
    serverInstanceId: SERVER,
    lineageGeneration: 1,
    epoch: 1,
    securityRevision: 4,
    headDigest: bytes(6),
    expiresAt: NOW + 120_000,
  };
  const subject = {
    userId: USER,
    humanActorId: HUMAN,
    deviceId: DEVICE,
    admission: { ...admission, headDigest: bytes(6) },
  };
  const operation = (record: BackgroundAuthorizationTaskRuntimeRecordV3) => ({
    subject,
    admission,
    device,
    restricted,
    record,
  });
  return {
    hooks,
    initial,
    operation,
    repository,
    recipients,
    close: () => {
      recipients.close();
      signing.privateKey.fill(0);
      signing.publicKey.fill(0);
    },
    setClock: (value: number) => { clock = value; },
  };
}

test("binds and lends the exact initial Task grant", async () => {
  const f = await fixture();
  try {
    const bound = await f.hooks.bindTaskRecipient(f.operation(f.initial));
    expect(bound).not.toBeNull();
    if (bound === null) return;
    expect(bound.record.snapshot.state).toBe("awaiting_device");
    let uses = 0;
    const accepted = await f.hooks.withTaskAuthority({
      ...f.operation(bound.record),
      use: async (_request, plan, _domains, device, restricted) => {
        uses += 1;
        expect(plan.roomId).toBe(ROOM);
        expect(device.deviceId).toBe(DEVICE);
        expect(restricted).toBe(f.operation(bound.record).restricted);
        return "accepted";
      },
    });
    expect(accepted).toBe("accepted");
    expect(uses).toBe(1);
  } finally {
    f.close();
  }
});

test("keeps committed recipient custody when detached occurrence discovery changes", async () => {
  let resolves = 0;
  const f = await fixture(() => {
    resolves += 1;
    return resolves === 1 ? occurrence() : null;
  });
  try {
    const bound = await f.hooks.bindTaskRecipient(f.operation(f.initial));
    expect(bound).not.toBeNull();
    if (bound === null) return;
    expect(resolves).toBe(1);
    const durable = await f.repository.get(REQUEST);
    expect(durable?.snapshot.state).toBe("awaiting_device");
    expect(durable?.snapshot.recipient).toEqual(bound.record.snapshot.recipient);
    if (durable === null || durable.snapshot.recipient === null) {
      throw new Error("Initial recipient binding was not durable");
    }
    expect(f.recipients.hasAttempt({
      requestId: durable.snapshot.requestId,
      workId: durable.snapshot.workId,
      recipientGeneration: durable.snapshot.recipientGeneration,
      recipientKeyId: durable.snapshot.recipient.recipientKeyId,
    })).toBe(true);
    expect(f.recipients.size).toBe(1);
  } finally {
    f.close();
  }
});

test("rejects wrong or stale initial occurrence identity", async () => {
  for (const current of [
    () => ({ ...occurrence(), run: { ...occurrence().run, id: USER } }),
    () => null,
  ]) {
    const f = await fixture(current as () => ProtectedTaskOccurrence | null);
    try {
      expect(await f.hooks.bindTaskRecipient(f.operation(f.initial))).toBeNull();
      expect(f.recipients.size).toBe(0);
    } finally {
      f.close();
    }
  }
});

test("rejects expired or substituted recipient identity", async () => {
  const expired = await fixture();
  try {
    const bound = await expired.hooks.bindTaskRecipient(
      expired.operation(expired.initial),
    );
    if (bound === null || bound.record.snapshot.recipient === null) {
      throw new Error("Initial recipient did not bind");
    }
    expired.setClock(bound.record.snapshot.recipient.expiresAt);
    expect(await expired.hooks.withTaskAuthority({
      ...expired.operation(bound.record),
      use: async () => "unsafe",
    })).toBeNull();
  } finally {
    expired.close();
  }

  const substituted = await fixture();
  try {
    const bound = await substituted.hooks.bindTaskRecipient(
      substituted.operation(substituted.initial),
    );
    if (bound === null || bound.record.snapshot.recipient === null) {
      throw new Error("Initial recipient did not bind");
    }
    const changed = structuredClone(bound.record);
    const recipient = changed.snapshot.recipient;
    if (recipient === null) throw new Error("Bound recipient disappeared");
    const substitutedRecord = {
      ...changed,
      snapshot: {
        ...changed.snapshot,
        recipient: { ...recipient, recipientKeyId: "substituted-key" },
      },
    } as BackgroundAuthorizationTaskRuntimeRecordV3;
    expect(await substituted.hooks.withTaskAuthority({
      ...substituted.operation(substitutedRecord),
      use: async () => "unsafe",
    })).toBeNull();
  } finally {
    substituted.close();
  }
});

test("never routes a parked Task occurrence through the initial adapter", async () => {
  const f = await fixture(() => occurrence(JOB));
  try {
    expect(await f.hooks.bindTaskRecipient(f.operation(f.initial))).toBeNull();
    expect(f.recipients.size).toBe(0);
  } finally {
    f.close();
  }
});
