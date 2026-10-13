import {
  normalizeRecordModelExposureDependenciesV1,
  RECORD_PAYLOAD_V1_LIMITS,
  type RecordPayloadModelExposureDependencyV1,
} from "@nautilo/reflection/payload";
import type { DurableModelExposureDependency } from "@nautilo/reflection/durable";

export const MEMORY_PAYLOAD_FORMAT_VERSION_V1 = 1 as const;
export const MEMORY_PAYLOAD_MAX_CONTENT_BYTES_V1 = 64 * 1024;
export const MEMORY_PAYLOAD_MAX_TYPE_BYTES_V1 = 256;
export const MEMORY_PAYLOAD_MAX_WIRE_BYTES_V1 =
  MEMORY_PAYLOAD_MAX_CONTENT_BYTES_V1
  + MEMORY_PAYLOAD_MAX_TYPE_BYTES_V1
  + RECORD_PAYLOAD_V1_LIMITS.payloadBytes
  + 256;

export type MemoryPayloadV1 = Readonly<{
  readonly formatVersion: typeof MEMORY_PAYLOAD_FORMAT_VERSION_V1;
  readonly content: string;
  readonly type: string;
  /** Complete confidential model-input ancestry; absent on legacy payloads. */
  readonly modelExposureDependencies?:
    readonly RecordPayloadModelExposureDependencyV1[];
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

function normalizeModelExposureDependencies(
  value: unknown,
): readonly RecordPayloadModelExposureDependencyV1[] {
  const normalized = normalizeRecordModelExposureDependenciesV1(value);
  if (
    new TextEncoder().encode(JSON.stringify(normalized)).byteLength
      > RECORD_PAYLOAD_V1_LIMITS.payloadBytes
  ) {
    throw new RangeError("Memory payload model exposure exceeds its wire limit");
  }
  return normalized;
}

/** Convert process-trusted durable ancestry into the confidential wire shape. */
export function memoryPayloadExposureFromDurable(
  dependencies: readonly DurableModelExposureDependency[],
): readonly RecordPayloadModelExposureDependencyV1[] {
  return normalizeModelExposureDependencies(
    dependencies.map((dependency) => dependency.kind === "record"
      ? {
          kind: "record",
          recordId: dependency.recordRef,
          observedProcessingGeneration:
            dependency.observedProcessingGeneration,
          terminalAuthorityLeafHandles:
            dependency.terminalAuthorityLeafHandles,
        }
      : {
          kind: "source",
          sourceKind: dependency.sourceKind,
          logicalObjectRef: dependency.logicalSourceRef,
          observedRevision: dependency.observedRevision ?? null,
          observedContentFingerprint:
            dependency.observedContentFingerprint ?? null,
          terminalAuthorityLeafHandle:
            dependency.terminalAuthorityLeafHandle,
        }),
  );
}

/** Recover validated ordinary ancestry only from an authenticated payload. */
export function memoryPayloadExposureToDurable(
  payload: Pick<MemoryPayloadV1, "modelExposureDependencies">,
): readonly DurableModelExposureDependency[] | undefined {
  return payload.modelExposureDependencies?.map((dependency) =>
    dependency.kind === "record"
      ? Object.freeze({
          kind: "record" as const,
          recordRef: dependency.recordId,
          observedProcessingGeneration:
            dependency.observedProcessingGeneration,
          terminalAuthorityLeafHandles:
            Object.freeze([...dependency.terminalAuthorityLeafHandles]),
        })
      : Object.freeze({
          kind: "source" as const,
          sourceKind: dependency.sourceKind,
          logicalSourceRef: dependency.logicalObjectRef,
          ...(dependency.observedRevision === null
            ? {}
            : { observedRevision: dependency.observedRevision }),
          ...(dependency.observedContentFingerprint === null
            ? {}
            : {
                observedContentFingerprint:
                  dependency.observedContentFingerprint,
              }),
          terminalAuthorityLeafHandle:
            dependency.terminalAuthorityLeafHandle,
        })
  );
}

function normalizeMemoryPayloadV1(value: unknown): MemoryPayloadV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Memory payload must be an object");
  }
  const record = value as Record<string, unknown>;
  const hasModelExposureDependencies = Object.hasOwn(
    record,
    "modelExposureDependencies",
  );
  const expected = [
    "content",
    "formatVersion",
    ...(hasModelExposureDependencies ? ["modelExposureDependencies"] : []),
    "type",
  ].sort();
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
    ...(hasModelExposureDependencies
      ? {
          modelExposureDependencies:
            normalizeModelExposureDependencies(
              record["modelExposureDependencies"],
            ),
        }
      : {}),
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
    ...(normalized.modelExposureDependencies === undefined
      ? {}
      : {
          modelExposureDependencies:
            normalized.modelExposureDependencies,
        }),
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
