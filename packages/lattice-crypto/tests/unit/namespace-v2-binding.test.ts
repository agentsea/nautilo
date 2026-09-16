import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  seededRng,
} from "../../src/crypto/index.ts";
import {
  NAMESPACE_BINDING_DOMAIN,
  assertNamespaceBinding,
  namespaceBindingSigningBytes,
  parseNamespaceBinding,
  serializeNamespaceBinding,
} from "../../src/format/namespace-binding-v2.ts";
import {
  CanonicalDecodingError,
} from "../../src/format/v2-primitives.ts";
import {
  assertVerifiedNamespaceBindingHead,
  createNamespaceBinding,
  namespaceBindingHash,
  namespaceKeyringEnvelopeHash,
  verifyBindingEnvelopePair,
  verifyNamespaceBinding,
  verifyNamespaceBindingProof,
} from "../../src/namespace/bindings.ts";
import { createInitialNamespaceKeyrings, sealNamespaceKeyring } from "../../src/namespace/keyrings.ts";
import type {
  NamespaceBindingAnchorV2,
  NamespaceBindingV2,
  NamespaceKeyringEnvelopeV2,
} from "../../src/namespace/types.ts";
import {
  accessRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  namespaceGeneration,
  namespaceId,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

function bytes(value: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(value);
}

class CaptureSignatureCrypto extends LatticeCrypto {
  lastSignature: Uint8Array | null = null;

  override sign(
    signingPrivateKey: Uint8Array,
    message: Uint8Array,
  ): Uint8Array {
    const signature = super.sign(signingPrivateKey, message);
    this.lastSignature = signature;
    return signature;
  }
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  for (
    let offset = 0;
    offset <= haystack.length - needle.length;
    offset += 1
  ) {
    if (needle.every((byte, index) => haystack[offset + index] === byte)) {
      return offset;
    }
  }
  return -1;
}

function fixtureBinding(): NamespaceBindingV2 {
  return {
    formatVersion: 2,
    namespaceId: namespaceId("ns_room"),
    domainId: cryptoDomainId("domain_ab"),
    domainEpoch: domainEpoch(2),
    accessRevision: accessRevision(3),
    humanCurrentGeneration: namespaceGeneration(4),
    aiCurrentGeneration: namespaceGeneration(5),
    previousBindingHash: bytes(0xaa),
    humanKeyringEnvelopeHash: bytes(0xbb),
    aiKeyringEnvelopeHash: bytes(0xcc),
    committerDeviceId: cryptoDeviceId("device_alice"),
    signature: bytes(0xdd, 64),
  };
}

function envelopePair(
  crypto: LatticeCrypto,
  signingPrivateKey: Uint8Array,
  signingPublicKey: Uint8Array,
  revision: number,
  previousBindingHash: Uint8Array | null,
): readonly [NamespaceKeyringEnvelopeV2, NamespaceKeyringEnvelopeV2] {
  const keyrings = createInitialNamespaceKeyrings(
    crypto,
    namespaceId("ns_room"),
  );
  const humanKeyring = {
    ...keyrings.human,
    accessRevision: accessRevision(revision),
  };
  const aiKeyring = {
    ...keyrings.ai,
    accessRevision: accessRevision(revision),
  };
  const metadata = {
    domainId: cryptoDomainId(revision === 0 ? "domain_ab" : "domain_abc"),
    domainEpoch: domainEpoch(revision + 1),
    previousBindingHash,
    committerDeviceId: cryptoDeviceId("device_alice"),
  };
  return [
    sealNamespaceKeyring({
      crypto,
      domainRoot: bytes(0x70 + revision),
      keyring: humanKeyring,
      metadata,
      committerSigningPrivateKey: signingPrivateKey,
      resolveCurrentCommitter: () => signingPublicKey,
    }),
    sealNamespaceKeyring({
      crypto,
      domainRoot: bytes(0x80 + revision),
      keyring: aiKeyring,
      metadata,
      committerSigningPrivateKey: signingPrivateKey,
      resolveCurrentCommitter: () => signingPublicKey,
    }),
  ];
}

function resignBinding(
  crypto: LatticeCrypto,
  signingPrivateKey: Uint8Array,
  binding: NamespaceBindingV2,
): NamespaceBindingV2 {
  const unsigned = { ...binding, signature: bytes(0, 64) };
  return {
    ...unsigned,
    signature: crypto.sign(
      signingPrivateKey,
      namespaceBindingSigningBytes(unsigned),
    ),
  };
}

describe("Namespace binding v2 canonical format", () => {
  test("locks the exact domain and signing fixture", () => {
    expect(NAMESPACE_BINDING_DOMAIN).toBe(
      "nautilo/lattice-crypto/namespace-binding/v2",
    );
    expect(hex(namespaceBindingSigningBytes(fixtureBinding()))).toBe(
      "0000002b6e617574696c6f2f6c6174746963652d63727970746f2f6e616d6573706163652d62696e64696e672f7632" +
        "000000116e616d6573706163652d62696e64696e67" +
        "00000002" +
        "000000076e735f726f6f6d" +
        "00000009646f6d61696e5f6162" +
        "0000000000000002" +
        "0000000000000003" +
        "0000000000000004" +
        "0000000000000005" +
        `00000020${"aa".repeat(32)}` +
        `00000020${"bb".repeat(32)}` +
        `00000020${"cc".repeat(32)}` +
        "0000000c6465766963655f616c696365",
    );
  });

  test("strictly round-trips and rejects malformed binding wire", () => {
    const binding = fixtureBinding();
    const wire = serializeNamespaceBinding(binding);
    const decoded = parseNamespaceBinding(wire);
    expect(serializeNamespaceBinding(decoded)).toEqual(wire);
    expect(() =>
      parseNamespaceBinding(new Uint8Array([...wire, 0]))
    ).toThrow("trailing bytes");
    expect(() =>
      serializeNamespaceBinding({ ...binding, previousBindingHash: null })
    ).toThrow("binding hash");
    expect(() =>
      serializeNamespaceBinding({
        ...binding,
        humanKeyringEnvelopeHash: bytes(1, 31),
      })
    ).toThrow("32 bytes");
    expect(() =>
      serializeNamespaceBinding({
        ...binding,
        unexpected: true,
      } as NamespaceBindingV2)
    ).toThrow("unknown field");
  });

  test("validates the complete canonical binding shape and revision/hash relation", () => {
    const binding = fixtureBinding();

    expect(() => assertNamespaceBinding(null as never)).toThrow(
      "must be an object",
    );
    expect(() => assertNamespaceBinding(42 as never)).toThrow(
      "must be an object",
    );
    expect(() =>
      assertNamespaceBinding({
        ...binding,
        formatVersion: 1,
      } as never)
    ).toThrow("version is unsupported");
    expect(() =>
      assertNamespaceBinding({
        ...binding,
        previousBindingHash: bytes(0xaa, 31),
      })
    ).toThrow("Previous binding hash must contain exactly 32 bytes");
    expect(() =>
      assertNamespaceBinding({
        ...binding,
        humanKeyringEnvelopeHash: bytes(0xbb, 31),
      })
    ).toThrow("Human keyring envelope hash must contain exactly 32 bytes");
    expect(() =>
      assertNamespaceBinding({
        ...binding,
        aiKeyringEnvelopeHash: bytes(0xcc, 31),
      })
    ).toThrow("AI keyring envelope hash must contain exactly 32 bytes");
    expect(() =>
      assertNamespaceBinding({
        ...binding,
        signature: bytes(0xdd, V2_LIMITS.signatureBytes - 1),
      })
    ).toThrow("Namespace binding signature must contain exactly 64 bytes");
    expect(() =>
      assertNamespaceBinding({
        ...binding,
        unexpected: true,
      } as NamespaceBindingV2)
    ).toThrow("Namespace binding contains unknown field unexpected");
    expect(() =>
      assertNamespaceBinding({
        ...binding,
        accessRevision: accessRevision(0),
      })
    ).toThrow("empty only at access revision zero");
    expect(() =>
      assertNamespaceBinding({
        ...binding,
        previousBindingHash: null,
      })
    ).toThrow("empty only at access revision zero");
  });

  test("strict parser binds its domain, purpose, wire ceiling, and nullable previous hash", () => {
    const binding = fixtureBinding();
    const wire = serializeNamespaceBinding(binding);
    const domainOffset = 4;
    const purposeOffset = domainOffset
      + new TextEncoder().encode(NAMESPACE_BINDING_DOMAIN).length
      + 4;
    const wrongDomain = wire.slice();
    wrongDomain[domainOffset] = wrongDomain[domainOffset]! ^ 1;
    const wrongPurpose = wire.slice();
    wrongPurpose[purposeOffset] = wrongPurpose[purposeOffset]! ^ 1;

    expect(() => parseNamespaceBinding(wrongDomain)).toThrow(
      "domain is unsupported",
    );
    expect(() => parseNamespaceBinding(wrongPurpose)).toThrow(
      "purpose is unsupported",
    );
    expect(() => parseNamespaceBinding(new Uint8Array(4_097))).toThrow(
      "wire limit",
    );
    expect(() => parseNamespaceBinding(new Uint8Array(4_096))).toThrow(
      "domain is unsupported",
    );

    const initial = {
      ...binding,
      accessRevision: accessRevision(0),
      previousBindingHash: null,
    };
    expect(
      parseNamespaceBinding(serializeNamespaceBinding(initial))
        .previousBindingHash,
    ).toBeNull();
  });

  test("rejects a nonempty short previous hash as a canonical decoding error", () => {
    const wire = serializeNamespaceBinding(fixtureBinding());
    const framedPrevious = new Uint8Array([
      0,
      0,
      0,
      32,
      ...bytes(0xaa),
    ]);
    const offset = findBytes(wire, framedPrevious);
    expect(offset).toBeGreaterThan(-1);
    const malformed = new Uint8Array([
      ...wire.slice(0, offset),
      0,
      0,
      0,
      31,
      ...bytes(0xaa, 31),
      ...wire.slice(offset + framedPrevious.length),
    ]);

    expect(() => parseNamespaceBinding(malformed)).toThrow(
      CanonicalDecodingError,
    );
    expect(() => parseNamespaceBinding(malformed)).toThrow(
      "Previous binding hash",
    );
  });
});

describe("Namespace binding verification and retained anchors", () => {
  test("creates a signed immutable binding over the exact envelope pair", () => {
    const crypto = new LatticeCrypto(seededRng(0x9999));
    const signing = crypto.generateSigningKeyPair();
    const [human, ai] = envelopePair(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );
    const binding = createNamespaceBinding({
      crypto,
      humanEnvelope: human,
      aiEnvelope: ai,
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: () => signing.publicKey,
    });

    expect(Object.isFrozen(binding)).toBe(true);
    expect(
      verifyNamespaceBinding({
        crypto,
        binding,
        resolveHistoricalCommitter(context) {
          expect(Number(context.domainEpoch)).toBe(1);
          return signing.publicKey;
        },
      }),
    ).toBe(true);
    expect(
      verifyBindingEnvelopePair(binding, human, ai),
    ).toBe(true);
    expect(
      verifyBindingEnvelopePair(
        binding,
        { ...human, ciphertext: bytes(0xff, human.ciphertext.length) },
        ai,
      ),
    ).toBe(false);
    const pairSubstitutions: readonly [
      NamespaceBindingV2,
      NamespaceKeyringEnvelopeV2,
      NamespaceKeyringEnvelopeV2,
    ][] = [
      [{ ...binding, namespaceId: namespaceId("ns_other") }, human, ai],
      [{ ...binding, domainId: cryptoDomainId("domain_other") }, human, ai],
      [{ ...binding, domainEpoch: domainEpoch(2) }, human, ai],
      [{ ...binding, accessRevision: accessRevision(1) }, human, ai],
      [
        { ...binding, committerDeviceId: cryptoDeviceId("device_other") },
        human,
        ai,
      ],
      [
        {
          ...binding,
          humanCurrentGeneration: namespaceGeneration(2),
        },
        human,
        ai,
      ],
      [
        {
          ...binding,
          aiCurrentGeneration: namespaceGeneration(2),
        },
        human,
        ai,
      ],
      [{ ...binding, previousBindingHash: bytes(1) }, human, ai],
      [{ ...binding, humanKeyringEnvelopeHash: bytes(1) }, human, ai],
      [{ ...binding, aiKeyringEnvelopeHash: bytes(1) }, human, ai],
      [binding, { ...human, keyClass: "ai" }, ai],
      [binding, human, { ...ai, keyClass: "human" }],
      [binding, human, { ...ai, namespaceId: namespaceId("ns_other") }],
      [binding, human, { ...ai, domainId: cryptoDomainId("domain_other") }],
      [binding, human, { ...ai, domainEpoch: domainEpoch(2) }],
      [binding, human, { ...ai, accessRevision: accessRevision(1) }],
      [
        binding,
        human,
        { ...ai, committerDeviceId: cryptoDeviceId("device_other") },
      ],
      [binding, human, { ...ai, previousBindingHash: bytes(1) }],
    ];
    for (const [candidate, candidateHuman, candidateAi] of pairSubstitutions) {
      expect(
        verifyBindingEnvelopePair(candidate, candidateHuman, candidateAi),
      ).toBe(false);
    }
    expect(
      verifyBindingEnvelopePair(
        binding,
        { ...human, signature: bytes(1, 63) },
        ai,
      ),
    ).toBe(false);
    const wrongHumanClass = { ...human, keyClass: "ai" as const };
    expect(
      verifyBindingEnvelopePair(
        {
          ...binding,
          humanKeyringEnvelopeHash:
            namespaceKeyringEnvelopeHash(wrongHumanClass),
        },
        wrongHumanClass,
        ai,
      ),
    ).toBe(false);
    const wrongAiClass = { ...ai, keyClass: "human" as const };
    expect(
      verifyBindingEnvelopePair(
        {
          ...binding,
          aiKeyringEnvelopeHash: namespaceKeyringEnvelopeHash(wrongAiClass),
        },
        human,
        wrongAiClass,
      ),
    ).toBe(false);
    const crossNamespaceAi = {
      ...ai,
      namespaceId: namespaceId("ns_other"),
    };
    expect(
      verifyBindingEnvelopePair(
        {
          ...binding,
          aiKeyringEnvelopeHash:
            namespaceKeyringEnvelopeHash(crossNamespaceAi),
        },
        human,
        crossNamespaceAi,
      ),
    ).toBe(false);

    const tamperedSignature = binding.signature.slice();
    tamperedSignature[0] = tamperedSignature[0]! ^ 1;
    expect(() =>
      verifyNamespaceBinding({
        crypto,
        binding: { ...binding, signature: tamperedSignature },
        resolveHistoricalCommitter: () => signing.publicKey,
      })
    ).toThrow("signature");
  });

  test("rejects every mismatched envelope class and metadata coordinate before signing", () => {
    const crypto = new LatticeCrypto(seededRng(0x8181));
    const signing = crypto.generateSigningKeyPair();
    const previousBindingHash = bytes(0x71);
    const [human, ai] = envelopePair(
      crypto,
      signing.privateKey,
      signing.publicKey,
      1,
      previousBindingHash,
    );
    const mismatchedPairs: readonly [
      NamespaceKeyringEnvelopeV2,
      NamespaceKeyringEnvelopeV2,
    ][] = [
      [{ ...human, keyClass: "ai" }, ai],
      [human, { ...ai, keyClass: "human" }],
      [human, { ...ai, namespaceId: namespaceId("ns_other") }],
      [human, { ...ai, domainId: cryptoDomainId("domain_other") }],
      [human, { ...ai, domainEpoch: domainEpoch(3) }],
      [human, { ...ai, accessRevision: accessRevision(2) }],
      [
        human,
        { ...ai, committerDeviceId: cryptoDeviceId("device_other") },
      ],
      [human, { ...ai, previousBindingHash: bytes(0x72) }],
    ];
    let resolverCalls = 0;

    for (const [candidateHuman, candidateAi] of mismatchedPairs) {
      expect(() =>
        createNamespaceBinding({
          crypto,
          humanEnvelope: candidateHuman,
          aiEnvelope: candidateAi,
          committerSigningPrivateKey: signing.privateKey,
          resolveCurrentCommitter: () => {
            resolverCalls += 1;
            return signing.publicKey;
          },
        })
      ).toThrow(
        "Namespace binding requires one matching Human and AI keyring envelope",
      );
    }
    expect(resolverCalls).toBe(0);

    const binding = createNamespaceBinding({
      crypto,
      humanEnvelope: human,
      aiEnvelope: ai,
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: () => signing.publicKey,
    });
    expect(() =>
      createNamespaceBinding({
        crypto,
        humanEnvelope: { ...human, previousBindingHash: null },
        aiEnvelope: ai,
        committerSigningPrivateKey: signing.privateKey,
        resolveCurrentCommitter: () => signing.publicKey,
      })
    ).toThrow();
    expect(
      verifyBindingEnvelopePair(
        binding,
        { ...human, previousBindingHash: null },
        ai,
      ),
    ).toBe(false);
    for (const [, candidateAi] of mismatchedPairs.slice(2)) {
      expect(
        verifyBindingEnvelopePair(
          {
            ...binding,
            aiKeyringEnvelopeHash: namespaceKeyringEnvelopeHash(candidateAi),
          },
          human,
          candidateAi,
        ),
      ).toBe(false);
    }
  });

  test("binds current authorization to an isolated exact context and detaches output bytes", () => {
    const crypto = new CaptureSignatureCrypto(seededRng(0x8282));
    const signing = crypto.generateSigningKeyPair();
    const previousBindingHash = bytes(0x73);
    const [human, ai] = envelopePair(
      crypto,
      signing.privateKey,
      signing.publicKey,
      1,
      previousBindingHash,
    );
    const binding = createNamespaceBinding({
      crypto,
      humanEnvelope: human,
      aiEnvelope: ai,
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter(context) {
        expect(Object.isFrozen(context)).toBe(true);
        expect(context).toEqual({
          purpose: "namespace-binding",
          namespaceId: human.namespaceId,
          domainId: human.domainId,
          domainEpoch: human.domainEpoch,
          accessRevision: human.accessRevision,
          committerDeviceId: human.committerDeviceId,
          previousBindingHash,
        });
        context.previousBindingHash![0] = 0x74;
        return signing.publicKey;
      },
    });
    const returnedSignature = crypto.lastSignature!;
    const expectedSignature = binding.signature.slice();

    expect(human.previousBindingHash).toEqual(previousBindingHash);
    expect(binding.previousBindingHash).toEqual(previousBindingHash);
    human.previousBindingHash![0] = 0x75;
    returnedSignature[0] = returnedSignature[0]! ^ 1;
    expect(binding.previousBindingHash).toEqual(previousBindingHash);
    expect(binding.signature).toEqual(expectedSignature);
  });

  test("rejects unauthorized, malformed, and mismatched current signing credentials exactly", () => {
    const crypto = new LatticeCrypto(seededRng(0x8383));
    const signing = crypto.generateSigningKeyPair();
    const otherSigning = crypto.generateSigningKeyPair();
    const [human, ai] = envelopePair(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );
    const base = {
      crypto,
      humanEnvelope: human,
      aiEnvelope: ai,
    };

    expect(() =>
      createNamespaceBinding({
        ...base,
        committerSigningPrivateKey: bytes(1, 31),
        resolveCurrentCommitter: () => signing.publicKey,
      })
    ).toThrow(
      "Committer signing private key must contain exactly 32 bytes",
    );
    expect(() =>
      createNamespaceBinding({
        ...base,
        committerSigningPrivateKey: signing.privateKey,
        resolveCurrentCommitter: () => null,
      })
    ).toThrow(
      "Namespace binding current committer is not authorized and unrevoked",
    );
    expect(() =>
      createNamespaceBinding({
        ...base,
        committerSigningPrivateKey: signing.privateKey,
        resolveCurrentCommitter: () => bytes(1, 31),
      })
    ).toThrow(
      "Current committer signing public key must contain exactly 32 bytes",
    );
    expect(() =>
      createNamespaceBinding({
        ...base,
        committerSigningPrivateKey: otherSigning.privateKey,
        resolveCurrentCommitter: () => signing.publicKey,
      })
    ).toThrow(
      "Namespace binding committer private key does not match the registered device",
    );
  });

  test("binds historical authorization to an isolated exact context", () => {
    const crypto = new LatticeCrypto(seededRng(0x8484));
    const signing = crypto.generateSigningKeyPair();
    const previousBindingHash = bytes(0x76);
    const [human, ai] = envelopePair(
      crypto,
      signing.privateKey,
      signing.publicKey,
      1,
      previousBindingHash,
    );
    const binding = createNamespaceBinding({
      crypto,
      humanEnvelope: human,
      aiEnvelope: ai,
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: () => signing.publicKey,
    });

    expect(
      verifyNamespaceBinding({
        crypto,
        binding,
        resolveHistoricalCommitter(context) {
          expect(Object.isFrozen(context)).toBe(true);
          expect(context).toEqual({
            purpose: "namespace-binding",
            namespaceId: binding.namespaceId,
            domainId: binding.domainId,
            domainEpoch: binding.domainEpoch,
            accessRevision: binding.accessRevision,
            committerDeviceId: binding.committerDeviceId,
            previousBindingHash,
          });
          context.previousBindingHash![0] = 0x77;
          return signing.publicKey;
        },
      }),
    ).toBe(true);
    expect(binding.previousBindingHash).toEqual(previousBindingHash);
    expect(() =>
      verifyNamespaceBinding({
        crypto,
        binding,
        resolveHistoricalCommitter: () => bytes(1, 31),
      })
    ).toThrow(
      "Historical committer signing public key must contain exactly 32 bytes",
    );
  });

  test("historical authorization survives later revocation but cannot be replaced by current state", () => {
    const crypto = new LatticeCrypto(seededRng(0x123));
    const signing = crypto.generateSigningKeyPair();
    const [human, ai] = envelopePair(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );
    const binding = createNamespaceBinding({
      crypto,
      humanEnvelope: human,
      aiEnvelope: ai,
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: () => signing.publicKey,
    });
    const currentlyRevoked = true;

    expect(
      verifyNamespaceBinding({
        crypto,
        binding,
        resolveHistoricalCommitter: (context) =>
          context.domainEpoch === 1 ? signing.publicKey : null,
      }),
    ).toBe(true);
    expect(currentlyRevoked).toBe(true);
    expect(() =>
      verifyNamespaceBinding({
        crypto,
        binding,
        resolveHistoricalCommitter: () => null,
      })
    ).toThrow("historical roster");
  });

  test("verifies a contiguous hash chain from a minimum trusted anchor", () => {
    const crypto = new LatticeCrypto(seededRng(0xabcd));
    const signing = crypto.generateSigningKeyPair();
    const [human0, ai0] = envelopePair(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );
    const binding0 = createNamespaceBinding({
      crypto,
      humanEnvelope: human0,
      aiEnvelope: ai0,
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: () => signing.publicKey,
    });
    const hash0 = namespaceBindingHash(binding0);
    const [human1, ai1] = envelopePair(
      crypto,
      signing.privateKey,
      signing.publicKey,
      1,
      hash0,
    );
    const binding1 = createNamespaceBinding({
      crypto,
      humanEnvelope: human1,
      aiEnvelope: ai1,
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: () => signing.publicKey,
    });
    const hash1 = namespaceBindingHash(binding1);
    expect(verifyBindingEnvelopePair(binding1, human1, ai1)).toBe(true);
    expect(
      verifyBindingEnvelopePair(
        { ...binding1, accessRevision: accessRevision(2) },
        human1,
        ai1,
      ),
    ).toBe(false);
    expect(
      verifyBindingEnvelopePair(
        { ...binding1, previousBindingHash: bytes(1) },
        human1,
        ai1,
      ),
    ).toBe(false);
    const anchor0: NamespaceBindingAnchorV2 = {
      namespaceId: namespaceId("ns_room"),
      accessRevision: accessRevision(0),
      bindingHash: hash0,
    };

    const verified = verifyNamespaceBindingProof({
      crypto,
      anchor: anchor0,
      proof: [binding0, binding1],
      resolveHistoricalCommitter: () => signing.publicKey,
    });
    expect(Number(verified.accessRevision)).toBe(1);
    expect(verified.bindingHash).toEqual(hash1);
    expect(() => assertVerifiedNamespaceBindingHead(verified)).not.toThrow();
    expect(() =>
      assertVerifiedNamespaceBindingHead({ ...verified })
    ).toThrow(
      "Namespace binding head requires an anchored proof-verifier capability",
    );
    expect(
      verifyNamespaceBindingProof({
        crypto,
        anchor: null,
        proof: [binding0, binding1],
        resolveHistoricalCommitter: () => signing.publicKey,
      }).bindingHash,
    ).toEqual(hash1);
    expect(
      verifyNamespaceBindingProof({
        crypto,
        anchor: anchor0,
        proof: [binding1],
        resolveHistoricalCommitter: () => signing.publicKey,
      }).bindingHash,
    ).toEqual(hash1);

    const [alternateHuman0, alternateAi0] = envelopePair(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );
    const alternateBinding0 = createNamespaceBinding({
      crypto,
      humanEnvelope: alternateHuman0,
      aiEnvelope: alternateAi0,
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: () => signing.publicKey,
    });
    let rollbackResolverCalls = 0;
    expect(() =>
      verifyNamespaceBindingProof({
        crypto,
        anchor: anchor0,
        proof: [alternateBinding0],
        resolveHistoricalCommitter: () => signing.publicKey,
      })
    ).toThrow("trusted revision");

    expect(() =>
      verifyNamespaceBindingProof({
        crypto,
        anchor: {
          ...anchor0,
          accessRevision: accessRevision(1),
          bindingHash: hash1,
        },
        proof: [binding0],
        resolveHistoricalCommitter: () => {
          rollbackResolverCalls++;
          return signing.publicKey;
        },
      })
    ).toThrow("gap");
    expect(rollbackResolverCalls).toBe(0);
    const brokenLink = resignBinding(crypto, signing.privateKey, {
      ...binding1,
      previousBindingHash: bytes(0xee),
    });
    expect(() =>
      verifyNamespaceBindingProof({
        crypto,
        anchor: anchor0,
        proof: [binding0, brokenLink],
        resolveHistoricalCommitter: () => signing.publicKey,
      })
    ).toThrow("Namespace binding proof has broken hash linkage");

    const gap = resignBinding(crypto, signing.privateKey, {
      ...binding1,
      accessRevision: accessRevision(2),
    });
    expect(() =>
      verifyNamespaceBindingProof({
        crypto,
        anchor: anchor0,
        proof: [gap],
        resolveHistoricalCommitter: () => signing.publicKey,
      })
    ).toThrow("gap");
    const wrongNamespace = resignBinding(crypto, signing.privateKey, {
      ...binding1,
      namespaceId: namespaceId("ns_other"),
    });
    expect(() =>
      verifyNamespaceBindingProof({
        crypto,
        anchor: anchor0,
        proof: [wrongNamespace],
        resolveHistoricalCommitter: () => signing.publicKey,
      })
    ).toThrow("Namespace identity");
    expect(() =>
      verifyNamespaceBindingProof({
        crypto,
        anchor: null,
        proof: [binding0, binding0],
        resolveHistoricalCommitter: () => signing.publicKey,
      })
    ).toThrow("gap");
    expect(() =>
      verifyNamespaceBindingProof({
        crypto,
        anchor: null,
        proof: [binding0, wrongNamespace],
        resolveHistoricalCommitter: () => signing.publicKey,
      })
    ).toThrow("Namespace identity");
    expect(() =>
      verifyNamespaceBindingProof({
        crypto,
        anchor: { ...anchor0, bindingHash: bytes(1, 31) },
        proof: [binding1],
        resolveHistoricalCommitter: () => signing.publicKey,
      })
    ).toThrow(
      "Namespace binding anchor hash must contain exactly 32 bytes",
    );

    verified.bindingHash[0] = verified.bindingHash[0]! ^ 1;
    expect(() => assertVerifiedNamespaceBindingHead(verified)).toThrow(
      "Namespace binding head requires an anchored proof-verifier capability",
    );

    const mutableBinding = {
      ...binding0,
      signature: binding0.signature.slice(),
    };
    const mutableHead = verifyNamespaceBindingProof({
      crypto,
      anchor: null,
      proof: [mutableBinding],
      resolveHistoricalCommitter: () => signing.publicKey,
    });
    expect(() =>
      assertVerifiedNamespaceBindingHead(mutableHead)
    ).not.toThrow();
    mutableBinding.namespaceId = namespaceId("n");
    expect(() => assertVerifiedNamespaceBindingHead(mutableHead)).toThrow(
      "Namespace binding head requires an anchored proof-verifier capability",
    );
  });

  test("enforces the proof limit before historical roster work", () => {
    const crypto = new LatticeCrypto(seededRng(0x42));
    const binding = fixtureBinding();
    let resolverCalls = 0;
    expect(() =>
      verifyNamespaceBindingProof({
        crypto,
        anchor: null,
        proof: [],
        resolveHistoricalCommitter: () => {
          resolverCalls++;
          return bytes(1);
        },
      })
    ).toThrow(
      "Namespace binding proof entries must be between 1 and 256",
    );
    expect(() =>
      verifyNamespaceBindingProof({
        crypto,
        anchor: null,
        proof: Array.from(
          { length: V2_LIMITS.proofEntriesPerSegment + 1 },
          () => binding,
        ),
        resolveHistoricalCommitter: () => {
          resolverCalls++;
          return bytes(1);
        },
      })
    ).toThrow(
      "Namespace binding proof entries exceeds the 256 limit",
    );
    expect(resolverCalls).toBe(0);
  });
});
