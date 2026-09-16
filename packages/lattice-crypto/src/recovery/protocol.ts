import type { LatticeCrypto, RecoveryKit } from "../crypto/index.ts";
import { LATTICE_LIMITS } from "../limits.ts";
import type {
  DeviceId,
  Epoch,
  NamespaceId,
  UserId,
} from "../types/index.ts";
import { concat, utf8 } from "../util/bytes.ts";
import {
  assertBytes,
  assertEpoch,
  assertId,
  assertTimestamp,
} from "../validation.ts";

export const EPOCH_SECRET_PACKAGE_FORMAT_VERSION = 1 as const;
export const DEVICE_APPROVAL_FORMAT_VERSION = 1 as const;
export const RECOVERY_ARCHIVE_FORMAT_VERSION = 1 as const;

export type EpochSecretPurpose = "device-transfer" | "recovery";

export interface EpochSecretPackage {
  formatVersion: 1;
  purpose: EpochSecretPurpose;
  id: string;
  userId: UserId;
  namespaceId: NamespaceId;
  epoch: Epoch;
  issuerDeviceId: DeviceId;
  recipientId: string;
  generation: number;
  createdAt: number;
  encryptedSecret: Uint8Array;
  signature: Uint8Array;
}

export interface DeviceApproval {
  formatVersion: 1;
  userId: UserId;
  targetDeviceId: DeviceId;
  issuerDeviceId: DeviceId;
  createdAt: number;
  packages: EpochSecretPackage[];
  signature: Uint8Array;
}

export interface RecoveryArchive {
  formatVersion: 1;
  userId: UserId;
  recoveryKeyId: string;
  generation: number;
  issuerDeviceId: DeviceId;
  createdAt: number;
  packages: EpochSecretPackage[];
  signature: Uint8Array;
}

export interface RecoveryPublicKeyRecord {
  userId: UserId;
  keyId: string;
  publicKey: Uint8Array;
  generation: number;
}

const PACKAGE_DOMAIN = utf8(
  "nautilo/lattice-crypto/epoch-secret-package/v1",
);
const DEVICE_APPROVAL_DOMAIN = utf8(
  "nautilo/lattice-crypto/device-approval/v1",
);
const RECOVERY_ARCHIVE_DOMAIN = utf8(
  "nautilo/lattice-crypto/recovery-archive/v1",
);

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return out;
}

function frame(value: Uint8Array): Uint8Array {
  return concat(u32(value.length), value);
}

function text(value: string): Uint8Array {
  return frame(utf8(value));
}

function purposeByte(purpose: EpochSecretPurpose): Uint8Array {
  return new Uint8Array([purpose === "device-transfer" ? 0 : 1]);
}

function validatePackage(value: EpochSecretPackage): void {
  if (value.formatVersion !== EPOCH_SECRET_PACKAGE_FORMAT_VERSION) {
    throw new Error("unsupported epoch-secret package format");
  }
  if (value.purpose !== "device-transfer" && value.purpose !== "recovery") {
    throw new Error("invalid epoch-secret package purpose");
  }
  assertId("epoch-secret package id", value.id);
  assertId("epoch-secret package user id", value.userId);
  assertId("epoch-secret package namespace id", value.namespaceId);
  assertEpoch("epoch-secret package epoch", value.epoch);
  assertId("epoch-secret package issuer device id", value.issuerDeviceId);
  assertId("epoch-secret package recipient id", value.recipientId);
  assertTimestamp("epoch-secret package generation", value.generation);
  assertTimestamp("epoch-secret package creation time", value.createdAt);
  assertBytes(
    "encrypted epoch secret",
    value.encryptedSecret,
    1,
    LATTICE_LIMITS.recoveryPackageBytes,
  );
  assertBytes("epoch-secret package signature", value.signature, 64, 64);
}

export function epochSecretPackageSigningBytes(
  value: Omit<EpochSecretPackage, "signature"> | EpochSecretPackage,
): Uint8Array {
  return concat(
    frame(PACKAGE_DOMAIN),
    u32(value.formatVersion),
    purposeByte(value.purpose),
    text(value.id),
    text(value.userId),
    text(value.namespaceId),
    u64(value.epoch),
    text(value.issuerDeviceId),
    text(value.recipientId),
    u64(value.generation),
    u64(value.createdAt),
    frame(value.encryptedSecret),
  );
}

export function epochSecretPackageKey(value: EpochSecretPackage): string {
  return `${value.namespaceId}@${value.epoch}`;
}

export function sortEpochSecretPackages(
  packages: EpochSecretPackage[],
): EpochSecretPackage[] {
  return [...packages].sort((left, right) => {
    const leftKey = epochSecretPackageKey(left);
    const rightKey = epochSecretPackageKey(right);
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
    return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
  });
}

export async function createEpochSecretPackage(params: {
  crypto: LatticeCrypto;
  purpose: EpochSecretPurpose;
  id: string;
  userId: UserId;
  namespaceId: NamespaceId;
  epoch: Epoch;
  issuerDeviceId: DeviceId;
  issuerSigningPrivateKey: Uint8Array;
  recipientId: string;
  recipientPublicKey: Uint8Array;
  generation: number;
  createdAt: number;
  secret: Uint8Array;
}): Promise<EpochSecretPackage> {
  assertBytes("retained epoch secret", params.secret, 32, 32);
  const base: Omit<EpochSecretPackage, "signature"> = {
    formatVersion: EPOCH_SECRET_PACKAGE_FORMAT_VERSION,
    purpose: params.purpose,
    id: params.id,
    userId: params.userId,
    namespaceId: params.namespaceId,
    epoch: params.epoch,
    issuerDeviceId: params.issuerDeviceId,
    recipientId: params.recipientId,
    generation: params.generation,
    createdAt: params.createdAt,
    encryptedSecret: await params.crypto.sealTo(
      params.recipientPublicKey,
      params.secret,
    ),
  };
  const signature = params.crypto.sign(
    params.issuerSigningPrivateKey,
    epochSecretPackageSigningBytes(base),
  );
  const result = { ...base, signature };
  validatePackage(result);
  return result;
}

export async function verifyAndOpenEpochSecretPackage(params: {
  crypto: LatticeCrypto;
  package: EpochSecretPackage;
  issuerSigningPublicKey: Uint8Array;
  recipientPrivateKey: Uint8Array;
}): Promise<Uint8Array | null> {
  try {
    validatePackage(params.package);
  } catch {
    return null;
  }
  if (
    !params.crypto.verify(
      params.issuerSigningPublicKey,
      epochSecretPackageSigningBytes(params.package),
      params.package.signature,
    )
  ) {
    return null;
  }
  const secret = await params.crypto.openSealed(
    params.recipientPrivateKey,
    params.package.encryptedSecret,
  );
  return secret?.length === 32 ? secret : null;
}

function packageFrames(packages: EpochSecretPackage[]): Uint8Array {
  if (
    !Array.isArray(packages) ||
    packages.length > LATTICE_LIMITS.recoveryPackages
  ) {
    throw new RangeError("retained history exceeds the package limit");
  }
  for (const item of packages) validatePackage(item);
  const canonical = sortEpochSecretPackages(packages);
  return concat(
    u32(canonical.length),
    ...canonical.map((item) =>
      frame(concat(epochSecretPackageSigningBytes(item), frame(item.signature)))
    ),
  );
}

export function deviceApprovalSigningBytes(
  value: Omit<DeviceApproval, "signature"> | DeviceApproval,
): Uint8Array {
  return concat(
    frame(DEVICE_APPROVAL_DOMAIN),
    u32(value.formatVersion),
    text(value.userId),
    text(value.targetDeviceId),
    text(value.issuerDeviceId),
    u64(value.createdAt),
    packageFrames(value.packages),
  );
}

export function recoveryArchiveSigningBytes(
  value: Omit<RecoveryArchive, "signature"> | RecoveryArchive,
): Uint8Array {
  return concat(
    frame(RECOVERY_ARCHIVE_DOMAIN),
    u32(value.formatVersion),
    text(value.userId),
    text(value.recoveryKeyId),
    u64(value.generation),
    text(value.issuerDeviceId),
    u64(value.createdAt),
    packageFrames(value.packages),
  );
}

function clonePackage(value: EpochSecretPackage): EpochSecretPackage {
  return {
    ...value,
    encryptedSecret: value.encryptedSecret.slice(),
    signature: value.signature.slice(),
  };
}

function cloneArchive(value: RecoveryArchive): RecoveryArchive {
  return {
    ...value,
    packages: value.packages.map(clonePackage),
    signature: value.signature.slice(),
  };
}

/** Reference public relay. It deliberately has no crypto keys capable of
 * opening an archive; its snapshot models what a database thief can obtain. */
export class InMemoryRecoveryRelay {
  private readonly keys = new Map<UserId, RecoveryPublicKeyRecord>();
  private readonly archives = new Map<UserId, RecoveryArchive>();

  publishRecoveryKey(
    userId: UserId,
    keyId: string,
    publicKey: Uint8Array,
    generation: number,
  ): Promise<void> {
    assertId("recovery user id", userId);
    assertId("recovery key id", keyId);
    assertBytes("recovery public key", publicKey, 65, 65);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      return Promise.reject(new Error("recovery generation must be positive"));
    }
    const current = this.keys.get(userId);
    if (current && generation <= current.generation) {
      return Promise.reject(new Error("recovery generation must advance"));
    }
    this.keys.set(userId, {
      userId,
      keyId,
      publicKey: publicKey.slice(),
      generation,
    });
    this.archives.delete(userId);
    return Promise.resolve();
  }

  publishArchive(archive: RecoveryArchive): Promise<void> {
    const key = this.keys.get(archive.userId);
    if (
      !key ||
      key.keyId !== archive.recoveryKeyId ||
      key.generation !== archive.generation
    ) {
      return Promise.reject(
        new Error("archive does not match the published recovery key"),
      );
    }
    this.archives.set(archive.userId, cloneArchive(archive));
    return Promise.resolve();
  }

  getArchive(userId: UserId): Promise<RecoveryArchive | null> {
    const value = this.archives.get(userId);
    return Promise.resolve(value ? cloneArchive(value) : null);
  }

  snapshot(): {
    recoveryKeys: RecoveryPublicKeyRecord[];
    archives: RecoveryArchive[];
  } {
    return {
      recoveryKeys: [...this.keys.values()].map((value) => ({
        ...value,
        publicKey: value.publicKey.slice(),
      })),
      archives: [...this.archives.values()].map(cloneArchive),
    };
  }
}

export function recoveryKitMatchesArchive(
  kit: RecoveryKit,
  archive: RecoveryArchive,
): boolean {
  return (
    kit.formatVersion === 1 &&
    kit.keyId === archive.recoveryKeyId &&
    kit.publicKey.length === 65
  );
}
