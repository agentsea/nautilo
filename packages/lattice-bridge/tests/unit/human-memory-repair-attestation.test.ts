import { describe, expect, test } from "bun:test";
import { LatticeCrypto, namespaceId } from "@nautilo/lattice-crypto";
import { HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V2 } from
  "@nautilo/lattice-crypto/wire";

import {
  MAX_HUMAN_MEMORY_REPAIR_ATTESTATION_WIRE_BYTES_V1,
  assertHumanMemoryRepairAttestationV1,
  decodeHumanMemoryRepairAttestationV1,
  encodeHumanMemoryRepairAttestationV1,
  humanMemoryRepairAttestationSigningDigestV1,
  humanMemoryRepairPayloadDigestV1,
  prepareHumanMemoryRepairAttestationV1,
} from "../../src/memory/human-memory-repair-attestation.ts";

const MEMORY_ID = "10000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000002";
const bytes = (fill: number) => new Uint8Array(32).fill(fill);

describe("Human Memory representation repair attestation", () => {
  test("admits the maximum canonical repair shape within its wire envelope", () => {
    const crypto = new LatticeCrypto({
      bytes: (length) => new Uint8Array(length).fill(11),
    });
    const signer = crypto.generateSigningKeyPair();
    const portable = (prefix: string) =>
      `${prefix}${"x".repeat(128 - prefix.length)}`;
    const namespaces = Array.from({ length: 256 }, (_, index) => {
      const namespace = `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      return Object.freeze({
        namespaceId: namespace,
        namespaceAccessRevision: Number.MAX_SAFE_INTEGER,
        namespaceKeyGeneration: Number.MAX_SAFE_INTEGER,
        headDigest: bytes(1), publicationDigest: bytes(2),
        publicationSetDigest: bytes(3), audienceFingerprint: bytes(4),
        envelopeHash: bytes(5),
      });
    });
    const attestation = prepareHumanMemoryRepairAttestationV1(crypto, {
      version: 1, purpose: "human_memory_representation_repair",
      direction: "protected_to_ordinary",
      operationId: portable("operation-"),
      policyRevision: Number.MAX_SAFE_INTEGER,
      subjectHumanId: portable("human-"),
      deviceId: portable("device-"),
      deviceSigningKeyGeneration: Number.MAX_SAFE_INTEGER,
      hostAuthorizationRevision: Number.MAX_SAFE_INTEGER,
      memoryId: MEMORY_ID,
      expectedContentRevision: Number.MAX_SAFE_INTEGER,
      targetContentRevision: Number.MAX_SAFE_INTEGER,
      expectedCryptoAccessRevision: Number.MAX_SAFE_INTEGER,
      cryptoObjectId: portable("object-"),
      requiredNamespaceFingerprint: bytes(6),
      currentAuthorityEntries: namespaces.map((entry) => Object.freeze({
        namespaceId: namespaceId(entry.namespaceId),
        namespaceAccessRevision: entry.namespaceAccessRevision,
        keyGeneration: entry.namespaceKeyGeneration,
        headDigest: entry.headDigest, publicationDigest: entry.publicationDigest,
        publicationSetDigest: entry.publicationSetDigest,
        audienceFingerprint: entry.audienceFingerprint,
      })),
      namespaces,
      payloadHash: bytes(7), accessManifestHash: bytes(8),
      authoredPayloadDigest: bytes(9),
      issuedAt: Number.MAX_SAFE_INTEGER - 30_000,
      deadlineAt: Number.MAX_SAFE_INTEGER,
      signingPrivateKey: signer.privateKey,
      signingPublicKey: signer.publicKey,
    });
    const encoded = encodeHumanMemoryRepairAttestationV1(attestation);
    expect(encoded).toHaveLength(193_982);
    expect(encoded.length)
      .toBeLessThan(MAX_HUMAN_MEMORY_REPAIR_ATTESTATION_WIRE_BYTES_V1);
    expect(decodeHumanMemoryRepairAttestationV1(encoded)).toEqual(attestation);
    for (const field of [
      "operationId", "subjectHumanId", "deviceId", "cryptoObjectId",
    ] as const) {
      expect(() => assertHumanMemoryRepairAttestationV1({
        ...attestation,
        [field]: `a${"x".repeat(128)}`,
      })).toThrow("invalid");
    }
    signer.privateKey.fill(0);
    encoded.fill(0);
  });

  test("signs the exact native authority, representation and authored payload", () => {
    const crypto = new LatticeCrypto({
      bytes: (length) => new Uint8Array(length).fill(7),
    });
    const signer = crypto.generateSigningKeyPair();
    const payload = { formatVersion: 1 as const, type: "preference", content: "tea" };
    const attestation = prepareHumanMemoryRepairAttestationV1(crypto, {
      version: 1,
      purpose: "human_memory_representation_repair",
      direction: "ordinary_to_protected",
      operationId: "repair-1",
      policyRevision: 4,
      subjectHumanId: "human-1",
      deviceId: "device-1",
      deviceSigningKeyGeneration: 2,
      hostAuthorizationRevision: 3,
      memoryId: MEMORY_ID,
      expectedContentRevision: 5,
      targetContentRevision: 6,
      expectedCryptoAccessRevision: 0,
      cryptoObjectId: "memory-content-v1:object",
      requiredNamespaceFingerprint: bytes(1),
      currentAuthorityEntries: [Object.freeze({
        namespaceId: namespaceId(NAMESPACE_ID),
        namespaceAccessRevision: 18,
        keyGeneration: 19,
        headDigest: bytes(12), publicationDigest: bytes(13),
        publicationSetDigest: bytes(14), audienceFingerprint: bytes(15),
      })],
      namespaces: [Object.freeze({
        namespaceId: NAMESPACE_ID,
        namespaceAccessRevision: 8,
        namespaceKeyGeneration: 9,
        headDigest: bytes(2),
        publicationDigest: bytes(3),
        publicationSetDigest: bytes(4),
        audienceFingerprint: bytes(5),
        envelopeHash: bytes(6),
      })],
      payloadHash: bytes(7),
      accessManifestHash: bytes(8),
      authoredPayloadDigest: humanMemoryRepairPayloadDigestV1(payload),
      issuedAt: 100,
      deadlineAt: 200,
      signingPrivateKey: signer.privateKey,
      signingPublicKey: signer.publicKey,
    });
    assertHumanMemoryRepairAttestationV1(attestation);
    const signingDigest = humanMemoryRepairAttestationSigningDigestV1(attestation);
    expect(crypto.verify(signer.publicKey, signingDigest, attestation.signature))
      .toBe(true);
    const encoded = encodeHumanMemoryRepairAttestationV1(attestation);
    const decoded = decodeHumanMemoryRepairAttestationV1(encoded);
    expect(decoded).toEqual(attestation);
    const noncanonical = new Uint8Array([...encoded, 0x20]);
    expect(() => decodeHumanMemoryRepairAttestationV1(noncanonical)).toThrow();
    encoded.fill(0);
    noncanonical.fill(0);
    const changed = humanMemoryRepairAttestationSigningDigestV1({
      ...attestation,
      direction: "protected_to_ordinary",
      targetContentRevision: attestation.expectedContentRevision,
    });
    expect(crypto.verify(signer.publicKey, changed, attestation.signature))
      .toBe(false);
    signingDigest.fill(0);
    changed.fill(0);
    signer.privateKey.fill(0);
  });

  test("rejects noncanonical Namespace inventories and partial digests", () => {
    const base = {
      version: 1 as const,
      purpose: "human_memory_representation_repair" as const,
      direction: "protected_to_ordinary" as const,
      operationId: "repair-2",
      policyRevision: 4,
      subjectHumanId: "human-1",
      deviceId: "device-1",
      deviceSigningKeyGeneration: 2,
      hostAuthorizationRevision: 3,
      memoryId: MEMORY_ID,
      expectedContentRevision: 5,
      targetContentRevision: 5,
      expectedCryptoAccessRevision: 1,
      cryptoObjectId: "memory-content-v1:object",
      requiredNamespaceFingerprint: bytes(1),
      currentAuthorityEntries: [Object.freeze({
        namespaceId: namespaceId(NAMESPACE_ID),
        namespaceAccessRevision: 18,
        keyGeneration: 19,
        headDigest: bytes(12), publicationDigest: bytes(13),
        publicationSetDigest: bytes(14), audienceFingerprint: bytes(15),
      })],
      namespaces: [Object.freeze({
        namespaceId: NAMESPACE_ID,
        namespaceAccessRevision: 8,
        namespaceKeyGeneration: 9,
        headDigest: bytes(2), publicationDigest: bytes(3),
        publicationSetDigest: bytes(4), audienceFingerprint: bytes(5),
        envelopeHash: bytes(6),
      })],
      payloadHash: bytes(7), accessManifestHash: bytes(8),
      authoredPayloadDigest: bytes(9), issuedAt: 100, deadlineAt: 200,
      signature: new Uint8Array(64),
    };
    expect(() => assertHumanMemoryRepairAttestationV1({
      ...base,
      namespaces: [...base.namespaces, base.namespaces[0]!],
    })).toThrow("invalid");
    expect(() => assertHumanMemoryRepairAttestationV1({
      ...base,
      payloadHash: new Uint8Array(31),
    })).toThrow("invalid");
    expect(() => assertHumanMemoryRepairAttestationV1({
      ...base,
      deadlineAt: base.issuedAt
        + HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V2 + 1,
    })).toThrow("invalid");
    expect(() => assertHumanMemoryRepairAttestationV1({
      ...base,
      direction: "ordinary_to_protected",
      expectedContentRevision: 0,
      targetContentRevision: 0,
    })).toThrow("invalid");
    expect(() => assertHumanMemoryRepairAttestationV1({
      ...base,
      targetContentRevision: base.expectedContentRevision + 1,
    })).toThrow("invalid");
    expect(() => assertHumanMemoryRepairAttestationV1({
      ...base,
      namespaces: Array.from({ length: 257 }, (_, index) => Object.freeze({
        ...base.namespaces[0]!,
        namespaceId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })),
    })).toThrow("invalid");
  });
});
