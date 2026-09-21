import type { LatticeStorage } from "@nautilo/lattice-crypto";
import type { RoomHistoryTerminalExecutionSummary } from "@nautilo/types";
import type { PostgresJsBridgeConnection } from "@nautilo/db";
import {
  actors, and, asc, desc, eq, gt, gte, inArray, lt, lte, or, sql,
  sessionMessages, sessions, rooms,
  sessionMessageCryptoRevisions, conversationShadowTurnOperations,
  conversationHumanPeerShadowOperations, conversationSharedAgentShadowOperations,
  conversationSharedAgentShadowExecutions, conversationSharedAgentShadowInvocations,
  conversationSharedAgentShadowExecutionInputs,
  conversationShadowTurnAgentSigners,
} from "@nautilo/db";
import { alias } from "drizzle-orm/pg-core";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  decodeHumanAiReadableLiveShadowMessagePlan,
  decodeHumanAiReadableLiveShadowMessageRequest,
} from "@nautilo/lattice-crypto";
import {
  decodeLiveShadowMessagePlanV4,
  encodeLiveShadowMessagePlanV4,
  MAX_HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_WIRE_BYTES_V4,
  MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V4,
  decodeObjectAccessManifestV2OrV3,
  decodeNamespaceObjectEnvelopeV2,
  parseHumanMessageEditCryptoObjectIdV1,
} from "@nautilo/lattice-crypto/wire";
import { deriveMessageCryptoObjectIdV2 } from "../../message/conversation-repository.ts";
import type { ExistingMessageRepairEvidence, ExistingMessageRetainedGeneration } from
  "../../message/existing-message-repair-evidence.ts";
import type { ResolveLiveShadowAgentObjectSigner } from "../storage/postgres-object-access-manifest-v5.ts";

import type {
  ConversationProductDatabaseRow,
  ConversationProductPostgresHandle,
} from "./postgres-conversation-product-store.ts";
import {
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
} from "./postgres-conversation-product-store.ts";
import {
  projectConversationProtectedMessageDtoV2,
  type ConversationProtectedMessageDtoV2,
} from "./postgres-conversation-protected-read.ts";
import {
  createLiveShadowToolResultCallIdResolver,
  encodeLiveShadowOrdinaryPayloadV2,
  resolveLiveShadowToolResultCallIds,
} from "./postgres-live-shadow-client-verification.ts";
import {
  inspectNamespaceProductAuthoritySnapshot,
  PostgresNamespaceProductAuthority,
} from "../delivery/postgres-namespace-product-authority.ts";
import { PostgresDomainKeyAuthorityRepository } from
  "../delivery/postgres-domain-key-authority.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const MAXIMUM_ROOM_PAGE = 50;

export type RoomHistorySelectedCoordinate = Readonly<{
  readonly sessionId: string;
  readonly messageId: number;
  readonly editRevision: number;
  readonly role: "user" | "assistant" | "tool" | "system";
  readonly logicalMessageKey: string;
}>;

export type RoomHistoryDomainKeyV2Authority = Readonly<{
  readonly scheme: "domain_key_v2";
  readonly keyClass: "human" | "ai";
  readonly subjectHumanId: string;
  readonly readerDeviceId: string;
  readonly readerDeviceSigningKeyGeneration: number;
  readonly hostAuthorizationRevision: number;
  readonly policyRevision: number;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly namespaceAccessRevision: number;
  readonly namespaceCurrentGeneration: number;
  readonly namespaceHeadDigestBase64url: string;
  readonly domainId: string;
  readonly domainKeyGeneration: number;
  readonly domainAuthorizationRevision: number;
  readonly domainHeadDigestBase64url: string;
  readonly namespaceBundleRevision: number;
  readonly namespaceBundleDigestBase64url: string;
}>;

export type RoomHistoryCurrentAuthority = RoomHistoryDomainKeyV2Authority;

export type RoomHistoryCurrentAuthorityResolution =
  | Readonly<{
      readonly status: "ready";
      readonly authority: RoomHistoryDomainKeyV2Authority;
    }>
  | Readonly<{ readonly status: "disabled" }>
  | Readonly<{ readonly status: "unavailable" }>;

export type ResolveRoomHistoryCurrentAuthority = (input: Readonly<{
  readonly subjectHumanId: string;
  readonly subjectUserId: string;
  readonly readerDeviceId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly selectedCoordinates: readonly RoomHistorySelectedCoordinate[];
}>) =>
  | RoomHistoryCurrentAuthorityResolution
  | Promise<RoomHistoryCurrentAuthorityResolution>;

export type RoomHistoryHumanPeerAuthorityResolution =
  | Readonly<{
    readonly status: "ready";
    readonly authority: RoomHistoryDomainKeyV2Authority;
  }>
  | Readonly<{ readonly status: "disabled" }>
  | Readonly<{ readonly status: "unavailable" }>;

export type ResolveRoomHistoryHumanPeerAuthority = (input: Readonly<{
  readonly subjectHumanId: string;
  readonly subjectUserId: string;
  readonly readerDeviceId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly selectedCoordinates: readonly RoomHistorySelectedCoordinate[];
}>) => RoomHistoryHumanPeerAuthorityResolution
  | Promise<RoomHistoryHumanPeerAuthorityResolution>;

export type ResolveRoomHistoryHumanEditedRepresentationAuthority = (
  input: Readonly<{
    subjectHumanId: string;
    readerDeviceId: string;
    namespaceId: string;
    keyClass: "ai" | "human";
    generation: number;
    accessRevision: number;
    authorHumanId: string;
    committerDeviceId: string;
    committerHostAuthorizationRevision: number;
  }>,
) => Promise<Readonly<{
  status: "ready";
  headDigestBase64url: string;
  committerDeviceSigningPublicKeyBase64url: string;
}> | Readonly<{ status: "unavailable" }>>;

export type RoomHistorySignerEvidenceTransportV1 =
  | Readonly<{
    readonly kind: "human_ai_readable_live_shadow_request_v1"
      | "human_ai_readable_live_shadow_request_v2";
    readonly operationId: string;
    readonly planBytesBase64url: string;
    readonly requestBytesBase64url: string;
    readonly requestDigestBase64url: string;
    readonly committerDeviceSigningPublicKeyBase64url?: string | undefined;
  }>
  | Readonly<{
    /** Server-retained accepted execution authority, not a Human signature. */
    readonly kind: "shared_agent_execution_plan_v4";
    readonly operationId: string;
    readonly planBytesBase64url: string;
    readonly planDigestBase64url: string;
  }>
  | Readonly<{
    readonly kind: "agent_runtime_publication";
    readonly evidenceBytesBase64url: string;
  }>
  | Readonly<{
    readonly kind:
      | "human_live_shadow_request_v3"
      | "human_live_shadow_request_v4";
    readonly operationId: string;
    readonly planBytesBase64url: string;
    readonly requestBytesBase64url: string;
    readonly requestDigestBase64url: string;
  }>
  | Readonly<{
    readonly kind: "human_peer_live_shadow_request_v1";
    readonly operationId: string;
    readonly planBytesBase64url: string;
    readonly requestBytesBase64url: string;
    readonly requestDigestBase64url: string;
    readonly senderDeviceId: string;
    readonly senderDeviceSigningKeyGeneration: number;
    readonly senderDeviceSigningPublicKeyBase64url: string;
  }>;

type RoomHistoryLiveProjectionCoordinates = Readonly<{
  readonly kind?: "live_shadow";
  readonly coordinate: RoomHistorySelectedCoordinate;
  readonly shadowOperationId: string;
  readonly shadowOperationFamily?: "shared_human" | "shared_execution";
  readonly shadowTranscriptOrdinal: number;
  readonly retainedGeneration: Readonly<{
    readonly namespaceGeneration: number;
    readonly accessRevision: number;
    readonly headDigestBase64url: string;
    readonly publicationDigestBase64url: string;
    readonly publicationSetDigestBase64url: string;
    readonly audienceFingerprintBase64url: string;
  }>;
  readonly protectedMessage: ConversationProtectedMessageDtoV2;
}>;
export type RoomHistoryLiveShadowProjectionRecord = RoomHistoryLiveProjectionCoordinates & (
  | Readonly<{ representationMode?: "ordinary-and-protected"; ordinaryPayloadBytesBase64url: string }>
  | Readonly<{ representationMode: "protected-only"; selectedSource: RoomHistoryProjectionSource; ordinaryPayloadBytesBase64url?: never }>
);

type RoomHistoryProjectionSource = Readonly<{
  role: RoomHistorySelectedCoordinate["role"];
  logicalMessageKey: string;
  sourceUserId?: string;
  authorAgentId?: string;
}>;

function selectedProjectionSource(
  row: ConversationProductDatabaseRow,
  coordinate: RoomHistorySelectedCoordinate,
): RoomHistoryProjectionSource {
  return {
    role: coordinate.role,
    logicalMessageKey: coordinate.logicalMessageKey,
    ...(coordinate.role === "user" && typeof row["source_user_id"] === "string"
      ? { sourceUserId: row["source_user_id"] } : {}),
    ...((coordinate.role === "assistant" || coordinate.role === "tool") && typeof row["author_agent_id"] === "string"
      ? { authorAgentId: row["author_agent_id"] } : {}),
  };
}

export type RoomHistoryExistingRepresentationProjectionRecord = Readonly<{
  readonly kind: "existing_representation";
  readonly coordinate: RoomHistorySelectedCoordinate;
  readonly protectedMessage: ConversationProtectedMessageDtoV2;
}> & (
  | Readonly<{ repair: Extract<ExistingMessageRepairEvidence, { publisherKind?: "foreground_runtime" }>;
      retainedGeneration?: ExistingMessageRetainedGeneration }>
  | Readonly<{ repair: Extract<ExistingMessageRepairEvidence, { publisherKind: "human_device" }>;
      retainedGeneration: ExistingMessageRetainedGeneration }>
) & (
  | Readonly<{ representationMode?: never; selectedSource?: never; ordinaryPayloadBytesBase64url?: string }>
  | Readonly<{ representationMode: "protected-only"; selectedSource: RoomHistoryProjectionSource;
      ordinaryPayloadBytesBase64url?: never }>
);

export type RoomHistoryHumanEditedRepresentationProjectionRecord = Readonly<{
  readonly kind: "human_edited_representation";
  readonly coordinate: RoomHistorySelectedCoordinate;
  readonly protectedMessage: ConversationProtectedMessageDtoV2;
  readonly authorHumanId: string;
  readonly committerDeviceSigningPublicKeyBase64url: string;
  readonly retainedGeneration: Readonly<{
    readonly namespaceGeneration: number;
    readonly accessRevision: number;
    readonly headDigestBase64url: string;
    readonly publicationDigestBase64url: string;
    readonly publicationSetDigestBase64url: string;
    readonly audienceFingerprintBase64url: string;
  }>;
}> & (
  | Readonly<{ representationMode: "protected-only";
      selectedSource: RoomHistoryProjectionSource; ordinaryPayloadBytesBase64url?: never }>
  | Readonly<{ representationMode: "ordinary-and-protected";
      ordinaryPayloadBytesBase64url: string; selectedSource?: never }>
);

export type RoomHistoryShadowProjectionRecord =
  | RoomHistoryLiveShadowProjectionRecord
  | RoomHistoryExistingRepresentationProjectionRecord
  | RoomHistoryHumanEditedRepresentationProjectionRecord;

export type RoomHistoryShadowProjection =
  | Readonly<{
    readonly status: "ready";
    readonly authority: RoomHistoryCurrentAuthority;
    /** One exact current authority per retained key class in a mixed page. */
    readonly authorities?: readonly RoomHistoryCurrentAuthority[];
    readonly selectedCount: number;
    readonly eligibleCount: number;
    readonly records: readonly RoomHistoryShadowProjectionRecord[];
    readonly signerEvidence: readonly RoomHistorySignerEvidenceTransportV1[];
    readonly terminalExecutions: readonly RoomHistoryTerminalExecutionSummary[];
  }>
  | Readonly<{
    readonly status: "disabled" | "ineligible";
    readonly selectedCount: number;
    readonly eligibleCount: number;
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason:
      | "current_read_authority_unavailable"
      | "selection_changed"
      | "projection_corrupt";
    readonly selectedCount: number;
    readonly eligibleCount: number;
  }>;

type CryptoReadPort = Pick<LatticeStorage, "getObject" | "getObjectAccessState">;

export interface PostgresRoomHistoryShadowProjectionOptions {
  readonly product: ConversationProductPostgresHandle;
  readonly crypto: CryptoReadPort;
  readonly restricted?: PostgresJsBridgeConnection;
  readonly resolveAuthority: ResolveRoomHistoryCurrentAuthority;
  readonly resolveHumanPeerAuthority?: ResolveRoomHistoryHumanPeerAuthority;
  readonly resolveHumanEditedRepresentationAuthority?:
    ResolveRoomHistoryHumanEditedRepresentationAuthority;
  readonly resolveForegroundAgentSigner?: ResolveLiveShadowAgentObjectSigner;
  readonly resolveExistingRetainedGeneration?: (input: Readonly<{
    namespaceId: string; keyClass: "ai" | "human"; generation: number; accessRevision: number;
  }>) => Promise<ExistingMessageRetainedGeneration | null>;
  readonly resolveTerminalExecutions?: (input: Readonly<{
    roomId: string;
    selectedCoordinates: readonly RoomHistorySelectedCoordinate[];
  }>) => Promise<readonly RoomHistoryTerminalExecutionSummary[]>;
}

export async function selectRoomHistoryTerminalExecutions(
  product: ConversationProductPostgresHandle,
  input: Readonly<{
    roomId: string;
    selectedCoordinates: readonly RoomHistorySelectedCoordinate[];
  }>,
): Promise<readonly RoomHistoryTerminalExecutionSummary[]> {
  const requested = input.selectedCoordinates.flatMap((coordinate, selectionOrdinal) =>
    coordinate.role === "user" ? [{
      selectionOrdinal,
      sessionId: coordinate.sessionId,
      messageId: coordinate.messageId,
      editRevision: coordinate.editRevision,
    }] : []
  );
  if (requested.length === 0) return Object.freeze([]);
  const coordinateMatches = requested.map((coordinate) => and(
    eq(sessionMessages.sessionId, coordinate.sessionId),
    eq(sessionMessages.id, coordinate.messageId),
    eq(sessionMessages.editRevision, coordinate.editRevision),
  )!);
  const rows = await executeTypedConversationProductQuery(
    product,
    conversationProductTypedDb.select({
      message_id: sessionMessages.id,
      execution_id: conversationSharedAgentShadowExecutions.executionId,
      execution_sequence: conversationSharedAgentShadowExecutions.sequence,
      state: conversationSharedAgentShadowExecutions.state,
      terminal_reason: conversationSharedAgentShadowExecutions.terminalReason,
    })
      .from(conversationSharedAgentShadowExecutionInputs)
      .innerJoin(
        conversationSharedAgentShadowExecutions,
        eq(
          conversationSharedAgentShadowExecutions.executionId,
          conversationSharedAgentShadowExecutionInputs.executionId,
        ),
      )
      .innerJoin(
        sessionMessages,
        and(
          eq(
            sessionMessages.id,
            conversationSharedAgentShadowExecutionInputs.messageId,
          ),
          or(...coordinateMatches),
        ),
      )
      .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
      .where(and(
        eq(sessions.roomId, input.roomId),
        eq(conversationSharedAgentShadowExecutions.roomId, input.roomId),
        eq(sessionMessages.role, "user"),
        or(
          and(
            eq(conversationSharedAgentShadowExecutions.state, "fallback"),
            eq(
              conversationSharedAgentShadowExecutions.terminalReason,
              "agent_agent_input_cancelled",
            ),
          ),
          and(
            eq(conversationSharedAgentShadowExecutions.state, "failed"),
            eq(
              conversationSharedAgentShadowExecutions.terminalReason,
              "process_lost",
            ),
          ),
        ),
      ))
      .orderBy(asc(conversationSharedAgentShadowExecutions.sequence)),
  );
  const requestedOrder = new Map(requested.map((coordinate) => [
    coordinate.messageId,
    coordinate.selectionOrdinal,
  ]));
  const summaries: Array<RoomHistoryTerminalExecutionSummary & {
    readonly executionSequence: number;
  }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const messageId = counter(
      "Room history terminal execution Message ID",
      row["id"],
      1,
    );
    const executionId = text(
      "Room history terminal execution ID",
      row["execution_id"],
    );
    const executionSequence = counter(
      "Room history terminal execution sequence",
      row["sequence"],
      1,
    );
    exactId("Room history terminal execution ID", executionId, PORTABLE_ID);
    const state = text("Room history terminal execution state", row["state"]);
    const reason = text(
      "Room history terminal execution reason",
      row["terminal_reason"],
    );
    const classification = state === "fallback"
      && reason === "agent_agent_input_cancelled"
      ? "cancelled" as const
      : state === "failed" && reason === "process_lost"
      ? "process_lost" as const
      : null;
    if (classification === null) {
      throw new TypeError("Room history terminal execution is invalid");
    }
    const identity = `${messageId}\0${executionId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    summaries.push(Object.freeze({
      messageId,
      executionId,
      classification,
      executionSequence,
    }));
  }
  summaries.sort((left, right) =>
    (requestedOrder.get(left.messageId) ?? Number.MAX_SAFE_INTEGER)
      - (requestedOrder.get(right.messageId) ?? Number.MAX_SAFE_INTEGER)
      || left.executionSequence - right.executionSequence
  );
  return Object.freeze(summaries.map(({ executionSequence: _sequence, ...summary }) =>
    Object.freeze(summary)
  ));
}

function counter(label: string, value: unknown, minimum = 0): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof normalized !== "number"
    || !Number.isSafeInteger(normalized)
    || normalized < minimum
  ) throw new TypeError(`${label} is invalid`);
  return normalized;
}

function text(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function exactId(label: string, value: string, pattern = UUID): void {
  if (!pattern.test(value) || new TextEncoder().encode(value).length > 128) {
    throw new TypeError(`${label} is invalid`);
  }
}

function digest(label: string, value: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function validateSelected(
  values: readonly RoomHistorySelectedCoordinate[],
): readonly RoomHistorySelectedCoordinate[] {
  if (values.length > MAXIMUM_ROOM_PAGE) {
    throw new RangeError("Room history selection is out of bounds");
  }
  const seen = new Set<string>();
  return Object.freeze(values.map((value) => {
    exactId("Room history selected Session ID", value.sessionId);
    counter("Room history selected Message ID", value.messageId, 1);
    counter("Room history selected edit revision", value.editRevision);
    text("Room history selected role", value.role);
    exactId("Room history selected logical key", value.logicalMessageKey, PORTABLE_ID);
    const key = `${value.sessionId}:${value.messageId}:${value.editRevision}`;
    if (seen.has(key)) throw new TypeError("Room history selection is duplicated");
    seen.add(key);
    return Object.freeze({ ...value });
  }));
}

function validateDomainKeyV2Authority(
  authority: RoomHistoryDomainKeyV2Authority,
  expected: Readonly<{
    subjectHumanId: string;
    readerDeviceId: string;
    roomId: string;
    keyClass: "human" | "ai";
  }>,
): RoomHistoryDomainKeyV2Authority | null {
  if (
    authority.scheme !== "domain_key_v2"
    || authority.keyClass !== expected.keyClass
    || authority.subjectHumanId !== expected.subjectHumanId
    || authority.readerDeviceId !== expected.readerDeviceId
    || authority.roomId !== expected.roomId
  ) return null;
  for (const [label, value, pattern] of [
    ["subject Human ID", authority.subjectHumanId, UUID],
    ["Room ID", authority.roomId, UUID],
    ["Namespace ID", authority.namespaceId, UUID],
    ["reader device ID", authority.readerDeviceId, PORTABLE_ID],
    ["Domain ID", authority.domainId, PORTABLE_ID],
  ] as const) exactId(`Room history ${label}`, value, pattern);
  for (const [label, value, minimum] of [
    ["device signing generation", authority.readerDeviceSigningKeyGeneration, 1],
    ["host authorization revision", authority.hostAuthorizationRevision, 0],
    ["policy revision", authority.policyRevision, 0],
    ["Namespace access revision", authority.namespaceAccessRevision, 0],
    ["Namespace current generation", authority.namespaceCurrentGeneration, 0],
    ["Domain key generation", authority.domainKeyGeneration, 1],
    ["Domain authorization revision", authority.domainAuthorizationRevision, 0],
    ["Namespace bundle revision", authority.namespaceBundleRevision, 1],
  ] as const) counter(`Room history ${label}`, value, minimum);
  for (const [label, value] of [
    ["Namespace head digest", authority.namespaceHeadDigestBase64url],
    ["Domain head digest", authority.domainHeadDigestBase64url],
    ["Namespace bundle digest", authority.namespaceBundleDigestBase64url],
  ] as const) digest(`Room history ${label}`, value);
  return Object.freeze({ ...authority });
}

function selectRoomRows(
  product: ConversationProductPostgresHandle,
  roomId: string,
  selected: readonly RoomHistorySelectedCoordinate[],
  representationMode: "ordinary-and-protected" | "protected-only",
) {
  const sessionRoom = alias(rooms, "history_session_room");
  const coordinates = selected.map((coordinate) => and(
    eq(sessionMessages.sessionId, coordinate.sessionId),
    eq(sessionMessages.id, coordinate.messageId),
    eq(sessionMessages.editRevision, coordinate.editRevision),
  )!);
  // CASE preserves the already bounded, caller-selected order without widening
  // the product read to other Room messages.
  const ordinal = sql<number>`CASE ${sql.join(coordinates.map((match, index) =>
    sql`WHEN ${match} THEN ${index}::int`), sql` `)} END`;
  return executeTypedConversationProductQuery(product,
    conversationProductTypedDb.select({
      selection_ordinal: ordinal.as("selection_ordinal"),
      message_id: sql`${sessionMessages.id}::int`.as("message_id"),
      session_id: sql`${sessionMessages.sessionId}::text`.as("session_id"),
      room_id: sql`${rooms.id}::text`.as("room_id"),
      namespace_id: sql`${rooms.namespaceId}::text`.as("namespace_id"),
      role: sql`${sessionMessages.role}`.as("role"),
      ...(representationMode === "protected-only" ? {} : {
        content: sessionMessages.content,
        tool_calls: sessionMessages.toolCalls,
        tool_name: sessionMessages.toolName,
      }),
      created_at: sql`${sessionMessages.createdAt}`.as("created_at"),
      edited_at: sql`${sessionMessages.editedAt}`.as("edited_at"),
      edit_revision: sql`${sessionMessages.editRevision}::int`.as("edit_revision"),
      fingerprint: sql`${sessionMessages.fingerprint}`.as("fingerprint"),
      reply_to_message_id: sql`${sessionMessages.replyToMessageId}::int`.as("reply_to_message_id"),
      subthread_room_id: sql`${sessionMessages.subthreadRoomId}::text`.as("subthread_room_id"),
      reply_count: sql`${sessionMessages.replyCount}::int`.as("reply_count"),
      last_reply_at: sql`${sessionMessages.lastReplyAt}`.as("last_reply_at"),
      summary_revision: sql`${sessionMessages.summaryRevision}::int`.as("summary_revision"),
      source_user_id: sql`${sessions.ownerId}::text`.as("source_user_id"),
      source_human_id: sql`${actors.id}::text`.as("source_human_id"),
      author_agent_id: sql`COALESCE(${conversationSharedAgentShadowExecutions.agentId}, ${sessions.agentId})::text`.as("author_agent_id"),
      crypto_object_id: sql`${sessionMessages.cryptoObjectId}`.as("crypto_object_id"),
      lifecycle_object_id: sql`${sessionMessageCryptoRevisions.cryptoObjectId}`.as("lifecycle_object_id"),
      object_id_scheme: sql`${sessionMessageCryptoRevisions.objectIdScheme}`.as("object_id_scheme"),
      shadow_operation_id: sql`${sessionMessageCryptoRevisions.shadowOperationId}`.as("shadow_operation_id"),
      human_peer_shadow_operation_id: sql`${sessionMessageCryptoRevisions.humanPeerShadowOperationId}`.as("human_peer_shadow_operation_id"),
      shared_agent_shadow_operation_id: sql`${sessionMessageCryptoRevisions.sharedAgentShadowOperationId}`.as("shared_agent_shadow_operation_id"),
      shared_agent_shadow_execution_id: sql`${sessionMessageCryptoRevisions.sharedAgentShadowExecutionId}`.as("shared_agent_shadow_execution_id"),
      shadow_transcript_ordinal: sql`${sessionMessageCryptoRevisions.shadowTranscriptOrdinal}::int`.as("shadow_transcript_ordinal"),
      payload_version: sql`${sessionMessageCryptoRevisions.payloadVersion}::int`.as("payload_version"),
      key_class: sql`${sessionMessageCryptoRevisions.keyClass}`.as("key_class"),
      author_role: sql`${sessionMessageCryptoRevisions.authorRole}`.as("author_role"),
      completion: sql`${sessionMessageCryptoRevisions.completion}`.as("completion"),
      disposition: sql`${sessionMessageCryptoRevisions.disposition}`.as("disposition"),
      parity_status: sql`${sessionMessageCryptoRevisions.parityStatus}`.as("parity_status"),
      repair_identity_digest: sessionMessageCryptoRevisions.repairIdentityDigest,
      allocation_request_digest: sql`coalesce(${sessionMessageCryptoRevisions.repairSourceDigest}, ${sessionMessageCryptoRevisions.allocationRequestDigest})`.as("allocation_request_digest"),
      repair_publisher_kind: sessionMessageCryptoRevisions.repairPublisherKind,
      repair_publisher_id: sessionMessageCryptoRevisions.repairPublisherId,
      repair_publisher_human_id: sessionMessageCryptoRevisions.repairPublisherHumanId,
      repair_attestation_digest: sessionMessageCryptoRevisions.repairAttestationDigest,
      turn_room_id: sql`COALESCE(${conversationShadowTurnOperations.roomId}, ${conversationHumanPeerShadowOperations.roomId}, ${conversationSharedAgentShadowOperations.roomId})::text`.as("turn_room_id"),
      turn_namespace_id: sql`COALESCE(${conversationShadowTurnOperations.namespaceId}, ${conversationHumanPeerShadowOperations.namespaceId}, ${conversationSharedAgentShadowOperations.namespaceId})::text`.as("turn_namespace_id"),
      namespace_generation: sql`COALESCE(${conversationShadowTurnOperations.namespaceKeyGeneration}, ${conversationHumanPeerShadowOperations.namespaceKeyGeneration}, ${conversationSharedAgentShadowOperations.namespaceKeyGeneration})::int`.as("namespace_generation"),
      turn_namespace_access_revision: sql`COALESCE(${conversationShadowTurnOperations.namespaceAccessRevision}, ${conversationHumanPeerShadowOperations.namespaceAccessRevision}, ${conversationSharedAgentShadowOperations.namespaceAccessRevision})::int`.as("turn_namespace_access_revision"),
      namespace_head_digest: sql`COALESCE(${conversationShadowTurnOperations.namespaceHeadDigest}, ${conversationHumanPeerShadowOperations.namespaceHeadDigest}, ${conversationSharedAgentShadowOperations.namespaceHeadDigest})`.as("namespace_head_digest"),
      namespace_publication_digest: sql`COALESCE(${conversationShadowTurnOperations.namespacePublicationDigest}, ${conversationHumanPeerShadowOperations.namespacePublicationDigest}, ${conversationSharedAgentShadowOperations.namespacePublicationDigest})`.as("namespace_publication_digest"),
      namespace_publication_set_digest: sql`COALESCE(${conversationShadowTurnOperations.namespacePublicationSetDigest}, ${conversationHumanPeerShadowOperations.namespacePublicationSetDigest}, ${conversationSharedAgentShadowOperations.namespacePublicationSetDigest})`.as("namespace_publication_set_digest"),
      namespace_audience_fingerprint: sql`COALESCE(${conversationShadowTurnOperations.namespaceAudienceFingerprint}, ${conversationHumanPeerShadowOperations.namespaceAudienceFingerprint}, ${conversationSharedAgentShadowOperations.namespaceAudienceFingerprint})`.as("namespace_audience_fingerprint"),
      plan_bytes: sql`COALESCE(${conversationShadowTurnOperations.planBytes}, ${conversationHumanPeerShadowOperations.planBytes}, ${conversationSharedAgentShadowOperations.planBytes})`.as("plan_bytes"),
      human_request_bytes: sql`COALESCE(${conversationShadowTurnOperations.humanRequestBytes}, ${conversationHumanPeerShadowOperations.humanRequestBytes}, ${conversationSharedAgentShadowOperations.humanRequestBytes})`.as("human_request_bytes"),
      human_request_digest: sql`COALESCE(${conversationShadowTurnOperations.humanRequestDigest}, ${conversationHumanPeerShadowOperations.humanRequestDigest}, ${conversationSharedAgentShadowOperations.humanRequestDigest})`.as("human_request_digest"),
      human_peer_committer_device_id: sql`${conversationHumanPeerShadowOperations.committerDeviceId}`.as("human_peer_committer_device_id"),
      human_peer_committer_device_signing_key_generation: sql`${conversationHumanPeerShadowOperations.committerDeviceSigningKeyGeneration}::int`.as("human_peer_committer_device_signing_key_generation"),
      agent_signer_key_id: sql`${conversationShadowTurnAgentSigners.agentSignerKeyId}`.as("agent_signer_key_id"),
      shared_session_id: sql`${conversationSharedAgentShadowOperations.sessionId}::text`.as("shared_session_id"),
      shared_message_id: sql`${conversationSharedAgentShadowOperations.humanMessageId}`.as("shared_message_id"),
      shared_object_id: sql`${conversationSharedAgentShadowOperations.cryptoObjectId}`.as("shared_object_id"),
      shared_transcript_ordinal: sql`${conversationSharedAgentShadowOperations.transcriptOrdinal}`.as("shared_transcript_ordinal"),
      execution_session_id: sql`${conversationSharedAgentShadowExecutions.sessionId}::text`.as("execution_session_id"),
      execution_room_id: sql`${conversationSharedAgentShadowExecutions.roomId}::text`.as("execution_room_id"),
      execution_agent_id: sql`${conversationSharedAgentShadowExecutions.agentId}::text`.as("execution_agent_id"),
      execution_sequence: sql`${conversationSharedAgentShadowExecutions.sequence}::double precision`.as("execution_sequence"),
      execution_kind: sql`${conversationSharedAgentShadowExecutions.executionKind}`.as("execution_kind"),
      execution_invocation_id: sql`${conversationSharedAgentShadowExecutions.invocationId}`.as("execution_invocation_id"),
      execution_invoking_human_id: sql`${conversationSharedAgentShadowExecutions.invokingHumanId}`.as("execution_invoking_human_id"),
      execution_invoking_device_id: sql`${conversationSharedAgentShadowExecutions.invokingDeviceId}`.as("execution_invoking_device_id"),
      execution_input_count: sql`${conversationSharedAgentShadowExecutions.inputCount}`.as("execution_input_count"),
      execution_input_set_digest: sql`${conversationSharedAgentShadowExecutions.inputSetDigest}`.as("execution_input_set_digest"),
      execution_state: sql`${conversationSharedAgentShadowExecutions.state}`.as("execution_state"),
      execution_created_at: sql`${conversationSharedAgentShadowExecutions.createdAt}`.as("execution_created_at"),
      execution_terminal_at: sql`${conversationSharedAgentShadowExecutions.terminalAt}`.as("execution_terminal_at"),
      invocation_session_id: sql`${conversationSharedAgentShadowInvocations.sessionId}::text`.as("invocation_session_id"),
      invocation_room_id: sql`${conversationSharedAgentShadowInvocations.roomId}::text`.as("invocation_room_id"),
      invocation_invoking_human_id: sql`${conversationSharedAgentShadowInvocations.invokingHumanId}`.as("invocation_invoking_human_id"),
      invocation_input_count: sql`${conversationSharedAgentShadowInvocations.inputCount}`.as("invocation_input_count"),
      invocation_input_set_digest: sql`${conversationSharedAgentShadowInvocations.inputSetDigest}`.as("invocation_input_set_digest"),
      execution_plan_bytes: sql`${conversationSharedAgentShadowExecutions.planBytes}`.as("execution_plan_bytes"),
      execution_plan_digest: sql`${conversationSharedAgentShadowExecutions.planDigest}`.as("execution_plan_digest"),
      // The direct executor does not run Drizzle bigint decoders. float8
      // yields a number; counter() still rejects values outside safe integers.
      execution_runtime_generation: sql`${conversationSharedAgentShadowExecutions.agentRuntimeGeneration}::double precision`.as("execution_runtime_generation"),
      execution_signer_key_id: sql`${conversationSharedAgentShadowExecutions.agentSignerKeyId}`.as("execution_signer_key_id"),
      execution_signer_public_key: sql`${conversationSharedAgentShadowExecutions.agentSignerPublicKey}`.as("execution_signer_public_key"),
      execution_authorized_at: sql`${conversationSharedAgentShadowExecutions.authorizedAt}`.as("execution_authorized_at"),
      execution_authorization_digest: sql`COALESCE(${conversationSharedAgentShadowInvocations.authorizationDigest}, ${conversationSharedAgentShadowExecutions.authorizationDigest})`.as("execution_authorization_digest"),
    }).from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
      // Canonical parent history includes its Session's Subthread rows. An
      // exact child read may select the same row through its Subthread pointer.
      // Preserve both product selection scopes within one Namespace; a child
      // cannot select unrelated parent rows or another parent's Session.
      .innerJoin(sessionRoom, eq(sessionRoom.id, sessions.roomId))
      .innerJoin(rooms, and(
        eq(rooms.id, roomId),
        eq(rooms.namespaceId, sessionRoom.namespaceId),
        or(eq(rooms.id, sessions.roomId), and(
          eq(rooms.id, sessionMessages.subthreadRoomId),
          eq(rooms.kind, "subthread"), eq(rooms.parentRoomId, sessions.roomId),
        )),
      ))
      .innerJoin(actors, and(eq(actors.ownerId, sessions.ownerId), eq(actors.kind, "user")))
      .leftJoin(sessionMessageCryptoRevisions, and(
        eq(sessionMessageCryptoRevisions.sessionId, sessionMessages.sessionId),
        eq(sessionMessageCryptoRevisions.messageId, sessionMessages.id),
        eq(sessionMessageCryptoRevisions.editRevision, sessionMessages.editRevision),
      ))
      .leftJoin(conversationShadowTurnOperations,
        eq(conversationShadowTurnOperations.operationId, sessionMessageCryptoRevisions.shadowOperationId))
      .leftJoin(conversationHumanPeerShadowOperations,
        eq(conversationHumanPeerShadowOperations.operationId, sessionMessageCryptoRevisions.humanPeerShadowOperationId))
      .leftJoin(conversationSharedAgentShadowOperations,
        eq(conversationSharedAgentShadowOperations.operationId, sessionMessageCryptoRevisions.sharedAgentShadowOperationId))
      .leftJoin(conversationSharedAgentShadowExecutions,
        eq(conversationSharedAgentShadowExecutions.executionId, sessionMessageCryptoRevisions.sharedAgentShadowExecutionId))
      .leftJoin(conversationSharedAgentShadowInvocations,
        eq(conversationSharedAgentShadowInvocations.invocationId, conversationSharedAgentShadowExecutions.invocationId))
      .leftJoin(conversationShadowTurnAgentSigners,
        eq(conversationShadowTurnAgentSigners.operationId, sessionMessageCryptoRevisions.shadowOperationId))
      .where(and(eq(rooms.id, roomId), or(...coordinates)))
      .orderBy(ordinal));
}

async function selectCompleteShadowOperations(
  product: ConversationProductPostgresHandle,
  operationIds: readonly string[],
): Promise<readonly ConversationProductDatabaseRow[]> {
  const operation = sql<string>`COALESCE(
    ${sessionMessageCryptoRevisions.shadowOperationId},
    ${sessionMessageCryptoRevisions.sharedAgentShadowOperationId},
    ${sessionMessageCryptoRevisions.sharedAgentShadowExecutionId})`;
  return product.transaction(async (transaction) => {
    const rows: ConversationProductDatabaseRow[] = [];
    let cursor: Readonly<{
      operationId: string;
      transcriptOrdinal: number;
    }> | null = null;
    for (;;) {
      const page: readonly ConversationProductDatabaseRow[] =
        await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb.select({
            shadow_operation_id: operation.as("shadow_operation_id"),
            session_id: sql`${sessionMessages.sessionId}::text`.as("session_id"),
            shadow_transcript_ordinal: sessionMessageCryptoRevisions.shadowTranscriptOrdinal,
            role: sessionMessages.role,
            content: sessionMessages.content,
            tool_calls: sessionMessages.toolCalls,
            tool_name: sessionMessages.toolName,
            completion: sessionMessageCryptoRevisions.completion,
            disposition: sessionMessageCryptoRevisions.disposition,
            parity_status: sessionMessageCryptoRevisions.parityStatus,
          }).from(sessionMessageCryptoRevisions)
            .innerJoin(sessionMessages, and(
              eq(sessionMessages.sessionId, sessionMessageCryptoRevisions.sessionId),
              eq(sessionMessages.id, sessionMessageCryptoRevisions.messageId),
              eq(sessionMessages.editRevision, sessionMessageCryptoRevisions.editRevision),
            ))
            .where(and(
              eq(sessionMessageCryptoRevisions.objectIdScheme, "live_shadow_v1"),
              inArray(operation, [...operationIds]),
              cursor === null ? undefined : or(
                gt(operation, cursor.operationId),
                and(
                  eq(operation, cursor.operationId),
                  gt(
                    sessionMessageCryptoRevisions.shadowTranscriptOrdinal,
                    cursor.transcriptOrdinal,
                  ),
                ),
              ),
            ))
            .orderBy(operation, sessionMessageCryptoRevisions.shadowTranscriptOrdinal)
            // One look-ahead row proves that the keyset boundary is unique rather
            // than silently skipping a cross-family operation/ordinal collision.
            .limit(MAXIMUM_ROOM_PAGE + 1),
        );
      if (page.length === 0) return rows;
      if (page.length > MAXIMUM_ROOM_PAGE + 1) {
        throw new TypeError("Room history transcript page is invalid");
      }
      let previous = cursor;
      for (const row of page) {
        const key = Object.freeze({
          operationId: text(
            "Room history transcript operation ID",
            row["shadow_operation_id"],
          ),
          transcriptOrdinal: counter(
            "Room history transcript ordinal",
            row["shadow_transcript_ordinal"],
            1,
          ),
        });
        if (previous?.operationId === key.operationId
          && previous.transcriptOrdinal === key.transcriptOrdinal) {
          throw new TypeError("Room history transcript key is ambiguous");
        }
        previous = key;
      }
      const retained: readonly ConversationProductDatabaseRow[] =
        page.slice(0, MAXIMUM_ROOM_PAGE);
      rows.push(...retained);
      if (page.length <= MAXIMUM_ROOM_PAGE) return rows;
      const last: ConversationProductDatabaseRow =
        retained[retained.length - 1]!;
      cursor = Object.freeze({
        operationId: text(
          "Room history transcript operation ID",
          last["shadow_operation_id"],
        ),
        transcriptOrdinal: counter(
          "Room history transcript ordinal",
          last["shadow_transcript_ordinal"],
          1,
        ),
      });
    }
  }, { isolationLevel: "serializable" });
}

type SharedResumeLineageKey = Readonly<{
  currentExecutionId: string;
  currentSequence: number;
  sessionId: string;
  roomId: string;
  namespaceId: string;
  agentId: string;
  invokingHumanId: string;
  invokingDeviceId: string;
  inputCount: number;
  inputSetDigest: Uint8Array;
}>;

function selectSharedResumeLineagePage(
  product: ConversationProductPostgresHandle,
  key: SharedResumeLineageKey,
  direction: "backward" | "forward",
  cursor: number | null,
) {
  const execution = conversationSharedAgentShadowExecutions;
  const invocation = conversationSharedAgentShadowInvocations;
  const cursorClause = direction === "backward"
    ? cursor === null ? lte(execution.sequence, key.currentSequence) : lt(execution.sequence, cursor)
    : cursor === null ? gte(execution.sequence, 1) : gt(execution.sequence, cursor);
  return executeTypedConversationProductQuery(product,
    conversationProductTypedDb.select({
      execution_sequence: sql`${execution.sequence}::double precision`.as("execution_sequence"),
      execution_id: sql`${execution.executionId}`.as("execution_id"),
      execution_kind: sql`${execution.executionKind}`.as("execution_kind"),
      execution_invocation_id: sql`${execution.invocationId}`.as("execution_invocation_id"),
      execution_session_id: sql`${execution.sessionId}::text`.as("execution_session_id"),
      execution_room_id: sql`${execution.roomId}::text`.as("execution_room_id"),
      execution_agent_id: sql`${execution.agentId}::text`.as("execution_agent_id"),
      execution_invoking_human_id: sql`${execution.invokingHumanId}`.as("execution_invoking_human_id"),
      execution_invoking_device_id: sql`${execution.invokingDeviceId}`.as("execution_invoking_device_id"),
      execution_input_count: sql`${execution.inputCount}`.as("execution_input_count"),
      execution_input_set_digest: sql`${execution.inputSetDigest}`.as("execution_input_set_digest"),
      execution_state: sql`${execution.state}`.as("execution_state"),
      execution_created_at: sql`${execution.createdAt}`.as("execution_created_at"),
      execution_terminal_at: sql`${execution.terminalAt}`.as("execution_terminal_at"),
      execution_plan_bytes: sql`${execution.planBytes}`.as("execution_plan_bytes"),
      execution_plan_digest: sql`${execution.planDigest}`.as("execution_plan_digest"),
      execution_runtime_generation: sql`${execution.agentRuntimeGeneration}::double precision`.as("execution_runtime_generation"),
      execution_signer_key_id: sql`${execution.agentSignerKeyId}`.as("execution_signer_key_id"),
      execution_signer_public_key: sql`${execution.agentSignerPublicKey}`.as("execution_signer_public_key"),
      execution_authorized_at: sql`${execution.authorizedAt}`.as("execution_authorized_at"),
      execution_authorization_digest: sql`COALESCE(${invocation.authorizationDigest}, ${execution.authorizationDigest})`.as("execution_authorization_digest"),
      invocation_session_id: sql`${invocation.sessionId}::text`.as("invocation_session_id"),
      invocation_room_id: sql`${invocation.roomId}::text`.as("invocation_room_id"),
      invocation_invoking_human_id: sql`${invocation.invokingHumanId}`.as("invocation_invoking_human_id"),
      invocation_input_count: sql`${invocation.inputCount}`.as("invocation_input_count"),
      invocation_input_set_digest: sql`${invocation.inputSetDigest}`.as("invocation_input_set_digest"),
    }).from(execution).leftJoin(invocation, eq(invocation.invocationId, execution.invocationId))
      .where(and(
        eq(execution.sessionId, key.sessionId),
        eq(execution.roomId, key.roomId),
        eq(execution.agentId, key.agentId),
        eq(execution.invokingHumanId, key.invokingHumanId),
        eq(execution.inputCount, key.inputCount),
        eq(execution.inputSetDigest, key.inputSetDigest),
        lte(execution.sequence, key.currentSequence),
        cursorClause,
      ))
      .orderBy(direction === "backward" ? desc(execution.sequence) : asc(execution.sequence))
      .limit(MAXIMUM_ROOM_PAGE));
}

function sharedResumeLineageKey(row: ConversationProductDatabaseRow): SharedResumeLineageKey {
  return Object.freeze({
    currentExecutionId: text("Shared resume execution ID", row["shared_agent_shadow_execution_id"]),
    currentSequence: counter("Shared resume execution sequence", row["execution_sequence"], 1),
    sessionId: text("Shared resume Session ID", row["execution_session_id"]),
    roomId: text("Shared resume Room ID", row["execution_room_id"]),
    namespaceId: text("Shared resume Namespace ID", row["namespace_id"]),
    agentId: text("Shared resume Agent ID", row["execution_agent_id"]),
    invokingHumanId: text("Shared resume invoking Human ID", row["execution_invoking_human_id"]),
    invokingDeviceId: text("Shared resume source device ID", row["execution_invoking_device_id"]),
    inputCount: counter("Shared resume input count", row["execution_input_count"], 1),
    inputSetDigest: byteField(row, "execution_input_set_digest").slice(),
  });
}

// Direct product queries return PostgreSQL timestamps as strings; unlike a
// Drizzle execution, they do not apply the schema's Date decoder.
function executionTimestamp(value: unknown): number {
  const milliseconds = value instanceof Date ? value.getTime()
    : typeof value === "string"
      && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(value)
    ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("Shared resume execution timestamp is invalid");
  }
  return milliseconds;
}

function validateSharedResumeLineageExecution(
  row: ConversationProductDatabaseRow,
  key: SharedResumeLineageKey,
): Readonly<{ sequence: number; executionId: string; kind: "turn" | "resume";
  createdAt: number; terminalAt: number | null }> {
  const executionId = text("Shared resume lineage execution ID", row["execution_id"]);
  const current = executionId === key.currentExecutionId;
  const kind = row["execution_kind"];
  const createdAt = executionTimestamp(row["execution_created_at"]);
  const terminalAt = row["execution_terminal_at"] === null
    ? null : executionTimestamp(row["execution_terminal_at"]);
  const state = row["execution_state"];
  const terminal = state === "completed" || state === "fallback" || state === "failed";
  const inputDigest = byteField(row, "execution_input_set_digest");
  const invocationDigest = byteField(row, "invocation_input_set_digest");
  if ((kind !== "turn" && kind !== "resume")
    || (!current && (!terminal || terminalAt === null))
    || (current && !terminal && state !== "authorized" && state !== "running")
    || (terminal && (terminalAt === null || terminalAt < createdAt))
    || (!terminal && terminalAt !== null)
    || row["execution_invocation_id"] == null
    || row["execution_session_id"] !== key.sessionId
    || row["execution_room_id"] !== key.roomId
    || row["execution_agent_id"] !== key.agentId
    || row["execution_invoking_human_id"] !== key.invokingHumanId
    || row["execution_invoking_device_id"] !== key.invokingDeviceId
    || counter("Shared resume lineage input count", row["execution_input_count"], 1) !== key.inputCount
    || !bytesEqual(inputDigest, key.inputSetDigest)
    || typeof row["invocation_session_id"] !== "string"
    || row["invocation_session_id"].length === 0
    || (kind === "resume" && row["invocation_session_id"] !== key.sessionId)
    || row["invocation_room_id"] !== key.roomId
    || row["invocation_invoking_human_id"] !== key.invokingHumanId
    || counter("Shared resume invocation input count", row["invocation_input_count"], 1) !== key.inputCount
    || !bytesEqual(invocationDigest, key.inputSetDigest)) {
    throw new TypeError("Shared resume execution lineage disagrees");
  }
  return Object.freeze({
    sequence: counter("Shared resume lineage sequence", row["execution_sequence"], 1),
    executionId,
    kind,
    createdAt,
    terminalAt,
  });
}

function validateSharedResumePublisher(
  row: ConversationProductDatabaseRow,
  key: SharedResumeLineageKey,
): void {
  const evidence = withSharedProvenance({
    ...row,
    shared_agent_shadow_execution_id: text("Shared resume publisher execution ID", row["execution_id"]),
    shadow_operation_id: null,
    human_peer_shadow_operation_id: null,
    shared_agent_shadow_operation_id: null,
    session_id: key.sessionId,
    room_id: key.roomId,
    namespace_id: key.namespaceId,
    author_agent_id: key.agentId,
    edit_revision: 0,
  });
  const planBytes = evidence["execution_plan_bytes"];
  if (!(planBytes instanceof Uint8Array)) {
    throw new TypeError("Shared resume signed execution plan is unavailable");
  }
  const plan = decodeLiveShadowMessagePlanV4(planBytes);
  if (plan.subjectHumanId !== key.invokingHumanId
    || plan.committerDeviceId !== row["execution_invoking_device_id"]) {
    throw new TypeError("Shared resume signed input lineage disagrees");
  }
}

async function resolveSharedResumeToolResultCallId(
  product: ConversationProductPostgresHandle,
  selectedRow: ConversationProductDatabaseRow,
  selectedOrdinal: number,
): Promise<string> {
  const key = sharedResumeLineageKey(selectedRow);
  try {
    let backwardCursor: number | null = null;
    let sourceSequence: number | null = null;
    let sawCurrent = false;
    while (sourceSequence === null) {
      const page = await selectSharedResumeLineagePage(product, key, "backward", backwardCursor);
      if (page.length === 0) throw new TypeError("Shared resume source execution is unavailable");
      for (const row of page) {
        const sequence = counter("Shared resume source sequence", row["execution_sequence"], 1);
        if (!sawCurrent) {
          if (text("Shared resume current execution", row["execution_id"]) !== key.currentExecutionId) {
            throw new TypeError("Shared resume current execution is not the lineage head");
          }
          sawCurrent = true;
        }
        const kind = row["execution_kind"];
        if (kind === "turn") {
          sourceSequence = sequence;
          break;
        }
        if (kind !== "resume") throw new TypeError("Shared resume lineage kind is invalid");
        backwardCursor = sequence;
      }
      if (sourceSequence === null && page.length < MAXIMUM_ROOM_PAGE) {
        throw new TypeError("Shared resume source execution is unavailable");
      }
    }

    const resolver = createLiveShadowToolResultCallIdResolver();
    let consumedRows = 0;
    let forwardCursor: number | null = sourceSequence - 1;
    let previous: ReturnType<typeof validateSharedResumeLineageExecution> | null = null;
    let selectedCallId: string | null = null;
    let sawSelected = false;
    while (!sawSelected) {
      const page = await selectSharedResumeLineagePage(product, key, "forward", forwardCursor);
      if (page.length === 0) throw new TypeError("Shared resume lineage ended before its selected execution");
      const ordered = page.map(row => validateSharedResumeLineageExecution(row, key));
      for (let index = 0; index < ordered.length; index += 1) {
        const execution = ordered[index]!;
        if (previous !== null) {
          if (execution.sequence <= previous.sequence
            || previous.terminalAt === null
            || execution.kind !== "resume") {
            throw new TypeError("Shared resume execution lineage is not terminal and ordered");
          }
          // createdAt records reservation, not execution. reserveRuntimeResume
          // may create the next approval before the predecessor's terminal
          // bookkeeping is written. Sequence plus exact signed provenance and
          // transcript parity establish order; reservation lifetimes do not.
        } else if (execution.sequence !== sourceSequence || execution.kind !== "turn") {
          throw new TypeError("Shared resume execution lineage has no unique turn source");
        }
        previous = execution;
      }
      const transcriptRows = await selectCompleteShadowOperations(
        product,
        ordered.map(execution => execution.executionId),
      );
      const byExecution = new Map<string, ConversationProductDatabaseRow[]>();
      for (const row of transcriptRows) {
        const executionId = text("Shared resume transcript execution ID", row["shadow_operation_id"]);
        const group = byExecution.get(executionId) ?? [];
        group.push(row);
        byExecution.set(executionId, group);
      }
      for (const [executionIndex, execution] of ordered.entries()) {
        const transcript = byExecution.get(execution.executionId) ?? [];
        // A resume may expire before approval or plan creation. An exact,
        // terminal, empty reservation contributes no published evidence. Any
        // output at all (including pending/malformed output) needs provenance.
        const state = page[executionIndex]!["execution_state"];
        if (transcript.length > 0 || execution.kind !== "resume"
          || execution.executionId === key.currentExecutionId
          || (state !== "failed" && state !== "fallback")) {
          validateSharedResumePublisher(page[executionIndex]!, key);
        }
        if (transcript.some((row, index) =>
          counter("Shared resume transcript ordinal", row["shadow_transcript_ordinal"], 1) !== index + 2
          || (row["role"] !== "assistant" && row["role"] !== "tool")
          || typeof row["content"] !== "string"
          || row["completion"] !== "complete"
          || row["disposition"] !== "mapped"
          || (row["parity_status"] !== "server_verified" && row["parity_status"] !== "client_verified")
        )) throw new TypeError("Shared resume execution transcript is invalid");
        const callIds = resolver.consume(transcript, {
          allowProjectionCheckpointRedaction: execution.kind === "resume",
        });
        for (let index = 0; index < transcript.length; index += 1) {
          const row = transcript[index]!;
          if (execution.executionId === key.currentExecutionId
            && counter("Shared resume selected ordinal", row["shadow_transcript_ordinal"], 1) === selectedOrdinal) {
            if (sawSelected || row["role"] !== "tool") {
              throw new TypeError("Shared resume selected Tool result is ambiguous");
            }
            sawSelected = true;
            selectedCallId = callIds.get(consumedRows + index + 1) ?? null;
          }
        }
        consumedRows += transcript.length;
      }
      forwardCursor = ordered[ordered.length - 1]!.sequence;
      if (!sawSelected && forwardCursor >= key.currentSequence) {
        throw new TypeError("Shared resume selected Tool result is unavailable");
      }
    }
    if (selectedCallId === null) throw new TypeError("Shared resume selected Tool result is unpaired");
    return selectedCallId;
  } finally {
    key.inputSetDigest.fill(0);
  }
}

function operationFamily(row: ConversationProductDatabaseRow): "legacy" | "human_peer" | "shared_human" | "shared_execution" | null {
  const families = [
    ["legacy", row["shadow_operation_id"]],
    ["human_peer", row["human_peer_shadow_operation_id"]],
    ["shared_human", row["shared_agent_shadow_operation_id"]],
    ["shared_execution", row["shared_agent_shadow_execution_id"]],
  ] as const;
  const present = families.filter(([, value]) => value != null);
  return present.length === 1 && typeof present[0]![1] === "string"
    && present[0]![1].length > 0 ? present[0]![0] : null;
}

function isEligible(row: ConversationProductDatabaseRow): boolean {
  const family = operationFamily(row);
  const role = row["role"];
  if (isHumanEditedRepresentation(row)) return true;
  if (isExistingRepresentation(row)) return row["completion"] === "complete"
    && (row["key_class"] === "ai" || row["key_class"] === "human")
    && role === row["author_role"] && (role === "user" || role === "assistant" || role === "tool" || role === "system");
  if (row["object_id_scheme"] !== "live_shadow_v1"
    || role !== row["author_role"]) return false;
  if (family === "human_peer") return row["key_class"] === "human" && role === "user";
  if (row["key_class"] !== "ai") return false;
  if (family === "shared_human") return role === "user";
  if (family === "shared_execution") return role === "assistant" || role === "tool";
  return family === "legacy" && (role === "user" || role === "assistant" || role === "tool");
}

function isHumanEditedRepresentation(row: ConversationProductDatabaseRow): boolean {
  return row["object_id_scheme"] === "human_message_edit_v1"
    && row["repair_identity_digest"] == null
    && (row["key_class"] === "human" || row["key_class"] === "ai")
    && row["role"] === "user"
    && row["author_role"] === "user"
    && counter("Edited Human revision", row["edit_revision"], 1) > 0
    && row["completion"] === "complete"
    && row["disposition"] === "mapped"
    && row["parity_status"] === "client_authenticated"
    && row["crypto_object_id"] === row["lifecycle_object_id"];
}


function isExistingRepresentation(row: ConversationProductDatabaseRow): boolean {
  return row["object_id_scheme"] === "message_v2" && row["repair_identity_digest"] != null
    && ["shadow_operation_id", "human_peer_shadow_operation_id",
      "shared_agent_shadow_operation_id", "shared_agent_shadow_execution_id"]
      .every((field) => row[field] == null);
}

async function projectExistingRepresentation(
  options: PostgresRoomHistoryShadowProjectionOptions,
  coordinate: RoomHistorySelectedCoordinate,
  row: ConversationProductDatabaseRow,
  roomId: string,
  namespaceId: string,
  protectedOnly: boolean,
  reader: Readonly<{ subjectHumanId: string; readerDeviceId: string }>,
): Promise<RoomHistoryExistingRepresentationProjectionRecord> {
  const ordinary = !protectedOnly && coordinate.role === "system"
    ? encodeLiveShadowOrdinaryPayloadV2(row, null) : null;
  const representation = protectedOnly
    ? { representationMode: "protected-only" as const, selectedSource: selectedProjectionSource(row, coordinate) }
    : ordinary === null ? {} : { ordinaryPayloadBytesBase64url: Buffer.from(ordinary).toString("base64url") };
  ordinary?.fill(0);
  const identity = byteField(row, "repair_identity_digest");
  const allocation = byteField(row, "allocation_request_digest");
  const attestation = byteField(row, "repair_attestation_digest");
  const publisher = text("Repair publisher signer", row["repair_publisher_id"]);
  const expectedId = deriveMessageCryptoObjectIdV2({
    sessionId: coordinate.sessionId, messageId: coordinate.messageId, revision: coordinate.editRevision,
  });
  if ([identity, allocation, attestation].some((value) => value.length !== 32)
    || (row["repair_publisher_kind"] !== "foreground_runtime" && row["repair_publisher_kind"] !== "human_device")
    || row["completion"] !== "complete" || row["disposition"] !== "mapped"
    || (!["server_verified", "client_verified", "server_authenticated", "client_authenticated"].includes(String(row["parity_status"])))
    || row["crypto_object_id"] !== expectedId || row["lifecycle_object_id"] !== expectedId) {
    throw new TypeError("Existing Message repair receipt disagrees");
  }
  const dto = await projectConversationProtectedMessageDtoV2(
    row, { sessionId: coordinate.sessionId, roomId, namespaceId }, options.crypto,
  );
  if (dto.projection.logicalMessageKey !== coordinate.logicalMessageKey
    || dto.protectedPayload.status !== "encrypted") {
    throw new TypeError("Existing Message repair selection or ciphertext unavailable");
  }
  const manifestBytes = Buffer.from(dto.protectedPayload.accessManifestBytesBase64url, "base64url");
  const manifest = decodeObjectAccessManifestV2OrV3(manifestBytes);
  if (row["repair_publisher_kind"] === "human_device") {
    const envelopeBytes = Buffer.from(dto.protectedPayload.namespaceEnvelopeBytesBase64url, "base64url");
    const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
    try {
      if (manifest.formatVersion !== 2 || manifest.objectId !== expectedId
        || manifest.committerDeviceId !== publisher || manifest.accessRevision !== 0
        || !bytesEqual(sha256(manifestBytes), attestation)
        || envelope.context.objectId !== expectedId
        || envelope.context.namespaceId !== namespaceId
        || envelope.context.keyClass !== row["key_class"]) {
        throw new TypeError("Device Message repair attestation disagrees");
      }
      const publisherHumanId = text("Repairing Human", row["repair_publisher_human_id"]);
      const resolved = await options.resolveHumanEditedRepresentationAuthority?.({
        ...reader, namespaceId, keyClass: envelope.context.keyClass,
        generation: envelope.context.keyGeneration,
        accessRevision: envelope.context.bindingRevisionAtWrap,
        authorHumanId: publisherHumanId,
        committerDeviceId: manifest.committerDeviceId,
        committerHostAuthorizationRevision: manifest.hostAuthorizationRevision,
      });
      if (resolved?.status !== "ready") throw new TypeError("Device Message retained authority unavailable");
      return { kind: "existing_representation", coordinate, protectedMessage: dto, ...representation,
        repair: { publisherKind: "human_device", publisherHumanId,
          identityDigestBase64url: base64url(identity), allocationDigestBase64url: base64url(allocation),
          attestationDigestBase64url: base64url(attestation), publisherSignerKeyId: publisher,
          publisherSigningPublicKeyBase64url: resolved.committerDeviceSigningPublicKeyBase64url },
        retainedGeneration: { namespaceGeneration: envelope.context.keyGeneration,
          accessRevision: envelope.context.bindingRevisionAtWrap,
          headDigestBase64url: resolved.headDigestBase64url,
          publicationDigestBase64url: resolved.headDigestBase64url,
          publicationSetDigestBase64url: resolved.headDigestBase64url,
          audienceFingerprintBase64url: resolved.headDigestBase64url },
      };
    } finally { manifestBytes.fill(0); envelopeBytes.fill(0); envelope.wrappedDek.fill(0); }
  }
  if (manifest.formatVersion !== 3 || manifest.objectId !== expectedId
    || manifest.signer.signerKeyId !== publisher || !bytesEqual(sha256(manifestBytes), attestation)) {
    throw new TypeError("Existing Message repair attestation disagrees");
  }
  const publicKey = await options.resolveForegroundAgentSigner?.(manifest.signer);
  if (publicKey == null || publicKey.length !== 32) {
    throw new TypeError("Existing Message repair publisher unavailable");
  }
  try {
    let retainedGeneration: ExistingMessageRetainedGeneration | undefined;
    if (options.resolveExistingRetainedGeneration !== undefined) {
      const envelopeBytes = Buffer.from(dto.protectedPayload.namespaceEnvelopeBytesBase64url, "base64url");
      const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
      try {
        if (envelope.context.objectId !== expectedId || envelope.context.namespaceId !== namespaceId
          || envelope.context.keyClass !== "ai") throw new TypeError("Runtime repair retained coordinates disagree");
        retainedGeneration = await options.resolveExistingRetainedGeneration({
          namespaceId, keyClass: "ai", generation: envelope.context.keyGeneration,
          accessRevision: envelope.context.bindingRevisionAtWrap,
        }) ?? undefined;
        if (retainedGeneration === undefined) throw new TypeError("Runtime repair retained authority unavailable");
      } finally { envelopeBytes.fill(0); envelope.wrappedDek.fill(0); }
    }
    return { kind: "existing_representation", coordinate, protectedMessage: dto, ...representation,
      ...(retainedGeneration === undefined ? {} : { retainedGeneration }),
      repair: { identityDigestBase64url: base64url(identity),
        allocationDigestBase64url: base64url(allocation),
        attestationDigestBase64url: base64url(attestation), publisherSignerKeyId: publisher,
        publisherSigningPublicKeyBase64url: base64url(publicKey) } };
  } finally { publicKey.fill(0); manifestBytes.fill(0); }
}

function operationIdFor(row: ConversationProductDatabaseRow): string {
  return text("Room history Shadow operation ID",
    row["shadow_operation_id"] ?? row["human_peer_shadow_operation_id"]
      ?? row["shared_agent_shadow_operation_id"] ?? row["shared_agent_shadow_execution_id"]);
}

/** Bind shared provenance before exposing ciphertext or signer authority. */
function withSharedProvenance(row: ConversationProductDatabaseRow): ConversationProductDatabaseRow {
  const family = operationFamily(row);
  if (family === "shared_human") {
    if (row["shared_session_id"] !== row["session_id"]
      || counter("Shared Human message", row["shared_message_id"], 1) !== row["message_id"]
      || row["shared_object_id"] !== row["lifecycle_object_id"]
      || counter("Shared Human ordinal", row["shared_transcript_ordinal"], 1) !== row["shadow_transcript_ordinal"]
      || row["edit_revision"] !== 0) throw new TypeError("Shared Human history provenance disagrees");
  }
  if (family !== "shared_execution") return row;
  const planBytes = row["execution_plan_bytes"];
  const planDigest = row["execution_plan_digest"];
  const authorizationDigest = row["execution_authorization_digest"];
  const invocationBacked = row["execution_invocation_id"] != null;
  const publicKey = row["execution_signer_public_key"];
  if (!(planBytes instanceof Uint8Array) || !(planDigest instanceof Uint8Array)
    || !(authorizationDigest instanceof Uint8Array) || authorizationDigest.length !== 32
    || !(publicKey instanceof Uint8Array) || row["execution_authorized_at"] == null
    || !bytesEqual(sha256(planBytes), planDigest)) throw new TypeError("Shared execution history evidence is unavailable");
  if (invocationBacked && (
    (row["execution_kind"] !== "turn" && row["execution_kind"] !== "resume")
    || typeof row["invocation_session_id"] !== "string"
    || row["invocation_session_id"].length === 0
    // A turn fans one Human invocation out into per-Agent Sessions. A resume
    // instead reserves an invocation for the exact existing Agent Session.
    || (row["execution_kind"] === "resume"
      && row["invocation_session_id"] !== row["execution_session_id"])
    || row["invocation_room_id"] !== row["execution_room_id"]
    || row["invocation_invoking_human_id"] !== row["execution_invoking_human_id"]
    || counter("Shared invocation input count", row["invocation_input_count"], 1)
      !== counter("Shared execution input count", row["execution_input_count"], 1)
    || !bytesEqual(byteField(row, "invocation_input_set_digest"),
      byteField(row, "execution_input_set_digest"))
  )) throw new TypeError("Shared execution invocation authority disagrees");
  const plan = decodeLiveShadowMessagePlanV4(planBytes);
  try {
    if (!bytesEqual(encodeLiveShadowMessagePlanV4(plan), planBytes)
      || plan.operationId !== operationIdFor(row)
      || plan.sessionId !== row["session_id"] || plan.sessionId !== row["execution_session_id"]
      || plan.roomId !== row["room_id"] || plan.roomId !== row["execution_room_id"]
      || plan.namespaceId !== row["namespace_id"]
      || plan.recipientAgentId !== row["execution_agent_id"]
      || plan.recipientAgentId !== row["author_agent_id"]
      || plan.agentRuntimeGeneration !== counter("Execution generation", row["execution_runtime_generation"])
      || plan.agentSignerKeyId !== row["execution_signer_key_id"]
      || !bytesEqual(plan.agentSignerPublicKey, publicKey)
      || row["edit_revision"] !== 0
      // Invocation-backed V4 plans are server work descriptors. Their cached
      // grant may differ from the separately accepted Runtime invocation grant;
      // the latter owns authorization and is bound to exact inputs above.
      || (!invocationBacked && plan.authorization.disposition === "authorization_reusable"
        && !bytesEqual(plan.authorization.authorizationDigest, authorizationDigest))) {
      throw new TypeError("Shared execution history provenance disagrees");
    }
    return { ...row,
      turn_room_id: plan.roomId, turn_namespace_id: plan.namespaceId,
      namespace_generation: plan.namespaceKeyGeneration,
      turn_namespace_access_revision: plan.namespaceAccessRevision,
      namespace_head_digest: plan.namespaceHeadDigest.slice(),
      namespace_publication_digest: plan.namespacePublicationDigest.slice(),
      namespace_publication_set_digest: plan.namespacePublicationSetDigest.slice(),
      namespace_audience_fingerprint: plan.namespaceAudienceFingerprint.slice(),
    };
  } finally {
    for (const value of Object.values(plan)) if (value instanceof Uint8Array) value.fill(0);
    for (const value of Object.values(plan.authorization)) if (value instanceof Uint8Array) value.fill(0);
  }
}

function base64url(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new TypeError("Room history authority digest is invalid");
  }
  return Buffer.from(bytes).toString("base64url");
}

function byteField(
  row: ConversationProductDatabaseRow,
  key: string,
): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(`Room history ${key} is invalid`);
  }
  return value;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export function createCurrentDomainKeyRoomHistoryAuthorityResolver(input: Readonly<{
  readonly product: PostgresJsBridgeConnection;
  readonly productAuthority: PostgresNamespaceProductAuthority;
  readonly domainKeys: PostgresDomainKeyAuthorityRepository;
}>): ResolveRoomHistoryCurrentAuthority {
  const policy = async (): Promise<Readonly<{
    mode: string;
    revision: number;
  }> | null> => {
    const rows = await input.product.query(
      `/* m275_room_history_policy */
       SELECT mode, revision::int AS revision
         FROM encryption_transition_policy
        WHERE id = 'server'
        LIMIT 2`,
    );
    if (rows.length !== 1) return null;
    return Object.freeze({
      mode: text("Room history policy mode", rows[0]!["mode"]),
      revision: counter("Room history policy revision", rows[0]!["revision"], 1),
    });
  };

  return async (request) => {
    const before = await policy();
    if (before === null) return Object.freeze({ status: "unavailable" as const });
    if (before.mode === "plaintext_only") {
      return Object.freeze({ status: "disabled" as const });
    }
    if (before.mode !== "shadow_encryption" && before.mode !== "encrypted_only") {
      return Object.freeze({ status: "unavailable" as const });
    }
    const resolved = await input.productAuthority
      .withDetachedCurrentMessageHistoryRead({
        subjectUserId: request.subjectUserId,
        subjectHumanId: request.subjectHumanId,
        roomId: request.roomId,
        namespaceId: request.namespaceId,
        use: async (snapshot) => {
          const inspected = await input.domainKeys.inspectMessageReadAuthority({
            authority: snapshot,
            deviceId: request.readerDeviceId,
            keyClass: "ai",
          });
          if (inspected.status !== "ready") return null;
          const current = await input.domainKeys
            .inspectForegroundNamespaceAuthority({
              namespaceId: request.namespaceId,
              keyClass: "ai",
            });
          if (current.status !== "ready") return null;
          const snapshotFacts = inspectNamespaceProductAuthoritySnapshot(snapshot);
          try {
            if (
              snapshotFacts.namespaceId !== request.namespaceId
              || inspected.subjectHumanId !== request.subjectHumanId
              || inspected.committerDeviceId !== request.readerDeviceId
              || inspected.namespaceId !== request.namespaceId
              || inspected.namespaceAccessRevision
                !== snapshotFacts.accessRevision
              || current.namespaceAccessRevision !== snapshotFacts.accessRevision
              || current.namespaceKeyGeneration
                !== inspected.namespaceKeyGeneration
              || !bytesEqual(
                current.namespaceHeadDigest,
                inspected.namespaceHeadDigest,
              )
            ) return null;
            return Object.freeze({
              scheme: "domain_key_v2" as const,
              keyClass: "ai" as const,
              subjectHumanId: request.subjectHumanId,
              readerDeviceId: request.readerDeviceId,
              readerDeviceSigningKeyGeneration:
                inspected.committerDeviceSigningKeyGeneration,
              hostAuthorizationRevision: inspected.committerDeviceRevision,
              policyRevision: before.revision,
              roomId: request.roomId,
              namespaceId: request.namespaceId,
              namespaceAccessRevision: inspected.namespaceAccessRevision,
              namespaceCurrentGeneration: current.namespaceKeyGeneration,
              namespaceHeadDigestBase64url:
                base64url(current.namespaceHeadDigest),
              domainId: current.domainId,
              domainKeyGeneration: current.domainKeyGeneration,
              domainAuthorizationRevision:
                current.domainAuthorizationRevision,
              domainHeadDigestBase64url: base64url(current.domainHeadDigest),
              namespaceBundleRevision: current.bundleRevision,
              namespaceBundleDigestBase64url:
                base64url(current.bundleDigest),
            } satisfies RoomHistoryDomainKeyV2Authority);
          } finally {
            snapshotFacts.audienceFingerprint.fill(0);
            inspected.namespaceHeadDigest.fill(0);
            inspected.namespacePublicationDigest.fill(0);
            inspected.namespacePublicationSetDigest.fill(0);
            inspected.namespaceAudienceFingerprint.fill(0);
            inspected.committerDeviceSigningPublicKey.fill(0);
            current.namespaceHeadDigest.fill(0);
            current.namespacePublicationDigest.fill(0);
            current.namespacePublicationSetDigest.fill(0);
            current.namespaceAudienceFingerprint.fill(0);
            current.domainHeadDigest.fill(0);
            current.bundleDigest.fill(0);
          }
        },
      });
    if (resolved === null) {
      return Object.freeze({ status: "unavailable" as const });
    }
    const after = await policy();
    if (
      after === null
      || after.mode !== before.mode
      || after.revision !== before.revision
    ) return Object.freeze({ status: "unavailable" as const });
    return Object.freeze({ status: "ready" as const, authority: resolved });
  };
}

/** Current Human-only Room and active recipient-device authority for M295. */
export function createCurrentHumanDomainKeyRoomHistoryAuthorityResolver(
  input: Readonly<{
    readonly product: PostgresJsBridgeConnection;
    readonly productAuthority: PostgresNamespaceProductAuthority;
    readonly domainKeys: PostgresDomainKeyAuthorityRepository;
  }>,
): ResolveRoomHistoryHumanPeerAuthority {
  const policy = async (): Promise<Readonly<{
    mode: string;
    revision: number;
  }> | null> => {
    const rows = await input.product.query(
      `/* m295_room_history_policy */
       SELECT mode, revision::int AS revision
         FROM encryption_transition_policy
        WHERE id = 'server'
        LIMIT 2`,
    );
    if (rows.length !== 1) return null;
    return Object.freeze({
      mode: text("Human-peer history policy mode", rows[0]!["mode"]),
      revision: counter(
        "Human-peer history policy revision",
        rows[0]!["revision"],
        1,
      ),
    });
  };

  return async (request) => {
    const before = await policy();
    if (before === null) return Object.freeze({ status: "unavailable" as const });
    if (before.mode === "plaintext_only") {
      return Object.freeze({ status: "disabled" as const });
    }
    if (before.mode !== "shadow_encryption" && before.mode !== "encrypted_only") {
      return Object.freeze({ status: "unavailable" as const });
    }
    const inspected = await input.productAuthority.withDetachedCurrentMessageHistoryRead({
      subjectUserId: request.subjectUserId,
      subjectHumanId: request.subjectHumanId,
      roomId: request.roomId,
      namespaceId: request.namespaceId,
      use: async (authority) => {
        const write = await input.domainKeys.inspectMessageReadAuthority({
          authority,
          deviceId: request.readerDeviceId,
          keyClass: "human",
        });
        if (write.status !== "ready") return null;
        const current = await input.domainKeys
          .inspectForegroundNamespaceAuthority({
            namespaceId: request.namespaceId,
            keyClass: "human",
          });
        if (current.status !== "ready") return null;
        if (
          write.namespaceAccessRevision !== current.namespaceAccessRevision
          || write.namespaceKeyGeneration !== current.namespaceKeyGeneration
          || !bytesEqual(write.namespaceHeadDigest, current.namespaceHeadDigest)
        ) {
          write.committerDeviceSigningPublicKey.fill(0);
          write.namespaceHeadDigest.fill(0);
          write.namespacePublicationDigest.fill(0);
          write.namespacePublicationSetDigest.fill(0);
          write.namespaceAudienceFingerprint.fill(0);
          current.namespaceHeadDigest.fill(0);
          current.namespacePublicationDigest.fill(0);
          current.namespacePublicationSetDigest.fill(0);
          current.namespaceAudienceFingerprint.fill(0);
          current.domainHeadDigest.fill(0);
          current.bundleDigest.fill(0);
          return null;
        }
        return Object.freeze({ write, current });
      },
    });
    if (inspected === null) {
      return Object.freeze({ status: "unavailable" as const });
    }
    try {
      const after = await policy();
      if (
        after === null
        || after.mode !== before.mode
        || after.revision !== before.revision
      ) return Object.freeze({ status: "unavailable" as const });
      return Object.freeze({
        status: "ready" as const,
        authority: Object.freeze({
          scheme: "domain_key_v2" as const,
          keyClass: "human" as const,
          subjectHumanId: inspected.write.subjectHumanId,
          readerDeviceId: inspected.write.committerDeviceId,
          readerDeviceSigningKeyGeneration:
            inspected.write.committerDeviceSigningKeyGeneration,
          hostAuthorizationRevision: inspected.write.committerDeviceRevision,
          policyRevision: before.revision,
          roomId: request.roomId,
          namespaceId: inspected.current.namespaceId,
          namespaceAccessRevision: inspected.current.namespaceAccessRevision,
          namespaceCurrentGeneration:
            inspected.current.namespaceKeyGeneration,
          namespaceHeadDigestBase64url:
            base64url(inspected.current.namespaceHeadDigest),
          domainId: inspected.current.domainId,
          domainKeyGeneration: inspected.current.domainKeyGeneration,
          domainAuthorizationRevision:
            inspected.current.domainAuthorizationRevision,
          domainHeadDigestBase64url:
            base64url(inspected.current.domainHeadDigest),
          namespaceBundleRevision: inspected.current.bundleRevision,
          namespaceBundleDigestBase64url:
            base64url(inspected.current.bundleDigest),
        } satisfies RoomHistoryDomainKeyV2Authority),
      });
    } finally {
      inspected.write.committerDeviceSigningPublicKey.fill(0);
      inspected.write.namespaceHeadDigest.fill(0);
      inspected.write.namespacePublicationDigest.fill(0);
      inspected.write.namespacePublicationSetDigest.fill(0);
      inspected.write.namespaceAudienceFingerprint.fill(0);
      inspected.current.namespaceHeadDigest.fill(0);
      inspected.current.namespacePublicationDigest.fill(0);
      inspected.current.namespacePublicationSetDigest.fill(0);
      inspected.current.namespaceAudienceFingerprint.fill(0);
      inspected.current.domainHeadDigest.fill(0);
      inspected.current.bundleDigest.fill(0);
    }
  };
}

export function createHumanEditedRepresentationAuthorityResolver(input: Readonly<{
  domainKeys: PostgresDomainKeyAuthorityRepository;
}>): ResolveRoomHistoryHumanEditedRepresentationAuthority {
  return async (request) => {
    const retained = await input.domainKeys.inspectRetainedNamespaceGenerationAuthority({
      namespaceId: request.namespaceId,
      keyClass: request.keyClass,
      generation: request.generation,
      accessRevision: request.accessRevision,
      subjectHumanId: request.subjectHumanId,
      readerDeviceId: request.readerDeviceId,
      committerHumanId: request.authorHumanId,
      committerDeviceId: request.committerDeviceId,
      committerHostAuthorizationRevision: request.committerHostAuthorizationRevision,
    });
    if (retained.status !== "ready") return Object.freeze({ status: "unavailable" as const });
    try {
      return Object.freeze({ status: "ready" as const,
        headDigestBase64url: base64url(retained.headDigest),
        committerDeviceSigningPublicKeyBase64url:
          base64url(retained.committerDeviceSigningPublicKey) });
    } finally {
      retained.headDigest.fill(0);
      retained.committerDeviceSigningPublicKey.fill(0);
    }
  };
}

export function createPostgresRoomHistoryShadowProjection(
  options: PostgresRoomHistoryShadowProjectionOptions,
): (input: Readonly<{
  readonly subjectUserId: string;
  readonly subjectHumanId: string;
  readonly readerDeviceId: string | null;
  readonly roomId: string;
  readonly selectedCoordinates: readonly RoomHistorySelectedCoordinate[];
  readonly representationMode?: "ordinary-and-protected" | "protected-only";
}>) => Promise<RoomHistoryShadowProjection> {
  assertVerifiedConversationProductPostgresHandle(options.product);
  if (typeof options.resolveAuthority !== "function") {
    throw new TypeError("Room history V2 authority resolver is required");
  }

  return async function project(input): Promise<RoomHistoryShadowProjection> {
    exactId("Room history subject User ID", input.subjectUserId);
    exactId("Room history subject Human ID", input.subjectHumanId);
    if (input.readerDeviceId !== null) {
      exactId("Room history reader device ID", input.readerDeviceId, PORTABLE_ID);
    }
    exactId("Room history Room ID", input.roomId);
    const selected = validateSelected(input.selectedCoordinates);
    if (selected.length === 0) {
      return Object.freeze({
        status: "ineligible" as const,
        selectedCount: 0,
        eligibleCount: 0,
      });
    }

    const protectedOnly = input.representationMode === "protected-only";
    const rows = await selectRoomRows(options.product, input.roomId, selected,
      protectedOnly ? "protected-only" : "ordinary-and-protected");
    if (rows.length !== selected.length) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "selection_changed" as const,
        selectedCount: selected.length,
        eligibleCount: 0,
      });
    }

    let namespaceId: string;
    const eligible: Array<Readonly<{
      coordinate: RoomHistorySelectedCoordinate;
      row: ConversationProductDatabaseRow;
    }>> = [];
    try {
      namespaceId = text(
        "Room history selected Namespace ID",
        rows[0]!["namespace_id"],
      );
      for (let ordinal = 0; ordinal < selected.length; ordinal += 1) {
        const coordinate = selected[ordinal]!;
        const row = rows[ordinal]!;
        if (
          counter("Room history selection ordinal", row["selection_ordinal"])
            !== ordinal
          || text("Room history selected Session ID", row["session_id"])
            !== coordinate.sessionId
          || counter("Room history selected Message ID", row["message_id"], 1)
            !== coordinate.messageId
          || counter("Room history selected edit revision", row["edit_revision"])
            !== coordinate.editRevision
          || text("Room history selected role", row["role"]) !== coordinate.role
          || text("Room history selected Room ID", row["room_id"])
            !== input.roomId
          || text("Room history selected Namespace ID", row["namespace_id"])
            !== namespaceId
        ) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "selection_changed" as const,
            selectedCount: selected.length,
            eligibleCount: 0,
          });
        }
        if (isEligible(row)) {
          eligible.push(Object.freeze({ coordinate, row }));
        }
      }
    } catch {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "selection_changed" as const,
        selectedCount: selected.length,
        eligibleCount: 0,
      });
    }
    if (eligible.length === 0) {
      return Object.freeze({
        status: "ineligible" as const,
        selectedCount: selected.length,
        eligibleCount: 0,
      });
    }
    if (input.readerDeviceId === null) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "current_read_authority_unavailable" as const,
        selectedCount: selected.length,
        eligibleCount: eligible.length,
      });
    }
    const readerDeviceId = input.readerDeviceId;

    const schemes = new Set(eligible.map(({ row }) => row["key_class"]));
    if (schemes.size !== 1) {
      const groups = await Promise.all([...schemes].map((scheme) => project({
        ...input,
        selectedCoordinates: eligible.filter(({ row }) => row["key_class"] === scheme)
          .map(({ coordinate }) => coordinate),
      })));
      const ready = groups.filter((group) => group.status === "ready");
      if (ready.length === 0) return Object.freeze({
        status: "unavailable" as const, reason: "current_read_authority_unavailable" as const,
        selectedCount: selected.length, eligibleCount: eligible.length,
      });
      const records = new Map(ready.flatMap((group) => group.records).map((record) => [
        `${record.coordinate.sessionId}:${record.coordinate.messageId}:${record.coordinate.editRevision}`, record,
      ]));
      return Object.freeze({ status: "ready" as const, authority: ready[0]!.authority,
        authorities: Object.freeze(ready.map((group) => group.authority)),
        selectedCount: selected.length, eligibleCount: eligible.length,
        records: Object.freeze(selected.flatMap((coordinate) => {
          const record = records.get(`${coordinate.sessionId}:${coordinate.messageId}:${coordinate.editRevision}`);
          return record === undefined ? [] : [record];
        })), signerEvidence: Object.freeze(ready.flatMap((group) => group.signerEvidence)),
        terminalExecutions: Object.freeze(ready.flatMap((group) => group.terminalExecutions)),
      });
    }
    const keyClass = schemes.has("human") ? "human" as const : "ai" as const;

    const resolution = await (keyClass === "human"
      ? options.resolveHumanPeerAuthority?.({
        ...input,
        readerDeviceId,
        namespaceId,
        selectedCoordinates: selected,
      }) ?? Promise.resolve({ status: "unavailable" as const })
      : options.resolveAuthority({
      ...input,
      readerDeviceId,
      namespaceId,
      selectedCoordinates: selected,
      }));
    if (resolution.status === "disabled") {
      return Object.freeze({
        status: "disabled" as const,
        selectedCount: selected.length,
        eligibleCount: eligible.length,
      });
    }
    if (resolution.status !== "ready") {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "current_read_authority_unavailable" as const,
        selectedCount: selected.length,
        eligibleCount: eligible.length,
      });
    }
    const authority = validateDomainKeyV2Authority(resolution.authority, {
      ...input,
      readerDeviceId,
      keyClass,
    });
    if (authority === null || authority.namespaceId !== namespaceId) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "current_read_authority_unavailable" as const,
        selectedCount: selected.length,
        eligibleCount: eligible.length,
      });
    }

    try {
      for (let index = 0; index < eligible.length; index += 1) {
        const entry = eligible[index]!;
        eligible[index] = isHumanEditedRepresentation(entry.row)
          ? entry : { ...entry, row: withSharedProvenance(entry.row) };
      }
    } catch {
      return { status: "unavailable", reason: "projection_corrupt",
        selectedCount: selected.length, eligibleCount: eligible.length };
    }

    const operationIds = keyClass === "ai" && !protectedOnly
      ? [...new Set(eligible.filter(({ row }) => !isExistingRepresentation(row)
        && typeof row["content"] === "string")
        .map(({ row }) => operationIdFor(row)))].sort()
      : [];
    const transcriptRows = operationIds.length === 0
      ? []
      : await selectCompleteShadowOperations(options.product, operationIds);
    const transcripts = new Map<string, ConversationProductDatabaseRow[]>();
    for (const row of transcriptRows) {
      const operationId = text(
        "Room history transcript operation ID",
        row["shadow_operation_id"],
      );
      const group = transcripts.get(operationId) ?? [];
      group.push(row);
      transcripts.set(operationId, group);
    }

    const records: RoomHistoryShadowProjectionRecord[] = [];
    try {
      for (const { coordinate, row } of eligible) {
        if (isHumanEditedRepresentation(row)) {
          const dto = await projectConversationProtectedMessageDtoV2(
            row, { sessionId: coordinate.sessionId, roomId: input.roomId, namespaceId }, options.crypto,
          );
          const payload = dto.protectedPayload;
          const expectedId = text("Edited Human crypto object ID", row["crypto_object_id"]);
          parseHumanMessageEditCryptoObjectIdV1(expectedId, {
            sessionId: coordinate.sessionId,
            messageId: coordinate.messageId,
            revision: coordinate.editRevision,
          });
          if (payload.status !== "encrypted" || payload.keyClass !== row["key_class"]
            || payload.cryptoObjectId !== expectedId) {
            throw new TypeError("Edited Human protected representation is invalid");
          }
          const manifestBytes = Buffer.from(payload.accessManifestBytesBase64url, "base64url");
          const envelopeBytes = Buffer.from(payload.namespaceEnvelopeBytesBase64url, "base64url");
          const manifest = decodeObjectAccessManifestV2OrV3(manifestBytes);
          const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
          try {
            if (manifest.formatVersion !== 2 || manifest.objectId !== expectedId
              || envelope.context.objectId !== expectedId
              || envelope.context.namespaceId !== namespaceId
              || envelope.context.keyClass !== row["key_class"]
              || manifest.accessRevision !== 0) {
              throw new TypeError("Edited Human protected coordinates disagree");
            }
            const authorHumanId = text("Edited Human author", row["source_human_id"]);
            const resolved = await options.resolveHumanEditedRepresentationAuthority?.({
              subjectHumanId: input.subjectHumanId, readerDeviceId, namespaceId,
              keyClass: row["key_class"] as "ai" | "human",
              generation: envelope.context.keyGeneration,
              accessRevision: envelope.context.bindingRevisionAtWrap,
              authorHumanId, committerDeviceId: manifest.committerDeviceId,
              committerHostAuthorizationRevision: manifest.hostAuthorizationRevision,
            });
            if (resolved?.status !== "ready") {
              throw new TypeError("Edited Human retained authority unavailable");
            }
            records.push(Object.freeze({
              kind: "human_edited_representation" as const, coordinate,
              protectedMessage: dto, authorHumanId,
              ...(!protectedOnly && typeof row["content"] === "string"
                ? { representationMode: "ordinary-and-protected" as const,
                    ordinaryPayloadBytesBase64url: Buffer.from(
                    encodeLiveShadowOrdinaryPayloadV2(row, null),
                  ).toString("base64url") }
                : { representationMode: "protected-only" as const,
                    selectedSource: selectedProjectionSource(row, coordinate) }),
              committerDeviceSigningPublicKeyBase64url:
                resolved.committerDeviceSigningPublicKeyBase64url,
              retainedGeneration: Object.freeze({
                namespaceGeneration: envelope.context.keyGeneration,
                accessRevision: envelope.context.bindingRevisionAtWrap,
                headDigestBase64url: resolved.headDigestBase64url,
                publicationDigestBase64url: resolved.headDigestBase64url,
                publicationSetDigestBase64url: resolved.headDigestBase64url,
                audienceFingerprintBase64url: resolved.headDigestBase64url,
              }),
            }));
          } finally {
            manifestBytes.fill(0);
            envelopeBytes.fill(0);
            envelope.wrappedDek.fill(0);
          }
          continue;
        }
        if (isExistingRepresentation(row)) {
          records.push(await projectExistingRepresentation(
            options, coordinate, row, input.roomId, namespaceId,
            protectedOnly || row["content"] == null,
            { subjectHumanId: input.subjectHumanId, readerDeviceId },
          ));
          continue;
        }
        const shadowOperationId = operationIdFor(row);
        exactId("Room history Shadow operation ID", shadowOperationId, PORTABLE_ID);
        const shadowTranscriptOrdinal = counter(
          "Room history Shadow transcript ordinal",
          row["shadow_transcript_ordinal"],
          1,
        );
        const needsOrdinary = !protectedOnly && typeof row["content"] === "string";
        const transcript = needsOrdinary ? transcripts.get(shadowOperationId) : undefined;
        // createLiveShadowAgentTurnSession always starts output reservations
        // at 2, including multi-input shared executions. Their Human inputs
        // retain separate operation IDs/input ordinals and are not output rows.
        const firstTranscriptOrdinal = operationFamily(row) === "shared_execution" ? 2 : 1;
        if (needsOrdinary && keyClass === "ai" && (
          transcript === undefined
          || transcript.length < 1
          || transcript.some((entry, index) =>
            counter(
              "Room history complete transcript ordinal",
              entry["shadow_transcript_ordinal"],
              1,
            ) !== index + firstTranscriptOrdinal
          )
        )) throw new TypeError("Room history complete transcript is invalid");
        const sharedResumeCallId = needsOrdinary
          && operationFamily(row) === "shared_execution"
          && row["execution_kind"] === "resume"
          && row["role"] === "tool"
          ? await resolveSharedResumeToolResultCallId(
              options.product,
              row,
              shadowTranscriptOrdinal,
            )
          : null;
        const callIds = sharedResumeCallId !== null || transcript === undefined
          ? new Map<number, string>()
          : resolveLiveShadowToolResultCallIds(transcript);
        const ordinary = needsOrdinary ? encodeLiveShadowOrdinaryPayloadV2(
          row,
          // The pairing helper keys by one-based row position, not persisted
          // transcript ordinal; shared execution output rows start at 2.
          sharedResumeCallId
            ?? callIds.get(shadowTranscriptOrdinal - firstTranscriptOrdinal + 1)
            ?? null,
        ) : null;
        const dto = await projectConversationProtectedMessageDtoV2(
          row,
          {
            sessionId: coordinate.sessionId,
            roomId: input.roomId,
            namespaceId: authority.namespaceId,
          },
          options.crypto,
        );
        if (dto.projection.logicalMessageKey !== coordinate.logicalMessageKey) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "selection_changed" as const,
            selectedCount: selected.length,
            eligibleCount: eligible.length,
          });
        }
        try {
          if (
            text("Room history turn Room ID", row["turn_room_id"])
              !== input.roomId
            || text("Room history turn Namespace ID", row["turn_namespace_id"])
              !== namespaceId
          ) throw new TypeError("Room history turn authority is substituted");
          records.push(Object.freeze({
            coordinate,
            shadowOperationId,
            ...(operationFamily(row) === "shared_human" || operationFamily(row) === "shared_execution"
              ? { shadowOperationFamily: operationFamily(row) as "shared_human" | "shared_execution" }
              : {}),
            shadowTranscriptOrdinal,
            ...(ordinary === null ? {
              representationMode: "protected-only" as const,
              selectedSource: selectedProjectionSource(row, coordinate),
            }
              : { ordinaryPayloadBytesBase64url: Buffer.from(ordinary).toString("base64url") }),
            retainedGeneration: Object.freeze({
              namespaceGeneration: counter(
                "Room history Namespace generation",
                row["namespace_generation"],
              ),
              accessRevision: counter(
                "Room history Namespace access revision",
                row["turn_namespace_access_revision"],
              ),
              headDigestBase64url: base64url(
                byteField(row, "namespace_head_digest"),
              ),
              publicationDigestBase64url: base64url(
                byteField(row, "namespace_publication_digest"),
              ),
              publicationSetDigestBase64url: base64url(
                byteField(row, "namespace_publication_set_digest"),
              ),
              audienceFingerprintBase64url: base64url(
                byteField(row, "namespace_audience_fingerprint"),
              ),
            }),
            protectedMessage: dto,
          }));
        } finally {
          ordinary?.fill(0);
        }
      }
    } catch {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "projection_corrupt" as const,
        selectedCount: input.selectedCoordinates.length,
        eligibleCount: eligible.length,
      });
    }

    const signerOperations = [...new Map(eligible
      .filter(({ row }) => !isExistingRepresentation(row)
        && !isHumanEditedRepresentation(row)
        && (row["role"] === "assistant" || row["role"] === "tool"
          || operationFamily(row) === "shared_human"))
      .map(({ row }) => {
        const operationId = operationIdFor(row);
        return [operationId, row] as const;
      })).entries()].sort(([left], [right]) => left.localeCompare(right));
    const signerEvidence: RoomHistorySignerEvidenceTransportV1[] = [];
    const legacySignerKeys = new Set<string>();
    for (const [operationId, row] of signerOperations) {
      if (operationFamily(row) === "shared_human") {
        const planBytes = row["plan_bytes"];
        const requestBytes = row["human_request_bytes"];
        const requestDigest = row["human_request_digest"];
        if (!(planBytes instanceof Uint8Array)
          || !(requestBytes instanceof Uint8Array)
          || !(requestDigest instanceof Uint8Array)
          || requestDigest.length !== 32
          || !bytesEqual(sha256(requestBytes), requestDigest)) {
          throw new TypeError("Shared Human history signing evidence is invalid");
        }
        let humanPlan;
        try {
          humanPlan = decodeHumanAiReadableLiveShadowMessagePlan(planBytes);
        } catch {
          return Object.freeze({
            status: "unavailable" as const, reason: "projection_corrupt" as const,
            selectedCount: input.selectedCoordinates.length, eligibleCount: eligible.length,
          });
        }
        let humanRequest;
        try {
          humanRequest = decodeHumanAiReadableLiveShadowMessageRequest(requestBytes);
        } catch {
          return Object.freeze({ status: "unavailable" as const,
            reason: "projection_corrupt" as const,
            selectedCount: selected.length, eligibleCount: eligible.length });
        }
        const coordinatesMatch = humanRequest.operationId === operationId
          && humanPlan.operationId === operationId
          && bytesEqual(sha256(planBytes), humanRequest.planDigest)
          && humanPlan.formatVersion === humanRequest.formatVersion
          && humanRequest.namespaceId === namespaceId
          && humanRequest.roomId === input.roomId
          && humanRequest.subjectHumanId === row["source_human_id"]
          && humanRequest.sessionId === row["session_id"]
          && humanRequest.messageId === Number(row["message_id"])
          && humanRequest.revision === Number(row["edit_revision"])
          && humanPlan.subjectHumanId === humanRequest.subjectHumanId
          && humanPlan.committerDeviceId === humanRequest.committerDeviceId
          && humanPlan.committerDeviceSigningKeyGeneration === humanRequest.committerDeviceSigningKeyGeneration
          && humanPlan.hostAuthorizationRevision === humanRequest.hostAuthorizationRevision
          && humanPlan.roomId === humanRequest.roomId
          && humanPlan.sessionId === humanRequest.sessionId
          && humanPlan.humanMessageId === humanRequest.messageId
          && humanPlan.namespaceId === humanRequest.namespaceId
          && humanPlan.namespaceAccessRevision === humanRequest.namespaceAccessRevision
          && humanPlan.namespaceKeyGeneration === humanRequest.namespaceKeyGeneration
          && humanPlan.transcriptOrdinal === humanRequest.transcriptOrdinal;
        let signer: Awaited<ReturnType<ResolveRoomHistoryHumanEditedRepresentationAuthority>> | undefined;
        try {
          if (!coordinatesMatch) return Object.freeze({ status: "unavailable" as const,
            reason: "projection_corrupt" as const,
            selectedCount: selected.length, eligibleCount: eligible.length });
          signer = await options.resolveHumanEditedRepresentationAuthority?.({
            subjectHumanId: input.subjectHumanId,
            readerDeviceId,
            namespaceId,
            keyClass: "ai",
            generation: humanRequest.namespaceKeyGeneration,
            accessRevision: humanRequest.namespaceAccessRevision,
            authorHumanId: humanRequest.subjectHumanId,
            committerDeviceId: humanRequest.committerDeviceId,
            committerHostAuthorizationRevision: humanRequest.hostAuthorizationRevision,
          });
          if (signer?.status === "ready"
            && signer.headDigestBase64url !== base64url(humanRequest.namespaceHeadDigest)) {
            signer = undefined;
          }
        } finally {
          for (const value of Object.values(humanRequest)) {
            if (value instanceof Uint8Array) value.fill(0);
          }
        }
        const kind = humanPlan.formatVersion === 2
          ? "human_ai_readable_live_shadow_request_v2" as const
          : "human_ai_readable_live_shadow_request_v1" as const;
        humanPlan.namespaceHeadDigest.fill(0);
        humanPlan.namespacePublicationDigest.fill(0);
        humanPlan.namespacePublicationSetDigest.fill(0);
        humanPlan.namespaceAudienceFingerprint.fill(0);
        signerEvidence.push(Object.freeze({
          kind,
          operationId,
          ...(signer?.status === "ready" ? {
            committerDeviceSigningPublicKeyBase64url:
              signer.committerDeviceSigningPublicKeyBase64url,
          } : {}),
          planBytesBase64url: Buffer.from(planBytes).toString("base64url"),
          requestBytesBase64url: Buffer.from(requestBytes).toString("base64url"),
          requestDigestBase64url: Buffer.from(requestDigest).toString("base64url"),
        }));
        continue;
      }
      if (operationFamily(row) === "shared_execution") {
        signerEvidence.push({ kind: "shared_agent_execution_plan_v4", operationId,
          planBytesBase64url: Buffer.from(row["execution_plan_bytes"] as Uint8Array).toString("base64url"),
          planDigestBase64url: base64url(row["execution_plan_digest"] as Uint8Array),
        });
        continue;
      }
      const planBytes = row["plan_bytes"];
      const requestBytes = row["human_request_bytes"];
      const requestDigest = row["human_request_digest"];
      if (
        planBytes instanceof Uint8Array
        && planBytes.length > 0
        && planBytes.length <= MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V4
        && requestBytes instanceof Uint8Array
        && requestBytes.length > 0
        && requestBytes.length
          <= MAX_HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_WIRE_BYTES_V4
        && requestDigest instanceof Uint8Array
        && requestDigest.length === 32
        && bytesEqual(sha256(requestBytes), requestDigest)
      ) {
        let kind: RoomHistorySignerEvidenceTransportV1["kind"] =
          "human_live_shadow_request_v3";
        try {
          const foreground = decodeLiveShadowMessagePlanV4(planBytes);
          kind = "human_live_shadow_request_v4";
          foreground.agentSignerPublicKey.fill(0);
          foreground.namespaceHeadDigest.fill(0);
          foreground.namespacePublicationDigest.fill(0);
          foreground.namespacePublicationSetDigest.fill(0);
          foreground.namespaceAudienceFingerprint.fill(0);
          foreground.grantDomainParticipantDigest.fill(0);
          foreground.grantDomainHeadDigest.fill(0);
          foreground.grantDomainPublicationDigest.fill(0);
          foreground.namespaceBundleDigest.fill(0);
          if (foreground.authorization.disposition === "authorization_required") {
            foreground.authorization.authorizationPlanBytes.fill(0);
            foreground.authorization.authorizationPlanDigest.fill(0);
            foreground.authorization.recipientPublicKey.fill(0);
          } else {
            foreground.authorization.authorizationDigest.fill(0);
          }
        } catch {
          // Existing V3 evidence remains byte-identical.
        }
        signerEvidence.push(Object.freeze({
          kind,
          operationId,
          planBytesBase64url: Buffer.from(planBytes).toString("base64url"),
          requestBytesBase64url: Buffer.from(requestBytes).toString("base64url"),
          requestDigestBase64url: Buffer.from(requestDigest).toString("base64url"),
        }));
      } else {
        legacySignerKeys.add(text(
          "Room history Agent signer key ID",
          row["agent_signer_key_id"],
        ));
      }
    }
    const signerKeys = [...legacySignerKeys].sort();
    if (signerKeys.length > 0 && options.restricted !== undefined) {
      const evidenceRows = await options.restricted.query(
        `/* m275_room_history_agent_signer_evidence */
         SELECT signer_key_id, publication_bytes
           FROM agent_crypto_runtime_signers
          WHERE signer_key_id = ANY($1::text[])
          ORDER BY signer_key_id`,
        [signerKeys],
      );
      signerEvidence.push(...evidenceRows.filter((row, index) =>
        row["signer_key_id"] === signerKeys[index]
        && row["publication_bytes"] instanceof Uint8Array
        && row["publication_bytes"].length > 0
      ).map((row) => Object.freeze({
        kind: "agent_runtime_publication" as const,
        evidenceBytesBase64url: Buffer.from(
          row["publication_bytes"] as Uint8Array,
        ).toString("base64url"),
      })));
    }
    if (keyClass === "human" && options.restricted !== undefined) {
      const humanOperations = [...new Map(eligible
        .filter(({ row }) => !isHumanEditedRepresentation(row) && !isExistingRepresentation(row))
        .map(({ row }) => [
        operationIdFor(row),
        row,
      ] as const)).entries()].sort(([left], [right]) =>
        left.localeCompare(right)
      );
      const devices = humanOperations.map(([, row]) => Object.freeze({
        device_id: text(
          "Room history Human-peer sender device ID",
          row["human_peer_committer_device_id"],
        ),
        device_generation: counter(
          "Room history Human-peer sender device generation",
          row["human_peer_committer_device_signing_key_generation"],
          1,
        ),
      }));
      const deviceRows = await options.restricted.query(
        `/* m295_room_history_human_peer_signer_evidence */
         WITH requested AS (
           SELECT device_id, device_generation::int
             FROM jsonb_to_recordset($1::jsonb)
               AS evidence(device_id text, device_generation int)
         )
         SELECT device.device_id, device.device_generation::int,
                device.signing_public_key
           FROM human_crypto_devices device
           JOIN requested
             ON requested.device_id = device.device_id
            AND requested.device_generation = device.device_generation
          ORDER BY device.device_id, device.device_generation`,
        [JSON.stringify(devices)],
      );
      const keys = new Map(deviceRows.flatMap((row) => {
        try {
          const deviceId = text(
            "Room history Human-peer evidence device ID",
            row["device_id"],
          );
          const generation = counter(
            "Room history Human-peer evidence device generation",
            row["device_generation"],
            1,
          );
          const publicKey = row["signing_public_key"];
          return publicKey instanceof Uint8Array && publicKey.length === 32
            ? [[`${deviceId}\0${generation}`, publicKey] as const]
            : [];
        } catch {
          return [];
        }
      }));
      for (const [operationId, row] of humanOperations) {
        const planBytes = row["plan_bytes"];
        const requestBytes = row["human_request_bytes"];
        const requestDigest = row["human_request_digest"];
        const senderDeviceId = text(
          "Room history Human-peer sender device ID",
          row["human_peer_committer_device_id"],
        );
        const senderDeviceSigningKeyGeneration = counter(
          "Room history Human-peer sender device generation",
          row["human_peer_committer_device_signing_key_generation"],
          1,
        );
        const publicKey = keys.get(
          `${senderDeviceId}\0${senderDeviceSigningKeyGeneration}`,
        );
        if (
          planBytes instanceof Uint8Array
          && planBytes.length > 0
          && planBytes.length <= 262_144
          && requestBytes instanceof Uint8Array
          && requestBytes.length > 0
          && requestBytes.length <= 524_288
          && requestDigest instanceof Uint8Array
          && requestDigest.length === 32
          && bytesEqual(sha256(requestBytes), requestDigest)
          && publicKey !== undefined
        ) {
          signerEvidence.push(Object.freeze({
            kind: "human_peer_live_shadow_request_v1" as const,
            operationId,
            planBytesBase64url: Buffer.from(planBytes).toString("base64url"),
            requestBytesBase64url:
              Buffer.from(requestBytes).toString("base64url"),
            requestDigestBase64url:
              Buffer.from(requestDigest).toString("base64url"),
            senderDeviceId,
            senderDeviceSigningKeyGeneration,
            senderDeviceSigningPublicKeyBase64url:
              Buffer.from(publicKey).toString("base64url"),
          }));
        }
      }
    }
    let terminalExecutions: readonly RoomHistoryTerminalExecutionSummary[];
    try {
      terminalExecutions = await (
        options.resolveTerminalExecutions
          ?? ((request) => selectRoomHistoryTerminalExecutions(options.product, request))
      )({ roomId: input.roomId, selectedCoordinates: selected });
    } catch {
      // Terminal summaries are additive lifecycle presentation. A failed
      // summary read must not quarantine or hide otherwise valid mapped output.
      terminalExecutions = Object.freeze([]);
    }
    return Object.freeze({
      status: "ready" as const,
      authority,
      selectedCount: selected.length,
      eligibleCount: records.length,
      records: Object.freeze(records),
      signerEvidence: Object.freeze(signerEvidence),
      terminalExecutions: Object.freeze([...terminalExecutions]),
    });
  };
}
