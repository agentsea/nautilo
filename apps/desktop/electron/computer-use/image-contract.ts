/**
 * Bounded PNG structural contract shared by Desktop vision producers.
 *
 * This deliberately validates only already-bounded bytes. It does not decode
 * image data or allocate from image dimensions.
 */

/**
 * Maximum decoded Desktop vision PNG retained for one observation.
 *
 * Cua's qualified macOS desktop capture on this hardware is 3024x1964: an
 * uncompressed 8-bit RGBA pixel plane is about 23.8 MB before PNG framing.
 * 32 MiB keeps that real capture inside the contract even when the pixels do
 * not compress well. The PNG travels from Cua through a private owned file,
 * not through the 1 MiB JSON control frame.
 */
export const DESKTOP_VISION_PNG_MAX_BYTES = 32 * 1024 * 1024;

export type PngDimensions = Readonly<{ width: number; height: number }>;

/** Content-free failure: callers must not reflect untrusted PNG data. */
export type PngDimensionsFailure = Readonly<{ kind: "invalid_png" }>;

export type PngDimensionsResult = PngDimensions | PngDimensionsFailure;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const IHDR_TYPE = [0x49, 0x48, 0x44, 0x52] as const;
const PLTE_TYPE = [0x50, 0x4c, 0x54, 0x45] as const;
const IDAT_TYPE = [0x49, 0x44, 0x41, 0x54] as const;
const IEND_TYPE = [0x49, 0x45, 0x4e, 0x44] as const;
const INVALID_PNG: PngDimensionsFailure = Object.freeze({ kind: "invalid_png" });

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ 0xedb88320;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function hasBytesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset < 0 || expected.length > bytes.length - offset) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function crc32Chunk(bytes: Uint8Array, typeOffset: number, dataLength: number): number {
  let crc = 0xffffffff;
  const end = typeOffset + 4 + dataLength;
  for (let offset = typeOffset; offset < end; offset += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[offset]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isAsciiLetter(value: number | undefined): boolean {
  return value !== undefined && (
    (value >= 0x41 && value <= 0x5a) ||
    (value >= 0x61 && value <= 0x7a)
  );
}

function hasValidChunkType(bytes: Uint8Array, typeOffset: number): boolean {
  const first = bytes[typeOffset];
  const second = bytes[typeOffset + 1];
  const third = bytes[typeOffset + 2];
  const fourth = bytes[typeOffset + 3];
  return isAsciiLetter(first) && isAsciiLetter(second) && isAsciiLetter(third) && isAsciiLetter(fourth) &&
    third !== undefined && third >= 0x41 && third <= 0x5a;
}

function isKnownCriticalChunk(bytes: Uint8Array, typeOffset: number): boolean {
  return hasBytesAt(bytes, typeOffset, IHDR_TYPE) ||
    hasBytesAt(bytes, typeOffset, PLTE_TYPE) ||
    hasBytesAt(bytes, typeOffset, IDAT_TYPE) ||
    hasBytesAt(bytes, typeOffset, IEND_TYPE);
}

function hasLegalBitDepthForColorType(bitDepth: number | undefined, colorType: number | undefined): boolean {
  if (bitDepth === undefined || colorType === undefined) return false;
  switch (colorType) {
    case 0: return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8 || bitDepth === 16;
    case 2:
    case 4:
    case 6: return bitDepth === 8 || bitDepth === 16;
    case 3: return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8;
    default: return false;
  }
}

/**
 * Parses dimensions from a structurally valid PNG within the Desktop vision
 * byte cap. It never decodes pixel data.
 */
export function parseBoundedPngDimensions(bytes: Uint8Array): PngDimensionsResult {
  if (bytes.length > DESKTOP_VISION_PNG_MAX_BYTES) return INVALID_PNG;
  if (!hasBytesAt(bytes, 0, PNG_SIGNATURE)) return INVALID_PNG;

  let offset: number = PNG_SIGNATURE.length;
  let sawIhdr = false;
  let colorType: number | undefined;
  let bitDepth: number | undefined;
  let sawPlte = false;
  let sawIdat = false;
  let closedIdat = false;
  while (offset < bytes.length) {
    // Four length bytes, four type bytes, and four CRC bytes are mandatory.
    if (bytes.length - offset < 12) return INVALID_PNG;

    const dataLength = readUint32(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    // Compare before constructing an end offset from attacker-controlled data.
    if (dataLength > bytes.length - dataOffset - 4) return INVALID_PNG;
    const crcOffset = dataOffset + dataLength;
    const nextOffset = crcOffset + 4;

    if (!hasValidChunkType(bytes, typeOffset)) return INVALID_PNG;
    const isIhdr = hasBytesAt(bytes, typeOffset, IHDR_TYPE);
    const isPlte = hasBytesAt(bytes, typeOffset, PLTE_TYPE);
    const isIdat = hasBytesAt(bytes, typeOffset, IDAT_TYPE);
    const isIend = hasBytesAt(bytes, typeOffset, IEND_TYPE);
    // The first (critical) type byte being uppercase makes this critical.
    if (bytes[typeOffset]! <= 0x5a && !isKnownCriticalChunk(bytes, typeOffset)) return INVALID_PNG;

    if (crc32Chunk(bytes, typeOffset, dataLength) !== readUint32(bytes, crcOffset)) {
      return INVALID_PNG;
    }

    if (!sawIhdr) {
      if (!isIhdr || dataLength !== 13) return INVALID_PNG;
      const width = readUint32(bytes, dataOffset);
      const height = readUint32(bytes, dataOffset + 4);
      // Uint32 parsing yields safe integers; zero is disallowed by the PNG spec.
      if (width <= 0 || height <= 0) return INVALID_PNG;
      if (!hasLegalBitDepthForColorType(bytes[dataOffset + 8], bytes[dataOffset + 9])) return INVALID_PNG;
      if (bytes[dataOffset + 10] !== 0 || bytes[dataOffset + 11] !== 0) return INVALID_PNG;
      if (bytes[dataOffset + 12] !== 0 && bytes[dataOffset + 12] !== 1) return INVALID_PNG;
      bitDepth = bytes[dataOffset + 8];
      colorType = bytes[dataOffset + 9];
      sawIhdr = true;
    } else if (isIhdr) {
      return INVALID_PNG;
    }

    if (sawIdat && !isIdat) closedIdat = true;
    if (isPlte) {
      if (sawPlte || sawIdat || colorType === 0 || colorType === 4) return INVALID_PNG;
      if (dataLength === 0 || dataLength % 3 !== 0 || dataLength > 768) return INVALID_PNG;
      if (colorType === 3 && (bitDepth === undefined || dataLength / 3 > 2 ** bitDepth)) return INVALID_PNG;
      sawPlte = true;
    }
    if (isIdat) {
      if (closedIdat || (colorType === 3 && !sawPlte)) return INVALID_PNG;
      sawIdat = true;
    }

    if (isIend) {
      if (dataLength !== 0 || nextOffset !== bytes.length || !sawIdat) return INVALID_PNG;
      return {
        width: readUint32(bytes, PNG_SIGNATURE.length + 8),
        height: readUint32(bytes, PNG_SIGNATURE.length + 12),
      };
    }
    offset = nextOffset;
  }
  return INVALID_PNG;
}
