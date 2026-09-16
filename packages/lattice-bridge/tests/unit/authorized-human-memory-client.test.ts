import { describe, expect, test } from "bun:test";
import type {
  ProtectedMemoryCreatePlanSlotResponseV1,
  ProtectedMemoryDtoV1,
  ProtectedMemoryPreparedCreateRequestV1,
  ProtectedMemoryPreparedUpdateRequestV1,
  ProtectedMemoryPreparedAccessRequestV1,
  ProtectedMemoryAccessPlanResponseV1,
  ProtectedMemoryOrdinaryFallbackCreateRequestV1,
  ProtectedMemoryOrdinaryFallbackUpdateRequestV1,
} from "@nautilo/api-client/browser";

import {
  AuthorizedHumanMemoryUnavailableError,
  __mintAuthorizedHumanMemoryTestAuthorityForTesting,
  createAuthorizedHumanMemoryClient,
  createAuthorizedHumanMemoryClientFromTrustedPorts,
  type AuthorizedHumanMemoryDeviceContentPort,
  type AuthorizedHumanMemoryPreparedMutationJournal,
  type AuthorizedHumanMemoryWriteIntentV1,
  type ProtectedMemoryApi,
} from "../../src/client/memory/authorized-human-memory-client.ts";
import type {
  PreparedHumanMemoryMutation,
  PreparedMutationJournalIndex,
} from "../../src/client/memory/prepared-mutation-journal.ts";
import { encodeMemoryPayloadV1 } from "../../src/memory/memory-payload-v1.ts";
import { bindEncryptionDataOperationOwner } from "../../src/transition/encryption-data-operation-owner.ts";

const testOwner = bindEncryptionDataOperationOwner({ policy: {
  resolve: async () => ({ policy: { mode: "shadow_encryption", shadowBehavior: "fallback" }, revalidationToken: 1 }),
  revalidate: () => Promise.resolve(),
} });

const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const NAMESPACE_ID = "22222222-2222-4222-8222-222222222222";
const NAMESPACE_B = "33333333-3333-4333-8333-333333333333";
const ROOM_ID = "44444444-4444-4444-8444-444444444444";
const namespaceAuthority = (namespaceId: string) => ({ sourceRoomId: ROOM_ID,
  namespaceId, currentGeneration: 0, retainedGenerations: [{ generation: 0, accessRevision: 0,
    headDigestBase64url: "AA", publicationDigestBase64url: "AA",
    publicationSetDigestBase64url: "AA", audienceFingerprintBase64url: "AA" }] });

function dto(
  revision = 1,
  tier: 1 | 2 | 3 = 1,
  demotedFrom?: 1 | 2,
): ProtectedMemoryDtoV1 {
  return {
    dtoVersion: 1,
    projection: {
      memoryId: MEMORY_ID,
      contentRevision: revision,
      cryptoAccessRevision: 0,
      importance: 0.5,
      tier,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      namespaceIds: [NAMESPACE_ID],
      requiredNamespaceIds: [NAMESPACE_ID],
      readAuthorities: [namespaceAuthority(NAMESPACE_ID)],
      ...(demotedFrom === undefined ? {} : { demotedFrom }),
    },
    protectedPayload: {
      status: "encrypted",
      cryptoObjectId: `nautilo-memory-v1:${MEMORY_ID}:${revision}`,
      payloadVersion: 1,
      encryptedPayloadBytesBase64url: "Y2lwaGVydGV4dA",
      accessManifestBytesBase64url: "bWFuaWZlc3Q",
      accessSignerEvidence: [],
      namespaceEnvelopes: [{
        namespaceId: NAMESPACE_ID,
        envelopeBytesBase64url: "ZW52ZWxvcGU",
      }],
    },
  };
}

function sharedDto(
  revision = 1,
  tier: 1 | 2 | 3 = 1,
): ProtectedMemoryDtoV1 {
  const singleton = dto(revision, tier);
  return {
    ...singleton,
    projection: {
      ...singleton.projection,
      cryptoAccessRevision: 1,
      namespaceIds: [NAMESPACE_ID, NAMESPACE_B],
      requiredNamespaceIds: [NAMESPACE_ID, NAMESPACE_B],
    },
    protectedPayload: singleton.protectedPayload.status === "encrypted"
      ? {
        ...singleton.protectedPayload,
        namespaceEnvelopes: [
          ...singleton.protectedPayload.namespaceEnvelopes,
          {
            namespaceId: NAMESPACE_B,
            envelopeBytesBase64url: "ZW52ZWxvcGUtYg",
          },
        ],
      }
      : singleton.protectedPayload,
  };
}

const intent: AuthorizedHumanMemoryWriteIntentV1 = {
  payload: {
    formatVersion: 1,
    content: "callback-local private content",
    type: "preference",
  },
  requestedProvider: "openai",
  requestedModel: "text-embedding-3-small",
};

const plan: ProtectedMemoryCreatePlanSlotResponseV1 = {
  dtoVersion: 1,
  memoryId: MEMORY_ID,
  operationId: "memory-create:1",
  expectedContentRevision: 0,
  nextContentRevision: 1,
  productAuthority: { mode: "namespace" },
  requiredNamespaceIds: [NAMESPACE_ID],
  targetAuthorities: [namespaceAuthority(NAMESPACE_ID)],
  deadlineAt: 1_786_406_430_000,
};

function preparedCreate(): ProtectedMemoryPreparedCreateRequestV1 {
  return {
    requestVersion: 1,
    memoryId: MEMORY_ID,
    operationId: plan.operationId,
    expectedContentRevision: 0,
    nextContentRevision: 1,
    cryptoObjectId: `nautilo-memory-v1:${MEMORY_ID}:1`,
    payloadVersion: 1,
    encryptedPayloadBytesBase64url: "Y2lwaGVydGV4dA",
    accessManifestBytesBase64url: "bWFuaWZlc3Q",
    requiredNamespaceIds: [NAMESPACE_ID],
    namespaceEnvelopes: [{
      namespaceId: NAMESPACE_ID,
      envelopeBytesBase64url: "ZW52ZWxvcGU",
    }],
    signedContentEmbeddingRequestBytesBase64url: "c2lnbmVkLXJlcXVlc3Q",
  };
}

function preparedUpdate(): ProtectedMemoryPreparedUpdateRequestV1 {
  const { memoryId: _memoryId, ...create } = preparedCreate();
  return {
    ...create,
    operationId: "memory-update:1",
    expectedContentRevision: 1,
    nextContentRevision: 2,
    cryptoObjectId: `nautilo-memory-v1:${MEMORY_ID}:2`,
  };
}

function preparedSharedUpdate(): ProtectedMemoryPreparedUpdateRequestV1 {
  return {
    ...preparedUpdate(),
    requiredNamespaceIds: [NAMESPACE_ID, NAMESPACE_B],
    namespaceEnvelopes: [
      {
        namespaceId: NAMESPACE_ID,
        envelopeBytesBase64url: "ZW52ZWxvcGU",
      },
      {
        namespaceId: NAMESPACE_B,
        envelopeBytesBase64url: "ZW52ZWxvcGUtYg",
      },
    ],
  };
}


const accessPlan: Extract<ProtectedMemoryAccessPlanResponseV1, { status: "planned" }> = {
  dtoVersion: 1,
  status: "planned",
  planVersion: 1,
  operationId: "memory-access:1",
  memoryId: MEMORY_ID,
  expectedContentRevision: 1,
  expectedCryptoAccessRevision: 0,
  cryptoObjectId: `nautilo-memory-v1:${MEMORY_ID}:1`,
  currentNamespaceIds: [NAMESPACE_ID],
  targetNamespaceIds: [NAMESPACE_ID, NAMESPACE_B],
  currentAuthorities: [namespaceAuthority(NAMESPACE_ID)],
  targetAuthorities: [namespaceAuthority(NAMESPACE_ID), namespaceAuthority(NAMESPACE_B)],
  addedNamespaceIds: [NAMESPACE_B],
  removedNamespaceIds: [],
  deadlineAt: 1_786_406_430_000,
};

function preparedAccess(): ProtectedMemoryPreparedAccessRequestV1 {
  return {
    requestVersion: 1,
    operationId: accessPlan.operationId,
    memoryId: MEMORY_ID,
    expectedContentRevision: 1,
    expectedCryptoAccessRevision: 0,
    nextCryptoAccessRevision: 1,
    cryptoObjectId: accessPlan.cryptoObjectId,
    currentNamespaceIds: [NAMESPACE_ID],
    targetNamespaceIds: [NAMESPACE_ID, NAMESPACE_B],
    accessManifestBytesBase64url: "c2lnbmVkLWFjY2Vzcy1tYW5pZmVzdA",
    signedAccessRequestBytesBase64url: "c2lnbmVkLWFjY2Vzcy1yZXF1ZXN0",
    namespaceEnvelopes: [
      { namespaceId: NAMESPACE_ID, envelopeBytesBase64url: "ZW52ZWxvcGUtYQ" },
      { namespaceId: NAMESPACE_B, envelopeBytesBase64url: "ZW52ZWxvcGUtYg" },
    ],
  };
}

type ProtectedApi = Pick<ProtectedMemoryApi,
  | "listProtectedMemories"
  | "getProtectedMemory"
  | "searchProtectedMemories"
  | "getProtectedMemoryBrief"
  | "planProtectedMemoryCreate"
  | "createProtectedMemory"
  | "updateProtectedMemory"
  | "archiveProtectedMemory"
  | "transitionProtectedMemoryTier"
  | "restoreProtectedMemory"
  | "planProtectedMemoryAccess"
  | "commitProtectedMemoryAccess"
  | "planProtectedMemoryRepair"
  | "commitProtectedMemoryRepair"
>;

function api(overrides: Partial<ProtectedApi> = {}): ProtectedApi {
  return {
    listProtectedMemories: async () => ({
      dtoVersion: 1,
      items: [dto()],
      nextCursor: null,
      memoryMode: "namespace",
      total: 1,
    }),
    getProtectedMemory: async () => ({
      dtoVersion: 1,
      memory: dto(),
      memoryMode: "namespace",
      actionAuthority: {
        canEdit: true,
        canArchive: true,
        canManageAccess: true,
      },
    }),
    searchProtectedMemories: async () => ({
      dtoVersion: 1,
      items: [{ memory: dto(), score: 0.75 }],
      memoryMode: "namespace",
      queryDisclosure: "embedding_provider",
    }),
    getProtectedMemoryBrief: async () => ({
      dtoVersion: 1,
      items: [dto()],
      memoryMode: "namespace",
    }),
    planProtectedMemoryCreate: async () => plan,
    createProtectedMemory: async () => ({
      dtoVersion: 1,
      status: "published",
      memory: dto(),
    }),
    updateProtectedMemory: async () => ({
      dtoVersion: 1,
      status: "published",
      memory: dto(2),
    }),
    archiveProtectedMemory: async (_memoryId, request) => ({
      dtoVersion: 1,
      operationId: request.operationId,
      status: "archived",
      memoryId: MEMORY_ID,
      contentRevision: request.expectedContentRevision,
      cryptoAccessRevision: request.expectedCryptoAccessRevision,
      tier: 3,
    }),
    transitionProtectedMemoryTier: async (_memoryId, request) => ({
      dtoVersion: 1,
      operationId: request.operationId,
      status: request.action === "promote" ? "promoted" : "demoted",
      memoryId: MEMORY_ID,
      contentRevision: request.expectedContentRevision,
      cryptoAccessRevision: request.expectedCryptoAccessRevision,
      previousTier: request.expectedTier,
      nextTier: request.nextTier,
    }),
    restoreProtectedMemory: async (_memoryId, request) => ({
      dtoVersion: 1,
      operationId: request.operationId,
      status: "restored",
      memoryId: MEMORY_ID,
      contentRevision: request.expectedContentRevision,
      cryptoAccessRevision: request.expectedCryptoAccessRevision,
      previousTier: 3,
      nextTier: request.nextTier,
    }),
    planProtectedMemoryAccess: async () => accessPlan,
    commitProtectedMemoryAccess: async (_memoryId, request) => ({
      dtoVersion: 1,
      operationId: request.operationId,
      status: "updated",
      memoryId: MEMORY_ID,
      cryptoAccessRevision: request.nextCryptoAccessRevision,
      requiredNamespaceIds: request.targetNamespaceIds,
    }),
    ...overrides,
  };
}

function contentPort(openedBuffers: Uint8Array[], expectedIntent = intent):
AuthorizedHumanMemoryDeviceContentPort {
  return {
    prepareAccessReadiness: async () => undefined,
    openExact: async () => {
      const bytes = encodeMemoryPayloadV1(intent.payload);
      openedBuffers.push(bytes);
      return bytes;
    },
    prepareCreate: async ({ plan: received, intent: receivedIntent }) => {
      expect(received).toBe(plan);
      expect(receivedIntent).toEqual(expectedIntent);
      return preparedCreate();
    },
    prepareUpdate: async ({ current, intent: receivedIntent }) => {
      expect(current.projection.memoryId).toBe(MEMORY_ID);
      expect(receivedIntent).toEqual(expectedIntent);
      return preparedUpdate();
    },
    prepareAccess: async ({ current, plan: received }) => {
      expect(current.projection.memoryId).toBe(MEMORY_ID);
      expect(received).toEqual(accessPlan);
      return preparedAccess();
    },
  };
}

function fallbackCreateRequest(): ProtectedMemoryOrdinaryFallbackCreateRequestV1 {
  return { requestVersion: 1, publicationKind: "ordinary_fallback",
    reason: "target_encryption_not_ready", memoryId: MEMORY_ID,
    operationId: "memory-create:fallback", expectedContentRevision: 0,
    nextContentRevision: 1, expectedCryptoAccessRevision: 0,
    requiredNamespaceIds: [NAMESPACE_ID],
    signedOrdinaryFallbackRequestBytesBase64url: "c2lnbmVkLWZhbGxiYWNr" };
}

function fallbackUpdateRequest(): ProtectedMemoryOrdinaryFallbackUpdateRequestV1 {
  return { ...fallbackCreateRequest(), operationId: "memory-update:fallback",
    expectedContentRevision: 1, nextContentRevision: 2 };
}

class MemoryMutationJournal implements AuthorizedHumanMemoryPreparedMutationJournal {
  readonly mutations = new Map<string, Readonly<{
    mutation: PreparedHumanMemoryMutation;
    index: PreparedMutationJournalIndex;
  }>>();
  full = false;

  capacity(): Promise<Readonly<{ full: boolean }>> {
    return Promise.resolve({ full: this.full });
  }

  putBeforeSend(
    mutation: PreparedHumanMemoryMutation,
  ): ReturnType<AuthorizedHumanMemoryPreparedMutationJournal["putBeforeSend"]> {
    const operationId = mutation.request.operationId;
    const existing = this.mutations.get(operationId);
    if (existing !== undefined) {
      return Promise.resolve({ status: "duplicate" as const, index: existing.index });
    }
    const index: Extract<PreparedMutationJournalIndex, { memoryId: string }> = {
      formatVersion: 1,
      operationId,
      kind: mutation.kind,
      memoryId: mutation.memoryId,
      authenticatedRequestDigestBase64url: `digest:${operationId}`,
      canonicalBytes: 1,
      sealedBytes: 1,
      createdAt: 1,
      updatedAt: 1,
      attempts: 0,
      attemptWindowStartedAt: null,
      attemptsInWindow: 0,
      nextAttemptAt: 1,
      lastAttemptAt: null,
      state: "pending",
    };
    this.mutations.set(operationId, {
      mutation: structuredClone(mutation),
      index,
    });
    return Promise.resolve({ status: "inserted" as const, index });
  }

  listDue() {
    return Promise.resolve([...this.mutations.values()].map(({ index }) => ({
      operationId: index.operationId,
      authenticatedRequestDigestBase64url:
        index.authenticatedRequestDigestBase64url,
      kind: index.kind,
      attempts: index.attempts,
      ageMs: 1,
    })));
  }

  withPrepared<Result>(
    operationId: string,
    use: (mutation: PreparedHumanMemoryMutation) => Promise<Result> | Result,
  ): Promise<Result> {
    const retained = this.mutations.get(operationId);
    if (retained === undefined) throw new Error("missing mutation");
    return Promise.resolve(use(structuredClone(retained.mutation)));
  }

  recordOutcome(input: Parameters<
    AuthorizedHumanMemoryPreparedMutationJournal["recordOutcome"]
  >[0]): Promise<void> {
    if (input.outcome === "completed") this.mutations.delete(input.operationId);
    return Promise.resolve();
  }
}

test("ordinary fallback is a completed save, never a verified open or repeated mutation", async () => {
  const journal = new MemoryMutationJournal();
  const opened: unknown[] = [];
  let sends = 0;
  const fallback = { dtoVersion: 1 as const, status: "ordinary_fallback" as const,
    operationId: plan.operationId, memoryId: MEMORY_ID,
    contentRevision: 1, cryptoAccessRevision: 0,
    reason: "encryption_pending" as const, followUpPending: true as const };
  const subject = client({ journal, api: api({ createProtectedMemory: async () => {
    sends += 1;
    return fallback;
  } }) });
  expect(await subject.create(intent, (value) => { opened.push(value); }))
    .toEqual({ status: "ordinary_fallback", memoryId: MEMORY_ID,
      reason: "encryption_pending", followUpPending: true });
  expect(opened).toEqual([]);
  expect(journal.mutations.size).toBe(0);
  expect(await subject.retryPendingMutations()).toBe(0);
  expect(sends).toBe(1);
});

test("content fallback validates exact operation, object and revision before completing custody", async () => {
  for (const substitution of [
    { operationId: "other" }, { memoryId: ROOM_ID }, { contentRevision: 4 }, { cryptoAccessRevision: 2 },
  ]) {
    const journal = new MemoryMutationJournal();
    const subject = client({ journal, api: api({ createProtectedMemory: async () => ({
      dtoVersion: 1, status: "ordinary_fallback", operationId: plan.operationId,
      memoryId: MEMORY_ID, contentRevision: 1, cryptoAccessRevision: 0,
      reason: "encryption_pending", ...substitution,
    }) }) });
    let failure: unknown;
    try { await subject.create(intent, () => {}); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TypeError);
    expect(String(failure)).toContain("receipt was substituted");
    expect(journal.mutations.size).toBe(1);
  }
});

test("access fallback keeps the old crypto revision without claiming an updated encrypted head", async () => {
  const journal = new MemoryMutationJournal();
  const subject = client({ journal, api: api({ commitProtectedMemoryAccess: async () => ({
    dtoVersion: 1, status: "ordinary_fallback", operationId: accessPlan.operationId,
    memoryId: MEMORY_ID, cryptoAccessRevision: accessPlan.expectedCryptoAccessRevision,
    requiredNamespaceIds: [...accessPlan.targetNamespaceIds], reason: "target_encryption_not_ready",
  }) }) });
  expect(await subject.grantUser(MEMORY_ID, "bob")).toEqual({
    status: "ordinary_fallback", memoryId: MEMORY_ID, reason: "target_encryption_not_ready",
  });
  expect(journal.mutations.size).toBe(0);
});

function client(input?: {
  api?: ProtectedApi;
  content?: AuthorizedHumanMemoryDeviceContentPort;
  journal?: AuthorizedHumanMemoryPreparedMutationJournal;
  owner?: typeof testOwner;
}) {
  if (input?.owner !== undefined) return createAuthorizedHumanMemoryClientFromTrustedPorts({
    owner: input.owner,
    api: input.api ?? api(), content: input.content ?? contentPort([]),
    journal: input.journal ?? new MemoryMutationJournal(),
    createOperationId: ({ kind }) => `memory-${kind}:1`,
  });
  return createAuthorizedHumanMemoryClient({
    authority: __mintAuthorizedHumanMemoryTestAuthorityForTesting(),
    api: input?.api ?? api(),
    content: input?.content ?? contentPort([]),
    journal: input?.journal ?? new MemoryMutationJournal(),
    createOperationId: ({ kind }) => `memory-${kind}:1`,
  });
}

describe("authorized Human Memory client composition", () => {
  test("journals and retries the exact signed early create fallback without Namespace keys", async () => {
    const journal = new MemoryMutationJournal();
    const sent: ProtectedMemoryOrdinaryFallbackCreateRequestV1[] = [];
    let protectedPreparations = 0;
    const fallbackPlan = { dtoVersion: 1 as const,
      status: "ordinary_fallback_ready" as const,
      reason: "target_encryption_not_ready" as const,
      memoryId: MEMORY_ID, operationId: "memory-create:fallback",
      expectedContentRevision: 0 as const, nextContentRevision: 1 as const,
      expectedCryptoAccessRevision: 0 as const,
      productAuthority: { mode: "namespace" as const },
      requiredNamespaceIds: [NAMESPACE_ID],
      ordinaryFallbackAuthorization: { policyRevision: 7 },
      issuedAt: 1, deadlineAt: 30_001 };
    let failResponse = true;
    const protectedClient = client({ journal,
      api: api({ planProtectedMemoryCreate: async () => fallbackPlan,
        createProtectedMemory: async (request) => {
          if (!("publicationKind" in request)) throw new Error("expected fallback");
          sent.push(structuredClone(request));
          if (failResponse) throw new Error("response lost");
          return { dtoVersion: 1, status: "ordinary_fallback",
            operationId: request.operationId, memoryId: request.memoryId,
            contentRevision: 1, cryptoAccessRevision: 0,
            reason: "target_encryption_not_ready" };
        } }),
      content: { ...contentPort([]),
        prepareCreate: async () => { protectedPreparations += 1; return preparedCreate(); },
        prepareOrdinaryFallbackCreate: async () => fallbackCreateRequest() } });
    expect(protectedClient.create(intent, () => {})).rejects.toThrow("response lost");
    expect(protectedPreparations).toBe(0);
    expect(journal.mutations.size).toBe(1);
    failResponse = false;
    expect(await protectedClient.retryPendingMutations()).toBe(1);
    expect(sent).toEqual([fallbackCreateRequest(), fallbackCreateRequest()]);
    expect(journal.mutations.size).toBe(0);
  });

  test("uses only typed key unavailability for authorized update fallback", async () => {
    const sent: ProtectedMemoryOrdinaryFallbackUpdateRequestV1[] = [];
    const protectedClient = client({ api: api({
      getProtectedMemory: async () => ({ dtoVersion: 1, memory: dto(),
        ordinaryFallbackAuthorization: { policyRevision: 8 },
        memoryMode: "namespace", actionAuthority: {
          canEdit: true, canArchive: true, canManageAccess: true } }),
      updateProtectedMemory: async (_memoryId, request) => {
        if (!("publicationKind" in request)) throw new Error("expected fallback");
        sent.push(structuredClone(request));
        return { dtoVersion: 1, status: "ordinary_fallback",
          operationId: request.operationId, memoryId: MEMORY_ID,
          contentRevision: 2, cryptoAccessRevision: 0,
          reason: "target_encryption_not_ready" };
      },
    }), content: { ...contentPort([]),
      prepareUpdate: async () => {
        throw new AuthorizedHumanMemoryUnavailableError("target_encryption_not_ready");
      },
      prepareOrdinaryFallbackUpdate: async ({ policyRevision }) => {
        expect(policyRevision).toBe(8);
        return fallbackUpdateRequest();
      } } });
    expect(await protectedClient.update(MEMORY_ID, intent, () => {}))
      .toMatchObject({ status: "ordinary_fallback" });
    expect(sent).toEqual([fallbackUpdateRequest()]);

    const unknown = new Error("Namespace unavailable");
    const rejected = client({ api: api({ getProtectedMemory: async () => ({
      dtoVersion: 1, memory: dto(),
      ordinaryFallbackAuthorization: { policyRevision: 8 },
      memoryMode: "namespace", actionAuthority: {
        canEdit: true, canArchive: true, canManageAccess: true } }) }),
      content: { ...contentPort([]), prepareUpdate: async () => { throw unknown; },
        prepareOrdinaryFallbackUpdate: async () => fallbackUpdateRequest() } });
    expect(rejected.update(MEMORY_ID, intent, () => {})).rejects.toBe(unknown);
  });

  test("an ordinary update cannot accept a substituted crypto access revision", async () => {
    const protectedClient = client({ api: api({
      getProtectedMemory: async () => ({ dtoVersion: 1, memory: dto(),
        ordinaryFallbackAuthorization: { policyRevision: 8 }, memoryMode: "namespace",
        actionAuthority: { canEdit: true, canArchive: true, canManageAccess: true } }),
      updateProtectedMemory: async () => ({ dtoVersion: 1, status: "ordinary_fallback",
        operationId: "memory-update:fallback", memoryId: MEMORY_ID,
        contentRevision: 2, cryptoAccessRevision: 17, reason: "target_encryption_not_ready" }),
    }), content: { ...contentPort([]),
      prepareUpdate: async () => { throw new AuthorizedHumanMemoryUnavailableError("target_encryption_not_ready"); },
      prepareOrdinaryFallbackUpdate: async () => fallbackUpdateRequest(),
    } });
    const error: unknown = await protectedClient.update(MEMORY_ID, intent, () => {})
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe("Human Memory ordinary fallback receipt was substituted");
  });

  test("invalid opened payload is one corrupt row, not a failed library page", async () => {
    const bad = new TextEncoder().encode("not a Memory payload");
    let opens = 0;
    const protectedClient = client({ api: api({ listProtectedMemories: async () => ({
      dtoVersion: 1, items: [dto(), dto(2)], nextCursor: null, memoryMode: "namespace",
    }) }), content: { ...contentPort([]), openExact: async () =>
      opens++ === 0 ? bad : encodeMemoryPayloadV1(intent.payload) } });
    const displayed: number[] = [];
    const failures: string[] = [];
    await protectedClient.withList({}, ({ projection }) => { displayed.push(projection.contentRevision); },
      ({ reason }) => { failures.push(reason); });
    expect(displayed).toEqual([2]);
    expect(failures).toEqual(["corrupt"]);
    expect(bad.every((byte) => byte === 0)).toBe(true);
    const consumerFailure = new Error("UI callback failed");
    const failure = await protectedClient.withList({}, () => { throw consumerFailure; }, () => {})
      .catch((error: unknown) => error);
    expect(failure).toBe(consumerFailure);
  });

  test("does not classify an arbitrary unavailable-looking opener failure as a key miss", async () => {
    const storageFailure = new Error("storage unavailable");
    const protectedClient = client({ content: {
      ...contentPort([]),
      openExact: async () => { throw storageFailure; },
    } });
    const unavailableRows: unknown[] = [];
    const failure = await protectedClient.withList({}, () => {}, (row) => {
      unavailableRows.push(row);
    }).catch((error: unknown) => error);
    expect(failure).toBe(storageFailure);
    expect(unavailableRows).toEqual([]);
  });

  test("metadata mutation does not repair a touched ordinary-only Shadow row", async () => {
    const pending = { ...dto(), projection: { ...dto().projection, contentRevision: 0 },
      protectedPayload: { status: "pending" as const, reason: "backfill_pending" as const } };
    const original = api();
    let reads = 0;
    let plans = 0;
    const protectedClient = client({ api: api({ getProtectedMemory: async (...args) => {
      const response = await original.getProtectedMemory(...args);
      if ("status" in response) return response;
      reads += 1;
      return { ...response, memory: pending };
    }, planProtectedMemoryRepair: async () => {
      plans++; return { dtoVersion: 1, status: "not_needed", memoryId: MEMORY_ID };
    } }), content: { ...contentPort([]), prepareRepair: async () => {
      throw new Error("Concurrent repair needs no new mutation");
    } } });
    expect(await protectedClient.archive(MEMORY_ID)).toMatchObject({ status: "archived" });
    expect(plans).toBe(0);
    expect(reads).toBe(1);
  });

  test("a concurrently repaired row is refetched and opened, never displayed from repair input", async () => {
    const pending = { ...dto(), projection: { ...dto().projection, contentRevision: 0 },
      protectedPayload: { status: "pending" as const, reason: "backfill_pending" as const } };
    const openedIds: string[] = [];
    let plans = 0;
    const protectedClient = client({
      api: api({ listProtectedMemories: async () => ({ dtoVersion: 1, items: [pending], nextCursor: null, memoryMode: "namespace" }),
        planProtectedMemoryRepair: async () => { plans++; return { dtoVersion: 1, status: "not_needed", memoryId: MEMORY_ID }; } }),
      content: { ...contentPort([]), prepareRepair: async () => { throw new Error("Concurrent repair needs no new mutation"); },
        openExact: async (row) => { openedIds.push(row.protectedPayload.status); return encodeMemoryPayloadV1(intent.payload); } },
    });
    const displayed: string[] = [];
    await protectedClient.withList({}, ({ payload }) => { displayed.push(payload.content); });
    expect(plans).toBe(1);
    expect(openedIds).toEqual(["encrypted"]);
    expect(displayed).toEqual([intent.payload.content]);
  });

  test("repair waiting does not hide independent rows or use ordinary fallback", async () => {
    const pending = { ...dto(), projection: { ...dto().projection, contentRevision: 0 },
      protectedPayload: { status: "pending" as const, reason: "backfill_pending" as const } };
    const protectedClient = client({
      api: api({ listProtectedMemories: async () => ({ dtoVersion: 1, items: [pending, dto()], nextCursor: null, memoryMode: "namespace" }),
        planProtectedMemoryRepair: async () => ({ dtoVersion: 1, status: "unavailable", reason: "target_encryption_not_ready" }) }),
      content: { ...contentPort([]), prepareRepair: async () => { throw new Error("No authority for preparation"); } },
    });
    const displayed: string[] = [];
    const waiting: string[] = [];
    await protectedClient.withList({}, ({ payload }) => { displayed.push(payload.content); },
      ({ reason }) => { waiting.push(reason); });
    expect(displayed).toEqual([intent.payload.content]);
    expect(waiting).toEqual(["backfill_pending"]);
  });

  test("Full missing representations do not request repair or show ordinary content", async () => {
    let plans = 0;
    const missing = { ...dto(), protectedPayload: { status: "unavailable" as const,
      reason: "protected_representation_missing" as const } };
    const protectedClient = client({ owner: bindEncryptionDataOperationOwner({ policy: {
      resolve: async () => ({ policy: { mode: "encrypted_only", shadowBehavior: "fallback" },
        revalidationToken: 1 }), revalidate: async () => {},
    } }), api: api({ listProtectedMemories: async () => ({ dtoVersion: 1,
      items: [missing], nextCursor: null, memoryMode: "namespace" }), planProtectedMemoryRepair: async () => {
        plans++; return { dtoVersion: 1, status: "not_needed", memoryId: MEMORY_ID };
      } }), content: { ...contentPort([]), prepareRepair: async () => { throw new Error("Full cannot repair"); } } });
    const displayed: string[] = [];
    const unavailable: string[] = [];
    await protectedClient.withList({}, ({ payload }) => { displayed.push(payload.content); },
      ({ reason }) => { unavailable.push(reason); });
    expect(plans).toBe(0);
    expect(displayed).toEqual([]);
    expect(unavailable).toEqual(["protected_representation_missing"]);
  });

  test("Shadow forward-repairs an ordinary-only row before displaying it", async () => {
    const missing = { ...dto(), protectedPayload: { status: "unavailable" as const,
      reason: "protected_representation_missing" as const } };
    let plans = 0;
    const protectedClient = client({ api: api({
      listProtectedMemories: async () => ({ dtoVersion: 1, items: [missing],
        nextCursor: null, memoryMode: "namespace" }),
      planProtectedMemoryRepair: async () => { plans += 1; return {
        dtoVersion: 1, status: "not_needed", memoryId: MEMORY_ID,
      }; },
      getProtectedMemory: async () => ({ dtoVersion: 1, memory: dto(),
        memoryMode: "namespace", actionAuthority: { canEdit: true,
          canArchive: true, canManageAccess: true } }),
    }), content: { ...contentPort([]), prepareRepair: async () => {
      throw new Error("Concurrent repair should not prepare again");
    } } });
    const displayed: string[] = [];
    await protectedClient.withList({}, ({ payload }) => {
      displayed.push(payload.content);
    });
    expect(plans).toBe(1);
    expect(displayed).toEqual([intent.payload.content]);
  });
  test("production trusted-port assembly requires no test authority token", async () => {
    const production = createAuthorizedHumanMemoryClientFromTrustedPorts({
      owner: testOwner,
      api: api(), content: contentPort([]), journal: new MemoryMutationJournal(),
      createOperationId: ({ kind }) => `production-${kind}:1`,
    });
    let content = "";
    await production.withDetail(MEMORY_ID, (opened) => {
      content = opened.payload.content;
    });
    expect(content).toBe(intent.payload.content);
  });

  test("opens list/detail/search/brief only inside callbacks and wipes bytes", async () => {
    const openedBuffers: Uint8Array[] = [];
    const protectedClient = client({ content: contentPort(openedBuffers) });
    const seen: string[] = [];
    const use = (opened: Parameters<Parameters<typeof protectedClient.withList>[1]>[0]) => {
      seen.push(`${opened.payload.type}:${opened.payload.content}`);
    };

    const list = await protectedClient.withList({ limit: 10 }, use);
    const detail = await protectedClient.withDetail(MEMORY_ID, use);
    const search = await protectedClient.withSearch({
      q: "private query",
      mode: "semantic",
    }, async (opened, score) => {
      expect(score).toBe(0.75);
      use(opened);
    });
    const brief = await protectedClient.withBrief({}, use);

    expect(seen).toEqual([
      "preference:callback-local private content",
      "preference:callback-local private content",
      "preference:callback-local private content",
      "preference:callback-local private content",
    ]);
    expect(openedBuffers.every((bytes) => bytes.every((byte) => byte === 0)))
      .toBe(true);
    expect(JSON.stringify({ list, detail, search, brief }))
      .not.toContain("callback-local private content");
  });

  test.each(["openai", "openrouter", "venice"] as const)("uses %s with plan + injected signer/encrypter for create and current DTO for update", async (requestedProvider) => {
    const providerIntent = { ...intent, requestedProvider };
    const openedBuffers: Uint8Array[] = [];
    const calls: string[] = [];
    const protectedClient = client({
      content: contentPort(openedBuffers, providerIntent),
      api: api({
        planProtectedMemoryCreate: async () => {
          calls.push("plan");
          return plan;
        },
        createProtectedMemory: async (prepared) => {
          calls.push(`create:${prepared.operationId}`);
          return { dtoVersion: 1, status: "published", memory: dto() };
        },
        getProtectedMemory: async () => {
          calls.push("detail");
          return {
            dtoVersion: 1,
            memory: dto(),
            memoryMode: "namespace",
            actionAuthority: {
              canEdit: true,
              canArchive: true,
              canManageAccess: true,
            },
          };
        },
        updateProtectedMemory: async (_id, prepared) => {
          calls.push(`update:${prepared.operationId}`);
          return { dtoVersion: 1, status: "published", memory: dto(2) };
        },
      }),
    });

    const create = await protectedClient.create(providerIntent, () => undefined);
    const update = await protectedClient.update(
      MEMORY_ID,
      providerIntent,
      () => undefined,
    );
    expect(create).toEqual({ status: "published", memoryId: MEMORY_ID });
    expect(update).toEqual({ status: "published", memoryId: MEMORY_ID });
    expect(calls).toEqual([
      "plan",
      "create:memory-create:1",
      "detail",
      "update:memory-update:1",
    ]);
    expect(openedBuffers.every((bytes) => bytes.every((byte) => byte === 0)))
      .toBe(true);
  });

  test("uses exact content-free receipts for archive, tier, and restore without journaling", async () => {
    const journal = new MemoryMutationJournal();
    const tiers: ProtectedMemoryDtoV1[] = [dto(2, 2), dto(2, 2), dto(2, 3, 2)];
    const protectedClient = client({
      journal,
      api: api({
        getProtectedMemory: async () => ({
          dtoVersion: 1,
          memory: tiers.shift()!,
          memoryMode: "namespace",
          actionAuthority: {
            canEdit: true,
            canArchive: true,
            canManageAccess: false,
          },
        }),
      }),
    });

    expect(await protectedClient.archive(MEMORY_ID)).toEqual({
      status: "archived",
      memoryId: MEMORY_ID,
      tier: 3,
    });
    expect(await protectedClient.transitionTier(MEMORY_ID, "promote")).toEqual({
      status: "promoted",
      memoryId: MEMORY_ID,
      previousTier: 2,
      nextTier: 1,
    });
    expect(await protectedClient.restore(MEMORY_ID)).toEqual({
      status: "restored",
      memoryId: MEMORY_ID,
      previousTier: 3,
      nextTier: 2,
    });
    expect(journal.mutations.size).toBe(0);
  });

  test("metadata mutations use authorized structure without body repair or decryption", async () => {
    let repairs = 0;
    let opens = 0;
    const pending = (tier: 1 | 2 | 3, demotedFrom?: 1 | 2): ProtectedMemoryDtoV1 => ({
      ...dto(4, tier, demotedFrom),
      protectedPayload: { status: "pending", reason: "backfill_pending" },
    });
    const current = [pending(2), pending(2), pending(3, 2)];
    const protectedClient = client({
      api: api({
        getProtectedMemory: async () => ({ dtoVersion: 1,
          memory: current.shift()!, memoryMode: "namespace",
          actionAuthority: { canEdit: true, canArchive: true,
            canManageAccess: false } }),
        planProtectedMemoryRepair: async () => {
          repairs += 1;
          throw new Error("metadata must not plan body repair");
        },
      }),
      content: {
        ...contentPort([]),
        openExact: async () => {
          opens += 1;
          throw new Error("metadata must not open body content");
        },
      },
    });

    expect(await protectedClient.archive(MEMORY_ID)).toMatchObject({
      status: "archived", tier: 3,
    });
    expect(await protectedClient.transitionTier(MEMORY_ID, "promote")).toMatchObject({
      status: "promoted", previousTier: 2, nextTier: 1,
    });
    expect(await protectedClient.restore(MEMORY_ID)).toMatchObject({
      status: "restored", previousTier: 3, nextTier: 2,
    });
    expect({ repairs, opens }).toEqual({ repairs: 0, opens: 0 });
  });

  test("metadata mutations still reject denied structural authority", async () => {
    let archiveCalls = 0;
    const protectedClient = client({ api: api({
      getProtectedMemory: async () => ({ dtoVersion: 1,
        memory: { ...dto(), protectedPayload: {
          status: "pending", reason: "backfill_pending" } },
        memoryMode: "namespace", actionAuthority: {
          canEdit: true, canArchive: false, canManageAccess: false } }),
      archiveProtectedMemory: async (_memoryId, request) => {
        archiveCalls += 1;
        return { dtoVersion: 1, operationId: request.operationId,
          status: "archived", memoryId: MEMORY_ID,
          contentRevision: request.expectedContentRevision,
          cryptoAccessRevision: request.expectedCryptoAccessRevision, tier: 3 };
      },
    }) });

    const failure = await protectedClient.archive(MEMORY_ID)
      .catch((error: unknown) => error);
    expect(failure).toEqual(
      new AuthorizedHumanMemoryUnavailableError("authorization_required"));
    expect(archiveCalls).toBe(0);
  });

  test("updates and archives a granted exact M:N audience without collapsing it", async () => {
    const journal = new MemoryMutationJournal();
    const updated = sharedDto(2);
    updated.projection.cryptoAccessRevision = 0;
    const currentDetails = [sharedDto(), updated];
    const archivedRequests: Parameters<ProtectedApi["archiveProtectedMemory"]>[1][] = [];
    const baseContent = contentPort([]);
    const protectedClient = client({
      journal,
      content: {
        ...baseContent,
        prepareUpdate: async ({ current }) => {
          expect(current.projection.requiredNamespaceIds)
            .toEqual([NAMESPACE_ID, NAMESPACE_B]);
          return preparedSharedUpdate();
        },
      },
      api: api({
        getProtectedMemory: async () => ({
          dtoVersion: 1,
          memory: currentDetails.shift()!,
          memoryMode: "namespace",
          actionAuthority: {
            canEdit: true,
            canArchive: true,
            canManageAccess: true,
          },
        }),
        updateProtectedMemory: async (_memoryId, request) => {
          if ("publicationKind" in request) {
            throw new TypeError("unexpected ordinary fallback request");
          }
          expect(request.requiredNamespaceIds)
            .toEqual([NAMESPACE_ID, NAMESPACE_B]);
          expect(request.namespaceEnvelopes.map(({ namespaceId }) => namespaceId))
            .toEqual([NAMESPACE_ID, NAMESPACE_B]);
          return { dtoVersion: 1, status: "published", memory: updated };
        },
        archiveProtectedMemory: async (_memoryId, request) => {
          archivedRequests.push(request);
          return {
            dtoVersion: 1,
            operationId: request.operationId,
            status: "archived",
            memoryId: MEMORY_ID,
            contentRevision: request.expectedContentRevision,
            cryptoAccessRevision: request.expectedCryptoAccessRevision,
            tier: 3,
          };
        },
      }),
    });

    expect(await protectedClient.update(MEMORY_ID, intent, () => undefined))
      .toEqual({ status: "published", memoryId: MEMORY_ID });
    expect(await protectedClient.archive(MEMORY_ID)).toEqual({
      status: "archived",
      memoryId: MEMORY_ID,
      tier: 3,
    });
    expect(archivedRequests).toHaveLength(1);
    expect(archivedRequests[0]).toMatchObject({
      expectedContentRevision: 2,
      expectedCryptoAccessRevision: 0,
    });
  });

  test("keeps exact prepared content update after response loss and replays it", async () => {
    const journal = new MemoryMutationJournal();
    const sent: ProtectedMemoryPreparedUpdateRequestV1[] = [];
    const interrupted = client({
      journal,
      api: api({
        updateProtectedMemory: async (_memoryId, request) => {
          if ("publicationKind" in request) throw new Error("Expected protected update");
          sent.push(structuredClone(request));
          throw new Error("response lost after update commit");
        },
      }),
    });
    expect(interrupted.update(MEMORY_ID, intent, () => undefined))
      .rejects.toThrow("response lost after update commit");
    expect(journal.mutations.size).toBe(1);

    const restarted = client({
      journal,
      api: api({
        updateProtectedMemory: async (_memoryId, request) => {
          if ("publicationKind" in request) throw new Error("Expected protected update");
          sent.push(structuredClone(request));
          return { dtoVersion: 1, status: "replayed", memory: dto(2) };
        },
      }),
    });
    expect(await restarted.retryPendingMutations()).toBe(1);
    expect(journal.mutations.size).toBe(0);
    expect(sent).toEqual([preparedUpdate(), preparedUpdate()]);
  });

  test("continues a bounded retry batch after one retained mutation fails", async () => {
    const journal = new MemoryMutationJournal();
    await journal.putBeforeSend({
      kind: "update",
      memoryId: MEMORY_ID,
      request: preparedUpdate(),
    });
    await journal.putBeforeSend({ kind: "access", memoryId: MEMORY_ID,
      request: preparedAccess() });
    let deletionAttempts = 0;
    const restarted = client({
      journal,
      api: api({
        updateProtectedMemory: async () => {
          throw new Error("provider remains unavailable");
        },
        commitProtectedMemoryAccess: async (_memoryId, request) => {
          deletionAttempts += 1;
          return {
            dtoVersion: 1,
            operationId: request.operationId,
            status: "replayed",
            memoryId: MEMORY_ID,
            cryptoAccessRevision: request.nextCryptoAccessRevision,
            requiredNamespaceIds: request.targetNamespaceIds,
          };
        },
      }),
    });

    expect(await restarted.retryPendingMutations()).toBe(1);
    expect(deletionAttempts).toBe(1);
    expect([...journal.mutations.keys()]).toEqual(["memory-update:1"]);
  });

  test("rejects an unauthorized update before device preparation", async () => {
    let prepared = 0;
    const protectedClient = client({
      api: api({
        getProtectedMemory: async () => ({
          dtoVersion: 1,
          memory: dto(),
          memoryMode: "namespace",
          actionAuthority: {
            canEdit: false,
            canArchive: true,
            canManageAccess: false,
          },
        }),
      }),
      content: {
        ...contentPort([]),
        prepareUpdate: async () => {
          prepared += 1;
          return preparedUpdate();
        },
      },
    });

    expect(protectedClient.update(MEMORY_ID, intent, () => undefined))
      .rejects.toEqual(new AuthorizedHumanMemoryUnavailableError(
        "authorization_required",
      ));
    expect(prepared).toBe(0);
  });

  test("journal backpressure rejects preparation while reads remain available", async () => {
    const journal = new MemoryMutationJournal();
    journal.full = true;
    let plans = 0;
    let prepares = 0;
    const protectedClient = client({
      journal,
      api: api({
        planProtectedMemoryCreate: async () => {
          plans += 1;
          return plan;
        },
      }),
      content: {
        ...contentPort([]),
        prepareCreate: async () => {
          prepares += 1;
          return preparedCreate();
        },
      },
    });

    expect(protectedClient.create(intent, () => undefined)).rejects.toThrow(
      "journal is full",
    );
    expect(plans).toBe(0);
    expect(prepares).toBe(0);
    expect(await protectedClient.withList({}, () => undefined)).toMatchObject({
      memoryMode: "namespace",
    });
  });

  test("typed unavailable fails closed before opener or any legacy fallback", async () => {
    let opened = 0;
    const protectedClient = client({
      api: api({
        listProtectedMemories: async () => ({
          dtoVersion: 1,
          status: "unavailable",
          reason: "authorization_required",
        }),
      }),
      content: {
        ...contentPort([]),
        openExact: async () => {
          opened += 1;
          return new Uint8Array([1]);
        },
      },
    });
    let unavailableError: unknown;
    try {
      await protectedClient.withList({}, () => undefined);
    } catch (error) {
      unavailableError = error;
    }
    expect(unavailableError).toEqual(new AuthorizedHumanMemoryUnavailableError(
      "authorization_required",
    ));
    expect(opened).toBe(0);
  });

  test.each(["shadow_pending", "backfill_pending"] as const)(
    "list, search, and brief preserve independent rows when %s is unavailable", async (pendingReason) => {
    const pending: ProtectedMemoryDtoV1 = {
      ...dto(2),
      projection: {
        ...dto(2).projection,
        memoryId: "55555555-5555-4555-8555-555555555555",
        readAuthorities: [],
      },
      protectedPayload: {
        status: "pending",
        reason: pendingReason,
      },
    };
    const protectedClient = client({
      content: {
        ...contentPort([]),
        prepareRepair: async () => { throw new Error("unavailable plan must not prepare"); },
      },
      api: api({
        planProtectedMemoryRepair: async () => ({
          dtoVersion: 1, status: "unavailable", reason: "stale_revision",
        }),
        listProtectedMemories: async () => ({
          dtoVersion: 1,
          items: [dto(), pending],
          nextCursor: null,
          memoryMode: "namespace",
        }),
        searchProtectedMemories: async () => ({
          dtoVersion: 1,
          items: [
            { memory: dto(), score: 0.75 },
            { memory: pending, score: 0.25 },
          ],
          memoryMode: "namespace",
          queryDisclosure: "embedding_provider",
        }),
        getProtectedMemoryBrief: async () => ({
          dtoVersion: 1,
          items: [pending, dto()],
          memoryMode: "namespace",
        }),
      }),
    });
    const opened: string[] = [];
    const unavailableRows: Array<Readonly<{
      memoryId: string;
      reason: string;
      score?: number;
    }>> = [];
    const use = ({ projection }: { projection: ProtectedMemoryDtoV1["projection"] }) => {
      opened.push(projection.memoryId);
    };
    const unavailable = (input: {
      projection: ProtectedMemoryDtoV1["projection"];
      reason: string;
      score?: number;
    }) => {
      unavailableRows.push({
        memoryId: input.projection.memoryId,
        reason: input.reason,
        ...(input.score === undefined ? {} : { score: input.score }),
      });
    };

    await protectedClient.withList({}, use, unavailable);
    await protectedClient.withSearch({ q: "private", mode: "semantic" }, use,
      unavailable);
    await protectedClient.withBrief({}, use, unavailable);

    expect(opened).toEqual([MEMORY_ID, MEMORY_ID, MEMORY_ID]);
    const reason = pendingReason === "backfill_pending" ? "stale_revision" : "shadow_pending";
    expect(unavailableRows).toEqual([
      { memoryId: pending.projection.memoryId, reason },
      { memoryId: pending.projection.memoryId, reason,
        score: 0.25 },
      { memoryId: pending.projection.memoryId, reason },
    ]);
  });

  test("durably retries the exact signed access update after response loss and restart", async () => {
    const journal = new MemoryMutationJournal();
    const sent: ProtectedMemoryPreparedAccessRequestV1[] = [];
    const interrupted = client({
      journal,
      api: api({
        commitProtectedMemoryAccess: async (_memoryId, request) => {
          sent.push(structuredClone(request));
          throw new Error("response lost after commit");
        },
      }),
    });

    expect(interrupted.deleteAuthorizedView(MEMORY_ID)).rejects.toThrow(
      "response lost after commit",
    );
    expect([...journal.mutations.values()].map((item) => item.mutation.request))
      .toEqual([preparedAccess()]);

    const restarted = client({
      journal,
      api: api({
        commitProtectedMemoryAccess: async (_memoryId, request) => {
          sent.push(structuredClone(request));
          return {
            dtoVersion: 1,
            operationId: request.operationId,
            status: "replayed",
            memoryId: MEMORY_ID,
            cryptoAccessRevision: request.nextCryptoAccessRevision,
            requiredNamespaceIds: request.targetNamespaceIds,
          };
        },
      }),
    });
    expect(await restarted.retryPendingMutations()).toBe(1);
    expect(journal.mutations.size).toBe(0);
    expect(sent).toEqual([preparedAccess(), preparedAccess()]);
  });

  test("gates authorized-view removal on exact access management authority", async () => {
    let planned = 0;
    const protectedClient = client({
      api: api({
        getProtectedMemory: async () => ({
          dtoVersion: 1, memory: dto(), memoryMode: "namespace",
          actionAuthority: { canEdit: true, canArchive: true,
            canManageAccess: false },
        }),
        planProtectedMemoryAccess: async () => {
          planned += 1;
          return accessPlan;
        },
      }),
    });
    expect("deleteConnection" in protectedClient).toBeFalse();
    expect("deleteAuthorizedView" in protectedClient).toBeTrue();
    expect(protectedClient.deleteAuthorizedView(MEMORY_ID)).rejects.toEqual(
      new AuthorizedHumanMemoryUnavailableError("authorization_required"),
    );
    expect(planned).toBe(0);
  });

  test("does not send an exact authorized-view removal until journal custody succeeds", async () => {
    let sent = 0;
    const protectedClient = client({
      journal: new class extends MemoryMutationJournal {
        override putBeforeSend(): ReturnType<
          AuthorizedHumanMemoryPreparedMutationJournal["putBeforeSend"]
        > {
          return Promise.reject(new Error("vault write failed"));
        }
      }(),
      api: api({
        commitProtectedMemoryAccess: async (_memoryId, request) => {
          sent += 1;
          return {
            dtoVersion: 1,
            operationId: request.operationId,
            status: "updated",
            memoryId: MEMORY_ID,
            cryptoAccessRevision: request.nextCryptoAccessRevision,
            requiredNamespaceIds: request.targetNamespaceIds,
          };
        },
      }),
    });

    expect(protectedClient.deleteAuthorizedView(MEMORY_ID)).rejects.toThrow(
      "vault write failed",
    );
    expect(sent).toBe(0);
  });

  test("typed-fails before journal custody when v3 access custody is unavailable", async () => {
    const journal = new MemoryMutationJournal();
    const protectedClient = client({
      journal,
      content: {
        ...contentPort([]),
        prepareAccess: async () => {
          throw new AuthorizedHumanMemoryUnavailableError("unsupported_version");
        },
      },
    });
    expect(protectedClient.deleteAuthorizedView(MEMORY_ID)).rejects.toEqual(
      new AuthorizedHumanMemoryUnavailableError("unsupported_version"),
    );
    expect(journal.mutations.size).toBe(0);
  });

  test("retains the exact journal request for typed retryable denial", async () => {
    const journal = new MemoryMutationJournal();
    const protectedClient = client({
      journal,
      api: api({
        commitProtectedMemoryAccess: async () => ({
          dtoVersion: 1,
          status: "unavailable",
          reason: "authorization_required",
        }),
      }),
    });

    expect(protectedClient.deleteAuthorizedView(MEMORY_ID)).rejects.toEqual(
      new AuthorizedHumanMemoryUnavailableError("authorization_required"),
    );
    expect([...journal.mutations.values()].map((item) => item.mutation.request))
      .toEqual([preparedAccess()]);
  });

  test("does not journal or prepare an unchanged exact target", async () => {
    const journal = new MemoryMutationJournal();
    let prepared = 0;
    const protectedClient = client({
      journal,
      api: api({
        planProtectedMemoryAccess: async () => ({
          dtoVersion: 1,
          status: "unchanged",
          memoryId: MEMORY_ID,
          cryptoAccessRevision: 0,
          requiredNamespaceIds: [NAMESPACE_ID],
        }),
      }),
      content: {
        ...contentPort([]),
        prepareAccess: async () => {
          prepared += 1;
          return preparedAccess();
        },
      },
    });
    expect(await protectedClient.grantUser(MEMORY_ID, "bob")).toEqual({
      status: "unchanged",
      memoryId: MEMORY_ID,
    });
    expect(prepared).toBe(0);
    expect(journal.mutations.size).toBe(0);
  });

  test("prepares exact Namespace readiness once and replans the Human share", async () => {
    let plans = 0;
    const readiness: Array<Readonly<{ sourceRoomId: string;
      requiredNamespaceIds: readonly string[] }>> = [];
    const protectedClient = client({
      api: api({
        planProtectedMemoryAccess: async () => ++plans === 1 ? {
          dtoVersion: 1,
          status: "readiness_required",
          reason: "target_encryption_not_ready",
          memoryId: MEMORY_ID,
          sourceRoomId: ROOM_ID,
          requiredNamespaceIds: [NAMESPACE_B],
        } : accessPlan,
      }),
      content: {
        ...contentPort([]),
        prepareAccessReadiness: async ({ sourceRoomId, requiredNamespaceIds }) => {
          readiness.push({ sourceRoomId, requiredNamespaceIds });
        },
      },
    });
    expect(await protectedClient.grantUser(MEMORY_ID, "bob")).toEqual({
      status: "updated", memoryId: MEMORY_ID,
    });
    expect(plans).toBe(2);
    expect(readiness).toEqual([{ sourceRoomId: ROOM_ID,
      requiredNamespaceIds: [NAMESPACE_B] }]);
  });

  test("rejects substituted or repeated Human share readiness hints", async () => {
    const readiness = (sourceRoomId: string, memoryId = MEMORY_ID) => ({
      dtoVersion: 1 as const,
      status: "readiness_required" as const,
      reason: "target_encryption_not_ready" as const,
      memoryId,
      sourceRoomId,
      requiredNamespaceIds: [NAMESPACE_B],
    });
    let prepared = 0;
    const substituted = client({ api: api({
      planProtectedMemoryAccess: async () => readiness(MEMORY_ID),
    }), content: { ...contentPort([]), prepareAccessReadiness: async () => {
      prepared += 1;
    } } });
    let substitutedError: unknown;
    try {
      await substituted.grantUser(MEMORY_ID, "bob");
    } catch (error) {
      substitutedError = error;
    }
    expect(substitutedError).toBeInstanceOf(TypeError);
    expect((substitutedError as Error).message)
      .toContain("readiness target was substituted");
    expect(prepared).toBe(0);

    const wrongMemory = client({ api: api({
      planProtectedMemoryAccess: async () => readiness(ROOM_ID, NAMESPACE_B),
    }), content: { ...contentPort([]), prepareAccessReadiness: async () => {
      prepared += 1;
    } } });
    let wrongMemoryError: unknown;
    try {
      await wrongMemory.grantUser(MEMORY_ID, "bob");
    } catch (error) {
      wrongMemoryError = error;
    }
    expect(wrongMemoryError).toBeInstanceOf(TypeError);
    expect((wrongMemoryError as Error).message)
      .toContain("readiness target was substituted");
    expect(prepared).toBe(0);

    let plans = 0;
    const repeated = client({ api: api({
      planProtectedMemoryAccess: async () => {
        plans += 1;
        return readiness(ROOM_ID);
      },
    }), content: { ...contentPort([]), prepareAccessReadiness: async () => {
      prepared += 1;
    } } });
    let repeatedError: unknown;
    try {
      await repeated.grantUser(MEMORY_ID, "bob");
    } catch (error) {
      repeatedError = error;
    }
    expect(repeatedError).toEqual(new AuthorizedHumanMemoryUnavailableError(
      "target_encryption_not_ready",
    ));
    expect(plans).toBe(2);
    expect(prepared).toBe(1);
  });

  test("rejects an inexact M:N access delta before preparation or custody", async () => {
    const journal = new MemoryMutationJournal();
    let prepared = 0;
    const protectedClient = client({
      journal,
      api: api({
        planProtectedMemoryAccess: async () => ({
          ...accessPlan,
          addedNamespaceIds: [],
        }),
      }),
      content: {
        ...contentPort([]),
        prepareAccess: async () => {
          prepared += 1;
          return preparedAccess();
        },
      },
    });
    expect(protectedClient.grantUser(MEMORY_ID, "bob")).rejects.toThrow(
      "access plan is stale or substituted",
    );
    expect(prepared).toBe(0);
    expect(journal.mutations.size).toBe(0);
  });

  test("rejects forged authority and substituted prepared coordinates", async () => {
    expect(() => createAuthorizedHumanMemoryClient({
      authority: Object.freeze({}) as Parameters<
        typeof createAuthorizedHumanMemoryClient
      >[0]["authority"],
      api: api(),
      content: contentPort([]),
      journal: new MemoryMutationJournal(),
      createOperationId: ({ kind }) => `memory-${kind}:1`,
    })).toThrow("test authority is invalid");

    const protectedClient = client({
      content: {
        ...contentPort([]),
        prepareCreate: async () => ({
          ...preparedCreate(),
          operationId: "substituted-operation",
        }),
      },
    });
    let substitutionError: unknown;
    try {
      await protectedClient.create(intent, () => undefined);
    } catch (error) {
      substitutionError = error;
    }
    expect(substitutionError).toBeInstanceOf(TypeError);
    expect((substitutionError as Error).message)
      .toContain("does not match its plan");
  });

  test("rejects a publication receipt that substitutes non-genesis access", async () => {
    const protectedClient = client({
      api: api({
        createProtectedMemory: async () => ({
          dtoVersion: 1,
          status: "published",
          memory: {
            ...dto(),
            projection: { ...dto().projection, cryptoAccessRevision: 1 },
          },
        }),
      }),
    });
    expect(protectedClient.create(intent, () => undefined)).rejects.toThrow(
      "publication was substituted",
    );
  });

  test("caller/config cannot inject authorization revisions, device ids, or keys", async () => {
    let planCalls = 0;
    let prepareCalls = 0;
    const protectedClient = client({
      api: api({
        planProtectedMemoryCreate: async () => {
          planCalls += 1;
          return plan;
        },
      }),
      content: {
        ...contentPort([]),
        prepareCreate: async () => {
          prepareCalls += 1;
          return preparedCreate();
        },
      },
    });
    const injected = {
      ...intent,
      hostAuthorizationRevision: 999,
      deviceId: "attacker-device",
      signingPrivateKey: "must-not-be-configurable",
    } as AuthorizedHumanMemoryWriteIntentV1;
    let error: unknown;
    try {
      await protectedClient.create(injected, () => undefined);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain("write intent is invalid");
    expect(planCalls).toBe(0);
    expect(prepareCalls).toBe(0);
  });

  test("uses an authorized ordinary fallback only for typed protected availability", async () => {
    const fallbackMemory: ProtectedMemoryDtoV1 = {
      ...dto(),
      ordinaryFallback: {
        policyRevision: 17,
        payload: { formatVersion: 1, type: "preference", content: "ordinary sibling" },
      },
    };
    const protectedClient = client({
      api: api({ getProtectedMemory: async () => ({ dtoVersion: 1,
        memory: fallbackMemory, memoryMode: "namespace", actionAuthority: {
          canEdit: true, canArchive: true, canManageAccess: true } }) }),
      content: { ...contentPort([]), openExact: async () => {
        throw new AuthorizedHumanMemoryUnavailableError("lost_key_material");
      } },
    });
    let opened: Parameters<Parameters<typeof protectedClient.withDetail>[1]>[0] | undefined;
    await protectedClient.withDetail(MEMORY_ID, (value) => { opened = value; });
    expect(opened).toEqual({
      representation: "ordinary_fallback",
      projection: fallbackMemory.projection,
      payload: { formatVersion: 1, type: "preference", content: "ordinary sibling" },
      policyRevision: 17,
    });
  });

  test("prefers protected content and never downgrades integrity or unknown failures", async () => {
    const fallbackMemory: ProtectedMemoryDtoV1 = {
      ...dto(),
      ordinaryFallback: { policyRevision: 17,
        payload: { formatVersion: 1, type: "preference", content: "ordinary sibling" } },
    };
    const details = async () => ({ dtoVersion: 1 as const,
      memory: fallbackMemory, memoryMode: "namespace" as const,
      actionAuthority: { canEdit: true, canArchive: true, canManageAccess: true } });
    const protectedClient = client({ api: api({ getProtectedMemory: details }) });
    let representation = "";
    await protectedClient.withDetail(MEMORY_ID, (value) => {
      representation = value.representation;
      expect(value.payload.content).toBe(intent.payload.content);
    });
    expect(representation).toBe("protected");

    for (const failure of [
      new AuthorizedHumanMemoryUnavailableError("integrity_failure"),
      new AuthorizedHumanMemoryUnavailableError("authorization_required"),
      new AuthorizedHumanMemoryUnavailableError("stale_revision"),
      new Error("storage unavailable"),
    ]) {
      const denied = client({ api: api({ getProtectedMemory: details }),
        content: { ...contentPort([]), openExact: async () => { throw failure; } } });
      const caught = await denied.withDetail(MEMORY_ID, () => {
        throw new Error("ordinary fallback must not be displayed");
      }).catch((error: unknown) => error);
      expect(caught).toBe(failure);
    }
  });
});
