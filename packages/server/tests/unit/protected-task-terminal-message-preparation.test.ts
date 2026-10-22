import { expect, test } from "bun:test";
import {
  PROTECTED_TASK_CANCELLED_RESULT,
  protectedTaskRunCancelledResultObjectId,
  protectedTaskRunMessageOperationId,
  protectedTaskRunOutputBindingId,
  type DirectDatabase,
} from "@nautilo/db";
import {
  deriveMessageCryptoObjectIdV2, encodeMessagePayloadV2,
  type ConversationRevisionLifecycle, type EncryptionDataOperationOwner,
} from "@nautilo/lattice-bridge";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  attachBackgroundAuthorizationRecipient,
  claimTaskRuntimeBackgroundAuthorizationRequest,
  InMemoryBackgroundAuthorizationRepository,
  markBackgroundAuthorizationGrantReady,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";
import {
  createProtectedTaskTerminalMessagePreparation,
} from "../../src/routes/protected-task-terminal-message-preparation";
import {
  createProtectedTaskTerminalMessagePlan,
  protectedTaskTerminalMessageRequestId,
  type ProtectedTaskTerminalMessagePlan,
} from "../../src/routes/protected-task-terminal-message-plan";
import type { ProtectedTaskTerminalMessageIntent } from
  "../../src/routes/protected-task-terminal-message-product";

const NOW = 1_805_000_000_000;
const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const TASK = "40000000-0000-4000-8000-000000000004";
const RUN = "50000000-0000-4000-8000-000000000005";
const PRIVATE_ROOM = "60000000-0000-4000-8000-000000000006";
const PRIVATE_NAMESPACE = "70000000-0000-4000-8000-000000000007";
const ROOM = "80000000-0000-4000-8000-000000000008";
const NAMESPACE = "90000000-0000-4000-8000-000000000009";
const DOMAIN = "a0000000-0000-4000-8000-00000000000a";
const SESSION = "b0000000-0000-4000-8000-00000000000b";
const DEVICE = "c0000000-0000-4000-8000-00000000000c";

function terminalIntent(
  representation: "protected" | "dual" = "protected",
): ProtectedTaskTerminalMessageIntent {
  return Object.freeze({
    taskId: TASK, taskRunId: RUN, requesterUserId: USER, agentId: AGENT,
    contentNamespaceId: PRIVATE_NAMESPACE, representation,
    bindingId: protectedTaskRunOutputBindingId(RUN),
    resultObjectId: protectedTaskRunCancelledResultObjectId(TASK, RUN),
    resultRevision: 2, acceptedPolicyRevision: 7,
    terminalAt: new Date(NOW - 2_000), attachedAt: new Date(NOW - 1_000),
    destinationRoomId: ROOM, destinationNamespaceId: NAMESPACE,
    messageOperationId: protectedTaskRunMessageOperationId(RUN),
  });
}

function authority(policyRevision: number) {
  return Object.freeze({
    sourceRoomId: ROOM,
    sourceNamespaceId: PRIVATE_NAMESPACE,
    facts: Object.freeze([Object.freeze({
      namespaceId: NAMESPACE, domainId: DOMAIN,
      expectedAccessRevision: 3, expectedPolicyRevision: policyRevision,
      expectedDomainEpoch: 5, expectedAuthorizationRevision: 11,
    })]),
  });
}

type Overrides = NonNullable<Parameters<
  typeof createProtectedTaskTerminalMessagePreparation
>[1]>;

function fixture(input: Readonly<{
  representation?: "protected" | "dual";
  mode?: "plaintext_only" | "shadow_encryption" | "encrypted_only";
  policyRevision?: number;
  repository?: InMemoryBackgroundAuthorizationRepository;
  now?: number;
  failAllocationCommitOnce?: boolean;
  refreshConflict?: boolean;
  changeSessionAfterAllocation?: boolean;
  authorizationRequested?: (requesterUserId: string) => void | Promise<void>;
  rollbackAuthorizationCommitOnce?: boolean;
}> = {}) {
  const crypto = new LatticeCrypto();
  const intent = terminalIntent(input.representation);
  const repository = input.repository
    ?? new InMemoryBackgroundAuthorizationRepository();
  let mode = input.mode ?? (intent.representation === "protected"
    ? "encrypted_only" as const : "shadow_encryption" as const);
  let policyRevision = input.policyRevision ?? 7;
  let allocation: Readonly<{
    lifecycle: ConversationRevisionLifecycle;
    createdAt: number;
  }> | null = null;
  let appendCalls = 0;
  let refreshCalls = 0;
  let publicationExists = false;
  let authorityCalls = 0;
  let intentReads = 0;
  let destinationReads = 0;
  let deletionObservedBeforeAuthorityReturn = false;
  let failAllocationCommit = input.failAllocationCommitOnce ?? false;
  let rollbackAuthorizationCommit = input.rollbackAuthorizationCommitOnce
    ?? false;
  let authorizationCommits = 0;
  const deleted: Array<readonly [string, number]> = [];
  const events: string[] = [];

  const owner = {
    runMutation: async (operation: Parameters<
      EncryptionDataOperationOwner["runMutation"]
    >[0]) => {
      const selected = mode === "plaintext_only" ? operation.ordinary
        : mode === "encrypted_only" ? operation.protected : operation.dual;
      if (selected === undefined) throw new Error("unsupported fixture mode");
      return selected({ revalidationToken: "token" } as never);
    },
  } as EncryptionDataOperationOwner;

  const store = {
    appendAllocated: async (request: Readonly<{
      sessionId: string;
      idempotencyKey: string;
      content: string | null;
      requestDigest: Uint8Array;
      publicationPolicy?: Readonly<{
        expectedRevision: number;
        representation: "ordinary_and_protected" | "protected_only";
      }>;
      [key: string]: unknown;
    }>) => {
      events.push("append");
      appendCalls += 1;
      expect(request.idempotencyKey).toBe(intent.messageOperationId);
      expect(request.content).toBe(intent.representation === "protected"
        ? null : PROTECTED_TASK_CANCELLED_RESULT);
      expect(request.publicationPolicy).toEqual({
        expectedRevision: policyRevision,
        representation: intent.representation === "protected"
          ? "protected_only" : "ordinary_and_protected",
      });
      const messageId = 40 + appendCalls;
      const lifecycle = Object.freeze({
        sessionId: SESSION, messageId, revision: 0,
        roomId: ROOM, namespaceIdAtAllocation: NAMESPACE,
        cryptoObjectId: deriveMessageCryptoObjectIdV2({
          sessionId: SESSION, messageId, revision: 0,
        }),
        objectIdScheme: "message_v2",
        representationMode: intent.representation === "protected"
          ? "full_encryption" : "shadow_encryption",
        publicationPolicyRevision: intent.representation === "protected"
          ? policyRevision : null,
        appendIdempotencyKey: intent.messageOperationId,
        allocationRequestDigest: request.requestDigest.slice(),
        authorRole: "assistant", keyClass: "ai",
        completion: "pending", disposition: "active",
      }) as ConversationRevisionLifecycle;
      allocation = Object.freeze({ lifecycle, createdAt: NOW - 500 });
      return Object.freeze({ status: "allocated" as const, lifecycle });
    },
  };

  const overrides: Partial<Overrides> = {
    db: {
      transaction: async (use: (transaction: unknown) => Promise<unknown>) =>
        use({}),
    } as DirectDatabase,
    crypto, owner, serverScope: "https://server.example",
    recipients: { delete: (requestId, generation) => {
      deleted.push([requestId, generation]);
      return true;
    } },
    recipientTtlMs: 60_000,
    now: () => input.now ?? NOW,
    restricted: () => ({}) as never,
    readPolicy: async () => ({
      mode, shadowBehavior: "strict", revision: policyRevision,
      shadowEncryptionStartedAt: new Date(NOW - 20_000),
      updatedAt: new Date(NOW - 10_000),
    }),
    readIntent: async () => {
      intentReads += 1;
      return intent;
    },
    resolveRequesterHuman: async () => ({ id: HUMAN }),
    resolveRequesterPrivateRoom: async () => ({
      roomId: PRIVATE_ROOM, namespaceId: PRIVATE_NAMESPACE,
    }),
    productContext: async () => ({ canonicalRunner: {}, handle: {} }) as never,
    withDeliveryAuthority: async operation => {
      authorityCalls += 1;
      if (!await operation.validateCurrentTaskRun(
        {} as never, {} as never, {} as never,
      )) return null;
      const result = await operation.use(
        authority(policyRevision), {} as never, {} as never, {} as never,
      );
      if (failAllocationCommit && events.at(-1) === "append") {
        failAllocationCommit = false;
        allocation = null;
        throw new Error("injected product commit failure");
      }
      if (rollbackAuthorizationCommit && authorityCalls > 1) {
        rollbackAuthorizationCommit = false;
        return null;
      }
      deletionObservedBeforeAuthorityReturn ||= deleted.length !== 0;
      if (authorityCalls > 1) authorizationCommits += 1;
      return result;
    },
    resolveDestination: async () => {
      destinationReads += 1;
      return Object.freeze({
        sessionId: input.changeSessionAfterAllocation && destinationReads > 1
          ? "d0000000-0000-4000-8000-00000000000d" : SESSION,
        sessionOwnerId: USER, graphThreadId: "thread",
      });
    },
    withProductStore: async operation => operation.use(store as never),
    lockAllocation: async () => allocation,
    withUnstagedPublication: async operation => {
      events.push("absence_fence");
      if (publicationExists) return Object.freeze({
        status: "publication_exists" as const,
      });
      return Object.freeze({
        status: "unstaged" as const,
        value: await operation.use({} as never, {} as never),
      });
    },
    refreshPolicy: async refresh => {
      events.push("refresh");
      refreshCalls += 1;
      if (input.refreshConflict) return "conflict";
      if (allocation === null
        || refresh.expectedPolicyRevision
          !== allocation.lifecycle.publicationPolicyRevision) return "conflict";
      allocation = Object.freeze({
        ...allocation,
        lifecycle: Object.freeze({
          ...allocation.lifecycle,
          publicationPolicyRevision: refresh.nextPolicyRevision,
        }),
      });
      return "refreshed";
    },
    repository: () => repository,
    readTaskId: async taskRunId => taskRunId === RUN ? TASK : null,
  };
  const preparation = createProtectedTaskTerminalMessagePreparation({
    owner, recipients: overrides.recipients!, recipientTtlMs: 60_000,
    authorizationRequested: input.authorizationRequested,
  }, overrides);
  return {
    preparation, repository, intent, crypto, deleted, events,
    get allocation() { return allocation; },
    get appendCalls() { return appendCalls; },
    get refreshCalls() { return refreshCalls; },
    get authorityCalls() { return authorityCalls; },
    get authorizationCommits() { return authorizationCommits; },
    get intentReads() { return intentReads; },
    get deletionObservedBeforeAuthorityReturn() {
      return deletionObservedBeforeAuthorityReturn;
    },
    setMode(next: typeof mode) { mode = next; },
    setPolicyRevision(next: number) { policyRevision = next; },
    setPublicationExists(next: boolean) { publicationExists = next; },
  };
}

test("plaintext mode remains inactive before destination or allocation work", async () => {
  const notifications: string[] = [];
  const value = fixture({
    mode: "plaintext_only",
    authorizationRequested: userId => {
      notifications.push(userId);
    },
  });
  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "inactive" });
  expect(value.intentReads).toBe(0);
  expect(value.authorityCalls).toBe(0);
  expect(value.appendCalls).toBe(0);
  expect(notifications).toEqual([]);
});

test.each(["protected", "dual"] as const)(
  "allocates the fixed %s cancellation Message before creating authorization",
  async representation => {
    const notifications: string[] = [];
    const value = fixture({
      representation,
      authorizationRequested: userId => {
        expect(value.authorizationCommits).toBe(1);
        notifications.push(userId);
      },
    });
    const result = await value.preparation.prepare({ taskId: TASK, taskRunId: RUN });
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected creation");
    expect(result.plan.intent).toEqual(value.intent);
    expect(result.plan.publicationPolicyRevision).toBe(7);
    expect(result.plan.initialRecord.workKind).toBe("task.deliver_message");
    expect(result.plan.initialRecord.authoritySet.namespaceRequirements[0])
      .toMatchObject({ namespaceId: NAMESPACE, operations: ["encrypt"] });
    expect(value.events).toEqual(["append", "absence_fence"]);
    expect(notifications).toEqual([USER]);
    expect((await value.repository.get(
      protectedTaskTerminalMessageRequestId(RUN),
    ))?.snapshot.state).toBe("awaiting_recipient");
  },
);

test("a rolled-back allocation never creates crypto authority for its coordinate", async () => {
  const value = fixture({ failAllocationCommitOnce: true });
  await Promise.resolve(expect(value.preparation.prepare({
    taskId: TASK, taskRunId: RUN,
  })).rejects.toThrow("injected product commit failure"));
  expect(value.allocation).toBeNull();
  expect(value.events).toEqual(["append"]);
  expect(await value.repository.get(
    protectedTaskTerminalMessageRequestId(RUN),
  )).toBeNull();

  const retried = await value.preparation.prepare({ taskId: TASK, taskRunId: RUN });
  expect(retried.status).toBe("created");
  if (retried.status !== "created") throw new Error("expected creation");
  expect(retried.plan.allocation.messageId).toBe(42);
  expect(value.appendCalls).toBe(2);
  expect(value.events).toEqual(["append", "append", "absence_fence"]);
  expect((await value.repository.get(
    protectedTaskTerminalMessageRequestId(RUN),
  ))?.idempotencyKey).toBe(retried.plan.initialRecord.idempotencyKey);
});

test("second pass refuses a changed canonical destination Session", async () => {
  const value = fixture({ changeSessionAfterAllocation: true });
  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "conflict" });
  expect(value.appendCalls).toBe(1);
  expect(value.events).toEqual(["append"]);
  expect(await value.repository.get(
    protectedTaskTerminalMessageRequestId(RUN),
  )).toBeNull();
});

test("exact replay reuses one allocation and resolvePlan never allocates", async () => {
  const notifications: string[] = [];
  const value = fixture({ authorizationRequested: userId => {
    notifications.push(userId);
  } });
  const created = await value.preparation.prepare({ taskId: TASK, taskRunId: RUN });
  expect(created.status).toBe("created");
  if (created.status !== "created") throw new Error("expected creation");
  const digest = value.allocation!.lifecycle.allocationRequestDigest.slice();
  const replay = await value.preparation.prepare({ taskId: TASK, taskRunId: RUN });
  expect(replay.status).toBe("exact_replay");
  expect(value.appendCalls).toBe(1);
  expect(value.allocation!.lifecycle.allocationRequestDigest).toEqual(digest);
  expect((await value.preparation.resolvePlan(created.plan.initialRecord))
    ?.allocation).toEqual(created.plan.allocation);
  expect(value.appendCalls).toBe(1);
  expect(notifications).toEqual([USER]);
});

test("a pristine Full allocation advances policy without reappend or digest rewrite", async () => {
  const value = fixture();
  const created = await value.preparation.prepare({ taskId: TASK, taskRunId: RUN });
  expect(created.status).toBe("created");
  const digest = value.allocation!.lifecycle.allocationRequestDigest.slice();
  value.setPolicyRevision(8);
  const replay = await value.preparation.prepare({ taskId: TASK, taskRunId: RUN });
  expect(replay.status).toBe("exact_replay");
  if (replay.status !== "exact_replay") throw new Error("expected replay");
  expect(replay.plan.publicationPolicyRevision).toBe(8);
  expect(value.refreshCalls).toBe(1);
  expect(value.appendCalls).toBe(1);
  expect(value.allocation!.lifecycle.allocationRequestDigest).toEqual(digest);
  expect((await value.repository.get(
    protectedTaskTerminalMessageRequestId(RUN),
  ))?.expectedPolicyRevision).toBe(8);
});

test("a lost policy-refresh CAS preserves the durable allocation and request", async () => {
  const value = fixture({ refreshConflict: true });
  const created = await value.preparation.prepare({ taskId: TASK, taskRunId: RUN });
  expect(created.status).toBe("created");
  const digest = value.allocation!.lifecycle.allocationRequestDigest.slice();
  value.setPolicyRevision(8);
  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "conflict" });
  expect(value.appendCalls).toBe(1);
  expect(value.refreshCalls).toBe(1);
  expect(value.allocation!.lifecycle.publicationPolicyRevision).toBe(7);
  expect(value.allocation!.lifecycle.allocationRequestDigest).toEqual(digest);
  expect((await value.repository.get(
    protectedTaskTerminalMessageRequestId(RUN),
  ))?.expectedPolicyRevision).toBe(7);
});

test("staged bytes fence policy refresh and authorization rotation", async () => {
  const value = fixture();
  await value.preparation.prepare({ taskId: TASK, taskRunId: RUN });
  value.setPublicationExists(true);
  value.setPolicyRevision(8);
  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "not_ready" });
  expect(value.refreshCalls).toBe(0);
  expect((await value.repository.get(
    protectedTaskTerminalMessageRequestId(RUN),
  ))?.expectedPolicyRevision).toBe(7);
  expect(value.deleted).toEqual([]);
});

function claimedRecords(
  plan: ProtectedTaskTerminalMessagePlan,
  claimExpiresAt = NOW + 20_000,
): readonly BackgroundAuthorizationTaskRuntimeRecordV3[] {
  const descriptorBytes = new Uint8Array([1, 2, 3]);
  const descriptorDigest = Buffer.from(
    new LatticeCrypto().hash(descriptorBytes),
  ).toString("hex");
  const recipient = {
    recipientGeneration: 0,
    recipientKeyId: `task-delivery-runtime:${RUN}:0`,
    recipientPublicKey: Buffer.from(new Uint8Array(65).fill(7))
      .toString("base64url"),
    descriptorDigest,
    expiresAt: NOW + 60_000,
  };
  const awaiting = attachBackgroundAuthorizationRecipient(
    plan.initialRecord.snapshot, { ...recipient, now: NOW + 1 },
  );
  const responseBytes = new Uint8Array([8, 9]);
  const ready = markBackgroundAuthorizationGrantReady(awaiting, {
    ...recipient, kind: "runtime", requestId: plan.initialRecord.snapshot.requestId,
    responseDigest: Buffer.from(new LatticeCrypto().hash(responseBytes))
      .toString("hex"),
    credentialDigest: "22".repeat(32), issuingHumanId: HUMAN,
    issuingDeviceId: DEVICE, now: NOW + 2,
  });
  const claimed = claimTaskRuntimeBackgroundAuthorizationRequest(ready, {
    claimId: "terminal-message-claim", now: NOW + 3,
    requestDeadlineAt: claimExpiresAt,
    authorizationExpiresAt: claimExpiresAt,
  });
  const awaitingRecord: BackgroundAuthorizationTaskRuntimeRecordV3 = {
    ...plan.initialRecord, descriptorBytes,
    snapshot: awaiting as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
  };
  const readyRecord: BackgroundAuthorizationTaskRuntimeRecordV3 = {
    ...plan.initialRecord, descriptorBytes,
    acceptedMaterial: {
      credentialId: "terminal-message-credential", responseBytes,
      authorizationExpiresAt: claimExpiresAt,
      issuingDeviceAuthorizationRevision: 3,
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(10),
    },
    snapshot: ready as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
  };
  return [awaitingRecord, readyRecord, {
    ...readyRecord,
    snapshot: claimed,
  }];
}

test("a live claim blocks policy refresh and keeps its recipient", async () => {
  const crypto = new LatticeCrypto();
  const intent = terminalIntent();
  const encoded = encodeMessagePayloadV2({
    role: "assistant", content: PROTECTED_TASK_CANCELLED_RESULT,
  });
  const messageId = 41;
  const lifecycle = Object.freeze({
    sessionId: SESSION, messageId, revision: 0,
    roomId: ROOM, namespaceIdAtAllocation: NAMESPACE,
    cryptoObjectId: deriveMessageCryptoObjectIdV2({
      sessionId: SESSION, messageId, revision: 0,
    }),
    objectIdScheme: "message_v2", representationMode: "full_encryption",
    publicationPolicyRevision: 7,
    appendIdempotencyKey: intent.messageOperationId,
    allocationRequestDigest: crypto.hash(encoded),
    authorRole: "assistant", keyClass: "ai",
    completion: "pending", disposition: "active",
  }) as ConversationRevisionLifecycle;
  encoded.fill(0);
  const plan = createProtectedTaskTerminalMessagePlan({
    intent,
    allocation: {
      sessionId: SESSION, messageId, revision: 0,
      objectId: lifecycle.cryptoObjectId,
      createdAt: NOW - 500, publicationPolicyRevision: 7,
    },
    lifecycle, namespaceAuthority: authority(7), crypto,
    now: NOW, recipientTtlMs: 60_000,
  });
  const repository = new InMemoryBackgroundAuthorizationRepository();
  await repository.create(claimedRecords(plan).at(-1)!);
  const value = fixture({ repository });
  value.setPolicyRevision(8);
  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "conflict" });
  expect(value.refreshCalls).toBe(0);
  expect(value.deleted).toEqual([]);
});

test("an expired claim advances only under the absence fence and cleans up after commit", async () => {
  const crypto = new LatticeCrypto();
  const intent = terminalIntent();
  const encoded = encodeMessagePayloadV2({
    role: "assistant", content: PROTECTED_TASK_CANCELLED_RESULT,
  });
  const messageId = 41;
  const lifecycle = Object.freeze({
    sessionId: SESSION, messageId, revision: 0,
    roomId: ROOM, namespaceIdAtAllocation: NAMESPACE,
    cryptoObjectId: deriveMessageCryptoObjectIdV2({
      sessionId: SESSION, messageId, revision: 0,
    }),
    objectIdScheme: "message_v2", representationMode: "full_encryption",
    publicationPolicyRevision: 7,
    appendIdempotencyKey: intent.messageOperationId,
    allocationRequestDigest: crypto.hash(encoded),
    authorRole: "assistant", keyClass: "ai",
    completion: "pending", disposition: "active",
  }) as ConversationRevisionLifecycle;
  encoded.fill(0);
  const plan = createProtectedTaskTerminalMessagePlan({
    intent,
    allocation: {
      sessionId: SESSION, messageId, revision: 0,
      objectId: lifecycle.cryptoObjectId,
      createdAt: NOW - 500, publicationPolicyRevision: 7,
    },
    lifecycle, namespaceAuthority: authority(7), crypto,
    now: NOW, recipientTtlMs: 60_000,
  });
  const repository = new InMemoryBackgroundAuthorizationRepository();
  await repository.create(claimedRecords(plan, NOW + 20_000).at(-1)!);
  const notifications: string[] = [];
  const value = fixture({
    repository,
    now: NOW + 30_000,
    authorizationRequested: userId => {
      notifications.push(userId);
    },
  });
  const replay = await value.preparation.prepare({ taskId: TASK, taskRunId: RUN });
  expect(replay.status).toBe("exact_replay");
  expect(await repository.get(protectedTaskTerminalMessageRequestId(RUN)))
    .toMatchObject({ snapshot: {
      state: "awaiting_recipient", recipientGeneration: 1,
    } });
  expect(value.deleted).toEqual([[
    protectedTaskTerminalMessageRequestId(RUN), 0,
  ]]);
  expect(value.deletionObservedBeforeAuthorityReturn).toBe(false);
  expect(value.events).toContain("absence_fence");
  expect(notifications).toEqual([USER]);
});

test("withholds a rotation hint when terminal replacement returns substituted evidence", async () => {
  class SubstitutedReplacementRepository
    extends InMemoryBackgroundAuthorizationRepository {
    override async replaceUnclaimedTaskTerminalMessageAuthority(input: Parameters<
      InMemoryBackgroundAuthorizationRepository[
        "replaceUnclaimedTaskTerminalMessageAuthority"
      ]
    >[0]) {
      const replaced = await super
        .replaceUnclaimedTaskTerminalMessageAuthority(input);
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
  const crypto = new LatticeCrypto();
  const intent = terminalIntent();
  const encoded = encodeMessagePayloadV2({
    role: "assistant", content: PROTECTED_TASK_CANCELLED_RESULT,
  });
  const messageId = 41;
  const lifecycle = Object.freeze({
    sessionId: SESSION, messageId, revision: 0,
    roomId: ROOM, namespaceIdAtAllocation: NAMESPACE,
    cryptoObjectId: deriveMessageCryptoObjectIdV2({
      sessionId: SESSION, messageId, revision: 0,
    }),
    objectIdScheme: "message_v2", representationMode: "full_encryption",
    publicationPolicyRevision: 7,
    appendIdempotencyKey: intent.messageOperationId,
    allocationRequestDigest: crypto.hash(encoded),
    authorRole: "assistant", keyClass: "ai",
    completion: "pending", disposition: "active",
  }) as ConversationRevisionLifecycle;
  encoded.fill(0);
  const plan = createProtectedTaskTerminalMessagePlan({
    intent,
    allocation: {
      sessionId: SESSION, messageId, revision: 0,
      objectId: lifecycle.cryptoObjectId,
      createdAt: NOW - 500, publicationPolicyRevision: 7,
    },
    lifecycle, namespaceAuthority: authority(7), crypto,
    now: NOW, recipientTtlMs: 60_000,
  });
  const repository = new SubstitutedReplacementRepository();
  await repository.create(claimedRecords(plan, NOW + 20_000).at(-1)!);
  const notifications: string[] = [];
  const value = fixture({
    repository,
    now: NOW + 30_000,
    authorizationRequested: userId => {
      notifications.push(userId);
    },
  });
  value.setPolicyRevision(8);

  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "conflict" });
  expect(notifications).toEqual([]);
});

test("does not notify when terminal authorization creation is rolled back", async () => {
  const notifications: string[] = [];
  const value = fixture({
    rollbackAuthorizationCommitOnce: true,
    authorizationRequested: userId => {
      notifications.push(userId);
    },
  });

  expect(await value.preparation.prepare({ taskId: TASK, taskRunId: RUN }))
    .toEqual({ status: "not_ready" });
  expect(notifications).toEqual([]);
});

test("a rejecting terminal notification does not change committed creation", async () => {
  const value = fixture({
    authorizationRequested: () => Promise.reject(new Error("offline")),
  });

  expect((await value.preparation.prepare({ taskId: TASK, taskRunId: RUN })).status)
    .toBe("created");
});

test("payload allocation digest is the exact fixed encoded Message digest", async () => {
  const value = fixture();
  await value.preparation.prepare({ taskId: TASK, taskRunId: RUN });
  const encoded = encodeMessagePayloadV2({
    role: "assistant", content: PROTECTED_TASK_CANCELLED_RESULT,
  });
  try {
    expect(value.allocation!.lifecycle.allocationRequestDigest)
      .toEqual(value.crypto.hash(encoded));
  } finally {
    encoded.fill(0);
  }
});
