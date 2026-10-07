import { createHash } from "node:crypto";

import { expect, test } from "bun:test";

import {
  LatticeCrypto,
  authorizationRevision,
  type DomainForegroundAuthorityEntry,
} from "@nautilo/lattice-crypto";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  parseDomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import type { ScopeMemoryEnvelopeWithOrigin } from "@nautilo/trust";
import type {
  ProtectedTaskPredispatchPlan,
  ProtectedTaskOccurrence,
} from "@nautilo/runtime";
import {
  createProtectedTaskRuntimeGrantPlanBuilder,
  type ProtectedTaskRuntimeNamespaceAuthorityFact,
} from "../../src/routes/protected-task-runtime-grant-plan";

const NOW = 1_800_500_000_000;
const OWNER = "10000000-0000-4000-8000-000000000001";
const REQUESTOR = "20000000-0000-4000-8000-000000000002";
const HUMAN = "30000000-0000-4000-8000-000000000003";
const AGENT = "40000000-0000-4000-8000-000000000004";
const TASK = "50000000-0000-4000-8000-000000000005";
const RUN = "60000000-0000-4000-8000-000000000006";
const TASK_TWO = "51000000-0000-4000-8000-000000000005";
const RUN_TWO = "61000000-0000-4000-8000-000000000006";
const ROOM = "70000000-0000-4000-8000-000000000007";
const DEVICE = "80000000-0000-4000-8000-000000000008";
const CONTENT = "90000000-0000-4000-8000-000000000009";
const READABLE = "a0000000-0000-4000-8000-00000000000a";
const OUTPUT = "a1000000-0000-4000-8000-00000000000a";
const SEED = "a2000000-0000-4000-8000-00000000000a";
const DOMAIN_A = "b0000000-0000-4000-8000-00000000000b";
const DOMAIN_B = "c0000000-0000-4000-8000-00000000000c";
const SOURCE_ROOM = "d0000000-0000-4000-8000-00000000000d";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function occurrence(
  taskId: string = TASK,
  taskRunId: string = RUN,
): ProtectedTaskOccurrence {
  return Object.freeze({
    task: Object.freeze({
      id: taskId,
      ownerId: OWNER,
      requestorId: REQUESTOR,
      agentId: AGENT,
      callingRoomId: ROOM,
      scheduleKind: "now" as const,
      contentRepresentation: "protected" as const,
      contentNamespaceId: CONTENT,
      contentRevision: 3,
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1({
        kind: "definition",
        taskId,
        contentRevision: 3,
      }),
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: bytes(8),
    }),
    run: Object.freeze({
      id: taskRunId,
      taskId,
      jobId: null,
      graphThreadId: `subagent:task:${taskId}:${taskRunId}`,
      status: "awaiting" as const,
      startedAt: new Date(NOW - 1_000),
    }),
  });
}

function predispatch(value: ProtectedTaskOccurrence): ProtectedTaskPredispatchPlan {
  return Object.freeze({
    occurrence: value,
    scheduling: Object.freeze({
      ownerId: OWNER,
      requestorId: REQUESTOR,
      agentId: AGENT,
      roomId: ROOM,
      callingRoomId: ROOM,
      graphThreadId: value.run.graphThreadId,
    }),
    target: Object.freeze({ roomId: ROOM, targetUserIds: Object.freeze([REQUESTOR]) }),
    memory: Object.freeze({
      mode: "namespace" as const,
      authorityStatus: "exact" as const,
      provenance: "target_users_namespace" as const,
      envelope: Object.freeze({
        memoryMode: "namespace" as const,
        ownerId: REQUESTOR,
        actorId: HUMAN,
        agentId: AGENT,
        roomId: ROOM,
        readableNamespaces: [READABLE, CONTENT],
        mutableNamespaces: [CONTENT],
        writableNamespaces: [CONTENT],
        toolPolicy: {},
      }),
    }),
  });
}

function facts(): readonly ProtectedTaskRuntimeNamespaceAuthorityFact[] {
  return Object.freeze([
    Object.freeze({
      namespaceId: READABLE,
      domainId: DOMAIN_A,
      expectedAccessRevision: 2,
      expectedPolicyRevision: 7,
      expectedDomainEpoch: 5,
      expectedAuthorizationRevision: 9,
    }),
    Object.freeze({
      namespaceId: CONTENT,
      domainId: DOMAIN_B,
      expectedAccessRevision: 3,
      expectedPolicyRevision: 7,
      expectedDomainEpoch: 6,
      expectedAuthorizationRevision: 10,
    }),
  ]);
}

function memoryPolicy() {
  return Object.freeze({
    mode: "encrypted_only" as const,
    shadowBehavior: "strict" as const,
    revision: 7,
  });
}

function domain(
  domainId: string,
  sourceNamespaceId: string,
  generation: number,
  revision: number,
): DomainForegroundAuthorityEntry {
  return Object.freeze({
    domainId,
    sourceNamespaceId,
    participantDigest: bytes(1),
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: generation,
    authorizationRevision: authorizationRevision(revision),
    headDigest: bytes(2),
    activeNamespaceBindingSetDigest: bytes(3),
    activeNamespaceBindingCount: 1,
  });
}

function outputPorts(namespaceId: string = CONTENT) {
  return {
    resolveOutputDestination: async () => ({ roomId: ROOM, namespaceId }),
    acceptOutputBinding: async (input: Readonly<{
      taskId: string;
      taskRunId: string;
      requiredPolicyRevision: number;
      acceptedAt: Date;
    }>) => ({
      status: "accepted" as const,
      binding: {
        taskRunId: input.taskRunId,
        bindingId: `task-run-output:${input.taskRunId}`,
        deliveryMode: "wake" as const,
        destinationRoomId: ROOM,
        destinationNamespaceId: namespaceId,
        resultOperationId: `task-run-result:${input.taskRunId}`,
        resultObjectId: deriveTaskContentCryptoObjectIdV1({
          kind: "run_result", taskId: input.taskId,
          taskRunId: input.taskRunId, contentRevision: 1,
        }),
        messageOperationId: null,
        wakeOperationId: `task-run-delivery-wake:${input.taskRunId}`,
        acceptedPolicyRevision: input.requiredPolicyRevision,
        acceptedAt: input.acceptedAt,
        resultTerminalAt: null,
        resultAttachedAt: null,
        messageId: null,
        messagePublishedAt: null,
        wakeJobId: null,
        wakeScheduledAt: null,
        completedAt: null,
      },
    }),
  };
}

function builder(
  authorityFacts: readonly ProtectedTaskRuntimeNamespaceAuthorityFact[] = facts(),
  sourceNamespaceId: string = CONTENT,
  sourceRoomId: string = SOURCE_ROOM,
) {
  const crypto = new LatticeCrypto();
  const executor = async function* () { yield* []; };
  const openTransientInput = async () => ({ message: "opened" });
  const publishResult = async () => {};
  const startProtectedTaskRun = async () => ({ status: "started" as const });
  return createProtectedTaskRuntimeGrantPlanBuilder({
    crypto,
    recipientTtlMs: 60_000,
    now: () => NOW,
    predispatch: async value => predispatch(value),
    ...outputPorts(),
    resolveNamespaceAuthority: async ({ namespaceIds }) => {
      expect(namespaceIds).toEqual([CONTENT, READABLE].sort());
      return {
        sourceRoomId,
        sourceNamespaceId,
        policy: memoryPolicy(),
        facts: authorityFacts,
      };
    },
    prepareExecution: async () => ({ executor, openTransientInput }),
    startProtectedTaskRun,
    publishResult,
  });
}

test("builds an exact dark V3 plan from the predispatch Namespace inventory", async () => {
  const value = occurrence();
  const plan = await builder()(value);
  expect(plan.initialRecord.snapshot).toMatchObject({
    formatVersion: 3,
    requestId: `task-run-authorization:${RUN}`,
    workId: RUN,
    namespaceId: CONTENT,
    state: "awaiting_recipient",
  });
  expect(plan.initialRecord.authoritySet.namespaceRequirements).toEqual([
    expect.objectContaining({
      ordinal: 0,
      namespaceId: CONTENT,
      operations: ["decrypt", "encrypt"],
      expectedAccessRevision: 3,
    }),
    expect.objectContaining({
      ordinal: 1,
      namespaceId: READABLE,
      operations: ["decrypt"],
      expectedAccessRevision: 2,
    }),
  ]);
  expect(plan.reference).toMatchObject({
    kind: "protected_task_run_v1",
    taskId: TASK,
    taskRunId: RUN,
    inputObjectId: value.task.cryptoObjectId,
    authorizationRequestId: `task-run-authorization:${RUN}`,
    policyRevision: 7,
    executionSegment: 1,
  });
  expect(plan.scheduling.roomId).toBe(ROOM);
  expect(plan.stableIdentity).toMatchObject({
    taskId: TASK,
    taskRunId: RUN,
    ownerId: OWNER,
    requestorId: REQUESTOR,
    agentId: AGENT,
    sourceRoomId: SOURCE_ROOM,
    targetRoomId: ROOM,
    targetUserIds: [REQUESTOR],
    outputRoomId: ROOM,
    outputNamespaceId: CONTENT,
    memoryMode: "namespace",
    scopeId: null,
    contentObjectId: value.task.cryptoObjectId,
  });
  expect(plan.initialRecord.idempotencyKey)
    .toMatch(/^task-runtime-stable-v1:/u);

  const recipient = plan.recipientAttempt({ record: plan.initialRecord, now: NOW });
  const attempt = Object.freeze({
    requestId: plan.initialRecord.snapshot.requestId,
    workId: RUN,
    recipientGeneration: 0,
    recipientKeyId: recipient.recipientKeyId,
    recipientPublicKey: new Uint8Array(65).fill(4),
    expiresAt: recipient.expiresAt,
  });
  const request = plan.buildRequest({
    record: plan.initialRecord,
    attempt,
    binding: { userId: REQUESTOR, humanActorId: HUMAN, deviceId: DEVICE },
    authority: {
      device: {
        userId: REQUESTOR,
        humanActorId: HUMAN,
        deviceId: DEVICE,
        deviceGeneration: 2,
        securityRevision: 3,
      } as never,
      sourceRoomId: SOURCE_ROOM,
      policyRevision: 7,
      namespaceRequirements: plan.initialRecord.authoritySet.namespaceRequirements,
      domains: Object.freeze([
        domain(DOMAIN_A, READABLE, 5, 9),
        domain(DOMAIN_B, CONTENT, 6, 10),
      ]),
    },
  });
  expect(decodeTaskRuntimeBackgroundAuthorizationRequestV1(
    encodeTaskRuntimeBackgroundAuthorizationRequestV1(request),
  )).not.toBeNull();
  const authorization = parseDomainForegroundAuthorizationPlanV2(
    request.authorizationPlanBytes,
  );
  expect(authorization).toMatchObject({
    authorizationId: `task-run-authorization:${RUN}`,
    sessionId: `task-run:${RUN}`,
    roomId: SOURCE_ROOM,
    recipientKeyId: recipient.recipientKeyId,
    domainCount: 2,
  });
});

test("commits stable Task identity while excluding current authority epochs", async () => {
  const value = occurrence();
  const initial = await builder()(value);
  const refreshed = await builder(facts().map(fact => ({
    ...fact,
    expectedAccessRevision: fact.expectedAccessRevision + 10,
    expectedDomainEpoch: fact.expectedDomainEpoch + 10,
    expectedAuthorizationRevision: fact.expectedAuthorizationRevision + 10,
  })))(value);
  expect(refreshed.initialRecord.idempotencyKey)
    .toBe(initial.initialRecord.idempotencyKey);
  expect(refreshed.initialRecord.workIdentityHash)
    .not.toEqual(initial.initialRecord.workIdentityHash);

  const changedSource = await builder(facts(), CONTENT, ROOM)(value);
  expect(changedSource.initialRecord.idempotencyKey)
    .not.toBe(initial.initialRecord.idempotencyKey);

  const expectedNamespaceHash = createHash("sha256").update(JSON.stringify({
    taskId: value.task.id,
    taskRunId: value.run.id,
    scheduleKind: value.task.scheduleKind,
    sourceRoomId: SOURCE_ROOM,
    targetRoomId: ROOM,
    outputRoomId: ROOM,
    outputNamespaceId: CONTENT,
    targetUserIds: [REQUESTOR],
    memoryMode: "namespace",
    scopeId: null,
    inputObjectId: value.task.cryptoObjectId,
    contentRevision: value.task.contentRevision,
    fingerprint: Buffer.from(value.task.cryptoRequiredNamespaceFingerprint)
      .toString("base64url"),
    policyRevision: initial.initialRecord.expectedPolicyRevision,
    namespaces: initial.initialRecord.authoritySet.namespaceRequirements,
    domains: initial.initialRecord.authoritySet.domainRequirements,
  })).digest();
  expect(initial.initialRecord.workIdentityHash).toEqual(expectedNamespaceHash);
});

test("binds distinct per-occurrence executors and transient openers", async () => {
  const first = occurrence();
  const second = occurrence(TASK_TWO, RUN_TWO);
  const firstExecutor = async function* () { yield* []; };
  const secondExecutor = async function* () { yield* []; };
  const firstOpener = async () => ({ message: "first" });
  const secondOpener = async () => ({ message: "second" });
  const prepared: string[] = [];
  const build = createProtectedTaskRuntimeGrantPlanBuilder({
    crypto: new LatticeCrypto(),
    recipientTtlMs: 60_000,
    now: () => NOW,
    predispatch: async value => predispatch(value),
    ...outputPorts(),
    resolveNamespaceAuthority: async () => ({
      sourceRoomId: SOURCE_ROOM,
      sourceNamespaceId: CONTENT,
      policy: memoryPolicy(),
      facts: facts(),
    }),
    prepareExecution: async ({
      occurrence: value,
      predispatch: plan,
      policy,
      reference,
    }) => {
      expect(plan.occurrence).toBe(value);
      expect(plan.target.roomId).toBe(ROOM);
      expect(policy).toEqual(memoryPolicy());
      expect(reference).toMatchObject({
        taskId: value.task.id,
        taskRunId: value.run.id,
        policyRevision: 7,
        executionSegment: 1,
      });
      prepared.push(value.run.id);
      return value.run.id === RUN
        ? { executor: firstExecutor, openTransientInput: firstOpener }
        : {
            executor: secondExecutor,
            openTransientInput: secondOpener,
            modelAttribution: "external" as const,
          };
    },
    startProtectedTaskRun: async () => ({ status: "started" }),
    publishResult: async () => {},
  });

  const [firstPlan, secondPlan] = await Promise.all([
    build(first),
    build(second),
  ]);
  expect(prepared.sort()).toEqual([RUN, RUN_TWO].sort());
  expect(firstPlan.executor).toBe(firstExecutor);
  expect(firstPlan.openTransientInput).toBe(firstOpener);
  expect(firstPlan.modelAttribution).toBeUndefined();
  expect(secondPlan.executor).toBe(secondExecutor);
  expect(secondPlan.openTransientInput).toBe(secondOpener);
  expect(secondPlan.modelAttribution).toBe("external");
});

test("refuses substituted predispatch before execution preparation", async () => {
  const value = occurrence();
  const substituted = occurrence(TASK_TWO, RUN_TWO);
  let preparationCalls = 0;
  const build = createProtectedTaskRuntimeGrantPlanBuilder({
    crypto: new LatticeCrypto(),
    recipientTtlMs: 60_000,
    predispatch: async () => predispatch(substituted),
    ...outputPorts(),
    resolveNamespaceAuthority: async () => ({
      sourceRoomId: SOURCE_ROOM,
      sourceNamespaceId: CONTENT,
      policy: memoryPolicy(),
      facts: facts(),
    }),
    prepareExecution: async () => {
      preparationCalls += 1;
      return {
        executor: async function* () { yield* []; },
        openTransientInput: async () => ({}),
      };
    },
    startProtectedTaskRun: async () => ({ status: "started" }),
    publishResult: async () => {},
  });

  // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
  await expect(build(value)).rejects.toThrow(
    "predispatch substituted its occurrence",
  );
  expect(preparationCalls).toBe(0);
});

test("fails closed on incomplete authority and substituted current authority", async () => {
  expect(builder(facts(), READABLE)(occurrence())).rejects.toThrow(
    "source Room authority is unavailable",
  );
  expect(builder(facts().slice(0, 1))(occurrence())).rejects.toThrow(
    "Namespace authority inventory is incomplete",
  );

  const plan = await builder()(occurrence());
  const recipient = plan.recipientAttempt({ record: plan.initialRecord, now: NOW });
  expect(() => plan.buildRequest({
    record: plan.initialRecord,
    attempt: {
      requestId: plan.initialRecord.snapshot.requestId,
      workId: RUN,
      recipientGeneration: 0,
      recipientKeyId: recipient.recipientKeyId,
      recipientPublicKey: new Uint8Array(65).fill(4),
      expiresAt: recipient.expiresAt,
    },
    binding: { userId: REQUESTOR, humanActorId: HUMAN, deviceId: DEVICE },
    authority: {
      device: {
        userId: REQUESTOR,
        humanActorId: HUMAN,
        deviceId: DEVICE,
        deviceGeneration: 2,
        securityRevision: 3,
      } as never,
      sourceRoomId: ROOM,
      policyRevision: 8,
      namespaceRequirements: plan.initialRecord.authoritySet.namespaceRequirements,
      domains: [],
    },
  })).toThrow("request authority is not exact");
});

test("keeps object access revision independent from Namespace access revision", async () => {
  const value = occurrence();
  const plan = await builder()(value);
  expect(value.task.cryptoAccessRevision).toBe(0);
  expect(plan.initialRecord.expectedNamespaceAccessRevision).toBe(3);

  const substituted: ProtectedTaskOccurrence = Object.freeze({
    ...value,
    task: Object.freeze({ ...value.task, cryptoAccessRevision: 3 }),
  });
  // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
  await expect(builder()(substituted)).rejects.toThrow(
    "definition coordinates are invalid",
  );
});

test("includes the exact Scope origin and distinct output Namespaces", async () => {
  const value = occurrence();
  const outputFact = {
    namespaceId: OUTPUT,
    domainId: "c1000000-0000-4000-8000-00000000000c",
    expectedAccessRevision: 4,
    expectedPolicyRevision: 7,
    expectedDomainEpoch: 3,
    expectedAuthorizationRevision: 11,
  };
  const scopeEnvelope: ScopeMemoryEnvelopeWithOrigin = {
    memoryMode: "scope",
    ownerId: REQUESTOR,
    actorId: HUMAN,
    agentId: AGENT,
    roomId: ROOM,
    scopeId: "e0000000-0000-4000-8000-00000000000e",
    originWritableNamespaceId: READABLE,
    toolPolicy: {},
  };
  const scopeMemory = Object.freeze({
    scopeId: scopeEnvelope.scopeId,
    memoryRoomId: scopeEnvelope.roomId,
    originWritableNamespaceId: READABLE,
    readableNamespaceIds: Object.freeze([READABLE, SEED].sort()),
  });
  const seedFact = {
    namespaceId: SEED,
    domainId: "c2000000-0000-4000-8000-00000000000c",
    expectedAccessRevision: 5,
    expectedPolicyRevision: 7,
    expectedDomainEpoch: 4,
    expectedAuthorizationRevision: 12,
  };
  const scoped: ProtectedTaskPredispatchPlan = {
    ...predispatch(value),
    memory: {
      mode: "scope",
      authorityStatus: "exact",
      provenance: "scope_existing",
      // The initial grant fixes current Scope origin, seed, and Task content
      // inventory. Later Scope growth acquires separate operation-time authority.
      envelope: scopeEnvelope,
    },
  };
  let scopeWorkIdentityDigest: Uint8Array | undefined;
  const plan = await createProtectedTaskRuntimeGrantPlanBuilder({
    crypto: new LatticeCrypto(),
    recipientTtlMs: 60_000,
    now: () => NOW,
    predispatch: async () => scoped,
    ...outputPorts(OUTPUT),
    resolveScopeMemoryInventory: async ({ occurrence: current, predispatch: plan }) => {
      expect(current).toBe(value);
      expect(plan).toBe(scoped);
      return scopeMemory;
    },
    resolveNamespaceAuthority: async ({ namespaceIds, scopeMemory: binding }) => {
      expect(namespaceIds).toEqual([CONTENT, READABLE, OUTPUT, SEED].sort());
      expect(binding).toEqual(scopeMemory);
      return {
        sourceRoomId: SOURCE_ROOM,
        sourceNamespaceId: CONTENT,
        policy: memoryPolicy(),
        facts: [...facts(), outputFact, seedFact],
      };
    },
    prepareExecution: async ({ scopeMemory: binding, scopeWorkIdentity }) => {
      expect(binding).toEqual(scopeMemory);
      expect(typeof scopeWorkIdentity).toBe("string");
      scopeWorkIdentityDigest = createHash("sha256").update(scopeWorkIdentity!).digest();
      const committed = JSON.parse(scopeWorkIdentity!) as { scopeMemory: unknown };
      expect(committed.scopeMemory).toEqual(scopeMemory);
      return {
        executor: async function* () { yield* []; },
        openTransientInput: async () => ({}),
      };
    },
    startProtectedTaskRun: async () => ({ status: "started" }),
    publishResult: async () => {},
  })(value);

  expect(plan.initialRecord.authoritySet.namespaceRequirements).toEqual([
    expect.objectContaining({ namespaceId: CONTENT, operations: ["decrypt", "encrypt"] }),
    expect.objectContaining({ namespaceId: READABLE, operations: ["decrypt", "encrypt"] }),
    expect.objectContaining({ namespaceId: OUTPUT, operations: ["decrypt", "encrypt"] }),
    expect.objectContaining({ namespaceId: SEED, operations: ["decrypt"] }),
  ]);
  expect(plan.stableIdentity).toMatchObject({
    memoryMode: "scope",
    scopeId: scopeEnvelope.scopeId,
  });
  expect(plan.scopeMemory).toEqual(scopeMemory);
  expect(scopeWorkIdentityDigest).toEqual(plan.initialRecord.workIdentityHash);

  const reduced = await createProtectedTaskRuntimeGrantPlanBuilder({
    crypto: new LatticeCrypto(),
    recipientTtlMs: 60_000,
    now: () => NOW,
    predispatch: async () => scoped,
    ...outputPorts(OUTPUT),
    resolveScopeMemoryInventory: async () => ({
      ...scopeMemory,
      readableNamespaceIds: [READABLE],
    }),
    resolveNamespaceAuthority: async () => ({
      sourceRoomId: SOURCE_ROOM,
      sourceNamespaceId: CONTENT,
      policy: memoryPolicy(),
      facts: [...facts(), outputFact],
    }),
    prepareExecution: async () => ({
      executor: async function* () { yield* []; },
      openTransientInput: async () => ({}),
    }),
    startProtectedTaskRun: async () => ({ status: "started" }),
    publishResult: async () => {},
  })(value);
  expect(reduced.initialRecord.idempotencyKey)
    .toBe(plan.initialRecord.idempotencyKey);
  expect(reduced.initialRecord.workIdentityHash)
    .not.toEqual(plan.initialRecord.workIdentityHash);
});

test("requires and pins an exact Scope inventory", async () => {
  const value = occurrence();
  const scopeEnvelope: ScopeMemoryEnvelopeWithOrigin = {
    memoryMode: "scope",
    ownerId: REQUESTOR,
    actorId: HUMAN,
    agentId: AGENT,
    roomId: ROOM,
    scopeId: "e0000000-0000-4000-8000-00000000000e",
    originWritableNamespaceId: READABLE,
    toolPolicy: {},
  };
  const scoped: ProtectedTaskPredispatchPlan = {
    ...predispatch(value),
    memory: {
      mode: "scope",
      authorityStatus: "exact",
      provenance: "scope_existing",
      envelope: scopeEnvelope,
    },
  };
  const base = {
    crypto: new LatticeCrypto(),
    recipientTtlMs: 60_000,
    now: () => NOW,
    predispatch: async () => scoped,
    ...outputPorts(),
    resolveNamespaceAuthority: async () => ({
      sourceRoomId: SOURCE_ROOM,
      sourceNamespaceId: CONTENT,
      policy: memoryPolicy(),
      facts: facts(),
    }),
    prepareExecution: async () => ({
      executor: async function* () { yield* []; },
      openTransientInput: async () => ({}),
    }),
    startProtectedTaskRun: async () => ({ status: "started" as const }),
    publishResult: async () => {},
  };
  await Promise.resolve(
    expect(createProtectedTaskRuntimeGrantPlanBuilder(base)(value))
      .rejects.toThrow("inventory resolver is unavailable"),
  );

  let namespaceAuthorityUses = 0;
  await Promise.resolve(expect(createProtectedTaskRuntimeGrantPlanBuilder({
    ...base,
    resolveScopeMemoryInventory: async () => ({
      scopeId: scopeEnvelope.scopeId,
      memoryRoomId: SOURCE_ROOM,
      originWritableNamespaceId: READABLE,
      readableNamespaceIds: [READABLE],
    }),
    resolveNamespaceAuthority: async () => {
      namespaceAuthorityUses += 1;
      return {
        sourceRoomId: SOURCE_ROOM,
        sourceNamespaceId: CONTENT,
        policy: memoryPolicy(),
        facts: facts(),
      };
    },
  })(value)).rejects.toThrow("inventory is not exact"));
  expect(namespaceAuthorityUses).toBe(0);
});

test("grants decrypt and encrypt only to the exact distinct output Namespace", async () => {
  const extra = {
    namespaceId: OUTPUT,
    domainId: "c1000000-0000-4000-8000-00000000000c",
    expectedAccessRevision: 4,
    expectedPolicyRevision: 7,
    expectedDomainEpoch: 3,
    expectedAuthorizationRevision: 11,
  };
  const value = occurrence();
  const plan = await createProtectedTaskRuntimeGrantPlanBuilder({
    crypto: new LatticeCrypto(),
    recipientTtlMs: 60_000,
    now: () => NOW,
    predispatch: async () => predispatch(value),
    ...outputPorts(OUTPUT),
    resolveNamespaceAuthority: async ({ namespaceIds }) => {
      expect(namespaceIds).toEqual([CONTENT, READABLE, OUTPUT].sort());
      return {
        sourceRoomId: SOURCE_ROOM,
        sourceNamespaceId: CONTENT,
        policy: memoryPolicy(),
        facts: [...facts(), extra],
      };
    },
    prepareExecution: async () => ({
      executor: async function* () { yield* []; },
      openTransientInput: async () => ({}),
    }),
    startProtectedTaskRun: async () => ({ status: "started" }),
    publishResult: async () => {},
  })(value);
  const output = plan.initialRecord.authoritySet.namespaceRequirements.find(
    entry => entry.namespaceId === OUTPUT,
  );
  const readable = plan.initialRecord.authoritySet.namespaceRequirements.find(
    entry => entry.namespaceId === READABLE,
  );
  expect(output?.operations).toEqual(["decrypt", "encrypt"]);
  expect(readable?.operations).toEqual(["decrypt"]);
});

test("keeps decrypt and encrypt on an output Namespace shared with Task content", async () => {
  const plan = await builder()(occurrence());
  const content = plan.initialRecord.authoritySet.namespaceRequirements.find(
    entry => entry.namespaceId === CONTENT,
  );
  const readable = plan.initialRecord.authoritySet.namespaceRequirements.find(
    entry => entry.namespaceId === READABLE,
  );
  expect(content?.operations).toEqual(["decrypt", "encrypt"]);
  expect(readable?.operations).toEqual(["decrypt"]);
});

test("requires concrete execution and publication sinks", () => {
  expect(() => createProtectedTaskRuntimeGrantPlanBuilder({
    crypto: new LatticeCrypto(),
    recipientTtlMs: 60_000,
    predispatch: async (value: ProtectedTaskOccurrence) => predispatch(value),
    ...outputPorts(),
    resolveNamespaceAuthority: async () => ({
      sourceRoomId: SOURCE_ROOM,
      sourceNamespaceId: CONTENT,
      policy: memoryPolicy(),
      facts: facts(),
    }),
    prepareExecution: undefined,
    startProtectedTaskRun: async () => ({ status: "started" as const }),
    publishResult: async () => {},
  } as never)).toThrow("execution sink is unavailable");
});
