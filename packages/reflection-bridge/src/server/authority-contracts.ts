import type {
  AuthorityEligibilityPort,
  AuthorityLeafAlternatives,
  EffectiveAudienceAlternative,
} from "@nautilo/reflection/authority";

import type { RecordRepositoryRepresentation } from "./contracts";

export interface AuthorityClosureNode {
  readonly recordRef: string;
  readonly childRecordRefs: readonly string[];
  readonly directAuthorityLeafHandles: readonly string[];
  /** Validated cache only; it can never replace dependency traversal. */
  readonly declaredTerminalAuthorityLeafHandles: readonly string[];
}

export interface AuthorityClosureNodePort {
  readNode(recordRef: string): Promise<
    | { readonly status: "available"; readonly node: AuthorityClosureNode }
    | { readonly status: "unavailable" }
  >;
}

export type AuthorityClosureResult =
  | {
      readonly status: "paused";
      /** Sensitive logical state; durable adapters must seal it. */
      readonly continuation: string;
      readonly visitedRecords: number;
    }
  | {
      readonly status: "complete";
      readonly terminalAuthorityLeafHandles: readonly string[];
      readonly visitedRecords: number;
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "record_unavailable"
        | "dependency_cycle"
        | "declared_closure_mismatch"
        | "no_authority_leaves";
    };

/** Current canonical authority for one opaque terminal source handle. */
export interface CanonicalSourceAuthorityPort {
  resolve(handle: string): Promise<
    | { readonly status: "available"; readonly leaf: AuthorityLeafAlternatives }
    | { readonly status: "unavailable" }
  >;
}

export interface MaterializedAccessAudience {
  readonly accessRoomId: string;
  readonly accessNamespaceId: string;
  readonly humanRefs: readonly string[];
}

/** Strict product-owned kind=access Room resolver; no conversational reuse. */
export interface RecordAccessAudiencePort {
  resolveOrCreateExact(humanRefs: readonly string[]): Promise<MaterializedAccessAudience>;
  readExactSet(accessNamespaceIds: readonly string[]): Promise<
    | {
        readonly status: "available";
        readonly audiences: readonly (readonly string[])[];
      }
    | { readonly status: "unavailable" }
  >;
}

export interface MaterializedAuthorityAlternative {
  readonly accessNamespaceId: string;
  readonly includesPublicBoundary: boolean;
  readonly alternativeCommitment: Uint8Array;
}

export type AuthorityProjectionUnavailableReason =
  | "no_authority_leaves"
  | "no_effective_audience"
  | "source_unavailable"
  | "representation_capacity_exceeded";

export interface CurrentAuthorityProjection {
  readonly recordRef: string;
  readonly recordLifecycle: "current" | "stale" | "superseded" | "resolved" | "sunset";
  readonly recordDisposition: "available" | "blocked" | "purged";
  readonly projectionGeneration: number;
  readonly sourceChangeGeneration: number;
  readonly processingState: "current" | "dirty" | "reconciling" | "unavailable" | "purged";
  readonly alternatives: readonly MaterializedAuthorityAlternative[];
  readonly unavailableReason?: AuthorityProjectionUnavailableReason;
  readonly terminalAuthorityLeafHandles: readonly string[];
  readonly representationGeneration: number;
  /** Current protected head, independent of the configured ordinary/protected selection. */
  readonly protectedRepresentationGeneration?: number;
  readonly protectedCryptoObjectId?: string;
  readonly audienceSetCommitment?: Uint8Array;
  /** Exact completed protected receipt and current head agree with this logical projection. */
  readonly protectedAuthorityCurrent?: boolean;
}

export interface AuthorityProjectionCommitmentPort {
  commitAlternative(alternative: EffectiveAudienceAlternative): Uint8Array;
  commitSet(alternatives: readonly EffectiveAudienceAlternative[]): Uint8Array;
  sealCheckpoint(logicalCheckpoint: string): Uint8Array;
  openSealedCheckpoint(sealedCheckpoint: Uint8Array): string;
}

export interface AuthorityProjectionCasInput {
  readonly recordRef: string;
  readonly expectedProjectionGeneration: number;
  readonly sourceChangeGeneration: number;
  readonly terminalAuthorityLeafHandles: readonly string[];
  readonly audienceSetCommitment: Uint8Array;
  readonly alternatives: readonly MaterializedAuthorityAlternative[];
  readonly unavailableReason?: AuthorityProjectionUnavailableReason;
  readonly sealedRepairState?: Uint8Array;
  readonly protectedTransition?: Readonly<{
    representationGeneration: number;
    cryptoObjectId: string;
    /** One-use current Reflection fence; invoked inside the product attachment transaction. */
    authorizeCommit: () => Promise<number>;
  }>;
}

export interface AuthorityProjectionStorePort {
  readCurrent(recordRef: string): Promise<CurrentAuthorityProjection | null>;
  readProtectedReconciliation(input: Readonly<{recordRef: string; sourceChangeGeneration: number}>): Promise<AuthorityProtectedReconciliationReceipt | null>;
  isImmediatelyBlocked(input: Readonly<{
    recordRef: string;
    terminalAuthorityLeafHandles?: readonly string[];
  }>): Promise<"blocked" | "purged" | null>;
  installInitialClosure(input: Readonly<{
    recordRef: string;
    closureGeneration: number;
    terminalAuthorityLeafHandles: readonly string[];
  }>): Promise<"installed" | "replayed" | "conflict">;
  admitSourceChange(input: Readonly<{
    changeRef: string;
    terminalAuthorityLeafHandle: string;
    sourceChangeGeneration: number;
  }>): Promise<Readonly<{ dirtyRecordCount: number; replayed: boolean }>>;
  applyProjectionCas(input: AuthorityProjectionCasInput): Promise<"applied" | "stale" | "blocked">;
  recordProtectedCryptoComplete(input: Readonly<{
    recordRef: string;
    expectedProjectionGeneration: number;
    sourceChangeGeneration: number;
    targetRepresentationGeneration: number;
    targetCryptoObjectId: string;
    targetAccessNamespaceIds: readonly string[];
    targetAudienceSetCommitment: Uint8Array;
  }>): Promise<"recorded" | "replayed" | "stale" | "blocked">;
  claimDueReconciliations(
    limit: number,
    exact?: AuthorityReconciliationClaimCoordinates,
  ): Promise<readonly ClaimedAuthorityReconciliation[]>;
  deferReconciliation(input: Readonly<{
    recordRef: string;
    sourceChangeGeneration: number;
    leaseToken: string;
    sealedCheckpoint?: Uint8Array;
    failureCode?: AuthorityReconciliationFailureCode;
    nextAttemptAt: Date;
    terminal: boolean;
  }>): Promise<"deferred" | "retry_exhausted" | "quarantined" | "conflict">;
  withProtectedRetirementFence(input: Readonly<{recordRef: string; sourceChangeGeneration: number; cryptoObjectId: string; kind: "former" | "target"}>, retire: () => Promise<void>): Promise<"completed" | "replayed" | "conflict">;
  listDueProtectedTargetRetirements(limit: number): Promise<readonly AuthorityProtectedTargetRetirement[]>;
  completeProtectedTargetRetirement(input: AuthorityProtectedTargetRetirement): Promise<"completed" | "replayed" | "conflict">;
  listDueProtectedRetirements(limit: number): Promise<readonly AuthorityProtectedRetirement[]>;
  completeProtectedRetirement(
    input: AuthorityProtectedRetirement,
  ): Promise<"completed" | "replayed" | "conflict">;
  block(input: Readonly<{
    blockRef: string;
    recordRef?: string;
    terminalAuthorityLeafHandle?: string;
    disposition: "blocked" | "purged";
  }>): Promise<"applied" | "replayed" | "conflict">;
  readContentFreeHealth(
    representation: RecordRepositoryRepresentation,
  ): Promise<AuthorityProjectionHealth>;
}

export type AuthorityReconciliationFailureCode =
  | "authorization_unavailable"
  | "integrity_failure"
  | "mapping_conflict"
  | "source_unavailable"
  | "storage_transient";

export interface AuthorityReconciliationClaimCoordinates {
  readonly recordRef: string;
  readonly sourceChangeGeneration: number;
}

export interface ClaimedAuthorityReconciliation {
  readonly recordRef: string;
  readonly expectedProjectionGeneration: number;
  readonly sourceChangeGeneration: number;
  readonly leaseToken: string;
  readonly attemptCount: number;
  readonly sealedCheckpoint?: Uint8Array;
}

export interface AuthorityProtectedRetirement {
  readonly recordRef: string;
  readonly sourceChangeGeneration: number;
  readonly formerCryptoObjectId: string;
}

/** Immutable content-free coordinates retained across separate crypto/product commits. */
export interface AuthorityProtectedReconciliationReceipt {
  readonly receiptId: string;
  readonly recordRef: string;
  readonly expectedProjectionGeneration: number;
  readonly sourceChangeGeneration: number;
  readonly state: "pending" | "leased" | "crypto_complete" | "attached" | "complete" | "quarantined";
  readonly completedAt: Date | null;
  readonly targetRepresentationGeneration: number | null;
  readonly targetCryptoObjectId: string | null;
  readonly targetAccessNamespaceIds: readonly string[] | null;
  readonly targetAudienceSetCommitment: Uint8Array | null;
  readonly targetCryptoRetiredAt: Date | null;
  readonly formerCryptoObjectId: string | null;
  readonly formerCryptoRetiredAt: Date | null;
}

export interface AuthorityProtectedTargetRetirement {
  readonly recordRef: string;
  readonly sourceChangeGeneration: number;
  readonly targetCryptoObjectId: string;
}

export interface AuthorityProjectionHealth {
  readonly selectedRepresentation: RecordRepositoryRepresentation;
  readonly currentCount: number;
  readonly dirtyCount: number;
  readonly reconcilingCount: number;
  readonly unavailableCount: number;
  readonly purgedCount: number;
  readonly oldestDirtyAt: Date | null;
  readonly maximumAttemptCount: number;
  readonly retryExhaustedCount: number;
}

/** Crypto boundary owns exact Wave-11 authorization and byte-identical republish. */
export interface ProtectedAuthorityRepublisherPort {
  republishExact(input: Readonly<{
    recordRef: string;
    expectedRepresentationGeneration: number;
    targetRepresentationGeneration: number;
    sourceChangeGeneration: number;
    expectedProjectionGeneration: number;
    exactAccessNamespaceIds: readonly string[];
    workBindingRef: string;
    /** Called only within the live one-run crypto gate and the held product transaction. */
    attach(input: Readonly<{cryptoObjectId: string; authorizeCommit: () => Promise<number>; projections: AuthorityProjectionStorePort}>): Promise<"applied" | "stale" | "blocked">;
  }>): Promise<
    | {
        readonly status: "published" | "replayed";
        readonly cryptoObjectId: string;
        readonly attachment: "applied" | "stale" | "blocked";
      }
    | {
        readonly status: "unavailable";
        readonly reason: "authorization_unavailable" | "integrity_failure" | "storage_transient";
      }
  >;
  retire(cryptoObjectId: string): Promise<void>;
}

export interface AuthorityReconciliationPorts {
  /** Canonical server migration state; callers do not choose a mode per job. */
  readonly selection: import("./contracts").RecordRepositorySelection;
  readonly sourceAuthority: CanonicalSourceAuthorityPort;
  readonly accessAudiences: RecordAccessAudiencePort;
  readonly projections: AuthorityProjectionStorePort;
  readonly commitments: AuthorityProjectionCommitmentPort;
  readonly protectedRepublisher?: ProtectedAuthorityRepublisherPort;
}

export interface AuthorityReconciliationRequest {
  readonly recordRef: string;
  readonly sourceChangeGeneration: number;
  readonly workBindingRef: string;
  readonly maxOperations: number;
  readonly continuation?: string;
}

export type AuthorityReconciliationResult =
  | { readonly status: "paused"; readonly continuation: string }
  | { readonly status: "stale" | "blocked" }
  | {
      readonly status: "unavailable";
      readonly reason: AuthorityProjectionUnavailableReason;
    }
  | {
      readonly status: "applied";
      readonly projectionGeneration: number;
      readonly alternativeCount: number;
      readonly formerCryptoRetirementPending: boolean;
    };

export type { AuthorityEligibilityPort };
