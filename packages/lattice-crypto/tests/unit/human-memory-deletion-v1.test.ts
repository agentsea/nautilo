import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  createObjectAccessManifestV2,
  decodeObjectAccessManifestV2,
} from "../../src/format/object-access-manifest-v2.ts";
import {
  NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2,
  encodeNamespaceObjectEnvelopeV2,
} from "../../src/format/object-v2.ts";
import {
  assertAuthenticPreparedHumanMemoryDeletionV1,
  prepareHumanMemoryDeletionV1,
} from "../../src/memory/deletion-v1.ts";
import {
  prepareObjectAccessManifestGenesisV2,
  prepareObjectAccessManifestUpdateV2,
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

function envelope(
  crypto: LatticeCrypto,
  namespace: string,
  marker: number,
): Uint8Array {
  return encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespaceV2(
    crypto,
    new Uint8Array(32).fill(marker),
    {
      objectId: objectId("memory:v1:deletion-object"),
      namespaceId: namespaceId(namespace),
      keyClass: "human",
      keyGeneration: namespaceGeneration(0),
      bindingRevisionAtWrap: accessRevision(0),
    },
    new Uint8Array(32).fill(marker + 1),
  ));
}

function fixture() {
  const crypto = new LatticeCrypto(seededRng(0x243_17));
  const signer = crypto.generateSigningKeyPair();
  const currentEnvelopeBytes = [
    envelope(crypto, "namespace-a", 0x21),
    envelope(crypto, "namespace-b", 0x31),
  ];
  const genesis = prepareObjectAccessManifestGenesisV2(crypto, {
    objectId: objectId("memory:v1:deletion-object"),
    payloadHash: new Uint8Array(32).fill(0x41),
    envelopeBytes: currentEnvelopeBytes,
    sourceAuthorized: true,
    targetAuthorized: true,
    committerDeviceId: cryptoDeviceId("device-alice-1"),
    hostAuthorizationRevision: authorizationRevision(7),
    signingPrivateKey: signer.privateKey,
  });
  return {
    crypto,
    signer,
    genesis,
    input: {
      currentManifestBytes: genesis.manifestBytes,
      currentEnvelopeBytes,
      trustedMinimumHead: {
        objectId: genesis.manifest.objectId,
        payloadHash: genesis.manifest.payloadHash,
        accessRevision: genesis.manifest.accessRevision,
        manifestHash: genesis.manifestHash,
      },
      proof: [],
      resolveSigningPublicKey: (id: string) =>
        id === "device-alice-1" ? signer.publicKey : null,
      sourceAuthorized: true,
      committerDeviceId: cryptoDeviceId("device-alice-1"),
      hostAuthorizationRevision: authorizationRevision(7),
      committerSigningPublicKey: signer.publicKey,
      committerSigningPrivateKey: signer.privateKey,
    },
  };
}

function aggregateFixture(aggregateEnvelopeBytes: number) {
  const crypto = new LatticeCrypto(seededRng(0x243_18));
  const signer = crypto.generateSigningKeyPair();
  const targetObjectId = objectId("memory:v1:deletion-object");
  const minimumEnvelopes = Array.from(
    { length: V2_LIMITS.namespaceEnvelopesPerManifest },
    (_, index) => encodeNamespaceObjectEnvelopeV2({
      formatVersion: NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2,
      context: {
        objectId: targetObjectId,
        namespaceId: namespaceId(
          `namespace-${String(index).padStart(3, "0")}`,
        ),
        keyClass: "human",
        keyGeneration: namespaceGeneration(0),
        bindingRevisionAtWrap: accessRevision(0),
      },
      wrappedDek: new Uint8Array(40).fill(index),
    }),
  );
  let remaining = aggregateEnvelopeBytes - minimumEnvelopes.reduce(
    (total, bytes) => total + bytes.length,
    0,
  );
  if (remaining < 0) throw new Error("aggregate fixture is below minimum");
  const currentEnvelopeBytes = minimumEnvelopes.map((_, index) => {
    const extra = Math.min(remaining, V2_LIMITS.wrappedDekBytes - 40);
    remaining -= extra;
    return encodeNamespaceObjectEnvelopeV2({
      formatVersion: NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2,
      context: {
        objectId: targetObjectId,
        namespaceId: namespaceId(
          `namespace-${String(index).padStart(3, "0")}`,
        ),
        keyClass: "human",
        keyGeneration: namespaceGeneration(0),
        bindingRevisionAtWrap: accessRevision(0),
      },
      wrappedDek: new Uint8Array(40 + extra).fill(index),
    });
  });
  if (remaining !== 0) throw new Error("aggregate fixture exceeds capacity");
  const envelopeHashes = currentEnvelopeBytes.map((bytes) =>
    crypto.hash(bytes)
  ).sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right))
  );
  const genesis = createObjectAccessManifestV2(crypto, {
    objectId: targetObjectId,
    payloadHash: new Uint8Array(32).fill(0x41),
    accessRevision: accessRevision(0),
    previousManifestHash: null,
    envelopeHashes,
    committerDeviceId: cryptoDeviceId("device-alice-1"),
    hostAuthorizationRevision: authorizationRevision(7),
  }, signer.privateKey);
  return {
    crypto,
    input: {
      currentManifestBytes: genesis.bytes,
      currentEnvelopeBytes,
      trustedMinimumHead: {
        objectId: genesis.manifest.objectId,
        payloadHash: genesis.manifest.payloadHash,
        accessRevision: genesis.manifest.accessRevision,
        manifestHash: genesis.hash,
      },
      proof: [],
      resolveSigningPublicKey: () => signer.publicKey,
      sourceAuthorized: true,
      committerDeviceId: cryptoDeviceId("device-alice-1"),
      hostAuthorizationRevision: authorizationRevision(7),
      committerSigningPublicKey: signer.publicKey,
      committerSigningPrivateKey: signer.privateKey,
    },
  };
}

describe("on-demand Human Memory deletion", () => {
  test("signs the next chained empty-envelope access revision", () => {
    const state = fixture();
    const prepared = prepareHumanMemoryDeletionV1(state.crypto, state.input);
    expect(() => assertAuthenticPreparedHumanMemoryDeletionV1(prepared))
      .not.toThrow();
    const manifest = decodeObjectAccessManifestV2(prepared.manifestBytes);
    expect(manifest.accessRevision).toBe(accessRevision(1));
    expect(manifest.previousManifestHash).toEqual(
      state.genesis.manifestHash,
    );
    expect(manifest.payloadHash).toEqual(state.genesis.manifest.payloadHash);
    expect(manifest.envelopeHashes).toEqual([]);
    prepared.manifestHash[0] = prepared.manifestHash[0]! ^ 1;
    expect(() => assertAuthenticPreparedHumanMemoryDeletionV1(prepared))
      .toThrow("authentic prepared empty-envelope manifest");
  });

  test("appends deletion after an arbitrary current access revision", () => {
    const state = fixture();
    const resolver = state.input.resolveSigningPublicKey;
    const first = prepareObjectAccessManifestUpdateV2(state.crypto, {
      currentManifestBytes: state.genesis.manifestBytes,
      currentEnvelopeBytes: state.input.currentEnvelopeBytes,
      trustedMinimumHead: state.input.trustedMinimumHead,
      proof: [],
      resolveSigningPublicKey: resolver,
      operation: {
        type: "detach",
        envelopeBytes: state.input.currentEnvelopeBytes[1]!,
      },
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: cryptoDeviceId("device-alice-1"),
      hostAuthorizationRevision: authorizationRevision(8),
      signingPrivateKey: state.signer.privateKey,
    });
    const second = prepareObjectAccessManifestUpdateV2(state.crypto, {
      currentManifestBytes: first.manifestBytes,
      currentEnvelopeBytes: first.envelopeBytes,
      trustedMinimumHead: {
        objectId: first.manifest.objectId,
        payloadHash: first.manifest.payloadHash,
        accessRevision: first.manifest.accessRevision,
        manifestHash: first.manifestHash,
      },
      proof: [],
      resolveSigningPublicKey: resolver,
      operation: {
        type: "attach",
        envelopeBytes: state.input.currentEnvelopeBytes[1]!,
      },
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: cryptoDeviceId("device-alice-1"),
      hostAuthorizationRevision: authorizationRevision(9),
      signingPrivateKey: state.signer.privateKey,
    });
    const prepared = prepareHumanMemoryDeletionV1(state.crypto, {
      ...state.input,
      currentManifestBytes: second.manifestBytes,
      currentEnvelopeBytes: second.envelopeBytes,
      trustedMinimumHead: {
        objectId: second.manifest.objectId,
        payloadHash: second.manifest.payloadHash,
        accessRevision: second.manifest.accessRevision,
        manifestHash: second.manifestHash,
      },
      hostAuthorizationRevision: authorizationRevision(10),
    });
    expect(prepared.manifest.accessRevision).toBe(accessRevision(3));
    expect(prepared.manifest.previousManifestHash).toEqual(second.manifestHash);
  });

  test("rejects stale authority, inexact current envelopes, and wrong keys", () => {
    const state = fixture();
    expect(() => prepareHumanMemoryDeletionV1(state.crypto, {
      ...state.input,
      sourceAuthorized: false,
    })).toThrow("live source authority");
    expect(() => prepareHumanMemoryDeletionV1(state.crypto, {
      ...state.input,
      currentEnvelopeBytes: state.input.currentEnvelopeBytes.slice(1),
    })).toThrow("inventory is inexact");
    const other = state.crypto.generateSigningKeyPair();
    expect(() => prepareHumanMemoryDeletionV1(state.crypto, {
      ...state.input,
      committerSigningPrivateKey: other.privateKey,
    })).toThrow("signing keys do not match");
  });

  test("rejects malformed, empty, oversized, and cross-object envelope inventories", () => {
    const state = fixture();
    for (const currentEnvelopeBytes of [
      null,
      [],
      ["not-bytes"],
      [new Uint8Array(V2_LIMITS.manifestEnvelopeBytes + 1)],
    ]) {
      expect(() => prepareHumanMemoryDeletionV1(state.crypto, {
        ...state.input,
        currentEnvelopeBytes,
      } as never)).toThrow();
    }

    const otherObjectEnvelope = encodeNamespaceObjectEnvelopeV2(
      wrapObjectDekForNamespaceV2(
        state.crypto,
        new Uint8Array(32).fill(0x51),
        {
          objectId: objectId("memory:v1:other-object"),
          namespaceId: namespaceId("namespace-a"),
          keyClass: "human",
          keyGeneration: namespaceGeneration(0),
          bindingRevisionAtWrap: accessRevision(0),
        },
        new Uint8Array(32).fill(0x52),
      ),
    );
    expect(() => prepareHumanMemoryDeletionV1(state.crypto, {
      ...state.input,
      currentEnvelopeBytes: [
        otherObjectEnvelope,
        state.input.currentEnvelopeBytes[1]!,
      ],
    })).toThrow("envelope is inexact");

    const noncanonical = Uint8Array.from([
      ...state.input.currentEnvelopeBytes[0]!,
      0,
    ]);
    expect(() => prepareHumanMemoryDeletionV1(state.crypto, {
      ...state.input,
      currentEnvelopeBytes: [
        noncanonical,
        state.input.currentEnvelopeBytes[1]!,
      ],
    })).toThrow();
  });

  test("requires exact signing keys and an untampered prepared result", () => {
    const state = fixture();
    for (const patch of [
      { committerSigningPublicKey: state.signer.publicKey.slice(1) },
      { committerSigningPrivateKey: state.signer.privateKey.slice(1) },
    ]) {
      expect(() => prepareHumanMemoryDeletionV1(state.crypto, {
        ...state.input,
        ...patch,
      })).toThrow("exactly");
    }
    expect(() => assertAuthenticPreparedHumanMemoryDeletionV1({
      manifest: state.genesis.manifest,
      manifestBytes: state.genesis.manifestBytes,
      manifestHash: state.genesis.manifestHash,
    })).toThrow("authentic prepared empty-envelope manifest");

    const prepared = prepareHumanMemoryDeletionV1(state.crypto, state.input);
    prepared.manifestBytes[0] = prepared.manifestBytes[0]! ^ 1;
    expect(() => assertAuthenticPreparedHumanMemoryDeletionV1(prepared))
      .toThrow("authentic prepared empty-envelope manifest");
  });

  test("rejects a same-size inventory with only one substituted envelope", () => {
    const state = fixture();
    const substituted = envelope(state.crypto, "namespace-c", 0x61);
    expect(() => prepareHumanMemoryDeletionV1(state.crypto, {
      ...state.input,
      currentEnvelopeBytes: [
        state.input.currentEnvelopeBytes[0]!,
        substituted,
      ],
    })).toThrow("inventory is inexact");
  });

  test("wipes deletion signing buffers exposed to crypto", () => {
    const state = fixture();
    const signingCalls: Uint8Array[][] = [];
    const verificationCalls: Uint8Array[][] = [];
    const originalSign = state.crypto.sign.bind(state.crypto);
    const originalVerify = state.crypto.verify.bind(state.crypto);
    state.crypto.sign = (privateKey, message) => {
      signingCalls.push([privateKey, message]);
      return originalSign(privateKey, message);
    };
    state.crypto.verify = (publicKey, message, signature) => {
      verificationCalls.push([publicKey, message]);
      return originalVerify(publicKey, message, signature);
    };
    prepareHumanMemoryDeletionV1(state.crypto, state.input);
    const observed = [
      signingCalls.at(-1)![0]!,
      ...verificationCalls.at(-1)!,
    ];
    expect(observed.map((buffer) => buffer.every((byte) => byte === 0)))
      .toEqual([true, true, true]);
  });

  test("accepts the inclusive aggregate ceiling and rejects one byte above it", () => {
    const exact = aggregateFixture(V2_LIMITS.manifestEnvelopeBytes);
    expect(() => prepareHumanMemoryDeletionV1(exact.crypto, exact.input))
      .not.toThrow();
    const oversized = aggregateFixture(V2_LIMITS.manifestEnvelopeBytes + 1);
    expect(() => prepareHumanMemoryDeletionV1(
      oversized.crypto,
      oversized.input,
    )).toThrow("envelope bytes exceed limit");
  });
});
