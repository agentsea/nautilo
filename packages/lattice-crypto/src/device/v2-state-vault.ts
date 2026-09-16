import type { LatticeCrypto } from "../crypto/index.ts";
import {
  concatV2,
  encodeU32,
  encodeU64,
  frameText,
} from "../format/v2-primitives.ts";
import {
  type CryptoDeviceId,
  type CryptoDomainId,
  type DomainEpoch,
  assertPortableId,
  assertU64Counter,
  cryptoDeviceId,
} from "../v2-types/ids.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const V2_PROVIDER_STATE_FORMAT_VERSION = 2 as const;
export const V2_PROVIDER_STATE_MAX_BYTES = 1024 * 1024;

const PROVIDER_STATE_VAULT_DOMAIN =
  "nautilo/lattice-crypto/device-provider-state-vault/v2";
const PROVIDER_STATE_KEY_BYTES = 32;
const AEAD_OVERHEAD_BYTES = 40;

export type ProviderSnapshotKindV2 = "active" | "candidate";

declare const sealedProviderStateBrand: unique symbol;

/**
 * A device-local, AEAD-sealed provider state. This type is deliberately not
 * one of the server-storage opaque byte kinds: exporter-capable provider state
 * must never be accepted by that boundary, even while encrypted.
 */
export type SealedProviderStateV2 = Readonly<{
  readonly classification: "device-local-provider-ciphertext";
  readonly formatVersion: 2;
  readonly providerId: string;
  readonly domainId: CryptoDomainId;
  readonly deviceId: CryptoDeviceId;
  readonly revision: DomainEpoch;
  readonly snapshotKind: ProviderSnapshotKindV2;
  readonly ciphertext: Uint8Array;
  readonly [sealedProviderStateBrand]: true;
}>;

export interface ProviderSnapshotCoordinatesV2 {
  readonly providerId: string;
  readonly domainId: CryptoDomainId;
  readonly revision: DomainEpoch;
  readonly snapshotKind: ProviderSnapshotKindV2;
}

function providerStateAad(
  deviceId: CryptoDeviceId,
  coordinates: ProviderSnapshotCoordinatesV2,
): Uint8Array {
  return concatV2(
    frameText(PROVIDER_STATE_VAULT_DOMAIN),
    encodeU32(V2_PROVIDER_STATE_FORMAT_VERSION),
    frameText(coordinates.providerId),
    frameText(coordinates.domainId),
    frameText(deviceId),
    encodeU64(coordinates.revision),
    frameText(coordinates.snapshotKind),
  );
}

function validateCoordinates(
  coordinates: ProviderSnapshotCoordinatesV2,
): void {
  assertPortableId("Provider id", coordinates.providerId);
  assertPortableId("Crypto Domain id", coordinates.domainId);
  assertU64Counter("Provider state revision", coordinates.revision);
  if (
    coordinates.snapshotKind !== "active"
    && coordinates.snapshotKind !== "candidate"
  ) {
    throw new RangeError("Provider snapshot kind is unsupported");
  }
}

function sealedSnapshot(
  deviceId: CryptoDeviceId,
  coordinates: ProviderSnapshotCoordinatesV2,
  ciphertext: Uint8Array,
): SealedProviderStateV2 {
  return Object.freeze({
    classification: "device-local-provider-ciphertext" as const,
    formatVersion: V2_PROVIDER_STATE_FORMAT_VERSION,
    providerId: coordinates.providerId,
    domainId: coordinates.domainId,
    deviceId,
    revision: coordinates.revision,
    snapshotKind: coordinates.snapshotKind,
    ciphertext: copyOwnedBytesV2(ciphertext),
  }) as SealedProviderStateV2;
}

/**
 * Reconstruct a device-local provider snapshot after its containing secure
 * client profile has been opened. This deliberately does not serialize the
 * snapshot or make it server-storable; it only validates and detaches the
 * already sealed ciphertext so a fresh process can give it back to the
 * device-local vault.
 */
export function restoreSealedProviderStateV2(input: Readonly<{
  readonly providerId: string;
  readonly domainId: CryptoDomainId;
  readonly deviceId: CryptoDeviceId;
  readonly revision: DomainEpoch;
  readonly snapshotKind: ProviderSnapshotKindV2;
  readonly ciphertext: Uint8Array;
}>): SealedProviderStateV2 {
  const deviceId = cryptoDeviceId(input.deviceId);
  const coordinates = Object.freeze({
    providerId: input.providerId,
    domainId: input.domainId,
    revision: input.revision,
    snapshotKind: input.snapshotKind,
  });
  validateCoordinates(coordinates);
  if (
    !(input.ciphertext instanceof Uint8Array)
    || input.ciphertext.length < 1
    || input.ciphertext.length > V2_PROVIDER_STATE_MAX_BYTES + AEAD_OVERHEAD_BYTES
  ) {
    throw new RangeError("Sealed provider state ciphertext is invalid");
  }
  return sealedSnapshot(deviceId, coordinates, input.ciphertext);
}

/**
 * Minimal injected device-local sealing seam. The host owns key custody (for
 * example, an OS secure store); this class neither persists nor exports it.
 */
export class DeviceProviderStateVaultV2 {
  private destroyed = false;

  private constructor(
    private readonly crypto: LatticeCrypto,
    readonly deviceId: CryptoDeviceId,
    private readonly localKey: Uint8Array,
  ) {}

  static fromKey(
    crypto: LatticeCrypto,
    deviceId: CryptoDeviceId,
    localKey: Uint8Array,
  ): DeviceProviderStateVaultV2 {
    const validatedDeviceId = cryptoDeviceId(deviceId);
    if (
      !(localKey instanceof Uint8Array)
      || localKey.length !== PROVIDER_STATE_KEY_BYTES
    ) {
      throw new RangeError(
        `Provider state vault key must be ${PROVIDER_STATE_KEY_BYTES} bytes`,
      );
    }
    return new DeviceProviderStateVaultV2(
      crypto,
      validatedDeviceId,
      copyOwnedBytesV2(localKey),
    );
  }

  /**
   * End this device-local custody lifetime. Destruction is idempotent; after
   * it, sealing throws and opening returns null without invoking crypto.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.localKey.fill(0);
    this.destroyed = true;
  }

  seal(
    coordinates: ProviderSnapshotCoordinatesV2,
    plaintext: Uint8Array,
  ): SealedProviderStateV2 {
    if (this.destroyed) {
      throw new Error("Provider state vault is destroyed");
    }
    validateCoordinates(coordinates);
    if (
      !(plaintext instanceof Uint8Array)
      || plaintext.length < 1
      || plaintext.length > V2_PROVIDER_STATE_MAX_BYTES
    ) {
      throw new RangeError(
        `Provider state must be 1-${V2_PROVIDER_STATE_MAX_BYTES} bytes`,
      );
    }
    return sealedSnapshot(
      this.deviceId,
      coordinates,
      this.crypto.aeadSeal(
        this.localKey,
        plaintext,
        providerStateAad(this.deviceId, coordinates),
      ),
    );
  }

  open(
    snapshot: SealedProviderStateV2,
    expected: ProviderSnapshotCoordinatesV2,
  ): Uint8Array | null {
    if (this.destroyed) return null;
    try {
      validateCoordinates(expected);
      if (
        snapshot.classification !== "device-local-provider-ciphertext"
        || snapshot.formatVersion !== V2_PROVIDER_STATE_FORMAT_VERSION
        || snapshot.deviceId !== this.deviceId
        || snapshot.providerId !== expected.providerId
        || snapshot.domainId !== expected.domainId
        || snapshot.revision !== expected.revision
        || snapshot.snapshotKind !== expected.snapshotKind
        || !(snapshot.ciphertext instanceof Uint8Array)
        || snapshot.ciphertext.length
          > V2_PROVIDER_STATE_MAX_BYTES + AEAD_OVERHEAD_BYTES
      ) {
        return null;
      }
      const plaintext = this.crypto.aeadOpen(
        this.localKey,
        snapshot.ciphertext,
        providerStateAad(this.deviceId, expected),
      );
      if (plaintext === null) return null;
      try {
        return copyOwnedBytesV2(plaintext);
      } finally {
        plaintext.fill(0);
      }
    } catch {
      return null;
    }
  }
}
