const MAX_U32 = 0xffff_ffff;
const MAX_SAFE_U64 = BigInt(Number.MAX_SAFE_INTEGER);
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

const utf8Encoder = new TextEncoder();
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const unpairedSurrogate =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export class CanonicalEncodingError extends RangeError {
  override readonly name = "CanonicalEncodingError";
}

export class CanonicalDecodingError extends Error {
  override readonly name = "CanonicalDecodingError";
}

export function concatV2(...parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function encodeU32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_U32) {
    throw new CanonicalEncodingError(
      "u32 value must be an unsigned 32-bit integer",
    );
  }
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

export function encodeU64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CanonicalEncodingError(
      "u64 value must be a non-negative safe integer",
    );
  }
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, BigInt(value));
  return output;
}

export function utf8V2(value: string): Uint8Array {
  if (unpairedSurrogate.test(value)) {
    throw new CanonicalEncodingError(
      "text contains an unpaired UTF-16 surrogate",
    );
  }
  return utf8Encoder.encode(value);
}

export function frame(bytes: Uint8Array): Uint8Array {
  const lengthPrefix = encodeU32(bytes.length);
  return concatV2(lengthPrefix, bytes);
}

export function frameText(value: string): Uint8Array {
  return frame(utf8V2(value));
}

export class StrictDecoder {
  private offset = 0;
  private readonly bytes: Uint8Array;
  private readonly extractedFrames: Uint8Array[] = [];
  private destroyed = false;

  constructor(bytes: Uint8Array) {
    this.bytes = copyOwnedBytesV2(bytes);
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  readU32(): number {
    if (this.remaining < 4) {
      throw new CanonicalDecodingError("truncated u32");
    }
    const value =
      this.bytes[this.offset]! * 0x100_0000 +
      (this.bytes[this.offset + 1]! << 16) +
      (this.bytes[this.offset + 2]! << 8) +
      this.bytes[this.offset + 3]!;
    this.offset += 4;
    return value;
  }

  readU64(): number {
    if (this.remaining < 8) {
      throw new CanonicalDecodingError("truncated u64");
    }
    let value = 0n;
    for (let index = 0; index < 8; index++) {
      value = (value << 8n) | BigInt(this.bytes[this.offset + index]!);
    }
    this.offset += 8;
    if (value > MAX_SAFE_U64) {
      throw new CanonicalDecodingError(
        "u64 exceeds the TypeScript safe integer range",
      );
    }
    return Number(value);
  }

  readCount(maximum: number): number {
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_U32) {
      throw new TypeError("count maximum must fit u32");
    }
    const count = this.readU32();
    if (count > maximum) {
      throw new CanonicalDecodingError(
        `count exceeds the ${maximum} limit`,
      );
    }
    return count;
  }

  readVersion(expected: number): number {
    const actual = this.readU32();
    if (actual !== expected) {
      throw new CanonicalDecodingError(
        `unsupported version ${actual}; expected ${expected}`,
      );
    }
    return actual;
  }

  readFrame(maximumBytes: number): Uint8Array {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 0 ||
      maximumBytes > MAX_U32
    ) {
      throw new TypeError("frame maximum must fit u32");
    }
    const length = this.readU32();
    if (length > maximumBytes) {
      throw new CanonicalDecodingError(
        `frame length exceeds the ${maximumBytes}-byte limit`,
      );
    }
    if (length > this.remaining) {
      throw new CanonicalDecodingError("truncated frame");
    }
    const output = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    this.extractedFrames.push(output);
    return output;
  }

  readText(maximumBytes: number): string {
    const bytes = this.readFrame(maximumBytes);
    try {
      let value: string;
      try {
        value = strictUtf8Decoder.decode(bytes);
      } catch {
        throw new CanonicalDecodingError("invalid UTF-8 text");
      }
      const canonical = utf8V2(value);
      if (canonical.length !== bytes.length) {
        throw new CanonicalDecodingError("noncanonical UTF-8 text");
      }
      return value;
    } finally {
      bytes.fill(0);
    }
  }

  assertFinished(): void {
    if (this.remaining !== 0) {
      throw new CanonicalDecodingError(
        `trailing bytes (${this.remaining})`,
      );
    }
  }

  /**
   * Explicitly end the decoder's owned-byte lifetime. Failed decodes also wipe
   * every raw frame extracted before the failure; successful callers retain
   * the frames they intentionally returned.
   */
  destroy(wipeExtractedFrames = false): void {
    if (this.destroyed) return;
    if (wipeExtractedFrames) {
      this.extractedFrames.forEach((value) => value.fill(0));
    }
    this.bytes.fill(0);
    this.destroyed = true;
  }
}

export function decodeExact<T>(
  bytes: Uint8Array,
  decode: (reader: StrictDecoder) => T,
): T {
  const reader = new StrictDecoder(bytes);
  let succeeded = false;
  try {
    const value = decode(reader);
    reader.assertFinished();
    succeeded = true;
    return value;
  } finally {
    reader.destroy(!succeeded);
  }
}
