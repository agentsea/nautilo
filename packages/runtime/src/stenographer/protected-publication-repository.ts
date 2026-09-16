import {decodeStenographerOutputRepairPlan} from "@nautilo/lattice-bridge";
import { createHash } from "node:crypto";
import {
  and,
  count,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  reflectionRecords,
  rooms,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  roomEventRollups,
  roomEvents,
  roomJournalBatches,
  roomJournalCryptoPublications,
  roomJournalState,
  sql,
} from "@nautilo/db";
import {
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresExecutor,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresScalar,
  type ConversationProductPostgresTransaction,
} from "@nautilo/lattice-bridge/server";
import { assertRoomEventRollupPayloadBindingV1, decodeRoomEventRollupPayloadV1 } from "@nautilo/lattice-bridge";
import type { ProcessorTransformInput } from "@nautilo/lattice-crypto";
import {
  attachProtectedStenographerRecordsWithinTransaction,
  type ProtectedStenographerRecordCommitmentPort,
  type RecordSemanticCommitmentPort,
} from "@nautilo/reflection-bridge/server";

import {
  protectedJournalPublicationPlanMetadata,
  PROTECTED_JOURNAL_ATTACHMENT_PLAN_VERSION_V1,
  PROTECTED_JOURNAL_CONTENT_SENTINEL,
  PROTECTED_JOURNAL_MAX_OUTPUT_OBJECTS_V1,
  decodeProtectedJournalAttachmentPlanV1,
  type ProtectedJournalAttachmentPlanV1,
} from "./protected-journal-output-planner";
import {
  fingerprintProtectedStenographerCoveredRange,
  type ProtectedStenographerSourceMetadata,
} from "./protected-batch-planner";
import {
  PROTECTED_STENOGRAPHER_COMPACTION_MAX_EVENT_INPUTS,
} from "./protected-stenographer-compaction-planner";
import {
  fingerprintProtectedStenographerSourceBindings,
  type ProtectedStenographerSourceBinding,
} from "./protected-source-loader";

export const PROTECTED_JOURNAL_PUBLICATION_MAXIMUM_ATTEMPTS = 8;
export const PROTECTED_JOURNAL_PUBLICATION_LEASE_MS = 2 * 60_000;
export const PROTECTED_JOURNAL_PUBLICATION_MAX_RECONCILIATION_BATCH = 256;

const typedDb = conversationProductTypedDb;

export type ProtectedJournalPublicationState =
  | "reserved"
  | "crypto_committed"
  | "attached"
  | "quarantined"
  | "superseded"
  | "tombstone_pending"
  | "tombstoned";

export type ProtectedJournalPublicationFailureCode =
  | "stale_authority"
  | "crypto_publication_failed"
  | "mapping_conflict"
  | "attachment_failed"
  | "integrity_failure"
  | "rebuild_superseded"
  | "lease_lost"
  | "tombstone_failed";

export interface ProtectedJournalPublicationRecord {
  readonly publicationId: string;
  readonly requestId: string;
  readonly roomId: string;
  readonly namespaceIdAtAllocation: string;
  readonly workId: string;
  readonly sourceBatchId: string | null;
  readonly rebuildGeneration: number;
  readonly workIdentityHash: Uint8Array;
  readonly descriptorHash: Uint8Array;
  readonly attachmentPlanVersion: 1 | 2;
  readonly attachmentPlanHash: Uint8Array;
  readonly attachmentPlanBytes: Uint8Array;
  readonly outputObjectCount: number;
  readonly state: ProtectedJournalPublicationState;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly retryCount: number;
  readonly maximumAttempts:
    typeof PROTECTED_JOURNAL_PUBLICATION_MAXIMUM_ATTEMPTS;
  readonly failureCode: ProtectedJournalPublicationFailureCode | null;
  readonly lastFailureAt: Date | null;
  readonly cryptoCommittedAt: Date | null;
  readonly attachedAt: Date | null;
  readonly tombstoneRequestedAt: Date | null;
  readonly tombstonedAt: Date | null;
  readonly lastAuditedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ReserveProtectedJournalPublicationInput {
  readonly publicationId: string;
  readonly requestId: string;
  readonly workId: string;
  readonly workIdentityHash: Uint8Array;
  readonly descriptorHash: Uint8Array;
  readonly attachmentPlanHash: Uint8Array;
  readonly attachmentPlanBytes: Uint8Array;
  readonly now: Date;
}

export interface ReserveCurrentProtectedJournalPublicationInput
  extends ReserveProtectedJournalPublicationInput {
  readonly publicationLeaseToken: string;
  readonly sourceLeaseToken: string;
  readonly sourceBindingFingerprint: Uint8Array;
  readonly sourceBindings: readonly ProtectedStenographerSourceBinding[];
  readonly source:
    | Readonly<{
      readonly kind: "extraction";
      readonly lane: "live" | "historical";
      readonly rebuildTargetMessageId?: number;
      readonly fromMessageIdExclusive: number;
      readonly throughMessageIdInclusive: number;
      readonly extractorVersion: string;
      readonly coveredRangeFingerprint: Uint8Array;
    }>
    | Readonly<{
      readonly kind: "compaction";
      readonly activeEventCount: number;
      readonly selectedEventCount: number;
      readonly hasDeferredMiddle: boolean;
    }>;
}

export interface AttachCurrentProtectedJournalPublicationInput {
  readonly publicationId: string;
  readonly leaseToken: string;
  readonly sourceLeaseToken: string;
  readonly sourceBindingFingerprint: Uint8Array;
  readonly sourceBindings: readonly ProtectedStenographerSourceBinding[];
  readonly source: ReserveCurrentProtectedJournalPublicationInput["source"];
  readonly now: Date;
}

export class ProtectedJournalPublicationConflictError extends Error {
  constructor(message: "reservation_conflict" | "mapping_conflict") {
    super(message);
    this.name = "ProtectedJournalPublicationConflictError";
  }
}

export type ProtectedJournalPublicationReserveResult =
  | Readonly<{
    readonly status: "created";
    readonly record: ProtectedJournalPublicationRecord;
  }>
  | Readonly<{
    readonly status: "existing";
    readonly record: ProtectedJournalPublicationRecord;
  }>;

export type ProtectedJournalPublicationCurrentReserveResult =
  | Readonly<{
    readonly status: "claimed" | "existing";
    readonly record: ProtectedJournalPublicationRecord;
  }>
  | Readonly<{
    readonly status: "busy" | "stale";
    readonly record?: ProtectedJournalPublicationRecord;
  }>;

export type ProtectedJournalPublicationClaimResult =
  | Readonly<{
    readonly status: "claimed";
    readonly record: ProtectedJournalPublicationRecord;
  }>
  | Readonly<{
    readonly status: "missing" | "busy" | "terminal";
    readonly record?: ProtectedJournalPublicationRecord;
  }>;

export type ProtectedJournalCryptoCommitResult =
  | Readonly<{
    readonly status: "committed" | "duplicate";
    readonly record: ProtectedJournalPublicationRecord;
  }>
  | Readonly<{
    readonly status: "missing" | "lease_lost";
    readonly record?: ProtectedJournalPublicationRecord;
  }>;

export type ProtectedJournalAttachmentResult =
  | Readonly<{
    readonly status:
      | "attached"
      | "duplicate"
      | "crypto_not_committed"
      | "lease_lost"
      | "stale_reconcile"
      | "quarantined"
      | "retry"
      | "terminal";
    readonly record: ProtectedJournalPublicationRecord;
  }>
  | Readonly<{ readonly status: "missing" }>;

export type ProtectedJournalFailureResult =
  | Readonly<{
    readonly status: "retry" | "terminal";
    readonly record: ProtectedJournalPublicationRecord;
  }>
  | Readonly<{
    readonly status: "missing" | "lease_lost";
    readonly record?: ProtectedJournalPublicationRecord;
  }>;

export type ProtectedJournalReservedAbandonResult =
  | Readonly<{
    readonly status: "abandoned" | "duplicate";
    readonly record: ProtectedJournalPublicationRecord;
  }>
  | Readonly<{
    readonly status: "missing" | "lease_lost" | "unavailable";
    readonly record?: ProtectedJournalPublicationRecord;
  }>;

export type ProtectedJournalTombstoneRequestResult =
  | Readonly<{
    readonly status: "requested" | "duplicate" | "unavailable";
    readonly record: ProtectedJournalPublicationRecord;
  }>
  | Readonly<{ readonly status: "missing" }>;

export type ProtectedJournalTombstoneResult =
  | Readonly<{
    readonly status: "tombstoned" | "duplicate";
    readonly record: ProtectedJournalPublicationRecord;
  }>
  | Readonly<{
    readonly status: "missing" | "lease_lost" | "unavailable";
    readonly record?: ProtectedJournalPublicationRecord;
  }>;

const PUBLICATION_COLUMNS = `
  publication_id, request_id, room_id, namespace_id_at_allocation,
  work_id, source_batch_id, rebuild_generation, work_identity_hash,
  descriptor_hash, attachment_plan_version, attachment_plan_hash,
  attachment_plan_bytes, output_object_count, state, lease_token,
  lease_expires_at, retry_count, maximum_attempts, failure_code,
  last_failure_at, crypto_committed_at, attached_at,
  tombstone_requested_at, tombstoned_at, last_audited_at,
  created_at, updated_at
`;

const PUBLICATION_RETURNING = {
  publication_id: roomJournalCryptoPublications.publicationId,
  request_id: roomJournalCryptoPublications.requestId,
  room_id: roomJournalCryptoPublications.roomId,
  namespace_id_at_allocation:
    roomJournalCryptoPublications.namespaceIdAtAllocation,
  work_id: roomJournalCryptoPublications.workId,
  source_batch_id: roomJournalCryptoPublications.sourceBatchId,
  rebuild_generation: roomJournalCryptoPublications.rebuildGeneration,
  work_identity_hash: roomJournalCryptoPublications.workIdentityHash,
  descriptor_hash: roomJournalCryptoPublications.descriptorHash,
  attachment_plan_version:
    roomJournalCryptoPublications.attachmentPlanVersion,
  attachment_plan_hash: roomJournalCryptoPublications.attachmentPlanHash,
  attachment_plan_bytes: roomJournalCryptoPublications.attachmentPlanBytes,
  output_object_count: roomJournalCryptoPublications.outputObjectCount,
  state: roomJournalCryptoPublications.state,
  lease_token: roomJournalCryptoPublications.leaseToken,
  lease_expires_at: roomJournalCryptoPublications.leaseExpiresAt,
  retry_count: roomJournalCryptoPublications.retryCount,
  maximum_attempts: roomJournalCryptoPublications.maximumAttempts,
  failure_code: roomJournalCryptoPublications.failureCode,
  last_failure_at: roomJournalCryptoPublications.lastFailureAt,
  crypto_committed_at: roomJournalCryptoPublications.cryptoCommittedAt,
  attached_at: roomJournalCryptoPublications.attachedAt,
  tombstone_requested_at:
    roomJournalCryptoPublications.tombstoneRequestedAt,
  tombstoned_at: roomJournalCryptoPublications.tombstonedAt,
  last_audited_at: roomJournalCryptoPublications.lastAuditedAt,
  created_at: roomJournalCryptoPublications.createdAt,
  updated_at: roomJournalCryptoPublications.updatedAt,
} as const;

const PUBLICATION_ROW_FIELDS = [
  "publication_id",
  "request_id",
  "room_id",
  "namespace_id_at_allocation",
  "work_id",
  "source_batch_id",
  "rebuild_generation",
  "work_identity_hash",
  "descriptor_hash",
  "attachment_plan_version",
  "attachment_plan_hash",
  "attachment_plan_bytes",
  "output_object_count",
  "state",
  "lease_token",
  "lease_expires_at",
  "retry_count",
  "maximum_attempts",
  "failure_code",
  "last_failure_at",
  "crypto_committed_at",
  "attached_at",
  "tombstone_requested_at",
  "tombstoned_at",
  "last_audited_at",
  "created_at",
  "updated_at",
] as const;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const STATES = new Set<ProtectedJournalPublicationState>([
  "reserved",
  "crypto_committed",
  "attached",
  "quarantined",
  "superseded",
  "tombstone_pending",
  "tombstoned",
]);
const FAILURE_CODES = new Set<ProtectedJournalPublicationFailureCode>([
  "stale_authority",
  "crypto_publication_failed",
  "mapping_conflict",
  "attachment_failed",
  "integrity_failure",
  "rebuild_superseded",
  "lease_lost",
  "tombstone_failed",
]);

type ProductExecutor = ConversationProductPostgresExecutor;
type ProtectedExtractionAttachmentPlan =
  ProtectedJournalAttachmentPlanV1 & Readonly<{
    readonly kind: "extraction";
    readonly sourceBatchId: string;
    readonly rollup: null;
  }>;
type ProtectedRollupAttachmentPlan =
  ProtectedJournalAttachmentPlanV1 & Readonly<{
    readonly kind: "rollup";
    readonly sourceBatchId: null;
    readonly rollup: NonNullable<
      ProtectedJournalAttachmentPlanV1["rollup"]
    >;
  }>;

function strictRecord(
  label: string,
  value: unknown,
  fields: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Reflect.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function checkStrictRecord(
  label: string,
  value: unknown,
  fields: readonly string[],
): void {
  strictRecord(label, value, fields);
}

function portableId(label: string, value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || !PORTABLE_ID.test(value)
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

function uuid(label: string, value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function integer(
  label: string,
  value: unknown,
  minimum: number,
  maximum = 2_147_483_647,
): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) throw new RangeError(`${label} is out of bounds`);
  return value as number;
}

function date(label: string, value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} is invalid`);
  }
  return new Date(value);
}

/** Drizzle's owned postgres-js pool returns raw timestamp strings on its bridge. */
function rowDate(label: string, value: unknown): Date {
  return date(label, typeof value === "string" ? new Date(value) : value);
}

function nullableDate(label: string, value: unknown): Date | null {
  return value === null ? null : rowDate(label, value);
}

function bytes32(label: string, value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(`${label} must be 32 bytes`);
  }
  return value.slice();
}

function bytes(label: string, value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length < 1) {
    throw new TypeError(`${label} must be non-empty bytes`);
  }
  return value.slice();
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function digest(value: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(value).digest());
}

function expectedOutputObjectIds(
  plan: ProtectedJournalAttachmentPlanV1,
): readonly string[] {
  return plan.kind === "extraction"
    ? Object.freeze(plan.events.map((event) => event.objectId))
    : Object.freeze([plan.rollup!.objectId]);
}

function assertRepositoryPlanCoherence(
  plan: ProtectedJournalAttachmentPlanV1,
): void {
  if (plan.kind !== "extraction") return;
  if (
    plan.sourceBatchId === null
    || plan.events.some((event) =>
      event.sourceBatchId !== plan.sourceBatchId
    )
    || new Set(plan.statusUpdates.map((update) => update.eventId)).size
      !== plan.statusUpdates.length
    || new Set(plan.events.map((event) => event.sequence)).size
      !== plan.events.length
    || new Set(plan.events.map((event) => event.batchLocalOrdinal)).size
      !== plan.events.length
    || plan.events.some((event, index) =>
      index > 0
      && (
        event.sequence <= plan.events[index - 1]!.sequence
        || event.batchLocalOrdinal
          <= plan.events[index - 1]!.batchLocalOrdinal
      )
    )
  ) {
    throw new TypeError(
      "protected journal extraction attachment plan is incoherent",
    );
  }
}

function state(value: unknown): ProtectedJournalPublicationState {
  if (typeof value !== "string" || !STATES.has(
    value as ProtectedJournalPublicationState,
  )) throw new TypeError("protected journal publication state is invalid");
  return value as ProtectedJournalPublicationState;
}

function failureCode(
  value: unknown,
): ProtectedJournalPublicationFailureCode | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || !FAILURE_CODES.has(value as ProtectedJournalPublicationFailureCode)
  ) throw new TypeError("protected journal publication failure is invalid");
  return value as ProtectedJournalPublicationFailureCode;
}

function publicationRow(
  value: ConversationProductDatabaseRow,
): ProtectedJournalPublicationRecord {
  strictRecord(
    "protected journal publication row",
    value,
    PUBLICATION_ROW_FIELDS,
  );
  const attachmentPlanBytes = bytes(
    "protected journal attachment plan",
    value["attachment_plan_bytes"],
  );
  const attachmentPlanHash = bytes32(
    "protected journal attachment plan hash",
    value["attachment_plan_hash"],
  );
  if (!bytesEqual(digest(attachmentPlanBytes), attachmentPlanHash)) {
    throw new TypeError("protected journal attachment plan hash is invalid");
  }
  const plan = protectedJournalPublicationPlanMetadata(attachmentPlanBytes);
  if (plan.version === 1) assertRepositoryPlanCoherence(decodeProtectedJournalAttachmentPlanV1(attachmentPlanBytes));
  const outputObjectCount = integer(
    "protected journal output count",
    value["output_object_count"],
    0,
    PROTECTED_JOURNAL_MAX_OUTPUT_OBJECTS_V1,
  );
  if (plan.outputObjectIds.length !== outputObjectCount) {
    throw new TypeError("protected journal output count does not match plan");
  }
  const roomId = uuid("protected journal Room", value["room_id"]);
  const namespaceId = uuid(
    "protected journal Namespace",
    value["namespace_id_at_allocation"],
  );
  const rebuildGeneration = integer(
    "protected journal rebuild generation",
    value["rebuild_generation"],
    0,
  );
  const sourceBatchId = value["source_batch_id"] === null
    ? null
    : uuid("protected journal source batch", value["source_batch_id"]);
  if (
    plan.roomId !== roomId
    || plan.namespaceId !== namespaceId
    || plan.rebuildGeneration !== rebuildGeneration
    || plan.sourceBatchId !== sourceBatchId
    || value["attachment_plan_version"]
      !== plan.version
  ) throw new TypeError("protected journal receipt and plan disagree");
  const leaseToken = value["lease_token"] === null
    ? null
    : uuid("protected journal lease token", value["lease_token"]);
  const leaseExpiresAt = nullableDate(
    "protected journal lease expiry",
    value["lease_expires_at"],
  );
  if ((leaseToken === null) !== (leaseExpiresAt === null)) {
    throw new TypeError("protected journal lease is incoherent");
  }
  const recordState = state(value["state"]);
  const failure = failureCode(value["failure_code"]);
  const lastFailureAt = nullableDate(
    "protected journal last failure",
    value["last_failure_at"],
  );
  if ((failure === null) !== (lastFailureAt === null)) {
    throw new TypeError("protected journal failure is incoherent");
  }
  const cryptoCommittedAt = nullableDate(
    "protected journal crypto commit",
    value["crypto_committed_at"],
  );
  const attachedAt = nullableDate(
    "protected journal attachment",
    value["attached_at"],
  );
  const tombstoneRequestedAt = nullableDate(
    "protected journal tombstone request",
    value["tombstone_requested_at"],
  );
  const tombstonedAt = nullableDate(
    "protected journal tombstone",
    value["tombstoned_at"],
  );
  const createdAt = rowDate("protected journal creation", value["created_at"]);
  const updatedAt = rowDate("protected journal update", value["updated_at"]);
  const stateIsCoherent =
    recordState === "reserved"
      ? cryptoCommittedAt === null
        && attachedAt === null
        && tombstoneRequestedAt === null
        && tombstonedAt === null
      : recordState === "crypto_committed"
      ? cryptoCommittedAt !== null
        && attachedAt === null
        && tombstoneRequestedAt === null
        && tombstonedAt === null
      : recordState === "attached"
      ? cryptoCommittedAt !== null
        && attachedAt !== null
        && tombstoneRequestedAt === null
        && tombstonedAt === null
      : recordState === "tombstone_pending"
      ? cryptoCommittedAt !== null
        && tombstoneRequestedAt !== null
        && tombstonedAt === null
      : recordState === "tombstoned"
      ? cryptoCommittedAt !== null
        && tombstoneRequestedAt !== null
        && tombstonedAt !== null
      : recordState === "superseded"
      ? cryptoCommittedAt === null
        && attachedAt === null
        && tombstoneRequestedAt === null
        && tombstonedAt === null
      : attachedAt === null
        && tombstoneRequestedAt === null
        && tombstonedAt === null
        && failure !== null;
  if (
    !stateIsCoherent
    || createdAt.getTime() > updatedAt.getTime()
    || (
      cryptoCommittedAt !== null
      && createdAt.getTime() > cryptoCommittedAt.getTime()
    )
    || (
      attachedAt !== null
      && (
        cryptoCommittedAt === null
        || cryptoCommittedAt.getTime() > attachedAt.getTime()
      )
    )
    || (
      tombstoneRequestedAt !== null
      && (
        cryptoCommittedAt === null
        || cryptoCommittedAt.getTime() > tombstoneRequestedAt.getTime()
        || (
          attachedAt !== null
          && attachedAt.getTime() > tombstoneRequestedAt.getTime()
        )
      )
    )
    || (
      tombstonedAt !== null
      && (
        tombstoneRequestedAt === null
        || tombstoneRequestedAt.getTime() > tombstonedAt.getTime()
      )
    )
  ) {
    throw new TypeError("protected journal publication lifecycle is incoherent");
  }
  return Object.freeze({
    publicationId: portableId(
      "protected journal publication",
      value["publication_id"],
    ),
    requestId: portableId(
      "protected journal request",
      value["request_id"],
    ),
    roomId,
    namespaceIdAtAllocation: namespaceId,
    workId: portableId("protected journal work", value["work_id"]),
    sourceBatchId,
    rebuildGeneration,
    workIdentityHash: bytes32(
      "protected journal work identity",
      value["work_identity_hash"],
    ),
    descriptorHash: bytes32(
      "protected journal descriptor",
      value["descriptor_hash"],
    ),
    attachmentPlanVersion: plan.version,
    attachmentPlanHash,
    attachmentPlanBytes,
    outputObjectCount,
    state: recordState,
    leaseToken,
    leaseExpiresAt,
    retryCount: integer(
      "protected journal retry count",
      value["retry_count"],
      0,
      PROTECTED_JOURNAL_PUBLICATION_MAXIMUM_ATTEMPTS,
    ),
    maximumAttempts: integer(
      "protected journal maximum attempts",
      value["maximum_attempts"],
      PROTECTED_JOURNAL_PUBLICATION_MAXIMUM_ATTEMPTS,
      PROTECTED_JOURNAL_PUBLICATION_MAXIMUM_ATTEMPTS,
    ) as typeof PROTECTED_JOURNAL_PUBLICATION_MAXIMUM_ATTEMPTS,
    failureCode: failure,
    lastFailureAt,
    cryptoCommittedAt,
    attachedAt,
    tombstoneRequestedAt,
    tombstonedAt,
    lastAuditedAt: nullableDate(
      "protected journal audit",
      value["last_audited_at"],
    ),
    createdAt,
    updatedAt,
  });
}

function parseReservation(
  value: ReserveProtectedJournalPublicationInput,
): Readonly<{
  readonly publicationId: string;
  readonly requestId: string;
  readonly workId: string;
  readonly workIdentityHash: Uint8Array;
  readonly descriptorHash: Uint8Array;
  readonly attachmentPlanHash: Uint8Array;
  readonly attachmentPlanBytes: Uint8Array;
  readonly plan: ProtectedJournalAttachmentPlanV1;
  readonly outputObjectCount: number;
  readonly now: Date;
}> {
  strictRecord("protected journal reservation", value, [
    "publicationId",
    "requestId",
    "workId",
    "workIdentityHash",
    "descriptorHash",
    "attachmentPlanHash",
    "attachmentPlanBytes",
    "now",
  ]);
  const attachmentPlanBytes = bytes(
    "protected journal attachment plan",
    value.attachmentPlanBytes,
  );
  const attachmentPlanHash = bytes32(
    "protected journal attachment plan hash",
    value.attachmentPlanHash,
  );
  if (!bytesEqual(digest(attachmentPlanBytes), attachmentPlanHash)) {
    attachmentPlanBytes.fill(0);
    attachmentPlanHash.fill(0);
    throw new TypeError("protected journal attachment plan hash is invalid");
  }
  const plan = decodeProtectedJournalAttachmentPlanV1(attachmentPlanBytes);
  assertRepositoryPlanCoherence(plan);
  const outputObjectCount = expectedOutputObjectIds(plan).length;
  if (
    outputObjectCount > PROTECTED_JOURNAL_MAX_OUTPUT_OBJECTS_V1
  ) {
    throw new RangeError("protected journal output object count is out of bounds");
  }
  return Object.freeze({
    publicationId: portableId(
      "protected journal publication",
      value.publicationId,
    ),
    requestId: portableId("protected journal request", value.requestId),
    workId: portableId("protected journal work", value.workId),
    workIdentityHash: bytes32(
      "protected journal work identity",
      value.workIdentityHash,
    ),
    descriptorHash: bytes32(
      "protected journal descriptor",
      value.descriptorHash,
    ),
    attachmentPlanHash,
    attachmentPlanBytes,
    plan,
    outputObjectCount,
    now: date("protected journal reservation time", value.now),
  });
}

function parseCurrentReservation(
  value: ReserveCurrentProtectedJournalPublicationInput,
): Readonly<{
  readonly reservation: ReturnType<typeof parseReservation>;
  readonly publicationLeaseToken: string;
  readonly sourceLeaseToken: string;
  readonly sourceBindingFingerprint: Uint8Array;
  readonly sourceBindings: readonly ProtectedStenographerSourceBinding[];
  readonly source: ReserveCurrentProtectedJournalPublicationInput["source"];
}> {
  const sourceBindingsValue:
    readonly ProtectedStenographerSourceBinding[] = value.sourceBindings;
  checkStrictRecord("current protected journal reservation", value, [
    "publicationId",
    "requestId",
    "workId",
    "workIdentityHash",
    "descriptorHash",
    "attachmentPlanHash",
    "attachmentPlanBytes",
    "publicationLeaseToken",
    "sourceLeaseToken",
    "sourceBindingFingerprint",
    "sourceBindings",
    "source",
    "now",
  ]);
  const reservation = parseReservation({
    publicationId: value.publicationId,
    requestId: value.requestId,
    workId: value.workId,
    workIdentityHash: value.workIdentityHash,
    descriptorHash: value.descriptorHash,
    attachmentPlanHash: value.attachmentPlanHash,
    attachmentPlanBytes: value.attachmentPlanBytes,
    now: value.now,
  });
  if (
    !Array.isArray(value.sourceBindings as unknown)
    || sourceBindingsValue.length > 256
    || new Set(sourceBindingsValue.map((binding) => binding.objectId)).size
      !== sourceBindingsValue.length
  ) {
    throw new TypeError(
      "protected journal current source inventory is invalid",
    );
  }
  const sourceBindings = Object.freeze([...sourceBindingsValue]);
  const sourceBindingFingerprint = bytes32(
    "protected journal source binding fingerprint",
    value.sourceBindingFingerprint,
  );
  const calculatedFingerprint =
    fingerprintProtectedStenographerSourceBindings(sourceBindings);
  if (!bytesEqual(calculatedFingerprint, sourceBindingFingerprint)) {
    calculatedFingerprint.fill(0);
    sourceBindingFingerprint.fill(0);
    throw new TypeError(
      "protected journal source binding fingerprint is invalid",
    );
  }
  calculatedFingerprint.fill(0);
  const source = value.source;
  let normalizedSource:
    ReserveCurrentProtectedJournalPublicationInput["source"];
  if (source.kind === "extraction") {
    strictRecord("protected journal extraction source", source, [
      "kind",
      "lane",
      "fromMessageIdExclusive",
      "throughMessageIdInclusive",
      "extractorVersion",
      "coveredRangeFingerprint",
      ...("rebuildTargetMessageId" in source ? ["rebuildTargetMessageId"] : []),
    ]);
    if (
      reservation.plan.kind !== "extraction"
      || (source.lane !== "live" && source.lane !== "historical")
    ) {
      throw new TypeError(
        "protected journal extraction source is inconsistent",
      );
    }
    integer(
      "protected journal extraction lower bound",
      source.fromMessageIdExclusive,
      0,
    );
    integer(
      "protected journal extraction upper bound",
      source.throughMessageIdInclusive,
      source.fromMessageIdExclusive,
    );
    portableId(
      "protected journal extraction version",
      source.extractorVersion,
    );
    normalizedSource = Object.freeze({
      kind: "extraction",
      lane: source.lane,
      ...(source.rebuildTargetMessageId === undefined ? {} : {
        rebuildTargetMessageId: integer("protected rebuild target", source.rebuildTargetMessageId, source.throughMessageIdInclusive),
      }),
      fromMessageIdExclusive: source.fromMessageIdExclusive,
      throughMessageIdInclusive: source.throughMessageIdInclusive,
      extractorVersion: source.extractorVersion,
      coveredRangeFingerprint: bytes32(
        "protected journal covered range fingerprint",
        source.coveredRangeFingerprint,
      ),
    });
  } else if (source.kind === "compaction") {
    strictRecord("protected journal compaction source", source, [
      "kind",
      "activeEventCount",
      "selectedEventCount",
      "hasDeferredMiddle",
    ]);
    if (reservation.plan.kind !== "rollup") {
      throw new TypeError(
        "protected journal compaction source is inconsistent",
      );
    }
    const activeEventCount = integer(
      "protected journal active event count",
      source.activeEventCount,
      0,
    );
    const selectedEventCount = integer(
      "protected journal selected event count",
      source.selectedEventCount,
      0,
      PROTECTED_STENOGRAPHER_COMPACTION_MAX_EVENT_INPUTS,
    );
    if (
      typeof source.hasDeferredMiddle !== "boolean"
      || selectedEventCount > activeEventCount
      || source.hasDeferredMiddle
        !== (activeEventCount > selectedEventCount)
    ) {
      throw new TypeError(
        "protected journal compaction selection facts are inconsistent",
      );
    }
    normalizedSource = Object.freeze({
      kind: "compaction",
      activeEventCount,
      selectedEventCount,
      hasDeferredMiddle: source.hasDeferredMiddle,
    });
  } else {
    throw new TypeError("protected journal source kind is invalid");
  }
  return Object.freeze({
    reservation,
    publicationLeaseToken: uuid(
      "protected journal publication lease token",
      value.publicationLeaseToken,
    ),
    sourceLeaseToken: uuid(
      "protected journal source lease token",
      value.sourceLeaseToken,
    ),
    sourceBindingFingerprint,
    sourceBindings,
    source: normalizedSource,
  });
}

function parseCurrentAttachment(
  value: AttachCurrentProtectedJournalPublicationInput,
): Readonly<{
  readonly publicationId: string;
  readonly leaseToken: string;
  readonly sourceLeaseToken: string;
  readonly sourceBindingFingerprint: Uint8Array;
  readonly sourceBindings: readonly ProtectedStenographerSourceBinding[];
  readonly source: ReserveCurrentProtectedJournalPublicationInput["source"];
  readonly now: Date;
}> {
  strictRecord("protected journal attachment", value, [
    "publicationId",
    "leaseToken",
    "sourceLeaseToken",
    "sourceBindingFingerprint",
    "sourceBindings",
    "source",
    "now",
  ]);
  const sourceBindings = Object.freeze([...value.sourceBindings]);
  const sourceBindingFingerprint = bytes32(
    "protected journal source binding fingerprint",
    value.sourceBindingFingerprint,
  );
  const calculated =
    fingerprintProtectedStenographerSourceBindings(sourceBindings);
  if (!bytesEqual(calculated, sourceBindingFingerprint)) {
    calculated.fill(0);
    sourceBindingFingerprint.fill(0);
    throw new TypeError(
      "protected journal source binding fingerprint is invalid",
    );
  }
  calculated.fill(0);
  let source: ReserveCurrentProtectedJournalPublicationInput["source"];
  if (value.source.kind === "extraction") {
    strictRecord("protected journal extraction source", value.source, [
      "kind",
      "lane",
      "fromMessageIdExclusive",
      "throughMessageIdInclusive",
      "extractorVersion",
      "coveredRangeFingerprint",
      ...("rebuildTargetMessageId" in value.source ? ["rebuildTargetMessageId"] : []),
    ]);
    if (
      value.source.lane !== "live"
      && value.source.lane !== "historical"
    ) throw new TypeError("protected journal extraction lane is invalid");
    source = Object.freeze({
      kind: "extraction",
      lane: value.source.lane,
      ...(value.source.rebuildTargetMessageId === undefined ? {} : {
        rebuildTargetMessageId: integer("protected rebuild target", value.source.rebuildTargetMessageId, value.source.throughMessageIdInclusive),
      }),
      fromMessageIdExclusive: integer(
        "protected journal extraction lower bound",
        value.source.fromMessageIdExclusive,
        0,
      ),
      throughMessageIdInclusive: integer(
        "protected journal extraction upper bound",
        value.source.throughMessageIdInclusive,
        value.source.fromMessageIdExclusive,
      ),
      extractorVersion: portableId(
        "protected journal extraction version",
        value.source.extractorVersion,
      ),
      coveredRangeFingerprint: bytes32(
        "protected journal covered range fingerprint",
        value.source.coveredRangeFingerprint,
      ),
    });
  } else {
    strictRecord("protected journal compaction source", value.source, [
      "kind",
      "activeEventCount",
      "selectedEventCount",
      "hasDeferredMiddle",
    ]);
    const activeEventCount = integer(
      "protected journal active event count",
      value.source.activeEventCount,
      0,
    );
    const selectedEventCount = integer(
      "protected journal selected event count",
      value.source.selectedEventCount,
      0,
      PROTECTED_STENOGRAPHER_COMPACTION_MAX_EVENT_INPUTS,
    );
    if (
      typeof value.source.hasDeferredMiddle !== "boolean"
      || selectedEventCount > activeEventCount
      || value.source.hasDeferredMiddle
        !== (activeEventCount > selectedEventCount)
    ) {
      throw new TypeError(
        "protected journal compaction selection facts are inconsistent",
      );
    }
    source = Object.freeze({
      kind: "compaction",
      activeEventCount,
      selectedEventCount,
      hasDeferredMiddle: value.source.hasDeferredMiddle,
    });
  }
  return Object.freeze({
    publicationId: portableId(
      "protected journal publication",
      value.publicationId,
    ),
    leaseToken: uuid("protected journal lease token", value.leaseToken),
    sourceLeaseToken: uuid(
      "protected journal source lease token",
      value.sourceLeaseToken,
    ),
    sourceBindingFingerprint,
    sourceBindings,
    source,
    now: date("protected journal attachment time", value.now),
  });
}

function sameReservation(
  record: ProtectedJournalPublicationRecord,
  input: ReturnType<typeof parseReservation>,
): boolean {
  return record.publicationId === input.publicationId
    && record.requestId === input.requestId
    && record.roomId === input.plan.roomId
    && record.namespaceIdAtAllocation === input.plan.namespaceId
    && record.workId === input.workId
    && record.sourceBatchId === input.plan.sourceBatchId
    && record.rebuildGeneration === input.plan.rebuildGeneration
    && bytesEqual(record.workIdentityHash, input.workIdentityHash)
    && bytesEqual(record.descriptorHash, input.descriptorHash)
    && bytesEqual(record.attachmentPlanHash, input.attachmentPlanHash)
    && bytesEqual(record.attachmentPlanBytes, input.attachmentPlanBytes)
    && record.outputObjectCount === input.outputObjectCount;
}

function sameDurableWorkCoordinates(
  record: ProtectedJournalPublicationRecord,
  input: ReturnType<typeof parseReservation>,
): boolean {
  return record.publicationId === input.publicationId
    && record.requestId === input.requestId
    && record.roomId === input.plan.roomId
    && record.namespaceIdAtAllocation === input.plan.namespaceId
    && record.workId === input.workId
    && record.sourceBatchId === input.plan.sourceBatchId
    && record.rebuildGeneration === input.plan.rebuildGeneration
    && bytesEqual(record.workIdentityHash, input.workIdentityHash);
}

function exactFields<Value extends Record<string, unknown>>(
  label: string,
  value: Value,
  fields: readonly (keyof Value & string)[],
): void {
  strictRecord(label, value, fields);
}

async function loadPublication(
  executor: ProductExecutor,
  publicationId: string,
  lock = false,
): Promise<ProtectedJournalPublicationRecord | null> {
  const rows = await executor.query(
    `SELECT ${PUBLICATION_COLUMNS}
      FROM room_journal_crypto_publications
      WHERE publication_id = $1
      LIMIT 2
      ${lock ? "FOR UPDATE" : ""}`,
    [publicationId],
  );
  if (rows.length > 1) {
    throw new Error("duplicate protected journal publication");
  }
  return rows.length === 0 ? null : publicationRow(rows[0]!);
}

function leaseIsCurrent(
  record: ProtectedJournalPublicationRecord,
  leaseToken: string,
  now: Date,
): boolean {
  return record.leaseToken === leaseToken
    && record.leaseExpiresAt !== null
    && record.leaseExpiresAt.getTime() > now.getTime();
}

function canonicalTimestamp(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (
    typeof value === "string"
    && Number.isFinite(Date.parse(value))
  ) {
    return new Date(value).toISOString();
  }
  return null;
}

function canonicalIntegerArray(value: unknown): readonly number[] | null {
  if (
    !Array.isArray(value)
    || value.some((item) => !Number.isSafeInteger(item) || item < 1)
  ) {
    return null;
  }
  return Object.freeze(value as number[]);
}

function exactSourceRow(
  rows: readonly ConversationProductDatabaseRow[],
  objectId: string,
): ConversationProductDatabaseRow | null {
  const matches = rows.filter((row) => row["crypto_object_id"] === objectId);
  return matches.length === 1 ? matches[0]! : null;
}

export interface CurrentSourceCheckInput {
  readonly roomId: string;
  readonly namespaceId: string;
  readonly rebuildGeneration: number;
  readonly sourceBatchId: string | null;
  readonly now: Date;
  readonly sourceLeaseToken: string;
  readonly sourceBindingFingerprint: Uint8Array;
  readonly sourceBindings: readonly ProtectedStenographerSourceBinding[];
  readonly source: ReserveCurrentProtectedJournalPublicationInput["source"];
}

async function sourceCoordinatesAreCurrent(
  transaction: ConversationProductPostgresTransaction,
  input: CurrentSourceCheckInput,
): Promise<boolean> {
  const coordinateRows = await transaction.query(
    `SELECT room.namespace_id::text AS namespace_id,
            state.rebuild_generation::int AS rebuild_generation,
            state.rebuild_requested_at,
            state.rebuild_target_message_id,
            state.last_processed_message_id,
            state.lease_token::text AS lease_token,
            state.lease_expires_at,
            state.compaction_lease_token::text AS compaction_lease_token,
            state.compaction_lease_expires_at
       FROM rooms AS room
       JOIN room_journal_state AS state ON state.room_id = room.id
      WHERE room.id = $1::uuid
      LIMIT 2
      FOR UPDATE OF room, state`,
    [input.roomId],
  );
  if (coordinateRows.length !== 1) return false;
  const coordinate = coordinateRows[0]!;
  const sourceLease = input.source.kind === "extraction"
    ? coordinate["lease_token"]
    : coordinate["compaction_lease_token"];
  const sourceLeaseExpiry = canonicalTimestamp(input.source.kind === "extraction"
    ? coordinate["lease_expires_at"]
    : coordinate["compaction_lease_expires_at"]);
  const rebuilding = input.source.kind === "extraction" && input.source.rebuildTargetMessageId !== undefined;
  const rebuildMatches = rebuilding
    ? canonicalTimestamp(coordinate["rebuild_requested_at"]) !== null
      && input.source.lane === "live"
      && coordinate["rebuild_target_message_id"] === input.source.rebuildTargetMessageId
      && input.source.rebuildTargetMessageId >= input.source.throughMessageIdInclusive
      && coordinate["last_processed_message_id"] === input.source.fromMessageIdExclusive
    : coordinate["rebuild_requested_at"] === null;
  if (
    coordinate["namespace_id"] !== input.namespaceId
    || coordinate["rebuild_generation"]
      !== input.rebuildGeneration
    || !rebuildMatches
    || sourceLease !== input.sourceLeaseToken
    || sourceLeaseExpiry === null
    || Date.parse(sourceLeaseExpiry) <= input.now.getTime()
  ) return false;

  if (input.source.kind !== "extraction") return true;
  const batchRows = await transaction.query(
    `SELECT id::text AS id,
            from_message_id_exclusive::int AS from_message_id_exclusive,
            through_message_id_inclusive::int
              AS through_message_id_inclusive,
            extractor_version,
            lane,
            status
       FROM room_journal_batches
      WHERE id = $1::uuid
        AND room_id = $2::uuid
      LIMIT 2
      FOR UPDATE`,
    [input.sourceBatchId, input.roomId],
  );
  if (batchRows.length !== 1) return false;
  const batch = batchRows[0]!;
  return batch["id"] === input.sourceBatchId
    && batch["from_message_id_exclusive"]
      === input.source.fromMessageIdExclusive
    && batch["through_message_id_inclusive"]
      === input.source.throughMessageIdInclusive
    && batch["extractor_version"] === input.source.extractorVersion
    && batch["lane"] === input.source.lane
    && batch["status"] === "running";
}

async function messageBindingsAreCurrent(
  transaction: ConversationProductPostgresTransaction,
  roomId: string,
  input: CurrentSourceCheckInput,
): Promise<boolean> {
  const messages = input.sourceBindings.filter(
    (binding) => binding.kind === "message",
  );
  if (messages.length === 0) return true;
  if (input.source.kind !== "extraction") return false;
  const source = input.source;
  const rows = await transaction.query(
    `SELECT message.crypto_object_id,
            message.id::int AS message_id,
            message.edit_revision::int AS edit_revision,
            message.created_at,
            message.role,
            CASE
              WHEN message.role = 'user' THEN human_actor.id::text
              ELSE COALESCE(agent_actor.id, human_actor.id)::text
            END AS participant_id
       FROM sessions AS session
       JOIN session_messages AS message ON message.session_id = session.id
       LEFT JOIN actors AS agent_actor
         ON agent_actor.agent_id = session.agent_id
        AND agent_actor.kind = 'agent'
       LEFT JOIN actors AS human_actor
         ON human_actor.owner_id = session.owner_id
        AND human_actor.kind = 'user'
      WHERE session.room_id = $1::uuid
        AND message.crypto_object_id = ANY($2::text[])
      ORDER BY message.crypto_object_id`,
    [
      roomId,
      `{${messages.map((binding) => binding.objectId).join(",")}}`,
    ],
  );
  if (rows.length !== messages.length) return false;
  return messages.every((binding) => {
    const row = exactSourceRow(rows, binding.objectId);
    const rangeIsCurrent = binding.source === "current"
      ? binding.messageId > source.fromMessageIdExclusive
        && binding.messageId <= source.throughMessageIdInclusive
      : binding.messageId <= source.fromMessageIdExclusive;
    return row !== null
      && row["message_id"] === binding.messageId
      && row["edit_revision"] === binding.editRevision
      && canonicalTimestamp(row["created_at"])
        === binding.createdAt.toISOString()
      && row["participant_id"] === binding.participantId
      && row["role"] === binding.role
      && rangeIsCurrent;
  });
}

async function eventBindingsAreCurrent(
  transaction: ConversationProductPostgresTransaction,
  roomId: string,
  bindings: readonly ProtectedStenographerSourceBinding[],
): Promise<boolean> {
  const events = bindings.filter((binding) => binding.kind === "event");
  if (events.length === 0) return true;
  const rows = await executeTypedConversationProductQuery(transaction, typedDb.select({
    crypto_object_id: sql<string | null>`CASE WHEN ${roomEvents.projectionKind} = 'native'
      THEN ${reflectionRecordPayloadRepresentations.cryptoObjectId} ELSE ${roomEvents.cryptoObjectId} END`.as("crypto_object_id"),
    event_id: sql<string>`${roomEvents.id}`.as("event_id"), room_id: roomEvents.roomId, namespace_id: rooms.namespaceId,
    sequence: roomEvents.sequence, kind: roomEvents.kind, status: roomEvents.status,
    supersedes_event_id: roomEvents.supersedesEventId, resolves_event_id: roomEvents.resolvesEventId,
    source_message_ids: roomEvents.sourceMessageIds, source_batch_id: roomEvents.sourceBatchId,
    batch_local_ordinal: roomEvents.batchLocalOrdinal, extractor_version: roomEvents.extractorVersion,
    created_at: roomEvents.createdAt, projection_kind: roomEvents.projectionKind,
    record_id: roomEvents.recordId, lifecycle: reflectionRecords.lifecycle,
    structural_height: reflectionRecords.structuralHeight, processing_generation: reflectionRecords.processingGeneration,
  }).from(roomEvents).innerJoin(rooms, eq(rooms.id, roomEvents.roomId))
    .leftJoin(reflectionRecords, eq(reflectionRecords.recordId, roomEvents.recordId))
    .leftJoin(reflectionRecordPayloadRepresentationHeads, and(
      eq(reflectionRecordPayloadRepresentationHeads.recordId, roomEvents.recordId),
      eq(reflectionRecordPayloadRepresentationHeads.representation, "protected")))
    .leftJoin(reflectionRecordPayloadRepresentations, and(
      eq(reflectionRecordPayloadRepresentations.recordId, roomEvents.recordId),
      eq(reflectionRecordPayloadRepresentations.representation, "protected"),
      eq(reflectionRecordPayloadRepresentations.representationGeneration,
        reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration)))
    .where(and(eq(roomEvents.roomId, roomId), inArray(roomEvents.id, events.map(event => event.binding.eventId))))
    .for("share", {of: roomEvents}));
  if (rows.length !== events.length) return false;
  return events.every((binding) => {
    const row = exactSourceRow(rows, binding.objectId);
    const sourceMessageIds =
      canonicalIntegerArray(row?.["source_message_ids"]);
    return row !== null
      && (binding.payloadFormat === "record_v1"
        ? row["projection_kind"] === "native" && row["record_id"] === binding.binding.eventId
          && binding.recordMetadata !== undefined && row["lifecycle"] === binding.recordMetadata.lifecycle
          && row["structural_height"] === binding.recordMetadata.structuralHeight
          && row["processing_generation"] === binding.recordMetadata.processingGeneration
        : row["projection_kind"] === "legacy")
      && row["event_id"] === binding.binding.eventId
      && row["room_id"] === binding.binding.roomId
      && row["namespace_id"] === binding.binding.namespaceId
      && row["sequence"] === binding.binding.sequence
      && row["kind"] === binding.binding.kind
      && row["status"] === binding.status
      && row["supersedes_event_id"] === binding.binding.supersedesEventId
      && row["resolves_event_id"] === binding.binding.resolvesEventId
      && sourceMessageIds !== null
      && sourceMessageIds.length === binding.binding.sourceMessageIds.length
      && sourceMessageIds.every(
        (id, index) => id === binding.binding.sourceMessageIds[index],
      )
      && row["source_batch_id"] === binding.binding.sourceBatchId
      && row["batch_local_ordinal"] === binding.binding.batchLocalOrdinal
      && row["extractor_version"] === binding.binding.extractorVersion
      && canonicalTimestamp(row["created_at"]) === binding.binding.createdAt;
  });
}

async function rollupBindingsAreCurrent(
  transaction: ConversationProductPostgresTransaction,
  roomId: string,
  bindings: readonly ProtectedStenographerSourceBinding[],
): Promise<boolean> {
  const rollups = bindings.filter((binding) => binding.kind === "rollup");
  if (rollups.length === 0) return true;
  const rows = await transaction.query(
    `SELECT rollup.crypto_object_id,
            rollup.id::text AS rollup_id,
            rollup.room_id::text AS room_id,
            room.namespace_id::text AS namespace_id,
            rollup.through_event_sequence::int AS through_event_sequence,
            rollup.source_event_count::int AS source_event_count,
            rollup.model_id,
            rollup.compactor_version,
            rollup.created_at
       FROM room_event_rollups AS rollup
       JOIN rooms AS room ON room.id = rollup.room_id
      WHERE rollup.room_id = $1::uuid
        AND rollup.crypto_object_id = ANY($2::text[])
      ORDER BY rollup.crypto_object_id
      FOR SHARE OF rollup`,
    [
      roomId,
      `{${rollups.map((binding) => binding.objectId).join(",")}}`,
    ],
  );
  if (rows.length !== rollups.length) return false;
  return rollups.every((binding) => {
    const row = exactSourceRow(rows, binding.objectId);
    return row !== null
      && row["rollup_id"] === binding.binding.rollupId
      && row["room_id"] === binding.binding.roomId
      && row["namespace_id"] === binding.binding.namespaceId
      && row["through_event_sequence"]
        === binding.binding.throughEventSequence
      && row["source_event_count"] === binding.binding.sourceEventCount
      && row["model_id"] === binding.binding.modelId
      && row["compactor_version"] === binding.binding.compactorVersion
      && canonicalTimestamp(row["created_at"]) === binding.binding.createdAt;
  });
}

async function sourceBindingsAreCurrent(
  transaction: ConversationProductPostgresTransaction,
  input: CurrentSourceCheckInput,
): Promise<boolean> {
  const roomId = input.roomId;
  return await messageBindingsAreCurrent(transaction, roomId, input)
    && await eventBindingsAreCurrent(
      transaction,
      roomId,
      input.sourceBindings,
    )
    && await rollupBindingsAreCurrent(
      transaction,
      roomId,
      input.sourceBindings,
    );
}

function nullableBoundedText(value: unknown): string | null {
  return value === null
    ? null
    : typeof value === "string" && value.length > 0 && value.length <= 256
    ? value
    : (() => {
      throw new TypeError("protected source metadata text is invalid");
    })();
}

function coveredMessageMetadata(
  row: ConversationProductDatabaseRow,
): ProtectedStenographerSourceMetadata {
  const createdAt = canonicalTimestamp(row["created_at"]);
  const role = row["role"];
  const transcriptOrigin = row["transcript_origin"];
  const keyClass = row["key_class"];
  const cryptoCompletion = row["crypto_completion"];
  if (
    createdAt === null
    || (
      role !== "user"
      && role !== "assistant"
      && role !== "tool"
      && role !== "system"
    )
    || (transcriptOrigin !== "main" && transcriptOrigin !== "subagent")
    || (keyClass !== null && keyClass !== "ai" && keyClass !== "human")
    || (
      cryptoCompletion !== null
      && cryptoCompletion !== "pending"
      && cryptoCompletion !== "complete"
    )
    || typeof row["excluded_from_evidence"] !== "boolean"
  ) {
    throw new TypeError("protected covered source metadata is invalid");
  }
  return Object.freeze({
    messageId: integer(
      "protected covered source message id",
      row["message_id"],
      1,
    ),
    editRevision: integer(
      "protected covered source edit revision",
      row["edit_revision"],
      0,
    ),
    createdAt: new Date(createdAt),
    role,
    fingerprint: nullableBoundedText(row["fingerprint"]),
    transcriptOrigin,
    originatedBy: nullableBoundedText(row["originated_by"]),
    excludedFromEvidence: row["excluded_from_evidence"],
    keyClass,
    cryptoObjectId: nullableBoundedText(row["crypto_object_id"]),
    cryptoCompletion,
  });
}

async function coveredRangeIsCurrent(
  transaction: ConversationProductPostgresTransaction,
  input: CurrentSourceCheckInput,
): Promise<boolean> {
  if (input.source.kind !== "extraction") return true;
  const rows = await transaction.query(
    `SELECT message.id::int AS message_id,
            message.edit_revision::int AS edit_revision,
            message.created_at,
            message.role,
            message.fingerprint,
            message.transcript_origin,
            message.metadata->>'originatedBy' AS originated_by,
            EXISTS (
              SELECT 1
                FROM room_silence_state AS silence
               WHERE silence.room_id = $1::uuid
                 AND silence.kind = 'deaf'
                 AND message.created_at >= silence.started_at
                 AND message.created_at <= silence.expires_at
            ) AS excluded_from_evidence,
            lifecycle.key_class,
            message.crypto_object_id,
            CASE
              WHEN lifecycle.crypto_object_id = message.crypto_object_id
                THEN lifecycle.completion
              ELSE NULL
            END AS crypto_completion
       FROM sessions AS session
       JOIN session_messages AS message ON message.session_id = session.id
       LEFT JOIN session_message_crypto_revisions AS lifecycle
         ON lifecycle.session_id = session.id
        AND lifecycle.message_id = message.id
        AND lifecycle.edit_revision = message.edit_revision
      WHERE session.room_id = $1::uuid
        AND message.id > $2::integer
        AND message.id <= $3::integer
      ORDER BY message.id
      LIMIT 257`,
    [
      input.roomId,
      input.source.fromMessageIdExclusive,
      input.source.throughMessageIdInclusive,
    ],
  );
  if (rows.length > 256) return false;
  let metadata: readonly ProtectedStenographerSourceMetadata[];
  try {
    metadata = Object.freeze(rows.map(coveredMessageMetadata));
  } catch {
    return false;
  }
  const fingerprint = fingerprintProtectedStenographerCoveredRange({
    fromMessageIdExclusive: input.source.fromMessageIdExclusive,
    throughMessageIdInclusive: input.source.throughMessageIdInclusive,
    rows: metadata,
  });
  try {
    return bytesEqual(
      fingerprint,
      input.source.coveredRangeFingerprint,
    );
  } finally {
    fingerprint.fill(0);
  }
}

async function compactionSelectionIsCurrent(
  transaction: ConversationProductPostgresTransaction,
  input: CurrentSourceCheckInput,
): Promise<boolean> {
  if (input.source.kind !== "compaction") return true;
  const rollups = input.sourceBindings.filter(
    (binding) => binding.kind === "rollup",
  );
  const events = input.sourceBindings.filter(
    (binding) => binding.kind === "event",
  );
  if (
    input.sourceBindings.some((binding) => binding.kind === "message")
    || rollups.length > 1
    || events.length !== input.source.selectedEventCount
  ) return false;
  const latestRows = await transaction.query(
    `SELECT rollup.crypto_object_id
       FROM room_event_rollups AS rollup
      WHERE rollup.room_id = $1::uuid
      ORDER BY rollup.through_event_sequence DESC, rollup.created_at DESC
      LIMIT 1
      FOR SHARE OF rollup`,
    [input.roomId],
  );
  if (
    latestRows.length > 1
    || (
      latestRows[0]?.["crypto_object_id"] ?? null
    ) !== (rollups[0]?.objectId ?? null)
  ) return false;
  const through = rollups[0]?.binding.throughEventSequence ?? 0;
  const countRows = await executeTypedConversationProductQuery(
    transaction,
    typedDb.select({ active_event_count: count().as("active_event_count") })
      .from(roomEvents)
      .where(and(
        eq(roomEvents.roomId, input.roomId),
        eq(roomEvents.status, "active"),
        gt(roomEvents.sequence, through),
      )),
  );
  if (
    countRows.length !== 1
    || countRows[0]?.["active_event_count"] !== input.source.activeEventCount
  ) return false;
  const oldestLimit =
    PROTECTED_STENOGRAPHER_COMPACTION_MAX_EVENT_INPUTS - 50;
  const selectedRows = await transaction.query(
    `WITH active_event AS (
       SELECT event.crypto_object_id, event.sequence
         FROM room_events AS event
        WHERE event.room_id = $1::uuid
          AND event.status = 'active'
          AND event.sequence > $2::integer
     ),
     selected_event AS (
       (SELECT * FROM active_event
         ORDER BY sequence
         LIMIT $3::integer)
       UNION
       (SELECT * FROM active_event
         ORDER BY sequence DESC
         LIMIT 50)
     )
     SELECT crypto_object_id
       FROM selected_event
      ORDER BY sequence`,
    [input.roomId, through, oldestLimit],
  );
  return selectedRows.length === events.length
    && selectedRows.every(
      (row, index) =>
        row["crypto_object_id"] === events[index]!.objectId,
    );
}

export async function sourceInventoryIsCurrent(
  transaction: ConversationProductPostgresTransaction,
  input: CurrentSourceCheckInput,
): Promise<boolean> {
  return await sourceBindingsAreCurrent(transaction, input)
    && await coveredRangeIsCurrent(transaction, input)
    && await compactionSelectionIsCurrent(transaction, input);
}

function outputIdsMatch(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function isUniqueViolation(error: unknown): boolean {
  let current = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if ("code" in current && current.code === "23505") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

async function updateReceiptState(
  executor: ProductExecutor,
  statement: string,
  parameters: readonly ConversationProductPostgresScalar[],
): Promise<ProtectedJournalPublicationRecord> {
  const rows = await executor.query(statement, parameters);
  if (rows.length !== 1) {
    throw new Error("protected journal receipt state CAS failed");
  }
  return publicationRow(rows[0]!);
}

function parseLeaseInput(
  label: string,
  value: Readonly<{
    publicationId: string;
    leaseToken: string;
    now: Date;
  }>,
  extraFields: readonly string[] = [],
): Readonly<{
  publicationId: string;
  leaseToken: string;
  now: Date;
}> {
  strictRecord(label, value, [
    "publicationId",
    "leaseToken",
    "now",
    ...extraFields,
  ]);
  return Object.freeze({
    publicationId: portableId(
      "protected journal publication",
      value.publicationId,
    ),
    leaseToken: uuid("protected journal lease token", value.leaseToken),
    now: date("protected journal operation time", value.now),
  });
}

export class PostgresProtectedJournalPublicationRepository {
  constructor(
    private readonly handle: ConversationProductPostgresHandle,
    private readonly recordCommitment: ProtectedStenographerRecordCommitmentPort,
    private readonly semanticCommitments?: RecordSemanticCommitmentPort,
  ) {
    assertVerifiedConversationProductPostgresHandle(handle);
    if (handle.role !== "nautilo") {
      throw new TypeError(
        "protected journal publication requires the nautilo product role",
      );
    }
  }

  /** Same durable receipt and lease for encryption of an already completed ordinary result. */
  async reserveOutputRepairWithinTransaction(
    transaction: ConversationProductPostgresTransaction,
    value: ReserveProtectedJournalPublicationInput & Readonly<{leaseToken: string}>,
  ): Promise<ProtectedJournalPublicationRecord> {
    const plan = decodeStenographerOutputRepairPlan(value.attachmentPlanBytes);
    const metadata = protectedJournalPublicationPlanMetadata(value.attachmentPlanBytes);
    const planHash = digest(value.attachmentPlanBytes);
    try {
      if (!bytesEqual(planHash, value.attachmentPlanHash)) throw new TypeError("Output repair plan hash differs");
      const publicationId = portableId("repair publication", value.publicationId);
      if (publicationId !== value.requestId) throw new TypeError("Output repair receipt must use its request identity");
      const leaseToken = uuid("repair publication lease", value.leaseToken);
      const now = date("repair reservation time", value.now);
      const rows = await executeTypedConversationProductQuery(transaction, typedDb.insert(roomJournalCryptoPublications).values({
        publicationId, requestId: portableId("repair request", value.requestId),
        roomId: metadata.roomId, namespaceIdAtAllocation: metadata.namespaceId,
        sourceBatchId: metadata.sourceBatchId, rebuildGeneration: metadata.rebuildGeneration,
        workId: portableId("repair work", value.workId), workIdentityHash: bytes32("repair work identity", value.workIdentityHash),
        descriptorHash: bytes32("repair descriptor", value.descriptorHash), attachmentPlanVersion: 2,
        attachmentPlanHash: planHash, attachmentPlanBytes: value.attachmentPlanBytes,
        outputObjectCount: metadata.outputObjectIds.length, state: "reserved", leaseToken,
        leaseExpiresAt: new Date(now.getTime() + PROTECTED_JOURNAL_PUBLICATION_LEASE_MS),
        retryCount: 0, maximumAttempts: PROTECTED_JOURNAL_PUBLICATION_MAXIMUM_ATTEMPTS,
        createdAt: now, updatedAt: now,
      }).onConflictDoNothing().returning(PUBLICATION_RETURNING));
      let current = rows.length === 1 ? publicationRow(rows[0]!) : await loadPublication(transaction, publicationId, true);
      // The existing abandonment owner proved the previous one-run attempt was
      // fenced and had no crypto commit. Only that exact retained plan may retry.
      if (current?.state === "superseded" && current.failureCode === "crypto_publication_failed"
        && current.cryptoCommittedAt === null && current.attachedAt === null
        && current.requestId === value.requestId && current.workId === value.workId
        && current.attachmentPlanVersion === 2 && bytesEqual(current.workIdentityHash, value.workIdentityHash)
        && bytesEqual(current.attachmentPlanBytes, value.attachmentPlanBytes)) {
        const reactivated = await executeTypedConversationProductQuery(transaction, typedDb.update(roomJournalCryptoPublications)
          .set({state: "reserved", descriptorHash: value.descriptorHash, leaseToken,
            leaseExpiresAt: new Date(now.getTime() + PROTECTED_JOURNAL_PUBLICATION_LEASE_MS),
            failureCode: null, lastFailureAt: null, updatedAt: now})
          .where(and(eq(roomJournalCryptoPublications.publicationId, publicationId),
            eq(roomJournalCryptoPublications.state, "superseded"),
            eq(roomJournalCryptoPublications.descriptorHash, current.descriptorHash),
            eq(roomJournalCryptoPublications.attachmentPlanHash, current.attachmentPlanHash),
            isNull(roomJournalCryptoPublications.cryptoCommittedAt), isNull(roomJournalCryptoPublications.attachedAt)))
          .returning(PUBLICATION_RETURNING));
        if (reactivated.length !== 1) throw new ProtectedJournalPublicationConflictError("mapping_conflict");
        current = publicationRow(reactivated[0]!);
      }
      if (current === null || current.requestId !== value.requestId || current.workId !== value.workId
        || current.attachmentPlanVersion !== 2 || !bytesEqual(current.workIdentityHash, value.workIdentityHash)
        || !bytesEqual(current.descriptorHash, value.descriptorHash)
        || !bytesEqual(current.attachmentPlanBytes, value.attachmentPlanBytes)
        || current.state !== "reserved" || !leaseIsCurrent(current, leaseToken, now)) {
        throw new ProtectedJournalPublicationConflictError("mapping_conflict");
      }
      return current;
    } finally {planHash.fill(0); plan.binding.receipt.ordinaryOutputFingerprint.fill(0);}
  }

  /** Caller holds current grant and source locks; plaintext/mapping work uses that same product transaction. */
  async completeOutputRepairWithinTransaction(
    transaction: ConversationProductPostgresTransaction,
    input: Readonly<{publicationId: string; leaseToken: string; expected: ProtectedJournalPublicationRecord;
      now: Date; attach(): Promise<void>}>,
  ): Promise<void> {
    const current = await loadPublication(transaction, input.publicationId, true);
    if (current === null || current.attachmentPlanVersion !== 2
      || current.requestId !== input.expected.requestId || !bytesEqual(current.descriptorHash, input.expected.descriptorHash)
      || !bytesEqual(current.attachmentPlanBytes, input.expected.attachmentPlanBytes)) throw new Error("Output repair receipt changed");
    if (current.state === "attached") return;
    if ((current.state !== "reserved" && current.state !== "crypto_committed")
      || !leaseIsCurrent(current, input.leaseToken, input.now)) throw new Error("Output repair publication lease changed");
    await input.attach();
    const changed = await executeTypedConversationProductQuery(transaction, typedDb.update(roomJournalCryptoPublications).set({
      state: "attached", leaseToken: null, leaseExpiresAt: null, failureCode: null, lastFailureAt: null,
      cryptoCommittedAt: current.cryptoCommittedAt ?? input.now, attachedAt: input.now, updatedAt: input.now,
    }).where(and(eq(roomJournalCryptoPublications.publicationId, current.publicationId),
      eq(roomJournalCryptoPublications.state, current.state), eq(roomJournalCryptoPublications.leaseToken, input.leaseToken),
      eq(roomJournalCryptoPublications.descriptorHash, current.descriptorHash),
      eq(roomJournalCryptoPublications.attachmentPlanHash, current.attachmentPlanHash))).returning({id: roomJournalCryptoPublications.publicationId}));
    if (changed.length !== 1) throw new Error("Output repair publication completion changed");
  }

  async reserveCurrentSourceAndClaim(
    value: ReserveCurrentProtectedJournalPublicationInput,
  ): Promise<ProtectedJournalPublicationCurrentReserveResult> {
    const input = parseCurrentReservation(value);
    return this.handle.transaction(async (transaction) => {
      const currentSource: CurrentSourceCheckInput = Object.freeze({
        roomId: input.reservation.plan.roomId,
        namespaceId: input.reservation.plan.namespaceId,
        rebuildGeneration: input.reservation.plan.rebuildGeneration,
        sourceBatchId: input.reservation.plan.sourceBatchId,
        now: input.reservation.now,
        sourceLeaseToken: input.sourceLeaseToken,
        sourceBindingFingerprint: input.sourceBindingFingerprint,
        sourceBindings: input.sourceBindings,
        source: input.source,
      });
      if (
        !await sourceCoordinatesAreCurrent(transaction, currentSource)
        || !await sourceInventoryIsCurrent(transaction, currentSource)
      ) {
        return Object.freeze({ status: "stale" as const });
      }
      const reservation = input.reservation;
      const leaseExpiresAt = new Date(
        reservation.now.getTime()
          + PROTECTED_JOURNAL_PUBLICATION_LEASE_MS,
      );
      const inserted = await executeTypedConversationProductQuery(
        transaction,
        typedDb.insert(roomJournalCryptoPublications)
          .values({
            publicationId: reservation.publicationId,
            requestId: reservation.requestId,
            roomId: reservation.plan.roomId,
            namespaceIdAtAllocation: reservation.plan.namespaceId,
            workId: reservation.workId,
            sourceBatchId: reservation.plan.sourceBatchId,
            rebuildGeneration: reservation.plan.rebuildGeneration,
            workIdentityHash: reservation.workIdentityHash,
            descriptorHash: reservation.descriptorHash,
            attachmentPlanVersion:
              PROTECTED_JOURNAL_ATTACHMENT_PLAN_VERSION_V1,
            attachmentPlanHash: reservation.attachmentPlanHash,
            attachmentPlanBytes: reservation.attachmentPlanBytes,
            outputObjectCount: reservation.outputObjectCount,
            state: "reserved",
            leaseToken: input.publicationLeaseToken,
            leaseExpiresAt,
            retryCount: 0,
            maximumAttempts:
              PROTECTED_JOURNAL_PUBLICATION_MAXIMUM_ATTEMPTS,
            createdAt: reservation.now,
            updatedAt: reservation.now,
          })
          .onConflictDoNothing()
          .returning(PUBLICATION_RETURNING),
      );
      if (inserted.length === 1) {
        return Object.freeze({
          status: "claimed" as const,
          record: publicationRow(inserted[0]!),
        });
      }
      const collisions = await transaction.query(
        `SELECT ${PUBLICATION_COLUMNS}
           FROM room_journal_crypto_publications
          WHERE publication_id = $1
             OR request_id = $2
             OR work_id = $3
             OR work_identity_hash = $4
          LIMIT 4
          FOR UPDATE`,
        [
          reservation.publicationId,
          reservation.requestId,
          reservation.workId,
          reservation.workIdentityHash,
        ],
      );
      if (collisions.length !== 1) {
        throw new ProtectedJournalPublicationConflictError(
          "reservation_conflict",
        );
      }
      const current = publicationRow(collisions[0]!);
      if (
        current.state === "superseded"
        && current.cryptoCommittedAt === null
        && current.failureCode === "crypto_publication_failed"
        && sameDurableWorkCoordinates(current, reservation)
      ) {
        const reactivated = await executeTypedConversationProductQuery(
          transaction,
          typedDb.update(roomJournalCryptoPublications)
            .set({
              descriptorHash: reservation.descriptorHash,
              attachmentPlanVersion:
                PROTECTED_JOURNAL_ATTACHMENT_PLAN_VERSION_V1,
              attachmentPlanHash: reservation.attachmentPlanHash,
              attachmentPlanBytes: reservation.attachmentPlanBytes,
              outputObjectCount: reservation.outputObjectCount,
              state: "reserved",
              leaseToken: input.publicationLeaseToken,
              leaseExpiresAt,
              retryCount: 0,
              failureCode: null,
              lastFailureAt: null,
              updatedAt: reservation.now,
            })
            .where(and(
              eq(
                roomJournalCryptoPublications.publicationId,
                reservation.publicationId,
              ),
              eq(roomJournalCryptoPublications.state, "superseded"),
              isNull(roomJournalCryptoPublications.cryptoCommittedAt),
              isNull(roomJournalCryptoPublications.attachedAt),
              eq(
                roomJournalCryptoPublications.failureCode,
                "crypto_publication_failed",
              ),
              eq(roomJournalCryptoPublications.workId, reservation.workId),
              eq(
                roomJournalCryptoPublications.workIdentityHash,
                reservation.workIdentityHash,
              ),
            ))
            .returning(PUBLICATION_RETURNING),
        );
        if (reactivated.length !== 1) {
          throw new ProtectedJournalPublicationConflictError(
            "reservation_conflict",
          );
        }
        return Object.freeze({
          status: "claimed" as const,
          record: publicationRow(reactivated[0]!),
        });
      }
      if (!sameReservation(current, reservation)) {
        throw new ProtectedJournalPublicationConflictError(
          "reservation_conflict",
        );
      }
      if (current.state === "attached") {
        return Object.freeze({
          status: "existing" as const,
          record: current,
        });
      }
      if (
        current.state !== "reserved"
        && current.state !== "crypto_committed"
      ) {
        return Object.freeze({
          status: "stale" as const,
          record: current,
        });
      }
      const claimed = await executeTypedConversationProductQuery(
        transaction,
        typedDb.update(roomJournalCryptoPublications)
          .set({
            leaseToken: input.publicationLeaseToken,
            leaseExpiresAt,
            updatedAt: reservation.now,
          })
          .where(and(
            eq(
              roomJournalCryptoPublications.publicationId,
              reservation.publicationId,
            ),
            inArray(roomJournalCryptoPublications.state, [
              "reserved",
              "crypto_committed",
            ]),
            or(
              isNull(roomJournalCryptoPublications.leaseToken),
              isNull(roomJournalCryptoPublications.leaseExpiresAt),
              lte(
                roomJournalCryptoPublications.leaseExpiresAt,
                reservation.now,
              ),
              eq(
                roomJournalCryptoPublications.leaseToken,
                input.publicationLeaseToken,
              ),
            ),
          ))
          .returning(PUBLICATION_RETURNING),
      );
      if (claimed.length === 1) {
        return Object.freeze({
          status: "claimed" as const,
          record: publicationRow(claimed[0]!),
        });
      }
      return Object.freeze({
        status: "busy" as const,
        record: current,
      });
    }, { isolationLevel: "serializable" });
  }

  async reserve(
    value: ReserveProtectedJournalPublicationInput,
  ): Promise<ProtectedJournalPublicationReserveResult> {
    const input = parseReservation(value);
    const inserted = await executeTypedConversationProductQuery(
      this.handle,
      typedDb
        .insert(roomJournalCryptoPublications)
        .values({
          publicationId: input.publicationId,
          requestId: input.requestId,
          roomId: input.plan.roomId,
          namespaceIdAtAllocation: input.plan.namespaceId,
          workId: input.workId,
          sourceBatchId: input.plan.sourceBatchId,
          rebuildGeneration: input.plan.rebuildGeneration,
          workIdentityHash: input.workIdentityHash,
          descriptorHash: input.descriptorHash,
          attachmentPlanVersion:
            PROTECTED_JOURNAL_ATTACHMENT_PLAN_VERSION_V1,
          attachmentPlanHash: input.attachmentPlanHash,
          attachmentPlanBytes: input.attachmentPlanBytes,
          outputObjectCount: input.outputObjectCount,
          state: "reserved",
          leaseToken: null,
          leaseExpiresAt: null,
          retryCount: 0,
          maximumAttempts: PROTECTED_JOURNAL_PUBLICATION_MAXIMUM_ATTEMPTS,
          failureCode: null,
          lastFailureAt: null,
          cryptoCommittedAt: null,
          attachedAt: null,
          tombstoneRequestedAt: null,
          tombstonedAt: null,
          lastAuditedAt: null,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing()
        .returning(),
    );
    if (inserted.length === 1) {
      return Object.freeze({
        status: "created" as const,
        record: publicationRow(inserted[0]!),
      });
    }
    const collisions = await executeTypedConversationProductQuery(
      this.handle,
      typedDb
        .select()
        .from(roomJournalCryptoPublications)
        .where(or(
          eq(roomJournalCryptoPublications.publicationId, input.publicationId),
          eq(roomJournalCryptoPublications.requestId, input.requestId),
          eq(roomJournalCryptoPublications.workId, input.workId),
          eq(
            roomJournalCryptoPublications.workIdentityHash,
            input.workIdentityHash,
          ),
        ))
        .limit(4),
    );
    if (collisions.length === 1) {
      const record = publicationRow(collisions[0]!);
      if (sameReservation(record, input)) {
        return Object.freeze({ status: "existing" as const, record });
      }
    }
    throw new ProtectedJournalPublicationConflictError(
      "reservation_conflict",
    );
  }

  async get(
    publicationIdValue: string,
  ): Promise<ProtectedJournalPublicationRecord | null> {
    return loadPublication(
      this.handle,
      portableId("protected journal publication", publicationIdValue),
    );
  }

  async listReconciliation(value: Readonly<{
    readonly now: Date;
    readonly limit: number;
  }>): Promise<readonly ProtectedJournalPublicationRecord[]> {
    exactFields("protected journal reconciliation list", value, [
      "now",
      "limit",
    ]);
    const now = date("protected journal reconciliation time", value.now);
    const limit = integer(
      "protected journal reconciliation limit",
      value.limit,
      1,
      PROTECTED_JOURNAL_PUBLICATION_MAX_RECONCILIATION_BATCH,
    );
    const rows = await executeTypedConversationProductQuery(
      this.handle,
      typedDb
        .select()
        .from(roomJournalCryptoPublications)
        .where(and(
          inArray(roomJournalCryptoPublications.state, [
            "reserved",
            "crypto_committed",
            "tombstone_pending",
          ]),
          lt(
            roomJournalCryptoPublications.retryCount,
            roomJournalCryptoPublications.maximumAttempts,
          ),
          or(
            isNull(roomJournalCryptoPublications.leaseToken),
            isNull(roomJournalCryptoPublications.leaseExpiresAt),
            lte(roomJournalCryptoPublications.leaseExpiresAt, now),
          ),
        ))
        .orderBy(
          roomJournalCryptoPublications.updatedAt,
          roomJournalCryptoPublications.publicationId,
        )
        .limit(limit),
    );
    return Object.freeze(rows.map(publicationRow));
  }

  async claim(value: Readonly<{
    readonly publicationId: string;
    readonly leaseToken: string;
    readonly now: Date;
  }>): Promise<ProtectedJournalPublicationClaimResult> {
    const input = parseLeaseInput(
      "protected journal reconciliation claim",
      value,
    );
    const leaseExpiresAt = new Date(
      input.now.getTime() + PROTECTED_JOURNAL_PUBLICATION_LEASE_MS,
    );
    const rows = await executeTypedConversationProductQuery(
      this.handle,
      typedDb
        .update(roomJournalCryptoPublications)
        .set({
          leaseToken: input.leaseToken,
          leaseExpiresAt,
          updatedAt: input.now,
        })
        .where(and(
          eq(
            roomJournalCryptoPublications.publicationId,
            input.publicationId,
          ),
          inArray(roomJournalCryptoPublications.state, [
            "reserved",
            "crypto_committed",
            "tombstone_pending",
          ]),
          lt(
            roomJournalCryptoPublications.retryCount,
            roomJournalCryptoPublications.maximumAttempts,
          ),
          or(
            isNull(roomJournalCryptoPublications.leaseToken),
            isNull(roomJournalCryptoPublications.leaseExpiresAt),
            lte(roomJournalCryptoPublications.leaseExpiresAt, input.now),
            eq(roomJournalCryptoPublications.leaseToken, input.leaseToken),
          ),
        ))
        .returning(),
    );
    if (rows.length === 1) {
      return Object.freeze({
        status: "claimed" as const,
        record: publicationRow(rows[0]!),
      });
    }
    const current = await loadPublication(this.handle, input.publicationId);
    if (current === null) return Object.freeze({ status: "missing" as const });
    if (
      current.state === "attached"
      || current.state === "quarantined"
      || current.state === "superseded"
      || current.state === "tombstoned"
      || current.retryCount >= current.maximumAttempts
    ) {
      return Object.freeze({
        status: "terminal" as const,
        record: current,
      });
    }
    return Object.freeze({ status: "busy" as const, record: current });
  }

  async markCryptoCommitted(value: Readonly<{
    readonly publicationId: string;
    readonly leaseToken: string;
    readonly descriptorHash: Uint8Array;
    readonly attachmentPlanHash: Uint8Array;
    readonly outputObjectIds: readonly string[];
    readonly now: Date;
  }>): Promise<ProtectedJournalCryptoCommitResult> {
    strictRecord("protected journal crypto commit", value, [
      "publicationId",
      "leaseToken",
      "descriptorHash",
      "attachmentPlanHash",
      "outputObjectIds",
      "now",
    ]);
    const publicationId = portableId(
      "protected journal publication",
      value.publicationId,
    );
    const leaseToken = uuid(
      "protected journal lease token",
      value.leaseToken,
    );
    const descriptorHash = bytes32(
      "protected journal descriptor",
      value.descriptorHash,
    );
    const attachmentPlanHash = bytes32(
      "protected journal attachment plan hash",
      value.attachmentPlanHash,
    );
    const now = date("protected journal crypto commit time", value.now);
    if (
      !Array.isArray(value.outputObjectIds)
      || value.outputObjectIds.length
        > PROTECTED_JOURNAL_MAX_OUTPUT_OBJECTS_V1
    ) throw new RangeError("protected journal output objects are out of bounds");
    const outputObjectIds = value.outputObjectIds.map((object) =>
      portableId("protected journal output object", object)
    );
    const current = await loadPublication(this.handle, publicationId);
    if (current === null) return Object.freeze({ status: "missing" as const });
    const plan = protectedJournalPublicationPlanMetadata(
      current.attachmentPlanBytes,
    );
    if (
      !bytesEqual(current.descriptorHash, descriptorHash)
      || !bytesEqual(current.attachmentPlanHash, attachmentPlanHash)
      || !outputIdsMatch(plan.outputObjectIds, outputObjectIds)
      || current.outputObjectCount !== outputObjectIds.length
    ) {
      throw new ProtectedJournalPublicationConflictError(
        "mapping_conflict",
      );
    }
    if (
      current.state === "crypto_committed"
      || current.state === "attached"
      || current.state === "tombstone_pending"
      || current.state === "tombstoned"
    ) {
      return Object.freeze({
        status: "duplicate" as const,
        record: current,
      });
    }
    if (
      current.state !== "reserved"
      || !leaseIsCurrent(current, leaseToken, now)
    ) {
      return Object.freeze({
        status: "lease_lost" as const,
        record: current,
      });
    }
    const rows = await executeTypedConversationProductQuery(
      this.handle,
      typedDb
        .update(roomJournalCryptoPublications)
        .set({
          state: "crypto_committed",
          cryptoCommittedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(roomJournalCryptoPublications.publicationId, publicationId),
          eq(roomJournalCryptoPublications.state, "reserved"),
          eq(roomJournalCryptoPublications.leaseToken, leaseToken),
          gt(roomJournalCryptoPublications.leaseExpiresAt, now),
          eq(roomJournalCryptoPublications.descriptorHash, descriptorHash),
          eq(
            roomJournalCryptoPublications.attachmentPlanHash,
            attachmentPlanHash,
          ),
          eq(
            roomJournalCryptoPublications.attachmentPlanBytes,
            current.attachmentPlanBytes,
          ),
          eq(
            roomJournalCryptoPublications.outputObjectCount,
            outputObjectIds.length,
          ),
        ))
        .returning(),
    );
    if (rows.length === 1) {
      return Object.freeze({
        status: "committed" as const,
        record: publicationRow(rows[0]!),
      });
    }
    const latest = await loadPublication(this.handle, publicationId);
    if (
      latest !== null
      && (
        latest.state === "crypto_committed"
        || latest.state === "attached"
        || latest.state === "tombstone_pending"
        || latest.state === "tombstoned"
      )
      && bytesEqual(latest.descriptorHash, descriptorHash)
      && bytesEqual(latest.attachmentPlanHash, attachmentPlanHash)
    ) {
      return Object.freeze({
        status: "duplicate" as const,
        record: latest,
      });
    }
    return Object.freeze({
      status: "lease_lost" as const,
      ...(latest === null ? {} : { record: latest }),
    });
  }

  async attach(
    value: AttachCurrentProtectedJournalPublicationInput,
  ): Promise<ProtectedJournalAttachmentResult> {
    const input = parseCurrentAttachment(value);
    try {
      return await this.handle.transaction(
        (transaction) =>
          this.attachInTransaction(transaction, input),
        { isolationLevel: "serializable" },
      );
    } catch (error) {
      if (
        !isUniqueViolation(error)
        && !(
          error instanceof ProtectedJournalPublicationConflictError
          && error.message === "mapping_conflict"
        )
      ) throw error;
      const quarantined = await this.quarantineMappingConflict({
        publicationId: input.publicationId,
        leaseToken: input.leaseToken,
        now: input.now,
      });
      return quarantined === null
        ? Object.freeze({ status: "missing" as const })
        : Object.freeze({
          status: "quarantined" as const,
          record: quarantined,
        });
    }
  }

  /** Lattice lends the product transaction while current policy, Room and device
   * authority remain locked. Never open a second transaction for this write. */
  async attachWithOrdinarySiblings(
    transaction: ConversationProductPostgresTransaction,
    value: AttachCurrentProtectedJournalPublicationInput,
    outputs: readonly ProcessorTransformInput[],
  ): Promise<ProtectedJournalAttachmentResult> {
    const input = parseCurrentAttachment(value);
    if (outputs.length > PROTECTED_JOURNAL_MAX_OUTPUT_OBJECTS_V1) {
      throw new TypeError("Journal ordinary sibling count exceeds its publication");
    }
    const ordinaryOutputs = outputs.map((output) => ({
      objectId: portableId("Journal sibling object", output.objectId),
      plaintext: Uint8Array.from(output.plaintext),
    }));
    try {
      return await this.attachInTransaction(transaction, {...input, ordinaryOutputs});
    } finally {
      ordinaryOutputs.forEach((output) => output.plaintext.fill(0));
    }
  }

  /** Receipt-only lock before Namespace authority acquires parent/source Rooms. */
  async validateCurrentPublicationReceipt(
    transaction: ConversationProductPostgresTransaction,
    publicationId: string,
    expected: Readonly<{descriptorHash: Uint8Array; attachmentPlanHash: Uint8Array}>,
  ): Promise<boolean> {
    const current = await loadPublication(transaction, publicationId, true);
    return current !== null && (current.state === "reserved" || current.state === "crypto_committed")
      && bytesEqual(current.descriptorHash, expected.descriptorHash)
      && bytesEqual(current.attachmentPlanHash, expected.attachmentPlanHash);
  }

  /** Metadata-only source locks, acquired before current restricted authority locks. */
  async validateCurrentReconciliationSource(
    transaction: ConversationProductPostgresTransaction,
    value: AttachCurrentProtectedJournalPublicationInput,
    expected: Readonly<{descriptorHash: Uint8Array; attachmentPlanHash: Uint8Array}>,
  ): Promise<boolean> {
    const input = parseCurrentAttachment(value);
    const current = await loadPublication(transaction, input.publicationId, true);
    if (current === null || (current.state !== "reserved" && current.state !== "crypto_committed")
      || !bytesEqual(current.descriptorHash, expected.descriptorHash)
      || !bytesEqual(current.attachmentPlanHash, expected.attachmentPlanHash)) return false;
    const source: CurrentSourceCheckInput = {roomId: current.roomId, namespaceId: current.namespaceIdAtAllocation,
      rebuildGeneration: current.rebuildGeneration, sourceBatchId: current.sourceBatchId,
      now: input.now, sourceLeaseToken: input.sourceLeaseToken,
      sourceBindingFingerprint: input.sourceBindingFingerprint, sourceBindings: input.sourceBindings, source: input.source};
    return await sourceCoordinatesAreCurrent(transaction, source) && await sourceInventoryIsCurrent(transaction, source);
  }

  /** Called only inside the current policy/Room/device authority owner's transaction.
   * The caller has authenticated the exact retained result and original receipt. */
  async attachCurrentReconciliation(
    transaction: ConversationProductPostgresTransaction,
    value: AttachCurrentProtectedJournalPublicationInput,
    expected: Readonly<{descriptorHash: Uint8Array; attachmentPlanHash: Uint8Array}>,
    ordinaryOutputs?: readonly ProcessorTransformInput[],
  ): Promise<ProtectedJournalAttachmentResult> {
    const input = parseCurrentAttachment(value);
    const current = await loadPublication(transaction, input.publicationId, true);
    if (current === null || !bytesEqual(current.descriptorHash, expected.descriptorHash)
      || !bytesEqual(current.attachmentPlanHash, expected.attachmentPlanHash)) {
      throw new Error("Reconciliation original receipt changed before attachment");
    }
    const owned = ordinaryOutputs?.map(output => ({objectId: output.objectId, plaintext: Uint8Array.from(output.plaintext)}));
    try {return await this.attachInTransaction(transaction, {...input,
      ...(owned === undefined ? {} : {ordinaryOutputs: owned})});}
    finally {owned?.forEach(output => output.plaintext.fill(0));}
  }

  private async attachInTransaction(
    transaction: ConversationProductPostgresTransaction,
    input: Readonly<{
      publicationId: string;
      leaseToken: string;
      sourceLeaseToken: string;
      sourceBindingFingerprint: Uint8Array;
      sourceBindings: readonly ProtectedStenographerSourceBinding[];
      source: ReserveCurrentProtectedJournalPublicationInput["source"];
      now: Date;
      ordinaryOutputs?: readonly ProcessorTransformInput[];
    }>,
  ): Promise<ProtectedJournalAttachmentResult> {
    const current = await loadPublication(
      transaction,
      input.publicationId,
      true,
    );
    if (current === null) return Object.freeze({ status: "missing" as const });
    if (input.ordinaryOutputs !== undefined) {
      const plan = decodeProtectedJournalAttachmentPlanV1(current.attachmentPlanBytes);
      const ids = plan.kind === "extraction" ? plan.events.map((event) => event.objectId) : [plan.rollup!.objectId];
      if (ids.length !== input.ordinaryOutputs.length
        || ids.some((id, index) => input.ordinaryOutputs![index]?.objectId !== id)) {
        throw new TypeError("Journal ordinary siblings differ from the committed output set");
      }
      if (current.state === "attached") {
        if (plan.kind === "extraction") {
          for (const [index, event] of plan.events.entries()) {
            const rows = await executeTypedConversationProductQuery(transaction,
              typedDb.select({bytes: reflectionRecordPayloadRepresentations.plaintextPayloadBytes})
                .from(reflectionRecordPayloadRepresentations).innerJoin(reflectionRecordPayloadRepresentationHeads, and(
                  eq(reflectionRecordPayloadRepresentationHeads.recordId, reflectionRecordPayloadRepresentations.recordId),
                  eq(reflectionRecordPayloadRepresentationHeads.representation, "ordinary"),
                  eq(reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration, reflectionRecordPayloadRepresentations.representationGeneration),
                )).where(and(eq(reflectionRecordPayloadRepresentations.recordId, event.eventId),
                  eq(reflectionRecordPayloadRepresentations.representation, "ordinary"))).limit(2));
            if (rows.length !== 1 || !(rows[0]?.plaintext_payload_bytes instanceof Uint8Array)
              || !bytesEqual(rows[0].plaintext_payload_bytes, input.ordinaryOutputs[index]!.plaintext)) {
              throw new TypeError("Attached Journal ordinary sibling is missing or conflicts");
            }
          }
        } else {
          const payload = decodeRoomEventRollupPayloadV1(input.ordinaryOutputs[0]!.plaintext);
          const rows = await executeTypedConversationProductQuery(transaction,
            typedDb.select({content: roomEventRollups.content}).from(roomEventRollups)
              .where(and(eq(roomEventRollups.id, plan.rollup!.rollupId), eq(roomEventRollups.cryptoObjectId, plan.rollup!.objectId))).limit(2));
          if (rows.length !== 1 || rows[0]?.content !== payload.content) {
            throw new TypeError("Attached Journal rollup sibling is missing or conflicts");
          }
        }
      }
    }
    if (current.state === "attached") {
      return Object.freeze({
        status: "duplicate" as const,
        record: current,
      });
    }
    if (current.state !== "crypto_committed") {
      return Object.freeze({
        status: "crypto_not_committed" as const,
        record: current,
      });
    }
    if (!leaseIsCurrent(current, input.leaseToken, input.now)) {
      return Object.freeze({
        status: "lease_lost" as const,
        record: current,
      });
    }
    const plan = decodeProtectedJournalAttachmentPlanV1(
      current.attachmentPlanBytes,
    );
    const coordinateRows = await transaction.query(
      `SELECT r.namespace_id::text AS namespace_id,
              rjs.rebuild_generation::int AS rebuild_generation,
              rjs.lease_token::text AS lease_token,
              rjs.lease_expires_at,
              rjs.compaction_lease_token::text AS compaction_lease_token,
              rjs.compaction_lease_expires_at
         FROM rooms AS r
         JOIN room_journal_state AS rjs ON rjs.room_id = r.id
        WHERE r.id = $1
        FOR UPDATE OF r, rjs`,
      [current.roomId],
    );
    if (coordinateRows.length !== 1) {
      const quarantined = await this.quarantineInTransaction(
        transaction,
        current,
        input,
        "integrity_failure",
      );
      return Object.freeze({
        status: "quarantined" as const,
        record: quarantined,
      });
    }
    const coordinate = coordinateRows[0]!;
    strictRecord("protected journal attachment coordinates", coordinate, [
      "namespace_id",
      "rebuild_generation",
      "lease_token",
      "lease_expires_at",
      "compaction_lease_token",
      "compaction_lease_expires_at",
    ]);
    if (coordinate["namespace_id"] !== current.namespaceIdAtAllocation) {
      const quarantined = await this.quarantineInTransaction(
        transaction,
        current,
        input,
        "integrity_failure",
      );
      return Object.freeze({
        status: "quarantined" as const,
        record: quarantined,
      });
    }
    if (coordinate["rebuild_generation"] !== current.rebuildGeneration) {
      const pending = await updateReceiptState(
        transaction,
        `UPDATE room_journal_crypto_publications
            SET state = 'tombstone_pending',
                lease_token = NULL,
                lease_expires_at = NULL,
                failure_code = 'rebuild_superseded',
                last_failure_at = $1,
                tombstone_requested_at = $1,
                updated_at = $1
          WHERE publication_id = $2
            AND state = 'crypto_committed'
            AND lease_token = $3
          RETURNING ${PUBLICATION_COLUMNS}`,
        [input.now, current.publicationId, input.leaseToken],
      );
      return Object.freeze({
        status: "stale_reconcile" as const,
        record: pending,
      });
    }
    const sourceLease = plan.kind === "extraction"
      ? coordinate["lease_token"]
      : coordinate["compaction_lease_token"];
    const sourceLeaseExpiry = canonicalTimestamp(plan.kind === "extraction"
      ? coordinate["lease_expires_at"]
      : coordinate["compaction_lease_expires_at"]);
    if (
      sourceLease !== input.sourceLeaseToken
      || sourceLeaseExpiry === null
      || Date.parse(sourceLeaseExpiry) <= input.now.getTime()
    ) {
      return this.retryInTransaction(
        transaction,
        current,
        input,
        "lease_lost",
      );
    }
    if (
      (plan.kind === "extraction") !== (input.source.kind === "extraction")
    ) {
      throw new ProtectedJournalPublicationConflictError("mapping_conflict");
    }
    const currentSource: CurrentSourceCheckInput = Object.freeze({
      roomId: current.roomId,
      namespaceId: current.namespaceIdAtAllocation,
      rebuildGeneration: current.rebuildGeneration,
      sourceBatchId: current.sourceBatchId,
      now: input.now,
      sourceLeaseToken: input.sourceLeaseToken,
      sourceBindingFingerprint: input.sourceBindingFingerprint,
      sourceBindings: input.sourceBindings,
      source: input.source,
    });
    if (
      !await sourceCoordinatesAreCurrent(transaction, currentSource)
      || !await sourceInventoryIsCurrent(transaction, currentSource)
    ) {
      const pending = await updateReceiptState(
        transaction,
        `UPDATE room_journal_crypto_publications
            SET state = 'tombstone_pending',
                lease_token = NULL,
                lease_expires_at = NULL,
                failure_code = 'stale_authority',
                last_failure_at = $1,
                tombstone_requested_at = $1,
                updated_at = $1
          WHERE publication_id = $2
            AND state = 'crypto_committed'
            AND lease_token = $3
          RETURNING ${PUBLICATION_COLUMNS}`,
        [input.now, current.publicationId, input.leaseToken],
      );
      return Object.freeze({
        status: "stale_reconcile" as const,
        record: pending,
      });
    }
    return plan.kind === "extraction"
      ? this.attachExtraction(
        transaction,
        current,
        plan as ProtectedExtractionAttachmentPlan,
        input,
        currentSource.source.kind === "extraction" ? currentSource.source.rebuildTargetMessageId : undefined,
      )
      : this.attachRollup(
        transaction,
        current,
        plan as ProtectedRollupAttachmentPlan,
        input,
      );
  }

  private async quarantineInTransaction(
    transaction: ProductExecutor,
    current: ProtectedJournalPublicationRecord,
    input: Readonly<{
      leaseToken: string;
      now: Date;
    }>,
    code: ProtectedJournalPublicationFailureCode,
  ): Promise<ProtectedJournalPublicationRecord> {
    return updateReceiptState(
      transaction,
      `UPDATE room_journal_crypto_publications
          SET state = 'quarantined',
              lease_token = NULL,
              lease_expires_at = NULL,
              failure_code = $1,
              last_failure_at = $2,
              retry_count = LEAST(retry_count + 1, maximum_attempts),
              updated_at = $2
        WHERE publication_id = $3
          AND state IN ('reserved', 'crypto_committed')
          AND lease_token = $4
        RETURNING ${PUBLICATION_COLUMNS}`,
      [code, input.now, current.publicationId, input.leaseToken],
    );
  }

  private async retryInTransaction(
    transaction: ProductExecutor,
    current: ProtectedJournalPublicationRecord,
    input: Readonly<{
      leaseToken: string;
      now: Date;
    }>,
    code: ProtectedJournalPublicationFailureCode,
  ): Promise<ProtectedJournalAttachmentResult> {
    const terminal = current.retryCount + 1 >= current.maximumAttempts;
    const record = await updateReceiptState(
      transaction,
      `UPDATE room_journal_crypto_publications
          SET state = CASE
                WHEN retry_count + 1 >= maximum_attempts
                  THEN 'quarantined'
                ELSE state
              END,
              lease_token = NULL,
              lease_expires_at = NULL,
              retry_count = LEAST(retry_count + 1, maximum_attempts),
              failure_code = $1,
              last_failure_at = $2,
              updated_at = $2
        WHERE publication_id = $3
          AND state = 'crypto_committed'
          AND lease_token = $4
        RETURNING ${PUBLICATION_COLUMNS}`,
      [code, input.now, current.publicationId, input.leaseToken],
    );
    return Object.freeze({
      status: terminal ? "terminal" as const : "retry" as const,
      record,
    });
  }

  private async attachExtraction(
    transaction: ConversationProductPostgresTransaction,
    current: ProtectedJournalPublicationRecord,
    plan: ProtectedExtractionAttachmentPlan,
    input: Readonly<{
      leaseToken: string;
      sourceLeaseToken: string;
      now: Date;
      ordinaryOutputs?: readonly ProcessorTransformInput[];
    }>,
    rebuildTargetMessageId?: number,
  ): Promise<ProtectedJournalAttachmentResult> {
    const batchRows = await transaction.query(
      `WITH writer_version AS MATERIALIZED (
         SELECT set_config('nautilo.stenographer_writer_version', '2', true)
       )
       SELECT batch.id::text AS id, batch.room_id::text AS room_id,
              batch.status, batch.lane,
              through_message_id_inclusive::int AS through_message_id_inclusive,
              batch.extractor_version
         FROM room_journal_batches batch
         CROSS JOIN writer_version
        WHERE batch.id = $1
          AND batch.room_id = $2
        FOR UPDATE OF batch`,
      [plan.sourceBatchId, current.roomId],
    );
    if (batchRows.length !== 1) {
      const quarantined = await this.quarantineInTransaction(
        transaction,
        current,
        input,
        "integrity_failure",
      );
      return Object.freeze({
        status: "quarantined" as const,
        record: quarantined,
      });
    }
    const batch = batchRows[0]!;
    strictRecord("protected journal source batch", batch, [
      "id",
      "room_id",
      "status",
      "lane",
      "through_message_id_inclusive",
      "extractor_version",
    ]);
    const extractorVersions = new Set(
      plan.events.map((event) => event.extractorVersion),
    );
    if (
      batch["id"] !== plan.sourceBatchId
      || batch["room_id"] !== current.roomId
      || batch["status"] !== "running"
      || (batch["lane"] !== "live" && batch["lane"] !== "historical")
      || !Number.isSafeInteger(batch["through_message_id_inclusive"])
      || (
        plan.events.length > 0
        && (
          extractorVersions.size !== 1
          || !extractorVersions.has(batch["extractor_version"] as string)
        )
      )
    ) {
      const quarantined = await this.quarantineInTransaction(
        transaction,
        current,
        input,
        "integrity_failure",
      );
      return Object.freeze({
        status: "quarantined" as const,
        record: quarantined,
      });
    }
    const recordAttachment =
      await attachProtectedStenographerRecordsWithinTransaction(
        transaction,
        {
          roomId: current.roomId,
          namespaceId: current.namespaceIdAtAllocation,
          rebuildGeneration: current.rebuildGeneration,
          events: plan.events.map((event) => ({
            ...event,
            requestCommitment: this.recordCommitment.commit({
              descriptorCommitment: current.descriptorHash,
              eventId: event.eventId,
              objectId: event.objectId,
              sourceBatchId: event.sourceBatchId,
              batchLocalOrdinal: event.batchLocalOrdinal,
            }),
          })),
          statusUpdates: plan.statusUpdates,
          ...(this.semanticCommitments === undefined ? {} : {semanticCommitments: this.semanticCommitments}),
          ...(input.ordinaryOutputs === undefined ? {} : {ordinaryOutputs: input.ordinaryOutputs}),
        },
      );
    if (recordAttachment.status === "mapping_conflict") {
      const quarantined = await this.quarantineInTransaction(
        transaction,
        current,
        input,
        "mapping_conflict",
      );
      return Object.freeze({
        status: "quarantined" as const,
        record: quarantined,
      });
    }
    const operationCount =
      plan.events.length + plan.foldedBatchLocalOrdinals.length;
    const completedBatch = await executeTypedConversationProductQuery(
      transaction,
      typedDb.update(roomJournalBatches)
        .set({
          status: "completed",
          observationPublicationVersion: 2,
          operationCount,
          completedAt: input.now,
        })
        .where(and(
          eq(roomJournalBatches.id, plan.sourceBatchId),
          eq(roomJournalBatches.roomId, current.roomId),
          eq(roomJournalBatches.status, "running"),
        ))
        .returning({ id: roomJournalBatches.id }),
    );
    if (completedBatch.length !== 1) {
      throw new Error("protected journal batch completion failed");
    }
    const through = batch["through_message_id_inclusive"] as number;
    const cursorRows = batch["lane"] !== "historical"
      ? await executeTypedConversationProductQuery(transaction, typedDb
        .update(roomJournalState)
        .set({
          lastProcessedMessageId:
            sql`GREATEST(${roomJournalState.lastProcessedMessageId}, ${through})`,
          lastProcessedAt: input.now,
          ...(rebuildTargetMessageId === undefined ? {} : {
            rebuildRequestedAt: sql`CASE WHEN ${through} >= ${roomJournalState.rebuildTargetMessageId}
              THEN NULL ELSE ${roomJournalState.rebuildRequestedAt} END`,
            rebuildTargetMessageId: sql`CASE WHEN ${through} >= ${roomJournalState.rebuildTargetMessageId}
              THEN NULL ELSE ${roomJournalState.rebuildTargetMessageId} END`,
          }),
          leaseToken: null,
          leaseExpiresAt: null,
          extractionFailureCount: 0,
          extractionRetryAfter: null,
          lastExtractionCompletedAt: input.now,
          updatedAt: input.now,
        })
        .where(and(
          eq(roomJournalState.roomId, current.roomId),
          eq(
            roomJournalState.rebuildGeneration,
            current.rebuildGeneration,
          ),
          eq(roomJournalState.leaseToken, input.sourceLeaseToken),
        ))
        .returning({ room_id: roomJournalState.roomId }))
      : await executeTypedConversationProductQuery(transaction, typedDb
        .update(roomJournalState)
        .set({
          historicalBackfillCursorMessageId:
            sql`GREATEST(
              ${roomJournalState.historicalBackfillCursorMessageId},
              ${through}
            )`,
          historicalBackfillStatus: sql`CASE
            WHEN ${through} >= ${roomJournalState.historicalBackfillTargetMessageId}
              THEN 'completed'
            ELSE ${roomJournalState.historicalBackfillStatus}
          END`,
          historicalBackfillCompletedAt: sql`CASE
            WHEN ${through} >= ${roomJournalState.historicalBackfillTargetMessageId}
              THEN ${input.now}
            ELSE ${roomJournalState.historicalBackfillCompletedAt}
          END`,
          leaseToken: null,
          leaseExpiresAt: null,
          extractionFailureCount: 0,
          extractionRetryAfter: null,
          lastExtractionCompletedAt: input.now,
          updatedAt: input.now,
        })
        .where(and(
          eq(roomJournalState.roomId, current.roomId),
          eq(
            roomJournalState.rebuildGeneration,
            current.rebuildGeneration,
          ),
          eq(roomJournalState.leaseToken, input.sourceLeaseToken),
        ))
        .returning({ room_id: roomJournalState.roomId }));
    if (cursorRows.length !== 1) {
      throw new Error("protected journal cursor attachment failed");
    }
    const attached = await updateReceiptState(
      transaction,
      `UPDATE room_journal_crypto_publications
          SET state = 'attached',
              lease_token = NULL,
              lease_expires_at = NULL,
              failure_code = NULL,
              last_failure_at = NULL,
              attached_at = $1,
              updated_at = $1
        WHERE publication_id = $2
          AND state = 'crypto_committed'
          AND lease_token = $3
          AND descriptor_hash = $4
          AND attachment_plan_hash = $5
          AND attachment_plan_bytes = $6
          AND output_object_count = $7
        RETURNING ${PUBLICATION_COLUMNS}`,
      [
        input.now,
        current.publicationId,
        input.leaseToken,
        current.descriptorHash,
        current.attachmentPlanHash,
        current.attachmentPlanBytes,
        current.outputObjectCount,
      ],
    );
    return Object.freeze({
      status: "attached" as const,
      record: attached,
    });
  }

  private async attachRollup(
    transaction: ConversationProductPostgresTransaction,
    current: ProtectedJournalPublicationRecord,
    plan: ProtectedRollupAttachmentPlan,
    input: Readonly<{
      leaseToken: string;
      sourceLeaseToken: string;
      now: Date;
      ordinaryOutputs?: readonly ProcessorTransformInput[];
    }>,
  ): Promise<ProtectedJournalAttachmentResult> {
    const rollup = plan.rollup;
    let content = PROTECTED_JOURNAL_CONTENT_SENTINEL;
    if (input.ordinaryOutputs !== undefined) {
      const payload = decodeRoomEventRollupPayloadV1(input.ordinaryOutputs[0]!.plaintext);
      assertRoomEventRollupPayloadBindingV1(payload, {
        rollupId: rollup.rollupId, roomId: current.roomId,
        namespaceId: current.namespaceIdAtAllocation,
        throughEventSequence: rollup.throughEventSequence,
        sourceEventCount: rollup.sourceEventCount, modelId: rollup.modelId,
        compactorVersion: rollup.compactorVersion, createdAt: rollup.createdAt,
      });
      content = payload.content;
    }
    const mappingRows = await transaction.query(
      `SELECT id::text AS id, crypto_object_id
         FROM room_event_rollups
        WHERE id = $1
           OR crypto_object_id = $2
        FOR UPDATE`,
      [rollup.rollupId, rollup.objectId],
    );
    if (mappingRows.length > 0) {
      const quarantined = await this.quarantineInTransaction(
        transaction,
        current,
        input,
        "mapping_conflict",
      );
      return Object.freeze({
        status: "quarantined" as const,
        record: quarantined,
      });
    }
    const inserted = await executeTypedConversationProductQuery(
      transaction,
      typedDb.insert(roomEventRollups)
        .values({
          id: rollup.rollupId,
          roomId: current.roomId,
          throughEventSequence: rollup.throughEventSequence,
          content,
          sourceEventCount: rollup.sourceEventCount,
          modelId: rollup.modelId,
          compactorVersion: rollup.compactorVersion,
          cryptoObjectId: rollup.objectId,
          createdAt: new Date(rollup.createdAt),
        })
        .returning({
          id: roomEventRollups.id,
          crypto_object_id: roomEventRollups.cryptoObjectId,
        }),
    );
    if (
      inserted.length !== 1
      || inserted[0]?.["id"] !== rollup.rollupId
      || inserted[0]?.["crypto_object_id"] !== rollup.objectId
    ) throw new Error("protected journal rollup attachment failed");
    const stateRows = await executeTypedConversationProductQuery(
      transaction,
      typedDb.update(roomJournalState)
        .set({
          compactionLeaseToken: null,
          compactionLeaseExpiresAt: null,
          compactionDueAt: null,
          compactionFailureCount: 0,
          compactionRetryAfter: null,
          lastCompactionCompletedAt: input.now,
          updatedAt: input.now,
        })
        .where(and(
          eq(roomJournalState.roomId, current.roomId),
          eq(
            roomJournalState.rebuildGeneration,
            current.rebuildGeneration,
          ),
          eq(roomJournalState.compactionLeaseToken, input.sourceLeaseToken),
        ))
        .returning({ room_id: roomJournalState.roomId }),
    );
    if (stateRows.length !== 1) {
      throw new Error("protected journal rollup state attachment failed");
    }
    const attached = await updateReceiptState(
      transaction,
      `UPDATE room_journal_crypto_publications
          SET state = 'attached',
              lease_token = NULL,
              lease_expires_at = NULL,
              failure_code = NULL,
              last_failure_at = NULL,
              attached_at = $1,
              updated_at = $1
        WHERE publication_id = $2
          AND state = 'crypto_committed'
          AND lease_token = $3
          AND descriptor_hash = $4
          AND attachment_plan_hash = $5
          AND attachment_plan_bytes = $6
          AND output_object_count = 1
        RETURNING ${PUBLICATION_COLUMNS}`,
      [
        input.now,
        current.publicationId,
        input.leaseToken,
        current.descriptorHash,
        current.attachmentPlanHash,
        current.attachmentPlanBytes,
      ],
    );
    return Object.freeze({
      status: "attached" as const,
      record: attached,
    });
  }

  private async quarantineMappingConflict(input: Readonly<{
    publicationId: string;
    leaseToken: string;
    now: Date;
  }>): Promise<ProtectedJournalPublicationRecord | null> {
    const rows = await executeTypedConversationProductQuery(
      this.handle,
      typedDb
        .update(roomJournalCryptoPublications)
        .set({
          state: "quarantined",
          leaseToken: null,
          leaseExpiresAt: null,
          failureCode: "mapping_conflict",
          lastFailureAt: input.now,
          retryCount:
            sql`LEAST(${roomJournalCryptoPublications.retryCount} + 1, ${roomJournalCryptoPublications.maximumAttempts})`,
          updatedAt: input.now,
        })
        .where(and(
          eq(
            roomJournalCryptoPublications.publicationId,
            input.publicationId,
          ),
          eq(roomJournalCryptoPublications.state, "crypto_committed"),
          eq(roomJournalCryptoPublications.leaseToken, input.leaseToken),
        ))
        .returning(),
    );
    return rows.length === 0 ? null : publicationRow(rows[0]!);
  }

  async fail(value: Readonly<{
    readonly publicationId: string;
    readonly leaseToken: string;
    readonly failureCode: ProtectedJournalPublicationFailureCode;
    readonly now: Date;
  }>): Promise<ProtectedJournalFailureResult> {
    strictRecord("protected journal publication failure", value, [
      "publicationId",
      "leaseToken",
      "failureCode",
      "now",
    ]);
    const publicationId = portableId(
      "protected journal publication",
      value.publicationId,
    );
    const leaseToken = uuid(
      "protected journal lease token",
      value.leaseToken,
    );
    const code = failureCode(value.failureCode);
    if (code === null) {
      throw new TypeError("protected journal failure code is required");
    }
    const now = date("protected journal failure time", value.now);
    const rows = await executeTypedConversationProductQuery(
      this.handle,
      typedDb
        .update(roomJournalCryptoPublications)
        .set({
          state: sql`CASE
            WHEN ${code} = 'rebuild_superseded'
              AND ${roomJournalCryptoPublications.state} = 'reserved'
              THEN 'superseded'
            WHEN ${roomJournalCryptoPublications.retryCount} + 1
                >= ${roomJournalCryptoPublications.maximumAttempts}
              AND ${roomJournalCryptoPublications.state} <> 'tombstone_pending'
              THEN 'quarantined'
            ELSE ${roomJournalCryptoPublications.state}
          END`,
          leaseToken: null,
          leaseExpiresAt: null,
          retryCount:
            sql`LEAST(${roomJournalCryptoPublications.retryCount} + 1, ${roomJournalCryptoPublications.maximumAttempts})`,
          failureCode: code,
          lastFailureAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(roomJournalCryptoPublications.publicationId, publicationId),
          inArray(roomJournalCryptoPublications.state, [
            "reserved",
            "crypto_committed",
            "tombstone_pending",
          ]),
          eq(roomJournalCryptoPublications.leaseToken, leaseToken),
          gt(roomJournalCryptoPublications.leaseExpiresAt, now),
        ))
        .returning(),
    );
    if (rows.length === 1) {
      const record = publicationRow(rows[0]!);
      const terminal = record.state === "superseded"
        || record.state === "quarantined"
        || record.retryCount >= record.maximumAttempts;
      return Object.freeze({
        status: terminal ? "terminal" as const : "retry" as const,
        record,
      });
    }
    const current = await loadPublication(this.handle, publicationId);
    if (current === null) return Object.freeze({ status: "missing" as const });
    return Object.freeze({
      status: "lease_lost" as const,
      record: current,
    });
  }

  /**
   * Retires an uncommitted reservation after the caller has proved that the
   * one-run crypto transform can no longer publish. The exact lease and
   * descriptor CAS prevent a stale reconciler from retiring a newer attempt.
   * A superseded row is deliberately content-free and may be reactivated only
   * by a later exact reservation for the same durable work coordinates.
   */
  async abandonReserved(value: Readonly<{
    readonly publicationId: string;
    readonly leaseToken: string;
    readonly descriptorHash: Uint8Array;
    readonly now: Date;
  }>): Promise<ProtectedJournalReservedAbandonResult> {
    strictRecord("protected journal reserved abandonment", value, [
      "publicationId",
      "leaseToken",
      "descriptorHash",
      "now",
    ]);
    const publicationId = portableId(
      "protected journal publication",
      value.publicationId,
    );
    const leaseToken = uuid(
      "protected journal lease token",
      value.leaseToken,
    );
    const descriptorHash = bytes32(
      "protected journal descriptor",
      value.descriptorHash,
    );
    const now = date(
      "protected journal reserved abandonment time",
      value.now,
    );
    const rows = await executeTypedConversationProductQuery(
      this.handle,
      typedDb
        .update(roomJournalCryptoPublications)
        .set({
          state: "superseded",
          leaseToken: null,
          leaseExpiresAt: null,
          failureCode: "crypto_publication_failed",
          lastFailureAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(roomJournalCryptoPublications.publicationId, publicationId),
          eq(roomJournalCryptoPublications.state, "reserved"),
          isNull(roomJournalCryptoPublications.cryptoCommittedAt),
          isNull(roomJournalCryptoPublications.attachedAt),
          eq(roomJournalCryptoPublications.leaseToken, leaseToken),
          gt(roomJournalCryptoPublications.leaseExpiresAt, now),
          eq(roomJournalCryptoPublications.descriptorHash, descriptorHash),
        ))
        .returning(),
    );
    if (rows.length === 1) {
      return Object.freeze({
        status: "abandoned" as const,
        record: publicationRow(rows[0]!),
      });
    }
    const current = await loadPublication(this.handle, publicationId);
    if (current === null) return Object.freeze({ status: "missing" as const });
    if (
      current.state === "superseded"
      && bytesEqual(current.descriptorHash, descriptorHash)
    ) {
      return Object.freeze({
        status: "duplicate" as const,
        record: current,
      });
    }
    if (current.state !== "reserved") {
      return Object.freeze({
        status: "unavailable" as const,
        record: current,
      });
    }
    return Object.freeze({
      status: "lease_lost" as const,
      record: current,
    });
  }

  async requestTombstone(value: Readonly<{
    readonly publicationId: string;
    readonly now: Date;
  }>): Promise<ProtectedJournalTombstoneRequestResult> {
    strictRecord("protected journal tombstone request", value, [
      "publicationId",
      "now",
    ]);
    const publicationId = portableId(
      "protected journal publication",
      value.publicationId,
    );
    const now = date("protected journal tombstone request time", value.now);
    const rows = await executeTypedConversationProductQuery(
      this.handle,
      typedDb
        .update(roomJournalCryptoPublications)
        .set({
          state: "tombstone_pending",
          leaseToken: null,
          leaseExpiresAt: null,
          failureCode: null,
          lastFailureAt: null,
          retryCount: 0,
          tombstoneRequestedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(roomJournalCryptoPublications.publicationId, publicationId),
          inArray(roomJournalCryptoPublications.state, [
            "crypto_committed",
            "attached",
            "quarantined",
          ]),
          isNotNull(roomJournalCryptoPublications.cryptoCommittedAt),
        ))
        .returning(),
    );
    if (rows.length === 1) {
      return Object.freeze({
        status: "requested" as const,
        record: publicationRow(rows[0]!),
      });
    }
    const current = await loadPublication(this.handle, publicationId);
    if (current === null) return Object.freeze({ status: "missing" as const });
    return Object.freeze({
      status: current.state === "tombstone_pending"
          || current.state === "tombstoned"
        ? "duplicate" as const
        : "unavailable" as const,
      record: current,
    });
  }

  async markTombstoned(value: Readonly<{
    readonly publicationId: string;
    readonly leaseToken: string;
    readonly now: Date;
  }>): Promise<ProtectedJournalTombstoneResult> {
    const input = parseLeaseInput(
      "protected journal tombstone completion",
      value,
    );
    const rows = await executeTypedConversationProductQuery(
      this.handle,
      typedDb
        .update(roomJournalCryptoPublications)
        .set({
          state: "tombstoned",
          leaseToken: null,
          leaseExpiresAt: null,
          failureCode: null,
          lastFailureAt: null,
          tombstonedAt: input.now,
          updatedAt: input.now,
        })
        .where(and(
          eq(
            roomJournalCryptoPublications.publicationId,
            input.publicationId,
          ),
          eq(roomJournalCryptoPublications.state, "tombstone_pending"),
          eq(roomJournalCryptoPublications.leaseToken, input.leaseToken),
          gt(roomJournalCryptoPublications.leaseExpiresAt, input.now),
        ))
        .returning(),
    );
    if (rows.length === 1) {
      return Object.freeze({
        status: "tombstoned" as const,
        record: publicationRow(rows[0]!),
      });
    }
    const current = await loadPublication(this.handle, input.publicationId);
    if (current === null) return Object.freeze({ status: "missing" as const });
    if (current.state === "tombstoned") {
      return Object.freeze({
        status: "duplicate" as const,
        record: current,
      });
    }
    if (current.state !== "tombstone_pending") {
      return Object.freeze({
        status: "unavailable" as const,
        record: current,
      });
    }
    return Object.freeze({
      status: "lease_lost" as const,
      record: current,
    });
  }
}
