const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Admit self-contained raster sources by declared MIME and basic decoded header.
 * This deliberately does not claim complete decoding, codec validity, or safe dimensions.
 */
export function normalizeEmbeddedRasterDataUrl(source: string): string | null {
  const match = /^data:image\/(png|jpeg|gif);base64,([A-Za-z0-9+/=]+)$/i.exec(source);
  if (!match || !BASE64.test(match[2]!) || match[2]!.length === 0 || !hasCanonicalPaddingBits(match[2]!)) return null;

  const mime = match[1]!.toLowerCase();
  const payload = match[2]!;
  const header = decodeBase64Prefix(payload, mime === "png" ? 24 : 10);
  if (!header || !hasExpectedHeader(mime, header)) return null;
  return `data:image/${mime};base64,${payload}`;
}

function hasCanonicalPaddingBits(payload: string): boolean {
  if (payload.endsWith("==")) return BASE64_ALPHABET.indexOf(payload[payload.length - 3]!) % 16 === 0;
  if (payload.endsWith("=")) return BASE64_ALPHABET.indexOf(payload[payload.length - 2]!) % 4 === 0;
  return true;
}

function hasExpectedHeader(mime: string, bytes: readonly number[]): boolean {
  if (mime === "png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= 24 && signature.every((byte, index) => bytes[index] === byte) &&
      bytes[8] === 0 && bytes[9] === 0 && bytes[10] === 0 && bytes[11] === 13 &&
      bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52 &&
      readUint32(bytes, 16) > 0 && readUint32(bytes, 20) > 0;
  }
  if (mime === "jpeg") {
    return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
      bytes[3] !== 0x00 && bytes[3] !== 0xff;
  }
  const header = String.fromCharCode(...bytes.slice(0, 6));
  return bytes.length >= 10 && (header === "GIF87a" || header === "GIF89a") &&
    (bytes[6]! | (bytes[7]! << 8)) > 0 && (bytes[8]! | (bytes[9]! << 8)) > 0;
}

function decodeBase64Prefix(payload: string, byteLimit: number): number[] | null {
  const output: number[] = [];
  for (let index = 0; index < payload.length && output.length < byteLimit; index += 4) {
    const quartet = payload.slice(index, index + 4);
    const values = [...quartet].map((character) => character === "=" ? 0 : BASE64_ALPHABET.indexOf(character));
    if (values.some((value) => value < 0)) return null;
    const bits = (values[0]! << 18) | (values[1]! << 12) | (values[2]! << 6) | values[3]!;
    output.push((bits >>> 16) & 0xff);
    if (quartet[2] !== "=" && output.length < byteLimit) output.push((bits >>> 8) & 0xff);
    if (quartet[3] !== "=" && output.length < byteLimit) output.push(bits & 0xff);
  }
  return output;
}

function readUint32(bytes: readonly number[], offset: number): number {
  return (((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) + bytes[offset + 3]!) >>> 0;
}
