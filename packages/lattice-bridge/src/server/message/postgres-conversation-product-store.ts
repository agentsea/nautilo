import {
  acquireEncryptionPublicationFence,
  acquireRoomWriteLock,
  alias,
  and,
  actors,
  asc,
  compileOfflineDirectQuery,
  conversationHumanPeerShadowOperations,
  conversationSharedAgentShadowOperations,
  conversationSharedAgentShadowExecutions,
  conversationSharedAgentShadowInvocations,
  conversationShadowTurnOperations,
  createOfflineDirectDb,
  eq,
  inArray,
  isNull,
  or,
  roomMembers,
  rooms,
  sessionMessageCryptoRevisions,
  sessionMessageOrdinaryRepairs,
  sessionMessages,
  sessions,
  sql,
  type OfflineDirectQuery,
  type OfflineDirectQueryRow,
  type PostgresJsBridgeConnection,
  type PostgresJsBridgeRow,
  type PostgresJsBridgeScalar,
} from "@nautilo/db";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  deriveHumanMessageEditCryptoObjectIdV1,
  parseHumanMessageEditCryptoObjectIdV1,
  MAX_HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_WIRE_BYTES_V4,
  MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V4,
} from "@nautilo/lattice-crypto/wire";
import {
  appendCanonicalTranscriptRowsToExistingSessionInTx,
  deleteMessageHardInTx,
  editCanonicalTranscriptMessageInTx,
  MessageDeleteError,
  reserveCanonicalTranscriptMessageIdInTx,
  type CanonicalTranscriptTx,
} from "@nautilo/trust";
import { logicalMessageKey } from "@nautilo/types";
import {
  CONVERSATION_MESSAGE_PAYLOAD_VERSION,
  CONVERSATION_RECONCILE_MAX_ATTEMPTS,
  CONVERSATION_RECONCILE_MAX_BATCH,
  CONVERSATION_RECONCILE_LEASE_SECONDS,
  IMMUTABLE_ROOM_NAMESPACE_INVARIANT,
  assertConversationAuthorRole,
  assertConversationDurableKey,
  assertConversationMessageId,
  assertConversationMessageKeyClass,
  assertConversationNotificationEligibility,
  assertConversationRevision,
  assertConversationSessionId,
  assertConversationSubthreadReplyClassification,
  assertProductPublicationRepresentation,
  conversationVerificationMatchesRepresentation,
  deriveMessageCryptoObjectIdV2,
  deriveLiveShadowMessageCryptoObjectIdV1,
  type ConversationDeleteEffects,
  type ConversationExistingRepresentationProductStorePort,
  type ConversationOrdinaryRepairInput,
  type ConversationIndependentMessageParityInput,
  type ConversationOrdinaryRepairProductStorePort,
  type ConversationFailureCode,
  type ConversationParityStatus,
  type ConversationProductAppendInput,
  type ConversationProductAppendResult,
  type ConversationProductDeleteResult,
  type ConversationProductEditResult,
  type ConversationProductMappingCasResult,
  type ConversationProductMessage,
  type ConversationProtectedEditPlanSource,
  type ConversationProductStorePort,
  type ConversationRepairPublicationEvidence,
  type ConversationLiveShadowAgentPublishInput,
  type ConversationLiveShadowAgentEvidenceInput,
  type ConversationLiveShadowAgentEvidenceResult,
  type ConversationLiveShadowAgentReservationInput,
  type ConversationLiveShadowAgentReservationResult,
  type ConversationRevisionCoordinates,
  type ConversationRevisionDisposition,
  type ConversationRevisionLifecycle,
  type ConversationRevisionMappingState,
  type ConversationRevisionState,
  type ConversationTerminalOperationType,
} from "../../message/conversation-repository.ts";

export type ConversationProductPostgresScalar =
  | string
  | number
  | bigint
  | boolean
  | Uint8Array
  | readonly string[]
  | readonly number[]
  | Date
  | null;
export type ConversationProductDatabaseRow = Readonly<
  Record<string, ConversationProductPostgresScalar>
>;

export interface ConversationProductPostgresExecutor {
  query<Row extends ConversationProductDatabaseRow =
    ConversationProductDatabaseRow>(
    statement: string,
    parameters?: readonly ConversationProductPostgresScalar[],
  ): Promise<readonly Row[]>;
}

export const conversationProductTypedDb = createOfflineDirectDb();

export type CompiledConversationProductQuery<Result = unknown> =
  OfflineDirectQuery<Result>;

function typedProductQueryParameters(
  values: readonly unknown[],
): readonly ConversationProductPostgresScalar[] {
  return values.map((value) => {
    if (
      value === null
      || typeof value === "string"
      || typeof value === "number"
      || typeof value === "bigint"
      || typeof value === "boolean"
      || value instanceof Date
      || value instanceof Uint8Array
    ) return value;
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      return value;
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === "number")) {
      return value;
    }
    throw new TypeError("typed product query emitted an unsupported parameter");
  });
}

/** Compile a schema-typed builder and execute it on an already verified role. */
export function executeTypedConversationProductQuery<
  Query extends CompiledConversationProductQuery,
>(
  executor: ConversationProductPostgresExecutor,
  query: Query,
): Promise<readonly OfflineDirectQueryRow<
  Query,
  ConversationProductPostgresScalar
>[]> {
  const compiled = compileOfflineDirectQuery(query);
  return executor.query(
    compiled.sql,
    typedProductQueryParameters(compiled.params),
  ) as unknown as Promise<readonly OfflineDirectQueryRow<
    Query,
    ConversationProductPostgresScalar
  >[]>;
}

export type ConversationProductPostgresTransaction =
  ConversationProductPostgresExecutor;

export type ConversationProductPostgresIsolationLevel =
  | "serializable"
  | "read committed";

export interface ConversationProductPostgresConnection
  extends ConversationProductPostgresExecutor
{
  /**
   * Starts `BEGIN` at the requested isolation before invoking the callback.
   * A trusted connection may install already-authenticated caller GUCs after
   * BEGIN and before the callback; the adapter never owns those values.
   */
  transaction<Result>(
    callback: (
      transaction: ConversationProductPostgresTransaction,
    ) => Promise<Result>,
    options: Readonly<{
      isolationLevel: ConversationProductPostgresIsolationLevel;
    }>,
  ): Promise<Result>;
}

export interface ConversationProductCanonicalTransactionConnection {
  /**
   * Opens a Drizzle transaction on the caller-authenticated ordinary product
   * connection. The caller must install request-scoped RLS context before
   * invoking the callback; this adapter never invents or changes that context.
   */
  transaction<Result>(
    callback: (
      transaction: CanonicalTranscriptTx,
      executor: ConversationProductPostgresExecutor,
    ) => Promise<Result>,
    options: Readonly<{
      isolationLevel: ConversationProductPostgresIsolationLevel;
    }>,
  ): Promise<Result>;
}

declare const verifiedConversationProductPostgresHandleBrand: unique symbol;
declare const verifiedConversationCanonicalRunnerBrand: unique symbol;

export interface ConversationProductPostgresHandle
  extends ConversationProductPostgresConnection
{
  readonly role: "nautilo" | "nautilo_agent";
  readonly [verifiedConversationProductPostgresHandleBrand]: true;
}

export interface ConversationProductCanonicalTransactionRunner {
  readonly role: ConversationProductPostgresHandle["role"];
  readonly [verifiedConversationCanonicalRunnerBrand]: true;
  transaction<Result>(
    callback: (
      transaction: CanonicalTranscriptTx,
      executor: ConversationProductPostgresExecutor,
    ) => Promise<Result>,
    options: Readonly<{
      isolationLevel: ConversationProductPostgresIsolationLevel;
    }>,
  ): Promise<Result>;
}

const verifiedProductHandles = new WeakSet<object>();
const verifiedCanonicalRunners =
  new WeakMap<object, ConversationProductPostgresHandle>();
const SERIALIZATION_FAILURE = "40001";
const DEADLOCK_FAILURE = "40P01";
const MAXIMUM_SERIALIZABLE_ATTEMPTS = 3;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FAILURE_CODES = new Set<ConversationFailureCode>([
  "namespace_unresolved",
  "namespace_mismatch",
  "crypto_absent",
  "crypto_incomplete",
  "crypto_mismatch",
  "authorization_unavailable",
  "recipient_unavailable",
  "storage_transient",
  "mapping_conflict",
  "retry_exhausted",
]);
const DISPOSITIONS = new Set<ConversationRevisionDisposition>([
  "active",
  "mapped",
  "blocked",
  "quarantined",
  "superseded",
  "hard_delete",
  "stale_mapping",
]);
const TERMINAL_TYPES = new Set<ConversationTerminalOperationType>([
  "edit",
  "delete",
]);

function isRetryableTransactionFailure(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if (
      "code" in current
      && (
        current.code === SERIALIZATION_FAILURE
        || current.code === DEADLOCK_FAILURE
      )
    ) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

async function retryTransaction<Result>(
  connection: ConversationProductPostgresConnection,
  callback: (
    transaction: ConversationProductPostgresTransaction,
  ) => Promise<Result>,
  options: Readonly<{
    isolationLevel: ConversationProductPostgresIsolationLevel;
  }>,
): Promise<Result> {
  for (
    let attempt = 1;
    attempt <= MAXIMUM_SERIALIZABLE_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await connection.transaction(callback, options);
    } catch (error) {
      if (
        !isRetryableTransactionFailure(error)
        || attempt === MAXIMUM_SERIALIZABLE_ATTEMPTS
      ) throw error;
    }
  }
  throw new Error("Unreachable conversation transaction retry state");
}

export function assertVerifiedConversationProductPostgresHandle(
  handle: ConversationProductPostgresHandle,
): void {
  if (!verifiedProductHandles.has(handle)) {
    throw new TypeError(
      "Conversation store requires a verified ordinary product Postgres handle",
    );
  }
}

export function assertConversationProductCanonicalTransactionRunner(
  handle: ConversationProductPostgresHandle,
  runner: ConversationProductCanonicalTransactionRunner,
): void {
  assertVerifiedConversationProductPostgresHandle(handle);
  if (verifiedCanonicalRunners.get(runner) !== handle) {
    throw new TypeError(
      "Canonical transaction runner must belong to the exact verified product handle",
    );
  }
}

/**
 * Mints the only handle accepted by the product adapter. Both PostgreSQL
 * identities must be the same ordinary role: this rejects SET ROLE
 * impersonation and the isolated `nautilo_crypto` authority. The wrapper never
 * changes caller GUCs, so request-scoped RLS identity remains the caller's.
 */
export async function verifyConversationProductPostgresHandle(
  connection: ConversationProductPostgresConnection,
): Promise<ConversationProductPostgresHandle> {
  const rows = await connection.query(
    `SELECT current_user::text AS current_user,
            session_user::text AS session_user
       LIMIT 2`,
  );
  const current = rows[0]?.["current_user"];
  const session = rows[0]?.["session_user"];
  if (
    rows.length !== 1
    || (current !== "nautilo" && current !== "nautilo_agent")
    || current !== session
  ) {
    throw new TypeError(
      "Conversation Postgres connection must authenticate directly as nautilo or nautilo_agent",
    );
  }
  const role = current;
  const verified = Object.freeze({
    role,
    query: <Row extends ConversationProductDatabaseRow =
      ConversationProductDatabaseRow>(
      statement: string,
      parameters?: readonly ConversationProductPostgresScalar[],
    ) => connection.query<Row>(statement, parameters),
    transaction: <Result>(
      callback: (
        transaction: ConversationProductPostgresTransaction,
      ) => Promise<Result>,
      options: Readonly<{
        isolationLevel: ConversationProductPostgresIsolationLevel;
      }>,
    ) => retryTransaction(connection, callback, options),
  }) as ConversationProductPostgresHandle;
  verifiedProductHandles.add(verified);
  return verified;
}

/**
 * Binds the canonical Drizzle transaction seam to one verified ordinary-role
 * handle. Every transaction rechecks both PostgreSQL identities on the actual
 * canonical connection before any product mutation runs, so a differently
 * privileged pool cannot be smuggled behind the verified raw handle.
 */
export function bindConversationProductCanonicalTransactionRunner(
  handle: ConversationProductPostgresHandle,
  connection: ConversationProductCanonicalTransactionConnection,
): ConversationProductCanonicalTransactionRunner {
  assertVerifiedConversationProductPostgresHandle(handle);
  const runner = Object.freeze({
    role: handle.role,
    transaction: <Result>(
      callback: (
        transaction: CanonicalTranscriptTx,
        executor: ConversationProductPostgresExecutor,
      ) => Promise<Result>,
      options: Readonly<{
        isolationLevel: ConversationProductPostgresIsolationLevel;
      }>,
    ) =>
      connection.transaction(async (transaction, executor) => {
        const identity = await transaction.execute<{
          current_user: string;
          session_user: string;
        }>(sql`
          SELECT current_user::text AS current_user,
                 session_user::text AS session_user
          LIMIT 2
        `);
        const row = identity[0];
        if (
          identity.length !== 1
          || row?.current_user !== handle.role
          || row.session_user !== handle.role
        ) {
          throw new TypeError(
            "Canonical conversation transaction must authenticate directly as the verified ordinary product role",
          );
        }
        return callback(transaction, executor);
      }, options),
  }) as ConversationProductCanonicalTransactionRunner;
  verifiedCanonicalRunners.set(runner, handle);
  return runner;
}

function requiredString(
  row: ConversationProductDatabaseRow,
  name: string,
): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new TypeError(`Conversation product column ${name} must be text`);
  }
  return value;
}

function nullableString(
  row: ConversationProductDatabaseRow,
  name: string,
): string | null {
  return row[name] === null ? null : requiredString(row, name);
}

function requiredInteger(
  row: ConversationProductDatabaseRow,
  name: string,
): number {
  const value = row[name];
  const normalized = typeof value === "bigint"
    ? Number(value)
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
    ? Number(value)
    : value;
  if (
    typeof normalized !== "number"
    || !Number.isSafeInteger(normalized)
    || normalized < 0
  ) {
    throw new TypeError(
      `Conversation product column ${name} must be a safe counter`,
    );
  }
  return normalized;
}

function nullableInteger(
  row: ConversationProductDatabaseRow,
  name: string,
): number | null {
  return row[name] === null ? null : requiredInteger(row, name);
}

function requiredBytes(
  row: ConversationProductDatabaseRow,
  name: string,
): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Conversation product column ${name} must be bytea`);
  }
  return Uint8Array.from(value);
}

function nullableBytes(
  row: ConversationProductDatabaseRow,
  name: string,
): Uint8Array | null {
  return row[name] === null ? null : requiredBytes(row, name);
}

function nullableDate(
  row: ConversationProductDatabaseRow,
  name: string,
): Date | null {
  const value = row[name];
  if (value === null) return null;
  const date = value instanceof Date
    ? new Date(value.getTime())
    : typeof value === "string"
    ? new Date(value)
    : null;
  if (date === null || !Number.isFinite(date.getTime())) {
    throw new TypeError(
      `Conversation product column ${name} must be timestamptz`,
    );
  }
  return date;
}

function requiredDate(
  row: ConversationProductDatabaseRow,
  name: string,
): Date {
  const value = nullableDate(row, name);
  if (value === null) {
    throw new TypeError(`Conversation product column ${name} must be timestamptz`);
  }
  return value;
}

function requiredBoolean(
  row: ConversationProductDatabaseRow,
  name: string,
): boolean {
  const value = row[name];
  if (typeof value !== "boolean") {
    throw new TypeError(`Conversation product column ${name} must be boolean`);
  }
  return value;
}

function nullableBoolean(
  row: ConversationProductDatabaseRow,
  name: string,
): boolean | null {
  return row[name] === null ? null : requiredBoolean(row, name);
}

function oneOrNone(
  rows: readonly ConversationProductDatabaseRow[],
  label: string,
): ConversationProductDatabaseRow | null {
  if (rows.length > 1) {
    throw new Error(`${label} returned more than one row`);
  }
  return rows[0] ?? null;
}

function assertUuid(label: string, value: string): void {
  if (!UUID.test(value)) throw new TypeError(`${label} must be a canonical UUID`);
}

function assertDigest(label: string, value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(`${label} must contain exactly 32 bytes`);
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function editMemberOperationId(
  operationId: string,
  messageId: number,
): string {
  return `edit-member:v1:${
    bytesToHex(
      sha256(
        new TextEncoder().encode(
          `nautilo/conversation/edit-member/v1\n${operationId}\n${messageId}`,
        ),
      ),
    )
  }`;
}

function failureCode(
  row: ConversationProductDatabaseRow,
): ConversationFailureCode | null {
  const value = nullableString(row, "failure_code");
  if (value !== null && !FAILURE_CODES.has(value as ConversationFailureCode)) {
    throw new TypeError("Conversation failure code is invalid");
  }
  return value as ConversationFailureCode | null;
}

function lifecycleFromRow(
  row: ConversationProductDatabaseRow,
): ConversationRevisionLifecycle {
  const sessionId = requiredString(row, "session_id");
  const messageId = requiredInteger(row, "message_id");
  const revision = requiredInteger(row, "edit_revision");
  const roomId = requiredString(row, "room_id");
  const namespaceId = requiredString(row, "namespace_id_at_allocation");
  const objectId = requiredString(row, "crypto_object_id");
  const objectIdScheme = requiredString(row, "object_id_scheme");
  const representationMode = requiredString(row, "representation_mode");
  const publicationPolicyRevision = nullableInteger(row, "publication_policy_revision");
  const shadowOperationId = nullableString(row, "shadow_operation_id");
  const humanPeerShadowOperationId = nullableString(
    row,
    "human_peer_shadow_operation_id",
  );
  const sharedAgentShadowOperationId = nullableString(
    row,
    "shared_agent_shadow_operation_id",
  );
  const sharedAgentShadowExecutionId = nullableString(
    row,
    "shared_agent_shadow_execution_id",
  );
  const shadowTranscriptOrdinal = nullableInteger(
    row,
    "shadow_transcript_ordinal",
  );
  const shadowReservedCreatedAt = nullableDate(
    row,
    "shadow_reserved_created_at",
  );
  const shadowStreamId = nullableString(row, "shadow_stream_id");
  const shadowStreamStartDigest = nullableBytes(
    row,
    "shadow_stream_start_digest",
  );
  const shadowStreamTerminalDigest = nullableBytes(
    row,
    "shadow_stream_terminal_digest",
  );
  const shadowStreamedTextDigest = nullableBytes(
    row,
    "shadow_streamed_text_digest",
  );
  const shadowDurableEventDigest = nullableBytes(
    row,
    "shadow_durable_event_digest",
  );
  const payloadVersion = requiredInteger(row, "payload_version");
  const keyClass = requiredString(row, "key_class");
  const authorRole = requiredString(row, "author_role");
  const subthreadReplyClassification = requiredString(
    row,
    "subthread_reply_classification",
  );
  const completion = requiredString(row, "completion");
  const disposition = requiredString(row, "disposition");
  const parityStatus = requiredString(row, "parity_status");
  const attemptCount = requiredInteger(row, "attempt_count");
  const nextAttemptAt = nullableDate(row, "next_attempt_at");
  const leaseToken = nullableString(row, "lease_token");
  const leaseExpiresAt = nullableDate(row, "lease_expires_at");
  const appendIdempotencyKey = nullableString(
    row,
    "append_idempotency_key",
  );
  const allocationRequestDigest = requiredBytes(
    row,
    "allocation_request_digest",
  );
  const repairIdentityDigest = nullableBytes(row, "repair_identity_digest");
  const repairPublisherKind = nullableString(row, "repair_publisher_kind");
  const repairPublisherId = nullableString(row, "repair_publisher_id");
  const repairPublisherHumanId = nullableString(row, "repair_publisher_human_id");
  if ((repairPublisherKind === "human_device") !== (repairPublisherHumanId !== null)) {
    throw new TypeError("Conversation repairing Human evidence is incoherent");
  }
  if (repairPublisherHumanId !== null) assertUuid("Conversation repairing Human", repairPublisherHumanId);
  const repairAttestationDigest = nullableBytes(
    row,
    "repair_attestation_digest",
  );
  const terminalOperationId = nullableString(row, "terminal_operation_id");
  const terminalOperationGroupId = nullableString(
    row,
    "terminal_operation_group_id",
  );
  const terminalOperationType = nullableString(
    row,
    "terminal_operation_type",
  );
  const terminalExpectedRevision = nullableInteger(
    row,
    "terminal_expected_revision",
  );
  const terminalRequestDigest = nullableBytes(
    row,
    "terminal_request_digest",
  );

  assertConversationSessionId(sessionId);
  assertConversationMessageId(messageId);
  assertConversationRevision(revision);
  assertUuid("Conversation Room ID", roomId);
  assertUuid("Conversation Namespace ID", namespaceId);
  assertConversationDurableKey("conversation crypto object ID", objectId);
  if (
    objectIdScheme !== "message_v2"
    && objectIdScheme !== "live_shadow_v1"
    && objectIdScheme !== "human_message_edit_v1"
  ) throw new TypeError("Conversation object ID scheme is invalid");
  if (shadowOperationId !== null) {
    assertConversationDurableKey(
      "conversation Shadow operation ID",
      shadowOperationId,
    );
  }
  if (humanPeerShadowOperationId !== null) {
    assertConversationDurableKey(
      "conversation Human-peer Shadow operation ID",
      humanPeerShadowOperationId,
    );
  }
  if (sharedAgentShadowOperationId !== null) {
    assertConversationDurableKey(
      "conversation shared-Agent Shadow operation ID",
      sharedAgentShadowOperationId,
    );
  }
  if (sharedAgentShadowExecutionId !== null) {
    assertConversationDurableKey(
      "conversation shared-Agent Shadow execution ID",
      sharedAgentShadowExecutionId,
    );
  }
  const liveParentCount = [
    shadowOperationId,
    humanPeerShadowOperationId,
    sharedAgentShadowOperationId,
    sharedAgentShadowExecutionId,
  ].filter((value) => value !== null).length;
  if (
    objectIdScheme === "message_v2"
      ? liveParentCount !== 0
        || shadowTranscriptOrdinal !== null
        || shadowReservedCreatedAt !== null
        || shadowStreamId !== null
        || shadowStreamStartDigest !== null
        || shadowStreamTerminalDigest !== null
        || shadowStreamedTextDigest !== null
        || shadowDurableEventDigest !== null
      : objectIdScheme === "human_message_edit_v1"
        ? liveParentCount > 1
          || sharedAgentShadowExecutionId !== null
          || authorRole !== "user"
          || revision < 1
      : liveParentCount !== 1
        || shadowTranscriptOrdinal === null
        || shadowTranscriptOrdinal < 1
        || shadowReservedCreatedAt === null
  ) throw new TypeError("Conversation live object identity is incoherent");
  if (objectIdScheme === "human_message_edit_v1") {
    parseHumanMessageEditCryptoObjectIdV1(objectId, {
      sessionId,
      messageId,
      revision,
    });
  }
  const hasStreamEvidence = shadowStreamId !== null
    && shadowStreamStartDigest !== null
    && shadowStreamTerminalDigest !== null
    && shadowStreamedTextDigest !== null;
  if (
    hasStreamEvidence !== (
      shadowStreamId !== null
      || shadowStreamStartDigest !== null
      || shadowStreamTerminalDigest !== null
      || shadowStreamedTextDigest !== null
    )
  ) throw new TypeError("Conversation live stream evidence is incoherent");
  if (shadowStreamId !== null) {
    assertConversationDurableKey("Conversation live stream ID", shadowStreamId);
  }
  if (shadowStreamStartDigest !== null) {
    assertDigest("Conversation live stream start digest", shadowStreamStartDigest);
  }
  if (shadowStreamTerminalDigest !== null) {
    assertDigest(
      "Conversation live stream terminal digest",
      shadowStreamTerminalDigest,
    );
  }
  if (shadowStreamedTextDigest !== null) {
    assertDigest(
      "Conversation live streamed text digest",
      shadowStreamedTextDigest,
    );
  }
  if (shadowDurableEventDigest !== null) {
    assertDigest(
      "Conversation live durable event digest",
      shadowDurableEventDigest,
    );
  }
  assertConversationMessageKeyClass(keyClass);
  assertConversationAuthorRole(authorRole);
  if (
    subthreadReplyClassification !== "counted"
    && subthreadReplyClassification !== "excluded"
  ) {
    throw new TypeError(
      "Conversation Subthread reply classification is invalid",
    );
  }
  if (
    representationMode !== "shadow_encryption"
    && representationMode !== "full_encryption"
  ) throw new TypeError("Conversation representation mode is invalid");
  if (representationMode === "full_encryption" && publicationPolicyRevision === null) {
    throw new TypeError("Full conversation publication policy revision is unavailable");
  }
  assertDigest("Conversation allocation request digest", allocationRequestDigest);
  if (repairIdentityDigest !== null) {
    assertDigest("Conversation repair identity digest", repairIdentityDigest);
  }
  if (
    repairPublisherKind !== null
    && repairPublisherKind !== "foreground_runtime"
    && repairPublisherKind !== "human_device"
  ) throw new TypeError("Conversation repair publisher kind is invalid");
  if (repairPublisherId !== null) {
    assertConversationDurableKey(
      "conversation repair publisher ID",
      repairPublisherId,
    );
  }
  if (repairAttestationDigest !== null) {
    assertDigest(
      "Conversation repair attestation digest",
      repairAttestationDigest,
    );
  }
  const hasRepairWinner = repairPublisherKind !== null
    || repairPublisherId !== null
    || repairAttestationDigest !== null;
  if (
    (repairIdentityDigest === null && hasRepairWinner)
    || (hasRepairWinner && (
      repairPublisherKind === null
      || repairPublisherId === null
      || repairAttestationDigest === null
      || (completion !== "complete" && completion !== "pending")
    ))
  ) throw new TypeError("Conversation repair evidence is incoherent");
  if (payloadVersion !== CONVERSATION_MESSAGE_PAYLOAD_VERSION) {
    throw new TypeError("Conversation payload version is invalid");
  }
  if (completion !== "pending" && completion !== "complete") {
    throw new TypeError("Conversation completion is invalid");
  }
  if (!DISPOSITIONS.has(disposition as ConversationRevisionDisposition)) {
    throw new TypeError("Conversation disposition is invalid");
  }
  if (
    parityStatus !== "pending"
    && parityStatus !== "server_verified"
    && parityStatus !== "client_verified"
    && parityStatus !== "server_authenticated"
    && parityStatus !== "client_authenticated"
  ) throw new TypeError("Conversation parity status is invalid");
  if (attemptCount > CONVERSATION_RECONCILE_MAX_ATTEMPTS) {
    throw new TypeError("Conversation attempt count is out of bounds");
  }
  if (
    (disposition === "active" && nextAttemptAt === null)
    || (disposition !== "active" && nextAttemptAt !== null)
  ) throw new TypeError("Conversation retry schedule is incoherent");
  if (
    (leaseToken === null) !== (leaseExpiresAt === null)
    || (leaseToken !== null && disposition !== "active")
  ) throw new TypeError("Conversation lease is incoherent");
  if (leaseToken !== null) assertUuid("Conversation lease token", leaseToken);
  if (completion === "pending" && parityStatus !== "pending") {
    throw new TypeError("Pending crypto cannot have verified parity");
  }
  if (
    (parityStatus === "server_verified" || parityStatus === "server_authenticated")
    && (
      keyClass !== "ai"
      || (authorRole === "user" && repairPublisherKind !== "foreground_runtime")
    )
  ) throw new TypeError("Server parity authority is invalid");
  if (
    (attemptCount === CONVERSATION_RECONCILE_MAX_ATTEMPTS)
      !== (
        disposition === "quarantined"
        && row["failure_code"] === "retry_exhausted"
      )
  ) throw new TypeError("Conversation retry exhaustion is incoherent");
  if (appendIdempotencyKey !== null) {
    assertConversationDurableKey(
      "conversation append idempotency key",
      appendIdempotencyKey,
    );
  }
  if (
    (revision === 0) !== (appendIdempotencyKey !== null)
  ) throw new TypeError("Conversation append receipt is incoherent");
  if (terminalOperationId !== null) {
    assertConversationDurableKey(
      "conversation terminal operation ID",
      terminalOperationId,
    );
  }
  if (terminalOperationGroupId !== null) {
    assertConversationDurableKey(
      "conversation terminal operation group ID",
      terminalOperationGroupId,
    );
  }
  if (
    terminalOperationType !== null
    && !TERMINAL_TYPES.has(
      terminalOperationType as ConversationTerminalOperationType,
    )
  ) throw new TypeError("Conversation terminal operation type is invalid");
  if (terminalRequestDigest !== null) {
    assertDigest(
      "Conversation terminal request digest",
      terminalRequestDigest,
    );
  }
  const terminal = disposition === "superseded" || disposition === "hard_delete";
  if (
    terminal
      !== (
        terminalOperationId !== null
        && terminalOperationType !== null
        && terminalExpectedRevision === revision
        && terminalRequestDigest !== null
      )
  ) throw new TypeError("Conversation terminal receipt is incoherent");
  if (
    (disposition === "superseded")
      !== (terminalOperationGroupId !== null)
  ) throw new TypeError("Conversation edit group receipt is incoherent");
  if (
    (disposition === "superseded" && terminalOperationType !== "edit")
    || (disposition === "hard_delete" && terminalOperationType !== "delete")
  ) throw new TypeError("Conversation terminal operation type is incoherent");

  const lifecycle = Object.freeze({
    sequence: requiredInteger(row, "sequence"),
    sessionId,
    messageId,
    revision,
    roomId,
    namespaceIdAtAllocation: namespaceId,
    cryptoObjectId: objectId,
    objectIdScheme,
    representationMode,
    publicationPolicyRevision,
    shadowOperationId,
    humanPeerShadowOperationId,
    sharedAgentShadowOperationId,
    sharedAgentShadowExecutionId,
    shadowTranscriptOrdinal,
    shadowReservedCreatedAt,
    shadowStreamId,
    shadowStreamStartDigest,
    shadowStreamTerminalDigest,
    shadowStreamedTextDigest,
    shadowDurableEventDigest,
    keyClass,
    authorRole,
    subthreadReplyClassification,
    completion,
    disposition: disposition as ConversationRevisionDisposition,
    parityStatus,
    attemptCount,
    nextAttemptAt,
    failureCode: failureCode(row),
    leaseToken,
    leaseExpiresAt,
    appendIdempotencyKey,
    allocationRequestDigest,
    repairIdentityDigest,
    repairPublisherKind,
    repairPublisherId,
    repairPublisherHumanId,
    repairSourceRevision: row["repair_source_revision"] == null ? null : requiredInteger(row, "repair_source_revision"),
    repairSourceDigest: nullableBytes(row, "repair_source_digest"),
    repairAttestationDigest,
    terminalOperationId,
    terminalOperationType:
      terminalOperationType as ConversationTerminalOperationType | null,
    terminalExpectedRevision,
    terminalRequestDigest,
  });
  const quarantineLeaseToken = nullableString(
    row,
    "quarantine_lease_token",
  );
  if (quarantineLeaseToken !== null) {
    assertUuid(
      "Conversation quarantine receipt lease token",
      quarantineLeaseToken,
    );
    if (
      disposition !== "quarantined"
      || leaseToken !== null
      || leaseExpiresAt !== null
    ) throw new TypeError("Conversation quarantine receipt is incoherent");
  }
  if (disposition === "hard_delete") {
    deleteEffectsFromRow(row, lifecycle);
  } else if (
    [
      "delete_was_unread",
      "delete_orphaned_turn_id",
      "delete_root_parent_room_id",
      "delete_root_anchor_message_id",
      "delete_root_reply_count",
      "delete_root_last_reply_at",
      "delete_root_summary_revision",
    ].some((name) => row[name] !== null)
  ) {
    throw new TypeError(
      "Conversation non-delete lifecycle carries hard-delete effects",
    );
  }
  return lifecycle;
}

function deleteEffectsFromRow(
  row: ConversationProductDatabaseRow,
  lifecycle: ConversationRevisionLifecycle,
): ConversationDeleteEffects {
  const wasUnread = nullableBoolean(row, "delete_was_unread");
  const orphanedTurnId = nullableString(row, "delete_orphaned_turn_id");
  const parentRoomId = nullableString(
    row,
    "delete_root_parent_room_id",
  );
  const anchorMessageId = nullableInteger(
    row,
    "delete_root_anchor_message_id",
  );
  const replyCount = nullableInteger(row, "delete_root_reply_count");
  const lastReplyAt = nullableDate(row, "delete_root_last_reply_at");
  const summaryRevision = nullableInteger(
    row,
    "delete_root_summary_revision",
  );
  if (lifecycle.disposition !== "hard_delete" || wasUnread === null) {
    throw new TypeError("Conversation hard-delete effects are incoherent");
  }
  if (orphanedTurnId !== null) {
    assertConversationDurableKey(
      "conversation orphaned attachment turn ID",
      orphanedTurnId,
    );
  }
  const hasRoot = parentRoomId !== null
    || anchorMessageId !== null
    || replyCount !== null
    || summaryRevision !== null;
  if (
    hasRoot
      !== (
        parentRoomId !== null
        && anchorMessageId !== null
        && replyCount !== null
        && summaryRevision !== null
      )
  ) throw new TypeError("Conversation hard-delete root summary is incoherent");
  if (parentRoomId !== null) {
    assertUuid("Conversation delete parent Room ID", parentRoomId);
    if (
      (replyCount === 0 && lastReplyAt !== null)
      || (replyCount! > 0 && lastReplyAt === null)
    ) {
      throw new TypeError(
        "Conversation hard-delete root summary timestamp is incoherent",
      );
    }
  }
  return Object.freeze({
    roomId: lifecycle.roomId,
    wasUnread,
    orphanedTurnId,
    rootSummary: parentRoomId === null
      ? null
      : Object.freeze({
        parentRoomId,
        anchorMessageId: anchorMessageId!,
        replyCount: replyCount!,
        lastReplyAt,
        revision: summaryRevision!,
      }),
  });
}

function messageFromJoinedRow(
  row: ConversationProductDatabaseRow,
  lifecycle: ConversationRevisionLifecycle,
): ConversationProductMessage | null {
  if (row["current_message_id"] === null) return null;
  const messageId = requiredInteger(row, "current_message_id");
  const sessionId = requiredString(row, "current_message_session_id");
  const role = requiredString(row, "current_message_role");
  const revision = requiredInteger(row, "current_message_edit_revision");
  const content = nullableString(row, "current_message_content");
  const objectId = nullableString(row, "current_message_crypto_object_id");
  assertConversationMessageId(messageId);
  assertConversationSessionId(sessionId);
  assertConversationRevision(revision);
  assertConversationAuthorRole(role);
  if (
    messageId !== lifecycle.messageId
    || sessionId !== lifecycle.sessionId
    || revision !== lifecycle.revision
    || role !== lifecycle.authorRole
  ) throw new TypeError("Conversation current message join is inconsistent");
  if (objectId !== null) {
    assertConversationDurableKey("conversation message mapping", objectId);
  }
  return Object.freeze({
    sessionId,
    messageId,
    roomId: lifecycle.roomId,
    content,
    revision,
    keyClass: lifecycle.keyClass,
    authorRole: role,
    cryptoObjectId: objectId,
  });
}

function stateFromRow(
  row: ConversationProductDatabaseRow,
): ConversationRevisionState {
  const lifecycle = lifecycleFromRow(row);
  return Object.freeze({
    lifecycle,
    message: messageFromJoinedRow(row, lifecycle),
  });
}

function mappingStateFromRow(
  row: ConversationProductDatabaseRow,
): ConversationRevisionMappingState {
  const lifecycle = lifecycleFromRow(row);
  if (row["current_message_id"] === null) {
    return Object.freeze({ lifecycle, message: null });
  }
  const messageId = requiredInteger(row, "current_message_id");
  const sessionId = requiredString(row, "current_message_session_id");
  const role = requiredString(row, "current_message_role");
  const revision = requiredInteger(row, "current_message_edit_revision");
  const cryptoObjectId = nullableString(row, "current_message_crypto_object_id");
  assertConversationMessageId(messageId);
  assertConversationSessionId(sessionId);
  assertConversationRevision(revision);
  assertConversationAuthorRole(role);
  if (
    messageId !== lifecycle.messageId
    || sessionId !== lifecycle.sessionId
    || revision !== lifecycle.revision
    || role !== lifecycle.authorRole
  ) throw new TypeError("Conversation current message mapping is inconsistent");
  if (cryptoObjectId !== null) {
    assertConversationDurableKey("conversation message mapping", cryptoObjectId);
  }
  return Object.freeze({
    lifecycle,
    message: Object.freeze({
      sessionId,
      messageId,
      revision,
      authorRole: role,
      cryptoObjectId,
    }),
  });
}

function parityAllowed(
  lifecycle: ConversationRevisionLifecycle,
  parity: ConversationParityStatus,
  repairPublication?: ConversationRepairPublicationEvidence,
): boolean {
  if (!conversationVerificationMatchesRepresentation(lifecycle.representationMode, parity)) {
    return false;
  }
  return parity === "pending"
    || (
      (parity === "server_verified" || parity === "server_authenticated")
      && lifecycle.keyClass === "ai"
      && (
        lifecycle.authorRole !== "user"
        || (
          lifecycle.repairIdentityDigest !== null
          && repairPublication?.publisherKind === "foreground_runtime"
        )
      )
    )
    || (
      (parity === "client_verified" || parity === "client_authenticated")
    );
}

function leaseMatches(
  row: ConversationProductDatabaseRow,
  lifecycle: ConversationRevisionLifecycle,
  token: string | null,
): boolean {
  return lifecycle.leaseToken === token
    && (token === null || requiredBoolean(row, "lease_is_live"));
}

function assertFailureCode(value: ConversationFailureCode): void {
  if (!FAILURE_CODES.has(value)) {
    throw new TypeError("Conversation failure code is invalid");
  }
}

const LIFECYCLE_COLUMNS = `lifecycle.sequence,
       lifecycle.session_id,
       lifecycle.message_id,
       lifecycle.edit_revision,
       lifecycle.room_id,
       lifecycle.namespace_id_at_allocation,
       lifecycle.crypto_object_id,
       lifecycle.object_id_scheme,
       lifecycle.representation_mode,
       lifecycle.publication_policy_revision,
       lifecycle.shadow_operation_id,
       lifecycle.human_peer_shadow_operation_id,
       lifecycle.shared_agent_shadow_operation_id,
       lifecycle.shared_agent_shadow_execution_id,
       lifecycle.shadow_transcript_ordinal,
       lifecycle.shadow_reserved_created_at,
       lifecycle.shadow_stream_id,
       lifecycle.shadow_stream_start_digest,
       lifecycle.shadow_stream_terminal_digest,
       lifecycle.shadow_streamed_text_digest,
       lifecycle.shadow_durable_event_digest,
       lifecycle.payload_version,
       lifecycle.key_class,
       lifecycle.author_role,
       lifecycle.subthread_reply_classification,
       lifecycle.completion,
       lifecycle.disposition,
       lifecycle.parity_status,
       lifecycle.attempt_count,
       lifecycle.next_attempt_at,
       lifecycle.failure_code,
       lifecycle.lease_token,
       lifecycle.lease_expires_at,
       lifecycle.append_idempotency_key,
       lifecycle.allocation_request_digest,
       lifecycle.repair_identity_digest,
       lifecycle.repair_source_revision,
       lifecycle.repair_source_digest,
       lifecycle.repair_publisher_kind,
       lifecycle.repair_publisher_id,
       lifecycle.repair_publisher_human_id,
       lifecycle.repair_attestation_digest,
       lifecycle.terminal_operation_id,
       lifecycle.terminal_operation_group_id,
       lifecycle.terminal_operation_type,
       lifecycle.terminal_expected_revision,
       lifecycle.terminal_request_digest,
       lifecycle.quarantine_lease_token,
       lifecycle.delete_was_unread,
       lifecycle.delete_orphaned_turn_id,
       lifecycle.delete_root_parent_room_id,
       lifecycle.delete_root_anchor_message_id,
       lifecycle.delete_root_reply_count,
       lifecycle.delete_root_last_reply_at,
       lifecycle.delete_root_summary_revision`;

const JOINED_MESSAGE_COLUMNS = `current_message.id AS current_message_id,
       current_message.session_id AS current_message_session_id,
       current_message.role AS current_message_role,
       current_message.content AS current_message_content,
       current_message.edit_revision AS current_message_edit_revision,
       current_message.crypto_object_id AS current_message_crypto_object_id`;

const lifecycleSelection = {
  sequence: sessionMessageCryptoRevisions.sequence,
  session_id: sessionMessageCryptoRevisions.sessionId,
  message_id: sessionMessageCryptoRevisions.messageId,
  edit_revision: sessionMessageCryptoRevisions.editRevision,
  room_id: sessionMessageCryptoRevisions.roomId,
  namespace_id_at_allocation:
    sessionMessageCryptoRevisions.namespaceIdAtAllocation,
  crypto_object_id: sessionMessageCryptoRevisions.cryptoObjectId,
  object_id_scheme: sessionMessageCryptoRevisions.objectIdScheme,
  representation_mode: sessionMessageCryptoRevisions.representationMode,
  publication_policy_revision: sessionMessageCryptoRevisions.publicationPolicyRevision,
  shadow_operation_id: sessionMessageCryptoRevisions.shadowOperationId,
  human_peer_shadow_operation_id:
    sessionMessageCryptoRevisions.humanPeerShadowOperationId,
  shared_agent_shadow_operation_id:
    sessionMessageCryptoRevisions.sharedAgentShadowOperationId,
  shared_agent_shadow_execution_id:
    sessionMessageCryptoRevisions.sharedAgentShadowExecutionId,
  shadow_transcript_ordinal:
    sessionMessageCryptoRevisions.shadowTranscriptOrdinal,
  shadow_reserved_created_at:
    sessionMessageCryptoRevisions.shadowReservedCreatedAt,
  shadow_stream_id: sessionMessageCryptoRevisions.shadowStreamId,
  shadow_stream_start_digest:
    sessionMessageCryptoRevisions.shadowStreamStartDigest,
  shadow_stream_terminal_digest:
    sessionMessageCryptoRevisions.shadowStreamTerminalDigest,
  shadow_streamed_text_digest:
    sessionMessageCryptoRevisions.shadowStreamedTextDigest,
  shadow_durable_event_digest:
    sessionMessageCryptoRevisions.shadowDurableEventDigest,
  payload_version: sessionMessageCryptoRevisions.payloadVersion,
  key_class: sessionMessageCryptoRevisions.keyClass,
  author_role: sessionMessageCryptoRevisions.authorRole,
  subthread_reply_classification:
    sessionMessageCryptoRevisions.subthreadReplyClassification,
  completion: sessionMessageCryptoRevisions.completion,
  disposition: sessionMessageCryptoRevisions.disposition,
  parity_status: sessionMessageCryptoRevisions.parityStatus,
  attempt_count: sessionMessageCryptoRevisions.attemptCount,
  next_attempt_at: sessionMessageCryptoRevisions.nextAttemptAt,
  failure_code: sessionMessageCryptoRevisions.failureCode,
  lease_token: sessionMessageCryptoRevisions.leaseToken,
  lease_expires_at: sessionMessageCryptoRevisions.leaseExpiresAt,
  append_idempotency_key:
    sessionMessageCryptoRevisions.appendIdempotencyKey,
  allocation_request_digest:
    sessionMessageCryptoRevisions.allocationRequestDigest,
  repair_identity_digest: sessionMessageCryptoRevisions.repairIdentityDigest,
  repair_source_revision: sessionMessageCryptoRevisions.repairSourceRevision,
  repair_source_digest: sessionMessageCryptoRevisions.repairSourceDigest,
  repair_publisher_kind: sessionMessageCryptoRevisions.repairPublisherKind,
  repair_publisher_id: sessionMessageCryptoRevisions.repairPublisherId,
  repair_publisher_human_id: sessionMessageCryptoRevisions.repairPublisherHumanId,
  repair_attestation_digest:
    sessionMessageCryptoRevisions.repairAttestationDigest,
  terminal_operation_id: sessionMessageCryptoRevisions.terminalOperationId,
  terminal_operation_group_id:
    sessionMessageCryptoRevisions.terminalOperationGroupId,
  terminal_operation_type:
    sessionMessageCryptoRevisions.terminalOperationType,
  terminal_expected_revision:
    sessionMessageCryptoRevisions.terminalExpectedRevision,
  terminal_request_digest:
    sessionMessageCryptoRevisions.terminalRequestDigest,
  quarantine_lease_token:
    sessionMessageCryptoRevisions.quarantineLeaseToken,
  delete_was_unread: sessionMessageCryptoRevisions.deleteWasUnread,
  delete_orphaned_turn_id:
    sessionMessageCryptoRevisions.deleteOrphanedTurnId,
  delete_root_parent_room_id:
    sessionMessageCryptoRevisions.deleteRootParentRoomId,
  delete_root_anchor_message_id:
    sessionMessageCryptoRevisions.deleteRootAnchorMessageId,
  delete_root_reply_count:
    sessionMessageCryptoRevisions.deleteRootReplyCount,
  delete_root_last_reply_at:
    sessionMessageCryptoRevisions.deleteRootLastReplyAt,
  delete_root_summary_revision:
    sessionMessageCryptoRevisions.deleteRootSummaryRevision,
} as const;

const joinedMessageSelection = {
  current_message_id: sql`${sessionMessages.id}`.as("current_message_id"),
  current_message_session_id: sql`${sessionMessages.sessionId}`
    .as("current_message_session_id"),
  current_message_role: sql`${sessionMessages.role}`.as("current_message_role"),
  current_message_content: sql`${sessionMessages.content}`
    .as("current_message_content"),
  current_message_edit_revision: sql`${sessionMessages.editRevision}`
    .as("current_message_edit_revision"),
  current_message_crypto_object_id: sql`${sessionMessages.cryptoObjectId}`
    .as("current_message_crypto_object_id"),
} as const;

const joinedMessageMappingSelection = {
  current_message_id: joinedMessageSelection.current_message_id,
  current_message_session_id: joinedMessageSelection.current_message_session_id,
  current_message_role: joinedMessageSelection.current_message_role,
  current_message_edit_revision: joinedMessageSelection.current_message_edit_revision,
  current_message_crypto_object_id: joinedMessageSelection.current_message_crypto_object_id,
} as const;

async function serializable<Result>(
  handle: ConversationProductPostgresHandle,
  callback: (
    transaction: ConversationProductPostgresTransaction,
  ) => Promise<Result>,
): Promise<Result> {
  return handle.transaction(callback, { isolationLevel: "serializable" });
}

async function readCommitted<Result>(
  handle: ConversationProductPostgresHandle,
  callback: (
    transaction: ConversationProductPostgresTransaction,
  ) => Promise<Result>,
): Promise<Result> {
  return handle.transaction(callback, { isolationLevel: "read committed" });
}

/** Serialize new publication with loss of the exact shared execution authority. */
async function lockLiveShadowExecutionForPublication(
  transaction: CanonicalTranscriptTx,
  lifecycle: ConversationRevisionLifecycle,
): Promise<boolean> {
  if (lifecycle.sharedAgentShadowExecutionId === null) return true;
  const rows = canonicalRows(await transaction.select({
    state: conversationSharedAgentShadowExecutions.state,
  }).from(conversationSharedAgentShadowExecutions).where(eq(
    conversationSharedAgentShadowExecutions.executionId,
    lifecycle.sharedAgentShadowExecutionId,
  )).for("update", { of: conversationSharedAgentShadowExecutions }).limit(2));
  const execution = oneOrNone(rows, "Live Shadow publication execution");
  return execution !== null && requiredString(execution, "state") === "running";
}

async function canonicalTransaction<Result>(
  runner: ConversationProductCanonicalTransactionRunner,
  callback: (
    transaction: CanonicalTranscriptTx,
    executor: ConversationProductPostgresExecutor,
  ) => Promise<Result>,
  isolationLevel: ConversationProductPostgresIsolationLevel,
): Promise<Result> {
  for (
    let attempt = 1;
    attempt <= MAXIMUM_SERIALIZABLE_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await runner.transaction(callback, { isolationLevel });
    } catch (error) {
      if (
        !isRetryableTransactionFailure(error)
        || attempt === MAXIMUM_SERIALIZABLE_ATTEMPTS
      ) throw error;
    }
  }
  throw new Error("Unreachable canonical conversation transaction retry state");
}

function canonicalRows<Row extends ConversationProductDatabaseRow>(
  rows: Iterable<Row>,
): readonly Row[] {
  return Array.from(rows);
}

async function canonicalDeleteReplay(
  transaction: CanonicalTranscriptTx,
  input: {
    readonly messageId: number;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly requestDigest: Uint8Array;
  },
): Promise<ConversationProductDeleteResult | null> {
  const rows = canonicalRows(await transaction.select(lifecycleSelection)
    .from(sessionMessageCryptoRevisions).where(eq(
      sessionMessageCryptoRevisions.terminalOperationId,
      input.operationId,
    )).limit(2));
  const row = oneOrNone(rows, "Conversation terminal receipt");
  if (row === null) return null;
  const lifecycle = lifecycleFromRow(row);
  const exact = lifecycle.messageId === input.messageId
    && lifecycle.revision === input.expectedRevision
    && lifecycle.terminalOperationType === "delete"
    && lifecycle.terminalRequestDigest !== null
    && bytesEqual(lifecycle.terminalRequestDigest, input.requestDigest);
  if (!exact) return { status: "conflict" };
  return {
    status: "replayed",
    lifecycle,
    effects: deleteEffectsFromRow(row, lifecycle),
  };
}

async function canonicalEditReplay(
  transaction: CanonicalTranscriptTx,
  input: {
    readonly messageId: number;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly requestDigest: Uint8Array;
  },
): Promise<ConversationProductEditResult | null> {
  const receiptRows = canonicalRows(
    await transaction.select(lifecycleSelection)
      .from(sessionMessageCryptoRevisions).where(eq(
        sessionMessageCryptoRevisions.terminalOperationId,
        input.operationId,
      )).limit(2),
  );
  const receiptRow = oneOrNone(receiptRows, "Conversation edit receipt");
  if (receiptRow === null) return null;
  const receipt = lifecycleFromRow(receiptRow);
  const exact = receipt.messageId === input.messageId
    && receipt.revision === input.expectedRevision
    && receipt.terminalOperationType === "edit"
    && nullableString(receiptRow, "terminal_operation_group_id")
      === input.operationId
    && receipt.terminalRequestDigest !== null
    && bytesEqual(receipt.terminalRequestDigest, input.requestDigest);
  if (!exact) return { status: "conflict" };

  const groupMember = alias(sessionMessageCryptoRevisions, "group_member");
  const previous = alias(sessionMessageCryptoRevisions, "previous");
  const nextRows = canonicalRows(await transaction.select({
    ...lifecycleSelection,
    edit_logical_message_key: sessionMessages.fingerprint,
    edit_committed_at: sessionMessageCryptoRevisions.createdAt,
    edit_group_size: sql<number>`(
      SELECT count(*)::integer
        FROM session_message_crypto_revisions AS group_member
       WHERE ${groupMember.terminalOperationGroupId} = ${input.operationId}
         AND ${groupMember.editRevision} = ${input.expectedRevision}
    )`.as("edit_group_size"),
  }).from(sessionMessageCryptoRevisions).innerJoin(
    sessionMessages,
    eq(sessionMessages.id, sessionMessageCryptoRevisions.messageId),
  ).where(and(
    eq(
      sessionMessageCryptoRevisions.editRevision,
      input.expectedRevision + 1,
    ),
    sql`EXISTS (
      SELECT 1 FROM session_message_crypto_revisions AS previous
       WHERE ${previous.terminalOperationGroupId} = ${input.operationId}
         AND ${previous.editRevision} = ${input.expectedRevision}
         AND ${previous.sessionId} = ${sessionMessageCryptoRevisions.sessionId}
         AND ${previous.messageId} = ${sessionMessageCryptoRevisions.messageId}
    )`,
  )).orderBy(asc(sessionMessageCryptoRevisions.messageId)));
  if (nextRows.length === 0) {
    throw new Error("Conversation edit receipt lost its allocated group");
  }
  const expectedGroupSize = requiredInteger(
    nextRows[0]!,
    "edit_group_size",
  );
  if (
    expectedGroupSize !== nextRows.length
    || nextRows.some(
      (row) => requiredInteger(row, "edit_group_size") !== expectedGroupSize,
    )
  ) {
    throw new Error("Conversation edit receipt has an incomplete group");
  }
  const rawLogicalMessageKey = nextRows[0]!["edit_logical_message_key"];
  const committedLogicalMessageKey = rawLogicalMessageKey === null || rawLogicalMessageKey === undefined
    ? null
    : logicalMessageKey({
      id: input.messageId,
      role: "user",
      fingerprint: requiredString(nextRows[0]!, "edit_logical_message_key"),
    });
  return {
    status: "replayed",
    lifecycles: Object.freeze(nextRows.map(lifecycleFromRow)),
    ...(committedLogicalMessageKey === null ? {} : {
      committedProjection: {
        logicalMessageKey: committedLogicalMessageKey,
        editedAt: requiredDate(nextRows[0]!, "edit_committed_at"),
      },
    }),
  };
}

export class PostgresConversationProductStore
  implements
    ConversationProductStorePort,
    ConversationExistingRepresentationProductStorePort,
    ConversationOrdinaryRepairProductStorePort
{
  readonly roomNamespaceInvariant = IMMUTABLE_ROOM_NAMESPACE_INVARIANT;

  constructor(
    private readonly handle: ConversationProductPostgresHandle,
    private readonly canonicalRunner:
      ConversationProductCanonicalTransactionRunner,
  ) {
    assertVerifiedConversationProductPostgresHandle(handle);
    assertConversationProductCanonicalTransactionRunner(handle, canonicalRunner);
  }

  async reserveLiveShadowAgent(
    input: ConversationLiveShadowAgentReservationInput,
  ): Promise<ConversationLiveShadowAgentReservationResult> {
    assertConversationSessionId(input.sessionId);
    assertConversationDurableKey("live Shadow operation ID", input.operationId);
    assertConversationAuthorRole(input.authorRole);
    assertConversationSubthreadReplyClassification(
      input.subthreadReplyClassification,
    );
    assertDigest("live Shadow Agent reservation digest", input.requestDigest);
    if (
      (input.authorRole !== "assistant" && input.authorRole !== "tool")
      || !Number.isSafeInteger(input.transcriptOrdinal)
      || input.transcriptOrdinal < 2
      || !Number.isSafeInteger(input.createdAt)
      || input.createdAt < 0
    ) throw new TypeError("Live Shadow Agent reservation is invalid");

    return canonicalTransaction(this.canonicalRunner, async (transaction) => {
      if (input.publicationPolicy !== undefined) {
        await acquireEncryptionPublicationFence(transaction, input.publicationPolicy);
      }
      await transaction.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext(${input.operationId}),
          ${input.transcriptOrdinal}
        )
      `);
      const existingRows = canonicalRows(
        await transaction.select(lifecycleSelection)
          .from(sessionMessageCryptoRevisions)
          .where(and(
            or(
              eq(
                sessionMessageCryptoRevisions.shadowOperationId,
                input.operationId,
              ),
              eq(
                sessionMessageCryptoRevisions.sharedAgentShadowExecutionId,
                input.operationId,
              ),
            ),
            eq(
              sessionMessageCryptoRevisions.shadowTranscriptOrdinal,
              input.transcriptOrdinal,
            ),
          )).for("update", { of: sessionMessageCryptoRevisions }).limit(2),
      );
      const existing = oneOrNone(
        existingRows,
        "Live Shadow Agent reservation",
      );
      if (existing !== null) {
        const lifecycle = lifecycleFromRow(existing);
        const expectedRepresentationMode = input.publicationPolicy?.representation === "protected_only"
          ? "full_encryption"
          : "shadow_encryption";
        const expectedPolicyRevision = expectedRepresentationMode === "full_encryption"
          ? input.publicationPolicy!.expectedRevision
          : null;
        return lifecycle.sessionId === input.sessionId
            && lifecycle.authorRole === input.authorRole
            && lifecycle.objectIdScheme === "live_shadow_v1"
            && lifecycle.representationMode === expectedRepresentationMode
            && lifecycle.publicationPolicyRevision === expectedPolicyRevision
            && lifecycle.shadowReservedCreatedAt?.getTime() === input.createdAt
            && lifecycle.subthreadReplyClassification
              === input.subthreadReplyClassification
            && bytesEqual(
              lifecycle.allocationRequestDigest,
              input.requestDigest,
            )
          ? Object.freeze({
              status: "replayed" as const,
              allocation: Object.freeze({
                status: "replayed" as const,
                sessionId: lifecycle.sessionId,
                messageId: lifecycle.messageId,
                revision: lifecycle.revision,
                roomId: lifecycle.roomId,
                namespaceId: lifecycle.namespaceIdAtAllocation,
                keyClass: lifecycle.keyClass,
                authorRole: lifecycle.authorRole,
                cryptoObjectId: lifecycle.cryptoObjectId,
              }),
              createdAt: input.createdAt,
            })
          : Object.freeze({ status: "conflict" as const });
      }

      const turnRows = canonicalRows(
        await transaction.select({
          state: conversationShadowTurnOperations.state,
          session_id: conversationShadowTurnOperations.sessionId,
          room_id: conversationShadowTurnOperations.roomId,
          namespace_id: conversationShadowTurnOperations.namespaceId,
        }).from(conversationShadowTurnOperations)
          .where(eq(
            conversationShadowTurnOperations.operationId,
            input.operationId,
          ))
          .for("update", { of: conversationShadowTurnOperations }).limit(2),
      );
      const turn = oneOrNone(turnRows, "Live Shadow Agent turn");
      const sharedRows = turn === null
        ? canonicalRows(await transaction.select({
          state: conversationSharedAgentShadowExecutions.state,
          invocation_id: conversationSharedAgentShadowExecutions.invocationId,
          session_id: conversationSharedAgentShadowExecutions.sessionId,
          room_id: conversationSharedAgentShadowExecutions.roomId,
          namespace_id: rooms.namespaceId,
        }).from(conversationSharedAgentShadowExecutions)
          .innerJoin(
            rooms,
            eq(rooms.id, conversationSharedAgentShadowExecutions.roomId),
          )
          .where(eq(
            conversationSharedAgentShadowExecutions.executionId,
            input.operationId,
          ))
          .for("update", { of: conversationSharedAgentShadowExecutions })
          .limit(2))
        : [];
      const shared = turn === null
        ? oneOrNone(sharedRows, "Shared-Agent execution")
        : null;
      const parent = turn ?? shared;
      const sharedParent = shared !== null;
      const sharedInvocationId = shared === null
        ? null
        : nullableString(shared, "invocation_id");
      if (
        parent === null
        || !(sharedParent ? ["authorized", "running"] : ["human_verified", "running"])
          .includes(requiredString(parent, "state"))
        || requiredString(parent, "session_id") !== input.sessionId
      ) return Object.freeze({ status: "stale" as const });
      const roomId = requiredString(parent, "room_id");
      const namespaceId = requiredString(parent, "namespace_id");
      assertUuid("Live Shadow Room ID", roomId);
      assertUuid("Live Shadow Namespace ID", namespaceId);
      await acquireRoomWriteLock(transaction, roomId);
      const messageId = await reserveCanonicalTranscriptMessageIdInTx(
        transaction,
      );
      const cryptoObjectId = deriveLiveShadowMessageCryptoObjectIdV1({
        operationId: input.operationId,
        sessionId: input.sessionId,
        messageId,
        revision: 0,
        transcriptOrdinal: input.transcriptOrdinal,
        authorRole: input.authorRole,
      });
      const idempotencyHash = bytesToHex(sha256(
        new TextEncoder().encode(
          `${input.operationId}\n${input.transcriptOrdinal}`,
        ),
      ));
      const inserted = canonicalRows(
        await transaction.insert(sessionMessageCryptoRevisions).values({
          sessionId: input.sessionId,
          messageId,
          editRevision: 0,
          roomId,
          namespaceIdAtAllocation: namespaceId,
          cryptoObjectId,
          objectIdScheme: "live_shadow_v1",
          representationMode: input.publicationPolicy?.representation === "protected_only"
            ? "full_encryption"
            : "shadow_encryption",
          publicationPolicyRevision: input.publicationPolicy?.representation === "protected_only"
            ? input.publicationPolicy.expectedRevision
            : null,
          shadowOperationId: sharedParent ? null : input.operationId,
          humanPeerShadowOperationId: null,
          sharedAgentShadowOperationId: null,
          sharedAgentShadowExecutionId:
            sharedParent ? input.operationId : null,
          shadowTranscriptOrdinal: input.transcriptOrdinal,
          shadowReservedCreatedAt: new Date(input.createdAt),
          payloadVersion: CONVERSATION_MESSAGE_PAYLOAD_VERSION,
          keyClass: "ai",
          authorRole: input.authorRole,
          subthreadReplyClassification:
            input.subthreadReplyClassification,
          appendIdempotencyKey: `live-agent:${idempotencyHash}`,
          allocationRequestDigest: Uint8Array.from(input.requestDigest),
          completion: "pending",
          disposition: "active",
          parityStatus: "pending",
          attemptCount: 0,
          nextAttemptAt: sql`CURRENT_TIMESTAMP`,
        }).returning(lifecycleSelection),
      );
      const insertedRow = oneOrNone(
        inserted,
        "Live Shadow Agent reservation insert",
      );
      if (insertedRow === null) {
        throw new Error("Live Shadow Agent reservation was not inserted");
      }
      if (sharedParent) {
        await transaction.update(conversationSharedAgentShadowExecutions).set({
          state: "running",
          updatedAt: new Date(),
        }).where(and(
          eq(
            conversationSharedAgentShadowExecutions.executionId,
            input.operationId,
          ),
          inArray(
            conversationSharedAgentShadowExecutions.state,
            ["authorized", "running"],
          ),
        ));
        if (sharedInvocationId !== null) {
          await transaction.update(
            conversationSharedAgentShadowInvocations,
          ).set({
            state: "running",
            updatedAt: new Date(),
          }).where(and(
            eq(
              conversationSharedAgentShadowInvocations.invocationId,
              sharedInvocationId,
            ),
            eq(conversationSharedAgentShadowInvocations.state, "authorized"),
          ));
        }
      } else {
        await transaction.update(conversationShadowTurnOperations).set({
          state: "running",
          startedAt: sql`COALESCE(${conversationShadowTurnOperations.startedAt}, CURRENT_TIMESTAMP)`,
          updatedAt: new Date(),
        }).where(and(
          eq(
            conversationShadowTurnOperations.operationId,
            input.operationId,
          ),
          inArray(
            conversationShadowTurnOperations.state,
            ["human_verified", "running"],
          ),
        ));
      }
      const lifecycle = lifecycleFromRow(insertedRow);
      return Object.freeze({
        status: "reserved" as const,
        allocation: Object.freeze({
          status: "allocated" as const,
          sessionId: lifecycle.sessionId,
          messageId: lifecycle.messageId,
          revision: lifecycle.revision,
          roomId: lifecycle.roomId,
          namespaceId: lifecycle.namespaceIdAtAllocation,
          keyClass: lifecycle.keyClass,
          authorRole: lifecycle.authorRole,
          cryptoObjectId: lifecycle.cryptoObjectId,
        }),
        createdAt: input.createdAt,
      });
    }, "read committed");
  }

  async publishReservedLiveShadowAgent(
    input: ConversationLiveShadowAgentPublishInput,
  ): Promise<ConversationProductAppendResult> {
    assertProductPublicationRepresentation(input);
    assertConversationSessionId(input.sessionId);
    assertConversationDurableKey("live Shadow operation ID", input.operationId);
    assertConversationMessageId(input.reservedMessageId);
    assertConversationAuthorRole(input.authorRole);
    assertConversationNotificationEligibility(
      input.structuralProjection.notificationEligibility,
    );
    assertConversationSubthreadReplyClassification(
      input.structuralProjection.subthreadReplyClassification,
    );
    assertDigest("live Shadow reservation digest", input.reservationDigest);
    if (
      (input.authorRole !== "assistant" && input.authorRole !== "tool")
      || input.keyClass !== "ai"
      || !Number.isSafeInteger(input.transcriptOrdinal)
      || input.transcriptOrdinal < 2
      || !Number.isSafeInteger(input.reservedCreatedAt)
      || input.reservedCreatedAt < 0
    ) throw new TypeError("Live Shadow Agent publication is invalid");
    const expectedObjectId = deriveLiveShadowMessageCryptoObjectIdV1({
      operationId: input.operationId,
      sessionId: input.sessionId,
      messageId: input.reservedMessageId,
      revision: 0,
      transcriptOrdinal: input.transcriptOrdinal,
      authorRole: input.authorRole,
    });
    if (expectedObjectId !== input.cryptoObjectId) {
      throw new TypeError("Live Shadow Agent object identity disagrees");
    }

    return canonicalTransaction(this.canonicalRunner, async (transaction) => {
      if (input.publicationPolicy !== undefined) {
        await acquireEncryptionPublicationFence(transaction, input.publicationPolicy);
      }
      await transaction.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext(${input.operationId}),
          ${input.transcriptOrdinal}
        )
      `);
      const lifecycleRows = canonicalRows(
        await transaction.select(lifecycleSelection)
          .from(sessionMessageCryptoRevisions)
          .where(and(
            eq(sessionMessageCryptoRevisions.sessionId, input.sessionId),
            eq(sessionMessageCryptoRevisions.messageId, input.reservedMessageId),
            eq(sessionMessageCryptoRevisions.editRevision, 0),
          )).for("update", { of: sessionMessageCryptoRevisions }).limit(2),
      );
      const lifecycleRow = oneOrNone(
        lifecycleRows,
        "Live Shadow Agent publication lifecycle",
      );
      if (lifecycleRow === null) return { status: "conflict" as const };
      const lifecycle = lifecycleFromRow(lifecycleRow);
      const expectedRepresentationMode = input.publicationPolicy?.representation === "protected_only"
        ? "full_encryption"
        : "shadow_encryption";
      const expectedPolicyRevision = expectedRepresentationMode === "full_encryption"
        ? input.publicationPolicy!.expectedRevision
        : null;
      if (
        lifecycle.shadowOperationId !== input.operationId
          && lifecycle.sharedAgentShadowExecutionId !== input.operationId
        || (
          lifecycle.shadowOperationId === input.operationId
          && lifecycle.sharedAgentShadowExecutionId !== null
        )
        || (
          lifecycle.sharedAgentShadowExecutionId === input.operationId
          && lifecycle.shadowOperationId !== null
        )
        || lifecycle.shadowTranscriptOrdinal !== input.transcriptOrdinal
        || lifecycle.shadowReservedCreatedAt?.getTime()
          !== input.reservedCreatedAt
        || lifecycle.cryptoObjectId !== input.cryptoObjectId
        || lifecycle.authorRole !== input.authorRole
        || lifecycle.representationMode !== expectedRepresentationMode
        || lifecycle.publicationPolicyRevision !== expectedPolicyRevision
        || lifecycle.disposition !== "active"
        || !bytesEqual(
          lifecycle.allocationRequestDigest,
          input.reservationDigest,
        )
      ) return { status: "conflict" as const };
      const existingRows = canonicalRows(
        await transaction.select({
          id: sessionMessages.id,
          session_id: sessionMessages.sessionId,
          role: sessionMessages.role,
          content: sessionMessages.content,
          tool_calls: sessionMessages.toolCalls,
          tool_name: sessionMessages.toolName,
          crypto_object_id: sessionMessages.cryptoObjectId,
          created_at: sessionMessages.createdAt,
        }).from(sessionMessages)
          .where(eq(sessionMessages.id, input.reservedMessageId))
          .for("update", { of: sessionMessages }).limit(2),
      );
      const existing = oneOrNone(
        existingRows,
        "Live Shadow Agent published row",
      );
      if (existing !== null) {
        return requiredString(existing, "session_id") === input.sessionId
            && requiredString(existing, "role") === input.authorRole
            && nullableString(existing, "content") === input.content
            && nullableString(existing, "tool_calls") === input.toolCalls
            && nullableString(existing, "tool_name") === input.toolName
            && nullableString(existing, "crypto_object_id")
              === input.cryptoObjectId
            && nullableDate(existing, "created_at")?.getTime()
              === input.reservedCreatedAt
          ? { status: "replayed" as const, lifecycle }
          : { status: "conflict" as const };
      }
      if (!await lockLiveShadowExecutionForPublication(transaction, lifecycle)) {
        return { status: "conflict" as const };
      }
      const result = await appendCanonicalTranscriptRowsToExistingSessionInTx(
        transaction,
        {
          sessionId: input.sessionId,
          publicationPolicy: input.publicationPolicy,
          rows: [{
            role: input.authorRole,
            content: input.content,
            toolCalls: input.toolCalls,
            toolName: input.toolName,
            fingerprint: input.fingerprint,
            humanTurnId: null,
            transcriptOrigin: input.transcriptOrigin,
            parentThreadId: input.parentThreadId,
            scopeId: input.scopeId,
            metadata: input.metadata === null ? null : { ...input.metadata },
            subthreadRoomId: input.subthreadRoomId,
            replyToMessageId: input.replyToMessageId,
            protectedStructuralProjection: {
              notificationEligibility:
                input.structuralProjection.notificationEligibility,
              subthreadReplyClassification:
                input.structuralProjection.subthreadReplyClassification,
              reservedMessageId: input.reservedMessageId,
              reservedCreatedAt: new Date(input.reservedCreatedAt),
            },
          }],
          notificationContext: {
            ...(input.notificationContext.mentionEveryone === true
              ? { mentionEveryone: true } : {}),
            mentionedHumanUserIds: [
              ...input.notificationContext.mentionedHumanUserIds,
            ],
            causalHumanUserId: input.notificationContext.causalHumanUserId,
            causalHumanTurnId:
              input.notificationContext.causalHumanTurnId,
          },
        },
      );
      if (
        result.insertedCount !== 1
        || result.insertedRows[0]?.id !== String(input.reservedMessageId)
      ) return { status: "conflict" as const };
      return { status: "allocated" as const, lifecycle };
    }, "read committed");
  }

  async recordLiveShadowAgentEvidence(
    input: ConversationLiveShadowAgentEvidenceInput,
  ): Promise<ConversationLiveShadowAgentEvidenceResult> {
    assertConversationSessionId(input.sessionId);
    assertConversationDurableKey("live Shadow operation ID", input.operationId);
    assertConversationMessageId(input.messageId);
    assertDigest("live Shadow durable event digest", input.durableEventDigest);
    if (input.streamEvidence !== null) {
      assertConversationDurableKey(
        "live Shadow stream ID",
        input.streamEvidence.streamId,
      );
      assertDigest("live Shadow stream start digest", input.streamEvidence.startDigest);
      assertDigest("live Shadow stream terminal digest", input.streamEvidence.terminalDigest);
      assertDigest("live Shadow streamed text digest", input.streamEvidence.streamedTextDigest);
    }
    if (
      !Number.isSafeInteger(input.transcriptOrdinal)
      || input.transcriptOrdinal < 2
      || !Number.isSafeInteger(input.now)
      || input.now < 0
    ) throw new TypeError("Live Shadow Agent evidence coordinate is invalid");

    return canonicalTransaction(this.canonicalRunner, async (transaction) => {
      if (input.publicationPolicy !== undefined) {
        await acquireEncryptionPublicationFence(transaction, input.publicationPolicy);
      }
      await transaction.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext(${input.operationId}),
          ${input.transcriptOrdinal}
        )
      `);
      const lifecycleRow = oneOrNone(canonicalRows(
        await transaction.select(lifecycleSelection)
          .from(sessionMessageCryptoRevisions)
          .where(and(
            eq(sessionMessageCryptoRevisions.sessionId, input.sessionId),
            eq(sessionMessageCryptoRevisions.messageId, input.messageId),
            eq(sessionMessageCryptoRevisions.editRevision, 0),
          )).for("update", { of: sessionMessageCryptoRevisions }).limit(2),
      ), "Live Shadow Agent evidence lifecycle");
      if (lifecycleRow === null) return "conflict" as const;
      const lifecycle = lifecycleFromRow(lifecycleRow);
      const lifecycleExact =
        lifecycle.shadowDurableEventDigest !== null
        && bytesEqual(
          lifecycle.shadowDurableEventDigest,
          input.durableEventDigest,
        )
        && (lifecycle.shadowStreamId === null
          ? input.streamEvidence === null
          : input.streamEvidence !== null
            && lifecycle.shadowStreamId === input.streamEvidence.streamId
            && lifecycle.shadowStreamStartDigest !== null
            && bytesEqual(lifecycle.shadowStreamStartDigest, input.streamEvidence.startDigest)
            && lifecycle.shadowStreamTerminalDigest !== null
            && bytesEqual(lifecycle.shadowStreamTerminalDigest, input.streamEvidence.terminalDigest)
            && lifecycle.shadowStreamedTextDigest !== null
            && bytesEqual(lifecycle.shadowStreamedTextDigest, input.streamEvidence.streamedTextDigest));
      if (
        lifecycle.shadowOperationId !== input.operationId
          && lifecycle.sharedAgentShadowExecutionId !== input.operationId
        || (
          lifecycle.shadowOperationId === input.operationId
          && lifecycle.sharedAgentShadowExecutionId !== null
        )
        || (
          lifecycle.sharedAgentShadowExecutionId === input.operationId
          && lifecycle.shadowOperationId !== null
        )
        || lifecycle.shadowTranscriptOrdinal !== input.transcriptOrdinal
        || lifecycle.completion !== "complete"
        || lifecycle.disposition !== "mapped"
        || lifecycle.parityStatus !== (lifecycle.representationMode === "full_encryption"
          ? "server_authenticated" : "server_verified")
        || (
          lifecycle.shadowDurableEventDigest !== null
          && !lifecycleExact
        )
        || (
          lifecycle.shadowDurableEventDigest === null
          && lifecycle.shadowStreamId !== null
        )
      ) return "conflict" as const;

      const turnRows = canonicalRows(await transaction.select({
        state: conversationShadowTurnOperations.state,
        final_causal_event_digest:
          conversationShadowTurnOperations.finalCausalEventDigest,
      }).from(conversationShadowTurnOperations).where(eq(
        conversationShadowTurnOperations.operationId,
        input.operationId,
      )).for("update", { of: conversationShadowTurnOperations }).limit(2));
      const turn = oneOrNone(turnRows, "Live Shadow Agent evidence turn");
      const sharedRows = turn === null
        ? canonicalRows(await transaction.select({
          state: conversationSharedAgentShadowExecutions.state,
          invocation_id: conversationSharedAgentShadowExecutions.invocationId,
          final_causal_event_digest:
            conversationSharedAgentShadowExecutions.finalCausalEventDigest,
        }).from(conversationSharedAgentShadowExecutions).where(eq(
          conversationSharedAgentShadowExecutions.executionId,
          input.operationId,
        )).for("update", { of: conversationSharedAgentShadowExecutions })
          .limit(2))
        : [];
      const shared = turn === null
        ? oneOrNone(sharedRows, "Shared-Agent evidence execution")
        : null;
      const parent = turn ?? shared;
      if (parent === null) return "conflict" as const;
      const sharedParent = shared !== null;
      const sharedInvocationId = shared === null
        ? null
        : nullableString(shared, "invocation_id");
      const turnState = requiredString(parent, "state");
      const finalDigest = nullableBytes(parent, "final_causal_event_digest");
      const turnExact = input.finalTurnMessage
        && (turnState === "completed" || (!sharedParent && turnState === "client_verified"))
        && finalDigest !== null
        && bytesEqual(finalDigest, input.durableEventDigest);
      if (
        input.finalTurnMessage
          ? turnState !== "running" && !turnExact
          : turnState !== "running"
      ) return "conflict" as const;
      if (lifecycleExact && (!input.finalTurnMessage || turnExact)) {
        return "duplicate" as const;
      }

      await transaction.update(sessionMessageCryptoRevisions).set({
        shadowStreamId: input.streamEvidence?.streamId ?? null,
        shadowStreamStartDigest: input.streamEvidence === null
          ? null
          : Uint8Array.from(input.streamEvidence.startDigest),
        shadowStreamTerminalDigest: input.streamEvidence === null
          ? null
          : Uint8Array.from(input.streamEvidence.terminalDigest),
        shadowStreamedTextDigest: input.streamEvidence === null
          ? null
          : Uint8Array.from(input.streamEvidence.streamedTextDigest),
        shadowDurableEventDigest: Uint8Array.from(input.durableEventDigest),
      }).where(and(
        eq(sessionMessageCryptoRevisions.sessionId, input.sessionId),
        eq(sessionMessageCryptoRevisions.messageId, input.messageId),
        eq(sessionMessageCryptoRevisions.editRevision, 0),
      ));
      if (input.finalTurnMessage && !turnExact) {
        if (sharedParent) {
          await transaction.update(conversationSharedAgentShadowExecutions).set({
            state: "completed",
            finalCausalEventDigest: Uint8Array.from(input.durableEventDigest),
            terminalAt: new Date(input.now),
            updatedAt: new Date(input.now),
          }).where(and(
            eq(
              conversationSharedAgentShadowExecutions.executionId,
              input.operationId,
            ),
            eq(conversationSharedAgentShadowExecutions.state, "running"),
          ));
          if (sharedInvocationId !== null) {
            await transaction.update(
              conversationSharedAgentShadowInvocations,
            ).set({
              state: "completed",
              terminalAt: new Date(input.now),
              updatedAt: new Date(input.now),
            }).where(and(
              eq(
                conversationSharedAgentShadowInvocations.invocationId,
                sharedInvocationId,
              ),
              inArray(
                conversationSharedAgentShadowInvocations.state,
                ["authorized", "running"],
              ),
              sql`NOT EXISTS (
                SELECT 1
                  FROM conversation_shared_agent_shadow_executions AS child
                 WHERE child.invocation_id = ${sharedInvocationId}
                   AND child.state NOT IN ('completed', 'fallback', 'failed')
              )`,
            ));
          }
        } else {
          await transaction.update(conversationShadowTurnOperations).set({
            state: "completed",
            finalCausalEventDigest: Uint8Array.from(input.durableEventDigest),
            terminalAt: new Date(input.now),
            updatedAt: new Date(input.now),
          }).where(and(
            eq(
              conversationShadowTurnOperations.operationId,
              input.operationId,
            ),
            eq(conversationShadowTurnOperations.state, "running"),
          ));
        }
      }
      return "applied" as const;
    }, "read committed");
  }

  async appendAllocated(
    input: ConversationProductAppendInput,
  ): Promise<ConversationProductAppendResult> {
    assertProductPublicationRepresentation(input);
    assertConversationSessionId(input.sessionId);
    assertConversationDurableKey(
      "message append idempotency key",
      input.idempotencyKey,
    );
    assertConversationMessageKeyClass(input.keyClass);
    assertConversationAuthorRole(input.authorRole);
    assertConversationNotificationEligibility(
      input.structuralProjection.notificationEligibility,
    );
    assertConversationSubthreadReplyClassification(
      input.structuralProjection.subthreadReplyClassification,
    );
    assertDigest("Append request digest", input.requestDigest);
    if (
      [
        input.liveShadow,
        input.humanPeerLiveShadow,
        input.sharedAgentLiveShadow,
      ].filter((value) => value !== undefined).length > 1
    ) throw new TypeError("Conversation append has multiple live parents");
    if (input.liveShadow !== undefined) {
      assertConversationDurableKey(
        "live Shadow operation ID",
        input.liveShadow.operationId,
      );
      assertConversationMessageId(input.liveShadow.reservedMessageId);
      assertDigest("live Shadow Grant digest", input.liveShadow.grantDigest);
      assertDigest("live Shadow plan digest", input.liveShadow.planDigest);
      if (
        !(input.liveShadow.planBytes instanceof Uint8Array)
        || input.liveShadow.planBytes.length < 1
        || input.liveShadow.planBytes.length
          > MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V4
        || !(input.liveShadow.requestBytes instanceof Uint8Array)
        || input.liveShadow.requestBytes.length < 1
        || input.liveShadow.requestBytes.length
          > MAX_HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_WIRE_BYTES_V4
      ) throw new TypeError("Live Shadow signed evidence is invalid");
      if (
        input.liveShadow.transcriptOrdinal !== 1
        || !Number.isSafeInteger(input.liveShadow.createdAt)
        || input.liveShadow.createdAt < 0
      ) throw new TypeError("Live Shadow append coordinate is invalid");
      const expectedObjectId = deriveLiveShadowMessageCryptoObjectIdV1({
        operationId: input.liveShadow.operationId,
        sessionId: input.sessionId,
        messageId: input.liveShadow.reservedMessageId,
        revision: 0,
        transcriptOrdinal: input.liveShadow.transcriptOrdinal,
        authorRole: input.authorRole,
      });
      if (
        input.authorRole !== "user"
        || input.keyClass !== "ai"
        || input.humanTurnId !== input.liveShadow.operationId
        || input.liveShadow.cryptoObjectId !== expectedObjectId
      ) throw new TypeError("Live Shadow append identity is incoherent");
    }
    if (input.humanPeerLiveShadow !== undefined) {
      const live = input.humanPeerLiveShadow;
      assertConversationDurableKey(
        "Human-peer live Shadow operation ID",
        live.operationId,
      );
      assertConversationMessageId(live.reservedMessageId);
      assertDigest("Human-peer live Shadow plan digest", live.planDigest);
      if (
        !(live.planBytes instanceof Uint8Array)
        || live.planBytes.length < 1
        || live.planBytes.length > 16_384
        || !(live.requestBytes instanceof Uint8Array)
        || live.requestBytes.length < 1
        || live.requestBytes.length > 16_384
        || !Number.isSafeInteger(live.transcriptOrdinal)
        || live.transcriptOrdinal < 1
        || !Number.isSafeInteger(live.createdAt)
        || live.createdAt < 0
      ) throw new TypeError("Human-peer live Shadow evidence is invalid");
      const expectedObjectId = deriveLiveShadowMessageCryptoObjectIdV1({
        operationId: live.operationId,
        sessionId: input.sessionId,
        messageId: live.reservedMessageId,
        revision: 0,
        transcriptOrdinal: live.transcriptOrdinal,
        authorRole: input.authorRole,
      });
      if (
        input.authorRole !== "user"
        || input.keyClass !== "human"
        || input.humanTurnId !== live.operationId
        || live.cryptoObjectId !== expectedObjectId
      ) throw new TypeError("Human-peer live Shadow identity is incoherent");
    }
    if (input.sharedAgentLiveShadow !== undefined) {
      const live = input.sharedAgentLiveShadow;
      assertConversationDurableKey(
        "Shared-Agent live Shadow operation ID",
        live.operationId,
      );
      assertConversationMessageId(live.reservedMessageId);
      assertDigest("Shared-Agent live Shadow plan digest", live.planDigest);
      if (
        !(live.planBytes instanceof Uint8Array)
        || live.planBytes.length < 1
        || live.planBytes.length > 16_384
        || !(live.requestBytes instanceof Uint8Array)
        || live.requestBytes.length < 1
        || live.requestBytes.length > 16_384
        || !Number.isSafeInteger(live.transcriptOrdinal)
        || live.transcriptOrdinal < 1
        || !Number.isSafeInteger(live.createdAt)
        || live.createdAt < 0
      ) throw new TypeError("Shared-Agent live Shadow evidence is invalid");
      const expectedObjectId = deriveLiveShadowMessageCryptoObjectIdV1({
        operationId: live.operationId,
        sessionId: input.sessionId,
        messageId: live.reservedMessageId,
        revision: 0,
        transcriptOrdinal: live.transcriptOrdinal,
        authorRole: input.authorRole,
      });
      if (
        input.authorRole !== "user"
        || input.keyClass !== "ai"
        || input.humanTurnId !== live.operationId
        || live.cryptoObjectId !== expectedObjectId
      ) throw new TypeError("Shared-Agent live Shadow identity is incoherent");
    }
    if (
      this.handle.role === "nautilo_agent"
      && (
        input.keyClass !== "ai"
        || input.authorRole === "user"
      )
    ) {
      throw new TypeError(
        "nautilo_agent may append only AI-authored assistant/tool/system rows",
      );
    }
    const liveCoordinate = input.liveShadow
      ?? input.humanPeerLiveShadow
      ?? input.sharedAgentLiveShadow;
    // READ COMMITTED is deliberate: contenders take the advisory lock in
    // their first statement and the following exact receipt lookup must see
    // the winner's commit. The canonical transcript primitive then owns the
    // Room lock, stable message ID, row shape, classification and summaries.
    return canonicalTransaction(
      this.canonicalRunner,
      async (transaction) => {
      if (input.publicationPolicy !== undefined) {
        await acquireEncryptionPublicationFence(transaction, input.publicationPolicy);
      }
      await transaction.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext(${input.sessionId}),
          hashtext(${input.idempotencyKey})
        )
      `);
      const receiptRows = canonicalRows(
        await transaction.select(lifecycleSelection)
          .from(sessionMessageCryptoRevisions).where(and(
            eq(sessionMessageCryptoRevisions.sessionId, input.sessionId),
            eq(
              sessionMessageCryptoRevisions.appendIdempotencyKey,
              input.idempotencyKey,
            ),
          )).limit(2),
      );
      const receiptRow = oneOrNone(receiptRows, "Conversation append receipt");
      if (receiptRow !== null) {
        const lifecycle = lifecycleFromRow(receiptRow);
        return bytesEqual(
            lifecycle.allocationRequestDigest,
            input.requestDigest,
          )
          ? { status: "replayed", lifecycle }
          : { status: "conflict" };
      }

      const result = await appendCanonicalTranscriptRowsToExistingSessionInTx(
        transaction,
        {
          sessionId: input.sessionId,
          publicationPolicy: input.publicationPolicy,
          rows: [{
            role: input.authorRole,
            content: input.content,
            toolCalls: input.toolCalls,
            toolName: input.toolName,
            fingerprint: input.fingerprint,
            humanTurnId: input.humanTurnId,
            transcriptOrigin: input.transcriptOrigin,
            parentThreadId: input.parentThreadId,
            scopeId: input.scopeId,
            metadata: input.metadata === null ? null : { ...input.metadata },
            subthreadRoomId: input.subthreadRoomId,
            replyToMessageId: input.replyToMessageId,
            protectedStructuralProjection: {
              notificationEligibility:
                input.structuralProjection.notificationEligibility,
              subthreadReplyClassification:
                input.structuralProjection.subthreadReplyClassification,
              ...(liveCoordinate === undefined
                ? {}
                : {
                  reservedMessageId:
                    liveCoordinate.reservedMessageId,
                  reservedCreatedAt: new Date(liveCoordinate.createdAt),
                }),
            },
          }],
          notificationContext: {
            ...(input.notificationContext.mentionEveryone === true
              ? { mentionEveryone: true } : {}),
            mentionedHumanUserIds: [
              ...input.notificationContext.mentionedHumanUserIds,
            ],
            causalHumanUserId:
              input.notificationContext.causalHumanUserId,
            causalHumanTurnId:
              input.notificationContext.causalHumanTurnId,
          },
        },
        {
          afterMessageIdAllocated: async ({
            sessionId,
            roomId,
            messageId,
          }) => {
            if (roomId === null) {
              throw new Error(
                "Conversation Session/Room/Namespace is missing",
              );
            }
            if (
              liveCoordinate !== undefined
              && messageId !== liveCoordinate.reservedMessageId
            ) throw new Error("Live Shadow reserved Message ID changed");
            const namespaceRows = canonicalRows(
              await transaction.select({ namespace_id: rooms.namespaceId })
                .from(rooms).where(eq(rooms.id, roomId))
                .for("share", { of: rooms }).limit(2),
            );
            const namespaceRow = oneOrNone(
              namespaceRows,
              "Conversation Room Namespace",
            );
            if (namespaceRow === null) {
              throw new Error(
                "Conversation Session/Room/Namespace is missing",
              );
            }
            const namespaceId = requiredString(
              namespaceRow,
              "namespace_id",
            );
            assertUuid("Conversation Namespace ID", namespaceId);
            const objectId = input.liveShadow?.cryptoObjectId
              ?? input.humanPeerLiveShadow?.cryptoObjectId
              ?? input.sharedAgentLiveShadow?.cryptoObjectId
              ?? deriveMessageCryptoObjectIdV2({
                sessionId,
                messageId,
                revision: 0,
              });
            if (input.liveShadow !== undefined) {
              const turnRows = canonicalRows(
                await transaction.select({
                  operation_id:
                    conversationShadowTurnOperations.operationId,
                  state: conversationShadowTurnOperations.state,
                  session_id: conversationShadowTurnOperations.sessionId,
                  room_id: conversationShadowTurnOperations.roomId,
                  human_message_id:
                    conversationShadowTurnOperations.humanMessageId,
                  human_message_created_at:
                    conversationShadowTurnOperations.humanMessageCreatedAt,
                  namespace_id:
                    conversationShadowTurnOperations.namespaceId,
                  human_request_digest:
                    conversationShadowTurnOperations.humanRequestDigest,
                  plan_bytes: conversationShadowTurnOperations.planBytes,
                  human_request_bytes:
                    conversationShadowTurnOperations.humanRequestBytes,
                  grant_digest: conversationShadowTurnOperations.grantDigest,
                  plan_digest: conversationShadowTurnOperations.planDigest,
                })
                  .from(conversationShadowTurnOperations)
                  .where(eq(
                    conversationShadowTurnOperations.operationId,
                    input.liveShadow.operationId,
                  ))
                  .for("update", {
                    of: conversationShadowTurnOperations,
                  }).limit(2),
              );
              const turn = oneOrNone(turnRows, "Live Shadow turn operation");
              const createdAt = turn === null
                ? null
                : nullableDate(turn, "human_message_created_at");
              if (
                turn === null
                || requiredString(turn, "state") !== "planned"
                || requiredString(turn, "session_id") !== sessionId
                || requiredString(turn, "room_id") !== roomId
                || requiredInteger(turn, "human_message_id") !== messageId
                || createdAt === null
                || createdAt.getTime() !== input.liveShadow.createdAt
                || requiredString(turn, "namespace_id") !== namespaceId
                || !bytesEqual(
                  requiredBytes(turn, "plan_digest"),
                  input.liveShadow.planDigest,
                )
                || turn["human_request_digest"] !== null
                || turn["plan_bytes"] !== null
                || turn["human_request_bytes"] !== null
                || turn["grant_digest"] !== null
              ) throw new Error("Live Shadow turn reservation changed");
            }
            if (input.humanPeerLiveShadow !== undefined) {
              const live = input.humanPeerLiveShadow;
              const operationRows = canonicalRows(
                await transaction.select({
                  operation_id:
                    conversationHumanPeerShadowOperations.operationId,
                  state: conversationHumanPeerShadowOperations.state,
                  session_id: conversationHumanPeerShadowOperations.sessionId,
                  room_id: conversationHumanPeerShadowOperations.roomId,
                  human_message_id:
                    conversationHumanPeerShadowOperations.humanMessageId,
                  human_message_created_at:
                    conversationHumanPeerShadowOperations.humanMessageCreatedAt,
                  transcript_ordinal:
                    conversationHumanPeerShadowOperations.transcriptOrdinal,
                  namespace_id:
                    conversationHumanPeerShadowOperations.namespaceId,
                  crypto_object_id:
                    conversationHumanPeerShadowOperations.cryptoObjectId,
                  plan_digest:
                    conversationHumanPeerShadowOperations.planDigest,
                  plan_bytes: conversationHumanPeerShadowOperations.planBytes,
                  human_request_digest:
                    conversationHumanPeerShadowOperations.humanRequestDigest,
                  human_request_bytes:
                    conversationHumanPeerShadowOperations.humanRequestBytes,
                })
                  .from(conversationHumanPeerShadowOperations)
                  .where(eq(
                    conversationHumanPeerShadowOperations.operationId,
                    live.operationId,
                  ))
                  .for("update", {
                    of: conversationHumanPeerShadowOperations,
                  }).limit(2),
              );
              const operation = oneOrNone(
                operationRows,
                "Human-peer live Shadow operation",
              );
              const createdAt = operation === null
                ? null
                : nullableDate(operation, "human_message_created_at");
              if (
                operation === null
                || requiredString(operation, "state") !== "planned"
                || requiredString(operation, "session_id") !== sessionId
                || requiredString(operation, "room_id") !== roomId
                || requiredInteger(operation, "human_message_id") !== messageId
                || createdAt?.getTime() !== live.createdAt
                || requiredInteger(operation, "transcript_ordinal")
                  !== live.transcriptOrdinal
                || requiredString(operation, "namespace_id") !== namespaceId
                || requiredString(operation, "crypto_object_id")
                  !== live.cryptoObjectId
                || !bytesEqual(
                  requiredBytes(operation, "plan_digest"),
                  live.planDigest,
                )
                || !bytesEqual(
                  requiredBytes(operation, "plan_bytes"),
                  live.planBytes,
                )
                || operation["human_request_digest"] !== null
                || operation["human_request_bytes"] !== null
              ) throw new Error("Human-peer live Shadow reservation changed");
            }
            if (input.sharedAgentLiveShadow !== undefined) {
              const live = input.sharedAgentLiveShadow;
              const operationRows = canonicalRows(
                await transaction.select({
                  operation_id:
                    conversationSharedAgentShadowOperations.operationId,
                  state: conversationSharedAgentShadowOperations.state,
                  session_id: conversationSharedAgentShadowOperations.sessionId,
                  room_id: conversationSharedAgentShadowOperations.roomId,
                  human_message_id:
                    conversationSharedAgentShadowOperations.humanMessageId,
                  human_message_created_at:
                    conversationSharedAgentShadowOperations.humanMessageCreatedAt,
                  transcript_ordinal:
                    conversationSharedAgentShadowOperations.transcriptOrdinal,
                  namespace_id:
                    conversationSharedAgentShadowOperations.namespaceId,
                  crypto_object_id:
                    conversationSharedAgentShadowOperations.cryptoObjectId,
                  plan_digest:
                    conversationSharedAgentShadowOperations.planDigest,
                  plan_bytes:
                    conversationSharedAgentShadowOperations.planBytes,
                  human_request_digest:
                    conversationSharedAgentShadowOperations.humanRequestDigest,
                  human_request_bytes:
                    conversationSharedAgentShadowOperations.humanRequestBytes,
                })
                  .from(conversationSharedAgentShadowOperations)
                  .where(eq(
                    conversationSharedAgentShadowOperations.operationId,
                    live.operationId,
                  ))
                  .for("update", {
                    of: conversationSharedAgentShadowOperations,
                  }).limit(2),
              );
              const operation = oneOrNone(
                operationRows,
                "Shared-Agent live Shadow operation",
              );
              const createdAt = operation === null
                ? null
                : nullableDate(operation, "human_message_created_at");
              if (
                operation === null
                || requiredString(operation, "state") !== "planned"
                || requiredString(operation, "session_id") !== sessionId
                || requiredString(operation, "room_id") !== roomId
                || requiredInteger(operation, "human_message_id") !== messageId
                || createdAt?.getTime() !== live.createdAt
                || requiredInteger(operation, "transcript_ordinal")
                  !== live.transcriptOrdinal
                || requiredString(operation, "namespace_id") !== namespaceId
                || requiredString(operation, "crypto_object_id")
                  !== live.cryptoObjectId
                || !bytesEqual(
                  requiredBytes(operation, "plan_digest"),
                  live.planDigest,
                )
                || !bytesEqual(
                  requiredBytes(operation, "plan_bytes"),
                  live.planBytes,
                )
                || operation["human_request_digest"] !== null
                || operation["human_request_bytes"] !== null
              ) throw new Error("Shared-Agent live Shadow reservation changed");
            }
            const inserted = canonicalRows(
              await transaction.insert(sessionMessageCryptoRevisions).values({
                sessionId,
                messageId,
                editRevision: 0,
                roomId,
                namespaceIdAtAllocation: namespaceId,
                cryptoObjectId: objectId,
                objectIdScheme: liveCoordinate === undefined
                  ? "message_v2"
                  : "live_shadow_v1",
                representationMode: input.publicationPolicy?.representation === "protected_only"
                  ? "full_encryption"
                  : "shadow_encryption",
                publicationPolicyRevision: input.publicationPolicy?.representation === "protected_only"
                  ? input.publicationPolicy.expectedRevision
                  : null,
                shadowOperationId:
                  input.liveShadow?.operationId ?? null,
                humanPeerShadowOperationId:
                  input.humanPeerLiveShadow?.operationId ?? null,
                sharedAgentShadowOperationId:
                  input.sharedAgentLiveShadow?.operationId ?? null,
                sharedAgentShadowExecutionId: null,
                shadowTranscriptOrdinal:
                  input.liveShadow?.transcriptOrdinal
                    ?? input.humanPeerLiveShadow?.transcriptOrdinal
                    ?? input.sharedAgentLiveShadow?.transcriptOrdinal
                    ?? null,
                shadowReservedCreatedAt: liveCoordinate === undefined
                  ? null
                  : new Date(liveCoordinate.createdAt),
                payloadVersion: CONVERSATION_MESSAGE_PAYLOAD_VERSION,
                keyClass: input.keyClass,
                authorRole: input.authorRole,
                subthreadReplyClassification:
                  input.structuralProjection.subthreadReplyClassification,
                appendIdempotencyKey: input.idempotencyKey,
                allocationRequestDigest:
                  Uint8Array.from(input.requestDigest),
                completion: "pending",
                disposition: "active",
                parityStatus: "pending",
                attemptCount: 0,
                nextAttemptAt: sql`CURRENT_TIMESTAMP`,
              }).returning(lifecycleSelection),
            );
            const insertedRow = oneOrNone(
              inserted,
              "Conversation allocation",
            );
            if (insertedRow === null) {
              throw new Error(
                "Conversation allocation lost its lifecycle receipt",
              );
            }
            const lifecycle = lifecycleFromRow(insertedRow);
            if (
              lifecycle.subthreadReplyClassification
                !== input.structuralProjection.subthreadReplyClassification
            ) {
              throw new Error(
                "Conversation structural projection was not persisted exactly",
              );
            }
            if (input.liveShadow !== undefined) {
              const updated = await transaction
                .update(conversationShadowTurnOperations)
                .set({
                  humanRequestDigest: Uint8Array.from(input.requestDigest),
                  planBytes: Uint8Array.from(input.liveShadow.planBytes),
                  humanRequestBytes:
                    Uint8Array.from(input.liveShadow.requestBytes),
                  grantDigest: Uint8Array.from(input.liveShadow.grantDigest),
                  state: "human_verified",
                  startedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(and(
                  eq(
                    conversationShadowTurnOperations.operationId,
                    input.liveShadow.operationId,
                  ),
                  eq(conversationShadowTurnOperations.state, "planned"),
                  sql`${conversationShadowTurnOperations.humanRequestDigest} IS NULL`,
                  sql`${conversationShadowTurnOperations.planBytes} IS NULL`,
                  sql`${conversationShadowTurnOperations.humanRequestBytes} IS NULL`,
                  sql`${conversationShadowTurnOperations.grantDigest} IS NULL`,
                ))
                .returning({
                  operationId: conversationShadowTurnOperations.operationId,
                });
              if (updated.length !== 1) {
                throw new Error("Live Shadow turn admission lost its CAS");
              }
            }
            if (input.humanPeerLiveShadow !== undefined) {
              const updated = await transaction
                .update(conversationHumanPeerShadowOperations)
                .set({
                  humanRequestDigest: Uint8Array.from(input.requestDigest),
                  humanRequestBytes: Uint8Array.from(
                    input.humanPeerLiveShadow.requestBytes,
                  ),
                  state: "human_verified",
                  humanVerifiedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(and(
                  eq(
                    conversationHumanPeerShadowOperations.operationId,
                    input.humanPeerLiveShadow.operationId,
                  ),
                  eq(
                    conversationHumanPeerShadowOperations.state,
                    "planned",
                  ),
                  sql`${conversationHumanPeerShadowOperations.humanRequestDigest} IS NULL`,
                  sql`${conversationHumanPeerShadowOperations.humanRequestBytes} IS NULL`,
                ))
                .returning({
                  operationId:
                    conversationHumanPeerShadowOperations.operationId,
                });
              if (updated.length !== 1) {
                throw new Error("Human-peer live Shadow admission lost its CAS");
              }
            }
            if (input.sharedAgentLiveShadow !== undefined) {
              const updated = await transaction
                .update(conversationSharedAgentShadowOperations)
                .set({
                  humanRequestDigest: Uint8Array.from(input.requestDigest),
                  humanRequestBytes: Uint8Array.from(
                    input.sharedAgentLiveShadow.requestBytes,
                  ),
                  state: "human_verified",
                  humanVerifiedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(and(
                  eq(
                    conversationSharedAgentShadowOperations.operationId,
                    input.sharedAgentLiveShadow.operationId,
                  ),
                  eq(
                    conversationSharedAgentShadowOperations.state,
                    "planned",
                  ),
                  sql`${conversationSharedAgentShadowOperations.humanRequestDigest} IS NULL`,
                  sql`${conversationSharedAgentShadowOperations.humanRequestBytes} IS NULL`,
                ))
                .returning({
                  operationId:
                    conversationSharedAgentShadowOperations.operationId,
                });
              if (updated.length !== 1) {
                throw new Error("Shared-Agent live Shadow admission lost its CAS");
              }
            }
            return lifecycle;
          },
        },
      );
      const inserted = result.insertedRows[0];
      if (
        result.insertedCount !== 1
        || inserted?.hookResult === undefined
      ) {
        throw new Error("Canonical conversation append lost its row");
      }
      return { status: "allocated", lifecycle: inserted.hookResult };
    },
      "read committed",
    );
  }

  /** The caller verifies exact signed independent parity under current device authority. */
  async acceptIndependentMessageParity(input: ConversationIndependentMessageParityInput):
    Promise<"applied" | "replayed" | "missing" | "stale" | "restored"> {
    this.#assertCoordinates(input);
    assertConversationDurableKey("parity crypto object ID", input.cryptoObjectId);
    assertUuid("parity Namespace ID", input.expectedNamespaceId);
    assertUuid("parity authority actor ID", input.authorityActorId);
    assertConversationMessageKeyClass(input.expectedKeyClass);
    if (this.handle.role !== "nautilo") throw new TypeError("Independent device parity requires nautilo role");
    if (!Number.isSafeInteger(input.expectedNamespaceAccessRevision)
      || input.expectedNamespaceAccessRevision < 0) throw new TypeError("Parity authority revision is invalid");
    if (input.publicationPolicy.representation !== "ordinary_and_protected") {
      throw new TypeError("Independent counterpart parity requires Shadow policy");
    }
    return canonicalTransaction(this.canonicalRunner, async (transaction) => {
      await acquireEncryptionPublicationFence(transaction, input.publicationPolicy);
      // Match canonical transcript edits: Room rows precede the Message row.
      const [coordinate] = await transaction.select({roomId: rooms.id, parentRoomId: rooms.parentRoomId})
        .from(sessions).innerJoin(rooms, eq(rooms.id, sessions.roomId))
        .where(eq(sessions.id, input.sessionId));
      if (coordinate === undefined) return "missing";
      for (const roomId of [...new Set([coordinate.roomId, coordinate.parentRoomId ?? coordinate.roomId])].sort()) {
        await acquireRoomWriteLock(transaction, roomId);
      }

      const authorityRoom = alias(rooms, "parity_authority_room");
      const row = oneOrNone(canonicalRows(await transaction.select({
        message_id: sessionMessages.id, edit_revision: sessionMessages.editRevision,
        crypto_object_id: sessionMessages.cryptoObjectId,
        namespace_id: rooms.namespaceId,
        namespace_access_revision: authorityRoom.namespaceAccessRevision,
        ordinary_present: sql<boolean>`${sessionMessages.content} is not null
          or ${sessionMessages.toolCalls} is not null or ${sessionMessages.toolName} is not null`,
      }).from(sessionMessages)
        .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
        .innerJoin(rooms, eq(rooms.id, sessions.roomId))
        .innerJoin(authorityRoom, eq(authorityRoom.id, sql`coalesce(${rooms.parentRoomId}, ${rooms.id})`))
        .innerJoin(roomMembers, eq(roomMembers.roomId, authorityRoom.id))
        .innerJoin(actors, eq(actors.id, roomMembers.actorId))
        .where(and(eq(sessionMessages.id, input.messageId), eq(sessionMessages.sessionId, input.sessionId),
          eq(actors.id, input.authorityActorId), eq(actors.kind, "user"),
          sql`${actors.ownerId} = app_current_user_id()`))
        .for("update", { of: [sessionMessages, rooms, authorityRoom] })), "independent parity Message");
      if (row === null) return "missing";
      if (row["edit_revision"] !== input.revision || row["crypto_object_id"] !== input.cryptoObjectId
        || row["namespace_id"] !== input.expectedNamespaceId
        || row["namespace_access_revision"] !== input.expectedNamespaceAccessRevision
        || row["ordinary_present"] !== true) return "stale";
      const receipt = oneOrNone(canonicalRows(await transaction.select({
        message_id: sessionMessageOrdinaryRepairs.messageId,
      }).from(sessionMessageOrdinaryRepairs).where(and(
        eq(sessionMessageOrdinaryRepairs.sessionId, input.sessionId),
        eq(sessionMessageOrdinaryRepairs.messageId, input.messageId),
        eq(sessionMessageOrdinaryRepairs.editRevision, input.revision),
      ))), "independent parity restoration receipt");
      if (receipt !== null) return "restored";
      const lifecycle = oneOrNone(canonicalRows(await transaction.select({
        parity_status: sessionMessageCryptoRevisions.parityStatus,
        completion: sessionMessageCryptoRevisions.completion,
        disposition: sessionMessageCryptoRevisions.disposition,
        crypto_object_id: sessionMessageCryptoRevisions.cryptoObjectId,
        key_class: sessionMessageCryptoRevisions.keyClass,
      }).from(sessionMessageCryptoRevisions).where(and(
        eq(sessionMessageCryptoRevisions.sessionId, input.sessionId),
        eq(sessionMessageCryptoRevisions.messageId, input.messageId),
        eq(sessionMessageCryptoRevisions.editRevision, input.revision),
      )).for("update")), "independent parity lifecycle");
      if (lifecycle === null) return "missing";
      if (lifecycle["completion"] !== "complete" || lifecycle["disposition"] !== "mapped"
        || lifecycle["crypto_object_id"] !== input.cryptoObjectId || lifecycle["key_class"] !== input.expectedKeyClass) return "stale";
      if (lifecycle["parity_status"] === "client_verified" || lifecycle["parity_status"] === "server_verified") return "replayed";
      if (lifecycle["parity_status"] !== "client_authenticated" && lifecycle["parity_status"] !== "server_authenticated") return "stale";
      const updated = await transaction.update(sessionMessageCryptoRevisions).set({ parityStatus: "client_verified" })
        .where(and(eq(sessionMessageCryptoRevisions.sessionId, input.sessionId),
          eq(sessionMessageCryptoRevisions.messageId, input.messageId),
          eq(sessionMessageCryptoRevisions.editRevision, input.revision),
          eq(sessionMessageCryptoRevisions.cryptoObjectId, input.cryptoObjectId)))
        .returning({ message_id: sessionMessageCryptoRevisions.messageId });
      return updated.length === 1 ? "applied" : "stale";
    }, "serializable");
  }

  async restoreOrdinaryExistingRepresentation(
    input: ConversationOrdinaryRepairInput,
  ): Promise<"applied" | "replayed" | "missing" | "stale" | "conflict"> {
    this.#assertCoordinates(input);
    assertConversationDurableKey("conversation crypto object ID", input.cryptoObjectId);
    assertUuid("Conversation Namespace ID", input.expectedNamespaceId);
    if (!Number.isSafeInteger(input.expectedNamespaceAccessRevision)
      || input.expectedNamespaceAccessRevision < 0
      || !Number.isSafeInteger(input.expectedNamespaceKeyGeneration)
      || input.expectedNamespaceKeyGeneration < 0) {
      throw new TypeError("ordinary repair Namespace authority is invalid");
    }
    assertConversationAuthorRole(input.expectedAuthorRole);
    assertConversationMessageKeyClass(input.expectedKeyClass);
    assertUuid("ordinary repair authority actor ID", input.authorityActorId);
    assertConversationDurableKey("ordinary repair publisher ID", input.publisher.id);
    assertDigest("ordinary repair identity digest", input.repairIdentityDigest);
    assertDigest("ordinary repair attestation digest", input.attestationDigest);
    if (!Number.isFinite(input.expectedCreatedAt)) {
      throw new TypeError("ordinary repair creation time is invalid");
    }
    if (input.publicationPolicy.representation !== "ordinary_and_protected") {
      throw new TypeError("ordinary repair requires Shadow publication policy");
    }
    const requiredRole = input.publisher.kind === "authenticated_runtime"
      ? "nautilo_agent" : "nautilo";
    if (this.handle.role !== requiredRole) {
      throw new TypeError(`ordinary repair requires the ${requiredRole} role`);
    }
    return canonicalTransaction(this.canonicalRunner, async (transaction) => {
      await acquireEncryptionPublicationFence(transaction, input.publicationPolicy);
      // Match canonical transcript edits: Room rows precede the Message row.
      const [coordinate] = await transaction.select({roomId: rooms.id, parentRoomId: rooms.parentRoomId})
        .from(sessions).innerJoin(rooms, eq(rooms.id, sessions.roomId))
        .where(eq(sessions.id, input.sessionId));
      if (coordinate === undefined) return "missing";
      for (const roomId of [...new Set([coordinate.roomId, coordinate.parentRoomId ?? coordinate.roomId])].sort()) {
        await acquireRoomWriteLock(transaction, roomId);
      }

      const authority = input.publisher.kind === "authenticated_runtime"
        ? sql`app_current_agent_id() = ${input.authorityActorId}::uuid
            and app_agent_in_room(${rooms.id})`
        : sql`app_current_user_id() = ${actors.ownerId}
            and ${actors.id} = ${input.authorityActorId}::uuid`;
      const authorityRoom = alias(rooms, "ordinary_repair_authority_room");
      const base = transaction.select({
        message_id: sessionMessages.id,
        session_id: sessionMessages.sessionId,
        role: sessionMessages.role,
        content: sessionMessages.content,
        tool_calls: sessionMessages.toolCalls,
        tool_name: sessionMessages.toolName,
        edit_revision: sessionMessages.editRevision,
        crypto_object_id: sessionMessages.cryptoObjectId,
        created_at: sessionMessages.createdAt,
        namespace_id: rooms.namespaceId,
        namespace_access_revision: authorityRoom.namespaceAccessRevision,
      }).from(sessionMessages)
        .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
        .innerJoin(rooms, eq(rooms.id, sessions.roomId))
        .innerJoin(authorityRoom, eq(authorityRoom.id, sql`coalesce(${rooms.parentRoomId}, ${rooms.id})`));
      const query = input.publisher.kind === "authenticated_runtime"
        ? base.where(and(eq(sessionMessages.id, input.messageId), authority))
        : base.innerJoin(roomMembers, eq(roomMembers.roomId, sql`coalesce(${rooms.parentRoomId}, ${rooms.id})`))
          .innerJoin(actors, eq(actors.id, roomMembers.actorId))
          .where(and(eq(sessionMessages.id, input.messageId), authority));
      const message = oneOrNone(canonicalRows(await query.for(
        "update", { of: [sessionMessages, rooms, authorityRoom] },
      )), "ordinary repair Message");
      if (message === null) return "missing";
      if (requiredString(message, "session_id") !== input.sessionId
        || requiredInteger(message, "edit_revision") !== input.revision
        || requiredString(message, "role") !== input.expectedAuthorRole
        || requiredString(message, "namespace_id") !== input.expectedNamespaceId
        || requiredInteger(message, "namespace_access_revision")
          !== (input.currentNamespaceAccessRevision ?? input.expectedNamespaceAccessRevision)
        || nullableString(message, "crypto_object_id") !== input.cryptoObjectId
        || new Date(message["created_at"] as Date | string).getTime()
          !== input.expectedCreatedAt) return "stale";
      // Reverse publication never mutates the protected lifecycle. A locking
      // read would require Human-authored Full rows to satisfy the Agent UPDATE
      // policy. Message/Room/current-head locks plus serializable isolation and
      // the receipt's exact lifecycle FK keep this read stable instead.
      const lifecycleRowValue = oneOrNone(canonicalRows(await transaction
        .select(lifecycleSelection).from(sessionMessageCryptoRevisions).where(and(
          eq(sessionMessageCryptoRevisions.sessionId, input.sessionId),
          eq(sessionMessageCryptoRevisions.messageId, input.messageId),
          eq(sessionMessageCryptoRevisions.editRevision, input.revision),
        ))), "ordinary repair lifecycle");
      if (lifecycleRowValue === null) return "missing";
      const lifecycle = lifecycleFromRow(lifecycleRowValue);
      if (lifecycle.cryptoObjectId !== input.cryptoObjectId
        || lifecycle.keyClass !== input.expectedKeyClass
        || lifecycle.completion !== "complete"
        || lifecycle.disposition !== "mapped") return "stale";
      const currentContent = nullableString(message, "content");
      const currentToolCalls = nullableString(message, "tool_calls");
      const currentToolName = nullableString(message, "tool_name");
      const alreadyExact = currentContent === input.content
        && currentToolCalls === input.toolCalls
        && currentToolName === input.toolName;
      if (!alreadyExact && (currentContent !== null
        || currentToolCalls !== null || currentToolName !== null)) return "conflict";
      const receipt = oneOrNone(canonicalRows(await transaction.select({
        repair_identity_digest:
          sessionMessageOrdinaryRepairs.repairIdentityDigest,
        attestation_digest: sessionMessageOrdinaryRepairs.attestationDigest,
        publisher_kind: sessionMessageOrdinaryRepairs.publisherKind,
        publisher_id: sessionMessageOrdinaryRepairs.publisherId,
        policy_revision: sessionMessageOrdinaryRepairs.policyRevision,
        expected_key_class: sessionMessageOrdinaryRepairs.expectedKeyClass,
        authority_actor_id: sessionMessageOrdinaryRepairs.authorityActorId,
        crypto_object_id: sessionMessageOrdinaryRepairs.cryptoObjectId,
      }).from(sessionMessageOrdinaryRepairs).where(and(
        eq(sessionMessageOrdinaryRepairs.sessionId, input.sessionId),
        eq(sessionMessageOrdinaryRepairs.messageId, input.messageId),
        eq(sessionMessageOrdinaryRepairs.editRevision, input.revision),
      ))), "ordinary repair receipt");
      // Each caller independently authenticates the exact protected source.
      // Current authority, immutable object/class and byte-for-byte ordinary
      // parity above permit different admitted Runtime/device attestations to
      // converge while preserving the first append-only restoration receipt.
      const receiptMatchesProtectedSource = receipt?.["attestation_digest"] instanceof Uint8Array
        && receipt["attestation_digest"].length === 32
        && (receipt["publisher_kind"] === "device_attested" || receipt["publisher_kind"] === "authenticated_runtime")
        && receipt["expected_key_class"] === input.expectedKeyClass
        && receipt["crypto_object_id"] === input.cryptoObjectId;
      if (alreadyExact) {
        return receiptMatchesProtectedSource ? "replayed" : "conflict";
      }
      if (receipt !== null) return "conflict";
      const repaired = oneOrNone(canonicalRows(await transaction
        .update(sessionMessages).set({
          content: input.content,
          toolCalls: input.toolCalls,
          toolName: input.toolName,
        }).where(and(
          eq(sessionMessages.id, input.messageId),
          eq(sessionMessages.sessionId, input.sessionId),
          eq(sessionMessages.editRevision, input.revision),
          eq(sessionMessages.cryptoObjectId, input.cryptoObjectId),
          isNull(sessionMessages.content),
          isNull(sessionMessages.toolCalls),
          isNull(sessionMessages.toolName),
        )).returning({ message_id: sessionMessages.id })), "ordinary repair CAS");
      if (repaired === null) return "conflict";
      const insertedReceipt = oneOrNone(canonicalRows(await transaction
        .insert(sessionMessageOrdinaryRepairs).values({
          sessionId: input.sessionId,
          messageId: input.messageId,
          editRevision: input.revision,
          cryptoObjectId: input.cryptoObjectId,
          expectedKeyClass: input.expectedKeyClass,
          authorityActorId: input.authorityActorId,
          repairIdentityDigest: input.repairIdentityDigest,
          attestationDigest: input.attestationDigest,
          publisherKind: input.publisher.kind,
          publisherId: input.publisher.id,
          policyRevision: input.publicationPolicy.expectedRevision,
        }).returning({ message_id: sessionMessageOrdinaryRepairs.messageId })),
      "ordinary repair receipt");
      if (insertedReceipt === null) {
        throw new Error("ordinary repair lost its receipt");
      }
      return "applied";
    }, "serializable");
  }

  async withExistingRepresentationPublication<Value>(input: Omit<Parameters<
    ConversationExistingRepresentationProductStorePort["withExistingRepresentationPublication"]
  >[0], "use"> & {use(product: PostgresConversationProductStore): Promise<Value>}): Promise<Value | null> {
    return this.#withExistingRepresentationPublication({
      ...input,
      prepareAuthority: () => Promise.resolve(true),
      use: (product) => input.use(product),
      disposeAuthority: () => {},
    }, "read committed");
  }

  /**
   * Bind authority reads to this exact Agent transaction. Preparation runs
   * before Room/Message locks so the authority owner can lock its complete
   * sorted Room set first. Its connection cannot escape the callback lifetime.
   */
  async withAuthorizedExistingRepresentationPublication<Value, Authority>(input: Omit<Parameters<
    ConversationExistingRepresentationProductStorePort["withExistingRepresentationPublication"]
  >[0], "use"> & {
    signal?: AbortSignal;
    prepareAuthority(connection: PostgresJsBridgeConnection): Promise<Authority | null>;
    use(product: PostgresConversationProductStore, authority: Authority): Promise<Value>;
    disposeAuthority(authority: Authority): void;
  }): Promise<Value | null> {
    return this.#withExistingRepresentationPublication(input, "serializable");
  }

  async #withExistingRepresentationPublication<Value, Authority>(input: Omit<Parameters<
    ConversationExistingRepresentationProductStorePort["withExistingRepresentationPublication"]
  >[0], "use"> & {
    signal?: AbortSignal;
    prepareAuthority(connection: PostgresJsBridgeConnection): Promise<Authority | null>;
    use(product: PostgresConversationProductStore, authority: Authority): Promise<Value>;
    disposeAuthority(authority: Authority): void;
  }, isolationLevel: "serializable" | "read committed"): Promise<Value | null> {
    this.#assertCoordinates(input);
    input.signal?.throwIfAborted();
    return this.canonicalRunner.transaction(async (transaction, executor) => {
      await acquireEncryptionPublicationFence(transaction, input.publicationPolicy);
      input.signal?.throwIfAborted();
      let live = true;
      const assertLive = (): void => {
        input.signal?.throwIfAborted();
        if (!live) throw new Error("Message publication transaction is closed");
      };
      const assertIsolation = (options?: Readonly<{isolationLevel: "serializable" | "read committed"}>): void => {
        if (options?.isolationLevel === "serializable" && isolationLevel !== "serializable") {
          throw new TypeError("Message publication cannot weaken requested serializable authority");
        }
      };
      const scopedConnection: PostgresJsBridgeConnection = {
        query: async <Row extends PostgresJsBridgeRow>(statement: string, parameters?: readonly PostgresJsBridgeScalar[]) => {
          assertLive();
          const rows = await executor.query<Row>(statement, parameters);
          assertLive();
          return rows;
        },
        transaction: async (use, options) => { assertLive(); assertIsolation(options); const value = await use(scopedConnection); assertLive(); return value; },
        transactionOnce: async (use, options) => { assertLive(); assertIsolation(options); const value = await use(scopedConnection); assertLive(); return value; },
      };
      let authority: Authority | null = null;
      try {
        authority = await input.prepareAuthority(scopedConnection);
        assertLive();
        if (authority === null) return null;
        const [coordinate] = await transaction.select({roomId: rooms.id, parentRoomId: rooms.parentRoomId})
          .from(sessions).innerJoin(rooms, eq(rooms.id, sessions.roomId)).where(eq(sessions.id, input.sessionId));
        assertLive();
        if (coordinate === undefined) return null;
        for (const roomId of [...new Set([coordinate.roomId, coordinate.parentRoomId ?? coordinate.roomId])].sort()) {
          await acquireRoomWriteLock(transaction, roomId);
          assertLive();
        }
        const [message] = await transaction.select({id: sessionMessages.id}).from(sessionMessages).where(and(
          eq(sessionMessages.id, input.messageId), eq(sessionMessages.sessionId, input.sessionId),
          eq(sessionMessages.editRevision, input.revision),
        )).for("update");
        assertLive();
        if (message === undefined) return null;
        const connection: ConversationProductPostgresConnection = {
          query: (statement, parameters) => scopedConnection.query(statement, parameters),
          transaction: async callback => {
            assertLive();
            const value = await callback(scopedConnection);
            assertLive();
            return value;
          },
        };
        const handle = await verifyConversationProductPostgresHandle(connection);
        const runner = bindConversationProductCanonicalTransactionRunner(handle, {
          transaction: async callback => {
            assertLive();
            const value = await callback(transaction, scopedConnection);
            assertLive();
            return value;
          },
        });
        const value = await input.use(new PostgresConversationProductStore(handle, runner), authority);
        assertLive();
        return value;
      } finally {
        live = false;
        if (authority !== null) input.disposeAuthority(authority);
      }
    }, {isolationLevel});
  }

  async reserveExistingRepresentationPublication(input: Parameters<
    ConversationExistingRepresentationProductStorePort["reserveExistingRepresentationPublication"]
  >[0]): Promise<"reserved" | "missing" | "conflict"> {
    this.#assertCoordinates(input);
    assertDigest("Repair source digest", input.sourceDigest);
    assertDigest("Repair reserved manifest digest", input.repairPublication.attestationDigest);
    assertConversationDurableKey("Repair reserved publisher", input.repairPublication.publisherId);
    if (input.repairPublication.publisherKind === "human_device") {
      if (this.handle.role !== "nautilo") throw new TypeError("Device reservation requires Human product role");
      assertUuid("Repair reserved Human", input.repairPublication.publisherHumanId);
    } else if (this.handle.role !== "nautilo_agent") throw new TypeError("Runtime reservation requires Agent product role");
    return canonicalTransaction(this.canonicalRunner, async (transaction) => {
      await acquireEncryptionPublicationFence(transaction, input.publicationPolicy);
      const row = await this.#lockedLifecycleCanonical(transaction, input, true);
      if (row === null) return "missing";
      const lifecycle = lifecycleFromRow(row);
      if (lifecycle.cryptoObjectId !== input.cryptoObjectId || lifecycle.repairIdentityDigest === null
        || lifecycle.completion !== "pending" || lifecycle.disposition !== "active"
        || !bytesEqual(lifecycle.repairSourceDigest ?? lifecycle.allocationRequestDigest, input.sourceDigest)
        || (this.handle.role === "nautilo_agent" && lifecycle.keyClass !== "ai")) return "conflict";
      const publication = input.repairPublication;
      const updated = await transaction.update(sessionMessageCryptoRevisions).set({
        repairPublisherKind: publication.publisherKind, repairPublisherId: publication.publisherId,
        ...(publication.publisherKind === "human_device" ? {repairPublisherHumanId: publication.publisherHumanId}
          : lifecycle.repairPublisherHumanId !== null ? {repairPublisherHumanId: null} : {}),
        repairAttestationDigest: publication.attestationDigest, updatedAt: sql`greatest(${sessionMessageCryptoRevisions.updatedAt}, CURRENT_TIMESTAMP)`,
      }).where(and(eq(sessionMessageCryptoRevisions.sessionId, input.sessionId),
        eq(sessionMessageCryptoRevisions.messageId, input.messageId), eq(sessionMessageCryptoRevisions.editRevision, input.revision)))
        .returning({messageId: sessionMessageCryptoRevisions.messageId});
      return updated.length === 1 ? "reserved" : "conflict";
    }, "read committed");
  }

  /** Called only after the authority owner proves the immutable crypto object
   * absent while holding the shared publication fence and Room/Message locks.
   * Keep the original allocation audit; replace only the current pending source. */
  async refreshPendingToolRepairSource(input: {
    sessionId: string; messageId: number; revision: number; cryptoObjectId: string;
    sourceRevision: number; sourceDigest: Uint8Array;
  }): Promise<"refreshed" | "conflict"> {
    this.#assertCoordinates(input);
    assertDigest("Current Tool repair source", input.sourceDigest);
    if (this.handle.role !== "nautilo" || !Number.isSafeInteger(input.sourceRevision)
      || input.sourceRevision < 0) throw new TypeError("Current Human Tool authority is required");
    return canonicalTransaction(this.canonicalRunner, async (transaction) => {
      const [source] = await transaction.select({revision: sessions.messageSourceRevision})
        .from(sessions).where(eq(sessions.id, input.sessionId)).for("share");
      if (source?.revision !== input.sourceRevision) return "conflict";
      const row = await this.#lockedLifecycleCanonical(transaction, input, true);
      if (row === null) return "conflict";
      const lifecycle = lifecycleFromRow(row);
      if (lifecycle.cryptoObjectId !== input.cryptoObjectId || lifecycle.authorRole !== "tool"
        || lifecycle.repairIdentityDigest === null || lifecycle.completion !== "pending"
        || lifecycle.disposition !== "active") return "conflict";
      if (bytesEqual(lifecycle.repairSourceDigest ?? lifecycle.allocationRequestDigest, input.sourceDigest)) return "refreshed";
      if (lifecycle.repairSourceRevision != null && lifecycle.repairSourceRevision >= input.sourceRevision) return "conflict";
      await transaction.update(sessionMessageCryptoRevisions).set({
        repairSourceRevision: input.sourceRevision, repairSourceDigest: input.sourceDigest,
        repairPublisherKind: null, repairPublisherId: null, repairPublisherHumanId: null,
        repairAttestationDigest: null, updatedAt: sql`greatest(${sessionMessageCryptoRevisions.updatedAt}, CURRENT_TIMESTAMP)`,
      }).where(and(eq(sessionMessageCryptoRevisions.sessionId, input.sessionId),
        eq(sessionMessageCryptoRevisions.messageId, input.messageId), eq(sessionMessageCryptoRevisions.editRevision, input.revision)));
      return "refreshed";
    }, "read committed");
  }

  async allocateExistingRepresentation(
    input: Parameters<
      ConversationExistingRepresentationProductStorePort["allocateExistingRepresentation"]
    >[0],
  ): ReturnType<
    ConversationExistingRepresentationProductStorePort["allocateExistingRepresentation"]
  > {
    this.#assertCoordinates(input);
    const keyClass = input.expectedKeyClass ?? "ai";
    if ((keyClass !== "ai" && keyClass !== "human")
      || (input.publisher.kind === "foreground_runtime" && keyClass !== "ai")) {
      throw new TypeError("Existing Message publisher cannot allocate this key class");
    }
    const publisherId = input.publisher.kind === "human_device"
      ? input.publisher.humanActorId
      : input.publisher.agentId;
    assertUuid("existing Message representation publisher ID", publisherId);
    assertConversationDurableKey(
      "existing Message representation operation ID",
      input.operationId,
    );
    assertUuid("Conversation Namespace ID", input.expectedNamespaceId);
    assertConversationAuthorRole(input.expectedAuthorRole);
    if (input.expectedAuthorHumanTurnId !== null) {
      assertConversationDurableKey(
        "existing Message Human turn ID",
        input.expectedAuthorHumanTurnId,
      );
    }
    if (input.expectedSessionAgentId !== null) {
      assertUuid("existing Message Session Agent ID", input.expectedSessionAgentId);
    }
    if (
      input.expectedAuthorRole !== "user"
      && input.expectedAuthorHumanTurnId !== null
    ) throw new TypeError("Only a user Message may have Human-turn provenance");
    assertDigest(
      "existing Message representation allocation digest",
      input.requestDigest,
    );
    assertDigest(
      "existing Message representation repair identity digest",
      input.repairIdentityDigest,
    );
    const expectedRole = input.publisher.kind === "human_device"
      ? "nautilo"
      : "nautilo_agent";
    if (this.handle.role !== expectedRole) {
      throw new TypeError(
        `existing Message representation allocation requires the ${expectedRole} role`,
      );
    }

    return readCommitted(this.handle, async (transaction) => {
      // Both publishers acquire Room locks before Message/lifecycle locks.
      // The lifecycle insert's Room FK otherwise takes a late key-share lock
      // and can deadlock against a Human publication already holding that Room.
      const room = oneOrNone(await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({id: rooms.id, parent_room_id: rooms.parentRoomId})
          .from(sessions).innerJoin(rooms, eq(rooms.id, sessions.roomId))
          .where(eq(sessions.id, input.sessionId)),
      ), "existing Message representation Room");
      if (room === null) return {status: "missing"} as const;
      const roomId = requiredString(room, "id");
      for (const id of [...new Set([roomId, nullableString(room, "parent_room_id") ?? roomId])].sort()) {
        await executeTypedConversationProductQuery(transaction,
          conversationProductTypedDb.select({id: rooms.id}).from(rooms)
            .where(eq(rooms.id, id)).for("update"));
      }
      const selection = {
        message_id: sessionMessages.id,
        session_id: sessionMessages.sessionId,
        role: sessionMessages.role,
        human_turn_id: sessionMessages.humanTurnId,
        edit_revision: sessionMessages.editRevision,
        crypto_object_id: sessionMessages.cryptoObjectId,
        subthread_room_id: sessionMessages.subthreadRoomId,
        room_id: sessions.roomId,
        agent_id: sessions.agentId,
        namespace_id: rooms.namespaceId,
      } as const;
      const rows = input.publisher.kind === "human_device"
        ? await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb.select(selection).from(sessionMessages)
            .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
            .innerJoin(rooms, eq(rooms.id, sessions.roomId))
            .innerJoin(roomMembers, eq(roomMembers.roomId, sql`coalesce(${rooms.parentRoomId}, ${rooms.id})`))
            .innerJoin(actors, eq(actors.id, roomMembers.actorId))
            .where(and(
              eq(sessionMessages.id, input.messageId),
              eq(actors.kind, "user"),
              eq(actors.id, publisherId),
              sql`${actors.ownerId} = app_current_user_id()`,
            ))
            .limit(2)
            .for("update", { of: sessionMessages }),
        )
        : await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb.select(selection).from(sessionMessages)
            .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
            .innerJoin(rooms, eq(rooms.id, sessions.roomId))
            .where(and(
              eq(sessionMessages.id, input.messageId),
              sql`app_agent_in_room(${rooms.id})`,
              sql`app_current_agent_id() = ${publisherId}::uuid`,
            ))
            .limit(2)
            .for("update", { of: sessionMessages }),
        );
      const row = oneOrNone(rows, "existing Message representation source");
      if (row === null) return { status: "missing" } as const;
      if (
        requiredString(row, "session_id") !== input.sessionId
        || requiredInteger(row, "edit_revision") !== input.revision
        || requiredString(row, "namespace_id") !== input.expectedNamespaceId
        || requiredString(row, "role") !== input.expectedAuthorRole
        || nullableString(row, "human_turn_id")
          !== input.expectedAuthorHumanTurnId
        || nullableString(row, "agent_id") !== input.expectedSessionAgentId
      ) return { status: "stale" } as const;

      const mappedObjectId = nullableString(row, "crypto_object_id");
      const cryptoObjectId = deriveMessageCryptoObjectIdV2(input);
      const existingRows = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select(lifecycleSelection)
          .from(sessionMessageCryptoRevisions).where(and(
            eq(sessionMessageCryptoRevisions.sessionId, input.sessionId),
            eq(sessionMessageCryptoRevisions.messageId, input.messageId),
            eq(sessionMessageCryptoRevisions.editRevision, input.revision),
          )).limit(2).for("update"),
      );
      const existing = oneOrNone(
        existingRows,
        "existing Message representation allocation receipt",
      );
      if (existing !== null) {
        const lifecycle = lifecycleFromRow(existing);
        // The allocation receipt owns the one deterministic representation for
        // this exact Message revision. A later foreground invocation may have
        // a fresh policy/authority-bound repair identity after a crash, but it
        // must still be able to finish that same representation when the
        // source bytes and immutable Message coordinates still match. Keep the
        // original repair identity on the receipt as audit evidence; it is not
        // an authorization token for resumption.
        return lifecycle.cryptoObjectId === cryptoObjectId
            && lifecycle.namespaceIdAtAllocation === input.expectedNamespaceId
            && lifecycle.authorRole === input.expectedAuthorRole
            && lifecycle.keyClass === keyClass
            && bytesEqual(
              lifecycle.repairSourceDigest ?? lifecycle.allocationRequestDigest,
              input.requestDigest,
            )
            && lifecycle.repairIdentityDigest !== null
          ? { status: "replayed", lifecycle } as const
          : { status: "conflict" } as const;
      }
      if (mappedObjectId !== null) {
        return { status: "already_mapped" } as const;
      }

      const inserted = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.insert(sessionMessageCryptoRevisions).values({
          sessionId: input.sessionId,
          messageId: input.messageId,
          editRevision: input.revision,
          roomId: requiredString(row, "room_id"),
          namespaceIdAtAllocation: input.expectedNamespaceId,
          cryptoObjectId,
          payloadVersion: 2,
          keyClass,
          authorRole: input.expectedAuthorRole,
          subthreadReplyClassification: row["subthread_room_id"] === null ? "excluded" : "counted",
          appendIdempotencyKey: input.revision === 0 ? input.operationId : null,
          allocationRequestDigest: input.requestDigest,
          repairIdentityDigest: input.repairIdentityDigest,
          completion: "pending",
          disposition: "active",
          parityStatus: "pending",
          attemptCount: 0,
          nextAttemptAt: sql`CURRENT_TIMESTAMP`,
        }).returning(lifecycleSelection),
      );
      const insertedRow = oneOrNone(
        inserted,
        "existing Message representation allocation",
      );
      if (insertedRow === null) {
        throw new Error(
          "existing Message representation allocation lost its receipt",
        );
      }
      return {
        status: "allocated",
        lifecycle: lifecycleFromRow(insertedRow),
      } as const;
    });
  }

  async getRevision(
    messageId: number,
    revision: number,
  ): Promise<ConversationRevisionState | null> {
    assertConversationMessageId(messageId);
    assertConversationRevision(revision);
    return readCommitted(this.handle, async (transaction) => {
      const rows = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          ...lifecycleSelection,
          ...joinedMessageSelection,
        }).from(sessionMessageCryptoRevisions).leftJoin(
          sessionMessages,
          and(
            eq(sessionMessages.id, sessionMessageCryptoRevisions.messageId),
            eq(
              sessionMessages.sessionId,
              sessionMessageCryptoRevisions.sessionId,
            ),
            eq(
              sessionMessages.editRevision,
              sessionMessageCryptoRevisions.editRevision,
            ),
          ),
        ).where(and(
          eq(sessionMessageCryptoRevisions.messageId, messageId),
          eq(sessionMessageCryptoRevisions.editRevision, revision),
        )).limit(2),
      );
      const row = oneOrNone(rows, "Conversation revision lookup");
      return row === null ? null : stateFromRow(row);
    });
  }

  async getRevisionMapping(
    sessionId: string,
    messageId: number,
    revision: number,
  ): Promise<ConversationRevisionMappingState | null> {
    assertConversationSessionId(sessionId);
    assertConversationMessageId(messageId);
    assertConversationRevision(revision);
    return readCommitted(this.handle, async (transaction) => {
      const rows = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          ...lifecycleSelection,
          ...joinedMessageMappingSelection,
        }).from(sessionMessageCryptoRevisions).leftJoin(
          sessionMessages,
          and(
            eq(sessionMessages.id, sessionMessageCryptoRevisions.messageId),
            eq(
              sessionMessages.sessionId,
              sessionMessageCryptoRevisions.sessionId,
            ),
            eq(
              sessionMessages.editRevision,
              sessionMessageCryptoRevisions.editRevision,
            ),
          ),
        ).where(and(
          eq(sessionMessageCryptoRevisions.sessionId, sessionId),
          eq(sessionMessageCryptoRevisions.messageId, messageId),
          eq(sessionMessageCryptoRevisions.editRevision, revision),
        )),
      );
      const row = oneOrNone(rows, "Conversation revision mapping lookup");
      return row === null ? null : mappingStateFromRow(row);
    });
  }

  async inspectProtectedEditPlanSource(
    messageId: number,
    expectedRevision: number,
  ): Promise<ConversationProtectedEditPlanSource | null> {
    assertConversationMessageId(messageId);
    assertConversationRevision(expectedRevision);
    return readCommitted(this.handle, async (transaction) => {
      const targetRows = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          room_id: sql<string>`${sessions.roomId}`.as("room_id"),
          subject_user_id: sql<string>`${sessions.ownerId}`.as("subject_user_id"),
          author_human_id: sql<string>`${actors.id}`.as("author_human_id"),
          fingerprint: sql<string | null>`${sessionMessages.fingerprint}`.as("fingerprint"),
          role: sql<string>`${sessionMessages.role}`.as("role"),
          edit_revision: sql<number>`${sessionMessages.editRevision}`.as("edit_revision"),
        }).from(sessionMessages)
          .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
          .innerJoin(actors, and(
            eq(actors.ownerId, sessions.ownerId),
            eq(actors.kind, "user"),
          ))
          .where(eq(sessionMessages.id, messageId)),
      );
      const target = oneOrNone(targetRows, "Protected edit structural target");
      if (
        target === null
        || requiredString(target, "role") !== "user"
        || requiredInteger(target, "edit_revision") !== expectedRevision
      ) return null;
      const fingerprint = nullableString(target, "fingerprint");
      const memberRows = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          ...lifecycleSelection,
          current_session_id: sql<string>`${sessionMessages.sessionId}`.as("current_session_id"),
          current_message_id: sql<number>`${sessionMessages.id}`.as("current_message_id"),
          current_edit_revision: sql<number>`${sessionMessages.editRevision}`.as("current_edit_revision"),
          current_created_at: sql<Date>`${sessionMessages.createdAt}`.as("current_created_at"),
          current_edited_at: sql<Date | null>`${sessionMessages.editedAt}`.as("current_edited_at"),
          current_crypto_object_id: sql<string | null>`${sessionMessages.cryptoObjectId}`.as("current_crypto_object_id"),
          current_namespace_id: sql<string>`${rooms.namespaceId}`.as("current_namespace_id"),
          shared_origin_agent_id: sql<string | null>`${conversationSharedAgentShadowOperations.agentId}`.as("shared_origin_agent_id"),
        }).from(sessionMessages)
          .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
          .innerJoin(rooms, eq(rooms.id, sessions.roomId))
          .innerJoin(sessionMessageCryptoRevisions, and(
            eq(sessionMessageCryptoRevisions.sessionId, sessionMessages.sessionId),
            eq(sessionMessageCryptoRevisions.messageId, sessionMessages.id),
            eq(sessionMessageCryptoRevisions.editRevision, sessionMessages.editRevision),
          ))
          .leftJoin(conversationSharedAgentShadowOperations, eq(
            conversationSharedAgentShadowOperations.operationId,
            sessionMessageCryptoRevisions.sharedAgentShadowOperationId,
          ))
          .where(fingerprint === null
            ? eq(sessionMessages.id, messageId)
            : and(
              eq(sessions.roomId, requiredString(target, "room_id")),
              eq(sessions.ownerId, requiredString(target, "subject_user_id")),
              eq(sessionMessages.role, "user"),
              eq(sessionMessages.fingerprint, fingerprint),
            ))
          .orderBy(asc(sessionMessages.id)),
      );
      if (memberRows.length < 1) return null;
      const lifecycles = memberRows.map(lifecycleFromRow);
      if (lifecycles.some((lifecycle, index) =>
        lifecycle.authorRole !== "user"
        || lifecycle.revision !== expectedRevision
        || lifecycle.completion !== "complete"
        || (lifecycle.disposition !== "active" && lifecycle.disposition !== "mapped")
        || requiredInteger(memberRows[index]!, "current_message_id") !== lifecycle.messageId
        || requiredString(memberRows[index]!, "current_session_id") !== lifecycle.sessionId
        || requiredInteger(memberRows[index]!, "current_edit_revision") !== expectedRevision
        || nullableString(memberRows[index]!, "current_crypto_object_id") !== lifecycle.cryptoObjectId
        || requiredString(memberRows[index]!, "current_namespace_id") !== lifecycle.namespaceIdAtAllocation
      )) return null;
      const schemes = new Set(lifecycles.map((lifecycle, index) =>
        lifecycle.humanPeerShadowOperationId !== null ? "human_peer_v1" as const
          : lifecycle.sharedAgentShadowOperationId !== null
            ? nullableString(memberRows[index]!, "shared_origin_agent_id") === null
              ? "human_ai_readable_v1" as const
              : "shared_agent_v1" as const
          : lifecycle.shadowOperationId !== null ? "foreground_session_v1" as const
          : null
      ));
      if (schemes.size !== 1 || schemes.has(null)) return null;
      return Object.freeze({
        roomId: requiredString(target, "room_id"),
        subjectUserId: requiredString(target, "subject_user_id"),
        authorHumanId: requiredString(target, "author_human_id"),
        logicalMessageKey: fingerprint,
        authorizationScheme: [...schemes][0]!,
        targets: Object.freeze(lifecycles.map((lifecycle, index) => Object.freeze({
          sessionId: lifecycle.sessionId,
          messageId: lifecycle.messageId,
          expectedRevision,
          createdAt: requiredDate(memberRows[index]!, "current_created_at").getTime(),
          editedAt: nullableDate(memberRows[index]!, "current_edited_at")?.getTime() ?? null,
          namespaceId: lifecycle.namespaceIdAtAllocation,
          keyClass: lifecycle.keyClass,
          cryptoObjectId: lifecycle.cryptoObjectId,
        })).sort((left, right) =>
          left.sessionId.localeCompare(right.sessionId) || left.messageId - right.messageId
        )),
      });
    });
  }

  async resolveCurrentNamespace(sessionId: string): Promise<string | null> {
    assertConversationSessionId(sessionId);
    return readCommitted(this.handle, async (transaction) => {
      const rows = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          namespace_id: rooms.namespaceId,
        }).from(sessions).innerJoin(rooms, eq(rooms.id, sessions.roomId))
          .where(eq(sessions.id, sessionId)).limit(2),
      );
      const row = oneOrNone(rows, "Conversation Namespace lookup");
      if (row === null) return null;
      const namespaceId = requiredString(row, "namespace_id");
      assertUuid("Conversation Namespace ID", namespaceId);
      return namespaceId;
    });
  }

  async markCryptoComplete(
    input: ConversationRevisionCoordinates & {
      readonly cryptoObjectId: string;
      readonly parityStatus: ConversationParityStatus;
      readonly leaseToken: string | null;
      readonly repairPublication?: ConversationRepairPublicationEvidence;
      readonly publicationPolicy?: ConversationProductAppendInput["publicationPolicy"];
    },
  ): Promise<"applied" | "duplicate" | "missing" | "conflict"> {
    this.#assertCoordinates(input);
    assertConversationDurableKey(
      "conversation crypto object ID",
      input.cryptoObjectId,
    );
    if (input.leaseToken !== null) {
      assertUuid("Conversation lease token", input.leaseToken);
    }
    if (input.repairPublication !== undefined) {
      if (input.repairPublication.publisherKind === "human_device") {
        assertUuid("Conversation repairing Human", input.repairPublication.publisherHumanId);
      }
      if (input.publicationPolicy === undefined) {
        throw new TypeError(
          "Conversation repair completion requires its prepared publication policy",
        );
      }
      assertConversationDurableKey(
        "conversation repair publisher ID",
        input.repairPublication.publisherId,
      );
      assertDigest(
        "Conversation repair attestation digest",
        input.repairPublication.attestationDigest,
      );
    }
    if (this.handle.role === "nautilo_agent" && input.parityStatus !== "server_verified"
      && input.parityStatus !== "server_authenticated" && input.repairPublication?.publisherKind !== "human_device") {
      throw new TypeError("nautilo_agent may mark only server-authenticated AI revisions complete or exact reserved device evidence");
    }
    return canonicalTransaction(this.canonicalRunner, async (transaction) => {
      if (input.publicationPolicy !== undefined) {
        await acquireEncryptionPublicationFence(transaction, input.publicationPolicy);
      }
      const row = await this.#lockedLifecycleCanonical(
        transaction,
        input,
        true,
      );
      if (row === null) return "missing";
      const lifecycle = lifecycleFromRow(row);
      if (lifecycle.completion === "pending" && lifecycle.repairPublisherKind !== null
        && (input.repairPublication === undefined || lifecycle.repairPublisherKind !== input.repairPublication.publisherKind
          || lifecycle.repairPublisherId !== input.repairPublication.publisherId
          || (lifecycle.repairPublisherHumanId ?? null) !== (input.repairPublication.publisherHumanId ?? null)
          || lifecycle.repairAttestationDigest === null
          || !bytesEqual(lifecycle.repairAttestationDigest, input.repairPublication.attestationDigest))) return "conflict";
      const reservedDeviceRecovery = input.repairPublication?.publisherKind === "human_device"
        && lifecycle.repairPublisherKind === "human_device"
        && lifecycle.repairPublisherId === input.repairPublication.publisherId
        && lifecycle.repairPublisherHumanId === input.repairPublication.publisherHumanId
        && lifecycle.repairAttestationDigest !== null
        && bytesEqual(lifecycle.repairAttestationDigest, input.repairPublication.attestationDigest)
        && input.parityStatus === "client_authenticated";
      if (this.handle.role === "nautilo_agent" && !reservedDeviceRecovery
        && input.parityStatus !== "server_verified" && input.parityStatus !== "server_authenticated") {
        throw new TypeError("Agent completion requires Runtime verification or exact reserved device evidence");
      }
      if (
        this.handle.role === "nautilo_agent"
        && (
          lifecycle.keyClass !== "ai"
          || (
            lifecycle.authorRole === "user"
            && !reservedDeviceRecovery
            && (
              lifecycle.repairIdentityDigest === null
              || input.repairPublication?.publisherKind !== "foreground_runtime"
            )
          )
        )
      ) {
        throw new TypeError(
          "nautilo_agent may mark only server-authenticated AI revisions complete",
        );
      }
      if (
        lifecycle.sessionId !== input.sessionId
        || lifecycle.cryptoObjectId !== input.cryptoObjectId
        || !leaseMatches(row, lifecycle, input.leaseToken)
        || !parityAllowed(
          lifecycle,
          input.parityStatus,
          input.repairPublication,
        )
        || ((lifecycle.repairIdentityDigest === null)
          !== (input.repairPublication === undefined))
        || lifecycle.disposition === "superseded"
        || lifecycle.disposition === "hard_delete"
        || lifecycle.disposition === "stale_mapping"
        || lifecycle.disposition === "quarantined"
        || lifecycle.disposition === "blocked"
      ) return "conflict";
      const parity = input.parityStatus === "pending"
        ? lifecycle.parityStatus
        : input.parityStatus;
      if (
        lifecycle.completion === "complete"
        && lifecycle.parityStatus !== "pending"
        && input.parityStatus !== "pending"
        && lifecycle.parityStatus !== input.parityStatus
      ) return "conflict";
      if (
        lifecycle.completion === "complete"
        && lifecycle.parityStatus === parity
      ) {
        return input.repairPublication === undefined
          || (
            lifecycle.repairPublisherKind
              === input.repairPublication.publisherKind
            && lifecycle.repairPublisherId
              === input.repairPublication.publisherId
            && (lifecycle.repairPublisherHumanId ?? null)
              === (input.repairPublication.publisherHumanId ?? null)
            && lifecycle.repairAttestationDigest !== null
            && bytesEqual(
              lifecycle.repairAttestationDigest,
              input.repairPublication.attestationDigest,
            )
          )
          ? "duplicate"
          : "conflict";
      }
      const updated = canonicalRows(await
        transaction.update(sessionMessageCryptoRevisions).set({
          completion: "complete",
          parityStatus: parity,
          repairPublisherKind:
            input.repairPublication?.publisherKind ?? null,
          repairPublisherId: input.repairPublication?.publisherId ?? null,
          ...(input.repairPublication?.publisherKind === "human_device" && this.handle.role === "nautilo"
            ? {repairPublisherHumanId: input.repairPublication.publisherHumanId} : {}),
          repairAttestationDigest:
            input.repairPublication?.attestationDigest ?? null,
          cryptoCompletedAt:
            sql`coalesce(${sessionMessageCryptoRevisions.cryptoCompletedAt}, CURRENT_TIMESTAMP)`,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(and(
          eq(sessionMessageCryptoRevisions.sessionId, input.sessionId),
          eq(sessionMessageCryptoRevisions.messageId, input.messageId),
          eq(sessionMessageCryptoRevisions.editRevision, input.revision),
          eq(
            sessionMessageCryptoRevisions.cryptoObjectId,
            input.cryptoObjectId,
          ),
          sql`${sessionMessageCryptoRevisions.leaseToken}
            IS NOT DISTINCT FROM ${input.leaseToken}::uuid`,
        )).returning(lifecycleSelection));
      return oneOrNone(updated, "Conversation completion update") === null
        ? "conflict"
        : "applied";
    }, "serializable");
  }

  async compareAndSwapCryptoMapping(
    input: ConversationRevisionCoordinates & {
      readonly expectedNamespaceId: string;
      readonly cryptoObjectId: string;
      readonly leaseToken: string | null;
      readonly publicationPolicy?: ConversationProductAppendInput["publicationPolicy"];
    },
  ): Promise<ConversationProductMappingCasResult> {
    this.#assertCoordinates(input);
    assertUuid("Conversation Namespace ID", input.expectedNamespaceId);
    assertConversationDurableKey(
      "conversation crypto object ID",
      input.cryptoObjectId,
    );
    if (input.leaseToken !== null) {
      assertUuid("Conversation lease token", input.leaseToken);
    }
    return canonicalTransaction(this.canonicalRunner, async (transaction) => {
      if (input.publicationPolicy !== undefined) {
        await acquireEncryptionPublicationFence(transaction, input.publicationPolicy);
      }
      const messageRows = canonicalRows(await
        transaction.select({
          message_id: sessionMessages.id,
          session_id: sessionMessages.sessionId,
          edit_revision: sessionMessages.editRevision,
          crypto_object_id: sessionMessages.cryptoObjectId,
        }).from(sessionMessages).where(eq(sessionMessages.id, input.messageId))
          .limit(2).for("update", { of: sessionMessages }));
      const messageRow = oneOrNone(
        messageRows,
        "Conversation mapping message",
      );
      const row = await this.#lockedLifecycleCanonical(transaction, input, true);
      if (row === null) return "missing";
      const lifecycle = lifecycleFromRow(row);
      if (!leaseMatches(row, lifecycle, input.leaseToken)) {
        return "lease_lost";
      }
      if (
        lifecycle.sessionId !== input.sessionId
        || lifecycle.cryptoObjectId !== input.cryptoObjectId
        || lifecycle.completion !== "complete"
        || (
          lifecycle.disposition !== "active"
          && lifecycle.disposition !== "mapped"
        )
      ) return "stale";

      if (lifecycle.disposition !== "mapped"
        && !await lockLiveShadowExecutionForPublication(transaction, lifecycle)) {
        return "stale";
      }

      if (
        lifecycle.namespaceIdAtAllocation !== input.expectedNamespaceId
      ) {
        await this.#persistStaleMappingCanonical(transaction, lifecycle);
        return "wrong_namespace";
      }
      const namespaceRows = canonicalRows(await
        transaction.select({
          namespace_id: rooms.namespaceId,
        }).from(sessions).innerJoin(rooms, eq(rooms.id, sessions.roomId)).where(
          and(
            eq(sessions.id, input.sessionId),
            eq(sessions.roomId, lifecycle.roomId),
          ),
        ).limit(2).for("share", { of: [sessions, rooms] }));
      const namespaceRow = oneOrNone(
        namespaceRows,
        "Conversation mapping Namespace",
      );
      if (
        namespaceRow === null
        || requiredString(namespaceRow, "namespace_id")
          !== input.expectedNamespaceId
      ) {
        await this.#persistStaleMappingCanonical(transaction, lifecycle);
        return "wrong_namespace";
      }

      if (messageRow === null) {
        await this.#persistStaleMappingCanonical(transaction, lifecycle);
        return "missing";
      }
      if (
        requiredString(messageRow, "session_id") !== input.sessionId
        || requiredInteger(messageRow, "edit_revision") !== input.revision
      ) {
        await this.#persistStaleMappingCanonical(transaction, lifecycle);
        return "stale";
      }
      const currentObjectId = nullableString(
        messageRow,
        "crypto_object_id",
      );
      if (
        currentObjectId !== null
        && currentObjectId !== input.cryptoObjectId
      ) {
        await this.#persistStaleMappingCanonical(transaction, lifecycle);
        return "stale";
      }
      const duplicate = currentObjectId === input.cryptoObjectId;
      if (!duplicate) {
        const mappedMessage = canonicalRows(await
          transaction.update(sessionMessages).set({
            cryptoObjectId: input.cryptoObjectId,
          }).where(and(
            eq(sessionMessages.id, input.messageId),
            eq(sessionMessages.sessionId, input.sessionId),
            eq(sessionMessages.editRevision, input.revision),
            sql`${sessionMessages.cryptoObjectId} IS NULL`,
          )).returning({ message_id: sessionMessages.id }));
        if (oneOrNone(mappedMessage, "Conversation mapping CAS") === null) {
          await this.#persistStaleMappingCanonical(transaction, lifecycle);
          return "stale";
        }
      }
      const mappedLifecycle = canonicalRows(await
        transaction.update(sessionMessageCryptoRevisions).set({
          completion: "complete",
          disposition: "mapped",
          failureCode: null,
          nextAttemptAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(and(
          eq(sessionMessageCryptoRevisions.sessionId, input.sessionId),
          eq(sessionMessageCryptoRevisions.messageId, input.messageId),
          eq(sessionMessageCryptoRevisions.editRevision, input.revision),
          eq(
            sessionMessageCryptoRevisions.cryptoObjectId,
            input.cryptoObjectId,
          ),
        )).returning(lifecycleSelection));
      if (
        oneOrNone(mappedLifecycle, "Conversation mapped lifecycle") === null
      ) throw new Error("Mapping CAS lost its lifecycle");
      return duplicate ? "duplicate" : "applied";
    }, "serializable");
  }

  async editAllocated(input: {
    readonly messageId: number;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly content: string;
    readonly subthreadReplyClassification: "counted" | "excluded";
    readonly requestDigest: Uint8Array;
  }): Promise<ConversationProductEditResult> {
    assertConversationMessageId(input.messageId);
    assertConversationRevision(input.expectedRevision);
    assertConversationDurableKey(
      "message edit operation ID",
      input.operationId,
    );
    assertConversationSubthreadReplyClassification(
      input.subthreadReplyClassification,
    );
    assertDigest("Edit request digest", input.requestDigest);
    return canonicalTransaction(
      this.canonicalRunner,
      async (transaction) => {
        await transaction.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtext('conversation-terminal'),
            hashtext(${input.operationId})
          )
        `);
        const replay = await canonicalEditReplay(transaction, input);
        if (replay !== null) return replay;

        const edited = await editCanonicalTranscriptMessageInTx(
          transaction,
          {
            messageId: input.messageId,
            expectedRevision: input.expectedRevision,
            content: input.content,
            clearCryptoObjectId: true,
          },
          {
            afterRowsEdited: async ({ rows, nextRevision }) => {
              assertConversationRevision(nextRevision);
              const previousRows = canonicalRows(
                await transaction.select(lifecycleSelection)
                  .from(sessionMessageCryptoRevisions).where(and(
                    inArray(
                      sessionMessageCryptoRevisions.messageId,
                      rows.map((row) => row.messageId),
                    ),
                    eq(
                      sessionMessageCryptoRevisions.editRevision,
                      input.expectedRevision,
                    ),
                  )).orderBy(asc(sessionMessageCryptoRevisions.messageId))
                  .for("update", { of: sessionMessageCryptoRevisions }),
              );
              if (previousRows.length !== rows.length) {
                throw new Error(
                  "Conversation logical edit is missing a physical lifecycle",
                );
              }
              const previousByMessage = new Map(
                previousRows.map((row) => {
                  const lifecycle = lifecycleFromRow(row);
                  return [lifecycle.messageId, lifecycle] as const;
                }),
              );
              const nextLifecycles: ConversationRevisionLifecycle[] = [];
              for (const physical of rows) {
                const previous = previousByMessage.get(physical.messageId);
                if (
                  previous === undefined
                  || previous.sessionId !== physical.sessionId
                  || previous.authorRole !== physical.role
                ) {
                  throw new Error(
                    "Conversation logical edit lifecycle coordinates disagree",
                  );
                }
                if (
                  previous.disposition === "superseded"
                  || previous.disposition === "hard_delete"
                ) {
                  throw new Error(
                    "Conversation logical edit raced a terminal mutation",
                  );
                }
                if (
                  this.handle.role === "nautilo_agent"
                  && (
                    previous.keyClass !== "ai"
                    || previous.authorRole === "user"
                    || previous.parityStatus === "client_verified"
                  )
                ) {
                  throw new TypeError(
                    "nautilo_agent cannot edit a Human-authorized transcript revision",
                  );
                }
                const memberOperationId =
                  physical.messageId === input.messageId
                    ? input.operationId
                    : editMemberOperationId(
                      input.operationId,
                      physical.messageId,
                    );
                const terminal = canonicalRows(
                  await transaction.update(sessionMessageCryptoRevisions).set({
                    disposition: "superseded",
                    attemptCount: 0,
                    terminalOperationId: memberOperationId,
                    terminalOperationGroupId: input.operationId,
                    terminalOperationType: "edit",
                    terminalExpectedRevision: input.expectedRevision,
                    terminalRequestDigest:
                      Uint8Array.from(input.requestDigest),
                    nextAttemptAt: null,
                    failureCode: null,
                    leaseToken: null,
                    leaseExpiresAt: null,
                    quarantineLeaseToken: null,
                    updatedAt: sql`CURRENT_TIMESTAMP`,
                  }).where(and(
                    eq(
                      sessionMessageCryptoRevisions.sessionId,
                      previous.sessionId,
                    ),
                    eq(
                      sessionMessageCryptoRevisions.messageId,
                      previous.messageId,
                    ),
                    eq(
                      sessionMessageCryptoRevisions.editRevision,
                      input.expectedRevision,
                    ),
                  )).returning({
                    sequence: sessionMessageCryptoRevisions.sequence,
                  }),
                );
                if (
                  oneOrNone(terminal, "Conversation edit group receipt")
                    === null
                ) {
                  throw new Error(
                    "Conversation logical edit lost a physical receipt",
                  );
                }

                const nextObjectId = deriveMessageCryptoObjectIdV2({
                  sessionId: previous.sessionId,
                  messageId: previous.messageId,
                  revision: nextRevision,
                });
                const inserted = canonicalRows(
                  await transaction.insert(sessionMessageCryptoRevisions)
                    .values({
                      sessionId: previous.sessionId,
                      messageId: previous.messageId,
                      editRevision: nextRevision,
                      roomId: previous.roomId,
                      namespaceIdAtAllocation:
                        previous.namespaceIdAtAllocation,
                      cryptoObjectId: nextObjectId,
                      payloadVersion: CONVERSATION_MESSAGE_PAYLOAD_VERSION,
                      keyClass: previous.keyClass,
                      authorRole: previous.authorRole,
                      subthreadReplyClassification:
                        input.subthreadReplyClassification,
                      appendIdempotencyKey: null,
                      allocationRequestDigest:
                        Uint8Array.from(input.requestDigest),
                      completion: "pending",
                      disposition: "active",
                      parityStatus: "pending",
                      attemptCount: 0,
                      nextAttemptAt: sql`CURRENT_TIMESTAMP`,
                    }).returning(lifecycleSelection),
                );
                const insertedRow = oneOrNone(
                  inserted,
                  "Conversation edit allocation",
                );
                if (insertedRow === null) {
                  throw new Error(
                    "Conversation logical edit lost a lifecycle allocation",
                  );
                }
                nextLifecycles.push(lifecycleFromRow(insertedRow));
              }
              return Object.freeze(nextLifecycles);
            },
          },
        );
        if (edited === null) {
          const existing = canonicalRows(
            await transaction.select({
              edit_revision: sessionMessages.editRevision,
            }).from(sessionMessages).where(eq(
              sessionMessages.id,
              input.messageId,
            )).limit(2),
          );
          return oneOrNone(existing, "Conversation edit stale lookup") === null
            ? { status: "missing" }
            : { status: "stale" };
        }
        if (edited.hookResult === undefined) {
          throw new Error("Canonical edit lost its lifecycle hook result");
        }
        return {
          status: "allocated",
          lifecycles: edited.hookResult,
        };
      },
      "serializable",
    );
  }

  async publishProtectedEdit(input: {
    readonly messageId: number;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly requestDigest: Uint8Array;
    readonly policyRevision: number;
    readonly lockCryptoAuthority: () => Promise<void>;
    readonly targets: readonly Readonly<{
      sessionId: string;
      messageId: number;
      namespaceId: string;
      cryptoObjectId: string;
      keyClass: "ai" | "human";
      namespaceAccessRevision: number;
      namespaceKeyGeneration: number;
      namespaceAudienceFingerprint: Uint8Array;
    }>[];
  }): Promise<ConversationProductEditResult> {
    assertConversationMessageId(input.messageId);
    assertConversationRevision(input.expectedRevision);
    assertConversationRevision(input.policyRevision);
    assertConversationDurableKey("protected message edit operation ID", input.operationId);
    assertDigest("Protected edit request digest", input.requestDigest);
    if (input.targets.length < 1) {
      throw new TypeError("Protected edit target set must not be empty");
    }
    for (const target of input.targets) {
      assertConversationSessionId(target.sessionId);
      assertConversationMessageId(target.messageId);
      assertConversationMessageKeyClass(target.keyClass);
      assertConversationDurableKey("protected edit Namespace ID", target.namespaceId);
      assertConversationDurableKey("protected edit object ID", target.cryptoObjectId);
      if (deriveHumanMessageEditCryptoObjectIdV1({
        operationId: input.operationId,
        sessionId: target.sessionId,
        messageId: target.messageId,
        revision: input.expectedRevision + 1,
      }) !== target.cryptoObjectId) {
        throw new TypeError("Protected edit object coordinates disagree");
      }
    }
    return canonicalTransaction(this.canonicalRunner, async (transaction) => {
      await transaction.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext('conversation-terminal'),
          hashtext(${input.operationId})
        )
      `);
      const replay = await canonicalEditReplay(transaction, input);
      if (replay !== null) return replay;
      const edited = await editCanonicalTranscriptMessageInTx(
        transaction,
        {
          messageId: input.messageId,
          expectedRevision: input.expectedRevision,
          content: null,
          protectedTargets: input.targets,
          publicationPolicy: {
            expectedRevision: input.policyRevision,
            representation: "protected_only",
          },
        },
        {
          beforeRowsEdited: async ({ tx, roomId }) => {
            const authorityRows = canonicalRows(await tx.select({
              namespace_id: rooms.namespaceId,
              namespace_access_revision: rooms.namespaceAccessRevision,
            }).from(rooms).where(eq(rooms.id, roomId)));
            const room = oneOrNone(authorityRows, "Protected edit Room authority");
            if (room === null) throw new TypeError("Protected edit Room authority is stale");
            for (const target of input.targets) {
              if (
                requiredString(room, "namespace_id") !== target.namespaceId
                || requiredInteger(room, "namespace_access_revision") !== target.namespaceAccessRevision
              ) throw new TypeError("Protected edit Namespace authority is stale");
            }
            await input.lockCryptoAuthority();
          },
          afterRowsEdited: async ({ rows, nextRevision, editedAt }) => {
            const targetByMessage = new Map(input.targets.map((target) => [
              target.messageId,
              target,
            ]));
            const previousRows = canonicalRows(await transaction
              .select(lifecycleSelection)
              .from(sessionMessageCryptoRevisions)
              .where(and(
                inArray(sessionMessageCryptoRevisions.messageId, rows.map((row) => row.messageId)),
                eq(sessionMessageCryptoRevisions.editRevision, input.expectedRevision),
              ))
              .orderBy(asc(sessionMessageCryptoRevisions.messageId))
              .for("update", { of: sessionMessageCryptoRevisions }));
            if (previousRows.length !== rows.length) {
              throw new Error("Protected logical edit is missing a physical lifecycle");
            }
            const next: ConversationRevisionLifecycle[] = [];
            for (const previousRow of previousRows) {
              const previous = lifecycleFromRow(previousRow);
              const target = targetByMessage.get(previous.messageId);
              if (
                target === undefined
                || target.sessionId !== previous.sessionId
                || target.namespaceId !== previous.namespaceIdAtAllocation
                || target.keyClass !== previous.keyClass
                || previous.authorRole !== "user"
                || previous.completion !== "complete"
                || (previous.disposition !== "active" && previous.disposition !== "mapped")
              ) throw new TypeError("Protected edit current authority coordinates disagree");
              const memberOperationId = previous.messageId === input.messageId
                ? input.operationId
                : editMemberOperationId(input.operationId, previous.messageId);
              const terminal = canonicalRows(await transaction
                .update(sessionMessageCryptoRevisions)
                .set({
                  disposition: "superseded",
                  terminalOperationId: memberOperationId,
                  terminalOperationGroupId: input.operationId,
                  terminalOperationType: "edit",
                  terminalExpectedRevision: input.expectedRevision,
                  terminalRequestDigest: Uint8Array.from(input.requestDigest),
                  nextAttemptAt: null,
                  failureCode: null,
                  leaseToken: null,
                  leaseExpiresAt: null,
                  quarantineLeaseToken: null,
                  updatedAt: sql`CURRENT_TIMESTAMP`,
                })
                .where(and(
                  eq(sessionMessageCryptoRevisions.sessionId, previous.sessionId),
                  eq(sessionMessageCryptoRevisions.messageId, previous.messageId),
                  eq(sessionMessageCryptoRevisions.editRevision, input.expectedRevision),
                )).returning({ sequence: sessionMessageCryptoRevisions.sequence }));
              if (oneOrNone(terminal, "Protected edit receipt") === null) {
                throw new Error("Protected edit lost its current lifecycle");
              }
              const inserted = canonicalRows(await transaction
                .insert(sessionMessageCryptoRevisions).values({
                  sessionId: previous.sessionId,
                  messageId: previous.messageId,
                  editRevision: nextRevision,
                  roomId: previous.roomId,
                  namespaceIdAtAllocation: target.namespaceId,
                  cryptoObjectId: target.cryptoObjectId,
                  objectIdScheme: "human_message_edit_v1",
                  payloadVersion: CONVERSATION_MESSAGE_PAYLOAD_VERSION,
                  keyClass: target.keyClass,
                  authorRole: previous.authorRole,
                  subthreadReplyClassification: previous.subthreadReplyClassification,
                  shadowOperationId: previous.shadowOperationId,
                  // The retained origin ID is provenance for the original
                  // Human publication. Its one-time transcript coordinates
                  // belong only to revision 0 and must not collide on edits.
                  shadowTranscriptOrdinal: null,
                  shadowReservedCreatedAt: null,
                  humanPeerShadowOperationId: previous.humanPeerShadowOperationId,
                  sharedAgentShadowOperationId: previous.sharedAgentShadowOperationId,
                  appendIdempotencyKey: null,
                  allocationRequestDigest: Uint8Array.from(input.requestDigest),
                  completion: "complete",
                  disposition: "mapped",
                  parityStatus: "client_authenticated",
                  cryptoCompletedAt: editedAt,
                  representationMode: "full_encryption",
                  publicationPolicyRevision: input.policyRevision,
                  createdAt: editedAt,
                  updatedAt: editedAt,
                  attemptCount: 0,
                  nextAttemptAt: null,
                }).returning(lifecycleSelection));
              const insertedRow = oneOrNone(inserted, "Protected edit lifecycle");
              if (insertedRow === null) throw new Error("Protected edit lost its next lifecycle");
              next.push(lifecycleFromRow(insertedRow));
            }
            return Object.freeze(next);
          },
        },
      );
      if (edited === null) {
        const existing = canonicalRows(await transaction.select({
          edit_revision: sessionMessages.editRevision,
        }).from(sessionMessages).where(eq(sessionMessages.id, input.messageId)));
        const current = oneOrNone(existing, "Protected edit stale lookup");
        return current === null
          ? { status: "missing" }
          : requiredInteger(current, "edit_revision") === input.expectedRevision
            ? { status: "conflict" }
            : { status: "stale" };
      }
      if (edited.hookResult === undefined) {
        throw new Error("Protected edit lost its lifecycle result");
      }
      if (edited.logicalMessageKey === null) {
        throw new TypeError("Protected Human edit requires a logical Message key");
      }
      return {
        status: "allocated",
        lifecycles: edited.hookResult,
        committedProjection: {
          logicalMessageKey: logicalMessageKey({
            id: input.messageId,
            role: "user",
            fingerprint: edited.logicalMessageKey,
          }),
          editedAt: edited.editedAt,
        },
      };
    }, "serializable");
  }

  async inspectProtectedEditReplay(input: {
    readonly messageId: number;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly requestDigest: Uint8Array;
  }): Promise<ConversationProductEditResult | null> {
    assertConversationMessageId(input.messageId);
    assertConversationRevision(input.expectedRevision);
    assertConversationDurableKey("protected message edit operation ID", input.operationId);
    assertDigest("Protected edit request digest", input.requestDigest);
    return canonicalTransaction(this.canonicalRunner, (transaction) =>
      canonicalEditReplay(transaction, input), "read committed");
  }

  async hardDelete(input: {
    readonly messageId: number;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly requestDigest: Uint8Array;
  }): Promise<ConversationProductDeleteResult> {
    assertConversationMessageId(input.messageId);
    assertConversationRevision(input.expectedRevision);
    assertConversationDurableKey(
      "message delete operation ID",
      input.operationId,
    );
    assertDigest("Delete request digest", input.requestDigest);
    return canonicalTransaction(
      this.canonicalRunner,
      async (transaction) => {
      await transaction.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext('conversation-terminal'),
          hashtext(${input.operationId})
        )
      `);
      const replay = await canonicalDeleteReplay(transaction, input);
      if (replay !== null) return replay;
      const coordinateRows = canonicalRows(
        await transaction.select({ room_id: sessions.roomId })
          .from(sessionMessages).innerJoin(
            sessions,
            eq(sessions.id, sessionMessages.sessionId),
          ).where(eq(sessionMessages.id, input.messageId)).limit(2),
      );
      const coordinate = oneOrNone(
        coordinateRows,
        "Conversation delete Room coordinate",
      );
      if (coordinate === null) return { status: "missing" };
      const roomId = requiredString(coordinate, "room_id");
      assertUuid("Conversation delete Room ID", roomId);
      await acquireRoomWriteLock(transaction, roomId);
      const messageRows = canonicalRows(
        await transaction.select({
          message_id: sessionMessages.id,
          session_id: sessionMessages.sessionId,
          edit_revision: sessionMessages.editRevision,
          role: sessionMessages.role,
        }).from(sessionMessages).where(eq(
          sessionMessages.id,
          input.messageId,
        )).for("update", { of: sessionMessages }).limit(2),
      );
      const messageRow = oneOrNone(messageRows, "Conversation delete message");
      if (messageRow === null) return { status: "missing" };
      if (
        this.handle.role === "nautilo_agent"
        && requiredString(messageRow, "role") === "user"
      ) {
        throw new TypeError(
          "nautilo_agent cannot delete a Human-authored transcript row",
        );
      }
      const lockedReplay = await canonicalDeleteReplay(transaction, input);
      if (lockedReplay !== null) return lockedReplay;
      if (
        requiredInteger(messageRow, "edit_revision")
          !== input.expectedRevision
      ) return { status: "stale" };
      const sessionId = requiredString(messageRow, "session_id");
      assertConversationSessionId(sessionId);
      const lifecycleRows = canonicalRows(
        await transaction.execute<ConversationProductDatabaseRow>(sql`
          SELECT ${sql.raw(LIFECYCLE_COLUMNS)}
            FROM session_message_crypto_revisions AS lifecycle
           WHERE lifecycle.message_id = ${input.messageId}
             AND lifecycle.edit_revision = ${input.expectedRevision}
             AND lifecycle.session_id = ${sessionId}::uuid
           LIMIT 2
           FOR UPDATE OF lifecycle
        `),
      );
      const lifecycleRow = oneOrNone(
        lifecycleRows,
        "Conversation locked lifecycle",
      );
      if (lifecycleRow === null) return { status: "missing" };
      const lifecycle = lifecycleFromRow(lifecycleRow);
      if (
        this.handle.role === "nautilo_agent"
        && (
          lifecycle.keyClass !== "ai"
          || lifecycle.authorRole === "user"
          || lifecycle.parityStatus === "client_verified"
        )
      ) {
        throw new TypeError(
          "nautilo_agent cannot delete a Human-authorized transcript revision",
        );
      }
      if (
        lifecycle.disposition === "superseded"
        || lifecycle.disposition === "hard_delete"
      ) return { status: "stale" };
      try {
        const deleted = await deleteMessageHardInTx(
          transaction,
          input.messageId,
          {
            protectedStructuralProjection: {
              subthreadReplyClassification:
                lifecycle.subthreadReplyClassification,
            },
            afterDeleteEffects: async ({ editRevision, effects }) => {
              if (editRevision !== input.expectedRevision) {
                throw new Error(
                  "Canonical conversation delete revision changed under lock",
                );
              }
              const terminalRows = canonicalRows(
                await transaction.update(sessionMessageCryptoRevisions).set({
                  disposition: "hard_delete",
                  attemptCount: 0,
                  terminalOperationId: input.operationId,
                  terminalOperationType: "delete",
                  terminalExpectedRevision: input.expectedRevision,
                  terminalRequestDigest: Uint8Array.from(input.requestDigest),
                  nextAttemptAt: null,
                  failureCode: null,
                  leaseToken: null,
                  leaseExpiresAt: null,
                  quarantineLeaseToken: null,
                  deleteWasUnread: effects.wasUnread,
                  deleteOrphanedTurnId: effects.orphanedTurnId,
                  deleteRootParentRoomId:
                    effects.rootSummary?.parentRoomId ?? null,
                  deleteRootAnchorMessageId:
                    effects.rootSummary?.anchorMessageId ?? null,
                  deleteRootReplyCount:
                    effects.rootSummary?.replyCount ?? null,
                  deleteRootLastReplyAt: effects.rootSummary?.lastReplyAt
                    ? new Date(effects.rootSummary.lastReplyAt)
                    : null,
                  deleteRootSummaryRevision:
                    effects.rootSummary?.revision ?? null,
                  updatedAt: sql`CURRENT_TIMESTAMP`,
                }).where(and(
                  eq(sessionMessageCryptoRevisions.sessionId, sessionId),
                  eq(
                    sessionMessageCryptoRevisions.messageId,
                    input.messageId,
                  ),
                  eq(
                    sessionMessageCryptoRevisions.editRevision,
                    input.expectedRevision,
                  ),
                )).returning(lifecycleSelection),
              );
              const terminalRow = oneOrNone(
                terminalRows,
                "Conversation delete receipt",
              );
              if (terminalRow === null) {
                throw new Error(
                  "Conversation delete lost its lifecycle receipt",
                );
              }
              return terminalRow;
            },
          },
        );
        const terminalRow = deleted.hookResult;
        if (terminalRow === undefined) {
          throw new Error("Canonical delete lost its lifecycle hook result");
        }
        const deletedLifecycle = lifecycleFromRow(terminalRow);
        return {
          status: "deleted",
          lifecycle: deletedLifecycle,
          effects: deleteEffectsFromRow(terminalRow, deletedLifecycle),
        };
      } catch (error) {
        if (
          error instanceof MessageDeleteError
          && error.reason === "message_anchors_thread"
        ) return { status: "message_anchors_thread" };
        if (
          error instanceof MessageDeleteError
          && error.reason === "not_found"
        ) return { status: "missing" };
        throw error;
      }
    },
      "serializable",
    );
  }

  async quarantineRevision(
    input: ConversationRevisionCoordinates & {
      readonly leaseToken: string | null;
      readonly failureCode: ConversationFailureCode;
    },
  ): Promise<"applied" | "duplicate" | "missing" | "conflict"> {
    this.#assertCoordinates(input);
    assertFailureCode(input.failureCode);
    if (input.failureCode === "retry_exhausted") {
      throw new TypeError(
        "retry_exhausted is reserved for the eighth failed claim",
      );
    }
    if (input.leaseToken !== null) {
      assertUuid("Conversation lease token", input.leaseToken);
    }
    return serializable(this.handle, async (transaction) => {
      const row = await this.#lockedLifecycle(transaction, input, true);
      if (row === null) return "missing";
      const lifecycle = lifecycleFromRow(row);
      if (lifecycle.disposition === "quarantined") {
        return lifecycle.failureCode === input.failureCode
            && nullableString(row, "quarantine_lease_token")
              === input.leaseToken
          ? "duplicate"
          : "conflict";
      }
      if (
        lifecycle.sessionId !== input.sessionId
        || !leaseMatches(row, lifecycle, input.leaseToken)
      ) return "missing";
      if (lifecycle.disposition !== "active") return "duplicate";
      const updated = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.update(sessionMessageCryptoRevisions).set({
          disposition: "quarantined",
          failureCode: input.failureCode,
          nextAttemptAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          quarantineLeaseToken: input.leaseToken,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(and(
          eq(sessionMessageCryptoRevisions.sessionId, input.sessionId),
          eq(sessionMessageCryptoRevisions.messageId, input.messageId),
          eq(sessionMessageCryptoRevisions.editRevision, input.revision),
          sql`${sessionMessageCryptoRevisions.leaseToken}
            IS NOT DISTINCT FROM ${input.leaseToken}::uuid`,
          eq(sessionMessageCryptoRevisions.disposition, "active"),
        )).returning(lifecycleSelection),
      );
      return oneOrNone(updated, "Conversation quarantine") === null
        ? "missing"
        : "applied";
    });
  }

  async claimReconciliationCandidates(input: {
    readonly leaseToken: string;
    readonly limit: number;
  }): Promise<readonly ConversationRevisionState[]> {
    assertUuid("Conversation lease token", input.leaseToken);
    if (
      !Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > CONVERSATION_RECONCILE_MAX_BATCH
    ) throw new RangeError("Conversation claim limit is out of bounds");
    return this.handle.transaction(async (transaction) => {
      const rows = await transaction.query(
        `WITH candidates AS (
           SELECT lifecycle.sequence
             FROM session_message_crypto_revisions AS lifecycle
            WHERE lifecycle.disposition = 'active'
              AND lifecycle.repair_identity_digest IS NULL
              AND lifecycle.attempt_count < ${CONVERSATION_RECONCILE_MAX_ATTEMPTS}
              AND lifecycle.next_attempt_at <= CURRENT_TIMESTAMP
              AND (
                lifecycle.lease_token IS NULL
                OR lifecycle.lease_expires_at <= CURRENT_TIMESTAMP
              )
            ORDER BY lifecycle.next_attempt_at, lifecycle.sequence
            LIMIT $3
            FOR UPDATE OF lifecycle SKIP LOCKED
         ),
         claimed AS (
           UPDATE session_message_crypto_revisions AS lifecycle
              SET lease_token = $1::uuid,
                  lease_expires_at = CURRENT_TIMESTAMP
                    + $2 * interval '1 second',
                  updated_at = CURRENT_TIMESTAMP
             FROM candidates
            WHERE lifecycle.sequence = candidates.sequence
            RETURNING lifecycle.*
         )
         SELECT ${LIFECYCLE_COLUMNS},
                ${JOINED_MESSAGE_COLUMNS}
           FROM claimed AS lifecycle
           LEFT JOIN session_messages AS current_message
             ON current_message.id = lifecycle.message_id
            AND current_message.session_id = lifecycle.session_id
            AND current_message.edit_revision = lifecycle.edit_revision
          ORDER BY lifecycle.next_attempt_at, lifecycle.sequence`,
        [
          input.leaseToken,
          CONVERSATION_RECONCILE_LEASE_SECONDS,
          input.limit,
        ],
      );
      if (rows.length > input.limit) {
        throw new Error("Conversation claim exceeded its requested limit");
      }
      return Object.freeze(rows.map(stateFromRow));
    }, { isolationLevel: "read committed" });
  }

  async failReconciliationClaim(
    input: ConversationRevisionCoordinates & {
      readonly leaseToken: string;
      readonly failureCode: ConversationFailureCode;
    },
  ): Promise<ConversationRevisionLifecycle | null> {
    this.#assertCoordinates(input);
    assertUuid("Conversation lease token", input.leaseToken);
    assertFailureCode(input.failureCode);
    if (input.failureCode === "retry_exhausted") {
      throw new TypeError(
        "retry_exhausted is reserved for the eighth failed claim",
      );
    }
    return serializable(this.handle, async (transaction) => {
      const rows = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.update(sessionMessageCryptoRevisions).set({
          attemptCount: sql`${sessionMessageCryptoRevisions.attemptCount} + 1`,
          disposition: sql`CASE
            WHEN ${sessionMessageCryptoRevisions.attemptCount} + 1 >=
              ${CONVERSATION_RECONCILE_MAX_ATTEMPTS}
            THEN 'quarantined' ELSE 'active' END`,
          failureCode: sql`CASE
            WHEN ${sessionMessageCryptoRevisions.attemptCount} + 1 >=
              ${CONVERSATION_RECONCILE_MAX_ATTEMPTS}
            THEN 'retry_exhausted' ELSE ${input.failureCode} END`,
          nextAttemptAt: sql`CASE
            WHEN ${sessionMessageCryptoRevisions.attemptCount} + 1 >=
              ${CONVERSATION_RECONCILE_MAX_ATTEMPTS}
            THEN NULL ELSE CURRENT_TIMESTAMP + LEAST(
              300000,
              (1000 * power(2, ${sessionMessageCryptoRevisions.attemptCount}))::bigint
            ) * interval '1 millisecond' END`,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(and(
          eq(sessionMessageCryptoRevisions.sessionId, input.sessionId),
          eq(sessionMessageCryptoRevisions.messageId, input.messageId),
          eq(sessionMessageCryptoRevisions.editRevision, input.revision),
          eq(sessionMessageCryptoRevisions.leaseToken, input.leaseToken),
          sql`${sessionMessageCryptoRevisions.leaseExpiresAt}
            > CURRENT_TIMESTAMP`,
          eq(sessionMessageCryptoRevisions.disposition, "active"),
          sql`${sessionMessageCryptoRevisions.attemptCount}
            < ${CONVERSATION_RECONCILE_MAX_ATTEMPTS}`,
        )).returning(lifecycleSelection),
      );
      const row = oneOrNone(rows, "Conversation failed claim");
      return row === null ? null : lifecycleFromRow(row);
    });
  }

  #assertCoordinates(input: ConversationRevisionCoordinates): void {
    assertConversationSessionId(input.sessionId);
    assertConversationMessageId(input.messageId);
    assertConversationRevision(input.revision);
  }

  async #lockedLifecycle(
    transaction: ConversationProductPostgresTransaction,
    coordinates: ConversationRevisionCoordinates,
    includeLeaseValidity: boolean,
  ): Promise<ConversationProductDatabaseRow | null> {
    const rows = await transaction.query(
      `SELECT ${LIFECYCLE_COLUMNS}${
        includeLeaseValidity
          ? `,
              CASE
                WHEN lifecycle.lease_token IS NULL THEN TRUE
                ELSE lifecycle.lease_expires_at > CURRENT_TIMESTAMP
              END AS lease_is_live`
          : ""
      }
         FROM session_message_crypto_revisions AS lifecycle
        WHERE lifecycle.message_id = $2
          AND lifecycle.edit_revision = $3
          AND lifecycle.session_id = $1
        LIMIT 2
        FOR UPDATE OF lifecycle`,
      [
        coordinates.sessionId,
        coordinates.messageId,
        coordinates.revision,
      ],
    );
    return oneOrNone(rows, "Conversation locked lifecycle");
  }

  async #lockedLifecycleCanonical(
    transaction: CanonicalTranscriptTx,
    coordinates: ConversationRevisionCoordinates,
    includeLeaseValidity: boolean,
  ): Promise<ConversationProductDatabaseRow | null> {
    const rows = canonicalRows(await transaction.select({
      ...lifecycleSelection,
      ...(includeLeaseValidity ? {
        lease_is_live: sql<boolean>`CASE
          WHEN ${sessionMessageCryptoRevisions.leaseToken} IS NULL THEN TRUE
          ELSE ${sessionMessageCryptoRevisions.leaseExpiresAt} > CURRENT_TIMESTAMP
        END`.as("lease_is_live"),
      } : {}),
    }).from(sessionMessageCryptoRevisions).where(and(
      eq(sessionMessageCryptoRevisions.sessionId, coordinates.sessionId),
      eq(sessionMessageCryptoRevisions.messageId, coordinates.messageId),
      eq(sessionMessageCryptoRevisions.editRevision, coordinates.revision),
    )).limit(2).for("update", { of: sessionMessageCryptoRevisions }));
    return oneOrNone(rows, "Conversation locked lifecycle");
  }

  async #persistStaleMappingCanonical(
    transaction: CanonicalTranscriptTx,
    lifecycle: ConversationRevisionLifecycle,
  ): Promise<void> {
    const rows = canonicalRows(await transaction
      .update(sessionMessageCryptoRevisions).set({
        completion: "complete", disposition: "stale_mapping",
        failureCode: "mapping_conflict", nextAttemptAt: null,
        leaseToken: null, leaseExpiresAt: null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(and(
        eq(sessionMessageCryptoRevisions.sessionId, lifecycle.sessionId),
        eq(sessionMessageCryptoRevisions.messageId, lifecycle.messageId),
        eq(sessionMessageCryptoRevisions.editRevision, lifecycle.revision),
        eq(sessionMessageCryptoRevisions.disposition, "active"),
      )).returning(lifecycleSelection));
    if (oneOrNone(rows, "Conversation stale mapping receipt") === null) {
      throw new Error("Conversation stale mapping lost its lifecycle CAS");
    }
  }

}
