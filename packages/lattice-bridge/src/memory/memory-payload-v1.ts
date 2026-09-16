export const MEMORY_PAYLOAD_FORMAT_VERSION_V1 = 1 as const;
export const MEMORY_PAYLOAD_MAX_CONTENT_BYTES_V1 = 64 * 1024;
export const MEMORY_PAYLOAD_MAX_TYPE_BYTES_V1 = 256;
export const MEMORY_PAYLOAD_MAX_WIRE_BYTES_V1 =
  MEMORY_PAYLOAD_MAX_CONTENT_BYTES_V1
  + MEMORY_PAYLOAD_MAX_TYPE_BYTES_V1
  + 128;

export type MemoryPayloadV1 = Readonly<{
  readonly formatVersion: typeof MEMORY_PAYLOAD_FORMAT_VERSION_V1;
  readonly content: string;
  readonly type: string;
}>;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function assertBoundedText(
  label: string,
  value: unknown,
  maximumBytes: number,
): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`Memory payload ${label} must be a string`);
  }
  const bytes = utf8Length(value);
  if (bytes < 1 || bytes > maximumBytes) {
    throw new RangeError(
      `Memory payload ${label} must be between 1 and ${maximumBytes} UTF-8 bytes`,
    );
  }
}

function normalizeMemoryPayloadV1(value: unknown): MemoryPayloadV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Memory payload must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = ["content", "formatVersion", "type"];
  const fields = Object.keys(record).sort();
  if (
    fields.length !== expected.length
    || fields.some((field, index) => field !== expected[index])
  ) {
    throw new TypeError("Memory payload has an invalid field set");
  }
  if (record["formatVersion"] !== MEMORY_PAYLOAD_FORMAT_VERSION_V1) {
    throw new TypeError("Memory payload format version is unsupported");
  }
  assertBoundedText(
    "content",
    record["content"],
    MEMORY_PAYLOAD_MAX_CONTENT_BYTES_V1,
  );
  assertBoundedText(
    "type",
    record["type"],
    MEMORY_PAYLOAD_MAX_TYPE_BYTES_V1,
  );
  return Object.freeze({
    formatVersion: MEMORY_PAYLOAD_FORMAT_VERSION_V1,
    content: record["content"],
    type: record["type"],
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

export function encodeMemoryPayloadV1(payload: MemoryPayloadV1): Uint8Array {
  const normalized = normalizeMemoryPayloadV1(payload);
  const bytes = new TextEncoder().encode(JSON.stringify({
    formatVersion: normalized.formatVersion,
    content: normalized.content,
    type: normalized.type,
  }));
  if (bytes.length > MEMORY_PAYLOAD_MAX_WIRE_BYTES_V1) {
    bytes.fill(0);
    throw new RangeError("Memory payload exceeds its wire limit");
  }
  return bytes;
}

export function decodeMemoryPayloadV1(bytes: Uint8Array): MemoryPayloadV1 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Memory payload bytes must be Uint8Array");
  }
  if (bytes.length < 1 || bytes.length > MEMORY_PAYLOAD_MAX_WIRE_BYTES_V1) {
    throw new RangeError("Memory payload exceeds its wire limit");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("Memory payload must contain valid UTF-8");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError("Memory payload must contain valid JSON");
  }
  const normalized = normalizeMemoryPayloadV1(decoded);
  const canonical = encodeMemoryPayloadV1(normalized);
  try {
    if (!equalBytes(bytes, canonical)) {
      throw new TypeError("Memory payload bytes are not canonical");
    }
    return normalized;
  } finally {
    canonical.fill(0);
  }
}
