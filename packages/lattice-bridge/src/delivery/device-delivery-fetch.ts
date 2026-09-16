import {
  cryptoDeviceId,
  humanId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";

export const DEVICE_DELIVERY_FETCH_FORMAT_VERSION = 1 as const;
export const DEVICE_DELIVERY_FETCH_MAX_MESSAGES = 4_096;
export const DEVICE_DELIVERY_FETCH_MIN_PAYLOAD_BYTES = 1_048_616;
export const DEVICE_DELIVERY_FETCH_MAX_PAYLOAD_BYTES = 64 * 1_048_576;
export const DEVICE_DELIVERY_FETCH_PROOF_TTL_MS = 300_000;

export interface DeviceDeliveryFetchProof {
  readonly formatVersion: typeof DEVICE_DELIVERY_FETCH_FORMAT_VERSION;
  readonly requestId: string;
  readonly humanId: string;
  readonly deviceId: string;
  readonly expectedDeviceRevision: number;
  readonly minimumHighWatermark: number;
  readonly maximumMessages: number;
  readonly maximumPayloadBytes: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly signature: Uint8Array;
}

function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("Device delivery fetch counter is invalid");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Device delivery fetch counter is unsafe");
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function frame(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + bytes.length);
  output.set(u32(bytes.length));
  output.set(bytes, 4);
  return output;
}

function text(value: string): Uint8Array {
  return frame(new TextEncoder().encode(value));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function portable(label: string, value: string): void {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  ) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
}

export function assertDeviceDeliveryFetchProof(
  proof: DeviceDeliveryFetchProof,
): void {
  if (
    typeof proof !== "object"
    || proof === null
    || proof.formatVersion !== DEVICE_DELIVERY_FETCH_FORMAT_VERSION
  ) {
    throw new TypeError("Device delivery fetch proof is malformed");
  }
  portable("Device delivery request id", proof.requestId);
  humanId(proof.humanId);
  cryptoDeviceId(proof.deviceId);
  for (const value of [
    proof.expectedDeviceRevision,
    proof.minimumHighWatermark,
    proof.maximumMessages,
    proof.maximumPayloadBytes,
    proof.issuedAt,
    proof.expiresAt,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Device delivery fetch counter is unsafe");
    }
  }
  if (
    proof.maximumMessages < 1
    || proof.maximumMessages > DEVICE_DELIVERY_FETCH_MAX_MESSAGES
    || proof.maximumPayloadBytes < DEVICE_DELIVERY_FETCH_MIN_PAYLOAD_BYTES
    || proof.maximumPayloadBytes > DEVICE_DELIVERY_FETCH_MAX_PAYLOAD_BYTES
    || proof.expiresAt <= proof.issuedAt
    || proof.expiresAt - proof.issuedAt > DEVICE_DELIVERY_FETCH_PROOF_TTL_MS
    || !(proof.signature instanceof Uint8Array)
    || proof.signature.length !== 64
  ) {
    throw new RangeError("Device delivery fetch bounds are invalid");
  }
}

export function deviceDeliveryFetchSigningBytes(
  proof: Omit<DeviceDeliveryFetchProof, "signature">,
): Uint8Array {
  return concat([
    text("nautilo/lattice-bridge/device-delivery-fetch/v1"),
    u32(proof.formatVersion),
    text(proof.requestId),
    text(proof.humanId),
    text(proof.deviceId),
    u64(proof.expectedDeviceRevision),
    u64(proof.minimumHighWatermark),
    u32(proof.maximumMessages),
    u64(proof.maximumPayloadBytes),
    u64(proof.issuedAt),
    u64(proof.expiresAt),
  ]);
}

export function createDeviceDeliveryFetchProof(input: {
  readonly crypto: LatticeCrypto;
  readonly requestId: string;
  readonly humanId: string;
  readonly deviceId: string;
  readonly expectedDeviceRevision: number;
  readonly minimumHighWatermark: number;
  readonly maximumMessages: number;
  readonly maximumPayloadBytes: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly signingPrivateKey: Uint8Array;
}): DeviceDeliveryFetchProof {
  const unsigned = Object.freeze({
    formatVersion: DEVICE_DELIVERY_FETCH_FORMAT_VERSION,
    requestId: input.requestId,
    humanId: input.humanId,
    deviceId: input.deviceId,
    expectedDeviceRevision: input.expectedDeviceRevision,
    minimumHighWatermark: input.minimumHighWatermark,
    maximumMessages: input.maximumMessages,
    maximumPayloadBytes: input.maximumPayloadBytes,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  });
  const candidate = Object.freeze({
    ...unsigned,
    signature: input.crypto.sign(
      input.signingPrivateKey,
      deviceDeliveryFetchSigningBytes(unsigned),
    ),
  });
  assertDeviceDeliveryFetchProof(candidate);
  return candidate;
}
