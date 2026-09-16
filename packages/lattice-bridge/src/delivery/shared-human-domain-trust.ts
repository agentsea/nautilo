import {
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";

export const SHARED_HUMAN_DOMAIN_TRUST_FORMAT_VERSION = 1 as const;
const SHARED_HUMAN_DOMAIN_TRUST_MAX_DEVICES = 256;

export interface SharedHumanDomainTrustedDeviceV1 {
  readonly humanId: string;
  readonly deviceId: string;
  readonly deviceGeneration: number;
  readonly signingPublicKey: Uint8Array;
}

export interface SharedHumanDomainTrustAcceptanceV1 {
  readonly formatVersion: typeof SHARED_HUMAN_DOMAIN_TRUST_FORMAT_VERSION;
  readonly domainId: string;
  readonly domainEpoch: number;
  readonly participantDigest: Uint8Array;
  readonly targetSubmissionDigest: Uint8Array;
  readonly deviceInventoryDigest: Uint8Array;
  readonly acceptedByHumanId: string;
  readonly acceptedByDeviceId: string;
  readonly acceptedAt: number;
  readonly signature: Uint8Array;
}

const HASH_BYTES = 32;
const PUBLIC_KEY_BYTES = 32;

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("Shared Domain trust counter is invalid");
  }
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value);
  return output;
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Shared Domain trust counter is unsafe");
  }
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, BigInt(value));
  return output;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce(
    (total, part) => total + part.length,
    0,
  ));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function frame(value: Uint8Array): Uint8Array {
  return concat([u32(value.length), value]);
}

function text(value: string): Uint8Array {
  return frame(new TextEncoder().encode(value));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function canonicalDevices(
  input: readonly SharedHumanDomainTrustedDeviceV1[],
): readonly SharedHumanDomainTrustedDeviceV1[] {
  if (input.length < 2 || input.length > SHARED_HUMAN_DOMAIN_TRUST_MAX_DEVICES) {
    throw new RangeError("Shared Domain trusted-device count is out of bounds");
  }
  const devices = input.map((entry) => Object.freeze({
    humanId: humanId(entry.humanId),
    deviceId: cryptoDeviceId(entry.deviceId),
    deviceGeneration: entry.deviceGeneration,
    signingPublicKey: entry.signingPublicKey.slice(),
  })).sort((left, right) => {
    const human = left.humanId.localeCompare(right.humanId);
    return human === 0 ? left.deviceId.localeCompare(right.deviceId) : human;
  });
  if (devices.some((entry, index) =>
    !Number.isSafeInteger(entry.deviceGeneration)
    || entry.deviceGeneration < 1
    || entry.signingPublicKey.length !== PUBLIC_KEY_BYTES
    || (index > 0 && devices[index - 1]!.deviceId === entry.deviceId)
  )) {
    devices.forEach((entry) => entry.signingPublicKey.fill(0));
    throw new TypeError("Shared Domain trusted-device inventory is malformed");
  }
  return Object.freeze(devices);
}

function sharedHumanDomainDeviceInventoryDigestV1(input: Readonly<{
  crypto: Pick<LatticeCrypto, "hash">;
  devices: readonly SharedHumanDomainTrustedDeviceV1[];
}>): Uint8Array {
  const devices = canonicalDevices(input.devices);
  const bytes = concat([
    text("nautilo/lattice-bridge/shared-human-domain-device-inventory/v1"),
    u32(devices.length),
    ...devices.flatMap((entry) => [
      text(entry.humanId),
      text(entry.deviceId),
      u64(entry.deviceGeneration),
      frame(entry.signingPublicKey),
    ]),
  ]);
  try {
    return input.crypto.hash(bytes);
  } finally {
    bytes.fill(0);
    devices.forEach((entry) => entry.signingPublicKey.fill(0));
  }
}

function signingBytes(
  input: Omit<SharedHumanDomainTrustAcceptanceV1, "signature">,
): Uint8Array {
  return concat([
    text("nautilo/lattice-bridge/shared-human-domain-trust/v1"),
    u32(input.formatVersion),
    text(input.domainId),
    u64(input.domainEpoch),
    frame(input.participantDigest),
    frame(input.targetSubmissionDigest),
    frame(input.deviceInventoryDigest),
    text(input.acceptedByHumanId),
    text(input.acceptedByDeviceId),
    u64(input.acceptedAt),
  ]);
}

function exactHash(label: string, value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new RangeError(`${label} must be exactly 32 bytes`);
  }
  return value.slice();
}

export function createSharedHumanDomainTrustAcceptanceV1(input: Readonly<{
  crypto: LatticeCrypto;
  domainId: string;
  domainEpoch: number;
  participantDigest: Uint8Array;
  targetSubmissionDigest: Uint8Array;
  devices: readonly SharedHumanDomainTrustedDeviceV1[];
  acceptedByHumanId: string;
  acceptedByDeviceId: string;
  acceptedAt: number;
  acceptingSigningPrivateKey: Uint8Array;
}>): Readonly<{
  acceptance: SharedHumanDomainTrustAcceptanceV1;
  devices: readonly SharedHumanDomainTrustedDeviceV1[];
}> {
  cryptoDomainId(input.domainId);
  humanId(input.acceptedByHumanId);
  cryptoDeviceId(input.acceptedByDeviceId);
  if (!Number.isSafeInteger(input.domainEpoch) || input.domainEpoch < 1
    || !Number.isSafeInteger(input.acceptedAt) || input.acceptedAt < 0) {
    throw new RangeError("Shared Domain trust coordinates are invalid");
  }
  const devices = canonicalDevices(input.devices);
  const accepter = devices.find((entry) =>
    entry.humanId === input.acceptedByHumanId
    && entry.deviceId === input.acceptedByDeviceId
  );
  if (accepter === undefined) {
    devices.forEach((entry) => entry.signingPublicKey.fill(0));
    throw new TypeError("Shared Domain accepter is not in the device inventory");
  }
  const inventoryDigest = sharedHumanDomainDeviceInventoryDigestV1({
    crypto: input.crypto,
    devices,
  });
  const unsigned = Object.freeze({
    formatVersion: SHARED_HUMAN_DOMAIN_TRUST_FORMAT_VERSION,
    domainId: input.domainId,
    domainEpoch: input.domainEpoch,
    participantDigest: exactHash(
      "Shared Domain participant digest",
      input.participantDigest,
    ),
    targetSubmissionDigest: exactHash(
      "Shared Domain submission digest",
      input.targetSubmissionDigest,
    ),
    deviceInventoryDigest: inventoryDigest,
    acceptedByHumanId: input.acceptedByHumanId,
    acceptedByDeviceId: input.acceptedByDeviceId,
    acceptedAt: input.acceptedAt,
  });
  const bytes = signingBytes(unsigned);
  try {
    return Object.freeze({
      acceptance: Object.freeze({
        ...unsigned,
        signature: input.crypto.sign(input.acceptingSigningPrivateKey, bytes),
      }),
      devices,
    });
  } finally {
    bytes.fill(0);
  }
}

export function verifySharedHumanDomainTrustAcceptanceV1(input: Readonly<{
  crypto: LatticeCrypto;
  acceptance: SharedHumanDomainTrustAcceptanceV1;
  devices: readonly SharedHumanDomainTrustedDeviceV1[];
}>): Readonly<{
  acceptance: SharedHumanDomainTrustAcceptanceV1;
  devices: readonly SharedHumanDomainTrustedDeviceV1[];
}> {
  const value = input.acceptance;
  cryptoDomainId(value.domainId);
  humanId(value.acceptedByHumanId);
  cryptoDeviceId(value.acceptedByDeviceId);
  if (value.formatVersion !== SHARED_HUMAN_DOMAIN_TRUST_FORMAT_VERSION
    || !Number.isSafeInteger(value.domainEpoch) || value.domainEpoch < 1
    || !Number.isSafeInteger(value.acceptedAt) || value.acceptedAt < 0
    || value.participantDigest.length !== HASH_BYTES
    || value.targetSubmissionDigest.length !== HASH_BYTES
    || value.deviceInventoryDigest.length !== HASH_BYTES
    || value.signature.length !== 64) {
    throw new TypeError("Shared Domain trust acceptance is malformed");
  }
  const devices = canonicalDevices(input.devices);
  const accepter = devices.find((entry) =>
    entry.humanId === value.acceptedByHumanId
    && entry.deviceId === value.acceptedByDeviceId
  );
  const digest = sharedHumanDomainDeviceInventoryDigestV1({
    crypto: input.crypto,
    devices,
  });
  const bytes = signingBytes(value);
  if (accepter === undefined
    || !equalBytes(digest, value.deviceInventoryDigest)
    || !input.crypto.verify(accepter.signingPublicKey, bytes, value.signature)) {
    bytes.fill(0);
    digest.fill(0);
    devices.forEach((entry) => entry.signingPublicKey.fill(0));
    throw new Error("Shared Domain trust acceptance is not authentic");
  }
  bytes.fill(0);
  digest.fill(0);
  return Object.freeze({
    acceptance: Object.freeze({
      ...value,
      participantDigest: value.participantDigest.slice(),
      targetSubmissionDigest: value.targetSubmissionDigest.slice(),
      deviceInventoryDigest: value.deviceInventoryDigest.slice(),
      signature: value.signature.slice(),
    }),
    devices,
  });
}

export function encodeSharedHumanDomainTrustAcceptanceV1(
  value: SharedHumanDomainTrustAcceptanceV1,
): Uint8Array {
  const unsigned = signingBytes(value);
  try {
    return concat([frame(unsigned), frame(value.signature)]);
  } finally {
    unsigned.fill(0);
  }
}

class Reader {
  #offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  u32(): number {
    if (this.#offset + 4 > this.bytes.length) {
      throw new RangeError("Shared Domain trust bytes are truncated");
    }
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    ).getUint32(this.#offset);
    this.#offset += 4;
    return value;
  }
  u64(): number {
    if (this.#offset + 8 > this.bytes.length) {
      throw new RangeError("Shared Domain trust bytes are truncated");
    }
    const value = Number(new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    ).getBigUint64(this.#offset));
    this.#offset += 8;
    if (!Number.isSafeInteger(value)) {
      throw new RangeError("Shared Domain trust counter is unsafe");
    }
    return value;
  }
  frame(maximum = 1_048_576): Uint8Array {
    const length = this.u32();
    if (length > maximum || this.#offset + length > this.bytes.length) {
      throw new RangeError("Shared Domain trust frame is invalid");
    }
    const output = this.bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return output;
  }
  text(): string {
    const value = this.frame(128);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } finally {
      value.fill(0);
    }
  }
  finish(): void {
    if (this.#offset !== this.bytes.length) {
      throw new RangeError("Shared Domain trust bytes have trailing data");
    }
  }
}

export function decodeSharedHumanDomainTrustAcceptanceV1(
  bytes: Uint8Array,
): SharedHumanDomainTrustAcceptanceV1 {
  const outer = new Reader(bytes);
  const unsignedBytes = outer.frame();
  const signature = outer.frame(64);
  outer.finish();
  const reader = new Reader(unsignedBytes);
  try {
    if (reader.text()
      !== "nautilo/lattice-bridge/shared-human-domain-trust/v1") {
      throw new TypeError("Shared Domain trust domain is unsupported");
    }
    const formatVersion = reader.u32();
    if (formatVersion !== SHARED_HUMAN_DOMAIN_TRUST_FORMAT_VERSION) {
      throw new TypeError("Shared Domain trust version is unsupported");
    }
    const value: SharedHumanDomainTrustAcceptanceV1 = Object.freeze({
      formatVersion,
      domainId: reader.text(),
      domainEpoch: reader.u64(),
      participantDigest: reader.frame(HASH_BYTES),
      targetSubmissionDigest: reader.frame(HASH_BYTES),
      deviceInventoryDigest: reader.frame(HASH_BYTES),
      acceptedByHumanId: reader.text(),
      acceptedByDeviceId: reader.text(),
      acceptedAt: reader.u64(),
      signature,
    });
    reader.finish();
    const canonical = encodeSharedHumanDomainTrustAcceptanceV1(value);
    try {
      if (!equalBytes(canonical, bytes)) {
        throw new TypeError("Shared Domain trust bytes are noncanonical");
      }
    } finally {
      canonical.fill(0);
    }
    return value;
  } catch (error) {
    signature.fill(0);
    throw error;
  } finally {
    unsignedBytes.fill(0);
  }
}
