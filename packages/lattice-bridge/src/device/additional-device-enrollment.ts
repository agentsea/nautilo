import {
  cryptoDeviceId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import type {
  NautiloActorId,
  NautiloUserId,
} from "../identity/product-ids.ts";
import { productIdIsValid } from "../identity/product-ids.ts";

export const ADDITIONAL_DEVICE_ENROLLMENT_FORMAT_VERSION = 1 as const;
export const ADDITIONAL_DEVICE_CHALLENGE_TTL_MS = 5 * 60 * 1_000;
export const MAX_ACTIVE_CRYPTO_DEVICES_PER_HUMAN = 16;
export const MAX_PENDING_CRYPTO_DEVICES_PER_HUMAN = 4;
export const MAX_ADDITIONAL_DEVICE_INVENTORY_RECORDS = 4_096;

export interface BeginAdditionalDeviceEnrollment {
  readonly userId: NautiloUserId;
  readonly humanActorId: NautiloActorId;
  readonly deviceId: string;
  readonly clientKind: "browser" | "electron" | "tui";
  readonly installationLineageDigest: Uint8Array;
  readonly deviceGeneration: number;
  readonly signingPublicKey: Uint8Array;
  readonly encryptionPublicKey: Uint8Array;
  readonly method: "device_approval" | "recovery";
  readonly idempotencyKey: string;
}

export interface PendingAdditionalDeviceEnrollment
  extends BeginAdditionalDeviceEnrollment
{
  readonly formatVersion:
    typeof ADDITIONAL_DEVICE_ENROLLMENT_FORMAT_VERSION;
  readonly operationId: string;
  readonly challengeId: string;
  readonly authorizationEvidenceDigest: Uint8Array;
  readonly authorizationDigest: Uint8Array;
  readonly expectedCustodyRevision: number;
  readonly expectedRecoveryGeneration: number;
  readonly inventoryRevision: number;
  readonly inventoryCount: number;
  readonly inventoryDigest: Uint8Array;
  readonly deviceRevision: 0;
  readonly status: "pending";
  readonly issuedAt: number;
  readonly expiresAt: number;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Additional-device counter must be nonnegative");
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

function assertBytes(
  label: string,
  value: Uint8Array,
  length: number,
): void {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} must be exactly ${length} bytes`);
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

function assertSafeCounter(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a safe nonnegative counter`);
  }
}

export function assertBeginAdditionalDeviceEnrollment(
  value: BeginAdditionalDeviceEnrollment,
): void {
  if (
    typeof value !== "object"
    || value === null
    || !productIdIsValid(value.userId)
    || !productIdIsValid(value.humanActorId)
  ) {
    throw new TypeError("Additional-device enrollment request is malformed");
  }
  cryptoDeviceId(value.deviceId);
  if (
    value.clientKind !== "browser"
    && value.clientKind !== "electron"
    && value.clientKind !== "tui"
  ) {
    throw new TypeError("Additional-device client kind is unsupported");
  }
  if (
    value.method !== "device_approval"
    && value.method !== "recovery"
  ) {
    throw new TypeError("Additional-device enrollment method is unsupported");
  }
  assertPortableText(
    "Additional-device idempotency key",
    value.idempotencyKey,
  );
  assertBytes(
    "Additional-device lineage digest",
    value.installationLineageDigest,
    32,
  );
  if (
    !Number.isSafeInteger(value.deviceGeneration)
    || value.deviceGeneration < 1
  ) {
    throw new RangeError(
      "Additional-device generation must be a positive safe counter",
    );
  }
  assertBytes("Additional-device signing key", value.signingPublicKey, 32);
  assertBytes(
    "Additional-device encryption key",
    value.encryptionPublicKey,
    65,
  );
}

export function assertPendingAdditionalDeviceEnrollment(
  value: PendingAdditionalDeviceEnrollment,
): void {
  if (
    typeof value !== "object"
    || value === null
    || value.formatVersion
      !== ADDITIONAL_DEVICE_ENROLLMENT_FORMAT_VERSION
  ) {
    throw new TypeError("Additional-device enrollment is malformed");
  }
  assertBeginAdditionalDeviceEnrollment(value);
  for (const [label, identifier] of [
    ["Additional-device operation id", value.operationId],
    ["Additional-device challenge id", value.challengeId],
    ["Additional-device idempotency key", value.idempotencyKey],
  ] as const) {
    assertPortableText(label, identifier);
  }
  for (const [label, bytes, length] of [
    ["Additional-device lineage digest", value.installationLineageDigest, 32],
    ["Additional-device signing key", value.signingPublicKey, 32],
    ["Additional-device encryption key", value.encryptionPublicKey, 65],
    [
      "Additional-device authorization evidence",
      value.authorizationEvidenceDigest,
      32,
    ],
    ["Additional-device authorization digest", value.authorizationDigest, 32],
    ["Additional-device inventory digest", value.inventoryDigest, 32],
  ] as const) {
    assertBytes(label, bytes, length);
  }
  assertSafeCounter(
    "Additional-device custody revision",
    value.expectedCustodyRevision,
  );
  assertSafeCounter(
    "Additional-device recovery generation",
    value.expectedRecoveryGeneration,
  );
  assertSafeCounter(
    "Additional-device inventory revision",
    value.inventoryRevision,
  );
  if (
    !Number.isInteger(value.inventoryCount)
    || value.inventoryCount < 0
    || value.inventoryCount > MAX_ADDITIONAL_DEVICE_INVENTORY_RECORDS
  ) {
    throw new RangeError("Additional-device inventory count is out of bounds");
  }
  if (
    value.deviceRevision !== 0
    || value.status !== "pending"
    || value.expiresAt <= value.issuedAt
    || value.expiresAt - value.issuedAt
      > ADDITIONAL_DEVICE_CHALLENGE_TTL_MS
  ) {
    throw new RangeError("Additional-device pending state is invalid");
  }
}

export function additionalDeviceAuthorizationDigest(input: {
  readonly request: BeginAdditionalDeviceEnrollment;
  readonly authorizationEvidenceDigest: Uint8Array;
  readonly expectedCustodyRevision: number;
  readonly expectedRecoveryGeneration: number;
  readonly inventoryRevision: number;
  readonly inventoryCount: number;
  readonly inventoryDigest: Uint8Array;
  readonly crypto: Pick<LatticeCrypto, "hash">;
}): Uint8Array {
  assertBytes(
    "Additional-device authorization evidence",
    input.authorizationEvidenceDigest,
    32,
  );
  assertBytes("Additional-device inventory digest", input.inventoryDigest, 32);
  const request = input.request;
  return input.crypto.hash(concat([
    text("nautilo/lattice-bridge/additional-device-enrollment/v1"),
    text(request.userId),
    text(request.humanActorId),
    text(request.deviceId),
    text(request.clientKind),
    frame(request.installationLineageDigest),
    u64(request.deviceGeneration),
    frame(request.signingPublicKey),
    frame(request.encryptionPublicKey),
    text(request.method),
    text(request.idempotencyKey),
    frame(input.authorizationEvidenceDigest),
    u64(input.expectedCustodyRevision),
    u64(input.expectedRecoveryGeneration),
    u64(input.inventoryRevision),
    u64(input.inventoryCount),
    frame(input.inventoryDigest),
  ]));
}
