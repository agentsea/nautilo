import { LATTICE_LIMITS } from "@nautilo/lattice-crypto";
import type {
  ProtectedTaskMetadataClassificationV1,
  ProtectedTaskMetadataJsonValueV1,
} from "@nautilo/types";
import {
  MESSAGE_PAYLOAD_MAX_JSON_DEPTH_V2,
  MESSAGE_PAYLOAD_MAX_JSON_NODES_V2,
  MESSAGE_PAYLOAD_MAX_METADATA_ENTRIES_V2,
  MESSAGE_PAYLOAD_MAX_METADATA_TEXT_BYTES_V2,
  MESSAGE_PAYLOAD_MAX_NAME_BYTES_V2,
} from "../message/message-payload-v2.ts";

export const TASK_PAYLOAD_FORMAT_VERSION_V1 = 1 as const;
export const TASK_RUN_RESULT_PAYLOAD_FORMAT_VERSION_V1 = 1 as const;
export const TASK_PAYLOAD_MAX_WIRE_BYTES_V1 = LATTICE_LIMITS.plaintextBytes;
export const TASK_RUN_RESULT_PAYLOAD_MAX_WIRE_BYTES_V1 =
  LATTICE_LIMITS.plaintextBytes;
export const TASK_PAYLOAD_MAX_TEXT_BYTES_V1 = LATTICE_LIMITS.plaintextBytes;
export const TASK_RUN_RESULT_PAYLOAD_MAX_TEXT_BYTES_V1 =
  LATTICE_LIMITS.plaintextBytes;
export const TASK_PAYLOAD_MAX_METADATA_ENTRIES_V1 =
  MESSAGE_PAYLOAD_MAX_METADATA_ENTRIES_V2;
export const TASK_PAYLOAD_MAX_METADATA_JSON_NODES_V1 =
  MESSAGE_PAYLOAD_MAX_JSON_NODES_V2;
export const TASK_PAYLOAD_MAX_METADATA_JSON_DEPTH_V1 =
  MESSAGE_PAYLOAD_MAX_JSON_DEPTH_V2;
export const TASK_PAYLOAD_MAX_METADATA_TEXT_BYTES_V1 =
  MESSAGE_PAYLOAD_MAX_METADATA_TEXT_BYTES_V2;
export const TASK_PAYLOAD_MAX_METADATA_NAME_BYTES_V1 =
  MESSAGE_PAYLOAD_MAX_NAME_BYTES_V2;

export type TaskProtectedMetadataContentV1 =
  Extract<
    ProtectedTaskMetadataClassificationV1,
    { status: "supported" }
  >["protectedContent"];

export type TaskPayloadV1 = Readonly<{
  formatVersion: typeof TASK_PAYLOAD_FORMAT_VERSION_V1;
  prompt: string;
  expectedOutput: string | null;
  /** Exact `protectedContent` projection returned by the metadata classifier. */
  protectedMetadata: TaskProtectedMetadataContentV1;
}>;

export type TaskRunResultPayloadV1 = Readonly<{
  formatVersion: typeof TASK_RUN_RESULT_PAYLOAD_FORMAT_VERSION_V1;
  resultText: string | null;
  lastError: string | null;
}>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

interface JsonBudget {
  nodes: number;
  aggregateUtf8Bytes: number;
}

function ownRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactFields(
  label: string,
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Reflect.ownKeys(value);
  const fields = new Set(expected);
  if (keys.length !== expected.length) {
    throw new TypeError(`${label} has an invalid field set`);
  }
  for (const key of keys) {
    if (typeof key !== "string" || !fields.has(key)) {
      throw new TypeError(`${label} has an invalid field set`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) throw new TypeError(`${label} contains a non-data field`);
  }
}

function assertWellFormedUnicode(label: string, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${label} contains malformed Unicode`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} contains malformed Unicode`);
    }
  }
}

function boundedText(
  label: string,
  value: unknown,
  maximumBytes: number,
  options: Readonly<{ nullable: boolean; allowEmpty: boolean }>,
  budget?: JsonBudget,
): string | null {
  if (value === null && options.nullable) return null;
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be text${options.nullable ? " or null" : ""}`);
  }
  assertWellFormedUnicode(label, value);
  const length = encoder.encode(value).length;
  if ((!options.allowEmpty && length === 0) || length > maximumBytes) {
    throw new RangeError(`${label} is out of bounds`);
  }
  if (budget !== undefined) {
    budget.aggregateUtf8Bytes += length;
    if (budget.aggregateUtf8Bytes > TASK_PAYLOAD_MAX_WIRE_BYTES_V1) {
      throw new RangeError("Task payload aggregate text is out of bounds");
    }
  }
  return value;
}

function normalizeMetadataJsonValue(
  value: unknown,
  label: string,
  depth: number,
  budget: JsonBudget,
  ancestors: Set<object>,
): ProtectedTaskMetadataJsonValueV1 {
  if (depth > TASK_PAYLOAD_MAX_METADATA_JSON_DEPTH_V1) {
    throw new RangeError(`${label} exceeds the JSON depth limit`);
  }
  budget.nodes += 1;
  if (budget.nodes > TASK_PAYLOAD_MAX_METADATA_JSON_NODES_V1) {
    throw new RangeError(`${label} exceeds the JSON node limit`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return boundedText(
      label,
      value,
      TASK_PAYLOAD_MAX_METADATA_TEXT_BYTES_V1,
      { nullable: false, allowEmpty: true },
      budget,
    )!;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`${label} must contain canonical finite numbers`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${label} must contain only JSON values`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${label} must not contain cyclic values`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > TASK_PAYLOAD_MAX_METADATA_JSON_NODES_V1) {
        throw new RangeError(`${label} array is out of bounds`);
      }
      for (const key of Reflect.ownKeys(value)) {
        if (
          key === "length"
          || typeof key === "string"
            && /^(?:0|[1-9][0-9]*)$/.test(key)
            && Number(key) < value.length
        ) continue;
        throw new TypeError(`${label} array contains an extra field`);
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${label} array must not contain holes`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (
          descriptor === undefined
          || !descriptor.enumerable
          || !("value" in descriptor)
        ) throw new TypeError(`${label} array contains a non-data item`);
      }
      return Object.freeze(value.map((item, index) =>
        normalizeMetadataJsonValue(
          item,
          `${label}[${index}]`,
          depth + 1,
          budget,
          ancestors,
        )
      ));
    }
    if (!ownRecord(value)) {
      throw new TypeError(`${label} must contain plain JSON objects`);
    }
    assertExactFields(label, value, Object.keys(value));
    const keys = Object.keys(value);
    if (keys.length > TASK_PAYLOAD_MAX_METADATA_ENTRIES_V1) {
      throw new RangeError(`${label} object is out of bounds`);
    }
    const normalized = Object.create(null) as Record<
      string,
      ProtectedTaskMetadataJsonValueV1
    >;
    for (const key of keys.sort()) {
      boundedText(
        `${label} key`,
        key,
        TASK_PAYLOAD_MAX_METADATA_NAME_BYTES_V1,
        { nullable: false, allowEmpty: false },
        budget,
      );
      normalized[key] = normalizeMetadataJsonValue(
        value[key],
        `${label}.${key}`,
        depth + 1,
        budget,
        ancestors,
      );
    }
    return Object.freeze(normalized);
  } finally {
    ancestors.delete(value);
  }
}

function normalizeProtectedMetadata(
  value: unknown,
  budget: JsonBudget,
): TaskProtectedMetadataContentV1 {
  if (!ownRecord(value)) {
    throw new TypeError("Task payload protected metadata must be a JSON object");
  }
  return normalizeMetadataJsonValue(
    value,
    "Task payload protected metadata",
    0,
    budget,
    new Set<object>(),
  ) as TaskProtectedMetadataContentV1;
}

function normalizeTaskPayloadV1(value: unknown): TaskPayloadV1 {
  if (!ownRecord(value)) throw new TypeError("Task payload must be an object");
  assertExactFields("Task payload", value, [
    "formatVersion", "prompt", "expectedOutput", "protectedMetadata",
  ]);
  if (value["formatVersion"] !== TASK_PAYLOAD_FORMAT_VERSION_V1) {
    throw new TypeError("Task payload format version is unsupported");
  }
  const budget: JsonBudget = { nodes: 0, aggregateUtf8Bytes: 0 };
  const prompt = boundedText(
    "Task payload prompt",
    value["prompt"],
    TASK_PAYLOAD_MAX_TEXT_BYTES_V1,
    { nullable: false, allowEmpty: false },
    budget,
  );
  const expectedOutput = boundedText(
    "Task payload expected output",
    value["expectedOutput"],
    TASK_PAYLOAD_MAX_TEXT_BYTES_V1,
    { nullable: true, allowEmpty: true },
    budget,
  );
  const protectedMetadata = normalizeProtectedMetadata(
    value["protectedMetadata"],
    budget,
  );
  return Object.freeze({
    formatVersion: TASK_PAYLOAD_FORMAT_VERSION_V1,
    prompt: prompt!,
    expectedOutput,
    protectedMetadata,
  });
}

function normalizeTaskRunResultPayloadV1(
  value: unknown,
): TaskRunResultPayloadV1 {
  if (!ownRecord(value)) {
    throw new TypeError("Task run result payload must be an object");
  }
  assertExactFields("Task run result payload", value, [
    "formatVersion", "resultText", "lastError",
  ]);
  if (value["formatVersion"] !== TASK_RUN_RESULT_PAYLOAD_FORMAT_VERSION_V1) {
    throw new TypeError("Task run result payload format version is unsupported");
  }
  const resultText = boundedText(
    "Task run result payload result text",
    value["resultText"],
    TASK_RUN_RESULT_PAYLOAD_MAX_TEXT_BYTES_V1,
    { nullable: true, allowEmpty: true },
  );
  const lastError = boundedText(
    "Task run result payload last error",
    value["lastError"],
    TASK_RUN_RESULT_PAYLOAD_MAX_TEXT_BYTES_V1,
    { nullable: true, allowEmpty: true },
  );
  if (resultText === null && lastError === null) {
    throw new TypeError("Task run result payload has no result content");
  }
  return Object.freeze({
    formatVersion: TASK_RUN_RESULT_PAYLOAD_FORMAT_VERSION_V1,
    resultText,
    lastError,
  });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function decodeJson(label: string, bytes: Uint8Array, maximum: number): unknown {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`${label} bytes must be Uint8Array`);
  }
  if (bytes.length < 1 || bytes.length > maximum) {
    throw new RangeError(`${label} exceeds its wire limit`);
  }
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new TypeError(`${label} must contain valid UTF-8`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TypeError(`${label} must contain valid JSON`);
  }
}

function assertWireLimit(label: string, bytes: Uint8Array, maximum: number): void {
  if (bytes.length < 1 || bytes.length > maximum) {
    bytes.fill(0);
    throw new RangeError(`${label} exceeds its wire limit`);
  }
}

function isMetadataArray(
  value: ProtectedTaskMetadataJsonValueV1,
): value is readonly ProtectedTaskMetadataJsonValueV1[] {
  return Array.isArray(value);
}

function canonicalJson(value: ProtectedTaskMetadataJsonValueV1): string {
  if (value === null) return "null";
  if (
    typeof value === "boolean"
    || typeof value === "number"
    || typeof value === "string"
  ) return JSON.stringify(value);
  if (isMetadataArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record: Readonly<Record<
    string,
    ProtectedTaskMetadataJsonValueV1
  >> = value;
  return `{${Object.keys(record).sort().map((key) => {
    const item = record[key];
    if (item === undefined) {
      throw new TypeError("Task payload protected metadata is invalid");
    }
    return `${JSON.stringify(key)}:${canonicalJson(item)}`;
  }).join(",")}}`;
}

export function encodeTaskPayloadV1(payload: TaskPayloadV1): Uint8Array {
  const normalized = normalizeTaskPayloadV1(payload);
  const bytes = encoder.encode(
    `{"formatVersion":${normalized.formatVersion},` +
      `"prompt":${JSON.stringify(normalized.prompt)},` +
      `"expectedOutput":${JSON.stringify(normalized.expectedOutput)},` +
      `"protectedMetadata":${canonicalJson(normalized.protectedMetadata)}}`,
  );
  assertWireLimit("Task payload", bytes, TASK_PAYLOAD_MAX_WIRE_BYTES_V1);
  return bytes;
}

export function decodeTaskPayloadV1(bytes: Uint8Array): TaskPayloadV1 {
  const normalized = normalizeTaskPayloadV1(decodeJson(
    "Task payload",
    bytes,
    TASK_PAYLOAD_MAX_WIRE_BYTES_V1,
  ));
  const canonical = encodeTaskPayloadV1(normalized);
  try {
    if (!equalBytes(bytes, canonical)) {
      throw new TypeError("Task payload bytes are not canonical");
    }
    return normalized;
  } finally {
    canonical.fill(0);
  }
}

export function encodeTaskRunResultPayloadV1(
  payload: TaskRunResultPayloadV1,
): Uint8Array {
  const normalized = normalizeTaskRunResultPayloadV1(payload);
  const bytes = encoder.encode(JSON.stringify({
    formatVersion: normalized.formatVersion,
    resultText: normalized.resultText,
    lastError: normalized.lastError,
  }));
  assertWireLimit(
    "Task run result payload",
    bytes,
    TASK_RUN_RESULT_PAYLOAD_MAX_WIRE_BYTES_V1,
  );
  return bytes;
}

export function decodeTaskRunResultPayloadV1(
  bytes: Uint8Array,
): TaskRunResultPayloadV1 {
  const normalized = normalizeTaskRunResultPayloadV1(decodeJson(
    "Task run result payload",
    bytes,
    TASK_RUN_RESULT_PAYLOAD_MAX_WIRE_BYTES_V1,
  ));
  const canonical = encodeTaskRunResultPayloadV1(normalized);
  try {
    if (!equalBytes(bytes, canonical)) {
      throw new TypeError("Task run result payload bytes are not canonical");
    }
    return normalized;
  } finally {
    canonical.fill(0);
  }
}
