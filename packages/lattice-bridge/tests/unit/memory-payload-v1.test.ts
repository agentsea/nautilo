import { describe, expect, test } from "bun:test";
import { RECORD_PAYLOAD_V1_LIMITS } from "@nautilo/reflection/payload";

import {
  MEMORY_PAYLOAD_FORMAT_VERSION_V1,
  MEMORY_PAYLOAD_MAX_CONTENT_BYTES_V1,
  MEMORY_PAYLOAD_MAX_TYPE_BYTES_V1,
  MEMORY_PAYLOAD_MAX_WIRE_BYTES_V1,
  decodeMemoryPayloadV1,
  encodeMemoryPayloadV1,
  memoryPayloadExposureFromDurable,
  memoryPayloadExposureToDurable,
} from "../../src/memory/memory-payload-v1.ts";

function maximumSerializedModelExposure() {
  const dependency = {
    kind: "source" as const,
    sourceKind: "message",
    logicalObjectRef: "message:maximum-lineage",
    observedRevision: null,
    observedContentFingerprint: "x",
    terminalAuthorityLeafHandle:
      "10000000-0000-4000-8000-000000000001",
  };
  const initialBytes = new TextEncoder().encode(JSON.stringify([dependency]))
    .byteLength;
  return [{
    ...dependency,
    observedContentFingerprint: "x".repeat(
      RECORD_PAYLOAD_V1_LIMITS.payloadBytes - initialBytes + 1,
    ),
  }];
}

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

  test("admits all bounded fields together at their worst-case wire expansion", () => {
    const modelExposureDependencies = maximumSerializedModelExposure();
    expect(new TextEncoder().encode(JSON.stringify(modelExposureDependencies)))
      .toHaveLength(RECORD_PAYLOAD_V1_LIMITS.payloadBytes);

    const encoded = encodeMemoryPayloadV1({
      formatVersion: 1,
      content: "\u0000".repeat(MEMORY_PAYLOAD_MAX_CONTENT_BYTES_V1),
      type: "\u0001".repeat(MEMORY_PAYLOAD_MAX_TYPE_BYTES_V1),
      modelExposureDependencies,
    });

    expect(MEMORY_PAYLOAD_MAX_WIRE_BYTES_V1).toBe(656_967);
    expect(encoded).toHaveLength(MEMORY_PAYLOAD_MAX_WIRE_BYTES_V1);
    expect(decodeMemoryPayloadV1(encoded)).toEqual({
      formatVersion: 1,
      content: "\u0000".repeat(MEMORY_PAYLOAD_MAX_CONTENT_BYTES_V1),
      type: "\u0001".repeat(MEMORY_PAYLOAD_MAX_TYPE_BYTES_V1),
      modelExposureDependencies,
    });
  });

  test("round-trips other escaped and multibyte string forms canonically", () => {
    const payload = {
      formatVersion: 1 as const,
      content: "quote: \"; slash: \\; tea: 🫖; lone surrogate: \ud800",
      type: "\tquoted\\type\"",
    };
    const encoded = encodeMemoryPayloadV1(payload);

    expect(decodeMemoryPayloadV1(encoded)).toEqual(payload);
    expect(new TextDecoder().decode(encoded)).toContain(
      "quote: \\\"; slash: \\\\",
    );
    expect(new TextDecoder().decode(encoded)).toContain("\\ud800");
  });

  test("rejects each field, lineage, and wire input above its bound", () => {
    expect(() => encodeMemoryPayloadV1({
      formatVersion: 1,
      content: "x",
      type: "t".repeat(MEMORY_PAYLOAD_MAX_TYPE_BYTES_V1 + 1),
    })).toThrow("type");

    const modelExposureDependencies = maximumSerializedModelExposure();
    modelExposureDependencies[0]!.observedContentFingerprint += "x";
    expect(() => encodeMemoryPayloadV1({
      formatVersion: 1,
      content: "x",
      type: "fact",
      modelExposureDependencies,
    })).toThrow("model exposure");

    expect(() => decodeMemoryPayloadV1(
      new Uint8Array(MEMORY_PAYLOAD_MAX_WIRE_BYTES_V1 + 1),
    )).toThrow("wire limit");
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
