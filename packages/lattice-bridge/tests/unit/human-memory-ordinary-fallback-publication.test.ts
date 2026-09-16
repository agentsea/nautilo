import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";

import { prepareHumanMemoryOrdinaryFallbackRequestV1,
  createHumanMemoryOrdinaryFallbackReplayAdmissionV1 } from
  "../../src/memory/human-memory-ordinary-fallback-request.ts";
import { publishHumanMemoryOrdinaryFallbackIntent } from
  "../../src/server/memory/human-memory-ordinary-fallback-publication.ts";
import { createHumanMemoryPreparedCreateRoutePort } from
  "../../src/server/memory/human-memory-prepared-create-composition.ts";
import type { HumanMemoryProductAuthority } from
  "../../src/server/memory/postgres-human-memory-product-update.ts";
import type { HumanMemoryProductCreatePort } from
  "../../src/server/memory/postgres-human-memory-product-update.ts";

const MEMORY = "81000000-0000-4000-8000-000000000001";
const NAMESPACE = "81000000-0000-4000-8000-000000000010";
const authority: HumanMemoryProductAuthority = Object.freeze({ userId: "user-1",
  mutableNamespaceIds: [NAMESPACE], writableNamespaceIds: [NAMESPACE] });

function fixture() {
  const crypto = new LatticeCrypto();
  const signer = crypto.generateSigningKeyPair();
  const signed = prepareHumanMemoryOrdinaryFallbackRequestV1(crypto, {
    formatVersion: 1, purpose: "memory.ordinary_fallback.update",
    reason: "target_encryption_not_ready", operationId: "operation-1",
    memoryId: MEMORY, expectedContentRevision: 2, nextContentRevision: 3,
    expectedCryptoAccessRevision: 1, requiredNamespaceIds: [NAMESPACE],
    type: "preference", content: "Keep this", requestedProvider: "openai",
    requestedModel: "text-embedding-3-small", dimensions: 1536,
    processorContractVersion: 1, policyRevision: 4, subjectHumanId: "human-1",
    committerDeviceId: "device-1", committerDeviceSigningKeyGeneration: 2,
    hostAuthorizationRevision: 3, planIssuedAt: null, planDeadlineAt: null,
    issuedAt: 1_000, deadlineAt: 31_000,
    signingPrivateKey: signer.privateKey,
  });
  return { crypto, signer, submitted: { requestVersion: 1 as const,
    publicationKind: "ordinary_fallback" as const,
    reason: "target_encryption_not_ready" as const, memoryId: MEMORY,
    operationId: "operation-1", expectedContentRevision: 2,
    nextContentRevision: 3, expectedCryptoAccessRevision: 1,
    requiredNamespaceIds: [NAMESPACE],
    signedOrdinaryFallbackRequestBytesBase64url:
      Buffer.from(signed.bytes).toString("base64url") } };
}

function projection() {
  return { memoryId: MEMORY, contentRevision: 3, cryptoAccessRevision: 1,
    importance: 0.5, tier: 1, createdAt: new Date(0), updatedAt: new Date(1),
    namespaceIds: [NAMESPACE], requiredNamespaceIds: [NAMESPACE],
    scopeOrigin: undefined } as const;
}

describe("Human Memory ordinary fallback publication", () => {
  test("denies create fallback before product lookup when policy did not authorize it", async () => {
    const value = fixture(); let lookups = 0;
    const product = { lookupOrdinaryFallback: async () => { lookups++;
      throw new Error("not reached"); } } as unknown as HumanMemoryProductCreatePort;
    const route = createHumanMemoryPreparedCreateRoutePort({ crypto: value.crypto,
      now: () => 2_000, resolveHumanId: async () => "human-1",
      resolveHistoricalDeviceAuthority: async () => null,
      resolveHistoricalOrdinaryDeviceAuthority: async () => null,
      resolveCurrentWriteAuthorization: async () => null,
      foregroundEmbeddingProcessor: { embed: async () => {
        throw new Error("not reached"); } }, product,
      createCryptoCompletion: () => ({ complete: async () => {
        throw new Error("not reached"); }, verify: async () => {
        throw new Error("not reached"); } }),
      resolveNamespaceAuthority: async () => null,
    });
    const result = await route.createPrepared({ authority: { ...authority,
      actorId: null, agentId: null, sourceRoomId: null, memoryMode: "namespace",
      scopeId: null, originWritableNamespaceId: null }, prepared: {
      ...value.submitted, expectedContentRevision: 0, nextContentRevision: 1,
      expectedCryptoAccessRevision: 0,
    } });
    expect(result).toEqual({ dtoVersion: 1, status: "unavailable",
      reason: "authorization_required" });
    expect(lookups).toBe(0);
  });

  test("rejects a borrowed Human before device resolution or embedding", async () => {
    const value = fixture();
    let resolved = 0; let embedded = 0;
    expect(publishHumanMemoryOrdinaryFallbackIntent({ ...value,
      now: () => 2_000, expectedHumanId: "human-2",
      expectedPurpose: "memory.ordinary_fallback.update", authority,
      product: { lookupOrdinaryFallback: async () => null,
        admitOrdinaryFallback: () => { throw new Error("not reached"); },
        publishOrdinaryFallbackIntent: () => { throw new Error("not reached"); } },
      resolveHistoricalDeviceAuthority: async () => { resolved++; return null; },
      foregroundEmbeddingProcessor: { embed: async () => { embedded++;
        throw new Error("not reached"); } },
    })).rejects.toThrow("subject disagrees");
    expect([resolved, embedded]).toEqual([0, 0]);
  });

  test("does not reinterpret a zero-revision update as a create", async () => {
    const value = fixture(); let admitted = 0; let embedded = 0;
    expect(publishHumanMemoryOrdinaryFallbackIntent({ ...value,
      now: () => 2_000, expectedHumanId: "human-1",
      expectedPurpose: "memory.ordinary_fallback.create", authority,
      product: { lookupOrdinaryFallback: async () => null,
        admitOrdinaryFallback: async () => { admitted++;
          throw new Error("not reached"); },
        publishOrdinaryFallbackIntent: () => { throw new Error("not reached"); } },
      resolveHistoricalDeviceAuthority: async () => ({
        committerSigningPublicKey: value.signer.publicKey }),
      foregroundEmbeddingProcessor: { embed: async () => { embedded++;
        throw new Error("not reached"); } },
    })).rejects.toThrow("request disagrees");
    expect([admitted, embedded]).toEqual([0, 0]);
  });

  test("rejects an unrecognized device before admission or embedding", async () => {
    const value = fixture(); let admitted = 0; let embedded = 0;
    expect(publishHumanMemoryOrdinaryFallbackIntent({ ...value,
      now: () => 2_000, expectedHumanId: "human-1",
      expectedPurpose: "memory.ordinary_fallback.update", authority,
      product: { lookupOrdinaryFallback: async () => null,
        admitOrdinaryFallback: async () => { admitted++; throw new Error("not reached"); },
        publishOrdinaryFallbackIntent: () => { throw new Error("not reached"); } },
      resolveHistoricalDeviceAuthority: async () => null,
      foregroundEmbeddingProcessor: { embed: async () => { embedded++;
        throw new Error("not reached"); } },
    })).rejects.toThrow("signer is unavailable");
    expect([admitted, embedded]).toEqual([0, 0]);
  });

  test("returns exact terminal replay without admission or provider work", async () => {
    const value = fixture(); let admitted = 0; let embedded = 0;
    const result = await publishHumanMemoryOrdinaryFallbackIntent({ ...value,
      now: () => 40_000, expectedHumanId: "human-1",
      expectedPurpose: "memory.ordinary_fallback.update", authority,
      product: { lookupOrdinaryFallback: async (input) => ({
        replayAdmission: createHumanMemoryOrdinaryFallbackReplayAdmissionV1(input),
        completed: { projection: projection(), reason: "target_encryption_not_ready" } }),
        admitOrdinaryFallback: async () => { admitted++; throw new Error("not reached"); },
        publishOrdinaryFallbackIntent: () => { throw new Error("not reached"); } },
      resolveHistoricalDeviceAuthority: async () => ({
        committerSigningPublicKey: value.signer.publicKey }),
      foregroundEmbeddingProcessor: { embed: async () => { embedded++;
        throw new Error("not reached"); } },
    });
    expect(result).toMatchObject({ status: "ordinary_fallback",
      contentRevision: 3, cryptoAccessRevision: 1 });
    expect([admitted, embedded]).toEqual([0, 0]);
  });

  test("admits before embedding and propagates an unknown provider error", async () => {
    const value = fixture(); const order: string[] = [];
    expect(publishHumanMemoryOrdinaryFallbackIntent({ ...value,
      now: () => 2_000, expectedHumanId: "human-1",
      expectedPurpose: "memory.ordinary_fallback.update", authority,
      product: { lookupOrdinaryFallback: async () => null,
        admitOrdinaryFallback: async ({ authenticated }) => { order.push("admit");
          return { authenticated, expectedAccessRevision: 1 }; },
        publishOrdinaryFallbackIntent: () => { throw new Error("not reached"); } },
      resolveHistoricalDeviceAuthority: async () => ({
        committerSigningPublicKey: value.signer.publicKey }),
      foregroundEmbeddingProcessor: { embed: async () => { order.push("embed");
        throw new Error("opaque storage cancellation"); } },
    })).rejects.toThrow("opaque storage cancellation");
    expect(order).toEqual(["admit", "embed"]);
  });
});
