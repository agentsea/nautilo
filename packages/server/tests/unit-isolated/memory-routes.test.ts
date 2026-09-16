/**
 * D234 — memory REST routes (hermetic).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import {
  NautiloApiClient,
  type MemoryProcessorRecipientV1,
  type NautiloApiFetch,
} from "@nautilo/api-client";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { sealForegroundMemoryProcessorRequest } from "@nautilo/lattice-bridge";
import {
  createHumanMemoryProtectedRoutePorts,
  type HumanMemoryProtectedProductRoutePort,
} from "@nautilo/lattice-bridge/server";
import {
  __mintHumanMemoryProtectedRouteTestAuthorityForTesting,
} from "@nautilo/lattice-bridge/testing";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import * as actualTrust from "@nautilo/trust";
import * as actualDb from "@nautilo/db";
import type {
  ProtectedMemoryRouteComposition,
  ProtectedMemoryRoutePorts,
} from "../../src/routes/protected-memory-composition";

const UUID_MEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_NS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const namespaceAuthority = { sourceRoomId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  namespaceId: UUID_NS, currentGeneration: 0,
  retainedGenerations: [{ generation: 0, accessRevision: 0,
    headDigestBase64url: "AA", publicationDigestBase64url: "AA",
    publicationSetDigestBase64url: "AA", audienceFingerprintBase64url: "AA" }] };

function protectedDeleteRequest() {
  return {
    requestVersion: 1 as const,
    operationId: "memory-delete:request-1",
    memoryId: UUID_MEM,
    expectedContentRevision: 2,
    expectedCryptoAccessRevision: 3,
    deletionAccessRevision: 4,
    cryptoObjectId: `nautilo-memory-v1:${UUID_MEM}:2`,
    requiredNamespaceIds: [UUID_NS],
    deletionAccessManifestBytesBase64url: "ZGVsZXRpb24tbWFuaWZlc3Q",
  };
}
const UUID_ROOM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UUID_SCOPE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type MemoryDetail = import("../../../agent/src/store/memory-store").MemoryDetail;
type HardDeleteResult = import("../../../agent/src/store/memory-store").HardDeleteMemoryResult;
type MemoryActionAuthority = {
  canEdit: boolean;
  canArchive: boolean;
  canHardDelete: boolean;
  canManageAccess: boolean;
};

function parseActionAuthority(body: string): MemoryActionAuthority {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || !("actionAuthority" in parsed)) {
    throw new Error("Missing action authority in memory detail response");
  }
  const authority = parsed.actionAuthority;
  if (
    typeof authority !== "object" ||
    authority === null
  ) {
    throw new Error("Invalid action authority in memory detail response");
  }
  const candidate = authority as Record<string, unknown>;
  if (
    typeof candidate["canEdit"] !== "boolean" ||
    typeof candidate["canArchive"] !== "boolean" ||
    typeof candidate["canHardDelete"] !== "boolean" ||
    typeof candidate["canManageAccess"] !== "boolean"
  ) {
    throw new Error("Invalid action authority in memory detail response");
  }
  return {
    canEdit: candidate["canEdit"],
    canArchive: candidate["canArchive"],
    canHardDelete: candidate["canHardDelete"],
    canManageAccess: candidate["canManageAccess"],
  };
}

const listMemoriesMock = mock(async () => ({ items: [], nextCursor: null }));
const getMemoryByIdMock = mock(async (): Promise<MemoryDetail | null | "forbidden"> => null);
const getPromptBriefMock = mock(async () => "");
const getPromptBriefReadOnlyMock = mock(async () => "");
const demoteMemoryMock = mock(async () => undefined);
const archiveMemoryMock = mock(async () => undefined);
const archiveScopeMemoryMock = mock(async () => undefined);
const hardDeleteMemoryMock = mock(async (): Promise<HardDeleteResult> => ({ status: "deleted" }));
const updateMemoryMock = mock(async () => undefined);
const searchMemoryMock = mock(async () => []);
const getMemoryNamespacesMock = mock(async (): Promise<string[]> => []);
const attachMemoryToNamespaceMock = mock(async () => undefined);
const detachMemoryFromNamespaceMock = mock(async () => undefined);
const listScopeMemoriesMock = mock(async () => ({ items: [{ id: UUID_MEM, type: "fact", content: "scope fact" }], nextCursor: null }));
const getScopeMemoryByIdMock = mock(async (): Promise<MemoryDetail | null> => null);
const resolveSpeakerUserIdMock = mock(async () => "speaker-1");
const userHasCapabilityMock = mock(async (_uid: string, cap: string) =>
  cap === "read_memories" || cap === "manage_memories",
);
const findRoomsByNamespaceIdsMock = mock(async (_namespaceIds: string[]) =>
  new Map<string, { humanActorIds: string[] }>());
const resolveActorsDisplayMapMock = mock(async (_actorIds: string[]) =>
  new Map<string, { userHandle: string; displayName: string }>());

mock.module("@nautilo/db", () => ({
  ...actualDb,
  getSharedDirectDb: () => {
    throw new Error("Hermetic Memory route tests must not query a real database");
  },
}));

mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  userHasCapability: userHasCapabilityMock,
  resolveSpeakerUserId: resolveSpeakerUserIdMock,
  findRoomsByNamespaceIds: findRoomsByNamespaceIdsMock,
  resolveActorsDisplayMap: resolveActorsDisplayMapMock,
}));

mock.module("../../../agent/src/store/memory-store", () => ({
  lockAtomicProjectionDestinationAuthority: () => { throw new Error("Projection is outside this route fixture"); },
  commitForegroundMemoryOrdinaryFallback: () => { throw new Error("Unexpected Agent Memory fallback from a Human route"); },
  // Background publication is imported transitively but must never run in route tests.
  findMemorySaveTarget: () => { throw new Error("Unexpected background Memory publication"); },
  saveMemoryWithDb: () => { throw new Error("Unexpected background Memory publication"); },
  replaceMemoryWithDb: () => { throw new Error("Unexpected background Memory publication"); },
  demoteMemoryWithDb: () => { throw new Error("Unexpected background Memory publication"); },
  promoteMemoryWithDb: () => { throw new Error("Unexpected background Memory publication"); },
  getPromptBrief: getPromptBriefMock,
  getPromptBriefReadOnly: getPromptBriefReadOnlyMock,
  selectPromptBriefMemories: async () => [],
  loadPromptBriefMemoryOrdinarySelections: () => { throw new Error("Unexpected prompt body loading in Memory route test"); },
  stagePromptBriefMemoryStructuralPage: () => { throw new Error("Unexpected prompt selection in Memory route test"); },
  packOpenedPromptBriefMemories: () => { throw new Error("Unexpected prompt packing in Memory route test"); },
  stagePromptBriefMemories: async () => ({ selected: [], overflow: [] }),
  commitPromptBriefMemoryOverflow: async () => undefined,
  attachMemoryToNamespace: attachMemoryToNamespaceMock,
  detachMemoryFromNamespace: detachMemoryFromNamespaceMock,
  getMemoryNamespaces: getMemoryNamespacesMock,
  saveMemory: async () => ({ id: UUID_MEM, action: "created" as const }),
  replaceMemory: async () => undefined,
  promoteMemory: async () => undefined,
  searchMemory: searchMemoryMock,
  listMemories: listMemoriesMock,
  countMemories: async () => 0,
  getMemoryById: getMemoryByIdMock,
  demoteMemory: demoteMemoryMock,
  archiveMemory: archiveMemoryMock,
  hardDeleteMemory: hardDeleteMemoryMock,
  updateMemory: updateMemoryMock,
  decodeMemoryListCursor: () => null,
  encodeMemoryListCursor: () => "",
  setMemoryAuditSink: () => {},
  emitMemoryAudit: () => {},
  assertNamespaceWriteAccess: () => {},
  // Imported transitively by D476 projection sharing; routes under test never invoke it.
  executeAtomicProjectionMemory: async () => {
    throw new Error("executeAtomicProjectionMemory must not run in memory route tests");
  },
  fingerprintProjectionReadableAuthority: () => "test-projection-readable-authority",
}));

mock.module("../../../agent/src/store/scope-memory-store", () => ({
  // Background publication is imported transitively but must never run in route tests.
  findScopeMemorySaveTarget: () => { throw new Error("Unexpected background Memory publication"); },
  saveScopeMemoryWithDb: () => { throw new Error("Unexpected background Memory publication"); },
  replaceScopeMemoryWithDb: () => { throw new Error("Unexpected background Memory publication"); },
  demoteScopeMemoryWithDb: () => { throw new Error("Unexpected background Memory publication"); },
  promoteScopeMemoryWithDb: () => { throw new Error("Unexpected background Memory publication"); },
  ScopeMemoryMutationError: class ScopeMemoryMutationError extends Error {},
  listScopeMemories: listScopeMemoriesMock,
  getScopeMemoryById: getScopeMemoryByIdMock,
  searchScopeMemory: async () => [],
  demoteScopeMemory: async () => undefined,
  archiveScopeMemory: archiveScopeMemoryMock,
  hardDeleteScopeMemory: async () => ({ status: "deleted" as const }),
  updateScopeMemory: async () => undefined,
  saveScopeMemory: async () => ({ id: UUID_MEM, action: "created" as const }),
  replaceScopeMemory: async () => undefined,
  promoteScopeMemory: async () => undefined,
}));

const writeSecurityAuditEventMock = mock(() => {});

mock.module("../../src/lib/security-audit-log", () => ({
  writeSecurityAuditEvent: writeSecurityAuditEventMock,
}));

const { memoryRoutes } = await import("../../src/routes/memory");

const allowOrdinaryShadowBoundary = async () => ({
  result: { disposition: "ordinary" },
}) as never;
const {
  __mintProtectedMemoryTestShadowAuthorityForTesting,
  createProtectedMemoryTestShadowComposition,
} = await import("../../src/routes/protected-memory-composition");

function protectedDto() {
  return {
    dtoVersion: 1 as const,
    projection: {
      memoryId: UUID_MEM,
      contentRevision: 2,
      cryptoAccessRevision: 3,
      importance: 0.7,
      tier: 1,
      createdAt: "2026-08-10T08:00:00.000Z",
      updatedAt: "2026-08-10T09:00:00.000Z",
      namespaceIds: [UUID_NS],
      requiredNamespaceIds: [UUID_NS],
      readAuthorities: [namespaceAuthority],
    },
    protectedPayload: {
      status: "encrypted" as const,
      cryptoObjectId: "memory-object-1",
      payloadVersion: 1 as const,
      encryptedPayloadBytesBase64url: "AQ",
      accessManifestBytesBase64url: "Ag",
      accessSignerEvidence: [],
      namespaceEnvelopes: [{
        namespaceId: UUID_NS,
        envelopeBytesBase64url: "Aw",
      }],
    },
  };
}

function protectedPorts(): ProtectedMemoryRoutePorts & {
  planCreate: ReturnType<typeof mock>;
  createPrepared: ReturnType<typeof mock>;
  list: ReturnType<typeof mock>;
  detail: ReturnType<typeof mock>;
  search: ReturnType<typeof mock>;
  brief: ReturnType<typeof mock>;
  updatePrepared: ReturnType<typeof mock>;
  archive: ReturnType<typeof mock>;
  transitionTier: ReturnType<typeof mock>;
  restore: ReturnType<typeof mock>;
  planAccess: ReturnType<typeof mock>;
  commitAccess: ReturnType<typeof mock>;
} {
  return {
    planCreate: mock(async () => ({
      dtoVersion: 1 as const,
      memoryId: UUID_MEM,
      operationId: "memory-create-1",
      expectedContentRevision: 0 as const,
      nextContentRevision: 1 as const,
      productAuthority: { mode: "namespace" as const },
      requiredNamespaceIds: [UUID_NS],
      targetAuthorities: [namespaceAuthority],
      deadlineAt: 1_800_000_030_000,
    })),
    createPrepared: mock(async () => ({
      dtoVersion: 1 as const,
      status: "published" as const,
      memory: {
        ...protectedDto(),
        projection: {
          ...protectedDto().projection,
          contentRevision: 1,
        },
      },
    })),
    list: mock(async () => ({
      dtoVersion: 1 as const,
      items: [protectedDto()],
      nextCursor: null,
      memoryMode: "namespace" as const,
      total: 1,
    })),
    detail: mock(async () => ({
      dtoVersion: 1 as const,
      memory: protectedDto(),
      memoryMode: "namespace" as const,
      actionAuthority: {
        canEdit: true,
        canArchive: true,
        canManageAccess: true,
      },
    })),
    search: mock(async () => ({
      dtoVersion: 1 as const,
      items: [{ memory: protectedDto(), score: 0.75 }],
      memoryMode: "namespace" as const,
      queryDisclosure: "embedding_provider" as const,
    })),
    brief: mock(async () => ({
      dtoVersion: 1 as const,
      items: [protectedDto()],
      memoryMode: "namespace" as const,
    })),
    updatePrepared: mock(async () => ({
      dtoVersion: 1 as const,
      status: "published" as const,
      memory: protectedDto(),
    })),
    archive: mock(async (input: Parameters<ProtectedMemoryRoutePorts["archive"]>[0]) => ({
      operation: "archive" as const,
      operationId: input.operationId,
      memoryId: input.memoryId,
      response: { operationId: input.operationId, status: "archived" as const,
        contentRevision: input.expectedContentRevision,
        cryptoAccessRevision: input.expectedCryptoAccessRevision,
        previousTier: input.expectedTier, nextTier: 3 as const },
    })),
    transitionTier: mock(async (input:
      Parameters<ProtectedMemoryRoutePorts["transitionTier"]>[0]) => ({ operation: "tier_transition" as const,
      operationId: input.operationId, memoryId: input.memoryId,
      response: { operationId: input.operationId,
        status: input.action === "promote" ? "promoted" as const : "demoted" as const,
        contentRevision: input.expectedContentRevision,
        cryptoAccessRevision: input.expectedCryptoAccessRevision,
        previousTier: input.expectedTier, nextTier: input.nextTier } })),
    restore: mock(async (input: Parameters<ProtectedMemoryRoutePorts["restore"]>[0]) => ({ operation: "restore" as const,
      operationId: input.operationId, memoryId: input.memoryId,
      response: { operationId: input.operationId, status: "restored" as const,
        contentRevision: input.expectedContentRevision,
        cryptoAccessRevision: input.expectedCryptoAccessRevision,
        previousTier: input.expectedTier, nextTier: input.nextTier } })),
    planAccess: mock(async () => ({ dtoVersion: 1 as const,
      status: "unavailable" as const, reason: "encryption_pending" as const })),
    commitAccess: mock(async () => ({ dtoVersion: 1 as const,
      status: "unavailable" as const, reason: "encryption_pending" as const })),
  };
}

function protectedComposition(
  ports: ProtectedMemoryRoutePorts,
  memoryMode: "namespace" | "scope" = "namespace",
  originWritableNamespaceId: string | null = null,
  scopeId: string = "scope-1",
): ProtectedMemoryRouteComposition {
  return createProtectedMemoryTestShadowComposition({
    authority: __mintProtectedMemoryTestShadowAuthorityForTesting(),
    target: {
      userId: "user-1",
      actorId: "actor-1",
      agentId: null,
      memoryMode,
      readableNamespaceIds: memoryMode === "namespace" ? [UUID_NS] : [],
      mutableNamespaceIds: memoryMode === "namespace" ? [UUID_NS] : [],
      writableNamespaceIds: memoryMode === "namespace" ? [UUID_NS] : [],
      scopeId: memoryMode === "scope" ? scopeId : null,
      originWritableNamespaceId: memoryMode === "scope"
        ? originWritableNamespaceId
        : null,
      sourceRoomId: UUID_ROOM,
    },
    ports,
  });
}

function humanProtectedComposition(
  ports: ProtectedMemoryRoutePorts,
): ProtectedMemoryRouteComposition {
  return createProtectedMemoryTestShadowComposition({
    authority: __mintProtectedMemoryTestShadowAuthorityForTesting(),
    target: {
      userId: "user-1",
      actorId: "actor-1",
      agentId: null,
      memoryMode: "namespace",
      readableNamespaceIds: [UUID_NS],
      mutableNamespaceIds: [UUID_NS],
      writableNamespaceIds: [UUID_NS],
      scopeId: null,
      originWritableNamespaceId: null,
      sourceRoomId: UUID_ROOM,
    },
    ports,
  });
}

function preparedUpdatePayload() {
  return {
    requestVersion: 1 as const,
    operationId: "memory-update-1",
    expectedContentRevision: 1,
    nextContentRevision: 2,
    cryptoObjectId: "memory-object-1",
    payloadVersion: 1 as const,
    encryptedPayloadBytesBase64url: "AQ",
    accessManifestBytesBase64url: "Ag",
    requiredNamespaceIds: [UUID_NS],
    namespaceEnvelopes: [{
      namespaceId: UUID_NS,
      envelopeBytesBase64url: "Aw",
    }],
    signedContentEmbeddingRequestBytesBase64url: "BQ",
  };
}

function preparedCreatePayload() {
  return {
    ...preparedUpdatePayload(),
    memoryId: UUID_MEM,
    operationId: "memory-create-1",
    expectedContentRevision: 0 as const,
    nextContentRevision: 1 as const,
  };
}

describe("memory routes (D234)", () => {
  beforeEach(() => {
    findRoomsByNamespaceIdsMock.mockReset();
    findRoomsByNamespaceIdsMock.mockImplementation(async () => new Map());
    resolveActorsDisplayMapMock.mockReset();
    resolveActorsDisplayMapMock.mockImplementation(async () => new Map());
    listMemoriesMock.mockClear();
    getMemoryByIdMock.mockClear();
    getPromptBriefMock.mockClear();
    getPromptBriefReadOnlyMock.mockClear();
    getMemoryNamespacesMock.mockClear();
    getMemoryNamespacesMock.mockImplementation(async () => []);
    attachMemoryToNamespaceMock.mockClear();
    detachMemoryFromNamespaceMock.mockClear();
    demoteMemoryMock.mockClear();
    archiveMemoryMock.mockClear();
    archiveScopeMemoryMock.mockClear();
    hardDeleteMemoryMock.mockClear();
    listScopeMemoriesMock.mockClear();
    getScopeMemoryByIdMock.mockClear();
    getScopeMemoryByIdMock.mockImplementation(async () => null);
    userHasCapabilityMock.mockImplementation(async (_uid, cap) =>
      cap === "read_memories" || cap === "manage_memories",
    );
  });

  afterEach(() => {
    userHasCapabilityMock.mockReset();
  });

  function nsEnvelope(): MemoryAccessEnvelope {
    return {
      memoryMode: "namespace",
      ownerId: "owner-1",
      actorId: "actor-1",
      agentId: "agent-1",
      roomId: UUID_ROOM,
      readableNamespaces: ["ns-readable"],
      mutableNamespaces: ["ns-mutable"],
      writableNamespaces: ["ns-writable"],
      toolPolicy: {},
    };
  }

  function scopeEnvelope(): MemoryAccessEnvelope {
    return {
      memoryMode: "scope",
      ownerId: "owner-1",
      actorId: "actor-1",
      agentId: "agent-1",
      roomId: UUID_ROOM,
      scopeId: "scope-1",
      toolPolicy: {},
    };
  }

  function protectedEnvelope(): MemoryAccessEnvelope {
    return {
      ...nsEnvelope(),
      readableNamespaces: [UUID_NS],
      mutableNamespaces: [UUID_NS],
      writableNamespaces: [UUID_NS],
    } as MemoryAccessEnvelope;
  }

  function makeApp(
    envelope: MemoryAccessEnvelope | null,
    composition?: Parameters<typeof memoryRoutes>[1],
    enforceStrictBoundary = allowOrdinaryShadowBoundary,
  ) {
    const app = Fastify({ logger: false });
    memoryRoutes(app, composition, enforceStrictBoundary);
    app.addHook("preHandler", async (request) => {
      (request as { sessionUserId?: string }).sessionUserId = "user-1";
      (request as { memoryEnvelope?: MemoryAccessEnvelope | null }).memoryEnvelope = envelope;
    });
    return app;
  }

  async function sealFor(
    app: ReturnType<typeof makeApp>,
    purpose: "memory.query_embedding" | "memory.content_embedding" | "memory.ordinary_fallback",
    payload: string,
    subjectId = "user-1",
  ) {
    const response = await app.inject({
      method: "GET",
      url: "/api/memory/processor-recipient",
    });
    expect(response.statusCode).toBe(200);
    return sealForegroundMemoryProcessorRequest({
      crypto: new LatticeCrypto(),
      recipient: JSON.parse(response.body) as MemoryProcessorRecipientV1,
      purpose,
      subjectId,
      payload,
    });
  }

  async function sealedPrepared(
    app: ReturnType<typeof makeApp>,
    prepared: ReturnType<typeof preparedCreatePayload>
      | ReturnType<typeof preparedUpdatePayload>,
  ) {
    const {
      signedContentEmbeddingRequestBytesBase64url,
      ...structural
    } = prepared;
    return {
      ...structural,
      sealedContentEmbeddingRequest: await sealFor(
        app,
        "memory.content_embedding",
        signedContentEmbeddingRequestBytesBase64url,
      ),
    };
  }

  test("rejects forged protected Memory test-shadow authority", () => {
    expect(() => createProtectedMemoryTestShadowComposition({
      authority: {} as never,
      target: {
        userId: "user-1",
        actorId: "actor-1",
        agentId: "agent-1",
        memoryMode: "namespace",
        readableNamespaceIds: [UUID_NS],
        mutableNamespaceIds: [UUID_NS],
        writableNamespaceIds: [UUID_NS],
      },
      ports: protectedPorts(),
    })).toThrow("recognized test authority");
  });

  test("keeps the exact legacy list path when protected composition is absent", async () => {
    const ports = protectedPorts();
    const app = makeApp(protectedEnvelope());
    const res = await app.inject({ method: "GET", url: "/api/memory" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      items: [],
      nextCursor: null,
      memoryMode: "namespace",
      total: 0,
    });
    expect(listMemoriesMock.mock.calls.length).toBe(1);
    expect(ports.list.mock.calls.length).toBe(0);
  });

  test("blocks the legacy plaintext Memory API before store access in Strict Shadow", async () => {
    const rejectUnsupportedBoundary = async () => ({
      result: {
        disposition: "reject",
        decision: {
          state: "unsupported",
          reason: "unsupported_operation",
          retryable: false,
        },
      },
    }) as never;
    const app = makeApp(nsEnvelope(), undefined, rejectUnsupportedBoundary);
    const response = await app.inject({ method: "GET", url: "/api/memory" });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({
      error: "strict_shadow_protected_content_required",
      state: "unsupported",
      reason: "unsupported_operation",
      retryable: false,
    });
    expect(listMemoriesMock).not.toHaveBeenCalled();
  });

  test("returns canonical encrypted list DTOs without calling plaintext stores", async () => {
    const ports = protectedPorts();
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const res = await app.inject({ method: "GET", url: "/api/memory?limit=25" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      dtoVersion: 1,
      memoryMode: "namespace",
      items: [{ projection: { accessList: [] } }],
    });
    expect(ports.list.mock.calls.length).toBe(1);
    expect(ports.list.mock.calls[0]?.[0]).toMatchObject({
      authority: { userId: "user-1", readableNamespaceIds: [UUID_NS] },
      namespaceIds: [UUID_NS],
      limit: 25,
    });
    expect(listMemoriesMock.mock.calls.length).toBe(0);
  });

  test("decorates encrypted Memory rows with batched people access without a database", async () => {
    findRoomsByNamespaceIdsMock.mockResolvedValue(new Map([
      [UUID_NS, { humanActorIds: ["human-1", "human-2"] }],
    ]));
    resolveActorsDisplayMapMock.mockResolvedValue(new Map([
      ["human-1", { userHandle: "alice", displayName: "Alice" }],
      ["human-2", { userHandle: "bob", displayName: "Bob" }],
    ]));
    const app = makeApp(protectedEnvelope(), protectedComposition(protectedPorts()));
    const res = await app.inject({ method: "GET", url: "/api/memory?limit=25" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      items: [{ projection: { accessList: [
        { userHandle: "alice", displayName: "Alice" },
        { userHandle: "bob", displayName: "Bob" },
      ] } }],
    });
    expect(findRoomsByNamespaceIdsMock.mock.calls).toEqual([[[UUID_NS]]]);
    expect(resolveActorsDisplayMapMock.mock.calls).toEqual([[["human-1", "human-2"]]]);
    expect(listMemoriesMock).not.toHaveBeenCalled();
    await app.close();
  });

  test("resolves live Memory ports for each current session and observes policy changes without restarting", async () => {
    let userId = "user-1";
    let protectedMode = true;
    const seen: string[] = [];
    const first = protectedPorts();
    const second = protectedPorts();
    const app = makeApp(protectedEnvelope(), async (authority) => {
      seen.push(authority.userId);
      return protectedMode ? authority.userId === "user-1" ? first : second : null;
    });
    app.addHook("preHandler", async (request) => { request.sessionUserId = userId; });
    await app.inject({ method: "GET", url: "/api/memory" });
    userId = "user-2";
    await app.inject({ method: "GET", url: "/api/memory" });
    expect(seen).toEqual(["user-1", "user-2"]);
    expect(first.list.mock.calls).toHaveLength(1);
    expect(second.list.mock.calls).toHaveLength(1);
    expect(listMemoriesMock.mock.calls).toHaveLength(0);
    protectedMode = false;
    const recipient = await app.inject({ method: "GET", url: "/api/memory/processor-recipient" });
    expect(recipient.statusCode).toBe(404);
    await app.close();
  });

  test("fails closed without plaintext fallback when authenticated authority does not exactly match", async () => {
    const ports = protectedPorts();
    const composition = protectedComposition(ports);
    const mismatched = {
      ...protectedEnvelope(),
      readableNamespaces: [
        UUID_NS,
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ],
    } as MemoryAccessEnvelope;
    const app = makeApp(mismatched, composition);
    const res = await app.inject({ method: "GET", url: "/api/memory" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      dtoVersion: 1,
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(ports.list.mock.calls.length).toBe(0);
    expect(listMemoriesMock.mock.calls.length).toBe(0);
  });

  test("fails closed on a malformed protected response without plaintext fallback", async () => {
    const ports = protectedPorts();
    ports.list.mockImplementation(async () => ({
      items: [{ content: "server plaintext must not pass as protected" }],
    } as never));
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const res = await app.inject({ method: "GET", url: "/api/memory" });

    expect(res.statusCode).toBe(500);
    expect(listMemoriesMock.mock.calls.length).toBe(0);
  });

  test("returns protected detail without reading plaintext Memory content", async () => {
    const ports = protectedPorts();
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const res = await app.inject({ method: "GET", url: `/api/memory/${UUID_MEM}` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      dtoVersion: 1,
      memoryMode: "namespace",
      memory: { projection: { accessList: [] } },
    });
    expect(ports.detail.mock.calls.length).toBe(1);
    expect(getMemoryByIdMock.mock.calls.length).toBe(0);
  });

  test("rejects a structurally valid protected detail substituted for another Memory", async () => {
    const ports = protectedPorts();
    ports.detail.mockImplementation(async () => ({
      dtoVersion: 1 as const,
      memory: {
        ...protectedDto(),
        projection: {
          ...protectedDto().projection,
          memoryId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        },
      },
      memoryMode: "namespace" as const,
      actionAuthority: {
        canEdit: false,
        canArchive: false,
        canManageAccess: false,
      },
    }));
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const res = await app.inject({ method: "GET", url: `/api/memory/${UUID_MEM}` });

    expect(res.statusCode).toBe(500);
    expect(getMemoryByIdMock.mock.calls.length).toBe(0);
  });

  test("rejects protected plaintext text search without calling either search implementation", async () => {
    const ports = protectedPorts();
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const sealedQuery = await sealFor(app, "memory.query_embedding", "private words");
    const res = await app.inject({
      method: "POST",
      url: "/api/memory/search",
      payload: { sealedQuery, mode: "text" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      dtoVersion: 1,
      status: "unavailable",
      reason: "text_search_unsupported",
    });
    expect(ports.search.mock.calls.length).toBe(0);
    expect(searchMemoryMock.mock.calls.length).toBe(0);
  });

  test("routes protected semantic search through the disclosed processor port only", async () => {
    const ports = protectedPorts();
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const sealedQuery = await sealFor(app, "memory.query_embedding", "bounded query");
    const res = await app.inject({
      method: "POST",
      url: "/api/memory/search",
      payload: { sealedQuery, mode: "semantic", limit: 10 },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      dtoVersion: 1,
      queryDisclosure: "embedding_provider",
      items: [{ memory: { projection: { accessList: [] } } }],
    });
    expect(ports.search.mock.calls[0]?.[0]).toMatchObject({
      query: "bounded query",
      limit: 10,
    });
    expect(searchMemoryMock.mock.calls.length).toBe(0);

    const legacyGet = await app.inject({
      method: "GET",
      url: "/api/memory/search?q=must-not-enter-the-url&mode=vector",
    });
    expect(legacyGet.statusCode).toBe(405);
    expect(ports.search.mock.calls.length).toBe(1);
    expect(searchMemoryMock.mock.calls.length).toBe(0);
  });

  test("executes the dormant Human assembler through the canonical API client", async () => {
    const routeMocks = protectedPorts();
    const semanticProductSearch = mock(async (_input: unknown) => ({
      dtoVersion: 1 as const,
      items: [{ memory: protectedDto(), score: 0.75 }],
      memoryMode: "namespace" as const,
      queryDisclosure: "embedding_provider" as const,
    }));
    const product: HumanMemoryProtectedProductRoutePort = {
      list: async (input) => routeMocks.list(input),
      detail: async (input) => routeMocks.detail(input),
      searchSemantic: semanticProductSearch,
      brief: async (input) => routeMocks.brief(input),
      transitionTier: async (input) => ({
        operation: input.action === "archive" ? "archive" as const
          : input.action === "restore" ? "restore" as const
          : "tier_transition" as const,
        operationId: input.operationId,
        memoryId: input.memoryId,
        response: {
          operationId: input.operationId,
          status: input.action === "archive" ? "archived" as const
            : input.action === "restore" ? "restored" as const
            : input.action === "promote" ? "promoted" as const
            : "demoted" as const,
          contentRevision: input.expectedContentRevision,
          cryptoAccessRevision: input.expectedCryptoAccessRevision,
          previousTier: input.expectedTier,
          nextTier: input.nextTier,
        },
      }),
    };
    const embed = mock(async () => ({
      status: "embedded" as const,
      embedding: {
        provider: "openai" as const,
        canonicalModel: "text-embedding-3-small",
        dimensions: 1536 as const,
        vector: Object.freeze(Array.from({ length: 1536 }, () => 0.25)),
        processorContractVersion: 1 as const,
      },
    }));
    const assembled = createHumanMemoryProtectedRoutePorts({
      authority: __mintHumanMemoryProtectedRouteTestAuthorityForTesting(),
      target: {
        userId: "user-1",
        actorId: "actor-1",
        agentId: null,
        memoryMode: "namespace",
        readableNamespaceIds: [UUID_NS],
        mutableNamespaceIds: [UUID_NS],
        writableNamespaceIds: [UUID_NS],
        scopeId: null,
        sourceRoomId: UUID_ROOM,
        originWritableNamespaceId: null,
      },
      now: () => 1_800_000_000_000,
      createRequestId: () => "memory-query:request-1",
      createAccessOperationId: () => "access:memory-routes",
      accessDeadlineAt: () => 1_800_000_030_000,
      queryProvider: "openai",
      queryModel: "text-embedding-3-small",
      resolveHumanId: async (userId) => userId === "user-1" ? "human-1" : null,
      foregroundEmbeddingProcessor: { embed },
      product,
      preparedCreate: routeMocks,
      preparedUpdate: routeMocks,
      exactAccessProduct: {
        commitOrdinaryFallback: async () => { throw new Error("Unexpected fallback publication in route fixture"); },
        resolveTarget: async () => ({ dtoVersion: 1, status: "unavailable",
          reason: "encryption_pending" }),
        plan: async () => ({ status: "unavailable",
          reason: "target_encryption_not_ready" }),
        reserve: async () => "reserved",
        lookupReplay: async () => ({ status: "absent" }),
        commit: async () => { throw new Error("not reached"); },
        reconcile: async () => ({ status: "pending", phase: "crypto" }),
      },
      exactAccessCrypto: {
        digestSignedRequest: () => new Uint8Array(32),
        authenticate: async () => { throw new Error("not reached"); },
        complete: async () => { throw new Error("not reached"); },
        observe: async () => ({ status: "absent" }),
      },
      resolveNamespaceAuthority: async ({ namespaceId }) => ({
        ...namespaceAuthority, namespaceId,
      }),
    });
    const app = makeApp(
      protectedEnvelope(),
      humanProtectedComposition(assembled),
    );
    const fetchImpl: NautiloApiFetch = async (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
          ? input.href
          : input.url,
      );
      const requestBody = init?.body;
      if (requestBody !== undefined && requestBody !== null
        && typeof requestBody !== "string") {
        throw new TypeError("Test API transport expected a JSON string body");
      }
      const response = await app.inject({
        method: (init?.method ?? "GET") as "GET" | "POST" | "PATCH"
          | "DELETE",
        url: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(requestBody === undefined || requestBody === null
          ? {}
          : { payload: requestBody }),
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    client.setToken("test-session");

    const recipient = await client.getMemoryProcessorRecipient();
    const sealedQuery = await sealForegroundMemoryProcessorRequest({
      crypto: new LatticeCrypto(),
      recipient,
      purpose: "memory.query_embedding",
      subjectId: "user-1",
      payload: "private query stays off the wire",
    });
    const response = await client.searchProtectedMemories({
      sealedQuery,
      mode: "semantic",
      limit: 5,
    });

    expect("items" in response && response.items[0]?.score).toBe(0.75);
    expect(embed.mock.calls).toHaveLength(1);
    expect(semanticProductSearch.mock.calls).toHaveLength(1);
    const productInput = semanticProductSearch.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(productInput).not.toHaveProperty("query");
    expect(productInput).not.toHaveProperty("plaintext");
    expect(searchMemoryMock.mock.calls).toHaveLength(0);
  });

  test("bounds protected semantic search bodies and never falls back", async () => {
    const ports = protectedPorts();
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const malformed = await app.inject({
      method: "POST",
      url: "/api/memory/search",
      payload: {
        q: "private query",
        mode: "semantic",
        unexpected: "not accepted",
      },
    });
    const oversized = await app.inject({
      method: "POST",
      url: "/api/memory/search",
      payload: {
        sealedQuery: await sealFor(
          app,
          "memory.query_embedding",
          "🙂".repeat(1_025),
        ),
        mode: "semantic",
      },
    });
    expect(malformed.statusCode).toBe(400);
    expect(oversized.statusCode).toBe(400);
    expect(ports.search.mock.calls.length).toBe(0);
    expect(searchMemoryMock.mock.calls.length).toBe(0);

    const legacyOnly = makeApp(protectedEnvelope());
    const absent = await legacyOnly.inject({
      method: "POST",
      url: "/api/memory/search",
      payload: {
        sealedQuery: await sealFor(
          app,
          "memory.query_embedding",
          "private query",
        ),
        mode: "semantic",
      },
    });
    expect(absent.statusCode).toBe(404);
    expect(searchMemoryMock.mock.calls.length).toBe(0);
  });

  test("rejects missing, tampered, and wrong-user processor carriers", async () => {
    const ports = protectedPorts();
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const sealed = await sealFor(app, "memory.query_embedding", "private sentinel");
    const wrongUser = await sealFor(
      app,
      "memory.query_embedding",
      "private sentinel",
      "actor-1",
    );
    const last = sealed.ciphertextBase64url.at(-1)!;
    const tampered = {
      ...sealed,
      ciphertextBase64url: `${sealed.ciphertextBase64url.slice(0, -1)}${
        last === "A" ? "B" : "A"
      }`,
    };
    for (const payload of [
      { mode: "semantic" },
      { mode: "semantic", sealedQuery: tampered },
      { mode: "semantic", sealedQuery: wrongUser },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/memory/search",
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(ports.search.mock.calls).toHaveLength(0);

    for (const payload of [
      preparedCreatePayload(),
      {
        ...preparedCreatePayload(),
        sealedContentEmbeddingRequest: sealed,
      },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/memory/protected-create",
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(ports.createPrepared.mock.calls).toHaveLength(0);
  });

  test("routes ordinary fallback through the same endpoints with a purpose-bound sealed signed intent", async () => {
    const ports = protectedPorts();
    const completion = { dtoVersion: 1 as const, status: "ordinary_fallback" as const,
      operationId: "ordinary-create", memoryId: UUID_MEM, contentRevision: 1,
      cryptoAccessRevision: 0, reason: "target_encryption_not_ready" as const };
    ports.createPrepared.mockImplementation(async () => completion);
    ports.updatePrepared.mockImplementation(async () => ({ ...completion,
      operationId: "ordinary-update", contentRevision: 2 }));
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const signed = "BQ";
    const structural = { requestVersion: 1, publicationKind: "ordinary_fallback",
      reason: "target_encryption_not_ready", memoryId: UUID_MEM,
      operationId: "ordinary-create", expectedContentRevision: 0,
      nextContentRevision: 1, expectedCryptoAccessRevision: 0,
      requiredNamespaceIds: [UUID_NS] };
    for (const purpose of ["memory.content_embedding", "memory.ordinary_fallback"] as const) {
      const result = await app.inject({ method: "POST", url: "/api/memory/protected-create",
        payload: { ...structural, sealedContentEmbeddingRequest: await sealFor(app, purpose, signed) } });
      expect(result.statusCode).toBe(purpose === "memory.ordinary_fallback" ? 200 : 400);
    }
    expect(ports.createPrepared.mock.calls).toHaveLength(1);
    expect(ports.createPrepared.mock.calls[0]?.[0]).toMatchObject({ prepared: {
      ...structural, signedOrdinaryFallbackRequestBytesBase64url: signed,
    } });
    const update = await app.inject({ method: "PATCH", url: `/api/memory/${UUID_MEM}`,
      payload: { ...structural, operationId: "ordinary-update", expectedContentRevision: 1,
        nextContentRevision: 2,
        sealedContentEmbeddingRequest: await sealFor(app, "memory.ordinary_fallback", signed) } });
    expect(update.statusCode).toBe(200);
    expect(ports.updatePrepared.mock.calls).toHaveLength(1);
    const unsealed = await app.inject({ method: "POST", url: "/api/memory/protected-create",
      payload: { ...structural, signedOrdinaryFallbackRequestBytesBase64url: signed,
        sealedContentEmbeddingRequest: await sealFor(app, "memory.ordinary_fallback", signed) } });
    expect(unsealed.statusCode).toBe(400);
    expect(ports.createPrepared.mock.calls).toHaveLength(1);
    expect(updateMemoryMock).not.toHaveBeenCalled();
    await app.close();
  });

  test("returns encrypted prompt-brief candidates without rendering plaintext on server", async () => {
    const ports = protectedPorts();
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const mutating = await app.inject({ method: "GET", url: "/api/memory/brief" });
    const readonly = await app.inject({
      method: "GET",
      url: "/api/memory/brief/readonly",
    });

    expect(mutating.statusCode).toBe(200);
    expect(readonly.statusCode).toBe(200);
    expect(JSON.parse(mutating.body)).toMatchObject({ dtoVersion: 1 });
    expect(JSON.parse(readonly.body)).toMatchObject({ dtoVersion: 1 });
    expect(ports.brief.mock.calls.length).toBe(2);
    expect(ports.brief.mock.calls[0]?.[0]).toMatchObject({ readonly: false });
    expect(ports.brief.mock.calls[1]?.[0]).toMatchObject({ readonly: true });
    expect(getPromptBriefMock.mock.calls.length).toBe(0);
    expect(getPromptBriefReadOnlyMock.mock.calls.length).toBe(0);
  });

  test("publishes a client-prepared encrypted update without accepting plaintext", async () => {
    const ports = protectedPorts();
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const res = await app.inject({
      method: "PATCH",
      url: `/api/memory/${UUID_MEM}`,
      payload: await sealedPrepared(app, preparedUpdatePayload()),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ dtoVersion: 1, status: "published" });
    expect(ports.updatePrepared.mock.calls.length).toBe(1);
    expect(updateMemoryMock.mock.calls.length).toBe(0);
    expect(getMemoryByIdMock.mock.calls.length).toBe(0);
  });

  test("exposes protected create plan and prepared publication only through injected composition", async () => {
    const ports = protectedPorts();
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const plan = await app.inject({
      method: "POST",
      url: "/api/memory/protected-create-plan",
      payload: {},
    });
    expect(plan.statusCode).toBe(200);
    expect(JSON.parse(plan.body)).toMatchObject({
      dtoVersion: 1,
      memoryId: UUID_MEM,
      operationId: "memory-create-1",
      expectedContentRevision: 0,
      nextContentRevision: 1,
      productAuthority: { mode: "namespace" },
      requiredNamespaceIds: [UUID_NS],
    });
    const published = await app.inject({
      method: "POST",
      url: "/api/memory/protected-create",
      payload: await sealedPrepared(app, preparedCreatePayload()),
    });
    expect(published.statusCode).toBe(200);
    expect(JSON.parse(published.body)).toMatchObject({
      dtoVersion: 1,
      status: "published",
      memory: { projection: { memoryId: UUID_MEM, contentRevision: 1 } },
    });
    expect(ports.planCreate.mock.calls.length).toBe(1);
    expect(ports.createPrepared.mock.calls.length).toBe(1);
    expect(updateMemoryMock.mock.calls.length).toBe(0);
  });

  test("keeps protected create routes dormant without injected composition", async () => {
    const app = makeApp(protectedEnvelope());
    const plan = await app.inject({
      method: "POST",
      url: "/api/memory/protected-create-plan",
      payload: {},
    });
    const published = await app.inject({
      method: "POST",
      url: "/api/memory/protected-create",
      payload: preparedCreatePayload(),
    });
    expect(plan.statusCode).toBe(404);
    expect(published.statusCode).toBe(404);
    expect(updateMemoryMock.mock.calls.length).toBe(0);
  });

  test("threads exact inherited scope-origin authority into protected create planning", async () => {
    const ports = protectedPorts();
    ports.planCreate.mockImplementation(async () => ({
      dtoVersion: 1 as const,
      memoryId: UUID_MEM,
      operationId: "memory-create-scope-1",
      expectedContentRevision: 0 as const,
      nextContentRevision: 1 as const,
      productAuthority: {
        mode: "scope" as const,
        scopeId: UUID_SCOPE,
        originWritableNamespaceId: UUID_NS,
      },
      requiredNamespaceIds: [UUID_NS],
      targetAuthorities: [namespaceAuthority],
      deadlineAt: 1_800_000_030_000,
    }));
    const envelope = {
      ...scopeEnvelope(),
      scopeId: UUID_SCOPE,
      originWritableNamespaceId: UUID_NS,
    };
    const app = makeApp(
      envelope,
      protectedComposition(ports, "scope", UUID_NS, UUID_SCOPE),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/memory/protected-create-plan",
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(ports.planCreate.mock.calls[0]?.[0]).toMatchObject({
      authority: {
        memoryMode: "scope",
        scopeId: UUID_SCOPE,
        originWritableNamespaceId: UUID_NS,
      },
    });
  });

  test("rejects plaintext at protected create publication", async () => {
    const ports = protectedPorts();
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const response = await app.inject({
      method: "POST",
      url: "/api/memory/protected-create",
      payload: { content: "never reaches the server product port" },
    });
    expect(response.statusCode).toBe(400);
    expect(ports.createPrepared.mock.calls.length).toBe(0);
    expect(updateMemoryMock.mock.calls.length).toBe(0);
  });

  test("rejects content in the protected create-plan request", async () => {
    const ports = protectedPorts();
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const response = await app.inject({
      method: "POST",
      url: "/api/memory/protected-create-plan",
      payload: { content: "must not enter a server-issued slot" },
    });
    expect(response.statusCode).toBe(400);
    expect(ports.planCreate.mock.calls.length).toBe(0);
  });

  test("fails closed on plaintext PATCH while protected composition is selected", async () => {
    const ports = protectedPorts();
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const res = await app.inject({
      method: "PATCH",
      url: `/api/memory/${UUID_MEM}`,
      payload: { content: "must never enter the legacy store" },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Prepared encrypted Memory update required",
    });
    expect(ports.updatePrepared.mock.calls.length).toBe(0);
    expect(updateMemoryMock.mock.calls.length).toBe(0);
  });

  test("keeps legacy archive unreachable when protected composition is selected", async () => {
    const ports = protectedPorts();
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const res = await app.inject({ method: "DELETE", url: `/api/memory/${UUID_MEM}` });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: "Protected Memory archive requires exact revision planning",
    });
    expect(ports.archive.mock.calls.length).toBe(0);
    expect(archiveMemoryMock.mock.calls.length).toBe(0);
  });

  test("makes the obsolete protected hard-delete route unreachable", async () => {
    const ports = protectedPorts();
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const res = await app.inject({
      method: "DELETE",
      url: `/api/memory/${UUID_MEM}?mode=hard&confirmShared=true`,
      payload: protectedDeleteRequest(),
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: "Protected Memory deletion requires exact access planning",
    });
    expect(ports.planAccess.mock.calls.length).toBe(0);
    expect(getMemoryNamespacesMock.mock.calls.length).toBe(0);
    expect(hardDeleteMemoryMock.mock.calls.length).toBe(0);
  });

  test("keeps legacy scope archive unreachable when protected composition is selected", async () => {
    const ports = protectedPorts();
    const app = makeApp(scopeEnvelope(), protectedComposition(ports, "scope"));
    const res = await app.inject({ method: "DELETE", url: `/api/memory/${UUID_MEM}` });

    expect(res.statusCode).toBe(404);
    expect(ports.archive.mock.calls.length).toBe(0);
    expect(resolveSpeakerUserIdMock.mock.calls.length).toBe(0);
    expect(archiveScopeMemoryMock.mock.calls.length).toBe(0);
  });

  test("makes obsolete protected grant routes unreachable", async () => {
    const ports = protectedPorts();
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const res = await app.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/grant`,
      payload: { room_id: UUID_ROOM },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: "Protected Memory access requires exact access planning",
    });
    expect(ports.planAccess.mock.calls.length).toBe(0);
    expect(getMemoryByIdMock.mock.calls.length).toBe(0);
    expect(attachMemoryToNamespaceMock.mock.calls.length).toBe(0);
  });

  test("makes obsolete protected user grant route unreachable", async () => {
    const ports = protectedPorts();
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const res = await app.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/grant`,
      payload: { user_handle: "@alice" },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: "Protected Memory access requires exact access planning",
    });
    expect(ports.planAccess.mock.calls.length).toBe(0);
    expect(getMemoryByIdMock.mock.calls.length).toBe(0);
  });

  test("makes obsolete protected revoke and make-private routes unreachable", async () => {
    const ports = protectedPorts();
    const app = makeApp(protectedEnvelope(), protectedComposition(ports));
    const revoke = await app.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/revoke`,
      payload: { user_handle: "alice" },
    });
    const makePrivate = await app.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/make_private`,
      payload: {},
    });

    expect(revoke.statusCode).toBe(404);
    expect(makePrivate.statusCode).toBe(404);
    expect(JSON.parse(revoke.body)).toEqual({
      error: "Protected Memory access requires exact access planning",
    });
    expect(JSON.parse(makePrivate.body)).toEqual({
      error: "Protected Memory access requires exact access planning",
    });
    expect(ports.planAccess.mock.calls.length).toBe(0);
    expect(getMemoryByIdMock.mock.calls.length).toBe(0);
    expect(getMemoryNamespacesMock.mock.calls.length).toBe(0);
  });

  test("GET /api/memory/:id returns 403 when store reports forbidden", async () => {
    getMemoryByIdMock.mockImplementation(async () => "forbidden");
    const app = makeApp(nsEnvelope());
    const res = await app.inject({ method: "GET", url: `/api/memory/${UUID_MEM}` });
    expect(res.statusCode).toBe(403);
  });

  test("GET detail projects a capability denial as disabled actions", async () => {
    getMemoryByIdMock.mockImplementation(async () => ({
      id: UUID_MEM,
      type: "fact",
      content: "readable only",
      importance: 0.6,
      tier: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      demotedAt: null,
      demotedFrom: null,
      namespaceIds: ["ns-readable"],
    }));
    userHasCapabilityMock.mockImplementation(async (_uid, cap) => cap === "read_memories");
    const app = makeApp(nsEnvelope());
    const res = await app.inject({ method: "GET", url: `/api/memory/${UUID_MEM}` });
    expect(res.statusCode).toBe(200);
    expect(parseActionAuthority(res.body)).toEqual({
      canEdit: false,
      canArchive: false,
      canHardDelete: false,
      canManageAccess: false,
    });
  });

  test("GET detail disables mutations for a readable but non-writable namespace memory", async () => {
    getMemoryByIdMock.mockImplementation(async () => ({
      id: UUID_MEM,
      type: "fact",
      content: "shared",
      importance: 0.6,
      tier: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      demotedAt: null,
      demotedFrom: null,
      namespaceIds: ["ns-readable"],
    }));
    const app = makeApp(nsEnvelope());
    const res = await app.inject({ method: "GET", url: `/api/memory/${UUID_MEM}` });
    expect(res.statusCode).toBe(200);
    expect(parseActionAuthority(res.body)).toEqual({
      canEdit: false,
      canArchive: false,
      canHardDelete: false,
      canManageAccess: false,
    });
  });

  test("GET detail projects supported namespace mutations from attached mutable and writable namespaces", async () => {
    getMemoryByIdMock.mockImplementation(async () => ({
      id: UUID_MEM,
      type: "fact",
      content: "writable",
      importance: 0.6,
      tier: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      demotedAt: null,
      demotedFrom: null,
      namespaceIds: ["ns-current"],
    }));
    const envelope = {
      ...nsEnvelope(),
      readableNamespaces: ["ns-current"],
      mutableNamespaces: ["ns-current"],
      writableNamespaces: ["ns-current"],
    } as MemoryAccessEnvelope;
    const app = makeApp(envelope);
    const res = await app.inject({ method: "GET", url: `/api/memory/${UUID_MEM}` });
    expect(res.statusCode).toBe(200);
    expect(parseActionAuthority(res.body)).toEqual({
      canEdit: true,
      canArchive: true,
      canHardDelete: true,
      canManageAccess: true,
    });
  });

  test("scope detail enables mutations only for a scope-origin detail row and never access management", async () => {
    getScopeMemoryByIdMock.mockImplementation(async () => ({
      id: UUID_MEM,
      type: "fact",
      content: "scope fact",
      importance: 0.6,
      tier: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      demotedAt: null,
      demotedFrom: null,
      namespaceIds: [],
    }));
    const app = makeApp(scopeEnvelope());
    const res = await app.inject({ method: "GET", url: `/api/memory/${UUID_MEM}` });
    expect(res.statusCode).toBe(200);
    expect(parseActionAuthority(res.body)).toEqual({
      canEdit: true,
      canArchive: true,
      canHardDelete: true,
      canManageAccess: false,
    });
  });

  test("scope-mode GET /api/memory returns scope memories", async () => {
    const app = makeApp(scopeEnvelope());
    const res = await app.inject({ method: "GET", url: "/api/memory" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { items: unknown[]; memoryMode: string };
    expect(body.memoryMode).toBe("scope");
    expect(body.items.length).toBe(1);
    expect(listScopeMemoriesMock.mock.calls.length).toBe(1);
  });

  test("DELETE hard returns 409 when multi-namespace block", async () => {
    getMemoryNamespacesMock.mockImplementation(async () => ["ns-writable"]);
    hardDeleteMemoryMock.mockImplementation(async () => ({
      status: "blocked" as const,
      namespaceCount: 2,
      namespaceIds: ["ns-a", "ns-b"],
    }));
    const app = makeApp(nsEnvelope());
    const res = await app.inject({
      method: "DELETE",
      url: `/api/memory/${UUID_MEM}?mode=hard`,
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { namespaceCount?: number; hint?: string };
    expect(body.namespaceCount).toBe(2);
    expect(body.hint).toBe(
      "Deleting removes it from your writable namespace. Others may keep access.",
    );
  });

  test("DELETE hard detaches an attached writable namespace instead of the first unrelated envelope entry", async () => {
    getMemoryNamespacesMock.mockImplementation(async () => ["ns-attached"]);
    hardDeleteMemoryMock.mockImplementation(async () => ({ status: "deleted" as const }));
    const envelope = {
      ...nsEnvelope(),
      readableNamespaces: ["ns-attached"],
      mutableNamespaces: ["ns-attached"],
      writableNamespaces: ["ns-unrelated", "ns-attached"],
    } as MemoryAccessEnvelope;
    const app = makeApp(envelope);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/memory/${UUID_MEM}?mode=hard`,
    });
    expect(res.statusCode).toBe(200);
    expect(hardDeleteMemoryMock).toHaveBeenCalledWith(
      UUID_MEM,
      "ns-attached",
      ["ns-attached"],
      expect.anything(),
      { confirmShared: false },
    );
  });

  test("PATCH invokes updateMemory for manage_memories holder", async () => {
    getMemoryByIdMock.mockImplementation(async () => ({
      id: UUID_MEM,
      type: "fact",
      content: "updated",
      importance: 0.6,
      tier: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      demotedAt: null,
      demotedFrom: null,
      namespaceIds: ["ns-readable"],
    }));
    const app = makeApp(nsEnvelope());
    const res = await app.inject({
      method: "PATCH",
      url: `/api/memory/${UUID_MEM}`,
      payload: { content: "updated" },
    });
    expect(res.statusCode).toBe(200);
    expect(updateMemoryMock.mock.calls.length).toBe(1);
    expect(parseActionAuthority(res.body)).toEqual({
      canEdit: false,
      canArchive: false,
      canHardDelete: false,
      canManageAccess: false,
    });
  });

  test("DELETE archive invokes direct-to-archive store mutation", async () => {
    writeSecurityAuditEventMock.mockClear();
    const app = makeApp(nsEnvelope());
    const res = await app.inject({
      method: "DELETE",
      url: `/api/memory/${UUID_MEM}?mode=archive`,
    });
    expect(res.statusCode).toBe(200);
    expect(archiveMemoryMock.mock.calls.length).toBe(1);
    expect(demoteMemoryMock.mock.calls.length).toBe(0);
  });

  test("scope DELETE archive invokes direct-to-archive store mutation", async () => {
    const app = makeApp(scopeEnvelope());
    const res = await app.inject({
      method: "DELETE",
      url: `/api/memory/${UUID_MEM}?mode=archive`,
    });
    expect(res.statusCode).toBe(200);
    expect(archiveScopeMemoryMock.mock.calls.length).toBe(1);
  });

  test("GET /api/memory returns 403 without read_memories", async () => {
    userHasCapabilityMock.mockImplementation(async (_uid, cap) => cap !== "read_memories");
    const app = makeApp(nsEnvelope());
    const res = await app.inject({ method: "GET", url: "/api/memory" });
    expect(res.statusCode).toBe(403);
  });
});
