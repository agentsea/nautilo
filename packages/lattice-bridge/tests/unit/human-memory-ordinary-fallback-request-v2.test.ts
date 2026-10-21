import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  createHumanMemoryOrdinaryFallbackReplayAdmissionV1,
  createHumanMemoryOrdinaryFallbackReplayAdmissionV2,
  decodeHumanMemoryOrdinaryFallbackRequestV1,
  decodeHumanMemoryOrdinaryFallbackRequestV2,
  encodeHumanMemoryOrdinaryFallbackRequestV2,
  digestHumanMemoryOrdinaryFallbackRequestV2,
  prepareHumanMemoryOrdinaryFallbackRequestV1,
  prepareHumanMemoryOrdinaryFallbackRequestV2,
  verifyHumanMemoryOrdinaryFallbackRequestV2,
  type HumanMemoryOrdinaryFallbackUnsignedRequestV2,
} from "../../src/memory/human-memory-ordinary-fallback-request.ts";

function fixture() {
  let value = 1;
  const crypto = new LatticeCrypto({ bytes: (length) => Uint8Array.from({ length }, () => value++ & 0xff) });
  const signer = crypto.generateSigningKeyPair();
  const unsigned: HumanMemoryOrdinaryFallbackUnsignedRequestV2 = {
    formatVersion: 2, purpose: "memory.ordinary_fallback.create", reason: "target_encryption_not_ready",
    operationId: "create:1", memoryId: "81000000-0000-4000-8000-000000000001",
    expectedContentRevision: 0, nextContentRevision: 1, expectedCryptoAccessRevision: 0,
    requiredNamespaceIds: ["81000000-0000-4000-8000-000000000010"],
    type: "fact", content: "Private memory content", importance: 0.5,
    requestedEmbedding: { contractVersion: 2,
      canonicalSpace: { provider: "venice", model: "text-embedding-3-large", dimensions: 1536 },
      processingRoute: { transport: "surplus_marketplace", marketplacePolicyVersion: "surplus-embedding-marketplace-v1",
        dataRecipientClasses: ["surplus", "marketplace_seller", "seller_upstream_processor"] } },
    processorContractVersion: 2, policyRevision: 7, subjectHumanId: "human:1", committerDeviceId: "device:1",
    committerDeviceSigningKeyGeneration: 2, hostAuthorizationRevision: 9,
    planIssuedAt: 1_000, planDeadlineAt: 31_000, issuedAt: 1_100, deadlineAt: 31_000,
  };
  return { crypto, signer, unsigned };
}
function mutateWire(bytes: Uint8Array, index: number, value: unknown) {
  const wire = JSON.parse(new TextDecoder().decode(bytes)) as unknown[];
  wire[index] = value;
  return new TextEncoder().encode(JSON.stringify(wire));
}

describe("Human Memory ordinary fallback V2", () => {
  test.each(["memory.ordinary_fallback.create", "memory.ordinary_fallback.update"] as const)("signs and canonically round-trips %s", (purpose) => {
    const { crypto, signer, unsigned } = fixture();
    const created = prepareHumanMemoryOrdinaryFallbackRequestV2(crypto, { ...unsigned, purpose,
      ...(purpose.endsWith("update") ? { planIssuedAt: null, planDeadlineAt: null } : {}), signingPrivateKey: signer.privateKey });
    expect(decodeHumanMemoryOrdinaryFallbackRequestV2(created.bytes)).toEqual(created.request);
    expect(encodeHumanMemoryOrdinaryFallbackRequestV2(created.request)).toEqual(created.bytes);
    const authenticated = verifyHumanMemoryOrdinaryFallbackRequestV2(crypto, {
      requestBytes: created.bytes, signingPublicKey: signer.publicKey, now: 2_000 });
    expect(authenticated.request).toEqual(created.request);
    expect(authenticated.requestDigest).toEqual(digestHumanMemoryOrdinaryFallbackRequestV2(created.bytes));
    expect(Object.isFrozen(created.request.requestedEmbedding.processingRoute)).toBeTrue();
  });

  test("signature commits to transport and every authority/content field", () => {
    const { crypto, signer, unsigned } = fixture();
    const created = prepareHumanMemoryOrdinaryFallbackRequestV2(crypto, { ...unsigned, signingPrivateKey: signer.privateKey });
    const changed = { ...unsigned.requestedEmbedding, processingRoute: { transport: "direct" } };
    const substitutions: readonly [number, unknown][] = [
      [4, "create:2"], [5, "81000000-0000-4000-8000-000000000002"],
      [9, ["81000000-0000-4000-8000-000000000011"]], [10, "preference"], [11, "changed"], [12, 0.9],
      [13, changed], [15, 8], [16, "human:2"], [17, "device:2"], [18, 3], [19, 10],
      [20, 999], [21, 30_999], [22, 1_101], [23, 30_999],
    ];
    for (const [index, value] of substitutions) expect(() => verifyHumanMemoryOrdinaryFallbackRequestV2(crypto, {
      requestBytes: mutateWire(created.bytes, index, value), signingPublicKey: signer.publicKey, now: 2_000,
    })).toThrow();
    for (const disclosure of [
      { ...unsigned.requestedEmbedding, canonicalSpace: { ...unsigned.requestedEmbedding.canonicalSpace, provider: "openai" } },
      { ...unsigned.requestedEmbedding, processingRoute: { ...unsigned.requestedEmbedding.processingRoute, marketplacePolicyVersion: "other" } },
      { ...unsigned.requestedEmbedding, processingRoute: { ...unsigned.requestedEmbedding.processingRoute, dataRecipientClasses: ["surplus"] } },
    ]) expect(() => verifyHumanMemoryOrdinaryFallbackRequestV2(crypto, {
      requestBytes: mutateWire(created.bytes, 13, disclosure), signingPublicKey: signer.publicKey, now: 2_000,
    })).toThrow();
  });

  test("rejects extra, missing, invalid, and noncanonical fields before signing", () => {
    const { crypto, signer, unsigned } = fixture();
    const sign = crypto.sign.bind(crypto);
    let signatures = 0;
    crypto.sign = (...args) => { signatures++; return sign(...args); };
    for (const patch of [{ formatVersion: 1 }, { processorContractVersion: 1 }, { requestedEmbedding: undefined },
      { requestedProvider: "venice" }, { extra: true }, { signature: new Uint8Array(64) }, { deadlineAt: 31_101 },
      { requestedEmbedding: { ...unsigned.requestedEmbedding, extra: true } }]) {
      expect(() => prepareHumanMemoryOrdinaryFallbackRequestV2(crypto, { ...unsigned, ...patch, signingPrivateKey: signer.privateKey } as never)).toThrow();
    }
    expect(signatures).toBe(0);
    const created = prepareHumanMemoryOrdinaryFallbackRequestV2(crypto, { ...unsigned, signingPrivateKey: signer.privateKey });
    const whitespace = Uint8Array.from([...created.bytes, 0x20]);
    expect(() => decodeHumanMemoryOrdinaryFallbackRequestV2(whitespace)).toThrow("noncanonical");
    const reversedFields = { processingRoute: unsigned.requestedEmbedding.processingRoute,
      canonicalSpace: unsigned.requestedEmbedding.canonicalSpace, contractVersion: 2 };
    expect(() => decodeHumanMemoryOrdinaryFallbackRequestV2(mutateWire(created.bytes, 13, reversedFields))).toThrow("noncanonical");
  });

  test("shares exact durable replay authority across versions without broadening its digest binding", () => {
    const { crypto, signer, unsigned } = fixture();
    const created = prepareHumanMemoryOrdinaryFallbackRequestV2(crypto, { ...unsigned, signingPrivateKey: signer.privateKey });
    const binding = { operationId: unsigned.operationId, memoryId: unsigned.memoryId,
      requestDigest: digestHumanMemoryOrdinaryFallbackRequestV2(created.bytes) };
    expect(() => verifyHumanMemoryOrdinaryFallbackRequestV2(crypto, { requestBytes: created.bytes,
      signingPublicKey: signer.publicKey, now: 31_000 })).toThrow("not currently valid");
    for (const replayAdmission of [createHumanMemoryOrdinaryFallbackReplayAdmissionV1(binding), createHumanMemoryOrdinaryFallbackReplayAdmissionV2(binding)]) {
      expect(verifyHumanMemoryOrdinaryFallbackRequestV2(crypto, { requestBytes: created.bytes,
        signingPublicKey: signer.publicKey, now: 31_000, replayAdmission }).request).toEqual(created.request);
      const changed = prepareHumanMemoryOrdinaryFallbackRequestV2(crypto, { ...unsigned, content: "different", signingPrivateKey: signer.privateKey });
      expect(() => verifyHumanMemoryOrdinaryFallbackRequestV2(crypto, { requestBytes: changed.bytes,
        signingPublicKey: signer.publicKey, now: 31_000, replayAdmission })).toThrow("replay admission disagrees");
    }
  });

  test("fences versions and preserves the legacy byte layout and signing domain", () => {
    const { crypto, signer, unsigned } = fixture();
    const created = prepareHumanMemoryOrdinaryFallbackRequestV2(crypto, { ...unsigned, signingPrivateKey: signer.privateKey });
    expect(() => decodeHumanMemoryOrdinaryFallbackRequestV1(created.bytes)).toThrow();
    const { requestedEmbedding: _, ...common } = unsigned;
    const legacy = prepareHumanMemoryOrdinaryFallbackRequestV1(crypto, { ...common, formatVersion: 1,
      requestedProvider: "venice", requestedModel: "text-embedding-3-large", dimensions: 1536,
      processorContractVersion: 1, signingPrivateKey: signer.privateKey });
    expect(() => decodeHumanMemoryOrdinaryFallbackRequestV2(legacy.bytes)).toThrow();
    const legacyFields = ["nautilo/memory/human-ordinary-fallback/v1", 1,
      "memory.ordinary_fallback.create", "target_encryption_not_ready", "create:1",
      "81000000-0000-4000-8000-000000000001", 0, 1, 0,
      ["81000000-0000-4000-8000-000000000010"], "fact", "Private memory content", 0.5,
      "venice", "text-embedding-3-large", 1536, 1, 7, "human:1", "device:1", 2, 9, 1_000, 31_000, 1_100, 31_000];
    const encoder = new TextEncoder();
    const signature = crypto.sign(signer.privateKey, encoder.encode(JSON.stringify(legacyFields)));
    expect(legacy.bytes).toEqual(encoder.encode(JSON.stringify([...legacyFields, Buffer.from(signature).toString("hex")])));
  });
});
