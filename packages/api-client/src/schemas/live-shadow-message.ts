import { z } from "zod";
import { protectedMessageDtoV2Schema } from "@nautilo/types";

const portableId = z.string().min(1).max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const maximumBase64urlCharacters = (rawBytes: number) =>
  Math.ceil(rawBytes * 4 / 3);
const base64urlBytes = (maximumCharacters: number) =>
  z.string().min(1).max(maximumCharacters)
    .regex(/^[A-Za-z0-9_-]+$/u)
    .refine((value) => value.length % 4 !== 1);
const bytes = base64urlBytes(1_398_102);
export const LIVE_SHADOW_MESSAGE_PLAN_RAW_BYTES = 8 * 1024 * 1024;
export const LIVE_SHADOW_AUTHORIZATION_RAW_BYTES = 16 * 1024 * 1024;
export const LIVE_SHADOW_SIGNED_REQUEST_RAW_BYTES = 18 * 1024 * 1024;
export const LIVE_SHADOW_AGENT_GRANT_DOMAIN_COUNT = 16_384;
// A canonical foreground plan may carry the complete bounded Agent-readable
// Domain authority inventory. These bounds mirror the current V2 Domain
// authorization and V4 live-Shadow wire ceilings after unpadded base64url
// encoding. A parity test keeps the independently owned packages aligned.
const liveShadowMessagePlanBytes = base64urlBytes(
  maximumBase64urlCharacters(LIVE_SHADOW_MESSAGE_PLAN_RAW_BYTES),
);
const liveShadowAuthorizationBytes = base64urlBytes(
  maximumBase64urlCharacters(LIVE_SHADOW_AUTHORIZATION_RAW_BYTES),
);
const liveShadowSignedRequestBytes = base64urlBytes(
  maximumBase64urlCharacters(LIVE_SHADOW_SIGNED_REQUEST_RAW_BYTES),
);
const sha256Bytes = bytes.length(43);

export const liveShadowMessagePlanRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  clientActionSessionId: portableId,
  clientDeviceId: portableId,
  idempotencyKey: portableId,
  requestShape: z.literal("text_only"),
}).strict();

/** Explicit opt-in to five-minute Human submission freshness, not execution authority. */
export const liveShadowMessagePlanRequestV2Schema =
  liveShadowMessagePlanRequestV1Schema.extend({ requestVersion: z.literal(2) });
export const liveShadowMessagePlanRequestSchema = z.union([
  liveShadowMessagePlanRequestV1Schema,
  liveShadowMessagePlanRequestV2Schema,
]);

const liveShadowMessageUnavailableResponseV1Schema = z.object({
  responseVersion: z.literal(1),
  status: z.literal("unavailable"),
  authorizationScheme: z.enum([
    "human_peer_v1",
    "shared_agent_v1",
    "human_ai_readable_v1",
    "human_ai_readable_v2",
  ]).optional(),
  reason: z.enum([
    "policy_unavailable",
    "device_unavailable",
    "agent_authority_unavailable",
    "domain_unavailable",
    "namespace_unavailable",
    "recipient_sync_required",
    "reservation_unavailable",
  ]),
  requiredNamespaceIds: z.array(portableId).min(1)
    .max(LIVE_SHADOW_AGENT_GRANT_DOMAIN_COUNT).optional(),
}).strict().superRefine((value, context) => {
  const required = value.reason === "namespace_unavailable"
    || value.reason === "recipient_sync_required";
  if (required !== (value.requiredNamespaceIds !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "Namespace readiness coordinates are incoherent",
    });
    return;
  }
  if (
    value.requiredNamespaceIds !== undefined
    && (
      new Set(value.requiredNamespaceIds).size
        !== value.requiredNamespaceIds.length
      || value.requiredNamespaceIds.some((entry, index) =>
        index > 0 && value.requiredNamespaceIds![index - 1]! >= entry
      )
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Namespace readiness coordinates must be canonical",
    });
  }
});

export const liveShadowMessagePlanResponseV1Schema =
  z.union([
    z.object({
      responseVersion: z.literal(1),
      status: z.literal("disabled"),
      mode: z.literal("plaintext_only"),
    }).strict(),
    z.object({
      responseVersion: z.literal(1),
      status: z.literal("ineligible"),
      reason: z.enum([
        "client_not_browser",
        "room_topology_unsupported",
        "request_shape_unsupported",
      ]),
    }).strict(),
    liveShadowMessageUnavailableResponseV1Schema,
    z.object({
      responseVersion: z.literal(1),
      status: z.literal("planned"),
      planBytesBase64url: liveShadowMessagePlanBytes,
      authorizationScheme: z.literal("human_ai_readable_v2").optional(),
      representationMode: z.literal("full_encryption").optional(),
    }).strict(),
  ]);

const liveShadowMessagePreparedRequestBaseV1Schema = z.object({
  requestVersion: z.literal(1),
  status: z.literal("prepared"),
  operationId: portableId,
  planBytesBase64url: liveShadowMessagePlanBytes,
  signedRequestBytesBase64url: liveShadowSignedRequestBytes,
  ordinaryPayloadBytesBase64url: bytes,
  encryptedPayloadBytesBase64url: bytes,
  accessManifestBytesBase64url: bytes,
  namespaceEnvelopeBytesBase64url: bytes,
});

const fullEncryptionMessagePreparedRequestBaseV2Schema =
  liveShadowMessagePreparedRequestBaseV1Schema.omit({
    ordinaryPayloadBytesBase64url: true,
  }).extend({
    requestVersion: z.literal(2),
    representationMode: z.literal("full_encryption"),
  });

export const liveShadowMessagePreparedRequestV1Schema = z.union([
  liveShadowMessagePreparedRequestBaseV1Schema.extend({
    grantBytesBase64url: bytes,
  }).strict(),
  liveShadowMessagePreparedRequestBaseV1Schema.extend({
    authorizationScheme: z.literal("foreground_session_v1"),
  }).strict(),
  liveShadowMessagePreparedRequestBaseV1Schema.extend({
    authorizationScheme: z.literal("human_peer_v1"),
  }).strict(),
  liveShadowMessagePreparedRequestBaseV1Schema.extend({
    authorizationScheme: z.literal("shared_agent_v1"),
  }).strict(),
  liveShadowMessagePreparedRequestBaseV1Schema.extend({
    authorizationScheme: z.literal("human_ai_readable_v1"),
  }).strict(),
  liveShadowMessagePreparedRequestBaseV1Schema.extend({
    authorizationScheme: z.literal("human_ai_readable_v2"),
  }).strict(),
]);

export const fullEncryptionMessagePreparedRequestV2Schema = z.union([
  fullEncryptionMessagePreparedRequestBaseV2Schema.extend({
    grantBytesBase64url: bytes,
  }).strict(),
  fullEncryptionMessagePreparedRequestBaseV2Schema.extend({
    authorizationScheme: z.literal("foreground_session_v1"),
  }).strict(),
  fullEncryptionMessagePreparedRequestBaseV2Schema.extend({
    authorizationScheme: z.literal("human_peer_v1"),
  }).strict(),
  fullEncryptionMessagePreparedRequestBaseV2Schema.extend({
    authorizationScheme: z.literal("shared_agent_v1"),
  }).strict(),
  fullEncryptionMessagePreparedRequestBaseV2Schema.extend({
    authorizationScheme: z.literal("human_ai_readable_v1"),
  }).strict(),
  fullEncryptionMessagePreparedRequestBaseV2Schema.extend({
    authorizationScheme: z.literal("human_ai_readable_v2"),
  }).strict(),
]);

export const fullEncryptionMessageSubmissionV2Schema = z.object({
  submissionVersion: z.literal(2),
  representationMode: z.literal("full_encryption"),
  prepared: fullEncryptionMessagePreparedRequestV2Schema,
}).strict();

export const humanMessageEditPlanRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  clientDeviceId: portableId,
  expectedRevision: z.number().int().nonnegative().max(2_147_483_647),
  clientIdempotencyKey: portableId,
}).strict();

export const humanMessageEditPlanResponseV1Schema = z.union([
  z.object({
    responseVersion: z.literal(1),
    status: z.literal("planned"),
    representationMode: z.literal("full_encryption"),
    planBytesBase64url: liveShadowMessagePlanBytes,
  }).strict(),
  z.object({
    responseVersion: z.literal(1),
    status: z.literal("unavailable"),
    reason: z.enum([
      "policy_unavailable",
      "device_unavailable",
      "authority_unavailable",
      "namespace_unavailable",
      "recipient_sync_required",
      "reservation_unavailable",
      "message_unavailable",
      "revision_conflict",
    ]),
  }).strict(),
]);

const humanMessageEditPreparedTargetV1Schema = z.object({
  sessionId: z.string().uuid(),
  messageId: z.number().int().positive(),
  encryptedPayloadBytesBase64url: bytes,
  accessManifestBytesBase64url: bytes,
  namespaceEnvelopeBytesBase64url: bytes,
}).strict();

export const humanMessageEditPreparedRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  representationMode: z.literal("full_encryption"),
  planBytesBase64url: liveShadowMessagePlanBytes,
  signedRequestBytesBase64url: liveShadowSignedRequestBytes,
  preparedTargets: z.array(humanMessageEditPreparedTargetV1Schema).min(1),
}).strict().superRefine((value, context) => {
  const coordinates = value.preparedTargets.map((target) =>
    `${target.sessionId}\u0000${target.messageId.toString().padStart(16, "0")}`
  );
  if (coordinates.some((coordinate, index) =>
    index > 0 && coordinates[index - 1]! >= coordinate
  )) {
    context.addIssue({
      code: "custom",
      message: "Prepared Human edit targets must be unique and canonically ordered",
    });
  }
});

export const humanMessageEditPreparedResponseV1Schema = z.object({
  responseVersion: z.literal(1),
  status: z.literal("published"),
  representationMode: z.literal("full_encryption"),
  editRevision: z.number().int().nonnegative().max(2_147_483_647),
  targets: z.array(z.object({
    sessionId: z.string().uuid(),
    messageId: z.number().int().positive(),
    cryptoObjectId: portableId,
  }).strict()).min(1),
}).strict();

export const sharedAgentExecutionAuthorizationRequestV1Schema =
  z.union([
    liveShadowMessagePreparedRequestBaseV1Schema.extend({
      authorizationScheme: z.literal("foreground_session_v1"),
      clientActionSessionId: portableId,
    }).strict(),
    z.object({
      requestVersion: z.literal(1),
      status: z.literal("prepared"),
      operationId: portableId,
      clientActionSessionId: portableId,
      authorizationScheme: z.literal("runtime_foreground_v1"),
      authorizationPlanBytesBase64url: liveShadowMessagePlanBytes,
      authorizationBytesBase64url: liveShadowAuthorizationBytes,
    }).strict(),
  ]);

export const sharedAgentExecutionAuthorizationResponseV1Schema = z.object({
  responseVersion: z.literal(1),
  status: z.enum(["authorized", "replayed", "unavailable"]),
  executionId: portableId,
}).strict();

export const runtimeInvocationAuthorizationRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  status: z.literal("prepared"),
  operationId: portableId,
  clientActionSessionId: portableId,
  authorizationScheme: z.literal("runtime_foreground_v1"),
  authorizationPlanBytesBase64url: liveShadowMessagePlanBytes,
  authorizationBytesBase64url: liveShadowAuthorizationBytes,
}).strict();

export const runtimeInvocationAuthorizationResponseV1Schema = z.object({
  responseVersion: z.literal(1),
  status: z.enum(["authorized", "replayed", "unavailable"]),
  invocationId: portableId,
}).strict();

export const liveShadowMessageClientUnavailableRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  status: z.literal("client_unavailable"),
  operationId: portableId,
  planBytesBase64url: liveShadowMessagePlanBytes,
  reason: z.enum([
    "profile_unavailable",
    "profile_invalid",
    "plan_stale",
    "namespace_unavailable",
    "domain_unavailable",
    "content_invalid",
    "journal_unavailable",
    "journal_full",
    "preparation_failed",
  ]),
}).strict();

export const liveShadowMessageSendAttemptV1Schema = z.union([
  liveShadowMessagePreparedRequestV1Schema,
  fullEncryptionMessagePreparedRequestV2Schema,
  liveShadowMessageClientUnavailableRequestV1Schema,
  // A failed plan has no operation or authority bytes. This is a diagnostic,
  // never evidence that protected handling happened or permission to persist.
  z.object({
    requestVersion: z.literal(1),
    status: z.literal("plan_unavailable"),
    reason: z.enum([
      "policy_unavailable",
      "device_unavailable",
      "agent_authority_unavailable",
      "domain_unavailable",
      "namespace_unavailable",
      "recipient_sync_required",
      "reservation_unavailable",
      "client_not_browser",
      "room_topology_unsupported",
      "request_shape_unsupported",
      "request_failed",
      "invalid_plan",
    ]),
  }).strict(),
]);

export const liveShadowMessageSendResultV1Schema = z.discriminatedUnion(
  "status",
  [
    z.object({
      responseVersion: z.literal(1),
      status: z.literal("human_verified"),
      operationId: portableId,
      protectedMessage: protectedMessageDtoV2Schema,
    }).strict(),
    z.object({
      responseVersion: z.literal(1),
      status: z.literal("ordinary_fallback"),
      operationId: portableId,
      reason: z.enum([
        "request_invalid",
        "authority_stale",
        "grant_invalid",
        "protected_open_failed",
        "human_parity_failed",
        "human_persistence_failed",
        "deadline_expired",
        "restart_lost",
        "agent_capacity_unavailable",
        "integrity_conflict",
      ]),
    }).strict(),
  ],
);

export const liveShadowMessageClientVerificationRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  operationId: portableId,
  verificationBytesBase64url: bytes.max(349_526),
}).strict();

export const liveShadowMessageClientVerificationResponseV1Schema = z.object({
  responseVersion: z.literal(1),
  status: z.enum(["verified", "replayed"]),
  operationId: portableId,
}).strict();

const createLiveShadowAcknowledgementRequestV1Schema = () => z.object({
  requestVersion: z.literal(1),
  operationId: portableId,
  acknowledgementBytesBase64url: bytes.max(349_526),
}).strict();

const createLiveShadowAcknowledgementPlanRequestV1Schema = () => z.object({
  requestVersion: z.literal(1),
  operationId: portableId,
  clientDeviceId: portableId,
}).strict();

const createLiveShadowAcknowledgementPlanResponseV1Schema = () =>
  z.discriminatedUnion("status", [
    z.object({
      responseVersion: z.literal(1),
      status: z.literal("ready"),
      subjectHumanId: portableId,
      clientDeviceId: portableId,
      clientDeviceSigningKeyGeneration:
        z.number().int().nonnegative().safe(),
      hostAuthorizationRevision: z.number().int().nonnegative().safe(),
    }).strict(),
    z.object({
      responseVersion: z.literal(1),
      status: z.literal("unavailable"),
      reason: z.enum([
        "operation_unavailable",
        "current_read_authority_unavailable",
      ]),
    }).strict(),
  ]);

const createLiveShadowAcknowledgementResponseV1Schema = () => z.object({
  responseVersion: z.literal(1),
  operationId: portableId,
  status: z.enum(["verified", "replayed"]),
}).strict();

export const humanPeerLiveShadowAcknowledgementRequestV1Schema =
  createLiveShadowAcknowledgementRequestV1Schema();
export const humanPeerLiveShadowAcknowledgementPlanRequestV1Schema =
  createLiveShadowAcknowledgementPlanRequestV1Schema();
export const humanPeerLiveShadowAcknowledgementPlanResponseV1Schema =
  createLiveShadowAcknowledgementPlanResponseV1Schema();
export const humanPeerLiveShadowAcknowledgementResponseV1Schema =
  createLiveShadowAcknowledgementResponseV1Schema();

// M296 uses the same transport bounds as M295, but keeps a separate endpoint
// and protocol name so Human-key evidence cannot be confused with AI-key
// shared-Room evidence.
export const sharedAgentLiveShadowAcknowledgementRequestV1Schema =
  createLiveShadowAcknowledgementRequestV1Schema();
export const sharedAgentLiveShadowAcknowledgementPlanRequestV1Schema =
  createLiveShadowAcknowledgementPlanRequestV1Schema();
export const sharedAgentLiveShadowAcknowledgementPlanResponseV1Schema =
  createLiveShadowAcknowledgementPlanResponseV1Schema();
export const sharedAgentLiveShadowAcknowledgementResponseV1Schema =
  createLiveShadowAcknowledgementResponseV1Schema();
export const sharedAgentOutputReadPlanRequestV1Schema =
  createLiveShadowAcknowledgementPlanRequestV1Schema();
export const sharedAgentOutputReadPlanResponseV1Schema =
  createLiveShadowAcknowledgementPlanResponseV1Schema();

const liveShadowRecoveryHumanV1Schema = z.object({
  protectedMessage: protectedMessageDtoV2Schema,
}).strict();

const liveShadowRecoveryDurableEventV1Schema = z.object({
  wireVersion: z.literal(1),
  type: z.literal("message.shadow_durable"),
  laneKey: z.string().startsWith("room:"),
  operationId: portableId,
  policyRevision: z.number().int().positive().safe(),
  transcriptOrdinal: z.number().int().min(2).max(256).safe(),
  ordinaryPayloadBytesBase64url: bytes,
  protectedMessage: protectedMessageDtoV2Schema,
  durableEventDigestBase64url: sha256Bytes,
}).strict();

const fullEncryptionRecoveryDurableEventV2Schema =
  liveShadowRecoveryDurableEventV1Schema.omit({
    ordinaryPayloadBytesBase64url: true,
  }).extend({
    wireVersion: z.literal(2),
    representationMode: z.literal("full_encryption"),
  }).strict();

export const liveShadowMessageRecoveryResponseV1Schema =
  z.discriminatedUnion("status", [
    z.object({
      responseVersion: z.literal(1),
      status: z.literal("human_published"),
      operationId: portableId,
      authorizationScheme: z.enum(["human_peer_v1", "shared_agent_v1", "human_ai_readable_v1", "human_ai_readable_v2"]),
      acceptedHumanRequestDigestBase64url: sha256Bytes,
      human: liveShadowRecoveryHumanV1Schema,
    }).strict(),
    z.object({
      responseVersion: z.literal(1),
      status: z.literal("absent"),
    }).strict(),
    z.object({
      responseVersion: z.literal(1),
      status: z.literal("pending"),
      state: z.enum(["planned", "human_verified", "running"]),
      jobId: z.string().uuid().nullable(),
      human: liveShadowRecoveryHumanV1Schema.optional(),
    }).strict(),
    z.object({
      responseVersion: z.literal(1),
      status: z.literal("completed"),
      state: z.enum(["completed", "client_verified"]),
      jobId: z.string().uuid(),
      human: liveShadowRecoveryHumanV1Schema,
      durableEvents: z.array(liveShadowRecoveryDurableEventV1Schema)
        .min(1).max(255),
    }).strict(),
    z.object({
      responseVersion: z.literal(1),
      status: z.literal("fallback"),
      state: z.enum(["fallback", "failed"]),
      jobId: z.string().uuid().nullable(),
      reason: z.enum([
        "protected_unavailable",
        "stale_authority",
        "integrity_failure",
        "parity_mismatch",
        "deadline_expired",
        "recipient_lost",
        "cancelled",
        "product_conflict",
        "policy_changed",
        "authority_changed",
        "stream_incomplete",
        "client_unavailable",
        "unsupported_payload",
        "storage_failure",
        "transport_failure",
      ]),
      human: liveShadowRecoveryHumanV1Schema.optional(),
    }).strict(),
  ]);

export const fullEncryptionMessageRecoveryResponseV2Schema =
  z.discriminatedUnion("status", [
    z.object({
      responseVersion: z.literal(2),
      representationMode: z.literal("full_encryption"),
      status: z.literal("human_published"),
      operationId: portableId,
      authorizationScheme: z.enum([
        "human_peer_v1", "shared_agent_v1", "human_ai_readable_v1",
        "human_ai_readable_v2",
      ]),
      acceptedHumanRequestDigestBase64url: sha256Bytes,
      human: liveShadowRecoveryHumanV1Schema,
    }).strict(),
    z.object({
      responseVersion: z.literal(2),
      representationMode: z.literal("full_encryption"),
      status: z.literal("absent"),
    }).strict(),
    z.object({
      responseVersion: z.literal(2),
      representationMode: z.literal("full_encryption"),
      status: z.literal("pending"),
      state: z.enum(["planned", "human_verified", "running"]),
      jobId: z.string().uuid().nullable(),
      human: liveShadowRecoveryHumanV1Schema.optional(),
    }).strict(),
    z.object({
      responseVersion: z.literal(2),
      representationMode: z.literal("full_encryption"),
      status: z.literal("completed"),
      state: z.enum(["completed", "client_verified"]),
      jobId: z.string().uuid(),
      human: liveShadowRecoveryHumanV1Schema,
      durableEvents: z.array(fullEncryptionRecoveryDurableEventV2Schema)
        .min(1).max(255),
    }).strict(),
    z.object({
      responseVersion: z.literal(2),
      representationMode: z.literal("full_encryption"),
      status: z.literal("fallback"),
      state: z.enum(["fallback", "failed"]),
      jobId: z.string().uuid().nullable(),
      reason: z.enum([
        "protected_unavailable", "stale_authority", "integrity_failure",
        "deadline_expired", "recipient_lost", "cancelled", "product_conflict",
        "policy_changed", "authority_changed", "stream_incomplete",
        "client_unavailable", "unsupported_payload", "storage_failure",
        "transport_failure",
      ]),
      human: liveShadowRecoveryHumanV1Schema.optional(),
    }).strict(),
  ]);

export type LiveShadowMessagePlanRequestV1 = z.infer<
  typeof liveShadowMessagePlanRequestV1Schema
>;
export type LiveShadowMessagePlanRequestV2 = z.infer<
  typeof liveShadowMessagePlanRequestV2Schema
>;
export type LiveShadowMessagePlanRequest = z.infer<
  typeof liveShadowMessagePlanRequestSchema
>;
export type LiveShadowMessagePlanResponseV1 = z.infer<
  typeof liveShadowMessagePlanResponseV1Schema
>;
export type LiveShadowMessagePreparedRequestV1 = z.infer<
  typeof liveShadowMessagePreparedRequestV1Schema
>;
export type FullEncryptionMessagePreparedRequestV2 = z.infer<
  typeof fullEncryptionMessagePreparedRequestV2Schema
>;
export type HumanMessageEditPlanRequestV1 = z.infer<
  typeof humanMessageEditPlanRequestV1Schema
>;
export type HumanMessageEditPlanResponseV1 = z.infer<
  typeof humanMessageEditPlanResponseV1Schema
>;
export type HumanMessageEditPreparedRequestV1 = z.infer<
  typeof humanMessageEditPreparedRequestV1Schema
>;
export type HumanMessageEditPreparedResponseV1 = z.infer<
  typeof humanMessageEditPreparedResponseV1Schema
>;
export type LiveShadowMessageClientUnavailableRequestV1 = z.infer<
  typeof liveShadowMessageClientUnavailableRequestV1Schema
>;
export type LiveShadowMessageSendAttemptV1 = z.infer<
  typeof liveShadowMessageSendAttemptV1Schema
>;
export type LiveShadowMessageSendResultV1 = z.infer<
  typeof liveShadowMessageSendResultV1Schema
>;
export type LiveShadowMessageClientVerificationRequestV1 = z.infer<
  typeof liveShadowMessageClientVerificationRequestV1Schema
>;
export type LiveShadowMessageClientVerificationResponseV1 = z.infer<
  typeof liveShadowMessageClientVerificationResponseV1Schema
>;
export type HumanPeerLiveShadowAcknowledgementRequestV1 = z.infer<
  typeof humanPeerLiveShadowAcknowledgementRequestV1Schema
>;
export type HumanPeerLiveShadowAcknowledgementPlanRequestV1 = z.infer<
  typeof humanPeerLiveShadowAcknowledgementPlanRequestV1Schema
>;
export type HumanPeerLiveShadowAcknowledgementPlanResponseV1 = z.infer<
  typeof humanPeerLiveShadowAcknowledgementPlanResponseV1Schema
>;
export type HumanPeerLiveShadowAcknowledgementResponseV1 = z.infer<
  typeof humanPeerLiveShadowAcknowledgementResponseV1Schema
>;
export type SharedAgentLiveShadowAcknowledgementRequestV1 = z.infer<
  typeof sharedAgentLiveShadowAcknowledgementRequestV1Schema
>;
export type SharedAgentLiveShadowAcknowledgementPlanRequestV1 = z.infer<
  typeof sharedAgentLiveShadowAcknowledgementPlanRequestV1Schema
>;
export type SharedAgentLiveShadowAcknowledgementPlanResponseV1 = z.infer<
  typeof sharedAgentLiveShadowAcknowledgementPlanResponseV1Schema
>;
export type SharedAgentLiveShadowAcknowledgementResponseV1 = z.infer<
  typeof sharedAgentLiveShadowAcknowledgementResponseV1Schema
>;
export type SharedAgentOutputReadPlanRequestV1 = z.infer<
  typeof sharedAgentOutputReadPlanRequestV1Schema
>;
export type SharedAgentOutputReadPlanResponseV1 = z.infer<
  typeof sharedAgentOutputReadPlanResponseV1Schema
>;
export type SharedAgentExecutionAuthorizationRequestV1 = z.infer<
  typeof sharedAgentExecutionAuthorizationRequestV1Schema
>;
export type SharedAgentExecutionAuthorizationResponseV1 = z.infer<
  typeof sharedAgentExecutionAuthorizationResponseV1Schema
>;
export type RuntimeInvocationAuthorizationRequestV1 = z.infer<
  typeof runtimeInvocationAuthorizationRequestV1Schema
>;
export type RuntimeInvocationAuthorizationResponseV1 = z.infer<
  typeof runtimeInvocationAuthorizationResponseV1Schema
>;
export type LiveShadowMessageRecoveryResponseV1 = z.infer<
  typeof liveShadowMessageRecoveryResponseV1Schema
>;
