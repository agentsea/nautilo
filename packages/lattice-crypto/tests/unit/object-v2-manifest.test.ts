import { describe, expect, test } from "bun:test";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  OBJECT_ACCESS_MANIFEST_DOMAIN_V2,
  OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V2,
  createObjectAccessManifestV2,
  decodeObjectAccessManifestV2,
  encodeObjectAccessManifestV2,
  objectAccessManifestSigningBytesV2,
} from "../../src/format/object-access-manifest-v2.ts";
import { encodeNamespaceObjectEnvelopeV2 } from "../../src/format/object-v2.ts";
import {
  assertEnvelopeAuthorizedV2,
  assertAuthenticPreparedObjectAccessManifestGenesisWithTombstoneV2,
  prepareObjectAccessManifestGenesisV2,
  prepareObjectAccessManifestGenesisWithTombstoneV2,
  prepareObjectAccessManifestUpdateV2,
  verifyObjectAccessManifestChainV2,
} from "../../src/object/access-manifest.ts";
import { wrapObjectDekForNamespaceV2 } from "../../src/object/namespace-envelope.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  namespaceGeneration,
  namespaceId,
  objectId,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function makeHash(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function hex(value: Uint8Array): string {
  return Array.from(
    value,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  for (let offset = 0; offset <= haystack.length - needle.length; offset++) {
    if (needle.every((byte, index) => haystack[offset + index] === byte)) {
      return offset;
    }
  }
  return -1;
}

function signerMap(
  deviceId: string,
  publicKey: Uint8Array,
): (id: string) => Uint8Array | null {
  return (id) => id === deviceId ? publicKey : null;
}

function envelopeWire(
  crypto: LatticeCrypto,
  namespace: string,
  marker: number,
  object = "object_1",
): Uint8Array {
  return encodeNamespaceObjectEnvelopeV2(
    wrapObjectDekForNamespaceV2(
      crypto,
      new Uint8Array(32).fill(marker),
      {
        objectId: objectId(object),
        namespaceId: namespaceId(namespace),
        keyClass: "human",
        keyGeneration: namespaceGeneration(0),
        bindingRevisionAtWrap: accessRevision(0),
      },
      new Uint8Array(32).fill(marker + 1),
    ),
  );
}

describe("ObjectAccessManifestV2 canonical signing", () => {
  test("pre-signs an empty exact successor for Human recovery", () => {
    const crypto = new LatticeCrypto(seededRng(402));
    const signing = crypto.generateSigningKeyPair();
    const prepared = prepareObjectAccessManifestGenesisWithTombstoneV2(
      crypto,
      {
        objectId: objectId("object_human_recovery"),
        payloadHash: makeHash(0x21),
        envelopeBytes: [
          envelopeWire(crypto, "namespace_a", 0x31, "object_human_recovery"),
          envelopeWire(crypto, "namespace_b", 0x41, "object_human_recovery"),
        ],
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: cryptoDeviceId("device_alice_1"),
        hostAuthorizationRevision: authorizationRevision(7),
        signingPrivateKey: signing.privateKey,
      },
    );

    expect(prepared.genesis.manifest.envelopeHashes).toHaveLength(2);
    expect(prepared.preauthorizedTombstone.manifest.accessRevision)
      .toBe(accessRevision(1));
    expect(prepared.preauthorizedTombstone.manifest.previousManifestHash)
      .toEqual(prepared.genesis.manifestHash);
    expect(prepared.preauthorizedTombstone.manifest.payloadHash)
      .toEqual(prepared.genesis.manifest.payloadHash);
    expect(prepared.preauthorizedTombstone.manifest.envelopeHashes).toEqual([]);
    expect(prepared.preauthorizedTombstone.manifest.committerDeviceId)
      .toBe(prepared.genesis.manifest.committerDeviceId);
    expect(() =>
      assertAuthenticPreparedObjectAccessManifestGenesisWithTombstoneV2(
        prepared,
      )
    ).not.toThrow();
    for (const [authenticatedBytes, expectedError] of [
      [prepared.genesis.manifestHash, "authentic prepared genesis"],
      [
        prepared.preauthorizedTombstone.manifestBytes,
        "authentic prepared genesis tombstone",
      ],
      [
        prepared.preauthorizedTombstone.manifestHash,
        "authentic prepared genesis tombstone",
      ],
    ] as const) {
      authenticatedBytes.fill(authenticatedBytes[0]! ^ 1, 0, 1);
      expect(() =>
        assertAuthenticPreparedObjectAccessManifestGenesisWithTombstoneV2(
          prepared,
        )
      ).toThrow(expectedError);
      authenticatedBytes.fill(authenticatedBytes[0]! ^ 1, 0, 1);
    }
  });

  test("rejects every malformed unsigned and signed field with exact boundaries", () => {
    const crypto = new LatticeCrypto(seededRng(403));
    const signing = crypto.generateSigningKeyPair();
    const base = {
      objectId: objectId("object_1"),
      payloadHash: makeHash(1),
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [makeHash(2)],
      committerDeviceId: cryptoDeviceId("device_alice_1"),
      hostAuthorizationRevision: authorizationRevision(0),
    };
    expect(() => objectAccessManifestSigningBytesV2(null as never))
      .toThrow("object access manifest must be an object");
    expect(() => objectAccessManifestSigningBytesV2("manifest" as never))
      .toThrow("object access manifest must be an object");
    expect(() =>
      objectAccessManifestSigningBytesV2({
        ...base,
        envelopeHashes: null as never,
      })
    ).toThrow("manifest envelope hashes must be an array");
    expect(() =>
      objectAccessManifestSigningBytesV2({
        ...base,
        envelopeHashes: [makeHash(1), makeHash(2)],
      })
    ).not.toThrow();
    expect(() =>
      objectAccessManifestSigningBytesV2({
        ...base,
        payloadHash: new Uint8Array(31),
      })
    ).toThrow("payload hash must be exactly 32 bytes");
    expect(() =>
      objectAccessManifestSigningBytesV2({
        ...base,
        previousManifestHash: new Uint8Array(31),
        accessRevision: accessRevision(1),
      })
    ).toThrow("previous manifest hash must be exactly 32 bytes");
    expect(() =>
      encodeObjectAccessManifestV2({
        ...base,
        formatVersion: 1 as 2,
        signature: new Uint8Array(64),
      })
    ).toThrow("unsupported object access manifest version");
    expect(() =>
      encodeObjectAccessManifestV2({
        ...base,
        formatVersion: OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V2,
        signature: new Uint8Array(63),
      })
    ).toThrow("manifest signature must be exactly 64 bytes");
    expect(() =>
      createObjectAccessManifestV2(
        crypto,
        base,
        new Uint8Array(31),
      )
    ).toThrow("signing private key must be exactly 32 bytes");
    const badCrypto = Object.create(crypto) as LatticeCrypto;
    badCrypto.sign = () => new Uint8Array(63);
    expect(() =>
      createObjectAccessManifestV2(
        badCrypto,
        base,
        signing.privateKey,
      )
    ).toThrow("manifest signature must be exactly 64 bytes");
    expect(() =>
      decodeObjectAccessManifestV2("bytes" as unknown as Uint8Array)
    ).toThrow("object access manifest bytes must be Uint8Array");

    const created = createObjectAccessManifestV2(
      crypto,
      base,
      signing.privateKey,
    );
    const badDomain = created.bytes.slice();
    const domain = new TextEncoder().encode(
      OBJECT_ACCESS_MANIFEST_DOMAIN_V2,
    );
    const domainOffset = findBytes(badDomain, domain);
    badDomain[domainOffset] = badDomain[domainOffset]! ^ 1;
    expect(() => decodeObjectAccessManifestV2(badDomain))
      .toThrow("object access manifest domain mismatch");

    const objectBytes = new TextEncoder().encode("object_1");
    const presenceOffset =
      4 + domain.length
      + 4
      + 4 + objectBytes.length
      + 4 + 32
      + 8;
    const badPresence = created.bytes.slice();
    badPresence[presenceOffset + 3] = 2;
    expect(() => decodeObjectAccessManifestV2(badPresence))
      .toThrow("previous manifest hash presence must be 0 or 1");

    const shortSignature = created.bytes.slice(0, -1);
    const signatureLengthOffset = shortSignature.length - 63 - 4;
    shortSignature[signatureLengthOffset + 3] = 63;
    expect(() => decodeObjectAccessManifestV2(shortSignature))
      .toThrow("manifest signature must be exactly 64 bytes");
  });

  test("detaches every caller-owned hash and signing key result", () => {
    const crypto = new LatticeCrypto(seededRng(402));
    const signing = crypto.generateSigningKeyPair();
    const payloadHash = makeHash(1);
    const envelopeHash = makeHash(2);
    const created = createObjectAccessManifestV2(
      crypto,
      {
        objectId: objectId("object_1"),
        payloadHash,
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [envelopeHash],
        committerDeviceId: cryptoDeviceId("device_alice_1"),
        hostAuthorizationRevision: authorizationRevision(0),
      },
      signing.privateKey,
    );
    const snapshot = structuredClone(created);
    payloadHash.fill(0);
    envelopeHash.fill(0);
    signing.privateKey.fill(0);
    expect(created).toEqual(snapshot);
  });

  test("round-trips a detached canonical signed hash-chained manifest", () => {
    const crypto = new LatticeCrypto(seededRng(404));
    const signing = crypto.generateSigningKeyPair();
    const created = createObjectAccessManifestV2(
      crypto,
      {
        objectId: objectId("object_1"),
        payloadHash: makeHash(0x11),
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [makeHash(0x22), makeHash(0x21)],
        committerDeviceId: cryptoDeviceId("device_alice_1"),
        hostAuthorizationRevision: authorizationRevision(8),
      },
      signing.privateKey,
    );
    const decoded = decodeObjectAccessManifestV2(created.bytes);

    expect(decoded.envelopeHashes).toEqual([makeHash(0x21), makeHash(0x22)]);
    expect(encodeObjectAccessManifestV2(decoded)).toEqual(created.bytes);
    expect(created.hash).toEqual(crypto.hash(created.bytes));
    expect(hex(created.hash)).toBe(
      "4c2a6475de3e9dcc8dbfcdddf839a2541cc9b9d6ea3fa8f39815ced7e12d952a",
    );
    expect(
      crypto.verify(
        signing.publicKey,
        objectAccessManifestSigningBytesV2(decoded),
        decoded.signature,
      ),
    ).toBe(true);

    const noncanonical = created.bytes.slice();
    const firstHashOffset = findBytes(noncanonical, makeHash(0x21));
    const secondHashOffset = findBytes(noncanonical, makeHash(0x22));
    expect(firstHashOffset).toBeGreaterThanOrEqual(0);
    expect(secondHashOffset).toBeGreaterThan(firstHashOffset);
    noncanonical.set(makeHash(0x22), firstHashOffset);
    noncanonical.set(makeHash(0x21), secondHashOffset);
    expect(() => decodeObjectAccessManifestV2(noncanonical)).toThrow(
      "noncanonical ordering",
    );
    expect(() =>
      decodeObjectAccessManifestV2(Uint8Array.from([...created.bytes, 0]))
    ).toThrow("trailing bytes");

    created.bytes[0] = created.bytes[0]! ^ 0xff;
    expect(encodeObjectAccessManifestV2(decoded)).not.toEqual(created.bytes);
  });

  test("rejects duplicate, malformed, and oversized envelope inventories", () => {
    const crypto = new LatticeCrypto(seededRng(405));
    const signing = crypto.generateSigningKeyPair();
    const base = {
      objectId: objectId("object_1"),
      payloadHash: makeHash(1),
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      committerDeviceId: cryptoDeviceId("device_alice_1"),
      hostAuthorizationRevision: authorizationRevision(0),
    };

    expect(() =>
      createObjectAccessManifestV2(
        crypto,
        { ...base, envelopeHashes: [makeHash(2), makeHash(2)] },
        signing.privateKey,
      )
    ).toThrow("duplicate");
    expect(() =>
      createObjectAccessManifestV2(
        crypto,
        { ...base, envelopeHashes: [new Uint8Array(31)] },
        signing.privateKey,
      )
    ).toThrow("32 bytes");
    expect(() =>
      createObjectAccessManifestV2(
        crypto,
        {
          ...base,
          envelopeHashes: Array.from(
            { length: V2_LIMITS.namespaceEnvelopesPerManifest + 1 },
            (_, index) => {
              const hash = new Uint8Array(32);
              hash[30] = index >>> 8;
              hash[31] = index;
              return hash;
            },
          ),
        },
        signing.privateKey,
      )
    ).toThrow("manifest envelope count");
    expect(() =>
      prepareObjectAccessManifestGenesisV2(crypto, {
        objectId: objectId("object_1"),
        payloadHash: makeHash(1),
        envelopeBytes: Array.from(
          { length: V2_LIMITS.namespaceEnvelopesPerManifest + 1 },
          () => new Uint8Array(),
        ),
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: cryptoDeviceId("device_alice_1"),
        hostAuthorizationRevision: authorizationRevision(0),
        signingPrivateKey: signing.privateKey,
      })
    ).toThrow(
      `Namespace envelope count exceeds the ${V2_LIMITS.namespaceEnvelopesPerManifest} limit`,
    );
    expect(() =>
      createObjectAccessManifestV2(
        crypto,
        { ...base, envelopeHashes: [new Uint8Array(31)] },
        signing.privateKey,
      )
    ).toThrow("envelope hash must be exactly 32 bytes");
    expect(() =>
      createObjectAccessManifestV2(
        crypto,
        {
          ...base,
          previousManifestHash: makeHash(3),
          envelopeHashes: [],
        },
        signing.privateKey,
      )
    ).toThrow("revision zero");
    expect(() =>
      createObjectAccessManifestV2(
        crypto,
        {
          ...base,
          accessRevision: accessRevision(1),
          envelopeHashes: [],
        },
        signing.privateKey,
      )
    ).toThrow("later revisions");
  });
});

describe("ObjectAccessManifestV2 verification and updates", () => {
  test("prepares signed attach/detach revisions and rejects detached replay", () => {
    const crypto = new LatticeCrypto(seededRng(500));
    const signing = crypto.generateSigningKeyPair();
    const deviceId = cryptoDeviceId("device_alice_1");
    const payloadHash = crypto.hash(bytes("payload"));
    const envelopeA = envelopeWire(crypto, "namespace_a", 0x11);
    const envelopeB = envelopeWire(crypto, "namespace_b", 0x22);
    const genesis = createObjectAccessManifestV2(
      crypto,
      {
        objectId: objectId("object_1"),
        payloadHash,
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [crypto.hash(envelopeA)],
        committerDeviceId: deviceId,
        hostAuthorizationRevision: authorizationRevision(1),
      },
      signing.privateKey,
    );
    const resolver = signerMap(deviceId, signing.publicKey);

    expect(() =>
      prepareObjectAccessManifestUpdateV2(crypto, {
        currentManifestBytes: genesis.bytes,
        currentEnvelopeBytes: [envelopeA],
        trustedMinimumHead: {
          objectId: objectId("object_1"),
          payloadHash,
          accessRevision: accessRevision(0),
          manifestHash: genesis.hash,
        },
        proof: [],
        resolveSigningPublicKey: resolver,
        operation: { type: "attach", envelopeBytes: envelopeB },
        sourceAuthorized: true,
        targetAuthorized: false,
        committerDeviceId: deviceId,
        hostAuthorizationRevision: authorizationRevision(2),
        signingPrivateKey: signing.privateKey,
      })
    ).toThrow("source and target authorization");
    expect(() =>
      prepareObjectAccessManifestUpdateV2(crypto, {
        currentManifestBytes: genesis.bytes,
        currentEnvelopeBytes: [envelopeA],
        trustedMinimumHead: {
          objectId: objectId("object_1"),
          payloadHash,
          accessRevision: accessRevision(0),
          manifestHash: genesis.hash,
        },
        proof: [],
        resolveSigningPublicKey: resolver,
        operation: { type: "attach", envelopeBytes: envelopeB },
        sourceAuthorized: false,
        targetAuthorized: true,
        committerDeviceId: deviceId,
        hostAuthorizationRevision: authorizationRevision(2),
        signingPrivateKey: signing.privateKey,
      })
    ).toThrow("source and target authorization");
    expect(() =>
      prepareObjectAccessManifestUpdateV2(crypto, {
        currentManifestBytes: genesis.bytes,
        currentEnvelopeBytes: [],
        trustedMinimumHead: {
          objectId: objectId("object_1"),
          payloadHash,
          accessRevision: accessRevision(0),
          manifestHash: genesis.hash,
        },
        proof: [],
        resolveSigningPublicKey: resolver,
        operation: { type: "attach", envelopeBytes: envelopeB },
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: deviceId,
        hostAuthorizationRevision: authorizationRevision(2),
        signingPrivateKey: signing.privateKey,
      })
    ).toThrow("inventory");
    expect(() =>
      prepareObjectAccessManifestUpdateV2(crypto, {
        currentManifestBytes: genesis.bytes,
        currentEnvelopeBytes: [envelopeB],
        trustedMinimumHead: {
          objectId: objectId("object_1"),
          payloadHash,
          accessRevision: accessRevision(0),
          manifestHash: genesis.hash,
        },
        proof: [],
        resolveSigningPublicKey: resolver,
        operation: { type: "attach", envelopeBytes: envelopeA },
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: deviceId,
        hostAuthorizationRevision: authorizationRevision(2),
        signingPrivateKey: signing.privateKey,
      })
    ).toThrow("inventory");
    expect(() =>
      prepareObjectAccessManifestUpdateV2(crypto, {
        currentManifestBytes: genesis.bytes,
        currentEnvelopeBytes: [envelopeA],
        trustedMinimumHead: {
          objectId: objectId("object_1"),
          payloadHash,
          accessRevision: accessRevision(0),
          manifestHash: genesis.hash,
        },
        proof: [],
        resolveSigningPublicKey: resolver,
        operation: { type: "attach", envelopeBytes: envelopeA },
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: deviceId,
        hostAuthorizationRevision: authorizationRevision(2),
        signingPrivateKey: signing.privateKey,
      })
    ).toThrow("already attached");
    expect(() =>
      prepareObjectAccessManifestUpdateV2(crypto, {
        currentManifestBytes: genesis.bytes,
        currentEnvelopeBytes: [envelopeA],
        trustedMinimumHead: {
          objectId: objectId("object_1"),
          payloadHash,
          accessRevision: accessRevision(0),
          manifestHash: genesis.hash,
        },
        proof: [],
        resolveSigningPublicKey: resolver,
        operation: { type: "detach", envelopeBytes: envelopeB },
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: deviceId,
        hostAuthorizationRevision: authorizationRevision(2),
        signingPrivateKey: signing.privateKey,
      })
    ).toThrow("absent");

    const attached = prepareObjectAccessManifestUpdateV2(crypto, {
      currentManifestBytes: genesis.bytes,
      currentEnvelopeBytes: [envelopeA],
      trustedMinimumHead: {
        objectId: objectId("object_1"),
        payloadHash,
        accessRevision: accessRevision(0),
        manifestHash: genesis.hash,
      },
      proof: [],
      resolveSigningPublicKey: resolver,
      operation: { type: "attach", envelopeBytes: envelopeB },
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: deviceId,
      hostAuthorizationRevision: authorizationRevision(2),
      signingPrivateKey: signing.privateKey,
    });

    expect(Number(attached.manifest.accessRevision)).toBe(1);
    expect(attached.manifest.previousManifestHash).toEqual(genesis.hash);
    expect(attached.envelopeBytes).toHaveLength(2);
    const verifiedAttached = verifyObjectAccessManifestChainV2(crypto, {
      manifestBytes: attached.manifestBytes,
      proof: [],
      trustedMinimumHead: {
        objectId: objectId("object_1"),
        payloadHash,
        accessRevision: accessRevision(0),
        manifestHash: genesis.hash,
      },
      resolveSigningPublicKey: resolver,
    });
    expect(Number(verifiedAttached.manifest.accessRevision)).toBe(1);
    expect(() =>
      assertEnvelopeAuthorizedV2(crypto, verifiedAttached, envelopeB)
    ).not.toThrow();
    expect(() =>
      assertEnvelopeAuthorizedV2(
        crypto,
        verifiedAttached.manifest as never,
        envelopeB,
      )
    ).toThrow("trusted-head-verified");
    const envelopeC = envelopeWire(crypto, "namespace_c", 0x44);
    verifiedAttached.manifest.envelopeHashes[0]!.set(crypto.hash(envelopeC));
    expect(() =>
      assertEnvelopeAuthorizedV2(crypto, verifiedAttached, envelopeC)
    ).toThrow("detached");
    const wrongObjectEnvelope = envelopeWire(
      crypto,
      "namespace_wrong_object",
      0x45,
      "object_2",
    );
    const wrongObjectManifest = createObjectAccessManifestV2(
      crypto,
      {
        objectId: objectId("object_1"),
        payloadHash,
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [crypto.hash(wrongObjectEnvelope)],
        committerDeviceId: deviceId,
        hostAuthorizationRevision: authorizationRevision(1),
      },
      signing.privateKey,
    );
    const verifiedWrongObject = verifyObjectAccessManifestChainV2(crypto, {
      manifestBytes: wrongObjectManifest.bytes,
      proof: [],
      trustedMinimumHead: {
        objectId: objectId("object_1"),
        payloadHash,
        accessRevision: accessRevision(0),
        manifestHash: wrongObjectManifest.hash,
      },
      resolveSigningPublicKey: resolver,
    });
    expect(() =>
      assertEnvelopeAuthorizedV2(
        crypto,
        verifiedWrongObject,
        wrongObjectEnvelope,
      )
    ).toThrow("object mismatch");
    expect(() =>
      prepareObjectAccessManifestUpdateV2(crypto, {
        currentManifestBytes: wrongObjectManifest.bytes,
        currentEnvelopeBytes: [wrongObjectEnvelope],
        trustedMinimumHead: {
          objectId: objectId("object_1"),
          payloadHash,
          accessRevision: accessRevision(0),
          manifestHash: wrongObjectManifest.hash,
        },
        proof: [],
        resolveSigningPublicKey: resolver,
        operation: { type: "attach", envelopeBytes: envelopeC },
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: deviceId,
        hostAuthorizationRevision: authorizationRevision(2),
        signingPrivateKey: signing.privateKey,
      })
    ).toThrow("object mismatch");
    expect(() =>
      prepareObjectAccessManifestUpdateV2(crypto, {
        currentManifestBytes: genesis.bytes,
        currentEnvelopeBytes: [envelopeA],
        trustedMinimumHead: {
          objectId: objectId("object_1"),
          payloadHash,
          accessRevision: accessRevision(0),
          manifestHash: genesis.hash,
        },
        proof: [],
        resolveSigningPublicKey: resolver,
        operation: {
          type: "attach",
          envelopeBytes: envelopeWire(
            crypto,
            "namespace_wrong_object",
            0x55,
            "object_2",
          ),
        },
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: deviceId,
        hostAuthorizationRevision: authorizationRevision(2),
        signingPrivateKey: signing.privateKey,
      })
    ).toThrow("object mismatch");

    const detached = prepareObjectAccessManifestUpdateV2(crypto, {
      currentManifestBytes: attached.manifestBytes,
      currentEnvelopeBytes: attached.envelopeBytes,
      trustedMinimumHead: {
        objectId: objectId("object_1"),
        payloadHash,
        accessRevision: accessRevision(1),
        manifestHash: attached.manifestHash,
      },
      proof: [],
      resolveSigningPublicKey: resolver,
      operation: { type: "detach", envelopeBytes: envelopeB },
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: deviceId,
      hostAuthorizationRevision: authorizationRevision(3),
      signingPrivateKey: signing.privateKey,
    });

    expect(Number(detached.manifest.accessRevision)).toBe(2);
    expect(detached.envelopeBytes).toEqual([envelopeA]);
    const verifiedDetached = verifyObjectAccessManifestChainV2(crypto, {
      manifestBytes: detached.manifestBytes,
      proof: [attached.manifestBytes],
      trustedMinimumHead: {
        objectId: objectId("object_1"),
        payloadHash,
        accessRevision: accessRevision(0),
        manifestHash: genesis.hash,
      },
      resolveSigningPublicKey: resolver,
    });
    expect(() =>
      assertEnvelopeAuthorizedV2(crypto, verifiedDetached, envelopeB)
    ).toThrow("detached");

    const firstEnvelope = attached.envelopeBytes[0]!;
    const detachedFirst = prepareObjectAccessManifestUpdateV2(crypto, {
      currentManifestBytes: attached.manifestBytes,
      currentEnvelopeBytes: attached.envelopeBytes,
      trustedMinimumHead: {
        objectId: objectId("object_1"),
        payloadHash,
        accessRevision: accessRevision(1),
        manifestHash: attached.manifestHash,
      },
      proof: [],
      resolveSigningPublicKey: resolver,
      operation: { type: "detach", envelopeBytes: firstEnvelope },
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: deviceId,
      hostAuthorizationRevision: authorizationRevision(3),
      signingPrivateKey: signing.privateKey,
    });
    expect(detachedFirst.envelopeBytes).toEqual(
      attached.envelopeBytes.filter((entry) => entry !== firstEnvelope),
    );
  });

  test("fails closed on rollback, same-revision change, fork, and payload mismatch", () => {
    const crypto = new LatticeCrypto(seededRng(501));
    const signing = crypto.generateSigningKeyPair();
    const deviceId = cryptoDeviceId("device_alice_1");
    const payloadHash = makeHash(7);
    const resolver = signerMap(deviceId, signing.publicKey);
    const genesis = createObjectAccessManifestV2(
      crypto,
      {
        objectId: objectId("object_1"),
        payloadHash,
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [makeHash(8)],
        committerDeviceId: deviceId,
        hostAuthorizationRevision: authorizationRevision(1),
      },
      signing.privateKey,
    );
    const revisionOne = createObjectAccessManifestV2(
      crypto,
      {
        ...genesis.manifest,
        accessRevision: accessRevision(1),
        previousManifestHash: genesis.hash,
        envelopeHashes: [makeHash(9)],
        hostAuthorizationRevision: authorizationRevision(2),
      },
      signing.privateKey,
    );
    const tamperedSignature = revisionOne.bytes.slice();
    tamperedSignature[tamperedSignature.length - 1] =
      tamperedSignature[tamperedSignature.length - 1]! ^ 1;
    expect(() =>
      verifyObjectAccessManifestChainV2(crypto, {
        manifestBytes: tamperedSignature,
        proof: [],
        trustedMinimumHead: {
          objectId: objectId("object_1"),
          payloadHash,
          accessRevision: accessRevision(0),
          manifestHash: genesis.hash,
        },
        resolveSigningPublicKey: resolver,
      })
    ).toThrow("signature");

    const currentAnchor = {
      objectId: objectId("object_1"),
      payloadHash,
      accessRevision: accessRevision(1),
      manifestHash: revisionOne.hash,
    };
    expect(() =>
      verifyObjectAccessManifestChainV2(crypto, {
        manifestBytes: revisionOne.bytes,
        proof: [genesis.bytes],
        trustedMinimumHead: currentAnchor,
        resolveSigningPublicKey: resolver,
      })
    ).toThrow("must be empty");
    expect(() =>
      verifyObjectAccessManifestChainV2(crypto, {
        manifestBytes: revisionOne.bytes,
        proof: {
          length: 0,
          *[Symbol.iterator]() {},
        } as unknown as readonly Uint8Array[],
        trustedMinimumHead: currentAnchor,
        resolveSigningPublicKey: resolver,
      })
    ).toThrow("array");
    expect(() =>
      verifyObjectAccessManifestChainV2(crypto, {
        manifestBytes: revisionOne.bytes,
        proof: [],
        trustedMinimumHead: {
          ...currentAnchor,
          manifestHash: new Uint8Array(31),
        },
        resolveSigningPublicKey: resolver,
      })
    ).toThrow("trusted manifest hash must be exactly 32 bytes");
    expect(() =>
      verifyObjectAccessManifestChainV2(crypto, {
        manifestBytes: revisionOne.bytes,
        proof: [],
        trustedMinimumHead: {
          ...currentAnchor,
          payloadHash: new Uint8Array(31),
        },
        resolveSigningPublicKey: resolver,
      })
    ).toThrow("trusted payload hash must be exactly 32 bytes");
    expect(() =>
      verifyObjectAccessManifestChainV2(crypto, {
        manifestBytes: revisionOne.bytes,
        proof: [],
        trustedMinimumHead: {
          ...currentAnchor,
          objectId: objectId("object_2"),
        },
        resolveSigningPublicKey: resolver,
      })
    ).toThrow("object mismatch");
    expect(() =>
      verifyObjectAccessManifestChainV2(crypto, {
        manifestBytes: revisionOne.bytes,
        proof: [],
        trustedMinimumHead: currentAnchor,
        resolveSigningPublicKey: () => null,
      })
    ).toThrow("trusted signing key");
    expect(() =>
      verifyObjectAccessManifestChainV2(crypto, {
        manifestBytes: genesis.bytes,
        proof: [],
        trustedMinimumHead: currentAnchor,
        resolveSigningPublicKey: resolver,
      })
    ).toThrow("rollback");

    const sameRevisionFork = createObjectAccessManifestV2(
      crypto,
      {
        ...revisionOne.manifest,
        envelopeHashes: [makeHash(10)],
      },
      signing.privateKey,
    );
    expect(() =>
      verifyObjectAccessManifestChainV2(crypto, {
        manifestBytes: sameRevisionFork.bytes,
        proof: [],
        trustedMinimumHead: currentAnchor,
        resolveSigningPublicKey: resolver,
      })
    ).toThrow("same revision");

    const brokenChain = createObjectAccessManifestV2(
      crypto,
      {
        ...revisionOne.manifest,
        accessRevision: accessRevision(2),
        previousManifestHash: makeHash(0xff),
      },
      signing.privateKey,
    );
    expect(() =>
      verifyObjectAccessManifestChainV2(crypto, {
        manifestBytes: brokenChain.bytes,
        proof: [],
        trustedMinimumHead: currentAnchor,
        resolveSigningPublicKey: resolver,
      })
    ).toThrow("fork");
    const gap = createObjectAccessManifestV2(
      crypto,
      {
        ...revisionOne.manifest,
        accessRevision: accessRevision(2),
        previousManifestHash: genesis.hash,
      },
      signing.privateKey,
    );
    expect(() =>
      verifyObjectAccessManifestChainV2(crypto, {
        manifestBytes: gap.bytes,
        proof: [],
        trustedMinimumHead: {
          objectId: objectId("object_1"),
          payloadHash,
          accessRevision: accessRevision(0),
          manifestHash: genesis.hash,
        },
        resolveSigningPublicKey: resolver,
      })
    ).toThrow("fork");

    expect(() =>
      verifyObjectAccessManifestChainV2(crypto, {
        manifestBytes: revisionOne.bytes,
        proof: [],
        trustedMinimumHead: {
          ...currentAnchor,
          payloadHash: makeHash(0xee),
        },
        resolveSigningPublicKey: resolver,
      })
    ).toThrow("payload");
  });

  test("detaches verified manifest bytes on same-revision and forward-chain paths", () => {
    const crypto = new LatticeCrypto(seededRng(504));
    const signing = crypto.generateSigningKeyPair();
    const deviceId = cryptoDeviceId("device_alice_1");
    const payloadHash = makeHash(7);
    const resolver = signerMap(deviceId, signing.publicKey);
    const genesis = createObjectAccessManifestV2(
      crypto,
      {
        objectId: objectId("object_1"),
        payloadHash,
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [],
        committerDeviceId: deviceId,
        hostAuthorizationRevision: authorizationRevision(1),
      },
      signing.privateKey,
    );
    const revisionOne = createObjectAccessManifestV2(
      crypto,
      {
        ...genesis.manifest,
        accessRevision: accessRevision(1),
        previousManifestHash: genesis.hash,
        hostAuthorizationRevision: authorizationRevision(2),
      },
      signing.privateKey,
    );
    const sameRevisionBytes = genesis.bytes.slice();
    const forwardBytes = revisionOne.bytes.slice();
    const verifiedSameRevision = verifyObjectAccessManifestChainV2(crypto, {
      manifestBytes: sameRevisionBytes,
      proof: [],
      trustedMinimumHead: {
        objectId: objectId("object_1"),
        payloadHash,
        accessRevision: accessRevision(0),
        manifestHash: crypto.hash(sameRevisionBytes),
      },
      resolveSigningPublicKey: resolver,
    });
    const verifiedForward = verifyObjectAccessManifestChainV2(crypto, {
      manifestBytes: forwardBytes,
      proof: [],
      trustedMinimumHead: {
        objectId: objectId("object_1"),
        payloadHash,
        accessRevision: accessRevision(0),
        manifestHash: genesis.hash,
      },
      resolveSigningPublicKey: resolver,
    });
    const expectedSameRevision = sameRevisionBytes.slice();
    const expectedForward = forwardBytes.slice();

    sameRevisionBytes[0] = sameRevisionBytes[0]! ^ 0xff;
    forwardBytes[0] = forwardBytes[0]! ^ 0xff;

    expect(verifiedSameRevision.manifestBytes).toEqual(expectedSameRevision);
    expect(verifiedForward.manifestBytes).toEqual(expectedForward);
  });

  test("enforces proof, envelope-count, and aggregate-envelope-byte limits first", () => {
    const crypto = new LatticeCrypto(seededRng(502));
    const signing = crypto.generateSigningKeyPair();
    const deviceId = cryptoDeviceId("device_alice_1");
    const payloadHash = makeHash(1);
    const envelope = envelopeWire(crypto, "namespace_a", 0x33);
    const genesis = createObjectAccessManifestV2(
      crypto,
      {
        objectId: objectId("object_1"),
        payloadHash,
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [crypto.hash(envelope)],
        committerDeviceId: deviceId,
        hostAuthorizationRevision: authorizationRevision(1),
      },
      signing.privateKey,
    );
    const common = {
      manifestBytes: genesis.bytes,
      trustedMinimumHead: {
        objectId: objectId("object_1"),
        payloadHash,
        accessRevision: accessRevision(0),
        manifestHash: genesis.hash,
      },
      resolveSigningPublicKey: signerMap(deviceId, signing.publicKey),
    };

    expect(() =>
      verifyObjectAccessManifestChainV2(crypto, {
        ...common,
        proof: Array.from(
          { length: V2_LIMITS.proofEntriesPerSegment + 1 },
          () => new Uint8Array(),
        ),
      })
    ).toThrow("proof");

    expect(() =>
      prepareObjectAccessManifestUpdateV2(crypto, {
        currentManifestBytes: genesis.bytes,
        currentEnvelopeBytes: [new Uint8Array(
          V2_LIMITS.manifestEnvelopeBytes + 1,
        )],
        trustedMinimumHead: common.trustedMinimumHead,
        proof: [],
        resolveSigningPublicKey: common.resolveSigningPublicKey,
        operation: { type: "attach", envelopeBytes: bytes("next") },
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: deviceId,
        hostAuthorizationRevision: authorizationRevision(2),
        signingPrivateKey: signing.privateKey,
      })
    ).toThrow("envelope bytes");
  });

  test("canonicalizes current envelope order and rejects duplicate bytes before mutation", () => {
    const crypto = new LatticeCrypto(seededRng(503));
    const signing = crypto.generateSigningKeyPair();
    const deviceId = cryptoDeviceId("device_alice_1");
    const payloadHash = makeHash(1);
    const firstByHashPrefix = new Map<number, Uint8Array>();
    let collisionPair: readonly [Uint8Array, Uint8Array] | null = null;
    for (let index = 0; index <= 256 && collisionPair === null; index += 1) {
      const candidate = envelopeWire(
        crypto,
        `namespace_collision_${index}`,
        index & 0xff,
      );
      const prefix = crypto.hash(candidate)[0]!;
      const prior = firstByHashPrefix.get(prefix);
      if (prior !== undefined) collisionPair = [prior, candidate];
      else firstByHashPrefix.set(prefix, candidate);
    }
    expect(collisionPair).not.toBeNull();
    const [envelopeA, envelopeB] = collisionPair!;
    expect(crypto.hash(envelopeA)[0]).toBe(crypto.hash(envelopeB)[0]);
    expect(crypto.hash(envelopeA)).not.toEqual(crypto.hash(envelopeB));
    const envelopeC = envelopeWire(crypto, "namespace_c", 0x63);
    const sorted = [envelopeA, envelopeB].sort((left, right) =>
      hex(crypto.hash(left)).localeCompare(hex(crypto.hash(right)))
    );
    const reverse = [...sorted].reverse();
    const genesis = createObjectAccessManifestV2(
      crypto,
      {
        objectId: objectId("object_1"),
        payloadHash,
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: sorted.map((envelope) => crypto.hash(envelope)),
        committerDeviceId: deviceId,
        hostAuthorizationRevision: authorizationRevision(1),
      },
      signing.privateKey,
    );
    const common = {
      currentManifestBytes: genesis.bytes,
      trustedMinimumHead: {
        objectId: objectId("object_1"),
        payloadHash,
        accessRevision: accessRevision(0),
        manifestHash: genesis.hash,
      },
      proof: [],
      resolveSigningPublicKey: signerMap(deviceId, signing.publicKey),
      operation: { type: "attach" as const, envelopeBytes: envelopeC },
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: deviceId,
      hostAuthorizationRevision: authorizationRevision(2),
      signingPrivateKey: signing.privateKey,
    };

    const prepared = prepareObjectAccessManifestUpdateV2(crypto, {
      ...common,
      currentEnvelopeBytes: reverse,
    });
    expect(prepared.manifest.envelopeHashes).toEqual(
      prepared.envelopeBytes.map((envelope) => crypto.hash(envelope)),
    );
    expect(() =>
      prepareObjectAccessManifestUpdateV2(crypto, {
        ...common,
        currentEnvelopeBytes: [envelopeA, envelopeA],
      })
    ).toThrow("duplicate Namespace envelope hash");
    expect(() =>
      prepareObjectAccessManifestUpdateV2(crypto, {
        ...common,
        currentEnvelopeBytes: ["not-bytes" as never],
      })
    ).toThrow();
    expect(() =>
      prepareObjectAccessManifestUpdateV2(crypto, {
        ...common,
        currentEnvelopeBytes: {
          length: 0,
          *[Symbol.iterator]() {},
        } as unknown as readonly Uint8Array[],
      })
    ).toThrow("must be an array");

    const expectedPreparedEnvelopes = prepared.envelopeBytes.map((envelope) =>
      envelope.slice()
    );
    reverse[0]![0] = reverse[0]![0]! ^ 0xff;
    envelopeC[0] = envelopeC[0]! ^ 0xff;
    expect(prepared.envelopeBytes).toEqual(expectedPreparedEnvelopes);
  });
});
