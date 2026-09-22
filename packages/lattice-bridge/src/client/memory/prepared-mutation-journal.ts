import {
  protectedMemorySubmittedCreateRequestV1Schema,
  protectedMemorySubmittedUpdateRequestV1Schema,
  protectedMemoryPreparedAccessRequestV1Schema,
  protectedMemoryPreparedRepairRequestV1Schema,
  type ProtectedMemorySubmittedCreateRequestV1,
  type ProtectedMemorySubmittedUpdateRequestV1,
  type ProtectedMemoryPreparedAccessRequestV1,
  type ProtectedMemoryPreparedRepairRequestV1,
} from "@nautilo/api-client/browser";
import {
  protectedArtifactPreparedPublicationRequestV1Schema,
  protectedArtifactPreparedAccessRequestV1Schema,
  type ProtectedArtifactPreparedPublicationRequestV1,
  type ProtectedArtifactPreparedAccessRequestV1,
} from "@nautilo/api-client/browser";
import {
  liveShadowMessagePreparedRequestV1Schema,
  fullEncryptionMessagePreparedRequestV2Schema,
  type LiveShadowMessagePreparedRequestV1,
  type FullEncryptionMessagePreparedRequestV2,
} from "@nautilo/api-client/browser";
import {
  protectedTaskPreparedCreateRequestV1Schema,
  protectedTaskPreparedUpdateRequestV1Schema,
  type ProtectedTaskPreparedCreateRequestV1,
  type ProtectedTaskPreparedUpdateRequestV1,
} from "@nautilo/api-client/browser";
import { sha256 } from "@noble/hashes/sha2.js";
import { PREPARED_MUTATION_JOURNAL_LIMITS } from "./prepared-mutation-journal-limits.ts";

export { PREPARED_MUTATION_JOURNAL_LIMITS };

export type PreparedHumanMemoryMutation =
  | Readonly<{
      kind: "repair";
      memoryId: string;
      request: ProtectedMemoryPreparedRepairRequestV1;
    }>
  | Readonly<{
      kind: "create";
      memoryId: string;
      request: ProtectedMemorySubmittedCreateRequestV1;
    }>
  | Readonly<{
      kind: "update";
      memoryId: string;
      request: ProtectedMemorySubmittedUpdateRequestV1;
    }>
  | Readonly<{
      kind: "access";
      memoryId: string;
      request: ProtectedMemoryPreparedAccessRequestV1;
    }>;

export type PreparedHumanArtifactMutation =
  | Readonly<{
      kind: "artifact_create" | "artifact_content" | "artifact_control";
      artifactId: string;
      request: ProtectedArtifactPreparedPublicationRequestV1;
    }>
  | Readonly<{
      kind: "artifact_access";
      artifactId: string;
      request: ProtectedArtifactPreparedAccessRequestV1;
    }>;

export type PreparedHumanLiveShadowMessageMutation = Readonly<{
  kind: "live_shadow_message";
  roomId: string;
  request: LiveShadowMessagePreparedRequestV1 | FullEncryptionMessagePreparedRequestV2;
}>;

export type PreparedHumanTaskMutation =
  | Readonly<{
      kind: "task_create";
      taskId: string;
      request: ProtectedTaskPreparedCreateRequestV1;
    }>
  | Readonly<{
      kind: "task_update";
      taskId: string;
      request: ProtectedTaskPreparedUpdateRequestV1;
    }>;

export type PreparedAdditionalDeviceTransitionCampaign = Readonly<{
  kind: "additional_device_transition";
  operationId: string;
  targetDeviceId: string;
  targetClientKind: "browser" | "electron";
  verificationCode: string;
  candidateProfileDigestBase64url: string;
  candidateProfileGeneration: number;
}>;

export type PreparedAdditionalDeviceTargetPlan = Readonly<{
  kind: "additional_device_target_plan";
  operationId: string;
  targetDeviceId: string;
  verificationCode: string;
  deliveryHighWatermark: number | null;
  deliveryManifest: readonly Readonly<{
    messageId: string;
    recipientSequence: number;
    payloadHashBase64url: string;
  }>[];
}>;

export type PreparedHumanMutation =
  | PreparedHumanMemoryMutation
  | PreparedHumanArtifactMutation
  | PreparedHumanLiveShadowMessageMutation
  | PreparedHumanTaskMutation;

export type PreparedMutationTerminalReason =
  | "stale"
  | "denied"
  | "integrity"
  | "expired"
  | "collision";

export type PreparedMutationJournalState =
  | "pending"
  | "retryable"
  | `terminal_${PreparedMutationTerminalReason}`
  | "corrupt"
  | "missing_authority";

interface PreparedMutationJournalIndexBase {
  readonly formatVersion: 1;
  readonly operationId: string;
  readonly authenticatedRequestDigestBase64url: string;
  readonly canonicalBytes: number;
  readonly sealedBytes: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly attempts: number;
  readonly attemptWindowStartedAt: number | null;
  readonly attemptsInWindow: number;
  readonly nextAttemptAt: number;
  readonly lastAttemptAt: number | null;
  readonly state: PreparedMutationJournalState;
}

export type PreparedMutationJournalIndex = PreparedMutationJournalIndexBase & (
  | Readonly<{
    kind: PreparedHumanMemoryMutation["kind"];
    memoryId: string;
  }>
  | Readonly<{
    kind: PreparedHumanArtifactMutation["kind"];
    artifactId: string;
  }>
  | Readonly<{
    kind: PreparedHumanLiveShadowMessageMutation["kind"];
    roomId: string;
  }>
  | Readonly<{
    kind: PreparedHumanTaskMutation["kind"];
    taskId: string;
  }>
  | Readonly<{
    kind: PreparedAdditionalDeviceTransitionCampaign["kind"];
    targetDeviceId: string;
    targetClientKind: "browser" | "electron";
    verificationCode: string;
    candidateProfileDigestBase64url: string;
    candidateProfileGeneration: number;
  }>
  | Readonly<{
    kind: PreparedAdditionalDeviceTargetPlan["kind"];
    targetDeviceId: string;
    verificationCode: string;
    deliveryHighWatermark: number | null;
    deliveryManifest: readonly Readonly<{
      messageId: string;
      recipientSequence: number;
      payloadHashBase64url: string;
    }>[];
  }>
);

export type PreparedHumanMutationJournalIndex = Extract<
  PreparedMutationJournalIndex,
  { kind: PreparedHumanMutation["kind"] }
>;

export interface PreparedMutationJournalVaultPort {
  /** Atomically seals the body with the exact index as AAD and persists both. */
  putSealed(input: Readonly<{
    index: PreparedMutationJournalIndex;
    canonicalBody: Uint8Array;
  }>): Promise<"inserted" | "exact_duplicate" | "collision">;
  listIndexes(): Promise<readonly PreparedMutationJournalIndex[]>;
  withOpenedBody<Result>(
    operationId: string,
    expectedDigestBase64url: string,
    use: (canonicalBody: Uint8Array) => Promise<Result> | Result,
  ): Promise<Result>;
  updateIndex(
    expected: PreparedMutationJournalIndex,
    replacement: PreparedMutationJournalIndex,
  ): Promise<boolean>;
  removeExact(
    operationId: string,
    expectedDigestBase64url: string,
  ): Promise<boolean>;
}

export type PreparedMutationCapacity = Readonly<{
  records: number;
  sealedBytes: number;
  warning: boolean;
  full: boolean;
}>;

export type PreparedMutationRetryCandidate = Readonly<{
  operationId: string;
  authenticatedRequestDigestBase64url: string;
  kind: PreparedHumanMutation["kind"]
    | PreparedAdditionalDeviceTransitionCampaign["kind"]
    | PreparedAdditionalDeviceTargetPlan["kind"];
  attempts: number;
  ageMs: number;
}>;

export class PreparedMutationJournalBackpressureError extends Error {
  override readonly name = "PreparedMutationJournalBackpressureError";
}

export class PreparedMutationJournalCollisionError extends Error {
  override readonly name = "PreparedMutationJournalCollisionError";
}

export type PreparedMutationCustodyFacts = Readonly<{
  operationId: string;
  kind: PreparedHumanMutation["kind"];
  resourceId: string;
  authenticatedRequestDigestBase64url: string;
  canonicalBytes: number;
}>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const BASE64URL_DIGEST = /^[A-Za-z0-9_-]{43}$/u;
const HUMAN_MUTATION_KINDS = new Set<string>([
  "repair",
  "create",
  "update",
  "access",
  "artifact_create",
  "artifact_content",
  "artifact_control",
  "artifact_access",
  "live_shadow_message",
  "task_create",
  "task_update",
]);
const MEMORY_MUTATION_KINDS = new Set<string>([
  "repair", "create", "update", "access",
]);
const ARTIFACT_MUTATION_KINDS = new Set<string>([
  "artifact_create", "artifact_content", "artifact_control", "artifact_access",
]);
const JOURNAL_STATES = new Set<string>([
  "pending",
  "retryable",
  "terminal_stale",
  "terminal_denied",
  "terminal_integrity",
  "terminal_expired",
  "terminal_collision",
  "corrupt",
  "missing_authority",
]);
const INDEX_COMMON_FIELDS = [
  "formatVersion",
  "operationId",
  "kind",
  "authenticatedRequestDigestBase64url",
  "canonicalBytes",
  "sealedBytes",
  "createdAt",
  "updatedAt",
  "attempts",
  "attemptWindowStartedAt",
  "attemptsInWindow",
  "nextAttemptAt",
  "lastAttemptAt",
  "state",
] as const;

function ownRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactOwnDataFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length) return false;
  const expected = new Set(fields);
  return keys.every((key) => {
    if (typeof key !== "string" || !expected.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
  });
}

function safeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullableSafeNonnegativeInteger(value: unknown): boolean {
  return value === null || safeNonnegativeInteger(value);
}

const DEFAULT_PORTABLE_ID_MAXIMUM_LENGTH = 128;
const LIVE_SHADOW_OPERATION_ID_MAXIMUM_LENGTH = 256;

function portableId(
  value: unknown,
  maximumLength = DEFAULT_PORTABLE_ID_MAXIMUM_LENGTH,
): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maximumLength
    && PORTABLE_ID.test(value);
}

function operationIdMaximumLength(kind: string): number {
  return kind === "live_shadow_message"
    ? LIVE_SHADOW_OPERATION_ID_MAXIMUM_LENGTH
    : DEFAULT_PORTABLE_ID_MAXIMUM_LENGTH;
}

function validDeliveryManifest(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 4_096) return false;
  let previousSequence = 0;
  for (const candidate of value) {
    if (!ownRecord(candidate) || !exactOwnDataFields(candidate, [
      "messageId", "recipientSequence", "payloadHashBase64url",
    ])) return false;
    if (
      !portableId(candidate["messageId"])
      || !safeNonnegativeInteger(candidate["recipientSequence"])
      || candidate["recipientSequence"] <= previousSequence
      || typeof candidate["payloadHashBase64url"] !== "string"
      || !BASE64URL_DIGEST.test(candidate["payloadHashBase64url"])
    ) return false;
    previousSequence = candidate["recipientSequence"];
  }
  return true;
}

/**
 * Validates the complete persisted index union without reconstructing it.
 * Returning the original object preserves the property order authenticated as
 * AES-GCM additional data by existing Browser and file records.
 */
export function decodePreparedMutationJournalIndex(
  value: unknown,
): PreparedMutationJournalIndex {
  if (!ownRecord(value) || typeof value["kind"] !== "string") {
    throw new TypeError("prepared mutation journal index is corrupt");
  }
  const kind = value["kind"];
  let branchFields: readonly string[];
  let maximumCanonicalBytes: number;
  if (MEMORY_MUTATION_KINDS.has(kind)) {
    branchFields = ["memoryId"];
    maximumCanonicalBytes = PREPARED_MUTATION_JOURNAL_LIMITS.maxCanonicalRecordBytes;
  } else if (ARTIFACT_MUTATION_KINDS.has(kind)) {
    branchFields = ["artifactId"];
    maximumCanonicalBytes = PREPARED_MUTATION_JOURNAL_LIMITS.maxCanonicalRecordBytes;
  } else if (kind === "live_shadow_message") {
    branchFields = ["roomId"];
    maximumCanonicalBytes = PREPARED_MUTATION_JOURNAL_LIMITS.maxCanonicalRecordBytes;
  } else if (kind === "task_create" || kind === "task_update") {
    branchFields = ["taskId"];
    maximumCanonicalBytes = PREPARED_MUTATION_JOURNAL_LIMITS.maxCanonicalRecordBytes;
  } else if (kind === "additional_device_transition") {
    branchFields = [
      "targetDeviceId",
      "targetClientKind",
      "verificationCode",
      "candidateProfileDigestBase64url",
      "candidateProfileGeneration",
    ];
    maximumCanonicalBytes =
      PREPARED_MUTATION_JOURNAL_LIMITS.maxAdditionalDeviceCampaignBytes;
  } else if (kind === "additional_device_target_plan") {
    branchFields = [
      "targetDeviceId",
      "verificationCode",
      "deliveryHighWatermark",
      "deliveryManifest",
    ];
    maximumCanonicalBytes =
      PREPARED_MUTATION_JOURNAL_LIMITS.maxAdditionalDeviceCampaignBytes;
  } else {
    throw new TypeError("prepared mutation journal index is corrupt");
  }
  if (!exactOwnDataFields(value, [...INDEX_COMMON_FIELDS, ...branchFields])) {
    throw new TypeError("prepared mutation journal index is corrupt");
  }
  const canonicalBytes = value["canonicalBytes"];
  const sealedBytes = value["sealedBytes"];
  if (
    value["formatVersion"] !== 1
    || !portableId(value["operationId"], operationIdMaximumLength(kind))
    || typeof value["authenticatedRequestDigestBase64url"] !== "string"
    || !BASE64URL_DIGEST.test(value["authenticatedRequestDigestBase64url"])
    || !safeNonnegativeInteger(canonicalBytes)
    || canonicalBytes < 1
    || canonicalBytes > maximumCanonicalBytes
    || !safeNonnegativeInteger(sealedBytes)
    || sealedBytes !== canonicalBytes && sealedBytes !== canonicalBytes + 16
    || !safeNonnegativeInteger(value["createdAt"])
    || !safeNonnegativeInteger(value["updatedAt"])
    || !safeNonnegativeInteger(value["attempts"])
    || !nullableSafeNonnegativeInteger(value["attemptWindowStartedAt"])
    || !safeNonnegativeInteger(value["attemptsInWindow"])
    || !safeNonnegativeInteger(value["nextAttemptAt"])
    || !nullableSafeNonnegativeInteger(value["lastAttemptAt"])
    || typeof value["state"] !== "string"
    || !JOURNAL_STATES.has(value["state"])
  ) throw new TypeError("prepared mutation journal index is corrupt");

  const resourceField = MEMORY_MUTATION_KINDS.has(kind)
    ? "memoryId"
    : ARTIFACT_MUTATION_KINDS.has(kind)
    ? "artifactId"
    : kind === "live_shadow_message"
    ? "roomId"
    : kind === "task_create" || kind === "task_update"
    ? "taskId"
    : undefined;
  if (resourceField !== undefined && !portableId(value[resourceField])) {
    throw new TypeError("prepared mutation journal index is corrupt");
  }
  if (kind === "additional_device_transition" && (
    !portableId(value["targetDeviceId"])
    || value["targetClientKind"] !== "browser" && value["targetClientKind"] !== "electron"
    || typeof value["verificationCode"] !== "string"
    || value["verificationCode"].length < 1
    || value["verificationCode"].length > 64
    || typeof value["candidateProfileDigestBase64url"] !== "string"
    || !BASE64URL_DIGEST.test(value["candidateProfileDigestBase64url"])
    || !safeNonnegativeInteger(value["candidateProfileGeneration"])
    || value["candidateProfileGeneration"] < 1
  )) throw new TypeError("prepared mutation journal index is corrupt");
  if (kind === "additional_device_target_plan" && (
    !portableId(value["targetDeviceId"])
    || typeof value["verificationCode"] !== "string"
    || value["verificationCode"].length < 1
    || value["verificationCode"].length > 64
    || !nullableSafeNonnegativeInteger(value["deliveryHighWatermark"])
    || !validDeliveryManifest(value["deliveryManifest"])
    || ((value["deliveryManifest"] as readonly unknown[]).length === 0)
      !== (value["deliveryHighWatermark"] === null)
  )) throw new TypeError("prepared mutation journal index is corrupt");
  return value as unknown as PreparedMutationJournalIndex;
}

function isPreparedHumanMutationJournalIndex(
  value: PreparedMutationJournalIndex,
): value is PreparedHumanMutationJournalIndex {
  return HUMAN_MUTATION_KINDS.has(value.kind);
}

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function canonicalMutation(value: PreparedHumanMutation): Readonly<{
  mutation: PreparedHumanMutation;
  bytes: Uint8Array;
  resourceId: string;
}> {
  switch (value.kind) {
    case "repair": {
      const request = protectedMemoryPreparedRepairRequestV1Schema.parse(value.request);
      if (request.memoryId !== value.memoryId) throw new TypeError("Prepared repair Memory ID disagrees");
      return Object.freeze({
        mutation: Object.freeze({ kind: value.kind, memoryId: value.memoryId, request }),
        bytes: encoder.encode(JSON.stringify(request)), resourceId: value.memoryId,
      });
    }
    case "create": {
      const request = protectedMemorySubmittedCreateRequestV1Schema.parse(value.request);
      if (request.memoryId !== value.memoryId) {
        throw new TypeError("Prepared mutation Memory ID disagrees");
      }
      return Object.freeze({
        mutation: Object.freeze({ kind: value.kind, memoryId: value.memoryId, request }),
        bytes: encoder.encode(JSON.stringify(request)),
        resourceId: value.memoryId,
      });
    }
    case "update": {
      const request = protectedMemorySubmittedUpdateRequestV1Schema.parse(value.request);
      return Object.freeze({
        mutation: Object.freeze({ kind: value.kind, memoryId: value.memoryId, request }),
        bytes: encoder.encode(JSON.stringify(request)),
        resourceId: value.memoryId,
      });
    }
    case "access": {
      const request = protectedMemoryPreparedAccessRequestV1Schema.parse(value.request);
      if (request.memoryId !== value.memoryId) {
        throw new TypeError("Prepared access mutation Memory ID disagrees");
      }
      return Object.freeze({
        mutation: Object.freeze({ kind: value.kind, memoryId: value.memoryId, request }),
        bytes: encoder.encode(JSON.stringify(request)),
        resourceId: value.memoryId,
      });
    }
    case "artifact_create":
    case "artifact_content":
    case "artifact_control": {
      const request = protectedArtifactPreparedPublicationRequestV1Schema.parse(value.request);
      const expectedKind = request.operation === "create"
        ? "artifact_create"
        : request.operation === "replace_content"
        ? "artifact_content"
        : "artifact_control";
      if (request.artifactId !== value.artifactId || value.kind !== expectedKind) {
        throw new TypeError("Prepared Artifact mutation coordinates disagree");
      }
      return Object.freeze({
        mutation: Object.freeze({ kind: value.kind, artifactId: value.artifactId, request }),
        bytes: encoder.encode(JSON.stringify(request)),
        resourceId: value.artifactId,
      });
    }
    case "artifact_access": {
      const request = protectedArtifactPreparedAccessRequestV1Schema.parse(value.request);
      if (request.artifactId !== value.artifactId) {
        throw new TypeError("Prepared Artifact access identity disagrees");
      }
      return Object.freeze({
        mutation: Object.freeze({ kind: value.kind, artifactId: value.artifactId, request }),
        bytes: encoder.encode(JSON.stringify(request)),
        resourceId: value.artifactId,
      });
    }
    case "live_shadow_message": {
      const request = value.request.requestVersion === 2
        ? fullEncryptionMessagePreparedRequestV2Schema.parse(value.request)
        : liveShadowMessagePreparedRequestV1Schema.parse(value.request);
      return Object.freeze({
        mutation: Object.freeze({
          kind: value.kind,
          roomId: value.roomId,
          request,
        }),
        bytes: encoder.encode(JSON.stringify(request)),
        resourceId: value.roomId,
      });
    }
    case "task_create": {
      const request = protectedTaskPreparedCreateRequestV1Schema.parse(value.request);
      if (request.taskId !== value.taskId || request.operation !== "create") {
        throw new TypeError("Prepared Task create coordinates disagree");
      }
      return Object.freeze({
        mutation: Object.freeze({ kind: value.kind, taskId: value.taskId, request }),
        bytes: encoder.encode(JSON.stringify(request)),
        resourceId: value.taskId,
      });
    }
    case "task_update": {
      const request = protectedTaskPreparedUpdateRequestV1Schema.parse(value.request);
      if (request.taskId !== value.taskId || request.operation !== "update") {
        throw new TypeError("Prepared Task update coordinates disagree");
      }
      return Object.freeze({
        mutation: Object.freeze({ kind: value.kind, taskId: value.taskId, request }),
        bytes: encoder.encode(JSON.stringify(request)),
        resourceId: value.taskId,
      });
    }
    default:
      throw new TypeError("Prepared mutation kind is unsupported");
  }
}

function decodeMutation(
  bytes: Uint8Array,
  index: PreparedHumanMutationJournalIndex,
): PreparedHumanMutation {
  const value: unknown = JSON.parse(decoder.decode(bytes));
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Prepared mutation body is corrupt");
  }
  const canonical = canonicalMutation({
    kind: index.kind,
    ...("memoryId" in index
      ? { memoryId: index.memoryId }
      : "artifactId" in index
      ? { artifactId: index.artifactId }
      : "roomId" in index
      ? { roomId: index.roomId }
      : { taskId: index.taskId }),
    request: value,
  } as PreparedHumanMutation);
  try {
    if (
      canonical.bytes.length !== bytes.length
      || canonical.bytes.some((byte, index) => byte !== bytes[index])
    ) throw new TypeError("Prepared mutation body is not canonical");
    return canonical.mutation;
  } finally {
    canonical.bytes.fill(0);
  }
}

function digest(
  bytes: Uint8Array,
  kind: PreparedHumanMutation["kind"],
  resourceId: string,
): string {
  const domain = kind === "live_shadow_message"
    ? "nautilo-live-shadow-message-prepared-journal-v1"
    : kind === "task_create" || kind === "task_update"
    ? "nautilo-protected-task-prepared-mutation-journal-v1"
    : kind.startsWith("artifact_")
    ? "nautilo-protected-artifact-prepared-mutation-journal-v1"
    : "nautilo-protected-memory-prepared-mutation-journal-v1";
  const prefix = encoder.encode(
    `${domain}\u0000${kind}\u0000${resourceId}\u0000`,
  );
  const hashed = sha256.create().update(prefix).update(bytes).digest();
  try {
    return toBase64url(hashed);
  } finally {
    prefix.fill(0);
    hashed.fill(0);
  }
}

export function inspectPreparedMutationCustodyFacts(
  value: PreparedHumanMutation,
): PreparedMutationCustodyFacts {
  const canonical = canonicalMutation(value);
  try {
    return Object.freeze({
      operationId: canonical.mutation.request.operationId,
      kind: canonical.mutation.kind,
      resourceId: canonical.resourceId,
      authenticatedRequestDigestBase64url: digest(
        canonical.bytes,
        canonical.mutation.kind,
        canonical.resourceId,
      ),
      canonicalBytes: canonical.bytes.length,
    });
  } finally {
    canonical.bytes.fill(0);
  }
}

function compareIndex(
  left: PreparedMutationJournalIndex,
  right: PreparedMutationJournalIndex,
): number {
  const byCreation = left.createdAt - right.createdAt;
  if (byCreation !== 0) return byCreation;
  return left.operationId < right.operationId
    ? -1
    : left.operationId > right.operationId ? 1 : 0;
}

function nextDelay(attempts: number): number {
  return Math.min(
    PREPARED_MUTATION_JOURNAL_LIMITS.retryMaxMs,
    PREPARED_MUTATION_JOURNAL_LIMITS.retryBaseMs * (2 ** Math.max(0, attempts - 1)),
  );
}

function copyIndex<Value extends PreparedMutationJournalIndex>(value: Value): Value {
  return Object.freeze({ ...value }) as unknown as Value;
}

async function indexes(port: PreparedMutationJournalVaultPort) {
  return (await port.listIndexes())
    .map(decodePreparedMutationJournalIndex)
    .filter(isPreparedHumanMutationJournalIndex)
    .map(copyIndex)
    .sort(compareIndex);
}

export function createPreparedMutationJournal(input: Readonly<{
  vault: PreparedMutationJournalVaultPort;
  now: () => number;
  auditDiscard?: (fact: Readonly<{
    operationId: string;
    kind: PreparedHumanMutation["kind"];
    state: PreparedMutationJournalState;
    reconciliation: "terminal" | "uncertain" | "unavailable";
  }>) => Promise<void> | void;
}>) {
  async function capacity(): Promise<PreparedMutationCapacity> {
    const current = await input.vault.listIndexes();
    const sealedBytes = current.reduce((sum, entry) => sum + entry.sealedBytes, 0);
    return Object.freeze({
      records: current.length,
      sealedBytes,
      warning: current.length >= PREPARED_MUTATION_JOURNAL_LIMITS.warningRecords
        || sealedBytes >= PREPARED_MUTATION_JOURNAL_LIMITS.warningTotalSealedBytes,
      full: current.length >= PREPARED_MUTATION_JOURNAL_LIMITS.maxRecords
        || sealedBytes >= PREPARED_MUTATION_JOURNAL_LIMITS.maxTotalSealedBytes,
    });
  }

  return Object.freeze({
    capacity,
    async putBeforeSend(value: PreparedHumanMutation) {
      const canonical = canonicalMutation(value);
      try {
        if (canonical.bytes.length > PREPARED_MUTATION_JOURNAL_LIMITS.maxCanonicalRecordBytes) {
          throw new PreparedMutationJournalBackpressureError(
            "Prepared mutation exceeds the journal per-record limit",
          );
        }
        const current = await indexes(input.vault);
        const requestDigest = digest(
          canonical.bytes,
          canonical.mutation.kind,
          canonical.resourceId,
        );
        const operationId = canonical.mutation.request.operationId;
        const existing = current.find((entry) => entry.operationId === operationId);
        if (existing !== undefined) {
          if (existing.authenticatedRequestDigestBase64url === requestDigest) {
            return Object.freeze({ status: "duplicate" as const, index: existing });
          }
          throw new PreparedMutationJournalCollisionError(
            "Prepared mutation operation ID collides with different authenticated bytes",
          );
        }
        const sealedBytes = current.reduce((sum, entry) => sum + entry.sealedBytes, 0);
        if (
          current.length >= PREPARED_MUTATION_JOURNAL_LIMITS.maxRecords
          || sealedBytes + canonical.bytes.length
            > PREPARED_MUTATION_JOURNAL_LIMITS.maxTotalSealedBytes
        ) throw new PreparedMutationJournalBackpressureError(
          "Prepared mutation journal is full",
        );
        const now = input.now();
        const common = {
          formatVersion: 1,
          operationId,
          kind: canonical.mutation.kind,
          authenticatedRequestDigestBase64url: requestDigest,
          canonicalBytes: canonical.bytes.length,
          sealedBytes: canonical.bytes.length,
          createdAt: now,
          updatedAt: now,
          attempts: 0,
          attemptWindowStartedAt: null,
          attemptsInWindow: 0,
          nextAttemptAt: now,
          lastAttemptAt: null,
          state: "pending",
        } as const;
        const index: PreparedMutationJournalIndex = "memoryId" in canonical.mutation
          ? Object.freeze({
              ...common,
              kind: canonical.mutation.kind,
              memoryId: canonical.mutation.memoryId,
            })
          : "artifactId" in canonical.mutation
          ? Object.freeze({
              ...common,
              kind: canonical.mutation.kind,
              artifactId: canonical.mutation.artifactId,
            })
          : "roomId" in canonical.mutation
          ? Object.freeze({
              ...common,
              kind: canonical.mutation.kind,
              roomId: canonical.mutation.roomId,
            })
          : Object.freeze({
              ...common,
              kind: canonical.mutation.kind,
              taskId: canonical.mutation.taskId,
            });
        const result = await input.vault.putSealed({ index, canonicalBody: canonical.bytes });
        if (result === "collision") throw new PreparedMutationJournalCollisionError(
          "Prepared mutation operation ID collided during atomic put",
        );
        return Object.freeze({
          status: result === "inserted" ? "inserted" as const : "duplicate" as const,
          index,
        });
      } finally {
        canonical.bytes.fill(0);
      }
    },
    async listStatus(): Promise<readonly PreparedMutationJournalIndex[]> {
      return Object.freeze(await indexes(input.vault));
    },
    async listDue(now = input.now()): Promise<readonly PreparedMutationRetryCandidate[]> {
      const current = await indexes(input.vault);
      const recent = current.reduce((sum, entry) =>
        sum + (entry.attemptWindowStartedAt !== null
            && now - entry.attemptWindowStartedAt
              < PREPARED_MUTATION_JOURNAL_LIMITS.attemptRateWindowMs
          ? entry.attemptsInWindow
          : 0), 0);
      const availableRate = Math.max(
        0,
        PREPARED_MUTATION_JOURNAL_LIMITS.maxAttemptsPerMinute - recent,
      );
      return Object.freeze(current.filter((entry) =>
        (entry.state === "pending" || entry.state === "retryable")
        && entry.nextAttemptAt <= now
      ).slice(0, Math.min(PREPARED_MUTATION_JOURNAL_LIMITS.maxBatch, availableRate))
        .map((entry) => Object.freeze({
          operationId: entry.operationId,
          authenticatedRequestDigestBase64url:
            entry.authenticatedRequestDigestBase64url,
          kind: entry.kind,
          attempts: entry.attempts,
          ageMs: Math.max(0, now - entry.createdAt),
        })));
    },
    async withPrepared<Result>(
      operationId: string,
      use: (mutation: PreparedHumanMutation) => Promise<Result> | Result,
    ): Promise<Result> {
      const entry = (await indexes(input.vault)).find((item) =>
        item.operationId === operationId
      );
      if (entry === undefined) throw new Error("Prepared mutation is missing");
      let bodyOpened = false;
      let bodyDecoded = false;
      try {
        return await input.vault.withOpenedBody(
          operationId,
          entry.authenticatedRequestDigestBase64url,
          async (body) => {
            bodyOpened = true;
            const owned = body.slice();
            try {
              if (digest(
                owned,
                entry.kind,
                "memoryId" in entry
                ? entry.memoryId
                  : "artifactId" in entry
                  ? entry.artifactId
                  : "roomId" in entry ? entry.roomId : entry.taskId,
              )
                !== entry.authenticatedRequestDigestBase64url) {
                throw new TypeError("Prepared mutation authenticated digest disagrees");
              }
              const mutation = decodeMutation(owned, entry);
              bodyDecoded = true;
              return await use(mutation);
            } finally {
              owned.fill(0);
            }
          },
        );
      } catch (cause) {
        if (!bodyOpened || !bodyDecoded) {
          const state: PreparedMutationJournalState = cause instanceof Error
            && /authority|locked|unavailable/u.test(cause.message)
            ? "missing_authority"
            : "corrupt";
          await input.vault.updateIndex(entry, Object.freeze({
            ...entry,
            state,
            updatedAt: input.now(),
            nextAttemptAt: Number.MAX_SAFE_INTEGER,
          }));
        }
        throw cause;
      }
    },
    async recordOutcome(inputOutcome: Readonly<{
      operationId: string;
      authenticatedRequestDigestBase64url: string;
      outcome: "completed" | "retryable" | PreparedMutationTerminalReason;
    }>): Promise<void> {
      const entry = (await indexes(input.vault)).find((item) =>
        item.operationId === inputOutcome.operationId
      );
      if (entry === undefined) throw new Error("Prepared mutation is missing");
      if (entry.authenticatedRequestDigestBase64url
        !== inputOutcome.authenticatedRequestDigestBase64url) {
        throw new PreparedMutationJournalCollisionError(
          "Prepared mutation outcome digest disagrees",
        );
      }
      if (inputOutcome.outcome === "completed") {
        if (!await input.vault.removeExact(
          entry.operationId,
          entry.authenticatedRequestDigestBase64url,
        )) throw new Error("Prepared mutation completion removal conflicted");
        return;
      }
      const now = input.now();
      const attempts = entry.attempts + 1;
      const inCurrentWindow = entry.attemptWindowStartedAt !== null
        && now - entry.attemptWindowStartedAt
          < PREPARED_MUTATION_JOURNAL_LIMITS.attemptRateWindowMs;
      const expired = now - entry.createdAt >= PREPARED_MUTATION_JOURNAL_LIMITS.retentionMs
        || attempts >= PREPARED_MUTATION_JOURNAL_LIMITS.maxAttempts;
      const state: PreparedMutationJournalState = inputOutcome.outcome === "retryable"
        ? expired ? "terminal_expired" : "retryable"
        : `terminal_${inputOutcome.outcome}`;
      if (!await input.vault.updateIndex(entry, Object.freeze({
        ...entry,
        attempts,
        attemptWindowStartedAt: inCurrentWindow
          ? entry.attemptWindowStartedAt
          : now,
        attemptsInWindow: inCurrentWindow ? entry.attemptsInWindow + 1 : 1,
        lastAttemptAt: now,
        nextAttemptAt: state === "retryable"
          ? now + nextDelay(attempts)
          : Number.MAX_SAFE_INTEGER,
        state,
        updatedAt: now,
      }))) throw new Error("Prepared mutation outcome update conflicted");
    },
    async discard(inputDiscard: Readonly<{
      operationId: string;
      confirmUncertainCommit: boolean;
      reconcile: (
        candidate: PreparedMutationRetryCandidate,
      ) => Promise<"terminal" | "uncertain" | "unavailable">;
    }>): Promise<void> {
      const entry = (await indexes(input.vault)).find((item) =>
        item.operationId === inputDiscard.operationId
      );
      if (entry === undefined) throw new Error("Prepared mutation is missing");
      const reconciliation = await inputDiscard.reconcile(Object.freeze({
        operationId: entry.operationId,
        authenticatedRequestDigestBase64url:
          entry.authenticatedRequestDigestBase64url,
        kind: entry.kind,
        attempts: entry.attempts,
        ageMs: Math.max(0, input.now() - entry.createdAt),
      }));
      if (reconciliation !== "terminal" && !inputDiscard.confirmUncertainCommit) {
        throw new Error("Prepared mutation discard requires uncertain-commit confirmation");
      }
      await input.auditDiscard?.(Object.freeze({
        operationId: entry.operationId,
        kind: entry.kind,
        state: entry.state,
        reconciliation,
      }));
      if (!await input.vault.removeExact(
        entry.operationId,
        entry.authenticatedRequestDigestBase64url,
      )) throw new Error("Prepared mutation discard conflicted");
    },
  });
}
