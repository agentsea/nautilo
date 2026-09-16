import { describe, expect, test } from "bun:test";

import {
  deriveAgentRuntimeObjectSignerPublicV1,
} from "../../src/agent-runtime/object-signer-v1.ts";
import type { AgentRuntimeGenerationV2 } from "../../src/agent-runtime/types.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  decodeObjectAccessStorageManifest,
} from "../../src/format/object-access-manifest.ts";
import {
  createAgentObjectAccessManifestV5,
  createHumanObjectAccessManifestV5,
  decodeObjectAccessManifestV5,
  encodeObjectAccessManifestV5,
  MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5,
  objectAccessManifestSigningBytesV5,
  verifyObjectAccessManifestChainV5,
  verifyObjectAccessManifestV5,
  type CreatedObjectAccessManifestV5,
  type ObjectAccessManifestUnsignedV5,
} from "../../src/format/object-access-manifest-v5.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  objectId,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

function hash(marker: number): Uint8Array {
  return new Uint8Array(32).fill(marker);
}

function fixture(seed = 26_340) {
  const crypto = new LatticeCrypto(seededRng(seed));
  const device = crypto.generateSigningKeyPair();
  const unsigned: ObjectAccessManifestUnsignedV5 = {
    objectId: objectId("memory-v5-adversarial"),
    payloadHash: hash(0x11),
    accessRevision: accessRevision(0),
    previousManifestHash: null,
    envelopeHashes: [hash(0x31), hash(0x32)],
    signer: {
      kind: "human_device",
      subjectHumanId: humanId("human-alice"),
      committerDeviceId: cryptoDeviceId("alice-device"),
    },
    signerAuthorizationHash: null,
    hostAuthorizationRevision: authorizationRevision(7),
  };
  const created = createHumanObjectAccessManifestV5(
    crypto,
    unsigned,
    device.privateKey,
  );
  const resolvers = {
    resolveHistoricalHumanDeviceSigningPublicKey: () => device.publicKey,
    resolveAgentRuntimeSignerPublicKey: () => null,
    resolveProcessorSignerAuthorizationBytes: () => null,
    resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
  } as const;
  return { crypto, device, unsigned, created, resolvers };
}

function chainInput(
  state: ReturnType<typeof fixture>,
  manifest: CreatedObjectAccessManifestV5 = state.created,
) {
  return {
    manifestBytes: manifest.bytes,
    proof: [] as Uint8Array[],
    trustedMinimumHead: {
      objectId: state.created.manifest.objectId,
      payloadHash: state.created.manifest.payloadHash,
      accessRevision: state.created.manifest.accessRevision,
      manifestHash: state.created.hash,
    },
    ...state.resolvers,
  };
}

describe("ObjectAccessManifestV5 adversarial boundaries", () => {
  test("dispatches canonical v5 storage manifests", () => {
    const state = fixture();
    expect(decodeObjectAccessStorageManifest(state.created.bytes))
      .toEqual(state.created.manifest);
  });

  test("enforces exact unsigned, signed, signer, hash, and inventory shapes", () => {
    const state = fixture();
    const encode = (value: unknown) =>
      encodeObjectAccessManifestV5(value as typeof state.created.manifest);
    for (const value of [null, [], () => undefined]) {
      expect(() => encode(value)).toThrow("must be an object");
    }
    expect(() => encode({ ...state.created.manifest, unexpected: true }))
      .toThrow("invalid field set");
    const { signature: _signature, ...missingSignature } = state.created.manifest;
    expect(() => encode(missingSignature)).toThrow("invalid field set");
    expect(() => encode({ ...state.created.manifest, formatVersion: 4 }))
      .toThrow("unsupported object access manifest version");
    expect(() => encode({ ...state.created.manifest, signature: hash(1) }))
      .toThrow("manifest signature must be exactly");

    expect(() => objectAccessManifestSigningBytesV5({
      ...state.unsigned,
      payloadHash: new Uint8Array(31),
    })).toThrow("payload hash must be exactly");
    expect(() => objectAccessManifestSigningBytesV5({
      ...state.unsigned,
      previousManifestHash: new Uint8Array(31),
    })).toThrow("previous manifest hash must be exactly");
    expect(() => objectAccessManifestSigningBytesV5({
      ...state.unsigned,
      envelopeHashes: null,
    } as never)).toThrow("envelope hashes must be an array");
    expect(() => objectAccessManifestSigningBytesV5({
      ...state.unsigned,
      envelopeHashes: [null],
    } as never)).toThrow("envelope hash must be exactly");
    expect(() => objectAccessManifestSigningBytesV5({
      ...state.unsigned,
      envelopeHashes: [hash(1), hash(1)],
    })).toThrow("duplicate envelope hash");
    expect(() => objectAccessManifestSigningBytesV5({
      ...state.unsigned,
      envelopeHashes: Array.from(
        { length: V2_LIMITS.namespaceEnvelopesPerManifest + 1 },
        (_, index) => new Uint8Array(32).fill(index),
      ),
    })).toThrow("manifest envelope count");

    for (const signer of [null, [], () => undefined]) {
      expect(() => objectAccessManifestSigningBytesV5({
        ...state.unsigned,
        signer,
      } as never)).toThrow("signer must be an object");
    }
    expect(() => objectAccessManifestSigningBytesV5({
      ...state.unsigned,
      signer: { ...state.unsigned.signer, unexpected: true },
    } as never)).toThrow("invalid field set");
    expect(() => objectAccessManifestSigningBytesV5({
      ...state.unsigned,
      signerAuthorizationHash: hash(2),
    })).toThrow("forbid");
  });

  test("enforces revision pairing and detaches every caller-owned byte field", () => {
    const state = fixture();
    expect(() => objectAccessManifestSigningBytesV5({
      ...state.unsigned,
      accessRevision: accessRevision(1),
    })).toThrow("later revisions require one");
    expect(() => objectAccessManifestSigningBytesV5({
      ...state.unsigned,
      previousManifestHash: hash(9),
    })).toThrow("revision zero requires no previous");

    const bytes = objectAccessManifestSigningBytesV5(state.unsigned);
    const payload = state.unsigned.payloadHash.slice();
    const envelopes = state.unsigned.envelopeHashes.map((value) => value.slice());
    state.unsigned.payloadHash.fill(0xff);
    state.unsigned.envelopeHashes.forEach((value) => value.fill(0xff));
    expect(bytes.length).toBeGreaterThan(0);
    expect(payload.every((byte) => byte === 0x11)).toBe(true);
    expect(envelopes.map((value) => Array.from(value))).toEqual([
      Array.from(hash(0x31)),
      Array.from(hash(0x32)),
    ]);
  });

  test("rejects non-byte, oversized, truncated, extended, and noncanonical wire", () => {
    const state = fixture();
    expect(() => decodeObjectAccessManifestV5(null as never))
      .toThrow("must be Uint8Array");
    expect(() => decodeObjectAccessManifestV5(
      new Uint8Array(MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5 + 1),
    )).toThrow("exceeds its wire limit");
    expect(() => decodeObjectAccessManifestV5(state.created.bytes.slice(0, -1)))
      .toThrow();
    expect(() => decodeObjectAccessManifestV5(
      new Uint8Array([...state.created.bytes, 0]),
    )).toThrow();
    const wrongDomain = state.created.bytes.slice();
    wrongDomain[4] = wrongDomain[4]! ^ 1;
    expect(() => decodeObjectAccessManifestV5(wrongDomain))
      .toThrow("domain mismatch");
  });

  test("accepts the largest canonical Human wire below the conservative ceiling", () => {
    const maximumId = `x${"a".repeat(V2_LIMITS.idBytes - 1)}`;
    const envelopeHashes = Array.from(
      { length: V2_LIMITS.namespaceEnvelopesPerManifest },
      (_, index) => {
        const value = new Uint8Array(32);
        value[0] = index;
        return value;
      },
    );
    const bytes = encodeObjectAccessManifestV5({
      formatVersion: 5,
      objectId: objectId(maximumId),
      payloadHash: hash(1),
      accessRevision: accessRevision(1),
      previousManifestHash: hash(2),
      envelopeHashes,
      signer: {
        kind: "human_device",
        subjectHumanId: humanId(maximumId),
        committerDeviceId: cryptoDeviceId(maximumId),
      },
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(1),
      signature: new Uint8Array(V2_LIMITS.signatureBytes),
    });
    expect(bytes.length).toBeLessThan(MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5);
    expect(decodeObjectAccessManifestV5(bytes)).toMatchObject({
      objectId: maximumId,
      envelopeHashes,
    });
  });

  test("fails closed for unavailable, malformed, wrong, and mismatched Human keys", () => {
    const state = fixture();
    const verify = (resolved: unknown) => verifyObjectAccessManifestV5(
      state.crypto,
      {
        ...state.resolvers,
        manifestBytes: state.created.bytes,
        resolveHistoricalHumanDeviceSigningPublicKey: () => resolved as never,
      },
    );
    expect(() => verify(null)).toThrow("public key must be exactly");
    expect(() => verify(new Uint8Array(31))).toThrow("public key must be exactly");
    expect(() => verify(state.crypto.generateSigningKeyPair().publicKey))
      .toThrow("signature is invalid");
    expect(() => verifyObjectAccessManifestV5(state.crypto, {
      ...state.resolvers,
      manifestBytes: null as never,
    })).toThrow("bytes must be Uint8Array");
    expect(() => verifyObjectAccessManifestV5(state.crypto, {
      ...state.resolvers,
      manifestBytes: new Uint8Array(MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5 + 1),
    })).toThrow("exceeds its wire limit");
  });

  test("fails closed for Agent signer kind, Runtime identity, key id, and signature", () => {
    const state = fixture();
    const runtime: AgentRuntimeGenerationV2 = {
      agentId: agentId("agent-adversarial"),
      keyClass: "runtime",
      generation: agentRuntimeGeneration(2),
      key: hash(0x51),
    };
    const signer = deriveAgentRuntimeObjectSignerPublicV1(state.crypto, runtime);
    const created = createAgentObjectAccessManifestV5(state.crypto, {
      ...state.unsigned,
      signer: signer.principal,
    }, runtime);
    const verify = (key: Uint8Array | null) => verifyObjectAccessManifestV5(
      state.crypto,
      {
        ...state.resolvers,
        manifestBytes: created.bytes,
        resolveHistoricalHumanDeviceSigningPublicKey: () => null,
        resolveAgentRuntimeSignerPublicKey: () => key,
      },
    );
    expect(() => verify(null)).toThrow("public key must be exactly");
    expect(() => verify(new Uint8Array(31))).toThrow("public key must be exactly");
    expect(() => verify(state.crypto.generateSigningKeyPair().publicKey))
      .toThrow("key id does not match");
    expect(() => createAgentObjectAccessManifestV5(state.crypto, {
      ...state.unsigned,
      signer: state.unsigned.signer,
    }, runtime)).toThrow("requires an Agent Runtime signer");
    expect(() => createHumanObjectAccessManifestV5(state.crypto, {
      ...state.unsigned,
      signer: signer.principal,
    }, state.device.privateKey)).toThrow("requires a Human device signer");
  });

  test("rejects every trusted-head shape, identity, rollback, and same-revision fork", () => {
    const state = fixture();
    const base = chainInput(state);
    expect(() => verifyObjectAccessManifestChainV5(state.crypto, {
      ...base,
      proof: null,
    } as never)).toThrow("proof must be an array");
    for (const head of [null, [], () => undefined]) {
      expect(() => verifyObjectAccessManifestChainV5(state.crypto, {
        ...base,
        trustedMinimumHead: head,
      } as never)).toThrow("head must be an object");
    }
    expect(() => verifyObjectAccessManifestChainV5(state.crypto, {
      ...base,
      trustedMinimumHead: { ...base.trustedMinimumHead, unexpected: true },
    } as never)).toThrow("invalid field set");
    expect(() => verifyObjectAccessManifestChainV5(state.crypto, {
      ...base,
      trustedMinimumHead: {
        ...base.trustedMinimumHead,
        manifestHash: new Uint8Array(31),
      },
    })).toThrow("trusted manifest hash must be exactly");
    expect(() => verifyObjectAccessManifestChainV5(state.crypto, {
      ...base,
      trustedMinimumHead: {
        ...base.trustedMinimumHead,
        objectId: objectId("memory-other"),
      },
    })).toThrow("object mismatch");
    expect(() => verifyObjectAccessManifestChainV5(state.crypto, {
      ...base,
      trustedMinimumHead: {
        ...base.trustedMinimumHead,
        payloadHash: hash(0xfe),
      },
    })).toThrow("payload mismatch");
    expect(() => verifyObjectAccessManifestChainV5(state.crypto, {
      ...base,
      proof: [state.created.bytes],
    })).toThrow("same-revision object access proof must be empty");
    expect(() => verifyObjectAccessManifestChainV5(state.crypto, {
      ...base,
      trustedMinimumHead: {
        ...base.trustedMinimumHead,
        manifestHash: hash(0xfd),
      },
    })).toThrow("changed at the same revision");
  });

  test("rejects skipped revisions, wrong predecessor hashes, and rollback", () => {
    const state = fixture(26_341);
    const revisionOne = createHumanObjectAccessManifestV5(state.crypto, {
      ...state.unsigned,
      accessRevision: accessRevision(1),
      previousManifestHash: state.created.hash,
    }, state.device.privateKey);
    const revisionTwo = createHumanObjectAccessManifestV5(state.crypto, {
      ...state.unsigned,
      accessRevision: accessRevision(2),
      previousManifestHash: revisionOne.hash,
    }, state.device.privateKey);
    const skippedWithMatchingPredecessor = createHumanObjectAccessManifestV5(
      state.crypto,
      {
        ...state.unsigned,
        accessRevision: accessRevision(2),
        previousManifestHash: state.created.hash,
      },
      state.device.privateKey,
    );
    const nextWithWrongPredecessor = createHumanObjectAccessManifestV5(
      state.crypto,
      {
        ...state.unsigned,
        accessRevision: accessRevision(1),
        previousManifestHash: hash(0xfe),
      },
      state.device.privateKey,
    );
    expect(() => verifyObjectAccessManifestChainV5(state.crypto, {
      ...chainInput(state, revisionTwo),
      proof: [],
    })).toThrow("fork or broken hash chain");
    expect(() => verifyObjectAccessManifestChainV5(state.crypto, {
      ...chainInput(state, skippedWithMatchingPredecessor),
      proof: [],
    })).toThrow("fork or broken hash chain");
    expect(() => verifyObjectAccessManifestChainV5(state.crypto, {
      ...chainInput(state, nextWithWrongPredecessor),
      proof: [],
    })).toThrow("fork or broken hash chain");
    expect(() => verifyObjectAccessManifestChainV5(state.crypto, {
      ...chainInput(state, revisionTwo),
      proof: [revisionOne.bytes],
    })).not.toThrow();
    expect(() => verifyObjectAccessManifestChainV5(state.crypto, {
      ...chainInput(state),
      trustedMinimumHead: {
        ...chainInput(state).trustedMinimumHead,
        accessRevision: accessRevision(1),
      },
    })).toThrow("rollback below trusted minimum");
  });

  test("validates crypto output lengths and wipes owned signing buffers", () => {
    const state = fixture(26_342);
    const originalSign = state.crypto.sign.bind(state.crypto);
    const signCalls: Uint8Array[][] = [];
    state.crypto.sign = (key, message) => {
      signCalls.push([key, message]);
      return originalSign(key, message);
    };
    createHumanObjectAccessManifestV5(
      state.crypto,
      state.unsigned,
      state.device.privateKey,
    );
    expect(signCalls.at(-1)!.every((bytes) =>
      bytes.every((byte) => byte === 0)
    )).toBe(true);

    state.crypto.sign = () => new Uint8Array(63);
    expect(() => createHumanObjectAccessManifestV5(
      state.crypto,
      state.unsigned,
      state.device.privateKey,
    )).toThrow("manifest signature must be exactly");
    state.crypto.sign = originalSign;
    const originalHash = state.crypto.hash.bind(state.crypto);
    state.crypto.hash = () => new Uint8Array(31);
    expect(() => createHumanObjectAccessManifestV5(
      state.crypto,
      state.unsigned,
      state.device.privateKey,
    )).toThrow("manifest hash must be exactly");
    state.crypto.hash = originalHash;
  });
});
