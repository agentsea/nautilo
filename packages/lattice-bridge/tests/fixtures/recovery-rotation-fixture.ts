import {
  LatticeCrypto,
  cryptoDeviceId,
  humanId,
  publishHumanRecoveryArchive,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {
  recoveryKeyGenerationV2,
} from "@nautilo/lattice-crypto/wire";
import {
  createRecoveryRotationSubmission,
  verifyRecoveryRotationSubmission,
} from "../../src/index.ts";

export async function createRecoveryRotationFixture(input: {
  readonly humanId?: string;
  readonly issuerDeviceId?: string;
  readonly expectedCustodyRevision?: number;
  readonly expectedRecoveryGeneration?: number;
  readonly expectedIssuerDeviceRevision?: number;
} = {}) {
  const crypto = new LatticeCrypto();
  const issuer = crypto.generateSigningKeyPair();
  const recovery = await crypto.createRecoveryKit();
  const human = humanId(input.humanId ?? "human_alice");
  const issuerDeviceId = cryptoDeviceId(
    input.issuerDeviceId ?? "device_alice_desktop",
  );
  const expectedCustodyRevision = input.expectedCustodyRevision ?? 7;
  const expectedRecoveryGeneration = input.expectedRecoveryGeneration ?? 1;
  const expectedIssuerDeviceRevision =
    input.expectedIssuerDeviceRevision ?? 4;
  const archive = await publishHumanRecoveryArchive({
    crypto,
    humanId: human,
    recoveryKeyId: recovery.keyId,
    recoveryGeneration: recoveryKeyGenerationV2(2),
    recoveryPublicKey: recovery.publicKey,
    resolveTrustedCurrentRecoveryKey: () => ({
      humanId: human,
      recoveryKeyId: recovery.keyId,
      recoveryGeneration: recoveryKeyGenerationV2(2),
      publicKeyDigest: crypto.hash(recovery.publicKey),
    }),
    issuerDeviceId,
    createdAt: unixTimestamp(40_000),
    sources: [],
    issuerSigningPrivateKey: issuer.privateKey,
    resolveIssuerDevice: () => issuer.publicKey,
  });
  const submission = createRecoveryRotationSubmission({
    crypto,
    expectedCustodyRevision,
    expectedRecoveryGeneration,
    expectedIssuerDeviceRevision,
    expectedInventoryRevision: null,
    expectedInventoryCount: null,
    expectedInventoryDigest: null,
    recoveryPublicKey: recovery.publicKey,
    archiveBytes: archive.archiveBytes,
    issuerSigningPrivateKey: issuer.privateKey,
  });
  const verify = (
    candidate = submission,
    overrides: Partial<Parameters<
      typeof verifyRecoveryRotationSubmission
    >[0]> = {},
  ) =>
    verifyRecoveryRotationSubmission({
      crypto,
      submission: candidate,
      expectedHumanId: human,
      currentCustodyRevision: expectedCustodyRevision,
      currentRecoveryGeneration: expectedRecoveryGeneration,
      resolveActiveIssuer: (deviceId) =>
        deviceId === issuerDeviceId
          ? {
            state: "active",
            humanId: human,
            revision: expectedIssuerDeviceRevision,
            signingPublicKey: issuer.publicKey,
          }
          : null,
      ...overrides,
    });
  return {
    crypto,
    issuer,
    recovery,
    human,
    issuerDeviceId,
    archive,
    submission,
    verify,
  };
}
