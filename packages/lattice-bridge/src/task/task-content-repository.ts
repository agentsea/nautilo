import { LATTICE_LIMITS } from "@nautilo/lattice-crypto";
import type {
  ProtectedTaskOperationalMetadataProjectionV1,
} from "@nautilo/types";
import { sha256 } from "@noble/hashes/sha2.js";

import type { TaskContentAuthorityV1 } from "./task-content-authority-v1.ts";
import type {
  TaskPayloadV1,
  TaskRunResultPayloadV1,
} from "./task-payload-v1.ts";
import { deriveTaskHistoricalContentCryptoObjectIdV1 } from "./task-historical-content-identity.ts";
import { hasTaskOrdinaryFallbackReceiptV1 } from "./task-ordinary-fallback-receipt.ts";
import { parseTaskHistoricalRepairProvenanceV1,
  type TaskHistoricalRepairProvenanceV1 } from
  "./task-historical-repair-provenance.ts";

export const TASK_CONTENT_OBJECT_ID_VERSION_V1 = 1 as const;
export const TASK_CONTENT_PAYLOAD_VERSION_V1 = 1 as const;
export const TASK_DEFINITION_OBJECT_TYPE_V1 =
  "nautilo-task-definition-v1" as const;
export const TASK_RUN_RESULT_OBJECT_TYPE_V1 =
  "nautilo-task-run-result-v1" as const;
export const TASK_CONTENT_RECONCILE_MAX_ATTEMPTS = 8;
export const TASK_CONTENT_RECONCILE_MAX_BATCH = LATTICE_LIMITS.batchItems;

const TASK_DEFINITION_OBJECT_ID_DOMAIN =
  "nautilo/task-definition-crypto-object/v1";
const TASK_RUN_RESULT_OBJECT_ID_DOMAIN =
  "nautilo/task-run-result-crypto-object/v1";
const TASK_CONTENT_AUTHORITY_FINGERPRINT_DOMAIN =
  "nautilo/task-content-authority/v1";
const TASK_CONTENT_AUTHORITY_IDENTITY_FINGERPRINT_DOMAIN =
  "nautilo/task-content-authority-identity/v1";
const TASK_CONTENT_NAMESPACE_FINGERPRINT_DOMAIN =
  "nautilo/task-content-namespace/v1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const encoder = new TextEncoder();

export type TaskDefinitionContentCoordinateV1 = Readonly<{
  kind: "definition";
  taskId: string;
  contentRevision: number;
}>;

export type TaskRunResultContentCoordinateV1 = Readonly<{
  kind: "run_result";
  taskId: string;
  taskRunId: string;
  contentRevision: number;
}>;

export type TaskContentCoordinateV1 =
  | TaskDefinitionContentCoordinateV1
  | TaskRunResultContentCoordinateV1;

export type TaskContentPayloadV1 =
  | Readonly<{
      coordinate: TaskDefinitionContentCoordinateV1;
      payload: TaskPayloadV1;
    }>
  | Readonly<{
      coordinate: TaskRunResultContentCoordinateV1;
      payload: TaskRunResultPayloadV1;
    }>;

export type TaskContentObjectTypeV1 =
  | typeof TASK_DEFINITION_OBJECT_TYPE_V1
  | typeof TASK_RUN_RESULT_OBJECT_TYPE_V1;

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function assertUuid(label: string, value: string): void {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
}

function assertPortableId(label: string, value: string): void {
  if (
    typeof value !== "string"
    || !PORTABLE_ID.test(value)
    || encoder.encode(value).length > LATTICE_LIMITS.idBytes
  ) throw new TypeError(`${label} must be a bounded portable identifier`);
}

function assertRevision(label: string, value: number, minimum: number): void {
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > 2_147_483_647
  ) throw new RangeError(`${label} is invalid`);
}

function assertDigest(label: string, value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(`${label} must contain exactly 32 bytes`);
  }
}

export function assertTaskContentCoordinateV1(
  coordinate: TaskContentCoordinateV1,
): void {
  if (coordinate === null || typeof coordinate !== "object") {
    throw new TypeError("Task content coordinate is invalid");
  }
  assertUuid("Task ID", coordinate.taskId);
  assertRevision("Task content revision", coordinate.contentRevision, 1);
  if (coordinate.kind === "run_result") {
    assertUuid("Task Run ID", coordinate.taskRunId);
  } else if (coordinate.kind !== "definition") {
    throw new TypeError("Task content kind is invalid");
  }
}

export function taskContentObjectTypeV1(
  coordinate: TaskContentCoordinateV1,
): TaskContentObjectTypeV1 {
  assertTaskContentCoordinateV1(coordinate);
  return coordinate.kind === "definition"
    ? TASK_DEFINITION_OBJECT_TYPE_V1
    : TASK_RUN_RESULT_OBJECT_TYPE_V1;
}

export function sameTaskContentCoordinateV1(
  left: TaskContentCoordinateV1,
  right: TaskContentCoordinateV1,
): boolean {
  return left.kind === right.kind
    && left.taskId === right.taskId
    && left.contentRevision === right.contentRevision
    && (left.kind === "definition"
      || (right.kind === "run_result" && left.taskRunId === right.taskRunId));
}

export function deriveTaskContentCryptoObjectIdV1(
  coordinate: TaskContentCoordinateV1,
): string {
  assertTaskContentCoordinateV1(coordinate);
  const domain = coordinate.kind === "definition"
    ? TASK_DEFINITION_OBJECT_ID_DOMAIN
    : TASK_RUN_RESULT_OBJECT_ID_DOMAIN;
  const identity = coordinate.kind === "definition"
    ? `${coordinate.taskId}\n${coordinate.contentRevision}`
    : `${coordinate.taskId}\n${coordinate.taskRunId}\n${coordinate.contentRevision}`;
  const prefix = coordinate.kind === "definition"
    ? "task-definition:v1:"
    : "task-run-result:v1:";
  return `${prefix}${bytesToHex(sha256(encoder.encode(`${domain}\n${identity}`)))}`;
}

/** Validate the closed persisted historical scheme without changing native object identities. */
export function taskContentRevisionObjectIdV1(input: Readonly<{
  coordinate: TaskContentCoordinateV1;
  namespaceId: string;
  historicalRepair?: TaskHistoricalRepairProvenanceV1 | null;
}>): string {
  const provenance = input.historicalRepair == null ? null
    : parseTaskHistoricalRepairProvenanceV1(input.historicalRepair);
  if (provenance !== null && input.coordinate.contentRevision !== 1) {
    throw new TypeError("Historical Task content revision is invalid");
  }
  return provenance?.version === 2
    ? deriveTaskHistoricalContentCryptoObjectIdV1({ coordinate: input.coordinate,
        namespaceId: input.namespaceId,
        sourceDigest: Uint8Array.from(provenance.sourceDigest.match(/../gu)!, byte => Number.parseInt(byte, 16)) })
    : deriveTaskContentCryptoObjectIdV1(input.coordinate);
}

export function assertTaskContentAuthorityV1(
  authority: TaskContentAuthorityV1,
): void {
  if (
    authority === null
    || typeof authority !== "object"
    || authority.authorityVersion !== 1
    || authority.kind !== "requester_private_namespace"
    || authority.keyClass !== "ai"
  ) throw new TypeError("Task content authority is invalid");
  assertPortableId("Task requester Human ID", authority.requesterHumanId);
  assertPortableId("Task content Namespace ID", authority.namespaceId);
  assertPortableId("Task content Domain ID", authority.domainId);
  assertRevision(
    "Task content Namespace access revision",
    authority.expectedAccessRevision,
    0,
  );
  assertRevision(
    "Task content policy revision",
    authority.expectedPolicyRevision,
    1,
  );
}

export function fingerprintTaskContentAuthorityV1(
  authority: TaskContentAuthorityV1,
): Uint8Array {
  assertTaskContentAuthorityV1(authority);
  return sha256(encoder.encode([
    TASK_CONTENT_AUTHORITY_FINGERPRINT_DOMAIN,
    authority.requesterHumanId,
    authority.namespaceId,
    authority.domainId,
    String(authority.expectedAccessRevision),
    String(authority.expectedPolicyRevision),
    authority.keyClass,
  ].join("\n")));
}

/**
 * Stable Task audience identity. Access and policy revisions intentionally do
 * not participate: a valid Namespace rewrap must not invalidate an already
 * published Task object or its exact replay receipt.
 */
export function fingerprintTaskContentAuthorityIdentityV1(
  authority: Pick<
    TaskContentAuthorityV1,
    "requesterHumanId" | "namespaceId" | "keyClass"
  >,
): Uint8Array {
  assertPortableId("Task requester Human ID", authority.requesterHumanId);
  assertPortableId("Task content Namespace ID", authority.namespaceId);
  if (authority.keyClass !== "ai") {
    throw new TypeError("Task content authority identity is invalid");
  }
  return sha256(encoder.encode([
    TASK_CONTENT_AUTHORITY_IDENTITY_FINGERPRINT_DOMAIN,
    authority.requesterHumanId,
    authority.namespaceId,
    authority.keyClass,
  ].join("\n")));
}

export function fingerprintTaskContentNamespaceV1(
  namespaceId: string,
): Uint8Array {
  assertPortableId("Task content Namespace ID", namespaceId);
  return sha256(encoder.encode(
    `${TASK_CONTENT_NAMESPACE_FINGERPRINT_DOMAIN}\n${namespaceId}`,
  ));
}

export type TaskContentFailureCode =
  | "authority_stale"
  | "crypto_absent"
  | "crypto_incomplete"
  | "crypto_mismatch"
  | "storage_transient"
  | "mapping_conflict"
  | "retry_exhausted";

export type TaskContentRevisionDisposition =
  | "active"
  | "mapped"
  | "quarantined"
  | "stale_mapping";

export interface TaskContentRevisionLifecycleV1 {
  readonly sequence: number;
  readonly coordinate: TaskContentCoordinateV1;
  readonly operationId: string;
  readonly requestDigest: Uint8Array;
  readonly requesterHumanId: string;
  readonly namespaceId: string;
  readonly cryptoObjectId: string;
  readonly objectType: TaskContentObjectTypeV1;
  readonly payloadVersion: typeof TASK_CONTENT_PAYLOAD_VERSION_V1;
  readonly representation: "protected" | "dual";
  readonly authorityFingerprint: Uint8Array;
  readonly requiredNamespaceFingerprint: Uint8Array;
  readonly operationalMetadata: ProtectedTaskOperationalMetadataProjectionV1 | null;
  readonly historicalRepair?: TaskHistoricalRepairProvenanceV1 | null;
  readonly completion: "pending" | "complete";
  readonly disposition: TaskContentRevisionDisposition;
  readonly attemptCount: number;
  readonly nextAttemptAt: Date | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly failureCode: TaskContentFailureCode | null;
  readonly cryptoCompletedAt: Date | null;
}

export interface TaskContentProductMappingV1 {
  readonly coordinate: TaskContentCoordinateV1;
  readonly namespaceId: string;
  readonly representation: "protected" | "dual";
  readonly cryptoObjectId: string | null;
  readonly cryptoAccessRevision: number;
  readonly cryptoRequiredNamespaceFingerprint: Uint8Array | null;
  readonly cryptoMappingState: "verified" | "stale";
}

export interface TaskContentRevisionStateV1 {
  readonly product: TaskContentProductMappingV1 | null;
  readonly lifecycle: TaskContentRevisionLifecycleV1;
  readonly authority: TaskContentAuthorityV1;
}

export interface PreparedTaskContentCryptoRevisionV1 {
  readonly coordinate: TaskContentCoordinateV1;
  readonly objectId: string;
  readonly objectType: TaskContentObjectTypeV1;
  readonly payloadVersion: typeof TASK_CONTENT_PAYLOAD_VERSION_V1;
  readonly namespaceId: string;
  readonly authorityFingerprint: Uint8Array;
}

export type VerifiedTaskContentCryptoRevisionV1 =
  PreparedTaskContentCryptoRevisionV1;

export type TaskContentCryptoRevisionReferenceV1 = Readonly<{
  coordinate: TaskContentCoordinateV1;
  objectId: string;
  objectType: TaskContentObjectTypeV1;
  expectedAccessRevision: number;
  expectedAuthorityFingerprint: Uint8Array;
  expectedAuthorityIdentityFingerprint: Uint8Array;
  expectedGenesisManifestHash?: Uint8Array;
  historicalRepair?: Readonly<{ provenance: TaskHistoricalRepairProvenanceV1; namespaceId: string }>;
  /** An inspector-authenticated historical prepared object, never a numeric override. */
  historicalStagedPrepared?: PreparedTaskContentCryptoRevisionV1;
}>;

export type TaskContentProductMappingCasResult =
  | "applied"
  | "duplicate"
  | "lease_lost"
  | "stale"
  | "missing"
  | "wrong_authority";

/** Opaque callback-live custody; only the foreground durable inspector mints it. */
export interface VerifiedForegroundTaskDefinitionPublication { readonly kind: "verified_foreground_task_definition" }

declare const TASK_ORDINARY_FALLBACK_REPAIR_SOURCE_V1: unique symbol;

/**
 * Callback-live claim for one exact persisted ordinary-fallback source. The
 * product store remains authoritative and revalidates every coordinate while
 * holding the Task row lock before it admits the next protected revision.
 */
export type TaskOrdinaryFallbackRepairSourceProofV1 = Readonly<{
  [TASK_ORDINARY_FALLBACK_REPAIR_SOURCE_V1]: true;
  taskId: string;
  sourceMutationVersion: string;
  sourceUpdatedAt: Date;
  sourceContentRevision: number;
  sourceNamespaceId: string;
  sourceCryptoObjectId: string;
  sourceCryptoAccessRevision: number;
  sourceRequiredNamespaceFingerprint: Uint8Array;
  fallbackOperationId: string;
  fallbackRequestDigest: Uint8Array;
  fallbackReason: "target_encryption_not_ready";
  fallbackPolicyRevision: number;
  fallbackCompletedAt: Date;
}>;

const taskOrdinaryFallbackRepairSourceProofs = new WeakSet<object>();

export function prepareTaskOrdinaryFallbackRepairSourceProofV1(
  input: Omit<
    TaskOrdinaryFallbackRepairSourceProofV1,
    typeof TASK_ORDINARY_FALLBACK_REPAIR_SOURCE_V1
  >,
): TaskOrdinaryFallbackRepairSourceProofV1 {
  assertUuid("Fallback repair Task ID", input.taskId);
  if (!/^[0-9]+$/u.test(input.sourceMutationVersion)) {
    throw new TypeError("Fallback repair mutation version is invalid");
  }
  assertRevision("Fallback repair source revision", input.sourceContentRevision, 1);
  assertPortableId("Fallback repair Namespace ID", input.sourceNamespaceId);
  assertPortableId("Fallback repair crypto object ID", input.sourceCryptoObjectId);
  assertRevision("Fallback repair crypto access revision", input.sourceCryptoAccessRevision, 0);
  assertDigest(
    "Fallback repair Namespace fingerprint",
    input.sourceRequiredNamespaceFingerprint,
  );
  if (!hasTaskOrdinaryFallbackReceiptV1({
    ordinaryFallbackOperationId: input.fallbackOperationId,
    ordinaryFallbackRequestDigest: input.fallbackRequestDigest,
    ordinaryFallbackReason: input.fallbackReason,
    ordinaryFallbackPolicyRevision: input.fallbackPolicyRevision,
    ordinaryFallbackCompletedAt: input.fallbackCompletedAt,
  })) {
    throw new TypeError("Fallback repair receipt is invalid");
  }
  if (!(input.sourceUpdatedAt instanceof Date)
    || !Number.isFinite(input.sourceUpdatedAt.getTime())) {
    throw new TypeError("Fallback repair timestamp is invalid");
  }
  const proof = Object.freeze({
    ...input,
    sourceUpdatedAt: new Date(input.sourceUpdatedAt),
    sourceRequiredNamespaceFingerprint:
      input.sourceRequiredNamespaceFingerprint.slice(),
    fallbackRequestDigest: input.fallbackRequestDigest.slice(),
    fallbackCompletedAt: new Date(input.fallbackCompletedAt),
  }) as TaskOrdinaryFallbackRepairSourceProofV1;
  taskOrdinaryFallbackRepairSourceProofs.add(proof);
  return proof;
}

export function isTaskOrdinaryFallbackRepairSourceProofV1(
  value: unknown,
): value is TaskOrdinaryFallbackRepairSourceProofV1 {
  return typeof value === "object" && value !== null
    && taskOrdinaryFallbackRepairSourceProofs.has(value);
}

export interface TaskContentProductStorePort {
  reserveRevision(input: Readonly<{
    operationId: string;
    coordinate: TaskContentCoordinateV1;
    requesterHumanId: string;
    namespaceId: string;
    authorityFingerprint: Uint8Array;
    requiredNamespaceFingerprint: Uint8Array;
    representation: "protected" | "dual";
    requestDigest: Uint8Array;
    cryptoObjectId: string;
    objectType: TaskContentObjectTypeV1;
    payloadVersion: typeof TASK_CONTENT_PAYLOAD_VERSION_V1;
    operationalMetadata: ProtectedTaskOperationalMetadataProjectionV1 | null;
    /** Only a source-bound authenticated revision may reserve historical content. */
    historicalPrepared?: PreparedTaskContentCryptoRevisionV1;
    /** Exact receipt-bound stale dual predecessor; revalidated under row lock. */
    fallbackRepairSource?: TaskOrdinaryFallbackRepairSourceProofV1;
  }>): Promise<
    | Readonly<{
        status: "reserved" | "replayed";
        state: TaskContentRevisionStateV1;
      }>
    | Readonly<{ status: "conflict" | "stale" }>
  >;
  getRevision(
    coordinate: TaskContentCoordinateV1,
  ): Promise<TaskContentRevisionStateV1 | null>;
  getRevisionByOperation(input: Readonly<{
    operationId: string;
  }>): Promise<
    | Readonly<{ status: "found"; state: TaskContentRevisionStateV1 }>
    | Readonly<{ status: "missing" | "conflict" | "authority_unavailable" }>
  >;
  markCryptoComplete(input: Readonly<{
    coordinate: TaskContentCoordinateV1;
    cryptoObjectId: string;
    leaseToken: string | null;
  }>): Promise<"applied" | "duplicate" | "missing" | "conflict">;
  compareAndSwapCryptoMapping(input: Readonly<{
    coordinate: TaskContentCoordinateV1;
    cryptoObjectId: string;
    expectedAuthorityFingerprint: Uint8Array;
    expectedRepresentation: "protected" | "dual";
    historicalStagedPrepared?: PreparedTaskContentCryptoRevisionV1;
    foregroundDefinitionProof?: VerifiedForegroundTaskDefinitionPublication;
    /** Live Human metadata inspection; existing mapped content only. */
    mappedMetadataProof?: VerifiedForegroundTaskDefinitionPublication;
    leaseToken: string | null;
  }>): Promise<TaskContentProductMappingCasResult>;
  quarantineRevision(input: Readonly<{
    coordinate: TaskContentCoordinateV1;
    leaseToken: string | null;
    failureCode: TaskContentFailureCode;
  }>): Promise<"applied" | "duplicate" | "missing" | "conflict">;
  markAuthorityStale(input: Readonly<{
    coordinate: TaskContentCoordinateV1;
    leaseToken: string | null;
  }>): Promise<TaskContentRevisionLifecycleV1 | null>;
  claimReconciliationCandidates(input: Readonly<{
    leaseToken: string;
    limit: number;
  }>): Promise<readonly TaskContentRevisionStateV1[]>;
  claimReconciliationCoordinate?(input: Readonly<{
    coordinate: TaskContentCoordinateV1;
    operationId: string;
    leaseToken: string;
  }>): Promise<TaskContentRevisionStateV1 | null>;
  failReconciliationClaim(input: Readonly<{
    coordinate: TaskContentCoordinateV1;
    leaseToken: string;
    failureCode: TaskContentFailureCode;
  }>): Promise<TaskContentRevisionLifecycleV1 | null>;
}

export interface AtomicTaskContentCryptoCompletionPort {
  complete(
    revision: PreparedTaskContentCryptoRevisionV1,
  ): Promise<"created" | "duplicate">;
  verify(
    reference: TaskContentCryptoRevisionReferenceV1,
  ): Promise<VerifiedTaskContentCryptoRevisionV1 | null>;
}

export type TaskContentCompletionResult =
  | Readonly<{
      status: "mapped" | "replayed";
      coordinate: TaskContentCoordinateV1;
      cryptoObjectId: string;
    }>
  | Readonly<{
      status: "orphaned";
      reason: "stale_mapping";
      coordinate: TaskContentCoordinateV1;
      cryptoObjectId: string;
    }>;

export type TaskContentReconciliationOutcome =
  | "mapped"
  | "pending"
  | "orphaned"
  | "quarantined";

export interface TaskContentRepository {
  reserveRevision(input: Readonly<{
    operationId: string;
    requestDigest: Uint8Array;
    representation: "protected" | "dual";
    authority: TaskContentAuthorityV1;
    prepared: PreparedTaskContentCryptoRevisionV1;
    operationalMetadata: ProtectedTaskOperationalMetadataProjectionV1 | null;
    historicalRepair?: true;
    fallbackRepairSource?: TaskOrdinaryFallbackRepairSourceProofV1;
  }>): Promise<
    | Readonly<{
        status: "reserved" | "replayed";
        coordinate: TaskContentCoordinateV1;
        cryptoObjectId: string;
      }>
    | Readonly<{ status: "conflict" | "stale" }>
  >;
  lookupPreparedReplay(input: Readonly<{
    operationId: string;
    requestDigest: Uint8Array;
    representation: "protected" | "dual";
    coordinate: TaskDefinitionContentCoordinateV1;
    requesterHumanId: string;
    namespaceId: string;
  }>): Promise<
    | Readonly<{ status: "exact"; authority: TaskContentAuthorityV1 }>
    | Readonly<{ status: "unavailable" }>
  >;
  completeRevision(input: Readonly<{
    coordinate: TaskContentCoordinateV1;
    prepared: PreparedTaskContentCryptoRevisionV1;
  }>): Promise<TaskContentCompletionResult>;
  reconcilePending(input: Readonly<{
    leaseToken: string;
    limit: number;
  }>): Promise<Readonly<{
    outcomes: readonly Readonly<{
      sequence: number;
      coordinate: TaskContentCoordinateV1;
      outcome: TaskContentReconciliationOutcome;
    }>[];
  }>>;
  reconcileCoordinate(input: Readonly<{
    coordinate: TaskContentCoordinateV1;
    operationId: string;
    leaseToken: string;
    publishProduct?: () => Promise<void>;
  }>): Promise<TaskContentReconciliationOutcome>;
}

export function assertTaskContentRevisionLifecycleV1(
  lifecycle: TaskContentRevisionLifecycleV1,
): void {
  if (!Number.isSafeInteger(lifecycle.sequence) || lifecycle.sequence < 1) {
    throw new TypeError("Task content lifecycle sequence is invalid");
  }
  assertTaskContentCoordinateV1(lifecycle.coordinate);
  if (lifecycle.historicalRepair != null) {
    parseTaskHistoricalRepairProvenanceV1(lifecycle.historicalRepair);
    if (lifecycle.representation !== "dual" || lifecycle.coordinate.contentRevision !== 1
      || lifecycle.historicalRepair.signedRequestDigest !== bytesToHex(lifecycle.requestDigest)) {
      throw new TypeError("Historical Task repair lifecycle coordinates disagree");
    }
  }
  assertPortableId("Task content operation ID", lifecycle.operationId);
  assertUuid("Task requester Human ID", lifecycle.requesterHumanId);
  assertUuid("Task content Namespace ID", lifecycle.namespaceId);
  assertPortableId("Task content crypto object ID", lifecycle.cryptoObjectId);
  if (
    lifecycle.cryptoObjectId
      !== taskContentRevisionObjectIdV1(lifecycle)
    || lifecycle.objectType !== taskContentObjectTypeV1(lifecycle.coordinate)
    || lifecycle.payloadVersion !== TASK_CONTENT_PAYLOAD_VERSION_V1
  ) throw new Error("Task content lifecycle coordinates are not canonical");
  assertDigest(
    "Task content request digest",
    lifecycle.requestDigest,
  );
  assertDigest("Task content authority fingerprint", lifecycle.authorityFingerprint);
  assertDigest(
    "Task content required Namespace fingerprint",
    lifecycle.requiredNamespaceFingerprint,
  );
  if (!sameBytesForContract(
    lifecycle.requiredNamespaceFingerprint,
    fingerprintTaskContentNamespaceV1(lifecycle.namespaceId),
  )) throw new Error("Task content Namespace fingerprint is not canonical");
  if (
    (lifecycle.coordinate.kind === "definition"
      && (lifecycle.operationalMetadata === null
        || typeof lifecycle.operationalMetadata !== "object"
        || Array.isArray(lifecycle.operationalMetadata)))
    || (lifecycle.coordinate.kind === "run_result"
      && lifecycle.operationalMetadata !== null)
  ) throw new TypeError("Task content operational metadata is invalid");
  if (
    lifecycle.representation !== "protected"
    && lifecycle.representation !== "dual"
  ) throw new TypeError("Task content representation is invalid");
  if (
    !Number.isSafeInteger(lifecycle.attemptCount)
    || lifecycle.attemptCount < 0
    || lifecycle.attemptCount > TASK_CONTENT_RECONCILE_MAX_ATTEMPTS
  ) throw new TypeError("Task content lifecycle attempt count is invalid");
  if (
    (lifecycle.leaseToken === null) !== (lifecycle.leaseExpiresAt === null)
    || (lifecycle.leaseToken !== null && !UUID.test(lifecycle.leaseToken))
    || (lifecycle.nextAttemptAt !== null
      && !Number.isFinite(lifecycle.nextAttemptAt.getTime()))
    || (lifecycle.leaseExpiresAt !== null
      && !Number.isFinite(lifecycle.leaseExpiresAt.getTime()))
  ) throw new TypeError("Task content lifecycle retry state is invalid");
  if (
    (lifecycle.completion === "pending"
      && (lifecycle.cryptoCompletedAt !== null
        || !["active", "quarantined"].includes(
          lifecycle.disposition,
        )))
    || (lifecycle.completion === "complete"
      && (lifecycle.cryptoCompletedAt === null
        || !Number.isFinite(lifecycle.cryptoCompletedAt.getTime())
        || ![
          "active",
          "mapped",
          "quarantined",
          "stale_mapping",
        ].includes(lifecycle.disposition)))
    || (lifecycle.disposition === "mapped"
      && lifecycle.failureCode !== null)
    || (["quarantined", "stale_mapping"].includes(
      lifecycle.disposition,
    ) && lifecycle.failureCode === null)
    || (lifecycle.failureCode === "authority_stale"
      && lifecycle.disposition !== "stale_mapping"
      && lifecycle.disposition !== "quarantined")
    || (lifecycle.failureCode === "retry_exhausted"
      && (lifecycle.disposition !== "quarantined"
        || lifecycle.attemptCount !== TASK_CONTENT_RECONCILE_MAX_ATTEMPTS))
  ) throw new TypeError("Task content lifecycle state is incoherent");
}

function sameBytesForContract(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/** Historical mapping waits for an authorized device to reprove its exact source. */
export class TaskHistoricalRepairPublicationUnavailableError extends Error {
  override readonly name = "TaskHistoricalRepairPublicationUnavailableError";
  constructor() { super("Task historical repair source authority is temporarily unavailable"); }
}


/** A compatible policy may return later; immutable cancellation publication stays retryable. */
export class TaskCancellationPublicationPolicyUnavailableError extends Error {
  override readonly name = "TaskCancellationPublicationPolicyUnavailableError";
  constructor() { super("Task cancellation publication policy is temporarily unavailable"); }
}
