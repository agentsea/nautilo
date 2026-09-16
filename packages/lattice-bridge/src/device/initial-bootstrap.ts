import {
  cryptoDeviceId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import type {
  NautiloActorId,
  NautiloUserId,
} from "../identity/product-ids.ts";
import { productIdIsValid } from "../identity/product-ids.ts";

export const INITIAL_DEVICE_BOOTSTRAP_FORMAT_VERSION = 1 as const;
export const INITIAL_DEVICE_BOOTSTRAP_CHALLENGE_BYTES = 32;
export const INITIAL_DEVICE_BOOTSTRAP_TTL_MS = 5 * 60 * 1_000;

export type InitialDeviceBootstrapContext =
  | {
    readonly kind: "preparation";
    readonly authorityId: string;
  }
  | {
    readonly kind: "greenfield_initial_owner";
    readonly authorityId: string;
  }
  | {
    readonly kind: "pending_encrypted_invite";
    readonly authorityId: string;
  };

export interface BeginInitialDeviceBootstrap {
  readonly userId: NautiloUserId;
  readonly humanActorId: NautiloActorId;
  readonly deviceId: string;
  readonly clientKind: "browser" | "electron" | "tui";
  readonly installationLineageDigest: Uint8Array;
  readonly signingPublicKey: Uint8Array;
  readonly encryptionPublicKey: Uint8Array;
  readonly recoveryKeyId: string;
  readonly recoveryPublicKey: Uint8Array;
  readonly context: InitialDeviceBootstrapContext;
  readonly idempotencyKey: string;
}

export interface InitialDeviceBootstrapChallenge
  extends BeginInitialDeviceBootstrap {
  readonly formatVersion: typeof INITIAL_DEVICE_BOOTSTRAP_FORMAT_VERSION;
  readonly challengeId: string;
  readonly authorizationEvidenceDigest: Uint8Array;
  readonly authorizationDigest: Uint8Array;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface InitialDeviceBootstrapCompletion {
  readonly formatVersion: typeof INITIAL_DEVICE_BOOTSTRAP_FORMAT_VERSION;
  readonly challenge: InitialDeviceBootstrapChallenge;
  readonly recoveryArchiveBytes: Uint8Array;
  readonly deviceProof: Uint8Array;
}

export interface InitialDeviceBootstrapReceipt {
  readonly formatVersion: typeof INITIAL_DEVICE_BOOTSTRAP_FORMAT_VERSION;
  readonly status: "active";
  readonly humanActorId: NautiloActorId;
  readonly deviceId: string;
  readonly recoveryKeyId: string;
  readonly recoveryGeneration: 1;
  readonly deviceRevision: 1;
  readonly custodyRevision: 1;
  readonly auditRef: string;
  readonly committedAt: number;
}

export interface InitialDeviceBootstrapReceiptQuery {
  readonly userId: NautiloUserId;
  readonly humanActorId: NautiloActorId;
  readonly deviceId: string;
  readonly challengeId: string;
  readonly publicFingerprint: Uint8Array;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Bootstrap timestamp must be a safe nonnegative integer");
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function frame(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + bytes.length);
  output.set(u32(bytes.length), 0);
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

function assertBytes(
  label: string,
  value: Uint8Array,
  expectedLength: number,
): void {
  if (!(value instanceof Uint8Array) || value.length !== expectedLength) {
    throw new RangeError(`${label} must be exactly ${expectedLength} bytes`);
  }
}

function assertPortableText(label: string, value: string): void {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  ) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
}

export function assertInitialDeviceBootstrapChallenge(
  challenge: InitialDeviceBootstrapChallenge,
): void {
  if (
    typeof challenge !== "object"
    || challenge === null
    || challenge.formatVersion !== INITIAL_DEVICE_BOOTSTRAP_FORMAT_VERSION
  ) {
    throw new TypeError("Initial device bootstrap challenge is malformed");
  }
  cryptoDeviceId(challenge.deviceId);
  if (
    !productIdIsValid(challenge.userId)
    || !productIdIsValid(challenge.humanActorId)
  ) {
    throw new TypeError("Bootstrap product identity is malformed");
  }
  if (
    challenge.clientKind !== "browser"
    && challenge.clientKind !== "electron"
    && challenge.clientKind !== "tui"
  ) {
    throw new TypeError("Bootstrap client kind is unsupported");
  }
  if (
    challenge.context.kind !== "preparation"
    && challenge.context.kind !== "greenfield_initial_owner"
    && challenge.context.kind !== "pending_encrypted_invite"
  ) {
    throw new TypeError("Bootstrap authorization context is unsupported");
  }
  assertPortableText("Bootstrap challenge id", challenge.challengeId);
  assertPortableText("Bootstrap recovery key id", challenge.recoveryKeyId);
  assertPortableText("Bootstrap idempotency key", challenge.idempotencyKey);
  assertPortableText(
    "Bootstrap context authority id",
    challenge.context.authorityId,
  );
  assertBytes(
    "Bootstrap installation lineage digest",
    challenge.installationLineageDigest,
    32,
  );
  assertBytes("Bootstrap signing public key", challenge.signingPublicKey, 32);
  assertBytes(
    "Bootstrap encryption public key",
    challenge.encryptionPublicKey,
    65,
  );
  assertBytes(
    "Bootstrap recovery public key",
    challenge.recoveryPublicKey,
    65,
  );
  assertBytes(
    "Bootstrap authorization evidence digest",
    challenge.authorizationEvidenceDigest,
    32,
  );
  assertBytes(
    "Bootstrap authorization digest",
    challenge.authorizationDigest,
    32,
  );
  if (
    challenge.expiresAt <= challenge.issuedAt
    || challenge.expiresAt - challenge.issuedAt
      > INITIAL_DEVICE_BOOTSTRAP_TTL_MS
  ) {
    throw new RangeError("Initial device bootstrap challenge expiry is invalid");
  }
}

export function initialDeviceBootstrapSigningBytes(input: {
  readonly challenge: InitialDeviceBootstrapChallenge;
  readonly recoveryArchiveBytes: Uint8Array;
  readonly crypto: Pick<LatticeCrypto, "hash">;
}): Uint8Array {
  assertInitialDeviceBootstrapChallenge(input.challenge);
  if (
    !(input.recoveryArchiveBytes instanceof Uint8Array)
    || input.recoveryArchiveBytes.length < 1
    || input.recoveryArchiveBytes.length > 67_108_864
  ) {
    throw new RangeError("Bootstrap recovery archive exceeds its byte limit");
  }
  const challenge = input.challenge;
  return concat([
    text("nautilo/lattice-bridge/initial-device-bootstrap/v1"),
    u32(INITIAL_DEVICE_BOOTSTRAP_FORMAT_VERSION),
    text(challenge.challengeId),
    text(challenge.userId),
    text(challenge.humanActorId),
    text(challenge.deviceId),
    text(challenge.clientKind),
    frame(challenge.installationLineageDigest),
    frame(challenge.signingPublicKey),
    frame(challenge.encryptionPublicKey),
    text(challenge.recoveryKeyId),
    frame(challenge.recoveryPublicKey),
    text(challenge.context.kind),
    text(challenge.context.authorityId),
    frame(challenge.authorizationEvidenceDigest),
    frame(challenge.authorizationDigest),
    text(challenge.idempotencyKey),
    u64(challenge.issuedAt),
    u64(challenge.expiresAt),
    frame(input.crypto.hash(input.recoveryArchiveBytes)),
  ]);
}

export function initialDeviceBootstrapAuditRef(input: {
  readonly challenge: InitialDeviceBootstrapChallenge;
  readonly recoveryArchiveBytes: Uint8Array;
  readonly crypto: Pick<LatticeCrypto, "hash">;
}): string {
  const signingBytes = initialDeviceBootstrapSigningBytes(input);
  try {
    return `bootstrap_${
      Array.from(
        input.crypto.hash(signingBytes).subarray(0, 16),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("")
    }`;
  } finally {
    signingBytes.fill(0);
  }
}

export function initialDeviceBootstrapAuthorizationDigest(input: {
  readonly request: BeginInitialDeviceBootstrap;
  readonly authorizationEvidenceDigest: Uint8Array;
  readonly crypto: Pick<LatticeCrypto, "hash">;
}): Uint8Array {
  const request = input.request;
  assertBytes(
    "Bootstrap authorization evidence digest",
    input.authorizationEvidenceDigest,
    32,
  );
  return input.crypto.hash(concat([
    text("nautilo/lattice-bridge/initial-device-authorization/v1"),
    text(request.userId),
    text(request.humanActorId),
    text(request.deviceId),
    text(request.clientKind),
    frame(request.installationLineageDigest),
    frame(request.signingPublicKey),
    frame(request.encryptionPublicKey),
    text(request.recoveryKeyId),
    frame(request.recoveryPublicKey),
    text(request.context.kind),
    text(request.context.authorityId),
    frame(input.authorizationEvidenceDigest),
    text(request.idempotencyKey),
  ]));
}

export function createInitialDeviceBootstrapProof(input: {
  readonly crypto: Pick<LatticeCrypto, "hash" | "sign">;
  readonly challenge: InitialDeviceBootstrapChallenge;
  readonly recoveryArchiveBytes: Uint8Array;
  readonly signingPrivateKey: Uint8Array;
}): InitialDeviceBootstrapCompletion {
  assertBytes("Bootstrap signing private key", input.signingPrivateKey, 32);
  const signingBytes = initialDeviceBootstrapSigningBytes(input);
  return Object.freeze({
    formatVersion: INITIAL_DEVICE_BOOTSTRAP_FORMAT_VERSION,
    challenge: input.challenge,
    recoveryArchiveBytes: Uint8Array.from(input.recoveryArchiveBytes),
    deviceProof: input.crypto.sign(input.signingPrivateKey, signingBytes),
  });
}
