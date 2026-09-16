import { randomUUID } from "node:crypto";

import {
  type DirectDatabase,
  type PostgresJsBridgeConnection,
  humanCryptoCustodies,
  humanCryptoDeviceAdmissionChallenges,
  humanCryptoDeviceAdmissions,
  humanCryptoDeviceGroupAcknowledgements,
  humanCryptoDeviceGroupCommits,
  humanCryptoDeviceGroupHeads,
  humanCryptoDeviceGroupJoinRequests,
  humanCryptoDeviceGroupWelcomes,
  humanCryptoDeviceKeyPackages,
  humanCryptoDevices,
  humanCryptoRecoveryKeys,
} from "@nautilo/db";
import {
  DeviceProviderStateVault,
  HumanDeviceOpenMlsGroup,
  LatticeCrypto,
  cryptoDeviceId,
  encodeHumanDeviceGroupHead,
  humanId,
} from "@nautilo/lattice-crypto";
import {
  PostgresHumanDeviceGroupRepository,
  verifyCryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import { and, eq } from "drizzle-orm";

function digest(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

export interface BackfillDeviceCustodyFixture {
  readonly deviceId: string;
  readonly signing: Readonly<{
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  }>;
  readonly encryption: Readonly<{
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  }>;
  readonly lineage: Uint8Array;
  readonly membershipVault: DeviceProviderStateVault;
  /**
   * Call after deleting Domain recipient rows and object storage that refer to
   * this device. This removes only rows keyed to the returned Human/device.
   */
  cleanup(): Promise<void>;
}

type BackfillCustodyAdminDatabase = Pick<
  DirectDatabase,
  "delete" | "insert"
>;

/**
 * Seeds one current founding device using the same MLS repository transition
 * as production. The caller owns the Human/User rows and Server identity.
 */
export async function seedBackfillDevice(input: Readonly<{
  adminDb: BackfillCustodyAdminDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  userId: string;
  humanActorId: string;
  serverInstanceId: string;
  deviceId?: string;
  installationLineageDigest?: Uint8Array;
}>): Promise<BackfillDeviceCustodyFixture> {
  const deviceId = input.deviceId ?? `browser-${randomUUID()}`;
  const recoveryKeyId = `recovery-${randomUUID()}`;
  const signing = input.crypto.generateSigningKeyPair();
  const encryption = await input.crypto.generateEncryptionKeyPair();
  const recovery = await input.crypto.generateEncryptionKeyPair();
  const lineage = input.installationLineageDigest?.slice() ?? input.crypto.hash(
    new TextEncoder().encode(`m313-lineage:${deviceId}`),
  );
  const authorizationEvidenceDigest = input.crypto.hash(
    new TextEncoder().encode(`m313-first-bootstrap:${deviceId}`),
  );
  const publicFingerprint = input.crypto.hash(signing.publicKey);
  const recoveryPublicKeyDigest = input.crypto.hash(recovery.publicKey);
  const archiveHash = digest(0x43);
  const membershipKey = input.crypto.hash(
    new TextEncoder().encode(`m313-membership:${deviceId}`),
  );
  const membershipVault = DeviceProviderStateVault.fromKey(
    input.crypto,
    cryptoDeviceId(deviceId),
    membershipKey,
  );
  membershipKey.fill(0);
  const now = new Date();
  let seeded = false;
  let cleaned = false;
  let disposed = false;

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    try {
      // Admissions reference the exact device generation with NO ACTION.
      await input.adminDb.delete(humanCryptoDeviceAdmissions).where(and(
        eq(humanCryptoDeviceAdmissions.humanActorId, input.humanActorId),
        eq(humanCryptoDeviceAdmissions.deviceId, deviceId),
      ));
      await input.adminDb.delete(humanCryptoDeviceAdmissionChallenges).where(and(
        eq(humanCryptoDeviceAdmissionChallenges.humanActorId, input.humanActorId),
        eq(humanCryptoDeviceAdmissionChallenges.deviceId, deviceId),
      ));

      // MLS children precede the current head/device/custody parents. Genesis
      // creates the acknowledgement and head; the wider list also makes an
      // interrupted later membership ceremony safe to clean by exact Human.
      await input.adminDb.delete(humanCryptoDeviceGroupAcknowledgements).where(and(
        eq(humanCryptoDeviceGroupAcknowledgements.humanId, input.humanActorId),
        eq(humanCryptoDeviceGroupAcknowledgements.deviceId, deviceId),
      ));
      await input.adminDb.delete(humanCryptoDeviceGroupWelcomes).where(
        eq(humanCryptoDeviceGroupWelcomes.humanId, input.humanActorId),
      );
      await input.adminDb.delete(humanCryptoDeviceGroupCommits).where(
        eq(humanCryptoDeviceGroupCommits.humanId, input.humanActorId),
      );
      await input.adminDb.delete(humanCryptoDeviceGroupJoinRequests).where(
        eq(humanCryptoDeviceGroupJoinRequests.humanId, input.humanActorId),
      );
      await input.adminDb.delete(humanCryptoDeviceGroupHeads).where(
        eq(humanCryptoDeviceGroupHeads.humanId, input.humanActorId),
      );
      await input.adminDb.delete(humanCryptoDeviceKeyPackages).where(
        eq(humanCryptoDeviceKeyPackages.deviceId, deviceId),
      );
      await input.adminDb.delete(humanCryptoRecoveryKeys).where(and(
        eq(humanCryptoRecoveryKeys.humanId, input.humanActorId),
        eq(humanCryptoRecoveryKeys.recoveryKeyId, recoveryKeyId),
      ));
      await input.adminDb.delete(humanCryptoDevices).where(and(
        eq(humanCryptoDevices.humanId, input.humanActorId),
        eq(humanCryptoDevices.deviceId, deviceId),
      ));
      await input.adminDb.delete(humanCryptoCustodies).where(and(
        eq(humanCryptoCustodies.humanId, input.humanActorId),
        eq(humanCryptoCustodies.userId, input.userId),
      ));
      cleaned = true;
    } finally {
      if (!disposed) {
        disposed = true;
        membershipVault.destroy();
        signing.privateKey.fill(0);
        encryption.privateKey.fill(0);
        recovery.privateKey.fill(0);
        recovery.publicKey.fill(0);
        authorizationEvidenceDigest.fill(0);
        publicFingerprint.fill(0);
        recoveryPublicKeyDigest.fill(0);
        archiveHash.fill(0);
      }
    }
  };

  try {
    await input.adminDb.insert(humanCryptoCustodies).values({
      humanId: input.humanActorId,
      userId: input.userId,
      humanActorId: input.humanActorId,
      initialInstallationLineageDigest: lineage,
      state: "active",
      everInitializedAt: now,
      firstDeviceId: deviceId,
      currentRecoveryGeneration: 1,
      currentRecoveryPublicKeyDigest: recoveryPublicKeyDigest,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await input.adminDb.insert(humanCryptoDevices).values({
      deviceId,
      humanId: input.humanActorId,
      userId: input.userId,
      humanActorId: input.humanActorId,
      clientKind: "browser",
      installationLineageDigest: lineage,
      deviceGeneration: 1,
      signingPublicKey: signing.publicKey,
      encryptionPublicKey: encryption.publicKey,
      publicFingerprint,
      state: "active",
      authorizationKind: "first_bootstrap",
      recoveryGeneration: 1,
      authorizationEvidenceDigest,
      keyPackageGeneration: 1,
      keyPackageCount: 0,
      revision: 1,
      createdAt: now,
      activatedAt: now,
    });
    await input.adminDb.insert(humanCryptoRecoveryKeys).values({
      humanId: input.humanActorId,
      generation: 1,
      recoveryKeyId,
      formatVersion: 1,
      publicKey: recovery.publicKey,
      publicKeyDigest: recoveryPublicKeyDigest,
      archiveHash,
      issuerDeviceId: deviceId,
      state: "current",
      activatedAt: now,
      retiredAt: null,
      revision: 1,
    });

    const coordinates = Object.freeze({
      serverInstanceId: input.serverInstanceId,
      humanId: humanId(input.humanActorId),
      lineageGeneration: 1,
    });
    const membership = new HumanDeviceOpenMlsGroup(
      input.crypto,
      membershipVault,
      {
        coordinates,
        ownCredential: Object.freeze({
          formatVersion: 1 as const,
          ...coordinates,
          deviceId: cryptoDeviceId(deviceId),
          installationLineageDigest: lineage,
          deviceKeyGeneration: 1,
        }),
      },
    );
    await membership.initialize();
    const initial = await membership.createInitialState();
    const repository = new PostgresHumanDeviceGroupRepository(
      await verifyCryptoPostgresHandle(input.restricted),
      input.crypto,
    );
    const established = await repository.establishInitial({
      userId: input.userId,
      humanId: input.humanActorId,
      deviceId,
      headBytes: encodeHumanDeviceGroupHead(initial.head),
      rosterBytes: initial.rosterBytes,
      now: now.getTime(),
    });
    if (established !== "created") {
      throw new Error("M313 founding Human-device group was not created");
    }
    seeded = true;
    return Object.freeze({
      deviceId,
      signing,
      encryption,
      lineage,
      membershipVault,
      cleanup,
    });
  } finally {
    if (!seeded) await cleanup();
  }
}
