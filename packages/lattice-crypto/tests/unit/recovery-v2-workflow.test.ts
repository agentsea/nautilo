import { describe, expect, test } from "bun:test";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  humanRecoveryArchiveSigningBytes,
  namespaceRecoveryPackageAad,
  namespaceRecoveryPackageSigningBytes,
  recoveryKeyGeneration,
  recoveryPublicKeyDigest,
  serializeHumanRecoveryArchive,
  type HumanRecoveryArchiveV2,
  type NamespaceRecoveryPackageV2,
} from "../../src/format/recovery-v2.ts";
import {
  encodeNamespaceKeyring,
} from "../../src/format/namespace-keyring-v2.ts";
import {
  namespaceBindingSigningBytes,
} from "../../src/format/namespace-binding-v2.ts";
import { concatV2, frame } from "../../src/format/v2-primitives.ts";
import {
  createNamespaceBinding,
  verifyNamespaceBindingProof,
} from "../../src/namespace/bindings.ts";
import {
  sealNamespaceKeyring,
} from "../../src/namespace/keyrings.ts";
import type {
  NamespaceBindingV2,
  NamespaceKeyClass,
  NamespaceKeyringPlaintextV2,
} from "../../src/namespace/types.ts";
import {
  assertHumanRecoveryArchiveAggregateBytesV2,
  assertOpenedHumanRecoveryArchiveV2,
  openHumanRecoveryArchiveV2,
  publishHumanRecoveryArchiveV2,
  type HumanRecoveryIssuerContextV2,
  type HumanRecoveryInventoryItemV2,
  type HumanRecoveryKeyringSourceV2,
} from "../../src/recovery/human-archive-v2.ts";
import {
  accessRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceGeneration,
  namespaceId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

function bytes(value: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(value);
}

class LengthSpoofedBytes extends Uint8Array {
  constructor(private readonly spoofedLength: number) {
    super(1);
  }

  override get length(): number {
    return this.spoofedLength;
  }
}

function isZeroized(value: Uint8Array | null): boolean {
  return value !== null && value.every((byte) => byte === 0);
}

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  return haystack.some((_, offset) =>
    offset + needle.length <= haystack.length
    && needle.every((byte, index) => haystack[offset + index] === byte)
  );
}

function expectExactError(action: () => unknown, message: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    return;
  }
  throw new Error(`expected exact error: ${message}`);
}

async function expectExactRejection(
  action: () => Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    return;
  }
  throw new Error(`expected exact rejection: ${message}`);
}

function completeKeyring(
  targetNamespace: string,
  keyClass: NamespaceKeyClass,
): NamespaceKeyringPlaintextV2 {
  return {
    formatVersion: 2,
    namespaceId: namespaceId(targetNamespace),
    keyClass,
    accessRevision: accessRevision(0),
    currentGeneration: namespaceGeneration(1),
    generations: [
      { generation: namespaceGeneration(0), key: bytes(keyClass === "human" ? 0x11 : 0x21) },
      { generation: namespaceGeneration(1), key: bytes(keyClass === "human" ? 0x12 : 0x22) },
    ],
  };
}

async function setup() {
  const crypto = new LatticeCrypto(seededRng(0x5ec0));
  const signing = crypto.generateSigningKeyPair();
  const issuerDeviceId = cryptoDeviceId("device_alice");
  const targetHumanId = humanId("human_alice");
  const human = completeKeyring("namespace_room", "human");
  const ai = completeKeyring("namespace_room", "ai");
  const metadata = {
    domainId: cryptoDomainId("domain_ab"),
    domainEpoch: domainEpoch(1),
    previousBindingHash: null,
    committerDeviceId: issuerDeviceId,
  };
  const humanEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: bytes(0x31),
    keyring: human,
    metadata,
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: () => signing.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: bytes(0x41),
    keyring: ai,
    metadata,
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: () => signing.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: () => signing.publicKey,
  });
  const trustedHead = verifyNamespaceBindingProof({
    crypto,
    anchor: null,
    proof: [binding],
    resolveHistoricalCommitter: () => signing.publicKey,
  });
  const kit = await crypto.createRecoveryKit();
  const recoveryKeyPair = await crypto.deriveEncryptionKeyPair(kit.secret);
  const recoveryGeneration = recoveryKeyGeneration(1);
  const resolveTrustedCurrentRecoveryKey = () => ({
    humanId: targetHumanId,
    recoveryKeyId: kit.keyId,
    recoveryGeneration,
    publicKeyDigest: recoveryPublicKeyDigest(recoveryKeyPair.publicKey),
  });
  const createdAt = unixTimestamp(1_700_000_000_000);
  const sources: readonly HumanRecoveryKeyringSourceV2[] = [
    {
      authorizedHumanId: targetHumanId,
      trustedNamespaceHead: trustedHead,
      keyClass: "human",
      currentKeyringEnvelope: humanEnvelope,
      currentDomainRoot: bytes(0x31),
      resolveHistoricalCommitter: () => signing.publicKey,
    },
    {
      authorizedHumanId: targetHumanId,
      trustedNamespaceHead: trustedHead,
      keyClass: "ai",
      currentKeyringEnvelope: aiEnvelope,
      currentDomainRoot: bytes(0x41),
      resolveHistoricalCommitter: () => signing.publicKey,
    },
  ];
  const expectedInventory: readonly HumanRecoveryInventoryItemV2[] =
    sources.map(({ authorizedHumanId, trustedNamespaceHead, keyClass }) => ({
      authorizedHumanId,
      trustedNamespaceHead,
      keyClass,
    }));
  const resolveIssuerDevice = () => signing.publicKey;
  const publish = (
    overrides: Partial<Parameters<
      typeof publishHumanRecoveryArchiveV2
    >[0]> = {},
  ) =>
    publishHumanRecoveryArchiveV2({
      crypto,
      humanId: targetHumanId,
      recoveryKeyId: kit.keyId,
      recoveryGeneration,
      recoveryPublicKey: recoveryKeyPair.publicKey,
      resolveTrustedCurrentRecoveryKey,
      issuerDeviceId,
      createdAt,
      sources,
      issuerSigningPrivateKey: signing.privateKey,
      resolveIssuerDevice,
      ...overrides,
    });
  const open = (
    archiveBytes: Uint8Array,
    overrides: Partial<Parameters<
      typeof openHumanRecoveryArchiveV2
    >[0]> = {},
  ) =>
    openHumanRecoveryArchiveV2({
      crypto,
      archiveBytes,
      humanId: targetHumanId,
      currentRecoveryKeyId: kit.keyId,
      currentRecoveryGeneration: recoveryGeneration,
      recoveryPrivateKey: recoveryKeyPair.privateKey,
      resolveTrustedCurrentRecoveryKey,
      expectedInventory,
      resolveIssuerDevice,
      ...overrides,
    });
  return {
    crypto,
    signing,
    issuerDeviceId,
    targetHumanId,
    human,
    ai,
    humanEnvelope,
    aiEnvelope,
    binding,
    trustedHead,
    kit,
    recoveryKeyPair,
    recoveryGeneration,
    resolveTrustedCurrentRecoveryKey,
    createdAt,
    sources,
    expectedInventory,
    resolveIssuerDevice,
    publish,
    open,
  };
}

function replacementHumanSource(
  scenario: Awaited<ReturnType<typeof setup>>,
  keyring: NamespaceKeyringPlaintextV2,
): HumanRecoveryKeyringSourceV2 {
  const root = bytes(0x61);
  const metadata = {
    domainId: cryptoDomainId("domain_replacement"),
    domainEpoch: domainEpoch(1),
    previousBindingHash: null,
    committerDeviceId: scenario.issuerDeviceId,
  };
  const humanEnvelope = sealNamespaceKeyring({
    crypto: scenario.crypto,
    domainRoot: root,
    keyring,
    metadata,
    committerSigningPrivateKey: scenario.signing.privateKey,
    resolveCurrentCommitter: () => scenario.signing.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto: scenario.crypto,
    domainRoot: bytes(0x62),
    keyring: scenario.ai,
    metadata,
    committerSigningPrivateKey: scenario.signing.privateKey,
    resolveCurrentCommitter: () => scenario.signing.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto: scenario.crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: scenario.signing.privateKey,
    resolveCurrentCommitter: () => scenario.signing.publicKey,
  });
  const trustedNamespaceHead = verifyNamespaceBindingProof({
    crypto: scenario.crypto,
    anchor: null,
    proof: [binding],
    resolveHistoricalCommitter: () => scenario.signing.publicKey,
  });
  return {
    authorizedHumanId: scenario.targetHumanId,
    trustedNamespaceHead,
    keyClass: "human",
    currentKeyringEnvelope: humanEnvelope,
    currentDomainRoot: root,
    resolveHistoricalCommitter: () => scenario.signing.publicKey,
  };
}

async function resignArchive(
  crypto: LatticeCrypto,
  signingPrivateKey: Uint8Array,
  archive: HumanRecoveryArchiveV2,
  packages: readonly NamespaceRecoveryPackageV2[],
): Promise<Uint8Array> {
  const unsigned: HumanRecoveryArchiveV2 = {
    ...archive,
    packages,
    signature: bytes(0, V2_LIMITS.signatureBytes),
  };
  const signed: HumanRecoveryArchiveV2 = {
    ...unsigned,
    signature: crypto.sign(
      signingPrivateKey,
      humanRecoveryArchiveSigningBytes(unsigned),
    ),
  };
  return serializeHumanRecoveryArchive(signed);
}

describe("Human recovery archive v2 workflow", () => {
  test("domain-separates recovery publication issuer proofs", async () => {
    const scenario = await setup();
    const signedMessages: Uint8Array[] = [];
    const originalSign = scenario.crypto.sign.bind(scenario.crypto);
    scenario.crypto.sign = (privateKey, message) => {
      signedMessages.push(message.slice());
      return originalSign(privateKey, message);
    };

    await scenario.publish();

    const label = new TextEncoder().encode(
      "nautilo/lattice-crypto/recovery-publication-issuer-proof/v2",
    );
    expect(
      signedMessages.some((message) => includesBytes(message, label)),
    ).toBe(true);
  });

  test("selects the current generation for each recovery key class", async () => {
    const scenario = await setup();
    const human = {
      ...scenario.human,
      currentGeneration: namespaceGeneration(2),
      generations: [
        ...scenario.human.generations,
        { generation: namespaceGeneration(2), key: bytes(0x13) },
      ],
    };
    const humanSource = replacementHumanSource(scenario, human);
    const published = await scenario.publish({
      sources: [humanSource, scenario.sources[1]!],
    });

    expect(
      published.archive.packages.find((item) => item.keyClass === "human")
        ?.currentGeneration,
    ).toBe(namespaceGeneration(2));
    expect(
      published.archive.packages.find((item) => item.keyClass === "ai")
        ?.currentGeneration,
    ).toBe(namespaceGeneration(1));
    const expectedInventory = [humanSource, scenario.sources[1]!].map(
      ({ authorizedHumanId, trustedNamespaceHead, keyClass }) => ({
        authorizedHumanId,
        trustedNamespaceHead,
        keyClass,
      }),
    );
    expect(await scenario.open(published.archiveBytes, {
      expectedInventory,
    })).toHaveLength(2);
  });

  test("enforces the exact inclusive aggregate archive-byte boundary", () => {
    expect(
      assertHumanRecoveryArchiveAggregateBytesV2(
        V2_LIMITS.recoveryArchiveBytes,
      ),
    ).toBe(V2_LIMITS.recoveryArchiveBytes);
    expectExactError(
      () =>
        assertHumanRecoveryArchiveAggregateBytesV2(
          V2_LIMITS.recoveryArchiveBytes + 1,
        ),
      `Human recovery archive aggregate bytes exceeds the ${V2_LIMITS.recoveryArchiveBytes} limit`,
    );
  });

  test("requires an exact opened-archive capability and trusted recovery identity", async () => {
    const scenario = await setup();
    await expectExactRejection(
      () =>
        scenario.publish({
          resolveTrustedCurrentRecoveryKey: () => null,
        }),
      "Trusted current recovery-key record is required for the Human",
    );
    await expectExactRejection(
      () =>
        scenario.publish({
          resolveTrustedCurrentRecoveryKey: () => ({
            ...scenario.resolveTrustedCurrentRecoveryKey(),
            humanId: humanId("human_mallory"),
          }),
        }),
      "Trusted current recovery-key record belongs to another Human",
    );

    const published = await scenario.publish();
    const restored = await scenario.open(published.archiveBytes);
    const archiveDigest = scenario.crypto.hash(published.archiveBytes);
    expect(() =>
      assertOpenedHumanRecoveryArchiveV2(restored, archiveDigest)
    ).not.toThrow();
    for (const [value, digest] of [
      [restored, null],
      [restored, bytes(1, 31)],
      [Object.freeze([...restored]), archiveDigest],
      [restored, bytes(0xff)],
    ] as const) {
      expectExactError(
        () =>
          assertOpenedHumanRecoveryArchiveV2(
            value,
            digest as never,
          ),
        "Recovery readiness requires the exact successfully opened archive capability",
      );
    }

    const originalKeyByte = restored[0]!.generations[0]!.key[0]!;
    restored[0]!.generations[0]!.key[0] = originalKeyByte ^ 1;
    expectExactError(
      () => assertOpenedHumanRecoveryArchiveV2(restored, archiveDigest),
      "Recovery readiness requires the exact successfully opened archive capability",
    );
    restored[0]!.generations[0]!.key[0] = originalKeyByte;
    expect(() =>
      assertOpenedHumanRecoveryArchiveV2(restored, archiveDigest)
    ).not.toThrow();
  });

  test("rejects oversized archive bytes before hashing or private-key copying", async () => {
    const scenario = await setup();
    await expectExactRejection(
      () =>
        scenario.open(
          new LengthSpoofedBytes(V2_LIMITS.recoveryArchiveBytes + 1),
          { recoveryPrivateKey: bytes(1, 31) },
        ),
      "Recovery archive exceeds the 64 MiB aggregate-byte limit",
    );
  });

  test("accepts the exact archive-byte ceiling before validating later inputs", async () => {
    const scenario = await setup();
    await expectExactRejection(
      () =>
        scenario.open(
          new LengthSpoofedBytes(V2_LIMITS.recoveryArchiveBytes),
          { recoveryPrivateKey: bytes(1, 31) },
        ),
      "Out of bounds access",
    );
  });

  test("preflights every recovery inventory and source field with exact diagnostics", async () => {
    const scenario = await setup();
    const source = scenario.sources[0]!;
    const cases = [
      {
        sources: null,
        message: "Human recovery inventory must be an array",
      },
      {
        sources: [null],
        message: "Human recovery inventory item must be an object",
      },
      {
        sources: ["source"],
        message: "Human recovery inventory item must be an object",
      },
      {
        sources: [{ ...source, unexpected: true }],
        message:
          "Human recovery inventory item contains unknown field unexpected",
      },
      {
        sources: [{ ...source, keyClass: "agent" }],
        message: "Human recovery supports only human and ai key classes",
      },
      {
        sources: [{ ...source, trustedNamespaceHead: null }],
        message:
          "Human recovery trusted Namespace head must be an object",
      },
      {
        sources: [source, source],
        message:
          "Human recovery inventory contains a duplicate Namespace/key class",
      },
      {
        sources: [{ ...source, authorizedHumanId: humanId("human_mallory") }],
        message:
          "Recovery publication inventory does not authorize the target Human",
      },
      {
        sources: [{ ...source, currentDomainRoot: bytes(1, 31) }],
        message:
          "Recovery publication current Domain root must contain exactly 32 bytes",
      },
      {
        sources: [{ ...source, currentDomainRoot: bytes(0xee) }],
        message: "Namespace keyring envelope failed to decrypt",
      },
      {
        sources: [{ ...source, currentKeyringEnvelope: null }],
        message:
          "Recovery publication current keyring envelope must be an object",
      },
      {
        sources: [{ ...source, currentKeyringEnvelope: "envelope" }],
        message:
          "Recovery publication current keyring envelope must be an object",
      },
      {
        sources: [{ ...source, resolveHistoricalCommitter: null }],
        message:
          "Recovery publication historical committer resolver is required",
      },
      {
        sources: Array.from(
          { length: V2_LIMITS.recoveryPackages + 1 },
          () => source,
        ),
        message:
          `Human recovery package count exceeds the ${V2_LIMITS.recoveryPackages} limit`,
      },
    ] as const;
    for (const { sources, message } of cases) {
      await expectExactRejection(
        () => scenario.publish({ sources: sources as never }),
        message,
      );
    }
  });

  test("preflights the complete source collection before opening any keyring", async () => {
    const scenario = await setup();
    for (const secondSource of [
      {
        ...scenario.sources[0]!,
        authorizedHumanId: humanId("human_mallory"),
      },
      {
        ...scenario.sources[0]!,
        currentKeyringEnvelope: scenario.aiEnvelope,
      },
    ]) {
      let historicalResolverCalls = 0;
      await expectExactRejection(
        () =>
          scenario.publish({
            sources: [
              {
                ...scenario.sources[1]!,
                resolveHistoricalCommitter: () => {
                  historicalResolverCalls++;
                  return scenario.signing.publicKey;
                },
              },
              secondSource,
            ],
          }),
        secondSource.authorizedHumanId !== scenario.targetHumanId
          ? "Recovery publication inventory does not authorize the target Human"
          : "Recovery publication current keyring envelope does not match the trusted Namespace binding",
      );
      expect(historicalResolverCalls).toBe(0);
    }
  });

  test("orders multiple Namespaces, rejects inconsistent Domain epochs, and selects the ai generation", async () => {
    const scenario = await setup();
    const otherHuman: NamespaceKeyringPlaintextV2 = {
      ...completeKeyring("namespace_other", "human"),
      currentGeneration: namespaceGeneration(0),
      generations: [{
        generation: namespaceGeneration(0),
        key: bytes(0x51),
      }],
    };
    const otherAi = completeKeyring("namespace_other", "ai");
    const makeOtherSources = (epoch: number) => {
      const metadata = {
        domainId: cryptoDomainId("domain_ab"),
        domainEpoch: domainEpoch(epoch),
        previousBindingHash: null,
        committerDeviceId: scenario.issuerDeviceId,
      };
      const humanRoot = bytes(0x51);
      const aiRoot = bytes(0x52);
      const humanEnvelope = sealNamespaceKeyring({
        crypto: scenario.crypto,
        domainRoot: humanRoot,
        keyring: otherHuman,
        metadata,
        committerSigningPrivateKey: scenario.signing.privateKey,
        resolveCurrentCommitter: () => scenario.signing.publicKey,
      });
      const aiEnvelope = sealNamespaceKeyring({
        crypto: scenario.crypto,
        domainRoot: aiRoot,
        keyring: otherAi,
        metadata,
        committerSigningPrivateKey: scenario.signing.privateKey,
        resolveCurrentCommitter: () => scenario.signing.publicKey,
      });
      const binding = createNamespaceBinding({
        crypto: scenario.crypto,
        humanEnvelope,
        aiEnvelope,
        committerSigningPrivateKey: scenario.signing.privateKey,
        resolveCurrentCommitter: () => scenario.signing.publicKey,
      });
      const trustedNamespaceHead = verifyNamespaceBindingProof({
        crypto: scenario.crypto,
        anchor: null,
        proof: [binding],
        resolveHistoricalCommitter: () => scenario.signing.publicKey,
      });
      return {
        human: {
          authorizedHumanId: scenario.targetHumanId,
          trustedNamespaceHead,
          keyClass: "human" as const,
          currentKeyringEnvelope: humanEnvelope,
          currentDomainRoot: humanRoot,
          resolveHistoricalCommitter: () => scenario.signing.publicKey,
        },
        ai: {
          authorizedHumanId: scenario.targetHumanId,
          trustedNamespaceHead,
          keyClass: "ai" as const,
          currentKeyringEnvelope: aiEnvelope,
          currentDomainRoot: aiRoot,
          resolveHistoricalCommitter: () => scenario.signing.publicKey,
        },
      };
    };

    const currentEpochSources = makeOtherSources(1);
    const published = await scenario.publish({
      sources: [
        currentEpochSources.ai,
        scenario.sources[0]!,
      ],
    });
    expect(
      published.archive.packages.map((item) =>
        `${item.namespaceId}:${item.keyClass}:${item.currentGeneration}`
      ),
    ).toEqual([
      "namespace_other:ai:1",
      "namespace_room:human:1",
    ]);
    const restored = await scenario.open(published.archiveBytes, {
      expectedInventory: [
        {
          authorizedHumanId: currentEpochSources.ai.authorizedHumanId,
          trustedNamespaceHead:
            currentEpochSources.ai.trustedNamespaceHead,
          keyClass: currentEpochSources.ai.keyClass,
        },
        scenario.expectedInventory[0]!,
      ],
    });
    expect(restored).toHaveLength(2);

    const staleEpochSources = makeOtherSources(2);
    await expectExactRejection(
      () =>
        scenario.publish({
          sources: [
            scenario.sources[0]!,
            staleEpochSources.human,
          ],
        }),
      "Human recovery inventory disagrees on the current Domain epoch",
    );
  });

  test("passes exact frozen archive and package contexts to the current issuer resolver", async () => {
    const scenario = await setup();
    const publicationContexts: HumanRecoveryIssuerContextV2[] = [];
    const published = await scenario.publish({
      resolveIssuerDevice: (context) => {
        publicationContexts.push(context);
        return scenario.signing.publicKey;
      },
    });
    expect(publicationContexts).toEqual([{
      purpose: "human-recovery-archive",
      humanId: scenario.targetHumanId,
      issuerDeviceId: scenario.issuerDeviceId,
      createdAt: scenario.createdAt,
    }]);

    const restoreContexts: HumanRecoveryIssuerContextV2[] = [];
    await scenario.open(published.archiveBytes, {
      resolveIssuerDevice: (context) => {
        restoreContexts.push(context);
        return scenario.signing.publicKey;
      },
    });
    expect(restoreContexts.map((context) => Object.keys(context))).toEqual([
      ["purpose", "humanId", "issuerDeviceId", "createdAt"],
      [
        "purpose",
        "humanId",
        "issuerDeviceId",
        "createdAt",
        "namespaceId",
        "keyClass",
      ],
      [
        "purpose",
        "humanId",
        "issuerDeviceId",
        "createdAt",
        "namespaceId",
        "keyClass",
      ],
    ]);
    expect(restoreContexts).toEqual([
      {
        purpose: "human-recovery-archive",
        humanId: scenario.targetHumanId,
        issuerDeviceId: scenario.issuerDeviceId,
        createdAt: scenario.createdAt,
      },
      {
        purpose: "namespace-recovery-package",
        humanId: scenario.targetHumanId,
        issuerDeviceId: scenario.issuerDeviceId,
        createdAt: scenario.createdAt,
        namespaceId: "namespace_room",
        keyClass: "ai",
      },
      {
        purpose: "namespace-recovery-package",
        humanId: scenario.targetHumanId,
        issuerDeviceId: scenario.issuerDeviceId,
        createdAt: scenario.createdAt,
        namespaceId: "namespace_room",
        keyClass: "human",
      },
    ]);
    expect(
      [...publicationContexts, ...restoreContexts].every(Object.isFrozen),
    ).toBe(true);

    for (const publicKey of [
      null,
      "key",
      bytes(1, V2_LIMITS.signingPublicKeyBytes - 1),
      bytes(1, V2_LIMITS.signingPublicKeyBytes + 1),
    ] as const) {
      await expectExactRejection(
        () =>
          scenario.publish({
            resolveIssuerDevice: () => publicKey as never,
          }),
        publicKey === null
          ? `Human recovery issuer ${scenario.issuerDeviceId} is not authorized`
          : `Human recovery issuer signing public key must contain exactly ${V2_LIMITS.signingPublicKeyBytes} bytes`,
      );
    }
    await expectExactRejection(
      () =>
        scenario.open(published.archiveBytes, {
          resolveIssuerDevice: (context) =>
            context.purpose === "human-recovery-archive"
              ? scenario.signing.publicKey
              : null,
        }),
      `Human recovery issuer ${scenario.issuerDeviceId} is not authorized`,
    );
  });

  test("validates exact publication keys, trusted rotation axes, and crypto outputs", async () => {
    const scenario = await setup();
    for (const [overrides, message] of [
      [
        { recoveryKeyId: "" },
        "Recovery key id must be 1-128 ASCII bytes using the portable identifier grammar",
      ],
      [
        { recoveryPublicKey: "key" },
        "Recovery public key must contain exactly 65 bytes",
      ],
      [
        { recoveryPublicKey: bytes(1, 64) },
        "Recovery public key must contain exactly 65 bytes",
      ],
      [
        { issuerSigningPrivateKey: "key" },
        "Recovery issuer signing private key must contain exactly 32 bytes",
      ],
      [
        { issuerSigningPrivateKey: bytes(1, 31) },
        "Recovery issuer signing private key must contain exactly 32 bytes",
      ],
    ] as const) {
      await expectExactRejection(
        () => scenario.publish(overrides as never),
        message,
      );
    }

    const trusted = scenario.resolveTrustedCurrentRecoveryKey();
    for (const resolveTrustedCurrentRecoveryKey of [
      () => ({ ...trusted, recoveryKeyId: "recovery_old" }),
      () => ({
        ...trusted,
        recoveryGeneration: recoveryKeyGeneration(2),
      }),
    ]) {
      await expectExactRejection(
        () => scenario.publish({ resolveTrustedCurrentRecoveryKey }),
        "Recovery publication recipient is not the trusted current recovery key",
      );
    }

    const otherSigning = scenario.crypto.generateSigningKeyPair();
    await expectExactRejection(
      () =>
        scenario.publish({
          issuerSigningPrivateKey: otherSigning.privateKey,
        }),
      "Recovery issuer private key does not match the authorized device",
    );

    const originalSeal = scenario.crypto.sealTo.bind(scenario.crypto);
    scenario.crypto.sealTo = async (...args) => {
      const ciphertext = await originalSeal(...args);
      return ciphertext.slice(0, -1);
    };
    await expectExactRejection(
      () => scenario.publish(),
      "Recovery HPKE ciphertext length is noncanonical",
    );
  });

  test("detaches publication ciphertexts and signatures from crypto outputs", async () => {
    const scenario = await setup();
    const returnedCiphertexts: Uint8Array[] = [];
    const returnedSignatures: Uint8Array[] = [];
    const originalSeal = scenario.crypto.sealTo.bind(scenario.crypto);
    const originalSign = scenario.crypto.sign.bind(scenario.crypto);
    scenario.crypto.sealTo = async (...args) => {
      const ciphertext = await originalSeal(...args);
      returnedCiphertexts.push(ciphertext);
      return ciphertext;
    };
    scenario.crypto.sign = (...args) => {
      const signature = originalSign(...args);
      returnedSignatures.push(signature);
      return signature;
    };
    const published = await scenario.publish();
    const expectedArchiveBytes = published.archiveBytes.slice();
    returnedCiphertexts.forEach((value) => value.fill(0));
    returnedSignatures.forEach((value) => value.fill(0));
    expect(serializeHumanRecoveryArchive(published.archive)).toEqual(
      expectedArchiveBytes,
    );
  });

  test("validates exact restore bytes, key inputs, and target Human", async () => {
    const scenario = await setup();
    const published = await scenario.publish();
    for (const [overrides, message] of [
      [
        { archiveBytes: null },
        "Recovery archive bytes must be bytes",
      ],
      [
        { recoveryPrivateKey: "key" },
        "Recovery private key must contain exactly 32 bytes",
      ],
      [
        { recoveryPrivateKey: bytes(1, 31) },
        "Recovery private key must contain exactly 32 bytes",
      ],
      [
        { currentRecoveryKeyId: "" },
        "Current recovery key id must be 1-128 ASCII bytes using the portable identifier grammar",
      ],
      [
        { humanId: humanId("human_mallory") },
        "Recovery archive belongs to another Human",
      ],
    ] as const) {
      await expectExactRejection(
        () => scenario.open(published.archiveBytes, overrides as never),
        message,
      );
    }
  });

  test("validates every nested source and restore inventory before trusted resolvers or crypto", async () => {
    const scenario = await setup();
    let recoveryResolverCalls = 0;
    let issuerResolverCalls = 0;
    let historicalResolverCalls = 0;
    let sealCalls = 0;
    const originalSeal = scenario.crypto.sealTo.bind(scenario.crypto);
    scenario.crypto.sealTo = async (...args) => {
      sealCalls++;
      return originalSeal(...args);
    };
    expect(scenario.publish({
      sources: [{
        ...scenario.sources[0]!,
        trustedNamespaceHead: {
          ...scenario.trustedHead,
          unexpected: true,
        } as never,
        resolveHistoricalCommitter: () => {
          historicalResolverCalls++;
          return scenario.signing.publicKey;
        },
      }],
      resolveTrustedCurrentRecoveryKey: () => {
        recoveryResolverCalls++;
        return scenario.resolveTrustedCurrentRecoveryKey();
      },
      resolveIssuerDevice: () => {
        issuerResolverCalls++;
        return scenario.signing.publicKey;
      },
    })).rejects.toThrow("unknown field");
    expect({
      recoveryResolverCalls,
      issuerResolverCalls,
      historicalResolverCalls,
      sealCalls,
    }).toEqual({
      recoveryResolverCalls: 0,
      issuerResolverCalls: 0,
      historicalResolverCalls: 0,
      sealCalls: 0,
    });

    const published = await scenario.publish();
    recoveryResolverCalls = 0;
    issuerResolverCalls = 0;
    let openCalls = 0;
    const originalOpen = scenario.crypto.openSealed.bind(scenario.crypto);
    scenario.crypto.openSealed = async (...args) => {
      openCalls++;
      return originalOpen(...args);
    };
    expect(scenario.open(published.archiveBytes, {
      expectedInventory: [{
        ...scenario.expectedInventory[0]!,
        unexpected: true,
      } as never],
      resolveTrustedCurrentRecoveryKey: () => {
        recoveryResolverCalls++;
        return scenario.resolveTrustedCurrentRecoveryKey();
      },
      resolveIssuerDevice: () => {
        issuerResolverCalls++;
        return scenario.signing.publicKey;
      },
    })).rejects.toThrow("unknown field");
    expect({ recoveryResolverCalls, issuerResolverCalls, openCalls }).toEqual({
      recoveryResolverCalls: 0,
      issuerResolverCalls: 0,
      openCalls: 0,
    });
  });

  test("snapshots archive bytes before asynchronous restore work", async () => {
    const scenario = await setup();
    const published = await scenario.publish();
    const archiveBytes = published.archiveBytes.slice();
    const expectedDigest = scenario.crypto.hash(archiveBytes);
    const originalOpen = scenario.crypto.openSealed.bind(scenario.crypto);
    let mutated = false;
    scenario.crypto.openSealed = async (...args) => {
      if (!mutated) {
        mutated = true;
        archiveBytes[0] = archiveBytes[0]! ^ 1;
      }
      return originalOpen(...args);
    };
    const restored = await scenario.open(archiveBytes);
    expect(() =>
      assertOpenedHumanRecoveryArchiveV2(restored, expectedDigest)
    ).not.toThrow();
  });

  test("snapshots publication keys across HPKE and immediately opens the resulting archive", async () => {
    const scenario = await setup();
    const recoveryPublicKey = Buffer.from(
      scenario.recoveryKeyPair.publicKey,
    );
    const issuerSigningPrivateKey = Buffer.from(
      scenario.signing.privateKey,
    );
    const originalSeal = scenario.crypto.sealTo.bind(scenario.crypto);
    const originalSign = scenario.crypto.sign.bind(scenario.crypto);
    let signingSnapshot: Uint8Array | null = null;
    let mutated = false;
    scenario.crypto.sign = (privateKey, message) => {
      signingSnapshot ??= privateKey;
      return originalSign(privateKey, message);
    };
    scenario.crypto.sealTo = async (...args) => {
      if (!mutated) {
        mutated = true;
        recoveryPublicKey.fill(0);
        issuerSigningPrivateKey.fill(0);
      }
      return originalSeal(...args);
    };
    const published = await scenario.publish({
      recoveryPublicKey,
      issuerSigningPrivateKey,
    });
    expect(isZeroized(signingSnapshot)).toBe(true);
    expect(Buffer.isBuffer(signingSnapshot)).toBe(false);
    const restored = await scenario.open(published.archiveBytes);
    expect(restored).toHaveLength(2);
  });

  test("snapshots trusted binding anchors before asynchronous archive publication", async () => {
    const scenario = await setup();
    const expectedBindingHash = scenario.trustedHead.bindingHash.slice();
    const originalSeal = scenario.crypto.sealTo.bind(scenario.crypto);
    let mutated = false;
    scenario.crypto.sealTo = async (...args) => {
      if (!mutated) {
        mutated = true;
        scenario.trustedHead.bindingHash.fill(0);
      }
      return originalSeal(...args);
    };
    const published = await scenario.publish();
    expect(
      published.archive.packages.every((item) =>
        item.bindingHash.every(
          (value, index) => value === expectedBindingHash[index],
        )
      ),
    ).toBe(true);
  });

  test("snapshots and wipes the recovery private key across HPKE restore", async () => {
    const scenario = await setup();
    const published = await scenario.publish();
    const recoveryPrivateKey = Buffer.from(
      scenario.recoveryKeyPair.privateKey,
    );
    const originalOpen = scenario.crypto.openSealed.bind(scenario.crypto);
    let privateSnapshot: Uint8Array | null = null;
    let mutated = false;
    scenario.crypto.openSealed = async (privateKey, ciphertext) => {
      privateSnapshot ??= privateKey;
      if (!mutated) {
        mutated = true;
        recoveryPrivateKey.fill(0);
      }
      return originalOpen(privateKey, ciphertext);
    };
    const restored = await scenario.open(published.archiveBytes, {
      recoveryPrivateKey,
    });
    expect(restored).toHaveLength(2);
    expect(isZeroized(privateSnapshot)).toBe(true);
    expect(Buffer.isBuffer(privateSnapshot)).toBe(false);
  });

  test("wipes publication and restore private snapshots on HPKE failure", async () => {
    const publishState = await setup();
    const originalSign = publishState.crypto.sign.bind(publishState.crypto);
    let signingSnapshot: Uint8Array | null = null;
    publishState.crypto.sign = (privateKey, message) => {
      signingSnapshot ??= privateKey;
      return originalSign(privateKey, message);
    };
    publishState.crypto.sealTo = async () => {
      throw new Error("injected recovery publication failure");
    };
    expect(publishState.publish()).rejects.toThrow(
      "injected recovery publication failure",
    );
    expect(isZeroized(signingSnapshot)).toBe(true);

    const openState = await setup();
    const published = await openState.publish();
    let privateSnapshot: Uint8Array | null = null;
    openState.crypto.openSealed = async (privateKey) => {
      privateSnapshot = privateKey;
      throw new Error("injected recovery restore failure");
    };
    expect(openState.open(published.archiveBytes)).rejects.toThrow(
      "injected recovery restore failure",
    );
    expect(isZeroized(privateSnapshot)).toBe(true);
  });

  test("publishes one canonical complete keyring per Namespace/class and restores detached outputs", async () => {
    const scenario = await setup();
    const published = await scenario.publish({
      sources: [...scenario.sources].reverse(),
    });

    expect(
      published.archive.packages.map((item) =>
        `${item.namespaceId}:${item.keyClass}`
      ),
    ).toEqual(["namespace_room:ai", "namespace_room:human"]);
    const restored = await scenario.open(published.archiveBytes);
    expect(restored.map((item) => item.keyClass)).toEqual(["ai", "human"]);
    expect(restored[0]).toEqual(scenario.ai);
    expect(restored[1]).toEqual(scenario.human);
    expect(restored[0]).not.toBe(scenario.ai);
    expect(restored[0]!.generations[0]!.key).not.toBe(
      scenario.ai.generations[0]!.key,
    );
    restored[0]!.generations[0]!.key[0] =
      restored[0]!.generations[0]!.key[0]! ^ 0xff;
    expect(restored[0]).not.toEqual(scenario.ai);
    expect(
      published.archive.packages.every((item) =>
        item.recoveryPublicKeyDigest.every(
          (byte, index) =>
            byte === published.archive.recoveryPublicKeyDigest[index],
        )
      ),
    ).toBe(true);
  });

  test("rejects server recipient substitution and recovery rotation before HPKE", async () => {
    const scenario = await setup();
    const serverKey = await scenario.crypto.generateEncryptionKeyPair();
    let sealCalls = 0;
    const originalSeal = scenario.crypto.sealTo.bind(scenario.crypto);
    scenario.crypto.sealTo = async (...args) => {
      sealCalls++;
      return originalSeal(...args);
    };
    expect(
      scenario.publish({ recoveryPublicKey: serverKey.publicKey }),
    ).rejects.toThrow("trusted current recovery key");
    expect(sealCalls).toBe(0);

    const published = await scenario.publish();
    let openCalls = 0;
    const originalOpen = scenario.crypto.openSealed.bind(scenario.crypto);
    scenario.crypto.openSealed = async (...args) => {
      openCalls++;
      return originalOpen(...args);
    };
    expect(
      scenario.open(published.archiveBytes, {
        resolveTrustedCurrentRecoveryKey: () => ({
          humanId: scenario.targetHumanId,
          recoveryKeyId: "recovery_rotated",
          recoveryGeneration: recoveryKeyGeneration(2),
          publicKeyDigest: recoveryPublicKeyDigest(serverKey.publicKey),
        }),
      }),
    ).rejects.toThrow("trusted current recovery key");
    expect(openCalls).toBe(0);
  });

  test("embeds the exact signed package metadata/AAD inside HPKE plaintext", async () => {
    const scenario = await setup();
    const published = await scenario.publish();
    const item = published.archive.packages[0]!;
    const plaintext = await scenario.crypto.openSealed(
      scenario.recoveryKeyPair.privateKey,
      item.ciphertext,
    );
    expect(plaintext).not.toBeNull();
    const expectedAad = namespaceRecoveryPackageAad(item);
    const aadLength =
      ((plaintext![0]! << 24) >>> 0)
      + (plaintext![1]! << 16)
      + (plaintext![2]! << 8)
      + plaintext![3]!;
    expect(Array.from(plaintext!.slice(4, 4 + aadLength))).toEqual(
      Array.from(expectedAad),
    );
  });

  test("zeroizes temporary recovery plaintext after publication and restore", async () => {
    const scenario = await setup();
    const publicationPlaintexts: Uint8Array[] = [];
    const originalSeal = scenario.crypto.sealTo.bind(scenario.crypto);
    const originalFill = Uint8Array.prototype.fill;
    const zeroized: Uint8Array[] = [];
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      const result = originalFill.call(this, value, start, end);
      if (value === 0) zeroized.push(this);
      return result;
    };
    scenario.crypto.sealTo = async (publicKey, plaintext) => {
      publicationPlaintexts.push(plaintext);
      return originalSeal(publicKey, plaintext);
    };
    try {
      const published = await scenario.publish();
      expect(publicationPlaintexts.length).toBe(2);
      expect(
        publicationPlaintexts.every((plaintext) =>
          plaintext.every((byte) => byte === 0)
        ),
      ).toBe(true);
      const publicationKeyringKeys = zeroized.filter(
        (value) => value.length === 32,
      );
      expect(publicationKeyringKeys.length).toBeGreaterThanOrEqual(4);
      expect(publicationKeyringKeys.every((value) => value.every(
        (byte) => byte === 0
      ))).toBe(true);

      const restoredPlaintexts: Uint8Array[] = [];
      const originalOpen = scenario.crypto.openSealed.bind(scenario.crypto);
      scenario.crypto.openSealed = async (privateKey, ciphertext) => {
        const plaintext = await originalOpen(privateKey, ciphertext);
        if (plaintext !== null) restoredPlaintexts.push(plaintext);
        return plaintext;
      };
      await scenario.open(published.archiveBytes);
      expect(restoredPlaintexts.length).toBe(2);
      expect(
        restoredPlaintexts.every((plaintext) =>
          plaintext.every((byte) => byte === 0)
        ),
      ).toBe(true);
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
  });

  test("wipes an already planned package when a later preflight source fails", async () => {
    const reference = await setup();
    const plaintextLengths: number[] = [];
    const referenceSeal = reference.crypto.sealTo.bind(reference.crypto);
    reference.crypto.sealTo = async (publicKey, plaintext) => {
      plaintextLengths.push(plaintext.length);
      return referenceSeal(publicKey, plaintext);
    };
    await reference.publish();
    const firstPlanPlaintextLength = plaintextLengths[0]!;

    const scenario = await setup();
    const originalFill = Uint8Array.prototype.fill;
    const wipedPlanPlaintexts: Uint8Array[] = [];
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      if (
        value === 0
        && this.length === firstPlanPlaintextLength
        && new Error().stack?.includes("preflightPublication")
      ) {
        wipedPlanPlaintexts.push(this);
      }
      return originalFill.call(this, value, start, end);
    };
    try {
      await expectExactRejection(
        () =>
          scenario.publish({
            sources: [
              scenario.sources[1]!,
              {
                ...scenario.sources[0]!,
                currentDomainRoot: bytes(0xee),
              },
            ],
          }),
        "Namespace keyring envelope failed to decrypt",
      );
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
    expect(wipedPlanPlaintexts.length).toBeGreaterThanOrEqual(1);
    expect(wipedPlanPlaintexts.every((value) =>
      value.every((byte) => byte === 0)
    )).toBe(true);
  });

  test("wipes prior restore intermediates when a later package fails", async () => {
    const scenario = await setup();
    const published = await scenario.publish();
    const captured: Uint8Array[] = [];
    const originalFill = Uint8Array.prototype.fill;
    const zeroized: Uint8Array[] = [];
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      const result = originalFill.call(this, value, start, end);
      if (value === 0) zeroized.push(this);
      return result;
    };
    let opens = 0;
    const originalOpen = scenario.crypto.openSealed.bind(scenario.crypto);
    scenario.crypto.openSealed = async (...args) => {
      opens++;
      if (opens === 2) return null;
      const plaintext = await originalOpen(...args);
      if (plaintext === null) return null;
      captured.push(plaintext);
      return plaintext;
    };

    try {
      expect(scenario.open(published.archiveBytes)).rejects.toThrow(
        "failed to decrypt",
      );
      expect(opens).toBe(2);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.every((byte) => byte === 0)).toBe(true);
      const wipedKeys = zeroized.filter((value) => value.length === 32);
      expect(wipedKeys.length).toBeGreaterThanOrEqual(
        scenario.ai.generations.length * 3,
      );
      expect(wipedKeys.every((value) =>
        value.every((byte) => byte === 0)
      )).toBe(true);
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
  });

  test("rejects a forged but canonical plaintext keyring behind a validly signed substitute envelope", async () => {
    const scenario = await setup();
    const forgedKeyring: NamespaceKeyringPlaintextV2 = {
      ...scenario.human,
      generations: scenario.human.generations.map((entry) => ({
        generation: entry.generation,
        key: bytes(0xf0 + entry.generation),
      })),
    };
    const forgedEnvelope = sealNamespaceKeyring({
      crypto: scenario.crypto,
      domainRoot: bytes(0x31),
      keyring: forgedKeyring,
      metadata: {
        domainId: cryptoDomainId("domain_ab"),
        domainEpoch: domainEpoch(1),
        previousBindingHash: null,
        committerDeviceId: scenario.issuerDeviceId,
      },
      committerSigningPrivateKey: scenario.signing.privateKey,
      resolveCurrentCommitter: () => scenario.signing.publicKey,
    });
    let hpkeCalls = 0;
    const originalSeal = scenario.crypto.sealTo.bind(scenario.crypto);
    scenario.crypto.sealTo = async (...args) => {
      hpkeCalls++;
      return originalSeal(...args);
    };

    expect(
      scenario.publish({
        sources: [{
          ...scenario.sources[0]!,
          currentKeyringEnvelope: forgedEnvelope,
        }],
      }),
    ).rejects.toThrow("does not match the trusted Namespace binding");
    expect(hpkeCalls).toBe(0);
  });

  test("rejects incomplete retained history and count overflow before HPKE", async () => {
    const scenario = await setup();
    const startsAtOne: NamespaceKeyringPlaintextV2 = {
      ...scenario.human,
      generations: [scenario.human.generations[1]!],
    };
    const startsAtOneSource = replacementHumanSource(
      scenario,
      startsAtOne,
    );
    const gap: NamespaceKeyringPlaintextV2 = {
      ...scenario.human,
      currentGeneration: namespaceGeneration(2),
      generations: [
        scenario.human.generations[0]!,
        { generation: namespaceGeneration(2), key: bytes(0x13) },
      ],
    };
    const gapSource = replacementHumanSource(scenario, gap);
    let hpkeCalls = 0;
    const originalSeal = scenario.crypto.sealTo.bind(scenario.crypto);
    scenario.crypto.sealTo = async (...args) => {
      hpkeCalls++;
      return originalSeal(...args);
    };
    expect(
      scenario.publish({
        sources: [startsAtOneSource],
      }),
    ).rejects.toThrow("generation 0");
    expect(hpkeCalls).toBe(0);

    expect(
      scenario.publish({
        sources: [gapSource],
      }),
    ).rejects.toThrow("contiguous");
    expect(hpkeCalls).toBe(0);

    expect(
      scenario.publish({
        sources: Array.from(
          { length: V2_LIMITS.recoveryPackages + 1 },
          () => scenario.sources[0]!,
        ),
      }),
    ).rejects.toThrow("4096");
    expect(hpkeCalls).toBe(0);
  });

  test("rejects stale recovery identity, wrong Human, and missing or extra authorization inventory", async () => {
    const scenario = await setup();
    const published = await scenario.publish();

    expect(
      scenario.publish({
        sources: scenario.sources.map((source) => ({
          ...source,
          authorizedHumanId: humanId("human_mallory"),
        })),
      }),
    ).rejects.toThrow("authorize the target Human");
    expect(
      scenario.open(published.archiveBytes, {
        humanId: humanId("human_mallory"),
      }),
    ).rejects.toThrow("Human");
    await expectExactRejection(
      () =>
        scenario.open(published.archiveBytes, {
          currentRecoveryKeyId: "recovery_stale",
        }),
      "Recovery archive does not target the current recovery key generation",
    );
    await expectExactRejection(
      () =>
        scenario.open(published.archiveBytes, {
          currentRecoveryGeneration: recoveryKeyGeneration(2),
        }),
      "Recovery archive does not target the current recovery key generation",
    );
    expect(
      scenario.open(published.archiveBytes, {
        expectedInventory: scenario.expectedInventory.map((item) => ({
          ...item,
          authorizedHumanId: humanId("human_mallory"),
        })),
      }),
    ).rejects.toThrow("authorize the target Human");
    await expectExactRejection(
      () =>
        scenario.open(published.archiveBytes, {
          expectedInventory: [
            scenario.expectedInventory[0]!,
            {
              ...scenario.expectedInventory[1]!,
              authorizedHumanId: humanId("human_mallory"),
            },
          ],
        }),
      "Recovery restore inventory does not authorize the target Human",
    );
    await expectExactRejection(
      () =>
        scenario.open(published.archiveBytes, {
          expectedInventory: scenario.expectedInventory.slice(0, 1),
        }),
      "Recovery archive package inventory is missing or has unauthorized extras",
    );
    expect(
      scenario.open(published.archiveBytes, {
        expectedInventory: [
          ...scenario.expectedInventory,
          {
            ...scenario.expectedInventory[0]!,
            keyClass: "ai",
          },
        ],
      }),
    ).rejects.toThrow("inventory");

    const trusted = scenario.resolveTrustedCurrentRecoveryKey();
    for (const resolveTrustedCurrentRecoveryKey of [
      () => ({ ...trusted, recoveryKeyId: "recovery_old" }),
      () => ({
        ...trusted,
        recoveryGeneration: recoveryKeyGeneration(2),
      }),
      () => ({ ...trusted, publicKeyDigest: bytes(0xee) }),
    ]) {
      await expectExactRejection(
        () =>
          scenario.open(published.archiveBytes, {
            resolveTrustedCurrentRecoveryKey,
          }),
        "Recovery archive does not match the trusted current recovery key",
      );
    }
  });

  test("matches every package inventory and binding-anchor field independently", async () => {
    const scenario = await setup();
    const published = await scenario.publish({
      sources: [scenario.sources[0]!],
    });
    const expectedInventory = [scenario.expectedInventory[0]!];
    const item = published.archive.packages[0]!;
    const cases = [
      {
        item: {
          ...item,
          namespaceId: namespaceId("namespace_other"),
        },
        message:
          "Recovery archive Namespace/key-class inventory is unauthorized",
      },
      {
        item: {
          ...item,
          keyClass: "ai" as const,
        },
        message:
          "Recovery archive Namespace/key-class inventory is unauthorized",
      },
      {
        item: {
          ...item,
          accessRevision: accessRevision(Number(item.accessRevision) + 1),
        },
        message:
          "Recovery package does not match the authorized binding anchor",
      },
      {
        item: {
          ...item,
          currentGeneration: namespaceGeneration(
            Number(item.currentGeneration) + 1,
          ),
        },
        message:
          "Recovery package does not match the authorized binding anchor",
      },
      {
        item: {
          ...item,
          bindingHash: bytes(0xdd),
        },
        message:
          "Recovery package does not match the authorized binding anchor",
      },
    ];
    for (const { item: changedItem, message } of cases) {
      const archiveBytes = await resignArchive(
        scenario.crypto,
        scenario.signing.privateKey,
        published.archive,
        [changedItem as NamespaceRecoveryPackageV2],
      );
      await expectExactRejection(
        () => scenario.open(archiveBytes, { expectedInventory }),
        message,
      );
    }
  });

  test("rejects a wrong binding anchor and archive/package signature substitution", async () => {
    const scenario = await setup();
    const published = await scenario.publish();
    const wrongBindingUnsigned: NamespaceBindingV2 = {
      ...scenario.binding,
      domainId: cryptoDomainId("domain_other"),
      signature: bytes(0, 64),
    };
    const wrongBinding: NamespaceBindingV2 = {
      ...wrongBindingUnsigned,
      signature: scenario.crypto.sign(
        scenario.signing.privateKey,
        namespaceBindingSigningBytes(wrongBindingUnsigned),
      ),
    };
    const wrongHead = verifyNamespaceBindingProof({
      crypto: scenario.crypto,
      anchor: null,
      proof: [wrongBinding],
      resolveHistoricalCommitter: () => scenario.signing.publicKey,
    });
    expect(
      scenario.open(published.archiveBytes, {
        expectedInventory: scenario.expectedInventory.map((item) => ({
          ...item,
          trustedNamespaceHead: wrongHead,
        })),
      }),
    ).rejects.toThrow("binding");

    const badArchiveSignature = published.archiveBytes.slice();
    badArchiveSignature[badArchiveSignature.length - 1] =
      badArchiveSignature[badArchiveSignature.length - 1]! ^ 0xff;
    expect(
      scenario.open(badArchiveSignature),
    ).rejects.toThrow("archive signature");

    const first = published.archive.packages[0]!;
    const badPackage = {
      ...first,
      signature: first.signature.slice(),
    };
    badPackage.signature[0] = badPackage.signature[0]! ^ 0xff;
    const badPackageArchive = await resignArchive(
      scenario.crypto,
      scenario.signing.privateKey,
      published.archive,
      [badPackage, ...published.archive.packages.slice(1)],
    );
    expect(
      scenario.open(badPackageArchive),
    ).rejects.toThrow("package signature");
  });

  test("binds embedded AAD and every inner keyring metadata field and wipes rejected decoded keys", async () => {
    const scenario = await setup();
    const published = await scenario.publish();
    const outer = published.archive.packages[0]!;
    const correctKeyring = outer.keyClass === "ai"
      ? scenario.ai
      : scenario.human;
    const buildArchive = async (
      keyring: NamespaceKeyringPlaintextV2,
      aad: Uint8Array = namespaceRecoveryPackageAad(outer),
    ): Promise<Uint8Array> => {
      const ciphertext = await scenario.crypto.sealTo(
        scenario.recoveryKeyPair.publicKey,
        concatV2(
          frame(aad),
          frame(encodeNamespaceKeyring(keyring)),
        ),
      );
      const unsigned: NamespaceRecoveryPackageV2 = {
        ...outer,
        ciphertext,
        signature: bytes(0, V2_LIMITS.signatureBytes),
      };
      const replacement: NamespaceRecoveryPackageV2 = {
        ...unsigned,
        signature: scenario.crypto.sign(
          scenario.signing.privateKey,
          namespaceRecoveryPackageSigningBytes(unsigned),
        ),
      };
      return resignArchive(
        scenario.crypto,
        scenario.signing.privateKey,
        published.archive,
        [replacement, ...published.archive.packages.slice(1)],
      );
    };

    const keyringBytesLength = encodeNamespaceKeyring(correctKeyring).length;
    const originalFill = Uint8Array.prototype.fill;
    const wipedKeyringBytes: Uint8Array[] = [];
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      if (
        value === 0
        && this.length === keyringBytesLength
        && new Error().stack?.includes("decodeRecoveryPlaintext")
      ) {
        wipedKeyringBytes.push(this);
      }
      return originalFill.call(this, value, start, end);
    };
    try {
      await scenario.open(published.archiveBytes);
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
    expect(wipedKeyringBytes.length).toBeGreaterThanOrEqual(1);
    expect(wipedKeyringBytes.every((value) =>
      value.every((byte) => byte === 0)
    )).toBe(true);

    const alteredAad = namespaceRecoveryPackageAad(outer);
    alteredAad[alteredAad.length - 1] =
      alteredAad[alteredAad.length - 1]! ^ 1;
    await expectExactRejection(
      async () =>
        scenario.open(await buildArchive(correctKeyring, alteredAad)),
      "Recovery package embedded metadata/AAD does not match its outer metadata",
    );

    const innerMismatches: NamespaceKeyringPlaintextV2[] = [
      {
        ...correctKeyring,
        namespaceId: namespaceId("namespace_other"),
      },
      {
        ...correctKeyring,
        accessRevision: accessRevision(
          Number(correctKeyring.accessRevision) + 1,
        ),
      },
      {
        ...correctKeyring,
        currentGeneration: namespaceGeneration(
          Number(correctKeyring.currentGeneration) + 1,
        ),
        generations: [
          ...correctKeyring.generations,
          {
            generation: namespaceGeneration(
              Number(correctKeyring.currentGeneration) + 1,
            ),
            key: bytes(0xce),
          },
        ],
      },
    ];
    for (const keyring of innerMismatches) {
      await expectExactRejection(
        async () => scenario.open(await buildArchive(keyring)),
        "Recovery package inner and outer keyring metadata do not match",
      );
    }

    const trackedArchive = await buildArchive(innerMismatches[0]!);
    const trackingFill = Uint8Array.prototype.fill;
    const zeroized: Uint8Array[] = [];
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      const result = trackingFill.call(this, value, start, end);
      if (value === 0) zeroized.push(this);
      return result;
    };
    const originalOpen = scenario.crypto.openSealed.bind(scenario.crypto);
    scenario.crypto.openSealed = async (...args) => {
      const plaintext = await originalOpen(...args);
      if (plaintext === null) return null;
      return plaintext;
    };
    try {
      await expectExactRejection(
        () => scenario.open(trackedArchive),
        "Recovery package inner and outer keyring metadata do not match",
      );
      const rejectedDecodedKeys = zeroized.filter(
        (value) => value.length === 32,
      );
      expect(rejectedDecodedKeys.length).toBeGreaterThanOrEqual(
        correctKeyring.generations.length,
      );
      expect(rejectedDecodedKeys.every((value) =>
        value.every((byte) => byte === 0)
      )).toBe(true);
    } finally {
      Uint8Array.prototype.fill = trackingFill;
    }
  });

  test("rejects ciphertext substitution and exact inner/outer mismatch even when re-signed", async () => {
    const scenario = await setup();
    const published = await scenario.publish();
    const first = published.archive.packages[0]!;
    const changedCiphertext = {
      ...first,
      ciphertext: first.ciphertext.slice(),
      signature: bytes(0, 64),
    };
    changedCiphertext.ciphertext[changedCiphertext.ciphertext.length - 1] =
      changedCiphertext.ciphertext[
        changedCiphertext.ciphertext.length - 1
      ]! ^ 0xff;
    const resignedPackage: NamespaceRecoveryPackageV2 = {
      ...changedCiphertext,
      signature: scenario.crypto.sign(
        scenario.signing.privateKey,
        namespaceRecoveryPackageSigningBytes(changedCiphertext),
      ),
    };
    const changedArchive = await resignArchive(
      scenario.crypto,
      scenario.signing.privateKey,
      published.archive,
      [resignedPackage, ...published.archive.packages.slice(1)],
    );
    expect(scenario.open(changedArchive)).rejects.toThrow("decrypt");

    const outer = published.archive.packages[0]!;
    const wrongInner = outer.keyClass === "ai"
      ? scenario.human
      : scenario.ai;
    const sealedWrongInner = await scenario.crypto.sealTo(
      scenario.recoveryKeyPair.publicKey,
      concatV2(
        frame(namespaceRecoveryPackageAad(outer)),
        frame(encodeNamespaceKeyring(wrongInner)),
      ),
    );
    const wrongInnerUnsigned = {
      ...outer,
      ciphertext: sealedWrongInner,
      signature: bytes(0, 64),
    };
    const wrongInnerPackage: NamespaceRecoveryPackageV2 = {
      ...wrongInnerUnsigned,
      signature: scenario.crypto.sign(
        scenario.signing.privateKey,
        namespaceRecoveryPackageSigningBytes(wrongInnerUnsigned),
      ),
    };
    const wrongInnerArchive = await resignArchive(
      scenario.crypto,
      scenario.signing.privateKey,
      published.archive,
      [wrongInnerPackage, ...published.archive.packages.slice(1)],
    );
    expect(
      scenario.open(wrongInnerArchive),
    ).rejects.toThrow("inner and outer");
  });

  test("rejects a validly encrypted but incomplete keyring during restore", async () => {
    const scenario = await setup();
    const published = await scenario.publish();
    const outer = published.archive.packages.find(
      (item) => item.keyClass === "human",
    )!;
    const incomplete: NamespaceKeyringPlaintextV2 = {
      ...scenario.human,
      generations: [scenario.human.generations[1]!],
    };
    const ciphertext = await scenario.crypto.sealTo(
      scenario.recoveryKeyPair.publicKey,
      concatV2(
        frame(namespaceRecoveryPackageAad(outer)),
        frame(encodeNamespaceKeyring(incomplete)),
      ),
    );
    const unsigned = {
      ...outer,
      ciphertext,
      signature: bytes(0, 64),
    };
    const replacement: NamespaceRecoveryPackageV2 = {
      ...unsigned,
      signature: scenario.crypto.sign(
        scenario.signing.privateKey,
        namespaceRecoveryPackageSigningBytes(unsigned),
      ),
    };
    const packages = published.archive.packages.map((item) =>
      item.keyClass === "human" ? replacement : item
    );
    const archiveBytes = await resignArchive(
      scenario.crypto,
      scenario.signing.privateKey,
      published.archive,
      packages,
    );
    expect(
      scenario.open(archiveBytes),
    ).rejects.toThrow("generation 0");
  });
});
