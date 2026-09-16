import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  cryptoDeviceId,
  humanId,
} from "@nautilo/lattice-crypto";
import {
  createDeviceRevocationManifest,
  verifyDeviceRevocationManifest,
  type DeviceRevocationManifest,
  type DeviceRevocationManifestUnsigned,
  type DeviceRevocationRegistryDevice,
  type ResolveDeviceRevocationDevice,
} from "../../src/index.ts";

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
}

async function fixture(input: { selfRevoke?: boolean } = {}) {
  const crypto = new LatticeCrypto();
  const issuerSigning = crypto.generateSigningKeyPair();
  const issuerEncryption = await crypto.generateEncryptionKeyPair();
  const targetSigning = input.selfRevoke
    ? issuerSigning
    : crypto.generateSigningKeyPair();
  const targetEncryption = input.selfRevoke
    ? issuerEncryption
    : await crypto.generateEncryptionKeyPair();
  const human = humanId("00000000-0000-4000-8000-00000000000a");
  const issuerDeviceId = cryptoDeviceId("device_alice_issuer");
  const targetDeviceId = input.selfRevoke
    ? issuerDeviceId
    : cryptoDeviceId("device_alice_target");
  const targetFingerprint = crypto.hash(
    concat(targetSigning.publicKey, targetEncryption.publicKey),
  );
  const unsigned: DeviceRevocationManifestUnsigned = {
    formatVersion: 1,
    operationId: "operation_revoke_alice_target",
    idempotencyKey: "revoke_alice_target",
    humanId: human,
    issuerDeviceId,
    targetDeviceId,
    expectedIssuerDeviceRevision: 7,
    expectedTargetDeviceRevision: input.selfRevoke ? 7 : 4,
    targetPublicFingerprint: targetFingerprint,
    targetSigningPublicKeyDigest: crypto.hash(targetSigning.publicKey),
    targetEncryptionPublicKeyDigest: crypto.hash(targetEncryption.publicKey),
    expectedCustodyRevision: 11,
    expectedRecoveryGeneration: 3,
    expectedInventoryRevision: 5,
    expectedInventoryCount: 3,
    expectedInventoryDigest: new Uint8Array(32).fill(0x41),
    domains: [{
      domainId: "domain_ab",
      expectedEpoch: 9,
      expectedAuthorizationRevision: 2,
      expectedParticipantDigest: new Uint8Array(32).fill(0x51),
      namespaces: [{
        namespaceId: "namespace_one",
        expectedAccessRevision: 12,
        expectedBindingHash: new Uint8Array(32).fill(0x61),
      }, {
        namespaceId: "namespace_two",
        expectedAccessRevision: 4,
        expectedBindingHash: new Uint8Array(32).fill(0x62),
      }],
    }, {
      domainId: "domain_cd",
      expectedEpoch: 3,
      expectedAuthorizationRevision: 1,
      expectedParticipantDigest: new Uint8Array(32).fill(0x52),
      namespaces: [{
        namespaceId: "namespace_three",
        expectedAccessRevision: 8,
        expectedBindingHash: new Uint8Array(32).fill(0x63),
      }],
    }],
    issuedAt: 100_000,
  };
  const manifest = createDeviceRevocationManifest({
    crypto,
    manifest: unsigned,
    issuerSigningPrivateKey: issuerSigning.privateKey,
  });
  const records = new Map<string, DeviceRevocationRegistryDevice>([
    [issuerDeviceId, {
      state: "active" as const,
      humanId: human,
      revision: 7,
      signingPublicKey: issuerSigning.publicKey,
      encryptionPublicKey: issuerEncryption.publicKey,
      publicFingerprint: crypto.hash(
        concat(issuerSigning.publicKey, issuerEncryption.publicKey),
      ),
    }],
    [targetDeviceId, {
      state: "active" as const,
      humanId: human,
      revision: input.selfRevoke ? 7 : 4,
      signingPublicKey: targetSigning.publicKey,
      encryptionPublicKey: targetEncryption.publicKey,
      publicFingerprint: targetFingerprint,
    }],
  ]);
  const resolveDevice: ResolveDeviceRevocationDevice = (deviceId) =>
    records.get(deviceId) ?? null;
  return {
    crypto,
    issuerSigning,
    targetSigning,
    unsigned,
    manifest,
    records,
    resolveDevice,
  };
}

describe("device revocation manifest", () => {
  test("binds one exact canonical Domain and Namespace inventory", async () => {
    const setup = await fixture();
    const verified = verifyDeviceRevocationManifest({
      crypto: setup.crypto,
      manifest: setup.manifest,
      resolveDevice: setup.resolveDevice,
    });

    expect(verified.manifest).toEqual(setup.manifest);
    expect(verified.domainCount).toBe(2);
    expect(verified.namespaceCount).toBe(3);
    expect(verified.authorizationArtifactHash).toHaveLength(32);
  });

  test("allows an active device to revoke itself", async () => {
    const setup = await fixture({ selfRevoke: true });
    expect(
      verifyDeviceRevocationManifest({
        crypto: setup.crypto,
        manifest: setup.manifest,
        resolveDevice: setup.resolveDevice,
      }).manifest.targetDeviceId,
    ).toBe(setup.manifest.issuerDeviceId);
  });

  test("rejects field, signature, target, and authority substitution", async () => {
    const setup = await fixture();
    const cases: DeviceRevocationManifest[] = [
      {
        ...setup.manifest,
        expectedCustodyRevision:
          setup.manifest.expectedCustodyRevision + 1,
      },
      {
        ...setup.manifest,
        targetPublicFingerprint: new Uint8Array(32).fill(0x99),
      },
      {
        ...setup.manifest,
        signature: new Uint8Array(64).fill(0x88),
      },
      {
        ...setup.manifest,
        domains: [...setup.manifest.domains].reverse(),
      },
    ];
    for (const manifest of cases) {
      expect(() =>
        verifyDeviceRevocationManifest({
          crypto: setup.crypto,
          manifest,
          resolveDevice: setup.resolveDevice,
        })
      ).toThrow();
    }

    const issuer = setup.records.get(setup.manifest.issuerDeviceId)!;
    setup.records.set(setup.manifest.issuerDeviceId, {
      ...issuer,
      state: "revoked",
    });
    expect(() =>
      verifyDeviceRevocationManifest({
        crypto: setup.crypto,
        manifest: setup.manifest,
        resolveDevice: setup.resolveDevice,
      })
    ).toThrow("issuer");
  });

  test("rejects noncanonical, incomplete, duplicate, and unbounded inventory", async () => {
    const setup = await fixture();
    const duplicateNamespace = {
      ...setup.unsigned,
      domains: [{
        ...setup.unsigned.domains[0]!,
        namespaces: [
          setup.unsigned.domains[0]!.namespaces[0]!,
          setup.unsigned.domains[0]!.namespaces[0]!,
        ],
      }],
    };
    expect(() =>
      createDeviceRevocationManifest({
        crypto: setup.crypto,
        manifest: duplicateNamespace,
        issuerSigningPrivateKey: setup.issuerSigning.privateKey,
      })
    ).toThrow("canonically ordered");

    expect(() =>
      createDeviceRevocationManifest({
        crypto: setup.crypto,
        manifest: {
          ...setup.unsigned,
          expectedInventoryDigest: null,
        },
        issuerSigningPrivateKey: setup.issuerSigning.privateKey,
      })
    ).toThrow("all null or complete");

    expect(() =>
      createDeviceRevocationManifest({
        crypto: setup.crypto,
        manifest: {
          ...setup.unsigned,
          domains: Array.from(
            { length: 257 },
            (_, index) => ({
              domainId: `domain_${String(index).padStart(3, "0")}`,
              expectedEpoch: 1,
              expectedAuthorizationRevision: 1,
              expectedParticipantDigest: new Uint8Array(32),
              namespaces: [],
            }),
          ),
        },
        issuerSigningPrivateKey: setup.issuerSigning.privateKey,
      })
    ).toThrow("too many Domains");

    expect(() =>
      verifyDeviceRevocationManifest({
        crypto: setup.crypto,
        manifest: {
          ...setup.manifest,
          unexpected: true,
        } as DeviceRevocationManifest,
        resolveDevice: setup.resolveDevice,
      })
    ).toThrow("fields");
  });
});
