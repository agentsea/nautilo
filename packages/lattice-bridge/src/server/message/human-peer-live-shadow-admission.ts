import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  encodeHumanPeerLiveShadowMessagePlanV1,
} from "@nautilo/lattice-crypto/wire";
import {
  encodeProtectedMessageDtoV2,
  parseProtectedMessageDtoV2,
  type ProtectedMessageDtoV2,
} from "@nautilo/types";

import type {
  ConversationProductStorePort,
  ConversationRepository,
} from "../../message/conversation-repository.ts";
import {
  admitHumanPeerLiveShadowMessage,
} from "../../message/human-peer-live-shadow-message-admission.ts";

interface HumanPeerLiveShadowPreparedAttemptBase {
  readonly operationId: string;
  readonly planBytes: Uint8Array;
  readonly requestBytes: Uint8Array;
  readonly encryptedPayloadBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly envelopeBytes: Uint8Array;
  readonly now: number;
}

export type HumanPeerLiveShadowPreparedAttempt =
  HumanPeerLiveShadowPreparedAttemptBase & (
    | Readonly<{ representationMode?: "shadow_encryption"; expectedContent: string; ordinaryPayloadBytes: Uint8Array }>
    | Readonly<{ representationMode: "full_encryption"; expectedContent?: never; ordinaryPayloadBytes?: never }>
  );

export type HumanPeerLiveShadowAdmissionResult =
  | Readonly<{
      status: "human_verified" | "human_replayed";
      operationId: string;
      messageId: number;
      content: string;
      protectedMessage: ProtectedMessageDtoV2;
      protectedMessageDigest: Uint8Array;
      /** Current enrolled sender-device evidence for peer verification. */
      senderDeviceSigningPublicKey: Uint8Array;
      representationMode?: "shadow_encryption";
    }>
  | Readonly<{
      status: "human_verified" | "human_replayed";
      representationMode: "full_encryption";
      operationId: string;
      messageId: number;
      protectedMessage: ProtectedMessageDtoV2;
      protectedMessageDigest: Uint8Array;
      senderDeviceSigningPublicKey: Uint8Array;
    }>
  | Readonly<{
      status: "ordinary_fallback";
      operationId: string;
      reason:
        | "request_invalid"
        | "authority_stale"
        | "human_parity_failed"
        | "human_persistence_failed"
        | "deadline_expired"
        | "integrity_conflict";
      messageId: number | null;
    }>;

export interface HumanPeerLiveShadowAdmissionDependencies {
  readonly crypto: LatticeCrypto;
  readonly product: ConversationProductStorePort;
  readonly conversation: ConversationRepository;
  readonly sourceUserId: string;
  readonly resolveCurrentHumanAuthority: Parameters<
    typeof admitHumanPeerLiveShadowMessage
  >[0]["resolveCurrentHumanAuthority"];
  readonly senderDeviceSigningPublicKey: Uint8Array;
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function fallback(
  operationId: string,
  reason: Extract<HumanPeerLiveShadowAdmissionResult, {
    status: "ordinary_fallback";
  }>["reason"],
  messageId: number | null = null,
): HumanPeerLiveShadowAdmissionResult {
  return Object.freeze({
    status: "ordinary_fallback" as const,
    operationId,
    reason,
    messageId,
  });
}

function destroyPlan(plan: Awaited<
  ReturnType<typeof admitHumanPeerLiveShadowMessage>
>["plan"]): void {
  plan.namespaceHeadDigest.fill(0);
  plan.namespacePublicationDigest.fill(0);
  plan.namespacePublicationSetDigest.fill(0);
  plan.namespaceAudienceFingerprint.fill(0);
}

/** Admit, append, and complete one exact same-row Human-only sibling. */
export async function admitAndPersistHumanPeerLiveShadowMessage(
  deps: HumanPeerLiveShadowAdmissionDependencies,
  input: HumanPeerLiveShadowPreparedAttempt,
): Promise<HumanPeerLiveShadowAdmissionResult> {
  const full = input.representationMode === "full_encryption";
  let admitted: Awaited<ReturnType<typeof admitHumanPeerLiveShadowMessage>>;
  try {
    admitted = await admitHumanPeerLiveShadowMessage({
      crypto: deps.crypto,
      expectedPlanBytes: input.planBytes,
      requestBytes: input.requestBytes,
      ...(full ? { contentRepresentation: "full" as const } : {
        ordinaryPayloadBytes: input.ordinaryPayloadBytes,
      }),
      encryptedPayloadBytes: input.encryptedPayloadBytes,
      manifestBytes: input.manifestBytes,
      envelopeBytes: input.envelopeBytes,
      now: input.now,
      resolveCurrentHumanAuthority: deps.resolveCurrentHumanAuthority,
    });
  } catch {
    return fallback(input.operationId, "request_invalid");
  }
  const plan = admitted.plan;
  try {
    if (plan.operationId !== input.operationId) {
      return fallback(input.operationId, "integrity_conflict");
    }
    if (!full && admitted.ordinaryContent !== input.expectedContent) {
      return fallback(input.operationId, "human_parity_failed");
    }
    if (input.now >= plan.deadlineAt) {
      return fallback(input.operationId, "deadline_expired");
    }
    const planDigest = deps.crypto.hash(
      encodeHumanPeerLiveShadowMessagePlanV1(plan),
    );
    let allocated;
    try {
      allocated = await deps.product.appendAllocated({
        sessionId: plan.sessionId,
        idempotencyKey: plan.operationId,
        content: admitted.ordinaryContent,
        publicationPolicy: {
          expectedRevision: plan.policyRevision,
          representation: full ? "protected_only" as const
            : "ordinary_and_protected" as const,
        },
        keyClass: "human",
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
        humanPeerLiveShadow: {
          operationId: plan.operationId,
          reservedMessageId: plan.humanMessageId,
          createdAt: plan.createdAt,
          transcriptOrdinal: plan.transcriptOrdinal,
          cryptoObjectId: admitted.prepared.objectId,
          planDigest,
          planBytes: input.planBytes,
          requestBytes: input.requestBytes,
        },
      });
    } finally {
      planDigest.fill(0);
    }
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
        sourceUserId: deps.sourceUserId,
        role: "user",
        createdAt: new Date(plan.createdAt).toISOString(),
        editRevision: 0,
      },
      protectedPayload: {
        status: "encrypted",
        cryptoObjectId: admitted.prepared.objectId,
        payloadVersion: 2,
        keyClass: "human",
        encryptedPayloadBytesBase64url: base64url(
          input.encryptedPayloadBytes,
        ),
        accessManifestBytesBase64url: base64url(input.manifestBytes),
        namespaceEnvelopeBytesBase64url: base64url(input.envelopeBytes),
      },
    });
    const protectedMessageBytes = new TextEncoder().encode(
      encodeProtectedMessageDtoV2(protectedMessage),
    );
    try {
      return Object.freeze({
        status: allocated.status === "replayed"
          ? "human_replayed" as const
          : "human_verified" as const,
        operationId: plan.operationId,
        messageId: plan.humanMessageId,
        ...(full ? { representationMode: "full_encryption" as const } : {
          content: admitted.ordinaryContent!,
        }),
        protectedMessage,
        protectedMessageDigest: deps.crypto.hash(protectedMessageBytes),
        senderDeviceSigningPublicKey:
          deps.senderDeviceSigningPublicKey.slice(),
      });
    } finally {
      protectedMessageBytes.fill(0);
    }
  } finally {
    admitted.requestDigest.fill(0);
    admitted.plaintextPayloadDigest.fill(0);
    destroyPlan(plan);
  }
}
