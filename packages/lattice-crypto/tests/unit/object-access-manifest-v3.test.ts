import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  deriveAgentRuntimeObjectSignerPublicV1,
} from "../../src/agent-runtime/object-signer-v1.ts";
import type {
  AgentRuntimeGenerationV2,
} from "../../src/agent-runtime/types.ts";
import {
  OBJECT_ACCESS_MANIFEST_DOMAIN_V2,
  OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V2,
  createObjectAccessManifestV2,
  objectAccessManifestSigningBytesV2,
} from "../../src/format/object-access-manifest-v2.ts";
import {
  decodeObjectAccessStorageManifest,
  decodeObjectAccessManifestV2OrV3,
} from "../../src/format/object-access-manifest.ts";
import {
  OBJECT_ACCESS_MANIFEST_DOMAIN_V3,
  OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V3,
  createAgentObjectAccessManifestV3,
  decodeObjectAccessManifestV3,
  encodeObjectAccessManifestV3,
  MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V3,
  objectAccessManifestSigningBytesV3,
  verifyAgentObjectAccessManifestV3,
} from "../../src/format/object-access-manifest-v3.ts";
import type {
  ObjectAccessManifestUnsignedV3,
} from "../../src/format/object-access-manifest-v3.ts";
import { frameText } from "../../src/format/v2-primitives.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  objectId,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

function runtime(
  id = "agent_alpha",
  generation = 7,
): AgentRuntimeGenerationV2 {
  return {
    agentId: agentId(id),
    keyClass: "runtime",
    generation: agentRuntimeGeneration(generation),
    key: new Uint8Array(32).fill(0x51),
  };
}

function hash(marker: number): Uint8Array {
  return new Uint8Array(32).fill(marker);
}

function hex(value: Uint8Array): string {
  return Array.from(
    value,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

const V3_SIGNING_HEX =
  "000000306e617574696c6f2f6c6174746963652d63727970746f2f6f626a6563742d6163636573732d6d616e69666573"
  + "742f7633000000030000000e6f626a6563745f6167656e745f3100000020111111111111111111111111111111111111"
  + "111111111111111111111111111100000000000000000000000000000002000000202222222222222222222222222222"
  + "222222222222222222222222222222222222000000202323232323232323232323232323232323232323232323232323"
  + "2323232323230000000d6167656e745f72756e74696d650000000b6167656e745f616c70686100000000000000070000"
  + "00556167656e745f72756e74696d655f7369676e65725f66393539373763636432366561383233326536616537646163"
  + "3165633332373564363632356136616139346238636461376138663132313635373536366335300000000000000009";
const V3_SIGNATURE_HEX =
  "a0ed0ed06b1b219f000de0e14249697f9984eb41b2ebd2a825050d3cc4f291db"
  + "f19cb19726ad652c3c22dfc8680f8d1d156e5ee61e7f18e0a7c88c2c80fc290a";
const V3_MANIFEST_HASH_HEX =
  "f3e5da037d1b00d275004091d8f208b6d8e183da234693098ddae73105ef5032";

function unsigned(
  crypto: LatticeCrypto,
  source: AgentRuntimeGenerationV2,
): ObjectAccessManifestUnsignedV3 {
  return {
    objectId: objectId("object_agent_1"),
    payloadHash: hash(0x11),
    accessRevision: accessRevision(0),
    previousManifestHash: null,
    envelopeHashes: [hash(0x23), hash(0x22)],
    signer: deriveAgentRuntimeObjectSignerPublicV1(crypto, source).principal,
    hostAuthorizationRevision: authorizationRevision(9),
  };
}

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  for (let offset = 0; offset <= haystack.length - needle.length; offset++) {
    if (needle.every((byte, index) => haystack[offset + index] === byte)) {
      return offset;
    }
  }
  return -1;
}

describe("Agent ObjectAccessManifestV3", () => {
  test("dispatches only exact framed v2 and v3 manifest domains", () => {
    const crypto = new LatticeCrypto(seededRng(710));
    const signing = crypto.generateSigningKeyPair();
    const v2 = createObjectAccessManifestV2(
      crypto,
      {
        objectId: objectId("object_v2"),
        payloadHash: hash(0x10),
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [hash(0x20)],
        committerDeviceId: cryptoDeviceId("device_v2"),
        hostAuthorizationRevision: authorizationRevision(0),
      },
      signing.privateKey,
    );
    const source = runtime();
    const v3 = createAgentObjectAccessManifestV3(
      crypto,
      unsigned(crypto, source),
      source,
    );

    expect(decodeObjectAccessManifestV2OrV3(v2.bytes).formatVersion).toBe(2);
    expect(decodeObjectAccessManifestV2OrV3(v3.bytes).formatVersion).toBe(3);
    expect(decodeObjectAccessStorageManifest(v2.bytes).formatVersion).toBe(2);
    expect(decodeObjectAccessStorageManifest(v3.bytes).formatVersion).toBe(3);
    for (const value of [null, "manifest", {}, []]) {
      expect(() => decodeObjectAccessManifestV2OrV3(value as never)).toThrow(
        "object access manifest bytes must be Uint8Array",
      );
      expect(() => decodeObjectAccessStorageManifest(value as never)).toThrow(
        "object access manifest bytes must be Uint8Array",
      );
    }
    expect(() =>
      decodeObjectAccessManifestV2OrV3(new Uint8Array([1, 2, 3]))
    ).toThrow("object access manifest domain is unsupported");
    expect(() => decodeObjectAccessManifestV2OrV3(
      frameText(OBJECT_ACCESS_MANIFEST_DOMAIN_V2),
    )).toThrow("truncated u32");
    expect(() => decodeObjectAccessStorageManifest(new Uint8Array([1, 2, 3])))
      .toThrow("object access storage manifest domain is unsupported");
  });

  test("round-trips later revisions and rejects invalid previous-hash presence", () => {
    const crypto = new LatticeCrypto(seededRng(718));
    const source = runtime();
    const previousManifestHash = hash(0x44);
    const created = createAgentObjectAccessManifestV3(
      crypto,
      {
        ...unsigned(crypto, source),
        accessRevision: accessRevision(1),
        previousManifestHash,
      },
      source,
    );

    expect(decodeObjectAccessManifestV3(created.bytes).previousManifestHash)
      .toEqual(previousManifestHash);
    expect(encodeObjectAccessManifestV3(created.manifest)).toEqual(created.bytes);

    const invalidPresence = created.bytes.slice();
    const previousHashOffset = findBytes(invalidPresence, previousManifestHash);
    expect(previousHashOffset).toBeGreaterThanOrEqual(8);
    invalidPresence.set([0, 0, 0, 2], previousHashOffset - 8);
    expect(() => decodeObjectAccessManifestV3(invalidPresence))
      .toThrow("previous manifest hash presence must be 0 or 1");
  });

  test("round-trips, verifies, and owns the canonical v3 access hash", () => {
    const crypto = new LatticeCrypto(seededRng(711));
    const source = runtime();
    const identity = deriveAgentRuntimeObjectSignerPublicV1(crypto, source);
    const created = createAgentObjectAccessManifestV3(
      crypto,
      unsigned(crypto, source),
      source,
    );
    const decoded = decodeObjectAccessManifestV3(created.bytes);
    const verified = verifyAgentObjectAccessManifestV3(crypto, {
      manifestBytes: created.bytes,
      resolveSignerPublicKey: (principal) =>
        principal.signerKeyId === identity.principal.signerKeyId
          ? identity.publicKey
          : null,
    });

    expect(decoded.formatVersion).toBe(3);
    expect(decoded.envelopeHashes).toEqual([hash(0x22), hash(0x23)]);
    expect(decoded.signer).toEqual(identity.principal);
    expect(encodeObjectAccessManifestV3(decoded)).toEqual(created.bytes);
    expect(created.hash).toEqual(crypto.hash(created.bytes));
    expect(verified.manifest).toEqual(decoded);
    expect(verified.manifestHash).toEqual(created.hash);
    expect(hex(objectAccessManifestSigningBytesV3(unsigned(crypto, source))))
      .toBe(V3_SIGNING_HEX);
    expect(hex(created.manifest.signature)).toBe(V3_SIGNATURE_HEX);
    expect(hex(created.bytes))
      .toBe(`${V3_SIGNING_HEX}00000040${V3_SIGNATURE_HEX}`);
    expect(hex(created.hash)).toBe(V3_MANIFEST_HASH_HEX);
    expect(OBJECT_ACCESS_MANIFEST_DOMAIN_V3)
      .toBe("nautilo/lattice-crypto/object-access-manifest/v3");
    expect(OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V3).toBe(3);
  });

  test("uses immutable historical signer authority after Runtime rotation", () => {
    const crypto = new LatticeCrypto(seededRng(716));
    const oldRuntime = runtime("agent_alpha", 7);
    const currentRuntime = runtime("agent_alpha", 8);
    const oldSigner = deriveAgentRuntimeObjectSignerPublicV1(
      crypto,
      oldRuntime,
    );
    const currentSigner = deriveAgentRuntimeObjectSignerPublicV1(
      crypto,
      currentRuntime,
    );
    const committed = createAgentObjectAccessManifestV3(
      crypto,
      unsigned(crypto, oldRuntime),
      oldRuntime,
    );
    const history = new Map([
      [oldSigner.principal.signerKeyId, oldSigner.publicKey],
      [currentSigner.principal.signerKeyId, currentSigner.publicKey],
    ]);

    expect(
      verifyAgentObjectAccessManifestV3(crypto, {
        manifestBytes: committed.bytes,
        resolveSignerPublicKey: (principal) =>
          history.get(principal.signerKeyId) ?? null,
      }).manifest.signer,
    ).toEqual(oldSigner.principal);

    const substitutedPrincipal = encodeObjectAccessManifestV3({
      ...committed.manifest,
      signer: currentSigner.principal,
    });
    expect(() =>
      verifyAgentObjectAccessManifestV3(crypto, {
        manifestBytes: substitutedPrincipal,
        resolveSignerPublicKey: (principal) =>
          history.get(principal.signerKeyId) ?? null,
      })
    ).toThrow("signature is invalid");
  });

  test("keeps Human device manifest v2 bytes and signing domain distinct", () => {
    const crypto = new LatticeCrypto(seededRng(712));
    const source = runtime();
    const v3 = objectAccessManifestSigningBytesV3(
      unsigned(crypto, source),
    );
    const v2 = objectAccessManifestSigningBytesV2({
      objectId: objectId("object_agent_1"),
      payloadHash: hash(0x11),
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [hash(0x23), hash(0x22)],
      committerDeviceId: cryptoDeviceId("device_human_1"),
      hostAuthorizationRevision: authorizationRevision(9),
    });

    expect(OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V2).toBe(2);
    expect(OBJECT_ACCESS_MANIFEST_DOMAIN_V2)
      .toBe("nautilo/lattice-crypto/object-access-manifest/v2");
    expect(v3).not.toEqual(v2);
  });

  test("rejects malformed, noncanonical, and identity-mismatched manifests", () => {
    const crypto = new LatticeCrypto(seededRng(713));
    const source = runtime();
    const base = unsigned(crypto, source);

    expect(() => objectAccessManifestSigningBytesV3(null as never))
      .toThrow("object access manifest must be an object");
    expect(() =>
      objectAccessManifestSigningBytesV3({
        ...base,
        payloadHash: new Uint8Array(31),
      })
    ).toThrow("payload hash must be exactly 32 bytes");
    expect(() =>
      objectAccessManifestSigningBytesV3({
        ...base,
        envelopeHashes: [hash(1), hash(1)],
      })
    ).toThrow("duplicate envelope hash");
    expect(() =>
      objectAccessManifestSigningBytesV3({
        ...base,
        accessRevision: accessRevision(1),
      })
    ).toThrow("revision zero requires no previous manifest hash");
    expect(() =>
      createAgentObjectAccessManifestV3(
        crypto,
        {
          ...base,
          signer: {
            ...base.signer,
            agentId: agentId("agent_other"),
          },
        },
        source,
      )
    ).toThrow("signer Agent does not match");
    expect(() =>
      createAgentObjectAccessManifestV3(
        crypto,
        {
          ...base,
          signer: {
            ...base.signer,
            runtimeGeneration: agentRuntimeGeneration(8),
          },
        },
        source,
      )
    ).toThrow("signer Runtime generation does not match");
    expect(() =>
      encodeObjectAccessManifestV3({
        ...createAgentObjectAccessManifestV3(crypto, base, source).manifest,
        extra: true,
      } as never)
    ).toThrow("object access manifest contains unknown field extra");
    expect(() =>
      decodeObjectAccessManifestV3("manifest" as unknown as Uint8Array)
    ).toThrow("object access manifest bytes must be Uint8Array");
    const oversized = new Uint8Array(
      MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V3 + 1,
    );
    expect(() => decodeObjectAccessManifestV3(oversized))
      .toThrow("object access manifest exceeds its wire limit");
    expect(() =>
      verifyAgentObjectAccessManifestV3(crypto, {
        manifestBytes: oversized,
        resolveSignerPublicKey: () => {
          throw new Error("oversized input reached the signer resolver");
        },
      })
    ).toThrow("object access manifest exceeds its wire limit");
  });

  test("round-trips the largest valid envelope set within the wire budget", () => {
    const crypto = new LatticeCrypto(seededRng(717));
    const source = runtime("a".repeat(V2_LIMITS.idBytes), 7);
    const envelopeHashes = Array.from(
      { length: V2_LIMITS.namespaceEnvelopesPerManifest },
      (_, index) => {
        const value = new Uint8Array(32);
        value[30] = index >>> 8;
        value[31] = index;
        return value;
      },
    );
    const created = createAgentObjectAccessManifestV3(
      crypto,
      {
        ...unsigned(crypto, source),
        objectId: objectId("o".repeat(V2_LIMITS.idBytes)),
        envelopeHashes,
      },
      source,
    );

    expect(created.bytes.length)
      .toBeLessThanOrEqual(MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V3);
    expect(decodeObjectAccessManifestV3(created.bytes).envelopeHashes)
      .toHaveLength(V2_LIMITS.namespaceEnvelopesPerManifest);
  });

  test("fails closed on payload, signer, public-key, signature, and domain tampering", () => {
    const crypto = new LatticeCrypto(seededRng(714));
    const source = runtime();
    const identity = deriveAgentRuntimeObjectSignerPublicV1(crypto, source);
    const created = createAgentObjectAccessManifestV3(
      crypto,
      unsigned(crypto, source),
      source,
    );
    const resolver = () => identity.publicKey;

    const payloadTampered = encodeObjectAccessManifestV3({
      ...created.manifest,
      payloadHash: hash(0x99),
    });
    expect(() =>
      verifyAgentObjectAccessManifestV3(crypto, {
        manifestBytes: payloadTampered,
        resolveSignerPublicKey: resolver,
      })
    ).toThrow("signature is invalid");

    expect(() =>
      verifyAgentObjectAccessManifestV3(crypto, {
        manifestBytes: created.bytes,
        resolveSignerPublicKey: () => new Uint8Array(32).fill(0x88),
      })
    ).toThrow("signer key id does not match");
    expect(() =>
      verifyAgentObjectAccessManifestV3(crypto, {
        manifestBytes: created.bytes,
        resolveSignerPublicKey: () => null,
      })
    ).toThrow("no trusted Agent Runtime signing key");

    const badSignature = encodeObjectAccessManifestV3({
      ...created.manifest,
      signature: new Uint8Array(64),
    });
    expect(() =>
      verifyAgentObjectAccessManifestV3(crypto, {
        manifestBytes: badSignature,
        resolveSignerPublicKey: resolver,
      })
    ).toThrow("signature is invalid");

    const badDomain = created.bytes.slice();
    const domain = new TextEncoder().encode(OBJECT_ACCESS_MANIFEST_DOMAIN_V3);
    const domainOffset = findBytes(badDomain, domain);
    badDomain[domainOffset] = badDomain[domainOffset]! ^ 1;
    expect(() => decodeObjectAccessManifestV3(badDomain))
      .toThrow("object access manifest domain mismatch");
  });

  test("rejects noncanonical order/trailing bytes and detaches every caller-owned byte array", () => {
    const crypto = new LatticeCrypto(seededRng(715));
    const source = runtime();
    const payloadHash = hash(0x11);
    const firstEnvelope = hash(0x22);
    const secondEnvelope = hash(0x23);
    const input = {
      ...unsigned(crypto, source),
      payloadHash,
      envelopeHashes: [secondEnvelope, firstEnvelope],
    };
    const created = createAgentObjectAccessManifestV3(crypto, input, source);
    const snapshot = structuredClone(created);
    payloadHash.fill(0);
    firstEnvelope.fill(0);
    secondEnvelope.fill(0);
    source.key.fill(0);
    expect(created).toEqual(snapshot);

    const noncanonical = created.bytes.slice();
    const firstOffset = findBytes(noncanonical, hash(0x22));
    const secondOffset = findBytes(noncanonical, hash(0x23));
    noncanonical.set(hash(0x23), firstOffset);
    noncanonical.set(hash(0x22), secondOffset);
    expect(() => decodeObjectAccessManifestV3(noncanonical))
      .toThrow("noncanonical ordering");
    expect(() =>
      decodeObjectAccessManifestV3(
        Uint8Array.from([...created.bytes, 0]),
      )
    ).toThrow("trailing bytes");
  });
});
