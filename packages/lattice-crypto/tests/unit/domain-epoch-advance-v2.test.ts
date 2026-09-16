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
} from "../../src/namespace/bindings.ts";
import {
  createInitialNamespaceKeyrings,
  openNamespaceKeyring,
  sealNamespaceKeyring,
} from "../../src/namespace/keyrings.ts";
import type {
  NamespaceKeyringPlaintextV2,
} from "../../src/namespace/types.ts";
import {
  prepareDomainEpochAdvanceV2,
  type DomainEpochAdvanceNamespaceV2,
  type PrepareDomainEpochAdvanceInputV2,
} from "../../src/transition/domain-epoch-advance.ts";
import {
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  namespaceGeneration,
  namespaceId,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

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
  const crypto = new CountingCrypto(seededRng(2260));
  const signing = crypto.generateSigningKeyPair();
  const deviceId = cryptoDeviceId("alice-phone");
  const domainId = cryptoDomainId("domain-ab");
  const oldHumanRoot = root(0x31);
  const oldAiRoot = root(0x32);
  const resolver = () => signing.publicKey;
  const expandKeyring = (
    keyring: NamespaceKeyringPlaintextV2,
    generationCount: number,
  ): NamespaceKeyringPlaintextV2 => {
    if (generationCount === 1) return keyring;
    return Object.freeze({
      ...keyring,
      currentGeneration: namespaceGeneration(generationCount - 1),
      generations: Object.freeze(
        Array.from({ length: generationCount }, (_, generation) =>
          Object.freeze({
            generation: namespaceGeneration(generation),
            key: root(keyring.keyClass === "human" ? 0x51 : 0x52),
          })
        ),
      ),
    });
  };
  const makeNamespace = (
    rawNamespaceId: string,
    options: {
      readonly domainId?: ReturnType<typeof cryptoDomainId>;
      readonly epoch?: ReturnType<typeof domainEpoch>;
      readonly humanGenerations?: number;
      readonly aiGenerations?: number;
    } = {},
  ): DomainEpochAdvanceNamespaceV2 => {
    const initialKeyrings = createInitialNamespaceKeyrings(
      crypto,
      namespaceId(rawNamespaceId),
    );
    const keyrings = {
      human: expandKeyring(
        initialKeyrings.human,
        options.humanGenerations ?? 1,
      ),
      ai: expandKeyring(
        initialKeyrings.ai,
        options.aiGenerations ?? 1,
      ),
    };
    const metadata = {
      domainId: options.domainId ?? domainId,
      domainEpoch: options.epoch ?? domainEpoch(6),
      previousBindingHash: null,
      committerDeviceId: deviceId,
    };
    const humanEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: oldHumanRoot,
      keyring: keyrings.human,
      metadata,
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: resolver,
    });
    const aiEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: oldAiRoot,
      keyring: keyrings.ai,
      metadata,
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
    return {
      anchor: null,
      proof: [binding],
      humanEnvelope,
      aiEnvelope,
    };
  };
  const affected = [makeNamespace("room-1"), makeNamespace("room-2")];
  const input: PrepareDomainEpochAdvanceInputV2 = {
    crypto,
    reason: "device_add",
    domain: {
      domainId,
      oldEpoch: domainEpoch(6),
      nextEpoch: domainEpoch(7),
      oldHumanRoot,
      oldAiRoot,
      nextHumanRoot: root(0x41),
      nextAiRoot: root(0x42),
    },
    affected,
    committer: {
      deviceId,
      signingPrivateKey: signing.privateKey,
    },
    resolveHistoricalCommitter: resolver,
    resolveSourceCommitter: (context) =>
      context.domainEpoch === domainEpoch(6) ? signing.publicKey : null,
    resolveTargetCommitter: (context) =>
      context.domainEpoch === domainEpoch(7) ? signing.publicKey : null,
  };
  return {
    affected,
    crypto,
    domainId,
    input,
    makeNamespace,
    oldAiRoot,
    oldHumanRoot,
    signing,
  };
}

describe("v2 Domain device epoch advance preparation", () => {
  test("device add reseals every affected Namespace without rotating its generations", () => {
    const { affected, input, signing } = setup();
    const sources = affected.map((current) => ({
      human: openNamespaceKeyring({
        crypto: input.crypto,
        domainRoot: input.domain.oldHumanRoot,
        envelope: current.humanEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      }),
      ai: openNamespaceKeyring({
        crypto: input.crypto,
        domainRoot: input.domain.oldAiRoot,
        envelope: current.aiEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      }),
    }));
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

    let prepared: ReturnType<typeof prepareDomainEpochAdvanceV2>;
    try {
      prepared = prepareDomainEpochAdvanceV2(input);
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }

    expect(prepared.reason).toBe("device_add");
    expect(prepared.namespaces).toHaveLength(2);
    for (const [index, item] of prepared.namespaces.entries()) {
      expect(item.nextHead.domainId).toBe(input.domain.domainId);
      expect(item.nextHead.domainEpoch).toBe(input.domain.nextEpoch);
      expect(Number(item.nextHead.accessRevision)).toBe(1);
      expect(
        verifyBindingEnvelopePair(
          item.binding,
          item.humanEnvelope,
          item.aiEnvelope,
        ),
      ).toBe(true);
      const human = openNamespaceKeyring({
        crypto: input.crypto,
        domainRoot: input.domain.nextHumanRoot,
        envelope: item.humanEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      });
      const ai = openNamespaceKeyring({
        crypto: input.crypto,
        domainRoot: input.domain.nextAiRoot,
        envelope: item.aiEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      });
      expect(human.generations).toHaveLength(1);
      expect(ai.generations).toHaveLength(1);
      expect(Number(human.currentGeneration)).toBe(0);
      expect(Number(ai.currentGeneration)).toBe(0);
      expect(human.generations).toEqual(sources[index]!.human.generations);
      expect(ai.generations).toEqual(sources[index]!.ai.generations);
      for (const sourceKey of [
        sources[index]!.human.generations[0]!.key,
        sources[index]!.ai.generations[0]!.key,
      ]) {
        // The decoded key, retained revision intermediate, final revision,
        // and batch-preflight keyring are four distinct owned copies.
        expect(
          wipedBefore.filter((before) =>
            before.every((byte, keyIndex) => byte === sourceKey[keyIndex])
          ),
        ).toHaveLength(4);
      }
    }
  });

  test("device revoke appends fresh Human and AI generations in every affected Namespace", () => {
    const { input, signing } = setup();

    const prepared = prepareDomainEpochAdvanceV2({
      ...input,
      reason: "device_revoke",
    });

    for (const item of prepared.namespaces) {
      const human = openNamespaceKeyring({
        crypto: input.crypto,
        domainRoot: input.domain.nextHumanRoot,
        envelope: item.humanEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      });
      const ai = openNamespaceKeyring({
        crypto: input.crypto,
        domainRoot: input.domain.nextAiRoot,
        envelope: item.aiEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      });
      expect(human.generations).toHaveLength(2);
      expect(ai.generations).toHaveLength(2);
      expect(Number(human.currentGeneration)).toBe(1);
      expect(Number(ai.currentGeneration)).toBe(1);
      expect(human.generations[1]?.key).not.toEqual(ai.generations[1]?.key);
    }
  });

  test("preflights the complete batch, exact Domain/epoch, uniqueness, and both committer contexts before randomness", () => {
    const { affected, crypto, input, makeNamespace } = setup();
    const wrongDomain = makeNamespace("room-wrong-domain", {
      domainId: cryptoDomainId("other-domain"),
    });
    const wrongEpoch = makeNamespace("room-wrong-epoch", {
      epoch: domainEpoch(5),
    });
    const mismatchedPair = {
      ...affected[1]!,
      aiEnvelope: affected[0]!.aiEnvelope,
    };
    const before = crypto.randomCalls;
    const denials: PrepareDomainEpochAdvanceInputV2[] = [
      { ...input, resolveSourceCommitter: () => null },
      { ...input, resolveTargetCommitter: () => null },
      { ...input, affected: [affected[0]!, affected[0]!] },
      { ...input, affected: [wrongDomain] },
      { ...input, affected: [wrongEpoch] },
      { ...input, affected: [mismatchedPair] },
    ];

    for (const denied of denials) {
      expect(() => prepareDomainEpochAdvanceV2(denied)).toThrow();
      expect(crypto.randomCalls).toBe(before);
    }
  });

  test("wipes prior and partial preflight keyrings when a later AI open fails", () => {
    const { affected, crypto, input, signing } = setup();
    const expectedKeys = [
      openNamespaceKeyring({
        crypto,
        domainRoot: input.domain.oldHumanRoot,
        envelope: affected[0]!.humanEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      }).generations[0]!.key.slice(),
      openNamespaceKeyring({
        crypto,
        domainRoot: input.domain.oldAiRoot,
        envelope: affected[0]!.aiEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      }).generations[0]!.key.slice(),
      openNamespaceKeyring({
        crypto,
        domainRoot: input.domain.oldHumanRoot,
        envelope: affected[1]!.humanEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      }).generations[0]!.key.slice(),
    ];
    const wipedBefore: Uint8Array[] = [];
    const originalFill = Uint8Array.prototype.fill;
    const originalOpen = crypto.aeadOpen.bind(crypto);
    let opens = 0;
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
    crypto.aeadOpen = (...args) => {
      opens += 1;
      if (opens === 4) throw new Error("injected later AI open failure");
      return originalOpen(...args);
    };

    try {
      expect(() => prepareDomainEpochAdvanceV2(input)).toThrow(
        "injected later AI open failure",
      );
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
    for (const expected of expectedKeys) {
      // Decoding wipes its temporary key copy; failed batch preflight wipes
      // the transferred/opened copy.
      expect(
        wipedBefore.filter((before) =>
          before.every((byte, index) => byte === expected[index])
        ),
      ).toHaveLength(2);
    }
  });

  test("reports exact source, duplicate, and current-pair preflight failures", () => {
    const { affected, input, makeNamespace } = setup();
    const wrongDomain = makeNamespace("room-wrong-domain-exact", {
      domainId: cryptoDomainId("other-domain"),
    });
    const wrongEpoch = makeNamespace("room-wrong-epoch-exact", {
      epoch: domainEpoch(5),
    });

    for (const current of [wrongDomain, wrongEpoch]) {
      expect(() =>
        prepareDomainEpochAdvanceV2({
          ...input,
          affected: [current],
        })
      ).toThrow(
        "Affected Namespace is not at the exact source Domain epoch",
      );
    }
    expect(() =>
      prepareDomainEpochAdvanceV2({
        ...input,
        affected: [affected[0]!, affected[0]!],
      })
    ).toThrow(
      "Domain epoch transition contains a duplicate Namespace",
    );
    expect(() =>
      prepareDomainEpochAdvanceV2({
        ...input,
        affected: [{
          ...affected[1]!,
          aiEnvelope: affected[0]!.aiEnvelope,
        }],
      })
    ).toThrow(
      "Domain epoch transition requires the matching current envelope pair",
    );
  });

  test("validates every Domain root by exact type, length, and label", () => {
    const invalidRoots = [
      ["oldHumanRoot", "Old Human Domain root"],
      ["oldAiRoot", "Old AI Domain root"],
      ["nextHumanRoot", "Next Human Domain root"],
      ["nextAiRoot", "Next AI Domain root"],
    ] as const;

    for (const [field, label] of invalidRoots) {
      const { input } = setup();
      expect(() =>
        prepareDomainEpochAdvanceV2({
          ...input,
          domain: {
            ...input.domain,
            [field]: root(1).subarray(0, 31),
          },
        })
      ).toThrow(`${label} must be exactly 32 bytes`);
    }

    const { input } = setup();
    expect(() =>
      prepareDomainEpochAdvanceV2({
        ...input,
        domain: {
          ...input.domain,
          oldHumanRoot: null as never,
        },
      })
    ).toThrow("Old Human Domain root must be exactly 32 bytes");
  });

  test("detaches all Domain roots before invoking host authorization resolvers", () => {
    const { affected, input, signing } = setup();
    const oldHumanRoot = input.domain.oldHumanRoot.slice();
    const oldAiRoot = input.domain.oldAiRoot.slice();
    const nextHumanRoot = input.domain.nextHumanRoot.slice();
    const nextAiRoot = input.domain.nextAiRoot.slice();
    let mutated = false;

    const prepared = prepareDomainEpochAdvanceV2({
      ...input,
      affected: [affected[0]!],
      resolveHistoricalCommitter: () => {
        if (!mutated) {
          mutated = true;
          input.domain.oldHumanRoot.fill(0xff);
          input.domain.oldAiRoot.fill(0xff);
          input.domain.nextHumanRoot.fill(0xff);
          input.domain.nextAiRoot.fill(0xff);
        }
        return signing.publicKey;
      },
    });

    expect(mutated).toBe(true);
    expect(
      openNamespaceKeyring({
        crypto: input.crypto,
        domainRoot: nextHumanRoot,
        envelope: prepared.namespaces[0]!.humanEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      }).keyClass,
    ).toBe("human");
    expect(
      openNamespaceKeyring({
        crypto: input.crypto,
        domainRoot: nextAiRoot,
        envelope: prepared.namespaces[0]!.aiEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      }).keyClass,
    ).toBe("ai");
    expect(Array.from(oldHumanRoot)).toEqual(Array.from(root(0x31)));
    expect(Array.from(oldAiRoot)).toEqual(Array.from(root(0x32)));
  });

  test("wipes owned Domain roots and signing-key clone after a successful batch", () => {
    const { crypto, input } = setup();
    const callerRoots = [
      input.domain.oldHumanRoot,
      input.domain.oldAiRoot,
      input.domain.nextHumanRoot,
      input.domain.nextAiRoot,
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

    prepareDomainEpochAdvanceV2(input);

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

  test("wipes captured secrets when a later Namespace fails after partial preparation", () => {
    const { crypto, input } = setup();
    const callerRoots = [
      input.domain.oldHumanRoot,
      input.domain.oldAiRoot,
      input.domain.nextHumanRoot,
      input.domain.nextAiRoot,
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
      if (seals === 3) throw new Error("injected later Namespace failure");
      return originalSeal(key, plaintext, aad);
    };
    crypto.sign = (privateKey, message) => {
      ownedPrivateKeys.add(privateKey);
      return originalSign(privateKey, message);
    };

    expect(() => prepareDomainEpochAdvanceV2(input)).toThrow(
      "injected later Namespace failure",
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

  test("validates source, target, and private signing keys exactly", () => {
    const { input, signing } = setup();

    expect(() =>
      prepareDomainEpochAdvanceV2({
        ...input,
        resolveSourceCommitter: () => null,
      })
    ).toThrow("Source committer public key must be exactly 32 bytes");
    expect(() =>
      prepareDomainEpochAdvanceV2({
        ...input,
        resolveTargetCommitter: () => root(1).subarray(0, 31),
      })
    ).toThrow("Target committer public key must be exactly 32 bytes");
    expect(() =>
      prepareDomainEpochAdvanceV2({
        ...input,
        committer: {
          ...input.committer,
          signingPrivateKey: root(1).subarray(0, 31),
        },
      })
    ).toThrow(
      "Domain epoch committer signing private key must be exactly 32 bytes",
    );
    expect(() =>
      prepareDomainEpochAdvanceV2({
        ...input,
        committer: {
          ...input.committer,
          signingPrivateKey: null as never,
        },
        resolveSourceCommitter: () => signing.publicKey,
      })
    ).toThrow(
      "Domain epoch committer signing private key must be exactly 32 bytes",
    );
  });

  test("rejects unsupported reasons and every non-consecutive target epoch", () => {
    const { input } = setup();

    expect(() =>
      prepareDomainEpochAdvanceV2({
        ...input,
        reason: "maintenance" as never,
      })
    ).toThrow("reason is unsupported");
    for (const nextEpoch of [6, 8]) {
      expect(() =>
        prepareDomainEpochAdvanceV2({
          ...input,
          domain: {
            ...input.domain,
            nextEpoch: domainEpoch(nextEpoch),
          },
        })
      ).toThrow("increment exactly once");
    }
  });

  test("supplies exact, detached source and target authorization contexts", () => {
    const { affected, input, signing } = setup();
    const binding = affected[0]!.proof[0]!;
    const expectedHash = namespaceBindingHash(binding);
    const observed: Array<{
      readonly side: "source" | "target";
      readonly purpose: string;
      readonly epoch: number;
      readonly revision: number;
      readonly previousBindingHash: Uint8Array | null;
    }> = [];
    const record = (side: "source" | "target") =>
      (context: Parameters<typeof input.resolveSourceCommitter>[0]) => {
        observed.push({
          side,
          purpose: context.purpose,
          epoch: Number(context.domainEpoch),
          revision: Number(context.accessRevision),
          previousBindingHash: context.previousBindingHash,
        });
        return signing.publicKey;
      };

    prepareDomainEpochAdvanceV2({
      ...input,
      affected: [affected[0]!],
      resolveSourceCommitter: record("source"),
      resolveTargetCommitter: record("target"),
    });

    expect(observed).toEqual([
      {
        side: "source",
        purpose: "namespace-keyring-envelope",
        epoch: 6,
        revision: 0,
        previousBindingHash: expectedHash,
      },
      {
        side: "target",
        purpose: "namespace-keyring-envelope",
        epoch: 7,
        revision: 1,
        previousBindingHash: expectedHash,
      },
      {
        side: "source",
        purpose: "namespace-binding",
        epoch: 6,
        revision: 0,
        previousBindingHash: expectedHash,
      },
      {
        side: "target",
        purpose: "namespace-binding",
        epoch: 7,
        revision: 1,
        previousBindingHash: expectedHash,
      },
    ]);
    expect(observed.every(
      (entry) => entry.previousBindingHash !== expectedHash,
    )).toBe(true);
    expect(
      new Set(observed.map((entry) => entry.previousBindingHash)).size,
    ).toBe(4);
  });

  test("does not expose the trusted binding hash to host resolver mutation", () => {
    const { affected, input, signing } = setup();
    const expectedHash = namespaceBindingHash(affected[0]!.proof[0]!);
    let resolverCalls = 0;
    const mutateHash = (
      context: Parameters<typeof input.resolveSourceCommitter>[0],
    ) => {
      resolverCalls += 1;
      if (resolverCalls === 1) {
        const previousBindingHash = context.previousBindingHash!;
        previousBindingHash[0] = previousBindingHash[0]! ^ 0xff;
      }
      return signing.publicKey;
    };

    const prepared = prepareDomainEpochAdvanceV2({
      ...input,
      affected: [affected[0]!],
      resolveSourceCommitter: mutateHash,
      resolveTargetCommitter: mutateHash,
    });

    expect(prepared.namespaces[0]!.expectedHead.bindingHash).toEqual(
      expectedHash,
    );
  });

  test("requires one committer across all contexts and Namespaces before randomness", () => {
    const { affected, crypto, input, signing } = setup();
    const otherSigning = crypto.generateSigningKeyPair();
    const before = crypto.randomCalls;

    expect(() =>
      prepareDomainEpochAdvanceV2({
        ...input,
        affected: [affected[0]!],
        resolveTargetCommitter: (context) =>
          context.purpose === "namespace-binding"
            ? otherSigning.publicKey
            : signing.publicKey,
      })
    ).toThrow("differs across transition contexts");
    expect(crypto.randomCalls).toBe(before);

    expect(() =>
      prepareDomainEpochAdvanceV2({
        ...input,
        resolveSourceCommitter: (context) =>
          context.namespaceId === affected[1]!.proof[0]!.namespaceId
            ? otherSigning.publicKey
            : signing.publicKey,
        resolveTargetCommitter: (context) =>
          context.namespaceId === affected[1]!.proof[0]!.namespaceId
            ? otherSigning.publicKey
            : signing.publicKey,
      })
    ).toThrow("different committers across Namespaces");
    expect(crypto.randomCalls).toBe(before);
  });

  test("rejects a committer private key mismatch before randomness", () => {
    const { crypto, input } = setup();
    const before = crypto.randomCalls;

    expect(() =>
      prepareDomainEpochAdvanceV2({
        ...input,
        committer: {
          ...input.committer,
          signingPrivateKey: root(0xee),
        },
      })
    ).toThrow("private key does not match");
    expect(crypto.randomCalls).toBe(before);
  });

  test("enforces the revoke generation ceiling independently for Human and AI keyrings", () => {
    for (const keyClass of ["human", "ai"] as const) {
      const { crypto, input, makeNamespace } = setup();
      const atLimit = makeNamespace(`room-limit-${keyClass}`, {
        humanGenerations: keyClass === "human"
          ? V2_LIMITS.retainedNamespaceGenerations
          : 1,
        aiGenerations: keyClass === "ai"
          ? V2_LIMITS.retainedNamespaceGenerations
          : 1,
      });
      const before = crypto.randomCalls;

      expect(() =>
        prepareDomainEpochAdvanceV2({
          ...input,
          reason: "device_revoke",
          affected: [atLimit],
        })
      ).toThrow("retained generation limit");
      expect(crypto.randomCalls).toBe(before);
    }
  });

  test("allows the exact last retained generation and does not apply the ceiling to device add", () => {
    const nearLimit = setup();
    const atLastFreeSlot = nearLimit.makeNamespace("room-near-limit", {
      humanGenerations: V2_LIMITS.retainedNamespaceGenerations - 1,
      aiGenerations: V2_LIMITS.retainedNamespaceGenerations - 1,
    });
    const revoked = prepareDomainEpochAdvanceV2({
      ...nearLimit.input,
      reason: "device_revoke",
      affected: [atLastFreeSlot],
    });
    expect(
      openNamespaceKeyring({
        crypto: nearLimit.crypto,
        domainRoot: nearLimit.input.domain.nextHumanRoot,
        envelope: revoked.namespaces[0]!.humanEnvelope,
        resolveHistoricalCommitter: () => nearLimit.signing.publicKey,
      }).generations,
    ).toHaveLength(V2_LIMITS.retainedNamespaceGenerations);

    const atLimit = setup();
    const full = atLimit.makeNamespace("room-full", {
      humanGenerations: V2_LIMITS.retainedNamespaceGenerations,
      aiGenerations: V2_LIMITS.retainedNamespaceGenerations,
    });
    expect(
      prepareDomainEpochAdvanceV2({
        ...atLimit.input,
        reason: "device_add",
        affected: [full],
      }).namespaces,
    ).toHaveLength(1);
  });

  test("allows an empty device-add Domain and rejects empty revocation or the 256-Namespace ceiling before resolver work", () => {
    const { affected, crypto, input } = setup();
    let resolverCalls = 0;
    const before = crypto.randomCalls;
    expect(prepareDomainEpochAdvanceV2({
      ...input,
      reason: "device_add",
      affected: [],
      resolveHistoricalCommitter: () => {
        resolverCalls += 1;
        return null;
      },
    }).namespaces).toEqual([]);
    expect(() => prepareDomainEpochAdvanceV2({
      ...input,
      reason: "device_revoke",
      affected: [],
      resolveHistoricalCommitter: () => {
        resolverCalls += 1;
        return null;
      },
    })).toThrow(
      "Affected Namespaces must be between 1 and 256",
    );
    expect(() =>
      prepareDomainEpochAdvanceV2({
        ...input,
        affected: Array.from(
          { length: V2_LIMITS.namespacesPerDomainTransition + 1 },
          () => affected[0]!,
        ),
        resolveHistoricalCommitter: () => {
          resolverCalls += 1;
          return null;
        },
      })
    ).toThrow(
      "Affected Namespaces exceeds the 256 limit",
    );
    expect(resolverCalls).toBe(0);
    expect(crypto.randomCalls).toBe(before);
  });

  test("returns stable, detached, fully aligned CAS records without mutating old bindings", () => {
    const { affected, input } = setup();
    const oldHashes = affected.map((item) =>
      namespaceBindingHash(item.proof[0]!)
    );

    const prepared = prepareDomainEpochAdvanceV2(input);

    expect(prepared.namespaces.map((item) => item.expectedHead.bindingHash))
      .toEqual(oldHashes);
    expect(prepared.namespaces.map((item) => item.binding.namespaceId))
      .toEqual(affected.map((item) => item.proof[0]!.namespaceId));
    for (const [index, item] of prepared.namespaces.entries()) {
      const oldHash = oldHashes[index]!;
      const nextHash = namespaceBindingHash(item.binding);
      const bindingBytes = serializeNamespaceBinding(item.binding);
      const humanBytes = serializeNamespaceKeyringEnvelope(item.humanEnvelope);
      const aiBytes = serializeNamespaceKeyringEnvelope(item.aiEnvelope);

      expect(Object.keys(item.bindingRecord).sort()).toEqual([
        "aiKeyringEnvelope",
        "bindingHash",
        "humanKeyringEnvelope",
        "namespaceId",
        "previousBindingHash",
        "revision",
        "signedBindingBytes",
      ]);
      expect(item.bindingRecord.namespaceId).toBe(item.binding.namespaceId);
      expect(item.bindingRecord.revision).toBe(item.binding.accessRevision);
      expect(item.bindingRecord.bindingHash).toEqual(nextHash);
      expect(item.bindingRecord.previousBindingHash).toEqual(oldHash);
      expect(item.bindingRecord.signedBindingBytes).toEqual(bindingBytes);
      expect(item.bindingRecord.humanKeyringEnvelope).toMatchObject({
        classification: "opaque-ciphertext",
        kind: "human-keyring-envelope",
        ciphertext: humanBytes,
      });
      expect(item.bindingRecord.aiKeyringEnvelope).toMatchObject({
        classification: "opaque-ciphertext",
        kind: "ai-keyring-envelope",
        ciphertext: aiBytes,
      });

      expect(item.bindingRecord.bindingHash).not.toBe(
        item.nextHead.bindingHash,
      );
      expect(item.bindingRecord.previousBindingHash).not.toBe(
        item.expectedHead.bindingHash,
      );
      expect(item.bindingRecord.signedBindingBytes).not.toBe(
        item.bindingBytes,
      );

      item.nextHead.bindingHash[0] = item.nextHead.bindingHash[0]! ^ 1;
      item.expectedHead.bindingHash[0] =
        item.expectedHead.bindingHash[0]! ^ 1;
      item.bindingBytes[0] = item.bindingBytes[0]! ^ 1;
      expect(item.bindingRecord.bindingHash).toEqual(nextHash);
      expect(item.bindingRecord.previousBindingHash).toEqual(oldHash);
      expect(item.bindingRecord.signedBindingBytes).toEqual(bindingBytes);
    }
    expect(affected.map((item) => Number(item.proof[0]!.accessRevision)))
      .toEqual([0, 0]);
  });
});
