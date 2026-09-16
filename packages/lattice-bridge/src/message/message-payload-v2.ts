import { LATTICE_LIMITS } from "@nautilo/lattice-crypto";

export const MESSAGE_PAYLOAD_FORMAT_VERSION_V2 = 2 as const;
export const MESSAGE_PAYLOAD_MAX_BYTES_V2 = LATTICE_LIMITS.plaintextBytes;
export const MESSAGE_PAYLOAD_MAX_TOOL_CALLS_V2 = 256;
export const MESSAGE_PAYLOAD_MAX_ATTACHMENTS_V2 = 10;
export const MESSAGE_PAYLOAD_MAX_METADATA_ENTRIES_V2 = 256;
export const MESSAGE_PAYLOAD_MAX_JSON_NODES_V2 = 4_096;
export const MESSAGE_PAYLOAD_MAX_JSON_DEPTH_V2 = 32;
export const MESSAGE_PAYLOAD_MAX_TEXT_BYTES_V2 =
  LATTICE_LIMITS.plaintextBytes;
export const MESSAGE_PAYLOAD_MAX_METADATA_TEXT_BYTES_V2 = 262_144;
export const MESSAGE_PAYLOAD_MAX_NAME_BYTES_V2 = 4_096;
export const MESSAGE_PAYLOAD_MAX_MIME_TYPE_BYTES_V2 = 256;
export const MESSAGE_PAYLOAD_MAX_CAPTION_BYTES_V2 = 65_536;

export type MessageRoleV2 = "user" | "assistant" | "tool" | "system";

export type CanonicalJsonArray = readonly CanonicalJsonValue[];

export interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue;
}

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonArray
  | CanonicalJsonObject;

export interface CanonicalToolCallV2 {
  readonly id?: string;
  readonly name: string;
  readonly args: Readonly<Record<string, CanonicalJsonValue>>;
}

export type EncryptedAttachmentReferenceKindV2 =
  | "message_attachment"
  | "artifact";

export interface EncryptedAttachmentReferenceV2 {
  readonly kind: EncryptedAttachmentReferenceKindV2;
  readonly referenceId: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly sizeBytes: number;
  readonly caption?: string;
}

/**
 * Canonical confidential message body. The codec adds the version dispatch
 * field to the encoded representation; callers cannot override it.
 */
export type MessagePayloadV2 = Readonly<{
  role: MessageRoleV2;
  content: string;
  toolCalls?: readonly CanonicalToolCallV2[];
  toolName?: string;
  sensitiveMetadata?: Readonly<Record<string, CanonicalJsonValue>>;
  attachmentRefs?: readonly EncryptedAttachmentReferenceV2[];
}>;

interface MessagePayloadWireV2 extends MessagePayloadV2 {
  readonly payloadVersion: typeof MESSAGE_PAYLOAD_FORMAT_VERSION_V2;
}

interface JsonBudget {
  nodes: number;
  aggregateUtf8Bytes: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const PORTABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

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
  allowed: readonly string[],
): void {
  const allowedFields = new Set(allowed);
  for (const field of Reflect.ownKeys(value)) {
    if (typeof field !== "string") {
      throw new TypeError(`${label} contains a symbol field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      throw new TypeError(`${label} contains a non-data field ${field}`);
    }
    if (!allowedFields.has(field)) {
      throw new TypeError(`${label} contains unknown field ${field}`);
    }
  }
}

function assertWellFormedUnicode(label: string, value: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) {
        throw new TypeError(`${label} contains malformed Unicode`);
      }
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
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
  options: Readonly<{ allowEmpty?: boolean }> = {},
  budget?: JsonBudget,
): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be text`);
  }
  assertWellFormedUnicode(label, value);
  if (value.length > maximumBytes) {
    throw new RangeError(`${label} is out of bounds`);
  }
  const byteLength = textEncoder.encode(value).length;
  if (
    (!options.allowEmpty && byteLength < 1)
    || byteLength > maximumBytes
  ) {
    throw new RangeError(`${label} is out of bounds`);
  }
  if (budget !== undefined) {
    budget.aggregateUtf8Bytes += byteLength;
    if (budget.aggregateUtf8Bytes > MESSAGE_PAYLOAD_MAX_BYTES_V2) {
      throw new RangeError(
        "message payload aggregate text is out of bounds",
      );
    }
  }
  return value;
}

function portableId(
  label: string,
  value: unknown,
  budget?: JsonBudget,
): string {
  const normalized = boundedText(
    label,
    value,
    LATTICE_LIMITS.idBytes,
    {},
    budget,
  );
  if (!PORTABLE_ID_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
  return normalized;
}

function safeCounter(label: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function normalizeJsonValue(
  value: unknown,
  label: string,
  depth: number,
  budget: JsonBudget,
  ancestors: Set<object>,
): CanonicalJsonValue {
  if (depth > MESSAGE_PAYLOAD_MAX_JSON_DEPTH_V2) {
    throw new RangeError(`${label} exceeds the JSON depth limit`);
  }
  budget.nodes += 1;
  if (budget.nodes > MESSAGE_PAYLOAD_MAX_JSON_NODES_V2) {
    throw new RangeError(`${label} exceeds the JSON node limit`);
  }

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return boundedText(
      label,
      value,
      MESSAGE_PAYLOAD_MAX_METADATA_TEXT_BYTES_V2,
      { allowEmpty: true },
      budget,
    );
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
      if (value.length > MESSAGE_PAYLOAD_MAX_JSON_NODES_V2) {
        throw new RangeError(`${label} array is out of bounds`);
      }
      const ownKeys = Reflect.ownKeys(value);
      for (const key of ownKeys) {
        if (
          key === "length"
          || (typeof key === "string"
            && /^(?:0|[1-9][0-9]*)$/.test(key)
            && Number(key) < value.length)
        ) {
          continue;
        }
        throw new TypeError(`${label} array contains an extra field`);
      }
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${label} array must not contain holes`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (
          descriptor === undefined
          || !descriptor.enumerable
          || !("value" in descriptor)
        ) {
          throw new TypeError(`${label} array contains a non-data item`);
        }
      }
      return Object.freeze(
        value.map((item, index) =>
          normalizeJsonValue(
            item,
            `${label}[${index}]`,
            depth + 1,
            budget,
            ancestors,
          )
        ),
      );
    }
    if (!ownRecord(value)) {
      throw new TypeError(`${label} must contain plain JSON objects`);
    }
    assertExactFields(label, value, Object.keys(value));
    const keys = Object.keys(value);
    if (keys.length > MESSAGE_PAYLOAD_MAX_METADATA_ENTRIES_V2) {
      throw new RangeError(`${label} object is out of bounds`);
    }
    const normalized = Object.create(null) as Record<
      string,
      CanonicalJsonValue
    >;
    for (const key of keys.sort()) {
      boundedText(
        `${label} key`,
        key,
        MESSAGE_PAYLOAD_MAX_NAME_BYTES_V2,
        {},
        budget,
      );
      normalized[key] = normalizeJsonValue(
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

function normalizeJsonRecord(
  value: unknown,
  label: string,
  budget: JsonBudget = { nodes: 0, aggregateUtf8Bytes: 0 },
): Readonly<Record<string, CanonicalJsonValue>> {
  if (!ownRecord(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return normalizeJsonValue(
    value,
    label,
    0,
    budget,
    new Set<object>(),
  ) as Readonly<Record<string, CanonicalJsonValue>>;
}

function normalizeToolCall(
  value: unknown,
  index: number,
  budget: JsonBudget,
): CanonicalToolCallV2 {
  if (!ownRecord(value)) {
    throw new TypeError(`message tool call ${index} must be an object`);
  }
  assertExactFields(`message tool call ${index}`, value, [
    "id",
    "name",
    "args",
  ]);
  const id = value["id"] === undefined
    ? undefined
    : portableId(`message tool call ${index} id`, value["id"], budget);
  return Object.freeze({
    ...(id === undefined ? {} : { id }),
    name: portableId(
      `message tool call ${index} name`,
      value["name"],
      budget,
    ),
    args: normalizeJsonRecord(
      value["args"],
      `message tool call ${index} arguments`,
      budget,
    ),
  });
}

function assertDenseOwnDataArray(
  label: string,
  value: unknown,
  maximumItems: number,
): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new RangeError(`${label} is out of bounds`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (
      key === "length"
      || (typeof key === "string"
        && /^(?:0|[1-9][0-9]*)$/.test(key)
        && Number(key) < value.length)
    ) {
      continue;
    }
    throw new TypeError(`${label} contains an extra field`);
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`${label} must not contain holes`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      throw new TypeError(`${label} contains a non-data item`);
    }
  }
}

function normalizeToolCalls(
  value: unknown,
  budget: JsonBudget,
): readonly CanonicalToolCallV2[] {
  assertDenseOwnDataArray(
    "message tool calls",
    value,
    MESSAGE_PAYLOAD_MAX_TOOL_CALLS_V2,
  );
  const normalized = value.map((call, index) =>
    normalizeToolCall(call, index, budget)
  );
  const seenIds = new Set<string>();
  for (const call of normalized) {
    if (call.id === undefined) continue;
    if (seenIds.has(call.id)) {
      throw new TypeError("message tool calls contain a duplicate id");
    }
    seenIds.add(call.id);
  }
  return Object.freeze(normalized);
}

function normalizeAttachment(
  value: unknown,
  index: number,
  budget: JsonBudget,
): EncryptedAttachmentReferenceV2 {
  if (!ownRecord(value)) {
    throw new TypeError(`message attachment ${index} must be an object`);
  }
  assertExactFields(`message attachment ${index}`, value, [
    "kind",
    "referenceId",
    "name",
    "mimeType",
    "sizeBytes",
    "caption",
  ]);
  const kind = value["kind"];
  if (kind !== "message_attachment" && kind !== "artifact") {
    throw new TypeError(`message attachment ${index} kind is unsupported`);
  }
  const mimeType = value["mimeType"] === undefined
    ? undefined
    : boundedText(
      `message attachment ${index} MIME type`,
      value["mimeType"],
      MESSAGE_PAYLOAD_MAX_MIME_TYPE_BYTES_V2,
      {},
      budget,
    );
  const caption = value["caption"] === undefined
    ? undefined
    : boundedText(
      `message attachment ${index} caption`,
      value["caption"],
      MESSAGE_PAYLOAD_MAX_CAPTION_BYTES_V2,
      { allowEmpty: true },
      budget,
    );
  return Object.freeze({
    kind,
    referenceId: portableId(
      `message attachment ${index} reference id`,
      value["referenceId"],
      budget,
    ),
    name: boundedText(
      `message attachment ${index} name`,
      value["name"],
      MESSAGE_PAYLOAD_MAX_NAME_BYTES_V2,
      {},
      budget,
    ),
    ...(mimeType === undefined ? {} : { mimeType }),
    sizeBytes: safeCounter(
      `message attachment ${index} size`,
      value["sizeBytes"],
    ),
    ...(caption === undefined ? {} : { caption }),
  });
}

function normalizeAttachments(
  value: unknown,
  budget: JsonBudget,
): readonly EncryptedAttachmentReferenceV2[] {
  assertDenseOwnDataArray(
    "message attachment references",
    value,
    MESSAGE_PAYLOAD_MAX_ATTACHMENTS_V2,
  );
  const normalized = value.map((item, index) =>
    normalizeAttachment(item, index, budget)
  );
  const seen = new Set<string>();
  for (const attachment of normalized) {
    const key = `${attachment.kind}\u0000${attachment.referenceId}`;
    if (seen.has(key)) {
      throw new TypeError(
        "message attachment references contain a duplicate identity",
      );
    }
    seen.add(key);
  }
  return Object.freeze(normalized);
}

function normalizePayload(
  value: unknown,
  expectsWireVersion: boolean,
): MessagePayloadV2 {
  if (!ownRecord(value)) {
    throw new TypeError("message payload must be an object");
  }
  assertExactFields("message payload", value, [
    ...(expectsWireVersion ? ["payloadVersion"] : []),
    "role",
    "content",
    "toolCalls",
    "toolName",
    "sensitiveMetadata",
    "attachmentRefs",
  ]);
  if (
    expectsWireVersion
    && value["payloadVersion"] !== MESSAGE_PAYLOAD_FORMAT_VERSION_V2
  ) {
    throw new TypeError("unsupported message payload version");
  }
  const role = value["role"];
  if (
    role !== "user"
    && role !== "assistant"
    && role !== "tool"
    && role !== "system"
  ) {
    throw new TypeError("message role is unsupported");
  }
  const jsonBudget: JsonBudget = {
    nodes: 0,
    aggregateUtf8Bytes: 0,
  };
  const toolCalls = value["toolCalls"] === undefined
    ? undefined
    : normalizeToolCalls(value["toolCalls"], jsonBudget);
  const toolName = value["toolName"] === undefined
    ? undefined
    : portableId("message tool name", value["toolName"], jsonBudget);
  const sensitiveMetadata = value["sensitiveMetadata"] === undefined
    ? undefined
    : normalizeJsonRecord(
      value["sensitiveMetadata"],
      "message sensitive metadata",
      jsonBudget,
    );
  const attachmentRefs = value["attachmentRefs"] === undefined
    ? undefined
    : normalizeAttachments(value["attachmentRefs"], jsonBudget);
  return Object.freeze({
    role,
    content: boundedText(
      "message content",
      value["content"],
      MESSAGE_PAYLOAD_MAX_TEXT_BYTES_V2,
      { allowEmpty: true },
      jsonBudget,
    ),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(sensitiveMetadata === undefined ? {} : { sensitiveMetadata }),
    ...(attachmentRefs === undefined ? {} : { attachmentRefs }),
  });
}

function canonicalJson(value: CanonicalJsonValue): string {
  if (value === null) return "null";
  if (
    typeof value === "boolean"
    || typeof value === "number"
    || typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Readonly<Record<string, CanonicalJsonValue>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(",")}}`;
}

function canonicalJsonStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (
      code === 0x08
      || code === 0x09
      || code === 0x0a
      || code === 0x0c
      || code === 0x0d
    ) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
    if (bytes > MESSAGE_PAYLOAD_MAX_BYTES_V2) return bytes;
  }
  return bytes;
}

function canonicalJsonByteLength(value: CanonicalJsonValue): number {
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") return String(value).length;
  if (typeof value === "string") {
    return canonicalJsonStringByteLength(value);
  }
  if (Array.isArray(value)) {
    let bytes = 2 + Math.max(0, value.length - 1);
    for (const item of value as CanonicalJsonArray) {
      bytes += canonicalJsonByteLength(item);
      if (bytes > MESSAGE_PAYLOAD_MAX_BYTES_V2) return bytes;
    }
    return bytes;
  }
  const record = value as Readonly<Record<string, CanonicalJsonValue>>;
  const keys = Object.keys(record);
  let bytes = 2 + Math.max(0, keys.length - 1);
  for (const key of keys) {
    bytes += canonicalJsonStringByteLength(key) + 1;
    bytes += canonicalJsonByteLength(record[key]!);
    if (bytes > MESSAGE_PAYLOAD_MAX_BYTES_V2) return bytes;
  }
  return bytes;
}

function canonicalWire(payload: MessagePayloadV2): MessagePayloadWireV2 {
  return Object.freeze({
    payloadVersion: MESSAGE_PAYLOAD_FORMAT_VERSION_V2,
    ...payload,
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export function encodeMessagePayloadV2(
  payload: MessagePayloadV2,
): Uint8Array {
  const normalized = normalizePayload(payload, false);
  const wire = canonicalWire(normalized) as unknown as CanonicalJsonValue;
  if (canonicalJsonByteLength(wire) > MESSAGE_PAYLOAD_MAX_BYTES_V2) {
    throw new RangeError("canonical message payload bytes are out of bounds");
  }
  const bytes = textEncoder.encode(
    canonicalJson(wire),
  );
  if (bytes.length < 1 || bytes.length > MESSAGE_PAYLOAD_MAX_BYTES_V2) {
    throw new RangeError("canonical message payload bytes are out of bounds");
  }
  return bytes;
}

export function decodeMessagePayloadV2(bytes: Uint8Array): MessagePayloadV2 {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length < 1
    || bytes.length > MESSAGE_PAYLOAD_MAX_BYTES_V2
  ) {
    throw new RangeError("canonical message payload bytes are out of bounds");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(bytes));
  } catch {
    throw new TypeError("canonical message payload JSON is malformed");
  }
  const normalized = normalizePayload(parsed, true);
  const expected = encodeMessagePayloadV2(normalized);
  if (!bytesEqual(bytes, expected)) {
    throw new TypeError("message payload encoding is not canonical");
  }
  return normalized;
}
