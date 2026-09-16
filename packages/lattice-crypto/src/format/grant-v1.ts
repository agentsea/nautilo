import type {
  Epoch,
  Grant,
  GrantOperation,
  NamespaceId,
  UserId,
} from "../types/index.ts";
import { LATTICE_LIMITS } from "../limits.ts";
import { concat, utf8 } from "../util/bytes.ts";

export const GRANT_FORMAT_VERSION = 1 as const;

const SIGNING_DOMAIN = utf8(
  "nautilo/lattice-crypto/grant-signature/v1",
);
const MAX_U32 = 0xffff_ffff;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const decoder = new TextDecoder("utf-8", { fatal: true });
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

type GrantSigningFields = Omit<Grant, "signature" | "consumed">;

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_U32) {
    throw new RangeError("grant field does not fit u32");
  }
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("grant integer must be a non-negative safe integer");
  }
  let remaining = BigInt(value);
  const bytes = new Uint8Array(8);
  for (let index = bytes.length - 1; index >= 0; index--) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function frame(bytes: Uint8Array): Uint8Array {
  return concat(u32(bytes.length), bytes);
}

function framedText(value: string): Uint8Array {
  return frame(utf8(value));
}

function canonicalStrings<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function canonicalEpochs(values: Epoch[]): Epoch[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function canonicalCoveredEpochs(
  coveredEpochs: Record<NamespaceId, Epoch[]>,
): Array<[NamespaceId, Epoch[]]> {
  return Object.entries(coveredEpochs)
    .map(([namespaceId, epochs]) => [
      namespaceId,
      canonicalEpochs(epochs),
    ] as [NamespaceId, Epoch[]])
    .sort(([left], [right]) => left.localeCompare(right));
}

function stringSet(values: string[]): Uint8Array {
  const canonical = canonicalStrings(values);
  return concat(
    u32(canonical.length),
    ...canonical.map((value) => framedText(value)),
  );
}

/**
 * Canonical grant-signature payload v1.
 *
 * All integers are unsigned big-endian, all byte/text values are u32-framed,
 * set-like arrays are sorted and deduplicated, and namespace maps are encoded
 * as sorted entries. The domain tag and format version make future formats a
 * clean dispatch rather than an ambiguous reinterpretation.
 */
export function grantSigningBytes(grant: GrantSigningFields): Uint8Array {
  if (grant.formatVersion !== GRANT_FORMAT_VERSION) {
    throw new Error(`unsupported grant format ${String(grant.formatVersion)}`);
  }
  if (
    !validId(grant.id) ||
    !validId(grant.issuingDeviceId) ||
    !Array.isArray(grant.scope) ||
    grant.scope.length < 1 ||
    grant.scope.length > LATTICE_LIMITS.grantScope ||
    grant.scope.some((userId) => !validId(userId))
  ) {
    throw new RangeError("grant identifiers or scope exceed format limits");
  }
  if (
    !Array.isArray(grant.operations) ||
    grant.operations.length < 1 ||
    grant.operations.length > 2 ||
    grant.operations.some((operation) =>
      operation !== "decrypt" && operation !== "encrypt"
    )
  ) {
    throw new RangeError("grant operations are invalid");
  }
  if (
    !Number.isSafeInteger(grant.issuedAt) ||
    !Number.isSafeInteger(grant.expiresAt) ||
    grant.issuedAt < 0 ||
    grant.expiresAt <= grant.issuedAt ||
    grant.expiresAt - grant.issuedAt > LATTICE_LIMITS.grantTtlMs
  ) {
    throw new RangeError("grant timestamps are invalid");
  }
  if (
    !(grant.encryptedSecret instanceof Uint8Array) ||
    grant.encryptedSecret.length < 1 ||
    grant.encryptedSecret.length > LATTICE_LIMITS.grantSecretBytes ||
    !validId(grant.scheme, LATTICE_LIMITS.schemeIdBytes) ||
    typeof grant.singleUse !== "boolean"
  ) {
    throw new RangeError("grant secret, scheme, or flags are invalid");
  }
  if (
    grant.coveredEpochs === null ||
    typeof grant.coveredEpochs !== "object" ||
    Array.isArray(grant.coveredEpochs)
  ) {
    throw new RangeError("grant covered epochs must be an object");
  }
  const rawCovered = Object.entries(grant.coveredEpochs);
  if (rawCovered.length > LATTICE_LIMITS.coveredNamespaces) {
    throw new RangeError("grant exceeds the covered namespace limit");
  }
  for (const [namespaceId, epochs] of rawCovered) {
    if (
      !validId(namespaceId) ||
      !Array.isArray(epochs) ||
      epochs.length < 1 ||
      epochs.length > LATTICE_LIMITS.epochsPerNamespace ||
      epochs.some((epoch) => !Number.isSafeInteger(epoch) || epoch < 0)
    ) {
      throw new RangeError("grant covered epochs are invalid");
    }
  }
  const covered = canonicalCoveredEpochs(grant.coveredEpochs);
  let totalEpochs = 0;
  for (const [namespaceId, epochs] of covered) {
    if (
      !validId(namespaceId) ||
      epochs.length < 1 ||
      epochs.length > LATTICE_LIMITS.epochsPerNamespace ||
      epochs.some((epoch) => !Number.isSafeInteger(epoch) || epoch < 0)
    ) {
      throw new RangeError("grant covered epochs are invalid");
    }
    totalEpochs += epochs.length;
    if (totalEpochs > LATTICE_LIMITS.totalGrantEpochs) {
      throw new RangeError("grant exceeds the total epoch limit");
    }
  }
  const coveredBytes = covered.map(([namespaceId, epochs]) =>
    concat(
      framedText(namespaceId),
      u32(epochs.length),
      ...epochs.map((epoch) => u64(epoch)),
    )
  );
  return concat(
    frame(SIGNING_DOMAIN),
    u32(grant.formatVersion),
    framedText(grant.id),
    framedText(grant.issuingDeviceId),
    stringSet(grant.scope),
    stringSet(grant.operations),
    u64(grant.issuedAt),
    u64(grant.expiresAt),
    u32(covered.length),
    ...coveredBytes,
    frame(grant.encryptedSecret),
    framedText(grant.scheme),
    new Uint8Array([grant.singleUse ? 1 : 0]),
  );
}

/** Canonical capability wire bytes. Consumption is server-side mutable state
 * and is deliberately not transported or signed. */
export function serializeGrant(grant: Grant): Uint8Array {
  if (
    !(grant.signature instanceof Uint8Array) ||
    grant.signature.length !== LATTICE_LIMITS.signatureBytes
  ) {
    throw new RangeError("grant signature has an invalid length");
  }
  const wire = concat(grantSigningBytes(grant), frame(grant.signature));
  if (wire.length > LATTICE_LIMITS.grantWireBytes) {
    throw new RangeError("grant wire bytes exceed the limit");
  }
  return wire;
}

class Cursor {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset === this.bytes.length;
  }

  u8(): number {
    if (this.offset >= this.bytes.length) throw new Error("truncated u8");
    return this.bytes[this.offset++]!;
  }

  u32(): number {
    if (this.bytes.length - this.offset < 4) throw new Error("truncated u32");
    const value =
      ((this.bytes[this.offset]! * 0x1000000) +
        (this.bytes[this.offset + 1]! << 16) +
        (this.bytes[this.offset + 2]! << 8) +
        this.bytes[this.offset + 3]!) >>> 0;
    this.offset += 4;
    return value;
  }

  u64(): number {
    if (this.bytes.length - this.offset < 8) throw new Error("truncated u64");
    let value = 0n;
    for (let index = 0; index < 8; index++) {
      value = (value << 8n) | BigInt(this.bytes[this.offset + index]!);
    }
    this.offset += 8;
    if (value > MAX_SAFE_BIGINT) throw new Error("u64 exceeds safe integer range");
    return Number(value);
  }

  frame(): Uint8Array {
    const length = this.u32();
    if (length > this.bytes.length - this.offset) {
      throw new Error("truncated frame");
    }
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  text(): string {
    return decoder.decode(this.frame());
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function validId(
  value: string,
  maximum: number = LATTICE_LIMITS.idBytes,
): boolean {
  return (
    ID_PATTERN.test(value) &&
    utf8(value).length <= maximum
  );
}

/**
 * Parse only canonical v1 wire bytes. Malformed, truncated, non-canonical, or
 * unknown-version input returns null and never escapes a parser exception.
 */
export function parseGrant(bytes: Uint8Array): Grant | null {
  try {
    if (bytes.length > LATTICE_LIMITS.grantWireBytes) return null;
    const cursor = new Cursor(bytes);
    if (!equalBytes(cursor.frame(), SIGNING_DOMAIN)) return null;
    const formatVersion = cursor.u32();
    if (formatVersion !== GRANT_FORMAT_VERSION) return null;
    const id = cursor.text();
    const issuingDeviceId = cursor.text();
    if (!validId(id) || !validId(issuingDeviceId)) return null;

    const scope: UserId[] = [];
    const scopeLength = cursor.u32();
    if (scopeLength < 1 || scopeLength > LATTICE_LIMITS.grantScope) return null;
    for (let index = 0; index < scopeLength; index++) scope.push(cursor.text());
    if (scope.some((userId) => !validId(userId))) return null;

    const operations: GrantOperation[] = [];
    const operationLength = cursor.u32();
    if (operationLength < 1 || operationLength > 2) return null;
    for (let index = 0; index < operationLength; index++) {
      operations.push(cursor.text() as GrantOperation);
    }
    if (operations.some((operation) =>
      operation !== "decrypt" && operation !== "encrypt"
    )) return null;

    const issuedAt = cursor.u64();
    const expiresAt = cursor.u64();
    if (
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > LATTICE_LIMITS.grantTtlMs
    ) return null;
    const coveredEpochs: Record<NamespaceId, Epoch[]> = {};
    const namespaceLength = cursor.u32();
    if (
      namespaceLength > LATTICE_LIMITS.coveredNamespaces
    ) return null;
    let totalEpochs = 0;
    for (let index = 0; index < namespaceLength; index++) {
      const namespaceId = cursor.text();
      if (!validId(namespaceId)) return null;
      const epochLength = cursor.u32();
      if (
        epochLength < 1 ||
        epochLength > LATTICE_LIMITS.epochsPerNamespace
      ) return null;
      totalEpochs += epochLength;
      if (totalEpochs > LATTICE_LIMITS.totalGrantEpochs) return null;
      const epochs: Epoch[] = [];
      for (let epochIndex = 0; epochIndex < epochLength; epochIndex++) {
        epochs.push(cursor.u64());
      }
      coveredEpochs[namespaceId] = epochs;
    }

    const encryptedSecret = cursor.frame();
    if (
      encryptedSecret.length < 1 ||
      encryptedSecret.length > LATTICE_LIMITS.grantSecretBytes
    ) return null;
    const scheme = cursor.text();
    if (!validId(scheme, LATTICE_LIMITS.schemeIdBytes)) return null;
    const singleUseByte = cursor.u8();
    if (singleUseByte !== 0 && singleUseByte !== 1) return null;
    const signature = cursor.frame();
    if (signature.length !== LATTICE_LIMITS.signatureBytes) return null;
    if (!cursor.done) return null;

    const grant: Grant = {
      formatVersion,
      id,
      issuingDeviceId,
      scope,
      operations,
      issuedAt,
      expiresAt,
      coveredEpochs,
      encryptedSecret,
      scheme,
      signature,
      singleUse: singleUseByte === 1,
      consumed: false,
    };
    return equalBytes(serializeGrant(grant), bytes) ? grant : null;
  } catch {
    return null;
  }
}
