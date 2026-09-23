import { describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  decodeHumanTaskPublicationRequestV1,
  encodeHumanTaskPublicationRequestV1,
  prepareHumanTaskPublicationRequestV1,
  verifyHumanTaskPublicationRequestV1,
  verifyHumanTaskPublicationRequestExactReplayV1,
  type PrepareHumanTaskPublicationRequestInputV1,
} from "../../src/task/publication-request-v1.ts";

function fixture() {
  const crypto = new LatticeCrypto(seededRng(601));
  const signer = crypto.generateSigningKeyPair();
  const hash = (n: number) => new Uint8Array(32).fill(n);
  const input: PrepareHumanTaskPublicationRequestInputV1 = {
    operation: "create", operationId: "task-publication-1",
    taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    cryptoObjectId: "task:v1:object",
    expectedContentRevision: 0, nextContentRevision: 1,
    expectedCryptoAccessRevision: 0, resultCryptoAccessRevision: 0,
    planDigest: hash(1), operationalFieldsDigest: hash(2),
    subjectHumanId: "human-1", committerDeviceId: "device-1",
    hostAuthorizationRevision: 1, namespaceId: "namespace-1", domainId: "domain-1",
    expectedNamespaceAccessRevision: 0, expectedPolicyRevision: 1,
    bindingHash: hash(3), keyGeneration: 1,
    payloadHash: hash(4), manifestHash: hash(5), envelopeHash: hash(6),
    issuedAt: 1000, deadlineAt: 2000,
    committerSigningPublicKey: signer.publicKey,
    committerSigningPrivateKey: signer.privateKey,
  };
  return { crypto, signer, input };
}

describe("Human Task publication request", () => {
  test("exact durable replay authenticates expired bytes while fresh admission stays closed", async () => {
    const { crypto, signer, input } = fixture();
    const { bytes } = prepareHumanTaskPublicationRequestV1(crypto, input);
    const expectedRequestDigest = crypto.hash(bytes);
    await rejects(verifyHumanTaskPublicationRequestV1(crypto, {
      requestBytes: bytes, now: input.deadlineAt + 1,
      resolveCurrentAuthority: async () => signer.publicKey,
    }), /currently valid/u);
    const replayed = await verifyHumanTaskPublicationRequestExactReplayV1(crypto, {
      requestBytes: bytes, expectedRequestDigest,
      resolveCurrentAuthority: async () => signer.publicKey,
    });
    expect(encodeHumanTaskPublicationRequestV1(replayed)).toEqual(bytes);
    expect(replayed.operationId).toBe(input.operationId);
  });

  test("replay rejects a different operation, content, or freshly re-signed deadline", async () => {
    const { crypto, signer, input } = fixture();
    const { bytes } = prepareHumanTaskPublicationRequestV1(crypto, input);
    const expectedRequestDigest = crypto.hash(bytes);
    for (const patch of [
      { operationId: "another-operation" },
      { taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { operationalFieldsDigest: new Uint8Array(32).fill(91) },
      { payloadHash: new Uint8Array(32).fill(92) },
      { issuedAt: 2000, deadlineAt: 3000 },
    ]) {
      const changed = prepareHumanTaskPublicationRequestV1(crypto, { ...input, ...patch });
      let authorityCalled = false;
      await rejects(verifyHumanTaskPublicationRequestExactReplayV1(crypto, {
        requestBytes: changed.bytes, expectedRequestDigest,
        resolveCurrentAuthority: async () => { authorityCalled = true; return signer.publicKey; },
      }), /durable request digest/u);
      expect(authorityCalled).toBe(false);
    }
  });

  test("exact replay still requires current authority and a valid signature", async () => {
    const { crypto, signer, input } = fixture();
    const { bytes } = prepareHumanTaskPublicationRequestV1(crypto, input);
    await rejects(verifyHumanTaskPublicationRequestExactReplayV1(crypto, {
      requestBytes: bytes, expectedRequestDigest: crypto.hash(bytes),
      resolveCurrentAuthority: async () => null,
    }), /authority/u);
    const corrupt = bytes.slice();
    corrupt[corrupt.length - 1]! ^= 1;
    await rejects(verifyHumanTaskPublicationRequestExactReplayV1(crypto, {
      requestBytes: corrupt, expectedRequestDigest: crypto.hash(corrupt),
      resolveCurrentAuthority: async () => signer.publicKey,
    }), /signature/u);
    await rejects(verifyHumanTaskPublicationRequestExactReplayV1(crypto, {
      requestBytes: bytes, expectedRequestDigest: new Uint8Array(31),
      resolveCurrentAuthority: async () => signer.publicKey,
    }), /byte length/u);
  });

  test("replay owns the accepted request across its authority await", async () => {
    const { crypto, signer, input } = fixture();
    const { bytes } = prepareHumanTaskPublicationRequestV1(crypto, input);
    const expectedRequestDigest = crypto.hash(bytes);
    const original = bytes.slice();
    const replayed = await verifyHumanTaskPublicationRequestExactReplayV1(crypto, {
      requestBytes: bytes, expectedRequestDigest,
      resolveCurrentAuthority: async (request) => {
        request.payloadHash.fill(0);
        bytes.fill(0);
        expectedRequestDigest.fill(0);
        return signer.publicKey;
      },
    });
    expect(encodeHumanTaskPublicationRequestV1(replayed)).toEqual(original);
  });

  test("supports an exact update predecessor and zero-based crypto authority counters", async () => {
    const { crypto, signer, input } = fixture();
    const created = prepareHumanTaskPublicationRequestV1(crypto, {
      ...input, operation: "update", expectedContentRevision: 3,
      nextContentRevision: 4, expectedCryptoAccessRevision: 2,
      keyGeneration: 0, hostAuthorizationRevision: 0,
    });
    const verified = await verifyHumanTaskPublicationRequestV1(crypto, {
      requestBytes: created.bytes, now: 1500, resolveCurrentAuthority: async () => signer.publicKey,
    });
    expect(verified.expectedContentRevision).toBe(3);
    expect(verified.nextContentRevision).toBe(4);
    expect(verified.expectedCryptoAccessRevision).toBe(2);
  });

  test("canonical roundtrip authenticates a currently authorized Human", async () => {
    const { crypto, signer, input } = fixture();
    const created = prepareHumanTaskPublicationRequestV1(crypto, input);
    expect(encodeHumanTaskPublicationRequestV1(decodeHumanTaskPublicationRequestV1(created.bytes)))
      .toEqual(created.bytes);
    expect(await verifyHumanTaskPublicationRequestV1(crypto, {
      requestBytes: created.bytes, now: 1500,
      resolveCurrentAuthority: async (request) => request.subjectHumanId === "human-1"
        && request.namespaceId === "namespace-1" ? signer.publicKey : null,
    })).toEqual(created.request);
  });

  test("signed operational, authority and encrypted-content fields cannot be substituted", async () => {
    const { crypto, signer, input } = fixture();
    const created = prepareHumanTaskPublicationRequestV1(crypto, input);
    const patches = [
      { operationalFieldsDigest: new Uint8Array(32).fill(90) },
      { planDigest: new Uint8Array(32).fill(90) },
      { bindingHash: new Uint8Array(32).fill(90) },
      { payloadHash: new Uint8Array(32).fill(90) },
      { manifestHash: new Uint8Array(32).fill(90) },
      { envelopeHash: new Uint8Array(32).fill(90) },
      { operationId: "another-operation" }, { domainId: "another-domain" },
      { namespaceId: "another-namespace" }, { committerDeviceId: "another-device" },
      { subjectHumanId: "another-human" }, { hostAuthorizationRevision: 2 },
      { expectedNamespaceAccessRevision: 1 }, { expectedPolicyRevision: 2 },
      { keyGeneration: 2 }, { cryptoObjectId: "another-object" },
      { taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    ];
    for (const patch of patches) {
      const bytes = encodeHumanTaskPublicationRequestV1({ ...created.request, ...patch });
      await rejects(verifyHumanTaskPublicationRequestV1(crypto, {
        requestBytes: bytes, now: 1500, resolveCurrentAuthority: async () => signer.publicKey,
      }), /signature/u);
    }
  });

  test("revocation, future requests and expiration fail closed", async () => {
    const { crypto, signer, input } = fixture();
    const { bytes } = prepareHumanTaskPublicationRequestV1(crypto, input);
    await rejects(verifyHumanTaskPublicationRequestV1(crypto, {
      requestBytes: bytes, now: 1500, resolveCurrentAuthority: async () => null,
    }), /authority/u);
    for (const now of [999, 2000]) {
      await rejects(verifyHumanTaskPublicationRequestV1(crypto, {
        requestBytes: bytes, now, resolveCurrentAuthority: async () => signer.publicKey,
      }), /currently valid/u);
    }
  });

  test("resolver mutation cannot rewrite the verified request", async () => {
    const { crypto, signer, input } = fixture();
    const { bytes } = prepareHumanTaskPublicationRequestV1(crypto, input);
    const result = await verifyHumanTaskPublicationRequestV1(crypto, {
      requestBytes: bytes, now: 1500,
      resolveCurrentAuthority: async (request) => {
        request.operationalFieldsDigest.fill(0);
        return signer.publicKey;
      },
    });
    expect(result.operationalFieldsDigest).toEqual(input.operationalFieldsDigest);
  });

  test("rejects mismatched signing keys, noncanonical frames and invalid revision transitions", () => {
    const { crypto, input } = fixture();
    expect(() => prepareHumanTaskPublicationRequestV1(crypto, {
      ...input, committerSigningPublicKey: crypto.generateSigningKeyPair().publicKey,
    })).toThrow("signing keys");
    for (const patch of [
      { nextContentRevision: 2 }, { expectedCryptoAccessRevision: 1 },
      { deadlineAt: 31_001 }, { expectedPolicyRevision: 0 },
    ]) expect(() => prepareHumanTaskPublicationRequestV1(crypto, { ...input, ...patch })).toThrow();
    const { bytes } = prepareHumanTaskPublicationRequestV1(crypto, input);
    expect(() => decodeHumanTaskPublicationRequestV1(new Uint8Array([...bytes, 0]))).toThrow();
    expect(() => decodeHumanTaskPublicationRequestV1(bytes.subarray(0, bytes.length - 1))).toThrow();
  });
});
