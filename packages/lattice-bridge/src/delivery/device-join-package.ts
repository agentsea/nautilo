import {
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";

export const DEVICE_JOIN_PACKAGE_FORMAT_VERSION = 1 as const;
export const DEVICE_JOIN_PACKAGE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEVICE_JOIN_PACKAGE_MAX_BYTES = 1_048_616;

export interface DeviceJoinRequestPublic {
  readonly formatVersion: 2;
  readonly providerId: string;
  readonly domainId: string;
  readonly humanId: string;
  readonly deviceId: string;
  readonly expectedHead: {
    readonly providerId: string;
    readonly domainId: string;
    readonly epoch: number;
    readonly stateHash: Uint8Array;
  };
  readonly keyPackageBytes: Uint8Array;
}

export interface DeviceJoinPackageEnvelope {
  readonly formatVersion: typeof DEVICE_JOIN_PACKAGE_FORMAT_VERSION;
  readonly providerId: string;
  readonly domainId: string;
  readonly humanId: string;
  readonly deviceId: string;
  readonly expectedEpoch: number;
  readonly expectedProviderHeadHash: Uint8Array;
  readonly generation: number;
  readonly packageId: string;
  readonly keyPackageBytes: Uint8Array;
  readonly packageHash: Uint8Array;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly signature: Uint8Array;
}

export type VerifiedDeviceJoinPackage = DeviceJoinPackageEnvelope;

const verifiedDeviceJoinPackages =
  new WeakMap<object, DeviceJoinPackageEnvelope>();

export type ResolveJoinPackageDevice = (
  deviceId: string,
) => {
  readonly humanId: string;
  readonly state: "pending" | "active";
  readonly generation: number;
  readonly signingPublicKey: Uint8Array;
} | null;

export type ResolveJoinPackageProviderHead = (
  domainId: string,
) => {
  readonly providerId: string;
  readonly domainId: string;
  readonly epoch: number;
  readonly stateHash: Uint8Array;
} | null;

function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("Device join package counter is invalid");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Device join package counter is unsafe");
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function envelopesEqual(
  left: DeviceJoinPackageEnvelope,
  right: DeviceJoinPackageEnvelope,
): boolean {
  return left.formatVersion === right.formatVersion
    && left.providerId === right.providerId
    && left.domainId === right.domainId
    && left.humanId === right.humanId
    && left.deviceId === right.deviceId
    && left.expectedEpoch === right.expectedEpoch
    && equalBytes(
      left.expectedProviderHeadHash,
      right.expectedProviderHeadHash,
    )
    && left.generation === right.generation
    && left.packageId === right.packageId
    && equalBytes(left.keyPackageBytes, right.keyPackageBytes)
    && equalBytes(left.packageHash, right.packageHash)
    && left.createdAt === right.createdAt
    && left.expiresAt === right.expiresAt
    && equalBytes(left.signature, right.signature);
}

function snapshotEnvelope(
  envelope: DeviceJoinPackageEnvelope,
): DeviceJoinPackageEnvelope {
  return Object.freeze({
    ...envelope,
    expectedProviderHeadHash:
      Uint8Array.from(envelope.expectedProviderHeadHash),
    keyPackageBytes: Uint8Array.from(envelope.keyPackageBytes),
    packageHash: Uint8Array.from(envelope.packageHash),
    signature: Uint8Array.from(envelope.signature),
  });
}

/**
 * Repository-only process-local provenance guard. It is deliberately omitted
 * from the public package barrel, so a caller cannot bless a structural
 * look-alike without running verifyDeviceJoinPackage.
 */
export function assertVerifiedDeviceJoinPackage(
  value: VerifiedDeviceJoinPackage,
): void {
  const snapshot = (
    typeof value === "object" && value !== null
      ? verifiedDeviceJoinPackages.get(value)
      : undefined
  );
  if (snapshot === undefined || !envelopesEqual(value, snapshot)) {
    throw new TypeError(
      "Device join package was not cryptographically verified",
    );
  }
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

function hash(label: string, value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new RangeError(`${label} must be exactly 32 bytes`);
  }
}

function assertEnvelope(
  envelope: DeviceJoinPackageEnvelope,
  crypto: LatticeCrypto,
): void {
  if (
    typeof envelope !== "object"
    || envelope === null
    || envelope.formatVersion !== DEVICE_JOIN_PACKAGE_FORMAT_VERSION
  ) {
    throw new TypeError("Device join package envelope is malformed");
  }
  portable("Device join provider", envelope.providerId);
  cryptoDomainId(envelope.domainId);
  humanId(envelope.humanId);
  cryptoDeviceId(envelope.deviceId);
  portable("Device join package id", envelope.packageId);
  for (const value of [
    envelope.expectedEpoch,
    envelope.generation,
    envelope.createdAt,
    envelope.expiresAt,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Device join package counter is unsafe");
    }
  }
  if (
    envelope.generation < 1
    || envelope.expiresAt <= envelope.createdAt
    || envelope.expiresAt - envelope.createdAt > DEVICE_JOIN_PACKAGE_TTL_MS
  ) {
    throw new RangeError("Device join package expiry or generation is invalid");
  }
  if (
    !(envelope.keyPackageBytes instanceof Uint8Array)
    || envelope.keyPackageBytes.length < 1
    || envelope.keyPackageBytes.length > DEVICE_JOIN_PACKAGE_MAX_BYTES
  ) {
    throw new RangeError("Device join package bytes are out of bounds");
  }
  hash("Device join provider head", envelope.expectedProviderHeadHash);
  hash("Device join package hash", envelope.packageHash);
  if (
    !equalBytes(crypto.hash(envelope.keyPackageBytes), envelope.packageHash)
    || !(envelope.signature instanceof Uint8Array)
    || envelope.signature.length !== 64
  ) {
    throw new Error("Device join package hash or signature is invalid");
  }
}

export function deviceJoinPackageSigningBytes(
  envelope: Omit<DeviceJoinPackageEnvelope, "signature">,
): Uint8Array {
  return concat([
    text("nautilo/lattice-bridge/device-join-package/v1"),
    u32(envelope.formatVersion),
    text(envelope.providerId),
    text(envelope.domainId),
    text(envelope.humanId),
    text(envelope.deviceId),
    u64(envelope.expectedEpoch),
    frame(envelope.expectedProviderHeadHash),
    u64(envelope.generation),
    text(envelope.packageId),
    frame(envelope.packageHash),
    u64(envelope.createdAt),
    u64(envelope.expiresAt),
  ]);
}

export function createDeviceJoinPackage(input: {
  readonly crypto: LatticeCrypto;
  readonly request: DeviceJoinRequestPublic;
  readonly generation: number;
  readonly packageId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly signingPrivateKey: Uint8Array;
}): DeviceJoinPackageEnvelope {
  const request = input.request;
  if (
    request.formatVersion !== 2
    || request.providerId !== request.expectedHead.providerId
    || request.domainId !== request.expectedHead.domainId
  ) {
    throw new Error("Device join request does not match its provider head");
  }
  const unsigned = Object.freeze({
    formatVersion: DEVICE_JOIN_PACKAGE_FORMAT_VERSION,
    providerId: request.providerId,
    domainId: request.domainId,
    humanId: request.humanId,
    deviceId: request.deviceId,
    expectedEpoch: request.expectedHead.epoch,
    expectedProviderHeadHash: Uint8Array.from(request.expectedHead.stateHash),
    generation: input.generation,
    packageId: input.packageId,
    keyPackageBytes: Uint8Array.from(request.keyPackageBytes),
    packageHash: input.crypto.hash(request.keyPackageBytes),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  });
  const candidate = Object.freeze({
    ...unsigned,
    signature: input.crypto.sign(
      input.signingPrivateKey,
      deviceJoinPackageSigningBytes(unsigned),
    ),
  });
  assertEnvelope(candidate, input.crypto);
  return candidate;
}

export function verifyDeviceJoinPackage(input: {
  readonly crypto: LatticeCrypto;
  readonly envelope: DeviceJoinPackageEnvelope;
  readonly now: number;
  readonly resolveDevice: ResolveJoinPackageDevice;
  readonly resolveProviderHead: ResolveJoinPackageProviderHead;
}): VerifiedDeviceJoinPackage {
  assertEnvelope(input.envelope, input.crypto);
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new RangeError("Device join verification time is invalid");
  }
  if (input.now >= input.envelope.expiresAt) {
    throw new Error("Device join package has expired");
  }
  const device = input.resolveDevice(input.envelope.deviceId);
  if (
    device === null
    || (device.state !== "pending" && device.state !== "active")
    || device.humanId !== input.envelope.humanId
    || device.generation !== input.envelope.generation
  ) {
    throw new Error("Device join package device is not registered or is revoked");
  }
  const head = input.resolveProviderHead(input.envelope.domainId);
  if (
    head === null
    || head.providerId !== input.envelope.providerId
    || head.domainId !== input.envelope.domainId
    || head.epoch !== input.envelope.expectedEpoch
    || !equalBytes(
      head.stateHash,
      input.envelope.expectedProviderHeadHash,
    )
  ) {
    throw new Error("Device join package provider head is stale");
  }
  if (
    device.signingPublicKey.length !== 32
    || !input.crypto.verify(
      device.signingPublicKey,
      deviceJoinPackageSigningBytes(input.envelope),
      input.envelope.signature,
    )
  ) {
    throw new Error("Device join package signature is invalid");
  }
  const verified = snapshotEnvelope(input.envelope);
  verifiedDeviceJoinPackages.set(verified, snapshotEnvelope(verified));
  return verified;
}
