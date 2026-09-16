import { expect, test } from "bun:test";
import { LatticeCrypto, accessRevision, decryptObjectThroughNamespace, namespaceGeneration,
  namespaceId, objectId, wrapObjectDekForNamespace } from "@nautilo/lattice-crypto";
import { decodeEncryptedPayloadV2, decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5, encodeNamespaceObjectEnvelopeV2,
  objectAccessManifestSigningBytesV5 } from "@nautilo/lattice-crypto/wire";
import { prepareHumanMemoryCiphertext } from "../../src/client/memory/prepare-human-memory-ciphertext.ts";
import { decodeMemoryPayloadV1 } from "../../src/memory/memory-payload-v1.ts";

const MEMORY = "91000000-0000-4000-8000-000000000001";
const NS = "91000000-0000-4000-8000-000000000010";
const OTHER = "91000000-0000-4000-8000-000000000020";
function fixture() {
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const namespaceKey = new Uint8Array(32).fill(7);
  const input = { crypto, memoryId: MEMORY, contentRevision: 1, createdAt: 1,
    payload: { formatVersion: 1 as const, type: "an authored type", content: "Memory repair must preserve this exact fact." },
    namespaceIds: [NS], subjectHumanId: "91000000-0000-4000-8000-000000000030",
    deviceId: "device:human", hostAuthorizationRevision: 1,
    signingPublicKey: signing.publicKey, signingPrivateKey: signing.privateKey };
  const wrap = ({ cryptoObjectId, dek }: { cryptoObjectId: string; dek: Uint8Array }, id = NS) =>
    encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(crypto, namespaceKey, {
      objectId: objectId(cryptoObjectId), namespaceId: namespaceId(id), keyClass: "ai",
      keyGeneration: namespaceGeneration(0), bindingRevisionAtWrap: accessRevision(1),
    }, dek));
  return { crypto, signing, namespaceKey, input, wrap };
}

test("semantic writes and repair reuse exact Human ciphertext without embedding or allocation", async () => {
  const f = fixture();
  const observed: Uint8Array[] = [];
  try {
    const sealed = await prepareHumanMemoryCiphertext({ ...f.input, wrapNamespace: async (request) => {
      observed.push(request.dek); return f.wrap(request);
    } });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.every((byte) => byte === 0)).toBe(true);
    const bytes = decryptObjectThroughNamespace(f.crypto, f.namespaceKey,
      decodeNamespaceObjectEnvelopeV2(sealed.envelopeBytes[0]!), decodeEncryptedPayloadV2(sealed.payloadBytes));
    if (bytes === null) throw new Error("Expected authenticated repair ciphertext");
    try { expect(decodeMemoryPayloadV1(bytes)).toEqual(f.input.payload); }
    finally { bytes.fill(0); }
    const manifest = decodeObjectAccessManifestV5(sealed.manifestBytes);
    const { signature, formatVersion, ...unsigned } = manifest;
    expect(formatVersion).toBe(5);
    expect(f.crypto.verify(f.signing.publicKey, objectAccessManifestSigningBytesV5(unsigned), signature)).toBe(true);
    expect(Object.keys(sealed).sort()).toEqual(["cryptoObjectId", "envelopeBytes", "manifestBytes", "payloadBytes"]);
  } finally { f.signing.privateKey.fill(0); f.namespaceKey.fill(0); }
});

test("incomplete wrapping wipes the transient DEK and previously prepared envelope", async () => {
  const f = fixture();
  const observed: Uint8Array[] = [];
  const envelopes: Uint8Array[] = [];
  try {
    const failure = await prepareHumanMemoryCiphertext({ ...f.input, namespaceIds: [NS, OTHER],
      wrapNamespace: async (request) => {
        observed.push(request.dek);
        if (request.namespaceId === OTHER) throw new Error("Missing wrapping key");
        const bytes = f.wrap(request); envelopes.push(bytes); return bytes;
      } }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(observed).toHaveLength(2);
    expect(envelopes).toHaveLength(1);
    expect(observed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
    expect(envelopes.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  } finally { f.signing.privateKey.fill(0); f.namespaceKey.fill(0); }
});

test("a substituted Namespace envelope cannot form a signed publication", async () => {
  const f = fixture();
  try {
    expect(await prepareHumanMemoryCiphertext({ ...f.input,
      wrapNamespace: async (request) => f.wrap(request, OTHER) }).catch((error: unknown) => error))
      .toBeInstanceOf(TypeError);
  } finally { f.signing.privateKey.fill(0); f.namespaceKey.fill(0); }
});
