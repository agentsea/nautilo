import { describe, expect, test } from "bun:test";

import { base64ToBytes } from "./base64";

describe("Hermes-safe base64 bytes", () => {
  test("decodes padded base64 without atob or Buffer", () => {
    expect([...base64ToBytes("aGVsbG8=")]).toEqual([104, 101, 108, 108, 111]);
  });

  test("accepts whitespace around a transport chunk", () => {
    expect(new TextDecoder().decode(base64ToBytes(" YWJj\n"))).toBe("abc");
  });
});
