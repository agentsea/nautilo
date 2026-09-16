export const RECORD_PAYLOAD_FORMAT_VERSION_V1 = 1 as const;

/**
 * The 256 KiB payload ceiling is one quarter of the lattice v2 object's
 * 1 MiB plaintext maximum. Identifier limits follow the same reviewed lattice
 * ceilings and the statement limit follows Wave 3. Inventories are bounded by
 * the canonical payload byte ceiling, not by semantic item-count ceilings.
 */
export const RECORD_PAYLOAD_V1_LIMITS = Object.freeze({
  payloadBytes: 256 * 1024,
  statementCodePoints: 800,
  identifierBytes: 128,
} as const);

export type RecordPayloadAnchorKindV1 =
  | "room"
  | "task"
  | "artifact"
  | "subject";

export interface RecordPayloadSourceDependencyV1 {
  readonly sourceKind: string;
  readonly logicalObjectRef: string;
  readonly observedRevision: string | null;
  readonly observedContentFingerprint: string | null;
  readonly terminalAuthorityLeafHandle: string;
  readonly authorityBearing: boolean;
}

export interface RecordPayloadAnchorV1 {
  readonly kind: RecordPayloadAnchorKindV1;
  readonly anchorRef: string;
  readonly role: string;
}

export interface RecordPayloadProducerV1 {
  readonly producerRef: string;
  readonly policyVersion: string;
}

export type RecordPayloadModelExposureDependencyV1 =
  | Readonly<{
      readonly kind: "record";
      readonly recordId: string;
      readonly observedProcessingGeneration: number;
      readonly terminalAuthorityLeafHandles: readonly string[];
    }>
  | Readonly<{
      readonly kind: "source";
      readonly sourceKind: string;
      readonly logicalObjectRef: string;
      readonly observedRevision: string | null;
      readonly observedContentFingerprint: string | null;
      readonly terminalAuthorityLeafHandle: string;
    }>;

export interface RecordPayloadV1 {
  readonly formatVersion: typeof RECORD_PAYLOAD_FORMAT_VERSION_V1;
  readonly posture: "derived";
  readonly observedContentFingerprint: string;
  readonly sourceOwnedKind: string | null;
  readonly observedLogicalObjectRef: string | null;
  readonly observedRevision: string | null;
  readonly statement: string;
  readonly sourceDependencies: readonly RecordPayloadSourceDependencyV1[];
  readonly anchors: readonly RecordPayloadAnchorV1[];
  readonly childRecordIds: readonly string[];
  readonly producer: RecordPayloadProducerV1;
  readonly terminalAuthorityLeafHandles: readonly string[];
  /** Absent only on canonical legacy V1 payload bytes. */
  readonly modelExposureDependencies?: readonly RecordPayloadModelExposureDependencyV1[];
}

export type RecordPayloadCodecErrorCode =
  | "malformed"
  | "unknown_field"
  | "unsupported_version"
  | "invalid_value"
  | "invalid_identifier"
  | "duplicate_reference"
  | "oversized"
  | "noncanonical";

export class RecordPayloadCodecError extends Error {
  readonly code: RecordPayloadCodecErrorCode;
  readonly path: string;

  constructor(code: RecordPayloadCodecErrorCode, path: string) {
    super(`RecordPayloadV1 ${code} at ${path}`);
    this.name = "RecordPayloadCodecError";
    this.code = code;
    this.path = path;
  }
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const PORTABLE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const ROOT_FIELDS = Object.freeze([
  "anchors",
  "childRecordIds",
  "formatVersion",
  "observedContentFingerprint",
  "observedLogicalObjectRef",
  "observedRevision",
  "posture",
  "producer",
  "sourceDependencies",
  "sourceOwnedKind",
  "statement",
  "terminalAuthorityLeafHandles",
] as const);
const EXTENDED_ROOT_FIELDS = Object.freeze([
  ...ROOT_FIELDS,
  "modelExposureDependencies",
] as const);
const SOURCE_FIELDS = Object.freeze([
  "authorityBearing",
  "logicalObjectRef",
  "observedContentFingerprint",
  "observedRevision",
  "sourceKind",
  "terminalAuthorityLeafHandle",
] as const);
const ANCHOR_FIELDS = Object.freeze(["anchorRef", "kind", "role"] as const);
const PRODUCER_FIELDS = Object.freeze(["policyVersion", "producerRef"] as const);
const RECORD_EXPOSURE_FIELDS = Object.freeze([
  "kind",
  "observedProcessingGeneration",
  "recordId",
  "terminalAuthorityLeafHandles",
] as const);
const SOURCE_EXPOSURE_FIELDS = Object.freeze([
  "kind",
  "logicalObjectRef",
  "observedContentFingerprint",
  "observedRevision",
  "sourceKind",
  "terminalAuthorityLeafHandle",
] as const);
const ANCHOR_KINDS = new Set<RecordPayloadAnchorKindV1>([
  "room",
  "task",
  "artifact",
  "subject",
]);
// Every canonical JSON array item needs at least two quotes, one byte of
// content, and a separator. Larger inventories cannot fit the payload anyway;
// rejecting them before normalization bounds hostile encode inputs without a
// product-level semantic count limit.
const MAXIMUM_PHYSICALLY_POSSIBLE_ARRAY_ITEMS = Math.floor(
  RECORD_PAYLOAD_V1_LIMITS.payloadBytes / 4,
);

function failure(
  code: RecordPayloadCodecErrorCode,
  path: string,
): RecordPayloadCodecError {
  return new RecordPayloadCodecError(code, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(
  value: unknown,
  expected: readonly string[],
  path: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw failure("malformed", path);
  const expectedSet = new Set(expected);
  if (Object.keys(value).some((key) => !expectedSet.has(key))) {
    throw failure("unknown_field", path);
  }
  if (expected.some((key) => !Object.hasOwn(value, key))) {
    throw failure("malformed", path);
  }
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function utf8Length(value: string): number {
  return TEXT_ENCODER.encode(value).byteLength;
}

function identifier(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || !PORTABLE_IDENTIFIER.test(value)
    || !hasWellFormedUnicode(value)
    || utf8Length(value) > RECORD_PAYLOAD_V1_LIMITS.identifierBytes
  ) throw failure("invalid_identifier", path);
  return value;
}

function boundedProvenanceText(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || !hasWellFormedUnicode(value)
    || Array.from(value).some((character) => {
      const point = character.codePointAt(0)!;
      return point <= 0x1f || point === 0x7f;
    })
  ) throw failure("invalid_value", path);
  return value;
}

function requiredProvenanceText(value: unknown, path: string): string {
  const normalized = boundedProvenanceText(value, path);
  if (normalized === null) throw failure("invalid_value", path);
  return normalized;
}

function statement(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || !hasWellFormedUnicode(value)
    || Array.from(value).length > RECORD_PAYLOAD_V1_LIMITS.statementCodePoints
  ) throw failure("invalid_value", "statement");
  return value;
}

function arrayValue(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw failure("malformed", path);
  if (value.length > MAXIMUM_PHYSICALLY_POSSIBLE_ARRAY_ITEMS) {
    throw failure("oversized", path);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSortedStrings(
  value: unknown,
  path: string,
): readonly string[] {
  const normalized = arrayValue(value, path).map((item, index) =>
    identifier(item, `${path}[${index}]`)
  );
  if (new Set(normalized).size !== normalized.length) {
    throw failure("duplicate_reference", path);
  }
  return Object.freeze(normalized.sort(compareText));
}

function sourceDependencyKey(value: RecordPayloadSourceDependencyV1): string {
  return `${value.sourceKind}\u0000${value.logicalObjectRef}`;
}

function normalizeSources(value: unknown): readonly RecordPayloadSourceDependencyV1[] {
  const sources = arrayValue(value, "sourceDependencies")
    .map((item, index): RecordPayloadSourceDependencyV1 => {
    const path = `sourceDependencies[${index}]`;
    exactFields(item, SOURCE_FIELDS, path);
    if (typeof item["authorityBearing"] !== "boolean") {
      throw failure("invalid_value", `${path}.authorityBearing`);
    }
    return Object.freeze({
      authorityBearing: item["authorityBearing"],
      logicalObjectRef: identifier(item["logicalObjectRef"], `${path}.logicalObjectRef`),
      observedContentFingerprint: boundedProvenanceText(
        item["observedContentFingerprint"],
        `${path}.observedContentFingerprint`,
      ),
      observedRevision: boundedProvenanceText(
        item["observedRevision"],
        `${path}.observedRevision`,
      ),
      sourceKind: identifier(item["sourceKind"], `${path}.sourceKind`),
      terminalAuthorityLeafHandle: identifier(
        item["terminalAuthorityLeafHandle"],
        `${path}.terminalAuthorityLeafHandle`,
      ),
    });
  });
  const keys = sources.map(sourceDependencyKey);
  if (new Set(keys).size !== keys.length) {
    throw failure("duplicate_reference", "sourceDependencies");
  }
  return Object.freeze(
    sources.sort((left, right) => compareText(sourceDependencyKey(left), sourceDependencyKey(right))),
  );
}

function anchorKey(value: RecordPayloadAnchorV1): string {
  return `${value.kind}\u0000${value.anchorRef}\u0000${value.role}`;
}

function normalizeAnchors(value: unknown): readonly RecordPayloadAnchorV1[] {
  const anchors = arrayValue(value, "anchors")
    .map((item, index): RecordPayloadAnchorV1 => {
    const path = `anchors[${index}]`;
    exactFields(item, ANCHOR_FIELDS, path);
    if (
      typeof item["kind"] !== "string"
      || !ANCHOR_KINDS.has(item["kind"] as RecordPayloadAnchorKindV1)
    ) {
      throw failure("invalid_value", `${path}.kind`);
    }
    return Object.freeze({
      anchorRef: identifier(item["anchorRef"], `${path}.anchorRef`),
      kind: item["kind"] as RecordPayloadAnchorKindV1,
      role: identifier(item["role"], `${path}.role`),
    });
  });
  const keys = anchors.map(anchorKey);
  if (new Set(keys).size !== keys.length) {
    throw failure("duplicate_reference", "anchors");
  }
  return Object.freeze(
    anchors.sort((left, right) => compareText(anchorKey(left), anchorKey(right))),
  );
}

function normalizeProducer(value: unknown): RecordPayloadProducerV1 {
  exactFields(value, PRODUCER_FIELDS, "producer");
  return Object.freeze({
    policyVersion: identifier(value["policyVersion"], "producer.policyVersion"),
    producerRef: identifier(value["producerRef"], "producer.producerRef"),
  });
}

function modelExposureDependencyKey(
  value: RecordPayloadModelExposureDependencyV1,
): string {
  return value.kind === "record"
    ? `record\u0000${value.recordId}`
    : `source\u0000${value.sourceKind}\u0000${value.logicalObjectRef}`;
}

function normalizeModelExposureDependencies(
  value: unknown,
): readonly RecordPayloadModelExposureDependencyV1[] {
  const dependencies = arrayValue(value, "modelExposureDependencies")
    .map((item, index): RecordPayloadModelExposureDependencyV1 => {
      const path = `modelExposureDependencies[${index}]`;
      if (!isRecord(item) || (item["kind"] !== "record" && item["kind"] !== "source")) {
        throw failure("invalid_value", `${path}.kind`);
      }
      if (item["kind"] === "record") {
        exactFields(item, RECORD_EXPOSURE_FIELDS, path);
        const generation = item["observedProcessingGeneration"];
        if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
          throw failure("invalid_value", `${path}.observedProcessingGeneration`);
        }
        const handles = uniqueSortedStrings(
          item["terminalAuthorityLeafHandles"],
          `${path}.terminalAuthorityLeafHandles`,
        );
        if (handles.length === 0) {
          throw failure("invalid_value", `${path}.terminalAuthorityLeafHandles`);
        }
        return Object.freeze({
          kind: "record",
          observedProcessingGeneration: generation as number,
          recordId: identifier(item["recordId"], `${path}.recordId`),
          terminalAuthorityLeafHandles: handles,
        });
      }
      exactFields(item, SOURCE_EXPOSURE_FIELDS, path);
      return Object.freeze({
        kind: "source",
        logicalObjectRef: identifier(item["logicalObjectRef"], `${path}.logicalObjectRef`),
        observedContentFingerprint: boundedProvenanceText(
          item["observedContentFingerprint"],
          `${path}.observedContentFingerprint`,
        ),
        observedRevision: boundedProvenanceText(
          item["observedRevision"],
          `${path}.observedRevision`,
        ),
        sourceKind: identifier(item["sourceKind"], `${path}.sourceKind`),
        terminalAuthorityLeafHandle: identifier(
          item["terminalAuthorityLeafHandle"],
          `${path}.terminalAuthorityLeafHandle`,
        ),
      });
    });
  const keys = dependencies.map(modelExposureDependencyKey);
  if (new Set(keys).size !== keys.length) {
    throw failure("duplicate_reference", "modelExposureDependencies");
  }
  return Object.freeze(dependencies.sort((left, right) =>
    compareText(modelExposureDependencyKey(left), modelExposureDependencyKey(right))
  ));
}

function normalizeRecordPayloadV1(value: unknown): RecordPayloadV1 {
  if (!isRecord(value)) throw failure("malformed", "payload");
  const hasModelExposureDependencies = Object.hasOwn(
    value,
    "modelExposureDependencies",
  );
  exactFields(
    value,
    hasModelExposureDependencies ? EXTENDED_ROOT_FIELDS : ROOT_FIELDS,
    "payload",
  );
  if (value["formatVersion"] !== RECORD_PAYLOAD_FORMAT_VERSION_V1) {
    throw failure("unsupported_version", "formatVersion");
  }
  if (value["posture"] !== "derived") throw failure("invalid_value", "posture");
  return Object.freeze({
    anchors: normalizeAnchors(value["anchors"]),
    childRecordIds: uniqueSortedStrings(
      value["childRecordIds"],
      "childRecordIds",
    ),
    formatVersion: RECORD_PAYLOAD_FORMAT_VERSION_V1,
    observedContentFingerprint: requiredProvenanceText(
      value["observedContentFingerprint"],
      "observedContentFingerprint",
    ),
    observedLogicalObjectRef: value["observedLogicalObjectRef"] === null
      ? null
      : identifier(value["observedLogicalObjectRef"], "observedLogicalObjectRef"),
    observedRevision: boundedProvenanceText(
      value["observedRevision"],
      "observedRevision",
    ),
    posture: "derived",
    producer: normalizeProducer(value["producer"]),
    sourceDependencies: normalizeSources(value["sourceDependencies"]),
    sourceOwnedKind: value["sourceOwnedKind"] === null
      ? null
      : identifier(value["sourceOwnedKind"], "sourceOwnedKind"),
    statement: statement(value["statement"]),
    terminalAuthorityLeafHandles: uniqueSortedStrings(
      value["terminalAuthorityLeafHandles"],
      "terminalAuthorityLeafHandles",
    ),
    ...(hasModelExposureDependencies
      ? {
          modelExposureDependencies: normalizeModelExposureDependencies(
            value["modelExposureDependencies"],
          ),
        }
      : {}),
  });
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort(compareText).map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  throw failure("malformed", "payload");
}

function encodeNormalized(value: RecordPayloadV1): Uint8Array {
  const bytes = TEXT_ENCODER.encode(canonicalJson(value));
  if (bytes.byteLength > RECORD_PAYLOAD_V1_LIMITS.payloadBytes) {
    throw failure("oversized", "payload");
  }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

/** Encode one normalized logical payload into its sole canonical byte shape. */
export function encodeRecordPayloadV1(value: unknown): Uint8Array {
  return encodeNormalized(normalizeRecordPayloadV1(value));
}

/** Decode only exact canonical bytes; whitespace, alternate ordering, and suffixes fail. */
export function decodeRecordPayloadV1(bytes: Uint8Array): RecordPayloadV1 {
  if (!(bytes instanceof Uint8Array)) throw failure("malformed", "payload");
  if (bytes.byteLength === 0) throw failure("malformed", "payload");
  if (bytes.byteLength > RECORD_PAYLOAD_V1_LIMITS.payloadBytes) {
    throw failure("oversized", "payload");
  }
  let text: string;
  try {
    text = TEXT_DECODER.decode(bytes);
  } catch {
    throw failure("malformed", "payload");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw failure("malformed", "payload");
  }
  const normalized = normalizeRecordPayloadV1(parsed);
  const canonical = encodeNormalized(normalized);
  if (!equalBytes(bytes, canonical)) throw failure("noncanonical", "payload");
  return normalized;
}
