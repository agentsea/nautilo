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

function builder(
  authorityFacts: readonly ProtectedTaskRuntimeNamespaceAuthorityFact[] = facts(),
  sourceNamespaceId: string = CONTENT,
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
    resolveNamespaceAuthority: async ({ namespaceIds }) => {
      expect(namespaceIds).toEqual([CONTENT, READABLE].sort());
      return {
        sourceRoomId: SOURCE_ROOM,
        sourceNamespaceId,
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
  });
  expect(plan.scheduling.roomId).toBe(ROOM);

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
    resolveNamespaceAuthority: async () => ({
      sourceRoomId: SOURCE_ROOM,
      sourceNamespaceId: CONTENT,
      facts: facts(),
    }),
    prepareExecution: async ({ occurrence: value, predispatch: plan }) => {
      expect(plan.occurrence).toBe(value);
      expect(plan.target.roomId).toBe(ROOM);
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
    resolveNamespaceAuthority: async () => ({
      sourceRoomId: SOURCE_ROOM,
      sourceNamespaceId: CONTENT,
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

test("includes the exact Scope origin Namespace in the grant inventory", async () => {
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
      // Dynamic retained Scope reads acquire their own operation-time
      // authority; the initial grant binds only this proven origin + content.
      envelope: scopeEnvelope,
    },
  };
  const plan = await createProtectedTaskRuntimeGrantPlanBuilder({
    crypto: new LatticeCrypto(),
    recipientTtlMs: 60_000,
    now: () => NOW,
    predispatch: async () => scoped,
    resolveNamespaceAuthority: async ({ namespaceIds }) => {
      expect(namespaceIds).toEqual([CONTENT, READABLE].sort());
      return {
        sourceRoomId: SOURCE_ROOM,
        sourceNamespaceId: CONTENT,
        facts: facts(),
      };
    },
    prepareExecution: async () => ({
      executor: async function* () { yield* []; },
      openTransientInput: async () => ({}),
    }),
    startProtectedTaskRun: async () => ({ status: "started" }),
    publishResult: async () => {},
  })(value);

  expect(plan.initialRecord.authoritySet.namespaceRequirements).toEqual([
    expect.objectContaining({ namespaceId: CONTENT, operations: ["decrypt", "encrypt"] }),
    expect.objectContaining({ namespaceId: READABLE, operations: ["decrypt", "encrypt"] }),
  ]);
});

test("requires concrete execution and publication sinks", () => {
  expect(() => createProtectedTaskRuntimeGrantPlanBuilder({
    crypto: new LatticeCrypto(),
    recipientTtlMs: 60_000,
    predispatch: async (value: ProtectedTaskOccurrence) => predispatch(value),
    resolveNamespaceAuthority: async () => ({
      sourceRoomId: SOURCE_ROOM,
      sourceNamespaceId: CONTENT,
      facts: facts(),
    }),
    prepareExecution: undefined,
    startProtectedTaskRun: async () => ({ status: "started" as const }),
    publishResult: async () => {},
  } as never)).toThrow("execution sink is unavailable");
});
