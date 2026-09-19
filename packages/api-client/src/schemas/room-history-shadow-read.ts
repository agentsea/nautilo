import { z } from "zod";
import { protectedMessageDtoV2Schema } from "@nautilo/types";

import {
  protectedObjectAccessSignerEvidenceSetV1Schema,
} from "./protected-object-access";

// Mirrors the signed Human history acknowledgement wire's exact result bound.
const HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1 = 50;

const portableId = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const canonicalUuid = z.string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const counter = z.number().int().nonnegative().safe();
const positiveCounter = z.number().int().positive().safe();
const base64url = z.string().min(1).max(4_300_000)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .refine((value) => value.length % 4 !== 1, {
    message: "bytes must be canonical unpadded base64url",
  });
const sha256 = base64url.length(43);

const roomHistoryShadowSignerEvidenceV1Schema = z.discriminatedUnion("kind", [
  protectedObjectAccessSignerEvidenceSetV1Schema.element,
  z.object({
    kind: z.enum(["human_ai_readable_live_shadow_request_v1", "human_ai_readable_live_shadow_request_v2"]),
    operationId: portableId,
    planBytesBase64url: base64url.max(350_000),
    requestBytesBase64url: base64url.max(699_052),
    requestDigestBase64url: sha256,
    committerDeviceSigningPublicKeyBase64url: sha256.optional(),
  }).strict(),
  z.object({
    // Accepted server execution authority, not a portable Human signature.
    kind: z.literal("shared_agent_execution_plan_v4"),
    operationId: portableId,
    planBytesBase64url: base64url.max(350_000),
    planDigestBase64url: sha256,
  }).strict(),
  z.object({
    kind: z.enum([
      "human_live_shadow_request_v3",
      "human_live_shadow_request_v4",
    ]),
    operationId: portableId,
    planBytesBase64url: base64url.max(350_000),
    // V4 establishment carries the bounded standing authorization. This is
    // the base64url ceiling for its authenticated 512 KiB wire limit.
    requestBytesBase64url: base64url.max(699_052),
    requestDigestBase64url: sha256,
  }).strict(),
  z.object({
    kind: z.literal("human_peer_live_shadow_request_v1"),
    operationId: portableId,
    planBytesBase64url: base64url.max(350_000),
    requestBytesBase64url: base64url.max(699_052),
    requestDigestBase64url: sha256,
    senderDeviceId: portableId,
    senderDeviceSigningKeyGeneration: positiveCounter,
    senderDeviceSigningPublicKeyBase64url: base64url.max(86),
  }).strict(),
]);

export const roomHistoryShadowReadIntentV1Schema = z.object({
  requestVersion: z.literal(1),
  clientRequestKey: portableId,
  readerDeviceId: portableId.optional(),
}).strict();

export const roomHistoryShadowSelectedCoordinateV1Schema = z.object({
  sessionId: canonicalUuid,
  messageId: positiveCounter,
  editRevision: counter,
  role: z.enum(["user", "assistant", "tool", "system"]),
  logicalMessageKey: portableId,
}).strict();

export const roomMessageShadowReadRequestV1Schema = z.object({
  intent: roomHistoryShadowReadIntentV1Schema,
  coordinate: roomHistoryShadowSelectedCoordinateV1Schema,
}).strict();

const roomHistoryShadowDomainKeyV2AuthoritySchema = z.object({
  scheme: z.literal("domain_key_v2"),
  keyClass: z.enum(["human", "ai"]),
  subjectHumanId: portableId,
  readerDeviceId: portableId,
  readerDeviceSigningKeyGeneration: positiveCounter,
  hostAuthorizationRevision: counter,
  policyRevision: positiveCounter,
  roomId: canonicalUuid,
  namespaceId: canonicalUuid,
  namespaceAccessRevision: counter,
  namespaceCurrentGeneration: counter,
  namespaceHeadDigestBase64url: sha256,
  domainId: portableId,
  domainKeyGeneration: positiveCounter,
  domainAuthorizationRevision: positiveCounter,
  domainHeadDigestBase64url: sha256,
  namespaceBundleRevision: positiveCounter,
  namespaceBundleDigestBase64url: sha256,
}).strict();

export const roomHistoryShadowAuthorityV1Schema =
  roomHistoryShadowDomainKeyV2AuthoritySchema;

const roomHistoryRetainedGenerationSchema = z.object({
  namespaceGeneration: counter,
  accessRevision: counter,
  headDigestBase64url: sha256,
  publicationDigestBase64url: sha256,
  publicationSetDigestBase64url: sha256,
  audienceFingerprintBase64url: sha256,
}).strict();

const roomHistoryLiveShadowRecordV1Schema = z.object({
  kind: z.literal("live_shadow").optional(),
  coordinate: roomHistoryShadowSelectedCoordinateV1Schema,
  shadowOperationId: portableId,
  shadowOperationFamily: z.enum(["shared_human", "shared_execution"]).optional(),
  shadowTranscriptOrdinal: positiveCounter.max(256),
  ordinaryPayloadBytesBase64url: base64url,
  retainedGeneration: roomHistoryRetainedGenerationSchema,
  protectedMessage: protectedMessageDtoV2Schema,
}).strict();

const roomHistoryShadowSelectedSourceV1Schema = z.object({
  role: z.enum(["user", "assistant", "tool", "system"]),
  logicalMessageKey: portableId.optional(),
  sourceUserId: portableId.optional(),
  authorAgentId: canonicalUuid.optional(),
}).strict();

const roomHistoryTerminalExecutionSummarySchema = z.object({
  messageId: positiveCounter,
  executionId: portableId,
  classification: z.enum(["cancelled", "process_lost"]),
}).strict();

export const roomHistoryShadowRecordV1Schema = z.union([
  roomHistoryLiveShadowRecordV1Schema,
  roomHistoryLiveShadowRecordV1Schema.omit({ ordinaryPayloadBytesBase64url: true }).extend({
    representationMode: z.literal("protected-only"),
    selectedSource: roomHistoryShadowSelectedSourceV1Schema,
  }).strict(),
  z.object({
    kind: z.literal("existing_representation"),
    coordinate: roomHistoryShadowSelectedCoordinateV1Schema,
    protectedMessage: protectedMessageDtoV2Schema,
    ordinaryPayloadBytesBase64url: base64url.optional(),
    // Retained server publication attestation, not original-author evidence.
    repair: z.object({
      identityDigestBase64url: sha256,
      allocationDigestBase64url: sha256,
      attestationDigestBase64url: sha256,
      publisherSignerKeyId: portableId,
      publisherSigningPublicKeyBase64url: base64url.length(43),
      publisherKind: z.literal("foreground_runtime").optional(),
    }).strict(),
    retainedGeneration: roomHistoryRetainedGenerationSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("existing_representation"),
    representationMode: z.literal("protected-only"),
    coordinate: roomHistoryShadowSelectedCoordinateV1Schema,
    selectedSource: roomHistoryShadowSelectedSourceV1Schema,
    protectedMessage: protectedMessageDtoV2Schema,
    repair: z.object({
      identityDigestBase64url: sha256,
      allocationDigestBase64url: sha256,
      attestationDigestBase64url: sha256,
      publisherSignerKeyId: portableId,
      publisherSigningPublicKeyBase64url: base64url.length(43),
      publisherKind: z.literal("foreground_runtime").optional(),
    }).strict(),
    retainedGeneration: roomHistoryRetainedGenerationSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("existing_representation"),
    coordinate: roomHistoryShadowSelectedCoordinateV1Schema,
    protectedMessage: protectedMessageDtoV2Schema,
    ordinaryPayloadBytesBase64url: base64url.optional(),
    repair: z.object({
      identityDigestBase64url: sha256,
      allocationDigestBase64url: sha256,
      attestationDigestBase64url: sha256,
      publisherSignerKeyId: portableId,
      publisherSigningPublicKeyBase64url: base64url.length(43),
      publisherKind: z.literal("human_device"),
      publisherHumanId: canonicalUuid,
    }).strict(),
    retainedGeneration: roomHistoryRetainedGenerationSchema,
  }).strict(),
  z.object({
    kind: z.literal("existing_representation"),
    representationMode: z.literal("protected-only"),
    coordinate: roomHistoryShadowSelectedCoordinateV1Schema,
    selectedSource: roomHistoryShadowSelectedSourceV1Schema,
    protectedMessage: protectedMessageDtoV2Schema,
    repair: z.object({
      identityDigestBase64url: sha256,
      allocationDigestBase64url: sha256,
      attestationDigestBase64url: sha256,
      publisherSignerKeyId: portableId,
      publisherSigningPublicKeyBase64url: base64url.length(43),
      publisherKind: z.literal("human_device"),
      publisherHumanId: canonicalUuid,
    }).strict(),
    retainedGeneration: roomHistoryRetainedGenerationSchema,
  }).strict(),
  z.object({
    kind: z.literal("human_edited_representation"),
    representationMode: z.literal("protected-only"),
    coordinate: roomHistoryShadowSelectedCoordinateV1Schema,
    selectedSource: roomHistoryShadowSelectedSourceV1Schema,
    authorHumanId: canonicalUuid,
    committerDeviceSigningPublicKeyBase64url: base64url.length(43),
    retainedGeneration: roomHistoryRetainedGenerationSchema,
    protectedMessage: protectedMessageDtoV2Schema,
  }).strict(),
  z.object({
    kind: z.literal("human_edited_representation"),
    representationMode: z.literal("ordinary-and-protected"),
    coordinate: roomHistoryShadowSelectedCoordinateV1Schema,
    ordinaryPayloadBytesBase64url: base64url,
    authorHumanId: canonicalUuid,
    committerDeviceSigningPublicKeyBase64url: base64url.length(43),
    retainedGeneration: roomHistoryRetainedGenerationSchema,
    protectedMessage: protectedMessageDtoV2Schema,
  }).strict(),
]);

const ready = z.object({
  responseVersion: z.literal(1),
  status: z.literal("ready"),
  operationId: portableId,
  clientRequestKey: portableId,
  selectedCoordinateDigestBase64url: sha256,
  selectedCount: counter.max(HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1),
  selectedCoordinates: z.array(roomHistoryShadowSelectedCoordinateV1Schema)
    .min(1).max(HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1),
  eligibleCount: positiveCounter.max(HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1),
  authority: roomHistoryShadowAuthorityV1Schema,
  authorities: z.array(roomHistoryShadowDomainKeyV2AuthoritySchema)
    .min(1).max(HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1).optional(),
  records: z.array(roomHistoryShadowRecordV1Schema).min(1)
    .max(HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1),
  signerEvidence: z.array(roomHistoryShadowSignerEvidenceV1Schema)
    .max(HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1),
  terminalExecutions: z.array(roomHistoryTerminalExecutionSummarySchema).default([]),
  acknowledgement: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("required"),
      tokenBase64url: base64url.max(86),
      issuedAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
    }).strict(),
    z.object({
      status: z.literal("already_recorded"),
    }).strict(),
  ]),
}).strict().superRefine((value, context) => {
  if (value.selectedCoordinates.length !== value.selectedCount) {
    context.addIssue({
      code: "custom",
      message: "selected Room history read coordinates do not close",
    });
  }
  if (value.records.length !== value.eligibleCount) {
    context.addIssue({
      code: "custom",
      message: "eligible Room history read records do not close",
    });
  }
  const selectedHumanMessageIds = new Set(value.selectedCoordinates
    .filter((coordinate) => coordinate.role === "user")
    .map((coordinate) => coordinate.messageId));
  const terminalIdentities = new Set<string>();
  for (const [index, terminal] of value.terminalExecutions.entries()) {
    if (!selectedHumanMessageIds.has(terminal.messageId)) {
      context.addIssue({
        code: "custom",
        message: "terminal execution does not belong to a selected Human input",
        path: ["terminalExecutions", index, "messageId"],
      });
    }
    const identity = `${terminal.messageId}\0${terminal.executionId}`;
    if (terminalIdentities.has(identity)) {
      context.addIssue({
        code: "custom",
        message: "terminal execution identity is duplicated",
        path: ["terminalExecutions", index, "executionId"],
      });
    }
    terminalIdentities.add(identity);
  }
});

const unavailable = z.object({
  responseVersion: z.literal(1),
  status: z.literal("unavailable"),
  operationId: portableId,
  clientRequestKey: portableId,
  policyRevision: positiveCounter,
  selectedCoordinateDigestBase64url: sha256,
  selectedCount: counter.max(HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1),
  eligibleCount: positiveCounter.max(HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1),
  reason: z.enum([
    "client_crypto_unavailable",
    "current_read_authority_unavailable",
    "selection_changed",
    "projection_corrupt",
  ]),
}).strict();

export const roomHistoryShadowReadResponseV1Schema = z.discriminatedUnion(
  "status",
  [
    z.object({
      responseVersion: z.literal(1),
      status: z.literal("disabled"),
      mode: z.literal("plaintext_only"),
    }).strict(),
    z.object({
      responseVersion: z.literal(1),
      status: z.literal("ineligible"),
      selectedCount: counter.max(HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1),
      eligibleCount: z.literal(0),
    }).strict(),
    unavailable,
    ready,
  ],
);

const roomHistoryShadowOrdinaryRepairFields = {
  purpose: z.literal("human_device_ordinary_repair"),
  operationId: portableId,
  policyRevision: positiveCounter,
  subjectHumanId: portableId,
  readerDeviceId: portableId,
  readerDeviceSigningKeyGeneration: positiveCounter,
  hostAuthorizationRevision: counter,
  roomId: canonicalUuid,
  namespaceId: canonicalUuid,
  namespaceAccessRevision: counter,
  namespaceKeyGeneration: counter,
  sessionId: canonicalUuid,
  messageId: positiveCounter,
  editRevision: counter,
  cryptoObjectId: portableId,
  authorRole: z.enum(["user", "assistant", "tool", "system"]),
  createdAt: counter,
  payloadDigestBase64url: sha256,
  payloadBytesBase64url: base64url,
  issuedAt: counter,
  deadlineAt: positiveCounter,
  signatureBase64url: base64url.length(86),
} as const;

const roomHistoryShadowOrdinaryRepairSchema = z.union([
  z.object({
    version: z.literal(2),
    ...roomHistoryShadowOrdinaryRepairFields,
  }).strict(),
  z.object({
    version: z.literal(3),
    keyClass: z.enum(["human", "ai"]),
    ...roomHistoryShadowOrdinaryRepairFields,
  }).strict(),
]);

export const roomHistoryShadowReadAcknowledgementRequestV1Schema =
  z.discriminatedUnion("status", [
    z.object({
      requestVersion: z.literal(1),
      status: z.literal("signed"),
      operationId: portableId,
      tokenBase64url: base64url.max(86),
      acknowledgementBytesBase64url: base64url.max(5_462),
    }).strict(),
    z.object({
      requestVersion: z.literal(2),
      status: z.literal("signed_with_ordinary_repairs"),
      operationId: portableId,
      tokenBase64url: base64url.max(86),
      acknowledgementBytesBase64url: base64url.max(5_462),
      selectedCoordinates: z.array(roomHistoryShadowSelectedCoordinateV1Schema)
        .min(1).max(HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1),
      ordinaryRepairs: z.array(roomHistoryShadowOrdinaryRepairSchema).min(1)
        .max(HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1),
    }).strict(),
    z.object({
      requestVersion: z.literal(1),
      status: z.literal("client_unavailable"),
      operationId: portableId,
      tokenBase64url: base64url.max(86),
      reason: z.enum([
        "client_crypto_unavailable",
        "client_custody_unavailable",
      ]),
    }).strict(),
  ]);

export const roomHistoryShadowReadAcknowledgementResponseV1Schema = z.object({
  responseVersion: z.literal(1),
  status: z.enum(["accepted", "replayed"]),
  operationId: portableId,
}).strict();

export type RoomHistoryShadowReadIntentV1 = z.infer<
  typeof roomHistoryShadowReadIntentV1Schema
>;
export type RoomMessageShadowReadRequestV1 = z.infer<
  typeof roomMessageShadowReadRequestV1Schema
>;
export type RoomHistoryShadowSelectedCoordinateV1 = z.infer<
  typeof roomHistoryShadowSelectedCoordinateV1Schema
>;
export type RoomHistoryShadowAuthorityV1 = z.infer<
  typeof roomHistoryShadowAuthorityV1Schema
>;
export type RoomHistoryShadowRecordV1 = z.infer<
  typeof roomHistoryShadowRecordV1Schema
>;
export type RoomHistoryShadowReadResponseV1 = z.infer<
  typeof roomHistoryShadowReadResponseV1Schema
>;
export type RoomHistoryShadowReadAcknowledgementRequestV1 = z.infer<
  typeof roomHistoryShadowReadAcknowledgementRequestV1Schema
>;
export type RoomHistoryShadowReadAcknowledgementResponseV1 = z.infer<
  typeof roomHistoryShadowReadAcknowledgementResponseV1Schema
>;
