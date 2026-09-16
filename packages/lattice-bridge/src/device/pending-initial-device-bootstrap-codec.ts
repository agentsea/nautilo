import { cryptoDeviceId } from "@nautilo/lattice-crypto";

import { assertClientProfileCoordinates } from
  "../client-vault/validation.ts";
import { CLIENT_PROFILE_VAULT_MAX_BYTES } from
  "../client-vault/types.ts";
import {
  nautiloActorId,
  nautiloUserId,
} from "../identity/product-ids.ts";
import {
  assertInitialDeviceBootstrapChallenge,
  type BeginInitialDeviceBootstrap,
  type InitialDeviceBootstrapChallenge,
  type InitialDeviceBootstrapContext,
} from "./initial-bootstrap.ts";
import type { PendingInitialDeviceBootstrap } from
  "./restart-safe-initial-device-client-ceremony.ts";

// 64 MiB recovery archive plus the bounded profile, after base64url expansion.
const MAX_PENDING_BYTES = 92 * 1_048_576;

interface EncodedRequest {
  readonly userId: string;
  readonly humanActorId: string;
  readonly deviceId: string;
  readonly clientKind: "browser" | "electron";
  readonly installationLineageDigestBase64url: string;
  readonly signingPublicKeyBase64url: string;
  readonly encryptionPublicKeyBase64url: string;
  readonly recoveryKeyId: string;
  readonly recoveryPublicKeyBase64url: string;
  readonly context: InitialDeviceBootstrapContext;
  readonly idempotencyKey: string;
}

interface EncodedChallenge extends EncodedRequest {
  readonly formatVersion: 1;
  readonly challengeId: string;
  readonly authorizationEvidenceDigestBase64url: string;
  readonly authorizationDigestBase64url: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

interface EncodedPendingInitialDeviceBootstrap {
  readonly formatVersion: 1;
  readonly revision: 1 | 2;
  readonly idempotencyKey: string;
  readonly coordinates: PendingInitialDeviceBootstrap["coordinates"];
  readonly request: EncodedRequest;
  readonly profileBytesBase64url: string;
  readonly recoveryArchiveBytesBase64url: string;
  readonly publicFingerprintBase64url: string;
  readonly challenge: EncodedChallenge | null;
  readonly deviceProofBase64url: string | null;
}

function encodeBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64url(value: unknown, label: string): Uint8Array {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9_-]*$/u.test(value)
    || value.length % 4 === 1
  ) throw new TypeError(`${label} is malformed`);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function exactBytes(
  value: unknown,
  label: string,
  length: number,
): Uint8Array {
  const bytes = decodeBase64url(value, label);
  if (bytes.length !== length) throw new RangeError(`${label} has invalid length`);
  return bytes;
}

function assertExactBytes(
  value: unknown,
  label: string,
  length: number,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} has invalid length`);
  }
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)) {
    throw new TypeError(`${label} is malformed`);
  }
  return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function challengeMatchesRequest(
  value: InitialDeviceBootstrapChallenge,
  current: BeginInitialDeviceBootstrap,
): boolean {
  return value.userId === current.userId
    && value.humanActorId === current.humanActorId
    && value.deviceId === current.deviceId
    && value.clientKind === current.clientKind
    && equalBytes(value.installationLineageDigest,
      current.installationLineageDigest)
    && equalBytes(value.signingPublicKey, current.signingPublicKey)
    && equalBytes(value.encryptionPublicKey, current.encryptionPublicKey)
    && value.recoveryKeyId === current.recoveryKeyId
    && equalBytes(value.recoveryPublicKey, current.recoveryPublicKey)
    && value.context.kind === current.context.kind
    && value.context.authorityId === current.context.authorityId
    && value.idempotencyKey === current.idempotencyKey;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function wipe(value: PendingInitialDeviceBootstrap): void {
  value.profileBytes.fill(0);
  value.recoveryArchiveBytes.fill(0);
  value.publicFingerprint.fill(0);
  value.deviceProof?.fill(0);
  value.request.installationLineageDigest.fill(0);
  value.request.signingPublicKey.fill(0);
  value.request.encryptionPublicKey.fill(0);
  value.request.recoveryPublicKey.fill(0);
  value.challenge?.installationLineageDigest.fill(0);
  value.challenge?.signingPublicKey.fill(0);
  value.challenge?.encryptionPublicKey.fill(0);
  value.challenge?.recoveryPublicKey.fill(0);
  value.challenge?.authorizationEvidenceDigest.fill(0);
  value.challenge?.authorizationDigest.fill(0);
}

function context(value: unknown): InitialDeviceBootstrapContext {
  if (typeof value !== "object" || value === null
    || !("kind" in value) || !("authorityId" in value)) {
    throw new TypeError("Pending bootstrap context is malformed");
  }
  const kind = value.kind;
  if (kind !== "preparation" && kind !== "greenfield_initial_owner"
    && kind !== "pending_encrypted_invite") {
    throw new TypeError("Pending bootstrap context is malformed");
  }
  return Object.freeze({
    kind,
    authorityId: boundedText(value.authorityId, "Pending bootstrap authority"),
  });
}

function request(value: unknown): BeginInitialDeviceBootstrap {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Pending bootstrap request is malformed");
  }
  const candidate = value as Partial<EncodedRequest>;
  const user = nautiloUserId(candidate.userId);
  const human = nautiloActorId(candidate.humanActorId);
  if (!user.ok || !human.ok) {
    throw new TypeError("Pending bootstrap product identity is malformed");
  }
  const deviceId = boundedText(candidate.deviceId, "Pending bootstrap device");
  cryptoDeviceId(deviceId);
  if (candidate.clientKind !== "browser" && candidate.clientKind !== "electron") {
    throw new TypeError("Pending bootstrap client kind is unsupported");
  }
  return Object.freeze({
    userId: user.value,
    humanActorId: human.value,
    deviceId,
    clientKind: candidate.clientKind,
    installationLineageDigest: exactBytes(
      candidate.installationLineageDigestBase64url,
      "Pending bootstrap lineage",
      32,
    ),
    signingPublicKey: exactBytes(
      candidate.signingPublicKeyBase64url,
      "Pending bootstrap signing key",
      32,
    ),
    encryptionPublicKey: exactBytes(
      candidate.encryptionPublicKeyBase64url,
      "Pending bootstrap encryption key",
      65,
    ),
    recoveryKeyId: boundedText(
      candidate.recoveryKeyId,
      "Pending bootstrap recovery key",
    ),
    recoveryPublicKey: exactBytes(
      candidate.recoveryPublicKeyBase64url,
      "Pending bootstrap recovery public key",
      65,
    ),
    context: context(candidate.context),
    idempotencyKey: boundedText(
      candidate.idempotencyKey,
      "Pending bootstrap idempotency key",
    ),
  });
}

function assertRequest(
  value: BeginInitialDeviceBootstrap,
): asserts value is BeginInitialDeviceBootstrap & Readonly<{
  clientKind: "browser" | "electron";
}> {
  const user = nautiloUserId(value.userId);
  const human = nautiloActorId(value.humanActorId);
  if (!user.ok || !human.ok) {
    throw new TypeError("Pending bootstrap product identity is malformed");
  }
  cryptoDeviceId(value.deviceId);
  if (value.clientKind !== "browser" && value.clientKind !== "electron") {
    throw new TypeError("Pending bootstrap client kind is unsupported");
  }
  assertExactBytes(value.installationLineageDigest,
    "Pending bootstrap lineage", 32);
  assertExactBytes(value.signingPublicKey,
    "Pending bootstrap signing key", 32);
  assertExactBytes(value.encryptionPublicKey,
    "Pending bootstrap encryption key", 65);
  assertExactBytes(value.recoveryPublicKey,
    "Pending bootstrap recovery public key", 65);
  boundedText(value.recoveryKeyId, "Pending bootstrap recovery key");
  context(value.context);
  boundedText(value.idempotencyKey, "Pending bootstrap idempotency key");
}

function encodedRequest(value: BeginInitialDeviceBootstrap): EncodedRequest {
  assertRequest(value);
  return {
    userId: value.userId,
    humanActorId: value.humanActorId,
    deviceId: value.deviceId,
    clientKind: value.clientKind,
    installationLineageDigestBase64url:
      encodeBase64url(value.installationLineageDigest),
    signingPublicKeyBase64url: encodeBase64url(value.signingPublicKey),
    encryptionPublicKeyBase64url: encodeBase64url(value.encryptionPublicKey),
    recoveryKeyId: value.recoveryKeyId,
    recoveryPublicKeyBase64url: encodeBase64url(value.recoveryPublicKey),
    context: { ...value.context },
    idempotencyKey: value.idempotencyKey,
  };
}

function challenge(value: unknown): InitialDeviceBootstrapChallenge {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Pending bootstrap challenge is malformed");
  }
  const candidate = value as Partial<EncodedChallenge>;
  const base = request(candidate);
  const decoded: InitialDeviceBootstrapChallenge = Object.freeze({
    ...base,
    formatVersion: 1,
    challengeId: boundedText(
      candidate.challengeId,
      "Pending bootstrap challenge",
    ),
    authorizationEvidenceDigest: exactBytes(
      candidate.authorizationEvidenceDigestBase64url,
      "Pending bootstrap authorization evidence",
      32,
    ),
    authorizationDigest: exactBytes(
      candidate.authorizationDigestBase64url,
      "Pending bootstrap authorization",
      32,
    ),
    issuedAt: candidate.issuedAt as number,
    expiresAt: candidate.expiresAt as number,
  });
  assertInitialDeviceBootstrapChallenge(decoded);
  return decoded;
}

function encodedChallenge(
  value: InitialDeviceBootstrapChallenge,
): EncodedChallenge {
  assertInitialDeviceBootstrapChallenge(value);
  const base = encodedRequest(value);
  return {
    ...base,
    formatVersion: 1,
    challengeId: value.challengeId,
    authorizationEvidenceDigestBase64url:
      encodeBase64url(value.authorizationEvidenceDigest),
    authorizationDigestBase64url: encodeBase64url(value.authorizationDigest),
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  };
}

export function encodePendingInitialDeviceBootstrap(
  value: PendingInitialDeviceBootstrap,
): Uint8Array {
  assertClientProfileCoordinates(value.coordinates);
  assertRequest(value.request);
  if (value.formatVersion !== 1 || (value.revision !== 1 && value.revision !== 2)
    || value.idempotencyKey !== value.request.idempotencyKey
    || value.coordinates.userId !== value.request.userId
    || value.coordinates.humanActorId !== value.request.humanActorId
    || value.coordinates.deviceId !== value.request.deviceId
    || value.coordinates.installationLineageDigest
      !== hex(value.request.installationLineageDigest)
    || value.profileBytes.length < 1
    || value.profileBytes.length > CLIENT_PROFILE_VAULT_MAX_BYTES
    || value.recoveryArchiveBytes.length < 1
    || value.recoveryArchiveBytes.length > 67_108_864
    || value.publicFingerprint.length !== 32
    || (value.revision === 1
      ? value.challenge !== null || value.deviceProof !== null
      : value.challenge === null || value.deviceProof?.length !== 64)
    || (value.challenge !== null
      && !challengeMatchesRequest(value.challenge, value.request))) {
    if (value.challenge !== null
      && !challengeMatchesRequest(value.challenge, value.request)) {
      throw new TypeError("Pending bootstrap challenge does not match request");
    }
    throw new TypeError("Pending initial-device bootstrap is malformed");
  }
  const encoded: EncodedPendingInitialDeviceBootstrap = {
    formatVersion: 1,
    revision: value.revision,
    idempotencyKey: value.idempotencyKey,
    coordinates: { ...value.coordinates },
    request: encodedRequest(value.request),
    profileBytesBase64url: encodeBase64url(value.profileBytes),
    recoveryArchiveBytesBase64url: encodeBase64url(value.recoveryArchiveBytes),
    publicFingerprintBase64url: encodeBase64url(value.publicFingerprint),
    challenge: value.challenge === null
      ? null : encodedChallenge(value.challenge),
    deviceProofBase64url: value.deviceProof === null
      ? null : encodeBase64url(value.deviceProof),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(encoded));
  if (bytes.length > MAX_PENDING_BYTES) {
    throw new RangeError("Pending initial-device bootstrap exceeds byte limit");
  }
  return bytes;
}

export function decodePendingInitialDeviceBootstrap(
  bytes: Uint8Array,
): PendingInitialDeviceBootstrap {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1
    || bytes.length > MAX_PENDING_BYTES) {
    throw new RangeError("Pending initial-device bootstrap exceeds byte limit");
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError("Pending initial-device bootstrap is malformed");
  }
  const value = parsed as Partial<EncodedPendingInitialDeviceBootstrap>;
  if (value.formatVersion !== 1 || (value.revision !== 1 && value.revision !== 2)
    || typeof value.idempotencyKey !== "string"
    || typeof value.coordinates !== "object" || value.coordinates === null) {
    throw new TypeError("Pending initial-device bootstrap is malformed");
  }
  assertClientProfileCoordinates(value.coordinates);
  const decodedRequest = request(value.request);
  const decodedChallenge = value.challenge === null
    ? null : challenge(value.challenge);
  const decoded: PendingInitialDeviceBootstrap = Object.freeze({
    formatVersion: 1,
    revision: value.revision,
    idempotencyKey: value.idempotencyKey,
    coordinates: Object.freeze({ ...value.coordinates }),
    request: decodedRequest,
    profileBytes: decodeBase64url(
      value.profileBytesBase64url,
      "Pending bootstrap profile",
    ),
    recoveryArchiveBytes: decodeBase64url(
      value.recoveryArchiveBytesBase64url,
      "Pending bootstrap recovery archive",
    ),
    publicFingerprint: exactBytes(
      value.publicFingerprintBase64url,
      "Pending bootstrap public fingerprint",
      32,
    ),
    challenge: decodedChallenge,
    deviceProof: value.deviceProofBase64url === null
      ? null : exactBytes(
        value.deviceProofBase64url,
        "Pending bootstrap device proof",
        64,
      ),
  });
  // The encoder is the single invariant boundary and catches cross-field drift.
  let canonical: Uint8Array;
  try {
    canonical = encodePendingInitialDeviceBootstrap(decoded);
  } catch (error) {
    wipe(decoded);
    throw error;
  }
  const exact = canonical.length === bytes.length
    && canonical.every((byte, index) => byte === bytes[index]);
  canonical.fill(0);
  if (!exact) {
    wipe(decoded);
    throw new TypeError("Pending initial-device bootstrap is not canonical");
  }
  return decoded;
}

export function pendingInitialDeviceBootstrapBytesEqual(
  left: PendingInitialDeviceBootstrap,
  right: PendingInitialDeviceBootstrap,
): boolean {
  const leftBytes = encodePendingInitialDeviceBootstrap(left);
  const rightBytes = encodePendingInitialDeviceBootstrap(right);
  try {
    return leftBytes.length === rightBytes.length
      && leftBytes.every((byte, index) => byte === rightBytes[index]);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}
