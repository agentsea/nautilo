import { describe, test, expect } from "bun:test";
import { sha256Hex, sha256Utf8 } from "../../src/sha256";
import { SHA256_ABC, SHA256_EMPTY } from "../fixtures/valid";

describe("sha256", () => {
  test("empty string matches NIST vector", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(SHA256_EMPTY);
  });

  test('"abc" matches NIST vector', () => {
    expect(sha256Utf8("abc")).toBe(SHA256_ABC);
  });

  test("a 56-byte input (one block boundary) is handled", () => {
    // 56 bytes of 0x00 -> known to exercise single-block padding edge
    const input = new Uint8Array(56);
    const h = sha256Hex(input);
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a 55-byte and 56-byte inputs produce different digests", () => {
    expect(sha256Hex(new Uint8Array(55))).not.toBe(sha256Hex(new Uint8Array(56)));
  });

  test("a 64-byte and 65-byte inputs produce different digests", () => {
    expect(sha256Hex(new Uint8Array(64))).not.toBe(sha256Hex(new Uint8Array(65)));
  });

  test("deterministic for identical input", () => {
    expect(sha256Utf8("nautilo")).toBe(sha256Utf8("nautilo"));
  });
});
