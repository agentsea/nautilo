import { describe, expect, test } from "bun:test";

import {
  MEMORY_PAYLOAD_FORMAT_VERSION_V1,
  MEMORY_PAYLOAD_MAX_CONTENT_BYTES_V1,
  decodeMemoryPayloadV1,
  encodeMemoryPayloadV1,
  memoryPayloadExposureFromDurable,
  memoryPayloadExposureToDurable,
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

  test("round-trips canonical confidential model exposure ancestry", () => {
    const payload = {
      formatVersion: MEMORY_PAYLOAD_FORMAT_VERSION_V1,
      content: "Derived preference",
      type: "preference",
      modelExposureDependencies: [
        {
          kind: "source" as const,
          sourceKind: "message",
          logicalObjectRef: "message:41",
          observedRevision: "3",
          observedContentFingerprint: "sha256:current",
          terminalAuthorityLeafHandle:
            "10000000-0000-4000-8000-000000000001",
        },
      ],
    };

    expect(decodeMemoryPayloadV1(encodeMemoryPayloadV1(payload))).toEqual(
      payload,
    );
    const durable = [{
      kind: "source" as const,
      sourceKind: "message",
      logicalSourceRef: "message:41",
      observedRevision: "3",
      observedContentFingerprint: "sha256:current",
      terminalAuthorityLeafHandle:
        "10000000-0000-4000-8000-000000000001",
    }];
    expect(memoryPayloadExposureToDurable({
      modelExposureDependencies:
        memoryPayloadExposureFromDurable(durable),
    })).toEqual(durable);
    expect(memoryPayloadExposureToDurable({})).toBeUndefined();
  });

  test("rejects malformed or noncanonical model exposure ancestry", () => {
    const malformed = {
      formatVersion: 1,
      content: "Derived preference",
      type: "preference",
      modelExposureDependencies: [{
        kind: "source",
        sourceKind: "message",
        logicalObjectRef: "message:41",
        observedRevision: "3",
        observedContentFingerprint: "sha256:current",
        terminalAuthorityLeafHandle:
          "10000000-0000-4000-8000-000000000001",
        forged: true,
      }],
    };
    expect(() => encodeMemoryPayloadV1(malformed as never)).toThrow();

    const noncanonical = new TextEncoder().encode(JSON.stringify({
      formatVersion: 1,
      content: "Derived preference",
      type: "preference",
      modelExposureDependencies: [
        {
          kind: "source",
          sourceKind: "message",
          logicalObjectRef: "message:42",
          observedRevision: "1",
          observedContentFingerprint: "sha256:later",
          terminalAuthorityLeafHandle:
            "10000000-0000-4000-8000-000000000001",
        },
        {
          kind: "source",
          sourceKind: "message",
          logicalObjectRef: "message:41",
          observedRevision: "1",
          observedContentFingerprint: "sha256:earlier",
          terminalAuthorityLeafHandle:
            "10000000-0000-4000-8000-000000000001",
        },
      ],
    }));
    expect(() => decodeMemoryPayloadV1(noncanonical)).toThrow("canonical");
  });
});
