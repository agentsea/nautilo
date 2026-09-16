import { LATTICE_LIMITS } from "@nautilo/lattice-crypto";
import { productIdIsValid } from "../identity/product-ids.ts";

const JOURNAL_PAYLOAD_MAX_BYTES = LATTICE_LIMITS.plaintextBytes;
const JOURNAL_PRODUCT_TEXT_MAX_BYTES = 256;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const PORTABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;

export function ownRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertExactFields(
  label: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedFields = new Set(allowed);
  for (const field of Reflect.ownKeys(value)) {
    if (typeof field !== "string") {
      throw new TypeError(`${label} contains a symbol field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      throw new TypeError(`${label} contains a non-data field ${field}`);
    }
    if (!allowedFields.has(field)) {
      throw new TypeError(`${label} contains unknown field ${field}`);
    }
  }
}

export function assertRequiredFields(
  label: string,
  value: Record<string, unknown>,
  required: readonly string[],
): void {
  for (const field of required) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      throw new TypeError(`${label} is missing required data field ${field}`);
    }
  }
}

function assertWellFormedUnicode(label: string, value: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) {
        throw new TypeError(`${label} contains malformed Unicode`);
      }
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`${label} contains malformed Unicode`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} contains malformed Unicode`);
    }
  }
}

function codePointLength(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

export function boundedText(
  label: string,
  value: unknown,
  limits: Readonly<{
    maximumCodePoints: number;
    maximumBytes: number;
  }>,
): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be text`);
  }
  assertWellFormedUnicode(label, value);
  const bytes = textEncoder.encode(value).length;
  if (
    bytes < 1
    || bytes > limits.maximumBytes
    || codePointLength(value) > limits.maximumCodePoints
  ) {
    throw new RangeError(`${label} is out of bounds`);
  }
  return value;
}

export function canonicalUuid(label: string, value: unknown): string {
  if (!productIdIsValid(value)) {
    throw new TypeError(`${label} must be a canonical lowercase UUID`);
  }
  return value;
}

export function nullableCanonicalUuid(
  label: string,
  value: unknown,
): string | null {
  if (value === null) return null;
  return canonicalUuid(label, value);
}

export function portableIdentifier(
  label: string,
  value: unknown,
): string {
  const normalized = boundedText(label, value, {
    maximumCodePoints: JOURNAL_PRODUCT_TEXT_MAX_BYTES,
    maximumBytes: JOURNAL_PRODUCT_TEXT_MAX_BYTES,
  });
  if (!PORTABLE_ID_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
  return normalized;
}

export function postgresInteger(
  label: string,
  value: unknown,
  minimum: 0 | 1,
): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > POSTGRES_INTEGER_MAX
  ) {
    throw new RangeError(
      `${label} must be an integer from ${minimum} to ${POSTGRES_INTEGER_MAX}`,
    );
  }
  return value as number;
}

export function canonicalTimestamp(
  label: string,
  value: unknown,
): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a canonical timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be a canonical timestamp`);
  }
  return value;
}

export function denseArray(
  label: string,
  value: unknown,
  minimumItems: number,
  maximumItems: number,
): readonly unknown[] {
  if (
    !Array.isArray(value)
    || value.length < minimumItems
    || value.length > maximumItems
  ) {
    throw new RangeError(`${label} is out of bounds`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (
      key === "length"
      || (
        typeof key === "string"
        && /^(?:0|[1-9][0-9]*)$/u.test(key)
        && Number(key) < value.length
      )
    ) {
      continue;
    }
    throw new TypeError(`${label} contains an extra field`);
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`${label} must not contain holes`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      throw new TypeError(`${label} contains a non-data item`);
    }
  }
  return value;
}

interface CanonicalObject {
  readonly [key: string]: CanonicalValue;
}

type CanonicalArray = readonly CanonicalValue[];

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalArray
  | CanonicalObject;

function canonicalJson(value: CanonicalValue): string {
  if (value === null) return "null";
  if (
    typeof value === "boolean"
    || typeof value === "number"
    || typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Readonly<Record<string, CanonicalValue>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(",")}}`;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export function encodeCanonicalJournalPayload(
  label: string,
  value: Readonly<object>,
): Uint8Array {
  const bytes = textEncoder.encode(
    canonicalJson(value as unknown as CanonicalObject),
  );
  if (bytes.length < 1 || bytes.length > JOURNAL_PAYLOAD_MAX_BYTES) {
    throw new RangeError(`${label} bytes are out of bounds`);
  }
  return bytes;
}

export function parseCanonicalJournalPayload(
  label: string,
  bytes: Uint8Array,
): Record<string, unknown> {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length < 1
    || bytes.length > JOURNAL_PAYLOAD_MAX_BYTES
  ) {
    throw new RangeError(`${label} bytes are out of bounds`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(bytes));
  } catch {
    throw new TypeError(`${label} JSON is malformed`);
  }
  if (!ownRecord(parsed)) {
    throw new TypeError(`${label} must be an object`);
  }
  return parsed;
}

export function assertCanonicalJournalPayload(
  label: string,
  bytes: Uint8Array,
  expected: Uint8Array,
): void {
  if (!bytesEqual(bytes, expected)) {
    throw new TypeError(`${label} encoding is not canonical`);
  }
}
