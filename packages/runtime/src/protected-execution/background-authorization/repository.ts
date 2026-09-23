import { createHash } from "node:crypto";
import {
  BACKGROUND_AUTHORIZATION_BYTE_LIMITS,
  BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS,
  CRYPTO_STORAGE_COLLECTION_LIMITS,
} from "@nautilo/db/schema";
import type {
  VerifiedBackgroundAuthorizationDeviceResponse,
  VerifiedAgentBackgroundAuthorizationDeviceResponseV2,
} from "@nautilo/lattice-bridge";
import {
  decodeBackgroundAuthorizationResponseV2,
  encodeBackgroundWorkDescriptorV2,
  inspectBackgroundAuthorizationResponseV2,
  backgroundProcessorNamespaceRequirementsV2,
  type VerifiedBackgroundAuthorizationV2,
} from "@nautilo/lattice-crypto/background";
import {
  BACKGROUND_AUTHORIZATION_MAX_GENERATION,
  BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES,
  BACKGROUND_AUTHORIZATION_MAX_TIMESTAMP_MS,
  advanceBackgroundAuthorizationGeneration,
  cancelBackgroundAuthorizationRequest,
  markBackgroundAuthorizationGrantReady,
  parseBackgroundAuthorizationRequestSnapshot,
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
  "task.approval_resume",
] as const);

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
  "task.approval_resume",
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

export type BackgroundAuthorizationVerifiedDeviceResponse =
  | VerifiedBackgroundAuthorizationDeviceResponse
  | VerifiedAgentBackgroundAuthorizationDeviceResponseV2
  | BackgroundAuthorizationVerifiedProcessorResponseV2
  | BackgroundAuthorizationVerifiedRuntimeResponseV3;

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

export type BackgroundAuthorizationSupersedeResult =
  | Readonly<{status: "superseded" | "existing"; record: BackgroundAuthorizationRecord}>
  | Readonly<{status: "stale"; current: BackgroundAuthorizationRecord | null}>;

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
  pruneTerminal(input: Readonly<{
    readonly now: number;
    readonly limit?: number;
  }>): Promise<number>;
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
  const credentialHash = isRuntimeV3Response(response)
    ? response.authorizationHash
    : response.credentialHash;
  const credentialId = isRuntimeV3Response(response)
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
        ? CRYPTO_STORAGE_COLLECTION_LIMITS.agentGrantMaximumOrdinal + 1
        : MAX_AUTHORITY_SET_SIZE
    )
    || !Array.isArray(value.domainRequirements as unknown)
    || value.domainRequirements.length < 1
    || value.domainRequirements.length > (
      subjectKind === "runtime"
        ? CRYPTO_STORAGE_COLLECTION_LIMITS.agentGrantMaximumOrdinal + 1
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
  if (
    snapshot.credentialSubject.kind === "runtime"
    && (
      (value.workKind !== "task.dispatch" && value.workKind !== "task.execute")
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
      )
      || (
        !isAgentV2Response(response)
        && !isProcessorV2Response(response)
        && !isRuntimeV3Response(response)
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
  if (isRuntimeV3Response(response)) {
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
      > BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_LIMITS.runtime
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

export class InMemoryBackgroundAuthorizationRepository
  implements BackgroundAuthorizationRepository {
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
