import { describe, expect, mock, test } from "bun:test";
import type {
  ProtectedMemoryDtoV1,
  ProtectedMemoryPreparedAccessRequestV1,
  ProtectedMemoryUnavailableResponseV1,
} from "@nautilo/api-client";

import {
  __mintHumanMemoryProtectedRouteTestAuthorityForTesting,
  createHumanMemoryProtectedRoutePorts,
  createHumanMemoryProtectedRoutePortsFromTrustedPorts,
  type HumanMemoryProtectedRouteAssembly,
  type HumanMemoryProtectedExactAccessCryptoPort,
  type HumanMemoryProtectedExactAccessProductPort,
  type HumanMemoryProtectedProductRoutePort,
  type HumanMemoryProtectedRouteAuthority,
  type HumanMemoryNamespaceAuthorityV1,
} from "../../src/server/memory/human-memory-protected-route-ports.ts";
import { HumanMemoryCryptoServiceUnavailableError } from
  "../../src/server/memory/human-memory-crypto-availability.ts";
import type { HumanMemoryExactAccessPlan } from "../../src/server/memory/postgres-human-memory-exact-access-product.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const HUMAN = "human-1";
const MEMORY = "33333333-3333-4333-8333-333333333333";
const A = "44444444-4444-4444-8444-444444444444";
const B = "55555555-5555-4555-8555-555555555555";
const OBJECT = "memory:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const target: HumanMemoryProtectedRouteAuthority = Object.freeze({
  userId: USER,
  actorId: "human-actor",
  agentId: null,
  memoryMode: "namespace",
  readableNamespaceIds: [A],
  mutableNamespaceIds: [A],
  writableNamespaceIds: [A, B],
  scopeId: null,
  originWritableNamespaceId: null,
  sourceRoomId: null,
});

function unavailable(
  reason: ProtectedMemoryUnavailableResponseV1["reason"],
): ProtectedMemoryUnavailableResponseV1 {
  return { dtoVersion: 1, status: "unavailable", reason };
}

function dto(): ProtectedMemoryDtoV1 {
  return {
    dtoVersion: 1,
    projection: {
      memoryId: MEMORY,
      contentRevision: 3,
      cryptoAccessRevision: 1,
      importance: 0.5,
      tier: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      namespaceIds: [A],
      requiredNamespaceIds: [A],
      readAuthorities: [{ sourceRoomId: MEMORY, namespaceId: A,
        currentGeneration: 0,
        retainedGenerations: [{ generation: 0, accessRevision: 1,
          headDigestBase64url: "AA", publicationDigestBase64url: "AA",
          publicationSetDigestBase64url: "AA", audienceFingerprintBase64url: "AA" }] }],
    },
    protectedPayload: {
      status: "encrypted",
      cryptoObjectId: OBJECT,
      payloadVersion: 1,
      encryptedPayloadBytesBase64url: "AQ",
      accessManifestBytesBase64url: "Ag",
      accessSignerEvidence: [],
      namespaceEnvelopes: [{ namespaceId: A, envelopeBytesBase64url: "Aw" }],
    },
  };
}

function plan(): HumanMemoryExactAccessPlan {
  return {
    status: "prepared",
    operationId: "access:1",
    subjectHumanId: HUMAN,
    anchorNamespaceId: A,
    memoryId: MEMORY,
    cryptoObjectId: OBJECT,
    expectedContentRevision: 3,
    expectedCryptoAccessRevision: 1,
    nextCryptoAccessRevision: 2,
    currentRequiredNamespaceFingerprint: new Uint8Array(32).fill(0x11),
    targetRequiredNamespaceFingerprint: new Uint8Array(32).fill(0x22),
    currentNamespaceIds: [A],
    targetNamespaceIds: [A, B],
    addedNamespaceIds: [B],
    removedNamespaceIds: [],
  };
}

function prepared(): ProtectedMemoryPreparedAccessRequestV1 {
  return {
    requestVersion: 1,
    operationId: "access:1",
    memoryId: MEMORY,
    expectedContentRevision: 3,
    expectedCryptoAccessRevision: 1,
    nextCryptoAccessRevision: 2,
    cryptoObjectId: OBJECT,
    currentNamespaceIds: [A],
    targetNamespaceIds: [A, B],
    accessManifestBytesBase64url: "bWFuaWZlc3Q",
    signedAccessRequestBytesBase64url: "c2lnbmVk",
    namespaceEnvelopes: [
      { namespaceId: A, envelopeBytesBase64url: "ZW52LWE" },
      { namespaceId: B, envelopeBytesBase64url: "ZW52LWI" },
    ],
  };
}

function fixture(boundTarget = target, production = false) {
  const exactPlan = plan();
  let replay: Awaited<ReturnType<
    HumanMemoryProtectedExactAccessProductPort["lookupReplay"]
  >> = { status: "absent" };
  let reconcile: Awaited<ReturnType<
    HumanMemoryProtectedExactAccessProductPort["reconcile"]
  >> = { status: "quarantined" };
  const product: HumanMemoryProtectedProductRoutePort = {
    list: mock(async ({ authority }:
      Parameters<HumanMemoryProtectedProductRoutePort["list"]>[0]) => ({ dtoVersion: 1 as const,
      items: [dto()], nextCursor: null, total: 1,
      memoryMode: authority.memoryMode })),
    detail: mock(async ({ authority }:
      Parameters<HumanMemoryProtectedProductRoutePort["detail"]>[0]) => ({ dtoVersion: 1 as const,
      memory: dto(), memoryMode: authority.memoryMode,
      actionAuthority: { canEdit: true, canArchive: true, canManageAccess: true } })),
    searchSemantic: mock(async ({ authority }:
      Parameters<HumanMemoryProtectedProductRoutePort["searchSemantic"]>[0]) => ({ dtoVersion: 1 as const,
      items: [{ memory: dto(), score: 0.75 }], memoryMode: authority.memoryMode,
      queryDisclosure: "embedding_provider" as const })),
    brief: mock(async ({ authority }:
      Parameters<HumanMemoryProtectedProductRoutePort["brief"]>[0]) => ({ dtoVersion: 1 as const,
      items: [dto()], memoryMode: authority.memoryMode })),
    transitionTier: mock(async (request:
      Parameters<HumanMemoryProtectedProductRoutePort["transitionTier"]>[0]) => ({
      operation: request.action === "archive" ? "archive" as const
        : request.action === "restore" ? "restore" as const
        : "tier_transition" as const,
      operationId: request.operationId,
      memoryId: request.memoryId,
      response: {
        operationId: request.operationId,
        status: request.action === "archive" ? "archived" as const
          : request.action === "restore" ? "restored" as const
          : request.action === "promote" ? "promoted" as const
          : "demoted" as const,
        contentRevision: request.expectedContentRevision,
        cryptoAccessRevision: request.expectedCryptoAccessRevision,
        previousTier: request.expectedTier,
        nextTier: request.nextTier,
      },
    })),
  };
  const resolveTarget = mock(async () => ({ kind: "replace_exact" as const,
    namespaceIds: [A, B] }));
  const exactProduct: HumanMemoryProtectedExactAccessProductPort = {
    resolveTarget,
    plan: mock(async () => exactPlan),
    lookupReplay: mock(async () => replay),
    reserve: mock(async () => "reserved" as const),
    commit: mock(async () => ({ status: "updated" as const,
      operationId: "access:1", memoryId: MEMORY, cryptoAccessRevision: 2,
      requiredNamespaceIds: [A, B] })),
    commitOrdinaryFallback: mock(async () => ({
      status: "ordinary_fallback" as const,
      operationId: "access:1", memoryId: MEMORY, cryptoAccessRevision: 1,
      requiredNamespaceIds: [A, B], reason: "encryption_pending" as const,
    })),
    reconcile: mock(async () => reconcile),
  };
  const digest = new Uint8Array(32).fill(0x77);
  const exactCrypto: HumanMemoryProtectedExactAccessCryptoPort = {
    digestSignedRequest: mock(() => new Uint8Array(32).fill(0x77)),
    authenticate: mock(async () => ({ handle: Object.freeze({}) as never,
      signedRequestDigest: digest, publicationAuthority: Object.freeze({}) as never })),
    complete: mock(async () => ({
      operationId: "access:1", memoryId: MEMORY, objectId: OBJECT,
      expectedContentRevision: 3, expectedAccessRevision: 1,
      resultAccessRevision: 2, currentManifestHash: new Uint8Array(32),
      resultManifestHash: new Uint8Array(32),
      targetRequiredNamespaceFingerprint: new Uint8Array(32).fill(0x22),
      requestDigest: new Uint8Array(32).fill(0x77),
      currentNamespaceIds: [A], targetNamespaceIds: [A, B],
      status: "applied" as const,
    })),
    observe: mock(async () => ({ status: "target" as const, objectId: OBJECT,
      accessRevision: 1, manifestHash: new Uint8Array(32),
      previousManifestHash: new Uint8Array(32).fill(1), namespaceIds: [A],
      namespaceEnvelopeCoordinates: [{ namespaceId: A, generation: 0,
        accessRevision: 1 }] })),
  };
  const resolveNamespaceAuthority = mock(async ({ namespaceId }: {
    namespaceId: string }): Promise<HumanMemoryNamespaceAuthorityV1 | null> => ({
      sourceRoomId: "11111111-1111-4111-8111-111111111119", namespaceId,
      currentGeneration: 0,
      retainedGenerations: [{ generation: 0, accessRevision: 1,
        headDigestBase64url: "AA", publicationDigestBase64url: "AA",
        publicationSetDigestBase64url: "AA", audienceFingerprintBase64url: "AA" }],
    }));
  const assembly: HumanMemoryProtectedRouteAssembly = {
    target: boundTarget,
    now: () => 1_800_000_000_000,
    createRequestId: () => "query:1",
    createAccessOperationId: () => "access:1",
    accessDeadlineAt: () => 1_800_000_030_000,
    queryProvider: "openai",
    queryModel: "text-embedding-3-small",
    resolveHumanId: async () => HUMAN,
    foregroundEmbeddingProcessor: { embed: async () => ({ status: "unavailable",
      reason: "provider_unavailable" }) },
    product,
    preparedCreate: { planCreate: async () => unavailable("encryption_pending"),
      createPrepared: async () => unavailable("encryption_pending") },
    preparedUpdate: { updatePrepared: async () => unavailable("encryption_pending") },
    exactAccessProduct: exactProduct,
    exactAccessCrypto: exactCrypto,
    resolveNamespaceAuthority,
  };
  const ports = production
    ? createHumanMemoryProtectedRoutePortsFromTrustedPorts(assembly)
    : createHumanMemoryProtectedRoutePorts({ ...assembly,
      authority: __mintHumanMemoryProtectedRouteTestAuthorityForTesting() });
  return { ports, product, exactProduct, exactCrypto, resolveTarget,
    resolveNamespaceAuthority, digest,
    setReplay(value: typeof replay) { replay = value; },
    setReconcile(value: typeof reconcile) { reconcile = value; } };
}

describe("unified dormant Human protected Memory route ports", () => {
  test("production assembly accepts populated Human authority without an account-wide 256 Namespace ceiling", async () => {
    const namespaceIds = [...new Set([A, B, ...Array.from({ length: 300 }, (_, i) =>
      `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`)])];
    const authority = { ...target, readableNamespaceIds: namespaceIds,
      mutableNamespaceIds: namespaceIds };
    const { ports, product } = fixture(authority, true);
    await ports.detail({ authority, memoryId: MEMORY, canManageMemories: true });
    expect(product.detail).toHaveBeenCalledTimes(1);
    await ports.detail({ authority: { ...authority, userId: "other-human" },
      memoryId: MEMORY, canManageMemories: true });
    expect(product.detail).toHaveBeenCalledTimes(1);
  });
  test("exposes one exact surface and no obsolete broad mutations", () => {
    const { ports } = fixture();
    expect(Object.keys(ports).sort()).toEqual([
      "archive", "brief", "commitAccess", "createPrepared", "detail", "list",
      "planAccess", "planCreate", "restore", "search", "transitionTier",
      "updatePrepared",
    ]);
  });

  test("applies exact tier CAS coordinates for an M:N-capable authority", async () => {
    const state = fixture();
    const result = await state.ports.archive({ authority: target,
      operationId: "tier:1", memoryId: MEMORY, expectedContentRevision: 3,
      expectedCryptoAccessRevision: 1, expectedTier: 1 });
    expect(result).toMatchObject({ operation: "archive", operationId: "tier:1",
      response: { status: "archived", previousTier: 1, nextTier: 3 } });
    expect(productCall(state.product, "transitionTier")).toMatchObject({
      subjectHumanId: HUMAN, action: "archive", nextTier: 3,
    });
  });

  test("plans, authenticates, reserves, and commits exact M:N access", async () => {
    const state = fixture();
    expect(await state.ports.planAccess({ authority: target, memoryId: MEMORY,
      operation: { kind: "grant_room", roomId: MEMORY } })).toMatchObject({
      status: "planned", currentNamespaceIds: [A], targetNamespaceIds: [A, B],
    });
    expect(await state.ports.commitAccess({ authority: target, memoryId: MEMORY,
      prepared: prepared() })).toEqual({ dtoVersion: 1, status: "updated",
      operationId: "access:1", memoryId: MEMORY, cryptoAccessRevision: 2,
      requiredNamespaceIds: [A, B] });
    expect(state.exactProduct.reserve).toHaveBeenCalledTimes(1);
    expect(state.exactCrypto.complete).toHaveBeenCalledTimes(1);
    expect(state.digest.every((byte) => byte === 0)).toBe(true);
  });

  test("returns only authorized exact Namespace readiness coordinates", async () => {
    const readinessAuthority = { ...target, sourceRoomId: MEMORY };
    const state = fixture(readinessAuthority);
    state.resolveTarget.mockResolvedValue({
      kind: "namespace_readiness_required",
      anchorNamespaceId: A,
      namespaceIds: [B],
    } as never);
    expect(await state.ports.planAccess({ authority: readinessAuthority, memoryId: MEMORY,
      operation: { kind: "grant_user", userHandle: "bob" } })).toEqual({
      dtoVersion: 1,
      status: "readiness_required",
      reason: "target_encryption_not_ready",
      memoryId: MEMORY,
      sourceRoomId: "11111111-1111-4111-8111-111111111119",
      requiredNamespaceIds: [B],
    });
    expect(state.exactProduct.plan).toHaveBeenCalledTimes(0);
    expect(state.resolveNamespaceAuthority).toHaveBeenCalledWith({
      subjectUserId: target.userId,
      subjectHumanId: HUMAN,
      preferredSourceRoomId: null,
      namespaceId: A,
      requested: [],
    });
  });

  test("returns an exact readiness result for a headless authorized addition", async () => {
    const readinessAuthority = { ...target, sourceRoomId: MEMORY };
    const state = fixture(readinessAuthority);
    state.resolveNamespaceAuthority.mockImplementation(async ({ namespaceId }) =>
      namespaceId === B ? null : {
        sourceRoomId: MEMORY, namespaceId, currentGeneration: 0,
        retainedGenerations: [{ generation: 0, accessRevision: 1,
          headDigestBase64url: "AA", publicationDigestBase64url: "AA",
          publicationSetDigestBase64url: "AA", audienceFingerprintBase64url: "AA" }],
      });
    expect(await state.ports.planAccess({ authority: readinessAuthority,
      memoryId: MEMORY,
      operation: { kind: "grant_user", userHandle: "bob" } })).toEqual({
      dtoVersion: 1, status: "readiness_required",
      reason: "target_encryption_not_ready", memoryId: MEMORY,
      sourceRoomId: MEMORY, requiredNamespaceIds: [B],
    });
  });

  test("replays only durable access facts before live authentication", async () => {
    const state = fixture();
    state.setReplay({ status: "completed", requestDigest: new Uint8Array(32),
      cryptoAccessRevision: 9, requiredNamespaceIds: [] });
    const outer = { ...prepared(), cryptoObjectId: `${OBJECT}:substituted`,
      targetNamespaceIds: [A], nextCryptoAccessRevision: 99 };
    expect(await state.ports.commitAccess({ authority: target, memoryId: MEMORY,
      prepared: outer })).toMatchObject({ status: "replayed",
      cryptoAccessRevision: 9, requiredNamespaceIds: [] });
    expect(state.exactCrypto.authenticate).not.toHaveBeenCalled();
  });

  test("reauthenticates an exact pending receipt and propagates its opaque admission", async () => {
    const state = fixture();
    const replayAdmission = Object.freeze({}) as never;
    state.setReplay({ status: "pending", requestDigest: new Uint8Array(32).fill(0x77),
      cryptoObjectId: OBJECT, replayAdmission });
    state.setReconcile({ status: "pending", phase: "crypto" });
    expect(await state.ports.commitAccess({ authority: target, memoryId: MEMORY,
      prepared: prepared() })).toMatchObject({ status: "updated" });
    expect(state.exactCrypto.authenticate).toHaveBeenCalledWith(expect.objectContaining({
      replayAdmission,
    }));
    expect(state.exactCrypto.complete).toHaveBeenCalledTimes(1);
  });

  test("terminalizes an admitted exact-access request as ordinary fallback when crypto is unavailable", async () => {
    const state = fixture();
    (state.exactCrypto.complete as ReturnType<typeof mock>)
      .mockImplementationOnce(async () => {
        throw new HumanMemoryCryptoServiceUnavailableError();
      });
    expect(await state.ports.commitAccess({ authority: target, memoryId: MEMORY,
      prepared: prepared() })).toEqual({
      dtoVersion: 1, status: "ordinary_fallback", operationId: "access:1",
      memoryId: MEMORY, cryptoAccessRevision: 1,
      requiredNamespaceIds: [A, B], reason: "encryption_pending",
    });
    expect(state.exactProduct.reserve).toHaveBeenCalledTimes(1);
    expect(state.exactProduct.commitOrdinaryFallback).toHaveBeenCalledTimes(1);
    expect(state.exactProduct.commit).not.toHaveBeenCalled();
  });
});

function productCall(
  product: HumanMemoryProtectedProductRoutePort,
  operation: "transitionTier",
): unknown {
  return (product[operation] as ReturnType<typeof mock>).mock.calls[0]?.[0];
}
