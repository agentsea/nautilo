import type { LatticeCrypto } from "../crypto/index.ts";
import { LATTICE_LIMITS } from "../limits.ts";
import type { DeviceId, NamespaceId } from "../types/index.ts";
import { concat, utf8 } from "../util/bytes.ts";
import { assertBytes, assertId, assertTimestamp } from "../validation.ts";

export const DEVICE_STATE_FORMAT_VERSION = 1 as const;
const DEVICE_STATE_DOMAIN = utf8(
  "nautilo/lattice-crypto/device-state-vault/v1",
);

export interface DeviceStateSnapshot {
  formatVersion: 1;
  deviceId: DeviceId;
  namespaceId: NamespaceId;
  revision: number;
  ciphertext: Uint8Array;
}

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

function frame(bytes: Uint8Array): Uint8Array {
  return concat(u32(bytes.length), bytes);
}

function aad(
  deviceId: DeviceId,
  namespaceId: NamespaceId,
  revision: number,
): Uint8Array {
  return concat(
    frame(DEVICE_STATE_DOMAIN),
    u32(DEVICE_STATE_FORMAT_VERSION),
    frame(utf8(deviceId)),
    frame(utf8(namespaceId)),
    u64(revision),
  );
}

export class DeviceStateVault {
  private constructor(
    private readonly crypto: LatticeCrypto,
    readonly deviceId: DeviceId,
    private readonly localKey: Uint8Array,
  ) {}

  static create(crypto: LatticeCrypto, deviceId: DeviceId): DeviceStateVault {
    return DeviceStateVault.fromKey(crypto, deviceId, crypto.randomBytes(32));
  }

  static fromKey(
    crypto: LatticeCrypto,
    deviceId: DeviceId,
    localKey: Uint8Array,
  ): DeviceStateVault {
    assertId("device vault device id", deviceId);
    assertBytes("device vault local key", localKey, 32, 32);
    return new DeviceStateVault(crypto, deviceId, localKey.slice());
  }

  /** Test/host integration hook. The returned key remains device-local and is
   * intended for an OS secure store, never the public relay or application DB. */
  exportLocalKey(): Uint8Array {
    return this.localKey.slice();
  }

  seal(
    namespaceId: NamespaceId,
    revision: number,
    state: Uint8Array,
  ): DeviceStateSnapshot {
    assertId("device state namespace id", namespaceId);
    assertTimestamp("device state revision", revision);
    assertBytes("device state", state, 1, LATTICE_LIMITS.deviceStateBytes);
    return {
      formatVersion: DEVICE_STATE_FORMAT_VERSION,
      deviceId: this.deviceId,
      namespaceId,
      revision,
      ciphertext: this.crypto.aeadSeal(
        this.localKey,
        state,
        aad(this.deviceId, namespaceId, revision),
      ),
    };
  }

  open(snapshot: DeviceStateSnapshot, minimumRevision: number): Uint8Array | null {
    if (
      snapshot.formatVersion !== DEVICE_STATE_FORMAT_VERSION ||
      snapshot.deviceId !== this.deviceId ||
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < minimumRevision ||
      !(snapshot.ciphertext instanceof Uint8Array) ||
      snapshot.ciphertext.length > LATTICE_LIMITS.deviceStateBytes + 40
    ) {
      return null;
    }
    try {
      assertId("device state namespace id", snapshot.namespaceId);
      assertTimestamp("minimum device state revision", minimumRevision);
    } catch {
      return null;
    }
    return this.crypto.aeadOpen(
      this.localKey,
      snapshot.ciphertext,
      aad(snapshot.deviceId, snapshot.namespaceId, snapshot.revision),
    );
  }
}
