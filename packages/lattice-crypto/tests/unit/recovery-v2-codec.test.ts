import { describe, expect, test } from "bun:test";
import {
  HUMAN_RECOVERY_ARCHIVE_DOMAIN,
  HUMAN_RECOVERY_FORMAT_VERSION,
  NAMESPACE_RECOVERY_PACKAGE_DOMAIN,
  RECOVERY_PUBLIC_KEY_DIGEST_BYTES,
  assertCanonicalHumanRecoveryArchive,
  assertNamespaceRecoveryPackage,
  assertTrustedCurrentRecoveryKey,
  decodeHumanRecoveryArchive,
  decodeNamespaceRecoveryPackage,
  humanRecoveryArchiveSigningBytes,
  namespaceRecoveryPackageAad,
  namespaceRecoveryPackageSigningBytes,
  recoveryPublicKeyDigest,
  recoveryKeyGeneration,
  serializeHumanRecoveryArchive,
  serializeNamespaceRecoveryPackage,
  type HumanRecoveryArchiveV2,
  type NamespaceRecoveryPackageV2,
  type TrustedCurrentRecoveryKeyV2,
} from "../../src/format/recovery-v2.ts";
import {
  LatticeCrypto,
  seededRng,
} from "../../src/crypto/index.ts";
import {
  concatV2,
  encodeU32,
  encodeU64,
  frame,
  frameText,
} from "../../src/format/v2-primitives.ts";
import {
  accessRevision,
  cryptoDeviceId,
  humanId,
  namespaceGeneration,
  namespaceId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";
import { toHex } from "../../src/util/bytes.ts";

const PACKAGE_AAD_FIXTURE_HEX =
  "000000366e617574696c6f2f6c6174746963652d63727970746f2f6e616d6573706163652d67656e65726174696f6e2d7061636b6167652f7632"
  + `0000000200000005616c6963650000000e7265636f766572792d6b65792d33000000000000000300000020${"33".repeat(32)}0000000b6e616d6573706163652d61`
  + "0000000568756d616e0000000000000007000000000000000900000020"
  + "1111111111111111111111111111111111111111111111111111111111111111"
  + "0000000b616c6963652d70686f6e6500000000000003e8";
const PACKAGE_SIGNING_FIXTURE_HEX =
  `${PACKAGE_AAD_FIXTURE_HEX}00000020`
  + "fa22dfe1da9013b3c1145040acae9089e0c08bc1c1a0719614f4b73add6f6ef5";
const PACKAGE_WIRE_FIXTURE_HEX =
  `${PACKAGE_AAD_FIXTURE_HEX}00000003aabbcc00000040${"5a".repeat(64)}`;
const ARCHIVE_SIGNING_FIXTURE_HEX =
  "0000002a6e617574696c6f2f6c6174746963652d63727970746f2f7265636f766572792d617263686976652f7632"
  + `0000000200000005616c6963650000000e7265636f766572792d6b65792d33000000000000000300000020${"33".repeat(32)}`
  + "0000000c616c6963652d6c6170746f7000000000000007d00000000100000020"
  + "fbdcc6fb371c8deb2e9ab8b82a25f0d6a9ac73dd3d8931df2cac31639f8e00c7";
const ARCHIVE_WIRE_FIXTURE_HEX =
  "0000002a6e617574696c6f2f6c6174746963652d63727970746f2f7265636f766572792d617263686976652f7632"
  + `0000000200000005616c6963650000000e7265636f766572792d6b65792d33000000000000000300000020${"33".repeat(32)}`
  + "0000000c616c6963652d6c6170746f7000000000000007d00000000100000133"
  + `${PACKAGE_WIRE_FIXTURE_HEX}00000040${"6b".repeat(64)}`;

function recoveryPackage(
  targetNamespaceId = "namespace-a",
  keyClass: "human" | "ai" = "human",
): NamespaceRecoveryPackageV2 {
  return {
    formatVersion: HUMAN_RECOVERY_FORMAT_VERSION,
    humanId: humanId("alice"),
    recoveryKeyId: "recovery-key-3",
    recoveryGeneration: recoveryKeyGeneration(3),
    recoveryPublicKeyDigest: new Uint8Array(32).fill(0x33),
    namespaceId: namespaceId(targetNamespaceId),
    keyClass,
    accessRevision: accessRevision(7),
    currentGeneration: namespaceGeneration(9),
    bindingHash: new Uint8Array(32).fill(0x11),
    issuerDeviceId: cryptoDeviceId("alice-phone"),
    createdAt: unixTimestamp(1_000),
    ciphertext: Uint8Array.of(0xaa, 0xbb, 0xcc),
    signature: new Uint8Array(V2_LIMITS.signatureBytes).fill(0x5a),
  };
}

function recoveryArchive(
  packages: readonly NamespaceRecoveryPackageV2[] = [recoveryPackage()],
): HumanRecoveryArchiveV2 {
  return {
    formatVersion: HUMAN_RECOVERY_FORMAT_VERSION,
    humanId: humanId("alice"),
    recoveryKeyId: "recovery-key-3",
    recoveryGeneration: recoveryKeyGeneration(3),
    recoveryPublicKeyDigest: new Uint8Array(32).fill(0x33),
    issuerDeviceId: cryptoDeviceId("alice-laptop"),
    createdAt: unixTimestamp(2_000),
    packages,
    signature: new Uint8Array(V2_LIMITS.signatureBytes).fill(0x6b),
  };
}

class LengthSpoofedBytes extends Uint8Array {
  constructor(private readonly spoofedLength: number) {
    super(1);
  }

  override get length(): number {
    return this.spoofedLength;
  }
}

function findNeedle(bytes: Uint8Array, needleText: string): number {
  const needle = new TextEncoder().encode(needleText);
  return bytes.findIndex((_, index) =>
    needle.every((byte, inner) => bytes[index + inner] === byte)
  );
}

function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to throw");
}

function noncanonicalArchiveWire(
  archive: HumanRecoveryArchiveV2,
): Uint8Array {
  return concatV2(
    frameText(HUMAN_RECOVERY_ARCHIVE_DOMAIN),
    encodeU32(HUMAN_RECOVERY_FORMAT_VERSION),
    frameText(archive.humanId),
    frameText(archive.recoveryKeyId),
    encodeU64(archive.recoveryGeneration),
    frame(archive.recoveryPublicKeyDigest),
    frameText(archive.issuerDeviceId),
    encodeU64(archive.createdAt),
    encodeU32(archive.packages.length),
    ...archive.packages.map((item) =>
      frame(serializeNamespaceRecoveryPackage(item))
    ),
    frame(archive.signature),
  );
}

describe("v2 Namespace recovery package codec", () => {
  test("validates recovery generations, public keys, and trusted-key records exactly", () => {
    expect(Number(recoveryKeyGeneration(1))).toBe(1);
    expect(() => recoveryKeyGeneration(0)).toThrow(
      "Recovery key generation must be positive",
    );
    expect(() => recoveryKeyGeneration("1")).toThrow(
      "Recovery key generation must be a non-negative safe integer",
    );

    const publicKey = new Uint8Array(V2_LIMITS.hpkePublicKeyBytes).fill(0x5c);
    const digest = recoveryPublicKeyDigest(publicKey);
    expect(digest).toHaveLength(RECOVERY_PUBLIC_KEY_DIGEST_BYTES);
    expect(digest).toEqual(recoveryPublicKeyDigest(publicKey));
    expect(() =>
      recoveryPublicKeyDigest(
        new Uint8Array(V2_LIMITS.hpkePublicKeyBytes - 1),
      )
    ).toThrow(
      `Recovery public key must contain exactly ${V2_LIMITS.hpkePublicKeyBytes} bytes`,
    );

    const trusted: TrustedCurrentRecoveryKeyV2 = {
      humanId: humanId("alice"),
      recoveryKeyId: "recovery-key-3",
      recoveryGeneration: recoveryKeyGeneration(1),
      publicKeyDigest: digest,
    };
    expect(() => assertTrustedCurrentRecoveryKey(trusted)).not.toThrow();
    expect(() => assertTrustedCurrentRecoveryKey(null as never)).toThrow(
      "Trusted current recovery key must be an object",
    );
    expect(() => assertTrustedCurrentRecoveryKey(42 as never)).toThrow(
      "Trusted current recovery key must be an object",
    );
    expect(() =>
      assertTrustedCurrentRecoveryKey({
        ...trusted,
        recoveryKeyId: "/",
      })
    ).toThrow("Recovery key id");
    expect(() =>
      assertTrustedCurrentRecoveryKey({
        ...trusted,
        publicKeyDigest: new Uint8Array(
          RECOVERY_PUBLIC_KEY_DIGEST_BYTES - 1,
        ),
      })
    ).toThrow(
      `Recovery public-key digest must contain exactly ${RECOVERY_PUBLIC_KEY_DIGEST_BYTES} bytes`,
    );
    expect(() =>
      assertTrustedCurrentRecoveryKey({
        ...trusted,
        unexpected: true,
      } as TrustedCurrentRecoveryKeyV2)
    ).toThrow(
      "Trusted current recovery key contains unknown field unexpected",
    );
  });

  test("validates every package discriminator, digest, ciphertext, and signature boundary", () => {
    const original = recoveryPackage();
    expect(() => assertNamespaceRecoveryPackage(original)).not.toThrow();
    expect(() => assertNamespaceRecoveryPackage(null as never)).toThrow(
      "Recovery package must be an object",
    );
    expect(() => assertNamespaceRecoveryPackage(42 as never)).toThrow(
      "Recovery package must be an object",
    );
    expect(() =>
      assertNamespaceRecoveryPackage({
        ...original,
        formatVersion: 1,
      } as never)
    ).toThrow("Recovery package format version is unsupported");
    expect(() =>
      assertNamespaceRecoveryPackage({
        ...original,
        recoveryKeyId: "/",
      })
    ).toThrow("Recovery key id");
    expect(() =>
      assertNamespaceRecoveryPackage({
        ...original,
        recoveryPublicKeyDigest: new Uint8Array(
          RECOVERY_PUBLIC_KEY_DIGEST_BYTES - 1,
        ),
      })
    ).toThrow(
      `Recovery package public-key digest must contain exactly ${RECOVERY_PUBLIC_KEY_DIGEST_BYTES} bytes`,
    );
    expect(() =>
      assertNamespaceRecoveryPackage({
        ...original,
        bindingHash: new Uint8Array(31),
      })
    ).toThrow("Recovery package binding hash must contain exactly 32 bytes");
    expect(() =>
      assertNamespaceRecoveryPackage({
        ...original,
        ciphertext: "ciphertext" as never,
      })
    ).toThrow("Recovery package ciphertext must be bytes");
    expect(() =>
      assertNamespaceRecoveryPackage({
        ...original,
        ciphertext: new Uint8Array(),
      })
    ).toThrow(
      `Recovery package ciphertext bytes must be between 1 and ${V2_LIMITS.ciphertextBytes}`,
    );
    expect(() =>
      assertNamespaceRecoveryPackage({
        ...original,
        ciphertext: Uint8Array.of(1),
      })
    ).not.toThrow();
    expect(() =>
      assertNamespaceRecoveryPackage({
        ...original,
        ciphertext: new Uint8Array(V2_LIMITS.ciphertextBytes),
      })
    ).not.toThrow();
    expect(() =>
      assertNamespaceRecoveryPackage({
        ...original,
        ciphertext: new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
      })
    ).toThrow(
      `Recovery package ciphertext bytes exceeds the ${V2_LIMITS.ciphertextBytes} limit`,
    );
    expect(() =>
      assertNamespaceRecoveryPackage({
        ...original,
        signature: new Uint8Array(V2_LIMITS.signatureBytes - 1),
      })
    ).toThrow(
      `Recovery package signature must contain exactly ${V2_LIMITS.signatureBytes} bytes`,
    );
  });

  test("round-trips every signed/AAD field with detached bytes", () => {
    const original = recoveryPackage();
    const wire = serializeNamespaceRecoveryPackage(original);
    const decoded = decodeNamespaceRecoveryPackage(wire);

    expect(decoded).toEqual(original);
    expect(decoded).not.toBe(original);
    expect(decoded.ciphertext).not.toBe(original.ciphertext);
    expect(decoded.signature).not.toBe(original.signature);
    expect(decoded.bindingHash).not.toBe(original.bindingHash);
    expect(decoded.recoveryPublicKeyDigest).not.toBe(
      original.recoveryPublicKeyDigest,
    );
  });

  test("locks the exact owned domain, AAD, signing, and wire fixtures", () => {
    const original = recoveryPackage();
    expect(NAMESPACE_RECOVERY_PACKAGE_DOMAIN).toBe(
      "nautilo/lattice-crypto/namespace-generation-package/v2",
    );
    expect(toHex(namespaceRecoveryPackageAad(original))).toBe(
      PACKAGE_AAD_FIXTURE_HEX,
    );
    expect(toHex(namespaceRecoveryPackageSigningBytes(original))).toBe(
      PACKAGE_SIGNING_FIXTURE_HEX,
    );
    expect(toHex(serializeNamespaceRecoveryPackage(original))).toBe(
      PACKAGE_WIRE_FIXTURE_HEX,
    );
  });

  test("binds owner, recovery key, Namespace, class, revision, head, issuer, and ciphertext", () => {
    const original = recoveryPackage();
    const signing = namespaceRecoveryPackageSigningBytes(original);
    const substitutions: NamespaceRecoveryPackageV2[] = [
      { ...original, humanId: humanId("mallory") },
      { ...original, recoveryKeyId: "recovery-key-4" },
      {
        ...original,
        recoveryGeneration: recoveryKeyGeneration(4),
      },
      {
        ...original,
        recoveryPublicKeyDigest: new Uint8Array(32).fill(0x44),
      },
      { ...original, namespaceId: namespaceId("namespace-b") },
      { ...original, keyClass: "ai" },
      { ...original, accessRevision: accessRevision(8) },
      {
        ...original,
        currentGeneration: namespaceGeneration(10),
      },
      { ...original, bindingHash: new Uint8Array(32).fill(0x22) },
      { ...original, issuerDeviceId: cryptoDeviceId("mallory-phone") },
      { ...original, createdAt: unixTimestamp(1_001) },
      { ...original, ciphertext: Uint8Array.of(0xaa, 0xbb, 0xcd) },
    ];
    for (const substitution of substitutions) {
      expect(namespaceRecoveryPackageSigningBytes(substitution)).not.toEqual(
        signing,
      );
    }
  });

  test("makes package and archive signatures fail under substitution", () => {
    const crypto = new LatticeCrypto(seededRng(88));
    const signingKeys = crypto.generateSigningKeyPair();
    const unsignedPackage = recoveryPackage();
    const signedPackage: NamespaceRecoveryPackageV2 = {
      ...unsignedPackage,
      signature: crypto.sign(
        signingKeys.privateKey,
        namespaceRecoveryPackageSigningBytes(unsignedPackage),
      ),
    };
    expect(
      crypto.verify(
        signingKeys.publicKey,
        namespaceRecoveryPackageSigningBytes(signedPackage),
        signedPackage.signature,
      ),
    ).toBe(true);
    expect(
      crypto.verify(
        signingKeys.publicKey,
        namespaceRecoveryPackageSigningBytes({
          ...signedPackage,
          namespaceId: namespaceId("namespace-b"),
        }),
        signedPackage.signature,
      ),
    ).toBe(false);

    const unsignedArchive = recoveryArchive([signedPackage]);
    const signedArchive: HumanRecoveryArchiveV2 = {
      ...unsignedArchive,
      signature: crypto.sign(
        signingKeys.privateKey,
        humanRecoveryArchiveSigningBytes(unsignedArchive),
      ),
    };
    expect(
      crypto.verify(
        signingKeys.publicKey,
        humanRecoveryArchiveSigningBytes(signedArchive),
        signedArchive.signature,
      ),
    ).toBe(true);
    expect(
      crypto.verify(
        signingKeys.publicKey,
        humanRecoveryArchiveSigningBytes({
          ...signedArchive,
          issuerDeviceId: cryptoDeviceId("mallory-phone"),
        }),
        signedArchive.signature,
      ),
    ).toBe(false);
  });

  test("strictly rejects truncation, trailing bytes, old domains, invalid UTF-8, and malformed fields", () => {
    const wire = serializeNamespaceRecoveryPackage(recoveryPackage());
    expect(() => decodeNamespaceRecoveryPackage(wire.slice(0, -1))).toThrow();
    expect(() =>
      decodeNamespaceRecoveryPackage(new Uint8Array([...wire, 0]))
    ).toThrow("trailing");

    const oldDomain = wire.slice();
    const domainOffset = findNeedle(oldDomain, NAMESPACE_RECOVERY_PACKAGE_DOMAIN);
    expect(domainOffset).toBeGreaterThanOrEqual(0);
    oldDomain[domainOffset + NAMESPACE_RECOVERY_PACKAGE_DOMAIN.length - 1] =
      0x31;
    expect(() => decodeNamespaceRecoveryPackage(oldDomain)).toThrow(
      "Recovery package domain is unsupported",
    );

    const invalidUtf8 = wire.slice();
    const humanOffset = findNeedle(invalidUtf8, "alice");
    expect(humanOffset).toBeGreaterThanOrEqual(0);
    invalidUtf8[humanOffset] = 0xff;
    expect(() => decodeNamespaceRecoveryPackage(invalidUtf8)).toThrow("UTF-8");

    expect(() =>
      serializeNamespaceRecoveryPackage({
        ...recoveryPackage(),
        recoveryGeneration: 0 as never,
      })
    ).toThrow("positive");
    expect(() =>
      serializeNamespaceRecoveryPackage({
        ...recoveryPackage(),
        keyClass: "management" as never,
      })
    ).toThrow("key class");
    expect(() =>
      serializeNamespaceRecoveryPackage({
        ...recoveryPackage(),
        bindingHash: new Uint8Array(31),
      })
    ).toThrow("32");
    expect(() =>
      serializeNamespaceRecoveryPackage({
        ...recoveryPackage(),
        signature: new Uint8Array(V2_LIMITS.signatureBytes - 1),
      })
    ).toThrow("signature");
    expect(() =>
      serializeNamespaceRecoveryPackage({
        ...recoveryPackage(),
        unexpected: "ignored",
      } as NamespaceRecoveryPackageV2)
    ).toThrow("unknown field");
    expect(thrownMessage(() =>
      serializeNamespaceRecoveryPackage({
        ...recoveryPackage(),
        unexpected: "ignored",
      } as NamespaceRecoveryPackageV2)
    )).toBe("Recovery package contains unknown field unexpected");

    const invalidRecoveryKeyId = wire.slice();
    const keyIdOffset = findNeedle(invalidRecoveryKeyId, "recovery-key-3");
    expect(keyIdOffset).toBeGreaterThanOrEqual(0);
    invalidRecoveryKeyId[keyIdOffset] = 0x2f;
    expect(() => decodeNamespaceRecoveryPackage(invalidRecoveryKeyId)).toThrow(
      "Recovery key id",
    );

    expect(() => decodeNamespaceRecoveryPackage(null as never)).toThrow(
      "Recovery package wire bytes exceed format limits",
    );
    expect(thrownMessage(() =>
      decodeNamespaceRecoveryPackage("package" as never)
    )).toBe("Recovery package wire bytes exceed format limits");
    expect(() =>
      decodeNamespaceRecoveryPackage(
        new Uint8Array(V2_LIMITS.ciphertextBytes),
      )
    ).toThrow("Recovery package domain is unsupported");
    expect(() =>
      decodeNamespaceRecoveryPackage(
        new Uint8Array(V2_LIMITS.ciphertextBytes + 2 * 1024 + 1),
      )
    ).toThrow("Recovery package wire bytes exceed format limits");
  });
});

describe("v2 per-Human recovery archive codec", () => {
  test("mutation contract: archive wire accounting enforces the inclusive 64 MiB boundary without a large allocation", () => {
    const packageCount = Math.ceil(
      V2_LIMITS.recoveryArchiveBytes / (V2_LIMITS.ciphertextBytes - 3),
    ) + 1;
    const packages = Array.from(
      { length: packageCount },
      (_, index) =>
        recoveryPackage(
          `namespace-boundary-${index.toString().padStart(4, "0")}`,
        ),
    );
    const baseline = serializeHumanRecoveryArchive(
      recoveryArchive(packages),
    ).length;
    let remaining = V2_LIMITS.recoveryArchiveBytes - baseline;
    const exactPackages = packages.map((item) => {
      const added = Math.min(
        remaining,
        V2_LIMITS.ciphertextBytes - item.ciphertext.length,
      );
      remaining -= added;
      return {
        ...item,
        ciphertext: new LengthSpoofedBytes(
          item.ciphertext.length + added,
        ),
      };
    });
    expect(remaining).toBe(0);
    const exact = recoveryArchive(exactPackages);
    expect(() => assertCanonicalHumanRecoveryArchive(exact)).not.toThrow();

    const expandable = exactPackages.findIndex(
      (item) => item.ciphertext.length < V2_LIMITS.ciphertextBytes,
    );
    expect(expandable).toBeGreaterThanOrEqual(0);
    const overflowPackages = exactPackages.slice();
    overflowPackages[expandable] = {
      ...overflowPackages[expandable]!,
      ciphertext: new LengthSpoofedBytes(
        overflowPackages[expandable]!.ciphertext.length + 1,
      ),
    };
    const overflow = recoveryArchive(overflowPackages);
    expect(thrownMessage(() =>
      assertCanonicalHumanRecoveryArchive(overflow)
    )).toBe("Recovery archive exceeds the 64 MiB aggregate-byte limit");
  });

  test("validates the complete archive shape and exact scalar labels", () => {
    const archive = recoveryArchive();
    expect(() => assertCanonicalHumanRecoveryArchive(archive)).not.toThrow();
    expect(() => assertCanonicalHumanRecoveryArchive(null as never)).toThrow(
      "Recovery archive must be an object",
    );
    expect(() => assertCanonicalHumanRecoveryArchive(42 as never)).toThrow(
      "Recovery archive must be an object",
    );
    expect(() =>
      assertCanonicalHumanRecoveryArchive({
        ...archive,
        formatVersion: 1,
      } as never)
    ).toThrow("Recovery archive format version is unsupported");
    expect(() =>
      assertCanonicalHumanRecoveryArchive({
        ...archive,
        recoveryKeyId: "/",
      })
    ).toThrow("Recovery key id");
    expect(() =>
      assertCanonicalHumanRecoveryArchive({
        ...archive,
        recoveryPublicKeyDigest: new Uint8Array(
          RECOVERY_PUBLIC_KEY_DIGEST_BYTES - 1,
        ),
      })
    ).toThrow(
      `Recovery archive public-key digest must contain exactly ${RECOVERY_PUBLIC_KEY_DIGEST_BYTES} bytes`,
    );
    expect(() =>
      assertCanonicalHumanRecoveryArchive({
        ...archive,
        packages: "packages" as never,
      })
    ).toThrow("Recovery archive packages must be an array");
    expect(() =>
      assertCanonicalHumanRecoveryArchive({
        ...archive,
        signature: new Uint8Array(V2_LIMITS.signatureBytes - 1),
      })
    ).toThrow(
      `Recovery archive signature must contain exactly ${V2_LIMITS.signatureBytes} bytes`,
    );
  });

  test("round-trips a canonical archive and locks exact signing/wire fixtures", () => {
    const original = recoveryArchive();
    const wire = serializeHumanRecoveryArchive(original);
    const decoded = decodeHumanRecoveryArchive(wire);

    expect(HUMAN_RECOVERY_ARCHIVE_DOMAIN).toBe(
      "nautilo/lattice-crypto/recovery-archive/v2",
    );
    expect(decoded).toEqual(original);
    expect(decoded.packages).not.toBe(original.packages);
    expect(decoded.packages[0]).not.toBe(original.packages[0]);
    expect(decoded.recoveryPublicKeyDigest).not.toBe(
      original.recoveryPublicKeyDigest,
    );
    expect(toHex(humanRecoveryArchiveSigningBytes(original))).toBe(
      ARCHIVE_SIGNING_FIXTURE_HEX,
    );
    expect(toHex(wire)).toBe(ARCHIVE_WIRE_FIXTURE_HEX);
  });

  test("requires unique canonical Namespace/key-class order", () => {
    const canonical = recoveryArchive([
      recoveryPackage("namespace-a", "ai"),
      recoveryPackage("namespace-a", "human"),
      recoveryPackage("namespace-b", "human"),
    ]);
    expect(() => assertCanonicalHumanRecoveryArchive(canonical)).not.toThrow();

    expect(() =>
      assertCanonicalHumanRecoveryArchive(
        recoveryArchive([...canonical.packages].reverse()),
      )
    ).toThrow("canonical");
    expect(() =>
      assertCanonicalHumanRecoveryArchive(
        recoveryArchive([
          recoveryPackage("namespace-a", "human"),
          recoveryPackage("namespace-a", "human"),
        ]),
      )
    ).toThrow("duplicate");

    const noncanonical = recoveryArchive([
      recoveryPackage("namespace-z", "human"),
      recoveryPackage("namespace-a", "human"),
    ]);
    expect(() =>
      decodeHumanRecoveryArchive(noncanonicalArchiveWire(noncanonical))
    ).toThrow("canonical");
  });

  test("rejects package substitution across Human or recovery-key generation", () => {
    expect(() =>
      serializeHumanRecoveryArchive(
        recoveryArchive([
          { ...recoveryPackage(), humanId: humanId("mallory") },
        ]),
      )
    ).toThrow("Human");
    expect(() =>
      serializeHumanRecoveryArchive(
        recoveryArchive([
          {
            ...recoveryPackage(),
            recoveryKeyId: "recovery-key-4",
          },
        ]),
      )
    ).toThrow("recovery key");
    expect(() =>
      serializeHumanRecoveryArchive(
        recoveryArchive([
          {
            ...recoveryPackage(),
            recoveryGeneration: recoveryKeyGeneration(4),
          },
        ]),
      )
    ).toThrow("recovery key");
    expect(() =>
      serializeHumanRecoveryArchive(
        recoveryArchive([
          {
            ...recoveryPackage(),
            recoveryPublicKeyDigest: new Uint8Array(32).fill(0x44),
          },
        ]),
      )
    ).toThrow("recovery key");
  });

  test("enforces package-count and canonical inventory shape cheaply", () => {
    expect(() =>
      serializeHumanRecoveryArchive(
        recoveryArchive(
          Array.from(
            { length: V2_LIMITS.recoveryPackages + 1 },
            () => recoveryPackage(),
          ),
        ),
      )
    ).toThrow("4,096");

    const exactCount = recoveryArchive(
      Array.from(
        { length: V2_LIMITS.recoveryPackages },
        () => recoveryPackage(),
      ),
    );
    expect(() => assertCanonicalHumanRecoveryArchive(exactCount)).toThrow(
      "duplicate Namespace/key-class package",
    );

  });

  test("strictly rejects truncation, trailing bytes, bad version, and archive substitution", () => {
    const wire = serializeHumanRecoveryArchive(recoveryArchive());
    expect(() => decodeHumanRecoveryArchive(wire.slice(0, -1))).toThrow();
    expect(() =>
      decodeHumanRecoveryArchive(new Uint8Array([...wire, 0]))
    ).toThrow("trailing");

    const wrongVersion = wire.slice();
    const versionOffset = 4 + HUMAN_RECOVERY_ARCHIVE_DOMAIN.length;
    wrongVersion[versionOffset + 3] = 0x01;
    expect(() => decodeHumanRecoveryArchive(wrongVersion)).toThrow(
      "unsupported version",
    );

    const excessiveCount = wire.slice();
    const nestedPackageDomainOffset = findNeedle(
      excessiveCount,
      NAMESPACE_RECOVERY_PACKAGE_DOMAIN,
    );
    expect(nestedPackageDomainOffset).toBeGreaterThanOrEqual(12);
    const packageCountOffset = nestedPackageDomainOffset - 12;
    excessiveCount.set(encodeU32(V2_LIMITS.recoveryPackages + 1), packageCountOffset);
    expect(() => decodeHumanRecoveryArchive(excessiveCount)).toThrow("count");

    expect(() =>
      serializeHumanRecoveryArchive({
        ...recoveryArchive(),
        unexpected: "ignored",
      } as HumanRecoveryArchiveV2)
    ).toThrow("unknown field");
    expect(thrownMessage(() =>
      serializeHumanRecoveryArchive({
        ...recoveryArchive(),
        unexpected: "ignored",
      } as HumanRecoveryArchiveV2)
    )).toBe("Recovery archive contains unknown field unexpected");

    const wrongDomain = wire.slice();
    wrongDomain[4] = wrongDomain[4]! ^ 1;
    expect(() => decodeHumanRecoveryArchive(wrongDomain)).toThrow(
      "Recovery archive domain is unsupported",
    );
    const invalidRecoveryKeyId = wire.slice();
    const keyIdOffset = findNeedle(invalidRecoveryKeyId, "recovery-key-3");
    expect(keyIdOffset).toBeGreaterThanOrEqual(0);
    invalidRecoveryKeyId[keyIdOffset] = 0x2f;
    expect(() => decodeHumanRecoveryArchive(invalidRecoveryKeyId)).toThrow(
      "Recovery key id",
    );
    expect(() => decodeHumanRecoveryArchive(null as never)).toThrow(
      "Recovery archive exceeds the 64 MiB aggregate-byte limit",
    );
    expect(thrownMessage(() =>
      decodeHumanRecoveryArchive("archive" as never)
    )).toBe("Recovery archive exceeds the 64 MiB aggregate-byte limit");
    expect(thrownMessage(() =>
      decodeHumanRecoveryArchive(
        new LengthSpoofedBytes(V2_LIMITS.recoveryArchiveBytes + 1),
      )
    )).toBe("Recovery archive exceeds the 64 MiB aggregate-byte limit");
  });
});
