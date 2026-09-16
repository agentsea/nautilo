import {decodeBackgroundProcessorWorkDescriptorV2, encodeBackgroundWorkDescriptorV2, type BackgroundProcessorWorkDescriptorV2, type BackgroundNamespaceAuthorityV2} from "@nautilo/lattice-crypto/background";
import { createHash } from "node:crypto";
import {
  accessRevision,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  namespaceId,
  objectId,
  unixTimestamp,
  type ProcessorTransformRecipientAttempt,
} from "@nautilo/lattice-crypto";
import {
  decodeBackgroundWorkDescriptorV1,
  encodeBackgroundWorkDescriptorV1,
  type BackgroundWorkDescriptorV1,
} from "@nautilo/lattice-crypto/wire";
import {
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_CIPHERTEXT_BYTES,
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_PLAINTEXT_BYTES,
} from "@nautilo/lattice-bridge";
import {
  REFLECTION_RECORD_CRYPTO_OBJECT_TYPE,
} from "@nautilo/reflection-bridge/server";

import {
  createBackgroundAuthorizationRequest,
  createBackgroundAuthorizationRequestV2,
} from "../protected-execution/background-authorization/lifecycle";
import {
  parseBackgroundAuthorizationRecord,
  type BackgroundAuthorizationRecord,
} from "../protected-execution/background-authorization/repository";
import type {
  ProtectedStenographerBackgroundDescriptorFactory,
} from "./protected-stenographer-background-coordinator";
import type {
  ProtectedStenographerCompactionWork,
} from "./protected-stenographer-compaction";
import type {
  ProtectedStenographerExtractionWork,
} from "./protected-stenographer-extraction";
import {
  fingerprintProtectedStenographerSourceBindings,
} from "./protected-source-loader";
import type {
  ProtectedStenographerCompactionWorkClaim,
  ProtectedStenographerExtractionWorkClaim,
} from "./protected-stenographer-work-repository";

export const PROTECTED_STENOGRAPHER_DESCRIPTOR_PLAINTEXT_BUDGET =
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_PLAINTEXT_BYTES;
export const PROTECTED_STENOGRAPHER_DESCRIPTOR_CIPHERTEXT_BUDGET =
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_CIPHERTEXT_BYTES;

export type ProtectedStenographerRecoveredWork =
  | Readonly<{
    readonly claim: ProtectedStenographerExtractionWorkClaim;
    readonly compactionModelId: null;
  }>
  | Readonly<{
    readonly claim: ProtectedStenographerCompactionWorkClaim;
    readonly compactionModelId: string;
  }>;

export type ProtectedStenographerDurableWorkRecoveryResult =
  | Readonly<{
    readonly status: "recovered";
    readonly work: ProtectedStenographerRecoveredWork;
  }>
  | Readonly<{
    readonly status: "missing" | "leased" | "stale";
  }>;

/**
 * Product-role restart boundary.
 *
 * Implementations must query durable product state and reacquire the exact
 * product lease described by `descriptor`. They must not return a claim from
 * a process-local scheduler cache. The composition independently verifies the
 * returned binding fingerprint, work identity, descriptor inventory, and
 * deterministic output slots before any protected object can be opened.
 */
export interface ProtectedStenographerDurableWorkRecoveryPort {
  readonly recoverExact: (input: Readonly<{
    readonly record: BackgroundAuthorizationRecord;
    readonly descriptor: BackgroundWorkDescriptorV1 | BackgroundProcessorWorkDescriptorV2 | null;
    readonly now: Date;
  }>) => Promise<ProtectedStenographerDurableWorkRecoveryResult>;
}

export interface ProtectedStenographerCryptoAuthority {
  readonly domainId: string;
  readonly processorAuthorizationRevision: number;
  readonly expectedDomainEpoch: number;
  readonly expectedNamespaceAccessRevision: number;
  readonly expectedPolicyRevision: number;
}

export class ProtectedStenographerWorkCompositionError extends Error {
  constructor(
    readonly reason:
      | "descriptor_mismatch"
      | "invalid_work"
      | "stale_authority"
      | "stale_work",
    message: string,
  ) {
    super(message);
    this.name = "ProtectedStenographerWorkCompositionError";
  }
}

type DescriptorCrypto = Readonly<{
  hash: (bytes: Uint8Array) => Uint8Array;
}>;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function exactDigest(label: string, value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new ProtectedStenographerWorkCompositionError(
      "invalid_work",
      `${label} must contain exactly 32 bytes`,
    );
  }
  return value.slice();
}

function sha256(value: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(value, "utf8").digest());
}

function descriptorHash(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(bytes).digest());
}

function orderedUnique(values: readonly string[]): readonly string[] {
  const ordered = [...values];
  const seen = new Set<string>();
  for (const value of ordered) {
    if (value.length === 0 || seen.has(value)) {
      throw new ProtectedStenographerWorkCompositionError(
        "invalid_work",
        "protected Stenographer object identities must be nonempty and unique",
      );
    }
    seen.add(value);
  }
  return Object.freeze(ordered);
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== value) {
    throw new ProtectedStenographerWorkCompositionError(
      "invalid_work",
      "protected Stenographer work creation time is invalid",
    );
  }
  return parsed;
}

function exactFields(
  label: string,
  value: object,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((field, index) => field !== canonical[index])
  ) {
    throw new ProtectedStenographerWorkCompositionError(
      "invalid_work",
      `${label} contains unknown or missing fields`,
    );
  }
}

function normalizedRecoveredWork(
  value: ProtectedStenographerRecoveredWork,
): ProtectedStenographerRecoveredWork {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtectedStenographerWorkCompositionError(
      "invalid_work",
      "recovered protected Stenographer work must be an object",
    );
  }
  exactFields("recovered protected Stenographer work", value, [
    "claim",
    "compactionModelId",
  ]);
  if (value.claim.kind === "extraction") {
    const target = value.claim.rebuildTargetMessageId;
    if (value.claim.workKind === "stenographer.rebuild"
      ? target === undefined || !Number.isSafeInteger(target) || target < value.claim.throughMessageIdInclusive || value.claim.lane !== "live"
      : target !== undefined) {
      throw new ProtectedStenographerWorkCompositionError("invalid_work", "Rebuild work requires its exact prepared target");
    }
    if (value.compactionModelId !== null) {
      throw new ProtectedStenographerWorkCompositionError(
        "invalid_work",
        "extraction work cannot carry a compaction model",
      );
    }
    return value;
  }
  if (
    typeof value.compactionModelId !== "string"
    || value.compactionModelId.length === 0
    || value.compactionModelId.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value.compactionModelId)
  ) {
    throw new ProtectedStenographerWorkCompositionError(
      "invalid_work",
      "compaction work requires a portable model identifier",
    );
  }
  return value;
}

function outputIds(
  work: ProtectedStenographerRecoveredWork,
): readonly string[] {
  return work.claim.kind === "extraction"
    ? orderedUnique(work.claim.outputSlots.map((slot) => slot.objectId))
    : Object.freeze([work.claim.outputSlot.objectId]);
}

function calculatedBindingFingerprint(
  work: ProtectedStenographerRecoveredWork,
): Uint8Array {
  const bindingObjectIds =
    work.claim.bindings.map((binding) => binding.objectId);
  if (
    work.claim.inputObjectIds.length !== bindingObjectIds.length
    || work.claim.inputObjectIds.some(
      (objectId, index) => objectId !== bindingObjectIds[index],
    )
  ) {
    throw new ProtectedStenographerWorkCompositionError(
      "invalid_work",
      "protected Stenographer input order does not match source bindings",
    );
  }
  const actual =
    fingerprintProtectedStenographerSourceBindings(work.claim.bindings);
  const claimed = exactDigest(
    "protected Stenographer source fingerprint",
    work.claim.sourceBindingFingerprint,
  );
  try {
    if (!equalBytes(actual, claimed)) {
      throw new ProtectedStenographerWorkCompositionError(
        "invalid_work",
        "protected Stenographer claim contains a false source fingerprint",
      );
    }
    return actual.slice();
  } finally {
    actual.fill(0);
    claimed.fill(0);
  }
}

function descriptorSourceFingerprint(
  work: ProtectedStenographerRecoveredWork,
): Uint8Array {
  return work.claim.kind === "extraction"
    ? exactDigest(
      "protected Stenographer covered range fingerprint",
      work.claim.coveredRangeFingerprint,
    )
    : calculatedBindingFingerprint(work);
}

function canonicalWorkIdentity(
  workInput: ProtectedStenographerRecoveredWork,
): Uint8Array {
  const work = normalizedRecoveredWork(workInput);
  const fingerprint = calculatedBindingFingerprint(work);
  const coveredRangeFingerprint = work.claim.kind === "extraction"
    ? exactDigest(
      "protected Stenographer covered range fingerprint",
      work.claim.coveredRangeFingerprint,
    )
    : null;
  try {
    const claim = work.claim;
    const common = [
      claim.kind,
      claim.workKind,
      claim.workId,
      claim.roomId,
      claim.namespaceId,
      claim.rebuildGeneration,
      Buffer.from(fingerprint).toString("hex"),
      orderedUnique(claim.inputObjectIds),
      outputIds(work),
      claim.createdAt,
    ];
    const specific = claim.kind === "extraction"
      ? [
        Buffer.from(coveredRangeFingerprint!).toString("hex"),
        claim.sourceBatchId,
        claim.lane,
        claim.fromMessageIdExclusive,
        claim.throughMessageIdInclusive,
        claim.trigger,
        claim.requiresContentRecheck,
        claim.extractorVersion,
        claim.outputSlots.map((slot) => [slot.eventId, slot.objectId]),
        ...(claim.rebuildTargetMessageId === undefined ? [] : [claim.rebuildTargetMessageId]),
      ]
      : [
        claim.activeEventCount,
        claim.selectedEventCount,
        claim.hasDeferredMiddle,
        claim.compactorVersion,
        claim.outputSlot.rollupId,
        work.compactionModelId,
      ];
    return sha256(JSON.stringify([
      "nautilo/runtime/protected-stenographer-work-identity/v1",
      ...common,
      ...specific,
    ]));
  } finally {
    fingerprint.fill(0);
    coveredRangeFingerprint?.fill(0);
  }
}

/** Append-only current plan identity; canonical v1 content identity remains readable. */
export function currentExecutionPlanIdentity(input: Readonly<{
  work: ProtectedStenographerRecoveredWork;
  domainId: string;
  expectedNamespaceAccessRevision: number;
  expectedPolicyRevision: number;
}>): Uint8Array {
  const domainId = cryptoDomainId(input.domainId);
  const namespaceRevision = accessRevision(input.expectedNamespaceAccessRevision);
  const policyRevision = authorizationRevision(input.expectedPolicyRevision);
  const canonical = canonicalWorkIdentity(input.work);
  try {
    return sha256(JSON.stringify(["nautilo/runtime/stenographer-current-execution-plan/v2",
      Buffer.from(canonical).toString("hex"), domainId, namespaceRevision, policyRevision]));
  } finally {canonical.fill(0);}
}

/** Retain the complete public authority digest in the queue key so metadata-only
 * recovery can authenticate work before a recipient descriptor exists. */
function currentAuthorityDigest(authority: CurrentProtectedStenographerAuthority): Uint8Array {
  return sha256(JSON.stringify([authority.policyRevision,
    (Object.keys(authority.namespace) as (keyof CurrentProtectedStenographerAuthority["namespace"])[]).sort().map(key => {
      const value = authority.namespace[key]; return [key, value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value];
    })]));
}

function boundCurrentExecutionIdentity(work: ProtectedStenographerRecoveredWork, domainId: string,
  namespaceRevision: number, policyRevision: number, authorityDigest: Uint8Array): Uint8Array {
  const canonical = currentExecutionPlanIdentity({work, domainId, expectedNamespaceAccessRevision: namespaceRevision,
    expectedPolicyRevision: policyRevision});
  try {return sha256(JSON.stringify(["nautilo/runtime/stenographer-current-execution-plan/v2-bound",
    Buffer.from(canonical).toString("hex"), Buffer.from(authorityDigest).toString("hex")]));}
  finally {canonical.fill(0);}
}

function currentBoundPlan(work: ProtectedStenographerRecoveredWork, authority: CurrentProtectedStenographerAuthority) {
  const authorityDigest = currentAuthorityDigest(authority);
  try {
    const identity = boundCurrentExecutionIdentity(work, authority.namespace.domainId,
      authority.namespace.namespaceAccessRevision, authority.policyRevision, authorityDigest);
    return {identity, idempotencyKey: `st-processor-v2:${Buffer.from(identity).toString("hex")}:${Buffer.from(authorityDigest).toString("base64url")}`};
  } finally {authorityDigest.fill(0);}
}

export function currentExecutionPlanIdempotencyKey(identity: Uint8Array): string {
  const digest = exactDigest("Current execution plan identity", identity);
  try {return `stenographer-processor-v2:${Buffer.from(digest).toString("hex")}`;}
  finally {digest.fill(0);}
}

function purpose(
  workKind: ProtectedStenographerRecoveredWork["claim"]["workKind"],
): "journal.extract" | "journal.compact" | "journal.rebuild" {
  return workKind === "stenographer.compaction"
    ? "journal.compact"
    : workKind === "stenographer.rebuild" ? "journal.rebuild" : "journal.extract";
}

function range(
  work: ProtectedStenographerRecoveredWork,
): Readonly<{ start: number; end: number }> {
  if (work.claim.kind === "extraction") {
    const start = work.claim.fromMessageIdExclusive + 1;
    const end = work.claim.throughMessageIdInclusive;
    if (!Number.isSafeInteger(start) || start < 1 || start > end) {
      throw new ProtectedStenographerWorkCompositionError(
        "invalid_work",
        "protected Stenographer extraction range is invalid",
      );
    }
    return Object.freeze({ start, end });
  }
  const sequences = work.claim.bindings.flatMap((binding) =>
    binding.kind === "event"
      ? [binding.binding.sequence]
      : binding.kind === "rollup"
      ? [binding.binding.throughEventSequence]
      : []
  );
  if (sequences.length === 0) {
    throw new ProtectedStenographerWorkCompositionError(
      "invalid_work",
      "protected Stenographer compaction has no journal sequence",
    );
  }
  return Object.freeze({
    start: Math.min(...sequences),
    end: Math.max(...sequences),
  });
}

function descriptorFor(
  input: Readonly<{
    readonly record: BackgroundAuthorizationRecord;
    readonly attempt: ProcessorTransformRecipientAttempt;
    readonly work: ProtectedStenographerRecoveredWork;
    readonly now: number;
  }>,
): BackgroundWorkDescriptorV1 {
  const work = normalizedRecoveredWork(input.work);
  assertRecoveredIdentity(input.record, work);
  const claim = work.claim;
  const exactRange = range(work);
  const exactOutputIds = outputIds(work);
  const outputType = claim.kind === "extraction"
    ? REFLECTION_RECORD_CRYPTO_OBJECT_TYPE
    : "room_event_rollup";
  const createdAt = timestamp(claim.createdAt);
  if (
    input.attempt.requestId !== input.record.snapshot.requestId
    || input.attempt.workId !== input.record.snapshot.workId
    || input.attempt.namespaceId !== input.record.snapshot.namespaceId
    || input.attempt.recipientGeneration
      !== input.record.snapshot.recipientGeneration
  ) {
    throw new ProtectedStenographerWorkCompositionError(
      "descriptor_mismatch",
      "recipient attempt does not match the durable work request",
    );
  }
  if (
    input.record.processorAuthorizationRevision === null
    || input.record.expectedDomainEpoch === null
    || input.record.snapshot.credentialSubject.kind !== "processor"
  ) {
    throw new ProtectedStenographerWorkCompositionError(
      "stale_authority",
      "protected Stenographer work lacks processor authority",
    );
  }
  const sourceFingerprint = descriptorSourceFingerprint(work);
  return Object.freeze({
    formatVersion: 1,
    requestId: input.record.snapshot.requestId,
    recipientGeneration: input.record.snapshot.recipientGeneration,
    workKind: claim.workKind,
    workId: claim.workId,
    namespaceId: namespaceId(claim.namespaceId),
    domainId: cryptoDomainId(input.record.domainId),
    subject: Object.freeze({
      kind: "processor" as const,
      processorKind: "stenographer" as const,
      processorVersion: 1 as const,
      authorizationRevision: authorizationRevision(
        input.record.processorAuthorizationRevision,
      ),
    }),
    purpose: purpose(claim.workKind),
    operations: Object.freeze(["decrypt", "encrypt"] as const),
    source: Object.freeze({
      kind: "journal_range" as const,
      startSequence: exactRange.start,
      endSequence: exactRange.end,
      rebuildGeneration: claim.rebuildGeneration,
      fingerprint: sourceFingerprint,
    }),
    inputObjectIds: Object.freeze(
      orderedUnique(claim.inputObjectIds).map(objectId),
    ),
    outputObjectIds: Object.freeze(exactOutputIds.map(objectId)),
    outputObjectMetadata: Object.freeze(exactOutputIds.map((exactObjectId) =>
      Object.freeze({
        objectId: objectId(exactObjectId),
        objectType: outputType,
        createdAt: unixTimestamp(createdAt),
      })
    )),
    maximumInputObjectCount: claim.inputObjectIds.length,
    maximumOutputObjectCount: exactOutputIds.length,
    maximumPlaintextBytes:
      PROTECTED_STENOGRAPHER_DESCRIPTOR_PLAINTEXT_BUDGET,
    maximumCiphertextBytes:
      PROTECTED_STENOGRAPHER_DESCRIPTOR_CIPHERTEXT_BUDGET,
    expectedDomainEpoch: domainEpoch(input.record.expectedDomainEpoch),
    expectedNamespaceAccessRevision: accessRevision(
      input.record.expectedNamespaceAccessRevision,
    ),
    expectedPolicyRevision: authorizationRevision(
      input.record.expectedPolicyRevision,
    ),
    recipientKeyId: input.attempt.recipientKeyId,
    recipientPublicKey: input.attempt.recipientPublicKey.slice(),
    issuedAt: input.now,
    notBefore: input.now,
    expiresAt: input.attempt.expiresAt,
    idempotencyId: input.record.idempotencyKey,
  });
}

function assertAuthorityMatches(
  record: BackgroundAuthorizationRecord,
  authority: ProtectedStenographerCryptoAuthority,
): void {
  if (
    authority.domainId !== record.domainId
    || authority.processorAuthorizationRevision
      !== record.processorAuthorizationRevision
    || authority.expectedDomainEpoch !== record.expectedDomainEpoch
    || authority.expectedNamespaceAccessRevision
      !== record.expectedNamespaceAccessRevision
    || authority.expectedPolicyRevision !== record.expectedPolicyRevision
  ) {
    throw new ProtectedStenographerWorkCompositionError(
      "stale_authority",
      "current crypto authority no longer matches the durable request",
    );
  }
}

function assertRecoveredIdentity(
  record: BackgroundAuthorizationRecord,
  work: ProtectedStenographerRecoveredWork,
): void {
  const isCurrentProcessor = record.snapshot.formatVersion === 2
    && record.snapshot.credentialSubject.kind === "processor";
  const bound = isCurrentProcessor
    ? /^st-processor-v2:([0-9a-f]{64}):([A-Za-z0-9_-]{43})$/u.exec(record.idempotencyKey) : null;
  const current = isCurrentProcessor && /^stenographer-processor-v2:[0-9a-f]{64}$/u.test(record.idempotencyKey);
  const identity = bound !== null ? boundCurrentExecutionIdentity(work, record.domainId,
    record.expectedNamespaceAccessRevision, record.expectedPolicyRevision, Uint8Array.from(Buffer.from(bound[2]!, "base64url"))) : current ? currentExecutionPlanIdentity({work, domainId: record.domainId,
    expectedNamespaceAccessRevision: record.expectedNamespaceAccessRevision, expectedPolicyRevision: record.expectedPolicyRevision}) : canonicalWorkIdentity(work);
  try {
    if (
      (bound !== null && bound[1] !== Buffer.from(identity).toString("hex"))
      || (current && record.idempotencyKey !== currentExecutionPlanIdempotencyKey(identity))
      || work.claim.workId !== record.snapshot.workId
      || work.claim.namespaceId !== record.snapshot.namespaceId
      || work.claim.workKind !== record.workKind
      || purpose(work.claim.workKind) !== record.purpose
      || !equalBytes(identity, record.workIdentityHash)
    ) {
      throw new ProtectedStenographerWorkCompositionError(
        "stale_work",
        "recovered work does not match its durable identity",
      );
    }
  } finally {
    identity.fill(0);
  }
}

function assertDescriptorMatchesRecord(
  descriptor: BackgroundWorkDescriptorV1,
  record: BackgroundAuthorizationRecord,
): void {
  const subject = descriptor.subject;
  const recipient = record.snapshot.recipient;
  const recipientMatches = recipient === null
    ? (
      (
        record.snapshot.state === "publication_reconciliation"
        || record.snapshot.state === "completed"
      )
      && record.snapshot.acceptedResponse !== null
      && descriptor.recipientGeneration
        === record.snapshot.acceptedResponse.recipientGeneration
    )
    : descriptor.recipientKeyId === recipient.recipientKeyId
      && Buffer.from(descriptor.recipientPublicKey).toString("base64url")
        === recipient.recipientPublicKey
      && descriptor.expiresAt === recipient.expiresAt;
  if (
    descriptor.requestId !== record.snapshot.requestId
    || descriptor.recipientGeneration
      !== record.snapshot.recipientGeneration
    || descriptor.workKind !== record.workKind
    || descriptor.workId !== record.snapshot.workId
    || descriptor.namespaceId !== record.snapshot.namespaceId
    || descriptor.domainId !== record.domainId
    || descriptor.purpose !== record.purpose
    || descriptor.idempotencyId !== record.idempotencyKey
    || descriptor.expectedDomainEpoch !== record.expectedDomainEpoch
    || descriptor.expectedNamespaceAccessRevision
      !== record.expectedNamespaceAccessRevision
    || descriptor.expectedPolicyRevision !== record.expectedPolicyRevision
    || subject.kind !== "processor"
    || subject.processorKind !== "stenographer"
    || subject.processorVersion !== 1
    || subject.authorizationRevision
      !== record.processorAuthorizationRevision
    || !recipientMatches
  ) {
    throw new ProtectedStenographerWorkCompositionError(
      "descriptor_mismatch",
      "durable descriptor does not match its authorization request",
    );
  }
}

function assertDescriptorMatchesRecoveredWork(
  descriptor: BackgroundWorkDescriptorV1,
  record: BackgroundAuthorizationRecord,
  work: ProtectedStenographerRecoveredWork,
): void {
  assertRecoveredIdentity(record, work);
  const claim = work.claim;
  const exactRange = range(work);
  const exactInputs = orderedUnique(claim.inputObjectIds);
  const exactOutputs = outputIds(work);
  const fingerprint = descriptorSourceFingerprint(work);
  const metadataCreatedAt = timestamp(claim.createdAt);
  const matches =
    descriptor.source.kind === "journal_range"
    && descriptor.source.startSequence === exactRange.start
    && descriptor.source.endSequence === exactRange.end
    && descriptor.source.rebuildGeneration === claim.rebuildGeneration
    && equalBytes(descriptor.source.fingerprint, fingerprint)
    && descriptor.maximumInputObjectCount === exactInputs.length
    && descriptor.maximumOutputObjectCount === exactOutputs.length
    && descriptor.maximumPlaintextBytes
      === PROTECTED_STENOGRAPHER_DESCRIPTOR_PLAINTEXT_BUDGET
    && descriptor.maximumCiphertextBytes
      === PROTECTED_STENOGRAPHER_DESCRIPTOR_CIPHERTEXT_BUDGET
    && descriptor.inputObjectIds.length === exactInputs.length
    && descriptor.inputObjectIds.every(
      (id, index) => id === exactInputs[index],
    )
    && descriptor.outputObjectIds.length === exactOutputs.length
    && descriptor.outputObjectIds.every(
      (id, index) => id === exactOutputs[index],
    )
    && descriptor.outputObjectMetadata.length === exactOutputs.length
    && descriptor.outputObjectMetadata.every((metadata, index) =>
      metadata.objectId === exactOutputs[index]
      && metadata.objectType === (
        claim.kind === "extraction"
          ? REFLECTION_RECORD_CRYPTO_OBJECT_TYPE
          : "room_event_rollup"
      )
      && metadata.createdAt === metadataCreatedAt
    );
  fingerprint.fill(0);
  if (!matches) {
    throw new ProtectedStenographerWorkCompositionError(
      "stale_work",
      "recovered work does not match its durable descriptor",
    );
  }
}

export function createProtectedStenographerAuthorizationRecord(
  input: Readonly<{
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly work: ProtectedStenographerRecoveredWork;
    readonly authority: ProtectedStenographerCryptoAuthority;
    readonly now: number;
  }>,
): BackgroundAuthorizationRecord {
  const work = normalizedRecoveredWork(input.work);
  const identity = canonicalWorkIdentity(work);
  return parseBackgroundAuthorizationRecord({
    snapshot: createBackgroundAuthorizationRequest({
      requestId: input.requestId,
      workId: work.claim.workId,
      namespaceId: work.claim.namespaceId,
      credentialSubject: {
        kind: "processor",
        processorKind: "stenographer",
        processorVersion: 1,
        authorizationRevision:
          input.authority.processorAuthorizationRevision,
      },
      now: input.now,
    }),
    workIdentityHash: identity,
    idempotencyKey: input.idempotencyKey,
    workKind: work.claim.workKind,
    purpose: purpose(work.claim.workKind),
    domainId: input.authority.domainId,
    processorAuthorizationRevision:
      input.authority.processorAuthorizationRevision,
    expectedDomainEpoch: input.authority.expectedDomainEpoch,
    expectedNamespaceAccessRevision:
      input.authority.expectedNamespaceAccessRevision,
    expectedPolicyRevision: input.authority.expectedPolicyRevision,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
  });
}

export function createProtectedStenographerDescriptorFactory(
  options: Readonly<{
    readonly crypto: DescriptorCrypto;
    readonly recovery: ProtectedStenographerDurableWorkRecoveryPort;
    readonly resolveCurrentAuthority: (
      record: BackgroundAuthorizationRecord,
    ) => Promise<ProtectedStenographerCryptoAuthority | null>;
    readonly now: () => number;
  }>,
): ProtectedStenographerBackgroundDescriptorFactory {
  return Object.freeze({
    create: async (input: Readonly<{
      readonly record: BackgroundAuthorizationRecord;
      readonly attempt: ProcessorTransformRecipientAttempt;
    }>) => {
      const { record, attempt } = input;
      const authority = await options.resolveCurrentAuthority(record);
      if (authority === null) {
        throw new ProtectedStenographerWorkCompositionError(
          "stale_authority",
          "current crypto authority is unavailable",
        );
      }
      assertAuthorityMatches(record, authority);
      const now = options.now();
      const recovered = await options.recovery.recoverExact({
        record,
        descriptor: null,
        now: new Date(now),
      });
      if (recovered.status !== "recovered") {
        throw new ProtectedStenographerWorkCompositionError(
          "stale_work",
          `protected Stenographer work recovery returned ${recovered.status}`,
        );
      }
      const descriptor = descriptorFor({
        record,
        attempt,
        work: recovered.work,
        now,
      });
      const bytes = encodeBackgroundWorkDescriptorV1(descriptor);
      const digest = exactDigest(
        "protected Stenographer descriptor digest",
        options.crypto.hash(bytes),
      );
      return Object.freeze({
        descriptorBytes: bytes,
        descriptorHash: digest,
      });
    },
  });
}

/** Current authority is the existing signed Domain/Namespace head, not a processor permission. */
export interface CurrentProtectedStenographerAuthority {
  readonly namespace: BackgroundNamespaceAuthorityV2;
  readonly policyRevision: number;
}

export function createCurrentProtectedStenographerAuthorizationRecord(input: Readonly<{
  requestId: string; idempotencyKey?: string; work: ProtectedStenographerRecoveredWork;
  authority: CurrentProtectedStenographerAuthority; now: number;
}>): BackgroundAuthorizationRecord {
  const work = normalizedRecoveredWork(input.work);
  if (input.authority.namespace.namespaceId !== work.claim.namespaceId
    || input.authority.namespace.roomId !== work.claim.roomId) {
    throw new ProtectedStenographerWorkCompositionError("stale_authority", "Current work namespace changed");
  }
  const {identity, idempotencyKey} = currentBoundPlan(work, input.authority);
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== idempotencyKey) {
    identity.fill(0);
    throw new TypeError("Current execution idempotency must match its derived plan identity");
  }
  try {return parseBackgroundAuthorizationRecord({
    snapshot: createBackgroundAuthorizationRequestV2({requestId: input.requestId, workId: work.claim.workId,
      namespaceId: work.claim.namespaceId,
      credentialSubject: {kind: "processor", processorKind: "stenographer", processorVersion: 1}, now: input.now}),
    workIdentityHash: identity, idempotencyKey,
    workKind: work.claim.workKind, purpose: purpose(work.claim.workKind),
    domainId: input.authority.namespace.domainId, processorAuthorizationRevision: null, expectedDomainEpoch: null,
    expectedNamespaceAccessRevision: input.authority.namespace.namespaceAccessRevision,
    expectedPolicyRevision: input.authority.policyRevision, descriptorBytes: null, acceptedMaterial: null, finishedAt: null,
  });} finally {identity.fill(0);}
}

function currentDescriptorFor(input: Readonly<{
  record: BackgroundAuthorizationRecord; attempt: ProcessorTransformRecipientAttempt;
  work: ProtectedStenographerRecoveredWork; authority: CurrentProtectedStenographerAuthority; now: number;
}>): BackgroundProcessorWorkDescriptorV2 {
  const {record, attempt, authority} = input;
  const work = normalizedRecoveredWork(input.work);
  assertRecoveredIdentity(record, work);
  if (record.idempotencyKey.startsWith("st-processor-v2:")) {
    const bound = currentBoundPlan(work, authority);
    try {
      if (bound.idempotencyKey !== record.idempotencyKey || !equalBytes(bound.identity, record.workIdentityHash)) {
        throw new ProtectedStenographerWorkCompositionError("stale_authority", "Current signed authority changed");
      }
    } finally {bound.identity.fill(0);}
  }
  if (record.snapshot.formatVersion !== 2 || record.snapshot.credentialSubject.kind !== "processor"
    || authority.namespace.domainId !== record.domainId
    || authority.namespace.namespaceId !== work.claim.namespaceId || authority.namespace.roomId !== work.claim.roomId
    || authority.namespace.namespaceAccessRevision !== record.expectedNamespaceAccessRevision
    || authority.policyRevision !== record.expectedPolicyRevision
    || attempt.requestId !== record.snapshot.requestId || attempt.workId !== record.snapshot.workId
    || attempt.namespaceId !== record.snapshot.namespaceId || attempt.recipientGeneration !== record.snapshot.recipientGeneration) {
    throw new ProtectedStenographerWorkCompositionError("stale_authority", "Current background authority changed");
  }
  const exactRange = range(work);
  const inputObjectIds = orderedUnique(work.claim.inputObjectIds);
  const outputObjectIds = outputIds(work);
  return {formatVersion: 2, requestId: record.snapshot.requestId, recipientGeneration: record.snapshot.recipientGeneration,
    workKind: work.claim.workKind, workId: work.claim.workId,
    anchorNamespaceId: authority.namespace.namespaceId, anchorDomainId: authority.namespace.domainId,
    subject: {kind: "processor", processorKind: "stenographer", processorVersion: 1},
    operations: [...(inputObjectIds.length > 0 ? ["decrypt" as const] : []),
      ...(outputObjectIds.length > 0 ? ["encrypt" as const] : [])],
    purpose: purpose(work.claim.workKind), authority: authority.namespace, policyRevision: authority.policyRevision,
    source: {kind: "stenographer_work", startSequence: exactRange.start, endSequence: exactRange.end, rebuildGeneration: work.claim.rebuildGeneration,
      fingerprint: descriptorSourceFingerprint(work)},
    inputBindings: inputObjectIds.map(objectId => ({objectId, namespaceId: authority.namespace.namespaceId})),
    outputSlots: outputObjectIds.map(id => ({objectId: id,
      objectType: work.claim.kind === "extraction" ? REFLECTION_RECORD_CRYPTO_OBJECT_TYPE : "room_event_rollup",
      createdAt: timestamp(work.claim.createdAt), namespaceIds: [authority.namespace.namespaceId]})),
    maximumPlaintextBytes: PROTECTED_STENOGRAPHER_DESCRIPTOR_PLAINTEXT_BUDGET,
    maximumCiphertextBytes: PROTECTED_STENOGRAPHER_DESCRIPTOR_CIPHERTEXT_BUDGET,
    recipientKeyId: attempt.recipientKeyId, recipientPublicKey: Uint8Array.from(attempt.recipientPublicKey),
    issuedAt: input.now, notBefore: input.now, expiresAt: attempt.expiresAt, idempotencyId: record.idempotencyKey};
}

export function createCurrentProtectedStenographerDescriptorFactory(options: Readonly<{
  crypto: DescriptorCrypto; recovery: ProtectedStenographerDurableWorkRecoveryPort;
  resolveCurrentAuthority(record: BackgroundAuthorizationRecord): Promise<CurrentProtectedStenographerAuthority | null>;
  now(): number;
}>): ProtectedStenographerBackgroundDescriptorFactory {
  return {create: async ({record, attempt}) => {
    const authority = await options.resolveCurrentAuthority(record);
    if (authority === null) throw new ProtectedStenographerWorkCompositionError("stale_authority", "Current authority unavailable");
    const now = options.now();
    const recovered = await options.recovery.recoverExact({record, descriptor: null, now: new Date(now)});
    if (recovered.status !== "recovered") throw new ProtectedStenographerWorkCompositionError("stale_work", "Current source unavailable");
    const descriptor = currentDescriptorFor({record, attempt, work: recovered.work, authority, now});
    const descriptorBytes = encodeBackgroundWorkDescriptorV2(descriptor);
    return {descriptorBytes, descriptorHash: options.crypto.hash(descriptorBytes)};
  }};
}

function assertCurrentDescriptorMatchesRecord(descriptor: BackgroundProcessorWorkDescriptorV2, record: BackgroundAuthorizationRecord): void {
  const recipient = record.snapshot.recipient;
  const recipientMatches = recipient === null
    ? ((record.snapshot.state === "publication_reconciliation" || record.snapshot.state === "completed")
      && record.snapshot.acceptedResponse?.recipientGeneration === descriptor.recipientGeneration)
    : recipient.recipientKeyId === descriptor.recipientKeyId
      && recipient.recipientPublicKey === Buffer.from(descriptor.recipientPublicKey).toString("base64url")
      && recipient.expiresAt === descriptor.expiresAt;
  if (record.snapshot.formatVersion !== 2 || record.snapshot.credentialSubject.kind !== "processor"
    || descriptor.requestId !== record.snapshot.requestId
    || descriptor.recipientGeneration !== record.snapshot.recipientGeneration || descriptor.workId !== record.snapshot.workId
    || descriptor.workKind !== record.workKind || descriptor.purpose !== record.purpose
    || descriptor.anchorNamespaceId !== record.snapshot.namespaceId || descriptor.anchorDomainId !== record.domainId
    || descriptor.authority.namespaceId !== record.snapshot.namespaceId || descriptor.authority.domainId !== record.domainId
    || descriptor.authority.namespaceAccessRevision !== record.expectedNamespaceAccessRevision
    || descriptor.policyRevision !== record.expectedPolicyRevision || descriptor.idempotencyId !== record.idempotencyKey
    || !recipientMatches) throw new ProtectedStenographerWorkCompositionError("descriptor_mismatch", "Current descriptor differs from durable work");
}

function assertCurrentDescriptorMatchesRecoveredWork(descriptor: BackgroundProcessorWorkDescriptorV2,
  record: BackgroundAuthorizationRecord, work: ProtectedStenographerRecoveredWork): void {
  assertRecoveredIdentity(record, work);
  if (record.idempotencyKey.startsWith("st-processor-v2:")) {
    const bound = currentBoundPlan(work, {namespace: descriptor.authority, policyRevision: descriptor.policyRevision});
    try {
      if (bound.idempotencyKey !== record.idempotencyKey || !equalBytes(bound.identity, record.workIdentityHash)) {
        throw new ProtectedStenographerWorkCompositionError("descriptor_mismatch", "Signed authority differs from current execution plan");
      }
    } finally {bound.identity.fill(0);}
  }
  const expectedRange = range(work);
  const fingerprint = descriptorSourceFingerprint(work);
  const ids = outputIds(work);
  const inputs = orderedUnique(work.claim.inputObjectIds);
  try {
    if (descriptor.authority.roomId !== work.claim.roomId
      || descriptor.source.startSequence !== expectedRange.start || descriptor.source.endSequence !== expectedRange.end
      || descriptor.source.rebuildGeneration !== work.claim.rebuildGeneration || !equalBytes(descriptor.source.fingerprint, fingerprint)
      || descriptor.maximumPlaintextBytes !== PROTECTED_STENOGRAPHER_DESCRIPTOR_PLAINTEXT_BUDGET
      || descriptor.maximumCiphertextBytes !== PROTECTED_STENOGRAPHER_DESCRIPTOR_CIPHERTEXT_BUDGET
      || descriptor.inputBindings.length !== inputs.length || descriptor.inputBindings.some((binding, index) => binding.objectId !== inputs[index]
        || binding.namespaceId !== record.snapshot.namespaceId)
      || descriptor.outputSlots.length !== ids.length || descriptor.outputSlots.some((slot, index) => slot.objectId !== ids[index]
        || slot.objectType !== (work.claim.kind === "extraction" ? REFLECTION_RECORD_CRYPTO_OBJECT_TYPE : "room_event_rollup")
        || slot.createdAt !== timestamp(work.claim.createdAt)
        || slot.namespaceIds.length !== 1 || slot.namespaceIds[0] !== record.snapshot.namespaceId)) {
      throw new ProtectedStenographerWorkCompositionError("stale_work", "Current descriptor source or output slots changed");
    }
  } finally {fingerprint.fill(0);}
}

export type ProtectedStenographerRecoveredExecutionWork =
  | Readonly<{
    readonly status: "recovered";
    readonly claim: ProtectedStenographerExtractionWorkClaim;
    readonly work: ProtectedStenographerExtractionWork;
  }>
  | Readonly<{
    readonly status: "recovered";
    readonly claim: ProtectedStenographerCompactionWorkClaim;
    readonly work: ProtectedStenographerCompactionWork;
  }>
  | Readonly<{
    readonly status: "missing" | "leased" | "stale";
  }>;

/**
 * Rebuilds executable work solely from the durable request/descriptor and a
 * freshly recovered product claim. No process-local scheduler state crosses
 * this boundary.
 */
/** Metadata-only handoff check. This does not restore recipient or execution authority. */
export function assertCancelledProtectedStenographerWorkIdentity(input: Readonly<{
  record: BackgroundAuthorizationRecord;
  work: ProtectedStenographerRecoveredWork;
}>): void {
  const record = parseBackgroundAuthorizationRecord(input.record);
  if (record.snapshot.formatVersion !== 2
    || record.snapshot.credentialSubject.kind !== "processor"
    || record.snapshot.state !== "cancelled"
    || record.snapshot.terminalReason !== "cancelled"
    || record.snapshot.acceptedResponse !== null || record.acceptedMaterial !== null
    || record.snapshot.claimId !== null || record.snapshot.recipient !== null) {
    throw new ProtectedStenographerWorkCompositionError("stale_work", "Cancelled unconsumed Stenographer work is required");
  }
  assertRecoveredIdentity(record, normalizedRecoveredWork(input.work));
}

/** Release-only coordinates: a cancelled compaction has no model authority to
 * restore. Its current product lease is separately checked under the policy
 * fence; changing the configured model must not poison this terminal handoff. */
export function assertCancelledProtectedStenographerFallbackCoordinates(input: Readonly<{
  record: BackgroundAuthorizationRecord; work: ProtectedStenographerRecoveredWork;
}>): void {
  const record = parseBackgroundAuthorizationRecord(input.record);
  const work = normalizedRecoveredWork(input.work);
  if (record.snapshot.formatVersion !== 2 || record.snapshot.credentialSubject.kind !== "processor"
    || record.snapshot.state !== "cancelled" || record.snapshot.terminalReason !== "cancelled"
    || record.snapshot.acceptedResponse !== null || record.acceptedMaterial !== null
    || record.snapshot.claimId !== null || record.snapshot.recipient !== null
    || work.claim.kind !== "compaction" || record.workKind !== "stenographer.compaction"
    || record.purpose !== "journal.compact" || record.snapshot.namespaceId !== work.claim.namespaceId
    || record.snapshot.workId !== work.claim.workId) {
    throw new ProtectedStenographerWorkCompositionError("stale_work", "Cancelled compaction release coordinates changed");
  }
}

export async function recoverProtectedStenographerExecutionWork(
  input: Readonly<{
    readonly record: BackgroundAuthorizationRecord;
    readonly recovery: ProtectedStenographerDurableWorkRecoveryPort;
    readonly now: Date;
  }>,
): Promise<ProtectedStenographerRecoveredExecutionWork> {
  const record = parseBackgroundAuthorizationRecord(input.record);
  if (
    record.descriptorBytes === null
    || record.snapshot.descriptorDigest === null
  ) {
    throw new ProtectedStenographerWorkCompositionError(
      "descriptor_mismatch",
      "durable protected Stenographer descriptor is absent",
    );
  }
  const actualDigest = descriptorHash(record.descriptorBytes);
  try {
    if (
      Buffer.from(actualDigest).toString("hex")
      !== record.snapshot.descriptorDigest
    ) {
      throw new ProtectedStenographerWorkCompositionError(
        "descriptor_mismatch",
        "durable protected Stenographer descriptor digest is invalid",
      );
    }
  } finally {
    actualDigest.fill(0);
  }
  const descriptor = record.snapshot.formatVersion === 2
      && record.snapshot.credentialSubject.kind === "processor"
    ? decodeBackgroundProcessorWorkDescriptorV2(record.descriptorBytes)
    : decodeBackgroundWorkDescriptorV1(record.descriptorBytes);
  if (record.snapshot.formatVersion === 2
    && record.snapshot.credentialSubject.kind === "processor") assertCurrentDescriptorMatchesRecord(descriptor as BackgroundProcessorWorkDescriptorV2, record);
  else assertDescriptorMatchesRecord(descriptor as BackgroundWorkDescriptorV1, record);
  const recovered = await input.recovery.recoverExact({
    record,
    descriptor,
    now: new Date(input.now),
  });
  if (recovered.status !== "recovered") {
    return Object.freeze({ status: recovered.status });
  }
  const durableWork = normalizedRecoveredWork(recovered.work);
  if (record.snapshot.formatVersion === 2
    && record.snapshot.credentialSubject.kind === "processor") assertCurrentDescriptorMatchesRecoveredWork(descriptor as BackgroundProcessorWorkDescriptorV2, record, durableWork);
  else assertDescriptorMatchesRecoveredWork(descriptor as BackgroundWorkDescriptorV1, record, durableWork);
  const exactDescriptorHash =
    Uint8Array.from(Buffer.from(record.snapshot.descriptorDigest, "hex"));
  if (durableWork.claim.kind === "extraction") {
    const claim = durableWork.claim;
    return Object.freeze({
      status: "recovered" as const,
      claim,
      work: Object.freeze({
        requestId: record.snapshot.requestId,
        workId: claim.workId,
        workIdentityHash: record.workIdentityHash.slice(),
        descriptorHash: exactDescriptorHash,
        sourceBindingFingerprint:
          claim.sourceBindingFingerprint.slice(),
        requiresContentRecheck: claim.requiresContentRecheck,
        roomId: claim.roomId,
        namespaceId: claim.namespaceId,
        sourceBatchId: claim.sourceBatchId,
        rebuildGeneration: claim.rebuildGeneration,
        fromMessageIdExclusive: claim.fromMessageIdExclusive,
        throughMessageIdInclusive: claim.throughMessageIdInclusive,
        extractorVersion: claim.extractorVersion,
        createdAt: claim.createdAt,
        bindings: claim.bindings,
        outputSlots: claim.outputSlots,
      }),
    });
  }
  const claim = durableWork.claim;
  const compactionModelId = durableWork.compactionModelId;
  if (compactionModelId === null) {
    throw new ProtectedStenographerWorkCompositionError(
      "invalid_work",
      "compaction work lost its model identifier",
    );
  }
  return Object.freeze({
    status: "recovered" as const,
    claim,
    work: Object.freeze({
      requestId: record.snapshot.requestId,
      workId: claim.workId,
      workIdentityHash: record.workIdentityHash.slice(),
      descriptorHash: exactDescriptorHash,
      sourceBindingFingerprint: claim.sourceBindingFingerprint.slice(),
      roomId: claim.roomId,
      namespaceId: claim.namespaceId,
      rebuildGeneration: claim.rebuildGeneration,
      bindings: claim.bindings,
      rollupId: claim.outputSlot.rollupId,
      outputObjectId: claim.outputSlot.objectId,
      modelId: compactionModelId,
      compactorVersion: claim.compactorVersion,
      createdAt: claim.createdAt,
    }),
  });
}
