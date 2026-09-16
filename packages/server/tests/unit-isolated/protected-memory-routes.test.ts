import { afterEach, describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import { NautiloApiClient, type NautiloApiFetch } from "@nautilo/api-client";
import {
  _resetAuthoredMemorySemanticChangeSinkForTests,
  installAuthoredMemorySemanticChangeSink,
  type AuthoredMemorySemanticChange,
} from "@nautilo/agent";

import {
  __mintProtectedMemoryTestShadowAuthorityForTesting,
  createProtectedMemoryTestShadowComposition,
  type ProtectedMemoryRouteAuthority,
  type ProtectedMemoryRoutePorts,
} from "../../src/routes/protected-memory-composition";
import { protectedMemoryRoutes } from "../../src/routes/protected-memory-routes";

const MEMORY = "10000000-0000-4000-8000-000000000001";
const A = "20000000-0000-4000-8000-000000000001";

const authority: ProtectedMemoryRouteAuthority = Object.freeze({
  userId: "user-1", actorId: "actor-1", agentId: null,
  memoryMode: "namespace", readableNamespaceIds: [A], mutableNamespaceIds: [A],
  writableNamespaceIds: [A], scopeId: null, originWritableNamespaceId: null,
  sourceRoomId: null,
});

function prepared() {
  return {
    requestVersion: 1 as const, operationId: "access:1", memoryId: MEMORY,
    expectedContentRevision: 2, expectedCryptoAccessRevision: 0,
    nextCryptoAccessRevision: 1, cryptoObjectId: "memory:v1:test",
    currentNamespaceIds: [A], targetNamespaceIds: [],
    accessManifestBytesBase64url: "bWFuaWZlc3Q",
    signedAccessRequestBytesBase64url: "c2lnbmVk", namespaceEnvelopes: [],
  };
}

function ports(): ProtectedMemoryRoutePorts {
  const unavailable = async () => ({ dtoVersion: 1 as const,
    status: "unavailable" as const, reason: "encryption_pending" as const });
  return {
    planCreate: unavailable,
    createPrepared: unavailable,
    updatePrepared: unavailable,
    list: unavailable,
    detail: unavailable,
    search: unavailable,
    brief: unavailable,
    archive: mock(async (request: Parameters<ProtectedMemoryRoutePorts["archive"]>[0]) => ({ operation: "archive" as const,
      operationId: request.operationId, memoryId: request.memoryId,
      response: { operationId: request.operationId, status: "archived" as const,
        contentRevision: request.expectedContentRevision,
        cryptoAccessRevision: request.expectedCryptoAccessRevision,
        previousTier: request.expectedTier, nextTier: 3 as const } })),
    transitionTier: mock(async (request:
      Parameters<ProtectedMemoryRoutePorts["transitionTier"]>[0]) => ({
      operation: "tier_transition" as const, operationId: request.operationId,
      memoryId: request.memoryId,
      response: { operationId: request.operationId,
        status: request.action === "promote" ? "promoted" as const : "demoted" as const,
        contentRevision: request.expectedContentRevision,
        cryptoAccessRevision: request.expectedCryptoAccessRevision,
        previousTier: request.expectedTier, nextTier: request.nextTier } })),
    restore: mock(async (request: Parameters<ProtectedMemoryRoutePorts["restore"]>[0]) => ({ operation: "restore" as const,
      operationId: request.operationId, memoryId: request.memoryId,
      response: { operationId: request.operationId, status: "restored" as const,
        contentRevision: request.expectedContentRevision,
        cryptoAccessRevision: request.expectedCryptoAccessRevision,
        previousTier: request.expectedTier, nextTier: request.nextTier } })),
    planAccess: mock(async ({ memoryId }:
      Parameters<ProtectedMemoryRoutePorts["planAccess"]>[0]) => ({ dtoVersion: 1 as const,
      status: "unchanged" as const, memoryId, cryptoAccessRevision: 0,
      requiredNamespaceIds: [A] })),
    commitAccess: mock(async ({ prepared: request }:
      Parameters<ProtectedMemoryRoutePorts["commitAccess"]>[0]) => ({ dtoVersion: 1 as const,
      status: "updated" as const, operationId: request.operationId,
      memoryId: request.memoryId,
      cryptoAccessRevision: request.nextCryptoAccessRevision,
      requiredNamespaceIds: request.targetNamespaceIds })),
  };
}

async function fixture(overrides: Partial<ProtectedMemoryRoutePorts> = {}) {
  const app = Fastify({ logger: false });
  const routePorts = { ...ports(), ...overrides };
  const legacyArchive = mock(() => Promise.resolve());
  const legacyDelete = mock(() => Promise.resolve());
  const composition = createProtectedMemoryTestShadowComposition({
    authority: __mintProtectedMemoryTestShadowAuthorityForTesting(),
    target: authority,
    ports: routePorts,
  });
  protectedMemoryRoutes(app, { composition,
    resolveAuthorizedRequest: async () => authority });
  await app.ready();
  const fetchImpl: NautiloApiFetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input
      : input instanceof URL ? input.href : input.url);
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      throw new TypeError("Test transport expected a JSON string body");
    }
    const response = await app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST" | "PATCH" | "DELETE",
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(body === undefined || body === null ? {} : { payload: body }),
    });
    return new Response(response.body, { status: response.statusCode,
      headers: { "content-type": "application/json" } });
  };
  const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
  client.setToken("test-session");
  return { app, client, routePorts, legacyArchive, legacyDelete };
}

describe("unified dormant protected Memory routes", () => {
  test("repair uses its own exact transport and does not issue semantic mutations", async () => {
    const commits: unknown[] = [];
    const state = await fixture({ repair: {
      plan: async ({ memoryId }) => ({ dtoVersion: 1, status: "not_needed", memoryId }),
      commit: async ({ authority: current, prepared }) => {
        commits.push({ current, prepared });
        return { dtoVersion: 1, status: "repaired", memoryId: prepared.memoryId,
          operationId: prepared.operationId, direction: prepared.direction,
          contentRevision: 1, cryptoAccessRevision: 0 };
      },
    } });
    try {
      expect(await state.client.planProtectedMemoryRepair(MEMORY)).toMatchObject({ status: "not_needed" });
      expect(await state.client.commitProtectedMemoryRepair(MEMORY, {
        requestVersion: 1, memoryId: MEMORY, operationId: "repair:1", direction: "protected_to_ordinary",
        signedRepairAttestationBytesBase64url: "c2lnbmVk", payload: { formatVersion: 1, type: "fact", content: "recovered" },
      })).toMatchObject({ status: "repaired" });
      expect(commits).toHaveLength(1);
      expect(commits[0]).toMatchObject({ current: authority });
      expect(state.routePorts.commitAccess).not.toHaveBeenCalled();
      expect(state.legacyArchive).not.toHaveBeenCalled();
      expect(state.legacyDelete).not.toHaveBeenCalled();
    } finally { await state.app.close(); }
  });

  test("repair refuses an uncomposed actor and malformed unsigned input", async () => {
    const state = await fixture();
    try {
      const denied = await state.app.inject({ method: "POST", url: `/api/protected/memories/${MEMORY}/repair-plan`,
        payload: { requestVersion: 1 } });
      expect(denied.statusCode).toBe(403);
      const malformed = await state.app.inject({ method: "POST", url: `/api/protected/memories/${MEMORY}/repair`,
        payload: { memoryId: MEMORY, content: "must not be an ordinary edit" } });
      expect(malformed.statusCode).toBe(400);
    } finally { await state.app.close(); }
  });
  afterEach(() => {
    _resetAuthoredMemorySemanticChangeSinkForTests();
  });

  test("carries tier and exact-access DTOs client-to-Fastify-to-one port surface", async () => {
    const changes: AuthoredMemorySemanticChange[] = [];
    installAuthoredMemorySemanticChangeSink(async (change) => {
      changes.push(change);
    });
    const state = await fixture();
    try {
      expect(await state.client.archiveProtectedMemory(MEMORY, {
        requestVersion: 1, operationId: "archive:1", expectedContentRevision: 2,
        expectedCryptoAccessRevision: 0, expectedTier: 1,
      })).toMatchObject({ status: "archived", tier: 3 });
      expect(await state.client.transitionProtectedMemoryTier(MEMORY, {
        requestVersion: 1, operationId: "tier:1", action: "promote",
        expectedContentRevision: 2, expectedCryptoAccessRevision: 0,
        expectedTier: 2, nextTier: 1,
      })).toMatchObject({ status: "promoted", previousTier: 2, nextTier: 1 });
      expect(await state.client.restoreProtectedMemory(MEMORY, {
        requestVersion: 1, operationId: "restore:1",
        expectedContentRevision: 2, expectedCryptoAccessRevision: 0,
        expectedTier: 3, nextTier: 2,
      })).toMatchObject({ status: "restored", previousTier: 3, nextTier: 2 });
      expect(await state.client.planProtectedMemoryAccess(MEMORY,
        { kind: "delete_authorized_view" })).toMatchObject({ status: "unchanged" });
      expect(await state.client.commitProtectedMemoryAccess(MEMORY, prepared()))
        .toMatchObject({ status: "updated", requiredNamespaceIds: [] });
      expect(state.routePorts.archive).toHaveBeenCalledTimes(1);
      expect(state.routePorts.restore).toHaveBeenCalledTimes(1);
      expect(state.routePorts.planAccess).toHaveBeenCalledTimes(1);
      expect(state.routePorts.commitAccess).toHaveBeenCalledTimes(1);
      // Effects belong to canonical publication receipts. A transport handler
      // must not fire a second unacknowledged notification after publication.
      expect(changes).toEqual([]);
      expect(state.legacyArchive).not.toHaveBeenCalled();
      expect(state.legacyDelete).not.toHaveBeenCalled();
    } finally {
      await state.app.close();
    }
  });

  test("has no broad grant, revoke, private, hard-delete, or connection routes", async () => {
    const state = await fixture();
    try {
      for (const target of ["grant", "revoke", "make-private", "connection"]) {
        const response = await state.app.inject({ method: "POST",
          url: `/api/protected/memories/${MEMORY}/${target}`, payload: {} });
        expect(response.statusCode).toBe(404);
      }
      expect(Object.keys(state.routePorts)).not.toContain("hardDelete");
    } finally {
      await state.app.close();
    }
  });
});
