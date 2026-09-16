import {
  LatticeCrypto,
  type KeyPair,
  type RecoveryKit,
} from "../crypto/index.ts";
import {
  ENCRYPTED_OBJECT_FORMAT_VERSION,
  objectPayloadAad,
} from "../format/object-v1.ts";
import {
  GRANT_FORMAT_VERSION,
  grantSigningBytes,
} from "../format/grant-v1.ts";
import type { GroupKeyProvider, GroupMember } from "../group/provider.ts";
import type { LatticeScheme, CoveredNamespaceKey, SchemeAccess } from "../lattice/scheme.ts";
import { LATTICE_LIMITS } from "../limits.ts";
import {
  DEVICE_APPROVAL_FORMAT_VERSION,
  EPOCH_SECRET_PACKAGE_FORMAT_VERSION,
  RECOVERY_ARCHIVE_FORMAT_VERSION,
  createEpochSecretPackage,
  deviceApprovalSigningBytes,
  epochSecretPackageKey,
  recoveryArchiveSigningBytes,
  recoveryKitMatchesArchive,
  sortEpochSecretPackages,
  verifyAndOpenEpochSecretPackage,
  type DeviceApproval,
  type EpochSecretPackage,
  type EpochSecretPurpose,
  type RecoveryArchive,
} from "../recovery/protocol.ts";
import type { Storage } from "../storage/store.ts";
import type {
  Device,
  DeviceId,
  Epoch,
  EncryptedObject,
  Grant,
  GrantId,
  GrantOperation,
  NamespaceId,
  NamespaceRecord,
  ObjectId,
  UserId,
} from "../types/index.ts";
import { concat, toHex, utf8 } from "../util/bytes.ts";
import { canonicalizeParticipants, isSubset } from "../util/sets.ts";
import {
  assertBatchSize,
  assertBytes,
  assertGrantTtl,
  assertHistoricalEpochs,
  assertId,
  assertIdList,
  assertPlaintext,
  assertTimestamp,
  canonicalOperations,
  grantShapeFailure,
  idIsValid,
  objectShapeFailure,
  plaintextIsValid,
} from "../validation.ts";

/**
 * Label off the MLS exporter secret for the AI-accessible key subtree. The
 * human-only E2EE subtree would use a DIFFERENT label ("human_e2ee_root") so
 * that a grant can NEVER reach human-only content. Only the AI-accessible
 * root is grantable; that split is the load-bearing invariant.
 */
const AI_ACCESSIBLE_LABEL = "ai_accessible_root";
const EXPORTER_LABEL = "lattice";
const GRANT_CACHE_FINGERPRINT_DOMAIN = new TextEncoder().encode(
  "nautilo/lattice-crypto/grant-cache-fingerprint/v1",
);
const DEVICE_CAPABILITY_DOMAIN = new TextEncoder().encode(
  "nautilo/lattice-crypto/device-capability/v1",
);

/** Internal, fixture-locked challenge bytes; not part of the package export map. */
export function deviceCapabilityChallengeBytes(
  deviceId: DeviceId,
): Uint8Array {
  return concat(DEVICE_CAPABILITY_DOMAIN, utf8(deviceId));
}

/** Internal, fixture-locked cache identity; not an authorization shortcut. */
export function grantCacheFingerprint(
  crypto: LatticeCrypto,
  signingBytes: Uint8Array,
  signature: Uint8Array,
  issuerSigningPublicKey: Uint8Array,
): string {
  return toHex(
    crypto.hash(
      concat(
        GRANT_CACHE_FINGERPRINT_DOMAIN,
        crypto.hash(signingBytes),
        crypto.hash(signature),
        crypto.hash(issuerSigningPublicKey),
      ),
    ),
  );
}

export interface EngineDeps {
  storage: Storage;
  scheme: LatticeScheme;
  group: GroupKeyProvider;
  crypto?: LatticeCrypto;
}

/** Handed to the caller when a device is registered; private keys stay with
 *  the caller (the device), never in storage. */
export interface DeviceRegistration {
  device: Device;
  encryptionPrivateKey: Uint8Array;
  signingPrivateKey: Uint8Array;
  capability: DeviceCapability;
}

/** Device-held authority presented to operations that touch MLS exporters.
 * The private key never enters storage; the engine proves it matches the
 * registered, authorized, unrevoked device before deriving any namespace key. */
export interface DeviceCapability {
  deviceId: DeviceId;
  signingPrivateKey: Uint8Array;
}

/** The agent's ephemeral keypair. A member device wraps a grant secret to
 *  `keyPair.publicKey`; the agent opens it with `keyPair.privateKey`. */
export interface DelegationSession {
  keyPair: KeyPair;
  /**
   * Per-session memoization of the two PURE, O(#accessible-namespaces) costs of
   * using a grant: verifying its signature (re-serialising + Ed25519 over the
   * whole grant) and opening its sealed key map (HPKE open + parse).
   *
   * The WeakMap lookup is only a lifecycle optimization. Every cache entry also
   * carries a cryptographic fingerprint over the exact signed bytes, signature,
   * and issuer public key. The fingerprint is recomputed on every use; an
   * in-place mutation therefore misses the cached value and must pass signature
   * verification again. This keeps weak-reference eviction and avoids repeated
   * public-key verification and sealed-map opening. Recomputing the fingerprint
   * remains linear in the signed grant size on every call. Dynamic gates (device
   * revocation, expiry, single-use consumption, epoch) also run on every call.
   */
  verifiedSignatures: WeakMap<Grant, string>;
  accessCache: WeakMap<Grant, { fingerprint: string; access: SchemeAccess }>;
}

export interface MintGrantParams {
  issuer: DeviceCapability;
  scope: UserId[];
  recipientPublicKey: Uint8Array;
  ttlMs: number;
  /** Retained historical epochs to include in addition to each namespace's
   * current epoch. Availability remains device/provider-authoritative. */
  historicalEpochs?: Record<NamespaceId, Epoch[]>;
  operations?: GrantOperation[];
  singleUse?: boolean;
}

/** One item for `encryptMany`: the target namespace + the plaintext to seal. */
export interface EncryptManyItem {
  namespaceId: NamespaceId;
  plaintext: Uint8Array;
}

export type DecryptResult =
  | { ok: true; plaintext: Uint8Array }
  | { ok: false; reason: DenyReason };

export type EncryptResult =
  | { ok: true; object: EncryptedObject }
  | { ok: false; reason: DenyReason };

export type DenyReason =
  | "grant_invalid_signature"
  | "grant_device_revoked"
  | "grant_expired"
  | "grant_consumed"
  | "operation_not_permitted"
  | "out_of_scope"
  | "epoch_rotated"
  | "epoch_mismatch"
  | "grant_open_failed"
  | "unwrap_failed"
  | "wrap_failed"
  | "decrypt_failed"
  | "unsupported_object_format"
  | "object_not_found"
  | "namespace_not_found"
  | "invalid_input";

export interface GrantCheck {
  ok: boolean;
  reason?: DenyReason;
}

type InternalGrantCheck =
  | { ok: true; fingerprint: string; grant: Grant }
  | { ok: false; reason: DenyReason };

type DecryptPlan =
  | { eligible: true; object: EncryptedObject }
  | { eligible: false; result: DecryptResult };

type EncryptPlan =
  | { eligible: true; item: EncryptManyItem; epoch: Epoch }
  | { eligible: false; result: EncryptResult };

/**
 * LatticeCryptoEngine — owns provider-agnostic business logic. Implementations
 * can swap behind the three seams without changing it; security fixes may still
 * evolve the seam contract itself.
 *
 * Client/server discipline: operations that read the group exporter secret —
 * `encryptObject`, `mintGrant` — require an authenticated current-device
 * capability. `decryptObject` is the agent-side path and touches only the grant,
 * never the group provider: the server holds zero persistent decryption keys.
 */
export class LatticeCryptoEngine {
  private readonly storage: Storage;
  private readonly scheme: LatticeScheme;
  private readonly group: GroupKeyProvider;
  private readonly crypto: LatticeCrypto;

  constructor(deps: EngineDeps) {
    this.storage = deps.storage;
    this.scheme = deps.scheme;
    this.group = deps.group;
    this.crypto = deps.crypto ?? new LatticeCrypto();
  }

  private newId(prefix: string): string {
    return `${prefix}_${toHex(this.crypto.randomBytes(16))}`;
  }

  // ---- Users + devices ---------------------------------------------------

  async registerUser(id: UserId): Promise<void> {
    assertId("user id", id);
    await this.storage.putUser(id);
  }

  async registerDevice(userId: UserId): Promise<DeviceRegistration> {
    assertId("user id", userId);
    await this.storage.putUser(userId);
    const existingDevices = await this.storage.listDevices(userId);
    const authorized = existingDevices.length === 0;
    const enc = await this.crypto.generateEncryptionKeyPair();
    const sig = this.crypto.generateSigningKeyPair();
    const device: Device = {
      id: this.newId("dev"),
      userId,
      encryptionPublicKey: enc.publicKey,
      signingPublicKey: sig.publicKey,
      authorized,
      revoked: false,
      createdAt: this.crypto.clock.now(),
    };
    await this.storage.putDevice(device);
    if (authorized) {
      for (const namespace of await this.storage.listNamespaces()) {
        if (!namespace.participants.includes(userId)) continue;
        await this.group.addDevices(namespace.id, [{ deviceId: device.id, userId }]);
      }
    }
    await this.storage.appendAudit({
      at: this.crypto.clock.now(),
      event: authorized ? "device.register" : "device.pending",
      detail: { deviceId: device.id, userId, authorized },
    });
    return {
      device,
      encryptionPrivateKey: enc.privateKey,
      signingPrivateKey: sig.privateKey,
      capability: {
        deviceId: device.id,
        signingPrivateKey: sig.privateKey,
      },
    };
  }

  async revokeDevice(id: DeviceId): Promise<void> {
    assertId("device id", id);
    const device = await this.storage.getDevice(id);
    if (!device || device.revoked) return;
    await this.storage.revokeDevice(id);
    for (const namespace of await this.storage.listNamespaces()) {
      if (!this.group.roster(namespace.id).some((member) => member.deviceId === id)) {
        continue;
      }
      const newEpoch = await this.group.removeDevices(namespace.id, [id]);
      await this.storage.updateNamespace(namespace.id, { currentEpoch: newEpoch });
      await this.storage.appendAudit({
        at: this.crypto.clock.now(),
        event: "epoch.rotate",
        detail: { namespaceId: namespace.id, newEpoch, revokedDeviceId: id },
      });
    }
    await this.storage.appendAudit({
      at: this.crypto.clock.now(),
      event: "device.revoke",
      detail: { deviceId: id },
    });
  }

  async listDevices(userId: UserId): Promise<Device[]> {
    assertId("user id", userId);
    return this.storage.listDevices(userId);
  }

  private async validateRecoveryKit(kit: RecoveryKit): Promise<KeyPair> {
    if (
      kit.formatVersion !== 1 ||
      !(kit.secret instanceof Uint8Array) ||
      kit.secret.length !== 32 ||
      !(kit.publicKey instanceof Uint8Array) ||
      kit.publicKey.length !== LATTICE_LIMITS.hpkePublicKeyBytes
    ) {
      throw new Error("invalid recovery kit");
    }
    const keyPair = await this.crypto.deriveEncryptionKeyPair(kit.secret);
    if (
      keyPair.publicKey.length !== kit.publicKey.length ||
      !keyPair.publicKey.every((byte, index) => byte === kit.publicKey[index])
    ) {
      throw new Error("recovery key does not match recovery secret");
    }
    const keyId = `recovery_${toHex(
      this.crypto.hash(keyPair.publicKey).subarray(0, 16),
    )}`;
    if (kit.keyId !== keyId) {
      throw new Error("recovery key id does not match recovery secret");
    }
    return keyPair;
  }

  async createRecoveryKit(): Promise<RecoveryKit> {
    return this.crypto.createRecoveryKit();
  }

  private async epochPackages(params: {
    issuer: Device;
    issuerCapability: DeviceCapability;
    purpose: EpochSecretPurpose;
    recipientId: string;
    recipientPublicKey: Uint8Array;
    generation: number;
  }): Promise<EpochSecretPackage[]> {
    const packages: EpochSecretPackage[] = [];
    const namespaces = (await this.storage.listNamespaces())
      .filter((namespace) => namespace.participants.includes(params.issuer.userId))
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const namespace of namespaces) {
      if (!this.group.roster(namespace.id).some(
        (member) => member.deviceId === params.issuer.id,
      )) {
        continue;
      }
      for (const epoch of this.group.retainedEpochs(
        namespace.id,
        params.issuer.id,
      )) {
        if (packages.length >= LATTICE_LIMITS.recoveryPackages) {
          throw new RangeError("retained history exceeds the package limit");
        }
        packages.push(await createEpochSecretPackage({
          crypto: this.crypto,
          purpose: params.purpose,
          id: this.newId("rootpkg"),
          userId: params.issuer.userId,
          namespaceId: namespace.id,
          epoch,
          issuerDeviceId: params.issuer.id,
          issuerSigningPrivateKey:
            params.issuerCapability.signingPrivateKey,
          recipientId: params.recipientId,
          recipientPublicKey: params.recipientPublicKey,
          generation: params.generation,
          createdAt: this.crypto.clock.now(),
          secret: await this.group.exportEpochSecret(
            namespace.id,
            epoch,
            params.issuer.id,
          ),
        }));
      }
    }
    return sortEpochSecretPackages(packages);
  }

  /** Existing-device authorization for a pending same-user device. The
   * returned packages are safe to relay: every retained root is HPKE-sealed to
   * the pending device and the complete manifest is signed by the issuer. */
  async approveDevice(
    targetDeviceId: DeviceId,
    issuerCapability: DeviceCapability,
  ): Promise<DeviceApproval> {
    assertId("target device id", targetDeviceId);
    const issuer = await this.capabilityDevice(issuerCapability);
    const target = await this.storage.getDevice(targetDeviceId);
    if (!target || target.revoked || target.authorized) {
      throw new Error("target device is not pending");
    }
    if (target.userId !== issuer.userId) {
      throw new Error("an existing device can approve only the same user");
    }
    const packages = await this.epochPackages({
      issuer,
      issuerCapability,
      purpose: "device-transfer",
      recipientId: target.id,
      recipientPublicKey: target.encryptionPublicKey,
      generation: 0,
    });
    const base: Omit<DeviceApproval, "signature"> = {
      formatVersion: DEVICE_APPROVAL_FORMAT_VERSION,
      userId: issuer.userId,
      targetDeviceId: target.id,
      issuerDeviceId: issuer.id,
      createdAt: this.crypto.clock.now(),
      packages,
    };
    return {
      ...base,
      signature: this.crypto.sign(
        issuerCapability.signingPrivateKey,
        deviceApprovalSigningBytes(base),
      ),
    };
  }

  private async proveEncryptionPrivateKey(
    device: Device,
    privateKey: Uint8Array,
  ): Promise<void> {
    assertBytes(
      "device encryption private key",
      privateKey,
      LATTICE_LIMITS.hpkePrivateKeyBytes,
      LATTICE_LIMITS.hpkePrivateKeyBytes,
    );
    const challenge = this.crypto.randomBytes(32);
    const sealed = await this.crypto.sealTo(
      device.encryptionPublicKey,
      challenge,
    );
    const opened = await this.crypto.openSealed(privateKey, sealed);
    if (
      !opened ||
      opened.length !== challenge.length ||
      !opened.every((byte, index) => byte === challenge[index])
    ) {
      throw new Error("device encryption private key does not match device");
    }
  }

  private async openEpochPackages(params: {
    packages: EpochSecretPackage[];
    issuer: Device;
    expectedPurpose: EpochSecretPurpose;
    expectedUserId: UserId;
    expectedRecipientId: string;
    expectedGeneration: number;
    recipientPrivateKey: Uint8Array;
  }): Promise<Map<string, Uint8Array>> {
    if (params.packages.length > LATTICE_LIMITS.recoveryPackages) {
      throw new RangeError("retained history exceeds the package limit");
    }
    const opened = new Map<string, Uint8Array>();
    for (const item of params.packages) {
      if (
        item.formatVersion !== EPOCH_SECRET_PACKAGE_FORMAT_VERSION ||
        item.purpose !== params.expectedPurpose ||
        item.userId !== params.expectedUserId ||
        item.issuerDeviceId !== params.issuer.id ||
        item.recipientId !== params.expectedRecipientId ||
        item.generation !== params.expectedGeneration
      ) {
        throw new Error("epoch-secret package metadata mismatch");
      }
      const key = epochSecretPackageKey(item);
      if (opened.has(key)) {
        throw new Error("duplicate epoch-secret package");
      }
      const secret = await verifyAndOpenEpochSecretPackage({
        crypto: this.crypto,
        package: item,
        issuerSigningPublicKey: params.issuer.signingPublicKey,
        recipientPrivateKey: params.recipientPrivateKey,
      });
      if (!secret) throw new Error("epoch-secret package signature or open failed");
      opened.set(key, secret);
    }
    return opened;
  }

  async acceptDeviceApproval(
    targetDeviceId: DeviceId,
    targetEncryptionPrivateKey: Uint8Array,
    approval: DeviceApproval,
  ): Promise<void> {
    assertId("target device id", targetDeviceId);
    if (
      !approval ||
      typeof approval !== "object" ||
      !Array.isArray(approval.packages) ||
      approval.packages.length > LATTICE_LIMITS.recoveryPackages ||
      !(approval.signature instanceof Uint8Array) ||
      approval.signature.length !== LATTICE_LIMITS.signatureBytes
    ) {
      throw new Error("device approval shape is invalid");
    }
    const target = await this.storage.getDevice(targetDeviceId);
    if (!target || target.revoked || target.authorized) {
      throw new Error("target device is not pending");
    }
    await this.proveEncryptionPrivateKey(target, targetEncryptionPrivateKey);
    const issuer = await this.storage.getDevice(approval.issuerDeviceId);
    if (
      !issuer ||
      !issuer.authorized ||
      issuer.revoked ||
      issuer.userId !== target.userId ||
      approval.formatVersion !== DEVICE_APPROVAL_FORMAT_VERSION ||
      approval.userId !== target.userId ||
      approval.targetDeviceId !== target.id
    ) {
      throw new Error("device approval metadata is invalid");
    }
    if (
      !this.crypto.verify(
        issuer.signingPublicKey,
        deviceApprovalSigningBytes(approval),
        approval.signature,
      )
    ) {
      throw new Error("device approval signature is invalid");
    }
    const opened = await this.openEpochPackages({
      packages: approval.packages,
      issuer,
      expectedPurpose: "device-transfer",
      expectedUserId: target.userId,
      expectedRecipientId: target.id,
      expectedGeneration: 0,
      recipientPrivateKey: targetEncryptionPrivateKey,
    });

    const namespaces = (await this.storage.listNamespaces())
      .filter((namespace) => namespace.participants.includes(target.userId))
      .sort((left, right) => left.id.localeCompare(right.id));
    const expected = new Set<string>();
    for (const namespace of namespaces) {
      if (!this.group.roster(namespace.id).some(
        (member) => member.deviceId === issuer.id,
      )) {
        throw new Error("approving device is missing from an authorized namespace");
      }
      for (const epoch of this.group.retainedEpochs(namespace.id, issuer.id)) {
        expected.add(`${namespace.id}@${epoch}`);
      }
    }
    if (
      expected.size !== opened.size ||
      [...expected].some((key) => !opened.has(key))
    ) {
      throw new Error("device approval does not contain complete retained history");
    }

    for (const namespace of namespaces) {
      await this.group.addDevices(namespace.id, [{
        deviceId: target.id,
        userId: target.userId,
      }]);
      for (const [key, secret] of opened) {
        const separator = key.lastIndexOf("@");
        if (key.slice(0, separator) !== namespace.id) continue;
        const epoch = Number(key.slice(separator + 1));
        await this.group.importEpochSecret(
          namespace.id,
          epoch,
          target.id,
          secret,
        );
      }
    }
    await this.storage.authorizeDevice(target.id);
    await this.storage.appendAudit({
      at: this.crypto.clock.now(),
      event: "device.approve",
      detail: {
        deviceId: target.id,
        issuerDeviceId: issuer.id,
        packageCount: opened.size,
      },
    });
  }

  async createRecoveryArchive(
    issuerCapability: DeviceCapability,
    kit: RecoveryKit,
    generation: number,
  ): Promise<RecoveryArchive> {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error("recovery generation must be positive");
    }
    await this.validateRecoveryKit(kit);
    const issuer = await this.capabilityDevice(issuerCapability);
    const packages = await this.epochPackages({
      issuer,
      issuerCapability,
      purpose: "recovery",
      recipientId: kit.keyId,
      recipientPublicKey: kit.publicKey,
      generation,
    });
    const base: Omit<RecoveryArchive, "signature"> = {
      formatVersion: RECOVERY_ARCHIVE_FORMAT_VERSION,
      userId: issuer.userId,
      recoveryKeyId: kit.keyId,
      generation,
      issuerDeviceId: issuer.id,
      createdAt: this.crypto.clock.now(),
      packages,
    };
    return {
      ...base,
      signature: this.crypto.sign(
        issuerCapability.signingPrivateKey,
        recoveryArchiveSigningBytes(base),
      ),
    };
  }

  async recoverDevice(
    targetDeviceId: DeviceId,
    targetEncryptionPrivateKey: Uint8Array,
    kit: RecoveryKit,
    archive: RecoveryArchive,
  ): Promise<void> {
    if (
      !archive ||
      typeof archive !== "object" ||
      !Array.isArray(archive.packages) ||
      archive.packages.length > LATTICE_LIMITS.recoveryPackages ||
      !(archive.signature instanceof Uint8Array) ||
      archive.signature.length !== LATTICE_LIMITS.signatureBytes
    ) {
      throw new Error("recovery archive shape is invalid");
    }
    const target = await this.storage.getDevice(targetDeviceId);
    if (!target || target.revoked || target.authorized) {
      throw new Error("target device is not pending");
    }
    await this.proveEncryptionPrivateKey(target, targetEncryptionPrivateKey);
    const recoveryKeyPair = await this.validateRecoveryKit(kit);
    if (!recoveryKitMatchesArchive(kit, archive)) {
      throw new Error("recovery key does not match archive");
    }
    const issuer = await this.storage.getDevice(archive.issuerDeviceId);
    if (
      !issuer ||
      !issuer.authorized ||
      issuer.userId !== target.userId ||
      archive.formatVersion !== RECOVERY_ARCHIVE_FORMAT_VERSION ||
      archive.userId !== target.userId ||
      archive.generation < 1
    ) {
      throw new Error("recovery archive metadata is invalid");
    }
    if (
      !this.crypto.verify(
        issuer.signingPublicKey,
        recoveryArchiveSigningBytes(archive),
        archive.signature,
      )
    ) {
      throw new Error("recovery archive signature is invalid");
    }
    const opened = await this.openEpochPackages({
      packages: archive.packages,
      issuer,
      expectedPurpose: "recovery",
      expectedUserId: target.userId,
      expectedRecipientId: kit.keyId,
      expectedGeneration: archive.generation,
      recipientPrivateKey: recoveryKeyPair.privateKey,
    });

    const namespaces = (await this.storage.listNamespaces())
      .filter((namespace) => namespace.participants.includes(target.userId))
      .sort((left, right) => left.id.localeCompare(right.id));
    const liveSenders = new Map<NamespaceId, DeviceId>();
    for (const namespace of namespaces) {
      const roster = this.group.roster(namespace.id);
      const sender = roster.find((member) =>
        this.group.hasEpochSecret(
          namespace.id,
          namespace.currentEpoch,
          member.deviceId,
        )
      );
      if (roster.length > 0 && !sender) {
        throw new Error(`no live device can deliver ${namespace.id}'s current root`);
      }
      if (sender) liveSenders.set(namespace.id, sender.deviceId);
    }

    for (const namespace of namespaces) {
      await this.group.addDevices(namespace.id, [{
        deviceId: target.id,
        userId: target.userId,
      }]);
      for (const [key, secret] of opened) {
        const separator = key.lastIndexOf("@");
        if (key.slice(0, separator) !== namespace.id) continue;
        const epoch = Number(key.slice(separator + 1));
        await this.group.importEpochSecret(
          namespace.id,
          epoch,
          target.id,
          secret,
        );
      }
      if (
        !opened.has(`${namespace.id}@${namespace.currentEpoch}`) &&
        liveSenders.has(namespace.id)
      ) {
        await this.group.deliverCurrentEpochSecret(
          namespace.id,
          liveSenders.get(namespace.id) as DeviceId,
          target.id,
        );
      }
    }
    await this.storage.authorizeDevice(target.id);
    await this.storage.appendAudit({
      at: this.crypto.clock.now(),
      event: "device.recover",
      detail: {
        deviceId: target.id,
        recoveryKeyId: archive.recoveryKeyId,
        generation: archive.generation,
        packageCount: opened.size,
      },
    });
  }

  private async activeGroupMembers(users: UserId[]): Promise<GroupMember[]> {
    const members: GroupMember[] = [];
    for (const userId of users) {
      for (const device of await this.storage.listDevices(userId)) {
        if (device.authorized && !device.revoked) {
          members.push({ deviceId: device.id, userId });
        }
      }
    }
    return members;
  }

  // ---- Namespaces --------------------------------------------------------

  async findNamespace(participants: UserId[]): Promise<NamespaceRecord | null> {
    assertIdList(
      "namespace participants",
      participants,
      1,
      LATTICE_LIMITS.namespaceParticipants,
    );
    return this.storage.findNamespaceByParticipants(
      canonicalizeParticipants(participants),
    );
  }

  async findOrCreateNamespace(participants: UserId[]): Promise<NamespaceRecord> {
    assertIdList(
      "namespace participants",
      participants,
      1,
      LATTICE_LIMITS.namespaceParticipants,
    );
    const canonical = canonicalizeParticipants(participants);
    const existing = await this.storage.findNamespaceByParticipants(canonical);
    if (existing) return existing;
    for (const u of canonical) await this.storage.putUser(u);
    const ns: NamespaceRecord = {
      id: this.newId("ns"),
      participants: canonical,
      currentEpoch: 0,
      createdAt: this.crypto.clock.now(),
    };
    const members = await this.activeGroupMembers(canonical);
    if (members.length === 0) {
      throw new Error("findOrCreateNamespace requires at least one active participant device");
    }
    await this.storage.putNamespace(ns);
    await this.group.initGroup(ns.id, members);
    return ns;
  }

  async currentEpoch(namespaceId: NamespaceId): Promise<Epoch> {
    assertId("namespace id", namespaceId);
    return (await this.mustNamespace(namespaceId)).currentEpoch;
  }

  /** Add a newly invited participant. The participant-set expansion advances
   * the lattice epoch so the new principal never receives pre-join history. */
  async addParticipants(namespaceId: NamespaceId, users: UserId[]): Promise<void> {
    assertId("namespace id", namespaceId);
    assertIdList(
      "participants to add",
      users,
      1,
      LATTICE_LIMITS.namespaceParticipants,
    );
    const ns = await this.mustNamespace(namespaceId);
    const additions = users.filter((userId) => !ns.participants.includes(userId));
    if (additions.length === 0) return;
    const next = canonicalizeParticipants([...ns.participants, ...additions]);
    if (next.length > LATTICE_LIMITS.namespaceParticipants) {
      throw new RangeError("namespace participant limit exceeded");
    }
    for (const u of additions) await this.storage.putUser(u);
    const newEpoch = await this.group.addDevicesAndRotate(
      namespaceId,
      await this.activeGroupMembers(additions),
    );
    await this.storage.updateNamespace(namespaceId, {
      participants: next,
      currentEpoch: newEpoch,
    });
    await this.storage.appendAudit({
      at: this.crypto.clock.now(),
      event: "epoch.rotate",
      detail: { namespaceId, newEpoch, added: additions },
    });
  }

  /** Remove a participant. Advances the epoch, invalidating covering grants. */
  async removeParticipants(namespaceId: NamespaceId, users: UserId[]): Promise<Epoch> {
    assertId("namespace id", namespaceId);
    assertIdList(
      "participants to remove",
      users,
      1,
      LATTICE_LIMITS.namespaceParticipants,
    );
    const ns = await this.mustNamespace(namespaceId);
    const removeUsers = new Set(users);
    const deviceIds = this.group
      .roster(namespaceId)
      .filter((member) => removeUsers.has(member.userId))
      .map((member) => member.deviceId);
    const newEpoch = await this.group.removeDevices(namespaceId, deviceIds);
    const next = ns.participants.filter((u) => !removeUsers.has(u));
    await this.storage.updateNamespace(namespaceId, {
      participants: next,
      currentEpoch: newEpoch,
    });
    await this.storage.appendAudit({
      at: this.crypto.clock.now(),
      event: "epoch.rotate",
      detail: { namespaceId, newEpoch, removed: users },
    });
    return newEpoch;
  }

  private async mustNamespace(id: NamespaceId): Promise<NamespaceRecord> {
    const ns = await this.storage.getNamespace(id);
    if (!ns) throw new Error(`unknown namespace ${id}`);
    return ns;
  }

  /** DEVICE-side: derive the AI-accessible namespace KEK for an epoch from the
   *  group's exporter secret. Never called in the agent decrypt path. */
  private async capabilityDevice(capability: DeviceCapability): Promise<Device> {
    assertId("device capability id", capability.deviceId);
    assertBytes(
      "device signing private key",
      capability.signingPrivateKey,
      LATTICE_LIMITS.signingPrivateKeyBytes,
      LATTICE_LIMITS.signingPrivateKeyBytes,
    );
    const device = await this.storage.getDevice(capability.deviceId);
    if (!device) throw new Error("device capability references an unknown device");
    if (!device.authorized) throw new Error("device capability is not authorized");
    if (device.revoked) throw new Error("device capability is revoked");
    const challenge = deviceCapabilityChallengeBytes(capability.deviceId);
    const proof = this.crypto.sign(capability.signingPrivateKey, challenge);
    if (!this.crypto.verify(device.signingPublicKey, challenge, proof)) {
      throw new Error("device capability signing key does not match device");
    }
    return device;
  }

  private async deriveNamespaceKey(
    namespaceId: NamespaceId,
    epoch: Epoch,
    capability: DeviceCapability,
  ): Promise<Uint8Array> {
    await this.capabilityDevice(capability);
    const exporter = await this.group.exporterSecret(
      namespaceId,
      epoch,
      EXPORTER_LABEL,
      capability.deviceId,
    );
    return this.crypto.deriveKey(exporter, AI_ACCESSIBLE_LABEL);
  }

  // ---- Objects -----------------------------------------------------------

  /** Own the bytes and metadata used across async scheme calls. */
  private snapshotEncryptedObject(obj: EncryptedObject): EncryptedObject {
    return {
      ...obj,
      wrappedDek: obj.wrappedDek.slice(),
      ciphertext: obj.ciphertext.slice(),
    };
  }

  private objectFormatFailure(obj: EncryptedObject): DenyReason | null {
    if (obj.formatVersion !== ENCRYPTED_OBJECT_FORMAT_VERSION) {
      return "unsupported_object_format";
    }
    return objectPayloadAad({
      formatVersion: obj.formatVersion,
      objectId: obj.id,
      namespaceId: obj.namespaceId,
      epoch: obj.epoch,
      createdAt: obj.createdAt,
    })
      ? null
      : "decrypt_failed";
  }

  async encryptObject(
    namespaceId: NamespaceId,
    plaintext: Uint8Array,
    capability: DeviceCapability,
  ): Promise<EncryptedObject> {
    assertId("namespace id", namespaceId);
    assertPlaintext(plaintext);
    const ns = await this.mustNamespace(namespaceId);
    const epoch = ns.currentEpoch;
    const namespaceKey = await this.deriveNamespaceKey(
      namespaceId,
      epoch,
      capability,
    );
    const formatVersion = ENCRYPTED_OBJECT_FORMAT_VERSION;
    const id = this.newId("obj");
    const createdAt = this.crypto.clock.now();
    const payloadAad = objectPayloadAad({
      formatVersion,
      objectId: id,
      namespaceId,
      epoch,
      createdAt,
    });
    if (!payloadAad) throw new Error("invalid internally generated v1 object metadata");
    const dek = this.crypto.randomBytes(32);
    const ciphertext = this.crypto.aeadSeal(dek, plaintext, payloadAad);
    const wrappedDek = await this.scheme.wrapDek(
      dek,
      { formatVersion, objectId: id, namespaceId, epoch, namespaceKey },
      this.crypto,
    );
    const obj: EncryptedObject = {
      formatVersion,
      id,
      namespaceId,
      epoch,
      wrappedDek,
      ciphertext,
      createdAt,
    };
    await this.storage.putObject(obj);
    return obj;
  }

  /**
   * AGENT-side WRITE. The agent authors a new object into a namespace it can
   * reach, using ONLY the key material inside its grant — never the group
   * exporter secret. This is how agent-authored memories/artifacts get
   * encrypted server-side. Fails closed exactly like `decryptObject`.
   */
  async encryptWithGrant(
    namespaceId: NamespaceId,
    plaintext: Uint8Array,
    grant: Grant,
    session: DelegationSession,
  ): Promise<EncryptResult> {
    if (!idIsValid(namespaceId) || !plaintextIsValid(plaintext)) {
      return { ok: false, reason: "invalid_input" };
    }
    if (grantShapeFailure(grant)) {
      return { ok: false, reason: "invalid_input" };
    }
    // Own the caller-supplied signed value before the first storage await.
    const operationGrant = this.snapshotGrant(grant);
    const ns = await this.storage.getNamespace(namespaceId);
    if (!ns) return { ok: false, reason: "namespace_not_found" };

    const check = await this.checkGrant(grant, session, operationGrant);
    if (!check.ok) return { ok: false, reason: check.reason ?? "grant_open_failed" };
    const validatedGrant = check.grant;
    if (!validatedGrant.operations.includes("encrypt")) {
      return { ok: false, reason: "operation_not_permitted" };
    }

    const coveredEpochs = validatedGrant.coveredEpochs[namespaceId];
    if (coveredEpochs === undefined) return { ok: false, reason: "out_of_scope" };
    if (!coveredEpochs.includes(ns.currentEpoch)) {
      return { ok: false, reason: "epoch_rotated" };
    }

    const access = await this.openAccess(
      grant,
      validatedGrant,
      session,
      check.fingerprint,
    );
    if (!access) return { ok: false, reason: "grant_open_failed" };

    // Possession and request preflight have passed. Claim immediately before
    // execution; any later crypto failure still spends this authorized attempt.
    if (!(await this.claimSingleUse(validatedGrant))) {
      return { ok: false, reason: "grant_consumed" };
    }

    return this.sealObject(
      namespaceId,
      plaintext,
      ns.currentEpoch,
      access,
      validatedGrant.id,
    );
  }

  // ---- Grants ------------------------------------------------------------

  async createDelegationSession(): Promise<DelegationSession> {
    return {
      keyPair: await this.crypto.generateEncryptionKeyPair(),
      verifiedSignatures: new WeakMap<Grant, string>(),
      accessCache: new WeakMap<
        Grant,
        { fingerprint: string; access: SchemeAccess }
      >(),
    };
  }

  /**
   * Open a grant's sealed access map, reusing the session-scoped cache. Only a
   * successful open (which requires this session's private key) is cached, so a
   * foreign session never benefits and never poisons another session's cache.
   */
  private async openAccess(
    cacheKey: Grant,
    validatedGrant: Grant,
    session: DelegationSession,
    fingerprint: string,
  ): Promise<SchemeAccess | null> {
    const cached = session.accessCache.get(cacheKey);
    if (cached?.fingerprint === fingerprint) return cached.access;
    const access = await this.scheme.openGrantSecret(
      validatedGrant.encryptedSecret,
      session.keyPair.privateKey,
      this.crypto,
    );
    if (access) session.accessCache.set(cacheKey, { fingerprint, access });
    return access;
  }

  async mintGrant(params: MintGrantParams): Promise<Grant> {
    if (params.scope.length === 0) {
      throw new Error("grant scope must not be empty");
    }
    assertIdList(
      "grant scope",
      params.scope,
      1,
      LATTICE_LIMITS.grantScope,
    );
    assertGrantTtl(params.ttlMs);
    assertBytes(
      "recipient public key",
      params.recipientPublicKey,
      LATTICE_LIMITS.hpkePublicKeyBytes,
      LATTICE_LIMITS.hpkePublicKeyBytes,
    );
    const historicalEpochs = params.historicalEpochs ?? {};
    assertHistoricalEpochs(historicalEpochs);
    const operations = canonicalOperations(
      params.operations ?? ["decrypt", "encrypt"],
    );
    if (params.singleUse !== undefined && typeof params.singleUse !== "boolean") {
      throw new TypeError("singleUse must be boolean");
    }
    const scope = canonicalizeParticipants(params.scope);
    const issuer = await this.capabilityDevice(params.issuer);
    if (!scope.includes(issuer.userId)) {
      throw new Error("grant scope must include the issuing device owner");
    }
    const covered = await this.storage.findNamespacesContainingSubset(
      scope,
      LATTICE_LIMITS.coveredNamespaces + 1,
    );
    if (covered.length > LATTICE_LIMITS.coveredNamespaces) {
      throw new RangeError("grant exceeds the covered namespace limit");
    }
    covered.sort((left, right) => left.id.localeCompare(right.id));
    const coveredIds = new Set(covered.map((namespace) => namespace.id));
    for (const namespaceId of Object.keys(historicalEpochs)) {
      if (!coveredIds.has(namespaceId)) {
        throw new Error(
          `historical epoch request is outside the grant scope: ${namespaceId}`,
        );
      }
    }
    const coveredKeys: CoveredNamespaceKey[] = [];
    const coveredEpochs: Record<NamespaceId, Epoch[]> = {};
    let totalEpochs = 0;
    for (const ns of covered) {
      if (!this.group.roster(ns.id).some(
        (member) => member.deviceId === issuer.id,
      )) {
        throw new Error(
          `issuing device is not a current member of namespace ${ns.id}`,
        );
      }
      const epochs = [
        ...new Set([
          ...(historicalEpochs[ns.id] ?? []),
          ns.currentEpoch,
        ]),
      ].sort((left, right) => left - right);
      if (epochs.length > LATTICE_LIMITS.epochsPerNamespace) {
        throw new RangeError("historical epochs exceed the per-namespace limit");
      }
      totalEpochs += epochs.length;
      if (totalEpochs > LATTICE_LIMITS.totalGrantEpochs) {
        throw new RangeError("historical epochs exceed the total epoch limit");
      }
      coveredEpochs[ns.id] = epochs;
      for (const epoch of epochs) {
        if (!this.group.hasEpochSecret(ns.id, epoch, issuer.id)) {
          throw new Error(
            `issuing device has no retained secret for ${ns.id}@${epoch}`,
          );
        }
        coveredKeys.push({
          namespaceId: ns.id,
          epoch,
          namespaceKey: await this.deriveNamespaceKey(
            ns.id,
            epoch,
            params.issuer,
          ),
        });
      }
    }

    const encryptedSecret = await this.scheme.deriveGrantSecret(
      { scope, covered: coveredKeys, recipientPublicKey: params.recipientPublicKey },
      this.crypto,
    );
    assertBytes(
      "grant encrypted secret",
      encryptedSecret,
      1,
      LATTICE_LIMITS.grantSecretBytes,
    );

    const now = this.crypto.clock.now();
    assertTimestamp("grant issuedAt", now);
    const expiresAt = now + params.ttlMs;
    assertTimestamp("grant expiresAt", expiresAt);
    const base: Omit<Grant, "signature"> = {
      formatVersion: GRANT_FORMAT_VERSION,
      id: this.newId("grant"),
      issuingDeviceId: issuer.id,
      scope,
      operations,
      issuedAt: now,
      expiresAt,
      coveredEpochs,
      encryptedSecret,
      scheme: this.scheme.id,
      singleUse: params.singleUse ?? false,
      consumed: false,
    };
    const signature = this.crypto.sign(
      params.issuer.signingPrivateKey,
      grantSigningBytes(base),
    );
    const grant: Grant = { ...base, signature };
    const shapeFailure = grantShapeFailure(grant);
    if (shapeFailure) throw new Error(`internally invalid grant: ${shapeFailure}`);
    await this.storage.putGrant(grant);
    await this.storage.appendAudit({
      at: now,
      event: "grant.mint",
      detail: { grantId: grant.id, scope, namespaces: Object.keys(coveredEpochs) },
    });
    return grant;
  }

  /**
   * Take an owned deep snapshot before validation. Grant values cross an async
   * boundary while their sealed access is opened, so later authorization and
   * audit decisions must not read from the caller's mutable object.
   */
  private snapshotGrant(grant: Grant): Grant {
    return {
      ...grant,
      scope: [...grant.scope],
      operations: [...grant.operations],
      coveredEpochs: Object.fromEntries(
        Object.entries(grant.coveredEpochs).map(([namespaceId, epochs]) => [
          namespaceId,
          [...epochs],
        ]),
      ),
      encryptedSecret: grant.encryptedSecret.slice(),
      signature: grant.signature.slice(),
    };
  }

  /**
   * Session-cache identity for one exact signed grant value under one issuer
   * key. Hash each variable-length component first, then hash the fixed-width
   * tuple under an explicit domain tag to avoid ambiguous concatenations.
   */
  private grantCacheFingerprint(
    signingBytes: Uint8Array,
    signature: Uint8Array,
    issuerSigningPublicKey: Uint8Array,
  ): string {
    return grantCacheFingerprint(
      this.crypto,
      signingBytes,
      signature,
      issuerSigningPublicKey,
    );
  }

  /** Validate a grant independent of any specific object. Always performs the
   *  full check (no memoization). */
  async verifyGrant(grant: Grant): Promise<GrantCheck> {
    if (grantShapeFailure(grant)) {
      return { ok: false, reason: "invalid_input" };
    }
    const check = await this.checkGrant(grant, null);
    return check.ok ? { ok: true } : check;
  }

  /**
   * Core grant validation. The DYNAMIC gates — issuing device existence +
   * revocation, expiry, and single-use consumption — are ALWAYS re-evaluated.
   * Only the signature check (a pure function of the grant's immutable bytes) is
   * memoized, and only when a `session` is supplied. Object identity locates a
   * weak entry, but a hit is accepted only when its recomputed fingerprint still
   * matches the exact signed bytes, signature, and issuer key.
   */
  private async checkGrant(
    grant: Grant,
    session: DelegationSession | null,
    operationGrant?: Grant,
  ): Promise<InternalGrantCheck> {
    if (grantShapeFailure(grant)) {
      return { ok: false, reason: "invalid_input" };
    }
    const validatedGrant = operationGrant ?? this.snapshotGrant(grant);
    const device = await this.storage.getDevice(validatedGrant.issuingDeviceId);
    if (!device) return { ok: false, reason: "grant_invalid_signature" };
    if (device.revoked) return { ok: false, reason: "grant_device_revoked" };

    const signingBytes = grantSigningBytes(validatedGrant);
    const fingerprint = this.grantCacheFingerprint(
      signingBytes,
      validatedGrant.signature,
      device.signingPublicKey,
    );
    if (session?.verifiedSignatures.get(grant) !== fingerprint) {
      const sigOk = this.crypto.verify(
        device.signingPublicKey,
        signingBytes,
        validatedGrant.signature,
      );
      if (!sigOk) return { ok: false, reason: "grant_invalid_signature" };
      session?.verifiedSignatures.set(grant, fingerprint);
    }
    if (validatedGrant.scheme !== this.scheme.id) {
      return { ok: false, reason: "invalid_input" };
    }

    if (this.crypto.clock.now() > validatedGrant.expiresAt) {
      return { ok: false, reason: "grant_expired" };
    }
    // Single-use: consult STORAGE, never the caller-supplied `consumed` flag
    // (a cached copy with consumed:false must not re-validate). Missing stored
    // row also fails closed.
    if (validatedGrant.singleUse) {
      const stored = await this.storage.getGrant(validatedGrant.id);
      if (!stored || stored.consumed) return { ok: false, reason: "grant_consumed" };
    }
    return { ok: true, fingerprint, grant: validatedGrant };
  }

  /**
   * Atomic authorization gate for single-use grants: marks the stored grant
   * consumed and returns true the FIRST time, false on every subsequent call
   * (and under concurrency — `storage.consumeGrant` is atomic). No-op for
   * reusable grants.
   */
  private async claimSingleUse(grant: Grant): Promise<boolean> {
    if (!grant.singleUse) return true;
    return (await this.storage.consumeGrant(grant.id)) !== null;
  }

  /**
   * AGENT-side decryption. Touches only the grant + the delegation session's
   * private key — never the group provider. Fails closed with a grep-able
   * reason on any access-control miss.
   */
  async decryptObject(
    objectId: ObjectId,
    grant: Grant,
    session: DelegationSession,
  ): Promise<DecryptResult> {
    if (!idIsValid(objectId) || grantShapeFailure(grant)) {
      return { ok: false, reason: "invalid_input" };
    }
    // Own the caller-supplied signed value before the first storage await.
    const operationGrant = this.snapshotGrant(grant);
    const storedObject = await this.storage.getObject(objectId);
    if (!storedObject) return { ok: false, reason: "object_not_found" };
    if (storedObject.formatVersion !== ENCRYPTED_OBJECT_FORMAT_VERSION) {
      return { ok: false, reason: "unsupported_object_format" };
    }
    if (objectShapeFailure(storedObject)) {
      return { ok: false, reason: "invalid_input" };
    }
    const obj = this.snapshotEncryptedObject(storedObject);
    const ns = await this.storage.getNamespace(obj.namespaceId);
    if (!ns) return { ok: false, reason: "namespace_not_found" };

    const check = await this.checkGrant(grant, session, operationGrant);
    if (!check.ok) return { ok: false, reason: check.reason ?? "grant_open_failed" };
    const validatedGrant = check.grant;
    if (!validatedGrant.operations.includes("decrypt")) {
      return { ok: false, reason: "operation_not_permitted" };
    }

    const coveredEpochs = validatedGrant.coveredEpochs[obj.namespaceId];
    if (coveredEpochs === undefined) return { ok: false, reason: "out_of_scope" };
    // Epoch rotation on this namespace invalidates the grant for it.
    if (!coveredEpochs.includes(ns.currentEpoch)) {
      return { ok: false, reason: "epoch_rotated" };
    }
    if (!coveredEpochs.includes(obj.epoch)) {
      return { ok: false, reason: "epoch_mismatch" };
    }
    const formatFailure = this.objectFormatFailure(obj);
    if (formatFailure) return { ok: false, reason: formatFailure };

    const access = await this.openAccess(
      grant,
      validatedGrant,
      session,
      check.fingerprint,
    );
    if (!access) return { ok: false, reason: "grant_open_failed" };

    // Possession and request preflight have passed. Claim immediately before
    // execution; any later crypto failure still spends this authorized attempt.
    if (!(await this.claimSingleUse(validatedGrant))) {
      return { ok: false, reason: "grant_consumed" };
    }

    return this.openObject(obj, access);
  }

  /**
   * Pure per-object crypto tail shared by the single- and batch-read paths.
   * Assumes ALL grant + epoch gates have already passed and the grant secret is
   * already open. Touches only the scheme + AEAD — never the group provider.
   */
  private async openObject(obj: EncryptedObject, access: SchemeAccess): Promise<DecryptResult> {
    const formatFailure = this.objectFormatFailure(obj);
    if (formatFailure) return { ok: false, reason: formatFailure };
    const payloadAad = objectPayloadAad({
      formatVersion: obj.formatVersion,
      objectId: obj.id,
      namespaceId: obj.namespaceId,
      epoch: obj.epoch,
      createdAt: obj.createdAt,
    });
    if (!payloadAad) return { ok: false, reason: "decrypt_failed" };
    const dek = await this.scheme.unwrapDek(
      obj.wrappedDek,
      {
        formatVersion: obj.formatVersion,
        objectId: obj.id,
        namespaceId: obj.namespaceId,
        epoch: obj.epoch,
      },
      access,
      this.crypto,
    );
    if (!dek) return { ok: false, reason: "unwrap_failed" };
    const plaintext = this.crypto.aeadOpen(dek, obj.ciphertext, payloadAad);
    if (!plaintext) return { ok: false, reason: "decrypt_failed" };
    return { ok: true, plaintext };
  }

  /**
   * Pure per-object write tail shared by the single- and batch-write paths.
   * Assumes ALL grant + epoch gates have already passed and the grant secret is
   * already open. Wraps a fresh DEK under the recovered access at `epoch`.
   */
  private async sealObject(
    namespaceId: NamespaceId,
    plaintext: Uint8Array,
    epoch: Epoch,
    access: SchemeAccess,
    grantId: GrantId,
  ): Promise<EncryptResult> {
    const formatVersion = ENCRYPTED_OBJECT_FORMAT_VERSION;
    const id = this.newId("obj");
    const createdAt = this.crypto.clock.now();
    const payloadAad = objectPayloadAad({
      formatVersion,
      objectId: id,
      namespaceId,
      epoch,
      createdAt,
    });
    if (!payloadAad) return { ok: false, reason: "wrap_failed" };
    const dek = this.crypto.randomBytes(32);
    const ciphertext = this.crypto.aeadSeal(dek, plaintext, payloadAad);
    const wrappedDek = await this.scheme.wrapDekWithAccess(
      dek,
      { formatVersion, objectId: id, namespaceId, epoch },
      access,
      this.crypto,
    );
    if (!wrappedDek) return { ok: false, reason: "wrap_failed" };
    const obj: EncryptedObject = {
      formatVersion,
      id,
      namespaceId,
      epoch,
      wrappedDek,
      ciphertext,
      createdAt,
    };
    await this.storage.putObject(obj);
    await this.storage.appendAudit({
      at: this.crypto.clock.now(),
      event: "object.encrypt_with_grant",
      detail: { objectId: obj.id, namespaceId, grantId },
    });
    return { ok: true, object: obj };
  }

  /**
   * Batch READ — the production access pattern. Verifies + opens the grant
   * ONCE (reusing the session cache) and bulk-fetches the requested objects in a
   * SINGLE storage round-trip, then decrypts each in memory. Results are aligned
   * 1:1 with `objectIds` (element i is the outcome for objectIds[i]).
   *
   * Grant-level failures (bad signature, expiry, device revocation, wrong
   * operation, foreign session, already-consumed single-use) fail the WHOLE
   * batch: every element carries that reason. Per-object gates (not-found,
   * out-of-scope, epoch) are evaluated element by element.
   *
   * Single-use semantics: the batch is ONE delegated operation. Empty or fully
   * ineligible batches do not consume; a batch with at least one eligible item
   * is claimed once after possession proof and preflight. A subsequent batch
   * (or single read) with the same grant is `grant_consumed`.
   */
  async decryptMany(
    objectIds: ObjectId[],
    grant: Grant,
    session: DelegationSession,
  ): Promise<DecryptResult[]> {
    assertBatchSize("decrypt", objectIds.length);
    if (objectIds.length === 0) return [];

    const failAll = (reason: DenyReason): DecryptResult[] =>
      objectIds.map(() => ({ ok: false, reason }));
    if (
      objectIds.some((objectId) => !idIsValid(objectId)) ||
      grantShapeFailure(grant)
    ) {
      return failAll("invalid_input");
    }
    const operationGrant = this.snapshotGrant(grant);

    const check = await this.checkGrant(grant, session, operationGrant);
    if (!check.ok) return failAll(check.reason ?? "grant_open_failed");
    const validatedGrant = check.grant;
    if (!validatedGrant.operations.includes("decrypt")) {
      return failAll("operation_not_permitted");
    }

    const found = new Map<ObjectId, EncryptedObject>();
    for (const storedObject of await this.storage.getObjects(objectIds)) {
      if (storedObject.formatVersion !== ENCRYPTED_OBJECT_FORMAT_VERSION) {
        found.set(storedObject.id, storedObject);
        continue;
      }
      if (objectShapeFailure(storedObject)) {
        found.set(storedObject.id, storedObject);
        continue;
      }
      const obj = this.snapshotEncryptedObject(storedObject);
      found.set(obj.id, obj);
    }
    const nsCache = new Map<
      NamespaceId,
      Promise<NamespaceRecord | null>
    >();
    const namespaceOf = (id: NamespaceId): Promise<NamespaceRecord | null> => {
      const hit = nsCache.get(id);
      if (hit !== undefined) return hit;
      const ns = this.storage.getNamespace(id);
      nsCache.set(id, ns);
      return ns;
    };

    const plan: DecryptPlan[] = [];
    for (const id of objectIds) {
      const obj = found.get(id);
      if (!obj) {
        plan.push({
          eligible: false,
          result: { ok: false, reason: "object_not_found" },
        });
        continue;
      }
      if (obj.formatVersion !== ENCRYPTED_OBJECT_FORMAT_VERSION) {
        plan.push({
          eligible: false,
          result: { ok: false, reason: "unsupported_object_format" },
        });
        continue;
      }
      if (
        objectShapeFailure(obj)
      ) {
        plan.push({
          eligible: false,
          result: { ok: false, reason: "invalid_input" },
        });
        continue;
      }
      const ns = await namespaceOf(obj.namespaceId);
      if (!ns) {
        plan.push({
          eligible: false,
          result: { ok: false, reason: "namespace_not_found" },
        });
        continue;
      }
      const coveredEpochs = validatedGrant.coveredEpochs[obj.namespaceId];
      if (coveredEpochs === undefined) {
        plan.push({
          eligible: false,
          result: { ok: false, reason: "out_of_scope" },
        });
        continue;
      }
      if (!coveredEpochs.includes(ns.currentEpoch)) {
        plan.push({
          eligible: false,
          result: { ok: false, reason: "epoch_rotated" },
        });
        continue;
      }
      if (!coveredEpochs.includes(obj.epoch)) {
        plan.push({
          eligible: false,
          result: { ok: false, reason: "epoch_mismatch" },
        });
        continue;
      }
      const formatFailure = this.objectFormatFailure(obj);
      if (formatFailure) {
        plan.push({
          eligible: false,
          result: { ok: false, reason: formatFailure },
        });
        continue;
      }
      plan.push({ eligible: true, object: obj });
    }

    const access = await this.openAccess(
      grant,
      validatedGrant,
      session,
      check.fingerprint,
    );
    if (!access) return failAll("grant_open_failed");

    if (!plan.some((item) => item.eligible)) {
      const results: DecryptResult[] = [];
      for (const item of plan) {
        if (!item.eligible) results.push(item.result);
      }
      return results;
    }

    if (!(await this.claimSingleUse(validatedGrant))) {
      return failAll("grant_consumed");
    }

    const results: DecryptResult[] = [];
    for (const item of plan) {
      results.push(
        item.eligible ? await this.openObject(item.object, access) : item.result,
      );
    }
    return results;
  }

  /**
   * Batch WRITE — the agent authors many objects under one grant. Verifies +
   * opens the grant ONCE (session cache) and seals each item in memory. Results
   * are aligned 1:1 with `items`. Grant-level failures fail the whole batch;
   * per-item gates (unknown namespace, out-of-scope, epoch) are per element.
   * Single-use follows the possession/preflight policy in `decryptMany`.
   */
  async encryptMany(
    items: EncryptManyItem[],
    grant: Grant,
    session: DelegationSession,
  ): Promise<EncryptResult[]> {
    assertBatchSize("encrypt", items.length);
    if (items.length === 0) return [];

    const failAll = (reason: DenyReason): EncryptResult[] =>
      items.map(() => ({ ok: false, reason }));
    if (grantShapeFailure(grant)) return failAll("invalid_input");
    const operationGrant = this.snapshotGrant(grant);

    const check = await this.checkGrant(grant, session, operationGrant);
    if (!check.ok) return failAll(check.reason ?? "grant_open_failed");
    const validatedGrant = check.grant;
    if (!validatedGrant.operations.includes("encrypt")) {
      return failAll("operation_not_permitted");
    }

    const nsCache = new Map<
      NamespaceId,
      Promise<NamespaceRecord | null>
    >();
    const namespaceOf = (id: NamespaceId): Promise<NamespaceRecord | null> => {
      const hit = nsCache.get(id);
      if (hit !== undefined) return hit;
      const ns = this.storage.getNamespace(id);
      nsCache.set(id, ns);
      return ns;
    };

    const plan: EncryptPlan[] = [];
    for (const item of items) {
      if (
        !idIsValid(item.namespaceId) ||
        !plaintextIsValid(item.plaintext)
      ) {
        plan.push({
          eligible: false,
          result: { ok: false, reason: "invalid_input" },
        });
        continue;
      }
      const ns = await namespaceOf(item.namespaceId);
      if (!ns) {
        plan.push({
          eligible: false,
          result: { ok: false, reason: "namespace_not_found" },
        });
        continue;
      }
      const coveredEpochs = validatedGrant.coveredEpochs[item.namespaceId];
      if (coveredEpochs === undefined) {
        plan.push({
          eligible: false,
          result: { ok: false, reason: "out_of_scope" },
        });
        continue;
      }
      if (!coveredEpochs.includes(ns.currentEpoch)) {
        plan.push({
          eligible: false,
          result: { ok: false, reason: "epoch_rotated" },
        });
        continue;
      }
      plan.push({ eligible: true, item, epoch: ns.currentEpoch });
    }

    const access = await this.openAccess(
      grant,
      validatedGrant,
      session,
      check.fingerprint,
    );
    if (!access) return failAll("grant_open_failed");

    if (!plan.some((item) => item.eligible)) {
      const results: EncryptResult[] = [];
      for (const item of plan) {
        if (!item.eligible) results.push(item.result);
      }
      return results;
    }

    if (!(await this.claimSingleUse(validatedGrant))) {
      return failAll("grant_consumed");
    }

    const results: EncryptResult[] = [];
    for (const item of plan) {
      results.push(
        item.eligible
          ? await this.sealObject(
              item.item.namespaceId,
              item.item.plaintext,
              item.epoch,
              access,
              validatedGrant.id,
            )
          : item.result,
      );
    }
    return results;
  }

  async consumeGrant(grantId: GrantId): Promise<Grant | null> {
    assertId("grant id", grantId);
    return this.storage.consumeGrant(grantId);
  }

  // ---- Queries -----------------------------------------------------------

  async canAccess(scope: UserId[], namespaceId: NamespaceId): Promise<boolean> {
    assertIdList("scope", scope, 1, LATTICE_LIMITS.grantScope);
    assertId("namespace id", namespaceId);
    const ns = await this.storage.getNamespace(namespaceId);
    if (!ns) return false;
    return isSubset(canonicalizeParticipants(scope), ns.participants);
  }

  async namespaceExists(namespaceId: NamespaceId): Promise<boolean> {
    assertId("namespace id", namespaceId);
    return (await this.storage.getNamespace(namespaceId)) !== null;
  }

  async objectExists(objectId: ObjectId): Promise<boolean> {
    assertId("object id", objectId);
    return (await this.storage.getObject(objectId)) !== null;
  }

  async grantValid(grant: Grant): Promise<boolean> {
    return (await this.verifyGrant(grant)).ok;
  }
}
