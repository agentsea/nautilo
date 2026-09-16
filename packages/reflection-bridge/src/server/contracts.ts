import type {
  DirectRecordDispositionMutation,
  DirectRecordDispositionResult,
  DurableRecordLifecycleMutation,
  DurableRecordLifecycleMutationResult,
  DurableRecordPublication,
  DurableRecordPublicationResult,
  DurableRecordReadPort,
} from "@nautilo/reflection/durable";

export type RecordRepositoryRepresentation = "ordinary" | "protected";

/** Canonical server migration state projected into the dormant bridge. */
export interface RecordRepositorySelection {
  readonly selectedRepresentation: RecordRepositoryRepresentation;
  readonly migrationGeneration: number;
}

export type RecordPublicationCryptoResult =
  | { readonly status: "created" | "duplicate"; readonly objectId: string }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "authorization_unavailable"
        | "crypto_incomplete"
        | "crypto_mismatch"
        | "storage_transient";
    };

/**
 * Opaque capability implemented by the reviewed lattice server composition.
 * Product receipts never receive keys, Grants, prepared bytes, or resolvers.
 */
export interface ProtectedRecordPublicationPort {
  publish(input: Readonly<{
    recordId: string;
    representationGeneration: number;
    payloadBytes: Uint8Array;
    publicationBindingRef: string;
  }>): Promise<RecordPublicationCryptoResult>;
  verify(input: Readonly<{
    objectId: string;
    recordId: string;
    representationGeneration: number;
  }>): Promise<"complete" | "absent" | "incomplete" | "mismatch">;
  open(input: Readonly<{
    objectId: string;
    recordId: string;
    representationGeneration: number;
    readBindingRef: string;
  }>): Promise<
    | { readonly status: "available"; readonly payloadBytes: Uint8Array }
    | {
        readonly status: "unavailable";
        readonly reason: "unauthorized" | "integrity_failure" | "not_found";
      }
  >;
  retire(objectId: string): Promise<void>;
}

export interface RecordRepositoryMutationPort {
  publish(input: DurableRecordPublication): Promise<DurableRecordPublicationResult>;
  transitionLifecycle(input: DurableRecordLifecycleMutation): Promise<DurableRecordLifecycleMutationResult>;
  block(input: DirectRecordDispositionMutation): Promise<DirectRecordDispositionResult>;
  purge(input: DirectRecordDispositionMutation): Promise<DirectRecordDispositionResult>;
}

export interface RecordRepositoryPort
  extends RecordRepositoryMutationPort,
    DurableRecordReadPort {}

export type RecordRepositoryFailureCode =
  | "invalid_handle"
  | "invalid_selection"
  | "idempotency_conflict"
  | "structural_conflict"
  | "selected_representation_missing"
  | "integrity_failure"
  | "authorization_unavailable"
  | "crypto_absent"
  | "crypto_incomplete"
  | "crypto_mismatch"
  | "storage_transient"
  | "mapping_conflict"
  | "retry_exhausted"
  | "blocked"
  | "purged";

export type ProtectedRecordFailureDisposition =
  | "scheduled"
  | "quarantined"
  | "retry_exhausted"
  | "ignored";

export interface ClaimedProtectedRecordPublication {
  readonly idempotencyKey: string;
  readonly recordId: string;
  readonly state: "reserved" | "crypto_complete" | "product_attached";
  readonly leaseToken: string;
  readonly cryptoObjectId?: string;
  readonly reservedCryptoObjectId?: string;
  readonly replay?: Readonly<{
    publicationBindingRef: string;
    originPublicationBindingRef?: string;
    requestCommitment: Uint8Array;
    structuralHeight: number;
    processingGeneration: number;
    predecessor?: Readonly<{
      recordRef: string;
      relation: "supersedes" | "resolves";
    }>;
  }>;
}

export interface ProtectedRecordRetirement {
  readonly idempotencyKey: string;
  readonly recordId: string;
  readonly representationGeneration: number;
  readonly cryptoObjectId: string;
}

export class RecordRepositoryError extends Error {
  readonly code: RecordRepositoryFailureCode;

  constructor(code: RecordRepositoryFailureCode) {
    super(`Reflection Record repository: ${code}`);
    this.name = "RecordRepositoryError";
    this.code = code;
  }
}

export type RecordProductPublicationReservation =
  | { readonly status: "reserved"; readonly recordId: string }
  | {
      readonly status: "replayed";
      readonly recordId: string;
      readonly state: "reserved" | "crypto_complete" | "product_attached" | "complete";
      readonly cryptoObjectId?: string;
    }
  | { readonly status: "conflict" | "blocked" | "purged"; readonly recordId: string };

export interface RecordProductVisibleRow {
  readonly recordId: string;
  readonly lifecycle: "current" | "stale" | "superseded" | "resolved" | "sunset";
  readonly structuralHeight: number;
  readonly processingGeneration: number;
  readonly producerPolicyVersion: string;
  readonly representation: RecordRepositoryRepresentation;
  readonly representationGeneration: number;
  readonly payloadBytes?: Uint8Array;
  readonly cryptoObjectId?: string;
}

/** Product transaction boundary; implementations must serialize graph writes. */
export interface RecordProductStorePort {
  readCompletedPublicationRecordId(input: Readonly<{
    idempotencyKey: string;
  }>): Promise<
    | { readonly status: "available"; readonly recordId: string }
    | {
        readonly status: "unavailable";
        readonly reason: "not_found" | "incomplete" | "blocked" | "purged";
      }
  >;
  publishOrdinary(input: Readonly<{
    publication: DurableRecordPublication;
    payloadBytes: Uint8Array;
    requestCommitment: Uint8Array;
  }>): Promise<DurableRecordPublicationResult>;
  transitionLifecycle(input: DurableRecordLifecycleMutation): Promise<DurableRecordLifecycleMutationResult>;
  reserveProtected(input: Readonly<{
    publication: DurableRecordPublication;
    requestCommitment: Uint8Array;
  }>): Promise<RecordProductPublicationReservation>;
  bindProtectedOutput(input: Readonly<{
    idempotencyKey: string;
    recordId: string;
    cryptoObjectId: string;
    requestCommitment: Uint8Array;
  }>): Promise<"updated" | "replayed" | "blocked" | "conflict">;
  markProtectedCryptoComplete(input: Readonly<{
    idempotencyKey: string;
    recordId: string;
    cryptoObjectId: string;
    leaseToken?: string;
  }>): Promise<"updated" | "replayed" | "blocked" | "conflict">;
  attachProtected(input: Readonly<{
    publication: DurableRecordPublication;
    cryptoObjectId: string;
    requestCommitment: Uint8Array;
    leaseToken?: string;
  }>): Promise<"attached" | "replayed" | "blocked" | "conflict">;
  completeProtected(input: Readonly<{
    idempotencyKey: string;
    recordId: string;
    leaseToken?: string;
  }>): Promise<"complete" | "replayed" | "blocked" | "conflict">;
  failProtected(input: Readonly<{
    idempotencyKey: string;
    recordId: string;
    failureCode: RecordRepositoryFailureCode;
    terminal: boolean;
    leaseToken?: string;
  }>): Promise<ProtectedRecordFailureDisposition>;
  readVisible(input: Readonly<{
    recordId: string;
    representation: RecordRepositoryRepresentation;
  }>): Promise<
    | { readonly status: "available"; readonly row: RecordProductVisibleRow }
    | {
        readonly status: "unavailable";
        readonly reason: "not_found" | "selected_representation_missing" | "blocked" | "purged";
      }
  >;
  readGraphPage(input: Readonly<{
    recordId: string;
    direction: "dependencies" | "parents" | "successors" | "predecessors";
    limit: number;
    continuation?: string;
  }>): Promise<Readonly<{
    items: readonly string[] | readonly import("@nautilo/reflection/durable").SuccessorEdge[];
    continuation?: string;
  }>>;
  block(input: DirectRecordDispositionMutation): Promise<DirectRecordDispositionResult>;
  purge(input: DirectRecordDispositionMutation): Promise<
    DirectRecordDispositionResult & {
      readonly protectedRetirements?: readonly ProtectedRecordRetirement[];
    }
  >;
  claimDueProtected(
    limit: number,
    options?: Readonly<{ requireReservedOutput?: boolean }>,
  ): Promise<readonly ClaimedProtectedRecordPublication[]>;
  listDueProtectedRetirements(
    limit: number,
  ): Promise<readonly ProtectedRecordRetirement[]>;
  completeProtectedRetirement(
    input: ProtectedRecordRetirement,
  ): Promise<"completed" | "replayed" | "conflict">;
}

export interface RecordRequestCommitmentPort {
  commit(payloadBytes: Uint8Array, publication: DurableRecordPublication): Uint8Array;
}
