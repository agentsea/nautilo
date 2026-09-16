import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DESKTOP_VISION_PNG_MAX_BYTES,
  parseBoundedPngDimensions,
} from "../../electron/computer-use/image-contract.ts";

const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 0 ? crc >>> 1 : (crc >>> 1) ^ 0xedb88320;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data = new Uint8Array()): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const result = new Uint8Array(12 + data.length);
  new DataView(result.buffer).setUint32(0, data.length);
  result.set(typeBytes, 4);
  result.set(data, 8);
  new DataView(result.buffer).setUint32(8 + data.length, crc32(result.subarray(4, 8 + data.length)));
  return result;
}

function png(...chunks: Uint8Array[]): Uint8Array {
  const size = signature.length + chunks.reduce((total, value) => total + value.length, 0);
  const result = new Uint8Array(size);
  result.set(signature);
  let offset = signature.length;
  for (const value of chunks) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function ihdr(overrides: Partial<{
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  compression: number;
  filter: number;
  interlace: number;
}> = {}): Uint8Array {
  const data = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const view = new DataView(data.buffer);
  if (overrides.width !== undefined) view.setUint32(0, overrides.width);
  if (overrides.height !== undefined) view.setUint32(4, overrides.height);
  if (overrides.bitDepth !== undefined) data[8] = overrides.bitDepth;
  if (overrides.colorType !== undefined) data[9] = overrides.colorType;
  if (overrides.compression !== undefined) data[10] = overrides.compression;
  if (overrides.filter !== undefined) data[11] = overrides.filter;
  if (overrides.interlace !== undefined) data[12] = overrides.interlace;
  return chunk("IHDR", data);
}

// A decodable 1×1 transparent RGBA PNG: zlib header, stored scanline, Adler32.
const validImageChunks = [ihdr(), chunk("IDAT", new Uint8Array([
  0x78, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xff,
  0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x05, 0x00, 0x01,
]))] as const;
const validPng = png(...validImageChunks, chunk("IEND"));

function invalid(input: Uint8Array): void {
  expect(parseBoundedPngDimensions(input)).toEqual({ kind: "invalid_png" });
}

describe("D516 bounded PNG image contract", () => {
  test("returns dimensions only for a structurally valid PNG with correct CRCs", () => {
    expect(parseBoundedPngDimensions(validPng)).toEqual({ width: 1, height: 1 });
    expect(DESKTOP_VISION_PNG_MAX_BYTES).toBe(32 * 1024 * 1024);
  });

  test("accepts exactly the shared byte cap and rejects cap plus one", () => {
    const ancillaryLength = DESKTOP_VISION_PNG_MAX_BYTES - validPng.length - 12;
    const exactCap = png(...validImageChunks, chunk("raNd", new Uint8Array(ancillaryLength)), chunk("IEND"));
    const capPlusOne = png(...validImageChunks, chunk("raNd", new Uint8Array(ancillaryLength + 1)), chunk("IEND"));
    expect(exactCap.length).toBe(DESKTOP_VISION_PNG_MAX_BYTES);
    expect(parseBoundedPngDimensions(exactCap)).toEqual({ width: 1, height: 1 });
    expect(capPlusOne.length).toBe(DESKTOP_VISION_PNG_MAX_BYTES + 1);
    invalid(capPlusOne);
  });

  test("uses the shared cap for Desktop vision while preserving the Browser cap", () => {
    const relay = readFileSync(resolve(import.meta.dir, "../../electron/relay.ts"), "utf8");
    const cuaSupervisor = readFileSync(resolve(import.meta.dir, "../../../../packages/computer-use-host/src/native-cua-supervisor.ts"), "utf8");
    const hostImageContract = readFileSync(resolve(import.meta.dir, "../../../../packages/computer-use-host/src/native-image-contract.ts"), "utf8");
    expect(hostImageContract).toContain("export const DESKTOP_VISION_PNG_MAX_BYTES = 32 * 1024 * 1024;");
    expect(cuaSupervisor).toContain('import { DESKTOP_VISION_PNG_MAX_BYTES, parseBoundedPngDimensions } from "./native-image-contract.js";');
    expect(cuaSupervisor).toContain("new Uint8Array(DESKTOP_VISION_PNG_MAX_BYTES + 1)");
    expect(relay).toContain("const BROWSER_VISION_PNG_MAX_BYTES = 4 * 1024 * 1024;");
  });

  test("rejects signature, truncation, CRC, and attacker-sized chunk failures", () => {
    const badSignature = validPng.slice();
    badSignature[0] ^= 0xff;
    invalid(badSignature);
    invalid(validPng.subarray(0, 7));
    invalid(validPng.subarray(0, validPng.length - 1));
    const badCrc = validPng.slice();
    badCrc[16] ^= 1;
    invalid(badCrc);
    invalid(png(ihdr(), new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x49, 0x44, 0x41, 0x54])));
  });

  test("rejects IHDR order, duplication, invalid dimensions, and invalid methods", () => {
    invalid(png(chunk("IDAT"), ihdr(), chunk("IEND")));
    invalid(png(ihdr(), ihdr(), chunk("IEND")));
    invalid(png(ihdr({ width: 0 }), chunk("IEND")));
    invalid(png(ihdr({ height: 0 }), chunk("IEND")));
    invalid(png(ihdr({ compression: 1 }), chunk("IEND")));
    invalid(png(ihdr({ filter: 1 }), chunk("IEND")));
    invalid(png(ihdr({ interlace: 2 }), chunk("IEND")));
    invalid(png(chunk("IHDR", new Uint8Array(12)), chunk("IEND")));
  });

  test("accepts only legal IHDR bit-depth and color-type pairs", () => {
    for (const [colorType, bitDepth] of [
      [0, 1], [0, 2], [0, 4], [0, 8], [0, 16],
      [2, 8], [2, 16],
      [3, 1], [3, 2], [3, 4], [3, 8],
      [4, 8], [4, 16], [6, 8], [6, 16],
    ]) {
      const palette = colorType === 3 ? [chunk("PLTE", new Uint8Array([0, 0, 0]))] : [];
      expect(parseBoundedPngDimensions(png(
        ihdr({ colorType, bitDepth }), ...palette, chunk("IDAT"), chunk("IEND"),
      ))).toEqual({ width: 1, height: 1 });
    }
    for (const [colorType, bitDepth] of [[0, 3], [1, 8], [2, 4], [3, 16], [4, 4], [6, 2]]) {
      const palette = colorType === 3 ? [chunk("PLTE", new Uint8Array([0, 0, 0]))] : [];
      invalid(png(ihdr({ colorType, bitDepth }), ...palette, chunk("IDAT"), chunk("IEND")));
    }
  });

  test("requires contiguous IDAT data and valid PLTE placement", () => {
    invalid(png(ihdr(), chunk("IEND")));
    invalid(png(ihdr(), chunk("IDAT"), chunk("tEXt"), chunk("IDAT"), chunk("IEND")));
    invalid(png(ihdr({ colorType: 3, bitDepth: 1 }), chunk("IDAT"), chunk("IEND")));
    invalid(png(ihdr(), chunk("IDAT"), chunk("PLTE", new Uint8Array([0, 0, 0])), chunk("IEND")));
    invalid(png(ihdr({ colorType: 0, bitDepth: 1 }), chunk("PLTE", new Uint8Array([0, 0, 0])), chunk("IDAT"), chunk("IEND")));
    invalid(png(ihdr({ colorType: 4, bitDepth: 8 }), chunk("PLTE", new Uint8Array([0, 0, 0])), chunk("IDAT"), chunk("IEND")));
    invalid(png(ihdr(), chunk("PLTE", new Uint8Array([0, 0, 0])), chunk("PLTE", new Uint8Array([0, 0, 0])), chunk("IDAT"), chunk("IEND")));
    for (const length of [0, 1, 2, 4, 771]) {
      invalid(png(ihdr(), chunk("PLTE", new Uint8Array(length)), chunk("IDAT"), chunk("IEND")));
    }
    invalid(png(
      ihdr({ colorType: 3, bitDepth: 1 }),
      chunk("PLTE", new Uint8Array(9)),
      chunk("IDAT"),
      chunk("IEND"),
    ));
  });

  test("rejects malformed chunk types and unknown critical chunks", () => {
    invalid(png(ihdr(), chunk("abcd"), chunk("IDAT"), chunk("IEND")));
    invalid(png(ihdr(), chunk("a1cD"), chunk("IDAT"), chunk("IEND")));
    invalid(png(ihdr(), chunk("ABCD"), chunk("IDAT"), chunk("IEND")));
  });

  test("requires a terminal, zero-length IEND with no trailing bytes", () => {
    invalid(png(ihdr()));
    invalid(png(ihdr(), chunk("IEND", new Uint8Array([0]))));
    invalid(png(ihdr(), chunk("IEND"), chunk("IDAT")));
    const trailing = new Uint8Array(validPng.length + 1);
    trailing.set(validPng);
    invalid(trailing);
  });
});
