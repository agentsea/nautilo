import {
  decryptObjectThroughNamespace,
  accessRevision,
  objectId,
  verifyDomainCompressedHumanLiveShadowMessageRequestExactReplay,
  verifyHumanAiReadableLiveShadowMessageRequestExactReplay,
  verifyForegroundSessionHumanLiveShadowMessageRequestExactReplay,
  verifyAgentObjectAccessManifest,
  verifyObjectAccessManifestChain,
  type LatticeCrypto,
  decodeHumanAiReadableLiveShadowMessagePlan,
  decodeHumanAiReadableLiveShadowMessageRequest,
} from "@nautilo/lattice-crypto";
import {
  decodeHumanLiveShadowMessageRequestV3,
  decodeLiveShadowMessagePlanV3,
  decodeHumanLiveShadowMessageRequestV4,
  decodeLiveShadowMessagePlanV4,
  encodeLiveShadowMessagePlanV4,
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV2OrV3,
  agentRuntimeObjectSignerKeyIdV1,
  parseHumanMessageEditCryptoObjectIdV1,
} from "@nautilo/lattice-crypto/wire";

import {
  ingestObjectAccessSignerEvidenceV4,
  type ObjectAccessSignerEvidenceTransportV1,
} from "../../client-vault/ingest-object-access-signer-evidence-v4.ts";
import {
  authenticateClientDeviceProfileV4,
  destroyOpenedClientDeviceProfileV4,
  withClientObjectAccessSignerResolversV4,
} from "../../client-vault/profile-v4.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../../client-vault/types.ts";
import { admitHumanPeerLiveShadowMessageExactReplay } from
  "../../message/human-peer-live-shadow-message-admission.ts";
import {
  decodeMessagePayloadV2,
  encodeMessagePayloadV2,
  type MessagePayloadV2,
} from "../../message/message-payload-v2.ts";
import type {
  RetainedRoomAuthorityClient,
  RetainedRoomReadPlan,
  RetainedRoomNamespaceGeneration,
} from "./namespace-authority-client.ts";
import type { NamespaceAuthorityClient } from
  "./namespace-authority-client.ts";
import { deriveLiveShadowMessageCryptoObjectIdV1, deriveMessageCryptoObjectIdV2,
  CONVERSATION_MESSAGE_OBJECT_TYPE } from
  "../../message/conversation-repository.ts";
import type { ExistingMessageRepairEvidence, ExistingMessageRetainedGeneration } from
  "../../message/existing-message-repair-evidence.ts";

const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const MAX_HISTORY_ROWS = 50;
const CUSTODY_UNAVAILABLE = "client_custody_unavailable" as const;

export type RoomHistoryShadowFallbackReasonV1 =
  | "client_crypto_unavailable"
  | "client_custody_unavailable"
  | "current_read_authority_unavailable"
  | "retained_key_material_unavailable"
  | "signer_evidence_unavailable"
  | "live_shadow_lifecycle_unavailable"
  | "integrity_failure"
  | "parity_mismatch";

export type ConversationProtectedMessageClientDtoV2 = Readonly<{
  dtoVersion: 2;
  projection: Readonly<{
    messageId: string;
    logicalMessageKey?: string;
    sessionId: string;
    roomId: string;
    namespaceId: string;
    role: "user" | "assistant" | "tool" | "system";
    createdAt: string;
    editedAt?: string | null;
    editRevision: number;
    replyToMessageId?: string | null;
    subthreadRoomId?: string | null;
    replyCount?: number;
    lastReplyAt?: string | null;
    summaryRevision?: number;
    sourceUserId?: string;
    authorAgentId?: string;
  }>;
  protectedPayload:
    | Readonly<{
      status: "encrypted";
      cryptoObjectId: string;
      payloadVersion: 2;
      keyClass: "ai" | "human";
      encryptedPayloadBytesBase64url: string;
      accessManifestBytesBase64url: string;
      namespaceEnvelopeBytesBase64url: string;
    }>
    | Readonly<{
      status: "pending";
      reason: "shadow_pending" | "backfill_pending";
    }>
    | Readonly<{
      status: "unavailable";
      reason:
        | "missing_grant"
        | "stale_grant"
        | "unauthorized"
        | "removed"
        | "unsupported_version"
        | "corrupt"
        | "lost_key_material";
      cryptoObjectId?: string;
    }>;
}>;

export interface RoomHistoryShadowDomainKeyAuthorityTransportV2 {
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
}

export type RoomHistoryShadowAuthorityTransportV1 =
  RoomHistoryShadowDomainKeyAuthorityTransportV2;

interface RoomHistorySelectedSource {
  readonly logicalMessageKey?: string;
  readonly sourceUserId?: string;
  readonly authorAgentId?: string;
  readonly role: MessagePayloadV2["role"];
}
type RoomHistoryOrdinarySibling = Omit<RoomHistorySelectedSource, "role"> & Readonly<{
  readonly payload: MessagePayloadV2;
}>;
type RoomHistoryReadRepresentation =
  | Readonly<{ representationMode?: "ordinary-and-protected";
    ordinaryPayloadBytesBase64url: string; ordinarySibling: RoomHistoryOrdinarySibling }>
  | Readonly<{ representationMode: "protected-only"; selectedSource: RoomHistorySelectedSource;
    ordinaryPayloadBytesBase64url?: never; ordinarySibling?: never }>;

interface RoomHistoryLiveRecordCoordinates {
  readonly kind?: "live_shadow";
  readonly sessionId: string;
  readonly messageId: string;
  readonly editRevision: number;
  readonly shadowOperationId: string;
  readonly shadowOperationFamily?: "shared_human" | "shared_execution";
  readonly shadowTranscriptOrdinal: number;
  readonly namespaceGeneration: number;
  readonly namespaceAccessRevision: number;
  readonly namespaceHeadDigestBase64url: string;
  readonly namespacePublicationDigestBase64url: string;
  readonly namespacePublicationSetDigestBase64url: string;
  readonly namespaceAudienceFingerprintBase64url: string;
  readonly protectedMessage: ConversationProtectedMessageClientDtoV2;
}
export type RoomHistoryLiveShadowRecordTransportV1 = RoomHistoryLiveRecordCoordinates
  & RoomHistoryReadRepresentation;

interface RoomHistoryExistingRepresentationCoordinates {
  readonly kind: "existing_representation";
  readonly sessionId: string;
  readonly messageId: string;
  readonly editRevision: number;
  readonly protectedMessage: ConversationProtectedMessageClientDtoV2;
  /** Server-retained publication receipt, never original-author signed proof. */
  readonly repair: ExistingMessageRepairEvidence;
  readonly retainedGeneration?: ExistingMessageRetainedGeneration;
}
export type RoomHistoryExistingRepresentationRecordTransportV1 =
  RoomHistoryExistingRepresentationCoordinates & (
    | Readonly<{
      representationMode?: "ordinary-and-protected";
      ordinarySibling: RoomHistoryOrdinarySibling;
      ordinaryPayloadBytesBase64url?: string;
      selectedSource?: never;
    }>
    | Readonly<{
      representationMode: "protected-only";
      selectedSource: RoomHistorySelectedSource;
      ordinarySibling?: never;
      ordinaryPayloadBytesBase64url?: never;
    }>
  );

type RoomHistoryHumanEditedRepresentationCoordinates = Readonly<{
  kind: "human_edited_representation";
  sessionId: string;
  messageId: string;
  editRevision: number;
  authorHumanId: string;
  committerDeviceSigningPublicKeyBase64url: string;
  namespaceGeneration: number;
  namespaceAccessRevision: number;
  namespaceHeadDigestBase64url: string;
  namespacePublicationDigestBase64url: string;
  namespacePublicationSetDigestBase64url: string;
  namespaceAudienceFingerprintBase64url: string;
  protectedMessage: ConversationProtectedMessageClientDtoV2;
}>;
export type RoomHistoryHumanEditedRepresentationRecordTransportV1 =
  RoomHistoryHumanEditedRepresentationCoordinates & (
    | Readonly<{ representationMode: "protected-only";
        selectedSource: RoomHistorySelectedSource;
        ordinaryPayloadBytesBase64url?: never; ordinarySibling?: never }>
    | Readonly<{ representationMode: "ordinary-and-protected";
        ordinaryPayloadBytesBase64url: string;
        ordinarySibling: RoomHistoryOrdinarySibling; selectedSource?: never }>
  );

export type RoomHistoryShadowRecordTransportV1 =
  | RoomHistoryLiveShadowRecordTransportV1
  | RoomHistoryExistingRepresentationRecordTransportV1
  | RoomHistoryHumanEditedRepresentationRecordTransportV1;

export type RoomHistoryShadowSignerEvidenceTransportV1 =
  | ObjectAccessSignerEvidenceTransportV1
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
    /** Accepted server execution authority, not a portable Human signature. */
    readonly kind: "shared_agent_execution_plan_v4";
    readonly operationId: string;
    readonly planBytesBase64url: string;
    readonly planDigestBase64url: string;
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

export interface VaultRoomHistoryShadowReadInputV1 {
  readonly sourceRoomId: string;
  readonly authority: RoomHistoryShadowAuthorityTransportV1;
  readonly authorities?: readonly RoomHistoryShadowAuthorityTransportV1[];
  readonly signerEvidence: readonly RoomHistoryShadowSignerEvidenceTransportV1[];
  readonly records: readonly RoomHistoryShadowRecordTransportV1[];
  readonly signal?: AbortSignal;
}

export type VaultRoomHistoryShadowRecordResultV1 =
  | Readonly<{
    sessionId: string;
    messageId: string;
    editRevision: number;
    status: "verified";
    verification:
      | "independent_parity"
      | "signed_representation_authenticated";
    payload: MessagePayloadV2;
  }>
  | Readonly<{
    sessionId: string;
    messageId: string;
    editRevision: number;
    status: "fallback";
    reason: RoomHistoryShadowFallbackReasonV1;
  }>;

export interface VaultRoomHistoryShadowReadResultV1 {
  readonly records: readonly VaultRoomHistoryShadowRecordResultV1[];
  readonly eligibleCount: number;
  readonly verifiedCount: number;
  readonly fallbackCounts: Readonly<
    Partial<Record<RoomHistoryShadowFallbackReasonV1, number>>
  >;
}

export interface VaultRoomHistoryShadowMessageReader {
  reconcile(
    input: VaultRoomHistoryShadowReadInputV1,
  ): Promise<VaultRoomHistoryShadowReadResultV1>;
}

export type RoomHistoryVerificationDiagnostic = Readonly<{
  operation: "human_edited_history";
  stage: "structural_selection" | "structural_coordinates" | "object_identity" | "encoding" | "protected_coordinates" | "manifest" | "generation" | "decrypt" | "payload";
  errorName: "type_error" | "range_error" | "error" | "unknown";
}>;

function diagnosticErrorName(error: unknown): RoomHistoryVerificationDiagnostic["errorName"] {
  if (error instanceof TypeError) return "type_error";
  if (error instanceof RangeError) return "range_error";
  if (error instanceof Error) return "error";
  return "unknown";
}

type ResolveTrustedDeviceSigningPublicKey = (input: Readonly<{
  deviceId: string;
  hostAuthorizationRevision: number;
  trustedDeviceRevision: number;
}>) => Promise<Uint8Array | null>;

function fromBase64url(label: string, value: string): Uint8Array {
  if (
    typeof value !== "string"
    || value.length < 1
    || !BASE64URL.test(value)
    || value.length % 4 === 1
  ) throw new TypeError(`${label} is not canonical base64url`);
  const bytes = Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")
      + "=".repeat((4 - value.length % 4) % 4)),
    (character) => character.charCodeAt(0),
  );
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const canonical = btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
  if (canonical !== value) {
    bytes.fill(0);
    throw new TypeError(`${label} is not canonical base64url`);
  }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function toBase64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-")
    .replaceAll("/", "_").replace(/=+$/u, "");
}

function wipe(values: readonly (Uint8Array | null | undefined)[]): void {
  values.forEach((value) => value?.fill(0));
}

function wipeOwnedByteFields(value: object): void {
  for (const field of Object.values(value as Record<string, unknown>)) {
    if (field instanceof Uint8Array) field.fill(0);
  }
}

function fallback(
  record: RoomHistoryShadowRecordTransportV1,
  reason: RoomHistoryShadowFallbackReasonV1,
): VaultRoomHistoryShadowRecordResultV1 {
  return Object.freeze({
    sessionId: record.sessionId,
    messageId: record.messageId,
    editRevision: record.editRevision,
    status: "fallback" as const,
    reason,
  });
}

function allFallback(
  records: readonly RoomHistoryShadowRecordTransportV1[],
  reason: RoomHistoryShadowFallbackReasonV1,
): readonly VaultRoomHistoryShadowRecordResultV1[] {
  return Object.freeze(records.map((record) => fallback(record, reason)));
}

function finish(
  records: readonly VaultRoomHistoryShadowRecordResultV1[],
): VaultRoomHistoryShadowReadResultV1 {
  const fallbackCounts: Partial<
    Record<RoomHistoryShadowFallbackReasonV1, number>
  > = {};
  let verifiedCount = 0;
  for (const record of records) {
    if (record.status === "verified") {
      verifiedCount++;
    } else {
      fallbackCounts[record.reason] = (fallbackCounts[record.reason] ?? 0) + 1;
    }
  }
  return Object.freeze({
    records: Object.freeze([...records]),
    eligibleCount: records.length,
    verifiedCount,
    fallbackCounts: Object.freeze(fallbackCounts),
  });
}

function decodeAuthority(
  input: RoomHistoryShadowDomainKeyAuthorityTransportV2,
): Readonly<{
  plan: RetainedRoomReadPlan;
  temporaryBytes: readonly Uint8Array[];
}> {
  const temporaryBytes: Uint8Array[] = [];
  const bytes = (label: string, value: string): Uint8Array => {
    const decoded = fromBase64url(label, value);
    temporaryBytes.push(decoded);
    return decoded;
  };
  try {
    const namespaceHead = bytes(
      "Room history Namespace head digest",
      input.namespaceHeadDigestBase64url,
    );
    return Object.freeze({
      plan: Object.freeze({
        subjectHumanId: input.subjectHumanId,
        readerDeviceSigningKeyGeneration:
          input.readerDeviceSigningKeyGeneration,
        namespaceId: input.namespaceId,
        namespaceAccessRevision: input.namespaceAccessRevision,
        namespaceAudienceFingerprint: namespaceHead,
      }),
      temporaryBytes,
    });
  } catch (error) {
    wipe(temporaryBytes);
    throw error;
  }
}

function destroyVerifiedManifest(verified: Readonly<{
  manifest: Readonly<{
    payloadHash: Uint8Array;
    previousManifestHash: Uint8Array | null;
    envelopeHashes: readonly Uint8Array[];
    signature: Uint8Array;
  }>;
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
}>): void {
  verified.manifest.payloadHash.fill(0);
  verified.manifest.previousManifestHash?.fill(0);
  verified.manifest.envelopeHashes.forEach((hash) => hash.fill(0));
  verified.manifest.signature.fill(0);
  verified.manifestBytes.fill(0);
  verified.manifestHash.fill(0);
}

function roleMatches(
  role: ConversationProtectedMessageClientDtoV2["projection"]["role"],
  payload: MessagePayloadV2,
): boolean {
  return payload.role === role;
}

function liveShadowAuthorRole(
  role: ConversationProtectedMessageClientDtoV2["projection"]["role"],
): "user" | "assistant" | "tool" | null {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "tool") return "tool";
  return null;
}

function ordinarySiblingMatches(
  dto: ConversationProtectedMessageClientDtoV2,
  ordinary: MessagePayloadV2,
  sibling: RoomHistoryOrdinarySibling | undefined,
): boolean {
  if (sibling === undefined) return false;
  if (dto.projection.logicalMessageKey !== sibling.logicalMessageKey) {
    return false;
  }
  if (ordinary.role !== sibling.payload.role) return false;
  if (ordinary.role === "tool") {
    return ordinary.content === sibling.payload.content
      && ordinary.toolName === sibling.payload.toolName;
  }
  let ordinaryBytes: Uint8Array | undefined;
  let siblingBytes: Uint8Array | undefined;
  try {
    ordinaryBytes = encodeMessagePayloadV2(ordinary);
    siblingBytes = encodeMessagePayloadV2(sibling.payload);
    return equalBytes(ordinaryBytes, siblingBytes);
  } catch {
    return false;
  } finally {
    wipe([ordinaryBytes, siblingBytes]);
  }
}

function protectedSelectionMatches(
  record: RoomHistoryShadowRecordTransportV1,
): boolean {
  if (record.representationMode !== "protected-only") return true;
  if ("ordinarySibling" in record || "ordinaryPayloadBytesBase64url" in record) return false;
  const selected = record.selectedSource;
  const projection = record.protectedMessage.projection;
  return selected !== undefined && selected.role === projection.role
    && selected.logicalMessageKey === projection.logicalMessageKey
    && (projection.role === "system"
      ? selected.sourceUserId === undefined && selected.authorAgentId === undefined
        && projection.sourceUserId === undefined && projection.authorAgentId === undefined
      : projection.role === "user" ? selected.sourceUserId === projection.sourceUserId
      : selected.authorAgentId === projection.authorAgentId);
}

async function reconcileHumanPeerHistory(input: Readonly<{
  crypto: LatticeCrypto;
  namespaceAuthority: NamespaceAuthorityClient;
  request: Omit<VaultRoomHistoryShadowReadInputV1, "authority" | "records"> & Readonly<{
    authority: RoomHistoryShadowDomainKeyAuthorityTransportV2;
    records: readonly RoomHistoryLiveShadowRecordTransportV1[];
  }>;
}>): Promise<VaultRoomHistoryShadowReadResultV1> {
  if (input.namespaceAuthority.withOpenedGenerations === undefined) {
    return finish(allFallback(
      input.request.records,
      "retained_key_material_unavailable",
    ));
  }
  const evidence = new Map(input.request.signerEvidence
    .filter((value): value is Extract<
      RoomHistoryShadowSignerEvidenceTransportV1,
      { kind: "human_peer_live_shadow_request_v1" }
    > => value.kind === "human_peer_live_shadow_request_v1")
    .map((value) => [value.operationId, value] as const));
  const retainedByCoordinate = new Map<string, Readonly<{
    generation: number;
    accessRevision: number;
    headDigest: Uint8Array;
    publicationDigest: Uint8Array;
    publicationSetDigest: Uint8Array;
    audienceFingerprint: Uint8Array;
  }>>();
  for (const record of input.request.records) {
    const retained = Object.freeze({
      generation: record.namespaceGeneration,
      accessRevision: record.namespaceAccessRevision,
      headDigest: fromBase64url(
        "Human-peer history head digest",
        record.namespaceHeadDigestBase64url,
      ),
      publicationDigest: fromBase64url(
        "Human-peer history publication digest",
        record.namespacePublicationDigestBase64url,
      ),
      publicationSetDigest: fromBase64url(
        "Human-peer history publication-set digest",
        record.namespacePublicationSetDigestBase64url,
      ),
      audienceFingerprint: fromBase64url(
        "Human-peer history audience fingerprint",
        record.namespaceAudienceFingerprintBase64url,
      ),
    });
    const coordinate = `${retained.generation}:${retained.accessRevision}`;
    const existing = retainedByCoordinate.get(coordinate);
    if (existing !== undefined && (
      !equalBytes(existing.headDigest, retained.headDigest)
      || !equalBytes(existing.publicationDigest, retained.publicationDigest)
      || !equalBytes(
        existing.publicationSetDigest,
        retained.publicationSetDigest,
      )
      || !equalBytes(
        existing.audienceFingerprint,
        retained.audienceFingerprint,
      )
    )) {
      wipe([
        retained.headDigest,
        retained.publicationDigest,
        retained.publicationSetDigest,
        retained.audienceFingerprint,
        ...[...retainedByCoordinate.values()].flatMap((value) => [
          value.headDigest,
          value.publicationDigest,
          value.publicationSetDigest,
          value.audienceFingerprint,
        ]),
      ]);
      return finish(allFallback(input.request.records, "integrity_failure"));
    }
    if (existing === undefined) {
      retainedByCoordinate.set(coordinate, retained);
    } else {
      wipe([
        retained.headDigest,
        retained.publicationDigest,
        retained.publicationSetDigest,
        retained.audienceFingerprint,
      ]);
    }
  }
  // The native authority adapter uses the final requirement as today's head.
  // Message rows may name older retained generations after membership changes;
  // authenticate the current bundle independently from those historical keys.
  const currentHeadDigest = fromBase64url("Current Namespace head",
    input.request.authority.namespaceHeadDigestBase64url);
  const authority = [Object.freeze({
    namespaceId: input.request.authority.namespaceId,
    retainedGenerations: Object.freeze([
      ...retainedByCoordinate.values(),
      Object.freeze({
        generation: input.request.authority.namespaceCurrentGeneration,
        accessRevision: input.request.authority.namespaceAccessRevision,
        headDigest: currentHeadDigest,
        publicationDigest: currentHeadDigest,
        publicationSetDigest: currentHeadDigest,
        audienceFingerprint: currentHeadDigest,
      }),
    ]),
  })];
  try {
    const opened = await input.namespaceAuthority.withOpenedGenerations({
      sourceRoomId: input.request.sourceRoomId,
      subjectHumanId: input.request.authority.subjectHumanId,
      deviceSigningKeyGeneration:
        input.request.authority.readerDeviceSigningKeyGeneration,
      keyClass: input.request.authority.keyClass,
      authority,
      ...(input.request.signal === undefined ? {} : {signal: input.request.signal}),
    }, async (generations) => {
      const results: VaultRoomHistoryShadowRecordResultV1[] = [];
      for (const record of input.request.records) {
        const protectedPayload = record.protectedMessage.protectedPayload;
        if (
          protectedPayload.status !== "encrypted"
          || protectedPayload.keyClass !== "human"
        ) {
          results.push(fallback(
            record,
            "live_shadow_lifecycle_unavailable",
          ));
          continue;
        }
        const proof = evidence.get(record.shadowOperationId);
        if (proof === undefined) {
          results.push(fallback(record, "signer_evidence_unavailable"));
          continue;
        }
        let planBytes: Uint8Array | undefined;
        let requestBytes: Uint8Array | undefined;
        let requestDigest: Uint8Array | undefined;
        let ordinaryBytes: Uint8Array | undefined;
        let encryptedBytes: Uint8Array | undefined;
        let manifestBytes: Uint8Array | undefined;
        let envelopeBytes: Uint8Array | undefined;
        let senderKey: Uint8Array | undefined;
        let openedPayload: Uint8Array | null = null;
        try {
          planBytes = fromBase64url(
            "Human-peer history plan",
            proof.planBytesBase64url,
          );
          requestBytes = fromBase64url(
            "Human-peer history request",
            proof.requestBytesBase64url,
          );
          requestDigest = fromBase64url(
            "Human-peer history request digest",
            proof.requestDigestBase64url,
          );
          senderKey = fromBase64url(
            "Human-peer history sender key",
            proof.senderDeviceSigningPublicKeyBase64url,
          );
          const protectedOnly = record.representationMode === "protected-only";
          if (!protectedSelectionMatches(record)) throw new TypeError("Protected history selection disagrees");
          ordinaryBytes = protectedOnly ? undefined : fromBase64url(
            "Human-peer history ordinary payload",
            record.ordinaryPayloadBytesBase64url,
          );
          encryptedBytes = fromBase64url(
            "Human-peer history protected payload",
            protectedPayload.encryptedPayloadBytesBase64url,
          );
          manifestBytes = fromBase64url(
            "Human-peer history manifest",
            protectedPayload.accessManifestBytesBase64url,
          );
          envelopeBytes = fromBase64url(
            "Human-peer history envelope",
            protectedPayload.namespaceEnvelopeBytesBase64url,
          );
          const ordinaryPayload = ordinaryBytes === undefined ? null : decodeMessagePayloadV2(ordinaryBytes);
          if (
            requestDigest.length !== 32
            || senderKey.length !== 32
            || record.protectedMessage.dtoVersion !== 2
            || record.protectedMessage.projection.roomId
              !== input.request.sourceRoomId
            || record.protectedMessage.projection.namespaceId
              !== input.request.authority.namespaceId
            || record.protectedMessage.projection.sessionId !== record.sessionId
            || record.protectedMessage.projection.messageId !== record.messageId
            || record.protectedMessage.projection.editRevision
              !== record.editRevision
            || record.protectedMessage.projection.role !== "user"
            || (ordinaryPayload !== null && !ordinarySiblingMatches(
              record.protectedMessage,
              ordinaryPayload,
              record.ordinarySibling,
            ))
          ) throw new TypeError("Human-peer history coordinates disagree");
          const admitted = await admitHumanPeerLiveShadowMessageExactReplay({
            crypto: input.crypto,
            expectedPlanBytes: planBytes,
            requestBytes,
            expectedRequestDigest: requestDigest,
            ...(ordinaryBytes === undefined ? { contentRepresentation: "full" as const }
              : { ordinaryPayloadBytes: ordinaryBytes }),
            encryptedPayloadBytes: encryptedBytes,
            manifestBytes,
            envelopeBytes,
            resolveCurrentHumanAuthority: (context) =>
              context.operationId === proof.operationId
                  && context.committerDeviceId === proof.senderDeviceId
                  && context.committerDeviceSigningKeyGeneration
                    === proof.senderDeviceSigningKeyGeneration
                ? senderKey!.slice()
                : null,
          });
          try {
            if (
              admitted.plan.operationId !== record.shadowOperationId
              || admitted.plan.sessionId !== record.sessionId
              || String(admitted.plan.humanMessageId) !== record.messageId
              || admitted.plan.revision !== record.editRevision
              || admitted.plan.transcriptOrdinal
                !== record.shadowTranscriptOrdinal
              || admitted.plan.roomId !== input.request.sourceRoomId
              || admitted.plan.namespaceId
                !== input.request.authority.namespaceId
              || admitted.plan.namespaceKeyGeneration
                !== record.namespaceGeneration
              || admitted.plan.namespaceAccessRevision
                !== record.namespaceAccessRevision
            ) throw new TypeError("Human-peer history plan disagrees");
            const generation = generations.find((candidate) =>
              candidate.keyClass === input.request.authority.keyClass
              && candidate.namespaceId === admitted.plan.namespaceId
              && candidate.generation === admitted.plan.namespaceKeyGeneration
              && candidate.accessRevision
                === admitted.plan.namespaceAccessRevision
              && equalBytes(
                candidate.headDigest,
                admitted.plan.namespaceHeadDigest,
              )
              && equalBytes(
                candidate.audienceFingerprint,
                admitted.plan.namespaceAudienceFingerprint,
              )
            );
            if (generation === undefined) {
              results.push(fallback(
                record,
                "retained_key_material_unavailable",
              ));
              continue;
            }
            const encrypted = decodeEncryptedPayloadV2(encryptedBytes);
            const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
            try {
              openedPayload = decryptObjectThroughNamespace(
                input.crypto,
                generation.generationKey,
                envelope,
                encrypted,
              );
            } finally {
              encrypted.ciphertext.fill(0);
              envelope.wrappedDek.fill(0);
            }
            if (openedPayload === null) {
              results.push(fallback(record, "integrity_failure"));
            } else if (ordinaryBytes !== undefined && !equalBytes(openedPayload, ordinaryBytes)) {
              results.push(fallback(record, "parity_mismatch"));
            } else {
              const openedDigest = input.crypto.hash(openedPayload);
              const signedCommitmentMatches = equalBytes(
                openedDigest,
                admitted.plaintextPayloadDigest,
              );
              openedDigest.fill(0);
              if (!signedCommitmentMatches) {
                results.push(fallback(record, "integrity_failure"));
                continue;
              }
              const payload = decodeMessagePayloadV2(openedPayload);
              if (payload.role !== "user" || payload.toolCalls?.length || payload.toolName !== undefined) {
                throw new TypeError("Human-only history payload role disagrees");
              }
              results.push(Object.freeze({
                sessionId: record.sessionId,
                messageId: record.messageId,
                editRevision: record.editRevision,
                status: "verified" as const,
                verification: protectedOnly
                  ? "signed_representation_authenticated" as const
                  : "independent_parity" as const,
                payload,
              }));
            }
          } finally {
            admitted.requestDigest.fill(0);
            admitted.plaintextPayloadDigest.fill(0);
            admitted.plan.namespaceHeadDigest.fill(0);
            admitted.plan.namespacePublicationDigest.fill(0);
            admitted.plan.namespacePublicationSetDigest.fill(0);
            admitted.plan.namespaceAudienceFingerprint.fill(0);
          }
        } catch {
          results.push(fallback(record, "integrity_failure"));
        } finally {
          wipe([
            planBytes,
            requestBytes,
            requestDigest,
            ordinaryBytes,
            encryptedBytes,
            manifestBytes,
            envelopeBytes,
            senderKey,
            openedPayload,
          ]);
        }
      }
      return Object.freeze(results);
    });
    return opened.status === "opened"
      ? finish(opened.value)
      : finish(allFallback(
        input.request.records,
        "retained_key_material_unavailable",
      ));
  } catch {
    return finish(allFallback(input.request.records, "integrity_failure"));
  } finally {
    authority.forEach((entry) => entry.retainedGenerations.forEach((value) => {
      value.headDigest.fill(0);
      value.publicationDigest.fill(0);
      value.publicationSetDigest.fill(0);
      value.audienceFingerprint.fill(0);
    }));
  }
}

async function reconcileDeviceSignedHistory(input: Readonly<{
  crypto: LatticeCrypto;
  namespaceAuthority: NamespaceAuthorityClient;
  request: Omit<VaultRoomHistoryShadowReadInputV1, "authority" | "records"> & Readonly<{
    authority: RoomHistoryShadowDomainKeyAuthorityTransportV2;
    records: readonly (RoomHistoryHumanEditedRepresentationRecordTransportV1 | RoomHistoryExistingRepresentationRecordTransportV1)[];
  }>;
  onDiagnostic?: (diagnostic: RoomHistoryVerificationDiagnostic) => void;
}>): Promise<VaultRoomHistoryShadowReadResultV1> {
  if (input.namespaceAuthority.withOpenedGenerations === undefined) {
    return finish(allFallback(input.request.records, "retained_key_material_unavailable"));
  }
  const coordinates = input.request.records.map((record) => record.kind === "existing_representation"
    ? record.retainedGeneration === undefined ? null : {
      namespaceGeneration: record.retainedGeneration.namespaceGeneration,
      namespaceAccessRevision: record.retainedGeneration.accessRevision,
      namespaceHeadDigestBase64url: record.retainedGeneration.headDigestBase64url,
      namespacePublicationDigestBase64url: record.retainedGeneration.publicationDigestBase64url,
      namespacePublicationSetDigestBase64url: record.retainedGeneration.publicationSetDigestBase64url,
      namespaceAudienceFingerprintBase64url: record.retainedGeneration.audienceFingerprintBase64url,
    } : record);
  if (coordinates.some((record) => record === null)) return finish(allFallback(input.request.records, "integrity_failure"));
  const retained = coordinates.map((coordinate) => {
    const record = coordinate!;
    return Object.freeze({
    generation: record.namespaceGeneration,
    accessRevision: record.namespaceAccessRevision,
    headDigest: fromBase64url("Edited Human head", record.namespaceHeadDigestBase64url),
    publicationDigest: fromBase64url("Edited Human publication", record.namespacePublicationDigestBase64url),
    publicationSetDigest: fromBase64url("Edited Human publication set", record.namespacePublicationSetDigestBase64url),
    audienceFingerprint: fromBase64url("Edited Human audience", record.namespaceAudienceFingerprintBase64url),
    });
  });
  // The native authority port treats the final generation as the current head.
  // A historical Message can name an older retained generation after rotation;
  // fence opening against today's authenticated head while requesting its old key.
  // Native V2 authority uses the retained-set head for all publication digests.
  const currentHeadDigest = fromBase64url("Current Namespace head",
    input.request.authority.namespaceHeadDigestBase64url);
  retained.push(Object.freeze({
    generation: input.request.authority.namespaceCurrentGeneration,
    accessRevision: input.request.authority.namespaceAccessRevision,
    headDigest: currentHeadDigest,
    publicationDigest: currentHeadDigest,
    publicationSetDigest: currentHeadDigest,
    audienceFingerprint: currentHeadDigest,
  }));
  try {
    const opened = await input.namespaceAuthority.withOpenedGenerations({
      sourceRoomId: input.request.sourceRoomId,
      subjectHumanId: input.request.authority.subjectHumanId,
      deviceSigningKeyGeneration: input.request.authority.readerDeviceSigningKeyGeneration,
      keyClass: input.request.authority.keyClass,
      authority: [{ namespaceId: input.request.authority.namespaceId, retainedGenerations: retained }],
      ...(input.request.signal === undefined ? {} : {signal: input.request.signal}),
    }, (generations) => {
      const results: VaultRoomHistoryShadowRecordResultV1[] = [];
      for (const record of input.request.records) {
        if (record.kind === "existing_representation") {
          results.push(readExistingRepresentation(input.crypto, input.request, record,
            generations.filter((generation) => generation.namespaceId === input.request.authority.namespaceId
              && generation.keyClass === input.request.authority.keyClass)));
          continue;
        }
        const owned: Uint8Array[] = [];
        let verified: ReturnType<typeof verifyObjectAccessManifestChain> | undefined;
        let stage: RoomHistoryVerificationDiagnostic["stage"] = "structural_selection";
        try {
          const dto = record.protectedMessage;
          const protectedPayload = dto.protectedPayload;
          if (!protectedSelectionMatches(record)) {
            throw new TypeError("Edited Human structural selection disagrees");
          }
          stage = "structural_coordinates";
          if (protectedPayload.status !== "encrypted"
            || protectedPayload.keyClass !== input.request.authority.keyClass
            || dto.projection.role !== "user"
            || dto.projection.sessionId !== record.sessionId
            || dto.projection.messageId !== record.messageId
            || dto.projection.editRevision !== record.editRevision
            || dto.projection.namespaceId !== input.request.authority.namespaceId) {
            throw new TypeError("Edited Human structural coordinates disagree");
          }
          stage = "object_identity";
          const expectedId = protectedPayload.cryptoObjectId;
          parseHumanMessageEditCryptoObjectIdV1(expectedId, {
            sessionId: record.sessionId,
            messageId: Number(record.messageId),
            revision: record.editRevision,
          });
          if (protectedPayload.cryptoObjectId !== expectedId) throw new TypeError("Edited Human object ID disagrees");
          stage = "encoding";
          const encryptedBytes = fromBase64url("Edited Human ciphertext", protectedPayload.encryptedPayloadBytesBase64url);
          const ordinaryBytes = record.representationMode === "protected-only" ? null
            : fromBase64url("Edited Human ordinary payload", record.ordinaryPayloadBytesBase64url);
          const manifestBytes = fromBase64url("Edited Human manifest", protectedPayload.accessManifestBytesBase64url);
          const envelopeBytes = fromBase64url("Edited Human envelope", protectedPayload.namespaceEnvelopeBytesBase64url);
          const signerKey = fromBase64url("Edited Human signer", record.committerDeviceSigningPublicKeyBase64url);
          owned.push(encryptedBytes, manifestBytes, envelopeBytes, signerKey,
            ...(ordinaryBytes === null ? [] : [ordinaryBytes]));
          const manifest = decodeObjectAccessManifestV2OrV3(manifestBytes);
          const encrypted = decodeEncryptedPayloadV2(encryptedBytes);
          const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
          try {
            stage = "protected_coordinates";
            if (manifest.formatVersion !== 2 || manifest.objectId !== expectedId
              || encrypted.context.objectId !== expectedId
              || encrypted.context.objectType !== CONVERSATION_MESSAGE_OBJECT_TYPE
              || encrypted.context.keyClass !== input.request.authority.keyClass
              || encrypted.context.createdAt !== Date.parse(dto.projection.createdAt)
              || envelope.context.objectId !== expectedId
              || envelope.context.namespaceId !== input.request.authority.namespaceId
              || envelope.context.keyClass !== input.request.authority.keyClass
              || envelope.context.keyGeneration !== record.namespaceGeneration
              || envelope.context.bindingRevisionAtWrap !== record.namespaceAccessRevision
              || signerKey.length !== 32) throw new TypeError("Edited Human protected coordinates disagree");
            stage = "manifest";
            const manifestHash = input.crypto.hash(manifestBytes);
            try {
              verified = verifyObjectAccessManifestChain(input.crypto, {
                manifestBytes, proof: [], trustedMinimumHead: {
                  objectId: objectId(expectedId), payloadHash: manifest.payloadHash,
                  accessRevision: accessRevision(manifest.accessRevision), manifestHash,
                },
                resolveSigningPublicKey: (deviceId) =>
                  deviceId === manifest.committerDeviceId ? signerKey.slice() : null,
              });
            } finally { manifestHash.fill(0); }
            const ciphertextDigest = input.crypto.hash(encryptedBytes);
            const envelopeDigest = input.crypto.hash(envelopeBytes);
            owned.push(ciphertextDigest, envelopeDigest);
            if (verified.manifest.objectId !== expectedId
              || verified.manifest.accessRevision !== 0
              || !equalBytes(verified.manifest.payloadHash, ciphertextDigest)
              || verified.manifest.envelopeHashes.length !== 1
              || !equalBytes(verified.manifest.envelopeHashes[0]!, envelopeDigest)) {
              throw new TypeError("Edited Human manifest disagrees");
            }
            stage = "generation";
            const generation = generations.find((candidate) =>
              candidate.keyClass === input.request.authority.keyClass
              && candidate.namespaceId === input.request.authority.namespaceId
              && candidate.generation === record.namespaceGeneration
              && candidate.accessRevision === record.namespaceAccessRevision
                && equalBytes(candidate.headDigest, retained.find((entry) =>
                entry.generation === record.namespaceGeneration
                && entry.accessRevision === record.namespaceAccessRevision)!.headDigest));
            if (generation === undefined) {
              results.push(fallback(record, "retained_key_material_unavailable"));
              continue;
            }
            stage = "decrypt";
            const plaintext = decryptObjectThroughNamespace(input.crypto, generation.generationKey, envelope, encrypted);
            if (plaintext === null) throw new TypeError("Edited Human decrypt failed");
            owned.push(plaintext);
            stage = "payload";
            const payload = decodeMessagePayloadV2(plaintext);
            if (payload.role !== "user" || payload.toolCalls?.length || payload.toolName !== undefined) {
              throw new TypeError("Edited Human payload role disagrees");
            }
            if (ordinaryBytes !== null && (!equalBytes(ordinaryBytes, plaintext)
              || !ordinarySiblingMatches(dto, payload, record.ordinarySibling))) {
              results.push(fallback(record, "parity_mismatch"));
              continue;
            }
            results.push({ sessionId: record.sessionId, messageId: record.messageId,
              editRevision: record.editRevision, status: "verified",
              verification: ordinaryBytes === null
                ? "signed_representation_authenticated" : "independent_parity", payload });
          } finally {
            encrypted.ciphertext.fill(0);
            envelope.wrappedDek.fill(0);
          }
        } catch (error) {
          try {
            input.onDiagnostic?.(Object.freeze({
              operation: "human_edited_history",
              stage,
              errorName: diagnosticErrorName(error),
            }));
          } catch {
            // Diagnostics are observational and cannot alter verification.
          }
          results.push(fallback(record, "integrity_failure"));
        } finally {
          if (verified !== undefined) destroyVerifiedManifest(verified);
          wipe(owned);
        }
      }
      return results;
    });
    return opened.status === "opened" ? finish(opened.value)
      : finish(allFallback(input.request.records, "retained_key_material_unavailable"));
  } finally {
    retained.forEach((entry) => wipe([entry.headDigest, entry.publicationDigest,
      entry.publicationSetDigest, entry.audienceFingerprint]));
  }
}

/**
 * Verify a retained Runtime or admitted-device publication of an existing Message. The publisher
 * signs the representation, not the original author's identity. Original
 * authorship stays in the selected product row and independent visible sibling.
 */
function readExistingRepresentation(
  crypto: LatticeCrypto,
  request: VaultRoomHistoryShadowReadInputV1,
  record: RoomHistoryExistingRepresentationRecordTransportV1,
  retained: readonly Pick<RetainedRoomNamespaceGeneration, "generation" | "accessRevision" | "generationKey">[],
): VaultRoomHistoryShadowRecordResultV1 {
  const owned: Uint8Array[] = [];
  const decode = (label: string, value: string) => {
    const bytes = fromBase64url(label, value);
    owned.push(bytes);
    return bytes;
  };
  let verified: ReturnType<typeof verifyAgentObjectAccessManifest> | undefined;
  let deviceVerified: ReturnType<typeof verifyObjectAccessManifestChain> | undefined;
  let encrypted: ReturnType<typeof decodeEncryptedPayloadV2> | undefined;
  let envelope: ReturnType<typeof decodeNamespaceObjectEnvelopeV2> | undefined;
  try {
    const dto = record.protectedMessage;
    const protectedPayload = dto.protectedPayload;
    if (protectedPayload.status !== "encrypted") return fallback(record, "live_shadow_lifecycle_unavailable");
    if (!protectedSelectionMatches(record)) {
      throw new TypeError("Existing Message protected selection disagrees");
    }
    const protectedOnly = record.representationMode === "protected-only";
    const original = protectedOnly ? record.selectedSource : record.ordinarySibling;
    const originalRole = protectedOnly
      ? record.selectedSource.role
      : record.ordinarySibling.payload.role;
    if (dto.projection.role === "system"
      && (dto.projection.sourceUserId !== undefined || dto.projection.authorAgentId !== undefined
        || original.sourceUserId !== undefined || original.authorAgentId !== undefined)) {
      throw new TypeError("System Message cannot acquire publisher attribution");
    }
    if (dto.dtoVersion !== 2 || dto.projection.roomId !== request.sourceRoomId
      || dto.projection.namespaceId !== request.authority.namespaceId
      || dto.projection.sessionId !== record.sessionId || dto.projection.messageId !== record.messageId
      || dto.projection.editRevision !== record.editRevision
      // Ordinary Room history also carries the Session owner on Agent/tool
      // rows. Only the role-specific field identifies the original author.
      || (dto.projection.role === "user"
        ? dto.projection.sourceUserId !== original.sourceUserId
        : dto.projection.authorAgentId !== original.authorAgentId)
      || dto.projection.role !== originalRole
      || protectedPayload.keyClass !== request.authority.keyClass || protectedPayload.payloadVersion !== 2
      || (record.repair.publisherKind !== "human_device" && protectedPayload.keyClass !== "ai")
      || deriveMessageCryptoObjectIdV2({ sessionId: record.sessionId,
        messageId: Number(record.messageId), revision: record.editRevision }) !== protectedPayload.cryptoObjectId) {
      throw new TypeError("Existing Message source coordinates disagree");
    }
    const identity = decode("Repair identity", record.repair.identityDigestBase64url);
    const allocation = decode("Repair allocation", record.repair.allocationDigestBase64url);
    const attestation = decode("Repair attestation", record.repair.attestationDigestBase64url);
    const publicKey = decode("Repair publisher key", record.repair.publisherSigningPublicKeyBase64url);
    if ([identity, allocation, attestation, publicKey].some((bytes) => bytes.length !== 32)
      || (record.repair.publisherKind !== "human_device"
        && agentRuntimeObjectSignerKeyIdV1(crypto, publicKey) !== record.repair.publisherSignerKeyId)) {
      throw new TypeError("Existing Message publisher evidence disagrees");
    }
    const manifestBytes = decode("Repair manifest", protectedPayload.accessManifestBytesBase64url);
    const payloadBytes = decode("Repair ciphertext", protectedPayload.encryptedPayloadBytesBase64url);
    const envelopeBytes = decode("Repair envelope", protectedPayload.namespaceEnvelopeBytesBase64url);
    if (!equalBytes(crypto.hash(manifestBytes), attestation)) throw new TypeError("Repair attestation disagrees");
    if (record.repair.publisherKind === "human_device") {
      const decodedManifest = decodeObjectAccessManifestV2OrV3(manifestBytes);
      if (decodedManifest.formatVersion !== 2
        || decodedManifest.committerDeviceId !== record.repair.publisherSignerKeyId) {
        throw new TypeError("Existing Message device signer disagrees");
      }
      const manifestHash = crypto.hash(manifestBytes);
      owned.push(manifestHash);
      deviceVerified = verifyObjectAccessManifestChain(crypto, {
        manifestBytes, proof: [], trustedMinimumHead: {
          objectId: objectId(protectedPayload.cryptoObjectId),
          payloadHash: decodedManifest.payloadHash,
          accessRevision: accessRevision(0), manifestHash,
        },
        resolveSigningPublicKey: (deviceId) =>
          deviceId === record.repair.publisherSignerKeyId ? publicKey.slice() : null,
      });
    } else {
      verified = verifyAgentObjectAccessManifest(crypto, {
        manifestBytes, resolveSignerPublicKey: (principal) =>
          principal.signerKeyId === record.repair.publisherSignerKeyId ? publicKey.slice() : null,
      });
    }
    encrypted = decodeEncryptedPayloadV2(payloadBytes);
    envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
    const manifest = (deviceVerified ?? verified)!.manifest;
    if (manifest.objectId !== protectedPayload.cryptoObjectId || manifest.accessRevision !== 0
      || !equalBytes(manifest.payloadHash, crypto.hash(payloadBytes))
      || manifest.envelopeHashes.length !== 1
      || !equalBytes(manifest.envelopeHashes[0]!, crypto.hash(envelopeBytes))
      || encrypted.context.objectId !== protectedPayload.cryptoObjectId
      || encrypted.context.objectType !== CONVERSATION_MESSAGE_OBJECT_TYPE
      || encrypted.context.keyClass !== request.authority.keyClass
      || encrypted.context.createdAt !== Date.parse(dto.projection.createdAt)
      || envelope.context.objectId !== protectedPayload.cryptoObjectId
      || envelope.context.namespaceId !== request.authority.namespaceId
      || envelope.context.keyClass !== request.authority.keyClass) throw new TypeError("Existing Message protected bytes disagree");
    // Current device-authenticated Namespace authority already contains the
    // retained generations; no live execution/Room plan is invented for repair.
    const generation = retained.find((entry) => entry.generation === envelope!.context.keyGeneration
      && entry.accessRevision === envelope!.context.bindingRevisionAtWrap);
    if (generation === undefined) return fallback(record, "retained_key_material_unavailable");
    const plaintext = decryptObjectThroughNamespace(crypto, generation.generationKey, envelope, encrypted);
    if (plaintext === null) throw new TypeError("Existing Message decrypt failed");
    owned.push(plaintext);
    if (!equalBytes(crypto.hash(plaintext), allocation)) return fallback(record, "parity_mismatch");
    const payload = decodeMessagePayloadV2(plaintext);
    const ordinaryBytes = !protectedOnly && record.ordinaryPayloadBytesBase64url !== undefined
      ? decode("Existing Message ordinary payload", record.ordinaryPayloadBytesBase64url) : null;
    if (!roleMatches(dto.projection.role, payload)
      || (ordinaryBytes !== null && !equalBytes(plaintext, ordinaryBytes))
      || (!protectedOnly && !ordinarySiblingMatches(dto, payload, record.ordinarySibling))) {
      return fallback(record, "parity_mismatch");
    }
    return { sessionId: record.sessionId, messageId: record.messageId, editRevision: record.editRevision,
      status: "verified",
      verification: protectedOnly
        ? "signed_representation_authenticated"
        : "independent_parity",
      payload };
  } catch {
    return fallback(record, "integrity_failure");
  } finally {
    if (verified !== undefined) destroyVerifiedManifest(verified);
    if (deviceVerified !== undefined) {
      deviceVerified.manifest.payloadHash.fill(0);
      deviceVerified.manifest.envelopeHashes.forEach((hash) => hash.fill(0));
      deviceVerified.manifest.signature.fill(0);
      deviceVerified.manifestBytes.fill(0);
      deviceVerified.manifestHash.fill(0);
    }
    encrypted?.ciphertext.fill(0);
    envelope?.wrappedDek.fill(0);
    wipe(owned);
  }
}

export function createVaultRoomHistoryShadowMessageReader(input: Readonly<{
  crypto: LatticeCrypto;
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  authority: RetainedRoomAuthorityClient;
  namespaceAuthority: NamespaceAuthorityClient;
  resolveTrustedDeviceSigningPublicKey:
    ResolveTrustedDeviceSigningPublicKey;
  createProfileStageId: () => string;
  onDiagnostic?: (diagnostic: RoomHistoryVerificationDiagnostic) => void;
}>): VaultRoomHistoryShadowMessageReader {
  const reconcile = async (
    request: VaultRoomHistoryShadowReadInputV1,
  ): Promise<VaultRoomHistoryShadowReadResultV1> => {
    if (request.records.length > MAX_HISTORY_ROWS) {
      return finish(allFallback(request.records, "integrity_failure"));
    }
    if (request.records.length === 0) return finish([]);

    if (request.authorities !== undefined) {
      const { authorities, ...single } = request;
      const byClass = new Map(authorities.map((authority) => [authority.keyClass, authority]));
      if (byClass.size !== authorities.length || byClass.size === 0
        || authorities.some((authority) => authority.namespaceId !== request.authority.namespaceId
          || authority.subjectHumanId !== request.authority.subjectHumanId
          || authority.readerDeviceId !== request.authority.readerDeviceId
          || authority.readerDeviceSigningKeyGeneration !== request.authority.readerDeviceSigningKeyGeneration
          || authority.hostAuthorizationRevision !== request.authority.hostAuthorizationRevision
          || authority.policyRevision !== request.authority.policyRevision
          || authority.roomId !== request.sourceRoomId)) {
        return finish(allFallback(request.records, "integrity_failure"));
      }
      const results = await Promise.all(authorities.map((authority) => reconcile({
        ...single, authority,
        records: request.records.filter((record) => record.protectedMessage.protectedPayload.status === "encrypted"
          && record.protectedMessage.protectedPayload.keyClass === authority.keyClass),
      })));
      const byCoordinate = new Map(results.flatMap((result) => result.records).map((record) => [
        `${record.sessionId}:${record.messageId}:${record.editRevision}`, record,
      ]));
      return finish(request.records.map((record) => byCoordinate.get(
        `${record.sessionId}:${record.messageId}:${record.editRevision}`,
      ) ?? fallback(record, "integrity_failure")));
    }

    const currentAuthority = request.authority;
    const isDeviceSigned = (record: RoomHistoryShadowRecordTransportV1): record is
      RoomHistoryHumanEditedRepresentationRecordTransportV1 | RoomHistoryExistingRepresentationRecordTransportV1 =>
      record.kind === "human_edited_representation"
      || (record.kind === "existing_representation" && record.repair.publisherKind === "human_device");
    const edited = request.records.filter(isDeviceSigned);
    if (edited.length > 0) {
      const remaining = request.records.filter((record) => !isDeviceSigned(record));
      const [editedResult, remainingResult] = await Promise.all([
        reconcileDeviceSignedHistory({ crypto: input.crypto,
          namespaceAuthority: input.namespaceAuthority,
          request: Object.freeze({ ...request, records: edited, authority: currentAuthority }),
          ...(input.onDiagnostic === undefined ? {} : { onDiagnostic: input.onDiagnostic }) }),
        remaining.length === 0 ? Promise.resolve(finish([]))
          : reconcile(Object.freeze({ ...request, records: remaining })),
      ]);
      const byCoordinate = new Map([...editedResult.records, ...remainingResult.records]
        .map((record) => [`${record.sessionId}:${record.messageId}:${record.editRevision}`, record] as const));
      return finish(request.records.map((record) => byCoordinate.get(
        `${record.sessionId}:${record.messageId}:${record.editRevision}`,
      ) ?? fallback(record, "integrity_failure")));
    }
    if (currentAuthority.keyClass === "human") {
      const live = request.records.filter((record): record is RoomHistoryLiveShadowRecordTransportV1 =>
        record.kind !== "existing_representation");
      if (live.length !== request.records.length) {
        return finish(allFallback(request.records, "integrity_failure"));
      }
      return reconcileHumanPeerHistory({
        crypto: input.crypto,
        namespaceAuthority: input.namespaceAuthority,
        request: Object.freeze({ ...request, records: live, authority: currentAuthority }),
      });
    }

    const encrypted = request.records.filter((record): record is
      RoomHistoryLiveShadowRecordTransportV1 | RoomHistoryExistingRepresentationRecordTransportV1 =>
      record.kind !== "human_edited_representation"
      && record.protectedMessage.protectedPayload.status === "encrypted"
    );
    if (encrypted.length === 0) {
      return finish(allFallback(
        request.records,
        "live_shadow_lifecycle_unavailable",
      ));
    }

    let legacySignerEvidenceAvailable = true;
    const legacySignerEvidence = request.signerEvidence.filter(
      (evidence): evidence is ObjectAccessSignerEvidenceTransportV1 =>
        evidence.kind !== "human_live_shadow_request_v3"
        && evidence.kind !== "human_live_shadow_request_v4"
        && evidence.kind !== "human_peer_live_shadow_request_v1"
        && evidence.kind !== "human_ai_readable_live_shadow_request_v1"
        && evidence.kind !== "human_ai_readable_live_shadow_request_v2"
        && evidence.kind !== "shared_agent_execution_plan_v4",
    );
    if (legacySignerEvidence.length > 0) {
      try {
        await ingestObjectAccessSignerEvidenceV4({
          crypto: input.crypto,
          vault: input.vault,
          coordinates: input.coordinates,
          evidence: legacySignerEvidence,
          resolveTrustedIssuingDevicePublicKey:
            input.resolveTrustedDeviceSigningPublicKey,
          createStageId: input.createProfileStageId,
        });
      } catch {
        legacySignerEvidenceAvailable = false;
      }
    }

    let decodedAuthority: ReturnType<typeof decodeAuthority>;
    try {
      decodedAuthority = decodeAuthority(request.authority);
    } catch {
      return finish(allFallback(request.records, "integrity_failure"));
    }
    try {
      const opened = await input.authority.withOpenedRetainedRoomAuthority({
        sourceRoomId: request.sourceRoomId,
        plan: decodedAuthority.plan,
      }, async ({ retainedGenerations }) => {
        const available = await input.vault.availability();
        if (
          available.status !== "available"
          && (await input.vault.unlock()).status !== "available"
        ) return CUSTODY_UNAVAILABLE;
        try {
          return await input.vault.withOpenProfile(
            input.coordinates,
            async (profileBytes) => {
            let profile;
            try {
              profile = await authenticateClientDeviceProfileV4({
                crypto: input.crypto,
                profileBytes,
                expectedDeviceId: input.coordinates.deviceId,
              });
            } catch {
              return CUSTODY_UNAVAILABLE;
            }
            try {
              const liveSigners = new Map<string, Readonly<{
                agentId: string;
                runtimeGeneration: number;
                signerKeyId: string;
                signerPublicKey: Uint8Array;
              }>>();
              const base = profile.baseProfile.baseProfile;
              const sharedPlans = new Map<string, ReturnType<typeof decodeLiveShadowMessagePlanV4>>();
              const humanPlaintextCommitments = new Map<string, Uint8Array>();
              const humanSigners = new Map<string, Readonly<{
                deviceId: string; hostAuthorizationRevision: number; publicKey: Uint8Array;
              }>>();
              const conflictingSharedPlans = new Set<string>();
              const seenHumanEvidence = new Set<string>();
              for (const evidence of request.signerEvidence) {
                if (evidence.kind === "human_ai_readable_live_shadow_request_v1"
                  || evidence.kind === "human_ai_readable_live_shadow_request_v2") {
                  if (seenHumanEvidence.has(evidence.operationId)) {
                    humanSigners.get(evidence.operationId)?.publicKey.fill(0);
                    humanSigners.delete(evidence.operationId);
                    humanPlaintextCommitments.get(evidence.operationId)?.fill(0);
                    humanPlaintextCommitments.delete(evidence.operationId);
                    continue;
                  }
                  seenHumanEvidence.add(evidence.operationId);
                  let planBytes: Uint8Array | undefined;
                  let requestBytes: Uint8Array | undefined;
                  let requestDigest: Uint8Array | undefined;
                  let signingPublicKey: Uint8Array | null = null;
                  let decoded = undefined as ReturnType<
                    typeof decodeHumanAiReadableLiveShadowMessageRequest
                  > | undefined;
                  let verified = undefined as ReturnType<
                    typeof verifyHumanAiReadableLiveShadowMessageRequestExactReplay
                  > | undefined;
                  let plan = undefined as ReturnType<
                    typeof decodeHumanAiReadableLiveShadowMessagePlan
                  > | undefined;
                  try {
                    planBytes = fromBase64url("Shared Human history plan", evidence.planBytesBase64url);
                    requestBytes = fromBase64url("Shared Human history request", evidence.requestBytesBase64url);
                    requestDigest = fromBase64url("Shared Human history request digest", evidence.requestDigestBase64url);
                    decoded = decodeHumanAiReadableLiveShadowMessageRequest(requestBytes);
                    signingPublicKey = decoded.committerDeviceId === base.deviceId
                      ? base.signingPublicKey.slice()
                      : evidence.committerDeviceSigningPublicKeyBase64url !== undefined
                      ? fromBase64url("Retained Human signing key", evidence.committerDeviceSigningPublicKeyBase64url)
                      : await input.resolveTrustedDeviceSigningPublicKey({
                      deviceId: decoded.committerDeviceId,
                      hostAuthorizationRevision: decoded.hostAuthorizationRevision,
                      trustedDeviceRevision: base.trustedDeviceRevision,
                    });
                    if (signingPublicKey === null) continue;
                    verified = verifyHumanAiReadableLiveShadowMessageRequestExactReplay(input.crypto, {
                      requestBytes, expectedRequestDigest: requestDigest,
                      resolveCurrentAuthority: (context) =>
                        context.operationId === evidence.operationId
                          && context.committerDeviceId === decoded!.committerDeviceId
                          ? signingPublicKey!.slice() : null,
                    });
                    plan = decodeHumanAiReadableLiveShadowMessagePlan(planBytes);
                    const planDigest = input.crypto.hash(planBytes);
                    const coordinatesMatch = equalBytes(planDigest, verified.planDigest)
                      && plan.formatVersion === verified.formatVersion
                      && (plan.formatVersion === 2)
                        === (evidence.kind === "human_ai_readable_live_shadow_request_v2")
                      && plan.operationId === evidence.operationId
                      && verified.operationId === evidence.operationId
                      && plan.subjectHumanId === verified.subjectHumanId
                      && plan.committerDeviceId === verified.committerDeviceId
                      && plan.committerDeviceSigningKeyGeneration === verified.committerDeviceSigningKeyGeneration
                      && plan.hostAuthorizationRevision === verified.hostAuthorizationRevision
                      && plan.policyRevision === verified.policyRevision
                      && plan.sessionId === verified.sessionId
                      && plan.roomId === verified.roomId
                      && plan.humanMessageId === verified.messageId
                      && plan.namespaceId === verified.namespaceId
                      && plan.namespaceAccessRevision === verified.namespaceAccessRevision
                      && plan.namespaceKeyGeneration === verified.namespaceKeyGeneration
                      && plan.transcriptOrdinal === verified.transcriptOrdinal
                      && plan.createdAt === verified.createdAt
                      && plan.clientIdempotencyKey === verified.clientIdempotencyKey
                      && plan.roomId === request.sourceRoomId
                      && plan.namespaceId === request.authority.namespaceId;
                    planDigest.fill(0);
                    if (!coordinatesMatch) continue;
                    humanSigners.get(evidence.operationId)?.publicKey.fill(0);
                    humanSigners.set(evidence.operationId, {
                      deviceId: verified.committerDeviceId,
                      hostAuthorizationRevision: verified.hostAuthorizationRevision,
                      publicKey: signingPublicKey.slice(),
                    });
                    humanPlaintextCommitments.set(
                      evidence.operationId,
                      verified.plaintextPayloadDigest.slice(),
                    );
                  } catch {
                    // A malformed retained Human proof grants no plaintext commitment.
                  } finally {
                    wipe([planBytes, requestBytes, requestDigest, signingPublicKey]);
                    if (decoded) wipeOwnedByteFields(decoded);
                    if (verified) wipeOwnedByteFields(verified);
                    if (plan) wipeOwnedByteFields(plan);
                  }
                  continue;
                }
                if (evidence.kind === "shared_agent_execution_plan_v4") {
                  let bytes: Uint8Array | undefined;
                  let expectedDigest: Uint8Array | undefined;
                  let plan: ReturnType<typeof decodeLiveShadowMessagePlanV4> | undefined;
                  try {
                    if (sharedPlans.has(evidence.operationId)) {
                      conflictingSharedPlans.add(evidence.operationId);
                      continue;
                    }
                    bytes = fromBase64url("Shared execution history plan", evidence.planBytesBase64url);
                    expectedDigest = fromBase64url("Shared execution history digest", evidence.planDigestBase64url);
                    plan = decodeLiveShadowMessagePlanV4(bytes);
                    if (expectedDigest.length !== 32
                      || !equalBytes(input.crypto.hash(bytes), expectedDigest)
                      || !equalBytes(encodeLiveShadowMessagePlanV4(plan), bytes)
                      || plan.operationId !== evidence.operationId
                      || plan.roomId !== request.sourceRoomId
                      || plan.namespaceId !== request.authority.namespaceId) continue;
                    sharedPlans.set(evidence.operationId, plan);
                    liveSigners.set(evidence.operationId, {
                      agentId: plan.recipientAgentId,
                      runtimeGeneration: plan.agentRuntimeGeneration,
                      signerKeyId: plan.agentSignerKeyId,
                      signerPublicKey: plan.agentSignerPublicKey.slice(),
                    });
                    plan = undefined;
                  } catch {
                    // Malformed accepted-plan transport cannot grant signer authority.
                  } finally {
                    wipe([bytes, expectedDigest]);
                    if (plan !== undefined) wipeOwnedByteFields(plan);
                  }
                  continue;
                }
                if (
                  evidence.kind !== "human_live_shadow_request_v3"
                  && evidence.kind !== "human_live_shadow_request_v4"
                ) continue;
                if (evidence.kind === "human_live_shadow_request_v4") {
                  let planBytes: Uint8Array | undefined;
                  let requestBytes: Uint8Array | undefined;
                  let requestDigest: Uint8Array | undefined;
                  let signingPublicKey: Uint8Array | null = null;
                  let decodedRequest: ReturnType<
                    typeof decodeHumanLiveShadowMessageRequestV4
                  > | undefined;
                  let verifiedRequest: ReturnType<
                    typeof verifyForegroundSessionHumanLiveShadowMessageRequestExactReplay
                  > | undefined;
                  let plan: ReturnType<typeof decodeLiveShadowMessagePlanV4>
                    | undefined;
                  let planDigest: Uint8Array | undefined;
                  try {
                    planBytes = fromBase64url(
                      "Room history foreground plan",
                      evidence.planBytesBase64url,
                    );
                    requestBytes = fromBase64url(
                      "Room history foreground request",
                      evidence.requestBytesBase64url,
                    );
                    requestDigest = fromBase64url(
                      "Room history foreground request digest",
                      evidence.requestDigestBase64url,
                    );
                    if (requestDigest.length !== 32) continue;
                    decodedRequest = decodeHumanLiveShadowMessageRequestV4(
                      requestBytes,
                    );
                    signingPublicKey = decodedRequest.committerDeviceId
                        === base.deviceId
                      ? base.signingPublicKey.slice()
                      : await input.resolveTrustedDeviceSigningPublicKey({
                        deviceId: decodedRequest.committerDeviceId,
                        hostAuthorizationRevision:
                          decodedRequest.hostAuthorizationRevision,
                        trustedDeviceRevision: base.trustedDeviceRevision,
                      });
                    if (signingPublicKey === null) continue;
                    verifiedRequest =
                      verifyForegroundSessionHumanLiveShadowMessageRequestExactReplay(
                        input.crypto,
                        {
                          requestBytes,
                          expectedRequestDigest: requestDigest,
                          resolveCurrentAuthority: (context) =>
                            context.subjectHumanId
                                === decodedRequest!.subjectHumanId
                              && context.operationId
                                === decodedRequest!.operationId
                              && context.committerDeviceId
                                === decodedRequest!.committerDeviceId
                              && context.committerDeviceSigningKeyGeneration
                                === decodedRequest!
                                  .committerDeviceSigningKeyGeneration
                              && context.hostAuthorizationRevision
                                === decodedRequest!.hostAuthorizationRevision
                              ? signingPublicKey!.slice()
                              : null,
                        },
                      );
                    plan = decodeLiveShadowMessagePlanV4(planBytes);
                    planDigest = input.crypto.hash(planBytes);
                    if (
                      evidence.operationId !== plan.operationId
                      || evidence.operationId !== verifiedRequest.operationId
                      || !equalBytes(planDigest, verifiedRequest.planDigest)
                      || plan.subjectHumanId !== verifiedRequest.subjectHumanId
                      || plan.sessionId !== verifiedRequest.sessionId
                      || plan.roomId !== verifiedRequest.roomId
                      || plan.humanMessageId !== verifiedRequest.messageId
                      || plan.recipientAgentId
                        !== verifiedRequest.recipientAgentId
                      || plan.agentAuthorizationRevision
                        !== verifiedRequest.agentAuthorizationRevision
                      || plan.namespaceId !== verifiedRequest.namespaceId
                      || plan.namespaceAccessRevision
                        !== verifiedRequest.namespaceAccessRevision
                      || plan.namespaceKeyGeneration
                        !== verifiedRequest.namespaceKeyGeneration
                      || plan.committerDeviceId
                        !== verifiedRequest.committerDeviceId
                      || plan.committerDeviceSigningKeyGeneration
                        !== verifiedRequest.committerDeviceSigningKeyGeneration
                      || plan.hostAuthorizationRevision
                        !== verifiedRequest.hostAuthorizationRevision
                    ) continue;
                    liveSigners.set(evidence.operationId, Object.freeze({
                      agentId: plan.recipientAgentId,
                      runtimeGeneration: plan.agentRuntimeGeneration,
                      signerKeyId: plan.agentSignerKeyId,
                      signerPublicKey: plan.agentSignerPublicKey.slice(),
                    }));
                    humanPlaintextCommitments.set(
                      evidence.operationId,
                      verifiedRequest.plaintextPayloadDigest.slice(),
                    );
                  } catch {
                    // One malformed V4 signer proof degrades only its Agent rows.
                  } finally {
                    wipe([
                      planBytes,
                      requestBytes,
                      requestDigest,
                      signingPublicKey,
                      planDigest,
                    ]);
                    if (decodedRequest) wipeOwnedByteFields(decodedRequest);
                    if (verifiedRequest) wipeOwnedByteFields(verifiedRequest);
                    if (plan) wipeOwnedByteFields(plan);
                  }
                  continue;
                }
                let planBytes: Uint8Array | undefined;
                let requestBytes: Uint8Array | undefined;
                let requestDigest: Uint8Array | undefined;
                let decodedRequest: ReturnType<
                  typeof decodeHumanLiveShadowMessageRequestV3
                > | undefined;
                let verifiedRequest: ReturnType<
                  typeof verifyDomainCompressedHumanLiveShadowMessageRequestExactReplay
                > | undefined;
                let plan: ReturnType<typeof decodeLiveShadowMessagePlanV3>
                  | undefined;
                let signingPublicKey: Uint8Array | null = null;
                let planDigest: Uint8Array | undefined;
                try {
                  planBytes = fromBase64url(
                    "Room history live Shadow plan",
                    evidence.planBytesBase64url,
                  );
                  requestBytes = fromBase64url(
                    "Room history live Shadow request",
                    evidence.requestBytesBase64url,
                  );
                  requestDigest = fromBase64url(
                    "Room history live Shadow request digest",
                    evidence.requestDigestBase64url,
                  );
                  if (requestDigest.length !== 32) continue;
                  decodedRequest = decodeHumanLiveShadowMessageRequestV3(
                    requestBytes,
                  );
                  signingPublicKey = decodedRequest.committerDeviceId
                      === base.deviceId
                    ? base.signingPublicKey.slice()
                    : await input.resolveTrustedDeviceSigningPublicKey({
                      deviceId: decodedRequest.committerDeviceId,
                      hostAuthorizationRevision:
                        decodedRequest.hostAuthorizationRevision,
                      trustedDeviceRevision: base.trustedDeviceRevision,
                    });
                  if (signingPublicKey === null) continue;
                  verifiedRequest =
                    verifyDomainCompressedHumanLiveShadowMessageRequestExactReplay(
                      input.crypto,
                      {
                        requestBytes,
                        expectedRequestDigest: requestDigest,
                        resolveCurrentAuthority: (context) =>
                          context.subjectHumanId
                              === decodedRequest!.subjectHumanId
                            && context.operationId
                              === decodedRequest!.operationId
                            && context.committerDeviceId
                              === decodedRequest!.committerDeviceId
                            && context.committerDeviceSigningKeyGeneration
                              === decodedRequest!
                                .committerDeviceSigningKeyGeneration
                            && context.hostAuthorizationRevision
                              === decodedRequest!.hostAuthorizationRevision
                            ? signingPublicKey!.slice()
                            : null,
                      },
                    );
                  plan = decodeLiveShadowMessagePlanV3(planBytes);
                  planDigest = input.crypto.hash(planBytes);
                  if (
                    evidence.operationId !== plan.operationId
                    || evidence.operationId !== verifiedRequest.operationId
                    || !equalBytes(planDigest, verifiedRequest.planDigest)
                    || plan.subjectHumanId !== verifiedRequest.subjectHumanId
                    || plan.sessionId !== verifiedRequest.sessionId
                    || plan.roomId !== verifiedRequest.roomId
                    || plan.humanMessageId !== verifiedRequest.messageId
                    || plan.recipientAgentId
                      !== verifiedRequest.recipientAgentId
                    || plan.agentAuthorizationRevision
                      !== verifiedRequest.agentAuthorizationRevision
                    || plan.namespaceId !== verifiedRequest.namespaceId
                    || plan.namespaceAccessRevision
                      !== verifiedRequest.namespaceAccessRevision
                    || plan.namespaceKeyGeneration
                      !== verifiedRequest.namespaceKeyGeneration
                    || plan.committerDeviceId
                      !== verifiedRequest.committerDeviceId
                    || plan.committerDeviceSigningKeyGeneration
                      !== verifiedRequest.committerDeviceSigningKeyGeneration
                    || plan.hostAuthorizationRevision
                      !== verifiedRequest.hostAuthorizationRevision
                  ) continue;
                  liveSigners.set(evidence.operationId, Object.freeze({
                    agentId: plan.recipientAgentId,
                    runtimeGeneration: plan.agentRuntimeGeneration,
                    signerKeyId: plan.agentSignerKeyId,
                    signerPublicKey: plan.agentSignerPublicKey.slice(),
                  }));
                  humanPlaintextCommitments.set(
                    evidence.operationId,
                    verifiedRequest.plaintextPayloadDigest.slice(),
                  );
                } catch {
                  // A bad evidence item degrades only its own Agent rows.
                } finally {
                  wipe([planBytes, requestBytes, requestDigest, signingPublicKey, planDigest]);
                  if (decodedRequest) wipeOwnedByteFields(decodedRequest);
                  if (verifiedRequest) wipeOwnedByteFields(verifiedRequest);
                  if (plan) wipeOwnedByteFields(plan);
                }
              }
              try {
              const results: VaultRoomHistoryShadowRecordResultV1[] = [];
              for (const record of request.records) {
                if (record.kind === "human_edited_representation") {
                  results.push(fallback(record, "integrity_failure"));
                  continue;
                }
                if (record.kind === "existing_representation") {
                  results.push(readExistingRepresentation(input.crypto, request, record, retainedGenerations));
                  continue;
                }
                const dto = record.protectedMessage;
                const protectedPayload = dto.protectedPayload;
                if (protectedPayload.status !== "encrypted") {
                  results.push(fallback(
                    record,
                    "live_shadow_lifecycle_unavailable",
                  ));
                  continue;
                }
                let ordinary: Uint8Array | undefined;
                let encryptedBytes: Uint8Array | undefined;
                let manifestBytes: Uint8Array | undefined;
                let envelopeBytes: Uint8Array | undefined;
                const authorityBytes: Uint8Array[] = [];
                let humanSignerPublicKey: Uint8Array | null = null;
                let openedPayload: Uint8Array | null = null;
                let signerUnavailable = false;
                try {
                  const protectedOnly = record.representationMode === "protected-only";
                  if (!protectedSelectionMatches(record)) throw new TypeError("Protected history selection disagrees");
                  ordinary = protectedOnly ? undefined : fromBase64url(
                    "Room history ordinary payload",
                    record.ordinaryPayloadBytesBase64url,
                  );
                  encryptedBytes = fromBase64url(
                    "Room history protected payload",
                    protectedPayload.encryptedPayloadBytesBase64url,
                  );
                  manifestBytes = fromBase64url(
                    "Room history access manifest",
                    protectedPayload.accessManifestBytesBase64url,
                  );
                  envelopeBytes = fromBase64url(
                    "Room history Namespace envelope",
                    protectedPayload.namespaceEnvelopeBytesBase64url,
                  );
                  const ordinaryPayload = ordinary === undefined ? null : decodeMessagePayloadV2(ordinary);
                  if (ordinaryPayload !== null && !ordinarySiblingMatches(
                    dto,
                    ordinaryPayload,
                    record.ordinarySibling,
                  )) throw new TypeError("Room history ordinary sibling disagrees");
                  if (
                    dto.dtoVersion !== 2
                    || dto.projection.roomId !== request.sourceRoomId
                    || dto.projection.namespaceId
                      !== request.authority.namespaceId
                    || dto.projection.sessionId !== record.sessionId
                    || dto.projection.messageId !== record.messageId
                    || dto.projection.editRevision !== record.editRevision
                    || protectedPayload.payloadVersion !== 2
                    || protectedPayload.keyClass !== "ai"
                  ) throw new TypeError("Room history coordinates disagree");
                  const authorRole = liveShadowAuthorRole(dto.projection.role);
                  if (record.shadowOperationFamily === "shared_execution") {
                    const plan = sharedPlans.get(record.shadowOperationId);
                    if (plan === undefined || conflictingSharedPlans.has(record.shadowOperationId)) {
                      results.push(fallback(record, "signer_evidence_unavailable"));
                      continue;
                    }
                    if (plan.sessionId !== record.sessionId
                      || plan.recipientAgentId !== dto.projection.authorAgentId
                      || (authorRole !== "assistant" && authorRole !== "tool")
                      || record.editRevision !== 0
                      || plan.namespaceKeyGeneration !== record.namespaceGeneration
                      || plan.namespaceAccessRevision !== record.namespaceAccessRevision
                      || toBase64url(plan.namespaceHeadDigest) !== record.namespaceHeadDigestBase64url
                      || toBase64url(plan.namespacePublicationDigest) !== record.namespacePublicationDigestBase64url
                      || toBase64url(plan.namespacePublicationSetDigest) !== record.namespacePublicationSetDigestBase64url
                      || toBase64url(plan.namespaceAudienceFingerprint) !== record.namespaceAudienceFingerprintBase64url) {
                      throw new TypeError("Shared execution history binding disagrees");
                    }
                  }
                  if (
                    authorRole === null
                    || deriveLiveShadowMessageCryptoObjectIdV1({
                      operationId: record.shadowOperationId,
                      sessionId: record.sessionId,
                      messageId: Number(record.messageId),
                      revision: record.editRevision,
                      transcriptOrdinal: record.shadowTranscriptOrdinal,
                      authorRole,
                    }) !== protectedPayload.cryptoObjectId
                  ) throw new TypeError("Room history live Shadow identity disagrees");

                  const encryptedPayload = decodeEncryptedPayloadV2(
                    encryptedBytes,
                  );
                  const envelope = decodeNamespaceObjectEnvelopeV2(
                    envelopeBytes,
                  );
                  const decodedManifest = decodeObjectAccessManifestV2OrV3(
                    manifestBytes,
                  );
                  try {
                    if (decodedManifest.formatVersion === 2) {
                      const base = profile.baseProfile.baseProfile;
                      const retainedSigner = record.shadowOperationFamily === "shared_human"
                        ? humanSigners.get(record.shadowOperationId) : undefined;
                      humanSignerPublicKey = retainedSigner !== undefined
                        && retainedSigner.deviceId === decodedManifest.committerDeviceId
                        && retainedSigner.hostAuthorizationRevision === decodedManifest.hostAuthorizationRevision
                        ? retainedSigner.publicKey.slice()
                        : decodedManifest.committerDeviceId === base.deviceId
                          && decodedManifest.hostAuthorizationRevision
                            <= base.trustedHostAuthorizationRevision
                        ? base.signingPublicKey.slice()
                        : await input.resolveTrustedDeviceSigningPublicKey({
                          deviceId: decodedManifest.committerDeviceId,
                          hostAuthorizationRevision:
                            decodedManifest.hostAuthorizationRevision,
                          trustedDeviceRevision: base.trustedDeviceRevision,
                        });
                      signerUnavailable = humanSignerPublicKey === null;
                    }
                    const verified = decodedManifest.formatVersion === 2
                      ? (() => {
                        const manifestHash = input.crypto.hash(manifestBytes);
                        try {
                          return verifyObjectAccessManifestChain(input.crypto, {
                            manifestBytes,
                            proof: [],
                            trustedMinimumHead: {
                              objectId: objectId(decodedManifest.objectId),
                              payloadHash: decodedManifest.payloadHash,
                              accessRevision: accessRevision(
                                decodedManifest.accessRevision,
                              ),
                              manifestHash,
                            },
                            resolveSigningPublicKey: (deviceId) =>
                              deviceId === decodedManifest.committerDeviceId
                                ? humanSignerPublicKey?.slice() ?? null
                                : null,
                          });
                        } finally {
                          manifestHash.fill(0);
                        }
                      })()
                      : withClientObjectAccessSignerResolversV4({
                        crypto: input.crypto,
                        profile,
                        operation: (resolvers) => {
                          const sharedPlan = record.shadowOperationFamily === "shared_execution"
                            ? sharedPlans.get(record.shadowOperationId) : undefined;
                          // A different evidence family cannot replace the signer
                          // committed by this selected shared execution's plan.
                          const liveSigner = sharedPlan === undefined
                            ? liveSigners.get(record.shadowOperationId)
                            : {
                              agentId: sharedPlan.recipientAgentId,
                              runtimeGeneration: sharedPlan.agentRuntimeGeneration,
                              signerKeyId: sharedPlan.agentSignerKeyId,
                              signerPublicKey: sharedPlan.agentSignerPublicKey,
                            };
                          if (sharedPlan !== undefined
                            && decodedManifest.hostAuthorizationRevision !== sharedPlan.agentAuthorizationRevision) {
                            throw new TypeError("Shared execution signer authority disagrees");
                          }
                          const agentSignerPublicKey = liveSigner !== undefined
                              && liveSigner.agentId
                                === decodedManifest.signer.agentId
                              && liveSigner.runtimeGeneration
                                === decodedManifest.signer.runtimeGeneration
                              && liveSigner.signerKeyId
                                === decodedManifest.signer.signerKeyId
                            ? liveSigner.signerPublicKey.slice()
                            : sharedPlan === undefined && legacySignerEvidenceAvailable
                            ? resolvers.resolveAgentRuntimeSignerPublicKey(
                              decodedManifest.signer,
                            )
                            : null;
                          if (agentSignerPublicKey === null) {
                            signerUnavailable = true;
                          }
                          return verifyAgentObjectAccessManifest(input.crypto, {
                            manifestBytes: manifestBytes!,
                            resolveSignerPublicKey: (principal) =>
                              principal.agentId
                                  === decodedManifest.signer.agentId
                                && principal.runtimeGeneration
                                  === decodedManifest.signer.runtimeGeneration
                                && principal.signerKeyId
                                  === decodedManifest.signer.signerKeyId
                                ? agentSignerPublicKey?.slice() ?? null
                                : null,
                          });
                        },
                      });
                    try {
                      const encryptedDigest = input.crypto.hash(encryptedBytes);
                      const envelopeDigest = input.crypto.hash(envelopeBytes);
                      authorityBytes.push(encryptedDigest, envelopeDigest);
                      if (
                        verified.manifest.objectId
                          !== protectedPayload.cryptoObjectId
                        || !equalBytes(
                          verified.manifest.payloadHash,
                          encryptedDigest,
                        )
                        || verified.manifest.envelopeHashes.length !== 1
                        || !equalBytes(
                          verified.manifest.envelopeHashes[0]!,
                          envelopeDigest,
                        )
                        || encryptedPayload.context.objectId
                          !== protectedPayload.cryptoObjectId
                        || envelope.context.objectId
                          !== protectedPayload.cryptoObjectId
                        || envelope.context.namespaceId
                          !== request.authority.namespaceId
                        || envelope.context.keyClass !== "ai"
                        || envelope.context.keyGeneration
                          !== record.namespaceGeneration
                        || envelope.context.bindingRevisionAtWrap
                          !== record.namespaceAccessRevision
                        || verified.manifest.accessRevision !== 0
                      ) throw new TypeError("Room history protected bytes disagree");
                      if (
                        decodedManifest.formatVersion === 3
                        && (
                          dto.projection.authorAgentId
                            !== decodedManifest.signer.agentId
                          || (dto.projection.role !== "assistant"
                            && dto.projection.role !== "tool")
                        )
                      ) throw new TypeError("Room history Agent signer disagrees");
                      if (
                        decodedManifest.formatVersion === 2
                        && (
                          dto.projection.role !== "user"
                        )
                      ) throw new TypeError("Room history Human signer disagrees");

                      const headDigest = fromBase64url(
                        "Room history retained head digest",
                        record.namespaceHeadDigestBase64url,
                      );
                      const publicationDigest = fromBase64url(
                        "Room history retained publication digest",
                        record.namespacePublicationDigestBase64url,
                      );
                      const publicationSetDigest = fromBase64url(
                        "Room history retained publication-set digest",
                        record.namespacePublicationSetDigestBase64url,
                      );
                      const audienceFingerprint = fromBase64url(
                        "Room history retained audience fingerprint",
                        record.namespaceAudienceFingerprintBase64url,
                      );
                      authorityBytes.push(
                        headDigest,
                        publicationDigest,
                        publicationSetDigest,
                        audienceFingerprint,
                      );
                      const generation = retainedGenerations.find((entry) =>
                        entry.generation === record.namespaceGeneration
                        && entry.accessRevision === record.namespaceAccessRevision
                        && equalBytes(entry.headDigest, headDigest)
                        && equalBytes(entry.publicationDigest, publicationDigest)
                        && equalBytes(
                          entry.publicationSetDigest,
                          publicationSetDigest,
                        )
                        && equalBytes(
                          entry.audienceFingerprint,
                          audienceFingerprint,
                        )
                      );
                      if (generation === undefined) {
                        results.push(fallback(
                          record,
                          "retained_key_material_unavailable",
                        ));
                        continue;
                      }
                      openedPayload = decryptObjectThroughNamespace(
                        input.crypto,
                        generation.generationKey,
                        envelope,
                        encryptedPayload,
                      );
                      if (openedPayload === null) {
                        results.push(fallback(record, "integrity_failure"));
                        continue;
                      }
                      if (ordinary !== undefined && !equalBytes(openedPayload, ordinary)) {
                        results.push(fallback(record, "parity_mismatch"));
                        continue;
                      }
                      if (protectedOnly && decodedManifest.formatVersion === 2) {
                        const commitment = humanPlaintextCommitments.get(
                          record.shadowOperationId,
                        );
                        if (commitment === undefined) {
                          results.push(fallback(record, "signer_evidence_unavailable"));
                          continue;
                        }
                        const openedDigest = input.crypto.hash(openedPayload);
                        const matches = equalBytes(openedDigest, commitment);
                        openedDigest.fill(0);
                        if (!matches) {
                          results.push(fallback(record, "integrity_failure"));
                          continue;
                        }
                      }
                      const payload = decodeMessagePayloadV2(openedPayload);
                      if (!roleMatches(dto.projection.role, payload)) {
                        results.push(fallback(record, "integrity_failure"));
                        continue;
                      }
                      results.push(Object.freeze({
                        sessionId: record.sessionId,
                        messageId: record.messageId,
                        editRevision: record.editRevision,
                        status: "verified" as const,
                        verification: protectedOnly
                          ? "signed_representation_authenticated" as const
                          : "independent_parity" as const,
                        payload,
                      }));
                    } finally {
                      destroyVerifiedManifest(verified);
                    }
                  } catch {
                    results.push(fallback(
                      record,
                      signerUnavailable
                        ? "signer_evidence_unavailable"
                        : "integrity_failure",
                    ));
                  } finally {
                    decodedManifest.payloadHash.fill(0);
                    decodedManifest.previousManifestHash?.fill(0);
                    decodedManifest.envelopeHashes.forEach((hash) => hash.fill(0));
                    decodedManifest.signature.fill(0);
                    encryptedPayload.ciphertext.fill(0);
                    envelope.wrappedDek.fill(0);
                  }
                } catch {
                  results.push(fallback(record, "integrity_failure"));
                } finally {
                  wipe([
                    ordinary,
                    encryptedBytes,
                    manifestBytes,
                    envelopeBytes,
                    humanSignerPublicKey,
                    openedPayload,
                    ...authorityBytes,
                  ]);
                }
              }
              return Object.freeze(results);
              } finally {
                for (const signer of liveSigners.values()) {
                  signer.signerPublicKey.fill(0);
                }
                for (const signer of humanSigners.values()) signer.publicKey.fill(0);
                for (const commitment of humanPlaintextCommitments.values()) {
                  commitment.fill(0);
                }
                for (const plan of sharedPlans.values()) wipeOwnedByteFields(plan);
              }
            } finally {
              destroyOpenedClientDeviceProfileV4(profile);
            }
            },
          );
        } catch {
          return CUSTODY_UNAVAILABLE;
        }
      });
      if (opened.status === "unavailable") {
        return finish(allFallback(
          request.records,
          "current_read_authority_unavailable",
        ));
      }
      if (opened.value === CUSTODY_UNAVAILABLE) {
        return finish(allFallback(
          request.records,
          CUSTODY_UNAVAILABLE,
        ));
      }
      return finish(opened.value);
    } finally {
      wipe(decodedAuthority.temporaryBytes);
    }
  };

  return Object.freeze({ reconcile });
}
