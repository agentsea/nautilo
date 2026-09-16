import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  decodeNamespaceGenerationAcknowledgementV1,
  decodeNamespaceGenerationFetchProofV1,
  encodeNamespaceGenerationAcknowledgementV1,
  encodeNamespaceGenerationFetchProofV1,
  namespaceGenerationAcknowledgementSigningBytesV1,
  namespaceGenerationFetchProofSigningBytesV1,
  prepareNamespaceGenerationAcknowledgementV1,
  prepareNamespaceGenerationFetchProofV1,
  verifyNamespaceGenerationAcknowledgementV1,
  verifyNamespaceGenerationFetchProofV1,
  type NamespaceGenerationAcknowledgementUnsignedV1,
  type NamespaceGenerationFetchProofUnsignedV1,
} from "../../src/format/namespace-delivery-v1.ts";
import {
  accessRevision,
  cryptoDeviceId,
  humanId,
  namespaceGeneration,
  namespaceId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const NOW = 1_800_000_000_000;

function fetchUnsigned(): NamespaceGenerationFetchProofUnsignedV1 {
  return {
    formatVersion: 1,
    requestId: "namespace-fetch:alpha",
    humanId: humanId("human:alpha"),
    deviceId: cryptoDeviceId("device:alpha"),
    deviceSigningKeyGeneration: 1,
    namespaceId: namespaceId("namespace:alpha"),
    keyClass: "ai",
    accessRevision: accessRevision(3),
    generation: namespaceGeneration(4),
    headDigest: new Uint8Array(32).fill(0x11),
    publicationDigest: new Uint8Array(32).fill(0x22),
    recipientKeyId: "device-key:alpha:1",
    recipientKeyGeneration: 1,
    issuedAt: unixTimestamp(NOW),
    expiresAt: unixTimestamp(NOW + 30_000),
  };
}

function acknowledgementUnsigned(): NamespaceGenerationAcknowledgementUnsignedV1 {
  return {
    formatVersion: 1,
    acknowledgementId: "namespace-ack:alpha",
    humanId: humanId("human:alpha"),
    deviceId: cryptoDeviceId("device:alpha"),
    deviceSigningKeyGeneration: 1,
    namespaceId: namespaceId("namespace:alpha"),
    keyClass: "ai",
    accessRevision: accessRevision(3),
    generation: namespaceGeneration(4),
    headDigest: new Uint8Array(32).fill(0x11),
    publicationDigest: new Uint8Array(32).fill(0x22),
    envelopeDigest: new Uint8Array(32).fill(0x33),
    recipientKeyId: "device-key:alpha:1",
    recipientKeyGeneration: 1,
    processedRevision: 9,
    issuedAt: unixTimestamp(NOW),
    expiresAt: unixTimestamp(NOW + 30_000),
  };
}

describe("M290 Namespace delivery V1 canonical bytes", () => {
  test("pins exact fetch and acknowledgement signing vectors", () => {
    const crypto = new LatticeCrypto(seededRng(290_101));
    expect(Buffer.from(crypto.hash(
      namespaceGenerationFetchProofSigningBytesV1(fetchUnsigned()),
    )).toString("hex")).toBe(
      "c433942e5da3a1b03f292e04a1ab84bec0c68f0eff7e9172538012afd3316882",
    );
    expect(Buffer.from(crypto.hash(
      namespaceGenerationAcknowledgementSigningBytesV1(
        acknowledgementUnsigned(),
      ),
    )).toString("hex")).toBe(
      "1a41831c3e33b403d9bae9528b349aff1859a511c065543b1c44e017d475c8c3",
    );
  });

  test("signs, strictly round-trips, verifies, and expires an exact fetch proof", () => {
    const crypto = new LatticeCrypto(seededRng(290_102));
    const signing = crypto.generateSigningKeyPair();
    const { formatVersion: _formatVersion, ...input } = fetchUnsigned();
    const prepared = prepareNamespaceGenerationFetchProofV1(crypto, {
      ...input,
      signingPublicKey: signing.publicKey,
      signingPrivateKey: signing.privateKey,
    });
    expect(encodeNamespaceGenerationFetchProofV1(
      decodeNamespaceGenerationFetchProofV1(prepared.bytes),
    )).toEqual(prepared.bytes);
    expect(verifyNamespaceGenerationFetchProofV1(crypto, {
      bytes: prepared.bytes,
      now: unixTimestamp(NOW + 1),
      signingPublicKey: signing.publicKey,
    })?.requestId).toBe("namespace-fetch:alpha");
    expect(verifyNamespaceGenerationFetchProofV1(crypto, {
      bytes: prepared.bytes,
      now: unixTimestamp(NOW + 30_000),
      signingPublicKey: signing.publicKey,
    })).toBeNull();

    const changed = prepared.bytes.slice();
    changed[80] = changed[80]! ^ 1;
    expect(verifyNamespaceGenerationFetchProofV1(crypto, {
      bytes: changed,
      now: unixTimestamp(NOW + 1),
      signingPublicKey: signing.publicKey,
    })).toBeNull();
    expect(() => decodeNamespaceGenerationFetchProofV1(
      new Uint8Array([...prepared.bytes, 0]),
    )).toThrow("trailing bytes");
  });

  test("signs, strictly round-trips, verifies, and binds acknowledgement closure", () => {
    const crypto = new LatticeCrypto(seededRng(290_103));
    const signing = crypto.generateSigningKeyPair();
    const { formatVersion: _formatVersion, ...input } = acknowledgementUnsigned();
    const prepared = prepareNamespaceGenerationAcknowledgementV1(
      crypto,
      {
        ...input,
        signingPublicKey: signing.publicKey,
        signingPrivateKey: signing.privateKey,
      },
    );
    expect(encodeNamespaceGenerationAcknowledgementV1(
      decodeNamespaceGenerationAcknowledgementV1(prepared.bytes),
    )).toEqual(prepared.bytes);
    expect(verifyNamespaceGenerationAcknowledgementV1(crypto, {
      bytes: prepared.bytes,
      now: unixTimestamp(NOW + 1),
      signingPublicKey: signing.publicKey,
    })?.processedRevision).toBe(9);

    const changed = decodeNamespaceGenerationAcknowledgementV1(prepared.bytes);
    const substituted = encodeNamespaceGenerationAcknowledgementV1({
      ...changed,
      envelopeDigest: new Uint8Array(32).fill(0xff),
    });
    expect(verifyNamespaceGenerationAcknowledgementV1(crypto, {
      bytes: substituted,
      now: unixTimestamp(NOW + 1),
      signingPublicKey: signing.publicKey,
    })).toBeNull();
  });

  test("rejects unknown fields, invalid windows, and malformed digest widths", () => {
    expect(() => namespaceGenerationFetchProofSigningBytesV1({
      ...fetchUnsigned(),
      unexpected: true,
    } as NamespaceGenerationFetchProofUnsignedV1)).toThrow(
      "invalid field set",
    );
    expect(() => namespaceGenerationFetchProofSigningBytesV1({
      ...fetchUnsigned(),
      expiresAt: unixTimestamp(NOW + 30_001),
    })).toThrow("validity window");
    expect(() => namespaceGenerationAcknowledgementSigningBytesV1({
      ...acknowledgementUnsigned(),
      envelopeDigest: new Uint8Array(31),
    })).toThrow("32 bytes");
  });
});
