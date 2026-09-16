import { sha256 } from "@noble/hashes/sha2.js";

export const MEMORY_OBJECT_ID_VERSION = 1 as const;
export const MEMORY_OBJECT_TYPE = "nautilo-memory-v1" as const;
export const MEMORY_PAYLOAD_VERSION = 1 as const;
export const MEMORY_RECONCILE_MAX_ATTEMPTS = 8;
export const MEMORY_RECONCILE_MAX_BATCH = 256;

const MEMORY_OBJECT_ID_DOMAIN = "nautilo/memory-crypto-object/v1";
const MEMORY_NAMESPACE_SET_DOMAIN = "nautilo/memory-required-namespaces/v1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const encoder = new TextEncoder();

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

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError("Memory content revision must be a positive integer");
  }
}

function assertDigest(label: string, value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(`${label} must contain exactly 32 bytes`);
  }
}

function assertPortableId(label: string, value: string): void {
  if (
    typeof value !== "string"
    || !PORTABLE_ID.test(value)
    || encoder.encode(value).length > 128
  ) {
    throw new TypeError(`${label} must be a bounded portable identifier`);
  }
}

function namespacePreimage(namespaceIds: readonly string[]): Uint8Array {
  if (namespaceIds.length < 1 || namespaceIds.length > 256) {
    throw new RangeError("Required Memory Namespace set is not bounded");
  }
  let previous: string | null = null;
  for (const namespaceId of namespaceIds) {
    assertUuid("Required Memory Namespace ID", namespaceId);
    if (previous !== null && namespaceId <= previous) {
      throw new TypeError(
        "Required Memory Namespace IDs must be unique and sorted",
      );
    }
    previous = namespaceId;
  }
  return encoder.encode(
    `${MEMORY_NAMESPACE_SET_DOMAIN}\n${namespaceIds.length}\n${
      namespaceIds.map((value) => `${encoder.encode(value).length}:${value}`)
        .join("\n")
    }`,
  );
}

export function fingerprintRequiredMemoryNamespaces(
  namespaceIds: readonly string[],
): Uint8Array {
  return sha256(namespacePreimage(namespaceIds));
}

export function deriveMemoryCryptoObjectIdV1(input: Readonly<{
  memoryId: string;
  contentRevision: number;
}>): string {
  assertUuid("Memory ID", input.memoryId);
  assertRevision(input.contentRevision);
  return `memory:v1:${bytesToHex(sha256(encoder.encode(
    `${MEMORY_OBJECT_ID_DOMAIN}\n${input.memoryId}\n${input.contentRevision}`,
  )))}`;
}

export type MemoryFailureCode =
  | "namespace_unresolved"
  | "scope_origin_unresolved"
  | "crypto_absent"
  | "crypto_incomplete"
  | "crypto_mismatch"
  | "authorization_unavailable"
  | "recipient_unavailable"
  | "target_encryption_not_ready"
  | "embedding_unavailable"
  | "storage_transient"
  | "mapping_conflict"
  | "retry_exhausted";

export type MemoryRevisionDisposition =
  | "active"
  | "mapped"
  | "blocked"
  | "quarantined"
  | "superseded"
  | "hard_delete"
  | "stale_mapping";

export interface MemoryRevisionLifecycle {
  readonly sequence: number;
  readonly memoryId: string;
  readonly contentRevision: number;
  readonly anchorNamespaceId: string;
  readonly cryptoObjectId: string;
  readonly payloadVersion: typeof MEMORY_PAYLOAD_VERSION;
  readonly allocationRequestDigest: Uint8Array;
  readonly requiredNamespaceFingerprint: Uint8Array;
  readonly completion: "pending" | "complete";
  readonly disposition: MemoryRevisionDisposition;
  readonly attemptCount: number;
  readonly nextAttemptAt: Date | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly failureCode: MemoryFailureCode | null;
  readonly cryptoCompletedAt: Date | null;
}

export interface MemoryProductMapping {
  readonly memoryId: string;
  readonly contentRevision: number;
  readonly cryptoObjectId: string | null;
  readonly cryptoAccessRevision: number;
  readonly cryptoRequiredNamespaceFingerprint: Uint8Array | null;
}

export interface MemoryRevisionState {
  readonly product: MemoryProductMapping | null;
  readonly lifecycle: MemoryRevisionLifecycle;
  readonly requiredNamespaceIds: readonly string[];
}

export interface PreparedMemoryCryptoRevision {
  readonly memoryId: string;
  readonly contentRevision: number;
  readonly objectId: string;
  readonly objectType: typeof MEMORY_OBJECT_TYPE;
  readonly payloadVersion: typeof MEMORY_PAYLOAD_VERSION;
  readonly requiredNamespaceIds: readonly string[];
}

export interface VerifiedMemoryCryptoRevision
  extends PreparedMemoryCryptoRevision {
  /**
   * Public signed history required by a Human client to verify a common-v5
   * Agent/processor head independently after restart. Returned bytes transfer
   * to the caller for wiping.
   */
  readonly accessSignerEvidence?: readonly Readonly<{
    kind: "agent_runtime_publication" | "processor_authorization";
    evidenceBytes: Uint8Array;
  }>[];
}

/**
 * Product-owned coordinates supplied when authenticating durable crypto
 * state after restart. Crypto storage cannot reverse the opaque object-id
 * digest to recover Memory identity or revision.
 */
export type MemoryCryptoRevisionReference = Readonly<{
  readonly memoryId: string;
  readonly contentRevision: number;
  readonly objectId: string;
  /** Product-mapped active object-access revision, not content revision. */
  readonly expectedAccessRevision: number;
  readonly expectedActiveNamespaceFingerprint: Uint8Array;
}>;

export type MemoryProductMappingCasResult =
  | "applied"
  | "duplicate"
  | "lease_lost"
  | "stale"
  | "missing"
  | "wrong_authority";

export interface MemoryProductStorePort {
  getRevision(input: Readonly<{
    memoryId: string;
    contentRevision: number;
  }>): Promise<MemoryRevisionState | null>;
  markCryptoComplete(input: Readonly<{
    memoryId: string;
    contentRevision: number;
    cryptoObjectId: string;
    leaseToken: string | null;
  }>): Promise<"applied" | "duplicate" | "missing" | "conflict">;
  compareAndSwapCryptoMapping(input: Readonly<{
    memoryId: string;
    contentRevision: number;
    cryptoObjectId: string;
    expectedRequiredNamespaceFingerprint: Uint8Array;
    leaseToken: string | null;
  }>): Promise<MemoryProductMappingCasResult>;
  quarantineRevision(input: Readonly<{
    memoryId: string;
    contentRevision: number;
    leaseToken: string | null;
    failureCode: MemoryFailureCode;
  }>): Promise<"applied" | "duplicate" | "missing" | "conflict">;
  claimReconciliationCandidates(input: Readonly<{
    leaseToken: string;
    limit: number;
  }>): Promise<readonly MemoryRevisionState[]>;
  failReconciliationClaim(input: Readonly<{
    memoryId: string;
    contentRevision: number;
    leaseToken: string;
    failureCode: MemoryFailureCode;
  }>): Promise<MemoryRevisionLifecycle | null>;
}

export interface AtomicMemoryCryptoCompletionPort {
  complete(
    revision: PreparedMemoryCryptoRevision,
  ): Promise<"created" | "duplicate">;
  verify(
    reference: MemoryCryptoRevisionReference,
  ): Promise<VerifiedMemoryCryptoRevision | null>;
}

export type MemoryCompletionResult = Readonly<{
  status: "mapped" | "replayed";
  memoryId: string;
  contentRevision: number;
  cryptoObjectId: string;
}> | Readonly<{
  status: "orphaned";
  reason: "stale_mapping" | "superseded" | "hard_delete";
  memoryId: string;
  contentRevision: number;
  cryptoObjectId: string;
}>;

export type MemoryReconciliationOutcome =
  | "mapped"
  | "pending"
  | "blocked"
  | "orphaned"
  | "quarantined";

export interface MemoryRepository {
  completeRevision(input: Readonly<{
    memoryId: string;
    expectedRevision: number;
    prepared: PreparedMemoryCryptoRevision;
  }>): Promise<MemoryCompletionResult>;
  reconcilePending(input: Readonly<{
    leaseToken: string;
    limit: number;
  }>): Promise<Readonly<{
    outcomes: readonly Readonly<{
      sequence: number;
      memoryId: string;
      contentRevision: number;
      outcome: MemoryReconciliationOutcome;
    }>[];
  }>>;
}

export function assertMemoryRevisionLifecycle(
  lifecycle: MemoryRevisionLifecycle,
): void {
  if (!Number.isSafeInteger(lifecycle.sequence) || lifecycle.sequence < 1) {
    throw new TypeError("Memory lifecycle sequence is invalid");
  }
  assertUuid("Memory ID", lifecycle.memoryId);
  assertRevision(lifecycle.contentRevision);
  assertUuid("Memory anchor Namespace ID", lifecycle.anchorNamespaceId);
  assertPortableId("Memory crypto object ID", lifecycle.cryptoObjectId);
  if (
    lifecycle.cryptoObjectId !== deriveMemoryCryptoObjectIdV1(lifecycle)
    || lifecycle.payloadVersion !== MEMORY_PAYLOAD_VERSION
  ) throw new Error("Memory lifecycle crypto coordinates are not canonical");
  assertDigest(
    "Memory allocation request digest",
    lifecycle.allocationRequestDigest,
  );
  assertDigest(
    "Memory required Namespace fingerprint",
    lifecycle.requiredNamespaceFingerprint,
  );
  if (
    !Number.isSafeInteger(lifecycle.attemptCount)
    || lifecycle.attemptCount < 0
    || lifecycle.attemptCount > MEMORY_RECONCILE_MAX_ATTEMPTS
  ) throw new TypeError("Memory lifecycle attempt count is invalid");
}
