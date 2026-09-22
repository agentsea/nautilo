import { sha256 } from "@noble/hashes/sha2.js";
import type {
  ProtectedAgentRuntimeForegroundEntrypointId,
} from "../invocation/protected-agent-runtime";
import type { MessagePayloadV2 } from "./message-payload-v2";

export const CONVERSATION_MESSAGE_OBJECT_ID_VERSION = 2 as const;
export const CONVERSATION_RECONCILE_MAX_BATCH = 256;
export const CONVERSATION_RECONCILE_LEASE_SECONDS = 60;
export const CONVERSATION_DURABLE_KEY_MAX_BYTES = 128;
export const CONVERSATION_MESSAGE_OBJECT_TYPE = "nautilo-message-v2";
export const CONVERSATION_MESSAGE_PAYLOAD_VERSION = 2 as const;
export const IMMUTABLE_ROOM_NAMESPACE_INVARIANT =
  "immutable-session-room-namespace-v1" as const;

const PG_SERIAL_MAX = 2_147_483_647;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const textEncoder = new TextEncoder();
const MESSAGE_OBJECT_ID_DOMAIN_V2 =
  "nautilo/conversation-message-crypto-object/v2";
const LIVE_SHADOW_MESSAGE_OBJECT_ID_DOMAIN_V1 =
  "nautilo/conversation-live-shadow-message-crypto-object/v1";
declare const preparedConversationCryptoRevisionBrand: unique symbol;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function assertConversationDurableKey(
  label: string,
  value: string,
): void {
  if (
    typeof value !== "string"
    || !PORTABLE_ID.test(value)
    || textEncoder.encode(value).length > CONVERSATION_DURABLE_KEY_MAX_BYTES
  ) {
    throw new TypeError(
      `${label} must be a non-empty portable identifier of at most ${
        CONVERSATION_DURABLE_KEY_MAX_BYTES
      } UTF-8 bytes`,
    );
  }
}

export function assertConversationSessionId(value: string): void {
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) {
    throw new TypeError("Conversation Session ID must be a canonical UUID");
  }
}

export function assertConversationMessageId(value: number): void {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > PG_SERIAL_MAX
  ) {
    throw new RangeError(
      "Conversation message ID must be a positive PostgreSQL serial",
    );
  }
}

export function assertConversationRevision(value: number): void {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > PG_SERIAL_MAX
  ) {
    throw new RangeError(
      "Conversation message revision must be a non-negative integer",
    );
  }
}

export interface ConversationRevisionCoordinates {
  readonly sessionId: string;
  readonly messageId: number;
  readonly revision: number;
}

/**
 * Stable opaque identity derived only after the product database allocates the
 * physical message row. The versioned, domain-separated input is
 * length-framed so every client/server implementation can reproduce it.
 */
export function deriveMessageCryptoObjectIdV2(
  coordinates: ConversationRevisionCoordinates,
): string {
  assertConversationSessionId(coordinates.sessionId);
  assertConversationMessageId(coordinates.messageId);
  assertConversationRevision(coordinates.revision);
  const sessionBytes = textEncoder.encode(coordinates.sessionId);
  const preimage = textEncoder.encode(
    `${MESSAGE_OBJECT_ID_DOMAIN_V2}\n${sessionBytes.length}\n${
      coordinates.sessionId
    }\n${coordinates.messageId}\n${coordinates.revision}`,
  );
  return `message:v2:${bytesToHex(sha256(preimage))}`;
}

const MESSAGE_EXISTING_REPAIR_IDENTITY_DOMAIN_V1 =
  "nautilo.message.existing-representation-repair.v1";

/** Publisher-neutral identity for one exact existing Message repair. */
export function conversationExistingRepresentationRepairIdentityDigest(
  input: ConversationRevisionCoordinates & Readonly<{
    namespaceId: string;
    authorRole: ConversationAuthorRole;
    /** Omission preserves the already-issued AI repair identity bytes. */
    keyClass?: ConversationMessageKeyClass;
    authorityFingerprint: Uint8Array;
    policyRevision: number;
  }>,
): Uint8Array {
  assertConversationSessionId(input.sessionId);
  assertConversationMessageId(input.messageId);
  assertConversationRevision(input.revision);
  if (!CANONICAL_UUID.test(input.namespaceId)) {
    throw new TypeError("Conversation repair Namespace ID is invalid");
  }
  assertConversationAuthorRole(input.authorRole);
  const keyClass = input.keyClass ?? "ai";
  if (keyClass !== "ai" && keyClass !== "human") {
    throw new TypeError("Conversation repair key class is invalid");
  }
  if (input.authorityFingerprint.length !== 32) {
    throw new TypeError("Conversation repair authority fingerprint is invalid");
  }
  if (!Number.isSafeInteger(input.policyRevision) || input.policyRevision < 0) {
    throw new TypeError("Conversation repair policy revision is invalid");
  }
  const prefix = textEncoder.encode(
    `${MESSAGE_EXISTING_REPAIR_IDENTITY_DOMAIN_V1}\n${input.sessionId}\n${
      input.messageId
    }\n${input.revision}\n${input.namespaceId}\n${keyClass}\n${input.authorRole}\n${
      input.policyRevision
    }\n`,
  );
  const preimage = new Uint8Array(
    prefix.length + input.authorityFingerprint.length,
  );
  preimage.set(prefix);
  preimage.set(input.authorityFingerprint, prefix.length);
  try {
    return Uint8Array.from(sha256(preimage));
  } finally {
    preimage.fill(0);
  }
}

export interface LiveShadowMessageObjectCoordinatesV1
  extends ConversationRevisionCoordinates {
  readonly operationId: string;
  readonly transcriptOrdinal: number;
  readonly authorRole: ConversationAuthorRole;
}

/**
 * M282 live-only Message identity. Historical and ordinary shadow
 * representations continue to use `deriveMessageCryptoObjectIdV2`; a stored
 * lifecycle discriminator prevents either scheme from being accepted under
 * the other's replay rules.
 */
export function deriveLiveShadowMessageCryptoObjectIdV1(
  coordinates: LiveShadowMessageObjectCoordinatesV1,
): string {
  assertConversationDurableKey(
    "Live Shadow Message operation ID",
    coordinates.operationId,
  );
  assertConversationSessionId(coordinates.sessionId);
  assertConversationMessageId(coordinates.messageId);
  assertConversationRevision(coordinates.revision);
  if (
    !Number.isSafeInteger(coordinates.transcriptOrdinal)
    || coordinates.transcriptOrdinal < 1
    || coordinates.transcriptOrdinal > PG_SERIAL_MAX
  ) {
    throw new RangeError(
      "Live Shadow Message transcript ordinal must be a positive integer",
    );
  }
  assertConversationAuthorRole(coordinates.authorRole);
  const operationBytes = textEncoder.encode(coordinates.operationId);
  const sessionBytes = textEncoder.encode(coordinates.sessionId);
  const preimage = textEncoder.encode(
    `${LIVE_SHADOW_MESSAGE_OBJECT_ID_DOMAIN_V1}\n${operationBytes.length}\n${
      coordinates.operationId
    }\n${sessionBytes.length}\n${coordinates.sessionId}\n${
      coordinates.messageId
    }\n${coordinates.revision}\n${coordinates.transcriptOrdinal}\n${
      coordinates.authorRole
    }`,
  );
  return `message:live-shadow:v1:${bytesToHex(sha256(preimage))}`;
}

export type ConversationMessageKeyClass = "ai" | "human";
export type ConversationAuthorRole =
  | "user"
  | "assistant"
  | "tool"
  | "system";
export type ConversationParityStatus =
  | "pending"
  | "server_verified"
  | "client_verified"
  | "server_authenticated"
  | "client_authenticated";

/** Full origin has no independent ordinary sibling to establish parity with. */
export function conversationVerificationMatchesRepresentation(
  representationMode: ConversationRevisionLifecycle["representationMode"],
  status: ConversationParityStatus,
): boolean {
  return representationMode !== "full_encryption"
    || status === "pending"
    || status === "server_authenticated"
    || status === "client_authenticated";
}
export type ConversationFailureCode =
  | "namespace_unresolved"
  | "namespace_mismatch"
  | "crypto_absent"
  | "crypto_incomplete"
  | "crypto_mismatch"
  | "authorization_unavailable"
  | "recipient_unavailable"
  | "storage_transient"
  | "mapping_conflict"
  | "retry_exhausted";
export type ConversationTerminalOperationType = "edit" | "delete";
export type ConversationSubthreadReplyClassification = "counted" | "excluded";
export type ConversationNotificationEligibility = "eligible" | "excluded";
export const CONVERSATION_RECONCILE_MAX_ATTEMPTS = 8;

export function assertConversationMessageKeyClass(
  value: string,
): asserts value is ConversationMessageKeyClass {
  if (value !== "ai" && value !== "human") {
    throw new TypeError("Conversation message key class is invalid");
  }
}

export function assertConversationAuthorRole(
  value: string,
): asserts value is ConversationAuthorRole {
  if (
    value !== "user"
    && value !== "assistant"
    && value !== "tool"
    && value !== "system"
  ) throw new TypeError("Conversation author role is invalid");
}

export function assertConversationSubthreadReplyClassification(
  value: string,
): asserts value is ConversationSubthreadReplyClassification {
  if (value !== "counted" && value !== "excluded") {
    throw new TypeError(
      "Conversation Subthread reply classification is invalid",
    );
  }
}

export function assertConversationNotificationEligibility(
  value: string,
): asserts value is ConversationNotificationEligibility {
  if (value !== "eligible" && value !== "excluded") {
    throw new TypeError(
      "Conversation notification eligibility is invalid",
    );
  }
}

export interface PreparedConversationCryptoRevision {
  readonly objectId: string;
  readonly namespaceId: string;
  readonly objectType: typeof CONVERSATION_MESSAGE_OBJECT_TYPE;
  readonly payloadVersion: typeof CONVERSATION_MESSAGE_PAYLOAD_VERSION;
  readonly keyClass: ConversationMessageKeyClass;
  readonly [preparedConversationCryptoRevisionBrand]: true;
}

export interface ConversationProductMessage {
  readonly sessionId: string;
  readonly messageId: number;
  readonly roomId: string;
  readonly content: string | null;
  readonly revision: number;
  readonly keyClass: ConversationMessageKeyClass;
  readonly authorRole: ConversationAuthorRole;
  readonly cryptoObjectId: string | null;
}

export type ConversationRevisionCompletion = "pending" | "complete";
export type ConversationRevisionDisposition =
  | "active"
  | "mapped"
  | "blocked"
  | "superseded"
  | "hard_delete"
  | "stale_mapping"
  | "quarantined";

export type ConversationRepairPublisherKind =
  | "foreground_runtime"
  | "human_device";

export type ConversationRepairPublicationEvidence = Readonly<{
  publisherId: string;
  attestationDigest: Uint8Array;
}> & (
  | Readonly<{ publisherKind: "foreground_runtime"; publisherHumanId?: never }>
  | Readonly<{ publisherKind: "human_device"; publisherHumanId: string }>
);

/**
 * Product-owned durable shadow lifecycle. Production adapters must persist
 * this with their append/edit/delete/mapping receipts in the same product
 * transaction; it is not an in-process crypto-side ledger.
 */
export interface ConversationRevisionLifecycle
  extends ConversationRevisionCoordinates
{
  readonly sequence: number;
  readonly roomId: string;
  /**
   * Historical routing coordinate captured by the product transaction. It is
   * never current authorization: every operation must compare it with the
   * immutable Session -> Room -> Namespace resolver.
   */
  readonly namespaceIdAtAllocation: string;
  readonly cryptoObjectId: string;
  /**
   * `human_message_edit_v1` identifies one immutable operation-scoped edit
   * candidate; retained origin fields are provenance, never edit authority.
   */
  readonly objectIdScheme:
    | "message_v2"
    | "live_shadow_v1"
    | "human_message_edit_v1";
  readonly representationMode: "shadow_encryption" | "full_encryption";
  readonly publicationPolicyRevision: number | null;
  /** Exact M282/M291/M294 Agent-turn parent, never a Human-peer parent. */
  readonly shadowOperationId: string | null;
  /** Exact M295 Human-peer parent, never an Agent-turn parent. */
  readonly humanPeerShadowOperationId: string | null;
  /** Exact M296 shared-Room Human-write parent. */
  readonly sharedAgentShadowOperationId: string | null;
  /** Exact M296 selected Agent-execution parent. */
  readonly sharedAgentShadowExecutionId: string | null;
  readonly shadowTranscriptOrdinal: number | null;
  readonly shadowReservedCreatedAt: Date | null;
  readonly shadowStreamId: string | null;
  readonly shadowStreamStartDigest: Uint8Array | null;
  readonly shadowStreamTerminalDigest: Uint8Array | null;
  readonly shadowStreamedTextDigest: Uint8Array | null;
  readonly shadowDurableEventDigest: Uint8Array | null;
  readonly keyClass: ConversationMessageKeyClass;
  readonly authorRole: ConversationAuthorRole;
  readonly subthreadReplyClassification:
    ConversationSubthreadReplyClassification;
  readonly completion: ConversationRevisionCompletion;
  readonly disposition: ConversationRevisionDisposition;
  readonly parityStatus: ConversationParityStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: Date | null;
  readonly failureCode: ConversationFailureCode | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly appendIdempotencyKey: string | null;
  /** Exact 32-byte digest of the append/edit request that allocated this revision. */
  readonly allocationRequestDigest: Uint8Array;
  readonly repairIdentityDigest: Uint8Array | null;
  readonly repairPublisherKind: ConversationRepairPublisherKind | null;
  readonly repairPublisherId: string | null;
  readonly repairPublisherHumanId?: string | null;
  readonly repairSourceRevision?: number | null;
  readonly repairSourceDigest?: Uint8Array | null;
  readonly repairAttestationDigest: Uint8Array | null;
  readonly terminalOperationId: string | null;
  readonly terminalOperationType: ConversationTerminalOperationType | null;
  readonly terminalExpectedRevision: number | null;
  readonly terminalRequestDigest: Uint8Array | null;
}

export interface ConversationRevisionState {
  readonly message: ConversationProductMessage | null;
  readonly lifecycle: ConversationRevisionLifecycle;
}

/** Current revision/mapping facts that contain no ordinary Message body. */
export interface ConversationRevisionMappingState {
  readonly message: Readonly<{
    sessionId: string;
    messageId: number;
    revision: number;
    authorRole: ConversationAuthorRole;
    cryptoObjectId: string | null;
  }> | null;
  readonly lifecycle: ConversationRevisionLifecycle;
}

export interface ConversationAllocatedRevision
  extends ConversationRevisionCoordinates
{
  readonly status: "allocated" | "replayed";
  readonly roomId: string;
  readonly namespaceId: string;
  readonly keyClass: ConversationMessageKeyClass;
  readonly authorRole: ConversationAuthorRole;
  readonly cryptoObjectId: string;
}

export interface ConversationEditAllocationResult
  extends ConversationAllocatedRevision
{
  /**
   * Every physical revision allocated by the logical edit. Human turns may
   * have one copy per Human Session; Agent-authored edits remain singletons.
   */
  readonly allocations: readonly ConversationAllocatedRevision[];
}

export interface ConversationAppendInput {
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly content: string | null;
  /** Exact policy used to prepare a publication, checked in its transaction. */
  readonly publicationPolicy?: Readonly<{
    expectedRevision: number;
    representation: "ordinary_and_protected" | "protected_only";
  }> | undefined;
  readonly keyClass: ConversationMessageKeyClass;
  readonly authorRole: ConversationAuthorRole;
  /** Canonical transcript facts. Callers must not rely on adapter defaults. */
  readonly toolCalls: string | null;
  readonly toolName: string | null;
  readonly fingerprint: string | null;
  readonly humanTurnId: string | null;
  readonly transcriptOrigin: "main" | "subagent";
  readonly parentThreadId: string | null;
  readonly scopeId: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly subthreadRoomId: string | null;
  readonly replyToMessageId: number | null;
  readonly notificationContext: Readonly<{
    readonly mentionedHumanUserIds: readonly string[];
    readonly mentionEveryone?: boolean;
    readonly causalHumanUserId: string | null;
    readonly causalHumanTurnId: string | null;
  }>;
  readonly structuralProjection: Readonly<{
    readonly notificationEligibility: ConversationNotificationEligibility;
    readonly subthreadReplyClassification:
      ConversationSubthreadReplyClassification;
  }>;
}

export interface ConversationProductAppendInput extends ConversationAppendInput {
  readonly requestDigest: Uint8Array;
  /** Present only for a coordinate-first M282 live Human append. */
  readonly liveShadow?: Readonly<{
    readonly operationId: string;
    readonly reservedMessageId: number;
    readonly createdAt: number;
    readonly transcriptOrdinal: 1;
    readonly cryptoObjectId: string;
    readonly planDigest: Uint8Array;
    readonly planBytes: Uint8Array;
    readonly requestBytes: Uint8Array;
    readonly grantDigest: Uint8Array;
  }> | undefined;
  /** Present only for one coordinate-first M295 Human-only append. */
  readonly humanPeerLiveShadow?: Readonly<{
    readonly operationId: string;
    readonly reservedMessageId: number;
    readonly createdAt: number;
    readonly transcriptOrdinal: number;
    readonly cryptoObjectId: string;
    readonly planDigest: Uint8Array;
    readonly planBytes: Uint8Array;
    readonly requestBytes: Uint8Array;
  }> | undefined;
  /** Present only for one coordinate-first M296 shared-Room Human append. */
  readonly sharedAgentLiveShadow?: Readonly<{
    readonly operationId: string;
    readonly reservedMessageId: number;
    readonly createdAt: number;
    readonly transcriptOrdinal: number;
    readonly cryptoObjectId: string;
    readonly planDigest: Uint8Array;
    readonly planBytes: Uint8Array;
    readonly requestBytes: Uint8Array;
  }> | undefined;
}

/** Full publications carry structural metadata, never ordinary payload siblings. */
export function assertProductPublicationRepresentation(
  input: ConversationAppendInput,
): void {
  const policy = input.publicationPolicy;
  if (policy !== undefined && (
    !Number.isSafeInteger(policy.expectedRevision)
    || policy.expectedRevision < 0
    || !["ordinary_and_protected", "protected_only"].includes(policy.representation)
  )) throw new TypeError("Conversation publication policy is invalid");
  if (policy?.representation === "protected_only") {
    if (
      input.content !== null || input.toolCalls !== null
      || input.toolName !== null || input.metadata !== null
    ) throw new TypeError("Protected-only publication contains an ordinary body");
  } else if (typeof input.content !== "string") {
    throw new TypeError("Absent ordinary content requires an explicit protected-only publication");
  }
}

export type ConversationProductAppendResult =
  | {
    readonly status: "allocated" | "replayed";
    readonly lifecycle: ConversationRevisionLifecycle;
  }
  | { readonly status: "conflict" };

export interface ConversationLiveShadowAgentReservationInput {
  readonly sessionId: string;
  readonly operationId: string;
  readonly transcriptOrdinal: number;
  readonly authorRole: "assistant" | "tool";
  readonly createdAt: number;
  /** Content-free exact reservation-coordinate digest. */
  readonly requestDigest: Uint8Array;
  readonly subthreadReplyClassification:
    ConversationSubthreadReplyClassification;
  readonly publicationPolicy?: ConversationAppendInput["publicationPolicy"];
}

export type ConversationLiveShadowAgentReservationResult =
  | Readonly<{
      status: "reserved" | "replayed";
      allocation: ConversationAllocatedRevision;
      createdAt: number;
    }>
  | Readonly<{ status: "stale" | "conflict" }>;

export interface ConversationLiveShadowAgentPublishInput
  extends ConversationAppendInput {
  readonly operationId: string;
  readonly transcriptOrdinal: number;
  readonly reservedMessageId: number;
  readonly reservedCreatedAt: number;
  readonly cryptoObjectId: string;
  readonly reservationDigest: Uint8Array;
}

export interface ConversationLiveShadowAgentEvidenceInput {
  readonly sessionId: string;
  readonly operationId: string;
  readonly messageId: number;
  readonly transcriptOrdinal: number;
  readonly durableEventDigest: Uint8Array;
  readonly streamEvidence: Readonly<{
    readonly streamId: string;
    readonly startDigest: Uint8Array;
    readonly terminalDigest: Uint8Array;
    readonly streamedTextDigest: Uint8Array;
  }> | null;
  readonly finalTurnMessage: boolean;
  readonly now: number;
  readonly publicationPolicy?: ConversationAppendInput["publicationPolicy"];
}

export type ConversationLiveShadowAgentEvidenceResult =
  | "applied"
  | "duplicate"
  | "conflict";

export type ConversationExistingRepresentationAllocationResult =
  | {
    readonly status: "allocated" | "replayed";
    readonly lifecycle: ConversationRevisionLifecycle;
  }
  | {
    readonly status: "missing" | "stale" | "already_mapped" | "conflict";
  };

/**
 * Product-side allocation for a current Human device publishing an encrypted
 * representation of an exact already-committed Message. The original author
 * facts are inputs to the CAS; they are never inferred from the publisher.
 */
export interface ConversationExistingRepresentationProductStorePort {
  /** Serializes every publisher on the canonical Room/Message before crypto writes. */
  withExistingRepresentationPublication<Value>(input: ConversationRevisionCoordinates & {
    readonly publicationPolicy: NonNullable<ConversationAppendInput["publicationPolicy"]>;
    use(product: ConversationProductStorePort & ConversationExistingRepresentationProductStorePort): Promise<Value>;
  }): Promise<Value | null>;
  /** Caller holds the publication fence and has proved the immutable crypto object absent.
   * Commit this admitted manifest/source reservation before any crypto write. */
  reserveExistingRepresentationPublication(input: ConversationRevisionCoordinates & {
    readonly cryptoObjectId: string;
    readonly sourceDigest: Uint8Array;
    readonly repairPublication: ConversationRepairPublicationEvidence;
    readonly publicationPolicy: NonNullable<ConversationAppendInput["publicationPolicy"]>;
  }): Promise<"reserved" | "missing" | "conflict">;

  allocateExistingRepresentation(input: ConversationRevisionCoordinates & {
    readonly publisher:
      | Readonly<{ kind: "human_device"; humanActorId: string }>
      | Readonly<{ kind: "foreground_runtime"; agentId: string }>;
    readonly operationId: string;
    readonly expectedNamespaceId: string;
    /** Derived by current product authority; retained allocations keep their class. */
    readonly expectedKeyClass?: ConversationMessageKeyClass;
    readonly expectedAuthorRole: ConversationAuthorRole;
    readonly expectedAuthorHumanTurnId: string | null;
    readonly expectedSessionAgentId: string | null;
    readonly requestDigest: Uint8Array;
    readonly repairIdentityDigest: Uint8Array;
  }): Promise<ConversationExistingRepresentationAllocationResult>;
}

/** Call only after verifying an exact device-signed independent-parity result. */
export interface ConversationIndependentMessageParityInput extends ConversationRevisionCoordinates {
  readonly cryptoObjectId: string;
  readonly expectedNamespaceId: string;
  readonly expectedKeyClass: ConversationMessageKeyClass;
  readonly expectedNamespaceAccessRevision: number;
  readonly authorityActorId: string;
  readonly publicationPolicy: NonNullable<ConversationAppendInput["publicationPolicy"]>;
}

export interface ConversationOrdinaryRepairInput
  extends ConversationRevisionCoordinates {
  readonly cryptoObjectId: string;
  readonly expectedNamespaceId: string;
  readonly expectedKeyClass: ConversationMessageKeyClass;
  readonly expectedNamespaceAccessRevision: number;
  readonly expectedNamespaceKeyGeneration: number;
  /** Current disclosure authority; retained envelope coordinates remain signed separately. */
  readonly currentNamespaceAccessRevision?: number;
  readonly expectedAuthorRole: ConversationAuthorRole;
  readonly expectedCreatedAt: number;
  readonly content: string;
  readonly toolCalls: string | null;
  readonly toolName: string | null;
  readonly authorityActorId: string;
  readonly repairIdentityDigest: Uint8Array;
  readonly attestationDigest: Uint8Array;
  readonly publisher: Readonly<{
    kind: "authenticated_runtime" | "device_attested";
    id: string;
  }>;
  readonly publicationPolicy: NonNullable<
    ConversationAppendInput["publicationPolicy"]
  >;
}

export interface ConversationOrdinaryRepairProductStorePort {
  restoreOrdinaryExistingRepresentation(
    input: ConversationOrdinaryRepairInput,
  ): Promise<"applied" | "replayed" | "missing" | "stale" | "conflict">;
}

export function conversationOrdinaryRepairIdentityDigest(input: Readonly<{
  sessionId: string;
  messageId: number;
  revision: number;
  cryptoObjectId: string;
  namespaceId: string;
  namespaceAccessRevision: number;
  namespaceKeyGeneration: number;
  keyClass: ConversationMessageKeyClass;
  publisherKind: "authenticated_runtime" | "device_attested";
  publisherId: string;
  policyRevision: number;
}>): Uint8Array {
  return requestDigest("nautilo/conversation/ordinary-repair-identity/v1", [
    input.sessionId, input.messageId, input.revision, input.cryptoObjectId,
    input.namespaceId, input.namespaceAccessRevision,
    input.namespaceKeyGeneration, input.keyClass,
    input.publisherKind, input.publisherId,
    input.policyRevision,
  ]);
}

export type ConversationProductMappingCasResult =
  | "applied"
  | "duplicate"
  | "lease_lost"
  | "stale"
  | "missing"
  | "wrong_namespace";

export type ConversationProductEditResult =
  | {
    readonly status: "allocated" | "replayed";
    /**
     * One lifecycle per physical transcript copy. Human fingerprint siblings
     * are edited as one logical turn; Agent-authored rows remain singletons.
     */
    readonly lifecycles: readonly ConversationRevisionLifecycle[];
    readonly committedProjection?: Readonly<{
      logicalMessageKey: string;
      editedAt: Date;
    }>;
  }
  | { readonly status: "stale" | "missing" | "conflict" };

export interface ConversationProtectedEditPlanSource {
  readonly roomId: string;
  readonly subjectUserId: string;
  readonly authorHumanId: string;
  readonly logicalMessageKey: string | null;
  readonly authorizationScheme:
    | "foreground_session_v1"
    | "human_peer_v1"
    | "shared_agent_v1"
    | "human_ai_readable_v1";
  readonly targets: readonly Readonly<{
    sessionId: string;
    messageId: number;
    expectedRevision: number;
    createdAt: number;
    editedAt: number | null;
    namespaceId: string;
    keyClass: ConversationMessageKeyClass;
    cryptoObjectId: string;
  }>[];
}

export interface ConversationDeleteEffects {
  readonly roomId: string;
  readonly wasUnread: boolean;
  readonly orphanedTurnId: string | null;
  readonly rootSummary: Readonly<{
    readonly parentRoomId: string;
    readonly anchorMessageId: number;
    readonly replyCount: number;
    readonly lastReplyAt: Date | null;
    readonly revision: number;
  }> | null;
}

export type ConversationProductDeleteResult =
  | {
    readonly status: "deleted" | "replayed";
    readonly lifecycle: ConversationRevisionLifecycle;
    readonly effects: ConversationDeleteEffects;
  }
  | {
    readonly status:
      | "stale"
      | "missing"
      | "conflict"
      | "message_anchors_thread";
  };

export interface ConversationProductStorePort {
  readonly roomNamespaceInvariant:
    typeof IMMUTABLE_ROOM_NAMESPACE_INVARIANT;
  /**
   * Allocates messageId and atomically writes message, lifecycle and the
   * Session-scoped idempotency receipt.
   */
  appendAllocated(
    input: ConversationProductAppendInput,
  ): Promise<ConversationProductAppendResult>;
  /** Reserve an Agent/Tool coordinate before its first live stream frame. */
  reserveLiveShadowAgent(
    input: ConversationLiveShadowAgentReservationInput,
  ): Promise<ConversationLiveShadowAgentReservationResult>;
  /** Append exactly the already-reserved Agent/Tool ordinary sibling. */
  publishReservedLiveShadowAgent(
    input: ConversationLiveShadowAgentPublishInput,
  ): Promise<ConversationProductAppendResult>;
  /**
   * Attach exact causal event evidence only after the protected representation
   * is complete. The final Assistant event atomically closes the parent turn.
   */
  recordLiveShadowAgentEvidence(
    input: ConversationLiveShadowAgentEvidenceInput,
  ): Promise<ConversationLiveShadowAgentEvidenceResult>;
  getRevision(
    messageId: number,
    revision: number,
  ): Promise<ConversationRevisionState | null>;
  getRevisionMapping?(
    sessionId: string,
    messageId: number,
    revision: number,
  ): Promise<ConversationRevisionMappingState | null>;
  inspectProtectedEditPlanSource(
    messageId: number,
    expectedRevision: number,
  ): Promise<ConversationProtectedEditPlanSource | null>;
  resolveCurrentNamespace(sessionId: string): Promise<string | null>;
  /** Atomically changes only lifecycle completion pending -> complete. */
  markCryptoComplete(input: ConversationRevisionCoordinates & {
    readonly cryptoObjectId: string;
    readonly parityStatus: ConversationParityStatus;
    readonly leaseToken: string | null;
    readonly repairPublication?: ConversationRepairPublicationEvidence;
    readonly publicationPolicy?: ConversationAppendInput["publicationPolicy"];
  }): Promise<"applied" | "duplicate" | "missing" | "conflict">;
  /**
   * Atomically publishes message mapping and mapped lifecycle, or persists
   * stale_mapping on every lost CAS decision.
   */
  compareAndSwapCryptoMapping(input: ConversationRevisionCoordinates & {
    readonly expectedNamespaceId: string;
    readonly cryptoObjectId: string;
    readonly leaseToken: string | null;
    readonly publicationPolicy?: ConversationAppendInput["publicationPolicy"];
  }): Promise<ConversationProductMappingCasResult>;
  /**
   * Atomically records the edit receipt, supersedes the previous lifecycle,
   * changes the product row and creates the next pending lifecycle. Operation
   * IDs share one global namespace with hard delete; receipts compare only
   * exact coordinates plus the 32-byte request digest and survive later
   * edits/deletion.
   */
  editAllocated(input: {
    readonly messageId: number;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly content: string;
    readonly subthreadReplyClassification:
      ConversationSubthreadReplyClassification;
    readonly requestDigest: Uint8Array;
  }): Promise<ConversationProductEditResult>;
  /** Publish an already authenticated Full edit without an ordinary sibling. */
  publishProtectedEdit(input: {
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
      keyClass: ConversationMessageKeyClass;
      namespaceAccessRevision: number;
      namespaceKeyGeneration: number;
      namespaceAudienceFingerprint: Uint8Array;
    }>[];
  }): Promise<ConversationProductEditResult>;
  /** Reads an immutable exact edit receipt without opening ordinary Message fields. */
  inspectProtectedEditReplay(input: {
    readonly messageId: number;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly requestDigest: Uint8Array;
  }): Promise<ConversationProductEditResult | null>;
  /**
   * Atomically records the exact delete receipt, marks the lifecycle
   * hard_delete and removes the product row. Operation IDs share the global
   * edit/delete namespace and receipt replay survives deletion.
   */
  hardDelete(input: {
    readonly messageId: number;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly requestDigest: Uint8Array;
  }): Promise<ConversationProductDeleteResult>;
  quarantineRevision(
    coordinates: ConversationRevisionCoordinates & {
      readonly leaseToken: string | null;
      readonly failureCode: ConversationFailureCode;
    },
  ): Promise<"applied" | "duplicate" | "missing" | "conflict">;
  claimReconciliationCandidates(input: {
    readonly leaseToken: string;
    readonly limit: number;
  }): Promise<readonly ConversationRevisionState[]>;
  failReconciliationClaim(input: ConversationRevisionCoordinates & {
    readonly leaseToken: string;
    readonly failureCode: ConversationFailureCode;
  }): Promise<ConversationRevisionLifecycle | null>;
}

export interface VerifiedConversationCryptoRevision {
  readonly objectId: string;
  readonly namespaceId: string;
  readonly objectType: typeof CONVERSATION_MESSAGE_OBJECT_TYPE;
  readonly payloadVersion: typeof CONVERSATION_MESSAGE_PAYLOAD_VERSION;
  readonly keyClass: ConversationMessageKeyClass;
}

export interface AtomicConversationCryptoCompletionPort {
  complete(
    revision: PreparedConversationCryptoRevision,
  ): Promise<"created" | "duplicate">;
  verify(
    objectId: string,
  ): Promise<VerifiedConversationCryptoRevision | null>;
}

export type ConversationCompletionResult =
  | Readonly<{
    status: "mapped" | "replayed";
    messageId: number;
    revision: number;
    cryptoObjectId: string;
  }>
  | Readonly<{
    status: "orphaned";
    reason: "stale_mapping" | "superseded" | "hard_delete";
    messageId: number;
    revision: number;
    cryptoObjectId: string;
  }>;

export type ConversationReconciliationOutcome =
  | "mapped"
  | "pending"
  | "blocked"
  | "orphaned"
  | "quarantined";

export interface ConversationRepository {
  append(input: ConversationAppendInput): Promise<ConversationAllocatedRevision>;
  completeRevision(input: {
    readonly messageId: number;
    readonly expectedRevision: number;
    readonly parityStatus: Exclude<ConversationParityStatus, "pending">;
    readonly prepared: PreparedConversationCryptoRevision;
    readonly repairPublication?: ConversationRepairPublicationEvidence;
    /** Current prepared repair policy; independent of immutable origin mode. */
    readonly publicationPolicy?: ConversationAppendInput["publicationPolicy"];
  }): Promise<ConversationCompletionResult>;
  edit(input: {
    readonly messageId: number;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly content: string;
    readonly subthreadReplyClassification:
      ConversationSubthreadReplyClassification;
  }): Promise<ConversationEditAllocationResult>;
  hardDelete(input: {
    readonly messageId: number;
    readonly operationId: string;
    readonly expectedRevision: number;
  }): Promise<
    | Readonly<{
      status: "deleted" | "replayed";
      messageId: number;
      revision: number;
      cryptoObjectId: string;
      effects: ConversationDeleteEffects;
    }>
    | Readonly<{
      status: "missing" | "stale" | "message_anchors_thread";
      messageId: number;
    }>
  >;
  reconcilePending(input: {
    readonly leaseToken: string;
    readonly limit: number;
  }): Promise<Readonly<{
    outcomes: readonly Readonly<{
      sequence: number;
      messageId: number;
      revision: number;
      outcome: ConversationReconciliationOutcome;
    }>[];
  }>>;
}

/**
 * Product projection consumed by a protected conversation reader. `ProtectedDto`
 * is supplied by the browser-safe wire package; the bridge boundary itself
 * remains independent of that package.
 */
export interface ConversationProtectedProductReadRecord<ProtectedDto> {
  readonly dto: ProtectedDto;
  readonly author: Readonly<{
    readonly actorId: string;
    readonly handle: string;
    readonly displayName: string;
  }>;
}

export interface ConversationProtectedAgentReadBatch<ProtectedDto> {
  readonly sessionId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly domainId: string;
  readonly expectedAccessRevision: number;
  readonly expectedPolicyRevision: number;
  readonly messages:
    readonly ConversationProtectedProductReadRecord<ProtectedDto>[];
}

declare const conversationProtectedProductReadAuthorizationBrand: unique symbol;

/**
 * Opaque, request-bound proof that the product layer has authenticated and
 * authorized a protected conversation read. The bridge never inspects this
 * handle; concrete product read ports must resolve it against current product
 * authority instead of consulting ambient request state or inferring access
 * from Session/Namespace coordinates.
 */
export type ConversationProtectedProductReadAuthorization = Readonly<{
  readonly [conversationProtectedProductReadAuthorizationBrand]: true;
}>;

/**
 * Content-free product read seam. Implementations may return only reviewed
 * public coordinates and a protected wire DTO/object reference.
 */
export interface ConversationProtectedProductReadPort<ProtectedDto> {
  readPage(input: Readonly<{
    readonly authorization: ConversationProtectedProductReadAuthorization;
    readonly sessionId: string;
    readonly beforeMessageId?: number;
    readonly limit: number;
  }>): Promise<
    readonly ConversationProtectedProductReadRecord<ProtectedDto>[]
  >;
  readAround(input: Readonly<{
    readonly authorization: ConversationProtectedProductReadAuthorization;
    readonly sessionId: string;
    readonly messageId: number;
    readonly radius: number;
  }>): Promise<
    readonly ConversationProtectedProductReadRecord<ProtectedDto>[]
  >;
  readAgentTranscript(input: Readonly<{
    readonly authorization: ConversationProtectedProductReadAuthorization;
    readonly sessionId: string;
    readonly namespaceId: string;
    readonly upToMessageId?: number;
    readonly limit: number;
  }>): Promise<ConversationProtectedAgentReadBatch<ProtectedDto> | null>;
}

export type ConversationProtectedAgentObjectOutcome<
  UnavailableReason extends string,
> =
  | Readonly<{
    readonly status: "opened";
    readonly messageId: number;
    readonly revision: number;
    readonly payload: MessagePayloadV2;
  }>
  | Readonly<{
    readonly status: "pending";
    readonly messageId: number;
    readonly revision: number;
    readonly reason: "shadow_pending" | "backfill_pending";
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly messageId: number;
    readonly revision: number;
    readonly reason: UnavailableReason;
  }>;

/**
 * Crypto-owning message opener. A concrete implementation must resolve the
 * opaque authorization handle to the exact live foreground session and keep
 * every opened payload inside `execute`.
 */
export interface ConversationProtectedAgentContentOpener<
  ProtectedDto,
  UnavailableReason extends string,
> {
  openBatch<Value>(input: Readonly<{
    readonly authorizationSession: unknown;
    readonly entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
    readonly namespaceId: string;
    readonly domainId: string;
    readonly expectedAccessRevision: number;
    readonly expectedPolicyRevision: number;
    readonly messages:
      readonly ConversationProtectedProductReadRecord<ProtectedDto>[];
    readonly signal?: AbortSignal;
    readonly execute: (
      outcomes:
        readonly ConversationProtectedAgentObjectOutcome<UnavailableReason>[],
    ) => Value | PromiseLike<Value>;
  }>): Promise<
    | Readonly<{ readonly status: "executed"; readonly value: Value }>
    | Readonly<{
      readonly status: "unavailable";
      readonly reason:
        | "authorization_unavailable"
        | "content_unavailable"
        | "content_invalid";
    }>
  >;
}

function requestDigest(
  domain: string,
  fields: readonly unknown[],
): Uint8Array {
  return sha256(textEncoder.encode(JSON.stringify([domain, ...fields])));
}

export function conversationAppendRequestDigest(
  input: ConversationAppendInput,
): Uint8Array {
  return requestDigest(input.publicationPolicy === undefined
    ? "nautilo/conversation/append-request/v2"
    : "nautilo/conversation/append-request/v3", [
    input.sessionId,
    input.idempotencyKey,
    input.content,
    input.keyClass,
    input.authorRole,
    input.toolCalls,
    input.toolName,
    input.fingerprint,
    input.humanTurnId,
    input.transcriptOrigin,
    input.parentThreadId,
    input.scopeId,
    input.metadata,
    input.subthreadRoomId,
    input.replyToMessageId,
    input.notificationContext,
    input.structuralProjection,
    ...(input.publicationPolicy === undefined ? [] : [input.publicationPolicy]),
  ]);
}

export function conversationEditRequestDigest(input: {
  readonly messageId: number;
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly content: string;
  readonly subthreadReplyClassification:
    ConversationSubthreadReplyClassification;
}): Uint8Array {
  return requestDigest("nautilo/conversation/edit-request/v2", [
    input.messageId,
    input.operationId,
    input.expectedRevision,
    input.content,
    input.subthreadReplyClassification,
  ]);
}

export function conversationDeleteRequestDigest(input: {
  readonly messageId: number;
  readonly operationId: string;
  readonly expectedRevision: number;
}): Uint8Array {
  return requestDigest("nautilo/conversation/delete-request/v1", [
    input.messageId,
    input.operationId,
    input.expectedRevision,
  ]);
}
