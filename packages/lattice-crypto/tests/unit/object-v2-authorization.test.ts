import { describe, expect, test } from "bun:test";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  createObjectAccessManifestV2,
} from "../../src/format/object-access-manifest-v2.ts";
import {
  encodeNamespaceObjectEnvelopeV2,
} from "../../src/format/object-v2.ts";
import {
  createNamespaceBinding,
  namespaceBindingHash,
  verifyNamespaceBindingProof,
} from "../../src/namespace/bindings.ts";
import {
  createInitialNamespaceKeyrings,
  openNamespaceKeyring,
  resealNamespaceKeyring,
  sealNamespaceKeyring,
} from "../../src/namespace/keyrings.ts";
import type {
  NamespaceKeyringPlaintextV2,
  VerifiedNamespaceBindingHeadV2,
} from "../../src/namespace/types.ts";
import {
  prepareObjectAccessManifestUpdateV2,
  verifyObjectAccessManifestChainV2,
  type VerifiedObjectAccessManifestV2,
} from "../../src/object/access-manifest.ts";
import {
  resolveAuthorizedNamespaceObjectKeyV2,
} from "../../src/object/authorization.ts";
import {
  openObjectDekForNamespaceV2,
  wrapObjectDekForNamespaceV2,
} from "../../src/object/namespace-envelope.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  namespaceGeneration,
  namespaceId,
  objectId,
} from "../../src/v2-types/ids.ts";

function bytes(value: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function setup() {
  const crypto = new LatticeCrypto(seededRng(0x0b1ec7));
  const signing = crypto.generateSigningKeyPair();
  const deviceId = cryptoDeviceId("device_alice");
  const targetNamespaceId = namespaceId("namespace_room");
  const targetObjectId = objectId("object_message");
  const oldHumanRoot = bytes(0x31);
  const oldAiRoot = bytes(0x41);
  const newHumanRoot = bytes(0x32);
  const newAiRoot = bytes(0x42);
  const initial = createInitialNamespaceKeyrings(
    crypto,
    targetNamespaceId,
  );
  const common0 = {
    domainId: cryptoDomainId("domain_ab"),
    domainEpoch: domainEpoch(1),
    previousBindingHash: null,
    committerDeviceId: deviceId,
  };
  const humanEnvelope0 = sealNamespaceKeyring({
    crypto,
    domainRoot: oldHumanRoot,
    keyring: initial.human,
    metadata: common0,
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: () => signing.publicKey,
  });
  const aiEnvelope0 = sealNamespaceKeyring({
    crypto,
    domainRoot: oldAiRoot,
    keyring: initial.ai,
    metadata: common0,
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: () => signing.publicKey,
  });
  const binding0 = createNamespaceBinding({
    crypto,
    humanEnvelope: humanEnvelope0,
    aiEnvelope: aiEnvelope0,
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: () => signing.publicKey,
  });
  const bindingHash0 = namespaceBindingHash(binding0);

  const dek = bytes(0xd0);
  const historicalEnvelope = wrapObjectDekForNamespaceV2(
    crypto,
    initial.human.generations[0]!.key,
    {
      objectId: targetObjectId,
      namespaceId: targetNamespaceId,
      keyClass: "human",
      keyGeneration: namespaceGeneration(0),
      bindingRevisionAtWrap: accessRevision(0),
    },
    dek,
  );
  const historicalEnvelopeBytes = encodeNamespaceObjectEnvelopeV2(
    historicalEnvelope,
  );
  const payloadHash = bytes(0x55);
  const manifest0 = createObjectAccessManifestV2(
    crypto,
    {
      objectId: targetObjectId,
      payloadHash,
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [crypto.hash(historicalEnvelopeBytes)],
      committerDeviceId: deviceId,
      hostAuthorizationRevision: authorizationRevision(1),
    },
    signing.privateKey,
  );
  const verifiedManifest = verifyObjectAccessManifestChainV2(crypto, {
    manifestBytes: manifest0.bytes,
    proof: [],
    trustedMinimumHead: {
      objectId: targetObjectId,
      payloadHash,
      accessRevision: accessRevision(0),
      manifestHash: manifest0.hash,
    },
    resolveSigningPublicKey: () => signing.publicKey,
  });

  const common1 = {
    domainId: cryptoDomainId("domain_abc"),
    domainEpoch: domainEpoch(1),
    accessRevision: accessRevision(1),
    previousBindingHash: bindingHash0,
    committerDeviceId: deviceId,
  };
  const humanEnvelope1 = resealNamespaceKeyring({
    crypto,
    oldDomainRoot: oldHumanRoot,
    oldEnvelope: humanEnvelope0,
    resolveHistoricalCommitter: () => signing.publicKey,
    newDomainRoot: newHumanRoot,
    newMetadata: common1,
    newCommitterSigningPrivateKey: signing.privateKey,
    resolveSourceCommitter: () => signing.publicKey,
    resolveCurrentCommitter: () => signing.publicKey,
    rotateGeneration: true,
  });
  const aiEnvelope1 = resealNamespaceKeyring({
    crypto,
    oldDomainRoot: oldAiRoot,
    oldEnvelope: aiEnvelope0,
    resolveHistoricalCommitter: () => signing.publicKey,
    newDomainRoot: newAiRoot,
    newMetadata: common1,
    newCommitterSigningPrivateKey: signing.privateKey,
    resolveSourceCommitter: () => signing.publicKey,
    resolveCurrentCommitter: () => signing.publicKey,
    rotateGeneration: true,
  });
  const binding1 = createNamespaceBinding({
    crypto,
    humanEnvelope: humanEnvelope1,
    aiEnvelope: aiEnvelope1,
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: () => signing.publicKey,
  });
  const trustedHead = verifyNamespaceBindingProof({
    crypto,
    anchor: {
      namespaceId: targetNamespaceId,
      accessRevision: accessRevision(0),
      bindingHash: bindingHash0,
    },
    proof: [binding0, binding1],
    resolveHistoricalCommitter: () => signing.publicKey,
  });
  const currentKeyring = openNamespaceKeyring({
    crypto,
    domainRoot: newHumanRoot,
    envelope: humanEnvelope1,
    resolveHistoricalCommitter: () => signing.publicKey,
  });
  const expected = {
    objectId: targetObjectId,
    namespaceId: targetNamespaceId,
    keyClass: "human" as const,
  };
  const resolve = (
    overrides: Partial<Parameters<
      typeof resolveAuthorizedNamespaceObjectKeyV2
    >[0]> = {},
  ) =>
    resolveAuthorizedNamespaceObjectKeyV2({
      crypto,
      verifiedManifest,
      envelopeBytes: historicalEnvelopeBytes,
      trustedNamespaceHead: trustedHead,
      currentKeyringEnvelope: humanEnvelope1,
      currentDomainRoot: newHumanRoot,
      resolveHistoricalCommitter: () => signing.publicKey,
      expected,
      ...overrides,
    });

  return {
    crypto,
    signing,
    deviceId,
    targetNamespaceId,
    targetObjectId,
    initial,
    binding0,
    binding1,
    bindingHash0,
    trustedHead,
    currentKeyring,
    newAiRoot,
    humanEnvelope1,
    aiEnvelope1,
    expected,
    historicalEnvelope,
    historicalEnvelopeBytes,
    dek,
    payloadHash,
    manifest0,
    verifiedManifest,
    resolve,
  };
}

describe("trusted Namespace/object authorization composition", () => {
  test("returns only a detached historical key after a valid Domain rebind", () => {
    const scenario = setup();
    const zeroizedKeys: Array<{
      readonly before: Uint8Array;
      readonly target: Uint8Array;
    }> = [];
    const originalFill = Uint8Array.prototype.fill;
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      const before = this.slice();
      const result = originalFill.call(this, value, start, end);
      if (value === 0 && this.length === 32) {
        zeroizedKeys.push({ before, target: this });
      }
      return result;
    };
    let key: Uint8Array;
    try {
      key = scenario.resolve();
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }

    expect(key).toEqual(scenario.initial.human.generations[0]!.key);
    expect(key).not.toBe(scenario.initial.human.generations[0]!.key);
    for (const generation of scenario.currentKeyring.generations) {
      expect(
        zeroizedKeys.filter(({ before }) =>
          before.every((byte, index) => byte === generation.key[index])
        ),
      ).toHaveLength(2);
    }
    expect(zeroizedKeys.map(({ target }) => target)).not.toContain(key);
    expect(
      zeroizedKeys.every(({ target }) =>
        target.every((byte) => byte === 0)
      ),
    ).toBe(true);
    expect(
      openObjectDekForNamespaceV2(
        scenario.crypto,
        key,
        scenario.historicalEnvelope,
      ),
    ).toEqual(scenario.dek);
    expect(String(scenario.binding0.domainId)).toBe("domain_ab");
    expect(String(scenario.binding1.domainId)).toBe("domain_abc");
    expect(
      Number(scenario.historicalEnvelope.context.bindingRevisionAtWrap),
    ).toBe(0);

    key[0] = key[0]! ^ 0xff;
    expect(key).not.toEqual(scenario.initial.human.generations[0]!.key);
  });

  test("requires exact object, Namespace, and immutable key-class identity", () => {
    const scenario = setup();
    expect(() =>
      scenario.resolve({ expected: null as never })
    ).toThrow("expected object authorization identity is required");
    expect(() =>
      scenario.resolve({ expected: "object" as never })
    ).toThrow("expected object authorization identity is required");
    expect(() =>
      scenario.resolve({
        expected: { ...scenario.expected, keyClass: "management" as never },
      })
    ).toThrow("object key class must be human or ai");
    expect(() =>
      scenario.resolve({
        expected: {
          ...scenario.expected,
          objectId: objectId("object_other"),
        },
      })
    ).toThrow("object");
    expect(() =>
      scenario.resolve({
        expected: {
          ...scenario.expected,
          namespaceId: namespaceId("namespace_other"),
        },
      })
    ).toThrow("Namespace");
    expect(() =>
      scenario.resolve({
        expected: { ...scenario.expected, keyClass: "ai" },
      })
    ).toThrow("key class");
  });

  test("selects and opens the AI keyring only for an exact AI envelope identity", () => {
    const scenario = setup();
    const aiDek = bytes(0xa1);
    const aiEnvelope = wrapObjectDekForNamespaceV2(
      scenario.crypto,
      scenario.initial.ai.generations[0]!.key,
      {
        objectId: scenario.targetObjectId,
        namespaceId: scenario.targetNamespaceId,
        keyClass: "ai",
        keyGeneration: namespaceGeneration(0),
        bindingRevisionAtWrap: accessRevision(0),
      },
      aiDek,
    );
    const aiEnvelopeBytes = encodeNamespaceObjectEnvelopeV2(aiEnvelope);
    const aiManifest = createObjectAccessManifestV2(
      scenario.crypto,
      {
        ...scenario.manifest0.manifest,
        envelopeHashes: [scenario.crypto.hash(aiEnvelopeBytes)],
      },
      scenario.signing.privateKey,
    );
    const verifiedAiManifest = verifyObjectAccessManifestChainV2(
      scenario.crypto,
      {
        manifestBytes: aiManifest.bytes,
        proof: [],
        trustedMinimumHead: {
          objectId: scenario.targetObjectId,
          payloadHash: scenario.payloadHash,
          accessRevision: accessRevision(0),
          manifestHash: aiManifest.hash,
        },
        resolveSigningPublicKey: () => scenario.signing.publicKey,
      },
    );

    const key = scenario.resolve({
      verifiedManifest: verifiedAiManifest,
      envelopeBytes: aiEnvelopeBytes,
      currentKeyringEnvelope: scenario.aiEnvelope1,
      currentDomainRoot: scenario.newAiRoot,
      expected: { ...scenario.expected, keyClass: "ai" },
    });
    expect(key).toEqual(scenario.initial.ai.generations[0]!.key);
    expect(
      openObjectDekForNamespaceV2(scenario.crypto, key, aiEnvelope),
    ).toEqual(aiDek);
  });

  test("rejects future binding revisions and a wrong or internally inconsistent trusted head", () => {
    const scenario = setup();
    const currentEnvelope = wrapObjectDekForNamespaceV2(
      scenario.crypto,
      scenario.currentKeyring.generations[1]!.key,
      {
        objectId: scenario.targetObjectId,
        namespaceId: scenario.targetNamespaceId,
        keyClass: "human",
        keyGeneration: namespaceGeneration(1),
        bindingRevisionAtWrap: accessRevision(1),
      },
      bytes(0xd1),
    );
    const currentEnvelopeBytes = encodeNamespaceObjectEnvelopeV2(
      currentEnvelope,
    );
    const currentManifest = createObjectAccessManifestV2(
      scenario.crypto,
      {
        ...scenario.manifest0.manifest,
        envelopeHashes: [scenario.crypto.hash(currentEnvelopeBytes)],
      },
      scenario.signing.privateKey,
    );
    const verifiedCurrent = verifyObjectAccessManifestChainV2(
      scenario.crypto,
      {
        manifestBytes: currentManifest.bytes,
        proof: [],
        trustedMinimumHead: {
          objectId: scenario.targetObjectId,
          payloadHash: scenario.payloadHash,
          accessRevision: accessRevision(0),
          manifestHash: currentManifest.hash,
        },
        resolveSigningPublicKey: () => scenario.signing.publicKey,
      },
    );
    expect(() =>
      scenario.resolve({
        verifiedManifest: verifiedCurrent,
        envelopeBytes: currentEnvelopeBytes,
      })
    ).not.toThrow();

    const futureEnvelopeBytes = encodeNamespaceObjectEnvelopeV2({
      ...scenario.historicalEnvelope,
      context: {
        ...scenario.historicalEnvelope.context,
        bindingRevisionAtWrap: accessRevision(2),
      },
    });
    const futureManifest = createObjectAccessManifestV2(
      scenario.crypto,
      {
        ...scenario.manifest0.manifest,
        envelopeHashes: [scenario.crypto.hash(futureEnvelopeBytes)],
      },
      scenario.signing.privateKey,
    );
    const verifiedFuture = verifyObjectAccessManifestChainV2(
      scenario.crypto,
      {
        manifestBytes: futureManifest.bytes,
        proof: [],
        trustedMinimumHead: {
          objectId: scenario.targetObjectId,
          payloadHash: scenario.payloadHash,
          accessRevision: accessRevision(0),
          manifestHash: futureManifest.hash,
        },
        resolveSigningPublicKey: () => scenario.signing.publicKey,
      },
    );
    expect(() =>
      scenario.resolve({
        verifiedManifest: verifiedFuture,
        envelopeBytes: futureEnvelopeBytes,
      })
    ).toThrow("future");

    expect(() =>
      scenario.resolve({
        trustedNamespaceHead: {
          ...scenario.trustedHead,
          bindingHash: bytes(0xff),
        },
      })
    ).toThrow("proof-verifier capability");
    expect(() =>
      scenario.resolve({ trustedNamespaceHead: null as never })
    ).toThrow("trusted Namespace head must be an object");
    expect(() =>
      scenario.resolve({ trustedNamespaceHead: "head" as never })
    ).toThrow("trusted Namespace head must be an object");
    expect(() =>
      scenario.resolve({
        trustedNamespaceHead: {
          ...scenario.trustedHead,
          namespaceId: namespaceId("namespace_other"),
        },
      })
    ).toThrow("proof-verifier capability");
  });

  test("requires the current complete keyring envelope to be the exact one committed by the trusted head", () => {
    const scenario = setup();
    const base = scenario.currentKeyring;
    const wrong = (currentKeyring: NamespaceKeyringPlaintextV2) => {
      const forgedEnvelope = sealNamespaceKeyring({
        crypto: scenario.crypto,
        domainRoot: bytes(0x32),
        keyring: currentKeyring,
        metadata: {
          domainId: cryptoDomainId("domain_abc"),
          domainEpoch: domainEpoch(1),
          previousBindingHash: scenario.bindingHash0,
          committerDeviceId: scenario.deviceId,
        },
        committerSigningPrivateKey: scenario.signing.privateKey,
        resolveCurrentCommitter: () => scenario.signing.publicKey,
      });
      return scenario.resolve({ currentKeyringEnvelope: forgedEnvelope });
    };

    expect(() =>
      wrong({
        ...base,
        namespaceId: namespaceId("namespace_other"),
      })
    ).toThrow();
    expect(() => wrong({ ...base, keyClass: "ai" })).toThrow();
    expect(() =>
      wrong({
        ...base,
        accessRevision: accessRevision(0),
      })
    ).toThrow();
    expect(() =>
      wrong({
        ...base,
        currentGeneration: namespaceGeneration(0),
        generations: [base.generations[0]!],
      })
    ).toThrow();
  });

  test("rejects a missing historical generation instead of falling back to current", () => {
    const scenario = setup();
    const currentOnly: NamespaceKeyringPlaintextV2 = {
      ...scenario.currentKeyring,
      generations: [scenario.currentKeyring.generations[1]!],
    };
    const currentOnlyEnvelope = sealNamespaceKeyring({
      crypto: scenario.crypto,
      domainRoot: bytes(0x32),
      keyring: currentOnly,
      metadata: {
        domainId: cryptoDomainId("domain_abc"),
        domainEpoch: domainEpoch(1),
        previousBindingHash: scenario.bindingHash0,
        committerDeviceId: scenario.deviceId,
      },
      committerSigningPrivateKey: scenario.signing.privateKey,
      resolveCurrentCommitter: () => scenario.signing.publicKey,
    });
    const incompleteBinding = createNamespaceBinding({
      crypto: scenario.crypto,
      humanEnvelope: currentOnlyEnvelope,
      aiEnvelope: scenario.aiEnvelope1,
      committerSigningPrivateKey: scenario.signing.privateKey,
      resolveCurrentCommitter: () => scenario.signing.publicKey,
    });
    const incompleteHead = verifyNamespaceBindingProof({
      crypto: scenario.crypto,
      anchor: {
        namespaceId: scenario.targetNamespaceId,
        accessRevision: accessRevision(0),
        bindingHash: scenario.bindingHash0,
      },
      proof: [scenario.binding0, incompleteBinding],
      resolveHistoricalCommitter: () => scenario.signing.publicKey,
    });
    expect(() =>
      scenario.resolve({
        trustedNamespaceHead: incompleteHead,
        currentKeyringEnvelope: currentOnlyEnvelope,
      })
    ).toThrow("historical generation");
  });

  test("rejects fabricated manifest capabilities and detached-envelope replay", () => {
    const scenario = setup();
    const fabricated = {
      ...scenario.verifiedManifest,
    } as VerifiedObjectAccessManifestV2;
    expect(() =>
      scenario.resolve({ verifiedManifest: fabricated })
    ).toThrow("trusted-head-verified manifest");

    const detached = prepareObjectAccessManifestUpdateV2(scenario.crypto, {
      currentManifestBytes: scenario.manifest0.bytes,
      currentEnvelopeBytes: [scenario.historicalEnvelopeBytes],
      trustedMinimumHead: {
        objectId: scenario.targetObjectId,
        payloadHash: scenario.payloadHash,
        accessRevision: accessRevision(0),
        manifestHash: scenario.manifest0.hash,
      },
      proof: [],
      resolveSigningPublicKey: () => scenario.signing.publicKey,
      operation: {
        type: "detach",
        envelopeBytes: scenario.historicalEnvelopeBytes,
      },
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: scenario.deviceId,
      hostAuthorizationRevision: authorizationRevision(2),
      signingPrivateKey: scenario.signing.privateKey,
    });
    const verifiedDetached = verifyObjectAccessManifestChainV2(
      scenario.crypto,
      {
        manifestBytes: detached.manifestBytes,
        proof: [],
        trustedMinimumHead: {
          objectId: scenario.targetObjectId,
          payloadHash: scenario.payloadHash,
          accessRevision: accessRevision(0),
          manifestHash: scenario.manifest0.hash,
        },
        resolveSigningPublicKey: () => scenario.signing.publicKey,
      },
    );
    expect(() =>
      scenario.resolve({ verifiedManifest: verifiedDetached })
    ).toThrow("detached");
  });

  test("inherits rollback and fork rejection from both existing trusted-head verifiers", () => {
    const scenario = setup();
    expect(() =>
      verifyObjectAccessManifestChainV2(scenario.crypto, {
        manifestBytes: scenario.manifest0.bytes,
        proof: [],
        trustedMinimumHead: {
          objectId: scenario.targetObjectId,
          payloadHash: scenario.payloadHash,
          accessRevision: accessRevision(1),
          manifestHash: bytes(0x77),
        },
        resolveSigningPublicKey: () => scenario.signing.publicKey,
      })
    ).toThrow("rollback");

    const forkedBinding1 = {
      ...scenario.binding1,
      previousBindingHash: bytes(0xee),
    };
    expect(() =>
      verifyNamespaceBindingProof({
        crypto: scenario.crypto,
        anchor: {
          namespaceId: scenario.targetNamespaceId,
          accessRevision: accessRevision(0),
          bindingHash: scenario.bindingHash0,
        },
        proof: [scenario.binding0, forkedBinding1],
        resolveHistoricalCommitter: () => scenario.signing.publicKey,
      })
    ).toThrow();
  });

  test("does not accept an arbitrary binding-shaped value as the current head", () => {
    const scenario = setup();
    const fabricatedHead = {
      namespaceId: scenario.trustedHead.namespaceId,
      accessRevision: scenario.trustedHead.accessRevision,
      binding: {
        ...scenario.trustedHead.binding,
        humanCurrentGeneration: namespaceGeneration(0),
      },
    } as VerifiedNamespaceBindingHeadV2;
    Object.assign(fabricatedHead, {
      bindingHash: namespaceBindingHash(fabricatedHead.binding),
    });
    expect(() =>
      scenario.resolve({ trustedNamespaceHead: fabricatedHead })
    ).toThrow("proof-verifier capability");
  });

  test("authentic Namespace heads freeze coordinates and detect mutable-byte corruption", () => {
    const scenario = setup();
    const head = scenario.trustedHead;
    const originalNamespaceId = head.namespaceId;
    const flipFirstByte = (value: Uint8Array): void => {
      const first = value[0];
      if (first === undefined) throw new Error("expected nonempty digest");
      value[0] = first ^ 0xff;
    };

    expect(Object.isFrozen(head)).toBe(true);
    expect(
      Reflect.set(head, "namespaceId", namespaceId("namespace_other")),
    ).toBe(false);
    expect(head.namespaceId).toBe(originalNamespaceId);

    flipFirstByte(head.bindingHash);
    expect(() => scenario.resolve()).toThrow("proof-verifier capability");
    flipFirstByte(head.bindingHash);

    const envelopeHash = head.binding.humanKeyringEnvelopeHash;
    flipFirstByte(envelopeHash);
    expect(() => scenario.resolve()).toThrow("proof-verifier capability");
    flipFirstByte(envelopeHash);

    expect(() => scenario.resolve()).not.toThrow();
  });

  test("does not trust a structurally valid caller-supplied plaintext keyring", () => {
    const scenario = setup();
    const forged: NamespaceKeyringPlaintextV2 = {
      ...scenario.currentKeyring,
      generations: scenario.currentKeyring.generations.map((entry) => ({
        ...entry,
        key: entry.generation === namespaceGeneration(0)
          ? bytes(0xfa)
          : entry.key,
      })),
    };

    expect(() =>
      scenario.resolve({
        currentKeyringEnvelope: sealNamespaceKeyring({
          crypto: scenario.crypto,
          domainRoot: bytes(0x32),
          keyring: forged,
          metadata: {
            domainId: cryptoDomainId("domain_abc"),
            domainEpoch: domainEpoch(1),
            previousBindingHash: scenario.bindingHash0,
            committerDeviceId: scenario.deviceId,
          },
          committerSigningPrivateKey: scenario.signing.privateKey,
          resolveCurrentCommitter: () => scenario.signing.publicKey,
        }),
      })
    ).toThrow("authenticated current keyring envelope");
  });
});
