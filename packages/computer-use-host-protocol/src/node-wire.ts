import { createHash } from "node:crypto";
import {
  COMPUTER_USE_HOST_CONTROL_MAX_BYTES,
  COMPUTER_USE_HOST_PNG_MAX_BYTES,
  ComputerUseHostProtocolError,
  stringifyCanonicalComputerUseJson,
  parseComputerUseHostAttachmentMetadata,
  parseComputerUseHostControlMessage,
  type ComputerUseHostAttachmentMetadata,
  type ComputerUseHostControlMessage,
} from "./protocol.js";

export type ComputerUseHostPngAttachment = Readonly<{
  metadata: ComputerUseHostAttachmentMetadata;
  bytes: Uint8Array;
}>;

function fail(code: ComputerUseHostProtocolError["code"]): never {
  throw new ComputerUseHostProtocolError(code);
}

type ObjectScanFrame = {
  readonly kind: "object";
  readonly keys: Set<string>;
  state: "keyOrEnd" | "key" | "colon" | "value" | "commaOrEnd";
};
type ArrayScanFrame = {
  readonly kind: "array";
  state: "valueOrEnd" | "value" | "commaOrEnd";
};
type JsonScanFrame = ObjectScanFrame | ArrayScanFrame;

/**
 * Validates JSON syntax and rejects duplicate decoded object keys before
 * JSON.parse can collapse them. Its memory is bounded by the reviewed frame
 * byte ceiling; it adds no separate depth or node-count policy.
 */
function hasUniqueJsonObjectKeys(raw: string): boolean {
  let offset = 0;
  const frames: JsonScanFrame[] = [];
  const primitive = /(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
  const whitespace = (): void => {
    while (offset < raw.length && /[\t\n\r ]/.test(raw[offset] ?? "")) offset += 1;
  };
  const readString = (decode: boolean): string | null => {
    if (raw[offset] !== "\"") return null;
    const start = offset;
    offset += 1;
    while (offset < raw.length) {
      const character = raw[offset];
      offset += 1;
      if (character === "\"") {
        if (!decode) return "";
        try {
          const value: unknown = JSON.parse(raw.slice(start, offset));
          return typeof value === "string" ? value : null;
        } catch {
          return null;
        }
      }
      if (character === "\\") {
        if (offset >= raw.length) return null;
        const escape = raw[offset];
        offset += 1;
        if (escape === "u") {
          const digits = raw.slice(offset, offset + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) return null;
          offset += 4;
        } else if (!"\"\\/bfnrt".includes(escape ?? "")) {
          return null;
        }
      } else if (character !== undefined && character.charCodeAt(0) < 0x20) {
        return null;
      }
    }
    return null;
  };
  const pushValue = (): boolean => {
    const character = raw[offset];
    if (character === "\"") return readString(false) !== null;
    if (character === "{") {
      offset += 1;
      frames.push({ kind: "object", keys: new Set(), state: "keyOrEnd" });
      return true;
    }
    if (character === "[") {
      offset += 1;
      frames.push({ kind: "array", state: "valueOrEnd" });
      return true;
    }
    primitive.lastIndex = offset;
    const match = primitive.exec(raw);
    if (match === null) return false;
    offset = primitive.lastIndex;
    return true;
  };

  whitespace();
  if (raw[offset] !== "{") return false;
  offset += 1;
  frames.push({ kind: "object", keys: new Set(), state: "keyOrEnd" });
  while (frames.length > 0) {
    whitespace();
    const frame = frames[frames.length - 1];
    if (frame === undefined) return false;
    if (frame.kind === "object") {
      if (frame.state === "keyOrEnd") {
        if (raw[offset] === "}") {
          offset += 1;
          frames.pop();
          continue;
        }
        frame.state = "key";
      }
      if (frame.state === "key") {
        const key = readString(true);
        if (key === null || frame.keys.has(key)) return false;
        frame.keys.add(key);
        frame.state = "colon";
        continue;
      }
      if (frame.state === "colon") {
        if (raw[offset] !== ":") return false;
        offset += 1;
        frame.state = "value";
        continue;
      }
      if (frame.state === "value") {
        frame.state = "commaOrEnd";
        if (!pushValue()) return false;
        continue;
      }
      if (raw[offset] === ",") {
        offset += 1;
        frame.state = "key";
        continue;
      }
      if (raw[offset] === "}") {
        offset += 1;
        frames.pop();
        continue;
      }
      return false;
    }
    if (frame.state === "valueOrEnd") {
      if (raw[offset] === "]") {
        offset += 1;
        frames.pop();
        continue;
      }
      frame.state = "value";
    }
    if (frame.state === "value") {
      frame.state = "commaOrEnd";
      if (!pushValue()) return false;
      continue;
    }
    if (raw[offset] === ",") {
      offset += 1;
      frame.state = "value";
      continue;
    }
    if (raw[offset] === "]") {
      offset += 1;
      frames.pop();
      continue;
    }
    return false;
  }
  whitespace();
  return offset === raw.length;
}

function parseJsonObjectBytes(bytes: Uint8Array, code: "invalid_message" | "invalid_attachment"): unknown {
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!hasUniqueJsonObjectKeys(raw)) return fail(code);
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof ComputerUseHostProtocolError) throw error;
    return fail(code);
  }
}

function frameLength(prefix: Uint8Array): number {
  return new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(0, false);
}

function decodeControlBody(body: Uint8Array): ComputerUseHostControlMessage {
  return parseComputerUseHostControlMessage(parseJsonObjectBytes(body, "invalid_message"));
}

/** Node/host-only inherited-pipe frame writer. */
export function encodeControlFrame(message: ComputerUseHostControlMessage): Uint8Array {
  const body = new TextEncoder().encode(stringifyCanonicalComputerUseJson(parseComputerUseHostControlMessage(message)));
  if (body.length > COMPUTER_USE_HOST_CONTROL_MAX_BYTES) fail("frame_too_large");
  const frame = new Uint8Array(body.length + 4);
  new DataView(frame.buffer).setUint32(0, body.length, false);
  frame.set(body, 4);
  return frame;
}

export function decodeControlFrame(frame: Uint8Array): ComputerUseHostControlMessage {
  if (frame.length < 4) fail("invalid_frame");
  const length = frameLength(frame.subarray(0, 4));
  if (length > COMPUTER_USE_HOST_CONTROL_MAX_BYTES) fail("frame_too_large");
  if (frame.length !== length + 4) fail("invalid_frame");
  return decodeControlBody(frame.subarray(4));
}

/**
 * Incremental decoder that allocates a body only after its complete, valid
 * four-byte prefix has been checked. Each byte is copied once.
 */
export class ControlFrameDecoder {
  readonly #prefix = new Uint8Array(4);
  #prefixOffset = 0;
  #body: Uint8Array | undefined;
  #bodyOffset = 0;

  push(chunk: Uint8Array): ComputerUseHostControlMessage[] {
    const output: ComputerUseHostControlMessage[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#body === undefined) {
        const prefixBytes = Math.min(4 - this.#prefixOffset, chunk.length - offset);
        this.#prefix.set(chunk.subarray(offset, offset + prefixBytes), this.#prefixOffset);
        this.#prefixOffset += prefixBytes;
        offset += prefixBytes;
        if (this.#prefixOffset < 4) break;
        const length = frameLength(this.#prefix);
        if (length > COMPUTER_USE_HOST_CONTROL_MAX_BYTES) fail("frame_too_large");
        this.#body = new Uint8Array(length);
        this.#bodyOffset = 0;
      }
      const bodyBytes = Math.min(this.#body.length - this.#bodyOffset, chunk.length - offset);
      this.#body.set(chunk.subarray(offset, offset + bodyBytes), this.#bodyOffset);
      this.#bodyOffset += bodyBytes;
      offset += bodyBytes;
      if (this.#bodyOffset === this.#body.length) {
        output.push(decodeControlBody(this.#body));
        this.#body = undefined;
        this.#bodyOffset = 0;
        this.#prefixOffset = 0;
      }
    }
    return output;
  }

  finish(): void {
    if (this.#prefixOffset !== 0 || this.#body !== undefined) fail("invalid_frame");
  }
}

function parseAttachmentMetadata(bytes: Uint8Array): ComputerUseHostAttachmentMetadata {
  try {
    const metadata = parseComputerUseHostAttachmentMetadata(
      parseJsonObjectBytes(bytes, "invalid_attachment"),
    );
    if (metadata.byteLength > COMPUTER_USE_HOST_PNG_MAX_BYTES) fail("invalid_attachment");
    return metadata;
  } catch (error) {
    if (error instanceof ComputerUseHostProtocolError && error.code === "frame_too_large") throw error;
    return fail("invalid_attachment");
  }
}

export function parsePngAttachment(
  metadataValue: unknown,
  bytes: Uint8Array,
): ComputerUseHostPngAttachment {
  let metadata: ComputerUseHostAttachmentMetadata;
  try {
    metadata = parseComputerUseHostAttachmentMetadata(metadataValue);
  } catch {
    return fail("invalid_attachment");
  }
  if (
    metadata.byteLength > COMPUTER_USE_HOST_PNG_MAX_BYTES
    || bytes.length !== metadata.byteLength
    || createHash("sha256").update(bytes).digest("hex") !== metadata.sha256
  ) {
    fail("invalid_attachment");
  }
  const dimensions = parsePngDimensions(bytes);
  if (dimensions.width !== metadata.width || dimensions.height !== metadata.height) {
    fail("invalid_attachment");
  }
  return { metadata, bytes };
}

/** Attachment metadata is length-framed, followed by exactly its PNG bytes. */
export function encodePngAttachmentFrame(metadataValue: unknown, bytes: Uint8Array): Uint8Array {
  const attachment = parsePngAttachment(metadataValue, bytes);
  const encoded = new TextEncoder().encode(stringifyCanonicalComputerUseJson(attachment.metadata));
  if (encoded.length > COMPUTER_USE_HOST_CONTROL_MAX_BYTES) fail("frame_too_large");
  const frame = new Uint8Array(4 + encoded.length + bytes.length);
  new DataView(frame.buffer).setUint32(0, encoded.length, false);
  frame.set(encoded, 4);
  frame.set(bytes, 4 + encoded.length);
  return frame;
}

/** Independently framed attachments can be interleaved by request identity. */
export class AttachmentFrameDecoder {
  readonly #prefix = new Uint8Array(4);
  #prefixOffset = 0;
  #metadataBody: Uint8Array | undefined;
  #metadataOffset = 0;
  #metadata: ComputerUseHostAttachmentMetadata | undefined;
  #png: Uint8Array | undefined;
  #pngOffset = 0;

  push(chunk: Uint8Array): ComputerUseHostPngAttachment[] {
    const output: ComputerUseHostPngAttachment[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#metadata === undefined && this.#metadataBody === undefined) {
        const prefixBytes = Math.min(4 - this.#prefixOffset, chunk.length - offset);
        this.#prefix.set(chunk.subarray(offset, offset + prefixBytes), this.#prefixOffset);
        this.#prefixOffset += prefixBytes;
        offset += prefixBytes;
        if (this.#prefixOffset < 4) break;
        const length = frameLength(this.#prefix);
        if (length > COMPUTER_USE_HOST_CONTROL_MAX_BYTES) fail("frame_too_large");
        this.#metadataBody = new Uint8Array(length);
        this.#metadataOffset = 0;
      }
      if (this.#metadata === undefined && this.#metadataBody !== undefined) {
        const metadataBytes = Math.min(
          this.#metadataBody.length - this.#metadataOffset,
          chunk.length - offset,
        );
        this.#metadataBody.set(chunk.subarray(offset, offset + metadataBytes), this.#metadataOffset);
        this.#metadataOffset += metadataBytes;
        offset += metadataBytes;
        if (this.#metadataOffset < this.#metadataBody.length) break;
        this.#metadata = parseAttachmentMetadata(this.#metadataBody);
        this.#metadataBody = undefined;
        this.#metadataOffset = 0;
        this.#png = new Uint8Array(this.#metadata.byteLength);
        this.#pngOffset = 0;
      }
      if (this.#metadata !== undefined && this.#png !== undefined) {
        const pngBytes = Math.min(this.#png.length - this.#pngOffset, chunk.length - offset);
        this.#png.set(chunk.subarray(offset, offset + pngBytes), this.#pngOffset);
        this.#pngOffset += pngBytes;
        offset += pngBytes;
        if (this.#pngOffset < this.#png.length) break;
        output.push(parsePngAttachment(this.#metadata, this.#png));
        this.#metadata = undefined;
        this.#png = undefined;
        this.#pngOffset = 0;
        this.#prefixOffset = 0;
      }
    }
    return output;
  }

  finish(): void {
    if (
      this.#prefixOffset !== 0
      || this.#metadataBody !== undefined
      || this.#metadata !== undefined
      || this.#png !== undefined
    ) {
      fail("invalid_attachment");
    }
  }
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const IHDR = [73, 72, 68, 82] as const;
const IDAT = [73, 68, 65, 84] as const;
const IEND = [73, 69, 78, 68] as const;
const PLTE = [80, 76, 84, 69] as const;
const CRC32 = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let current = index;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) === 0 ? current >>> 1 : (current >>> 1) ^ 0xedb88320;
    }
    table[index] = current >>> 0;
  }
  return table;
})();

function same(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.length <= bytes.length - offset
    && expected.every((byte, index) => bytes[offset + index] === byte);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x1000000
    + bytes[offset + 1]! * 0x10000
    + bytes[offset + 2]! * 0x100
    + bytes[offset + 3]!;
}

function crc32(bytes: Uint8Array, offset: number, length: number): number {
  let current = 0xffffffff;
  for (let index = offset; index < offset + length; index += 1) {
    current = CRC32[(current ^ bytes[index]!) & 0xff]! ^ (current >>> 8);
  }
  return (current ^ 0xffffffff) >>> 0;
}

function legalDepth(depth: number | undefined, color: number | undefined): boolean {
  if (color === 0) return depth === 1 || depth === 2 || depth === 4 || depth === 8 || depth === 16;
  if (color === 2 || color === 4 || color === 6) return depth === 8 || depth === 16;
  return color === 3 && (depth === 1 || depth === 2 || depth === 4 || depth === 8);
}

function parsePngDimensions(bytes: Uint8Array): Readonly<{ width: number; height: number }> {
  const ascii = (byte: number | undefined): boolean => byte !== undefined
    && ((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122));
  if (bytes.length < 45 || !same(bytes, 0, SIGNATURE)) fail("invalid_attachment");
  let offset = 8;
  let dimensions: Readonly<{ width: number; height: number }> | undefined;
  let sawIdat = false;
  let closedIdat = false;
  let sawPlte = false;
  let depth: number | undefined;
  let color: number | undefined;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) fail("invalid_attachment");
    const length = uint32(bytes, offset);
    const type = offset + 4;
    const data = type + 4;
    if (
      length > bytes.length - data - 4
      || !ascii(bytes[type])
      || !ascii(bytes[type + 1])
      || !ascii(bytes[type + 2])
      || !ascii(bytes[type + 3])
      || bytes[type + 2]! > 90
    ) {
      fail("invalid_attachment");
    }
    const next = data + length + 4;
    const ihdr = same(bytes, type, IHDR);
    const idat = same(bytes, type, IDAT);
    const iend = same(bytes, type, IEND);
    const plte = same(bytes, type, PLTE);
    if (
      (bytes[type]! <= 90 && !ihdr && !idat && !iend && !plte)
      || crc32(bytes, type, length + 4) !== uint32(bytes, data + length)
    ) {
      fail("invalid_attachment");
    }
    if (dimensions === undefined) {
      if (!ihdr || length !== 13) fail("invalid_attachment");
      const width = uint32(bytes, data);
      const height = uint32(bytes, data + 4);
      if (
        width === 0
        || height === 0
        || !legalDepth(bytes[data + 8], bytes[data + 9])
        || bytes[data + 10] !== 0
        || bytes[data + 11] !== 0
        || (bytes[data + 12] !== 0 && bytes[data + 12] !== 1)
      ) {
        fail("invalid_attachment");
      }
      dimensions = { width, height };
      depth = bytes[data + 8];
      color = bytes[data + 9];
    } else if (ihdr) {
      fail("invalid_attachment");
    }
    if (sawIdat && !idat) closedIdat = true;
    if (plte) {
      if (
        sawPlte
        || sawIdat
        || color === 0
        || color === 4
        || length === 0
        || length % 3 !== 0
        || length > 768
        || (color === 3 && (depth === undefined || length / 3 > 2 ** depth))
      ) {
        fail("invalid_attachment");
      }
      sawPlte = true;
    }
    if (idat) {
      if (closedIdat || (color === 3 && !sawPlte)) fail("invalid_attachment");
      sawIdat = true;
    }
    if (iend) {
      if (!sawIdat || length !== 0 || next !== bytes.length) fail("invalid_attachment");
      return dimensions;
    }
    offset = next;
  }
  return fail("invalid_attachment");
}
