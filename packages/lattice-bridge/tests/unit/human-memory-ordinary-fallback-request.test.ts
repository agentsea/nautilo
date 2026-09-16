import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { protectedMemoryOrdinaryFallbackUpdateRequestV1Schema } from
  "@nautilo/api-client";
import { createHumanMemoryOrdinaryFallbackReplayAdmissionV1, decodeHumanMemoryOrdinaryFallbackRequestV1, prepareHumanMemoryOrdinaryFallbackRequestV1, verifyHumanMemoryOrdinaryFallbackRequestV1, type HumanMemoryOrdinaryFallbackUnsignedRequestV1 } from "../../src/memory/human-memory-ordinary-fallback-request.ts";

const MEMORY = "81000000-0000-4000-8000-000000000001";
const NAMESPACE = "81000000-0000-4000-8000-000000000010";
const NAMESPACE_2 = "81000000-0000-4000-8000-000000000011";

function crypto(): LatticeCrypto {
  let value = 1;
  return new LatticeCrypto({ bytes: (length) => Uint8Array.from({ length }, () => value++ & 0xff) });
}

function unsigned(overrides: Partial<HumanMemoryOrdinaryFallbackUnsignedRequestV1> = {}): HumanMemoryOrdinaryFallbackUnsignedRequestV1 {
  return { formatVersion: 1, purpose: "memory.ordinary_fallback.create", reason: "target_encryption_not_ready",
    operationId: "human-memory-create:1", memoryId: MEMORY, expectedContentRevision: 0,
    nextContentRevision: 1, expectedCryptoAccessRevision: 0, requiredNamespaceIds: [NAMESPACE],
    type: "preference", content: "Exact authored content", importance: 0.8,
    requestedProvider: "openai", requestedModel: "text-embedding-3-small", dimensions: 1536,
    processorContractVersion: 1, policyRevision: 7, subjectHumanId: "human:1",
    committerDeviceId: "device:1", committerDeviceSigningKeyGeneration: 2,
    hostAuthorizationRevision: 9, planIssuedAt: 1_000, planDeadlineAt: 31_000,
    issuedAt: 1_100, deadlineAt: 31_000, ...overrides };
}

function tamper(bytes: Uint8Array, index: number, value: unknown): Uint8Array {
  const wire = JSON.parse(new TextDecoder().decode(bytes)) as unknown[];
  wire[index] = value;
  return new TextEncoder().encode(JSON.stringify(wire));
}

describe("Human Memory ordinary fallback request", () => {
  test.each(["openai", "openrouter", "venice"] as const)("authenticates exact %s create and update intent", (requestedProvider) => {
    const lattice = crypto();
    const signer = lattice.generateSigningKeyPair();
    const create = prepareHumanMemoryOrdinaryFallbackRequestV1(lattice, { ...unsigned({ requestedProvider }), signingPrivateKey: signer.privateKey });
    expect(decodeHumanMemoryOrdinaryFallbackRequestV1(create.bytes).requestedProvider).toBe(requestedProvider);
    expect(decodeHumanMemoryOrdinaryFallbackRequestV1(create.bytes)).toMatchObject({ purpose: "memory.ordinary_fallback.create", content: "Exact authored content", policyRevision: 7, expectedCryptoAccessRevision: 0 });
    const update = prepareHumanMemoryOrdinaryFallbackRequestV1(lattice, {
      ...unsigned({ requestedProvider, purpose: "memory.ordinary_fallback.update",
        expectedContentRevision: 0, nextContentRevision: 1,
        expectedCryptoAccessRevision: 0, planIssuedAt: null,
        planDeadlineAt: null }), signingPrivateKey: signer.privateKey });
    expect(verifyHumanMemoryOrdinaryFallbackRequestV1(lattice, {
      requestBytes: update.bytes, signingPublicKey: signer.publicKey,
      now: 1_500 }).request).toMatchObject({
      purpose: "memory.ordinary_fallback.update", expectedContentRevision: 0,
      nextContentRevision: 1, expectedCryptoAccessRevision: 0 });
    expect(protectedMemoryOrdinaryFallbackUpdateRequestV1Schema.parse({
      requestVersion: 1, publicationKind: "ordinary_fallback",
      reason: "target_encryption_not_ready", memoryId: MEMORY,
      operationId: update.request.operationId, expectedContentRevision: 0,
      nextContentRevision: 1, expectedCryptoAccessRevision: 0,
      requiredNamespaceIds: [NAMESPACE],
      signedOrdinaryFallbackRequestBytesBase64url:
        Buffer.from(update.bytes).toString("base64url"),
    }).nextContentRevision).toBe(1);
  });

  test("rejects every substitution covered by the signature", () => {
    const lattice = crypto();
    const signer = lattice.generateSigningKeyPair();
    const created = prepareHumanMemoryOrdinaryFallbackRequestV1(lattice, { ...unsigned(), signingPrivateKey: signer.privateKey });
    const substitutions: readonly [number, unknown][] = [[2, "memory.ordinary_fallback.update"], [4, "human-memory-create:2"], [8, 1], [9, [NAMESPACE, NAMESPACE_2]], [10, "profile"], [11, "Changed content"], [17, 8], [18, "human:2"], [19, "device:2"]];
    for (const [index, value] of substitutions) expect(() => verifyHumanMemoryOrdinaryFallbackRequestV1(lattice, { requestBytes: tamper(created.bytes, index, value), signingPublicKey: signer.publicKey, now: 1_500 })).toThrow();
  });

  test("rejects malformed, noncanonical, overlong, and invalid revision requests", () => {
    const lattice = crypto();
    const signer = lattice.generateSigningKeyPair();
    const created = prepareHumanMemoryOrdinaryFallbackRequestV1(lattice, { ...unsigned(), signingPrivateKey: signer.privateKey });
    const noncanonical = new Uint8Array(created.bytes.length + 1);
    noncanonical.set(created.bytes); noncanonical[created.bytes.length] = 0x20;
    expect(() => decodeHumanMemoryOrdinaryFallbackRequestV1(noncanonical)).toThrow("noncanonical");
    for (const overrides of [{ nextContentRevision: Number.MAX_SAFE_INTEGER + 1 },
      { expectedCryptoAccessRevision: 1 }, { content: "" }, { type: "" },
      { deadlineAt: 31_101 }, { operationId: undefined as unknown as string }]) {
      expect(() => prepareHumanMemoryOrdinaryFallbackRequestV1(lattice, { ...unsigned(overrides), signingPrivateKey: signer.privateKey })).toThrow();
    }
  });

  test("permits expiry only with the exact durable replay admission", () => {
    const lattice = crypto();
    const signer = lattice.generateSigningKeyPair();
    const created = prepareHumanMemoryOrdinaryFallbackRequestV1(lattice, { ...unsigned(), signingPrivateKey: signer.privateKey });
    const fresh = verifyHumanMemoryOrdinaryFallbackRequestV1(lattice, { requestBytes: created.bytes, signingPublicKey: signer.publicKey, now: 1_500 });
    expect(() => verifyHumanMemoryOrdinaryFallbackRequestV1(lattice, { requestBytes: created.bytes, signingPublicKey: signer.publicKey, now: 31_100 })).toThrow("not currently valid");
    const replayAdmission = createHumanMemoryOrdinaryFallbackReplayAdmissionV1({ operationId: created.request.operationId, memoryId: created.request.memoryId, requestDigest: fresh.requestDigest });
    expect(verifyHumanMemoryOrdinaryFallbackRequestV1(lattice, { requestBytes: created.bytes, signingPublicKey: signer.publicKey, now: 31_100, replayAdmission }).request.content).toBe("Exact authored content");
    const other = prepareHumanMemoryOrdinaryFallbackRequestV1(lattice, { ...unsigned({ content: "Different" }), signingPrivateKey: signer.privateKey });
    expect(() => verifyHumanMemoryOrdinaryFallbackRequestV1(lattice, { requestBytes: other.bytes, signingPublicKey: signer.publicKey, now: 31_100, replayAdmission })).toThrow("replay admission disagrees");
  });
});
