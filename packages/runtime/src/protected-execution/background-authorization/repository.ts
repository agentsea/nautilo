import { assertTaskRuntimeMappedHeadReplacement, type TaskRuntimeMappedHeadReplacementInput } from "./task-runtime-mapped-head-replan";
import { createHash } from "node:crypto";
import { assertVerifiedProtectedTaskWakeContinuation, type VerifiedProtectedTaskWakeContinuation,
  type ProtectedTaskWakeContinuationReceipt } from "@nautilo/db";
import {
  BACKGROUND_AUTHORIZATION_BYTE_LIMITS,
  BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS,
} from "@nautilo/db/schema";
import { MAX_AGENT_GRANT_DOMAINS_V2, MAX_AGENT_GRANT_NAMESPACES_V2 } from
  "@nautilo/lattice-crypto/wire-limits";
import type {
  VerifiedBackgroundAuthorizationDeviceResponse,
  VerifiedAgentBackgroundAuthorizationDeviceResponseV2,
} from "@nautilo/lattice-bridge";
import {
  decodeTaskRuntimeBackgroundAuthorizationResponseV2,
  decodeBackgroundAuthorizationResponseV2,
  encodeTaskRuntimeBackgroundAuthorizationResponseV2,
  encodeBackgroundWorkDescriptorV2,
  inspectBackgroundAuthorizationResponseV2,
  backgroundProcessorNamespaceRequirementsV2,
  MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
  type VerifiedBackgroundAuthorizationV2,
} from "@nautilo/lattice-crypto/background";
import {
  BACKGROUND_AUTHORIZATION_MAX_GENERATION,
  BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES,
  BACKGROUND_AUTHORIZATION_MAX_TIMESTAMP_MS,
  advanceBackgroundAuthorizationGeneration,
  cancelBackgroundAuthorizationRequest,
  deferUnstartedTaskRuntimeRequestSnapshot,
  markBackgroundAuthorizationGrantReady,
  parseBackgroundAuthorizationRequestSnapshot,
  replaceBackgroundAuthorizationPreclaimAuthority,
  restartBackgroundAuthorizationAfterUncommittedPublication,
  scheduleBackgroundAuthorizationPublicationRetry,
  type BackgroundAuthorizationRequestSnapshot,
  type BackgroundAuthorizationRequestSnapshotV1,
  type BackgroundAuthorizationAgentRequestSnapshotV2,
  type BackgroundAuthorizationProcessorRequestSnapshotV2,
  type BackgroundAuthorizationTaskRuntimeRequestSnapshotV3,
} from "./lifecycle";

export const BACKGROUND_AUTHORIZATION_WORK_KINDS = Object.freeze([
  "stenographer.extraction",
  "stenographer.historical",
  "stenographer.compaction",
  "stenographer.rebuild",
  "stenographer.publication_reconcile",
  "stenographer.output_repair",
  "reflection.authority_reproject",
  "reflection.publication_reconcile",
  "reflection.search_projection",
  "reflection.organization",
  "reflection.dependency_rewrite",
  "memory.review",
  "memory.exit_flush",
  "task.dispatch",
  "task.execute",
  "task.await_reply_resume",
  "task.approval_resume",
  "task.cancel_result",
  "task.deliver_message",
  "task.deliver_result",
  "task.delivery_wake",
] as const);

export const TASK_RUNTIME_STABLE_IDEMPOTENCY_PREFIX =
  "task-runtime-stable-v1";

export function isTaskRuntimeStableIdempotencyKey(
  value: string,
  taskRunId: string,
): boolean {
  const prefix = `${TASK_RUNTIME_STABLE_IDEMPOTENCY_PREFIX}:${taskRunId}:`;
  const digest = value.slice(prefix.length);
  return value.startsWith(prefix)
    && digest.length === 43
    && /^[A-Za-z0-9_-]{43}$/u.test(digest);
}

export type BackgroundAuthorizationWorkKind =
  (typeof BACKGROUND_AUTHORIZATION_WORK_KINDS)[number];

export const BACKGROUND_AUTHORIZATION_PURPOSES = Object.freeze([
  "journal.extract",
  "journal.compact",
  "journal.rebuild",
  "journal.reconcile",
  "journal.repair",
  "record.reproject",
  "record.reconcile",
  "record.search_projection",
  "record.organize",
  "record.dependency_rewrite",
  "memory.review",
  "memory.exit_flush",
  "task.dispatch",
  "task.execute",
  "task.await_reply_resume",
  "task.approval_resume",
  "task.cancel_result",
  "task.deliver_message",
  "task.deliver_result",
  "task.delivery_wake",
] as const);

export type BackgroundAuthorizationPurpose =
  (typeof BACKGROUND_AUTHORIZATION_PURPOSES)[number];

export type BackgroundAuthorizationAcceptedMaterial = Readonly<{
  readonly responseBytes: Uint8Array;
  readonly credentialId: string;
  /** M303 device securityRevision; never a processor permission revision. */
  readonly issuingDeviceAuthorizationRevision: number;
  readonly issuerSigningPublicKeyHash: Uint8Array;
  readonly authorizationExpiresAt: number;
}>;

export type BackgroundAuthorizationVerifiedProcessorResponseV2 =
  VerifiedBackgroundAuthorizationV2 & Readonly<{
    readonly formatVersion: 2;
    readonly kind: "processor";
  }>;

/**
 * Facts emitted only after a caller verifies the signed Runtime authorization.
 * This repository binds and persists those facts; it is not a wire verifier.
 */
export type BackgroundAuthorizationVerifiedRuntimeResponseV3 = Readonly<{
  readonly formatVersion: 3;
  readonly kind: "runtime";
  readonly requestId: string;
  readonly descriptorHash: Uint8Array;
  readonly descriptorBytes: Uint8Array;
  readonly recipientGeneration: number;
  readonly recipientKeyId: string;
  readonly recipientPublicKey: Uint8Array;
  readonly workId: string;
  readonly workKind: BackgroundAuthorizationWorkKind;
  readonly purpose: BackgroundAuthorizationPurpose;
  readonly authoritySet: BackgroundAuthorizationAuthoritySetV3;
  readonly responseBytes: Uint8Array;
  readonly responseHash: Uint8Array;
  readonly authorizationId: string;
  readonly authorizationHash: Uint8Array;
  readonly issuingHumanId: string;
  readonly issuingDeviceId: string;
  readonly issuingDeviceAuthorizationRevision: number;
  readonly issuerSigningPublicKeyHash: Uint8Array;
  readonly issuedAt: number;
  readonly expiresAt: number;
}>;

export type BackgroundAuthorizationVerifiedRuntimeResponseV4 = Readonly<
  Omit<BackgroundAuthorizationVerifiedRuntimeResponseV3, "formatVersion"> & {
    readonly formatVersion: 4;
    readonly authorizationBytes: Uint8Array;
    readonly certificateBytes: Uint8Array;
  }
>;

export type BackgroundAuthorizationVerifiedDeviceResponse =
  | VerifiedBackgroundAuthorizationDeviceResponse
  | VerifiedAgentBackgroundAuthorizationDeviceResponseV2
  | BackgroundAuthorizationVerifiedProcessorResponseV2
  | BackgroundAuthorizationVerifiedRuntimeResponseV3
  | BackgroundAuthorizationVerifiedRuntimeResponseV4;

type BackgroundAuthorizationRecordFields = Readonly<{
  readonly workIdentityHash: Uint8Array;
  readonly idempotencyKey: string;
  readonly workKind: BackgroundAuthorizationWorkKind;
  readonly purpose: BackgroundAuthorizationPurpose;
  readonly domainId: string;
  readonly processorAuthorizationRevision: number | null;
  readonly expectedDomainEpoch: number | null;
  readonly expectedNamespaceAccessRevision: number;
  readonly expectedPolicyRevision: number;
  readonly descriptorBytes: Uint8Array | null;
  readonly acceptedMaterial: BackgroundAuthorizationAcceptedMaterial | null;
  readonly finishedAt: number | null;
}>;

export const BACKGROUND_AUTHORIZATION_OPERATIONS = Object.freeze([
  "decrypt",
  "encrypt",
] as const);

export type BackgroundAuthorizationOperation =
  (typeof BACKGROUND_AUTHORIZATION_OPERATIONS)[number];

export type BackgroundAuthorizationNamespaceRequirementV2 = Readonly<{
  readonly ordinal: number;
  readonly namespaceId: string;
  readonly domainId: string;
  readonly operations: readonly BackgroundAuthorizationOperation[];
  readonly expectedAccessRevision: number;
  readonly expectedPolicyRevision: number;
}>;

export type BackgroundAuthorizationDomainRequirementV2 = Readonly<{
  readonly ordinal: number;
  readonly domainId: string;
  readonly expectedEpoch: number;
  readonly expectedAgentAuthorizationRevision: number;
}>;

export type BackgroundAuthorizationDomainRequirementV3 = Readonly<{
  readonly ordinal: number;
  readonly domainId: string;
  readonly expectedEpoch: number;
  readonly expectedAuthorizationRevision: number;
}>;

export type BackgroundAuthorizationAuthoritySetV2 = Readonly<{
  readonly namespaceRequirements:
    readonly BackgroundAuthorizationNamespaceRequirementV2[];
  readonly domainRequirements:
    readonly BackgroundAuthorizationDomainRequirementV2[];
}>;

export type BackgroundAuthorizationAuthoritySetV3 = Readonly<{
  readonly namespaceRequirements:
    readonly BackgroundAuthorizationNamespaceRequirementV2[];
  readonly domainRequirements:
    readonly BackgroundAuthorizationDomainRequirementV3[];
}>;

export type BackgroundAuthorizationRecordV1 = Readonly<
  Omit<BackgroundAuthorizationRecordFields, "expectedDomainEpoch"> & {
    readonly snapshot: BackgroundAuthorizationRequestSnapshotV1;
    readonly expectedDomainEpoch: number;
  }
>;

export type BackgroundAuthorizationAgentRecordV2 = Readonly<
  Omit<BackgroundAuthorizationRecordFields, "expectedDomainEpoch"> & {
    readonly snapshot: BackgroundAuthorizationAgentRequestSnapshotV2;
    readonly expectedDomainEpoch: number;
    readonly authoritySet: BackgroundAuthorizationAuthoritySetV2;
  }
>;

export type BackgroundAuthorizationProcessorRecordV2 = Readonly<
  Omit<
    BackgroundAuthorizationRecordFields,
    "expectedDomainEpoch" | "processorAuthorizationRevision"
  > & {
    readonly snapshot: BackgroundAuthorizationProcessorRequestSnapshotV2;
    readonly expectedDomainEpoch: null;
    readonly processorAuthorizationRevision: null;
  }
>;

export type BackgroundAuthorizationTaskRuntimeRecordV3 = Readonly<
  Omit<BackgroundAuthorizationRecordFields, "expectedDomainEpoch"> & {
    readonly snapshot: BackgroundAuthorizationTaskRuntimeRequestSnapshotV3;
    readonly expectedDomainEpoch: number;
    readonly authoritySet: BackgroundAuthorizationAuthoritySetV3;
  }
>;

/** V2 records are discriminated by the credential subject kind. */
export type BackgroundAuthorizationRecordV2 =
  | BackgroundAuthorizationAgentRecordV2
  | BackgroundAuthorizationProcessorRecordV2;

/** Compatibility shape; precise legacy, Agent V2, and processor V2 records remain discriminated above. */
export type BackgroundAuthorizationRecord = Readonly<
  BackgroundAuthorizationRecordFields & {
    readonly snapshot: BackgroundAuthorizationRequestSnapshot;
    readonly authoritySet?:
      | BackgroundAuthorizationAuthoritySetV2
      | BackgroundAuthorizationAuthoritySetV3;
  }
>;

type ProcessorSignerAuthorizationEvidenceFields = Readonly<{
  readonly authorizationId: string;
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly workId: string;
  readonly namespaceId: string;
  readonly domainId: string;
  readonly domainEpoch: number | null;
  readonly namespaceAccessRevision: number;
  readonly policyRevision: number;
  readonly processorAuthorizationRevision: number | null;
  readonly issuingHumanId: string;
  readonly issuingDeviceId: string;
  readonly issuingDeviceAuthorizationRevision: number;
  readonly issuerSigningPublicKeyHash: Uint8Array;
  readonly signerKeyId: string;
  readonly signerPublicKey: Uint8Array;
  readonly workDescriptorHash: Uint8Array;
  readonly workDescriptorBytes: Uint8Array;
  readonly authorizationHash: Uint8Array;
  readonly credentialHash: Uint8Array;
  readonly authorizationBytes: Uint8Array;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly createdAt: number;
}>;

export type ProcessorSignerAuthorizationEvidenceV1 = Readonly<
  Omit<
    ProcessorSignerAuthorizationEvidenceFields,
    "domainEpoch" | "processorAuthorizationRevision"
  > & {
    /** Omitted by legacy callers; persisted as format version 1. */
    readonly formatVersion?: 1;
    readonly domainEpoch: number;
    readonly processorAuthorizationRevision: number;
  }
>;

export type ProcessorSignerAuthorizationEvidenceV2 = Readonly<
  Omit<
    ProcessorSignerAuthorizationEvidenceFields,
    "domainEpoch" | "processorAuthorizationRevision"
  > & {
    readonly formatVersion: 2;
    readonly domainEpoch: null;
    readonly processorAuthorizationRevision: null;
  }
>;

export type ProcessorSignerAuthorizationEvidence =
  | ProcessorSignerAuthorizationEvidenceV1
  | ProcessorSignerAuthorizationEvidenceV2;

export type BackgroundAuthorizationCreateResult = Readonly<{
  readonly status: "created" | "existing";
  readonly record: BackgroundAuthorizationRecord;
}>;

export type BackgroundAuthorizationCasResult =
  | Readonly<{
    readonly status: "updated";
    readonly record: BackgroundAuthorizationRecord;
  }>
  | Readonly<{
    readonly status: "stale";
    readonly current: BackgroundAuthorizationRecord | null;
  }>;

export type ProcessorSignerEvidenceAppendResult = Readonly<{
  readonly status: "appended" | "existing";
  readonly evidence: ProcessorSignerAuthorizationEvidence;
}>;

export type BackgroundAuthorizationAcceptResponseResult =
  | Readonly<{
    readonly status: "accepted";
    readonly record: BackgroundAuthorizationRecord;
  }>
  | Readonly<{
    readonly status: "duplicate" | "lost";
    readonly current: BackgroundAuthorizationRecord | null;
  }>;

export type BackgroundAuthorizationAwaitingDeviceCursor = Readonly<{
  readonly updatedAt: number;
  readonly requestId: string;
}>;

export type BackgroundAuthorizationAwaitingDevicePage = Readonly<{
  readonly records: readonly BackgroundAuthorizationRecord[];
  readonly continuation: BackgroundAuthorizationAwaitingDeviceCursor | null;
}>;

export type BackgroundAuthorizationAwaitingTaskRuntimeRecipientCursor =
  Readonly<{
    readonly updatedAt: number;
    readonly requestId: string;
  }>;

export type BackgroundAuthorizationAwaitingTaskRuntimeRecipientPage =
  Readonly<{
    readonly records: readonly BackgroundAuthorizationTaskRuntimeRecordV3[];
    readonly continuation:
      BackgroundAuthorizationAwaitingTaskRuntimeRecipientCursor | null;
  }>;

export type BackgroundAuthorizationTaskRuntimeCancellationCursor = Readonly<{
  readonly updatedAt: number;
  readonly requestId: string;
}>;

export type BackgroundAuthorizationTaskRuntimeCancellationCandidate =
  Readonly<{
    readonly requestId: string;
    readonly workId: string;
    readonly namespaceId: string;
    readonly recipientGeneration: number;
    readonly requestRevision: number;
    readonly updatedAt: number;
  }>;

export type BackgroundAuthorizationTaskRuntimeCancellationPage = Readonly<{
  readonly candidates:
    readonly BackgroundAuthorizationTaskRuntimeCancellationCandidate[];
  readonly continuation:
    BackgroundAuthorizationTaskRuntimeCancellationCursor | null;
}>;

export type BackgroundAuthorizationTaskRuntimeSettledRecipient = Readonly<{
  readonly requestId: string;
  readonly recipientGeneration: number;
}>;

export type BackgroundAuthorizationTaskRuntimeExecutionSettlementResult =
  | Readonly<{
    readonly status: "settled";
    readonly transitioned: number;
    readonly alreadyTerminal: number;
    readonly recipients:
      readonly BackgroundAuthorizationTaskRuntimeSettledRecipient[];
  }>
  | Readonly<{
    readonly status: "conflict";
    readonly recipients: readonly [];
  }>;

export type BackgroundAuthorizationSupersedeResult =
  | Readonly<{status: "superseded" | "existing"; record: BackgroundAuthorizationRecord}>
  | Readonly<{status: "stale"; current: BackgroundAuthorizationRecord | null}>;

export type BackgroundAuthorizationTaskRuntimeReplacementResult =
  | Readonly<{
    status: "replaced";
    record: BackgroundAuthorizationTaskRuntimeRecordV3;
  }>
  | Readonly<{
    status: "stale";
    current: BackgroundAuthorizationRecord | null;
  }>;

export type BackgroundAuthorizationTaskRuntimeDeferralResult =
  | Readonly<{
    status: "deferred" | "exact_replay";
    record: BackgroundAuthorizationTaskRuntimeRecordV3;
  }>
  | Readonly<{
    status: "stale";
    current: BackgroundAuthorizationRecord | null;
  }>;

export type BackgroundAuthorizationTaskWakeParkResult =
  | Readonly<{
      status: "parked" | "exact_replay";
      record: BackgroundAuthorizationTaskRuntimeRecordV3;
    }>
  | Readonly<{
      status: "stale";
      current: BackgroundAuthorizationRecord | null;
    }>;

export type BackgroundAuthorizationTaskWakeRecipientRenewalResult =
  | Readonly<{
      status: "rotated";
      record: BackgroundAuthorizationTaskRuntimeRecordV3;
      releasedRecipientGeneration: number;
    }>
  | Readonly<{
      status: "not_due" | "inactive";
      record: BackgroundAuthorizationTaskRuntimeRecordV3;
    }>
  | Readonly<{
      status: "stale";
      current: BackgroundAuthorizationRecord | null;
    }>;

export interface BackgroundAuthorizationRepository {
  /** Product owner holds current policy, exact source and live lease before this atomic handoff. */
  supersedeUnstartedProcessorRequest?(input: Readonly<{
    expected: BackgroundAuthorizationRecord; successor: BackgroundAuthorizationRecord; now: number;
  }>): Promise<BackgroundAuthorizationSupersedeResult>;

  /** Optional for legacy/test repositories; current production owns exact handoff. */
  cancelUnconsumedProcessorRequest?(input: Readonly<{
    expected: BackgroundAuthorizationRecord;
    now: number;
    reason?: "superseded";
  }>): Promise<boolean>;

  /** Exact work lookup for resuming a retained cancelled handoff; never creates authority. */
  getByIdempotencyKey?(idempotencyKey: string): Promise<BackgroundAuthorizationRecord | null>;

  create(
    record: BackgroundAuthorizationRecord,
  ): Promise<BackgroundAuthorizationCreateResult>;
  get(requestId: string): Promise<BackgroundAuthorizationRecord | null>;
  compareAndSwap(input: Readonly<{
    readonly expectedRequestRevision: number;
    readonly next: BackgroundAuthorizationRecord;
  }>): Promise<BackgroundAuthorizationCasResult>;
  acceptVerifiedResponse(input: Readonly<{
    readonly response: BackgroundAuthorizationVerifiedDeviceResponse;
    readonly acceptedAt: number;
  }>): Promise<BackgroundAuthorizationAcceptResponseResult>;
  listEligible(input: Readonly<{
    readonly now: number;
    readonly limit: number;
  }>): Promise<readonly BackgroundAuthorizationRecord[]>;
  listAwaitingDevicePage(input: Readonly<{
    readonly now: number;
    readonly throughUpdatedAt: number;
    readonly after?: BackgroundAuthorizationAwaitingDeviceCursor;
    readonly limit: number;
  }>): Promise<BackgroundAuthorizationAwaitingDevicePage>;
  /** Optional for legacy/test repositories; production discovery is V3-only. */
  listAwaitingTaskRuntimeRecipientPage?(input: Readonly<{
    readonly now: number;
    readonly throughUpdatedAt: number;
    readonly after?: BackgroundAuthorizationAwaitingTaskRuntimeRecipientCursor;
    readonly limit: number;
  }>): Promise<BackgroundAuthorizationAwaitingTaskRuntimeRecipientPage>;
  pruneTerminal(input: Readonly<{
    readonly now: number;
    readonly limit?: number;
  }>): Promise<number>;
}

/** Task-only authority inventory replacement; ordinary repositories stay unchanged. */
export interface BackgroundAuthorizationTaskRuntimeReplacementRepository
  extends BackgroundAuthorizationRepository {
  replaceUnclaimedTaskRuntimeAuthority(input: Readonly<{
    expected: BackgroundAuthorizationTaskRuntimeRecordV3;
    replacement: BackgroundAuthorizationTaskRuntimeRecordV3;
    now: number;
  }>): Promise<BackgroundAuthorizationTaskRuntimeReplacementResult>;
}

/** A mapped-head repair can rotate only a request that has no accepted grant. */
export interface BackgroundAuthorizationTaskMappedHeadReplacementRepository extends BackgroundAuthorizationRepository {
  replaceUnclaimedTaskMappedHeadAuthority(input: TaskRuntimeMappedHeadReplacementInput): Promise<BackgroundAuthorizationTaskRuntimeReplacementResult>;
}

/** Caller holds stopped Task/Run locks and proves no result reservation exists. */
export interface BackgroundAuthorizationTaskCancellationReplacementRepository
  extends BackgroundAuthorizationRepository {
  replaceUnclaimedTaskCancellationAuthority(input: Readonly<{
    expected: BackgroundAuthorizationTaskRuntimeRecordV3;
    replacement: BackgroundAuthorizationTaskRuntimeRecordV3;
    now: number;
  }>): Promise<BackgroundAuthorizationTaskRuntimeReplacementResult>;
}

/** Caller holds the terminal Message allocation and current destination policy. */
export interface BackgroundAuthorizationTaskTerminalMessageReplacementRepository
  extends BackgroundAuthorizationRepository {
  replaceUnclaimedTaskTerminalMessageAuthority(input: Readonly<{
    expected: BackgroundAuthorizationTaskRuntimeRecordV3;
    replacement: BackgroundAuthorizationTaskRuntimeRecordV3;
    now: number;
  }>): Promise<BackgroundAuthorizationTaskRuntimeReplacementResult>;
}

/** Caller holds current closed output authority and proves no publication/effects began. */
export interface BackgroundAuthorizationTaskOutputReadReplacementRepository
  extends BackgroundAuthorizationRepository {
  replaceUnclaimedTaskOutputReadAuthority(input: Readonly<{
    expected: BackgroundAuthorizationTaskRuntimeRecordV3;
    replacement: BackgroundAuthorizationTaskRuntimeRecordV3;
    now: number;
  }>): Promise<BackgroundAuthorizationTaskRuntimeReplacementResult>;
}

/** Exact durable park proof is live for the full accepted-grant rotation. */
export interface BackgroundAuthorizationTaskWakeParkRepository
  extends BackgroundAuthorizationRepository {
  parkTaskWakeForAdditionalAuthority(input: Readonly<{
    expected: BackgroundAuthorizationTaskRuntimeRecordV3;
    replacement: BackgroundAuthorizationTaskRuntimeRecordV3;
    proof: VerifiedProtectedTaskWakeContinuation;
    now: number;
  }>): Promise<BackgroundAuthorizationTaskWakeParkResult>;
  renewParkedTaskWakeRecipient(input: Readonly<{
    expected: BackgroundAuthorizationTaskRuntimeRecordV3;
    replacement?: BackgroundAuthorizationTaskRuntimeRecordV3;
    proof: VerifiedProtectedTaskWakeContinuation;
    now: number;
  }>): Promise<BackgroundAuthorizationTaskWakeRecipientRenewalResult>;
}

/**
 * Narrow recovery owner for an unstarted Task Runtime execution. Callers must
 * first prove that the exact durable Job was cancelled and never entered
 * running; this repository operation does not establish that product proof.
 */
export interface BackgroundAuthorizationTaskRuntimeDeferralRepository
  extends BackgroundAuthorizationRepository {
  deferUnstartedTaskRuntimeRequest(input: Readonly<{
    expected: BackgroundAuthorizationTaskRuntimeRecordV3;
    now: number;
  }>): Promise<BackgroundAuthorizationTaskRuntimeDeferralResult>;
}

export interface BackgroundAuthorizationTaskRuntimeCancellationDiscoveryRepository
  extends BackgroundAuthorizationRepository {
  listTaskRuntimeCancellationPage(input: Readonly<{
    readonly throughUpdatedAt: number;
    readonly after?: BackgroundAuthorizationTaskRuntimeCancellationCursor;
    readonly limit: number;
  }>): Promise<BackgroundAuthorizationTaskRuntimeCancellationPage>;
}

/**
 * Cancels every prior Task execution authority for one stopped TaskRun. The
 * caller must hold the stopped Task and TaskRun product locks for the entire
 * repository transaction; this operation never establishes that product fact
 * and never creates replacement authority. A caller retaining a prior
 * jobAuthorizationRequestId must also require that exact id in `recipients`;
 * an empty result is sufficient only when no prior request id was recorded.
 */
export interface BackgroundAuthorizationTaskRuntimeCancellationSettlementRepository
  extends BackgroundAuthorizationRepository {
  settleTaskRuntimeExecutionAuthorities(input: Readonly<{
    readonly workId: string;
    readonly namespaceId: string;
    readonly now: number;
  }>): Promise<BackgroundAuthorizationTaskRuntimeExecutionSettlementResult>;
}

export type BackgroundAuthorizationRepositoryConflictReason =
  | "create_conflict"
  | "prune_conflict"
  | "signer_evidence_conflict";

export class BackgroundAuthorizationRepositoryConflictError extends Error {
  constructor(
    readonly reason: BackgroundAuthorizationRepositoryConflictReason,
  ) {
    super(reason);
    this.name = "BackgroundAuthorizationRepositoryConflictError";
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const WORK_KIND_SET = new Set<string>(BACKGROUND_AUTHORIZATION_WORK_KINDS);
const PURPOSE_SET = new Set<string>(BACKGROUND_AUTHORIZATION_PURPOSES);
const TERMINAL_STATES = new Set(["completed", "cancelled", "terminal_failure"]);
const RECORD_FIELDS_V1 = Object.freeze([
  "acceptedMaterial",
  "descriptorBytes",
  "domainId",
  "expectedDomainEpoch",
  "expectedNamespaceAccessRevision",
  "expectedPolicyRevision",
  "finishedAt",
  "idempotencyKey",
  "processorAuthorizationRevision",
  "purpose",
  "snapshot",
  "workIdentityHash",
  "workKind",
] as const);
const RECORD_FIELDS_AGENT_V2 = Object.freeze([
  "acceptedMaterial",
  "authoritySet",
  "descriptorBytes",
  "domainId",
  "expectedDomainEpoch",
  "expectedNamespaceAccessRevision",
  "expectedPolicyRevision",
  "finishedAt",
  "idempotencyKey",
  "processorAuthorizationRevision",
  "purpose",
  "snapshot",
  "workIdentityHash",
  "workKind",
] as const);
const RECORD_FIELDS_PROCESSOR_V2 = RECORD_FIELDS_V1;
const AUTHORITY_SET_FIELDS = Object.freeze([
  "domainRequirements",
  "namespaceRequirements",
] as const);
const NAMESPACE_REQUIREMENT_FIELDS = Object.freeze([
  "domainId",
  "expectedAccessRevision",
  "expectedPolicyRevision",
  "namespaceId",
  "operations",
  "ordinal",
] as const);
const DOMAIN_REQUIREMENT_FIELDS = Object.freeze([
  "domainId",
  "expectedAgentAuthorizationRevision",
  "expectedEpoch",
  "ordinal",
] as const);
const DOMAIN_REQUIREMENT_FIELDS_V3 = Object.freeze([
  "domainId",
  "expectedAuthorizationRevision",
  "expectedEpoch",
  "ordinal",
] as const);
const MAX_AUTHORITY_SET_SIZE = 256;
const ACCEPTED_MATERIAL_FIELDS = Object.freeze([
  "authorizationExpiresAt",
  "credentialId",
  "issuerSigningPublicKeyHash",
  "issuingDeviceAuthorizationRevision",
  "responseBytes",
] as const);
const SIGNER_EVIDENCE_FIELDS_V1 = Object.freeze([
  "authorizationBytes",
  "authorizationHash",
  "authorizationId",
  "createdAt",
  "credentialHash",
  "domainEpoch",
  "domainId",
  "expiresAt",
  "issuedAt",
  "issuerSigningPublicKeyHash",
  "issuingDeviceAuthorizationRevision",
  "issuingDeviceId",
  "issuingHumanId",
  "namespaceAccessRevision",
  "namespaceId",
  "policyRevision",
  "processorAuthorizationRevision",
  "recipientGeneration",
  "requestId",
  "signerKeyId",
  "signerPublicKey",
  "workDescriptorBytes",
  "workDescriptorHash",
  "workId",
] as const);
const SIGNER_EVIDENCE_FIELDS_V1_EXPLICIT = Object.freeze([
  "authorizationBytes",
  "authorizationHash",
  "authorizationId",
  "createdAt",
  "credentialHash",
  "domainEpoch",
  "domainId",
  "expiresAt",
  "formatVersion",
  "issuedAt",
  "issuerSigningPublicKeyHash",
  "issuingDeviceAuthorizationRevision",
  "issuingDeviceId",
  "issuingHumanId",
  "namespaceAccessRevision",
  "namespaceId",
  "policyRevision",
  "processorAuthorizationRevision",
  "recipientGeneration",
  "requestId",
  "signerKeyId",
  "signerPublicKey",
  "workDescriptorBytes",
  "workDescriptorHash",
  "workId",
] as const);
const SIGNER_EVIDENCE_FIELDS_V2 = SIGNER_EVIDENCE_FIELDS_V1_EXPLICIT;
const DEFAULT_PRUNE_LIMIT =
  BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS.pruningBatch;
const TERMINAL_RETENTION_MS =
  BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS.terminalRetentionDays
  * 24 * 60 * 60 * 1_000;
const PRODUCT_AUTHORIZATION_TTL_MS =
  BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS.productTtlSeconds * 1_000;
export const BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_LIMITS = Object.freeze({
  processor: BACKGROUND_AUTHORIZATION_BYTE_LIMITS.processorResponse,
  // lattice-crypto GrantV2 (2 MiB) + response framing (4 KiB)
  agent: 2 * 1_024 * 1_024 + 4 * 1_024,
  runtime: BACKGROUND_AUTHORIZATION_BYTE_LIMITS.runtimeResponse,
});

function cloneBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

function exactFields(
  label: string,
  value: object,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length
    || !actual.every((field, index) => field === expected[index])
  ) {
    throw new TypeError(`${label} contains unknown or missing fields`);
  }
}

function portable(label: string, value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES
    || !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
}

function counter(
  label: string,
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || value > maximum
  ) {
    throw new TypeError(`${label} must be a bounded counter`);
  }
}

function timestamp(label: string, value: unknown): asserts value is number {
  counter(label, value, BACKGROUND_AUTHORIZATION_MAX_TIMESTAMP_MS);
}

function exactBytes(
  label: string,
  value: unknown,
  length: number,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must contain exactly ${length} bytes`);
  }
}

function boundedBytes(
  label: string,
  value: unknown,
  maximum: number,
): asserts value is Uint8Array {
  if (
    !(value instanceof Uint8Array)
    || value.length < 1
    || value.length > maximum
  ) {
    throw new TypeError(`${label} exceeds its byte boundary`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export function isBackgroundAuthorizationResponseReplay(
  record: BackgroundAuthorizationRecord,
  response: BackgroundAuthorizationVerifiedDeviceResponse,
): boolean {
  const credentialHash = isRuntimeResponse(response)
    ? response.authorizationHash
    : response.credentialHash;
  const credentialId = isRuntimeResponse(response)
    ? response.authorizationId
    : response.credentialId;
  return record.snapshot.acceptedResponse?.responseDigest
      === hexBytes(response.responseHash)
    && record.snapshot.acceptedResponse.credentialDigest
      === hexBytes(credentialHash)
    && record.acceptedMaterial?.credentialId === credentialId
    && equalBytes(
      record.acceptedMaterial?.responseBytes ?? new Uint8Array(),
      response.responseBytes,
    );
}

function hexBytes(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function coherentWorkPurpose(
  workKind: BackgroundAuthorizationWorkKind,
  purpose: BackgroundAuthorizationPurpose,
): boolean {
  if (
    workKind === "stenographer.extraction"
    || workKind === "stenographer.historical"
  ) return purpose === "journal.extract";
  if (workKind === "stenographer.compaction") {
    return purpose === "journal.compact";
  }
  if (workKind === "stenographer.rebuild") return purpose === "journal.rebuild";
  if (workKind === "stenographer.publication_reconcile") return purpose === "journal.reconcile";
  if (workKind === "stenographer.output_repair") return purpose === "journal.repair";
  if (workKind === "reflection.authority_reproject") return purpose === "record.reproject";
  if (workKind === "reflection.publication_reconcile") return purpose === "record.reconcile";
  if (workKind === "reflection.search_projection") return purpose === "record.search_projection";
  if (workKind === "reflection.organization") return purpose === "record.organize";
  if (workKind === "reflection.dependency_rewrite") return purpose === "record.dependency_rewrite";
  return workKind === purpose;
}

function digestHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestMatches(bytes: Uint8Array, hexDigest: string): boolean {
  return digestHex(bytes) === hexDigest;
}

function parseAuthoritySet(
  value:
    | BackgroundAuthorizationAuthoritySetV2
    | BackgroundAuthorizationAuthoritySetV3,
  anchor: Readonly<{
    namespaceId: string;
    domainId: string;
    expectedDomainEpoch: number;
    expectedNamespaceAccessRevision: number;
    expectedPolicyRevision: number;
  }>,
  subjectKind: "agent" | "runtime",
): BackgroundAuthorizationAuthoritySetV2 | BackgroundAuthorizationAuthoritySetV3 {
  exactFields("Background authority set", value, AUTHORITY_SET_FIELDS);
  if (
    !Array.isArray(value.namespaceRequirements as unknown)
    || value.namespaceRequirements.length < 1
    || value.namespaceRequirements.length > (
      subjectKind === "runtime"
        ? MAX_AGENT_GRANT_NAMESPACES_V2
        : MAX_AUTHORITY_SET_SIZE
    )
    || !Array.isArray(value.domainRequirements as unknown)
    || value.domainRequirements.length < 1
    || value.domainRequirements.length > (
      subjectKind === "runtime"
        ? MAX_AGENT_GRANT_DOMAINS_V2
        : MAX_AUTHORITY_SET_SIZE
    )
  ) {
    throw new TypeError("Background authority set is empty or exceeds its bound");
  }

  let previousNamespaceId: string | null = null;
  const namespaceRequirements = value.namespaceRequirements.map(
    (requirement, index) => {
      exactFields(
        "Background Namespace requirement",
        requirement,
        NAMESPACE_REQUIREMENT_FIELDS,
      );
      counter("Background Namespace ordinal", requirement.ordinal);
      portable("Background Namespace id", requirement.namespaceId);
      portable("Background Namespace Domain id", requirement.domainId);
      counter(
        "Background Namespace access revision",
        requirement.expectedAccessRevision,
      );
      counter(
        "Background Namespace policy revision",
        requirement.expectedPolicyRevision,
      );
      if (
        requirement.ordinal !== index
        || (previousNamespaceId !== null
          && previousNamespaceId >= requirement.namespaceId)
      ) {
        throw new TypeError(
          "Background Namespace requirements must be uniquely canonical",
        );
      }
      if (
        !Array.isArray(requirement.operations as unknown)
        || requirement.operations.length < 1
        || requirement.operations.length > BACKGROUND_AUTHORIZATION_OPERATIONS.length
        || !requirement.operations.every(
          (operation: unknown, operationIndex: number) =>
            operation === BACKGROUND_AUTHORIZATION_OPERATIONS.filter(
              (candidate) => requirement.operations.includes(candidate),
            )[operationIndex],
        )
      ) {
        throw new TypeError(
          "Background Namespace operations must be non-empty and canonical",
        );
      }
      previousNamespaceId = requirement.namespaceId;
      return Object.freeze({
        ...requirement,
        operations: Object.freeze([...requirement.operations]),
      });
    },
  );

  let previousDomainId: string | null = null;
  const domainRequirements = value.domainRequirements.map(
    (requirement, index) => {
      exactFields(
        "Background Domain requirement",
        requirement,
        subjectKind === "runtime"
          ? DOMAIN_REQUIREMENT_FIELDS_V3
          : DOMAIN_REQUIREMENT_FIELDS,
      );
      counter("Background Domain ordinal", requirement.ordinal);
      portable("Background Domain id", requirement.domainId);
      counter("Background Domain epoch", requirement.expectedEpoch);
      if (subjectKind === "runtime") {
        counter(
          "Background Runtime Domain authorization revision",
          (requirement as BackgroundAuthorizationDomainRequirementV3)
            .expectedAuthorizationRevision,
        );
      } else {
        counter(
          "Background Agent Domain authorization revision",
          (requirement as BackgroundAuthorizationDomainRequirementV2)
            .expectedAgentAuthorizationRevision,
        );
      }
      if (
        requirement.ordinal !== index
        || (previousDomainId !== null && previousDomainId >= requirement.domainId)
      ) {
        throw new TypeError(
          "Background Domain requirements must be uniquely canonical",
        );
      }
      previousDomainId = requirement.domainId;
      return Object.freeze({ ...requirement });
    },
  );

  const namespaceDomainIds = [...new Set(
    namespaceRequirements.map((requirement) => requirement.domainId),
  )].sort();
  if (
    namespaceDomainIds.length !== domainRequirements.length
    || !domainRequirements.every(
      (requirement, index) => requirement.domainId === namespaceDomainIds[index],
    )
  ) {
    throw new TypeError(
      "Background Domain requirements must exactly cover Namespace Domains",
    );
  }

  const anchorNamespace = namespaceRequirements.find(
    (requirement) => requirement.namespaceId === anchor.namespaceId,
  );
  const anchorDomain = domainRequirements.find(
    (requirement) => requirement.domainId === anchor.domainId,
  );
  if (
    anchorNamespace?.domainId !== anchor.domainId
    || anchorNamespace.expectedAccessRevision
      !== anchor.expectedNamespaceAccessRevision
    || anchorNamespace.expectedPolicyRevision !== anchor.expectedPolicyRevision
    || anchorDomain?.expectedEpoch !== anchor.expectedDomainEpoch
  ) {
    throw new TypeError(
      "Background v2 compatibility anchor does not match its authority set",
    );
  }

  return Object.freeze({
    namespaceRequirements: Object.freeze(namespaceRequirements),
    domainRequirements: Object.freeze(domainRequirements),
  }) as BackgroundAuthorizationAuthoritySetV2
    | BackgroundAuthorizationAuthoritySetV3;
}

export function parseBackgroundAuthorizationRecord(
  value: BackgroundAuthorizationRecord,
): BackgroundAuthorizationRecord {
  const snapshot = parseBackgroundAuthorizationRequestSnapshot(value.snapshot);
  exactFields(
    "Background authorization record",
    value,
    snapshot.formatVersion === 2 || snapshot.formatVersion === 3
      ? snapshot.credentialSubject.kind === "processor"
        ? RECORD_FIELDS_PROCESSOR_V2
        : RECORD_FIELDS_AGENT_V2
      : RECORD_FIELDS_V1,
  );
  exactBytes(
    "Background work identity hash",
    value.workIdentityHash,
    BACKGROUND_AUTHORIZATION_BYTE_LIMITS.hash,
  );
  portable("Background idempotency key", value.idempotencyKey);
  portable("Background Domain id", value.domainId);
  if (
    !WORK_KIND_SET.has(value.workKind)
    || !PURPOSE_SET.has(value.purpose)
    || !coherentWorkPurpose(value.workKind, value.purpose)
    || (["stenographer.publication_reconcile", "stenographer.output_repair"].includes(value.workKind)
      && (snapshot.formatVersion !== 2 || snapshot.credentialSubject.kind !== "processor"))
  ) {
    throw new TypeError("Invalid background work kind/purpose");
  }
  if (["task.cancel_result", "task.deliver_message", "task.deliver_result", "task.delivery_wake"].includes(value.workKind)
    && (snapshot.formatVersion !== 3 || snapshot.credentialSubject.kind !== "runtime")) {
    throw new TypeError("Terminal Task publication requires Task Runtime custody");
  }
  if (
    snapshot.credentialSubject.kind === "runtime"
    && (
      (
        value.workKind !== "task.dispatch"
        && value.workKind !== "task.execute"
        && value.workKind !== "task.await_reply_resume"
        && value.workKind !== "task.approval_resume"
        && value.workKind !== "task.cancel_result"
        && value.workKind !== "task.deliver_message"
        && value.workKind !== "task.deliver_result"
        && value.workKind !== "task.delivery_wake"
      )
      || value.purpose !== value.workKind
    )
  ) {
    throw new TypeError(
      "Task Runtime authorization requires an exact Task work purpose",
    );
  }
  if (
    snapshot.formatVersion !== 1
    && snapshot.credentialSubject.kind === "processor"
  ) {
    if (value.expectedDomainEpoch !== null) {
      throw new TypeError("Background processor v2 cannot carry a legacy Domain epoch");
    }
  } else {
    counter("Expected Domain epoch", value.expectedDomainEpoch);
  }
  counter(
    "Expected Namespace access revision",
    value.expectedNamespaceAccessRevision,
  );
  counter("Expected policy revision", value.expectedPolicyRevision);

  if (snapshot.credentialSubject.kind === "processor") {
    if (!value.workKind.startsWith(`${snapshot.credentialSubject.processorKind}.`)
      || (snapshot.credentialSubject.processorKind === "reflection" && snapshot.formatVersion !== 2)) {
      throw new TypeError("Processor authorization requires its exact work purpose");
    }
    if (snapshot.formatVersion !== 1 && !("authorizationRevision" in snapshot.credentialSubject)) {
      if (value.processorAuthorizationRevision !== null) {
        throw new TypeError(
          "Background processor v2 cannot carry a processor authorization revision",
        );
      }
    } else {
      counter(
        "Processor authorization revision",
        value.processorAuthorizationRevision,
      );
      if (
        !("authorizationRevision" in snapshot.credentialSubject)
        || snapshot.credentialSubject.authorizationRevision
        !== value.processorAuthorizationRevision
      ) {
        throw new TypeError("Processor authorization revision drift");
      }
    }
  } else if (
    value.processorAuthorizationRevision !== null
    || value.workKind.startsWith("stenographer.")
    || value.workKind.startsWith("reflection.")
  ) {
    throw new TypeError("Non-processor authorization cannot carry processor authority");
  }

  if (snapshot.descriptorDigest === null) {
    if (value.descriptorBytes !== null) {
      throw new TypeError("Descriptor bytes require a descriptor digest");
    }
  } else {
    boundedBytes(
      "Background descriptor",
      value.descriptorBytes,
      (snapshot.formatVersion !== 1
        && snapshot.credentialSubject.kind === "processor"
        && snapshot.credentialSubject.processorKind === "reflection")
        || snapshot.credentialSubject.kind === "runtime"
        ? BACKGROUND_AUTHORIZATION_BYTE_LIMITS.descriptor
        : BACKGROUND_AUTHORIZATION_BYTE_LIMITS.legacyDescriptor,
    );
    if (!digestMatches(value.descriptorBytes, snapshot.descriptorDigest)) {
      throw new TypeError("Descriptor bytes do not match the durable digest");
    }
  }

  if (snapshot.acceptedResponse === null) {
    if (value.acceptedMaterial !== null) {
      throw new TypeError("Accepted material requires an accepted response");
    }
  } else {
    if (value.acceptedMaterial === null) {
      throw new TypeError("Accepted response material is missing");
    }
    exactFields(
      "Background accepted response material",
      value.acceptedMaterial,
      ACCEPTED_MATERIAL_FIELDS,
    );
    boundedBytes(
      "Background response",
      value.acceptedMaterial.responseBytes,
      snapshot.credentialSubject.kind === "processor"
        && snapshot.credentialSubject.processorKind === "stenographer"
        ? BACKGROUND_AUTHORIZATION_BYTE_LIMITS.legacyProcessorResponse
        : BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_LIMITS[snapshot.credentialSubject.kind],
    );
    portable(
      "Background credential id",
      value.acceptedMaterial.credentialId,
    );
    counter(
      "Issuing device authorization revision",
      value.acceptedMaterial.issuingDeviceAuthorizationRevision,
    );
    exactBytes(
      "Issuer signing public key hash",
      value.acceptedMaterial.issuerSigningPublicKeyHash,
      BACKGROUND_AUTHORIZATION_BYTE_LIMITS.hash,
    );
    timestamp(
      "Authorization expiry",
      value.acceptedMaterial.authorizationExpiresAt,
    );
    if (
      !digestMatches(
        value.acceptedMaterial.responseBytes,
        snapshot.acceptedResponse.responseDigest,
      )
      || value.acceptedMaterial.authorizationExpiresAt
        <= snapshot.acceptedResponse.acceptedAt
      || value.acceptedMaterial.authorizationExpiresAt
        - snapshot.acceptedResponse.acceptedAt
        > PRODUCT_AUTHORIZATION_TTL_MS
    ) {
      throw new TypeError("Accepted response material is inconsistent");
    }
  }

  if (snapshot.recipient !== null) {
    const recipientIssuedAt = snapshot.acceptedResponse?.acceptedAt
      ?? snapshot.updatedAt;
    if (
      snapshot.recipient.expiresAt - recipientIssuedAt
      > PRODUCT_AUTHORIZATION_TTL_MS
    ) {
      throw new TypeError("Recipient lifetime exceeds product policy");
    }
  }

  const terminal = TERMINAL_STATES.has(snapshot.state);
  if (terminal !== (value.finishedAt !== null)) {
    throw new TypeError("Finished timestamp/state mismatch");
  }
  if (value.finishedAt !== null) {
    timestamp("Background finished timestamp", value.finishedAt);
    if (value.finishedAt < snapshot.updatedAt) {
      throw new TypeError("Finished timestamp precedes the last update");
    }
  }

  const common = {
    ...value,
    snapshot,
    workIdentityHash: cloneBytes(value.workIdentityHash),
    descriptorBytes: value.descriptorBytes === null
      ? null
      : cloneBytes(value.descriptorBytes),
    acceptedMaterial: value.acceptedMaterial === null
      ? null
      : Object.freeze({
        ...value.acceptedMaterial,
        responseBytes: cloneBytes(value.acceptedMaterial.responseBytes),
        issuerSigningPublicKeyHash: cloneBytes(
          value.acceptedMaterial.issuerSigningPublicKeyHash,
        ),
      }),
  };
  if (snapshot.formatVersion === 1) {
    return Object.freeze(common) as BackgroundAuthorizationRecordV1;
  }
  if (snapshot.credentialSubject.kind === "processor") {
    return Object.freeze(common) as BackgroundAuthorizationProcessorRecordV2;
  }
  if (!("authoritySet" in value)) {
    throw new TypeError("Background v2 authority set is missing");
  }
  const protectedSubject = snapshot.credentialSubject;
  const parsed = Object.freeze({
    ...common,
    snapshot,
    authoritySet: parseAuthoritySet(value.authoritySet, {
      namespaceId: snapshot.namespaceId,
      domainId: value.domainId,
      expectedDomainEpoch: value.expectedDomainEpoch!,
      expectedNamespaceAccessRevision: value.expectedNamespaceAccessRevision,
      expectedPolicyRevision: value.expectedPolicyRevision,
    }, protectedSubject.kind),
  });
  if (value.workKind === "task.cancel_result" || value.workKind === "task.deliver_message") {
    const namespaces = parsed.authoritySet.namespaceRequirements;
    if (namespaces.length !== 1 || parsed.authoritySet.domainRequirements.length !== 1
      || namespaces[0]!.operations.length !== 1 || namespaces[0]!.operations[0] !== "encrypt") {
      throw new TypeError("Terminal Task publication requires one write-only Namespace");
    }
  }
  return parsed as BackgroundAuthorizationRecord;
}

export function parseProcessorSignerAuthorizationEvidence(
  value: ProcessorSignerAuthorizationEvidence,
): ProcessorSignerAuthorizationEvidence {
  const formatVersion = value.formatVersion ?? 1;
  exactFields(
    "Processor signer authorization evidence",
    value,
    formatVersion === 2
      ? SIGNER_EVIDENCE_FIELDS_V2
      : value.formatVersion === 1
        ? SIGNER_EVIDENCE_FIELDS_V1_EXPLICIT
        : SIGNER_EVIDENCE_FIELDS_V1,
  );
  if (formatVersion !== 1 && formatVersion !== 2) {
    throw new TypeError("Processor signer evidence format is unsupported");
  }
  portable("Processor signer authorization id", value.authorizationId);
  portable("Processor signer request id", value.requestId);
  counter(
    "Processor signer recipient generation",
    value.recipientGeneration,
    BACKGROUND_AUTHORIZATION_MAX_GENERATION,
  );
  portable("Processor signer work id", value.workId);
  portable("Processor signer Namespace id", value.namespaceId);
  portable("Processor signer Domain id", value.domainId);
  if (formatVersion === 2) {
    if (
      value.domainEpoch !== null
      || value.processorAuthorizationRevision !== null
    ) {
      throw new TypeError("Processor signer v2 cannot carry legacy authority");
    }
  } else {
    counter("Processor signer Domain epoch", value.domainEpoch);
    counter(
      "Processor authorization revision",
      value.processorAuthorizationRevision,
    );
  }
  counter(
    "Processor signer Namespace revision",
    value.namespaceAccessRevision,
  );
  counter("Processor signer policy revision", value.policyRevision);
  portable("Processor signer Human id", value.issuingHumanId);
  portable("Processor signer device id", value.issuingDeviceId);
  counter(
    "Processor signer device revision",
    value.issuingDeviceAuthorizationRevision,
  );
  exactBytes(
    "Processor signer issuer key hash",
    value.issuerSigningPublicKeyHash,
    BACKGROUND_AUTHORIZATION_BYTE_LIMITS.hash,
  );
  portable("Processor signer key id", value.signerKeyId);
  exactBytes(
    "Processor signer public key",
    value.signerPublicKey,
    BACKGROUND_AUTHORIZATION_BYTE_LIMITS.signingPublicKey,
  );
  exactBytes(
    "Processor signer work descriptor hash",
    value.workDescriptorHash,
    BACKGROUND_AUTHORIZATION_BYTE_LIMITS.hash,
  );
  boundedBytes(
    "Processor signer work descriptor",
    value.workDescriptorBytes,
    BACKGROUND_AUTHORIZATION_BYTE_LIMITS.descriptor,
  );
  const calculatedDescriptorHash = Uint8Array.from(
    createHash("sha256").update(value.workDescriptorBytes).digest(),
  );
  try {
    if (!equalBytes(calculatedDescriptorHash, value.workDescriptorHash)) {
      throw new TypeError(
        "Processor signer work descriptor hash is invalid",
      );
    }
  } finally {
    calculatedDescriptorHash.fill(0);
  }
  exactBytes(
    "Processor signer authorization hash",
    value.authorizationHash,
    BACKGROUND_AUTHORIZATION_BYTE_LIMITS.hash,
  );
  exactBytes(
    "Processor signer credential hash",
    value.credentialHash,
    BACKGROUND_AUTHORIZATION_BYTE_LIMITS.hash,
  );
  boundedBytes(
    "Processor signer authorization",
    value.authorizationBytes,
    BACKGROUND_AUTHORIZATION_BYTE_LIMITS.signerAuthorization,
  );
  timestamp("Processor signer issue time", value.issuedAt);
  timestamp("Processor signer expiry", value.expiresAt);
  timestamp("Processor signer creation time", value.createdAt);
  if (
    value.issuedAt > value.createdAt
    || value.createdAt >= value.expiresAt
    || value.expiresAt - value.issuedAt > PRODUCT_AUTHORIZATION_TTL_MS
  ) {
    throw new TypeError("Processor signer authorization time order is invalid");
  }
  const cloned = {
    ...value,
    issuerSigningPublicKeyHash: cloneBytes(value.issuerSigningPublicKeyHash),
    signerPublicKey: cloneBytes(value.signerPublicKey),
    workDescriptorHash: cloneBytes(value.workDescriptorHash),
    workDescriptorBytes: cloneBytes(value.workDescriptorBytes),
    authorizationHash: cloneBytes(value.authorizationHash),
    credentialHash: cloneBytes(value.credentialHash),
    authorizationBytes: cloneBytes(value.authorizationBytes),
  };
  if (formatVersion === 2) {
    return Object.freeze({ ...cloned, formatVersion: 2 }) as
      ProcessorSignerAuthorizationEvidenceV2;
  }
  return Object.freeze(cloned) as ProcessorSignerAuthorizationEvidenceV1;
}

function isAgentV2Response(
  response: BackgroundAuthorizationVerifiedDeviceResponse,
): response is VerifiedAgentBackgroundAuthorizationDeviceResponseV2 {
  return "formatVersion" in response && response.formatVersion === 2
    && response.kind === "agent";
}

function isProcessorV2Response(
  response: BackgroundAuthorizationVerifiedDeviceResponse,
): response is BackgroundAuthorizationVerifiedProcessorResponseV2 {
  return "formatVersion" in response && response.formatVersion === 2
    && response.kind === "processor";
}

function isRuntimeV3Response(
  response: BackgroundAuthorizationVerifiedDeviceResponse,
): response is BackgroundAuthorizationVerifiedRuntimeResponseV3 {
  return "formatVersion" in response && response.formatVersion === 3
    && response.kind === "runtime";
}

function isRuntimeV4Response(
  response: BackgroundAuthorizationVerifiedDeviceResponse,
): response is BackgroundAuthorizationVerifiedRuntimeResponseV4 {
  return "formatVersion" in response && response.formatVersion === 4
    && response.kind === "runtime";
}

function isRuntimeResponse(
  response: BackgroundAuthorizationVerifiedDeviceResponse,
): response is BackgroundAuthorizationVerifiedRuntimeResponseV3
  | BackgroundAuthorizationVerifiedRuntimeResponseV4 {
  return isRuntimeV3Response(response) || isRuntimeV4Response(response);
}

function assertSupportedVerifiedResponse(
  response: BackgroundAuthorizationVerifiedDeviceResponse,
): void {
  const formatVersion = (response as Readonly<{
    readonly formatVersion?: unknown;
  }>).formatVersion;
  if (
    formatVersion !== undefined
    && (
      (
        formatVersion !== 2
        && formatVersion !== 3
        && formatVersion !== 4
      )
      || (
        !isAgentV2Response(response)
        && !isProcessorV2Response(response)
        && !isRuntimeV3Response(response)
        && !isRuntimeV4Response(response)
      )
    )
  ) {
    throw new TypeError("Unsupported verified response format or subject kind");
  }
}

function verifiedResponseAuthorityMatches(
  current: BackgroundAuthorizationRecord,
  response: BackgroundAuthorizationVerifiedDeviceResponse,
): boolean {
  if (isProcessorV2Response(response)) return false;
  if (isRuntimeResponse(response)) {
    return current.snapshot.formatVersion === 3
      && current.snapshot.credentialSubject.kind === "runtime"
      && current.authoritySet !== undefined
      && JSON.stringify(response.authoritySet)
        === JSON.stringify(current.authoritySet);
  }
  if (isAgentV2Response(response)) {
    if (
      current.snapshot.formatVersion !== 2
      || current.snapshot.credentialSubject.kind !== "agent"
      || current.authoritySet === undefined
      || response.anchorNamespaceId !== current.snapshot.namespaceId
      || response.anchorDomainId !== current.domainId
      || response.namespaceRequirements.length
        !== current.authoritySet.namespaceRequirements.length
      || response.domainRequirements.length
        !== current.authoritySet.domainRequirements.length
    ) return false;
    const authoritySet = current.authoritySet as
      BackgroundAuthorizationAuthoritySetV2;
    return response.namespaceRequirements.every((actual, index) => {
      const expected = authoritySet.namespaceRequirements[index]!;
      return actual.namespaceId === expected.namespaceId
        && actual.domainId === expected.domainId
        && JSON.stringify(actual.operations)
          === JSON.stringify(expected.operations)
        && actual.expectedAccessRevision === expected.expectedAccessRevision
        && actual.expectedPolicyRevision === expected.expectedPolicyRevision;
    }) && response.domainRequirements.every((actual, index) => {
      const expected = authoritySet.domainRequirements[index]!;
      return actual.domainId === expected.domainId
        && actual.expectedEpoch === expected.expectedEpoch
        && actual.expectedAgentAuthorizationRevision
          === expected.expectedAgentAuthorizationRevision;
    });
  }
  return current.snapshot.formatVersion === 1
    && response.namespaceId === current.snapshot.namespaceId
    && response.domainId === current.domainId
    && response.domainEpoch === current.expectedDomainEpoch
    && response.namespaceAccessRevision
      === current.expectedNamespaceAccessRevision
    && response.policyRevision === current.expectedPolicyRevision;
}

function buildAcceptedBackgroundRuntimeAuthorizationResponseV4(
  current: BackgroundAuthorizationRecord,
  response: BackgroundAuthorizationVerifiedRuntimeResponseV4,
  acceptedAt: number,
): Readonly<{
  readonly next: BackgroundAuthorizationRecord;
  readonly signerEvidence: null;
}> {
  const recipient = current.snapshot.recipient;
  if (
    response.responseBytes.length
      > MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2
  ) {
    throw new TypeError(
      "Verified Runtime response does not match current durable authorization",
    );
  }

  let decoded:
    | Readonly<{
      readonly authorizationBytes: Uint8Array;
      readonly certificateBytes: Uint8Array;
    }>
    | undefined;
  let canonical: Uint8Array | undefined;
  try {
    decoded = decodeTaskRuntimeBackgroundAuthorizationResponseV2(
      response.responseBytes,
    );
    canonical = encodeTaskRuntimeBackgroundAuthorizationResponseV2(decoded);
    if (
      current.snapshot.formatVersion !== 3
      || current.snapshot.credentialSubject.kind !== "runtime"
      || current.snapshot.credentialSubject.runtimeKind !== "task"
      || current.snapshot.credentialSubject.runtimeVersion !== 1
      || current.authoritySet === undefined
      || current.descriptorBytes === null
      || current.snapshot.descriptorDigest === null
      || response.requestId !== current.snapshot.requestId
      || response.recipientGeneration !== current.snapshot.recipientGeneration
      || response.workId !== current.snapshot.workId
      || response.workKind !== current.workKind
      || response.purpose !== current.purpose
      || !isTaskExecutionWorkKind(response.workKind)
        && !isTaskPublicationWorkKind(response.workKind)
      || !verifiedResponseAuthorityMatches(current, response)
      || response.recipientKeyId !== recipient?.recipientKeyId
      || Buffer.from(response.recipientPublicKey).toString("base64url")
        !== recipient.recipientPublicKey
      || response.issuedAt > acceptedAt
      || response.expiresAt !== recipient.expiresAt
      || response.expiresAt <= acceptedAt
      || response.expiresAt - response.issuedAt > PRODUCT_AUTHORIZATION_TTL_MS
      || response.expiresAt - acceptedAt > PRODUCT_AUTHORIZATION_TTL_MS
      || !equalBytes(response.responseBytes, canonical)
      || !equalBytes(response.authorizationBytes, decoded.authorizationBytes)
      || !equalBytes(response.certificateBytes, decoded.certificateBytes)
      || !equalBytes(response.descriptorBytes, current.descriptorBytes)
      || hexBytes(response.descriptorHash) !== current.snapshot.descriptorDigest
      || !digestMatches(
        response.descriptorBytes,
        current.snapshot.descriptorDigest,
      )
      || hexBytes(response.responseHash) !== digestHex(response.responseBytes)
      || hexBytes(response.authorizationHash)
        !== digestHex(response.authorizationBytes)
    ) {
      throw new TypeError(
        "Verified Runtime response does not match current durable authorization",
      );
    }
    portable("Runtime authorization id", response.authorizationId);
    portable("Runtime authorization Human id", response.issuingHumanId);
    portable("Runtime authorization device id", response.issuingDeviceId);
    counter(
      "Runtime authorization device revision",
      response.issuingDeviceAuthorizationRevision,
    );
    exactBytes(
      "Runtime authorization issuer key hash",
      response.issuerSigningPublicKeyHash,
      BACKGROUND_AUTHORIZATION_BYTE_LIMITS.hash,
    );

    const nextSnapshot = markBackgroundAuthorizationGrantReady(
      current.snapshot,
      {
        kind: "runtime",
        requestId: response.requestId,
        descriptorDigest: hexBytes(response.descriptorHash),
        recipientKeyId: response.recipientKeyId,
        recipientPublicKey: Buffer.from(response.recipientPublicKey).toString(
          "base64url",
        ),
        expiresAt: response.expiresAt,
        responseDigest: hexBytes(response.responseHash),
        credentialDigest: hexBytes(response.authorizationHash),
        issuingHumanId: response.issuingHumanId,
        issuingDeviceId: response.issuingDeviceId,
        recipientGeneration: response.recipientGeneration,
        now: acceptedAt,
      },
    );
    return Object.freeze({
      next: parseBackgroundAuthorizationRecord({
        ...current,
        snapshot: nextSnapshot,
        acceptedMaterial: {
          responseBytes: response.responseBytes,
          credentialId: response.authorizationId,
          issuingDeviceAuthorizationRevision:
            response.issuingDeviceAuthorizationRevision,
          issuerSigningPublicKeyHash: response.issuerSigningPublicKeyHash,
          authorizationExpiresAt: response.expiresAt,
        },
      }),
      signerEvidence: null,
    });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(
      "Verified Runtime response does not match current durable authorization",
    );
  } finally {
    decoded?.authorizationBytes.fill(0);
    decoded?.certificateBytes.fill(0);
    canonical?.fill(0);
  }
}

export function backgroundAuthorizationVerifiedResponseRequestId(
  response: BackgroundAuthorizationVerifiedDeviceResponse,
): string {
  assertSupportedVerifiedResponse(response);
  return isProcessorV2Response(response)
    ? response.descriptor.requestId
    : response.requestId;
}

function buildAcceptedBackgroundRuntimeAuthorizationResponseV3(
  current: BackgroundAuthorizationRecord,
  response: BackgroundAuthorizationVerifiedRuntimeResponseV3,
  acceptedAt: number,
): Readonly<{
  readonly next: BackgroundAuthorizationRecord;
  readonly signerEvidence: null;
}> {
  const recipient = current.snapshot.recipient;
  if (
    current.snapshot.formatVersion !== 3
    || current.snapshot.credentialSubject.kind !== "runtime"
    || current.snapshot.credentialSubject.runtimeKind !== "task"
    || current.snapshot.credentialSubject.runtimeVersion !== 1
    || current.authoritySet === undefined
    || current.descriptorBytes === null
    || current.snapshot.descriptorDigest === null
    || response.requestId !== current.snapshot.requestId
    || response.recipientGeneration !== current.snapshot.recipientGeneration
    || response.workId !== current.snapshot.workId
    || response.workKind !== current.workKind
    || response.purpose !== current.purpose
    || !response.workKind.startsWith("task.")
    || !verifiedResponseAuthorityMatches(current, response)
    || response.recipientKeyId !== recipient?.recipientKeyId
    || Buffer.from(response.recipientPublicKey).toString("base64url")
      !== recipient.recipientPublicKey
    || response.issuedAt > acceptedAt
    || response.expiresAt !== recipient.expiresAt
    || response.expiresAt <= acceptedAt
    || response.expiresAt - response.issuedAt > PRODUCT_AUTHORIZATION_TTL_MS
    || response.expiresAt - acceptedAt > PRODUCT_AUTHORIZATION_TTL_MS
    || response.responseBytes.length
      > BACKGROUND_AUTHORIZATION_BYTE_LIMITS.legacyRuntimeResponse
    || !equalBytes(response.descriptorBytes, current.descriptorBytes)
    || hexBytes(response.descriptorHash) !== current.snapshot.descriptorDigest
    || !digestMatches(response.descriptorBytes, current.snapshot.descriptorDigest)
    || hexBytes(response.responseHash) !== digestHex(response.responseBytes)
    || hexBytes(response.authorizationHash) !== digestHex(response.responseBytes)
    || !equalBytes(response.responseHash, response.authorizationHash)
  ) {
    throw new TypeError(
      "Verified Runtime response does not match current durable authorization",
    );
  }
  portable("Runtime authorization id", response.authorizationId);
  portable("Runtime authorization Human id", response.issuingHumanId);
  portable("Runtime authorization device id", response.issuingDeviceId);
  counter(
    "Runtime authorization device revision",
    response.issuingDeviceAuthorizationRevision,
  );
  exactBytes(
    "Runtime authorization issuer key hash",
    response.issuerSigningPublicKeyHash,
    BACKGROUND_AUTHORIZATION_BYTE_LIMITS.hash,
  );

  const nextSnapshot = markBackgroundAuthorizationGrantReady(
    current.snapshot,
    {
      kind: "runtime",
      requestId: response.requestId,
      descriptorDigest: hexBytes(response.descriptorHash),
      recipientKeyId: response.recipientKeyId,
      recipientPublicKey: Buffer.from(response.recipientPublicKey).toString(
        "base64url",
      ),
      expiresAt: response.expiresAt,
      responseDigest: hexBytes(response.responseHash),
      credentialDigest: hexBytes(response.authorizationHash),
      issuingHumanId: response.issuingHumanId,
      issuingDeviceId: response.issuingDeviceId,
      recipientGeneration: response.recipientGeneration,
      now: acceptedAt,
    },
  );
  return Object.freeze({
    next: parseBackgroundAuthorizationRecord({
      ...current,
      snapshot: nextSnapshot,
      acceptedMaterial: {
        responseBytes: response.responseBytes,
        credentialId: response.authorizationId,
        issuingDeviceAuthorizationRevision:
          response.issuingDeviceAuthorizationRevision,
        issuerSigningPublicKeyHash: response.issuerSigningPublicKeyHash,
        authorizationExpiresAt: response.expiresAt,
      },
    }),
    signerEvidence: null,
  });
}

function buildAcceptedBackgroundAuthorizationResponseV2(
  current: BackgroundAuthorizationRecord,
  response: BackgroundAuthorizationVerifiedProcessorResponseV2,
  acceptedAt: number,
): Readonly<{
  readonly next: BackgroundAuthorizationRecord;
  readonly signerEvidence: ProcessorSignerAuthorizationEvidenceV2;
}> {
  const inspected = inspectBackgroundAuthorizationResponseV2(
    response.responseBytes,
  );
  const decodedResponse = decodeBackgroundAuthorizationResponseV2(
    response.responseBytes,
  );
  const descriptor = inspected.descriptor;
  const descriptorBytes = encodeBackgroundWorkDescriptorV2(descriptor);
  const responseDescriptorBytes = encodeBackgroundWorkDescriptorV2(
    response.descriptor,
  );
  const authority = backgroundProcessorNamespaceRequirementsV2(descriptor)
    .find(entry => entry.authority.namespaceId === descriptor.anchorNamespaceId)?.authority;
  if (authority === undefined) throw new TypeError("Processor authority anchor is missing");
  const recipient = current.snapshot.recipient;
  const issuerScalarFields = [
    "humanId",
    "deviceId",
    "deviceGeneration",
    "serverInstanceId",
    "lineageGeneration",
    "epoch",
    "securityRevision",
  ] as const;
  if (
    current.snapshot.formatVersion !== 2
    || current.snapshot.credentialSubject.kind !== "processor"
    || current.processorAuthorizationRevision !== null
    || current.expectedDomainEpoch !== null
    || current.descriptorBytes === null
    || current.snapshot.descriptorDigest === null
    || descriptor.formatVersion !== 2
    || descriptor.requestId !== current.snapshot.requestId
    || descriptor.recipientGeneration !== current.snapshot.recipientGeneration
    || descriptor.workId !== current.snapshot.workId
    || descriptor.workKind !== current.workKind
    || descriptor.purpose !== current.purpose
    || descriptor.subject.kind !== "processor"
    || descriptor.subject.processorKind !== current.snapshot.credentialSubject.processorKind
    || descriptor.subject.processorVersion !== 1
    || descriptor.anchorNamespaceId !== current.snapshot.namespaceId
    || descriptor.anchorDomainId !== current.domainId
    || authority.namespaceId !== current.snapshot.namespaceId
    || authority.domainId !== current.domainId
    || authority.namespaceAccessRevision
      !== current.expectedNamespaceAccessRevision
    || descriptor.policyRevision !== current.expectedPolicyRevision
    || descriptor.recipientKeyId !== recipient?.recipientKeyId
    || Buffer.from(descriptor.recipientPublicKey).toString("base64url")
      !== recipient.recipientPublicKey
    || descriptor.notBefore > acceptedAt
    || descriptor.expiresAt <= acceptedAt
    || descriptor.expiresAt - acceptedAt > PRODUCT_AUTHORIZATION_TTL_MS
    || response.responseBytes.length
      > BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_LIMITS.processor
    || !equalBytes(current.descriptorBytes, descriptorBytes)
    || !equalBytes(response.descriptorBytes, descriptorBytes)
    || !equalBytes(responseDescriptorBytes, descriptorBytes)
    || !equalBytes(response.signerAuthorizationBytes,
      decodedResponse.signerAuthorizationBytes)
    || !equalBytes(response.credentialBytes, decodedResponse.credentialBytes)
    || !equalBytes(response.descriptorHash, inspected.descriptorHash)
    || !equalBytes(response.issuer.headDigest, inspected.issuer.headDigest)
    || !equalBytes(response.issuer.signingPublicKeyHash,
      inspected.issuer.signingPublicKeyHash)
    || issuerScalarFields.some((field) =>
      response.issuer[field] !== inspected.issuer[field]
    )
    || hexBytes(response.responseHash) !== digestHex(response.responseBytes)
    || hexBytes(response.credentialHash)
      !== digestHex(decodedResponse.credentialBytes)
    || hexBytes(response.signerAuthorizationHash)
      !== digestHex(decodedResponse.signerAuthorizationBytes)
    || response.signer.signerAuthorizationId !== response.credentialId
    || response.signer.signerKeyId
      !== `processor_invocation_signer_${digestHex(response.signerPublicKey)}`
    || !equalBytes(response.signer.workDescriptorHash, response.descriptorHash)
    || hexBytes(response.descriptorHash) !== current.snapshot.descriptorDigest
    || !digestMatches(response.descriptorBytes, current.snapshot.descriptorDigest)
  ) {
    throw new TypeError(
      "Verified processor v2 response does not match current durable authorization",
    );
  }

  const nextSnapshot = markBackgroundAuthorizationGrantReady(
    current.snapshot,
    {
      kind: "processor",
      requestId: descriptor.requestId,
      descriptorDigest: hexBytes(response.descriptorHash),
      recipientKeyId: descriptor.recipientKeyId,
      recipientPublicKey: Buffer.from(descriptor.recipientPublicKey).toString(
        "base64url",
      ),
      expiresAt: descriptor.expiresAt,
      responseDigest: hexBytes(response.responseHash),
      credentialDigest: hexBytes(response.credentialHash),
      issuingHumanId: response.issuer.humanId,
      issuingDeviceId: response.issuer.deviceId,
      recipientGeneration: descriptor.recipientGeneration,
      now: acceptedAt,
    },
  );
  const next = parseBackgroundAuthorizationRecord({
    ...current,
    snapshot: nextSnapshot,
    acceptedMaterial: {
      responseBytes: response.responseBytes,
      credentialId: response.credentialId,
      issuingDeviceAuthorizationRevision: response.issuer.securityRevision,
      issuerSigningPublicKeyHash: response.issuer.signingPublicKeyHash,
      authorizationExpiresAt: descriptor.expiresAt,
    },
  });
  return Object.freeze({
    next,
    signerEvidence: parseProcessorSignerAuthorizationEvidence({
      formatVersion: 2,
      authorizationId: response.signer.signerAuthorizationId,
      requestId: descriptor.requestId,
      recipientGeneration: descriptor.recipientGeneration,
      workId: descriptor.workId,
      namespaceId: authority.namespaceId,
      domainId: authority.domainId,
      domainEpoch: null,
      namespaceAccessRevision: authority.namespaceAccessRevision,
      policyRevision: descriptor.policyRevision,
      processorAuthorizationRevision: null,
      issuingHumanId: response.issuer.humanId,
      issuingDeviceId: response.issuer.deviceId,
      issuingDeviceAuthorizationRevision: response.issuer.securityRevision,
      issuerSigningPublicKeyHash: response.issuer.signingPublicKeyHash,
      signerKeyId: response.signer.signerKeyId,
      signerPublicKey: response.signerPublicKey,
      workDescriptorHash: response.descriptorHash,
      workDescriptorBytes: response.descriptorBytes,
      authorizationHash: response.signerAuthorizationHash,
      credentialHash: response.credentialHash,
      authorizationBytes: response.signerAuthorizationBytes,
      issuedAt: descriptor.issuedAt,
      expiresAt: descriptor.expiresAt,
      createdAt: acceptedAt,
    }) as ProcessorSignerAuthorizationEvidenceV2,
  });
}

export function buildAcceptedBackgroundAuthorizationResponse(
  currentInput: BackgroundAuthorizationRecord,
  response: BackgroundAuthorizationVerifiedDeviceResponse,
  acceptedAt: number,
): Readonly<{
  readonly next: BackgroundAuthorizationRecord;
  readonly signerEvidence: ProcessorSignerAuthorizationEvidence | null;
}> {
  const current = parseBackgroundAuthorizationRecord(currentInput);
  timestamp("Background response acceptance time", acceptedAt);
  assertSupportedVerifiedResponse(response);
  if (isProcessorV2Response(response)) {
    return buildAcceptedBackgroundAuthorizationResponseV2(
      current,
      response,
      acceptedAt,
    );
  }
  if (isRuntimeV3Response(response)) {
    return buildAcceptedBackgroundRuntimeAuthorizationResponseV3(
      current,
      response,
      acceptedAt,
    );
  }
  if (isRuntimeV4Response(response)) {
    return buildAcceptedBackgroundRuntimeAuthorizationResponseV4(
      current,
      response,
      acceptedAt,
    );
  }
  const subjectMatches = response.kind === "processor"
    ? current.snapshot.credentialSubject.kind === "processor"
      && response.subject.kind === "processor"
      && response.subject.processorKind
        === current.snapshot.credentialSubject.processorKind
      && response.subject.processorVersion
        === current.snapshot.credentialSubject.processorVersion
      && response.subject.authorizationRevision
        === current.processorAuthorizationRevision
    : current.snapshot.credentialSubject.kind === "agent"
      && response.subject.kind === "agent"
      && response.subject.agentId
        === current.snapshot.credentialSubject.agentId
      && response.subject.runtimeGeneration
        === current.snapshot.credentialSubject.runtimeGeneration
      && response.subject.authorizationRevision
        === current.snapshot.credentialSubject.authorizationRevision;
  if (
    response.requestId !== current.snapshot.requestId
    || response.recipientGeneration !== current.snapshot.recipientGeneration
    || response.workId !== current.snapshot.workId
    || response.workKind !== current.workKind
    || response.purpose !== current.purpose
    || !verifiedResponseAuthorityMatches(current, response)
    || response.kind !== current.snapshot.credentialSubject.kind
    || !subjectMatches
    || current.snapshot.descriptorDigest !== hexBytes(response.descriptorHash)
    || current.snapshot.recipient?.recipientKeyId !== response.recipientKeyId
    || current.snapshot.recipient.recipientPublicKey
      !== Buffer.from(response.recipientPublicKey).toString("base64url")
    || response.notBefore > acceptedAt
    || response.expiresAt <= acceptedAt
    || response.expiresAt - acceptedAt > PRODUCT_AUTHORIZATION_TTL_MS
    || response.responseBytes.length
      > BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_LIMITS[response.kind]
  ) {
    throw new TypeError(
      "Verified response does not match current durable authorization",
    );
  }
  const nextSnapshot = markBackgroundAuthorizationGrantReady(
    current.snapshot,
    {
      kind: response.kind,
      requestId: response.requestId,
      descriptorDigest: hexBytes(response.descriptorHash),
      recipientKeyId: response.recipientKeyId,
      recipientPublicKey: Buffer.from(response.recipientPublicKey).toString(
        "base64url",
      ),
      expiresAt: response.expiresAt,
      responseDigest: hexBytes(response.responseHash),
      credentialDigest: hexBytes(response.credentialHash),
      issuingHumanId: response.issuingHumanId,
      issuingDeviceId: response.issuingDeviceId,
      recipientGeneration: response.recipientGeneration,
      now: acceptedAt,
    },
  );
  const next = parseBackgroundAuthorizationRecord({
    ...current,
    snapshot: nextSnapshot,
    acceptedMaterial: {
      responseBytes: response.responseBytes,
      credentialId: response.credentialId,
      issuingDeviceAuthorizationRevision:
        response.issuingDeviceAuthorizationRevision,
      issuerSigningPublicKeyHash: response.issuerSigningPublicKeyHash,
      authorizationExpiresAt: response.expiresAt,
    },
  });
  if (response.kind === "agent") {
    return Object.freeze({ next, signerEvidence: null });
  }
  if (
    current.processorAuthorizationRevision === null
    || current.descriptorBytes === null
    || current.snapshot.descriptorDigest === null
    || hexBytes(response.descriptorHash) !== current.snapshot.descriptorDigest
    || response.signerAuthorization.workId !== current.snapshot.workId
    || response.signerAuthorization.namespaceId
      !== current.snapshot.namespaceId
    || response.signerAuthorization.domainId !== current.domainId
    || response.signerAuthorization.domainEpoch !== current.expectedDomainEpoch
    || response.signerAuthorization.namespaceAccessRevision
      !== current.expectedNamespaceAccessRevision
    || response.signerAuthorization.policyRevision
      !== current.expectedPolicyRevision
    || response.signerAuthorization.processorAuthorizationRevision
      !== current.processorAuthorizationRevision
    || response.signerAuthorization.issuingHumanId !== response.issuingHumanId
    || response.signerAuthorization.issuingDeviceId
      !== response.issuingDeviceId
    || response.signerAuthorization.issuingDeviceAuthorizationRevision
      !== response.issuingDeviceAuthorizationRevision
    || response.signerAuthorization.issuedAt !== response.issuedAt
    || response.signerAuthorization.expiresAt !== response.expiresAt
    || !equalBytes(
      response.signerAuthorization.issuerSigningPublicKeyHash,
      response.issuerSigningPublicKeyHash,
    )
    || !equalBytes(
      response.signerAuthorization.credentialHash,
      response.credentialHash,
    )
  ) {
    throw new TypeError(
      "Processor signer evidence does not match verified response authority",
    );
  }
  return Object.freeze({
    next,
    signerEvidence: parseProcessorSignerAuthorizationEvidence({
      authorizationId: response.signerAuthorization.authorizationId,
      requestId: response.requestId,
      recipientGeneration: response.recipientGeneration,
      workId: response.signerAuthorization.workId,
      namespaceId: response.signerAuthorization.namespaceId,
      domainId: response.signerAuthorization.domainId,
      domainEpoch: response.signerAuthorization.domainEpoch,
      namespaceAccessRevision:
        response.signerAuthorization.namespaceAccessRevision,
      policyRevision: response.signerAuthorization.policyRevision,
      processorAuthorizationRevision:
        response.signerAuthorization.processorAuthorizationRevision,
      issuingHumanId: response.signerAuthorization.issuingHumanId,
      issuingDeviceId: response.signerAuthorization.issuingDeviceId,
      issuingDeviceAuthorizationRevision:
        response.signerAuthorization.issuingDeviceAuthorizationRevision,
      issuerSigningPublicKeyHash:
        response.signerAuthorization.issuerSigningPublicKeyHash,
      signerKeyId: response.signerAuthorization.signerKeyId,
      signerPublicKey: response.signerAuthorization.signerPublicKey,
      workDescriptorHash: response.descriptorHash,
      workDescriptorBytes: current.descriptorBytes,
      authorizationHash: response.signerAuthorization.authorizationHash,
      credentialHash: response.signerAuthorization.credentialHash,
      authorizationBytes: response.signerAuthorization.authorizationBytes,
      issuedAt: response.signerAuthorization.issuedAt,
      expiresAt: response.signerAuthorization.expiresAt,
      createdAt: acceptedAt,
    }),
  });
}

function sameAcceptedMaterial(
  left: BackgroundAuthorizationAcceptedMaterial | null,
  right: BackgroundAuthorizationAcceptedMaterial | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.credentialId === right.credentialId
      && left.issuingDeviceAuthorizationRevision
        === right.issuingDeviceAuthorizationRevision
      && left.authorizationExpiresAt === right.authorizationExpiresAt
      && equalBytes(left.responseBytes, right.responseBytes)
      && equalBytes(
        left.issuerSigningPublicKeyHash,
        right.issuerSigningPublicKeyHash,
      );
}

function sameAuthoritySet(
  left: BackgroundAuthorizationRecord,
  right: BackgroundAuthorizationRecord,
): boolean {
  if (left.snapshot.formatVersion !== right.snapshot.formatVersion) {
    return false;
  }
  if (left.snapshot.formatVersion === 1) return true;
  if (
    right.snapshot.formatVersion === 1
    || left.snapshot.credentialSubject.kind
      !== right.snapshot.credentialSubject.kind
  ) return false;
  if (left.snapshot.credentialSubject.kind === "processor") return true;
  return right.snapshot.credentialSubject.kind
      === left.snapshot.credentialSubject.kind
    && left.authoritySet !== undefined
    && right.authoritySet !== undefined
    && JSON.stringify(left.authoritySet) === JSON.stringify(right.authoritySet);
}

export function sameBackgroundAuthorizationRecord(
  left: BackgroundAuthorizationRecord,
  right: BackgroundAuthorizationRecord,
): boolean {
  return JSON.stringify(left.snapshot) === JSON.stringify(right.snapshot)
    && equalBytes(left.workIdentityHash, right.workIdentityHash)
    && left.idempotencyKey === right.idempotencyKey
    && left.workKind === right.workKind
    && left.purpose === right.purpose
    && left.domainId === right.domainId
    && left.processorAuthorizationRevision
      === right.processorAuthorizationRevision
    && left.expectedDomainEpoch === right.expectedDomainEpoch
    && left.expectedNamespaceAccessRevision
      === right.expectedNamespaceAccessRevision
    && left.expectedPolicyRevision === right.expectedPolicyRevision
    && (
      left.descriptorBytes === null || right.descriptorBytes === null
        ? left.descriptorBytes === right.descriptorBytes
        : equalBytes(left.descriptorBytes, right.descriptorBytes)
    )
    && sameAcceptedMaterial(left.acceptedMaterial, right.acceptedMaterial)
    && left.finishedAt === right.finishedAt
    && sameAuthoritySet(left, right);
}

export function sameProcessorSignerAuthorizationEvidence(
  left: ProcessorSignerAuthorizationEvidence,
  right: ProcessorSignerAuthorizationEvidence,
): boolean {
  if ((left.formatVersion ?? 1) !== (right.formatVersion ?? 1)) return false;
  const byteFields = [
    "issuerSigningPublicKeyHash",
    "signerPublicKey",
    "workDescriptorHash",
    "workDescriptorBytes",
    "authorizationHash",
    "credentialHash",
    "authorizationBytes",
  ] as const;
  const scalarFields = [
    "authorizationId",
    "requestId",
    "recipientGeneration",
    "workId",
    "namespaceId",
    "domainId",
    "domainEpoch",
    "namespaceAccessRevision",
    "policyRevision",
    "processorAuthorizationRevision",
    "issuingHumanId",
    "issuingDeviceId",
    "issuingDeviceAuthorizationRevision",
    "signerKeyId",
    "issuedAt",
    "expiresAt",
    "createdAt",
  ] as const;
  return scalarFields.every((field) => left[field] === right[field])
    && byteFields.every((field) => equalBytes(left[field], right[field]));
}

function isCanonicalGenerationAdvance(
  current: BackgroundAuthorizationRequestSnapshot,
  next: BackgroundAuthorizationRequestSnapshot,
): boolean {
  if (next.lastRetryReason === null || next.nextAttemptAt === null) return false;
  try {
    const input = {
      reason: next.lastRetryReason,
      now: next.updatedAt,
      nextAttemptAt: next.nextAttemptAt,
    };
    const expected = current.state === "publication_reconciliation"
      ? restartBackgroundAuthorizationAfterUncommittedPublication(current, input)
      : advanceBackgroundAuthorizationGeneration(current, input);
    return JSON.stringify(expected) === JSON.stringify(next);
  } catch {
    return false;
  }
}

export function assertBackgroundAuthorizationCasSuccessor(
  current: BackgroundAuthorizationRecord,
  expectedRevision: number,
  next: BackgroundAuthorizationRecord,
  options: Readonly<{ allowResponseAcceptance?: boolean }> = {},
): void {
  counter(
    "Expected request revision",
    expectedRevision,
    BACKGROUND_AUTHORIZATION_MAX_GENERATION,
  );
  if (
    expectedRevision !== current.snapshot.requestRevision
    || next.snapshot.requestRevision !== expectedRevision + 1
  ) {
    throw new TypeError("CAS successor must advance the exact revision once");
  }
  const allowedStates: Readonly<
    Record<
      BackgroundAuthorizationRequestSnapshot["state"],
      readonly BackgroundAuthorizationRequestSnapshot["state"][]
    >
  > = {
    awaiting_recipient: [
      "awaiting_device",
      "cancelled",
      "terminal_failure",
    ],
    awaiting_device: [
      "awaiting_recipient",
      "grant_ready",
      "cancelled",
      "terminal_failure",
    ],
    grant_ready: [
      "awaiting_recipient",
      "claimed",
      "cancelled",
      "terminal_failure",
    ],
    claimed: [
      "awaiting_recipient",
      "running",
      "cancelled",
      "terminal_failure",
    ],
    running: [
      "awaiting_recipient",
      "publication_reconciliation",
      "completed",
      "cancelled",
      "terminal_failure",
    ],
    publication_reconciliation: [
      "awaiting_recipient",
      "publication_reconciliation",
      "completed",
      "cancelled",
      "terminal_failure",
    ],
    completed: [],
    cancelled: [],
    terminal_failure: [],
  };
  if (
    next.snapshot.updatedAt < current.snapshot.updatedAt
    || !allowedStates[current.snapshot.state].includes(next.snapshot.state)
  ) {
    throw new TypeError("CAS successor is not a legal lifecycle transition");
  }
  if (
    current.snapshot.state === "publication_reconciliation"
    && next.snapshot.state === "awaiting_recipient"
    && next.snapshot.lastRetryReason !== "claim_expired"
  ) {
    throw new TypeError(
      "An uncommitted fenced publication must restart after claim expiry",
    );
  }
  const immutable = [
    current.snapshot.requestId === next.snapshot.requestId,
    current.snapshot.workId === next.snapshot.workId,
    current.snapshot.namespaceId === next.snapshot.namespaceId,
    JSON.stringify(current.snapshot.credentialSubject)
      === JSON.stringify(next.snapshot.credentialSubject),
    equalBytes(current.workIdentityHash, next.workIdentityHash),
    current.idempotencyKey === next.idempotencyKey,
    current.workKind === next.workKind,
    current.purpose === next.purpose,
    current.domainId === next.domainId,
    current.processorAuthorizationRevision
      === next.processorAuthorizationRevision,
    current.expectedDomainEpoch === next.expectedDomainEpoch,
    current.expectedNamespaceAccessRevision
      === next.expectedNamespaceAccessRevision,
    current.expectedPolicyRevision === next.expectedPolicyRevision,
    current.snapshot.createdAt === next.snapshot.createdAt,
    sameAuthoritySet(current, next),
  ];
  if (!immutable.every(Boolean)) {
    throw new TypeError("CAS cannot change immutable work authority");
  }
  if (
    current.snapshot.descriptorDigest !== null
    && current.snapshot.recipientGeneration
      === next.snapshot.recipientGeneration
    && (
      current.snapshot.descriptorDigest !== next.snapshot.descriptorDigest
      || (
        current.descriptorBytes === null || next.descriptorBytes === null
          ? current.descriptorBytes !== next.descriptorBytes
          : !equalBytes(current.descriptorBytes, next.descriptorBytes)
      )
      || (
        (
          next.snapshot.state === "awaiting_device"
          || next.snapshot.state === "grant_ready"
          || next.snapshot.state === "claimed"
          || next.snapshot.state === "running"
        )
        && JSON.stringify(current.snapshot.recipient)
          !== JSON.stringify(next.snapshot.recipient)
      )
    )
  ) {
    throw new TypeError(
      "Descriptor and recipient are immutable within one generation",
    );
  }
  const acceptedResponseChanged =
    !sameAcceptedMaterial(current.acceptedMaterial, next.acceptedMaterial)
    || JSON.stringify(current.snapshot.acceptedResponse)
      !== JSON.stringify(next.snapshot.acceptedResponse);
  const clearsAcceptedResponseForNextGeneration =
    current.acceptedMaterial !== null
    && next.acceptedMaterial === null
    && next.snapshot.acceptedResponse === null
    && next.snapshot.state === "awaiting_recipient"
    && next.snapshot.recipientGeneration
      === current.snapshot.recipientGeneration + 1
    && isCanonicalGenerationAdvance(current.snapshot, next.snapshot)
    && next.snapshot.lastRetryReason !== null
    && next.snapshot.lastRetryReason !== "publication_pending"
    && next.snapshot.nextAttemptAt !== null
    && next.snapshot.descriptorDigest === null
    && next.descriptorBytes === null
    && next.snapshot.recipient === null;
  if (
    current.acceptedMaterial !== null
    && acceptedResponseChanged
    && !clearsAcceptedResponseForNextGeneration
  ) {
    throw new TypeError("An accepted response is immutable");
  }
  if (
    current.acceptedMaterial === null
    && next.acceptedMaterial !== null
    && options.allowResponseAcceptance !== true
  ) {
    throw new TypeError(
      "Verified response acceptance requires the atomic repository operation",
    );
  }
  // CAS is also used after restart. Do not let a reconstructed recipient
  // silently reset the execution budget or invent retry history. Reuse the
  // lifecycle's transitions instead of duplicating their accounting rules.
  if (current.snapshot.recipientGeneration !== next.snapshot.recipientGeneration) {
    if (!isCanonicalGenerationAdvance(current.snapshot, next.snapshot)) {
      throw new TypeError("CAS must preserve canonical generation retry history");
    }
  } else if (
    current.snapshot.state === "publication_reconciliation"
    && next.snapshot.state === "publication_reconciliation"
  ) {
    if (next.snapshot.nextAttemptAt === null) {
      throw new TypeError("CAS publication retry requires a retry time");
    }
    const expected = scheduleBackgroundAuthorizationPublicationRetry(
      current.snapshot,
      { now: next.snapshot.updatedAt, nextAttemptAt: next.snapshot.nextAttemptAt },
    );
    if (JSON.stringify(expected) !== JSON.stringify(next.snapshot)) {
      throw new TypeError("CAS must preserve canonical publication retry history");
    }
  } else if (
    current.snapshot.retryCount !== next.snapshot.retryCount
    || current.snapshot.lastRetryReason !== next.snapshot.lastRetryReason
  ) {
    throw new TypeError("CAS cannot change retry history without a retry transition");
  }
}

function eligible(
  record: BackgroundAuthorizationRecord,
  now: number,
): boolean {
  const { snapshot } = record;
  if (snapshot.state === "awaiting_recipient") {
    return snapshot.nextAttemptAt === null || snapshot.nextAttemptAt <= now;
  }
  if (snapshot.state === "awaiting_device") {
    return snapshot.recipient !== null && snapshot.recipient.expiresAt <= now;
  }
  if (snapshot.state === "grant_ready") return true;
  if (snapshot.state === "claimed" || snapshot.state === "running") {
    return snapshot.claimExpiresAt !== null && snapshot.claimExpiresAt <= now;
  }
  if (snapshot.state === "publication_reconciliation") {
    return snapshot.nextAttemptAt === null || snapshot.nextAttemptAt <= now;
  }
  return false;
}

function boundedLimit(label: string, value: number): number {
  counter(label, value, DEFAULT_PRUNE_LIMIT);
  if (value < 1) throw new TypeError(`${label} must be positive`);
  return value;
}

function validateAwaitingDevicePageInput(input: Readonly<{
  readonly now: number;
  readonly throughUpdatedAt: number;
  readonly after?: BackgroundAuthorizationAwaitingDeviceCursor;
  readonly limit: number;
}>): number {
  timestamp("Awaiting-device page timestamp", input.now);
  timestamp("Awaiting-device page watermark", input.throughUpdatedAt);
  const limit = boundedLimit("Awaiting-device page limit", input.limit);
  if (input.after !== undefined) {
    timestamp("Awaiting-device page cursor timestamp", input.after.updatedAt);
    portable("Awaiting-device page cursor request id", input.after.requestId);
    if (input.after.updatedAt > input.throughUpdatedAt) {
      throw new TypeError("Awaiting-device page cursor exceeds watermark");
    }
  }
  return limit;
}

function validateAwaitingTaskRuntimeRecipientPageInput(input: Readonly<{
  readonly now: number;
  readonly throughUpdatedAt: number;
  readonly after?: BackgroundAuthorizationAwaitingTaskRuntimeRecipientCursor;
  readonly limit: number;
}>): number {
  timestamp("Task Runtime recipient page timestamp", input.now);
  timestamp("Task Runtime recipient page watermark", input.throughUpdatedAt);
  const limit = boundedLimit("Task Runtime recipient page limit", input.limit);
  if (input.after !== undefined) {
    timestamp(
      "Task Runtime recipient page cursor timestamp",
      input.after.updatedAt,
    );
    portable(
      "Task Runtime recipient page cursor request id",
      input.after.requestId,
    );
    if (input.after.updatedAt > input.throughUpdatedAt) {
      throw new TypeError("Task Runtime recipient page cursor exceeds watermark");
    }
  }
  return limit;
}

function validateTaskRuntimeCancellationPageInput(input: Readonly<{
  readonly throughUpdatedAt: number;
  readonly after?: BackgroundAuthorizationTaskRuntimeCancellationCursor;
  readonly limit: number;
}>): number {
  timestamp("Task Runtime cancellation page watermark", input.throughUpdatedAt);
  const limit = boundedLimit("Task Runtime cancellation page limit", input.limit);
  if (input.after !== undefined) {
    timestamp(
      "Task Runtime cancellation page cursor timestamp",
      input.after.updatedAt,
    );
    portable(
      "Task Runtime cancellation page cursor request id",
      input.after.requestId,
    );
    if (input.after.updatedAt > input.throughUpdatedAt) {
      throw new TypeError(
        "Task Runtime cancellation page cursor exceeds watermark",
      );
    }
  }
  return limit;
}

export function isTaskExecutionWorkKind(value: BackgroundAuthorizationRecord["workKind"]): boolean {
  return value === "task.execute" || value === "task.approval_resume"
    || value === "task.await_reply_resume";
}

function isTaskPublicationWorkKind(
  value: BackgroundAuthorizationRecord["workKind"],
): boolean {
  return value === "task.cancel_result"
    || value === "task.deliver_message"
    || value === "task.deliver_result"
    || value === "task.delivery_wake";
}

function isTaskRuntimeCancellationCandidate(
  record: BackgroundAuthorizationRecord,
): record is BackgroundAuthorizationTaskRuntimeRecordV3 {
  const snapshot = record.snapshot;
  return snapshot.formatVersion === 3
    && snapshot.credentialSubject.kind === "runtime"
    && snapshot.credentialSubject.runtimeKind === "task"
    && snapshot.credentialSubject.runtimeVersion === 1
    && isTaskExecutionWorkKind(record.workKind)
    && record.purpose === record.workKind
    && record.processorAuthorizationRevision === null
    && (
      [
        "awaiting_recipient",
        "awaiting_device",
        "grant_ready",
        "claimed",
        "running",
        "publication_reconciliation",
      ].includes(snapshot.state)
      || (
        snapshot.state === "cancelled"
        && snapshot.terminalReason === "cancelled"
      )
    );
}

function isDueTaskRuntimeRecipient(
  record: BackgroundAuthorizationRecord,
  now: number,
): record is BackgroundAuthorizationTaskRuntimeRecordV3 {
  const snapshot = record.snapshot;
  return snapshot.formatVersion === 3
    && snapshot.credentialSubject.kind === "runtime"
    && snapshot.credentialSubject.runtimeKind === "task"
    && snapshot.credentialSubject.runtimeVersion === 1
    && snapshot.state === "awaiting_recipient"
    && snapshot.descriptorDigest === null
    && record.descriptorBytes === null
    && snapshot.recipient === null
    && (snapshot.nextAttemptAt === null || snapshot.nextAttemptAt <= now)
    && record.authoritySet !== undefined;
}

/** Validate the narrow creation half without rewriting any old request authority. */
export function assertUnstartedProcessorSupersession(input: Readonly<{
  expected: BackgroundAuthorizationRecord; successor: BackgroundAuthorizationRecord; now: number;
}>): void {
  const {expected, successor, now} = input;
  timestamp("Processor supersession time", now);
  const allowed = ["stenographer.extraction", "stenographer.historical", "stenographer.rebuild", "stenographer.compaction"];
  if (expected.snapshot.formatVersion !== 2 || successor.snapshot.formatVersion !== 2
    || expected.snapshot.credentialSubject.kind !== "processor" || successor.snapshot.credentialSubject.kind !== "processor"
    || !allowed.includes(expected.workKind) || expected.workKind !== successor.workKind || expected.purpose !== successor.purpose
    || expected.snapshot.namespaceId !== successor.snapshot.namespaceId || expected.snapshot.workId !== successor.snapshot.workId
    || expected.snapshot.requestId === successor.snapshot.requestId || equalBytes(expected.workIdentityHash, successor.workIdentityHash)
    || expected.idempotencyKey === successor.idempotencyKey
    || (successor.idempotencyKey !== `stenographer-processor-v2:${hexBytes(successor.workIdentityHash)}`
      && !new RegExp(`^st-processor-v2:${hexBytes(successor.workIdentityHash)}:[A-Za-z0-9_-]{43}$`, "u").test(successor.idempotencyKey))
    || successor.snapshot.state !== "awaiting_recipient" || successor.snapshot.requestRevision !== 0
    || successor.snapshot.recipientGeneration !== 0 || successor.descriptorBytes !== null || successor.acceptedMaterial !== null
    || successor.snapshot.createdAt !== expected.snapshot.createdAt
    || successor.snapshot.updatedAt !== now
    || successor.snapshot.retryCount !== expected.snapshot.retryCount
    || successor.snapshot.lastRetryReason !== expected.snapshot.lastRetryReason
    || successor.snapshot.nextAttemptAt !== (expected.snapshot.lastRetryReason === null ? null : Math.max(now, expected.snapshot.nextAttemptAt ?? now))
    || successor.snapshot.createdAt > now || expected.snapshot.updatedAt > now) {
    throw new TypeError("Processor supersession requires an exact fresh current plan for the same work");
  }
}

/** Only an exact old cancellation is retryable; it may never create another successor. */
export function isExactProcessorSupersessionCancellation(current: BackgroundAuthorizationRecord, expected: BackgroundAuthorizationRecord): boolean {
  if (current.snapshot.state !== "cancelled" || current.snapshot.terminalReason !== "superseded"
    || !["awaiting_recipient", "awaiting_device", "grant_ready", "claimed"].includes(expected.snapshot.state)) return false;
  const snapshot = cancelBackgroundAuthorizationRequest(expected.snapshot, "superseded", current.snapshot.updatedAt);
  return sameBackgroundAuthorizationRecord(current, {...expected, snapshot, finishedAt: current.snapshot.updatedAt});
}

/** Creation identity survives a successor progressing while its caller retries. */
export function sameProcessorSupersessionPlan(current: BackgroundAuthorizationRecord, initial: BackgroundAuthorizationRecord): boolean {
  return current.snapshot.formatVersion === initial.snapshot.formatVersion
    && current.snapshot.workId === initial.snapshot.workId && current.snapshot.namespaceId === initial.snapshot.namespaceId
    && current.snapshot.createdAt === initial.snapshot.createdAt
    && JSON.stringify(current.snapshot.credentialSubject) === JSON.stringify(initial.snapshot.credentialSubject)
    && current.idempotencyKey === initial.idempotencyKey && equalBytes(current.workIdentityHash, initial.workIdentityHash)
    && current.workKind === initial.workKind && current.purpose === initial.purpose && current.domainId === initial.domainId
    && current.expectedNamespaceAccessRevision === initial.expectedNamespaceAccessRevision
    && current.expectedPolicyRevision === initial.expectedPolicyRevision
    && current.expectedDomainEpoch === initial.expectedDomainEpoch
    && current.processorAuthorizationRevision === initial.processorAuthorizationRevision;
}

function exactTaskRuntimeAuthorityAnchor(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): boolean {
  const namespaces = record.authoritySet.namespaceRequirements.filter(
    (requirement) =>
      requirement.namespaceId === record.snapshot.namespaceId,
  );
  const namespace = namespaces[0];
  const domains = namespace === undefined
    ? []
    : record.authoritySet.domainRequirements.filter(
      (requirement) => requirement.domainId === namespace.domainId,
    );
  const domain = domains[0];
  return namespaces.length === 1
    && namespace !== undefined
    && namespace.domainId === record.domainId
    && namespace.operations.length === 2
    && namespace.operations[0] === "decrypt"
    && namespace.operations[1] === "encrypt"
    && namespace.expectedAccessRevision
      === record.expectedNamespaceAccessRevision
    && namespace.expectedPolicyRevision === record.expectedPolicyRevision
    && record.authoritySet.namespaceRequirements.every(
      (requirement) =>
        requirement.expectedPolicyRevision === record.expectedPolicyRevision,
    )
    && domains.length === 1
    && domain !== undefined
    && domain.expectedEpoch === record.expectedDomainEpoch;
}

const TASK_RUNTIME_EXECUTION_SETTLEMENT_WORK_KINDS = new Set<
  BackgroundAuthorizationWorkKind
>([
  "task.execute",
  "task.dispatch",
  "task.approval_resume",
  "task.await_reply_resume",
]);

const TASK_RUNTIME_EXECUTION_SETTLEMENT_ACTIVE_STATES = new Set([
  "awaiting_recipient",
  "awaiting_device",
  "grant_ready",
  "claimed",
  "running",
  "publication_reconciliation",
]);

function taskRuntimeExecutionSettlementAuthorityAnchor(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): boolean {
  const namespaces = record.authoritySet.namespaceRequirements.filter(
    (requirement) => requirement.namespaceId === record.snapshot.namespaceId,
  );
  const namespace = namespaces[0];
  const domains = namespace === undefined
    ? []
    : record.authoritySet.domainRequirements.filter(
      (requirement) => requirement.domainId === namespace.domainId,
    );
  const domain = domains[0];
  return namespaces.length === 1
    && namespace !== undefined
    && namespace.domainId === record.domainId
    && namespace.operations.length === 2
    && namespace.operations[0] === "decrypt"
    && namespace.operations[1] === "encrypt"
    && namespace.expectedAccessRevision
      === record.expectedNamespaceAccessRevision
    && namespace.expectedPolicyRevision === record.expectedPolicyRevision
    && domains.length === 1
    && domain !== undefined
    && domain.expectedEpoch === record.expectedDomainEpoch;
}

export type BackgroundAuthorizationTaskRuntimeExecutionSettlementPlan =
  Readonly<{
    readonly result:
      BackgroundAuthorizationTaskRuntimeExecutionSettlementResult;
    readonly updates:
      readonly BackgroundAuthorizationTaskRuntimeRecordV3[];
  }>;

function taskRuntimeExecutionSettlementConflict():
  BackgroundAuthorizationTaskRuntimeExecutionSettlementPlan {
  const recipients: readonly [] = Object.freeze([]);
  const updates: readonly BackgroundAuthorizationTaskRuntimeRecordV3[] =
    Object.freeze([]);
  return Object.freeze({
    result: Object.freeze({
      status: "conflict",
      recipients,
    }),
    updates,
  });
}

/** Shared prevalidation keeps in-memory and Postgres settlement identical. */
export function planTaskRuntimeExecutionAuthoritySettlement(input: Readonly<{
  readonly records: readonly BackgroundAuthorizationRecord[];
  readonly workId: string;
  readonly namespaceId: string;
  readonly now: number;
}>): BackgroundAuthorizationTaskRuntimeExecutionSettlementPlan {
  portable("Task Runtime settlement work id", input.workId);
  portable("Task Runtime settlement Namespace id", input.namespaceId);
  timestamp("Task Runtime settlement time", input.now);
  const records = input.records.map(parseBackgroundAuthorizationRecord)
    .sort((left, right) =>
      left.snapshot.requestId.localeCompare(right.snapshot.requestId)
    );
  const recipients: BackgroundAuthorizationTaskRuntimeSettledRecipient[] = [];
  const updates: BackgroundAuthorizationTaskRuntimeRecordV3[] = [];
  let alreadyTerminal = 0;
  for (const record of records) {
    const snapshot = record.snapshot;
    if (
      snapshot.formatVersion !== 3
      || snapshot.credentialSubject.kind !== "runtime"
      || snapshot.credentialSubject.runtimeKind !== "task"
      || snapshot.credentialSubject.runtimeVersion !== 1
      || snapshot.workId !== input.workId
      || snapshot.namespaceId !== input.namespaceId
      || !TASK_RUNTIME_EXECUTION_SETTLEMENT_WORK_KINDS.has(record.workKind)
      || record.purpose !== record.workKind
      || record.processorAuthorizationRevision !== null
      || record.authoritySet === undefined
      || !taskRuntimeExecutionSettlementAuthorityAnchor(
        record as BackgroundAuthorizationTaskRuntimeRecordV3,
      )
    ) {
      return taskRuntimeExecutionSettlementConflict();
    }
    recipients.push(Object.freeze({
      requestId: snapshot.requestId,
      recipientGeneration: snapshot.recipientGeneration,
    }));
    if (TERMINAL_STATES.has(snapshot.state)) {
      alreadyTerminal += 1;
      continue;
    }
    if (!TASK_RUNTIME_EXECUTION_SETTLEMENT_ACTIVE_STATES.has(snapshot.state)) {
      return taskRuntimeExecutionSettlementConflict();
    }
    try {
      updates.push(parseBackgroundAuthorizationRecord({
        ...record,
        snapshot: cancelBackgroundAuthorizationRequest(
          snapshot,
          "cancelled",
          input.now,
        ),
        finishedAt: input.now,
      }) as BackgroundAuthorizationTaskRuntimeRecordV3);
    } catch {
      return taskRuntimeExecutionSettlementConflict();
    }
  }
  return Object.freeze({
    result: Object.freeze({
      status: "settled",
      transitioned: updates.length,
      alreadyTerminal,
      recipients: Object.freeze(recipients),
    }),
    updates: Object.freeze(updates),
  });
}

/**
 * Build the sole legal successor for a changed, unclaimed Task Runtime
 * inventory. Stable work identity stays bound by request/work/idempotency;
 * only the canonical current authority plan is replaced.
 */
export function buildUnclaimedTaskRuntimeAuthorityReplacement(input: Readonly<{
  expected: BackgroundAuthorizationTaskRuntimeRecordV3;
  replacement: BackgroundAuthorizationTaskRuntimeRecordV3;
  now: number;
}>): BackgroundAuthorizationTaskRuntimeRecordV3 {
  return buildUnclaimedTaskAuthorityReplacement(input, "execution");
}

/** Requires a live canonical Human inspection and an exact historical stable preimage. */
export function buildUnclaimedTaskMappedHeadAuthorityReplacement(input: TaskRuntimeMappedHeadReplacementInput): BackgroundAuthorizationTaskRuntimeRecordV3 {
  assertTaskRuntimeMappedHeadReplacement(input);
  return buildUnclaimedTaskAuthorityReplacement(input, "mapped_head");
}

/** Monotonic policy refresh for the single encrypt-only cancellation Namespace. */
export function buildUnclaimedTaskCancellationAuthorityReplacement(input: Readonly<{
  expected: BackgroundAuthorizationTaskRuntimeRecordV3;
  replacement: BackgroundAuthorizationTaskRuntimeRecordV3;
  now: number;
}>): BackgroundAuthorizationTaskRuntimeRecordV3 {
  return buildUnclaimedTaskAuthorityReplacement(input, "cancellation");
}

/** Monotonic policy refresh for one unclaimed terminal Message publication. */
export function buildUnclaimedTaskTerminalMessageAuthorityReplacement(input: Readonly<{
  expected: BackgroundAuthorizationTaskRuntimeRecordV3;
  replacement: BackgroundAuthorizationTaskRuntimeRecordV3;
  now: number;
}>): BackgroundAuthorizationTaskRuntimeRecordV3 {
  return buildUnclaimedTaskAuthorityReplacement(input, "terminal_message");
}

/** Fresh result-read authority only; historical staged bytes and running work stay immutable. */
export function buildUnclaimedTaskOutputReadAuthorityReplacement(input: Readonly<{
  expected: BackgroundAuthorizationTaskRuntimeRecordV3;
  replacement: BackgroundAuthorizationTaskRuntimeRecordV3;
  now: number;
}>): BackgroundAuthorizationTaskRuntimeRecordV3 {
  return buildUnclaimedTaskAuthorityReplacement(input, "output_read");
}

function exactTaskOutputReadAuthorityAnchor(record: BackgroundAuthorizationTaskRuntimeRecordV3): boolean {
  const raw = record.workKind === "task.deliver_result";
  const wake = record.workKind === "task.delivery_wake";
  const namespaces = record.authoritySet.namespaceRequirements;
  const primary = namespaces.find(n => n.namespaceId === record.snapshot.namespaceId);
  const domain = record.authoritySet.domainRequirements.find(d => d.domainId === record.domainId);
  const foreground = namespaces.filter(n => n.operations.includes("encrypt"));
  return (raw || wake) && record.purpose === record.workKind
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.snapshot.workId)
    && record.snapshot.requestId === (raw
      ? `task-run-delivery-result-authorization:${record.snapshot.workId}`
      : `task-wake-authorization:${record.snapshot.workId}`)
    && /^task-output-read:[0-9a-f]{64}$/u.test(record.idempotencyKey)
    && primary !== undefined && domain !== undefined
    && primary.domainId === record.domainId
    && primary.operations.includes("decrypt")
    && primary.expectedAccessRevision === record.expectedNamespaceAccessRevision
    && primary.expectedPolicyRevision === record.expectedPolicyRevision
    && domain.expectedEpoch === record.expectedDomainEpoch
    && record.expectedPolicyRevision >= 1
    && record.authoritySet.domainRequirements.every(d => d.expectedEpoch >= 1)
    && (raw ? foreground.length === 1 : foreground.length > 0)
    && namespaces.every(n => n.expectedPolicyRevision === record.expectedPolicyRevision
      && (n.namespaceId === record.snapshot.namespaceId
        ? n.operations.join(",") === "decrypt" || n.operations.join(",") === "decrypt,encrypt"
        : n.operations.join(",") === (raw ? "encrypt" : "decrypt,encrypt")));
}

function exactParkedWakeReplacementAuthority(input: Readonly<{
  current: BackgroundAuthorizationTaskRuntimeRecordV3;
  replacement: BackgroundAuthorizationTaskRuntimeRecordV3;
  proof: VerifiedProtectedTaskWakeContinuation;
}>): boolean {
  const { current, replacement, proof } = input;
  const receipt = proof.receipt;
  const prior = proof.priorReceipt;
  const retained = receipt.retainedSourceNamespaceIds;
  const expectedCurrentIds = [...new Set([current.snapshot.namespaceId, ...retained])].sort();
  const initialAuthority = exactTaskOutputReadAuthorityAnchor(current)
    && current.authoritySet.namespaceRequirements.map(n => n.namespaceId).sort().join(",") === expectedCurrentIds.join(",")
    && retained.every(id => current.authoritySet.namespaceRequirements.find(n => n.namespaceId === id)
      ?.operations.join(",") === "decrypt,encrypt");
  return (prior === null ? initialAuthority : exactParkedWakeCurrentAuthority(current, prior))
    && current.workKind === "task.delivery_wake"
    && current.snapshot.requestId === receipt.wakeAuthorizationRequestId
    && current.snapshot.workId === receipt.wakeJobId
    && current.snapshot.recipientGeneration === receipt.priorRecipientGeneration
    && current.expectedPolicyRevision >= receipt.initialPolicyRevision
    && replacement.expectedPolicyRevision >= current.expectedPolicyRevision
    && exactParkedWakeCurrentAuthority(replacement, receipt, false);
}

function exactParkedWakeCurrentAuthority(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
  receipt: ProtectedTaskWakeContinuationReceipt,
  requireGeneration = true,
): boolean {
  const retained = [...receipt.retainedSourceNamespaceIds].sort();
  const requirements = record.authoritySet.namespaceRequirements;
  const expectedIds = [...new Set([
    record.snapshot.namespaceId,
    ...retained,
    receipt.destinationNamespaceId,
  ])].sort();
  const actualIds = requirements.map(requirement => requirement.namespaceId)
    .sort();
  const primary = requirements.find(requirement =>
    requirement.namespaceId === record.snapshot.namespaceId);
  const destination = requirements.find(requirement =>
    requirement.namespaceId === receipt.destinationNamespaceId);
  const primaryDomain = record.authoritySet.domainRequirements.find(domain =>
    domain.domainId === record.domainId);
  return record.workKind === "task.delivery_wake"
    && record.purpose === "task.delivery_wake"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.snapshot.workId)
    && /^task-output-read:[0-9a-f]{64}$/u.test(record.idempotencyKey)
    && record.snapshot.requestId === receipt.wakeAuthorizationRequestId
    && record.snapshot.workId === receipt.wakeJobId
    && (!requireGeneration || record.snapshot.recipientGeneration >= receipt.segment)
    && record.expectedPolicyRevision >= receipt.initialPolicyRevision
    && actualIds.join(",") === expectedIds.join(",")
    && primary !== undefined
    && primary.operations.includes("decrypt")
    && primary.domainId === record.domainId
    && primary.expectedAccessRevision
      === record.expectedNamespaceAccessRevision
    && primary.expectedPolicyRevision === record.expectedPolicyRevision
    && primaryDomain?.expectedEpoch === record.expectedDomainEpoch
    && requirements.every(requirement =>
      requirement.expectedPolicyRevision === record.expectedPolicyRevision
      && requirement.operations.join(",") === (retained.includes(requirement.namespaceId)
        ? "decrypt,encrypt" : requirement.namespaceId === record.snapshot.namespaceId ? "decrypt" : "encrypt")
      && record.authoritySet.domainRequirements.some(domain =>
        domain.domainId === requirement.domainId))
    && record.authoritySet.domainRequirements.every(domain => domain.expectedEpoch >= 1
      && requirements.some(requirement => requirement.domainId === domain.domainId))
    && receipt.destinationNamespaceId !== record.snapshot.namespaceId
    && !retained.includes(receipt.destinationNamespaceId)
    && destination?.operations.join(",") === "encrypt"
    && retained.every(namespaceId => requirements.find(requirement =>
      requirement.namespaceId === namespaceId)
      ?.operations.join(",") === "decrypt,encrypt");
}

export function rotateExpiredParkedTaskWakeRecipient(input: Readonly<{
  expected: BackgroundAuthorizationTaskRuntimeRecordV3;
  replacement?: BackgroundAuthorizationTaskRuntimeRecordV3;
  proof: VerifiedProtectedTaskWakeContinuation;
  now: number;
}>): Exclude<
  BackgroundAuthorizationTaskWakeRecipientRenewalResult,
  Readonly<{ status: "stale"; current: BackgroundAuthorizationRecord | null }>
> {
  assertVerifiedProtectedTaskWakeContinuation(input.proof);
  timestamp("Parked Task wake recipient renewal time", input.now);
  const parsed = parseBackgroundAuthorizationRecord(input.expected);
  if (parsed.snapshot.formatVersion !== 3
    || parsed.snapshot.credentialSubject.kind !== "runtime"
    || parsed.snapshot.credentialSubject.runtimeKind !== "task"
    || parsed.snapshot.credentialSubject.runtimeVersion !== 1
    || parsed.authoritySet === undefined) {
    throw new TypeError("Parked Task wake renewal requires V3 Task custody");
  }
  const expected = parsed as BackgroundAuthorizationTaskRuntimeRecordV3;
  if (!exactParkedWakeCurrentAuthority(expected, input.proof.receipt)
    || expected.finishedAt !== null
    || expected.snapshot.claimId !== null
    || expected.snapshot.claimExpiresAt !== null) {
    throw new TypeError("Parked Task wake renewal changed authority");
  }
  if (input.replacement !== undefined) {
    const next = buildUnclaimedTaskAuthorityReplacement({ expected, replacement: input.replacement,
      now: input.now }, "parked_wake", input.proof);
    if (!equalBytes(expected.workIdentityHash, next.workIdentityHash) || !sameAuthoritySet(expected, next)) {
      return Object.freeze({ status: "rotated" as const, record: next,
        releasedRecipientGeneration: expected.snapshot.recipientGeneration });
    }
  }
  if (expected.snapshot.state !== "awaiting_device"
    && expected.snapshot.state !== "grant_ready") {
    return Object.freeze({ status: "inactive" as const, record: expected });
  }
  const recipient = expected.snapshot.recipient;
  if (recipient === null) {
    return Object.freeze({ status: "inactive" as const, record: expected });
  }
  if (input.now < recipient.expiresAt) {
    return Object.freeze({ status: "not_due" as const, record: expected });
  }
  const next = parseBackgroundAuthorizationRecord({
    ...expected,
    snapshot: advanceBackgroundAuthorizationGeneration(expected.snapshot, {
      reason: "attempt_expired",
      now: input.now,
      nextAttemptAt: input.now,
    }),
    descriptorBytes: null,
    acceptedMaterial: null,
  }) as BackgroundAuthorizationTaskRuntimeRecordV3;
  if (!exactParkedWakeCurrentAuthority(next, input.proof.receipt)
    || next.snapshot.recipientGeneration
      !== expected.snapshot.recipientGeneration + 1
    || next.snapshot.state !== "awaiting_recipient"
    || next.snapshot.recipient !== null
    || next.snapshot.acceptedResponse !== null
    || next.snapshot.lastRetryReason !== "attempt_expired") {
    throw new TypeError("Parked Task wake renewal successor is invalid");
  }
  return Object.freeze({
    status: "rotated" as const,
    record: next,
    releasedRecipientGeneration: expected.snapshot.recipientGeneration,
  });
}

export function buildParkedTaskWakeAuthorityReplacement(input: Readonly<{
  expected: BackgroundAuthorizationTaskRuntimeRecordV3;
  replacement: BackgroundAuthorizationTaskRuntimeRecordV3;
  proof: VerifiedProtectedTaskWakeContinuation;
  now: number;
}>): BackgroundAuthorizationTaskRuntimeRecordV3 {
  assertVerifiedProtectedTaskWakeContinuation(input.proof);
  timestamp("Parked Task wake authority replacement time", input.now);
  const expected = parseBackgroundAuthorizationRecord(input.expected);
  const replacement = parseBackgroundAuthorizationRecord(input.replacement);
  if (expected.snapshot.formatVersion !== 3
    || expected.snapshot.credentialSubject.kind !== "runtime"
    || expected.snapshot.credentialSubject.runtimeKind !== "task"
    || expected.snapshot.credentialSubject.runtimeVersion !== 1
    || expected.authoritySet === undefined
    || replacement.snapshot.formatVersion !== 3
    || replacement.snapshot.credentialSubject.kind !== "runtime"
    || replacement.snapshot.credentialSubject.runtimeKind !== "task"
    || replacement.snapshot.credentialSubject.runtimeVersion !== 1
    || replacement.authoritySet === undefined) {
    throw new TypeError("Parked Task wake replacement requires V3 Task records");
  }
  const current = expected as BackgroundAuthorizationTaskRuntimeRecordV3;
  const nextPlan = replacement as BackgroundAuthorizationTaskRuntimeRecordV3;
  const receipt = input.proof.receipt;
  if (current.snapshot.state !== "running"
    || current.snapshot.claimId === null
    || current.snapshot.recipient === null
    || current.snapshot.acceptedResponse === null
    || current.acceptedMaterial === null
    || current.finishedAt !== null
    || nextPlan.snapshot.state !== "awaiting_recipient"
    || nextPlan.snapshot.recipientGeneration !== 0
    || nextPlan.snapshot.recipient !== null
    || nextPlan.snapshot.acceptedResponse !== null
    || nextPlan.snapshot.claimId !== null
    || nextPlan.snapshot.claimExpiresAt !== null
    || nextPlan.snapshot.requestRevision !== 0
    || nextPlan.snapshot.retryCount !== 0
    || nextPlan.snapshot.lastRetryReason !== null
    || nextPlan.snapshot.nextAttemptAt !== null
    || nextPlan.descriptorBytes !== null
    || nextPlan.acceptedMaterial !== null
    || nextPlan.finishedAt !== null
    || current.snapshot.requestId !== nextPlan.snapshot.requestId
    || current.snapshot.workId !== nextPlan.snapshot.workId
    || current.snapshot.namespaceId !== nextPlan.snapshot.namespaceId
    || JSON.stringify(current.snapshot.credentialSubject)
      !== JSON.stringify(nextPlan.snapshot.credentialSubject)
    || current.idempotencyKey !== nextPlan.idempotencyKey
    || current.purpose !== "task.delivery_wake"
    || nextPlan.purpose !== "task.delivery_wake"
    || current.processorAuthorizationRevision !== null
    || nextPlan.processorAuthorizationRevision !== null
    || receipt.segment !== receipt.priorRecipientGeneration + 1
    || !exactParkedWakeReplacementAuthority({
      current,
      replacement: nextPlan,
      proof: input.proof,
    })) {
    throw new TypeError("Parked Task wake replacement changed authority");
  }
  const snapshot = deferUnstartedTaskRuntimeRequestSnapshot(
    current.snapshot,
    input.now,
  );
  if (snapshot.recipientGeneration !== receipt.segment) {
    throw new TypeError("Parked Task wake generation changed");
  }
  return parseBackgroundAuthorizationRecord({
    ...nextPlan,
    snapshot,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
  }) as BackgroundAuthorizationTaskRuntimeRecordV3;
}

function exactTaskCancellationAuthorityAnchor(record: BackgroundAuthorizationTaskRuntimeRecordV3): boolean {
  const namespace = record.authoritySet.namespaceRequirements[0];
  const domain = record.authoritySet.domainRequirements[0];
  return record.workKind === "task.cancel_result" && record.purpose === "task.cancel_result"
    && record.snapshot.requestId === `task-run-cancellation-result-authorization:${record.snapshot.workId}`
    && /^task-cancellation:[0-9a-f]{64}$/u.test(record.idempotencyKey)
    && record.authoritySet.namespaceRequirements.length === 1
    && record.authoritySet.domainRequirements.length === 1
    && namespace !== undefined && domain !== undefined
    && namespace.ordinal === 0 && domain.ordinal === 0
    && namespace.namespaceId === record.snapshot.namespaceId
    && namespace.domainId === record.domainId && domain.domainId === record.domainId
    && namespace.operations.length === 1 && namespace.operations[0] === "encrypt"
    && namespace.expectedAccessRevision === record.expectedNamespaceAccessRevision
    && namespace.expectedPolicyRevision === record.expectedPolicyRevision
    && domain.expectedEpoch === record.expectedDomainEpoch;
}

function exactTaskTerminalMessageAuthorityAnchor(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): boolean {
  const namespace = record.authoritySet.namespaceRequirements[0];
  const domain = record.authoritySet.domainRequirements[0];
  return record.workKind === "task.deliver_message"
    && record.purpose === "task.deliver_message"
    && record.snapshot.requestId
      === `task-run-delivery-message-authorization:${record.snapshot.workId}`
    && /^task-delivery-message:[0-9a-f]{64}$/u.test(record.idempotencyKey)
    && record.authoritySet.namespaceRequirements.length === 1
    && record.authoritySet.domainRequirements.length === 1
    && namespace !== undefined && domain !== undefined
    && namespace.ordinal === 0 && domain.ordinal === 0
    && namespace.namespaceId === record.snapshot.namespaceId
    && namespace.domainId === record.domainId
    && domain.domainId === record.domainId
    && namespace.operations.length === 1
    && namespace.operations[0] === "encrypt"
    && namespace.expectedAccessRevision
      === record.expectedNamespaceAccessRevision
    && namespace.expectedPolicyRevision === record.expectedPolicyRevision
    && domain.expectedEpoch === record.expectedDomainEpoch;
}

type TaskAuthorityReplacementKind =
  | "execution"
  | "mapped_head"
  | "cancellation"
  | "terminal_message"
  | "output_read"
  | "parked_wake";

function buildUnclaimedTaskAuthorityReplacement(input: Readonly<{
  expected: BackgroundAuthorizationTaskRuntimeRecordV3;
  replacement: BackgroundAuthorizationTaskRuntimeRecordV3;
  now: number;
}>, kind: TaskAuthorityReplacementKind, wakeProof?: VerifiedProtectedTaskWakeContinuation): BackgroundAuthorizationTaskRuntimeRecordV3 {
  timestamp("Task Runtime authority replacement time", input.now);
  const expected = parseBackgroundAuthorizationRecord(input.expected);
  const replacement = parseBackgroundAuthorizationRecord(input.replacement);
  if (
    expected.snapshot.formatVersion !== 3
    || expected.snapshot.credentialSubject.kind !== "runtime"
    || expected.snapshot.credentialSubject.runtimeKind !== "task"
    || expected.snapshot.credentialSubject.runtimeVersion !== 1
    || expected.authoritySet === undefined
    || replacement.snapshot.formatVersion !== 3
    || replacement.snapshot.credentialSubject.kind !== "runtime"
    || replacement.snapshot.credentialSubject.runtimeKind !== "task"
    || replacement.snapshot.credentialSubject.runtimeVersion !== 1
    || replacement.authoritySet === undefined
  ) throw new TypeError("Task Runtime authority replacement requires V3 Task records");
  const current = expected as BackgroundAuthorizationTaskRuntimeRecordV3;
  const nextPlan = replacement as BackgroundAuthorizationTaskRuntimeRecordV3;
  if (
    !["awaiting_recipient", "awaiting_device", "grant_ready"]
      .includes(current.snapshot.state)
    || current.finishedAt !== null
    || nextPlan.snapshot.state !== "awaiting_recipient"
    || nextPlan.snapshot.recipientGeneration !== 0
    || nextPlan.snapshot.recipient !== null
    || nextPlan.snapshot.acceptedResponse !== null
    || nextPlan.snapshot.claimId !== null
    || nextPlan.snapshot.claimExpiresAt !== null
    || nextPlan.snapshot.requestRevision !== 0
    || nextPlan.snapshot.retryCount !== 0
    || nextPlan.snapshot.lastRetryReason !== null
    || nextPlan.snapshot.nextAttemptAt !== null
    || nextPlan.descriptorBytes !== null
    || nextPlan.acceptedMaterial !== null
    || nextPlan.finishedAt !== null
    || current.snapshot.requestId !== nextPlan.snapshot.requestId
    || current.snapshot.workId !== nextPlan.snapshot.workId
    || current.snapshot.namespaceId !== nextPlan.snapshot.namespaceId
    || JSON.stringify(current.snapshot.credentialSubject)
      !== JSON.stringify(nextPlan.snapshot.credentialSubject)
    || (kind !== "mapped_head" && current.idempotencyKey !== nextPlan.idempotencyKey)
    || (kind === "cancellation"
      ? current.expectedPolicyRevision > nextPlan.expectedPolicyRevision
        || !exactTaskCancellationAuthorityAnchor(current)
        || !exactTaskCancellationAuthorityAnchor(nextPlan)
      : kind === "terminal_message"
        ? current.expectedPolicyRevision > nextPlan.expectedPolicyRevision
          || !exactTaskTerminalMessageAuthorityAnchor(current)
          || !exactTaskTerminalMessageAuthorityAnchor(nextPlan)
        : kind === "parked_wake"
          ? wakeProof === undefined || current.expectedPolicyRevision > nextPlan.expectedPolicyRevision
            || !exactParkedWakeCurrentAuthority(current, wakeProof.receipt)
            || !exactParkedWakeCurrentAuthority(nextPlan, wakeProof.receipt, false)
          : kind === "output_read"
          ? current.expectedPolicyRevision > nextPlan.expectedPolicyRevision
            || !exactTaskOutputReadAuthorityAnchor(current)
            || !exactTaskOutputReadAuthorityAnchor(nextPlan)
          : !isTaskRuntimeStableIdempotencyKey(
          current.idempotencyKey,
          current.snapshot.workId,
        )
          || !isTaskExecutionWorkKind(current.workKind)
          || !exactTaskRuntimeAuthorityAnchor(current)
          || !exactTaskRuntimeAuthorityAnchor(nextPlan))
    || nextPlan.workKind !== current.workKind
    || current.purpose !== current.workKind
    || nextPlan.purpose !== current.purpose
    || current.processorAuthorizationRevision !== null
    || nextPlan.processorAuthorizationRevision !== null
  ) {
    throw new TypeError(
      "Task Runtime authority replacement changed stable work identity",
    );
  }
  const snapshot = replaceBackgroundAuthorizationPreclaimAuthority(
    current.snapshot,
    input.now,
  );
  return parseBackgroundAuthorizationRecord({
    ...nextPlan,
    snapshot,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
  }) as BackgroundAuthorizationTaskRuntimeRecordV3;
}

/** Build the sole retry-preserving successor after proven pre-execution loss. */
export function buildDeferredUnstartedTaskRuntimeRequest(input: Readonly<{
  expected: BackgroundAuthorizationTaskRuntimeRecordV3;
  now: number;
}>): BackgroundAuthorizationTaskRuntimeRecordV3 {
  timestamp("Unstarted Task Runtime deferral time", input.now);
  const parsed = parseBackgroundAuthorizationRecord(input.expected);
  if (
    parsed.snapshot.formatVersion !== 3
    || parsed.snapshot.credentialSubject.kind !== "runtime"
    || parsed.snapshot.credentialSubject.runtimeKind !== "task"
    || parsed.snapshot.credentialSubject.runtimeVersion !== 1
    || parsed.authoritySet === undefined
  ) {
    throw new TypeError(
      "Unstarted Task Runtime deferral requires a V3 Task record",
    );
  }
  const expected = parsed as BackgroundAuthorizationTaskRuntimeRecordV3;
  if (
    !isTaskExecutionWorkKind(expected.workKind)
    || expected.purpose !== expected.workKind
    || expected.processorAuthorizationRevision !== null
    || expected.finishedAt !== null
    || !isTaskRuntimeStableIdempotencyKey(
      expected.idempotencyKey,
      expected.snapshot.workId,
    )
    || !exactTaskRuntimeAuthorityAnchor(expected)
  ) {
    throw new TypeError(
      "Unstarted Task Runtime deferral changed stable work identity",
    );
  }
  const snapshot = deferUnstartedTaskRuntimeRequestSnapshot(
    expected.snapshot,
    input.now,
  );
  return parseBackgroundAuthorizationRecord({
    ...expected,
    snapshot,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
  }) as BackgroundAuthorizationTaskRuntimeRecordV3;
}

export class InMemoryBackgroundAuthorizationRepository
  implements BackgroundAuthorizationTaskRuntimeReplacementRepository,
    BackgroundAuthorizationTaskRuntimeDeferralRepository,
    BackgroundAuthorizationTaskRuntimeCancellationDiscoveryRepository,
    BackgroundAuthorizationTaskRuntimeCancellationSettlementRepository,
    BackgroundAuthorizationTaskCancellationReplacementRepository,
    BackgroundAuthorizationTaskTerminalMessageReplacementRepository,
    BackgroundAuthorizationTaskOutputReadReplacementRepository,
    BackgroundAuthorizationTaskWakeParkRepository {
  readonly #records = new Map<string, BackgroundAuthorizationRecord>();
  readonly #evidence = new Map<string, ProcessorSignerAuthorizationEvidence>();

  #appendEvidence(
    evidence: ProcessorSignerAuthorizationEvidence,
  ): ProcessorSignerEvidenceAppendResult {
    const collisions = [...this.#evidence.values()].filter((existing) =>
      existing.authorizationId === evidence.authorizationId
      || (
        existing.requestId === evidence.requestId
        && existing.recipientGeneration === evidence.recipientGeneration
      )
      || existing.signerKeyId === evidence.signerKeyId
      || equalBytes(existing.authorizationHash, evidence.authorizationHash)
      || equalBytes(existing.credentialHash, evidence.credentialHash)
    );
    if (collisions.length > 0) {
      const existing = collisions[0]!;
      if (
        collisions.every((candidate) =>
          candidate.authorizationId === existing.authorizationId
        )
        && sameProcessorSignerAuthorizationEvidence(existing, evidence)
      ) {
        return {
          status: "existing",
          evidence: parseProcessorSignerAuthorizationEvidence(existing),
        };
      }
      throw new BackgroundAuthorizationRepositoryConflictError(
        "signer_evidence_conflict",
      );
    }
    this.#evidence.set(evidence.authorizationId, evidence);
    return {
      status: "appended",
      evidence: parseProcessorSignerAuthorizationEvidence(evidence),
    };
  }

  async create(
    input: BackgroundAuthorizationRecord,
  ): Promise<BackgroundAuthorizationCreateResult> {
    await Promise.resolve();
    const record = parseBackgroundAuthorizationRecord(input);
    const collisions = [...this.#records.values()].filter((existing) =>
      existing.snapshot.requestId === record.snapshot.requestId
      || existing.idempotencyKey === record.idempotencyKey
      || equalBytes(existing.workIdentityHash, record.workIdentityHash)
    );
    if (collisions.length > 0) {
      const existing = collisions[0]!;
      if (
        collisions.every((candidate) =>
          candidate.snapshot.requestId === existing.snapshot.requestId
        )
        && sameBackgroundAuthorizationRecord(existing, record)
      ) {
        return { status: "existing", record: parseBackgroundAuthorizationRecord(existing) };
      }
      throw new BackgroundAuthorizationRepositoryConflictError(
        "create_conflict",
      );
    }
    this.#records.set(record.snapshot.requestId, record);
    return { status: "created", record: parseBackgroundAuthorizationRecord(record) };
  }

  async supersedeUnstartedProcessorRequest(input: Readonly<{
    expected: BackgroundAuthorizationRecord; successor: BackgroundAuthorizationRecord; now: number;
  }>): Promise<BackgroundAuthorizationSupersedeResult> {
    const expected = parseBackgroundAuthorizationRecord(input.expected);
    const successor = parseBackgroundAuthorizationRecord(input.successor);
    assertUnstartedProcessorSupersession({...input, expected, successor});
    await Promise.resolve();
    // No asynchronous boundary between the in-memory observation and both writes.
    const current = this.#records.get(expected.snapshot.requestId) ?? null;
    const collisions = [...this.#records.values()].filter(value => value.snapshot.requestId === successor.snapshot.requestId
      || value.idempotencyKey === successor.idempotencyKey || equalBytes(value.workIdentityHash, successor.workIdentityHash));
    if (current !== null && isExactProcessorSupersessionCancellation(current, expected)) {
      const existing = collisions[0];
      return collisions.length === 1 && existing !== undefined && sameProcessorSupersessionPlan(existing, successor)
        ? {status: "existing", record: parseBackgroundAuthorizationRecord(existing)} : {status: "stale", current: parseBackgroundAuthorizationRecord(current)};
    }
    if (current === null || !sameBackgroundAuthorizationRecord(current, expected)
      || !["awaiting_recipient", "awaiting_device", "grant_ready", "claimed"].includes(current.snapshot.state)) {
      return {status: "stale", current: current === null ? null : parseBackgroundAuthorizationRecord(current)};
    }
    if (collisions.length !== 0) throw new BackgroundAuthorizationRepositoryConflictError("create_conflict");
    const snapshot = cancelBackgroundAuthorizationRequest(current.snapshot, "superseded", input.now);
    const cancelled = parseBackgroundAuthorizationRecord({...current, snapshot, finishedAt: input.now});
    assertBackgroundAuthorizationCasSuccessor(current, current.snapshot.requestRevision, cancelled);
    this.#records.set(current.snapshot.requestId, cancelled);
    this.#records.set(successor.snapshot.requestId, successor);
    return {status: "superseded", record: parseBackgroundAuthorizationRecord(successor)};
  }

  async get(requestId: string): Promise<BackgroundAuthorizationRecord | null> {
    await Promise.resolve();
    portable("Background request id", requestId);
    const record = this.#records.get(requestId);
    return record === undefined ? null : parseBackgroundAuthorizationRecord(record);
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<BackgroundAuthorizationRecord | null> {
    await Promise.resolve();
    portable("Background idempotency key", idempotencyKey);
    const record = [...this.#records.values()].find((value) => value.idempotencyKey === idempotencyKey);
    return record === undefined ? null : parseBackgroundAuthorizationRecord(record);
  }

  async replaceUnclaimedTaskMappedHeadAuthority(input: TaskRuntimeMappedHeadReplacementInput): Promise<BackgroundAuthorizationTaskRuntimeReplacementResult> {
    return this.#replaceUnclaimedAuthority(input, checked => buildUnclaimedTaskMappedHeadAuthorityReplacement({ ...input, ...checked }));
  }

  async replaceUnclaimedTaskRuntimeAuthority(input: Readonly<{
    expected: BackgroundAuthorizationTaskRuntimeRecordV3;
    replacement: BackgroundAuthorizationTaskRuntimeRecordV3;
    now: number;
  }>): Promise<BackgroundAuthorizationTaskRuntimeReplacementResult> {
    return this.#replaceUnclaimedAuthority(input, buildUnclaimedTaskRuntimeAuthorityReplacement);
  }

  async replaceUnclaimedTaskCancellationAuthority(input: Readonly<{
    expected: BackgroundAuthorizationTaskRuntimeRecordV3;
    replacement: BackgroundAuthorizationTaskRuntimeRecordV3;
    now: number;
  }>): Promise<BackgroundAuthorizationTaskRuntimeReplacementResult> {
    return this.#replaceUnclaimedAuthority(input, buildUnclaimedTaskCancellationAuthorityReplacement);
  }

  async replaceUnclaimedTaskTerminalMessageAuthority(input: Readonly<{
    expected: BackgroundAuthorizationTaskRuntimeRecordV3;
    replacement: BackgroundAuthorizationTaskRuntimeRecordV3;
    now: number;
  }>): Promise<BackgroundAuthorizationTaskRuntimeReplacementResult> {
    return this.#replaceUnclaimedAuthority(
      input,
      buildUnclaimedTaskTerminalMessageAuthorityReplacement,
    );
  }

  async replaceUnclaimedTaskOutputReadAuthority(input: Readonly<{
    expected: BackgroundAuthorizationTaskRuntimeRecordV3;
    replacement: BackgroundAuthorizationTaskRuntimeRecordV3;
    now: number;
  }>): Promise<BackgroundAuthorizationTaskRuntimeReplacementResult> {
    return this.#replaceUnclaimedAuthority(input, buildUnclaimedTaskOutputReadAuthorityReplacement);
  }

  async parkTaskWakeForAdditionalAuthority(input: Readonly<{
    expected: BackgroundAuthorizationTaskRuntimeRecordV3;
    replacement: BackgroundAuthorizationTaskRuntimeRecordV3;
    proof: VerifiedProtectedTaskWakeContinuation;
    now: number;
  }>): Promise<BackgroundAuthorizationTaskWakeParkResult> {
    await input.proof.assertCurrent();
    const expected = parseBackgroundAuthorizationRecord(input.expected) as
      BackgroundAuthorizationTaskRuntimeRecordV3;
    const next = buildParkedTaskWakeAuthorityReplacement(input);
    const current = this.#records.get(expected.snapshot.requestId) ?? null;
    if (current !== null && sameBackgroundAuthorizationRecord(current, next)) {
      await input.proof.assertCurrent();
      return { status: "exact_replay", record: next };
    }
    if (current === null || !sameBackgroundAuthorizationRecord(current, expected)) {
      return {
        status: "stale",
        current: current === null ? null : parseBackgroundAuthorizationRecord(current),
      };
    }
    this.#records.set(next.snapshot.requestId, next);
    try {
      await input.proof.assertCurrent();
    } catch (error) {
      this.#records.set(expected.snapshot.requestId, expected);
      throw error;
    }
    return { status: "parked", record: next };
  }

  async renewParkedTaskWakeRecipient(input: Readonly<{
    expected: BackgroundAuthorizationTaskRuntimeRecordV3;
    replacement?: BackgroundAuthorizationTaskRuntimeRecordV3;
    proof: VerifiedProtectedTaskWakeContinuation;
    now: number;
  }>): Promise<BackgroundAuthorizationTaskWakeRecipientRenewalResult> {
    await input.proof.assertCurrent();
    const expected = parseBackgroundAuthorizationRecord(input.expected) as
      BackgroundAuthorizationTaskRuntimeRecordV3;
    const current = this.#records.get(expected.snapshot.requestId) ?? null;
    if (current === null || !sameBackgroundAuthorizationRecord(
      current,
      expected,
    )) {
      return {
        status: "stale",
        current: current === null
          ? null : parseBackgroundAuthorizationRecord(current),
      };
    }
    const renewal = rotateExpiredParkedTaskWakeRecipient(input);
    if (renewal.status !== "rotated") {
      await input.proof.assertCurrent();
      return renewal;
    }
    this.#records.set(expected.snapshot.requestId, renewal.record);
    try {
      await input.proof.assertCurrent();
    } catch (error) {
      this.#records.set(expected.snapshot.requestId, expected);
      throw error;
    }
    return renewal;
  }

  async #replaceUnclaimedAuthority(
    input: Parameters<typeof buildUnclaimedTaskRuntimeAuthorityReplacement>[0],
    build: typeof buildUnclaimedTaskRuntimeAuthorityReplacement,
  ): Promise<BackgroundAuthorizationTaskRuntimeReplacementResult> {
    await Promise.resolve();
    const expected = parseBackgroundAuthorizationRecord(input.expected);
    const current = this.#records.get(expected.snapshot.requestId) ?? null;
    if (current === null || !sameBackgroundAuthorizationRecord(current, expected)) {
      return {
        status: "stale",
        current: current === null
          ? null
          : parseBackgroundAuthorizationRecord(current),
      };
    }
    const next = build(input);
    const collision = [...this.#records.values()].find((record) =>
      record.snapshot.requestId !== next.snapshot.requestId
      && (equalBytes(record.workIdentityHash, next.workIdentityHash) || record.idempotencyKey === next.idempotencyKey)
    );
    if (collision !== undefined) {
      throw new BackgroundAuthorizationRepositoryConflictError(
        "create_conflict",
      );
    }
    this.#records.set(next.snapshot.requestId, next);
    return {
      status: "replaced",
      record: parseBackgroundAuthorizationRecord(
        next,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3,
    };
  }

  async deferUnstartedTaskRuntimeRequest(input: Readonly<{
    expected: BackgroundAuthorizationTaskRuntimeRecordV3;
    now: number;
  }>): Promise<BackgroundAuthorizationTaskRuntimeDeferralResult> {
    await Promise.resolve();
    const expected = parseBackgroundAuthorizationRecord(input.expected);
    const next = buildDeferredUnstartedTaskRuntimeRequest({
      expected: expected as BackgroundAuthorizationTaskRuntimeRecordV3,
      now: input.now,
    });
    const current = this.#records.get(expected.snapshot.requestId) ?? null;
    if (current !== null && sameBackgroundAuthorizationRecord(current, next)) {
      return {
        status: "exact_replay",
        record: parseBackgroundAuthorizationRecord(
          current,
        ) as BackgroundAuthorizationTaskRuntimeRecordV3,
      };
    }
    if (current === null || !sameBackgroundAuthorizationRecord(current, expected)) {
      return {
        status: "stale",
        current: current === null
          ? null
          : parseBackgroundAuthorizationRecord(current),
      };
    }
    this.#records.set(next.snapshot.requestId, next);
    return {
      status: "deferred",
      record: parseBackgroundAuthorizationRecord(
        next,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3,
    };
  }

  async compareAndSwap(input: Readonly<{
    readonly expectedRequestRevision: number;
    readonly next: BackgroundAuthorizationRecord;
  }>): Promise<BackgroundAuthorizationCasResult> {
    await Promise.resolve();
    const next = parseBackgroundAuthorizationRecord(input.next);
    const current = this.#records.get(next.snapshot.requestId);
    if (
      current === undefined
      || current.snapshot.requestRevision !== input.expectedRequestRevision
    ) {
      return {
        status: "stale",
        current: current === undefined
          ? null
          : parseBackgroundAuthorizationRecord(current),
      };
    }
    assertBackgroundAuthorizationCasSuccessor(
      current,
      input.expectedRequestRevision,
      next,
    );
    this.#records.set(next.snapshot.requestId, next);
    return { status: "updated", record: parseBackgroundAuthorizationRecord(next) };
  }

  async acceptVerifiedResponse(input: Readonly<{
    readonly response: BackgroundAuthorizationVerifiedDeviceResponse;
    readonly acceptedAt: number;
  }>): Promise<BackgroundAuthorizationAcceptResponseResult> {
    await Promise.resolve();
    const current = this.#records.get(
      backgroundAuthorizationVerifiedResponseRequestId(input.response),
    );
    if (current === undefined) return { status: "lost", current: null };
    if (current.snapshot.state !== "awaiting_device") {
      return {
        status: isBackgroundAuthorizationResponseReplay(current, input.response)
          ? "duplicate"
          : "lost",
        current: parseBackgroundAuthorizationRecord(current),
      };
    }
    const accepted = buildAcceptedBackgroundAuthorizationResponse(
      current,
      input.response,
      input.acceptedAt,
    );
    assertBackgroundAuthorizationCasSuccessor(
      current,
      current.snapshot.requestRevision,
      accepted.next,
      { allowResponseAcceptance: true },
    );
    if (accepted.signerEvidence !== null) {
      this.#appendEvidence(accepted.signerEvidence);
    }
    this.#records.set(current.snapshot.requestId, accepted.next);
    return {
      status: "accepted",
      record: parseBackgroundAuthorizationRecord(accepted.next),
    };
  }

  async listEligible(input: Readonly<{
    readonly now: number;
    readonly limit: number;
  }>): Promise<readonly BackgroundAuthorizationRecord[]> {
    await Promise.resolve();
    timestamp("Eligible-list timestamp", input.now);
    const limit = boundedLimit("Eligible-list limit", input.limit);
    return [...this.#records.values()]
      .filter((record) => eligible(record, input.now))
      .sort((left, right) =>
        left.snapshot.updatedAt - right.snapshot.updatedAt
        || left.snapshot.requestId.localeCompare(right.snapshot.requestId)
      )
      .slice(0, limit)
      .map(parseBackgroundAuthorizationRecord);
  }

  async listAwaitingDevicePage(input: Readonly<{
    readonly now: number;
    readonly throughUpdatedAt: number;
    readonly after?: BackgroundAuthorizationAwaitingDeviceCursor;
    readonly limit: number;
  }>): Promise<BackgroundAuthorizationAwaitingDevicePage> {
    await Promise.resolve();
    const limit = validateAwaitingDevicePageInput(input);
    const records = [...this.#records.values()]
      .filter((record) => {
        const { snapshot } = record;
        const after = input.after;
        return snapshot.state === "awaiting_device"
          && snapshot.recipient !== null
          && snapshot.recipient.expiresAt > input.now
          && snapshot.descriptorDigest !== null
          && record.descriptorBytes !== null
          && snapshot.updatedAt <= input.throughUpdatedAt
          && (after === undefined
            || snapshot.updatedAt > after.updatedAt
            || (
              snapshot.updatedAt === after.updatedAt
              && snapshot.requestId.localeCompare(after.requestId) > 0
            ));
      })
      .sort((left, right) =>
        left.snapshot.updatedAt - right.snapshot.updatedAt
        || left.snapshot.requestId.localeCompare(right.snapshot.requestId)
      )
      .slice(0, limit)
      .map(parseBackgroundAuthorizationRecord);
    const last = records.at(-1);
    return Object.freeze({
      records: Object.freeze(records),
      continuation: records.length === limit && last !== undefined
        ? Object.freeze({
          updatedAt: last.snapshot.updatedAt,
          requestId: last.snapshot.requestId,
        })
        : null,
    });
  }

  async listAwaitingTaskRuntimeRecipientPage(input: Readonly<{
    readonly now: number;
    readonly throughUpdatedAt: number;
    readonly after?: BackgroundAuthorizationAwaitingTaskRuntimeRecipientCursor;
    readonly limit: number;
  }>): Promise<BackgroundAuthorizationAwaitingTaskRuntimeRecipientPage> {
    await Promise.resolve();
    const limit = validateAwaitingTaskRuntimeRecipientPageInput(input);
    const records = [...this.#records.values()]
      .filter((record): record is BackgroundAuthorizationTaskRuntimeRecordV3 => {
        const after = input.after;
        return isDueTaskRuntimeRecipient(record, input.now)
          && record.snapshot.updatedAt <= input.throughUpdatedAt
          && (after === undefined
            || record.snapshot.updatedAt > after.updatedAt
            || (
              record.snapshot.updatedAt === after.updatedAt
              && record.snapshot.requestId.localeCompare(after.requestId) > 0
            ));
      })
      .sort((left, right) =>
        left.snapshot.updatedAt - right.snapshot.updatedAt
        || left.snapshot.requestId.localeCompare(right.snapshot.requestId)
      )
      .slice(0, limit)
      .map((record) =>
        parseBackgroundAuthorizationRecord(record) as
          BackgroundAuthorizationTaskRuntimeRecordV3
      );
    const last = records.at(-1);
    return Object.freeze({
      records: Object.freeze(records),
      continuation: records.length === limit && last !== undefined
        ? Object.freeze({
          updatedAt: last.snapshot.updatedAt,
          requestId: last.snapshot.requestId,
        })
        : null,
    });
  }

  async listTaskRuntimeCancellationPage(input: Readonly<{
    readonly throughUpdatedAt: number;
    readonly after?: BackgroundAuthorizationTaskRuntimeCancellationCursor;
    readonly limit: number;
  }>): Promise<BackgroundAuthorizationTaskRuntimeCancellationPage> {
    await Promise.resolve();
    const limit = validateTaskRuntimeCancellationPageInput(input);
    const candidates = [...this.#records.values()]
      .filter((record): record is BackgroundAuthorizationTaskRuntimeRecordV3 => {
        const after = input.after;
        return isTaskRuntimeCancellationCandidate(record)
          && record.snapshot.updatedAt <= input.throughUpdatedAt
          && (after === undefined
            || record.snapshot.updatedAt > after.updatedAt
            || (
              record.snapshot.updatedAt === after.updatedAt
              && record.snapshot.requestId.localeCompare(after.requestId) > 0
            ));
      })
      .sort((left, right) =>
        left.snapshot.updatedAt - right.snapshot.updatedAt
        || left.snapshot.requestId.localeCompare(right.snapshot.requestId)
      )
      .slice(0, limit)
      .map((record) => Object.freeze({
        requestId: record.snapshot.requestId,
        workId: record.snapshot.workId,
        namespaceId: record.snapshot.namespaceId,
        recipientGeneration: record.snapshot.recipientGeneration,
        requestRevision: record.snapshot.requestRevision,
        updatedAt: record.snapshot.updatedAt,
      }));
    const last = candidates.at(-1);
    return Object.freeze({
      candidates: Object.freeze(candidates),
      continuation: candidates.length === limit && last !== undefined
        ? Object.freeze({
          updatedAt: last.updatedAt,
          requestId: last.requestId,
        })
        : null,
    });
  }

  async settleTaskRuntimeExecutionAuthorities(input: Readonly<{
    readonly workId: string;
    readonly namespaceId: string;
    readonly now: number;
  }>): Promise<BackgroundAuthorizationTaskRuntimeExecutionSettlementResult> {
    await Promise.resolve();
    const records = [...this.#records.values()].filter((record) =>
      record.snapshot.workId === input.workId
      && TASK_RUNTIME_EXECUTION_SETTLEMENT_WORK_KINDS.has(record.workKind)
    );
    const plan = planTaskRuntimeExecutionAuthoritySettlement({
      ...input,
      records,
    });
    if (plan.result.status === "conflict") return plan.result;
    for (const next of plan.updates) {
      this.#records.set(next.snapshot.requestId, next);
    }
    return plan.result;
  }

  async pruneTerminal(input: Readonly<{
    readonly now: number;
    readonly limit?: number;
  }>): Promise<number> {
    await Promise.resolve();
    timestamp("Terminal-prune timestamp", input.now);
    const limit = boundedLimit(
      "Terminal-prune limit",
      input.limit ?? DEFAULT_PRUNE_LIMIT,
    );
    const cutoff = input.now - TERMINAL_RETENTION_MS;
    const candidates = [...this.#records.values()]
      .filter((record) =>
        record.finishedAt !== null && record.finishedAt <= cutoff
      )
      .sort((left, right) =>
        left.finishedAt! - right.finishedAt!
        || left.snapshot.requestId.localeCompare(right.snapshot.requestId)
      )
      .slice(0, limit);
    for (const record of candidates) {
      this.#records.delete(record.snapshot.requestId);
    }
    return candidates.length;
  }

}

export const BACKGROUND_AUTHORIZATION_TERMINAL_RETENTION_MS =
  TERMINAL_RETENTION_MS;
export const BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH =
  DEFAULT_PRUNE_LIMIT;
