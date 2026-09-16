import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  seededRng,
} from "../../src/crypto/index.ts";
import {
  serializeNamespaceBinding,
} from "../../src/format/namespace-binding-v2.ts";
import {
  serializeNamespaceKeyringEnvelope,
} from "../../src/format/namespace-keyring-v2.ts";
import {
  createNamespaceBinding,
  namespaceBindingHash,
  verifyBindingEnvelopePair,
  verifyNamespaceBindingProof,
} from "../../src/namespace/bindings.ts";
import {
  createInitialNamespaceKeyrings,
  openNamespaceKeyring,
  sealNamespaceKeyring,
} from "../../src/namespace/keyrings.ts";
import {
  prepareHumanNamespaceRebindV2,
  type PrepareHumanNamespaceRebindInputV2,
} from "../../src/transition/namespace-rebind.ts";
import {
  accessRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  namespaceId,
} from "../../src/v2-types/ids.ts";

function root(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

class CountingCrypto extends LatticeCrypto {
  randomCalls = 0;

  override randomBytes(length: number): Uint8Array {
    this.randomCalls += 1;
    return super.randomBytes(length);
  }
}

function setup() {
  const crypto = new CountingCrypto(seededRng(2250));
  const signing = crypto.generateSigningKeyPair();
  const committerDeviceId = cryptoDeviceId("alice-phone");
  const oldDomainId = cryptoDomainId("domain-ab");
  const oldHumanRoot = root(0x11);
  const oldAiRoot = root(0x12);
  const keyrings = createInitialNamespaceKeyrings(
    crypto,
    namespaceId("room-1"),
  );
  const resolver = () => signing.publicKey;
  const humanEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: oldHumanRoot,
    keyring: keyrings.human,
    metadata: {
      domainId: oldDomainId,
      domainEpoch: domainEpoch(4),
      previousBindingHash: null,
      committerDeviceId,
    },
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: resolver,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: oldAiRoot,
    keyring: keyrings.ai,
    metadata: {
      domainId: oldDomainId,
      domainEpoch: domainEpoch(4),
      previousBindingHash: null,
      committerDeviceId,
    },
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: resolver,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: resolver,
  });
  const input: PrepareHumanNamespaceRebindInputV2 = {
    crypto,
    reason: "human_add",
    current: {
      anchor: null,
      proof: [binding],
      humanEnvelope,
      aiEnvelope,
      oldHumanDomainRoot: oldHumanRoot,
      oldAiDomainRoot: oldAiRoot,
    },
    target: {
      domainId: cryptoDomainId("domain-abc"),
      domainEpoch: domainEpoch(0),
      humanDomainRoot: root(0x21),
      aiDomainRoot: root(0x22),
    },
    committer: {
      deviceId: committerDeviceId,
      signingPrivateKey: signing.privateKey,
    },
    resolveHistoricalCommitter: resolver,
    resolveSourceCommitter: (context) =>
      context.domainId === oldDomainId ? signing.publicKey : null,
    resolveTargetCommitter: (context) =>
      context.domainId === cryptoDomainId("domain-abc")
        ? signing.publicKey
        : null,
  };
  return {
    aiEnvelope,
    binding,
    crypto,
    humanEnvelope,
    input,
    keyrings,
    oldAiRoot,
    oldHumanRoot,
    signing,
  };
}

describe("v2 full-history Human Namespace rebind preparation", () => {
  test("AB -> ABC carries complete Human/AI history and appends fresh generations", () => {
    const {
      binding,
      crypto,
      input,
      keyrings,
      signing,
    } = setup();
    const wipedBefore: Uint8Array[] = [];
    const originalFill = Uint8Array.prototype.fill;
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      const before = this.slice();
      const result = originalFill.call(this, value, start, end);
      if (value === 0 && this.length === 32) wipedBefore.push(before);
      return result;
    };

    let prepared: ReturnType<typeof prepareHumanNamespaceRebindV2>;
    try {
      prepared = prepareHumanNamespaceRebindV2(input);
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }

    expect(prepared.reason).toBe("human_add");
    expect(prepared.expectedHead).toEqual({
      namespaceId: binding.namespaceId,
      accessRevision: binding.accessRevision,
      bindingHash: namespaceBindingHash(binding),
    });
    expect(prepared.nextHead.namespaceId).toBe(binding.namespaceId);
    expect(prepared.nextHead.domainId).toBe(input.target.domainId);
    expect(prepared.nextHead.domainEpoch).toBe(input.target.domainEpoch);
    expect(Number(prepared.nextHead.accessRevision)).toBe(1);
    expect(prepared.binding.previousBindingHash).toEqual(
      namespaceBindingHash(binding),
    );
    expect(
      verifyBindingEnvelopePair(
        prepared.binding,
        prepared.humanEnvelope,
        prepared.aiEnvelope,
      ),
    ).toBe(true);

    const openedHuman = openNamespaceKeyring({
      crypto,
      domainRoot: input.target.humanDomainRoot,
      envelope: prepared.humanEnvelope,
      resolveHistoricalCommitter: () => signing.publicKey,
    });
    const openedAi = openNamespaceKeyring({
      crypto,
      domainRoot: input.target.aiDomainRoot,
      envelope: prepared.aiEnvelope,
      resolveHistoricalCommitter: () => signing.publicKey,
    });
    expect(openedHuman.generations).toHaveLength(2);
    expect(openedAi.generations).toHaveLength(2);
    expect(openedHuman.generations[0]).toEqual(keyrings.human.generations[0]);
    expect(openedAi.generations[0]).toEqual(keyrings.ai.generations[0]);
    expect(openedHuman.generations[1]?.key).not.toEqual(
      openedAi.generations[1]?.key,
    );
    expect(Number(openedHuman.currentGeneration)).toBe(1);
    expect(Number(openedAi.currentGeneration)).toBe(1);
    for (const sourceKey of [
      keyrings.human.generations[0]!.key,
      keyrings.ai.generations[0]!.key,
    ]) {
      // The decoded key, appended-keyring clone, retained revision
      // intermediate, and final revision are four distinct owned copies.
      expect(
        wipedBefore.filter((before) =>
          before.every((byte, index) => byte === sourceKey[index])
        ),
      ).toHaveLength(4);
    }

    const verified = verifyNamespaceBindingProof({
      crypto,
      anchor: {
        namespaceId: binding.namespaceId,
        accessRevision: accessRevision(0),
        bindingHash: namespaceBindingHash(binding),
      },
      proof: [prepared.binding],
      resolveHistoricalCommitter: () => signing.publicKey,
    });
    expect(verified.bindingHash).toEqual(prepared.nextHead.bindingHash);
  });

  test("Human removal uses the same retained-history transition and leaves old bytes usable", () => {
    const {
      aiEnvelope,
      crypto,
      humanEnvelope,
      input,
      oldAiRoot,
      oldHumanRoot,
      signing,
    } = setup();
    const oldHumanCiphertext = humanEnvelope.ciphertext.slice();
    const oldAiCiphertext = aiEnvelope.ciphertext.slice();

    const prepared = prepareHumanNamespaceRebindV2({
      ...input,
      reason: "human_remove",
      target: {
        ...input.target,
        domainId: cryptoDomainId("domain-ac"),
      },
      resolveTargetCommitter: () => signing.publicKey,
    });

    expect(prepared.reason).toBe("human_remove");
    expect(humanEnvelope.ciphertext).toEqual(oldHumanCiphertext);
    expect(aiEnvelope.ciphertext).toEqual(oldAiCiphertext);
    expect(
      openNamespaceKeyring({
        crypto,
        domainRoot: oldHumanRoot,
        envelope: humanEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      }).generations,
    ).toHaveLength(1);
    expect(
      openNamespaceKeyring({
        crypto,
        domainRoot: oldAiRoot,
        envelope: aiEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      }).generations,
    ).toHaveLength(1);
    expect(prepared.binding.domainId).toBe(cryptoDomainId("domain-ac"));
  });

  test("rejects unauthorized source/target committers and a mismatched private key before randomness", () => {
    const { crypto, input } = setup();
    const before = crypto.randomCalls;
    const cases: PrepareHumanNamespaceRebindInputV2[] = [
      { ...input, resolveSourceCommitter: () => null },
      { ...input, resolveTargetCommitter: () => null },
      {
        ...input,
        committer: {
          ...input.committer,
          signingPrivateKey: root(0xee),
        },
      },
    ];

    for (const denied of cases) {
      expect(() => prepareHumanNamespaceRebindV2(denied)).toThrow();
      expect(crypto.randomCalls).toBe(before);
    }
  });

  test("validates every source and target Domain root by exact type, length, and label", () => {
    const invalidRoots = [
      ["target", "humanDomainRoot", "Target Human Domain root"],
      ["target", "aiDomainRoot", "Target AI Domain root"],
      ["current", "oldHumanDomainRoot", "Source Human Domain root"],
      ["current", "oldAiDomainRoot", "Source AI Domain root"],
    ] as const;

    for (const [container, field, label] of invalidRoots) {
      const { input } = setup();
      const invalid = root(1).subarray(0, 31);
      expect(() =>
        prepareHumanNamespaceRebindV2({
          ...input,
          [container]: {
            ...input[container],
            [field]: invalid,
          },
        })
      ).toThrow(`${label} must be exactly 32 bytes`);
    }

    const { input } = setup();
    expect(() =>
      prepareHumanNamespaceRebindV2({
        ...input,
        target: {
          ...input.target,
          humanDomainRoot: null as never,
        },
      })
    ).toThrow("Target Human Domain root must be exactly 32 bytes");
  });

  test("detaches all Domain roots before invoking host authorization resolvers", () => {
    const { input, signing } = setup();
    const sourceHumanRoot = input.current.oldHumanDomainRoot.slice();
    const sourceAiRoot = input.current.oldAiDomainRoot.slice();
    const targetHumanRoot = input.target.humanDomainRoot.slice();
    const targetAiRoot = input.target.aiDomainRoot.slice();
    let mutated = false;

    const prepared = prepareHumanNamespaceRebindV2({
      ...input,
      resolveHistoricalCommitter: () => {
        if (!mutated) {
          mutated = true;
          input.current.oldHumanDomainRoot.fill(0xff);
          input.current.oldAiDomainRoot.fill(0xff);
          input.target.humanDomainRoot.fill(0xff);
          input.target.aiDomainRoot.fill(0xff);
        }
        return signing.publicKey;
      },
    });

    expect(mutated).toBe(true);
    expect(
      openNamespaceKeyring({
        crypto: input.crypto,
        domainRoot: targetHumanRoot,
        envelope: prepared.humanEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      }).keyClass,
    ).toBe("human");
    expect(
      openNamespaceKeyring({
        crypto: input.crypto,
        domainRoot: targetAiRoot,
        envelope: prepared.aiEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      }).keyClass,
    ).toBe("ai");
    expect(Array.from(sourceHumanRoot)).toEqual(Array.from(root(0x11)));
    expect(Array.from(sourceAiRoot)).toEqual(Array.from(root(0x12)));
  });

  test("wipes owned roots and signing-key clone after success without wiping caller inputs", () => {
    const { crypto, input } = setup();
    const callerRoots = [
      input.current.oldHumanDomainRoot,
      input.current.oldAiDomainRoot,
      input.target.humanDomainRoot,
      input.target.aiDomainRoot,
    ];
    const callerPrivateKey = input.committer.signingPrivateKey;
    const ownedRoots = new Set<Uint8Array>();
    const ownedPrivateKeys = new Set<Uint8Array>();
    const originalOpen = crypto.aeadOpen.bind(crypto);
    const originalSeal = crypto.aeadSeal.bind(crypto);
    const originalSign = crypto.sign.bind(crypto);
    crypto.aeadOpen = (key, ciphertext, aad) => {
      ownedRoots.add(key);
      return originalOpen(key, ciphertext, aad);
    };
    crypto.aeadSeal = (key, plaintext, aad) => {
      ownedRoots.add(key);
      return originalSeal(key, plaintext, aad);
    };
    crypto.sign = (privateKey, message) => {
      ownedPrivateKeys.add(privateKey);
      return originalSign(privateKey, message);
    };

    prepareHumanNamespaceRebindV2(input);

    expect(ownedRoots.size).toBe(4);
    expect(
      [...ownedRoots].every((value) => value.every((byte) => byte === 0)),
    ).toBe(true);
    expect(ownedPrivateKeys.size).toBe(1);
    expect(
      [...ownedPrivateKeys][0]!.every((byte) => byte === 0),
    ).toBe(true);
    expect(
      callerRoots.every((value) => value.some((byte) => byte !== 0)),
    ).toBe(true);
    expect(callerPrivateKey.some((byte) => byte !== 0)).toBe(true);
  });

  test("wipes every captured secret clone when the second seal fails", () => {
    const { crypto, input } = setup();
    const callerRoots = [
      input.current.oldHumanDomainRoot,
      input.current.oldAiDomainRoot,
      input.target.humanDomainRoot,
      input.target.aiDomainRoot,
    ];
    const callerPrivateKey = input.committer.signingPrivateKey;
    const ownedRoots = new Set<Uint8Array>();
    const ownedPrivateKeys = new Set<Uint8Array>();
    const encodedPlaintexts: Uint8Array[] = [];
    const originalOpen = crypto.aeadOpen.bind(crypto);
    const originalSeal = crypto.aeadSeal.bind(crypto);
    const originalSign = crypto.sign.bind(crypto);
    let seals = 0;
    crypto.aeadOpen = (key, ciphertext, aad) => {
      ownedRoots.add(key);
      return originalOpen(key, ciphertext, aad);
    };
    crypto.aeadSeal = (key, plaintext, aad) => {
      ownedRoots.add(key);
      encodedPlaintexts.push(plaintext);
      seals += 1;
      if (seals === 2) throw new Error("injected second seal failure");
      return originalSeal(key, plaintext, aad);
    };
    crypto.sign = (privateKey, message) => {
      ownedPrivateKeys.add(privateKey);
      return originalSign(privateKey, message);
    };

    expect(() => prepareHumanNamespaceRebindV2(input)).toThrow(
      "injected second seal failure",
    );
    expect(ownedRoots.size).toBe(4);
    expect(
      [...ownedRoots].every((value) => value.every((byte) => byte === 0)),
    ).toBe(true);
    expect(
      [...ownedPrivateKeys].every((value) =>
        value.every((byte) => byte === 0)
      ),
    ).toBe(true);
    expect(
      encodedPlaintexts.every((value) =>
        value.every((byte) => byte === 0)
      ),
    ).toBe(true);
    expect(
      callerRoots.every((value) => value.some((byte) => byte !== 0)),
    ).toBe(true);
    expect(callerPrivateKey.some((byte) => byte !== 0)).toBe(true);
  });

  test("validates resolver keys and the private signing key exactly", () => {
    const { input } = setup();

    expect(() =>
      prepareHumanNamespaceRebindV2({
        ...input,
        resolveSourceCommitter: () => null,
      })
    ).toThrow("Source committer public key must be exactly 32 bytes");
    expect(() =>
      prepareHumanNamespaceRebindV2({
        ...input,
        resolveTargetCommitter: () => root(1).subarray(0, 31),
      })
    ).toThrow("Target committer public key must be exactly 32 bytes");
    expect(() =>
      prepareHumanNamespaceRebindV2({
        ...input,
        committer: {
          ...input.committer,
          signingPrivateKey: root(1).subarray(0, 31),
        },
      })
    ).toThrow(
      "Namespace rebind committer signing private key must be exactly 32 bytes",
    );
    expect(() =>
      prepareHumanNamespaceRebindV2({
        ...input,
        committer: {
          ...input.committer,
          signingPrivateKey: null as never,
        },
      })
    ).toThrow(
      "Namespace rebind committer signing private key must be exactly 32 bytes",
    );
  });

  test("reports an exact mismatch for a different valid private signing key", () => {
    const { crypto, input } = setup();
    const otherSigning = crypto.generateSigningKeyPair();

    expect(() =>
      prepareHumanNamespaceRebindV2({
        ...input,
        committer: {
          ...input.committer,
          signingPrivateKey: otherSigning.privateKey,
        },
      })
    ).toThrow(
      "Namespace rebind private key does not match the authorized committer",
    );
  });

  test("rejects unsupported transition reasons before cryptographic work", () => {
    const { crypto, input } = setup();
    const before = crypto.randomCalls;

    expect(() =>
      prepareHumanNamespaceRebindV2({
        ...input,
        reason: "maintenance" as never,
      })
    ).toThrow("reason is unsupported");
    expect(crypto.randomCalls).toBe(before);
  });

  test("requires one committer across every source and target purpose before randomness", () => {
    const { crypto, input, signing } = setup();
    const otherPublicKey = signing.publicKey.slice();
    otherPublicKey[0] = otherPublicKey[0]! ^ 1;
    const before = crypto.randomCalls;

    expect(() =>
      prepareHumanNamespaceRebindV2({
        ...input,
        resolveTargetCommitter: (context) =>
          context.purpose === "namespace-binding"
            ? otherPublicKey
            : signing.publicKey,
      })
    ).toThrow("differs across transition contexts");
    expect(crypto.randomCalls).toBe(before);
  });

  test("asks the host for exact source and target revisions for both signed artifacts", () => {
    const { input, signing } = setup();
    const observed: Array<{
      side: "source" | "target";
      purpose: string;
      namespaceId: string;
      domainId: string;
      epoch: number;
      revision: number;
      deviceId: string;
      previousBindingHash: Uint8Array | null;
    }> = [];

    prepareHumanNamespaceRebindV2({
      ...input,
      resolveSourceCommitter: (context) => {
        observed.push({
          side: "source",
          purpose: context.purpose,
          namespaceId: context.namespaceId,
          domainId: context.domainId,
          epoch: Number(context.domainEpoch),
          revision: Number(context.accessRevision),
          deviceId: context.committerDeviceId,
          previousBindingHash: context.previousBindingHash,
        });
        return signing.publicKey;
      },
      resolveTargetCommitter: (context) => {
        observed.push({
          side: "target",
          purpose: context.purpose,
          namespaceId: context.namespaceId,
          domainId: context.domainId,
          epoch: Number(context.domainEpoch),
          revision: Number(context.accessRevision),
          deviceId: context.committerDeviceId,
          previousBindingHash: context.previousBindingHash,
        });
        return signing.publicKey;
      },
    });

    const binding = input.current.proof[0]!;
    const expectedHash = namespaceBindingHash(binding);
    const common = {
      namespaceId: binding.namespaceId,
      deviceId: input.committer.deviceId,
      previousBindingHash: expectedHash,
    };
    expect(observed).toEqual([
      {
        ...common,
        side: "source",
        purpose: "namespace-keyring-envelope",
        domainId: binding.domainId,
        epoch: Number(binding.domainEpoch),
        revision: 0,
      },
      {
        ...common,
        side: "target",
        purpose: "namespace-keyring-envelope",
        domainId: input.target.domainId,
        epoch: Number(input.target.domainEpoch),
        revision: 1,
      },
      {
        ...common,
        side: "source",
        purpose: "namespace-binding",
        domainId: binding.domainId,
        epoch: Number(binding.domainEpoch),
        revision: 0,
      },
      {
        ...common,
        side: "target",
        purpose: "namespace-binding",
        domainId: input.target.domainId,
        epoch: Number(input.target.domainEpoch),
        revision: 1,
      },
    ]);
    expect(
      new Set(observed.map((entry) => entry.previousBindingHash)).size,
    ).toBe(4);
  });

  test("rejects a fabricated/forked current proof, mismatched envelope pair, and no-op Domain move", () => {
    const { aiEnvelope, binding, input } = setup();
    const badHash = binding.signature.slice(0, 32);

    expect(() =>
      prepareHumanNamespaceRebindV2({
        ...input,
        current: {
          ...input.current,
          anchor: {
            namespaceId: binding.namespaceId,
            accessRevision: accessRevision(0),
            bindingHash: badHash,
          },
        },
      })
    ).toThrow();
    expect(() =>
      prepareHumanNamespaceRebindV2({
        ...input,
        current: {
          ...input.current,
          aiEnvelope: {
            ...aiEnvelope,
            domainId: cryptoDomainId("other-domain"),
          },
        },
      })
    ).toThrow("matching");
    expect(() =>
      prepareHumanNamespaceRebindV2({
        ...input,
        target: {
          ...input.target,
          domainId: binding.domainId,
        },
      })
    ).toThrow("different Crypto Domain");
  });

  test("returns detached, storage-ready opaque envelopes and exact CAS heads without writing", () => {
    const { input } = setup();
    const prepared = prepareHumanNamespaceRebindV2(input);
    const oldHash = namespaceBindingHash(input.current.proof[0]!);
    const nextHash = namespaceBindingHash(prepared.binding);
    const bindingBytes = serializeNamespaceBinding(prepared.binding);
    const humanEnvelopeBytes = serializeNamespaceKeyringEnvelope(
      prepared.humanEnvelope,
    );
    const aiEnvelopeBytes = serializeNamespaceKeyringEnvelope(
      prepared.aiEnvelope,
    );

    expect(Object.keys(prepared.bindingRecord).sort()).toEqual([
      "aiKeyringEnvelope",
      "bindingHash",
      "humanKeyringEnvelope",
      "namespaceId",
      "previousBindingHash",
      "revision",
      "signedBindingBytes",
    ]);
    expect(prepared.bindingRecord.namespaceId).toBe(
      prepared.binding.namespaceId,
    );
    expect(prepared.bindingRecord.revision).toBe(
      prepared.binding.accessRevision,
    );
    expect(prepared.bindingRecord.humanKeyringEnvelope.kind).toBe(
      "human-keyring-envelope",
    );
    expect(prepared.bindingRecord.aiKeyringEnvelope.kind).toBe(
      "ai-keyring-envelope",
    );
    expect(prepared.bindingRecord.humanKeyringEnvelope).toMatchObject({
      classification: "opaque-ciphertext",
      kind: "human-keyring-envelope",
      ciphertext: humanEnvelopeBytes,
    });
    expect(prepared.bindingRecord.aiKeyringEnvelope).toMatchObject({
      classification: "opaque-ciphertext",
      kind: "ai-keyring-envelope",
      ciphertext: aiEnvelopeBytes,
    });
    expect(prepared.bindingRecord.bindingHash).toEqual(nextHash);
    expect(prepared.bindingRecord.previousBindingHash).toEqual(oldHash);
    expect(prepared.bindingRecord.signedBindingBytes).toEqual(bindingBytes);
    expect(prepared.bindingRecord.bindingHash).not.toBe(
      prepared.nextHead.bindingHash,
    );
    expect(prepared.bindingRecord.previousBindingHash).not.toBe(
      prepared.expectedHead.bindingHash,
    );
    expect(prepared.bindingRecord.signedBindingBytes).not.toBe(
      prepared.bindingBytes,
    );

    prepared.nextHead.bindingHash[0] =
      prepared.nextHead.bindingHash[0]! ^ 0xff;
    prepared.expectedHead.bindingHash[0] =
      prepared.expectedHead.bindingHash[0]! ^ 0xff;
    prepared.bindingBytes[0] = prepared.bindingBytes[0]! ^ 0xff;
    expect(prepared.bindingRecord.bindingHash).toEqual(nextHash);
    expect(prepared.bindingRecord.previousBindingHash).toEqual(oldHash);
    expect(prepared.bindingRecord.signedBindingBytes).toEqual(bindingBytes);
  });
});
