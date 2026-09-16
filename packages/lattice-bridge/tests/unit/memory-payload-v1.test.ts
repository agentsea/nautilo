import { describe, expect, test } from "bun:test";

import {
  MEMORY_PAYLOAD_FORMAT_VERSION_V1,
  MEMORY_PAYLOAD_MAX_CONTENT_BYTES_V1,
  decodeMemoryPayloadV1,
  encodeMemoryPayloadV1,
} from "../../src/memory/memory-payload-v1.ts";

describe("MemoryPayloadV1", () => {
  test("round-trips a canonical bounded content/type payload", () => {
    const payload = {
      formatVersion: MEMORY_PAYLOAD_FORMAT_VERSION_V1,
      content: "Casey prefers tea 🫖",
      type: "preference",
    } as const;
    const first = encodeMemoryPayloadV1(payload);
    const second = encodeMemoryPayloadV1({ ...payload });

    expect(first).toEqual(second);
    expect(decodeMemoryPayloadV1(first)).toEqual(payload);
    expect(new TextDecoder().decode(first)).toBe(
      '{"formatVersion":1,"content":"Casey prefers tea 🫖","type":"preference"}',
    );
  });

  test("rejects unknown fields, malformed UTF-8, and non-canonical bytes", () => {
    expect(() => decodeMemoryPayloadV1(new TextEncoder().encode(
      '{"formatVersion":1,"content":"x","type":"general","extra":true}',
    ))).toThrow("field set");
    expect(() => decodeMemoryPayloadV1(Uint8Array.of(0xff))).toThrow("UTF-8");
    expect(() => decodeMemoryPayloadV1(new TextEncoder().encode(
      '{"type":"general","content":"x","formatVersion":1}',
    ))).toThrow("canonical");
  });

  test("enforces byte limits rather than JavaScript character counts", () => {
    const overLimit = "🫖".repeat(Math.floor(MEMORY_PAYLOAD_MAX_CONTENT_BYTES_V1 / 4) + 1);
    expect(() => encodeMemoryPayloadV1({
      formatVersion: 1,
      content: overLimit,
      type: "general",
    })).toThrow("content");
  });
});
