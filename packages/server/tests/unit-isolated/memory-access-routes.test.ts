/**
 * M173 — memory access routes (hermetic): `?room`/`?person` filters,
 * `accessList` on detail, and the grant/revoke/make_private guards. Mocks the
 * trust + memory-store boundaries so no DB is touched.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import * as actualTrust from "@nautilo/trust";

const UUID_MEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_ROOM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UUID_USER = "11111111-1111-4111-8111-111111111111";
const UUID_ACTOR = "22222222-2222-4222-8222-222222222222";
const UUID_TARGET_ACTOR = "33333333-3333-4333-8333-333333333333";
const UUID_SOURCE_ROOM = "44444444-4444-4444-8444-444444444444";
const UUID_TARGET_ROOM = "55555555-5555-4555-8555-555555555555";

type MemoryDetail = import("../../../agent/src/store/memory-store").MemoryDetail;

function detailFixture(): MemoryDetail {
  return {
    id: UUID_MEM,
    type: "fact",
    content: "the cat is named Mochi",
    importance: 0.6,
    tier: 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    demotedAt: null,
    demotedFrom: null,
    namespaceIds: ["ns-readable"],
  };
}

const listMemoriesMock = mock(
  async (
    _opts: { namespaceIds: string[] } & Record<string, unknown>,
  ): Promise<{ items: unknown[]; nextCursor: string | null }> => ({
    items: [],
    nextCursor: null,
  }),
);
const countMemoriesMock = mock(
  async (_opts: { namespaceIds: string[] } & Record<string, unknown>): Promise<number> => 0,
);
const getMemoryByIdMock = mock(
  async (): Promise<MemoryDetail | null | "forbidden"> => detailFixture(),
);
const getMemoryNamespacesMock = mock(async (): Promise<string[]> => []);
const attachMock = mock(async () => undefined);
const detachMock = mock(async () => undefined);

const userHasCapabilityMock = mock(
  async (_uid: string, cap: string) => cap === "read_memories" || cap === "manage_memories",
);
const getRoomWithAccessMock = mock(
  async (): Promise<{
    namespaceId: string;
    humanActorIds: string[];
    isPublicNamespaceBoundary?: boolean;
  } | null> => null,
);
const getRoomDetailForMemberMock = mock(async (_roomId: string, _actorId: string):
  Promise<{ id: string; label: string; kind: string } | null> => null);
const findActorByOwnerIdMock = mock(
  async (): Promise<{ id: string } | null> => ({ id: "req-actor" }),
);
const findActorByHandleMock = mock(
  async (): Promise<{ kind: "user" | "agent"; actorId: string } | null> => null,
);
const findActorByIdMock = mock(
  async (): Promise<{ ownerId: string } | null> => null,
);
const findReadableNamespacesForSubsetMock = mock(async (): Promise<string[]> => []);
const findRoomByNamespaceIdMock = mock(
  async (): Promise<{ roomId: string; label: string; humanActorIds: string[] } | null> =>
    null,
);
const resolveActorsDisplayMock = mock(
  async (): Promise<Array<{ userHandle: string; displayName: string }>> => [],
);
const findRoomsByNamespaceIdsMock = mock(
  async (): Promise<Map<string, { humanActorIds: string[] }>> => new Map(),
);
const resolveActorsDisplayMapMock = mock(
  async (): Promise<Map<string, { userHandle: string; displayName: string }>> =>
    new Map(),
);
const findAgentOwnerPrivateRoomMock = mock(
  async (): Promise<{ roomId: string; namespaceId: string } | null> => null,
);
const findOrCreateAccessNamespaceMock = mock(
  async (): Promise<{ namespaceId: string; roomId: string; minted: boolean }> => ({
    namespaceId: "ns-access",
    roomId: "room-access",
    minted: true,
  }),
);

mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  userHasCapability: userHasCapabilityMock,
  getRoomWithAccess: getRoomWithAccessMock,
  getRoomDetailForMember: getRoomDetailForMemberMock,
  findActorByOwnerId: findActorByOwnerIdMock,
  findActorByHandle: findActorByHandleMock,
  findActorById: findActorByIdMock,
  findReadableNamespacesForSubset: findReadableNamespacesForSubsetMock,
  findRoomByNamespaceId: findRoomByNamespaceIdMock,
  findRoomsByNamespaceIds: findRoomsByNamespaceIdsMock,
  resolveActorsDisplay: resolveActorsDisplayMock,
  resolveActorsDisplayMap: resolveActorsDisplayMapMock,
  findAgentOwnerPrivateRoom: findAgentOwnerPrivateRoomMock,
  findOrCreateAccessNamespace: findOrCreateAccessNamespaceMock,
}));

mock.module("../../../agent/src/store/memory-store", () => ({
  lockAtomicProjectionDestinationAuthority: () => {
    throw new Error("Projection is outside this route fixture");
  },
  commitForegroundMemoryOrdinaryFallback: () => {
    throw new Error("Unexpected Agent Memory fallback from a Human route");
  },
  // Background publication is imported transitively but must never run in route tests.
  findMemorySaveTarget: () => { throw new Error("Unexpected background Memory publication"); },
  saveMemoryWithDb: () => { throw new Error("Unexpected background Memory publication"); },
  replaceMemoryWithDb: () => { throw new Error("Unexpected background Memory publication"); },
  demoteMemoryWithDb: () => { throw new Error("Unexpected background Memory publication"); },
  promoteMemoryWithDb: () => { throw new Error("Unexpected background Memory publication"); },
  getPromptBrief: async () => "",
  getPromptBriefReadOnly: async () => "",
  selectPromptBriefMemories: async () => [],
  loadPromptBriefMemoryOrdinarySelections: () => { throw new Error("Unexpected prompt body loading in Memory access test"); },
  stagePromptBriefMemoryStructuralPage: () => { throw new Error("Unexpected prompt selection in Memory access test"); },
  packOpenedPromptBriefMemories: () => { throw new Error("Unexpected prompt packing in Memory access test"); },
  stagePromptBriefMemories: async () => ({ selected: [], overflow: [] }),
  commitPromptBriefMemoryOverflow: async () => undefined,
  attachMemoryToNamespace: attachMock,
  detachMemoryFromNamespace: detachMock,
  getMemoryNamespaces: getMemoryNamespacesMock,
  saveMemory: async () => ({ id: UUID_MEM, action: "created" as const }),
  replaceMemory: async () => undefined,
  promoteMemory: async () => undefined,
  searchMemory: async () => [],
  listMemories: listMemoriesMock,
  countMemories: countMemoriesMock,
  getMemoryById: getMemoryByIdMock,
  demoteMemory: async () => undefined,
  archiveMemory: async () => undefined,
  hardDeleteMemory: async () => ({ status: "deleted" as const }),
  updateMemory: async () => undefined,
  decodeMemoryListCursor: () => null,
  encodeMemoryListCursor: () => "",
  setMemoryAuditSink: () => {},
  emitMemoryAudit: () => {},
  assertNamespaceWriteAccess: () => {},
  // Imported transitively by D476 projection sharing; routes under test never invoke it.
  executeAtomicProjectionMemory: async () => {
    throw new Error("executeAtomicProjectionMemory must not run in memory access route tests");
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
  listScopeMemories: async () => ({ items: [], nextCursor: null }),
  getScopeMemoryById: async () => null,
  searchScopeMemory: async () => [],
  demoteScopeMemory: async () => undefined,
  archiveScopeMemory: async () => undefined,
  hardDeleteScopeMemory: async () => ({ status: "deleted" as const }),
  updateScopeMemory: async () => undefined,
  saveScopeMemory: async () => ({ id: UUID_MEM, action: "created" as const }),
  replaceScopeMemory: async () => undefined,
  promoteScopeMemory: async () => undefined,
}));

mock.module("../../src/lib/security-audit-log", () => ({
  writeSecurityAuditEvent: () => {},
}));

const { memoryRoutes } = await import("../../src/routes/memory");
type MemoryContentAccessDependencies = import("../../src/routes/memory").MemoryContentAccessDependencies;

const allowOrdinaryShadowBoundary = async () => ({
  result: { disposition: "ordinary" },
}) as never;

function nsEnvelope(): MemoryAccessEnvelope {
  return {
    memoryMode: "namespace",
    ownerId: "owner-1",
    actorId: "actor-1",
    agentId: "agent-1",
    roomId: "room-1",
    readableNamespaces: ["ns-readable"],
    mutableNamespaces: ["ns-mutable"],
    writableNamespaces: ["ns-writable"],
    toolPolicy: {},
  } as unknown as MemoryAccessEnvelope;
}

function scopeEnvelope(): MemoryAccessEnvelope {
  return {
    memoryMode: "scope",
    ownerId: "owner-1",
    actorId: "actor-1",
    agentId: "agent-1",
    roomId: "room-1",
    scopeId: "scope-1",
    toolPolicy: {},
  } as unknown as MemoryAccessEnvelope;
}

function canonicalEnvelope(): MemoryAccessEnvelope {
  return {
    memoryMode: "namespace",
    ownerId: UUID_USER,
    actorId: UUID_ACTOR,
    agentId: "agent-1",
    roomId: UUID_SOURCE_ROOM,
    readableNamespaces: ["ns-readable"],
    mutableNamespaces: ["ns-mutable", "ns-target"],
    writableNamespaces: ["ns-mutable", "ns-target"],
    toolPolicy: {},
  } as unknown as MemoryAccessEnvelope;
}

const policy = (mode: "plaintext_only" | "shadow_encryption" | "encrypted_only") => ({
  mode,
  shadowBehavior: "fallback" as const,
  revision: 1,
  shadowEncryptionStartedAt: null,
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

function makeApp(
  envelope: MemoryAccessEnvelope | null,
  contentAccess: MemoryContentAccessDependencies = {
    loadEncryptionPolicy: async () => policy("shadow_encryption"),
  },
) {
  const app = Fastify({ logger: false });
  memoryRoutes(app, undefined, allowOrdinaryShadowBoundary, contentAccess);
  app.addHook("preHandler", async (request) => {
    (request as { sessionUserId?: string }).sessionUserId =
      envelope?.ownerId === UUID_USER ? UUID_USER : "user-1";
    (request as { memoryEnvelope?: MemoryAccessEnvelope | null }).memoryEnvelope = envelope;
  });
  return app;
}

beforeEach(() => {
  listMemoriesMock.mockClear();
  countMemoriesMock.mockClear();
  countMemoriesMock.mockImplementation(async () => 0);
  getMemoryByIdMock.mockClear();
  getMemoryByIdMock.mockImplementation(async () => detailFixture());
  getMemoryNamespacesMock.mockClear();
  getMemoryNamespacesMock.mockImplementation(async () => []);
  attachMock.mockClear();
  detachMock.mockClear();
  getRoomWithAccessMock.mockClear();
  getRoomWithAccessMock.mockImplementation(async () => null);
  getRoomDetailForMemberMock.mockClear();
  getRoomDetailForMemberMock.mockImplementation(async () => null);
  findActorByOwnerIdMock.mockClear();
  findActorByOwnerIdMock.mockImplementation(async () => ({ id: "req-actor" }));
  findActorByHandleMock.mockClear();
  findActorByHandleMock.mockImplementation(async () => null);
  findActorByIdMock.mockClear();
  findActorByIdMock.mockImplementation(async () => null);
  findReadableNamespacesForSubsetMock.mockClear();
  findReadableNamespacesForSubsetMock.mockImplementation(async () => []);
  findRoomByNamespaceIdMock.mockClear();
  findRoomByNamespaceIdMock.mockImplementation(async () => null);
  findRoomsByNamespaceIdsMock.mockClear();
  findRoomsByNamespaceIdsMock.mockImplementation(async () => new Map());
  resolveActorsDisplayMapMock.mockClear();
  resolveActorsDisplayMapMock.mockImplementation(async () => new Map());
  findAgentOwnerPrivateRoomMock.mockClear();
  findAgentOwnerPrivateRoomMock.mockImplementation(async () => null);
  userHasCapabilityMock.mockImplementation(
    async (_uid, cap) => cap === "read_memories" || cap === "manage_memories",
  );
});

afterEach(() => {
  userHasCapabilityMock.mockReset();
});

describe("M173 GET filters", () => {
  test("plain detail projects its admitted Room, never an attachment or client-selected fallback", async () => {
    getRoomDetailForMemberMock.mockImplementation(async (roomId) => ({
      id: roomId, label: "My personal library", kind: "private",
    }));
    const app = makeApp(canonicalEnvelope(), { loadEncryptionPolicy: async () => policy("plaintext_only") });
    const res = await app.inject({ method: "GET", url: `/api/memory/${UUID_MEM}?roomId=${UUID_TARGET_ROOM}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ accessContext?: unknown }>().accessContext).toEqual({ roomId: UUID_SOURCE_ROOM, label: "My personal library" });
    expect(getRoomDetailForMemberMock).toHaveBeenCalledWith(UUID_SOURCE_ROOM, UUID_ACTOR);
    expect(findAgentOwnerPrivateRoomMock).not.toHaveBeenCalled();
    await app.close();
  });

  test("explicitly admitted non-private Room remains the displayed access context", async () => {
    getRoomDetailForMemberMock.mockImplementation(async (roomId) => ({ id: roomId, label: "Team", kind: "group" }));
    const app = makeApp({ ...canonicalEnvelope(), roomId: UUID_TARGET_ROOM } as MemoryAccessEnvelope,
      { loadEncryptionPolicy: async () => policy("plaintext_only") });
    const res = await app.inject({ method: "GET", url: `/api/memory/${UUID_MEM}` });
    expect(res.json<{ accessContext?: unknown }>().accessContext).toEqual({ roomId: UUID_TARGET_ROOM, label: "Team" });
    await app.close();
  });

  test("shadow detail preserves the existing response without an ordinary context lookup", async () => {
    const app = makeApp(canonicalEnvelope());
    const res = await app.inject({ method: "GET", url: `/api/memory/${UUID_MEM}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ accessContext?: unknown }>().accessContext).toBeUndefined();
    expect(getRoomDetailForMemberMock).not.toHaveBeenCalled();
    await app.close();
  });

  test("missing membership or unavailable policy omits context without guessing or losing the readable detail", async () => {
    for (const loadEncryptionPolicy of [
      async () => policy("plaintext_only"),
      async () => { throw new Error("policy unavailable"); },
    ]) {
      const app = makeApp(canonicalEnvelope(), { loadEncryptionPolicy });
      const res = await app.inject({ method: "GET", url: `/api/memory/${UUID_MEM}` });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ accessContext?: unknown }>().accessContext).toBeUndefined();
      await app.close();
    }
    expect(findAgentOwnerPrivateRoomMock).not.toHaveBeenCalled();
  });

  test("forbidden Memory never resolves or discloses an access context", async () => {
    getMemoryByIdMock.mockImplementation(async () => "forbidden");
    const app = makeApp(canonicalEnvelope(), { loadEncryptionPolicy: async () => policy("plaintext_only") });
    const res = await app.inject({ method: "GET", url: `/api/memory/${UUID_MEM}` });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ accessContext?: unknown }>().accessContext).toBeUndefined();
    expect(getRoomDetailForMemberMock).not.toHaveBeenCalled();
    await app.close();
  });

  test("backward-compat: unfiltered GET /api/memory keeps its shape", async () => {
    listMemoriesMock.mockImplementation(async () => ({
      items: [{ id: UUID_MEM, type: "fact", content: "x", importance: 0.5, tier: 1, createdAt: new Date(), updatedAt: new Date(), namespaceIds: ["ns-readable"] }],
      nextCursor: null,
    }));
    countMemoriesMock.mockImplementation(async () => 7);
    const app = makeApp(nsEnvelope());
    const res = await app.inject({ method: "GET", url: "/api/memory" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      items: unknown[];
      nextCursor: null;
      memoryMode: string;
      total: number;
    };
    // D328 — additive `total`; the rest of the shape is unchanged.
    expect(Object.keys(body).sort()).toEqual(["items", "memoryMode", "nextCursor", "total"]);
    expect(body.memoryMode).toBe("namespace");
    expect(body.total).toBe(7);
    // No filter present → readable namespaces used verbatim.
    expect(listMemoriesMock.mock.calls[0]?.[0]).toMatchObject({ namespaceIds: ["ns-readable"] });
  });

  test("D328: ?audience=private lists private namespaces only + true total", async () => {
    // readable = ["ns-readable"]; mock it as a single-human (private) room.
    findRoomsByNamespaceIdsMock.mockImplementation(
      async () => new Map([["ns-readable", { humanActorIds: ["req-actor"] }]]),
    );
    countMemoriesMock.mockImplementation(async () => 152);
    const app = makeApp(nsEnvelope());
    const res = await app.inject({ method: "GET", url: "/api/memory?audience=private" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { total: number };
    expect(body.total).toBe(152);
    // listMemories scoped to the private namespace, nothing excluded (no shared ns).
    expect(listMemoriesMock.mock.calls[0]?.[0]).toMatchObject({
      namespaceIds: ["ns-readable"],
    });
  });

  test("D328: ?audience=private cannot combine with person → 400", async () => {
    const app = makeApp(nsEnvelope());
    const res = await app.inject({
      method: "GET",
      url: "/api/memory?audience=private&person=alice",
    });
    expect(res.statusCode).toBe(400);
  });

  test("D328: list rows carry a people accessList (batched, per page)", async () => {
    listMemoriesMock.mockImplementation(async () => ({
      items: [
        {
          id: UUID_MEM,
          type: "fact",
          content: "shared with the family",
          importance: 0.5,
          tier: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          namespaceIds: ["ns-fam"],
        },
      ],
      nextCursor: null,
    }));
    findRoomsByNamespaceIdsMock.mockImplementation(
      async () => new Map([["ns-fam", { humanActorIds: ["a1", "a2"] }]]),
    );
    resolveActorsDisplayMapMock.mockImplementation(
      async () =>
        new Map([
          ["a1", { userHandle: "you", displayName: "You" }],
          ["a2", { userHandle: "casey", displayName: "Casey" }],
        ]),
    );
    const app = makeApp(nsEnvelope());
    const res = await app.inject({ method: "GET", url: "/api/memory" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      items: Array<{ accessList?: Array<{ userHandle: string; displayName: string }> }>;
    };
    const access = body.items[0]?.accessList ?? [];
    expect(access.map((a) => a.userHandle).sort()).toEqual(["casey", "you"]);
  });

  test("backward-compat: GET /api/memory/:id adds accessList additively", async () => {
    const app = makeApp(nsEnvelope());
    const res = await app.inject({ method: "GET", url: `/api/memory/${UUID_MEM}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      memory: Record<string, unknown> & { accessList?: unknown };
      memoryMode: string;
    };
    expect(body.memoryMode).toBe("namespace");
    expect(Array.isArray(body.memory.accessList)).toBe(true);
    // Stripping accessList yields the original detail shape byte-for-byte.
    const { accessList, ...rest } = body.memory;
    expect(accessList).toEqual([]);
    expect(rest).toMatchObject({ id: UUID_MEM, type: "fact", content: "the cat is named Mochi" });
  });

  test("?room non-member → 404 (never reveals a room you're not in)", async () => {
    getRoomWithAccessMock.mockImplementation(async () => ({
      namespaceId: "ns-x",
      humanActorIds: ["someone-else"],
    }));
    findActorByOwnerIdMock.mockImplementation(async () => ({ id: "req-actor" }));
    const app = makeApp(nsEnvelope());
    const res = await app.inject({ method: "GET", url: `/api/memory?room=${UUID_ROOM}` });
    expect(res.statusCode).toBe(404);
    expect(listMemoriesMock).not.toHaveBeenCalled();
  });

  test("?room public boundary passes the virtual-cosmos source policy", async () => {
    getRoomWithAccessMock.mockImplementation(async () => ({
      namespaceId: "ns-public",
      humanActorIds: ["req-actor"],
      isPublicNamespaceBoundary: true,
    }));
    findActorByOwnerIdMock.mockImplementation(async () => ({ id: "req-actor" }));
    findReadableNamespacesForSubsetMock.mockImplementation(async () => ["ns-public"]);

    const app = makeApp(nsEnvelope());
    const res = await app.inject({ method: "GET", url: `/api/memory?room=${UUID_ROOM}` });

    expect(res.statusCode).toBe(200);
    expect(findReadableNamespacesForSubsetMock).toHaveBeenLastCalledWith(
      ["req-actor"],
      { isPublicNamespaceBoundary: true },
    );
  });

  test("?person → intersection of person-readable and requester-readable", async () => {
    findActorByHandleMock.mockImplementation(async () => ({ kind: "user", actorId: "tgt" }));
    findReadableNamespacesForSubsetMock.mockImplementation(async () => [
      "ns-readable",
      "ns-only-person-can-see",
    ]);
    const app = makeApp(nsEnvelope());
    const res = await app.inject({ method: "GET", url: "/api/memory?person=alice" });
    expect(res.statusCode).toBe(200);
    // Intersection with requester readable (["ns-readable"]) drops the private one.
    expect(listMemoriesMock.mock.calls[0]?.[0]).toMatchObject({ namespaceIds: ["ns-readable"] });
  });

  test("?person handle that is an agent → 400", async () => {
    findActorByHandleMock.mockImplementation(async () => ({ kind: "agent", actorId: "bot" }));
    const app = makeApp(nsEnvelope());
    const res = await app.inject({ method: "GET", url: "/api/memory?person=genie" });
    expect(res.statusCode).toBe(400);
  });

  test("scope-mode + filter → 400 namespace mode required", async () => {
    const app = makeApp(scopeEnvelope());
    const res = await app.inject({ method: "GET", url: `/api/memory?room=${UUID_ROOM}` });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("namespace mode required");
  });
});

describe("M173 grant / revoke / make_private guards", () => {
  test("grant requires exactly one of room_id / user_handle (neither → 400)", async () => {
    const app = makeApp(nsEnvelope());
    const res = await app.inject({ method: "POST", url: `/api/memory/${UUID_MEM}/grant`, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  test("grant rejects both room_id AND user_handle → 400", async () => {
    const app = makeApp(nsEnvelope());
    const res = await app.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/grant`,
      payload: { room_id: UUID_ROOM, user_handle: "alice" },
    });
    expect(res.statusCode).toBe(400);
  });

  test("grant by room_id: non-member → 403, nothing attached", async () => {
    getRoomWithAccessMock.mockImplementation(async () => ({
      namespaceId: "ns-x",
      humanActorIds: ["someone-else"],
    }));
    const app = makeApp(nsEnvelope());
    const res = await app.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/grant`,
      payload: { room_id: UUID_ROOM },
    });
    expect(res.statusCode).toBe(403);
    expect(attachMock).not.toHaveBeenCalled();
  });

  test("grant by room_id: namespace not mutable → 403", async () => {
    getRoomWithAccessMock.mockImplementation(async () => ({
      namespaceId: "ns-not-mutable",
      humanActorIds: ["req-actor"],
    }));
    findActorByOwnerIdMock.mockImplementation(async () => ({ id: "req-actor" }));
    const app = makeApp(nsEnvelope());
    const res = await app.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/grant`,
      payload: { room_id: UUID_ROOM },
    });
    expect(res.statusCode).toBe(403);
    expect(attachMock).not.toHaveBeenCalled();
  });

  test("grant by room_id: member + mutable → 200 attaches", async () => {
    getRoomWithAccessMock.mockImplementation(async () => ({
      namespaceId: "ns-mutable",
      humanActorIds: ["req-actor"],
    }));
    findActorByOwnerIdMock.mockImplementation(async () => ({ id: "req-actor" }));
    const app = makeApp(nsEnvelope());
    const res = await app.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/grant`,
      payload: { room_id: UUID_ROOM },
    });
    expect(res.statusCode).toBe(200);
    expect(attachMock).toHaveBeenCalledWith(UUID_MEM, "ns-mutable", expect.anything());
  });

  test("revoke yourself → 400", async () => {
    findActorByHandleMock.mockImplementation(async () => ({ kind: "user", actorId: "self-actor" }));
    findActorByIdMock.mockImplementation(async () => ({ ownerId: "user-1" }));
    const app = makeApp(nsEnvelope());
    const res = await app.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/revoke`,
      payload: { user_handle: "me" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toContain("make_private");
  });

  test("revoke: skipped when target's namespace is read-but-not-writable", async () => {
    // mutable ⊊ readable: attached ns 'ns-shared' is NOT in mutable (['ns-mutable']).
    findActorByHandleMock.mockImplementation(async () => ({ kind: "user", actorId: "tgt-actor" }));
    findActorByIdMock.mockImplementation(async () => ({ ownerId: "tgt-user" }));
    getMemoryNamespacesMock.mockImplementation(async () => ["ns-shared"]);
    findRoomByNamespaceIdMock.mockImplementation(async () => ({
      roomId: "r",
      label: "Fam",
      humanActorIds: ["tgt-actor", "req-actor"],
    }));
    const app = makeApp(nsEnvelope());
    const res = await app.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/revoke`,
      payload: { user_handle: "alice" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string; reHomed: number; skipped: string[] };
    expect(body).toEqual({ status: "revoked", reHomed: 0, skipped: ["ns-shared"] });
    expect(attachMock).not.toHaveBeenCalled();
    expect(detachMock).not.toHaveBeenCalled();
  });

  test("make_private: detaches mutable, reports read-but-not-writable as skipped, attaches private first", async () => {
    findAgentOwnerPrivateRoomMock.mockImplementation(async () => ({
      roomId: "r-priv",
      namespaceId: "ns-priv",
    }));
    // Attached to a writable ns + a read-only ns.
    getMemoryNamespacesMock.mockImplementation(async () => ["ns-mutable", "ns-shared"]);
    const app = makeApp(nsEnvelope());
    const res = await app.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/make_private`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string; skipped: string[] };
    expect(body).toEqual({ status: "private", skipped: ["ns-shared"] });
    // Private namespace attached first (self-access guaranteed before any detach).
    expect(attachMock).toHaveBeenCalledWith(UUID_MEM, "ns-priv", expect.anything());
    expect(detachMock).toHaveBeenCalledWith(UUID_MEM, "ns-mutable", expect.anything());
    expect(detachMock).not.toHaveBeenCalledWith(UUID_MEM, "ns-shared", expect.anything());
  });

  test("make_private without a private namespace → 409", async () => {
    findAgentOwnerPrivateRoomMock.mockImplementation(async () => null);
    const app = makeApp(nsEnvelope());
    const res = await app.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/make_private`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });

  test("grant in scope mode → 400 namespace mode required", async () => {
    const app = makeApp(scopeEnvelope());
    const res = await app.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/grant`,
      payload: { user_handle: "alice" },
    });
    expect(res.statusCode).toBe(400);
  });
});

type LegacyExecute = NonNullable<
  MemoryContentAccessDependencies["ordinaryAccess"]
>["executeLegacyHuman"];

function ordinaryAccess(result: Awaited<ReturnType<LegacyExecute>>) {
  const executeLegacyHuman = mock(async (
    _admission: Parameters<LegacyExecute>[0],
    _input: Parameters<LegacyExecute>[1],
  ) => result);
  return {
    executeLegacyHuman,
    dependencies: {
      ordinaryAccess: { executeLegacyHuman } as NonNullable<
        MemoryContentAccessDependencies["ordinaryAccess"]
      >,
      loadEncryptionPolicy: async () => policy("plaintext_only"),
    } satisfies MemoryContentAccessDependencies,
  };
}

function receipt(
  outcome: "applied" | "already_applied" | "partial" = "applied",
) {
  const changed = outcome !== "already_applied";
  return {
    operationId: "66666666-6666-4666-8666-666666666666",
    outcome,
    stateChanged: changed,
    originalStateChanged: changed,
    replayed: false,
    attachedCount: changed ? 1 : 0,
    detachedCount: 0,
    skippedCount: outcome === "partial" ? 1 : 0,
  } as const;
}

const emptyAccounting = {
  removedAttachmentCount: 0,
  skippedAttachmentCount: 0,
  skippedNamespaceIds: [],
  residualDynamicRoomIds: [],
  residualDynamicNamespaceIds: [],
  residualAccessNamespaceIds: [],
} as const;

describe("M322 plaintext frozen Memory access adapter", () => {
  test("personal grant sends authenticated A+C actor IDs and preserves roomLabel/minted", async () => {
    findActorByHandleMock.mockImplementation(async () => ({
      kind: "user",
      actorId: UUID_TARGET_ACTOR,
    }));
    findActorByOwnerIdMock.mockImplementation(async () => ({ id: UUID_ACTOR }));
    const ordinary = ordinaryAccess({
      kind: "completed",
      receipt: receipt(),
      details: {
        destinations: [{
          namespaceId: "ns-person",
          roomId: "77777777-7777-4777-8777-777777777777",
          minted: true,
          label: "Alice & Bob",
        }],
        accounting: emptyAccounting,
      },
    });
    const app = makeApp(canonicalEnvelope(), ordinary.dependencies);

    const response = await app.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/grant`,
      payload: { user_handle: "@alice" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toEqual({
      status: "granted",
      roomLabel: "Alice & Bob",
      minted: true,
    });
    expect(ordinary.executeLegacyHuman).toHaveBeenCalledWith({
      principal: {
        kind: "human",
        userId: UUID_USER,
        actorId: UUID_ACTOR,
        sourceRoomId: UUID_SOURCE_ROOM,
        agentId: "agent-1",
      },
      audienceContract: "legacy_personal_grant",
      approvalContext: "nautilo/content-access/legacy-human-memory/v1",
    }, {
      object: { kind: "memory", id: UUID_MEM },
      change: { kind: "grant_people", selectedActorIds: [UUID_TARGET_ACTOR] },
    });
    expect(attachMock).not.toHaveBeenCalled();
  });

  test("Room grant retains membership/mutable checks and projects its namespace", async () => {
    getRoomWithAccessMock.mockImplementation(async () => ({
      namespaceId: "ns-target",
      humanActorIds: [UUID_ACTOR],
    }));
    findActorByOwnerIdMock.mockImplementation(async () => ({ id: UUID_ACTOR }));
    const ordinary = ordinaryAccess({
      kind: "completed",
      receipt: receipt(),
      details: {
        destinations: [{
          namespaceId: "ns-target",
          roomId: UUID_TARGET_ROOM,
          minted: false,
          label: "Project",
        }],
        accounting: emptyAccounting,
      },
    });
    const app = makeApp(canonicalEnvelope(), ordinary.dependencies);

    const response = await app.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/grant`,
      payload: { room_id: UUID_TARGET_ROOM },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toEqual({ status: "granted", namespaceId: "ns-target" });
    expect(ordinary.executeLegacyHuman.mock.calls[0]?.[1]).toEqual({
      object: { kind: "memory", id: UUID_MEM },
      change: { kind: "grant_room", targetRoomId: UUID_TARGET_ROOM },
    });
    expect(attachMock).not.toHaveBeenCalled();
  });

  test("revoke reports re-homed and every authorized residual Namespace fact", async () => {
    findActorByHandleMock.mockImplementation(async () => ({
      kind: "user",
      actorId: UUID_TARGET_ACTOR,
    }));
    findActorByIdMock.mockImplementation(async () => ({
      ownerId: "77777777-7777-4777-8777-777777777777",
    }));
    findActorByOwnerIdMock.mockImplementation(async () => ({ id: UUID_ACTOR }));
    const ordinary = ordinaryAccess({
      kind: "completed",
      receipt: receipt("partial"),
      details: {
        destinations: [],
        accounting: {
          removedAttachmentCount: 2,
          skippedAttachmentCount: 1,
          skippedNamespaceIds: ["ns-hidden"],
          residualDynamicRoomIds: ["room-dynamic"],
          residualDynamicNamespaceIds: ["ns-dynamic"],
          residualAccessNamespaceIds: ["ns-hidden", "ns-access"],
        },
      },
    });
    const app = makeApp(canonicalEnvelope(), ordinary.dependencies);

    const response = await app.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/revoke`,
      payload: { user_handle: "alice" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toEqual({
      status: "revoked",
      reHomed: 2,
      skipped: ["ns-hidden", "ns-dynamic", "ns-access"],
    });
    expect(ordinary.executeLegacyHuman.mock.calls[0]?.[1]).toEqual({
      object: { kind: "memory", id: UUID_MEM },
      change: { kind: "remove_person", actorId: UUID_TARGET_ACTOR },
    });
    expect(attachMock).not.toHaveBeenCalled();
    expect(detachMock).not.toHaveBeenCalled();
  });

  test("make-private preserves residual skipped Namespace facts", async () => {
    findActorByOwnerIdMock.mockImplementation(async () => ({ id: UUID_ACTOR }));
    const ordinary = ordinaryAccess({
      kind: "completed",
      receipt: receipt("partial"),
      details: {
        destinations: [],
        accounting: {
          ...emptyAccounting,
          skippedAttachmentCount: 1,
          skippedNamespaceIds: ["ns-unmodifiable"],
          residualDynamicRoomIds: ["room-dynamic"],
          residualDynamicNamespaceIds: ["ns-dynamic"],
        },
      },
    });
    const app = makeApp(canonicalEnvelope(), ordinary.dependencies);

    const response = await app.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/make_private`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toEqual({
      status: "private",
      skipped: ["ns-unmodifiable", "ns-dynamic"],
    });
    expect(ordinary.executeLegacyHuman.mock.calls[0]?.[1]).toEqual({
      object: { kind: "memory", id: UUID_MEM },
      change: { kind: "make_private" },
    });
    expect(findAgentOwnerPrivateRoomMock).not.toHaveBeenCalled();
    expect(attachMock).not.toHaveBeenCalled();
    expect(detachMock).not.toHaveBeenCalled();
  });

  test("missing core and receipt-only outcomes fail closed without legacy writes or metadata", async () => {
    findActorByOwnerIdMock.mockImplementation(async () => ({ id: UUID_ACTOR }));
    const withoutCore = makeApp(canonicalEnvelope(), {
      loadEncryptionPolicy: async () => policy("plaintext_only"),
    });
    const missing = await withoutCore.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/make_private`,
      payload: {},
    });
    expect(missing.statusCode).toBe(503);
    expect(missing.json<unknown>()).toEqual({
      error: "Memory access is temporarily unavailable",
      outcome: "failed",
      stateChanged: false,
    });

    const ordinary = ordinaryAccess({ kind: "receipt_only", receipt: receipt("already_applied") });
    const replayApp = makeApp(canonicalEnvelope(), ordinary.dependencies);
    const replay = await replayApp.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/make_private`,
      payload: {},
    });
    expect(replay.statusCode).toBe(503);
    expect(replay.json<unknown>()).toEqual({
      error: "Memory access result is unavailable",
      outcome: "failed",
      stateChanged: "unknown",
    });
    expect(attachMock).not.toHaveBeenCalled();
    expect(detachMock).not.toHaveBeenCalled();
  });

  test("requires the authenticated session and matching current Room actor", async () => {
    const ordinary = ordinaryAccess({
      kind: "completed",
      receipt: receipt(),
      details: { destinations: [], accounting: emptyAccounting },
    });
    const anonymous = Fastify({ logger: false });
    memoryRoutes(anonymous, undefined, allowOrdinaryShadowBoundary, ordinary.dependencies);
    anonymous.addHook("preHandler", async (request) => {
      (request as { memoryEnvelope?: MemoryAccessEnvelope }).memoryEnvelope = canonicalEnvelope();
    });
    expect((await anonymous.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/make_private`,
      payload: {},
    })).statusCode).toBe(401);

    findActorByOwnerIdMock.mockImplementation(async () => ({ id: UUID_TARGET_ACTOR }));
    const mismatched = makeApp(canonicalEnvelope(), ordinary.dependencies);
    expect((await mismatched.inject({
      method: "POST",
      url: `/api/memory/${UUID_MEM}/make_private`,
      payload: {},
    })).statusCode).toBe(403);
    expect(ordinary.executeLegacyHuman).not.toHaveBeenCalled();
  });
});
