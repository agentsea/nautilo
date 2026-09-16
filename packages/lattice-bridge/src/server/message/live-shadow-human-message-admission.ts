import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  parseProtectedMessageDtoV2,
  type ProtectedMessageDtoV2,
} from "@nautilo/types";

import type {
  ConversationProductStorePort,
  ConversationRepository,
} from "../../message/conversation-repository.ts";
import type {
  AdmittedForegroundSessionHumanLiveShadowMessage,
} from "../../message/human-foreground-session-live-shadow-message-admission.ts";
import type { LiveShadowForegroundAuthorizationScope } from
  "./postgres-live-shadow-turn-plan.ts";

export type ForegroundLiveShadowSessionExecutionCapability = Readonly<{
  readonly kind: "foreground_session";
  readonly sessionReference: string;
  readonly authorizationDigest: Uint8Array;
  readonly scope: LiveShadowForegroundAuthorizationScope;
}>;

export type LiveShadowExecutionCapability =
  ForegroundLiveShadowSessionExecutionCapability;

export type LiveShadowHumanAdmissionResult =
  | Readonly<{
      status: "human_verified";
      operationId: string;
      messageId: number;
      content: string;
      protectedMessage: ProtectedMessageDtoV2;
      capability: LiveShadowExecutionCapability;
    }>
  | Readonly<{
      status: "human_replayed";
      operationId: string;
      messageId: number;
      content: string;
      protectedMessage: ProtectedMessageDtoV2;
      jobId: string | null;
    }>
  | Readonly<{
      status: "ordinary_fallback";
      operationId: string;
      reason:
        | "request_invalid"
        | "authority_stale"
        | "grant_invalid"
        | "protected_open_failed"
        | "human_parity_failed"
        | "human_persistence_failed"
        | "deadline_expired"
        | "restart_lost"
        | "agent_capacity_unavailable"
        | "integrity_conflict";
      messageId: number | null;
    }>;

interface HumanPreparedAttemptCoordinates {
  readonly operationId: string;
  readonly clientActionSessionId: string;
  readonly userId: string;
  readonly actorId: string;
  readonly planBytes: Uint8Array;
  readonly requestBytes: Uint8Array;
  readonly encryptedPayloadBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly envelopeBytes: Uint8Array;
  readonly grantBytes: Uint8Array;
  readonly authorizationScheme?: "foreground_session_v1" | null;
  readonly now: number;
}

export type LiveShadowHumanPreparedAttempt = HumanPreparedAttemptCoordinates & (
  | Readonly<{
    representationMode?: "shadow_encryption";
    /** Exact ordinary request-body sibling; never trusted as Agent input. */
    expectedContent: string;
    ordinaryPayloadBytes: Uint8Array;
  }>
  | Readonly<{
    representationMode: "full_encryption";
    expectedContent?: never;
    ordinaryPayloadBytes?: never;
  }>
);

export interface LiveShadowHumanAdmissionDependencies {
  readonly crypto: LatticeCrypto;
  readonly product: ConversationProductStorePort;
  readonly conversation: ConversationRepository;
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function fallback(
  operationId: string,
  reason: Extract<LiveShadowHumanAdmissionResult, {
    status: "ordinary_fallback";
  }>["reason"],
  messageId: number | null = null,
): LiveShadowHumanAdmissionResult {
  return Object.freeze({
    status: "ordinary_fallback" as const,
    operationId,
    reason,
    messageId,
  });
}

/** Persist an already-authenticated/self-opened V4 Human sibling exactly once. */
export async function persistForegroundSessionHumanLiveShadowMessage(
  deps: Pick<
    LiveShadowHumanAdmissionDependencies,
    "crypto" | "product" | "conversation"
  >,
  input: LiveShadowHumanPreparedAttempt,
  admitted: AdmittedForegroundSessionHumanLiveShadowMessage,
  capability: ForegroundLiveShadowSessionExecutionCapability,
  /** Full only: transient, independently opened under the bounded grant. */
  openedContent?: string,
): Promise<LiveShadowHumanAdmissionResult> {
  const plan = admitted.plan;
  const full = input.representationMode === "full_encryption";
  if (
    plan.operationId !== input.operationId
    || (admitted.contentRepresentation === "full") !== full
    || (full
      ? typeof openedContent !== "string"
        || "ordinaryPayloadBytes" in input || "expectedContent" in input
      : admitted.ordinaryContent !== input.expectedContent)
  ) {
    return fallback(
      input.operationId,
      plan.operationId === input.operationId
        ? "human_parity_failed"
        : "integrity_conflict",
    );
  }
  const planDigest = deps.crypto.hash(input.planBytes);
  try {
    const allocated = await deps.product.appendAllocated({
      sessionId: plan.sessionId,
      idempotencyKey: plan.operationId,
      content: admitted.ordinaryContent,
      publicationPolicy: {
        expectedRevision: plan.policyRevision,
        representation: full ? "protected_only" as const
          : "ordinary_and_protected" as const,
      },
      keyClass: "ai",
      authorRole: "user",
      toolCalls: null,
      toolName: null,
      fingerprint: plan.operationId,
      humanTurnId: plan.operationId,
      transcriptOrigin: "main",
      parentThreadId: null,
      scopeId: null,
      metadata: null,
      subthreadRoomId: null,
      replyToMessageId: null,
      notificationContext: {
        mentionedHumanUserIds: [],
        causalHumanUserId: null,
        causalHumanTurnId: null,
      },
      structuralProjection: {
        notificationEligibility: "eligible",
        subthreadReplyClassification: "counted",
      },
      requestDigest: admitted.requestDigest,
      liveShadow: {
        operationId: plan.operationId,
        reservedMessageId: plan.humanMessageId,
        createdAt: plan.createdAt,
        transcriptOrdinal: 1,
        cryptoObjectId: admitted.prepared.objectId,
        planDigest,
        planBytes: input.planBytes,
        requestBytes: input.requestBytes,
        grantDigest: capability.authorizationDigest,
      },
    });
    if (allocated.status === "conflict") {
      return fallback(input.operationId, "integrity_conflict");
    }
    try {
      const completed = await deps.conversation.completeRevision({
        messageId: plan.humanMessageId,
        expectedRevision: 0,
        parityStatus: full ? "client_authenticated" : "client_verified",
        prepared: admitted.prepared,
      });
      if (completed.status === "orphaned") {
        return fallback(
          input.operationId,
          "human_persistence_failed",
          plan.humanMessageId,
        );
      }
    } catch {
      return fallback(
        input.operationId,
        "human_persistence_failed",
        plan.humanMessageId,
      );
    }
    const protectedMessage = parseProtectedMessageDtoV2({
      dtoVersion: 2,
      projection: {
        messageId: String(plan.humanMessageId),
        sessionId: plan.sessionId,
        roomId: plan.roomId,
        namespaceId: plan.namespaceId,
        role: "user",
        createdAt: new Date(plan.createdAt).toISOString(),
        editRevision: 0,
      },
      protectedPayload: {
        status: "encrypted",
        cryptoObjectId: admitted.prepared.objectId,
        payloadVersion: 2,
        keyClass: "ai",
        encryptedPayloadBytesBase64url: base64url(input.encryptedPayloadBytes),
        accessManifestBytesBase64url: base64url(input.manifestBytes),
        namespaceEnvelopeBytesBase64url: base64url(input.envelopeBytes),
      },
    });
    return Object.freeze({
      status: "human_verified" as const,
      operationId: plan.operationId,
      messageId: plan.humanMessageId,
      // Durable Full storage above has no body. This value remains transient
      // inside the server's already-authorized foreground execution owner.
      content: full ? openedContent! : admitted.ordinaryContent!,
      protectedMessage,
      capability,
    });
  } finally {
    planDigest.fill(0);
  }
}
