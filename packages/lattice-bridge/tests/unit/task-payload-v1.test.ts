import { describe, expect, test } from "bun:test";
import { classifyProtectedTaskMetadataV1 } from "@nautilo/types";

import {
  TASK_PAYLOAD_MAX_METADATA_JSON_DEPTH_V1,
  TASK_PAYLOAD_MAX_METADATA_TEXT_BYTES_V1,
  TASK_PAYLOAD_MAX_TEXT_BYTES_V1,
  TASK_PAYLOAD_MAX_WIRE_BYTES_V1,
  TASK_RUN_RESULT_PAYLOAD_MAX_TEXT_BYTES_V1,
  TASK_RUN_RESULT_PAYLOAD_MAX_WIRE_BYTES_V1,
  decodeTaskPayloadV1,
  decodeTaskRunResultPayloadV1,
  encodeTaskPayloadV1,
  encodeTaskRunResultPayloadV1,
} from "../../src/task/task-payload-v1.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("Task payload v1", () => {
  test("round-trips one deterministic definition without changing content", () => {
    const payload = {
      formatVersion: 1,
      prompt: "Prepare the complete tea inventory 🫖",
      expectedOutput: "A checked inventory with discrepancies.",
      protectedMetadata: {
        target: "file:///workspace/tea",
        instructions: "Preserve the original order.",
      },
    } as const;
    const bytes = encodeTaskPayloadV1(payload);

    expect(decodeTaskPayloadV1(bytes)).toEqual(payload);
    expect(decoder.decode(bytes)).toBe(
      '{"formatVersion":1,"prompt":"Prepare the complete tea inventory 🫖","expectedOutput":"A checked inventory with discrepancies.","protectedMetadata":{"instructions":"Preserve the original order.","target":"file:///workspace/tea"}}',
    );
    expect(encodeTaskPayloadV1({ ...payload })).toEqual(bytes);
  });

  test("rejects unknown fields, duplicate keys, and non-canonical JSON", () => {
    expect(() => encodeTaskPayloadV1({
      formatVersion: 1,
      prompt: "p",
      expectedOutput: null,
      protectedMetadata: {},
      extra: true,
    } as never)).toThrow("field set");
    expect(() => decodeTaskPayloadV1(encoder.encode(
      '{"formatVersion":1,"prompt":"first","prompt":"second","expectedOutput":null,"protectedMetadata":{}}',
    ))).toThrow("canonical");
    expect(() => decodeTaskPayloadV1(encoder.encode(
      '{"prompt":"p","formatVersion":1,"expectedOutput":null,"protectedMetadata":{}}',
    ))).toThrow("canonical");
    expect(() => decodeTaskPayloadV1(encoder.encode(
      '{"formatVersion":1,"prompt":"p","expectedOutput":null,"protectedMetadata":{}}\n',
    ))).toThrow("canonical");
  });

  test("consumes only the classifier protected-content projection", () => {
    const classified = classifyProtectedTaskMetadataV1({
      target: "file:///workspace/private-project",
      mode: "update",
      publish: "branch",
      instructions: "Retain the private migration notes.",
    });
    expect(classified.status).toBe("supported");
    if (classified.status !== "supported") throw new Error("fixture rejected");

    const bytes = encodeTaskPayloadV1({
      formatVersion: 1,
      prompt: "Update the repository guide.",
      expectedOutput: null,
      protectedMetadata: classified.protectedContent,
    });
    const decoded = decodeTaskPayloadV1(bytes);

    expect(decoded.protectedMetadata).toEqual({
      instructions: "Retain the private migration notes.",
      target: "file:///workspace/private-project",
    });
    expect(decoder.decode(bytes)).not.toContain('"mode"');
    expect(decoder.decode(bytes)).not.toContain('"publish"');
    expect(Object.isFrozen(decoded.protectedMetadata)).toBe(true);
  });

  test("canonicalizes nested metadata and rejects duplicate nested keys", () => {
    const bytes = encodeTaskPayloadV1({
      formatVersion: 1,
      prompt: "p",
      expectedOutput: null,
      protectedMetadata: {
        z: [{ b: 2, a: 1 }],
        a: true,
      },
    });
    expect(decoder.decode(bytes)).toBe(
      '{"formatVersion":1,"prompt":"p","expectedOutput":null,"protectedMetadata":{"a":true,"z":[{"a":1,"b":2}]}}',
    );
    expect(() => decodeTaskPayloadV1(encoder.encode(
      '{"formatVersion":1,"prompt":"p","expectedOutput":null,"protectedMetadata":{"target":"a","target":"b"}}',
    ))).toThrow("canonical");
  });

  test("rejects malformed encoding and content above the upstream plaintext bound", () => {
    expect(() => decodeTaskPayloadV1(Uint8Array.of(0xff))).toThrow("UTF-8");
    expect(() => encodeTaskPayloadV1({
      formatVersion: 1,
      prompt: "\ud800",
      expectedOutput: null,
      protectedMetadata: {},
    })).toThrow("Unicode");
    expect(() => encodeTaskPayloadV1({
      formatVersion: 1,
      prompt: "x".repeat(TASK_PAYLOAD_MAX_TEXT_BYTES_V1 + 1),
      expectedOutput: null,
      protectedMetadata: {},
    })).toThrow("bounds");
  });

  test("enforces the achievable definition text maximum at N-1, N, and N+1", () => {
    for (const size of [
      TASK_PAYLOAD_MAX_TEXT_BYTES_V1 - 1,
      TASK_PAYLOAD_MAX_TEXT_BYTES_V1,
    ]) {
      const encoded = encodeTaskPayloadV1({
        formatVersion: 1,
        prompt: "x".repeat(size),
        expectedOutput: null,
        protectedMetadata: {},
      });
      expect(encoded.length).toBe(
        TASK_PAYLOAD_MAX_WIRE_BYTES_V1
        - (TASK_PAYLOAD_MAX_TEXT_BYTES_V1 - size),
      );
    }
    expect(() => encodeTaskPayloadV1({
      formatVersion: 1,
      prompt: "x".repeat(TASK_PAYLOAD_MAX_TEXT_BYTES_V1 + 1),
      expectedOutput: null,
      protectedMetadata: {},
    })).toThrow("bounds");
  });

  test("enforces metadata type, text, depth, and cycle bounds", () => {
    expect(() => encodeTaskPayloadV1({
      formatVersion: 1,
      prompt: "p",
      expectedOutput: null,
      protectedMetadata: { value: undefined },
    } as never)).toThrow("JSON values");
    expect(() => encodeTaskPayloadV1({
      formatVersion: 1,
      prompt: "p",
      expectedOutput: null,
      protectedMetadata: {
        value: "x".repeat(TASK_PAYLOAD_MAX_METADATA_TEXT_BYTES_V1 + 1),
      },
    })).toThrow("bounds");

    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth <= TASK_PAYLOAD_MAX_METADATA_JSON_DEPTH_V1; depth += 1) {
      nested = { nested };
    }
    expect(() => encodeTaskPayloadV1({
      formatVersion: 1,
      prompt: "p",
      expectedOutput: null,
      protectedMetadata: nested as never,
    })).toThrow("depth");

    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => encodeTaskPayloadV1({
      formatVersion: 1,
      prompt: "p",
      expectedOutput: null,
      protectedMetadata: cyclic as never,
    })).toThrow("cyclic");
  });
});

describe("Task run result payload v1", () => {
  test("round-trips success and error content exactly", () => {
    const success = {
      formatVersion: 1,
      resultText: "All 37 items were checked.",
      lastError: null,
    } as const;
    const failure = {
      formatVersion: 1,
      resultText: null,
      lastError: "Provider stopped before returning a result.",
    } as const;

    expect(decodeTaskRunResultPayloadV1(
      encodeTaskRunResultPayloadV1(success),
    )).toEqual(success);
    expect(decodeTaskRunResultPayloadV1(
      encodeTaskRunResultPayloadV1(failure),
    )).toEqual(failure);
  });

  test("rejects empty result records, duplicates, unknown fields, and over-limit text", () => {
    expect(() => encodeTaskRunResultPayloadV1({
      formatVersion: 1,
      resultText: null,
      lastError: null,
    })).toThrow("no result content");
    expect(() => decodeTaskRunResultPayloadV1(encoder.encode(
      '{"formatVersion":1,"resultText":"a","resultText":"b","lastError":null}',
    ))).toThrow("canonical");
    expect(() => decodeTaskRunResultPayloadV1(encoder.encode(
      '{"formatVersion":1,"resultText":"a","lastError":null,"plaintext":"leak"}',
    ))).toThrow("field set");
    expect(() => encodeTaskRunResultPayloadV1({
      formatVersion: 1,
      resultText: "x".repeat(TASK_RUN_RESULT_PAYLOAD_MAX_TEXT_BYTES_V1 + 1),
      lastError: null,
    })).toThrow("bounds");
  });

  test("enforces the achievable result text maximum at N-1, N, and N+1", () => {
    for (const size of [
      TASK_RUN_RESULT_PAYLOAD_MAX_TEXT_BYTES_V1 - 1,
      TASK_RUN_RESULT_PAYLOAD_MAX_TEXT_BYTES_V1,
    ]) {
      const encoded = encodeTaskRunResultPayloadV1({
        formatVersion: 1,
        resultText: "x".repeat(size),
        lastError: null,
      });
      expect(encoded.length).toBe(
        TASK_RUN_RESULT_PAYLOAD_MAX_WIRE_BYTES_V1
        - (TASK_RUN_RESULT_PAYLOAD_MAX_TEXT_BYTES_V1 - size),
      );
    }
    expect(() => encodeTaskRunResultPayloadV1({
      formatVersion: 1,
      resultText: "x".repeat(TASK_RUN_RESULT_PAYLOAD_MAX_TEXT_BYTES_V1 + 1),
      lastError: null,
    })).toThrow("bounds");
  });
});
