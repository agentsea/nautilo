import {
  cryptoDeviceId,
  humanId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import type {
  DeviceAdmissionChallengeDto,
  DeviceAdmissionProofRequest,
} from "@nautilo/api-client";

export const DEVICE_ADMISSION_FORMAT_VERSION = 1 as const;
export const DEVICE_ADMISSION_CHALLENGE_TTL_MS = 5 * 60 * 1_000;
export const DEVICE_ADMISSION_NONCE_BYTES = 32;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface DeviceAdmissionChallenge {
  readonly formatVersion: typeof DEVICE_ADMISSION_FORMAT_VERSION;
  readonly challengeId: string;
  readonly credentialDigest: Uint8Array;
  readonly userId: string;
  readonly humanActorId: string;
  readonly deviceId: string;
  readonly deviceGeneration: number;
  readonly serverInstanceId: string;
  readonly lineageGeneration: number;
  readonly epoch: number;
  readonly securityRevision: number;
  readonly headDigest: Uint8Array;
  readonly nonce: Uint8Array;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface DeviceAdmissionProof extends DeviceAdmissionChallenge {
  readonly signature: Uint8Array;
}

function assertCounter(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} is invalid`);
  }
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${label} is invalid`);
}

function assertBytes(
  value: Uint8Array,
  length: number,
  label: string,
): void {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
}

function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("Device admission frame length is invalid");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value: number): Uint8Array {
  assertCounter(value, "Device admission counter");
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

function framedText(value: string): Uint8Array {
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

export function assertDeviceAdmissionChallenge(
  value: DeviceAdmissionChallenge,
): void {
  if (
    typeof value !== "object"
    || value === null
    || value.formatVersion !== DEVICE_ADMISSION_FORMAT_VERSION
  ) {
    throw new TypeError("Device admission challenge is malformed");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.challengeId)) {
    throw new TypeError("Device admission challenge id is invalid");
  }
  assertBytes(value.credentialDigest, 32, "Credential digest");
  assertUuid(value.userId, "Device admission user id");
  humanId(value.humanActorId);
  cryptoDeviceId(value.deviceId);
  assertCounter(value.deviceGeneration, "Device generation");
  if (value.deviceGeneration < 1) {
    throw new RangeError("Device generation is invalid");
  }
  assertUuid(value.serverInstanceId, "Device admission server instance id");
  assertCounter(value.lineageGeneration, "Device-group lineage generation");
  if (value.lineageGeneration < 1) {
    throw new RangeError("Device-group lineage generation is invalid");
  }
  assertCounter(value.epoch, "Device-group epoch");
  assertCounter(value.securityRevision, "Device-group security revision");
  if (value.securityRevision < 1) {
    throw new RangeError("Device-group security revision is invalid");
  }
  assertBytes(value.headDigest, 32, "Device-group head digest");
  assertBytes(value.nonce, DEVICE_ADMISSION_NONCE_BYTES, "Admission nonce");
  assertCounter(value.issuedAt, "Admission challenge issue time");
  assertCounter(value.expiresAt, "Admission challenge expiry");
  if (
    value.expiresAt <= value.issuedAt
    || value.expiresAt - value.issuedAt > DEVICE_ADMISSION_CHALLENGE_TTL_MS
  ) {
    throw new RangeError("Device admission challenge lifetime is invalid");
  }
}

export function deviceAdmissionSigningBytes(
  challenge: DeviceAdmissionChallenge,
): Uint8Array {
  assertDeviceAdmissionChallenge(challenge);
  return concat([
    framedText("nautilo/lattice-bridge/device-admission/v1"),
    u32(challenge.formatVersion),
    framedText(challenge.challengeId),
    frame(challenge.credentialDigest),
    framedText(challenge.userId),
    framedText(challenge.humanActorId),
    framedText(challenge.deviceId),
    u64(challenge.deviceGeneration),
    framedText(challenge.serverInstanceId),
    u64(challenge.lineageGeneration),
    u64(challenge.epoch),
    u64(challenge.securityRevision),
    frame(challenge.headDigest),
    frame(challenge.nonce),
    u64(challenge.issuedAt),
    u64(challenge.expiresAt),
  ]);
}

export function createDeviceAdmissionProof(input: Readonly<{
  crypto: Pick<LatticeCrypto, "sign">;
  challenge: DeviceAdmissionChallenge;
  signingPrivateKey: Uint8Array;
}>): DeviceAdmissionProof {
  assertBytes(input.signingPrivateKey, 32, "Device signing private key");
  return Object.freeze({
    ...input.challenge,
    credentialDigest: input.challenge.credentialDigest.slice(),
    headDigest: input.challenge.headDigest.slice(),
    nonce: input.challenge.nonce.slice(),
    signature: input.crypto.sign(
      input.signingPrivateKey,
      deviceAdmissionSigningBytes(input.challenge),
    ),
  });
}

export function verifyDeviceAdmissionProof(input: Readonly<{
  crypto: Pick<LatticeCrypto, "verify">;
  proof: DeviceAdmissionProof;
  signingPublicKey: Uint8Array;
}>): boolean {
  assertDeviceAdmissionChallenge(input.proof);
  assertBytes(input.proof.signature, 64, "Device admission signature");
  assertBytes(input.signingPublicKey, 32, "Device signing public key");
  return input.crypto.verify(
    input.signingPublicKey,
    deviceAdmissionSigningBytes(input.proof),
    input.proof.signature,
  );
}

function decodeBase64url(value: string, length: number): Uint8Array {
  let binary: string;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/")
      + "=".repeat((4 - value.length % 4) % 4));
  } catch {
    throw new TypeError("Device admission bytes are malformed");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length !== length || encodeBase64url(bytes) !== value) {
    bytes.fill(0);
    throw new TypeError("Device admission bytes are malformed");
  }
  return bytes;
}

function encodeBase64url(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function deviceAdmissionChallengeFromDto(
  input: DeviceAdmissionChallengeDto,
): DeviceAdmissionChallenge {
  const challenge = Object.freeze({
    formatVersion: 1 as const,
    challengeId: input.challengeId,
    credentialDigest: decodeBase64url(input.credentialDigestBase64url, 32),
    userId: input.userId,
    humanActorId: input.humanActorId,
    deviceId: input.deviceId,
    deviceGeneration: input.deviceGeneration,
    serverInstanceId: input.serverInstanceId,
    lineageGeneration: input.lineageGeneration,
    epoch: input.epoch,
    securityRevision: input.securityRevision,
    headDigest: decodeBase64url(input.headDigestBase64url, 32),
    nonce: decodeBase64url(input.nonceBase64url, 32),
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  });
  assertDeviceAdmissionChallenge(challenge);
  return challenge;
}

export function deviceAdmissionProofToDto(
  proof: DeviceAdmissionProof,
): DeviceAdmissionProofRequest["proof"] {
  assertDeviceAdmissionChallenge(proof);
  assertBytes(proof.signature, 64, "Device admission signature");
  return Object.freeze({
    formatVersion: 1 as const,
    challengeId: proof.challengeId,
    credentialDigestBase64url: encodeBase64url(proof.credentialDigest),
    userId: proof.userId,
    humanActorId: proof.humanActorId,
    deviceId: proof.deviceId,
    deviceGeneration: proof.deviceGeneration,
    serverInstanceId: proof.serverInstanceId,
    lineageGeneration: proof.lineageGeneration,
    epoch: proof.epoch,
    securityRevision: proof.securityRevision,
    headDigestBase64url: encodeBase64url(proof.headDigest),
    nonceBase64url: encodeBase64url(proof.nonce),
    issuedAt: proof.issuedAt,
    expiresAt: proof.expiresAt,
    signatureBase64url: encodeBase64url(proof.signature),
  });
}
