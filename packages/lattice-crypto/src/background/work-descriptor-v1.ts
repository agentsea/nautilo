import type { LatticeCrypto } from "../crypto/index.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import {
  CanonicalDecodingError,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "../format/v2-primitives.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  assertPortableId,
  assertU64Counter,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  namespaceId,
  objectId,
  unixTimestamp,
  type AccessRevision,
  type AgentId,
  type AgentRuntimeGeneration,
  type AuthorizationRevision,
  type CryptoDomainId,
  type DomainEpoch,
  type NamespaceId,
  type ObjectId,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import {
  V2_LIMITS,
  assertV2Range,
} from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1 = 1 as const;
export const BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V1 =
  "nautilo/lattice-crypto/background-work-descriptor/v1";
export const MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1 = 128 * 1024;

const HASH_BYTES = 32;
const ENUM_BYTES = 64;
const PROCESSOR_KIND = "stenographer" as const;
const PROCESSOR_VERSION = 1 as const;

export type BackgroundWorkKindV1 =
  | "stenographer.extraction"
  | "stenographer.historical"
  | "stenographer.compaction"
  | "stenographer.rebuild"
  | "memory.review"
  | "memory.exit_flush"
  | "task.dispatch"
  | "task.execute"
  | "task.approval_resume";

export type BackgroundWorkPurposeV1 =
  | "journal.extract"
  | "journal.compact"
  | "journal.rebuild"
  | "memory.review"
  | "memory.exit_flush"
  | "task.dispatch"
  | "task.execute"
  | "task.approval_resume";

export type BackgroundWorkOperationV1 = "decrypt" | "encrypt";

export interface BackgroundProcessorSubjectV1 {
  readonly kind: "processor";
  readonly processorKind: typeof PROCESSOR_KIND;
  readonly processorVersion: typeof PROCESSOR_VERSION;
  readonly authorizationRevision: AuthorizationRevision;
}

export interface BackgroundAgentSubjectV1 {
  readonly kind: "agent";
  readonly agentId: AgentId;
  readonly runtimeGeneration: AgentRuntimeGeneration;
  readonly authorizationRevision: AuthorizationRevision;
}

export type BackgroundWorkSubjectV1 =
  | BackgroundProcessorSubjectV1
  | BackgroundAgentSubjectV1;

export interface BackgroundJournalRangeSourceV1 {
  readonly kind: "journal_range";
  readonly startSequence: number;
  readonly endSequence: number;
  readonly rebuildGeneration: number;
  readonly fingerprint: Uint8Array;
}

export interface BackgroundSyntheticPayloadSourceV1 {
  readonly kind: "synthetic_payload";
  readonly generation: number;
  readonly fingerprint: Uint8Array;
}

export type BackgroundWorkSourceV1 =
  | BackgroundJournalRangeSourceV1
  | BackgroundSyntheticPayloadSourceV1;

export interface BackgroundOutputObjectMetadataV1 {
  readonly objectId: ObjectId;
  readonly objectType: string;
  readonly createdAt: UnixTimestamp;
}

export interface BackgroundWorkDescriptorV1 {
  readonly formatVersion:
    typeof BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1;
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly workKind: BackgroundWorkKindV1;
  readonly workId: string;
  readonly namespaceId: NamespaceId;
  readonly domainId: CryptoDomainId;
  readonly subject: BackgroundWorkSubjectV1;
  readonly purpose: BackgroundWorkPurposeV1;
  readonly operations: readonly BackgroundWorkOperationV1[];
  readonly source: BackgroundWorkSourceV1;
  readonly inputObjectIds: readonly ObjectId[];
  /**
   * Ordered deterministic slots the processor may materialize. A transform
   * publishes only a canonical prefix of these slots; unused suffix slots do
   * not become crypto objects.
   */
  readonly outputObjectIds: readonly ObjectId[];
  /** Immutable object metadata paired one-for-one with authorized slots. */
  readonly outputObjectMetadata:
    readonly BackgroundOutputObjectMetadataV1[];
  readonly maximumInputObjectCount: number;
  /** Exact size of `outputObjectIds`, not the transform's eventual output. */
  readonly maximumOutputObjectCount: number;
  readonly maximumPlaintextBytes: number;
  readonly maximumCiphertextBytes: number;
  readonly expectedDomainEpoch: DomainEpoch;
  readonly expectedNamespaceAccessRevision: AccessRevision;
  readonly expectedPolicyRevision: AuthorizationRevision;
  readonly recipientKeyId: string;
  readonly recipientPublicKey: Uint8Array;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly idempotencyId: string;
}

const DESCRIPTOR_FIELDS = Object.freeze([
  "formatVersion",
  "requestId",
  "recipientGeneration",
  "workKind",
  "workId",
  "namespaceId",
  "domainId",
  "subject",
  "purpose",
  "operations",
  "source",
  "inputObjectIds",
  "outputObjectIds",
  "outputObjectMetadata",
  "maximumInputObjectCount",
  "maximumOutputObjectCount",
  "maximumPlaintextBytes",
  "maximumCiphertextBytes",
  "expectedDomainEpoch",
  "expectedNamespaceAccessRevision",
  "expectedPolicyRevision",
  "recipientKeyId",
  "recipientPublicKey",
  "issuedAt",
  "notBefore",
  "expiresAt",
  "idempotencyId",
] as const);

const WORK_PURPOSES: Readonly<
  Record<BackgroundWorkKindV1, BackgroundWorkPurposeV1>
> = Object.freeze({
  "stenographer.extraction": "journal.extract",
  "stenographer.historical": "journal.extract",
  "stenographer.compaction": "journal.compact",
  "stenographer.rebuild": "journal.rebuild",
  "memory.review": "memory.review",
  "memory.exit_flush": "memory.exit_flush",
  "task.dispatch": "task.dispatch",
  "task.execute": "task.execute",
  "task.approval_resume": "task.approval_resume",
});

const WORK_KINDS = new Set<BackgroundWorkKindV1>(
  Object.keys(WORK_PURPOSES) as BackgroundWorkKindV1[],
);
const PURPOSES = new Set<BackgroundWorkPurposeV1>(
  Object.values(WORK_PURPOSES),
);

function assertObject(
  label: string,
  value: unknown,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactFields(
  label: string,
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort(compareUnsignedUtf8);
  const canonical = [...expected].sort(compareUnsignedUtf8);
  if (
    actual.length !== canonical.length
    || actual.some((field, index) => field !== canonical[index])
  ) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function exactBytes(
  label: string,
  value: unknown,
  length: number,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function normalizedWorkKind(value: unknown): BackgroundWorkKindV1 {
  if (typeof value !== "string" || !WORK_KINDS.has(value as never)) {
    throw new TypeError("Background work kind is unsupported");
  }
  return value as BackgroundWorkKindV1;
}

function normalizedPurpose(value: unknown): BackgroundWorkPurposeV1 {
  if (typeof value !== "string" || !PURPOSES.has(value as never)) {
    throw new TypeError("Background work purpose is unsupported");
  }
  return value as BackgroundWorkPurposeV1;
}

function normalizeSubject(value: unknown): BackgroundWorkSubjectV1 {
  assertObject("Background work subject", value);
  if (value["kind"] === "processor") {
    assertExactFields("Background processor subject", value, [
      "kind",
      "processorKind",
      "processorVersion",
      "authorizationRevision",
    ]);
    if (value["processorKind"] !== PROCESSOR_KIND) {
      throw new TypeError("Background processor kind is unsupported");
    }
    if (value["processorVersion"] !== PROCESSOR_VERSION) {
      throw new TypeError("Background processor version is unsupported");
    }
    return Object.freeze({
      kind: "processor",
      processorKind: PROCESSOR_KIND,
      processorVersion: PROCESSOR_VERSION,
      authorizationRevision:
        authorizationRevision(value["authorizationRevision"]),
    });
  }
  if (value["kind"] === "agent") {
    assertExactFields("Background Agent subject", value, [
      "kind",
      "agentId",
      "runtimeGeneration",
      "authorizationRevision",
    ]);
    return Object.freeze({
      kind: "agent",
      agentId: agentId(value["agentId"]),
      runtimeGeneration:
        agentRuntimeGeneration(value["runtimeGeneration"]),
      authorizationRevision:
        authorizationRevision(value["authorizationRevision"]),
    });
  }
  throw new TypeError("Background work subject kind is unsupported");
}

function normalizeSource(value: unknown): BackgroundWorkSourceV1 {
  assertObject("Background work source", value);
  if (value["kind"] === "journal_range") {
    assertExactFields("Background journal source", value, [
      "kind",
      "startSequence",
      "endSequence",
      "rebuildGeneration",
      "fingerprint",
    ]);
    assertU64Counter(
      "Background journal start sequence",
      value["startSequence"],
    );
    assertU64Counter(
      "Background journal end sequence",
      value["endSequence"],
    );
    assertU64Counter(
      "Background journal rebuild generation",
      value["rebuildGeneration"],
    );
    if (value["startSequence"] > value["endSequence"]) {
      throw new RangeError("Background journal source range is invalid");
    }
    return Object.freeze({
      kind: "journal_range",
      startSequence: value["startSequence"],
      endSequence: value["endSequence"],
      rebuildGeneration: value["rebuildGeneration"],
      fingerprint: exactBytes(
        "Background journal source fingerprint",
        value["fingerprint"],
        HASH_BYTES,
      ),
    });
  }
  if (value["kind"] === "synthetic_payload") {
    assertExactFields("Background synthetic source", value, [
      "kind",
      "generation",
      "fingerprint",
    ]);
    assertU64Counter(
      "Background synthetic source generation",
      value["generation"],
    );
    return Object.freeze({
      kind: "synthetic_payload",
      generation: value["generation"],
      fingerprint: exactBytes(
        "Background synthetic source fingerprint",
        value["fingerprint"],
        HASH_BYTES,
      ),
    });
  }
  throw new TypeError("Background work source kind is unsupported");
}

function normalizeOperations(
  value: unknown,
): readonly BackgroundWorkOperationV1[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Background work operations must be an array");
  }
  assertV2Range("Background work operations", value.length, 1, 2);
  const operations: BackgroundWorkOperationV1[] = [];
  for (const operation of value as readonly unknown[]) {
    if (operation !== "decrypt" && operation !== "encrypt") {
      throw new TypeError("Background work operation is unsupported");
    }
    operations.push(operation);
  }
  const canonical = [...new Set(operations)].sort(compareUnsignedUtf8);
  if (
    canonical.length !== operations.length
    || canonical.some((operation, index) => operation !== operations[index])
  ) {
    throw new TypeError(
      "Background work operations must be canonical and unique",
    );
  }
  return Object.freeze(canonical);
}

function normalizeObjectIds(
  label: string,
  value: unknown,
  minimum: number,
): readonly ObjectId[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  assertV2Range(
    label,
    value.length,
    minimum,
    V2_LIMITS.batchItems,
  );
  const ids = value.map(objectId);
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(`${label} must be ordered and unique`);
  }
  return Object.freeze(ids);
}

function normalizeOutputMetadata(
  value: unknown,
  outputObjectIds: readonly ObjectId[],
): readonly BackgroundOutputObjectMetadataV1[] {
  if (!Array.isArray(value) || value.length !== outputObjectIds.length) {
    throw new TypeError(
      "Background output metadata must match the authorized output slots",
    );
  }
  return Object.freeze(value.map((entry, index) => {
    assertObject("Background output metadata", entry);
    assertExactFields("Background output metadata", entry, [
      "objectId",
      "objectType",
      "createdAt",
    ]);
    const exactObjectId = objectId(entry["objectId"]);
    if (exactObjectId !== outputObjectIds[index]) {
      throw new TypeError(
        "Background output metadata must follow authorized output slot order",
      );
    }
    assertPortableId(
      "Background output object type",
      entry["objectType"],
    );
    return Object.freeze({
      objectId: exactObjectId,
      objectType: entry["objectType"],
      createdAt: unixTimestamp(entry["createdAt"]),
    });
  }));
}

function normalizeDescriptor(
  value: BackgroundWorkDescriptorV1,
): BackgroundWorkDescriptorV1 {
  assertObject("Background work descriptor", value);
  assertExactFields(
    "Background work descriptor",
    value,
    DESCRIPTOR_FIELDS,
  );
  if (
    value["formatVersion"]
      !== BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1
  ) {
    throw new TypeError("Background work descriptor format version is unsupported");
  }
  assertPortableId("Background request id", value["requestId"]);
  assertU64Counter(
    "Background recipient generation",
    value["recipientGeneration"],
  );
  const workKind = normalizedWorkKind(value["workKind"]);
  assertPortableId("Background product work id", value["workId"]);
  const checkedNamespaceId = namespaceId(value["namespaceId"]);
  const checkedDomainId = cryptoDomainId(value["domainId"]);
  const subject = normalizeSubject(value["subject"]);
  const purpose = normalizedPurpose(value["purpose"]);
  if (WORK_PURPOSES[workKind] !== purpose) {
    throw new TypeError("Background work kind and purpose do not match");
  }
  const stenographerWork = workKind.startsWith("stenographer.");
  if (stenographerWork && subject.kind !== "processor") {
    throw new TypeError(
      "Stenographer background work requires the Stenographer processor",
    );
  }
  if (!stenographerWork && subject.kind !== "agent") {
    throw new TypeError(
      "Agent-owned background work requires an Agent subject",
    );
  }
  const operations = normalizeOperations(value["operations"]);
  if (
    subject.kind === "processor"
    && (
      operations.length !== 2
      || operations[0] !== "decrypt"
      || operations[1] !== "encrypt"
    )
  ) {
    throw new TypeError(
      "Stenographer processor operations must be decrypt and encrypt",
    );
  }
  const source = normalizeSource(value["source"]);
  if (stenographerWork && source.kind !== "journal_range") {
    throw new TypeError(
      "Stenographer background work requires a journal source",
    );
  }
  if (!stenographerWork && source.kind !== "synthetic_payload") {
    throw new TypeError(
      "Dark Agent background work requires a synthetic source",
    );
  }
  const inputObjectIds = normalizeObjectIds(
    "Background input object ids",
    value["inputObjectIds"],
    1,
  );
  const outputObjectIds = normalizeObjectIds(
    "Background output object ids",
    value["outputObjectIds"],
    0,
  );
  const outputObjectMetadata = normalizeOutputMetadata(
    value["outputObjectMetadata"],
    outputObjectIds,
  );
  assertV2Range(
    "Background maximum input object count",
    value["maximumInputObjectCount"],
    1,
    V2_LIMITS.batchItems,
  );
  if (value["maximumInputObjectCount"] !== inputObjectIds.length) {
    throw new RangeError(
      "Background maximum input object count must match the exact input inventory",
    );
  }
  assertV2Range(
    "Background maximum output object count",
    value["maximumOutputObjectCount"],
    0,
    V2_LIMITS.batchItems,
  );
  if (value["maximumOutputObjectCount"] !== outputObjectIds.length) {
    throw new RangeError(
      "Background maximum output object count must match the authorized output slot count",
    );
  }
  const canEncrypt = operations.includes("encrypt");
  if (
    (canEncrypt && outputObjectIds.length === 0)
    || (!canEncrypt && outputObjectIds.length !== 0)
  ) {
    throw new TypeError(
      "Background output object slot space must match encrypt operations",
    );
  }
  assertV2Range(
    "Background plaintext byte budget",
    value["maximumPlaintextBytes"],
    1,
    V2_LIMITS.plaintextBytes,
  );
  assertV2Range(
    "Background ciphertext byte budget",
    value["maximumCiphertextBytes"],
    1,
    V2_LIMITS.ciphertextBytes,
  );
  const expectedDomainEpoch = domainEpoch(value["expectedDomainEpoch"]);
  const expectedNamespaceAccessRevision =
    accessRevision(value["expectedNamespaceAccessRevision"]);
  const expectedPolicyRevision =
    authorizationRevision(value["expectedPolicyRevision"]);
  assertPortableId(
    "Background recipient key id",
    value["recipientKeyId"],
  );
  const recipientPublicKey = exactBytes(
    "Background recipient public key",
    value["recipientPublicKey"],
    V2_LIMITS.hpkePublicKeyBytes,
  );
  assertU64Counter("Background issued-at timestamp", value["issuedAt"]);
  assertU64Counter(
    "Background not-before timestamp",
    value["notBefore"],
  );
  assertU64Counter("Background expiry timestamp", value["expiresAt"]);
  if (
    value["issuedAt"] > value["notBefore"]
    || value["notBefore"] >= value["expiresAt"]
  ) {
    recipientPublicKey.fill(0);
    throw new RangeError("Background work descriptor timestamps are invalid");
  }
  if (value["expiresAt"] - value["issuedAt"] > V2_LIMITS.grantTtlMs) {
    recipientPublicKey.fill(0);
    throw new RangeError("Background work descriptor TTL exceeds its format limit");
  }
  assertPortableId(
    "Background idempotency id",
    value["idempotencyId"],
  );

  return Object.freeze({
    formatVersion: BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1,
    requestId: value["requestId"],
    recipientGeneration: value["recipientGeneration"],
    workKind,
    workId: value["workId"],
    namespaceId: checkedNamespaceId,
    domainId: checkedDomainId,
    subject,
    purpose,
    operations,
    source,
    inputObjectIds,
    outputObjectIds,
    outputObjectMetadata,
    maximumInputObjectCount: value["maximumInputObjectCount"],
    maximumOutputObjectCount: value["maximumOutputObjectCount"],
    maximumPlaintextBytes: value["maximumPlaintextBytes"],
    maximumCiphertextBytes: value["maximumCiphertextBytes"],
    expectedDomainEpoch,
    expectedNamespaceAccessRevision,
    expectedPolicyRevision,
    recipientKeyId: value["recipientKeyId"],
    recipientPublicKey,
    issuedAt: value["issuedAt"],
    notBefore: value["notBefore"],
    expiresAt: value["expiresAt"],
    idempotencyId: value["idempotencyId"],
  });
}

function subjectBytes(subject: BackgroundWorkSubjectV1): Uint8Array {
  if (subject.kind === "processor") {
    return concatV2(
      frameText(subject.kind),
      frameText(subject.processorKind),
      encodeU32(subject.processorVersion),
      encodeU64(subject.authorizationRevision),
    );
  }
  return concatV2(
    frameText(subject.kind),
    frameText(subject.agentId),
    encodeU64(subject.runtimeGeneration),
    encodeU64(subject.authorizationRevision),
  );
}

function sourceBytes(source: BackgroundWorkSourceV1): Uint8Array {
  if (source.kind === "journal_range") {
    return concatV2(
      frameText(source.kind),
      encodeU64(source.startSequence),
      encodeU64(source.endSequence),
      encodeU64(source.rebuildGeneration),
      frame(source.fingerprint),
    );
  }
  return concatV2(
    frameText(source.kind),
    encodeU64(source.generation),
    frame(source.fingerprint),
  );
}

function encodeNormalized(
  value: BackgroundWorkDescriptorV1,
): Uint8Array {
  const encoded = concatV2(
    frameText(BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V1),
    encodeU32(BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1),
    frameText(value.requestId),
    encodeU64(value.recipientGeneration),
    frameText(value.workKind),
    frameText(value.workId),
    frameText(value.namespaceId),
    frameText(value.domainId),
    subjectBytes(value.subject),
    frameText(value.purpose),
    encodeU32(value.operations.length),
    ...value.operations.map(frameText),
    sourceBytes(value.source),
    encodeU32(value.inputObjectIds.length),
    ...value.inputObjectIds.map(frameText),
    encodeU32(value.outputObjectIds.length),
    ...value.outputObjectIds.map(frameText),
    encodeU32(value.outputObjectMetadata.length),
    ...value.outputObjectMetadata.flatMap((metadata) => [
      frameText(metadata.objectId),
      frameText(metadata.objectType),
      encodeU64(metadata.createdAt),
    ]),
    encodeU32(value.maximumInputObjectCount),
    encodeU32(value.maximumOutputObjectCount),
    encodeU64(value.maximumPlaintextBytes),
    encodeU64(value.maximumCiphertextBytes),
    encodeU64(value.expectedDomainEpoch),
    encodeU64(value.expectedNamespaceAccessRevision),
    encodeU64(value.expectedPolicyRevision),
    frameText(value.recipientKeyId),
    frame(value.recipientPublicKey),
    encodeU64(value.issuedAt),
    encodeU64(value.notBefore),
    encodeU64(value.expiresAt),
    frameText(value.idempotencyId),
  );
  if (encoded.length > MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1) {
    encoded.fill(0);
    throw new RangeError("Background work descriptor exceeds its wire limit");
  }
  return encoded;
}

export function encodeBackgroundWorkDescriptorV1(
  value: BackgroundWorkDescriptorV1,
): Uint8Array {
  return encodeNormalized(normalizeDescriptor(value));
}

export function decodeBackgroundWorkDescriptorV1(
  bytes: Uint8Array,
): BackgroundWorkDescriptorV1 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Background work descriptor bytes must be Uint8Array");
  }
  if (bytes.length > MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1) {
    throw new RangeError("Background work descriptor exceeds its wire limit");
  }
  const decoded = decodeExact(bytes, (reader): BackgroundWorkDescriptorV1 => {
    const domain = reader.readText(
      utf8V2(BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V1).length,
    );
    if (domain !== BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V1) {
      throw new CanonicalDecodingError(
        "Background work descriptor domain mismatch",
      );
    }
    const formatVersion = reader.readVersion(
      BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1,
    ) as typeof BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1;
    const requestId = reader.readText(V2_LIMITS.idBytes);
    const recipientGeneration = reader.readU64();
    const workKind = reader.readText(ENUM_BYTES) as BackgroundWorkKindV1;
    const workId = reader.readText(V2_LIMITS.idBytes);
    const decodedNamespaceId =
      namespaceId(reader.readText(V2_LIMITS.idBytes));
    const decodedDomainId =
      cryptoDomainId(reader.readText(V2_LIMITS.idBytes));
    const subjectKind = reader.readText(ENUM_BYTES);
    let subject: BackgroundWorkSubjectV1;
    if (subjectKind === "processor") {
      subject = {
        kind: "processor",
        processorKind:
          reader.readText(ENUM_BYTES) as typeof PROCESSOR_KIND,
        processorVersion:
          reader.readU32() as typeof PROCESSOR_VERSION,
        authorizationRevision:
          authorizationRevision(reader.readU64()),
      };
    } else if (subjectKind === "agent") {
      subject = {
        kind: "agent",
        agentId: agentId(reader.readText(V2_LIMITS.idBytes)),
        runtimeGeneration:
          agentRuntimeGeneration(reader.readU64()),
        authorizationRevision:
          authorizationRevision(reader.readU64()),
      };
    } else {
      throw new CanonicalDecodingError(
        "Background work subject kind is unsupported",
      );
    }
    const purpose =
      reader.readText(ENUM_BYTES) as BackgroundWorkPurposeV1;
    const operationCount = reader.readCount(2);
    const operations = Array.from(
      { length: operationCount },
      () =>
        reader.readText(ENUM_BYTES) as BackgroundWorkOperationV1,
    );
    const sourceKind = reader.readText(ENUM_BYTES);
    let source: BackgroundWorkSourceV1;
    if (sourceKind === "journal_range") {
      source = {
        kind: "journal_range",
        startSequence: reader.readU64(),
        endSequence: reader.readU64(),
        rebuildGeneration: reader.readU64(),
        fingerprint: reader.readFrame(HASH_BYTES),
      };
    } else if (sourceKind === "synthetic_payload") {
      source = {
        kind: "synthetic_payload",
        generation: reader.readU64(),
        fingerprint: reader.readFrame(HASH_BYTES),
      };
    } else {
      throw new CanonicalDecodingError(
        "Background work source kind is unsupported",
      );
    }
    const inputCount = reader.readCount(V2_LIMITS.batchItems);
    const inputObjectIds = Array.from(
      { length: inputCount },
      () => objectId(reader.readText(V2_LIMITS.idBytes)),
    );
    const outputCount = reader.readCount(V2_LIMITS.batchItems);
    const outputObjectIds = Array.from(
      { length: outputCount },
      () => objectId(reader.readText(V2_LIMITS.idBytes)),
    );
    const outputMetadataCount = reader.readCount(V2_LIMITS.batchItems);
    const outputObjectMetadata = Array.from(
      { length: outputMetadataCount },
      (): BackgroundOutputObjectMetadataV1 => ({
        objectId: objectId(reader.readText(V2_LIMITS.idBytes)),
        objectType: reader.readText(V2_LIMITS.idBytes),
        createdAt: unixTimestamp(reader.readU64()),
      }),
    );
    return {
      formatVersion,
      requestId,
      recipientGeneration,
      workKind,
      workId,
      namespaceId: decodedNamespaceId,
      domainId: decodedDomainId,
      subject,
      purpose,
      operations,
      source,
      inputObjectIds,
      outputObjectIds,
      outputObjectMetadata,
      maximumInputObjectCount: reader.readU32(),
      maximumOutputObjectCount: reader.readU32(),
      maximumPlaintextBytes: reader.readU64(),
      maximumCiphertextBytes: reader.readU64(),
      expectedDomainEpoch: domainEpoch(reader.readU64()),
      expectedNamespaceAccessRevision:
        accessRevision(reader.readU64()),
      expectedPolicyRevision:
        authorizationRevision(reader.readU64()),
      recipientKeyId: reader.readText(V2_LIMITS.idBytes),
      recipientPublicKey:
        reader.readFrame(V2_LIMITS.hpkePublicKeyBytes),
      issuedAt: reader.readU64(),
      notBefore: reader.readU64(),
      expiresAt: reader.readU64(),
      idempotencyId: reader.readText(V2_LIMITS.idBytes),
    };
  });
  const normalized = normalizeDescriptor(decoded);
  const canonical = encodeNormalized(normalized);
  try {
    if (!equalBytes(canonical, bytes)) {
      throw new CanonicalDecodingError(
        "Background work descriptor is noncanonical",
      );
    }
    return normalized;
  } finally {
    canonical.fill(0);
  }
}

export function backgroundWorkDescriptorDigestV1(
  crypto: Pick<LatticeCrypto, "hash">,
  value: BackgroundWorkDescriptorV1,
): Uint8Array {
  const encoded = encodeBackgroundWorkDescriptorV1(value);
  try {
    return exactBytes(
      "Background work descriptor digest",
      crypto.hash(encoded),
      HASH_BYTES,
    );
  } finally {
    encoded.fill(0);
  }
}
