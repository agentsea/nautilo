import { describe, expect, test } from "bun:test";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import { decodeHumanMemoryContentEmbeddingRequestV2, prepareHumanMemoryContentEmbeddingRequestV2 } from "../../src/memory/content-embedding-request-v1.ts";
import {
  decodeHumanMemoryContentEmbeddingRequestV3,
  encodeHumanMemoryContentEmbeddingRequestV3,
  prepareHumanMemoryContentEmbeddingRequestV3,
  verifyHumanMemoryContentEmbeddingRequestV3,
  type HumanMemoryContentEmbeddingRequestV3,
  type PrepareHumanMemoryContentEmbeddingRequestInputV3,
} from "../../src/memory/content-embedding-request-v3.ts";
import { authorizationRevision, cryptoDeviceId, humanId, namespaceId, objectId, unixTimestamp } from "../../src/v2-types/ids.ts";

function fixture() {
  const crypto = new LatticeCrypto(seededRng(27_931));
  const signer = crypto.generateSigningKeyPair();
  const input: PrepareHumanMemoryContentEmbeddingRequestInputV3 = {
    subjectHumanId: humanId("human-alice"), requestId: "request-1",
    memoryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    expectedProductRevision: 0, nextProductRevision: 1,
    cryptoObjectId: objectId("memory:v1:object-1"),
    ciphertextPayloadHash: new Uint8Array(32).fill(1), genesisManifestHash: new Uint8Array(32).fill(2),
    namespaceEnvelopes: [{ namespaceId: namespaceId("namespace-1"), envelopeHash: new Uint8Array(32).fill(3) }],
    type: "fact", content: "Private authored content 🧠", importance: 0.5,
    requestedEmbedding: { contractVersion: 2,
      canonicalSpace: { provider: "venice", model: "text-embedding-3-large", dimensions: 1536 },
      processingRoute: { transport: "surplus_marketplace", marketplacePolicyVersion: "surplus-embedding-marketplace-v1",
        dataRecipientClasses: ["surplus", "marketplace_seller", "seller_upstream_processor"] } },
    processorContractVersion: 2, issuedAt: unixTimestamp(1_000), deadlineAt: unixTimestamp(11_000),
    committerDeviceId: cryptoDeviceId("device-1"), hostAuthorizationRevision: authorizationRevision(1),
    committerSigningPublicKey: signer.publicKey, committerSigningPrivateKey: signer.privateKey,
  };
  return { crypto, signer, input };
}

describe("Human Memory content embedding V3", () => {
  test("round-trips, signs all marketplace semantics, and retains exact authority/content", () => {
    const { crypto, signer, input } = fixture();
    const created = prepareHumanMemoryContentEmbeddingRequestV3(crypto, input);
    expect(decodeHumanMemoryContentEmbeddingRequestV3(created.bytes)).toEqual(created.request);
    expect(encodeHumanMemoryContentEmbeddingRequestV3(created.request)).toEqual(created.bytes);
    expect(verifyHumanMemoryContentEmbeddingRequestV3(crypto, { requestBytes: created.bytes,
      committerSigningPublicKey: signer.publicKey, now: unixTimestamp(2_000) })).toEqual(created.request);
    expect(created.request).toMatchObject({ formatVersion: 3, processorContractVersion: 2,
      content: input.content, requestedEmbedding: input.requestedEmbedding });
    const mutations: Partial<HumanMemoryContentEmbeddingRequestV3>[] = [
      { requestedEmbedding: { ...input.requestedEmbedding, processingRoute: { transport: "direct" } } },
      { content: "changed" }, { type: "preference" }, { importance: 0.9 }, { requestId: "request-2" },
      { subjectHumanId: humanId("human-other") }, { committerDeviceId: cryptoDeviceId("device-other") },
      { hostAuthorizationRevision: authorizationRevision(2) },
      { memoryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { expectedProductRevision: 1, nextProductRevision: 2 }, { cryptoObjectId: objectId("other") },
      { ciphertextPayloadHash: new Uint8Array(32).fill(9) }, { genesisManifestHash: new Uint8Array(32).fill(9) },
      { namespaceEnvelopes: [{ namespaceId: namespaceId("namespace-other"), envelopeHash: new Uint8Array(32).fill(3) }] },
      { namespaceEnvelopes: [{ namespaceId: namespaceId("namespace-1"), envelopeHash: new Uint8Array(32).fill(9) }] },
      { issuedAt: unixTimestamp(1_001) }, { deadlineAt: unixTimestamp(11_001) },
    ];
    for (const patch of mutations) {
      expect(() => verifyHumanMemoryContentEmbeddingRequestV3(crypto, {
        requestBytes: encodeHumanMemoryContentEmbeddingRequestV3({ ...created.request, ...patch }),
        committerSigningPublicKey: signer.publicKey, now: unixTimestamp(2_000),
      })).toThrow("signature");
    }
    for (const requestedEmbedding of [
      { ...input.requestedEmbedding, contractVersion: 1 },
      { ...input.requestedEmbedding, processingRoute: { ...input.requestedEmbedding.processingRoute, marketplacePolicyVersion: "other" } },
      { ...input.requestedEmbedding, processingRoute: { ...input.requestedEmbedding.processingRoute, dataRecipientClasses: ["surplus"] } },
      { ...input.requestedEmbedding, canonicalSpace: { ...input.requestedEmbedding.canonicalSpace, model: "other" } },
    ]) expect(() => encodeHumanMemoryContentEmbeddingRequestV3({ ...created.request, requestedEmbedding } as never)).toThrow();
  });

  test("binds direct canonical provider/model and rejects unknown versions and extra fields", () => {
    const { crypto, signer, input } = fixture();
    const direct = { ...input.requestedEmbedding, processingRoute: { transport: "direct" as const } };
    const created = prepareHumanMemoryContentEmbeddingRequestV3(crypto, { ...input, requestedEmbedding: direct });
    for (const canonicalSpace of [
      { ...direct.canonicalSpace, provider: "openai" as const },
      { ...direct.canonicalSpace, model: "other/model" },
    ]) expect(() => verifyHumanMemoryContentEmbeddingRequestV3(crypto, {
      requestBytes: encodeHumanMemoryContentEmbeddingRequestV3({ ...created.request, requestedEmbedding: { ...direct, canonicalSpace } }),
      committerSigningPublicKey: signer.publicKey, now: unixTimestamp(2_000),
    })).toThrow("signature");
    for (const patch of [{ formatVersion: 2 }, { processorContractVersion: 1 }, { extra: true }, { requestedProvider: "venice" },
      { requestedEmbedding: { ...direct, extra: true } }, { requestedEmbedding: undefined }]) {
      expect(() => encodeHumanMemoryContentEmbeddingRequestV3({ ...created.request, ...patch } as never)).toThrow();
    }
    for (const patch of [{ formatVersion: 2 }, { purpose: "memory.content_embedding" }]) {
      expect(() => prepareHumanMemoryContentEmbeddingRequestV3(crypto, { ...input, ...patch } as never)).toThrow("invalid field set");
    }
    for (const now of [999, 11_000]) expect(() => verifyHumanMemoryContentEmbeddingRequestV3(crypto, {
      requestBytes: created.bytes, committerSigningPublicKey: signer.publicKey, now: unixTimestamp(now),
    })).toThrow("not currently valid");
  });

  test("fences legacy and new version decoders, and owns nested disclosure snapshots", () => {
    const { crypto, input } = fixture();
    const created = prepareHumanMemoryContentEmbeddingRequestV3(crypto, input);
    expect(() => decodeHumanMemoryContentEmbeddingRequestV2(created.bytes)).toThrow();
    const { requestedEmbedding: _, processorContractVersion: _version, ...common } = input;
    const legacy = prepareHumanMemoryContentEmbeddingRequestV2(crypto, { ...common,
      requestedProvider: "venice", requestedModel: "text-embedding-3-large", dimensions: 1536, processorContractVersion: 1 });
    expect(() => decodeHumanMemoryContentEmbeddingRequestV3(legacy.bytes)).toThrow();
    expect(created.request.requestedEmbedding).not.toBe(input.requestedEmbedding);
    expect(created.request.requestedEmbedding.canonicalSpace).not.toBe(input.requestedEmbedding.canonicalSpace);
    for (const bytes of [created.bytes.slice(0, -1), Uint8Array.from([...created.bytes, 0])]) {
      expect(() => decodeHumanMemoryContentEmbeddingRequestV3(bytes)).toThrow();
    }
  });
});
