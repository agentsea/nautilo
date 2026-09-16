import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";

import { NautiloApiClient, type NautiloApiFetch } from "../../src/client";
import type {
  ProtectedMemoryDtoV1,
  ProtectedMemoryPreparedCreateRequestV1,
  ProtectedMemoryPreparedUpdateRequestV1,
} from "../../src/schemas/protected-memory";

const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const NAMESPACE_ID = "22222222-2222-4222-8222-222222222222";
const SEALED = {
  formatVersion: 1 as const,
  recipientId: "A".repeat(43),
  ciphertextBase64url: "c2VhbGVk",
};

function dto(revision = 1): ProtectedMemoryDtoV1 {
  return {
    dtoVersion: 1,
    projection: {
      memoryId: MEMORY_ID,
      contentRevision: revision,
      cryptoAccessRevision: 0,
      importance: 0.5,
      tier: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      namespaceIds: [NAMESPACE_ID],
      requiredNamespaceIds: [NAMESPACE_ID],
      readAuthorities: [{
        namespaceId: NAMESPACE_ID,
        sourceRoomId: "33333333-3333-4333-8333-333333333333",
        currentGeneration: 0,
        retainedGenerations: [{
          generation: 0, accessRevision: 0,
          headDigestBase64url: "aGVhZA",
          publicationDigestBase64url: "aGVhZA",
          publicationSetDigestBase64url: "aGVhZA",
          audienceFingerprintBase64url: "aGVhZA",
        }],
      }],
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

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): NautiloApiClient {
  const fetchImpl: NautiloApiFetch = async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    return handler(url, init ?? {});
  };
  const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
  client.setToken("session-token");
  return client;
}

async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

function preparedCreate(): ProtectedMemoryPreparedCreateRequestV1 {
  return {
    requestVersion: 1,
    memoryId: MEMORY_ID,
    operationId: "memory-create:1",
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

describe("protected Human Memory HTTP methods", () => {
  test("plans and commits one exact signed access update", async () => {
    const bodies: unknown[] = [];
    const client = clientWith((url, init) => {
      if (typeof init.body === "string") bodies.push(JSON.parse(init.body));
      if (url.endsWith("/access-plan")) return response({
        dtoVersion: 1, status: "unchanged", memoryId: MEMORY_ID,
        cryptoAccessRevision: 0, requiredNamespaceIds: [NAMESPACE_ID],
      });
      return response({
        dtoVersion: 1, status: "updated", operationId: "access:1",
        memoryId: MEMORY_ID, cryptoAccessRevision: 1,
        requiredNamespaceIds: [],
      });
    });
    expect(await client.planProtectedMemoryAccess(MEMORY_ID, {
      kind: "grant_user", userHandle: "bob",
    })).toMatchObject({ status: "unchanged" });
    expect(await client.commitProtectedMemoryAccess(MEMORY_ID, {
      requestVersion: 1, operationId: "access:1", memoryId: MEMORY_ID,
      expectedContentRevision: 1, expectedCryptoAccessRevision: 0,
      nextCryptoAccessRevision: 1,
      cryptoObjectId: `nautilo-memory-v1:${MEMORY_ID}:1`,
      currentNamespaceIds: [NAMESPACE_ID], targetNamespaceIds: [],
      accessManifestBytesBase64url: "bWFuaWZlc3Q",
      signedAccessRequestBytesBase64url: "c2lnbmVkLWFjY2Vzcy1yZXF1ZXN0",
      namespaceEnvelopes: [],
    })).toMatchObject({ status: "updated", cryptoAccessRevision: 1 });
    expect(bodies).toHaveLength(2);
  });
  test("parses encrypted list/detail/search/brief responses with canonical schemas", async () => {
    const seen: string[] = [];
    const searchRequests: RequestInit[] = [];
    const client = clientWith((url, init) => {
      seen.push(url);
      if (url.endsWith("/api/memory/search")) {
        searchRequests.push(init);
        return response({
        dtoVersion: 1,
        items: [{ memory: dto(), score: 0.75 }],
        memoryMode: "namespace",
        queryDisclosure: "embedding_provider",
      });
      }
      if (url.endsWith(`/api/memory/${MEMORY_ID}`)) return response({
        dtoVersion: 1,
        memory: dto(),
        memoryMode: "namespace",
        actionAuthority: {
          canEdit: true,
          canArchive: true,
          canManageAccess: true,
        },
      });
      if (url.endsWith("/api/memory/brief")) return response({
        dtoVersion: 1,
        items: [dto()],
        memoryMode: "namespace",
      });
      return response({
        dtoVersion: 1,
        items: [dto()],
        nextCursor: null,
        memoryMode: "namespace",
        total: 1,
      });
    });

    const list = await client.listProtectedMemories({ limit: 10 });
    const detail = await client.getProtectedMemory(MEMORY_ID);
    const search = await client.searchProtectedMemories({
      sealedQuery: SEALED,
      mode: "semantic",
    });
    const brief = await client.getProtectedMemoryBrief();
    expect("items" in list && list.items.length).toBe(1);
    expect("memory" in detail && detail.memory.projection.memoryId)
      .toBe(MEMORY_ID);
    expect("items" in search && search.items[0]?.score).toBe(0.75);
    expect("items" in brief && brief.items.length).toBe(1);
    expect(seen.some((url) => url.includes("private"))).toBe(false);
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]?.method).toBe("POST");
    const searchBody = searchRequests[0]?.body;
    expect(typeof searchBody).toBe("string");
    if (typeof searchBody !== "string") {
      throw new TypeError("Protected Memory search body was not JSON text");
    }
    expect(JSON.parse(searchBody)).toEqual({
      sealedQuery: SEALED,
      mode: "semantic",
    });
    expect(searchBody).not.toContain("private query");
  });

  test("returns canonical typed unavailable without retrying a legacy path", async () => {
    let calls = 0;
    const client = clientWith(() => {
      calls += 1;
      return response({
        dtoVersion: 1,
        status: "unavailable",
        reason: "text_search_unsupported",
      });
    });
    const result = await client.searchProtectedMemories({
      sealedQuery: SEALED,
      mode: "text",
    });
    expect(result).toEqual({
      dtoVersion: 1,
      status: "unavailable",
      reason: "text_search_unsupported",
    });
    expect(calls).toBe(1);
  });

  test("rejects plaintext legacy and malformed protected successes", async () => {
    const legacy = clientWith(() => response({
      items: [{ id: MEMORY_ID, content: "must not cross selected boundary" }],
      nextCursor: null,
      memoryMode: "namespace",
    }));
    expect(await captureError(legacy.listProtectedMemories()))
      .toBeInstanceOf(ZodError);

    const substituted = clientWith(() => response({
      dtoVersion: 1,
      memory: { ...dto(), projection: { ...dto().projection, memoryId: NAMESPACE_ID } },
      memoryMode: "namespace",
      actionAuthority: {
        canEdit: true,
        canArchive: true,
        canManageAccess: true,
      },
    }));
    const substitutionError = await captureError(
      substituted.getProtectedMemory(MEMORY_ID),
    );
    expect(substitutionError).toBeInstanceOf(TypeError);
    expect((substitutionError as Error).message).toContain("requested Memory");
  });

  test("plans and publishes canonical prepared create/update requests exactly", async () => {
    const bodies: unknown[] = [];
    const methods: string[] = [];
    const client = clientWith((_url, init) => {
      methods.push(init.method ?? "GET");
      if (init.body !== undefined) {
        if (typeof init.body !== "string") {
          throw new TypeError("expected JSON string body");
        }
        bodies.push(JSON.parse(init.body));
      }
      if (init.method === "PATCH") return response({
        dtoVersion: 1,
        status: "published",
        memory: dto(2),
      });
      if (init.body !== undefined) return response({
        dtoVersion: 1,
        status: "published",
        memory: dto(1),
      });
      return response({
        dtoVersion: 1,
        memoryId: MEMORY_ID,
        operationId: "memory-create:1",
        expectedContentRevision: 0,
        nextContentRevision: 1,
        productAuthority: { mode: "namespace" },
        requiredNamespaceIds: [NAMESPACE_ID],
        targetAuthorities: dto().projection.readAuthorities,
        deadlineAt: 1_786_406_430_000,
      });
    });

    const plan = await client.planProtectedMemoryCreate();
    expect("memoryId" in plan && plan.memoryId).toBe(MEMORY_ID);
    await client.createProtectedMemory(preparedCreate(), SEALED);
    await client.updateProtectedMemory(MEMORY_ID, preparedUpdate(), SEALED);
    expect(methods).toEqual(["POST", "POST", "PATCH"]);
    const {
      signedContentEmbeddingRequestBytesBase64url: _createSigned,
      ...createBody
    } = preparedCreate();
    const {
      signedContentEmbeddingRequestBytesBase64url: _updateSigned,
      ...updateBody
    } = preparedUpdate();
    expect(bodies).toEqual([
      {
        ...createBody,
        sealedContentEmbeddingRequest: SEALED,
      },
      {
        ...updateBody,
        sealedContentEmbeddingRequest: SEALED,
      },
    ]);
    expect(JSON.stringify(bodies)).not.toContain("c2lnbmVkLXJlcXVlc3Q");
  });

  test("rejects content publications that do not return exact v5 genesis authority", async () => {
    const nonGenesis = clientWith((_url, init) => response({
      dtoVersion: 1,
      status: "published",
      memory: {
        ...dto(init.method === "PATCH" ? 2 : 1),
        projection: {
          ...dto(init.method === "PATCH" ? 2 : 1).projection,
          cryptoAccessRevision: 1,
        },
      },
    }));
    expect(await captureError(nonGenesis.createProtectedMemory(preparedCreate(), SEALED)))
      .toBeInstanceOf(TypeError);
    expect(await captureError(
      nonGenesis.updateProtectedMemory(MEMORY_ID, preparedUpdate(), SEALED),
    )).toBeInstanceOf(TypeError);

    const wrongAudience = clientWith(() => response({
      dtoVersion: 1,
      status: "published",
      memory: {
        ...dto(),
        projection: {
          ...dto().projection,
          namespaceIds: [],
          requiredNamespaceIds: [],
        },
        protectedPayload: {
          ...dto().protectedPayload,
          namespaceEnvelopes: [],
        },
      },
    }));
    expect(await captureError(wrongAudience.createProtectedMemory(preparedCreate(), SEALED)))
      .toBeInstanceOf(ZodError);
  });

  test("exposes deletion only through exact access planning", () => {
    const client = clientWith(() => response({}));
    expect("hardDeleteProtectedMemory" in client).toBe(false);
    expect("deleteProtectedMemoryConnection" in client).toBe(false);
    expect("planProtectedMemoryAccess" in client).toBe(true);
    expect("commitProtectedMemoryAccess" in client).toBe(true);
  });

  test("binds content-free archive, tier, and restore requests exactly", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const client = clientWith((url, init) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      calls.push({ url, method: init.method ?? "GET", body });
      if (url.endsWith("/archive")) return response({
        dtoVersion: 1,
        operationId: "memory-metadata:1",
        status: "archived",
        memoryId: MEMORY_ID,
        contentRevision: 2,
        cryptoAccessRevision: 0,
        tier: 3,
      });
      if (url.endsWith("/tier")) return response({
        dtoVersion: 1,
        operationId: "memory-tier:1",
        status: "promoted",
        memoryId: MEMORY_ID,
        contentRevision: 2,
        cryptoAccessRevision: 0,
        previousTier: 2,
        nextTier: 1,
      });
      if (url.endsWith("/restore")) return response({
        dtoVersion: 1,
        operationId: "memory-restore:1",
        status: "restored",
        memoryId: MEMORY_ID,
        contentRevision: 2,
        cryptoAccessRevision: 0,
        previousTier: 3,
        nextTier: 2,
      });
      return response({
        dtoVersion: 1,
        operationId: "memory-delete:1",
        status: "deleted",
        memoryId: MEMORY_ID,
      });
    });
    const common = {
      requestVersion: 1 as const,
      operationId: "memory-metadata:1",
      expectedContentRevision: 2,
      expectedCryptoAccessRevision: 0,
    };
    await client.archiveProtectedMemory(MEMORY_ID, {
      ...common,
      expectedTier: 2,
    });
    await client.transitionProtectedMemoryTier(MEMORY_ID, {
      ...common,
      operationId: "memory-tier:1",
      action: "promote",
      expectedTier: 2,
      nextTier: 1,
    });
    await client.restoreProtectedMemory(MEMORY_ID, {
      ...common,
      operationId: "memory-restore:1",
      expectedTier: 3,
      nextTier: 2,
    });
    expect(calls.map(({ url, method }) => ({
      path: new URL(url).pathname,
      method,
    }))).toEqual([
      { path: `/api/protected/memories/${MEMORY_ID}/archive`, method: "POST" },
      { path: `/api/protected/memories/${MEMORY_ID}/tier`, method: "POST" },
      { path: `/api/protected/memories/${MEMORY_ID}/restore`, method: "POST" },
    ]);
    expect(JSON.stringify(calls)).not.toContain("provider");
  });

  test("rejects arbitrary tier changes and substituted metadata receipts", async () => {
    let calls = 0;
    const client = clientWith(() => {
      calls += 1;
      return response({
        dtoVersion: 1,
        operationId: "substituted-operation",
        status: "promoted",
        memoryId: NAMESPACE_ID,
        contentRevision: 2,
        cryptoAccessRevision: 0,
        previousTier: 2,
        nextTier: 1,
      });
    });
    const invalid = await captureError(client.transitionProtectedMemoryTier(
      MEMORY_ID,
      {
        requestVersion: 1,
        operationId: "memory-tier:bad",
        expectedContentRevision: 2,
        expectedCryptoAccessRevision: 0,
        action: "promote",
        expectedTier: 2,
        nextTier: 3,
      },
    ));
    expect(invalid).toBeInstanceOf(ZodError);
    expect(calls).toBe(0);

    const substituted = await captureError(
      client.transitionProtectedMemoryTier(MEMORY_ID, {
        requestVersion: 1,
        operationId: "memory-tier:1",
        expectedContentRevision: 2,
        expectedCryptoAccessRevision: 0,
        action: "promote",
        expectedTier: 2,
        nextTier: 1,
      }),
    );
    expect(substituted).toBeInstanceOf(TypeError);
    expect(calls).toBe(1);
  });

  test("validates prepared publications before transport", async () => {
    let calls = 0;
    const client = clientWith(() => {
      calls += 1;
      return response({});
    });
    const invalid = { ...preparedUpdate(), nextContentRevision: 9 };
    expect(await captureError(
      client.updateProtectedMemory(MEMORY_ID, invalid, SEALED),
    )).toBeInstanceOf(ZodError);
    expect(calls).toBe(0);
  });
});
