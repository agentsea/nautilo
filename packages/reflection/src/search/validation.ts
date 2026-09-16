import { RECORD_SEARCH_POLICY_V1 } from "./policy";

const PORTABLE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;

/** Strict UTF-8 length; unpaired UTF-16 surrogates are rejected, not replaced. */
export function strictUtf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        throw new TypeError("text contains an unpaired high surrogate");
      }
      bytes += 4;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("text contains an unpaired low surrogate");
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function assertPortableRecordSearchIdentifier(
  label: string,
  value: string,
  maximumBytes = RECORD_SEARCH_POLICY_V1.referenceIdentifierMaximumUtf8Bytes,
): void {
  const bytes = strictUtf8ByteLength(value);
  if (bytes < 1 || bytes > maximumBytes || !PORTABLE_IDENTIFIER.test(value)) {
    throw new TypeError(`${label} must be a bounded portable identifier`);
  }
}

export function assertPortableRecordSearchText(
  label: string,
  value: string,
  minimumBytes: number,
  maximumBytes: number,
): void {
  const bytes = strictUtf8ByteLength(value);
  if (
    bytes < minimumBytes
    || bytes > maximumBytes
    || !PORTABLE_IDENTIFIER.test(value)
  ) {
    throw new TypeError(`${label} must be bounded portable text`);
  }
}

export function assertPositiveSafeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

export function assertOpaqueCommitment(label: string, value: string): void {
  assertPortableRecordSearchIdentifier(label, value);
}
