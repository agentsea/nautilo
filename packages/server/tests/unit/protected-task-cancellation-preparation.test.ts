import { expect, test } from "bun:test";
import {
  prepareProtectedTaskCancellationOutput,
  type DirectDatabase,
  type ProtectedTaskCancellationOutputAuthority,
  type ProtectedTaskCancellationOutputIntent,
} from "@nautilo/db";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  attachBackgroundAuthorizationRecipient,
  claimTaskRuntimeBackgroundAuthorizationRequest,
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  InMemoryBackgroundAuthorizationRepository,
  markBackgroundAuthorizationGrantReady,
  markBackgroundAuthorizationRunning,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";
import {
  createProtectedTaskCancellationPreparation,
} from "../../src/routes/protected-task-cancellation-preparation";
import {
  createProtectedTaskCancellationPlan,
  protectedTaskCancellationRequestId,
} from "../../src/routes/protected-task-cancellation-plan";

const NOW = 1_800_500_000_000;
const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const TASK = "40000000-0000-4000-8000-000000000004";
const RUN = "50000000-0000-4000-8000-000000000005";
const ROOM = "60000000-0000-4000-8000-000000000006";
const NAMESPACE = "70000000-0000-4000-8000-000000000007";
const DOMAIN = "80000000-0000-4000-8000-000000000008";

const intent: ProtectedTaskCancellationOutputIntent = Object.freeze({
  taskId: TASK,
  taskRunId: RUN,
  requesterUserId: USER,
  agentId: AGENT,
  contentNamespaceId: NAMESPACE,
  representation: "protected",
  resultRevision: 2,
  resultOperationId: `task-run-cancelled-result:${RUN}`,
  resultObjectId: deriveTaskContentCryptoObjectIdV1({
    kind: "run_result",
    taskId: TASK,
    taskRunId: RUN,
    contentRevision: 2,
  }),
  policyRevision: 7,
  taskStatus: "cancelled",
  runStatus: "cancelled",
  terminalAt: new Date(NOW - 1_000),
});

type CancellationNamespaceAuthority = Parameters<
  typeof createProtectedTaskCancellationPlan
>[0]["namespaceAuthority"];

const authority: CancellationNamespaceAuthority = Object.freeze({
  sourceRoomId: ROOM,
  sourceNamespaceId: NAMESPACE,
  facts: Object.freeze([Object.freeze({
    namespaceId: NAMESPACE,
    domainId: DOMAIN,
    expectedAccessRevision: 3,
    expectedPolicyRevision: 7,
    expectedDomainEpoch: 5,
    expectedAuthorizationRevision: 11,
  })]),
});
const priorAuthority: CancellationNamespaceAuthority = Object.freeze({
  sourceRoomId: ROOM,
  sourceNamespaceId: NAMESPACE,
  facts: Object.freeze([Object.freeze({
    namespaceId: NAMESPACE,
    domainId: DOMAIN,
    expectedAccessRevision: 2,
    expectedPolicyRevision: 7,
    expectedDomainEpoch: 4,
    expectedAuthorizationRevision: 10,
  })]),
});

function intentAtPolicy(policyRevision: number): ProtectedTaskCancellationOutputIntent {
  return Object.freeze({ ...intent, policyRevision });
}

function authorityAtPolicy(policyRevision: number): CancellationNamespaceAuthority {
  return Object.freeze({
    ...authority,
    facts: Object.freeze(authority.facts.map(fact => Object.freeze({
      ...fact,
      expectedPolicyRevision: policyRevision,
    }))) as CancellationNamespaceAuthority["facts"],
  });
}

function priorExecution(): BackgroundAuthorizationTaskRuntimeRecordV3 {
  return {
    snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({
      requestId: "prior_execution_request",
      workId: RUN,
      namespaceId: NAMESPACE,
      now: NOW - 10_000,
    }),
    workIdentityHash: new Uint8Array(32).fill(1),
    idempotencyKey:
      `task-runtime-stable-v1:${RUN}:${"a".repeat(43)}`,
    workKind: "task.execute",
    purpose: "task.execute",
    domainId: DOMAIN,
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 5,
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
        expectedEpoch: 5,
        expectedAuthorizationRevision: 11,
      }],
    },
  };
}

type Overrides = NonNullable<Parameters<
  typeof createProtectedTaskCancellationPreparation
>[1]>;

function fixture(input: Readonly<{
  repository?: InMemoryBackgroundAuthorizationRepository;
  jobAuthorizationRequestId?: string | null;
  afterSettlement?: "prepared" | "rejected";
  mode?: "plaintext_only" | "shadow_encryption" | "encrypted_only";
  now?: () => number;
  authorityOverride?: typeof authority;
  hasCancellationReservation?: boolean;
  cancellationPublication?: boolean | readonly boolean[];
  policyRevision?: number;
  refreshFromPolicyRevision?: number;
  authorizationRequested?: (requesterUserId: string) => void | Promise<void>;
  rollbackContentAuthority?: boolean;
}> = {}) {
  const repository = input.repository
    ?? new InMemoryBackgroundAuthorizationRepository();
  const deleted: Array<readonly [string, number]> = [];
  let prepares = 0;
  let publicationChecks = 0;
  let refreshGuardCalls = 0;
  let contentAuthorityHeld = false;
  const policyRevision = input.policyRevision ?? 7;
  const previous: ProtectedTaskCancellationOutputAuthority = {
    taskId: TASK,
    taskRunId: RUN,
    contentNamespaceId: NAMESPACE,
    jobAuthorizationRequestId: input.jobAuthorizationRequestId === undefined
      ? "prior_execution_request"
      : input.jobAuthorizationRequestId,
  };
  const prepareOutput: Overrides["prepareOutput"] = async (
    _db,
    _coordinates,
    settle,
    authorizePolicyRefresh,
  ) => {
    prepares += 1;
    if ((input.mode ?? "encrypted_only") !== "encrypted_only") {
      return { status: "rejected", reason: "authority_changed" };
    }
    const preparedIntent = intentAtPolicy(policyRevision);
    if (input.refreshFromPolicyRevision !== undefined) {
      refreshGuardCalls += 1;
      if (authorizePolicyRefresh === undefined || !await authorizePolicyRefresh({
        transaction: {} as never,
        previousIntent: intentAtPolicy(input.refreshFromPolicyRevision),
        nextIntent: preparedIntent,
      })) return { status: "rejected", reason: "not_ready" };
      return {
        status: "prepared",
        binding: {} as Extract<Awaited<ReturnType<
          typeof prepareProtectedTaskCancellationOutput
        >>, { status: "prepared" | "exact_replay" }>["binding"],
        intent: preparedIntent,
        previousAuthority: previous,
      };
    }
    if (!await settle(previous)) {
      return { status: "rejected", reason: "not_ready" };
    }
    if (input.afterSettlement === "rejected") {
      return { status: "rejected", reason: "conflict" };
    }
    return {
      status: prepares === 1 ? "prepared" : "exact_replay",
      binding: {} as Extract<Awaited<ReturnType<
        typeof prepareProtectedTaskCancellationOutput
      >>, { status: "prepared" | "exact_replay" }>["binding"],
      intent: preparedIntent,
      previousAuthority: previous,
    };
  };
  const overrides: Partial<Overrides> = {
    db: {} as DirectDatabase,
    crypto: new LatticeCrypto(),
    serverScope: "https://server.example",
    recipients: { delete: (requestId, generation) => {
      deleted.push([requestId, generation]);
      return true;
    } },
    recipientTtlMs: 60_000,
    now: input.now ?? (() => NOW),
    restricted: () => ({}) as ReturnType<NonNullable<Overrides["restricted"]>>,
    repository: async () => repository,
    readPolicy: async () => ({
      mode: input.mode ?? "encrypted_only",
      shadowBehavior: "strict",
      revision: policyRevision,
      shadowEncryptionStartedAt: new Date(NOW - 10_000),
      updatedAt: new Date(NOW - 10_000),
    }),
    prepareOutput,
    resolveRequesterHuman: async () => ({ id: HUMAN }),
    resolveRequesterPrivateRoom: async () => ({
      roomId: ROOM,
      namespaceId: NAMESPACE,
    }),
    productContext: async () => ({
      canonicalRunner: {},
      handle: {},
    }) as Awaited<ReturnType<NonNullable<Overrides["productContext"]>>>,
    inspectContentAuthority: async () => input.authorityOverride ?? authority,
    hasCancellationPublication: async () => {
      const publication = input.cancellationPublication;
      const selected = typeof publication === "boolean"
          || publication === undefined
        ? publication
        : publication[publicationChecks] ?? publication.at(-1);
      publicationChecks += 1;
      return selected ?? false;
    },
    hasCancellationReservation: async () =>
      input.hasCancellationReservation ?? false,
    readTaskId: async taskRunId => taskRunId === RUN ? TASK : null,
    validateCurrentIntent: async () => true,
    withContentAuthority: async operation => {
      if (!await operation.validateCurrentTaskRun({} as never, {} as never,
        {} as never)) return null;
      contentAuthorityHeld = true;
      try {
        const result = await operation.use(
          input.authorityOverride ?? authority,
          {} as never,
          {} as never,
          {} as never,
        );
        return input.rollbackContentAuthority ? null : result;
      } finally {
        contentAuthorityHeld = false;
      }
    },
  };
  const preparation = createProtectedTaskCancellationPreparation({
    recipients: overrides.recipients!,
    recipientTtlMs: 60_000,
    authorizationRequested: input.authorizationRequested,
  }, overrides);
  return {
    deleted,
    preparation,
    get prepares() {
      return prepares;
    },
    get publicationChecks() {
      return publicationChecks;
    },
    get refreshGuardCalls() {
      return refreshGuardCalls;
    },
    get contentAuthorityHeld() {
      return contentAuthorityHeld;
    },
    repository,
  };
}

test("settles linked execution authority before creating an encrypt-only cancellation request", async () => {
  const notifications: string[] = [];
  const value = fixture({ authorizationRequested: userId => {
    notifications.push(userId);
  } });
  const prior = priorExecution();
  await value.repository.create(prior);

  const prepared = await value.preparation.prepare({ taskId: TASK, taskRunId: RUN });
  expect(prepared.status).toBe("created");
  if (prepared.status !== "created") throw new Error("expected creation");
  expect(prepared.plan.initialRecord.workKind).toBe("task.cancel_result");
  expect(prepared.plan.initialRecord.purpose).toBe("task.cancel_result");
  expect(prepared.plan.initialRecord.idempotencyKey
    .startsWith("task-cancellation:")).toBe(true);
  expect((await value.repository.get(prior.snapshot.requestId))?.snapshot)
    .toMatchObject({ state: "cancelled", terminalReason: "cancelled" });
  expect(value.deleted).toContainEqual([prior.snapshot.requestId, 0]);
  const cancellation = await value.repository.get(
    protectedTaskCancellationRequestId(RUN),
  );
  expect(cancellation?.snapshot.state).toBe("awaiting_recipient");

  const replay = await value.preparation.prepare({ taskId: TASK, taskRunId: RUN });
  expect(replay.status).toBe("exact_replay");
  expect(notifications).toEqual([USER]);
  expect(cancellation?.snapshot.formatVersion).toBe(3);
  if (cancellation?.snapshot.formatVersion !== 3
    || cancellation.snapshot.credentialSubject.kind !== "runtime"
    || cancellation.snapshot.credentialSubject.runtimeKind !== "task"
    || cancellation.snapshot.credentialSubject.runtimeVersion !== 1) {
    throw new Error("expected cancellation record");
  }
  expect(await value.preparation.resolvePlan(
    cancellation as BackgroundAuthorizationTaskRuntimeRecordV3,
  )).not.toBeNull();
});

for (const existing of ["staged receipt", "bare ciphertext object"] as const) {
  test(`does not prepare or create authority when a ${existing} exists`, async () => {
    const value = fixture({ cancellationPublication: true });

    expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
      .toEqual({ status: "not_ready" });
    expect(value.prepares).toBe(0);
    expect(value.deleted).toEqual([]);
    expect(value.publicationChecks).toBe(1);
    expect(await value.repository.get(protectedTaskCancellationRequestId(RUN)))
      .toBeNull();
  });
}

test("does not create a request when publication appears after plan construction", async () => {
  const value = fixture({
    jobAuthorizationRequestId: null,
    cancellationPublication: [false, false, false, true],
  });

  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "not_ready" });
  expect(value.prepares).toBe(1);
  expect(value.deleted).toEqual([]);
  expect(value.publicationChecks).toBe(4);
  expect(await value.repository.get(protectedTaskCancellationRequestId(RUN)))
    .toBeNull();
});

test("does not settle or delete prior authority when publication appears under the stopped Run lock", async () => {
  const value = fixture({ cancellationPublication: [false, true] });
  const prior = priorExecution();
  await value.repository.create(prior);

  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "not_ready" });
  expect(await value.repository.get(prior.snapshot.requestId)).toEqual(prior);
  expect(value.deleted).toEqual([]);
  expect(value.publicationChecks).toBe(2);
  expect(await value.repository.get(protectedTaskCancellationRequestId(RUN)))
    .toBeNull();
});

test("does not reconstruct a reusable plan after cancellation publication", async () => {
  const plan = createProtectedTaskCancellationPlan({
    intent,
    namespaceAuthority: authority,
    crypto: new LatticeCrypto(),
    now: NOW,
    recipientTtlMs: 60_000,
  });
  const value = fixture({
    jobAuthorizationRequestId: null,
    cancellationPublication: true,
  });

  expect(await value.preparation.resolvePlan(plan.initialRecord)).toBeNull();
  expect(value.prepares).toBe(0);
  expect(value.deleted).toEqual([]);
  expect(value.publicationChecks).toBe(1);
});

function claimedCancellation(input: Readonly<{
  running?: boolean;
  claimExpiresAt?: number;
  namespaceAuthority?: typeof authority;
}> = {}): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const plan = createProtectedTaskCancellationPlan({
    intent,
    namespaceAuthority: input.namespaceAuthority ?? authority,
    crypto: new LatticeCrypto(),
    now: NOW,
    recipientTtlMs: 60_000,
  });
  const descriptorBytes = new Uint8Array([4, 5, 6]);
  const descriptorDigest = Buffer.from(
    new LatticeCrypto().hash(descriptorBytes),
  ).toString("hex");
  const recipient = {
    recipientGeneration: 0,
    recipientKeyId: `task-cancellation-runtime:${RUN}:0`,
    recipientPublicKey: Buffer.from(new Uint8Array(65).fill(7))
      .toString("base64url"),
    descriptorDigest,
    expiresAt: NOW + 60_000,
  };
  const awaiting = attachBackgroundAuthorizationRecipient(
    plan.initialRecord.snapshot,
    { ...recipient, now: NOW + 1 },
  );
  const responseBytes = new Uint8Array([8, 9]);
  const ready = markBackgroundAuthorizationGrantReady(awaiting, {
    ...recipient,
    kind: "runtime",
    requestId: plan.initialRecord.snapshot.requestId,
    responseDigest: Buffer.from(new LatticeCrypto().hash(responseBytes))
      .toString("hex"),
    credentialDigest: "22".repeat(32),
    issuingHumanId: HUMAN,
    issuingDeviceId: "90000000-0000-4000-8000-000000000009",
    now: NOW + 2,
  });
  const claimExpiresAt = input.claimExpiresAt ?? NOW + 10;
  const claimed = claimTaskRuntimeBackgroundAuthorizationRequest(ready, {
    claimId: "cancellation-claim",
    now: NOW + 3,
    requestDeadlineAt: claimExpiresAt,
    authorizationExpiresAt: claimExpiresAt,
  });
  return {
    ...plan.initialRecord,
    descriptorBytes,
    acceptedMaterial: {
      credentialId: "cancellation-credential",
      responseBytes,
      authorizationExpiresAt: claimExpiresAt,
      issuingDeviceAuthorizationRevision: 3,
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(10),
    },
    snapshot: (input.running
      ? markBackgroundAuthorizationRunning(claimed, NOW + 4)
      : claimed) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
  };
}

function recipientCancellation(
  expiresAt = NOW + 10,
): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const plan = createProtectedTaskCancellationPlan({
    intent,
    namespaceAuthority: authority,
    crypto: new LatticeCrypto(),
    now: NOW,
    recipientTtlMs: 60_000,
  });
  const descriptorBytes = new Uint8Array([1, 2, 3]);
  return {
    ...plan.initialRecord,
    snapshot: attachBackgroundAuthorizationRecipient(
      plan.initialRecord.snapshot,
      {
        recipientGeneration: 0,
        recipientKeyId: `task-cancellation-runtime:${RUN}:0`,
        recipientPublicKey: Buffer.from(new Uint8Array(65).fill(4))
          .toString("base64url"),
        descriptorDigest:
          "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
        expiresAt,
        now: NOW + 1,
      },
    ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    descriptorBytes,
  };
}

test("refreshes same-policy preclaim authority under the stopped Task lock", async () => {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const stalePlan = createProtectedTaskCancellationPlan({
    intent,
    namespaceAuthority: priorAuthority,
    crypto: new LatticeCrypto(),
    now: NOW,
    recipientTtlMs: 60_000,
  });
  await repository.create(stalePlan.initialRecord);
  const notifications: string[] = [];
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    authorizationRequested: userId => {
      expect(value.contentAuthorityHeld).toBe(false);
      notifications.push(userId);
    },
  });

  const result = await value.preparation.prepare({ taskId: TASK, taskRunId: RUN });
  expect(result.status).toBe("exact_replay");
  if (result.status !== "exact_replay") throw new Error("expected replay");
  expect(result.plan.initialRecord.expectedNamespaceAccessRevision).toBe(3);
  expect(result.plan.initialRecord.expectedDomainEpoch).toBe(5);
  expect(result.plan.initialRecord.authoritySet.domainRequirements[0]
    ?.expectedAuthorizationRevision).toBe(11);
  expect(await repository.get(stalePlan.initialRecord.snapshot.requestId))
    .toMatchObject({
      snapshot: {
        state: "awaiting_recipient",
        recipientGeneration: 1,
      },
      expectedNamespaceAccessRevision: 3,
      expectedDomainEpoch: 5,
      descriptorBytes: null,
      acceptedMaterial: null,
    });
  expect(value.deleted).toContainEqual([
    stalePlan.initialRecord.snapshot.requestId,
    0,
  ]);
  expect(notifications).toEqual([USER]);
  expect((await value.preparation.resolvePlan(stalePlan.initialRecord))
    ?.initialRecord.expectedNamespaceAccessRevision).toBe(3);
});

test("does not refresh a live claimed cancellation after authority drift", async () => {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const selected = claimedCancellation({
    namespaceAuthority: priorAuthority,
    claimExpiresAt: NOW + 100,
  });
  await repository.create(selected);
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    now: () => NOW + 50,
  });

  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "conflict" });
  expect(await repository.get(selected.snapshot.requestId)).toEqual(selected);
  expect(value.deleted).toEqual([]);
});

test("stops drift replacement when publication appears under the held authority", async () => {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const stalePlan = createProtectedTaskCancellationPlan({
    intent,
    namespaceAuthority: priorAuthority,
    crypto: new LatticeCrypto(),
    now: NOW,
    recipientTtlMs: 60_000,
  });
  await repository.create(stalePlan.initialRecord);
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    cancellationPublication: [false, false, false, false, true],
  });

  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "not_ready" });
  expect(await repository.get(stalePlan.initialRecord.snapshot.requestId))
    .toEqual(stalePlan.initialRecord);
  expect(value.deleted).toEqual([]);
  expect(value.publicationChecks).toBe(5);
});

test("rotates an expired claim then refreshes its same-policy authority", async () => {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const selected = claimedCancellation({
    running: true,
    namespaceAuthority: priorAuthority,
  });
  await repository.create(selected);
  const notifications: string[] = [];
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    now: () => NOW + 11,
    authorizationRequested: userId => {
      expect(value.contentAuthorityHeld).toBe(false);
      notifications.push(userId);
    },
  });

  const result = await value.preparation.prepare({ taskId: TASK, taskRunId: RUN });
  expect(result.status).toBe("exact_replay");
  if (result.status !== "exact_replay") throw new Error("expected replay");
  expect(result.plan.initialRecord.expectedNamespaceAccessRevision).toBe(3);
  expect(await repository.get(selected.snapshot.requestId)).toMatchObject({
    snapshot: {
      state: "awaiting_recipient",
      recipientGeneration: 2,
      retryCount: 1,
      lastRetryReason: "claim_expired",
      claimId: null,
      claimExpiresAt: null,
    },
    expectedNamespaceAccessRevision: 3,
    expectedDomainEpoch: 5,
    descriptorBytes: null,
    acceptedMaterial: null,
  });
  expect(value.deleted).toContainEqual([selected.snapshot.requestId, 0]);
  expect(notifications).toEqual([USER]);
});

test("does not refresh drifted authority after revision 2 was reserved", async () => {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const stalePlan = createProtectedTaskCancellationPlan({
    intent,
    namespaceAuthority: priorAuthority,
    crypto: new LatticeCrypto(),
    now: NOW,
    recipientTtlMs: 60_000,
  });
  await repository.create(stalePlan.initialRecord);
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    hasCancellationReservation: true,
  });

  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "not_ready" });
  expect(await repository.get(stalePlan.initialRecord.snapshot.requestId))
    .toEqual(stalePlan.initialRecord);
  expect(value.deleted).toEqual([]);
});

test("rotates an expired claimed cancellation only while revision 2 is absent", async () => {
  const clock = NOW + 11;
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const selected = claimedCancellation();
  await repository.create(selected);
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    now: () => clock,
  });

  expect((await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .status).toBe("exact_replay");
  expect((await repository.get(selected.snapshot.requestId))?.snapshot)
    .toMatchObject({
      state: "awaiting_recipient",
      recipientGeneration: 1,
      retryCount: 0,
      lastRetryReason: "claim_expired",
      claimId: null,
      claimExpiresAt: null,
    });
  expect(await repository.get(selected.snapshot.requestId)).toMatchObject({
    descriptorBytes: null,
    acceptedMaterial: null,
  });
  expect(value.deleted).toContainEqual([selected.snapshot.requestId, 0]);
});

test("does not rotate an expired claim when publication appears under the held authority", async () => {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const selected = claimedCancellation();
  await repository.create(selected);
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    now: () => NOW + 11,
    cancellationPublication: [false, false, false, false, true],
  });

  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "not_ready" });
  expect(await repository.get(selected.snapshot.requestId)).toEqual(selected);
  expect(value.deleted).toEqual([]);
  expect(value.publicationChecks).toBe(5);
});

test("rotates an expired running cancellation while revision 2 is absent", async () => {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const selected = claimedCancellation({ running: true });
  await repository.create(selected);
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    now: () => NOW + 11,
  });

  expect((await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .status).toBe("exact_replay");
  expect(await repository.get(selected.snapshot.requestId)).toMatchObject({
    snapshot: {
      state: "awaiting_recipient",
      recipientGeneration: 1,
      retryCount: 1,
      lastRetryReason: "claim_expired",
      claimId: null,
      claimExpiresAt: null,
    },
    descriptorBytes: null,
    acceptedMaterial: null,
  });
  expect(value.deleted).toContainEqual([selected.snapshot.requestId, 0]);
});

test("does not rotate expired running cancellation after revision 2 was reserved", async () => {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const selected = claimedCancellation({ running: true });
  await repository.create(selected);
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    now: () => NOW + 11,
    hasCancellationReservation: true,
  });

  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "not_ready" });
  expect((await repository.get(selected.snapshot.requestId))?.snapshot)
    .toEqual(selected.snapshot);
  expect(value.deleted).toEqual([]);
});

test("does not rotate a running cancellation with a live claim lease", async () => {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const selected = claimedCancellation({
    running: true,
    claimExpiresAt: NOW + 100,
  });
  await repository.create(selected);
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    now: () => NOW + 50,
  });

  expect((await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .status).toBe("exact_replay");
  expect((await repository.get(selected.snapshot.requestId))?.snapshot)
    .toEqual(selected.snapshot);
  expect(value.deleted).toEqual([]);
});

test("requires the stopped Job's linked request while deleting every settled recipient", async () => {
  const value = fixture({ jobAuthorizationRequestId: "missing_request" });
  const prior = priorExecution();
  await value.repository.create(prior);
  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "not_ready" });
  expect(value.deleted).toEqual([[prior.snapshot.requestId, 0]]);
  expect(await value.repository.get(protectedTaskCancellationRequestId(RUN)))
    .toBeNull();
});

test("keeps settled custody revoked when the product reservation later rejects", async () => {
  const value = fixture({ afterSettlement: "rejected" });
  const prior = priorExecution();
  await value.repository.create(prior);
  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "conflict" });
  expect(value.deleted).toEqual([[prior.snapshot.requestId, 0]]);
  expect((await value.repository.get(prior.snapshot.requestId))?.snapshot.state)
    .toBe("cancelled");
});

test("plaintext policy performs no cancellation preparation", async () => {
  const notifications: string[] = [];
  const value = fixture({
    mode: "plaintext_only",
    authorizationRequested: userId => {
      notifications.push(userId);
    },
  });
  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "inactive" });
  expect(value.prepares).toBe(0);
  expect(value.deleted).toEqual([]);
  expect(notifications).toEqual([]);
});

test("rotates an exact durably expired cancellation recipient under held content authority", async () => {
  let clock = NOW;
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const notifications: string[] = [];
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    now: () => clock,
    authorizationRequested: userId => {
      expect(value.contentAuthorityHeld).toBe(false);
      notifications.push(userId);
    },
  });
  const attached = recipientCancellation();
  await repository.create(attached);
  clock = NOW + 11;

  const prepared = await value.preparation.prepare({ taskId: TASK, taskRunId: RUN });
  expect(prepared.status).toBe("exact_replay");
  expect((await repository.get(attached.snapshot.requestId))?.snapshot)
    .toMatchObject({
      state: "awaiting_recipient",
      recipientGeneration: 1,
      lastRetryReason: "attempt_expired",
      recipient: null,
    });
  expect(value.deleted).toContainEqual([
    attached.snapshot.requestId,
    0,
  ]);
  expect(notifications).toEqual([USER]);
});

test("does not notify when held cancellation authority rolls back its rotation", async () => {
  let clock = NOW;
  const notifications: string[] = [];
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const attached = recipientCancellation();
  await repository.create(attached);
  clock = NOW + 11;
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    now: () => clock,
    rollbackContentAuthority: true,
    authorizationRequested: userId => {
      notifications.push(userId);
    },
  });

  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "not_ready" });
  expect(notifications).toEqual([]);
});

test("a rejecting cancellation notification does not change committed creation", async () => {
  const value = fixture({
    authorizationRequested: () => Promise.reject(new Error("offline")),
  });
  await value.repository.create(priorExecution());

  expect((await value.preparation.prepare({ taskId: TASK, taskRunId: RUN })).status)
    .toBe("created");
});

test("does not rotate an expired recipient when publication appears under the held authority", async () => {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const attached = recipientCancellation();
  await repository.create(attached);
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    now: () => NOW + 11,
    cancellationPublication: [false, false, false, false, true],
  });

  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "not_ready" });
  expect(await repository.get(attached.snapshot.requestId)).toEqual(attached);
  expect(value.deleted).toEqual([]);
  expect(value.publicationChecks).toBe(5);
});

test("refreshes a pristine old-policy binding and advances its unclaimed request generation", async () => {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const oldPlan = createProtectedTaskCancellationPlan({
    intent: intentAtPolicy(7),
    namespaceAuthority: authorityAtPolicy(7),
    crypto: new LatticeCrypto(),
    now: NOW,
    recipientTtlMs: 60_000,
  });
  await repository.create(oldPlan.initialRecord);
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    policyRevision: 8,
    refreshFromPolicyRevision: 7,
    authorityOverride: authorityAtPolicy(8),
  });

  const result = await value.preparation.prepare({ taskId: TASK, taskRunId: RUN });
  expect(result.status).toBe("exact_replay");
  expect(value.refreshGuardCalls).toBe(1);
  const refreshed = await repository.get(oldPlan.initialRecord.snapshot.requestId);
  expect(refreshed).toMatchObject({
    expectedPolicyRevision: 8,
    snapshot: {
      state: "awaiting_recipient",
      recipientGeneration: 1,
    },
    descriptorBytes: null,
    acceptedMaterial: null,
  });
  expect(refreshed?.authoritySet?.namespaceRequirements[0])
    .toMatchObject({ expectedPolicyRevision: 8, operations: ["encrypt"] });
  expect(value.deleted).toEqual([[oldPlan.initialRecord.snapshot.requestId, 0]]);
});

test("creates the current-policy request after recovering an old binding with no request", async () => {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    policyRevision: 8,
    refreshFromPolicyRevision: 7,
    authorityOverride: authorityAtPolicy(8),
  });

  const result = await value.preparation.prepare({ taskId: TASK, taskRunId: RUN });
  expect(result.status).toBe("created");
  expect(value.refreshGuardCalls).toBe(1);
  expect(await repository.get(protectedTaskCancellationRequestId(RUN)))
    .toMatchObject({
      expectedPolicyRevision: 8,
      snapshot: {
        state: "awaiting_recipient",
        recipientGeneration: 0,
      },
    });
  expect(value.deleted).toEqual([]);
});

test("waits without refreshing when the current policy mode is incompatible", async () => {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const oldPlan = createProtectedTaskCancellationPlan({
    intent: intentAtPolicy(7), namespaceAuthority: authorityAtPolicy(7),
    crypto: new LatticeCrypto(), now: NOW, recipientTtlMs: 60_000,
  });
  await repository.create(oldPlan.initialRecord);
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    mode: "shadow_encryption",
    policyRevision: 8,
    refreshFromPolicyRevision: 7,
    authorityOverride: authorityAtPolicy(8),
  });

  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "conflict" });
  expect(value.refreshGuardCalls).toBe(0);
  expect(await repository.get(oldPlan.initialRecord.snapshot.requestId))
    .toEqual(oldPlan.initialRecord);
  expect(value.deleted).toEqual([]);
});

test("does not refresh an old-policy binding while its claim is live", async () => {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const selected = claimedCancellation({ claimExpiresAt: NOW + 100 });
  await repository.create(selected);
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    now: () => NOW + 50,
    policyRevision: 8,
    refreshFromPolicyRevision: 7,
    authorityOverride: authorityAtPolicy(8),
  });

  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "not_ready" });
  expect(value.refreshGuardCalls).toBe(1);
  expect(await repository.get(selected.snapshot.requestId)).toEqual(selected);
  expect(value.deleted).toEqual([]);
});

test("does not refresh an old-policy binding for a foreign request", async () => {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const oldPlan = createProtectedTaskCancellationPlan({
    intent: intentAtPolicy(7), namespaceAuthority: authorityAtPolicy(7),
    crypto: new LatticeCrypto(), now: NOW, recipientTtlMs: 60_000,
  });
  const foreign = {
    ...oldPlan.initialRecord,
    purpose: "task.execute" as const,
    workKind: "task.execute" as const,
  };
  await repository.create(foreign);
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    policyRevision: 8,
    refreshFromPolicyRevision: 7,
    authorityOverride: authorityAtPolicy(8),
  });

  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "not_ready" });
  expect(value.refreshGuardCalls).toBe(1);
  expect(await repository.get(foreign.snapshot.requestId)).toEqual(foreign);
  expect(value.deleted).toEqual([]);
});

test("does not refresh an old-policy binding after ciphertext or a receipt appears", async () => {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const oldPlan = createProtectedTaskCancellationPlan({
    intent: intentAtPolicy(7), namespaceAuthority: authorityAtPolicy(7),
    crypto: new LatticeCrypto(), now: NOW, recipientTtlMs: 60_000,
  });
  await repository.create(oldPlan.initialRecord);
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    policyRevision: 8,
    refreshFromPolicyRevision: 7,
    authorityOverride: authorityAtPolicy(8),
    cancellationPublication: [false, true],
  });

  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "not_ready" });
  expect(value.refreshGuardCalls).toBe(1);
  expect(value.publicationChecks).toBe(2);
  expect(await repository.get(oldPlan.initialRecord.snapshot.requestId))
    .toEqual(oldPlan.initialRecord);
  expect(value.deleted).toEqual([]);
});

test("rotates an expired old-policy claim before replacing it with the current plan", async () => {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const selected = claimedCancellation({ running: true, claimExpiresAt: NOW + 10 });
  await repository.create(selected);
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    now: () => NOW + 11,
    policyRevision: 8,
    refreshFromPolicyRevision: 7,
    authorityOverride: authorityAtPolicy(8),
  });

  expect((await value.preparation.prepare({ taskId: TASK, taskRunId: RUN })).status)
    .toBe("exact_replay");
  expect(value.refreshGuardCalls).toBe(1);
  expect(await repository.get(selected.snapshot.requestId)).toMatchObject({
    expectedPolicyRevision: 8,
    snapshot: {
      state: "awaiting_recipient",
      recipientGeneration: 2,
      claimId: null,
      claimExpiresAt: null,
    },
    descriptorBytes: null,
    acceptedMaterial: null,
  });
  expect(value.deleted).toContainEqual([selected.snapshot.requestId, 0]);
});

test("notifies after a committed rotation even when its stale replacement loses", async () => {
  class StaleReplacementRepository
    extends InMemoryBackgroundAuthorizationRepository {
    override async replaceUnclaimedTaskCancellationAuthority(input: Parameters<
      InMemoryBackgroundAuthorizationRepository[
        "replaceUnclaimedTaskCancellationAuthority"
      ]
    >[0]) {
      return Object.freeze({
        status: "stale" as const,
        current: await this.get(input.expected.snapshot.requestId),
      });
    }
  }
  const repository = new StaleReplacementRepository();
  const selected = claimedCancellation({ running: true, claimExpiresAt: NOW + 10 });
  await repository.create(selected);
  const notifications: string[] = [];
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    now: () => NOW + 11,
    policyRevision: 8,
    refreshFromPolicyRevision: 7,
    authorityOverride: authorityAtPolicy(8),
    authorizationRequested: userId => {
      expect(value.contentAuthorityHeld).toBe(false);
      notifications.push(userId);
    },
  });

  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "not_ready" });
  expect(notifications).toEqual([USER]);
  expect(await repository.get(selected.snapshot.requestId)).toMatchObject({
    snapshot: { state: "awaiting_recipient", recipientGeneration: 1 },
  });
});

test("withholds a rotation hint when replacement returns substituted evidence", async () => {
  class SubstitutedReplacementRepository
    extends InMemoryBackgroundAuthorizationRepository {
    override async replaceUnclaimedTaskCancellationAuthority(input: Parameters<
      InMemoryBackgroundAuthorizationRepository[
        "replaceUnclaimedTaskCancellationAuthority"
      ]
    >[0]) {
      const replaced = await super
        .replaceUnclaimedTaskCancellationAuthority(input);
      if (replaced.status !== "replaced") return replaced;
      return Object.freeze({
        status: "replaced" as const,
        record: Object.freeze({
          ...replaced.record,
          expectedPolicyRevision: replaced.record.expectedPolicyRevision + 1,
        }),
      });
    }
  }
  const repository = new SubstitutedReplacementRepository();
  const selected = claimedCancellation({ running: true, claimExpiresAt: NOW + 10 });
  await repository.create(selected);
  const notifications: string[] = [];
  const value = fixture({
    repository,
    jobAuthorizationRequestId: null,
    now: () => NOW + 11,
    policyRevision: 8,
    refreshFromPolicyRevision: 7,
    authorityOverride: authorityAtPolicy(8),
    authorizationRequested: userId => {
      notifications.push(userId);
    },
  });

  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "not_ready" });
  expect(notifications).toEqual([]);
});
